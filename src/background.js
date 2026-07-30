/**
 * StarBoard — service worker.
 *
 * Owns every network fetch so that a refresh started from the popup survives
 * the popup being closed, and so the periodic alarm and the manual button
 * share one code path.
 */

import { fetchAccount, GitHubError } from './lib/github.js';
import {
  getSettings,
  setSettings,
  getCache,
  getBaseline,
  setCache,
  chooseBaseline,
  commitRefresh,
} from './lib/storage.js';
import { createRefreshCoordinator } from './lib/refresh-coordinator.js';

const ALARM = 'starboard-refresh';
const RETRY_ALARM = 'starboard-retry';
const OFFSCREEN_PATH = 'src/offscreen.html';
const GITHUB_ORIGIN = 'https://github.com/*';

let offscreenReady = null;

/** Web mode needs github.com access, granted on demand from the options page. */
async function hasWebPermission() {
  return chrome.permissions.contains({ origins: [GITHUB_ORIGIN] });
}

/**
 * Detect the hidden document without assuming the latest offscreen API.
 *
 * `chrome.offscreen.hasDocument()` only arrived long after StarBoard's
 * declared Chrome 110 floor. Chrome 116+ exposes runtime contexts; Chrome
 * 110-115 can still discover the document through the service worker client
 * list.
 */
async function hasOffscreenDocument() {
  if (typeof chrome.offscreen.hasDocument === 'function') {
    return chrome.offscreen.hasDocument();
  }

  if (typeof chrome.runtime.getContexts === 'function') {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    return contexts.length > 0;
  }

  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const workerClients = await globalThis.clients.matchAll();
  return workerClients.some((client) => client.url === offscreenUrl);
}

/**
 * Spin up (once) the hidden document that owns DOMParser. Concurrent callers
 * share one creation promise — createDocument throws if one already exists.
 */
async function ensureOffscreen() {
  if (await hasOffscreenDocument()) return;
  if (!offscreenReady) {
    offscreenReady = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.DOM_PARSER],
        justification: 'Parse github.com HTML into repo data for no-token mode.',
      })
      .finally(() => {
        offscreenReady = null;
      });
  }
  await offscreenReady;
}

/** Fetch + parse github.com in the offscreen document. */
async function fetchAccountViaWeb(username) {
  if (!username) {
    throw new GitHubError('Web mode needs a GitHub username. Add one in Settings.');
  }
  if (!(await hasWebPermission())) {
    throw new GitHubError(
      'StarBoard needs permission to read github.com. Open Settings and re-select "GitHub website".',
    );
  }

  await ensureOffscreen();
  try {
    const res = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'scrape-account',
      username,
    });
    if (!res?.ok) {
      const error = new Error(res?.error?.message || 'Could not read github.com.');
      Object.assign(error, res?.error || {});
      throw error;
    }
    return res.result;
  } finally {
    if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
  }
}

function compact(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

async function updateBadge(snapshot = null) {
  const { settings, cache, baseline } =
    snapshot ||
    Object.fromEntries(
      await Promise.all([
        getSettings().then((value) => ['settings', value]),
        getCache().then((value) => ['cache', value]),
        getBaseline().then((value) => ['baseline', value]),
      ]),
    );
  if (settings.badgeMode === 'off' || !cache?.repos?.length) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }

  const repos = cache.repos.filter((r) => settings.includeForks || !r.fork);
  const stars = repos.reduce((sum, r) => sum + r.stargazers_count, 0);

  let text;
  let color = '#e3b341'; // star gold
  if (settings.badgeMode === 'delta') {
    const base = baseline?.counts || {};
    const delta = repos.reduce(
      (sum, r) => sum + (r.stargazers_count - (base[r.full_name]?.[0] ?? r.stargazers_count)),
      0,
    );
    if (delta === 0) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }
    text = `${delta > 0 ? '+' : '−'}${compact(Math.abs(delta))}`;
    color = delta > 0 ? '#3fb950' : '#f85149';
  } else {
    text = compact(stars);
  }

  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

function generationId() {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

async function scheduleRetry(retryAt) {
  await chrome.alarms.clear(RETRY_ALARM);
  if (Number.isFinite(retryAt) && retryAt > Date.now()) {
    chrome.alarms.create(RETRY_ALARM, { when: retryAt });
  }
}

/** Run one generation selected by the refresh coordinator. */
async function runRefresh(intent) {
  const { settings } = intent;
  const generation = generationId();
  try {
    const result =
      settings.dataSource === 'web'
        ? await fetchAccountViaWeb(settings.username)
        : await fetchAccount(settings);
    const existingBaseline = await getBaseline();
    const baseline = chooseBaseline(existingBaseline, result.repos, settings.baselineHours, {
      rebase: intent.rebase,
      generation,
    });
    const previous = await getCache();
    const source = result.source || 'api';
    const complete = result.complete !== false;
    const approximate = !!result.approximate;
    const cache = {
      ...result,
      source,
      requestedSource: settings.dataSource,
      previousSource: previous?.source && previous.source !== source ? previous.source : null,
      complete,
      partialReason: result.partialReason || null,
      confidence: complete ? (approximate ? 'approximate' : 'exact') : 'partial',
      stale: false,
      pendingSource: null,
      error: null,
    };
    const committed = await commitRefresh(cache, baseline, generation);
    await updateBadge({ settings, ...committed });
    await scheduleRetry(result.retryAt);
    return { ok: true, ...committed, generation };
  } catch (err) {
    const detail = {
      message: err.message,
      code: err.code || 'REFRESH_FAILED',
      status: err.status || 0,
      rateLimited:
        (err instanceof GitHubError && err.rateLimited) || err.code === 'RATE_LIMITED',
      resetAt: err instanceof GitHubError ? err.resetAt : err.retryAt || null,
      retryAt: err.retryAt || (err instanceof GitHubError ? err.resetAt : null),
      at: Date.now(),
      requestedSource: settings.dataSource,
    };
    const [previous, baseline] = await Promise.all([getCache(), getBaseline()]);
    let cache = previous;
    if (previous) {
      cache = {
        ...previous,
        stale: true,
        confidence: 'stale',
        pendingSource:
          previous.source !== settings.dataSource ? settings.dataSource : null,
        error: detail,
      };
      await setCache(cache);
      await updateBadge({ settings, cache, baseline });
    }
    await scheduleRetry(detail.retryAt);
    return { ok: false, error: detail, cache, baseline };
  }
}

const refreshCoordinator = createRefreshCoordinator(runRefresh);

async function refresh({ rebase = false, force = false, reason = 'manual', source = null } = {}) {
  const settings = await getSettings();
  const selectedSource = source || settings.dataSource;
  return refreshCoordinator.request({
    rebase,
    force,
    source: selectedSource,
    accountKey: `${selectedSource}:${settings.username}:${settings.token ? 'authenticated' : 'public'}`,
    settings: { ...settings, dataSource: selectedSource },
    reasons: [reason],
  });
}

async function syncAlarm() {
  const { refreshMinutes } = await getSettings();
  await chrome.alarms.clear(ALARM);
  if (refreshMinutes > 0) {
    const period = Math.max(5, refreshMinutes);
    chrome.alarms.create(ALARM, { periodInMinutes: period, delayInMinutes: period });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await syncAlarm();
  await updateBadge();
  const settings = await getSettings();
  if (settings.username || settings.token) refresh({ reason: 'installed' });
});

chrome.runtime.onStartup.addListener(async () => {
  await syncAlarm();
  await updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM || alarm.name === RETRY_ALARM) {
    refresh({ reason: alarm.name === RETRY_ALARM ? 'retry' : 'alarm' });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false; // belongs to the offscreen document

  (async () => {
    switch (msg?.type) {
      case 'patch-settings': {
        const settings = await setSettings(msg.changes || {});
        sendResponse({ ok: true, settings });
        break;
      }
      case 'refresh':
        sendResponse(
          await refresh({
            rebase: !!msg.rebase,
            force: !!msg.force,
            reason: msg.reason || 'manual',
            source: msg.source || null,
          }),
        );
        break;
      case 'settings-changed':
        await syncAlarm();
        await updateBadge();
        if (msg.refresh) {
          sendResponse(
            await refresh({
              force: true,
              reason: msg.reason || 'settings-change',
              source: msg.source || null,
            }),
          );
        } else {
          sendResponse({ ok: true });
        }
        break;
      case 'update-badge':
        await updateBadge();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: { message: `Unknown message: ${msg?.type}` } });
    }
  })();
  return true; // keep the response channel open for the async work above
});

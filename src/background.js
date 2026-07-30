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
  getCache,
  setCache,
  getBaseline,
  resolveBaseline,
  resetBaseline,
} from './lib/storage.js';

const ALARM = 'starboard-refresh';
const OFFSCREEN_PATH = 'src/offscreen.html';
const GITHUB_ORIGIN = 'https://github.com/*';

let inFlight = null;
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
    if (!res?.ok) throw new GitHubError(res?.error?.message || 'Could not read github.com.');
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

async function updateBadge() {
  const [settings, cache, baseline] = await Promise.all([
    getSettings(),
    getCache(),
    getBaseline(),
  ]);
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

/**
 * Fetch, roll the baseline if due, persist. Concurrent callers share the same
 * in-flight promise instead of firing duplicate API requests.
 *
 * The baseline stays in its own storage key — never copied into the cache —
 * so there is exactly one source of truth for what deltas are measured from.
 */
async function refresh({ rebase = false } = {}) {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const settings = await getSettings();
    try {
      const result =
        settings.dataSource === 'web'
          ? await fetchAccountViaWeb(settings.username)
          : await fetchAccount(settings);
      const baseline = rebase
        ? await resetBaseline(result.repos)
        : await resolveBaseline(result.repos, settings.baselineHours);

      const cache = { ...result, source: result.source || 'api', error: null };
      await setCache(cache);
      await updateBadge();
      return { ok: true, cache, baseline };
    } catch (err) {
      const detail = {
        message: err.message,
        rateLimited: err instanceof GitHubError && err.rateLimited,
        resetAt: err instanceof GitHubError ? err.resetAt : null,
        at: Date.now(),
      };
      const prev = await getCache();
      if (prev) await setCache({ ...prev, error: detail });
      return { ok: false, error: detail, cache: prev };
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
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
  if (settings.username || settings.token) refresh();
});

chrome.runtime.onStartup.addListener(async () => {
  await syncAlarm();
  await updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) refresh();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false; // belongs to the offscreen document

  (async () => {
    switch (msg?.type) {
      case 'refresh':
        sendResponse(await refresh({ rebase: !!msg.rebase }));
        break;
      case 'settings-changed':
        await syncAlarm();
        await updateBadge();
        sendResponse({ ok: true });
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

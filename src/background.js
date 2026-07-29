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

let inFlight = null;

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
      const result = await fetchAccount(settings);
      const baseline = rebase
        ? await resetBaseline(result.repos)
        : await resolveBaseline(result.repos, settings.baselineHours);

      const cache = { ...result, error: null };
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

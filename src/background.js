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
  forgetToken,
  getCache,
  getBaseline,
  setCache,
  chooseBaseline,
  commitRefresh,
  acknowledgeLifecycle,
  createUndoSnapshot,
  clearPortfolioData,
  getUndoStatus,
  restoreUndoSnapshot,
  pruneStoredHistory,
  applyImportedState,
  getHistory,
  getStorageDiagnostics,
  getNotificationConfig,
  setNotificationConfig,
  getNotificationState,
  setNotificationState,
  getCapabilityState,
  setCapabilityState,
} from './lib/storage.js';
import {
  CAPABILITY_POLL_INTERVAL_MS,
  capabilityFetchIsDue,
  disabledCapabilities,
  fetchCapabilityManifest,
  isCapabilityDisabled,
} from './lib/capabilities.js';
import { createRefreshCoordinator } from './lib/refresh-coordinator.js';
import { createRetryWait } from './lib/request.js';
import { deriveLifecycleEvents, mergeLifecycleEvents } from './lib/lifecycle.js';
import { historyStats } from './lib/history.js';
import { buildDiagnostics } from './lib/diagnostics.js';
import {
  installationPlan,
  privacyNoticeForUpdate,
  stagePrivacyNotice,
} from './lib/install.js';
import {
  acknowledgeNotifications,
  evaluateNotificationEvents,
  markNotificationsNotified,
  notificationAvailability,
} from './lib/notifications.js';
import { message } from './lib/i18n.js';

const ALARM = 'starboard-refresh';
const CAPABILITY_ALARM = 'starboard-capabilities';
const RETRY_ALARM = 'starboard-retry';
const NOTIFICATION_ALARM = 'starboard-notification';
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
 * The Chrome 120 floor exposes both `chrome.offscreen.hasDocument()` and
 * runtime contexts. The client-list fallback also keeps compatible test
 * doubles and older development browsers from creating duplicate documents.
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
    // Coded so the popup can offer to re-request the origin from a user
    // gesture rather than sending the user to Settings.
    throw new GitHubError('StarBoard needs permission to read github.com.', {
      code: 'WEB_PERMISSION_REQUIRED',
    });
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

const waitForRetry = createRetryWait({
  schedule: scheduleRetry,
  keepAlive: () => chrome.runtime.getPlatformInfo(),
});

async function hasNotificationPermission() {
  return chrome.permissions.contains({ permissions: ['notifications'] });
}

function createSystemNotification(options) {
  const localized = {
    ...options,
    title: message(options.title),
    message: message(options.message),
  };
  return new Promise((resolve, reject) => {
    const id = `starboard-${Date.now()}-${crypto.randomUUID()}`;
    chrome.notifications.create(id, localized, (createdId) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(createdId);
    });
  });
}

async function deliverPendingNotifications() {
  const [config, state, permitted, notificationsOff] = await Promise.all([
    getNotificationConfig(),
    getNotificationState(),
    hasNotificationPermission(),
    capabilityOff('notifications'),
  ]);
  await chrome.alarms.clear(NOTIFICATION_ALARM);
  const pending = state.pending.filter((event) => !event.notifiedAt);
  if (notificationsOff || !config.enabled || !permitted || !pending.length) return state;

  const availability = notificationAvailability(config, state);
  if (!availability.allowed) {
    if (availability.nextAt) {
      chrome.alarms.create(NOTIFICATION_ALARM, { when: availability.nextAt });
    }
    return state;
  }

  const first = pending[0];
  const more = pending.length - 1;
  await createSystemNotification({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: pending.length === 1 ? first.title : 'StarBoard portfolio update',
    message:
      pending.length === 1
        ? first.message
        : `${first.message} ${more} more alert${more === 1 ? '' : 's'} are saved in StarBoard.`,
    priority: 0,
  });
  const next = markNotificationsNotified(
    state,
    pending.map((event) => event.id),
  );
  await setNotificationState(next);
  return next;
}

async function evaluateNotifications(previous, current, settings, generation) {
  const config = await getNotificationConfig();
  if (!config.enabled || (await capabilityOff('notifications'))) return;
  const state = await getNotificationState();
  const next = evaluateNotificationEvents(previous, current, config, state, {
    generation,
    includeForks: settings.includeForks,
  });
  await setNotificationState(next);
  await deliverPendingNotifications();
}

function changedRepositoryNames(previous, current) {
  const prior = new Map(
    (previous?.repos || []).map((repo) => [repo.full_name, [repo.stargazers_count, repo.forks_count]]),
  );
  return (current?.repos || [])
    .filter((repo) => {
      const before = prior.get(repo.full_name);
      return before &&
        (before[0] !== repo.stargazers_count || before[1] !== repo.forks_count);
    })
    .map((repo) => repo.full_name);
}

/**
 * Refresh the static kill-switch, at most once every six hours.
 *
 * Every failure is swallowed on purpose: the document being unreachable,
 * malformed, or served by something that is not the expected origin must leave
 * the extension exactly as it was. A kill-switch that can itself break the
 * product is worse than not having one.
 */
async function syncCapabilityAlarm() {
  await chrome.alarms.clear(CAPABILITY_ALARM);
  const minutes = CAPABILITY_POLL_INTERVAL_MS / 60_000;
  chrome.alarms.create(CAPABILITY_ALARM, {
    periodInMinutes: minutes,
    delayInMinutes: minutes,
  });
  // Startup and install are the two moments a stale rule most needs lifting.
  await syncCapabilities();
}

async function syncCapabilities({ force = false } = {}) {
  const current = await getCapabilityState();
  if (!force && !capabilityFetchIsDue(current)) return current;
  try {
    const next = await fetchCapabilityManifest();
    await setCapabilityState(next);
    return next;
  } catch {
    return current;
  }
}

/** Named capabilities currently switched off for this installed version. */
async function offCapabilities() {
  const state = await getCapabilityState();
  return disabledCapabilities(state, chrome.runtime.getManifest().version);
}

async function capabilityOff(name) {
  const state = await getCapabilityState();
  return isCapabilityDisabled(state, name, chrome.runtime.getManifest().version);
}

/** Run one generation selected by the refresh coordinator. */
async function runRefresh(intent) {
  const { settings } = intent;
  let sourceResolution = null;
  const generation = generationId();
  try {
    const stored = await getCache();
    // A capability switched off in the field must not be attempted. Website
    // mode falls through to the API rather than failing the refresh outright,
    // because the API can serve the same account with no token.
    const [webOff, graphqlOff] = await Promise.all([
      capabilityOff('web-source'),
      capabilityOff('api-graphql'),
    ]);
    const useWeb = settings.dataSource === 'web' && !webOff;
    sourceResolution = {
      requested: settings.dataSource,
      effective: useWeb ? 'web' : 'api',
      reason: settings.dataSource === 'web' && webOff ? 'web-source-disabled' : null,
    };
    const result = useWeb
      ? await fetchAccountViaWeb(settings.username)
      : await fetchAccount(settings, {
          previous: stored,
          sleep: waitForRetry,
          graphql: !graphqlOff,
        });

    // Comparing one account's live counts against another account's snapshot
    // produces confident nonsense, and blending both into one history series
    // corrupts every trend. Switching the tracked account starts clean.
    const resolved = result.profile?.login?.toLowerCase() || '';
    const held = stored?.profile?.login?.toLowerCase() || '';
    const accountChanged = !!held && !!resolved && held !== resolved;
    // clearPortfolioData keeps its own undo snapshot, so the previous
    // account's data stays recoverable for the usual window.
    if (accountChanged) await clearPortfolioData();
    const previous = accountChanged ? null : stored;

    const existingBaseline = accountChanged ? null : await getBaseline();
    if (intent.rebase) {
      await createUndoSnapshot('baseline-reset', ['baseline']);
    }
    const baseline = chooseBaseline(existingBaseline, result.repos, settings.baselineHours, {
      rebase: intent.rebase || accountChanged,
      generation,
    });
    const source = result.source || 'api';
    const sourceDowngrade =
      settings.dataSource !== source
        ? {
            requested: settings.dataSource,
            effective: source,
            reason:
              settings.dataSource === 'web' && webOff
                ? 'web-source-disabled'
                : 'source-unavailable',
          }
        : null;
    const authenticated =
      typeof result.authenticated === 'boolean'
        ? result.authenticated
        : source === 'web'
          ? true
          : false;
    const accessReduced =
      previous?.source === source &&
      previous.authenticated === true &&
      authenticated === false;
    const complete = result.complete !== false && !accessReduced;
    const approximate = !!result.approximate;
    const cache = {
      ...result,
      source,
      sourceDowngrade,
      authenticated,
      accessReduced,
      requestedSource: settings.dataSource,
      previousSource:
        previous?.source &&
        (previous.source !== source || previous.authenticated !== authenticated)
          ? previous.source
          : null,
      complete,
      partialReason: accessReduced ? 'access-reduced' : result.partialReason || null,
      confidence: complete ? (approximate ? 'approximate' : 'exact') : 'partial',
      stale: false,
      pendingSource: null,
      error: null,
      movement: {
        generation,
        repos: changedRepositoryNames(previous, result),
      },
    };
    cache.lifecycleEvents = mergeLifecycleEvents(
      previous?.lifecycleEvents || [],
      deriveLifecycleEvents(previous, cache, {
        generation,
        source,
      }),
    );
    const committed = await commitRefresh(cache, baseline, generation);
    await updateBadge({ settings, ...committed });
    await scheduleRetry(result.retryAt);
    await evaluateNotifications(previous, committed.cache, settings, generation).catch(() => {});
    // History can consume one fifth of the local quota. Keep it in storage
    // rather than echoing it through the MV3 response channel; the popup reads
    // it locally after the refresh response arrives.
    return {
      ok: true,
      cache: committed.cache,
      baseline: committed.baseline,
      generation,
    };
  } catch (err) {
    return recordRefreshFailure(err, settings, sourceResolution);
  }
}

const refreshCoordinator = createRefreshCoordinator(runRefresh);

/** Normalize every refresh rejection without letting error reporting reject too. */
async function recordRefreshFailure(err, settings = null, sourceResolution = null) {
  const detail = {
    message: err?.message || 'StarBoard could not refresh this account.',
    code: err?.code || 'REFRESH_FAILED',
    status: err?.status || 0,
    rateLimited:
      (err instanceof GitHubError && err.rateLimited) || err?.code === 'RATE_LIMITED',
    resetAt: err instanceof GitHubError ? err.resetAt : err?.retryAt || null,
    retryAt: err?.retryAt || (err instanceof GitHubError ? err.resetAt : null),
    at: Date.now(),
    requestedSource: settings?.dataSource || null,
    sourceDowngrade:
      sourceResolution?.reason && sourceResolution.requested !== sourceResolution.effective
        ? sourceResolution
        : null,
  };
  // Persist the recovery trigger before storage or badge reporting can fail.
  await scheduleRetry(detail.retryAt).catch(() => {});
  const [previous, baseline] = await Promise.all([
    getCache().catch(() => null),
    getBaseline().catch(() => null),
  ]);
  let cache = previous;
  if (previous) {
    cache = {
      ...previous,
      stale: true,
      confidence: 'stale',
      sourceDowngrade: detail.sourceDowngrade || previous.sourceDowngrade || null,
      movement: null,
      pendingSource:
        settings?.dataSource && previous.source !== settings.dataSource
          ? settings.dataSource
          : null,
      error: detail,
    };
    try {
      await setCache(cache);
    } catch (storageError) {
      if (storageError?.code === 'STORAGE_QUOTA_EXCEEDED' && cache.validators) {
        // Validators are only bandwidth hints. Drop them before giving up on
        // the much more important persisted failure state.
        cache = { ...cache, validators: {} };
        await setCache(cache).catch(() => {});
      }
    }
    if (settings) await updateBadge({ settings, cache, baseline }).catch(() => {});
  }
  return { ok: false, error: detail, cache, baseline };
}

async function refresh({ rebase = false, force = false, reason = 'manual', source = null } = {}) {
  let settings = null;
  try {
    settings = await getSettings();
    const selectedSource = source || settings.dataSource;
    return await refreshCoordinator.request({
      rebase,
      force,
      source: selectedSource,
      accountKey: `${selectedSource}:${settings.username}:${settings.token ? 'authenticated' : 'public'}`,
      settings: { ...settings, dataSource: selectedSource },
      reasons: [reason],
    });
  } catch (error) {
    return recordRefreshFailure(error, settings || { dataSource: source || null });
  }
}

/**
 * The GraphQL listing carries no ETag — it is a POST, so a refresh that finds
 * nothing changed still costs its full point budget and transfers the whole
 * payload, where a REST refresh answers 304 for free. The budget itself is not
 * the constraint: 4 points per sweep at 343 repositories against 5,000/hour is
 * 48 points even at the 5-minute floor. The transfer is, so an automatic sweep
 * on the unconditional transport is held to a quarter hour. Manual refreshes
 * and the popup's own reads are untouched.
 */
const GRAPHQL_MIN_AUTOMATIC_MINUTES = 15;

async function syncAlarm() {
  const [{ refreshMinutes }, cache] = await Promise.all([getSettings(), getCache()]);
  await chrome.alarms.clear(ALARM);
  if (refreshMinutes > 0) {
    const floor = cache?.transport === 'graphql' ? GRAPHQL_MIN_AUTOMATIC_MINUTES : 5;
    const period = Math.max(floor, refreshMinutes);
    chrome.alarms.create(ALARM, { periodInMinutes: period, delayInMinutes: period });
  }
}

async function diagnosticsBundle() {
  const [
    settings,
    cache,
    storage,
    history,
    websitePermission,
    notificationPermission,
    alarms,
    storageBytes,
  ] =
    await Promise.all([
      getSettings(),
      getCache(),
      getStorageDiagnostics(),
      getHistory().then(historyStats),
      hasWebPermission(),
      hasNotificationPermission(),
      chrome.alarms.getAll(),
      chrome.storage.local.getBytesInUse(null),
    ]);
  return buildDiagnostics({
    manifest: chrome.runtime.getManifest(),
    settings,
    cache,
    storage,
    history,
    websitePermission,
    notificationPermission,
    alarms,
    storageBytes,
    userAgent: navigator.userAgent,
    disabledCapabilities: await offCapabilities(),
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const install = installationPlan(details);
  const privacyNotice = privacyNoticeForUpdate(
    details,
    chrome.runtime.getManifest().version,
  );
  if (privacyNotice) await stagePrivacyNotice(privacyNotice).catch(() => {});
  await syncAlarm();
  await syncCapabilityAlarm();
  await updateBadge();
  // Chrome itself updating is not an extension lifecycle change and must not
  // spend network budget. `previousVersion` remains available on `install`
  // for version-gated work when an extension update actually needs it.
  if (!install.shouldRefresh) return;
  const settings = await getSettings();
  if (settings.username || settings.token) {
    void refresh({ reason: install.reason }).catch((error) =>
      recordRefreshFailure(error, settings),
    );
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await syncAlarm();
  await syncCapabilityAlarm();
  await updateBadge();
  await deliverPendingNotifications().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === NOTIFICATION_ALARM) {
    deliverPendingNotifications().catch(() => {});
  } else if (alarm.name === CAPABILITY_ALARM) {
    syncCapabilities().catch(() => {});
  } else if (alarm.name === ALARM || alarm.name === RETRY_ALARM) {
    void refresh({ reason: alarm.name === RETRY_ALARM ? 'retry' : 'alarm' }).catch((error) =>
      recordRefreshFailure(error),
    );
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
      case 'forget-token': {
        const settings = await forgetToken();
        sendResponse({ ok: true, settings });
        break;
      }
      case 'acknowledge-lifecycle': {
        const cache = await acknowledgeLifecycle(msg.ids || null);
        sendResponse({ ok: true, cache });
        break;
      }
      case 'acknowledge-notifications': {
        const state = acknowledgeNotifications(
          await getNotificationState(),
          msg.ids || null,
        );
        await setNotificationState(state);
        sendResponse({ ok: true, state });
        break;
      }
      case 'clear-portfolio': {
        await clearPortfolioData();
        await chrome.alarms.clear(NOTIFICATION_ALARM);
        await updateBadge();
        sendResponse({ ok: true, undo: await getUndoStatus() });
        break;
      }
      case 'undo-status':
        sendResponse({ ok: true, undo: await getUndoStatus() });
        break;
      case 'undo': {
        const restored = await restoreUndoSnapshot();
        await syncAlarm();
        await updateBadge();
        await deliverPendingNotifications().catch(() => {});
        sendResponse({
          ok: !!restored,
          restored,
          error: restored ? null : { message: 'The undo window has expired.' },
        });
        break;
      }
      case 'prune-history': {
        await pruneStoredHistory(Number(msg.keepDays));
        sendResponse({ ok: true, undo: await getUndoStatus() });
        break;
      }
      case 'import-backup': {
        await applyImportedState(msg.records);
        await syncAlarm();
        await updateBadge();
        await deliverPendingNotifications().catch(() => {});
        sendResponse({ ok: true, undo: await getUndoStatus() });
        break;
      }
      case 'get-diagnostics':
        sendResponse({ ok: true, diagnostics: await diagnosticsBundle() });
        break;
      case 'notification-status': {
        const [config, permitted, state] = await Promise.all([
          getNotificationConfig(),
          hasNotificationPermission(),
          getNotificationState(),
        ]);
        sendResponse({
          ok: true,
          config,
          permitted,
          pending: state.pending.length,
          dropped: state.dropped || 0,
        });
        break;
      }
      case 'patch-notification-config': {
        const config = await setNotificationConfig(msg.changes || {});
        let state = await getNotificationState();
        if (!config.enabled) {
          state = { ...state, pending: [], dropped: 0 };
          await setNotificationState(state);
          await chrome.alarms.clear(NOTIFICATION_ALARM);
        } else {
          state = await deliverPendingNotifications();
        }
        sendResponse({
          ok: true,
          config,
          permitted: await hasNotificationPermission(),
          pending: state.pending.length,
          dropped: state.dropped || 0,
        });
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
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: {
        message: error?.message || 'StarBoard could not complete that request.',
        code: error?.code || 'MESSAGE_FAILED',
        // Settings needs this to say when a rate limit lifts rather than
        // repeating a bare "rate limit reached".
        resetAt: error?.resetAt ?? error?.retryAt ?? null,
      },
    });
  });
  return true; // keep the response channel open for the async work above
});

/** StarBoard — settings page. */

import {
  getSettings,
  getCache,
  getBaseline,
  getHistory,
  getNotificationConfig,
  getPortfolioViewState,
  getStorageDiagnostics,
  applyTheme,
} from './lib/storage.js';
import { historyStats } from './lib/history.js';
import {
  assertBackupSize,
  createBackup,
  createCsv,
  serializeBackup,
  validateBackupText,
} from './lib/transfer.js';
import { testApiConnection } from './lib/github.js';
import { testWebsiteConnection } from './lib/scrape.js';
import { formatters, localizeDocument, message as i18nMessage } from './lib/i18n.js';

const GITHUB_ORIGIN = 'https://github.com/*';
const WEB_MIN_REFRESH_MINUTES = 360;

/**
 * One element registry holds inputs, selects, buttons and spans, so a single
 * narrow return type would be wrong for every caller. The type checker is here
 * for logic defects, not to re-derive which tag each id refers to.
 * @param {string} id
 * @returns {any}
 */
const $ = (id) => document.getElementById(id);
localizeDocument();
const fields = {
  username: $('username'),
  token: $('token'),
  tokenMode: $('tokenMode'),
  dataSource: $('dataSource'),
  refreshMinutes: $('refreshMinutes'),
  baselineHours: $('baselineHours'),
  badgeMode: $('badgeMode'),
  theme: $('theme'),
  showFollowers: $('showFollowers'),
  showDescriptions: $('showDescriptions'),
  showMetadata: $('showMetadata'),
  showForkStats: $('showForkStats'),
  showSourceStatus: $('showSourceStatus'),
};
const notificationFields = {
  portfolioMilestone: $('portfolioMilestone'),
  repositoryMilestone: $('repositoryMilestone'),
  portfolioDelta: $('portfolioDelta'),
  repositoryDelta: $('repositoryDelta'),
  quietStart: $('quietStart'),
  quietEnd: $('quietEnd'),
  cooldownMinutes: $('notificationCooldown'),
};

const SOURCE_HINTS = {
  web: 'The default. Reads your github.com repositories page using the session you are already signed in with — no token. Uses one page load per 30 repositories, so larger portfolios use more bandwidth and take longer to refresh.',
  api: 'The secondary option. Reads api.github.com with exact counts and 3-4 requests per refresh. Without a token GitHub allows 60 requests/hour and shows public repos only.',
};
const WEB_PERMISSION_MISSING =
  ' Access to github.com is not currently granted, so website mode cannot read anything —' +
  ' choose the website source again to re-grant it.';

/**
 * Whether `https://github.com/*` is granted. Cached because the hint has to be
 * rendered synchronously, and refreshed from every event that can change it.
 */
let hasWebPermission = true;
/**
 * True once a username has been saved. A first-run profile has not been asked
 * for the github.com origin yet — Save requests it — so the missing-permission
 * warning belongs only to an established install that lost the grant.
 */
let configured = false;

function syncSourceUI() {
  const web = fields.dataSource.value === 'web';
  const webBlocked = web && configured && !hasWebPermission;
  $('sourceHint').textContent =
    SOURCE_HINTS[fields.dataSource.value] + (webBlocked ? WEB_PERMISSION_MISSING : '');
  $('sourceHint').classList.toggle('token-warning', webBlocked);
  $('tokenField').style.display = web ? 'none' : '';
  const persistent = fields.tokenMode.value === 'persistent';
  $('tokenStorageHint').textContent = persistent
    ? 'Persistent mode keeps the PAT in chrome.storage.local after the browser closes. Choose this only on a trusted profile.'
    : 'Session mode keeps the PAT in chrome.storage.session and clears it when the browser session ends.';
  $('tokenStorageHint').classList.toggle('token-warning', persistent);
  $('forgetToken').disabled = pageBusy || !fields.token.value;
  for (const option of fields.refreshMinutes.options) {
    const minutes = Number(option.value);
    option.disabled = web && minutes > 0 && minutes < WEB_MIN_REFRESH_MINUTES;
  }
  if (
    web &&
    Number(fields.refreshMinutes.value) > 0 &&
    Number(fields.refreshMinutes.value) < WEB_MIN_REFRESH_MINUTES
  ) {
    fields.refreshMinutes.value = String(WEB_MIN_REFRESH_MINUTES);
  }
}

const parser = new DOMParser();
const parseHTML = (html) => parser.parseFromString(html, 'text/html');
const feedback = {
  account: { ok: $('status'), error: $('statusError') },
  history: { ok: $('historyStatus'), error: $('historyError') },
  transfer: { ok: $('transferStatus'), error: $('transferError') },
  diagnostics: { ok: $('diagnosticsStatus'), error: $('diagnosticsError') },
  clear: { ok: $('clearStatus'), error: $('clearError') },
};
const feedbackTimers = new Map();

/**
 * Rethrow a message-boundary failure as an Error that still carries the code and
 * reset time. Wrapping it in a bare `new Error(message)` dropped both, which is
 * why a quota failure read as a generic "could not save".
 */
function messageError(error, fallback) {
  /** @type {any} */
  const rethrown = new Error(error?.message || fallback);
  rethrown.code = error?.code || 'MESSAGE_FAILED';
  if (error?.resetAt != null) rethrown.resetAt = error.resetAt;
  return rethrown;
}

async function patchSettings(changes) {
  const response = await chrome.runtime.sendMessage({ type: 'patch-settings', changes });
  if (!response?.ok) throw messageError(response?.error, 'Could not save settings.');
  return response.settings;
}

function say(message, kind = '', target = 'account') {
  message = message ? i18nMessage(message) : message;
  const regions = feedback[target] || feedback.account;
  clearTimeout(feedbackTimers.get(target));
  regions.ok.textContent = '';
  regions.ok.hidden = false;
  regions.error.textContent = '';
  regions.error.hidden = true;
  if (!message) return;
  if (kind === 'err') {
    regions.error.textContent = message;
    regions.error.hidden = false;
    return;
  }
  regions.ok.textContent = message;
  feedbackTimers.set(target, setTimeout(() => say('', '', target), 6000));
}

/**
 * Every control that must not accept input before `load()` has resolved. Until
 * it does, the form still reads its HTML defaults — `web` for the source, `dark`
 * for the theme — and a click would save those over the user's real settings.
 */
function busyControls() {
  return [
    ...Object.values(fields),
    ...Object.values(notificationFields),
    $('notificationsEnabled'),
    $('save'),
    $('test'),
    $('forgetToken'),
    $('historyKeep'),
    $('pruneHistory'),
    $('includePrivateExport'),
    $('includeHistoryExport'),
    $('backupJson'),
    $('exportCsv'),
    $('chooseImport'),
    $('applyImport'),
    $('cancelImport'),
    $('buildDiagnostics'),
    $('copyDiagnostics'),
    $('clear'),
    $('undoClear'),
  ];
}

let pageBusy = true;
let notificationState = null;

function setPageBusy(busy) {
  pageBusy = busy;
  $('settingsGrid').setAttribute('aria-busy', String(busy));
  $('loadingBanner').hidden = !busy;
  for (const control of busyControls()) control.disabled = busy;
  if (busy) return;
  // Several controls carry a disabled state of their own — the notification
  // block, the token button, web-mode refresh intervals. Re-derive them rather
  // than leaving everything enabled.
  syncSourceUI();
  if (notificationState) {
    syncNotificationUI(
      notificationState.config,
      notificationState.permitted,
      notificationState.pending,
      notificationState.dropped,
    );
  }
  $('copyDiagnostics').disabled = !diagnosticsText;
  syncOfflineState();
}

function offline() {
  return navigator.onLine === false;
}

function syncOfflineState() {
  $('offlineBanner').hidden = !offline();
}

window.addEventListener('online', syncOfflineState);
window.addEventListener('offline', syncOfflineState);

function formatRetryAt(timestamp) {
  if (!Number.isFinite(timestamp)) return '';
  const seconds = Math.max(0, Math.round((timestamp - Date.now()) / 1000));
  if (seconds <= 90) return ` Try again in about ${Math.max(1, seconds)} seconds.`;
  const time = formatters
    .dateTime({ hour: 'numeric', minute: '2-digit' })
    .format(new Date(timestamp));
  return ` The quota resets at ${time}.`;
}

/**
 * Surface an error with the one piece of context the raw message never carries:
 * when a rate limit lifts, that a quota failure has a fix on this very page, or
 * that nothing was going to reach the network in the first place.
 */
/** @param {any} error */
function reportError(error, target = 'account', fallback = 'That action failed.') {
  const code = error?.code;
  let message = error?.message || fallback;
  if (code === 'RATE_LIMITED') {
    message += formatRetryAt(error.resetAt ?? error.retryAt);
  } else if (code === 'STORAGE_QUOTA_EXCEEDED') {
    message += ' Prune trend history below to free space, then try again.';
  } else if (offline() && (code === 'NETWORK' || code === 'TIMEOUT')) {
    message = `No network connection — ${message}`;
  }
  say(message, 'err', target);
  if (code === 'STORAGE_QUOTA_EXCEEDED' && !pageBusy) {
    $('pruneHistory').scrollIntoView({ block: 'center' });
    $('pruneHistory').focus();
  }
}

async function withBusy(button, busyLabel, work) {
  const label = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = busyLabel;
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = label;
  }
}

async function showStorageInfo() {
  const [cache, settings, history] = await Promise.all([
    getCache(),
    getSettings(),
    getHistory(),
  ]);
  // Read diagnostics after the records because those reads can quarantine an
  // invalid envelope and the count should reflect that recovery immediately.
  const [bytes, diagnostics] = await Promise.all([
    chrome.storage.local.getBytesInUse(null),
    getStorageDiagnostics(),
  ]);
  const repos = cache?.repos?.length || 0;
  const badgeRepos = cache?.repos?.filter((repo) => settings.includeForks || !repo.fork);
  const stars = badgeRepos?.reduce((total, repo) => total + repo.stargazers_count, 0);
  const trends = historyStats(history);
  $('storageSummary').textContent =
    `${repos} repos cached, ${trends.points} daily trend points across ` +
    `${trends.days} day${trends.days === 1 ? '' : 's'}, ${(bytes / 1024).toFixed(1)} KB total.` +
    (diagnostics.quarantined
      ? ` ${diagnostics.quarantined} storage record${diagnostics.quarantined === 1 ? '' : 's'} quarantined.`
      : '');
  $('storageDiagnosticsLink').hidden = diagnostics.quarantined === 0;
  $('badgePreview').textContent = stars == null ? '—' : formatters.number().format(stars);
}

async function load() {
  const [s] = await Promise.all([
    getSettings(),
    chrome.permissions
      .contains({ origins: [GITHUB_ORIGIN] })
      .then((granted) => {
        hasWebPermission = granted;
      })
      .catch(() => {}),
  ]);
  configured = Boolean(s.username);
  fields.username.value = s.username;
  fields.token.value = s.token;
  fields.tokenMode.value = s.tokenMode;
  fields.refreshMinutes.value = String(s.refreshMinutes);
  fields.baselineHours.value = String(s.baselineHours);
  fields.badgeMode.value = s.badgeMode;
  fields.theme.value = s.theme;
  fields.dataSource.value = s.dataSource;
  fields.showFollowers.checked = s.showFollowers;
  fields.showDescriptions.checked = s.showDescriptions;
  fields.showMetadata.checked = s.showMetadata;
  fields.showForkStats.checked = s.showForkStats;
  fields.showSourceStatus.checked = s.showSourceStatus;
  syncSourceUI();
  applyTheme(s.theme);
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  await Promise.all([showStorageInfo(), loadNotificationConfig()]);
}

function collect() {
  return {
    username: fields.username.value.trim().replace(/^@/, ''),
    token: fields.token.value.trim(),
    tokenMode: fields.tokenMode.value,
    refreshMinutes: Number(fields.refreshMinutes.value),
    baselineHours: Number(fields.baselineHours.value),
    badgeMode: fields.badgeMode.value,
    theme: fields.theme.value,
    dataSource: fields.dataSource.value,
    showFollowers: fields.showFollowers.checked,
    showDescriptions: fields.showDescriptions.checked,
    showMetadata: fields.showMetadata.checked,
    showForkStats: fields.showForkStats.checked,
    showSourceStatus: fields.showSourceStatus.checked,
  };
}

function exportSelection() {
  return {
    includePrivate: $('includePrivateExport').checked,
    includeHistory: $('includeHistoryExport').checked,
  };
}

function downloadText(text, filename, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportDate() {
  return new Date().toISOString().slice(0, 10);
}

function notificationPatch() {
  return {
    portfolioMilestone: Number(notificationFields.portfolioMilestone.value),
    repositoryMilestone: Number(notificationFields.repositoryMilestone.value),
    portfolioDelta: Number(notificationFields.portfolioDelta.value),
    repositoryDelta: Number(notificationFields.repositoryDelta.value),
    quietStart: notificationFields.quietStart.value,
    quietEnd: notificationFields.quietEnd.value,
    cooldownMinutes: Number(notificationFields.cooldownMinutes.value),
  };
}

function syncNotificationUI(config, permitted, pending = 0, dropped = 0) {
  notificationState = { config, permitted, pending, dropped };
  $('notificationsEnabled').checked = !!config.enabled;
  $('notificationsEnabled').disabled = pageBusy;
  for (const [key, field] of Object.entries(notificationFields)) {
    field.value = String(config[key]);
    field.disabled = pageBusy || !config.enabled;
  }
  $('notificationControls').setAttribute('aria-disabled', String(!config.enabled));
  $('notificationPermissionState').textContent =
    config.enabled && permitted
      ? `On · ${pending} unread alert${pending === 1 ? '' : 's'} saved in the popup${
          dropped ? `; ${dropped} older alert${dropped === 1 ? '' : 's'} could not be retained` : ''
        }. Quiet hours and cooldown apply locally.`
      : config.enabled
        ? 'Notification access was removed. Turn alerts off and on to grant it again.'
        : permitted
          ? 'Off · notification access remains granted in Chrome but no alerts are generated.'
          : 'Off · notification access has not been requested.';
}

async function loadNotificationConfig() {
  const response = await chrome.runtime.sendMessage({ type: 'notification-status' });
  if (!response?.ok) throw messageError(response?.error, 'Could not load notifications.');
  syncNotificationUI(response.config, response.permitted, response.pending, response.dropped);
}

/**
 * Website mode reads github.com through an optional permission. Even though it
 * is the default source, Chrome only prompts when the user selects it or saves
 * from a click — both are qualifying user gestures.
 */
async function ensureWebPermission() {
  hasWebPermission = await chrome.permissions.contains({ origins: [GITHUB_ORIGIN] });
  if (!hasWebPermission) {
    hasWebPermission = await chrome.permissions.request({ origins: [GITHUB_ORIGIN] });
  }
  return hasWebPermission;
}

fields.dataSource.addEventListener('change', async () => {
  fields.dataSource.disabled = true;
  try {
    const prior = await getSettings();
    if (fields.dataSource.value === 'web' && !(await ensureWebPermission())) {
      fields.dataSource.value = prior.dataSource;
      fields.refreshMinutes.value = String(prior.refreshMinutes);
      syncSourceUI();
      say(
        `Permission for github.com denied — staying on ${
          prior.dataSource === 'web' ? 'website' : 'API'
        } mode.`,
        'err',
      );
      return;
    }
    syncSourceUI();
    const source = fields.dataSource.value;
    const refreshMinutes = Number(fields.refreshMinutes.value);
    const settings = await patchSettings({ dataSource: source, refreshMinutes });
    fields.token.value = settings.token;
    syncSourceUI();
    if (offline()) {
      say(
        `Source set to ${source === 'web' ? 'github.com' : 'the GitHub API'}. StarBoard is ` +
          'offline — it will read from there once you reconnect.',
        'ok',
      );
      return;
    }
    say(`Switching to ${source === 'web' ? 'github.com' : 'the GitHub API'}…`);
    const result = await chrome.runtime.sendMessage({
      type: 'settings-changed',
      refresh: true,
      source,
      reason: 'source-change',
    });
    if (result?.ok) {
      say(`Now reading from ${source === 'web' ? 'github.com' : 'the GitHub API'}.`, 'ok');
    } else {
      reportError(
        {
          ...(result?.error || {}),
          message: `${result?.error?.message || 'Source refresh failed.'} The prior snapshot is still shown.`,
        },
        'account',
      );
    }
  } finally {
    fields.dataSource.disabled = false;
  }
});

$('save').addEventListener('click', async () => {
  await withBusy($('save'), 'Saving…', async () => {
    const next = collect();
    if (!next.username && !next.token) {
      say('Enter a username (or a token) first.', 'err');
      return;
    }
    if (next.dataSource === 'web') {
      if (!next.username) {
        say('Web mode needs a username — it reads github.com/<username>.', 'err');
        return;
      }
      if (!(await ensureWebPermission())) {
        say('Permission for github.com denied.', 'err');
        return;
      }
    }
    await patchSettings(next);
    configured = Boolean(next.username);
    fields.username.value = next.username;
    await chrome.runtime.sendMessage({ type: 'settings-changed' });
    // Saving is local and works offline; only the refresh that follows needs
    // the network, so say which half happened instead of failing both.
    if (offline()) {
      say('Settings saved. StarBoard is offline — the refresh will run once you reconnect.', 'ok');
      await showStorageInfo();
      return;
    }
    say('Saved — refreshing…');
    const res = await chrome.runtime.sendMessage({
      type: 'refresh',
      force: true,
      source: next.dataSource,
      reason: 'settings-save',
    });
    if (res?.ok) {
      say(`Synced ${res.cache.repos.length} repos for @${res.cache.profile.login}.`, 'ok');
      await showStorageInfo();
    } else {
      reportError(res?.error, 'account', 'Refresh failed.');
    }
  }).catch((err) => reportError(err, 'account', 'Could not save settings.'));
});

let connectionController = null;
window.addEventListener('pagehide', () => connectionController?.abort('pagehide'));

$('test').addEventListener('click', async () => {
  if (offline()) {
    say(
      'No network connection — a connection test cannot reach GitHub. Reconnect and try again.',
      'err',
    );
    return;
  }
  connectionController?.abort('restarted');
  const controller = new AbortController();
  connectionController = controller;
  const button = $('test');
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Cancel & retest';
  const { username, token, dataSource } = collect();
  say('Testing…');
  try {
    if (dataSource === 'web') {
      if (!(await ensureWebPermission())) {
        if (connectionController === controller) say('Permission for github.com denied.', 'err');
        return;
      }
      const res = await testWebsiteConnection(username, parseHTML, {
        signal: controller.signal,
      });
      if (connectionController !== controller) return;
      const stars = res.repos.reduce((sum, repo) => sum + repo.stargazers_count, 0);
      say(
        `OK — @${res.profile.login}: first page has ${res.repos.length} repositories and ` +
          `${stars} stars${res.approximate ? ' (some counts abbreviated by GitHub)' : ''}.`,
        'ok',
      );
      return;
    }
    const res = await testApiConnection(
      { username, token },
      { signal: controller.signal },
    );
    if (connectionController !== controller) return;
    say(
      `OK — @${res.profile.login}: API reachable with one request. ` +
        `${res.rate?.remaining ?? '?'}/${res.rate?.limit ?? '?'} API calls left.`,
      'ok',
    );
  } catch (err) {
    if (connectionController !== controller) return;
    if (err.code === 'CANCELLED') say('Connection test cancelled.', 'err');
    else reportError(err, 'account', 'The connection test failed.');
  } finally {
    if (connectionController === controller) {
      connectionController = null;
      button.removeAttribute('aria-busy');
      button.textContent = 'Test connection';
    }
  }
});

let clearArmedUntil = 0;
let clearResetTimer;

function resetClearConfirmation() {
  clearArmedUntil = 0;
  $('clear').textContent = 'Clear snapshot, baseline & history';
  $('clearScope').hidden = true;
}

async function syncUndoControl() {
  const response = await chrome.runtime.sendMessage({ type: 'undo-status' });
  $('undoClear').hidden = !response?.undo?.available;
}

$('clear').addEventListener('click', async () => {
  if (Date.now() > clearArmedUntil) {
    clearArmedUntil = Date.now() + 8000;
    $('clear').textContent = 'Confirm clear all portfolio data';
    $('clearScope').hidden = false;
    say('Confirm the exact data scope below.', 'err', 'clear');
    clearTimeout(clearResetTimer);
    clearResetTimer = setTimeout(resetClearConfirmation, 8000);
    return;
  }
  clearTimeout(clearResetTimer);
  resetClearConfirmation();
  await withBusy($('clear'), 'Clearing…', async () => {
    const response = await chrome.runtime.sendMessage({ type: 'clear-portfolio' });
    if (!response?.ok) throw messageError(response?.error, 'Could not clear local data.');
    await showStorageInfo();
    $('undoClear').hidden = !response.undo?.available;
    say('Snapshot, baseline and history cleared. Undo is available for 10 minutes.', 'ok', 'clear');
  }).catch((error) => reportError(error, 'clear', 'Could not clear local data.'));
});

let pruneArmedUntil = 0;
let pruneResetTimer;

function resetPruneConfirmation() {
  pruneArmedUntil = 0;
  $('pruneHistory').textContent = 'Prune history';
  $('pruneScope').hidden = true;
}

$('pruneHistory').addEventListener('click', async () => {
  const keepDays = Number($('historyKeep').value);
  if (Date.now() > pruneArmedUntil) {
    pruneArmedUntil = Date.now() + 8000;
    $('pruneHistory').textContent = `Confirm keep ${keepDays} days`;
    $('pruneScope').textContent =
      `This permanently removes trend points older than ${keepDays} days. ` +
      'The current snapshot, baseline, settings and credentials stay unchanged.';
    $('pruneScope').hidden = false;
    say('Confirm the history range to prune.', 'err', 'history');
    clearTimeout(pruneResetTimer);
    pruneResetTimer = setTimeout(resetPruneConfirmation, 8000);
    return;
  }
  clearTimeout(pruneResetTimer);
  resetPruneConfirmation();
  await withBusy($('pruneHistory'), 'Pruning…', async () => {
    const response = await chrome.runtime.sendMessage({ type: 'prune-history', keepDays });
    if (!response?.ok) throw messageError(response?.error, 'Could not prune history.');
    await showStorageInfo();
    $('undoClear').hidden = !response.undo?.available;
    say(`History now keeps at most ${keepDays} days. Undo is available for 10 minutes.`, 'ok', 'history');
  }).catch((error) => reportError(error, 'history', 'Could not prune history.'));
});

async function readPortableState() {
  const [settings, cache, baseline, history, notificationConfig, portfolioViews] = await Promise.all([
    getSettings(),
    getCache(),
    getBaseline(),
    getHistory(),
    getNotificationConfig(),
    getPortfolioViewState(),
  ]);
  return { settings, cache, baseline, history, notificationConfig, portfolioViews };
}

$('backupJson').addEventListener('click', async () => {
  await withBusy($('backupJson'), 'Preparing…', async () => {
    const document = await createBackup({
      ...(await readPortableState()),
      ...exportSelection(),
    });
    let text;
    try {
      text = serializeBackup(document);
    } catch (error) {
      if (error?.code === 'BACKUP_TOO_LARGE' && error.historyIncluded) {
        $('includeHistoryExport').checked = false;
        $('includeHistoryExport').focus();
        throw new Error(
          `${error.message} Trend history was deselected; choose Download JSON ` +
            'again to create a restorable backup without it.',
        );
      }
      throw error;
    }
    downloadText(
      text,
      `StarBoard-backup-${exportDate()}.json`,
      'application/json',
    );
    say('Checksummed JSON backup downloaded. No personal access token was included.', 'ok', 'transfer');
  }).catch((error) => reportError(error, 'transfer', 'Could not create the backup.'));
});

$('exportCsv').addEventListener('click', async () => {
  await withBusy($('exportCsv'), 'Preparing…', async () => {
    const csv = createCsv({
      ...(await readPortableState()),
      ...exportSelection(),
    });
    downloadText(csv, `StarBoard-repositories-${exportDate()}.csv`, 'text/csv;charset=utf-8');
    say('Timestamped repository CSV downloaded.', 'ok', 'transfer');
  }).catch((error) => reportError(error, 'transfer', 'Could not create the CSV.'));
});

let pendingImportRecords = null;
let applyImportArmedUntil = 0;
let applyImportResetTimer;

function resetApplyImportConfirmation() {
  applyImportArmedUntil = 0;
  clearTimeout(applyImportResetTimer);
  $('applyImport').textContent = 'Apply restore';
}

function resetImportPreview() {
  resetApplyImportConfirmation();
  pendingImportRecords = null;
  $('importPreview').hidden = true;
  $('importSummary').textContent = '';
  $('importFile').value = '';
}

$('chooseImport').addEventListener('click', () => $('importFile').click());
$('cancelImport').addEventListener('click', resetImportPreview);

$('importFile').addEventListener('change', async () => {
  const file = $('importFile').files?.[0];
  if (!file) return;
  resetApplyImportConfirmation();
  try {
    // File.size is already bytes, so reject before file.text() allocates an
    // attacker-controlled document that the validator will refuse anyway.
    assertBackupSize(file.size);
    const preview = await validateBackupText(await file.text());
    pendingImportRecords = preview.records;
    const summary = preview.summary;
    $('importSummary').textContent =
      `${summary.repositories} repositories, ${summary.baselineRepositories} baseline entries, ` +
      `${summary.historyPoints} history points across ${summary.historyDays} days, ` +
      `${summary.privateRepositories} private repositories. ` +
      `${summary.migratedRecords} record${summary.migratedRecords === 1 ? '' : 's'} will migrate. ` +
      `${summary.notificationConfig ? 'Notification settings are included.' : 'No notification settings.'} ` +
      `${summary.savedViews} saved view${summary.savedViews === 1 ? '' : 's'}.`;
    $('importPreview').hidden = false;
    say('Backup validated. Review the dry-run summary before applying it.', 'ok', 'transfer');
  } catch (error) {
    resetImportPreview();
    say(error.message || 'Could not validate that backup.', 'err', 'transfer');
  }
});

$('applyImport').addEventListener('click', async () => {
  if (!pendingImportRecords) return;
  if (Date.now() > applyImportArmedUntil) {
    applyImportArmedUntil = Date.now() + 8000;
    $('applyImport').textContent = 'Confirm apply restore';
    say(
      'Applying this backup replaces the selected local records. Activate again within 8 seconds to confirm.',
      'err',
      'transfer',
    );
    applyImportResetTimer = setTimeout(resetApplyImportConfirmation, 8000);
    return;
  }
  resetApplyImportConfirmation();
  await withBusy($('applyImport'), 'Restoring…', async () => {
    const response = await chrome.runtime.sendMessage({
      type: 'import-backup',
      records: pendingImportRecords,
    });
    if (!response?.ok) throw messageError(response?.error, 'Could not restore backup.');
    resetImportPreview();
    await load();
    $('undoClear').hidden = !response.undo?.available;
    say('Backup restored. The prior local state is undoable for 10 minutes.', 'ok', 'transfer');
  }).catch((error) => reportError(error, 'transfer', 'Could not restore backup.'));
});

let diagnosticsText = '';

$('buildDiagnostics').addEventListener('click', async () => {
  await withBusy($('buildDiagnostics'), 'Building…', async () => {
    const response = await chrome.runtime.sendMessage({ type: 'get-diagnostics' });
    if (!response?.ok) {
      throw messageError(response?.error, 'Could not build diagnostics.');
    }
    diagnosticsText = `${JSON.stringify(response.diagnostics, null, 2)}\n`;
    $('diagnosticsOutput').textContent = diagnosticsText;
    $('diagnosticsOutput').hidden = false;
    $('copyDiagnostics').disabled = false;
    say('Redacted diagnostics built locally.', 'ok', 'diagnostics');
  }).catch((error) => reportError(error, 'diagnostics', 'Could not build diagnostics.'));
});

async function copyDiagnosticsText() {
  try {
    await navigator.clipboard.writeText(diagnosticsText);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = diagnosticsText;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  }
}

$('copyDiagnostics').addEventListener('click', async () => {
  if (!diagnosticsText) return;
  const copied = await copyDiagnosticsText();
  say(
    copied ? 'Diagnostics copied.' : 'Copy was blocked; select the diagnostics text manually.',
    copied ? 'ok' : 'err',
    'diagnostics',
  );
});

$('notificationsEnabled').addEventListener('change', async () => {
  const checkbox = $('notificationsEnabled');
  const enabling = checkbox.checked;
  checkbox.disabled = true;
  try {
    let permitted = await chrome.permissions.contains({ permissions: ['notifications'] });
    if (enabling && !permitted) {
      permitted = await chrome.permissions.request({ permissions: ['notifications'] });
    }
    if (enabling && !permitted) {
      checkbox.checked = false;
      say('Notification access was denied; alerts remain off.', 'err');
      await loadNotificationConfig();
      return;
    }
    const response = await chrome.runtime.sendMessage({
      type: 'patch-notification-config',
      changes: { enabled: enabling },
    });
    if (!response?.ok) throw messageError(response?.error, 'Could not save notifications.');
    syncNotificationUI(response.config, response.permitted, response.pending, response.dropped);
    say(enabling ? 'Local alerts enabled.' : 'Local alerts disabled.', 'ok');
  } catch (error) {
    await loadNotificationConfig().catch(() => {});
    say(error.message || 'Could not change notification access.', 'err');
  } finally {
    checkbox.disabled = false;
  }
});

for (const field of Object.values(notificationFields)) {
  field.addEventListener('change', async () => {
    field.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'patch-notification-config',
        changes: notificationPatch(),
      });
      if (!response?.ok) {
        throw messageError(response?.error, 'Could not save notification settings.');
      }
      syncNotificationUI(response.config, response.permitted, response.pending, response.dropped);
      say('Notification settings saved.', 'ok');
    } catch (error) {
      await loadNotificationConfig().catch(() => {});
      say(error.message || 'Could not save notification settings.', 'err');
    } finally {
      field.disabled = !$('notificationsEnabled').checked;
    }
  });
}

chrome.permissions.onRemoved.addListener(async (permissions) => {
  if (permissions.permissions?.includes('notifications')) {
    loadNotificationConfig().catch(() => {});
  }
  // Revoking github.com leaves the stored source reading `web` while website
  // mode can no longer fetch anything. Re-sync from storage and say so.
  if (permissions.origins?.some((origin) => origin.includes('github.com'))) {
    hasWebPermission = false;
    const settings = await getSettings().catch(() => null);
    if (settings) {
      configured = Boolean(settings.username);
      fields.dataSource.value = settings.dataSource;
    }
    syncSourceUI();
    if (settings?.dataSource === 'web') {
      say(
        'Access to github.com was removed. Website mode cannot read your repositories until ' +
          'you select the website source again, or switch to the GitHub API.',
        'err',
      );
    }
  }
});

chrome.permissions.onAdded.addListener((permissions) => {
  if (permissions.origins?.some((origin) => origin.includes('github.com'))) {
    hasWebPermission = true;
    syncSourceUI();
  }
});

$('undoClear').addEventListener('click', async () => {
  await withBusy($('undoClear'), 'Restoring…', async () => {
    const response = await chrome.runtime.sendMessage({ type: 'undo' });
    if (!response?.ok) throw messageError(response?.error, 'Undo is no longer available.');
    await load();
    $('undoClear').hidden = true;
    say('Last data action undone.', 'ok', 'clear');
  }).catch((error) => {
    $('undoClear').hidden = true;
    say(error.message || 'Undo is no longer available.', 'err', 'clear');
  });
});

fields.token.addEventListener('input', syncSourceUI);
fields.tokenMode.addEventListener('change', async () => {
  fields.tokenMode.disabled = true;
  try {
    const settings = await patchSettings({
      tokenMode: fields.tokenMode.value,
      token: fields.token.value,
    });
    fields.token.value = settings.token;
    say(
      settings.tokenMode === 'session'
        ? 'Token will clear with this browser session.'
        : 'Token will remain on this device until you forget it.',
      settings.tokenMode === 'session' ? 'ok' : '',
    );
  } catch (error) {
    say(error.message || 'Could not change token storage.', 'err');
    const settings = await getSettings();
    fields.tokenMode.value = settings.tokenMode;
  } finally {
    fields.tokenMode.disabled = false;
    syncSourceUI();
  }
});

$('forgetToken').addEventListener('click', async () => {
  await withBusy($('forgetToken'), 'Forgetting…', async () => {
    const response = await chrome.runtime.sendMessage({ type: 'forget-token' });
    if (!response?.ok) throw messageError(response?.error, 'Could not forget the token.');
    fields.token.value = '';
    fields.tokenMode.value = 'session';
    syncSourceUI();
    say('Token removed from session and persistent storage.', 'ok');
  }).catch((error) => reportError(error, 'account', 'Could not forget the token.'));
  syncSourceUI();
});

let settingsSaveQueue = Promise.resolve();
let pendingSettingsSaves = 0;

const INSTANT_SETTING_KEYS = [
  'refreshMinutes',
  'baselineHours',
  'badgeMode',
  'theme',
  'showFollowers',
  'showDescriptions',
  'showMetadata',
  'showForkStats',
  'showSourceStatus',
];
const INSTANT_SETTING_LABELS = {
  refreshMinutes: 'Refresh interval',
  baselineHours: 'Baseline window',
  badgeMode: 'Badge display',
  theme: 'Theme',
  showFollowers: 'Follower count',
  showDescriptions: 'Repository descriptions',
  showMetadata: 'Language and activity',
  showForkStats: 'Fork statistics',
  showSourceStatus: 'Source and quota status',
};

for (const key of INSTANT_SETTING_KEYS) {
  fields[key].addEventListener('change', () => {
    pendingSettingsSaves += 1;
    document.body.dataset.settingsState = 'saving';
    settingsSaveQueue = settingsSaveQueue
      .then(async () => {
        const values = collect();
        const patch = Object.fromEntries(
          INSTANT_SETTING_KEYS.map((settingKey) => [settingKey, values[settingKey]]),
        );
        await patchSettings(patch);
        if (key === 'theme') applyTheme(values.theme);
        await chrome.runtime.sendMessage({ type: 'settings-changed' });
        say(`${INSTANT_SETTING_LABELS[key]} saved.`, 'ok');
      })
      .catch((err) => reportError(err, 'account', 'Could not save that setting.'))
      .finally(() => {
        pendingSettingsSaves -= 1;
        if (pendingSettingsSaves === 0) document.body.dataset.settingsState = 'saved';
      });
  });
}

// The form starts disabled and busy. Until `load()` resolves it still holds the
// markup defaults — `web`, `dark`, `—` — and any activation would write those
// over the user's real settings. A rejection also used to leave the page
// silently half-initialised: storage figures stuck at defaults and the undo
// control hidden even when an undo was available.
setPageBusy(true);
syncOfflineState();
load()
  .then(async () => {
    setPageBusy(false);
    await syncUndoControl();
  })
  .catch((error) => {
    $('loadingBanner').hidden = true;
    $('settingsGrid').setAttribute('aria-busy', 'false');
    say(
      `Settings could not be loaded, so the controls stay locked to avoid overwriting them. ${
        error?.message || 'Reload the page to try again.'
      }`,
      'err',
    );
  });

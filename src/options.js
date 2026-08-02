/** StarBoard — settings page. */

import {
  getSettings,
  getCache,
  getBaseline,
  getHistory,
  getNotificationConfig,
  getPortfolioViewState,
  getRefreshFailures,
  getStorageDiagnostics,
  getAuthStatus,
  AUTH_STATUS_KEY,
  applyTheme,
} from './lib/storage.js';
import { historyStats } from './lib/history.js';
import {
  CSV_FORMAT_VERSION,
  HISTORY_REPORT_FORMAT_VERSION,
  assertBackupSize,
  createBackup,
  createCsv,
  createHistoryReport,
  createSvgTrendBadge,
  serializeBackup,
  serializeHistoryReport,
  validateBackupText,
} from './lib/transfer.js';
import { testApiConnection } from './lib/github.js';
import { testWebsiteConnection } from './lib/scrape.js';
import { formatters, localizeDocument, message as i18nMessage } from './lib/i18n.js';
import { runtimeMessage as t } from './lib/i18n-messages.js';
import { dismissPrivacyNotice, getPrivacyNotice } from './lib/install.js';
import { repositoryAlertKey } from './lib/notifications.js';

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
  showReleaseStats: $('showReleaseStats'),
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
  repositoryAlertMode: $('repositoryAlertMode'),
  releaseAlertMode: $('releaseAlertMode'),
};

const SOURCE_HINTS = {
  web: t('optionsSourceHintWeb'),
  api: t('optionsSourceHintApi'),
};
const WEB_PERMISSION_MISSING = t('optionsWebPermissionMissing');

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
let sourceCapabilityNotice = '';

function sourceLabel(source) {
  return source === 'web' ? t('optionsGitHubWebsite') : t('optionsGitHubApi');
}

function sourceDowngradeMessage(downgrade) {
  if (!downgrade?.requested || !downgrade?.effective) return '';
  const why =
    downgrade.reason === 'web-source-disabled'
      ? t('popupRemoteSourceDisabled')
      : t('popupSourceUnavailable');
  return t('popupSourceDowngrade', [
    sourceLabel(downgrade.requested),
    why,
    sourceLabel(downgrade.effective),
  ]);
}

function syncSourceUI() {
  const web = fields.dataSource.value === 'web';
  const webBlocked = web && configured && !hasWebPermission;
  $('sourceHint').textContent =
    SOURCE_HINTS[fields.dataSource.value] +
    (webBlocked ? WEB_PERMISSION_MISSING : '') +
    (sourceCapabilityNotice ? ` ${sourceCapabilityNotice}` : '');
  $('sourceHint').classList.toggle('token-warning', webBlocked);
  $('tokenField').style.display = web ? 'none' : '';
  const persistent = fields.tokenMode.value === 'persistent';
  $('tokenStorageHint').textContent = persistent
    ? t('optionsTokenPersistentHint')
    : t('optionsTokenSessionHint');
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

const AUTH_STATUS_LABELS = {
  unknown: t('optionsAuthUnknown'),
  active: t('optionsAuthActive'),
  expired: t('optionsAuthExpired'),
  revoked: t('optionsAuthRevoked'),
  denied: t('optionsAuthDenied'),
  'rate-limited': t('optionsAuthRateLimited'),
};

function renderAuthStatus(status) {
  const box = $('authStatus');
  if (!box) return;
  const value = AUTH_STATUS_LABELS[status?.status] ? status.status : 'unknown';
  if (value === 'unknown' && !fields.token.value) {
    box.hidden = true;
    return;
  }
  const last = Number.isFinite(status?.lastAuthenticatedAt)
    ? t('optionsAuthLast', [formatters.dateTime({ dateStyle: 'medium', timeStyle: 'short' }).format(new Date(status.lastAuthenticatedAt))])
    : t('optionsAuthNever');
  const action = ['expired', 'revoked', 'denied'].includes(value)
    ? t('optionsAuthAction', [t('optionsReplaceToken')])
    : '';
  $('authStatusText').textContent = `${AUTH_STATUS_LABELS[value]}.${last}${action}`;
  box.dataset.state = value;
  box.hidden = false;
  $('replaceToken').hidden = !['expired', 'revoked', 'denied'].includes(value);
}

async function loadAuthStatus() {
  renderAuthStatus(await getAuthStatus().catch(() => ({ status: 'unknown' })));
}

function renderRefreshFailures(history) {
  const records = Array.isArray(history?.records) ? [...history.records].reverse() : [];
  const list = $('refreshFailuresList');
  if (!list) return;
  list.replaceChildren();
  $('refreshFailuresSummary').textContent = records.length
    ? records.length === 1
      ? t('optionsRefreshFailuresOne', [records.length])
      : t('optionsRefreshFailuresMany', [records.length])
    : t('optionsRefreshFailuresNone');
  for (const record of records) {
    const source =
      record.source === 'web'
        ? t('optionsGitHubWebsite')
        : record.source === 'api'
          ? t('optionsGitHubApi')
          : t('optionsUnknownSource');
    const at = Number.isFinite(record.at)
      ? formatters.dateTime({ dateStyle: 'medium', timeStyle: 'short' }).format(new Date(record.at))
      : t('optionsUnknownTime');
    const item = document.createElement('li');
    item.textContent = `${at} · ${source} · ${record.code || t('optionsRefreshFailedCode')} · ${
      record.authenticated ? t('optionsAuthenticated') : t('optionsNotAuthenticated')
    }`;
    list.append(item);
  }
}

async function loadRefreshFailures() {
  renderRefreshFailures(await getRefreshFailures().catch(() => ({ records: [] })));
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
  if (!response?.ok) throw messageError(response?.error, t('optionsSaveSettingsError'));
  return response.settings;
}

function renderFeedback(message, kind = '', target = 'account') {
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
  feedbackTimers.set(target, setTimeout(() => renderFeedback('', '', target), 6000));
}

function say(message, kind = '', target = 'account') {
  renderFeedback(message ? i18nMessage(message) : message, kind, target);
}

function sayT(key, substitutions, kind = '', target = 'account') {
  renderFeedback(t(key, substitutions), kind, target);
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
    $('releaseAlertsEnabled'),
    $('save'),
    $('test'),
    $('forgetToken'),
    $('replaceToken'),
    $('historyKeep'),
    $('pruneHistory'),
    $('includePrivateExport'),
    $('includeHistoryExport'),
    $('backupJson'),
    $('exportCsv'),
    $('historyReportDuration'),
    $('exportHistoryJson'),
    $('exportHistorySvg'),
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
let notificationCache = null;
let optionSettings = null;

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
  if (seconds <= 90) return t('optionsRetrySeconds', [Math.max(1, seconds)]);
  const time = formatters
    .dateTime({ hour: 'numeric', minute: '2-digit' })
    .format(new Date(timestamp));
  return t('optionsQuotaReset', [time]);
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
    message += ` ${t('optionsPruneQuotaAdvice')}`;
  } else if (offline() && (code === 'NETWORK' || code === 'TIMEOUT')) {
    message = t('optionsNoNetwork', [message]);
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
    t('optionsStorageSummary', [
      repos,
      trends.points,
      trends.days,
      trends.days === 1 ? '' : 's',
      (bytes / 1024).toFixed(1),
      diagnostics.quarantined
        ? t('optionsStorageQuarantine', [diagnostics.quarantined, diagnostics.quarantined === 1 ? '' : 's'])
        : '',
    ]);
  $('storageDiagnosticsLink').hidden = diagnostics.quarantined === 0;
  $('badgePreview').textContent = stars == null ? '—' : formatters.number().format(stars);
}

async function load() {
  const [s, cache, privacyNotice] = await Promise.all([
    getSettings(),
    getCache().catch(() => null),
    getPrivacyNotice().catch(() => null),
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
  sourceCapabilityNotice = '';
  if (cache?.sourceDowngrade?.requested === s.dataSource) {
    fields.dataSource.value = cache.sourceDowngrade.effective;
    sourceCapabilityNotice = sourceDowngradeMessage(cache.sourceDowngrade);
  }
  renderPrivacyNotice(privacyNotice);
  fields.showFollowers.checked = s.showFollowers;
  fields.showDescriptions.checked = s.showDescriptions;
  fields.showMetadata.checked = s.showMetadata;
  fields.showForkStats.checked = s.showForkStats;
  fields.showReleaseStats.checked = s.showReleaseStats;
  fields.showSourceStatus.checked = s.showSourceStatus;
  syncSourceUI();
  applyTheme(s.theme);
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  await Promise.all([
    showStorageInfo(),
    loadNotificationConfig(),
    loadAuthStatus(),
    loadRefreshFailures(),
  ]);
  optionSettings = s;
}

function renderPrivacyNotice(notice) {
  const banner = $('privacyChangeNotice');
  const text = $('privacyChangeText');
  if (!banner || !text) return;
  text.textContent = notice?.message || '';
  banner.hidden = !notice;
  banner.dataset.noticeId = notice?.id || '';
}

$('privacyChangeDismiss')?.addEventListener('click', async () => {
  const banner = $('privacyChangeNotice');
  const id = banner?.dataset.noticeId;
  if (!id) return;
  await dismissPrivacyNotice(id).catch(() => {});
  renderPrivacyNotice(await getPrivacyNotice().catch(() => null));
});

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
    showReleaseStats: fields.showReleaseStats.checked,
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
    repositoryAlertMode: notificationFields.repositoryAlertMode.value,
    repositoryAlerts: repositoryPreferencePatch(),
    releaseAlertsEnabled: $('releaseAlertsEnabled').checked,
    releaseAlertMode: notificationFields.releaseAlertMode.value,
    releaseAlerts: releasePreferencePatch(),
  };
}

function repositoryPreferencePatch() {
  const mode = notificationFields.repositoryAlertMode.value;
  const existing = new Set(notificationState?.config?.repositoryAlerts || []);
  const inputs = [...$('repositoryAlertList').querySelectorAll('input[data-repository-key]')];
  const current = new Set(inputs.map((input) => input.dataset.repositoryKey));
  const next = new Set([...existing].filter((key) => !current.has(key)));
  for (const input of inputs) {
    const enabled = input.checked;
    if ((mode === 'selected' && enabled) || (mode !== 'selected' && !enabled)) {
      next.add(input.dataset.repositoryKey);
    }
  }
  return [...next].slice(0, 500);
}

function releasePreferencePatch() {
  const mode = notificationFields.releaseAlertMode.value;
  const existing = new Set(notificationState?.config?.releaseAlerts || []);
  const inputs = [...$('releaseAlertList').querySelectorAll('input[data-repository-key]')];
  const current = new Set(inputs.map((input) => input.dataset.repositoryKey));
  const next = new Set([...existing].filter((key) => !current.has(key)));
  for (const input of inputs) {
    const enabled = input.checked;
    if ((mode === 'selected' && enabled) || (mode !== 'selected' && !enabled)) {
      next.add(input.dataset.repositoryKey);
    }
  }
  return [...next].slice(0, 500);
}

function renderRepositoryAlertPreferences(config, cache = notificationCache) {
  notificationCache = cache;
  const list = $('repositoryAlertList');
  list.replaceChildren();
  const repos = [...(cache?.repos || [])].sort((a, b) => a.full_name.localeCompare(b.full_name));
  if (!repos.length) {
    list.textContent = t('optionsNoRepositoriesForAlerts');
    return;
  }
  const preferences = new Set(config.repositoryAlerts || []);
  for (const repo of repos) {
    const key = repositoryAlertKey(repo);
    const label = document.createElement('label');
    label.className = 'repository-alert-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.repositoryKey = key;
    input.checked = config.repositoryAlertMode === 'selected'
      ? preferences.has(key)
      : !preferences.has(key);
    input.disabled = pageBusy || !config.enabled;
    const name = document.createElement('span');
    name.textContent = repo.full_name;
    label.append(input, name);
    list.append(label);
  }
}

function renderReleaseAlertPreferences(config, cache = notificationCache) {
  const list = $('releaseAlertList');
  list.replaceChildren();
  const repos = [...(cache?.repos || [])].sort((a, b) => a.full_name.localeCompare(b.full_name));
  if (!repos.length) {
    list.textContent = t('optionsNoRepositoriesForAlerts');
    return;
  }
  const preferences = new Set(config.releaseAlerts || []);
  for (const repo of repos) {
    const key = repositoryAlertKey(repo);
    const label = document.createElement('label');
    label.className = 'repository-alert-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.repositoryKey = key;
    input.checked = config.releaseAlertMode === 'selected'
      ? preferences.has(key)
      : !preferences.has(key);
    input.disabled = pageBusy || !config.enabled || !config.releaseAlertsEnabled;
    const name = document.createElement('span');
    name.textContent = repo.full_name;
    label.append(input, name);
    list.append(label);
  }
}

function renderReleaseTrackingStatus(config, cache = notificationCache) {
  const status = $('releaseTrackingStatus');
  if (!config.releaseAlertsEnabled) {
    status.textContent = t('optionsReleaseTrackingOff');
    return;
  }
  if (optionSettings?.dataSource !== 'api' && cache?.source !== 'api') {
    status.textContent = t('optionsReleaseTrackingWebsite');
    return;
  }
  const tracking = cache?.releaseTracking;
  if (!tracking) {
    status.textContent = t('optionsReleaseTrackingStatus', [0, 0, 0, 0, '', 'unknown', 'never']);
    return;
  }
  const requestSuffix = tracking.requests === 1 ? '' : 's';
  const checkedAt = tracking.fetchedAt
    ? formatters.dateTime({ dateStyle: 'medium', timeStyle: 'short' }).format(new Date(tracking.fetchedAt))
    : 'never';
  status.textContent = t('optionsReleaseTrackingStatus', [
    tracking.attemptedCount,
    tracking.requestedCount,
    tracking.unavailableCount,
    tracking.requests,
    requestSuffix,
    tracking.authorization,
    checkedAt,
  ]);
}

function syncNotificationUI(config, permitted, pending = 0, dropped = 0, cache = notificationCache) {
  notificationState = { config, permitted, pending, dropped };
  $('notificationsEnabled').checked = !!config.enabled;
  $('notificationsEnabled').disabled = pageBusy;
  $('releaseAlertsEnabled').checked = !!config.releaseAlertsEnabled;
  $('releaseAlertsEnabled').disabled = pageBusy || !config.enabled;
  for (const [key, field] of Object.entries(notificationFields)) {
    field.value = String(config[key]);
    field.disabled = pageBusy || !config.enabled;
  }
  notificationFields.releaseAlertMode.disabled =
    pageBusy || !config.enabled || !config.releaseAlertsEnabled;
  renderRepositoryAlertPreferences(config, cache);
  renderReleaseAlertPreferences(config, cache);
  renderReleaseTrackingStatus(config, cache);
  $('notificationControls').setAttribute('aria-disabled', String(!config.enabled));
  $('notificationPermissionState').textContent =
    config.enabled && permitted
      ? t('optionsNotificationsOn', [
          pending,
          pending === 1 ? '' : 's',
          dropped
            ? t('optionsNotificationsDropped', [dropped, dropped === 1 ? '' : 's'])
            : '',
        ])
      : config.enabled
        ? t('optionsNotifPermissionRemoved')
        : permitted
          ? t('optionsNotificationsOffGranted')
          : t('optionsNotifOffNotRequested');
}

async function loadNotificationConfig() {
  const [response, cache] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'notification-status' }),
    getCache().catch(() => null),
  ]);
  if (!response?.ok) throw messageError(response?.error, 'Could not load notifications.');
  syncNotificationUI(response.config, response.permitted, response.pending, response.dropped, cache);
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
  sourceCapabilityNotice = '';
  try {
    const prior = await getSettings();
    if (fields.dataSource.value === 'web' && !(await ensureWebPermission())) {
      fields.dataSource.value = prior.dataSource;
      fields.refreshMinutes.value = String(prior.refreshMinutes);
      syncSourceUI();
      sayT('optionsPermissionStaying', [
        prior.dataSource === 'web' ? t('optionsGitHubWebsite') : t('optionsGitHubApi'),
      ], 'err');
      return;
    }
    syncSourceUI();
    const source = fields.dataSource.value;
    const refreshMinutes = Number(fields.refreshMinutes.value);
    const settings = await patchSettings({ dataSource: source, refreshMinutes });
    fields.token.value = settings.token;
    syncSourceUI();
    if (offline()) {
      sayT('optionsSourceSetOffline', [
        source === 'web' ? 'github.com' : t('optionsGitHubApi'),
      ], 'ok');
      return;
    }
    sayT('optionsSwitchingSource', [source === 'web' ? 'github.com' : t('optionsGitHubApi')]);
    const result = await chrome.runtime.sendMessage({
      type: 'settings-changed',
      refresh: true,
      source,
      reason: 'source-change',
    });
    if (result?.ok) {
      if (result.cache?.sourceDowngrade) {
        fields.dataSource.value = result.cache.sourceDowngrade.effective;
        sourceCapabilityNotice = sourceDowngradeMessage(result.cache.sourceDowngrade);
        syncSourceUI();
        say(sourceCapabilityNotice, 'err');
      } else {
        sayT('optionsNowReadingSource', [source === 'web' ? 'github.com' : t('optionsGitHubApi')], 'ok');
      }
    } else {
      reportError(
        {
          ...(result?.error || {}),
          message: `${result?.error?.message || t('optionsSourceRefreshFailed')} ${t('optionsPriorSnapshotShown')}`,
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
      sayT('optionsUsernameRequired', null, 'err');
      return;
    }
    if (next.dataSource === 'web') {
      if (!next.username) {
        sayT('optionsWebUsernameRequired', null, 'err');
        return;
      }
      if (!(await ensureWebPermission())) {
        sayT('optionsPermissionDenied', null, 'err');
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
      sayT('optionsSavedOffline', null, 'ok');
      await showStorageInfo();
      return;
    }
    sayT('optionsSavedRefreshing');
    const res = await chrome.runtime.sendMessage({
      type: 'refresh',
      force: true,
      source: next.dataSource,
      reason: 'settings-save',
    });
    if (res?.ok) {
      if (res.cache?.sourceDowngrade) {
        fields.dataSource.value = res.cache.sourceDowngrade.effective;
        sourceCapabilityNotice = sourceDowngradeMessage(res.cache.sourceDowngrade);
        syncSourceUI();
        say(sourceCapabilityNotice, 'err');
      } else {
        sayT('optionsSyncedRepos', [res.cache.repos.length, res.cache.profile.login], 'ok');
      }
      await showStorageInfo();
    } else {
      if (res?.error?.credentialCleared) {
        fields.token.value = '';
        fields.tokenMode.value = 'session';
        syncSourceUI();
      }
      await loadAuthStatus();
      await loadRefreshFailures();
      reportError(res?.error, 'account', 'Refresh failed.');
    }
  }).catch((err) => reportError(err, 'account', t('optionsSaveSettingsError')));
});

let connectionController = null;
window.addEventListener('pagehide', () => connectionController?.abort('pagehide'));

$('test').addEventListener('click', async () => {
  if (offline()) {
    say(
      t('optionsOfflineConnectionTest'),
      'err',
    );
    return;
  }
  connectionController?.abort('restarted');
  const controller = new AbortController();
  connectionController = controller;
  const button = $('test');
  button.setAttribute('aria-busy', 'true');
  button.textContent = t('optionsCancelRetest');
  const { username, token, dataSource } = collect();
  sayT('optionsTesting');
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
        t('optionsTestWebsiteOk', [
          res.profile.login,
          res.repos.length,
          stars,
          res.approximate ? t('optionsApproximateCounts') : '',
        ]),
        'ok',
      );
      return;
    }
    const res = await testApiConnection(
      { username, token },
      { signal: controller.signal },
    );
    if (connectionController !== controller) return;
    if (token) {
      await chrome.runtime.sendMessage({ type: 'record-auth-status', status: 'active' });
      await loadAuthStatus();
    }
    say(
      t('optionsTestApiOk', [
        res.profile.login,
        res.rate?.remaining ?? '?',
        res.rate?.limit ?? '?',
      ]),
      'ok',
    );
  } catch (err) {
    if (connectionController !== controller) return;
    if (err.code === 'CANCELLED') sayT('optionsTestCancelled', null, 'err');
    else {
      if (token && err.authStatus) {
        const response = await chrome.runtime.sendMessage({
          type: 'record-auth-status',
          status: err.authStatus,
          code: err.code,
        });
        if (response?.credentialCleared) {
          fields.token.value = '';
          fields.tokenMode.value = 'session';
          syncSourceUI();
        }
        await loadAuthStatus();
      }
      reportError(err, 'account', t('optionsConnectionFailed'));
    }
  } finally {
    if (connectionController === controller) {
      connectionController = null;
      button.removeAttribute('aria-busy');
      button.textContent = t('optionsTestConnection');
    }
  }
});

let clearArmedUntil = 0;
let clearResetTimer;

function resetClearConfirmation() {
  clearArmedUntil = 0;
  $('clear').textContent = t('optionsClear');
  $('clearScope').hidden = true;
}

async function syncUndoControl() {
  const response = await chrome.runtime.sendMessage({ type: 'undo-status' });
  $('undoClear').hidden = !response?.undo?.available;
}

$('clear').addEventListener('click', async () => {
  if (Date.now() > clearArmedUntil) {
    clearArmedUntil = Date.now() + 8000;
    $('clear').textContent = t('optionsConfirmClear');
    $('clearScope').hidden = false;
    sayT('optionsConfirmClearScope', null, 'err', 'clear');
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
    sayT('optionsCleared', null, 'ok', 'clear');
  }).catch((error) => reportError(error, 'clear', t('optionsClearError')));
});

let pruneArmedUntil = 0;
let pruneResetTimer;

function resetPruneConfirmation() {
  pruneArmedUntil = 0;
  $('pruneHistory').textContent = t('optionsPrune');
  $('pruneScope').hidden = true;
}

$('pruneHistory').addEventListener('click', async () => {
  const keepDays = Number($('historyKeep').value);
  if (Date.now() > pruneArmedUntil) {
    pruneArmedUntil = Date.now() + 8000;
    $('pruneHistory').textContent = t('optionsConfirmKeep', [keepDays]);
    $('pruneScope').textContent = t('optionsPruneScope', [keepDays]);
    $('pruneScope').hidden = false;
    sayT('optionsConfirmPrune', null, 'err', 'history');
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
    sayT('optionsPruned', [keepDays], 'ok', 'history');
  }).catch((error) => reportError(error, 'history', t('optionsPruneError')));
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
  await withBusy($('backupJson'), t('optionsPreparing'), async () => {
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
        sayT('optionsBackupTooLarge', [error.message], 'err', 'transfer');
        return;
      }
      throw error;
    }
    downloadText(
      text,
      `StarBoard-backup-${exportDate()}.json`,
      'application/json',
    );
    sayT('optionsBackupDownloaded', null, 'ok', 'transfer');
  }).catch((error) => reportError(error, 'transfer', t('optionsBackupError')));
});

$('exportCsv').addEventListener('click', async () => {
  await withBusy($('exportCsv'), t('optionsPreparing'), async () => {
    const csv = createCsv({
      ...(await readPortableState()),
      ...exportSelection(),
    });
    // The version is in the name as well as in every row: a renamed file still
    // declares its contract, and one that has not been opened can be sorted by
    // it.
    downloadText(
      csv,
      `StarBoard-repositories-v${CSV_FORMAT_VERSION}-${exportDate()}.csv`,
      'text/csv;charset=utf-8',
    );
    sayT('optionsCsvDownloaded', null, 'ok', 'transfer');
  }).catch((error) => reportError(error, 'transfer', t('optionsCsvError')));
});

async function readHistoryReport() {
  const { cache, history } = await readPortableState();
  return createHistoryReport({
    cache,
    history,
    includePrivate: $('includePrivateExport').checked,
    duration: Number($('historyReportDuration').value),
  });
}

$('exportHistoryJson').addEventListener('click', async () => {
  await withBusy($('exportHistoryJson'), t('optionsPreparing'), async () => {
    const report = await readHistoryReport();
    downloadText(
      serializeHistoryReport(report),
      `StarBoard-history-v${HISTORY_REPORT_FORMAT_VERSION}-${report.period.days}d-${exportDate()}.json`,
      'application/json',
    );
    sayT('optionsHistoryReportDownloaded', null, 'ok', 'transfer');
  }).catch((error) => reportError(error, 'transfer', t('optionsHistoryReportError')));
});

$('exportHistorySvg').addEventListener('click', async () => {
  await withBusy($('exportHistorySvg'), t('optionsPreparing'), async () => {
    const report = await readHistoryReport();
    downloadText(
      createSvgTrendBadge(report),
      `StarBoard-badge-${report.period.days}d-${exportDate()}.svg`,
      'image/svg+xml;charset=utf-8',
    );
    sayT('optionsHistoryReportSvgDownloaded', null, 'ok', 'transfer');
  }).catch((error) => reportError(error, 'transfer', t('optionsHistoryReportError')));
});

let pendingImportRecords = null;
let applyImportArmedUntil = 0;
let applyImportResetTimer;

function resetApplyImportConfirmation() {
  applyImportArmedUntil = 0;
  clearTimeout(applyImportResetTimer);
  $('applyImport').textContent = t('optionsApplyRestore');
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
    $('importSummary').textContent = t('optionsBackupSummary', [
      summary.repositories,
      summary.baselineRepositories,
      summary.historyPoints,
      summary.historyDays,
      summary.privateRepositories,
      summary.migratedRecords,
      summary.migratedRecords === 1 ? '' : 's',
      summary.notificationConfig ? t('optionsBackupIncluded') : t('optionsBackupNotIncluded'),
      t('optionsSavedViews', [summary.savedViews, summary.savedViews === 1 ? '' : 's']),
    ]);
    $('importPreview').hidden = false;
    sayT('optionsBackupValidated', null, 'ok', 'transfer');
  } catch (error) {
    resetImportPreview();
    say(error.message || t('optionsBackupValidationError'), 'err', 'transfer');
  }
});

$('applyImport').addEventListener('click', async () => {
  if (!pendingImportRecords) return;
  if (Date.now() > applyImportArmedUntil) {
    applyImportArmedUntil = Date.now() + 8000;
    $('applyImport').textContent = t('optionsConfirmRestore');
    sayT('optionsApplyRestoreWarning', null, 'err', 'transfer');
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
    sayT('optionsBackupRestored', null, 'ok', 'transfer');
  }).catch((error) => reportError(error, 'transfer', t('optionsRestoreError')));
});

let diagnosticsText = '';

$('buildDiagnostics').addEventListener('click', async () => {
  await withBusy($('buildDiagnostics'), t('optionsBuilding'), async () => {
    const response = await chrome.runtime.sendMessage({ type: 'get-diagnostics' });
    if (!response?.ok) {
      throw messageError(response?.error, 'Could not build diagnostics.');
    }
    diagnosticsText = `${JSON.stringify(response.diagnostics, null, 2)}\n`;
    $('diagnosticsOutput').textContent = diagnosticsText;
    $('diagnosticsOutput').hidden = false;
    $('copyDiagnostics').disabled = false;
    sayT('optionsDiagnosticsBuilt', null, 'ok', 'diagnostics');
  }).catch((error) => reportError(error, 'diagnostics', t('optionsDiagnosticsError')));
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
  sayT(copied ? 'optionsDiagnosticsCopied' : 'optionsCopyBlocked', null, copied ? 'ok' : 'err', 'diagnostics');
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
      sayT('optionsNotificationsDenied', null, 'err');
      await loadNotificationConfig();
      return;
    }
    const response = await chrome.runtime.sendMessage({
      type: 'patch-notification-config',
      changes: { enabled: enabling },
    });
    if (!response?.ok) throw messageError(response?.error, 'Could not save notifications.');
    syncNotificationUI(response.config, response.permitted, response.pending, response.dropped);
    sayT(enabling ? 'optionsAlertsEnabled' : 'optionsAlertsDisabled', null, 'ok');
  } catch (error) {
    await loadNotificationConfig().catch(() => {});
      if (error.message) say(error.message, 'err');
      else sayT('optionsNotificationAccessError', null, 'err');
  } finally {
    checkbox.disabled = false;
  }
});

async function refreshReleaseLane() {
  if (optionSettings?.dataSource !== 'api' || !$('releaseAlertsEnabled').checked) return;
  await chrome.runtime.sendMessage({ type: 'refresh', reason: 'release-alerts' }).catch(() => {});
}

async function saveReleaseAlertSettings() {
  const response = await chrome.runtime.sendMessage({
    type: 'patch-notification-config',
    changes: notificationPatch(),
  });
  if (!response?.ok) {
    throw messageError(response?.error, 'Could not save release alert settings.');
  }
  syncNotificationUI(response.config, response.permitted, response.pending, response.dropped);
  await refreshReleaseLane();
}

$('releaseAlertsEnabled').addEventListener('change', async () => {
  const checkbox = $('releaseAlertsEnabled');
  checkbox.disabled = true;
  try {
    await saveReleaseAlertSettings();
    sayT('optionsNotificationSaved', null, 'ok');
  } catch (error) {
    await loadNotificationConfig().catch(() => {});
    if (error.message) say(error.message, 'err');
    else sayT('optionsNotificationSaveError', null, 'err');
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
      if (field === notificationFields.releaseAlertMode) await refreshReleaseLane();
      sayT('optionsNotificationSaved', null, 'ok');
    } catch (error) {
      await loadNotificationConfig().catch(() => {});
      if (error.message) say(error.message, 'err');
      else sayT('optionsNotificationSaveError', null, 'err');
    } finally {
      field.disabled = !$('notificationsEnabled').checked;
    }
  });
}

$("releaseAlertList").addEventListener('change', async (event) => {
  if (!(event.target instanceof HTMLInputElement)) return;
  event.target.disabled = true;
  try {
    await saveReleaseAlertSettings();
    sayT('optionsNotificationSaved', null, 'ok');
  } catch (error) {
    await loadNotificationConfig().catch(() => {});
    if (error.message) say(error.message, 'err');
    else sayT('optionsNotificationSaveError', null, 'err');
  }
});

$("repositoryAlertList").addEventListener('change', async (event) => {
  if (!(event.target instanceof HTMLInputElement)) return;
  event.target.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'patch-notification-config',
      changes: notificationPatch(),
    });
    if (!response?.ok) {
      throw messageError(response?.error, 'Could not save repository alert settings.');
    }
    syncNotificationUI(response.config, response.permitted, response.pending, response.dropped);
    sayT('optionsNotificationSaved', null, 'ok');
  } catch (error) {
    await loadNotificationConfig().catch(() => {});
    if (error.message) say(error.message, 'err');
    else sayT('optionsNotificationSaveError', null, 'err');
  }
});

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
    sayT('optionsLastActionUndone', null, 'ok', 'clear');
  }).catch((error) => {
    $('undoClear').hidden = true;
    say(error.message || t('optionsUndoUnavailable'), 'err', 'clear');
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
        ? t('optionsTokenSession')
        : t('optionsTokenPersistent'),
      settings.tokenMode === 'session' ? 'ok' : '',
    );
  } catch (error) {
    say(error.message || t('optionsTokenStorageError'), 'err');
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
    await loadAuthStatus();
    sayT('optionsTokenRemoved', null, 'ok');
  }).catch((error) => reportError(error, 'account', t('optionsForgetTokenError')));
  syncSourceUI();
});

$('replaceToken').addEventListener('click', () => {
  fields.token.focus();
  fields.token.select();
  sayT('optionsReplacementToken', null, 'ok');
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && (
    changes[AUTH_STATUS_KEY] ||
    Object.keys(changes).some((key) => key.endsWith(`:${AUTH_STATUS_KEY}`))
  )) {
    loadAuthStatus().catch(() => {});
  }
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
  'showReleaseStats',
  'showSourceStatus',
];
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
        await chrome.runtime.sendMessage({
          type: 'settings-changed',
          refresh: key === 'showReleaseStats' && values.showReleaseStats,
          reason: key === 'showReleaseStats' ? 'release-details' : undefined,
        });
        sayT('optionsSettingSaved', [t(`optionsSetting_${key}`)], 'ok');
      })
      .catch((err) => reportError(err, 'account', t('optionsSettingSaveError')))
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
      t('optionsSettingsLoadFailed', [error?.message || t('optionsReloadTryAgain')]),
      'err',
    );
  });

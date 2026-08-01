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
import { fetchAccount } from './lib/github.js';
import { scrapeAccount } from './lib/scrape.js';

const GITHUB_ORIGIN = 'https://github.com/*';
const WEB_MIN_REFRESH_MINUTES = 360;

const $ = (id) => document.getElementById(id);
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

function syncSourceUI() {
  const web = fields.dataSource.value === 'web';
  $('sourceHint').textContent = SOURCE_HINTS[fields.dataSource.value];
  $('tokenField').style.display = web ? 'none' : '';
  const persistent = fields.tokenMode.value === 'persistent';
  $('tokenStorageHint').textContent = persistent
    ? 'Persistent mode keeps the PAT in chrome.storage.local after the browser closes. Choose this only on a trusted profile.'
    : 'Session mode keeps the PAT in chrome.storage.session and clears it when the browser session ends.';
  $('tokenStorageHint').classList.toggle('token-warning', persistent);
  $('forgetToken').disabled = !fields.token.value;
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
const status = $('status');

async function patchSettings(changes) {
  const response = await chrome.runtime.sendMessage({ type: 'patch-settings', changes });
  if (!response?.ok) throw new Error(response?.error?.message || 'Could not save settings.');
  return response.settings;
}

let statusTimer;
function say(message, kind = '') {
  clearTimeout(statusTimer);
  status.textContent = message;
  status.className = `status ${kind}`;
  status.setAttribute('aria-live', kind === 'err' ? 'assertive' : 'polite');
  if (message) statusTimer = setTimeout(() => say(''), 6000);
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
  $('badgePreview').textContent = stars == null ? '—' : stars.toLocaleString();
}

async function load() {
  const s = await getSettings();
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

function syncNotificationUI(config, permitted, pending = 0) {
  $('notificationsEnabled').checked = !!config.enabled;
  for (const [key, field] of Object.entries(notificationFields)) {
    field.value = String(config[key]);
    field.disabled = !config.enabled;
  }
  $('notificationControls').setAttribute('aria-disabled', String(!config.enabled));
  $('notificationPermissionState').textContent =
    config.enabled && permitted
      ? `On · ${pending} queued alert${pending === 1 ? '' : 's'}. Quiet hours and cooldown apply locally.`
      : config.enabled
        ? 'Notification access was removed. Turn alerts off and on to grant it again.'
        : permitted
          ? 'Off · notification access remains granted in Chrome but no alerts are generated.'
          : 'Off · notification access has not been requested.';
}

async function loadNotificationConfig() {
  const response = await chrome.runtime.sendMessage({ type: 'notification-status' });
  if (!response?.ok) throw new Error(response?.error?.message || 'Could not load notifications.');
  syncNotificationUI(response.config, response.permitted, response.pending);
}

/**
 * Website mode reads github.com through an optional permission. Even though it
 * is the default source, Chrome only prompts when the user selects it or saves
 * from a click — both are qualifying user gestures.
 */
async function ensureWebPermission() {
  if (await chrome.permissions.contains({ origins: [GITHUB_ORIGIN] })) return true;
  return chrome.permissions.request({ origins: [GITHUB_ORIGIN] });
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
    say(`Switching to ${source === 'web' ? 'github.com' : 'the GitHub API'}…`);
    const result = await chrome.runtime.sendMessage({
      type: 'settings-changed',
      refresh: true,
      source,
      reason: 'source-change',
    });
    say(
      result?.ok
        ? `Now reading from ${source === 'web' ? 'github.com' : 'the GitHub API'}.`
        : `${result?.error?.message || 'Source refresh failed.'} The prior snapshot is still shown.`,
      result?.ok ? 'ok' : 'err',
    );
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
    fields.username.value = next.username;
    await chrome.runtime.sendMessage({ type: 'settings-changed' });
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
      say(res?.error?.message || 'Refresh failed.', 'err');
    }
  }).catch((err) => say(err.message || 'Could not save settings.', 'err'));
});

$('test').addEventListener('click', async () => {
  await withBusy($('test'), 'Testing…', async () => {
    const { username, token, dataSource } = collect();
    say('Testing…');
    try {
      if (dataSource === 'web') {
        if (!(await ensureWebPermission())) {
          say('Permission for github.com denied.', 'err');
          return;
        }
        const res = await scrapeAccount(username, parseHTML);
        const stars = res.repos.reduce((s, r) => s + r.stargazers_count, 0);
        say(
          `OK — @${res.profile.login}: ${res.repos.length} repos, ${stars} stars, ` +
            `read from ${res.pagesFetched} page${res.pagesFetched === 1 ? '' : 's'}` +
            `${res.approximate ? ' (some counts abbreviated by GitHub)' : ''}.`,
          'ok',
        );
        return;
      }
      const res = await fetchAccount({ username, token });
      const stars = res.repos.reduce((s, r) => s + r.stargazers_count, 0);
      say(
        `OK — @${res.profile.login}: ${res.repos.length} repos, ${stars} stars. ` +
          `${res.rate?.remaining ?? '?'}/${res.rate?.limit ?? '?'} API calls left.`,
        'ok',
      );
    } catch (err) {
      say(err.message, 'err');
    }
  });
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
    say('Confirm the exact data scope below.', 'err');
    clearTimeout(clearResetTimer);
    clearResetTimer = setTimeout(resetClearConfirmation, 8000);
    return;
  }
  clearTimeout(clearResetTimer);
  resetClearConfirmation();
  await withBusy($('clear'), 'Clearing…', async () => {
    const response = await chrome.runtime.sendMessage({ type: 'clear-portfolio' });
    if (!response?.ok) throw new Error(response?.error?.message || 'Could not clear local data.');
    await showStorageInfo();
    $('undoClear').hidden = !response.undo?.available;
    say('Snapshot, baseline and history cleared. Undo is available for 10 minutes.', 'ok');
  }).catch((error) => say(error.message || 'Could not clear local data.', 'err'));
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
    say('Confirm the history range to prune.', 'err');
    clearTimeout(pruneResetTimer);
    pruneResetTimer = setTimeout(resetPruneConfirmation, 8000);
    return;
  }
  clearTimeout(pruneResetTimer);
  resetPruneConfirmation();
  await withBusy($('pruneHistory'), 'Pruning…', async () => {
    const response = await chrome.runtime.sendMessage({ type: 'prune-history', keepDays });
    if (!response?.ok) throw new Error(response?.error?.message || 'Could not prune history.');
    await showStorageInfo();
    $('undoClear').hidden = !response.undo?.available;
    say(`History now keeps at most ${keepDays} days. Undo is available for 10 minutes.`, 'ok');
  }).catch((error) => say(error.message || 'Could not prune history.', 'err'));
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
    say('Checksummed JSON backup downloaded. No personal access token was included.', 'ok');
  }).catch((error) => say(error.message || 'Could not create the backup.', 'err'));
});

$('exportCsv').addEventListener('click', async () => {
  await withBusy($('exportCsv'), 'Preparing…', async () => {
    const csv = createCsv({
      ...(await readPortableState()),
      ...exportSelection(),
    });
    downloadText(csv, `StarBoard-repositories-${exportDate()}.csv`, 'text/csv;charset=utf-8');
    say('Timestamped repository CSV downloaded.', 'ok');
  }).catch((error) => say(error.message || 'Could not create the CSV.', 'err'));
});

let pendingImportRecords = null;

function resetImportPreview() {
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
    say('Backup validated. Review the dry-run summary before applying it.', 'ok');
  } catch (error) {
    resetImportPreview();
    say(error.message || 'Could not validate that backup.', 'err');
  }
});

$('applyImport').addEventListener('click', async () => {
  if (!pendingImportRecords) return;
  await withBusy($('applyImport'), 'Restoring…', async () => {
    const response = await chrome.runtime.sendMessage({
      type: 'import-backup',
      records: pendingImportRecords,
    });
    if (!response?.ok) throw new Error(response?.error?.message || 'Could not restore backup.');
    resetImportPreview();
    await load();
    $('undoClear').hidden = !response.undo?.available;
    say('Backup restored. The prior local state is undoable for 10 minutes.', 'ok');
  }).catch((error) => say(error.message || 'Could not restore backup.', 'err'));
});

let diagnosticsText = '';

$('buildDiagnostics').addEventListener('click', async () => {
  await withBusy($('buildDiagnostics'), 'Building…', async () => {
    const response = await chrome.runtime.sendMessage({ type: 'get-diagnostics' });
    if (!response?.ok) {
      throw new Error(response?.error?.message || 'Could not build diagnostics.');
    }
    diagnosticsText = `${JSON.stringify(response.diagnostics, null, 2)}\n`;
    $('diagnosticsOutput').textContent = diagnosticsText;
    $('diagnosticsOutput').hidden = false;
    $('copyDiagnostics').disabled = false;
    say('Redacted diagnostics built locally.', 'ok');
  }).catch((error) => say(error.message || 'Could not build diagnostics.', 'err'));
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
  say(copied ? 'Diagnostics copied.' : 'Copy was blocked; select the diagnostics text manually.', copied ? 'ok' : 'err');
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
    if (!response?.ok) throw new Error(response?.error?.message || 'Could not save notifications.');
    syncNotificationUI(response.config, response.permitted, response.pending);
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
        throw new Error(response?.error?.message || 'Could not save notification settings.');
      }
      syncNotificationUI(response.config, response.permitted, response.pending);
      say('Notification settings saved.', 'ok');
    } catch (error) {
      await loadNotificationConfig().catch(() => {});
      say(error.message || 'Could not save notification settings.', 'err');
    } finally {
      field.disabled = !$('notificationsEnabled').checked;
    }
  });
}

chrome.permissions.onRemoved.addListener((permissions) => {
  if (permissions.permissions?.includes('notifications')) {
    loadNotificationConfig().catch(() => {});
  }
});

$('undoClear').addEventListener('click', async () => {
  await withBusy($('undoClear'), 'Restoring…', async () => {
    const response = await chrome.runtime.sendMessage({ type: 'undo' });
    if (!response?.ok) throw new Error(response?.error?.message || 'Undo is no longer available.');
    await load();
    $('undoClear').hidden = true;
    say('Last data action undone.', 'ok');
  }).catch((error) => {
    $('undoClear').hidden = true;
    say(error.message || 'Undo is no longer available.', 'err');
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
    if (!response?.ok) throw new Error(response?.error?.message || 'Could not forget the token.');
    fields.token.value = '';
    fields.tokenMode.value = 'session';
    syncSourceUI();
    say('Token removed from session and persistent storage.', 'ok');
  }).catch((error) => say(error.message || 'Could not forget the token.', 'err'));
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
        say('Saved.', 'ok');
      })
      .catch((err) => say(err.message || 'Could not save that setting.', 'err'))
      .finally(() => {
        pendingSettingsSaves -= 1;
        if (pendingSettingsSaves === 0) document.body.dataset.settingsState = 'saved';
      });
  });
}

// A rejection here used to leave the page silently half-initialised: storage
// figures and the badge preview stuck at defaults, and the undo control hidden
// even when an undo was available.
load()
  .then(syncUndoControl)
  .catch((error) => {
    say(`Settings could not be loaded. ${error?.message || 'Reload the page to try again.'}`, 'err');
  });

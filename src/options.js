/** StarBoard — settings page. */

import {
  getSettings,
  getCache,
  getHistory,
  applyTheme,
} from './lib/storage.js';
import { historyStats } from './lib/history.js';
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

const SOURCE_HINTS = {
  web: 'The default. Reads your github.com repositories page using the session you are already signed in with — no token. GitHub abbreviates counts at 1,000+ ("1.2k"), so deltas on repos that large are approximate.',
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
  const bytes = await chrome.storage.local.getBytesInUse(null);
  const [cache, settings, history] = await Promise.all([
    getCache(),
    getSettings(),
    getHistory(),
  ]);
  const repos = cache?.repos?.length || 0;
  const badgeRepos = cache?.repos?.filter((repo) => settings.includeForks || !repo.fork);
  const stars = badgeRepos?.reduce((total, repo) => total + repo.stargazers_count, 0);
  const trends = historyStats(history);
  $('storageInfo').textContent =
    `${repos} repos cached, ${trends.points} daily trend points across ` +
    `${trends.days} day${trends.days === 1 ? '' : 's'}, ${(bytes / 1024).toFixed(1)} KB total.`;
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
  await showStorageInfo();
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
    await patchSettings({ dataSource: source, refreshMinutes });
    if (source === 'web') fields.token.value = '';
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

$('undoClear').addEventListener('click', async () => {
  await withBusy($('undoClear'), 'Restoring…', async () => {
    const response = await chrome.runtime.sendMessage({ type: 'undo' });
    if (!response?.ok) throw new Error(response?.error?.message || 'Undo is no longer available.');
    await showStorageInfo();
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

load().then(syncUndoControl);

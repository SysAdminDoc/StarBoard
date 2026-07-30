/** StarBoard — settings page. */

import {
  getSettings,
  getCache,
  clearPortfolioData,
  applyTheme,
} from './lib/storage.js';
import { fetchAccount } from './lib/github.js';
import { scrapeAccount } from './lib/scrape.js';

const GITHUB_ORIGIN = 'https://github.com/*';
const WEB_MIN_REFRESH_MINUTES = 360;

const $ = (id) => document.getElementById(id);
const fields = {
  username: $('username'),
  token: $('token'),
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
  const [cache, settings] = await Promise.all([getCache(), getSettings()]);
  const repos = cache?.repos?.length || 0;
  const badgeRepos = cache?.repos?.filter((repo) => settings.includeForks || !repo.fork);
  const stars = badgeRepos?.reduce((total, repo) => total + repo.stargazers_count, 0);
  $('storageInfo').textContent = `${repos} repos cached, ${(bytes / 1024).toFixed(1)} KB.`;
  $('badgePreview').textContent = stars == null ? '—' : stars.toLocaleString();
}

async function load() {
  const s = await getSettings();
  fields.username.value = s.username;
  fields.token.value = s.token;
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
    if (fields.dataSource.value === 'web' && !(await ensureWebPermission())) {
      fields.dataSource.value = 'api';
      syncSourceUI();
      say('Permission for github.com denied — staying on API mode.', 'err');
      return;
    }
    syncSourceUI();
    const source = fields.dataSource.value;
    const refreshMinutes = Number(fields.refreshMinutes.value);
    await patchSettings({ dataSource: source, refreshMinutes });
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

$('clear').addEventListener('click', async () => {
  await clearPortfolioData();
  await chrome.runtime.sendMessage({ type: 'update-badge' });
  await showStorageInfo();
  say('Cached repos and baseline cleared. Settings kept.', 'ok');
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

load();

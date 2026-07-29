/** StarBoard — settings page. */

import { getSettings, setSettings, applyTheme } from './lib/storage.js';
import { fetchAccount } from './lib/github.js';
import { scrapeAccount } from './lib/scrape.js';

const GITHUB_ORIGIN = 'https://github.com/*';

const $ = (id) => document.getElementById(id);
const fields = {
  username: $('username'),
  token: $('token'),
  dataSource: $('dataSource'),
  refreshMinutes: $('refreshMinutes'),
  baselineHours: $('baselineHours'),
  badgeMode: $('badgeMode'),
  theme: $('theme'),
};

const SOURCE_HINTS = {
  api: 'Reads api.github.com. Exact counts, 3-4 requests per refresh. Without a token GitHub allows 60 requests/hour and shows public repos only.',
  web: 'Reads your github.com repositories page using the session you are already signed in with — no token. Costs one page load per 30 repos (~12x more data than the API), and GitHub abbreviates counts at 1,000+ ("1.2k"), so deltas on repos that large are approximate.',
};

function syncSourceUI() {
  const web = fields.dataSource.value === 'web';
  $('sourceHint').textContent = SOURCE_HINTS[fields.dataSource.value];
  $('tokenField').style.display = web ? 'none' : '';
}

const parser = new DOMParser();
const parseHTML = (html) => parser.parseFromString(html, 'text/html');
const status = $('status');

let statusTimer;
function say(message, kind = '') {
  clearTimeout(statusTimer);
  status.textContent = message;
  status.className = `status ${kind}`;
  if (message) statusTimer = setTimeout(() => say(''), 6000);
}

async function showStorageInfo() {
  const bytes = await chrome.storage.local.getBytesInUse(null);
  const { cache } = await chrome.storage.local.get('cache');
  const repos = cache?.repos?.length || 0;
  $('storageInfo').textContent = `${repos} repos cached, ${(bytes / 1024).toFixed(1)} KB.`;
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
  };
}

/**
 * Web mode reads github.com, which is an optional permission so a default
 * install never asks for it. Must run from a user gesture — the select's
 * change event qualifies.
 */
async function ensureWebPermission() {
  if (await chrome.permissions.contains({ origins: [GITHUB_ORIGIN] })) return true;
  return chrome.permissions.request({ origins: [GITHUB_ORIGIN] });
}

fields.dataSource.addEventListener('change', async () => {
  if (fields.dataSource.value === 'web' && !(await ensureWebPermission())) {
    fields.dataSource.value = 'api';
    syncSourceUI();
    say('Permission for github.com denied — staying on API mode.', 'err');
    return;
  }
  syncSourceUI();
  await setSettings({ dataSource: fields.dataSource.value });
  await chrome.runtime.sendMessage({ type: 'settings-changed' });
  say(`Reading from ${fields.dataSource.value === 'web' ? 'github.com' : 'the GitHub API'}.`, 'ok');
});

$('save').addEventListener('click', async () => {
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
  await setSettings(next);
  fields.username.value = next.username;
  await chrome.runtime.sendMessage({ type: 'settings-changed' });
  say('Saved — refreshing…');
  const res = await chrome.runtime.sendMessage({ type: 'refresh' });
  if (res?.ok) {
    say(`Synced ${res.cache.repos.length} repos for @${res.cache.profile.login}.`, 'ok');
    await showStorageInfo();
  } else {
    say(res?.error?.message || 'Refresh failed.', 'err');
  }
});

$('test').addEventListener('click', async () => {
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

$('clear').addEventListener('click', async () => {
  await chrome.storage.local.remove(['cache', 'baseline']);
  await chrome.runtime.sendMessage({ type: 'update-badge' });
  await showStorageInfo();
  say('Cached repos and baseline cleared. Settings kept.', 'ok');
});

for (const key of ['refreshMinutes', 'baselineHours', 'badgeMode', 'theme']) {
  fields[key].addEventListener('change', async () => {
    const value = collect()[key];
    await setSettings({ [key]: value });
    if (key === 'theme') applyTheme(value);
    await chrome.runtime.sendMessage({ type: 'settings-changed' });
    say('Saved.', 'ok');
  });
}

load();

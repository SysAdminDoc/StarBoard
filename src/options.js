/** StarBoard — settings page. */

import { getSettings, setSettings, applyTheme } from './lib/storage.js';
import { fetchAccount } from './lib/github.js';

const $ = (id) => document.getElementById(id);
const fields = {
  username: $('username'),
  token: $('token'),
  refreshMinutes: $('refreshMinutes'),
  baselineHours: $('baselineHours'),
  badgeMode: $('badgeMode'),
  theme: $('theme'),
};
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
  };
}

$('save').addEventListener('click', async () => {
  const next = collect();
  if (!next.username && !next.token) {
    say('Enter a username (or a token) first.', 'err');
    return;
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
  const { username, token } = collect();
  say('Testing…');
  try {
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

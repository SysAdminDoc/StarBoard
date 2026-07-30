/**
 * StarBoard — persisted state.
 *
 * Three distinct things live in chrome.storage.local:
 *   settings  — user config (username, token, refresh cadence, filters)
 *   cache     — the last successful fetch (repo list + profile + fetch metadata)
 *   baseline  — a frozen snapshot of star/fork counts that deltas are measured against
 *
 * The baseline is deliberately NOT overwritten on every refresh. If it were,
 * every delta would read +0 forever. It rolls forward only when it is older
 * than `baselineHours`, or when the user explicitly resets it.
 */

export const DEFAULTS = {
  username: '',
  token: '',
  dataSource: 'web', // 'web' = github.com, no token | 'api' = api.github.com
  refreshMinutes: 60,
  baselineHours: 24,
  includeForks: false,
  includeArchived: true,
  sortKey: 'stars',
  badgeMode: 'stars', // 'stars' | 'delta' | 'off'
  theme: 'dark', // 'dark' | 'light' | 'auto'
  showFollowers: true,
  showDescriptions: true,
  showMetadata: true,
  showForkStats: true,
  showSourceStatus: true,
};

/** Apply a theme to the current document. Pages default to dark markup-side. */
export function applyTheme(theme) {
  // Theme is loaded asynchronously from extension storage. Disable transitions
  // across that first paint so light mode does not briefly animate out of the
  // dark markup default.
  document.documentElement.classList.add('theme-switching');
  document.documentElement.dataset.theme = theme || DEFAULTS.theme;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => document.documentElement.classList.remove('theme-switching'));
  });
}

const AREA = chrome.storage.local;

export async function getSettings() {
  const { settings } = await AREA.get('settings');
  if (!settings) return { ...DEFAULTS };

  // Profiles saved before data-source selection existed used the API. Keep
  // that established behavior on upgrade while new installs start on the
  // website source.
  const dataSource = Object.hasOwn(settings, 'dataSource') ? settings.dataSource : 'api';
  return { ...DEFAULTS, ...settings, dataSource };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await AREA.set({ settings: next });
  return next;
}

export async function getCache() {
  const { cache } = await AREA.get('cache');
  return cache || null;
}

export async function setCache(cache) {
  await AREA.set({ cache });
}

export async function getBaseline() {
  const { baseline } = await AREA.get('baseline');
  return baseline || null;
}

export async function setBaseline(baseline) {
  await AREA.set({ baseline });
}

/** Reduce a repo list to the minimum needed to diff against later. */
export function snapshotOf(repos) {
  const counts = {};
  for (const r of repos) {
    counts[r.full_name] = [r.stargazers_count, r.forks_count];
  }
  return { at: Date.now(), counts };
}

/**
 * Return the baseline to diff against, rolling it forward if it has aged out.
 * A missing baseline is seeded from the current list, which yields zero deltas
 * on first run — correct, since there is nothing to compare against yet.
 * `baselineHours` of 0 means "never roll automatically".
 */
export async function resolveBaseline(repos, baselineHours) {
  const existing = await getBaseline();
  const aged =
    existing && baselineHours > 0 && Date.now() - existing.at > baselineHours * 3600_000;
  if (!existing || aged) {
    const fresh = snapshotOf(repos);
    await setBaseline(fresh);
    return fresh;
  }
  return existing;
}

/** Force the baseline to "now" — the user's "start counting from here" action. */
export async function resetBaseline(repos) {
  const fresh = snapshotOf(repos);
  await setBaseline(fresh);
  return fresh;
}

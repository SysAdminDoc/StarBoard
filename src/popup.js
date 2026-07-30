/**
 * StarBoard — popup UI.
 *
 * Renders whatever is in the cache immediately (so the popup never opens
 * blank), then asks the service worker for a refresh in the background.
 */

import {
  getSettings,
  getCache,
  getBaseline,
  getHistory,
  STORAGE_KEYS,
  applyTheme,
} from './lib/storage.js';
import { historyPointsForRepos, repositoryHistoryKey } from './lib/history.js';

const LANG_COLORS = {
  JavaScript: '#f1e05a',
  TypeScript: '#3178c6',
  Python: '#3572A5',
  'C#': '#178600',
  'C++': '#f34b7d',
  C: '#555555',
  Kotlin: '#A97BFF',
  Java: '#b07219',
  PowerShell: '#012456',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#563d7c',
  SCSS: '#c6538c',
  Rust: '#dea584',
  Go: '#00ADD8',
  Ruby: '#701516',
  PHP: '#4F5D95',
  Swift: '#F05138',
  Dart: '#00B4AB',
  Lua: '#000080',
  Vue: '#41b883',
  Svelte: '#ff3e00',
  Batchfile: '#C1F12E',
  Dockerfile: '#384d54',
  Makefile: '#427819',
  Nix: '#7e7eff',
  Zig: '#ec915c',
};

const $ = (id) => document.getElementById(id);

const el = {
  avatar: $('avatar'),
  login: $('login'),
  subline: $('subline'),
  refresh: $('refresh'),
  settings: $('settings'),
  totals: $('totals'),
  totalStars: $('total-stars'),
  totalStarsLabel: $('total-stars-label'),
  totalStarsDelta: $('total-stars-delta'),
  totalForks: $('total-forks'),
  totalForksDelta: $('total-forks-delta'),
  totalForksWrap: $('total-forks-wrap'),
  totalRepos: $('total-repos'),
  totalReposLabel: $('total-repos-label'),
  confidence: $('confidence'),
  rebase: $('rebase'),
  since: $('since'),
  search: $('search'),
  sort: $('sort'),
  incForks: $('incForks'),
  incArchived: $('incArchived'),
  trendRange: $('trendRange'),
  count: $('count'),
  banner: $('banner'),
  lifecycle: $('lifecycle'),
  lifecycleList: $('lifecycle-list'),
  acknowledgeLifecycle: $('ack-lifecycle'),
  list: $('list'),
  footer: $('footer'),
  undo: $('undo'),
  updated: $('updated'),
  rate: $('rate'),
  liveStatus: $('live-status'),
};

let state = {
  settings: null,
  cache: null,
  baseline: null,
  history: null,
  trendRange: 'baseline',
  query: '',
};
let refreshing = false;

function hasSetup() {
  return !!(state.settings?.username || state.settings?.token);
}

function syncControls() {
  const hasRows = !!state.cache?.repos;
  el.refresh.disabled = !hasSetup() || refreshing;
  el.rebase.disabled = !hasRows || refreshing;
  el.search.disabled = !hasRows;
  el.sort.disabled = !hasRows;
  el.incForks.disabled = !hasRows;
  el.incArchived.disabled = !hasRows;
  el.trendRange.disabled = !hasRows;
  el.list.setAttribute(
    'aria-busy',
    String(refreshing || (hasSetup() && !state.cache?.repos && !state.cache?.error)),
  );
}

function announce(message) {
  el.liveStatus.textContent = '';
  requestAnimationFrame(() => {
    el.liveStatus.textContent = message;
  });
}

async function updateUndoAvailability() {
  const response = await chrome.runtime.sendMessage({ type: 'undo-status' });
  el.undo.hidden = !response?.undo?.available;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[STORAGE_KEYS.undo]) return;
  const envelope = changes[STORAGE_KEYS.undo].newValue;
  el.undo.hidden = !(envelope?.data?.expiresAt > Date.now());
});

/* ---------- formatting ---------- */

const nf = new Intl.NumberFormat();
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const UNITS = [
  ['year', 31536000000],
  ['month', 2592000000],
  ['week', 604800000],
  ['day', 86400000],
  ['hour', 3600000],
  ['minute', 60000],
];

function relative(ts) {
  if (!ts) return '—';
  const diff = Date.now() - new Date(ts).getTime();
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return rtf.format(-Math.round(diff / ms), unit);
  }
  return 'just now';
}

function svg(path) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 16 16');
  node.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  node.appendChild(p);
  return node;
}

const STAR_PATH =
  'M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z';
const FORK_PATH =
  'M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z';

function deltaNode(value, cls = 'delta', missing = false) {
  const span = document.createElement('span');
  span.className = cls;
  if (missing) {
    span.classList.add('missing');
    span.textContent = '—';
    span.title = 'No retained point exists for this range';
  } else if (value > 0) {
    span.classList.add('up');
    span.textContent = `+${nf.format(value)}`;
  } else if (value < 0) {
    span.classList.add('down');
    span.textContent = `−${nf.format(Math.abs(value))}`;
  }
  return span;
}

/* ---------- data shaping ---------- */

function withDeltas(cache) {
  const base = state.baseline?.counts || {};
  const trendDays =
    state.trendRange === 'baseline' ? null : Number.parseInt(state.trendRange, 10);
  const historyPoints = trendDays
    ? historyPointsForRepos(state.history, cache?.repos || [], trendDays, {
        now: cache?.fetchedAt || Date.now(),
      }) || new Map()
    : null;
  return (cache?.repos || []).map((r) => {
    const historyPoint = historyPoints?.get(repositoryHistoryKey(r));
    const prev = historyPoint
      ? [historyPoint.stars, historyPoint.forks]
      : trendDays
        ? null
        : base[r.full_name];
    return {
      ...r,
      starsDelta: prev ? r.stargazers_count - prev[0] : 0,
      forksDelta: prev ? r.forks_count - prev[1] : 0,
      isNew: !trendDays && !prev,
      comparisonMissing: !!trendDays && !prev,
      comparisonAt: historyPoint?.at || state.baseline?.at || null,
    };
  });
}

const SORTERS = {
  stars: (a, b) => b.stargazers_count - a.stargazers_count || a.name.localeCompare(b.name),
  forks: (a, b) => b.forks_count - a.forks_count || b.stargazers_count - a.stargazers_count,
  starsDelta: (a, b) => b.starsDelta - a.starsDelta || b.stargazers_count - a.stargazers_count,
  forksDelta: (a, b) => b.forksDelta - a.forksDelta || b.forks_count - a.forks_count,
  updated: (a, b) => new Date(b.pushed_at || 0) - new Date(a.pushed_at || 0),
  name: (a, b) => a.name.localeCompare(b.name),
};

function visibleRepos() {
  const { settings, query } = state;
  const q = query.trim().toLowerCase();
  const rows = withDeltas(state.cache).filter((r) => {
    if (!settings.includeForks && r.fork) return false;
    if (!settings.includeArchived && r.archived) return false;
    if (!q) return true;
    return (
      r.name.toLowerCase().includes(q) ||
      r.description.toLowerCase().includes(q) ||
      (r.language || '').toLowerCase().includes(q)
    );
  });
  return rows.sort(SORTERS[settings.sortKey] || SORTERS.stars);
}

/* ---------- rendering ---------- */

function statNode(kind, value, delta, approx = false, comparisonMissing = false) {
  const wrap = document.createElement('span');
  wrap.className = `stat ${kind}`;
  wrap.appendChild(svg(kind === 'stars' ? STAR_PATH : FORK_PATH));
  const b = document.createElement('b');
  // GitHub's own pages abbreviate past 1,000, so web mode can only report a
  // rounded figure there. Say so rather than implying false precision.
  b.textContent = approx ? `~${nf.format(value)}` : nf.format(value);
  if (approx) b.title = 'Approximate — github.com abbreviates counts above 1,000';
  wrap.appendChild(b);
  wrap.appendChild(deltaNode(delta, 'delta', comparisonMissing));
  return wrap;
}

function rowNode(repo, rank) {
  const a = document.createElement('a');
  a.className = 'row';
  a.href = repo.html_url;
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.title = repo.description || repo.full_name;

  const rankEl = document.createElement('div');
  rankEl.className = 'rank';
  rankEl.textContent = rank;
  a.appendChild(rankEl);

  const main = document.createElement('div');
  main.className = 'main';

  const name = document.createElement('div');
  name.className = 'name';
  const nameText = document.createElement('span');
  nameText.className = 'name-text';
  nameText.textContent = repo.name;
  name.appendChild(nameText);
  const lifecycle = (state.cache?.lifecycleEvents || []).find(
    (event) =>
      (event.type === 'added' || event.type === 'renamed') &&
      event.to === repo.full_name,
  );
  if (lifecycle) {
    const change = document.createElement('span');
    change.className = `lifecycle-tag ${lifecycle.type}`;
    change.textContent = lifecycle.type === 'renamed' ? 'renamed' : 'new';
    name.appendChild(change);
  }
  main.appendChild(name);

  if (state.settings.showDescriptions && repo.description) {
    const desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = repo.description;
    main.appendChild(desc);
  }

  if (state.settings.showMetadata) {
    const meta = document.createElement('div');
    meta.className = 'meta';

    if (repo.language) {
      const lang = document.createElement('span');
      lang.className = 'lang';
      const dot = document.createElement('span');
      dot.className = 'dot';
      if (LANG_COLORS[repo.language]) dot.style.background = LANG_COLORS[repo.language];
      lang.append(dot, document.createTextNode(repo.language));
      meta.appendChild(lang);
    }

    const pushed = document.createElement('span');
    pushed.textContent = relative(repo.pushed_at);
    meta.appendChild(pushed);

    for (const [flag, label] of [
      [repo.private, 'private'],
      [repo.fork, 'fork'],
      [repo.archived, 'archived'],
    ]) {
      if (!flag) continue;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = label;
      meta.appendChild(tag);
    }

    main.appendChild(meta);
  }

  a.appendChild(main);

  const stats = document.createElement('div');
  stats.className = 'stats';
  stats.appendChild(
    statNode(
      'stars',
      repo.stargazers_count,
      repo.starsDelta,
      repo.approx,
      repo.comparisonMissing,
    ),
  );
  if (state.settings.showForkStats) {
    stats.appendChild(
      statNode(
        'forks',
        repo.forks_count,
        repo.forksDelta,
        repo.approx,
        repo.comparisonMissing,
      ),
    );
  }
  a.appendChild(stats);

  return a;
}

function renderSkeleton() {
  el.list.replaceChildren();
  for (let i = 0; i < 7; i++) {
    const s = document.createElement('div');
    s.className = 'skeleton';
    const a = document.createElement('div');
    a.className = 'sk-bar';
    a.style.width = `${45 + Math.round(Math.sin(i) * 15 + 15)}%`;
    const b = document.createElement('div');
    b.className = 'sk-bar';
    b.style.width = '78%';
    s.append(a, b);
    el.list.appendChild(s);
  }
}

function renderEmpty(title, message, action) {
  el.list.replaceChildren();
  const box = document.createElement('div');
  box.className = 'empty';
  const h = document.createElement('h3');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = message;
  box.append(h, p);
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'primary-btn';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    box.appendChild(btn);
  }
  el.list.appendChild(box);
}

function renderTotals(rows) {
  const stars = rows.reduce((s, r) => s + r.stargazers_count, 0);
  const forks = rows.reduce((s, r) => s + r.forks_count, 0);
  const dStars = rows.reduce((s, r) => s + r.starsDelta, 0);
  const dForks = rows.reduce((s, r) => s + r.forksDelta, 0);
  const comparable = rows.filter((repo) => !repo.comparisonMissing).length;
  const trendSelected = state.trendRange !== 'baseline';

  const approximate = rows.some((repo) => repo.approx);
  el.totalStars.textContent = `${approximate ? '~' : ''}${nf.format(stars)}`;
  el.totalForks.textContent = `${approximate ? '~' : ''}${nf.format(forks)}`;
  el.totalRepos.textContent = nf.format(rows.length);
  el.totalStarsDelta.replaceWith(
    withId(deltaNode(dStars, 'delta', trendSelected && comparable === 0), 'total-stars-delta'),
  );
  el.totalForksDelta.replaceWith(
    withId(deltaNode(dForks, 'delta', trendSelected && comparable === 0), 'total-forks-delta'),
  );
  el.totalStarsDelta = $('total-stars-delta');
  el.totalForksDelta = $('total-forks-delta');
  el.totalForksWrap.hidden = !state.settings.showForkStats;
  el.totals.classList.toggle('fork-stats-hidden', !state.settings.showForkStats);
  const unfilteredCount = withDeltas(state.cache).length;
  const filtered = !!state.query.trim() || rows.length !== unfilteredCount;
  el.totalStarsLabel.textContent = filtered ? 'Visible stars' : 'Total stars';
  el.totalReposLabel.textContent = filtered ? 'Visible repos' : 'Repos';
  el.totalStars.title = approximate
    ? 'Approximate total — one or more website counts are abbreviated'
    : '';
  const trendDays = trendSelected ? Number.parseInt(state.trendRange, 10) : null;
  el.trendRange.title = trendSelected
    ? `${comparable} of ${rows.length} visible repositories have a retained ${trendDays}-day comparison point`
    : 'Compare against the resettable baseline';

  const confidence = state.cache?.confidence || 'exact';
  const confidenceLabel = {
    exact: 'Exact snapshot',
    approximate: 'Approximate counts',
    partial: 'Partial snapshot',
    stale: 'Last-known-good',
  }[confidence] || 'Snapshot';
  el.confidence.textContent = confidenceLabel;
  el.confidence.className = `confidence-badge ${confidence}`;

  const at = state.baseline?.at;
  el.since.textContent = at ? `Δ since ${relative(at)}` : 'Δ since —';
  el.rebase.title = at
    ? `Baseline set ${relative(at)}. Click to reset it to now.`
    : 'Click to set the comparison baseline to now.';
  el.totals.hidden = false;
}

function renderLifecycle() {
  const events = state.cache?.lifecycleEvents || [];
  if (!events.length) {
    el.lifecycle.hidden = true;
    el.lifecycleList.replaceChildren();
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const event of events.slice(0, 6)) {
    const item = document.createElement('li');
    const label =
      event.type === 'renamed'
        ? `${event.from} renamed to ${event.to}`
        : event.type === 'added'
          ? `${event.to} added`
          : `${event.to} removed`;
    item.textContent = `${label} · ${relative(event.at)}`;
    fragment.appendChild(item);
  }
  if (events.length > 6) {
    const more = document.createElement('li');
    more.textContent = `+${events.length - 6} more changes`;
    fragment.appendChild(more);
  }
  el.lifecycleList.replaceChildren(fragment);
  el.lifecycle.hidden = false;
}

function withId(node, id) {
  node.id = id;
  return node;
}

function renderBanner() {
  const err = state.cache?.error;
  if (err) {
    el.banner.hidden = false;
    const retained =
      state.cache?.pendingSource
        ? ` Showing the last successful ${state.cache.source === 'web' ? 'website' : 'API'} snapshot.`
        : ' Showing the last successful snapshot.';
    el.banner.textContent =
      err.rateLimited && err.resetAt
        ? `${err.message} Retry ${relative(err.resetAt)}.${retained}`
        : `${err.message}.${retained}`.replace('..', '.');
    return;
  }
  if (state.cache?.complete === false) {
    const reason = {
      cap: `the ${state.cache.cap?.maxRepositories || 1500}-repository safety cap was reached`,
      'parser-drift': 'a later GitHub page could not be parsed',
      'rate-limited': 'GitHub asked StarBoard to slow down',
      timeout: 'a later GitHub page timed out',
      network: 'a later GitHub page could not be loaded',
    }[state.cache.partialReason] || 'the refresh could not finish';
    el.banner.hidden = false;
    el.banner.textContent = `Partial snapshot: ${reason}. Loaded data remains usable and is labeled partial.`;
    return;
  }
  el.banner.hidden = true;
}

function render() {
  const { settings, cache } = state;
  const healthy = !!cache?.fetchedAt && !cache.error;
  el.footer.classList.toggle('is-healthy', healthy);
  syncControls();

  if (cache?.profile) {
    el.avatar.src = cache.profile.avatar_url;
    el.login.textContent = cache.profile.login;
    el.login.href = cache.profile.html_url;
    const synced = `${nf.format(cache.repos.length)} repos synced`;
    el.subline.textContent = settings.showFollowers
      ? `${nf.format(cache.profile.followers)} followers · ${synced}`
      : synced;
  } else {
    el.login.textContent = settings.username ? `@${settings.username}` : 'No account';
    el.login.href = settings.username ? `https://github.com/${settings.username}` : '#';
    el.subline.textContent = settings.username ? 'Waiting to sync' : 'Open settings to connect';
  }

  renderBanner();
  renderLifecycle();

  if (!settings.username && !settings.token) {
    el.totals.hidden = true;
    renderEmpty('Set up StarBoard', 'Add your GitHub username to see your repo standings.', {
      label: 'Open settings',
      onClick: () => chrome.runtime.openOptionsPage(),
    });
    return;
  }

  if (!cache?.repos) {
    el.totals.hidden = true;
    renderSkeleton();
    return;
  }

  const rows = visibleRepos();
  renderTotals(rows);

  const allCount = withDeltas(cache).length;
  el.count.textContent =
    rows.length === allCount
      ? `${nf.format(rows.length)} shown`
      : `${nf.format(rows.length)} of ${nf.format(allCount)} shown`;
  el.updated.textContent = `${cache.stale ? 'Last successful update' : 'Updated'} ${relative(cache.fetchedAt)}`;
  el.rate.hidden = !settings.showSourceStatus;
  if (cache.source === 'web') {
    const n = cache.pagesFetched || 0;
    const confidence =
      cache.confidence === 'partial'
        ? ` · partial (${cache.partialReason || 'incomplete'})`
        : cache.confidence === 'approximate'
          ? ' · some counts approximate'
          : cache.confidence === 'stale'
            ? ' · stale'
            : '';
    el.rate.textContent = `via github.com · ${n} page${n === 1 ? '' : 's'}${confidence}`;
    el.rate.title = 'Read from your github.com repositories tab — no API token in use';
  } else {
    el.rate.textContent = cache.rate?.remaining != null
      ? `${cache.rate.remaining}/${cache.rate.limit} API calls left`
      : '';
    el.rate.title = 'GitHub API requests remaining this hour';
  }

  if (!rows.length) {
    renderEmpty('Nothing matches', 'Try clearing the filter or enabling forks and archived repos.');
    return;
  }

  const frag = document.createDocumentFragment();
  rows.forEach((repo, i) => frag.appendChild(rowNode(repo, i + 1)));
  el.list.replaceChildren(frag);
  el.list.scrollTop = 0;
}

/* ---------- actions ---------- */

async function doRefresh(rebase = false) {
  if (refreshing) return;
  refreshing = true;
  el.refresh.classList.add('spinning');
  el.refresh.setAttribute('aria-label', 'Refreshing repositories');
  syncControls();
  try {
    const res = await chrome.runtime.sendMessage({ type: 'refresh', rebase });
    state.cache = res?.cache ?? (await getCache());
    state.baseline = res?.baseline ?? (await getBaseline());
    state.history = res?.history ?? (await getHistory());
    if (res && !res.ok && !state.cache) {
      state.cache = { error: res.error };
    }
    render();
    if (res?.ok) {
      announce(
        rebase
          ? `Comparison baseline reset for ${res.cache.repos.length} repositories.`
          : `Refresh complete. ${res.cache.repos.length} repositories loaded.`,
      );
      if (rebase) await updateUndoAvailability();
    } else {
      announce(`Refresh failed. ${res?.error?.message || 'The cached snapshot is still shown.'}`);
    }
  } catch (error) {
    state.cache = (await getCache()) || {
      error: { message: error.message || 'The background refresh did not respond.' },
    };
    render();
    announce(`Refresh failed. ${error.message || 'The background refresh did not respond.'}`);
  } finally {
    refreshing = false;
    el.refresh.classList.remove('spinning');
    el.refresh.setAttribute('aria-label', 'Refresh now');
    syncControls();
  }
}

async function patch(changes) {
  const response = await chrome.runtime.sendMessage({ type: 'patch-settings', changes });
  if (!response?.ok) throw new Error(response?.error?.message || 'Could not save settings.');
  state.settings = response.settings;
  chrome.runtime.sendMessage({ type: 'update-badge' }).catch(() => {});
  render();
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

el.refresh.addEventListener('click', () => doRefresh(false));
el.settings.addEventListener('click', () => chrome.runtime.openOptionsPage());
let rebaseArmedUntil = 0;
let rebaseResetTimer;

function resetRebaseConfirmation() {
  rebaseArmedUntil = 0;
  el.rebase.classList.remove('confirming');
  const at = state.baseline?.at;
  el.since.textContent = at ? `Δ since ${relative(at)}` : 'Δ since —';
}

el.rebase.addEventListener('click', () => {
  if (Date.now() > rebaseArmedUntil) {
    rebaseArmedUntil = Date.now() + 8000;
    el.rebase.classList.add('confirming');
    el.since.textContent = 'Confirm reset baseline';
    announce('Resetting the baseline changes every displayed delta. Activate again to confirm.');
    clearTimeout(rebaseResetTimer);
    rebaseResetTimer = setTimeout(resetRebaseConfirmation, 8000);
    return;
  }
  clearTimeout(rebaseResetTimer);
  resetRebaseConfirmation();
  doRefresh(true);
});
el.search.addEventListener(
  'input',
  debounce(() => {
    state.query = el.search.value;
    render();
  }, 120),
);
el.sort.addEventListener('change', () => patch({ sortKey: el.sort.value }));
el.incForks.addEventListener('change', () => patch({ includeForks: el.incForks.checked }));
el.incArchived.addEventListener('change', () => patch({ includeArchived: el.incArchived.checked }));
el.trendRange.addEventListener('change', () => {
  state.trendRange = el.trendRange.value;
  render();
  const label =
    state.trendRange === 'baseline' ? 'the comparison baseline' : `${state.trendRange} days`;
  announce(`Repository changes now compare against ${label}.`);
});
el.acknowledgeLifecycle.addEventListener('click', async () => {
  const ids = (state.cache?.lifecycleEvents || []).map((event) => event.id);
  const response = await chrome.runtime.sendMessage({
    type: 'acknowledge-lifecycle',
    ids,
  });
  if (response?.ok) {
    state.cache = response.cache;
    render();
    announce('Repository changes acknowledged.');
  }
});
el.undo.addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'undo' });
  if (!response?.ok) {
    el.undo.hidden = true;
    announce(response?.error?.message || 'Undo is no longer available.');
    return;
  }
  state.cache = response.restored.cache;
  state.baseline = response.restored.baseline;
  state.history = response.restored.history || state.history;
  render();
  el.undo.hidden = true;
  announce('Last data action undone.');
});

/* ---------- boot ---------- */

(async function init() {
  [state.settings, state.cache, state.baseline, state.history] = await Promise.all([
    getSettings(),
    getCache(),
    getBaseline(),
    getHistory(),
  ]);

  applyTheme(state.settings.theme);
  el.sort.value = state.settings.sortKey;
  el.incForks.checked = state.settings.includeForks;
  el.incArchived.checked = state.settings.includeArchived;
  el.trendRange.value = state.trendRange;

  render();
  await updateUndoAvailability();
  if (!el.search.disabled) el.search.focus();

  // Website reads are intentionally conservative: opening the popup never
  // turns the six-hour automatic floor into an implicit one-minute poll.
  const age = state.cache?.fetchedAt ? Date.now() - state.cache.fetchedAt : Infinity;
  const interval =
    state.settings.dataSource === 'web'
      ? Math.max(360, state.settings.refreshMinutes || 360) * 60_000
      : 60_000;
  const retryAllowed = !state.cache?.error?.retryAt || state.cache.error.retryAt <= Date.now();
  const stale =
    !state.cache?.fetchedAt ||
    (state.settings.refreshMinutes > 0 && age > interval && retryAllowed);
  if (hasSetup() && stale) doRefresh(false);
})();

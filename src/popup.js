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
  getNotificationState,
  getPortfolioViewState,
  setActivePortfolioFilters,
  saveCurrentPortfolioView,
  renameSavedPortfolioView,
  deleteSavedPortfolioView,
  activateSavedPortfolioView,
  createUndoSnapshot,
  dismissStorageRecoveryNotice,
  getStorageRecoveryNotice,
  STORAGE_KEYS,
  applyTheme,
} from './lib/storage.js';
import {
  dismissPrivacyNotice,
  getPrivacyNotice,
} from './lib/install.js';
import { formatters, localizeDocument, message } from './lib/i18n.js';
import {
  SPARKLINE_MIN_POINTS,
  compareHistoryDeltas,
  historyPointsForRepos,
  historyDeltaForRepo,
  historyRepoIndex,
  historyRetainedDays,
  historySeriesForRepo,
  repositoryHistoryKey,
  sparklineSegments,
} from './lib/history.js';
import {
  DEFAULT_PORTFOLIO_FILTERS,
  NO_LANGUAGE,
  activeAdvancedFilterCount,
  filterRepositories,
} from './lib/portfolio-views.js';

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

/**
 * One element registry holds inputs, selects, buttons and spans, so a single
 * narrow return type would be wrong for every caller. The type checker is here
 * for logic defects, not to re-derive which tag each id refers to.
 * @param {string} id
 * @returns {any}
 */
const $ = (id) => document.getElementById(id);
localizeDocument();

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
  viewSelect: $('viewSelect'),
  saveView: $('saveView'),
  renameView: $('renameView'),
  deleteView: $('deleteView'),
  viewEditor: $('viewEditor'),
  viewName: $('viewName'),
  confirmView: $('confirmView'),
  cancelView: $('cancelView'),
  toggleFilters: $('toggleFilters'),
  filterCount: $('filterCount'),
  filterPanel: $('filterPanel'),
  filterLanguage: $('filterLanguage'),
  filterVisibility: $('filterVisibility'),
  filterForks: $('filterForks'),
  filterArchived: $('filterArchived'),
  filterPrecision: $('filterPrecision'),
  filterLifecycle: $('filterLifecycle'),
  filterActivity: $('filterActivity'),
  resetFilters: $('resetFilters'),
  trendRange: $('trendRange'),
  trendCustomField: $('trendCustomField'),
  trendCustomDays: $('trendCustomDays'),
  trendCustomHint: $('trendCustomHint'),
  toggleTrendTable: $('toggleTrendTable'),
  trendTable: $('trendTable'),
  trendTableCaption: $('trendTableCaption'),
  trendTableBody: $('trendTableBody'),
  count: $('count'),
  quality: $('quality'),
  banner: $('banner'),
  alerts: $('alerts'),
  alertCount: $('alert-count'),
  alertList: $('alert-list'),
  alertsDropped: $('alerts-dropped'),
  acknowledgeAlerts: $('ack-alerts'),
  lifecycle: $('lifecycle'),
  lifecycleList: $('lifecycle-list'),
  acknowledgeLifecycle: $('ack-lifecycle'),
  list: $('list'),
  asOf: $('as-of'),
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
  notificationState: null,
  portfolioViews: null,
  storageRecoveryNotice: null,
  privacyNotice: null,
  trendRange: 'baseline',
  // Only meaningful while `trendRange` is 'custom'.
  trendCustomDays: 14,
  movement: new Set(),
};
let refreshing = false;
let bootReady = false;
let viewEditorMode = null;
/** The control that opened the view editor, so closing it can return focus. */
let viewEditorOpener = null;
/** Set by `syncControls` when it had to abandon an unavailable trend range. */
let trendRangeFellBack = false;
/**
 * A control the view editor owes focus to. Closing the editor from inside a
 * queued portfolio update hides it while every control is still disabled, so
 * the focus call has to wait for `syncControls` to re-enable the target.
 */
let pendingFocusReturn = null;

function flushFocusReturn() {
  if (!pendingFocusReturn) return;
  const target = pendingFocusReturn;
  // Only reclaim focus that was actually stranded — nothing focused, or focus
  // still sitting inside the editor that is being hidden out from under it. If
  // the user has moved on, stealing it back would be worse than the drop.
  const stranded =
    !document.activeElement ||
    document.activeElement === document.body ||
    el.viewEditor.contains(document.activeElement);
  if (!target.isConnected || !stranded) {
    pendingFocusReturn = null;
    return;
  }
  if (target.disabled) return;
  pendingFocusReturn = null;
  target.focus();
}
// Which repositories the list currently shows, so a re-render can tell an
// unchanged result set from a genuinely different one.
let lastRenderedIdentity = null;

function hasSetup() {
  return !!(state.settings?.username || state.settings?.token);
}

/**
 * The comparison window in days, or null while the baseline is selected. The
 * control's value and the number of days stopped being the same thing once a
 * custom range existed.
 */
function effectiveTrendDays() {
  if (state.trendRange === 'baseline') return null;
  if (state.trendRange === 'custom') return state.trendCustomDays;
  return Number.parseInt(state.trendRange, 10);
}

/** How the current range reads in a sentence. */
function trendRangeLabel() {
  const days = effectiveTrendDays();
  return days === null ? 'the comparison baseline' : `${days} days`;
}

function syncControls() {
  const hasRows = !!state.cache?.repos;
  const viewBusy = pendingPortfolioUpdates > 0;
  el.refresh.disabled = !hasSetup() || refreshing;
  el.rebase.disabled = !hasRows || refreshing;
  el.search.disabled = !hasRows || viewBusy;
  el.sort.disabled = !hasRows || viewBusy;
  el.trendRange.disabled = !hasRows;
  // Offering a range longer than the retained window returned a column of
  // dashes with no explanation. Say how far back the data actually goes.
  const retained = historyRetainedDays(state.history);
  let longestAvailable = 'baseline';
  for (const option of el.trendRange.options) {
    if (option.value === 'baseline' || option.value === 'custom') continue;
    const days = Number(option.value);
    const unavailable = hasRows && retained < days;
    option.disabled = unavailable;
    option.textContent = unavailable ? `${days} days — not retained yet` : `${days} days`;
    if (!unavailable) longestAvailable = option.value;
  }
  // A custom range is offered only once the history can serve the two days a
  // comparison needs at minimum.
  const customOption = [...el.trendRange.options].find((o) => o.value === 'custom');
  customOption.disabled = hasRows && retained < 2;
  // Same discipline as the fixed ranges: a window the history stopped covering
  // must move to what it can serve rather than silently returning dashes.
  if (hasRows && state.trendRange === 'custom' && retained >= 2 && state.trendCustomDays > retained) {
    const previousCustom = state.trendCustomDays;
    state.trendCustomDays = retained;
    trendRangeFellBack = true;
    queueMicrotask(() =>
      announce(
        `${previousCustom}-day trend is no longer retained. Showing ${retained} days instead.`,
      ),
    );
  }
  el.trendCustomField.hidden = state.trendRange !== 'custom';
  el.trendCustomDays.max = String(Math.max(2, retained));
  if (document.activeElement !== el.trendCustomDays) {
    el.trendCustomDays.value = String(state.trendCustomDays);
  }
  el.trendCustomDays.disabled = !hasRows || customOption.disabled;
  el.trendCustomHint.textContent = `Between 2 and ${nf.format(retained)} retained days.`;
  // A pruned or newly-capped window can disable the range that is currently
  // selected. Leaving it selected left every delta as a dash with no
  // explanation, so fall back to the longest range the history can serve.
  const selectedOption = [...el.trendRange.options].find(
    (option) => option.value === state.trendRange,
  );
  if (hasRows && selectedOption?.disabled) {
    const previous = effectiveTrendDays();
    state.trendRange = longestAvailable;
    el.trendRange.value = longestAvailable;
    trendRangeFellBack = true;
    // Later stages of this same render announce the confidence sentence, and
    // `announce` keeps only the newest message. Queue past them.
    queueMicrotask(() =>
      announce(
        `${previous}-day trend is no longer retained. Showing ${
          longestAvailable === 'baseline' ? 'the baseline comparison' : `${longestAvailable} days`
        } instead.`,
      ),
    );
  } else {
    el.trendRange.value = state.trendRange;
  }
  el.viewSelect.disabled = !hasRows || viewBusy;
  el.saveView.disabled = !hasRows || viewBusy;
  el.toggleFilters.disabled = !hasRows || viewBusy;
  const selected = !!state.portfolioViews?.activeViewId;
  el.renameView.disabled = !hasRows || viewBusy || !selected;
  el.deleteView.disabled = !hasRows || viewBusy || !selected;
  for (const control of [
    el.filterLanguage,
    el.filterVisibility,
    el.filterForks,
    el.filterArchived,
    el.filterPrecision,
    el.filterLifecycle,
    el.filterActivity,
    el.resetFilters,
  ]) {
    control.disabled = !hasRows || viewBusy;
  }
  el.list.setAttribute(
    'aria-busy',
    String(refreshing || (hasSetup() && !state.cache?.repos && !state.cache?.error)),
  );
  flushFocusReturn();
}

// Typing in the search box settles the debounce repeatedly, and each settle
// used to restart the same sentence in the middle of the previous utterance.
// Identical text inside this window is dropped instead.
const REPEAT_WINDOW_MS = 1200;
let lastAnnouncement = { text: '', at: 0 };
let announceFrame = 0;
let quietAnnounceTimer = 0;

/**
 * Update the polite live region.
 *
 * `role="status"` only re-announces when the text actually changes, hence the
 * clear-then-set. Queuing through one animation frame also means that when a
 * render and the action that caused it both want to speak, the more specific
 * message wins instead of the two overlapping.
 */
function announce(message) {
  const text = sentence(message ? messageText(message) : message);
  if (!text) return;
  clearTimeout(quietAnnounceTimer);
  if (
    text === lastAnnouncement.text &&
    Date.now() - lastAnnouncement.at < REPEAT_WINDOW_MS
  ) {
    return;
  }
  el.liveStatus.textContent = '';
  cancelAnimationFrame(announceFrame);
  announceFrame = requestAnimationFrame(() => {
    lastAnnouncement = { text, at: Date.now() };
    el.liveStatus.textContent = text;
  });
}

const messageText = (text) => message(text);

/**
 * Announce only once the user stops typing.
 *
 * The search box persists on a 120 ms debounce, which is right for storage but
 * wrong for speech: every settle restarted the sentence mid-word. Anything more
 * urgent that arrives first cancels the pending message.
 */
function announceWhenIdle(message, delay = 700) {
  clearTimeout(quietAnnounceTimer);
  quietAnnounceTimer = setTimeout(() => announce(message), delay);
}

/** How many repositories the current filters keep, phrased for a listener. */
function matchSummary() {
  if (!state.cache?.repos?.length) return '';
  const total = state.cache.repos.length;
  const shown = visibleRepos().length;
  if (shown === total) {
    return `All ${nf.format(total)} repositories match.`;
  }
  return `${nf.format(shown)} of ${nf.format(total)} repositories match.`;
}

async function updateUndoAvailability() {
  const response = await chrome.runtime.sendMessage({ type: 'undo-status' });
  el.undo.hidden = !response?.undo?.available;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[STORAGE_KEYS.undo]) return;
  const envelope = /** @type {any} */ (changes[STORAGE_KEYS.undo].newValue);
  el.undo.hidden = !(envelope?.data?.expiresAt > Date.now());
});

/* ---------- formatting ---------- */

// Every formatter is bound to chrome.i18n.getUILanguage(), not to
// navigator.language: the two disagree often enough that leaving it implicit
// ships English grouping beside translated text.
const nf = formatters.number();
const signed = formatters.signed();
const rtf = formatters.relativeTime();
const dateTime = formatters.dateTime({ dateStyle: 'medium', timeStyle: 'short' });
const percentFormat = formatters.signed({ maximumFractionDigits: 1 });

/** @type {[Intl.RelativeTimeFormatUnit, number][]} */
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

/** Terminate a message with exactly one sentence-ending mark. */
function sentence(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
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

/** A note carried in the accessible name but not on screen. */
function srOnly(text) {
  const node = document.createElement('span');
  node.className = 'sr-only';
  node.textContent = ` ${text}`;
  return node;
}

const MISSING_POINT_NOTE = 'no comparison point was retained for this range';
const APPROXIMATE_NOTE = 'approximate count';

function sourceLabel(source) {
  return source === 'web' ? 'GitHub website' : 'GitHub API';
}

function sourceDowngradeMessage(downgrade) {
  if (!downgrade?.requested || !downgrade?.effective) return '';
  const why =
    downgrade.reason === 'web-source-disabled'
      ? 'A remote capability rule disabled website mode.'
      : 'The requested source is unavailable.';
  return `The requested ${sourceLabel(downgrade.requested)} source is unavailable. ${why} Using the ${sourceLabel(downgrade.effective)} source instead.`;
}

function deltaNode(value, cls = 'delta', missing = false, partial = null) {
  const span = document.createElement('span');
  span.className = cls;
  if (missing) {
    span.classList.add('missing');
    // The dash is the whole visible message, so the reason travels with it in
    // the accessible name rather than in a pointer-only tooltip.
    span.append('—', srOnly(MISSING_POINT_NOTE));
    span.title = 'No comparison point was retained for this range';
  } else if (value > 0) {
    span.classList.add('up');
    // signDisplay, not a concatenated "+": it produces the locale's real minus
    // sign for negatives and places the sign correctly in RTL.
    span.textContent = signed.format(value);
  } else if (value < 0) {
    span.classList.add('down');
    span.textContent = signed.format(value);
  }
  if (partial && partial.comparable < partial.total) {
    const note = `Partial comparison: ${nf.format(partial.comparable)} of ${nf.format(partial.total)} visible repositories have a retained comparison point.`;
    span.classList.add('partial');
    span.title = note;
    span.setAttribute('aria-label', `${signed.format(value) || 'No change'}. ${note}`);
  }
  return span;
}

/* ---------- data shaping ---------- */

function withDeltas(cache) {
  const base = state.baseline?.counts || {};
  const trendDays = effectiveTrendDays();
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

function movementFor(cache) {
  const movement = cache?.movement;
  if (!movement?.generation || movement.generation !== cache.generation || !Array.isArray(movement.repos)) {
    return new Set();
  }
  try {
    if (sessionStorage.getItem('starboardMovementGeneration') === movement.generation) {
      return new Set();
    }
    sessionStorage.setItem('starboardMovementGeneration', movement.generation);
  } catch {
    // A restricted storage context should not suppress the visual cue.
  }
  return new Set(movement.repos);
}

const SORTERS = {
  stars: (a, b) => b.stargazers_count - a.stargazers_count || a.name.localeCompare(b.name),
  forks: (a, b) => b.forks_count - a.forks_count || b.stargazers_count - a.stargazers_count,
  starsDelta: (a, b) => b.starsDelta - a.starsDelta || b.stargazers_count - a.stargazers_count,
  forksDelta: (a, b) => b.forksDelta - a.forksDelta || b.forks_count - a.forks_count,
  updated: (a, b) =>
    new Date(b.pushed_at || 0).getTime() - new Date(a.pushed_at || 0).getTime(),
  name: (a, b) => a.name.localeCompare(b.name),
};

/**
 * Derived rows for the whole portfolio.
 *
 * `withDeltas` walks every repository and, for a day range, looks each one up
 * in the retained history. It ran three times per render — once for the list,
 * once for the totals' unfiltered count and once for the footer count — on
 * every keystroke commit, filter change and background refresh.
 */
function visibleRepos(all = withDeltas(state.cache)) {
  const filters = state.portfolioViews?.active || DEFAULT_PORTFOLIO_FILTERS;
  const rows = filterRepositories(all, filters, state.cache?.lifecycleEvents || []);
  return rows.sort(SORTERS[filters.sortKey] || SORTERS.stars);
}

/** Repository full name -> the lifecycle change to badge on its row, if any. */
function lifecycleIndex() {
  const index = new Map();
  for (const event of state.cache?.lifecycleEvents || []) {
    if (event.type !== 'added' && event.type !== 'renamed') continue;
    if (!index.has(event.to)) index.set(event.to, event);
  }
  return index;
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
  wrap.appendChild(b);
  // The note is a sibling of `b`, never a child: the smoke suite parses that
  // element as a bare number.
  if (approx) {
    b.title = 'Approximate — github.com abbreviates counts above 1,000';
    wrap.appendChild(srOnly(APPROXIMATE_NOTE));
  }
  wrap.appendChild(deltaNode(delta, 'delta', comparisonMissing));
  return wrap;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The window the sparkline covers, or null while the baseline is selected. */
function sparklineDays() {
  return effectiveTrendDays();
}

// Rebuilt only when the history record itself changes: a findIndex per row was
// quadratic in the portfolio size, on every render.
let seriesIndex = { history: null, map: null };

function repoSeriesIndex() {
  if (seriesIndex.history !== state.history) {
    seriesIndex = { history: state.history, map: historyRepoIndex(state.history) };
  }
  return seriesIndex.map;
}

function seriesFor(repo) {
  const days = sparklineDays();
  if (!days || !state.history) return null;
  return historySeriesForRepo(state.history, repo, days, { index: repoSeriesIndex() });
}

/** Sentence a screen reader gets in place of the line. */
function seriesLabel(series) {
  if (!series || series.measured === 0) {
    return `No star history retained in the last ${series?.days ?? 0} days.`;
  }
  const change =
    series.delta === null
      ? 'no measurable change'
      : series.delta === 0
        ? 'unchanged'
        : `${series.delta > 0 ? 'up' : 'down'} ${nf.format(Math.abs(series.delta))}`;
  const gaps = series.gaps
    ? ` No data for ${nf.format(series.gaps)} of ${nf.format(series.days)} days.`
    : '';
  // The dates have to be the days actually measured. Naming the window's edges
  // instead claimed a reading on a day the series has no point for.
  return (
    `Stars over ${nf.format(series.days)} days (${series.from} to ${series.to}): ` +
    `${nf.format(series.first)} on ${series.firstDay}, ` +
    `${nf.format(series.last)} on ${series.lastDay}, ${change}.${gaps}`
  );
}

/**
 * An inline SVG sparkline with no dependency. The viewBox is authored in data
 * space — x is the day index, y is the value — and stretched to the slot by
 * `preserveAspectRatio="none"`, so no value has to be projected by hand.
 */
function sparklineNode(series) {
  if (!series || series.measured < SPARKLINE_MIN_POINTS) {
    const thin = document.createElement('span');
    thin.className = 'spark-thin';
    thin.textContent = series?.measured ? `${series.measured} pts` : '—';
    thin.setAttribute('role', 'img');
    thin.setAttribute(
      'aria-label',
      series?.measured
        ? `Only ${series.measured} retained points in ${series.days} days — too few to plot. ` +
          seriesLabel(series)
        : seriesLabel(series),
    );
    return thin;
  }

  const segments = sparklineSegments(series.values);
  const measured = series.values.filter((point) => point.value !== null).map((p) => p.value);
  const min = Math.min(...measured);
  const max = Math.max(...measured);
  const flat = min === max;
  // A flat series would collapse to a zero-height box and disappear.
  const span = flat ? 1 : max - min;
  const width = Math.max(1, series.days - 1);
  const yFor = (value) => (flat ? min + span / 2 : min + max - value);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `spark${series.delta < 0 ? ' is-down' : ''}`);
  svg.setAttribute('viewBox', `0 ${min - span * 0.12} ${width} ${span * 1.24}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-roledescription', 'sparkline');
  svg.setAttribute('aria-label', seriesLabel(series));

  for (const segment of segments) {
    if (segment.length === 1) {
      // One measurement stranded between long gaps is still a measurement.
      // A radius is stretched by preserveAspectRatio="none" and can become
      // sub-pixel when the value range is large. A short data-space tick keeps
      // the measurement visible in physical pixels instead.
      const dot = document.createElementNS(SVG_NS, 'line');
      const halfHeight = span * 0.1;
      dot.setAttribute('x1', String(segment[0].index));
      dot.setAttribute('x2', String(segment[0].index));
      dot.setAttribute('y1', String(yFor(segment[0].value) - halfHeight));
      dot.setAttribute('y2', String(yFor(segment[0].value) + halfHeight));
      dot.setAttribute('class', 'spark-point');
      svg.appendChild(dot);
      continue;
    }
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute(
      'd',
      segment
        // SVG y grows downward; mirror the value around the series midpoint so
        // a rising count rises on screen.
        .map((point, i) => `${i ? 'L' : 'M'}${point.index} ${yFor(point.value)}`)
        .join(' '),
    );
    svg.appendChild(path);
  }
  return svg;
}

/**
 * The comparison is bounded on purpose. Filters, search and saved views choose
 * the set; this caps how much of it is tabulated so the popup cannot be asked
 * to lay out 343 rows of seven columns inside an 800x600 ceiling.
 */
const TREND_TABLE_MAX_ROWS = 50;

function growthText(series, metric) {
  if (!series || series.delta === null) return '—';
  if (metric === 'percent') {
    // Growth from nothing is not a percentage. Saying "+∞%" or "+100%" would
    // both be inventions.
    if (!series.first) return series.delta > 0 ? 'from 0' : '—';
    const percent = (series.delta / series.first) * 100;
    return `${percentFormat.format(percent)}%`;
  }
  const mark = series.approximate ? '~' : '';
  return `${mark}${signed.format(series.delta)}`;
}

function renderTrendTable(rows) {
  const days = sparklineDays();
  const active = !el.trendTable.hidden;
  el.toggleTrendTable.disabled = !days || !rows.length;
  if (!days) {
    el.trendTable.hidden = true;
    el.toggleTrendTable.setAttribute('aria-expanded', 'false');
    return;
  }
  if (!active) return;

  const index = repoSeriesIndex();
  const compared = rows
    .map((repo) => ({
      repo,
      stars: historyDeltaForRepo(state.history, repo, days, { index }),
    }))
    // Biggest movers first: a comparison ordered by current stars answers a
    // different question than the one this table is for.
    .sort((a, b) => compareHistoryDeltas(a.stars, b.stars));
  const shown = compared.slice(0, TREND_TABLE_MAX_ROWS).map(({ repo }) => ({
    repo,
    stars: historySeriesForRepo(state.history, repo, days, { index }),
    forks: historySeriesForRepo(state.history, repo, days, { index, metric: 'forks' }),
  }));
  const dropped = compared.length - shown.length;

  el.trendTableCaption.textContent =
    `Star growth over the last ${nf.format(days)} days, biggest movers first, for ` +
    `${nf.format(shown.length)} of ${nf.format(rows.length)} visible ` +
    `repositor${rows.length === 1 ? 'y' : 'ies'}. A dash means no measurement was retained ` +
    'for that range; ~ marks a count GitHub abbreviated.' +
    (dropped ? ` ${nf.format(dropped)} more are excluded — narrow the filters to see them.` : '');

  const body = document.createDocumentFragment();
  for (const entry of shown) {
    const { repo, stars, forks } = entry;
    const tr = document.createElement('tr');
    const cells = [
      repo.full_name,
      stars.first === null ? '—' : `${stars.approximate ? '~' : ''}${nf.format(stars.first)}`,
      stars.last === null ? '—' : `${stars.approximate ? '~' : ''}${nf.format(stars.last)}`,
      growthText(stars, 'absolute'),
      growthText(stars, 'percent'),
      growthText(forks, 'absolute'),
      `${nf.format(stars.measured)} of ${nf.format(stars.days)}`,
    ];
    cells.forEach((text, at) => {
      const cell = document.createElement(at === 0 ? 'th' : 'td');
      if (at === 0) cell.setAttribute('scope', 'row');
      cell.textContent = text;
      if (stars.gaps && at === 6) cell.classList.add('has-gaps');
      tr.appendChild(cell);
    });
    body.appendChild(tr);
  }
  el.trendTableBody.replaceChildren(body);
}

function rowNode(repo, rank, changes) {
  const a = document.createElement('a');
  a.className = 'row';
  a.href = repo.html_url;
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.title = repo.description || repo.full_name;
  if (state.movement.has(repo.full_name)) a.classList.add('moved');

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
  // Indexed once per render. Scanning the event list per row made this
  // quadratic in the portfolio size for no gain.
  const lifecycle = changes.get(repo.full_name);
  if (lifecycle) {
    const change = document.createElement('span');
    change.className = `lifecycle-tag ${lifecycle.type}`;
    change.textContent = lifecycle.type === 'renamed' ? 'renamed' : 'new';
    name.appendChild(change);
  }
  if (state.movement.has(repo.full_name)) {
    const moved = document.createElement('span');
    moved.className = 'movement-tag';
    moved.textContent = 'moved';
    moved.title = 'Star or fork count changed in the newest snapshot';
    name.appendChild(moved);
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

  const series = seriesFor(repo);
  if (series) a.appendChild(sparklineNode(series));

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

// Only the rows that can be on screen are built before the popup paints; the
// rest arrive in frame-sized chunks. Building all of them up front was ~3,000
// nodes at 206 repositories and ~22,000 at the documented 1,500 cap, on every
// keystroke commit, filter change and background refresh.
const FIRST_PAINT_ROWS = 60;
const CHUNK_ROWS = 120;
let paintFrame = 0;

/** `painting` until every row is in the DOM. The browser suite waits on this. */
function paintRows(rows, changes, restoreScroll) {
  cancelAnimationFrame(paintFrame);
  const started = performance.now();
  const initial = Math.min(rows.length, FIRST_PAINT_ROWS);
  const first = document.createDocumentFragment();
  for (let i = 0; i < initial; i += 1) first.appendChild(rowNode(rows[i], i + 1, changes));
  el.list.replaceChildren(first);
  el.list.scrollTop = restoreScroll;
  document.body.dataset.listPaintMs = String(Math.round(performance.now() - started));
  if (initial >= rows.length) {
    document.body.dataset.listState = 'painted';
    return;
  }
  document.body.dataset.listState = 'painting';
  let next = initial;
  const step = () => {
    const end = Math.min(rows.length, next + CHUNK_ROWS);
    const chunk = document.createDocumentFragment();
    for (let i = next; i < end; i += 1) chunk.appendChild(rowNode(rows[i], i + 1, changes));
    el.list.appendChild(chunk);
    // A restored position can exceed the content height until enough chunks
    // have landed, so it is re-applied until it sticks.
    if (el.list.scrollTop < restoreScroll) el.list.scrollTop = restoreScroll;
    next = end;
    if (next < rows.length) paintFrame = requestAnimationFrame(step);
    else document.body.dataset.listState = 'painted';
  };
  paintFrame = requestAnimationFrame(step);
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

/** Shared by the Reset filters control and the no-match empty state. */
function resetAllFilters() {
  return queueFilterPatch(
    {
      query: '',
      language: DEFAULT_PORTFOLIO_FILTERS.language,
      visibility: DEFAULT_PORTFOLIO_FILTERS.visibility,
      forkStatus: DEFAULT_PORTFOLIO_FILTERS.forkStatus,
      archivedStatus: DEFAULT_PORTFOLIO_FILTERS.archivedStatus,
      precision: DEFAULT_PORTFOLIO_FILTERS.precision,
      lifecycle: DEFAULT_PORTFOLIO_FILTERS.lifecycle,
      activity: DEFAULT_PORTFOLIO_FILTERS.activity,
    },
    'Repository filters reset.',
  ).catch((error) => announce(error.message || 'Could not reset the filters.'));
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

function renderTotals(rows, allRows) {
  const stars = rows.reduce((s, r) => s + r.stargazers_count, 0);
  const forks = rows.reduce((s, r) => s + r.forks_count, 0);
  const dStars = rows.reduce((s, r) => s + r.starsDelta, 0);
  const dForks = rows.reduce((s, r) => s + r.forksDelta, 0);
  const comparable = rows.filter((repo) => !repo.comparisonMissing).length;
  const trendSelected = state.trendRange !== 'baseline';
  const partialComparison =
    trendSelected && comparable > 0 && comparable < rows.length
      ? { comparable, total: rows.length }
      : null;

  const approximate = rows.some((repo) => repo.approx);
  el.totalStars.textContent = `${approximate ? '~' : ''}${nf.format(stars)}`;
  el.totalForks.textContent = `${approximate ? '~' : ''}${nf.format(forks)}`;
  el.totalRepos.textContent = nf.format(rows.length);
  el.totalStarsDelta.replaceWith(
    withId(
      deltaNode(dStars, 'delta', trendSelected && comparable === 0, partialComparison),
      'total-stars-delta',
    ),
  );
  el.totalForksDelta.replaceWith(
    withId(
      deltaNode(dForks, 'delta', trendSelected && comparable === 0, partialComparison),
      'total-forks-delta',
    ),
  );
  el.totalStarsDelta = $('total-stars-delta');
  el.totalForksDelta = $('total-forks-delta');
  el.totalForksWrap.hidden = !state.settings.showForkStats;
  el.totals.classList.toggle('fork-stats-hidden', !state.settings.showForkStats);
  const unfilteredCount = allRows.length;
  const filtered =
    !!state.portfolioViews?.active.query.trim() || rows.length !== unfilteredCount;
  el.totalStarsLabel.textContent = filtered ? 'Visible stars' : 'Total stars';
  el.totalReposLabel.textContent = filtered ? 'Visible repos' : 'Repos';
  el.totalStars.title = approximate
    ? 'Approximate total — one or more website counts are abbreviated'
    : '';
  const trendDays = effectiveTrendDays();
  el.trendRange.title = trendSelected
    ? `${comparable} of ${rows.length} visible repositories have a retained ${trendDays}-day comparison point`
    : 'Compare against the point you last reset';

  const confidence = state.cache?.confidence || 'exact';
  const confidenceLabel = {
    exact: 'Exact snapshot',
    approximate: 'Approximate counts',
    partial: 'Partial snapshot',
    stale: 'Not a live read',
  }[confidence] || 'Snapshot';
  el.confidence.textContent = confidenceLabel;
  el.confidence.className = `confidence-badge ${confidence}`;

  const notes = renderQuality(rows, comparable, trendDays, confidence);
  // The badge names the state; the notes say what it means for the numbers on
  // screen. Neither is announced by itself, so a change in either speaks once.
  const signature = `${confidenceLabel} ${notes.join(' ')}`;
  if (lastQualitySignature !== null && signature !== lastQualitySignature) {
    announce([confidenceLabel, ...notes].join('. '));
  }
  lastQualitySignature = signature;

  const at = state.baseline?.at;
  el.since.textContent = at ? `since ${relative(at)}` : 'since —';
  el.rebase.title = at
    ? `Changes are measured from ${relative(at)}. Activate to measure from now instead.`
    : 'Activate to start measuring changes from now.';
  el.totals.hidden = false;
}

let lastQualitySignature = null;

/**
 * Spell out the data-quality caveats that apply to the numbers on screen.
 *
 * The partial case is deliberately absent: the banner already states it and
 * names the reason, and saying it twice on one screen reads as two problems.
 */
function renderQuality(rows, comparable, trendDays, confidence) {
  const notes = [];
  if (rows.some((repo) => repo.approx)) {
    notes.push('Some counts are approximate — github.com abbreviates counts above 1,000.');
  }
  if (confidence === 'stale' || state.cache?.stale) {
    notes.push('These counts are from the last snapshot that loaded, not a live read.');
  }
  if (trendDays) {
    notes.push(
      comparable === 0
        ? `No visible repository has a retained ${trendDays}-day comparison point yet, so every change column shows a dash.`
        : `${nf.format(comparable)} of ${nf.format(rows.length)} visible repositories have a retained ${trendDays}-day comparison point; the rest show a dash.`,
    );
  }
  const fragment = document.createDocumentFragment();
  for (const note of notes) {
    const item = document.createElement('li');
    item.textContent = note;
    fragment.appendChild(item);
  }
  el.quality.replaceChildren(fragment);
  el.quality.hidden = notes.length === 0;
  return notes;
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

function renderAlerts() {
  const events = state.notificationState?.pending || [];
  const dropped = state.notificationState?.dropped || 0;
  if (!events.length && !dropped) {
    el.alerts.hidden = true;
    el.alertList.replaceChildren();
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const event of events) {
    const item = document.createElement('li');
    item.textContent = `${event.title}: ${event.message} · ${relative(event.createdAt)}`;
    fragment.appendChild(item);
  }
  el.alertCount.textContent = events.length ? `(${nf.format(events.length)})` : '';
  el.alertList.replaceChildren(fragment);
  el.alertList.hidden = events.length === 0;
  el.alertsDropped.textContent = dropped
    ? `${nf.format(dropped)} older alert${dropped === 1 ? '' : 's'} could not be retained after the local 50-alert inbox filled.`
    : '';
  el.alertsDropped.hidden = dropped === 0;
  el.acknowledgeAlerts.textContent = events.length ? 'Dismiss all' : 'Dismiss notice';
  el.alerts.hidden = false;
}

function withId(node, id) {
  node.id = id;
  return node;
}

// What the banner currently says, so a change can be announced once. `null`
// before the first render suppresses an announcement for a banner the user is
// already looking at when the popup opens.
let bannerMessage = null;
let announcedBanner; // undefined until the first render completes
const SETTINGS_RECOVERY_MESSAGES = Object.freeze({
  TOKEN_REJECTED: 'GitHub rejected the configured token. Check or replace the token in Settings.',
  USER_NOT_FOUND: 'GitHub could not find the configured username. Check the username in Settings.',
  FORBIDDEN: 'GitHub refused access for the configured token. Check its permissions in Settings.',
  SETUP_REQUIRED: 'No GitHub username is configured. Add a username in Settings.',
});

/** Fill the banner with a message and, when recovery is possible, one action. */
function showBanner(message, action) {
  bannerMessage = message;
  el.banner.hidden = false;
  const text = document.createElement('span');
  text.className = 'banner-text';
  text.textContent = message;
  el.banner.replaceChildren(text);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'banner-action';
    button.textContent = action.label;
    button.addEventListener('click', action.onClick);
    el.banner.appendChild(button);
  }
}

/** Ask for the github.com origin from this click, then refresh. */
async function requestWebPermission() {
  try {
    const granted = await chrome.permissions.request({
      origins: ['https://github.com/*'],
    });
    if (granted) await doRefresh();
    else announce('StarBoard still has no access to github.com.');
  } catch (error) {
    announce(`Could not request access. ${error.message}`);
  }
}

/**
 * `role="alert"` covers the case where the banner is already on screen and its
 * text changes. It does not reliably cover the first appearance, because the
 * unhide and the content insertion happen in the same task. Mirroring the
 * message into the polite region closes that gap; when the action that caused
 * the banner announces something more specific in the same frame, `announce`
 * collapses to that instead.
 */
function renderBanner() {
  bannerMessage = null;
  renderBannerContent();
  if (announcedBanner !== undefined && bannerMessage && bannerMessage !== announcedBanner) {
    announce(bannerMessage);
  }
  announcedBanner = bannerMessage;
}

function renderBannerContent() {
  const downgrade = sourceDowngradeMessage(state.cache?.sourceDowngrade);
  if (state.storageRecoveryNotice) {
    const notice = state.storageRecoveryNotice;
    const outcome =
      notice.outcome === 'restored'
        ? 'was restored from the last-known-good copy after its stored record became invalid.'
        : 'was reset because neither its stored record nor its recovery copy could be read.';
    showBanner(`${notice.label} ${outcome} ${sentence(notice.reason)}`, {
      label: 'Dismiss',
      onClick: async () => {
        try {
          await dismissStorageRecoveryNotice(notice.id);
          state.storageRecoveryNotice = await getStorageRecoveryNotice();
          renderBanner();
        } catch (error) {
          announce(`Could not dismiss the storage notice. ${sentence(error.message)}`);
        }
      },
    });
    return;
  }
  if (!navigator.onLine) {
    showBanner(
      state.cache?.repos
        ? 'You are offline. Showing the last snapshot StarBoard stored locally.'
        : 'You are offline. StarBoard will load your repositories once the connection returns.',
    );
    return;
  }
  const err = state.cache?.error;
  if (err) {
    const retained =
      state.cache?.pendingSource
        ? ` Showing the last successful ${state.cache.source === 'web' ? 'website' : 'API'} snapshot.`
        : ' Showing the last successful snapshot.';
    const hasSnapshot = !!state.cache?.repos?.length;
    const suffix = `${hasSnapshot ? retained : ''}${downgrade ? ` ${downgrade}` : ''}`;
    if (err.code === 'WEB_PERMISSION_REQUIRED') {
      showBanner(`${err.message}${suffix}`, {
        label: 'Grant access',
        onClick: requestWebPermission,
      });
      return;
    }
    if (err.code === 'STORAGE_QUOTA_EXCEEDED') {
      // Retrying cannot help; the user has to free space.
      showBanner(`${sentence(err.message)}${suffix}`, {
        label: 'Open settings',
        onClick: () => chrome.runtime.openOptionsPage(),
      });
      return;
    }
    if (Object.hasOwn(SETTINGS_RECOVERY_MESSAGES, err.code)) {
      showBanner(`${SETTINGS_RECOVERY_MESSAGES[err.code]}${suffix}`, {
        label: 'Open settings',
        onClick: () => chrome.runtime.openOptionsPage(),
      });
      return;
    }
    if (err.rateLimited && err.resetAt) {
      // The service worker already scheduled a retry alarm for resetAt; this
      // only tells the user when that will happen.
      showBanner(`${err.message} Retrying automatically ${relative(err.resetAt)}.${suffix}`);
      return;
    }
    showBanner(`${sentence(err.message)}${suffix}`, {
      label: 'Try again',
      onClick: () => doRefresh(),
    });
    return;
  }
  if (state.privacyNotice) {
    const notice = state.privacyNotice;
    showBanner(notice.message, {
      label: 'Dismiss',
      onClick: async () => {
        try {
          await dismissPrivacyNotice(notice.id);
          state.privacyNotice = await getPrivacyNotice();
          renderBanner();
        } catch (error) {
          announce(`Could not dismiss the privacy notice. ${sentence(error.message)}`);
        }
      },
    });
    return;
  }
  if (state.cache?.complete === false) {
    if (state.cache.partialReason === 'access-reduced') {
      showBanner(
        'Access reduced: this refresh was unauthenticated after the previous snapshot used a token. Private repositories may be missing. Add the token again in Settings.',
        {
          label: 'Open settings',
          onClick: () => chrome.runtime.openOptionsPage(),
        },
      );
      return;
    }
    if (downgrade) {
      showBanner(downgrade, {
        label: 'Open settings',
        onClick: () => chrome.runtime.openOptionsPage(),
      });
      return;
    }
    const reason = {
      cap: `the ${state.cache.cap?.maxRepositories || 1500}-repository safety cap was reached`,
      'parser-drift': 'a later GitHub page could not be parsed',
      shortfall: 'GitHub listed fewer repositories than the account reports owning',
      'rate-limited': 'GitHub asked StarBoard to slow down',
      timeout: 'a later GitHub page timed out',
      network: 'a later GitHub page could not be loaded',
    }[state.cache.partialReason] || 'the refresh could not finish';
    showBanner(`Partial snapshot: ${reason}. What loaded is still usable.`, {
      label: 'Try again',
      onClick: () => doRefresh(),
    });
    return;
  }
  if (downgrade) {
    showBanner(downgrade, {
      label: 'Open settings',
      onClick: () => chrome.runtime.openOptionsPage(),
    });
    return;
  }
  el.banner.hidden = true;
  el.banner.replaceChildren();
}

function setSelectOptions(select, options, selected) {
  const fragment = document.createDocumentFragment();
  for (const option of options) {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    fragment.appendChild(node);
  }
  select.replaceChildren(fragment);
  select.value = selected;
}

// The snapshot generation the language list was built from, plus the selected
// value, so an unchanged portfolio does not rebuild the dropdown.
let lastLanguageSignature = null;
let languageCache = { generation: null, languages: [] };

function languageChoices() {
  const generation = state.cache?.generation ?? state.cache?.fetchedAt ?? null;
  if (generation !== null && generation === languageCache.generation) {
    return languageCache.languages;
  }
  const languages = [
    ...new Set((state.cache?.repos || []).map((repo) => repo.language).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  languageCache = { generation, languages };
  return languages;
}

function syncPortfolioViewControls() {
  if (!state.portfolioViews) return;
  const { active, activeViewId, views } = state.portfolioViews;
  // Renders are driven by an awaited storage write, so anything typed during
  // that round trip would be overwritten and the caret thrown to the end.
  // Only correct a control the user is not currently using.
  if (document.activeElement !== el.search && el.search.value !== active.query) {
    el.search.value = active.query;
  }
  if (document.activeElement !== el.sort && el.sort.value !== active.sortKey) {
    el.sort.value = active.sortKey;
  }

  setSelectOptions(
    el.viewSelect,
    [
      { value: '', label: 'Custom view' },
      ...views.map((view) => ({ value: view.id, label: view.name })),
    ],
    activeViewId || '',
  );

  // Rebuilding these options on every render collapsed the dropdown while the
  // user had it open, and cost a full pass over the portfolio each time. The
  // languages can only change when the snapshot does.
  const languages = languageChoices();
  const signature = [active.language].concat(languages).join('|');
  if (signature !== lastLanguageSignature) {
    const languageOptions = [
      { value: 'all', label: 'All languages' },
      { value: NO_LANGUAGE, label: 'No language' },
      ...languages.map((language) => ({ value: language, label: language })),
    ];
    if (
      active.language !== 'all' &&
      active.language !== NO_LANGUAGE &&
      !languages.includes(active.language)
    ) {
      languageOptions.push({
        value: active.language,
        label: `${active.language} (not present)`,
      });
    }
    setSelectOptions(el.filterLanguage, languageOptions, active.language);
    lastLanguageSignature = signature;
  } else if (el.filterLanguage.value !== active.language) {
    el.filterLanguage.value = active.language;
  }
  el.filterVisibility.value = active.visibility;
  el.filterForks.value = active.forkStatus;
  el.filterArchived.value = active.archivedStatus;
  el.filterPrecision.value = active.precision;
  el.filterLifecycle.value = active.lifecycle;
  el.filterActivity.value = active.activity;

  const filterCount = activeAdvancedFilterCount(active);
  el.filterCount.textContent = String(filterCount);
  el.filterCount.hidden = filterCount === 0;
  el.toggleFilters.title =
    filterCount === 0
      ? 'Open repository filters'
      : `${filterCount} non-default repository filter${filterCount === 1 ? '' : 's'}`;
  const viewBusy = pendingPortfolioUpdates > 0;
  el.renameView.disabled = !state.cache?.repos || viewBusy || !activeViewId;
  el.deleteView.disabled = !state.cache?.repos || viewBusy || !activeViewId;
  el.resetFilters.disabled =
    !state.cache?.repos || viewBusy || (!active.query && filterCount === 0);
}

function render() {
  const { settings, cache } = state;
  // A chunk queued by the previous render would otherwise append rows on top
  // of a skeleton or an empty state.
  cancelAnimationFrame(paintFrame);
  document.body.dataset.listState = 'painted';
  // Every early return below leaves the totals hidden, and the quality notes
  // describe those totals. `renderTotals` refills them on the normal path.
  el.quality.replaceChildren();
  el.quality.hidden = true;
  el.asOf.hidden = true;
  const healthy = !!cache?.fetchedAt && !cache.error;
  el.footer.classList.toggle('is-healthy', healthy);
  syncControls();
  syncPortfolioViewControls();

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
  renderAlerts();
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

  // A synced account that genuinely owns nothing is not a filtering problem —
  // `repos` is an empty array here, which is truthy, so it must be caught
  // before the no-match branch below.
  if (!cache.repos.length) {
    el.totals.hidden = true;
    el.count.textContent = '';
    el.updated.textContent = `${cache.stale ? 'Last successful update' : 'Updated'} ${relative(cache.fetchedAt)}`;
    renderEmpty(
      'No repositories yet',
      `${cache.profile?.login ? `@${cache.profile.login}` : 'This account'} does not own any repositories that StarBoard can see. Create one on GitHub, or check the username in settings.`,
      { label: 'Open settings', onClick: () => chrome.runtime.openOptionsPage() },
    );
    return;
  }

  const allRows = withDeltas(cache);
  const rows = visibleRepos(allRows);
  renderTotals(rows, allRows);

  const allCount = allRows.length;
  el.count.textContent =
    rows.length === allCount
      ? `${nf.format(rows.length)} shown`
      : `${nf.format(rows.length)} of ${nf.format(allCount)} shown`;
  if (cache.fetchedAt) {
    el.asOf.hidden = false;
    el.asOf.textContent = `As of ${relative(cache.fetchedAt)}`;
    el.asOf.title = `Snapshot captured ${dateTime.format(new Date(cache.fetchedAt))}`;
  } else {
    el.asOf.hidden = true;
  }
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

  renderTrendTable(rows);

  if (!rows.length) {
    // Every other empty state offers a way out. This one hid its only escape
    // inside the collapsed filter panel.
    renderEmpty(
      'Nothing matches',
      'The current search and filters exclude every repository in this snapshot.',
      { label: 'Reset filters', onClick: resetAllFilters },
    );
    return;
  }

  // Scrolling back to the top is only correct when the user is looking at a
  // different set of repositories. A background refresh landing while they
  // read row 40 must not yank them away from it.
  const identity = rows.map((repo) => repo.full_name).join('\n');
  const sameResults = identity === lastRenderedIdentity;
  const previousScroll = el.list.scrollTop;
  paintRows(rows, lifecycleIndex(), sameResults ? previousScroll : 0);
  lastRenderedIdentity = identity;
}

/* ---------- actions ---------- */

async function doRefresh(rebase = false) {
  if (refreshing) return;
  refreshing = true;
  el.refresh.classList.add('spinning');
  el.refresh.setAttribute('aria-label', 'Refreshing repositories');
  syncControls();
  try {
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'refresh', rebase });
    } catch (error) {
      state.cache =
        (await getCache().catch(() => null)) ||
        state.cache ||
        { error: { message: error.message || 'The background refresh did not respond.' } };
      render();
      announce(`Refresh failed. ${error.message || 'The background refresh did not respond.'}`);
      return;
    }

    // The response is the authoritative outcome. Optional local reads and the
    // undo-status probe must not turn a committed success into a reported
    // failure if the MV3 worker disappears immediately after responding.
    state.cache = res?.cache ?? (await getCache().catch(() => state.cache));
    state.movement = res?.ok ? movementFor(state.cache) : new Set();
    state.baseline = res?.baseline ?? (await getBaseline().catch(() => state.baseline));
    state.history = await getHistory().catch(() => state.history);
    state.notificationState = await getNotificationState().catch(
      () => state.notificationState,
    );
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
      if (rebase) updateUndoAvailability().catch(() => {});
    } else {
      announce(`Refresh failed. ${res?.error?.message || 'The cached snapshot is still shown.'}`);
    }
  } finally {
    refreshing = false;
    el.refresh.classList.remove('spinning');
    el.refresh.setAttribute('aria-label', 'Refresh now');
    syncControls();
  }
}

async function patchSettings(changes) {
  const response = await chrome.runtime.sendMessage({ type: 'patch-settings', changes });
  if (!response?.ok) throw new Error(response?.error?.message || 'Could not save settings.');
  state.settings = response.settings;
  chrome.runtime.sendMessage({ type: 'update-badge' }).catch(() => {});
  return response.settings;
}

async function syncLegacyFilterSettings(filters) {
  await patchSettings({
    sortKey: filters.sortKey,
    includeForks: filters.forkStatus !== 'sources',
    includeArchived: filters.archivedStatus !== 'active',
  });
}

async function applyFilterPatch(changes, message = 'Filters updated.', { defer = false } = {}) {
  state.portfolioViews = await setActivePortfolioFilters(changes);
  render();
  if (
    Object.hasOwn(changes, 'sortKey') ||
    Object.hasOwn(changes, 'forkStatus') ||
    Object.hasOwn(changes, 'archivedStatus')
  ) {
    await syncLegacyFilterSettings(state.portfolioViews.active);
  }
  // "Filters updated" told a listener nothing: not which filter, and not
  // whether the result set still contains anything.
  const spoken = `${sentence(message)} ${matchSummary()}`.trim();
  if (defer) announceWhenIdle(spoken);
  else announce(spoken);
}

function closeViewEditor() {
  // Hiding a container while focus is inside it drops focus to <body>, which
  // strands a keyboard user at the top of the document.
  const returnTo = viewEditorOpener;
  viewEditorOpener = null;
  viewEditorMode = null;
  el.viewEditor.hidden = true;
  el.viewName.value = '';
  el.viewName.setCustomValidity('');
  pendingFocusReturn = returnTo?.isConnected ? returnTo : el.viewSelect;
  flushFocusReturn();
}

function openViewEditor(mode) {
  resetDeleteConfirmation();
  viewEditorOpener = mode === 'rename' ? el.renameView : el.saveView;
  viewEditorMode = mode;
  const selected = state.portfolioViews.views.find(
    (view) => view.id === state.portfolioViews.activeViewId,
  );
  el.viewName.value = mode === 'rename' ? selected?.name || '' : '';
  el.confirmView.textContent = mode === 'rename' ? 'Rename view' : 'Save view';
  el.viewEditor.hidden = false;
  el.viewName.focus();
  el.viewName.select();
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

let portfolioUpdateQueue = Promise.resolve();
let pendingPortfolioUpdates = 0;
let latestFilterIntent = 0;
// `data-portfolio-state` / `data-portfolio-error` are settle signals the
// browser suite synchronises on. Keep writing them.
document.body.dataset.portfolioState = 'saved';

function queuePortfolioUpdate(work) {
  pendingPortfolioUpdates += 1;
  document.body.dataset.portfolioState = 'saving';
  delete document.body.dataset.portfolioError;
  syncControls();
  const result = portfolioUpdateQueue.then(work, work);
  portfolioUpdateQueue = result.catch((error) => {
    const message = error?.message || 'Portfolio update failed.';
    document.body.dataset.portfolioError = message;
    // The attribute alone told the user nothing; a saved view or filter that
    // failed to persist has to be visible.
    announce(`Could not save that view change. ${sentence(message)}`);
  });
  return result.finally(() => {
    pendingPortfolioUpdates -= 1;
    if (pendingPortfolioUpdates === 0) document.body.dataset.portfolioState = 'saved';
    syncControls();
  });
}

function nextFilterIntent() {
  latestFilterIntent += 1;
  return latestFilterIntent;
}

/**
 * Persist filter intents in user-event order, not debounce-expiry order.
 *
 * Search writes deliberately wait 120 ms. A sort or select change that happens
 * during that window is the newer intent even though it reaches the queue
 * first. The newer action includes the search control's current value, so the
 * delayed write is both redundant and unsafe to apply afterwards.
 */
function queueFilterPatch(changes, message, options, intent = nextFilterIntent()) {
  if (intent !== latestFilterIntent) return Promise.resolve();
  return queuePortfolioUpdate(() => {
    if (intent !== latestFilterIntent) return undefined;
    return applyFilterPatch(changes, message, options);
  });
}

el.refresh.addEventListener('click', () => doRefresh(false));
el.settings.addEventListener('click', () => chrome.runtime.openOptionsPage());
let rebaseArmedUntil = 0;
let rebaseResetTimer;

function resetRebaseConfirmation() {
  rebaseArmedUntil = 0;
  el.rebase.classList.remove('confirming');
  const at = state.baseline?.at;
  el.since.textContent = at ? `since ${relative(at)}` : 'since —';
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
const persistSearch = debounce((value, intent) => {
  queueFilterPatch(
    { query: value },
    value.trim() ? `Filtering repositories by "${value.trim()}".` : 'Repository search cleared.',
    { defer: true },
    intent,
  ).catch((error) => announce(error.message || 'Could not save the repository search.'));
}, 120);
el.search.addEventListener('input', () => persistSearch(el.search.value, nextFilterIntent()));

/** The visible label of a select's current option, for spoken feedback. */
function chosenLabel(select) {
  return select.selectedOptions[0]?.textContent?.trim() || select.value;
}

el.sort.addEventListener('change', () => {
  const value = el.sort.value;
  const label = chosenLabel(el.sort);
  queueFilterPatch(
    { query: el.search.value, sortKey: value },
    `Sorted by ${label}.`,
  ).catch((error) => announce(error.message || 'Could not save the repository sort.'));
});

for (const [control, key, name] of [
  [el.filterLanguage, 'language', 'Language'],
  [el.filterVisibility, 'visibility', 'Visibility'],
  [el.filterForks, 'forkStatus', 'Repository type'],
  [el.filterArchived, 'archivedStatus', 'Archive state'],
  [el.filterPrecision, 'precision', 'Count precision'],
  [el.filterLifecycle, 'lifecycle', 'Lifecycle'],
  [el.filterActivity, 'activity', 'Last push'],
]) {
  control.addEventListener('change', () => {
    const value = control.value;
    const label = chosenLabel(control);
    queueFilterPatch(
      { query: el.search.value, [key]: value },
      `${name} filter set to ${label}.`,
    ).catch((error) => announce(error.message || 'Could not save that filter.'));
  });
}

el.toggleTrendTable.addEventListener('click', () => {
  const opening = el.trendTable.hidden;
  el.trendTable.hidden = !opening;
  el.toggleTrendTable.setAttribute('aria-expanded', String(opening));
  if (opening) {
    render();
    announce('Trend table shown. It carries the same series as the row sparklines.');
  } else {
    announce('Trend table hidden.');
  }
});

el.toggleFilters.addEventListener('click', () => {
  const opening = el.filterPanel.hidden;
  el.filterPanel.hidden = !opening;
  el.toggleFilters.setAttribute('aria-expanded', String(opening));
});

el.resetFilters.addEventListener('click', resetAllFilters);

el.viewSelect.addEventListener('change', () => {
  resetDeleteConfirmation();
  const id = el.viewSelect.value || null;
  // Loading a view is a newer, complete filter intent. It must not be followed
  // by a search debounce that was scheduled from the view being replaced.
  nextFilterIntent();
  queuePortfolioUpdate(async () => {
    state.portfolioViews = await activateSavedPortfolioView(id);
    closeViewEditor();
    render();
    await syncLegacyFilterSettings(state.portfolioViews.active);
    announce(
      state.portfolioViews.activeViewId
        ? `Loaded ${el.viewSelect.selectedOptions[0]?.textContent || 'saved view'}.`
        : 'Using a custom portfolio view.',
    );
  }).catch(async (error) => {
    state.portfolioViews = await getPortfolioViewState();
    render();
    announce(error.message || 'Could not load that saved view.');
  });
});

el.saveView.addEventListener('click', () => openViewEditor('save'));
el.renameView.addEventListener('click', () => openViewEditor('rename'));
el.cancelView.addEventListener('click', closeViewEditor);

el.viewName.addEventListener('input', () => el.viewName.setCustomValidity(''));
el.viewEditor.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = el.viewName.value;
  const mode = viewEditorMode;
  queuePortfolioUpdate(async () => {
    if (mode === 'rename') {
      await createUndoSnapshot('portfolio-view-change', [STORAGE_KEYS.portfolioViews]);
      state.portfolioViews = await renameSavedPortfolioView(
        state.portfolioViews.activeViewId,
        name,
      );
      await updateUndoAvailability();
      announce('Saved view renamed. Undo is available for 10 minutes.');
    } else {
      state.portfolioViews = await saveCurrentPortfolioView(name);
      announce('Portfolio view saved.');
    }
    closeViewEditor();
    render();
  }).catch((error) => {
    el.viewName.setCustomValidity(error.message || 'Could not save that view.');
    el.viewName.reportValidity();
  });
});

let deleteViewArmedUntil = 0;
let deleteViewResetTimer;

function resetDeleteConfirmation() {
  deleteViewArmedUntil = 0;
  clearTimeout(deleteViewResetTimer);
  el.deleteView.classList.remove('confirming');
  el.deleteView.textContent = 'Delete';
}

el.deleteView.addEventListener('click', () => {
  const id = state.portfolioViews.activeViewId;
  const name = state.portfolioViews.views.find((view) => view.id === id)?.name;
  if (!id) return;
  if (Date.now() > deleteViewArmedUntil) {
    deleteViewArmedUntil = Date.now() + 8000;
    el.deleteView.classList.add('confirming');
    el.deleteView.textContent = 'Confirm delete';
    announce(
      `${name || 'Saved view'} will be deleted. Activate again within 8 seconds to confirm.`,
    );
    deleteViewResetTimer = setTimeout(resetDeleteConfirmation, 8000);
    return;
  }
  resetDeleteConfirmation();
  queuePortfolioUpdate(async () => {
    await createUndoSnapshot('portfolio-view-change', [STORAGE_KEYS.portfolioViews]);
    state.portfolioViews = await deleteSavedPortfolioView(id);
    closeViewEditor();
    render();
    await updateUndoAvailability();
    announce(`${name || 'Saved view'} deleted. Undo is available for 10 minutes.`);
  }).catch((error) => announce(error.message || 'Could not delete that saved view.'));
});

// A committed value, not a keystroke: retyping "30" as "3" then "0" must not
// render a three-day comparison in between.
el.trendCustomDays.addEventListener('change', () => {
  const retained = historyRetainedDays(state.history);
  const requested = Number.parseInt(el.trendCustomDays.value, 10);
  const clamped = Math.min(Math.max(Number.isFinite(requested) ? requested : 2, 2), Math.max(2, retained));
  const adjusted = clamped !== requested;
  state.trendCustomDays = clamped;
  el.trendCustomDays.value = String(clamped);
  render();
  announce(
    adjusted
      ? `Only ${retained} days are retained. Comparing against ${clamped} days.`
      : `Repository changes now compare against ${clamped} days.`,
  );
});

el.trendRange.addEventListener('change', () => {
  state.trendRange = el.trendRange.value;
  if (state.trendRange === 'custom') {
    const retained = historyRetainedDays(state.history);
    state.trendCustomDays = Math.min(state.trendCustomDays, Math.max(2, retained));
  }
  trendRangeFellBack = false;
  render();
  // The range the user picked is no longer retained; `syncControls` already
  // moved the control and said so. Repeating the ordinary sentence over it
  // would claim a comparison that is not what is on screen.
  if (trendRangeFellBack) return;
  const label = trendRangeLabel();
  // The quality notes already carry the coverage sentence; reuse it so the
  // spoken and visible explanations cannot drift apart.
  // The coverage sentence is appended last and only exists for a day range.
  const coverage =
    state.trendRange === 'baseline'
      ? ''
      : [...el.quality.children].at(-1)?.textContent || '';
  announce(`Repository changes now compare against ${label}. ${coverage}`.trim());
});
el.acknowledgeLifecycle.addEventListener('click', async () => {
  const ids = (state.cache?.lifecycleEvents || []).map((event) => event.id);
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'acknowledge-lifecycle',
      ids,
    });
    if (!response?.ok) throw new Error(response?.error?.message || 'StarBoard could not update.');
    state.cache = response.cache;
    render();
    announce('Repository changes dismissed.');
  } catch (error) {
    // Silence here left the button looking broken with no explanation.
    announce(`Could not acknowledge those changes. ${sentence(error.message)}`);
  }
});
el.acknowledgeAlerts.addEventListener('click', async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'acknowledge-notifications' });
    if (!response?.ok) throw new Error(response?.error?.message || 'StarBoard could not update.');
    state.notificationState = response.state;
    render();
    announce('Recent alerts dismissed.');
  } catch (error) {
    announce(`Could not dismiss recent alerts. ${sentence(error.message)}`);
  }
});
el.undo.addEventListener('click', async () => {
  el.undo.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'undo' });
    if (!response?.ok) {
      el.undo.hidden = true;
      announce(response?.error?.message || 'Undo is no longer available.');
      return;
    }
    state.cache = response.restored.cache;
    state.movement = new Set();
    state.baseline = response.restored.baseline;
    state.history = response.restored.history || state.history;
    state.notificationState = response.restored.notificationState || state.notificationState;
    state.settings = response.restored.settings || state.settings;
    state.portfolioViews =
      response.restored.portfolioViews ||
      (await getPortfolioViewState().catch(() => state.portfolioViews));
    applyTheme(state.settings.theme);
    render();
    el.undo.hidden = true;
    announce('Last data action undone.');
  } catch (error) {
    announce(`Could not undo the last data action. ${sentence(error.message)}`);
  } finally {
    el.undo.disabled = false;
  }
});

// Connectivity is a render input, not an error: dropping offline swaps the
// banner without discarding the cached snapshot, and reconnecting refreshes.
window.addEventListener('offline', () => {
  if (!bootReady) return;
  renderBanner();
  announce('You are offline. StarBoard is showing its stored snapshot.');
});
window.addEventListener('online', () => {
  if (!bootReady) return;
  renderBanner();
  announce('Back online. Refreshing.');
  doRefresh();
});

/* ---------- boot ---------- */

(async function init() {
  try {
    [
      state.settings,
      state.cache,
      state.baseline,
      state.history,
      state.notificationState,
      state.portfolioViews,
    ] = await Promise.all([
      getSettings(),
      getCache(),
      getBaseline(),
      getHistory(),
      getNotificationState(),
      getPortfolioViewState(),
    ]);
    state.movement = movementFor(state.cache);
    // Read this after the records: one of those reads may have just restored
    // or reset an invalid envelope and written the notice we need to show.
    state.storageRecoveryNotice = await getStorageRecoveryNotice();
    state.privacyNotice = await getPrivacyNotice();
  } catch (error) {
    // Without settings there is nothing to render. Say so rather than leaving
    // the static "Loading…" markup on screen with every control disabled.
    const newerSchema = error?.code === 'STORAGE_VERSION_TOO_NEW';
    applyTheme('dark');
    el.login.textContent = 'StarBoard';
    el.subline.textContent = newerSchema
      ? 'A newer StarBoard version is required'
      : 'Could not read local data';
    showBanner(
      newerSchema
        ? sentence(error.message)
        : `StarBoard could not read its local data. ${sentence(error?.message || '')}`.trim(),
      { label: 'Reload', onClick: () => location.reload() },
    );
    renderEmpty(
      newerSchema ? 'Newer StarBoard data detected' : 'Local data could not be read',
      newerSchema
        ? 'This build left your data untouched. Update or restore the newer StarBoard version, then reload.'
        : 'Your stored snapshot may be corrupt. Reload to retry, or clear StarBoard data from Settings.',
      newerSchema
        ? { label: 'Reload', onClick: () => location.reload() }
        : { label: 'Open settings', onClick: () => chrome.runtime.openOptionsPage() },
    );
    return;
  }

  applyTheme(state.settings.theme);
  el.trendRange.value = state.trendRange;

  render();
  bootReady = true;
  // Undo availability is a convenience. A worker that is still starting up
  // must never prevent the refresh below from running.
  await updateUndoAvailability().catch(() => {});
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

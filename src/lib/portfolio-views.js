/**
 * Saved portfolio views and repository filtering.
 *
 * View state is deliberately separate from account/settings state: it is
 * portable, bounded, contains no credentials, and can be restored atomically.
 */

export const PORTFOLIO_VIEW_FORMAT_VERSION = 1;
export const MAX_SAVED_VIEWS = 12;
export const MAX_REPOSITORY_LABELS = 1000;
export const MAX_LABELS_PER_REPOSITORY = 12;
export const MAX_LABEL_LENGTH = 32;
export const MAX_COMPARISON_REPOSITORIES = 8;
export const NO_LANGUAGE = '__none__';

export const DEFAULT_PORTFOLIO_FILTERS = Object.freeze({
  query: '',
  sortKey: 'stars',
  language: 'all',
  visibility: 'all',
  forkStatus: 'sources',
  archivedStatus: 'all',
  precision: 'all',
  lifecycle: 'all',
  activity: 'all',
  label: 'all',
});

const VALUES = Object.freeze({
  sortKey: new Set(['stars', 'starsDelta', 'forks', 'forksDelta', 'updated', 'name']),
  visibility: new Set(['all', 'public', 'private']),
  forkStatus: new Set(['all', 'sources', 'forks']),
  archivedStatus: new Set(['all', 'active', 'archived']),
  precision: new Set(['all', 'exact', 'approximate']),
  lifecycle: new Set(['all', 'changed', 'added', 'renamed', 'unchanged']),
  activity: new Set(['all', '30', '90', '365', 'stale', 'unknown']),
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function repositoryLabelKey(repo) {
  const id = String(repo?.id ?? '').trim();
  return /^\d+$/.test(id) ? `id:${id}` : `name:${repo?.full_name || ''}`;
}

function normalizedLabels(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : [])
    .map((label) => cleanText(label, MAX_LABEL_LENGTH).trim())
    .filter((label) => {
      const folded = label.toLocaleLowerCase('en-US');
      if (!label || seen.has(folded)) return false;
      seen.add(folded);
      return true;
    })
    .slice(0, MAX_LABELS_PER_REPOSITORY);
}

export function normalizeRepositoryLabels(value = {}) {
  const labels = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return labels;
  for (const [key, list] of Object.entries(value).slice(0, MAX_REPOSITORY_LABELS)) {
    if (typeof key !== 'string' || key.length < 3 || key.length > 240) continue;
    const clean = normalizedLabels(list);
    if (clean.length) labels[key] = clean;
  }
  return labels;
}

export function normalizeComparisonKeys(value = []) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((key) => typeof key === 'string' && key.length >= 3 && key.length <= 240)
      .slice(0, MAX_COMPARISON_REPOSITORIES),
  )];
}

export function validateComparisonKeys(value = []) {
  assert(Array.isArray(value) && value.length <= MAX_COMPARISON_REPOSITORIES, 'too many comparison repositories');
  const seen = new Set();
  for (const key of value) {
    assert(typeof key === 'string' && key.length >= 3 && key.length <= 240, 'invalid comparison repository key');
    assert(!seen.has(key), 'duplicate comparison repository key');
    seen.add(key);
  }
  return value;
}

export function validateRepositoryLabels(value = {}) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'invalid repository labels');
  const keys = Object.keys(value);
  assert(keys.length <= MAX_REPOSITORY_LABELS, 'too many repository labels');
  for (const key of keys) {
    assert(typeof key === 'string' && key.length >= 3 && key.length <= 240, 'invalid repository label key');
    assert(Array.isArray(value[key]) && value[key].length <= MAX_LABELS_PER_REPOSITORY, 'invalid repository labels');
    const seen = new Set();
    for (const label of value[key]) {
      assert(typeof label === 'string' && label === label.trim() && label.length > 0 && label.length <= MAX_LABEL_LENGTH, 'invalid repository label');
      const folded = label.toLocaleLowerCase('en-US');
      assert(!seen.has(folded), 'duplicate repository label');
      seen.add(folded);
    }
  }
  return value;
}

export function normalizePortfolioFilters(value = {}) {
  /** @type {any} */
  const next = { ...DEFAULT_PORTFOLIO_FILTERS };
  next.query = cleanText(value.query, 200);
  next.language =
    typeof value.language === 'string' && value.language.length <= 100
      ? value.language
      : 'all';
  next.label = cleanText(value.label, MAX_LABEL_LENGTH) || 'all';
  for (const key of [
    'sortKey',
    'visibility',
    'forkStatus',
    'archivedStatus',
    'precision',
    'lifecycle',
    'activity',
  ]) {
    next[key] = VALUES[key].has(value[key]) ? value[key] : DEFAULT_PORTFOLIO_FILTERS[key];
  }
  validatePortfolioFilters(next);
  return next;
}

export function validatePortfolioFilters(filters) {
  assert(filters && typeof filters === 'object' && !Array.isArray(filters), 'invalid portfolio filters');
  assert(typeof filters.query === 'string' && filters.query.length <= 200, 'invalid view query');
  assert(
    typeof filters.language === 'string' && filters.language.length <= 100,
    'invalid language filter',
  );
  if (filters.label !== undefined) {
    assert(
      typeof filters.label === 'string' && filters.label.length <= MAX_LABEL_LENGTH,
      'invalid label filter',
    );
  }
  for (const key of Object.keys(VALUES)) {
    assert(VALUES[key].has(filters[key]), `invalid ${key} filter`);
  }
  return filters;
}

export function emptyPortfolioViewState(filters = {}) {
  return {
    formatVersion: PORTFOLIO_VIEW_FORMAT_VERSION,
    activeViewId: null,
    active: normalizePortfolioFilters(filters),
    views: [],
    labels: {},
    comparisonKeys: [],
  };
}

export function validatePortfolioViewState(state) {
  assert(state && typeof state === 'object' && !Array.isArray(state), 'invalid portfolio view state');
  assert(
    state.formatVersion === PORTFOLIO_VIEW_FORMAT_VERSION,
    'unsupported portfolio view state',
  );
  assert(
    state.activeViewId == null ||
      (typeof state.activeViewId === 'string' && state.activeViewId.length <= 80),
    'invalid active view',
  );
  validatePortfolioFilters(state.active);
  if (state.labels !== undefined) validateRepositoryLabels(state.labels);
  if (state.comparisonKeys !== undefined) validateComparisonKeys(state.comparisonKeys);
  assert(Array.isArray(state.views) && state.views.length <= MAX_SAVED_VIEWS, 'too many saved views');
  const ids = new Set();
  const names = new Set();
  for (const view of state.views) {
    assert(view && typeof view === 'object' && !Array.isArray(view), 'invalid saved view');
    assert(typeof view.id === 'string' && view.id.length > 0 && view.id.length <= 80, 'invalid view id');
    assert(!ids.has(view.id), 'duplicate view id');
    ids.add(view.id);
    assert(
      typeof view.name === 'string' &&
        view.name === view.name.trim() &&
        view.name.length > 0 &&
        view.name.length <= 40,
      'invalid view name',
    );
    const foldedName = view.name.toLocaleLowerCase('en-US');
    assert(!names.has(foldedName), 'duplicate view name');
    names.add(foldedName);
    validatePortfolioFilters(view.filters);
  }
  assert(
    state.activeViewId == null || ids.has(state.activeViewId),
    'active saved view does not exist',
  );
  return state;
}

function cloneState(state) {
  validatePortfolioViewState(state);
  const next = structuredClone(state);
  next.labels = normalizeRepositoryLabels(next.labels);
  next.comparisonKeys = normalizeComparisonKeys(next.comparisonKeys);
  return next;
}

function cleanName(name) {
  const value = cleanText(name, 40).trim();
  assert(value, 'View name is required.');
  return value;
}

function assertUniqueName(state, name, ignoredId = null) {
  const folded = name.toLocaleLowerCase('en-US');
  assert(
    !state.views.some(
      (view) =>
        view.id !== ignoredId && view.name.toLocaleLowerCase('en-US') === folded,
    ),
    'A view with this name already exists.',
  );
}

export function patchActivePortfolioFilters(state, patch) {
  const next = cloneState(state);
  next.active = normalizePortfolioFilters({ ...next.active, ...patch });
  next.activeViewId = null;
  validatePortfolioViewState(next);
  return next;
}

export function setRepositoryLabels(state, key, labels) {
  const next = cloneState(state);
  assert(typeof key === 'string' && key.length >= 3 && key.length <= 240, 'invalid repository label key');
  const clean = normalizedLabels(labels);
  if (clean.length) next.labels[key] = clean;
  else delete next.labels[key];
  validatePortfolioViewState(next);
  return next;
}

export function setComparisonRepositories(state, keys) {
  const next = cloneState(state);
  next.comparisonKeys = normalizeComparisonKeys(keys);
  validatePortfolioViewState(next);
  return next;
}

export function savePortfolioView(state, name, id) {
  const next = cloneState(state);
  assert(next.views.length < MAX_SAVED_VIEWS, `You can save at most ${MAX_SAVED_VIEWS} views.`);
  const clean = cleanName(name);
  assertUniqueName(next, clean);
  assert(typeof id === 'string' && id.length > 0 && id.length <= 80, 'invalid view id');
  assert(!next.views.some((view) => view.id === id), 'duplicate view id');
  next.views.push({
    id,
    name: clean,
    filters: structuredClone(next.active),
  });
  next.views.sort((a, b) => a.name.localeCompare(b.name));
  next.activeViewId = id;
  validatePortfolioViewState(next);
  return next;
}

export function renamePortfolioView(state, id, name) {
  const next = cloneState(state);
  const view = next.views.find((candidate) => candidate.id === id);
  assert(view, 'Saved view not found.');
  const clean = cleanName(name);
  assertUniqueName(next, clean, id);
  view.name = clean;
  next.views.sort((a, b) => a.name.localeCompare(b.name));
  validatePortfolioViewState(next);
  return next;
}

export function deletePortfolioView(state, id) {
  const next = cloneState(state);
  assert(next.views.some((view) => view.id === id), 'Saved view not found.');
  next.views = next.views.filter((view) => view.id !== id);
  if (next.activeViewId === id) next.activeViewId = null;
  validatePortfolioViewState(next);
  return next;
}

export function activatePortfolioView(state, id) {
  const next = cloneState(state);
  if (id == null || id === '') {
    next.activeViewId = null;
    return next;
  }
  const view = next.views.find((candidate) => candidate.id === id);
  assert(view, 'Saved view not found.');
  next.activeViewId = id;
  next.active = structuredClone(view.filters);
  validatePortfolioViewState(next);
  return next;
}

function lifecycleByRepository(events) {
  const byName = new Map();
  for (const event of events || []) {
    if ((event.type === 'added' || event.type === 'renamed') && event.to) {
      byName.set(event.to, event.type);
    }
  }
  return byName;
}

function pushedAt(repo) {
  const timestamp = Date.parse(repo.pushed_at || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

function activityMatches(repo, activity, now) {
  if (activity === 'all') return true;
  const pushed = pushedAt(repo);
  if (activity === 'unknown') return pushed == null;
  if (pushed == null) return false;
  const ageDays = Math.max(0, now - pushed) / 86_400_000;
  if (activity === 'stale') return ageDays > 365;
  return ageDays <= Number(activity);
}

export function filterRepositories(
  repositories,
  filters,
  lifecycleEvents = [],
  { now = Date.now(), labels = {} } = {},
) {
  const selected = normalizePortfolioFilters(filters);
  const query = selected.query.trim().toLocaleLowerCase();
  const changes = lifecycleByRepository(lifecycleEvents);
  return (repositories || []).filter((repo) => {
    if (selected.forkStatus === 'sources' && repo.fork) return false;
    if (selected.forkStatus === 'forks' && !repo.fork) return false;
    if (selected.archivedStatus === 'active' && repo.archived) return false;
    if (selected.archivedStatus === 'archived' && !repo.archived) return false;
    if (selected.visibility === 'public' && repo.private) return false;
    if (selected.visibility === 'private' && !repo.private) return false;
    if (selected.precision === 'exact' && repo.approx) return false;
    if (selected.precision === 'approximate' && !repo.approx) return false;
    if (selected.language === NO_LANGUAGE && repo.language) return false;
    if (
      selected.language !== 'all' &&
      selected.language !== NO_LANGUAGE &&
      repo.language !== selected.language
    ) {
      return false;
    }
    if (selected.label !== 'all') {
      const repositoryLabels = labels?.[repositoryLabelKey(repo)] || [];
      if (!repositoryLabels.includes(selected.label)) return false;
    }
    const lifecycle = changes.get(repo.full_name) || null;
    if (selected.lifecycle === 'changed' && !lifecycle) return false;
    if (selected.lifecycle === 'unchanged' && lifecycle) return false;
    if (
      (selected.lifecycle === 'added' || selected.lifecycle === 'renamed') &&
      lifecycle !== selected.lifecycle
    ) {
      return false;
    }
    if (!activityMatches(repo, selected.activity, now)) return false;
    if (!query) return true;
    return [repo.name, repo.full_name, repo.description, repo.language]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(query));
  });
}

export function activeAdvancedFilterCount(filters) {
  const selected = normalizePortfolioFilters(filters);
  return [
    'language',
    'visibility',
    'forkStatus',
    'archivedStatus',
    'precision',
    'lifecycle',
    'activity',
    'label',
  ].filter((key) => selected[key] !== DEFAULT_PORTFOLIO_FILTERS[key]).length;
}

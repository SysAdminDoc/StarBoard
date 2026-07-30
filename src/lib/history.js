/**
 * StarBoard's bounded, local-only daily history.
 *
 * History stores counts rather than full repository objects. Numeric API IDs
 * stay stable across renames; website rows fall back to their full name and
 * therefore remain explicit add/remove transitions.
 */

export const HISTORY_FORMAT_VERSION = 1;
export const HISTORY_RETENTION_DAYS = 365;
export const HISTORY_MAX_BYTES = 2 * 1024 * 1024;
const DAY_MS = 86_400_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function finiteCount(value, label) {
  assert(Number.isFinite(value) && value >= 0, `${label} must be a non-negative number`);
}

export function utcDay(timestamp = Date.now()) {
  const date = new Date(timestamp);
  assert(Number.isFinite(date.getTime()), 'invalid history timestamp');
  return date.toISOString().slice(0, 10);
}

export function repositoryHistoryKey(repo) {
  return typeof repo?.id === 'number' && Number.isFinite(repo.id)
    ? `id:${repo.id}`
    : `name:${repo?.full_name || ''}`;
}

export function emptyHistory() {
  return { formatVersion: HISTORY_FORMAT_VERSION, snapshots: [] };
}

export function validateHistory(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'history must be an object');
  assert(value.formatVersion === HISTORY_FORMAT_VERSION, 'unsupported history format');
  assert(Array.isArray(value.snapshots), 'history snapshots must be an array');

  const days = new Set();
  let previousDay = '';
  for (const snapshot of value.snapshots) {
    assert(
      snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot),
      'history snapshot must be an object',
    );
    assert(/^\d{4}-\d{2}-\d{2}$/.test(snapshot.day), 'invalid history day');
    assert(!days.has(snapshot.day), 'history contains more than one snapshot per UTC day');
    assert(!previousDay || snapshot.day > previousDay, 'history snapshots must be chronological');
    days.add(snapshot.day);
    previousDay = snapshot.day;
    finiteCount(snapshot.at, 'history timestamp');
    assert(['api', 'web'].includes(snapshot.source), 'invalid history source');
    assert(
      ['exact', 'approximate', 'partial', 'stale'].includes(snapshot.confidence),
      'invalid history confidence',
    );
    assert(Array.isArray(snapshot.repos), 'history repositories must be an array');
    const keys = new Set();
    for (const repo of snapshot.repos) {
      assert(repo && typeof repo === 'object' && !Array.isArray(repo), 'invalid history repo');
      assert(
        typeof repo.key === 'string' &&
          (repo.key.startsWith('id:') || repo.key.startsWith('name:')),
        'invalid history repository key',
      );
      assert(!keys.has(repo.key), 'duplicate repository point for one UTC day');
      keys.add(repo.key);
      assert(typeof repo.fullName === 'string' && repo.fullName.includes('/'), 'invalid history name');
      finiteCount(repo.stars, 'history stars');
      finiteCount(repo.forks, 'history forks');
      assert(typeof repo.private === 'boolean', 'invalid history visibility');
      assert(typeof repo.approximate === 'boolean', 'invalid history precision');
    }
  }
  return value;
}

export function historyByteSize(history) {
  return new TextEncoder().encode(JSON.stringify(history)).byteLength;
}

function snapshotFromCache(cache, now) {
  const repos = (cache.repos || [])
    .map((repo) => ({
      key: repositoryHistoryKey(repo),
      fullName: repo.full_name,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      private: !!repo.private,
      approximate: !!repo.approx,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const snapshot = {
    day: utcDay(now),
    at: now,
    source: cache.source === 'web' ? 'web' : 'api',
    confidence: ['exact', 'approximate', 'partial', 'stale'].includes(cache.confidence)
      ? cache.confidence
      : cache.approximate
        ? 'approximate'
        : 'exact',
    repos,
  };
  return snapshot;
}

export function recordDailyHistory(
  current,
  cache,
  {
    now = cache?.fetchedAt || Date.now(),
    retentionDays = HISTORY_RETENTION_DAYS,
    maxBytes = HISTORY_MAX_BYTES,
  } = {},
) {
  assert(cache?.repos && Array.isArray(cache.repos), 'cache repositories are required for history');
  assert(Number.isInteger(retentionDays) && retentionDays >= 1, 'invalid history retention');
  assert(Number.isFinite(maxBytes) && maxBytes > 0, 'invalid history byte cap');
  const existing = current ? structuredClone(current) : emptyHistory();
  validateHistory(existing);
  const nextSnapshot = snapshotFromCache(cache, now);
  const snapshots = existing.snapshots.filter((point) => point.day !== nextSnapshot.day);
  snapshots.push(nextSnapshot);
  snapshots.sort((a, b) => a.day.localeCompare(b.day));

  const todayStart = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
  const cutoff = utcDay(todayStart - (retentionDays - 1) * DAY_MS);
  const next = {
    formatVersion: HISTORY_FORMAT_VERSION,
    snapshots: snapshots.filter((point) => point.day >= cutoff),
  };

  while (next.snapshots.length > 1 && historyByteSize(next) > maxBytes) {
    next.snapshots.shift();
  }
  // A normal 1,500-repository snapshot is far below 2 MiB. This final guard
  // keeps the hard cap even for pathological imported names.
  while (
    next.snapshots.length === 1 &&
    next.snapshots[0].repos.length &&
    historyByteSize(next) > maxBytes
  ) {
    next.snapshots[0].repos.shift();
    next.snapshots[0].truncated = true;
  }

  validateHistory(next);
  assert(historyByteSize(next) <= maxBytes, 'history cannot fit within the configured cap');
  return next;
}

export function pruneHistory(current, keepDays, { now = Date.now() } = {}) {
  validateHistory(current);
  assert(Number.isInteger(keepDays) && keepDays >= 0, 'invalid prune range');
  if (keepDays === 0) return emptyHistory();
  const todayStart = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
  const cutoff = utcDay(todayStart - (keepDays - 1) * DAY_MS);
  return {
    formatVersion: HISTORY_FORMAT_VERSION,
    snapshots: current.snapshots.filter((point) => point.day >= cutoff),
  };
}

export function historyPointsForRepos(history, repos, days, { now = Date.now() } = {}) {
  if (!history?.snapshots?.length) return null;
  validateHistory(history);
  assert(Number.isInteger(days) && days >= 1, 'invalid trend range');
  const targetDay = utcDay(Date.parse(`${utcDay(now)}T00:00:00.000Z`) - days * DAY_MS);
  const pending = new Set(repos.map(repositoryHistoryKey));
  const points = new Map();
  for (let index = history.snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = history.snapshots[index];
    if (snapshot.day > targetDay) continue;
    for (const point of snapshot.repos) {
      if (!pending.has(point.key)) continue;
      points.set(point.key, { ...point, day: snapshot.day, at: snapshot.at });
      pending.delete(point.key);
    }
    if (!pending.size) break;
  }
  return points;
}

export function historyPointForRepo(history, repo, days, { now = Date.now() } = {}) {
  return (
    historyPointsForRepos(history, [repo], days, { now })?.get(repositoryHistoryKey(repo)) ||
    null
  );
}

export function historyStats(history) {
  const value = history || emptyHistory();
  validateHistory(value);
  return {
    days: value.snapshots.length,
    points: value.snapshots.reduce((total, snapshot) => total + snapshot.repos.length, 0),
    bytes: historyByteSize(value),
    oldestDay: value.snapshots[0]?.day || null,
    newestDay: value.snapshots.at(-1)?.day || null,
  };
}

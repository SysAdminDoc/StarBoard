/**
 * StarBoard's bounded, local-only daily history.
 *
 * Format 2 stores a repository dictionary once and one positional array of
 * counts per day, instead of repeating every repository's name and flags in
 * every daily snapshot. Format 1 did the latter and cost ~26 KB per day at 206
 * repositories, so the 2 MiB cap held about 78 days — the shipped 90-day trend
 * could not resolve for a normal portfolio, and pruning was silent. The same
 * portfolio now costs ~2 KB per day, so the documented 365 days fits with room
 * to spare.
 *
 * A missing repository on a given day is `null`, never `0`. The distinction is
 * load-bearing: `0` is a measured count, `null` means "not seen", and a delta
 * must never be computed across a gap.
 */

export const HISTORY_FORMAT_VERSION = 2;
export const HISTORY_RETENTION_DAYS = 365;
export const HISTORY_MAX_BYTES = 2 * 1024 * 1024;
const DAY_MS = 86_400_000;
const CONFIDENCE = ['exact', 'approximate', 'partial', 'stale'];

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
  return { formatVersion: HISTORY_FORMAT_VERSION, repos: [], snapshots: [] };
}

/** Rebuild the format-1 shape into the dictionary form. */
export function migrateHistoryToV2(legacy) {
  const index = new Map();
  const repos = [];
  for (const snapshot of legacy.snapshots || []) {
    for (const repo of snapshot.repos || []) {
      if (index.has(repo.key)) continue;
      index.set(repo.key, repos.length);
      repos.push([repo.key, repo.fullName, repo.private ? 1 : 0]);
    }
  }
  const snapshots = (legacy.snapshots || []).map((snapshot) => {
    const stars = new Array(repos.length).fill(null);
    const forks = new Array(repos.length).fill(null);
    const approx = [];
    for (const repo of snapshot.repos || []) {
      const at = index.get(repo.key);
      stars[at] = repo.stars;
      forks[at] = repo.forks;
      if (repo.approximate) approx.push(at);
    }
    return {
      day: snapshot.day,
      at: snapshot.at,
      source: snapshot.source,
      confidence: snapshot.confidence,
      stars,
      forks,
      approx,
    };
  });
  return { formatVersion: HISTORY_FORMAT_VERSION, repos, snapshots };
}

export function validateHistory(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'history must be an object');
  assert(value.formatVersion === HISTORY_FORMAT_VERSION, 'unsupported history format');
  assert(Array.isArray(value.repos), 'history repositories must be an array');
  assert(Array.isArray(value.snapshots), 'history snapshots must be an array');

  const keys = new Set();
  for (const entry of value.repos) {
    assert(Array.isArray(entry) && entry.length === 3, 'invalid history repository entry');
    const [key, fullName, isPrivate] = entry;
    assert(
      typeof key === 'string' && (key.startsWith('id:') || key.startsWith('name:')),
      'invalid history repository key',
    );
    assert(!keys.has(key), 'duplicate history repository');
    keys.add(key);
    assert(
      typeof fullName === 'string' && fullName.includes('/'),
      'invalid history repository name',
    );
    assert(isPrivate === 0 || isPrivate === 1, 'invalid history visibility');
  }

  const width = value.repos.length;
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
    assert(CONFIDENCE.includes(snapshot.confidence), 'invalid history confidence');
    assert(
      Array.isArray(snapshot.stars) && snapshot.stars.length === width,
      'history star row must align with the repository dictionary',
    );
    assert(
      Array.isArray(snapshot.forks) && snapshot.forks.length === width,
      'history fork row must align with the repository dictionary',
    );
    for (let i = 0; i < width; i += 1) {
      const star = snapshot.stars[i];
      const fork = snapshot.forks[i];
      // null is a gap, not a zero.
      assert(star === null || (Number.isFinite(star) && star >= 0), 'invalid history stars');
      assert(fork === null || (Number.isFinite(fork) && fork >= 0), 'invalid history forks');
      assert((star === null) === (fork === null), 'history gaps must cover both counts');
    }
    assert(Array.isArray(snapshot.approx), 'history approximation list must be an array');
    for (const at of snapshot.approx) {
      assert(
        Number.isInteger(at) && at >= 0 && at < width,
        'invalid history approximation index',
      );
    }
  }
  return value;
}

export function historyByteSize(history) {
  return new TextEncoder().encode(JSON.stringify(history)).byteLength;
}

/** Drop dictionary entries no retained day references, then reindex. */
function compactDictionary(history) {
  const used = new Set();
  for (const snapshot of history.snapshots) {
    for (let i = 0; i < snapshot.stars.length; i += 1) {
      if (snapshot.stars[i] !== null) used.add(i);
    }
  }
  if (used.size === history.repos.length) return history;
  const keep = [...used].sort((a, b) => a - b);
  const remap = new Map(keep.map((from, to) => [from, to]));
  return {
    formatVersion: HISTORY_FORMAT_VERSION,
    repos: keep.map((index) => history.repos[index]),
    snapshots: history.snapshots.map((snapshot) => ({
      ...snapshot,
      stars: keep.map((index) => snapshot.stars[index]),
      forks: keep.map((index) => snapshot.forks[index]),
      approx: snapshot.approx.map((index) => remap.get(index)).filter((v) => v !== undefined),
    })),
  };
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

  const index = new Map(existing.repos.map((entry, at) => [entry[0], at]));
  const repos = [...existing.repos];
  for (const repo of cache.repos) {
    const key = repositoryHistoryKey(repo);
    const isPrivate = repo.private ? 1 : 0;
    if (index.has(key)) {
      // Names change; keep the dictionary current so exports stay readable.
      repos[index.get(key)] = [key, repo.full_name, isPrivate];
      continue;
    }
    index.set(key, repos.length);
    repos.push([key, repo.full_name, isPrivate]);
  }

  const width = repos.length;
  const grow = (row) => {
    const next = row.slice();
    while (next.length < width) next.push(null);
    return next;
  };

  const day = utcDay(now);
  const stars = new Array(width).fill(null);
  const forks = new Array(width).fill(null);
  const approx = [];
  for (const repo of cache.repos) {
    const at = index.get(repositoryHistoryKey(repo));
    stars[at] = repo.stargazers_count;
    forks[at] = repo.forks_count;
    if (repo.approx) approx.push(at);
  }

  const snapshots = existing.snapshots
    .filter((point) => point.day !== day)
    .map((point) => ({ ...point, stars: grow(point.stars), forks: grow(point.forks) }));
  snapshots.push({
    day,
    at: now,
    source: cache.source === 'web' ? 'web' : 'api',
    confidence: CONFIDENCE.includes(cache.confidence)
      ? cache.confidence
      : cache.approximate
        ? 'approximate'
        : 'exact',
    stars,
    forks,
    approx: approx.sort((a, b) => a - b),
  });
  snapshots.sort((a, b) => a.day.localeCompare(b.day));

  const todayStart = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
  const cutoff = utcDay(todayStart - (retentionDays - 1) * DAY_MS);
  let next = compactDictionary({
    formatVersion: HISTORY_FORMAT_VERSION,
    repos,
    snapshots: snapshots.filter((point) => point.day >= cutoff),
  });

  // Oldest days go first. The dictionary is compacted alongside so a portfolio
  // that shrank does not keep paying for repositories no retained day mentions.
  while (next.snapshots.length > 1 && historyByteSize(next) > maxBytes) {
    next = compactDictionary({ ...next, snapshots: next.snapshots.slice(1) });
  }
  if (next.snapshots.length === 1 && historyByteSize(next) > maxBytes) {
    // Pathological single day: keep the day, shed repositories from the end.
    const only = next.snapshots[0];
    while (next.repos.length > 0 && historyByteSize(next) > maxBytes) {
      const keep = next.repos.length - 1;
      next = {
        formatVersion: HISTORY_FORMAT_VERSION,
        repos: next.repos.slice(0, keep),
        snapshots: [
          {
            ...only,
            stars: only.stars.slice(0, keep),
            forks: only.forks.slice(0, keep),
            approx: only.approx.filter((at) => at < keep),
            truncated: true,
          },
        ],
      };
      only.stars = next.snapshots[0].stars;
      only.forks = next.snapshots[0].forks;
      only.approx = next.snapshots[0].approx;
    }
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
  return compactDictionary({
    formatVersion: HISTORY_FORMAT_VERSION,
    repos: current.repos,
    snapshots: current.snapshots.filter((point) => point.day >= cutoff),
  });
}

/** Flatten to per-repository rows. Gaps are skipped, never emitted as zero. */
export function historyRows(history) {
  const value = history || emptyHistory();
  validateHistory(value);
  const rows = [];
  for (const snapshot of value.snapshots) {
    const approximate = new Set(snapshot.approx);
    for (let i = 0; i < value.repos.length; i += 1) {
      if (snapshot.stars[i] === null) continue;
      const [key, fullName, isPrivate] = value.repos[i];
      rows.push({
        key,
        fullName,
        private: isPrivate === 1,
        stars: snapshot.stars[i],
        forks: snapshot.forks[i],
        approximate: approximate.has(i),
        day: snapshot.day,
        at: snapshot.at,
        source: snapshot.source,
        confidence: snapshot.confidence,
      });
    }
  }
  return rows;
}

/** Keep only repositories the predicate accepts, then compact. */
export function filterHistoryRepositories(history, keep) {
  const value = history || emptyHistory();
  validateHistory(value);
  const kept = [];
  value.repos.forEach((entry, index) => {
    if (keep({ key: entry[0], fullName: entry[1], private: entry[2] === 1 })) kept.push(index);
  });
  const remap = new Map(kept.map((from, to) => [from, to]));
  return {
    formatVersion: HISTORY_FORMAT_VERSION,
    repos: kept.map((index) => value.repos[index]),
    snapshots: value.snapshots.map((snapshot) => ({
      ...snapshot,
      stars: kept.map((index) => snapshot.stars[index]),
      forks: kept.map((index) => snapshot.forks[index]),
      approx: snapshot.approx.map((index) => remap.get(index)).filter((v) => v !== undefined),
    })),
  };
}

export function historyPointsForRepos(history, repos, days, { now = Date.now() } = {}) {
  if (!history?.snapshots?.length) return null;
  validateHistory(history);
  assert(Number.isInteger(days) && days >= 1, 'invalid trend range');
  const targetDay = utcDay(Date.parse(`${utcDay(now)}T00:00:00.000Z`) - days * DAY_MS);
  const index = new Map(history.repos.map((entry, at) => [entry[0], at]));
  const pending = new Map();
  for (const repo of repos) {
    const key = repositoryHistoryKey(repo);
    if (index.has(key)) pending.set(key, index.get(key));
  }
  const points = new Map();
  for (let i = history.snapshots.length - 1; i >= 0 && pending.size; i -= 1) {
    const snapshot = history.snapshots[i];
    if (snapshot.day > targetDay) continue;
    const approximate = new Set(snapshot.approx);
    for (const [key, at] of [...pending]) {
      if (snapshot.stars[at] === null) continue;
      const [, fullName, isPrivate] = history.repos[at];
      points.set(key, {
        key,
        fullName,
        private: isPrivate === 1,
        stars: snapshot.stars[at],
        forks: snapshot.forks[at],
        approximate: approximate.has(at),
        day: snapshot.day,
        at: snapshot.at,
      });
      pending.delete(key);
    }
  }
  return points;
}

export function historyPointForRepo(history, repo, days, { now = Date.now() } = {}) {
  return (
    historyPointsForRepos(history, [repo], days, { now })?.get(repositoryHistoryKey(repo)) ||
    null
  );
}

/** The oldest day actually retained, so the UI can stop offering longer ranges. */
export function historyRetainedDays(history, { now = Date.now() } = {}) {
  const oldest = history?.snapshots?.[0]?.day;
  if (!oldest) return 0;
  const today = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
  const first = Date.parse(`${oldest}T00:00:00.000Z`);
  return Math.max(0, Math.round((today - first) / DAY_MS));
}

export function historyStats(history) {
  const value = history || emptyHistory();
  validateHistory(value);
  let points = 0;
  for (const snapshot of value.snapshots) {
    for (const star of snapshot.stars) if (star !== null) points += 1;
  }
  return {
    days: value.snapshots.length,
    points,
    bytes: historyByteSize(value),
    repositories: value.repos.length,
    oldestDay: value.snapshots[0]?.day || null,
    newestDay: value.snapshots.at(-1)?.day || null,
    retainedDays: historyRetainedDays(value),
  };
}

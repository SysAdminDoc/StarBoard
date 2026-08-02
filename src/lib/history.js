/**
 * StarBoard's bounded, local-only daily history.
 *
 * Format 3 stores a repository dictionary once and one positional array of
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

export const HISTORY_FORMAT_VERSION = 3;
export const HISTORY_RETENTION_DAYS = 365;
export const HISTORY_QUOTA_SHARE = 0.2;
export const HISTORY_FALLBACK_QUOTA_BYTES = 10 * 1024 * 1024;

/** Keep history proportional to the quota reported by the active storage area. */
export function historyMaxBytesForQuota(reportedQuotaBytes) {
  const quotaBytes =
    Number.isFinite(reportedQuotaBytes) && reportedQuotaBytes > 0
      ? Math.floor(reportedQuotaBytes)
      : HISTORY_FALLBACK_QUOTA_BYTES;
  return Math.max(1, Math.floor(quotaBytes * HISTORY_QUOTA_SHARE));
}

// Direct history helpers do not own a storage area, so they use Chrome's
// current 10 MiB default. Persisted refreshes pass the live reported quota.
export const HISTORY_MAX_BYTES = historyMaxBytesForQuota(HISTORY_FALLBACK_QUOTA_BYTES);
const DAY_MS = 86_400_000;
const CONFIDENCE = ['exact', 'approximate', 'partial', 'stale'];
const CONFIDENCE_SCORE = Object.freeze({
  stale: 0,
  partial: 1,
  approximate: 2,
  exact: 3,
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function finiteCount(value, label) {
  assert(Number.isFinite(value) && value >= 0, `${label} must be a non-negative number`);
}

function cacheConfidence(cache) {
  if (CONFIDENCE.includes(cache.confidence)) return cache.confidence;
  return cache.approximate ? 'approximate' : 'exact';
}

/** Merge two measurements for one UTC day without making the retained point poorer. */
function mergeSameDaySnapshot(previous, incoming) {
  if (CONFIDENCE_SCORE[incoming.confidence] < CONFIDENCE_SCORE[previous.confidence]) {
    return previous;
  }

  const stars = incoming.stars.slice();
  const forks = incoming.forks.slice();
  const approximate = new Set(incoming.approx);
  const previousApproximate = new Set(previous.approx);
  let retainedPreviousMeasurement = false;

  for (let i = 0; i < stars.length; i += 1) {
    if (stars[i] !== null || previous.stars[i] === null) continue;
    stars[i] = previous.stars[i];
    forks[i] = previous.forks[i];
    if (previousApproximate.has(i)) approximate.add(i);
    retainedPreviousMeasurement = true;
  }

  const confidence =
    retainedPreviousMeasurement &&
    CONFIDENCE_SCORE[previous.confidence] < CONFIDENCE_SCORE[incoming.confidence]
      ? previous.confidence
      : incoming.confidence;
  const merged = {
    ...incoming,
    confidence,
    stars,
    forks,
    approx: [...approximate].sort((a, b) => a - b),
  };
  if (retainedPreviousMeasurement && previous.truncated) merged.truncated = true;
  return merged;
}

export function utcDay(timestamp = Date.now()) {
  const date = new Date(timestamp);
  assert(Number.isFinite(date.getTime()), 'invalid history timestamp');
  return date.toISOString().slice(0, 10);
}

/**
 * The one identifier both data sources produce.
 *
 * Format 2 keyed API repositories on their numeric id and website repositories
 * on their name, so changing the source orphaned every series at once — the
 * new key space simply had no history in it. github.com never exposes the
 * numeric id, so the name is the only key that can survive a switch. Renames
 * are handled by re-keying the dictionary from the lifecycle events rather
 * than by choosing a rename-proof key that one source cannot supply.
 */
export function repositoryHistoryKey(repo) {
  return `name:${repo?.full_name || ''}`;
}

export function emptyHistory() {
  return { formatVersion: HISTORY_FORMAT_VERSION, repos: [], snapshots: [] };
}

/**
 * Collapse dictionary entries that now resolve to the same key.
 *
 * A day holds one measurement per repository, so when two slots merge only one
 * of them can hold a value for any given day; the first non-null wins and the
 * other is a no-op.
 */
function mergeByKey(repos, snapshots) {
  const index = new Map();
  const merged = [];
  const slotFor = [];
  for (const entry of repos) {
    const existingAt = index.get(entry[0]);
    if (existingAt !== undefined) {
      merged[existingAt] = entry;
      slotFor.push(existingAt);
      continue;
    }
    index.set(entry[0], merged.length);
    slotFor.push(merged.length);
    merged.push(entry);
  }
  if (merged.length === repos.length) return { repos: merged, snapshots };
  const nextSnapshots = snapshots.map((snapshot) => {
    const stars = new Array(merged.length).fill(null);
    const forks = new Array(merged.length).fill(null);
    const wasApproximate = new Set(snapshot.approx);
    const approx = new Set();
    for (let i = 0; i < repos.length; i += 1) {
      if (snapshot.stars[i] === null) continue;
      const at = slotFor[i];
      if (stars[at] !== null) continue;
      stars[at] = snapshot.stars[i];
      forks[at] = snapshot.forks[i];
      if (wasApproximate.has(i)) approx.add(at);
    }
    return { ...snapshot, stars, forks, approx: [...approx].sort((a, b) => a - b) };
  });
  return { repos: merged, snapshots: nextSnapshots };
}

/**
 * Move a format-2 dictionary onto name keys.
 *
 * `id:` entries already carry the repository's current full name, so the
 * rewrite is lossless. An account that had used both sources ends up with two
 * entries per repository, which merge into one series.
 */
export function rekeyHistoryByName(history) {
  const repos = (history?.repos || []).map(([, fullName, isPrivate]) => [
    `name:${fullName}`,
    fullName,
    isPrivate,
  ]);
  const merged = mergeByKey(repos, history?.snapshots || []);
  return {
    formatVersion: HISTORY_FORMAT_VERSION,
    repos: merged.repos,
    snapshots: merged.snapshots,
  };
}

/** Follow detected renames so a renamed repository keeps its series. */
function applyRenames(repos, snapshots, lifecycleEvents) {
  const moves = new Map();
  for (const event of lifecycleEvents || []) {
    if (event?.type !== 'renamed' || !event.from || !event.to) continue;
    moves.set(`name:${event.from}`, event.to);
  }
  if (!moves.size) return { repos, snapshots };
  let touched = false;
  const next = repos.map((entry) => {
    const to = moves.get(entry[0]);
    if (!to) return entry;
    touched = true;
    return [`name:${to}`, to, entry[2]];
  });
  if (!touched) return { repos, snapshots };
  return mergeByKey(next, snapshots);
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
  // Deliberately literal: this step only changes the shape. The schema chain
  // runs `rekeyHistoryByName` afterwards to reach the current format.
  return { formatVersion: 2, repos, snapshots };
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
      typeof key === 'string' && key.startsWith('name:'),
      'invalid history repository key',
    );
    assert(!keys.has(key), 'duplicate history repository');
    keys.add(key);
    assert(
      typeof fullName === 'string' && fullName.includes('/'),
      'invalid history repository name',
    );
    // One key space, derived from one field: a drifting pair is how a single
    // repository ends up with two series.
    assert(key === `name:${fullName}`, 'history repository key must match its name');
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
    validate = true,
  } = {},
) {
  assert(cache?.repos && Array.isArray(cache.repos), 'cache repositories are required for history');
  assert(Number.isInteger(retentionDays) && retentionDays >= 1, 'invalid history retention');
  assert(Number.isFinite(maxBytes) && maxBytes > 0, 'invalid history byte cap');
  const existing = current ? structuredClone(current) : emptyHistory();
  if (validate) validateHistory(existing);
  // An empty or degraded account walk contains no measurement to record. In
  // particular, it must never erase the only same-day point we already have.
  if (cache.repos.length === 0) return existing;

  // A rename changes the key, so the old series has to be carried across
  // before today's counts are placed, or the repository restarts from zero.
  // Lifecycle events remain in the cache until the user dismisses them, so an
  // event at or before the newest measurement has already been applied. Replaying
  // it would consume a different repository later created under the freed name.
  const newestMeasurementAt = existing.snapshots.reduce(
    (latest, snapshot) => Math.max(latest, snapshot.at),
    -Infinity,
  );
  const unappliedLifecycleEvents = (cache.lifecycleEvents || []).filter(
    (event) => Number.isFinite(event?.at) && event.at > newestMeasurementAt,
  );
  const carried = applyRenames(
    existing.repos,
    existing.snapshots,
    unappliedLifecycleEvents,
  );
  const index = new Map(carried.repos.map((entry, at) => [entry[0], at]));
  const repos = [...carried.repos];
  for (const repo of cache.repos) {
    const key = repositoryHistoryKey(repo);
    const isPrivate = repo.private ? 1 : 0;
    if (index.has(key)) {
      // Visibility changes; keep the dictionary current so exports stay honest.
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

  const carriedSnapshots = carried.snapshots.map((point) => ({
    ...point,
    stars: grow(point.stars),
    forks: grow(point.forks),
  }));
  const previousToday = carriedSnapshots.find((point) => point.day === day);
  const snapshots = carriedSnapshots.filter((point) => point.day !== day);
  const incoming = {
    day,
    at: now,
    source: cache.source === 'web' ? 'web' : 'api',
    confidence: cacheConfidence(cache),
    stars,
    forks,
    approx: approx.sort((a, b) => a - b),
  };
  snapshots.push(previousToday ? mergeSameDaySnapshot(previousToday, incoming) : incoming);
  snapshots.sort((a, b) => a.day.localeCompare(b.day));

  const todayStart = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
  const cutoff = utcDay(todayStart - (retentionDays - 1) * DAY_MS);
  let next = compactDictionary({
    formatVersion: HISTORY_FORMAT_VERSION,
    repos,
    snapshots: snapshots.filter((point) => point.day >= cutoff),
  });
  let bytes = historyByteSize(next);

  // Oldest days go first. The dictionary is compacted alongside so a portfolio
  // that shrank does not keep paying for repositories no retained day mentions.
  while (next.snapshots.length > 1 && bytes > maxBytes) {
    next = compactDictionary({ ...next, snapshots: next.snapshots.slice(1) });
    bytes = historyByteSize(next);
  }
  if (next.snapshots.length === 1 && bytes > maxBytes) {
    // Pathological single day: keep the day, shed repositories from the end.
    const only = next.snapshots[0];
    while (next.repos.length > 0 && bytes > maxBytes) {
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
      bytes = historyByteSize(next);
    }
  }

  if (validate) validateHistory(next);
  assert(bytes <= maxBytes, 'history cannot fit within the configured cap');
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
    // A range names one comparison day. Once that day is behind us, an older
    // measurement would be a real value with a false age label. History is
    // chronological, so no remaining snapshot can be eligible after this.
    if (snapshot.day < targetDay) break;
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

/**
 * Below this many measured points a line encodes nothing a reader can use — two
 * points only say "up or down" — so the caller shows the count instead.
 */
export const SPARKLINE_MIN_POINTS = 5;
/**
 * Prometheus's staleness discipline: a measurement is carried across a hole only
 * this wide. A longer hole splits the line into separate segments so three
 * missing weeks are never drawn as a trend through them.
 */
export const SPARKLINE_MAX_GAP_DAYS = 3;

/**
 * One repository's daily series across the trailing `days` window.
 *
 * Every day in the window gets an entry; days with no measurement carry
 * `value: null`. Nothing is interpolated and nothing is carried forward — that
 * decision belongs to the renderer, which splits the line instead.
 */
export function historySeriesForRepo(
  history,
  repo,
  days,
  { now = Date.now(), metric = 'stars', index = null } = {},
) {
  assert(Number.isInteger(days) && days >= 1, 'invalid trend range');
  assert(metric === 'stars' || metric === 'forks', 'invalid history metric');
  const key = repositoryHistoryKey(repo);
  const empty = {
    key,
    fullName: repo?.full_name || '',
    metric,
    days,
    from: null,
    to: null,
    values: [],
    measured: 0,
    gaps: days,
    first: null,
    firstDay: null,
    last: null,
    lastDay: null,
    delta: null,
    approximate: false,
  };
  if (!history?.snapshots?.length) return empty;
  // Callers rendering a whole board pass the shared index; a lone caller pays
  // one scan rather than one scan per row.
  const at = index
    ? index.get(key) ?? -1
    : history.repos.findIndex((entry) => entry[0] === key);
  if (at === -1) return empty;

  const todayStart = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
  const oldestDay = utcDay(todayStart - (days - 1) * DAY_MS);
  const measuredByDay = new Map();
  for (let i = history.snapshots.length - 1; i >= 0; i -= 1) {
    const snapshot = history.snapshots[i];
    if (snapshot.day < oldestDay) break;
    const value = snapshot[metric][at];
    if (value === null || value === undefined) continue;
    measuredByDay.set(snapshot.day, {
      value,
      approximate: snapshot.approx.includes(at),
    });
  }

  const values = [];
  let measured = 0;
  let first = null;
  let firstDay = null;
  let last = null;
  let lastDay = null;
  let approximate = false;
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = utcDay(todayStart - offset * DAY_MS);
    const point = measuredByDay.get(day) || null;
    values.push({ day, value: point ? point.value : null, approximate: !!point?.approximate });
    if (!point) continue;
    measured += 1;
    if (firstDay === null) {
      first = point.value;
      firstDay = day;
    }
    last = point.value;
    lastDay = day;
    approximate = approximate || point.approximate;
  }

  return {
    ...empty,
    from: values[0]?.day || null,
    to: values.at(-1)?.day || null,
    values,
    measured,
    gaps: days - measured,
    first,
    firstDay,
    last,
    lastDay,
    delta: first === null || last === null ? null : last - first,
    approximate,
  };
}

/**
 * Return only the comparison values needed to order a trend table.
 *
 * Sorting a large table should not allocate a complete day-by-day series for
 * every row that will be dropped by the 50-row display cap. The renderer uses
 * this cheap pass for ordering, then builds full series only for rows shown.
 */
export function historyDeltaForRepo(
  history,
  repo,
  days,
  { now = Date.now(), metric = 'stars', index = null } = {},
) {
  assert(Number.isInteger(days) && days >= 1, 'invalid trend range');
  assert(metric === 'stars' || metric === 'forks', 'invalid history metric');
  const key = repositoryHistoryKey(repo);
  const at = index
    ? index.get(key) ?? -1
    : history?.repos?.findIndex((entry) => entry[0] === key) ?? -1;
  if (at === -1 || !history?.snapshots?.length) {
    return { key, metric, days, first: null, last: null, delta: null, measured: 0, approximate: false };
  }
  const today = utcDay(now);
  const todayStart = Date.parse(`${today}T00:00:00.000Z`);
  const oldestDay = utcDay(todayStart - (days - 1) * DAY_MS);
  const measuredByDay = new Map();
  for (const snapshot of history.snapshots) {
    if (snapshot.day < oldestDay) continue;
    if (snapshot.day > today) break;
    const value = snapshot[metric][at];
    if (value === null || value === undefined) continue;
    measuredByDay.set(snapshot.day, {
      value,
      approximate: snapshot.approx.includes(at),
    });
  }
  const values = [...measuredByDay.values()];
  const first = values[0]?.value ?? null;
  const last = values.at(-1)?.value ?? null;
  return {
    key,
    metric,
    days,
    first,
    last,
    delta: first === null || last === null ? null : last - first,
    measured: values.length,
    approximate: values.some((point) => point.approximate),
  };
}

/** One key→slot map for a whole board render, so per-row reads stay linear. */
export function historyRepoIndex(history) {
  return new Map((history?.repos || []).map((entry, at) => [entry[0], at]));
}

/**
 * Contiguous runs of measured points, split wherever the hole between two
 * measurements exceeds `maxGapDays`. A run of one point is kept: the renderer
 * draws it as a dot rather than dropping a real measurement on the floor.
 */
export function sparklineSegments(values, { maxGapDays = SPARKLINE_MAX_GAP_DAYS } = {}) {
  const segments = [];
  let current = [];
  let lastIndex = -1;
  values.forEach((point, index) => {
    if (point.value === null) return;
    if (current.length && index - lastIndex > maxGapDays) {
      segments.push(current);
      current = [];
    }
    current.push({ ...point, index });
    lastIndex = index;
  });
  if (current.length) segments.push(current);
  return segments;
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

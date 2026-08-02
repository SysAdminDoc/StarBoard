import { repositoryHistoryKey } from './history.js';
import { formatters } from './i18n.js';

export const NOTIFICATION_FORMAT_VERSION = 1;
export const DEFAULT_NOTIFICATION_CONFIG = Object.freeze({
  enabled: false,
  portfolioMilestone: 100,
  repositoryMilestone: 10,
  portfolioDelta: 10,
  repositoryDelta: 3,
  quietStart: '22:00',
  quietEnd: '08:00',
  cooldownMinutes: 360,
});

const MAX_PENDING = 50;
const MAX_SEEN = 500;
// Bound to the extension UI language, not navigator.language: an OS
// notification showing `1,234` beside German text is the same defect as in the
// popup, just harder to notice.
const localeCount = (value) => formatters.number().format(value);

const SEEN_RETENTION_MS = 365 * 86_400_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function count(value, name, max = 1_000_000) {
  assert(Number.isInteger(value) && value >= 0 && value <= max, `invalid ${name}`);
}

function validTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function normalizeNotificationConfig(value = {}) {
  /** @type {any} */
  const config = {
    ...DEFAULT_NOTIFICATION_CONFIG,
    ...Object.fromEntries(
      Object.keys(DEFAULT_NOTIFICATION_CONFIG)
        .filter((key) => Object.hasOwn(value, key))
        .map((key) => [key, value[key]]),
    ),
  };
  config.enabled = !!config.enabled;
  for (const key of [
    'portfolioMilestone',
    'repositoryMilestone',
    'portfolioDelta',
    'repositoryDelta',
    'cooldownMinutes',
  ]) {
    config[key] = Number(config[key]);
  }
  validateNotificationConfig(config);
  return config;
}

export function validateNotificationConfig(config) {
  assert(config && typeof config === 'object' && !Array.isArray(config), 'invalid notification config');
  assert(typeof config.enabled === 'boolean', 'invalid notification enabled state');
  count(config.portfolioMilestone, 'portfolio milestone');
  count(config.repositoryMilestone, 'repository milestone');
  count(config.portfolioDelta, 'portfolio delta');
  count(config.repositoryDelta, 'repository delta');
  count(config.cooldownMinutes, 'notification cooldown', 10_080);
  assert(validTime(config.quietStart), 'invalid quiet-hours start');
  assert(validTime(config.quietEnd), 'invalid quiet-hours end');
  return config;
}

export function emptyNotificationState() {
  return {
    formatVersion: NOTIFICATION_FORMAT_VERSION,
    lastEvaluatedGeneration: null,
    pending: [],
    dropped: 0,
    seen: {},
    lastSentAt: 0,
  };
}

export function validateNotificationState(state) {
  assert(state && typeof state === 'object' && !Array.isArray(state), 'invalid notification state');
  assert(state.formatVersion === NOTIFICATION_FORMAT_VERSION, 'unsupported notification state');
  assert(
    state.lastEvaluatedGeneration == null ||
      typeof state.lastEvaluatedGeneration === 'string',
    'invalid notification generation',
  );
  assert(Array.isArray(state.pending) && state.pending.length <= MAX_PENDING, 'invalid pending alerts');
  const ids = new Set();
  for (const event of state.pending) {
    assert(event && typeof event === 'object' && !Array.isArray(event), 'invalid alert event');
    assert(typeof event.id === 'string' && event.id.length <= 240, 'invalid alert id');
    assert(!ids.has(event.id), 'duplicate pending alert');
    ids.add(event.id);
    assert(typeof event.title === 'string' && event.title.length <= 120, 'invalid alert title');
    assert(typeof event.message === 'string' && event.message.length <= 500, 'invalid alert message');
    assert(Number.isFinite(event.createdAt) && event.createdAt >= 0, 'invalid alert time');
    assert(
      event.notifiedAt == null ||
        (Number.isFinite(event.notifiedAt) && event.notifiedAt >= 0),
      'invalid alert notification time',
    );
  }
  count(state.dropped ?? 0, 'dropped alerts');
  assert(state.seen && typeof state.seen === 'object' && !Array.isArray(state.seen), 'invalid seen alerts');
  assert(Object.keys(state.seen).length <= MAX_SEEN, 'too many seen alerts');
  for (const [id, at] of Object.entries(state.seen)) {
    assert(id.length <= 240 && Number.isFinite(at) && at >= 0, 'invalid seen alert');
  }
  assert(Number.isFinite(state.lastSentAt) && state.lastSentAt >= 0, 'invalid last alert time');
  return state;
}

function milestoneEvent(prefix, previous, current, step, title, message, now) {
  if (!step || current <= previous) return null;
  const previousBand = Math.floor(previous / step);
  const currentBand = Math.floor(current / step);
  if (currentBand <= previousBand) return null;
  const crossed = currentBand * step;
  return {
    id: `${prefix}:milestone:${crossed}`,
    title,
    message: message(crossed),
    createdAt: now,
  };
}

function deltaEvent(prefix, delta, minimum, generation, title, message, now) {
  if (!minimum || delta < minimum) return null;
  return {
    id: `${prefix}:delta:${generation}`,
    title,
    message: message(delta),
    createdAt: now,
  };
}

function comparablePortfolio(cache, includeForks) {
  return (cache?.repos || []).filter((repo) => (includeForks || !repo.fork) && !repo.approx);
}

/**
 * @param {any} previous
 * @param {any} current
 * @param {any} config
 * @param {any} state
 * @param {any} [options]
 */
export function evaluateNotificationEvents(
  previous,
  current,
  config,
  state,
  { generation, includeForks = false, now = Date.now() } = {},
) {
  const normalized = normalizeNotificationConfig(config);
  const existing = state ? structuredClone(state) : emptyNotificationState();
  validateNotificationState(existing);
  assert(typeof generation === 'string' && generation, 'notification generation is required');
  if (
    !normalized.enabled ||
    !previous?.repos ||
    !current?.repos ||
    existing.lastEvaluatedGeneration === generation
  ) {
    return existing;
  }

  const candidates = [];
  const previousRepos = new Map(
    (previous.repos || []).map((repo) => [repositoryHistoryKey(repo), repo]),
  );
  const currentComparable = comparablePortfolio(current, includeForks);
  const previousComparable = comparablePortfolio(previous, includeForks);
  if (
    previous.confidence === 'exact' &&
    current.confidence === 'exact' &&
    previousComparable.length &&
    currentComparable.length
  ) {
    const before = previousComparable.reduce((total, repo) => total + repo.stargazers_count, 0);
    const after = currentComparable.reduce((total, repo) => total + repo.stargazers_count, 0);
    const gain = after - before;
    candidates.push(
      milestoneEvent(
        'portfolio',
        before,
        after,
        normalized.portfolioMilestone,
        'Portfolio milestone',
        (crossed) => `Your repositories reached ${localeCount(crossed)} stars.`,
        now,
      ),
      deltaEvent(
        'portfolio',
        gain,
        normalized.portfolioDelta,
        generation,
        'Portfolio growth',
        (delta) => `Your repositories gained ${localeCount(delta)} stars.`,
        now,
      ),
    );
  }

  for (const repo of current.repos) {
    if ((!includeForks && repo.fork) || repo.approx) continue;
    const before = previousRepos.get(repositoryHistoryKey(repo));
    if (!before || before.approx) continue;
    const gain = repo.stargazers_count - before.stargazers_count;
    const prefix = `repo:${repositoryHistoryKey(repo)}`;
    candidates.push(
      milestoneEvent(
        prefix,
        before.stargazers_count,
        repo.stargazers_count,
        normalized.repositoryMilestone,
        `${repo.name} milestone`,
        (crossed) => `${repo.full_name} reached ${localeCount(crossed)} stars.`,
        now,
      ),
      deltaEvent(
        prefix,
        gain,
        normalized.repositoryDelta,
        generation,
        `${repo.name} is moving`,
        (delta) => `${repo.full_name} gained ${localeCount(delta)} stars.`,
        now,
      ),
    );
  }

  const seen = Object.fromEntries(
    Object.entries(existing.seen)
      .filter(([, at]) => at >= now - SEEN_RETENTION_MS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SEEN),
  );
  const pendingIds = new Set(existing.pending.map((event) => event.id));
  const fresh = candidates
    .filter(Boolean)
    .filter((event) => !seen[event.id] && !pendingIds.has(event.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const combined = [...existing.pending, ...fresh];
  const dropped = Math.max(0, combined.length - MAX_PENDING);
  const next = {
    ...existing,
    lastEvaluatedGeneration: generation,
    pending: combined.slice(-MAX_PENDING),
    dropped: (existing.dropped || 0) + dropped,
    seen,
  };
  validateNotificationState(next);
  return next;
}

function minutes(value) {
  const [hours, mins] = value.split(':').map(Number);
  return hours * 60 + mins;
}

export function notificationAvailability(config, state, now = Date.now()) {
  const normalized = normalizeNotificationConfig(config);
  validateNotificationState(state);
  const date = new Date(now);
  const currentMinute = date.getHours() * 60 + date.getMinutes();
  const start = minutes(normalized.quietStart);
  const end = minutes(normalized.quietEnd);
  let quiet = false;
  let quietEndsAt = 0;
  if (start !== end) {
    quiet = start < end
      ? currentMinute >= start && currentMinute < end
      : currentMinute >= start || currentMinute < end;
    if (quiet) {
      const endDate = new Date(date);
      endDate.setHours(Math.floor(end / 60), end % 60, 0, 0);
      if (endDate.getTime() <= now) endDate.setDate(endDate.getDate() + 1);
      quietEndsAt = endDate.getTime();
    }
  }
  const cooldownEndsAt = state.lastSentAt
    ? state.lastSentAt + normalized.cooldownMinutes * 60_000
    : 0;
  const nextAt = Math.max(quietEndsAt, cooldownEndsAt);
  return { allowed: !quiet && cooldownEndsAt <= now, nextAt: nextAt > now ? nextAt : null };
}

export function markNotificationsNotified(state, ids, now = Date.now()) {
  validateNotificationState(state);
  const notified = new Set(ids);
  const next = {
    ...state,
    pending: state.pending.map((event) =>
      notified.has(event.id) ? { ...event, notifiedAt: now } : event,
    ),
    lastSentAt: now,
  };
  validateNotificationState(next);
  return next;
}

export function acknowledgeNotifications(state, ids = null, now = Date.now()) {
  validateNotificationState(state);
  const acknowledged = new Set(ids || state.pending.map((event) => event.id));
  const seen = { ...state.seen };
  for (const event of state.pending) {
    if (acknowledged.has(event.id)) seen[event.id] = now;
  }
  const next = {
    ...state,
    pending: state.pending.filter((event) => !acknowledged.has(event.id)),
    dropped: ids == null ? 0 : state.dropped || 0,
    seen: Object.fromEntries(
      Object.entries(seen)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_SEEN),
    ),
  };
  validateNotificationState(next);
  return next;
}

/**
 * StarBoard — versioned local state.
 *
 * Settings, cache, and baseline remain separately addressable, but every
 * persisted record is a validated schema envelope. Refresh results write the
 * cache and baseline together so the popup never observes mixed generations.
 */

import {
  emptyHistory,
  historyMaxBytesForQuota,
  migrateHistoryToV2,
  pruneHistory,
  rekeyHistoryByName,
  recordDailyHistory,
  validateHistory,
} from './history.js';
import {
  DEFAULT_NOTIFICATION_CONFIG,
  emptyNotificationState,
  normalizeNotificationConfig,
  validateNotificationConfig,
  validateNotificationState,
} from './notifications.js';
import {
  activatePortfolioView as activatePortfolioViewState,
  deletePortfolioView as deletePortfolioViewState,
  emptyPortfolioViewState,
  patchActivePortfolioFilters,
  renamePortfolioView as renamePortfolioViewState,
  savePortfolioView as savePortfolioViewState,
  validatePortfolioViewState,
} from './portfolio-views.js';

export const SCHEMA_VERSION = 6;
export const STORAGE_KEYS = Object.freeze({
  settings: 'settings',
  cache: 'cache',
  baseline: 'baseline',
  history: 'history',
  notificationConfig: 'notificationConfig',
  notificationState: 'notificationState',
  portfolioViews: 'portfolioViews',
  lastKnownGood: 'starboardLastKnownGood',
  quarantine: 'starboardQuarantine',
  undo: 'starboardUndo',
});
export const SESSION_TOKEN_KEY = 'starboardSessionToken';
export const UNDO_WINDOW_MS = 10 * 60_000;
const STORAGE_WRITE_LOCK = 'starboard-storage-write';

const RECORD_LABELS = Object.freeze({
  [STORAGE_KEYS.settings]: 'Settings',
  [STORAGE_KEYS.cache]: 'The repository snapshot',
  [STORAGE_KEYS.baseline]: 'The comparison baseline',
  [STORAGE_KEYS.history]: 'Trend history',
  [STORAGE_KEYS.notificationConfig]: 'Notification settings',
  [STORAGE_KEYS.notificationState]: 'Pending notifications',
  [STORAGE_KEYS.portfolioViews]: 'Saved views',
  [STORAGE_KEYS.lastKnownGood]: 'The recovery copy',
  [STORAGE_KEYS.quarantine]: 'The quarantine log',
  [STORAGE_KEYS.undo]: 'The undo snapshot',
  [SESSION_TOKEN_KEY]: 'The session token',
});

export class StorageVersionError extends Error {
  constructor(key, detectedVersion) {
    const label = RECORD_LABELS[key] || `Stored record “${key}”`;
    super(
      `${label} was written by storage schema v${detectedVersion}, but this ` +
        `StarBoard build only understands v${SCHEMA_VERSION}. Update or restore ` +
        'the newer StarBoard version; the stored data was left untouched.',
    );
    this.name = 'StorageVersionError';
    this.code = 'STORAGE_VERSION_TOO_NEW';
    this.key = key;
    this.detectedVersion = detectedVersion;
    this.supportedVersion = SCHEMA_VERSION;
  }
}

export const DEFAULTS = Object.freeze({
  username: '',
  token: '',
  tokenMode: 'session',
  dataSource: 'web',
  refreshMinutes: 720,
  baselineHours: 24,
  includeForks: false,
  includeArchived: true,
  sortKey: 'stars',
  badgeMode: 'stars',
  theme: 'dark',
  showFollowers: true,
  showDescriptions: true,
  showMetadata: true,
  showForkStats: true,
  showSourceStatus: true,
});

const VALID = Object.freeze({
  dataSource: new Set(['web', 'api']),
  sortKey: new Set(['stars', 'starsDelta', 'forks', 'forksDelta', 'updated', 'name']),
  badgeMode: new Set(['stars', 'delta', 'off']),
  theme: new Set(['dark', 'light', 'auto']),
  tokenMode: new Set(['session', 'persistent']),
});
const SETTINGS_KEYS = new Set(Object.keys(DEFAULTS));
const AREA = chrome.storage.local;
const SESSION_AREA = chrome.storage.session;

let writeQueue = Promise.resolve();
let quarantineQueue = Promise.resolve();
let storageLockQueue = Promise.resolve();

function serialized(work) {
  const result = writeQueue.then(work, work);
  writeQueue = result.catch(() => {});
  return result;
}

/** Serialize record commits across extension pages and the service worker. */
function storageLocked(work) {
  const run = () => {
    if (globalThis.navigator?.locks?.request) {
      return globalThis.navigator.locks.request(STORAGE_WRITE_LOCK, { mode: 'exclusive' }, work);
    }
    return work();
  };
  const result = storageLockQueue.then(run, run);
  storageLockQueue = result.catch(() => {});
  return result;
}

function copy(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeEnvelope(data, { generation = null, savedAt = Date.now() } = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt,
    generation,
    // chrome.storage clones at set() time. Callers already own fresh values,
    // so cloning here only serializes large cache/history records needlessly.
    data,
  };
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function rejectFutureSchema(key, raw) {
  if (
    isObject(raw) &&
    Number.isInteger(raw.schemaVersion) &&
    raw.schemaVersion > SCHEMA_VERSION
  ) {
    throw new StorageVersionError(key, raw.schemaVersion);
  }
}

function isVersionError(error) {
  return error?.code === 'STORAGE_VERSION_TOO_NEW';
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertFinite(value, name, { min = 0 } = {}) {
  assert(Number.isFinite(value) && value >= min, `${name} must be a finite number >= ${min}`);
}

const GITHUB_ORIGIN = 'https://github.com';
const GITHUB_ORIGINS = new Set([GITHUB_ORIGIN]);
const AVATAR_ORIGINS = new Set([GITHUB_ORIGIN, 'https://avatars.githubusercontent.com']);

function githubUrl(path) {
  const encoded = String(path || '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `${GITHUB_ORIGIN}/${encoded}`;
}

function allowlistedUrl(value, fallback, origins) {
  try {
    const parsed = new URL(String(value || ''));
    if (origins.has(parsed.origin)) return parsed.href;
  } catch {
    // Malformed input takes the same safe fallback as an off-origin URL.
  }
  return fallback;
}

/** Replace untrusted cache links with values derived from validated identities. */
function normalizeCacheUrls(value) {
  if (!isObject(value)) return value;
  const profile = isObject(value.profile) ? value.profile : {};
  const profileUrl = githubUrl(profile.login);
  return {
    ...value,
    profile: {
      ...profile,
      html_url: allowlistedUrl(profile.html_url, profileUrl, GITHUB_ORIGINS),
      // An absent avatar is a supported no-image state. Only a supplied but
      // unsafe URL needs replacing, otherwise fixtures/offline snapshots would
      // gain a network request they never contained.
      avatar_url: profile.avatar_url
        ? allowlistedUrl(profile.avatar_url, `${profileUrl}.png?size=80`, AVATAR_ORIGINS)
        : '',
    },
    repos: Array.isArray(value.repos)
      ? value.repos.map((repo) => ({
          ...repo,
          html_url: allowlistedUrl(
            repo?.html_url,
            githubUrl(repo?.full_name),
            GITHUB_ORIGINS,
          ),
        }))
      : value.repos,
  };
}

function inferLegacyVersion(key, data) {
  if (key !== STORAGE_KEYS.settings) return 1;
  if (!Object.hasOwn(data, 'dataSource')) return 1;
  if (!Object.hasOwn(data, 'showFollowers')) return 2;
  if (!Object.hasOwn(data, 'tokenMode')) return 3;
  return 4;
}

function migrateV1ToV2(key, value) {
  if (key !== STORAGE_KEYS.settings) return value;
  return {
    ...value,
    // StarBoard 1.0 profiles used the API. Preserve that established source.
    dataSource: 'api',
  };
}

function migrateV2ToV3(key, value) {
  if (key === STORAGE_KEYS.settings) {
    // The final normalization pass validates once after every migration step.
    return { ...DEFAULTS, ...value };
  }
  if (key === STORAGE_KEYS.cache) {
    const approximate = !!value.approximate || value.repos?.some((repo) => repo.approx);
    return {
      complete: true,
      partialReason: null,
      confidence: approximate ? 'approximate' : 'exact',
      stale: false,
      ...value,
    };
  }
  return value;
}

function migrateV3ToV4(key, value) {
  if (key !== STORAGE_KEYS.settings) return value;
  return {
    ...value,
    // Existing stored PATs must not disappear during upgrade. The settings
    // page labels this retained mode and lets the user move/forget it.
    tokenMode: value.token ? 'persistent' : 'session',
  };
}

function migrateV4ToV5(key, value) {
  if (key !== STORAGE_KEYS.history) return value;
  // Format 1 repeated every repository's name and flags in every daily
  // snapshot. Rebuild it into the dictionary form so retained history is not
  // silently capped at ~78 days.
  if (value?.formatVersion === 1) return migrateHistoryToV2(value);
  return value;
}

function migrateV5ToV6(key, value) {
  if (key !== STORAGE_KEYS.history) return value;
  // Format 2 keyed API repositories on their numeric id and website
  // repositories on their name, so switching source orphaned every series.
  // Name keys are the only ones both sources can produce.
  if (value?.formatVersion === 2) return rekeyHistoryByName(value);
  return value;
}

function validateSettings(value) {
  assert(isObject(value), 'settings must be an object');
  assert(typeof value.username === 'string' && value.username.length <= 100, 'invalid username');
  assert(typeof value.token === 'string', 'invalid token');
  assert(VALID.tokenMode.has(value.tokenMode), 'invalid token storage mode');
  assert(VALID.dataSource.has(value.dataSource), 'invalid data source');
  assertFinite(value.refreshMinutes, 'refreshMinutes');
  assertFinite(value.baselineHours, 'baselineHours');
  assert(VALID.sortKey.has(value.sortKey), 'invalid sort key');
  assert(VALID.badgeMode.has(value.badgeMode), 'invalid badge mode');
  assert(VALID.theme.has(value.theme), 'invalid theme');
  for (const key of [
    'includeForks',
    'includeArchived',
    'showFollowers',
    'showDescriptions',
    'showMetadata',
    'showForkStats',
    'showSourceStatus',
  ]) {
    assert(typeof value[key] === 'boolean', `${key} must be boolean`);
  }
}

function validateRepo(repo) {
  assert(isObject(repo), 'repository must be an object');
  assert(typeof repo.full_name === 'string' && repo.full_name.includes('/'), 'invalid repository name');
  assertFinite(repo.stargazers_count, 'repository stars');
  assertFinite(repo.forks_count, 'repository forks');
}

function validateCache(value) {
  assert(isObject(value), 'cache must be an object');
  assert(isObject(value.profile), 'cache profile must be an object');
  assert(typeof value.profile.login === 'string' && value.profile.login, 'cache profile login missing');
  assert(Array.isArray(value.repos), 'cache repositories must be an array');
  value.repos.forEach(validateRepo);
  assertFinite(value.fetchedAt, 'cache fetchedAt');
  if (value.confidence != null) {
    assert(
      ['exact', 'approximate', 'partial', 'stale'].includes(value.confidence),
      'invalid cache confidence',
    );
  }
  if (value.lifecycleEvents != null) {
    assert(Array.isArray(value.lifecycleEvents), 'cache lifecycle events must be an array');
    for (const event of value.lifecycleEvents) {
      assert(isObject(event) && typeof event.id === 'string', 'invalid lifecycle event');
      assert(
        ['added', 'removed', 'renamed'].includes(event.type),
        'invalid lifecycle event type',
      );
      assertFinite(event.at, 'lifecycle event timestamp');
    }
  }
}

function validateBaseline(value) {
  assert(isObject(value), 'baseline must be an object');
  assertFinite(value.at, 'baseline timestamp');
  assert(isObject(value.counts), 'baseline counts must be an object');
  for (const [name, counts] of Object.entries(value.counts)) {
    assert(name.includes('/'), 'invalid baseline repository name');
    assert(Array.isArray(counts) && counts.length >= 2, 'invalid baseline count tuple');
    assertFinite(counts[0], 'baseline stars');
    assertFinite(counts[1], 'baseline forks');
  }
}

function validateRecord(key, value) {
  if (key === STORAGE_KEYS.settings) validateSettings(value);
  else if (key === STORAGE_KEYS.cache) validateCache(value);
  else if (key === STORAGE_KEYS.baseline) validateBaseline(value);
  else if (key === STORAGE_KEYS.history) validateHistory(value);
  else if (key === STORAGE_KEYS.notificationConfig) validateNotificationConfig(value);
  else if (key === STORAGE_KEYS.notificationState) validateNotificationState(value);
  else if (key === STORAGE_KEYS.portfolioViews) validatePortfolioViewState(value);
  else throw new Error(`unknown storage record: ${key}`);
}

export function normalizeSettings(value, { validate = true } = {}) {
  const clean = {};
  for (const key of SETTINGS_KEYS) {
    if (Object.hasOwn(value, key)) clean[key] = value[key];
  }
  const next = { ...DEFAULTS, ...clean };
  next.username = String(next.username || '').trim().replace(/^@/, '').slice(0, 100);
  next.token = typeof next.token === 'string' ? next.token.trim() : '';
  next.refreshMinutes = Number(next.refreshMinutes);
  next.baselineHours = Number(next.baselineHours);
  if (next.dataSource === 'web' && next.refreshMinutes > 0 && next.refreshMinutes < 360) {
    next.refreshMinutes = 360;
  }
  if (validate) validateSettings(next);
  return next;
}

/**
 * Pure migration entry point used by runtime reads and fixture tests.
 * Legacy raw records are accepted; the returned value is always current
 * (`SCHEMA_VERSION`, currently 6).
 */
export function migrateRecord(key, raw, now = Date.now()) {
  assert(raw != null, `${key} is missing`);
  const wrapped =
    isObject(raw) && Number.isInteger(raw.schemaVersion) && Object.hasOwn(raw, 'data');
  let version = wrapped ? raw.schemaVersion : inferLegacyVersion(key, raw);
  let value = copy(wrapped ? raw.data : raw);
  assert(version >= 1, `unsupported ${key} schema v${version}`);
  if (version > SCHEMA_VERSION) throw new StorageVersionError(key, version);

  while (version < SCHEMA_VERSION) {
    if (version === 1) value = migrateV1ToV2(key, value);
    else if (version === 2) value = migrateV2ToV3(key, value);
    else if (version === 3) value = migrateV3ToV4(key, value);
    else if (version === 4) value = migrateV4ToV5(key, value);
    else if (version === 5) value = migrateV5ToV6(key, value);
    version += 1;
  }

  if (key === STORAGE_KEYS.cache) value = normalizeCacheUrls(value);

  if (key === STORAGE_KEYS.settings) {
    if (wrapped && raw.schemaVersion === SCHEMA_VERSION) {
      validateSettings(value);
      value = normalizeSettings(value, { validate: false });
    } else {
      value = normalizeSettings(value);
    }
  } else validateRecord(key, value);

  const generation = wrapped ? raw.generation ?? null : value.generation ?? null;
  const envelope = makeEnvelope(value, {
    generation,
    savedAt: wrapped && Number.isFinite(raw.savedAt) ? raw.savedAt : now,
  });
  // Deciding "did migration change anything?" by serializing the record twice
  // costs two full passes over a history that can reach 2 MiB, on every read.
  // A wrapped record already at the current schema ran no migration step, and
  // only cache and settings are rewritten afterwards, so for every other key
  // the answer is structurally no.
  const rewritable = key === STORAGE_KEYS.cache || key === STORAGE_KEYS.settings;
  const changed =
    !wrapped ||
    raw.schemaVersion !== SCHEMA_VERSION ||
    (rewritable && JSON.stringify(raw.data) !== JSON.stringify(envelope.data));
  return { envelope, changed };
}

export function recoveryStorageKey(key) {
  return `${STORAGE_KEYS.lastKnownGood}:${key}`;
}

function legacyRecoveryData(raw) {
  if (
    !isObject(raw) ||
    !Number.isInteger(raw.schemaVersion) ||
    raw.schemaVersion < 1 ||
    !isObject(raw.data)
  ) {
    return {};
  }
  return raw.data;
}

/** Read requested split recovery records and prepare a one-time legacy split. */
async function readRecoveryState(keys) {
  const requested = [...new Set(keys)].filter(
    (key) => !LAST_KNOWN_GOOD_EXCLUDED.has(key),
  );
  const requestedStorageKeys = requested.map(recoveryStorageKey);
  const initial = await AREA.get([STORAGE_KEYS.lastKnownGood, ...requestedStorageKeys]);
  const legacyRaw = initial[STORAGE_KEYS.lastKnownGood];
  const legacy = legacyRecoveryData(legacyRaw);
  const records = new Map();

  for (const key of requested) {
    const split = initial[recoveryStorageKey(key)];
    if (split != null) records.set(key, split);
    else if (Object.hasOwn(legacy, key)) records.set(key, legacy[key]);
  }

  const legacyEntries = Object.entries(legacy).filter(
    ([key]) => !LAST_KNOWN_GOOD_EXCLUDED.has(key),
  );
  const migrationWrites = {};
  if (legacyEntries.length) {
    const splitKeys = legacyEntries.map(([key]) => recoveryStorageKey(key));
    const existing = await AREA.get(splitKeys);
    for (const [key, envelope] of legacyEntries) {
      const splitKey = recoveryStorageKey(key);
      if (existing[splitKey] == null) migrationWrites[splitKey] = envelope;
    }
  }

  return {
    records,
    migrationWrites,
    legacyPresent: legacyRaw != null,
  };
}

async function readRecoveryRecord(key) {
  return (await readRecoveryState([key])).records.get(key);
}

function quarantineRecords(raw) {
  return isObject(raw) &&
    Number.isInteger(raw.schemaVersion) &&
    raw.schemaVersion >= 1 &&
    raw.schemaVersion <= SCHEMA_VERSION &&
    Array.isArray(raw.data?.records)
    ? raw.data.records
    : [];
}

function quarantine(key, raw, reason, outcome, writes = {}) {
  const work = async () => {
    const stored = (await AREA.get(STORAGE_KEYS.quarantine))[STORAGE_KEYS.quarantine];
    rejectFutureSchema(STORAGE_KEYS.quarantine, stored);
    const records = quarantineRecords(stored);
    const at = Date.now();
    const notice = {
      id: `${at}:${key}:${crypto.randomUUID()}`,
      key,
      label: RECORD_LABELS[key] || key,
      at,
      reason: String(reason || 'invalid record').slice(0, 240),
      outcome,
      acknowledgedAt: null,
      detectedSchema: Number.isInteger(raw?.schemaVersion) ? raw.schemaVersion : null,
    };
    await commit({
      ...writes,
      [STORAGE_KEYS.quarantine]: makeEnvelope({
        records: [...records.slice(-9), notice],
      }),
    });
    return copy(notice);
  };
  const result = quarantineQueue.then(work, work);
  quarantineQueue = result.catch(() => {});
  return result;
}

export async function getStorageRecoveryNotice() {
  const raw = (await AREA.get(STORAGE_KEYS.quarantine))[STORAGE_KEYS.quarantine];
  rejectFutureSchema(STORAGE_KEYS.quarantine, raw);
  const notice = [...quarantineRecords(raw)]
    .reverse()
    .find((record) =>
      !record.acknowledgedAt && ['restored', 'reset'].includes(record.outcome),
    );
  return notice ? copy(notice) : null;
}

export async function dismissStorageRecoveryNotice(id) {
  return serialized(async () => {
    const raw = (await AREA.get(STORAGE_KEYS.quarantine))[STORAGE_KEYS.quarantine];
    rejectFutureSchema(STORAGE_KEYS.quarantine, raw);
    const records = quarantineRecords(raw);
    let dismissed = false;
    const next = records.map((record) => {
      if (record.id !== id || record.acknowledgedAt) return record;
      dismissed = true;
      return { ...record, acknowledgedAt: Date.now() };
    });
    if (dismissed) {
      await commit({
        [STORAGE_KEYS.quarantine]: makeEnvelope({ records: next }),
      });
    }
    return dismissed;
  });
}

/**
 * History is by far the largest record and is the one thing that does not need
 * a shadow copy: it is append-only, derived from refreshes, and losing a day
 * degrades a trend rather than breaking the extension. Mirroring it would
 * double the single biggest consumer and defeat the quota-proportional cap.
 */
const LAST_KNOWN_GOOD_EXCLUDED = new Set([STORAGE_KEYS.history]);
const RECOVERY_RECORD_KEYS = Object.freeze([
  STORAGE_KEYS.settings,
  STORAGE_KEYS.cache,
  STORAGE_KEYS.baseline,
  STORAGE_KEYS.notificationConfig,
  STORAGE_KEYS.notificationState,
  STORAGE_KEYS.portfolioViews,
]);

const CONSUMER_LABELS = Object.freeze({
  [STORAGE_KEYS.history]: 'Trend history',
  [STORAGE_KEYS.cache]: 'The repository snapshot',
  [STORAGE_KEYS.baseline]: 'The comparison baseline',
  [STORAGE_KEYS.lastKnownGood]: 'The recovery copy',
  [STORAGE_KEYS.undo]: 'The undo snapshot',
  [STORAGE_KEYS.portfolioViews]: 'Saved views',
  [STORAGE_KEYS.quarantine]: 'The quarantine log',
});

export class StorageQuotaError extends Error {
  constructor(message, { largest = null, bytes = 0 } = {}) {
    super(message);
    this.name = 'StorageQuotaError';
    this.code = 'STORAGE_QUOTA_EXCEEDED';
    this.largest = largest;
    this.bytes = bytes;
  }
}

function isQuotaError(error) {
  return /quota/i.test(String(error?.message || error || ''));
}

async function largestConsumer() {
  const keys = [
    ...Object.values(STORAGE_KEYS),
    ...RECOVERY_RECORD_KEYS.map(recoveryStorageKey),
  ];
  const sizes = await Promise.all(
    keys.map(async (key) => {
      try {
        return [key, await AREA.getBytesInUse(key)];
      } catch {
        return [key, 0];
      }
    }),
  );
  sizes.sort((first, second) => second[1] - first[1]);
  return sizes[0] || [null, 0];
}

/**
 * Write through one place so a full disk produces an explanation the user can
 * act on rather than a bare "QUOTA_BYTES quota exceeded" surfacing as a
 * generic refresh failure.
 */
async function commit(writes) {
  // An older build must never replace a record whose shape it cannot know.
  // Recovery keys are independently versioned records; the legacy bag is only
  // excluded because it is removed after its one-time split migration.
  const guardedKeys = Object.keys(writes).filter((key) => key !== STORAGE_KEYS.lastKnownGood);
  if (guardedKeys.length) {
    const current = await AREA.get(guardedKeys);
    for (const key of guardedKeys) rejectFutureSchema(key, current[key]);
  }
  try {
    await AREA.set(writes);
  } catch (error) {
    if (!isQuotaError(error)) throw error;
    const [key, bytes] = await largestConsumer();
    const label = CONSUMER_LABELS[key] || 'Stored data';
    const size = bytes ? ` (${Math.round(bytes / 1024)} KB)` : '';
    throw new StorageQuotaError(
      `StarBoard is out of local storage, so nothing was changed. ${label}${size} is using the most space — prune trend history in Settings to free some.`,
      { largest: key, bytes },
    );
  }
}

/**
 * `validated` is set only by the migration write in `readRecord`, where
 * `migrateRecord` has already run the same check against the same value.
 * Validating a 365-day history twice per read is pure duplicated work.
 */
async function writeRecords(records, generation = null, { validated = false } = {}) {
  return storageLocked(async () => {
    const keys = Object.keys(records);
    const recovery = await readRecoveryState(keys);
    const writes = { ...recovery.migrationWrites };
    for (const [key, value] of Object.entries(records)) {
      // A missing or older primary can still have a newer recovery envelope.
      // Replacing that only surviving copy would be the same downgrade loss.
      rejectFutureSchema(key, recovery.records.get(key));
      if (!validated) validateRecord(key, value);
      const wrapped = makeEnvelope(value, { generation: generation ?? value.generation ?? null });
      writes[key] = wrapped;
      if (!LAST_KNOWN_GOOD_EXCLUDED.has(key)) writes[recoveryStorageKey(key)] = wrapped;
    }
    await commit(writes);
    if (recovery.legacyPresent) await AREA.remove(STORAGE_KEYS.lastKnownGood);
  });
}

async function removeRecoveryRecords(keys) {
  return storageLocked(async () => {
    const recovery = await readRecoveryState([]);
    const writes = { ...recovery.migrationWrites };
    const removals = [];
    for (const key of keys) {
      delete writes[recoveryStorageKey(key)];
      removals.push(recoveryStorageKey(key));
    }
    if (Object.keys(writes).length) await commit(writes);
    if (recovery.legacyPresent) removals.push(STORAGE_KEYS.lastKnownGood);
    if (removals.length) await AREA.remove(removals);
  });
}

async function restoreRecord(key, raw, reason) {
  const candidate = await readRecoveryRecord(key);
  if (candidate) {
    let envelope;
    try {
      ({ envelope } = migrateRecord(key, candidate));
    } catch (error) {
      if (isVersionError(error)) throw error;
      // The backup is also unusable; fall through to a clean record.
    }
    if (envelope) {
      const recovery = await quarantine(key, raw, reason, 'restored', { [key]: envelope });
      return { value: copy(envelope.data), recovery };
    }
  }
  const recovery = await quarantine(key, raw, reason, 'reset');
  await AREA.remove(key);
  return { value: null, recovery };
}

async function readRecord(key) {
  const raw = (await AREA.get(key))[key];
  if (raw == null) return null;
  let migrated;
  try {
    migrated = migrateRecord(key, raw);
  } catch (error) {
    if (isVersionError(error)) throw error;
    const restored = await restoreRecord(key, raw, error.message);
    return restored.value;
  }
  if (migrated.changed) {
    try {
      await writeRecords({ [key]: migrated.envelope.data }, null, { validated: true });
    } catch (error) {
      if (isVersionError(error)) throw error;
      const restored = await restoreRecord(
        key,
        raw,
        `migration write failed: ${error.message}`,
      );
      return restored.value;
    }
  }
  // `migrateRecord` already copied the value out of the raw record, and
  // `AREA.get` handed back a fresh structured clone before that. A third pass
  // here only re-serialized the whole record for the caller.
  return migrated.envelope.data;
}

/** Apply a theme to the current document. Pages default to dark markup-side. */
export function applyTheme(theme) {
  document.documentElement.classList.add('theme-switching');
  document.documentElement.dataset.theme = theme || DEFAULTS.theme;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => document.documentElement.classList.remove('theme-switching'));
  });
}

export async function getSettings() {
  const settings = await getStoredSettings();
  if (settings.tokenMode !== 'session') return settings;
  return { ...settings, token: await getSessionToken() };
}

async function getStoredSettings() {
  const settings = await readRecord(STORAGE_KEYS.settings);
  if (settings) return settings;
  const defaults = { ...DEFAULTS };
  await writeRecords({ [STORAGE_KEYS.settings]: defaults });
  return defaults;
}

export async function setSettings(patch) {
  return serialized(async () => {
    const current = await getStoredSettings();
    const currentSessionToken =
      current.tokenMode === 'session' ? await getSessionToken() : '';
    const requestedMode = patch.tokenMode || current.tokenMode;
    const effectiveToken =
      Object.hasOwn(patch, 'token')
        ? String(patch.token || '').trim()
        : current.tokenMode === 'session'
          ? currentSessionToken
          : current.token;

    if (requestedMode === 'session') {
      await setSessionToken(effectiveToken);
    } else {
      await SESSION_AREA.remove(SESSION_TOKEN_KEY);
    }

    const next = normalizeSettings({
      ...current,
      ...patch,
      tokenMode: requestedMode,
      token: requestedMode === 'persistent' ? effectiveToken : '',
    });
    await writeRecords({ [STORAGE_KEYS.settings]: next });
    return {
      ...copy(next),
      token: requestedMode === 'session' ? effectiveToken : next.token,
    };
  });
}

async function getSessionToken() {
  const raw = (await SESSION_AREA.get(SESSION_TOKEN_KEY))[SESSION_TOKEN_KEY];
  if (raw == null) return '';
  rejectFutureSchema(SESSION_TOKEN_KEY, raw);
  if (
    !isObject(raw) ||
    !Number.isInteger(raw.schemaVersion) ||
    raw.schemaVersion < 1 ||
    typeof raw.data?.token !== 'string'
  ) {
    await SESSION_AREA.remove(SESSION_TOKEN_KEY);
    return '';
  }
  return raw.data.token;
}

async function setSessionToken(token) {
  const stored = (await SESSION_AREA.get(SESSION_TOKEN_KEY))[SESSION_TOKEN_KEY];
  rejectFutureSchema(SESSION_TOKEN_KEY, stored);
  if (!token) {
    await SESSION_AREA.remove(SESSION_TOKEN_KEY);
    return;
  }
  await SESSION_AREA.set({
    [SESSION_TOKEN_KEY]: makeEnvelope({ token }),
  });
}

export async function forgetToken() {
  return serialized(async () => {
    await SESSION_AREA.remove(SESSION_TOKEN_KEY);
    const current = await getStoredSettings();
    const next = normalizeSettings({ ...current, token: '', tokenMode: 'session' });
    await writeRecords({ [STORAGE_KEYS.settings]: next });
    return copy(next);
  });
}

export async function getCache() {
  return readRecord(STORAGE_KEYS.cache);
}

export async function setCache(cache) {
  await serialized(() => writeRecords({ [STORAGE_KEYS.cache]: cache }, cache.generation));
}

export async function acknowledgeLifecycle(ids) {
  return serialized(async () => {
    const cache = await getCache();
    if (!cache) return null;
    const selected = new Set(ids || []);
    const lifecycleEvents = selected.size
      ? (cache.lifecycleEvents || []).filter((event) => !selected.has(event.id))
      : [];
    const next = { ...cache, lifecycleEvents };
    await writeRecords({ [STORAGE_KEYS.cache]: next }, next.generation);
    return next;
  });
}

export async function getBaseline() {
  return readRecord(STORAGE_KEYS.baseline);
}

export async function setBaseline(baseline) {
  await serialized(() =>
    writeRecords({ [STORAGE_KEYS.baseline]: baseline }, baseline.generation ?? null),
  );
}

export async function getHistory() {
  return (await readRecord(STORAGE_KEYS.history)) || emptyHistory();
}

export async function setHistory(history) {
  await serialized(() => writeRecords({ [STORAGE_KEYS.history]: history }));
}

export async function pruneStoredHistory(keepDays) {
  return serialized(async () => {
    const current = (await readRecord(STORAGE_KEYS.history)) || emptyHistory();
    await saveUndoSnapshotInternal('history-prune', [STORAGE_KEYS.history]);
    const history = pruneHistory(current, keepDays);
    await writeRecords({ [STORAGE_KEYS.history]: history });
    return history;
  });
}

export async function getNotificationConfig() {
  const stored = await readRecord(STORAGE_KEYS.notificationConfig);
  if (stored) return stored;
  const config = { ...DEFAULT_NOTIFICATION_CONFIG };
  await writeRecords({ [STORAGE_KEYS.notificationConfig]: config });
  return config;
}

export async function setNotificationConfig(patch) {
  return serialized(async () => {
    const current =
      (await readRecord(STORAGE_KEYS.notificationConfig)) ||
      { ...DEFAULT_NOTIFICATION_CONFIG };
    const config = normalizeNotificationConfig({ ...current, ...patch });
    await writeRecords({ [STORAGE_KEYS.notificationConfig]: config });
    return config;
  });
}

export async function getNotificationState() {
  return (await readRecord(STORAGE_KEYS.notificationState)) || emptyNotificationState();
}

export async function setNotificationState(state) {
  await serialized(() => writeRecords({ [STORAGE_KEYS.notificationState]: state }));
}

function portfolioViewDefaults(settings) {
  return emptyPortfolioViewState({
    sortKey: settings.sortKey,
    forkStatus: settings.includeForks ? 'all' : 'sources',
    archivedStatus: settings.includeArchived ? 'all' : 'active',
  });
}

async function readPortfolioViewsOrDefault() {
  const stored = await readRecord(STORAGE_KEYS.portfolioViews);
  if (stored) return stored;
  const settings = (await readRecord(STORAGE_KEYS.settings)) || { ...DEFAULTS };
  return portfolioViewDefaults(settings);
}

export async function getPortfolioViewState() {
  const stored = await readRecord(STORAGE_KEYS.portfolioViews);
  if (stored) return stored;
  const state = portfolioViewDefaults(await getSettings());
  await writeRecords({ [STORAGE_KEYS.portfolioViews]: state });
  return state;
}

function updatePortfolioViews(update) {
  return serialized(async () => {
    const current = await readPortfolioViewsOrDefault();
    const next = update(current);
    validatePortfolioViewState(next);
    await writeRecords({ [STORAGE_KEYS.portfolioViews]: next });
    return copy(next);
  });
}

export async function setActivePortfolioFilters(patch) {
  return updatePortfolioViews((state) => patchActivePortfolioFilters(state, patch));
}

export async function saveCurrentPortfolioView(name) {
  return updatePortfolioViews((state) =>
    savePortfolioViewState(state, name, crypto.randomUUID()),
  );
}

export async function renameSavedPortfolioView(id, name) {
  return updatePortfolioViews((state) => renamePortfolioViewState(state, id, name));
}

export async function deleteSavedPortfolioView(id) {
  return updatePortfolioViews((state) => deletePortfolioViewState(state, id));
}

export async function activateSavedPortfolioView(id) {
  return updatePortfolioViews((state) => activatePortfolioViewState(state, id));
}

export async function applyImportedState(input) {
  return serialized(async () => {
    assert(isObject(input), 'import records must be an object');
    const allowed = new Set([
      STORAGE_KEYS.settings,
      STORAGE_KEYS.cache,
      STORAGE_KEYS.baseline,
      STORAGE_KEYS.history,
      STORAGE_KEYS.notificationConfig,
      STORAGE_KEYS.portfolioViews,
    ]);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    assert(!unknown.length, `unsupported import records: ${unknown.join(', ')}`);
    assert(Object.hasOwn(input, STORAGE_KEYS.settings), 'import settings are required');

    const records = {};
    for (const [key, value] of Object.entries(input)) {
      const raw = makeEnvelope(value);
      records[key] = migrateRecord(key, raw).envelope.data;
    }
    assert(!records[STORAGE_KEYS.settings].token, 'imported settings may not contain a token');

    // A portable file never carries credentials. Preserve the current local
    // credential choice without copying it through the import message.
    const currentSettings = await getSettings();
    records[STORAGE_KEYS.settings] = normalizeSettings({
      ...records[STORAGE_KEYS.settings],
      tokenMode: currentSettings.tokenMode,
      token: currentSettings.tokenMode === 'persistent' ? currentSettings.token : '',
    });

    const keys = Object.keys(records);
    await saveUndoSnapshotInternal('backup-import', keys);
    const generation = `import-${Date.now().toString(36)}-${crypto.randomUUID()}`;
    if (records[STORAGE_KEYS.cache]) records[STORAGE_KEYS.cache].generation = generation;
    if (records[STORAGE_KEYS.baseline]) records[STORAGE_KEYS.baseline].generation = generation;
    await writeRecords(records, generation);
    return {
      settings: records[STORAGE_KEYS.settings],
      cache: records[STORAGE_KEYS.cache] || (await readRecord(STORAGE_KEYS.cache)),
      baseline: records[STORAGE_KEYS.baseline] || (await readRecord(STORAGE_KEYS.baseline)),
      history: records[STORAGE_KEYS.history] || (await readRecord(STORAGE_KEYS.history)),
      portfolioViews:
        records[STORAGE_KEYS.portfolioViews] ||
        (await readRecord(STORAGE_KEYS.portfolioViews)),
    };
  });
}

/** Reduce a repo list to the minimum needed to diff against later. */
export function snapshotOf(repos, { now = Date.now(), generation = null } = {}) {
  const counts = {};
  for (const repo of repos) {
    counts[repo.full_name] = [repo.stargazers_count, repo.forks_count];
  }
  return { at: now, counts, generation };
}

export function chooseBaseline(
  existing,
  repos,
  baselineHours,
  { rebase = false, now = Date.now(), generation = null } = {},
) {
  const aged =
    existing && baselineHours > 0 && now - existing.at > baselineHours * 3600_000;
  if (rebase || !existing || aged) return snapshotOf(repos, { now, generation });
  return { ...existing, generation };
}

export async function resolveBaseline(repos, baselineHours) {
  const existing = await getBaseline();
  const baseline = chooseBaseline(existing, repos, baselineHours);
  if (!existing || baseline.at !== existing.at) await setBaseline(baseline);
  return baseline;
}

export async function resetBaseline(repos) {
  const baseline = snapshotOf(repos);
  await setBaseline(baseline);
  return baseline;
}

/** Atomically publish one refresh generation. */
export async function commitRefresh(cache, baseline, generation) {
  const nextCache = { ...cache, generation };
  const nextBaseline = { ...baseline, generation };
  let nextHistory;
  await serialized(async () => {
    const currentHistory = (await readRecord(STORAGE_KEYS.history)) || emptyHistory();
    nextHistory = recordDailyHistory(currentHistory, nextCache, {
      now: nextCache.fetchedAt || Date.now(),
      maxBytes: historyMaxBytesForQuota(AREA.QUOTA_BYTES),
      // readRecord already validated the current point; writeRecords validates
      // the finished result once before publishing it.
      validate: false,
    });
    await writeRecords(
      {
        [STORAGE_KEYS.cache]: nextCache,
        [STORAGE_KEYS.baseline]: nextBaseline,
        [STORAGE_KEYS.history]: nextHistory,
      },
      generation,
    );
  });
  return { cache: nextCache, baseline: nextBaseline, history: nextHistory };
}

export async function clearPortfolioData() {
  await serialized(async () => {
    await saveUndoSnapshotInternal('clear-portfolio', [
      STORAGE_KEYS.cache,
      STORAGE_KEYS.baseline,
      STORAGE_KEYS.history,
      STORAGE_KEYS.notificationState,
    ]);
    await removeRecoveryRecords([
      STORAGE_KEYS.cache,
      STORAGE_KEYS.baseline,
      STORAGE_KEYS.history,
      STORAGE_KEYS.notificationState,
    ]);
    await AREA.remove([
      STORAGE_KEYS.cache,
      STORAGE_KEYS.baseline,
      STORAGE_KEYS.history,
      STORAGE_KEYS.notificationState,
    ]);
  });
}

async function saveUndoSnapshotInternal(scope, keys) {
  const snapshot = {};
  for (const key of keys) snapshot[key] = await readRecord(key);
  const createdAt = Date.now();
  await commit({
    [STORAGE_KEYS.undo]: makeEnvelope({
      scope,
      createdAt,
      expiresAt: createdAt + UNDO_WINDOW_MS,
      snapshot,
    }),
  });
}

export async function createUndoSnapshot(scope, keys) {
  await serialized(() => saveUndoSnapshotInternal(scope, keys));
  return getUndoStatus();
}

async function readUndo() {
  const raw = (await AREA.get(STORAGE_KEYS.undo))[STORAGE_KEYS.undo];
  rejectFutureSchema(STORAGE_KEYS.undo, raw);
  if (
    !isObject(raw) ||
    !Number.isInteger(raw.schemaVersion) ||
    raw.schemaVersion < 1 ||
    !isObject(raw.data?.snapshot) ||
    !Number.isFinite(raw.data?.expiresAt)
  ) {
    if (raw != null) await AREA.remove(STORAGE_KEYS.undo);
    return null;
  }
  if (raw.data.expiresAt <= Date.now()) {
    await AREA.remove(STORAGE_KEYS.undo);
    return null;
  }
  return raw.data;
}

export async function getUndoStatus() {
  const undo = await readUndo();
  return undo
    ? {
        available: true,
        scope: undo.scope,
        createdAt: undo.createdAt,
        expiresAt: undo.expiresAt,
      }
    : { available: false };
}

export async function restoreUndoSnapshot() {
  return serialized(async () => {
    const undo = await readUndo();
    if (!undo) return null;
    const records = {};
    const restorableKeys = [
      STORAGE_KEYS.settings,
      STORAGE_KEYS.cache,
      STORAGE_KEYS.baseline,
      STORAGE_KEYS.history,
      STORAGE_KEYS.notificationConfig,
      STORAGE_KEYS.notificationState,
      STORAGE_KEYS.portfolioViews,
    ];
    for (const key of restorableKeys) {
      if (undo.snapshot[key]) records[key] = undo.snapshot[key];
    }
    if (Object.keys(records).length) {
      const generation =
        records[STORAGE_KEYS.cache]?.generation ||
        records[STORAGE_KEYS.baseline]?.generation ||
        null;
      await writeRecords(records, generation);
    }
    const removed = [];
    for (const key of restorableKeys) {
      if (Object.hasOwn(undo.snapshot, key) && undo.snapshot[key] == null) {
        removed.push(key);
      }
    }
    if (removed.length) await removeRecoveryRecords(removed);
    if (removed.length) await AREA.remove(removed);
    await AREA.remove(STORAGE_KEYS.undo);
    return {
      scope: undo.scope,
      settings: await readRecord(STORAGE_KEYS.settings),
      cache: await readRecord(STORAGE_KEYS.cache),
      baseline: await readRecord(STORAGE_KEYS.baseline),
      history: await readRecord(STORAGE_KEYS.history),
      notificationConfig: await readRecord(STORAGE_KEYS.notificationConfig),
      notificationState: await readRecord(STORAGE_KEYS.notificationState),
      portfolioViews: await readRecord(STORAGE_KEYS.portfolioViews),
    };
  });
}

export async function getStorageDiagnostics() {
  const stored = await AREA.get([
    STORAGE_KEYS.settings,
    STORAGE_KEYS.cache,
    STORAGE_KEYS.baseline,
    STORAGE_KEYS.history,
    STORAGE_KEYS.portfolioViews,
    STORAGE_KEYS.quarantine,
  ]);
  return {
    schemaVersion: SCHEMA_VERSION,
    settingsStored: !!stored[STORAGE_KEYS.settings],
    cacheStored: !!stored[STORAGE_KEYS.cache],
    baselineStored: !!stored[STORAGE_KEYS.baseline],
    historyStored: !!stored[STORAGE_KEYS.history],
    portfolioViewsStored: !!stored[STORAGE_KEYS.portfolioViews],
    quarantined: stored[STORAGE_KEYS.quarantine]?.data?.records?.length || 0,
  };
}

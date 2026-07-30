/**
 * Portable StarBoard backup and CSV export.
 *
 * The JSON format is deliberately independent from chrome.storage envelopes:
 * each record carries its source schema, the complete document is checksummed,
 * and credentials are rejected rather than silently imported.
 */

import {
  SCHEMA_VERSION,
  STORAGE_KEYS,
  migrateRecord,
  normalizeSettings,
} from './storage.js';
import { emptyHistory, historyStats, validateHistory } from './history.js';

export const BACKUP_FORMAT = 'starboard-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_MAX_BYTES = 5 * 1024 * 1024;
const PORTABLE_KEYS = [
  STORAGE_KEYS.settings,
  STORAGE_KEYS.cache,
  STORAGE_KEYS.baseline,
  STORAGE_KEYS.history,
  STORAGE_KEYS.notificationConfig,
  STORAGE_KEYS.portfolioViews,
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function copy(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function portableRecord(data) {
  return { schemaVersion: SCHEMA_VERSION, data: copy(data) };
}

function classifiedNames(cache, history) {
  const publicNames = new Set();
  const privateNames = new Set();
  for (const repo of cache?.repos || []) {
    (repo.private ? privateNames : publicNames).add(repo.full_name);
  }
  for (const snapshot of history?.snapshots || []) {
    for (const repo of snapshot.repos) {
      (repo.private ? privateNames : publicNames).add(repo.fullName);
    }
  }
  const safePublicNames = new Set(
    [...publicNames].filter((name) => !privateNames.has(name)),
  );
  return { publicNames: safePublicNames, privateNames };
}

function sanitizeCache(cache, includePrivate, names) {
  if (!cache) return null;
  const repos = cache.repos.filter((repo) => includePrivate || !repo.private);
  const included = new Set(repos.map((repo) => repo.full_name));
  const lifecycleEvents = (cache.lifecycleEvents || []).filter((event) => {
    if (includePrivate) return true;
    if (event.type === 'removed') return names.publicNames.has(event.to);
    return included.has(event.to) && (!event.from || !names.privateNames.has(event.from));
  });
  return { ...copy(cache), repos: copy(repos), lifecycleEvents: copy(lifecycleEvents) };
}

function sanitizeBaseline(baseline, includePrivate, names) {
  if (!baseline) return null;
  const counts = {};
  for (const [name, value] of Object.entries(baseline.counts || {})) {
    if (includePrivate || names.publicNames.has(name)) counts[name] = copy(value);
  }
  return { ...copy(baseline), counts };
}

function sanitizeHistory(history, includePrivate, names) {
  const source = history || emptyHistory();
  validateHistory(source);
  return {
    ...copy(source),
    snapshots: source.snapshots.map((snapshot) => ({
      ...copy(snapshot),
      repos: snapshot.repos
        .filter(
          (repo) =>
            includePrivate || (!repo.private && !names.privateNames.has(repo.fullName)),
        )
        .map(copy),
    })),
  };
}

function sanitizePortfolioViews(state, includePrivate, names) {
  if (!state) return null;
  const clean = copy(state);
  if (includePrivate || !names.privateNames.size) return clean;
  const privateTerms = [...names.privateNames]
    .flatMap((name) => [name, name.split('/').at(-1)])
    .filter(Boolean)
    .map((name) => name.toLocaleLowerCase());
  const containsPrivateName = (value) => {
    const text = String(value || '').toLocaleLowerCase();
    return privateTerms.some((term) => text.includes(term));
  };
  if (containsPrivateName(clean.active?.query)) clean.active.query = '';
  const retainedNames = new Set(
    clean.views
      .filter((view) => !containsPrivateName(view.name))
      .map((view) => view.name.toLocaleLowerCase()),
  );
  clean.views.forEach((view) => {
    if (containsPrivateName(view.name)) {
      let suffix = 1;
      let candidate = `Redacted view ${suffix}`;
      while (retainedNames.has(candidate.toLocaleLowerCase())) {
        suffix += 1;
        candidate = `Redacted view ${suffix}`;
      }
      view.name = candidate;
      retainedNames.add(candidate.toLocaleLowerCase());
    }
    if (containsPrivateName(view.filters?.query)) view.filters.query = '';
  });
  return clean;
}

export async function createBackup({
  settings,
  cache,
  baseline,
  history,
  notificationConfig,
  portfolioViews,
  includePrivate = false,
  includeHistory = false,
  now = Date.now(),
} = {}) {
  assert(settings, 'settings are required for backup');
  const sourceHistory = history || emptyHistory();
  const names = classifiedNames(cache, sourceHistory);
  const cleanSettings = normalizeSettings({ ...settings, token: '' });
  const records = {
    [STORAGE_KEYS.settings]: portableRecord(cleanSettings),
  };
  const cleanCache = sanitizeCache(cache, includePrivate, names);
  const cleanBaseline = sanitizeBaseline(baseline, includePrivate, names);
  if (cleanCache) records[STORAGE_KEYS.cache] = portableRecord(cleanCache);
  if (cleanBaseline) records[STORAGE_KEYS.baseline] = portableRecord(cleanBaseline);
  if (includeHistory) {
    records[STORAGE_KEYS.history] = portableRecord(
      sanitizeHistory(sourceHistory, includePrivate, names),
    );
  }
  if (notificationConfig) {
    records[STORAGE_KEYS.notificationConfig] = portableRecord(notificationConfig);
  }
  const cleanViews = sanitizePortfolioViews(portfolioViews, includePrivate, names);
  if (cleanViews) {
    records[STORAGE_KEYS.portfolioViews] = portableRecord(cleanViews);
  }

  const core = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: new Date(now).toISOString(),
    privacy: {
      privateRepositoryNamesIncluded: !!includePrivate,
      historyIncluded: !!includeHistory,
      credentialsIncluded: false,
    },
    records,
  };
  return {
    ...core,
    checksum: {
      algorithm: 'SHA-256',
      value: await sha256Hex(stableStringify(core)),
    },
  };
}

function summarize(records, versions) {
  const cache = records[STORAGE_KEYS.cache];
  const baseline = records[STORAGE_KEYS.baseline];
  const history = records[STORAGE_KEYS.history] || emptyHistory();
  const trends = historyStats(history);
  const privateNames = new Set(
    (cache?.repos || []).filter((repo) => repo.private).map((repo) => repo.full_name),
  );
  for (const snapshot of history.snapshots) {
    for (const repo of snapshot.repos) {
      if (repo.private) privateNames.add(repo.fullName);
    }
  }
  return {
    settings: !!records[STORAGE_KEYS.settings],
    repositories: cache?.repos?.length || 0,
    privateRepositories: privateNames.size,
    baselineRepositories: Object.keys(baseline?.counts || {}).length,
    historyDays: trends.days,
    historyPoints: trends.points,
    notificationConfig: !!records[STORAGE_KEYS.notificationConfig],
    savedViews: records[STORAGE_KEYS.portfolioViews]?.views?.length || 0,
    migratedRecords: versions.filter((version) => version < SCHEMA_VERSION).length,
  };
}

export async function validateBackupText(text) {
  assert(typeof text === 'string' && text.trim(), 'backup file is empty');
  assert(new TextEncoder().encode(text).byteLength <= BACKUP_MAX_BYTES, 'backup exceeds 5 MiB');
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error('backup is not valid JSON');
  }
  assert(document && typeof document === 'object' && !Array.isArray(document), 'invalid backup');
  const { checksum, ...core } = document;
  assert(core.format === BACKUP_FORMAT, 'not a StarBoard backup');
  assert(core.formatVersion === BACKUP_FORMAT_VERSION, 'unsupported backup format');
  assert(Number.isFinite(Date.parse(core.exportedAt)), 'invalid backup timestamp');
  assert(
    checksum?.algorithm === 'SHA-256' && /^[a-f0-9]{64}$/.test(checksum.value || ''),
    'invalid backup checksum metadata',
  );
  const actual = await sha256Hex(stableStringify(core));
  assert(actual === checksum.value, 'backup checksum does not match its contents');
  assert(
    core.records && typeof core.records === 'object' && !Array.isArray(core.records),
    'backup records are missing',
  );
  const unknown = Object.keys(core.records).filter((key) => !PORTABLE_KEYS.includes(key));
  assert(!unknown.length, `backup contains unsupported records: ${unknown.join(', ')}`);
  assert(core.records[STORAGE_KEYS.settings], 'backup settings are missing');

  const records = {};
  const versions = [];
  for (const [key, raw] of Object.entries(core.records)) {
    assert(
      raw && typeof raw === 'object' && Number.isInteger(raw.schemaVersion),
      `invalid ${key} record`,
    );
    versions.push(raw.schemaVersion);
    const migrated = migrateRecord(key, raw);
    records[key] = migrated.envelope.data;
  }
  assert(!records[STORAGE_KEYS.settings].token, 'backup files may not contain credentials');
  records[STORAGE_KEYS.settings] = normalizeSettings({
    ...records[STORAGE_KEYS.settings],
    token: '',
  });

  return {
    document,
    records,
    summary: summarize(records, versions),
  };
}

function csvCell(value) {
  if (value == null) return '';
  let text = String(value);
  if (/^[=+@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csvLine(values) {
  return values.map(csvCell).join(',');
}

function currentCsvRows(cache, baseline, includePrivate) {
  if (!cache?.repos?.length) return [];
  const counts = baseline?.counts || {};
  return cache.repos
    .filter((repo) => includePrivate || !repo.private)
    .map((repo) => {
      const previous = counts[repo.full_name];
      return [
        new Date(cache.fetchedAt).toISOString(),
        repo.full_name,
        repo.private ? 'private' : 'public',
        repo.stargazers_count,
        repo.forks_count,
        previous ? repo.stargazers_count - previous[0] : '',
        previous ? repo.forks_count - previous[1] : '',
        cache.source || '',
        repo.approx ? 'approximate' : cache.confidence || 'exact',
      ];
    });
}

function historyCsvRows(history, includePrivate) {
  validateHistory(history);
  const previous = new Map();
  const rows = [];
  for (const snapshot of history.snapshots) {
    for (const repo of snapshot.repos) {
      if (!includePrivate && repo.private) continue;
      const before = previous.get(repo.key);
      rows.push([
        new Date(snapshot.at).toISOString(),
        repo.fullName,
        repo.private ? 'private' : 'public',
        repo.stars,
        repo.forks,
        before ? repo.stars - before.stars : '',
        before ? repo.forks - before.forks : '',
        snapshot.source,
        repo.approximate ? 'approximate' : snapshot.confidence,
      ]);
      previous.set(repo.key, repo);
    }
  }
  return rows;
}

export function createCsv({
  cache,
  baseline,
  history,
  includePrivate = false,
  includeHistory = false,
} = {}) {
  const header = [
    'captured_at',
    'repository',
    'visibility',
    'stars',
    'forks',
    'stars_delta',
    'forks_delta',
    'source',
    'confidence',
  ];
  const rows =
    includeHistory && history?.snapshots?.length
      ? historyCsvRows(history, includePrivate)
      : currentCsvRows(cache, baseline, includePrivate);
  return `\uFEFF${[header, ...rows].map(csvLine).join('\r\n')}\r\n`;
}

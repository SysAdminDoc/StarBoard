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
import {
  emptyHistory,
  filterHistoryRepositories,
  historyRows,
  historySeriesForRepo,
  historyStats,
  validateHistory,
} from './history.js';
import { repositoryAlertKey } from './notifications.js';

export const BACKUP_FORMAT = 'starboard-backup';
export const BACKUP_FORMAT_VERSION = 1;
/**
 * The CSV column contract, carried in every row so a consumer never has to
 * infer it from a filename or from a header it may not have read.
 *
 * Compatibility promise: within one version these columns are stable — never
 * removed, reordered or retyped — and new columns are only ever appended to the
 * right. Anything that would break a reader indexing by position increments
 * this number instead.
 */
export const CSV_FORMAT_VERSION = 1;
export const CSV_COLUMNS = Object.freeze([
  'schema_version',
  'captured_at',
  'repository',
  'visibility',
  'stars',
  'forks',
  'stars_delta',
  'forks_delta',
  'source',
  'confidence',
]);
export const BACKUP_MAX_BYTES = 5 * 1024 * 1024;
export const HISTORY_REPORT_FORMAT = 'starboard-history';
export const HISTORY_REPORT_FORMAT_VERSION = 1;
export const HISTORY_REPORT_DURATIONS = Object.freeze([7, 30, 90]);
export const HISTORY_REPORT_COLORS = Object.freeze({
  positive: 'brightgreen',
  negative: 'red',
  neutral: 'blue',
  empty: 'lightgrey',
});
/** @type {string[]} */
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

export class BackupSizeError extends Error {
  constructor(bytes, { historyIncluded = false } = {}) {
    const excessKiB = Math.max(1, Math.ceil((bytes - BACKUP_MAX_BYTES) / 1024));
    super(`Backup exceeds StarBoard's 5 MiB restore limit by ${excessKiB} KiB.`);
    this.name = 'BackupSizeError';
    this.code = 'BACKUP_TOO_LARGE';
    this.bytes = bytes;
    this.maxBytes = BACKUP_MAX_BYTES;
    this.historyIncluded = historyIncluded;
  }
}

export function assertBackupSize(bytes, { historyIncluded = false } = {}) {
  if (bytes > BACKUP_MAX_BYTES) throw new BackupSizeError(bytes, { historyIncluded });
}

/** The on-disk representation is compact so every exported file is restorable. */
export function serializeBackup(document) {
  const text = `${JSON.stringify(document)}\n`;
  const bytes = new TextEncoder().encode(text).byteLength;
  assertBackupSize(bytes, { historyIncluded: !!document?.privacy?.historyIncluded });
  return text;
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
  for (const entry of history?.repos || []) {
    const [, fullName, isPrivate] = entry;
    (isPrivate === 1 ? privateNames : publicNames).add(fullName);
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
  if (includePrivate) return copy(source);
  return copy(
    filterHistoryRepositories(
      source,
      (repo) => !repo.private && !names.privateNames.has(repo.fullName),
    ),
  );
}

function notificationRepositoryKeys(cache, history) {
  const publicKeys = new Set();
  const privateKeys = new Set();
  for (const repo of cache?.repos || []) {
    (repo.private ? privateKeys : publicKeys).add(repositoryAlertKey(repo));
  }
  for (const entry of history?.repos || []) {
    const [, fullName, isPrivate] = entry;
    (isPrivate === 1 ? privateKeys : publicKeys).add(`name:${fullName}`);
  }
  return { publicKeys, privateKeys };
}

function sanitizeNotificationConfig(config, includePrivate, cache, history) {
  const clean = copy(config);
  if (!Array.isArray(clean?.repositoryAlerts)) return clean;
  const { publicKeys, privateKeys } = notificationRepositoryKeys(cache, history);
  clean.repositoryAlerts = clean.repositoryAlerts.filter((key) => {
    if (key.startsWith('id:')) return true;
    if (publicKeys.has(key)) return true;
    return includePrivate && privateKeys.has(key);
  });
  return clean;
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

/** @param {any} [state] */
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
    records[STORAGE_KEYS.notificationConfig] = portableRecord(
      sanitizeNotificationConfig(notificationConfig, includePrivate, cache, sourceHistory),
    );
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
  for (const [, fullName, isPrivate] of history.repos || []) {
    if (isPrivate === 1) privateNames.add(fullName);
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
  assertBackupSize(new TextEncoder().encode(text).byteLength);
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

  // A backup file is untrusted input that overwrites settings, cache, baseline,
  // history and saved views. Reject prototype-polluting keys before any of it
  // is merged, and refuse a record written by a newer StarBoard rather than
  // silently downgrading data this build cannot represent.
  const ownKeys = Object.keys(core.records);
  assert(
    !ownKeys.some((key) => ['__proto__', 'constructor', 'prototype'].includes(key)),
    'backup contains a prohibited record name',
  );
  assert(
    Object.getPrototypeOf(core.records) === Object.prototype ||
      Object.getPrototypeOf(core.records) === null,
    'backup records have an unexpected prototype',
  );

  const records = Object.create(null);
  const versions = [];
  for (const key of ownKeys) {
    const raw = core.records[key];
    assert(
      raw && typeof raw === 'object' && !Array.isArray(raw) && Number.isInteger(raw.schemaVersion),
      `invalid ${key} record`,
    );
    assert(
      raw.schemaVersion >= 1 && raw.schemaVersion <= SCHEMA_VERSION,
      `${key} was written by a newer StarBoard (schema v${raw.schemaVersion}); update first`,
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

/**
 * RFC 4180 quoting plus the full OWASP formula-injection guard.
 *
 * Repository names and descriptions are attacker-influencable, and a
 * spreadsheet treats a leading `=`, `+`, `-`, `@`, control character or its
 * full-width equivalent as the start of a formula. A tab inside the quoted
 * field survives Excel save/reopen, where a leading apostrophe may not.
 * Keep the whole set here even if a given column cannot currently carry one —
 * columns get added, and this is the only place that decides.
 */
function csvCell(value) {
  if (value == null) return '';
  let text = String(value);
  // A plain number is not a formula, and the delta columns are legitimately
  // negative — prefixing those would turn -3 into the text "'-3" and break
  // every consumer. Guard everything else.
  const numeric = /^-?\d+(?:\.\d+)?$/.test(text);
  if (!numeric && /^[=+\-@\t\r\n＝＋－＠]/.test(text)) text = `\t${text}`;
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
        CSV_FORMAT_VERSION,
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
  const previous = new Map();
  const rows = [];
  for (const row of historyRows(history)) {
    if (!includePrivate && row.private) continue;
    const before = previous.get(row.key);
    rows.push([
      CSV_FORMAT_VERSION,
      new Date(row.at).toISOString(),
      row.fullName,
      row.private ? 'private' : 'public',
      row.stars,
      row.forks,
      // A delta is only meaningful between two observed points. A gap must
      // leave the cell empty rather than imply a change from zero.
      before ? row.stars - before.stars : '',
      before ? row.forks - before.forks : '',
      row.source,
      row.approximate ? 'approximate' : row.confidence,
    ]);
    previous.set(row.key, row);
  }
  return rows;
}

/** @param {any} [state] */
export function createCsv({
  cache,
  baseline,
  history,
  includePrivate = false,
  includeHistory = false,
} = {}) {
  const rows =
    includeHistory && history?.snapshots?.length
      ? historyCsvRows(history, includePrivate)
      : currentCsvRows(cache, baseline, includePrivate);
  return `\uFEFF${[[...CSV_COLUMNS], ...rows].map(csvLine).join('\r\n')}\r\n`;
}

function reportDuration(days) {
  const value = Number(days);
  assert(
    Number.isInteger(value) && HISTORY_REPORT_DURATIONS.includes(value),
    `unsupported history report duration: ${days}`,
  );
  return value;
}

function reportCount(value) {
  return Number.isFinite(value) ? value : null;
}

function reportNames(cache, history, includePrivate) {
  const visibility = new Map();
  for (const repo of cache?.repos || []) {
    if (!repo?.full_name) continue;
    visibility.set(repo.full_name, !!repo.private);
  }
  for (const [, fullName, isPrivate] of history?.repos || []) {
    if (!fullName) continue;
    visibility.set(fullName, !!isPrivate || visibility.get(fullName) === true);
  }
  return [...visibility.entries()]
    .filter(([, isPrivate]) => includePrivate || !isPrivate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fullName, isPrivate]) => ({ fullName, private: isPrivate }));
}

function reportPortfolioPoints(rows) {
  const dates = rows[0]?.points?.map((point) => point.date) || [];
  return dates.map((date, index) => {
    let stars = 0;
    let forks = 0;
    let measuredRepositories = 0;
    let approximate = false;
    for (const row of rows) {
      const point = row.points[index];
      if (point.stars === null) continue;
      stars += point.stars;
      forks += point.forks;
      measuredRepositories += 1;
      approximate ||= point.approximate;
    }
    return {
      date,
      stars: measuredRepositories ? stars : null,
      forks: measuredRepositories ? forks : null,
      measuredRepositories,
      approximate,
    };
  });
}

function reportColor(delta, measured) {
  if (!measured) return HISTORY_REPORT_COLORS.empty;
  if (delta > 0) return HISTORY_REPORT_COLORS.positive;
  if (delta < 0) return HISTORY_REPORT_COLORS.negative;
  return HISTORY_REPORT_COLORS.neutral;
}

function reportDelta(value) {
  if (!Number.isFinite(value)) return null;
  return value;
}

/**
 * Build the local, commit-friendly report used by the JSON and SVG exports.
 *
 * The top-level Shields fields are intentional: the same JSON can be committed
 * to a gist or repository and passed to img.shields.io/endpoint without a
 * second conversion step. The additional StarBoard fields retain the actual
 * bounded history instead of reducing it to a badge message.
 * @param {{cache?: any, history?: any, includePrivate?: boolean, duration?: number, now?: number}} options
 */
export function createHistoryReport({
  cache,
  history,
  includePrivate = false,
  duration = 30,
  now = Date.now(),
} = {}) {
  const days = reportDuration(duration);
  const sourceHistory = history || emptyHistory();
  validateHistory(sourceHistory);
  const names = reportNames(cache, sourceHistory, includePrivate);
  const rows = names.map(({ fullName, private: isPrivate }) => {
    const repo = { full_name: fullName };
    const stars = historySeriesForRepo(sourceHistory, repo, days, { now, metric: 'stars' });
    const forks = historySeriesForRepo(sourceHistory, repo, days, { now, metric: 'forks' });
    const points = stars.values.map((point, index) => ({
      date: point.day,
      stars: reportCount(point.value),
      forks: reportCount(forks.values[index]?.value),
      approximate: !!point.approximate || !!forks.values[index]?.approximate,
    }));
    return {
      repository: fullName,
      visibility: isPrivate ? 'private' : 'public',
      points,
      measured: stars.measured,
      gaps: stars.gaps,
      first: reportCount(stars.first),
      last: reportCount(stars.last),
      delta: reportDelta(stars.delta),
      approximate: stars.approximate,
    };
  });
  const portfolioPoints = reportPortfolioPoints(rows);
  const measuredRows = rows.filter((row) => row.measured > 0);
  const stars = measuredRows.reduce((total, row) => total + (row.last || 0), 0);
  const forks = rows.reduce((total, row) => {
    const last = row.points.findLast((point) => point.forks !== null);
    return total + (last?.forks || 0);
  }, 0);
  const delta = measuredRows.reduce((total, row) => total + (row.delta || 0), 0);
  const measured = portfolioPoints.some((point) => point.stars !== null);
  const newest = portfolioPoints.at(-1)?.date || null;
  const oldest = portfolioPoints[0]?.date || null;
  const message = measured
    ? `${stars.toLocaleString('en-US')} stars · ${delta >= 0 ? '+' : ''}${delta.toLocaleString('en-US')} over ${days}d`
    : `No retained history over ${days}d`;

  return {
    schemaVersion: HISTORY_REPORT_FORMAT_VERSION,
    label: 'StarBoard stars',
    message,
    color: reportColor(delta, measured),
    format: HISTORY_REPORT_FORMAT,
    formatVersion: HISTORY_REPORT_FORMAT_VERSION,
    generatedAt: new Date(now).toISOString(),
    privacy: {
      privateRepositoryNamesIncluded: !!includePrivate,
      credentialsIncluded: false,
    },
    period: { days, from: oldest, to: newest },
    summary: {
      repositories: rows.length,
      measuredRepositories: measuredRows.length,
      stars,
      forks,
      starsDelta: delta,
    },
    portfolio: { points: portfolioPoints },
    repositories: rows,
  };
}

export function serializeHistoryReport(report) {
  assert(report?.format === HISTORY_REPORT_FORMAT, 'invalid history report');
  assert(report?.privacy?.credentialsIncluded === false, 'history report credentials are not allowed');
  return `${JSON.stringify(report, null, 2)}\n`;
}

function svgEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function svgPoints(points, width, height) {
  const measured = points.filter((point) => point.stars !== null);
  if (!measured.length) return '';
  const values = measured.map((point) => point.stars);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const lastIndex = Math.max(1, points.length - 1);
  return measured
    .map((point) => {
      const index = points.indexOf(point);
      const x = 12 + (index / lastIndex) * (width - 24);
      const y = height - 8 - ((point.stars - min) / range) * (height - 16);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

/** Render a self-contained SVG with no network references or embedded data. */
export function createSvgTrendBadge(report) {
  assert(report?.format === HISTORY_REPORT_FORMAT, 'invalid history report');
  const points = report.portfolio?.points || [];
  const width = 360;
  const height = 72;
  const chart = svgPoints(points, 92, 28);
  const delta = report.summary?.starsDelta || 0;
  const deltaLabel = report.summary?.measuredRepositories
    ? `${delta >= 0 ? '+' : ''}${delta.toLocaleString('en-US')} / ${report.period.days}d`
    : 'no retained history';
  const title = `${report.label}: ${report.message}`;
  const chartMarkup = chart
    ? `<polyline points="${chart}" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
    : '<text x="12" y="18" fill="#ffffff" font-size="8">No data</text>';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${svgEscape(title)}">`,
    `<title>${svgEscape(title)}</title>`,
    `<rect width="${width}" height="${height}" rx="8" fill="#24292f"/>`,
    `<text x="16" y="24" fill="#ffffff" font-family="Arial, sans-serif" font-size="13" font-weight="700">${svgEscape(report.label)}</text>`,
    `<text x="16" y="48" fill="#ffffff" font-family="Arial, sans-serif" font-size="18" font-weight="700">${svgEscape(report.summary?.stars?.toLocaleString('en-US') || '0')}</text>`,
    `<text x="82" y="47" fill="#d0d7de" font-family="Arial, sans-serif" font-size="11">${svgEscape(deltaLabel)}</text>`,
    `<g transform="translate(252 22)">${chartMarkup}</g>`,
    '</svg>',
  ].join('');
}

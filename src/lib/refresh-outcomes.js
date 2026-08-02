/**
 * Small, redacted history of refresh failures for local support diagnostics.
 *
 * This record deliberately contains no error message, URL, username or
 * repository identity. It is a bounded ring because its job is to show an
 * intermittent failure pattern, not to become another history archive.
 */

export const REFRESH_FAILURES_FORMAT_VERSION = 1;
export const MAX_REFRESH_FAILURES = 20;

const SOURCES = new Set(['api', 'web', 'unknown']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeOutcome(value) {
  const source = SOURCES.has(value?.source) ? value.source : 'unknown';
  const code = String(value?.code || 'REFRESH_FAILED').slice(0, 80);
  const at = Number(value?.at);
  assert(Number.isFinite(at) && at >= 0, 'invalid refresh failure timestamp');
  assert(code.length > 0, 'invalid refresh failure code');
  return {
    at,
    source,
    code,
    authenticated: !!value?.authenticated,
  };
}

export function emptyRefreshFailures() {
  return { formatVersion: REFRESH_FAILURES_FORMAT_VERSION, records: [] };
}

export function validateRefreshFailures(value) {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    'refresh failures must be an object',
  );
  assert(
    value.formatVersion === REFRESH_FAILURES_FORMAT_VERSION,
    'unsupported refresh failure history',
  );
  assert(
    Array.isArray(value.records) && value.records.length <= MAX_REFRESH_FAILURES,
    'invalid refresh failure records',
  );
  value.records.forEach((record) => {
    const normalized = normalizeOutcome(record);
    assert(normalized.authenticated === record.authenticated, 'invalid refresh authentication state');
  });
  return value;
}

export function appendRefreshFailure(current, outcome) {
  const history = current || emptyRefreshFailures();
  validateRefreshFailures(history);
  const next = {
    formatVersion: REFRESH_FAILURES_FORMAT_VERSION,
    records: [...history.records, normalizeOutcome(outcome)].slice(-MAX_REFRESH_FAILURES),
  };
  validateRefreshFailures(next);
  return next;
}

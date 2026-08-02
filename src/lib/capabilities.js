/**
 * StarBoard — a static kill-switch for field breakage.
 *
 * A store review cycle is documented as "a few days… up to a few weeks", so a
 * broken adapter or a removed upstream field currently cannot be turned off for
 * installed users without shipping a release and waiting out review. This reads
 * a small static JSON from a fixed origin and lets a *named* capability be
 * disabled until the installed version reaches a stated minimum.
 *
 * What this deliberately is not: it never fetches, evaluates or injects code,
 * never accepts a selector, URL, script or template from the network, and never
 * enables anything. The only thing the document can do is switch one of a
 * fixed, locally-defined list of capabilities off. Anything it says that is not
 * in that list is discarded.
 *
 * GitHub Pages answers `Access-Control-Allow-Origin: *`, so this needs no host
 * permission — the same reason the API lane dropped its `api.github.com` grant.
 */

export const CAPABILITY_MANIFEST_URL =
  'https://sysadmindoc.github.io/StarBoard/capabilities.json';
export const CAPABILITY_MANIFEST_ORIGIN = 'https://sysadmindoc.github.io';
export const CAPABILITY_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const CAPABILITY_FORMAT_VERSION = 1;
/** A hostile or accidental 40 MB response must not be read into memory. */
export const CAPABILITY_MAX_BYTES = 16 * 1024;

/**
 * Every capability the document is allowed to name. A name outside this list is
 * ignored, so the file can never reach anything the build did not anticipate.
 */
export const KNOWN_CAPABILITIES = Object.freeze([
  // The github.com scraping source, whose selector contract is the one thing
  // here that a remote site can break without warning.
  'web-source',
  // The optional GraphQL listing. REST remains as its fallback.
  'api-graphql',
  // Local milestone and growth notifications.
  'notifications',
]);

const CAPABILITY_SET = new Set(KNOWN_CAPABILITIES);
const VERSION_PATTERN = /^\d+(\.\d+){0,3}$/;

/** Numeric dotted-version compare. Returns -1, 0 or 1. */
export function compareVersions(left, right) {
  const a = String(left || '0').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = String(right || '0').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const width = Math.max(a.length, b.length);
  for (let i = 0; i < width; i += 1) {
    const difference = (a[i] || 0) - (b[i] || 0);
    if (difference) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * Validate a fetched document into the only shape the rest of the extension
 * sees. Anything malformed anywhere yields an empty rule set rather than a
 * throw: a broken kill-switch must never break the extension it protects.
 */
export function parseCapabilityManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { rules: [] };
  if (raw.formatVersion !== CAPABILITY_FORMAT_VERSION) return { rules: [] };
  if (!Array.isArray(raw.capabilities)) return { rules: [] };
  const rules = [];
  const seen = new Set();
  for (const entry of raw.capabilities.slice(0, KNOWN_CAPABILITIES.length * 2)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name : '';
    if (!CAPABILITY_SET.has(name) || seen.has(name)) continue;
    const fixedIn = typeof entry.fixedInVersion === 'string' ? entry.fixedInVersion : '';
    // A rule with no version would disable the capability forever, including
    // for the release that fixes it. Require the version that lifts it.
    if (!VERSION_PATTERN.test(fixedIn)) continue;
    seen.add(name);
    rules.push({
      name,
      fixedInVersion: fixedIn,
      reason: cleanText(entry.reason, 200),
    });
  }
  return { rules };
}

/** The capability names disabled for `installedVersion`. */
export function disabledCapabilities(state, installedVersion) {
  const rules = Array.isArray(state?.rules) ? state.rules : [];
  return rules
    .filter((rule) => compareVersions(installedVersion, rule.fixedInVersion) < 0)
    .map((rule) => rule.name);
}

export function isCapabilityDisabled(state, name, installedVersion) {
  return disabledCapabilities(state, installedVersion).includes(name);
}

export function emptyCapabilityState() {
  return { formatVersion: CAPABILITY_FORMAT_VERSION, fetchedAt: 0, rules: [] };
}

export function validateCapabilityState(value) {
  const ok =
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.formatVersion === CAPABILITY_FORMAT_VERSION &&
    Number.isFinite(value.fetchedAt) &&
    Array.isArray(value.rules) &&
    value.rules.every(
      (rule) =>
        !!rule &&
        typeof rule === 'object' &&
        CAPABILITY_SET.has(rule.name) &&
        VERSION_PATTERN.test(String(rule.fixedInVersion)) &&
        // The reason is a human note, not part of the decision, so it is
        // optional. The name and the version that lifts the rule are not.
        (rule.reason === undefined || typeof rule.reason === 'string'),
    );
  if (!ok) throw new Error('invalid capability state');
  return value;
}

export function capabilityFetchIsDue(state, { now = Date.now() } = {}) {
  const fetchedAt = Number(state?.fetchedAt) || 0;
  // A fresh install has never fetched. Waiting six hours from the epoch would
  // leave the very state the switch exists for — a broken build — unprotected.
  if (fetchedAt <= 0) return true;
  return now - fetchedAt >= CAPABILITY_POLL_INTERVAL_MS;
}

/**
 * Read the document. Redirects are refused outright rather than followed: the
 * whole security property here is that the bytes came from one known origin.
 */
export async function fetchCapabilityManifest({
  fetchImpl = fetch,
  now = Date.now,
  signal = null,
  url = CAPABILITY_MANIFEST_URL,
} = {}) {
  if (new URL(url).origin !== CAPABILITY_MANIFEST_ORIGIN) {
    throw new Error('capability manifest origin is not allowed');
  }
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'error',
    cache: 'no-cache',
    credentials: 'omit',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw new Error(`capability manifest returned ${response.status}`);
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > CAPABILITY_MAX_BYTES) {
    throw new Error('capability manifest is too large');
  }
  const text = await response.text();
  if (text.length > CAPABILITY_MAX_BYTES) throw new Error('capability manifest is too large');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('capability manifest is not valid JSON');
  }
  return { ...parseCapabilityManifest(raw), formatVersion: CAPABILITY_FORMAT_VERSION, fetchedAt: now() };
}

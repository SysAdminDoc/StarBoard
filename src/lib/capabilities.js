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

import {
  CAPABILITY_MANIFEST_URL,
  NETWORK_DESTINATIONS,
} from './network-contract.js';

export { CAPABILITY_MANIFEST_URL } from './network-contract.js';
export const CAPABILITY_MANIFEST_ORIGIN = NETWORK_DESTINATIONS.capability.origin;
export const CAPABILITY_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
// A fetched rule is trusted for at most 24 hours. Beyond that window the
// extension fails open while continuing to poll, so an unreachable document
// cannot pin a capability off indefinitely.
export const CAPABILITY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CAPABILITY_FORMAT_VERSION = 1;
/** A hostile or accidental 40 MB response must not be read into memory. */
export const CAPABILITY_MAX_BYTES = 16 * 1024;
export const CAPABILITY_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const CAPABILITY_MAX_SIGNED_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const CAPABILITY_MANIFEST_ALGORITHM = 'Ed25519';
export const CAPABILITY_MANIFEST_KEY_ID = '2026-08';

// The matching private key is never part of the extension or repository. A
// key id makes a future rotation explicit without accepting an arbitrary key
// from the network. A payload signed by any other key is fail-open rejected.
export const CAPABILITY_PUBLIC_KEYS = Object.freeze({
  [CAPABILITY_MANIFEST_KEY_ID]: 'jKn4PC_XUTBMuU9ZavWARuPhBRP4MdT4zSIGRX1BjQw',
});
export const CAPABILITY_OUTCOMES = Object.freeze([
  'never',
  'accepted',
  'unsigned',
  'invalid-signature',
  'expired',
  'invalid',
  'unavailable',
]);

export class CapabilityManifestError extends Error {
  constructor(message, code = 'CAPABILITY_MANIFEST_INVALID') {
    super(message);
    this.name = 'CapabilityManifestError';
    this.code = code;
  }
}

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

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The signed portion of a manifest, in deterministic JSON form. */
export function canonicalCapabilityPayload(raw) {
  return canonicalize({
    capabilities: raw?.capabilities,
    expiresAt: raw?.expiresAt,
    formatVersion: raw?.formatVersion,
    issuedAt: raw?.issuedAt,
  });
}

/**
 * Verify the author and lifetime of a fetched document before parsing rules.
 * `publicKeys` is injectable only for deterministic tests; production uses the
 * baked allow-list above and never accepts a key from the manifest itself.
 */
export async function verifyCapabilityManifest(
  raw,
  {
    now = Date.now(),
    publicKeys = CAPABILITY_PUBLIC_KEYS,
    subtle = globalThis.crypto?.subtle,
  } = {},
) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CapabilityManifestError('capability manifest is not an object');
  }
  const signature = raw.signature;
  if (!signature || typeof signature !== 'object' || Array.isArray(signature)) {
    throw new CapabilityManifestError('capability manifest is unsigned', 'CAPABILITY_UNSIGNED');
  }
  const issuedAt = Number(raw.issuedAt);
  const expiresAt = Number(raw.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    throw new CapabilityManifestError('capability manifest has no signed lifetime', 'CAPABILITY_INVALID');
  }
  if (expiresAt <= now) {
    throw new CapabilityManifestError('capability manifest has expired', 'CAPABILITY_EXPIRED');
  }
  if (issuedAt > now + CAPABILITY_CLOCK_SKEW_MS) {
    throw new CapabilityManifestError('capability manifest starts in the future', 'CAPABILITY_INVALID');
  }
  if (expiresAt <= issuedAt || expiresAt - issuedAt > CAPABILITY_MAX_SIGNED_LIFETIME_MS) {
    throw new CapabilityManifestError('capability manifest lifetime is invalid', 'CAPABILITY_INVALID');
  }

  if (signature.algorithm !== CAPABILITY_MANIFEST_ALGORITHM) {
    throw new CapabilityManifestError('capability manifest algorithm is not allowed', 'CAPABILITY_INVALID');
  }
  const keyId = typeof signature.keyId === 'string' ? signature.keyId : '';
  const keyText = publicKeys?.[keyId];
  const keyBytes = decodeBase64Url(keyText);
  const signatureBytes = decodeBase64Url(signature.value);
  if (!keyBytes || keyBytes.length !== 32 || !signatureBytes || signatureBytes.length !== 64) {
    throw new CapabilityManifestError('capability manifest signature is malformed', 'CAPABILITY_INVALID_SIGNATURE');
  }
  if (!subtle) {
    throw new CapabilityManifestError('capability signature verification is unavailable', 'CAPABILITY_CRYPTO_UNAVAILABLE');
  }
  let valid = false;
  try {
    const key = await subtle.importKey('raw', keyBytes, CAPABILITY_MANIFEST_ALGORITHM, false, ['verify']);
    valid = await subtle.verify(
      CAPABILITY_MANIFEST_ALGORITHM,
      key,
      signatureBytes,
      new TextEncoder().encode(canonicalCapabilityPayload(raw)),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new CapabilityManifestError('capability manifest signature is invalid', 'CAPABILITY_INVALID_SIGNATURE');
  }
  return { keyId, issuedAt, expiresAt };
}

/** The capability names disabled for `installedVersion`. */
export function capabilityStateIsStale(state, { now = Date.now() } = {}) {
  const fetchedAt = Number(state?.fetchedAt);
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0 || fetchedAt > now) return true;
  const expiresAt = Number(state?.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= now) return true;
  return now - fetchedAt >= CAPABILITY_MAX_AGE_MS;
}

export function disabledCapabilities(state, installedVersion, options = {}) {
  if (capabilityStateIsStale(state, options)) return [];
  const rules = Array.isArray(state?.rules) ? state.rules : [];
  return rules
    .filter((rule) => compareVersions(installedVersion, rule.fixedInVersion) < 0)
    .map((rule) => rule.name);
}

export function isCapabilityDisabled(state, name, installedVersion, options = {}) {
  return disabledCapabilities(state, installedVersion, options).includes(name);
}

export function emptyCapabilityState() {
  return {
    formatVersion: CAPABILITY_FORMAT_VERSION,
    fetchedAt: 0,
    rules: [],
    lastAttemptAt: 0,
    lastOutcome: 'never',
    lastErrorCode: null,
  };
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
  if (
    value.lastAttemptAt !== undefined &&
    (!Number.isFinite(value.lastAttemptAt) || value.lastAttemptAt < 0)
  ) {
    throw new Error('invalid capability attempt timestamp');
  }
  if (value.lastOutcome !== undefined && !CAPABILITY_OUTCOMES.includes(value.lastOutcome)) {
    throw new Error('invalid capability outcome');
  }
  if (
    value.lastErrorCode !== undefined &&
    value.lastErrorCode !== null &&
    (typeof value.lastErrorCode !== 'string' || value.lastErrorCode.length > 80)
  ) {
    throw new Error('invalid capability error code');
  }
  for (const field of ['expiresAt', 'issuedAt']) {
    if (value[field] !== undefined && (!Number.isFinite(value[field]) || value[field] < 0)) {
      throw new Error(`invalid capability ${field}`);
    }
  }
  return value;
}

export function capabilityFetchIsDue(state, { now = Date.now() } = {}) {
  const fetchedAt = Number(state?.fetchedAt) || 0;
  // A fresh install has never fetched. Waiting six hours from the epoch would
  // leave the very state the switch exists for — a broken build — unprotected.
  if (fetchedAt <= 0) return true;
  // Clock rollback or a malformed future timestamp must not suppress polling.
  if (fetchedAt > now) return true;
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
  publicKeys = CAPABILITY_PUBLIC_KEYS,
  subtle = globalThis.crypto?.subtle,
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
  const fetchedAt = now();
  const verified = await verifyCapabilityManifest(raw, { now: fetchedAt, publicKeys, subtle });
  return {
    ...parseCapabilityManifest(raw),
    formatVersion: CAPABILITY_FORMAT_VERSION,
    fetchedAt,
    issuedAt: verified.issuedAt,
    expiresAt: verified.expiresAt,
    keyId: verified.keyId,
  };
}

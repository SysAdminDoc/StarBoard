import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, 'fixtures', 'storage');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Stub of a `chrome.storage` area. `quotaBytes` enforces the real
 * QUOTA_BYTES behaviour — Chrome rejects the whole `set` and leaves existing
 * values untouched — which is the only way to exercise the out-of-space path.
 * Chrome bills the JSON serialization of each value plus its key length.
 */
function memoryArea(initial = {}, { quotaBytes = Infinity } = {}) {
  const values = clone(initial);
  const sizeOf = (bag) =>
    Object.entries(bag).reduce(
      (total, [key, value]) => total + key.length + Buffer.byteLength(JSON.stringify(value)),
      0,
    );
  const area = {
    values,
    // Mutable so a test can narrow the budget around one write.
    quotaBytes,
    async get(keys) {
      if (keys == null) return clone(values);
      // Chrome also accepts an object of key -> default.
      if (keys && !Array.isArray(keys) && typeof keys === 'object') {
        return Object.fromEntries(
          Object.entries(keys).map(([name, fallback]) => [
            name,
            Object.hasOwn(values, name) ? clone(values[name]) : clone(fallback),
          ]),
        );
      }
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        names.filter((name) => Object.hasOwn(values, name)).map((name) => [name, clone(values[name])]),
      );
    },
    async set(next) {
      const candidate = { ...values, ...clone(next) };
      if (sizeOf(candidate) > area.quotaBytes) {
        throw new Error('QUOTA_BYTES quota exceeded');
      }
      Object.assign(values, clone(next));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
    async clear() {
      for (const key of Object.keys(values)) delete values[key];
    },
    async getBytesInUse(keys) {
      if (keys == null) return sizeOf(values);
      const names = Array.isArray(keys) ? keys : [keys];
      return sizeOf(
        Object.fromEntries(
          names.filter((name) => Object.hasOwn(values, name)).map((name) => [name, values[name]]),
        ),
      );
    },
  };
  return area;
}

const area = memoryArea();
const sessionArea = memoryArea();
globalThis.chrome = { storage: { local: area, session: sessionArea } };

const storage = await import('../src/lib/storage.js');
const { createRefreshCoordinator } = await import('../src/lib/refresh-coordinator.js');
const { parseRetryAfter, requestText, RequestPolicyError } = await import('../src/lib/request.js');
const {
  fetchAccount,
  readRate,
  parseLinkHeader,
  GitHubError,
} = await import('../src/lib/github.js');
const {
  deriveLifecycleEvents,
  mergeLifecycleEvents,
  acknowledgeLifecycleEvents,
} = await import('../src/lib/lifecycle.js');
const {
  HISTORY_MAX_BYTES,
  historyByteSize,
  historyPointForRepo,
  historyRetainedDays,
  historyRows,
  migrateHistoryToV2,
  recordDailyHistory,
} = await import('../src/lib/history.js');
const {
  createBackup,
  createCsv,
  sha256Hex,
  stableStringify,
  validateBackupText,
} = await import('../src/lib/transfer.js');
const { buildDiagnostics } = await import('../src/lib/diagnostics.js');
const {
  DEFAULT_NOTIFICATION_CONFIG,
  emptyNotificationState,
  evaluateNotificationEvents,
  markNotificationsDelivered,
  notificationAvailability,
} = await import('../src/lib/notifications.js');
const {
  activatePortfolioView,
  deletePortfolioView,
  emptyPortfolioViewState,
  filterRepositories,
  patchActivePortfolioFilters,
  renamePortfolioView,
  savePortfolioView,
} = await import('../src/lib/portfolio-views.js');

async function fixture(name) {
  return JSON.parse(await readFile(resolve(FIXTURES, name), 'utf8'));
}

const checks = [];
async function test(name, work) {
  try {
    await work();
    checks.push({ name, passed: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    checks.push({ name, passed: false });
    console.error(`FAIL  ${name}\n${error.stack || error}`);
  }
}

await test('v1.0 settings migrate sequentially and preserve API behavior', async () => {
  const migrated = storage.migrateRecord('settings', await fixture('v1.0.0-settings.json'), 1);
  assert.equal(migrated.envelope.schemaVersion, storage.SCHEMA_VERSION);
  assert.equal(migrated.envelope.data.dataSource, 'api');
  assert.equal(migrated.envelope.data.showFollowers, true);
  assert.equal(migrated.envelope.data.refreshMinutes, 60);
});

await test('v1.1 website settings migrate to the six-hour floor', async () => {
  const migrated = storage.migrateRecord('settings', await fixture('v1.1.0-settings.json'), 2);
  assert.equal(migrated.envelope.data.dataSource, 'web');
  assert.equal(migrated.envelope.data.refreshMinutes, 360);
  assert.equal(migrated.envelope.data.showSourceStatus, true);
});

await test('v1.2 settings migrate to session-aware schema v4', async () => {
  const legacy = await fixture('v1.2.0-settings.json');
  const first = storage.migrateRecord('settings', legacy, 3);
  const second = storage.migrateRecord('settings', first.envelope, 4);
  assert.equal(first.changed, true);
  assert.equal(first.envelope.data.tokenMode, 'session');
  assert.equal(second.changed, false);
});

await test('current settings migration is idempotent', async () => {
  const current = await fixture('current-settings.json');
  const migrated = storage.migrateRecord('settings', current, 5);
  assert.equal(migrated.changed, false);
  assert.deepEqual(migrated.envelope.data, current.data);
});

await test('corrupt settings restore last-known-good and record redacted quarantine metadata', async () => {
  Object.keys(area.values).forEach((key) => delete area.values[key]);
  Object.keys(sessionArea.values).forEach((key) => delete sessionArea.values[key]);
  const saved = await storage.setSettings({ username: 'safe-user', dataSource: 'api' });
  area.values.settings = {
    schemaVersion: storage.SCHEMA_VERSION,
    savedAt: 10,
    generation: null,
    data: { username: 42, token: 'must-not-leak' },
  };
  const restored = await storage.getSettings();
  assert.equal(restored.username, saved.username);
  assert.equal(area.values.settings.schemaVersion, storage.SCHEMA_VERSION);
  const quarantine = JSON.stringify(area.values.starboardQuarantine);
  assert.match(quarantine, /invalid username|invalid data source/);
  assert.doesNotMatch(quarantine, /must-not-leak/);
});

await test('PATs default to session storage, can opt into persistence, and clear on website mode', async () => {
  Object.keys(area.values).forEach((key) => delete area.values[key]);
  Object.keys(sessionArea.values).forEach((key) => delete sessionArea.values[key]);
  const sessionSettings = await storage.setSettings({
    username: 'octocat',
    dataSource: 'api',
    token: 'session-secret',
  });
  assert.equal(sessionSettings.tokenMode, 'session');
  assert.equal(area.values.settings.data.token, '');
  assert.equal(sessionArea.values.starboardSessionToken.data.token, 'session-secret');
  assert.equal((await storage.getSettings()).token, 'session-secret');

  await storage.setSettings({ tokenMode: 'persistent' });
  assert.equal(area.values.settings.data.token, 'session-secret');
  assert.equal(sessionArea.values.starboardSessionToken, undefined);

  await storage.setSettings({ dataSource: 'web' });
  assert.equal(area.values.settings.data.token, '');
  assert.equal((await storage.getSettings()).token, '');
});

await test('refresh cache and baseline commit with one generation', async () => {
  const generation = 'generation-1';
  const repo = {
    id: 1,
    name: 'demo',
    full_name: 'octocat/demo',
    stargazers_count: 4,
    forks_count: 2,
  };
  const cache = {
    profile: { login: 'octocat' },
    repos: [repo],
    fetchedAt: 100,
    source: 'api',
    confidence: 'exact',
  };
  const baseline = storage.snapshotOf([repo], { now: 100, generation });
  await storage.commitRefresh(cache, baseline, generation);
  assert.equal(area.values.cache.generation, generation);
  assert.equal(area.values.baseline.generation, generation);
  assert.equal(area.values.cache.data.generation, generation);
  assert.equal(area.values.baseline.data.generation, generation);
});

await test('equivalent refreshes coalesce and repeated rebases queue exactly once', async () => {
  const gates = [];
  const calls = [];
  const coordinator = createRefreshCoordinator(async (intent) => {
    calls.push(intent);
    return new Promise((resolveGate) => gates.push(() => resolveGate(intent)));
  });
  const first = coordinator.request({ source: 'api', accountKey: 'a', reasons: ['manual'] });
  const shared = coordinator.request({ source: 'api', accountKey: 'a', reasons: ['alarm'] });
  await new Promise((resolveTick) => setTimeout(resolveTick, 0));
  const rebaseOne = coordinator.request({ source: 'api', accountKey: 'a', rebase: true });
  const rebaseTwo = coordinator.request({ source: 'api', accountKey: 'a', rebase: true });
  assert.equal(calls.length, 1);
  gates.shift()();
  await Promise.all([first, shared]);
  await new Promise((resolveTick) => setTimeout(resolveTick, 0));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].rebase, true);
  gates.shift()();
  await Promise.all([rebaseOne, rebaseTwo]);
  assert.equal(calls.length, 2);
});

await test('Retry-After is honored before a bounded retry', async () => {
  const sleeps = [];
  let attempt = 0;
  const response = (status, body, headers = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    text: async () => body,
  });
  const result = await requestText('https://example.invalid', {
    fetchImpl: async () => {
      attempt += 1;
      return attempt === 1
        ? response(429, '', { 'retry-after': '2' })
        : response(200, 'ok');
    },
    sleep: async (ms) => sleeps.push(ms),
    now: () => 1000,
    random: () => 0,
  });
  assert.equal(result.value, 'ok');
  assert.equal(result.attempts, 2);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(parseRetryAfter('2', 1000), 3000);
});

await test('request timeout aborts and reports a normalized code', async () => {
  await assert.rejects(
    requestText('https://example.invalid', {
      fetchImpl: async (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
      timeoutMs: 5,
      retries: 0,
    }),
    (error) => error instanceof RequestPolicyError && error.code === 'TIMEOUT',
  );
});

await test('missing REST quota headers stay nullable and Link relations parse', async () => {
  const response = new Response('{}', { status: 200 });
  assert.deepEqual(readRate(response), {
    remaining: null,
    limit: null,
    resetAt: null,
  });
  assert.deepEqual(
    parseLinkHeader(
      '<https://api.github.com/items?page=2>; rel="next", ' +
        '<https://api.github.com/items?page=4>; rel="last"',
    ),
    {
      next: 'https://api.github.com/items?page=2',
      last: 'https://api.github.com/items?page=4',
    },
  );
});

await test('REST adapter follows Link pagination and reuses ETag snapshots', async () => {
  const requests = [];
  const profile = {
    login: 'octocat',
    name: 'The Octocat',
    avatar_url: 'https://example.invalid/avatar.png',
    html_url: 'https://github.com/octocat',
    public_repos: 2,
    followers: 10,
  };
  const repo = (id, name) => ({
    id,
    name,
    full_name: `octocat/${name}`,
    html_url: `https://github.com/octocat/${name}`,
    stargazers_count: id,
    forks_count: 0,
    private: false,
    fork: false,
    archived: false,
  });
  const firstFetch = async (url, options) => {
    requests.push({ url, headers: options.headers });
    const parsed = new URL(url);
    if (parsed.pathname === '/users/octocat') {
      return new Response(JSON.stringify(profile), {
        status: 200,
        headers: { etag: '"profile"', 'x-ratelimit-remaining': '59' },
      });
    }
    const page = parsed.searchParams.get('page');
    const headers =
      page === '1'
        ? {
            etag: '"page-1"',
            link:
              '<https://api.github.com/users/octocat/repos?type=owner&sort=updated&per_page=100&page=2>; rel="next"',
          }
        : { etag: '"page-2"' };
    return new Response(JSON.stringify([repo(Number(page), `repo-${page}`)]), {
      status: 200,
      headers,
    });
  };
  const first = await fetchAccount(
    { username: 'octocat', token: '' },
    { fetchImpl: firstFetch, sleep: async () => {}, now: () => 1000 },
  );
  assert.equal(first.repos.length, 2);
  assert.equal(first.pagesFetched, 2);
  assert.equal(first.complete, true);

  const conditionalHeaders = [];
  const second = await fetchAccount(
    { username: 'octocat', token: '' },
    {
      previous: first,
      fetchImpl: async (_url, options) => {
        conditionalHeaders.push(options.headers['If-None-Match']);
        return new Response(null, {
          status: 304,
          headers: { etag: options.headers['If-None-Match'] },
        });
      },
      sleep: async () => {},
      now: () => 2000,
    },
  );
  assert.deepEqual(second.repos, first.repos);
  assert.equal(second.pagesFetched, 2);
  assert.deepEqual(conditionalHeaders, ['"profile"', '"page-1"', '"page-2"']);
});

await test('hostile backup documents are rejected without touching stored state', async () => {
  Object.keys(area.values).forEach((key) => delete area.values[key]);
  Object.keys(sessionArea.values).forEach((key) => delete sessionArea.values[key]);
  const settings = { ...storage.DEFAULTS, username: 'octocat', dataSource: 'api' };
  const good = await createBackup({ settings, now: Date.UTC(2026, 6, 31) });
  // Structural guards only get a chance to run if the document is re-sealed;
  // otherwise the checksum — correctly — rejects everything first.
  const reseal = async (mutate) => {
    const copy = JSON.parse(JSON.stringify(good));
    mutate(copy);
    const { checksum, ...core } = copy;
    copy.checksum = { algorithm: 'SHA-256', value: await sha256Hex(stableStringify(core)) };
    return JSON.stringify(copy);
  };
  const rebuild = async (mutate) => {
    const copy = JSON.parse(JSON.stringify(good));
    mutate(copy);
    return JSON.stringify(copy);
  };

  // Tampering that the checksum alone must catch.
  const tampered = [
    ['absent checksum', (doc) => delete doc.checksum, /checksum/i],
    ['wrong algorithm', (doc) => { doc.checksum.algorithm = 'MD5'; }, /checksum/i],
    ['forged checksum value', (doc) => { doc.checksum.value = 'f'.repeat(64); }, /checksum/i],
    ['edited record with the original checksum', (doc) => {
      doc.records.settings.data.username = 'attacker';
    }, /checksum/i],
  ];
  for (const [name, mutate, pattern] of tampered) {
    const text = await rebuild(mutate);
    await assert.rejects(
      validateBackupText(text),
      (error) => {
        assert.match(error.message, pattern, `${name}: unexpected message ${error.message}`);
        return true;
      },
      `${name} must be rejected`,
    );
  }

  // Structurally hostile documents that carry a valid checksum.
  const cases = [
    ['unknown record', (doc) => { doc.records.evil = { schemaVersion: 1, data: {} }; }, /unsupported/i],
    ['missing settings', (doc) => delete doc.records.settings, /settings/i],
    ['non-object records', (doc) => { doc.records = ['settings']; }, /records/i],
    ['array record', (doc) => { doc.records.settings = []; }, /invalid|settings/i],
    ['wrong format', (doc) => { doc.format = 'not-starboard'; }, /not a StarBoard backup/i],
    ['wrong format version', (doc) => { doc.formatVersion = 99; }, /unsupported backup format/i],
    ['bad timestamp', (doc) => { doc.exportedAt = 'never'; }, /timestamp/i],
    [
      'record from a newer StarBoard',
      (doc) => { doc.records.settings.schemaVersion = storage.SCHEMA_VERSION + 1; },
      /newer StarBoard/i,
    ],
    [
      'credential smuggled into settings',
      (doc) => { doc.records.settings.data.token = 'stolen'; },
      /credential/i,
    ],
  ];

  for (const [name, mutate, pattern] of cases) {
    const text = await reseal(mutate);
    await assert.rejects(
      validateBackupText(text),
      (error) => {
        assert.match(error.message, pattern, `${name}: unexpected message ${error.message}`);
        return true;
      },
      `${name} must be rejected`,
    );
  }

  // Prototype pollution through a record name.
  const polluted = JSON.parse(JSON.stringify(good));
  const raw = JSON.stringify(polluted).replace(
    '"records":{',
    '"records":{"__proto__":{"schemaVersion":1,"data":{}},',
  );
  await assert.rejects(validateBackupText(raw));
  assert.equal({}.schemaVersion, undefined, 'Object.prototype must be untouched');

  // Oversized payloads are refused before parsing work is done.
  await assert.rejects(validateBackupText('x'.repeat(6 * 1024 * 1024)), /5 MiB|JSON/i);
  await assert.rejects(validateBackupText(''), /empty/i);

  // Nothing above may have altered stored state.
  assert.equal(Object.keys(area.values).filter((k) => k === 'cache').length, 0);

  // The untampered document still validates.
  const valid = await validateBackupText(JSON.stringify(good));
  assert.equal(valid.records.settings.username, 'octocat');
});

await test('CSV quoting and formula guards follow RFC 4180 and OWASP', async () => {
  const cache = {
    profile: { login: 'octocat' },
    fetchedAt: Date.UTC(2026, 6, 31, 12),
    source: 'api',
    confidence: 'exact',
    repos: [
      // Names a spreadsheet would otherwise execute or mis-split.
      // GitHub logins cannot start with these, so full_name never does today —
      // the guard exists for the columns this export will grow.
      { full_name: '=cmd|calc/x', stargazers_count: 1, forks_count: 0, private: false },
      { full_name: '+add/x', stargazers_count: 2, forks_count: 0, private: false },
      { full_name: '-minus/x', stargazers_count: 3, forks_count: 0, private: false },
      { full_name: '@at/x', stargazers_count: 4, forks_count: 0, private: false },
      { full_name: 'octocat/a,comma', stargazers_count: 5, forks_count: 0, private: false },
      { full_name: 'octocat/a"quote', stargazers_count: 6, forks_count: 0, private: false },
      { full_name: 'octocat/a\r\nnewline', stargazers_count: 7, forks_count: 0, private: false },
    ],
  };
  const baseline = {
    at: 1,
    counts: { '=cmd|calc/x': [4, 0] },
  };
  const csv = createCsv({ cache, baseline, includePrivate: true });

  for (const dangerous of ['"\'=cmd|calc', '"\'+add', '"\'-minus', '"\'@at']) {
    assert.ok(csv.includes(dangerous), `formula prefix missing for ${dangerous}`);
  }
  // RFC 4180: quotes double, and commas/CRLF survive inside a quoted field.
  assert.ok(csv.includes('"octocat/a""quote"'));
  assert.ok(csv.includes('"octocat/a,comma"'));
  assert.ok(csv.includes('octocat/a\r\nnewline'));
  assert.ok(csv.startsWith('﻿'), 'Excel needs the UTF-8 BOM');
  assert.ok(csv.endsWith('\r\n'), 'RFC 4180 line endings');

  // A negative delta is a number, not a formula: it must not gain a prefix.
  assert.ok(csv.includes('"-3"'), 'negative deltas must stay numeric');
  assert.ok(!csv.includes("\"'-3\""));
});

await test('an out-of-space write fails loudly and leaves stored data intact', async () => {
  Object.keys(area.values).forEach((key) => delete area.values[key]);
  Object.keys(sessionArea.values).forEach((key) => delete sessionArea.values[key]);
  const saved = await storage.setSettings({ username: 'octocat', dataSource: 'api' });
  const before = clone(area.values);

  // Narrow the budget to just under what the next write needs.
  area.quotaBytes = await area.getBytesInUse(null);
  await assert.rejects(
    storage.setSettings({ username: 'a-much-longer-username-than-before' }),
    (error) => {
      assert.equal(error.code, 'STORAGE_QUOTA_EXCEEDED');
      assert.equal(error.name, 'StorageQuotaError');
      // The message must name a consumer and a remedy, not leak "QUOTA_BYTES".
      assert.match(error.message, /out of local storage/i);
      assert.match(error.message, /prune trend history/i);
      assert.doesNotMatch(error.message, /QUOTA_BYTES/);
      return true;
    },
  );
  area.quotaBytes = Infinity;

  // Chrome rejects the whole set, so nothing may have changed.
  assert.deepEqual(area.values, before);
  assert.equal((await storage.getSettings()).username, saved.username);
});

await test('history is not mirrored into the recovery copy', async () => {
  Object.keys(area.values).forEach((key) => delete area.values[key]);
  Object.keys(sessionArea.values).forEach((key) => delete sessionArea.values[key]);
  await storage.setSettings({ username: 'octocat', dataSource: 'api' });
  await storage.setHistory({
    formatVersion: 2,
    repos: [['id:1', 'octocat/a', 0]],
    snapshots: [
      {
        day: '2026-07-30',
        at: Date.parse('2026-07-30T00:00:00.000Z'),
        source: 'api',
        confidence: 'exact',
        stars: [5],
        forks: [1],
        approx: [],
      },
    ],
  });
  assert.ok(area.values.history, 'history is stored');
  // The largest record must not be duplicated into the shadow copy: doing so
  // doubled the biggest consumer against a 5 MiB budget on Chrome <= 113.
  const backup = area.values.starboardLastKnownGood.data;
  assert.equal(backup.history, undefined);
  assert.ok(backup.settings, 'settings are still recoverable');
});

await test('website count parsing covers full, abbreviated, and malformed input', async () => {
  const { parseCount } = await import('../src/lib/scrape.js');
  // What the repositories tab actually renders (verified 2026-07-31): full
  // numbers, comma grouped, never abbreviated — so `approximate` stays false.
  assert.deepEqual(parseCount('52'), [52, false]);
  assert.deepEqual(parseCount('1,234'), [1234, false]);
  assert.deepEqual(parseCount('241,273'), [241273, false]);
  assert.deepEqual(parseCount('  8  '), [8, false]);
  assert.deepEqual(parseCount('0'), [0, false]);

  // Retained as a drift guard: if the tab ever abbreviates, the value is
  // flagged approximate rather than silently parsed as 1.
  assert.deepEqual(parseCount('1.2k'), [1200, true]);
  assert.deepEqual(parseCount('12k'), [12000, true]);
  assert.deepEqual(parseCount('1.3m'), [1300000, true]);
  assert.deepEqual(parseCount('1.2K'), [1200, true]);

  // Malformed input must never throw and never invent a count.
  assert.deepEqual(parseCount(''), [0, false]);
  assert.deepEqual(parseCount(null), [0, false]);
  assert.deepEqual(parseCount(undefined), [0, false]);
  assert.deepEqual(parseCount('Star'), [0, false]);
  assert.deepEqual(parseCount('1.2x'), [0, false]);
  assert.deepEqual(parseCount('--'), [0, false]);
});

await test('website adapter pages over an immutable ordering', async () => {
  const { reposUrl } = await import('../src/lib/scrape.js');
  const url = reposUrl('octocat', 2);
  assert.match(url, /sort=name/);
  assert.doesNotMatch(url, /sort=stargazers/);
  assert.match(url, /[?&]page=2\b/);
  assert.match(url, /tab=repositories/);
});

await test('REST adapter pages over an immutable ordering', async () => {
  const listUrls = [];
  const profile = {
    login: 'octocat',
    name: 'The Octocat',
    avatar_url: '',
    html_url: 'https://github.com/octocat',
    public_repos: 1,
    followers: 0,
  };
  await fetchAccount(
    { username: 'octocat', token: '' },
    {
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/users/octocat') {
          return new Response(JSON.stringify(profile), { status: 200 });
        }
        listUrls.push(url);
        return new Response(
          JSON.stringify([
            {
              id: 1,
              name: 'a',
              full_name: 'octocat/a',
              stargazers_count: 5,
              forks_count: 0,
            },
          ]),
          { status: 200 },
        );
      },
      sleep: async () => {},
      now: () => 1000,
    },
  );
  // Ranking is applied client-side; the wire order must not depend on a value
  // that changes while pagination is in flight.
  assert.equal(listUrls.length, 1);
  assert.match(listUrls[0], /sort=full_name/);
  assert.doesNotMatch(listUrls[0], /sort=(updated|stargazers|pushed)/);
});

await test('REST adapter flags repositories dropped between pages', async () => {
  // GitHub says the account owns three; pagination hands back two. That gap is
  // exactly what a mutating sort key used to produce silently, and what
  // lifecycle derivation would otherwise report as a removal.
  const profile = {
    login: 'octocat',
    name: 'The Octocat',
    avatar_url: '',
    html_url: 'https://github.com/octocat',
    public_repos: 3,
    followers: 0,
  };
  const result = await fetchAccount(
    { username: 'octocat', token: '' },
    {
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/users/octocat') {
          return new Response(JSON.stringify(profile), { status: 200 });
        }
        return new Response(
          JSON.stringify([
            { id: 1, name: 'a', full_name: 'octocat/a', stargazers_count: 1, forks_count: 0 },
            { id: 2, name: 'b', full_name: 'octocat/b', stargazers_count: 2, forks_count: 0 },
          ]),
          { status: 200 },
        );
      },
      sleep: async () => {},
      now: () => 1000,
    },
  );
  assert.equal(result.repos.length, 2);
  assert.equal(result.complete, false);
  assert.equal(result.partialReason, 'shortfall');
  assert.equal(result.shortfall, 1);
  assert.equal(result.confidence, 'partial');
});

await test('REST adapter reports a full listing as complete', async () => {
  const profile = {
    login: 'octocat',
    name: 'The Octocat',
    avatar_url: '',
    html_url: 'https://github.com/octocat',
    public_repos: 2,
    followers: 0,
  };
  const result = await fetchAccount(
    { username: 'octocat', token: '' },
    {
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/users/octocat') {
          return new Response(JSON.stringify(profile), { status: 200 });
        }
        return new Response(
          JSON.stringify([
            { id: 1, name: 'a', full_name: 'octocat/a', stargazers_count: 1, forks_count: 0 },
            { id: 2, name: 'b', full_name: 'octocat/b', stargazers_count: 2, forks_count: 0 },
          ]),
          { status: 200 },
        );
      },
      sleep: async () => {},
      now: () => 1000,
    },
  );
  assert.equal(result.complete, true);
  assert.equal(result.partialReason, null);
  assert.equal(result.shortfall, 0);
});

await test('REST adapter normalizes exhausted retry responses', async () => {
  await assert.rejects(
    fetchAccount(
      { username: 'octocat', token: '' },
      {
        fetchImpl: async () =>
          new Response(JSON.stringify({ message: 'slow down' }), {
            status: 429,
            headers: { 'retry-after': '1' },
          }),
        sleep: async () => {},
        retries: 0,
        now: () => 1000,
      },
    ),
    (error) =>
      error instanceof GitHubError &&
      error.code === 'RATE_LIMITED' &&
      error.rateLimited === true,
  );
});

await test('REST adapter honors exhausted 403 quota metadata', async () => {
  await assert.rejects(
    fetchAccount(
      { username: 'octocat', token: '' },
      {
        fetchImpl: async () =>
          new Response(JSON.stringify({ message: 'quota exhausted' }), {
            status: 403,
            headers: {
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': '10',
            },
          }),
        sleep: async () => {},
        now: () => 1000,
      },
    ),
    (error) =>
      error instanceof GitHubError &&
      error.code === 'RATE_LIMITED' &&
      error.resetAt === 10_000,
  );
});

await test('shared request policy retries 5xx responses serially', async () => {
  let calls = 0;
  const sleeps = [];
  const result = await requestText('https://example.invalid', {
    fetchImpl: async () => {
      calls += 1;
      return new Response(calls === 1 ? 'unavailable' : 'ok', {
        status: calls === 1 ? 503 : 200,
      });
    },
    sleep: async (ms) => sleeps.push(ms),
    random: () => 0,
    baseDelayMs: 100,
  });
  assert.equal(result.value, 'ok');
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [100]);
});

await test('stable API IDs distinguish rename, addition, and removal', async () => {
  const previous = {
    source: 'api',
    complete: true,
    repos: [
      { id: 1, full_name: 'octocat/old-name' },
      { id: 2, full_name: 'octocat/removed' },
    ],
  };
  const current = {
    source: 'api',
    complete: true,
    repos: [
      { id: 1, full_name: 'octocat/new-name' },
      { id: 3, full_name: 'octocat/added' },
    ],
  };
  const events = deriveLifecycleEvents(previous, current, {
    generation: 'g1',
    now: 100,
    source: 'api',
  });
  assert.deepEqual(
    events.map((event) => [event.type, event.from, event.to]),
    [
      ['renamed', 'octocat/old-name', 'octocat/new-name'],
      ['added', null, 'octocat/added'],
      ['removed', null, 'octocat/removed'],
    ],
  );
  assert.equal(mergeLifecycleEvents(events, events).length, 3);
  assert.equal(acknowledgeLifecycleEvents(events, [events[0].id]).length, 2);
});

await test('website-only unmatched names remain explicit add/remove events', async () => {
  const events = deriveLifecycleEvents(
    {
      source: 'web',
      complete: true,
      repos: [{ id: 'octocat/old', full_name: 'octocat/old' }],
    },
    {
      source: 'web',
      complete: true,
      repos: [{ id: 'octocat/new', full_name: 'octocat/new' }],
    },
    { generation: 'g2', now: 200, source: 'web' },
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ['added', 'removed'],
  );
});

await test('portfolio filters cover language, visibility, state, lifecycle, and activity', async () => {
  const now = Date.UTC(2026, 6, 29);
  const repos = [
    {
      id: 1,
      name: 'active-js',
      full_name: 'octocat/active-js',
      description: 'Current public source',
      language: 'JavaScript',
      private: false,
      fork: false,
      archived: false,
      approx: false,
      pushed_at: new Date(now - 10 * 86_400_000).toISOString(),
    },
    {
      id: 2,
      name: 'old-python-fork',
      full_name: 'octocat/old-python-fork',
      description: 'Archived private fork',
      language: 'Python',
      private: true,
      fork: true,
      archived: true,
      approx: true,
      pushed_at: new Date(now - 500 * 86_400_000).toISOString(),
    },
    {
      id: 3,
      name: 'no-language',
      full_name: 'octocat/no-language',
      description: '',
      language: null,
      private: false,
      fork: false,
      archived: false,
      approx: false,
      pushed_at: null,
    },
  ];
  const events = [
    { type: 'added', to: repos[0].full_name },
    { type: 'renamed', to: repos[1].full_name },
  ];
  const names = (patch) =>
    filterRepositories(repos, { ...emptyPortfolioViewState().active, ...patch }, events, {
      now,
    }).map((repo) => repo.name);

  assert.deepEqual(names({ language: 'JavaScript' }), ['active-js']);
  assert.deepEqual(names({ language: '__none__' }), ['no-language']);
  assert.deepEqual(names({ visibility: 'private', forkStatus: 'all' }), ['old-python-fork']);
  assert.deepEqual(names({ forkStatus: 'forks' }), ['old-python-fork']);
  assert.deepEqual(names({ archivedStatus: 'archived', forkStatus: 'all' }), ['old-python-fork']);
  assert.deepEqual(names({ precision: 'approximate', forkStatus: 'all' }), ['old-python-fork']);
  assert.deepEqual(names({ lifecycle: 'changed', forkStatus: 'all' }), [
    'active-js',
    'old-python-fork',
  ]);
  assert.deepEqual(names({ lifecycle: 'renamed', forkStatus: 'all' }), ['old-python-fork']);
  assert.deepEqual(names({ activity: '30' }), ['active-js']);
  assert.deepEqual(names({ activity: 'stale', forkStatus: 'all' }), ['old-python-fork']);
  assert.deepEqual(names({ activity: 'unknown' }), ['no-language']);
});

await test('saved portfolio views activate, rename, delete, and reject duplicates', async () => {
  let state = emptyPortfolioViewState();
  state = patchActivePortfolioFilters(state, {
    query: 'demo',
    language: 'TypeScript',
    sortKey: 'updated',
  });
  state = savePortfolioView(state, 'Maintained', 'view-1');
  assert.equal(state.activeViewId, 'view-1');
  assert.equal(state.views[0].filters.query, 'demo');

  state = patchActivePortfolioFilters(state, { query: 'changed' });
  assert.equal(state.activeViewId, null);
  state = activatePortfolioView(state, 'view-1');
  assert.equal(state.active.query, 'demo');
  assert.equal(state.active.sortKey, 'updated');

  state = renamePortfolioView(state, 'view-1', 'Active work');
  assert.equal(state.views[0].name, 'Active work');
  assert.throws(
    () => savePortfolioView(state, 'active work', 'view-2'),
    /already exists/,
  );
  state = deletePortfolioView(state, 'view-1');
  assert.equal(state.activeViewId, null);
  assert.equal(state.views.length, 0);
});

await test('destructive portfolio changes keep one expiring recovery snapshot', async () => {
  Object.keys(area.values).forEach((key) => delete area.values[key]);
  const cache = {
    profile: { login: 'octocat' },
    repos: [
      {
        id: 1,
        name: 'demo',
        full_name: 'octocat/demo',
        stargazers_count: 4,
        forks_count: 2,
      },
    ],
    fetchedAt: 100,
    source: 'api',
    confidence: 'exact',
  };
  const baseline = storage.snapshotOf(cache.repos, { now: 100, generation: 'undo-g1' });
  await storage.commitRefresh(cache, baseline, 'undo-g1');
  await storage.setNotificationState({
    ...emptyNotificationState(),
    pending: [
      {
        id: 'undo-alert',
        title: 'Portfolio milestone',
        message: 'Your repositories reached 100 stars.',
        createdAt: 100,
      },
    ],
  });

  await storage.clearPortfolioData();
  assert.equal(await storage.getCache(), null);
  assert.equal(await storage.getBaseline(), null);
  assert.equal((await storage.getNotificationState()).pending.length, 0);
  assert.equal((await storage.getUndoStatus()).scope, 'clear-portfolio');

  const restored = await storage.restoreUndoSnapshot();
  assert.equal(restored.cache.generation, 'undo-g1');
  assert.equal(restored.baseline.generation, 'undo-g1');
  assert.equal(restored.history.snapshots.length, 1);
  assert.equal(restored.notificationState.pending[0].id, 'undo-alert');
  assert.equal((await storage.getUndoStatus()).available, false);

  await storage.createUndoSnapshot('baseline-reset', ['baseline']);
  area.values[storage.STORAGE_KEYS.undo].data.expiresAt = Date.now() - 1;
  assert.equal((await storage.getUndoStatus()).available, false);
  assert.equal(area.values[storage.STORAGE_KEYS.undo], undefined);
});

await test('saved portfolio view deletion is recoverable through the shared undo record', async () => {
  Object.keys(area.values).forEach((key) => delete area.values[key]);
  await storage.setSettings({
    sortKey: 'name',
    includeForks: true,
    includeArchived: false,
  });
  let views = await storage.getPortfolioViewState();
  assert.equal(views.active.sortKey, 'name');
  assert.equal(views.active.forkStatus, 'all');
  assert.equal(views.active.archivedStatus, 'active');

  views = await storage.setActivePortfolioFilters({
    language: 'JavaScript',
    visibility: 'public',
  });
  views = await storage.saveCurrentPortfolioView('JavaScript sources');
  const savedId = views.activeViewId;
  await storage.createUndoSnapshot('portfolio-view-change', [
    storage.STORAGE_KEYS.portfolioViews,
  ]);
  views = await storage.deleteSavedPortfolioView(savedId);
  assert.equal(views.views.length, 0);

  const restored = await storage.restoreUndoSnapshot();
  assert.equal(restored.portfolioViews.views[0].name, 'JavaScript sources');
  assert.equal(restored.portfolioViews.active.language, 'JavaScript');
});

await test('daily history replaces same-day points and follows API IDs across renames', async () => {
  const firstAt = Date.UTC(2026, 0, 1, 8);
  const first = {
    source: 'api',
    confidence: 'exact',
    repos: [
      {
        id: 7,
        full_name: 'octocat/old-name',
        stargazers_count: 10,
        forks_count: 2,
        private: false,
      },
    ],
  };
  let history = recordDailyHistory(null, first, { now: firstAt });
  history = recordDailyHistory(
    history,
    {
      ...first,
      repos: [{ ...first.repos[0], stargazers_count: 11 }],
    },
    { now: firstAt + 3_600_000 },
  );
  assert.equal(history.snapshots.length, 1);
  assert.equal(history.repos.length, 1);
  assert.equal(history.snapshots[0].stars[0], 11);

  const renamed = {
    ...first.repos[0],
    full_name: 'octocat/new-name',
    stargazers_count: 18,
  };
  history = recordDailyHistory(
    history,
    { source: 'api', confidence: 'exact', repos: [renamed] },
    { now: firstAt + 7 * 86_400_000 },
  );
  const comparison = historyPointForRepo(history, renamed, 7, {
    now: firstAt + 7 * 86_400_000,
  });
  // Identity follows the numeric API id, so the delta spans the rename. The
  // dictionary holds one name per identity and keeps it current, so a
  // historical point reports the repository's present name rather than the one
  // it carried that day — the series stays one continuous line instead of
  // appearing to change subject halfway through.
  assert.equal(comparison.fullName, 'octocat/new-name');
  assert.equal(comparison.stars, 11);
  assert.equal(renamed.stargazers_count - comparison.stars, 7);
});

await test('history keeps gaps distinct from measured zeros', async () => {
  const day = Date.UTC(2026, 0, 1, 12);
  const base = { source: 'api', confidence: 'exact' };
  // Day one sees both repositories; day two sees only the first.
  let history = recordDailyHistory(
    null,
    {
      ...base,
      repos: [
        { id: 1, full_name: 'octocat/a', stargazers_count: 5, forks_count: 0, private: false },
        { id: 2, full_name: 'octocat/b', stargazers_count: 0, forks_count: 0, private: false },
      ],
    },
    { now: day },
  );
  history = recordDailyHistory(
    history,
    {
      ...base,
      repos: [
        { id: 1, full_name: 'octocat/a', stargazers_count: 6, forks_count: 0, private: false },
      ],
    },
    { now: day + 86_400_000 },
  );

  const second = history.snapshots[1];
  const indexOfB = history.repos.findIndex((entry) => entry[0] === 'id:2');
  // A measured zero on day one, an explicit gap on day two. Conflating them
  // would invent a fake -0 delta and a phantom data point.
  assert.equal(history.snapshots[0].stars[indexOfB], 0);
  assert.equal(second.stars[indexOfB], null);

  const rows = historyRows(history);
  assert.equal(rows.filter((row) => row.fullName === 'octocat/b').length, 1);
  assert.equal(rows.filter((row) => row.fullName === 'octocat/a').length, 2);
});

await test('a full year of a large portfolio fits inside the storage cap', async () => {
  // The previous format cost ~26 KB/day at 206 repositories, so the 2 MiB cap
  // held about 78 days and the shipped 90-day trend could never resolve.
  const start = Date.UTC(2026, 0, 1, 12);
  const repos = Array.from({ length: 500 }, (_, index) => ({
    id: index,
    full_name: `octocat/repository-with-a-realistic-name-${index}`,
    stargazers_count: 1000 + index,
    forks_count: 25,
    private: false,
  }));
  let history = null;
  for (let day = 0; day < 365; day += 1) {
    history = recordDailyHistory(
      history,
      { source: 'api', confidence: 'exact', repos },
      { now: start + day * 86_400_000 },
    );
  }
  assert.equal(history.snapshots.length, 365);
  assert.equal(history.repos.length, 500);
  assert.ok(
    historyByteSize(history) <= HISTORY_MAX_BYTES,
    `365 days x 500 repositories must fit in 2 MiB, used ${historyByteSize(history)}`,
  );
  assert.equal(historyRetainedDays(history, { now: start + 364 * 86_400_000 }), 364);
});

await test('history reports the range it can actually serve', async () => {
  const start = Date.UTC(2026, 0, 1, 12);
  let history = null;
  for (const offset of [0, 1, 2]) {
    history = recordDailyHistory(
      history,
      {
        source: 'api',
        confidence: 'exact',
        repos: [
          { id: 1, full_name: 'octocat/a', stargazers_count: offset, forks_count: 0, private: false },
        ],
      },
      { now: start + offset * 86_400_000 },
    );
  }
  assert.equal(historyRetainedDays(history, { now: start + 2 * 86_400_000 }), 2);
  assert.equal(historyRetainedDays(emptyHistoryForTest()), 0);
});

function emptyHistoryForTest() {
  return { formatVersion: 2, repos: [], snapshots: [] };
}

await test('history enforces 365 UTC days and the two-megabyte hard cap', async () => {
  const start = Date.UTC(2025, 0, 1, 12);
  const legacySeed = {
    formatVersion: 1,
    snapshots: Array.from({ length: 369 }, (_, day) => ({
      day: new Date(start + day * 86_400_000).toISOString().slice(0, 10),
      at: start + day * 86_400_000,
      source: 'web',
      confidence: 'approximate',
      repos: [
        {
          key: 'name:octocat/demo',
          fullName: 'octocat/demo',
          stars: day,
          forks: 0,
          private: false,
          approximate: true,
        },
      ],
    })),
  };
  const historySeed = migrateHistoryToV2(legacySeed);
  const history = recordDailyHistory(
    historySeed,
    {
      source: 'web',
      confidence: 'approximate',
      repos: [
        {
          id: 'octocat/demo',
          full_name: 'octocat/demo',
          stargazers_count: 369,
          forks_count: 0,
          private: false,
          approx: true,
        },
      ],
    },
    { now: start + 369 * 86_400_000 },
  );
  assert.equal(history.snapshots.length, 365);
  assert.ok(historyByteSize(history) <= HISTORY_MAX_BYTES);

  const oversized = recordDailyHistory(
    null,
    {
      source: 'api',
      confidence: 'exact',
      repos: Array.from({ length: 100 }, (_, index) => ({
        id: index,
        full_name: `octocat/${'long-name-'.repeat(8)}${index}`,
        stargazers_count: index,
        forks_count: 0,
        private: false,
      })),
    },
    { now: start, maxBytes: 800 },
  );
  assert.ok(historyByteSize(oversized) <= 800);
  assert.equal(oversized.snapshots[0].truncated, true);
});

await test('portable backups are checksummed, credential-free, and privacy-filtered', async () => {
  const exportedAt = Date.UTC(2026, 6, 29, 12);
  const settings = {
    ...storage.DEFAULTS,
    username: 'octocat',
    dataSource: 'api',
    refreshMinutes: 60,
    tokenMode: 'persistent',
    token: 'must-never-export',
  };
  const repos = [
    {
      id: 1,
      name: 'public-demo',
      full_name: 'octocat/public-demo',
      stargazers_count: 10,
      forks_count: 2,
      private: false,
      fork: false,
      archived: false,
      description: '',
    },
    {
      id: 2,
      name: 'private-demo',
      full_name: 'octocat/private-demo',
      stargazers_count: 7,
      forks_count: 1,
      private: true,
      fork: false,
      archived: false,
      description: '',
    },
  ];
  const cache = {
    profile: { login: 'octocat' },
    repos,
    fetchedAt: exportedAt,
    source: 'api',
    confidence: 'exact',
    lifecycleEvents: [
      {
        id: 'private-removed',
        type: 'removed',
        repoId: 3,
        from: null,
        to: 'octocat/private-removed',
        at: exportedAt,
        source: 'api',
      },
    ],
  };
  const baseline = storage.snapshotOf(repos, { now: exportedAt - 1000 });
  let history = recordDailyHistory(null, cache, { now: exportedAt });
  history = recordDailyHistory(
    history,
    {
      ...cache,
      repos: repos.map((repo) =>
        repo.full_name === 'octocat/private-demo' ? { ...repo, private: false } : repo,
      ),
    },
    { now: exportedAt - 86_400_000 },
  );
  let portfolioViews = patchActivePortfolioFilters(emptyPortfolioViewState(), {
    query: 'private-demo',
    visibility: 'private',
    forkStatus: 'all',
  });
  portfolioViews = savePortfolioView(
    portfolioViews,
    'private-demo focus',
    'portable-view-1',
  );

  const publicBackup = await createBackup({
    settings,
    cache,
    baseline,
    history,
    notificationConfig: {
      ...DEFAULT_NOTIFICATION_CONFIG,
      portfolioMilestone: 250,
    },
    portfolioViews,
    now: exportedAt,
  });
  const publicText = JSON.stringify(publicBackup);
  assert.doesNotMatch(publicText, /must-never-export|private-demo|private-removed/);
  const publicPreview = await validateBackupText(publicText);
  assert.equal(publicPreview.summary.repositories, 1);
  assert.equal(publicPreview.summary.historyDays, 0);
  assert.equal(publicPreview.summary.notificationConfig, true);
  assert.equal(publicPreview.summary.savedViews, 1);
  assert.equal(publicPreview.records.notificationConfig.portfolioMilestone, 250);
  assert.equal(publicPreview.records.notificationState, undefined);
  assert.equal(publicPreview.records.portfolioViews.active.query, '');
  assert.equal(publicPreview.records.portfolioViews.views[0].name, 'Redacted view 1');
  assert.equal(publicPreview.records.settings.token, '');

  const privateBackup = await createBackup({
    settings,
    cache,
    baseline,
    history,
    notificationConfig: {
      ...DEFAULT_NOTIFICATION_CONFIG,
      portfolioMilestone: 250,
    },
    portfolioViews,
    includePrivate: true,
    includeHistory: true,
    now: exportedAt,
  });
  const privateText = JSON.stringify(privateBackup);
  assert.match(privateText, /private-demo/);
  assert.doesNotMatch(privateText, /must-never-export/);
  const privatePreview = await validateBackupText(privateText);
  assert.equal(privatePreview.summary.privateRepositories, 1);
  assert.equal(privatePreview.summary.historyPoints, 4);

  const tampered = JSON.stringify({
    ...privateBackup,
    exportedAt: new Date(exportedAt + 1000).toISOString(),
  });
  await assert.rejects(validateBackupText(tampered), /checksum does not match/);

  const currentCsv = createCsv({ cache, baseline, history });
  assert.match(currentCsv, /octocat\/public-demo/);
  assert.doesNotMatch(currentCsv, /octocat\/private-demo/);
  assert.match(currentCsv, /stars_delta/);
  const historyCsv = createCsv({
    cache,
    baseline,
    history,
    includePrivate: true,
    includeHistory: true,
  });
  assert.match(historyCsv, /octocat\/private-demo/);
});

await test('validated imports preserve local credentials and support full rollback', async () => {
  Object.keys(area.values).forEach((key) => delete area.values[key]);
  Object.keys(sessionArea.values).forEach((key) => delete sessionArea.values[key]);
  await storage.setSettings({
    username: 'before',
    dataSource: 'api',
    refreshMinutes: 60,
    token: 'session-stays-local',
  });
  await storage.setNotificationConfig({
    enabled: false,
    portfolioMilestone: 100,
  });
  await storage.setActivePortfolioFilters({ query: 'before-view' });
  await storage.saveCurrentPortfolioView('Before view');
  const beforeCache = {
    profile: { login: 'before' },
    repos: [
      {
        id: 1,
        name: 'before',
        full_name: 'before/repo',
        stargazers_count: 1,
        forks_count: 0,
      },
    ],
    fetchedAt: 100,
    source: 'api',
    confidence: 'exact',
  };
  await storage.commitRefresh(
    beforeCache,
    storage.snapshotOf(beforeCache.repos, { now: 100 }),
    'before-generation',
  );

  const importedCache = {
    ...beforeCache,
    profile: { login: 'after' },
    repos: [
      {
        ...beforeCache.repos[0],
        id: 2,
        name: 'after',
        full_name: 'after/repo',
        stargazers_count: 9,
      },
    ],
  };
  const document = await createBackup({
    settings: {
      ...storage.DEFAULTS,
      username: 'after',
      dataSource: 'api',
      refreshMinutes: 120,
    },
    cache: importedCache,
    baseline: storage.snapshotOf(importedCache.repos, { now: 90 }),
    history: recordDailyHistory(null, importedCache, { now: 100 }),
    notificationConfig: {
      ...DEFAULT_NOTIFICATION_CONFIG,
      enabled: false,
      portfolioMilestone: 250,
    },
    portfolioViews: savePortfolioView(
      patchActivePortfolioFilters(emptyPortfolioViewState(), {
        query: 'after-view',
        language: 'Rust',
      }),
      'After view',
      'imported-view',
    ),
    includeHistory: true,
    now: 100,
  });
  const preview = await validateBackupText(JSON.stringify(document));
  const applied = await storage.applyImportedState(preview.records);
  assert.equal(applied.settings.username, 'after');
  assert.equal((await storage.getSettings()).token, 'session-stays-local');
  assert.equal(applied.cache.generation, applied.baseline.generation);
  assert.equal((await storage.getNotificationConfig()).portfolioMilestone, 250);
  assert.equal((await storage.getPortfolioViewState()).active.query, 'after-view');

  const restored = await storage.restoreUndoSnapshot();
  assert.equal(restored.settings.username, 'before');
  assert.equal(restored.cache.profile.login, 'before');
  assert.equal(restored.notificationConfig.portfolioMilestone, 100);
  assert.equal(restored.portfolioViews.active.query, 'before-view');
  assert.equal((await storage.getSettings()).token, 'session-stays-local');
});

await test('diagnostics expose allow-listed health metadata without sensitive values', async () => {
  const diagnostics = buildDiagnostics({
    manifest: {
      version: '1.2.0',
      minimum_chrome_version: '110',
      manifest_version: 3,
    },
    settings: {
      dataSource: 'api',
      token: 'ghp_diagnostic-secret',
      username: 'private-owner',
    },
    cache: {
      source: 'api',
      requestedSource: 'api',
      fetchedAt: Date.UTC(2026, 6, 29),
      complete: false,
      confidence: 'partial',
      partialReason: 'rate-limited',
      repos: [{ full_name: 'private-owner/private-repo', private: true }],
      error: {
        code: 'RATE_LIMITED',
        message: 'private-owner/private-repo failed with ghp_diagnostic-secret',
        status: 429,
        rateLimited: true,
        at: Date.UTC(2026, 6, 29, 1),
        retryAt: Date.UTC(2026, 6, 29, 2),
      },
      rawHtml: '<p>private-owner/private-repo</p>',
    },
    storage: {
      schemaVersion: 4,
      settingsStored: true,
      cacheStored: true,
      baselineStored: true,
      historyStored: true,
      quarantined: 1,
    },
    history: { days: 3, points: 8, bytes: 900 },
    websitePermission: false,
    alarms: [
      {
        name: 'starboard-refresh',
        scheduledTime: Date.UTC(2026, 6, 29, 3),
        periodInMinutes: 60,
      },
    ],
    storageBytes: 1200,
    userAgent: 'Mozilla/5.0 Chrome/110.0.0.0',
    now: Date.UTC(2026, 6, 29, 4),
  });
  const text = JSON.stringify(diagnostics);
  assert.equal(diagnostics.extension.minimumChromeVersion, '110');
  assert.equal(diagnostics.extension.runtimeChromeMajor, 110);
  assert.equal(diagnostics.refresh.error.code, 'RATE_LIMITED');
  assert.equal(diagnostics.alarms.refresh.periodMinutes, 60);
  assert.doesNotMatch(
    text,
    /diagnostic-secret|private-owner|private-repo|rawHtml|<p>|message|token|cookie/i,
  );
});

await test('notification milestones and deltas deduplicate across worker restarts', async () => {
  const previous = {
    confidence: 'exact',
    repos: [
      {
        id: 1,
        name: 'demo',
        full_name: 'octocat/demo',
        stargazers_count: 9,
        forks_count: 0,
        fork: false,
        approx: false,
      },
      {
        id: 2,
        name: 'other',
        full_name: 'octocat/other',
        stargazers_count: 90,
        forks_count: 0,
        fork: false,
        approx: false,
      },
    ],
  };
  const current = {
    confidence: 'exact',
    repos: [
      { ...previous.repos[0], stargazers_count: 12 },
      { ...previous.repos[1], stargazers_count: 91 },
    ],
  };
  const config = {
    ...DEFAULT_NOTIFICATION_CONFIG,
    enabled: true,
    portfolioMilestone: 100,
    portfolioDelta: 4,
    repositoryMilestone: 10,
    repositoryDelta: 3,
  };
  const first = evaluateNotificationEvents(
    previous,
    current,
    config,
    emptyNotificationState(),
    { generation: 'notification-g1', now: 1000 },
  );
  assert.deepEqual(
    first.pending.map((event) => event.id),
    [
      'portfolio:delta:notification-g1',
      'portfolio:milestone:100',
      'repo:id:1:delta:notification-g1',
      'repo:id:1:milestone:10',
    ],
  );

  const restarted = evaluateNotificationEvents(previous, current, config, first, {
    generation: 'notification-g1',
    now: 2000,
  });
  assert.deepEqual(restarted, first);

  const delivered = markNotificationsDelivered(
    first,
    first.pending.map((event) => event.id),
    3000,
  );
  const noRepeat = evaluateNotificationEvents(previous, current, config, delivered, {
    generation: 'notification-g2',
    now: 4000,
  });
  assert.equal(
    noRepeat.pending.filter((event) => event.id.includes('milestone')).length,
    0,
  );
});

await test('notification quiet hours, cooldowns, and approximation guards are deterministic', async () => {
  const noon = new Date(2026, 6, 29, 12, 0, 0, 0).getTime();
  const quiet = notificationAvailability(
    {
      ...DEFAULT_NOTIFICATION_CONFIG,
      enabled: true,
      quietStart: '00:00',
      quietEnd: '23:59',
    },
    emptyNotificationState(),
    noon,
  );
  assert.equal(quiet.allowed, false);
  assert.ok(quiet.nextAt > noon);

  const cooldownState = { ...emptyNotificationState(), lastSentAt: noon - 30 * 60_000 };
  const cooling = notificationAvailability(
    {
      ...DEFAULT_NOTIFICATION_CONFIG,
      enabled: true,
      quietStart: '00:00',
      quietEnd: '00:00',
      cooldownMinutes: 60,
    },
    cooldownState,
    noon,
  );
  assert.equal(cooling.allowed, false);
  assert.equal(cooling.nextAt, cooldownState.lastSentAt + 60 * 60_000);

  const approximate = evaluateNotificationEvents(
    {
      confidence: 'exact',
      repos: [
        {
          id: 1,
          name: 'demo',
          full_name: 'octocat/demo',
          stargazers_count: 9,
          forks_count: 0,
          fork: false,
          approx: false,
        },
      ],
    },
    {
      confidence: 'approximate',
      repos: [
        {
          id: 1,
          name: 'demo',
          full_name: 'octocat/demo',
          stargazers_count: 1000,
          forks_count: 0,
          fork: false,
          approx: true,
        },
      ],
    },
    { ...DEFAULT_NOTIFICATION_CONFIG, enabled: true },
    emptyNotificationState(),
    { generation: 'notification-approx', now: noon },
  );
  assert.equal(approximate.pending.length, 0);
});

const failed = checks.filter((check) => !check.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} unit checks passed`);
process.exit(failed.length ? 1 : 0);

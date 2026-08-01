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
  const listeners = new Set();
  const area = {
    values,
    // Mutable so a test can narrow the budget around one write.
    quotaBytes,
    onChanged: {
      addListener: (fn) => listeners.add(fn),
      removeListener: (fn) => listeners.delete(fn),
      __emit: (changes) => {
        if (Object.keys(changes).length) listeners.forEach((fn) => fn(changes));
      },
    },
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
        // Chrome rejects the whole write; nothing is partially applied.
        throw new Error('QUOTA_BYTES quota exceeded');
      }
      const changes = {};
      for (const [key, value] of Object.entries(clone(next))) {
        changes[key] = { oldValue: clone(values[key]), newValue: clone(value) };
      }
      Object.assign(values, clone(next));
      area.onChanged.__emit(changes);
    },
    async remove(keys) {
      const changes = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (Object.hasOwn(values, key)) changes[key] = { oldValue: clone(values[key]) };
        delete values[key];
      }
      area.onChanged.__emit(changes);
    },
    async clear() {
      const changes = Object.fromEntries(
        Object.entries(values).map(([key, value]) => [key, { oldValue: clone(value) }]),
      );
      for (const key of Object.keys(values)) delete values[key];
      area.onChanged.__emit(changes);
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
  rekeyHistoryByName,
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

/** Return both areas to a pristine state so cases cannot depend on order. */
function resetStorage() {
  area.quotaBytes = Infinity;
  sessionArea.quotaBytes = Infinity;
}

function replaceAreaValues(storageArea, values) {
  for (const key of Object.keys(storageArea.values)) delete storageArea.values[key];
  Object.assign(storageArea.values, clone(values));
}

const checks = [];
async function test(name, work) {
  resetStorage();
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
  const migrated = storage.migrateRecord('settings', current, storage.SCHEMA_VERSION);
  assert.equal(migrated.changed, false);
  assert.deepEqual(migrated.envelope.data, current.data);
});

await test('a downgraded build explains and preserves every newer-schema record', async () => {
  const originalLocal = clone(area.values);
  const originalSession = clone(sessionArea.values);
  try {
    replaceAreaValues(area, {});
    replaceAreaValues(sessionArea, {});
    await storage.setSettings({ username: 'future-user', dataSource: 'api' });
    const currentSettings = clone(area.values.settings);
    const futureSettings = {
      ...currentSettings,
      schemaVersion: storage.SCHEMA_VERSION + 1,
      data: { ...currentSettings.data, futureOnly: 'preserve-me' },
    };
    area.values.settings = clone(futureSettings);

    await assert.rejects(storage.getSettings(), (error) => {
      assert.equal(error.name, 'StorageVersionError');
      assert.equal(error.code, 'STORAGE_VERSION_TOO_NEW');
      assert.equal(error.key, storage.STORAGE_KEYS.settings);
      assert.equal(error.detectedVersion, storage.SCHEMA_VERSION + 1);
      assert.match(
        error.message,
        new RegExp(`only understands v${storage.SCHEMA_VERSION}`, 'i'),
      );
      assert.match(error.message, /left untouched/i);
      return true;
    });
    await assert.rejects(storage.setSettings({ username: 'older-build' }), {
      code: 'STORAGE_VERSION_TOO_NEW',
    });
    assert.deepEqual(area.values.settings, futureSettings);
    assert.equal(area.values.starboardQuarantine, undefined);

    const cache = {
      profile: { login: 'future-user' },
      repos: [],
      fetchedAt: 100,
      source: 'api',
      confidence: 'exact',
    };
    const futureCache = {
      schemaVersion: storage.SCHEMA_VERSION + 1,
      savedAt: 100,
      generation: 'future-generation',
      data: { ...cache, futureOnly: true },
    };
    area.values.cache = clone(futureCache);
    await assert.rejects(storage.setCache({ ...cache, generation: 'older-generation' }), {
      code: 'STORAGE_VERSION_TOO_NEW',
    });
    assert.deepEqual(area.values.cache, futureCache);

    delete area.values.cache;
    area.values.starboardLastKnownGood.data.cache = clone(futureCache);
    await assert.rejects(storage.setCache({ ...cache, generation: 'older-generation' }), {
      code: 'STORAGE_VERSION_TOO_NEW',
    });
    assert.deepEqual(area.values.starboardLastKnownGood.data.cache, futureCache);

    area.values.settings = currentSettings;
    const futureToken = {
      schemaVersion: storage.SCHEMA_VERSION + 1,
      savedAt: 100,
      generation: null,
      data: { token: 'future-session-token', futureOnly: true },
    };
    sessionArea.values[storage.SESSION_TOKEN_KEY] = clone(futureToken);
    await assert.rejects(storage.getSettings(), {
      code: 'STORAGE_VERSION_TOO_NEW',
      key: storage.SESSION_TOKEN_KEY,
    });
    assert.deepEqual(sessionArea.values[storage.SESSION_TOKEN_KEY], futureToken);

    const futureUndo = {
      schemaVersion: storage.SCHEMA_VERSION + 1,
      savedAt: 100,
      generation: null,
      data: {
        scope: 'future-action',
        createdAt: 100,
        expiresAt: Date.now() + 60_000,
        snapshot: { settings: null },
      },
    };
    area.values[storage.STORAGE_KEYS.undo] = clone(futureUndo);
    await assert.rejects(storage.getUndoStatus(), {
      code: 'STORAGE_VERSION_TOO_NEW',
      key: storage.STORAGE_KEYS.undo,
    });
    assert.deepEqual(area.values[storage.STORAGE_KEYS.undo], futureUndo);
  } finally {
    replaceAreaValues(area, originalLocal);
    replaceAreaValues(sessionArea, originalSession);
  }
});

await test('a schema upgrade keeps the complete recovery copy through its first write', async () => {
  const originalLocal = clone(area.values);
  const originalSession = clone(sessionArea.values);
  try {
    replaceAreaValues(area, {});
    replaceAreaValues(sessionArea, {});
    await storage.setSettings({ username: 'octocat', dataSource: 'api' });
    const baseline = {
      at: 100,
      generation: 'baseline-generation',
      counts: { 'octocat/demo': [4, 1] },
    };
    await storage.setBaseline(baseline);
    await storage.setNotificationConfig({ enabled: false });
    await storage.getPortfolioViewState();

    const preserved = clone(area.values.starboardLastKnownGood.data);
    const requiredKeys = [
      storage.STORAGE_KEYS.settings,
      storage.STORAGE_KEYS.baseline,
      storage.STORAGE_KEYS.notificationConfig,
      storage.STORAGE_KEYS.portfolioViews,
    ];
    for (const key of requiredKeys) {
      assert.ok(preserved[key], `${key} must exist before the simulated upgrade`);
      preserved[key].schemaVersion = storage.SCHEMA_VERSION - 1;
    }
    area.values.starboardLastKnownGood = {
      schemaVersion: storage.SCHEMA_VERSION - 1,
      savedAt: 90,
      generation: null,
      data: clone(preserved),
    };
    area.values.baseline = {
      schemaVersion: storage.SCHEMA_VERSION,
      savedAt: 100,
      generation: null,
      data: { corrupt: true },
    };

    await storage.setCache({
      profile: { login: 'octocat' },
      repos: [],
      fetchedAt: 110,
      source: 'api',
      confidence: 'exact',
      generation: 'first-v6-write',
    });

    const upgradedRecovery = area.values.starboardLastKnownGood;
    assert.equal(upgradedRecovery.schemaVersion, storage.SCHEMA_VERSION);
    for (const key of requiredKeys) {
      assert.deepEqual(
        upgradedRecovery.data[key],
        preserved[key],
        `${key} recovery envelope must survive the first post-upgrade write`,
      );
    }
    assert.deepEqual(await storage.getBaseline(), baseline);
    assert.equal(area.values.baseline.schemaVersion, storage.SCHEMA_VERSION);
  } finally {
    replaceAreaValues(area, originalLocal);
    replaceAreaValues(sessionArea, originalSession);
  }
});

await test('corrupt settings restore last-known-good and record redacted quarantine metadata', async () => {
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

await test('synchronous refresh requests keep source and account generations isolated', async () => {
  for (const intents of [
    [
      { source: 'api', accountKey: 'api:alice:public' },
      { source: 'api', accountKey: 'api:bob:public' },
    ],
    [
      { source: 'web', accountKey: 'alice:public' },
      { source: 'api', accountKey: 'alice:public' },
    ],
  ]) {
    const calls = [];
    const coordinator = createRefreshCoordinator(async (intent) => {
      calls.push(intent);
      return `${intent.source}/${intent.accountKey}`;
    });

    const results = await Promise.all(intents.map((intent) => coordinator.request(intent)));
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map(({ source, accountKey }) => ({ source, accountKey })),
      intents,
    );
    assert.deepEqual(
      results,
      intents.map((intent) => `${intent.source}/${intent.accountKey}`),
    );
  }
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
  const settings = { ...storage.DEFAULTS, username: 'octocat', dataSource: 'api' };
  const good = await createBackup({ settings, now: Date.UTC(2026, 6, 31) });
  // Structural guards only get a chance to run if the document is re-sealed;
  // otherwise the checksum — correctly — rejects everything first.
  const before = clone(area.values);
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

  // Nothing above may have altered stored state. Compare against a snapshot
  // rather than asserting a key is absent: the storage module serialises
  // writes, so an earlier case's write can still be settling.
  assert.deepEqual(area.values, before);

  // The untampered document still validates.
  const valid = await validateBackupText(JSON.stringify(good));
  assert.equal(valid.records.settings.username, 'octocat');
});

await test('backup import replaces off-origin profile, avatar, and repository URLs', async () => {
  const cache = {
    profile: {
      login: 'octocat',
      name: 'The Octocat',
      avatar_url: 'https://attacker.example/pixel?profile=octocat',
      html_url: 'https://phish.example/sign-in',
      public_repos: 1,
      followers: 0,
    },
    repos: [
      {
        id: 1,
        name: 'demo',
        full_name: 'octocat/demo',
        html_url: 'https://phish.example/octocat/demo',
        description: '',
        language: null,
        stargazers_count: 1,
        forks_count: 0,
        private: false,
        fork: false,
        archived: false,
      },
    ],
    fetchedAt: Date.UTC(2026, 7, 1),
    source: 'api',
    confidence: 'exact',
    lifecycleEvents: [],
  };
  const document = await createBackup({
    settings: { ...storage.DEFAULTS, username: 'octocat', dataSource: 'api' },
    cache,
    baseline: storage.snapshotOf(cache.repos, { now: cache.fetchedAt }),
    now: cache.fetchedAt,
  });

  const preview = await validateBackupText(JSON.stringify(document));
  await storage.applyImportedState(preview.records);
  const restored = await storage.getCache();
  assert.equal(restored.profile.html_url, 'https://github.com/octocat');
  assert.equal(restored.profile.avatar_url, 'https://github.com/octocat.png?size=80');
  assert.equal(restored.repos[0].html_url, 'https://github.com/octocat/demo');
  assert.ok(
    [restored.profile.html_url, restored.profile.avatar_url, restored.repos[0].html_url].every(
      (value) => ['https://github.com', 'https://avatars.githubusercontent.com'].includes(
        new URL(value).origin,
      ),
    ),
  );
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
  await storage.setSettings({ username: 'octocat', dataSource: 'api' });
  await storage.setHistory({
    formatVersion: 3,
    repos: [['name:octocat/a', 'octocat/a', 0]],
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

await test('a token belonging to someone else never lists its own repositories', async () => {
  // `/user/repos` returns the *token owner's* repositories regardless of the
  // pinned username. Without resolving the owner first, pinning `octocat` with
  // a `hubot` token silently ranks hubot's portfolio under octocat's name.
  const seen = [];
  const profileFor = (login) => ({
    login,
    name: login,
    avatar_url: '',
    html_url: `https://github.com/${login}`,
    public_repos: 1,
    followers: 0,
  });
  const respond = async (url) => {
    const { pathname, search } = new URL(url);
    seen.push(pathname + search);
    if (pathname === '/user') return new Response(JSON.stringify(profileFor('hubot')), { status: 200 });
    if (pathname === '/users/octocat') {
      return new Response(JSON.stringify(profileFor('octocat')), { status: 200 });
    }
    return new Response(
      JSON.stringify([
        { id: 1, name: 'a', full_name: 'octocat/a', stargazers_count: 5, forks_count: 0 },
      ]),
      { status: 200 },
    );
  };
  const result = await fetchAccount(
    { username: 'octocat', token: 'ghp_someone_else' },
    { fetchImpl: respond, sleep: async () => {}, now: () => 1000 },
  );
  assert.equal(result.profile.login, 'octocat');
  assert.ok(seen.includes('/user'), 'the token owner is resolved before the listing');
  assert.ok(
    seen.some((path) => path.startsWith('/users/octocat/repos')),
    `expected the pinned account's listing, got ${JSON.stringify(seen)}`,
  );
  assert.ok(
    !seen.some((path) => path.startsWith('/user/repos')),
    'the token owner\'s own listing must not be used for a different account',
  );

  // The self case still takes the authenticated listing, which is the only one
  // that can see private repositories.
  const own = [];
  await fetchAccount(
    { username: 'hubot', token: 'ghp_own' },
    {
      fetchImpl: async (url) => {
        own.push(new URL(url).pathname);
        return respond(url);
      },
      sleep: async () => {},
      now: () => 1000,
    },
  );
  assert.ok(own.includes('/user/repos'), `expected the authenticated listing, got ${own}`);
  assert.ok(!own.some((path) => path.startsWith('/users/hubot')), 'no redundant public fetch');
});

await test('a partial snapshot never reports repositories as removed', async () => {
  // Website mode demonstrably produces `complete: false` — a cap, a parser
  // drift, a timed-out later page. Diffing that against a complete generation
  // would announce every unfetched repository as deleted.
  const repo = (id, name) => ({ id, full_name: name, stargazers_count: 1, forks_count: 0 });
  const complete = {
    source: 'web',
    complete: true,
    repos: [repo('octocat/a', 'octocat/a'), repo('octocat/b', 'octocat/b')],
  };
  const truncated = {
    source: 'web',
    complete: false,
    partialReason: 'cap',
    repos: [repo('octocat/a', 'octocat/a')],
  };
  const options = { generation: 'g2', now: 1000, source: 'web' };
  assert.deepEqual(deriveLifecycleEvents(complete, truncated, options), []);
  // And the reverse: a complete generation following a partial one must not
  // announce the repositories the partial one simply never saw as new.
  assert.deepEqual(deriveLifecycleEvents(truncated, complete, options), []);
  // The same comparison between two complete generations is the real signal.
  const events = deriveLifecycleEvents(
    complete,
    { ...complete, repos: [repo('octocat/a', 'octocat/a')] },
    options,
  );
  assert.deepEqual(
    events.map((event) => [event.type, event.to]),
    [['removed', 'octocat/b']],
  );
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

await test('daily history updates same-day points and follows renames', async () => {
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
    {
      source: 'api',
      confidence: 'exact',
      repos: [renamed],
      lifecycleEvents: [
        {
          id: 'rename-old-to-new',
          type: 'renamed',
          from: 'octocat/old-name',
          to: 'octocat/new-name',
          at: firstAt + 7 * 86_400_000,
        },
      ],
    },
    { now: firstAt + 7 * 86_400_000 },
  );
  assert.equal(history.repos.length, 1, 'a rename must not open a second series');
  const comparison = historyPointForRepo(history, renamed, 7, {
    now: firstAt + 7 * 86_400_000,
  });
  // The key is the name, so a rename is carried across by re-keying the
  // dictionary from the detected lifecycle event. The dictionary holds one
  // name per identity, so a historical point reports the repository's present
  // name rather than the one it carried that day — the series stays one
  // continuous line instead of appearing to change subject halfway through.
  assert.equal(comparison.fullName, 'octocat/new-name');
  assert.equal(comparison.stars, 11);
  assert.equal(renamed.stargazers_count - comparison.stars, 7);
});

await test('a retained rename event cannot consume a repository recreated under the old name', async () => {
  const day = Date.UTC(2026, 0, 10, 8);
  const original = {
    id: 7,
    full_name: 'octocat/foo',
    stargazers_count: 10,
    forks_count: 1,
    private: false,
  };
  const renamed = { ...original, full_name: 'octocat/bar' };
  const rename = {
    id: 'generation-2:renamed:7:octocat/foo:octocat/bar',
    type: 'renamed',
    from: 'octocat/foo',
    to: 'octocat/bar',
    at: day + 86_400_000,
  };

  let history = recordDailyHistory(
    null,
    { source: 'api', confidence: 'exact', repos: [original] },
    { now: day },
  );
  history = recordDailyHistory(
    history,
    {
      source: 'api',
      confidence: 'exact',
      repos: [{ ...renamed, stargazers_count: 11 }],
      lifecycleEvents: [rename],
    },
    { now: day + 86_400_000 },
  );

  for (let offset = 2; offset <= 4; offset += 1) {
    history = recordDailyHistory(
      history,
      {
        source: 'api',
        confidence: 'exact',
        repos: [
          { ...renamed, stargazers_count: 10 + offset },
          {
            ...original,
            id: 8,
            stargazers_count: offset - 1,
            forks_count: 0,
          },
        ],
        lifecycleEvents: [rename],
      },
      { now: day + offset * 86_400_000 },
    );
  }

  assert.deepEqual(
    history.repos.map((entry) => entry[1]).sort(),
    ['octocat/bar', 'octocat/foo'],
  );
  assert.deepEqual(
    historyRows(history)
      .filter((row) => row.fullName === 'octocat/foo')
      .map((row) => row.stars),
    [1, 2, 3],
  );
});

await test('rename then rename back converges without replaying either event', async () => {
  const day = Date.UTC(2026, 0, 20, 8);
  const foo = {
    id: 7,
    full_name: 'octocat/foo',
    stargazers_count: 10,
    forks_count: 1,
    private: false,
  };
  const bar = { ...foo, full_name: 'octocat/bar' };
  const toBar = {
    id: 'generation-2:renamed:7:octocat/foo:octocat/bar',
    type: 'renamed',
    from: 'octocat/foo',
    to: 'octocat/bar',
    at: day + 86_400_000,
  };
  const toFoo = {
    id: 'generation-3:renamed:7:octocat/bar:octocat/foo',
    type: 'renamed',
    from: 'octocat/bar',
    to: 'octocat/foo',
    at: day + 2 * 86_400_000,
  };

  let history = recordDailyHistory(
    null,
    { source: 'api', confidence: 'exact', repos: [foo] },
    { now: day },
  );
  history = recordDailyHistory(
    history,
    {
      source: 'api',
      confidence: 'exact',
      repos: [{ ...bar, stargazers_count: 11 }],
      lifecycleEvents: [toBar],
    },
    { now: day + 86_400_000 },
  );

  for (let offset = 2; offset <= 4; offset += 1) {
    history = recordDailyHistory(
      history,
      {
        source: 'api',
        confidence: 'exact',
        repos: [{ ...foo, stargazers_count: 10 + offset }],
        lifecycleEvents: [toFoo, toBar],
      },
      { now: day + offset * 86_400_000 },
    );
    assert.deepEqual(history.repos.map((entry) => entry[1]), ['octocat/foo']);
  }

  assert.deepEqual(
    historyRows(history).map((row) => [row.fullName, row.stars]),
    [
      ['octocat/foo', 10],
      ['octocat/foo', 11],
      ['octocat/foo', 12],
      ['octocat/foo', 13],
      ['octocat/foo', 14],
    ],
  );
});

await test('same-day history keeps repositories missing from a later refresh', async () => {
  const firstAt = Date.UTC(2026, 0, 2, 8);
  const alpha = {
    id: 1,
    full_name: 'octocat/alpha',
    stargazers_count: 10,
    forks_count: 2,
    private: false,
  };
  const bravo = {
    id: 2,
    full_name: 'octocat/bravo',
    stargazers_count: 20,
    forks_count: 4,
    private: false,
  };
  let history = recordDailyHistory(
    null,
    { source: 'api', confidence: 'exact', repos: [alpha, bravo] },
    { now: firstAt },
  );
  history = recordDailyHistory(
    history,
    {
      source: 'api',
      confidence: 'exact',
      repos: [{ ...alpha, stargazers_count: 12, forks_count: 3 }],
    },
    { now: firstAt + 3_600_000 },
  );

  assert.equal(history.snapshots.length, 1);
  const rows = historyRows(history);
  assert.deepEqual(
    rows.map((row) => [row.fullName, row.stars, row.forks]),
    [
      ['octocat/alpha', 12, 3],
      ['octocat/bravo', 20, 4],
    ],
  );
});

await test('lower-confidence same-day history never displaces an exact point', async () => {
  const firstAt = Date.UTC(2026, 0, 3, 8);
  const repo = {
    id: 1,
    full_name: 'octocat/alpha',
    stargazers_count: 10,
    forks_count: 2,
    private: false,
  };
  const exact = recordDailyHistory(
    null,
    { source: 'api', confidence: 'exact', repos: [repo] },
    { now: firstAt },
  );

  for (const confidence of ['partial', 'stale']) {
    const history = recordDailyHistory(
      exact,
      {
        source: 'web',
        confidence,
        repos: [{ ...repo, stargazers_count: 99, forks_count: 9 }],
      },
      { now: firstAt + 3_600_000 },
    );
    assert.equal(history.snapshots[0].confidence, 'exact');
    assert.equal(history.snapshots[0].source, 'api');
    assert.equal(history.snapshots[0].stars[0], 10);
    assert.equal(history.snapshots[0].forks[0], 2);
  }
});

await test('an empty generation cannot erase same-day history', async () => {
  const firstAt = Date.UTC(2026, 0, 4, 8);
  const history = recordDailyHistory(
    null,
    {
      source: 'api',
      confidence: 'exact',
      repos: [
        {
          id: 1,
          full_name: 'octocat/alpha',
          stargazers_count: 10,
          forks_count: 2,
          private: false,
        },
      ],
    },
    { now: firstAt },
  );
  const afterEmpty = recordDailyHistory(
    history,
    { source: 'api', confidence: 'exact', repos: [] },
    { now: firstAt + 3_600_000 },
  );

  assert.deepEqual(afterEmpty, history);
});

await test('a trend series survives a change of data source', async () => {
  const start = Date.UTC(2026, 2, 1, 9);
  // The API knows the numeric id; github.com never exposes it. Keying on the
  // id meant a source switch started every series over from nothing.
  const viaApi = {
    source: 'api',
    confidence: 'exact',
    repos: [
      { id: 42, full_name: 'octocat/demo', stargazers_count: 30, forks_count: 4, private: false },
    ],
  };
  const viaWeb = {
    source: 'web',
    confidence: 'exact',
    repos: [
      {
        id: 'octocat/demo',
        full_name: 'octocat/demo',
        stargazers_count: 37,
        forks_count: 5,
        private: false,
      },
    ],
  };
  let history = recordDailyHistory(null, viaApi, { now: start });
  history = recordDailyHistory(history, viaWeb, { now: start + 7 * 86_400_000 });

  assert.equal(history.repos.length, 1, 'one repository must occupy one key space');
  assert.equal(history.snapshots.length, 2);
  const comparison = historyPointForRepo(history, viaWeb.repos[0], 7, {
    now: start + 7 * 86_400_000,
  });
  assert.equal(comparison.stars, 30, 'the pre-switch point is still comparable');
  assert.equal(viaWeb.repos[0].stargazers_count - comparison.stars, 7);
});

await test('an id-keyed history merges into one series when it is re-keyed', async () => {
  // What an account that used both sources under format 2 actually holds: the
  // same repository twice, once per key space, each with half the series.
  const day = (n) => new Date(Date.UTC(2026, 2, 1 + n)).toISOString().slice(0, 10);
  const legacy = {
    formatVersion: 2,
    repos: [
      ['id:42', 'octocat/demo', 0],
      ['name:octocat/demo', 'octocat/demo', 0],
    ],
    snapshots: [
      {
        day: day(0),
        at: Date.UTC(2026, 2, 1),
        source: 'api',
        confidence: 'exact',
        stars: [30, null],
        forks: [4, null],
        approx: [],
      },
      {
        day: day(1),
        at: Date.UTC(2026, 2, 2),
        source: 'web',
        confidence: 'approximate',
        stars: [null, 37],
        forks: [null, 5],
        approx: [1],
      },
    ],
  };
  const merged = rekeyHistoryByName(legacy);
  assert.equal(merged.formatVersion, 3);
  assert.equal(merged.repos.length, 1);
  assert.deepEqual(merged.repos[0], ['name:octocat/demo', 'octocat/demo', 0]);
  assert.deepEqual(merged.snapshots[0].stars, [30]);
  assert.deepEqual(merged.snapshots[1].stars, [37]);
  // The approximation index has to follow the repository into its new slot.
  assert.deepEqual(merged.snapshots[1].approx, [0]);
  const rows = historyRows(merged);
  assert.equal(rows.length, 2, 'both days remain readable as one series');
  assert.ok(rows.every((row) => row.fullName === 'octocat/demo'));
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
  const indexOfB = history.repos.findIndex((entry) => entry[0] === 'name:octocat/b');
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
  return { formatVersion: 3, repos: [], snapshots: [] };
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
  // Both migration steps, in the order the schema chain applies them.
  const historySeed = rekeyHistoryByName(migrateHistoryToV2(legacySeed));
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
      'repo:name:octocat/demo:delta:notification-g1',
      'repo:name:octocat/demo:milestone:10',
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

await test('a quiet window that wraps midnight holds on both sides of it', async () => {
  // Every realistic configuration wraps: the default is 22:00 to 08:00. Only
  // the non-wrapping case had a test, and that is the branch that cannot fail.
  const config = {
    ...DEFAULT_NOTIFICATION_CONFIG,
    enabled: true,
    quietStart: '22:00',
    quietEnd: '07:00',
    cooldownMinutes: 0,
  };
  const at = (hour, minute = 0) => new Date(2026, 6, 29, hour, minute, 0, 0).getTime();
  const check = (hour, minute = 0) =>
    notificationAvailability(config, emptyNotificationState(), at(hour, minute));

  assert.equal(check(21, 59).allowed, true, 'a minute before the window');
  assert.equal(check(22, 0).allowed, false, 'the window is inclusive at its start');
  assert.equal(check(6, 59).allowed, false, 'still quiet a minute before the end');
  assert.equal(check(7, 0).allowed, true, 'the window is exclusive at its end');
  assert.equal(check(12, 0).allowed, true, 'the middle of the day is never quiet');

  // Before midnight the window ends tomorrow; after midnight it ends today.
  // Getting this backwards schedules a retry ~24 hours late or immediately.
  const evening = notificationAvailability(config, emptyNotificationState(), at(23, 30));
  assert.equal(evening.nextAt, new Date(2026, 6, 30, 7, 0, 0, 0).getTime());
  const smallHours = notificationAvailability(config, emptyNotificationState(), at(3, 0));
  assert.equal(smallHours.nextAt, new Date(2026, 6, 29, 7, 0, 0, 0).getTime());

  // Equal endpoints mean "no quiet hours", not "quiet all day".
  const always = notificationAvailability(
    { ...config, quietStart: '09:00', quietEnd: '09:00' },
    emptyNotificationState(),
    at(9, 0),
  );
  assert.equal(always.allowed, true);
  assert.equal(always.nextAt, null);
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

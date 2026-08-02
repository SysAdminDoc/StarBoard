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
    QUOTA_BYTES: 10 * 1024 * 1024,
    writeBytes: [],
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
      area.writeBytes.push(Buffer.byteLength(JSON.stringify(next)));
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
const {
  parseRetryAfter,
  createRetryWait,
  requestText,
  requestWithRetry,
  RequestPolicyError,
} = await import('../src/lib/request.js');
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
  MAX_EVENTS,
} = await import('../src/lib/lifecycle.js');
const {
  HISTORY_MAX_BYTES,
  historyByteSize,
  historyMaxBytesForQuota,
  historyPointForRepo,
  historyRetainedDays,
  historyRows,
  migrateHistoryToV2,
  recordDailyHistory,
  rekeyHistoryByName,
  validateHistory,
} = await import('../src/lib/history.js');
const {
  BACKUP_MAX_BYTES,
  assertBackupSize,
  createBackup,
  createCsv,
  serializeBackup,
  sha256Hex,
  stableStringify,
  validateBackupText,
} = await import('../src/lib/transfer.js');
const { buildDiagnostics } = await import('../src/lib/diagnostics.js');
const { installationPlan } = await import('../src/lib/install.js');
const {
  acknowledgeNotifications,
  DEFAULT_NOTIFICATION_CONFIG,
  emptyNotificationState,
  evaluateNotificationEvents,
  markNotificationsNotified,
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
  area.QUOTA_BYTES = 10 * 1024 * 1024;
  area.writeBytes.length = 0;
  sessionArea.quotaBytes = Infinity;
  sessionArea.QUOTA_BYTES = 10 * 1024 * 1024;
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

await test('extension installs and updates refresh while Chrome updates do not', async () => {
  assert.deepEqual(installationPlan({ reason: 'install' }), {
    reason: 'install',
    shouldRefresh: true,
    previousVersion: null,
  });
  assert.deepEqual(installationPlan({ reason: 'update', previousVersion: '1.3.0' }), {
    reason: 'update',
    shouldRefresh: true,
    previousVersion: '1.3.0',
  });
  assert.deepEqual(installationPlan({ reason: 'chrome_update', previousVersion: '151.0' }), {
    reason: 'chrome_update',
    shouldRefresh: false,
    previousVersion: null,
  });
  assert.equal(installationPlan({ reason: 'shared_module_update' }).shouldRefresh, false);
});

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

await test('baseline resolution covers lifetime, age threshold, and explicit rebase', async () => {
  const originalLocal = clone(area.values);
  const originalSession = clone(sessionArea.values);
  const realDateNow = Date.now;
  let now = Date.UTC(2026, 7, 1, 12);
  Date.now = () => now;
  try {
    replaceAreaValues(area, {});
    replaceAreaValues(sessionArea, {});
    const initialRepos = [
      { full_name: 'octocat/alpha', stargazers_count: 10, forks_count: 2 },
    ];
    const changedRepos = [
      { full_name: 'octocat/alpha', stargazers_count: 15, forks_count: 3 },
    ];

    const initial = await storage.resolveBaseline(initialRepos, 0);
    assert.equal(initial.at, now);
    assert.deepEqual(initial.counts, { 'octocat/alpha': [10, 2] });

    now += 6 * 3600_000;
    const lifetime = await storage.resolveBaseline(changedRepos, 0);
    assert.equal(lifetime.at, initial.at);
    assert.deepEqual(lifetime.counts, initial.counts);

    const belowThreshold = {
      at: now - 24 * 3600_000 + 1,
      counts: { 'octocat/alpha': [11, 2] },
    };
    await storage.setBaseline(belowThreshold);
    const preserved = await storage.resolveBaseline(changedRepos, 24);
    assert.equal(preserved.at, belowThreshold.at, 'a baseline below the threshold is preserved');
    assert.deepEqual(preserved.counts, belowThreshold.counts);

    const aboveThreshold = {
      at: now - 24 * 3600_000 - 1,
      counts: { 'octocat/alpha': [12, 2] },
    };
    await storage.setBaseline(aboveThreshold);
    const rolled = await storage.resolveBaseline(changedRepos, 24);
    assert.equal(rolled.at, now);
    assert.deepEqual(rolled.counts, { 'octocat/alpha': [15, 3] });

    now += 1;
    const rebased = await storage.resetBaseline(initialRepos);
    assert.equal(rebased.at, now);
    assert.deepEqual(rebased.counts, { 'octocat/alpha': [10, 2] });
  } finally {
    Date.now = realDateNow;
    replaceAreaValues(area, originalLocal);
    replaceAreaValues(sessionArea, originalSession);
  }
});

await test('history validation rejects a repository key that disagrees with its name', async () => {
  assert.throws(
    () =>
      validateHistory({
        formatVersion: 3,
        repos: [['name:octocat/old-name', 'octocat/new-name', 0]],
        snapshots: [],
      }),
    /history repository key must match its name/,
  );
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
    area.values[storage.recoveryStorageKey(storage.STORAGE_KEYS.cache)] = clone(futureCache);
    await assert.rejects(storage.setCache({ ...cache, generation: 'older-generation' }), {
      code: 'STORAGE_VERSION_TOO_NEW',
    });
    assert.deepEqual(
      area.values[storage.recoveryStorageKey(storage.STORAGE_KEYS.cache)],
      futureCache,
    );

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

    const preserved = Object.fromEntries(
      [
        storage.STORAGE_KEYS.settings,
        storage.STORAGE_KEYS.baseline,
        storage.STORAGE_KEYS.notificationConfig,
        storage.STORAGE_KEYS.portfolioViews,
      ].map((key) => [
        key,
        clone(area.values[storage.recoveryStorageKey(key)]),
      ]),
    );
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
    for (const key of requiredKeys) delete area.values[storage.recoveryStorageKey(key)];
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

    assert.equal(area.values.starboardLastKnownGood, undefined);
    for (const key of requiredKeys) {
      assert.deepEqual(
        area.values[storage.recoveryStorageKey(key)],
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
  const originalLocal = clone(area.values);
  const originalSession = clone(sessionArea.values);
  try {
    replaceAreaValues(area, {});
    replaceAreaValues(sessionArea, {});
    const saved = await storage.setSettings({ username: 'safe-user', dataSource: 'api' });
    area.values.settings = {
      schemaVersion: storage.SCHEMA_VERSION,
      savedAt: 10,
      generation: null,
      data: { username: 42, token: 'must-not-leak' },
    };

    const restored = await storage.getSettings();
    const notice = await storage.getStorageRecoveryNotice();
    assert.equal(restored.username, saved.username);
    assert.equal(area.values.settings.schemaVersion, storage.SCHEMA_VERSION);
    assert.equal(notice.key, storage.STORAGE_KEYS.settings);
    assert.equal(notice.label, 'Settings');
    assert.equal(notice.outcome, 'restored');
    assert.match(notice.reason, /invalid username|invalid data source/);
    assert.doesNotMatch(JSON.stringify(notice), /must-not-leak/);
    assert.equal((await storage.getStorageDiagnostics()).quarantined, 1);

    assert.equal(await storage.dismissStorageRecoveryNotice(notice.id), true);
    assert.equal(await storage.getStorageRecoveryNotice(), null);
    assert.ok(area.values.starboardQuarantine.data.records[0].acknowledgedAt);
  } finally {
    replaceAreaValues(area, originalLocal);
    replaceAreaValues(sessionArea, originalSession);
  }
});

await test('a corrupt record without a usable recovery copy reports why it was reset', async () => {
  const originalLocal = clone(area.values);
  const originalSession = clone(sessionArea.values);
  try {
    replaceAreaValues(area, {});
    replaceAreaValues(sessionArea, {});
    area.values.cache = {
      schemaVersion: storage.SCHEMA_VERSION,
      savedAt: 10,
      generation: null,
      data: { corrupt: true },
    };

    assert.equal(await storage.getCache(), null);
    const notice = await storage.getStorageRecoveryNotice();
    assert.equal(notice.key, storage.STORAGE_KEYS.cache);
    assert.equal(notice.label, 'The repository snapshot');
    assert.equal(notice.outcome, 'reset');
    assert.match(notice.reason, /cache profile login missing/);
    assert.equal(area.values.cache, undefined);
  } finally {
    replaceAreaValues(area, originalLocal);
    replaceAreaValues(sessionArea, originalSession);
  }
});

await test('PATs survive source switches and clear only through Forget token', async () => {
  const sessionSettings = await storage.setSettings({
    username: 'octocat',
    dataSource: 'api',
    token: 'session-secret',
  });
  assert.equal(sessionSettings.tokenMode, 'session');
  assert.equal(area.values.settings.data.token, '');
  assert.equal(sessionArea.values.starboardSessionToken.data.token, 'session-secret');
  assert.equal((await storage.getSettings()).token, 'session-secret');

  await storage.setSettings({ dataSource: 'web' });
  assert.equal(sessionArea.values.starboardSessionToken.data.token, 'session-secret');
  assert.equal((await storage.getSettings()).token, 'session-secret');
  await storage.setSettings({ dataSource: 'api' });
  assert.equal((await storage.getSettings()).token, 'session-secret');

  await storage.setSettings({ tokenMode: 'persistent' });
  assert.equal(area.values.settings.data.token, 'session-secret');
  assert.equal(sessionArea.values.starboardSessionToken, undefined);

  await storage.setSettings({ dataSource: 'web' });
  assert.equal(area.values.settings.data.token, 'session-secret');
  assert.equal((await storage.getSettings()).token, 'session-secret');
  await storage.setSettings({ dataSource: 'api' });
  assert.equal((await storage.getSettings()).token, 'session-secret');

  await storage.forgetToken();
  assert.equal(area.values.settings.data.token, '');
  assert.equal(sessionArea.values.starboardSessionToken, undefined);
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
  const result = await requestWithRetry('https://example.invalid', {
    fetchImpl: async () => {
      attempt += 1;
      return attempt === 1
        ? response(429, '', { 'retry-after': '2' })
        : response(200, 'ok');
    },
    sleep: async (ms) => sleeps.push(ms),
    now: () => 1000,
    random: () => 0,
    parse: async (retryResponse) => retryResponse.text(),
  });
  assert.equal(result.value, 'ok');
  assert.equal(result.attempts, 2);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(parseRetryAfter('2', 1000), 3000);
});

await test('request timeout aborts and reports a normalized code', async () => {
  await assert.rejects(
    requestWithRetry('https://example.invalid', {
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

await test('request retries are bounded and give up with the final policy error', async () => {
  let calls = 0;
  const sleeps = [];
  await assert.rejects(
    requestWithRetry('https://example.invalid', {
      fetchImpl: async () => {
        calls += 1;
        return new Response('unavailable', { status: 503 });
      },
      sleep: async (ms) => sleeps.push(ms),
      retries: 2,
      baseDelayMs: 10,
      maxDelayMs: 100,
      jitterMs: 0,
      random: () => 0,
      now: () => 1000,
    }),
    (error) =>
      error instanceof RequestPolicyError &&
      error.code === 'UPSTREAM_UNAVAILABLE' &&
      error.status === 503 &&
      error.attempts === 3,
  );
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 20]);
});

await test('retry recovery is scheduled before an abandoned backoff can strand the run', async () => {
  let scheduledAt = null;
  let signalScheduled;
  const scheduled = new Promise((resolveScheduled) => {
    signalScheduled = resolveScheduled;
  });
  const retryWait = createRetryWait({
    schedule: async (retryAt) => {
      scheduledAt = retryAt;
      signalScheduled();
    },
    // Model a worker disappearing after the timer yield: this promise never
    // settles, so only the already-persisted alarm can own recovery.
    sleep: async () => new Promise(() => {}),
    now: () => 1000,
  });
  let calls = 0;
  void requestWithRetry('https://example.invalid', {
    fetchImpl: async () => {
      calls += 1;
      return new Response('unavailable', { status: 503 });
    },
    sleep: retryWait,
    retries: 1,
    baseDelayMs: 50,
    maxDelayMs: 50,
    jitterMs: 0,
    random: () => 0,
    now: () => 1000,
  });
  await scheduled;
  assert.equal(calls, 1);
  assert.equal(scheduledAt, 1050);
});

await test('long retry waits keep the worker alive at bounded intervals', async () => {
  const scheduled = [];
  const sleeps = [];
  let keepAlives = 0;
  const retryWait = createRetryWait({
    schedule: async (retryAt) => scheduled.push(retryAt),
    sleep: async (ms) => sleeps.push(ms),
    keepAlive: async () => {
      keepAlives += 1;
    },
    keepAliveMs: 20,
  });
  await retryWait(45, { retryAt: 1045 });
  assert.deepEqual(scheduled, [1045]);
  assert.deepEqual(sleeps, [20, 20, 5]);
  assert.equal(keepAlives, 3);
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
    if (parsed.pathname === '/users/octocat' || parsed.pathname === '/user') {
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
  assert.equal(first.authenticated, false);
  assert.ok(
    requests.every(({ headers }) => headers['X-GitHub-Api-Version'] === '2026-03-10'),
    'every REST request must pin the current GitHub API version',
  );

  const authenticatedHeaders = [];
  const authenticated = await fetchAccount(
    { username: 'octocat', token: 'ghp_fixture' },
    {
      fetchImpl: async (url, options) => {
        authenticatedHeaders.push(options.headers.Authorization);
        return firstFetch(url, options);
      },
      sleep: async () => {},
      now: () => 1500,
    },
  );
  assert.ok(
    authenticatedHeaders.length > 0 &&
      authenticatedHeaders.every((value) => value === 'Bearer ghp_fixture'),
    'token requests remain authenticated without a host permission',
  );
  assert.equal(authenticated.authenticated, true);

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

await test('nested prototype keys stay inert through backup import and repository shaping', async () => {
  const cache = {
    profile: { login: 'octocat' },
    repos: [
      {
        full_name: 'octocat/demo',
        stargazers_count: 1,
        forks_count: 0,
        private: false,
      },
    ],
    fetchedAt: Date.UTC(2026, 7, 1),
    source: 'api',
    confidence: 'exact',
    lifecycleEvents: [],
  };
  const backup = await createBackup({
    settings: { ...storage.DEFAULTS, username: 'octocat', dataSource: 'api' },
    cache,
    now: cache.fetchedAt,
  });
  const hostile = JSON.parse(JSON.stringify(backup));
  Object.defineProperty(hostile.records.cache.data.repos[0], '__proto__', {
    value: { polluted: true },
    enumerable: true,
  });
  const { checksum: _checksum, ...core } = hostile;
  hostile.checksum = { algorithm: 'SHA-256', value: await sha256Hex(stableStringify(core)) };

  const preview = await validateBackupText(JSON.stringify(hostile));
  const restored = preview.records.cache.repos[0];
  const shaped = { ...restored };

  assert.equal(Object.getPrototypeOf(restored), Object.prototype);
  assert.equal(Object.getPrototypeOf(shaped), Object.prototype);
  assert.equal(shaped.polluted, undefined);
  assert.equal({}.polluted, undefined);
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

await test('the CSV export carries a versioned, positionally stable column contract', async () => {
  const { CSV_COLUMNS, CSV_FORMAT_VERSION, createCsv } = await import('../src/lib/transfer.js');
  // Pinned literally: this is the promise consumers script against, so a
  // reorder or a rename has to fail here rather than in someone's pipeline.
  assert.deepEqual(
    [...CSV_COLUMNS],
    [
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
    ],
  );

  const cache = {
    profile: { login: 'octocat' },
    fetchedAt: Date.UTC(2026, 6, 31, 12),
    source: 'api',
    confidence: 'exact',
    repos: [
      {
        full_name: 'octocat/alpha',
        private: false,
        stargazers_count: 12,
        forks_count: 3,
      },
    ],
  };
  const csv = createCsv({ cache, baseline: null, includePrivate: false });
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  // Every field is quoted, per the writer's RFC 4180 discipline.
  const quoted = CSV_COLUMNS.map((name) => `"${name}"`).join(',');
  assert.equal(lines[0], quoted);
  // Every row declares the contract, so a consumer that never read the header
  // — or received the file renamed — still knows what it is holding.
  assert.equal(lines[1].split(',')[0], `"${CSV_FORMAT_VERSION}"`);
  assert.equal(lines[1].split(',').length, CSV_COLUMNS.length);

  const history = {
    formatVersion: 3,
    repos: [['name:octocat/alpha', 'octocat/alpha', 0]],
    snapshots: [
      {
        day: '2026-07-30',
        at: Date.UTC(2026, 6, 30),
        source: 'api',
        confidence: 'exact',
        stars: [10],
        forks: [2],
        approx: [],
      },
    ],
  };
  const historyCsv = createCsv({ cache, baseline: null, history, includeHistory: true });
  const historyLines = historyCsv.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(historyLines[0], quoted);
  assert.equal(historyLines[1].split(',')[0], `"${CSV_FORMAT_VERSION}"`);
  assert.equal(historyLines[1].split(',').length, CSV_COLUMNS.length);
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
      { full_name: '\ttab/x', stargazers_count: 5, forks_count: 0, private: false },
      { full_name: '\rcarriage/x', stargazers_count: 6, forks_count: 0, private: false },
      { full_name: '\nline-feed/x', stargazers_count: 7, forks_count: 0, private: false },
      { full_name: '＝full-equals/x', stargazers_count: 8, forks_count: 0, private: false },
      { full_name: '＋full-plus/x', stargazers_count: 9, forks_count: 0, private: false },
      { full_name: '－full-minus/x', stargazers_count: 10, forks_count: 0, private: false },
      { full_name: '＠full-at/x', stargazers_count: 11, forks_count: 0, private: false },
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

  for (const dangerous of [
    '=cmd|calc',
    '+add',
    '-minus',
    '@at',
    '\ttab',
    '\rcarriage',
    '\nline-feed',
    '＝full-equals',
    '＋full-plus',
    '－full-minus',
    '＠full-at',
  ]) {
    const guarded = `"\t${dangerous}`;
    assert.ok(csv.includes(guarded), `formula prefix missing for ${JSON.stringify(dangerous)}`);
  }
  assert.ok(!csv.includes('"\'='), 'an apostrophe is not a durable Excel guard');
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
  assert.equal(area.values[storage.recoveryStorageKey(storage.STORAGE_KEYS.history)], undefined);
  assert.ok(
    area.values[storage.recoveryStorageKey(storage.STORAGE_KEYS.settings)],
    'settings are still recoverable',
  );
});

await test('recovery writes scale with the changed record instead of the whole shadow', async () => {
  replaceAreaValues(area, {});
  const cache = {
    profile: { login: 'octocat' },
    repos: Array.from({ length: 300 }, (_, index) => ({
      full_name: `octocat/${'large-repository-name-'.repeat(4)}${index}`,
      stargazers_count: index,
      forks_count: index % 7,
    })),
    fetchedAt: 100,
    source: 'api',
    confidence: 'exact',
  };
  await storage.setCache(cache);
  const cacheRecovery = area.values[storage.recoveryStorageKey(storage.STORAGE_KEYS.cache)];
  const state = emptyNotificationState();
  const stateEnvelope = {
    schemaVersion: storage.SCHEMA_VERSION,
    savedAt: 0,
    generation: null,
    data: state,
  };
  const legacyPayload = {
    [storage.STORAGE_KEYS.notificationState]: state,
    [storage.STORAGE_KEYS.lastKnownGood]: {
      schemaVersion: storage.SCHEMA_VERSION,
      savedAt: 0,
      generation: null,
      data: {
        [storage.STORAGE_KEYS.cache]: cacheRecovery,
        [storage.STORAGE_KEYS.notificationState]: stateEnvelope,
      },
    },
  };
  const legacyBytes = Buffer.byteLength(JSON.stringify(legacyPayload));
  area.writeBytes.length = 0;
  await storage.setNotificationState(state);
  const actualBytes = area.writeBytes.at(-1);
  assert.ok(actualBytes < legacyBytes / 4, `${actualBytes} must be below ${legacyBytes / 4}`);
  console.log(`INFO  changed-record write ${actualBytes} bytes vs legacy ${legacyBytes} bytes`);
});

await test('reading a settled record serializes it once, not three times', async () => {
  replaceAreaValues(area, {});
  // A year of a real portfolio: the record whose repeated serialization cost
  // the most. Reads happen on every popup open; refreshes are twelve-hourly.
  const repos = Array.from({ length: 200 }, (_, index) => [
    `name:octocat/repository-with-a-realistic-name-${index}`,
    `octocat/repository-with-a-realistic-name-${index}`,
    index % 3 === 0 ? 1 : 0,
  ]);
  const snapshots = Array.from({ length: 365 }, (_, day) => ({
    day: new Date(Date.UTC(2025, 0, 1) + day * 86400000).toISOString().slice(0, 10),
    at: Date.UTC(2025, 0, 1) + day * 86400000,
    source: 'api',
    confidence: 'exact',
    stars: repos.map((_entry, index) => index + day),
    forks: repos.map((_entry, index) => (index + day) % 11),
    approx: [],
  }));
  const history = { formatVersion: 3, repos, snapshots };
  await storage.setHistory(history);

  // The memory area emulates Chrome's structured clone with JSON, so its own
  // copy has to be excluded — the real chrome.storage does not serialize here.
  const nativeGet = area.get.bind(area);
  let inStorageStub = false;
  area.get = (...args) => {
    inStorageStub = true;
    try {
      return nativeGet(...args);
    } finally {
      inStorageStub = false;
    }
  };
  const nativeStringify = JSON.stringify;
  let serializedBytes = 0;
  let serializedCalls = 0;
  JSON.stringify = function counted(value, ...rest) {
    const text = nativeStringify.call(JSON, value, ...rest);
    if (!inStorageStub && typeof text === 'string' && text.length > 100_000) {
      serializedCalls += 1;
      serializedBytes += text.length;
    }
    return text;
  };
  let read;
  try {
    read = await storage.getHistory();
  } finally {
    JSON.stringify = nativeStringify;
    area.get = nativeGet;
  }

  const recordBytes = nativeStringify(history).length;
  assert.equal(read.snapshots.length, 365);
  assert.equal(read.repos.length, 200);
  // One pass belongs to `copy()` inside migrateRecord. The change-detection
  // comparison and the defensive re-copy on return were the other two.
  assert.ok(
    serializedCalls <= 1,
    `a settled read serialized the record ${serializedCalls} times`,
  );
  console.log(
    `INFO  ${(recordBytes / 1024).toFixed(0)} KB history read serialized ` +
      `${(serializedBytes / 1024).toFixed(0)} KB (was ~${((recordBytes * 3) / 1024).toFixed(0)} KB)`,
  );
});

await test('a migrating read validates the record it writes back exactly once', async () => {
  replaceAreaValues(area, {});
  const legacyHistory = {
    schemaVersion: storage.SCHEMA_VERSION - 1,
    savedAt: 0,
    generation: null,
    data: {
      formatVersion: 2,
      repos: [['7', 'octocat/one', 0]],
      snapshots: [
        {
          day: '2026-01-01',
          at: Date.UTC(2026, 0, 1),
          source: 'api',
          confidence: 'exact',
          stars: [5],
          forks: [1],
          approx: [],
        },
      ],
    },
  };
  replaceAreaValues(area, { [storage.STORAGE_KEYS.history]: legacyHistory });

  const restored = await storage.getHistory();
  assert.equal(restored.formatVersion, 3);
  assert.equal(restored.repos[0][0], 'name:octocat/one');
  // The re-keyed record must be persisted: skipping the second validation must
  // not skip the write itself. History has no recovery copy by design.
  assert.equal(area.values[storage.STORAGE_KEYS.history].data.formatVersion, 3);
  assert.equal(area.values[storage.STORAGE_KEYS.history].schemaVersion, storage.SCHEMA_VERSION);
  // A settled read must not write at all — the change comparison it used to
  // run is exactly what this now decides structurally.
  area.writeBytes.length = 0;
  await storage.getHistory();
  assert.equal(area.writeBytes.length, 0, 'a settled read must not write');

  // An invalid record still has to be caught: the skipped validation is only
  // the duplicate one, not the gate.
  replaceAreaValues(area, {});
  await assert.rejects(
    storage.setHistory({ formatVersion: 3, repos: [['name:a', 'a', 0]], snapshots: 'nope' }),
  );
});

await test('the kill-switch disables named capabilities and ignores everything else', async () => {
  const {
    CAPABILITY_MANIFEST_URL,
    CAPABILITY_MAX_BYTES,
    KNOWN_CAPABILITIES,
    capabilityFetchIsDue,
    compareVersions,
    disabledCapabilities,
    emptyCapabilityState,
    fetchCapabilityManifest,
    parseCapabilityManifest,
    validateCapabilityState,
  } = await import('../src/lib/capabilities.js');

  assert.equal(compareVersions('1.4.0', '1.5.0'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.5', '1.5.0'), 0);

  const document = {
    formatVersion: 1,
    capabilities: [
      { name: 'web-source', fixedInVersion: '1.6.0', reason: 'github.com markup changed' },
      { name: 'api-graphql', fixedInVersion: '1.5.0' },
    ],
  };
  const parsed = parseCapabilityManifest(document);
  assert.deepEqual(
    parsed.rules.map((rule) => rule.name),
    ['web-source', 'api-graphql'],
  );
  // The rule lifts itself the moment the installed build reaches the version
  // that fixes it — nobody has to publish a second document to re-enable it.
  assert.deepEqual(disabledCapabilities(parsed, '1.4.0'), ['web-source', 'api-graphql']);
  assert.deepEqual(disabledCapabilities(parsed, '1.5.0'), ['web-source']);
  assert.deepEqual(disabledCapabilities(parsed, '1.6.0'), []);

  // The document can only ever switch a known capability off. Everything else
  // it might try to say is discarded, so it can never introduce behaviour.
  const hostile = parseCapabilityManifest({
    formatVersion: 1,
    capabilities: [
      { name: 'web-source' }, // no version: would disable it forever
      { name: '__proto__', fixedInVersion: '9.9.9' },
      { name: 'constructor', fixedInVersion: '9.9.9' },
      { name: 'eval-this', fixedInVersion: '9.9.9', script: 'alert(1)' },
      { name: 'notifications', fixedInVersion: 'not-a-version' },
      { name: 'notifications', fixedInVersion: '2.0.0', selector: '#pwned', url: 'https://evil' },
      { name: 'notifications', fixedInVersion: '3.0.0' },
      'notifications',
      null,
      42,
    ],
  });
  assert.deepEqual(
    hostile.rules,
    [{ name: 'notifications', fixedInVersion: '2.0.0', reason: '' }],
    'only the first well-formed rule for a known capability survives',
  );
  assert.ok(!Object.hasOwn(hostile.rules[0], 'selector'));
  assert.ok(!Object.hasOwn(hostile.rules[0], 'url'));
  assert.ok(!Object.hasOwn(hostile.rules[0], 'script'));
  assert.equal({}.polluted, undefined);
  assert.ok(KNOWN_CAPABILITIES.every((name) => typeof name === 'string'));

  // Anything malformed anywhere yields no rules rather than throwing: a broken
  // kill-switch must never break the extension it protects.
  for (const broken of [null, undefined, 'string', 42, [], { formatVersion: 2 }, {}]) {
    assert.deepEqual(parseCapabilityManifest(broken).rules, []);
  }

  const state = { ...emptyCapabilityState(), fetchedAt: 1000, rules: parsed.rules };
  assert.equal(validateCapabilityState(state), state);
  assert.throws(() => validateCapabilityState({ formatVersion: 1, fetchedAt: 0, rules: [{}] }));

  // At most one fetch per six hours.
  assert.equal(capabilityFetchIsDue({ fetchedAt: 0 }, { now: 1 }), true);
  assert.equal(capabilityFetchIsDue({ fetchedAt: 1000 }, { now: 1000 + 6 * 3600 * 1000 }), true);
  assert.equal(capabilityFetchIsDue({ fetchedAt: 1000 }, { now: 1000 + 3600 * 1000 }), false);

  const respond = (body, init = {}) =>
    new Response(body, { status: 200, headers: { 'content-type': 'application/json' }, ...init });
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    return respond(JSON.stringify(document));
  };
  const fetched = await fetchCapabilityManifest({ fetchImpl, now: () => 5000 });
  assert.equal(fetched.fetchedAt, 5000);
  assert.deepEqual(
    fetched.rules.map((rule) => rule.name),
    ['web-source', 'api-graphql'],
  );
  assert.equal(requests[0].url, CAPABILITY_MANIFEST_URL);
  // The security property is that the bytes came from one known origin, so a
  // redirect is refused rather than followed.
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].init.credentials, 'omit');

  // An off-origin URL is refused before any request is made.
  let attempted = false;
  await assert.rejects(
    fetchCapabilityManifest({
      url: 'https://evil.example/capabilities.json',
      fetchImpl: async () => {
        attempted = true;
        return respond('{}');
      },
    }),
  );
  assert.equal(attempted, false);

  await assert.rejects(fetchCapabilityManifest({ fetchImpl: async () => respond('not json') }));
  await assert.rejects(
    fetchCapabilityManifest({ fetchImpl: async () => respond('{}', { status: 404 }) }),
  );
  await assert.rejects(
    fetchCapabilityManifest({
      fetchImpl: async () => respond('x'.repeat(CAPABILITY_MAX_BYTES + 1)),
    }),
    /too large/,
  );
});

await test('the GraphQL and REST listings normalize to identical records', async () => {
  // One repository, described the way each API describes it. REST counts open
  // pull requests inside open_issues_count; GraphQL does not, so the adapter
  // has to add them back or the two records diverge by exactly the PR count.
  const restRepo = {
    id: 4242,
    name: 'starboard',
    full_name: 'octocat/starboard',
    html_url: 'https://github.com/octocat/starboard',
    description: 'Portfolio signal',
    language: 'JavaScript',
    stargazers_count: 52,
    forks_count: 7,
    open_issues_count: 5,
    private: false,
    fork: false,
    archived: false,
    updated_at: '2026-07-30T10:00:00Z',
    pushed_at: '2026-07-31T09:00:00Z',
  };
  const graphNode = {
    databaseId: 4242,
    name: 'starboard',
    nameWithOwner: 'octocat/starboard',
    url: 'https://github.com/octocat/starboard',
    description: 'Portfolio signal',
    primaryLanguage: { name: 'JavaScript' },
    stargazerCount: 52,
    forkCount: 7,
    openIssues: { totalCount: 3 },
    openPullRequests: { totalCount: 2 },
    isPrivate: false,
    isFork: false,
    isArchived: false,
    updatedAt: '2026-07-30T10:00:00Z',
    pushedAt: '2026-07-31T09:00:00Z',
  };
  const profile = {
    login: 'octocat',
    name: 'The Octocat',
    avatar_url: 'https://avatars.githubusercontent.com/u/1',
    html_url: 'https://github.com/octocat',
    public_repos: 1,
    followers: 12,
  };
  const graphUser = {
    login: 'octocat',
    name: 'The Octocat',
    avatarUrl: 'https://avatars.githubusercontent.com/u/1',
    url: 'https://github.com/octocat',
    followers: { totalCount: 12 },
    publicRepositories: { totalCount: 1 },
    privateRepositories: { totalCount: 0 },
    repositories: {
    totalCount: 2,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [graphNode],
    },
  };

  const json = (body, headers = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    });
  const restHeaders = {
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4998',
    'x-ratelimit-reset': '2000000',
  };

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init.method || 'GET'} ${path}`);
    if (path === '/graphql') {
      return json({
        data: {
          rateLimit: { limit: 5000, remaining: 4996, resetAt: '2033-05-18T03:33:20.000Z' },
          viewer: { ...graphUser, repositories: { totalCount: 1 } },
          user: graphUser,
        },
      });
    }
    if (path === '/user' || path === '/users/octocat') return json(profile, restHeaders);
    if (path.endsWith('/repos')) return json([restRepo], restHeaders);
    throw new Error(`unexpected request: ${path}`);
  };

  const viaGraph = await fetchAccount(
    { username: 'octocat', token: 'ghp_test' },
    { fetchImpl, retries: 0 },
  );
  const graphCalls = calls.splice(0);
  const viaRest = await fetchAccount(
    { username: 'octocat', token: 'ghp_test' },
    { fetchImpl, retries: 0, graphql: false },
  );
  const restCalls = calls.splice(0);

  assert.equal(viaGraph.transport, 'graphql');
  assert.equal(viaRest.transport, 'rest');
  assert.equal(viaGraph.authenticated, true);
  assert.equal(viaRest.authenticated, true);
  assert.equal(viaGraph.complete, false);
  assert.equal(viaGraph.partialReason, 'shortfall');
  assert.equal(viaGraph.shortfall, 1);
  assert.deepEqual(viaGraph.repos, viaRest.repos, 'normalized records must not diverge');
  assert.deepEqual(viaGraph.repos, [restRepo]);
  assert.deepEqual(viaGraph.profile, viaRest.profile);
  // One point for the whole listing versus a request per resource.
  assert.deepEqual(graphCalls, ['POST /graphql']);
  assert.ok(restCalls.length >= 2, JSON.stringify(restCalls));

  // GraphQL is 403 without a token, so a tokenless read must never try it.
  const anonymous = await fetchAccount({ username: 'octocat', token: '' }, { fetchImpl, retries: 0 });
  assert.equal(anonymous.transport, 'rest');
  assert.ok(!calls.splice(0).some((call) => call.includes('/graphql')));

  // A GraphQL failure that REST can survive falls back rather than erroring.
  const failing = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init.method || 'GET'} ${path}`);
    // An organization login: GraphQL `user(login:)` resolves to null, REST lists it.
    if (path === '/graphql') return json({ data: { rateLimit: null, viewer: null, user: null } });
    return fetchImpl(url, init);
  };
  const fellBack = await fetchAccount(
    { username: 'octocat', token: 'ghp_test' },
    { fetchImpl: failing, retries: 0 },
  );
  assert.equal(fellBack.transport, 'rest');
  assert.deepEqual(fellBack.repos, [restRepo]);

  // A GraphQL error arrives with HTTP 200; treating it as success once shipped
  // an empty list that downstream read as "every repository removed".
  const errored = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/graphql') return json({ errors: [{ message: 'Bad credentials' }] });
    return fetchImpl(url, init);
  };
  const afterError = await fetchAccount(
    { username: 'octocat', token: 'ghp_test' },
    { fetchImpl: errored, retries: 0 },
  );
  assert.equal(afterError.transport, 'rest');
  assert.deepEqual(afterError.repos, [restRepo]);

  // A rate limit means the same on both transports; retrying REST only burns
  // the budget again.
  const limited = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/graphql') {
      return new Response('{}', {
        status: 403,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '2000000',
        },
      });
    }
    return fetchImpl(url, init);
  };
  await assert.rejects(
    fetchAccount({ username: 'octocat', token: 'ghp_test' }, { fetchImpl: limited, retries: 0 }),
    (error) => error.code === 'RATE_LIMITED',
  );
});

await test('a sparkline series keeps gaps and never carries a value forward', async () => {
  const {
    SPARKLINE_MAX_GAP_DAYS,
    historyRepoIndex,
    historySeriesForRepo,
    sparklineSegments,
  } = await import('../src/lib/history.js');
  const now = Date.UTC(2026, 0, 31, 12);
  const day = (offset) =>
    new Date(Date.UTC(2026, 0, 31) - offset * 86400000).toISOString().slice(0, 10);
  const point = (offset, stars) => ({
    day: day(offset),
    at: Date.UTC(2026, 0, 31) - offset * 86400000,
    source: 'api',
    confidence: 'exact',
    stars: [stars],
    forks: [1],
    approx: [],
  });
  // Measured on days 9, 8, 7 then a six-day hole, then 0. The hole is wider
  // than the carry-forward window, so the line must break rather than imply a
  // trend across it.
  const history = {
    formatVersion: 3,
    repos: [['name:octocat/one', 'octocat/one', 0]],
    snapshots: [point(9, 10), point(8, 12), point(7, 13), point(0, 40)],
  };
  const repo = { full_name: 'octocat/one' };
  const series = historySeriesForRepo(history, repo, 10, { now });

  assert.equal(series.values.length, 10);
  assert.equal(series.measured, 4);
  assert.equal(series.gaps, 6);
  assert.equal(series.first, 10);
  assert.equal(series.last, 40);
  assert.equal(series.delta, 30);
  assert.equal(series.from, day(9));
  assert.equal(series.to, day(0));
  assert.equal(series.firstDay, day(9));
  assert.equal(series.lastDay, day(0));
  // A missing day is null, never the previous measurement and never zero.
  assert.deepEqual(
    series.values.map((v) => v.value),
    [10, 12, 13, null, null, null, null, null, null, 40],
  );

  const segments = sparklineSegments(series.values);
  assert.equal(segments.length, 2, 'a six-day hole must split the line');
  assert.deepEqual(
    segments[0].map((p) => p.value),
    [10, 12, 13],
  );
  assert.deepEqual(
    segments[1].map((p) => p.value),
    [40],
  );

  // A hole inside the carry-forward window stays one segment.
  const narrow = historySeriesForRepo(
    {
      ...history,
      snapshots: [point(3, 10), point(1, 14), point(0, 15)],
    },
    repo,
    10,
    { now },
  );
  assert.equal(sparklineSegments(narrow.values).length, 1);
  // The reported dates are the days measured, not the window's edges.
  assert.equal(narrow.from, day(9));
  assert.equal(narrow.firstDay, day(3));
  assert.equal(narrow.lastDay, day(0));
  assert.ok(SPARKLINE_MAX_GAP_DAYS >= 2);

  // A repository with no retained series reports the empty shape, not a throw.
  const missing = historySeriesForRepo(history, { full_name: 'octocat/absent' }, 10, { now });
  assert.equal(missing.measured, 0);
  assert.equal(missing.gaps, 10);
  assert.equal(missing.delta, null);
  assert.deepEqual(sparklineSegments(missing.values), []);

  // The shared index must select the same slot the scan would.
  const indexed = historySeriesForRepo(history, repo, 10, {
    now,
    index: historyRepoIndex(history),
  });
  assert.deepEqual(indexed.values, series.values);
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

  assert.deepEqual(
    deriveLifecycleEvents(
      { ...previous, authenticated: true },
      { ...current, authenticated: false },
      { generation: 'g2', now: 200, source: 'api' },
    ),
    [],
    'authentication loss is a source boundary, not repository removals',
  );
});

await test('lifecycle history keeps exactly MAX_EVENTS at its boundary', async () => {
  const events = Array.from({ length: MAX_EVENTS + 1 }, (_, index) => ({
    id: `event-${index}`,
    at: index,
  }));
  assert.equal(mergeLifecycleEvents([], events.slice(0, MAX_EVENTS)).length, MAX_EVENTS);
  const overflow = mergeLifecycleEvents([], events);
  assert.equal(overflow.length, MAX_EVENTS);
  assert.equal(overflow[0].id, `event-${MAX_EVENTS}`);
  assert.equal(overflow.at(-1).id, 'event-1');
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

await test('refresh history cap follows the browser-reported local quota', async () => {
  assert.equal(historyMaxBytesForQuota(5 * 1024 * 1024), 1024 * 1024);
  assert.equal(historyMaxBytesForQuota(10 * 1024 * 1024), 2 * 1024 * 1024);
  assert.equal(historyMaxBytesForQuota(undefined), HISTORY_MAX_BYTES);

  replaceAreaValues(area, {});
  area.QUOTA_BYTES = 4_000;
  const repos = Array.from({ length: 100 }, (_, index) => ({
    id: index,
    full_name: `octocat/${'quota-sensitive-name-'.repeat(5)}${index}`,
    stargazers_count: index,
    forks_count: 0,
    private: false,
  }));
  const cache = {
    profile: { login: 'octocat' },
    repos,
    fetchedAt: Date.UTC(2026, 0, 1, 12),
    source: 'api',
    confidence: 'exact',
  };
  await storage.commitRefresh(cache, storage.snapshotOf(repos), 'quota-generation');
  const persisted = area.values.history.data;
  assert.ok(historyByteSize(persisted) <= 800);
  assert.ok(persisted.repos.length < repos.length, 'the reported cap must drive pruning');
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

await test('large history backups stay compact enough to restore', async () => {
  const repositoryCount = 650;
  const dayCount = 365;
  const repos = Array.from({ length: repositoryCount }, (_, index) => ({
    id: index + 1,
    name: `repository-${index}`,
    full_name: `octocat/repository-${index}`,
    stargazers_count: 1,
    forks_count: 0,
    private: false,
    fork: false,
    archived: false,
  }));
  const dictionary = repos.map((repo) => [`name:${repo.full_name}`, repo.full_name, 0]);
  const history = {
    formatVersion: 3,
    repos: dictionary,
    snapshots: Array.from({ length: dayCount }, (_, index) => {
      const at = Date.UTC(2025, 7, 2 + index);
      return {
        day: new Date(at).toISOString().slice(0, 10),
        at,
        source: 'api',
        confidence: 'exact',
        stars: Array(repositoryCount).fill(1),
        forks: Array(repositoryCount).fill(0),
        approx: [],
      };
    }),
  };
  const document = await createBackup({
    settings: { ...storage.DEFAULTS, username: 'octocat', dataSource: 'api' },
    cache: {
      profile: { login: 'octocat' },
      repos,
      fetchedAt: Date.UTC(2026, 7, 1),
      source: 'api',
      confidence: 'exact',
    },
    history,
    includeHistory: true,
    now: Date.UTC(2026, 7, 1),
  });

  const compact = serializeBackup(document);
  const pretty = `${JSON.stringify(document, null, 2)}\n`;
  const encoded = new TextEncoder();
  assert.ok(
    encoded.encode(pretty).byteLength > BACKUP_MAX_BYTES,
    'the prior pretty-printed export must exceed the restore ceiling',
  );
  assert.ok(encoded.encode(compact).byteLength <= BACKUP_MAX_BYTES);
  const preview = await validateBackupText(compact);
  assert.equal(preview.summary.repositories, repositoryCount);
  assert.equal(preview.summary.historyDays, dayCount);
  assert.equal(preview.summary.historyPoints, repositoryCount * dayCount);
});

await test('backup restore size accepts its exact boundary and rejects one byte more', async () => {
  assert.doesNotThrow(() => assertBackupSize(BACKUP_MAX_BYTES));
  assert.throws(
    () => assertBackupSize(BACKUP_MAX_BYTES + 1, { historyIncluded: true }),
    (error) =>
      error.code === 'BACKUP_TOO_LARGE' &&
      error.bytes === BACKUP_MAX_BYTES + 1 &&
      error.maxBytes === BACKUP_MAX_BYTES &&
      error.historyIncluded,
  );
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
      minimum_chrome_version: '120',
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
    userAgent: 'Mozilla/5.0 Chrome/120.0.0.0',
    now: Date.UTC(2026, 6, 29, 4),
  });
  const text = JSON.stringify(diagnostics);
  assert.equal(diagnostics.extension.minimumChromeVersion, '120');
  assert.equal(diagnostics.extension.runtimeChromeMajor, 120);
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

  const notified = markNotificationsNotified(
    first,
    first.pending.map((event) => event.id),
    3000,
  );
  assert.equal(notified.pending.length, 4);
  assert.equal(notified.pending.every((event) => event.notifiedAt === 3000), true);
  assert.equal(Object.keys(notified.seen).length, 0);

  const acknowledged = acknowledgeNotifications(notified, null, 3500);
  assert.equal(acknowledged.pending.length, 0);
  assert.equal(Object.keys(acknowledged.seen).length, 4);
  const noRepeat = evaluateNotificationEvents(previous, current, config, acknowledged, {
    generation: 'notification-g2',
    now: 4000,
  });
  assert.equal(
    noRepeat.pending.filter((event) => event.id.includes('milestone')).length,
    0,
  );
});

await test('nine notified alerts remain reachable until the user acknowledges them', async () => {
  const pending = Array.from({ length: 9 }, (_, index) => ({
    id: `alert-${index + 1}`,
    title: `Alert ${index + 1}`,
    message: `Repository event ${index + 1}.`,
    createdAt: 1000 + index,
  }));
  const state = { ...emptyNotificationState(), pending };
  const notified = markNotificationsNotified(
    state,
    pending.map((event) => event.id),
    2000,
  );
  assert.equal(notified.pending.length, 9);
  assert.deepEqual(
    notified.pending.map((event) => event.message),
    pending.map((event) => event.message),
  );
  assert.equal(notified.pending.every((event) => event.notifiedAt === 2000), true);
  assert.equal(Object.keys(notified.seen).length, 0);

  const acknowledged = acknowledgeNotifications(notified, null, 3000);
  assert.equal(acknowledged.pending.length, 0);
  assert.equal(Object.keys(acknowledged.seen).length, 9);
});

await test('notification queue overflow records every alert it cannot retain', async () => {
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
    ],
  };
  const current = {
    confidence: 'exact',
    repos: [{ ...previous.repos[0], stargazers_count: 12 }],
  };
  const pending = Array.from({ length: 50 }, (_, index) => ({
    id: `existing-${index}`,
    title: `Existing ${index}`,
    message: `Existing alert ${index}.`,
    createdAt: index,
  }));
  const next = evaluateNotificationEvents(
    previous,
    current,
    {
      ...DEFAULT_NOTIFICATION_CONFIG,
      enabled: true,
      portfolioMilestone: 0,
      portfolioDelta: 0,
      repositoryMilestone: 10,
      repositoryDelta: 3,
    },
    { ...emptyNotificationState(), pending },
    { generation: 'overflow-generation', now: 1000 },
  );
  assert.equal(next.pending.length, 50);
  assert.equal(next.dropped, 2);
  assert.equal(next.pending.some((event) => event.id === 'existing-0'), false);
  assert.equal(next.pending.some((event) => event.id === 'existing-1'), false);
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

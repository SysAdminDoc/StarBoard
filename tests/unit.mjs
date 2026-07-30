import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, 'fixtures', 'storage');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function memoryArea(initial = {}) {
  const values = clone(initial);
  return {
    values,
    async get(keys) {
      if (keys == null) return clone(values);
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        names.filter((name) => Object.hasOwn(values, name)).map((name) => [name, clone(values[name])]),
      );
    },
    async set(next) {
      Object.assign(values, clone(next));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
    async getBytesInUse() {
      return Buffer.byteLength(JSON.stringify(values));
    },
  };
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
  recordDailyHistory,
} = await import('../src/lib/history.js');

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
  const migrated = storage.migrateRecord('settings', current, 4);
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

  await storage.clearPortfolioData();
  assert.equal(await storage.getCache(), null);
  assert.equal(await storage.getBaseline(), null);
  assert.equal((await storage.getUndoStatus()).scope, 'clear-portfolio');

  const restored = await storage.restoreUndoSnapshot();
  assert.equal(restored.cache.generation, 'undo-g1');
  assert.equal(restored.baseline.generation, 'undo-g1');
  assert.equal(restored.history.snapshots.length, 1);
  assert.equal((await storage.getUndoStatus()).available, false);

  await storage.createUndoSnapshot('baseline-reset', ['baseline']);
  area.values[storage.STORAGE_KEYS.undo].data.expiresAt = Date.now() - 1;
  assert.equal((await storage.getUndoStatus()).available, false);
  assert.equal(area.values[storage.STORAGE_KEYS.undo], undefined);
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
  assert.equal(history.snapshots[0].repos[0].stars, 11);

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
  assert.equal(comparison.fullName, 'octocat/old-name');
  assert.equal(renamed.stargazers_count - comparison.stars, 7);
});

await test('history enforces 365 UTC days and the two-megabyte hard cap', async () => {
  const start = Date.UTC(2025, 0, 1, 12);
  let history = null;
  for (let day = 0; day < 370; day += 1) {
    history = recordDailyHistory(
      history,
      {
        source: 'web',
        confidence: 'approximate',
        repos: [
          {
            id: 'octocat/demo',
            full_name: 'octocat/demo',
            stargazers_count: day,
            forks_count: 0,
            private: false,
            approx: true,
          },
        ],
      },
      { now: start + day * 86_400_000 },
    );
  }
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

const failed = checks.filter((check) => !check.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} unit checks passed`);
process.exit(failed.length ? 1 : 0);

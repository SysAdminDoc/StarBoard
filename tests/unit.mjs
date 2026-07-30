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
globalThis.chrome = { storage: { local: area } };

const storage = await import('../src/lib/storage.js');
const { createRefreshCoordinator } = await import('../src/lib/refresh-coordinator.js');
const { parseRetryAfter, requestText, RequestPolicyError } = await import('../src/lib/request.js');

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

await test('current settings migration is idempotent', async () => {
  const current = await fixture('v1.2.0-settings.json');
  const first = storage.migrateRecord('settings', current, 3);
  const second = storage.migrateRecord('settings', first.envelope, 4);
  assert.equal(first.changed, false);
  assert.equal(second.changed, false);
  assert.deepEqual(second.envelope.data, current.data);
});

await test('corrupt settings restore last-known-good and record redacted quarantine metadata', async () => {
  Object.keys(area.values).forEach((key) => delete area.values[key]);
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

const failed = checks.filter((check) => !check.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} unit checks passed`);
process.exit(failed.length ? 1 : 0);

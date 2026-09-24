// Tests for the CRE two-tier cache, including the negative case that an expired entry is never served as fresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCreCache } from '../../../server/providers/cre/common/cache.js';

async function tempRoot(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cre-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => (now += ms) };
}

test('NEGATIVE: an expired entry is not served as fresh from memory or disk', async (t) => {
  const rootDir = await tempRoot(t);
  const c = clock();
  const cache = createCreCache({
    family: 'test',
    ttlMs: 1000,
    rootDir,
    now: c.now,
  });
  await cache.set('k', { v: 1 });
  assert.equal((await cache.getFresh('k')).source, 'HIT');
  c.advance(1001);
  assert.equal(await cache.getFresh('k'), null);
  cache.clearMemory();
  assert.equal(await cache.getFresh('k'), null, 'disk copy is expired too');

  let loads = 0;
  const result = await cache.getOrLoad('k', async () => {
    loads += 1;
    return { v: 2 };
  });
  assert.equal(loads, 1, 'expired entry forces a reload');
  assert.equal(result.source, 'MISS');
  assert.deepEqual(result.value, { v: 2 });
});

test('fresh entries come from memory, then disk after a restart', async (t) => {
  const rootDir = await tempRoot(t);
  const c = clock();
  const options = { family: 'fam-a', ttlMs: 5000, rootDir, now: c.now };
  const a = createCreCache(options);
  await a.getOrLoad('key', async () => 'value');
  const again = await a.getOrLoad('key', async () => assert.fail('no load'));
  assert.equal(again.source, 'HIT');
  const files = await readdir(path.join(rootDir, 'fam-a'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f]{40}\.json$/);

  const b = createCreCache(options);
  const hit = await b.getOrLoad('key', async () => assert.fail('no load'));
  assert.equal(hit.source, 'DISK');
  assert.equal(hit.value, 'value');
});

test('NEGATIVE: a version-1 entry is not served under version 2, memory or disk', async (t) => {
  const rootDir = await tempRoot(t);
  const c = clock();
  const v1 = createCreCache({
    family: 'versioned',
    ttlMs: 60_000,
    rootDir,
    now: c.now,
  });
  await v1.set('k', 'old-logic-value');
  assert.equal((await v1.getFresh('k')).value, 'old-logic-value');

  // Same family, same key, bumped version -- a process restart with the new
  // version must not read the old process's cached value from memory
  // (fresh instance below has no memory of it) or from disk (the assertion
  // that matters: same rootDir, same family, same key, different version).
  const v2 = createCreCache({
    family: 'versioned',
    ttlMs: 60_000,
    rootDir,
    now: c.now,
    version: 2,
  });
  assert.equal(
    await v2.getFresh('k'),
    null,
    'version 2 must not see version 1\'s disk entry',
  );
  let loads = 0;
  const result = await v2.getOrLoad('k', async () => {
    loads += 1;
    return 'new-logic-value';
  });
  assert.equal(loads, 1, 'version bump forces a real reload, not a stale serve');
  assert.equal(result.value, 'new-logic-value');

  // The version-1 cache is untouched -- still serves its own old value from
  // its own directory, proving the two versions are fully isolated on disk.
  assert.equal((await v1.getFresh('k')).value, 'old-logic-value');
});

test('NEGATIVE: an invalid version is rejected, never silently coerced', () => {
  assert.throws(() => createCreCache({ family: 'x', ttlMs: 1000, version: 0 }));
  assert.throws(() =>
    createCreCache({ family: 'x', ttlMs: 1000, version: 1.5 }),
  );
  assert.throws(() =>
    createCreCache({ family: 'x', ttlMs: 1000, version: -1 }),
  );
});

test('serves stale data at any age when the loader fails, and rethrows with none', async (t) => {
  const rootDir = await tempRoot(t);
  const c = clock();
  const cache = createCreCache({
    family: 'stale',
    ttlMs: 1000,
    rootDir,
    now: c.now,
  });
  await cache.set('k', 'old');
  c.advance(10 * 24 * 3600 * 1000);
  const stale = await cache.getOrLoad('k', async () => {
    throw new Error('down');
  });
  assert.equal(stale.source, 'STALE');
  assert.equal(stale.value, 'old');

  await assert.rejects(
    cache.getOrLoad('missing', async () => {
      throw new Error('down');
    }),
    /down/,
  );
});

test('concurrent loads for one key share a single loader call', async (t) => {
  const rootDir = await tempRoot(t);
  const cache = createCreCache({ family: 'coalesce', ttlMs: 1000, rootDir });
  let loads = 0;
  const loader = async () => {
    loads += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return 7;
  };
  const [x, y] = await Promise.all([
    cache.getOrLoad('k', loader),
    cache.getOrLoad('k', loader),
  ]);
  assert.equal(loads, 1);
  assert.equal(x.value, 7);
  assert.equal(y.value, 7);
  assert.deepEqual([x.source, y.source].sort(), ['INFLIGHT', 'MISS']);
});

test('memory cap evicts the oldest entry', async () => {
  const cache = createCreCache({
    family: 'cap',
    ttlMs: 1000,
    maxEntries: 2,
    disk: false,
  });
  await cache.set('a', 1);
  await cache.set('b', 2);
  await cache.set('c', 3);
  assert.equal(await cache.getFresh('a'), null);
  assert.equal((await cache.getFresh('c')).value, 3);
});

test('NEGATIVE: a family name that could escape the cache folder is refused', () => {
  assert.throws(() => createCreCache({ family: '../etc', ttlMs: 1 }), /family/);
  assert.throws(() => createCreCache({ family: 'ok', ttlMs: 0 }), /TTL/);
});

test('manual refresh bypasses a fresh entry once per cooldown and retains dated last-good data', async () => {
  const c = clock();
  const cache = createCreCache({
    family: 'refresh',
    ttlMs: 60_000,
    minRefreshIntervalMs: 30_000,
    now: c.now,
    disk: false,
  });
  await cache.set('site', { value: 1 });
  c.advance(1_000);
  let loads = 0;
  const refreshed = await cache.getOrLoad(
    'site',
    async () => {
      loads++;
      return { value: 2 };
    },
    { refresh: true },
  );
  assert.equal(refreshed.value.value, 2);
  assert.equal(refreshed.cachedAt, 1_001_000);
  assert.equal(refreshed.refreshStatus, 'succeeded');
  const throttled = await cache.getOrLoad(
    'site',
    async () => {
      loads++;
      return 3;
    },
    { refresh: true },
  );
  assert.equal(loads, 1);
  assert.equal(throttled.refreshStatus, 'throttled');
  assert.equal(throttled.cachedAt, refreshed.cachedAt);
  c.advance(30_001);
  const failed = await cache.getOrLoad(
    'site',
    async () => {
      throw new Error('upstream down');
    },
    { refresh: true },
  );
  assert.equal(failed.source, 'STALE');
  assert.equal(failed.refreshStatus, 'failed');
  assert.equal(failed.cachedAt, refreshed.cachedAt);
  assert.equal(failed.attemptedAt, c.now());
});

test('manual refresh shares one inflight attempt and throttles retry after cold failure', async () => {
  const c = clock();
  const cache = createCreCache({
    family: 'refresh-cold',
    ttlMs: 60_000,
    minRefreshIntervalMs: 30_000,
    now: c.now,
    disk: false,
  });
  let resolve;
  let loads = 0;
  const loader = async () => {
    loads++;
    return new Promise((done) => {
      resolve = done;
    });
  };
  const a = cache.getOrLoad('site', loader, { refresh: true });
  const b = cache.getOrLoad('site', loader, { refresh: true });
  await new Promise((done) => setImmediate(done));
  resolve(7);
  const both = await Promise.all([a, b]);
  assert.equal(loads, 1);
  assert.deepEqual(
    both.map((result) => result.refreshStatus),
    ['succeeded', 'succeeded'],
  );
  await assert.rejects(
    cache.getOrLoad(
      'missing',
      async () => {
        throw new Error('down');
      },
      { refresh: true },
    ),
    /down/,
  );
  await assert.rejects(
    cache.getOrLoad('missing', async () => 1, { refresh: true }),
    /cooldown/,
  );
});

test('a synchronous loader throw does not pin rejected in-flight state', async () => {
  const cache = createCreCache({
    family: 'sync-throw',
    ttlMs: 1000,
    disk: false,
  });
  await assert.rejects(
    cache.getOrLoad('site', () => {
      throw new Error('sync');
    }),
    /sync/,
  );
  const recovered = await cache.getOrLoad('site', async () => 'recovered');
  assert.equal(recovered.value, 'recovered');
  assert.equal(recovered.source, 'MISS');
});

test('refresh joining ordinary in-flight work does not claim a forced refresh', async () => {
  const cache = createCreCache({
    family: 'ordinary-inflight',
    ttlMs: 1000,
    disk: false,
  });
  let resolve;
  const ordinary = cache.getOrLoad(
    'site',
    async () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await new Promise((done) => setImmediate(done));
  const refresh = cache.getOrLoad(
    'site',
    async () => assert.fail('second load'),
    { refresh: true },
  );
  await new Promise((done) => setImmediate(done));
  resolve('data');
  assert.equal((await ordinary).value, 'data');
  const joined = await refresh;
  assert.equal(joined.refreshStatus, 'joined-existing');
  assert.equal(joined.attemptedAt, undefined);
});

test('partial responses can be served without pinning them in cache', async () => {
  const cache = createCreCache({
    family: 'partial-opt-out',
    ttlMs: 1000,
    disk: false,
  });
  const first = await cache.getOrLoad('site', async () => ({ partial: true }), {
    shouldCache: (value) => !value.partial,
  });
  assert.equal(first.value.partial, true);
  assert.equal(await cache.getFresh('site'), null);
});

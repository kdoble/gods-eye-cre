// Two-tier CRE response cache (memory plus .gev-cache/cre/<family>/ on disk) so public data sources are hit once per TTL and a dead source serves last-good data.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';

export const CRE_CACHE_ROOT = path.join(process.cwd(), '.gev-cache', 'cre');
const FAMILY_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * @typedef {object} CacheEntry
 * @property {*} value
 * @property {number} cachedAt - Epoch ms.
 */

/**
 * @typedef {'HIT'|'DISK'|'MISS'|'INFLIGHT'|'STALE'} CacheSource
 */

/**
 * Create a cache for one data family.
 *
 * @param {object} options
 * @param {string} options.family - Lowercase slug; becomes the disk folder name.
 * @param {number} options.ttlMs - Fresh lifetime for memory and disk entries.
 * @param {number} [options.maxEntries] - Memory entry cap, oldest evicted first.
 * @param {string} [options.rootDir] - Disk root; tests pass a temp dir.
 * @param {boolean} [options.disk] - Set false for memory only.
 * @param {() => number} [options.now]
 * @param {number} [options.minRefreshIntervalMs] - Per-key manual refresh cooldown.
 * @param {number} [options.version] - Schema/logic version for this family's
 *   stored values, default 1. Bump it any time a provider changes what it
 *   loads or how it shapes the cached value for the SAME key: without this,
 *   a disk (or long-TTL memory) entry written by the old logic keeps being
 *   served as fresh until its TTL expires, so a shipped fix silently does
 *   not take effect for callers who already have a cached answer. Folded
 *   into the disk directory (never the memory map, which is process-local
 *   and reset on every deploy) so version 1 and version 2 never collide
 *   there either. version 1 keeps the pre-versioning disk path unchanged.
 */
export function createCreCache({
  family,
  ttlMs,
  maxEntries = 500,
  rootDir = CRE_CACHE_ROOT,
  disk = true,
  now = Date.now,
  minRefreshIntervalMs = 30_000,
  version = 1,
}) {
  if (!FAMILY_PATTERN.test(String(family))) {
    throw new Error('Invalid CRE cache family');
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('Invalid CRE cache TTL');
  }
  if (!Number.isFinite(minRefreshIntervalMs) || minRefreshIntervalMs < 0)
    throw new Error('Invalid CRE cache refresh interval');
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('Invalid CRE cache version');
  }
  const dir =
    version === 1
      ? path.join(rootDir, family)
      : path.join(rootDir, family, `v${version}`);
  /** @type {Map<string, CacheEntry>} */
  const memory = new Map();
  /** @type {Map<string, Promise<*>>} */
  const inFlight = new Map();
  const inFlightRefresh = new Set();
  const lastRefreshAttempt = new Map();

  const hashKey = (key) => createHash('sha1').update(String(key)).digest('hex');
  const diskPath = (key) => path.join(dir, `${hashKey(key)}.json`);
  const isFresh = (entry) => now() - entry.cachedAt <= ttlMs;

  function remember(key, entry) {
    memory.delete(key);
    memory.set(key, entry);
    while (memory.size > maxEntries) {
      memory.delete(memory.keys().next().value);
    }
  }

  /** @returns {Promise<CacheEntry|null>} Any-age disk entry. */
  async function readDisk(key) {
    if (!disk) return null;
    try {
      const entry = JSON.parse(await fsp.readFile(diskPath(key), 'utf8'));
      if (!entry || !Number.isFinite(entry.cachedAt) || !('value' in entry)) {
        return null;
      }
      return entry;
    } catch {
      return null;
    }
  }

  async function writeDisk(key, entry) {
    if (!disk) return;
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(diskPath(key), JSON.stringify(entry));
    } catch (error) {
      console.warn(`[CRE cache:${family}] disk write failed`, error?.code);
    }
  }

  /**
   * Fresh value only. An expired entry returns null, never a stale value.
   * @returns {Promise<{value:*, cachedAt:number, source:'HIT'|'DISK'}|null>}
   */
  async function getFresh(key) {
    const cached = memory.get(key);
    if (cached && isFresh(cached)) return { ...cached, source: 'HIT' };
    const stored = await readDisk(key);
    if (stored && isFresh(stored)) {
      remember(key, stored);
      return { ...stored, source: 'DISK' };
    }
    return null;
  }

  /**
   * Last-good value at any age, for serve-stale-on-error.
   * @returns {Promise<CacheEntry|null>}
   */
  async function getStale(key) {
    return memory.get(key) || (await readDisk(key));
  }

  /** Store a value in memory and on disk. */
  async function set(key, value) {
    const entry = { value, cachedAt: now() };
    remember(key, entry);
    await writeDisk(key, entry);
    return entry;
  }

  /**
   * Fresh cache, else one shared load, else last-good data if the load fails.
   * The loader's error is rethrown only when no stale entry exists.
   *
   * @param {string} key
   * @param {() => Promise<*>} loader
   * @param {{refresh?:boolean,shouldCache?:(value:*)=>boolean}} [options] - Bypass a fresh value after the per-key cooldown; partial results may opt out of storage.
   * @returns {Promise<{value:*, cachedAt:number, source:CacheSource,refreshStatus?:'succeeded'|'failed'|'throttled'|'joined-existing',attemptedAt?:number}>}
   */
  async function getOrLoad(
    key,
    loader,
    { refresh = false, shouldCache = () => true } = {},
  ) {
    if (!refresh) {
      const fresh = await getFresh(key);
      if (fresh) return fresh;
    }
    const pending = inFlight.get(key);
    if (pending) {
      const attemptedAt = inFlightRefresh.has(key)
        ? lastRefreshAttempt.get(key)
        : undefined;
      const joinedStatus = refresh
        ? attemptedAt === undefined
          ? 'joined-existing'
          : 'succeeded'
        : undefined;
      try {
        return {
          ...(await pending),
          source: 'INFLIGHT',
          ...(refresh
            ? {
                refreshStatus: joinedStatus,
                ...(attemptedAt !== undefined ? { attemptedAt } : {}),
              }
            : {}),
        };
      } catch (error) {
        const stale = await getStale(key);
        if (stale)
          return {
            ...stale,
            source: 'STALE',
            ...(refresh
              ? {
                  refreshStatus:
                    attemptedAt === undefined ? 'joined-existing' : 'failed',
                  ...(attemptedAt !== undefined ? { attemptedAt } : {}),
                }
              : {}),
          };
        throw error;
      }
    }
    const attemptedAt = lastRefreshAttempt.get(key);
    if (
      refresh &&
      attemptedAt !== undefined &&
      now() - attemptedAt < minRefreshIntervalMs
    ) {
      const prior = await getStale(key);
      if (prior)
        return {
          ...prior,
          source: isFresh(prior) ? 'HIT' : 'STALE',
          refreshStatus: 'throttled',
          attemptedAt,
        };
      const error = new Error('CRE refresh cooldown');
      error.code = 'REFRESH_COOLDOWN';
      throw error;
    }
    const startedAt = refresh ? now() : undefined;
    if (refresh) {
      lastRefreshAttempt.delete(key);
      lastRefreshAttempt.set(key, startedAt);
      while (lastRefreshAttempt.size > maxEntries)
        lastRefreshAttempt.delete(lastRefreshAttempt.keys().next().value);
    }
    // Defer loader invocation until after the promise is registered. A loader
    // that throws before its first await must not leave a rejected in-flight
    // promise pinned forever.
    const load = Promise.resolve()
      .then(async () => {
        const value = await loader();
        return shouldCache(value)
          ? await set(key, value)
          : { value, cachedAt: now() };
      })
      .finally(() => {
        inFlight.delete(key);
        inFlightRefresh.delete(key);
      });
    inFlight.set(key, load);
    if (refresh) inFlightRefresh.add(key);
    try {
      return {
        ...(await load),
        source: 'MISS',
        ...(refresh
          ? { refreshStatus: 'succeeded', attemptedAt: startedAt }
          : {}),
      };
    } catch (error) {
      const stale = await getStale(key);
      if (stale)
        return {
          ...stale,
          source: 'STALE',
          ...(refresh
            ? { refreshStatus: 'failed', attemptedAt: startedAt }
            : {}),
        };
      throw error;
    }
  }

  return {
    family,
    dir,
    getFresh,
    getStale,
    set,
    getOrLoad,
    clearMemory: () => memory.clear(),
  };
}

// GET /api/cre/wayback/{releases,changes,metadata}: the Esri World Imagery Wayback release catalog and the few releases whose imagery actually changed at a site, so the time slider and the supply section step through real changes, never 196 identical frames.
import { readResponseJsonCapped } from '../common/http.js';
import { createCreCache } from './common/cache.js';
import { queryPoint } from './common/arcgis.js';
import {
  CRE_ERRORS,
  creBody,
  creRoute,
  makeCreLimiter,
  parsePoint,
  sendError,
  sendJson,
} from './common/route.js';

export const WAYBACK_CONFIG_URL =
  'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json';
export const WAYBACK_TILEMAP_BASE =
  'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tilemap';
export const WAYBACK_TILE_TEMPLATE =
  'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/{release}/{z}/{y}/{x}';
export const WAYBACK_ATTRIBUTION =
  'Esri, Vantor, Earthstar Geographics, CNES/Airbus DS, USDA FSA, USGS, Aerogrid, IGN, IGP, and the GIS User Community';
export const WAYBACK_SOURCE = Object.freeze({
  name: `Esri World Imagery Wayback (${WAYBACK_ATTRIBUTION})`,
  url: 'https://livingatlas.arcgis.com/wayback/',
  license: 'Esri terms of use: display with attribution, no tile caching',
});

/** Tile zoom the change detection runs at (about 1.2 m per pixel). */
export const WAYBACK_CHANGE_ZOOM = 17;
/** Metadata layer id that covers zoom 17 in every release's metadata service. */
const METADATA_LAYER_FOR_Z17 = 6;
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const CHANGES_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_TILEMAP_BYTES = 16 * 1024;
const TITLE_DATE = /(\d{4})-(\d{2})-(\d{2})/;
const METADATA_HOST = 'metadata.maptiles.arcgis.com';

/**
 * @typedef {object} WaybackRelease
 * @property {number} num - Release number (the {release} tile path segment).
 * @property {string} date - Release date, YYYY-MM-DD.
 * @property {string} tileTemplate - {z}/{y}/{x} tile URL for this release.
 * @property {string|null} metadataUrl - Metadata MapServer for this release.
 */

/** @param {string} text @returns {string|null} Valid YYYY-MM-DD or null. */
function titleDate(text) {
  const match = TITLE_DATE.exec(String(text || ''));
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

/** Metadata URL only when it is https on Esri's metadata host. */
function safeMetadataUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.hostname !== METADATA_HOST) {
      return null;
    }
    return url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * Parse waybackconfig.json into releases sorted newest first. Entries with a
 * bad key or an unreadable itemTitle date are skipped and counted.
 * @param {unknown} config
 * @returns {{releases: WaybackRelease[], warnings: {skipped:number, reasons:string[]}}}
 */
export function parseWaybackConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Invalid Wayback config');
  }
  const releases = [];
  const reasons = [];
  for (const [key, entry] of Object.entries(config)) {
    const num = Number(key);
    if (!Number.isInteger(num) || num <= 0) {
      reasons.push(`bad release key ${String(key).slice(0, 20)}`);
      continue;
    }
    const date = titleDate(entry?.itemTitle);
    if (!date) {
      reasons.push(`release ${num}: unreadable itemTitle date`);
      continue;
    }
    releases.push({
      num,
      date,
      tileTemplate: WAYBACK_TILE_TEMPLATE.replace('{release}', String(num)),
      metadataUrl: safeMetadataUrl(entry?.metadataLayerUrl),
    });
  }
  releases.sort((a, b) =>
    a.date === b.date ? b.num - a.num : a.date < b.date ? 1 : -1,
  );
  return { releases, warnings: { skipped: reasons.length, reasons } };
}

/**
 * Web Mercator tile containing a point.
 * @param {number} lat @param {number} lon @param {number} z
 * @returns {{z:number, x:number, y:number}}
 */
export function tileForPoint(lat, lon, z = WAYBACK_CHANGE_ZOOM) {
  const n = 2 ** z;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (clampedLat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
  );
  return {
    z,
    x: Math.min(n - 1, Math.max(0, x)),
    y: Math.min(n - 1, Math.max(0, y)),
  };
}

/** Fetch JSON with a timeout and byte cap; redirects are followed. */
async function fetchJson(url, { fetchImpl, maxBytes, signal }) {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetchImpl(url, {
    signal: combined,
    redirect: 'follow',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    void response.body?.cancel?.().catch(() => {});
    const error = new Error('Wayback HTTP failure');
    error.code = 'HTTP_ERROR';
    error.status = response.status;
    throw error;
  }
  return readResponseJsonCapped(response, maxBytes, combined);
}

/**
 * One tilemap probe. `select[0]`, when present, is the release where this
 * tile last changed at or before `release`; absent means `release` itself.
 * @returns {Promise<{state:'present', effective:number}|{state:'absent'}|{state:'unknown'}>}
 */
async function probeTilemap(release, tile, { fetchImpl, signal }) {
  const url = `${WAYBACK_TILEMAP_BASE}/${release}/${tile.z}/${tile.y}/${tile.x}/1/1`;
  let body;
  try {
    body = await fetchJson(url, {
      fetchImpl,
      maxBytes: MAX_TILEMAP_BYTES,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { state: 'unknown' };
  }
  if (!body || !Array.isArray(body.data)) return { state: 'unknown' };
  if (body.data[0] !== 1) return { state: 'absent' };
  const selected = Number(body.select?.[0]);
  return {
    state: 'present',
    effective: Number.isInteger(selected) && selected > 0 ? selected : release,
  };
}

/**
 * Walk releases newest to oldest, jumping past every release that shares the
 * same tile, so the call count equals the number of real changes plus gaps.
 * A failed probe marks that release unknown (never changed) and the walk
 * continues with the next older release.
 * @param {WaybackRelease[]} releases - Newest first.
 * @param {{z:number,x:number,y:number}} tile
 * @returns {Promise<{changed: WaybackRelease[], unknown: number[], probes: number}>}
 */
export async function findChangedReleases(releases, tile, options = {}) {
  const { fetchImpl = globalThis.fetch, signal } = options;
  const indexByNum = new Map(releases.map((r, i) => [r.num, i]));
  const changed = [];
  const seen = new Set();
  const unknown = [];
  let probes = 0;
  let i = 0;
  while (i < releases.length) {
    if (signal?.aborted) throw new Error('aborted');
    const release = releases[i];
    probes += 1;
    const result = await probeTilemap(release.num, tile, { fetchImpl, signal });
    if (result.state === 'unknown') {
      unknown.push(release.num);
      i += 1;
      continue;
    }
    if (result.state === 'absent') {
      i += 1;
      continue;
    }
    const effectiveIndex = indexByNum.get(result.effective);
    // A select pointing at a newer or unlisted release cannot move the walk
    // forward; count the probed release itself so the loop always advances.
    const index =
      effectiveIndex !== undefined && effectiveIndex >= i ? effectiveIndex : i;
    const hit = releases[index];
    if (!seen.has(hit.num)) {
      seen.add(hit.num);
      changed.push(hit);
    }
    i = index + 1;
  }
  return { changed, unknown, probes };
}

/** Epoch ms or YYYYMMDD integer to YYYY-MM-DD, else null. */
function metadataDate(attrs) {
  const ms = Number(attrs?.SRC_DATE2);
  if (Number.isFinite(ms) && ms > 0) {
    return new Date(ms).toISOString().slice(0, 10);
  }
  const raw = String(attrs?.SRC_DATE ?? '');
  return /^\d{8}$/.test(raw)
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    : null;
}

/**
 * Source capture date, resolution and provider at a point for one release.
 * Returns nulls rather than throwing, so one dead metadata service never
 * blanks the change list.
 */
export async function releaseMetadata(release, lat, lon, options = {}) {
  const empty = { captureDate: null, resolutionM: null, provider: null };
  if (!release.metadataUrl) return empty;
  try {
    const { features } = await queryPoint(
      `${release.metadataUrl}/${METADATA_LAYER_FOR_Z17}`,
      { lat, lon },
      {
        outFields: 'SRC_DATE,SRC_DATE2,SRC_RES,NICE_NAME,NICE_DESC',
        returnGeometry: false,
        retries: 1,
        timeoutMs: FETCH_TIMEOUT_MS,
        signal: options.signal,
        fetchImpl: options.fetchImpl,
      },
    );
    const attrs = features[0]?.attributes;
    if (!attrs) return empty;
    const res = Number(attrs.SRC_RES);
    const provider = [attrs.NICE_DESC, attrs.NICE_NAME]
      .filter((part) => typeof part === 'string' && part.trim())
      .join(' ');
    return {
      captureDate: metadataDate(attrs),
      resolutionM:
        Number.isFinite(res) && res > 0 ? Math.round(res * 100) / 100 : null,
      provider: provider || null,
    };
  } catch {
    return empty;
  }
}

/**
 * Build the wayback service: catalog and per-tile change caches plus the two
 * route handlers. Everything is injectable for tests.
 * @param {{fetchImpl?: typeof fetch, disk?: boolean, rootDir?: string, limiter?: ((key:string)=>boolean)|null, now?: () => number}} [options]
 */
export function createWaybackService(options = {}) {
  const {
    fetchImpl = (...args) => globalThis.fetch(...args),
    disk = true,
    rootDir,
    limiter = makeCreLimiter({ max: 30 }),
    metadataLimiter = limiter === null ? null : makeCreLimiter({ max: 240 }),
    now,
  } = options;
  const cacheOpts = { disk, ...(rootDir ? { rootDir } : {}) };
  if (now) cacheOpts.now = now;
  // Only JSON answers are cached (catalog, change lists, metadata). Esri tiles are
  // never fetched or stored server side; the browser loads them directly.
  const catalogCache = createCreCache({
    family: 'wayback-catalog',
    ttlMs: CATALOG_TTL_MS,
    maxEntries: 4,
    ...cacheOpts,
  });
  const changesCache = createCreCache({
    family: 'wayback-changes',
    ttlMs: CHANGES_TTL_MS,
    maxEntries: 500,
    ...cacheOpts,
  });
  const metadataCache = createCreCache({
    family: 'wayback-metadata',
    ttlMs: CHANGES_TTL_MS,
    maxEntries: 2000,
    ...cacheOpts,
  });
  /** @type {Map<string, Promise<object>>} */
  const inFlight = new Map();

  /**
   * Capture date, resolution and provider for one release at a tile. Only a
   * real answer is cached; nulls from a slow metadata service are retried.
   */
  async function getMetadata(release, tile, signal) {
    const key = `${release.num}/${tile.z}/${tile.x}/${tile.y}`;
    const fresh = await metadataCache.getFresh(key);
    if (fresh) return fresh.value;
    const center = tileCenter(tile);
    const value = await releaseMetadata(release, center.lat, center.lon, {
      fetchImpl,
      signal,
    });
    if (value.captureDate) await metadataCache.set(key, value);
    return value;
  }

  async function getCatalog(signal) {
    const { value } = await catalogCache.getOrLoad('catalog', async () =>
      parseWaybackConfig(
        await fetchJson(WAYBACK_CONFIG_URL, {
          fetchImpl,
          maxBytes: MAX_CATALOG_BYTES,
          signal,
        }),
      ),
    );
    return value;
  }

  /**
   * Distinct releases that changed at the site's zoom-17 tile, newest first,
   * each with source capture metadata.
   */
  async function computeChanges(tile, signal) {
    const catalog = await getCatalog(signal);
    const walk = await findChangedReleases(catalog.releases, tile, {
      fetchImpl,
      signal,
    });
    if (walk.changed.length === 0 && walk.unknown.length > 0) {
      // Every probe failed: that is an outage, not "no imagery here".
      const error = new Error('Wayback tilemap unavailable');
      error.code = 'UPSTREAM';
      throw error;
    }
    // Metadata services answer in 1 to 3 s each, so only the two ends are
    // fetched here; the slider asks /metadata for the rest on demand.
    const ends = [...new Set([walk.changed[0], walk.changed.at(-1)])].filter(
      Boolean,
    );
    const endMeta = new Map(
      await Promise.all(
        ends.map(async (release) => [
          release.num,
          await getMetadata(release, tile, signal),
        ]),
      ),
    );
    const noMeta = { captureDate: null, resolutionM: null, provider: null };
    const all = catalog.releases;
    return {
      tile,
      releases: walk.changed.map((release) => ({
        release: release.num,
        releaseDate: release.date,
        tileTemplate: release.tileTemplate,
        ...(endMeta.get(release.num) || noMeta),
      })),
      unknown: walk.unknown,
      probes: walk.probes,
      catalog: {
        count: all.length,
        earliest: all.at(-1)?.date ?? null,
        latest: all[0]?.date ?? null,
      },
      warnings: catalog.warnings,
    };
  }

  /**
   * Distinct releases that changed at the site's zoom-17 tile, newest first,
   * each with source capture metadata. Only complete walks (no unknown
   * probes) are cached for 30 days; a partial walk is served but recomputed
   * next time, and a failed walk falls back to the last complete answer.
   */
  async function getChanges(lat, lon, signal) {
    const tile = tileForPoint(lat, lon);
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    const fresh = await changesCache.getFresh(key);
    if (fresh) return fresh.value;
    let pending = inFlight.get(key);
    if (!pending) {
      pending = computeChanges(tile, signal).finally(() =>
        inFlight.delete(key),
      );
      inFlight.set(key, pending);
    }
    try {
      const value = await pending;
      if (value.unknown.length === 0) await changesCache.set(key, value);
      return value;
    } catch (error) {
      const stale = await changesCache.getStale(key);
      if (stale) return stale.value;
      throw error;
    }
  }

  const releasesHandler = creRoute(
    async ({ res }) => {
      const catalog = await getCatalog();
      sendJson(
        res,
        200,
        creBody(
          catalog.releases.length ? 'ready' : 'empty',
          {
            releases: catalog.releases.map(({ num, date, tileTemplate }) => ({
              num,
              date,
              tileTemplate,
            })),
            warnings: catalog.warnings,
          },
          WAYBACK_SOURCE,
        ),
      );
    },
    { limiter, tag: 'wayback' },
  );

  const changesHandler = creRoute(
    async ({ res, params }) => {
      const point = parsePoint(params);
      if (!point.ok) {
        sendError(res, 400, CRE_ERRORS.BAD_POINT);
        return;
      }
      // No client abort here: the load is shared by every caller for this tile.
      const data = await getChanges(point.lat, point.lon);
      sendJson(
        res,
        200,
        creBody(data.releases.length ? 'ready' : 'empty', data, WAYBACK_SOURCE),
      );
    },
    { limiter, tag: 'wayback' },
  );

  const metadataHandler = creRoute(
    async ({ res, params }) => {
      const point = parsePoint(params);
      const num = Number(params.get('release'));
      if (!point.ok || !Number.isInteger(num) || num <= 0) {
        sendError(
          res,
          400,
          point.ok ? 'Invalid release' : CRE_ERRORS.BAD_POINT,
        );
        return;
      }
      const catalog = await getCatalog();
      const release = catalog.releases.find((r) => r.num === num);
      if (!release) {
        sendError(res, 404, CRE_ERRORS.NOT_FOUND);
        return;
      }
      const tile = tileForPoint(point.lat, point.lon);
      const meta = await getMetadata(release, tile);
      sendJson(
        res,
        200,
        creBody(
          meta.captureDate ? 'ready' : 'empty',
          { release: num, releaseDate: release.date, ...meta },
          WAYBACK_SOURCE,
        ),
      );
    },
    { limiter: metadataLimiter, tag: 'wayback' },
  );

  return {
    getCatalog,
    getChanges,
    getMetadata,
    releasesHandler,
    changesHandler,
    metadataHandler,
  };
}

/** Center of a Web Mercator tile, for the metadata point query. */
function tileCenter({ z, x, y }) {
  const n = 2 ** z;
  const lon = ((x + 0.5) / n) * 360 - 180;
  const lat =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
  return { lat, lon };
}

/** Vite plugin mounting /api/cre/wayback/{releases,changes,metadata}. */
export function creWaybackProxy() {
  let service = null;
  const install = (server) => {
    service ??= createWaybackService();
    server.middlewares.use(
      '/api/cre/wayback/releases',
      service.releasesHandler,
    );
    server.middlewares.use('/api/cre/wayback/changes', service.changesHandler);
    server.middlewares.use(
      '/api/cre/wayback/metadata',
      service.metadataHandler,
    );
  };
  return {
    name: 'cre-wayback',
    configureServer: install,
    configurePreviewServer: install,
  };
}

// GET /api/cre/site/{geography,elevation,soils,watershed,walkability}: the physical and administrative facts for a US point, from keyless federal sources, cached 30 days.
import { readResponseJsonCapped } from '../common/http.js';
import { queryPoint } from './common/arcgis.js';
import { createCreCache } from './common/cache.js';
import {
  CRE_ERRORS,
  creBody,
  creRoute,
  makeCreLimiter,
  parsePoint,
  parseRadiusM,
  parseRefresh,
  sendError,
  sendJson,
} from './common/route.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const PUBLIC_DOMAIN = 'Public domain (US Government work)';

export const SITE_SOURCES = Object.freeze({
  geography: {
    name: 'US Census Bureau Geocoder',
    url: 'https://geocoding.geo.census.gov/geocoder/geographies/coordinates',
    license: PUBLIC_DOMAIN,
  },
  elevation: {
    name: 'USGS 3DEP (Elevation Point Query Service and 3DEPElevation ImageServer)',
    url: 'https://epqs.nationalmap.gov/v1/json',
    license: PUBLIC_DOMAIN,
  },
  soils: {
    name: 'USDA NRCS SSURGO Soil Data Access',
    url: 'https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest',
    license: PUBLIC_DOMAIN,
  },
  watershed: {
    name: 'USGS Watershed Boundary Dataset (HUC12)',
    url: 'https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer/6',
    license: PUBLIC_DOMAIN,
  },
  walkability: {
    name: 'US EPA National Walkability Index',
    url: 'https://geodata.epa.gov/arcgis/rest/services/OA/WalkabilityIndex/MapServer/0',
    license: PUBLIC_DOMAIN,
  },
});

const EPQS_URL = 'https://epqs.nationalmap.gov/v1/json';
const IMAGE_SERVER =
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/identify';
const CENSUS_URL = SITE_SOURCES.geography.url;
const SDA_URL = SITE_SOURCES.soils.url;
const METERS_TO_FEET = 1 / 0.3048;

/** Fixed upstream failure; never carries upstream text. */
export class UpstreamError extends Error {
  /** @param {string} code @param {{retryable?:boolean}} [info] */
  constructor(code, { retryable = false } = {}) {
    super('Upstream data source failed');
    this.name = 'UpstreamError';
    this.code = code;
    this.retryable = retryable;
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Fetch JSON from a server-known URL with a timeout, capped body, and retry on
 * transient failures. Every failure becomes an UpstreamError.
 * @param {string} url
 * @param {{fetchImpl?:typeof fetch, init?:RequestInit, timeoutMs?:number, retries?:number, backoffMs?:number}} [options]
 */
export async function fetchJsonUpstream(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    init = {},
    timeoutMs = 10_000,
    retries = 1,
    backoffMs = 300,
  } = options;
  let lastError = new UpstreamError('HTTP_ERROR', { retryable: true });
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
    }
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const response = await fetchImpl(url, {
        ...init,
        signal,
        headers: { Accept: 'application/json', ...(init.headers || {}) },
      });
      if (!response.ok) {
        void response.body?.cancel?.().catch(() => {});
        throw new UpstreamError('HTTP_ERROR', {
          retryable: RETRYABLE_STATUS.has(response.status),
        });
      }
      const body = await readResponseJsonCapped(
        response,
        MAX_JSON_BYTES,
        signal,
      );
      // ArcGIS-style services report failures as a 200 with an error body.
      if (body && typeof body === 'object' && 'error' in body) {
        throw new UpstreamError('UPSTREAM_ERROR');
      }
      return body;
    } catch (error) {
      lastError =
        error instanceof UpstreamError
          ? error
          : new UpstreamError(
              error instanceof SyntaxError ? 'INVALID_RESPONSE' : 'NETWORK',
              { retryable: !(error instanceof SyntaxError) },
            );
      if (!lastError.retryable) throw lastError;
    }
  }
  throw lastError;
}

/**
 * Retry an async call when `shouldRetry(error)` says so. Used for services
 * that intermittently answer a transient error body the shared helper treats
 * as final (EPA FRS answers {"error":{"code":404}} on some requests).
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{attempts?:number, shouldRetry?:(e:any)=>boolean, backoffMs?:number}} [options]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, options = {}) {
  const { attempts = 3, shouldRetry = () => true, backoffMs = 250 } = options;
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, backoffMs * i));
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error)) throw error;
    }
  }
  throw lastError;
}

/** Cache key for a point, rounded to about 1 m. */
export function pointKey(op, lat, lon, radiusM) {
  const point = `${op}:${lat.toFixed(5)},${lon.toFixed(5)}`;
  return Number.isFinite(radiusM) ? `${point}:${radiusM.toFixed(2)}m` : point;
}

/** True when a value is a finite number. */
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** Trimmed non-empty string or null. */
export function text(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Fresh cache, else a live load, else last-good data when the load throws.
 * A result marked `partial` (some sub-source failed) is served but never
 * cached, so one transient failure is not pinned for the whole TTL.
 * @param {ReturnType<typeof createCreCache>} cache
 * @param {string} key
 * @param {() => Promise<{status:string, data:object, partial?:boolean}>} load
 */
export async function loadCached(cache, key, load, { refresh = false } = {}) {
  return cache.getOrLoad(key, load, {
    refresh,
    shouldCache: (value) => value?.partial !== true,
  });
}

/**
 * Build one GET op: validate the point, serve from the family cache, answer
 * the route contract body with retrievedAt set to when the data was fetched.
 * @param {object} options
 * @param {ReturnType<typeof createCreCache>} options.cache
 * @param {{name:string,url:string,license:string}} options.source
 * @param {(point:{lat:number, lon:number}) => Promise<{status:'ready'|'empty', data:object}>} options.load
 * @param {string} options.tag
 * @param {((key:string)=>boolean)|null} [options.limiter]
 * @param {{fallback:number,max:number}} [options.radius] - Opt-in bounded radius for area geometry.
 */
export function pointOp({ cache, source, load, tag, limiter, radius }) {
  return creRoute(
    async ({ res, params }) => {
      const point = parsePoint(params);
      if (!point.ok) {
        sendError(res, 400, CRE_ERRORS.BAD_POINT);
        return;
      }
      const refreshFlag = parseRefresh(params);
      if (!refreshFlag.ok) {
        sendError(res, 400, CRE_ERRORS.BAD_REFRESH);
        return;
      }
      const radiusFlag = radius ? parseRadiusM(params, radius) : null;
      if (radiusFlag && !radiusFlag.ok) {
        sendError(res, 400, CRE_ERRORS.BAD_RADIUS);
        return;
      }
      const loadPoint = radiusFlag
        ? { ...point, radiusM: radiusFlag.radiusM }
        : point;
      const entry = await loadCached(
        cache,
        pointKey(tag, point.lat, point.lon, radiusFlag?.radiusM),
        () => load(loadPoint),
        { refresh: refreshFlag.refresh },
      );
      const { status, data } = entry.value;
      const body = creBody(status, data, source, new Date(entry.cachedAt));
      if (refreshFlag.refresh)
        body.refresh = {
          status: entry.refreshStatus || 'joined-existing',
          attemptedAt: Number.isFinite(entry.attemptedAt)
            ? new Date(entry.attemptedAt).toISOString()
            : null,
          dataRetrievedAt: body.retrievedAt,
        };
      sendJson(res, 200, body);
    },
    { limiter: limiter === undefined ? makeCreLimiter() : limiter, tag },
  );
}

/**
 * Vite plugin mounting a set of ops at /api/cre/<family>/<op>.
 * @param {string} family
 * @param {Record<string, Function>} handlers
 */
export function mountOps(family, handlers) {
  const install = (server) => {
    for (const [op, handler] of Object.entries(handlers)) {
      server.middlewares.use(`/api/cre/${family}/${op}`, handler);
    }
  };
  return {
    name: `cre-${family}`,
    configureServer: install,
    configurePreviewServer: install,
  };
}

/** Census geographies at a coordinate. */
async function loadGeography({ lat, lon }, deps) {
  const url = `${CENSUS_URL}?${new URLSearchParams({
    x: String(lon),
    y: String(lat),
    benchmark: 'Public_AR_Current',
    vintage: 'Current_Current',
    layers: 'Census Tracts,Counties,States,Incorporated Places',
    format: 'json',
  })}`;
  const body = await fetchJsonUpstream(url, deps.upstream);
  const geos = body?.result?.geographies;
  if (!geos || typeof geos !== 'object') {
    throw new UpstreamError('INVALID_RESPONSE');
  }
  const tract = geos['Census Tracts']?.[0];
  const county = geos.Counties?.[0];
  const state = geos.States?.[0];
  const place = geos['Incorporated Places']?.[0];
  if (!text(tract?.GEOID) || !text(county?.NAME)) {
    return { status: 'empty', data: {} };
  }
  return {
    status: 'ready',
    data: {
      tractGeoid: tract.GEOID,
      tractName: text(tract.NAME),
      county: county.NAME,
      countyGeoid: text(county.GEOID),
      state: text(state?.NAME),
      stateAbbr: text(state?.STUSAB),
      place: text(place?.NAME),
    },
  };
}

/** Parse an ImageServer identify pixel value; NoData becomes null. */
function pixelValue(body) {
  const value = Number(body?.value);
  return body && body.value !== 'NoData' && Number.isFinite(value)
    ? value
    : null;
}

function identifyUrl(lat, lon, renderingRule) {
  const params = {
    f: 'json',
    geometry: JSON.stringify({
      x: lon,
      y: lat,
      spatialReference: { wkid: 4326 },
    }),
    geometryType: 'esriGeometryPoint',
    returnGeometry: 'false',
    returnCatalogItems: 'false',
  };
  if (renderingRule) {
    params.renderingRule = JSON.stringify({ rasterFunction: renderingRule });
    params.pixelSize = JSON.stringify({
      x: 10,
      y: 10,
      spatialReference: { wkid: 3857 },
    });
  }
  return `${IMAGE_SERVER}?${new URLSearchParams(params)}`;
}

/** EPQS elevation in feet, falling back to a 3DEP identify; slope from 3DEP. */
async function loadElevation({ lat, lon }, deps) {
  let elevationFt = null;
  let method = 'USGS EPQS';
  try {
    const body = await fetchJsonUpstream(
      `${EPQS_URL}?${new URLSearchParams({ x: String(lon), y: String(lat), units: 'Feet', wkid: '4326' })}`,
      deps.upstream,
    );
    const value = Number(body?.value);
    // EPQS answers -1000000 where it has no data.
    if (Number.isFinite(value) && value > -1000) elevationFt = value;
  } catch {
    elevationFt = null;
  }
  if (elevationFt === null) {
    method = 'USGS 3DEP ImageServer identify';
    const meters = pixelValue(
      await fetchJsonUpstream(identifyUrl(lat, lon), deps.upstream),
    );
    if (meters !== null && meters > -1000)
      elevationFt = meters * METERS_TO_FEET;
  }
  let slopeDeg = null;
  let slopeFailed = false;
  try {
    slopeDeg = pixelValue(
      await fetchJsonUpstream(
        identifyUrl(lat, lon, 'Slope Degrees'),
        deps.upstream,
      ),
    );
  } catch {
    slopeFailed = true;
  }
  if (elevationFt === null) return { status: 'empty', data: {} };
  return {
    status: 'ready',
    partial: slopeFailed,
    data: {
      elevationFt: Math.round(elevationFt * 10) / 10,
      elevationMethod: method,
      slopeDeg: finite(slopeDeg) ? slopeDeg : null,
      slopeResolutionM: 10,
    },
  };
}

/** SSURGO map unit and its major components at the point. */
async function loadSoils({ lat, lon }, deps) {
  const query =
    'SELECT mu.mukey, mu.muname, c.compname, c.comppct_r, c.slope_r, ' +
    'c.hydricrating, c.drainagecl, c.hydgrp FROM mapunit mu ' +
    "INNER JOIN component c ON c.mukey = mu.mukey AND c.majcompflag = 'Yes' " +
    'WHERE mu.mukey IN (SELECT * FROM ' +
    `SDA_Get_Mukey_from_intersection_with_WktWgs84('point(${lon.toFixed(6)} ${lat.toFixed(6)})')) ` +
    'ORDER BY c.comppct_r DESC';
  const body = await fetchJsonUpstream(SDA_URL, {
    ...deps.upstream,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, format: 'JSON+COLUMNNAME' }),
    },
  });
  // SDA answers {} (no Table) when the point has no soil survey.
  if (!body || typeof body !== 'object') {
    throw new UpstreamError('INVALID_RESPONSE');
  }
  const table = Array.isArray(body.Table) ? body.Table : [];
  if (table.length < 2) return { status: 'empty', data: {} };
  const [header, ...rows] = table;
  const col = (row, name) => row[header.indexOf(name)];
  const num = (value) =>
    value === null || value === '' ? null : Number(value);
  const components = rows.map((row) => ({
    name: text(col(row, 'compname')),
    pct: num(col(row, 'comppct_r')),
    slopePct: num(col(row, 'slope_r')),
    hydric: text(col(row, 'hydricrating')),
    drainage: text(col(row, 'drainagecl')),
    hydGroup: text(col(row, 'hydgrp')),
  }));
  const mapUnit = text(col(rows[0], 'muname'));
  if (!mapUnit) return { status: 'empty', data: {} };
  return {
    status: 'ready',
    data: { mukey: String(col(rows[0], 'mukey')), mapUnit, components },
  };
}

async function loadWatershed(point, deps) {
  const { features } = await queryPoint(SITE_SOURCES.watershed.url, point, {
    outFields: 'huc12,name',
    returnGeometry: false,
    ...deps.arcgis,
  });
  const attrs = features[0]?.attributes || {};
  const huc12 = text(attrs.huc12);
  const name = text(attrs.name);
  if (!huc12 || !name) return { status: 'empty', data: {} };
  return { status: 'ready', data: { huc12, name } };
}

/** EPA's published bands for the 1 to 20 National Walkability Index. */
export function walkabilityBand(index) {
  if (index <= 5.75) return 'Least walkable';
  if (index <= 10.5) return 'Below average walkable';
  if (index <= 15.25) return 'Above average walkable';
  return 'Most walkable';
}

async function loadWalkability(point, deps) {
  const { features } = await queryPoint(SITE_SOURCES.walkability.url, point, {
    outFields: 'GEOID20,NatWalkInd',
    returnGeometry: false,
    ...deps.arcgis,
  });
  const attrs = features[0]?.attributes || {};
  const index = Number(attrs.NatWalkInd);
  if (attrs.NatWalkInd === null || !Number.isFinite(index)) {
    return { status: 'empty', data: {} };
  }
  return {
    status: 'ready',
    data: {
      index: Math.round(index * 10) / 10,
      band: walkabilityBand(index),
      blockGroup: text(attrs.GEOID20),
    },
  };
}

/**
 * Shared dependency bundle for loaders: the fetch to use and timing overrides
 * for the ArcGIS helper and for plain JSON upstreams (tests shrink them).
 * @param {{fetchImpl?:typeof fetch, timing?:{timeoutMs?:number, retries?:number, backoffMs?:number, sleep?:Function}}} [options]
 */
export function makeDeps({ fetchImpl, timing = {} } = {}) {
  const impl = fetchImpl || ((...args) => globalThis.fetch(...args));
  return {
    fetchImpl: impl,
    arcgis: { fetchImpl: impl, timeoutMs: 10_000, ...timing },
    upstream: { fetchImpl: impl, ...timing },
  };
}

/**
 * The site ops, with injectable fetch, timing and cache options for tests.
 * @param {{fetchImpl?:typeof fetch, timing?:object, cacheOptions?:object, limiter?:((key:string)=>boolean)|null}} [options]
 */
export function createSiteHandlers({
  fetchImpl,
  timing,
  cacheOptions = {},
  limiter,
} = {}) {
  const deps = makeDeps({ fetchImpl, timing });
  const loaders = {
    geography: loadGeography,
    elevation: loadElevation,
    soils: loadSoils,
    watershed: loadWatershed,
    walkability: loadWalkability,
  };
  const handlers = {};
  for (const [op, loader] of Object.entries(loaders)) {
    const cache = createCreCache({
      family: `site-${op}`,
      ttlMs: 30 * DAY_MS,
      ...cacheOptions,
    });
    handlers[op] = pointOp({
      cache,
      source: SITE_SOURCES[op],
      load: (point) => loader(point, deps),
      tag: `site-${op}`,
      limiter,
    });
  }
  return handlers;
}

/** Vite plugin mounting /api/cre/site/*. */
export function creSiteProxy(options) {
  return mountOps('site', createSiteHandlers(options));
}

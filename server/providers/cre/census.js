// Census data family: tract internal points from TIGERweb (keyless) and ACS 5-year tract values with the server-held key, so the demographics and jobs sections can build 1/3/5 mile ring aggregates without the key ever leaving the server.
import { queryEnvelope, queryPoint } from './common/arcgis.js';
import { createCreCache } from './common/cache.js';
import { CRE_KEY_ENV, readCreKey } from './common/keys.js';
import {
  CRE_ERRORS,
  creBody,
  creRoute,
  makeCreLimiter,
  parsePoint,
  parseRadiusM,
  sendError,
  sendJson,
} from './common/route.js';
import { readResponseTextCapped } from '../common/http.js';
import { bbox, haversineMeters } from '../../../src/cre/geo.js';
import { RINGS_M } from '../../../src/cre/config.js';

export const TIGERWEB_TRACTS_URL =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/0';
export const ACS_YEAR = 2024;
/** First 5-year release on 2020 tract geography, so tract GEOIDs match 2024. */
export const ACS_PRIOR_YEAR = 2020;
export const CENSUS_KEY_SIGNUP_URL =
  'https://api.census.gov/data/key_signup.html';
/** Largest tract search radius a caller may ask for (a long 15 minute drive). */
export const TRACTS_MAX_RADIUS_M = 40_000;
export const ACS_MAX_GEOIDS = 800;
export const ACS_MAX_COUNTIES = 40;

const DAY_MS = 86_400_000;
const GEOID_PATTERN = /^\d{11}$/;
const UPSTREAM_MAX_BYTES = 8 * 1024 * 1024;

/** ACS variables fetched for the current vintage, by readable field name. */
export const ACS_FIELDS = Object.freeze({
  pop: 'B01003_001E',
  medianAge: 'B01002_001E',
  mhi: 'B19013_001E',
  households: 'B25003_001E',
  renters: 'B25003_003E',
  rent: 'B25064_001E',
  units: 'B25002_001E',
  vacant: 'B25002_003E',
  grapiTotal: 'B25070_001E',
  grapi30: 'B25070_007E',
  grapi35: 'B25070_008E',
  grapi40: 'B25070_009E',
  grapi50: 'B25070_010E',
  grapiNotComputed: 'B25070_011E',
  edTotal: 'B15003_001E',
  edBachelors: 'B15003_022E',
  edMasters: 'B15003_023E',
  edProfessional: 'B15003_024E',
  edDoctorate: 'B15003_025E',
  laborForce: 'B23025_003E',
  unemployed: 'B23025_005E',
  // Margins of error (90 percent). Without them the dossier stated a 1 percent
  // unemployment rate built on 29 +/- 48 unemployed people (B-S3-1).
  popMoe: 'B01003_001M',
  mhiMoe: 'B19013_001M',
  rentMoe: 'B25064_001M',
  laborForceMoe: 'B23025_003M',
  unemployedMoe: 'B23025_005M',
});

/** Fields fetched for the prior vintage (growth and change figures). */
export const ACS_PRIOR_FIELDS = Object.freeze({
  pop: 'B01003_001E',
  mhi: 'B19013_001E',
  households: 'B25003_001E',
  renters: 'B25003_003E',
  rent: 'B25064_001E',
  // DATA-04: a z-test on the change rows needs both vintages' margins of error.
  popMoe: 'B01003_001M',
  mhiMoe: 'B19013_001M',
  rentMoe: 'B25064_001M',
});

/**
 * B19001 household income bins (DATA-02) and B25063 gross rent bins, plus
 * B25004 vacancy-status detail (DATA-03), fetched as a third vintage so the
 * request stays under the Census API's 50-variable-per-call ceiling. Pooling
 * these bins across a ring and interpolating (Census's own method) gives a
 * true pooled median, instead of a household-weighted mean of tract medians
 * that runs 3 to 11 percent high.
 */
export const ACS_INCOME_BIN_VARS = Array.from(
  { length: 16 },
  (_, i) => `B19001_${String(i + 2).padStart(3, '0')}E`,
);
export const ACS_RENT_BIN_VARS = Array.from(
  { length: 24 },
  (_, i) => `B25063_${String(i + 3).padStart(3, '0')}E`,
);
export const ACS_BIN_FIELDS = Object.freeze({
  ...Object.fromEntries(ACS_INCOME_BIN_VARS.map((v, i) => [`incBin${i}`, v])),
  ...Object.fromEntries(ACS_RENT_BIN_VARS.map((v, i) => [`rentBin${i}`, v])),
  vacForRent: 'B25004_002E',
  vacRentedNotOccupied: 'B25004_003E',
});
/** Upper edge of each B19001 bin, in dollars; the last bin has no upper edge. */
export const INCOME_BIN_EDGES = Object.freeze([
  0,
  10000,
  15000,
  20000,
  25000,
  30000,
  35000,
  40000,
  45000,
  50000,
  60000,
  75000,
  100000,
  125000,
  150000,
  200000,
  null,
]);
/** Upper edge of each B25063 bin, in dollars/month; the last bin is open-ended. */
export const RENT_BIN_EDGES = Object.freeze([
  0,
  100,
  150,
  200,
  250,
  300,
  350,
  400,
  450,
  500,
  550,
  600,
  650,
  700,
  750,
  800,
  900,
  1000,
  1250,
  1500,
  2000,
  2500,
  3000,
  3500,
  null,
]);

export const CENSUS_SOURCE = Object.freeze({
  name: 'U.S. Census Bureau ACS 5-year and TIGERweb',
  url: 'https://www.census.gov/data/developers/data-sets/acs-5year.html',
  license: 'Public domain (US Government work)',
});

const TIGER_SOURCE = Object.freeze({
  name: 'U.S. Census Bureau TIGERweb',
  url: 'https://tigerweb.geo.census.gov/',
  license: 'Public domain (US Government work)',
});

/** Fixed messages for upstream failures; upstream text never reaches a client. */
export class UpstreamError extends Error {
  /** @param {string} code @param {{status?:number}} [info] */
  constructor(code, { status } = {}) {
    super(`Upstream ${code}`);
    this.name = 'UpstreamError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/**
 * One request with a timeout, a byte cap, and optional retries on a dropped
 * connection or a 502/503/504. The URL may carry a key, so it is
 * never logged and never placed in an error.
 * @param {string} url
 * @param {{fetchImpl?:typeof fetch, signal?:AbortSignal, timeoutMs?:number, maxBytes?:number, headers?:Record<string,string>, method?:string, body?:string, retries?:number, retryDelayMs?:number}} [options]
 * @returns {Promise<{status:number, text:string}>}
 */
export async function fetchUpstreamText(url, options = {}) {
  const { retries = 0, retryDelayMs = 800 } = options;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchUpstreamOnce(url, options);
    } catch (error) {
      const transient =
        error.code === 'NETWORK' || [502, 503, 504].includes(error.status);
      if (!transient || attempt >= retries || options.signal?.aborted) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

async function fetchUpstreamOnce(url, options) {
  const {
    fetchImpl = globalThis.fetch,
    signal,
    timeoutMs = 15_000,
    maxBytes = UPSTREAM_MAX_BYTES,
    headers,
    method = 'GET',
    body,
  } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      body,
      signal: combined,
      redirect: 'manual',
      headers: { Accept: 'application/json, text/csv, */*', ...headers },
    });
  } catch {
    if (signal?.aborted) throw new UpstreamError('ABORTED');
    if (timeout.aborted) throw new UpstreamError('TIMEOUT');
    throw new UpstreamError('NETWORK');
  }
  if (!response.ok) {
    void response.body?.cancel?.().catch(() => {});
    throw new UpstreamError('HTTP', { status: response.status });
  }
  try {
    return {
      status: response.status,
      text: await readResponseTextCapped(response, maxBytes, combined),
    };
  } catch (error) {
    if (error?.code === 'RESPONSE_TOO_LARGE') {
      throw new UpstreamError('TOO_LARGE');
    }
    if (timeout.aborted) throw new UpstreamError('TIMEOUT');
    throw new UpstreamError('NETWORK');
  }
}

/** @param {string} value */
function parseDecimal(value) {
  const number = Number.parseFloat(String(value ?? '').replace(/^\+/, ''));
  return Number.isFinite(number) ? number : null;
}

/**
 * Tracts whose Census internal point lies within radiusM of the site, plus
 * the tract containing the site. Membership is centroid-in-ring: a tract
 * counts wholly when its internal point is inside, not at all otherwise.
 * @param {{lat:number, lon:number, radiusM:number}} area
 * @param {{fetchImpl?:typeof fetch, signal?:AbortSignal}} [options]
 */
export async function loadTracts({ lat, lon, radiusM }, options = {}) {
  const common = {
    returnGeometry: false,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    retries: 1,
  };
  const [site, areaPages] = await Promise.all([
    queryPoint(
      TIGERWEB_TRACTS_URL,
      { lat, lon },
      {
        ...common,
        outFields: 'GEOID',
      },
    ),
    (async () => {
      const features = [];
      const seenGeoids = new Set();
      const pageSize = 2000;
      const maxPages = 25;
      let truncated = false;
      for (let page = 0; page < maxPages; page += 1) {
        const result = await queryEnvelope(
          TIGERWEB_TRACTS_URL,
          bbox(lat, lon, radiusM),
          {
            ...common,
            outFields: 'GEOID,NAME,INTPTLAT,INTPTLON,AREALAND',
            extra: {
              resultOffset: page * pageSize,
              resultRecordCount: pageSize,
            },
          },
        );
        let newFeatures = 0;
        for (const feature of result.features) {
          const geoid = String(feature?.attributes?.GEOID ?? '');
          if (GEOID_PATTERN.test(geoid) && seenGeoids.has(geoid)) continue;
          if (GEOID_PATTERN.test(geoid)) seenGeoids.add(geoid);
          features.push(feature);
          newFeatures += 1;
        }
        if (
          result.exceededTransferLimit &&
          result.features.length &&
          !newFeatures
        ) {
          truncated = true;
          break;
        }
        if (!result.exceededTransferLimit && result.features.length < pageSize)
          break;
        if (page === maxPages - 1) truncated = true;
      }
      return { features, exceededTransferLimit: truncated };
    })(),
  ]);
  const siteGeoid = site.features
    .map((f) => String(f?.attributes?.GEOID ?? ''))
    .find((g) => GEOID_PATTERN.test(g));
  const tracts = [];
  for (const feature of areaPages.features) {
    const a = feature?.attributes || {};
    const geoid = String(a.GEOID ?? '');
    const tLat = parseDecimal(a.INTPTLAT);
    const tLon = parseDecimal(a.INTPTLON);
    if (!GEOID_PATTERN.test(geoid) || tLat === null || tLon === null) continue;
    const distanceM = haversineMeters(lat, lon, tLat, tLon);
    if (distanceM > radiusM) continue;
    tracts.push({
      geoid,
      name: String(a.NAME ?? ''),
      lat: tLat,
      lon: tLon,
      distanceM: Math.round(distanceM),
      landM2: Number.isFinite(Number(a.AREALAND)) ? Number(a.AREALAND) : null,
    });
  }
  tracts.sort((x, y) => x.distanceM - y.distanceM);
  return {
    siteTract: siteGeoid || null,
    radiusM,
    method: 'Census internal point within radius',
    truncated: areaPages.exceededTransferLimit,
    tracts,
  };
}

/**
 * Parse a Census API array-of-arrays body into tract rows keyed by GEOID.
 * Negative sentinels (-666666666 and friends) become null.
 * @param {string} text
 * @param {Record<string,string>} fields
 */
export function parseAcsTable(text, fields) {
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    throw new UpstreamError('INVALID_RESPONSE');
  }
  if (!Array.isArray(rows) || !Array.isArray(rows[0])) {
    throw new UpstreamError('INVALID_RESPONSE');
  }
  const header = rows[0];
  const col = (name) => header.indexOf(name);
  const stateCol = col('state');
  const countyCol = col('county');
  const tractCol = col('tract');
  if (stateCol < 0 || countyCol < 0 || tractCol < 0) {
    throw new UpstreamError('INVALID_RESPONSE');
  }
  const fieldCols = Object.entries(fields).map(([name, variable]) => [
    name,
    col(variable),
  ]);
  if (fieldCols.some(([, index]) => index < 0)) {
    throw new UpstreamError('INVALID_RESPONSE');
  }
  /** @type {Map<string, Record<string, number|null>>} */
  const out = new Map();
  for (const row of rows.slice(1)) {
    const geoid = `${row[stateCol]}${row[countyCol]}${row[tractCol]}`;
    if (!GEOID_PATTERN.test(geoid)) continue;
    const record = {};
    for (const [name, index] of fieldCols) {
      // The cell must be a non-empty string before it is trusted as a number:
      // `Number(null)` and `Number('')` are both 0 and both pass a `>= 0`
      // test, which turned a suppressed median into a real $0 (A-S3-6).
      const raw = row[index];
      const number =
        typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      record[name] = Number.isFinite(number) && number >= 0 ? number : null;
    }
    out.set(geoid, record);
  }
  return out;
}

/** Key-free URL for display and sourceUrls. */
export function acsPublicUrl(year, fields, state, county) {
  const get = ['NAME', ...Object.values(fields)].join(',');
  return `https://api.census.gov/data/${year}/acs/acs5?get=${get}&for=tract:*&in=state:${state}%20county:${county}`;
}

/**
 * ACS values for a set of tracts, fetched one county at a time. Returns a
 * needs-key result when the key is absent; the key is appended only to the
 * outbound URL, which is never logged or returned.
 * @param {string[]} geoids
 * @param {{env?:Record<string,string|undefined>, fetchImpl?:typeof fetch, signal?:AbortSignal, cache?:ReturnType<typeof createCreCache>}} [options]
 */
export async function loadAcs(geoids, options = {}) {
  const { env = process.env, fetchImpl, signal, cache } = options;
  const key = readCreKey('census', env);
  if (!key) {
    return {
      status: 'needs-key',
      keyName: CRE_KEY_ENV.census,
      message: `Census ACS needs the free ${CRE_KEY_ENV.census}; add it in POWER UP (${CENSUS_KEY_SIGNUP_URL}).`,
    };
  }
  const counties = new Map();
  for (const geoid of geoids) {
    const county = geoid.slice(0, 5);
    if (!counties.has(county)) counties.set(county, []);
    counties.get(county).push(geoid);
  }
  const vintages = [
    { year: ACS_YEAR, fields: ACS_FIELDS, slot: 'cur' },
    { year: ACS_PRIOR_YEAR, fields: ACS_PRIOR_FIELDS, slot: 'prior' },
    { year: ACS_YEAR, fields: ACS_BIN_FIELDS, slot: 'bins' },
  ];
  const tracts = {};
  const sourceUrls = [];
  const loadCounty = async (county, { year, fields, slot }) => {
    const state = county.slice(0, 2);
    const code = county.slice(2);
    const publicUrl = acsPublicUrl(year, fields, state, code);
    const load = async () => {
      const { text } = await fetchUpstreamText(
        `${publicUrl}&key=${encodeURIComponent(key)}`,
        { fetchImpl, signal },
      );
      return Object.fromEntries(parseAcsTable(text, fields));
    };
    // The version tag changes with ACS_FIELDS: a 30 day cache entry written
    // before the margins of error were added has no margin columns in it.
    // The slot is part of the key too: 'cur' and 'bins' share the same
    // year, and without the slot they collided on one cache entry, so the
    // bins vintage silently read back cur's rows (no incBin*/rentBin*
    // columns) and every pooled median and rental vacancy figure went null.
    const cacheKey = `acs:v2:${year}:${county}:${slot}`;
    const entry = cache
      ? await cache.getOrLoad(cacheKey, load)
      : { value: await load(), cachedAt: Date.now() };
    return {
      publicUrl,
      rows: entry.value,
      cachedAt: entry.cachedAt,
      stale: entry.source === 'STALE',
    };
  };
  const wanted = new Set(geoids);
  // Oldest county cache entry: the answer is only as fresh as its stalest part.
  let cachedAt = null;
  let stale = false;
  const collect = (vintage, results) => {
    for (const { publicUrl, rows, cachedAt: at, stale: isStale } of results) {
      stale ||= isStale;
      sourceUrls.push(publicUrl);
      if (Number.isFinite(at))
        cachedAt = cachedAt === null ? at : Math.min(cachedAt, at);
      for (const [geoid, record] of Object.entries(rows)) {
        if (!wanted.has(geoid)) continue;
        tracts[geoid] ||= { cur: null, prior: null, bins: null };
        tracts[geoid][vintage.slot] = record;
      }
    }
  };
  const loadVintage = (vintage) =>
    Promise.all(
      [...counties.keys()].map((county) => loadCounty(county, vintage)),
    );
  let priorAvailable = true;
  try {
    collect(vintages[0], await loadVintage(vintages[0]));
  } catch (error) {
    // A redirect or HTML body from api.census.gov is how a bad key answers.
    if (
      error instanceof UpstreamError &&
      (error.code === 'INVALID_RESPONSE' ||
        (error.status >= 300 && error.status < 400))
    ) {
      return {
        status: 'needs-key',
        keyName: CRE_KEY_ENV.census,
        message: `Census ACS rejected ${CRE_KEY_ENV.census}; check it in POWER UP (${CENSUS_KEY_SIGNUP_URL}).`,
      };
    }
    throw error;
  }
  try {
    collect(vintages[1], await loadVintage(vintages[1]));
  } catch (error) {
    if (error?.code === 'ABORTED') throw error;
    // Growth figures drop out; current values still stand.
    priorAvailable = false;
  }
  let binsAvailable = true;
  try {
    collect(vintages[2], await loadVintage(vintages[2]));
  } catch (error) {
    if (error?.code === 'ABORTED') throw error;
    // Pooled medians and rental vacancy drop out; current values still stand.
    binsAvailable = false;
  }
  const missing = geoids.filter((geoid) => !tracts[geoid]?.cur);
  return {
    status: Object.keys(tracts).length ? 'ready' : 'empty',
    data: {
      year: ACS_YEAR,
      priorYear: ACS_PRIOR_YEAR,
      vintage: `ACS ${ACS_YEAR - 4}-${ACS_YEAR} 5-year`,
      priorVintage: `ACS ${ACS_PRIOR_YEAR - 4}-${ACS_PRIOR_YEAR} 5-year`,
      fields: ACS_FIELDS,
      tracts,
      missing,
      priorAvailable,
      binsAvailable,
      stale,
    },
    cachedAt,
    sourceUrls,
  };
}

/**
 * Parse and validate a comma list of 11-digit tract GEOIDs.
 * @param {string|null} raw
 * @returns {string[]|null}
 */
export function parseGeoids(raw, max = ACS_MAX_GEOIDS) {
  if (!raw) return null;
  const list = [...new Set(raw.split(',').map((g) => g.trim()))].filter(
    Boolean,
  );
  if (!list.length || list.length > max) return null;
  return list.every((g) => GEOID_PATTERN.test(g)) ? list : null;
}

/**
 * GET /api/cre/census/tracts?lat&lon&radiusM
 * @param {{fetchImpl?:typeof fetch, cache?:ReturnType<typeof createCreCache>, limiter?:any}} [options]
 */
export function censusTractsHandler(options = {}) {
  const cache =
    options.cache ??
    createCreCache({ family: 'census-tracts-v2', ttlMs: 30 * DAY_MS });
  return creRoute(
    async ({ res, params }) => {
      const point = parsePoint(params);
      if (!point.ok) return sendError(res, 400, CRE_ERRORS.BAD_POINT);
      const radius = parseRadiusM(params, {
        fallback: RINGS_M.fiveMi,
        max: TRACTS_MAX_RADIUS_M,
      });
      if (!radius.ok) return sendError(res, 400, CRE_ERRORS.BAD_RADIUS);
      const key = `${point.lat.toFixed(5)},${point.lon.toFixed(5)},${Math.round(radius.radiusM)}`;
      const { value, cachedAt } = await cache.getOrLoad(key, () =>
        loadTracts(
          { lat: point.lat, lon: point.lon, radiusM: radius.radiusM },
          { fetchImpl: options.fetchImpl },
        ),
      );
      sendJson(
        res,
        200,
        creBody(
          value.tracts.length ? 'ready' : 'empty',
          value,
          TIGER_SOURCE,
          new Date(cachedAt),
        ),
      );
    },
    { limiter: options.limiter, tag: 'census-tracts' },
  );
}

/**
 * GET /api/cre/census/acs?geoids=a,b,c
 * @param {{env?:Record<string,string|undefined>, fetchImpl?:typeof fetch, cache?:ReturnType<typeof createCreCache>, limiter?:any}} [options]
 */
export function censusAcsHandler(options = {}) {
  const cache =
    options.cache ??
    createCreCache({ family: 'census-acs', ttlMs: 30 * DAY_MS });
  return creRoute(
    async ({ res, params }) => {
      const geoids = parseGeoids(params.get('geoids'));
      if (!geoids) return sendError(res, 400, 'Invalid geoids');
      if (new Set(geoids.map((g) => g.slice(0, 5))).size > ACS_MAX_COUNTIES) {
        return sendError(res, 400, 'Invalid geoids');
      }
      const result = await loadAcs(geoids, {
        env: options.env ?? process.env,
        fetchImpl: options.fetchImpl,
        cache,
      });
      const at = new Date().toISOString();
      if (result.status === 'needs-key') {
        return sendJson(res, 200, {
          status: 'needs-key',
          data: null,
          keyName: result.keyName,
          message: result.message,
          retrievedAt: at,
          source: CENSUS_SOURCE,
        });
      }
      sendJson(res, 200, {
        ...creBody(
          result.status,
          result.data,
          CENSUS_SOURCE,
          Number.isFinite(result.cachedAt)
            ? new Date(result.cachedAt)
            : new Date(),
        ),
        sourceUrls: result.sourceUrls,
      });
    },
    { limiter: options.limiter, tag: 'census-acs' },
  );
}

/** Vite plugin mounting /api/cre/census/tracts and /api/cre/census/acs. */
export function creCensusProxy() {
  const tracts = censusTractsHandler({ limiter: makeCreLimiter({ max: 60 }) });
  const acs = censusAcsHandler({ limiter: makeCreLimiter({ max: 60 }) });
  const install = (server) => {
    server.middlewares.use('/api/cre/census/tracts', tracts);
    server.middlewares.use('/api/cre/census/acs', acs);
  };
  return {
    name: 'cre-census',
    configureServer: install,
    configurePreviewServer: install,
  };
}

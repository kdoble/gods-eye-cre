// LEHD LODES8 workplace jobs: downloads one state WAC file into .gev-cache, rolls 15-digit blocks up to tracts, and serves tract job counts by sector plus the county's densest job cluster for the jobs and access sections.
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { arcgisQuery } from './common/arcgis.js';
import { CRE_CACHE_ROOT } from './common/cache.js';
import {
  creBody,
  creRoute,
  makeCreLimiter,
  sendError,
  sendJson,
} from './common/route.js';
import { parseGeoids, TIGERWEB_TRACTS_URL, UpstreamError } from './census.js';
import { readResponseBytesCapped } from '../common/http.js';
import { haversineMeters } from '../../../src/cre/geo.js';

export const LODES_YEARS = Object.freeze([2023, 2022]);
export const LODES_TTL_MS = 90 * 86_400_000;
export const LODES_MEMORY_TTL_MS = 5 * 60_000;
export const LODES_CLUSTER_MEMORY_TTL_MS = 15 * 60_000;
export const LODES_MAX_GZ_BYTES = 80 * 1024 * 1024;
export const LODES_MAX_STATES = 4;
/** Radius used to score a job cluster around each tract's internal point. */
export const CLUSTER_RADIUS_M = 1609.344;
export const LODES_DIR = path.join(CRE_CACHE_ROOT, 'lodes');

/** LODES CNS columns (2017 NAICS sectors) to readable names. */
export const LODES_SECTORS = Object.freeze({
  CNS01: 'Agriculture, Forestry, Fishing and Hunting',
  CNS02: 'Mining, Quarrying, and Oil and Gas',
  CNS03: 'Utilities',
  CNS04: 'Construction',
  CNS05: 'Manufacturing',
  CNS06: 'Wholesale Trade',
  CNS07: 'Retail Trade',
  CNS08: 'Transportation and Warehousing',
  CNS09: 'Information',
  CNS10: 'Finance and Insurance',
  CNS11: 'Real Estate and Rental and Leasing',
  CNS12: 'Professional, Scientific, and Technical Services',
  CNS13: 'Management of Companies and Enterprises',
  CNS14: 'Administrative, Support, and Waste Management',
  CNS15: 'Educational Services',
  CNS16: 'Health Care and Social Assistance',
  CNS17: 'Arts, Entertainment, and Recreation',
  CNS18: 'Accommodation and Food Services',
  CNS19: 'Other Services (except Public Administration)',
  CNS20: 'Public Administration',
});
const SECTOR_KEYS = Object.keys(LODES_SECTORS);

/** State FIPS to the lowercase postal code LODES uses in file names. */
export const STATE_POSTAL = Object.freeze({
  '01': 'al',
  '02': 'ak',
  '04': 'az',
  '05': 'ar',
  '06': 'ca',
  '08': 'co',
  '09': 'ct',
  10: 'de',
  11: 'dc',
  12: 'fl',
  13: 'ga',
  15: 'hi',
  16: 'id',
  17: 'il',
  18: 'in',
  19: 'ia',
  20: 'ks',
  21: 'ky',
  22: 'la',
  23: 'me',
  24: 'md',
  25: 'ma',
  26: 'mi',
  27: 'mn',
  28: 'ms',
  29: 'mo',
  30: 'mt',
  31: 'ne',
  32: 'nv',
  33: 'nh',
  34: 'nj',
  35: 'nm',
  36: 'ny',
  37: 'nc',
  38: 'nd',
  39: 'oh',
  40: 'ok',
  41: 'or',
  42: 'pa',
  44: 'ri',
  45: 'sc',
  46: 'sd',
  47: 'tn',
  48: 'tx',
  49: 'ut',
  50: 'vt',
  51: 'va',
  53: 'wa',
  54: 'wv',
  55: 'wi',
  56: 'wy',
});

export const LODES_SOURCE = Object.freeze({
  name: 'U.S. Census Bureau LEHD LODES8 WAC',
  url: 'https://lehd.ces.census.gov/data/',
  license: 'Public domain (US Government work)',
});

/** Raised when a WAC file does not look like the published format. */
export class LodesFormatError extends Error {
  constructor(reason) {
    super(`LODES format: ${reason}`);
    this.name = 'LodesFormatError';
    this.code = 'LODES_FORMAT';
  }
}

/** @param {string} postal @param {number} year */
export function lodesUrl(postal, year) {
  return `https://lehd.ces.census.gov/data/lodes/LODES8/${postal}/wac/${postal}_wac_S000_JT00_${year}.csv.gz`;
}

/**
 * Roll a WAC CSV up to 11-digit tracts. Every block code must be exactly 15
 * digits: a 14-digit code is what a spreadsheet round trip leaves after
 * stripping a leading zero, and it would silently land in the wrong tract, so
 * the whole file is rejected instead.
 * @param {string} csv
 * @returns {Map<string, number[]>} tract -> [C000, CNS01..CNS20]
 */
export function rollUpWac(csv) {
  const lines = csv.split(/\r?\n/);
  const header = (lines[0] || '').split(',');
  const geoCol = header.indexOf('w_geocode');
  const totalCol = header.indexOf('C000');
  const sectorCols = SECTOR_KEYS.map((key) => header.indexOf(key));
  if (geoCol < 0 || totalCol < 0 || sectorCols.some((c) => c < 0)) {
    throw new LodesFormatError('missing columns');
  }
  /** @type {Map<string, number[]>} */
  const tracts = new Map();
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const cells = line.split(',');
    const block = cells[geoCol].replace(/"/g, '');
    if (!/^\d{15}$/.test(block)) {
      throw new LodesFormatError(
        `block code on line ${i + 1} is not 15 digits`,
      );
    }
    const tract = block.slice(0, 11);
    let row = tracts.get(tract);
    if (!row) {
      row = new Array(SECTOR_KEYS.length + 1).fill(0);
      tracts.set(tract, row);
    }
    const values = [totalCol, ...sectorCols].map((c) => Number(cells[c]));
    if (values.some((v) => !Number.isFinite(v) || v < 0)) {
      throw new LodesFormatError(`non-numeric count on line ${i + 1}`);
    }
    values.forEach((v, k) => {
      row[k] += v;
    });
  }
  return tracts;
}

/**
 * Loader for state WAC files with a disk cache (90 day TTL, stale file used
 * when the download fails) and a parsed in-memory copy per state.
 * @param {{fetchImpl?:typeof fetch, dir?:string, now?:()=>number, years?:readonly number[]}} [options]
 */
export function createLodesStore(options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    dir = LODES_DIR,
    now = Date.now,
    years = LODES_YEARS,
  } = options;
  /** @type {Map<string, {promise:Promise<object>, expiresAt:number}>} */
  const parsed = new Map();

  async function freshFile(file) {
    try {
      const stat = await fsp.stat(file);
      return now() - stat.mtimeMs <= LODES_TTL_MS ? 'fresh' : 'stale';
    } catch {
      return 'missing';
    }
  }

  async function download(url, file) {
    const timeout = AbortSignal.timeout(90_000);
    let response;
    try {
      response = await fetchImpl(url, { signal: timeout, redirect: 'manual' });
    } catch {
      throw new UpstreamError(timeout.aborted ? 'TIMEOUT' : 'NETWORK');
    }
    if (!response.ok) {
      void response.body?.cancel?.().catch(() => {});
      throw new UpstreamError('HTTP', { status: response.status });
    }
    let bytes;
    try {
      bytes = await readResponseBytesCapped(response, LODES_MAX_GZ_BYTES);
    } catch {
      throw new UpstreamError('TOO_LARGE');
    }
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, bytes);
    await fsp.rename(tmp, file);
  }

  async function loadState(stateFips) {
    const postal = STATE_POSTAL[stateFips];
    if (!postal) throw new UpstreamError('NO_STATE');
    let lastError = new UpstreamError('NO_FILE');
    for (const year of years) {
      const url = lodesUrl(postal, year);
      const file = path.join(dir, path.basename(new URL(url).pathname));
      const state = await freshFile(file);
      if (state !== 'fresh') {
        try {
          await download(url, file);
        } catch (error) {
          lastError = error;
          if (state === 'missing') {
            // A 404 means this vintage is not published for the state yet.
            if (error.status === 404) continue;
            throw error;
          }
          // Stale file on disk: serve it rather than fail, and carry that
          // provenance into the response so callers can mark it clearly.
        }
      }
      const gz = await fsp.readFile(file);
      let csv;
      try {
        csv = gunzipSync(gz, { maxOutputLength: 1024 * 1024 * 1024 }).toString(
          'utf8',
        );
      } catch {
        await fsp.rm(file, { force: true });
        throw new LodesFormatError('not a gzip file');
      }
      // The file's mtime is when these jobs were actually fetched. A 90 day
      // cache stamped with the request time is a false freshness claim (B-S2-2).
      let cachedAt = Date.now();
      try {
        cachedAt = (await fsp.stat(file)).mtimeMs;
      } catch {
        // Keep the request time; the file was just written.
      }
      return {
        year,
        tracts: rollUpWac(csv),
        url,
        cachedAt,
        stale: state === 'stale' && now() - cachedAt > LODES_TTL_MS,
      };
    }
    throw lastError;
  }

  /** Parsed tract table for a state; one load shared by concurrent callers. */
  function state(stateFips) {
    let entry = parsed.get(stateFips);
    if (entry && entry.expiresAt <= now()) {
      parsed.delete(stateFips);
      entry = null;
    }
    if (!entry) {
      const promise = loadState(stateFips);
      entry = { promise, expiresAt: now() + LODES_MEMORY_TTL_MS };
      parsed.set(stateFips, entry);
      promise.catch(() => {
        if (parsed.get(stateFips) === entry) parsed.delete(stateFips);
      });
    }
    return entry.promise;
  }

  return { state };
}

/** Shape one tract row for a response. */
function tractJobs(row) {
  const sectors = {};
  SECTOR_KEYS.forEach((key, index) => {
    sectors[key] = row[index + 1];
  });
  return { total: row[0], sectors };
}

/**
 * Job counts for the requested tracts. Tracts with no workplace blocks are
 * real zeros (no covered jobs), reported under `zero`.
 * @param {string[]} geoids
 * @param {ReturnType<typeof createLodesStore>} store
 */
export async function loadJobs(geoids, store) {
  const states = [...new Set(geoids.map((g) => g.slice(0, 2)))];
  if (states.length > LODES_MAX_STATES) throw new UpstreamError('TOO_MANY');
  const tables = new Map();
  for (const fips of states) tables.set(fips, await store.state(fips));
  const tracts = {};
  const zero = [];
  let year = null;
  const vintages = new Set();
  let cachedAt = null;
  let stale = false;
  const sourceUrls = [];
  for (const table of tables.values()) {
    vintages.add(table.year);
    year = Math.min(year ?? table.year, table.year);
    if (Number.isFinite(table.cachedAt))
      cachedAt =
        cachedAt === null ? table.cachedAt : Math.min(cachedAt, table.cachedAt);
    sourceUrls.push(table.url);
    stale ||= table.stale === true;
  }
  for (const geoid of geoids) {
    const row = tables.get(geoid.slice(0, 2)).tracts.get(geoid);
    if (row) tracts[geoid] = tractJobs(row);
    else {
      tracts[geoid] = tractJobs(new Array(SECTOR_KEYS.length + 1).fill(0));
      zero.push(geoid);
    }
  }
  return {
    year,
    vintages: [...vintages].sort(),
    sectors: LODES_SECTORS,
    tracts,
    zero,
    cachedAt,
    sourceUrls,
    stale,
  };
}

/**
 * The county's largest job cluster: the tract whose internal point has the
 * most LODES jobs within CLUSTER_RADIUS_M (all tracts of the county scored).
 * @param {string} county - 5-digit county FIPS.
 * @param {ReturnType<typeof createLodesStore>} store
 * @param {{fetchImpl?:typeof fetch}} [options]
 */
export async function loadCluster(county, store, options = {}) {
  const table = await store.state(county.slice(0, 2));
  const body = await arcgisQuery(
    TIGERWEB_TRACTS_URL,
    {
      where: `STATE='${county.slice(0, 2)}' AND COUNTY='${county.slice(2)}'`,
      outFields: 'GEOID,INTPTLAT,INTPTLON',
      returnGeometry: false,
    },
    { fetchImpl: options.fetchImpl, retries: 1 },
  );
  const points = (Array.isArray(body.features) ? body.features : [])
    .map((f) => ({
      geoid: String(f?.attributes?.GEOID ?? ''),
      lat: Number.parseFloat(String(f?.attributes?.INTPTLAT ?? '')),
      lon: Number.parseFloat(String(f?.attributes?.INTPTLON ?? '')),
    }))
    .filter(
      (p) =>
        /^\d{11}$/.test(p.geoid) &&
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lon),
    )
    .map((p) => ({ ...p, jobs: table.tracts.get(p.geoid)?.[0] ?? 0 }));
  if (!points.length) return null;
  const countyJobs = points.reduce((sum, p) => sum + p.jobs, 0);
  let best = null;
  for (const center of points) {
    let jobs = 0;
    for (const p of points) {
      if (
        haversineMeters(center.lat, center.lon, p.lat, p.lon) <=
        CLUSTER_RADIUS_M
      ) {
        jobs += p.jobs;
      }
    }
    if (!best || jobs > best.clusterJobs) {
      best = { ...center, clusterJobs: jobs };
    }
  }
  if (!best || best.clusterJobs <= 0) return null;
  return {
    year: table.year,
    county,
    geoid: best.geoid,
    lat: best.lat,
    lon: best.lon,
    tractJobs: best.jobs,
    clusterJobs: best.clusterJobs,
    clusterRadiusM: CLUSTER_RADIUS_M,
    countyJobs,
    cachedAt: table.cachedAt ?? null,
    stale: table.stale === true,
    sourceUrls: [table.url],
  };
}

/**
 * GET /api/cre/lodes/jobs?geoids=..
 * @param {{store?:ReturnType<typeof createLodesStore>, limiter?:any}} [options]
 */
export function lodesJobsHandler(options = {}) {
  const store = options.store ?? createLodesStore();
  return creRoute(
    async ({ res, params }) => {
      const geoids = parseGeoids(params.get('geoids'));
      if (!geoids) return sendError(res, 400, 'Invalid geoids');
      const result = await loadJobs(geoids, store);
      sendJson(res, 200, {
        ...creBody(
          'ready',
          result,
          LODES_SOURCE,
          Number.isFinite(result.cachedAt)
            ? new Date(result.cachedAt)
            : new Date(),
        ),
        sourceUrls: result.sourceUrls,
      });
    },
    { limiter: options.limiter, tag: 'lodes-jobs' },
  );
}

/**
 * GET /api/cre/lodes/cluster?county=47179
 * @param {{store?:ReturnType<typeof createLodesStore>, fetchImpl?:typeof fetch, limiter?:any}} [options]
 */
export function lodesClusterHandler(options = {}) {
  const store = options.store ?? createLodesStore();
  /** @type {Map<string, Promise<object|null>>} */
  const memo = new Map();
  return creRoute(
    async ({ res, params }) => {
      const county = params.get('county') || '';
      if (!/^\d{5}$/.test(county)) return sendError(res, 400, 'Invalid county');
      let pending = memo.get(county);
      if (pending && pending.expiresAt <= Date.now()) {
        memo.delete(county);
        pending = null;
      }
      if (!pending) {
        const promise = loadCluster(county, store, {
          fetchImpl: options.fetchImpl,
        });
        pending = {
          promise,
          expiresAt: Date.now() + LODES_CLUSTER_MEMORY_TTL_MS,
        };
        memo.set(county, pending);
        promise.catch(() => {
          if (memo.get(county) === pending) memo.delete(county);
        });
      }
      const cluster = await pending.promise;
      sendJson(res, 200, {
        ...creBody(
          cluster ? 'ready' : 'empty',
          cluster,
          LODES_SOURCE,
          Number.isFinite(cluster?.cachedAt)
            ? new Date(cluster.cachedAt)
            : new Date(),
        ),
        sourceUrls: cluster?.sourceUrls ?? [],
      });
    },
    { limiter: options.limiter, tag: 'lodes-cluster' },
  );
}

/** Vite plugin mounting /api/cre/lodes/jobs and /api/cre/lodes/cluster. */
export function creLodesProxy() {
  const store = createLodesStore();
  const jobs = lodesJobsHandler({
    store,
    limiter: makeCreLimiter({ max: 60 }),
  });
  const cluster = lodesClusterHandler({
    store,
    limiter: makeCreLimiter({ max: 30 }),
  });
  const install = (server) => {
    server.middlewares.use('/api/cre/lodes/jobs', jobs);
    server.middlewares.use('/api/cre/lodes/cluster', cluster);
  };
  return {
    name: 'cre-lodes',
    configureServer: install,
    configurePreviewServer: install,
  };
}

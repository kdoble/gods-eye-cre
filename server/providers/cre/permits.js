// GET /api/cre/permits?lat&lon: Census Building Permits Survey 5+ unit permits for the site's county and, when the site sits in a permit-issuing incorporated place, that place, over the last five annual files plus year to date, so the dossier can show multifamily supply and its trend.
import { readResponseTextCapped } from '../common/http.js';
import { queryPoint } from './common/arcgis.js';
import { createCreCache } from './common/cache.js';
import {
  CRE_ERRORS,
  creBody,
  creRoute,
  makeCreLimiter,
  parsePoint,
  sendError,
  sendJson,
} from './common/route.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BPS_BASE = 'https://www2.census.gov/econ/bps';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LISTING_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
export const PERMIT_YEARS = 5;

export const PERMITS_SOURCE = Object.freeze({
  name: 'US Census Bureau Building Permits Survey',
  url: 'https://www.census.gov/construction/bps/',
  license: 'Public domain (US Government work)',
});

const TIGER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb';
export const TIGER_LAYERS = Object.freeze({
  county: `${TIGER}/State_County/MapServer/1`,
  place: `${TIGER}/Places_CouSub_ConCity_SubMCD/MapServer/4`,
});

/** Census region folder and file prefix for BPS place files, by state FIPS. */
const REGIONS = Object.freeze({
  northeast: { dir: 'Northeast%20Region', prefix: 'ne' },
  midwest: { dir: 'Midwest%20Region', prefix: 'mw' },
  south: { dir: 'South%20Region', prefix: 'so' },
  west: { dir: 'West%20Region', prefix: 'we' },
});
const STATE_REGION = (() => {
  const map = {};
  const put = (region, codes) =>
    codes.split(' ').forEach((code) => (map[code] = REGIONS[region]));
  put('northeast', '09 23 25 33 34 36 42 44 50');
  put('midwest', '17 18 19 20 26 27 29 31 38 39 46 55');
  put('south', '01 05 10 11 12 13 21 22 24 28 37 40 45 47 48 51 54');
  put('west', '02 04 06 08 15 16 30 32 35 41 49 53 56');
  return Object.freeze(map);
})();

/** BPS place region for a two-digit state FIPS, or null (territories). */
export function placeRegion(stateFips) {
  return STATE_REGION[String(stateFips)] || null;
}

/** Error with a fixed message and a stable code; never carries upstream text. */
export class PermitsError extends Error {
  /** @param {'BAD_FILE'|'HTTP_ERROR'|'NO_FILES'} code */
  constructor(code) {
    super('Building permits source failed');
    this.name = 'PermitsError';
    this.code = code;
  }
}

/** Split one BPS comma line; the files carry no quoted commas. */
const cells = (line) => line.split(',').map((cell) => cell.trim());

/**
 * Parse a BPS county or place file into { key: {bldgs, units, value, name} }
 * for the 5+ unit block. The file must carry the two header rows ("Survey..."
 * then "Date...") and a "5+ units" column group headed Bldgs, Units, Value;
 * anything else is rejected rather than guessed.
 *
 * County key: state FIPS + county FIPS (5 digits). Place key: state FIPS +
 * FIPS place code (7 digits); rows with no place code are skipped.
 *
 * @param {string} text
 * @param {'county'|'place'} kind
 * @returns {Record<string, {bldgs:number, units:number, value:number, name:string}>}
 */
export function parseBpsFile(text, kind) {
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length < 3) throw new PermitsError('BAD_FILE');
  const top = cells(lines[0]);
  const second = cells(lines[1]);
  if (!/^survey$/i.test(top[0]) || !/^date$/i.test(second[0])) {
    throw new PermitsError('BAD_FILE');
  }
  // The group label sits over the middle (Units) column in the Census files,
  // so look for the Bldgs, Units, Value triple at or just left of it.
  const label = top.findIndex((cell) => /^5\+\s*units$/i.test(cell));
  const block = [label - 1, label, label - 2].find(
    (i) =>
      label >= 0 &&
      i >= 0 &&
      /^bldgs$/i.test(second[i] || '') &&
      /^units$/i.test(second[i + 1] || '') &&
      /^value$/i.test(second[i + 2] || ''),
  );
  if (block === undefined) throw new PermitsError('BAD_FILE');
  const nameIndex =
    kind === 'county'
      ? second.findIndex((cell) => /^name$/i.test(cell))
      : second.findIndex((cell, i) => /^name$/i.test(cell) && i > 5);
  const out = {};
  for (let i = 2; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    const row = cells(lines[i]);
    if (row.length < block + 3) continue;
    let key;
    if (kind === 'county') {
      if (!/^\d{2}$/.test(row[1]) || !/^\d{3}$/.test(row[2])) continue;
      key = `${row[1]}${row[2]}`;
    } else {
      if (!/^\d{2}$/.test(row[1]) || !/^\d{5}$/.test(row[5])) continue;
      if (row[5] === '00000' || row[5] === '99990') continue;
      key = `${row[1]}${row[5]}`;
    }
    const bldgs = Number(row[block]);
    const units = Number(row[block + 1]);
    const value = Number(row[block + 2]);
    if (![bldgs, units, value].every(Number.isFinite)) continue;
    const prior = out[key];
    out[key] = {
      bldgs: (prior?.bldgs || 0) + bldgs,
      units: (prior?.units || 0) + units,
      value: (prior?.value || 0) + value,
      name: prior?.name || (nameIndex >= 0 ? row[nameIndex] : ''),
    };
  }
  if (Object.keys(out).length === 0) throw new PermitsError('BAD_FILE');
  return out;
}

/**
 * Pick the newest annual files and the newest year-to-date file from a BPS
 * directory listing. File names: <prefix>YYYYa.txt and <prefix>YYMMy.txt.
 * @param {string} html
 * @param {string} prefix - 'co' for counties, 'so', 'ne', 'mw', 'we' for places.
 * @param {number} [years]
 * @param {Date} [now]
 * @returns {{annual:number[], ytd:{year:number, month:number, file:string}|null}}
 */
export function pickBpsFiles(
  html,
  prefix,
  years = PERMIT_YEARS,
  now = new Date(),
) {
  const annual = new Set();
  const ytd = [];
  // Two-digit years: the listings run back to the 1990s (so9912y.txt).
  const pivot = (now.getUTCFullYear() % 100) + 1;
  const fullYear = (yy) => (yy <= pivot ? 2000 + yy : 1900 + yy);
  const annualRe = new RegExp(`href="${prefix}(\\d{4})a\\.txt"`, 'g');
  const ytdRe = new RegExp(`href="${prefix}(\\d{2})(\\d{2})y\\.txt"`, 'g');
  for (const match of String(html).matchAll(annualRe)) {
    annual.add(Number(match[1]));
  }
  for (const match of String(html).matchAll(ytdRe)) {
    const month = Number(match[2]);
    if (month >= 1 && month <= 12) {
      ytd.push({
        year: fullYear(Number(match[1])),
        month,
        file: `${prefix}${match[1]}${match[2]}y.txt`,
      });
    }
  }
  const sorted = [...annual].sort((a, b) => b - a).slice(0, years);
  ytd.sort((a, b) => b.year - a.year || b.month - a.month);
  const latestYtd = ytd[0] && ytd[0].year > (sorted[0] || 0) ? ytd[0] : null;
  return { annual: sorted.sort((a, b) => a - b), ytd: latestYtd };
}

/**
 * Trend of the latest full year against the mean of the earlier years.
 * @param {Array<{year:number, units:number}>} years - Oldest first.
 * @returns {{direction:'rising'|'falling'|'flat'|'new'|'none', latestYear:number, latestUnits:number, priorMeanUnits:number, changePct:number|null, priorYears:number[]}|null}
 */
export function permitTrend(years) {
  if (!Array.isArray(years) || years.length < 2) return null;
  const latest = years[years.length - 1];
  // DATA-11: a county absent from a year's BPS file has no data for that
  // year, not zero permits. Averaging that fake zero into the trend pulled
  // the whole average down toward a county that simply was not filed yet.
  const prior = years.slice(0, -1).filter((y) => y.reported !== false);
  if (!prior.length) return null;
  const priorMean = prior.reduce((sum, y) => sum + y.units, 0) / prior.length;
  let direction;
  let changePct = null;
  if (priorMean === 0) {
    direction = latest.units > 0 ? 'new' : 'none';
  } else {
    changePct = Number(
      (((latest.units - priorMean) / priorMean) * 100).toFixed(1),
    );
    direction =
      changePct >= 10 ? 'rising' : changePct <= -10 ? 'falling' : 'flat';
  }
  return {
    direction,
    latestYear: latest.year,
    latestUnits: latest.units,
    priorMeanUnits: Number(priorMean.toFixed(1)),
    changePct,
    priorYears: prior.map((y) => y.year),
  };
}

async function fetchText(url, { fetchImpl, maxBytes }) {
  let response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'text/plain, text/html' },
    });
  } catch {
    throw new PermitsError('HTTP_ERROR');
  }
  if (!response.ok) {
    void response.body?.cancel?.().catch(() => {});
    throw new PermitsError('HTTP_ERROR');
  }
  try {
    return await readResponseTextCapped(response, maxBytes);
  } catch {
    throw new PermitsError('HTTP_ERROR');
  }
}

/**
 * Build the permits loader with its caches. Exposed for the live run and tests.
 * @param {{fetchImpl?: typeof fetch, cacheRoot?: string, disk?: boolean, sleep?: Function}} [options]
 */
export function createPermitsService({
  fetchImpl = globalThis.fetch,
  cacheRoot,
  disk = true,
  sleep,
} = {}) {
  const root = cacheRoot ? { rootDir: cacheRoot } : {};
  const listings = createCreCache({
    family: 'bps-listing',
    ttlMs: DAY_MS,
    disk,
    ...root,
  });
  const annualFiles = createCreCache({
    family: 'bps-annual',
    ttlMs: 90 * DAY_MS,
    maxEntries: 40,
    disk,
    ...root,
  });
  const ytdFiles = createCreCache({
    family: 'bps-ytd',
    ttlMs: 7 * DAY_MS,
    maxEntries: 10,
    disk,
    ...root,
  });
  const geography = createCreCache({
    family: 'permits-geo',
    ttlMs: 90 * DAY_MS,
    disk,
    ...root,
  });

  /** Oldest cache stamp behind one answer, so retrievedAt is the fetch time, not the request time (B-S2-2). */
  const makeTracker = () => {
    let oldest = null;
    return {
      note(at) {
        if (Number.isFinite(at))
          oldest = oldest === null ? at : Math.min(oldest, at);
      },
      get cachedAt() {
        return oldest;
      },
    };
  };

  const listing = (dirUrl, track) =>
    listings
      .getOrLoad(dirUrl, () =>
        fetchText(dirUrl, { fetchImpl, maxBytes: MAX_LISTING_BYTES }),
      )
      .then((entry) => {
        track?.note(entry.cachedAt);
        return entry.value;
      });

  const parsedFile = (cache, url, kind, track) =>
    cache
      .getOrLoad(url, async () =>
        parseBpsFile(
          await fetchText(url, { fetchImpl, maxBytes: MAX_FILE_BYTES }),
          kind,
        ),
      )
      .then((entry) => {
        track?.note(entry.cachedAt);
        return entry.value;
      });

  /** County and incorporated place containing the point. */
  async function locate(lat, lon, track) {
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    const { value, cachedAt } = await geography.getOrLoad(key, async () => {
      const opts = {
        fetchImpl,
        sleep,
        returnGeometry: false,
        timeoutMs: 10_000,
      };
      const [county, place] = await Promise.all([
        queryPoint(
          TIGER_LAYERS.county,
          { lat, lon },
          {
            ...opts,
            outFields: 'GEOID,STATE,COUNTY,NAME',
          },
        ),
        queryPoint(
          TIGER_LAYERS.place,
          { lat, lon },
          {
            ...opts,
            outFields: 'GEOID,STATE,PLACE,NAME,BASENAME',
          },
        ),
      ]);
      const c = county.features[0]?.attributes;
      const p = place.features[0]?.attributes;
      return {
        county:
          c && /^\d{5}$/.test(String(c.GEOID))
            ? { fips: String(c.GEOID), name: String(c.NAME) }
            : null,
        place:
          p && /^\d{7}$/.test(String(p.GEOID))
            ? { fips: String(p.GEOID), name: String(p.NAME) }
            : null,
      };
    });
    return value;
  }

  /**
   * Series for one geography across the picked files.
   * @param {'county'|'place'} kind
   */
  async function series(kind, key, dirUrl, prefix, track) {
    const picked = pickBpsFiles(await listing(`${dirUrl}/`, track), prefix);
    if (picked.annual.length === 0) throw new PermitsError('NO_FILES');
    const years = [];
    let found = false;
    let name = '';
    for (const year of picked.annual) {
      const url = `${dirUrl}/${prefix}${year}a.txt`;
      const table = await parsedFile(annualFiles, url, kind, track);
      const row = table[key];
      if (row) {
        found = true;
        name = row.name || name;
      }
      years.push({
        year,
        bldgs: row?.bldgs ?? 0,
        units: row?.units ?? 0,
        value: row?.value ?? 0,
        reported: Boolean(row),
        file: url,
      });
    }
    let ytd = null;
    if (picked.ytd) {
      const url = `${dirUrl}/${picked.ytd.file}`;
      const table = await parsedFile(ytdFiles, url, kind, track);
      const row = table[key];
      ytd = {
        year: picked.ytd.year,
        throughMonth: picked.ytd.month,
        bldgs: row?.bldgs ?? 0,
        units: row?.units ?? 0,
        value: row?.value ?? 0,
        reported: Boolean(row),
        file: url,
      };
    }
    return { found, name, years, ytd, trend: permitTrend(years) };
  }

  /** Full permits answer for a point. */
  async function permitsFor(lat, lon) {
    const track = makeTracker();
    const where = await locate(lat, lon, track);
    if (!where.county)
      return {
        county: null,
        place: null,
        geography: where,
        cachedAt: track.cachedAt,
      };
    const countySeries = await series(
      'county',
      where.county.fips,
      `${BPS_BASE}/County`,
      'co',
      track,
    );
    let place = null;
    if (where.place) {
      const region = placeRegion(where.place.fips.slice(0, 2));
      if (region) {
        const placeSeries = await series(
          'place',
          where.place.fips,
          `${BPS_BASE}/Place/${region.dir}`,
          region.prefix,
          track,
        );
        place = {
          fips: where.place.fips,
          name: where.place.name,
          issuesPermits: placeSeries.found,
          ...(placeSeries.found ? placeSeries : {}),
        };
      }
    }
    return {
      county: {
        fips: where.county.fips,
        name: where.county.name,
        ...countySeries,
      },
      place,
      geography: where,
      cachedAt: track.cachedAt,
    };
  }

  return { locate, series, permitsFor };
}

/**
 * Build the permits middleware.
 * @param {{service?: ReturnType<typeof createPermitsService>, limiter?: Function|null}} [options]
 */
export function crePermitsHandler({
  service = createPermitsService(),
  limiter = makeCreLimiter({ max: 60 }),
} = {}) {
  return creRoute(
    async ({ res, params }) => {
      const point = parsePoint(params);
      if (!point.ok) {
        sendError(res, 400, CRE_ERRORS.BAD_POINT);
        return;
      }
      const { cachedAt, ...data } = await service.permitsFor(
        point.lat,
        point.lon,
      );
      sendJson(
        res,
        200,
        creBody(
          data.county ? 'ready' : 'empty',
          data,
          PERMITS_SOURCE,
          Number.isFinite(cachedAt) ? new Date(cachedAt) : new Date(),
        ),
      );
    },
    { limiter, tag: 'permits' },
  );
}

/** Vite plugin mounting /api/cre/permits on the dev and preview servers. */
export function crePermitsProxy() {
  const install = (server) => {
    server.middlewares.use('/api/cre/permits', crePermitsHandler());
  };
  return {
    name: 'cre-permits',
    configureServer: install,
    configurePreviewServer: install,
  };
}

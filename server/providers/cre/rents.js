// GET /api/cre/rents?zip|lat&lon: Zillow ZORI for the site ZIP (downloaded server side, no CORS, cached 7 days) plus HUD FMR and Small Area FMR when HUD_API_TOKEN is set, so the dossier shows the rent level and trend without a key leaving the server.
import {
  readResponseJsonCapped,
  readResponseTextCapped,
} from '../common/http.js';
import { queryPoint } from './common/arcgis.js';
import { createCreCache } from './common/cache.js';
import { readCreKey } from './common/keys.js';
import {
  CRE_ERRORS,
  creBody,
  creRoute,
  makeCreLimiter,
  parsePoint,
  sendError,
  sendJson,
  parseRefresh,
} from './common/route.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const ZORI_URL =
  'https://files.zillowstatic.com/research/public_csvs/zori/Zip_zori_uc_sfrcondomfr_sm_month.csv';
const ZORI_MAX_BYTES = 40 * 1024 * 1024;
const ZORI_MONTHS_KEPT = 37;
export const HUD_FMR_URL = 'https://www.huduser.gov/hudapi/public/fmr/data';
const TIGER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb';
export const ZCTA_LAYER = `${TIGER}/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/1`;
export const COUNTY_LAYER = `${TIGER}/State_County/MapServer/1`;

export const ZORI_SOURCE = Object.freeze({
  name: 'Zillow Observed Rent Index (ZORI), all homes plus multifamily, smoothed, by ZIP',
  url: 'https://www.zillow.com/research/data/',
  license: 'Zillow Research data, free with attribution to Zillow',
});
export const HUD_SOURCE = Object.freeze({
  name: 'HUD Fair Market Rents and Small Area FMRs',
  url: 'https://www.huduser.gov/portal/dataset/fmr-api.html',
  license: 'Public domain (US Government work)',
});

/** Error with a fixed message and a stable code; never carries upstream text. */
export class RentsError extends Error {
  /** @param {'BAD_FILE'|'HTTP_ERROR'|'HUD_ERROR'} code */
  constructor(code) {
    super('Rent data source failed');
    this.name = 'RentsError';
    this.code = code;
  }
}

/** Split one CSV line, honoring double-quoted fields with commas and "". */
export function splitCsvLine(line) {
  const out = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  out.push(cell);
  return out;
}

const DATE_COLUMN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse the wide ZORI CSV into a compact table keeping the last 37 months.
 * @param {string} text
 * @returns {{dates:string[], rows:Record<string, {city:string, state:string, metro:string, county:string, values:(number|null)[]}>}}
 */
export function parseZoriCsv(text) {
  const lines = String(text || '').split(/\r?\n/);
  const header = splitCsvLine(lines[0] || '');
  const zipIndex = header.indexOf('RegionName');
  const typeIndex = header.indexOf('RegionType');
  const dateIndexes = header
    .map((name, i) => (DATE_COLUMN.test(name) ? i : -1))
    .filter((i) => i >= 0);
  if (zipIndex < 0 || dateIndexes.length < 13) {
    throw new RentsError('BAD_FILE');
  }
  const kept = dateIndexes.slice(-ZORI_MONTHS_KEPT);
  const col = (name) => header.indexOf(name);
  const idx = {
    city: col('City'),
    state: col('State'),
    metro: col('Metro'),
    county: col('CountyName'),
  };
  const rows = {};
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i]) continue;
    const row = splitCsvLine(lines[i]);
    if (typeIndex >= 0 && row[typeIndex] && row[typeIndex] !== 'zip') continue;
    const zip = String(row[zipIndex] || '').padStart(5, '0');
    if (!/^\d{5}$/.test(zip)) continue;
    rows[zip] = {
      city: row[idx.city] || '',
      state: row[idx.state] || '',
      metro: row[idx.metro] || '',
      county: row[idx.county] || '',
      values: kept.map((c) => {
        const text = row[c];
        if (text === undefined || text.trim() === '') return null;
        const value = Number(text);
        return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
      }),
    };
  }
  if (Object.keys(rows).length === 0) throw new RentsError('BAD_FILE');
  return { dates: kept.map((c) => header[c]), rows };
}

const pct = (now, then) =>
  now !== null && then !== null && then > 0
    ? Number((((now - then) / then) * 100).toFixed(2))
    : null;

/** Months of trailing history kept for the rent trend chart (feature 2). */
export const ZORI_HISTORY_MONTHS = 36;

/**
 * Latest value and 12 and 36 month changes for a ZIP, or null when the ZIP is
 * not in the file or has no values.
 * @param {ReturnType<typeof parseZoriCsv>} table
 * @param {string} zip
 */
export function zoriForZip(table, zip) {
  const row = table?.rows?.[zip];
  if (!row) return null;
  let last = -1;
  for (let i = row.values.length - 1; i >= 0; i -= 1) {
    if (row.values[i] !== null) {
      last = i;
      break;
    }
  }
  if (last < 0) return null;
  const at = (offset) =>
    last - offset >= 0 ? (row.values[last - offset] ?? null) : null;
  const latest = row.values[last];
  const ago12 = at(12);
  const ago36 = at(36);
  // The trailing window for the chart: every month is kept, including ones
  // with a null value, so a gap in Zillow's file renders as a gap, not a
  // false zero (feature 2). `last` may sit before month 36 in a short file;
  // Math.max keeps the start in range instead of a negative index.
  const start = Math.max(0, last - (ZORI_HISTORY_MONTHS - 1));
  const history = [];
  for (let i = start; i <= last; i += 1) {
    history.push({ date: table.dates[i], value: row.values[i] });
  }
  return {
    zip,
    city: row.city,
    state: row.state,
    metro: row.metro,
    county: row.county,
    latest: { date: table.dates[last], value: latest },
    value12MonthsAgo: ago12,
    value36MonthsAgo: ago36,
    change12mPct: pct(latest, ago12),
    change36mPct: pct(latest, ago36),
    history,
  };
}

const HUD_BEDROOMS = Object.freeze([
  ['studio', 'Efficiency'],
  ['oneBr', 'One-Bedroom'],
  ['twoBr', 'Two-Bedroom'],
  ['threeBr', 'Three-Bedroom'],
  ['fourBr', 'Four-Bedroom'],
]);

/**
 * Map a HUD FMR API body to rents by bedroom. When the area is Small Area FMR
 * (basicdata is a list by ZIP) the site ZIP's row wins; otherwise the area row.
 * Shape per HUD's API documentation. DATA-06: still not exercised against a
 * live response as of this pass (no HUD_API_TOKEN on this machine); the
 * caller marks its result `liveVerified` only when a real HTTP call reaches
 * this parser, so an untested build cannot claim verification it lacks.
 * @param {object} body
 * @param {string|null} zip
 */
export function parseHudFmr(body, zip) {
  const data = body?.data;
  if (!data || typeof data !== 'object') throw new RentsError('HUD_ERROR');
  const basic = data.basicdata;
  let row = null;
  let smallArea = false;
  if (Array.isArray(basic)) {
    row =
      basic.find((r) => String(r?.zip_code) === String(zip)) ||
      basic.find((r) => /msa level/i.test(String(r?.zip_code))) ||
      null;
    smallArea = Boolean(row && String(row.zip_code) === String(zip));
  } else if (basic && typeof basic === 'object') {
    row = basic;
  }
  if (!row) throw new RentsError('HUD_ERROR');
  const rents = {};
  for (const [key, field] of HUD_BEDROOMS) {
    const value = Number(row[field]);
    if (Number.isFinite(value) && value > 0) rents[key] = value;
  }
  if (!rents.oneBr && !rents.twoBr && !rents.threeBr) {
    throw new RentsError('HUD_ERROR');
  }
  return {
    areaName: String(
      data.area_name || data.metro_name || data.county_name || '',
    ),
    year: Number(data.year || row.year) || null,
    smallArea,
    zip: smallArea ? String(zip) : null,
    rents,
  };
}

/**
 * Build the rents service. fetchImpl, env and cache root are injectable.
 * @param {{fetchImpl?: typeof fetch, env?: Record<string,string|undefined>, cacheRoot?: string, disk?: boolean, sleep?: Function}} [options]
 */
export function createRentsService({
  fetchImpl = globalThis.fetch,
  env = process.env,
  cacheRoot,
  disk = true,
  sleep,
} = {}) {
  const root = cacheRoot ? { rootDir: cacheRoot } : {};
  const zoriCache = createCreCache({
    family: 'zori',
    ttlMs: 7 * DAY_MS,
    maxEntries: 2,
    disk,
    ...root,
  });
  const geoCache = createCreCache({
    family: 'rents-geo',
    ttlMs: 90 * DAY_MS,
    disk,
    ...root,
  });
  const fmrCache = createCreCache({
    family: 'hud-fmr',
    ttlMs: 30 * DAY_MS,
    disk,
    ...root,
  });

  async function zoriTable({ refresh = false } = {}) {
    const { value, cachedAt, source, refreshStatus, attemptedAt } =
      await zoriCache.getOrLoad(
        'zip-zori-v1',
        async () => {
          let response;
          try {
            response = await fetchImpl(ZORI_URL, {
              signal: AbortSignal.timeout(60_000),
            });
          } catch {
            throw new RentsError('HTTP_ERROR');
          }
          if (!response.ok) {
            void response.body?.cancel?.().catch(() => {});
            throw new RentsError('HTTP_ERROR');
          }
          let text;
          try {
            text = await readResponseTextCapped(response, ZORI_MAX_BYTES);
          } catch {
            throw new RentsError('HTTP_ERROR');
          }
          return parseZoriCsv(text);
        },
        { refresh },
      );
    return { table: value, cachedAt, source, refreshStatus, attemptedAt };
  }

  /** ZCTA and county for a point (2020 ZCTAs approximate USPS ZIPs). */
  async function locate(lat, lon) {
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    const { value } = await geoCache.getOrLoad(key, async () => {
      const opts = {
        fetchImpl,
        sleep,
        returnGeometry: false,
        timeoutMs: 10_000,
      };
      const [zcta, county] = await Promise.all([
        queryPoint(ZCTA_LAYER, { lat, lon }, { ...opts, outFields: 'ZCTA5' }),
        queryPoint(COUNTY_LAYER, { lat, lon }, { ...opts, outFields: 'GEOID' }),
      ]);
      const zip = String(zcta.features[0]?.attributes?.ZCTA5 ?? '');
      const fips = String(county.features[0]?.attributes?.GEOID ?? '');
      return {
        zip: /^\d{5}$/.test(zip) ? zip : null,
        countyFips: /^\d{5}$/.test(fips) ? fips : null,
      };
    });
    return value;
  }

  /**
   * HUD FMR for the county entity. Returns needs-key without making any
   * request when the token is absent.
   */
  async function fmr(countyFips, zip, { refresh = false } = {}) {
    const token = readCreKey('hud', env);
    if (!token) {
      return { status: 'needs-key', key: 'HUD_API_TOKEN' };
    }
    if (!countyFips) return { status: 'empty' };
    const url = `${HUD_FMR_URL}/${countyFips}99999`;
    try {
      const { value, cachedAt, source, refreshStatus, attemptedAt } =
        await fmrCache.getOrLoad(
          `${countyFips}:${zip}`,
          async () => {
            let response;
            try {
              response = await fetchImpl(url, {
                signal: AbortSignal.timeout(15_000),
                headers: {
                  Authorization: `Bearer ${token}`,
                  Accept: 'application/json',
                },
              });
            } catch {
              throw new RentsError('HUD_ERROR');
            }
            if (!response.ok) {
              void response.body?.cancel?.().catch(() => {});
              throw new RentsError('HUD_ERROR');
            }
            let body;
            try {
              body = await readResponseJsonCapped(response, 4 * 1024 * 1024);
            } catch {
              throw new RentsError('HUD_ERROR');
            }
            return parseHudFmr(body, zip);
          },
          { refresh },
        );
      return {
        status: 'ready',
        cachedAt,
        source,
        refreshStatus,
        attemptedAt,
        // DATA-06: this path only runs after a real HUD_API_TOKEN produced a
        // real HTTP response, so the parser genuinely ran against the live
        // API to reach this value, cached or not.
        liveVerified: true,
        ...value,
      };
    } catch {
      return { status: 'unavailable' };
    }
  }

  /**
   * Full rents answer.
   * @param {{zip?:string|null, lat?:number, lon?:number}} where
   */
  async function rentsFor({ zip = null, lat, lon, refresh = false }) {
    let siteZip = zip;
    let zipSource = zip ? 'query' : null;
    let countyFips = null;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      try {
        const located = await locate(lat, lon);
        countyFips = located.countyFips;
        if (!siteZip && located.zip) {
          siteZip = located.zip;
          zipSource = 'zcta';
        }
      } catch {
        // Point lookup failure only costs the FMR county and the ZCTA fallback.
      }
    }
    let zori = null;
    let zoriStatus = 'empty';
    let zoriRetrievedAt = null;
    let zoriRefreshStatus = null;
    let zoriAttemptedAt = null;
    let zoriSource = null;
    if (siteZip) {
      try {
        const { table, cachedAt, source, refreshStatus, attemptedAt } =
          await zoriTable({ refresh });
        zori = zoriForZip(table, siteZip);
        zoriStatus = zori ? 'ready' : 'empty';
        zoriRetrievedAt = new Date(cachedAt).toISOString();
        zoriSource = source;
        zoriRefreshStatus = refreshStatus;
        zoriAttemptedAt = attemptedAt;
      } catch {
        zoriStatus = 'unavailable';
      }
    }
    const fmrResult = await fmr(countyFips, siteZip, { refresh });
    const stamps = [
      Date.parse(zoriRetrievedAt ?? ''),
      fmrResult.cachedAt,
    ].filter(Number.isFinite);
    const attempts = [zoriAttemptedAt, fmrResult.attemptedAt].filter(
      Number.isFinite,
    );
    const refreshStatuses = [zoriRefreshStatus, fmrResult.refreshStatus].filter(
      Boolean,
    );
    const refreshFailed =
      zoriStatus === 'unavailable' ||
      (fmrResult.status === 'unavailable' && readCreKey('hud', env));
    return {
      zip: siteZip,
      zipSource,
      zoriStatus,
      zori,
      zoriRetrievedAt,
      cachedAt: stamps.length ? Math.min(...stamps) : null,
      fmr: fmrResult,
      ...(refresh
        ? {
            refresh: {
              status:
                refreshFailed ||
                zoriSource === 'STALE' ||
                fmrResult.source === 'STALE' ||
                refreshStatuses.includes('failed')
                  ? 'failed'
                  : refreshStatuses.includes('throttled')
                    ? 'throttled'
                    : refreshStatuses.includes('joined-existing')
                      ? 'joined-existing'
                      : 'succeeded',
              attemptedAt: attempts.length
                ? new Date(Math.max(...attempts)).toISOString()
                : null,
              dataRetrievedAt: stamps.length
                ? new Date(Math.min(...stamps)).toISOString()
                : null,
            },
          }
        : {}),
    };
  }

  return { rentsFor, zoriTable, locate, fmr };
}

/**
 * Build the rents middleware.
 * @param {{service?: ReturnType<typeof createRentsService>, limiter?: Function|null}} [options]
 */
export function creRentsHandler({
  service = createRentsService(),
  limiter = makeCreLimiter({ max: 60 }),
} = {}) {
  return creRoute(
    async ({ res, params }) => {
      const zipParam = params.get('zip');
      let zip = null;
      if (zipParam !== null && zipParam !== '') {
        if (!/^\d{5}$/.test(zipParam)) {
          sendError(res, 400, 'Invalid zip');
          return;
        }
        zip = zipParam;
      }
      let lat;
      let lon;
      if (params.has('lat') || params.has('lon')) {
        const point = parsePoint(params);
        if (!point.ok) {
          sendError(res, 400, CRE_ERRORS.BAD_POINT);
          return;
        }
        ({ lat, lon } = point);
      }
      if (!zip && lat === undefined) {
        sendError(res, 400, CRE_ERRORS.BAD_POINT);
        return;
      }
      const flag = parseRefresh(params);
      if (!flag.ok) {
        sendError(res, 400, CRE_ERRORS.BAD_REFRESH);
        return;
      }
      const {
        cachedAt,
        refresh: refreshMeta,
        ...data
      } = await service.rentsFor({ zip, lat, lon, refresh: flag.refresh });
      if (data.zoriStatus === 'unavailable' && data.fmr.status !== 'ready') {
        sendError(res, 502, CRE_ERRORS.UPSTREAM);
        return;
      }
      const ready = data.zoriStatus === 'ready' || data.fmr.status === 'ready';
      sendJson(res, 200, {
        ...creBody(
          ready ? 'ready' : 'empty',
          data,
          ZORI_SOURCE,
          Number.isFinite(cachedAt) ? new Date(cachedAt) : new Date(),
        ),
        ...(refreshMeta ? { refresh: refreshMeta } : {}),
      });
    },
    { limiter, tag: 'rents' },
  );
}

/** Vite plugin mounting /api/cre/rents on the dev and preview servers. */
export function creRentsProxy() {
  const install = (server) => {
    server.middlewares.use('/api/cre/rents', creRentsHandler());
  };
  return {
    name: 'cre-rents',
    configureServer: install,
    configurePreviewServer: install,
  };
}

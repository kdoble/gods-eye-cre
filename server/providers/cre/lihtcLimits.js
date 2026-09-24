// GET /api/cre/lihtc-limits/mtsp: HUD Multifamily Tax Subsidy Project (MTSP) 50 and 60 percent income limits for the site's county and the LIHTC max gross rents derived from them. Needs HUD_API_TOKEN; without it the route answers needs-key and makes no request of any kind.
import { queryPoint } from './common/arcgis.js';
import { createCreCache } from './common/cache.js';
import { readCreKey } from './common/keys.js';
import { pinnedFetch } from './common/pinnedHosts.js';
import {
  CRE_ERRORS,
  creBody,
  creRoute,
  makeCreLimiter,
  parsePoint,
  parseRefresh,
  sendError,
  sendJson,
} from './common/route.js';
import {
  DAY_MS,
  fetchJsonUpstream,
  makeDeps,
  mountOps,
  pointKey,
  UpstreamError,
} from './site.js';

/** Only hosts this provider may call. */
export const LIHTC_LIMITS_HOSTS = Object.freeze(
  new Set(['www.huduser.gov', 'tigerweb.geo.census.gov']),
);

/** HUD USER API, MTSP income limits by entity (county FIPS + 99999). */
export const HUD_MTSP_URL = 'https://www.huduser.gov/hudapi/public/mtspil/data';
/** Where a user gets a free HUD USER API token. */
export const HUD_SIGNUP_URL =
  'https://www.huduser.gov/portal/dataset/fmr-api.html';
const COUNTY_LAYER =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1';

export const LIHTC_LIMITS_SOURCE = Object.freeze({
  name: 'HUD USER API, Multifamily Tax Subsidy Project (MTSP) income limits',
  url: 'https://www.huduser.gov/portal/datasets/mtsp.html',
  license: 'Public domain (US Government work)',
});

const TIERS = Object.freeze([50, 60]);
const PERSONS = 8;

/**
 * Parse a HUD mtspil/data/{entityid} body into 50 and 60 percent limits for
 * 1 to 8 persons.
 *
 * NOT YET EXERCISED AGAINST THE LIVE API. The shape follows HUD's documented
 * "Response Structure for mtspil/data/{entityid}" (huduser.gov/portal/dataset/
 * fmr-api.html, read 2026-09-24): data.{area_name, year, median_income,
 * "50percent":{il50_p1..il50_p8}, "60percent":{il60_p1..il60_p8}}. HUD's table
 * types these as strings while its example shows numbers, so both are
 * accepted. No HUD_API_TOKEN exists on the build machine, so the only proof is
 * a hand-built fixture of that documented shape. Strict: a missing tier or a
 * missing, non-numeric or non-positive limit for 1 to 5 persons throws (5 is
 * needed for the 3BR rent).
 * @param {unknown} body
 */
export function parseMtsp(body) {
  const data = body && typeof body === 'object' ? body.data : null;
  if (!data || typeof data !== 'object') throw new UpstreamError('HUD_SHAPE');
  const limits = {};
  for (const tier of TIERS) {
    const block = data[`${tier}percent`];
    if (!block || typeof block !== 'object') {
      throw new UpstreamError('HUD_SHAPE');
    }
    const row = [];
    for (let n = 1; n <= PERSONS; n += 1) {
      const raw = block[`il${tier}_p${n}`];
      const value =
        raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
      if (Number.isFinite(value) && value > 0) row.push(value);
      else if (n <= 5) throw new UpstreamError('HUD_SHAPE');
      else row.push(null);
    }
    limits[tier] = row;
  }
  const year = Number(data.year);
  const median = Number(data.median_income);
  const areaName =
    [data.area_name, data.metro_name, data.county_name]
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .find(Boolean) || null;
  return {
    areaName,
    year: Number.isInteger(year) && year > 2000 ? year : null,
    medianIncome: Number.isFinite(median) && median > 0 ? median : null,
    heraSpecial: Boolean(
      data.hera_special_50percent || data.hera_special_60percent,
    ),
    limits,
  };
}

/**
 * LIHTC max gross rent (IRC section 42): 30 percent of the income limit at the
 * imputed household size, over 12, rounded down to a whole dollar. Imputed
 * size is 1.5 persons per bedroom, 1 for a studio: 0BR = 1, 1BR = 1.5 (mean
 * of the 1 and 2 person limits), 2BR = 3, 3BR = 4.5 (mean of 4 and 5).
 * @param {number[]} row - Limits for 1..8 persons.
 */
export function lihtcMaxRents(row) {
  const rent = (income) => Math.floor((income * 0.3) / 12);
  return {
    studio: rent(row[0]),
    oneBr: rent((row[0] + row[1]) / 2),
    twoBr: rent(row[2]),
    threeBr: rent((row[3] + row[4]) / 2),
  };
}

/**
 * @param {{fetchImpl?:typeof fetch, env?:Record<string,string|undefined>, timing?:object, cacheOptions?:object, limiter?:((key:string)=>boolean)|null}} [options]
 */
export function createLihtcLimitsHandlers({
  fetchImpl,
  env = process.env,
  timing,
  cacheOptions = {},
  limiter,
} = {}) {
  const deps = makeDeps({
    fetchImpl: pinnedFetch(LIHTC_LIMITS_HOSTS, fetchImpl),
    timing,
  });
  const countyCache = createCreCache({
    family: 'lihtc-limits-county',
    ttlMs: 90 * DAY_MS,
    ...cacheOptions,
  });
  const mtspCache = createCreCache({
    family: 'lihtc-limits-mtsp',
    ttlMs: 30 * DAY_MS,
    ...cacheOptions,
  });

  async function countyFor(point, refresh) {
    const entry = await countyCache.getOrLoad(
      pointKey('county', point.lat, point.lon),
      async () => {
        const { features } = await queryPoint(COUNTY_LAYER, point, {
          outFields: 'GEOID',
          returnGeometry: false,
          ...deps.arcgis,
        });
        const fips = String(features[0]?.attributes?.GEOID ?? '');
        return /^\d{5}$/.test(fips) ? fips : '';
      },
      { refresh },
    );
    return entry.value || null;
  }

  const mtsp = creRoute(
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
      // Presence check only; the value is read again at call time and is
      // never logged, cached, or put in a response body.
      if (!readCreKey('hud', env)) {
        sendJson(res, 200, {
          status: 'needs-key',
          data: { key: 'HUD_API_TOKEN', signupUrl: HUD_SIGNUP_URL },
          retrievedAt: new Date().toISOString(),
          source: LIHTC_LIMITS_SOURCE,
        });
        return;
      }
      const countyFips = await countyFor(point, refreshFlag.refresh);
      if (!countyFips) {
        sendJson(res, 200, creBody('empty', {}, LIHTC_LIMITS_SOURCE));
        return;
      }
      const entry = await mtspCache.getOrLoad(
        countyFips,
        async () => {
          const token = readCreKey('hud', env);
          if (!token) throw new UpstreamError('NO_KEY');
          const body = await fetchJsonUpstream(
            `${HUD_MTSP_URL}/${countyFips}99999`,
            {
              ...deps.upstream,
              timeoutMs: 15_000,
              init: { headers: { Authorization: `Bearer ${token}` } },
            },
          );
          return parseMtsp(body);
        },
        { refresh: refreshFlag.refresh },
      );
      const parsed = entry.value;
      const rents = Object.fromEntries(
        TIERS.map((tier) => [tier, lihtcMaxRents(parsed.limits[tier])]),
      );
      sendJson(
        res,
        200,
        creBody(
          'ready',
          {
            countyFips,
            entityId: `${countyFips}99999`,
            ...parsed,
            rents,
          },
          LIHTC_LIMITS_SOURCE,
          new Date(entry.cachedAt),
        ),
      );
    },
    {
      limiter: limiter === undefined ? makeCreLimiter() : limiter,
      tag: 'lihtc-limits',
    },
  );
  return { mtsp };
}

/** Vite plugin mounting /api/cre/lihtc-limits/*. */
export function creLihtcLimitsProxy(options) {
  return mountOps('lihtc-limits', createLihtcLimitsHandlers(options));
}

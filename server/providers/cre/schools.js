// GET /api/cre/schools?lat&lon&radiusM: public schools near a US point from NCES EDGE locations joined to NCES admin data on NCESSCH, cached 30 days, so the dossier can show the nearest school per level with enrollment, ratio and lunch share.
import { haversineMeters } from '../../../src/cre/geo.js';
import { arcgisQuery, queryRadius } from './common/arcgis.js';
import { createCreCache } from './common/cache.js';
import {
  CRE_ERRORS,
  creBody,
  creRoute,
  makeCreLimiter,
  parsePoint,
  parseRefresh,
  parseRadiusM,
  sendError,
  sendJson,
} from './common/route.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const EDGE_BASE =
  'https://nces.ed.gov/opengis/rest/services/K12_School_Locations';

export const SCHOOL_LAYERS = Object.freeze({
  locations: `${EDGE_BASE}/EDGE_GEOCODE_PUBLICSCH_2425/MapServer/0`,
  admin: `${EDGE_BASE}/EDGE_ADMINDATA_PUBLICSCH_2425/MapServer/1`,
});

export const SCHOOLS_SOURCE = Object.freeze({
  name: 'NCES EDGE Public School Locations and Administrative Data, SY 2024-25',
  url: 'https://nces.ed.gov/programs/edge/Geographic/SchoolLocations',
  license: 'Public domain (US Government work)',
});

/** Default search radius (5 mi) and ceiling (10 mi). */
export const SCHOOLS_RADIUS_M = Object.freeze({ fallback: 8047, max: 16094 });

const LOCATION_FIELDS = 'NCESSCH,NAME,LAT,LON,CITY,STATE';
const ADMIN_FIELDS = [
  'NCESSCH',
  'SCH_NAME',
  'SCHOOL_LEVEL',
  'GSLO',
  'GSHI',
  'MEMBER',
  'FTE',
  'STUTERATIO',
  'TOTFRL',
  'DIRECTCERT',
  'VIRTUAL',
  'SY_STATUS_TEXT',
  'CHARTER_TEXT',
].join(',');
const ADMIN_CHUNK = 80;
const NCESSCH_PATTERN = /^\d{12}$/;

/**
 * NCES codes missing, not applicable and suppressed values as negative
 * numbers (-1, -2, -9). Those are "not reported", never zero.
 * @param {unknown} value
 * @returns {number|null}
 */
export function ncesNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return number;
}

/**
 * Join EDGE locations to admin rows on NCESSCH and measure distance from the
 * site. A school with no admin row keeps admin: null, so a consumer can say
 * "not available" rather than showing zero.
 *
 * @param {Array<{attributes:object}>} locationFeatures
 * @param {Array<{attributes:object}>} adminFeatures
 * @param {{lat:number, lon:number}} site
 */
export function joinSchools(locationFeatures, adminFeatures, site) {
  const adminById = new Map();
  for (const feature of adminFeatures || []) {
    const row = feature?.attributes;
    if (row && NCESSCH_PATTERN.test(String(row.NCESSCH))) {
      adminById.set(String(row.NCESSCH), row);
    }
  }
  const schools = [];
  for (const feature of locationFeatures || []) {
    const row = feature?.attributes;
    const id = String(row?.NCESSCH ?? '');
    const lat = Number(row?.LAT);
    const lon = Number(row?.LON);
    if (!NCESSCH_PATTERN.test(id) || !Number.isFinite(lat)) continue;
    if (!Number.isFinite(lon)) continue;
    const admin = adminById.get(id) || null;
    schools.push({
      ncessch: id,
      name: String(row.NAME || admin?.SCH_NAME || id).trim(),
      city: row.CITY ? String(row.CITY).trim() : null,
      state: row.STATE ? String(row.STATE).trim() : null,
      lat,
      lon,
      distanceM: Math.round(haversineMeters(site.lat, site.lon, lat, lon)),
      admin: admin
        ? {
            level: admin.SCHOOL_LEVEL ? String(admin.SCHOOL_LEVEL) : null,
            gradeLow: admin.GSLO ? String(admin.GSLO) : null,
            gradeHigh: admin.GSHI ? String(admin.GSHI) : null,
            enrollment: ncesNumber(admin.MEMBER),
            fte: ncesNumber(admin.FTE),
            studentTeacherRatio: ncesNumber(admin.STUTERATIO),
            freeReducedLunch: ncesNumber(admin.TOTFRL),
            directCertification: ncesNumber(admin.DIRECTCERT),
            virtual: admin.VIRTUAL ? String(admin.VIRTUAL) : null,
            status: admin.SY_STATUS_TEXT ? String(admin.SY_STATUS_TEXT) : null,
            charter: admin.CHARTER_TEXT ? String(admin.CHARTER_TEXT) : null,
          }
        : null,
    });
  }
  schools.sort((a, b) => a.distanceM - b.distanceM);
  return schools;
}

/**
 * Query both EDGE layers and join them.
 * @param {{lat:number, lon:number, radiusM:number}} area
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal, sleep?: Function}} [options]
 */
export async function loadSchools({ lat, lon, radiusM }, options = {}) {
  const { features } = await queryRadius(
    SCHOOL_LAYERS.locations,
    { lat, lon, radiusM },
    {
      ...options,
      outFields: LOCATION_FIELDS,
      returnGeometry: false,
      timeoutMs: 12_000,
    },
  );
  const ids = [
    ...new Set(
      features
        .map((f) => String(f?.attributes?.NCESSCH ?? ''))
        .filter((id) => NCESSCH_PATTERN.test(id)),
    ),
  ];
  const adminFeatures = [];
  for (let i = 0; i < ids.length; i += ADMIN_CHUNK) {
    const chunk = ids.slice(i, i + ADMIN_CHUNK);
    const body = await arcgisQuery(
      SCHOOL_LAYERS.admin,
      {
        where: `NCESSCH IN (${chunk.map((id) => `'${id}'`).join(',')})`,
        outFields: ADMIN_FIELDS,
        returnGeometry: false,
      },
      { ...options, timeoutMs: 12_000 },
    );
    if (Array.isArray(body.features)) adminFeatures.push(...body.features);
  }
  return {
    radiusM,
    schools: joinSchools(features, adminFeatures, { lat, lon }),
  };
}

/**
 * Build the schools middleware. fetchImpl and cache are injectable for tests.
 * @param {{fetchImpl?: typeof fetch, cache?: ReturnType<typeof createCreCache>, limiter?: Function|null, sleep?: Function}} [options]
 */
export function creSchoolsHandler({
  fetchImpl = globalThis.fetch,
  cache = createCreCache({ family: 'schools', ttlMs: 30 * DAY_MS }),
  limiter = makeCreLimiter({ max: 60 }),
  sleep,
} = {}) {
  return creRoute(
    async ({ res, params }) => {
      const point = parsePoint(params);
      if (!point.ok) {
        sendError(res, 400, CRE_ERRORS.BAD_POINT);
        return;
      }
      const flag = parseRefresh(params);
      if (!flag.ok) return sendError(res, 400, CRE_ERRORS.BAD_REFRESH);
      const radius = parseRadiusM(params, SCHOOLS_RADIUS_M);
      if (!radius.ok) {
        sendError(res, 400, CRE_ERRORS.BAD_RADIUS);
        return;
      }
      const area = {
        lat: Number(point.lat.toFixed(5)),
        lon: Number(point.lon.toFixed(5)),
        radiusM: Math.round(radius.radiusM),
      };
      const key = `${area.lat},${area.lon},${area.radiusM}`;
      const entry = await cache.getOrLoad(
        key,
        () => loadSchools(area, { fetchImpl, sleep }),
        { refresh: flag.refresh },
      );
      const { value, cachedAt } = entry;
      sendJson(res, 200, {
        ...creBody(
          value.schools.length ? 'ready' : 'empty',
          value,
          SCHOOLS_SOURCE,
          new Date(cachedAt),
        ),
        ...(flag.refresh
          ? {
              refresh: {
                status: entry.refreshStatus,
                attemptedAt: Number.isFinite(entry.attemptedAt)
                  ? new Date(entry.attemptedAt).toISOString()
                  : null,
                dataRetrievedAt: new Date(entry.cachedAt).toISOString(),
              },
            }
          : {}),
      });
    },
    { limiter, tag: 'schools' },
  );
}

/** Vite plugin mounting /api/cre/schools on the dev and preview servers. */
export function creSchoolsProxy() {
  const install = (server) => {
    server.middlewares.use('/api/cre/schools', creSchoolsHandler());
  };
  return {
    name: 'cre-schools',
    configureServer: install,
    configurePreviewServer: install,
  };
}

// GET /api/cre/amenities?lat&lon: counts and nearest distance for everyday amenities within 1 mile of a site from OpenStreetMap, through the repo's Overpass transport with two extra public mirrors that answer from this network, cached 7 days.
import { haversineMeters } from '../../../src/cre/geo.js';
import { OVERPASS_UPSTREAMS } from '../overpass/constants.js';
import {
  fetchOverpassPayload,
  overpassPayloadIsData,
} from '../overpass/transport.js';
import { createCreCache } from './common/cache.js';
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

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Count radius (1 mi) and the wider radius used only for the nearest hospital (3 mi). */
export const AMENITY_RADIUS_M = 1609;
export const HOSPITAL_NEAREST_RADIUS_M = 4828;

/**
 * Mirror order. overpass-api.de and its lz4 host answered HTTP 406 to every
 * request from this network on 2026-09-22 (even /api/status), and kumi and
 * private.coffee timed out, while overpass.openstreetmap.fr answered 200 with
 * US data, so it goes first and the repo's own list stays as the fallback.
 * The VK-operated maps.mail.ru instance also answered but is deliberately
 * excluded: every query carries the exact coordinates of a site under review.
 */
export const AMENITY_OVERPASS_ENDPOINTS = Object.freeze([
  'https://overpass.openstreetmap.fr/api/interpreter',
  ...OVERPASS_UPSTREAMS,
]);

export const AMENITIES_SOURCE = Object.freeze({
  name: 'OpenStreetMap contributors, via the Overpass API',
  url: 'https://www.openstreetmap.org/copyright',
  license: 'ODbL 1.0',
});

/**
 * Category order matters: an element is counted once, in the first category
 * whose test it passes.
 */
export const AMENITY_CATEGORIES = Object.freeze([
  {
    id: 'grocery',
    label: 'Grocery',
    test: (t) => t.shop === 'supermarket' || t.shop === 'grocery',
  },
  {
    id: 'pharmacy',
    label: 'Pharmacy',
    test: (t) => t.amenity === 'pharmacy' || t.shop === 'chemist',
  },
  {
    id: 'restaurants',
    label: 'Restaurants',
    test: (t) => t.amenity === 'restaurant' || t.amenity === 'fast_food',
  },
  {
    id: 'gyms',
    label: 'Gyms',
    test: (t) => t.leisure === 'fitness_centre' || t.amenity === 'gym',
  },
  {
    id: 'transit',
    label: 'Transit stops',
    test: (t) =>
      t.highway === 'bus_stop' ||
      ['station', 'halt', 'tram_stop'].includes(t.railway) ||
      t.amenity === 'bus_station',
  },
  {
    id: 'hospitals',
    label: 'Hospitals',
    test: (t) => t.amenity === 'hospital',
  },
  { id: 'parks', label: 'Parks', test: (t) => t.leisure === 'park' },
  {
    id: 'bigBox',
    label: 'Big-box retail',
    test: (t) =>
      ['department_store', 'wholesale', 'doityourself', 'mall'].includes(
        t.shop,
      ),
  },
]);

/**
 * Overpass QL for every category around a point. Hospitals use the wider
 * radius so a nearest distance exists even when none is within 1 mile.
 * @param {number} lat @param {number} lon
 */
export function buildAmenitiesQuery(lat, lon) {
  const at = (r) => `(around:${r},${lat.toFixed(6)},${lon.toFixed(6)})`;
  const near = at(AMENITY_RADIUS_M);
  return [
    '[out:json][timeout:25];',
    '(',
    `nwr["shop"~"^(supermarket|grocery|chemist|department_store|wholesale|doityourself|mall)$"]${near};`,
    `nwr["amenity"~"^(pharmacy|restaurant|fast_food|gym|bus_station)$"]${near};`,
    `nwr["leisure"~"^(fitness_centre|park)$"]${near};`,
    `node["highway"="bus_stop"]${near};`,
    `nwr["railway"~"^(station|halt|tram_stop)$"]${near};`,
    `nwr["amenity"="hospital"]${at(HOSPITAL_NEAREST_RADIUS_M)};`,
    ');',
    'out tags center qt;',
  ].join('');
}

/** Error with a fixed message and a stable code; never carries upstream text. */
export class AmenitiesError extends Error {
  /** @param {'UPSTREAM'|'BAD_PAYLOAD'} code */
  constructor(code) {
    super('OpenStreetMap Overpass did not answer');
    this.name = 'AmenitiesError';
    this.code = code;
  }
}

/**
 * Summarize an Overpass JSON body into per-category counts within 1 mile and
 * the nearest named feature. Ways and relations use their center.
 * @param {{elements?: Array<object>, remark?: string}} payload
 * @param {{lat:number, lon:number}} site
 */
export function summarizeAmenities(payload, site) {
  if (!payload || !Array.isArray(payload.elements)) {
    throw new AmenitiesError('BAD_PAYLOAD');
  }
  if (
    typeof payload.remark === 'string' &&
    /error|timed out/i.test(payload.remark)
  ) {
    throw new AmenitiesError('UPSTREAM');
  }
  const categories = {};
  for (const category of AMENITY_CATEGORIES) {
    categories[category.id] = {
      label: category.label,
      count: 0,
      nearest: null,
    };
  }
  const points = [];
  const seen = new Set();
  for (const element of payload.elements) {
    const tags = element?.tags;
    if (!tags) continue;
    const key = `${element.type}/${element.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lat = Number(element.lat ?? element.center?.lat);
    const lon = Number(element.lon ?? element.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const category = AMENITY_CATEGORIES.find((c) => c.test(tags));
    if (!category) continue;
    const distanceM = Math.round(haversineMeters(site.lat, site.lon, lat, lon));
    const bucket = categories[category.id];
    if (distanceM <= AMENITY_RADIUS_M) bucket.count += 1;
    const limit =
      category.id === 'hospitals'
        ? HOSPITAL_NEAREST_RADIUS_M
        : AMENITY_RADIUS_M;
    if (distanceM > limit) continue;
    if (points.length < 500)
      points.push({
        type: 'Feature',
        properties: {
          name: String(tags.name || category.label).slice(0, 120),
          category: category.id,
        },
        geometry: { type: 'Point', coordinates: [lon, lat] },
      });
    if (!bucket.nearest || distanceM < bucket.nearest.distanceM) {
      bucket.nearest = {
        name: tags.name ? String(tags.name).slice(0, 120) : null,
        distanceM,
        lat,
        lon,
      };
    }
  }
  return {
    features: points,
    radiusM: AMENITY_RADIUS_M,
    hospitalNearestRadiusM: HOSPITAL_NEAREST_RADIUS_M,
    categories,
  };
}

/**
 * Query Overpass and summarize. Any non-data answer (406, 429, 5xx, runtime
 * error, unparseable JSON) becomes an AmenitiesError with a fixed message.
 * @param {{lat:number, lon:number}} site
 * @param {{fetchImpl?: typeof fetch, endpoints?: readonly string[]}} [options]
 */
export async function loadAmenities(site, options = {}) {
  const body = new URLSearchParams({
    data: buildAmenitiesQuery(site.lat, site.lon),
  }).toString();
  let payload;
  try {
    payload = await fetchOverpassPayload(body, MAX_RESPONSE_BYTES, {
      endpoints: options.endpoints || AMENITY_OVERPASS_ENDPOINTS,
      fetchImpl: options.fetchImpl || globalThis.fetch,
    });
  } catch {
    throw new AmenitiesError('UPSTREAM');
  }
  if (!overpassPayloadIsData(payload)) throw new AmenitiesError('UPSTREAM');
  let json;
  try {
    json = JSON.parse(payload.body);
  } catch {
    throw new AmenitiesError('BAD_PAYLOAD');
  }
  let host = null;
  try {
    host = new URL(payload.endpoint).host;
  } catch {
    host = null;
  }
  return {
    ...summarizeAmenities(json, site),
    mirror: host,
    osmBase: json?.osm3s?.timestamp_osm_base || null,
  };
}

/**
 * Build the amenities middleware.
 * @param {{fetchImpl?: typeof fetch, endpoints?: readonly string[], cache?: ReturnType<typeof createCreCache>, limiter?: Function|null}} [options]
 */
export function creAmenitiesHandler({
  fetchImpl,
  endpoints,
  cache = createCreCache({ family: 'amenities-v2', ttlMs: 7 * DAY_MS }),
  limiter = makeCreLimiter({ max: 30 }),
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
      const site = {
        lat: Number(point.lat.toFixed(4)),
        lon: Number(point.lon.toFixed(4)),
      };
      let entry;
      try {
        entry = await cache.getOrLoad(
          `${site.lat},${site.lon}`,
          () => loadAmenities(site, { fetchImpl, endpoints }),
          { refresh: flag.refresh },
        );
      } catch (error) {
        if (error instanceof AmenitiesError) {
          sendError(res, 502, CRE_ERRORS.UPSTREAM);
          return;
        }
        throw error;
      }
      const total = Object.values(entry.value.categories).reduce(
        (sum, c) => sum + c.count,
        0,
      );
      sendJson(res, 200, {
        ...creBody(
          total > 0 ? 'ready' : 'empty',
          entry.value,
          AMENITIES_SOURCE,
          new Date(entry.cachedAt),
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
    { limiter, tag: 'amenities' },
  );
}

/** Vite plugin mounting /api/cre/amenities on the dev and preview servers. */
export function creAmenitiesProxy() {
  const install = (server) => {
    server.middlewares.use('/api/cre/amenities', creAmenitiesHandler());
  };
  return {
    name: 'cre-amenities',
    configureServer: install,
    configurePreviewServer: install,
  };
}

// Drive-time access: the 15 minute isochrone from the Valhalla FOSSGIS demo (or openrouteservice when ORS_API_KEY is set) with its area in square miles, plus an OSRM drive time and distance to a target point.
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
import { fetchUpstreamText, UpstreamError } from './census.js';
import { haversineMeters } from '../../../src/cre/geo.js';
import { DRIVE_TIME_MINUTES } from '../../../src/cre/config.js';

const DAY_MS = 86_400_000;
export const SQ_METERS_PER_SQ_MILE = 2_589_988.110336;
/** WGS84 semi-major axis, the radius the ring-area formula is calibrated to. */
const AREA_RADIUS_M = 6_378_137;
export const MAX_ISOCHRONE_VERTICES = 20_000;

export const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/isochrone';
export const ORS_URL =
  'https://api.openrouteservice.org/v2/isochrones/driving-car';
export const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving';

export const VALHALLA_SOURCE = Object.freeze({
  name: 'Valhalla (FOSSGIS demo server), OpenStreetMap data',
  url: 'https://valhalla1.openstreetmap.de/',
  license: 'ODbL (OpenStreetMap contributors); demo server, fair use',
});
export const ORS_SOURCE = Object.freeze({
  name: 'openrouteservice, OpenStreetMap data',
  url: 'https://openrouteservice.org/',
  license: 'ODbL (OpenStreetMap contributors); ORS terms',
});
export const OSRM_SOURCE = Object.freeze({
  name: 'OSRM demo server, OpenStreetMap data',
  url: 'https://project-osrm.org/',
  license: 'ODbL (OpenStreetMap contributors); demo server, no SLA',
});

const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Area of one closed lon/lat ring in square meters on a sphere (the
 * Chamberlain and Duquette formula turf uses). Sign ignored.
 * @param {number[][]} ring
 */
export function ringAreaM2(ring) {
  const n = ring.length;
  if (n < 4) return 0;
  let total = 0;
  for (let i = 0; i < n - 1; i += 1) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % (n - 1)];
    const p3 = ring[(i + 2) % (n - 1)];
    total += (toRad(p3[0]) - toRad(p1[0])) * Math.sin(toRad(p2[1]));
  }
  return Math.abs((total * AREA_RADIUS_M * AREA_RADIUS_M) / 2);
}

/**
 * Area of a GeoJSON Polygon or MultiPolygon geometry (holes subtracted).
 * @param {{type:string, coordinates:any}} geometry
 */
export function geometryAreaM2(geometry) {
  const polygon = (rings) =>
    rings.reduce(
      (sum, ring, index) => sum + (index === 0 ? 1 : -1) * ringAreaM2(ring),
      0,
    );
  if (geometry?.type === 'Polygon') return polygon(geometry.coordinates);
  if (geometry?.type === 'MultiPolygon') {
    return geometry.coordinates.reduce((sum, p) => sum + polygon(p), 0);
  }
  return 0;
}

function validCoordinateArrays(geometry) {
  const rings =
    geometry.type === 'Polygon'
      ? geometry.coordinates
      : geometry.coordinates.flat();
  let count = 0;
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 4) return false;
    for (const p of ring) {
      if (
        !Array.isArray(p) ||
        !Number.isFinite(p[0]) ||
        !Number.isFinite(p[1]) ||
        Math.abs(p[0]) > 180 ||
        Math.abs(p[1]) > 90
      ) {
        return false;
      }
      count += 1;
    }
  }
  return count <= MAX_ISOCHRONE_VERTICES;
}

/**
 * Keep only polygon features from an isochrone response and measure them.
 * No polygon, or zero area, is unavailable rather than a zero-area ready.
 * @param {any} body - Parsed GeoJSON FeatureCollection.
 * @param {{lat:number, lon:number, minutes:number}} request
 */
export function normalizeIsochrone(body, { lat, lon, minutes }) {
  const features = (Array.isArray(body?.features) ? body.features : []).filter(
    (f) =>
      (f?.geometry?.type === 'Polygon' ||
        f?.geometry?.type === 'MultiPolygon') &&
      Array.isArray(f.geometry.coordinates) &&
      validCoordinateArrays(f.geometry),
  );
  const areaM2 = features.reduce(
    (sum, f) => sum + geometryAreaM2(f.geometry),
    0,
  );
  if (!features.length || !(areaM2 > 0)) return null;
  let maxDistanceM = 0;
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of features) {
    const rings =
      f.geometry.type === 'Polygon'
        ? f.geometry.coordinates
        : f.geometry.coordinates.flat();
    for (const ring of rings) {
      for (const [x, y] of ring) {
        maxDistanceM = Math.max(maxDistanceM, haversineMeters(lat, lon, y, x));
        box[0] = Math.min(box[0], x);
        box[1] = Math.min(box[1], y);
        box[2] = Math.max(box[2], x);
        box[3] = Math.max(box[3], y);
      }
    }
  }
  return {
    minutes,
    areaSqMi: areaM2 / SQ_METERS_PER_SQ_MILE,
    maxDistanceM: Math.round(maxDistanceM),
    bbox: box,
    geojson: {
      type: 'FeatureCollection',
      features: features.map((f) => ({
        type: 'Feature',
        properties: { minutes, metric: 'time' },
        geometry: f.geometry,
      })),
    },
  };
}

/**
 * Fetch one isochrone. ORS is used when its key exists (sent in a header,
 * never in the URL); otherwise the keyless Valhalla demo.
 * @param {{lat:number, lon:number, minutes:number}} request
 * @param {{env?:Record<string,string|undefined>, fetchImpl?:typeof fetch}} [options]
 */
export async function loadIsochrone({ lat, lon, minutes }, options = {}) {
  const { env = process.env, fetchImpl } = options;
  const orsKey = String(env.ORS_API_KEY ?? '').trim();
  let text;
  let source;
  let publicUrl;
  if (orsKey) {
    source = ORS_SOURCE;
    publicUrl = ORS_URL;
    ({ text } = await fetchUpstreamText(ORS_URL, {
      fetchImpl,
      method: 'POST',
      timeoutMs: 12_000,
      headers: { Authorization: orsKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locations: [[lon, lat]],
        range: [minutes * 60],
        range_type: 'time',
      }),
    }));
  } else {
    source = VALHALLA_SOURCE;
    const query = {
      locations: [{ lat, lon }],
      costing: 'auto',
      contours: [{ time: minutes }],
      polygons: true,
      denoise: 0.5,
      generalize: 150,
    };
    publicUrl = `${VALHALLA_URL}?json=${encodeURIComponent(JSON.stringify(query))}`;
    ({ text } = await fetchUpstreamText(publicUrl, {
      fetchImpl,
      timeoutMs: 12_000,
    }));
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new UpstreamError('INVALID_RESPONSE');
  }
  const data = normalizeIsochrone(body, { lat, lon, minutes });
  if (!data) {
    return {
      status: 'unavailable',
      data: null,
      source,
      sourceUrls: [publicUrl],
      message: 'Routing source returned no drive-time polygon',
    };
  }
  return {
    status: 'ready',
    data: { ...data, provider: orsKey ? 'openrouteservice' : 'valhalla' },
    source,
    sourceUrls: [publicUrl],
  };
}

/**
 * OSRM driving route summary between two points.
 * @param {{lat:number, lon:number, toLat:number, toLon:number}} request
 * @param {{fetchImpl?:typeof fetch}} [options]
 */
export async function loadRoute({ lat, lon, toLat, toLon }, options = {}) {
  const url = `${OSRM_URL}/${lon},${lat};${toLon},${toLat}?overview=false`;
  const { text } = await fetchUpstreamText(url, {
    fetchImpl: options.fetchImpl,
    timeoutMs: 10_000,
    retries: 1,
    retryDelayMs: options.retryDelayMs,
  });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new UpstreamError('INVALID_RESPONSE');
  }
  const route = body?.code === 'Ok' ? body.routes?.[0] : null;
  if (
    !route ||
    !Number.isFinite(route.duration) ||
    !Number.isFinite(route.distance)
  ) {
    return {
      status: 'unavailable',
      data: null,
      sourceUrls: [url],
      message: 'OSRM found no drivable route',
    };
  }
  return {
    status: 'ready',
    data: { durationS: route.duration, distanceM: route.distance },
    sourceUrls: [url],
  };
}

function parseMinutes(params) {
  if (!params.has('minutes')) return DRIVE_TIME_MINUTES;
  const minutes = Number(params.get('minutes'));
  return Number.isInteger(minutes) && minutes >= 5 && minutes <= 60
    ? minutes
    : null;
}

/**
 * GET /api/cre/isochrone?lat&lon&minutes (limit 10 per minute per client,
 * 7 day cache).
 * @param {{env?:Record<string,string|undefined>, fetchImpl?:typeof fetch, cache?:any, limiter?:any}} [options]
 */
export function isochroneHandler(options = {}) {
  const cache =
    options.cache ?? createCreCache({ family: 'isochrone', ttlMs: 7 * DAY_MS });
  return creRoute(
    async ({ res, params }) => {
      const point = parsePoint(params);
      if (!point.ok) return sendError(res, 400, CRE_ERRORS.BAD_POINT);
      const minutes = parseMinutes(params);
      if (minutes === null) return sendError(res, 400, 'Invalid minutes');
      const request = { lat: point.lat, lon: point.lon, minutes };
      const key = `${point.lat.toFixed(5)},${point.lon.toFixed(5)},${minutes}`;
      const fresh = cache ? await cache.getFresh(key) : null;
      let result = fresh?.value;
      if (!result) {
        result = await loadIsochrone(request, options);
        if (result.status === 'ready' && cache) await cache.set(key, result);
      }
      sendJson(res, 200, {
        ...creBody(result.status, result.data, result.source),
        sourceUrls: result.sourceUrls,
        ...(result.message ? { message: result.message } : {}),
      });
    },
    { limiter: options.limiter, tag: 'isochrone' },
  );
}

/**
 * GET /api/cre/isochrone/route?lat&lon&toLat&toLon (7 day cache).
 * @param {{fetchImpl?:typeof fetch, cache?:any, limiter?:any}} [options]
 */
export function driveRouteHandler(options = {}) {
  const cache =
    options.cache ??
    createCreCache({ family: 'drive-route', ttlMs: 7 * DAY_MS });
  return creRoute(
    async ({ res, params }) => {
      const from = parsePoint(params);
      const to = parsePoint(
        new URLSearchParams({
          lat: params.get('toLat') ?? '',
          lon: params.get('toLon') ?? '',
        }),
      );
      if (!from.ok || !to.ok) return sendError(res, 400, CRE_ERRORS.BAD_POINT);
      const request = {
        lat: from.lat,
        lon: from.lon,
        toLat: to.lat,
        toLon: to.lon,
      };
      const key = [from.lat, from.lon, to.lat, to.lon]
        .map((v) => v.toFixed(5))
        .join(',');
      const fresh = cache ? await cache.getFresh(key) : null;
      let result = fresh?.value;
      if (!result) {
        result = await loadRoute(request, options);
        if (result.status === 'ready' && cache) await cache.set(key, result);
      }
      sendJson(res, 200, {
        ...creBody(result.status, result.data, OSRM_SOURCE),
        sourceUrls: result.sourceUrls,
        ...(result.message ? { message: result.message } : {}),
      });
    },
    { limiter: options.limiter, tag: 'drive-route' },
  );
}

/** Vite plugin mounting /api/cre/isochrone and /api/cre/isochrone/route. */
export function creIsochroneProxy() {
  const isochrone = isochroneHandler({ limiter: makeCreLimiter({ max: 10 }) });
  const route = driveRouteHandler({ limiter: makeCreLimiter({ max: 30 }) });
  const install = (server) => {
    // The longer path first: connect matches by prefix.
    server.middlewares.use('/api/cre/isochrone/route', route);
    server.middlewares.use('/api/cre/isochrone', isochrone);
  };
  return {
    name: 'cre-isochrone',
    configureServer: install,
    configurePreviewServer: install,
  };
}

// Named daily-needs, retail, and workplace candidates with routed walking
// distances only for the daily-needs destination subset.
import { haversineMeters } from '../../../src/cre/geo.js';
import {
  fetchOverpassPayload,
  overpassPayloadIsData,
} from '../overpass/transport.js';
import { OVERPASS_UPSTREAMS } from '../overpass/constants.js';
import { createCreCache } from './common/cache.js';
import {
  creRoute,
  parsePoint,
  parseRefresh,
  sendError,
  sendJson,
  CRE_ERRORS,
  makeCreLimiter,
} from './common/route.js';

export const DESTINATION_SOURCE = Object.freeze({
  text: 'OpenStreetMap contributors, via Overpass API; public FOSSGIS OSRM routing service',
  url: 'https://www.openstreetmap.org/copyright',
  license: 'ODbL 1.0',
});
export const ROUTING_SOURCE_URL = 'https://routing.openstreetmap.de/';
export const DESTINATION_RADIUS_M = 5000;
// Schema v3 adds bounded named workplace candidates. A distinct cache family
// prevents pre-upgrade disk entries from hiding the new category.
export const DESTINATIONS_CACHE_FAMILY = 'cre-destinations-v3';
const DAY = 86_400_000;
const MAX_BYTES = 6 * 1024 * 1024;
const ENDPOINTS = Object.freeze([
  'https://overpass.openstreetmap.fr/api/interpreter',
  ...OVERPASS_UPSTREAMS,
]);

export function buildDestinationsQuery(lat, lon) {
  const around = `(around:${DESTINATION_RADIUS_M},${lat.toFixed(6)},${lon.toFixed(6)})`;
  return `[out:json][timeout:20];(nwr["shop"~"^(supermarket|grocery|chemist|department_store|mall|doityourself|hardware)$"]${around};nwr["amenity"="pharmacy"]${around};nwr["amenity"="cafe"]${around};nwr["leisure"="park"]${around};nwr["tourism"~"^(attraction|museum|theme_park|zoo|gallery|viewpoint)$"]${around};nwr["office"~"^(company|government|it|research|telecommunication|insurance|financial|engineering)$"]["name"]${around};nwr["amenity"~"^(hospital|university|college)$"]["name"]${around};);out tags center qt;`;
}

const WORKPLACE_OFFICE_TYPES = new Set([
  'company',
  'government',
  'it',
  'research',
  'telecommunication',
  'insurance',
  'financial',
  'engineering',
]);
const WORKPLACE_AMENITIES = new Set(['hospital', 'university', 'college']);

function category(tags = {}) {
  if (tags.shop === 'supermarket' || tags.shop === 'grocery') return 'grocery';
  if (tags.amenity === 'pharmacy' || tags.shop === 'chemist') return 'pharmacy';
  if (
    ['department_store', 'mall', 'doityourself', 'hardware'].includes(tags.shop)
  )
    return 'retail';
  return null;
}

export function selectDestinations(payload, site, maxPerCategory = 1) {
  if (!Array.isArray(payload?.elements))
    throw new Error('Invalid destination data');
  const unique = new Set();
  const items = [];
  for (const element of payload.elements) {
    const key = `${element?.type}/${element?.id}`;
    if (unique.has(key)) continue;
    unique.add(key);
    const kind = category(element.tags);
    const lat = Number(element.lat ?? element.center?.lat);
    const lon = Number(element.lon ?? element.center?.lon);
    if (
      !kind ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    )
      continue;
    const name = String(element.tags?.name || '')
      .trim()
      .slice(0, 120);
    if (!name) continue;
    const straightDistanceM = Math.round(
      haversineMeters(site.lat, site.lon, lat, lon),
    );
    if (straightDistanceM > DESTINATION_RADIUS_M) continue;
    items.push({
      id: key.slice(0, 100),
      name,
      category: kind,
      lat,
      lon,
      straightDistanceM,
    });
  }
  const selected = [];
  for (const kind of ['grocery', 'pharmacy', 'retail']) {
    selected.push(
      ...items
        .filter((item) => item.category === kind)
        .sort((a, b) => a.straightDistanceM - b.straightDistanceM)
        .slice(0, maxPerCategory),
    );
  }
  return selected;
}

/** Additional named map places. A returned OSM place has no verified opening date. */
export function selectMapPlaces(payload, site, maxPerCategory = 3) {
  if (!Array.isArray(payload?.elements))
    throw new Error('Invalid destination data');
  const seen = new Set();
  const places = [];
  for (const element of payload.elements) {
    const key = `${element?.type}/${element?.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tags = element?.tags || {};
    const category =
      tags.amenity === 'cafe'
        ? 'coffee'
        : tags.leisure === 'park'
          ? 'parks'
          : [
                'attraction',
                'museum',
                'theme_park',
                'zoo',
                'gallery',
                'viewpoint',
              ].includes(tags.tourism)
            ? 'attractions'
            : WORKPLACE_OFFICE_TYPES.has(tags.office) ||
                WORKPLACE_AMENITIES.has(tags.amenity)
              ? 'employers'
              : null;
    if (!category) continue;
    const name = String(tags.name || '')
      .trim()
      .slice(0, 120);
    const lat = Number(element.lat ?? element.center?.lat);
    const lon = Number(element.lon ?? element.center?.lon);
    if (
      !name ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    )
      continue;
    const straightDistanceM = Math.round(
      haversineMeters(site.lat, site.lon, lat, lon),
    );
    if (straightDistanceM > DESTINATION_RADIUS_M) continue;
    places.push({
      id: key.slice(0, 100),
      name,
      category,
      lat,
      lon,
      straightDistanceM,
      ...(/^(?:node|way|relation)\/\d+$/.test(key)
        ? { sourceUrl: `https://www.openstreetmap.org/${key}` }
        : {}),
      ...(category === 'employers'
        ? {
            workplaceType: WORKPLACE_AMENITIES.has(tags.amenity)
              ? tags.amenity
              : 'office',
          }
        : {}),
    });
  }
  return ['coffee', 'parks', 'attractions', 'employers'].flatMap((category) =>
    places
      .filter((item) => item.category === category)
      .sort((a, b) => a.straightDistanceM - b.straightDistanceM)
      .slice(0, category === 'employers' ? 6 : maxPerCategory),
  );
}

export async function loadDestinations(
  site,
  { fetchImpl = globalThis.fetch, endpoints = ENDPOINTS } = {},
) {
  const query = new URLSearchParams({
    data: buildDestinationsQuery(site.lat, site.lon),
  }).toString();
  const payload = await fetchOverpassPayload(query, MAX_BYTES, {
    endpoints,
    fetchImpl,
  });
  if (!overpassPayloadIsData(payload))
    throw new Error('Destination source unavailable');
  const osm = JSON.parse(payload.body);
  if (!Array.isArray(osm?.elements))
    throw new Error('Invalid destination data');
  const destinations = selectDestinations(osm, site);
  const mappedRetail = selectDestinations(osm, site, 5);
  const places = selectMapPlaces(osm, site);
  const featureItems = [
    ...new Map(
      [...mappedRetail, ...places].map((item) => [item.id, item]),
    ).values(),
  ];
  const features = featureItems.map((item) => ({
    type: 'Feature',
    properties: {
      id: item.id,
      name: item.name,
      named: true,
      category: item.category,
      straightDistanceM: item.straightDistanceM,
      ...(item.workplaceType ? { workplaceType: item.workplaceType } : {}),
      ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
    },
    geometry: { type: 'Point', coordinates: [item.lon, item.lat] },
  }));
  const host = (() => {
    try {
      return new URL(payload.endpoint).host;
    } catch {
      return null;
    }
  })();
  return {
    status: features.length ? 'ready' : 'empty',
    destinations,
    places,
    features,
    radiusM: DESTINATION_RADIUS_M,
    osmBase: osm.osm3s?.timestamp_osm_base || null,
    source: DESTINATION_SOURCE,
    sourceUrls: ['https://www.openstreetmap.org/copyright', ROUTING_SOURCE_URL],
    mirror: host,
    message:
      'Map: up to five named OpenStreetMap grocery, pharmacy and major retail candidates per category; up to three coffee, park and attraction places per category; and up to six named office, hospital and higher-education workplace candidates within 5 km. Workplace names are map candidates, not verified major employers or employee counts. Only the nearest grocery, pharmacy and major retail candidate is sent for a route. Coverage and hours vary; verify location and operating status. Place presence or first observation is not an opening date. Routed travel times are added separately through the app route service.',
  };
}

export function creDestinationsHandler({
  fetchImpl,
  endpoints,
  cache = createCreCache({ family: DESTINATIONS_CACHE_FAMILY, ttlMs: DAY }),
  limiter = makeCreLimiter({ max: 10 }),
} = {}) {
  return creRoute(
    async ({ res, params }) => {
      const point = parsePoint(params);
      if (!point.ok) return sendError(res, 400, CRE_ERRORS.BAD_POINT);
      const flag = parseRefresh(params);
      if (!flag.ok) return sendError(res, 400, CRE_ERRORS.BAD_REFRESH);
      const site = {
        lat: Number(point.lat.toFixed(4)),
        lon: Number(point.lon.toFixed(4)),
      };
      try {
        const entry = await cache.getOrLoad(
          `${site.lat},${site.lon}`,
          () => loadDestinations(site, { fetchImpl, endpoints }),
          { refresh: flag.refresh },
        );
        sendJson(res, 200, {
          data: entry.value,
          retrievedAt: new Date(entry.cachedAt).toISOString(),
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
      } catch {
        sendJson(res, 200, {
          data: {
            status: 'unavailable',
            routeStatus: 'unavailable',
            destinations: [],
            features: [],
            source: DESTINATION_SOURCE,
            sourceUrls: [
              'https://www.openstreetmap.org/copyright',
              ROUTING_SOURCE_URL,
            ],
            message:
              'Destination or walking route sources did not answer. No destinations or walking times can be inferred.',
          },
          retrievedAt: new Date().toISOString(),
        });
      }
    },
    { tag: 'cre-destinations', limiter },
  );
}

export function creDestinationsProxy() {
  const install = (server) => {
    server.middlewares.use('/api/cre/destinations', creDestinationsHandler());
  };
  return {
    name: 'cre-destinations',
    configureServer: install,
    configurePreviewServer: install,
  };
}

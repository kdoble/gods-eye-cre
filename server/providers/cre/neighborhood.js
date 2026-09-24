// Bounded, fixed-host public context: roads, Chicago incident coverage, Atlanta parcels.
import { readResponseJsonCapped } from '../common/http.js';
import { fetchOverpassPayload } from '../overpass/transport.js';
import { AMENITY_OVERPASS_ENDPOINTS } from './amenities.js';
import { arcgisPolygonFeature } from './hazards.js';
import { arcgisQuery } from './common/arcgis.js';
import { createCreCache } from './common/cache.js';
import {
  resolveLocalJurisdiction,
  LOCAL_JURISDICTIONS,
  LOCAL_PACKAGE_VERSION,
} from './jurisdictions.js';
import { loadLocalParcelZoning } from './localZoning.js';
import { loadDallasCrime } from './dallasCrime.js';
import {
  creRoute,
  parsePoint,
  parseRadiusM,
  parseRefresh,
  sendJson,
  sendError,
  CRE_ERRORS,
} from './common/route.js';

export const CRIME_SOURCE =
  'https://data.cityofchicago.org/Public-Safety/Crimes-2001-to-present/ijzp-q8t2';
export const PARCEL_SOURCE =
  'https://gis.atlantaga.gov/dpcd/rest/services/LandUsePlanning/CadastralLots/MapServer/17';
export const JC_PARCEL_SOURCE =
  'https://gis.johnsoncitytn.org/arcgis/rest/services/ParcelPublishing/TaxParcels/MapServer/0';
export const JC_ZONING_SOURCE =
  'https://gis.johnsoncitytn.org/arcgis/rest/services/LandUsePlanning/Zoning_and_Overlays/MapServer/1';
export const JC_CRIME_SOURCE =
  'https://experience.arcgis.com/experience/43bc4ffa407d4ac1b0a402ed189f745f/';
const DAY = 86_400_000;
const unavailable = (message) => ({
  status: 'unavailable',
  message,
  features: [],
});

export function crimeQuery(site, radiusM, now = new Date()) {
  const end = new Date(now.getTime() - 7 * DAY).toISOString().slice(0, 10);
  const start = new Date(now.getTime() - 97 * DAY).toISOString().slice(0, 10);
  const url = new URL('https://data.cityofchicago.org/resource/ijzp-q8t2.json');
  url.searchParams.set('$select', 'date,primary_type,latitude,longitude');
  url.searchParams.set(
    '$where',
    `date >= '${start}T00:00:00' AND date < '${end}T00:00:00' AND within_circle(location,${site.lat},${site.lon},${radiusM})`,
  );
  url.searchParams.set('$order', 'date DESC');
  url.searchParams.set('$limit', '2001');
  return { url: url.href, start, end };
}

export async function loadCrime(
  site,
  radiusM,
  {
    fetchImpl = globalThis.fetch,
    now = new Date(),
    johnsonCityConfirmed = false,
    jurisdiction,
  } = {},
) {
  const local = LOCAL_JURISDICTIONS.find(
    (entry) => entry.id === jurisdiction?.id,
  );
  if (local?.id === 'dallas-tx')
    return loadDallasCrime(site, radiusM, { fetchImpl, now });
  if (local) {
    return {
      status: 'unsupported',
      sourceStatus: 'published-not-connected',
      features: [],
      source: local.crime,
      sourceUrls: [local.crime],
      packageVersion: LOCAL_PACKAGE_VERSION,
      verifiedOn: '2026-09-23',
      sourceMetadata: {
        publisher:
          local.id === 'dallas-tx'
            ? 'Dallas Police Department'
            : 'Atlanta Police Department',
        coverage: local.name,
        recordDate: null,
        recordDateStatus: 'unverified',
      },
      message: `${local.crimeReason} Official source link only. Missing coverage is not evidence of low crime.`,
    };
  }
  if (jurisdiction?.status === 'unavailable') {
    return {
      status: 'unavailable',
      features: [],
      sourceUrls: jurisdiction.sourceUrls || [],
      message:
        'City boundary services did not answer; local police jurisdiction could not be confirmed.',
    };
  }
  if (
    johnsonCityConfirmed &&
    site.lat >= 36.15 &&
    site.lat <= 36.48 &&
    site.lon >= -82.55 &&
    site.lon <= -82.18
  ) {
    return {
      status: 'unavailable',
      sourceStatus: 'published-not-connected',
      verifiedOn: '2026-09-23',
      features: [],
      source: JC_CRIME_SOURCE,
      sourceUrls: [
        JC_CRIME_SOURCE,
        'https://www.tn.gov/tbi/divisions/cjis-division/tncrimeonline.html',
      ],
      message:
        'Source verified 2026-09-23: Johnson City Police links this official incident map and describes hourly updates beginning in 2020. The underlying feature feed did not return usable records during that verification, so this dossier does not show incident counts or a safety rating. The publisher excludes homicide, kidnapping, sex offenses, juvenile cases, unfounded reports, traffic and miscellaneous records. Missing or excluded records do not mean low crime. Tennessee TBI CrimeInsight is a separate agency-level source, not neighborhood coverage.',
    };
  }
  if (!(
    site.lat >= 41.64 &&
    site.lat <= 42.03 &&
    site.lon >= -87.95 &&
    site.lon <= -87.52
  )) {
    return {
      status: 'unsupported',
      features: [],
      source: CRIME_SOURCE,
      sourceUrls: [CRIME_SOURCE],
      message:
        'No automatic local crime feed for this area. Coverage pilot: Chicago reported incidents only. Import a dated official local GeoJSON layer or check local police records. Missing coverage does not mean low crime.',
    };
  }
  const query = crimeQuery(site, radiusM, now);
  const res = await fetchImpl(query.url, {
    signal: AbortSignal.timeout(12000),
    redirect: 'error',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error('Crime source unavailable');
  const rows = await readResponseJsonCapped(res, 3 * 1024 * 1024);
  if (!Array.isArray(rows)) throw new Error('Crime source unavailable');
  const features = rows.slice(0, 2000).flatMap((row) => {
    if (row.latitude == null || row.longitude == null) return [];
    const lat = Number(row.latitude),
      lon = Number(row.longitude);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    )
      return [];
    return [
      {
        type: 'Feature',
        properties: {
          name: String(row.primary_type || 'Reported incident').slice(0, 100),
          date: String(row.date || '').slice(0, 10),
        },
        geometry: { type: 'Point', coordinates: [lon, lat] },
      },
    ];
  });
  return {
    status: rows.length > 2000 ? 'partial' : 'ready',
    features,
    source: CRIME_SOURCE,
    sourceUrls: [CRIME_SOURCE],
    start: query.start,
    end: query.end,
    queryUrl: query.url,
    message: `Chicago police reports only, ${query.start} to ${query.end} (end exclusive). Most recent seven days excluded; approximate locations. ${rows.length > 2000 ? 'Only the newest 2,000 records are shown. ' : ''}Records with no coordinates are excluded by the source query. A record count is not a population-adjusted crime rate or a safety rating. Coverage outside city limits is not established.`,
  };
}

export async function loadRoads(
  site,
  radiusM,
  { fetchImpl = globalThis.fetch } = {},
) {
  const radius = Math.min(radiusM, 4828);
  const query = `[out:json][timeout:12];way["highway"~"^(motorway|trunk|primary|secondary|motorway_link|trunk_link)$"](around:${Math.round(radius)},${site.lat.toFixed(6)},${site.lon.toFixed(6)});out tags geom 350;`;
  const payload = await fetchOverpassPayload(
    new URLSearchParams({ data: query }).toString(),
    4 * 1024 * 1024,
    { endpoints: AMENITY_OVERPASS_ENDPOINTS, fetchImpl },
  );
  const data = JSON.parse(payload.body);
  if (!Array.isArray(data.elements) || data.remark)
    throw new Error('Roads unavailable');
  const features = data.elements.slice(0, 350).flatMap((row) => {
    const coordinates = (row.geometry || [])
      .map((p) => [p.lon, p.lat])
      .filter((p) => p.every(Number.isFinite));
    return coordinates.length < 2
      ? []
      : [
          {
            type: 'Feature',
            properties: {
              name:
                row.tags?.name ||
                row.tags?.ref ||
                row.tags?.highway ||
                'Mapped road',
            },
            geometry: { type: 'LineString', coordinates },
          },
        ];
  });
  return {
    status: data.elements.length >= 350 ? 'partial' : 'ready',
    features,
    radiusM: radius,
    source: 'https://www.openstreetmap.org/copyright',
    sourceUrls: ['https://www.openstreetmap.org/copyright'],
    message: `Mapped major roads within ${Number((radius / 1609.344).toFixed(1))} mi, up to 350 ways. A mapped road does not establish legal site access, a curb cut, traffic volume or highway ingress. OpenStreetMap coverage varies.`,
  };
}

export async function loadParcel(site, options = {}) {
  if (
    site.lat >= 36.15 &&
    site.lat <= 36.48 &&
    site.lon >= -82.55 &&
    site.lon <= -82.18
  ) {
    const query = (url, outFields) =>
      arcgisQuery(
        url,
        {
          geometry: `${site.lon},${site.lat}`,
          geometryType: 'esriGeometryPoint',
          spatialRel: 'esriSpatialRelIntersects',
          outFields,
          returnGeometry: true,
          resultRecordCount: 5,
          f: 'geojson',
        },
        { ...options, retries: 0, timeoutMs: 12000 },
      );
    const [parcelResult, zoningResult] = await Promise.allSettled([
      query(
        JC_PARCEL_SOURCE,
        'ADDRESS,ZONING,WATERSEWER,WATER,SEWER,ELEC,GAS,TAXYR',
      ),
      query(JC_ZONING_SOURCE, '*'),
    ]);
    const parcelFeatures =
      (parcelResult.status === 'fulfilled'
        ? parcelResult.value.features
        : []) || [];
    const normalizedParcelFeatures = parcelFeatures
      .slice(0, 5)
      .filter((f) => f.geometry?.rings?.length)
      .map((f) => arcgisPolygonFeature(f.geometry, f.attributes))
      .filter(Boolean);
    const zoning =
      zoningResult.status === 'fulfilled' ? zoningResult.value : null;
    const zoningFeatures = (zoning?.features || [])
      .slice(0, 5)
      .filter((f) => f.geometry?.rings?.length)
      .map((f) => arcgisPolygonFeature(f.geometry, f.attributes))
      .filter(Boolean);
    const features = [...normalizedParcelFeatures, ...zoningFeatures];
    const parcelStatus =
      parcelResult.status === 'rejected'
        ? 'unavailable'
        : normalizedParcelFeatures.length
          ? 'ready'
          : 'empty';
    const zoningStatus =
      zoningResult.status === 'rejected'
        ? 'unavailable'
        : zoningFeatures.length
          ? 'ready'
          : 'empty';
    return {
      status:
        parcelStatus === 'unavailable' || zoningStatus === 'unavailable'
          ? features.length
            ? 'partial'
            : 'unavailable'
          : features.length
            ? 'ready'
            : 'empty',
      features,
      parcelFeatures: normalizedParcelFeatures,
      zoningFeatures,
      parcelStatus,
      zoningStatus,
      source: JC_PARCEL_SOURCE,
      sourceUrls: [JC_PARCEL_SOURCE, JC_ZONING_SOURCE],
      message: `Johnson City GIS layers queried independently at the selected point (parcel: ${parcelStatus}; zoning: ${zoningStatus}). Confirm boundaries, current zoning interpretation, entitlements and utility availability with the city. Mapped utility flags do not establish capacity or connection rights.`,
    };
  }
  const jurisdiction =
    options.jurisdiction ||
    (await resolveLocalJurisdiction(site, 1609.344, options));
  return loadLocalParcelZoning(site, jurisdiction, options);
}

export function creNeighborhoodHandler({
  fetchImpl,
  cache = createCreCache({
    family: `neighborhood-${LOCAL_PACKAGE_VERSION.replaceAll('.', '-')}`,
    ttlMs: DAY,
  }),
  failureCache = createCreCache({
    family: 'neighborhood-failure-v1',
    ttlMs: 5 * 60 * 1000,
  }),
} = {}) {
  const inFlight = new Map();
  const refreshAttempts = new Map();
  const load = async (site, radiusM) => {
    const jurisdiction = await resolveLocalJurisdiction(site, radiusM, {
      fetchImpl,
    });
    const [roads, parcel] = await Promise.allSettled([
      loadRoads(site, radiusM, { fetchImpl }),
      loadParcel(site, { fetchImpl, jurisdiction }),
    ]);
    const parcelValue = parcel.status === 'fulfilled' ? parcel.value : null;
    const johnsonCityConfirmed = Boolean(parcelValue?.zoningFeatures?.length);
    const crime = await Promise.allSettled([
      loadCrime(site, radiusM, {
        fetchImpl,
        johnsonCityConfirmed,
        jurisdiction,
      }),
    ]).then((outcomes) => outcomes[0]);
    const outcomes = [roads, crime, parcel];
    return {
      jurisdiction,
      ...Object.fromEntries(
        ['roads', 'crime', 'parcel'].map((key, i) => [
          key,
          outcomes[i].status === 'fulfilled'
            ? outcomes[i].value
            : unavailable(
                `${key} source did not answer. Coverage cannot be assessed.`,
              ),
        ]),
      ),
    };
  };
  return creRoute(
    async ({ res, params }) => {
      const point = parsePoint(params),
        radius = parseRadiusM(params, { fallback: 1609.344, max: 8047 }),
        refresh = parseRefresh(params);
      if (!point.ok || !radius.ok || !refresh.ok)
        return sendError(
          res,
          400,
          !point.ok
            ? CRE_ERRORS.BAD_POINT
            : !radius.ok
              ? CRE_ERRORS.BAD_RADIUS
              : CRE_ERRORS.BAD_REFRESH,
        );
      const site = { lat: point.lat, lon: point.lon };
      const key = `${site.lat.toFixed(5)},${site.lon.toFixed(5)},${radius.radiusM}`;
      const attemptedAt = Date.now();
      const lastAttempt = refreshAttempts.get(key);
      const throttled =
        refresh.refresh &&
        lastAttempt !== undefined &&
        attemptedAt - lastAttempt < 30_000;
      if (refresh.refresh && !throttled) {
        refreshAttempts.delete(key);
        refreshAttempts.set(key, attemptedAt);
        while (refreshAttempts.size > 500)
          refreshAttempts.delete(refreshAttempts.keys().next().value);
      }
      let entry =
        !refresh.refresh || throttled ? await cache.getFresh(key) : null;
      if (!entry && (!refresh.refresh || throttled))
        entry = await failureCache.getFresh(key);
      if (!entry) {
        let pending = inFlight.get(key);
        if (!pending) {
          pending = (async () => {
            const value = await load(site, radius.radiusM);
            const hasUnavailable = Object.values(value).some(
              (item) => item?.status === 'unavailable',
            );
            const hasPartial =
              Object.values(value).some((item) => item?.status === 'partial') ||
              value.jurisdiction?.crossesBoundary === true;
            if (hasUnavailable || hasPartial) {
              const stale = await cache.getStale(key);
              if (stale) {
                for (const [name, item] of Object.entries(value)) {
                  if (item?.status === 'unavailable' && stale.value[name]) {
                    value[name] = {
                      ...stale.value[name],
                      stale: true,
                      staleAt: new Date(stale.cachedAt).toISOString(),
                      message: `${item.message} Showing the last successful observation from ${new Date(stale.cachedAt).toISOString()}.`,
                    };
                  }
                }
              }
              return failureCache.set(key, value);
            }
            return cache.set(key, value);
          })().finally(() => inFlight.delete(key));
          inFlight.set(key, pending);
        }
        entry = await pending;
      }
      const incomplete =
        Object.values(entry.value).some(
          (item) =>
            item?.stale === true ||
            ['unavailable', 'partial'].includes(item?.status),
        ) || entry.value.jurisdiction?.crossesBoundary === true;
      const observationAt = Math.min(
        entry.cachedAt,
        ...Object.values(entry.value)
          .filter((item) => item?.stale)
          .map((item) => Date.parse(item.staleAt))
          .filter(Number.isFinite),
      );
      sendJson(res, 200, {
        data: entry.value,
        retrievedAt: new Date(observationAt).toISOString(),
        ...(refresh.refresh
          ? {
              refresh: {
                status: throttled
                  ? 'throttled'
                  : incomplete
                    ? 'failed'
                    : 'succeeded',
                attemptedAt: new Date(
                  throttled ? lastAttempt : attemptedAt,
                ).toISOString(),
                dataRetrievedAt: new Date(observationAt).toISOString(),
              },
            }
          : {}),
      });
    },
    { tag: 'neighborhood' },
  );
}
export function creNeighborhoodProxy() {
  const install = (s) => {
    s.middlewares.use('/api/cre/neighborhood', creNeighborhoodHandler());
  };
  return {
    name: 'cre-neighborhood',
    configureServer: install,
    configurePreviewServer: install,
  };
}

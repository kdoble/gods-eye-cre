// GET /api/cre/incentives/{zones,lihtc,publichousing}: QCT, DDA and Opportunity Zone status plus nearby LIHTC and public housing from HUD eGIS, so tax-credit and OZ eligibility and affordable competition show for any US site.
import { haversineMeters } from '../../../src/cre/geo.js';
import { METERS_PER_MILE } from '../../../src/cre/config.js';
import { queryPoint, queryRadius } from './common/arcgis.js';
import { createCreCache } from './common/cache.js';
import { arcgisPolygonFeature, featureCollection } from './hazards.js';
import {
  DAY_MS,
  fetchJsonUpstream,
  makeDeps,
  mountOps,
  pointOp,
  text,
  UpstreamError,
} from './site.js';

const HUD = 'https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services';
const HUD_LICENSE = 'Public domain (US Government work)';

export const INCENTIVE_LAYERS = Object.freeze({
  qct: `${HUD}/QUALIFIED_CENSUS_TRACTS_2026/FeatureServer/0`,
  dda: `${HUD}/Difficult_Development_Areas_2026/FeatureServer/0`,
  oz: `${HUD}/Opportunity_Zones/FeatureServer/13`,
  lihtc: `${HUD}/LIHTC/FeatureServer/0`,
  publichousing: `${HUD}/Public_Housing_Developments/FeatureServer/0`,
});

export const INCENTIVE_SOURCES = Object.freeze({
  zones: {
    name: 'HUD eGIS: Qualified Census Tracts 2026, Difficult Development Areas 2026, Opportunity Zones',
    url: INCENTIVE_LAYERS.qct,
    license: HUD_LICENSE,
  },
  lihtc: {
    name: 'HUD eGIS: LIHTC properties',
    url: INCENTIVE_LAYERS.lihtc,
    license: HUD_LICENSE,
  },
  publichousing: {
    name: 'HUD eGIS: Public Housing Developments',
    url: INCENTIVE_LAYERS.publichousing,
    license: HUD_LICENSE,
  },
});

/** Search radii in miles: the brief's 1 and 3 mile rings. */
export const NEAR_MI = 1;
export const FAR_MI = 3;
const GEOMETRY_EXTRA = { maxAllowableOffset: 0.0001, geometryPrecision: 5 };

/** Designation year embedded in a HUD layer name, e.g. QUALIFIED_CENSUS_TRACTS_2026. */
function yearFromLayerName(name) {
  const match = String(name ?? '').match(/(20\d{2})\D*$/);
  return match ? Number(match[1]) : null;
}

/**
 * DATA-08: designation year N is the year in the layer name. HUD publishes
 * year-N QCT/DDA designations in the fall of year N-1, so the layer's
 * editingInfo.dataLastEditDate should fall in N-1 or N; older than that means
 * the layer data may not have been refreshed. The `description` field is NOT
 * used: on the live 2026 layers it is stale boilerplate ("Fiscal Year 2024 ...
 * Date Updated: 10/2023") while the data was last edited 2025-09-22.
 * N7: HUD publishes year N+1's designations in the FALL of year N (see
 * above), so the "a newer designation year may be available" flag must
 * fire from October 1 of year N, not January 1 of year N+1 -- the old
 * Dec-31 cutoff was false for the entire Oct-Dec window during which the
 * newer layer already existed.
 * @param {string} layer
 * @param {{fetchImpl:typeof fetch, now:()=>Date}} deps
 */
/** How long a layer's own metadata (year, last-edit date) is trusted before refetching. Point-independent, so every point sharing a process reuses one fetch. */
const DESIGNATION_CACHE_TTL_MS = DAY_MS;

async function loadDesignation(layer, deps) {
  const cache = deps.designationCache;
  const now = deps.now().getTime();
  const cached = cache?.get(layer);
  if (cached && cached.expiresAt > now) return cached.value;
  const fallbackYear = yearFromLayerName(layer.split('/').at(-3));
  let body = null;
  try {
    // S6: routed through the same 8s-timeout, size-capped, abortable fetch
    // every other upstream call in this family uses (site.js's
    // fetchJsonUpstream), instead of a bare, uncapped, non-abortable
    // fetch. A stalled HUD answer used to hold every point sharing this
    // cache slot open for minutes (Node's undici default), which the
    // browser's 25s route timeout only hid, never fixed.
    body = await fetchJsonUpstream(`${layer}?f=json`, {
      timeoutMs: 8_000,
      retries: 0,
      ...deps.upstream,
    });
  } catch {
    body = null;
  }
  const year = yearFromLayerName(body?.name) ?? fallbackYear;
  const editedMs = Number(body?.editingInfo?.dataLastEditDate);
  const edited =
    Number.isFinite(editedMs) && editedMs > 0 ? new Date(editedMs) : null;
  const today = deps.now();
  const value = {
    year,
    dataUpdated: edited ? edited.toISOString().slice(0, 10) : null,
    dataMayBeStale:
      Boolean(edited && year) && edited.getUTCFullYear() < year - 1,
    newerYearMayExist: Boolean(year) && today.getTime() >= Date.UTC(year, 9, 1),
  };
  // Only cache a real answer: a failed fetch (body === null, fallbackYear
  // only) must retry next time, never wedge a stale "unavailable" in place.
  if (body && cache) {
    cache.set(layer, { value, expiresAt: now + DESIGNATION_CACHE_TTL_MS });
  }
  return value;
}

/** One point-in-polygon lookup; returns the first feature or null. */
async function zoneLookup(layer, point, outFields, deps) {
  const { features } = await queryPoint(layer, point, {
    outFields,
    returnGeometry: true,
    extra: GEOMETRY_EXTRA,
    ...deps.arcgis,
  });
  return features[0] || null;
}

async function loadZones(point, deps) {
  const lookups = [
    ['qct', 'GEOID,NAME'],
    ['dda', 'ZCTA5,DDA_NAME,DDA_TYPE,DDA_CODE'],
    ['oz', 'GEOID10'],
  ];
  const [settled, qctDesignation, ddaDesignation] = await Promise.all([
    Promise.allSettled(
      lookups.map(([key, fields]) =>
        zoneLookup(INCENTIVE_LAYERS[key], point, fields, deps),
      ),
    ),
    loadDesignation(INCENTIVE_LAYERS.qct, deps),
    loadDesignation(INCENTIVE_LAYERS.dda, deps),
  ]);
  if (settled.every((s) => s.status === 'rejected')) {
    throw new UpstreamError('ALL_FAILED');
  }
  const data = { failed: [], qctDesignation, ddaDesignation };

  const features = [];
  settled.forEach((s, i) => {
    const [key] = lookups[i];
    if (s.status === 'rejected') {
      data.failed.push(key);
      data[key] = null;
      return;
    }
    const f = s.value;
    const a = f?.attributes || {};
    if (key === 'qct') {
      data.qct = {
        inside: Boolean(f),
        tract: text(a.GEOID),
        name: text(a.NAME),
      };
    } else if (key === 'dda') {
      data.dda = {
        inside: Boolean(f),
        name: text(a.DDA_NAME),
        zcta: text(a.ZCTA5),
        type: text(a.DDA_TYPE),
      };
    } else {
      data.oz = { inside: Boolean(f), tract2010: text(a.GEOID10) };
    }
    if (f?.geometry) {
      features.push(arcgisPolygonFeature(f.geometry, { zone: key }));
    }
  });
  data.geojson = featureCollection(features);
  return { status: 'ready', partial: data.failed.length > 0, data };
}

/** Radius query for HUD point layers, with distance from the site. */
async function nearbyPoints(layer, { lat, lon }, outFields, deps) {
  const result = await queryRadius(
    layer,
    { lat, lon, radiusM: FAR_MI * METERS_PER_MILE },
    {
      outFields,
      returnGeometry: true,
      extra: { resultRecordCount: 2000 },
      ...deps.arcgis,
    },
  );
  if (result.exceededTransferLimit) {
    // A partial list would undercount; report unavailable instead.
    throw new UpstreamError('TRUNCATED');
  }
  return result.features
    .map((f) => {
      const pLon = Number(f.geometry?.x);
      const pLat = Number(f.geometry?.y);
      if (!Number.isFinite(pLat) || !Number.isFinite(pLon)) return null;
      return {
        attributes: f.attributes || {},
        lat: pLat,
        lon: pLon,
        distanceMi: haversineMeters(lat, lon, pLat, pLon) / METERS_PER_MILE,
      };
    })
    .filter(Boolean)
    .sort((x, y) => x.distanceMi - y.distanceMi);
}

/** First finite, non-negative number among the arguments, or null. */
function units(...values) {
  for (const value of values) {
    const n = Number(value);
    if (value !== null && value !== '' && Number.isFinite(n) && n >= 0)
      return n;
  }
  return null;
}

/** Count, known-unit total and how many records lacked units, within a radius. */
function ringSummary(points, radiusMi, unitsOf) {
  const inside = points.filter((p) => p.distanceMi <= radiusMi);
  let total = 0;
  let unknown = 0;
  for (const p of inside) {
    const u = unitsOf(p);
    if (u === null) unknown += 1;
    else total += u;
  }
  return { count: inside.length, units: total, unitsUnknown: unknown };
}

const round2 = (n) => Math.round(n * 100) / 100;

function pointFeatures(points, nameOf, kind) {
  return featureCollection(
    points.map((p) => ({
      type: 'Feature',
      properties: { name: nameOf(p), kind },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    })),
  );
}

async function loadLihtc(point, deps) {
  const points = await nearbyPoints(
    INCENTIVE_LAYERS.lihtc,
    point,
    'HUD_ID,PROJECT,PROJ_ADD,PROJ_CTY,N_UNITS,LI_UNITS,N_UNITSR,LI_UNITR',
    deps,
  );
  const unitsOf = (p) => units(p.attributes.N_UNITS, p.attributes.N_UNITSR);
  const nameOf = (p) => text(p.attributes.PROJECT) || text(p.attributes.HUD_ID);
  return {
    status: 'ready',
    data: {
      oneMi: ringSummary(points, NEAR_MI, unitsOf),
      threeMi: ringSummary(points, FAR_MI, unitsOf),
      nearest: points.slice(0, 3).map((p) => ({
        name: nameOf(p),
        address: text(p.attributes.PROJ_ADD),
        units: unitsOf(p),
        lowIncomeUnits: units(p.attributes.LI_UNITS, p.attributes.LI_UNITR),
        distanceMi: round2(p.distanceMi),
      })),
      geojson: pointFeatures(points, nameOf, 'lihtc'),
    },
  };
}

async function loadPublicHousing(point, deps) {
  const points = await nearbyPoints(
    INCENTIVE_LAYERS.publichousing,
    point,
    'DEVELOPMENT_CODE,PROJECT_NAME,FORMAL_PARTICIPANT_NAME,TOTAL_UNITS,STD_ADDR',
    deps,
  );
  const unitsOf = (p) => units(p.attributes.TOTAL_UNITS);
  const nameOf = (p) =>
    text(p.attributes.PROJECT_NAME) || text(p.attributes.DEVELOPMENT_CODE);
  return {
    status: 'ready',
    data: {
      oneMi: ringSummary(points, NEAR_MI, unitsOf),
      threeMi: ringSummary(points, FAR_MI, unitsOf),
      nearest: points.slice(0, 3).map((p) => ({
        name: nameOf(p),
        agency: text(p.attributes.FORMAL_PARTICIPANT_NAME),
        units: unitsOf(p),
        distanceMi: round2(p.distanceMi),
      })),
      geojson: pointFeatures(points, nameOf, 'publichousing'),
    },
  };
}

/**
 * The incentive ops, with injectable fetch, timing and cache options for tests.
 * @param {{fetchImpl?:typeof fetch, timing?:object, cacheOptions?:object, limiter?:((key:string)=>boolean)|null}} [options]
 */
export function createIncentiveHandlers({
  fetchImpl,
  timing,
  cacheOptions = {},
  limiter,
  now = () => new Date(),
} = {}) {
  const deps = {
    ...makeDeps({ fetchImpl, timing }),
    now,
    // Fresh per handler set (per createIncentiveHandlers call), never a
    // module-level singleton -- so tests never leak a cached designation
    // across independently mocked fetch setups.
    designationCache: new Map(),
  };
  const loaders = {
    zones: loadZones,
    lihtc: loadLihtc,
    publichousing: loadPublicHousing,
  };
  const handlers = {};
  for (const [op, loader] of Object.entries(loaders)) {
    handlers[op] = pointOp({
      cache: createCreCache({
        family: `incentives-${op}`,
        ttlMs: 7 * DAY_MS,
        // DATA-08 (this release) added qctDesignation/ddaDesignation to
        // loadZones's cached per-point payload; a pre-existing 7-day
        // incentives-zones entry has neither field. Bumped so 'zones'
        // never serves that shape stale. lihtc/publichousing are unchanged.
        ...(op === 'zones' ? { version: 2 } : {}),
        ...cacheOptions,
      }),
      source: INCENTIVE_SOURCES[op],
      load: (point) => loader(point, deps),
      tag: `incentives-${op}`,
      limiter,
    });
  }
  return handlers;
}

/** Vite plugin mounting /api/cre/incentives/*. */
export function creIncentivesProxy(options) {
  return mountOps('incentives', createIncentiveHandlers(options));
}

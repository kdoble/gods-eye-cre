// GET /api/cre/hazards/{flood,nri,wetlands,epa,seismic}: FEMA flood zone and risk index, wetlands, EPA sites and seismic design category for a US point, so an investor sees site risk in one place.
import { haversineMeters, bbox } from '../../../src/cre/geo.js';
import { METERS_PER_MILE } from '../../../src/cre/config.js';
import { queryEnvelope, queryPoint, queryRadius } from './common/arcgis.js';
import { createCreCache } from './common/cache.js';
import {
  circleAcres,
  ringsAreaInCircleM2,
  SQ_M_PER_ACRE,
} from './common/circleClip.js';
import {
  DAY_MS,
  fetchJsonUpstream,
  makeDeps,
  mountOps,
  pointOp,
  text,
  UpstreamError,
  withRetry,
} from './site.js';

const PUBLIC_DOMAIN = 'Public domain (US Government work)';
const NFHL =
  'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer';
const FRS =
  'https://geodata.epa.gov/arcgis/rest/services/OEI/FRS_INTERESTS/MapServer';
const SEISMIC_URL = 'https://earthquake.usgs.gov/ws/designmaps/asce7-22.json';
// County FIPS lookup, so an ambiguous FIRM panel query can be resolved to the
// panel that actually governs this county rather than just the newest one.
const COUNTY_LAYER =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1';

export const HAZARD_SOURCES = Object.freeze({
  flood: {
    name: 'FEMA National Flood Hazard Layer',
    url: `${NFHL}/28`,
    license: PUBLIC_DOMAIN,
  },
  nri: {
    name: 'FEMA National Risk Index (census tracts)',
    url: 'https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Census_Tracts/FeatureServer/0',
    license: PUBLIC_DOMAIN,
  },
  wetlands: {
    name: 'USFWS National Wetlands Inventory',
    url: 'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0',
    license: PUBLIC_DOMAIN,
  },
  epa: {
    name: 'US EPA Facility Registry Service (FRS_INTERESTS)',
    url: FRS,
    license: PUBLIC_DOMAIN,
  },
  seismic: {
    name: 'USGS Seismic Design Web Services (ASCE 7-22)',
    url: SEISMIC_URL,
    license: PUBLIC_DOMAIN,
  },
});

/** Kept for the legacy fixtures; site classification now uses an exact server-side point query. */
export const FLOOD_SITE_HALF_DEG = 0.0001;
/** "Worst zone nearby" radius: 500 ft. */
export const FLOOD_NEAR_M = 152.4;
export const FLOOD_MAP_MAX_M = 5 * METERS_PER_MILE;
const FLOOD_MAP_MAX_FEATURES = 100;
export const WETLAND_RADIUS_M = 500;
export const EPA_RADIUS_M = METERS_PER_MILE;

/** EPA programs reported, keyed by FRS_INTERESTS layer id. */
export const EPA_PROGRAMS = Object.freeze([
  { key: 'brownfields', layer: 0, label: 'Brownfields (ACRES)' },
  { key: 'superfund', layer: 21, label: 'Superfund (SEMS)' },
  { key: 'rcra', layer: 15, label: 'Hazardous waste handlers (RCRA)' },
  { key: 'tri', layer: 23, label: 'Toxic release reporters (TRI)' },
]);

/** NRI hazard field prefixes to display names. */
export const NRI_HAZARDS = Object.freeze({
  AVLN: 'Avalanche',
  CFLD: 'Coastal flooding',
  CWAV: 'Cold wave',
  DRGT: 'Drought',
  ERQK: 'Earthquake',
  HAIL: 'Hail',
  HWAV: 'Heat wave',
  HRCN: 'Hurricane',
  ISTM: 'Ice storm',
  LNDS: 'Landslide',
  LTNG: 'Lightning',
  IFLD: 'Inland flooding',
  SWND: 'Strong wind',
  TRND: 'Tornado',
  TSUN: 'Tsunami',
  VLCN: 'Volcanic activity',
  WFIR: 'Wildfire',
  WNTW: 'Winter weather',
});

/** A regulatory floodway carries the no-rise requirement; it is the fact a buyer needs most. */
export const FLOODWAY_SUBTYPE = /FLOODWAY/;

/**
 * Severity rank of a NFHL zone, higher is worse. A regulatory floodway
 * outranks every other SFHA zone: with all SFHA zones tied at 5, `worstZone`
 * kept the first AE it saw and threw away the FLOODWAY beside it (B-S3-3).
 * Then V zones, then any other SFHA, then shaded X (0.2 percent annual
 * chance), then D and plain X.
 * @param {{zone:string, subtype:string|null, sfha:boolean}} z
 */
export function floodSeverity(z) {
  const zone = z.zone.toUpperCase();
  const subtype = String(z.subtype || '').toUpperCase();
  if (z.sfha && FLOODWAY_SUBTYPE.test(subtype)) return 7;
  if (z.sfha && zone.startsWith('V')) return 6;
  if (z.sfha) return 5;
  if (/0\.2 PCT|500/.test(subtype)) return 3;
  if (zone === 'D') return 2;
  if (zone === 'X') return 1;
  return 0;
}

/** NFHL feature attributes to a zone record, or null when the zone is blank. */
function floodZone(attributes = {}) {
  const zone = text(attributes.FLD_ZONE);
  if (!zone) return null;
  return {
    zone,
    subtype: text(attributes.ZONE_SUBTY),
    // Preserve FEMA's third state. Null/blank is not evidence that a zone is
    // outside the SFHA (and is common on partially populated records).
    sfha:
      attributes.SFHA_TF === 'T'
        ? true
        : attributes.SFHA_TF === 'F'
          ? false
          : null,
    bfeFt:
      Number.isFinite(attributes.STATIC_BFE) && attributes.STATIC_BFE > -9000
        ? attributes.STATIC_BFE
        : null,
  };
}

const EARTH_M = 111_195;
function pointSegmentMeters(lat, lon, a, b) {
  const cos = Math.cos((lat * Math.PI) / 180);
  const ax = (a[0] - lon) * EARTH_M * cos,
    ay = (a[1] - lat) * EARTH_M;
  const bx = (b[0] - lon) * EARTH_M * cos,
    by = (b[1] - lat) * EARTH_M;
  const dx = bx - ax,
    dy = by - ay;
  const t =
    dx * dx + dy * dy
      ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
      : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
function inRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i],
      [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}
function polygonDistanceMeters(lat, lon, geometry) {
  const rings = Array.isArray(geometry?.rings) ? geometry.rings : [];
  if (!rings.length) return Infinity;
  // Even-odd containment respects holes and disjoint polygon parts regardless
  // of ArcGIS ring ordering. Envelope candidates alone never establish membership.
  let inside = false;
  for (const ring of rings) if (inRing(lat, lon, ring)) inside = !inside;
  if (inside) return 0;
  let distance = Infinity;
  for (const ring of rings)
    for (let i = 0; i < ring.length - 1; i++)
      distance = Math.min(
        distance,
        pointSegmentMeters(lat, lon, ring[i], ring[i + 1]),
      );
  return distance;
}

function worstZone(features) {
  let worst = null;
  for (const feature of features) {
    const zone = floodZone(feature.attributes);
    if (zone && (!worst || floodSeverity(zone) > floodSeverity(worst))) {
      worst = zone;
    }
  }
  return worst;
}

/** Epoch ms or ISO text to YYYY-MM-DD, or null. */
function isoDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** Signed area of a ring (lon/lat); negative is clockwise. */
function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

/**
 * ArcGIS polygon rings (clockwise outers, counterclockwise holes) to a
 * GeoJSON MultiPolygon Feature with RFC 7946 winding, or null when empty.
 * @param {{rings?:number[][][]}} geometry
 * @param {object} properties
 */
export function arcgisPolygonFeature(geometry, properties = {}) {
  const rings = Array.isArray(geometry?.rings) ? geometry.rings : [];
  const polygons = [];
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 4) continue;
    const area = ringArea(ring);
    if (area < 0 || polygons.length === 0) {
      polygons.push([area < 0 ? [...ring].reverse() : ring]);
    } else {
      polygons[polygons.length - 1].push([...ring].reverse());
    }
  }
  if (polygons.length === 0) return null;
  return {
    type: 'Feature',
    properties,
    geometry: { type: 'MultiPolygon', coordinates: polygons },
  };
}

/** GeoJSON FeatureCollection. */
export const featureCollection = (features) => ({
  type: 'FeatureCollection',
  features: features.filter(Boolean),
});

async function loadFlood({ lat, lon, radiusM = METERS_PER_MILE }, deps) {
  // Exact server-side point classification avoids returning an entire FEMA
  // zone-X polygon (13 MB at the Dallas pilot), which exceeded our 8 MB cap.
  const arcgis = {
    ...deps.arcgis,
    // Two sequential FEMA stages must fit inside the section's deadline.
    // A slow source is an unavailable subresult, not a stalled dossier.
    timeoutMs: Math.min(deps.arcgis.timeoutMs ?? 5000, 5000),
    retries: Math.min(deps.arcgis.retries ?? 1, 1),
  };
  const fields = 'FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE';
  const atSite = await queryPoint(
    `${NFHL}/28`,
    { lat, lon },
    {
      outFields: fields,
      returnGeometry: false,
      extra: { resultRecordCount: 10 },
      ...arcgis,
    },
  );
  if (atSite.exceededTransferLimit)
    throw new Error('FEMA site classification incomplete');
  if (
    atSite.features.length &&
    atSite.features.some((f) => !floodZone(f.attributes))
  )
    throw new Error('FEMA flood zone schema invalid');
  const zone = worstZone(atSite.features);
  if (!zone) return { status: 'empty', data: {} };
  const mapRadiusM = Math.min(
    FLOOD_MAP_MAX_M,
    Math.max(METERS_PER_MILE, radiusM),
  );
  const [nearResult, panelResult, mapResult] = await Promise.allSettled([
    queryRadius(
      `${NFHL}/28`,
      { lat, lon, radiusM: FLOOD_NEAR_M },
      {
        outFields: fields,
        returnGeometry: false,
        extra: { resultRecordCount: 100 },
        ...arcgis,
      },
    ),
    queryPoint(
      `${NFHL}/3`,
      { lat, lon },
      {
        outFields: 'FIRM_PAN,EFF_DATE,PANEL_TYP,DFIRM_ID',
        returnGeometry: false,
        extra: { resultRecordCount: 10 },
        ...arcgis,
      },
    ),
    queryEnvelope(`${NFHL}/28`, bbox(lat, lon, mapRadiusM), {
      where: "SFHA_TF = 'T'",
      outFields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF',
      returnGeometry: true,
      extra: {
        maxAllowableOffset: 0.0002,
        geometryPrecision: 5,
        resultRecordCount: FLOOD_MAP_MAX_FEATURES,
      },
      ...arcgis,
    }),
  ]);
  const near = nearResult.status === 'fulfilled' ? nearResult.value : null;
  const nearInvalid =
    near?.features.some((f) => !floodZone(f.attributes)) || false;
  const nearWorst = near && !nearInvalid ? worstZone(near.features) : null;
  const nearby = near
    ? nearInvalid
      ? null
      : nearWorst && floodSeverity(nearWorst) > floodSeverity(zone)
        ? nearWorst
        : zone
    : null;
  const panels =
    panelResult.status === 'fulfilled' ? panelResult.value.features : [];
  const panelCandidates = panels
    .map((f) => ({
      id: text(f.attributes?.FIRM_PAN),
      // DFIRM_ID is the panel's own 6-character county/community code
      // ("13121C" countywide, "360497" community-based); when a caller's
      // query didn't request it, it is always FIRM_PAN's first 6
      // characters (DFIRM_ID + 4-digit panel + 1-letter suffix = 11).
      dfirmId:
        text(f.attributes?.DFIRM_ID) ||
        text(f.attributes?.FIRM_PAN)?.slice(0, 6) ||
        '',
      effective: isoDate(f.attributes?.EFF_DATE),
      type: text(f.attributes?.PANEL_TYP),
    }))
    .filter((item) => item.id);
  const panelSchemaInvalid = panels.length > panelCandidates.length;
  panelCandidates.sort((a, b) =>
    String(b.effective || '').localeCompare(String(a.effective || '')),
  );
  // N6: a COUNTYWIDE panel's DFIRM_ID is the 5-digit county FIPS plus a
  // trailing "C" (verified live 2026-09-24: Fulton County GA DFIRM_ID
  // "13121C"), so its first 5 digits really are the county FIPS. A
  // COMMUNITY-BASED panel's DFIRM_ID is a standalone NFIP community number
  // with NO trailing "C" and NO relationship to the county FIPS at all
  // (verified live: Brooklyn/Kings County NY, county FIPS 36047, DFIRM_ID
  // "360497", PANEL_TYP "Community Based, Not Printed") -- comparing it
  // against the county FIPS always failed by construction, degrading every
  // community-based site with an overlapping panel to "no county match".
  const isCountywidePanel = (p) => /C$/i.test(p.dfirmId || '');
  /** A FIRM panel id's first 5 digits are the county FIPS ONLY for a countywide panel. */
  let panel = panelCandidates[0] || null;
  let panelAmbiguous = false;
  // N-3: true only when the panel came from the state-scoped community-based
  // fallback below (a guess by elimination -- the sole remaining candidate
  // in-state, never confirmed against the site's own county). Left as a
  // documented guess, not a real fix, but the row must say so rather than
  // presenting it with the same confidence as a real county-FIPS match.
  let panelApproximate = false;
  if (panelCandidates.length > 1) {
    let countyFips = null;
    try {
      const countyResult = await queryPoint(
        COUNTY_LAYER,
        { lat, lon },
        { outFields: 'GEOID', returnGeometry: false, ...arcgis },
      );
      countyFips = text(countyResult.features[0]?.attributes?.GEOID);
    } catch {
      countyFips = null;
    }
    const validCountyFips = countyFips && /^\d{5}$/.test(countyFips);
    let matches = validCountyFips
      ? panelCandidates.filter(
          (p) => isCountywidePanel(p) && p.dfirmId.slice(0, 5) === countyFips,
        )
      : [];
    // No countywide candidate matched the county (or none is countywide at
    // all): a community-based candidate can only be identified by state
    // (its DFIRM_ID's own leading 2 digits), never by county. When exactly
    // one such candidate remains, it is the site's panel -- selecting it
    // beats degrading to "no county match" on every community-based site.
    // Two or more surviving community candidates is a genuine tie with no
    // county field to break it, so it stays conservatively ambiguous.
    if (!matches.length && validCountyFips) {
      const stateFips = countyFips.slice(0, 2);
      const communityInState = panelCandidates.filter(
        (p) =>
          !isCountywidePanel(p) && (p.dfirmId || '').slice(0, 2) === stateFips,
      );
      if (communityInState.length === 1) {
        matches = communityInState;
        panelApproximate = true;
      }
    }
    if (matches.length >= 1) {
      panel = matches[0];
      panelAmbiguous = false;
    } else {
      panel = null;
      panelAmbiguous = true;
    }
  }
  const shapes = mapResult.status === 'fulfilled' ? mapResult.value : null;
  const sfhaGeojson = shapes
    ? featureCollection(
        shapes.features.slice(0, FLOOD_MAP_MAX_FEATURES).map(
          (f) =>
            floodZone(f.attributes) &&
            arcgisPolygonFeature(f.geometry, {
              zone: text(f.attributes?.FLD_ZONE),
              subtype: text(f.attributes?.ZONE_SUBTY),
            }),
        ),
      )
    : null;
  const invalidShapes =
    shapes && sfhaGeojson.features.length !== shapes.features.length;
  const mapStatus = !shapes
    ? 'unavailable'
    : shapes.exceededTransferLimit ||
        invalidShapes ||
        shapes.features.length >= FLOOD_MAP_MAX_FEATURES
      ? 'partial'
      : shapes.features.length
        ? 'ready'
        : 'empty';
  const partial =
    !near ||
    nearInvalid ||
    near.exceededTransferLimit ||
    panelResult.status !== 'fulfilled' ||
    panelResult.value.exceededTransferLimit ||
    panelSchemaInvalid ||
    panelAmbiguous ||
    mapStatus === 'unavailable' ||
    mapStatus === 'partial';

  return {
    status: 'ready',
    partial,
    data: {
      site: zone,
      nearby,
      nearRadiusM: FLOOD_NEAR_M,
      panel,
      panels: panelCandidates,
      panelAmbiguous,
      panelApproximate,
      partial,
      panelCount: panelCandidates.length,
      sfhaGeojson,
      mapStatus,
      mapRadiusM,
      mapFeatureCount: sfhaGeojson?.features.length || 0,
      mapSimplification:
        'approximately 0.0002 degrees; map only, not used for the site determination',
      sourceMetadata: {
        publisher: 'FEMA National Flood Hazard Layer',
        source: HAZARD_SOURCES.flood.url,
        checkedAt: new Date().toISOString(),
        siteDeterminationMethod: 'unsimplified server-side point intersection',
        panelEffectiveDate: panel?.effective || null,
        floodMapRecordDate: null,
      },
    },
  };
}

async function loadNri(point, deps) {
  const outFields = [
    'TRACTFIPS',
    'COUNTY',
    'STATEABBRV',
    'RISK_SCORE',
    'RISK_RATNG',
    'SOVI_RATNG',
    'RESL_RATNG',
    'NRI_VER',
    ...Object.keys(NRI_HAZARDS).flatMap((k) => [`${k}_RISKS`, `${k}_RISKR`]),
  ].join(',');
  const { features } = await queryPoint(HAZARD_SOURCES.nri.url, point, {
    outFields,
    returnGeometry: false,
    ...deps.arcgis,
  });
  const a = features[0]?.attributes;
  if (!a || !Number.isFinite(a.RISK_SCORE) || !text(a.RISK_RATNG)) {
    return { status: 'empty', data: {} };
  }
  const hazards = Object.entries(NRI_HAZARDS)
    .map(([key, name]) => ({
      name,
      score: a[`${key}_RISKS`],
      rating: text(a[`${key}_RISKR`]),
    }))
    .filter(
      (h) =>
        Number.isFinite(h.score) &&
        h.score > 0 &&
        h.rating &&
        !/^(No Rating|Not Applicable|Insufficient Data)$/i.test(h.rating),
    )
    .sort((x, y) => y.score - x.score);
  return {
    status: 'ready',
    data: {
      tract: text(a.TRACTFIPS),
      score: Math.round(a.RISK_SCORE * 10) / 10,
      rating: a.RISK_RATNG,
      socialVulnerability: text(a.SOVI_RATNG),
      communityResilience: text(a.RESL_RATNG),
      version: text(a.NRI_VER),
      topHazards: hazards.slice(0, 3).map((h) => ({
        ...h,
        score: Math.round(h.score * 10) / 10,
      })),
    },
  };
}

async function loadWetlands(point, deps) {
  const fields = 'Wetlands.ATTRIBUTE,Wetlands.WETLAND_TYPE,Wetlands.ACRES';
  const onSite = await queryPoint(HAZARD_SOURCES.wetlands.url, point, {
    outFields: fields,
    returnGeometry: false,
    ...deps.arcgis,
  });
  const near = await queryRadius(
    HAZARD_SOURCES.wetlands.url,
    { ...point, radiusM: WETLAND_RADIUS_M },
    {
      outFields: fields,
      returnGeometry: true,
      extra: { maxAllowableOffset: 0.00002, geometryPrecision: 6 },
      ...deps.arcgis,
    },
  );
  // Acres are clipped to the 500 m circle (B1-13): NWI's ACRES field is the
  // whole feature, so a river through the circle reported 3,102 acres in a
  // 194 acre circle. The whole-feature total is kept, labeled as such.
  const circle = { ...point, radiusM: WETLAND_RADIUS_M };
  const byType = new Map();
  let acres = 0;
  let featureAcres = 0;
  let clipped = true;
  for (const f of near.features) {
    const type =
      text(f.attributes?.['Wetlands.WETLAND_TYPE']) || 'Unclassified';
    const whole = Number(f.attributes?.['Wetlands.ACRES']);
    const rings = f.geometry?.rings;
    const inside = Array.isArray(rings)
      ? ringsAreaInCircleM2(rings, circle) / SQ_M_PER_ACRE
      : null;
    if (inside === null) clipped = false;
    const entry = byType.get(type) || { type, count: 0, acres: 0 };
    entry.count += 1;
    if (inside !== null) {
      entry.acres += inside;
      acres += inside;
    }
    if (Number.isFinite(whole)) featureAcres += whole;
    byType.set(type, entry);
  }
  // Rounding and the many-sided circle can put the sum a hair over the
  // circle; clamp, never report more wetland than the circle holds.
  acres = Math.min(acres, circleAcres(WETLAND_RADIUS_M));
  const siteType = text(
    onSite.features[0]?.attributes?.['Wetlands.WETLAND_TYPE'],
  );
  return {
    status: 'ready',
    data: {
      onSite: onSite.features.length > 0,
      onSiteType: siteType,
      radiusM: WETLAND_RADIUS_M,
      count: near.features.length,
      acres: clipped ? Math.round(acres * 10) / 10 : null,
      acresMethod: clipped
        ? 'clipped to the 500 m circle'
        : 'not computed: the service returned no shapes',
      circleAcres: Math.round(circleAcres(WETLAND_RADIUS_M) * 10) / 10,
      featureAcres: Math.round(featureAcres * 10) / 10,
      types: [...byType.values()]
        .map((t) => ({ ...t, acres: Math.round(t.acres * 10) / 10 }))
        .sort((x, y) => y.acres - x.acres),
      truncated: near.exceededTransferLimit,
      geojson: featureCollection(
        near.features.map((f) =>
          arcgisPolygonFeature(f.geometry, {
            type: text(f.attributes?.['Wetlands.WETLAND_TYPE']),
            code: text(f.attributes?.['Wetlands.ATTRIBUTE']),
          }),
        ),
      ),
    },
  };
}

/** The EPA server intermittently answers {"error":{"code":404}}; retry those. */
const epaRetryable = (error) =>
  error?.retryable === true ||
  (error?.code === 'UPSTREAM_ERROR' && error?.status === 404);

async function loadEpaProgram(program, { lat, lon }, deps) {
  const result = await withRetry(
    () =>
      queryRadius(
        `${FRS}/${program.layer}`,
        { lat, lon, radiusM: EPA_RADIUS_M },
        {
          outFields: 'REGISTRY_ID,PRIMARY_NAME,LATITUDE83,LONGITUDE83',
          returnGeometry: false,
          extra: { resultRecordCount: 2000 },
          ...deps.arcgis,
          retries: 0,
        },
      ),
    {
      attempts: deps.epaAttempts ?? 4,
      shouldRetry: epaRetryable,
      backoffMs: deps.epaBackoffMs ?? 250,
    },
  );
  const sites = new Map();
  for (const f of result.features) {
    const a = f.attributes || {};
    const id = text(a.REGISTRY_ID) || `${a.LATITUDE83},${a.LONGITUDE83}`;
    const name = text(a.PRIMARY_NAME);
    const sLat = Number(a.LATITUDE83);
    const sLon = Number(a.LONGITUDE83);
    const distanceM =
      Number.isFinite(sLat) && Number.isFinite(sLon)
        ? haversineMeters(lat, lon, sLat, sLon)
        : null;
    if (!sites.has(id))
      sites.set(id, { name, lat: sLat, lon: sLon, distanceM });
  }
  const located = [...sites.values()].filter(
    (s) => s.name && Number.isFinite(s.distanceM),
  );
  located.sort((x, y) => x.distanceM - y.distanceM);
  const nearest = located[0];
  return {
    count: sites.size,
    truncated: result.exceededTransferLimit,
    nearest: nearest
      ? {
          name: nearest.name,
          distanceMi:
            Math.round((nearest.distanceM / METERS_PER_MILE) * 100) / 100,
        }
      : null,
    points: located.map((s) => ({ name: s.name, lat: s.lat, lon: s.lon })),
  };
}

async function loadEpa(point, deps) {
  const settled = await Promise.allSettled(
    EPA_PROGRAMS.map((p) => loadEpaProgram(p, point, deps)),
  );
  if (settled.every((s) => s.status === 'rejected')) {
    throw new UpstreamError('ALL_FAILED');
  }
  const programs = {};
  const failed = [];
  const features = [];
  settled.forEach((s, i) => {
    const program = EPA_PROGRAMS[i];
    if (s.status === 'rejected') {
      failed.push(program.key);
      return;
    }
    const { points, ...summary } = s.value;
    programs[program.key] = { label: program.label, ...summary };
    if (program.key === 'brownfields' || program.key === 'superfund') {
      for (const p of points) {
        features.push({
          type: 'Feature',
          properties: { name: p.name, program: program.key },
          geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        });
      }
    }
  });
  return {
    status: 'ready',
    partial: failed.length > 0,
    data: {
      radiusMi: 1,
      programs,
      failed,
      geojson: featureCollection(features),
    },
  };
}

async function loadSeismic({ lat, lon }, deps) {
  const url = `${SEISMIC_URL}?${new URLSearchParams({
    latitude: lat.toFixed(6),
    longitude: lon.toFixed(6),
    riskCategory: 'II',
    siteClass: 'D',
    title: 'site',
  })}`;
  const body = await fetchJsonUpstream(url, deps.upstream);
  const d = body?.response?.data;
  if (!d || typeof d !== 'object') throw new UpstreamError('INVALID_RESPONSE');
  const sdc = text(d.sdc);
  if (!sdc) return { status: 'empty', data: {} };
  return {
    status: 'ready',
    data: {
      sdc,
      ss: Number.isFinite(d.ss) ? d.ss : null,
      s1: Number.isFinite(d.s1) ? d.s1 : null,
      riskCategory: 'II',
      siteClass: 'D',
      code: 'ASCE 7-22',
    },
  };
}

/** Cache lifetimes per op (PLAN WP3). */
export const HAZARD_TTL_MS = Object.freeze({
  flood: 7 * DAY_MS,
  nri: 30 * DAY_MS,
  wetlands: 30 * DAY_MS,
  epa: 1 * DAY_MS,
  seismic: 30 * DAY_MS,
});

/**
 * The hazard ops, with injectable fetch, timing and cache options for tests.
 * @param {{fetchImpl?:typeof fetch, timing?:object, cacheOptions?:object, limiter?:((key:string)=>boolean)|null, epaAttempts?:number, epaBackoffMs?:number}} [options]
 */
export function createHazardHandlers({
  fetchImpl,
  timing,
  cacheOptions = {},
  limiter,
  epaAttempts,
  epaBackoffMs,
} = {}) {
  const deps = {
    ...makeDeps({ fetchImpl, timing }),
    epaAttempts,
    epaBackoffMs,
  };
  const loaders = {
    flood: loadFlood,
    nri: loadNri,
    wetlands: loadWetlands,
    epa: loadEpa,
    seismic: loadSeismic,
  };
  const handlers = {};
  for (const [op, loader] of Object.entries(loaders)) {
    handlers[op] = pointOp({
      cache: createCreCache({
        family: op === 'flood' ? 'hazards-flood-v3' : `hazards-${op}`,
        ttlMs: HAZARD_TTL_MS[op],
        // N6 (this release) changed how an ambiguous FIRM panel is picked
        // (county-FIPS match for countywide panels, state-scoped fallback
        // for community-based ones), which changes the cached `panel` and
        // `panelAmbiguous` fields for the SAME point. Bumped so a flood
        // answer cached under the old logic is never served stale.
        ...(op === 'flood' ? { version: 2 } : {}),
        ...cacheOptions,
      }),
      source: HAZARD_SOURCES[op],
      load: (point) => loader(point, deps),
      ...(op === 'flood'
        ? { radius: { fallback: METERS_PER_MILE, max: FLOOD_MAP_MAX_M } }
        : {}),
      tag: `hazards-${op}`,
      limiter,
    });
  }
  return handlers;
}

/** Vite plugin mounting /api/cre/hazards/*. */
export function creHazardsProxy(options) {
  return mountOps('hazards', createHazardHandlers(options));
}

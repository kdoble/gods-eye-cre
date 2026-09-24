import { arcgisQuery } from './common/arcgis.js';

// The registry is versioned independently from the remote GIS datasets. A
// registry revision never implies that the publisher refreshed its polygons.
export const LOCAL_PACKAGE_VERSION = '2026-09-23.2';
export const LOCAL_JURISDICTIONS = Object.freeze([
  Object.freeze({
    id: 'dallas-tx',
    name: 'City of Dallas, Texas',
    boundary:
      'https://gis.dallascityhall.com/arcgis/rest/services/Basemap/CityLimits/MapServer/0',
    boundaryField: 'CITY',
    boundaryValue: 'DALLAS',
    candidateBounds: { south: 32.5, north: 33.15, west: -97.25, east: -96.35 },
    planningAgency: 'City of Dallas Planning and Development',
    policeAgency: 'Dallas Police Department',
    zoning:
      'https://gis.dallascityhall.com/arcgis/rest/services/sdc_public/Zoning/MapServer/15',
    zoningField: 'LONG_ZONE_DIST',
    crime:
      'https://www.dallasopendata.com/Public-Safety/Police-Incidents/qv6i-rri7',
    crimeAvailability: 'connected-research-only',
    crimeReason:
      'Dallas Police offense records are preliminary and filtered; the city says its Crime Analytics Dashboard is authoritative.',
  }),
  Object.freeze({
    id: 'atlanta-ga',
    name: 'City of Atlanta, Georgia',
    boundary:
      'https://gis.atlantaga.gov/dpcd/rest/services/AdministrativeArea/GeopoliticalArea/FeatureServer/0',
    boundaryField: 'NAME',
    boundaryValue: 'ATLANTA',
    candidateBounds: { south: 33.45, north: 34.15, west: -84.85, east: -84.05 },
    planningAgency: 'City of Atlanta Department of City Planning',
    policeAgency: 'Atlanta Police Department',
    zoning:
      'https://gis.atlantaga.gov/dpcd/rest/services/OpenDataService1/FeatureServer/22',
    zoningField: 'ZONECLASS',
    parcel:
      'https://gis.atlantaga.gov/dpcd/rest/services/LandUsePlanning/CadastralLots/MapServer/17',
    crime: 'https://www.atlantapd.org/community/crime-statistics/crime-maps',
    crimeAvailability: 'official-link-only',
    crimeReason:
      'Atlanta Police publishes maps and downloads; the direct incident endpoint, schema, and reuse rights remain unverified.',
  }),
]);

function segmentDistanceM(point, a, b) {
  const scaleX = 111_320 * Math.cos((point[1] * Math.PI) / 180);
  const scaleY = 110_540;
  const ax = (a[0] - point[0]) * scaleX,
    ay = (a[1] - point[1]) * scaleY;
  const bx = (b[0] - point[0]) * scaleX,
    by = (b[1] - point[1]) * scaleY;
  const dx = bx - ax,
    dy = by - ay;
  const t = Math.max(
    0,
    Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)),
  );
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export function circleCrossesBoundary(site, radiusM, geometries) {
  const point = [site.lon, site.lat];
  for (const geometry of geometries) {
    for (const ring of geometry?.rings || []) {
      for (let i = 1; i < ring.length; i += 1) {
        if (segmentDistanceM(point, ring[i - 1], ring[i]) <= radiusM)
          return true;
      }
    }
  }
  return false;
}

function validBoundary(geometry) {
  return (
    Array.isArray(geometry?.rings) &&
    geometry.rings.length > 0 &&
    geometry.rings.every(
      (ring) =>
        Array.isArray(ring) &&
        ring.length >= 4 &&
        ring.every(
          (point) =>
            Array.isArray(point) &&
            point.length >= 2 &&
            Number.isFinite(point[0]) &&
            Number.isFinite(point[1]),
        ) &&
        ring[0][0] === ring.at(-1)[0] &&
        ring[0][1] === ring.at(-1)[1],
    )
  );
}

const unknown = (message, sources = []) => ({
  status: 'unavailable',
  id: null,
  message,
  sourceUrls: sources,
  packageVersion: LOCAL_PACKAGE_VERSION,
});

export async function resolveLocalJurisdiction(site, radiusM, options = {}) {
  const candidates = LOCAL_JURISDICTIONS.filter((entry) => {
    const b = entry.candidateBounds;
    return (
      site.lat >= b.south &&
      site.lat <= b.north &&
      site.lon >= b.west &&
      site.lon <= b.east
    );
  });
  if (!candidates.length)
    return {
      status: 'uncovered',
      id: null,
      sourceUrls: LOCAL_JURISDICTIONS.map((entry) => entry.boundary),
      packageVersion: LOCAL_PACKAGE_VERSION,
      boundaryCheckedAt: null,
      crossesBoundary: null,
      message:
        'The point is outside the broad candidate regions for tested city packages. No municipal membership is inferred from this prefilter.',
    };
  const results = await Promise.allSettled(
    candidates.map((entry) =>
      arcgisQuery(
        entry.boundary,
        {
          geometry: `${site.lon},${site.lat}`,
          geometryType: 'esriGeometryPoint',
          spatialRel: 'esriSpatialRelIntersects',
          outFields: entry.boundaryField,
          returnGeometry: true,
          resultRecordCount: 2,
        },
        { ...options, retries: 0, timeoutMs: 10_000 },
      ),
    ),
  );
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (result.status !== 'fulfilled') continue;
    const entry = candidates[i];
    const features = result.value.features;
    if (
      !Array.isArray(features) ||
      result.value.exceededTransferLimit ||
      features.length > 1
    ) {
      return unknown('City boundary response was incomplete.', [
        entry.boundary,
      ]);
    }
    if (
      features.some(
        (f) =>
          !f?.attributes ||
          typeof f.attributes[entry.boundaryField] !== 'string' ||
          !f.attributes[entry.boundaryField].trim(),
      )
    ) {
      return unknown(
        'City boundary name field was missing; municipal membership cannot be confirmed.',
        [entry.boundary],
      );
    }
    if (!features.every((f) => validBoundary(f.geometry))) {
      return unknown(
        'City boundary geometry was invalid; municipal membership cannot be confirmed.',
        [entry.boundary],
      );
    }
    const named = features.filter(
      (f) =>
        f.attributes[entry.boundaryField].trim().toUpperCase() ===
        entry.boundaryValue,
    );
    const matching = named;
    if (matching.length === 1) {
      return {
        status: 'resolved',
        id: entry.id,
        name: entry.name,
        planningAgency: entry.planningAgency,
        policeAgency: entry.policeAgency,
        policeAgencyStatus:
          'candidate-agency; verify service jurisdiction before incident adapter',
        county: null,
        countyStatus: 'not-resolved-by-city-package',
        source: entry.boundary,
        sourceUrls: [entry.boundary],
        packageVersion: LOCAL_PACKAGE_VERSION,
        boundaryCheckedAt: new Date().toISOString(),
        crossesBoundary: circleCrossesBoundary(
          site,
          radiusM,
          matching.map((f) => f.geometry),
        ),
        message:
          'Municipal jurisdiction confirmed by official city-limit polygon at the selected point.',
      };
    }
  }
  if (results.some((r) => r.status === 'rejected')) {
    return unknown(
      'At least one city boundary service did not answer; local jurisdiction cannot be confirmed.',
      LOCAL_JURISDICTIONS.map((entry) => entry.boundary),
    );
  }
  return {
    status: 'uncovered',
    id: null,
    sourceUrls: LOCAL_JURISDICTIONS.map((entry) => entry.boundary),
    packageVersion: LOCAL_PACKAGE_VERSION,
    boundaryCheckedAt: new Date().toISOString(),
    crossesBoundary: null,
    message:
      'Selected point is outside the tested Dallas and Atlanta municipal polygons. Nearby suburbs require separate agency packages.',
  };
}

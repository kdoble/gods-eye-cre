// Spherical geometry for the dossier (distance, bearing, ring polygons, bounding boxes) with no Cesium dependency so server, client and tests share it.

/** Mean Earth radius in meters (IUGG). */
export const EARTH_RADIUS_M = 6371008.8;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/**
 * Great-circle distance in meters.
 * @param {number} lat1 @param {number} lon1 @param {number} lat2 @param {number} lon2
 */
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Initial bearing from point 1 to point 2, degrees clockwise from north, [0, 360).
 * @param {number} lat1 @param {number} lon1 @param {number} lat2 @param {number} lon2
 */
export function bearingDegrees(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Normalize a longitude to [-180, 180). */
function wrapLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Point reached by travelling distanceM along a bearing.
 * @returns {{lat:number, lon:number}}
 */
export function destinationPoint(lat, lon, bearingDeg, distanceM) {
  const delta = distanceM / EARTH_RADIUS_M;
  const theta = toRad(bearingDeg);
  const phi1 = toRad(lat);
  const lambda1 = toRad(lon);
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) +
      Math.cos(phi1) * Math.sin(delta) * Math.cos(theta),
  );
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
    );
  return { lat: toDeg(phi2), lon: wrapLon(toDeg(lambda2)) };
}

/**
 * Closed GeoJSON Polygon Feature approximating a circle of radiusM.
 * @param {number} lat @param {number} lon @param {number} radiusM
 * @param {{steps?:number, properties?:object}} [options]
 */
export function ringPolygon(
  lat,
  lon,
  radiusM,
  { steps = 64, properties = {} } = {},
) {
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw new RangeError('radiusM must be a positive number');
  }
  const count = Math.max(8, Math.floor(steps));
  const ring = [];
  for (let i = 0; i < count; i += 1) {
    const p = destinationPoint(lat, lon, (360 * i) / count, radiusM);
    ring.push([p.lon, p.lat]);
  }
  ring.push([...ring[0]]);
  return {
    type: 'Feature',
    properties: { radiusM, ...properties },
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

/**
 * WGS84 bounding box of a circle, in GeoJSON order and as named edges.
 * Does not handle circles crossing the antimeridian or a pole (not needed for US sites).
 * @returns {{west:number, south:number, east:number, north:number, bbox:[number,number,number,number]}}
 */
export function bbox(lat, lon, radiusM) {
  const north = destinationPoint(lat, lon, 0, radiusM).lat;
  const south = destinationPoint(lat, lon, 180, radiusM).lat;
  const east = destinationPoint(lat, lon, 90, radiusM).lon;
  const west = destinationPoint(lat, lon, 270, radiusM).lon;
  // East/west edges of a small circle bulge past the due-east point at high
  // latitude; widen by the exact max longitude offset instead.
  const angular = radiusM / EARTH_RADIUS_M;
  const dLon = toDeg(
    Math.asin(Math.min(1, Math.sin(angular) / Math.cos(toRad(lat)))),
  );
  const w = Math.min(west, wrapLon(lon - dLon));
  const e = Math.max(east, wrapLon(lon + dLon));
  return { west: w, south, east: e, north, bbox: [w, south, e, north] };
}

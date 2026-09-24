// Area of polygon rings inside a circle around a point: clips each WGS84 ring to a many-sided polygon that approximates the circle, in local meters, so a wetland total counts only the acres near the site.

const EARTH_RADIUS_M = 6_371_008.8;
export const SQ_M_PER_ACRE = 4046.8564224;
/** Sides of the polygon standing in for the circle; its area is 99.99% of the circle's. */
export const CIRCLE_SIDES = 256;

/** WGS84 lon/lat to meters east/north of the center (equirectangular, fine at 500 m). */
function toLocal([lon, lat], center) {
  const rad = Math.PI / 180;
  return [
    (lon - center.lon) * rad * EARTH_RADIUS_M * Math.cos(center.lat * rad),
    (lat - center.lat) * rad * EARTH_RADIUS_M,
  ];
}

/** Signed shoelace area; counterclockwise is positive. */
export function signedArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** Counterclockwise polygon inscribed in the circle. */
export function circlePolygon(radiusM, sides = CIRCLE_SIDES) {
  return Array.from({ length: sides }, (_, i) => {
    const angle = (2 * Math.PI * i) / sides;
    return [radiusM * Math.cos(angle), radiusM * Math.sin(angle)];
  });
}

/**
 * Sutherland-Hodgman: clip any subject ring to a convex counterclockwise
 * clip polygon. The result can carry zero-width slivers where a concave
 * subject leaves and re-enters, which add no area.
 */
export function clipToConvex(subject, clip) {
  let output = subject;
  for (let i = 0; i < clip.length && output.length; i += 1) {
    const [ax, ay] = clip[i];
    const [bx, by] = clip[(i + 1) % clip.length];
    const inside = ([x, y]) => (bx - ax) * (y - ay) - (by - ay) * (x - ax) >= 0;
    const cross = ([px, py], [qx, qy]) => {
      const dx = qx - px;
      const dy = qy - py;
      const denom = (bx - ax) * dy - (by - ay) * dx;
      const t = ((ax - px) * (by - ay) - (ay - py) * (bx - ax)) / -denom;
      return [px + t * dx, py + t * dy];
    };
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j += 1) {
      const current = input[j];
      const previous = input[(j + input.length - 1) % input.length];
      if (inside(current)) {
        if (!inside(previous)) output.push(cross(previous, current));
        output.push(current);
      } else if (inside(previous)) {
        output.push(cross(previous, current));
      }
    }
  }
  return output;
}

/**
 * Square meters of an ArcGIS polygon (rings: outer rings one way, holes the
 * other) that fall inside the circle. Holes subtract because their signed
 * areas have the opposite sign.
 * @param {number[][][]} rings WGS84 [lon, lat] rings.
 * @param {{lat:number, lon:number, radiusM:number}} circle
 */
export function ringsAreaInCircleM2(rings, { lat, lon, radiusM }) {
  if (!Array.isArray(rings)) return 0;
  const clip = circlePolygon(radiusM);
  let total = 0;
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 3) continue;
    const local = ring.map((point) => toLocal(point, { lat, lon }));
    const open =
      local.length > 1 &&
      local[0][0] === local[local.length - 1][0] &&
      local[0][1] === local[local.length - 1][1]
        ? local.slice(0, -1)
        : local;
    const clipped = clipToConvex(open, clip);
    if (clipped.length >= 3) total += signedArea(clipped);
  }
  return Math.abs(total);
}

/** Acres of the circle itself, the most any clipped total can reach. */
export const circleAcres = (radiusM) =>
  (Math.PI * radiusM * radiusM) / SQ_M_PER_ACRE;

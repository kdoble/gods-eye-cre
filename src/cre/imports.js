import { safeSourceUrl } from './sourceUrls.js';
// Local-only user evidence. Inputs are bounded and never executed or fetched.
export const IMPORT_MAX_BYTES = 1_000_000;
export function usBounds(lon, lat) {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    ((lat >= 24 && lat <= 50 && lon >= -125 && lon <= -66) ||
      (lat >= 51 && lat <= 72 && lon >= -180 && lon <= -129) ||
      (lat >= 18 && lat <= 23 && lon >= -161 && lon <= -154) ||
      (lat >= 17 && lat <= 19 && lon >= -68 && lon <= -64))
  );
}
function crosses(a, b, c, d) {
  const orient = (p, q, r) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return (
    orient(a, b, c) * orient(a, b, d) < 0 &&
    orient(c, d, a) * orient(c, d, b) < 0
  );
}
export function polygonAcres(rings) {
  const areas = rings.map((ring) =>
    Math.abs(
      (ring.reduce((sum, p, i) => {
        const q = ring[(i + 1) % ring.length];
        return (
          sum +
          (((q[0] - p[0]) * Math.PI) / 180) *
            (2 +
              Math.sin((p[1] * Math.PI) / 180) +
              Math.sin((q[1] * Math.PI) / 180))
        );
      }, 0) *
        6371008.8 ** 2) /
        2,
    ),
  );
  return (
    Math.max(0, (areas[0] || 0) - areas.slice(1).reduce((a, b) => a + b, 0)) /
    4046.8564224
  );
}
export function parseOverlay(text) {
  if (text.length > IMPORT_MAX_BYTES)
    throw new Error('GeoJSON must be smaller than 1 MB.');
  const data = JSON.parse(text),
    features =
      data.type === 'FeatureCollection'
        ? data.features
        : data.type === 'Feature'
          ? [data]
          : null;
  if (!Array.isArray(features) || !features.length || features.length > 1000)
    throw new Error('Use 1 to 1,000 GeoJSON features.');
  let vertices = 0,
    acres = 0;
  const cleaned = features.map((f, index) => {
    const g = f.geometry;
    if (!['Point', 'LineString', 'Polygon', 'MultiPolygon'].includes(g?.type))
      throw new Error('Use points, lines or polygons.');
    const rings =
      g.type === 'Polygon'
        ? g.coordinates
        : g.type === 'MultiPolygon'
          ? g.coordinates.flat()
          : [];
    const positions =
      g.type === 'Point'
        ? [g.coordinates]
        : g.type === 'LineString'
          ? g.coordinates
          : rings.flat();
    if (!Array.isArray(positions) || !positions.length)
      throw new Error('Empty geometry.');
    for (const p of positions) {
      if (!Array.isArray(p) || !usBounds(p[0], p[1]))
        throw new Error(
          'Coordinates must be numeric longitude/latitude in the supported U.S. map bounds.',
        );
      if (++vertices > 20000)
        throw new Error('Geometry exceeds 20,000 vertices.');
    }
    if (
      g.type === 'LineString' &&
      (positions.length < 2 ||
        positions.every(
          (p) => p[0] === positions[0][0] && p[1] === positions[0][1],
        ))
    )
      throw new Error('A line needs two points.');
    for (const r of rings) {
      if (
        r.length < 4 ||
        r.length > 1000 ||
        r[0][0] !== r.at(-1)[0] ||
        r[0][1] !== r.at(-1)[1]
      )
        throw new Error(
          'Polygon rings must be closed and contain 4 to 1,000 vertices.',
        );
      for (let i = 0; i < r.length - 1; i++)
        for (let j = i + 2; j < r.length - 1; j++)
          if (crosses(r[i], r[i + 1], r[j], r[j + 1]))
            throw new Error(
              'Polygon edges cross. Repair the geometry before importing.',
            );
    }
    if (g.type === 'Polygon') {
      validatePolygon(g.coordinates);
      acres += polygonAcres(g.coordinates);
    }
    if (g.type === 'MultiPolygon')
      for (const poly of g.coordinates) {
        validatePolygon(poly);
        acres += polygonAcres(poly);
      }
    return {
      type: 'Feature',
      properties: {
        name: String(
          f.properties?.name || f.properties?.title || `Feature ${index + 1}`,
        ).slice(0, 150),
      },
      geometry: structuredClone(g),
    };
  });
  return {
    geojson: { type: 'FeatureCollection', features: cleaned },
    acres: Number(acres.toFixed(2)),
    count: cleaned.length,
  };
}

export function parseCsv(text) {
  if (text.length > IMPORT_MAX_BYTES)
    throw new Error('CSV must be smaller than 1 MB.');
  const rows = [];
  let row = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (quoted) throw new Error('CSV has an unclosed quoted field.');
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  if (rows.length < 2 || rows.length > 501)
    throw new Error('Use a header and 1 to 500 records.');
  const header = rows.shift().map((v) => v.trim().toLowerCase());
  if (new Set(header).size !== header.length)
    throw new Error('CSV headers must be unique.');
  return rows.map((r, i) => {
    if (r.length !== header.length)
      throw new Error(`Row ${i + 2} has the wrong number of columns.`);
    return Object.fromEntries(header.map((h, j) => [h, r[j].trim()]));
  });
}
export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
export function parseEvidenceCsv(text, type) {
  const rows = parseCsv(text),
    seen = new Set();
  return rows.map((r, i) => {
    if (!r.name || !validDate(r.as_of))
      throw new Error(`Row ${i + 2} needs name and as_of (YYYY-MM-DD).`);
    try {
      const url = new URL(r.source_url);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error();
    } catch {
      throw new Error(`Row ${i + 2} needs a valid source_url.`);
    }
    if (r.expected_date && !validDate(r.expected_date))
      throw new Error(`Row ${i + 2}: invalid expected_date.`);
    r.source_url = safeSourceUrl(r.source_url);
    const identity = [r.name, r.unit_type, r.as_of].join('|');
    if (seen.has(identity))
      throw new Error(`Duplicate record on row ${i + 2}.`);
    seen.add(identity);
    const number = (field, required = true) => {
      if (!r[field] && !required) return null;
      const v = Number(r[field]);
      if (!r[field] || !Number.isFinite(v) || v < 0)
        throw new Error(`Row ${i + 2}: ${field} must be a nonnegative number.`);
      return v;
    };
    if (type === 'comps') {
      const rent = number('asking_rent'),
        months = number('lease_months'),
        concession = number('concession_total', false) || 0;
      if (!(months > 0) || concession > rent * months)
        throw new Error(`Row ${i + 2}: check lease term and concessions.`);
      return {
        ...r,
        asking_rent: rent,
        lease_months: months,
        concession_total: concession,
        effective_rent: Number((rent - concession / months).toFixed(2)),
      };
    }
    if (
      !['proposed', 'permitted', 'under construction', 'delivered'].includes(
        r.stage,
      )
    )
      throw new Error(
        `Row ${i + 2}: stage must be proposed, permitted, under construction, or delivered.`,
      );
    const units = number('units');
    if (!Number.isInteger(units))
      throw new Error(`Row ${i + 2}: units must be a whole number.`);
    return { ...r, units };
  });
}

function validatePolygon(rings) {
  const inside = (p, ring) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i],
        b = ring[j];
      if (
        a[1] > p[1] !== b[1] > p[1] &&
        p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
      )
        hit = !hit;
    }
    return hit;
  };
  const orient = (a, b, c) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const on = (a, b, p) =>
    Math.abs(orient(a, b, p)) < 1e-12 &&
    p[0] >= Math.min(a[0], b[0]) &&
    p[0] <= Math.max(a[0], b[0]) &&
    p[1] >= Math.min(a[1], b[1]) &&
    p[1] <= Math.max(a[1], b[1]);
  const touch = (a, b, c, d) =>
    crosses(a, b, c, d) ||
    on(a, b, c) ||
    on(a, b, d) ||
    on(c, d, a) ||
    on(c, d, b);
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i],
        b = ring[i + 1],
        c = ring[(i + 2) % (ring.length - 1)];
      if (a[0] === b[0] && a[1] === b[1])
        throw new Error('Polygon has a zero-length edge.');
      if (
        Math.abs(orient(a, b, c)) < 1e-12 &&
        (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0
      )
        throw new Error('Polygon edges overlap or backtrack.');
      for (let j = i + 2; j < ring.length - 1; j++) {
        if (i === 0 && j === ring.length - 2) continue;
        if (touch(a, b, ring[j], ring[j + 1]))
          throw new Error('Polygon edges intersect or overlap.');
      }
    }
  }
  for (let h = 1; h < rings.length; h++) {
    if (!rings[h].slice(0, -1).every((p) => inside(p, rings[0])))
      throw new Error('Polygon hole lies outside the outer boundary.');
    for (let j = 0; j < h; j++) {
      if (
        j > 0 &&
        (inside(rings[h][0], rings[j]) || inside(rings[j][0], rings[h]))
      )
        throw new Error('Polygon holes overlap.');
      for (let a = 0; a < rings[h].length - 1; a++)
        for (let b = 0; b < rings[j].length - 1; b++)
          if (touch(rings[h][a], rings[h][a + 1], rings[j][b], rings[j][b + 1]))
            throw new Error('Polygon boundaries intersect.');
    }
  }
}

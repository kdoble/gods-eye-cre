// Local, versioned candidate snapshots. No account or remote storage is used.
import { validateSectionResult } from './contract.js';
import { usBounds, parseOverlay } from './imports.js';
import { validResearchSnapshot } from './reportEvidence.js';

export const WORKSPACE_KEY = 'gods-eye-cre.workspace.v1';
export const MAX_CANDIDATES = 5;
export const MAX_IMPORTS = 10;

export function assertImportCapacity(imports) {
  if (imports.length >= MAX_IMPORTS)
    throw new Error(
      `A site can hold at most ${MAX_IMPORTS} imports. Export existing evidence before adding more.`,
    );
}
export const MAX_WORKSPACE_BYTES = 3_500_000;
export const MAX_SNAPSHOT_OVERLAY_VERTICES = 100_000;
const MAX_SNAPSHOT_OVERLAY_FEATURES = 10_000;

export { safeSourceUrl } from './sourceUrls.js';
import { safeSourceUrl } from './sourceUrls.js';

/** Structural GeoJSON guard for restored source overlays. Unlike user imports,
 * source shapes skip acreage and intersection calculations; this only bounds
 * their nesting, coordinate counts and WGS84 positions before Cesium sees them.
 */
function validOverlayGeojson(geojson, budget, depth = 0) {
  if (
    !geojson ||
    typeof geojson !== 'object' ||
    Array.isArray(geojson) ||
    depth > 8
  )
    return false;
  const position = (p) => {
    if (
      !Array.isArray(p) ||
      (p.length !== 2 && p.length !== 3) ||
      !Number.isFinite(p[0]) ||
      !Number.isFinite(p[1]) ||
      Math.abs(p[0]) > 180 ||
      Math.abs(p[1]) > 90 ||
      (p.length === 3 && !Number.isFinite(p[2]))
    )
      return false;
    budget.vertices += 1;
    return budget.vertices <= MAX_SNAPSHOT_OVERLAY_VERTICES;
  };
  const positions = (value, min = 1) =>
    Array.isArray(value) && value.length >= min && value.every(position);
  const line = (value) => positions(value, 2);
  const ring = (value) =>
    Array.isArray(value) &&
    value.length >= 4 &&
    value[0]?.[0] === value.at(-1)?.[0] &&
    value[0]?.[1] === value.at(-1)?.[1] &&
    (value[0]?.length !== 3 || value[0]?.[2] === value.at(-1)?.[2]) &&
    positions(value, 4);
  const polygon = (value) =>
    Array.isArray(value) && value.length > 0 && value.every(ring);
  switch (geojson.type) {
    case 'FeatureCollection':
      return (
        Array.isArray(geojson.features) &&
        geojson.features.length <= MAX_SNAPSHOT_OVERLAY_FEATURES &&
        geojson.features.every((feature) =>
          validOverlayGeojson(feature, budget, depth + 1),
        )
      );
    case 'Feature':
      return (
        (geojson.geometry === null ||
          validOverlayGeojson(geojson.geometry, budget, depth + 1)) &&
        (geojson.properties === undefined ||
          geojson.properties === null ||
          (typeof geojson.properties === 'object' &&
            !Array.isArray(geojson.properties)))
      );
    case 'GeometryCollection':
      return (
        Array.isArray(geojson.geometries) &&
        geojson.geometries.length <= MAX_SNAPSHOT_OVERLAY_FEATURES &&
        geojson.geometries.every((geometry) =>
          validOverlayGeojson(geometry, budget, depth + 1),
        )
      );
    case 'Point':
      return position(geojson.coordinates);
    case 'MultiPoint':
      return positions(geojson.coordinates);
    case 'LineString':
      return line(geojson.coordinates);
    case 'MultiLineString':
      return (
        Array.isArray(geojson.coordinates) &&
        geojson.coordinates.length > 0 &&
        geojson.coordinates.every(line)
      );
    case 'Polygon':
      return polygon(geojson.coordinates);
    case 'MultiPolygon':
      return (
        Array.isArray(geojson.coordinates) &&
        geojson.coordinates.length > 0 &&
        geojson.coordinates.every(polygon)
      );
    default:
      return false;
  }
}

export function mapLinks(site) {
  if (!Number.isFinite(site?.lat) || !Number.isFinite(site?.lon)) return {};
  const point = encodeURIComponent(`${site.lat},${site.lon}`);
  return {
    street: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${point}`,
    map: `https://www.google.com/maps/search/?api=1&query=${point}`,
    directions: `https://www.google.com/maps/dir/?api=1&destination=${point}`,
  };
}

export function validCandidate(item) {
  try {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !item.id ||
      item.id.length > 100 ||
      item.schema !== 'gods-eye-cre/dossier@1' ||
      !usBounds(item.site?.lon, item.site?.lat) ||
      typeof item.site.address !== 'string' ||
      item.site.address.length > 1000 ||
      !Number.isFinite(Date.parse(item.generatedAt)) ||
      ![1, 3, 5].includes(item.radiusMiles ?? 1) ||
      !Array.isArray(item.sections) ||
      item.sections.length > 30 ||
      (item.imports &&
        (!Array.isArray(item.imports) || item.imports.length > MAX_IMPORTS))
    )
      return false;
    if (
      item.role !== undefined &&
      !['investor', 'developer'].includes(item.role)
    )
      return false;
    if (
      !validResearchSnapshot(item.research, {
        ...item.site,
        radiusMiles: item.radiusMiles || 1,
      })
    )
      return false;
    const overlayBudget = { vertices: 0 };
    for (const section of [...item.sections, ...(item.imports || [])]) {
      validateSectionResult(section);
      for (const overlay of section.overlays || [])
        if (!validOverlayGeojson(overlay.geojson, overlayBudget)) return false;
      if (section.id === 'imports')
        for (const overlay of section.overlays || [])
          parseOverlay(JSON.stringify(overlay.geojson));
    }
    if (
      item.analyst &&
      (typeof item.analyst !== 'object' ||
        Array.isArray(item.analyst) ||
        Object.values(item.analyst).some(
          (v) => typeof v !== 'string' || v.length > 3000,
        ))
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

export function createWorkspace(storage) {
  let candidates = [];
  let problem = '';
  try {
    const raw = storage?.getItem(WORKSPACE_KEY);
    if (raw && raw.length > MAX_WORKSPACE_BYTES) throw new Error();
    const saved = raw ? JSON.parse(raw) : null;
    if (
      saved &&
      (saved.version !== 1 ||
        !Array.isArray(saved.candidates) ||
        saved.candidates.length > MAX_CANDIDATES ||
        !saved.candidates.every(validCandidate))
    )
      throw new Error();
    candidates = saved?.candidates || [];
  } catch {
    problem =
      'Saved sites could not be read. Existing storage was left intact. Export a backup before clearing browser data.';
  }
  function write(next) {
    if (problem)
      throw new Error(
        'Existing saved data could not be read. Back up or clear the invalid workspace in browser settings before saving. No stored data was replaced.',
      );
    if (!storage)
      throw new Error(
        'Browser storage is unavailable. Export your report to keep a copy.',
      );
    const serialized = JSON.stringify({ version: 1, candidates: next });
    if (serialized.length > MAX_WORKSPACE_BYTES)
      throw new Error(
        'Saved sites exceed the local storage limit. Export a backup and remove a site.',
      );
    try {
      storage.setItem(WORKSPACE_KEY, serialized);
    } catch {
      throw new Error(
        'Could not save locally. Storage may be full or blocked. Export a backup.',
      );
    }
    candidates = next;
  }
  return {
    get problem() {
      return problem;
    },
    list: () => structuredClone(candidates),
    save(doc, id) {
      if (id === undefined) {
        const crypto = globalThis.crypto;
        id =
          crypto && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `site-${Date.now()}`;
      }
      const candidate = structuredClone({ ...doc, id });
      if (!validCandidate(candidate))
        throw new Error(
          'This site snapshot is incomplete and cannot be saved.',
        );
      const index = candidates.findIndex((x) => x.id === id);
      if (index < 0 && candidates.length >= MAX_CANDIDATES)
        throw new Error(
          'You can keep five sites. Export a backup or remove one before saving another.',
        );
      const next = [...candidates];
      if (index < 0) next.push(candidate);
      else next[index] = candidate;
      write(next);
      return id;
    },
    remove(id) {
      write(candidates.filter((x) => x.id !== id));
    },
    importBackup(input) {
      if (typeof input !== 'string' || input.length > MAX_WORKSPACE_BYTES)
        throw new Error('Backup is too large.');
      const data = JSON.parse(input);
      if (
        data.schema !== 'gods-eye-cre/candidates@1' ||
        !Array.isArray(data.candidates) ||
        !data.candidates.every(validCandidate)
      )
        throw new Error('Choose a Gods Eye CRE candidate backup.');
      const merged = new Map(candidates.map((x) => [x.id, x]));
      for (const item of data.candidates) {
        if (merged.has(item.id)) continue;
        merged.set(item.id, item);
      }
      if (merged.size > MAX_CANDIDATES)
        throw new Error(
          'The combined backup has more than five sites. Remove a site first.',
        );
      write([...merged.values()]);
    },
  };
}

/** Selection follows explicit user order, not array/storage order. */
export function selectedCandidates(candidates, ids) {
  const byId = new Map(candidates.map((x) => [x.id, x]));
  return [...new Set(ids)].map((id) => byId.get(id)).filter(Boolean);
}

export function candidateBackup(candidates) {
  return {
    schema: 'gods-eye-cre/candidates@1',
    exportedAt: new Date().toISOString(),
    candidates,
  };
}

export function csvCell(value) {
  const text = String(value ?? '');
  const safe =
    /^[\s]*[=+@-]/.test(text) && typeof value !== 'number' ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function comparisonCsv(candidates) {
  const rows = [
    [
      'Site',
      'Latitude',
      'Longitude',
      'Radius miles',
      'Snapshot',
      'Section',
      'Status',
      'Metric',
      'Value',
      'Unit',
      'Note',
      'Source',
      'Fetched',
    ],
  ];
  for (const candidate of candidates)
    for (const section of candidate.sections) {
      for (const item of section.values?.length
        ? section.values
        : [
            {
              label: 'Source availability',
              value: section.message || section.status,
            },
          ]) {
        rows.push([
          candidate.site.address,
          candidate.site.lat,
          candidate.site.lon,
          candidate.radiusMiles || 1,
          candidate.generatedAt,
          section.label,
          section.status,
          item.label,
          item.value,
          item.unit,
          item.note,
          safeSourceUrl(section.credit?.url),
          section.retrievedAt,
        ]);
      }
    }
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export function downloadText(
  text,
  name,
  type = 'application/json',
  doc = globalThis.document,
) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  a.hidden = true;
  doc.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

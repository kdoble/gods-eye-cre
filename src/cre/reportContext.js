// Asset-free geographic context for reports. Coordinates are projected locally;
// this shows returned source geometry, never a parcel survey or aerial image.
import { MAP_COLORS } from './mapColors.js';
import { categoryGlyphFor } from './brandMarks.js';
import { brandMarkFor } from './localBrandMarks.js';
import {
  mapLayerForFeature,
  mapLayerVisible,
  namedLabelLimit,
  crimeMapFeatures,
} from './mapSelection.js';
/**
 * A user-supplied local-brand-mark URL (e.g. `/api/cre/local-brand-marks/
 * kroger.png`) is root-relative, which resolves fine in the live app but not
 * inside the printed report: `openPrintPage` (printPage.js) opens that HTML
 * from a `blob:` URL, and a `blob:` document has an opaque path, so a
 * root-relative `<image href>` cannot resolve there and silently fetches
 * nothing (an empty box where the user's own logo should be). Resolve it
 * against the app's own origin here, at map-SVG build time, so the href
 * embedded into the report is always absolute. Falls back to the original
 * (root-relative) value when there is no browser `location` to resolve
 * against, e.g. under Node's test runner.
 * @param {string} url
 */
const absoluteBrandMarkUrl = (url) => {
  const origin = globalThis.location?.origin;
  if (!origin) return url;
  try {
    return new URL(url, origin).href;
  } catch {
    return url;
  }
};
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c],
  );
const COLORS = {
  roads: '#925308',
  crime: '#9d174d',
  parcel: '#087653',
  zoning: '#4338ca',
  access: '#3554a5',
  hazards: '#1d4ed8',
  flood: MAP_COLORS.flood,
  'hazards-sfha': '#1d4ed8',
  'hazards-wetlands': '#0f766e',
  'hazards-epa-sites': '#c2410c',
  destinations: '#155e75',
  schools: MAP_COLORS.school,
  retail: MAP_COLORS.retail,
  coffee: MAP_COLORS.coffee,
  parks: MAP_COLORS.parks,
  attractions: MAP_COLORS.attractions,
  restaurants: MAP_COLORS.restaurants,
  amenities: MAP_COLORS.amenities,
  routes: MAP_COLORS.routes,
  employers: MAP_COLORS.employers,
  incentives: MAP_COLORS.zones,
  jobs: MAP_COLORS.jobCluster,
  cameras: MAP_COLORS.camera,
  imports: MAP_COLORS.imports,
};

export function buildReportContext(doc) {
  const lat = doc.site?.lat,
    lon = doc.site?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  const miles = [1, 3, 5].includes(doc.radiusMiles) ? doc.radiusMiles : 1;
  const radius = miles * 1609.344;
  const selection = doc.mapSelection || null;
  const labelDensity = selection?.labelDensity || 'key';
  let namedShown = 0;
  let namedHidden = 0;
  const labelCounts = new Map();
  // Keep labels clear of the selected site pin, including its white outline.
  const labelBoxes = [{ left: 239, top: 171, right: 301, bottom: 244 }];
  const labelShapes = [];
  const placedNames = new Set();
  function placeLabel(point, rawName) {
    const fullName = String(rawName).trim();
    if (!fullName || placedNames.has(fullName.toLowerCase())) return null;
    const label =
      fullName.length > 32 ? `${fullName.slice(0, 31).trimEnd()}…` : fullName;
    const width = Math.min(215, label.length * 6.5 + 6);
    const x = Number(point[0]),
      y = Number(point[1]);
    const positions = [
      [x + 9, y - 8],
      [x + 9, y + 16],
      [x - width - 9, y - 8],
      [x - width - 9, y + 16],
      [x + 9, y - 25],
      [x + 9, y + 33],
      [x - width - 9, y - 25],
      [x - width - 9, y + 33],
      [x + 18, y - 52],
      [x - width - 18, y - 52],
      [x + 18, y + 58],
      [x - width - 18, y + 58],
      [x + 42, y - 38],
      [x - width - 42, y + 44],
    ];
    for (const [left, baseline] of positions) {
      const box = {
        left,
        top: baseline - 11,
        right: left + width,
        bottom: baseline + 4,
      };
      if (box.left < 10 || box.right > 590 || box.top < 10 || box.bottom > 430)
        continue;
      if (
        labelBoxes.some(
          (other) =>
            box.left < other.right + 3 &&
            box.right + 3 > other.left &&
            box.top < other.bottom + 3 &&
            box.bottom + 3 > other.top,
        )
      )
        continue;
      labelBoxes.push(box);
      placedNames.add(fullName.toLowerCase());
      return `<text x="${left.toFixed(1)}" y="${baseline.toFixed(1)}" font-size="10" font-family="Arial, sans-serif" fill="#172b38" stroke="#fff" stroke-width="3" paint-order="stroke">${escape(label)}</text>`;
    }
    return null;
  }
  const project = (p) => {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
      return null;
    const x =
      270 +
      (((p[0] - lon) * 111320 * Math.cos((lat * Math.PI) / 180)) / radius) *
        180;
    const y = 220 - (((p[1] - lat) * 111320) / radius) * 180;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      Math.abs(x) > 1e6 ||
      Math.abs(y) > 1e6
    )
      return null;
    return [x.toFixed(1), y.toFixed(1)];
  };
  const shapes = [],
    used = new Map();
  let vertices = 0,
    features = 0;
  function geometry(
    g,
    color,
    name = '',
    named = false,
    layerId = '',
    densityCount = 0,
  ) {
    if (!g || vertices > 8000 || features++ > 500) return;
    if (g.type === 'Point') {
      const p = project(g.coordinates);
      vertices++;
      if (
        p &&
        Number(p[0]) >= 8 &&
        Number(p[0]) <= 592 &&
        Number(p[1]) >= 8 &&
        Number(p[1]) <= 432
      ) {
        const brand = named ? brandMarkFor(name) : null;
        const glyph = named && !brand ? categoryGlyphFor(layerId) : null;
        if (densityCount)
          shapes.push(
            `<circle cx="${p[0]}" cy="${p[1]}" r="${Math.min(17, 7 + Math.log2(1 + densityCount) * 2).toFixed(1)}" fill="${color}" fill-opacity="0.65" stroke="#fff" stroke-width="1.5"/><text x="${p[0]}" y="${(Number(p[1]) + 3.5).toFixed(1)}" text-anchor="middle" font-size="10" font-family="Arial, sans-serif" font-weight="700" fill="#fff">${densityCount}</text>`,
          );
        else if (brand?.overrideUrl)
          // A user-supplied local file (local-brand-marks/), referenced by
          // URL only -- never the file's raw bytes pasted into this SVG.
          shapes.push(
            `<image data-chain-label="${escape(brand.name)}" href="${escape(absoluteBrandMarkUrl(brand.overrideUrl))}" x="${(Number(p[0]) - 10).toFixed(1)}" y="${(Number(p[1]) - 10).toFixed(1)}" width="20" height="20"/>`,
          );
        else if (brand)
          shapes.push(
            `<circle cx="${p[0]}" cy="${p[1]}" r="10" fill="#455568" stroke="${color}" stroke-width="2"/><text data-chain-label="${escape(brand.name)}" x="${p[0]}" y="${(Number(p[1]) + 3).toFixed(1)}" text-anchor="middle" font-size="9" font-family="Arial, sans-serif" fill="#fff">${escape(brand.initials)}</text>`,
          );
        else if (glyph)
          shapes.push(
            `<circle cx="${p[0]}" cy="${p[1]}" r="9" fill="${color}" stroke="#fff" stroke-width="1"/><text x="${p[0]}" y="${(Number(p[1]) + 3.5).toFixed(1)}" text-anchor="middle" font-size="10" font-family="Arial, sans-serif" font-weight="700" fill="#fff">${escape(glyph)}</text>`,
          );
        else
          shapes.push(
            `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="${color}" stroke="#fff" stroke-width="1"/>`,
          );
        if (named && name) {
          const rank = (labelCounts.get(layerId) || 0) + 1;
          labelCounts.set(layerId, rank);
          if (rank <= namedLabelLimit(labelDensity)) {
            const label = placeLabel(p, name);
            if (label) {
              labelShapes.push(
                `<g data-cre-map-layer="${escape(layerId)}" data-cre-map-label="${escape(layerId)}">${label}</g>`,
              );
              namedShown++;
            } else namedHidden++;
          } else namedHidden++;
        }
      }
    } else if (
      ['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'].includes(
        g.type,
      )
    ) {
      const lines =
        g.type === 'LineString'
          ? [g.coordinates]
          : g.type === 'MultiPolygon'
            ? g.coordinates?.flat()
            : g.coordinates;
      if (!Array.isArray(lines)) return;
      for (const line of lines.slice(0, 100)) {
        if (!Array.isArray(line) || vertices > 8000) continue;
        const step = Math.max(1, Math.ceil(line.length / 160));
        const points = line
          .filter((_, i) => i % step === 0 || i === line.length - 1)
          .map(project)
          .filter(Boolean);
        vertices += points.length;
        if (points.length > 1)
          shapes.push(
            `<polyline points="${points.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="1.4"/>`,
          );
      }
    }
  }
  const entries = [];
  const usedSources = new Map();
  for (const section of doc.sections || [])
    for (const overlay of section.overlays || []) {
      const geo = overlay.geojson;
      const rawList =
        geo?.type === 'FeatureCollection' ? geo.features || [] : [geo];
      const list =
        overlay.id === 'crime' ? crimeMapFeatures(rawList, selection) : rawList;
      for (const feature of list) {
        const id = mapLayerForFeature(
          section.id,
          overlay.id,
          feature?.properties,
        );
        if (!mapLayerVisible(selection, id)) continue;
        const color = COLORS[id] || COLORS[overlay.id] || COLORS[section.id];
        if (!color) continue;
        entries.push({ section, id, color, feature, overlayId: overlay.id });
      }
    }
  // Preserve decision-relevant named points if a large incident feed consumes
  // the bounded schematic budget. The cap is disclosed below.
  entries.sort(
    (a, b) =>
      Number(b.feature?.properties?.named === true) -
      Number(a.feature?.properties?.named === true),
  );
  const omittedFeatures = Math.max(0, entries.length - 500);
  for (const { section, id, color, feature, overlayId } of entries.slice(
    0,
    500,
  )) {
    const before = shapes.length;
    geometry(
      feature?.type === 'Feature' ? feature.geometry : feature,
      color,
      String(feature?.properties?.name || ''),
      feature?.properties?.named === true,
      id,
      feature?.properties?.densityCell ? Number(feature.properties.count) : 0,
    );
    if (shapes.length > before) {
      shapes.splice(
        before,
        shapes.length - before,
        `<g data-cre-map-layer="${escape(id)}" data-source-overlay="${escape(overlayId)}">${shapes.slice(before).join('')}</g>`,
      );
      used.set(id, color);
      usedSources.set(section.id, section);
    }
  }
  const scaleMiles = miles === 1 ? 0.25 : 1;
  const scalePx = (180 * scaleMiles) / miles;
  const legend = [...used]
    .map(
      ([id, color]) =>
        `<span style="display:inline-block;margin-right:10px"><b style="color:${color}">■</b> ${escape(id)}</span>`,
    )
    .join(' ');
  const dates = [
    ...new Set(
      [...usedSources.values()].map((section) => {
        const evidence = section.evidence || {};
        const observed = [
          evidence.crime?.recordDate,
          evidence.zoning?.recordDate,
          evidence.boundaryCheckedAt,
          evidence.flood?.panelEffectiveDate,
        ]
          .filter(Boolean)
          .join(', ');
        const stale = section.jurisdiction?.stale || evidence.boundaryStale;
        return `${section.credit?.text || section.label || section.id}: retrieved ${section.retrievedAt || 'unknown'}; observation ${observed || 'date unknown'}${stale ? '; boundary stale' : ''}`;
      }),
    ),
  ]
    .map(escape)
    .join('; ');
  const truncated = namedHidden || omittedFeatures || vertices > 8000;
  const crimeNote =
    selection?.crimeMode === 'density' && used.has('crime')
      ? 'Crime circles show counts of mapped reported offense records in fixed cells, not a population-adjusted rate or prediction. '
      : '';
  const floodNote =
    used.has('flood') &&
    [...usedSources.values()].some(
      (section) => section.evidence?.flood?.floodMapRecordDate == null,
    )
      ? 'FEMA polygon observation date was not supplied; panel effective date is listed when known. '
      : '';
  return `<figure class="context-map"><svg role="img" aria-label="Selected source geometry within ${miles} mile study radius" viewBox="0 0 600 470" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="report-map-clip"><rect x="8" y="8" width="584" height="424"/></clipPath></defs><rect x="8" y="8" width="584" height="424" fill="#f6f8fa" stroke="#c6d0d9"/><g clip-path="url(#report-map-clip)">${shapes.join('')}<circle cx="270" cy="220" r="180" stroke="#516578" stroke-dasharray="4 4" fill="none"/><path d="M270 200 287 232H253Z" fill="#e11d48" stroke="#fff" stroke-width="3" stroke-linejoin="round"/><text x="270" y="190" text-anchor="middle" font-size="12" font-family="Arial, sans-serif" font-weight="800" fill="#7f1d1d" stroke="#fff" stroke-width="3" paint-order="stroke">SITE</text>${labelShapes.join('')}</g><text x="548" y="31" font-size="15" fill="#172b38">N ↑</text><line x1="20" y1="409" x2="${(20 + scalePx).toFixed(1)}" y2="409" stroke="#172b38" stroke-width="3"/><text x="20" y="426" font-size="11" fill="#172b38">${scaleMiles} mile${scaleMiles === 1 ? '' : 's'}</text><text x="18" y="456" font-size="11" fill="#374151">Dashed ring: ${miles} mile${miles === 1 ? '' : 's'} around selected location.</text></svg><figcaption>${shapes.length ? `Selected geometry: ${legend}.` : 'No selected source geometry was available for this snapshot.'} ${truncated ? `Map detail was capped for legibility (${namedHidden} names and ${omittedFeatures} features omitted). ` : ''}${crimeNote}${floodNote}Geometry-only map. Selected source retrieval and observation dates: ${dates || 'not provided'}. Rectangular export extent surrounds the selected study ring; features outside the dashed ring may appear. This preview defines the exported crop. This is not the live camera viewport. This is not an aerial image or survey.</figcaption></figure>`;
}

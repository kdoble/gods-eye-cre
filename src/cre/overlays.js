// Draws the site pin, the 1, 3 and 5 mile rings, and any section overlays into one Cesium CustomDataSource that is cleared on the next search.
import { METERS_PER_MILE, RING_MILES } from './config.js';
import { ringPolygon } from './geo.js';
import { MAP_COLORS } from './mapColors.js';
import {
  crimeMapFeatures,
  mapLayerForFeature,
  namedLabelLimit,
} from './mapSelection.js';
import { categoryIconImage } from './brandMarks.js';
import { brandMarkFor } from './localBrandMarks.js';

export const OVERLAY_SOURCE_NAME = 'cre-dossier';
export const RING_STEPS = 64;

const RING_COLOR = MAP_COLORS.ring;
export const SITE_MARKER_IMAGE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><path d="M20 3 37 35H3Z" fill="#e11d48" stroke="#fff" stroke-width="3" stroke-linejoin="round"/><path d="M20 12 29 30H11Z" fill="#831843"/></svg>')}`;
const DEFAULT_STROKE = '#38bdf8';

/**
 * Section fills stay a faint tint so the satellite imagery under them reads
 * as imagery. A shape that contains the site gets no fill at all: the site
 * and its blocks are what the user came to see.
 */
export const FILL_ALPHA = 0.08;

/**
 * Ray-casting point-in-ring test on [lon, lat] pairs.
 * @param {number} lon @param {number} lat
 * @param {Array<[number, number]>} ring
 */
export function ringContains(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

/**
 * Fill for one polygon: none when it covers the site, else the faint tint.
 * @param {{kind:string, coords:Array}} shape
 * @param {{fill?:string}|undefined} style
 * @param {{lat:number, lon:number}|null} site
 * @returns {number|null} Fill alpha, or null for outline only.
 */
export function fillAlphaFor(shape, style, site) {
  if (shape.kind !== 'polygon' || !style?.fill) return null;
  if (site && ringContains(site.lon, site.lat, shape.coords)) return null;
  return FILL_ALPHA;
}

/**
 * Ring polygons around the site, smallest first, each with RING_STEPS vertices
 * (plus the closing vertex) and a `miles` property.
 * @param {number} lat @param {number} lon
 */
export function siteRingFeatures(lat, lon, miles = RING_MILES) {
  return miles.map((mi) =>
    ringPolygon(lat, lon, mi * METERS_PER_MILE, {
      steps: RING_STEPS,
      properties: { miles: mi },
    }),
  );
}

/**
 * Flatten GeoJSON (Feature, FeatureCollection, or bare geometry) into simple
 * shapes: { kind: 'polygon'|'line'|'point', coords }. Holes are ignored; the
 * outline is what the globe needs.
 * @param {object} geojson
 */
export function flattenGeojson(geojson) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FeatureCollection') {
      (node.features || []).forEach(visit);
    } else if (node.type === 'Feature') {
      const start = out.length;
      visit(node.geometry);
      for (let i = start; i < out.length; i++)
        Object.assign(out[i], {
          name: String(node.properties?.name || '').slice(0, 150),
          named: node.properties?.named === true,
          category: node.properties?.category,
          count: node.properties?.count,
          densityCell: node.properties?.densityCell === true,
          profile: node.properties?.profile,
        });
    } else if (node.type === 'GeometryCollection') {
      (node.geometries || []).forEach(visit);
    } else if (node.type === 'Polygon') {
      if (node.coordinates?.[0]?.length >= 4)
        out.push({
          kind: 'polygon',
          coords: node.coordinates[0],
          holes: node.coordinates.slice(1),
        });
    } else if (node.type === 'MultiPolygon') {
      for (const poly of node.coordinates || [])
        if (poly?.[0]?.length >= 4)
          out.push({ kind: 'polygon', coords: poly[0], holes: poly.slice(1) });
    } else if (node.type === 'LineString') {
      if (node.coordinates?.length >= 2)
        out.push({ kind: 'line', coords: node.coordinates });
    } else if (node.type === 'MultiLineString') {
      for (const line of node.coordinates || [])
        if (line?.length >= 2) out.push({ kind: 'line', coords: line });
    } else if (node.type === 'Point') {
      if (node.coordinates?.length >= 2)
        out.push({ kind: 'point', coords: node.coordinates });
    } else if (node.type === 'MultiPoint') {
      for (const point of node.coordinates || [])
        if (point?.length >= 2) out.push({ kind: 'point', coords: point });
    }
  };
  visit(geojson);
  return out.filter((shape) =>
    (shape.kind === 'point' ? [shape.coords] : shape.coords).every(
      (pair) => Number.isFinite(pair?.[0]) && Number.isFinite(pair?.[1]),
    ),
  );
}

/**
 * Create the overlay owner. Cesium is injected so the pure helpers above stay
 * testable in Node.
 * @param {{viewer: object, Cesium: object, requestRender?: () => void}} deps
 */
export function createDossierOverlays({ viewer, Cesium, requestRender }) {
  // Pin and rings in one source, section shapes in another, so the section
  // shapes can be hidden without losing the site.
  const source = new Cesium.CustomDataSource(OVERLAY_SOURCE_NAME);
  const sectionSource = new Cesium.CustomDataSource(
    `${OVERLAY_SOURCE_NAME}-sections`,
  );
  let site = null;
  let attached = false;
  const attach = () => {
    if (attached) return;
    attached = true;
    void viewer.dataSources.add(sectionSource);
    void viewer.dataSources.add(source);
  };
  const render = () => {
    if (requestRender) requestRender();
    else viewer.scene?.requestRender?.();
  };
  const color = (css, alpha = 1) =>
    Cesium.Color.fromCssColorString(css).withAlpha(alpha);
  const positions = (coords) =>
    coords.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));

  let labelDensity = 'key';
  let crimeSelection = { crimeMode: 'incidents', crimeCategory: 'all' };
  const namedLabels = [];
  const labelCounts = new Map();
  const labelVisible = (rank) => rank <= namedLabelLimit(labelDensity);

  const addShape = (shape, style, id, layerId) => {
    const stroke = color(style?.stroke || DEFAULT_STROKE);
    if (shape.kind === 'point') {
      const rank = (labelCounts.get(layerId) || 0) + 1;
      if (shape.named && shape.name) labelCounts.set(layerId, rank);
      const brand = shape.named ? brandMarkFor(shape.name) : null;
      const density = shape.densityCell === true;
      const categoryImage =
        shape.named && !brand
          ? categoryIconImage(layerId, style?.stroke)
          : null;
      const entity = sectionSource.entities.add({
        id,
        name: shape.name || 'Mapped feature',
        position: Cesium.Cartesian3.fromDegrees(
          shape.coords[0],
          shape.coords[1],
        ),
        point:
          brand || categoryImage
            ? undefined
            : {
                pixelSize: density
                  ? Math.min(32, 13 + Math.log2(1 + shape.count) * 3)
                  : 8,
                color: stroke,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 1.5,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
        billboard:
          brand || categoryImage
            ? {
                image: brand?.image || categoryImage,
                width: brand ? 26 : 22,
                height: brand ? 26 : 22,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              }
            : undefined,
        label:
          density || (shape.named && shape.name && rank <= 80)
            ? {
                text: density ? String(shape.count) : shape.name,
                show: density || labelVisible(rank),
                font: '600 12px system-ui, sans-serif',
                fillColor: Cesium.Color.WHITE,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 3,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                pixelOffset: new Cesium.Cartesian2(0, -15),
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              }
            : undefined,
      });
      if (entity.label && !density) namedLabels.push({ entity, rank });
      return;
    }
    const line = positions(shape.coords);
    sectionSource.entities.add({
      id,
      polyline: {
        positions: line,
        width: 2,
        material: stroke,
        clampToGround: true,
      },
    });
    for (const [index, hole] of (shape.holes || []).entries())
      sectionSource.entities.add({
        id: `${id}:hole-${index}`,
        polyline: {
          positions: positions(hole),
          width: 2,
          material: stroke,
          clampToGround: true,
        },
      });
    const alpha = fillAlphaFor(shape, style, site);
    if (alpha !== null) {
      sectionSource.entities.add({
        id: `${id}:fill`,
        polygon: {
          hierarchy: shape.holes?.length
            ? new Cesium.PolygonHierarchy(
                line,
                shape.holes.map(
                  (hole) => new Cesium.PolygonHierarchy(positions(hole)),
                ),
              )
            : line,
          material: color(style.fill, alpha),
          classificationType: Cesium.ClassificationType.TERRAIN,
        },
      });
    }
  };

  const layerEntities = new Map();
  const layerVisible = new Map();
  let count = 0;
  const nextId = (prefix) => `${OVERLAY_SOURCE_NAME}:${prefix}:${count++}`;

  return {
    source,
    sectionSource,
    setLayerVisible(id, visible) {
      layerVisible.set(id, Boolean(visible));
      for (const entity of layerEntities.get(id) || [])
        entity.show = Boolean(visible);
      render();
    },
    setLabelDensity(value) {
      labelDensity = ['key', 'all', 'off'].includes(value) ? value : 'key';
      for (const { entity, rank } of namedLabels)
        entity.label.show = labelVisible(rank);
      render();
    },
    setCrimeFilter(selection) {
      crimeSelection = {
        crimeMode: selection?.crimeMode || 'incidents',
        crimeCategory: selection?.crimeCategory || 'all',
      };
    },
    layerIds: () => [...layerEntities.keys()],
    /** Remove everything drawn for the previous site. */
    clear() {
      site = null;
      layerEntities.clear();
      namedLabels.length = 0;
      labelCounts.clear();
      source.entities.removeAll();
      sectionSource.entities.removeAll();
      render();
    },
    /** Show or hide the section shapes; the pin and rings stay. */
    setSectionsVisible(visible) {
      sectionSource.show = Boolean(visible);
      render();
    },
    /** Pin plus the 1, 3, 5 mile rings. */
    drawSite(lat, lon, label = '', radiusMiles = null) {
      attach();
      site = { lat, lon };
      source.entities.removeAll();
      sectionSource.entities.removeAll();
      layerEntities.clear();
      namedLabels.length = 0;
      labelCounts.clear();
      for (const ring of siteRingFeatures(
        lat,
        lon,
        radiusMiles ? [radiusMiles] : RING_MILES,
      )) {
        const coords = ring.geometry.coordinates[0];
        source.entities.add({
          id: nextId(`ring-${ring.properties.miles}mi`),
          polyline: {
            positions: positions(coords),
            width: 2,
            material: new Cesium.PolylineDashMaterialProperty({
              color: color(RING_COLOR, 0.95),
              dashLength: 14,
            }),
            clampToGround: true,
          },
        });
        // South vertex (vertices run clockwise from north): the search lands
        // looking north-northeast, so a north label floats at the top of the
        // screen under the header while a south one sits behind the camera.
        const labelAt = coords[Math.floor((coords.length - 1) / 2)];
        source.entities.add({
          id: nextId(`ring-label-${ring.properties.miles}mi`),
          position: Cesium.Cartesian3.fromDegrees(labelAt[0], labelAt[1]),
          label: {
            text: `${ring.properties.miles} mi`,
            font: '600 13px system-ui, sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }
      source.entities.add({
        id: nextId('site'),
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        billboard: {
          image: SITE_MARKER_IMAGE,
          width: 40,
          height: 40,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          verticalOrigin: Cesium.VerticalOrigin?.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: 'SITE',
          font: '600 14px system-ui, sans-serif',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -47),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      render();
    },
    /**
     * Draw the overlays one section returned.
     * @param {import('./contract.js').SectionResult} result
     */
    drawSection(result) {
      if (!result?.overlays?.length) return 0;
      attach();
      let drawn = 0;
      for (const overlay of result.overlays) {
        const rawFeatures =
          overlay.geojson?.type === 'FeatureCollection'
            ? overlay.geojson.features || []
            : [overlay.geojson];
        const features =
          overlay.id === 'crime'
            ? crimeMapFeatures(rawFeatures, crimeSelection)
            : rawFeatures;
        for (const feature of features) {
          const layerId = mapLayerForFeature(
            result.id,
            overlay.id,
            feature?.properties,
          );
          const startIndex = sectionSource.entities.values?.length || 0;
          for (const shape of flattenGeojson(feature)) {
            try {
              addShape(
                shape,
                {
                  ...overlay.style,
                  stroke: MAP_COLORS[layerId] || overlay.style?.stroke,
                },
                nextId(`${result.id}-${overlay.id}`),
                layerId,
              );
              drawn += 1;
            } catch (error) {
              console.warn(`[cre] overlay ${overlay.id} not drawn:`, error);
            }
          }
          const added = (sectionSource.entities.values || []).slice(startIndex);
          for (const entity of added)
            entity.show = layerVisible.get(layerId) !== false;
          layerEntities.set(layerId, [
            ...(layerEntities.get(layerId) || []),
            ...added,
          ]);
        }
      }
      if (drawn) render();
      return drawn;
    },
    destroy() {
      source.entities.removeAll();
      sectionSource.entities.removeAll();
      if (attached) {
        viewer.dataSources.remove(source, true);
        viewer.dataSources.remove(sectionSource, true);
      }
      attached = false;
      render();
    },
  };
}

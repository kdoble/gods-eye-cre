// Overlay tests: ring geometry accuracy (64 vertices, under 1 m radial error at 1 mile), GeoJSON flattening, and one data source cleared per search.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  siteRingFeatures,
  flattenGeojson,
  createDossierOverlays,
  RING_STEPS,
  OVERLAY_SOURCE_NAME,
  fillAlphaFor,
  ringContains,
  FILL_ALPHA,
} from './overlays.js';
import { haversineMeters } from './geo.js';
import { METERS_PER_MILE } from './config.js';

const LAT = 36.320692;
const LON = -82.342509;

test('1 mile ring has 64 vertices with max radial error under 1 m', () => {
  const [one, three, five] = siteRingFeatures(LAT, LON);
  const ring = one.geometry.coordinates[0];
  assert.equal(ring.length, RING_STEPS + 1, '64 vertices plus closing vertex');
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  let maxError = 0;
  for (const [lon, lat] of ring.slice(0, -1)) {
    const error = Math.abs(
      haversineMeters(LAT, LON, lat, lon) - METERS_PER_MILE,
    );
    maxError = Math.max(maxError, error);
  }
  assert.ok(maxError < 1, `max radial error ${maxError} m`);
  assert.equal(one.properties.miles, 1);
  assert.equal(three.properties.miles, 3);
  assert.equal(five.properties.miles, 5);
});

test('flattenGeojson handles collections and drops broken coordinates', () => {
  const shapes = flattenGeojson({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
      },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 3] } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: ['x', 3] } },
      {
        type: 'Feature',
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [0, 0],
              [1, 1],
            ],
          ],
        },
      },
      null,
    ],
  });
  assert.deepEqual(
    shapes.map((s) => s.kind),
    ['polygon', 'point', 'line'],
  );
});

function fakeCesium() {
  class Collection {
    constructor() {
      this.values = [];
    }
    add(entity) {
      this.values.push(entity);
      return entity;
    }
    removeAll() {
      this.values = [];
    }
  }
  const color = { withAlpha: () => color };
  return {
    CustomDataSource: class {
      constructor(name) {
        this.name = name;
        this.entities = new Collection();
      }
    },
    Color: { fromCssColorString: () => color, WHITE: color, BLACK: color },
    Cartesian3: { fromDegrees: (lon, lat) => ({ lon, lat }) },
    Cartesian2: class {},
    PolylineDashMaterialProperty: class {},
    HeightReference: { CLAMP_TO_GROUND: 1 },
    LabelStyle: { FILL_AND_OUTLINE: 2 },
    ClassificationType: { BOTH: 2, TERRAIN: 0 },
  };
}

test('site source and section source: site draw replaces the previous site, sections add, clear empties', () => {
  const added = [];
  const viewer = {
    dataSources: {
      add: (s) => added.push(s),
      remove: () => true,
    },
  };
  let renders = 0;
  const overlays = createDossierOverlays({
    viewer,
    Cesium: fakeCesium(),
    requestRender: () => renders++,
  });
  overlays.drawSite(LAT, LON);
  const siteCount = overlays.source.entities.values.length;
  assert.equal(siteCount, 7, 'three rings, three labels, one pin');
  overlays.drawSite(33.77, -84.37);
  assert.equal(overlays.source.entities.values.length, siteCount);
  const drawn = overlays.drawSection({
    id: 'access',
    overlays: [
      {
        id: 'iso',
        geojson: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
        style: { stroke: '#123456', fill: '#123456' },
      },
    ],
  });
  assert.equal(drawn, 1);
  assert.equal(overlays.source.entities.values.length, siteCount);
  assert.equal(
    overlays.sectionSource.entities.values.length,
    2,
    'outline plus a faint fill: the shape does not contain the site',
  );
  assert.equal(added.length, 2);
  assert.deepEqual(
    added.map((s) => s.name).sort(),
    [OVERLAY_SOURCE_NAME, `${OVERLAY_SOURCE_NAME}-sections`].sort(),
  );
  overlays.setSectionsVisible(false);
  assert.equal(overlays.sectionSource.show, false);
  assert.ok(overlays.source.show !== false, 'the pin and rings stay');
  overlays.setSectionsVisible(true);
  assert.equal(overlays.sectionSource.show, true);
  overlays.clear();
  assert.equal(overlays.source.entities.values.length, 0);
  assert.equal(overlays.sectionSource.entities.values.length, 0);
  assert.ok(renders >= 4);
});

test('live reported offense density and category filter count the same selected rows', () => {
  const overlays = createDossierOverlays({
    viewer: { dataSources: { add: () => {}, remove: () => {} } },
    Cesium: fakeCesium(),
  });
  overlays.drawSite(LAT, LON, '', 1);
  overlays.setCrimeFilter({ crimeMode: 'density', crimeCategory: 'Burglary' });
  overlays.drawSection({
    id: 'neighborhood',
    overlays: [
      {
        id: 'crime',
        style: { stroke: '#9d174d' },
        geojson: {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { category: 'Burglary' },
              geometry: { type: 'Point', coordinates: [LON, LAT] },
            },
            {
              type: 'Feature',
              properties: { category: 'Burglary' },
              geometry: {
                type: 'Point',
                coordinates: [LON + 0.001, LAT + 0.001],
              },
            },
            {
              type: 'Feature',
              properties: { category: 'Assault' },
              geometry: { type: 'Point', coordinates: [LON, LAT] },
            },
          ],
        },
      },
    ],
  });
  assert.equal(overlays.sectionSource.entities.values.length, 1);
  assert.equal(overlays.sectionSource.entities.values[0].label.text, '2');
  assert.deepEqual(overlays.layerIds(), ['crime']);
});

test('retailer and category billboards are not covered by a Cesium point primitive', () => {
  const overlays = createDossierOverlays({
    viewer: { dataSources: { add: () => {}, remove: () => {} } },
    Cesium: fakeCesium(),
  });
  overlays.drawSite(LAT, LON, '', 1);
  overlays.drawSection({
    id: 'destinations',
    overlays: [
      {
        id: 'nearby',
        geojson: {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {
                name: 'Starbucks',
                named: true,
                category: 'coffee',
              },
              geometry: { type: 'Point', coordinates: [LON, LAT] },
            },
            {
              type: 'Feature',
              properties: {
                name: 'Local Cafe',
                named: true,
                category: 'coffee',
              },
              geometry: { type: 'Point', coordinates: [LON + 0.01, LAT] },
            },
          ],
        },
      },
    ],
  });
  const [brand, local] = overlays.sectionSource.entities.values;
  assert.equal(brand.point, undefined);
  assert.match(brand.billboard.image, /^data:image\/svg\+xml,/);
  assert.equal(local.point, undefined);
  assert.match(local.billboard.image, /^data:image\/svg\+xml,/);
});

test('live FEMA SFHA and other environmental features use distinct visibility groups', () => {
  const overlays = createDossierOverlays({
    viewer: { dataSources: { add: () => {}, remove: () => {} } },
    Cesium: fakeCesium(),
  });
  overlays.drawSite(LAT, LON, '', 1);
  overlays.drawSection({
    id: 'hazards',
    overlays: [
      {
        id: 'hazards-sfha',
        geojson: { type: 'Point', coordinates: [LON, LAT] },
        style: { stroke: '#1d4ed8' },
      },
      {
        id: 'hazards-wetlands',
        geojson: { type: 'Point', coordinates: [LON + 0.01, LAT] },
        style: { stroke: '#0f766e' },
      },
    ],
  });
  assert.deepEqual(overlays.layerIds(), ['flood', 'hazards']);
  overlays.setLayerVisible('hazards', false);
  assert.equal(overlays.sectionSource.entities.values[0].show, true);
  assert.equal(overlays.sectionSource.entities.values[1].show, false);
});

test('a section shape that contains the site is drawn as an outline only', () => {
  const overlays = createDossierOverlays({
    viewer: { dataSources: { add() {}, remove: () => true } },
    Cesium: fakeCesium(),
    requestRender() {},
  });
  overlays.drawSite(LAT, LON);
  const around = (d) => ({
    type: 'Polygon',
    coordinates: [
      [
        [LON - d, LAT - d],
        [LON + d, LAT - d],
        [LON + d, LAT + d],
        [LON - d, LAT + d],
        [LON - d, LAT - d],
      ],
    ],
  });
  overlays.drawSection({
    id: 'incentives',
    overlays: [
      {
        id: 'zones',
        geojson: around(0.01),
        style: { stroke: '#7c3aed', fill: 'rgba(124,58,237,0.12)' },
      },
    ],
  });
  const ids = overlays.sectionSource.entities.values.map((e) => e.id);
  assert.equal(ids.length, 1);
  assert.ok(!ids[0].endsWith(':fill'), 'no fill over the site');
});

test('fillAlphaFor: faint tint away from the site, none over it, none without a fill style', () => {
  const square = {
    kind: 'polygon',
    coords: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  };
  const fill = { fill: '#123456' };
  assert.equal(fillAlphaFor(square, fill, { lat: 5, lon: 5 }), FILL_ALPHA);
  assert.ok(FILL_ALPHA <= 0.1, 'fills never hide the imagery');
  assert.equal(fillAlphaFor(square, fill, { lat: 0.5, lon: 0.5 }), null);
  assert.equal(fillAlphaFor(square, {}, { lat: 5, lon: 5 }), null);
  assert.equal(ringContains(0.5, 0.5, square.coords), true);
  assert.equal(ringContains(1.5, 0.5, square.coords), false);
});

test('polygon holes survive geometry flattening for boundary rendering', () => {
  const outer = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
      [0, 0],
    ],
    hole = [
      [1, 1],
      [1, 2],
      [2, 2],
      [2, 1],
      [1, 1],
    ];
  const shapes = flattenGeojson({
    type: 'Polygon',
    coordinates: [outer, hole],
  });
  assert.deepEqual(shapes[0].holes, [hole]);
  const multi = flattenGeojson({
    type: 'MultiPolygon',
    coordinates: [[outer, hole]],
  });
  assert.deepEqual(multi[0].holes, [hole]);
});

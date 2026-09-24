import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMapSelection,
  mapLayerForFeature,
  mapLayerVisible,
  namedLabelLimit,
  crimeMapFeatures,
  availableCrimeCategory,
} from './mapSelection.js';
import { buildReportContext } from './reportContext.js';
import { buildMapPreviewHtml } from './printPage.js';

const feature = (name, category) => ({
  type: 'Feature',
  properties: { name, named: true, category },
  geometry: { type: 'Point', coordinates: [-96.8, 32.8] },
});
const doc = (selection) => ({
  site: { address: 'Dallas sample', lat: 32.8, lon: -96.8 },
  radiusMiles: 1,
  mapSelection: selection,
  sections: [
    {
      id: 'destinations',
      label: 'Destinations',
      retrievedAt: '2026-09-23T12:00:00Z',
      credit: { text: 'OpenStreetMap' },
      overlays: [
        {
          id: 'nearby',
          geojson: {
            type: 'FeatureCollection',
            features: [
              feature('Market A', 'grocery'),
              feature('Coffee B', 'coffee'),
            ],
          },
        },
      ],
    },
  ],
});

test('presets, individual toggles, labels and hidden overlays persist in a saved selection', () => {
  const model = createMapSelection();
  model.setPreset('presentation');
  model.setLayer('coffee', false);
  model.setLabelDensity('all');
  model.setOverlaysVisible(false);
  const restored = createMapSelection();
  restored.restore(model.getSnapshot());
  assert.deepEqual(restored.getSnapshot(), model.getSnapshot());
  assert.equal(mapLayerVisible(restored.getSnapshot(), 'retail'), false);
  restored.setOverlaysVisible(true);
  assert.equal(mapLayerVisible(restored.getSnapshot(), 'retail'), true);
  assert.equal(mapLayerVisible(restored.getSnapshot(), 'coffee'), false);
  assert.deepEqual(
    [namedLabelLimit('off'), namedLabelLimit('key'), namedLabelLimit('all')],
    [0, 3, 80],
  );
});

test('FEMA flood separates from other hazards and reported offense cells obey category and mode', () => {
  assert.equal(mapLayerForFeature('hazards', 'hazards-sfha'), 'flood');
  assert.equal(mapLayerForFeature('hazards', 'hazards-wetlands'), 'hazards');
  const model = createMapSelection();
  model.setLayer('hazards', false);
  assert.equal(mapLayerVisible(model.getSnapshot(), 'flood'), true);
  assert.equal(mapLayerVisible(model.getSnapshot(), 'hazards'), false);
  const offenses = [
    {
      type: 'Feature',
      properties: { category: 'Burglary' },
      geometry: { type: 'Point', coordinates: [-96.8, 32.8] },
    },
    {
      type: 'Feature',
      properties: { category: 'Burglary' },
      geometry: { type: 'Point', coordinates: [-96.801, 32.801] },
    },
    {
      type: 'Feature',
      properties: { category: 'Assault' },
      geometry: { type: 'Point', coordinates: [-96.8, 32.8] },
    },
  ];
  model.setCrimeCategory('Burglary');
  assert.equal(crimeMapFeatures(offenses, model.getSnapshot()).length, 2);
  model.setCrimeMode('density');
  const cells = crimeMapFeatures(offenses, model.getSnapshot());
  assert.equal(
    cells.reduce((sum, cell) => sum + cell.properties.count, 0),
    2,
  );
  assert.ok(cells.every((cell) => cell.properties.densityCell));
  assert.equal(
    createMapSelection().restore(model.getSnapshot()).crimeMode,
    'density',
  );
  assert.equal(availableCrimeCategory('Burglary', ['Assault']), 'all');
  assert.equal(availableCrimeCategory('Assault', ['Assault']), 'Assault');
});

test('named OSM workplace candidates map to their own visible layer without implying employee counts', () => {
  const model = createMapSelection();
  assert.equal(model.getSnapshot().layers.employers, true);
  const candidate = feature('Medical Center', 'employers');
  assert.equal(
    mapLayerForFeature('destinations', 'nearby', candidate.properties),
    'employers',
  );
  const data = doc(model.getSnapshot());
  data.sections[0].overlays[0].geojson.features = [candidate];
  assert.match(buildReportContext(data), /data-cre-map-layer="employers"/);
});

test('exported crime count cells and flood-only selection match chosen filters', () => {
  const model = createMapSelection();
  model.setCrimeMode('density');
  model.setCrimeCategory('Burglary');
  model.setLayer('hazards', false);
  const data = doc(model.getSnapshot());
  data.sections.push({
    id: 'neighborhood',
    label: 'Local police',
    retrievedAt: '2026-09-23T12:00:00Z',
    credit: { text: 'City police' },
    overlays: [
      {
        id: 'crime',
        geojson: {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { category: 'Burglary' },
              geometry: { type: 'Point', coordinates: [-96.8, 32.8] },
            },
            {
              type: 'Feature',
              properties: { category: 'Assault' },
              geometry: { type: 'Point', coordinates: [-96.8, 32.8] },
            },
          ],
        },
      },
    ],
  });
  data.sections.push({
    id: 'hazards',
    label: 'Federal hazards',
    retrievedAt: '2026-09-23T12:00:00Z',
    credit: { text: 'FEMA' },
    overlays: [
      {
        id: 'hazards-sfha',
        geojson: { type: 'Point', coordinates: [-96.8, 32.8] },
      },
      {
        id: 'hazards-wetlands',
        geojson: { type: 'Point', coordinates: [-96.8, 32.8] },
      },
    ],
  });
  const map = buildReportContext(data);
  assert.match(map, /data-cre-map-layer="crime"/);
  assert.match(map, /data-cre-map-layer="flood"/);
  assert.doesNotMatch(map, /data-cre-map-layer="hazards"/);
  assert.match(map, /<text[^>]*>1<\/text>/);
});

test('feature names obey the same selected layer in live classification and map export', () => {
  const model = createMapSelection();
  model.setLayer('coffee', false);
  assert.equal(
    mapLayerForFeature(
      'destinations',
      'nearby',
      feature('Coffee B', 'coffee').properties,
    ),
    'coffee',
  );
  const map = buildReportContext(doc(model.getSnapshot()));
  assert.match(map, /data-cre-map-layer="retail"/);
  assert.match(map, /Market A/);
  assert.doesNotMatch(map, /Coffee B/);
  assert.match(map, /OpenStreetMap/);
  assert.match(map, /retrieved 2026-09-23/);
  assert.match(map, /N ↑/);
  assert.match(map, /0\.25 miles/);
  model.setOverlaysVisible(false);
  assert.doesNotMatch(
    buildReportContext(doc(model.getSnapshot())),
    /data-cre-map-layer=/,
  );
});

test('key labels cap at three per layer and preview has PNG and PDF actions', () => {
  const data = doc(createMapSelection().getSnapshot());
  data.sections[0].overlays[0].geojson.features = Array.from(
    { length: 5 },
    (_, i) => feature(`Market ${i}`, 'grocery'),
  );
  const map = buildReportContext(data);
  assert.equal((map.match(/data-cre-map-label="retail"/g) || []).length, 3);
  assert.match(map, /2 names and 0 features omitted/);
  const preview = buildMapPreviewHtml(data);
  assert.match(preview, /data-cre-map-png/);
  assert.match(preview, /Print \/ Save PDF/);
  assert.match(preview, /Rectangular export extent/);
  assert.match(preview, /Source detail truncated in PNG/);
});

test('a large incident feed does not suppress named places and discloses geometry cap', () => {
  const data = doc(createMapSelection().getSnapshot());
  data.sections.unshift({
    id: 'crime',
    label: 'Reported incidents',
    retrievedAt: '2026-09-23T12:00:00Z',
    credit: { text: 'City incidents' },
    overlays: [
      {
        id: 'incidents',
        geojson: {
          type: 'FeatureCollection',
          features: Array.from({ length: 2000 }, () => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-96.8, 32.8] },
            properties: {},
          })),
        },
      },
    ],
  });
  const map = buildReportContext(data);
  assert.match(map, /Market A/);
  assert.match(map, /1502 features omitted/);
  assert.match(map, /City incidents/);
  assert.equal(mapLayerForFeature('access', 'county-job-cluster'), 'jobs');
});

test('exported names at one busy location use distinct positions and truncate long names visibly', () => {
  const data = doc(createMapSelection().getSnapshot());
  data.sections[0].overlays[0].geojson.features = [
    feature('A Very Long Grocery Store Name With Extra Description', 'grocery'),
    feature('Coffee B', 'coffee'),
    feature('Park C', 'parks'),
  ];
  const map = buildReportContext(data);
  const labels = [
    ...map.matchAll(
      /<text x="([\d.]+)" y="([\d.]+)" font-size="10"[^>]*>(.*?)<\/text>/g,
    ),
  ];
  assert.equal(labels.length, 3);
  assert.equal(
    new Set(labels.map((match) => `${match[1]},${match[2]}`)).size,
    3,
  );
  assert.match(map, /A Very Long Grocery Store Name…/);
  assert.match(map, /font-family="Arial, sans-serif"/);
  assert.ok(
    map.indexOf('<circle cx="270" cy="220" r="5"') <
      map.indexOf('data-cre-map-label="retail"'),
    'labels must paint after the site and all source points',
  );
  const boxes = labels.map((match) => ({
    left: Number(match[1]),
    top: Number(match[2]) - 11,
    right: Number(match[1]) + Math.min(215, match[3].length * 6.5 + 6),
    bottom: Number(match[2]) + 4,
  }));
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i],
        b = boxes[j];
      assert.ok(
        a.right <= b.left ||
          b.right <= a.left ||
          a.bottom <= b.top ||
          b.bottom <= a.top,
        'clustered labels overlap',
      );
    }
  for (const box of boxes)
    assert.ok(
      box.right <= 253 ||
        box.left >= 287 ||
        box.bottom <= 203 ||
        box.top >= 237,
      'a place label covers the selected site pin',
    );
});

test('report chain labels use native SVG text that survives image export', () => {
  const candidate = doc(createMapSelection().getSnapshot());
  candidate.sections[0].overlays[0].geojson.features = [feature('Starbucks', 'coffee')];
  const html = buildReportContext(candidate);
  assert.match(html, /data-chain-label="Starbucks"/);
  assert.match(html, />Sb<\/text>/);
  assert.equal(html.includes('<image '), false);
});

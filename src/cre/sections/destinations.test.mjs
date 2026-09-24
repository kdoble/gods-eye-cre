import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSectionResult, SECTION_STATUS } from '../contract.js';
import {
  destinationsSection,
  destinationRows,
  loadDestinationsSection,
} from './destinations.js';

const CTX = {
  lat: 36.320692,
  lon: -82.342509,
  address: '601 E Main St',
};
const DESTINATIONS = [
  {
    id: 'node/1',
    category: 'grocery',
    name: 'Market A',
    lat: 36.31,
    lon: -82.36,
    straightDistanceM: 300,
  },
  {
    id: 'node/2',
    category: 'retail',
    name: 'Mall B',
    lat: 36.32,
    lon: -82.36,
    straightDistanceM: 1100,
  },
];
const response = (data) => async (url) => {
  if (String(url).startsWith('/api/cre/destinations?')) {
    assert.equal(
      String(url),
      '/api/cre/destinations?lat=36.320692&lon=-82.342509',
    );
    return new Response(
      JSON.stringify({ data, retrievedAt: '2026-09-23T12:00:00Z' }),
    );
  }
  if (String(url).startsWith('/api/route?')) {
    const car = String(url).includes('profile=car');
    return new Response(
      JSON.stringify({
        ok: true,
        profile: car ? 'car' : 'foot',
        distanceM: car ? 2200 : 450,
        durationS: car ? 310 : 500,
        geometry: [
          [-82.342509, 36.320692],
          [-82.36, 36.31],
        ],
      }),
    );
  }
  throw new Error(`unexpected URL ${url}`);
};

test('module identity and table values retain routed versus straight-line meaning', () => {
  assert.equal(destinationsSection.id, 'destinations');
  const rows = destinationRows({
    destinations: DESTINATIONS,
    routes: { grocery: { walk: { durationS: 500, distanceM: 450 } } },
  });
  assert.equal(rows[0].label, 'Grocery: Market A');
  assert.equal(rows[0].value, '8 min walk');
  assert.match(rows[0].note, /Routed walk/);
  assert.equal(rows[1].value, 'Straight-line 0.68 mi');
  assert.match(rows[1].note, /free routing service did not answer/);
  assert.match(rows[1].note, /not a walking distance or travel time/);
});

test('named workplace row is a candidate location, not a verified major employer', () => {
  const rows = destinationRows({
    destinations: [],
    places: [
      {
        category: 'employers',
        id: 'way/7',
        name: 'Medical Campus',
        workplaceType: 'hospital',
        straightDistanceM: 1200,
      },
    ],
  });
  assert.equal(rows[0].label, 'Named workplace: Medical Campus');
  assert.equal(rows[0].value, '0.75 mi straight-line');
  assert.match(rows[0].note, /employee count.*unverified/);
  assert.match(rows[0].note, /major-employer status/);
  assert.ok(rows[0].sourceUrls.includes('https://www.openstreetmap.org/way/7'));
});

test('ready section carries source, retrieval time, named rows and retail overlay', async () => {
  const result = validateSectionResult(
    await loadDestinationsSection(CTX, {
      fetchImpl: response({
        status: 'ready',
        destinations: DESTINATIONS,
        features: [
          {
            type: 'Feature',
            properties: { id: 'node/1', name: 'Market A' },
            geometry: { type: 'Point', coordinates: [-82.36, 36.31] },
          },
        ],
        message: 'Some walk routes unavailable.',
      }),
    }),
  );
  assert.equal(result.status, SECTION_STATUS.READY);
  assert.equal(result.retrievedAt, '2026-09-23T12:00:00Z');
  assert.equal(result.values.length, 3);
  assert.equal(result.overlays[0].id, 'destinations');
  assert.equal(
    result.overlays[0].geojson.features[0].properties.sourceUrl,
    'https://www.openstreetmap.org/node/1',
  );
  assert.ok(
    result.overlays.some(
      (overlay) =>
        overlay.id === 'destinations' &&
        overlay.geojson.features.some((f) => f.geometry.type === 'LineString'),
    ),
  );
  assert.ok(result.sourceUrls.includes('https://routing.openstreetmap.de/'));
});

test('route outage preserves named POIs and never shows a straight-line-derived travel time', async () => {
  let routeCalls = 0;
  const result = validateSectionResult(
    await loadDestinationsSection(CTX, {
      fetchImpl: async (url) => {
        if (String(url).startsWith('/api/cre/destinations?'))
          return new Response(
            JSON.stringify({
              data: {
                status: 'ready',
                destinations: DESTINATIONS,
                features: [],
              },
            }),
          );
        routeCalls += 1;
        return new Response('{}', { status: 502 });
      },
    }),
  );
  assert.equal(result.status, SECTION_STATUS.PARTIAL);
  assert.equal(routeCalls, 3);
  assert.equal(result.values[0].value, 'Straight-line 0.19 mi');
  assert.match(result.values[0].note, /free routing service did not answer/);
  assert.match(result.values[0].note, /not a walking distance or travel time/);
  assert.match(result.values[2].value, /^Straight-line /);
  assert.match(result.values[2].note, /free routing service did not answer/);
});

test('empty Overpass source is not described as proof of no services', async () => {
  const result = validateSectionResult(
    await loadDestinationsSection(CTX, {
      fetchImpl: response({
        status: 'empty',
        destinations: [],
        message: 'No mapped services were returned; coverage varies.',
      }),
    }),
  );
  assert.equal(result.status, SECTION_STATUS.EMPTY);
  assert.match(result.message, /coverage varies/);
});

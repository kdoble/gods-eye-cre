// Tests for dossier geometry and config, checked against independently known distances and bearings.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bbox,
  bearingDegrees,
  destinationPoint,
  haversineMeters,
  ringPolygon,
} from './geo.js';
import {
  ADDRESS_PLACEHOLDER,
  DRIVE_TIME_MINUTES,
  RINGS_M,
  RING_MILES,
} from './config.js';
import { SECTIONS } from './sections.js';

const near = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} not within ${tolerance} of ${expected}`,
  );

test('haversine: one degree of latitude and a known city pair', () => {
  near(haversineMeters(0, 0, 1, 0), 111195, 1, '1 deg lat');
  // Johnson City TN to Atlanta GA, about 358 km great circle.
  const d = haversineMeters(36.320692, -82.342509, 33.749, -84.388);
  near(d, 336_000, 30_000, 'JC to ATL');
  assert.equal(haversineMeters(10, 20, 10, 20), 0);
});

test('bearing: cardinal directions', () => {
  near(bearingDegrees(0, 0, 1, 0), 0, 1e-9, 'north');
  near(bearingDegrees(0, 0, 0, 1), 90, 1e-9, 'east');
  near(bearingDegrees(0, 0, -1, 0), 180, 1e-9, 'south');
  near(bearingDegrees(0, 0, 0, -1), 270, 1e-9, 'west');
});

test('destinationPoint round-trips distance and bearing', () => {
  const start = { lat: 36.320692, lon: -82.342509 };
  const p = destinationPoint(start.lat, start.lon, 45, RINGS_M.threeMi);
  near(
    haversineMeters(start.lat, start.lon, p.lat, p.lon),
    RINGS_M.threeMi,
    0.01,
    'distance',
  );
  near(bearingDegrees(start.lat, start.lon, p.lat, p.lon), 45, 1e-6, 'bearing');
});

test('ringPolygon is closed and every vertex sits on the radius', () => {
  const feature = ringPolygon(33.77, -84.37, RINGS_M.oneMi, { steps: 32 });
  const ring = feature.geometry.coordinates[0];
  assert.equal(feature.geometry.type, 'Polygon');
  assert.equal(ring.length, 33);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  for (const [lon, lat] of ring) {
    near(
      haversineMeters(33.77, -84.37, lat, lon),
      RINGS_M.oneMi,
      0.01,
      'vertex',
    );
  }
  assert.throws(() => ringPolygon(0, 0, 0), RangeError);
});

test('bbox contains the whole ring', () => {
  const box = bbox(36.3, -82.36, RINGS_M.fiveMi);
  assert.deepEqual(box.bbox, [box.west, box.south, box.east, box.north]);
  const ring = ringPolygon(36.3, -82.36, RINGS_M.fiveMi, { steps: 360 });
  for (const [lon, lat] of ring.geometry.coordinates[0]) {
    assert.ok(lon >= box.west - 1e-9 && lon <= box.east + 1e-9);
    assert.ok(lat >= box.south - 1e-9 && lat <= box.north + 1e-9);
  }
});

test('config carries the SPEC defaults and the registry holds the real sections', () => {
  assert.deepEqual(RING_MILES, [1, 3, 5]);
  assert.equal(RINGS_M.oneMi, 1609.344);
  assert.equal(RINGS_M.threeMi, 4828.032);
  assert.equal(RINGS_M.fiveMi, 8046.72);
  assert.equal(DRIVE_TIME_MINUTES, 15);
  assert.equal(ADDRESS_PLACEHOLDER, 'Enter a property address');
  assert.deepEqual(
    SECTIONS.map((section) => section.id),
    [
      'neighborhood',
      'destinations',
      'demand-drivers',
      'hazards',
      'insurance',
      'market',
      'development',
      'local-news',
      'incentives',
      'lihtc-limits',
      'demographics',
      'rents',
      'supply',
      'jobs',
      'access',
      'utilities',
      'schools',
      'amenities',
      'imagery',
      'cameras',
      'location',
    ],
    'decision data first, site trivia last',
  );
  for (const section of SECTIONS) {
    assert.equal(typeof section.load, 'function', section.id);
    assert.ok(section.label, section.id);
    assert.ok(
      !/fixture/i.test(section.id),
      'the test fixture is never registered',
    );
  }
  assert.ok(Object.isFrozen(SECTIONS));
});

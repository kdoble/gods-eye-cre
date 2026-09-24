// Tests for the amenities section: one row per category with count and nearest, empty when nothing is mapped, and the negative that an Overpass 406 (route 502) yields unavailable with the fixed message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSectionResult } from '../contract.js';
import {
  AMENITIES_MESSAGES,
  amenitiesSection,
  amenityRows,
  loadAmenitiesSection,
} from './amenities.js';

const CTX = {
  lat: 36.320692,
  lon: -82.342509,
  address: '601 E Main St',
};
const cat = (label, count, nearest = null) => ({ label, count, nearest });
const DATA = {
  radiusM: 1609,
  hospitalNearestRadiusM: 4828,
  categories: {
    grocery: cat('Grocery', 3, { name: 'Piere Marketplace', distanceM: 1421 }),
    pharmacy: cat('Pharmacy', 0),
    restaurants: cat('Restaurants', 37, { name: 'Diner', distanceM: 224 }),
    gyms: cat('Gyms', 1, { name: 'Downtown Yoga Center', distanceM: 1410 }),
    transit: cat('Transit stops', 72, { name: null, distanceM: 269 }),
    hospitals: cat('Hospitals', 0, { name: 'Far Hospital', distanceM: 3000 }),
    parks: cat('Parks', 10, { name: 'D R Beeson Park', distanceM: 677 }),
    bigBox: cat('Big-box retail', 0),
  },
};
const reply =
  (payload, status = 200) =>
  async (url) => {
    assert.equal(
      String(url),
      '/api/cre/amenities?lat=36.320692&lon=-82.342509',
    );
    return new Response(JSON.stringify(payload), { status });
  };

test('module shape matches the section contract', () => {
  assert.equal(amenitiesSection.id, 'amenities');
  assert.equal(amenitiesSection.order, 10);
});

test('amenityRows: count within 1 mi per category, nearest in the note, honest none', () => {
  const rows = amenityRows(DATA);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows[0], {
    label: 'Grocery within 1 mi',
    value: 3,
    note: 'Nearest: Piere Marketplace, 0.88 mi',
  });
  assert.equal(rows[1].note, 'None within 1 mi');
  assert.equal(rows[4].note, 'Nearest: unnamed feature, 0.17 mi');
  assert.equal(rows[5].value, 0);
  assert.equal(rows[5].note, 'Nearest: Far Hospital, 1.86 mi');
  assert.equal(rows[7].note, 'None within 1 mi');
});

test('ready section validates against the contract', async () => {
  const result = validateSectionResult(
    await loadAmenitiesSection(CTX, {
      fetchImpl: reply({
        status: 'ready',
        data: DATA,
        retrievedAt: '2026-09-22T15:00:00.000Z',
      }),
    }),
  );
  assert.equal(result.status, 'ready');
  assert.equal(result.values.length, 8);
  assert.equal(result.credit.license, 'ODbL 1.0');
  assert.equal(result.retrievedAt, '2026-09-22T15:00:00.000Z');
});

test('nothing mapped within 1 mile is empty, not a row of zeros', async () => {
  const zero = structuredClone(DATA);
  for (const c of Object.values(zero.categories)) c.count = 0;
  const result = validateSectionResult(
    await loadAmenitiesSection(CTX, {
      fetchImpl: reply({ status: 'empty', data: zero }),
    }),
  );
  assert.equal(result.status, 'empty');
  assert.equal(result.message, AMENITIES_MESSAGES.EMPTY);
});

test('NEGATIVE: an Overpass 406 or 504 (route 502) yields unavailable with the fixed message', async () => {
  for (const status of [502, 504, 406]) {
    const result = validateSectionResult(
      await loadAmenitiesSection(CTX, {
        fetchImpl: reply({ error: 'Data source unavailable' }, status),
      }),
    );
    assert.equal(result.status, 'unavailable');
    assert.equal(result.message, AMENITIES_MESSAGES.UNAVAILABLE);
    assert.deepEqual(result.values, []);
  }
});

test('an aborted load rethrows so the controller can drop it', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    loadAmenitiesSection(CTX, {
      signal: controller.signal,
      fetchImpl: async (url, init) => {
        init.signal.throwIfAborted();
        return new Response('{}');
      },
    }),
  );
});

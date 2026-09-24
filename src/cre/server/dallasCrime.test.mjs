import test from 'node:test';
import assert from 'node:assert/strict';
import { dallasCrimePeriod, dallasCrimeWhere, loadDallasCrime } from '../../../server/providers/cre/dallasCrime.js';

const site = { lat: 32.8935, lon: -96.7391 };
const now = new Date('2026-09-23T12:00:00Z');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const row = (category, lat = '32.89351', lon = '-96.73914') => ({
  year1: '2026', date1dayofyear: '265', nibrs_crime_category: category,
  geocoded_column: { latitude: lat, longitude: lon, human_address: '{"address":"excluded"}' },
  incident_address: 'EXCLUDED ADDRESS', incidentnum: 'EXCLUDED ID',
});

test('Dallas query has a dated 90-day window and handles year boundaries', () => {
  const period = dallasCrimePeriod(now);
  assert.equal(period.start, '2026-06-25');
  assert.equal(period.end, '2026-09-22');
  const across = dallasCrimeWhere(site, 1609.344, new Date('2027-01-02T12:00:00Z'));
  assert.match(across.where, /year1 = 2026/);
  assert.match(across.where, /year1 = 2027/);
  assert.match(across.where, /within_circle\(geocoded_column,32\.893500,-96\.739100,1609\)/);
});

test('Dallas mapped offense records keep publisher category/date but no identifiers or addresses', async () => {
  const requests = [];
  const result = await loadDallasCrime(site, 1609.344, {
    now,
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      requests.push(parsed);
      assert.equal(parsed.origin, 'https://www.dallasopendata.com');
      assert.equal(parsed.pathname, '/resource/qv6i-rri7.json');
      assert.equal(init.redirect, 'error');
      return parsed.searchParams.has('$group')
        ? json([{ nibrs_crime_category: 'MOTOR VEHICLE THEFT', n: '2' }])
        : json([row('MOTOR VEHICLE THEFT'), row('MOTOR VEHICLE THEFT', '32.89352', '-96.73911')]);
    },
  });
  assert.equal(requests.length, 2);
  assert.equal(result.status, 'ready');
  assert.equal(result.totalRecords, 2);
  assert.equal(result.mappedRecords, 2);
  assert.equal(result.categories[0].count, 2);
  assert.equal(result.sourceMetadata.recordDate, '2026-09-22');
  assert.deepEqual(result.features[0].geometry.coordinates, [-96.739, 32.894]);
  assert.deepEqual(Object.keys(result.features[0].properties).sort(), ['category', 'date', 'locationPrecision', 'name']);
  assert.ok(!JSON.stringify(result).includes('EXCLUDED'));
  assert.match(result.message, /offense records/);
  assert.match(result.message, /One incident can have multiple offense rows/);
});

test('Dallas valid zero, malformed summary, and row truncation remain distinct', async () => {
  const zero = await loadDallasCrime(site, 1609.344, {
    now, fetchImpl: async () => json([]),
  });
  assert.equal(zero.status, 'empty');
  assert.equal(zero.totalRecords, 0);
  await assert.rejects(loadDallasCrime(site, 1609.344, {
    now, fetchImpl: async () => json({ error: 'schema changed' }),
  }));
  const many = Array.from({ length: 500 }, () => row('LARCENY/ THEFT OFFENSES'));
  const partial = await loadDallasCrime(site, 1609.344, {
    now,
    fetchImpl: async (url) => {
      const q = new URL(url).searchParams;
      return q.has('$group')
        ? json([{ nibrs_crime_category: 'LARCENY/ THEFT OFFENSES', n: '1001' }])
        : json(many);
    },
  });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.totalRecords, 1001);
  assert.equal(partial.mappedRecords, 1000);
  assert.equal(partial.features.length, 1000);
});

test('Dallas transient upstream 500 retries once and never means zero', async () => {
  let calls = 0;
  const result = await loadDallasCrime(site, 1609.344, {
    now,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? json({ error: 'transient' }, 500) : json([]);
    },
  });
  assert.equal(result.status, 'empty');
  assert.equal(calls, 2);
  await assert.rejects(loadDallasCrime(site, 1609.344, {
    now, fetchImpl: async () => json({ error: 'outage' }, 500),
  }));
});

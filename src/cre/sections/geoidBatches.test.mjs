// Tests for GEOID batching: batches stay inside the route's own ceilings and a safe URL length, merged answers keep every tract, and a batch that fails is reported as missing rather than summed as zero.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_COUNTIES_PER_BATCH,
  MAX_GEOIDS_PER_BATCH,
  MAX_QUERY_CHARS,
  MAX_STATES_PER_BATCH,
  chunkGeoids,
  fetchAcsBatches,
  fetchLodesBatches,
} from './geoidBatches.js';
import {
  ACS_MAX_COUNTIES,
  ACS_MAX_GEOIDS,
} from '../../../server/providers/cre/census.js';
import { LODES_MAX_STATES } from '../../../server/providers/cre/lodes.js';

/** `count` tract GEOIDs spread across `counties` counties of one state. */
function geoids(count, { state = '36', counties = 4 } = {}) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const county = String(((i % counties) + 1) * 2).padStart(3, '0');
    out.push(`${state}${county}${String(i).padStart(6, '0')}`);
  }
  return out;
}

test('batches stay inside the route ceilings and a URL every proxy carries', () => {
  const batches = chunkGeoids(geoids(819));
  assert.ok(batches.length > 1, 'a Brooklyn sized list is split');
  for (const batch of batches) {
    assert.ok(batch.length <= MAX_GEOIDS_PER_BATCH);
    assert.ok(batch.length <= ACS_MAX_GEOIDS, 'inside the server GEOID cap');
    const query = `/api/cre/census/acs?geoids=${batch.join(',')}`;
    assert.ok(
      query.length <= MAX_QUERY_CHARS,
      `query ${query.length} chars is inside ${MAX_QUERY_CHARS}`,
    );
    assert.ok(
      query.length < 8192,
      'inside the 8 KB request line nginx and Apache allow',
    );
    const counties = new Set(batch.map((g) => g.slice(0, 5)));
    assert.ok(counties.size <= ACS_MAX_COUNTIES);
  }
  const flat = batches.flat();
  assert.equal(new Set(flat).size, 819, 'every GEOID is carried, none dropped');
});

test('NEGATIVE: the old single request is exactly what the server refuses', () => {
  // The shape the bug had: one query holding every 5 mile tract in Brooklyn.
  const all = geoids(819);
  const single = `/api/cre/census/acs?geoids=${all.join(',')}`;
  assert.ok(all.length > ACS_MAX_GEOIDS, 'over the route GEOID ceiling');
  assert.ok(single.length > 8192, 'and over an 8 KB request line');
  // The batched form is not.
  assert.ok(
    chunkGeoids(all).every((b) => b.length <= ACS_MAX_GEOIDS),
    'batching removes both failures',
  );
});

test('a county or state ceiling splits a batch before the count ceiling does', () => {
  const many = [];
  for (let c = 0; c < 60; c += 1) {
    many.push(`13${String(c).padStart(3, '0')}000100`);
  }
  for (const batch of chunkGeoids(many, { maxGroups: MAX_COUNTIES_PER_BATCH })) {
    assert.ok(new Set(batch.map((g) => g.slice(0, 5))).size <= 40);
  }
  const states = [];
  for (let s = 1; s <= 12; s += 1) {
    states.push(`${String(s).padStart(2, '0')}001000100`);
  }
  const lodes = chunkGeoids(states, {
    groupOf: (g) => g.slice(0, 2),
    maxGroups: MAX_STATES_PER_BATCH,
  });
  for (const batch of lodes) {
    assert.ok(
      new Set(batch.map((g) => g.slice(0, 2))).size <= LODES_MAX_STATES,
      'inside the server state ceiling',
    );
  }
});

/** A fake `get` that answers ACS batches from a table, failing named GEOIDs. */
function acsGet({ fail = () => false, retrievedAt = {} } = {}) {
  const seen = [];
  return {
    seen,
    get: async (path) => {
      const list = new URL(path, 'http://x').searchParams
        .get('geoids')
        .split(',');
      seen.push(list);
      if (fail(list)) throw new Error('CRE route HTTP 400');
      return {
        status: 'ready',
        retrievedAt: retrievedAt[list[0]] ?? '2026-09-22T17:00:00.000Z',
        sourceUrls: [`https://api.census.gov/${list[0].slice(0, 5)}`],
        data: {
          vintage: 'ACS 2020-2024 5-year',
          priorVintage: 'ACS 2016-2020 5-year',
          tracts: Object.fromEntries(
            list.map((g) => [g, { cur: { pop: 100 }, prior: { pop: 90 } }]),
          ),
        },
      };
    },
  };
}

test('every tract in a dense metro comes back, merged across batches', async () => {
  const wanted = geoids(819);
  const { get, seen } = acsGet();
  const acs = await fetchAcsBatches(wanted, get);
  assert.equal(acs.status, 'ready');
  assert.ok(seen.length > 1, 'more than one request');
  assert.equal(Object.keys(acs.data.tracts).length, 819);
  assert.deepEqual(acs.missing, []);
  assert.equal(acs.failedBatches, 0);
  assert.equal(acs.data.vintage, 'ACS 2020-2024 5-year');
});

test('NEGATIVE: a batch that fails is reported missing, never silently dropped', async () => {
  const wanted = geoids(400);
  const { get } = acsGet({ fail: (list) => list.includes(wanted[0]) });
  const acs = await fetchAcsBatches(wanted, get);
  assert.equal(acs.failedBatches, 1);
  assert.ok(acs.missing.length > 0, 'the lost tracts are named');
  assert.ok(
    acs.missing.every((g) => !acs.data.tracts[g]?.cur),
    'nothing in missing has values',
  );
  assert.equal(
    Object.keys(acs.data.tracts).length + acs.missing.length,
    400,
    'every requested tract is either merged or reported missing',
  );
});

test('the merged stamp is the oldest batch, not the newest', async () => {
  const wanted = geoids(300);
  const sorted = [...new Set(wanted)].sort();
  const { get } = acsGet({
    retrievedAt: {
      [sorted[0]]: '2026-08-01T00:00:00.000Z',
      [sorted[150]]: '2026-09-22T17:00:00.000Z',
    },
  });
  const acs = await fetchAcsBatches(wanted, get);
  assert.equal(acs.retrievedAt, '2026-08-01T00:00:00.000Z');
});

test('every batch failing throws, so the section can report unavailable', async () => {
  const { get } = acsGet({ fail: () => true });
  await assert.rejects(() => fetchAcsBatches(geoids(300), get), /HTTP 400/);
});

test('needs-key from any batch is carried straight through', async () => {
  const get = async () => ({
    status: 'needs-key',
    keyName: 'CENSUS_API_KEY',
    message: 'Census ACS needs the free CENSUS_API_KEY',
    retrievedAt: '2026-09-22T17:00:00.000Z',
  });
  const acs = await fetchAcsBatches(geoids(300), get);
  assert.equal(acs.status, 'needs-key');
  assert.equal(acs.keyName, 'CENSUS_API_KEY');
});

test('LODES batches merge, and a lost batch lands in missing, not in the total', async () => {
  const wanted = geoids(819, { state: '36', counties: 3 });
  const sorted = [...new Set(wanted)].sort();
  const lost = sorted[0];
  const get = async (path) => {
    const list = new URL(path, 'http://x').searchParams
      .get('geoids')
      .split(',');
    if (list.includes(lost)) throw new Error('CRE route HTTP 502');
    return {
      status: 'ready',
      retrievedAt: '2026-09-22T17:00:00.000Z',
      sourceUrls: ['https://lehd.ces.census.gov/ny'],
      data: {
        year: 2023,
        sectors: { CNS01: 'Agriculture' },
        tracts: Object.fromEntries(
          list.map((g) => [g, { total: 1000, sectors: { CNS01: 1000 } }]),
        ),
      },
    };
  };
  const lodes = await fetchLodesBatches(wanted, get);
  assert.equal(lodes.status, 'ready');
  assert.equal(lodes.data.year, 2023);
  assert.ok(lodes.missing.includes(lost));
  assert.equal(lodes.failedBatches, 1);
  assert.equal(
    Object.keys(lodes.data.tracts).length + lodes.missing.length,
    819,
  );
});

test('LODES batch response retains every vintage and propagates stale-cache state', async () => {
  const wanted = geoids(300);
  let call = 0;
  const get = async (path) => {
    const list = new URL(path, 'http://x').searchParams.get('geoids').split(',');
    call += 1;
    return {
      status: 'ready', sourceUrls: [], retrievedAt: '2026-01-01T00:00:00.000Z',
      data: { year: call === 1 ? 2023 : 2022, stale: call === 2, tracts: Object.fromEntries(list.map((g) => [g, { total: 1, sectors: {} }])) },
    };
  };
  const result = await fetchLodesBatches(wanted, get);
  assert.deepEqual(result.data.vintages, [2022, 2023]);
  assert.equal(result.data.stale, true);
});

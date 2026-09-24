// Tests for /api/cre/incentives/* with a mocked upstream: QCT, DDA and OZ lookups, LIHTC and public housing ring counts, and the ArcGIS 400, timeout and truncation negatives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIncentiveHandlers } from '../../../server/providers/cre/incentives.js';
import { CRE_ERRORS } from '../../../server/providers/cre/common/route.js';
import {
  ARCGIS_400,
  SECRET,
  TIMING,
  call,
  hangingFetch,
  incentiveUpstream,
  json,
} from './wp3Fixtures.testutil.mjs';

const handlersFor = (overrides, { now } = {}) => {
  const upstream = incentiveUpstream(overrides);
  const handlers = createIncentiveHandlers({
    fetchImpl: upstream.fetchImpl,
    timing: TIMING,
    cacheOptions: { disk: false },
    limiter: null,
    now,
  });
  return { handlers, upstream };
};

test('zones: QCT yes, DDA no, OZ yes, with outlines for the hits', async () => {
  const { handlers } = handlersFor();
  const body = (await call(handlers.zones)).json();
  assert.equal(body.status, 'ready');
  assert.deepEqual(body.data.qct, {
    inside: true,
    tract: '47179060902',
    // Re-derived 2026-09-24 from the live Census Geocoder for the new test
    // point (36.320692, -82.342509): tract 47179060902 is "Census Tract
    // 609.02", not the old site's truncated fixture name.
    name: 'Census Tract 609.02',
  });
  assert.equal(body.data.dda.inside, false);
  assert.equal(body.data.oz.inside, true);
  assert.equal(body.data.oz.tract2010, '47179060902');
  assert.deepEqual(body.data.failed, []);
  assert.equal(body.data.geojson.features.length, 2);
});

test('DATA-08: designation year is the layer-name year (2026), corroborated by dataLastEditDate, despite a stale "Fiscal Year 2024" description', async () => {
  const { handlers } = handlersFor(undefined, {
    now: () => new Date('2026-09-24T12:00:00Z'),
  });
  const body = (await call(handlers.zones)).json();
  for (const key of ['qctDesignation', 'ddaDesignation']) {
    const d = body.data[key];
    assert.equal(d.year, 2026, key);
    assert.equal(d.dataUpdated, '2025-09-22', key);
    assert.equal(d.newerYearMayExist, false, key);
    assert.equal(d.dataMayBeStale, false, key);
  }
});

test('DATA-08: after Dec 31 of the designation year, a newer HUD year may be available', async () => {
  const { handlers } = handlersFor(undefined, {
    now: () => new Date('2027-01-15T12:00:00Z'),
  });
  const body = (await call(handlers.zones)).json();
  assert.equal(body.data.qctDesignation.year, 2026);
  assert.equal(body.data.qctDesignation.newerYearMayExist, true);
  assert.equal(body.data.ddaDesignation.newerYearMayExist, true);
});

test('DATA-08: missing editingInfo falls back to the layer-name year with no flag and no update date', async () => {
  const { handlers } = handlersFor(
    {
      qctMeta: { name: 'QUALIFIED_CENSUS_TRACTS_2026', description: 'x' },
    },
    { now: () => new Date('2026-09-24T12:00:00Z') },
  );
  const q = (await call(handlers.zones)).json().data.qctDesignation;
  assert.equal(q.year, 2026);
  assert.equal(q.dataUpdated, null);
  assert.equal(q.dataMayBeStale, false);
  assert.equal(q.newerYearMayExist, false);
});

test('N7: the "newer HUD year may be available" flag fires from October 1 of the designation year, not January 1 of the next', async () => {
  const { handlers } = handlersFor(undefined, {
    now: () => new Date('2026-10-01T00:00:00Z'),
  });
  const body = (await call(handlers.zones)).json();
  assert.equal(
    body.data.qctDesignation.newerYearMayExist,
    true,
    'HUD publishes year N+1 in the fall of year N -- the flag must not wait until January',
  );
});

test('N7 NEGATIVE: the flag is still false the day before, September 30', async () => {
  const { handlers } = handlersFor(undefined, {
    now: () => new Date('2026-09-30T23:59:59Z'),
  });
  const body = (await call(handlers.zones)).json();
  assert.equal(body.data.qctDesignation.newerYearMayExist, false);
});

test('S6: a hanging HUD metadata fetch times out (never hangs the request) and falls back to the layer-name year', async () => {
  const { handlers } = handlersFor({ qctMeta: hangingFetch });
  const body = (await call(handlers.zones)).json();
  assert.equal(body.status, 'ready', 'the point lookup itself still succeeds');
  assert.equal(
    body.data.qctDesignation.year,
    2026,
    'falls back to the layer-name year, not stuck waiting forever',
  );
  assert.equal(body.data.qctDesignation.dataUpdated, null);
});

test('S6: the designation metadata fetch is cached across DIFFERENT points in the same handler set, never refetched every call', async () => {
  const { handlers, upstream } = handlersFor(undefined, {
    now: () => new Date('2026-09-24T12:00:00Z'),
  });
  // Two distinct points, so the outer per-point result cache (a separate
  // mechanism) cannot be what is being measured here -- only the
  // layer-metadata cache is point-independent.
  await call(handlers.zones, 'lat=36.320692&lon=-82.342509');
  const metaCallsAfterFirst = upstream.calls.filter((u) => !u.includes('/query')).length;
  assert.equal(metaCallsAfterFirst, 2, 'one metadata fetch each for QCT and DDA');
  await call(handlers.zones, 'lat=36.4&lon=-82.5');
  const metaCallsAfterSecond = upstream.calls.filter((u) => !u.includes('/query')).length;
  assert.equal(
    metaCallsAfterSecond,
    metaCallsAfterFirst,
    'a different point must reuse the cached layer metadata, not refetch it',
  );
});

test('NEGATIVE DATA-08: data last edited before year N-1 is flagged as possibly stale', async () => {
  const { handlers } = handlersFor(
    {
      qctMeta: {
        name: 'QUALIFIED_CENSUS_TRACTS_2026',
        editingInfo: { dataLastEditDate: Date.UTC(2023, 9, 1) },
      },
    },
    { now: () => new Date('2026-09-24T12:00:00Z') },
  );
  const q = (await call(handlers.zones)).json().data.qctDesignation;
  assert.equal(q.year, 2026);
  assert.equal(q.dataMayBeStale, true);
});

test('NEGATIVE: one zone layer down is reported failed, never as "No", and not cached', async () => {
  let ddaCalls = 0;
  const { handlers } = handlersFor({
    dda: () => {
      ddaCalls += 1;
      return json(ARCGIS_400);
    },
  });
  const res = await call(handlers.zones);
  const body = res.json();
  assert.equal(body.data.dda, null);
  assert.deepEqual(body.data.failed, ['dda']);
  assert.ok(!res.body.includes(SECRET));
  await call(handlers.zones);
  assert.equal(ddaCalls, 2);
});

test('NEGATIVE: every zone layer ArcGIS 400 answers 502 with the fixed message', async () => {
  const { handlers } = handlersFor({
    qct: ARCGIS_400,
    dda: ARCGIS_400,
    oz: ARCGIS_400,
  });
  const res = await call(handlers.zones);
  assert.equal(res.status, 502);
  assert.deepEqual(res.json(), { error: CRE_ERRORS.UPSTREAM });
  assert.ok(!res.body.includes(SECRET));
});

test('lihtc: 1 and 3 mile counts, unit totals, unknown units, nearest three', async () => {
  const { handlers, upstream } = handlersFor();
  const body = (await call(handlers.lihtc)).json();
  const params = new URL(upstream.calls[0]).searchParams;
  assert.ok(Math.abs(Number(params.get('distance')) - 3 * 1609.344) < 1e-6);
  assert.deepEqual(body.data.oneMi, { count: 3, units: 140, unitsUnknown: 1 });
  assert.deepEqual(body.data.threeMi, {
    count: 4,
    units: 240,
    unitsUnknown: 1,
  });
  assert.deepEqual(
    body.data.nearest.map((n) => n.name),
    ['WATAUGA SQUARE', 'CEDAR GROVE', 'NO COUNT'],
  );
  assert.equal(body.data.nearest[1].units, 38);
  assert.equal(body.data.nearest[2].units, null);
  assert.equal(body.data.geojson.features.length, 4);
});

test('lihtc: no properties within 3 miles is ready with zero counts', async () => {
  const { handlers } = handlersFor({ lihtc: { features: [] } });
  const body = (await call(handlers.lihtc)).json();
  assert.equal(body.status, 'ready');
  assert.deepEqual(body.data.oneMi, { count: 0, units: 0, unitsUnknown: 0 });
});

test('NEGATIVE: a truncated LIHTC answer is refused rather than undercounted', async () => {
  const { handlers } = handlersFor({
    lihtc: { features: [], exceededTransferLimit: true },
  });
  const res = await call(handlers.lihtc);
  assert.equal(res.status, 502);
  assert.deepEqual(res.json(), { error: CRE_ERRORS.UPSTREAM });
});

test('NEGATIVE: a LIHTC timeout answers 502 with the fixed message', async () => {
  const { handlers } = handlersFor({ lihtc: hangingFetch });
  const res = await call(handlers.lihtc);
  assert.equal(res.status, 502);
});

test('publichousing: 1 and 3 mile counts and the nearest development', async () => {
  const { handlers } = handlersFor();
  const body = (await call(handlers.publichousing)).json();
  assert.deepEqual(body.data.oneMi, { count: 1, units: 74, unitsUnknown: 0 });
  assert.deepEqual(body.data.threeMi, {
    count: 2,
    units: 425,
    unitsUnknown: 0,
  });
  assert.equal(body.data.nearest[0].name, 'NORTHSIDE');
  assert.equal(body.data.nearest[0].agency, 'Johnson City Housing Authority');
});

test('NEGATIVE: public housing ArcGIS 400 answers 502 without upstream text', async () => {
  const { handlers } = handlersFor({ ph: ARCGIS_400 });
  const res = await call(handlers.publichousing);
  assert.equal(res.status, 502);
  assert.ok(!res.body.includes(SECRET));
});

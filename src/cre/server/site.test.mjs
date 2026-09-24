// Tests for /api/cre/site/* with a mocked upstream: hits, empty answers, the ArcGIS 400 and timeout negatives, the EPQS fallback, and partial results that must not be cached.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSiteHandlers,
  loadCached,
  pointKey,
  pointOp,
  walkabilityBand,
} from '../../../server/providers/cre/site.js';
import { CRE_ERRORS } from '../../../server/providers/cre/common/route.js';
import { createCreCache } from '../../../server/providers/cre/common/cache.js';
import {
  ARCGIS_400,
  SECRET,
  TIMING,
  call,
  hangingFetch,
  json,
  siteUpstream,
} from './wp3Fixtures.testutil.mjs';

const handlersFor = (overrides) => {
  const upstream = siteUpstream(overrides);
  const handlers = createSiteHandlers({
    fetchImpl: upstream.fetchImpl,
    timing: TIMING,
    cacheOptions: { disk: false },
    limiter: null,
  });
  return { handlers, upstream };
};

test('geography: hit returns county, tract and place with the route contract', async () => {
  const { handlers } = handlersFor();
  const res = await call(handlers.geography);
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.status, 'ready');
  assert.equal(body.data.tractGeoid, '47179060902');
  assert.equal(body.data.county, 'Washington County');
  assert.equal(body.data.stateAbbr, 'TN');
  assert.equal(body.data.place, 'Johnson City city');
  assert.equal(body.source.license, 'Public domain (US Government work)');
  assert.ok(!Number.isNaN(Date.parse(body.retrievedAt)));
});

test('geography: no tract (outside the US) is empty, not ready', async () => {
  const { handlers } = handlersFor({ census: { result: { geographies: {} } } });
  const body = (await call(handlers.geography)).json();
  assert.equal(body.status, 'empty');
  assert.deepEqual(body.data, {});
});

test('elevation: EPQS value in feet plus 3DEP slope', async () => {
  const { handlers } = handlersFor();
  const body = (await call(handlers.elevation)).json();
  assert.equal(body.status, 'ready');
  assert.equal(body.data.elevationFt, 1649.7);
  assert.equal(body.data.elevationMethod, 'USGS EPQS');
  assert.equal(body.data.slopeDeg, 4);
});

test('elevation: EPQS no-data sentinel falls back to the 3DEP identify in meters', async () => {
  const { handlers } = handlersFor({ epqs: { value: -1000000 } });
  const body = (await call(handlers.elevation)).json();
  assert.equal(body.data.elevationMethod, 'USGS 3DEP ImageServer identify');
  assert.equal(body.data.elevationFt, 1649.7);
});

test('elevation: NoData everywhere is empty', async () => {
  const { handlers } = handlersFor({
    epqs: json({ error: 'bad' }, 400),
    identify: { value: 'NoData' },
    slope: { value: 'NoData' },
  });
  const body = (await call(handlers.elevation)).json();
  assert.equal(body.status, 'empty');
});

test('soils: map unit and dominant component from SDA', async () => {
  const { handlers } = handlersFor();
  const body = (await call(handlers.soils)).json();
  assert.equal(body.data.mapUnit, 'Urban land');
  assert.equal(body.data.mukey, '1690201');
  assert.equal(body.data.components[0].pct, 90);
  assert.equal(body.data.components[0].drainage, null);
});

test('soils: SDA with no table (no survey) is empty', async () => {
  const { handlers } = handlersFor({ sda: {} });
  assert.equal((await call(handlers.soils)).json().status, 'empty');
});

test('watershed and walkability: hits', async () => {
  const { handlers } = handlersFor();
  const shed = (await call(handlers.watershed)).json();
  assert.deepEqual(shed.data, { huc12: '060101030504', name: 'Brush Creek' });
  const walk = (await call(handlers.walkability)).json();
  assert.equal(walk.data.index, 8.3);
  assert.equal(walk.data.band, 'Below average walkable');
});

test('walkability: an empty feature list is empty', async () => {
  const { handlers } = handlersFor({ walk: { features: [] } });
  assert.equal((await call(handlers.walkability)).json().status, 'empty');
});

test('NEGATIVE: ArcGIS 400 body answers 502 with the fixed message, never the upstream text', async () => {
  const { handlers } = handlersFor({ wbd: ARCGIS_400, walk: ARCGIS_400 });
  for (const op of ['watershed', 'walkability']) {
    const res = await call(handlers[op]);
    assert.equal(res.status, 502);
    assert.deepEqual(res.json(), { error: CRE_ERRORS.UPSTREAM });
    assert.ok(!res.body.includes(SECRET));
  }
});

test('NEGATIVE: an upstream timeout answers 502 with the fixed message', async () => {
  const { handlers } = handlersFor({ census: hangingFetch, wbd: hangingFetch });
  for (const op of ['geography', 'watershed']) {
    const res = await call(handlers[op]);
    assert.equal(res.status, 502);
    assert.deepEqual(res.json(), { error: CRE_ERRORS.UPSTREAM });
  }
});

test('NEGATIVE: lat=91 answers 400 and never calls upstream', async () => {
  const { handlers, upstream } = handlersFor();
  const res = await call(handlers.elevation, 'lat=91&lon=-82');
  assert.equal(res.status, 400);
  assert.equal(upstream.calls.length, 0);
});

test('a second request is served from cache without an upstream call', async () => {
  const { handlers, upstream } = handlersFor();
  await call(handlers.watershed);
  const before = upstream.calls.length;
  const again = (await call(handlers.watershed)).json();
  assert.equal(again.data.name, 'Brush Creek');
  assert.equal(upstream.calls.length, before);
});

test('NEGATIVE: a partial result (slope failed) is served but not cached', async () => {
  let slopeCalls = 0;
  const { handlers } = handlersFor({
    slope: () => {
      slopeCalls += 1;
      return json({ error: 'x' }, 500);
    },
  });
  const first = (await call(handlers.elevation)).json();
  assert.equal(first.status, 'ready');
  assert.equal(first.data.slopeDeg, null);
  await call(handlers.elevation);
  assert.equal(slopeCalls, 2, 'partial result must be re-fetched');
});

test('loadCached serves last-good data when the live load throws', async () => {
  let t = 0;
  const cache = createCreCache({
    family: 'test-site',
    ttlMs: 10,
    disk: false,
    now: () => t,
  });
  await loadCached(cache, 'k', async () => ({
    status: 'ready',
    data: { v: 1 },
  }));
  t = 100;
  const stale = await loadCached(cache, 'k', async () => {
    throw new Error('down');
  });
  assert.equal(stale.value.data.v, 1);
  await assert.rejects(
    loadCached(cache, 'other', async () => {
      throw new Error('down');
    }),
  );
});

test('pointOp keys bounded radius separately and refreshes only the selected area', async () => {
  const cache = createCreCache({
    family: 'site-radius-refresh',
    ttlMs: 60_000,
    disk: false,
    minRefreshIntervalMs: 0,
  });
  const seen = [];
  const handler = pointOp({
    cache,
    tag: 'radius',
    limiter: null,
    radius: { fallback: 1609, max: 8047 },
    source: { name: 'fixture', url: 'https://example.org/', license: 'test' },
    load: async (point) => {
      seen.push(point.radiusM);
      return {
        status: 'ready',
        data: { radiusM: point.radiusM, n: seen.length },
      };
    },
  });
  const one = (await call(handler, 'lat=32.89&lon=-96.73&radiusM=1609')).json();
  const two = (await call(handler, 'lat=32.89&lon=-96.73&radiusM=3000')).json();
  const hit = (await call(handler, 'lat=32.89&lon=-96.73&radiusM=1609')).json();
  const refreshed = (
    await call(handler, 'lat=32.89&lon=-96.73&radiusM=1609&refresh=1')
  ).json();
  assert.deepEqual(seen, [1609, 3000, 1609]);
  assert.equal(hit.data.n, one.data.n);
  assert.equal(refreshed.data.n, 3);
  assert.equal(refreshed.refresh.status, 'succeeded');
  assert.match(pointKey('radius', 32.89, -96.73, 1609), /1609\.00m$/);
  assert.equal(
    (await call(handler, 'lat=32.89&lon=-96.73&radiusM=9000')).status,
    400,
  );
  assert.equal(
    (await call(handler, 'lat=32.89&lon=-96.73&refresh=oops')).status,
    400,
  );
});

test('walkabilityBand follows the EPA cut points', () => {
  assert.equal(walkabilityBand(5.75), 'Least walkable');
  assert.equal(walkabilityBand(10.5), 'Below average walkable');
  assert.equal(walkabilityBand(15.25), 'Above average walkable');
  assert.equal(walkabilityBand(18.8), 'Most walkable');
});

test('NEGATIVE: a 200 answer carrying an error body is a failure, not empty data', async () => {
  const { handlers } = handlersFor({
    epqs: ARCGIS_400,
    identify: ARCGIS_400,
    census: ARCGIS_400,
  });
  for (const op of ['elevation', 'geography']) {
    const res = await call(handlers[op]);
    assert.equal(res.status, 502, op);
    assert.ok(!res.body.includes(SECRET));
  }
});

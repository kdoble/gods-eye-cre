import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CRIME_SOURCE,
  PARCEL_SOURCE,
  crimeQuery,
  creNeighborhoodHandler,
  loadCrime,
  loadParcel,
  loadRoads,
  JC_PARCEL_SOURCE,
  JC_ZONING_SOURCE,
  JC_CRIME_SOURCE,
} from '../../../server/providers/cre/neighborhood.js';
import { AMENITY_OVERPASS_ENDPOINTS } from '../../../server/providers/cre/amenities.js';
import { createCreCache } from '../../../server/providers/cre/common/cache.js';
import { CRE_ERRORS } from '../../../server/providers/cre/common/route.js';
import { call, fakeRes, json } from './wp3Fixtures.testutil.mjs';

const CHICAGO = { lat: 41.88, lon: -87.63 };
const ATLANTA = { lat: 33.75, lon: -84.39 };
const TEST_POINT = { lat: 36.320692, lon: -82.342509 };
const square = [
  [-84.391, 33.749],
  [-84.391, 33.751],
  [-84.389, 33.751],
  [-84.389, 33.749],
  [-84.391, 33.749],
];

test('default neighborhood handler constructs with the versioned cache family', () => {
  assert.equal(typeof creNeighborhoodHandler(), 'function');
});

test('crime query uses the fixed Chicago host, exact point/radius, and excludes the latest seven days', () => {
  const { url, start, end } = crimeQuery(
    CHICAGO,
    1609,
    new Date('2026-09-22T12:00:00Z'),
  );
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://data.cityofchicago.org');
  assert.equal(parsed.pathname, '/resource/ijzp-q8t2.json');
  assert.equal(parsed.searchParams.get('$limit'), '2001');
  assert.match(
    parsed.searchParams.get('$where'),
    /within_circle\(location,41\.88,-87\.63,1609\)/,
  );
  assert.equal(end, '2026-09-15');
  assert.equal(start, '2026-06-17');
  assert.match(
    parsed.searchParams.get('$where'),
    /date < '2026-09-15T00:00:00'/,
  );
  assert.equal(
    CRIME_SOURCE,
    'https://data.cityofchicago.org/Public-Safety/Crimes-2001-to-present/ijzp-q8t2',
  );
});

test('crime request applies a fixed 12 second timeout and returns only bounded valid point features', async () => {
  const originalTimeout = AbortSignal.timeout;
  let timeoutMs;
  let requestUrl;
  let requestInit;
  AbortSignal.timeout = (ms) => {
    timeoutMs = ms;
    return originalTimeout.call(AbortSignal, ms);
  };
  try {
    const rows = Array.from({ length: 2001 }, (_, i) => ({
      date: `2026-09-${String((i % 14) + 1).padStart(2, '0')}T10:00:00`,
      primary_type: `Incident ${i}`,
      latitude: i === 1 ? '999' : '41.88',
      longitude: '-87.63',
    }));
    const result = await loadCrime(CHICAGO, 2500, {
      now: new Date('2026-09-22T12:00:00Z'),
      fetchImpl: async (url, init) => {
        requestUrl = String(url);
        requestInit = init;
        return json(rows);
      },
    });
    assert.equal(timeoutMs, 12_000);
    assert.equal(requestInit.redirect, 'error');
    assert.equal(requestInit.headers.Accept, 'application/json');
    const parsed = new URL(requestUrl);
    assert.equal(parsed.origin, 'https://data.cityofchicago.org');
    assert.match(
      parsed.searchParams.get('$where'),
      /within_circle\(location,41\.88,-87\.63,2500\)/,
    );
    assert.equal(result.status, 'partial');
    assert.equal(
      result.features.length,
      1999,
      'bad coordinates are dropped from first 2,000 rows',
    );
    assert.match(result.message, /newest 2,000 records/);
    assert.match(
      result.message,
      /not a population-adjusted crime rate or a safety rating/,
    );
    assert.ok(result.features.every((f) => f.geometry.type === 'Point'));
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test('crime outside the Chicago pilot makes no request and cannot imply low crime', async () => {
  let calls = 0;
  const result = await loadCrime({ lat: 40.7, lon: -74 }, 1609, {
    fetchImpl: async () => {
      calls += 1;
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.status, 'unsupported');
  assert.deepEqual(result.features, []);
  assert.match(result.message, /Chicago reported incidents only/);
  assert.match(result.message, /Missing coverage does not mean low crime/);
});

test('Johnson City crime shows the official but unreadable source as unavailable, never zero or unsupported', async () => {
  let calls = 0;
  const result = await loadCrime(TEST_POINT, 1609, {
    johnsonCityConfirmed: true,
    fetchImpl: async () => {
      calls += 1;
    },
  });
  assert.equal(
    calls,
    0,
    'known inaccessible feed is not probed on each dossier open',
  );
  assert.equal(result.status, 'unavailable');
  assert.equal(result.source, JC_CRIME_SOURCE);
  assert.match(result.message, /hourly updates beginning in 2020/);
  assert.match(result.message, /did not return usable records/);
  assert.match(result.message, /homicide, kidnapping, sex offenses/);
  assert.match(
    result.message,
    /Tennessee TBI CrimeInsight is a separate agency-level source/,
  );
});

test('Johnson City incident source is not attributed outside a point confirmed by the city zoning layer', async () => {
  const handler = creNeighborhoodHandler({
    cache: createCreCache({
      family: 'neighborhood-city-gate-test',
      ttlMs: 60_000,
      disk: false,
    }),
    fetchImpl: async (url) =>
      String(url).includes('overpass')
        ? json({ elements: [] })
        : json({ features: [] }),
  });
  const res = await call(handler, 'lat=36.320692&lon=-82.342509&radiusM=1609');
  assert.equal(res.status, 200);
  assert.equal(res.json().data.crime.status, 'unsupported');
  assert.equal(res.json().data.crime.sourceStatus, undefined);
  assert.doesNotMatch(
    res.json().data.crime.message,
    /Johnson City Police links/,
  );
});

test('major road query stays on the fixed Overpass mirrors, clamps radius, and turns mapped ways into lines', async () => {
  let endpoint;
  let init;
  const result = await loadRoads(TEST_POINT, 8047, {
    fetchImpl: async (url, request) => {
      endpoint = String(url);
      init = request;
      return new Response(
        JSON.stringify({
          elements: [
            {
              type: 'way',
              tags: { highway: 'primary', name: 'Main Road' },
              geometry: [
                { lat: 36.31, lon: -82.37 },
                { lat: 36.32, lon: -82.36 },
              ],
            },
            {
              type: 'way',
              tags: { highway: 'secondary' },
              geometry: [{ lat: 36.3, lon: -82.3 }],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  assert.ok(AMENITY_OVERPASS_ENDPOINTS.includes(endpoint));
  assert.equal(init.method, 'POST');
  assert.equal(result.radiusM, 4828);
  assert.equal(result.status, 'ready');
  assert.equal(result.features.length, 1);
  assert.deepEqual(result.features[0].geometry.coordinates, [
    [-82.37, 36.31],
    [-82.36, 36.32],
  ]);
  assert.equal(result.features[0].properties.name, 'Main Road');
  const query = new URLSearchParams(init.body).get('data');
  assert.match(query, /around:4828,36\.320692,-82\.342509/);
  assert.match(query, /out tags geom 350/);
  assert.match(result.message, /does not establish legal site access/);
});

test('road source errors and Overpass remarks are failures, not empty road coverage', async () => {
  await assert.rejects(
    loadRoads(TEST_POINT, 1609, {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ remark: 'runtime error: timed out', elements: [] }),
          { status: 200 },
        ),
    }),
  );
  await assert.rejects(
    loadRoads(TEST_POINT, 1609, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ elements: null }), { status: 200 }),
    }),
    /Roads unavailable/,
  );
});

test('road result is capped at 350 ways and marks truncated results partial', async () => {
  const elements = Array.from({ length: 351 }, (_, i) => ({
    type: 'way',
    tags: { ref: `R-${i}` },
    geometry: [
      { lat: 36.31, lon: -82.37 },
      { lat: 36.32, lon: -82.36 },
    ],
  }));
  const result = await loadRoads(TEST_POINT, 1609, {
    fetchImpl: async () =>
      new Response(JSON.stringify({ elements }), { status: 200 }),
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.features.length, 350);
  assert.equal(result.features.at(-1).properties.name, 'R-349');
});

test('Atlanta parcel and zoning queries use fixed official point layers', async () => {
  const requestUrls = [];
  const result = await loadParcel(ATLANTA, {
    jurisdiction: {
      id: 'atlanta-ga',
      status: 'resolved',
      crossesBoundary: false,
    },
    fetchImpl: async (url, init) => {
      requestUrls.push(String(url));
      assert.ok(init.signal instanceof AbortSignal);
      if (String(url).includes('OpenDataService1'))
        return json({
          features: [
            {
              attributes: {
                ZONECLASS: 'SPI-1',
                ZONEDESC: 'Special public interest',
              },
              geometry: { rings: [square] },
            },
          ],
        });
      return json({
        features: [
          {
            type: 'Feature',
            attributes: {
              PIN: '14-0012-0001',
              SITEADDRESS: '1 Peachtree St',
              ZONING: 'C-3',
              ACRES: 0.8,
            },
            geometry: { rings: [square] },
          },
        ],
      });
    },
  });
  const parsed = new URL(requestUrls.find((u) => u.includes('CadastralLots')));
  assert.equal(requestUrls.length, 2);
  assert.ok(
    requestUrls.every((u) => new URL(u).origin === 'https://gis.atlantaga.gov'),
  );
  assert.equal(
    parsed.pathname,
    '/dpcd/rest/services/LandUsePlanning/CadastralLots/MapServer/17/query',
  );
  assert.equal(parsed.searchParams.get('geometry'), '-84.39,33.75');
  assert.equal(parsed.searchParams.get('geometryType'), 'esriGeometryPoint');
  assert.equal(
    parsed.searchParams.get('spatialRel'),
    'esriSpatialRelIntersects',
  );
  assert.equal(parsed.searchParams.get('returnGeometry'), 'true');
  assert.equal(parsed.searchParams.get('outSR'), '4326');
  assert.equal(result.status, 'ready');
  assert.equal(
    result.source,
    'https://gis.atlantaga.gov/dpcd/rest/services/OpenDataService1/FeatureServer/22',
  );
  assert.equal(
    PARCEL_SOURCE,
    'https://gis.atlantaga.gov/dpcd/rest/services/LandUsePlanning/CadastralLots/MapServer/17',
  );
  assert.equal(result.features[0].geometry.type, 'MultiPolygon');
  assert.equal(result.features[0].properties.PIN, '14-0012-0001');
  assert.equal(result.zoningFeatures[0].properties.ZONECLASS, 'SPI-1');
  assert.match(result.message, /screening observation/);
});

test('Johnson City parcel and zoning are queried as separate official point layers', async () => {
  const urls = [];
  const result = await loadParcel(TEST_POINT, {
    fetchImpl: async (url) => {
      const u = new URL(String(url));
      urls.push(u);
      const zoning = u.pathname.includes('Zoning_and_Overlays');
      return json({
        features: [
          {
            type: 'Feature',
            attributes: zoning
              ? { ZONECLASS: 'R-4' }
              : { ADDRESS: '601 E Main St', WATER: 'Yes', SEWER: 'Yes' },
            geometry: {
              rings: [square.map(([x, y]) => [x + 1.975, y + 2.56])],
            },
          },
        ],
      });
    },
  });
  assert.equal(urls.length, 2);
  assert.ok(urls.some((u) => u.href.startsWith(JC_PARCEL_SOURCE + '/query?')));
  assert.ok(urls.some((u) => u.href.startsWith(JC_ZONING_SOURCE + '/query?')));
  for (const url of urls) {
    assert.equal(url.searchParams.get('geometry'), '-82.342509,36.320692');
    assert.equal(url.searchParams.get('geometryType'), 'esriGeometryPoint');
    assert.equal(
      url.searchParams.get('spatialRel'),
      'esriSpatialRelIntersects',
    );
  }
  assert.equal(result.status, 'ready');
  assert.equal(result.parcelFeatures[0].properties.ADDRESS, '601 E Main St');
  assert.equal(result.zoningFeatures[0].properties.ZONECLASS, 'R-4');
  assert.match(result.message, /utility flags do not establish capacity/);
});

test('Johnson City parcel survives zoning-layer outage as partial, independently sourced data', async () => {
  const result = await loadParcel(TEST_POINT, {
    fetchImpl: async (url) => {
      if (String(url).includes('Zoning_and_Overlays'))
        return new Response('{}', { status: 503 });
      return json({
        features: [
          {
            attributes: { ADDRESS: '601 E Main St' },
            geometry: {
              rings: [square.map(([x, y]) => [x + 1.975, y + 2.56])],
            },
          },
        ],
      });
    },
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.parcelStatus, 'ready');
  assert.equal(result.zoningStatus, 'unavailable');
  assert.equal(result.parcelFeatures.length, 1);
  assert.equal(result.zoningFeatures.length, 0);
  assert.match(result.message, /parcel: ready; zoning: unavailable/);
});

test('parcel coverage outside Atlanta is explicitly unsupported and makes no request', async () => {
  let calls = 0;
  const result = await loadParcel(
    { lat: 40.7, lon: -74 },
    {
      fetchImpl: async () => {
        calls += 1;
      },
    },
  );
  assert.equal(calls, 0);
  assert.equal(result.status, 'unsupported');
  assert.deepEqual(result.features, []);
  assert.match(result.message, /tested city packages/);
  assert.doesNotMatch(result.message, /no parcel|no zoning/i);
});

test('a cached source transport failure is retried and replaced after recovery', async () => {
  let crimeCalls = 0;
  const handler = creNeighborhoodHandler({
    cache: createCreCache({
      family: 'neighborhood-retry-test',
      ttlMs: 86_400_000,
      disk: false,
    }),
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes('data.cityofchicago.org')) {
        crimeCalls += 1;
        if (crimeCalls === 1) throw new Error('temporary source outage');
        return json([
          {
            date: '2026-09-14T12:00:00.000',
            primary_type: 'THEFT',
            latitude: '41.88',
            longitude: '-87.63',
          },
        ]);
      }
      return json({ elements: [] });
    },
    failureCache: {
      getFresh: async () => null,
      set: async (key, value) => ({ key, value, cachedAt: Date.now() }),
    },
  });
  const query = 'lat=41.88&lon=-87.63&radiusM=1609';

  const failed = await call(handler, query);
  assert.equal(failed.status, 200);
  assert.equal(failed.json().data.crime.status, 'unavailable');
  assert.deepEqual(failed.json().data.crime.features, []);

  const recovered = await call(handler, query);
  assert.equal(recovered.status, 200);
  assert.equal(
    crimeCalls,
    2,
    'fresh cached failures should not suppress retries',
  );
  assert.equal(recovered.json().data.crime.status, 'ready');
  assert.equal(recovered.json().data.crime.features.length, 1);
  assert.deepEqual(
    recovered.json().data.crime.features[0].geometry.coordinates,
    [-87.63, 41.88],
  );
});

test('unavailable neighborhood observations have a short retry TTL instead of refetching on every request', async () => {
  let now = 1_000_000;
  let calls = 0;
  const handler = creNeighborhoodHandler({
    cache: createCreCache({
      family: 'neighborhood-success-cache-test',
      ttlMs: 86_400_000,
      disk: false,
      now: () => now,
    }),
    failureCache: createCreCache({
      family: 'neighborhood-failure-cache-test',
      ttlMs: 300_000,
      disk: false,
      now: () => now,
    }),
    fetchImpl: async () => {
      calls += 1;
      throw new Error('source outage');
    },
  });
  const query = 'lat=41.88&lon=-87.63&radiusM=1609';
  await call(handler, query);
  const firstCalls = calls;
  assert.ok(firstCalls >= 2);
  await call(handler, query);
  assert.equal(
    calls,
    firstCalls,
    'failure result is served within its short retry window',
  );
  now += 300_001;
  await call(handler, query);
  assert.ok(
    calls > firstCalls,
    'expired failure cache triggers another source check',
  );
});

test('partial neighborhood observations use the short retry cache', async () => {
  let shortWrites = 0;
  let successWrites = 0;
  const handler = creNeighborhoodHandler({
    cache: {
      getFresh: async () => null,
      getStale: async () => null,
      set: async () => {
        successWrites += 1;
        return { value: {}, cachedAt: Date.now() };
      },
    },
    failureCache: {
      getFresh: async () => null,
      set: async (_key, value) => {
        shortWrites += 1;
        return { value, cachedAt: Date.now() };
      },
    },
    fetchImpl: async (url) =>
      String(url).includes('data.cityofchicago.org')
        ? json(
            Array.from({ length: 2001 }, () => ({
              date: '2026-09-14T12:00:00.000',
              primary_type: 'THEFT',
              latitude: '41.88',
              longitude: '-87.63',
            })),
          )
        : json({ elements: [] }),
  });
  const response = await call(handler, 'lat=41.88&lon=-87.63&radiusM=1609');
  assert.equal(response.json().data.crime.status, 'partial');
  assert.equal(shortWrites, 1);
  assert.equal(successWrites, 0);
});

test('manual neighborhood refresh bypasses a fresh cache once and then throttles repeat requests', async () => {
  let crimeCalls = 0;
  const handler = creNeighborhoodHandler({
    cache: createCreCache({
      family: 'neighborhood-refresh-test',
      ttlMs: 86_400_000,
      disk: false,
    }),
    failureCache: createCreCache({
      family: 'neighborhood-refresh-failure-test',
      ttlMs: 300_000,
      disk: false,
    }),
    fetchImpl: async (url) => {
      if (String(url).includes('data.cityofchicago.org')) {
        crimeCalls += 1;
        return json([
          {
            date: '2026-09-14T12:00:00.000',
            primary_type: 'THEFT',
            latitude: '41.88',
            longitude: '-87.63',
          },
        ]);
      }
      return json({ elements: [] });
    },
  });
  const query = 'lat=41.88&lon=-87.63&radiusM=1609';
  await call(handler, query);
  assert.equal(crimeCalls, 1);
  const refreshed = await call(handler, `${query}&refresh=1`);
  assert.equal(crimeCalls, 2);
  assert.equal(refreshed.json().refresh.status, 'succeeded');
  const repeat = await call(handler, `${query}&refresh=1`);
  assert.equal(crimeCalls, 2);
  assert.equal(repeat.json().refresh.status, 'throttled');
});

test('neighborhood route rejects out-of-range coordinates and radius before calling any provider', async () => {
  let calls = 0;
  const handler = creNeighborhoodHandler({
    fetchImpl: async () => {
      calls += 1;
    },
    cache: createCreCache({
      family: 'neighborhood-test',
      ttlMs: 60_000,
      disk: false,
    }),
  });
  for (const [query, message] of [
    ['lat=91&lon=-82', CRE_ERRORS.BAD_POINT],
    ['lat=36.3&lon=-82.3&radiusM=8048', CRE_ERRORS.BAD_RADIUS],
  ]) {
    const res = fakeRes();
    await handler(
      {
        method: 'GET',
        url: `/?${query}`,
        socket: { remoteAddress: '127.0.0.1' },
      },
      res,
    );
    assert.equal(res.status, 400);
    assert.deepEqual(res.json(), { error: message });
  }
  assert.equal(calls, 0);
});

test('a refresh using retained observations reports failure and keeps their age', async () => {
  const old = Date.parse('2026-09-01T00:00:00Z');
  const handler = creNeighborhoodHandler({
    cache: {
      getFresh: async () => null,
      getStale: async () => ({
        cachedAt: old,
        value: {
          crime: { status: 'ready', features: [] },
          roads: { status: 'ready', features: [] },
        },
      }),
    },
    failureCache: {
      getFresh: async () => null,
      set: async (_key, value) => ({
        value,
        cachedAt: Date.parse('2026-09-23T00:00:00Z'),
      }),
    },
    fetchImpl: async () => {
      throw new Error('fixture outage');
    },
  });
  const response = await call(
    handler,
    'lat=41.88&lon=-87.63&radiusM=1609&refresh=1',
  );
  const body = response.json();
  assert.equal(body.data.crime.stale, true);
  assert.equal(body.refresh.status, 'failed');
  assert.equal(body.retrievedAt, new Date(old).toISOString());
  assert.equal(body.refresh.dataRetrievedAt, body.retrievedAt);
  assert.notEqual(body.refresh.attemptedAt, body.retrievedAt);
});

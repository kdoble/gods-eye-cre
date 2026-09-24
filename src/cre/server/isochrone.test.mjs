// Tests for the isochrone family: area within 1 percent of an independent shoelace value, no-polygon answers unavailable (not zero-area ready), the ORS key kept out of URLs and bodies, and the OSRM route summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SQ_METERS_PER_SQ_MILE,
  geometryAreaM2,
  isochroneHandler,
  loadIsochrone,
  loadRoute,
  normalizeIsochrone,
} from '../../../server/providers/cre/isochrone.js';
import { createCreCache } from '../../../server/providers/cre/common/cache.js';

const SITE = { lat: 36.320692, lon: -82.342509, minutes: 15 };

/** An irregular 7-vertex polygon around the site, about 8 by 6 miles. */
const RING = [
  [-82.44, 36.27],
  [-82.36, 36.24],
  [-82.29, 36.28],
  [-82.3, 36.35],
  [-82.35, 36.37],
  [-82.42, 36.36],
  [-82.45, 36.32],
  [-82.44, 36.27],
];
const FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { contour: 15 },
      geometry: { type: 'Polygon', coordinates: [RING] },
    },
  ],
};

/** Independent check: planar shoelace on a local equal-scale projection. */
function shoelaceM2(ring) {
  const lat0 =
    (ring.reduce((s, p) => s + p[1], 0) / ring.length) * (Math.PI / 180);
  const R = 6371008.8;
  const pts = ring.map(([x, y]) => [
    R * x * (Math.PI / 180) * Math.cos(lat0),
    R * y * (Math.PI / 180),
  ]);
  let twice = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    twice += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
  }
  return Math.abs(twice) / 2;
}

const memCache = () =>
  createCreCache({ family: 'test', ttlMs: 60_000, disk: false });
function fakeRes() {
  return {
    status: 0,
    body: '',
    headersSent: false,
    writeHead(s) {
      this.status = s;
      this.headersSent = true;
    },
    end(b = '') {
      this.body = b;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

test('fixture area is within 1 percent of the shoelace value', () => {
  const data = normalizeIsochrone(FIXTURE, SITE);
  const expected = shoelaceM2(RING) / SQ_METERS_PER_SQ_MILE;
  assert.ok(data.areaSqMi > 20, `plausible size, got ${data.areaSqMi}`);
  assert.ok(
    Math.abs(data.areaSqMi - expected) / expected < 0.01,
    `${data.areaSqMi} vs ${expected}`,
  );
  assert.ok(data.maxDistanceM > 5000);
});

test('a hole is subtracted from the polygon area', () => {
  const hole = [
    [-82.37, 36.3],
    [-82.37, 36.31],
    [-82.36, 36.31],
    [-82.36, 36.3],
    [-82.37, 36.3],
  ];
  const full = geometryAreaM2({ type: 'Polygon', coordinates: [RING] });
  const holed = geometryAreaM2({ type: 'Polygon', coordinates: [RING, hole] });
  assert.ok(
    Math.abs(full - holed - shoelaceM2(hole)) / shoelaceM2(hole) < 0.01,
  );
});

test('NEGATIVE: no features, or line contours only, is unavailable and never a zero-area ready', async () => {
  assert.equal(
    normalizeIsochrone({ type: 'FeatureCollection', features: [] }, SITE),
    null,
  );
  const lines = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: RING } },
    ],
  };
  assert.equal(normalizeIsochrone(lines, SITE), null);
  const degenerate = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [1, 1],
              [1, 1],
              [1, 1],
              [1, 1],
            ],
          ],
        },
      },
    ],
  };
  assert.equal(normalizeIsochrone(degenerate, SITE), null);
  const handler = isochroneHandler({
    env: {},
    fetchImpl: async () =>
      Response.json({ type: 'FeatureCollection', features: [] }),
    cache: memCache(),
    limiter: null,
  });
  const res = fakeRes();
  await handler(
    { url: '/?lat=36.320692&lon=-82.342509', method: 'GET', socket: {} },
    res,
  );
  const body = res.json();
  assert.equal(body.status, 'unavailable');
  assert.equal(body.data, null);
  assert.ok(body.message);
});

test('Valhalla is called keyless with polygons requested', async () => {
  let seen = '';
  const result = await loadIsochrone(SITE, {
    env: {},
    fetchImpl: async (url) => {
      seen = String(url);
      return Response.json(FIXTURE);
    },
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.data.provider, 'valhalla');
  const query = JSON.parse(new URL(seen).searchParams.get('json'));
  assert.equal(query.polygons, true);
  assert.deepEqual(query.contours, [{ time: 15 }]);
});

test('NEGATIVE: the ORS key goes in a header, never a URL or a body sent to the client', async () => {
  const secret = 'ors-secret-fixture-123';
  let seenUrl = '';
  let seenAuth = '';
  const handler = isochroneHandler({
    env: { ORS_API_KEY: secret },
    fetchImpl: async (url, init) => {
      seenUrl = String(url);
      seenAuth = init.headers.Authorization;
      return Response.json(FIXTURE);
    },
    cache: memCache(),
    limiter: null,
  });
  const res = fakeRes();
  await handler(
    {
      url: '/?lat=36.320692&lon=-82.342509&minutes=15',
      method: 'GET',
      socket: {},
    },
    res,
  );
  assert.equal(res.json().data.provider, 'openrouteservice');
  assert.equal(seenAuth, secret);
  assert.ok(!seenUrl.includes(secret));
  assert.ok(!res.body.includes(secret));
});

test('NEGATIVE: minutes outside 5..60 is refused', async () => {
  const handler = isochroneHandler({
    env: {},
    fetchImpl: async () => Response.json(FIXTURE),
    cache: memCache(),
    limiter: null,
  });
  const res = fakeRes();
  await handler(
    { url: '/?lat=36.3&lon=-82.3&minutes=500', method: 'GET', socket: {} },
    res,
  );
  assert.equal(res.status, 400);
});

test('OSRM route yields duration and distance; a NoRoute answer is unavailable', async () => {
  const ok = await loadRoute(
    { lat: 36.3, lon: -82.36, toLat: 36.32, toLon: -82.35 },
    {
      fetchImpl: async () =>
        Response.json({
          code: 'Ok',
          routes: [{ duration: 285.9, distance: 2807.2 }],
        }),
    },
  );
  assert.deepEqual(ok.data, { durationS: 285.9, distanceM: 2807.2 });
  const none = await loadRoute(
    { lat: 36.3, lon: -82.36, toLat: 36.32, toLon: -82.35 },
    { fetchImpl: async () => Response.json({ code: 'NoRoute' }) },
  );
  assert.equal(none.status, 'unavailable');
});

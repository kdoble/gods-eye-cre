// Tests for /api/cre/amenities: the Overpass query, counting and nearest from a fixture payload, and the negatives that a 406 or 504 from every mirror yields the fixed unavailable message.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AMENITY_OVERPASS_ENDPOINTS,
  buildAmenitiesQuery,
  creAmenitiesHandler,
  loadAmenities,
  summarizeAmenities,
} from '../../../server/providers/cre/amenities.js';
import { createCreCache } from '../../../server/providers/cre/common/cache.js';
import { CRE_ERRORS } from '../../../server/providers/cre/common/route.js';

const SITE = { lat: 36.3207, lon: -82.3425 };
// Every element below is shifted by the same delta the site itself moved
// (test point migration, 2026-09-24: +0.011227 lat, +0.023098 lon) so each
// keeps its originally-designed distance and in-range/out-of-range status
// relative to SITE, rather than being stranded at the old site's location.
const PAYLOAD = {
  version: 0.6,
  osm3s: { timestamp_osm_base: '2026-09-22T15:15:20Z' },
  elements: [
    {
      type: 'node',
      id: 1,
      lat: 36.327927,
      lon: -82.329402,
      tags: { shop: 'supermarket', name: 'Food City' },
    },
    {
      type: 'way',
      id: 2,
      center: { lat: 36.312227, lon: -82.346902 },
      tags: { shop: 'supermarket', name: 'Kroger' },
    },
    {
      type: 'node',
      id: 3,
      lat: 36.319227,
      lon: -82.340902,
      tags: { amenity: 'pharmacy', shop: 'chemist', name: 'CVS' },
    },
    {
      type: 'node',
      id: 4,
      lat: 36.319027,
      lon: -82.341102,
      tags: { amenity: 'fast_food', name: "McDonald's" },
    },
    {
      type: 'node',
      id: 5,
      lat: 36.321227,
      lon: -82.342902,
      tags: { amenity: 'restaurant' },
    },
    {
      type: 'node',
      id: 6,
      lat: 36.318227,
      lon: -82.342202,
      tags: { highway: 'bus_stop' },
    },
    {
      type: 'way',
      id: 7,
      center: { lat: 36.318627, lon: -82.353102 },
      tags: { amenity: 'hospital', name: 'VA Medical Center' },
    },
    {
      type: 'way',
      id: 8,
      center: { lat: 36.351227, lon: -82.342502 },
      tags: { amenity: 'hospital', name: 'Far Hospital' },
    },
    {
      type: 'way',
      id: 9,
      center: { lat: 36.323827, lon: -82.349002 },
      tags: { leisure: 'park', name: 'Beeson Park' },
    },
    {
      type: 'node',
      id: 10,
      lat: 36.361227,
      lon: -82.342502,
      tags: { shop: 'supermarket', name: 'Out of range' },
    },
    {
      type: 'node',
      id: 3,
      lat: 36.319227,
      lon: -82.340902,
      tags: { amenity: 'pharmacy', name: 'CVS duplicate' },
    },
    {
      type: 'node',
      id: 11,
      lat: 36.320227,
      lon: -82.341902,
      tags: { shop: 'wholesale', name: "Sam's Club" },
    },
    { type: 'node', id: 12, lat: 36.320227, lon: -82.341902 },
  ],
};

test('the Overpass query covers every category at 1 mile and hospitals at 3 miles', () => {
  const ql = buildAmenitiesQuery(SITE.lat, SITE.lon);
  assert.match(ql, /^\[out:json\]\[timeout:25\];/);
  assert.match(ql, /supermarket\|grocery/);
  assert.match(ql, /fitness_centre\|park/);
  assert.match(ql, /"highway"="bus_stop"\]\(around:1609,/);
  assert.match(ql, /"amenity"="hospital"\]\(around:4828,/);
  assert.match(ql, /out tags center qt;$/);
});

test('a fixture Overpass payload yields counts and nearest per category', () => {
  const out = summarizeAmenities(PAYLOAD, SITE);
  const c = out.categories;
  assert.equal(c.grocery.count, 2, 'the 4.5 km supermarket is outside 1 mile');
  assert.equal(c.grocery.nearest.name, 'Kroger');
  assert.equal(
    c.pharmacy.count,
    1,
    'one element with two pharmacy tags, plus a duplicate id, counts once',
  );
  assert.equal(c.restaurants.count, 2);
  assert.equal(c.restaurants.nearest.name, null);
  assert.equal(c.transit.count, 1);
  assert.equal(c.hospitals.count, 1);
  assert.equal(c.hospitals.nearest.name, 'VA Medical Center');
  assert.equal(c.parks.count, 1);
  assert.equal(c.bigBox.count, 1);
  assert.equal(c.gyms.count, 0);
  assert.equal(c.gyms.nearest, null);
});

test('a hospital between 1 and 3 miles is the nearest but not counted', () => {
  const out = summarizeAmenities(
    {
      elements: [
        {
          type: 'node',
          id: 1,
          lat: 36.34,
          lon: -82.3425,
          tags: { amenity: 'hospital', name: 'Mid' },
        },
      ],
    },
    SITE,
  );
  assert.equal(out.categories.hospitals.count, 0);
  assert.equal(out.categories.hospitals.nearest.name, 'Mid');
});

test('NEGATIVE: an Overpass runtime-error remark is not treated as data', () => {
  assert.throws(
    () =>
      summarizeAmenities(
        { elements: [], remark: 'runtime error: Query timed out' },
        SITE,
      ),
    { code: 'UPSTREAM' },
  );
  assert.throws(() => summarizeAmenities({ nope: true }, SITE), {
    code: 'BAD_PAYLOAD',
  });
});

function fakeRes() {
  return {
    status: 0,
    body: '',
    headersSent: false,
    writeHead(status) {
      this.status = status;
      this.headersSent = true;
    },
    end(body = '') {
      this.body = body;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}
const req = (url) => ({
  url,
  method: 'GET',
  socket: { remoteAddress: '127.0.0.1' },
});
const memCache = () =>
  createCreCache({ family: 'amenities-test', ttlMs: 60_000, disk: false });
const ENDPOINTS = [
  'https://a.test/api/interpreter',
  'https://b.test/api/interpreter',
];

const HTML_406 =
  '<!DOCTYPE HTML><html><head><title>406 Not Acceptable</title></head><body>Not Acceptable</body></html>';

for (const status of [406, 504]) {
  test(`NEGATIVE: HTTP ${status} from every mirror yields unavailable with the fixed message`, async (t) => {
    t.mock.method(console, 'error', () => {});
    const hits = [];
    const handler = creAmenitiesHandler({
      fetchImpl: async (url) => {
        hits.push(url);
        return new Response(HTML_406, {
          status,
          headers: { 'content-type': 'text/html' },
        });
      },
      endpoints: ENDPOINTS,
      cache: memCache(),
      limiter: null,
    });
    const res = fakeRes();
    await handler(req('/?lat=36.3207&lon=-82.3425'), res);
    assert.equal(res.status, 502);
    assert.deepEqual(res.json(), { error: CRE_ERRORS.UPSTREAM });
    assert.ok(!res.body.includes('Acceptable'));
    assert.deepEqual(hits, ENDPOINTS, 'every mirror tried once');
  });
}

test('a refusing first mirror rotates to a healthy second one', async () => {
  const data = await loadAmenities(SITE, {
    endpoints: ENDPOINTS,
    fetchImpl: async (url) =>
      url.startsWith('https://a.test')
        ? new Response(HTML_406, { status: 406 })
        : new Response(JSON.stringify(PAYLOAD), {
            headers: { 'content-type': 'application/json' },
          }),
  });
  assert.equal(data.mirror, 'b.test');
  assert.equal(data.categories.grocery.count, 2);
  assert.equal(data.osmBase, '2026-09-22T15:15:20Z');
});

test('route: ready body, lat=91 refused, and no mapped features is status empty', async () => {
  const handler = creAmenitiesHandler({
    fetchImpl: async () => new Response(JSON.stringify(PAYLOAD)),
    endpoints: ENDPOINTS,
    cache: memCache(),
    limiter: null,
  });
  const ok = fakeRes();
  await handler(req('/?lat=36.3207&lon=-82.3425'), ok);
  assert.equal(ok.status, 200);
  assert.equal(ok.json().status, 'ready');
  assert.equal(ok.json().source.license, 'ODbL 1.0');

  const bad = fakeRes();
  await handler(req('/?lat=91&lon=0'), bad);
  assert.equal(bad.status, 400);

  const none = creAmenitiesHandler({
    fetchImpl: async () => new Response(JSON.stringify({ elements: [] })),
    endpoints: ENDPOINTS,
    cache: memCache(),
    limiter: null,
  });
  const res = fakeRes();
  await none(req('/?lat=45&lon=-110'), res);
  assert.equal(res.json().status, 'empty');
});

test('the verified-working mirrors go first and the repo list stays as fallback', () => {
  assert.equal(
    AMENITY_OVERPASS_ENDPOINTS[0],
    'https://overpass.openstreetmap.fr/api/interpreter',
  );
  assert.ok(
    AMENITY_OVERPASS_ENDPOINTS.includes(
      'https://overpass-api.de/api/interpreter',
    ),
  );
});

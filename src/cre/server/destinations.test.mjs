import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDestinationsQuery,
  loadDestinations,
  selectDestinations,
  selectMapPlaces,
  creDestinationsProxy,
  DESTINATIONS_CACHE_FAMILY,
} from '../../../server/providers/cre/destinations.js';
import { createCreCache } from '../../../server/providers/cre/common/cache.js';

const site = { lat: 36.320692, lon: -82.342509 };
// Every element below is shifted by the same delta the site itself moved
// (test point migration, 2026-09-24: +0.011227 lat, +0.023098 lon) so each
// keeps its originally-designed distance and order relative to `site`.
const osm = {
  osm3s: { timestamp_osm_base: '2026-09-23T00:00:00Z' },
  elements: [
    {
      type: 'node',
      id: 1,
      lat: 36.321227,
      lon: -82.336902,
      tags: { shop: 'supermarket', name: 'Market A' },
    },
    {
      type: 'way',
      id: 2,
      center: { lat: 36.331227, lon: -82.336902 },
      tags: { amenity: 'pharmacy', name: 'Pharmacy B' },
    },
    {
      type: 'node',
      id: 3,
      lat: 36.341227,
      lon: -82.336902,
      tags: { shop: 'mall', name: 'Mall C' },
    },
    {
      type: 'node',
      id: 4,
      lat: 36.321227,
      lon: -82.336902,
      tags: { shop: 'supermarket' },
    },
    {
      type: 'node',
      id: 5,
      lat: 36.511227,
      lon: -82.336902,
      tags: { shop: 'supermarket', name: 'Outside radius' },
    },
    {
      type: 'node',
      id: 6,
      lat: 36.322227,
      lon: -82.337902,
      tags: { office: 'company', name: 'Regional Office' },
    },
    {
      type: 'way',
      id: 7,
      center: { lat: 36.323227, lon: -82.338902 },
      tags: { amenity: 'hospital', name: 'Medical Campus' },
    },
    {
      type: 'node',
      id: 8,
      lat: 36.324227,
      lon: -82.338902,
      tags: { office: 'lawyer', name: 'Legal Office' },
    },
    {
      type: 'node',
      id: 9,
      lat: 36.325227,
      lon: -82.338902,
      tags: { office: 'company' },
    },
  ],
};
const response = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

test('destination query bounds daily needs and named workplace candidates to five kilometres', () => {
  const q = buildDestinationsQuery(site.lat, site.lon);
  assert.match(q, /around:5000,36\.320692,-82\.342509/);
  assert.match(q, /supermarket\|grocery/);
  assert.match(q, /amenity.*pharmacy/);
  assert.match(q, /office.*company/);
  assert.match(q, /amenity.*hospital/);
  assert.ok(!q.includes('employee_count'));
});

test('named workplace selection keeps supported offices and campuses, not all businesses', () => {
  const selected = selectMapPlaces(osm, site).filter(
    (item) => item.category === 'employers',
  );
  assert.deepEqual(
    selected.map((item) => item.name),
    ['Medical Campus', 'Regional Office'],
  );
  assert.deepEqual(
    selected.map((item) => item.workplaceType),
    ['hospital', 'office'],
  );
  assert.ok(selected.every((item) => item.straightDistanceM <= 5000));
});

test('selection keeps named nearby grocery, pharmacy and retail destinations only', () => {
  const selected = selectDestinations(osm, site);
  assert.deepEqual(
    selected.map((item) => item.name),
    ['Market A', 'Pharmacy B', 'Mall C'],
  );
  assert.ok(selected.every((item) => item.straightDistanceM <= 5000));
});

test('POI provider preserves named destinations separately from the shared route service', async () => {
  const calls = [];
  const data = await loadDestinations(site, {
    endpoints: ['https://overpass.test/api/interpreter'],
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      assert.ok(String(url).includes('overpass.test'));
      return response(osm);
    },
  });
  assert.equal(
    calls.length,
    1,
    'the server never bypasses the shared route proxy',
  );
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(data.status, 'ready');
  assert.equal(data.destinations.length, 3);
  assert.equal(data.destinations[0].walkDurationS, undefined);
  const workplaces = data.features.filter(
    (feature) => feature.properties.category === 'employers',
  );
  assert.equal(workplaces.length, 2);
  assert.ok(workplaces.every((feature) => feature.properties.named === true));
  assert.ok(
    workplaces.every((feature) =>
      feature.properties.sourceUrl.startsWith('https://www.openstreetmap.org/'),
    ),
  );
  assert.ok(
    workplaces.every((feature) => !('employeeCount' in feature.properties)),
  );
  assert.match(data.message, /Routed travel times are added separately/);
});

test('new destination cache family cannot serve nameless pre-upgrade map geometry', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'cre-destinations-cache-'));
  try {
    const legacy = createCreCache({
      family: 'cre-destinations-v1',
      ttlMs: 86400000,
      rootDir,
    });
    const current = createCreCache({
      family: DESTINATIONS_CACHE_FAMILY,
      ttlMs: 86400000,
      rootDir,
    });
    await legacy.set('32.8673,-96.683', {
      features: [{ properties: { name: 'Legacy store' } }],
    });
    assert.equal(await current.getFresh('32.8673,-96.683'), null);
    const fresh = await current.getOrLoad('32.8673,-96.683', () =>
      loadDestinations(site, {
        endpoints: ['https://overpass.test/api/interpreter'],
        fetchImpl: async () =>
          response({
            ...osm,
            elements: [
              ...osm.elements,
              {
                type: 'node',
                id: 7,
                lat: 36.322227,
                lon: -82.336902,
                tags: { shop: 'supermarket', name: 'Market D' },
              },
              {
                type: 'node',
                id: 18,
                lat: 36.323227,
                lon: -82.336902,
                tags: { amenity: 'cafe', name: 'Coffee E' },
              },
            ],
          }),
      }),
    );
    assert.equal(fresh.source, 'MISS');
    assert.ok(
      fresh.value.features.every(
        (feature) => feature.properties.named === true,
      ),
    );
    assert.deepEqual(
      fresh.value.destinations
        .filter((item) => item.category === 'grocery')
        .map((item) => item.name),
      ['Market A'],
    );
    assert.deepEqual(
      fresh.value.features
        .filter((feature) => feature.properties.category === 'grocery')
        .map((feature) => feature.properties.name),
      ['Market A', 'Market D'],
    );
    assert.ok(
      fresh.value.features.some(
        (feature) => feature.properties.name === 'Coffee E',
      ),
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('empty destination response avoids routing and stays an explicit empty source observation', async () => {
  let calls = 0;
  const data = await loadDestinations(site, {
    endpoints: ['https://overpass.test/api/interpreter'],
    fetchImpl: async () => {
      calls += 1;
      return response({ elements: [] });
    },
  });
  assert.equal(calls, 1);
  assert.equal(data.status, 'empty');
  assert.deepEqual(data.destinations, []);
});

test('preview proxy registers middleware without returning it as a Vite post-hook', () => {
  const calls = [];
  const proxy = creDestinationsProxy();
  const result = proxy.configurePreviewServer({
    middlewares: {
      use: (...args) => {
        calls.push(args);
        return function unintendedPostHook() {};
      },
    },
  });
  assert.equal(result, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/cre/destinations');
});

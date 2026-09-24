// Tests for the CRE ArcGIS query helper, including the negative case that an HTTP 200 error body must reject.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ArcgisError,
  ARCGIS_ERROR_MESSAGES,
  arcgisQuery,
  queryCount,
  queryEnvelope,
  queryPoint,
  queryRadius,
} from '../../../server/providers/cre/common/arcgis.js';

const LAYER = 'https://example.test/arcgis/rest/services/X/MapServer/0';
const noSleep = async () => {};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next.clone();
  };
  return { fetchImpl, calls };
}

test('NEGATIVE: an {"error":{"code":400}} body with HTTP 200 rejects and is not retried', async () => {
  const { fetchImpl, calls } = mockFetch([
    jsonResponse({ error: { code: 400, message: 'secret upstream detail' } }),
  ]);
  await assert.rejects(
    queryPoint(
      LAYER,
      { lat: 36.3, lon: -82.36 },
      { fetchImpl, sleep: noSleep },
    ),
    (error) => {
      assert.ok(error instanceof ArcgisError);
      assert.equal(error.code, 'UPSTREAM_ERROR');
      assert.equal(error.message, ARCGIS_ERROR_MESSAGES.UPSTREAM_ERROR);
      assert.ok(!error.message.includes('secret'));
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test('queryPoint sends WGS84 in and out, lon,lat order, and returns features', async () => {
  const { fetchImpl, calls } = mockFetch([
    jsonResponse({ features: [{ attributes: { A: 1 } }] }),
  ]);
  const result = await queryPoint(
    LAYER,
    { lat: 36.320692, lon: -82.342509 },
    { fetchImpl, extra: { inSR: '3857' } },
  );
  assert.deepEqual(result, {
    features: [{ attributes: { A: 1 } }],
    exceededTransferLimit: false,
  });
  const params = calls[0].url.searchParams;
  assert.equal(
    calls[0].url.pathname,
    '/arcgis/rest/services/X/MapServer/0/query',
  );
  assert.equal(params.get('inSR'), '4326');
  assert.equal(params.get('outSR'), '4326');
  assert.equal(params.get('f'), 'json');
  assert.equal(params.get('geometry'), '-82.342509,36.320692');
  assert.equal(params.get('geometryType'), 'esriGeometryPoint');
});

test('queryRadius sends distance in meters', async () => {
  const { fetchImpl, calls } = mockFetch([jsonResponse({ features: [] })]);
  await queryRadius(
    LAYER,
    { lat: 33.77, lon: -84.37, radiusM: 1609.344 },
    { fetchImpl },
  );
  assert.equal(calls[0].url.searchParams.get('distance'), '1609.344');
  assert.equal(calls[0].url.searchParams.get('units'), 'esriSRUnit_Meter');
});

test('queryEnvelope sends an envelope and queryCount returns the count', async () => {
  const env = mockFetch([
    jsonResponse({ features: [], exceededTransferLimit: true }),
  ]);
  const result = await queryEnvelope(
    LAYER,
    { west: -84.4, south: 33.7, east: -84.3, north: 33.8 },
    { fetchImpl: env.fetchImpl },
  );
  assert.equal(result.exceededTransferLimit, true);
  const envParams = env.calls[0].url.searchParams;
  assert.equal(envParams.get('geometry'), '-84.4,33.7,-84.3,33.8');
  assert.equal(envParams.get('geometryType'), 'esriGeometryEnvelope');

  const count = mockFetch([jsonResponse({ count: 42 })]);
  const total = await queryCount(
    LAYER,
    { lat: 33.77, lon: -84.37, radiusM: 500 },
    { fetchImpl: count.fetchImpl },
  );
  assert.equal(total, 42);
  assert.equal(count.calls[0].url.searchParams.get('returnCountOnly'), 'true');
});

test('NEGATIVE: queryCount rejects a body without a numeric count', async () => {
  const { fetchImpl } = mockFetch([jsonResponse({ features: [] })]);
  await assert.rejects(
    queryCount(LAYER, { lat: 33.77, lon: -84.37, radiusM: 500 }, { fetchImpl }),
    { code: 'INVALID_RESPONSE' },
  );
});

test('retries HTTP 503 and ArcGIS 500 bodies with doubling backoff, then succeeds', async () => {
  const waits = [];
  const { fetchImpl, calls } = mockFetch([
    new Response('busy', { status: 503 }),
    jsonResponse({ error: { code: 500 } }),
    jsonResponse({ features: [] }),
  ]);
  const result = await queryPoint(
    LAYER,
    { lat: 1, lon: 1 },
    { fetchImpl, backoffMs: 100, sleep: async (ms) => waits.push(ms) },
  );
  assert.deepEqual(result.features, []);
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [100, 200]);
});

test('gives up after the retry budget with a fixed message', async () => {
  const { fetchImpl, calls } = mockFetch([
    new TypeError('socket hang up at 10.0.0.1'),
  ]);
  await assert.rejects(
    arcgisQuery(LAYER, {}, { fetchImpl, retries: 2, sleep: noSleep }),
    (error) =>
      error.code === 'HTTP_ERROR' && !error.message.includes('10.0.0.1'),
  );
  assert.equal(calls.length, 3);
});

test('HTTP 404 is not retried', async () => {
  const { fetchImpl, calls } = mockFetch([
    new Response('nope', { status: 404 }),
  ]);
  await assert.rejects(arcgisQuery(LAYER, {}, { fetchImpl, sleep: noSleep }), {
    code: 'HTTP_ERROR',
    status: 404,
  });
  assert.equal(calls.length, 1);
});

test('times out through AbortSignal and maps to TIMEOUT', async () => {
  const fetchImpl = (url, { signal }) =>
    new Promise((resolve, reject) => {
      // A real socket keeps the loop alive; the unref'd timeout timer does not.
      const keepAlive = setTimeout(() => {}, 1000);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(keepAlive);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  await assert.rejects(
    arcgisQuery(LAYER, {}, { fetchImpl, timeoutMs: 20, retries: 0 }),
    { code: 'TIMEOUT' },
  );
});

test('a caller abort is not retried', async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetchImpl = (url, { signal }) => {
    calls += 1;
    controller.abort();
    return Promise.reject(signal.reason);
  };
  await assert.rejects(
    arcgisQuery(
      LAYER,
      {},
      { fetchImpl, signal: controller.signal, sleep: noSleep },
    ),
    { code: 'ABORTED' },
  );
  assert.equal(calls, 1);
});

test('NEGATIVE: non-https or query-carrying layer URLs and bad points are refused before any fetch', async () => {
  const { fetchImpl, calls } = mockFetch([jsonResponse({ features: [] })]);
  const point = { lat: 1, lon: 1 };
  await assert.rejects(
    queryPoint('http://example.test/0', point, { fetchImpl }),
    { code: 'BAD_REQUEST' },
  );
  await assert.rejects(queryPoint(`${LAYER}?where=1`, point, { fetchImpl }), {
    code: 'BAD_REQUEST',
  });
  await assert.rejects(queryPoint(LAYER, { lat: 91, lon: 1 }, { fetchImpl }), {
    code: 'BAD_REQUEST',
  });
  await assert.rejects(
    queryRadius(LAYER, { lat: 1, lon: 1, radiusM: -5 }, { fetchImpl }),
    { code: 'BAD_REQUEST' },
  );
  assert.equal(calls.length, 0);
});

test('NEGATIVE: invalid JSON maps to INVALID_RESPONSE', async () => {
  const { fetchImpl } = mockFetch([new Response('<html>', { status: 200 })]);
  await assert.rejects(arcgisQuery(LAYER, {}, { fetchImpl, sleep: noSleep }), {
    code: 'INVALID_RESPONSE',
  });
});

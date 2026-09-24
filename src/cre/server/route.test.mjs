// Tests for the CRE route helpers and the health route, including the negative case that lat=91 is refused with a 400.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CRE_ERRORS,
  creRoute,
  parsePoint,
  parseRadiusM,
  sendError,
} from '../../../server/providers/cre/common/route.js';
import { creHealthHandler } from '../../../server/providers/cre/health.js';
import { creProviderPlugins } from '../../../server/providers/cre/index.js';

function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
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

const req = (url, method = 'GET') => ({
  url,
  method,
  socket: { remoteAddress: '127.0.0.1' },
});

/** A route that validates the point the way every family route will. */
const pointRoute = (options) =>
  creRoute(
    ({ res, params }) => {
      const point = parsePoint(params);
      if (!point.ok) return sendError(res, 400, CRE_ERRORS.BAD_POINT);
      res.writeHead(200, {});
      res.end(JSON.stringify(point));
    },
    { limiter: null, ...options },
  );

test('NEGATIVE: lat=91 answers 400 with the fixed message', async () => {
  const res = fakeRes();
  await pointRoute()(req('/?lat=91&lon=-82.36'), res);
  assert.equal(res.status, 400);
  assert.deepEqual(res.json(), { error: CRE_ERRORS.BAD_POINT });
});

test('parsePoint accepts the valid range and rejects junk', () => {
  assert.deepEqual(parsePoint(new URLSearchParams('lat=36.3&lon=-82.36')), {
    ok: true,
    lat: 36.3,
    lon: -82.36,
  });
  assert.deepEqual(parsePoint(new URLSearchParams('lat=90&lon=180')), {
    ok: true,
    lat: 90,
    lon: 180,
  });
  const bad = [
    'lat=-90.1&lon=0',
    'lat=0&lon=181',
    'lat=&lon=1',
    'lon=1',
    'lat=abc&lon=1',
    'lat=1&lon=Infinity',
  ];
  for (const query of bad) {
    assert.deepEqual(parsePoint(new URLSearchParams(query)), { ok: false });
  }
});

test('parseRadiusM falls back, and refuses out-of-range values', () => {
  const limits = { fallback: 1609.344, max: 10000 };
  const parse = (query) => parseRadiusM(new URLSearchParams(query), limits);
  assert.deepEqual(parse(''), { ok: true, radiusM: 1609.344 });
  assert.deepEqual(parse('radiusM=500'), { ok: true, radiusM: 500 });
  assert.deepEqual(parse('radiusM=0'), { ok: false });
  assert.deepEqual(parse('radiusM=10001'), { ok: false });
});

test('non-GET is 405, sub-paths are 404, and the limiter answers 429', async () => {
  const post = fakeRes();
  await pointRoute()(req('/?lat=1&lon=1', 'POST'), post);
  assert.equal(post.status, 405);

  const sub = fakeRes();
  await pointRoute()(req('/extra?lat=1&lon=1'), sub);
  assert.equal(sub.status, 404);

  let allowed = 1;
  const limited = pointRoute({ limiter: () => allowed-- > 0 });
  const first = fakeRes();
  await limited(req('/?lat=1&lon=1'), first);
  assert.equal(first.status, 200);
  const second = fakeRes();
  await limited(req('/?lat=1&lon=1'), second);
  assert.equal(second.status, 429);
  assert.deepEqual(second.json(), { error: CRE_ERRORS.RATE_LIMITED });
});

test('NEGATIVE: a thrown upstream error is answered with the fixed message, never its text', async (t) => {
  t.mock.method(console, 'error', () => {});
  const res = fakeRes();
  const route = creRoute(
    () => {
      throw Object.assign(new Error('upstream said: key=abc123'), {
        code: 'UPSTREAM_ERROR',
      });
    },
    { limiter: null },
  );
  await route(req('/'), res);
  assert.equal(res.status, 502);
  assert.deepEqual(res.json(), { error: CRE_ERRORS.UPSTREAM });
  assert.ok(!res.body.includes('abc123'));
  const logged = console.error.mock.calls.map((call) => call.arguments);
  assert.ok(!JSON.stringify(logged).includes('abc123'));
});

test('health reports key presence as booleans only', async () => {
  const res = fakeRes();
  const handler = creHealthHandler({ env: { CENSUS_API_KEY: 'secret-value' } });
  await handler(req('/'), res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), {
    status: 'ok',
    keys: { census: true, hud: false, dataGov: false },
  });
  assert.ok(!res.body.includes('secret-value'));
});

test('creProviderPlugins returns Vite plugins with dev and preview hooks', () => {
  const plugins = creProviderPlugins();
  assert.ok(Array.isArray(plugins));
  for (const plugin of plugins) {
    assert.equal(typeof plugin.name, 'string');
    assert.equal(typeof plugin.configureServer, 'function');
    assert.equal(typeof plugin.configurePreviewServer, 'function');
  }
});

// /api/cctv/frame's Street View fallback is the one paid-key route that had
// no rate limiter (server/providers/cctv.js). This pins it to the same
// default Google limiter used for Places (server/providers/common/rate-limit.js):
// calls beyond the per-IP cap get 429, not another billed Street View call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cctvProxy } from '../../server/providers/cctv.js';

const CAMERA = {
  id: 'streetview-fixture',
  name: 'Street View fixture',
  lat: 30.27,
  lon: -97.74,
  feedType: 'image',
  // No url/snapshotUrl: the upstream-image attempt returns null immediately
  // and the route falls straight into the Street View fallback.
};

/** Collects what a handler wrote, the way a Node ServerResponse would. */
function recordingResponse() {
  const chunks = [];
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  const res = {
    statusCode: 0,
    headers: {},
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers || {};
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      res.body = Buffer.concat(chunks).toString('utf8');
      finished();
    },
    on() {},
    once() {},
    emit() {},
    destroy() {},
  };
  return { res, done };
}

function mount(t) {
  const before = {
    json: process.env.CCTV_SOURCES_JSON,
    file: process.env.CCTV_SOURCES_FILE,
    austin: process.env.CCTV_FORCE_AUSTIN,
    key: process.env.GOOGLE_MAPS_SERVER_API_KEY,
    limit: process.env.GEV_RATELIMIT_GOOGLE_PER_MIN,
  };
  process.env.CCTV_SOURCES_JSON = JSON.stringify([CAMERA]);
  process.env.CCTV_SOURCES_FILE = 'absent-source-file.json';
  process.env.CCTV_FORCE_AUSTIN = '0';
  process.env.GOOGLE_MAPS_SERVER_API_KEY = 'fake-server-key';
  process.env.GEV_RATELIMIT_GOOGLE_PER_MIN = '1';

  let streetViewCalls = 0;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('maps.googleapis.com/maps/api/streetview')) {
      streetViewCalls += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
        arrayBuffer: async () => Buffer.from([1, 2, 3]),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  t.after(() => {
    globalThis.fetch = nativeFetch;
    for (const [name, value] of [
      ['CCTV_SOURCES_JSON', before.json],
      ['CCTV_SOURCES_FILE', before.file],
      ['CCTV_FORCE_AUSTIN', before.austin],
      ['GOOGLE_MAPS_SERVER_API_KEY', before.key],
      ['GEV_RATELIMIT_GOOGLE_PER_MIN', before.limit],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  let handler = null;
  const plugin = cctvProxy();
  plugin.configureServer({
    middlewares: {
      use: (_route, fn) => {
        handler = fn;
      },
    },
  });
  assert.ok(handler, 'the CCTV provider must mount a middleware');

  const call = async (path) => {
    const { res, done } = recordingResponse();
    await handler({ url: path, headers: {}, method: 'GET', socket: { remoteAddress: '127.0.0.1' }, on() {} }, res);
    await done;
    return res;
  };
  return { call, streetViewCalls: () => streetViewCalls };
}

test('calls beyond the per-IP cap get 429 instead of another Street View fallback call', async (t) => {
  const app = mount(t);

  const first = await app.call(`/frame/${CAMERA.id}`);
  assert.equal(first.headers['X-CCTV-Source'], 'streetview');
  assert.equal(app.streetViewCalls(), 1);

  const second = await app.call(`/frame/${CAMERA.id}`);
  assert.equal(second.statusCode, 429, 'the second call must be rate-limited, not billed again');
  assert.equal(app.streetViewCalls(), 1, 'a rate-limited call must never reach Google');
});

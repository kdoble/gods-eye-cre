import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreCache } from '../../../server/providers/cre/common/cache.js';
import { createCreCameraHandlers } from '../../../server/providers/cre/cameras.js';

const SITE = 'lat=32.92&lon=-96.68&radiusM=8047';
const on = (id, lat, lon) => ({
  icd_Id: id,
  name: `US-75 NB ${id}`,
  statusDescription: 'Device Online',
  hasSnapshot: true,
  latitude: lat,
  longitude: lon,
  equipLoc: { roadway: 'US-75' },
});
const OFFLINE = {
  ...on('offline', 32.922, -96.682),
  statusDescription: 'Device Offline',
};
const payload = (rows) => ({ roadwayCctvStatuses: { 'US-75': rows } });

function catalogFetch({
  dal = payload([on('near', 32.921, -96.681), OFFLINE, on('far', 32.5, -96.5)]),
  ftw = payload([]),
  calls = [],
} = {}) {
  return async (url, init) => {
    calls.push(url);
    assert.match(
      url,
      /^https:\/\/its\.txdot\.gov\/its\/DistrictIts\/GetCctvStatusListByDistrict\?districtCode=(DAL|FTW)$/,
    );
    assert.equal(init.redirect, 'error');
    const response = url.endsWith('DAL') ? dal : ftw;
    return response instanceof Response
      ? response
      : new Response(JSON.stringify(response), { status: 200 });
  };
}

async function invoke(handler, url) {
  const req = {
    method: 'GET',
    url,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res = {
    status: null,
    headers: null,
    bytes: Buffer.alloc(0),
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(chunk = '') {
      this.bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    },
  };
  await handler(req, res);
  return {
    status: res.status,
    headers: res.headers,
    bytes: res.bytes,
    body: res.headers?.['Content-Type']?.includes('json')
      ? JSON.parse(res.bytes.toString())
      : null,
  };
}

test('Dallas list uses only near online TxDOT devices; frame time and reuse stay unknown', async () => {
  const calls = [];
  const { list } = createCreCameraHandlers({
    fetchImpl: catalogFetch({ calls }),
    allowFrameProxy: false,
  });
  const result = await invoke(list, `/?${SITE}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'ready');
  assert.equal(result.body.cameras.length, 1);
  assert.match(result.body.cameras[0].name, /near/);
  assert.equal(result.body.cameras[0].sourceReportedOnline, true);
  assert.equal(result.body.cameras[0].frameTimeStatus, 'unknown');
  assert.equal(result.body.cameras[0].frameUrl, null);
  assert.equal(result.body.frameReuseStatus, 'rights-unresolved');
  assert.equal(
    result.body.cameras[0].officialViewerUrl,
    'https://its.txdot.gov/its/District/DAL',
  );
  assert.equal(calls.length, 2);
});

test('malformed HTTP 200 catalog is unavailable, not a legitimate zero', async () => {
  const { list } = createCreCameraHandlers({
    fetchImpl: catalogFetch({
      dal: { error: 'schema changed' },
      ftw: { error: 'schema changed' },
    }),
  });
  const result = await invoke(list, `/?${SITE}`);
  assert.equal(result.body.status, 'unavailable');
  assert.equal(result.body.cameras.length, 0);
});

test('a mixed valid and malformed roadway rejects that district', async () => {
  const { list } = createCreCameraHandlers({
    fetchImpl: catalogFetch({
      dal: { roadwayCctvStatuses: { US75: [], IH35: { changed: true } } },
      ftw: { error: 'offline' },
    }),
  });
  const result = await invoke(list, `/?${SITE}`);
  assert.equal(result.body.status, 'unavailable');
});

test('one failed district is partial and names missing coverage', async () => {
  const { list } = createCreCameraHandlers({
    fetchImpl: catalogFetch({ ftw: new Response('', { status: 503 }) }),
  });
  const result = await invoke(list, `/?${SITE}`);
  assert.equal(result.body.status, 'partial');
  assert.match(result.body.message, /FTW/);
  assert.equal(result.body.cameras.length, 1);
});

test('catalog cache date remains the original fetch time on a repeated request', async () => {
  const calls = [];
  let clock = Date.parse('2026-09-23T12:00:00Z');
  const cache = createCreCache({
    family: 'test-cre-cameras',
    ttlMs: 300_000,
    now: () => clock,
    disk: false,
  });
  const { list } = createCreCameraHandlers({
    fetchImpl: catalogFetch({ calls }),
    cache,
  });
  const first = await invoke(list, `/?${SITE}`);
  clock += 120_000;
  const second = await invoke(list, `/?${SITE}`);
  assert.equal(first.body.catalogRetrievedAt, '2026-09-23T12:00:00.000Z');
  assert.equal(second.body.catalogRetrievedAt, first.body.catalogRetrievedAt);
  assert.equal(calls.length, 2);
  assert.equal('sourceReportedAt' in second.body, false);
});

test('rights gate blocks frames before any upstream request', async () => {
  let called = false;
  const { frame } = createCreCameraHandlers({
    allowFrameProxy: false,
    fetchImpl: async () => {
      called = true;
      throw new Error('unexpected');
    },
    frameFetchImpl: async () => {
      called = true;
      throw new Error('unexpected');
    },
  });
  const result = await invoke(frame, `/?${SITE}&id=txdot-dal-bmVhcg`);
  assert.equal(result.status, 403);
  assert.equal(called, false);
});

test('enabled frame path returns only fixed-host JPEG; an unavailable frame has no substitute', async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const captured = [];
  const handlers = createCreCameraHandlers({
    allowFrameProxy: true,
    fetchImpl: catalogFetch(),
    frameFetchImpl: async (url, init) => {
      captured.push(url);
      assert.equal(init.redirect, 'manual');
      return new Response(
        JSON.stringify({ snippet: bytes.toString('base64') }),
        { status: 200 },
      );
    },
  });
  const list = await invoke(handlers.list, `/?${SITE}`);
  const url = new URL(list.body.cameras[0].frameUrl, 'http://localhost');
  const frame = await invoke(handlers.frame, `/${url.search}`);
  assert.equal(frame.status, 200);
  assert.equal(frame.headers['Content-Type'], 'image/jpeg');
  assert.equal(frame.headers['X-CRE-Frame-Capture-Time'], 'unknown');
  assert.deepEqual(frame.bytes, bytes);
  assert.equal(captured.length, 1);
  assert.match(
    captured[0],
    /^https:\/\/its\.txdot\.gov\/its\/DistrictIts\/GetCctvSnapshotByIcdId\?/,
  );

  const missing = createCreCameraHandlers({
    allowFrameProxy: true,
    fetchImpl: catalogFetch(),
    frameFetchImpl: async () =>
      new Response(JSON.stringify({ snippet: '' }), { status: 200 }),
  });
  const noFrame = await invoke(
    missing.frame,
    `/?${SITE}&id=${encodeURIComponent(list.body.cameras[0].id)}`,
  );
  assert.equal(noFrame.status, 503);
  assert.equal(noFrame.body.error, 'TxDOT frame unavailable');
  const far = await invoke(
    handlers.frame,
    `/?lat=32.3&lon=-96.3&radiusM=8047&id=${encodeURIComponent(list.body.cameras[0].id)}`,
  );
  assert.equal(far.status, 404);
});

test('Georgia and uncovered regions require no TxDOT catalog call', async () => {
  let calls = 0;
  const { list } = createCreCameraHandlers({
    fetchImpl: async () => {
      calls += 1;
      throw new Error('unexpected');
    },
  });
  const ga = await invoke(list, '/?lat=33.76&lon=-84.39&radiusM=8047');
  const tn = await invoke(list, '/?lat=36.3&lon=-82.36&radiusM=8047');
  assert.equal(ga.body.status, 'needs-key');
  assert.deepEqual(ga.body.sourceUrls, ['https://511ga.org/']);
  assert.equal(tn.body.status, 'not-covered');
  assert.equal(calls, 0);
});

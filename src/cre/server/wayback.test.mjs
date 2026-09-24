// Tests for the Wayback routes with mocked fetch: catalog parse, change walk, and the negatives (malformed date skipped and counted, tilemap 404 marks unknown not changed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  WAYBACK_CONFIG_URL,
  createWaybackService,
  findChangedReleases,
  parseWaybackConfig,
  tileForPoint,
} from '../../../server/providers/cre/wayback.js';

const CATALOG = JSON.parse(
  readFileSync(new URL('./fixtures/waybackconfig.json', import.meta.url)),
);
const TEST_POINT = { lat: 36.320692, lon: -82.342509 };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * Fake fetch: catalog, tilemap (per-release answer function), metadata.
 * @param {(release:number) => Response} tilemap
 */
function fakeFetch(tilemap, { catalog = CATALOG, calls = [] } = {}) {
  return async (url) => {
    const href = String(url);
    calls.push(href);
    if (href === WAYBACK_CONFIG_URL) return json(catalog);
    const tm = /\/MapServer\/tilemap\/(\d+)\/17\/(\d+)\/(\d+)\/1\/1$/.exec(
      href,
    );
    if (tm) return tilemap(Number(tm[1]));
    if (href.includes('metadata.maptiles.arcgis.com')) {
      return json({
        features: [
          {
            attributes: {
              SRC_DATE2: Date.UTC(2025, 3, 19),
              SRC_RES: 0.5,
              NICE_DESC: 'Vantor',
              NICE_NAME: 'Vivid Advanced',
            },
          },
        ],
      });
    }
    return json({ error: 'unexpected' }, 500);
  };
}

/** Tilemap where the tile changed only at releases 10 and 64001. */
const twoChanges = (release) => {
  const order = parseWaybackConfig(CATALOG).releases.map((r) => r.num);
  const at = order.indexOf(release);
  const cut = order.indexOf(64001);
  const select = at <= cut ? 64001 : 10;
  return json(
    select === release
      ? { data: [1], valid: true }
      : { data: [1], select: [select], valid: true },
  );
};

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
const req = (url) => ({ url, method: 'GET', socket: {} });

test('recorded catalog parses to 196 releases, 2014-02-20 to 2026-08-05', () => {
  const { releases, warnings } = parseWaybackConfig(CATALOG);
  assert.equal(releases.length, 196);
  assert.equal(releases.at(-1).date, '2014-02-20');
  assert.equal(releases.at(-1).num, 10);
  assert.equal(releases[0].date, '2026-08-05');
  assert.equal(releases[0].num, 26334);
  assert.equal(warnings.skipped, 0);
  assert.match(releases[0].tileTemplate, /\/tile\/26334\/\{z\}\/\{y\}\/\{x\}$/);
});

test('negative: a malformed itemTitle date is skipped and counted', () => {
  const bad = {
    ...CATALOG,
    777: { ...CATALOG['10'], itemTitle: 'World Imagery (Wayback 2019-13-45)' },
    778: { ...CATALOG['10'], itemTitle: 'no date at all' },
  };
  const { releases, warnings } = parseWaybackConfig(bad);
  assert.equal(releases.length, 196);
  assert.equal(warnings.skipped, 2);
  assert.ok(!releases.some((r) => r.num === 777 || r.num === 778));
});

test('test point zoom-17 tile matches the recorded x35556 y51325', () => {
  assert.deepEqual(tileForPoint(TEST_POINT.lat, TEST_POINT.lon), {
    z: 17,
    x: 35556,
    y: 51325,
  });
});

test('changes: a tilemap reporting 10 and 64001 returns exactly those two', async () => {
  const calls = [];
  const service = createWaybackService({
    fetchImpl: fakeFetch(twoChanges, { calls }),
    disk: false,
    limiter: null,
  });
  const res = fakeRes();
  await service.changesHandler(
    req(`/?lat=${TEST_POINT.lat}&lon=${TEST_POINT.lon}`),
    res,
  );
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.status, 'ready');
  assert.deepEqual(
    body.data.releases.map((r) => r.release),
    [64001, 10],
  );
  assert.deepEqual(
    body.data.releases.map((r) => r.releaseDate),
    ['2026-02-26', '2014-02-20'],
  );
  assert.equal(body.data.releases[0].captureDate, '2025-04-19');
  assert.equal(body.data.releases[0].resolutionM, 0.5);
  assert.deepEqual(body.data.unknown, []);
  // The walk jumps: one probe at the newest release, one at 64001's elder.
  assert.equal(body.data.probes, 2);
  assert.match(body.source.name, /Esri, Vantor, Earthstar Geographics/);
  // No tile bytes are ever fetched server side.
  assert.ok(!calls.some((u) => /\/MapServer\/tile\//.test(u)));
});

test('negative: a tilemap 404 marks that release unknown, not changed', async () => {
  const releases = parseWaybackConfig(CATALOG).releases;
  const newest = releases[0].num;
  const fetchImpl = fakeFetch((release) =>
    release === newest ? json({ error: 'nope' }, 404) : twoChanges(release),
  );
  const walk = await findChangedReleases(
    releases,
    { z: 17, x: 35547, y: 51330 },
    { fetchImpl },
  );
  assert.deepEqual(walk.unknown, [newest]);
  assert.ok(!walk.changed.some((r) => r.num === newest));
  assert.deepEqual(
    walk.changed.map((r) => r.num),
    [64001, 10],
  );
});

test('negative: every tilemap failing is unavailable (502), never an empty site', async () => {
  const service = createWaybackService({
    fetchImpl: fakeFetch(() => json({}, 404)),
    disk: false,
    limiter: null,
  });
  const res = fakeRes();
  await service.changesHandler(req('/?lat=36.3&lon=-82.3'), res);
  assert.equal(res.status, 502);
  assert.deepEqual(res.json(), { error: 'Data source unavailable' });
});

test('changes: a tile absent in every release is status empty', async () => {
  const service = createWaybackService({
    fetchImpl: fakeFetch(() => json({ data: [0], valid: true })),
    disk: false,
    limiter: null,
  });
  const res = fakeRes();
  await service.changesHandler(req('/?lat=10&lon=-150'), res);
  assert.equal(res.status, 200);
  assert.equal(res.json().status, 'empty');
});

test('negative: lat=91 is refused with 400 before any upstream call', async () => {
  const calls = [];
  const service = createWaybackService({
    fetchImpl: fakeFetch(twoChanges, { calls }),
    disk: false,
    limiter: null,
  });
  const res = fakeRes();
  await service.changesHandler(req('/?lat=91&lon=-82'), res);
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('releases route returns the sorted catalog', async () => {
  const service = createWaybackService({
    fetchImpl: fakeFetch(twoChanges),
    disk: false,
    limiter: null,
  });
  const res = fakeRes();
  await service.releasesHandler(req('/'), res);
  const body = res.json();
  assert.equal(body.data.releases.length, 196);
  assert.equal(body.data.releases[0].date, '2026-08-05');
});

test('metadata route: capture date for one release; unknown release is 404', async () => {
  const service = createWaybackService({
    fetchImpl: fakeFetch(twoChanges),
    disk: false,
    limiter: null,
  });
  const res = fakeRes();
  await service.metadataHandler(
    req(`/?release=64001&lat=${TEST_POINT.lat}&lon=${TEST_POINT.lon}`),
    res,
  );
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.data.captureDate, '2025-04-19');
  assert.equal(body.data.releaseDate, '2026-02-26');
  const missing = fakeRes();
  await service.metadataHandler(
    req(`/?release=999999&lat=${TEST_POINT.lat}&lon=${TEST_POINT.lon}`),
    missing,
  );
  assert.equal(missing.status, 404);
  const bad = fakeRes();
  await service.metadataHandler(req('/?release=abc&lat=1&lon=2'), bad);
  assert.equal(bad.status, 400);
});

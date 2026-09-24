// Tests for /api/cre/schools: the NCESSCH join, NCES negative codes, route validation, and the negative that a school with no admin row never reads as zero enrollment.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  creSchoolsHandler,
  joinSchools,
  loadSchools,
  ncesNumber,
} from '../../../server/providers/cre/schools.js';
import { createCreCache } from '../../../server/providers/cre/common/cache.js';
import { CRE_ERRORS } from '../../../server/providers/cre/common/route.js';

const SITE = { lat: 33.7726, lon: -84.366 };

const LOCATIONS = [
  {
    attributes: {
      NCESSCH: '130012004143',
      NAME: 'Midtown High School',
      LAT: 33.7813,
      LON: -84.3665,
    },
  },
  {
    attributes: {
      NCESSCH: '130012000001',
      NAME: 'Kindezi Old 4th Ward',
      LAT: 33.7672,
      LON: -84.3725,
    },
  },
  {
    attributes: {
      NCESSCH: '130012000002',
      NAME: 'Inman Middle School',
      LAT: 33.778,
      LON: -84.3555,
    },
  },
  {
    attributes: {
      NCESSCH: '130012000003',
      NAME: 'No Admin Academy',
      LAT: 33.773,
      LON: -84.3665,
    },
  },
  {
    attributes: { NCESSCH: 'bad', NAME: 'Malformed', LAT: 33.77, LON: -84.36 },
  },
];
const ADMIN = [
  {
    attributes: {
      NCESSCH: '130012004143',
      SCHOOL_LEVEL: 'High',
      MEMBER: 1696,
      STUTERATIO: 17.4,
      TOTFRL: 400,
      DIRECTCERT: 210,
      FTE: 97.5,
    },
  },
  {
    attributes: {
      NCESSCH: '130012000001',
      SCHOOL_LEVEL: 'Elementary',
      MEMBER: 321,
      STUTERATIO: -1,
      TOTFRL: -9,
      DIRECTCERT: 150,
      FTE: -1,
    },
  },
  {
    attributes: {
      NCESSCH: '130012000002',
      SCHOOL_LEVEL: 'Middle',
      MEMBER: 1102,
      STUTERATIO: 15.1,
      TOTFRL: 300,
      DIRECTCERT: 120,
      FTE: 73,
    },
  },
];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch({
  locations = LOCATIONS,
  admin = ADMIN,
  fail = false,
} = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u);
    if (fail) return jsonResponse({ error: { code: 400, message: 'boom' } });
    if (u.pathname.includes('EDGE_GEOCODE')) {
      return jsonResponse({ features: locations });
    }
    const where = u.searchParams.get('where') || '';
    return jsonResponse({
      features: admin.filter((f) =>
        where.includes(`'${f.attributes.NCESSCH}'`),
      ),
    });
  };
  return { fetchImpl, calls };
}

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
const tempCache = (family) =>
  createCreCache({
    family,
    ttlMs: 60_000,
    disk: false,
    rootDir: path.join(os.tmpdir(), 'cre-wp5-test'),
  });

test('ncesNumber maps NCES negative codes to null and keeps real zero', () => {
  assert.equal(ncesNumber(-1), null);
  assert.equal(ncesNumber(-2), null);
  assert.equal(ncesNumber(-9), null);
  assert.equal(ncesNumber(0), 0);
  assert.equal(ncesNumber(17.4), 17.4);
  assert.equal(ncesNumber(null), null);
});

test('joinSchools yields the nearest three with enrollment, sorted by distance', () => {
  const schools = joinSchools(LOCATIONS, ADMIN, SITE);
  assert.equal(schools.length, 4, 'malformed NCESSCH dropped');
  const withAdmin = schools.filter((s) => s.admin);
  assert.deepEqual(
    withAdmin.slice(0, 3).map((s) => [s.name, s.admin.enrollment]),
    [
      ['Kindezi Old 4th Ward', 321],
      ['Midtown High School', 1696],
      ['Inman Middle School', 1102],
    ],
  );
  for (let i = 1; i < schools.length; i += 1) {
    assert.ok(schools[i - 1].distanceM <= schools[i].distanceM);
  }
  const kindezi = schools.find((s) => s.name === 'Kindezi Old 4th Ward');
  assert.equal(kindezi.admin.studentTeacherRatio, null);
  assert.equal(kindezi.admin.freeReducedLunch, null);
  assert.equal(kindezi.admin.directCertification, 150);
});

test('NEGATIVE: a school with no admin row carries admin null, never enrollment 0', () => {
  const schools = joinSchools(LOCATIONS, ADMIN, SITE);
  const orphan = schools.find((s) => s.name === 'No Admin Academy');
  assert.equal(orphan.admin, null);
  assert.notEqual(orphan.admin?.enrollment, 0);
});

test('loadSchools joins the two EDGE layers on NCESSCH through a quoted IN clause', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const result = await loadSchools({ ...SITE, radiusM: 8047 }, { fetchImpl });
  assert.equal(result.schools.length, 4);
  const adminCall = calls.find((u) => u.pathname.includes('EDGE_ADMINDATA'));
  assert.match(adminCall.searchParams.get('where'), /^NCESSCH IN \('\d{12}'/);
  const geo = calls.find((u) => u.pathname.includes('EDGE_GEOCODE'));
  assert.equal(geo.searchParams.get('distance'), '8047');
});

test('route answers the contract body, and refuses lat=91 and a huge radius', async () => {
  const { fetchImpl } = fakeFetch();
  const handler = creSchoolsHandler({
    fetchImpl,
    cache: tempCache('schools-t1'),
    limiter: null,
  });
  const ok = fakeRes();
  await handler(req('/?lat=33.7726&lon=-84.366'), ok);
  assert.equal(ok.status, 200);
  const body = ok.json();
  assert.equal(body.status, 'ready');
  assert.equal(body.data.schools.length, 4);
  assert.ok(body.source.name.includes('NCES'));
  assert.ok(!Number.isNaN(Date.parse(body.retrievedAt)));

  const bad = fakeRes();
  await handler(req('/?lat=91&lon=-84.366'), bad);
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json(), { error: CRE_ERRORS.BAD_POINT });

  const wide = fakeRes();
  await handler(req('/?lat=33.7&lon=-84.3&radiusM=99999'), wide);
  assert.equal(wide.status, 400);
});

test('NEGATIVE: an ArcGIS error body becomes the fixed 502 message', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { fetchImpl } = fakeFetch({ fail: true });
  const handler = creSchoolsHandler({
    fetchImpl,
    cache: tempCache('schools-t2'),
    limiter: null,
  });
  const res = fakeRes();
  await handler(req('/?lat=33.7726&lon=-84.366'), res);
  assert.equal(res.status, 502);
  assert.deepEqual(res.json(), { error: CRE_ERRORS.UPSTREAM });
  assert.ok(!res.body.includes('boom'));
});

test('no schools in range is status empty', async () => {
  const { fetchImpl } = fakeFetch({ locations: [] });
  const handler = creSchoolsHandler({
    fetchImpl,
    cache: tempCache('schools-t3'),
    limiter: null,
  });
  const res = fakeRes();
  await handler(req('/?lat=40&lon=-100'), res);
  assert.equal(res.json().status, 'empty');
});

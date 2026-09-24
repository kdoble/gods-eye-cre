// Tests for the census family: needs-key without a key, the key never leaving the server (URL, logs, body), tract listing, and ACS sentinel parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACS_BIN_FIELDS,
  censusAcsHandler,
  censusTractsHandler,
  loadAcs,
  parseAcsTable,
  parseGeoids,
} from '../../../server/providers/cre/census.js';
import { createCreCache } from '../../../server/providers/cre/common/cache.js';

const KEY = 'FAKEKEY0123456789abcdef';

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
  createCreCache({ family: 'test', ttlMs: 60_000, disk: false });

const ACS_HEADER = [
  'NAME',
  'B01003_001E',
  'B01002_001E',
  'B19013_001E',
  'B25003_001E',
  'B25003_003E',
  'B25064_001E',
  'B25002_001E',
  'B25002_003E',
  'B25070_001E',
  'B25070_007E',
  'B25070_008E',
  'B25070_009E',
  'B25070_010E',
  'B25070_011E',
  'B15003_001E',
  'B15003_022E',
  'B15003_023E',
  'B15003_024E',
  'B15003_025E',
  'B23025_003E',
  'B23025_005E',
  'B01003_001M',
  'B19013_001M',
  'B25064_001M',
  'B23025_003M',
  'B23025_005M',
  'state',
  'county',
  'tract',
];
const acsRow = (tract, pop, mhi) => [
  `Census Tract ${tract}`,
  String(pop),
  '30.5',
  String(mhi),
  '1000',
  '600',
  '900',
  '1100',
  '100',
  '600',
  '50',
  '40',
  '60',
  '150',
  '20',
  '2000',
  '300',
  '100',
  '20',
  '10',
  '1500',
  '75',
  '210',
  '3440',
  '109',
  '180',
  '48',
  '47',
  '179',
  tract,
];
const PRIOR_HEADER = [
  'NAME',
  'B01003_001E',
  'B19013_001E',
  'B25003_001E',
  'B25003_003E',
  'B25064_001E',
  'B01003_001M',
  'B19013_001M',
  'B25064_001M',
  'state',
  'county',
  'tract',
];

/** Fake fetch answering ACS calls; records every URL it saw. */
function acsFetch(seen, status = 200) {
  return async (url) => {
    seen.push(String(url));
    if (status !== 200) return new Response('', { status });
    const body = String(url).includes('/2020/')
      ? [
          PRIOR_HEADER,
          [
            'Census Tract 609.02',
            '3910',
            '27072',
            '950',
            '560',
            '696',
            '261',
            '5000',
            '150',
            '47',
            '179',
            '060902',
          ],
        ]
      : [
          ACS_HEADER,
          acsRow('060902', 4428, 30840),
          acsRow('061900', 5000, -666666666),
        ];
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

/** Capture console output while fn runs. */
async function captureConsole(fn) {
  const lines = [];
  const saved = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[level] = console[level];
    console[level] = (...args) => lines.push(args.map(String).join(' '));
  }
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines.join('\n');
}

test('NEGATIVE: no key answers needs-key naming CENSUS_API_KEY and never calls upstream', async () => {
  const seen = [];
  const handler = censusAcsHandler({
    env: {},
    fetchImpl: acsFetch(seen),
    cache: memCache(),
    limiter: null,
  });
  const res = fakeRes();
  await handler(req('/?geoids=47179060902'), res);
  const body = res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'needs-key');
  assert.match(body.message, /CENSUS_API_KEY/);
  assert.equal(seen.length, 0);
});

test('with a key: values come back, and the key is in no response, sourceUrl, or log line', async () => {
  const seen = [];
  const handler = censusAcsHandler({
    env: { CENSUS_API_KEY: KEY },
    fetchImpl: acsFetch(seen),
    cache: memCache(),
    limiter: null,
  });
  const res = fakeRes();
  const logs = await captureConsole(() =>
    handler(req('/?geoids=47179060902,47179061900'), res),
  );
  const body = res.json();
  assert.equal(body.status, 'ready');
  assert.equal(body.data.tracts['47179060902'].cur.pop, 4428);
  assert.equal(body.data.tracts['47179060902'].prior.pop, 3910);
  assert.equal(
    body.data.tracts['47179061900'].cur.mhi,
    null,
    'sentinel is null',
  );
  assert.ok(
    seen.every((url) => url.includes(`key=${KEY}`)),
    'outbound only',
  );
  assert.ok(!res.body.includes(KEY), 'key not in response body');
  assert.ok(body.sourceUrls.length > 0);
  assert.ok(body.sourceUrls.every((url) => !url.includes('key=')));
  assert.ok(!logs.includes(KEY), 'key not logged');
});

test('DATA-02: the bins vintage (same year as cur) is not shadowed by the cur cache entry', async () => {
  const cache = memCache();
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('B19001_002E')) {
      const vars = Object.values(ACS_BIN_FIELDS);
      const header = ['NAME', ...vars, 'state', 'county', 'tract'];
      const row = [
        'Census Tract 609.02',
        ...vars.map((v) => (v === 'B19001_002E' ? '7' : '0')),
        '47',
        '179',
        '060902',
      ];
      return new Response(JSON.stringify([header, row]), { status: 200 });
    }
    if (u.includes('/2020/')) {
      return new Response(
        JSON.stringify([
          PRIOR_HEADER,
          [
            'Census Tract 609.02',
            '3910',
            '27072',
            '950',
            '560',
            '696',
            '261',
            '5000',
            '150',
            '47',
            '179',
            '060902',
          ],
        ]),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify([ACS_HEADER, acsRow('060902', 4428, 30840)]),
      { status: 200 },
    );
  };
  const result = await loadAcs(['47179060902'], {
    env: { CENSUS_API_KEY: KEY },
    fetchImpl,
    cache,
  });
  assert.equal(result.data.tracts['47179060902'].cur.pop, 4428);
  assert.equal(
    result.data.tracts['47179060902'].bins.incBin0,
    7,
    'the bins vintage must not read back the cur-vintage cache entry (same year, different fields)',
  );
});

test('NEGATIVE: an upstream failure answers a fixed 502 and logs no key', async () => {
  const handler = censusAcsHandler({
    env: { CENSUS_API_KEY: KEY },
    fetchImpl: acsFetch([], 500),
    cache: memCache(),
    limiter: null,
  });
  const res = fakeRes();
  const logs = await captureConsole(() =>
    handler(req('/?geoids=47179060902'), res),
  );
  assert.equal(res.status, 502);
  assert.deepEqual(res.json(), { error: 'Data source unavailable' });
  assert.ok(!logs.includes(KEY));
  assert.ok(!res.body.includes(KEY));
});

test('NEGATIVE: a rejected key (redirect) is needs-key, not ready', async () => {
  const result = await loadAcs(['47179060902'], {
    env: { CENSUS_API_KEY: KEY },
    fetchImpl: acsFetch([], 302),
  });
  assert.equal(result.status, 'needs-key');
  assert.match(result.message, /rejected CENSUS_API_KEY/);
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('a missing prior vintage leaves current values standing', async () => {
  const base = acsFetch([]);
  const result = await loadAcs(['47179060902'], {
    env: { CENSUS_API_KEY: KEY },
    fetchImpl: (url) =>
      String(url).includes('/2020/')
        ? new Response('', { status: 500 })
        : base(url),
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.data.priorAvailable, false);
  assert.equal(result.data.tracts['47179060902'].prior, null);
});

test('geoid parsing refuses junk and oversize lists', () => {
  assert.deepEqual(parseGeoids('47179060902, 47179060902'), ['47179060902']);
  assert.equal(parseGeoids('4717906200'), null);
  assert.equal(parseGeoids('47179060902,abc'), null);
  assert.equal(parseGeoids(''), null);
  assert.equal(
    parseGeoids(
      Array(801)
        .fill(0)
        .map((_, i) => String(47179000000 + i))
        .join(','),
    ),
    null,
  );
});

test('NEGATIVE: an ACS body without the tract columns is rejected', () => {
  assert.throws(() =>
    parseAcsTable('[["NAME"],["x"]]', { pop: 'B01003_001E' }),
  );
  assert.throws(() => parseAcsTable('<html>', { pop: 'B01003_001E' }));
});

/** TIGERweb fake: point query returns the site tract, envelope returns three. */
function tigerFetch() {
  return async (url) => {
    const u = new URL(String(url));
    if (u.searchParams.get('geometryType') === 'esriGeometryPoint') {
      return Response.json({
        features: [{ attributes: { GEOID: '47179060902' } }],
      });
    }
    return Response.json({
      features: [
        {
          attributes: {
            GEOID: '47179060902',
            NAME: 'Census Tract 609.02',
            INTPTLAT: '+36.3210000',
            INTPTLON: '-082.3430000',
            AREALAND: 1,
          },
        },
        {
          attributes: {
            GEOID: '47179061900',
            NAME: 'Census Tract 619',
            INTPTLAT: '+36.3300000',
            INTPTLON: '-082.3500000',
            AREALAND: 1,
          },
        },
        {
          attributes: {
            GEOID: '47179099999',
            NAME: 'Far',
            INTPTLAT: '+36.5000000',
            INTPTLON: '-082.3600000',
            AREALAND: 1,
          },
        },
      ],
    });
  };
}

test('tracts route lists tracts whose internal point is within the radius', async () => {
  const handler = censusTractsHandler({
    fetchImpl: tigerFetch(),
    cache: memCache(),
    limiter: null,
  });
  const res = fakeRes();
  await handler(req('/?lat=36.320692&lon=-82.342509&radiusM=8046.72'), res);
  const body = res.json();
  assert.equal(body.status, 'ready');
  assert.equal(body.data.siteTract, '47179060902');
  const ids = body.data.tracts.map((t) => t.geoid);
  assert.ok(ids.includes('47179060902'));
  assert.ok(ids.includes('47179061900'));
  assert.ok(
    !ids.includes('47179099999'),
    'internal point 21 km away is outside 5 mi',
  );
  assert.ok(body.data.tracts[0].distanceM <= body.data.tracts[1].distanceM);
});

test('tract discovery pages past ArcGIS transfer limits and reports only a true page-cap truncation', async () => {
  const offsets = [];
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    if (u.searchParams.get('geometryType') === 'esriGeometryPoint')
      return Response.json({ features: [{ attributes: { GEOID: '47179060902' } }] });
    const offset = Number(u.searchParams.get('resultOffset') || 0);
    offsets.push(offset);
    const count = offset === 0 ? 2000 : 1;
    const features = Array.from({ length: count }, (_, index) => {
      const n = offset + index;
      return { attributes: {
        GEOID: `47${String(100 + (n % 800)).padStart(3, '0')}${String(n).padStart(6, '0')}`,
        NAME: `Tract ${n}`, INTPTLAT: '+36.320692', INTPTLON: '-082.342509', AREALAND: 1,
      } };
    });
    return Response.json({ features, exceededTransferLimit: offset === 0 });
  };
  const handler = censusTractsHandler({ fetchImpl, cache: memCache(), limiter: null });
  const res = fakeRes();
  await handler(req('/?lat=36.320692&lon=-82.342509&radiusM=8046'), res);
  const body = res.json();
  assert.deepEqual(offsets, [0, 2000]);
  assert.equal(body.data.tracts.length, 2001);
  assert.equal(body.data.truncated, false);
});

test('NEGATIVE: tracts route refuses lat=91 and an oversize radius', async () => {
  const handler = censusTractsHandler({
    fetchImpl: tigerFetch(),
    cache: memCache(),
    limiter: null,
  });
  const a = fakeRes();
  await handler(req('/?lat=91&lon=-82.36'), a);
  assert.equal(a.status, 400);
  const b = fakeRes();
  await handler(req('/?lat=36.3&lon=-82.36&radiusM=90000'), b);
  assert.equal(b.status, 400);
});


test('NEGATIVE: a JSON null or an empty ACS cell is null, never a real zero (A-S3-6)', () => {
  const header = ['NAME', 'B01003_001E', 'B19013_001E', 'state', 'county', 'tract'];
  const fields = { pop: 'B01003_001E', mhi: 'B19013_001E' };
  const rows = [
    header,
    ['Tract 1', '1000', null, '47', '179', '061900'],
    ['Tract 2', '2000', '', '47', '179', '060902'],
    ['Tract 3', '3000', '-666666666', '47', '179', '062100'],
    ['Tract 4', '4000', '30840', '47', '179', '062200'],
  ];
  const parsed = parseAcsTable(JSON.stringify(rows), fields);
  assert.equal(parsed.get('47179061900').mhi, null, 'JSON null is not $0');
  assert.equal(parsed.get('47179060902').mhi, null, 'an empty cell is not $0');
  assert.equal(parsed.get('47179062100').mhi, null, 'the sentinel is still null');
  assert.equal(parsed.get('47179062200').mhi, 30840, 'a real value survives');
  assert.equal(parsed.get('47179061900').pop, 1000);
});

test('margins of error come back beside their estimates', async () => {
  const result = await loadAcs(['47179060902'], {
    env: { CENSUS_API_KEY: KEY },
    fetchImpl: acsFetch([]),
  });
  const cur = result.data.tracts['47179060902'].cur;
  assert.equal(cur.mhiMoe, 3440);
  assert.equal(cur.unemployedMoe, 48);
  assert.equal(cur.rentMoe, 109);
});

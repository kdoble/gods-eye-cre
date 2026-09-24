// Tests for /api/cre/permits: parsing the real two-header BPS county and place layouts, file picking, trend, the service end to end on a fake fetch, and the negative that a one-header file is rejected.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPermitsService,
  crePermitsHandler,
  parseBpsFile,
  permitTrend,
  pickBpsFiles,
  placeRegion,
} from '../../../server/providers/cre/permits.js';
import { CRE_ERRORS } from '../../../server/providers/cre/common/route.js';

// Recorded from https://www2.census.gov/econ/bps/County/co2025a.txt on 2026-09-22.
const COUNTY_H1 =
  'Survey,FIPS,FIPS,Region,Division,County,,1-unit,,,2-units,,,3-4 units,,,5+ units,,,1-unit rep,,,2-units rep,,,3-4 units rep,,, 5+units rep';
const COUNTY_H2 =
  'Date,State,County,Code,Code,Name,Bldgs,Units,Value,Bldgs,Units,Value,Bldgs,Units,Value,Bldgs,Units,Value,Bldgs,Units,Value,Bldgs,Units,Value,Bldgs,Units,Value,Bldgs,Units,Value';
const FULTON_2025 =
  '2025,13,121,3,5,Fulton County                 ,2344,2344,811585596,78,156,29192203,66,242,38212126,425,6918,994357931,1995,1995,744609237,78,156,29192203,64,236,37907088,403,6456,936758066';
const WASHINGTON_2025 =
  '2025,47,179,3,6,Washington County             ,662,662,261860785,7,14,2797969,0,0,0,3,21,3694660,662,662,261860785,7,14,2797969,0,0,0,3,21,3694660';
const countyFile = (...rows) =>
  [COUNTY_H1, COUNTY_H2, ' ', ...rows, ''].join('\r\n');

// Recorded from https://www2.census.gov/econ/bps/Place/South%20Region/so2025a.txt.
const PLACE_H1 =
  'Survey,State,6-Digit,County,Census Place,FIPS Place,FIPS MCD,Pop,CSA,CBSA,Footnote,Central,Zip,Region,Division,Number of,Place,,1-unit,,,2-units,,,3-4 units,,,5+ units,,,1-unit rep,,,2-units rep,,,3-4 units rep,,,5+ units rep';
const PLACE_H2 =
  'Date,Code,ID,Code,Code,Code,Code,  ,Code,Code,Code,City,Code,Code,Code,Months Rep,Name,Bldgs,Units,Value,Bldgs,Units,Value,Bldgs,Units,Value,Bldgs,Units,Value,Bldgs,Units,Value,Bldgs,Units,Value,Bldgs,Units,Value,Bldgs,Units,Value';
const ATLANTA_2025 =
  '2025,13,038000,121,0150,04000 ,00000 ,471266 ,122,12060,2,1,30303      ,3,5,12,Atlanta,561,561,164969672,78,156,29192203,64,236,37907088,388,4669,715427549,561,561,164969672,78,156,29192203,64,236,37907088,388,4669,715427549';
const JOHNSON_CITY_2025 =
  '2025,47,419000,179,3720,38320 ,00000 ,65418 ,304,27740,2,1,37601      ,3,6,12,Johnson City,333,333,121406699,6,12,2497969,0,0,0,1,5,1294660,333,333,121406699,6,12,2497969,0,0,0,1,5,1294660';
const placeFile = (...rows) =>
  [PLACE_H1, PLACE_H2, ' ', ...rows, ''].join('\n');

test('the real co2025a.txt Fulton line parses to 425 buildings, 6,918 units, 994,357,931 value', () => {
  const table = parseBpsFile(
    countyFile(FULTON_2025, WASHINGTON_2025),
    'county',
  );
  assert.deepEqual(table['13121'], {
    bldgs: 425,
    units: 6918,
    value: 994357931,
    name: 'Fulton County',
  });
  assert.equal(table['47179'].units, 21);
});

test('NEGATIVE: a file with one header row is rejected', () => {
  // Full-size bodies, so the rejection comes from the header check and not
  // from a short-file guard.
  const oneHeader = [COUNTY_H2, ' ', FULTON_2025, WASHINGTON_2025].join('\n');
  assert.throws(() => parseBpsFile(oneHeader, 'county'), { code: 'BAD_FILE' });
  const topOnly = [COUNTY_H1, ' ', FULTON_2025, WASHINGTON_2025].join('\n');
  assert.throws(() => parseBpsFile(topOnly, 'county'), { code: 'BAD_FILE' });
});

test('NEGATIVE: a file whose 5+ block is not Bldgs, Units, Value is rejected', () => {
  const shifted = COUNTY_H2.replace(
    /Bldgs,Units,Value,Bldgs,Units,Value,Bldgs,Units,Value,Bldgs,Units,Value/,
    'Bldgs,Units,Value,Bldgs,Units,Value,Bldgs,Units,Value,Units,Bldgs,Value',
  );
  assert.throws(
    () => parseBpsFile([COUNTY_H1, shifted, FULTON_2025].join('\n'), 'county'),
    { code: 'BAD_FILE' },
  );
  assert.throws(() => parseBpsFile('', 'county'), { code: 'BAD_FILE' });
});

test('the place layout parses Atlanta city 2025 to 388 buildings and 4,669 units', () => {
  const table = parseBpsFile(
    placeFile(ATLANTA_2025, JOHNSON_CITY_2025),
    'place',
  );
  assert.equal(table['1304000'].bldgs, 388);
  assert.equal(table['1304000'].units, 4669);
  assert.equal(table['1304000'].name, 'Atlanta');
  assert.equal(table['4738320'].units, 5);
});

test('pickBpsFiles takes the five newest annual files and the newest YTD, reading so9912y as 1999', () => {
  const html = [
    'so1999a.txt',
    'so9912y.txt',
    'so2020a.txt',
    'so2021a.txt',
    'so2022a.txt',
    'so2023a.txt',
    'so2024a.txt',
    'so2025a.txt',
    'so2606y.txt',
    'so2607y.txt',
    'so2607c.txt',
  ]
    .map((f) => `<a href="${f}">${f}</a>`)
    .join('\n');
  const picked = pickBpsFiles(html, 'so', 5, new Date('2026-09-22'));
  assert.deepEqual(picked.annual, [2021, 2022, 2023, 2024, 2025]);
  assert.deepEqual(picked.ytd, { year: 2026, month: 7, file: 'so2607y.txt' });
  const noYtd = pickBpsFiles(
    '<a href="co2025a.txt">',
    'co',
    5,
    new Date('2026-09-22'),
  );
  assert.equal(noYtd.ytd, null);
});

test('permitTrend compares the latest year with the prior mean', () => {
  const trend = permitTrend([
    { year: 2021, units: 39 },
    { year: 2022, units: 197 },
    { year: 2023, units: 214 },
    { year: 2024, units: 437 },
    { year: 2025, units: 21 },
  ]);
  assert.equal(trend.direction, 'falling');
  assert.equal(trend.priorMeanUnits, 221.8);
  assert.equal(trend.changePct, -90.5);
  assert.equal(
    permitTrend([
      { year: 2024, units: 0 },
      { year: 2025, units: 0 },
    ]).direction,
    'none',
  );
  assert.equal(
    permitTrend([
      { year: 2024, units: 0 },
      { year: 2025, units: 8 },
    ]).direction,
    'new',
  );
  assert.equal(permitTrend([{ year: 2025, units: 8 }]), null);
});

test('DATA-11: a year with no BPS row is excluded from the trend average, not counted as zero', () => {
  const trend = permitTrend([
    { year: 2021, units: 200, reported: true },
    { year: 2022, units: 0, reported: false }, // county absent from that year's file: no data, not zero
    { year: 2023, units: 220, reported: true },
    { year: 2024, units: 210, reported: true },
    { year: 2025, units: 21, reported: true },
  ]);
  // Old, wrong behavior averaged in the unreported year's fake zero:
  // (200+0+220+210)/4 = 157.5. Excluding it: (200+220+210)/3 = 210.
  assert.equal(trend.priorMeanUnits, 210);
  assert.notEqual(trend.priorMeanUnits, 157.5);
});

test('placeRegion maps state FIPS to the BPS region folder', () => {
  assert.equal(placeRegion('47').prefix, 'so');
  assert.equal(placeRegion('36').prefix, 'ne');
  assert.equal(placeRegion('17').prefix, 'mw');
  assert.equal(placeRegion('06').prefix, 'we');
  assert.equal(placeRegion('72'), null);
});

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

function bpsFetch({ place = true } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u.href);
    if (u.pathname.includes('State_County')) {
      return jsonResponse({
        features: [{ attributes: { GEOID: '13121', NAME: 'Fulton County' } }],
      });
    }
    if (u.pathname.includes('Places_CouSub')) {
      return jsonResponse({
        features: place
          ? [{ attributes: { GEOID: '1304000', NAME: 'Atlanta city' } }]
          : [],
      });
    }
    if (u.pathname.endsWith('/County/')) {
      return new Response(
        '<a href="co2024a.txt"></a><a href="co2025a.txt"></a><a href="co2607y.txt"></a>',
      );
    }
    if (u.pathname.endsWith('/South%20Region/')) {
      return new Response(
        '<a href="so2024a.txt"></a><a href="so2025a.txt"></a>',
      );
    }
    if (u.pathname.endsWith('co2025a.txt'))
      return new Response(countyFile(FULTON_2025));
    if (u.pathname.endsWith('co2024a.txt')) {
      return new Response(
        countyFile(
          FULTON_2025.replace(/^2025/, '2024').replace(
            '425,6918,994357931',
            '626,8159,1242569826',
          ),
        ),
      );
    }
    if (u.pathname.endsWith('co2607y.txt')) {
      return new Response(
        countyFile(
          FULTON_2025.replace(/^2025/, '202607').replace(
            '425,6918,994357931',
            '189,4632,540371272',
          ),
        ),
      );
    }
    if (u.pathname.endsWith('so2025a.txt'))
      return new Response(placeFile(ATLANTA_2025));
    if (u.pathname.endsWith('so2024a.txt'))
      return new Response(placeFile(JOHNSON_CITY_2025));
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, calls };
}

test('the service returns the county series with YTD and the place series', async () => {
  const { fetchImpl } = bpsFetch();
  const service = createPermitsService({ fetchImpl, disk: false });
  const data = await service.permitsFor(33.7726, -84.366);
  assert.equal(data.county.fips, '13121');
  assert.deepEqual(
    data.county.years.map((y) => [y.year, y.bldgs, y.units, y.value]),
    [
      [2024, 626, 8159, 1242569826],
      [2025, 425, 6918, 994357931],
    ],
  );
  assert.equal(data.county.ytd.units, 4632);
  assert.equal(data.county.ytd.throughMonth, 7);
  assert.equal(data.county.trend.direction, 'falling');
  assert.equal(data.place.issuesPermits, true);
  // Atlanta is absent from the 2024 place fixture, so that year is not reported.
  assert.deepEqual(
    data.place.years.map((y) => [y.year, y.units, y.reported]),
    [
      [2024, 0, false],
      [2025, 4669, true],
    ],
  );
});

test('a site outside any incorporated place gets county figures and place null', async () => {
  const { fetchImpl } = bpsFetch({ place: false });
  const service = createPermitsService({ fetchImpl, disk: false });
  const data = await service.permitsFor(33.7726, -84.366);
  assert.equal(data.place, null);
  assert.equal(data.county.years.length, 2);
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

test('route: ready body, lat=91 refused, and a dead BPS host gives the fixed 502', async (t) => {
  const { fetchImpl } = bpsFetch();
  const handler = crePermitsHandler({
    service: createPermitsService({ fetchImpl, disk: false }),
    limiter: null,
  });
  const ok = fakeRes();
  await handler(req('/?lat=33.7726&lon=-84.366'), ok);
  assert.equal(ok.status, 200);
  assert.equal(ok.json().status, 'ready');
  assert.equal(ok.json().data.county.name, 'Fulton County');

  const bad = fakeRes();
  await handler(req('/?lat=91&lon=0'), bad);
  assert.equal(bad.status, 400);

  t.mock.method(console, 'error', () => {});
  const dead = crePermitsHandler({
    service: createPermitsService({
      fetchImpl: async (url) =>
        String(url).includes('tigerweb')
          ? bpsFetch().fetchImpl(url)
          : new Response('upstream secret', { status: 503 }),
      disk: false,
    }),
    limiter: null,
  });
  const res = fakeRes();
  await dead(req('/?lat=33.7726&lon=-84.366'), res);
  assert.equal(res.status, 502);
  assert.deepEqual(res.json(), { error: CRE_ERRORS.UPSTREAM });
  assert.ok(!res.body.includes('secret'));
});

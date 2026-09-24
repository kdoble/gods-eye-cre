// Tests for /api/cre/rents: ZORI parsing and changes for 30308, the ZIP-not-in-file negative, and the negative that without HUD_API_TOKEN the FMR path reports needs-key and makes no HUD request.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRentsService,
  creRentsHandler,
  parseHudFmr,
  parseZoriCsv,
  splitCsvLine,
  zoriForZip,
} from '../../../server/providers/cre/rents.js';
import { CRE_ERRORS } from '../../../server/providers/cre/common/route.js';

/** 40 month-end columns, 2023-05-31 through 2026-08-31. */
function monthEnds() {
  const out = [];
  for (let i = 0; i < 40; i += 1) {
    const d = new Date(Date.UTC(2023, 5 + i, 0));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Fixture ZORI file. The 30308 row carries the real published values at the
 * three points the section reads (2023-08-31, 2025-08-31, 2026-08-31).
 */
function zoriFixture() {
  const dates = monthEnds();
  const header = [
    'RegionID',
    'SizeRank',
    'RegionName',
    'RegionType',
    'StateName',
    'State',
    'City',
    'Metro',
    'CountyName',
    ...dates,
  ];
  const values30308 = dates.map((d) => {
    if (d === '2026-08-31') return '2078.651741895348';
    if (d === '2025-08-31') return '2016.6403081021485';
    if (d === '2023-08-31') return '2050.289575824139';
    return '2040.5';
  });
  const values37601 = dates.map((d, i) => (i < 20 ? '' : String(1400 + i)));
  return [
    header.join(','),
    [
      '71028',
      '5519',
      '30308',
      'zip',
      'GA',
      'GA',
      'Atlanta',
      '"Atlanta-Sandy Springs-Alpharetta, GA"',
      'Fulton County',
      ...values30308,
    ].join(','),
    [
      '74387',
      '1994',
      '37601',
      'zip',
      'TN',
      'TN',
      'Johnson City',
      '"Johnson City, TN"',
      'Washington County',
      ...values37601,
    ].join(','),
    '',
  ].join('\n');
}

test('splitCsvLine honors quoted commas and doubled quotes', () => {
  assert.deepEqual(splitCsvLine('a,"b, c","d ""e""",'), [
    'a',
    'b, c',
    'd "e"',
    '',
  ]);
});

test('a fixture ZORI row for 30308 yields 2078.65 latest and the right 12 and 36 month changes', () => {
  const table = parseZoriCsv(zoriFixture());
  assert.equal(table.dates.length, 37);
  assert.equal(table.dates.at(-1), '2026-08-31');
  const zori = zoriForZip(table, '30308');
  assert.equal(zori.latest.value, 2078.65);
  assert.equal(zori.latest.date, '2026-08-31');
  assert.equal(zori.value12MonthsAgo, 2016.64);
  // (2078.65 - 2016.64) / 2016.64 = 3.0749%
  assert.equal(zori.change12mPct, 3.07);
  // (2078.65 - 2050.29) / 2050.29 = 1.3832%
  assert.equal(zori.change36mPct, 1.38);
  assert.equal(zori.metro, 'Atlanta-Sandy Springs-Alpharetta, GA');
});

test('a series too short for 36 months reports that change as null, not zero', () => {
  const zori = zoriForZip(parseZoriCsv(zoriFixture()), '37601');
  assert.equal(zori.change36mPct, null);
  assert.equal(typeof zori.change12mPct, 'number');
});

test('feature 2: zoriForZip carries 36 months of chart history, newest last', () => {
  const table = parseZoriCsv(zoriFixture());
  const zori = zoriForZip(table, '30308');
  assert.equal(zori.history.length, 36);
  assert.equal(zori.history.at(-1).date, '2026-08-31');
  assert.equal(zori.history.at(-1).value, 2078.65);
  assert.ok(zori.history.every((m) => typeof m.value === 'number'));
});

test('feature 2: a month with no published value is kept as a gap (null), never zeroed', () => {
  const table = parseZoriCsv(zoriFixture());
  const zori = zoriForZip(table, '37601');
  assert.equal(zori.history.length, 36);
  const nulls = zori.history.filter((m) => m.value === null);
  assert.ok(nulls.length > 0, 'the fixture has an early blank stretch for 37601');
  assert.ok(
    zori.history.some((m) => typeof m.value === 'number'),
    'and later months are real numbers, not all gaps',
  );
});

test('NEGATIVE: a ZIP not in the file yields null, and the service reports empty', async () => {
  const table = parseZoriCsv(zoriFixture());
  assert.equal(zoriForZip(table, '99999'), null);
  const service = createRentsService({
    fetchImpl: async () => new Response(zoriFixture()),
    env: {},
    disk: false,
  });
  const data = await service.rentsFor({ zip: '99999' });
  assert.equal(data.zoriStatus, 'empty');
  assert.equal(data.zori, null);
});

test('NEGATIVE: a file without date columns is rejected', () => {
  assert.throws(() => parseZoriCsv('RegionName,RegionType\n30308,zip\n'), {
    code: 'BAD_FILE',
  });
});

test('NEGATIVE: without HUD_API_TOKEN the FMR path is needs-key and no HUD request is made', async () => {
  const urls = [];
  const service = createRentsService({
    fetchImpl: async (url) => {
      urls.push(String(url));
      return new Response(zoriFixture());
    },
    env: { HUD_API_TOKEN: '   ' },
    disk: false,
  });
  const data = await service.rentsFor({ zip: '30308' });
  assert.deepEqual(data.fmr, { status: 'needs-key', key: 'HUD_API_TOKEN' });
  assert.equal(data.zoriStatus, 'ready');
  assert.ok(
    urls.every((u) => !u.includes('huduser.gov')),
    urls.join(' '),
  );
});

test('with a token, HUD is called with a Bearer header and the Small Area row for the ZIP wins', async () => {
  const seen = [];
  const hudBody = {
    data: {
      area_name: 'Atlanta-Sandy Springs-Roswell, GA HUD Metro FMR Area',
      year: 2026,
      smallarea_status: '1',
      basicdata: [
        {
          zip_code: 'MSA level',
          Efficiency: 1500,
          'One-Bedroom': 1560,
          'Two-Bedroom': 1760,
          'Three-Bedroom': 2200,
        },
        {
          zip_code: '30308',
          Efficiency: 1900,
          'One-Bedroom': 2000,
          'Two-Bedroom': 2300,
          'Three-Bedroom': 2900,
        },
      ],
    },
  };
  const service = createRentsService({
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      seen.push({ url: u, auth: init?.headers?.Authorization });
      if (u.host === 'tigerweb.geo.census.gov') {
        const layer = u.pathname.includes('ZCTA')
          ? { ZCTA5: '30308' }
          : { GEOID: '13121' };
        return new Response(
          JSON.stringify({ features: [{ attributes: layer }] }),
        );
      }
      if (u.host === 'www.huduser.gov')
        return new Response(JSON.stringify(hudBody));
      return new Response(zoriFixture());
    },
    env: { HUD_API_TOKEN: 'test-token-value' },
    disk: false,
  });
  const data = await service.rentsFor({ lat: 33.7726, lon: -84.366 });
  assert.equal(data.zip, '30308');
  assert.equal(data.zipSource, 'zcta');
  assert.equal(data.fmr.status, 'ready');
  assert.equal(data.fmr.smallArea, true);
  assert.deepEqual(data.fmr.rents, {
    studio: 1900,
    oneBr: 2000,
    twoBr: 2300,
    threeBr: 2900,
  });
  const hud = seen.find((s) => s.url.host === 'www.huduser.gov');
  assert.equal(hud.url.pathname, '/hudapi/public/fmr/data/1312199999');
  assert.equal(hud.auth, 'Bearer test-token-value');
  assert.ok(
    !hud.url.href.includes('test-token-value'),
    'token never in the URL',
  );
  assert.ok(!JSON.stringify(data).includes('test-token-value'));
});

test('parseHudFmr falls back to the area row and rejects a body with no rents', () => {
  const area = parseHudFmr(
    {
      data: {
        county_name: 'Washington County',
        basicdata: { 'One-Bedroom': 812, 'Two-Bedroom': 1024, year: 2026 },
      },
    },
    '37601',
  );
  assert.equal(area.smallArea, false);
  assert.equal(area.rents.twoBr, 1024);
  assert.throws(() => parseHudFmr({ data: { basicdata: {} } }, '37601'), {
    code: 'HUD_ERROR',
  });
  assert.throws(() => parseHudFmr({ error: 'x' }, '37601'), {
    code: 'HUD_ERROR',
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

test('route: ready for 30308, bad zip refused, and a dead Zillow host gives the fixed 502', async () => {
  const handler = creRentsHandler({
    service: createRentsService({
      fetchImpl: async () => new Response(zoriFixture()),
      env: {},
      disk: false,
    }),
    limiter: null,
  });
  const ok = fakeRes();
  await handler(req('/?zip=30308'), ok);
  assert.equal(ok.status, 200);
  const body = ok.json();
  assert.equal(body.status, 'ready');
  assert.equal(body.data.zori.latest.value, 2078.65);
  assert.equal(body.data.fmr.status, 'needs-key');

  for (const query of ['/?zip=3030', '/?zip=abcde', '/', '/?lat=91&lon=0']) {
    const bad = fakeRes();
    await handler(req(query), bad);
    assert.equal(bad.status, 400, query);
  }

  const dead = creRentsHandler({
    service: createRentsService({
      fetchImpl: async () => new Response('secret upstream', { status: 503 }),
      env: {},
      disk: false,
    }),
    limiter: null,
  });
  const res = fakeRes();
  await dead(req('/?zip=30308'), res);
  assert.equal(res.status, 502);
  assert.deepEqual(res.json(), { error: CRE_ERRORS.UPSTREAM });
});

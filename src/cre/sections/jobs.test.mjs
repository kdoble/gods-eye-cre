// Tests for the jobs section: ring and drive-time job sums with top sectors, county QCEW and LAUS rows, and honest unavailable states when sources fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSectionResult } from '../contract.js';
import { RINGS_M } from '../config.js';
import {
  load as loadJobs,
  oldestRetrievedAt,
  pointInGeometry,
  retrievedDate,
  sumJobs,
  topSectors,
} from './jobs.js';

const CTX = { lat: 36.320692, lon: -82.342509, address: 'x', rings: RINGS_M };

function server(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const match = Object.keys(routes)
      .filter((prefix) => String(url).startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    if (!match) return new Response('{}', { status: 404 });
    const out = routes[match];
    return out instanceof Response ? out : Response.json(out);
  };
  return { fetchImpl, calls };
}

const SQUARE = [
  [-82.4, 36.28],
  [-82.33, 36.28],
  [-82.33, 36.34],
  [-82.4, 36.34],
  [-82.4, 36.28],
];
const ISO = {
  status: 'ready',
  sourceUrls: ['https://valhalla1.openstreetmap.de/isochrone?json=x'],
  data: {
    minutes: 15,
    provider: 'valhalla',
    areaSqMi: 16.2,
    maxDistanceM: 4500,
    geojson: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Polygon', coordinates: [SQUARE] },
        },
      ],
    },
  },
};
const TRACTS = {
  status: 'ready',
  data: {
    siteTract: '47179060902',
    tracts: [
      { geoid: '47179060902', lat: 36.31, lon: -82.36, distanceM: 500 },
      { geoid: '47179061900', lat: 36.33, lon: -82.35, distanceM: 3000 },
      { geoid: '47179060100', lat: 36.36, lon: -82.42, distanceM: 7500 },
    ],
  },
};
const sectors = (over) => ({ CNS07: 0, CNS15: 0, CNS16: 0, CNS18: 0, ...over });
const LODES = {
  status: 'ready',
  sourceUrls: [
    'https://lehd.ces.census.gov/data/lodes/LODES8/tn/wac/tn_wac_S000_JT00_2023.csv.gz',
  ],
  data: {
    year: 2023,
    sectors: {
      CNS07: 'Retail Trade',
      CNS15: 'Educational Services',
      CNS16: 'Health Care and Social Assistance',
      CNS18: 'Accommodation and Food Services',
    },
    tracts: {
      47179060902: {
        total: 1000,
        sectors: sectors({ CNS15: 700, CNS18: 300 }),
      },
      47179061900: {
        total: 3000,
        sectors: sectors({ CNS16: 2500, CNS07: 500 }),
      },
      47179060100: { total: 400, sectors: sectors({ CNS07: 400 }) },
    },
  },
};
const QCEW = {
  status: 'ready',
  sourceUrls: ['https://data.bls.gov/cew/data/api/2026/1/area/47179.csv'],
  data: {
    fips: '47179',
    year: 2026,
    qtr: 1,
    month3Employment: 63348,
    avgWeeklyWage: 1121,
    employmentChangeYoY: -968,
    employmentChangeYoYPct: -1.5,
    avgWeeklyWageChangeYoYPct: 4.1,
  },
};
const QCEW_ANNUAL = {
  status: 'ready',
  sourceUrls: ['https://data.bls.gov/cew/data/api/2025/a/area/47179.csv'],
  data: {
    fips: '47179',
    year: 2025,
    avgWeeklyWage: 999,
  },
};
const LAUS = {
  status: 'ready',
  sourceUrls: [
    'https://api.bls.gov/publicAPI/v2/timeseries/data/LAUCN471790000000003',
  ],
  data: {
    fips: '47179',
    period: '2026-07',
    rate: 3.4,
    preliminary: true,
    yearAgoRate: 3.9,
  },
};
// Real shares/LQs from the recorded Fulton County 2025 QCEW annual file
// (see server/providers/cre/qcew.js sectorConcentration tests).
const QCEW_SECTORS = {
  status: 'ready',
  sourceUrls: ['https://data.bls.gov/cew/data/api/2025/a/area/47179.csv'],
  data: {
    year: 2025,
    totalPrivateEmployment: 840040,
    top: {
      code: '1024',
      title: 'Professional and business services',
      employment: 229961,
      lq: 1.69,
      sharePct: 27.374602161801343,
      concentrated: true,
    },
    // FIX (misleading flag): 27.4% is below the 35% single-sector-dependence
    // line, and Information (LQ 3.1 but only 6.4% share) no longer clears
    // the concentrated bar, which now requires share >= 10% too.
    singleSectorDependence: false,
    concentrated: [
      { code: '1023', title: 'Financial activities', employment: 90621, lq: 1.7, sharePct: 10.8, concentrated: true },
      { code: '1024', title: 'Professional and business services', employment: 229961, lq: 1.69, sharePct: 27.374602161801343, concentrated: true },
    ],
    sectors: [
      { code: '1024', title: 'Professional and business services', employment: 229961, lq: 1.69, sharePct: 27.374602161801343, concentrated: true },
      { code: '1021', title: 'Trade, transportation, and utilities', employment: 145460, lq: 0.83, sharePct: 17.3, concentrated: false },
      { code: '1026', title: 'Leisure and hospitality', employment: 100634, lq: 0.98, sharePct: 12.0, concentrated: false },
      { code: '1023', title: 'Financial activities', employment: 90621, lq: 1.7, sharePct: 10.8, concentrated: true },
      { code: '1022', title: 'Information', employment: 53764, lq: 3.1, sharePct: 6.4, concentrated: false },
      { code: '1027', title: 'Other services', employment: 26410, lq: 0.93, sharePct: 3.1, concentrated: false },
      { code: '1012', title: 'Construction', employment: 24308, lq: 0.48, sharePct: 2.9, concentrated: false },
      { code: '1013', title: 'Manufacturing', employment: 27003, lq: 0.35, sharePct: 3.2, concentrated: false },
      { code: '1011', title: 'Natural resources and mining', employment: 740, lq: 0.07, sharePct: 0.1, concentrated: false },
    ],
  },
};
const ROUTES = {
  '/api/cre/census/tracts': TRACTS,
  '/api/cre/isochrone?': ISO,
  '/api/cre/lodes/jobs': LODES,
  '/api/cre/qcew/county-annual': QCEW_ANNUAL,
  '/api/cre/qcew/county': QCEW,
  '/api/cre/qcew/sectors': QCEW_SECTORS,
  '/api/cre/qcew/laus': LAUS,
};

test('helpers: point in polygon, sums, top sectors', () => {
  const geometry = { type: 'Polygon', coordinates: [SQUARE] };
  assert.equal(pointInGeometry(-82.36, 36.31, geometry), true);
  assert.equal(pointInGeometry(-82.42, 36.36, geometry), false);
  const summed = sumJobs(['47179060902', '47179061900'], LODES.data.tracts);
  assert.equal(summed.total, 4000);
  assert.deepEqual(
    topSectors(summed).map(([k]) => k),
    ['CNS16', 'CNS15', 'CNS07'],
  );
  assert.deepEqual(
    topSectors({ total: 0, sectors: {} }),
    [],
    'no divide by zero',
  );
});

test('jobs section: ring and drive-time sums, top sectors, QCEW and LAUS rows', async () => {
  const { fetchImpl } = server(ROUTES);
  const result = validateSectionResult(await loadJobs(CTX, { fetchImpl }));
  assert.equal(result.status, 'ready');
  const get = (label) => result.values.find((v) => v.label === label)?.value;
  assert.equal(get('Jobs within 1 mi'), 1000);
  assert.equal(get('Jobs within 3 mi'), 4000);
  assert.equal(get('Jobs within 5 mi'), 4400);
  assert.equal(
    get('Jobs within 15 min drive'),
    4000,
    'tract 060100 is outside the polygon',
  );
  assert.equal(get('Top sector 1 (3 mi)'), 'Health Care and Social Assistance');
  assert.equal(get('County employment'), 63348);
  assert.equal(get('County average weekly wage (annual average)'), 999);
  assert.equal(get('County average annual pay'), 999 * 52);
  assert.equal(
    get('County average weekly wage change, year over year (quarterly)'),
    4.1,
  );
  assert.equal(get('County employment change, year over year'), -1.5);
  assert.equal(get('County unemployment rate'), 3.4);
  assert.equal(get('County unemployment rate, year earlier'), 3.9);
  assert.equal(result.message, undefined, 'nothing failed');
  const topRow = result.values.find((v) =>
    v.label.startsWith('Employment location quotient, Professional and business services'),
  );
  assert.match(topRow.label, /\(concentrated vs U\.S\.\)/);
  assert.equal(topRow.value, 1.69);
  const miningRow = result.values.find((v) =>
    v.label.startsWith('Employment location quotient, Natural resources and mining'),
  );
  assert.doesNotMatch(miningRow.label, /concentrated/);
  const infoRow = result.values.find((v) =>
    v.label.startsWith('Employment location quotient, Information'),
  );
  assert.doesNotMatch(
    infoRow.label,
    /concentrated/,
    'LQ 3.1 alone is not enough at 6.4% share',
  );
  const shareRow = result.values.find((v) => v.label === 'Largest sector of county employment');
  assert.doesNotMatch(
    shareRow.label,
    /single-sector dependence/,
    'Fulton at 27.4% is a broad urban supersector, not single-sector dependence',
  );
  assert.equal(Math.round(shareRow.value * 10) / 10, 27.4);
  assert.match(
    shareRow.note,
    /Largest sector: Professional and business services, 27\.4% of private jobs \(LQ 1\.69 vs U\.S\.\)/,
  );
});

test('N5: County average annual pay uses BLS\'s own avg_annual_pay, not the rounded weekly wage x 52, when the annual file carries it', async () => {
  const { fetchImpl } = server({
    ...ROUTES,
    '/api/cre/qcew/county-annual': {
      ...QCEW_ANNUAL,
      data: { ...QCEW_ANNUAL.data, avgAnnualPay: 103950 },
    },
  });
  const result = validateSectionResult(await loadJobs(CTX, { fetchImpl }));
  const get = (label) => result.values.find((v) => v.label === label)?.value;
  const row = result.values.find((v) => v.label === 'County average annual pay');
  assert.equal(get('County average annual pay'), 103950, 'the BLS-published figure, not 999 * 52 = 51,948');
  assert.match(row.note, /avg_annual_pay/);
});

test('N5 NEGATIVE: falls back to weekly wage x 52, labeled as an estimate, when avg_annual_pay is absent from the file', async () => {
  const { fetchImpl } = server(ROUTES);
  const result = validateSectionResult(await loadJobs(CTX, { fetchImpl }));
  const get = (label) => result.values.find((v) => v.label === label)?.value;
  const row = result.values.find((v) => v.label === 'County average annual pay');
  assert.equal(get('County average annual pay'), 999 * 52);
  assert.match(row.note, /weekly wage x 52/);
});

test('N3: a suppressed year-over-year job count never renders as the literal "+0 jobs" beside a real percent', async () => {
  const { fetchImpl } = server({
    ...ROUTES,
    '/api/cre/qcew/county': {
      ...QCEW,
      data: { ...QCEW.data, employmentChangeYoY: null },
    },
  });
  const result = validateSectionResult(await loadJobs(CTX, { fetchImpl }));
  const row = result.values.find((v) => v.label === 'County employment change, year over year');
  assert.equal(row.value, -1.5, 'the percent still shows');
  assert.doesNotMatch(row.note, /\+0 jobs/);
  assert.match(row.note, /job count not available/);
});

test('N4: section retrievedAt is the oldest of ALL FIVE sources, not just three of them', async () => {
  const { fetchImpl } = server({
    ...ROUTES,
    '/api/cre/qcew/county-annual': {
      ...QCEW_ANNUAL,
      retrievedAt: '2020-01-01T00:00:00.000Z',
    },
  });
  const result = validateSectionResult(await loadJobs(CTX, { fetchImpl }));
  assert.equal(
    result.retrievedAt,
    '2020-01-01T00:00:00.000Z',
    'the stale annual-QCEW timestamp must win the "oldest" comparison, not be silently excluded',
  );
});

test('NEGATIVE: QCEW sectors unavailable leaves the rest ready with a partial note, no sector rows', async () => {
  const { fetchImpl } = server({
    ...ROUTES,
    '/api/cre/qcew/sectors': {
      status: 'unavailable',
      data: null,
      message: 'BLS QCEW has no annual file for the latest two expected years',
    },
  });
  const result = validateSectionResult(await loadJobs(CTX, { fetchImpl }));
  assert.equal(result.status, 'ready');
  assert.match(result.message, /no annual file/);
  assert.ok(
    !result.values.some((v) => v.label.startsWith('Employment location quotient')),
  );
});

test('DATA-07: QCEW wage falls back to the quarterly level only when the annual file is unavailable', async () => {
  const { fetchImpl } = server({
    ...ROUTES,
    '/api/cre/qcew/county-annual': {
      status: 'unavailable',
      data: null,
      message: 'BLS QCEW has no annual file for the latest two expected years',
    },
  });
  const result = validateSectionResult(await loadJobs(CTX, { fetchImpl }));
  const get = (label) => result.values.find((v) => v.label === label)?.value;
  assert.equal(get('County average weekly wage (quarterly, unverified annual)'), 1121);
  assert.match(result.message, /no annual file/);
});

test('mixed LODES vintages and stale fallback are disclosed', async () => {
  const mixed = structuredClone(LODES);
  mixed.data.vintages = [2022, 2023];
  mixed.data.stale = true;
  const { fetchImpl } = server({ ...ROUTES, '/api/cre/lodes/jobs': mixed });
  const result = await loadJobs(CTX, { fetchImpl });
  const jobRow = result.values.find((value) => value.label.startsWith('Jobs within 1 mi'));
  assert.match(jobRow.note, /mixed vintages 2022, 2023/);
  assert.match(result.message, /LODES refresh failed; cached job counts are being shown/);
});

test('NEGATIVE: jobs section with every source down is unavailable with reasons, not zero jobs', async () => {
  const { fetchImpl } = server({});
  const result = validateSectionResult(await loadJobs(CTX, { fetchImpl }));
  assert.equal(result.status, 'unavailable');
  assert.match(result.message, /TIGERweb/);
  assert.equal(result.values.length, 0);
});

test('NEGATIVE: QCEW unavailable leaves the rest ready with a partial note', async () => {
  const { fetchImpl } = server({
    ...ROUTES,
    '/api/cre/qcew/county': {
      status: 'unavailable',
      data: null,
      message: 'BLS QCEW has no file for the latest two expected quarters',
    },
  });
  const result = validateSectionResult(await loadJobs(CTX, { fetchImpl }));
  assert.equal(result.status, 'ready');
  assert.match(result.message, /QCEW/);
  assert.ok(!result.values.some((v) => v.label === 'County employment'));
});


test('NEGATIVE: a tract with no LODES row is counted as missing, never as zero jobs (A-S2-2)', () => {
  const jobs = {
    36047055300: { total: 1000, sectors: { CNS01: 1000 } },
    36047055500: { total: 500, sectors: { CNS01: 500 } },
  };
  const complete = sumJobs(['36047055300', '36047055500'], jobs);
  assert.deepEqual(
    { total: complete.total, missing: complete.missing },
    { total: 1500, missing: 0 },
  );
  // The bug: a dropped tract used to be worth zero and nothing said so.
  const dropped = sumJobs(['36047055300', '36047055500', '36047099999'], jobs);
  assert.equal(dropped.total, 1500, 'the sum cannot include what it never got');
  assert.equal(dropped.missing, 1, 'but it reports the shortfall');
});

test('oldestRetrievedAt takes the stalest upstream stamp', () => {
  assert.equal(
    oldestRetrievedAt([
      '2026-09-22T17:48:00.000Z',
      '2026-09-22T17:07:09.000Z',
      null,
      'not a date',
    ]),
    '2026-09-22T17:07:09.000Z',
  );
  assert.equal(oldestRetrievedAt([]), null);
});

test('retrievedDate names the day the data was fetched', () => {
  assert.equal(retrievedDate('2026-09-22T17:07:09.000Z'), '2026-09-22');
  assert.equal(retrievedDate(undefined), 'an unknown date');
});

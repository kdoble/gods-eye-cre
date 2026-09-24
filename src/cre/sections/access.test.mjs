// Tests for the access section: the isochrone overlay and area, drive time and distance to the county job cluster, and unavailable (never zero-area ready) when routing fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSectionResult } from '../contract.js';
import { RINGS_M } from '../config.js';
import { load as loadAccess } from './access.js';

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
const ROUTES = {
  '/api/cre/census/tracts': TRACTS,
  '/api/cre/isochrone?': ISO,
  '/api/cre/lodes/jobs': LODES,
  '/api/cre/qcew/county': QCEW,
  '/api/cre/qcew/laus': LAUS,
};

test('access section: isochrone overlay, area, cluster drive time and distance', async () => {
  const { fetchImpl, calls } = server({
    ...ROUTES,
    '/api/cre/lodes/cluster': {
      status: 'ready',
      sourceUrls: ['https://lehd.ces.census.gov/x'],
      data: {
        year: 2023,
        geoid: '47179061900',
        lat: 36.33,
        lon: -82.35,
        clusterJobs: 12000,
        countyJobs: 60000,
      },
    },
    '/api/cre/isochrone/route': {
      status: 'ready',
      sourceUrls: ['https://router.project-osrm.org/x'],
      data: { durationS: 420, distanceM: 4023.36 },
    },
  });
  const result = validateSectionResult(await loadAccess(CTX, { fetchImpl }));
  assert.equal(result.status, 'ready');
  assert.equal(result.overlays[0].id, 'drive-time-15min');
  assert.equal(result.overlays[0].geojson.type, 'FeatureCollection');
  const get = (label) => result.values.find((v) => v.label === label)?.value;
  assert.equal(get('15 min drive-time area'), 16.2);
  assert.equal(get('Drive time to job cluster'), 7);
  assert.equal(get('Drive distance to job cluster'), 2.5);
  assert.equal(get('Job cluster inside 15 min drive'), 'Yes');
  assert.ok(
    calls.some((u) => u.startsWith('/api/cre/lodes/cluster?county=47179')),
  );
});

test('NEGATIVE: access with routing and cluster down is unavailable, never a zero-area ready', async () => {
  const { fetchImpl } = server({
    '/api/cre/census/tracts': TRACTS,
    '/api/cre/isochrone?': {
      status: 'unavailable',
      data: null,
      message: 'Routing source returned no drive-time polygon',
    },
  });
  const result = validateSectionResult(await loadAccess(CTX, { fetchImpl }));
  assert.equal(result.status, 'unavailable');
  assert.match(result.message, /no drive-time polygon/);
  assert.equal(result.values.length, 0);
});

// Tests for the supply section: county and place permit rows with YTD and trend, the Wayback line in both route shapes, and the negative that a dead Wayback route marks only that line unavailable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSectionResult } from '../contract.js';
import {
  IMAGERY_REFRESH_LABEL,
  loadSupplySection,
  permitRows,
  supplySection,
  SUPPLY_MESSAGES,
  waybackReleases,
} from './supply.js';

const CTX = { lat: 33.7726, lon: -84.366, address: '675 Ponce de Leon Ave NE' };
const year = (y, bldgs, units, value, reported = true) => ({
  year: y,
  bldgs,
  units,
  value,
  reported,
  file: `https://www2.census.gov/econ/bps/County/co${y}a.txt`,
});
const PERMITS = {
  status: 'ready',
  retrievedAt: '2026-09-22T15:00:00.000Z',
  data: {
    county: {
      fips: '13121',
      name: 'Fulton County',
      years: [
        year(2024, 626, 8159, 1242569826),
        year(2025, 425, 6918, 994357931),
      ],
      ytd: {
        year: 2026,
        throughMonth: 7,
        bldgs: 189,
        units: 4632,
        value: 540371272,
        reported: true,
        file: 'https://www2.census.gov/econ/bps/County/co2607y.txt',
      },
      trend: {
        direction: 'falling',
        latestYear: 2025,
        latestUnits: 6918,
        priorMeanUnits: 8159,
        changePct: -15.2,
        priorYears: [2024],
      },
    },
    place: {
      fips: '1304000',
      name: 'Atlanta city',
      issuesPermits: true,
      years: [year(2024, 0, 0, 0, false), year(2025, 388, 4669, 715427549)],
      ytd: null,
      trend: {
        direction: 'new',
        latestYear: 2025,
        latestUnits: 4669,
        priorMeanUnits: 0,
        changePct: null,
        priorYears: [2024],
      },
    },
  },
};
const WP6_BODY = {
  status: 'ready',
  data: {
    releases: [
      { release: 64001, releaseDate: '2025-06-12' },
      { release: 10, releaseDate: '2014-02-20' },
      { release: 5, releaseDate: '2013-11-01' },
    ],
  },
};

function routes({
  permits = PERMITS,
  wayback = WP6_BODY,
  waybackStatus = 200,
  permitsStatus = 200,
} = {}) {
  return async (url) => {
    const u = String(url);
    if (u.startsWith('/api/cre/permits?lat=33.7726&lon=-84.366')) {
      return new Response(JSON.stringify(permits), { status: permitsStatus });
    }
    if (u.startsWith('/api/cre/wayback/changes?lat=33.7726&lon=-84.366')) {
      return new Response(JSON.stringify(wayback), { status: waybackStatus });
    }
    return new Response('{}', { status: 404 });
  };
}

test('module shape matches the section contract', () => {
  assert.equal(supplySection.id, 'supply');
  assert.equal(supplySection.order, 8);
});

test('permitRows: units and buildings per year, YTD, trend, and an unreported year says so', () => {
  const rows = permitRows('Fulton County', PERMITS.data.county);
  assert.deepEqual(rows[1], {
    label: 'Fulton County 5+ unit permits, 2025',
    value: '6,918 units in 425 buildings',
    note: 'Permit value $994,357,931',
  });
  assert.equal(
    rows[2].label,
    'Fulton County 5+ unit permits, 2026 through Jul',
  );
  assert.equal(rows[3].value, 'Falling, -15.2% vs 2024 average');
  const place = permitRows('Atlanta city', PERMITS.data.place);
  assert.match(place[0].note, /Not listed in this annual file/);
  assert.equal(place.at(-1).value, 'New activity; no 5+ unit permits 2024');
});

test('waybackReleases reads the agreed shape and the WP6 shape', () => {
  assert.deepEqual(
    waybackReleases({ releases: [{ num: 10, date: '2014-02-20' }] }),
    [{ num: 10, date: '2014-02-20' }],
  );
  assert.equal(waybackReleases(WP6_BODY).length, 3);
  assert.equal(waybackReleases({ data: {} }), null);
});

test('ready section carries county, place and the imagery change count since 2014', async () => {
  const result = validateSectionResult(
    await loadSupplySection(CTX, { fetchImpl: routes() }),
  );
  assert.equal(result.status, 'ready');
  const labels = result.values.map((v) => v.label);
  assert.ok(labels.includes('Fulton County 5+ unit permits, 2025'));
  assert.ok(
    labels.includes('Atlanta 5+ unit permits, 2025'),
    'the Census "city" suffix is dropped for display',
  );
  const imagery = result.values.find(
    (v) => v.label === IMAGERY_REFRESH_LABEL,
  );
  assert.equal(imagery.value, 2, 'the 2013 release is excluded');
  assert.match(imagery.note, /latest 2025-06-12/);
  assert.equal(result.message, undefined);
  assert.ok(
    result.sourceUrls.includes(
      'https://www2.census.gov/econ/bps/County/co2607y.txt',
    ),
  );
  assert.equal(result.retrievedAt, '2026-09-22T15:00:00.000Z');
});

test('NEGATIVE: a dead Wayback route marks only that line unavailable; the section stays ready', async () => {
  const result = validateSectionResult(
    await loadSupplySection(CTX, {
      fetchImpl: routes({ waybackStatus: 404, wayback: {} }),
    }),
  );
  assert.equal(result.status, 'ready');
  assert.ok(!result.values.some((v) => /Imagery/.test(v.label)));
  assert.equal(result.message, SUPPLY_MESSAGES.WAYBACK_UNAVAILABLE);
});

test('a place that does not report to BPS and a site outside any place are both explained', async () => {
  const notIssuing = structuredClone(PERMITS);
  notIssuing.data.place = {
    fips: '1399999',
    name: 'Tiny town',
    issuesPermits: false,
  };
  const a = validateSectionResult(
    await loadSupplySection(CTX, {
      fetchImpl: routes({ permits: notIssuing }),
    }),
  );
  assert.match(a.message, /Tiny does not report/);
  const noPlace = structuredClone(PERMITS);
  noPlace.data.place = null;
  const b = validateSectionResult(
    await loadSupplySection(CTX, { fetchImpl: routes({ permits: noPlace }) }),
  );
  assert.match(b.message, /not inside an incorporated place/);
});

test('NEGATIVE: permits and Wayback both dead is unavailable with both reasons', async () => {
  const result = validateSectionResult(
    await loadSupplySection(CTX, {
      fetchImpl: routes({
        permitsStatus: 502,
        permits: {},
        waybackStatus: 502,
        wayback: {},
      }),
    }),
  );
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.values, []);
  assert.equal(
    result.message,
    `${SUPPLY_MESSAGES.PERMITS_UNAVAILABLE} ${SUPPLY_MESSAGES.WAYBACK_UNAVAILABLE}`,
  );
});


test('the imagery row counts Esri refreshes of the site tile, not change at the site (B-S3-5)', () => {
  assert.match(IMAGERY_REFRESH_LABEL, /Esri imagery refreshes/);
  assert.match(IMAGERY_REFRESH_LABEL, /about 300 m/);
  assert.ok(
    !/changes at the site/i.test(IMAGERY_REFRESH_LABEL),
    'the label no longer claims the site changed',
  );
});

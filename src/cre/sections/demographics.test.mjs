// Tests for the demographics section: ring aggregation math, an empty ring with no division by zero, needs-key naming the key, and honest unavailable states, all through the section contract validator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSectionResult } from '../contract.js';
import { RINGS_M } from '../config.js';
import {
  acsZScore,
  aggregateAcs,
  interpolateMedian,
  isAboveTopBin,
  isSiteTractOnly,
  load,
  ringCoverage,
  ringScopes,
  round,
  scopeValues,
  tractsInRing,
} from './demographics.js';

const CTX = {
  lat: 36.320692,
  lon: -82.342509,
  address: '601 E Main St',
  rings: RINGS_M,
};

const cur = (over = {}) => ({
  pop: 1000,
  medianAge: 30,
  mhi: 50000,
  households: 400,
  renters: 200,
  rent: 1000,
  units: 440,
  vacant: 40,
  grapiTotal: 200,
  grapi30: 20,
  grapi35: 10,
  grapi40: 10,
  grapi50: 40,
  grapiNotComputed: 20,
  edTotal: 600,
  edBachelors: 100,
  edMasters: 40,
  edProfessional: 5,
  edDoctorate: 5,
  laborForce: 500,
  unemployed: 25,
  ...over,
});
const prior = (over = {}) => ({
  pop: 900,
  mhi: 45000,
  households: 380,
  renters: 190,
  rent: 900,
  ...over,
});

test('aggregation sums counts and weights medians by the right base', () => {
  const m = aggregateAcs([
    { cur: cur(), prior: prior() },
    {
      cur: cur({
        pop: 3000,
        mhi: 90000,
        households: 1200,
        renters: 200,
        rent: 2000,
        medianAge: 40,
      }),
      prior: prior({ pop: 2100 }),
    },
  ]);
  assert.equal(m.population, 4000);
  assert.equal(m.populationGrowthPct, (4000 / 3000 - 1) * 100);
  assert.equal(
    m.medianHouseholdIncome,
    (50000 * 400 + 90000 * 1200) / 1600,
    'household weighted',
  );
  assert.equal(
    m.medianGrossRent,
    (1000 * 200 + 2000 * 200) / 400,
    'renter weighted',
  );
  assert.equal(
    m.medianAge,
    (30 * 1000 + 40 * 3000) / 4000,
    'population weighted',
  );
  assert.equal(m.renterSharePct, (400 / 1600) * 100);
  assert.equal(
    m.rentBurdenPct,
    (160 / 360) * 100,
    'burdened over computed renters',
  );
  assert.equal(m.bachelorsPlusPct, (300 / 1200) * 100);
  assert.equal(m.vacancyPct, (80 / 880) * 100);
  assert.equal(m.unemploymentPct, 5);
});

test('NEGATIVE: an empty scope yields nulls, never NaN or Infinity', () => {
  const m = aggregateAcs([]);
  for (const [key, value] of Object.entries(m)) {
    if (['tracts', 'incomeMatchedTracts', 'rentMatchedTracts'].includes(key)) assert.equal(value, 0);
    else assert.equal(value, null, key);
  }
  const zero = aggregateAcs([
    {
      cur: cur({
        households: 0,
        renters: 0,
        units: 0,
        laborForce: 0,
        pop: 0,
        edTotal: 0,
        grapiTotal: 0,
        grapiNotComputed: 0,
      }),
      prior: prior({ pop: 0 }),
    },
  ]);
  assert.equal(zero.renterSharePct, null);
  assert.equal(zero.vacancyPct, null);
  assert.equal(zero.populationGrowthPct, null);
  assert.equal(zero.medianHouseholdIncome, null);
});

test('interpolateMedian: Census linear interpolation within the bin holding the median', () => {
  assert.equal(interpolateMedian([2, 4, 4], [0, 10, 20, 30]), 17.5);
  assert.equal(interpolateMedian([0, 0, 0], [0, 10, 20, 30]), null, 'no data at all is null');
});

test('S1: interpolateMedian: a median in the open-ended top bin is an answer ($X+, Census convention), never null', () => {
  const result = interpolateMedian([1, 1, 10], [0, 10, 20, null]);
  assert.ok(isAboveTopBin(result), 'not null -- there IS a pooled answer, it is just above the top edge');
  assert.equal(result.floor, 20, 'the bin floor is the reportable value, e.g. "$20+"');
});

test('acsZScore: Census z-test with the published MOE converted to a standard error (/1.645)', () => {
  const z = acsZScore(110, 20, 100, 15);
  const se = Math.sqrt((20 / 1.645) ** 2 + (15 / 1.645) ** 2);
  assert.ok(Math.abs(z - (110 - 100) / se) < 1e-9);
  assert.equal(acsZScore(null, 1, 2, 3), null);
});

test('DATA-02: pooled median household income and gross rent come from ACS bins, not a mean of tract medians', () => {
  const bins = { incBin2: 3, incBin3: 5, rentBin1: 3, rentBin2: 5 };
  const m = aggregateAcs([{ cur: cur(), prior: prior(), bins }]);
  assert.equal(
    m.pooledMedianHouseholdIncome,
    21000,
    '15000-20000 x3, 20000-25000 x5: median falls 1/5 into the 20000-25000 bin',
  );
  assert.equal(
    m.pooledMedianGrossRent,
    160,
    '100-150 x3, 150-200 x5: median falls 1/5 into the 150-200 bin',
  );
  assert.equal(m.medianHouseholdIncome, 50000, 'weighted-mean field is untouched');
});

test('S1: a ring median in the open-ended top income/rent bin shows "$200,000+" / "$3,500+", never "ACS income bins unavailable"', () => {
  // 600 of 1000 households in the top $200k+ income bin (incBin15), and 600
  // of 1000 renters in the top $3,500+ rent bin (rentBin23): the pooled
  // median falls in the open top bin for both.
  const bins = { incBin15: 600, incBin0: 400, rentBin23: 600, rentBin0: 400 };
  const m = aggregateAcs([{ cur: cur(), prior: prior(), bins }]);
  assert.ok(isAboveTopBin(m.pooledMedianHouseholdIncome));
  assert.ok(isAboveTopBin(m.pooledMedianGrossRent));
  const rows = scopeValues('1 mi', m, { ...VINTAGES, ring: true });
  const income = rows.find((r) => r.label.startsWith('Median household income ('));
  const rent = rows.find((r) => r.label.startsWith('Median gross rent ('));
  assert.equal(income.value, 200000);
  assert.match(income.note, /\$200,000\+/);
  assert.doesNotMatch(income.note, /unavailable/);
  assert.equal(rent.value, 3500);
  assert.match(rent.note, /\$3,500\+/);
  assert.doesNotMatch(rent.note, /unavailable/);
});

test('DATA-02: bins absent (fetch failed) falls back to null, never a guess', () => {
  const m = aggregateAcs([{ cur: cur(), prior: prior(), bins: null }]);
  assert.equal(m.pooledMedianHouseholdIncome, null);
  assert.equal(m.pooledMedianGrossRent, null);
});

test('DATA-03: rental vacancy (B25004) is for-rent over renter-occupied + for-rent + rented-not-occupied', () => {
  const bins = { vacForRent: 10, vacRentedNotOccupied: 5 };
  const m = aggregateAcs([{ cur: cur({ renters: 200 }), prior: prior(), bins }]);
  assert.equal(m.rentalVacancyPct, (10 / (200 + 10 + 5)) * 100);
  assert.notEqual(
    m.rentalVacancyPct,
    m.vacancyPct,
    'rental vacancy is a different figure from all-housing vacancy',
  );
});

test('DATA-04: a single-tract change row carries a z-score from both vintages MOEs', () => {
  const m = aggregateAcs([
    {
      cur: cur({
        pop: 1916,
        mhi: 106661,
        rent: 1858,
        popMoe: 261,
        mhiMoe: 31946,
        rentMoe: 528,
      }),
      prior: prior({
        pop: 1848,
        mhi: 103361,
        rent: 1391,
        popMoe: 245,
        mhiMoe: 29000,
        rentMoe: 480,
      }),
    },
  ]);
  assert.ok(Number.isFinite(m.populationChangeZ));
  assert.ok(Number.isFinite(m.incomeChangeZ));
  assert.ok(Number.isFinite(m.rentChangeZ));
});

test('income and rent growth use only paired tracts; an unmatched added tract cannot create growth', () => {
  const m = aggregateAcs([
    { cur: cur({ mhi: 50000, rent: 1000 }), prior: prior({ mhi: 50000, rent: 1000 }) },
    { cur: cur({ mhi: 150000, households: 400, rent: 3000, renters: 200 }), prior: null },
  ]);
  assert.equal(m.medianHouseholdIncome, 100000, 'current level includes all valid current tracts');
  assert.equal(m.incomeChangePct, 0, 'growth uses the one matched tract');
  assert.equal(m.incomeMatchedTracts, 1);
  assert.equal(m.medianGrossRent, 2000);
  assert.equal(m.rentChangePct, 0);
  assert.equal(m.rentMatchedTracts, 1);
});

test('null population is omitted from section values, never rounded to zero', () => {
  const rows = scopeValues('tract 1', aggregateAcs([{ cur: cur({ pop: null }), prior: null }]), {
    vintage: 'ACS current', priorVintage: 'ACS prior', ring: false,
  });
  assert.ok(!rows.some((row) => row.label.startsWith('Population (')));
});

test('a suppressed tract median drops out of the weighted mean instead of counting as zero', () => {
  const m = aggregateAcs([
    { cur: cur({ mhi: null }), prior: null },
    { cur: cur({ mhi: 80000 }), prior: null },
  ]);
  assert.equal(m.medianHouseholdIncome, 80000);
  assert.equal(m.populationGrowthPct, null, 'no prior vintage, no growth');
});

/** Fake CRE server: routes by path to fixture bodies. */
function server(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    for (const [prefix, reply] of Object.entries(routes)) {
      if (String(url).startsWith(prefix)) {
        const out = typeof reply === 'function' ? reply(String(url)) : reply;
        if (out instanceof Response) return out;
        return Response.json(out);
      }
    }
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, calls };
}

const TRACTS = {
  status: 'ready',
  data: {
    siteTract: '47179060902',
    tracts: [
      // Nearest internal point is 2 miles out: the 1 mile ring is empty.
      { geoid: '47179060902', lat: 36.33, lon: -82.36, distanceM: 3300 },
      { geoid: '47179061900', lat: 36.34, lon: -82.38, distanceM: 4000 },
      { geoid: '47179060100', lat: 36.36, lon: -82.4, distanceM: 7000 },
    ],
  },
};
const ACS = {
  status: 'ready',
  retrievedAt: '2026-09-22T00:00:00.000Z',
  sourceUrls: [
    'https://api.census.gov/data/2024/acs/acs5?get=NAME&for=tract:*&in=state:47%20county:179',
  ],
  data: {
    vintage: 'ACS 2020-2024 5-year',
    priorVintage: 'ACS 2016-2020 5-year',
    tracts: {
      47179060902: { cur: cur({ pop: 4428 }), prior: prior({ pop: 3910 }) },
      47179061900: { cur: cur(), prior: prior() },
      47179060100: { cur: cur(), prior: null },
    },
  },
};

test('the site tract counts in every ring even when its internal point is outside (B1-12)', async () => {
  const { fetchImpl } = server({
    '/api/cre/census/tracts': TRACTS,
    '/api/cre/census/acs': ACS,
  });
  const result = validateSectionResult(await load(CTX, { fetchImpl }));
  assert.equal(result.status, 'ready');
  const one = result.values.find((v) => v.label === 'Tracts counted (1 mi)');
  assert.equal(one.value, 1, 'site tract alone in the 1 mile ring');
  assert.match(one.note, /tract the site sits in always counts/);
  // The ring holds nothing but the substituted site tract, so the row says so
  // instead of claiming the 1 mile ring's area (B-S2-3).
  const onePop = result.values.find(
    (v) => v.label === 'Population (1 mi, site tract)',
  );
  assert.equal(onePop.value, 4428);
  assert.match(onePop.note, /no tract internal point falls inside this ring/);
  assert.ok(
    result.values.every(
      (v) => typeof v.value === 'string' || Number.isFinite(v.value),
    ),
  );
  const tractPop = result.values.find(
    (v) => v.label === 'Population (tract 47179060902)',
  );
  assert.equal(tractPop.value, 4428);
  // Every ring is at least the site tract: no ring smaller than its host.
  for (const ring of ['1 mi, site tract', '3 mi', '5 mi']) {
    const pop = result.values.find((v) => v.label === `Population (${ring})`);
    assert.ok(pop.value >= tractPop.value, `${ring} ${pop.value}`);
  }
  const threePop = result.values.find((v) => v.label === 'Population (3 mi)');
  assert.equal(threePop.value, 5428);
  const fivePop = result.values.find((v) => v.label === 'Population (5 mi)');
  assert.equal(fivePop.value, 6428);
  const growth = result.values.find(
    (v) => v.label === 'Population change (5 mi)',
  );
  assert.equal(growth.value, 12.8, 'matched tracts only: 5428 vs 4810');
  assert.equal(
    result.values.find((v) => v.label === 'Tracts counted (5 mi)').value,
    3,
  );
});

test('the site tract is added when its internal point is beyond 5 miles', () => {
  const far = [{ geoid: '51077060100', distanceM: 1200 }];
  const ring = tractsInRing(far, 1609, '51077060200');
  assert.deepEqual(
    ring.map((t) => t.geoid),
    ['51077060200', '51077060100'],
  );
  assert.equal(ring[0].distanceM, null, 'distance unknown, not invented');
  assert.deepEqual(
    tractsInRing(far, 1609, '51077060100').map((t) => t.geoid),
    ['51077060100'],
    'no duplicate when already inside',
  );
});

test('NEGATIVE: a ring that leaves out the site tract fails the check', () => {
  // The old centroid-only rule: what B1-12 caught in Fries VA.
  const oldRule = (tracts, radiusM) =>
    tracts.filter(
      (t) => Number.isFinite(t.distanceM) && t.distanceM <= radiusM,
    );
  const includesSite = (ring, site) => ring.some((t) => t.geoid === site);
  const tracts = TRACTS.data.tracts;
  assert.equal(includesSite(oldRule(tracts, 1609), '47179060902'), false);
  for (const radius of [1609, 4828, 8047]) {
    assert.equal(
      includesSite(tractsInRing(tracts, radius, '47179060902'), '47179060902'),
      true,
    );
  }
});

test('NEGATIVE: with no site tract known, an empty ring stays zero with no NaN', async () => {
  const { fetchImpl } = server({
    '/api/cre/census/tracts': {
      ...TRACTS,
      data: { ...TRACTS.data, siteTract: null },
    },
    '/api/cre/census/acs': ACS,
  });
  const result = validateSectionResult(await load(CTX, { fetchImpl }));
  const one = result.values.find((v) => v.label === 'Tracts counted (1 mi)');
  assert.equal(one.value, 0);
  assert.ok(
    !result.values.some(
      (v) => v.label.endsWith('(1 mi)') && v.label !== 'Tracts counted (1 mi)',
    ),
  );
  assert.ok(
    result.values.every(
      (v) => typeof v.value === 'string' || Number.isFinite(v.value),
    ),
  );
});

test('NEGATIVE: no key maps to needs-key naming CENSUS_API_KEY with no values', async () => {
  const { fetchImpl } = server({
    '/api/cre/census/tracts': TRACTS,
    '/api/cre/census/acs': {
      status: 'needs-key',
      data: null,
      retrievedAt: '2026-09-22T00:00:00.000Z',
      message: 'x',
    },
  });
  const result = validateSectionResult(await load(CTX, { fetchImpl }));
  assert.equal(result.status, 'needs-key');
  assert.match(result.message, /CENSUS_API_KEY/);
  assert.match(result.message, /POWER UP/);
  assert.equal(result.values.length, 0);
});

test('NEGATIVE: a dead tract lookup is unavailable, and no tracts at all is empty', async () => {
  const dead = server({
    '/api/cre/census/tracts': new Response('', { status: 502 }),
  });
  const a = validateSectionResult(
    await load(CTX, { fetchImpl: dead.fetchImpl }),
  );
  assert.equal(a.status, 'unavailable');
  assert.match(a.message, /TIGERweb/);
  const none = server({
    '/api/cre/census/tracts': {
      status: 'empty',
      data: { siteTract: null, tracts: [] },
    },
  });
  const b = validateSectionResult(
    await load(CTX, { fetchImpl: none.fetchImpl }),
  );
  assert.equal(b.status, 'empty');
});

test('ring scopes follow the context radii and label them in miles', () => {
  assert.deepEqual(
    ringScopes({}).map((s) => s.label),
    ['1 mi', '3 mi', '5 mi'],
  );
  assert.equal(ringScopes({ rings: { oneMi: 804.672 } })[0].label, '0.5 mi');
});


const VINTAGES = {
  vintage: 'ACS 2020-2024 5-year',
  priorVintage: 'ACS 2016-2020 5-year',
};

test('a suppressed component makes the whole rate null, it never shrinks it (A-S3-7)', () => {
  const full = aggregateAcs([{ cur: cur(), prior: prior() }]);
  assert.ok(Number.isFinite(full.rentBurdenPct));
  assert.ok(Number.isFinite(full.bachelorsPlusPct));
  const gap = aggregateAcs([
    { cur: cur({ grapi30: null, edBachelors: null }), prior: prior() },
  ]);
  assert.equal(gap.rentBurdenPct, null, 'not a smaller number');
  assert.equal(gap.bachelorsPlusPct, null);
  const denom = aggregateAcs([
    { cur: cur({ grapiNotComputed: null }), prior: prior() },
  ]);
  assert.equal(denom.rentBurdenPct, null, 'a null denominator part is not zero');
});

test('ringCoverage tells a ring that describes itself from one that does not (B-S2-3)', () => {
  const oneMi = RINGS_M.oneMi;
  // Fries VA: one tract of 118.1 km2 land standing in for a 3.1 sq mi ring.
  const rural = ringCoverage([{ landM2: 118_100_000 }], oneMi);
  assert.equal(rural.describesRing, false);
  assert.equal(round(rural.ringSqMi, 1), 3.1);
  assert.equal(round(rural.landSqMi, 1), 45.6);
  assert.ok(rural.ratio > 14, 'the tract is more than 14x the ring');
  const dense = ringCoverage(
    [{ landM2: 900_000 }, { landM2: 1_200_000 }, { landM2: 800_000 }],
    oneMi,
  );
  assert.equal(dense.describesRing, true);
  assert.equal(ringCoverage([{ landM2: null }], oneMi).describesRing, true);
});

test('a rural ring says the figures describe the site tract, not the ring area', () => {
  const rows = scopeValues('1 mi, tract area', aggregateAcs([{ cur: cur() }]), {
    ...VINTAGES,
    ring: true,
    areaNote:
      'these figures describe the tract(s) covering the site, not the 3.1 sq mi ring',
  });
  const population = rows.find((r) => r.label.startsWith('Population'));
  assert.match(population.label, /1 mi, tract area/);
  assert.match(population.note, /not the 3\.1 sq mi ring/);
});

test('an estimate its own margin swallows is suppressed, not stated (B-S3-1)', () => {
  const info = { ...VINTAGES, ring: false };
  // A real small-tract MOE edge case (ACS B23025): 29 unemployed, margin of error 48.
  const noisy = aggregateAcs([
    { cur: cur({ unemployed: 29, laborForce: 2767, unemployedMoe: 48 }) },
  ]);
  const rows = scopeValues('tract 47179060902', noisy, info);
  const rate = rows.find((r) => r.label.startsWith('Unemployment rate'));
  assert.equal(rate.value, 'Not distinguishable from zero');
  assert.match(rate.note, /29 \+\/- 48/);
  // NEGATIVE: a clean estimate keeps its number and gains the interval.
  const clean = aggregateAcs([
    {
      cur: cur({
        unemployed: 29,
        laborForce: 2767,
        unemployedMoe: 12,
        mhiMoe: 3440,
      }),
    },
  ]);
  const cleanRows = scopeValues('tract 47179060902', clean, info);
  assert.equal(
    typeof cleanRows.find((r) => r.label.startsWith('Unemployment rate')).value,
    'number',
  );
  assert.match(
    cleanRows.find((r) => r.label.startsWith('Median household income (')).note,
    /\+\/- 3440 \(90% confidence\)/,
  );
});

test('median gross rent always carries the tenant-paid utilities caveat (B-S3-2)', () => {
  const rows = scopeValues('tract 47179060902', aggregateAcs([{ cur: cur() }]), {
    ...VINTAGES,
    ring: false,
  });
  const rent = rows.find((r) => r.label.startsWith('Median gross rent ('));
  assert.match(rent.note, /tenant-paid utilities/);
});


test('a ring with no tract centroid inside is labelled the site tract, not the ring (B-S2-3)', () => {
  // Fries VA: the site tract's internal point is 5,211 m out, past both the
  // 1 mi and the 3 mi ring, so both rings resolved to that one tract.
  const tracts = [
    { geoid: '51077060101', distanceM: 5211, landM2: 118_100_000 },
    { geoid: '51640070102', distanceM: 7400, landM2: 9_500_000 },
  ];
  const oneMi = tractsInRing(tracts, RINGS_M.oneMi, '51077060101');
  assert.equal(oneMi.length, 1);
  assert.equal(isSiteTractOnly(oneMi), true);
  const threeMi = tractsInRing(tracts, RINGS_M.threeMi, '51077060101');
  assert.equal(isSiteTractOnly(threeMi), true, 'the 3 mi ring is the same one tract');
  // NEGATIVE: once a real centroid lands inside, the ring describes itself.
  const fiveMi = tractsInRing(tracts, RINGS_M.fiveMi, '51077060101');
  assert.equal(fiveMi.length, 2);
  assert.equal(isSiteTractOnly(fiveMi), false);
  // And a ring built without any substitution is never flagged.
  assert.equal(isSiteTractOnly(tractsInRing(tracts, RINGS_M.fiveMi, null)), false);
  assert.equal(isSiteTractOnly([]), false);
});

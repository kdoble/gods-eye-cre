// Tests for the QCEW and LAUS routes: county row parsing, the one-quarter fallback on 404, unavailable after two 404s, and the LAUS latest and year-ago rates.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  latestExpectedAnnualYear,
  latestExpectedQuarter,
  loadLaus,
  loadQcewAnnualCounty,
  loadQcewCounty,
  loadQcewSectors,
  parseQcewAnnualCounty,
  parseQcewCounty,
  parseQcewSupersectors,
  sectorConcentration,
  loadCachedReady,
  previousQuarter,
  qcewCountyHandler,
  qcewCountyAnnualHandler,
  QCEW_ANNUAL_CACHE_VERSION,
} from '../../../server/providers/cre/qcew.js';
import { createCreCache } from '../../../server/providers/cre/common/cache.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HEADER =
  '"area_fips","own_code","industry_code","agglvl_code","size_code","year","qtr","disclosure_code","qtrly_estabs","month1_emplvl","month2_emplvl","month3_emplvl","avg_wkly_wage","oty_month3_emplvl_chg","oty_month3_emplvl_pct_chg","oty_avg_wkly_wage_chg","oty_avg_wkly_wage_pct_chg"';
const CSV = [
  HEADER,
  '"47179","5","10","71","0","2026","1","",3000,50000,50100,50200,1050,500,1.0,20,1.9',
  '"47179","0","10","70","0","2026","1","",3620,62146,62900,63348,1121,-968,-1.5,44,4.1',
].join('\n');

test('the total-covered county row yields employment and wage with year-over-year change', () => {
  const row = parseQcewCounty(CSV);
  assert.equal(row.month1Employment, 62146);
  assert.equal(row.month3Employment, 63348);
  assert.equal(row.avgWeeklyWage, 1121);
  assert.equal(row.employmentChangeYoYPct, -1.5);
  assert.equal(row.avgWeeklyWageChangeYoYPct, 4.1);
  assert.equal(row.year, 2026);
});

test('NEGATIVE: a suppressed (disclosure N) row is not reported as data', () => {
  const suppressed = CSV.replace(
    '"70","0","2026","1",""',
    '"70","0","2026","1","N"',
  );
  assert.equal(parseQcewCounty(suppressed), null);
  assert.throws(() => parseQcewCounty('a,b\n1,2'));
});

// Recorded from https://data.bls.gov/cew/data/api/2025/a/area/13121.csv on 2026-09-24.
const ANNUAL_HEADER =
  '"area_fips","own_code","industry_code","agglvl_code","size_code","year","qtr","disclosure_code","annual_avg_estabs","annual_avg_emplvl","total_annual_wages","taxable_annual_wages","annual_contributions","annual_avg_wkly_wage","avg_annual_pay","lq_disclosure_code","lq_annual_avg_estabs","lq_annual_avg_emplvl","lq_total_annual_wages","lq_taxable_annual_wages","lq_annual_contributions","lq_annual_avg_wkly_wage","lq_avg_annual_pay","oty_disclosure_code","oty_annual_avg_estabs_chg","oty_annual_avg_estabs_pct_chg","oty_annual_avg_emplvl_chg","oty_annual_avg_emplvl_pct_chg","oty_total_annual_wages_chg","oty_total_annual_wages_pct_chg","oty_taxable_annual_wages_chg","oty_taxable_annual_wages_pct_chg","oty_annual_contributions_chg","oty_annual_contributions_pct_chg","oty_annual_avg_wkly_wage_chg","oty_annual_avg_wkly_wage_pct_chg","oty_avg_annual_pay_chg","oty_avg_annual_pay_pct_chg"';
const ANNUAL_FULTON_2025 =
  '"13121","0","10","70","0","2025","A","",81140,948768,98624571251,9990381862,114878977,1999,103950,"",1.00,1.00,1.00,1.00,1.00,1.00,1.00,"",8424,11.6,611,0.1,3034654446,3.2,3276448,0.0,-1737697,-1.5,60,3.1,3133,3.1';
const ANNUAL_CSV = [ANNUAL_HEADER, ANNUAL_FULTON_2025].join('\n');

test('DATA-07: the annual county row yields the true annual average weekly wage (real Fulton 2025 file)', () => {
  const row = parseQcewAnnualCounty(ANNUAL_CSV);
  assert.equal(row.avgWeeklyWage, 1999, 'not the $2,355 Q1 figure the review flagged as misleading');
  assert.equal(row.avgWeeklyWage * 52, 103948, 'weekly x 52, the house rule for an annual figure');
  assert.equal(row.year, 2025);
  assert.equal(row.employment, 948768);
});

test('NEGATIVE: parseQcewAnnualCounty rejects a quarterly-shaped file with no annual_avg_wkly_wage column', () => {
  assert.throws(() => parseQcewAnnualCounty(CSV));
});

test('latestExpectedAnnualYear follows the same publication lag as the quarterly file', () => {
  assert.equal(
    latestExpectedAnnualYear(new Date('2026-09-24T12:00:00Z')),
    2025,
  );
  assert.equal(
    latestExpectedAnnualYear(new Date('2026-03-01T12:00:00Z')),
    2024,
  );
});

test('NEGATIVE: a 404 on the latest annual file falls back one year', async () => {
  const seen = [];
  const result = await loadQcewAnnualCounty('13121', {
    now: () => new Date('2026-09-24T12:00:00Z'),
    fetchImpl: async (url) => {
      seen.push(String(url));
      return String(url).includes('/2025/')
        ? new Response('', { status: 404 })
        : new Response(ANNUAL_CSV.replace('"2025"', '"2024"'), { status: 200 });
    },
  });
  assert.equal(result.status, 'ready');
  assert.equal(seen.length, 2);
  assert.equal(result.data.avgWeeklyWage, 1999);
});

test('S-2: the qcew-annual cache family is version-bumped so a pre-existing entry without avgAnnualPay is never served stale', async (t) => {
  assert.equal(
    QCEW_ANNUAL_CACHE_VERSION,
    2,
    'a v1 disk entry predates avgAnnualPay; the family must be on a newer version so it is never read as fresh',
  );

  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'cre-qcew-annual-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  // Simulate a disk entry written by the pre-fix code: same family, default
  // (unbumped) version, an old-shaped row with no avgAnnualPay.
  const staleCache = createCreCache({
    family: 'qcew-annual',
    ttlMs: 30 * 24 * 60 * 60 * 1000,
    rootDir,
  });
  await staleCache.set('county-annual:13121', {
    status: 'ready',
    data: { year: 2024, avgWeeklyWage: 1900, avgAnnualPay: null },
    sourceUrls: [],
  });

  // The real handler, pointed at the same disk root, must not see that
  // stale entry -- it should reload from the fresh upstream and cache the
  // new shape with avgAnnualPay populated.
  let fetchCount = 0;
  const handler = qcewCountyAnnualHandler({
    cacheRoot: rootDir,
    now: () => new Date('2026-09-24T12:00:00Z'),
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response(ANNUAL_CSV, { status: 200 });
    },
  });
  const res = {
    status: 0,
    body: '',
    writeHead(s) {
      this.status = s;
    },
    end(b = '') {
      this.body = b;
    },
  };
  await handler({ url: '/?fips=13121', method: 'GET', socket: {} }, res);
  assert.equal(fetchCount, 1, 'the stale v1 entry must not short-circuit the reload');
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(
    body.data.avgAnnualPay,
    103950,
    'the reloaded, correctly-versioned entry must carry avgAnnualPay from the fresh source',
  );
});

test('latest expected quarter respects the publication lag', () => {
  assert.deepEqual(latestExpectedQuarter(new Date('2026-09-22T12:00:00Z')), {
    year: 2026,
    qtr: 1,
  });
  assert.deepEqual(latestExpectedQuarter(new Date('2026-12-05T12:00:00Z')), {
    year: 2026,
    qtr: 2,
  });
  assert.deepEqual(latestExpectedQuarter(new Date('2026-02-01T12:00:00Z')), {
    year: 2025,
    qtr: 2,
  });
  assert.deepEqual(previousQuarter({ year: 2026, qtr: 1 }), {
    year: 2025,
    qtr: 4,
  });
});

const now = () => new Date('2026-09-22T12:00:00Z');

test('NEGATIVE: a 404 on the latest quarter falls back one quarter', async () => {
  const seen = [];
  const result = await loadQcewCounty('47179', {
    now,
    fetchImpl: async (url) => {
      seen.push(String(url));
      return String(url).includes('/2026/1/')
        ? new Response('', { status: 404 })
        : new Response(CSV, { status: 200 });
    },
  });
  assert.equal(result.status, 'ready');
  assert.deepEqual(seen, [
    'https://data.bls.gov/cew/data/api/2026/1/area/47179.csv',
    'https://data.bls.gov/cew/data/api/2025/4/area/47179.csv',
  ]);
});

test('NEGATIVE: two 404s yield unavailable, never a zero', async () => {
  const result = await loadQcewCounty('47179', {
    now,
    fetchImpl: async () => new Response('', { status: 404 }),
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.data, null);
  assert.match(result.message, /latest two/);
});

test('a 503 is retried once', async () => {
  let calls = 0;
  const result = await loadQcewCounty('47179', {
    now,
    retryDelayMs: 1,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response('', { status: 503 })
        : new Response(CSV);
    },
  });
  assert.equal(result.status, 'ready');
  assert.equal(calls, 2);
});

test('county route refuses a bad fips', async () => {
  const res = {
    status: 0,
    body: '',
    writeHead(s) {
      this.status = s;
    },
    end(b = '') {
      this.body = b;
    },
  };
  await qcewCountyHandler({ cache: null, limiter: null })(
    { url: '/?fips=4717', method: 'GET', socket: {} },
    res,
  );
  assert.equal(res.status, 400);
});

const LAUS = {
  status: 'REQUEST_SUCCEEDED',
  Results: {
    series: [
      {
        seriesID: 'LAUCN471790000000003',
        data: [
          {
            year: '2026',
            period: 'M07',
            value: '3.4',
            footnotes: [{ code: 'P' }],
          },
          { year: '2026', period: 'M06', value: '3.6', footnotes: [{}] },
          { year: '2025', period: 'M13', value: '3.3', footnotes: [{}] },
          { year: '2025', period: 'M07', value: '3.9', footnotes: [{}] },
        ],
      },
    ],
  },
};

test('LAUS yields the latest month and the same month a year earlier', async () => {
  let seen = '';
  const result = await loadLaus('47179', {
    fetchImpl: async (url) => {
      seen = String(url);
      return Response.json(LAUS);
    },
  });
  assert.equal(
    seen,
    'https://api.bls.gov/publicAPI/v2/timeseries/data/LAUCN471790000000003',
  );
  assert.deepEqual(result.data, {
    fips: '47179',
    series: 'LAUCN471790000000003',
    period: '2026-07',
    rate: 3.4,
    preliminary: true,
    yearAgoRate: 3.9,
  });
});

test('NEGATIVE: a BLS daily-limit answer is unavailable', async () => {
  const result = await loadLaus('47179', {
    fetchImpl: async () =>
      Response.json({ status: 'REQUEST_NOT_PROCESSED', message: ['limit'] }),
  });
  assert.equal(result.status, 'unavailable');
});

test('a transient LAUS 503 is retried once; a second 503 is an error', async () => {
  let calls = 0;
  const ok = await loadLaus('47179', {
    retryDelayMs: 1,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response('', { status: 503 })
        : Response.json(LAUS);
    },
  });
  assert.equal(ok.status, 'ready');
  assert.equal(calls, 2);
  await assert.rejects(
    loadLaus('47179', {
      retryDelayMs: 1,
      fetchImpl: async () => new Response('', { status: 503 }),
    }),
  );
});


test('a cached answer is stamped when the DATA was fetched, not when it was asked for (B-S2-2)', async () => {
  const cache = createCreCache({ family: 'test-laus', ttlMs: 60_000, disk: false });
  let calls = 0;
  const load = async () => {
    calls += 1;
    return { status: 'ready', data: { rate: 3.4 }, sourceUrls: [] };
  };
  const first = await loadCachedReady(cache, 'laus:47179', load);
  assert.equal(first.stale, false);
  assert.ok(Number.isFinite(first.cachedAt));
  await new Promise((r) => setTimeout(r, 20));
  const second = await loadCachedReady(cache, 'laus:47179', load);
  assert.equal(calls, 1, 'served from cache');
  assert.equal(
    second.cachedAt,
    first.cachedAt,
    'the stamp does not move to now on a cache hit',
  );
  assert.ok(second.cachedAt < Date.now(), 'and it is in the past');
});

test('NEGATIVE: a BLS refusal serves the cached rate and marks it stale, never fresh', async () => {
  const cache = createCreCache({ family: 'test-laus2', ttlMs: 1, disk: false });
  await loadCachedReady(cache, 'laus:47179', async () => ({
    status: 'ready',
    data: { rate: 3.4 },
    sourceUrls: [],
  }));
  await new Promise((r) => setTimeout(r, 10));
  // This is the live BLS answer today: REQUEST_NOT_PROCESSED, daily threshold.
  const refused = await loadCachedReady(cache, 'laus:47179', async () => ({
    status: 'unavailable',
    data: null,
    sourceUrls: [],
    message: 'BLS LAUS did not process the request (daily limit or bad series)',
  }));
  assert.equal(refused.result.data.rate, 3.4, 'the last good value is served');
  assert.equal(refused.stale, true, 'and it is flagged as cached');
  assert.ok(refused.cachedAt < Date.now());
});

// Recorded from https://data.bls.gov/cew/data/api/2025/a/area/13121.csv on
// 2026-09-24: the total-private row (own_code 5, industry 10, agglvl 71) and
// every private supersector row (agglvl 73), Fulton County, GA, 2025 annual.
const SUPERSECTOR_HEADER =
  '"area_fips","own_code","industry_code","agglvl_code","size_code","year","qtr","disclosure_code","annual_avg_estabs","annual_avg_emplvl","total_annual_wages","taxable_annual_wages","annual_contributions","annual_avg_wkly_wage","avg_annual_pay","lq_disclosure_code","lq_annual_avg_estabs","lq_annual_avg_emplvl","lq_total_annual_wages","lq_taxable_annual_wages","lq_annual_contributions","lq_annual_avg_wkly_wage","lq_avg_annual_pay","oty_disclosure_code","oty_annual_avg_estabs_chg","oty_annual_avg_estabs_pct_chg","oty_annual_avg_emplvl_chg","oty_annual_avg_emplvl_pct_chg","oty_total_annual_wages_chg","oty_total_annual_wages_pct_chg","oty_taxable_annual_wages_chg","oty_taxable_annual_wages_pct_chg","oty_annual_contributions_chg","oty_annual_contributions_pct_chg","oty_annual_avg_wkly_wage_chg","oty_annual_avg_wkly_wage_pct_chg","oty_avg_annual_pay_chg","oty_avg_annual_pay_pct_chg"';
const SUPERSECTOR_ROWS = [
  '"13121","5","10","71","0","2025","A","","80591","840040","89087767689","9912377376","114613808","2039","106052","","1.02","1.04","1.05","1.01","1.00","1.02","1.02","","8433","11.7","-1214","-0.1","2599216829","3.0","-155938","0.0","-1688845","-1.5","62","3.1","3243","3.2"',
  '"13121","5","1011","73","0","2025","A","","121","740","80116576","10727637","84804","2082","108241","","0.13","0.07","0.07","0.06","0.03","1.08","1.08","","13","12.0","50","7.2","10312145","14.8","655643","6.5","-37700","-30.8","136","7.0","7026","6.9"',
  '"13121","5","1012","73","0","2025","A","","3470","24308","2691443324","343821296","4245163","2129","110721","","0.55","0.48","0.48","0.44","0.29","0.99","0.99","","490","16.4","719","3.0","225789647","9.2","23114747","7.2","21945","0.5","119","5.9","6195","5.9"',
  '"13121","5","1013","73","0","2025","A","","2055","27003","2784091347","334193833","3741096","1983","103103","","0.77","0.35","0.31","0.32","0.34","0.87","0.87","","240","13.2","-1002","-3.6","101778002","3.8","-11947794","-3.5","216889","6.2","141","7.7","7323","7.6"',
  '"13121","5","1021","73","0","2025","A","","9653","145460","11239747932","1725325175","18192044","1486","77271","","0.71","0.83","0.76","0.80","0.87","0.91","0.91","","600","6.6","-6835","-4.5","-111912317","-1.0","-45177363","-2.6","-2171459","-10.7","53","3.7","2734","3.7"',
  '"13121","5","1022","73","0","2025","A","","2839","53764","9640927390","708884787","7841187","3448","179320","","1.43","3.10","2.20","2.61","2.06","0.71","0.71","","361","14.6","-1554","-2.8","688314","0.0","-31846924","-4.3","-1351419","-14.7","97","2.9","5049","2.9"',
  '"13121","5","1023","73","0","2025","A","","9208","90621","14137628322","1151930850","11660059","3000","156008","","1.28","1.70","1.51","1.62","1.50","0.89","0.89","","899","10.8","1409","1.6","622690327","4.6","-7232034","-0.6","-136902","-1.2","87","3.0","4516","3.0"',
  '"13121","5","1024","73","0","2025","A","","24206","229961","31158167313","2978827109","36989006","2606","135493","","1.42","1.69","1.59","1.52","1.49","0.95","0.95","","2996","14.1","-776","-0.3","739744310","2.4","-52496138","-1.7","-1361408","-3.5","71","2.8","3662","2.8"',
  '"13121","5","1025","73","0","2025","A","","8576","136201","11148058313","1092338117","11180354","1574","81850","","0.57","0.85","0.79","0.86","0.84","0.93","0.93","","878","11.4","5015","3.8","757523689","7.3","126522927","13.1","1346115","13.7","51","3.3","2645","3.3"',
  '"13121","5","1026","73","0","2025","A","","5902","100634","4078803803","1201369651","15004383","779","40531","","0.89","0.98","0.88","1.09","1.28","0.90","0.90","","266","4.7","-75","-0.1","76745751","1.9","-7602877","-0.6","1309288","9.6","15","2.0","792","2.0"',
  '"13121","5","1027","73","0","2025","A","","4838","26410","1580380834","283978308","3625677","1151","59841","","0.82","0.93","0.77","0.90","1.07","0.83","0.83","","339","7.5","640","2.5","15981135","1.0","-7636312","-2.6","126959","3.6","-16","-1.4","-866","-1.4"',
  '"13121","5","1029","73","0","2025","A","","9724","4938","548402535","80980613","2050035","2136","111059","","5.97","4.03","4.12","3.80","5.18","1.02","1.02","","1353","16.2","1195","31.9","159875826","41.1","13490187","20.0","348847","20.5","140","7.0","7270","7.0"',
];
const SUPERSECTOR_CSV = [SUPERSECTOR_HEADER, ...SUPERSECTOR_ROWS].join('\n');

test('parseQcewSupersectors reads the real Fulton 2025 file: 10 private supersectors (no Public administration in private ownership), total-private employment, 1029 Unclassified dropped', () => {
  const parsed = parseQcewSupersectors(SUPERSECTOR_CSV);
  assert.equal(parsed.year, 2025);
  assert.equal(parsed.totalPrivateEmployment, 840040);
  assert.equal(parsed.sectors.length, 10, 'Unclassified (1029) is not a sector');
  assert.ok(
    !parsed.sectors.some((s) => s.code === '1029'),
    'Unclassified never appears',
  );
  const info = parsed.sectors.find((s) => s.code === '1022');
  assert.equal(info.title, 'Information');
  assert.equal(info.employment, 53764);
  assert.equal(info.lq, 3.1);
});

test('NEGATIVE: a suppressed (disclosure N) supersector row is dropped, not reported as data', () => {
  const suppressed = SUPERSECTOR_CSV.replace(
    '"1022","73","0","2025","A",""',
    '"1022","73","0","2025","A","N"',
  );
  const parsed = parseQcewSupersectors(suppressed);
  assert.ok(!parsed.sectors.some((s) => s.code === '1022'));
});

test('NEGATIVE: a file with only the total-private row and no supersectors yields null, never an empty-but-ready result', () => {
  assert.equal(
    parseQcewSupersectors([SUPERSECTOR_HEADER, SUPERSECTOR_ROWS[0]].join('\n')),
    null,
  );
});

test('NEGATIVE: parseQcewSupersectors rejects a file missing the lq_annual_avg_emplvl column', () => {
  assert.throws(() => parseQcewSupersectors(CSV));
});

// FIX (misleading flag): Fulton's 27.4% Professional and business services
// share is a broad urban supersector, not a one-industry economy. It must
// NOT read as "single-sector dependence" (that caution is reserved for a
// largest-sector share >= 35%, documented in DATA_SOURCES.md), and the
// "concentrated vs U.S." marker requires BOTH LQ >= 1.5 AND sector share
// >= 10% -- Information clears LQ 1.5 (3.1) but is only 6.4% of the county,
// so it drops off the concentrated list under the new rule.
test('sectorConcentration: Fulton is informational, not a single-sector-dependence caution; concentrated requires LQ >= 1.5 AND share >= 10%', () => {
  const parsed = parseQcewSupersectors(SUPERSECTOR_CSV);
  const result = sectorConcentration(parsed);
  assert.equal(result.top.title, 'Professional and business services');
  assert.equal(Math.round(result.top.sharePct * 10) / 10, 27.4);
  assert.equal(
    result.singleSectorDependence,
    false,
    'Fulton at 27.4% stays below the 35% single-sector-dependence line',
  );
  assert.deepEqual(
    result.concentrated.map((s) => s.title),
    ['Financial activities', 'Professional and business services'],
  );
  // Information (LQ 3.1) never appears as concentrated: only 6.4% share.
  assert.ok(!result.concentrated.some((s) => s.title === 'Information'));
  // Natural resources and mining (LQ 0.07) never appears as concentrated.
  assert.ok(!result.concentrated.some((s) => s.title === 'Natural resources and mining'));
});

test('NEGATIVE: no sector reaches 35% share on a flatter fixture, so singleSectorDependence is false', () => {
  const parsed = parseQcewSupersectors(SUPERSECTOR_CSV);
  const flattened = {
    ...parsed,
    sectors: parsed.sectors.map((s) => ({ ...s, employment: 1000, lq: 1 })),
  };
  const result = sectorConcentration(flattened);
  assert.equal(result.singleSectorDependence, false);
  assert.equal(result.concentrated.length, 0);
});

test('synthetic 40% case: a single sector at 40% share triggers the single-sector-dependence caution', () => {
  const parsed = parseQcewSupersectors(SUPERSECTOR_CSV);
  const total = parsed.totalPrivateEmployment;
  const boosted = {
    ...parsed,
    sectors: parsed.sectors.map((s) =>
      s.code === '1024' ? { ...s, employment: Math.round(total * 0.4) } : s,
    ),
  };
  const result = sectorConcentration(boosted);
  assert.equal(result.top.title, 'Professional and business services');
  assert.ok(result.top.sharePct >= 35);
  assert.equal(result.singleSectorDependence, true);
});

test('loadQcewSectors: a 404 on the latest annual file falls back one year, same as loadQcewAnnualCounty', async () => {
  const seen = [];
  const result = await loadQcewSectors('13121', {
    now: () => new Date('2026-09-24T12:00:00Z'),
    fetchImpl: async (url) => {
      seen.push(String(url));
      return String(url).includes('/2025/')
        ? new Response('', { status: 404 })
        : new Response(SUPERSECTOR_CSV.replace(/"2025"/g, '"2024"'), {
            status: 200,
          });
    },
  });
  assert.equal(result.status, 'ready');
  assert.equal(seen.length, 2);
  assert.equal(result.data.top.title, 'Professional and business services');
});

test('NEGATIVE: loadQcewSectors is unavailable, never a fabricated zero, after two 404s', async () => {
  const result = await loadQcewSectors('13121', {
    now: () => new Date('2026-09-24T12:00:00Z'),
    fetchImpl: async () => new Response('', { status: 404 }),
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.data, null);
});

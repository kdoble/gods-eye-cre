// Tests for the demand drivers section through the real /api/cre/demand-drivers routes with mocked HIFLD layers plus a stubbed LODES cluster route: top 3 hospitals and colleges with straight-line miles, beds and enrollment, the county job cluster distance, and the unavailable state.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDemandDriversSection,
  DEMAND_DRIVERS_MESSAGES,
} from './demandDrivers.js';
import { createDemandDriverHandlers } from '../../../server/providers/cre/demandDrivers.js';
import {
  isPlaceholderValue,
  SECTION_STATUS,
  validateSectionResult,
} from '../contract.js';
import { RINGS_M } from '../config.js';
import { mountAt, routeFetch } from './routeFetch.testutil.mjs';
import { ARCGIS_400, TIMING, json } from '../server/wp3Fixtures.testutil.mjs';
import {
  ATLANTA_POINT,
  CMS_HOSPITALS_ATLANTA,
  COLLEGES_ATLANTA,
  HOSPITALS_ATLANTA,
  upstreamBy,
} from '../server/p6bFixtures.testutil.mjs';

const CTX = {
  ...ATLANTA_POINT,
  address: 'x',
  rings: RINGS_M,
  tractGeoid: '13121001302',
};

const CLUSTER = {
  status: 'ready',
  data: {
    year: 2023,
    county: '13121',
    geoid: '13121011900',
    lat: 33.7876,
    lon: -84.3831,
    clusterJobs: 250000,
    countyJobs: 900000,
  },
  sourceUrls: ['https://lehd.ces.census.gov/data/lodes/LODES8/ga/wac/'],
};

function sectionFor({
  hospitals = HOSPITALS_ATLANTA,
  colleges = COLLEGES_ATLANTA,
  cluster = CLUSTER,
  cms = CMS_HOSPITALS_ATLANTA,
} = {}) {
  const upstream = upstreamBy([
    ['Hospitals_RAPT/FeatureServer/6', hospitals],
    ['Colleges_and_Universities/FeatureServer/5', colleges],
    ['data.cms.gov/provider-data/api/1/datastore/query', cms],
  ]);
  const handlers = createDemandDriverHandlers({
    fetchImpl: upstream.fetchImpl,
    timing: TIMING,
    cacheOptions: { disk: false },
    limiter: null,
  });
  const routes = routeFetch(mountAt('demand-drivers', handlers));
  const lodesCalls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('/api/cre/lodes/cluster')) {
      lodesCalls.push(String(url));
      return cluster ? json(cluster) : json({ error: 'x' }, 502);
    }
    return routes(url, init);
  };
  return { section: createDemandDriversSection({ fetchImpl }), lodesCalls };
}

const find = (result, pattern) => result.values.find((v) => pattern.test(v.label));

test('ready: counts, top 3 hospitals with beds, top 3 colleges with enrollment, job cluster miles', async () => {
  const { section, lodesCalls } = sectionFor();
  const result = await section.load(CTX, {});
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.READY);
  assert.equal(result.id, 'demand-drivers');

  // OWNER DECISION: flag, don't exclude. WELLSTAR ATLANTA MEDICAL CENTER is
  // HIFLD-open (closed in reality, November 2022) and has no CMS record
  // under any normalization (M3); it is kept, flagged unverified, and never
  // in the headline. PIEDMONT (fuzzy-matched past its ", INC" mismatch),
  // CHOA EGLESTON (no CMS row exists at all), the ATLANTA VA (fuzzy-matched
  // to CMS's differently spelled record), FAR NAVAL HOSPITAL (MILITARY,
  // zero CMS candidates) and RIVERBEND COMMUNITY HOSPITAL (address-only
  // match) are all kept too, all 8 in-radius HIFLD-open records total.
  const openRow = find(result, /^Open hospitals within 10 mi/);
  assert.equal(openRow.value, 8);
  assert.match(openRow.note, /5 of 8 facilities confirmed in Medicare's current list/);
  assert.ok(!/excluded/.test(openRow.note), '"excluded" wording is gone');
  const hospitalRows = result.values.filter((v) => /^Hospital \d/.test(v.label));
  assert.equal(hospitalRows.length, 3);
  assert.ok(
    !hospitalRows.some((v) => /WELLSTAR/.test(v.label)),
    'CMS-unconfirmed Wellstar never appears in the headline',
  );
  const fullListRows = result.values.filter((v) => /^\d+\. /.test(v.label));
  assert.equal(fullListRows.length, 8, 'the full list carries every kept record, headline included');
  const wellstarFull = fullListRows.find((v) => /WELLSTAR/.test(v.label));
  assert.ok(wellstarFull, 'Wellstar is kept in the full list, not dropped');
  assert.match(
    wellstarFull.note,
    /Not in Medicare's current hospital list; confirm it operates/,
  );
  // F3: headline is the nearest 3 GENERAL hospitals only (general acute
  // care, critical access, military) -- not nearest-first across every
  // TYPE. Select Specialty (long-term care, 0.97 mi) and CHOA Egleston
  // (children, 2.74 mi) are each nearer than Piedmont or the Atlanta VA,
  // but neither is a general hospital, so neither makes the headline;
  // Emory Midtown, Piedmont, and the Atlanta VA (military) do.
  assert.ok(
    !hospitalRows.some((v) => /SELECT SPECIALTY/.test(v.label)),
    'long-term care never displaces a general hospital in the headline',
  );
  assert.ok(
    !hospitalRows.some((v) => /EGLESTON/.test(v.label)),
    "a children's hospital never displaces a general hospital in the headline",
  );
  const emory = hospitalRows.find((v) => /EMORY/.test(v.label));
  assert.ok(emory, 'Emory Midtown (general acute care) is in the headline');
  assert.match(emory.note, /beds not reported/);
  assert.ok(
    hospitalRows.some((v) => /PIEDMONT/.test(v.label)),
    'Piedmont (general acute care) is in the headline',
  );
  assert.ok(
    hospitalRows.some((v) => /ATLANTA VA/.test(v.label)),
    'the Atlanta VA (military) is in the headline',
  );

  // Second line: the facility types the headline left out, counted, never
  // dropped -- Select Specialty (long-term care) and CHOA Egleston
  // (children) are still real facilities nearby.
  const otherTypesRow = find(result, /^Also within 10 mi/);
  assert.ok(otherTypesRow, 'other facility types are surfaced, not silently dropped');
  assert.equal(otherTypesRow.value, "1 children's, 1 long-term care");

  // 5 degree-granting schools in range (Beauty Trade School is excluded,
  // not degree-granting); Atlanta Technical has unreported enrollment, so
  // it counts here but is left out of the top 3 and the total below.
  const collegesCountRow = find(result, /^Colleges and universities within 10 mi/);
  assert.equal(collegesCountRow.value, 5);
  assert.match(collegesCountRow.note, /1 of these has no reported enrollment/);
  assert.equal(
    find(result, /^Total enrollment within 10 mi/).value,
    39771 + 37000 + 2400 + 48,
  );
  const collegeRows = result.values.filter((v) => /^College \d/.test(v.label));
  assert.equal(collegeRows.length, 3);
  assert.match(
    collegeRows.find((v) => /GEORGIA INSTITUTE/.test(v.label)).note,
    /39,771 total enrollment/,
  );
  // Ranked by enrollment, not distance: Tiny Community College (48
  // students, nearest at 0.1 mi) does not make the top 3.
  assert.ok(!collegeRows.some((v) => /TINY COMMUNITY COLLEGE/.test(v.label)));
  assert.ok(collegeRows.some((v) => /SPELMAN COLLEGE/.test(v.label)));

  assert.deepEqual(lodesCalls, ['/api/cre/lodes/cluster?county=13121']);
  const cluster = find(result, /job cluster/);
  assert.equal(cluster.unit, 'mi');
  assert.ok(cluster.value > 0);
  assert.match(cluster.note, /LODES 2023/);
  assert.match(cluster.note, /13121011900/);
  // N8: this is a site-to-point distance to a tract centroid, not a
  // county-level statistic; the label's own "county's" wording must not
  // make exportCsv's keyword inference mislabel its geography.
  assert.equal(cluster.geography, 'tract');

  for (const row of result.values) {
    assert.ok(!isPlaceholderValue(row.value), row.label);
    assert.ok(row.note && row.note.length > 10, row.label);
    assert.ok(!/[–—]/.test(`${row.label} ${row.note}`), row.label);
  }
  for (const row of [...hospitalRows, ...collegeRows]) {
    assert.match(row.note, /straight-line/, row.label);
    assert.match(row.note, /HIFLD/, row.label);
  }
});

test('NEGATIVE: the job cluster failing costs only that row; the section says which source did not answer', async () => {
  const { section } = sectionFor({ cluster: null });
  const result = await section.load(CTX, {});
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.READY);
  assert.equal(find(result, /job cluster/), undefined);
  assert.match(result.message, /LODES/);
});

test('NEGATIVE: CMS cross-check unreachable shows HIFLD results with a not-cross-checked caution, never a silent drop', async () => {
  const { section } = sectionFor({
    cms: () => {
      throw new Error('network down');
    },
  });
  const result = await section.load(CTX, {});
  validateSectionResult(result);
  const openRow = find(result, /^Open hospitals within 10 mi/);
  assert.match(openRow.note, /not cross-checked; confirm each facility operates/);
  const hospitalRows = result.values.filter((v) => /^Hospital \d/.test(v.label));
  assert.ok(
    hospitalRows.some((v) => /WELLSTAR/.test(v.label)),
    'uncross-checked HIFLD results are shown, not silently dropped',
  );
});

test('NEGATIVE: both HIFLD layers down and no cluster is unavailable, never zeros', async () => {
  const { section } = sectionFor({
    hospitals: ARCGIS_400,
    colleges: ARCGIS_400,
    cluster: null,
  });
  const result = await section.load(CTX, {});
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.UNAVAILABLE);
  assert.equal(result.message, DEMAND_DRIVERS_MESSAGES.unavailable);
  assert.equal(result.values.length, 0);
});

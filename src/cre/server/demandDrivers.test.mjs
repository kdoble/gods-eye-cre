// Tests for /api/cre/demand-drivers/{hospitals,colleges}: the three nearest open hospitals (beds when reported) and degree-granting colleges (enrollment when reported) within 10 straight-line miles from the FEMA-hosted HIFLD layers, with closed, trade-school, out-of-range and sentinel values filtered, and the upstream-failure negative.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  CMS_STATUS,
  COLLEGES_LAYER,
  createDemandDriverHandlers,
  crossCheckHospitalsWithCms,
  DEMAND_RADIUS_MI,
  HOSPITALS_LAYER,
  rankHospitalsByGeneralAcuteType,
} from '../../../server/providers/cre/demandDrivers.js';
import { createCreCache } from '../../../server/providers/cre/common/cache.js';
import { makeDeps } from '../../../server/providers/cre/site.js';
import { CRE_ERRORS } from '../../../server/providers/cre/common/route.js';
import { ARCGIS_400, SECRET, TIMING, call } from './wp3Fixtures.testutil.mjs';
import {
  ATLANTA,
  CMS_HOSPITALS_ATLANTA,
  COLLEGES_ATLANTA,
  HOSPITALS_ATLANTA,
  upstreamBy,
} from './p6bFixtures.testutil.mjs';

const handlersFor = ({
  hospitals = HOSPITALS_ATLANTA,
  colleges = COLLEGES_ATLANTA,
  cms = CMS_HOSPITALS_ATLANTA,
} = {}) => {
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
  return { handlers, upstream };
};

test('the layers are the FEMA-hosted HIFLD copies verified live on 2026-09-24', () => {
  assert.equal(
    HOSPITALS_LAYER,
    'https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Hospitals_RAPT/FeatureServer/6',
  );
  assert.equal(
    COLLEGES_LAYER,
    'https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Colleges_and_Universities/FeatureServer/5',
  );
  assert.equal(DEMAND_RADIUS_MI, 10);
});

test('hospitals: robust CMS cross-check keeps real hospitals a punctuation-exact match would drop, nearest first, beds when reported, the -999 sentinel is null, 10 mi straight-line query', async () => {
  const { handlers, upstream } = handlersFor();
  const body = (await call(handlers.hospitals, ATLANTA)).json();
  assert.equal(body.status, 'ready');
  const d = body.data;
  assert.equal(d.radiusMi, 10);
  // OWNER DECISION (this release): flag, never exclude. Every one of the 8
  // HIFLD-open fixture records within radius is kept (CLOSED TEST HOSPITAL
  // is dropped by STATUS and FAR HOSPITAL by radius before cross-check ever
  // runs) -- including WELLSTAR ATLANTA MEDICAL CENTER, the one genuine
  // closure CMS has no record of under any normalization.
  assert.equal(d.count, 8, 'nothing is excluded any more: all 8 in-radius, open HIFLD records are kept, Wellstar included');
  assert.equal(d.crossChecked, true);
  assert.equal(
    d.verifiedCount,
    5,
    '5 of the 8 confirm against CMS (Piedmont, Atlanta VA, Riverbend, Select Specialty, Emory Midtown); Egleston, Far Naval and Wellstar do not',
  );
  assert.ok(
    d.nearest.every((h) => h.name !== 'WELLSTAR ATLANTA MEDICAL CENTER'),
    'CMS-unconfirmed Wellstar never appears in the headline nearest-3, even though it is kept',
  );
  assert.ok(d.nearest.every((h) => h.name !== 'CLOSED TEST HOSPITAL'));
  assert.ok(d.nearest.every((h) => h.name !== 'FAR HOSPITAL'));
  for (let i = 1; i < d.nearest.length; i += 1) {
    assert.ok(d.nearest[i].distanceMi >= d.nearest[i - 1].distanceMi);
  }
  assert.equal(d.nearest.find((h) => h.name.startsWith('EMORY')).beds, null);
  // Full list: every kept record, by distance, Wellstar present and flagged.
  assert.equal(d.all.length, 8);
  const wellstar = d.all.find((h) => h.name === 'WELLSTAR ATLANTA MEDICAL CENTER');
  assert.ok(wellstar, 'Wellstar appears in the full list, not dropped');
  assert.equal(wellstar.cmsStatus, CMS_STATUS.NOT_LISTED);
  for (let i = 1; i < d.all.length; i += 1) {
    assert.ok(d.all[i].distanceMi >= d.all[i - 1].distanceMi, 'full list is ordered by distance');
  }
  const url = new URL(upstream.calls[0].url);
  assert.equal(url.searchParams.get('units'), 'esriSRUnit_Meter');
  assert.equal(Math.round(Number(url.searchParams.get('distance'))), 16093);
});

test("OWNER DECISION: headline takes only verified GENERAL ACUTE CARE/CRITICAL ACCESS/MILITARY records -- an unverified general-acute record (Wellstar) never displaces a verified one into the headline", async () => {
  const { handlers } = handlersFor();
  const d = (await call(handlers.hospitals, ATLANTA)).json().data;
  assert.ok(d.nearest.length <= 3);
  assert.ok(
    d.nearest.every((h) => h.cmsStatus !== CMS_STATUS.NOT_LISTED),
    'every headline record is CMS-verified (or cross-check did not run)',
  );
  assert.ok(
    d.nearest.every((h) =>
      ['GENERAL ACUTE CARE', 'CRITICAL ACCESS', 'MILITARY'].includes(
        String(h.type || '').toUpperCase(),
      ),
    ),
  );
});

/** Direct unit coverage of the cross-check itself, independent of the top-3 `nearest` cutoff. */
function directCrossCheck(cms = CMS_HOSPITALS_ATLANTA) {
  const upstream = upstreamBy([['data.cms.gov/provider-data/api/1/datastore/query', cms]]);
  const deps = makeDeps({ fetchImpl: upstream.fetchImpl, timing: TIMING });
  const items = [
    { name: 'PIEDMONT HOSPITAL', city: 'ATLANTA', state: 'GA', zip: '30309', address: '1968 PEACHTREE RD NW', type: 'GENERAL ACUTE CARE' },
    { name: "CHILDREN'S HEALTHCARE OF ATLANTA AT EGLESTON", city: 'ATLANTA', state: 'GA', zip: '30322', address: '1405 CLIFTON ROAD NE', type: 'CHILDREN' },
    { name: 'ATLANTA VA MEDICAL CENTER', city: 'DECATUR', state: 'GA', zip: '30033', address: '1670 CLAIRMONT ROAD', type: 'MILITARY' },
    { name: 'FAR NAVAL HOSPITAL', city: 'ATLANTA', state: 'GA', zip: '39999', address: '1 NAVAL WAY', type: 'MILITARY' },
    { name: 'RIVERBEND COMMUNITY HOSPITAL', city: 'ATLANTA', state: 'GA', zip: '30310', address: '42 MERGER PARKWAY', type: 'GENERAL ACUTE CARE' },
    { name: 'WELLSTAR ATLANTA MEDICAL CENTER', city: 'ATLANTA', state: 'GA', zip: '30312', address: '303 PARKWAY DRIVE NE', type: 'GENERAL ACUTE CARE' },
  ];
  return crossCheckHospitalsWithCms(items, deps.upstream);
}

test('cross-check: a punctuation-only name mismatch (PIEDMONT HOSPITAL vs CMS "PIEDMONT HOSPITAL, INC") is fuzzy-matched and CMS-verified', async () => {
  const { items } = await directCrossCheck();
  const piedmont = items.find((h) => h.name === 'PIEDMONT HOSPITAL');
  assert.ok(piedmont, 'exact-string matching would have dropped this real, open, 552-bed hospital');
  assert.equal(piedmont.cmsStatus, CMS_STATUS.VERIFIED);
});

test('cross-check: CHOA Egleston (pediatric, no CMS record exists at all) is kept and labeled not verified against CMS, never excluded', async () => {
  const { items } = await directCrossCheck();
  const egleston = items.find((h) =>
    h.name.includes("CHILDREN'S HEALTHCARE OF ATLANTA AT EGLESTON"),
  );
  assert.ok(egleston, "CHOA Egleston must appear; CMS's Medicare-scoped dataset does not cover pediatric specialty hospitals");
  assert.equal(egleston.cmsStatus, CMS_STATUS.NOT_LISTED);
});

test('cross-check: the Atlanta VA is fuzzy-matched to CMS\'s differently spelled record, not merely kept as a type exemption', async () => {
  const { items } = await directCrossCheck();
  const va = items.find((h) => h.name === 'ATLANTA VA MEDICAL CENTER');
  assert.ok(va);
  assert.equal(va.cmsStatus, CMS_STATUS.VERIFIED, 'token-overlap on ATLANTA + VA (state+city gated) should confirm this, not just the MILITARY-type fallback');
});

test('cross-check: a MILITARY-type record with zero CMS candidates anywhere is kept and labeled not verified, never excluded', async () => {
  const { items } = await directCrossCheck();
  const naval = items.find((h) => h.name === 'FAR NAVAL HOSPITAL');
  assert.ok(naval, 'MILITARY-type records must never require a CMS hit');
  assert.equal(naval.cmsStatus, CMS_STATUS.NOT_LISTED);
});

test('cross-check: a GENERAL ACUTE CARE record with zero name-token overlap is confirmed by shared street address, not excluded as a closure', async () => {
  const { items } = await directCrossCheck();
  const riverbend = items.find((h) => h.name === 'RIVERBEND COMMUNITY HOSPITAL');
  assert.ok(riverbend, 'address match must confirm this even though the names share zero tokens');
  assert.equal(riverbend.cmsStatus, CMS_STATUS.VERIFIED);
});

test('N-4: an address that reduces to a bare house number after generic-token stripping must not confirm via a different street sharing that number', async () => {
  const cms = {
    results: [
      {
        // Every word except the house number is a generic street-noun
        // token (BOULEVARD, PARKWAY, NE all get stripped), so this reduces
        // to the bare number {123} too -- would previously "match" on that
        // alone, with zero name-token overlap and an entirely different
        // (unknown) street.
        facility_name: 'UNRELATED MEDICAL FACILITY',
        citytown: 'ATLANTA',
        state: 'GA',
        zip_code: '30310',
        address: '123 BOULEVARD PARKWAY NE',
      },
    ],
  };
  const items = [
    {
      name: 'SOME CLOSED HOSPITAL',
      city: 'ATLANTA',
      state: 'GA',
      zip: '30311',
      // PARKWAY, DRIVE, NE are all generic tokens -- this address also
      // reduces to the bare house number {123}.
      address: '123 PARKWAY DRIVE NE',
      type: 'GENERAL ACUTE CARE',
    },
  ];
  const upstream = upstreamBy([
    ['data.cms.gov/provider-data/api/1/datastore/query', cms],
  ]);
  const deps = makeDeps({ fetchImpl: upstream.fetchImpl, timing: TIMING });
  const { items: kept } = await crossCheckHospitalsWithCms(items, deps.upstream);
  const closed = kept.find((h) => h.name === 'SOME CLOSED HOSPITAL');
  assert.ok(closed, 'flag, do not exclude: kept in the full list even though unconfirmed');
  assert.equal(
    closed.cmsStatus,
    CMS_STATUS.NOT_LISTED,
    'a bare house-number collision (MAIN vs OAK, no name overlap) must not confirm it',
  );
});

test('N-6: CHRONIC DISEASE is kept unverified, never excluded, when no CMS row matches', async () => {
  const cms = { results: [] };
  const items = [
    {
      name: 'RIVER VALLEY CHRONIC DISEASE HOSPITAL',
      city: 'ATLANTA',
      state: 'GA',
      zip: '30399',
      address: '9 NOWHERE RD',
      type: 'CHRONIC DISEASE',
    },
  ];
  const upstream = upstreamBy([
    ['data.cms.gov/provider-data/api/1/datastore/query', cms],
  ]);
  const deps = makeDeps({ fetchImpl: upstream.fetchImpl, timing: TIMING });
  const { items: kept } = await crossCheckHospitalsWithCms(items, deps.upstream);
  assert.equal(kept.length, 1, 'nothing is ever excluded for a CMS miss any more');
  assert.equal(kept[0].cmsStatus, CMS_STATUS.NOT_LISTED);
});

test('OWNER DECISION: SPECIAL and WOMEN are flagged, never excluded, on a CMS miss', async () => {
  const cms = { results: [] };
  const items = [
    {
      name: 'SOME SPECIAL HOSPITAL',
      city: 'ATLANTA',
      state: 'GA',
      zip: '30399',
      address: '9 NOWHERE RD',
      type: 'SPECIAL',
    },
    {
      name: 'SOME WOMENS HOSPITAL',
      city: 'ATLANTA',
      state: 'GA',
      zip: '30399',
      address: '10 NOWHERE RD',
      type: 'WOMEN',
    },
  ];
  const upstream = upstreamBy([
    ['data.cms.gov/provider-data/api/1/datastore/query', cms],
  ]);
  const deps = makeDeps({ fetchImpl: upstream.fetchImpl, timing: TIMING });
  const { items: kept } = await crossCheckHospitalsWithCms(items, deps.upstream);
  assert.equal(kept.length, 2, 'flag, do not exclude: both are kept in the full list');
  assert.ok(kept.every((h) => h.cmsStatus === CMS_STATUS.NOT_LISTED));
});

test('OWNER DECISION: NOT AVAILABLE type is flagged, never excluded, on a CMS miss', async () => {
  const cms = { results: [] };
  const items = [
    {
      name: 'UNKNOWN TYPE HOSPITAL',
      city: 'ATLANTA',
      state: 'GA',
      zip: '30399',
      address: '9 NOWHERE RD',
      type: 'NOT AVAILABLE',
    },
  ];
  const upstream = upstreamBy([
    ['data.cms.gov/provider-data/api/1/datastore/query', cms],
  ]);
  const deps = makeDeps({ fetchImpl: upstream.fetchImpl, timing: TIMING });
  const { items: kept } = await crossCheckHospitalsWithCms(items, deps.upstream);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].cmsStatus, CMS_STATUS.NOT_LISTED);
});

test('N-7: city comparison normalizes SAINT/ST, FORT/FT, MOUNT/MT, punctuation and whitespace before comparing', async () => {
  const cms = {
    results: [
      {
        facility_name: 'BARNES JEWISH HOSPITAL',
        citytown: 'SAINT LOUIS',
        state: 'MO',
        zip_code: null,
        address: '4990 KINGSHIGHWAY BLVD',
      },
    ],
  };
  const items = [
    {
      // No ZIP on the HIFLD side and no name-token overlap by itself, so
      // only the (normalized) city gate lets the address-match path even
      // reach this CMS row at all -- before N-7, the sameCity gate itself
      // would skip it and the address match underneath would never run.
      name: 'BJH',
      city: 'ST. LOUIS',
      state: 'MO',
      zip: null,
      address: '4990 KINGSHIGHWAY BOULEVARD',
      type: 'GENERAL ACUTE CARE',
    },
  ];
  const upstream = upstreamBy([
    ['data.cms.gov/provider-data/api/1/datastore/query', cms],
  ]);
  const deps = makeDeps({ fetchImpl: upstream.fetchImpl, timing: TIMING });
  const { items: kept } = await crossCheckHospitalsWithCms(items, deps.upstream);
  assert.equal(
    kept.length,
    1,
    '"ST. LOUIS" (HIFLD) and "SAINT LOUIS" (CMS) must be treated as the same city, letting the address match underneath run',
  );
  assert.equal(kept[0].cmsStatus, CMS_STATUS.VERIFIED);
});

test('(a) OWNER DECISION: WELLSTAR (GENERAL ACUTE CARE, genuinely closed, no CMS record under any normalization) appears in the full list flagged and never in the headline', async () => {
  const { items } = await directCrossCheck();
  const wellstar = items.find((h) => h.name === 'WELLSTAR ATLANTA MEDICAL CENTER');
  assert.ok(wellstar, 'kept, never dropped');
  assert.equal(wellstar.cmsStatus, CMS_STATUS.NOT_LISTED);
});

test('(b) OWNER DECISION: a satellite campus CMS surveys under its parent CCN (Memorial Hermann Southwest, absent from CMS by exact match) is kept and flagged, not dropped', async () => {
  // CMS carries only the flagship "MEMORIAL HERMANN HOSPITAL" downtown --
  // exactly the P3-1(a) same-city-satellite-campus case: CMS surveys the
  // whole system under one CCN, so a same-city Jaccard match on shared
  // "MEMORIAL HERMANN" tokens alone must not confirm a different campus at
  // a different ZIP/address, and this satellite gets no exact-key hit.
  const cms = {
    results: [
      {
        facility_name: 'MEMORIAL HERMANN HOSPITAL',
        citytown: 'HOUSTON',
        state: 'TX',
        zip_code: '77030',
        address: '6411 FANNIN ST',
      },
    ],
  };
  const items = [
    {
      name: 'MEMORIAL HERMANN SOUTHWEST HOSPITAL',
      city: 'HOUSTON',
      state: 'TX',
      zip: '77074',
      address: '7600 BEECHNUT ST',
      type: 'GENERAL ACUTE CARE',
    },
  ];
  const upstream = upstreamBy([
    ['data.cms.gov/provider-data/api/1/datastore/query', cms],
  ]);
  const deps = makeDeps({ fetchImpl: upstream.fetchImpl, timing: TIMING });
  const { items: kept } = await crossCheckHospitalsWithCms(items, deps.upstream);
  const southwest = kept.find((h) => h.name === 'MEMORIAL HERMANN SOUTHWEST HOSPITAL');
  assert.ok(southwest, 'a satellite campus absent by exact match must never be dropped from the list');
  assert.equal(southwest.cmsStatus, CMS_STATUS.NOT_LISTED, 'not confirmed by the parent-only CMS record, so flagged');
});

test('cross-check: a closed/renamed sibling campus is NOT confirmed through its parent hospital system sharing only a city; still confirmed by its own ZIP-matching CMS row (S-1)', async () => {
  const cms = {
    results: [
      {
        facility_name: 'EMORY UNIVERSITY HOSPITAL',
        citytown: 'ATLANTA',
        state: 'GA',
        zip_code: '30322',
        address: '1364 CLIFTON ROAD NE',
      },
    ],
  };
  const items = [
    {
      name: 'EMORY UNIVERSITY HOSPITAL MIDTOWN',
      city: 'ATLANTA',
      state: 'GA',
      zip: '30308',
      address: '550 PEACHTREE STREET NE',
      type: 'GENERAL ACUTE CARE',
    },
  ];
  const upstream = upstreamBy([
    ['data.cms.gov/provider-data/api/1/datastore/query', cms],
  ]);
  const deps = makeDeps({ fetchImpl: upstream.fetchImpl, timing: TIMING });
  const { items: kept } = await crossCheckHospitalsWithCms(items, deps.upstream);
  const midtown = kept.find((h) => h.name === 'EMORY UNIVERSITY HOSPITAL MIDTOWN');
  assert.ok(
    midtown,
    'kept in the full list even though a same-city-only Jaccard match on shared "EMORY UNIVERSITY" tokens must not confirm it',
  );
  assert.equal(midtown.cmsStatus, CMS_STATUS.NOT_LISTED);

  // Its own CMS row (same ZIP) still confirms it.
  const ownCms = {
    results: [
      {
        facility_name: 'EMORY UNIVERSITY HOSPITAL MIDTOWN',
        citytown: 'ATLANTA',
        state: 'GA',
        zip_code: '30308',
        address: '550 PEACHTREE STREET, NE',
      },
    ],
  };
  const upstream2 = upstreamBy([
    ['data.cms.gov/provider-data/api/1/datastore/query', ownCms],
  ]);
  const deps2 = makeDeps({ fetchImpl: upstream2.fetchImpl, timing: TIMING });
  const result2 = await crossCheckHospitalsWithCms(items, deps2.upstream);
  assert.equal(
    result2.items.find((h) => h.name === 'EMORY UNIVERSITY HOSPITAL MIDTOWN')
      ?.cmsStatus,
    CMS_STATUS.VERIFIED,
    'the same hospital verified by its own CMS row (matching ZIP) must still be confirmed',
  );
});

test('NEGATIVE: CMS cross-check unreachable falls back to raw HIFLD results with crossChecked false, never a silent drop', async () => {
  const { handlers } = handlersFor({
    cms: () => {
      throw new Error('network down');
    },
  });
  const d = (await call(handlers.hospitals, ATLANTA)).json().data;
  assert.equal(d.crossChecked, false);
  assert.ok(
    d.nearest.some((h) => h.name === 'WELLSTAR ATLANTA MEDICAL CENTER'),
    'uncross-checked HIFLD results are shown, not silently dropped',
  );
});

test('NULL-STATE: a HIFLD record with no state can never be run through CMS, so it must be labeled not-checked, not a false CMS miss', async () => {
  const upstream = upstreamBy([['data.cms.gov/provider-data/api/1/datastore/query', CMS_HOSPITALS_ATLANTA]]);
  const deps = makeDeps({ fetchImpl: upstream.fetchImpl, timing: TIMING });
  const items = [
    { name: 'GRADY MEMORIAL HOSPITAL', state: null, zip: '30303', type: 'GENERAL ACUTE CARE' },
  ];
  const result = await crossCheckHospitalsWithCms(items, deps.upstream);
  assert.equal(
    result.crossChecked,
    false,
    'no record in the batch had a usable state, so nothing could actually be checked',
  );
  assert.equal(
    result.items[0].cmsStatus,
    CMS_STATUS.NOT_CHECKED,
    'a record that was never queried against CMS must not be asserted as a CMS miss (cmsStatus: not-listed)',
  );
});

test('NULL-STATE: mixed batch -- a null-state record is left unchecked while its state-bearing siblings are still cross-checked normally', async () => {
  const upstream = upstreamBy([['data.cms.gov/provider-data/api/1/datastore/query', CMS_HOSPITALS_ATLANTA]]);
  const deps = makeDeps({ fetchImpl: upstream.fetchImpl, timing: TIMING });
  const items = [
    { name: 'GRADY MEMORIAL HOSPITAL', state: null, zip: '30303', type: 'GENERAL ACUTE CARE' },
    { name: 'PIEDMONT HOSPITAL', city: 'ATLANTA', state: 'GA', zip: '30309', address: '1968 PEACHTREE RD NW', type: 'GENERAL ACUTE CARE' },
  ];
  const result = await crossCheckHospitalsWithCms(items, deps.upstream);
  assert.equal(
    result.crossChecked,
    true,
    'at least one record in the batch had a usable state and was actually checked',
  );
  const grady = result.items.find((h) => h.name === 'GRADY MEMORIAL HOSPITAL');
  const piedmont = result.items.find((h) => h.name === 'PIEDMONT HOSPITAL');
  assert.equal(
    grady.cmsStatus,
    CMS_STATUS.NOT_CHECKED,
    'Grady has no state, so isConfirmedByCms can never run for it -- it must read as not-checked, not as a CMS miss',
  );
  assert.equal(piedmont.cmsStatus, CMS_STATUS.VERIFIED, 'Piedmont still gets a real cross-check result');
});

test('NULL-STATE: a not-checked record (state present in batch, but this one lacks it) never reaches the headline even though a genuine CMS-down record would', async () => {
  const { handlers } = handlersFor({
    hospitals: () => ({
      features: [
        {
          attributes: {
            NAME: 'GRADY MEMORIAL HOSPITAL',
            STATUS: 'OPEN',
            TYPE: 'GENERAL ACUTE CARE',
            CITY: 'ATLANTA',
            STATE: null,
            ZIP: '30303',
            ADDRESS: '80 JESSE HILL JR DR SE',
            BEDS: 900,
          },
          geometry: { x: ATLANTA.lon, y: ATLANTA.lat },
        },
      ],
    }),
  });
  const d = (await call(handlers.hospitals, ATLANTA)).json().data;
  assert.equal(d.crossChecked, false, 'nothing in this all-null-state response could be checked');
  assert.ok(
    !d.nearest.some((h) => h.name === 'GRADY MEMORIAL HOSPITAL'),
    'a record CMS was never asked about must not be asserted into the verified headline',
  );
});

/**
 * MUST FIX (coordinator review of 4bb0732): a tri-state built on "is the
 * cmsVerified key present, and what boolean does it hold" cannot survive a
 * JSON round-trip -- JSON.stringify drops any key whose value is undefined,
 * so "not-checked" (key present, value undefined) and "CMS never attempted"
 * (key absent) become identical the instant the record crosses the disk
 * cache or the HTTP response. cmsStatus is a string on every record in every
 * path specifically so it survives both.
 */
function fourStatusRecords() {
  return [
    { name: 'VERIFIED HOSPITAL', type: 'GENERAL ACUTE CARE', distanceMi: 1, cmsStatus: CMS_STATUS.VERIFIED },
    { name: 'NOT LISTED HOSPITAL', type: 'GENERAL ACUTE CARE', distanceMi: 2, cmsStatus: CMS_STATUS.NOT_LISTED },
    { name: 'NOT CHECKED HOSPITAL', type: 'GENERAL ACUTE CARE', distanceMi: 3, cmsStatus: CMS_STATUS.NOT_CHECKED },
    { name: 'CMS UNAVAILABLE HOSPITAL', type: 'GENERAL ACUTE CARE', distanceMi: 4, cmsStatus: CMS_STATUS.CMS_UNAVAILABLE },
  ];
}

function assertFourStatusRanking(items, label) {
  const { top } = rankHospitalsByGeneralAcuteType(items);
  const names = top.map((h) => h.name);
  assert.ok(names.includes('VERIFIED HOSPITAL'), `${label}: verified must reach the headline`);
  assert.ok(names.includes('CMS UNAVAILABLE HOSPITAL'), `${label}: the labeled CMS-down fallback must still reach the headline`);
  assert.ok(!names.includes('NOT LISTED HOSPITAL'), `${label}: a real CMS miss must never reach the headline`);
  assert.ok(!names.includes('NOT CHECKED HOSPITAL'), `${label}: a record that was never itself checked must never reach the headline on that technicality`);
}

test('JSON-ROUNDTRIP: headline composition for all four cmsStatus values is unchanged after JSON.parse(JSON.stringify(...))', () => {
  const original = fourStatusRecords();
  assertFourStatusRanking(original, 'pre-round-trip (sanity)');
  const roundTripped = JSON.parse(JSON.stringify(original));
  assert.deepEqual(
    roundTripped.map((h) => h.cmsStatus),
    original.map((h) => h.cmsStatus),
    'a string field must survive JSON.stringify/JSON.parse unchanged for every status',
  );
  assertFourStatusRanking(roundTripped, 'post-round-trip');
});

test('JSON-ROUNDTRIP: headline composition for all four cmsStatus values is unchanged after a real write/read through the disk cache', async () => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gev-cre-cache-test-'));
  try {
    const cache = createCreCache({
      family: 'demand-hospitals-rt-test',
      ttlMs: 60_000,
      rootDir,
      disk: true,
    });
    const original = fourStatusRecords();
    await cache.set('k', { data: { all: original } });
    cache.clearMemory(); // force the read to actually hit disk, not the in-process memory map
    const fresh = await cache.getFresh('k');
    assert.equal(fresh.source, 'DISK', 'the memory tier was cleared, so this must be a real disk round-trip');
    const roundTripped = fresh.value.data.all;
    assert.deepEqual(
      roundTripped.map((h) => h.cmsStatus),
      original.map((h) => h.cmsStatus),
      'a string field must survive the disk cache round-trip unchanged for every status',
    );
    assertFourStatusRanking(roundTripped, 'post-disk-cache');
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('colleges: degree-granting only (universities and junior colleges), ranked by total enrollment not distance, unreported enrollment excluded from ranking but counted', async () => {
  const { handlers } = handlersFor();
  const d = (await call(handlers.colleges, ATLANTA)).json().data;
  // 5 degree-granting schools within 10 mi: Georgia Tech, Georgia State,
  // Spelman, Tiny Community College and Atlanta Technical (unreported).
  // Beauty Trade School is not degree-granting and never counted.
  assert.equal(d.count, 5);
  assert.ok(d.nearest.every((c) => c.name !== 'BEAUTY TRADE SCHOOL'));
  // Tiny Community College is the NEAREST degree-granting school (0.1 mi)
  // but only 48 students; ranked by enrollment it falls out of the top 3
  // behind Georgia Tech, Georgia State and Spelman.
  assert.deepEqual(
    d.nearest.map((c) => c.name),
    ['GEORGIA INSTITUTE OF TECHNOLOGY-MAIN CAMPUS', 'GEORGIA STATE UNIVERSITY', 'SPELMAN COLLEGE'],
  );
  const tech = d.nearest.find((c) => c.name.startsWith('GEORGIA INSTITUTE'));
  assert.equal(tech.enrollment, 39771);
  assert.ok(tech.distanceMi > 0, 'distance is still shown alongside the enrollment rank');
  // Unreported enrollment (Atlanta Technical) is excluded from the ranking,
  // not zeroed or last-placed, but still counted.
  assert.ok(!d.nearest.some((c) => c.name.startsWith('ATLANTA TECHNICAL')));
  assert.equal(d.unrankedCount, 1);
  // Total enrollment within 10 mi sums only the reported-enrollment schools.
  assert.equal(d.totalEnrollment, 39771 + 37000 + 2400 + 48);
});

test('NEGATIVE: nothing within 10 mi is ready with a real zero count, not unavailable', async () => {
  const { handlers } = handlersFor({ hospitals: { features: [] } });
  const body = (await call(handlers.hospitals, ATLANTA)).json();
  assert.equal(body.status, 'ready');
  assert.equal(body.data.count, 0);
  assert.deepEqual(body.data.nearest, []);
});

test('NEGATIVE: an ArcGIS error answers 502 with the fixed message and no upstream text', async () => {
  const { handlers } = handlersFor({ colleges: ARCGIS_400 });
  const res = await call(handlers.colleges, ATLANTA);
  assert.equal(res.status, 502);
  assert.deepEqual(res.json(), { error: CRE_ERRORS.UPSTREAM });
  assert.ok(!res.body.includes(SECRET));
});

test('NEGATIVE: a truncated answer is flagged partial so a short list is never presented as complete', async () => {
  const { handlers } = handlersFor({
    hospitals: { ...HOSPITALS_ATLANTA, exceededTransferLimit: true },
  });
  const d = (await call(handlers.hospitals, ATLANTA)).json().data;
  assert.equal(d.truncated, true);
});

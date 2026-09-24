// Tests for the utility providers section through the real /api/cre/utilities routes with mocked layers: electric utility name and type, water systems, gas and sewer stated as not available nationally rather than guessed, and the unavailable state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUtilitiesSection, UTILITIES_MESSAGES } from './utilities.js';
import { createUtilityHandlers } from '../../../server/providers/cre/utilities.js';
import {
  isPlaceholderValue,
  SECTION_STATUS,
  validateSectionResult,
} from '../contract.js';
import { RINGS_M } from '../config.js';
import { mountAt, routeFetch } from './routeFetch.testutil.mjs';
import { ARCGIS_400, TIMING } from '../server/wp3Fixtures.testutil.mjs';
import {
  ATLANTA_POINT,
  ELECTRIC_ATLANTA,
  WATER_ATLANTA,
  upstreamBy,
} from '../server/p6bFixtures.testutil.mjs';

const CTX = { ...ATLANTA_POINT, address: 'x', rings: RINGS_M };

function sectionFor({ electric = ELECTRIC_ATLANTA, water = WATER_ATLANTA } = {}) {
  const upstream = upstreamBy([
    ['Electric_Retail_Service_Territories_HIFLD', electric],
    ['Water_System_Boundaries', water],
  ]);
  const handlers = createUtilityHandlers({
    fetchImpl: upstream.fetchImpl,
    timing: TIMING,
    cacheOptions: { disk: false },
    limiter: null,
  });
  return createUtilitiesSection({
    fetchImpl: routeFetch(mountAt('utilities', handlers)),
  });
}

const find = (result, label) => result.values.find((v) => v.label === label);

test('ready: electric utility and type, water systems, gas and sewer honestly not available nationally', async () => {
  const result = await sectionFor().load(CTX, {});
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.READY);
  assert.equal(result.id, 'utilities');

  const electric = find(result, 'Electric utility');
  assert.equal(electric.value, 'GEORGIA POWER CO');
  assert.match(electric.note, /SOUTHERN COMPANY/);
  assert.match(electric.note, /2,712,780 customers/);
  assert.match(electric.note, /EIA-861 data year 2022/);
  // PROVENANCE: no verified official (DOE/EIA/ORNL/HIFLD-geoplatform)
  // publisher of this exact layer was found live (searched 2026-09-24); it
  // is a public republished copy from an unidentified ArcGIS account
  // (NBAM_Org), so the row says so plainly rather than implying an
  // official source.
  assert.match(
    electric.note,
    /public republished copy; publisher not verified/,
  );
  assert.equal(
    find(result, 'Electric utility type').value,
    'Investor-owned utility (IOU)',
  );

  const water1 = find(result, 'Water system 1');
  assert.equal(water1.value, 'ATLANTA');
  assert.match(water1.note, /PWSID GA1210001/);
  assert.match(water1.note, /1,089,893 people/);
  assert.equal(find(result, 'Water system 2').value, 'DEKALB COUNTY');

  assert.equal(find(result, 'Natural gas utility').value, 'Not available nationally');
  assert.equal(find(result, 'Sewer provider').value, 'Not available nationally');

  for (const row of result.values) {
    assert.ok(!isPlaceholderValue(row.value), row.label);
    assert.ok(row.note && row.note.length > 10, row.label);
    assert.ok(!/[–—]/.test(`${row.label} ${row.note}`), row.label);
  }
});

test('NEGATIVE: no territory at the point says so in words, never invents a utility', async () => {
  const result = await sectionFor({ electric: { features: [] } }).load(CTX, {});
  validateSectionResult(result);
  assert.equal(
    find(result, 'Electric utility').value,
    'No territory found at this point',
  );
  assert.equal(find(result, 'Electric utility type'), undefined);
});

test('NEGATIVE: both layers down is unavailable; the gas and sewer rows alone never make it ready', async () => {
  const result = await sectionFor({ electric: ARCGIS_400, water: ARCGIS_400 }).load(
    CTX,
    {},
  );
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.UNAVAILABLE);
  assert.equal(result.message, UTILITIES_MESSAGES.unavailable);
  assert.equal(result.values.length, 0);
});

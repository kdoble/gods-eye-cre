// Tests for the insurance cost signal section end to end through the real /api/cre/insurance route with a mocked FEMA NRI: the exact label, annual dollar rows with source, tract and vintage, Not Applicable perils shown as words, and the empty and unavailable states.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInsuranceSection,
  INSURANCE_LABEL,
  INSURANCE_MESSAGES,
} from './insurance.js';
import { createInsuranceHandlers } from '../../../server/providers/cre/insurance.js';
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
  nriBody,
  upstreamBy,
} from '../server/p6bFixtures.testutil.mjs';

const CTX = { ...ATLANTA_POINT, address: 'x', rings: RINGS_M };

function sectionFor(answer) {
  const upstream = upstreamBy([['National_Risk_Index_Census_Tracts', answer]]);
  const handlers = createInsuranceHandlers({
    fetchImpl: upstream.fetchImpl,
    timing: TIMING,
    cacheOptions: { disk: false },
    limiter: null,
  });
  return createInsuranceSection({
    fetchImpl: routeFetch(mountAt('insurance', handlers)),
  });
}

const find = (result, label) => result.values.find((v) => v.label === label);

test('the label is exactly the wording the brief asks for', () => {
  assert.equal(
    INSURANCE_LABEL,
    'FEMA expected annual loss to buildings in this tract, a relative risk signal, not an insurance premium',
  );
});

test('ready: composite rating and total, per-peril annual dollars, every row sourced with tract and vintage', async () => {
  const result = await sectionFor(nriBody()).load(CTX, {});
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.READY);
  assert.equal(result.id, 'insurance');
  assert.equal(result.message, INSURANCE_LABEL);

  const rating = find(result, 'Tract expected annual loss rating, all hazards');
  assert.equal(rating.value, 'Very Low');
  assert.match(rating.note, /national percentile 6\.5/);

  const total = find(result, 'Expected annual building loss, all hazards');
  assert.equal(total.value, 365145);
  assert.equal(total.unit, '$/yr');
  assert.match(total.note, new RegExp(INSURANCE_LABEL));
  assert.match(total.note, /\$605,749,822 tract building value/);

  const hurricane = find(result, 'Hurricane, expected annual building loss');
  assert.equal(hurricane.value, 2841);
  assert.equal(hurricane.unit, '$/yr');
  assert.match(hurricane.note, /national percentile 42\.7/);
  assert.match(hurricane.note, /rating Very Low/);

  const riverine = find(
    result,
    'Riverine (inland) flooding, expected annual building loss',
  );
  assert.equal(riverine.value, 282814);

  for (const row of result.values) {
    assert.ok(!isPlaceholderValue(row.value), row.label);
    assert.match(row.note, /FEMA National Risk Index/, row.label);
    assert.match(row.note, /tract 13121001302/, row.label);
    assert.match(row.note, /December 2025/, row.label);
    assert.ok(!/[–—]/.test(`${row.label} ${row.note}`), row.label);
  }
});

test('NEGATIVE: a Not Applicable peril reads as words, never a $0 row', async () => {
  const result = await sectionFor(nriBody()).load(CTX, {});
  const coastal = find(result, 'Coastal flooding, expected annual building loss');
  assert.equal(coastal.value, 'Not applicable here');
  assert.equal(coastal.unit, undefined);
  for (const row of result.values) {
    assert.ok(!(row.value === 0 && String(row.unit).includes('$')), row.label);
  }
});

test('NEGATIVE: no NRI tract at the point is empty with a fixed message', async () => {
  const result = await sectionFor(nriBody(null)).load(CTX, {});
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.EMPTY);
  assert.equal(result.message, INSURANCE_MESSAGES.empty);
  assert.equal(result.values.length, 0);
});

test('NEGATIVE: FEMA down is unavailable, never zeros', async () => {
  const result = await sectionFor(ARCGIS_400).load(CTX, {});
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.UNAVAILABLE);
  assert.equal(result.message, INSURANCE_MESSAGES.unavailable);
  assert.equal(result.values.length, 0);
});

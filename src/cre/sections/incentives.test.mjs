// Tests for the incentives section run end to end through the real HUD routes with a mocked upstream: QCT, DDA, OZ flags, ring counts, a failed layer never shown as "No", and the all-down fixed message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIncentivesSection, INCENTIVES_MESSAGES } from './incentives.js';
import { createIncentiveHandlers } from '../../../server/providers/cre/incentives.js';
import {
  isPlaceholderValue,
  SECTION_STATUS,
  validateSectionResult,
} from '../contract.js';
import { RINGS_M } from '../config.js';
import { mountAt, routeFetch } from './routeFetch.testutil.mjs';
import {
  ARCGIS_400,
  SECRET,
  TIMING,
  incentiveUpstream,
} from '../server/wp3Fixtures.testutil.mjs';

const CTX = { lat: 36.320692, lon: -82.342509, address: 'x', rings: RINGS_M };

function sectionFor(overrides) {
  const upstream = incentiveUpstream(overrides);
  const handlers = createIncentiveHandlers({
    fetchImpl: upstream.fetchImpl,
    timing: TIMING,
    cacheOptions: { disk: false },
    limiter: null,
  });
  return createIncentivesSection({
    fetchImpl: routeFetch(mountAt('incentives', handlers)),
  });
}

const find = (result, label) => result.values.find((v) => v.label === label);

test('ready: QCT, DDA and OZ flags, LIHTC and public housing rings, overlays', async () => {
  const result = await sectionFor().load(CTX, {});
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.READY);
  // DATA-08: layer-name year 2026, data edited Sep 2025 (fixture recorded
  // live 2026-09-24); the stale "Fiscal Year 2024" description is ignored.
  const qctRow = find(result, 'Qualified Census Tract (2026)');
  assert.equal(qctRow.value, 'Yes');
  assert.match(qctRow.note, /HUD 2026 designation, data updated Sep 2025/);
  assert.equal(find(result, 'Difficult Development Area (2026)').value, 'No');
  const oz = find(result, 'Opportunity Zone');
  assert.equal(oz.value, 'Yes');
  assert.match(oz.note, /2010 census tracts/);
  assert.equal(
    find(result, 'Tax credit (LIHTC) properties within 1 mi').value,
    3,
  );
  assert.equal(
    find(result, 'Tax credit (LIHTC) properties within 1 mi').note,
    '1 with units not reported',
  );
  assert.equal(find(result, 'Tax credit (LIHTC) units within 1 mi').value, 140);
  assert.equal(
    find(result, 'Tax credit (LIHTC) properties within 3 mi').value,
    4,
  );
  assert.equal(
    find(result, 'Nearest tax credit (LIHTC) property 1').value,
    'WATAUGA SQUARE',
  );
  assert.equal(
    find(result, 'Public housing developments within 1 mi').value,
    1,
  );
  assert.equal(find(result, 'Public housing units within 1 mi').value, 74);
  assert.deepEqual(
    result.overlays.map((o) => o.id),
    ['incentives-zones', 'incentives-lihtc', 'incentives-public-housing'],
  );
  for (const v of result.values)
    assert.ok(!isPlaceholderValue(v.value), v.label);
});

test('NEGATIVE: a failed DDA layer is named in the message and never shown as "No"', async () => {
  const result = await sectionFor({ dda: ARCGIS_400 }).load(CTX, {});
  validateSectionResult(result);
  assert.equal(find(result, 'Difficult Development Area (2026)'), undefined);
  assert.equal(
    result.message,
    'Did not answer, try again later: HUD Difficult Development Areas.',
  );
});

test('NEGATIVE: every HUD layer ArcGIS 400 is unavailable with the fixed message', async () => {
  const result = await sectionFor({
    qct: ARCGIS_400,
    dda: ARCGIS_400,
    oz: ARCGIS_400,
    lihtc: ARCGIS_400,
    ph: ARCGIS_400,
  }).load(CTX, {});
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.UNAVAILABLE);
  assert.equal(result.message, INCENTIVES_MESSAGES.unavailable);
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('zero LIHTC nearby is a real zero, with no units line', async () => {
  const result = await sectionFor({ lihtc: { features: [] } }).load(CTX, {});
  assert.equal(
    find(result, 'Tax credit (LIHTC) properties within 3 mi').value,
    0,
  );
  assert.equal(find(result, 'Tax credit (LIHTC) units within 3 mi'), undefined);
});

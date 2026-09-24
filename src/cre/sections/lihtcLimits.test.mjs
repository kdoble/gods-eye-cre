// Tests for the LIHTC rent and income limits section through the real /api/cre/lihtc-limits route: "Needs HUD key" with the signup link when no token is set, and, from a hand-built fixture of HUD's documented shape (NOT a live response), annual and monthly limits and max gross rents with source, area and year on every row.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLihtcLimitsSection,
  LIHTC_LIMITS_MESSAGES,
} from './lihtcLimits.js';
import {
  createLihtcLimitsHandlers,
  HUD_SIGNUP_URL,
} from '../../../server/providers/cre/lihtcLimits.js';
import {
  isPlaceholderValue,
  SECTION_STATUS,
  validateSectionResult,
} from '../contract.js';
import { RINGS_M } from '../config.js';
import { mountAt, routeFetch } from './routeFetch.testutil.mjs';
import { TIMING, json } from '../server/wp3Fixtures.testutil.mjs';
import {
  ATLANTA_POINT,
  MTSP_DOC_SHAPE,
  TIGER_COUNTY_FULTON,
  upstreamBy,
} from '../server/p6bFixtures.testutil.mjs';

const CTX = { ...ATLANTA_POINT, address: 'x', rings: RINGS_M };
const FAKE_TOKEN = ['fixture', 'hud', 'token', 'not', 'real'].join('-');

function sectionFor(env, hudAnswer = MTSP_DOC_SHAPE) {
  const upstream = upstreamBy([
    ['State_County/MapServer/1', TIGER_COUNTY_FULTON],
    ['/hudapi/public/mtspil/data/', hudAnswer],
  ]);
  const handlers = createLihtcLimitsHandlers({
    fetchImpl: upstream.fetchImpl,
    env,
    timing: TIMING,
    cacheOptions: { disk: false },
    limiter: null,
  });
  return {
    upstream,
    section: createLihtcLimitsSection({
      fetchImpl: routeFetch(mountAt('lihtc-limits', handlers)),
    }),
  };
}

const find = (result, label) => result.values.find((v) => v.label === label);

test('NEGATIVE: no HUD_API_TOKEN shows needs-key, "Needs HUD key" and the signup link, and calls nothing upstream', async () => {
  const { section, upstream } = sectionFor({});
  const result = await section.load(CTX, {});
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.NEEDS_KEY);
  assert.match(result.message, /HUD_API_TOKEN/);
  assert.equal(result.values.length, 1);
  const row = result.values[0];
  assert.equal(row.value, 'Needs HUD key');
  assert.match(row.note, /https:\/\/www\.huduser\.gov\/portal\/dataset\/fmr-api\.html/);
  assert.deepEqual(row.sourceUrls, [HUD_SIGNUP_URL]);
  assert.equal(upstream.calls.length, 0);
});

test('with a token: 50 and 60 percent income limits for 1 to 4 persons and max gross rents 0BR to 3BR, annual with monthly shown', async () => {
  const { section } = sectionFor({ HUD_API_TOKEN: FAKE_TOKEN });
  const result = await section.load(CTX, {});
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.READY);
  assert.equal(result.values.length, 16);

  const il = find(result, 'LIHTC income limit, 60% AMI, 2 persons');
  assert.equal(il.value, 57300);
  assert.equal(il.unit, '$/yr');
  assert.match(il.note, /\$4,775\.00 per month/);

  const il50 = find(result, 'LIHTC income limit, 50% AMI, 1 person');
  assert.equal(il50.value, 41800);

  const rent = find(result, 'Max gross LIHTC rent, 60% AMI, 2BR');
  assert.equal(rent.value, 19332);
  assert.equal(rent.unit, '$/yr');
  assert.match(rent.note, /\$1,611 per month/);
  assert.match(rent.note, /3 persons/);

  const studio = find(result, 'Max gross LIHTC rent, 50% AMI, 0BR (studio)');
  assert.equal(studio.value, 1045 * 12);

  for (const row of result.values) {
    assert.ok(!isPlaceholderValue(row.value), row.label);
    assert.ok(row.value > 0, row.label);
    assert.match(row.note, /HUD Multifamily Tax Subsidy Project/, row.label);
    assert.match(row.note, /FY2025/, row.label);
    assert.match(row.note, /Atlanta-Sandy Springs-Roswell/, row.label);
    assert.ok(!/[–—]/.test(`${row.label} ${row.note}`), row.label);
  }
});

test('NEGATIVE: HUD failing with a token set is unavailable, never zeros', async () => {
  const { section } = sectionFor({ HUD_API_TOKEN: FAKE_TOKEN }, () =>
    json({ error: 'Unauthenticated' }, 401),
  );
  const result = await section.load(CTX, {});
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.UNAVAILABLE);
  assert.equal(result.message, LIHTC_LIMITS_MESSAGES.unavailable);
  assert.equal(result.values.length, 0);
});

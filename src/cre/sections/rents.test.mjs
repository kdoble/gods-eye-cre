// Tests for the rents section: ZORI rows for 30308, FMR rows with a token, the honest needs-key and empty states, and unavailable on a dead route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSectionResult } from '../contract.js';
import {
  fmrRows,
  loadRentsSection,
  rentsSection,
  RENTS_MESSAGES,
  zoriRows,
} from './rents.js';

const CTX = {
  lat: 33.7726,
  lon: -84.366,
  address: '675 Ponce de Leon Ave NE',
  zip: '30308',
};
const ZORI = {
  zip: '30308',
  city: 'Atlanta',
  state: 'GA',
  metro: 'Atlanta-Sandy Springs-Alpharetta, GA',
  county: 'Fulton County',
  latest: { date: '2026-08-31', value: 2078.65 },
  value12MonthsAgo: 2016.64,
  value36MonthsAgo: 2050.29,
  change12mPct: 3.07,
  change36mPct: 1.38,
};
const body = (data) => ({
  status: 'ready',
  data,
  retrievedAt: '2026-09-22T15:00:00.000Z',
  source: { name: 'Zillow', url: 'x', license: 'y' },
});
const reply =
  (data, status = 200) =>
  async (url) => {
    assert.equal(
      String(url),
      '/api/cre/rents?lat=33.7726&lon=-84.366&zip=30308',
    );
    return new Response(JSON.stringify(data), { status });
  };

test('module shape matches the section contract', () => {
  assert.equal(rentsSection.id, 'rents');
  assert.equal(rentsSection.order, 9);
});

test('DATA-10: ZORI is rounded to whole dollars, not false 2-decimal precision', () => {
  const rows = zoriRows(ZORI);
  assert.deepEqual(
    rows.map((r) => [r.label, r.value, r.unit]),
    [
      ['Zillow rent index (ZORI), ZIP 30308, Aug 2026', 2079, '$/mo'],
      ['Zillow rent, 12-month change', 3.07, '%'],
      ['Zillow rent, 36-month change', 1.38, '%'],
    ],
  );
  // DATA-11: annualize from the unrounded index (2078.65 * 12 = 24943.80),
  // then round for display ($24,944). Round-then-multiply gives the wrong
  // $24,948.
  assert.match(rows[0].note, /\$24,944 per unit per year/);
  assert.equal(zoriRows({ ...ZORI, change36mPct: null }).length, 2);
});

test('without a HUD token: ready on ZORI with the needs-key reason in the message', async () => {
  const result = validateSectionResult(
    await loadRentsSection(CTX, {
      fetchImpl: reply(
        body({
          zip: '30308',
          zipSource: 'query',
          zoriStatus: 'ready',
          zori: ZORI,
          zoriRetrievedAt: '2026-09-20T00:00:00.000Z',
          fmr: { status: 'needs-key', key: 'HUD_API_TOKEN' },
        }),
      ),
    }),
  );
  assert.equal(result.status, 'ready');
  assert.equal(result.values.length, 3);
  assert.equal(result.message, RENTS_MESSAGES.FMR_NEEDS_KEY);
  assert.equal(result.retrievedAt, '2026-09-20T00:00:00.000Z');
});

test('feature 2: a ZORI reply carrying chart history attaches result.rentsChart', async () => {
  const history = [
    { date: '2025-08-31', value: 2016.64 },
    { date: '2026-08-31', value: 2078.65 },
  ];
  const result = validateSectionResult(
    await loadRentsSection(CTX, {
      fetchImpl: reply(
        body({
          zip: '30308',
          zipSource: 'query',
          zoriStatus: 'ready',
          zori: { ...ZORI, history },
          zoriRetrievedAt: '2026-09-20T00:00:00.000Z',
          fmr: { status: 'needs-key', key: 'HUD_API_TOKEN' },
        }),
      ),
    }),
  );
  assert.deepEqual(result.rentsChart.history, history);
  assert.equal(result.rentsChart.zip, '30308');
  assert.equal(result.rentsChart.change12mPct, 3.07);
});

test('NEGATIVE: a ZORI reply with no history array never invents result.rentsChart', async () => {
  const result = validateSectionResult(
    await loadRentsSection(CTX, {
      fetchImpl: reply(
        body({
          zip: '30308',
          zipSource: 'query',
          zoriStatus: 'ready',
          zori: ZORI,
          zoriRetrievedAt: '2026-09-20T00:00:00.000Z',
          fmr: { status: 'needs-key', key: 'HUD_API_TOKEN' },
        }),
      ),
    }),
  );
  assert.equal(result.rentsChart, undefined);
});

test('with a HUD token: FMR 1BR, 2BR and 3BR rows are added', async () => {
  const fmr = {
    status: 'ready',
    areaName: 'Atlanta HUD Metro FMR Area',
    year: 2026,
    smallArea: true,
    zip: '30308',
    rents: { oneBr: 2000, twoBr: 2300, threeBr: 2900 },
  };
  const result = validateSectionResult(
    await loadRentsSection(CTX, {
      fetchImpl: reply(
        body({ zip: '30308', zoriStatus: 'ready', zori: ZORI, fmr }),
      ),
    }),
  );
  const rows = result.values.filter((v) =>
    v.label.startsWith('HUD Fair Market Rent'),
  );
  assert.deepEqual(
    rows.map((r) => [r.label, r.value]),
    [
      ['HUD Fair Market Rent (FMR), 1BR', 2000],
      ['HUD Fair Market Rent (FMR), 2BR', 2300],
      ['HUD Fair Market Rent (FMR), 3BR', 2900],
    ],
  );
  assert.match(rows[0].note, /Small Area FMR, ZIP 30308, FY2026/);
  assert.match(
    rows[0].note,
    /HUD Fair Market Rent: 40th percentile gross rent including utilities, used for voucher payment standards; not a market rent/,
  );
  assert.equal(result.message, undefined);
});

test('DATA-06: an FMR row states plainly whether the parser has been checked against a live HUD response', () => {
  const fmr = {
    status: 'ready',
    areaName: 'Atlanta HUD Metro FMR Area',
    year: 2026,
    smallArea: true,
    zip: '30308',
    rents: { oneBr: 2000 },
    liveVerified: false,
  };
  const rows = fmrRows(fmr);
  assert.match(
    rows[0].note,
    /not been verified against a live HUD API response/,
  );
  const verifiedRows = fmrRows({ ...fmr, liveVerified: true });
  assert.doesNotMatch(
    verifiedRows[0].note,
    /not been verified against a live HUD API response/,
  );
});

test('NEGATIVE: ZIP not in ZORI and no token is needs-key, never a fake value', async () => {
  const result = validateSectionResult(
    await loadRentsSection(CTX, {
      fetchImpl: reply(
        body({
          zip: '30308',
          zoriStatus: 'empty',
          zori: null,
          fmr: { status: 'needs-key', key: 'HUD_API_TOKEN' },
        }),
      ),
    }),
  );
  assert.equal(result.status, 'needs-key');
  assert.deepEqual(result.values, []);
  assert.match(result.message, /no ZORI series for ZIP 30308/);
  assert.match(result.message, /HUD_API_TOKEN/);
});

test('ZIP not in ZORI with a token but no FMR rows is empty', async () => {
  const result = validateSectionResult(
    await loadRentsSection(CTX, {
      fetchImpl: reply(
        body({
          zip: '30308',
          zoriStatus: 'empty',
          zori: null,
          fmr: { status: 'empty' },
        }),
      ),
    }),
  );
  assert.equal(result.status, 'empty');
});

test('NEGATIVE: a dead route is unavailable with the fixed message', async () => {
  const result = validateSectionResult(
    await loadRentsSection(CTX, {
      fetchImpl: reply({ error: 'Data source unavailable' }, 502),
    }),
  );
  assert.equal(result.status, 'unavailable');
  assert.equal(result.message, RENTS_MESSAGES.UNAVAILABLE);
});

test('HUD-only and mixed evidence retain the oldest aggregate observation time', async () => {
  for (const zori of [null, ZORI]) {
    const result = await loadRentsSection(CTX, { fetchImpl: reply({
      retrievedAt: '2026-09-01T00:00:00Z',
      data: { zip: '30308', zoriStatus: zori ? 'ready' : 'unavailable', zori, zoriRetrievedAt: '2026-09-20T00:00:00Z', fmr: { status: 'ready', areaName: 'Fixture', year: 2026, rents: { oneBr: 1000, twoBr: 1200, threeBr: 1400 } } },
    }) });
    assert.ok(result.values.some((row) => row.label.includes('HUD Fair Market Rent')));
    assert.equal(result.retrievedAt, '2026-09-01T00:00:00Z');
  }
});

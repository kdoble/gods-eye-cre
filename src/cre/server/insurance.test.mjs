// Tests for /api/cre/insurance/eal: FEMA NRI expected annual loss to buildings for the perils that drive multifamily insurance, the verified field names, the empty and upstream-failure negatives, and the pinned-host guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInsuranceHandlers,
  INSURANCE_PERILS,
  NRI_EAL_FIELDS,
  NRI_LAYER,
} from '../../../server/providers/cre/insurance.js';
import { CRE_ERRORS } from '../../../server/providers/cre/common/route.js';
import { ARCGIS_400, SECRET, TIMING, call } from './wp3Fixtures.testutil.mjs';
import { ATLANTA, nriBody, upstreamBy } from './p6bFixtures.testutil.mjs';

const handlersFor = (answer) => {
  const upstream = upstreamBy([['National_Risk_Index_Census_Tracts', answer]]);
  const handlers = createInsuranceHandlers({
    fetchImpl: upstream.fetchImpl,
    timing: TIMING,
    cacheOptions: { disk: false },
    limiter: null,
  });
  return { handlers, upstream };
};

test('insurance perils are the seven multifamily drivers, with riverine as NRI inland flooding (IFLD)', () => {
  assert.deepEqual(
    INSURANCE_PERILS.map((p) => p.key),
    ['HRCN', 'SWND', 'HAIL', 'TRND', 'WFIR', 'IFLD', 'CFLD'],
  );
  assert.match(
    INSURANCE_PERILS.find((p) => p.key === 'IFLD').name,
    /riverine/i,
  );
});

test('eal: asks FEMA for the exact field names confirmed against the live service metadata', async () => {
  const { handlers, upstream } = handlersFor(nriBody());
  await call(handlers.eal, ATLANTA);
  const url = new URL(upstream.calls[0].url);
  assert.equal(url.hostname, 'services.arcgis.com');
  assert.ok(url.pathname.startsWith(new URL(NRI_LAYER).pathname));
  const fields = url.searchParams.get('outFields').split(',');
  for (const f of [
    'TRACTFIPS',
    'NRI_VER',
    'BUILDVALUE',
    'RISK_RATNG',
    'EAL_VALB',
    'EAL_SCORE',
    'EAL_RATNG',
    'ALR_NPCTL',
    'HRCN_EALB',
    'HRCN_EALS',
    'HRCN_EALR',
    'HRCN_ALR_NPCTL',
    'IFLD_EALB',
    'CFLD_EALB',
  ]) {
    assert.ok(fields.includes(f), f);
  }
  assert.deepEqual([...fields].sort(), [...NRI_EAL_FIELDS].sort());
});

test('eal: tract composite plus per-peril building loss, national percentile and rating', async () => {
  const { handlers } = handlersFor(nriBody());
  const res = await call(handlers.eal, ATLANTA);
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.status, 'ready');
  const d = body.data;
  assert.equal(d.tract, '13121001302');
  assert.equal(d.version, 'December 2025');
  assert.equal(d.buildValue, 605749822);
  assert.equal(d.composite.ealBuilding, 365145.26769650221);
  assert.equal(d.composite.ealRating, 'Very Low');
  assert.equal(d.composite.ealPercentile, 6.5199520868074314);
  assert.equal(d.composite.lossRatePercentile, 9.595556286257839);
  assert.equal(d.composite.riskRating, 'Very Low');
  const hrcn = d.perils.find((p) => p.key === 'HRCN');
  assert.equal(hrcn.ealBuilding, 2841.3276673462783);
  assert.equal(hrcn.percentile, 42.721391863251654);
  assert.equal(hrcn.lossRatePercentile, 42.829438572675265);
  assert.equal(hrcn.rating, 'Very Low');
  assert.equal(d.perils.length, 7);
});

test('NEGATIVE: a peril FEMA rates Not Applicable keeps a null loss, never a zero', async () => {
  const { handlers } = handlersFor(nriBody());
  const d = (await call(handlers.eal, ATLANTA)).json().data;
  const cfld = d.perils.find((p) => p.key === 'CFLD');
  assert.equal(cfld.ealBuilding, null);
  assert.equal(cfld.percentile, null);
  assert.equal(cfld.rating, 'Not Applicable');
});

test('NEGATIVE: a point with no NRI tract is empty, not a zero loss', async () => {
  const { handlers } = handlersFor(nriBody(null));
  const body = (await call(handlers.eal, ATLANTA)).json();
  assert.equal(body.status, 'empty');
});

test('NEGATIVE: an ArcGIS error answers 502 with the fixed message and no upstream text', async () => {
  const { handlers } = handlersFor(ARCGIS_400);
  const res = await call(handlers.eal, ATLANTA);
  assert.equal(res.status, 502);
  assert.deepEqual(res.json(), { error: CRE_ERRORS.UPSTREAM });
  assert.ok(!res.body.includes(SECRET));
});

test('NEGATIVE: a bad point is 400 and makes no upstream call', async () => {
  const { handlers, upstream } = handlersFor(nriBody());
  const res = await call(handlers.eal, 'lat=999&lon=0');
  assert.equal(res.status, 400);
  assert.equal(upstream.calls.length, 0);
});

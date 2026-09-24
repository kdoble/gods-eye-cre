// Tests for /api/cre/utilities/{electric,water}: the electric retail territory at the point with utility name and plain-word type (IOU, co-op, municipal), EPA community water systems at the point, the empty and upstream-failure negatives, and the pinned hosts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUtilityHandlers,
  ELECTRIC_LAYER,
  electricTypeLabel,
  UTILITY_HOSTS,
  WATER_LAYER,
} from '../../../server/providers/cre/utilities.js';
import { CRE_ERRORS } from '../../../server/providers/cre/common/route.js';
import { ARCGIS_400, SECRET, TIMING, call } from './wp3Fixtures.testutil.mjs';
import {
  ATLANTA,
  ELECTRIC_ATLANTA,
  WATER_ATLANTA,
  upstreamBy,
} from './p6bFixtures.testutil.mjs';

const handlersFor = ({ electric = ELECTRIC_ATLANTA, water = WATER_ATLANTA } = {}) => {
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
  return { handlers, upstream };
};

test('layers and hosts are the ones verified live on 2026-09-24', () => {
  assert.equal(
    ELECTRIC_LAYER,
    'https://services3.arcgis.com/OYP7N6mAJJCyH6hd/arcgis/rest/services/Electric_Retail_Service_Territories_HIFLD/FeatureServer/0',
  );
  assert.equal(
    WATER_LAYER,
    'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/Water_System_Boundaries/FeatureServer/0',
  );
  assert.deepEqual(
    [...UTILITY_HOSTS].sort(),
    ['services.arcgis.com', 'services3.arcgis.com'],
  );
});

test('every HIFLD TYPE value maps to plain words; unknown types never pass as a real type', () => {
  assert.equal(electricTypeLabel('INVESTOR OWNED'), 'Investor-owned utility (IOU)');
  assert.equal(electricTypeLabel('COOPERATIVE'), 'Cooperative (co-op)');
  assert.equal(electricTypeLabel('MUNICIPAL'), 'Municipal utility');
  assert.equal(
    electricTypeLabel('POLITICAL SUBDIVISION'),
    'Public power district (political subdivision)',
  );
  for (const t of [
    'STATE',
    'FEDERAL',
    'MUNICIPAL MKTG AUTHORITY',
    'WHOLESALE POWER MARKETER',
    'COMMUNITY CHOICE AGGREGATOR',
  ]) {
    assert.ok(electricTypeLabel(t), t);
  }
  assert.equal(electricTypeLabel('NOT AVAILABLE'), null);
  assert.equal(electricTypeLabel(''), null);
  assert.equal(electricTypeLabel('SOMETHING NEW'), null);
});

test('electric: utility name, type, holding company, customers, EIA data year at the point', async () => {
  const { handlers } = handlersFor();
  const body = (await call(handlers.electric, ATLANTA)).json();
  assert.equal(body.status, 'ready');
  assert.deepEqual(body.data.territories, [
    {
      eiaId: '7140',
      name: 'GEORGIA POWER CO',
      type: 'INVESTOR OWNED',
      typeLabel: 'Investor-owned utility (IOU)',
      state: 'GA',
      holdingCompany: 'SOUTHERN COMPANY',
      customers: 2712780,
      dataYear: '2022',
      sourceDate: '2023-08-01',
    },
  ]);
});

test('water: every community water system whose boundary holds the point, largest first', async () => {
  const { handlers } = handlersFor();
  const body = (await call(handlers.water, ATLANTA)).json();
  assert.equal(body.status, 'ready');
  assert.deepEqual(
    body.data.systems.map((s) => [s.pwsid, s.name, s.population]),
    [
      ['GA1210001', 'ATLANTA', 1089893],
      ['GA0890001', 'DEKALB COUNTY', 743000],
    ],
  );
});

test('NEGATIVE: no territory at the point is empty, not a made-up utility', async () => {
  const { handlers } = handlersFor({ electric: { features: [] } });
  const body = (await call(handlers.electric, ATLANTA)).json();
  assert.equal(body.status, 'empty');
});

test('NEGATIVE: an ArcGIS error answers 502 with the fixed message and no upstream text', async () => {
  const { handlers } = handlersFor({ water: ARCGIS_400 });
  const res = await call(handlers.water, ATLANTA);
  assert.equal(res.status, 502);
  assert.deepEqual(res.json(), { error: CRE_ERRORS.UPSTREAM });
  assert.ok(!res.body.includes(SECRET));
});

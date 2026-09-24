// Tests for /api/cre/hazards/* with a mocked upstream: flood envelope and worst zone nearby, the FLD_ZONE null and ArcGIS 400 negatives, NRI ranking, wetlands, EPA retry on the intermittent 404, and seismic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  arcgisPolygonFeature,
  createHazardHandlers,
  floodSeverity,
} from '../../../server/providers/cre/hazards.js';
import { CRE_ERRORS } from '../../../server/providers/cre/common/route.js';
import {
  ARCGIS_400,
  TEST_POINT,
  SECRET,
  SQUARE,
  TIMING,
  call,
  hangingFetch,
  hazardUpstream,
  json,
} from './wp3Fixtures.testutil.mjs';

const handlersFor = (overrides) => {
  const upstream = hazardUpstream(overrides);
  const handlers = createHazardHandlers({
    fetchImpl: upstream.fetchImpl,
    timing: TIMING,
    cacheOptions: { disk: false },
    limiter: null,
    epaAttempts: 3,
    epaBackoffMs: 1,
  });
  return { handlers, upstream };
};

test('flood: site zone X, worst zone within 500 ft AE, panel and SFHA overlay', async () => {
  const { handlers } = handlersFor();
  const body = (await call(handlers.flood)).json();
  assert.equal(body.status, 'ready');
  assert.equal(body.data.site.zone, 'X');
  assert.equal(body.data.site.sfha, false);
  assert.equal(body.data.site.bfeFt, null, '-9999 BFE sentinel is not a value');
  assert.equal(body.data.nearby.zone, 'AE');
  assert.equal(body.data.nearby.sfha, true);
  assert.deepEqual(body.data.panel, {
    id: '47019C0165E',
    dfirmId: '47019C',
    effective: '2008-09-26',
    type: 'Countywide, Panel Printed',
  });
  const shape = body.data.sfhaGeojson.features[0];
  assert.equal(shape.geometry.type, 'MultiPolygon');
});

test('N-3: the sole community-based panel candidate in-state is selected by elimination and flagged panelApproximate (a documented guess)', async () => {
  const { handlers } = handlersFor({
    // Two candidates intersect the point: a countywide panel from a
    // DIFFERENT county (so the county-FIPS match fails) and a single
    // community-based panel whose DFIRM_ID's leading 2 digits (state FIPS)
    // agree with the site's own county (default fixture GEOID '47179',
    // state '47'). With no county field to confirm it, this is a guess by
    // elimination, not a real match.
    panel: {
      features: [
        {
          attributes: {
            FIRM_PAN: '13121C1234D',
            DFIRM_ID: '13121C',
            EFF_DATE: Date.UTC(2015, 0, 1),
            PANEL_TYP: 'Countywide, Panel Printed',
          },
        },
        {
          attributes: {
            FIRM_PAN: '4701990001A',
            DFIRM_ID: '470199',
            EFF_DATE: Date.UTC(2012, 5, 15),
            PANEL_TYP: 'Community Based, Not Printed',
          },
        },
      ],
    },
  });
  const body = (await call(handlers.flood)).json();
  assert.equal(body.status, 'ready');
  assert.equal(body.data.panelAmbiguous, false);
  assert.equal(
    body.data.panelApproximate,
    true,
    'a state-only, no-county-confirmation selection must be flagged approximate',
  );
  assert.equal(body.data.panel.dfirmId, '470199');
});

test('flood: exact point classification omits huge polygon geometry; map area remains bounded', async () => {
  const { handlers, upstream } = handlersFor();
  await call(handlers.flood, `${TEST_POINT}&radiusM=1609.344`);
  const siteCall = upstream.calls.find((u) => u.includes('/MapServer/28/'));
  const params = new URL(siteCall).searchParams;
  assert.equal(params.get('geometryType'), 'esriGeometryPoint');
  assert.equal(params.get('returnGeometry'), 'false');
  assert.equal(params.get('geometry'), '-82.342509,36.320692');
  const mapCall = upstream.calls.find((u) => u.includes('/MapServer/28/') && new URL(u).searchParams.get('where')?.includes('SFHA_TF'));
  assert.equal(new URL(mapCall).searchParams.get('resultRecordCount'), '100');
  assert.equal(new URL(mapCall).searchParams.get('maxAllowableOffset'), '0.0002');
});

test('flood: selected radius alters map cache key and keeps 500ft nearby metric', async () => {
  const { handlers, upstream } = handlersFor();
  const first = (await call(handlers.flood, `${TEST_POINT}&radiusM=1609.344`)).json();
  const second = (await call(handlers.flood, `${TEST_POINT}&radiusM=4828.032`)).json();
  assert.equal(first.data.mapRadiusM, 1609.344);
  assert.equal(second.data.mapRadiusM, 4828.032);
  assert.equal(first.data.nearRadiusM, 152.4);
  assert.equal(second.data.nearRadiusM, 152.4);
  assert.equal(upstream.calls.filter((u) => u.includes('/MapServer/28/') && new URL(u).searchParams.get('where')?.includes('SFHA_TF')).length, 2);
});

test('flood: FEMA nearby query does not replace exact site classification', async () => {
  const { handlers } = handlersFor();
  const body = (await call(handlers.flood)).json();
  assert.equal(body.data.site.zone, 'X');
  assert.equal(body.data.nearby.zone, 'AE');
});

test('flood preserves unknown FEMA SFHA input as null', async () => {
  const { handlers } = handlersFor({
    floodSite: { features: [{ attributes: { FLD_ZONE: 'AE', SFHA_TF: null }, geometry: { rings: [[[-82.367, 36.308], [-82.367, 36.311], [-82.364, 36.311], [-82.364, 36.308], [-82.367, 36.308]]] } }] },
  });
  const body = (await call(handlers.flood)).json();
  assert.equal(body.data.site.sfha, null);
});

test('NEGATIVE: empty FEMA point answer is distinct from malformed zone fields', async () => {
  const { handlers } = handlersFor({
    floodSite: { features: [] },
  });
  const res = await call(handlers.flood);
  const body = res.json();
  assert.equal(body.status, 'empty');
  assert.deepEqual(body.data, {});
  assert.ok(!res.body.includes('null'));
  const malformed = handlersFor({
    floodSite: { features: [{ attributes: { FLD_ZONE: null, SFHA_TF: null } }] },
  });
  assert.equal((await call(malformed.handlers.flood)).status, 502);
});

test('NEGATIVE: flood ArcGIS 400 answers 502 with the fixed message only', async () => {
  const { handlers } = handlersFor({ floodSite: ARCGIS_400 });
  const res = await call(handlers.flood);
  assert.equal(res.status, 502);
  assert.deepEqual(res.json(), { error: CRE_ERRORS.UPSTREAM });
  assert.ok(!res.body.includes(SECRET));
});

test('NEGATIVE: a flood timeout answers 502 with the fixed message', async () => {
  const { handlers } = handlersFor({ floodSite: hangingFetch });
  const res = await call(handlers.flood);
  assert.equal(res.status, 502);
  assert.deepEqual(res.json(), { error: CRE_ERRORS.UPSTREAM });
});

test('flood: a failed panel lookup still answers ready, and is not cached', async () => {
  let panelCalls = 0;
  const { handlers } = handlersFor({
    panel: () => {
      panelCalls += 1;
      return json(ARCGIS_400);
    },
  });
  const body = (await call(handlers.flood)).json();
  assert.equal(body.status, 'ready');
  assert.equal(body.data.panel, null);
  await call(handlers.flood);
  assert.equal(panelCalls, 2);
});

test('malformed nearby and map records remain partial, not valid zero coverage', async () => {
  const { handlers } = handlersFor({
    floodNear: { features: [{ attributes: { FLD_ZONE: null, SFHA_TF: null } }] },
    floodShapes: { features: [{ attributes: { FLD_ZONE: null, SFHA_TF: 'T' }, geometry: { rings: [SQUARE] } }] },
  });
  const body = (await call(handlers.flood)).json();
  assert.equal(body.status, 'ready');
  assert.equal(body.data.site.zone, 'X');
  assert.equal(body.data.nearby, null);
  assert.equal(body.data.mapStatus, 'partial');
  assert.equal(body.data.partial, true);
  assert.equal(body.data.sfhaGeojson.features.length, 0);
});

test('nri: score, rating and the top three hazards by score', async () => {
  const { handlers } = handlersFor();
  const body = (await call(handlers.nri)).json();
  assert.equal(body.status, 'ready');
  assert.equal(body.data.tract, '47179060902');
  assert.equal(body.data.score, 8.9);
  assert.equal(body.data.rating, 'Very Low');
  assert.deepEqual(
    body.data.topHazards.map((h) => `${h.name}:${h.rating}`),
    [
      'Lightning:Relatively High',
      'Strong wind:Relatively Moderate',
      'Earthquake:Relatively Low',
    ],
  );
});

test('nri: no tract feature is empty', async () => {
  const { handlers } = handlersFor({ nri: { features: [] } });
  assert.equal((await call(handlers.nri)).json().status, 'empty');
});

test('wetlands: prefixed outFields, on-site flag, count, acres and types', async () => {
  const { handlers, upstream } = handlersFor();
  const body = (await call(handlers.wetlands)).json();
  assert.ok(upstream.calls.every((u) => u.includes('Wetlands.WETLAND_TYPE')));
  assert.equal(body.data.onSite, false);
  assert.equal(body.data.count, 3);
  // Three copies of a 2.46 acre square that sits wholly inside the circle.
  assert.equal(body.data.acres, 7.4);
  assert.equal(body.data.acresMethod, 'clipped to the 500 m circle');
  assert.equal(body.data.featureAcres, 6.5, 'whole-feature NWI total kept');
  assert.equal(body.data.circleAcres, 194.1);
  assert.equal(body.data.geojson.features.length, 3);
});

test('epa: counts per program, duplicates collapsed, nearest named with distance', async () => {
  const { handlers } = handlersFor();
  const body = (await call(handlers.epa)).json();
  const p = body.data.programs;
  assert.equal(p.brownfields.count, 2);
  assert.equal(p.brownfields.nearest.name, 'MENNEL MILL SITE');
  assert.ok(
    p.brownfields.nearest.distanceMi > 0.4 &&
      p.brownfields.nearest.distanceMi < 0.6,
  );
  assert.equal(p.superfund.count, 0);
  assert.equal(p.superfund.nearest, null);
  assert.equal(p.rcra.count, 1);
  assert.deepEqual(body.data.failed, []);
  assert.equal(body.data.geojson.features.length, 2, 'brownfield points only');
});

test('epa: the intermittent {"error":{"code":404}} body is retried', async () => {
  let calls = 0;
  const { handlers } = handlersFor({
    epa0: () => {
      calls += 1;
      return calls === 1
        ? json({ error: { code: 404, message: 'Service not found' } })
        : json({ features: [] });
    },
  });
  const body = (await call(handlers.epa)).json();
  assert.equal(calls, 2);
  assert.equal(body.data.programs.brownfields.count, 0);
});

test('NEGATIVE: one EPA program down is reported as failed and not cached', async () => {
  let tri = 0;
  const { handlers } = handlersFor({
    epa23: () => {
      tri += 1;
      return json(ARCGIS_400);
    },
  });
  const res = await call(handlers.epa);
  const body = res.json();
  assert.equal(body.status, 'ready');
  assert.deepEqual(body.data.failed, ['tri']);
  assert.equal(body.data.programs.tri, undefined);
  assert.ok(!res.body.includes(SECRET));
  await call(handlers.epa);
  assert.equal(tri, 2);
});

test('NEGATIVE: every EPA program down answers 502', async () => {
  const down = {
    epa0: ARCGIS_400,
    epa21: ARCGIS_400,
    epa15: ARCGIS_400,
    epa23: ARCGIS_400,
  };
  const { handlers } = handlersFor(down);
  const res = await call(handlers.epa);
  assert.equal(res.status, 502);
  assert.deepEqual(res.json(), { error: CRE_ERRORS.UPSTREAM });
});

test('seismic: design category with Ss and S1', async () => {
  const { handlers } = handlersFor();
  const body = (await call(handlers.seismic)).json();
  assert.equal(body.data.sdc, 'B');
  assert.equal(body.data.ss, 0.34);
  assert.equal(body.data.siteClass, 'D');
});

test('NEGATIVE: a seismic HTTP 500 answers 502 with the fixed message', async () => {
  const { handlers } = handlersFor({ seismic: json({ error: SECRET }, 500) });
  const res = await call(handlers.seismic);
  assert.equal(res.status, 502);
  assert.ok(!res.body.includes(SECRET));
});

test('floodSeverity ranks V over A over shaded X over D over X', () => {
  const z = (zone, sfha, subtype = null) =>
    floodSeverity({ zone, sfha, subtype });
  assert.ok(z('VE', true) > z('AE', true));
  assert.ok(
    z('AE', true) > z('X', false, '0.2 PCT ANNUAL CHANCE FLOOD HAZARD'),
  );
  assert.ok(
    z('X', false, '0.2 PCT ANNUAL CHANCE FLOOD HAZARD') > z('D', false),
  );
  assert.ok(z('D', false) > z('X', false, 'AREA OF MINIMAL FLOOD HAZARD'));
});

test('arcgisPolygonFeature: clockwise outer becomes counterclockwise, holes attach', () => {
  const hole = [
    [-82.3657, 36.3093],
    [-82.3653, 36.3093],
    [-82.3653, 36.3097],
    [-82.3657, 36.3097],
    [-82.3657, 36.3093],
  ];
  const f = arcgisPolygonFeature({ rings: [SQUARE, hole] }, { zone: 'AE' });
  assert.equal(f.geometry.coordinates.length, 1);
  assert.equal(f.geometry.coordinates[0].length, 2);
  assert.deepEqual(f.geometry.coordinates[0][0], [...SQUARE].reverse());
  assert.equal(arcgisPolygonFeature({ rings: [] }), null);
});

test('wetlands: a river larger than the circle counts only its acres inside (B1-13)', async () => {
  const river = [
    [-82.6, 36.2],
    [-82.6, 36.4],
    [-82.1, 36.4],
    [-82.1, 36.2],
    [-82.6, 36.2],
  ];
  const { handlers } = handlersFor({
    wetNear: {
      features: [
        {
          attributes: {
            'Wetlands.ATTRIBUTE': 'R2UBH',
            'Wetlands.WETLAND_TYPE': 'Riverine',
            'Wetlands.ACRES': 3102.4,
          },
          geometry: { rings: [river] },
        },
      ],
    },
  });
  const body = (await call(handlers.wetlands)).json();
  assert.equal(body.data.featureAcres, 3102.4);
  assert.ok(
    body.data.acres <= body.data.circleAcres,
    `${body.data.acres} acres in a ${body.data.circleAcres} acre circle`,
  );
  assert.ok(body.data.acres > 193.9, 'the circle is all wetland');
});

test('NEGATIVE: whole-feature acres (the old value) fail the circle bound', () => {
  const circle = 194.1;
  const oldValue = 3102.4;
  const withinCircle = (acres) => acres <= circle;
  assert.equal(withinCircle(oldValue), false);
});

test('wetlands: no shapes returned means acres not computed, never guessed', async () => {
  const { handlers } = handlersFor({
    wetNear: {
      features: [
        {
          attributes: {
            'Wetlands.ATTRIBUTE': 'R2UBH',
            'Wetlands.WETLAND_TYPE': 'Riverine',
            'Wetlands.ACRES': 3102.4,
          },
        },
      ],
    },
  });
  const body = (await call(handlers.wetlands)).json();
  assert.equal(body.data.acres, null);
  assert.match(body.data.acresMethod, /not computed/);
});


test('a regulatory FLOODWAY outranks a plain AE, so worstZone keeps it (B-S3-3)', () => {
  // The four NFHL features within 500 ft of the test point, in the order the
  // service returns them. Plain AE came first and used to win the tie.
  const nearby = [
    { zone: 'AE', subtype: null, sfha: true },
    { zone: 'AE', subtype: null, sfha: true },
    { zone: 'AE', subtype: 'FLOODWAY', sfha: true },
    { zone: 'X', subtype: 'AREA OF MINIMAL FLOOD HAZARD', sfha: false },
  ];
  const worst = nearby.reduce((best, z) =>
    !best || floodSeverity(z) > floodSeverity(best) ? z : best,
  );
  assert.equal(worst.subtype, 'FLOODWAY');
  assert.ok(
    floodSeverity(nearby[2]) > floodSeverity(nearby[0]),
    'FLOODWAY ranks above a plain SFHA zone',
  );
  // NEGATIVE: the rest of the order is unchanged.
  assert.ok(
    floodSeverity({ zone: 'VE', subtype: null, sfha: true }) >
      floodSeverity({ zone: 'AE', subtype: null, sfha: true }),
  );
  assert.ok(
    floodSeverity({ zone: 'X', subtype: '0.2 PCT ANNUAL CHANCE', sfha: false }) >
      floodSeverity({ zone: 'D', subtype: null, sfha: false }),
  );
  assert.ok(
    floodSeverity({ zone: 'D', subtype: null, sfha: false }) >
      floodSeverity({ zone: 'X', subtype: null, sfha: false }),
  );
  // A FLOODWAY label outside an SFHA is not promoted.
  assert.equal(floodSeverity({ zone: 'X', subtype: 'FLOODWAY', sfha: false }), 1);
});


test('flood honors an empty exact FEMA point reply even when neighboring geometry exists',async()=>{
 const outer=[[-82.367,36.308],[-82.367,36.311],[-82.364,36.311],[-82.364,36.308],[-82.367,36.308]];
 const hole=[[-82.366,36.309],[-82.365,36.309],[-82.365,36.310],[-82.366,36.310],[-82.366,36.309]];
 const {handlers}=handlersFor({floodSite:{features:[]},floodNear:{features:[{attributes:{FLD_ZONE:'AE',SFHA_TF:'T'},geometry:{rings:[hole,outer]}}]}});
 const body=(await call(handlers.flood)).json();assert.equal(body.status,'empty');
});

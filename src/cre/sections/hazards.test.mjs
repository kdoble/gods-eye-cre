// Tests for the hazards section run end to end through the real hazard routes with a mocked upstream: values, overlays, the FLD_ZONE null negative and the all-down fixed message.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHazardsSection,
  HAZARDS_MESSAGES,
  isFloodUndetermined,
  FLOOD_SFHA_UNKNOWN,
} from './hazards.js';
import { createHazardHandlers } from '../../../server/providers/cre/hazards.js';
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
  hazardUpstream,
  json,
} from '../server/wp3Fixtures.testutil.mjs';

const CTX = { lat: 36.320692, lon: -82.342509, address: 'x', rings: RINGS_M };

function sectionFor(overrides) {
  const upstream = hazardUpstream(overrides);
  const handlers = createHazardHandlers({
    fetchImpl: upstream.fetchImpl,
    timing: TIMING,
    cacheOptions: { disk: false },
    limiter: null,
    epaAttempts: 2,
    epaBackoffMs: 1,
  });
  return createHazardsSection({
    fetchImpl: routeFetch(mountAt('hazards', handlers)),
  });
}

const find = (result, label) => result.values.find((v) => v.label === label);

test('ready: flood, NRI, wetlands, EPA and seismic values plus overlays', async () => {
  const result = await sectionFor().load(CTX, {});
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.READY);
  assert.equal(find(result, 'FEMA flood zone at site').value, 'X');
  assert.equal(find(result, 'In the 100-year floodplain').value, 'No');
  assert.equal(find(result, 'Worst flood zone within 500 ft').value, 'AE');
  assert.equal(
    find(result, 'FEMA flood map panel (FIRM)').note,
    'effective 2008-09-26; Countywide, Panel Printed',
  );
  assert.equal(find(result, 'Natural hazard risk score').value, 8.9);
  assert.equal(
    find(result, 'Top natural hazards').value,
    'Lightning (Relatively High), Strong wind (Relatively Moderate), Earthquake (Relatively Low)',
  );
  assert.equal(find(result, 'Wetland mapped at site').value, 'No');
  assert.equal(find(result, 'Wetland areas within 500 m').value, 3);
  const brown = find(result, 'Brownfields (ACRES) within 1 mi');
  assert.equal(brown.value, 2);
  assert.match(brown.note, /^nearest MENNEL MILL SITE, 0\.\d+ mi$/);
  assert.equal(find(result, 'Superfund (SEMS) within 1 mi').value, 0);
  assert.equal(find(result, 'Seismic design category').value, 'B');
  assert.equal(find(result, 'Base flood elevation'), undefined);
  assert.deepEqual(
    result.overlays.map((o) => o.id),
    ['hazards-sfha', 'hazards-wetlands', 'hazards-epa-sites'],
  );
  for (const v of result.values)
    assert.ok(!isPlaceholderValue(v.value), v.label);
});

test('NEGATIVE: malformed FEMA zone is a partial flood gap, never a site-zone value', async () => {
  const result = await sectionFor({
    floodSite: {
      features: [{ attributes: { FLD_ZONE: null, SFHA_TF: null } }],
    },
  }).load(CTX, {});
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.PARTIAL);
  assert.equal(find(result, 'FEMA flood zone at site'), undefined);
  assert.ok(result.values.every((v) => String(v.value) !== 'null'));
  assert.match(
    result.message,
    /Did not answer, try again later: FEMA flood map\./,
  );
});

test('missing SFHA flag is unknown, not an outside-floodplain claim', async () => {
  const result = await sectionFor({
    floodSite: { features: [{ attributes: { FLD_ZONE: 'AE', SFHA_TF: null }, geometry: { rings: [[[-82.367, 36.308], [-82.367, 36.311], [-82.364, 36.311], [-82.364, 36.308], [-82.367, 36.308]]] } }] },
  }).load(CTX, {});
  assert.equal(find(result, 'In the 100-year floodplain').value, FLOOD_SFHA_UNKNOWN);
  assert.match(find(result, 'In the 100-year floodplain').note, /status unknown/);
});

test('NEGATIVE: every hazard source ArcGIS 400 is unavailable with the fixed message', async () => {
  const down = {
    floodSite: ARCGIS_400,
    nri: ARCGIS_400,
    wetSite: ARCGIS_400,
    wetNear: ARCGIS_400,
    epa0: ARCGIS_400,
    epa21: ARCGIS_400,
    epa15: ARCGIS_400,
    epa23: ARCGIS_400,
    seismic: json({ error: SECRET }, 400),
  };
  const result = await sectionFor(down).load(CTX, {});
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.UNAVAILABLE);
  assert.equal(result.message, HAZARDS_MESSAGES.unavailable);
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('one EPA program down: the section names it, other counts still show', async () => {
  const result = await sectionFor({ epa23: ARCGIS_400 }).load(CTX, {});
  assert.equal(result.status, SECTION_STATUS.READY);
  assert.equal(result.message, 'Did not answer, try again later: EPA TRI.');
  assert.equal(
    find(result, 'Toxic release reporters (TRI) within 1 mi'),
    undefined,
  );
  assert.ok(find(result, 'Brownfields (ACRES) within 1 mi'));
});

test('flood route down: aggregate section is partial and NRI still shows', async () => {
  const result = await sectionFor({ floodSite: ARCGIS_400 }).load(CTX, {});
  assert.equal(result.status, SECTION_STATUS.PARTIAL);
  assert.equal(
    result.message,
    'Did not answer, try again later: FEMA flood map.',
  );
  assert.ok(find(result, 'Natural hazard risk rating'));
});

test('two intersecting FEMA panels produce a valid partial section with a visible explanation', async () => {
  const panel = { features: [
    { attributes: { FIRM_PAN: '48113C0215K', EFF_DATE: Date.UTC(2014, 6, 7), PANEL_TYP: 'Panel' } },
    { attributes: { FIRM_PAN: '48085C0525J', EFF_DATE: Date.UTC(2009, 8, 25), PANEL_TYP: 'Panel' } },
  ] };
  const result = await sectionFor({ panel }).load(CTX, {});
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.PARTIAL);
  assert.equal(result.evidence.floodPanelCount, 2);
  assert.match(result.message, /Multiple FEMA map panels/);
  assert.equal(find(result, 'FEMA flood zone at site').value, 'X');
});

test('DATA-01: FEMA FIRM panel prefers the panel matching the site county FIPS, not the newest', async () => {
  const panel = { features: [
    { attributes: { FIRM_PAN: '13089C0063K', EFF_DATE: Date.UTC(2019, 7, 15), PANEL_TYP: 'Panel' } },
    { attributes: { FIRM_PAN: '13121C0263G', EFF_DATE: Date.UTC(2013, 8, 18), PANEL_TYP: 'Panel' } },
  ] };
  const county = { features: [{ attributes: { GEOID: '13121' } }] };
  const result = await sectionFor({ panel, county }).load(CTX, {});
  validateSectionResult(result);
  assert.equal(find(result, 'FEMA flood map panel (FIRM)').value, '13121C0263G');
  assert.equal(result.status, SECTION_STATUS.READY);
});

test('DATA-01: no panel matches the site county, so all candidates are listed instead of a guess', async () => {
  const panel = { features: [
    { attributes: { FIRM_PAN: '48113C0215K', EFF_DATE: Date.UTC(2014, 6, 7), PANEL_TYP: 'Panel' } },
    { attributes: { FIRM_PAN: '48085C0525J', EFF_DATE: Date.UTC(2009, 8, 25), PANEL_TYP: 'Panel' } },
  ] };
  const county = { features: [{ attributes: { GEOID: '13121' } }] };
  const result = await sectionFor({ panel, county }).load(CTX, {});
  validateSectionResult(result);
  assert.equal(find(result, 'FEMA flood map panel (FIRM)'), undefined);
  const all = find(result, 'FEMA flood map panels (no county match)');
  assert.ok(all, 'expected an all-panels row when no candidate matches the site county');
  assert.equal(all.value, '48113C0215K, 48085C0525J');
  assert.match(result.message, /Multiple FEMA map panels/);
});

test('N6: a community-based FIRM panel (DFIRM_ID is an NFIP community number, not county-FIPS-prefixed) is still selected correctly', async () => {
  // Live shapes verified 2026-09-24: Brooklyn/Kings County NY (county FIPS
  // 36047) sits on a COMMUNITY-BASED panel, DFIRM_ID "360497" -- its first
  // 5 digits ("36049") never equal the county FIPS, by construction. A
  // stray countywide candidate from an unrelated county ("48113C...") is
  // included to prove the site still resolves instead of degrading to
  // "no county match" the way the old FIPS-prefix-only comparison did.
  const panel = { features: [
    { attributes: { FIRM_PAN: '48113C0215K', DFIRM_ID: '48113C', EFF_DATE: Date.UTC(2014, 6, 7), PANEL_TYP: 'Countywide, Panel Printed' } },
    { attributes: { FIRM_PAN: '3604970212F', DFIRM_ID: '360497', EFF_DATE: Date.UTC(2007, 8, 5), PANEL_TYP: 'Community Based, Not Printed' } },
  ] };
  const county = { features: [{ attributes: { GEOID: '36047' } }] };
  const result = await sectionFor({ panel, county }).load(CTX, {});
  validateSectionResult(result);
  assert.equal(find(result, 'FEMA flood map panel (FIRM)').value, '3604970212F');
  assert.equal(result.status, SECTION_STATUS.READY);
  assert.match(
    find(result, 'FEMA flood map panel (FIRM)').note,
    /panel selection approximate/,
    'N-3: a state-only, no-county-confirmation selection is a documented guess and must say so',
  );
});

test('N6 NEGATIVE: two community-based candidates in the same state is a genuine tie -- stays conservatively ambiguous, never a guess', async () => {
  const panel = { features: [
    { attributes: { FIRM_PAN: '3604970212F', DFIRM_ID: '360497', EFF_DATE: Date.UTC(2007, 8, 5), PANEL_TYP: 'Community Based, Not Printed' } },
    { attributes: { FIRM_PAN: '3605100050F', DFIRM_ID: '360510', EFF_DATE: Date.UTC(2007, 8, 5), PANEL_TYP: 'Community Based, Not Printed' } },
  ] };
  const county = { features: [{ attributes: { GEOID: '36047' } }] };
  const result = await sectionFor({ panel, county }).load(CTX, {});
  validateSectionResult(result);
  assert.equal(find(result, 'FEMA flood map panel (FIRM)'), undefined);
  assert.ok(find(result, 'FEMA flood map panels (no county match)'));
});

test('failed FEMA panel lookup retains exact zone as valid partial section', async () => {
  const result = await sectionFor({ panel: ARCGIS_400 }).load(CTX, {});
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.PARTIAL);
  assert.match(result.message, /supporting flood coverage is incomplete/);
  assert.equal(find(result, 'FEMA flood zone at site').value, 'X');
});

test('slow non-flood sources settle before section deadline and retain the FEMA site zone', async () => {
  const section = createHazardsSection({
    routeDeadlineMs: 15,
    fetchImpl: (url, init) => {
      if (String(url).includes('/hazards/flood?')) return Promise.resolve(new Response(JSON.stringify({
        status: 'ready', retrievedAt: '2026-09-23T12:00:00.000Z',
        data: { site: { zone: 'X', sfha: false }, mapStatus: 'empty', mapFeatureCount: 0 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    },
  });
  const keepAlive = setTimeout(() => {}, 50);
  const result = await section.load(CTX, {});
  clearTimeout(keepAlive);
  assert.equal(find(result, 'FEMA flood zone at site').value, 'X');
  assert.notEqual(result.status, SECTION_STATUS.UNAVAILABLE);
  assert.match(result.message, /Did not answer/);
});


test('Zone D and AREA NOT INCLUDED are undetermined, an X zone is not (B-S3-4)', () => {
  assert.equal(isFloodUndetermined('D', null), true);
  assert.equal(isFloodUndetermined('Zone D', null), true);
  assert.equal(isFloodUndetermined('X', 'AREA NOT INCLUDED'), true);
  // NEGATIVE: the zones FEMA HAS determined keep the inside/outside answer.
  assert.equal(isFloodUndetermined('AE', 'FLOODWAY'), false);
  assert.equal(isFloodUndetermined('X', 'AREA OF MINIMAL FLOOD HAZARD'), false);
  assert.equal(isFloodUndetermined('AE', null), false);
  assert.equal(isFloodUndetermined('', null), false);
});

// Tests for the location section run end to end through the real site routes with a mocked upstream, including the all-sources-down negative that must show the fixed message.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLocationSection,
  LOCATION_MESSAGES,
  pushValue,
} from './location.js';
import { createSiteHandlers } from '../../../server/providers/cre/site.js';
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
  siteUpstream,
} from '../server/wp3Fixtures.testutil.mjs';

const CTX = {
  lat: 36.320692,
  lon: -82.342509,
  address: '601 E MAIN ST, JOHNSON CITY, TN, 37601',
  rings: RINGS_M,
};

function sectionFor(overrides) {
  const upstream = siteUpstream(overrides);
  const handlers = createSiteHandlers({
    fetchImpl: upstream.fetchImpl,
    timing: TIMING,
    cacheOptions: { disk: false },
    limiter: null,
  });
  return createLocationSection({
    fetchImpl: routeFetch(mountAt('site', handlers)),
  });
}

const valueOf = (result, label) =>
  result.values.find((v) => v.label === label)?.value;

test('ready: every value is real and the contract validates', async () => {
  const result = await sectionFor().load(CTX, {});
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.READY);
  assert.equal(result.message, undefined);
  assert.equal(valueOf(result, 'Matched address'), CTX.address);
  assert.equal(valueOf(result, 'County'), 'Washington County, TN');
  assert.equal(valueOf(result, 'Census tract'), '47179060902');
  assert.equal(valueOf(result, 'Ground elevation'), 1650);
  assert.equal(valueOf(result, 'Ground slope'), 4);
  assert.equal(valueOf(result, 'Soil map unit'), 'Urban land');
  assert.equal(valueOf(result, 'Dominant soil component'), 'Urban land (90%)');
  assert.equal(valueOf(result, 'Watershed'), 'Brush Creek');
  const place = result.values.find((v) => v.label === 'City or place');
  assert.equal(place.value, 'Johnson City', 'Census "city" suffix dropped');
  assert.equal(
    place.raw,
    'Johnson City city',
    'raw TIGER name kept for export',
  );
  const shed = result.values.find((v) => v.label === 'Watershed');
  assert.match(shed.note, /HUC12/, 'technical term stays, secondary');
  assert.equal(valueOf(result, 'EPA walkability index'), 8.3);
  for (const v of result.values)
    assert.ok(!isPlaceholderValue(v.value), v.label);
  assert.ok(result.sourceUrls.length >= 5);
});

test('NEGATIVE: every source failing (ArcGIS 400 and error bodies) is unavailable with the fixed message', async () => {
  const down = {
    census: ARCGIS_400,
    epqs: ARCGIS_400,
    identify: ARCGIS_400,
    slope: ARCGIS_400,
    sda: ARCGIS_400,
    wbd: ARCGIS_400,
    walk: ARCGIS_400,
  };
  const result = await sectionFor(down).load(CTX, {});
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.UNAVAILABLE);
  assert.equal(result.message, LOCATION_MESSAGES.unavailable);
  assert.deepEqual(result.values, []);
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('one source down: still ready, and the message names only that source', async () => {
  const result = await sectionFor({ sda: ARCGIS_400 }).load(CTX, {});
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.READY);
  assert.equal(result.message, 'Did not answer, try again later: USDA soils.');
  assert.equal(valueOf(result, 'Soil map unit'), undefined);
});

test('geography down: county and tract fall back to the address match, labelled as such', async () => {
  const result = await sectionFor({ census: ARCGIS_400 }).load(
    { ...CTX, county: 'Washington County', tractGeoid: '47179060902' },
    {},
  );
  const tract = result.values.find((v) => v.label === 'Census tract');
  assert.equal(tract.value, '47179060902');
  assert.equal(tract.note, 'from the address match');
});

test('NEGATIVE: every source empty is status empty, not ready on ctx values alone', async () => {
  const result = await sectionFor({
    census: { result: { geographies: {} } },
    epqs: { value: -1000000 },
    identify: { value: 'NoData' },
    slope: { value: 'NoData' },
    sda: {},
    wbd: { features: [] },
    walk: { features: [] },
  }).load(CTX, {});
  validateSectionResult(result);
  assert.equal(result.status, SECTION_STATUS.EMPTY);
  assert.equal(result.message, LOCATION_MESSAGES.empty);
});

test('an aborted run rejects instead of writing a late result', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    sectionFor().load(CTX, { signal: controller.signal }),
    /aborted/,
  );
});

test('NEGATIVE: pushValue drops null, NaN and blank values', () => {
  const values = [];
  pushValue(values, 'a', null);
  pushValue(values, 'b', Number.NaN);
  pushValue(values, 'c', '   ');
  pushValue(values, 'd', 0);
  assert.deepEqual(values, [{ label: 'd', value: 0 }]);
});

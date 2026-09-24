// Tests for the imagery section: count, earliest, latest and resolution from a mocked changes answer, plus the empty and unavailable negatives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSectionResult } from '../contract.js';
import { RINGS_M } from '../config.js';
import { load } from './imagery.js';
import { clearWaybackChangesCache } from '../imagery/waybackProvider.js';

const TEMPLATE = (n) =>
  `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${n}/{z}/{y}/{x}`;
const ctx = {
  lat: 36.320692,
  lon: -82.342509,
  address: '601 E Main St',
  rings: RINGS_M,
};

const answer =
  (releases, status = 200) =>
  async () =>
    new Response(
      JSON.stringify({
        status: releases.length ? 'ready' : 'empty',
        retrievedAt: '2026-09-22T12:00:00.000Z',
        data: { releases, unknown: [], catalog: { count: 196 } },
      }),
      { status },
    );

test('ready: distinct dates, earliest, latest and source resolution', async () => {
  clearWaybackChangesCache();
  const result = await load(ctx, {
    fetchImpl: answer([
      {
        release: 64001,
        releaseDate: '2026-02-26',
        tileTemplate: TEMPLATE(64001),
        captureDate: '2025-04-19',
        resolutionM: 0.5,
        provider: 'Vantor Vivid Advanced',
      },
      {
        release: 26120,
        releaseDate: '2021-12-21',
        tileTemplate: TEMPLATE(26120),
        captureDate: null,
        resolutionM: 0.3,
        provider: null,
      },
      {
        release: 10,
        releaseDate: '2014-02-20',
        tileTemplate: TEMPLATE(10),
        captureDate: '2012-10-01',
        resolutionM: 0.6,
        provider: null,
      },
    ]),
  });
  validateSectionResult(result);
  assert.equal(result.status, 'ready');
  const byLabel = Object.fromEntries(result.values.map((v) => [v.label, v]));
  assert.equal(
    byLabel['Imagery updates at the site (releases that changed)'].value,
    3,
  );
  assert.equal(byLabel['Earliest imagery'].value, '2012-10-01');
  assert.equal(byLabel['Latest imagery'].value, '2025-04-19');
  assert.equal(byLabel['Source resolution (latest)'].value, 0.5);
  assert.equal(byLabel['Street-level imagery'].captureDate, null);
  assert.match(byLabel['Street-level imagery'].note, /Capture date unknown/);
  assert.match(
    byLabel['Street-level imagery'].externalUrl,
    /^https:\/\/www\.google\.com\/maps\/\@\?/,
  );
  assert.match(result.credit.text, /Esri, Vantor, Earthstar Geographics/);
});

test('negative: no releases at the site is empty with a reason', async () => {
  clearWaybackChangesCache();
  const result = await load(ctx, { fetchImpl: answer([]) });
  validateSectionResult(result);
  assert.equal(result.status, 'empty');
  assert.ok(result.message.length > 10);
});

test('negative: a failed route is unavailable, never empty', async () => {
  clearWaybackChangesCache();
  const result = await load(ctx, { fetchImpl: answer([], 502) });
  validateSectionResult(result);
  assert.equal(result.status, 'unavailable');
});

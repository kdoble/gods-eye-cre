import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSectionResult } from '../contract.js';
import { RINGS_M } from '../config.js';
import {
  CAMERAS_EMPTY_MESSAGE,
  camerasResult,
  compassPoint,
  load,
} from './cameras.js';

const ctx = {
  lat: 32.92,
  lon: -96.68,
  address: '12660 Jupiter Road',
  rings: RINGS_M,
};
const camera = {
  id: 'txdot-dal-bmVhcg',
  name: 'US-75 NB near',
  lat: 32.921,
  lon: -96.681,
  distanceM: 150,
  officialViewerUrl: 'https://its.txdot.gov/its/District/DAL',
  frameTime: null,
  frameTimeStatus: 'unknown',
  frameUrl: null,
};
const fetchBody =
  (body, status = 200) =>
  async (url) => {
    assert.match(url, /^\/api\/cre\/cameras\?lat=32\.92&lon=-96\.68&radiusM=/);
    return new Response(JSON.stringify(body), { status });
  };

test('authentic TxDOT metadata keeps frame and capture time unverified', async () => {
  const result = await load(ctx, {
    fetchImpl: fetchBody({
      status: 'ready',
      region: 'dfw',
      cameras: [camera],
      catalogRetrievedAt: '2026-09-23T11:00:00.000Z',
      retrievedAt: '2026-09-23T11:05:00.000Z',
    }),
  });
  validateSectionResult(result);
  assert.equal(result.status, 'ready');
  assert.equal(result.values[0].value, 1);
  assert.equal(result.values[1].frameUrl, null);
  assert.equal(result.values[1].frameTimeStatus, 'unknown');
  assert.match(result.values[1].note, /frame time unknown/);
  assert.equal(
    result.values[1].officialViewerUrl,
    'https://its.txdot.gov/its/District/DAL',
  );
  assert.equal(result.catalogRetrievedAt, '2026-09-23T11:00:00.000Z');
  assert.equal(result.overlays[0].geojson.features.length, 1);
});

test('client rejects substituted frame URLs and unrelated cameras', () => {
  const result = camerasResult(
    {
      status: 'ready',
      region: 'dfw',
      cameras: [
        { ...camera, frameUrl: '/api/cctv/frame/txdot-dal-bmVhcg' },
        { ...camera, id: 'google-fallback' },
      ],
    },
    ctx,
  );
  assert.equal(result.values[0].value, 1);
  assert.equal(result.values[1].frameUrl, null);
});

test('client caps and validates coordinates, status and catalog date', () => {
  const result = camerasResult(
    {
      status: 'ready',
      region: 'dfw',
      cameras: [
        { ...camera, lat: 44 },
        ...Array.from({ length: 15 }, (_, i) => ({
          ...camera,
          id: `txdot-dal-a${i}`,
        })),
      ],
      catalogRetrievedAt: 'tomorrow',
      retrievedAt: '2026-09-23T12:00:00.000Z',
    },
    ctx,
  );
  assert.equal(result.values[0].value, 9);
  assert.equal(result.catalogRetrievedAt, null);
  assert.equal(result.retrievedAt, '2026-09-23T12:00:00.000Z');
  for (const status of ['unknown', 'ready']) {
    const invalid = camerasResult({ region: 'dfw', status, cameras: [] }, ctx);
    assert.equal(invalid.status, 'unavailable');
  }
  assert.equal(
    camerasResult({ region: 'dfw', status: 'ready' }, ctx).status,
    'unavailable',
  );
});

test('empty DFW catalog, partial catalog and Georgia link-only remain distinct', async () => {
  const empty = await load(ctx, {
    fetchImpl: fetchBody({ status: 'empty', region: 'dfw', cameras: [] }),
  });
  validateSectionResult(empty);
  assert.equal(empty.status, 'empty');
  assert.equal(empty.message, CAMERAS_EMPTY_MESSAGE);

  const partial = await load(ctx, {
    fetchImpl: fetchBody({
      status: 'partial',
      region: 'dfw',
      cameras: [],
      message: 'Missing FTW district',
    }),
  });
  assert.equal(partial.status, 'partial');
  assert.match(partial.message, /FTW/);

  const ga = camerasResult(
    { region: 'georgia-candidate', status: 'needs-key', cameras: [] },
    ctx,
  );
  validateSectionResult(ga);
  assert.equal(ga.status, 'partial');
  assert.equal(ga.values[0].officialViewerUrl, 'https://511ga.org/');
  assert.match(ga.message, /developer access/);
});

test('source failure is unavailable and does not trigger inherited CCTV route', async () => {
  const result = await load(ctx, { fetchImpl: fetchBody({}, 503) });
  validateSectionResult(result);
  assert.equal(result.status, 'unavailable');
  assert.match(result.message, /CRE camera catalog/);
});

test('Georgia route failure points to the Georgia viewer', async () => {
  const result = await load(
    { ...ctx, lat: 33.76, lon: -84.39 },
    {
      fetchImpl: async () => new Response('', { status: 503 }),
    },
  );
  assert.equal(result.status, 'unavailable');
  assert.equal(result.credit.url, 'https://511ga.org/');
  assert.deepEqual(result.sourceUrls, ['https://511ga.org/']);
});

test('compass points describe camera position relative to site', () => {
  assert.equal(compassPoint(0), 'N');
  assert.equal(compassPoint(44), 'NE');
  assert.equal(compassPoint(181), 'S');
});

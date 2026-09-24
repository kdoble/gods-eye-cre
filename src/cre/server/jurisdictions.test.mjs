import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalJurisdiction } from '../../../server/providers/cre/jurisdictions.js';
import { loadLocalParcelZoning } from '../../../server/providers/cre/localZoning.js';
import { loadCrime } from '../../../server/providers/cre/neighborhood.js';

const point = { lat: 32.78, lon: -96.8 };
const ring = [
  [-96.82, 32.76], [-96.78, 32.76], [-96.78, 32.8],
  [-96.82, 32.8], [-96.82, 32.76],
];
const json = (body) => new Response(JSON.stringify(body), { status: 200 });

test('Dallas package requires exact official city polygon match, not candidate bounds', async () => {
  const urls = [];
  const outside = await resolveLocalJurisdiction(point, 1000, {
    fetchImpl: async (url, init) => {
      urls.push(new URL(url));
      assert.equal(init.redirect, 'error');
      return json({ features: [] });
    },
  });
  assert.equal(urls.length, 1);
  assert.equal(urls[0].origin, 'https://gis.dallascityhall.com');
  assert.equal(urls[0].searchParams.get('inSR'), '4326');
  assert.equal(urls[0].searchParams.get('outSR'), '4326');
  assert.equal(outside.status, 'uncovered');
  assert.equal(outside.id, null);

  const wrongName = await resolveLocalJurisdiction(point, 1000, {
    fetchImpl: async () => json({ features: [{ attributes: { CITY: 'Dallas County' }, geometry: { rings: [ring] } }] }),
  });
  assert.equal(wrongName.status, 'uncovered');
});

test('official polygon confirms jurisdiction and flags a ring crossing its boundary', async () => {
  const fetchImpl = async () => json({
    features: [{ attributes: { CITY: 'Dallas' }, geometry: { rings: [ring] } }],
  });
  const inside = await resolveLocalJurisdiction(point, 1000, { fetchImpl });
  assert.equal(inside.status, 'resolved');
  assert.equal(inside.id, 'dallas-tx');
  assert.equal(inside.crossesBoundary, false);
  assert.equal(inside.countyStatus, 'not-resolved-by-city-package');
  const crossing = await resolveLocalJurisdiction(point, 2500, { fetchImpl });
  assert.equal(crossing.crossesBoundary, true);
});

test('invalid boundary geometry or failed source is unknown, never uncovered', async () => {
  const missingName = await resolveLocalJurisdiction(point, 1000, {
    fetchImpl: async () => json({ features: [{ attributes: { OTHER: 'Dallas' }, geometry: { rings: [ring] } }] }),
  });
  assert.equal(missingName.status, 'unavailable');
  const invalid = await resolveLocalJurisdiction(point, 1000, {
    fetchImpl: async () => json({ features: [{ attributes: { CITY: 'Dallas' }, geometry: { rings: [[[0, 0], [1, 1]]] } }] }),
  });
  assert.equal(invalid.status, 'unavailable');
  const failed = await resolveLocalJurisdiction(point, 1000, {
    fetchImpl: async () => new Response('{}', { status: 503 }),
  });
  assert.equal(failed.status, 'unavailable');
});

test('Atlanta package requires NAME field and its official polygon', async () => {
  const atlanta = { lat: 33.75, lon: -84.39 };
  const atlantaRing = [[-84.4, 33.74], [-84.38, 33.74], [-84.38, 33.76], [-84.4, 33.76], [-84.4, 33.74]];
  const seen = [];
  const result = await resolveLocalJurisdiction(atlanta, 1000, {
    fetchImpl: async (url) => {
      seen.push(new URL(url));
      return json({ features: [{ attributes: { NAME: 'Atlanta' }, geometry: { rings: [atlantaRing] } }] });
    },
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.id, 'atlanta-ga');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].pathname, '/dpcd/rest/services/AdministrativeArea/GeopoliticalArea/FeatureServer/0/query');
  const missing = await resolveLocalJurisdiction(atlanta, 1000, {
    fetchImpl: async () => json({ features: [{ attributes: { CITY: 'Atlanta' }, geometry: { rings: [atlantaRing] } }] }),
  });
  assert.equal(missing.status, 'unavailable');
});

test('Dallas zoning is conditionally available and code does not invent a parcel feed', async () => {
  let query;
  const jurisdiction = { id: 'dallas-tx', crossesBoundary: true };
  const result = await loadLocalParcelZoning(point, jurisdiction, {
    fetchImpl: async (url, init) => {
      query = new URL(url);
      assert.equal(init.redirect, 'error');
      return json({ features: [{ attributes: { LONG_ZONE_DIST: 'PD-619' }, geometry: { rings: [ring] } }] });
    },
  });
  assert.equal(query.pathname, '/arcgis/rest/services/sdc_public/Zoning/MapServer/15/query');
  assert.equal(result.zoningFeatures[0].properties.LONG_ZONE_DIST, 'PD-619');
  assert.equal(result.parcelStatus, 'unsupported');
  assert.equal(result.crossesBoundary, true);
  assert.equal(result.sourceMetadata.recordDate, null);

  const mismatch = await loadLocalParcelZoning(point, jurisdiction, {
    fetchImpl: async () => json({ features: [{ attributes: { OTHER: 'PD-619' }, geometry: { rings: [ring] } }] }),
  });
  assert.equal(mismatch.status, 'unavailable');
  assert.equal(mismatch.zoningStatus, 'unavailable');

  const empty = await loadLocalParcelZoning(point, jurisdiction, {
    fetchImpl: async () => json({ features: [] }),
  });
  assert.equal(empty.status, 'empty');
  assert.equal(empty.zoningStatus, 'empty');

  const truncated = await loadLocalParcelZoning(point, jurisdiction, {
    fetchImpl: async () => json({
      exceededTransferLimit: true,
      features: [{ attributes: { LONG_ZONE_DIST: 'PD-619' }, geometry: { rings: [ring] } }],
    }),
  });
  assert.equal(truncated.status, 'partial');
  assert.equal(truncated.zoningStatus, 'partial');
});

test('Atlanta crime stays official-link-only while its direct source gate is unresolved', async () => {
  for (const id of ['atlanta-ga']) {
    let calls = 0;
    const result = await loadCrime(point, 1609, {
      jurisdiction: { id },
      fetchImpl: async () => { calls += 1; throw new Error('unexpected network call'); },
    });
    assert.equal(calls, 0);
    assert.equal(result.status, 'unsupported');
    assert.equal(result.sourceStatus, 'published-not-connected');
    assert.equal(result.features.length, 0);
  }
});

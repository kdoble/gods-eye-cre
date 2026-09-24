// Census address geocoder: detection, fixture parsing, and fall-through to Photon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createCensusGeocoder,
  looksLikeUsStreetAddress,
  normalizeCensusResponse,
} from './censusGeocoder.js';
import { createCoordinateGeocoder } from './coordinateGeocoder.js';
import { createPlaceSearch } from './placeSearch.js';
import { createPhotonGeocoder } from '../keylessGeocoder.js';

const testPoint = JSON.parse(
  readFileSync(
    new URL(
      './fixtures/census-testpoint-601-e-main-st.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const noMatch = { result: { input: {}, addressMatches: [] } };
const photonRoad = {
  features: [
    {
      geometry: { type: 'Point', coordinates: [-82.3712, 36.3087] },
      properties: {
        name: 'University Parkway',
        osm_key: 'highway',
        osm_value: 'primary',
        type: 'street',
      },
    },
  ],
};

/** Chain matching the default order: coordinates, Census, then Photon. */
function chain(fetchImpl) {
  return createPlaceSearch({
    providers: [
      createCoordinateGeocoder(),
      createCensusGeocoder({ fetchImpl }),
      createPhotonGeocoder({ fetchImpl }),
    ],
  });
}

test('US street addresses are detected', () => {
  for (const query of [
    '601 E Main Street, Johnson City, TN',
    '601 E Main St, Johnson City, TN',
    '601 E MAIN ST, JOHNSON CITY, TN, 37601',
    '675 Ponce de Leon Ave NE, Atlanta, GA',
    '1600 Pennsylvania Ave. NW, Washington, DC 20500',
    '221B Baker Street',
    '350 Fifth Avenue New York NY 10118',
    '12 Main, Springfield, Illinois',
    '42 Peachtree, Atlanta, GA 30303',
    '99999 Nowhere Blvd, Faketown, ZZ',
    // Numbered streets: the second token is an ordinal ("5th"), not a
    // letter, and the old HOUSE_NUMBER_STREET regex missed these entirely,
    // sending "350 5th Ave" to Photon place search instead of Census.
    '350 5th Ave, New York, NY',
    '42 42nd St, New York, NY',
    '1 1st Ave, New York, NY',
    '100 3rd St, San Francisco, CA',
  ])
    assert.equal(looksLikeUsStreetAddress(query), true, query);
});

test('names, cities and coordinates are not addresses', () => {
  for (const query of [
    'City Hall',
    'Atlanta',
    'Atlanta, GA',
    'Johnson City, TN 37601',
    'City Hall, Johnson City',
    'Times Square',
    'Ho Guom, Ha Noi',
    '36.320692, -82.342509',
    '36.320692 -82.342509',
    '10 Downing',
    '37601',
    '',
    '   ',
  ])
    assert.equal(looksLikeUsStreetAddress(query), false, query);
});

test('negative: the detector rejects "City Hall" and "Atlanta" and makes no request', async () => {
  let calls = 0;
  const census = createCensusGeocoder({
    fetchImpl: async () => {
      calls++;
      return Response.json(testPoint);
    },
  });
  for (const query of ['City Hall', 'Atlanta']) {
    assert.equal(looksLikeUsStreetAddress(query), false);
    assert.deepEqual(await census.geocode(query), {
      place: null,
      answered: true,
    });
  }
  assert.equal(calls, 0);
});

test('the recorded test-point response parses to a point-level place', () => {
  const place = normalizeCensusResponse(testPoint);
  assert.equal(place.lat, 36.320691517558);
  assert.equal(place.lng, -82.342508730011);
  assert.equal(
    place.matchedAddress,
    '601 E MAIN ST, JOHNSON CITY, TN, 37601',
  );
  assert.equal(place.label, place.matchedAddress);
  assert.equal(place.tractGeoid, '47179060902');
  assert.equal(place.countyGeoid, '47179');
  assert.equal(place.stateAbbr, 'TN');
  assert.equal(place.city, 'JOHNSON CITY');
  assert.equal(place.geocoder, 'census');
  assert.equal(place.exact, true);
  assert.equal(place.viewport, null);
  assert.deepEqual(place.types, ['street_address']);
});

test('empty or malformed responses normalize to null', () => {
  assert.equal(normalizeCensusResponse(noMatch), null);
  assert.equal(normalizeCensusResponse({}), null);
  assert.equal(
    normalizeCensusResponse({
      result: { addressMatches: [{ coordinates: { x: 'a', y: null } }] },
    }),
    null,
  );
});

const ground = {
  results: [
    {
      lon: -82.34251,
      lat: 36.32069,
      elevation: 503.28,
      geoid: -32.25,
      ellipsoid: 471.03,
    },
  ],
};

test('a Census match wins the chain, gets its ground height, and Photon is never asked', async () => {
  const urls = [];
  const result = await chain(async (url) => {
    urls.push(url);
    if (url.startsWith('/api/census-geocode')) return Response.json(testPoint);
    if (url.startsWith('/api/terrain/heights')) return Response.json(ground);
    return Response.json(photonRoad);
  }).geocode('601 E Main St, Johnson City, TN');
  assert.equal(result.place.geocoder, 'census');
  assert.equal(result.place.tractGeoid, '47179060902');
  assert.equal(result.place.groundElevation, 471.03);
  assert.equal(result.place.viewRangeM, 700);
  assert.equal(urls.length, 2);
  assert.equal(
    new URL(urls[0], 'http://x').searchParams.get('address'),
    '601 E Main St, Johnson City, TN',
  );
  assert.equal(
    new URL(urls[1], 'http://x').searchParams.get('points'),
    '-82.34251,36.32069',
  );
});

test('a failed ground lookup keeps the match with a null ground height', async () => {
  const result = await chain(async (url) => {
    if (url.startsWith('/api/census-geocode')) return Response.json(testPoint);
    if (url.startsWith('/api/terrain/heights'))
      throw new TypeError('fetch failed');
    return Response.json(photonRoad);
  }).geocode('601 E Main St, Johnson City, TN');
  assert.equal(result.place.geocoder, 'census');
  assert.equal(result.place.groundElevation, null);
});

test('a Census no-match falls through to Photon', async () => {
  const hosts = [];
  const result = await chain(async (url) => {
    hosts.push(url.startsWith('/') ? 'census' : new URL(url).hostname);
    return url.startsWith('/api/census-geocode')
      ? Response.json(noMatch)
      : Response.json(photonRoad);
  }).geocode('601 E Main St, Johnson City, TN');
  assert.deepEqual(hosts, ['census', 'photon.komoot.io']);
  assert.equal(result.place.name, 'University Parkway');
  assert.equal(result.answered, true);
});

test('a Census network error or 503 falls through to Photon', async () => {
  for (const fail of [
    () => {
      throw new TypeError('fetch failed');
    },
    () => Response.json({ error: 'unavailable' }, { status: 503 }),
    () => new Response('not json'),
  ]) {
    const result = await chain(async (url) =>
      url.startsWith('/api/census-geocode')
        ? fail()
        : Response.json(photonRoad),
    ).geocode('675 Ponce de Leon Ave NE, Atlanta, GA');
    assert.equal(result.place.name, 'University Parkway');
  }
});

test('non-addresses skip Census entirely', async () => {
  const hosts = [];
  await chain(async (url) => {
    hosts.push(url.startsWith('/') ? 'census' : new URL(url).hostname);
    return Response.json(photonRoad);
  }).geocode('Atlanta');
  assert.deepEqual(hosts, ['photon.komoot.io']);
});

test('a Census failure reports unanswered so the miss is not cached', async () => {
  let calls = 0;
  const census = createCensusGeocoder({
    fetchImpl: async (url) => {
      if (url.startsWith('/api/terrain/heights')) return Response.json(ground);
      if (++calls === 1) throw new TypeError('fetch failed');
      return Response.json(testPoint);
    },
  });
  const query = '601 E Main St, Johnson City, TN';
  assert.deepEqual(await census.geocode(query), {
    place: null,
    answered: false,
  });
  assert.equal((await census.geocode(query)).place.tractGeoid, '47179060902');
  assert.equal(calls, 2);
});

test('caller cancellation throws instead of falling through', async () => {
  const controller = new AbortController();
  const census = createCensusGeocoder({
    fetchImpl: async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    },
  });
  await assert.rejects(
    census.geocode('601 E Main St, Johnson City, TN', {
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
});

// US-first lookup tests: ZIPs never leave the US, names ignore the view bias and prefer the prominent US place, non-street matches are flagged approximate, and foreign matches are refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyQuery,
  createUsFirstGeocode,
  foreignCountryInQuery,
  hasUsSignal,
  inUsBoxes,
  usStateAt,
} from './usGeocode.js';

const json = (body) => ({ ok: true, json: async () => body });

const feature = (name, lat, lon, props = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { name, countrycode: 'US', country: 'United States', ...props },
});

/**
 * Fake fetch: ZCTA queries, the TIGERweb state point test, the US-filtered
 * Photon call (it carries `bbox`) and the world Photon call (it does not).
 * `world` defaults to the same table as `photon` so a query that is US-only
 * in both stays US.
 */
function fakeFetch({ zcta = {}, photon = {}, world = null, states = {} } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const parsed = new URL(url);
    if (parsed.hostname === 'tigerweb.geo.census.gov') {
      if (parsed.searchParams.has('geometry')) {
        const [lon, lat] = parsed.searchParams
          .get('geometry')
          .split(',')
          .map(Number);
        const hit = states[`${lat},${lon}`];
        return json({
          features: hit ? [{ attributes: { STUSAB: hit, NAME: hit } }] : [],
        });
      }
      const zip = /ZCTA5='(\d{5})'/.exec(parsed.searchParams.get('where'))[1];
      const hit = zcta[zip];
      return json({
        features: hit
          ? [{ attributes: { ZCTA5: zip, INTPTLAT: hit[0], INTPTLON: hit[1] } }]
          : [],
      });
    }
    if (parsed.hostname === 'photon.komoot.io') {
      const q = parsed.searchParams.get('q');
      const table = parsed.searchParams.has('bbox') ? photon : (world ?? photon);
      return json({ features: table[q] || [] });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { impl, calls };
}

function fakeOriginal(answers) {
  const calls = [];
  const fn = async (query, options) => {
    calls.push({ query, options });
    return answers[query] || { place: null, answered: true };
  };
  return { fn, calls };
}

const UKRAINE = {
  place: {
    lat: 49.97,
    lng: 33.6,
    label: '37604, Myrhorod, Poltava Oblast, Ukraine',
  },
  answered: true,
};

test('classify: ZIP, ZIP+4, PO Box, coordinates, other', () => {
  assert.deepEqual(classifyQuery('37604'), { kind: 'zip', zip: '37604' });
  assert.deepEqual(classifyQuery(' 37604-1234 '), {
    kind: 'zip',
    zip: '37604',
  });
  assert.deepEqual(classifyQuery('37604, USA'), { kind: 'zip', zip: '37604' });
  assert.deepEqual(classifyQuery('PO Box 123, Johnson City, TN 37605'), {
    kind: 'pobox',
    zip: '37605',
  });
  assert.deepEqual(classifyQuery('P.O. Box 9, Johnson City, TN'), {
    kind: 'pobox',
    zip: null,
  });
  assert.equal(classifyQuery('36.3207, -82.3425').kind, 'coords');
  assert.equal(
    classifyQuery('601 E Main St, Johnson City, TN').kind,
    'other',
  );
  assert.equal(classifyQuery('Atlanta').kind, 'other');
});

test('ZIP resolves to the Census ZIP center and never asks the world geocoder', async () => {
  const net = fakeFetch({ zcta: { 37604: ['+36.2992419', '-082.3830442'] } });
  const original = fakeOriginal({ 37604: UKRAINE });
  const geocode = createUsFirstGeocode(original.fn, { fetchImpl: net.impl });
  const outcome = await geocode('37604');
  assert.equal(original.calls.length, 0, 'world geocoder not consulted');
  assert.equal(outcome.place.lat, 36.2992419);
  assert.equal(outcome.place.lng, -82.3830442);
  assert.equal(outcome.place.zip, '37604');
  assert.equal(
    outcome.cre.approximate,
    'Approximate match: center of ZIP 37604, not a street address',
  );
});

test('negative: an unknown ZIP is a no-match, not a foreign place', async () => {
  const net = fakeFetch();
  const original = fakeOriginal({ '00000': UKRAINE });
  const geocode = createUsFirstGeocode(original.fn, { fetchImpl: net.impl });
  const outcome = await geocode('00000');
  assert.equal(outcome.place, null);
  assert.equal(outcome.answered, true);
  assert.equal(original.calls.length, 0);
});

test('city name drops the view bias and prefers the prominent US match', async () => {
  const net = fakeFetch({
    photon: {
      Atlanta: [
        feature('Atlanta', 33.749, -84.388, { state: 'Georgia', type: 'city' }),
        feature('Atlanta', 29.66, -97.67, { state: 'Texas', type: 'city' }),
      ],
    },
  });
  const original = fakeOriginal({
    Atlanta: {
      place: {
        lat: 29.66,
        lng: -97.67,
        label: 'Atlanta, Luling, Texas, United States',
      },
      answered: true,
    },
  });
  const geocode = createUsFirstGeocode(original.fn, { fetchImpl: net.impl });
  const outcome = await geocode('Atlanta', { bias: '30,-98|31,-97' });
  assert.equal(original.calls[0].options.bias, null, 'view bias removed');
  assert.equal(outcome.place.lat, 33.749);
  assert.match(outcome.cre.approximate, /Atlanta, Georgia/);
  assert.deepEqual(outcome.cre.others, ['Atlanta, Texas, United States']);
  const photonUrl = new URL(net.calls.find((u) => u.includes('photon')));
  assert.equal(photonUrl.searchParams.get('bbox'), '-179.9,17.5,-64,71.6');
});

test('negative: a non-US Photon feature inside the box is never chosen', async () => {
  const net = fakeFetch({
    photon: {
      Windsor: [
        feature('Windsor', 42.3, -83.0, {
          countrycode: 'CA',
          country: 'Canada',
        }),
        feature('Windsor', 38.54, -122.82, { state: 'California' }),
      ],
    },
    // The world geocoder leads with the US one here, so the outside-US path
    // stays shut and this test measures only the country filter.
    world: {
      Windsor: [
        feature('Windsor', 38.54, -122.82, { state: 'California' }),
        feature('Windsor', 42.3, -83.0, { countrycode: 'CA' }),
      ],
    },
  });
  const geocode = createUsFirstGeocode(fakeOriginal({}).fn, {
    fetchImpl: net.impl,
  });
  const outcome = await geocode('Windsor');
  assert.equal(outcome.place.lat, 38.54);
});

test('a foreign place the world geocoder ranks first is refused, not answered with a US namesake (B2-01)', async () => {
  const net = fakeFetch({
    photon: {
      Toronto: [
        feature('Toronto', 41.9, -90.86, { state: 'Iowa', type: 'city' }),
      ],
      'Tokyo Japan': [
        feature('Tokyo Japan Hibachi and Sushi', 34.67, -86.03, {
          state: 'Alabama',
          city: 'Scottsboro',
        }),
      ],
      '10 Downing Street, London': [
        feature('Legare-Morgan House', 33.56, -81.72, {
          state: 'South Carolina',
          city: 'Aiken',
        }),
      ],
    },
    world: {
      Toronto: [
        feature('Toronto', 43.65, -79.38, {
          countrycode: 'CA',
          country: 'Canada',
          state: 'Ontario',
          type: 'city',
        }),
        feature('Toronto', 41.9, -90.86, { state: 'Iowa', type: 'city' }),
      ],
      'Tokyo Japan': [
        feature('Tokyo', 35.68, 139.76, {
          countrycode: 'JP',
          country: 'Japan',
          type: 'city',
        }),
      ],
      '10 Downing Street, London': [
        feature('10 Downing Street', 51.5034, -0.1276, {
          countrycode: 'GB',
          country: 'United Kingdom',
          city: 'London',
        }),
      ],
    },
  });
  const geocode = createUsFirstGeocode(fakeOriginal({}).fn, {
    fetchImpl: net.impl,
  });
  for (const query of ['Toronto', 'Tokyo Japan', '10 Downing Street, London']) {
    const outcome = await geocode(query);
    assert.equal(outcome.place, null, `${query} must not land on a US place`);
    assert.equal(outcome.answered, true);
    assert.ok(outcome.cre.outsideUs, `${query} names the foreign match`);
  }
});

test('a trailing country name refuses the query even when the world geocoder is down', async () => {
  const net = fakeFetch({
    photon: {
      'Shibuya, Tokyo, Japan': [
        feature('Tokyo Steakhouse', 35.2, -89.9, { state: 'Tennessee' }),
      ],
    },
    world: {},
  });
  const geocode = createUsFirstGeocode(fakeOriginal({}).fn, {
    fetchImpl: net.impl,
  });
  const outcome = await geocode('Shibuya, Tokyo, Japan');
  assert.equal(outcome.place, null);
  assert.match(outcome.cre.outsideUs, /Japan/);
});

test('NEGATIVE: a US signal in the query keeps the US namesake, never outside-us', async () => {
  const iowaOnly = [
    feature('Toronto', 41.9, -90.86, { state: 'Iowa', type: 'city' }),
  ];
  const net = fakeFetch({
    photon: {
      'Toronto, IA': iowaOnly,
      'Athens GA': [
        feature('Athens', 33.96, -83.38, { state: 'Georgia', type: 'city' }),
      ],
    },
    world: {
      'Toronto, IA': [
        feature('Toronto', 43.65, -79.38, {
          countrycode: 'CA',
          state: 'Ontario',
        }),
        ...iowaOnly,
      ],
      'Athens GA': [
        feature('Athens', 37.98, 23.73, {
          countrycode: 'GR',
          state: 'Attica',
        }),
      ],
    },
  });
  const geocode = createUsFirstGeocode(fakeOriginal({}).fn, {
    fetchImpl: net.impl,
  });
  const iowa = await geocode('Toronto, IA');
  assert.equal(iowa.cre.outsideUs, '', 'a state abbreviation is a US signal');
  assert.equal(iowa.place.lat, 41.9);
  const athens = await geocode('Athens GA');
  assert.equal(athens.cre.outsideUs, '');
  assert.equal(athens.place.lat, 33.96);
  // The world call must not even be made once the query claims a US state.
  assert.ok(
    net.calls.every((url) => !url.includes('photon') || url.includes('bbox')),
    'no world lookup for a query that names a US state',
  );
});

test('ranking: the place the query names beats a business that merely contains it (B2-05)', async () => {
  const net = fakeFetch({
    photon: {
      'Portland OR': [
        feature('Portland', 45.52, -122.68, {
          state: 'Oregon',
          type: 'city',
        }),
        feature('Portland Oregon Temple', 45.39, -122.68, {
          state: 'Oregon',
          city: 'Lake Oswego',
        }),
      ],
      'City Hall Johnson City': [
        feature(
          'Howard Johnson Atlantic City/Egg Harbor Township',
          39.4,
          -74.6,
          { state: 'New Jersey', city: 'Egg Harbor Township' },
        ),
        feature('The Mall at Johnson City', 36.33, -82.37, {
          state: 'Tennessee',
          city: 'Johnson City',
        }),
      ],
    },
  });
  const geocode = createUsFirstGeocode(fakeOriginal({}).fn, {
    fetchImpl: net.impl,
  });
  const portland = await geocode('Portland OR');
  assert.equal(portland.place.lat, 45.52, 'Portland, Oregon, not the Temple');
  const cityHall = await geocode('City Hall Johnson City');
  assert.equal(cityHall.place.lat, 36.33, 'Johnson City TN, not New Jersey');
});

test('a Census street match passes through untouched, no warning', async () => {
  const street = {
    place: {
      lat: 36.320692,
      lng: -82.342509,
      label: '601 E MAIN ST, JOHNSON CITY, TN, 37601',
      matchedAddress: '601 E MAIN ST, JOHNSON CITY, TN, 37601',
    },
    answered: true,
  };
  const net = fakeFetch();
  const original = fakeOriginal({
    '601 E Main St, Johnson City, TN': street,
  });
  const geocode = createUsFirstGeocode(original.fn, { fetchImpl: net.impl });
  const outcome = await geocode('601 E Main St, Johnson City, TN');
  assert.equal(outcome.place, street.place);
  assert.equal(outcome.cre.approximate, '');
  assert.equal(net.calls.length, 0);
});

test('a property name that lands on a business is flagged approximate', async () => {
  const net = fakeFetch({
    photon: {
      'City Hall Johnson City': [
        feature('Howard Johnson Atlantic City/Egg Harbor', 39.4, -74.6, {
          city: 'Egg Harbor Township',
          state: 'New Jersey',
        }),
      ],
    },
  });
  const geocode = createUsFirstGeocode(fakeOriginal({}).fn, {
    fetchImpl: net.impl,
  });
  const outcome = await geocode('City Hall Johnson City');
  assert.ok(outcome.place);
  assert.match(
    outcome.cre.approximate,
    /^Approximate match: Howard Johnson Atlantic City\/Egg Harbor, .*New Jersey.*, not a street address$/,
  );
});

test('PO Box: ZIP center when a ZIP is given, the city otherwise, always approximate', async () => {
  const net = fakeFetch({
    zcta: { 37605: ['+36.3', '-082.35'] },
    photon: {
      'Johnson City, TN': [
        feature('Johnson City', 36.31, -82.35, {
          state: 'Tennessee',
          type: 'city',
        }),
      ],
    },
  });
  const geocode = createUsFirstGeocode(fakeOriginal({}).fn, {
    fetchImpl: net.impl,
  });
  const withZip = await geocode('PO Box 123, Johnson City, TN 37605');
  assert.match(
    withZip.cre.approximate,
    /ZIP 37605 \(a PO Box has no street location\)/,
  );
  // 37615 has no ZCTA in this fake, like the real PO Box only ZIP 37605.
  const poOnlyZip = await geocode('PO Box 123, Johnson City, TN 37615');
  assert.equal(poOnlyZip.place.lat, 36.31, 'falls back to the town');
  assert.match(poOnlyZip.cre.approximate, /Johnson City, Tennessee.*PO Box/);
  const noZip = await geocode('PO Box 123, Johnson City, TN');
  assert.equal(noZip.place.lat, 36.31);
  assert.match(noZip.cre.approximate, /Johnson City, Tennessee/);
});

test('negative: a place outside the US is refused with its name, not run', async () => {
  const net = fakeFetch();
  const original = fakeOriginal({ Myrhorod: UKRAINE });
  const geocode = createUsFirstGeocode(original.fn, { fetchImpl: net.impl });
  const outcome = await geocode('Myrhorod');
  assert.equal(outcome.place, null);
  assert.equal(outcome.answered, true);
  assert.match(outcome.cre.outsideUs, /Ukraine/);
});

test('coordinates: US passes, outside the US is refused', async () => {
  const original = fakeOriginal({
    '36.3207, -82.3425': {
      place: { lat: 36.3207, lng: -82.3425, label: '36.3207, -82.3425' },
      answered: true,
    },
    '48.85, 2.35': {
      place: { lat: 48.85, lng: 2.35, label: '48.85, 2.35' },
      answered: true,
    },
  });
  const net = fakeFetch({ states: { '36.3207,-82.3425': 'TN' } });
  const geocode = createUsFirstGeocode(original.fn, { fetchImpl: net.impl });
  const us = await geocode('36.3207, -82.3425');
  assert.equal(us.place.lat, 36.3207);
  assert.equal(us.cre.outsideUs, '');
  const paris = await geocode('48.85, 2.35');
  assert.equal(paris.place, null);
  assert.equal(paris.cre.outsideUs, '48.85, 2.35');
  assert.equal(inUsBoxes(21.3, -157.85), true, 'Honolulu');
  assert.equal(inUsBoxes(61.2, -149.9), true, 'Anchorage');
});

test('NEGATIVE: coordinates inside the coarse US boxes but in Canada or Mexico are refused (B-S2-1)', async () => {
  const points = {
    '43.6532, -79.3832': 'Toronto, Ontario',
    '42.3149, -83.0364': 'Windsor, Ontario',
    '25.6866, -100.3161': 'Monterrey, Mexico',
  };
  const original = fakeOriginal(
    Object.fromEntries(
      Object.entries(points).map(([query, label]) => [
        query,
        {
          place: {
            lat: Number(query.split(',')[0]),
            lng: Number(query.split(',')[1]),
            label,
          },
          answered: true,
        },
      ]),
    ),
  );
  // No `states` entry: TIGERweb answers with no feature, as it does live.
  const net = fakeFetch();
  const geocode = createUsFirstGeocode(original.fn, { fetchImpl: net.impl });
  for (const [query, label] of Object.entries(points)) {
    const [lat, lng] = query.split(',').map(Number);
    assert.equal(inUsBoxes(lat, lng), true, `${label} is inside the coarse boxes`);
    const outcome = await geocode(query);
    assert.equal(outcome.place, null, `${label} must not build a US dossier`);
    assert.equal(outcome.cre.outsideUs, label);
  }
});

test('usStateAt: a US point names its state, a foreign point is out, an unanswered query is unknown', async () => {
  const net = fakeFetch({ states: { '36.3207,-82.3425': 'TN' } });
  const inside = await usStateAt(36.3207, -82.3425, { fetchImpl: net.impl });
  assert.deepEqual(inside, { inUs: true, state: 'TN', answered: true });
  const canada = await usStateAt(43.6532, -79.3832, { fetchImpl: net.impl });
  assert.equal(canada.inUs, false);
  const ocean = await usStateAt(25, -45, { fetchImpl: net.impl });
  assert.equal(ocean.inUs, false, 'outside the boxes needs no network');
  const down = await usStateAt(36.3207, -82.3425, {
    fetchImpl: async () => {
      throw new Error('down');
    },
  });
  assert.deepEqual(down, { inUs: null, state: '', answered: false });
});

test('hasUsSignal and foreignCountryInQuery read the query, not the network', () => {
  assert.equal(hasUsSignal('Portland OR'), true);
  assert.equal(hasUsSignal('Athens GA'), true);
  assert.equal(hasUsSignal('Toronto, IA'), true);
  assert.equal(
    hasUsSignal('601 E Main St, Johnson City, TN 37601'),
    true,
  );
  assert.equal(hasUsSignal('Anywhere, USA'), true);
  assert.equal(hasUsSignal('Toronto'), false);
  assert.equal(hasUsSignal('10 Downing Street, London'), false);
  assert.equal(
    hasUsSignal('Harbor or Bay'),
    false,
    'a mid-query "or" is not Oregon',
  );
  assert.equal(foreignCountryInQuery('Tokyo Japan'), 'Japan');
  assert.equal(foreignCountryInQuery('Paris, France'), 'France');
  assert.equal(
    foreignCountryInQuery('Albuquerque, New Mexico'),
    '',
    'New Mexico is a state',
  );
  assert.equal(foreignCountryInQuery('Mexico City'), '', 'not trailing');
  assert.equal(foreignCountryInQuery('Lebanon'), '', 'one word is a US town');
  assert.equal(foreignCountryInQuery('Atlanta, Georgia'), '', 'a US state');
});

// Marfa is ~30.3211,-104.0212; Georgetown is ~30.6333,-97.6772 — about 380
// miles apart, both in Texas, so a state-only check would miss it (B1: a
// nonexistent "101 Main St, Marfa TX" matched Georgetown, TX, and 11 of 17
// dossier sections still built for the wrong city).
const MARFA = feature('Marfa', 30.3211, -104.0212, {
  city: 'Marfa',
  state: 'Texas',
  type: 'city',
});
const ATLANTA = feature('Atlanta', 33.749, -84.388, {
  city: 'Atlanta',
  state: 'Georgia',
  type: 'city',
});

test('city-mismatch: a Census street match 380 miles from the typed city is stopped, not built', async () => {
  const georgetown = {
    place: {
      lat: 30.6333,
      lng: -97.6772,
      label: '101 MAIN ST, GEORGETOWN, TX, 78626',
      matchedAddress: '101 MAIN ST, GEORGETOWN, TX, 78626',
      stateAbbr: 'TX',
    },
    answered: true,
  };
  const net = fakeFetch({ photon: { 'Marfa TX': [MARFA] } });
  const original = fakeOriginal({
    '101 Main St, Marfa TX': georgetown,
  });
  const geocode = createUsFirstGeocode(original.fn, { fetchImpl: net.impl });
  const outcome = await geocode('101 Main St, Marfa TX');
  assert.equal(outcome.place, null, 'must not build a dossier for Georgetown');
  assert.equal(outcome.answered, true);
  assert.ok(outcome.cre.cityMismatch, 'reports a city mismatch');
  assert.equal(outcome.cre.cityMismatch.typed, '101 Main St, Marfa TX');
  assert.match(outcome.cre.cityMismatch.matchLabel, /GEORGETOWN/);
  assert.ok(
    outcome.cre.cityMismatch.milesOff > 300,
    `expected >300 miles, got ${outcome.cre.cityMismatch.milesOff}`,
  );
  assert.equal(outcome.cre.cityMismatch.cityCenter.lat, 30.3211);
  assert.equal(
    outcome.cre.cityMismatch.matchedPlace,
    null,
    'N-2: a RESOLVED (genuine) mismatch has no "use anyway" override -- only unresolved does',
  );
});

test('city-mismatch: a Census street match inside the typed city passes through, no warning', async () => {
  const match = {
    place: {
      lat: 33.7719,
      lng: -84.3654,
      label: '675 PONCE DE LEON AVE NE, ATLANTA, GA, 30308',
      matchedAddress: '675 PONCE DE LEON AVE NE, ATLANTA, GA, 30308',
      stateAbbr: 'GA',
    },
    answered: true,
  };
  const net = fakeFetch({ photon: { 'Atlanta, GA': [ATLANTA] } });
  const original = fakeOriginal({
    '675 Ponce de Leon Ave NE, Atlanta, GA': match,
  });
  const geocode = createUsFirstGeocode(original.fn, { fetchImpl: net.impl });
  const outcome = await geocode('675 Ponce de Leon Ave NE, Atlanta, GA');
  assert.equal(outcome.place, match.place);
  assert.equal(outcome.cre.cityMismatch, null);
  assert.equal(outcome.cre.approximate, '');
});

test('S4: a full "Street, City, ST ZIP" address resolves the cheap check without a Photon round trip', async () => {
  const match = {
    place: {
      lat: 33.7719,
      lng: -84.3654,
      label: '675 PONCE DE LEON AVE NE, ATLANTA, GA, 30308',
      matchedAddress: '675 PONCE DE LEON AVE NE, ATLANTA, GA, 30308',
      stateAbbr: 'GA',
      city: 'Atlanta',
    },
    answered: true,
  };
  const net = fakeFetch({ photon: {} });
  const original = fakeOriginal({
    '675 Ponce de Leon Ave NE, Atlanta, GA 30308': match,
  });
  const geocode = createUsFirstGeocode(original.fn, { fetchImpl: net.impl });
  const outcome = await geocode('675 Ponce de Leon Ave NE, Atlanta, GA 30308');
  assert.equal(outcome.place, match.place);
  assert.equal(outcome.cre.cityMismatch, null);
  assert.equal(
    net.calls.some((u) => u.includes('photon.komoot.io')),
    false,
    'the ZIP-stripped cheap check must resolve without ever calling Photon',
  );
});

test('S4: when the cheap check disagrees and Photon is unreachable, fail CLOSED (a warning, never a silent build)', async () => {
  const georgetown = {
    place: {
      lat: 30.6333,
      lng: -97.6772,
      label: '101 MAIN ST, GEORGETOWN, TX, 78626',
      matchedAddress: '101 MAIN ST, GEORGETOWN, TX, 78626',
      stateAbbr: 'TX',
    },
    answered: true,
  };
  const net = {
    impl: async () => {
      throw new Error('network down');
    },
    calls: [],
  };
  const original = fakeOriginal({
    '101 Main St, Marfa TX': georgetown,
  });
  const geocode = createUsFirstGeocode(original.fn, { fetchImpl: net.impl });
  const outcome = await geocode('101 Main St, Marfa TX');
  assert.equal(outcome.place, null, 'never silently build for the wrong city');
  assert.ok(outcome.cre.cityMismatch, 'a warning must be reported');
  assert.equal(outcome.cre.cityMismatch.unresolved, true);
  assert.equal(outcome.cre.cityMismatch.milesOff, null);
  assert.deepEqual(
    outcome.cre.cityMismatch.matchedPlace,
    {
      lat: 30.6333,
      lng: -97.6772,
      label: '101 MAIN ST, GEORGETOWN, TX, 78626',
    },
    'N-2: an unresolved check keeps the original match so the caller can offer "use this pin anyway"',
  );
});

test('city-mismatch: no comma to parse a typed city from means no check runs (a run-on address builds normally)', async () => {
  const match = {
    place: {
      lat: 30.6333,
      lng: -97.6772,
      label: '101 MAIN ST, GEORGETOWN, TX, 78626',
      matchedAddress: '101 MAIN ST, GEORGETOWN, TX, 78626',
      stateAbbr: 'TX',
    },
    answered: true,
  };
  const net = fakeFetch();
  const original = fakeOriginal({ '101 Main St Marfa TX': match });
  const geocode = createUsFirstGeocode(original.fn, { fetchImpl: net.impl });
  const outcome = await geocode('101 Main St Marfa TX');
  assert.equal(outcome.place, match.place);
  assert.equal(outcome.cre.cityMismatch, null);
});

test('broadcast stations and other telecom infrastructure never appear as alternates', async () => {
  const net = fakeFetch({
    photon: {
      '350 5th Ave, New York, NY': [
        feature('WNEW-FM', 40.7484, -73.9857, {
          city: 'New York',
          state: 'New York',
        }),
        feature('WCBS-FM', 40.7484, -73.9857, {
          city: 'New York',
          state: 'New York',
        }),
        feature('WQXR-FM', 40.7484, -73.9857, {
          city: 'New York',
          state: 'New York',
        }),
        feature('Empire State Building', 40.7484, -73.9857, {
          city: 'New York',
          state: 'New York',
          type: 'house',
        }),
      ],
    },
  });
  const geocode = createUsFirstGeocode(fakeOriginal({}).fn, {
    fetchImpl: net.impl,
  });
  const outcome = await geocode('350 5th Ave, New York, NY');
  assert.ok(outcome.place, 'still finds a place');
  assert.equal(outcome.place.name, 'Empire State Building');
  assert.deepEqual(
    outcome.cre.others,
    [],
    'no radio or TV call signs among the alternates',
  );
});

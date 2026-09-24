/** US Census address geocoder: address-level points for US street addresses, which Photon only resolves to a road. */

/**
 * Same-origin proxy route. The Census service sends no CORS headers, so the
 * browser cannot call it directly; the dev/preview server relays it
 * (server/providers/census.js).
 */
const CENSUS_PROXY_ENDPOINT = '/api/census-geocode';

/** Census answers in 1 to 3 s; past this, Photon gets its turn instead. */
const CENSUS_TIMEOUT_MS = 6000;

const CENSUS_CACHE_MAX = 64;

/** Same-origin bare-earth terrain route (server/providers/terrain.js). */
const GROUND_ENDPOINT = '/api/terrain/heights';

/** Ground lookup is best effort; a slow one must not hold the flight. */
const GROUND_TIMEOUT_MS = 4000;

/**
 * Camera range for an address. At the no-building pitch of -25 degrees this
 * puts the camera about 330 m above the ground, an oblique whole-site view,
 * rather than the 250 m single-building default.
 */
const ADDRESS_VIEW_RANGE_M = 700;

/** USPS state and territory abbreviations the Census benchmark covers. */
const US_STATE_CODES = new Set(
  (
    'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN ' +
    'MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA ' +
    'WV WI WY PR GU VI AS MP'
  ).split(' '),
);

const US_STATE_NAMES = new Set([
  'alabama',
  'alaska',
  'arizona',
  'arkansas',
  'california',
  'colorado',
  'connecticut',
  'delaware',
  'district of columbia',
  'florida',
  'georgia',
  'hawaii',
  'idaho',
  'illinois',
  'indiana',
  'iowa',
  'kansas',
  'kentucky',
  'louisiana',
  'maine',
  'maryland',
  'massachusetts',
  'michigan',
  'minnesota',
  'mississippi',
  'missouri',
  'montana',
  'nebraska',
  'nevada',
  'new hampshire',
  'new jersey',
  'new mexico',
  'new york',
  'north carolina',
  'north dakota',
  'ohio',
  'oklahoma',
  'oregon',
  'pennsylvania',
  'rhode island',
  'south carolina',
  'south dakota',
  'tennessee',
  'texas',
  'utah',
  'vermont',
  'virginia',
  'washington',
  'west virginia',
  'wisconsin',
  'wyoming',
  'puerto rico',
]);

/** Street-type words (USPS suffixes and their spelled-out forms). */
const STREET_SUFFIXES = new Set(
  (
    'st street ave av avenue blvd boulevard rd road dr drive ln lane way ct ' +
    'court pl place pkwy parkway hwy highway cir circle ter terrace trl trail ' +
    'pike loop run sq square plz plaza aly alley xing crossing expy expressway ' +
    'fwy freeway tpke turnpike byp bypass row walk path pass cv cove pt point ' +
    'bnd bend crk creek hl hill hts heights holw hollow jct junction mnr manor ' +
    'rdg ridge vw view vly valley'
  ).split(' '),
);

/**
 * A leading house number ("1109", "221B", "12-14") followed by a street
 * word. The street word may start with a letter ("Main") or be a numbered
 * street's ordinal ("5th", "42nd", "3rd", "1st"): without the ordinal
 * alternative, "350 5th Ave" fails this test entirely (the second token
 * starts with a digit), so numbered-street addresses skipped Census and
 * went straight to Photon place search.
 */
const HOUSE_NUMBER_STREET =
  /^\d{1,6}[a-z]?(?:-\d{1,6}[a-z]?)?\s+(?:[a-z]|\d+(?:st|nd|rd|th)\b)/i;

const ZIP_CODE = /^\d{5}(?:-\d{4})?$/;

/** Lowercase words of one segment, with trailing periods dropped ("Ave." -> "ave"). */
function words(segment) {
  return segment
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/\.+$/, ''))
    .filter(Boolean);
}

/** True when the query's tail is a US state and/or ZIP ("..., TN", "..., Georgia 30308", "... 37604"). */
function endsInUsStateOrZip(segments) {
  const tail = words(segments[segments.length - 1]);
  if (!tail.length) return false;
  if (ZIP_CODE.test(tail[tail.length - 1])) tail.pop();
  if (!tail.length) return true;
  if (US_STATE_CODES.has(tail[tail.length - 1].toUpperCase())) return true;
  return [1, 2, 3].some((count) =>
    US_STATE_NAMES.has(tail.slice(-count).join(' ')),
  );
}

/**
 * Whether a free-text query reads as a US street address worth asking Census.
 *
 * Requires a leading house number plus a street name, and then either a
 * street-type word in that first segment ("Pkwy", "Ave") or a US state / ZIP
 * at the end. A bare city ("Atlanta", "Atlanta, GA"), a name ("City Hall") or a
 * coordinate never qualifies, so landmark and city searches cost no Census
 * round trip and go straight to Photon.
 * @param {string} query
 * @returns {boolean}
 */
export function looksLikeUsStreetAddress(query) {
  const text = String(query ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 6 || text.length > 200) return false;
  const segments = text
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!segments.length || !HOUSE_NUMBER_STREET.test(segments[0])) return false;
  const street = words(segments[0]).slice(1);
  if (street.some((word) => STREET_SUFFIXES.has(word))) return true;
  return segments.length > 1 && endsInUsStateOrZip(segments);
}

/**
 * The point-level place a Census match resolves to. Same shape the rest of the
 * search chain returns, plus the Census identifiers later packages read.
 * @typedef {object} CensusPlace
 * @property {number} lat - Interpolated address point latitude (WGS84).
 * @property {number} lng - Interpolated address point longitude (WGS84).
 * @property {string} name - Census matched address, e.g. "601 E MAIN ST, JOHNSON CITY, TN, 37601".
 * @property {string} label - Same as `name`; shown in the search box.
 * @property {string[]} types - Always ['street_address'], which frames as a precise place.
 * @property {true} exact - The point is the answer; nearby Places recovery must not replace it.
 * @property {null} viewport - Point result; no extent to frame.
 * @property {'census'} geocoder - Which provider answered.
 * @property {string} matchedAddress - Census `matchedAddress`, the standardized USPS-style address.
 * @property {?string} tractGeoid - 11-digit census tract GEOID (state+county+tract), e.g. "47179060902"; null if Census omitted geographies.
 * @property {?string} countyGeoid - 5-digit county FIPS GEOID, e.g. "47179"; null if omitted.
 * @property {?string} stateAbbr - USPS state code from the match, e.g. "TN"; null if omitted.
 * @property {?string} city - Matched city as Census reports it, e.g. "JOHNSON CITY"; null if omitted.
 * @property {number} viewRangeM - Camera range the flight should use for this point (site-scale oblique view).
 * @property {?number} groundElevation - Bare-earth height at the point, metres above the WGS84 ellipsoid; null if the terrain lookup failed. Without it the flight aims at ellipsoid height 0, which is underground anywhere inland (an Appalachian-plateau test site can sit at ~500 m).
 */

/**
 * Raw Census `geographies/onelineaddress` JSON -> a CensusPlace, or null when
 * the response holds no usable match.
 * @param {object} data - Parsed Census response.
 * @returns {?CensusPlace}
 */
export function normalizeCensusResponse(data) {
  const match = data?.result?.addressMatches?.[0];
  const lng = Number(match?.coordinates?.x);
  const lat = Number(match?.coordinates?.y);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const matchedAddress = String(match.matchedAddress || '').trim();
  const geographies = match.geographies || {};
  const geoid = (layer) => {
    const value = geographies[layer]?.[0]?.GEOID;
    return value ? String(value) : null;
  };
  const components = match.addressComponents || {};
  const stateAbbr =
    String(components.state || geographies.States?.[0]?.STUSAB || '') || null;
  const city = String(components.city || '') || null;
  return {
    lat,
    lng,
    name: matchedAddress,
    label: matchedAddress,
    types: ['street_address'],
    exact: true,
    viewport: null,
    geocoder: 'census',
    matchedAddress,
    tractGeoid: geoid('Census Tracts'),
    countyGeoid: geoid('Counties'),
    stateAbbr,
    city,
    viewRangeM: ADDRESS_VIEW_RANGE_M,
    groundElevation: null,
  };
}

/**
 * Ellipsoidal ground height at one point from the terrain route, or null.
 * @returns {Promise<?number>}
 */
async function groundElevationAt(place, { fetchImpl, endpoint, signal }) {
  try {
    const deadline = AbortSignal.timeout(GROUND_TIMEOUT_MS);
    const response = await fetchImpl(
      `${endpoint}?points=${place.lng.toFixed(5)},${place.lat.toFixed(5)}`,
      { signal: signal ? AbortSignal.any([signal, deadline]) : deadline },
    );
    if (!response.ok) return null;
    const height = Number((await response.json())?.results?.[0]?.ellipsoid);
    return Number.isFinite(height) ? height : null;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

/** Evict the oldest memo entries until the cache is within its cap. */
function trimCache(cache) {
  while (cache.size > CENSUS_CACHE_MAX) cache.delete(cache.keys().next().value);
}

/**
 * Construct the Census provider for `createPlaceSearch`.
 *
 * Declines anything that is not a US street address with `answered: true` and
 * no request. A Census "no match" is also `answered: true`, so the chain moves
 * on to Photon; a network failure, timeout or malformed body is
 * `answered: false`, which moves on to Photon too but keeps the miss out of
 * every cache. Caller cancellation throws.
 * A match is then given its ground height (best effort, see
 * `groundElevation`), so the flight frames it above the terrain.
 * @param {{fetchImpl?: Function, endpoint?: string, groundEndpoint?: string}} [options]
 */
export function createCensusGeocoder({
  fetchImpl = (...args) => fetch(...args),
  endpoint = CENSUS_PROXY_ENDPOINT,
  groundEndpoint = GROUND_ENDPOINT,
} = {}) {
  const cache = new Map();
  return {
    /** @returns {Promise<{place: ?CensusPlace, answered: boolean}>} */
    async geocode(query, { signal } = {}) {
      signal?.throwIfAborted();
      const text = String(query ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!looksLikeUsStreetAddress(text))
        return { place: null, answered: true };
      const key = text.toLowerCase();
      const cached = cache.get(key);
      if (cached && cached.expires > Date.now())
        return { place: cached.place, answered: true };
      cache.delete(key);
      let place;
      try {
        const deadline = AbortSignal.timeout(CENSUS_TIMEOUT_MS);
        const requestSignal = signal
          ? AbortSignal.any([signal, deadline])
          : deadline;
        const response = await fetchImpl(
          `${endpoint}?${new URLSearchParams({ address: text })}`,
          { signal: requestSignal },
        );
        if (!response.ok) return { place: null, answered: false };
        const data = await response.json();
        if (!Array.isArray(data?.result?.addressMatches))
          return { place: null, answered: false };
        place = normalizeCensusResponse(data);
      } catch {
        signal?.throwIfAborted();
        return { place: null, answered: false };
      }
      if (place)
        place.groundElevation = await groundElevationAt(place, {
          fetchImpl,
          endpoint: groundEndpoint,
          signal,
        });
      cache.set(key, {
        place,
        expires: Date.now() + (place ? 3_600_000 : 60_000),
      });
      trimCache(cache);
      return { place, answered: true };
    },
  };
}

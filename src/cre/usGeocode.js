// US-first place lookup for CRE mode: ZIP codes resolve to the Census ZIP code center, PO Boxes to their ZIP, names to the most prominent US match, anything that is not a Census street match is labeled approximate, and places outside the US are refused.
import {
  normalizePhotonFeature,
  normalizeToponym,
} from '../keylessGeocoder.js';
import { parseCoordinateQuery } from '../search/coordinateParser.js';
import { looksLikeUsStreetAddress } from '../search/censusGeocoder.js';
import { haversineMeters } from './geo.js';

/** Photon hard filter box: the states, Alaska, Hawaii, Puerto Rico, USVI. Results are also filtered on countrycode US. */
export const US_BBOX = Object.freeze([-179.9, 17.5, -64.0, 71.6]);
export const ZCTA_LAYER =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/1/query';
/** TIGERweb States, layer 0 of State_County: the authoritative "is this point in a US state or territory" test. */
export const STATES_LAYER =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0/query';
export const PHOTON_ENDPOINT = 'https://photon.komoot.io/api/';
const TIMEOUT_MS = 8000;

/**
 * Coarse US boxes, a cheap pre-filter only (w, s, e, n). Box 1 holds Toronto,
 * Windsor, Montreal and northern Mexico, so a point inside it is NOT known to
 * be in the US: `usStateAt` settles that against TIGERweb (B-S2-1). A point
 * outside every box is refused without a network call.
 */
const US_BOXES = Object.freeze([
  [-125.0, 24.4, -66.9, 49.4],
  [-179.9, 51.2, -129.9, 71.6],
  [-160.6, 18.8, -154.7, 22.4],
  [-67.3, 17.6, -64.5, 18.6],
]);

/** USPS abbreviation to state name, for reading a US signal out of a query and for scoring Photon candidates. */
export const US_STATES = Object.freeze({
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  PR: 'Puerto Rico',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  VI: 'U.S. Virgin Islands',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
});

/**
 * Country names that name a place outside the US. "Georgia" is left out
 * because it is a US state, and a trailing "Mexico" preceded by "New" is
 * ignored below for the same reason.
 */
export const FOREIGN_COUNTRIES = Object.freeze([
  'afghanistan',
  'albania',
  'algeria',
  'argentina',
  'armenia',
  'australia',
  'austria',
  'azerbaijan',
  'bahamas',
  'bahrain',
  'bangladesh',
  'barbados',
  'belarus',
  'belgium',
  'belize',
  'bolivia',
  'bosnia',
  'botswana',
  'brazil',
  'bulgaria',
  'cambodia',
  'cameroon',
  'canada',
  'chile',
  'china',
  'colombia',
  'costa rica',
  'croatia',
  'cuba',
  'cyprus',
  'czechia',
  'czech republic',
  'denmark',
  'dominican republic',
  'ecuador',
  'egypt',
  'el salvador',
  'england',
  'estonia',
  'ethiopia',
  'finland',
  'france',
  'germany',
  'ghana',
  'great britain',
  'greece',
  'guatemala',
  'haiti',
  'holland',
  'honduras',
  'hong kong',
  'hungary',
  'iceland',
  'india',
  'indonesia',
  'iran',
  'iraq',
  'ireland',
  'israel',
  'italy',
  'jamaica',
  'japan',
  'jordan',
  'kazakhstan',
  'kenya',
  'kuwait',
  'latvia',
  'lebanon',
  'libya',
  'lithuania',
  'luxembourg',
  'malaysia',
  'mexico',
  'morocco',
  'nepal',
  'netherlands',
  'new zealand',
  'nicaragua',
  'nigeria',
  'north korea',
  'northern ireland',
  'norway',
  'oman',
  'pakistan',
  'panama',
  'paraguay',
  'peru',
  'philippines',
  'poland',
  'portugal',
  'qatar',
  'romania',
  'russia',
  'saudi arabia',
  'scotland',
  'senegal',
  'serbia',
  'singapore',
  'slovakia',
  'slovenia',
  'south africa',
  'south korea',
  'spain',
  'sri lanka',
  'sweden',
  'switzerland',
  'syria',
  'taiwan',
  'tanzania',
  'thailand',
  'tunisia',
  'turkey',
  'uae',
  'uganda',
  'uk',
  'ukraine',
  'united arab emirates',
  'united kingdom',
  'uruguay',
  'uzbekistan',
  'venezuela',
  'vietnam',
  'wales',
  'zambia',
  'zimbabwe',
]);

const ZIP_ONLY =
  /^\s*(\d{5})(?:-\d{4})?\s*(?:,?\s*(?:usa?|united states))?\s*$/i;
const PO_BOX = /\b(?:p\.?\s*o\.?\s*box|post\s+office\s+box)\b/i;
const TRAILING_ZIP =
  /\b(\d{5})(?:-\d{4})?\s*(?:,?\s*(?:usa?|united states))?\s*$/i;
const US_LABEL = /,\s*(?:united states(?: of america)?|usa?)\s*$/i;

/**
 * What kind of query this is.
 * @param {string} text
 * @returns {{kind:'zip', zip:string} | {kind:'pobox', zip:string|null} | {kind:'coords'} | {kind:'other'}}
 */
export function classifyQuery(text) {
  const query = String(text ?? '').trim();
  const zipOnly = ZIP_ONLY.exec(query);
  if (zipOnly) return { kind: 'zip', zip: zipOnly[1] };
  if (PO_BOX.test(query)) {
    const zip = TRAILING_ZIP.exec(query);
    return { kind: 'pobox', zip: zip ? zip[1] : null };
  }
  if (parseCoordinateQuery(query)) return { kind: 'coords' };
  return { kind: 'other' };
}

/** True when a point sits inside the coarse US boxes. Necessary, never sufficient: see `usStateAt`. */
export function inUsBoxes(lat, lng) {
  return US_BOXES.some(
    ([w, s, e, n]) => lng >= w && lng <= e && lat >= s && lat <= n,
  );
}

/** Lowercase, unaccented, punctuation to single spaces. Same shape as normalizeToponym. */
const norm = (text) =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const STATE_NAMES = new Set(Object.values(US_STATES).map((n) => norm(n)));
const STATE_ABBRS = new Set(Object.keys(US_STATES).map((a) => a.toLowerCase()));

/**
 * Does the query itself claim a US location? A state name anywhere, a trailing
 * USPS abbreviation, a trailing ZIP, or "USA". Any of these vetoes the
 * outside-US path, so "Toronto, IA" and "Athens GA" stay US lookups (B2-01).
 * @param {string} text
 */
export function hasUsSignal(text) {
  const query = norm(text);
  if (!query) return false;
  if (/\b(?:usa|united states(?: of america)?)\b/.test(query)) return true;
  if (/\b\d{5}(?: \d{4})?$/.test(query)) return true;
  for (const name of STATE_NAMES) {
    if (query === name || query.includes(` ${name}`)) return true;
  }
  // A bare two-letter token is only a state when it ends the query (possibly
  // before a ZIP): "Portland OR" yes, "Harbor or Bay" no.
  const tokens = query.split(' ');
  const tail = /^\d{5}$|^\d{4}$/.test(tokens.at(-1) ?? '')
    ? tokens.at(-2)
    : tokens.at(-1);
  return tokens.length > 1 && STATE_ABBRS.has(String(tail));
}

/**
 * A country named at the end of the query, e.g. "Tokyo Japan". Trailing only,
 * and never on a one-word query, so "Lebanon" and "Cuba" (both US towns) do
 * not trip it; "New Mexico" is excluded by name.
 * @param {string} text
 * @returns {string} The country as typed, or ''.
 */
export function foreignCountryInQuery(text) {
  const query = norm(text);
  const tokens = query.split(' ').filter(Boolean);
  if (tokens.length < 2) return '';
  for (const country of FOREIGN_COUNTRIES) {
    if (query !== country && query.endsWith(` ${country}`)) {
      if (country === 'mexico' && / new mexico$/.test(query)) continue;
      return country.replace(/\b[a-z]/g, (c) => c.toUpperCase());
    }
  }
  return '';
}

/**
 * OSM tags for broadcast and telecom infrastructure: a radio/TV transmitter
 * or studio is not a place a site search should ever offer as an
 * alternate. `key=*` matches any value for that key.
 */
const BROADCAST_OSM_TAGS = Object.freeze(
  new Set([
    'man_made=mast',
    'man_made=communications_tower',
    'man_made=tower',
    'broadcast=*',
    'telecom=*',
    'office=telecommunication',
  ]),
);

/** US broadcast call signs: 3-4 letters starting K/W, optionally with -FM/-AM/-TV. */
const CALL_SIGN = /^[KW][A-Z]{2,3}(?:-(?:FM|AM|TV|HD\d?))?$/;

/**
 * Is this Photon feature a radio/TV station or other broadcast/telecom
 * infrastructure rather than a place? Filtered out of both the chosen
 * candidate and the alternates list (B3: "350 5th Ave" offered
 * WNEW-FM/WCBS-FM/WQXR-FM as alternates to the Empire State Building).
 * @param {object} feature Raw Photon feature.
 */
export function isBroadcastFeature(feature) {
  const properties = feature?.properties || {};
  const key = String(properties.osm_key || '');
  const value = String(properties.osm_value || '');
  if (
    BROADCAST_OSM_TAGS.has(`${key}=${value}`) ||
    BROADCAST_OSM_TAGS.has(`${key}=*`)
  )
    return true;
  const name = String(properties.name || '').trim();
  return CALL_SIGN.test(name);
}

/** Two place names that answer each other: equal, or one leads the other. */
export function namesAnswer(head, name) {
  if (!head || !name) return false;
  return (
    head === name || head.startsWith(`${name} `) || name.startsWith(`${head} `)
  );
}

/**
 * Is this point inside a US state or territory? A single TIGERweb point query,
 * the same service the tract lookups already depend on.
 * @returns {Promise<{inUs:boolean|null, state:string, answered:boolean}>}
 */
export async function usStateAt(lat, lon, { fetchImpl = fetch, signal } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon))
    return { inUs: null, state: '', answered: true };
  if (!inUsBoxes(lat, lon)) return { inUs: false, state: '', answered: true };
  const url = new URL(STATES_LAYER);
  url.searchParams.set('geometry', `${lon},${lat}`);
  url.searchParams.set('geometryType', 'esriGeometryPoint');
  url.searchParams.set('inSR', '4326');
  url.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
  url.searchParams.set('outFields', 'STUSAB,NAME');
  url.searchParams.set('returnGeometry', 'false');
  url.searchParams.set('f', 'json');
  let body;
  try {
    body = await getJson(url.toString(), { fetchImpl, signal });
  } catch {
    signal?.throwIfAborted();
    return { inUs: null, state: '', answered: false };
  }
  if (body?.error) return { inUs: null, state: '', answered: false };
  const attributes = body?.features?.[0]?.attributes;
  const state = String(attributes?.STUSAB ?? '').toUpperCase();
  return { inUs: Boolean(state), state, answered: true };
}

/** Census matched the street address itself (it only answers inside the US). */
export const isStreetMatch = (place) => Boolean(place?.matchedAddress);

async function getJson(url, { fetchImpl, signal }) {
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const response = await fetchImpl(url, { signal: combined });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * The Census ZIP Code Tabulation Area internal point for a five digit ZIP.
 * ZCTAs approximate USPS ZIPs; a PO Box only ZIP has no ZCTA and no match.
 * @returns {Promise<{place: object|null, answered: boolean}>}
 */
export async function zipCenter(zip, { fetchImpl = fetch, signal } = {}) {
  if (!/^\d{5}$/.test(String(zip))) return { place: null, answered: true };
  const url = new URL(ZCTA_LAYER);
  url.searchParams.set('where', `ZCTA5='${zip}'`);
  url.searchParams.set('outFields', 'ZCTA5,INTPTLAT,INTPTLON');
  url.searchParams.set('returnGeometry', 'false');
  url.searchParams.set('f', 'json');
  let body;
  try {
    body = await getJson(url.toString(), { fetchImpl, signal });
  } catch (error) {
    signal?.throwIfAborted();
    return { place: null, answered: false };
  }
  const attributes = body?.features?.[0]?.attributes;
  const lat = Number(attributes?.INTPTLAT);
  const lng = Number(attributes?.INTPTLON);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inUsBoxes(lat, lng))
    return { place: null, answered: !body?.error };
  return {
    place: {
      lat,
      lng,
      name: `ZIP ${zip}`,
      label: `ZIP ${zip}`,
      zip: String(zip),
      types: ['postal_code'],
      viewport: null,
    },
    answered: true,
  };
}

/**
 * Score one US Photon candidate against the query. The name the user typed
 * counts most, then the state the query names, then the city. Without this,
 * a substring match let "Portland OR" land on "Portland Oregon Temple" and
 * "City Hall Johnson City" on a Howard Johnson in New Jersey (B2-05).
 * @param {object} feature Raw Photon feature.
 * @param {{head:string, full:string, states:Set<string>}} q
 */
export function scoreUsFeature(feature, q) {
  const properties = feature?.properties || {};
  const name = norm(properties.name);
  const city = norm(properties.city);
  const state = norm(properties.state);
  let score = 0;
  if (name && name === q.head) score += 5;
  else if (name && q.head.startsWith(`${name} `)) score += 4;
  else if (name && name.startsWith(`${q.head} `)) score += 2;
  else if (name && q.head && name.includes(q.head)) score += 1;
  if (state && q.states.has(state)) score += 3;
  if (city && q.full.includes(city)) score += 2;
  // A named settlement answers a place query better than a business inside it.
  if (
    name === q.head &&
    /^(?:city|town|village|locality|district)$/.test(
      String(properties.type || ''),
    )
  )
    score += 1;
  return score;
}

/** The state names a query points at, from full names and a trailing USPS abbreviation. */
export function statesInQuery(text) {
  const query = norm(text);
  const found = new Set();
  for (const name of STATE_NAMES) {
    if (query === name || query.includes(` ${name}`)) found.add(name);
  }
  const tokens = query.split(' ').filter(Boolean);
  const tail = /^\d{4,5}$/.test(tokens.at(-1) ?? '')
    ? tokens.at(-2)
    : tokens.at(-1);
  if (tokens.length > 1 && STATE_ABBRS.has(String(tail))) {
    found.add(norm(US_STATES[String(tail).toUpperCase()]));
  }
  return found;
}

/**
 * Photon limited to the US: hard box plus countrycode US, no view bias. The
 * candidates are re-ranked by `scoreUsFeature`; Photon's own order, which puts
 * the most prominent place first, breaks ties.
 * @returns {Promise<{place: object|null, answered: boolean, others: string[]}>}
 */
export async function photonUs(query, { fetchImpl = fetch, signal } = {}) {
  const url = new URL(PHOTON_ENDPOINT);
  url.searchParams.set('q', String(query ?? '').trim());
  url.searchParams.set('limit', '10');
  url.searchParams.set('lang', 'en');
  url.searchParams.set('bbox', US_BBOX.join(','));
  let body;
  try {
    body = await getJson(url.toString(), { fetchImpl, signal });
  } catch {
    signal?.throwIfAborted();
    return { place: null, answered: false, others: [] };
  }
  const us = (Array.isArray(body?.features) ? body.features : []).filter(
    (feature) =>
      String(feature?.properties?.countrycode || '').toUpperCase() === 'US' &&
      normalizePhotonFeature(feature) &&
      !isBroadcastFeature(feature),
  );
  if (!us.length) return { place: null, answered: true, others: [] };
  const head = normalizeToponym(String(query).split(',')[0]);
  const q = { head, full: norm(query), states: statesInQuery(query) };
  const ranked = us
    .map((feature, index) => ({
      feature,
      index,
      score: scoreUsFeature(feature, q),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen = ranked[0].score > 0 ? ranked[0].feature : us[0];
  const place = normalizePhotonFeature(chosen);
  const chosenProperties = chosen.properties || {};
  place.city = String(chosenProperties.city || chosenProperties.name || '');
  place.state = String(chosenProperties.state || '');
  const others = ranked
    .map((entry) => entry.feature)
    .filter((feature) => feature !== chosen)
    .map((feature) => normalizePhotonFeature(feature).label)
    .filter((label) => label && label !== place.label)
    .slice(0, 3);
  return { place, answered: true, others };
}

/**
 * Photon with no country filter, used only to ask "does the world geocoder
 * think this query names a place outside the US?". A non-US result ranked
 * above every US one, whose name answers what was typed, is the signal
 * (B2-01: "Toronto" is Toronto, Ontario, not Toronto, Iowa).
 * @returns {Promise<{top: object|null, foreign: boolean, label: string, answered: boolean}>}
 */
export async function photonWorld(query, { fetchImpl = fetch, signal } = {}) {
  const url = new URL(PHOTON_ENDPOINT);
  url.searchParams.set('q', String(query ?? '').trim());
  url.searchParams.set('limit', '6');
  url.searchParams.set('lang', 'en');
  let body;
  try {
    body = await getJson(url.toString(), { fetchImpl, signal });
  } catch {
    signal?.throwIfAborted();
    return { top: null, foreign: false, label: '', answered: false };
  }
  const features = (Array.isArray(body?.features) ? body.features : []).filter(
    (feature) => normalizePhotonFeature(feature),
  );
  const top = features[0] || null;
  if (!top) return { top: null, foreign: false, label: '', answered: true };
  const cc = String(top.properties?.countrycode || '').toUpperCase();
  const head = normalizeToponym(String(query).split(',')[0]);
  const foreign =
    cc !== '' && cc !== 'US' && namesAnswer(head, norm(top.properties?.name));
  return {
    top,
    foreign,
    label: normalizePhotonFeature(top)?.label || '',
    answered: true,
  };
}

/** Honest header line for a place that is not a street address match. */
export function approximateNote(what) {
  return `Approximate match: ${what}, not a street address`;
}

const METERS_PER_MILE = 1609.344;
/** A matched point over this far from the typed city's centroid is treated
 * as a wrong-city match, never as "close enough" (Marfa/Georgetown, 379 mi). */
export const CITY_MISMATCH_MILES = 25;

/**
 * The "city, state" (or "city") tail of a street-shaped query: everything
 * after the first comma. Empty when the query has no comma, which is a
 * deliberate no-op: a run-on address with no separator ("675 Ponce de Leon
 * Ave NE Atlanta") is left unchecked rather than guessed at.
 * @param {string} text
 */
export function cityTailOfQuery(text) {
  const parts = String(text ?? '').split(',');
  if (parts.length < 2) return '';
  return parts.slice(1).join(',').trim();
}

/** Normalized US state name a place claims, from a Census `stateAbbr` or a Photon `state`. */
function placeStateName(place) {
  if (!place) return '';
  if (place.stateAbbr) return norm(US_STATES[String(place.stateAbbr)] || '');
  if (place.state) return norm(place.state);
  return '';
}

/** The matched place's city: a Census/Photon `city` field, else parsed out of `matchedAddress` ("STREET, CITY, ST, ZIP"). */
function matchedCityName(place) {
  if (place?.city) return String(place.city);
  const segment = String(place?.matchedAddress || '').split(',')[1];
  return segment ? segment.trim() : '';
}

/** Normalized text with a trailing US state (abbreviation or full name) removed. */
function stripTrailingState(text) {
  const query = norm(text);
  const tokens = query.split(' ').filter(Boolean);
  if (tokens.length > 1 && STATE_ABBRS.has(tokens.at(-1)))
    return tokens.slice(0, -1).join(' ');
  for (const count of [3, 2, 1]) {
    if (tokens.length <= count) continue;
    if (STATE_NAMES.has(tokens.slice(-count).join(' ')))
      return tokens.slice(0, -count).join(' ');
  }
  return query;
}

/**
 * S4: normalized text with a trailing ZIP removed, so a ZIP-bearing city
 * tail ("Atlanta, GA 30308") strips down to "atlanta ga" (then, via
 * `stripTrailingState`, "atlanta") instead of staying "atlanta ga 30308" --
 * which never equals a matched city name and forces every full street
 * address into an avoidable Photon round trip. `norm` turns a ZIP+4's
 * hyphen into a space ("30308-1234" -> "30308 1234"), so both trailing
 * numeric tokens are checked.
 */
function stripTrailingZip(text) {
  const query = norm(text);
  const tokens = query.split(' ').filter(Boolean);
  if (
    tokens.length > 2 &&
    /^\d{4}$/.test(tokens.at(-1) ?? '') &&
    /^\d{5}$/.test(tokens.at(-2) ?? '')
  ) {
    return tokens.slice(0, -2).join(' ');
  }
  if (tokens.length > 1 && /^\d{5}$/.test(tokens.at(-1) ?? '')) {
    return tokens.slice(0, -1).join(' ');
  }
  return query;
}

/**
 * Compare a street-shaped query's typed city/state against where it actually
 * matched. A cheap name comparison (no network) settles the common case
 * where the match is exactly the city the user typed; only a genuine
 * disagreement pays for an independent geocode of the typed city, whose
 * distance to the match is what actually proves a wrong-city match (a
 * nonexistent "101 Main St, Marfa TX" still names a real state, TX, that the
 * wrong-city match, Georgetown TX, also sits in — only distance catches it).
 * @returns {Promise<null|{milesOff:number, cityCenter:object}>} null when the
 *   match checks out (or the check could not be run); otherwise the mismatch.
 */
async function checkCityMatch(query, matchedPlace, { fetchImpl, signal }) {
  const cityTail = cityTailOfQuery(query);
  if (!cityTail) return null;
  // S4: strip a trailing ZIP before the state check, so the cheap
  // name comparison actually resolves for a full "Street, City, ST ZIP"
  // address instead of always falling through to a Photon round trip.
  const typedCityNorm = stripTrailingState(stripTrailingZip(cityTail));
  const matchedCityNorm = norm(matchedCityName(matchedPlace));
  const typedState = statesInQuery(cityTail);
  const matchedState = placeStateName(matchedPlace);
  const namesAgree =
    Boolean(typedCityNorm) && typedCityNorm === matchedCityNorm;
  const statesAgree =
    !typedState.size || !matchedState || typedState.has(matchedState);
  if (namesAgree && statesAgree) return null;

  const cityResult = await photonUs(cityTail, { fetchImpl, signal });
  // S4: fail CLOSED when the independent check cannot run at all (Photon
  // unreachable) -- the cheap check already disagreed, so silently building
  // here means shipping data for a possibly wrong city with no warning.
  if (!cityResult.answered) return { unresolved: true };
  if (!cityResult.place) return null;
  const stateDiffers =
    typedState.size > 0 && matchedState && !typedState.has(matchedState);
  const milesOff =
    haversineMeters(
      cityResult.place.lat,
      cityResult.place.lng,
      matchedPlace.lat,
      matchedPlace.lng,
    ) / METERS_PER_MILE;
  if (stateDiffers || milesOff > CITY_MISMATCH_MILES) {
    return { milesOff: Math.round(milesOff), cityCenter: cityResult.place };
  }
  return null;
}

/**
 * Wrap a place search so CRE lookups are US-first. The wrapped geocode
 * returns the usual { place, answered } and adds `cre` to the outcome:
 * { approximate: string, outsideUs: string, others: string[] }.
 * @param {(query:string, options:object) => Promise<{place:object|null, answered:boolean}>} original
 * @param {{fetchImpl?: Function}} [deps]
 */
export function createUsFirstGeocode(original, { fetchImpl = fetch } = {}) {
  return async function usFirstGeocode(query, options = {}) {
    const signal = options.signal;
    const text = String(query ?? '').trim();
    const kind = classifyQuery(text);
    const done = (outcome, cre = {}) => ({
      ...outcome,
      cre: {
        approximate: '',
        outsideUs: '',
        others: [],
        cityMismatch: null,
        ...cre,
      },
    });
    /**
     * A matched point that lands somewhere other than the city/state the
     * query named (Marfa/Georgetown, 379 mi apart, both in TX). Reported as
     * a stop, never a silent build: the caller shows the distance and offers
     * the typed city's center as an alternative (SPEC: city-mismatch gate).
     */
    const mismatchStop = (matchedPlace, mismatch) =>
      done(
        { place: null, answered: true },
        {
          cityMismatch: {
            typed: text,
            matchLabel:
              matchedPlace.label || matchedPlace.matchedAddress || text,
            milesOff: mismatch.unresolved ? null : mismatch.milesOff,
            cityCenter: mismatch.unresolved ? null : mismatch.cityCenter,
            unresolved: Boolean(mismatch.unresolved),
            // N-2: the original geocoder match itself (lat/lng), so an
            // unresolved check (Photon down) is not a permanent dead end --
            // the independent check simply could not run, the match is
            // still whatever the primary geocoder returned. Only offered
            // when unresolved; a real disagreement (cityCenter present)
            // still forces the "use city center" / "try another" choice.
            matchedPlace: mismatch.unresolved
              ? {
                  lat: matchedPlace.lat,
                  lng: matchedPlace.lng,
                  label:
                    matchedPlace.label || matchedPlace.matchedAddress || text,
                }
              : null,
          },
        },
      );

    if (kind.kind === 'zip' || (kind.kind === 'pobox' && kind.zip)) {
      const outcome = await zipCenter(kind.zip, { fetchImpl, signal });
      if (outcome.place) {
        const what =
          kind.kind === 'pobox'
            ? `center of ZIP ${kind.zip} (a PO Box has no street location)`
            : `center of ZIP ${kind.zip}`;
        return done(outcome, { approximate: approximateNote(what) });
      }
      // A PO Box only ZIP (37605) has no ZCTA; a PO Box falls back to its town.
      if (kind.kind === 'zip') return done(outcome);
    }

    // No view bias: what is on screen must not decide which Atlanta wins.
    // A PO Box never matches a street, and the world geocoder turns it into a
    // business ("Johnson's Jewlers"), so it goes straight to the town.
    const first =
      kind.kind === 'pobox'
        ? { place: null, answered: true }
        : await original(text, { ...options, bias: null });
    if (kind.kind === 'coords') {
      const place = first?.place;
      if (!place) return done(first);
      // The coarse boxes hold Toronto, Windsor, Montreal and northern Mexico,
      // so they only rule points OUT. TIGERweb rules them in (B-S2-1).
      const where = await usStateAt(place.lat, place.lng, {
        fetchImpl,
        signal,
      });
      if (where.inUs === false)
        return done(
          { place: null, answered: true },
          { outsideUs: place.label || text },
        );
      return done(first);
    }
    if (isStreetMatch(first?.place)) {
      const mismatch = await checkCityMatch(text, first.place, {
        fetchImpl,
        signal,
      });
      if (mismatch) return mismatchStop(first.place, mismatch);
      return done(first);
    }

    // Not a Census street match. Before settling for a US namesake, ask whether
    // the query names somewhere abroad: a trailing country, or a non-US place
    // the world geocoder ranks above every US one (B2-01). A query that names
    // a US state, a ZIP or "USA" never takes this path.
    const usSignal = hasUsSignal(text);
    const namedCountry = usSignal ? '' : foreignCountryInQuery(text);
    const photonQuery =
      kind.kind === 'pobox'
        ? text
            .replace(PO_BOX, '')
            .replace(TRAILING_ZIP, '')
            .replace(/^[\s,#\d]+|[\s,]+$/g, '')
        : text;
    const [us, world] = await Promise.all([
      photonUs(photonQuery, { fetchImpl, signal }),
      usSignal || kind.kind === 'pobox'
        ? Promise.resolve({ foreign: false, label: '', answered: true })
        : photonWorld(text, { fetchImpl, signal }),
    ]);
    if (namedCountry || world.foreign) {
      return done(
        { place: null, answered: true },
        {
          outsideUs: world.foreign
            ? world.label || text
            : `${text}, ${namedCountry}`,
        },
      );
    }
    if (us.place) {
      // Only a street-shaped query gets the mismatch gate: a bare city/name
      // search ("Nashville") has no separate "typed city" to compare against
      // its own match, and a PO Box was already resolved to its town on
      // purpose.
      if (kind.kind !== 'pobox' && looksLikeUsStreetAddress(text)) {
        const mismatch = await checkCityMatch(text, us.place, {
          fetchImpl,
          signal,
        });
        if (mismatch) return mismatchStop(us.place, mismatch);
      }
      return done(
        { place: us.place, answered: true },
        {
          approximate: approximateNote(
            kind.kind === 'pobox'
              ? `${us.place.label} (a PO Box has no street location)`
              : us.place.label,
          ),
          others: us.others,
        },
      );
    }
    const foreign = first?.place;
    if (
      foreign &&
      !(
        US_LABEL.test(foreign.label || '') &&
        inUsBoxes(foreign.lat, foreign.lng)
      )
    )
      return done(
        { place: null, answered: true },
        { outsideUs: foreign.label || foreign.name || text },
      );
    if (foreign)
      return done(first, {
        approximate: approximateNote(foreign.label || text),
      });
    return done({
      place: null,
      answered: Boolean(first?.answered) && us.answered,
    });
  };
}

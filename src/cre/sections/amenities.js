import { MAP_COLORS } from '../mapColors.js';
// Dossier section "amenities": counts within 1 mile and nearest distance for grocery, pharmacy, restaurants, gyms, transit stops, hospitals, parks and big-box retail, read from /api/cre/amenities (OpenStreetMap via Overpass).
import { SECTION_STATUS } from '../contract.js';
import { METERS_PER_MILE } from '../config.js';

const CREDIT = Object.freeze({
  text: 'OpenStreetMap contributors, via the Overpass API',
  url: 'https://www.openstreetmap.org/copyright',
  license: 'ODbL 1.0',
});

/** Fixed section messages. */
export const AMENITIES_MESSAGES = Object.freeze({
  UNAVAILABLE:
    'OpenStreetMap Overpass did not answer (every mirror refused or timed out).',
  EMPTY: 'No mapped amenities within 1 mile in OpenStreetMap.',
  COVERAGE:
    'OpenStreetMap coverage varies by area; counts are mapped features, not a business census. The map shows at most 500 features within the fixed 1-mile amenity area (nearest hospitals may be within 3 miles).',
});

/** Display order; ids match the route's categories. */
export const AMENITY_ORDER = Object.freeze([
  'grocery',
  'pharmacy',
  'restaurants',
  'gyms',
  'transit',
  'hospitals',
  'parks',
  'bigBox',
]);

const miles = (m) => Number((m / METERS_PER_MILE).toFixed(2));

/**
 * One row per category: the count within 1 mile, with the nearest in the note.
 * @param {{categories: Record<string, {label:string, count:number, nearest:{name:string|null, distanceM:number}|null}>, hospitalNearestRadiusM?: number}} data
 */
export function amenityRows(data) {
  const rows = [];
  for (const id of AMENITY_ORDER) {
    const c = data?.categories?.[id];
    if (!c || !Number.isInteger(c.count)) continue;
    const reach = id === 'hospitals' ? 3 : 1;
    let note;
    if (c.nearest) {
      const name = c.nearest.name || 'unnamed feature';
      note = `Nearest: ${name}, ${miles(c.nearest.distanceM)} mi`;
    } else {
      note = `None within ${reach} mi`;
    }
    rows.push({ label: `${c.label} within 1 mi`, value: c.count, note });
  }
  return rows;
}

async function getRoute(url, { signal, fetchImpl = globalThis.fetch }) {
  try {
    const response = await fetchImpl(url, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return { ok: false };
    return { ok: true, body: await response.json() };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false };
  }
}

/**
 * @param {import('../contract.js').SectionContext} ctx
 * @param {{signal?: AbortSignal, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<import('../contract.js').SectionResult>}
 */
export async function loadAmenitiesSection(ctx, options = {}) {
  const reply = await getRoute(
    `/api/cre/amenities?lat=${ctx.lat}&lon=${ctx.lon}`,
    options,
  );
  const base = {
    id: 'amenities',
    label: 'Amenities',
    credit: CREDIT,
    sourceUrls: [
      CREDIT.url,
      'https://wiki.openstreetmap.org/wiki/Overpass_API',
    ],
    retrievedAt: new Date().toISOString(),
  };
  const data = reply.ok ? reply.body?.data : null;
  if (!data || !data.categories) {
    return {
      ...base,
      status: SECTION_STATUS.UNAVAILABLE,
      values: [],
      message: AMENITIES_MESSAGES.UNAVAILABLE,
    };
  }
  const retrievedAt = reply.body.retrievedAt || base.retrievedAt;
  const rows = amenityRows(data);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  if (total === 0) {
    return {
      ...base,
      retrievedAt,
      status: SECTION_STATUS.EMPTY,
      values: [],
      message: AMENITIES_MESSAGES.EMPTY,
    };
  }
  return {
    ...base,
    retrievedAt,
    status: SECTION_STATUS.READY,
    values: rows,
    overlays: data.features?.length
      ? [
          {
            id: 'retail',
            geojson: { type: 'FeatureCollection', features: data.features },
            style: { stroke: MAP_COLORS.retail },
          },
        ]
      : [],
    message: AMENITIES_MESSAGES.COVERAGE,
  };
}

/** @type {import('../contract.js').SectionModule} */
export const amenitiesSection = Object.freeze({
  id: 'amenities',
  label: 'Amenities',
  order: 10,
  load: loadAmenitiesSection,
});

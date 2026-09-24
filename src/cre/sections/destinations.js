import { SECTION_STATUS } from '../contract.js';
import { MAP_COLORS } from '../mapColors.js';

export const DESTINATIONS_SOURCE = Object.freeze({
  text: 'OpenStreetMap contributors; public FOSSGIS OSRM route service',
  url: 'https://www.openstreetmap.org/copyright',
  license: 'ODbL 1.0',
});

const miles = (meters) => Number((meters / 1609.344).toFixed(2));
const minutes = (seconds) => Math.max(1, Math.round(seconds / 60));
const osmElementUrl = (id) =>
  /^(?:node|way|relation)\/\d+$/.test(String(id || ''))
    ? `https://www.openstreetmap.org/${id}`
    : null;

export function destinationRows(data = {}) {
  const rows = [];
  for (const item of Array.isArray(data.destinations)
    ? data.destinations
    : []) {
    const category =
      item.category === 'grocery'
        ? 'Grocery'
        : item.category === 'pharmacy'
          ? 'Pharmacy'
          : 'Retail';
    const walk = data.routes?.[item.category]?.walk;
    rows.push({
      label: `${category}: ${item.name}`,
      value: Number.isFinite(walk?.durationS)
        ? `${minutes(walk.durationS)} min walk`
        : `Straight-line ${miles(item.straightDistanceM)} mi`,
      note: Number.isFinite(walk?.distanceM)
        ? `Routed walk: ${miles(walk.distanceM)} mi; named OSM destination within 5 km.`
        : 'The free routing service did not answer; walking time unavailable. Straight-line distance is not a walking distance or travel time; named OSM destination is within 5 km.',
      partial: !Number.isFinite(walk?.durationS),
      status: Number.isFinite(walk?.durationS) ? 'ready' : 'unavailable',
      sourceUrls: [
        data.sourceUrls?.[0] || DESTINATIONS_SOURCE.url,
        ...(walk
          ? [data.sourceUrls?.[1] || 'https://routing.openstreetmap.de/']
          : []),
      ],
    });
    if (item.category === 'retail') {
      const drive = data.routes?.retail?.car;
      rows.push({
        label: `Drive to ${item.name}`,
        value: Number.isFinite(drive?.durationS)
          ? `${minutes(drive.durationS)} min drive`
          : `Straight-line ${miles(item.straightDistanceM)} mi`,
        note: Number.isFinite(drive?.distanceM)
          ? `Routed drive: ${miles(drive.distanceM)} mi.`
          : 'The free routing service did not answer; driving time unavailable.',
        partial: !Number.isFinite(drive?.durationS),
        status: Number.isFinite(drive?.durationS) ? 'ready' : 'unavailable',
        sourceUrls: [
          data.sourceUrls?.[0] || DESTINATIONS_SOURCE.url,
          ...(drive
            ? [data.sourceUrls?.[1] || 'https://routing.openstreetmap.de/']
            : []),
        ],
      });
    }
  }
  for (const item of Array.isArray(data.places) ? data.places : []) {
    const category = {
      coffee: 'Coffee',
      parks: 'Park',
      attractions: 'Attraction',
      employers: 'Named workplace',
    }[item.category];
    if (!category || !item.name || !Number.isFinite(item.straightDistanceM))
      continue;
    rows.push({
      label: `${category}: ${item.name}`,
      value: `${miles(item.straightDistanceM)} mi straight-line`,
      note:
        item.category === 'employers'
          ? `Named OpenStreetMap ${item.workplaceType || 'workplace'} candidate within 5 km. Employer identity, operating status, employee count, and major-employer status are unverified; no travel time inferred.`
          : 'Named OpenStreetMap place within 5 km. Travel time, operating status and opening date are unverified.',
      sourceUrls: [
        ...(item.sourceUrl || osmElementUrl(item.id)
          ? [item.sourceUrl || osmElementUrl(item.id)]
          : []),
        data.sourceUrls?.[0] || DESTINATIONS_SOURCE.url,
      ],
    });
  }
  return rows;
}

async function routedAccess(item, ctx, profile, { signal, fetchImpl }) {
  const coords = `${ctx.lon},${ctx.lat};${item.lon},${item.lat}`;
  try {
    const response = await fetchImpl(
      `/api/route?profile=${profile}&coords=${encodeURIComponent(coords)}`,
      { signal, headers: { Accept: 'application/json' } },
    );
    if (!response.ok) return null;
    const body = await response.json();
    const route = body?.data || body;
    if (
      !Number.isFinite(route?.durationS) ||
      !Number.isFinite(route?.distanceM)
    )
      return null;
    const geometry =
      Array.isArray(route.geometry) && route.geometry.length >= 2
        ? {
            type: 'LineString',
            coordinates: route.geometry.filter(
              (p) =>
                Array.isArray(p) && p.length >= 2 && p.every(Number.isFinite),
            ),
          }
        : null;
    return { distanceM: route.distanceM, durationS: route.durationS, geometry };
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

export async function loadDestinationsSection(
  ctx,
  { signal, fetchImpl = globalThis.fetch } = {},
) {
  const base = {
    id: 'destinations',
    label: 'Named destinations & walking access',
    credit: DESTINATIONS_SOURCE,
    sourceUrls: [
      DESTINATIONS_SOURCE.url,
      'https://routing.openstreetmap.de/',
      'https://project-osrm.org/',
    ],
    retrievedAt: new Date().toISOString(),
  };
  let response;
  try {
    response = await fetchImpl(
      `/api/cre/destinations?lat=${ctx.lat}&lon=${ctx.lon}`,
      { signal, headers: { Accept: 'application/json' } },
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      ...base,
      status: SECTION_STATUS.UNAVAILABLE,
      values: [],
      message:
        'Destination and walking route sources did not answer. No access time can be inferred.',
    };
  }
  if (!response.ok)
    return {
      ...base,
      status: SECTION_STATUS.UNAVAILABLE,
      values: [],
      message:
        'Destination and walking route sources did not answer. No access time can be inferred.',
    };
  const body = await response.json();
  const data = body?.data;
  if (!data || !Array.isArray(data.destinations))
    return {
      ...base,
      status: SECTION_STATUS.UNAVAILABLE,
      values: [],
      message:
        'Destination source returned an invalid result. No access time can be inferred.',
    };
  const routes = {};
  const routeTasks = [];
  for (const item of data.destinations) {
    routeTasks.push(
      routedAccess(item, ctx, 'foot', { signal, fetchImpl }).then((route) => ({
        item,
        profile: 'foot',
        route,
      })),
    );
    if (item.category === 'retail')
      routeTasks.push(
        routedAccess(item, ctx, 'car', { signal, fetchImpl }).then((route) => ({
          item,
          profile: 'car',
          route,
        })),
      );
  }
  const routeResults = await Promise.all(routeTasks);
  const routeFeatures = [];
  for (const { item, profile, route } of routeResults) {
    routes[item.category] = {
      ...(routes[item.category] || {}),
      [profile === 'car' ? 'car' : 'walk']: route,
    };
    if (route?.geometry?.coordinates.length >= 2)
      routeFeatures.push({
        type: 'Feature',
        properties: {
          name: `${item.name} ${profile === 'car' ? 'driving' : 'walking'} route`,
          category: item.category,
          profile,
        },
        geometry: route.geometry,
      });
  }
  const rows = destinationRows({ ...data, routes });
  if (!rows.length)
    return {
      ...base,
      retrievedAt: body.retrievedAt || base.retrievedAt,
      status:
        data.status === 'empty'
          ? SECTION_STATUS.EMPTY
          : SECTION_STATUS.UNAVAILABLE,
      values: [],
      message:
        data.message ||
        'No named destinations were returned. OpenStreetMap coverage varies; this is not evidence that services are absent.',
    };
  return {
    ...base,
    retrievedAt: body.retrievedAt || base.retrievedAt,
    status: rows.some((row) => row.partial)
      ? SECTION_STATUS.PARTIAL
      : SECTION_STATUS.READY,
    values: rows,
    overlays:
      data.features?.length || routeFeatures.length
        ? [
            {
              id: 'destinations',
              geojson: {
                type: 'FeatureCollection',
                features: [
                  ...(data.features || []).map((feature) => {
                    const sourceUrl = osmElementUrl(feature?.properties?.id);
                    return sourceUrl
                      ? {
                          ...feature,
                          properties: {
                            ...feature.properties,
                            sourceUrl,
                          },
                        }
                      : feature;
                  }),
                  ...routeFeatures,
                ],
              },
              style: {
                stroke: MAP_COLORS.destinations,
                fill: MAP_COLORS.destinations,
              },
            },
          ]
        : [],
    message: `${data.message || 'Named mapped destinations.'} OpenStreetMap base timestamp: ${data.osmBase || 'not supplied by source'}. ${Object.values(routes).some((entry) => entry.walk || entry.car) ? 'Route times come from the app route service using OSM street/path routing; route geometry is shown when supplied. Availability and operating hours should be independently verified.' : 'Walking/driving routing was unavailable. No travel time is inferred from straight-line distance.'}`,
  };
}

export const destinationsSection = Object.freeze({
  id: 'destinations',
  label: 'Named destinations & walking access',
  order: 11,
  load: loadDestinationsSection,
});

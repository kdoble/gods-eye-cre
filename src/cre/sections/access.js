// Access dossier section: the 15 minute drive-time polygon (overlay plus area) and the drive time and distance to the county's largest job cluster, keyless.
import { SECTION_STATUS } from '../contract.js';
import { DRIVE_TIME_MINUTES, RINGS_M } from '../config.js';
import { haversineMeters } from '../geo.js';
import { fetchCreJson, round } from './demographics.js';
import { pointInCollection } from './jobs.js';
import { MAP_COLORS } from '../mapColors.js';

export const id = 'access';
export const label = 'Access and drive time';
export const order = 5;

const CREDIT = Object.freeze({
  text: 'Routing by Valhalla (FOSSGIS demo) and OSRM (demo) on OpenStreetMap data; job cluster from U.S. Census Bureau LEHD LODES8 2023',
  url: 'https://www.openstreetmap.org/copyright',
  license: 'OpenStreetMap data ODbL; LODES public domain',
});
const METERS_PER_MILE = 1609.344;

export const ISOCHRONE_STYLE = Object.freeze({
  stroke: MAP_COLORS.driveTime,
  fill: MAP_COLORS.driveTimeFill,
});
export const CLUSTER_STYLE = Object.freeze({
  stroke: MAP_COLORS.jobCluster,
  icon: 'jobs',
});

const settle = (promise) =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );

const fmt = (n) => Math.round(n).toLocaleString('en-US');

/**
 * Load the access section.
 * @param {import('../contract.js').SectionContext} ctx
 * @param {{signal?:AbortSignal, fetchImpl?:typeof fetch}} [options]
 * @returns {Promise<import('../contract.js').SectionResult>}
 */
export async function load(ctx, { signal, fetchImpl } = {}) {
  const get = (path) => fetchCreJson(path, { signal, fetchImpl });
  const at = `lat=${ctx.lat}&lon=${ctx.lon}`;
  const radius = Math.round(
    Math.max(ctx.rings?.fiveMi || 0, ctx.rings?.threeMi || 0, RINGS_M.fiveMi),
  );
  const knownTract = /^\d{11}$/.test(ctx.tractGeoid || '')
    ? ctx.tractGeoid
    : null;
  const [isoRes, tractRes] = await Promise.all([
    settle(get(`/api/cre/isochrone?${at}&minutes=${DRIVE_TIME_MINUTES}`)),
    knownTract
      ? Promise.resolve({
          ok: true,
          value: { data: { siteTract: knownTract } },
        })
      : settle(get(`/api/cre/census/tracts?${at}&radiusM=${radius}`)),
  ]);
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');
  const values = [];
  const overlays = [];
  const sourceUrls = [];
  const problems = [];

  const iso =
    isoRes.ok && isoRes.value?.status === 'ready' ? isoRes.value.data : null;
  if (iso) {
    sourceUrls.push(...(isoRes.value.sourceUrls || []));
    overlays.push({
      id: `drive-time-${iso.minutes}min`,
      geojson: iso.geojson,
      style: ISOCHRONE_STYLE,
    });
    const via =
      iso.provider === 'openrouteservice'
        ? 'openrouteservice'
        : 'Valhalla demo';
    values.push({
      label: `${iso.minutes} min drive-time area`,
      value: round(iso.areaSqMi, 1),
      unit: 'sq mi',
      note: `Auto, no traffic, ${via} on OpenStreetMap`,
    });
    values.push({
      label: `Farthest point reached in ${iso.minutes} min`,
      value: round(iso.maxDistanceM / METERS_PER_MILE, 1),
      unit: 'mi',
      note: 'Straight-line distance from the site to the polygon edge',
    });
  } else {
    problems.push(
      isoRes.value?.message ||
        'Drive-time routing (Valhalla demo) did not answer',
    );
  }

  const siteTract = tractRes.ok ? tractRes.value?.data?.siteTract : null;
  const county = /^\d{11}$/.test(siteTract || '')
    ? siteTract.slice(0, 5)
    : null;
  if (!county) problems.push('No county found for this point');
  let cluster = null;
  if (county) {
    const clusterRes = await settle(
      get(`/api/cre/lodes/cluster?county=${county}`),
    );
    cluster =
      clusterRes.ok && clusterRes.value?.status === 'ready'
        ? clusterRes.value.data
        : null;
    if (!cluster) problems.push('County job cluster (LODES) did not load');
    else sourceUrls.push(...(clusterRes.value.sourceUrls || []));
  }
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');

  if (cluster) {
    const straightMi =
      haversineMeters(ctx.lat, ctx.lon, cluster.lat, cluster.lon) /
      METERS_PER_MILE;
    overlays.push({
      id: 'county-job-cluster',
      geojson: {
        type: 'Feature',
        properties: { geoid: cluster.geoid, jobs: cluster.clusterJobs },
        geometry: { type: 'Point', coordinates: [cluster.lon, cluster.lat] },
      },
      style: CLUSTER_STYLE,
    });
    values.push({
      label: "County's largest job cluster",
      value: `Tract ${cluster.geoid}`,
      note: `${fmt(cluster.clusterJobs)} LODES ${cluster.year} jobs within 1 mi of its center, ${round((cluster.clusterJobs / cluster.countyJobs) * 100, 1)}% of the county's ${fmt(cluster.countyJobs)}`,
    });
    values.push({
      label: 'Straight-line distance to job cluster',
      value: round(straightMi, 1),
      unit: 'mi',
    });
    const routeRes = await settle(
      get(
        `/api/cre/isochrone/route?${at}&toLat=${cluster.lat}&toLon=${cluster.lon}`,
      ),
    );
    const route =
      routeRes.ok && routeRes.value?.status === 'ready'
        ? routeRes.value.data
        : null;
    if (route) {
      sourceUrls.push(...(routeRes.value.sourceUrls || []));
      values.push({
        label: 'Drive time to job cluster',
        value: round(route.durationS / 60, 1),
        unit: 'min',
        note: 'OSRM demo, free-flow, no traffic',
      });
      values.push({
        label: 'Drive distance to job cluster',
        value: round(route.distanceM / METERS_PER_MILE, 1),
        unit: 'mi',
        note: 'OSRM demo',
      });
    } else {
      problems.push('OSRM drive route did not answer');
    }
    if (iso) {
      values.push({
        label: `Job cluster inside ${iso.minutes} min drive`,
        value: pointInCollection(cluster.lon, cluster.lat, iso.geojson)
          ? 'Yes'
          : 'No',
      });
    }
  }
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');

  const base = {
    id,
    label,
    credit: CREDIT,
    sourceUrls,
    retrievedAt: new Date().toISOString(),
  };
  if (values.length) {
    return {
      ...base,
      status: SECTION_STATUS.READY,
      values,
      overlays,
      ...(problems.length
        ? { message: `Partial: ${problems.join('; ')}` }
        : {}),
    };
  }
  return {
    ...base,
    status: SECTION_STATUS.UNAVAILABLE,
    values: [],
    message: problems.join('; ') || 'Routing sources did not answer',
  };
}

export default { id, label, order, load };

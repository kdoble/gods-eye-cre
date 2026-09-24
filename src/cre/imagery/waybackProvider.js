// Client side of Esri Wayback: one shared fetch of a site's changed releases and a Cesium imagery provider per release, so the imagery section and the time slider make one request and the browser loads tiles straight from Esri (never cached by us).
import * as Cesium from 'cesium';

export const WAYBACK_CHANGES_ENDPOINT = '/api/cre/wayback/changes';
export const WAYBACK_ATTRIBUTION =
  'Esri, Vantor, Earthstar Geographics, CNES/Airbus DS, USDA FSA, USGS, Aerogrid, IGN, IGP, and the GIS User Community';
export const WAYBACK_INFO_URL = 'https://livingatlas.arcgis.com/wayback/';
const TILE_TEMPLATE_PREFIX =
  'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/';

/**
 * @typedef {object} WaybackChange
 * @property {number} release
 * @property {string} releaseDate - YYYY-MM-DD.
 * @property {string} tileTemplate - {z}/{y}/{x} template.
 * @property {string|null} captureDate - Source capture date at the site.
 * @property {number|null} resolutionM
 * @property {string|null} provider
 */

/**
 * @typedef {object} WaybackChanges
 * @property {'ready'|'empty'} status
 * @property {WaybackChange[]} releases - Newest first.
 * @property {number[]} unknown
 * @property {{count:number, earliest:string|null, latest:string|null}} catalog
 * @property {string} retrievedAt
 */

/** @type {Map<string, Promise<WaybackChanges>>} */
const shared = new Map();

/** Key by the ~1 m grid so tiny coordinate noise shares one request. */
const siteKey = (lat, lon) => `${lat.toFixed(5)},${lon.toFixed(5)}`;

/**
 * Changed releases at a site from /api/cre/wayback/changes. Concurrent and
 * repeat callers for the same site share one request; a failure is not kept.
 * @param {number} lat
 * @param {number} lon
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal}} [options]
 * @returns {Promise<WaybackChanges>}
 */
export function fetchWaybackChanges(lat, lon, options = {}) {
  const { fetchImpl = (...args) => globalThis.fetch(...args) } = options;
  const key = siteKey(lat, lon);
  let pending = shared.get(key);
  if (!pending) {
    pending = (async () => {
      const url = `${WAYBACK_CHANGES_ENDPOINT}?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
      // The caller's signal is not passed: the request is shared.
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`Wayback changes HTTP ${response.status}`);
      }
      const body = await response.json();
      const releases = Array.isArray(body?.data?.releases)
        ? body.data.releases.filter(isUsableChange)
        : [];
      return {
        status: releases.length ? 'ready' : 'empty',
        releases,
        unknown: Array.isArray(body?.data?.unknown) ? body.data.unknown : [],
        catalog: body?.data?.catalog || {
          count: 0,
          earliest: null,
          latest: null,
        },
        retrievedAt: body?.retrievedAt || new Date().toISOString(),
      };
    })();
    shared.set(key, pending);
    pending.catch(() => shared.delete(key));
  }
  const { signal } = options;
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
    pending.then(resolve, reject);
  });
}

/** Test hook: forget shared requests. */
export function clearWaybackChangesCache() {
  shared.clear();
}

export const WAYBACK_METADATA_ENDPOINT = '/api/cre/wayback/metadata';

/**
 * Source capture date, resolution and provider for one release at a site
 * (the changes answer carries these only for the newest and oldest).
 * @param {number} release
 * @param {number} lat
 * @param {number} lon
 * @param {{fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{captureDate:string|null, resolutionM:number|null, provider:string|null}>}
 */
export async function fetchReleaseMetadata(release, lat, lon, options = {}) {
  const { fetchImpl = (...args) => globalThis.fetch(...args) } = options;
  const url = `${WAYBACK_METADATA_ENDPOINT}?release=${encodeURIComponent(release)}&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Wayback metadata HTTP ${response.status}`);
  const data = (await response.json())?.data || {};
  return {
    captureDate: /^\d{4}-\d{2}-\d{2}$/.test(String(data.captureDate))
      ? data.captureDate
      : null,
    resolutionM: Number.isFinite(data.resolutionM) ? data.resolutionM : null,
    provider: typeof data.provider === 'string' ? data.provider : null,
  };
}

/** A change is usable only with a real number, date and an Esri template. */
function isUsableChange(change) {
  return (
    Number.isInteger(change?.release) &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(change?.releaseDate)) &&
    typeof change?.tileTemplate === 'string' &&
    change.tileTemplate.startsWith(TILE_TEMPLATE_PREFIX)
  );
}

/**
 * The date to show for a release: the source capture date when Esri's
 * metadata gave one, else the release (publication) date.
 * @param {WaybackChange} change
 */
export function displayDate(change) {
  return change.captureDate || change.releaseDate;
}

/**
 * Cesium imagery provider for one Wayback release. Tiles load in the browser
 * directly from Esri (CORS open, no key).
 * @param {WaybackChange} change
 * @param {{Cesium?: typeof Cesium}} [options] - Cesium injectable for tests.
 */
export function createWaybackImageryProvider(change, options = {}) {
  const C = options.Cesium || Cesium;
  return new C.UrlTemplateImageryProvider({
    url: change.tileTemplate,
    maximumLevel: 19,
    credit: new C.Credit(WAYBACK_ATTRIBUTION, true),
  });
}

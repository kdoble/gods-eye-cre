// ArcGIS REST query helper shared by every CRE data family, so retry, timeout, WGS84 and error-body handling live in one place.
import { readResponseJsonCapped } from '../../common/http.js';

/** Hard cap on one ArcGIS JSON response body. */
export const ARCGIS_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const ARCGIS_DEFAULT_TIMEOUT_MS = 15_000;
export const ARCGIS_DEFAULT_RETRIES = 2;
export const ARCGIS_DEFAULT_BACKOFF_MS = 400;

/**
 * Fixed error messages. Upstream error text is never copied into these, so a
 * route that forwards err.message cannot leak what the service said.
 */
export const ARCGIS_ERROR_MESSAGES = Object.freeze({
  UPSTREAM_ERROR: 'ArcGIS service returned an error',
  HTTP_ERROR: 'ArcGIS service HTTP failure',
  TIMEOUT: 'ArcGIS service timed out',
  ABORTED: 'ArcGIS request aborted',
  INVALID_RESPONSE: 'ArcGIS service returned an invalid response',
  BAD_REQUEST: 'Invalid ArcGIS query',
});

/** Error with a fixed message, a stable code, and whether a retry could help. */
export class ArcgisError extends Error {
  /**
   * @param {keyof typeof ARCGIS_ERROR_MESSAGES} code
   * @param {{retryable?: boolean, status?: number}} [info]
   */
  constructor(code, { retryable = false, status } = {}) {
    super(ARCGIS_ERROR_MESSAGES[code]);
    this.name = 'ArcgisError';
    this.code = code;
    this.retryable = retryable;
    if (status !== undefined) this.status = status;
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** @param {number} ms @param {AbortSignal} [signal] */
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ArcgisError('ABORTED'));
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(new ArcgisError('ABORTED'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Accept only an https ArcGIS layer URL written in server code. Query strings
 * and fragments are refused so callers pass parameters through `params`.
 * @param {string} layerUrl
 * @returns {string} The layer's /query endpoint.
 */
function queryEndpoint(layerUrl) {
  let url;
  try {
    url = new URL(layerUrl);
  } catch {
    throw new ArcgisError('BAD_REQUEST');
  }
  if (url.protocol !== 'https:' || url.search || url.hash) {
    throw new ArcgisError('BAD_REQUEST');
  }
  const base = url.href.replace(/\/+$/, '');
  return base.endsWith('/query') ? base : `${base}/query`;
}

/**
 * One ArcGIS query with timeout, retry with exponential backoff, and rejection
 * of `{ error: ... }` bodies even when the HTTP status is 200.
 *
 * @param {string} layerUrl - Server-known FeatureServer/MapServer layer URL.
 * @param {Record<string, string|number|boolean>} params - Query parameters.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - Caller abort; never retried.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.retries] - Extra attempts after the first.
 * @param {number} [options.backoffMs] - First backoff; doubles per retry.
 * @param {(ms:number, signal?:AbortSignal)=>Promise<void>} [options.sleep]
 * @returns {Promise<object>} Parsed ArcGIS JSON body.
 */
export async function arcgisQuery(layerUrl, params, options = {}) {
  const {
    signal,
    fetchImpl = globalThis.fetch,
    timeoutMs = ARCGIS_DEFAULT_TIMEOUT_MS,
    retries = ARCGIS_DEFAULT_RETRIES,
    backoffMs = ARCGIS_DEFAULT_BACKOFF_MS,
    sleep = defaultSleep,
  } = options;
  const endpoint = queryEndpoint(layerUrl);
  const search = new URLSearchParams({
    f: 'json',
    inSR: '4326',
    outSR: '4326',
  });
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  // Coordinates are always WGS84 in and out; a caller cannot override it.
  search.set('inSR', '4326');
  search.set('outSR', '4326');
  search.set('f', 'json');
  const url = `${endpoint}?${search}`;

  let lastError = new ArcgisError('HTTP_ERROR', { retryable: true });
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw new ArcgisError('ABORTED');
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1), signal);
    try {
      return await arcgisAttempt(url, { signal, fetchImpl, timeoutMs });
    } catch (error) {
      lastError =
        error instanceof ArcgisError
          ? error
          : new ArcgisError('HTTP_ERROR', { retryable: true });
      if (lastError.code === 'ABORTED' || !lastError.retryable) {
        throw lastError;
      }
    }
  }
  throw lastError;
}

/** One HTTP round trip; every failure is mapped to an ArcgisError. */
async function arcgisAttempt(url, { signal, fetchImpl, timeoutMs }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  let body;
  try {
    response = await fetchImpl(url, {
      signal: combined,
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      void response.body?.cancel?.().catch(() => {});
      throw new ArcgisError('HTTP_ERROR', {
        retryable: RETRYABLE_STATUS.has(response.status),
        status: response.status,
      });
    }
    body = await readResponseJsonCapped(
      response,
      ARCGIS_MAX_RESPONSE_BYTES,
      combined,
    );
  } catch (error) {
    if (error instanceof ArcgisError) throw error;
    if (signal?.aborted) throw new ArcgisError('ABORTED');
    if (timeout.aborted) throw new ArcgisError('TIMEOUT', { retryable: true });
    if (error instanceof SyntaxError || error?.code === 'RESPONSE_TOO_LARGE') {
      throw new ArcgisError('INVALID_RESPONSE');
    }
    throw new ArcgisError('HTTP_ERROR', { retryable: true });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ArcgisError('INVALID_RESPONSE');
  }
  if (body.error) {
    const code = Number(body.error.code);
    throw new ArcgisError('UPSTREAM_ERROR', {
      retryable: RETRYABLE_STATUS.has(code),
      status: Number.isFinite(code) ? code : undefined,
    });
  }
  return body;
}

/** @param {number} lat @param {number} lon */
function assertPoint(lat, lon) {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  ) {
    throw new ArcgisError('BAD_REQUEST');
  }
}

/** Normalize a feature query body to { features, exceededTransferLimit }. */
function featureResult(body) {
  if (!Array.isArray(body.features)) throw new ArcgisError('INVALID_RESPONSE');
  return {
    features: body.features,
    exceededTransferLimit: body.exceededTransferLimit === true,
  };
}

/**
 * @typedef {object} ArcgisQueryOptions
 * @property {string} [where] - Defaults to '1=1'.
 * @property {string} [outFields] - Defaults to '*'.
 * @property {boolean} [returnGeometry] - Defaults to true.
 * @property {Record<string, string|number|boolean>} [extra] - Extra query params.
 * @property {AbortSignal} [signal]
 * @property {typeof fetch} [fetchImpl]
 * @property {number} [timeoutMs]
 * @property {number} [retries]
 * @property {number} [backoffMs]
 * @property {(ms:number, signal?:AbortSignal)=>Promise<void>} [sleep]
 */

/** @param {ArcgisQueryOptions} options */
function baseParams(options) {
  return {
    where: options.where ?? '1=1',
    outFields: options.outFields ?? '*',
    returnGeometry: options.returnGeometry ?? true,
    ...options.extra,
  };
}

/**
 * Features intersecting a point.
 * @param {string} layerUrl
 * @param {{lat:number, lon:number}} point
 * @param {ArcgisQueryOptions} [options]
 */
export async function queryPoint(layerUrl, { lat, lon }, options = {}) {
  assertPoint(lat, lon);
  const body = await arcgisQuery(
    layerUrl,
    {
      ...baseParams(options),
      geometry: `${lon},${lat}`,
      geometryType: 'esriGeometryPoint',
      spatialRel: 'esriSpatialRelIntersects',
    },
    options,
  );
  return featureResult(body);
}

/** @param {number} radiusM */
function assertRadius(radiusM) {
  if (!Number.isFinite(radiusM) || radiusM <= 0 || radiusM > 100_000) {
    throw new ArcgisError('BAD_REQUEST');
  }
}

/**
 * Features within radiusM meters of a point.
 * @param {string} layerUrl
 * @param {{lat:number, lon:number, radiusM:number}} circle
 * @param {ArcgisQueryOptions} [options]
 */
export async function queryRadius(layerUrl, { lat, lon, radiusM }, options) {
  const body = await arcgisQuery(
    layerUrl,
    { ...baseParams(options || {}), ...radiusParams(lat, lon, radiusM) },
    options,
  );
  return featureResult(body);
}

function radiusParams(lat, lon, radiusM) {
  assertPoint(lat, lon);
  assertRadius(radiusM);
  return {
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    spatialRel: 'esriSpatialRelIntersects',
    distance: radiusM,
    units: 'esriSRUnit_Meter',
  };
}

function envelopeParams({ west, south, east, north }) {
  assertPoint(south, west);
  assertPoint(north, east);
  if (south > north || west > east) throw new ArcgisError('BAD_REQUEST');
  return {
    geometry: `${west},${south},${east},${north}`,
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
  };
}

/**
 * Features intersecting a WGS84 envelope. Use this for services that time out
 * on point-plus-distance queries.
 * @param {string} layerUrl
 * @param {{west:number, south:number, east:number, north:number}} bbox
 * @param {ArcgisQueryOptions} [options]
 */
export async function queryEnvelope(layerUrl, bbox, options = {}) {
  const body = await arcgisQuery(
    layerUrl,
    { ...baseParams(options), ...envelopeParams(bbox || {}) },
    options,
  );
  return featureResult(body);
}

/**
 * Count of features within a radius, or within an envelope when `bbox` is set.
 * @param {string} layerUrl
 * @param {{lat?:number, lon?:number, radiusM?:number, bbox?:{west:number, south:number, east:number, north:number}}} area
 * @param {ArcgisQueryOptions} [options]
 * @returns {Promise<number>}
 */
export async function queryCount(layerUrl, area, options = {}) {
  const spatial = area?.bbox
    ? envelopeParams(area.bbox)
    : radiusParams(area?.lat, area?.lon, area?.radiusM);
  const body = await arcgisQuery(
    layerUrl,
    {
      where: options.where ?? '1=1',
      ...options.extra,
      ...spatial,
      returnCountOnly: true,
    },
    options,
  );
  if (!Number.isInteger(body.count) || body.count < 0) {
    throw new ArcgisError('INVALID_RESPONSE');
  }
  return body.count;
}

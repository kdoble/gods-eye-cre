// Shared plumbing for /api/cre/* routes: JSON replies, lat/lon validation, per-IP limits and fixed error text, so every family follows the proxy hardening rules the same way.
import { makeRateLimiter, clientKey } from '../../common/rate-limit.js';
import { requiredFiniteQueryNumber } from '../../common/query.js';

/** Fixed client-facing error messages. Upstream text never reaches a client. */
export const CRE_ERRORS = Object.freeze({
  METHOD: 'Method Not Allowed',
  NOT_FOUND: 'Not Found',
  BAD_POINT: 'Invalid lat/lon',
  BAD_RADIUS: 'Invalid radiusM',
  BAD_REFRESH: 'Invalid refresh',
  RATE_LIMITED: 'Rate limit exceeded',
  UPSTREAM: 'Data source unavailable',
  INTERNAL: 'CRE route error',
});

/**
 * Write a JSON response.
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

/** Write a fixed-message JSON error. */
export function sendError(res, status, message, headers) {
  sendJson(res, status, { error: message }, headers);
}

/**
 * Parse and range-check lat/lon from a query string.
 * @param {URLSearchParams} params
 * @returns {{ok:true, lat:number, lon:number}|{ok:false}}
 */
export function parsePoint(params) {
  const lat = requiredFiniteQueryNumber(params, 'lat');
  const lon = requiredFiniteQueryNumber(params, 'lon');
  if (lat === null || lon === null) return { ok: false };
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return { ok: false };
  return { ok: true, lat, lon };
}

/**
 * Parse an optional radiusM, clamped to a family's own ceiling.
 * @param {URLSearchParams} params
 * @param {{fallback:number, max:number}} limits
 * @returns {{ok:true, radiusM:number}|{ok:false}}
 */
export function parseRadiusM(params, { fallback, max }) {
  if (!params.has('radiusM')) return { ok: true, radiusM: fallback };
  const radiusM = requiredFiniteQueryNumber(params, 'radiusM');
  if (radiusM === null || radiusM <= 0 || radiusM > max) return { ok: false };
  return { ok: true, radiusM };
}

/** Accept only an explicit one-shot refresh flag; other query values fail closed. */
export function parseRefresh(params) {
  const flags = params.getAll('refresh');
  if (!flags.length) return { ok: true, refresh: false };
  if (flags.length !== 1 || !['0', '1'].includes(flags[0]))
    return { ok: false };
  return { ok: true, refresh: flags[0] === '1' };
}

/** Per-IP limiter for CRE routes, built on the repo's shared limiter. */
export function makeCreLimiter({ max = 60, windowMs = 60_000 } = {}) {
  return makeRateLimiter({ windowMs, max, globalMax: max * 20 });
}

/**
 * The route contract body: { status, data, retrievedAt, source }.
 * @param {'ready'|'empty'} status
 * @param {unknown} data
 * @param {{name:string, url:string, license:string}} source
 * @param {Date} [at]
 */
export function creBody(status, data, source, at = new Date()) {
  return { status, data, retrievedAt: at.toISOString(), source };
}

/**
 * Wrap a GET handler with method check, exact-path check, per-IP limit, and a
 * catch-all that answers with a fixed message. Mount it on the full route path
 * (connect strips that prefix, so only '/' is accepted here).
 *
 * @param {(ctx:{req:import('http').IncomingMessage, res:import('http').ServerResponse, params:URLSearchParams}) => Promise<void>|void} handler
 * @param {{limiter?: ((key:string)=>boolean)|null, tag?: string}} [options]
 */
export function creRoute(
  handler,
  { limiter = makeCreLimiter(), tag = 'cre' } = {},
) {
  return async (req, res) => {
    try {
      if (req.method !== 'GET') {
        sendError(res, 405, CRE_ERRORS.METHOD, { Allow: 'GET' });
        return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname !== '/' && url.pathname !== '') {
        sendError(res, 404, CRE_ERRORS.NOT_FOUND);
        return;
      }
      if (limiter && !limiter(clientKey(req))) {
        sendError(res, 429, CRE_ERRORS.RATE_LIMITED, { 'Retry-After': '5' });
        return;
      }
      await handler({ req, res, params: url.searchParams });
    } catch (error) {
      // Log the stable code only; messages can carry upstream text.
      console.error(`[CRE ${tag}] route failed`, error?.code || 'ERROR');
      if (!res.headersSent) sendError(res, 502, CRE_ERRORS.UPSTREAM);
      else res.end();
    }
  };
}

/** Same-origin relay for the US Census geocoder, which sends no CORS headers, with a short in-memory cache. */
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { coalesceProxyRequest, readResponseTextCapped } from './common/http.js';

const CENSUS_ENDPOINT =
  'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';

/** Census asks nothing of callers, but an identifiable agent is the courtesy. */
const CENSUS_USER_AGENT =
  'gods-eye-cre/0.1 (site-intelligence address geocoder; +https://github.com/bilawalsidhu/gods-eye-view)';

const CENSUS_TIMEOUT_MS = 10_000;

/** A real match with every geography layer is ~5 KB; 256 KB is generous. */
const CENSUS_MAX_BODY_BYTES = 256 * 1024;

const CENSUS_CACHE_TTL_MS = 60 * 60_000;

const CENSUS_CACHE_MAX = 200;

const CENSUS_MAX_QUERY = 200;

/**
 * Ask Census for one address and return its JSON text. Throws on a non-200,
 * an oversized body, or a body that is not JSON with `result.addressMatches`,
 * so only well-formed answers (including "no match") reach the cache.
 * @param {string} address - One-line address.
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal}} [options]
 * @returns {Promise<string>}
 */
export async function fetchCensusGeocode(
  address,
  { fetchImpl = fetch, signal } = {},
) {
  const url = new URL(CENSUS_ENDPOINT);
  url.searchParams.set('address', address);
  url.searchParams.set('benchmark', 'Public_AR_Current');
  url.searchParams.set('vintage', 'Current_Current');
  url.searchParams.set('format', 'json');
  const deadline = AbortSignal.timeout(CENSUS_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const upstream = await fetchImpl(url.toString(), {
    headers: { 'User-Agent': CENSUS_USER_AGENT, Accept: 'application/json' },
    signal: requestSignal,
  });
  if (!upstream.ok) {
    void upstream.body?.cancel().catch(() => {});
    throw Object.assign(new Error(`Census HTTP ${upstream.status}`), {
      code: 'CENSUS_UPSTREAM',
    });
  }
  const text = await readResponseTextCapped(
    upstream,
    CENSUS_MAX_BODY_BYTES,
    requestSignal,
  );
  if (!Array.isArray(JSON.parse(text)?.result?.addressMatches))
    throw Object.assign(new Error('Census body has no addressMatches'), {
      code: 'CENSUS_MALFORMED',
    });
  return text;
}

/**
 * Vite plugin serving GET /api/census-geocode?address=<one line>.
 * Relays the raw Census JSON so the client parses the documented format.
 */
export function censusGeocodeProxy({ lookup = fetchCensusGeocode } = {}) {
  const limiter = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 90 });
  const cache = new Map();
  const inFlight = new Map();

  function install(middlewares) {
    middlewares.use('/api/census-geocode', async (req, res) => {
      const send = (status, body, headers = {}) => {
        if (res.writableEnded) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...headers,
        });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (req.method !== 'GET')
        return send(405, { error: 'Method Not Allowed' });
      if (!limiter(clientKey(req)))
        return send(
          429,
          { error: 'Rate limit exceeded' },
          { 'Retry-After': '10' },
        );
      const url = new URL(req.url || '', 'http://localhost');
      const address = String(url.searchParams.get('address') || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!address || address.length > CENSUS_MAX_QUERY)
        return send(400, {
          error: 'An address of 1-200 characters is required',
        });
      const key = address.toLowerCase();
      const cached = cache.get(key);
      if (cached && cached.expires > Date.now())
        return send(200, cached.text, {
          'Cache-Control': 'public, max-age=60',
        });
      cache.delete(key);
      try {
        const { promise } = coalesceProxyRequest(inFlight, key, () =>
          lookup(address),
        );
        const text = await promise;
        cache.set(key, { text, expires: Date.now() + CENSUS_CACHE_TTL_MS });
        while (cache.size > CENSUS_CACHE_MAX)
          cache.delete(cache.keys().next().value);
        send(200, text);
      } catch {
        send(503, { error: 'Address geocoding is temporarily unavailable' });
      }
    });
  }

  return {
    name: 'census-geocode-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

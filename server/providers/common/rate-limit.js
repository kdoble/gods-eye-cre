import { makeRateLimiter } from '../../../src/sources/rateLimit.js';
export { makeRateLimiter } from '../../../src/sources/rateLimit.js';

/**
 * Per-IP rate limiter for the cost-bearing API proxies (OpenAI / Google).
 * DEFAULT IS ON: when the env var is UNSET, this returns a limiter built from
 * `defaultMax` (the values Pinokio's own launch environment already sets —
 * see scripts/pinokio-environment.mjs — so a plain `git clone` + `npm run
 * dev` behaves the same as a Pinokio install). Set the env var to `0`
 * explicitly to opt back into unlimited; a positive integer N overrides the
 * default with N requests/min/IP (built lazily once, then reused so its
 * per-IP window state persists across requests). The global backstop is a
 * generous multiple of the per-IP cap so a single host can't starve the rest.
 *
 * @param {string|undefined} envValue - Raw env value (requests/min/IP). Unset
 *   uses `defaultMax`; `0` or a non-numeric value means unlimited.
 * @param {number} [defaultMax] - Requests/min/IP used when envValue is unset.
 * @returns {((key:string)=>boolean)|null} An `allow(key)` fn, or null when unlimited.
 */
export function makeOptInRateLimiter(envValue, defaultMax) {
  const hasEnvValue =
    envValue !== undefined &&
    envValue !== null &&
    String(envValue).trim() !== '';
  const parsed = Number(hasEnvValue ? envValue : defaultMax);
  // N1: a typo'd env value ("12O", letter O) must fall back to the
  // default cap, never silently disable a limiter that is supposed to be
  // ON by default. Only an explicit, genuinely numeric "0" (or another
  // non-positive number) opts out of limiting.
  const max =
    hasEnvValue && !Number.isFinite(parsed) ? Number(defaultMax) : parsed;
  if (!Number.isFinite(max) || max <= 0) return null; // 0/unset default/genuinely non-positive -> unlimited
  return makeRateLimiter({
    windowMs: 60_000,
    max: Math.floor(max),
    globalMax: Math.floor(max) * 20,
  });
}

/**
 * Client key for rate limiting. Uses the real socket peer address only — we do
 * NOT trust X-Forwarded-For (client-controlled; a rotating value would mint fresh
 * quota and grow the limiter map). This is a localhost dev proxy, so the socket
 * address is the real client.
 */
export function clientKey(req) {
  return String(req.socket?.remoteAddress || 'local');
}

/** Default cap (requests/min/IP) when GEV_RATELIMIT_GOOGLE_PER_MIN is unset — matches Pinokio's own launch environment (scripts/pinokio-environment.mjs). */
const GOOGLE_RATE_LIMIT_DEFAULT_PER_MIN = 120;

// Construct lazily after the standalone environment has loaded.
// undefined = not built yet; null = unlimited; fn = active limiter
let _googleRateLimiter;

/**
 * The one shared Google cost-endpoint limiter (Places nearby/text-search AND
 * the CCTV Street View fallback — every server-side call that spends the
 * same Google key's quota). On by default; set GEV_RATELIMIT_GOOGLE_PER_MIN
 * to 0 for unlimited.
 */
export function googleRateLimiter() {
  if (_googleRateLimiter === undefined)
    _googleRateLimiter = makeOptInRateLimiter(
      process.env.GEV_RATELIMIT_GOOGLE_PER_MIN,
      GOOGLE_RATE_LIMIT_DEFAULT_PER_MIN,
    );
  return _googleRateLimiter;
}

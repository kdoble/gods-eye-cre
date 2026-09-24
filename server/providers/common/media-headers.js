/**
 * Response headers for inert, non-navigable upstream media/JSON proxied onto
 * the app origin: `nosniff` stops the browser from re-interpreting a
 * mistyped body, and a sandboxed CSP with no origins allowed stops a
 * mis-served `text/html` (or an HTML body a compromised/hijacked upstream
 * decides to send) from ever executing as the app.
 *
 * Shared by the CCTV camera routes (server/providers/cctv/media.js, which
 * re-exports this for its existing callers) and the GBFS proxy (SEC-05) —
 * one constant, not two copies that could drift.
 */
export const CCTV_RESPONSE_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'",
});

import { localAuthority } from '../../src/keySetupCore.mjs';

/**
 * Refuses forged-Host and cross-site requests to every `/api/*` route,
 * registered BEFORE every provider plugin so no route answers before this
 * check runs (SEC-01/02/03).
 *
 * Why this exists: Vite's own `allowedHosts` check and each provider's own
 * ad-hoc Origin comparisons (e.g. the old HUD-summary check that compared
 * Origin to Host) both run too late or too narrowly. Under DNS rebinding, a
 * page on `attacker.example` gets the victim's browser to resolve that name
 * to 127.0.0.1/::1; the TCP connection is genuinely local, but every plugin
 * middleware registered in `configureServer`/`configurePreviewServer` answers
 * before Vite's Host check ever runs, and a same-value Origin==Host
 * comparison is a tautology in that scenario (both carry the attacker's
 * name). This guard checks the Host header against a fixed allowlist of
 * local names instead of against itself.
 *
 * Checks, in order:
 *  1. Host must resolve to a local name (localhost/127.0.0.1/::1) via
 *     `localAuthority()` — the same parser the Provider Settings admission
 *     gate uses — UNLESS `allowWideHost` is set, which mirrors
 *     `HOST=0.0.0.0`/`HOST=::` opting the operator into LAN/tunnel
 *     reachability (see SECURITY.md's HOST=0.0.0.0 section).
 *  2. `Sec-Fetch-Site: cross-site` is refused outright.
 *  3. Any Origin header present must match this request's own local origin
 *     exactly; a mismatched or unparseable Origin is refused.
 *
 * A request with neither Origin nor Sec-Fetch-Site (curl, a Node script, a
 * server-to-server call, most non-browser tooling) is allowed once the Host
 * check above passes — that is what keeps a legitimate same-origin curl or
 * smoke test working while still closing the browser-driven attacks above.
 *
 * @param {{allowWideHost?: boolean}} [options]
 * @returns {import('vite').Plugin}
 */
export function apiOriginGuardPlugin({ allowWideHost = false } = {}) {
  function refuse(res, status, error) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error }));
  }

  function install(middlewares) {
    middlewares.use('/api', (req, res, next) => {
      const headers = req.headers || {};
      const protocol = req.socket?.encrypted ? 'https:' : 'http:';

      let authority = null;
      if (!allowWideHost) {
        authority = localAuthority(headers.host, protocol);
        if (!authority) {
          refuse(res, 403, 'Refused: non-local Host');
          return;
        }
      }

      // Only same-origin (this page) or none (no Sec-Fetch-Site sender, e.g.
      // curl) are allowed. `same-site` is refused too: a no-cors GET (<img>,
      // <script>, a form navigation) from another local dev server on the
      // same hostname/different port is same-site with no Origin, and would
      // otherwise reach these paid/quota-bearing routes blind.
      const secFetchSite = String(
        headers['sec-fetch-site'] || '',
      ).toLowerCase();
      if (
        secFetchSite &&
        secFetchSite !== 'same-origin' &&
        secFetchSite !== 'none'
      ) {
        refuse(res, 403, 'Refused: cross-site request');
        return;
      }

      const origin = headers.origin;
      if (origin !== undefined && origin !== null && origin !== '') {
        let sameOrigin = false;
        try {
          const parsedOrigin = new URL(String(origin));
          const expected =
            authority ?? new URL(`${protocol}//${headers.host}`).origin;
          sameOrigin = parsedOrigin.origin === expected;
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin) {
          refuse(res, 403, 'Refused: cross-origin request');
          return;
        }
      }

      next();
    });
  }

  return {
    name: 'api-origin-guard',
    // `enforce: 'pre'` makes Vite sort this plugin ahead of every plugin
    // without that flag, regardless of array position — so array order
    // (also kept first, in build/vite.js) is defense-in-depth rather than
    // the only thing stopping a future `enforce: 'pre'` plugin from running
    // ahead of this guard's configureServer/configurePreviewServer hook.
    enforce: 'pre',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

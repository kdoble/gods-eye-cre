#!/usr/bin/env node
// Adversarial matrix for every /api/* route: DNS-rebinding (forged Host),
// cross-site fetch (Origin + Sec-Fetch-Site: cross-site), and a text/plain
// cross-site simple-request POST where the route accepts POST. Each route
// also gets one legitimate same-origin request to prove the guard doesn't
// break normal use. Runs against `vite` dev AND, when routes install there
// too, `vite preview` (after `npm run build`).
//
// Provider keys used here are synthesized at runtime (never a real key, and
// never a literal that looks like one — see FAKE_OPENAI_KEY below) — some
// keyless/free upstream calls (OpenSky anon, GBFS, Overpass, etc.) may still
// reach the real public internet, same as `npm run dev` does; that's
// expected and not a cost risk.
//
// Exit code 0 only when VULNERABLE_ROUTES=0 and LEGIT_BROKEN=0.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const ROOT = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
);
const REQUEST_TIMEOUT_MS = 6000;

// Assembled, not written as one literal, so this never reads as a real
// credential in a diff or a secret scanner: it is not one.
const FAKE_OPENAI_KEY = ['sk', 'fake', 'test', 'not', 'real'].join('-');
const FAKE_GOOGLE_BROWSER_KEY = ['fake', 'google', 'maps', 'browser', 'key'].join('-');
const FAKE_GOOGLE_SERVER_KEY = ['fake', 'google', 'maps', 'server', 'key'].join('-');

// Every /api mount point registered by a Vite plugin's configureServer /
// configurePreviewServer, enumerated from server/providers/**/*.js and
// server/standalone/*.js (grep '/api' route registrations, 2026-09-24).
// `query` is a deliberately minimal/invalid same-origin query — enough to
// prove the route is reachable (any non-403 status), not enough to trigger
// a slow or costly upstream call. `post` marks routes whose handler accepts
// POST (checked against each handler's `req.method` guard).
const ROUTES = [
  { path: '/api/cre/health', query: '' },
  { path: '/api/cre/hazards', query: '' },
  { path: '/api/cre/incentives', query: '' },
  // Uncovered before 2026-09-24 (found by the coverage check below, not by
  // this task's proof case): mounted via mountOps('site', ...) same as
  // hazards/incentives above, just missing its own family-level entry here.
  { path: '/api/cre/site', query: '' },
  { path: '/api/cre/census/tracts', query: '' },
  { path: '/api/cre/census/acs', query: '' },
  { path: '/api/cre/lodes/jobs', query: '' },
  { path: '/api/cre/lodes/cluster', query: '' },
  { path: '/api/cre/qcew/county', query: '' },
  { path: '/api/cre/qcew/laus', query: '' },
  { path: '/api/cre/qcew/county-annual', query: '' },
  { path: '/api/cre/qcew/sectors', query: '' },
  { path: '/api/cre/isochrone', query: '' },
  { path: '/api/cre/isochrone/route', query: '' },
  { path: '/api/cre/schools', query: '' },
  { path: '/api/cre/permits', query: '' },
  { path: '/api/cre/rents', query: '' },
  { path: '/api/cre/amenities', query: '' },
  { path: '/api/cre/neighborhood', query: '' },
  { path: '/api/cre/destinations', query: '' },
  { path: '/api/cre/wayback/changes', query: '' },
  { path: '/api/cre/wayback/metadata', query: '' },
  { path: '/api/cre/wayback/releases', query: '' },
  { path: '/api/cre/cameras', query: '' },
  {
    // `allowFrameProxy` (server/providers/cre/cameras.js) is an operator
    // feature flag, off by default, unrelated to Origin/Host — a legit
    // same-origin request 403s here regardless of the guard fix.
    path: '/api/cre/camera-frame',
    query: '?id=test&lat=&lon=',
    legit403IsExpected: true,
  },
  { path: '/api/cre/market', query: '' },
  { path: '/api/cre/development', query: '' },
  { path: '/api/cre/local-news', query: '' },
  // P6B (2026-09-24): insurance EAL, LIHTC limits, demand drivers, utilities.
  { path: '/api/cre/insurance', query: '' },
  { path: '/api/cre/lihtc-limits', query: '' },
  { path: '/api/cre/demand-drivers', query: '' },
  { path: '/api/cre/utilities', query: '' },
  { path: '/api/cre/local-brand-marks/manifest', query: '' },
  // GET on a filename that doesn't exist in the (gitignored, dev-only)
  // local-brand-marks folder: proves the route is reachable without
  // depending on any file actually being present. 404 is expected and legit
  // (`legit.status !== 403` already treats it as ok — not a refusal).
  { path: '/api/cre/local-brand-marks', query: '/does-not-exist.png' },
  { path: '/api/realtime/token', query: '', post: true, legitPostBody: null },
  {
    path: '/api/openai/hud-summary',
    query: '',
    post: true,
    legitPostBody: '{}',
  },
  {
    path: '/api/realtime/debug-log',
    query: '',
    post: true,
    legitPostBody: '{"note":"security-attack-matrix legit smoke test"}',
  },
  { path: '/api/google/text-search', query: '?query=test&lat=35&lon=-80' },
  { path: '/api/google/nearby-places', query: '?lat=35&lon=-80' },
  { path: '/api/cctv', query: '' },
  { path: '/api/cctv/frame/test', query: '?lat=&lon=' },
  { path: '/api/setup/status', query: '' },
  {
    path: '/api/setup/keys',
    query: '',
    post: true,
    // Invalid JSON: proves the route is reachable (400) without persisting
    // anything to the credential store.
    legitPostBody: 'not-json',
  },
  { path: '/api/adsbdb', query: '' },
  { path: '/api/adsblol/mil', query: '' },
  { path: '/api/adsblol/trace', query: '' },
  { path: '/api/ais-live', query: '' },
  { path: '/api/celestrak', query: '' },
  { path: '/api/census-geocode', query: '' },
  { path: '/api/firms', query: '' },
  { path: '/api/gbfs', query: '' },
  { path: '/api/geocode', query: '' },
  { path: '/api/launches', query: '' },
  { path: '/api/military-installations', query: '' },
  { path: '/api/opensky', query: '' },
  { path: '/api/opensky-track', query: '' },
  { path: '/api/overpass', query: '' },
  { path: '/api/radio', query: '' },
  { path: '/api/regional-brief', query: '' },
  { path: '/api/route', query: '' },
  { path: '/api/terrain/heights', query: '' },
  { path: '/api/tomtom', query: '' },
  { path: '/api/transit', query: '' },
  { path: '/api/weather-effects', query: '' },
];

// Routes present only under `vite` dev (never configurePreviewServer),
// confirmed by reading each plugin's `apply`/hook wiring:
//   - key-setup.js pins `apply: command === 'serve' && !isPreview`.
const DEV_ONLY_PATHS = new Set(['/api/setup/status', '/api/setup/keys']);

// Coverage check: reads back what's ACTUALLY mounted on the running Vite
// dev server (Connect's `middlewares.stack`, each entry's `.route` is the
// literal string passed to `.use(...)`), rather than grepping source for a
// registration pattern. This is robust to any registration shape a provider
// uses — a literal string, a template literal (`mountOps`'s
// `/api/cre/${family}/${op}`), a loop, whatever — because it reads the
// result Vite actually installed, not the syntax that produced it.
//
// A ROUTES entry covers a registered path if it's an exact match or an
// ancestor path segment (e.g. the family-level `/api/cre/hazards` entry
// covers the actual per-op mounts `/api/cre/hazards/flood`, `.../nri`, …).
// The bare `/api` catch-all (api-origin-guard.js, api-not-found.js) isn't a
// route to cover, so it's excluded.
function registeredApiPaths(middlewareStack) {
  const paths = new Set();
  for (const layer of middlewareStack) {
    const route = layer?.route;
    if (typeof route === 'string' && route.startsWith('/api') && route !== '/api') {
      paths.add(route);
    }
  }
  return [...paths].sort();
}

function findUncoveredRoutes(middlewareStack) {
  const isCovered = (registeredPath) =>
    ROUTES.some(
      (r) => registeredPath === r.path || registeredPath.startsWith(`${r.path}/`),
    );
  return registeredApiPaths(middlewareStack).filter((p) => !isCovered(p));
}

function fetchOnce({ port, path: routePath, method = 'GET', headers = {}, body }) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: routePath,
        method,
        headers,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode }));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: null, timedOut: true });
    });
    req.on('error', () => resolve({ status: null, error: true }));
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

async function runOneRoute({ port, route, mode, rows }) {
  const {
    path: routePath,
    query = '',
    post,
    legitPostBody,
    legit403IsExpected = false,
  } = route;
  const target = `${routePath}${query}`;
  const localHost = `127.0.0.1:${port}`;

  // (legit) same-origin, no Origin/Sec-Fetch-Site header at all — the curl /
  // non-browser shape the admission logic must keep allowing.
  const legit = await fetchOnce({
    port,
    path: target,
    headers: { host: localHost },
  });
  const legitOk = legit.status !== 403 || legit403IsExpected;
  rows.push({
    mode,
    route: routePath,
    check: 'legit (same-origin)',
    status: legit.status ?? (legit.timedOut ? 'TIMEOUT' : 'ERROR'),
    verdict: legitOk ? 'ok' : 'LEGIT_BROKEN',
  });

  // (a) forged Host — the DNS-rebinding shape: the TCP peer is loopback but
  // the Host header names the attacker's domain.
  const rebind = await fetchOnce({
    port,
    path: target,
    headers: { host: `attacker.example:${port}` },
  });
  const rebindRefused = rebind.status === 403;
  rows.push({
    mode,
    route: routePath,
    check: 'rebind (forged Host)',
    status: rebind.status ?? (rebind.timedOut ? 'TIMEOUT' : 'ERROR'),
    verdict: rebindRefused ? 'ok' : 'VULNERABLE',
  });

  // (b) cross-site fetch — legitimate Host, foreign Origin + Sec-Fetch-Site.
  const crossSite = await fetchOnce({
    port,
    path: target,
    headers: {
      host: localHost,
      origin: 'http://evil.example',
      'sec-fetch-site': 'cross-site',
    },
  });
  const crossSiteRefused = crossSite.status === 403;
  rows.push({
    mode,
    route: routePath,
    check: 'cross-site (Origin+Sec-Fetch-Site)',
    status: crossSite.status ?? (crossSite.timedOut ? 'TIMEOUT' : 'ERROR'),
    verdict: crossSiteRefused ? 'ok' : 'VULNERABLE',
  });

  // (c) text/plain cross-site simple-request POST, only where the route
  // accepts POST at all.
  if (post) {
    const crossPost = await fetchOnce({
      port,
      path: target,
      method: 'POST',
      headers: {
        host: localHost,
        origin: 'http://evil.example',
        'sec-fetch-site': 'cross-site',
        'content-type': 'text/plain',
      },
      body: '{"injected":"from-security-attack-matrix"}',
    });
    const crossPostRefused = crossPost.status === 403;
    rows.push({
      mode,
      route: routePath,
      check: 'cross-site POST (text/plain)',
      status: crossPost.status ?? (crossPost.timedOut ? 'TIMEOUT' : 'ERROR'),
      verdict: crossPostRefused ? 'ok' : 'VULNERABLE',
    });

    // Legit same-origin POST, JSON content-type — proves POST routes still work.
    const legitPost = await fetchOnce({
      port,
      path: target,
      method: 'POST',
      headers: {
        host: localHost,
        origin: `http://${localHost}`,
        'content-type': 'application/json',
      },
      body: legitPostBody ?? '{}',
    });
    const legitPostOk = legitPost.status !== 403;
    rows.push({
      mode,
      route: routePath,
      check: 'legit POST (same-origin JSON)',
      status: legitPost.status ?? (legitPost.timedOut ? 'TIMEOUT' : 'ERROR'),
      verdict: legitPostOk ? 'ok' : 'LEGIT_BROKEN',
    });
  }
}

function printTable(rows) {
  const widths = { mode: 7, route: 34, check: 34, status: 8, verdict: 11 };
  const line = (r) =>
    [
      String(r.mode).padEnd(widths.mode),
      String(r.route).padEnd(widths.route),
      String(r.check).padEnd(widths.check),
      String(r.status).padEnd(widths.status),
      String(r.verdict).padEnd(widths.verdict),
    ].join(' | ');
  console.log(
    line({
      mode: 'MODE',
      route: 'ROUTE',
      check: 'CHECK',
      status: 'STATUS',
      verdict: 'VERDICT',
    }),
  );
  console.log(
    '-'.repeat(
      widths.mode + widths.route + widths.check + widths.status + widths.verdict + 12,
    ),
  );
  for (const r of rows) console.log(line(r));
}

async function runAgainstServer(server, mode, rows, { alreadyListening = false } = {}) {
  if (!alreadyListening) await server.listen();
  const port = server.httpServer.address().port;
  console.log(`\n[${mode}] listening on 127.0.0.1:${port}`);
  for (const route of ROUTES) {
    if (mode === 'preview' && DEV_ONLY_PATHS.has(route.path)) continue;
    await runOneRoute({ port, route, mode, rows });
  }
  if (!alreadyListening) await server.close();
}

async function main() {
  process.env.OPENAI_API_KEY = FAKE_OPENAI_KEY;
  process.env.GOOGLE_MAPS_API_KEY = FAKE_GOOGLE_BROWSER_KEY;
  process.env.GOOGLE_MAPS_SERVER_API_KEY = FAKE_GOOGLE_SERVER_KEY;
  process.chdir(ROOT);

  const rows = [];

  const { createServer } = await import('vite');
  const devServer = await createServer({
    root: ROOT,
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  // Coverage check runs before the attacks: a route family merged without a
  // matching ROUTES entry never gets attacked at all, which is a silent gap
  // rather than a failure.
  const uncovered = findUncoveredRoutes(devServer.middlewares.stack);

  await runAgainstServer(devServer, 'dev', rows);

  const previewInstallsAnyRoute = ROUTES.some(
    (route) => !DEV_ONLY_PATHS.has(route.path),
  );
  if (previewInstallsAnyRoute) {
    const { build, preview } = await import('vite');
    console.log('\nBuilding for preview mode…');
    await build({ root: ROOT, logLevel: 'warn' });
    const previewServer = await preview({
      root: ROOT,
      preview: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    await runAgainstServer(previewServer, 'preview', rows, { alreadyListening: true });
    await new Promise((resolve) => previewServer.httpServer.close(resolve));
  }

  printTable(rows);

  const vulnerable = rows.filter((r) => r.verdict === 'VULNERABLE');
  const legitBroken = rows.filter((r) => r.verdict === 'LEGIT_BROKEN');

  if (vulnerable.length) {
    console.log('\nVulnerable checks:');
    for (const r of vulnerable)
      console.log(`  [${r.mode}] ${r.route} — ${r.check} — status ${r.status}`);
  }
  if (legitBroken.length) {
    console.log('\nLegit-broken checks:');
    for (const r of legitBroken)
      console.log(`  [${r.mode}] ${r.route} — ${r.check} — status ${r.status}`);
  }

  if (uncovered.length) {
    console.log('\nUncovered registered routes (mounted, no ROUTES entry):');
    for (const p of uncovered) console.log(`  ${p}`);
  }

  console.log(`\nVULNERABLE_ROUTES=${vulnerable.length}`);
  console.log(`LEGIT_BROKEN=${legitBroken.length}`);
  console.log(`UNCOVERED_ROUTES=${uncovered.length}`);
  process.exitCode =
    vulnerable.length === 0 && legitBroken.length === 0 && uncovered.length === 0
      ? 0
      : 1;
}

main().catch((error) => {
  console.error('[security-attack-matrix] fatal:', error);
  process.exitCode = 1;
});

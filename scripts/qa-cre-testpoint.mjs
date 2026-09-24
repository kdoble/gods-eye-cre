#!/usr/bin/env node
/** CRE address-search acceptance: typed US street addresses must land the camera on the building and put the site pin in the open map area, on desktop and phone. An address Census cannot match must land nowhere: no flight, no pin, no dossier. */
import puppeteer from 'puppeteer';
import {
  probeSiteScreen,
  probeAimPoint,
  probeSiteOverlay,
  judgeSiteOnScreen,
  judgeLanding,
  judgeNoMatch,
  applyPageFault,
  haversineM,
  MAX_MISS_M,
  MAX_RANGE_M,
  QA_FAULTS,
} from './qa-cre-screen-check.mjs';
import {
  snapshotDossierDom,
  readyValueCount,
  DOSSIER_ATTR,
} from './qa-cre-dossier-check.mjs';

const origin = process.env.QA_BASE_URL || 'http://localhost:4173';
const CENSUS =
  'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';
/**
 * Landing limits. Overridable so the assertions themselves can be watched
 * firing on a good build: QA_MAX_RANGE_M=100 makes the real 661 m landing
 * fail, which proves the range check is wired and not decorative.
 */
const MAX_MISS = Number(process.env.QA_MAX_MISS_M || MAX_MISS_M);
const MAX_RANGE = Number(process.env.QA_MAX_RANGE_M || MAX_RANGE_M);

/** A no-match search may not move the camera further than this. */
const MAX_NO_MATCH_MOVE_M = 50;
/**
 * A matched address must leave at least this many sections ready with real
 * values. The full count is qa-cre-dossier.mjs's job; this floor exists so a
 * landing onto a dossier of placeholders cannot be called a pass.
 */
const MIN_READY_SECTIONS = Number(process.env.QA_MIN_SECTIONS || 1);
/** Dossier states that mean the panel has data. */
const SETTLED_STATES = ['ready', 'partial'];
/** Dossier states that mean the panel has stopped working. */
const TERMINAL_STATES = [...SETTLED_STATES, 'no-match', 'outside-us', 'error'];

/**
 * Expected points. (a) is hardcoded from the Census match for the primary
 * test point (Johnson City, TN city hall, chosen for its Appalachian-plateau
 * elevation, about the same regime as the property this suite originally
 * screened). The other positive cases are fetched live from census.gov at
 * run time, independent of the app's own proxy. (c) is a bogus address
 * Census cannot match: there is no point to land on, so it is judged on
 * what the page does instead of on a distance, which is what made it
 * unfailable before (S2-3).
 */
const cases = [
  {
    id: 'a-testpoint',
    query: '601 E Main St, Johnson City, TN',
    expected: { lat: 36.320692, lon: -82.342509, source: 'hardcoded' },
    expectSuccess: true,
  },
  {
    id: 'b-ponce',
    query: '675 Ponce de Leon Ave NE, Atlanta, GA',
    expected: null,
    expectSuccess: true,
  },
  // High ground (about 700 m): the old oblique landing missed by the most here.
  {
    id: 'd-fries-high',
    query: '100 Main St, Fries, VA 24330',
    expected: null,
    expectSuccess: true,
  },
  // Near sea level: a landing that only works at h=0 would pass here alone.
  {
    id: 'e-miami-coastal',
    query: '100 Ocean Dr, Miami Beach, FL 33139',
    expected: null,
    expectSuccess: true,
  },
  {
    id: 'c-negative-bogus',
    query: '99999 Nowhere Blvd, Faketown, ZZ',
    expected: null,
    expectSuccess: false,
  },
];

/** Census's own answer for an address, straight from census.gov (null = no match). */
async function censusPoint(address) {
  const url = new URL(CENSUS);
  url.searchParams.set('address', address);
  url.searchParams.set('benchmark', 'Public_AR_Current');
  url.searchParams.set('vintage', 'Current_Current');
  url.searchParams.set('format', 'json');
  const response = await fetch(url, {
    headers: { 'User-Agent': 'gods-eye-cre-qa/0.1' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Census HTTP ${response.status}`);
  const match = (await response.json())?.result?.addressMatches?.[0];
  if (!match) return null;
  return {
    lat: match.coordinates.y,
    lon: match.coordinates.x,
    source: 'census-live',
    matchedAddress: match.matchedAddress,
  };
}

function readHash(href) {
  const params = new URLSearchParams(new URL(href).hash.slice(1));
  const num = (key) => {
    const value = Number(params.get(key));
    return params.has(key) && Number.isFinite(value) ? value : null;
  };
  return {
    lat: num('lat'),
    lon: num('lon'),
    alt: num('alt'),
    pitch: num('pitch'),
  };
}

/** The overlay and camera probe, read straight off the page. */
const readOverlay = (page) => page.evaluate(`(${probeSiteOverlay})()`);

/** The dossier DOM, read through the same checker the dossier harness uses. */
const readDossier = (page) =>
  page.evaluate(
    `(${snapshotDossierDom})(document, ${JSON.stringify(DOSSIER_ATTR)})`,
  );

const distanceXyz = (a, b) =>
  a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : null;

/** Wait for the camera to hold still, so a move measurement means the search. */
async function cameraQuiet(page, { steps = 30, stepMs = 1000, epsilon = 0.5 }) {
  let last = (await readOverlay(page)).camera;
  for (let i = 0; i < steps; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, stepMs));
    const now = (await readOverlay(page)).camera;
    const drift = distanceXyz(now, last);
    last = now;
    if (Number.isFinite(drift) && drift < epsilon) return { quiet: true, last };
  }
  return { quiet: false, last };
}

async function settle(page, { minMs = 4000, quietMs = 3000, maxMs = 60_000 }) {
  const start = Date.now();
  let last = '';
  let stableSince = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const hash = JSON.stringify(readHash(page.url()));
    if (hash !== last) {
      last = hash;
      stableSince = Date.now();
    } else if (
      Date.now() - start >= minMs &&
      Date.now() - stableSince >= quietMs
    )
      return true;
  }
  return false;
}

/** Viewports every case runs at: desktop (panel on the left) and phone (bottom sheet). */
const viewports = (process.env.QA_VIEWPORTS || '1440x900,390x844')
  .split(',')
  .map((spec) => {
    const [width, height] = spec.split('x').map(Number);
    return { width, height, label: spec };
  });
const only = process.env.QA_CASES
  ? new Set(process.env.QA_CASES.split(','))
  : null;
/**
 * Negative-test switch: break the page on purpose right before the
 * assertions read it, so this harness can be watched failing on a known-bad
 * state. Every case is expected to FAIL under a fault.
 */
const fault = process.env.QA_FAULT || '';
if (fault && !QA_FAULTS.includes(fault))
  throw new Error(`QA_FAULT must be one of ${QA_FAULTS.join(', ')}`);

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});
let unexpected = 0;
try {
  for (const item of cases) {
    if (only && !only.has(item.id)) continue;
    if (!item.expected && item.expectSuccess) {
      item.expected = await censusPoint(item.query).catch(() => null);
      if (!item.expected) {
        unexpected++;
        console.log(
          JSON.stringify({
            case: item.id,
            verdict: 'FAIL',
            reason: 'census.gov gave no reference point, cannot verify',
          }),
        );
        continue;
      }
    }
    for (const viewport of viewports) {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.setViewport({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto(`${origin}/?mode=cre&welcome=0`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      await page.waitForSelector('#location-search', { timeout: 60_000 });
      await page.waitForFunction(() => window.__godsEyeView?.viewer, {
        timeout: 60_000,
      });
      await page.waitForFunction(
        () =>
          new URLSearchParams(location.hash.slice(1)).has('lat') &&
          document
            .getElementById('loading-screen')
            ?.classList.contains('hidden'),
        { timeout: 60_000 },
      );
      // The boot flight is still running when the page is ready; hold until
      // the camera stops so "did it move" measures the search alone. This
      // runs BEFORE the query is typed: waiting 30 s with text already in the
      // box drops focus, and Enter then reaches nothing.
      const boot = await cameraQuiet(page, {});
      const cameraBefore = boot.last;
      const searchVisible = () =>
        page.$eval('#location-search', (input) => input.offsetParent !== null);
      if (!(await searchVisible()))
        await page.click('#location-bar-toggle').catch(() => {});
      if (!(await searchVisible()))
        await page.click('#search-toggle').catch(() => {});
      await page.waitForSelector('#location-search', { visible: true });
      await page.$eval('#location-search', (input) => {
        input.value = '';
        input.focus();
      });
      await page.type('#location-search', item.query);
      const prior = readHash(page.url());
      await page.keyboard.press('Enter');
      // The flight starts only after geocoding, which can take seconds; wait
      // for the camera to leave before timing a settle.
      await page
        .waitForFunction(
          (lat, lon) => {
            const hash = new URLSearchParams(location.hash.slice(1));
            return (
              Number(hash.get('lat')) !== lat || Number(hash.get('lon')) !== lon
            );
          },
          { timeout: 30_000, polling: 250 },
          prior.lat,
          prior.lon,
        )
        .catch(() => {});
      const settled = await settle(page, {});
      // Let the dossier fill so a bottom sheet has grown to its full height.
      const dossierSettled = await page
        .waitForFunction(
          (states) =>
            states.includes(
              document
                .getElementById('dossier-panel')
                ?.getAttribute('data-dossier-state'),
            ),
          { timeout: 30_000, polling: 500 },
          TERMINAL_STATES,
        )
        .then(() => true)
        .catch(() => false);
      if (fault) {
        const at = item.expected
          ? { lat: item.expected.lat, lon: item.expected.lon }
          : null;
        const applied = await page.evaluate(
          `(${applyPageFault})(${JSON.stringify(fault)}, ${JSON.stringify(at)})`,
        );
        if (!applied.applied)
          throw new Error(`fault "${fault}" not applied: ${applied.why}`);
      }
      const camera = readHash(page.url());
      const snapshot = await readDossier(page);
      const ready = readyValueCount(snapshot);
      const overlay = await readOverlay(page);
      const movedM = distanceXyz(overlay.camera, cameraBefore);
      const expected = item.expected;
      let screen = null;
      let target = null;
      let distance = null;
      let verdict = null;

      if (item.expectSuccess) {
        const probe = await page.evaluate(
          `(${probeSiteScreen})(${expected.lat}, ${expected.lon})`,
        );
        screen = judgeSiteOnScreen(probe);
        screen.range_m = probe?.rangeM ?? null;
        screen.height_m = probe?.heightM ?? null;
        screen.height_source = probe?.heightSource ?? null;
        const area = screen.area;
        if (area && Number.isFinite(probe?.heightM)) {
          target = await page.evaluate(
            `(${probeAimPoint})(${probe.heightM}, ${JSON.stringify({
              x: (area.left + area.right) / 2,
              y: (area.top + area.bottom) / 2,
            })})`,
          );
        }
        distance = target
          ? haversineM(target.lat, target.lon, expected.lat, expected.lon)
          : null;
        verdict = judgeLanding(
          { distanceM: distance, rangeM: probe?.rangeM ?? null, screen },
          { maxMissM: MAX_MISS, maxRangeM: MAX_RANGE },
        );
        if (verdict.ok && !settled)
          verdict = { ok: false, reason: 'camera never settled' };
        if (verdict.ok && !dossierSettled)
          verdict = { ok: false, reason: 'dossier never reached a final state' };
        if (verdict.ok && !SETTLED_STATES.includes(snapshot?.state))
          verdict = {
            ok: false,
            reason: `dossier state "${snapshot?.state}" on an address Census matched`,
          };
        if (verdict.ok && ready < MIN_READY_SECTIONS)
          verdict = {
            ok: false,
            reason: `${ready} sections ready with real values, need ${MIN_READY_SECTIONS}`,
          };
        if (verdict.ok && overlay.pinCount !== 1)
          verdict = {
            ok: false,
            reason: `expected exactly 1 site pin, found ${overlay.pinCount}`,
          };
      } else {
        verdict = judgeNoMatch(
          {
            state: snapshot?.state,
            ready,
            movedM,
            pinCount: overlay.pinCount,
            overlayError: overlay.error,
          },
          { maxMoveM: MAX_NO_MATCH_MOVE_M },
        );
        if (verdict.ok && !dossierSettled)
          verdict = { ok: false, reason: 'dossier never reached a final state' };
      }
      if (verdict.ok && pageErrors.length)
        verdict = {
          ok: false,
          reason: `page errors: ${pageErrors.slice(0, 3).join(' | ')}`,
        };

      // The verdict already encodes what this case is supposed to do: land on
      // the site, or report no match and do nothing. A case passes only when
      // its verdict passes. Judging `success === expectSuccess` is what made
      // the negative case unfailable: every broken state gave success=false,
      // which matched, so it passed (S2-3).
      const asExpected = verdict.ok;
      if (!asExpected) unexpected++;
      console.log(
        JSON.stringify({
          case: item.id,
          fault: fault || null,
          viewport: viewport.label,
          query: item.query,
          expected_point: expected
            ? { lat: expected.lat, lon: expected.lon, source: expected.source }
            : null,
          landed: target
            ? {
                lat: Number(target.lat.toFixed(6)),
                lon: Number(target.lon.toFixed(6)),
              }
            : null,
          distance_m: distance == null ? null : Math.round(distance * 10) / 10,
          screen: screen
            ? {
                ok: screen.ok,
                pixel: screen.pixel,
                open_area: screen.area,
                range_m: screen.range_m,
                rendered_height_m: screen.height_m,
                height_source: screen.height_source,
                reason: screen.reason,
              }
            : null,
          dossier_state: snapshot?.state ?? null,
          ready_sections: ready,
          site_pins: overlay.pinCount ?? null,
          ring_entities: overlay.ringCount ?? null,
          camera_moved_m:
            movedM == null ? null : Math.round(movedM * 10) / 10,
          page_errors: pageErrors.length,
          alt: camera.alt,
          pitch: camera.pitch,
          settled,
          dossier_settled: dossierSettled,
          reason: verdict.reason,
          expect_success: item.expectSuccess,
          verdict: asExpected ? 'PASS' : 'FAIL',
        }),
      );
      await page.close();
    }
  }
} finally {
  await browser.close();
}
process.exitCode = unexpected ? 1 : 0;

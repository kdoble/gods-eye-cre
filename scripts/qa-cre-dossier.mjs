#!/usr/bin/env node
/** Headless dossier harness: types an address in CRE mode, waits for the dossier to settle, checks the camera actually landed on the site, prints the section table with seconds, exits 1 on failure. */
import puppeteer from 'puppeteer';
import {
  snapshotDossierDom,
  judgeDossier,
  readyValueCount,
  isEligibleReadySection,
  DOSSIER_ATTR,
} from './qa-cre-dossier-check.mjs';
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

/**
 * Landing limits. Overridable so the assertions themselves can be watched
 * firing on a good build: QA_MAX_RANGE_M=100 makes the real 661 m landing
 * fail, which proves the range check is wired and not decorative.
 */
const MAX_MISS = Number(process.env.QA_MAX_MISS_M || MAX_MISS_M);
const MAX_RANGE = Number(process.env.QA_MAX_RANGE_M || MAX_RANGE_M);

/** A no-match search may not move the camera further than this. */
const MAX_NO_MATCH_MOVE_M = 50;

/** Census's own point for an address, fetched from census.gov, not through the app. */
async function censusPoint(address) {
  const url = new URL(
    'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress',
  );
  url.searchParams.set('address', address);
  url.searchParams.set('benchmark', 'Public_AR_Current');
  url.searchParams.set('format', 'json');
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Census HTTP ${response.status}`);
  const match = (await response.json())?.result?.addressMatches?.[0];
  return match ? { lat: match.coordinates.y, lon: match.coordinates.x } : null;
}

function parseArgs(argv) {
  const args = {
    url: process.env.QA_BASE_URL || 'http://localhost:4173',
    address: '601 E Main St, Johnson City, TN',
    minSections: 8,
    timeoutMs: 20000,
    negative: false,
    fault: '',
    screenshot: '',
    expect: null,
    viewport: { width: 1440, height: 900 },
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === '--url') args.url = next();
    else if (flag === '--address') args.address = next();
    else if (flag === '--min-sections') args.minSections = Number(next());
    else if (flag === '--timeout-ms') args.timeoutMs = Number(next());
    else if (flag === '--negative') args.negative = true;
    else if (flag === '--fault') args.fault = next();
    else if (flag === '--screenshot') args.screenshot = next();
    else if (flag === '--expect') {
      const [lat, lon] = next().split(',').map(Number);
      args.expect = { lat, lon };
    } else if (flag === '--viewport') {
      const [width, height] = next().split('x').map(Number);
      args.viewport = { width, height };
    } else throw new Error(`Unknown flag ${flag}`);
  }
  if (args.negative && !argv.includes('--address'))
    args.address = 'zzzz qqqq 99999 nowhere';
  if (args.fault && !QA_FAULTS.includes(args.fault))
    throw new Error(`--fault must be one of ${QA_FAULTS.join(', ')}`);
  return args;
}

const args = parseArgs(process.argv.slice(2));
const target = new URL(args.url);
target.searchParams.set('mode', 'cre');
target.searchParams.set('welcome', '0');

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});
let exitCode = 1;
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewport(args.viewport);
  await page.goto(target.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__godsEyeView &&
      window.__creDossier &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  const overlay = () => page.evaluate(`(${probeSiteOverlay})()`);
  const camera = async () => (await overlay()).camera;
  const drift = (a, b) =>
    a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity;
  /** Hold until the camera stops. Returns false when it never did. */
  const holdStill = async (steps, stepMs) => {
    let last = await camera();
    for (let i = 0; i < steps; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, stepMs));
      const now = await camera();
      const moved = drift(now, last);
      last = now;
      if (moved < 0.5) return { still: true, at: last };
    }
    return { still: false, at: last };
  };
  // The boot flight is still running when the page is ready; wait for the
  // camera to hold still so the no-move check measures the search alone.
  const boot = await holdStill(30, 1000);
  const before = boot.at;

  await page.click('#location-search', { clickCount: 3 });
  await page.type('#location-search', args.address);
  const started = Date.now();
  await page.keyboard.press('Enter');

  const firstSettled = new Map();
  let snap = null;
  // snapshotDossierDom is self-contained, so its source runs in the page.
  const probe = `(${snapshotDossierDom})(document, ${JSON.stringify(DOSSIER_ATTR)})`;
  let dossierSettled = false;
  let timeToEightEligibleSeconds = null;
  let allSettledSeconds = null;
  while (Date.now() - started < args.timeoutMs) {
    snap = await page.evaluate(probe);
    const elapsed = (Date.now() - started) / 1000;
    for (const section of snap.sections) {
      if (section.status !== 'loading' && !firstSettled.has(section.id))
        firstSettled.set(section.id, elapsed);
    }
    if (timeToEightEligibleSeconds === null && readyValueCount(snap) >= 8)
      timeToEightEligibleSeconds = elapsed;
    if (['no-match','outside-us','error'].includes(snap.state)) {
      dossierSettled = true;
      allSettledSeconds = elapsed;
      break;
    }
    if (
      (snap.state === 'ready' || snap.state === 'partial') &&
      snap.sections.length
    ) {
      dossierSettled = true;
      allSettledSeconds = elapsed;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const totalSeconds = (Date.now() - started) / 1000;
  // Let the flight land before anything is measured, so a fault is injected
  // into a settled page and the measurements mean what they say.
  const flight = await holdStill(20, 500);

  // Negative-test switch: break the page on purpose right after it settles
  // and before the assertions read it, so this harness can be watched
  // failing on a known-bad state instead of trusted because it says PASS.
  if (args.fault) {
    const applied = await page.evaluate(
      `(${applyPageFault})(${JSON.stringify(args.fault)}, ${JSON.stringify(args.expect)})`,
    );
    if (!applied.applied)
      throw new Error(`fault "${args.fault}" not applied: ${applied.why}`);
    snap = await page.evaluate(probe);
    console.log(`fault injected: ${args.fault} ${JSON.stringify(applied)}`);
  }

  console.log(`address: ${args.address}`);
  console.log(`mode: ${args.negative ? 'negative' : 'positive'}`);
  console.log(`state: ${snap?.state}`);
  console.log(`time to 8 eligible sections: ${timeToEightEligibleSeconds === null ? 'not reached' : `${timeToEightEligibleSeconds.toFixed(1)} s`}`);
  console.log(`time to all-settled dossier: ${allSettledSeconds === null ? `not reached within ${totalSeconds.toFixed(1)} s` : `${allSettledSeconds.toFixed(1)} s`}`);
  console.log('section            status        counts  seconds  first value');
  for (const section of snap?.sections || []) {
    const seconds = firstSettled.has(section.id)
      ? firstSettled.get(section.id).toFixed(1)
      : '-';
    console.log(
      `${section.id.padEnd(18)} ${String(section.status).padEnd(13)} ${(isEligibleReadySection(section) ? 'yes' : 'no').padEnd(6)} ${seconds.padStart(7)}  ${(section.values[0] || '').slice(0, 40)}`,
    );
  }

  let verdict;
  if (args.negative) {
    const after = await overlay();
    const moved = drift(after.camera, before);
    console.log(
      `camera moved: ${moved.toFixed(2)} m, site pins: ${after.pinCount}`,
    );
    verdict = judgeDossier(snap, { negative: true });
    if (verdict.ok)
      verdict = judgeNoMatch(
        {
          state: snap?.state,
          ready: readyValueCount(snap),
          movedM: moved,
          pinCount: after.pinCount,
          overlayError: after.error,
        },
        { maxMoveM: MAX_NO_MATCH_MOVE_M },
      );
  } else {
    verdict = judgeDossier(snap, { minSections: args.minSections });
    // Where the pin is on screen AND how far the camera is aimed from the
    // site (B1-01, B1-02, B2-03). Without the distance the tester could fly
    // 5,600 km straight up and still be judged PASS. The reference point
    // comes from census.gov or --expect, never the app.
    const expected =
      args.expect || (await censusPoint(args.address).catch(() => null));
    let screen = null;
    let distanceM = null;
    let rangeM = null;
    let landed = null;
    if (expected) {
      if (!flight.still)
        console.log('camera never stopped flying before the measurement');
      const probed = await page.evaluate(
        `(${probeSiteScreen})(${expected.lat}, ${expected.lon})`,
      );
      screen = judgeSiteOnScreen(probed);
      const area = screen.area;
      if (area && Number.isFinite(probed?.heightM)) {
        landed = await page.evaluate(
          `(${probeAimPoint})(${probed.heightM}, ${JSON.stringify({
            x: (area.left + area.right) / 2,
            y: (area.top + area.bottom) / 2,
          })})`,
        );
      }
      if (landed)
        distanceM = haversineM(
          landed.lat,
          landed.lon,
          expected.lat,
          expected.lon,
        );
      rangeM = probed?.rangeM ?? null;
    } else {
      screen = { ok: false, reason: 'no census.gov reference point' };
    }
    const landing = judgeLanding(
      { distanceM, rangeM, screen },
      { maxMissM: MAX_MISS, maxRangeM: MAX_RANGE },
    );
    console.log(
      `landing: ${landing.ok ? 'yes' : 'no'}, ${landing.reason} (aimed at ${
        landed
          ? `${landed.lat.toFixed(6)}, ${landed.lon.toFixed(6)}`
          : 'nothing'
      })`,
    );
    if (verdict.ok && !landing.ok)
      verdict = { ...verdict, ok: false, reason: landing.reason };
    if (verdict.ok && !dossierSettled)
      verdict = {
        ...verdict,
        ok: false,
        reason: `dossier never settled within ${args.timeoutMs} ms`,
      };
    if (verdict.ok && !flight.still)
      verdict = {
        ...verdict,
        ok: false,
        reason: 'camera never stopped flying',
      };
  }
  if (pageErrors.length) {
    console.log(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
    if (verdict.ok)
      verdict = {
        ...verdict,
        ok: false,
        reason: `page errors: ${pageErrors.slice(0, 3).join(' | ')}`,
      };
  }
  if (args.screenshot) await page.screenshot({ path: args.screenshot });
  console.log(`${verdict.ok ? 'PASS' : 'FAIL'}: ${verdict.reason}`);
  exitCode = verdict.ok ? 0 : 1;
} catch (error) {
  console.log(`FAIL: harness could not complete: ${error.message}`);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);

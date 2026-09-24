// Screen-space landing judge tests: a pin in the open map passes; a pin off screen, under the panel or bottom sheet, behind the camera, or with no rendered height fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineM,
  judgeLanding,
  judgeNoMatch,
  judgeSiteOnScreen,
  openMapArea,
} from '../../scripts/qa-cre-screen-check.mjs';

const DESKTOP = { left: 0, top: 0, right: 1440, bottom: 900 };
const DESK_PANEL = { left: 12, top: 60, right: 452, bottom: 880 };
const PHONE = { left: 0, top: 0, right: 390, bottom: 844 };
const SHEET = { left: 8, top: 375, right: 382, bottom: 814 };

const probe = (x, y, canvas = DESKTOP, panel = DESK_PANEL, extra = {}) => ({
  pixel: { x, y },
  canvas,
  panel,
  inFront: true,
  heightM: 0,
  ...extra,
});

test('open area is the biggest strip beside the panel', () => {
  assert.deepEqual(openMapArea(DESKTOP, DESK_PANEL), {
    ...DESKTOP,
    left: 452,
  });
  assert.deepEqual(openMapArea(PHONE, SHEET), { ...PHONE, bottom: 375 });
  assert.deepEqual(openMapArea(DESKTOP, null), DESKTOP);
});

test('pass: pin in the middle of the open map, desktop and phone', () => {
  assert.equal(judgeSiteOnScreen(probe(946, 450)).ok, true);
  assert.equal(judgeSiteOnScreen(probe(195, 203, PHONE, SHEET)).ok, true);
});

test('negative: the beta B1-01 landing (pin at 720, 1071 on 900 px) fails', () => {
  const verdict = judgeSiteOnScreen(probe(720, 1071));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /outside the open map area/);
});

test('negative: pin under the desktop panel fails', () => {
  assert.equal(judgeSiteOnScreen(probe(300, 450)).ok, false);
});

test('negative: pin under the phone bottom sheet fails', () => {
  const verdict = judgeSiteOnScreen(probe(195, 644, PHONE, SHEET));
  assert.equal(verdict.ok, false);
});

test('negative: visible but far from the open map centre fails', () => {
  // Screen centre with a 452 px panel: 226 px off, limit 198.
  const verdict = judgeSiteOnScreen(probe(720, 450));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /from the open map center/);
});

test('negative: missing measurements are a FAIL, never a pass', () => {
  assert.equal(judgeSiteOnScreen(null).ok, false);
  assert.equal(
    judgeSiteOnScreen({ error: 'rendered ground height unavailable' }).ok,
    false,
  );
  assert.equal(
    judgeSiteOnScreen({ ...probe(946, 450), pixel: null }).ok,
    false,
  );
  assert.equal(
    judgeSiteOnScreen(probe(946, 450, DESKTOP, DESK_PANEL, { inFront: false }))
      .ok,
    false,
  );
  assert.equal(judgeSiteOnScreen(probe(NaN, 450)).ok, false);
});

test('negative: pin covered by other chrome (a dock) fails', () => {
  const verdict = judgeSiteOnScreen(
    probe(946, 450, DESKTOP, DESK_PANEL, { coveredBy: 'command-dock' }),
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /covered by command-dock/);
});

test('haversine matches an independently derived separation', () => {
  // One degree of latitude on the mean-radius sphere: R * pi / 180.
  const degree = (6_371_008.8 * Math.PI) / 180;
  assert.ok(
    Math.abs(haversineM(0, 0, 1, 0) - degree) < 0.01,
    String(haversineM(0, 0, 1, 0)),
  );
  // Johnson City test point to Ponce City Market, about 338 km great circle.
  const km = haversineM(36.320692, -82.342509, 33.77191, -84.36562) / 1000;
  assert.ok(Math.abs(km - 338) < 2, `${km.toFixed(1)} km`);
  assert.equal(haversineM(36.3, -82.3, 36.3, -82.3), 0);
});

const onScreen = { ok: true, reason: 'site pin at (947, 450)' };

test('judgeLanding passes only when aim, range and pin all hold', () => {
  assert.equal(
    judgeLanding({ distanceM: 12, rangeM: 650, screen: onScreen }).ok,
    true,
  );
});

test('NEGATIVE: the B2-03 flight (5,600 km straight up) fails the landing', () => {
  // The tester drove the camera 5,600 km up over the test site and the
  // dossier harness returned PASS. A nadir camera flown straight up keeps the pin
  // dead centre and the aim point unmoved, so only the range catches it.
  const verdict = judgeLanding({
    distanceM: 2,
    rangeM: 5_600_650,
    screen: onScreen,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /5600650 m from the site, limit 5000 m/);
});

test('NEGATIVE: an aim that misses the site fails however close the camera is', () => {
  const verdict = judgeLanding({
    distanceM: 1_032_367,
    rangeM: 650,
    screen: onScreen,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /aimed 1032367 m from the site, limit 75 m/);
});

test('NEGATIVE: a missing measurement is a FAIL, never a pass', () => {
  const ok = { distanceM: 5, rangeM: 650, screen: onScreen };
  assert.equal(judgeLanding({ ...ok, distanceM: null }).ok, false);
  assert.equal(judgeLanding({ ...ok, distanceM: NaN }).ok, false);
  assert.equal(judgeLanding({ ...ok, rangeM: null }).ok, false);
  assert.equal(judgeLanding({ ...ok, screen: null }).ok, false);
  assert.equal(judgeLanding({}).ok, false);
  assert.equal(
    judgeLanding({ ...ok, screen: { ok: false, reason: 'off screen' } }).ok,
    false,
  );
});

const noMatch = {
  state: 'no-match',
  ready: 0,
  movedM: 0,
  pinCount: 0,
  overlayError: null,
};

test('judgeNoMatch passes when the app reports no match and does nothing', () => {
  assert.equal(judgeNoMatch(noMatch).ok, true);
  assert.equal(judgeNoMatch({ ...noMatch, state: 'outside-us' }).ok, true);
});

test('NEGATIVE: a no-match search that flies, pins or renders values fails', () => {
  const cases = [
    [{ ...noMatch, state: 'ready' }, /expected the dossier to report/],
    [{ ...noMatch, ready: 11 }, /11 sections still render real values/],
    [{ ...noMatch, movedM: 5_600_000 }, /camera flew 5600000 m/],
    [{ ...noMatch, pinCount: 1 }, /1 site pin/],
    [{ ...noMatch, overlayError: 'CRE overlay source missing' }, /overlay unreadable/],
  ];
  for (const [observed, pattern] of cases) {
    const verdict = judgeNoMatch(observed);
    assert.equal(verdict.ok, false, JSON.stringify(observed));
    assert.match(verdict.reason, pattern);
  }
});

test('NEGATIVE: an unmeasured negative case cannot pass', () => {
  // The S2-3 defect: every measurement null and the harness said PASS.
  assert.equal(judgeNoMatch({}).ok, false);
  assert.equal(judgeNoMatch({ ...noMatch, ready: null }).ok, false);
  assert.equal(judgeNoMatch({ ...noMatch, movedM: null }).ok, false);
  assert.equal(judgeNoMatch({ ...noMatch, pinCount: null }).ok, false);
});

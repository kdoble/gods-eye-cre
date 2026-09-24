// Site view plan tests: straight down over the site on wide screens (so the landing check holds at any ground height), shifted south on phones so the site clears the bottom sheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  siteViewPlan,
  SITE_VIEW_HEIGHT_M,
  SITE_VIEW_HEIGHT_NARROW_M,
  NARROW_SITE_SCREEN_Y,
  wideSiteScreenX,
  areaFramePlan,
} from './landing.js';
import { haversineMeters } from './geo.js';

const SITE = { lat: 36.320692, lon: -82.342509 };

test('wide: straight down over the site, height above the drawn ground', () => {
  const flat = siteViewPlan(SITE);
  assert.equal(flat.pitchDeg, -90);
  assert.equal(flat.heading, 0);
  assert.equal(flat.lat, SITE.lat);
  assert.equal(flat.lon, SITE.lon);
  assert.equal(flat.height, SITE_VIEW_HEIGHT_M);
  const terrain = siteViewPlan(SITE, { groundM: 503 });
  assert.equal(terrain.height, 503 + SITE_VIEW_HEIGHT_M);
  assert.equal(siteViewPlan(SITE, { groundM: NaN }).height, SITE_VIEW_HEIGHT_M);
});

test('narrow: camera slides due south so the site sits in the upper screen', () => {
  const plan = siteViewPlan(SITE, { narrow: true });
  assert.equal(plan.pitchDeg, -90);
  assert.ok(plan.lat < SITE.lat, 'south of the site');
  assert.ok(Math.abs(plan.lon - SITE.lon) < 1e-9, 'due south');
  const expected =
    (0.5 - NARROW_SITE_SCREEN_Y) *
    2 *
    SITE_VIEW_HEIGHT_NARROW_M *
    Math.tan(Math.PI / 6);
  const moved = haversineMeters(plan.lat, plan.lon, SITE.lat, SITE.lon);
  assert.ok(Math.abs(moved - expected) < 1, `${moved} vs ${expected}`);
});

test('wide: the site sits in the middle of the map right of the panel', () => {
  // 1440 px canvas, panel right edge at 452 px: open strip 452..1440.
  const screenX = wideSiteScreenX(1440, 452);
  assert.ok(Math.abs(screenX * 1440 - 946) < 0.5, `${screenX * 1440}`);
  const plan = siteViewPlan(SITE, { screenX });
  assert.ok(plan.lon < SITE.lon, 'camera west of the site');
  assert.ok(Math.abs(plan.lat - SITE.lat) < 1e-6, 'due west');
  const span = 2 * SITE_VIEW_HEIGHT_M * Math.tan(Math.PI / 6);
  const moved = haversineMeters(plan.lat, plan.lon, SITE.lat, SITE.lon);
  const expected = (screenX - 0.5) * span;
  assert.ok(Math.abs(moved - expected) < 1, `${moved} vs ${expected}`);
  // Site pixel implied by the plan: 720 px + moved / (span / 1440).
  const sitePx = 720 + moved / (span / 1440);
  assert.ok(Math.abs(sitePx - 946) < 1, `${sitePx}`);
});

test('wide: no panel, or a panel wider than 60 percent, keeps the site centred', () => {
  assert.equal(wideSiteScreenX(1440, 0), 0.5);
  assert.equal(wideSiteScreenX(1440, 1000), 0.5);
  assert.equal(wideSiteScreenX(0, 452), 0.5);
  const plan = siteViewPlan(SITE, { screenX: 0.5 });
  assert.equal(plan.lon, SITE.lon);
});

test('study ring framing clears the dossier at 990 and 1440 px wide', () => {
  const radius = 1609.344 * 1.1;
  for (const [width, height, panelRight] of [
    [990, 872, 452],
    [1440, 900, 452],
  ]) {
    const plan = areaFramePlan(width, height, panelRight, radius);
    const apparentDiameter = (0.9 * height * radius) / plan.fitRadiusM;
    const left = plan.screenX * width - apparentDiameter / 2;
    const right = plan.screenX * width + apparentDiameter / 2;
    assert.ok(left >= panelRight + 20, `${width}px ring starts at ${left}`);
    assert.ok(right <= width - 20, `${width}px ring ends at ${right}`);
    assert.ok(plan.westShiftM > 0);
  }
});

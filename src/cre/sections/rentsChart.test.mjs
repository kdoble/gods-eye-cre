// Tests for the rent trend sparkline (feature 2): scaling, gap handling
// (a missing month breaks the line instead of drawing a false zero), the
// accessible summary text, and the DOM node build.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildZoriChartNode,
  monthLabel,
  scaleZoriHistory,
  zoriSparklinePaths,
  zoriTrendSummary,
} from './rentsChart.js';
import { createFakeDocument } from '../testing/fakeDom.mjs';

const monthEnds = (count, startYear = 2023, startMonth = 9) => {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const d = new Date(Date.UTC(startYear, startMonth - 1 + i, 0));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

/** 36 rising months, 1800 to 2135, no gaps. */
function risingHistory() {
  const dates = monthEnds(36);
  return dates.map((date, i) => ({ date, value: 1800 + i * 10 }));
}

test('monthLabel formats an ISO month-end date and rejects garbage', () => {
  assert.equal(monthLabel('2026-08-31'), 'Aug 2026');
  assert.equal(monthLabel('not-a-date'), '');
  assert.equal(monthLabel(undefined), '');
});

test('scaleZoriHistory scales the min to the chart floor and the max to the ceiling', () => {
  const history = risingHistory();
  const dims = scaleZoriHistory(history, { width: 100, height: 50, padX: 0, padY: 0 });
  assert.equal(dims.min, 1800);
  assert.equal(dims.max, 1800 + 35 * 10);
  assert.equal(dims.runs.length, 1, 'one unbroken run');
  assert.equal(dims.runs[0].length, 36);
  const first = dims.runs[0][0];
  const last = dims.runs[0].at(-1);
  assert.equal(first.x, 0);
  assert.equal(last.x, 100);
  // Higher rent renders higher up (smaller y).
  assert.ok(last.y < first.y);
  assert.equal(Math.round(last.y), 0);
  assert.equal(Math.round(first.y), 50);
});

test('a missing month breaks the line into separate runs instead of a false zero', () => {
  const history = risingHistory();
  history[10] = { date: history[10].date, value: null };
  history[11] = { date: history[11].date, value: null };
  const dims = scaleZoriHistory(history);
  assert.equal(dims.runs.length, 2, 'the gap splits one run into two');
  assert.equal(dims.runs[0].length, 10);
  assert.equal(dims.runs[1].length, 24);
  // Neither run's point list ever contains a null-derived zero.
  for (const run of [...dims.runs[0], ...dims.runs[1]]) {
    assert.ok(Number.isFinite(run.value) && run.value > 0);
  }
});

test('NEGATIVE: fewer than two known months yields no runs, never a one-point or flat-zero chart', () => {
  assert.deepEqual(scaleZoriHistory([]).runs, []);
  assert.deepEqual(scaleZoriHistory([{ date: '2026-01-31', value: 1500 }]).runs, []);
  assert.deepEqual(
    scaleZoriHistory([
      { date: '2026-01-31', value: null },
      { date: '2026-02-28', value: null },
    ]).runs,
    [],
  );
});

test('zoriSparklinePaths returns one M...L path per run and skips single-point runs', () => {
  const history = risingHistory();
  history[5] = { date: history[5].date, value: null }; // isolates index 4 as a lone point on one side
  const paths = zoriSparklinePaths(history);
  assert.equal(paths.length, 2);
  for (const d of paths) {
    assert.match(d, /^M[\d.]+,[\d.]+( L[\d.]+,[\d.]+)+$/);
  }
});

test('zoriTrendSummary reads out the level and both changes', () => {
  const summary = zoriTrendSummary({
    zip: '30308',
    latest: { date: '2026-08-31', value: 2078.65 },
    change12mPct: 3.07,
    change36mPct: -1.38,
  });
  assert.match(summary, /ZIP 30308/);
  assert.match(summary, /\$2,079 per month/);
  assert.match(summary, /as of Aug 2026/);
  assert.match(summary, /up 3\.1% over 12 months/);
  assert.match(summary, /down 1\.4% over 36 months/);
});

test('zoriTrendSummary omits a change that is not a finite number, never "up NaN%"', () => {
  const summary = zoriTrendSummary({
    zip: '30308',
    latest: { date: '2026-08-31', value: 2000 },
    change12mPct: null,
    change36mPct: undefined,
  });
  assert.doesNotMatch(summary, /NaN/);
  assert.doesNotMatch(summary, /over 12 months/);
  assert.doesNotMatch(summary, /over 36 months/);
});

test('buildZoriChartNode draws a line, a latest-point dot, and an accessible fallback', () => {
  const doc = createFakeDocument();
  const history = risingHistory();
  const node = buildZoriChartNode(doc, {
    zip: '30308',
    history,
    latest: history.at(-1),
    change12mPct: 3.07,
    change36mPct: 1.38,
  });
  assert.ok(node);
  const svg = node.children.find((c) => c.tagName === 'SVG');
  assert.ok(svg, 'an svg element is present');
  assert.equal(svg.getAttribute('aria-hidden'), 'true');
  const path = svg.children.find((c) => c.tagName === 'PATH');
  assert.ok(path.getAttribute('d').startsWith('M'));
  const dot = svg.children.find((c) => c.tagName === 'CIRCLE');
  assert.ok(dot, 'the latest value gets a marker');
  const caption = node.children.find((c) => c.tagName === 'P');
  const hidden = caption.children.find((c) => c.className === 'cre-visually-hidden');
  assert.ok(hidden.getAttribute('aria-label').includes('ZIP 30308'));
  assert.match(hidden.textContent, /up 3\.1% over 12 months/);
});

test('NEGATIVE: buildZoriChartNode returns null when there is not enough history to draw', () => {
  const doc = createFakeDocument();
  assert.equal(buildZoriChartNode(doc, { history: [] }), null);
  assert.equal(
    buildZoriChartNode(doc, {
      history: [{ date: '2026-01-31', value: null }],
    }),
    null,
  );
});

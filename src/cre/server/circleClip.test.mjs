// Circle clip tests: a small shape inside counts in full, a shape covering the circle counts the circle, half a circle counts half, holes subtract, and no answer ever exceeds the circle.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  circleAcres,
  ringsAreaInCircleM2,
  SQ_M_PER_ACRE,
} from '../../../server/providers/cre/common/circleClip.js';

const C = { lat: 36.320692, lon: -82.342509, radiusM: 500 };
const M_PER_DEG_LAT = (Math.PI / 180) * 6_371_008.8;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((C.lat * Math.PI) / 180);

/** A ring from local meter offsets (east, north), closed, clockwise like ArcGIS. */
function ring(points) {
  const out = points.map(([e, n]) => [
    C.lon + e / M_PER_DEG_LON,
    C.lat + n / M_PER_DEG_LAT,
  ]);
  return [...out, out[0]];
}
const square = (half) =>
  ring([
    [-half, -half],
    [-half, half],
    [half, half],
    [half, -half],
  ]);
const circleM2 = Math.PI * 500 * 500;

test('a 100 m square inside the circle counts in full', () => {
  const area = ringsAreaInCircleM2([square(50)], C);
  assert.ok(Math.abs(area - 10_000) < 1, `${area}`);
});

test('a shape covering the circle counts the circle, not the shape', () => {
  const area = ringsAreaInCircleM2([square(5000)], C);
  assert.ok(area <= circleM2, `${area} over ${circleM2}`);
  assert.ok(area > circleM2 * 0.999, `${area}`);
});

test('the east half-plane counts half the circle', () => {
  const half = ring([
    [0, -2000],
    [0, 2000],
    [2000, 2000],
    [2000, -2000],
  ]);
  const area = ringsAreaInCircleM2([half], C);
  assert.ok(Math.abs(area - circleM2 / 2) < circleM2 * 0.001, `${area}`);
});

test('a hole subtracts, and orientation does not flip the sign', () => {
  const outer = square(200);
  const hole = [...square(100)].reverse();
  const area = ringsAreaInCircleM2([outer, hole], C);
  assert.ok(Math.abs(area - (160_000 - 40_000)) < 2, `${area}`);
  const flipped = ringsAreaInCircleM2([[...outer].reverse(), square(100)], C);
  assert.ok(Math.abs(flipped - area) < 1e-6);
});

test('a concave shape (an L) crossing the edge is clipped correctly', () => {
  // L: 1000 x 200 bar along the east axis plus a 200 x 1000 bar north.
  const ell = ring([
    [0, 0],
    [0, 1000],
    [200, 1000],
    [200, 200],
    [1000, 200],
    [1000, 0],
  ]);
  const area = ringsAreaInCircleM2([ell], C);
  // Inside the circle: the 200 x 200 corner plus two identical arms
  // clipped by the circle. Each arm: integral of y from 200 to sqrt(r^2-x^2)
  // over x in 0..200.
  const arm = (() => {
    let sum = 0;
    const steps = 20000;
    for (let i = 0; i < steps; i += 1) {
      const x = ((i + 0.5) / steps) * 200;
      sum += (Math.sqrt(500 * 500 - x * x) - 200) * (200 / steps);
    }
    return sum;
  })();
  const expected = 200 * 200 + 2 * arm;
  assert.ok(
    Math.abs(area - expected) < expected * 0.001,
    `${area} vs ${expected}`,
  );
});

test('NEGATIVE: acres greater than the circle are impossible', () => {
  const acres = ringsAreaInCircleM2([square(50_000)], C) / SQ_M_PER_ACRE;
  assert.ok(acres <= circleAcres(500), `${acres}`);
  // The unclipped shape is 2.47 million acres: a check on the clipped value
  // must reject the unclipped one.
  const unclipped = (100_000 * 100_000) / SQ_M_PER_ACRE;
  assert.equal(unclipped <= circleAcres(500), false);
  assert.ok(Math.abs(circleAcres(500) - 194.1) < 0.05);
});

test('bad input is zero, never NaN', () => {
  assert.equal(ringsAreaInCircleM2(null, C), 0);
  assert.equal(ringsAreaInCircleM2([[]], C), 0);
  assert.equal(ringsAreaInCircleM2([square(50_000).map(() => [0, 0])], C), 0);
});

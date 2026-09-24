// Tests for makeOptInRateLimiter's env-value parsing: unset/zero means unlimited on purpose, a typo'd non-numeric value must never silently disable a limiter that defaults to ON (N1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeOptInRateLimiter } from '../../../server/providers/common/rate-limit.js';

test('unset env value uses the default cap', () => {
  assert.notEqual(makeOptInRateLimiter(undefined, 120), null);
});

test('explicit "0" opts out to unlimited (a real, deliberate value)', () => {
  assert.equal(makeOptInRateLimiter('0', 120), null);
});

test('a positive integer overrides the default', () => {
  assert.notEqual(makeOptInRateLimiter('50', 120), null);
});

test('N1: a non-numeric env value (typo, e.g. "12O" with a letter O) falls back to the default cap, never disables the limiter', () => {
  const limiter = makeOptInRateLimiter('12O', 120);
  assert.notEqual(limiter, null, 'a typo must not silently open the limit');
  // The fallback really is the default cap: it allows exactly `defaultMax`
  // requests for one key in the window, then blocks the next.
  const key = 'test-ip';
  let allowedCount = 0;
  for (let i = 0; i < 121; i += 1) {
    if (limiter(key)) allowedCount += 1;
  }
  assert.equal(allowedCount, 120, 'the default (120), not unlimited');
});

test('NEGATIVE: whitespace-only counts as unset (uses the default), and plain garbage also falls back to the default, never unlimited', () => {
  assert.notEqual(makeOptInRateLimiter('   ', 120), null, 'whitespace-only is treated as unset, which defaults ON');
  assert.notEqual(makeOptInRateLimiter('abc', 120), null, 'a non-numeric string falls back to the default');
});

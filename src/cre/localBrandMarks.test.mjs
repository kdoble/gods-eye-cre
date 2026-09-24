// Tests for the client-side local-brand-mark resolver: neutral labels stay
// the default, a registered override swaps the image for a server file URL,
// and a failed/missing manifest fetch never breaks the neutral fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  brandMarkFor,
  loadLocalBrandMarkOverrides,
  setLocalBrandMarkOverridesForTest,
} from './localBrandMarks.js';

test.beforeEach(() => {
  setLocalBrandMarkOverridesForTest({});
});

test('unnamed or non-chain places stay unmarked', () => {
  assert.equal(brandMarkFor('Local Coffee Shop'), null);
  assert.equal(brandMarkFor(''), null);
});

test('a known chain with no override keeps the bundled neutral image', () => {
  const mark = brandMarkFor('Kroger');
  assert.equal(mark.overrideUrl, null);
  assert.ok(mark.image.startsWith('data:image/svg+xml,'));
});

test('a registered override swaps the image for the local file route, keyed correctly', () => {
  setLocalBrandMarkOverridesForTest({ kroger: 'kroger.png' });
  const kroger = brandMarkFor('Kroger Marketplace');
  assert.equal(kroger.overrideUrl, '/api/cre/local-brand-marks/kroger.png');
  assert.equal(kroger.image, '/api/cre/local-brand-marks/kroger.png');
  // A different chain with no override of its own stays neutral.
  const target = brandMarkFor('Target');
  assert.equal(target.overrideUrl, null);
  assert.ok(target.image.startsWith('data:image/svg+xml,'));
});

test('loadLocalBrandMarkOverrides adopts a successful manifest response', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, '/api/cre/local-brand-marks/manifest');
    return {
      ok: true,
      json: async () => ({ marks: { starbucks: 'starbucks.svg' } }),
    };
  };
  const result = await loadLocalBrandMarkOverrides({ fetchImpl });
  assert.deepEqual(result, { starbucks: 'starbucks.svg' });
  assert.equal(
    brandMarkFor('Starbucks').overrideUrl,
    '/api/cre/local-brand-marks/starbucks.svg',
  );
});

test('a failed fetch (production build, offline dev server) leaves prior overrides untouched', async () => {
  setLocalBrandMarkOverridesForTest({ walmart: 'walmart.png' });
  const throwingFetch = async () => {
    throw new Error('network down');
  };
  const result = await loadLocalBrandMarkOverrides({
    fetchImpl: throwingFetch,
  });
  assert.deepEqual(result, { walmart: 'walmart.png' });
  assert.equal(
    brandMarkFor('Walmart Supercenter').overrideUrl,
    '/api/cre/local-brand-marks/walmart.png',
  );
});

test('a non-ok response (e.g. production build with no route) is ignored, not adopted', async () => {
  setLocalBrandMarkOverridesForTest({ walgreens: 'walgreens.svg' });
  const notFoundFetch = async () => ({ ok: false });
  const result = await loadLocalBrandMarkOverrides({
    fetchImpl: notFoundFetch,
  });
  assert.deepEqual(result, { walgreens: 'walgreens.svg' });
});

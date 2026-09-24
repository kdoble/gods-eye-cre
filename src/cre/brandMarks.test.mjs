import test from 'node:test';
import assert from 'node:assert/strict';
import { brandMarkFor } from './brandMarks.js';

test('only fixed chain names receive original neutral labels', () => {
  for (const name of [
    'Starbucks',
    'Kroger',
    'Target',
    'Walmart Supercenter',
    'Walgreens Pharmacy',
  ]) {
    const mark = brandMarkFor(name);
    assert.ok(mark?.image.startsWith('data:image/svg+xml,'), name);
    assert.ok(mark.image.length < 16000, `${name} icon should stay small`);
  }
  assert.equal(brandMarkFor('Starbucks-ish'), null);
  assert.equal(brandMarkFor('New Kroger Apartments'), null);
  assert.equal(brandMarkFor('Local Coffee Shop'), null);
});

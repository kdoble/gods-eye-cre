// Tests for the CRE key reader, including the negative case that an empty environment reports missing keys without throwing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  creKeyStatus,
  readCreKey,
} from '../../../server/providers/cre/common/keys.js';

const NONE = { census: false, hud: false, dataGov: false };

test('NEGATIVE: an empty env reports every key missing and does not throw', () => {
  assert.deepEqual(creKeyStatus({}), NONE);
  assert.deepEqual(creKeyStatus(null), NONE);
  assert.equal(readCreKey('census', {}), null);
  assert.equal(readCreKey('census', null), null);
});

test('whitespace-only values count as missing', () => {
  assert.deepEqual(
    creKeyStatus({ CENSUS_API_KEY: '   ', HUD_API_TOKEN: '' }),
    NONE,
  );
});

test('status is booleans only and never carries the value', () => {
  const env = {
    CENSUS_API_KEY: 'c-secret',
    HUD_API_TOKEN: 'h-secret',
    DATA_GOV_API_KEY: 'd-secret',
  };
  const status = creKeyStatus(env);
  assert.deepEqual(status, { census: true, hud: true, dataGov: true });
  assert.ok(!JSON.stringify(status).includes('secret'));
});

test('readCreKey returns the trimmed value for server use and null for unknown ids', () => {
  assert.equal(readCreKey('hud', { HUD_API_TOKEN: ' tok ' }), 'tok');
  assert.equal(readCreKey('nope', { HUD_API_TOKEN: 'tok' }), null);
});

// Tests for the pinned upstream host guard every P6B provider wraps its fetch in: only https to an allowlisted host goes out; anything else throws before any request is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPinnedUrl,
  pinnedFetch,
  PinnedHostError,
} from '../../../server/providers/cre/common/pinnedHosts.js';

const HOSTS = new Set(['services.arcgis.com']);

test('an allowlisted https URL passes', () => {
  const url = 'https://services.arcgis.com/x/FeatureServer/0/query?f=json';
  assert.equal(assertPinnedUrl(url, HOSTS), url);
});

test('NEGATIVE: other hosts, lookalike hosts, http and credentials in the URL are refused', () => {
  for (const url of [
    'https://evil.example/x',
    'https://services.arcgis.com.evil.example/x',
    'http://services.arcgis.com/x',
    'https://user:pass@services.arcgis.com/x',
    'file:///etc/passwd',
    'not a url',
  ]) {
    assert.throws(() => assertPinnedUrl(url, HOSTS), PinnedHostError, url);
  }
});

test('NEGATIVE: pinnedFetch never calls the real fetch for a refused host', async () => {
  let called = 0;
  const guarded = pinnedFetch(HOSTS, async () => {
    called += 1;
    return new Response('{}');
  });
  await assert.rejects(guarded('https://evil.example/x'), PinnedHostError);
  assert.equal(called, 0);
  await guarded('https://services.arcgis.com/ok');
  assert.equal(called, 1);
});

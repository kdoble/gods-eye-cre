import test from 'node:test';
import assert from 'node:assert/strict';
import { isTflImageUrl } from '../server/providers/cctv/sources.js';

// SEC-04: the raw-string `startsWith` this replaced would pass a `/../`
// traversal straight through, because the string `.../jamcams.tfl.gov.uk/../evil-bucket/x.jpg`
// literally starts with the bucket prefix. Parsing collapses the `..`
// segment, so the pinned check must see the real (post-traversal) path.
test('rejects a path-traversal escape out of the TfL bucket prefix', () => {
  assert.equal(
    isTflImageUrl(
      'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/../evil-bucket/x.jpg',
    ),
    false,
  );
});

test('accepts a real frame URL on the official bucket', () => {
  assert.equal(
    isTflImageUrl(
      'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.00865.jpg',
    ),
    true,
  );
});

test('rejects a different bucket on the same shared S3 host', () => {
  assert.equal(
    isTflImageUrl('https://s3-eu-west-1.amazonaws.com/evil-bucket/x.jpg'),
    false,
  );
});

test('rejects a look-alike host', () => {
  assert.equal(
    isTflImageUrl(
      'https://s3-eu-west-1.amazonaws.com.evil.example/jamcams.tfl.gov.uk/x.jpg',
    ),
    false,
  );
});

test('rejects garbage input rather than throwing', () => {
  assert.equal(isTflImageUrl(''), false);
  assert.equal(isTflImageUrl(undefined), false);
  assert.equal(isTflImageUrl('not a url'), false);
});

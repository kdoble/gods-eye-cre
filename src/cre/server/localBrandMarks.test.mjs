// Tests for the local-brand-marks route: manifest reports only files present
// on disk, a known key with no file serves nothing, an unknown filename and a
// path-traversal attempt are both refused before touching the filesystem.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_BRAND_MARK_EXTENSIONS,
  createLocalBrandMarkHandlers,
  localBrandMarkManifest,
  resolveSafeBrandMarkFile,
} from '../../../server/providers/cre/localBrandMarks.js';
import { KNOWN_BRAND_MARK_KEYS } from '../brandMarks.js';

function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
      this.headersSent = true;
    },
    end(body = '') {
      this.body = body;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}
const req = (url, method = 'GET') => ({ url, method });

function tempSourceRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gev-brand-marks-'));
}

test('manifest lists only known keys with a file actually on disk', () => {
  const sourceRoot = tempSourceRoot();
  fs.mkdirSync(path.join(sourceRoot, 'local-brand-marks'));
  fs.writeFileSync(
    path.join(sourceRoot, 'local-brand-marks', 'kroger.png'),
    'fake-png-bytes',
  );
  const manifest = localBrandMarkManifest({ sourceRoot });
  assert.deepEqual(manifest, { kroger: 'kroger.png' });
  for (const key of KNOWN_BRAND_MARK_KEYS) {
    if (key !== 'kroger') assert.ok(!(key in manifest), key);
  }
});

test('manifest is empty when the folder does not exist at all', () => {
  const sourceRoot = tempSourceRoot();
  assert.deepEqual(localBrandMarkManifest({ sourceRoot }), {});
});

test('the manifest route serves the current manifest as JSON', () => {
  const sourceRoot = tempSourceRoot();
  fs.mkdirSync(path.join(sourceRoot, 'local-brand-marks'));
  fs.writeFileSync(
    path.join(sourceRoot, 'local-brand-marks', 'starbucks.svg'),
    '<svg></svg>',
  );
  const { manifest } = createLocalBrandMarkHandlers({ sourceRoot });
  const res = fakeRes();
  manifest(req('/api/cre/local-brand-marks/manifest'), res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { marks: { starbucks: 'starbucks.svg' } });
});

test('the file route serves an allowed known-key file with a nosniff header', () => {
  const sourceRoot = tempSourceRoot();
  fs.mkdirSync(path.join(sourceRoot, 'local-brand-marks'));
  fs.writeFileSync(
    path.join(sourceRoot, 'local-brand-marks', 'target.webp'),
    'fake-webp-bytes',
  );
  const { file } = createLocalBrandMarkHandlers({ sourceRoot });
  const res = fakeRes();
  file(req('/target.webp'), res);
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'image/webp');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.match(
    res.headers['Content-Security-Policy'],
    /^sandbox; default-src 'none'/,
  );
  assert.equal(res.body.toString('utf8'), 'fake-webp-bytes');
});

test('the file route 404s a known key with no file on disk', () => {
  const sourceRoot = tempSourceRoot();
  const { file } = createLocalBrandMarkHandlers({ sourceRoot });
  const res = fakeRes();
  file(req('/kroger.png'), res);
  assert.equal(res.status, 404);
});

test('the file route refuses a filename outside the known-key allowlist', () => {
  const sourceRoot = tempSourceRoot();
  fs.mkdirSync(path.join(sourceRoot, 'local-brand-marks'));
  fs.writeFileSync(
    path.join(sourceRoot, 'local-brand-marks', 'not-a-chain.png'),
    'x',
  );
  const { file } = createLocalBrandMarkHandlers({ sourceRoot });
  const res = fakeRes();
  file(req('/not-a-chain.png'), res);
  assert.equal(res.status, 404);
});

test('the file route refuses a disallowed extension even for a known key', () => {
  const sourceRoot = tempSourceRoot();
  fs.mkdirSync(path.join(sourceRoot, 'local-brand-marks'));
  fs.writeFileSync(
    path.join(sourceRoot, 'local-brand-marks', 'kroger.exe'),
    'x',
  );
  const { file } = createLocalBrandMarkHandlers({ sourceRoot });
  const res = fakeRes();
  file(req('/kroger.exe'), res);
  assert.equal(res.status, 404);
});

test('path traversal attempts never resolve to a file, even one that exists', () => {
  const sourceRoot = tempSourceRoot();
  fs.mkdirSync(path.join(sourceRoot, 'local-brand-marks'));
  // A real secret sitting one level up from the folder this route may read.
  fs.writeFileSync(path.join(sourceRoot, 'secret.env'), 'TOP_SECRET=1');
  const attempts = [
    '/../secret.env',
    '/..%2Fsecret.env',
    '/kroger.png/../../secret.env',
    '/%2e%2e/secret.env',
    '/kroger.png%00.exe',
  ];
  const { file } = createLocalBrandMarkHandlers({ sourceRoot });
  for (const attempt of attempts) {
    const res = fakeRes();
    file(req(attempt), res);
    assert.equal(res.status, 404, attempt);
    assert.ok(!res.body.includes('TOP_SECRET'), attempt);
  }
});

test('N2: a malformed percent-escape 404s instead of throwing a 500', () => {
  const sourceRoot = tempSourceRoot();
  fs.mkdirSync(path.join(sourceRoot, 'local-brand-marks'));
  const { file } = createLocalBrandMarkHandlers({ sourceRoot });
  // "%E0" alone is not valid UTF-8 (no continuation bytes); decodeURIComponent throws URIError.
  const res = fakeRes();
  file(req('/%E0'), res);
  assert.equal(res.status, 404);
  assert.doesNotThrow(() => file(req('/%E0'), fakeRes()));
});

test('resolveSafeBrandMarkFile rejects anything not an exact known filename', () => {
  const sourceRoot = tempSourceRoot();
  assert.equal(resolveSafeBrandMarkFile(sourceRoot, '../etc/passwd'), null);
  assert.equal(resolveSafeBrandMarkFile(sourceRoot, 'kroger.png/../x'), null);
  assert.equal(resolveSafeBrandMarkFile(sourceRoot, 'kroger'), null);
  assert.equal(resolveSafeBrandMarkFile(sourceRoot, 'kroger.png.exe'), null);
  assert.equal(resolveSafeBrandMarkFile(sourceRoot, ''), null);
  assert.ok(
    resolveSafeBrandMarkFile(sourceRoot, 'kroger.png').endsWith(
      path.join('local-brand-marks', 'kroger.png'),
    ),
  );
});

test('every known extension maps to a real content type', () => {
  for (const ext of Object.keys(ALLOWED_BRAND_MARK_EXTENSIONS)) {
    assert.ok(ALLOWED_BRAND_MARK_EXTENSIONS[ext].startsWith('image/'), ext);
  }
});

test('non-GET requests are refused on both routes', () => {
  const sourceRoot = tempSourceRoot();
  const { manifest, file } = createLocalBrandMarkHandlers({ sourceRoot });
  for (const handler of [manifest, file]) {
    const res = fakeRes();
    handler(req('/kroger.png', 'POST'), res);
    assert.equal(res.status, 405);
  }
});

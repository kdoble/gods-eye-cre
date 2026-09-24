import test from 'node:test';
import assert from 'node:assert/strict';
import { apiOriginGuardPlugin } from '../server/standalone/api-origin-guard.js';

/** Minimal fake Vite plugin container: captures the one middleware the guard installs. */
function install(plugin, hookName) {
  let handler;
  const middlewares = {
    use(mountPath, fn) {
      assert.equal(mountPath, '/api');
      handler = fn;
    },
  };
  plugin[hookName]({ middlewares });
  assert.ok(handler, `${hookName} did not install a middleware`);
  return handler;
}

/** Drive one request through the guard's middleware and capture the response. */
function run(handler, { headers = {}, encrypted = false } = {}) {
  const req = { headers, socket: { encrypted } };
  let nextCalled = false;
  let statusCode;
  let body = '';
  const res = {
    setHeader() {},
    end(text) {
      body = text ?? '';
    },
    set statusCode(value) {
      statusCode = value;
    },
    get statusCode() {
      return statusCode;
    },
  };
  handler(req, res, () => {
    nextCalled = true;
  });
  return { nextCalled, statusCode, body };
}

for (const hookName of ['configureServer', 'configurePreviewServer']) {
  test(`${hookName}: allows a same-origin request with no Origin/Sec-Fetch-Site (curl shape)`, () => {
    const handler = install(apiOriginGuardPlugin(), hookName);
    const { nextCalled, statusCode } = run(handler, {
      headers: { host: 'localhost:4173' },
    });
    assert.equal(nextCalled, true);
    assert.equal(statusCode, undefined);
  });

  test(`${hookName}: allows a same-origin browser request (matching Origin, no Sec-Fetch-Site)`, () => {
    const handler = install(apiOriginGuardPlugin(), hookName);
    const { nextCalled } = run(handler, {
      headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' },
    });
    assert.equal(nextCalled, true);
  });

  test(`${hookName}: refuses a forged Host (DNS-rebinding shape)`, () => {
    const handler = install(apiOriginGuardPlugin(), hookName);
    const { nextCalled, statusCode } = run(handler, {
      headers: { host: 'attacker.example:4173' },
    });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 403);
  });

  test(`${hookName}: refuses Sec-Fetch-Site: cross-site even with a local Host`, () => {
    const handler = install(apiOriginGuardPlugin(), hookName);
    const { nextCalled, statusCode } = run(handler, {
      headers: {
        host: 'localhost:4173',
        'sec-fetch-site': 'cross-site',
      },
    });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 403);
  });

  test(`${hookName}: refuses a mismatched Origin on an otherwise-local Host`, () => {
    const handler = install(apiOriginGuardPlugin(), hookName);
    const { nextCalled, statusCode } = run(handler, {
      headers: { host: 'localhost:4173', origin: 'http://evil.example' },
    });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 403);
  });

  test(`${hookName}: refuses an unparseable Origin`, () => {
    const handler = install(apiOriginGuardPlugin(), hookName);
    const { nextCalled, statusCode } = run(handler, {
      headers: { host: 'localhost:4173', origin: 'not a url' },
    });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 403);
  });

  test(`${hookName}: allowWideHost skips the Host check but still refuses cross-site`, () => {
    const wideHandler = install(
      apiOriginGuardPlugin({ allowWideHost: true }),
      hookName,
    );
    const allowed = run(wideHandler, {
      headers: { host: 'anything.example:4173' },
    });
    assert.equal(allowed.nextCalled, true);

    const refused = run(wideHandler, {
      headers: {
        host: 'anything.example:4173',
        'sec-fetch-site': 'cross-site',
      },
    });
    assert.equal(refused.nextCalled, false);
    assert.equal(refused.statusCode, 403);
  });

  test(`${hookName}: refuses Sec-Fetch-Site: same-site with no Origin (another local port)`, () => {
    const handler = install(apiOriginGuardPlugin(), hookName);
    const { nextCalled, statusCode } = run(handler, {
      headers: {
        host: 'localhost:4173',
        'sec-fetch-site': 'same-site',
      },
    });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 403);
  });

  test(`${hookName}: allows Sec-Fetch-Site: same-origin`, () => {
    const handler = install(apiOriginGuardPlugin(), hookName);
    const { nextCalled } = run(handler, {
      headers: {
        host: 'localhost:4173',
        'sec-fetch-site': 'same-origin',
      },
    });
    assert.equal(nextCalled, true);
  });

  test(`${hookName}: allows Sec-Fetch-Site: none`, () => {
    const handler = install(apiOriginGuardPlugin(), hookName);
    const { nextCalled } = run(handler, {
      headers: {
        host: 'localhost:4173',
        'sec-fetch-site': 'none',
      },
    });
    assert.equal(nextCalled, true);
  });
}

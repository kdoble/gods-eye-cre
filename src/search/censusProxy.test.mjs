// Census relay: identifying User-Agent, malformed-body refusal, and the answer cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  censusGeocodeProxy,
  fetchCensusGeocode,
} from '../../server/providers/census.js';

const body = { result: { addressMatches: [] } };

test('the upstream call identifies itself and asks for the current benchmark', async () => {
  let seen;
  const text = await fetchCensusGeocode('601 E Main St', {
    fetchImpl: async (url, init) => {
      seen = { url: new URL(url), init };
      return Response.json(body);
    },
  });
  assert.deepEqual(JSON.parse(text), body);
  assert.equal(seen.url.hostname, 'geocoding.geo.census.gov');
  assert.equal(seen.url.searchParams.get('address'), '601 E Main St');
  assert.equal(seen.url.searchParams.get('benchmark'), 'Public_AR_Current');
  assert.match(seen.init.headers['User-Agent'], /gods-eye-cre/);
});

test('an upstream error or a body without addressMatches is refused', async () => {
  for (const reply of [
    () => new Response('down', { status: 502 }),
    () => Response.json({ errors: ['bad'] }),
  ])
    await assert.rejects(
      fetchCensusGeocode('1 Main St', { fetchImpl: async () => reply() }),
    );
});

/** Drive the middleware once and collect status and body. */
function call(handler, path) {
  return new Promise((resolve) => {
    const res = {
      writableEnded: false,
      writeHead(status) {
        this.status = status;
      },
      end(text) {
        this.writableEnded = true;
        resolve({ status: this.status, text });
      },
    };
    handler(
      { method: 'GET', url: path, socket: { remoteAddress: 'test' } },
      res,
    );
  });
}

test('the relay caches answers and reports failures as 503', async () => {
  let lookups = 0;
  let handler;
  const plugin = censusGeocodeProxy({
    lookup: async (address) => {
      lookups++;
      if (address.startsWith('fail')) throw new Error('offline');
      return JSON.stringify(body);
    },
  });
  plugin.configureServer({
    middlewares: { use: (_route, fn) => (handler = fn) },
  });
  const first = await call(handler, '/api/census-geocode?address=1+Main+St');
  const second = await call(
    handler,
    '/api/census-geocode?address=1%20MAIN%20ST',
  );
  assert.equal(first.status, 200);
  assert.equal(second.text, first.text);
  assert.equal(lookups, 1);
  assert.equal(
    (await call(handler, '/api/census-geocode?address=fail+1')).status,
    503,
  );
  assert.equal((await call(handler, '/api/census-geocode')).status, 400);
});

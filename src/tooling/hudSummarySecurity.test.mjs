import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { openAiRealtimeProxy } from '../../server/providers/openai.js';

function request(handler, headers) {
  const req = Readable.from([Buffer.from('{}')]);
  Object.assign(req, { method: 'POST', headers: { host: 'localhost:4173', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, body }); } };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}
test('HUD summary rejects cross-site and simple requests before spending provider quota in dev and preview', async (t) => {
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'fixture-not-a-real-key';
  t.after(() => { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ output_text: 'One two three four five' }); });
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    const routes = new Map();
    openAiRealtimeProxy()[hook]({ middlewares: { use: (path, handler) => routes.set(path, handler) } });
    const handler = routes.get('/api/openai/hud-summary');
    for (const headers of [
      { 'content-type': 'text/plain' },
      { 'content-type': 'application/json', origin: 'https://evil.example' },
      { 'content-type': 'application/json', origin: 'null' },
      { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      {},
    ]) {
      const before = calls;
      const result = await request(handler, headers);
      assert.ok([403, 415].includes(result.status));
      assert.equal(calls, before);
    }
    for (const headers of [{ 'content-type': 'application/json', origin: 'http://localhost:4173' }, { 'content-type': 'Application/JSON; charset=utf-8' }]) {
      assert.equal((await request(handler, headers)).status, 200);
    }
  }
  assert.equal(calls, 4);
});

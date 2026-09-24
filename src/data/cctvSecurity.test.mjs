import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { once } from 'node:events';
import { fetchCctvMediaUpstream, fetchCctvImageFromUpstream, proxyMediaResponse } from '../../server/providers/cctv/media.js';

function sink() {
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } });
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.text = () => Buffer.concat(chunks).toString();
  return res;
}
test('camera media rejects active, unknown and missing types without reflecting payloads', async () => {
  for (const type of ['text/html', 'image/svg+xml', ' Image/SVG+XML; charset=utf-8', 'application/octet-stream', '']) {
    const res = sink();
    const done = once(res, 'finish');
    await proxyMediaResponse(res, new Response('<script>attack()</script>', { headers: type ? { 'Content-Type': type } : {} }));
    await done;
    assert.equal(res.status, 502, type);
    assert.equal(res.text().includes('<script>'), false);
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    assert.match(res.headers['Content-Security-Policy'], /sandbox/);
    assert.equal(await fetchCctvImageFromUpstream('https://camera.example/frame', { fetchImpl: async () => new Response('attack', { headers: { 'Content-Type': type } }) }), null);
  }
});
test('normal raster, video, HLS and MJPEG retain bytes, range status and sandbox', async () => {
  for (const type of ['image/jpeg', 'Image/PNG; charset=binary', 'video/mp4', 'video/webm', 'application/vnd.apple.mpegurl', 'multipart/x-mixed-replace; boundary=frame']) {
    const res = sink();
    const done = once(res, 'finish');
    await proxyMediaResponse(res, new Response('fixture', { status: 206, headers: { 'Content-Type': type, 'Content-Range': 'bytes 0-6/10', 'Accept-Ranges': 'bytes' } }));
    await done;
    assert.equal(res.status, 206);
    assert.equal(res.text(), 'fixture');
    assert.equal(res.headers['Content-Range'], 'bytes 0-6/10');
    assert.match(res.headers['Content-Security-Policy'], /sandbox; default-src 'none'/);
  }
  assert.equal((await fetchCctvImageFromUpstream('https://camera.example/frame', { fetchImpl: async () => new Response('fixture', { headers: { 'Content-Type': 'image/jpeg' } }) })).body.toString(), 'fixture');
});
test('media redirects cannot escape origin, downgrade, change port or loop', async () => {
  for (const location of ['http://127.0.0.1/private', 'http://camera.example/frame', 'https://camera.example:444/frame', 'https://other.example/frame', '/loop']) {
    const calls = [];
    await assert.rejects(fetchCctvMediaUpstream('https://camera.example/frame', { fetchImpl: async (url, init) => {
      calls.push(url); assert.equal(init.redirect, 'manual');
      return new Response('', { status: 302, headers: { location } });
    } }), /redirect refused/);
    assert.equal(calls.length, location === '/loop' ? 3 : 1);
  }
});
test('same-origin media redirects preserve range headers', async () => {
  const calls = [];
  const response = await fetchCctvMediaUpstream('https://camera.example/frame', { headers: { Range: 'bytes=0-6' }, fetchImpl: async (url, init) => {
    calls.push(url); assert.equal(init.headers.Range, 'bytes=0-6');
    return calls.length === 1 ? new Response('', { status: 302, headers: { location: '/video' } }) : new Response('fixture', { status: 206 });
  } });
  assert.equal(response.status, 206);
  assert.deepEqual(calls, ['https://camera.example/frame', 'https://camera.example/video']);
});

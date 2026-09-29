import assert from 'node:assert/strict';
import { openInterpretSource, pcmWav, readPcmWav } from '../lib/downloaded-audio-source.js';
const a = new Uint8Array(32000).fill(11), b = new Uint8Array(32000).fill(22);
const id = 'a'.repeat(32), calls = [];
const fetchImpl = async (url, options = {}) => {
  calls.push([url, options.method]);
  if (url.endsWith('/health')) return Response.json({ service: 'pagelens-media' });
  if (options.method === 'DELETE') return Response.json({ ok: true });
  if (url.endsWith('/jobs')) return Response.json({ id });
  if (url.includes('/background/')) return new Response(pcmWav([new Uint8Array(32000).fill(33)]));
  if (url.endsWith('/analysis')) return Response.json({ status: 'ready', result: { duration: 2, spans: [] } });
  if (url.includes('/audio/')) return new Response(pcmWav([url.endsWith('/0') ? a : b]));
  return Response.json({ status: 'ready', duration: 2, parts: [{ index: 0, start: 0, duration: 1 }, { index: 1, start: 1, duration: 1 }] });
};
const source = await openInterpretSource({ url: 'https://example.test/video', fetchImpl });
const part = await source.slice(.5, 1);
const pcm = readPcmWav(await part.blob.arrayBuffer());
assert.equal(pcm.length, 32000);
assert(pcm.subarray(0, 16000).every(n => n === 11));
assert(pcm.subarray(16000).every(n => n === 22));
assert.equal(part.start, .5);
assert.equal(part.end, 1.5);
assert.equal((await source.slice(1.8, 5)).seconds, .2);
assert.equal(await source.slice(2, 5), null);
assert.equal(calls.filter(([url]) => url.includes('/audio/')).length, 2, 'reuse downloaded parts');
assert.equal((await source.analyze()).duration, 2);
const bg = await source.slice(0, .25, 'background');
assert(readPcmWav(await bg.blob.arrayBuffer()).every(n => n === 33), 'background must not reuse original PCM cache');
assert.equal(bg.seconds, .25);
await source.close();
assert(calls.some(([, method]) => method === 'DELETE'));
assert.throws(() => readPcmWav(new ArrayBuffer(20)));
console.log('PASS downloaded audio: cross-part timing, exact samples, short tail, cache, cleanup');

// Subtitles are delivered before audio download. A single shared readiness poll
// gates slice/analyze; early text planning must not depend on audio bytes.
{
  let ready = false, audioReads = 0, deleted = false;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/health')) return Response.json({ service: 'pagelens-media' });
    if (options.method === 'DELETE') { deleted = true; return Response.json({ ok: true }); }
    if (url.endsWith('/jobs')) return Response.json({ id });
    if (url.includes('/audio/')) { audioReads++; return new Response(pcmWav([a])); }
    return Response.json({ status: ready ? 'ready' : 'downloading', duration: 1,
      subtitles: [{ id: 's', start: 0, end: 1, src: 'Hello.' }], subtitlesComplete: true,
      ...(ready ? { parts: [{ index: 0, start: 0, duration: 1 }] } : {}) });
  };
  const source = await openInterpretSource({ url: 'https://fixture.test/staged', fetchImpl });
  assert.equal(source.subtitles[0].src, 'Hello.'); assert.equal(source.subtitlesComplete, true);
  assert.equal(audioReads, 0); assert.equal(ready, false, 'open returns while media is downloading');
  const pending = source.slice(0, .5);
  ready = true;
  assert.equal((await pending).seconds, .5); assert.equal(audioReads, 1);
  await source.close(); assert(deleted);
}

// Cancel a slice waiting for download without waiting for readiness or timeout.
{
  const abort = new AbortController();
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/health')) return Response.json({ service: 'pagelens-media' });
    if (options.method === 'DELETE') return Response.json({ ok: true });
    if (url.endsWith('/jobs')) return Response.json({ id });
    return Response.json({ status: 'downloading', duration: 1, subtitles: [{ start: 0, end: 1, src: 'Hello.' }] });
  };
  const source = await openInterpretSource({ url: 'https://fixture.test/cancel', fetchImpl, signal: abort.signal });
  const pending = source.slice(0, 1); abort.abort();
  await assert.rejects(pending, { name: 'AbortError' }); await source.close();
}
console.log('PASS staged subtitle readiness and abort while audio is downloading');

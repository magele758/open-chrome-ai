import assert from 'node:assert/strict';
import { session, gate, until, source, blob } from './interpret-test-harness.mjs';
import { synthesizeTts } from '../lib/tts.js';

// Gates establish actual dependency overlap, independent of machine speed.
{
  const voiceGate = gate(), ttsGate = gate(), slices = [], requests = [];
  const lines = [0, 1, 2].map(i => ({ id: `l${i}`, start: i * 4, end: i * 4 + 4, src: `Sentence ${i}.`, zh: `译文${i}`, speaker: 'A' }));
  let inFlight = 0, maxInFlight = 0;
  const s = session({ plan: { lines, spans: [], sourceKey: 'prefetch' },
    openSource: async () => source(lines, 12, { slice: async start => {
      slices.push(start);
      if (slices.length === 1) await voiceGate.promise;
      return { blob: new Blob([String(start)]) };
    } }),
    voiceRef: async b => b,
    synthesizeTts: async (_, text, options) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      requests.push({ text, ref: await options.referenceBlob.text(), emo: await options.emotionBlob.text() });
      if (requests.length === 1) await ttsGate.promise;
      inFlight--;
      return { blob };
    },
  });
  try {
    await until(() => slices.length === 2);
    assert.equal(requests.length, 0, 'TTS must wait for both exact references');
    voiceGate.release();
    await until(() => requests.length === 1 && slices.includes(4));
    assert(!slices.includes(8), 'lookahead bounded to one following line');
    ttsGate.release();
    await until(() => requests.length === 3);
    assert.equal(maxInFlight, 1, 'GPU synthesis remains sequential');
    assert.deepEqual(requests.map(r => [r.ref, r.emo]), [['0', '0'], ['0', '4'], ['0', '8']], 'stable timbre and per-line emotion unchanged');
  } finally { voiceGate.release(); ttsGate.release(); await s.stop(); }
}

// A seek during synthesis cannot bind the prefetched line's emotion/cache to
// the newly prioritized line, and does not increase the speculative depth.
{
  const held = gate(), requests = [], slices = [];
  const lines = [0, 1, 2].map(i => ({ id: `seek${i}`, start: i * 4, end: i * 4 + 4, src: `Sentence ${i}.`, zh: `译文${i}`, speaker: 'A' }));
  const s = session({ plan: { lines, spans: [], sourceKey: 'seek-prefetch' },
    openSource: async () => source(lines, 12, { slice: async start => {
      slices.push(start); return { blob: new Blob([String(start)]) };
    } }), voiceRef: async b => b,
    synthesizeTts: async (_, text, options) => {
      requests.push({ text, emo: await options.emotionBlob.text() });
      if (requests.length === 1) await held.promise;
      return { blob };
    },
  });
  try {
    await until(() => requests.length === 1 && slices.includes(4));
    s.state.currentTime = 8; s.state.seekRevision++;
    await until(() => s.events.some(e => e.type === 'status' && e.message?.includes('已跳转')));
    held.release();
    await until(() => requests.length === 3);
    assert.deepEqual(requests.map(r => [r.text, r.emo]), [['译文0', '0'], ['译文2', '8'], ['译文1', '4']]);
  } finally { held.release(); await s.stop(); }
}

// Both uploads start before either responds; generation waits for both files.
{
  const originalFetch = globalThis.fetch, uploads = [], submitted = [];
  const held = gate();
  globalThis.fetch = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    if (path === '/gradio_api/upload') {
      const text = await opts.body.get('files').text(); uploads.push(text);
      await held.promise;
      return Response.json([`/tmp/${text}.wav`]);
    }
    if (path === '/gradio_api/call/gen_single') { submitted.push(JSON.parse(opts.body).data); return Response.json({ event_id: 'e' }); }
    if (path.endsWith('/gen_single/e')) return new Response('event: complete\ndata: [{"path":"/tmp/out.wav","url":"/gradio_api/file=/tmp/out.wav"}]\n\n');
    if (path.includes('/file=')) return new Response(blob);
    throw Error(path);
  };
  const running = synthesizeTts({ baseUrl: 'https://prefetch.test' }, '译文', { referenceBlob: new Blob(['voice']), emotionBlob: new Blob(['emotion']) });
  try {
    await until(() => uploads.length === 2);
    assert.equal(submitted.length, 0);
    held.release(); await running;
    assert.equal(submitted[0][1].path, '/tmp/voice.wav');
    assert.equal(submitted[0][4].path, '/tmp/emotion.wav');
  } finally { held.release(); await running; globalThis.fetch = originalFetch; }
}
console.log('PASS parallel reference extraction/uploads, bounded next-line prefetch, ordered TTS, exact voice/emotion');

import assert from 'node:assert/strict';
import { runInterpret } from '../lib/interpret.js';
const nativeTimeout = globalThis.setTimeout;
let clock = 100000;
Date.now = () => clock;
globalThis.setTimeout = (fn, ms, ...args) => nativeTimeout(() => { if (ms === 200) clock += ms; fn(...args); }, ms === 200 ? 1 : ms);
let recorded = 0, played = 0, lastTake = clock;
let sourceTime = 0, sourcePaused = true;
let visibleTime = 120, removed = [], restored = false;
let releaseFirst;
const firstRecognition = new Promise(resolve => { releaseFirst = resolve; });
const recognized = [], references = [], events = [];
const state = () => ({ ok: true, currentTime: visibleTime, duration: 135, revision: 0, done: true, desiredPlaying: true });
globalThis.chrome = {
  tabs: {
    get: async () => ({ url: 'https://example.test/video' }),
    create: async args => { assert.equal(args.active, false); return { id: 2 }; },
    remove: async id => removed.push(id),
  },
  scripting: { executeScript: async ({ target, func, args }) => {
    const [cmd, options] = args;
    if (func.name === 'plInterpretVideo') {
      if (cmd === 'audio') { played++; visibleTime = options.end; }
      if (cmd === 'stop') restored = true;
      return [{ result: state() }];
    }
    if (func.name === 'plPageAudio') {
      if (cmd === 'take') {
        if (clock - lastTake >= 1000 && !sourcePaused) { recorded++; sourceTime = Math.min(135, sourceTime + 5); }
        lastTake = clock;
        return [{ result: { ok: true, b64: Buffer.alloc(2000, recorded).toString('base64'), mime: 'audio/wav', seconds: 5 } }];
      }
      if (cmd === 'start') { lastTake = clock; sourcePaused = false; }
      return [{ result: { ok: true } }];
    }
    if (target.tabId === 1) return [{ result: { ok: true, currentTime: visibleTime, duration: 135, index: 0 } }];
    if (cmd === 'seek') { sourceTime = options.seconds; sourcePaused = Boolean(options.paused); }
    if (cmd === 'control') sourcePaused = options.action === 'pause';
    return [{ result: { ok: true, currentTime: sourceTime, duration: 135, ended: sourceTime >= 135,
      paused: sourcePaused, readyState: 4, seeking: false } }];
  } },
};
globalThis.indexedDB = { open() { throw new Error('Live references must not access saved voice storage'); } };
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname;
  if (path === '/v1/transcribe') {
    const id = new Uint8Array(await options.body.get('file').arrayBuffer())[0];
    recognized.push(id);
    if (id === 1) await firstRecognition;
    else releaseFirst();
    return Response.json({ segments: [{ start: 0, end: 5, text: `第${id}段中文内容` }] });
  }
  if (path === '/gradio_api/upload') {
    const id = new Uint8Array(await options.body.get('files').arrayBuffer())[0];
    references.push(id);
    return Response.json([`/tmp/ref-${id}.wav`]);
  }
  if (path === '/gradio_api/call/gen_single') {
    const submitted = JSON.parse(options.body).data;
    const id = references.at(-1);
    assert.equal(submitted[2], `第${id}段中文内容`, 'voice and translation are paired');
    return Response.json({ event_id: String(id) });
  }
  if (path.startsWith('/gradio_api/call/gen_single/')) {
    return new Response('event: complete\ndata: [{"__type__":"update","value":{"url":"/audio.wav"}}]\n\n');
  }
  if (path === '/audio.wav') return new Response(new Uint8Array(2000), { headers: { 'content-type': 'audio/wav' } });
  throw new Error(`Unexpected request ${path}`);
};
const result = await runInterpret({ tabId: 1, settings: {
  asr: { preset: 'v1-transcribe', baseUrl: 'https://asr.example.test' },
  tts: { baseUrl: 'https://tts.example.test' },
}, onEvent: e => events.push(e) });
assert.deepEqual(recognized, [1, 2, 3], 'background capture continues while first ASR waits');
assert.deepEqual(references, [1, 2, 3]);
assert.deepEqual(result.lines.map(x => [x.start, x.end]), [[120, 125], [125, 130], [130, 135]]);
assert.equal(played, 3, 'natural video end waits for last audio');
assert.equal(visibleTime, 135);
assert.deepEqual(removed, [2], 'only the owned background source is closed');
assert(restored);
assert.equal(events.filter(e => e.type === 'warn').length, 0);
assert(events.some(e => e.message?.includes('缓冲')));
console.log('ok synchronized flow: independent source, ASR, segment references, video timestamps, cleanup');

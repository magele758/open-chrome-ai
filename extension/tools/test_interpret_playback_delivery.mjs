import assert from 'node:assert/strict';
import { session, source, blob, gate, until, sleep } from './interpret-test-harness.mjs';
import { plVideo } from '../lib/video-pick.js';
const cues = [{ id: 'a', start: 0, end: 2, src: 'A short subtitle.' }, { id: 'b', start: 2, end: 8, src: 'The next sentence.' }];
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch(e) { failures.push(name); console.error('FAIL', name, e.message); } }
await check('generated long audio must actually play, cold and warm plans', async () => {
  for (const warm of [false, true]) {
    const plan = { lines: cues.map(c => ({ ...c, zh: '这是需要完整播出的中文内容。', speaker: 'A' })), spans: [], sourceKey: 'delivery', background: false };
    let extraCalls = 0;
    const s = session({ ...(warm ? { plan } : {}), openSource: async () => source(cues, 8), audioDuration: async () => 6,
      chat: async (_, { messages }) => {
        const input = JSON.parse(messages[1].content);
        if (!input.current) { extraCalls++; return ''; }
        return JSON.stringify({ lines: input.current.map(c => ({ ids: [c.id], zh: '这是需要完整播出的中文内容。' })) });
      } });
    try {
      await until(() => s.audios.some(a => a.played), 1000);
      assert.equal(s.audios[0].dubItem.start, 0);
      assert.equal(extraCalls, 0, 'realtime audio must not wait for an extra rewrite/re-synthesis');
    } finally { await s.stop(); }
  }
});
await check('starting on paused video expresses playback intent; later user pause still wins', async () => {
  const attributes = new Map();
  class Video extends EventTarget {
    constructor() { super(); Object.assign(this, { tagName: 'VIDEO', offsetWidth: 1280, offsetHeight: 720,
      duration: 8, currentTime: 0, paused: true, ended: false, readyState: 4, playbackRate: 1,
      muted: false, volume: 1, isConnected: true, className: 'html5-main-video' }); }
    closest() { return null; }
    setAttribute(k, v) { attributes.set(k, v); }
    removeAttribute(k) { attributes.delete(k); }
    getAttribute(k) { return attributes.get(k); }
    pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); } }
    async play() { if (this.paused) { this.paused = false; this.dispatchEvent(new Event('play')); } }
  }
  const video = new Video();
  globalThis.document = { querySelectorAll: () => [video] };
  globalThis.window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) };
  const s = session({ openSource: async () => source(cues, 8), video: async (cmd, arg) => plVideo(cmd, arg) });
  try {
    await until(() => s.audios.some(a => a.played), 1000);
    assert.equal(plVideo('state').userPaused, false);
    video.pause();
    await until(() => s.audios[0].paused);
    assert.equal(plVideo('state').userPaused, true, 'real injected video watch must honor subsequent user pause');
    assert(video.paused);
  } finally {
    await s.stop();
    for (const key of ['document', 'window', '__plLiveWatch', '__plAudioTap', '__plSiMute', '__plVideoIndex']) delete globalThis[key];
  }
});
await check('a short first clip starts while the next synthesis is pending', async () => {
  const second = gate(); let calls = 0;
  const s = session({ openSource: async () => source(cues, 8), audioDuration: async () => 1.5,
    synthesizeTts: async () => { if (++calls > 1) await second.promise; return { blob }; } });
  try {
    await until(() => s.audios.some(a => a.played), 1000);
    assert.equal(s.audios[0].dubItem.start, 0);
    assert.equal(s.events.filter(e => e.type === 'dub_segment').length, 1);
  } finally { second.release(); await s.stop(); }
});
await check('buffer deadline cannot skip speech whose TTS is still running', async () => {
  const pending = gate(); let entered = false;
  const s = session({ openSource: async () => source(cues, 8), playbackWaitMs: 30, ttsTimeoutMs: 1000,
    synthesizeTts: async () => { entered = true; await pending.promise; return { blob }; } });
  try {
    await until(() => entered); await sleep(160);
    assert(s.state.paused, 'keep source position until the current phrase resolves');
    pending.release(); await until(() => s.audios.some(a => a.played), 1000);
    assert.equal(s.audios[0].dubItem.start, 0);
  } finally { pending.release(); await s.stop(); }
});
assert.deepEqual(failures, []);

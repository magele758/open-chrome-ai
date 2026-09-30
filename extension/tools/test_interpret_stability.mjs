import assert from 'node:assert/strict';
import { runPlannedInterpret } from '../lib/planned-interpret.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 400; i++) { if (fn()) return; await sleep(10); }
  throw Error('timeout: ' + fn);
}
const blob = new Blob(['dub']);
const settings = { text: { baseUrl: 'https://text.test', model: 'm' }, tts: { baseUrl: 'https://tts.test', preparationMode: 'full' } };
const lines = [0, 1, 2].map(i => ({ id: String(i), start: i * 2, end: i * 2 + 2, src: `sentence ${i}`, zh: `句子${i}`, speaker: 'A' }));
function start(extra = {}) {
  const state = { ok: true, currentTime: 0, duration: 6, paused: false, userPaused: false, seekRevision: 0, readyState: 4, playbackRate: 1, silenced: false };
  const audios = [], commands = [], abort = new AbortController();
  const running = runPlannedInterpret({ tabId: 1, settings, signal: abort.signal,
    plan: { sourceKey: 'stability', lines: lines.map(l => ({ ...l })), spans: [] },
    openSource: async () => ({ duration: 6, subtitles: lines, slice: async () => ({ blob }), close: async () => {} }),
    getTtsRef: async () => null, cacheGet: async () => null, cacheSet: async () => true,
    voiceRef: async b => b, audioDuration: async () => 2, synthesizeTts: async () => ({ blob }),
    video: async (cmd, arg = {}) => {
      commands.push({ cmd, arg, time: state.currentTime });
      if (cmd === 'control') state.paused = arg.action === 'pause';
      if (cmd === 'silence') state.silenced = true;
      if (cmd === 'restore') state.silenced = false;
      return { ...state };
    },
    createAudio: () => { const a = { paused: true, pause() { this.paused = true; }, async play() { this.paused = false; } }; audios.push(a); return a; },
    ...extra,
  });
  const outcome = running.then(value => ({ value }), error => ({ error }));
  return { state, audios, commands, abort, outcome };
}
// Simulate a throttled scheduler: video crosses an entire next sentence before
// the previous audio's ended callback is observed, including at the media end.
{
  const r = start();
  try {
    await until(() => r.audios.length === 1 && !r.audios[0].paused);
    r.state.currentTime = 4.2;
    r.audios[0].onended();
    await until(() => r.audios.length === 2 && !r.audios[1].paused);
    assert.equal(r.audios[1].dubItem.id, '1', 'expired but unheard sentence must play');
    assert(r.state.paused, 'video holds while overdue speech drains');
    r.state.currentTime = 6; r.state.ended = true;
    r.audios[1].onended();
    await until(() => r.audios.length === 3 && !r.audios[2].paused);
    r.audios[2].onended();
    assert(!(await r.outcome).error);
    assert.deepEqual(r.audios.map(a => a.dubItem.id), ['0', '1', '2']);
  } finally { r.abort.abort(); await r.outcome; }
}
// A deliberate seek still skips old content.
{
  const r = start();
  try {
    await until(() => r.audios.length === 1 && !r.audios[0].paused);
    r.state.currentTime = 4.2; r.state.seekRevision++;
    await until(() => r.audios.length === 2 && !r.audios[1].paused);
    assert.equal(r.audios[1].dubItem.id, '2');
    assert(r.commands.filter(c => c.cmd === 'silence').every(c => c.arg.fadeSeconds === 0), 'mute cannot depend on a repeatedly restarted gain ramp');
  } finally { r.abort.abort(); await r.outcome; }
}
// A failed following sentence cannot reopen the original track over the
// previous sentence's still-playing translated tail.
{
  const r = start({ synthesizeTts: async (_settings, text) => {
    if (text === '句子1') throw Error('invalid audio');
    return { blob };
  } });
  try {
    await until(() => r.audios.length === 1 && !r.audios[0].paused);
    r.state.currentTime = 2.1;
    await until(() => r.state.paused);
    assert(r.state.silenced, 'failed upcoming speech cannot enable original audio during a tail');
    r.audios[0].onended();
    assert((await r.outcome).error);
    assert(r.state.paused);
  } finally { r.abort.abort(); await r.outcome; }
}
// Exhausted generation retries and playback failure must not resume original video.
for (const kind of ['tts', 'playback', 'translation']) {
  const r = start(kind === 'tts' ? { synthesizeTts: async () => { throw Error('invalid audio'); } } : kind === 'translation' ? {
    plan: { sourceKey: 'failed-translation', spans: [], lines: [{ ...lines[0], translationStatus: 'failed' }] },
  } : {});
  if (kind === 'playback') {
    await until(() => r.audios.length === 1 && !r.audios[0].paused);
    r.audios[0].onerror();
  }
  const result = await r.outcome;
  assert(result.error, kind + ' failure is surfaced');
  assert(r.state.paused, kind + ' failure leaves video paused');
  const restored = r.commands.findIndex(c => c.cmd === 'restore');
  assert(!r.commands.slice(Math.max(0, restored)).some(c => c.cmd === 'control' && c.arg.action === 'play'), 'cleanup must not restart playback');
}
console.log('PASS stability: overdue sentences, final tail, explicit seek, immediate mute, fail-closed generation/playback');

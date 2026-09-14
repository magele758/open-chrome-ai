import assert from 'node:assert/strict';
import { runPlannedInterpret } from '../lib/planned-interpret.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 400; i++) { if (fn()) return; await sleep(10); } throw Error('timeout ' + fn); }
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const planningGate = gate(), audioGate = gate(), analysisGate = gate();
const abort = new AbortController(), audio = [], notices = [], translated = [];
const state = { ok: true, currentTime: 0, duration: 60, paused: false, userPaused: false, seekRevision: 0, readyState: 4, playbackRate: 1 };
const cues = [[0, 4], [6, 12], [12, 18], [18, 24], [24, 36], [36, 60]].map(([start, end]) => ({ start, end, text: `Sentence ${start}.` }));
const blob = new Blob(['audio']);
const cache = new Map();
let failures = 0;
class AudioMock {
  constructor() { this.paused = true; audio.push(this); }
  pause() { this.paused = true; }
  async play() { this.paused = false; }
  removeAttribute() {} load() {}
}
const running = runPlannedInterpret({
  tabId: 1, settings: { text: { baseUrl: 'https://text.test', model: 'm' }, tts: { baseUrl: 'https://tts.test', preparationMode: 'progressive', bufferSeconds: 10 } },
  signal: abort.signal,
  video: async (cmd, arg = {}) => { if (cmd === 'control') state.paused = arg.action === 'pause'; return { ...state }; },
  openSource: async () => ({ duration: 60, subtitles: cues, close: async () => {},
    analyze: async () => { await analysisGate.promise; return { spans: [{ start: 0, end: 60, kind: 'unknown', speaker: null }] }; },
    slice: async (start, seconds) => ({ start, end: start + seconds, seconds, blob: new Blob([String(start)]) }),
  }),
  chat: async (_m, { messages }) => {
    const input = JSON.parse(messages[1].content);
    translated.push(input.current.map(c => c.src));
    if (input.current.some(c => c.src === 'Sentence 12.')) {
      await planningGate.promise;
      if (failures++ === 0) throw new TypeError('Failed to fetch');
    }
    return JSON.stringify({ lines: input.current.map(c => ({ ids: [c.id], zh: '译文' + c.src.match(/\d+/)[0] })) });
  },
  cacheGet: async k => cache.get(k), cacheSet: async (k, v) => { cache.set(k, v); },
  getTtsRef: async () => null, voiceRef: async b => b,
  synthesizeTts: async (_m, text) => { if (text === '译文18') await audioGate.promise; return { blob: new Blob([text]) }; },
  audioDuration: async b => (await b.text()) === '译文0' ? 5 : 6,
  createAudio: () => new AudioMock(), onEvent: ev => { if (ev.message) notices.push(ev.message); },
});
const outcome = running.then(value => ({ value }), error => ({ error }));
try {
  await until(() => audio.length === 1 && !audio[0].paused);
  assert.equal(audio[0].dubItem.rate, 1, '5s translation uses the known gap rather than speeding up to fit 4s');
  assert.equal(audio[0].dubItem.slotEnd, 5.5, 'borrowing is bounded to 1.5s, before the next voice');
  audio[0].onended(); state.currentTime = 6;
  await until(() => audio.length === 2 && !audio[1].paused);
  assert.equal(audio[1].dubItem.slotEnd, 12, 'unknown future windows cannot be borrowed');
  audio[1].onended(); state.currentTime = 12;
  await until(() => state.paused);
  planningGate.resolve();
  await until(() => notices.some(s => s.includes('重试当前段')));
  await until(() => notices.some(s => s.includes('缓冲 6/10')));
  assert(state.paused, '6 ready seconds must not satisfy the configured 10s recovery buffer');
  assert.equal(audio.length, 2);
  audioGate.resolve();
  await until(() => audio.length === 3 && !audio[2].paused && !state.paused);
  assert.equal(audio[2].dubItem.start, 12, 'retry resumes with the failed window, without skipping speech');
  assert.equal(translated.filter(batch => batch.includes('Sentence 0.')).length, 1, 'finished translations are not repeated');
  assert.equal(failures, 2, 'a transient failure retries only the affected batch');
} finally {
  abort.abort(); planningGate.resolve(); audioGate.resolve(); analysisGate.resolve();
  assert.equal((await outcome).error?.name, 'AbortError');
}
console.log('PASS continuity: natural rate, known gaps, unknown boundaries, configured refill and failed-window recovery');

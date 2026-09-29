import assert from 'node:assert/strict';
import { runPlannedInterpret } from '../lib/planned-interpret.js';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
export async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(10); }
  throw new Error('Expected playback checkpoint was not reached');
}
export const settings = { text: { baseUrl: 'https://text.test', model: 'mock', apiKey: 'test-key' },
  asr: { baseUrl: 'https://asr.test/v1', model: 'mock' },
  tts: { baseUrl: 'https://tts.test', preparationMode: 'progressive', contextMode: 'sentence' } };
export const blob = new Blob([new Uint8Array(100)], { type: 'audio/wav' });
export function source(subtitles, duration = 40, extra = {}) {
  return { duration, subtitles, subtitlesComplete: true, close: async () => {},
    analyze: () => new Promise(() => {}),
    slice: async (start, seconds) => ({ blob, start, end: start + seconds, seconds }), ...extra };
}
export const chat = async (_, { messages }) => {
  const input = JSON.parse(messages[1].content);
  if (!input.current) return '';
  return JSON.stringify({ lines: input.current.map(c => ({ ids: [c.id], zh: '这是一句译文。' })) });
};
export function session(extra = {}) {
  const abort = new AbortController(), events = [], audios = [], commands = [];
  const state = { ok: true, currentTime: 0, paused: true, readyState: 4, playbackRate: 1, silenced: false, userPaused: false, seekRevision: 0 };
  const running = runPlannedInterpret({ tabId: 1, settings, signal: abort.signal,
    video: async (cmd, arg = {}) => {
      commands.push({ cmd, arg, time: state.currentTime });
      if (cmd === 'control') state.paused = arg.action === 'pause';
      if (cmd === 'silence') state.silenced = true;
      if (cmd === 'restore') state.silenced = false;
      return { ...state };
    },
    cacheGet: async () => null, cacheSet: async () => {}, getTtsRef: async () => null,
    voiceRef: async () => blob, audioDuration: async () => 3, synthesizeTts: async () => ({ blob }), chat,
    createAudio: () => {
      const audio = { paused: true, currentTime: 0, playbackRate: 1,
        pause() { this.paused = true; }, async play() { this.paused = false; this.played = true; } };
      audios.push(audio); return audio;
    }, onEvent: event => events.push(event), ...extra,
  });
  const outcome = running.then(value => ({ value }), error => ({ error }));
  return { abort, events, audios, commands, state, outcome, async stop() {
    abort.abort(); const result = await outcome;
    if (result.error && result.error.name !== 'AbortError') throw result.error;
  } };
}

// Drives BOTH clocks and the real production loop. Source time stops when the
// system pauses the video; audio time keeps advancing during an allowed hold.
export async function continuousPlayback({ override = {}, rate = 1 } = {}) {
  const subtitles = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, start: 1 + i * 4, end: 5 + i * 4, src: `Sentence ${i}.` }));
  const s = session({ openSource: async () => source(subtitles, 38), ...override });
  s.state.playbackRate = rate;
  let pausedTicks = 0, playingTicks = 0;
  const timer = setInterval(() => {
    if (s.state.paused) pausedTicks++; else { playingTicks++; s.state.currentTime += .1 * rate; }
    if (s.state.currentTime >= 38) { s.state.currentTime = 38; s.state.ended = true; }
    for (const audio of s.audios) if (!audio.paused) {
      audio.currentTime += .1 * audio.playbackRate;
      if (audio.currentTime >= (audio.dubItem?.audioSeconds || 3)) { audio.pause(); audio.onended?.(); }
    }
  }, 5);
  try {
    await until(() => s.state.ended, 7000);
    const result = await Promise.race([s.outcome, sleep(1000).then(() => { throw new Error('Playback did not finish'); })]);
    assert(!result.error, result.error?.message);
    assert.equal(s.audios.filter(a => a.played).length, subtitles.length, 'all speech, not just quiet intro, must play');
    const ids = s.events.filter(e => e.type === 'line').map(e => e.id);
    assert.equal(new Set(ids).size, 9, 'every utterance plays once');
    assert.equal(ids.length, 9, 'no repeated utterances');
    assert(!s.events.some(e => e.type === 'dub_gap' || e.type === 'dub_partial'), 'happy path must not silently degrade');
    assert(s.events.some(e => e.type === 'dub_complete'));
    assert(pausedTicks / Math.max(1, pausedTicks + playingTicks) < .15, 'mock fast services must sustain playback');
    return { played: ids.length, pausedTicks, playingTicks };
  } finally { clearInterval(timer); await s.stop(); }
}

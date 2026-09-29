import assert from 'node:assert/strict';
import { runPlannedInterpret } from '../lib/planned-interpret.js';

// A quiet intro is coverage, not translated speech. Slow work beyond the first
// short window must never prevent its audio from becoming available.
const subtitles = Array.from({ length: 100 }, (_, i) => ({
  id: `sub:${i}`, start: 37.136 + i * 4, end: 41.136 + i * 4,
  src: 'a continuous unpunctuated subtitle fragment', speaker: null,
}));
const settings = { text: { baseUrl: 'https://text.test', model: 'm' },
  tts: { baseUrl: 'https://tts.test', preparationMode: 'progressive', contextMode: 'sentence', translateAheadSeconds: 600 } };
const blob = new Blob(['fixture']);
for (const audioOnly of [true, false]) {
  const abort = new AbortController();
  const slices = [], events = [];
  let release;
  const later = new Promise(resolve => { release = resolve; });
  const state = { ok: true, currentTime: 0, paused: true, readyState: 4, playbackRate: 1 };
  const running = runPlannedInterpret({ tabId: 1, sourceUrl: 'https://fixture.test/quiet-intro', settings,
    audioOnly, signal: abort.signal,
    video: async (cmd, arg) => { if (cmd === 'control') state.paused = arg.action === 'pause'; return { ...state }; },
    openSource: async () => ({ duration: 438, subtitles, subtitlesComplete: true, close: async () => {},
      analyze: () => new Promise(() => {}),
      slice: async (start, seconds) => { slices.push({ start, seconds }); return { blob, start, end: start + seconds, seconds }; },
    }),
    cacheGet: async () => null, cacheSet: async () => {}, getTtsRef: async () => null,
    voiceRef: async () => blob, audioDuration: async () => 3, synthesizeTts: async () => ({ blob }),
    chat: async (_, { messages }) => {
      const input = JSON.parse(messages[1].content);
      if (!input.current) return '';
      // Model translation of later speech is deliberately blocked.
      if (input.current.some(cue => Number(cue.id.split(':').at(-1)) >= 4)) await later;
      return JSON.stringify({ lines: input.current.map(cue => ({ ids: [cue.id], zh: '译文。' })) });
    },
    onEvent: event => events.push(event),
  });
  try {
    for (let i = 0; i < 100 && !events.some(e => e.type === 'dub_segment'); i++) await new Promise(r => setTimeout(r, 10));
    assert(slices.every(slice => slice.seconds <= 7), 'subtitle planning must not download/hash a translation window; only references need slices');
    assert(events.some(e => e.type === 'dub_segment'), 'first speech must reach TTS while later translation is blocked');
    assert.equal(events.find(e => e.type === 'dub_segment').segment.start, 37.136);
  } finally {
    abort.abort(); release(); await assert.rejects(running, { name: 'AbortError' });
  }
}
console.log('PASS short first speech after quiet intro, sync and audio-only, later translation does not block first audio');

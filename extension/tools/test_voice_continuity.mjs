import assert from 'node:assert/strict';
import { runPlannedInterpret } from '../lib/planned-interpret.js';

console.log('Testing voice reference continuity across short/unassigned cues...');

const settings = {
  text: { baseUrl: 'https://text.test', model: 'test' },
  asr: { baseUrl: 'https://asr.test', model: 'test' },
  tts: { baseUrl: 'https://tts.test', preparationMode: 'progressive', bufferSeconds: 5 },
};

const chat = async (_, { messages }) => {
  const p = JSON.parse(messages[1].content);
  return p.current ? JSON.stringify({ lines: p.current.map(c => ({ ids: [c.id], zh: c.src })) }) : 'context';
};

const noCache = { cacheGet: async () => null, cacheSet: async () => true };

// Cue 0 is short (1.5s), Cue 1 is long (5s, valid speaker), Cue 2 is short (1.2s)
const subtitles = [
  { id: 'sub:0', start: 0, end: 1.5, src: 'Short intro' },
  { id: 'sub:1', start: 1.5, end: 6.5, src: 'Long explanation of the main topic with clear voice' },
  { id: 'sub:2', start: 6.5, end: 7.7, src: 'Brief concluding remark' },
];

const speechBlob = new Blob(['SPEAKER_SAMPLE_AUDIO'], { type: 'audio/wav' });

const source = {
  duration: 10,
  subtitles,
  close: async () => {},
  analyze: async () => ({
    duration: 10,
    spans: [{ start: 0, end: 10, kind: 'unknown', speaker: null }],
  }),
  slice: async (start, seconds) => {
    // Only intervals >= 3s are deemed valid clean speech by the voice quality gate
    if (seconds >= 3) {
      return { start, seconds, blob: speechBlob };
    }
    return { start, seconds, blob: new Blob(['short'], { type: 'audio/wav' }) };
  },
};

const state = { ok: true, currentTime: 0, duration: 10, paused: false, userPaused: false, seekRevision: 0, readyState: 4, playbackRate: 1 };
const synthRequests = [];
const abort = new AbortController();
class AudioMock {
  constructor() { this.paused = true; }
  pause() { this.paused = true; }
  async play() { this.paused = false; }
  removeAttribute() {}
  load() {}
}

const running = runPlannedInterpret({
  tabId: 1,
  sourceUrl: 'https://fixture.test/voice-continuity',
  settings,
  signal: abort.signal,
  openSource: async () => source,
  video: async (cmd, arg = {}) => {
    if (cmd === 'control') state.paused = arg.action === 'pause';
    return { ...state };
  },
  getTtsRef: async () => null, // User has NOT configured any manual voice ref
  chat,
  ...noCache,
  transcribe: async () => { throw new Error('subtitles should not use ASR'); },
  voiceRef: async (blob) => {
    // Accept only the valid speaker sample (>= 3s)
    const text = await blob.text();
    return text === 'SPEAKER_SAMPLE_AUDIO' ? speechBlob : null;
  },
  audioDuration: async () => 1.5,
  createAudio: () => new AudioMock(),
  synthesizeTts: async (_m, text, { referenceBlob }) => {
    synthRequests.push({ text, hasRef: referenceBlob != null, refText: referenceBlob ? await referenceBlob.text() : null });
    return { blob: new Blob(['dub_wav']) };
  },
});

const outcome = running.then(value => ({ value }), error => ({ error }));

// Wait until all 3 cues have been synthesized
for (let n = 0; n < 100 && synthRequests.length < 3; n++) {
  await new Promise(r => setTimeout(r, 50));
}
abort.abort();
const result = await outcome;
if (result.error && result.error.name !== 'AbortError') {
  console.error('RUNNING ERROR:', result.error);
}

assert.equal(synthRequests.length, 3, 'All 3 cues must be synthesized');
for (const req of synthRequests) {
  assert.equal(req.hasRef, true, `Cue "${req.text}" must have a voice reference`);
  assert.equal(req.refText, 'SPEAKER_SAMPLE_AUDIO', `Cue "${req.text}" must use the speaker's cloned audio`);
}

console.log('PASS: Speaker voice reference continuity preserved across all cues!');

// VOICE CONTRACT — product decisions confirmed by the user (2026-09-29).
// These have regressed repeatedly when one property was "fixed" in isolation.
// Do not edit an assertion here to make an implementation change pass; change
// the product decision with the user first, then update this file.
//
// 1. Never reference-less: without a configured voice, every TTS request still
//    carries a voice sample from the video (Index-TTS rejects requests without one,
//    and the line would silently fall back to original audio).
// 2. Timbre is per speaker: one sample per known speaker; all unlabeled cues
//    (no diarization) share ONE video voice, so the voice does not drift.
// 3. The timbre sample comes from speech-dense audio, never an intro/applause cue.
// 4. Tone follows the original: each line sends its own original audio as the
//    emotion reference ("Use emotion reference audio"), separate from timbre.
// 5. A shared timbre sample is uploaded once, not per line.
// 6. Quiet but clean speech still yields a sample (normalized); near-silence does not.
import assert from 'node:assert/strict';
import { runPlannedInterpret } from '../lib/planned-interpret.js';
import { synthesizeTts, buildGenSingleData, TTS_EMO_FROM_AUDIO, TTS_EMO_SAME_AS_REF } from '../lib/tts.js';
import { voiceSample } from '../lib/tab-audio-record.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(10); }
  throw new Error('timeout waiting for TTS requests');
}
const chat = async (_, { messages }) => {
  const input = JSON.parse(messages[1].content);
  return input.current ? JSON.stringify({ lines: input.current.map(c => ({ ids: [c.id], zh: c.src })) }) : 'context';
};
class AudioMock { constructor() { this.paused = true; } pause() { this.paused = true; } async play() { this.paused = false; } }

// Each slice is labelled by who/what is audible at its start, so a request's
// reference proves where it was sampled from.
async function capture({ subtitles, duration, labelAt, analyze, preparationMode = 'progressive', configured = null, count }) {
  const state = { ok: true, currentTime: 0, duration, paused: false, userPaused: false, seekRevision: 0, readyState: 4, playbackRate: 1 };
  const abort = new AbortController(), requests = [];
  const source = { duration, subtitles, subtitlesComplete: true, close: async () => {}, analyze,
    slice: async (start, seconds) => ({ start, end: start + seconds, seconds, blob: new Blob([labelAt(start)]) }) };
  const running = runPlannedInterpret({ tabId: 1, sourceUrl: `https://fixture.test/${Math.random()}`, signal: abort.signal,
    settings: { text: { baseUrl: 'https://text.test', model: 't' }, asr: {}, tts: { baseUrl: 'https://tts.test', preparationMode, contextMode: 'cue' } },
    openSource: async () => source, chat, cacheGet: async () => null, cacheSet: async () => true,
    video: async (cmd, arg = {}) => { if (cmd === 'control') state.paused = arg.action === 'pause'; return { ...state }; },
    getTtsRef: async () => configured && { buffer: new TextEncoder().encode(configured), type: 'audio/wav' },
    transcribe: async () => { throw new Error('subtitle cues need no ASR'); },
    voiceRef: async blob => ((await blob.text()) === 'SILENCE' ? null : blob),
    audioDuration: async () => 2, createAudio: () => new AudioMock(),
    synthesizeTts: async (_m, text, { referenceBlob, emotionBlob }) => {
      requests.push({ text, ref: referenceBlob ? await referenceBlob.text() : null, emo: emotionBlob ? await emotionBlob.text() : null });
      return { blob: new Blob(['dub']) };
    } });
  const outcome = running.then(v => ({ v }), e => ({ e }));
  try { await until(() => requests.length >= count); } finally { abort.abort(); await outcome; }
  return requests;
}

// Unlabeled cues, no configured voice, no diarization (analysis never arrives).
{
  const subtitles = [
    { id: 'sub:0', start: 0, end: 11, src: 'Applause.' },
    { id: 'sub:1', start: 11, end: 15, src: 'Hello everyone, today we talk about grit.' },
    { id: 'sub:2', start: 15, end: 19, src: 'It is about passion and perseverance over time.' },
    { id: 'sub:3', start: 19, end: 23, src: 'Thank you all for coming tonight.' },
  ];
  const startOf = Object.fromEntries(subtitles.map(c => [c.src, c.start]));
  const requests = await capture({ subtitles, duration: 23, count: 4, analyze: () => new Promise(() => {}),
    labelAt: t => (t < 11 ? 'INTRO' : `SPEAKER@${Math.floor(t)}`) });
  assert(requests.every(r => r.ref), '1. every request carries a voice sample');
  assert.equal(new Set(requests.map(r => r.ref)).size, 1, '2. unlabeled cues share one timbre');
  assert(!requests[0].ref.startsWith('INTRO'), '3. timbre is not sampled from the intro/applause cue');
  for (const r of requests) {
    assert.equal(r.emo, startOf[r.text] < 11 ? 'INTRO' : `SPEAKER@${startOf[r.text]}`, `4. "${r.text}" uses its own audio as emotion reference`);
  }
}

// A silent line gets no emotion reference but keeps the shared timbre.
{
  const subtitles = [
    { id: 'sub:0', start: 0, end: 4, src: 'We start with a clear sentence here.' },
    { id: 'sub:1', start: 4, end: 8, src: 'This one was recorded in silence.' },
  ];
  const requests = await capture({ subtitles, duration: 8, count: 2, analyze: () => new Promise(() => {}),
    labelAt: t => (t >= 4 ? 'SILENCE' : 'VOICE') });
  assert.deepEqual(requests.map(r => r.ref), ['VOICE', 'VOICE']);
  assert.deepEqual(requests.map(r => r.emo), ['VOICE', null]);
}

// Diarized speakers keep their own timbre, even over a configured voice.
{
  const spans = [['A', 0, 4], ['B', 4, 8], ['A', 8, 12]].map(([speaker, start, end]) => ({ speaker, start, end, kind: 'speech' }));
  const subtitles = spans.map((s, i) => ({ id: `sub:${i}`, start: s.start, end: s.end, src: `Sentence number ${i} spoken here.` }));
  const person = t => spans.find(s => t >= s.start && t < s.end)?.speaker || 'A';
  const requests = await capture({ subtitles, duration: 12, count: 3, preparationMode: 'full', configured: 'CONFIGURED',
    analyze: async () => ({ duration: 12, spans }), labelAt: person });
  assert.deepEqual(requests.map(r => r.ref), ['A', 'B', 'A'], '2. timbre per diarized speaker');
  assert.deepEqual(requests.map(r => r.emo), ['A', 'B', 'A'], '4. emotion from each line');
}

// Wire format: emotion reference switches Index-TTS to "Use emotion reference audio".
{
  const withEmotion = buildGenSingleData({ promptFile: { path: 'voice' }, text: '你好', emotionFile: { path: 'line' } });
  assert.equal(withEmotion[0], TTS_EMO_FROM_AUDIO);
  assert.deepEqual(withEmotion[4], { path: 'line' });
  const plain = buildGenSingleData({ promptFile: { path: 'voice' }, text: '你好' });
  assert.equal(plain[0], TTS_EMO_SAME_AS_REF);
  assert.equal(plain[4], null);
}

// End-to-end client: shared timbre uploaded once; each line's emotion clip is sent.
{
  const uploads = [], submissions = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === '/gradio_api/upload') {
      const bytes = await options.body.get('files').text();
      uploads.push(bytes);
      return Response.json([`/tmp/${bytes}.wav`]);
    }
    if (path === '/gradio_api/call/gen_single') { submissions.push(JSON.parse(options.body).data); return Response.json({ event_id: 'e1' }); }
    if (path === '/gradio_api/call/gen_single/e1') return new Response(`event: complete\ndata: ${JSON.stringify([{ path: '/tmp/o.wav', url: '/gradio_api/file=/tmp/o.wav' }])}\n\n`);
    if (path === '/gradio_api/file=/tmp/o.wav') return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/wav' } });
    throw new Error(`Unexpected route ${path}`);
  };
  const voice = new Blob(['voice'], { type: 'audio/wav' });
  await synthesizeTts({ baseUrl: 'https://tts.test' }, '第一句', { referenceBlob: voice, emotionBlob: new Blob(['line1']) });
  await synthesizeTts({ baseUrl: 'https://tts.test' }, '第二句', { referenceBlob: voice, emotionBlob: new Blob(['line2']) });
  assert.deepEqual(uploads, ['voice', 'line1', 'line2'], '5. shared timbre uploaded once, emotion per line');
  assert.deepEqual(submissions.map(d => [d[0], d[1].path, d[4].path]), [
    [TTS_EMO_FROM_AUDIO, '/tmp/voice.wav', '/tmp/line1.wav'],
    [TTS_EMO_FROM_AUDIO, '/tmp/voice.wav', '/tmp/line2.wav'],
  ]);
}

// Quiet talk recordings (e.g. RMS ~0.013, peak ~0.15) must not lose their voice.
{
  const sr = 16000, speech = Float32Array.from({ length: sr * 4 }, (_, i) => 0.15 * Math.sin(i / 7) * (Math.floor(i / 1600) % 2));
  const quiet = voiceSample(speech, sr);
  assert(quiet.ok && quiet.gain > 1 && quiet.samples, '6. quiet clean speech is normalized and accepted');
  const hiss = voiceSample(Float32Array.from({ length: sr * 4 }, (_, i) => ((i * 7919) % 13 - 6) / 1600), sr);
  assert(!hiss.ok, '6. near-silence is not amplified into a voice');
}

console.log('PASS voice contract: never reference-less, per-speaker timbre, shared unlabeled voice, speech-dense sample, per-line emotion, single upload, quiet-speech sample');

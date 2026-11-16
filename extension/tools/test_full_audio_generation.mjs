import assert from 'node:assert/strict';
import { session, until } from './interpret-test-harness.mjs';
import { installMemoryIndexedDB } from './idb_mem.mjs';
import { runPlannedInterpret } from '../lib/planned-interpret.js';
import { encodeMonoWav } from '../lib/tts.js';
import { loadFullMediaArchive, composeCompactDubTrack } from '../lib/audio-composer.js';
import { videoIdentity } from '../lib/library.js';
import { createVideoDubCache, clearVideoDubCache, dubKey, writeDubCache, pruneDubCache } from '../lib/dub-cache.js';
installMemoryIndexedDB();
const url = 'https://www.youtube.com/watch?v=full-audio-test';
const videoId = videoIdentity(url);
const blob = encodeMonoWav(new Float32Array(2400).fill(.1), 24000);
let chatCalls = 0, ttsCalls = 0;
const source = {
  duration: 180,
  subtitles: Array.from({ length: 30 }, (_, i) => ({ start: i * 6, end: i * 6 + 5, text: `Sentence ${i}` })),
  analyze: async () => { throw Error('no analysis'); },
  slice: async (start, seconds) => ({ start, end: start + seconds, seconds, blob }), close: async () => {},
};
const settings = { text: { baseUrl: 'https://text.test', model: 'm' }, tts: { baseUrl: 'https://tts.test', preparationMode: 'progressive' } };
async function run(extra = {}) {
  const events = [];
  const result = await runPlannedInterpret({
    sourceUrl: url, tabId: 1, audioOnly: true, generateFull: true, settings,
    signal: AbortSignal.timeout(10000),
    // No playback at all: generation must still cover the entire source.
    getAudioPlayhead: () => 0, getAudioScheduledTime: () => 0, isAudioActive: () => false,
    video: async cmd => { assert(['pick', 'media'].includes(cmd)); return { ok: true }; },
    openSource: async () => source, getTtsRef: async () => null, voiceRef: async () => null,
    chat: async (_, { messages }) => {
      chatCalls++;
      return JSON.stringify({ lines: JSON.parse(messages[1].content).current.map(c => ({ ids: [c.id], zh: `译文 ${c.src}` })) });
    },
    synthesizeTts: async () => { ttsCalls++; return { blob }; }, audioDuration: async () => .1,
    onEvent: ev => events.push(ev), ...extra,
  });
  return { events, result };
}
const first = await run();
assert.equal(first.result.lines.length, 30);
assert.equal(ttsCalls, 30);
const archive = await loadFullMediaArchive(videoId);
assert.equal(archive.complete, true);
assert.equal(archive.compactCues.length, 30);
assert(archive.compactAudioBlob.size > 100);
assert(Math.abs(archive.compactDuration - (30 * .1 + 29 * .25)) < .01);
assert(first.events.some(e => e.type === 'archive_saved'));
console.log('PASS: full generation without playback produces all 30 segments and a downloadable joined WAV');
chatCalls = ttsCalls = 0;
const second = await run();
assert.equal(chatCalls, 0, 'Complete plan must bypass translation');
assert.equal(ttsCalls, 0, 'Generated audio must be reused');
assert.equal(second.events.filter(e => e.type === 'generation_progress').at(-1).reused, 30);
console.log('PASS: second run makes zero translation and zero TTS calls');
const key = await dubKey({ legacy: 'shared' });
await writeDubCache(key, ['old']);
const other = await createVideoDubCache('another-video');
await other.set(key, ['keep']);
await clearVideoDubCache(videoId);
await pruneDubCache();
assert.equal(await (await createVideoDubCache(videoId)).get(key), null, 'Clear disables legacy fallback');
assert.deepEqual(await other.get(key), ['keep']);
chatCalls = ttsCalls = 0;
await run();
assert(chatCalls > 0);
assert.equal(ttsCalls, 30);
console.log('PASS: clearing one video forces regeneration without clearing another video');
await assert.rejects(composeCompactDubTrack([{ blob: new Blob(['invalid']) }]), /无法解码/);
console.log('PASS: corrupt segments fail export instead of silently producing an incomplete file');
const cancelledUrl = 'https://www.youtube.com/watch?v=cancelled-full-audio';
const abort = new AbortController();
await assert.rejects(run({ sourceUrl: cancelledUrl, signal: abort.signal,
  onEvent: ev => { if (ev.type === 'dub_segment') abort.abort(); },
}), error => error.name === 'AbortError');
assert.equal(await loadFullMediaArchive(videoIdentity(cancelledUrl)), null);
console.log('PASS: cancellation never publishes a partial file as a completed archive');

// The first translated window and its emitted audio survive transfer to a fresh worker.
const handoffUrl = 'https://www.youtube.com/watch?v=handoff-progress';
const translated = [], synthesized = [];
const handoff = {
  sourceUrl: handoffUrl,
  chat: async (_, { messages }) => {
    const { current } = JSON.parse(messages[1].content);
    translated.push(...current.map(c => c.src));
    return JSON.stringify({ lines: current.map(c => ({ ids: [c.id], zh: '译文 ' + c.src })) });
  },
  synthesizeTts: async (_, text) => { synthesized.push(text); return { blob }; },
};
const transfer = new AbortController();
await assert.rejects(run({ ...handoff, signal: transfer.signal, onEvent: e => {
  if (e.type === 'dub_segment') transfer.abort();
} }), { name: 'AbortError' });
const finished = await run(handoff);
assert.equal(finished.result.lines.length, 30);
assert.equal(new Set(synthesized).size, 30);
assert.equal(synthesized.length, 30, 'completed audio is not synthesized again');
assert.equal(translated.filter(text => text === 'Sentence 0').length, 1);
console.log('PASS partial handoff reuses committed translations and audio before finishing the archive');

// An offline provider must not consume another retry budget for every remaining line.
const outageUrl = 'https://www.youtube.com/watch?v=offline-full-audio';
const attempted = [];
await assert.rejects(run({ sourceUrl: outageUrl, synthesizeTts: async (_, line) => {
  attempted.push(line);
  if (attempted.length === 1) return { blob };
  throw new TypeError('Failed to fetch');
} }), /处理已停止.*Failed to fetch/);
assert.equal(attempted.length, 3);
assert.equal(attempted[1], attempted[2]);
assert.equal(await loadFullMediaArchive(videoIdentity(outageUrl)), null);
const resumedLines = [];
await run({ sourceUrl: outageUrl, synthesizeTts: async (_, line) => {
  resumedLines.push(line);
  return { blob };
} });
assert.equal(resumedLines.length, 29);
assert(!resumedLines.includes(attempted[0]));
console.log('PASS offline TTS stops the job and retry preserves completed audio');

// A held playhead must not delay saving a fully generated live dub.
const liveUrl = 'https://video.test/live-auto-save';
const live = session({
  sourceUrl: liveUrl, settings, generateFull: true, openSource: async () => source,
  voiceRef: async () => blob, synthesizeTts: async () => ({ blob }),
});
try {
  await until(() => live.events.some(e => e.type === 'archive_saved'), 10000);
  const saved = await loadFullMediaArchive(videoIdentity(liveUrl));
  assert(saved.complete && saved.compactAudioBlob.size > 100);
  assert.equal(live.state.currentTime, 0);
  assert.equal(live.events.filter(e => e.type === 'archive_saved').length, 1);
} finally { await live.stop(); }
console.log('PASS completed audio saves once while the live player is still open');

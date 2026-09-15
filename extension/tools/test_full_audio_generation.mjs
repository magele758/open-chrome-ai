import assert from 'node:assert/strict';
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

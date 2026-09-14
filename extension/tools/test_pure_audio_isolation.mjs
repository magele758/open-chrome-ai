import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { runPlannedInterpret } from '../lib/planned-interpret.js';
import { InterpretController } from '../sidepanel/interpret-controller.js';

// A paused page must not govern audio production, even beyond the planning window.
const blob = new Blob(['audio']);
let playhead = 0;
const actions = [], segments = [];
const source = {
  duration: 180,
  subtitles: Array.from({ length: 30 }, (_, i) => ({ start: i * 6, end: i * 6 + 5, text: `Sentence ${i}.` })),
  analyze: async () => { throw new Error('No speaker analysis'); },
  slice: async (start, seconds) => ({ start, seconds, end: start + seconds, blob }),
  close: async () => {},
};
await runPlannedInterpret({
  tabId: 1, audioOnly: true,
  settings: { text: { baseUrl: 'https://text.test', model: 'm' }, tts: { baseUrl: 'https://tts.test', preparationMode: 'progressive' } },
  signal: AbortSignal.timeout(10000),
  openSource: async () => source,
  video: async cmd => { actions.push(cmd); return { ok: true, paused: true, currentTime: 0 }; },
  getAudioPlayhead: () => playhead,
  getAudioScheduledTime: () => playhead,
  isAudioActive: () => true,
  cacheGet: async () => null, cacheSet: async () => {}, getTtsRef: async () => null,
  voiceRef: async () => null,
  chat: async (_, { messages }) => JSON.stringify({ lines: JSON.parse(messages[1].content).current.map(c => ({ ids: [c.id], zh: `译文 ${c.src}` })) }),
  synthesizeTts: async () => ({ blob }), audioDuration: async () => 2,
  onEvent: ev => { if (ev.type === 'dub_segment') { segments.push(ev.segment); playhead = ev.segment.end; } },
});
assert.equal(segments.length, 30);
assert(playhead > 170);
assert.deepEqual(actions, ['pick', 'media'], 'Audio generation must not watch, resume, mute or poll the video');
console.log('PASS: 3-minute pure audio finishes independently of a paused video');

// Cancel during page probing: no late-started task may survive cancellation.
let release;
globalThis.chrome = { tabs: { get: async id => ({ id, url: 'https://video.test' }) }, scripting: {
  executeScript: async () => { await new Promise(resolve => { release = resolve; }); return [{ result: { ok: true } }]; },
} };
const ctrl = new InterpretController({ audioOnly: true });
const events = [];
ctrl.subscribe(ev => events.push(ev.type));
const starting = ctrl.start({ tab: { id: 9, url: 'https://video.test' }, settings: {} });
while (!release) await new Promise(resolve => setTimeout(resolve, 1));
const stopping = ctrl.stop(9);
release();
await Promise.all([starting, stopping]);
assert(!events.includes('started'));
assert.equal(ctrl.tasks.size, 0);
console.log('PASS: cancel during preparation prevents late startup');
delete globalThis.chrome;

// Exercise actual panel functions with a small DOM/audio harness.
const app = fs.readFileSync(new URL('../sidepanel/app.js', import.meta.url), 'utf8');
const els = new Map();
const el = id => {
  if (!els.has(id)) els.set(id, { dataset: {}, classList: { add() {}, remove() {} }, setAttribute() {}, textContent: '' });
  return els.get(id);
};
let videoStarts = 0, audioStarts = 0, audioStops = 0;
class FakeAudio {
  constructor() { this.paused = true; this.currentTime = 0; this.duration = 100; }
  async play() { this.paused = false; }
  pause() { this.paused = true; }
}
const context = vm.createContext({
  console, Blob, URL, Audio: FakeAudio, setTimeout: fn => { fn(); return 1; }, setInterval: () => 1, clearInterval() {},
  $: el, state: { tab: { id: 1 }, settings: { asr: {}, tts: {} }, pack: {} },
  InterpretController: class { constructor() { this.running = false; }
    setAudioProviders() {} subscribe(fn) { this.listener = fn; } isRunning() { return this.running; }
    async start() { this.running = true; audioStarts++; } async stop() { this.running = false; audioStops++; }
  },
  renderContext() {}, renderTranscribeAction() {}, formatTime: n => String(n), pushError: err => { throw Error(err); },
  getSharedAudioContext: () => null, injectVideo: async () => ({ ok: true }),
  isAsrReady: () => true, isTtsReady: () => true, requireModel: () => true,
  startInterpret: () => { videoStarts++; },
});
const from = app.indexOf('const interpretController =');
const to = app.indexOf('async function regenerateCurrentDubbing');
vm.runInContext(app.slice(from, to), context);
await vm.runInContext('toggleCompactPlayback()', context);
assert.equal(audioStarts, 1);
assert.equal(videoStarts, 0);
await vm.runInContext('toggleCompactPlayback()', context);
assert.equal(vm.runInContext('compactPendingAutoplay', context), false);
assert(audioStops > 0);
// Another tab's events must never enter this player's queue.
vm.runInContext('compactSessionOpen = true; compactController.listener({ type: "dub_segment", segment: { id: "wrong" } }, { tabId: 2 })', context);
assert.equal(vm.runInContext('compactSegments.length', context), 0);
await vm.runInContext('startCompactArchivePlayback(new Blob(["audio"]), {})', context);
vm.runInContext('compactPlayerAudio.currentTime = 42', context);
await vm.runInContext('toggleCompactPlayback()', context);
assert.equal(vm.runInContext('compactPlayerAudio.currentTime', context), 42);
assert.equal(vm.runInContext('compactPlaying', context), false);
await vm.runInContext('toggleCompactPlayback()', context);
vm.runInContext('compactPlayerAudio.currentTime = 43; compactPlayerAudio.ontimeupdate()', context);
assert.equal(el('cp-time').textContent, '43 / 100');
assert.equal(vm.runInContext('compactPlaying', context), true);
console.log('PASS: independent entry, cancel, tab filtering and archive pause/resume progress');

// Seeking keeps the exact offset and the closed-stream marker, including while paused.
const { StreamingAudioPlayer } = await import('../lib/streaming-audio-player.js');
const player = new StreamingAudioPlayer({ AudioContextClass: null, createAudioElement: () => new FakeAudio() });
await player.pause();
await player.enqueue({ id: 'a', blob, start: 0, end: 5 });
await player.enqueue({ id: 'b', blob, start: 5, end: 10 });
player.history.forEach(item => { item.duration = 5; });
player.closeStream();
await player.seekToTime(7);
assert.equal(player.getCurrentPlaybackTime(), 7);
assert.equal(player.state, 'paused');
assert.equal(player.streamClosed, true);
await player.play();
assert.equal(player.activeAudio.currentTime, 2);
assert.equal(player.getCurrentPlaybackTime(), 7);
player.stop();
console.log('PASS: precise seek preserves paused position and stream completion');

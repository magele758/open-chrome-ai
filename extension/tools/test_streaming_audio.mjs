import assert from 'node:assert/strict';
import { StreamingAudioPlayer } from '../lib/streaming-audio-player.js';
import { runPlannedInterpret } from '../lib/planned-interpret.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error('Timeout waiting for condition: ' + fn.toString());
}

console.log('Starting StreamingAudioPlayer test suite...');

// 1. Mock Web Audio Environment
class MockBufferSource {
  constructor(ctx) {
    this.ctx = ctx;
    this.buffer = null;
    this.playbackRate = { value: 1.0 };
    this.startedAt = -1;
    this.stoppedAt = -1;
    this.connected = false;
  }
  connect(dest) { this.connected = true; }
  disconnect() { this.connected = false; }
  start(when) { this.startedAt = when; }
  stop() { this.stoppedAt = this.ctx.currentTime; }
}

class MockGainNode {
  constructor(ctx) {
    this.ctx = ctx;
    this.gain = {
      value: 1.0,
      setValueAtTime(val) { this.value = val; },
    };
  }
  connect() {}
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.destination = {};
    this.sources = [];
  }
  createGain() { return new MockGainNode(this); }
  createBufferSource() {
    const src = new MockBufferSource(this);
    this.sources.push(src);
    return src;
  }
  decodeAudioData(arrayBuffer) {
    // Return mock AudioBuffer with duration 2.0s
    return Promise.resolve({
      duration: 2.0,
      sampleRate: 24000,
      numberOfChannels: 1,
    });
  }
  async suspend() { this.state = 'suspended'; }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}

// TEST 1: Web Audio Gapless Scheduling (0ms gap)
{
  const mockCtx = new MockAudioContext();
  const started = [];
  const ended = [];
  const bufferingEvents = [];

  const player = new StreamingAudioPlayer({
    AudioContextClass: function() { return mockCtx; },
    gapMs: 0,
    onItemStart: item => started.push(item.id),
    onItemEnd: item => ended.push(item.id),
    onBuffering: isBuf => bufferingEvents.push(isBuf),
  });

  const blob1 = new Blob(['chunk1'], { type: 'audio/wav' });
  const blob2 = new Blob(['chunk2'], { type: 'audio/wav' });

  await player.enqueue({ id: 'seg1', blob: blob1, zh: '第一句' });
  await player.enqueue({ id: 'seg2', blob: blob2, zh: '第二句' });

  assert.equal(mockCtx.sources.length, 2, 'Both chunks should be scheduled in Web Audio');

  const src1 = mockCtx.sources[0];
  const src2 = mockCtx.sources[1];

  assert(src1.startedAt >= 0, 'Chunk 1 has scheduled start');
  // Gapless verification: Chunk 2 starts exactly when chunk 1 finishes (src1.startedAt + 2.0s duration)
  const diff = Math.abs(src2.startedAt - (src1.startedAt + 2.0));
  assert(diff < 0.0001, `Gapless check: diff between chunk 1 end and chunk 2 start is ${diff}s, expected 0ms gap`);

  // Simulate hardware clock advance to trigger onItemStart
  mockCtx.currentTime = src1.startedAt + 0.1;
  player.tick();
  assert.equal(started.length, 1);
  assert.equal(started[0], 'seg1');

  // Advance time to chunk 2
  mockCtx.currentTime = src2.startedAt + 0.1;
  player.tick();
  assert.equal(started.length, 2);
  assert.equal(started[1], 'seg2');
  assert.equal(ended.length, 1);
  assert.equal(ended[0], 'seg1');

  // Advance past chunk 2 -> Starvation detection
  mockCtx.currentTime = src2.startedAt + 2.1;
  player.tick();
  assert.equal(ended.length, 2);
  assert.equal(ended[1], 'seg2');
  assert(player.isBuffering, 'Player enters buffering state after queue depletes');

  // Incremental supplement ("翻译一段补一段")
  const blob3 = new Blob(['chunk3'], { type: 'audio/wav' });
  await player.enqueue({ id: 'seg3', blob: blob3, zh: '第三句' });

  assert.equal(mockCtx.sources.length, 3, 'New chunk scheduled immediately upon arrival');
  assert(!player.isBuffering, 'Buffering cleared when new chunk arrives');

  player.stop();
  assert.equal(player.state, 'stopped');
  console.log('  PASS: Web Audio gapless scheduling and starvation buffering');
}

// TEST 2: Playback Controls (Pause, Resume, Rate, Volume)
{
  const mockCtx = new MockAudioContext();
  const player = new StreamingAudioPlayer({
    AudioContextClass: function() { return mockCtx; },
  });

  await player.enqueue({ id: 'ctrl1', blob: new Blob(['c1']), zh: '测试控制' });

  assert.equal(player.state, 'playing');

  await player.pause();
  assert.equal(player.state, 'paused');
  assert.equal(mockCtx.state, 'suspended');

  await player.resume();
  assert.equal(player.state, 'playing');
  assert.equal(mockCtx.state, 'running');

  player.setPlaybackRate(1.5);
  assert.equal(player.playbackRate, 1.5);
  assert.equal(mockCtx.sources[0].playbackRate.value, 1.5);

  player.setVolume(0.7);
  assert.equal(player.volume, 0.7);
  assert.equal(player.gainNode.gain.value, 0.7);

  player.stop();
  console.log('  PASS: Playback controls (pause, resume, rate, volume)');
}

// TEST 3: Element Fallback Queue
{
  class MockAudioElement {
    constructor(url) {
      this.url = url;
      this.paused = true;
      this.playbackRate = 1.0;
      this.volume = 1.0;
      this.onended = null;
      this.onerror = null;
    }
    play() {
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
  }

  const audioInstances = [];
  const started = [];
  const ended = [];

  const player = new StreamingAudioPlayer({
    AudioContextClass: null, // Force Element fallback
    createAudioElement: url => {
      const a = new MockAudioElement(url);
      audioInstances.push(a);
      return a;
    },
    onItemStart: item => started.push(item.id),
    onItemEnd: item => ended.push(item.id),
  });

  await player.enqueue({ id: 'elem1', blob: new Blob(['e1']), zh: '第一句回退' });
  assert.equal(audioInstances.length, 1);
  assert.equal(started[0], 'elem1');
  assert(!audioInstances[0].paused);

  await player.enqueue({ id: 'elem2', blob: new Blob(['e2']), zh: '第二句回退' });

  // Trigger end of first audio
  audioInstances[0].onended();
  await sleep(10);

  assert.equal(ended[0], 'elem1');
  assert.equal(audioInstances.length, 2);
  assert.equal(started[1], 'elem2');
  assert(!audioInstances[1].paused);

  player.closeStream();
  audioInstances[1].onended();
  await sleep(10);

  assert.equal(player.state, 'idle');
  player.stop();
  console.log('  PASS: Element fallback queue');
}

// TEST 4: runPlannedInterpret Streaming Mode (Decoupled from Video Transport)
{
  const state = {
    ok: true,
    currentTime: 0,
    duration: 30,
    paused: false,
    userPaused: false,
    seekRevision: 0,
    readyState: 4,
    playbackRate: 1,
  };

  const abort = new AbortController();
  const cues = [
    { start: 0, end: 5, text: 'Hello world.' },
    { start: 6, end: 12, text: 'Streaming translation without video pause.' },
  ];

  const blob = new Blob(['speech_audio']);
  const emittedLines = [];
  let streamPlayerRef = null;

  class MockAudioElement {
    constructor(url) {
      this.paused = true;
      this.playbackRate = 1;
      this.volume = 1;
    }
    play() {
      this.paused = false;
      return Promise.resolve();
    }
    pause() { this.paused = true; }
  }

  const running = runPlannedInterpret({
    tabId: 1,
    sourceUrl: 'https://fixture.test/streaming',
    settings: {
      text: { baseUrl: 'https://text.test', model: 'm' },
      tts: { baseUrl: 'https://tts.test', preparationMode: 'progressive', playbackMode: 'stream' },
    },
    signal: abort.signal,
    streamPlayback: true,
    AudioContextClass: null, // Use element mock for deterministic testing
    createAudioElement: url => new MockAudioElement(url),
    audioDuration: async () => 3.0,
    openSource: async () => ({
      duration: 30,
      subtitles: cues,
      close: async () => {},
      analyze: async () => ({ spans: [{ start: 0, end: 30, kind: 'unknown', speaker: null }] }),
      slice: async (start, seconds) => ({ start, end: start + seconds, seconds, blob }),
    }),
    video: async (cmd, arg = {}) => {
      if (cmd === 'control') state.paused = arg.action === 'pause';
      return { ...state };
    },
    transcribe: async () => [],
    chat: async (_m, { messages }) => {
      const input = JSON.parse(messages[1].content);
      return JSON.stringify({
        lines: (input.current || []).map(c => ({ ids: [c.id], zh: '中文: ' + c.src })),
      });
    },
    synthesizeTts: async (_m, text) => ({ blob }),
    onStreamPlayer: p => { streamPlayerRef = p; },
    onEvent: ev => {
      if (ev.type === 'line') emittedLines.push(ev);
    },
  });

  try {
    // Wait until stream player is initialized and received first line
    await until(() => streamPlayerRef !== null && streamPlayerRef.startedCount >= 1);
    assert(streamPlayerRef, 'Stream player was attached to task');
    assert.equal(emittedLines.length, 1);
    assert.equal(emittedLines[0].zh, '中文: Hello world.');

    // Simulate user pausing video: video is paused, but streaming audio MUST continue
    state.userPaused = true;
    state.paused = true;
    await sleep(50);

    // Verify audio stream is NOT stopped/paused simply by video user pause!
    assert.equal(streamPlayerRef.state, 'playing', 'Streaming audio continues even when video is paused by user');

    // Simulate stream player advancing to next chunk
    if (streamPlayerRef.activeAudio?.onended) {
      streamPlayerRef.activeAudio.onended();
    }
    await until(() => emittedLines.length >= 2);
    assert.equal(emittedLines[1].zh, '中文: Streaming translation without video pause.');

    abort.abort();
    await running.catch(err => {
      if (err.name !== 'AbortError') throw err;
    });
  } finally {
    abort.abort();
  }
  console.log('  PASS: runPlannedInterpret in streaming mode decouples from video user pause and emits lines smoothly');
}

// TEST 5: Starvation Auto-Splicing and Source Time Tracking
{
  const mockCtx = {
    currentTime: 0,
    state: 'running',
    sources: [],
    createGain() {
      return { gain: { value: 1, setValueAtTime() {} }, connect() {} };
    },
    createBufferSource() {
      const src = {
        ctx: this,
        buffer: null,
        playbackRate: { value: 1.0 },
        startedAt: -1,
        connect() {},
        start(when) { this.startedAt = when; },
      };
      this.sources.push(src);
      return src;
    },
    decodeAudioData() {
      return Promise.resolve({ duration: 2.0, sampleRate: 24000, numberOfChannels: 1 });
    },
    async resume() { this.state = 'running'; },
    async suspend() { this.state = 'suspended'; },
  };

  const started = [];
  const ended = [];
  const player = new StreamingAudioPlayer({
    AudioContextClass: function() { return mockCtx; },
    gapMs: 0,
    onItemStart: item => started.push(item.id),
    onItemEnd: item => ended.push(item.id),
  });

  const blob = new Blob(['wav']);

  // 1. Enqueue chunk 1 (0s to 5s in source time, 2s duration)
  await player.enqueue({ id: 'c1', blob, start: 0, end: 5 });
  assert.equal(player.getCurrentSourceTime(), 0);
  assert.equal(player.getScheduledSourceTime(), 5);
  assert.equal(mockCtx.sources.length, 1);
  assert.equal(mockCtx.sources[0].startedAt, 0.02);

  // Advance time to 1.0s: chunk 1 playing
  mockCtx.currentTime = 1.0;
  player.tick();
  assert.equal(started.includes('c1'), true);
  assert.equal(player.getCurrentSourceTime(), 5);

  // Advance time to 3.0s: chunk 1 has ended, starvation occurs
  mockCtx.currentTime = 3.0;
  player.tick();
  assert.equal(ended.includes('c1'), true);
  assert.equal(player.isBuffering, true, 'Player should enter buffering on starvation');
  assert.equal(player.getCurrentSourceTime(), 5, 'Current source time persists after chunk ends');

  // 2. Enqueue chunk 2 after starvation (5s to 12s in source time)
  // Player MUST automatically splice and schedule at currentTime + 0.02 without requiring play()!
  await player.enqueue({ id: 'c2', blob, start: 5, end: 12 });
  assert.equal(mockCtx.sources.length, 2, 'Chunk 2 was decoded and scheduled');
  assert.equal(mockCtx.sources[1].startedAt, 3.02, 'Chunk 2 scheduled immediately at curTime + 0.02');
  assert.equal(player.isBuffering, false, 'Player recovers from buffering automatically');
  assert.equal(player.state, 'playing', 'Player transitions back to playing state automatically');
  assert.equal(player.getScheduledSourceTime(), 12, 'Furthest scheduled source time updated');

  // Advance time to 3.05s: chunk 2 starts playing
  mockCtx.currentTime = 3.05;
  player.tick();
  assert.equal(started.includes('c2'), true, 'Chunk 2 started automatically');

  player.stop();
  console.log('  PASS: Starvation auto-splicing and source time tracking');
}

// TEST 6: Seeking and Duration in StreamingAudioPlayer
{
  const mockCtx = new MockAudioContext();
  const player = new StreamingAudioPlayer({
    AudioContextClass: function() { return mockCtx; },
    gapMs: 0,
  });

  const blob1 = new Blob(['b1']);
  const blob2 = new Blob(['b2']);
  const blob3 = new Blob(['b3']);

  await player.enqueue({ id: 's1', blob: blob1, zh: '句一' });
  await player.enqueue({ id: 's2', blob: blob2, zh: '句二' });
  await player.enqueue({ id: 's3', blob: blob3, zh: '句三' });

  // Each mock chunk has duration 2.0s
  assert.equal(player.getTotalDuration(), 6.0, 'Total duration should be 6.0s (3 * 2.0s)');

  // Advance time to 1.0s (in the middle of chunk 1)
  mockCtx.currentTime = 1.0;
  player.tick();
  const curTime = player.getCurrentPlaybackTime();
  assert(curTime >= 0.9 && curTime <= 1.1, `Current playback time should be around 1.0s, got ${curTime}`);

  // Seek forward to 3.0s (inside chunk 2)
  await player.seekToTime(3.0);
  assert.equal(player.scheduledItems.length, 2, 'Seeking to 3.0s should schedule chunk 2 and 3');
  assert.equal(player.scheduledItems[0].id, 's2');
  assert.equal(player.scheduledItems[1].id, 's3');

  // Seek backward to 0.5s (inside chunk 1)
  await player.seekToTime(0.5);
  assert.equal(player.scheduledItems.length, 3, 'Seeking to 0.5s should re-schedule all chunks');
  assert.equal(player.scheduledItems[0].id, 's1');

  player.stop();
  console.log('  PASS: StreamingAudioPlayer duration tracking and seeking');
}

// TEST 7: Universal Content-Based TTS Cache Reuse
{
  const cache = new Map();
  const cacheGet = async k => cache.get(k);
  const cacheSet = async (k, v) => { cache.set(k, v); return true; };

  let ttsCount = 0;
  const mockTts = async (cfg, text) => {
    ttsCount++;
    return { blob: new Blob(['audio:' + text], { type: 'audio/wav' }) };
  };

  const plan = {
    sourceKey: 'vid-test-identity',
    spans: [{ start: 0, end: 20, kind: 'speech', speaker: 'spk1' }],
    lines: [
      { id: '1:0', zh: '这是测试翻译', src: 'This is test translation', start: 0, end: 3, speaker: 'spk1' }
    ]
  };

  const emitted = [];
  const abort1 = new AbortController();

  const mockVideo = async () => ({ ok: true, paused: false, currentTime: 0, duration: 20 });
  const mockSource = {
    duration: 20,
    analyze: async () => ({ duration: 20, fingerprint: 'f', spans: [{ start: 0, end: 20, kind: 'speech', speaker: 'A' }] }),
    slice: async (s, d) => ({ start: s, end: s + d, seconds: d, blob: new Blob(['slice']) }),
    close: async () => {}
  };
  const mockTranscribe = async () => [{ start: 0, end: 3, text: 'This is test' }];
  const mockChat = async () => JSON.stringify({ lines: [{ ids: ['c1'], zh: '这是测试翻译' }] });

  class MockAudioEl {
    constructor(url) { this.paused = true; this.playbackRate = 1; this.volume = 1; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  }

  // Run 1: first generation
  const run1 = runPlannedInterpret({
    tabId: 99,
    plan,
    video: mockVideo,
    openSource: async () => mockSource,
    transcribe: mockTranscribe,
    chat: mockChat,
    AudioContextClass: null,
    createAudioElement: url => new MockAudioEl(url),
    settings: {
      text: { baseUrl: 'https://text.test', model: 'm' },
      asr: { baseUrl: 'https://asr.test', model: 'w' },
      tts: { baseUrl: 'https://tts.test', model: 'mock-tts', lang: 'ZH', preparationMode: 'buffered' }
    },
    signal: abort1.signal,
    synthesizeTts: mockTts,
    audioDuration: async () => 2.5,
    voiceRef: async b => b,
    cacheGet,
    cacheSet,
    streamPlayback: true,
    onEvent: e => emitted.push(e),
    createAudio: () => ({ paused: true, play: () => {}, pause: () => {} }),
  });

  await until(() => ttsCount >= 1 && emitted.some(e => e.type === 'dub_segment'), 5000);
  abort1.abort();
  try { await run1; } catch {}

  assert.equal(ttsCount, 1, 'First run calls TTS synthesis');
  assert(emitted.some(e => e.type === 'dub_segment'));

  // Run 2: second generation with same zh and TTS settings, but different line ID or timestamps!
  const plan2 = {
    sourceKey: 'vid-test-different-identity',
    spans: [{ start: 0, end: 20, kind: 'speech', speaker: 'spk1' }],
    lines: [
      { id: '99:88', zh: '这是测试翻译', src: 'Different line', start: 10, end: 15, speaker: 'spk1' }
    ]
  };

  const emitted2 = [];
  const abort2 = new AbortController();
  const run2 = runPlannedInterpret({
    tabId: 99,
    plan: plan2,
    video: mockVideo,
    openSource: async () => mockSource,
    transcribe: mockTranscribe,
    chat: mockChat,
    AudioContextClass: null,
    createAudioElement: url => new MockAudioEl(url),
    settings: {
      text: { baseUrl: 'https://text.test', model: 'm' },
      asr: { baseUrl: 'https://asr.test', model: 'w' },
      tts: { baseUrl: 'https://tts.test', model: 'mock-tts', lang: 'ZH', preparationMode: 'buffered' }
    },
    signal: abort2.signal,
    synthesizeTts: mockTts,
    audioDuration: async () => 2.5,
    voiceRef: async b => b,
    cacheGet,
    cacheSet,
    streamPlayback: true,
    onEvent: e => emitted2.push(e),
    createAudio: () => ({ paused: true, play: () => {}, pause: () => {} }),
  });

  await until(() => emitted2.some(e => e.type === 'dub_segment'), 5000);
  abort2.abort();
  try { await run2; } catch {}

  assert.equal(ttsCount, 1, 'Second run with same content MUST reuse cached TTS audio without re-synthesizing!');
  assert(emitted2.some(e => e.type === 'dub_segment'));

  console.log('  PASS: Universal content-based TTS audio cache reuse');
}

// TEST 8: 1-Hour Pure Audio Streaming Continues Smoothly with Video Paused at 0s
{
  const cache = new Map();
  const cacheGet = async k => cache.get(k);
  const cacheSet = async (k, v) => { cache.set(k, v); return true; };

  const mockVideo = async () => ({
    ok: true,
    paused: true,
    userPaused: true,
    currentTime: 0,
    duration: 3600,
  });

  const mockSource = {
    duration: 3600,
    subtitles: [
      { id: 'sub0', start: 0, end: 10, text: 'Welcome to this 1 hour video' },
      { id: 'sub1', start: 10, end: 35, text: 'This is section one' },
      { id: 'sub2', start: 35, end: 60, text: 'This is section two' },
      { id: 'sub3', start: 60, end: 85, text: 'This is section three beyond 1 minute' },
      { id: 'sub4', start: 85, end: 130, text: 'This is section four deep into the video' },
    ],
    analyze: async () => ({
      duration: 3600,
      fingerprint: 'fp-hour',
      spans: [{ start: 0, end: 3600, kind: 'speech', speaker: 'host' }]
    }),
    slice: async (s, d) => ({ start: s, end: s + d, seconds: d, blob: new Blob(['slice-hour']) }),
    close: async () => {}
  };

  const mockChat = async (cfg, prompt) => {
    const input = JSON.parse(prompt.messages[1].content);
    const current = input.current || [];
    return JSON.stringify({
      lines: current.map(c => {
        if (c.id === 'sub0') return { ids: ['sub0'], zh: '欢迎观看这个一小时的视频' };
        if (c.id === 'sub1') return { ids: ['sub1'], zh: '这是第一部分' };
        if (c.id === 'sub2') return { ids: ['sub2'], zh: '这是第二部分' };
        if (c.id === 'sub3') return { ids: ['sub3'], zh: '这是突破一分钟的第三部分' };
        if (c.id === 'sub4') return { ids: ['sub4'], zh: '这是深度推进的第四部分' };
        return { ids: [c.id], zh: '口播内容：' + (c.src || c.text || '正文') };
      })
    });
  };

  const mockTts = async (cfg, text) => {
    return { blob: new Blob(['tts:' + text], { type: 'audio/wav' }) };
  };

  let audioPlayhead = 0;
  let audioScheduledTime = 0;
  let isAudioActive = true;

  const emitted = [];
  const abort = new AbortController();

  const run = runPlannedInterpret({
    tabId: 100,
    sourceUrl: 'https://example.com/watch?v=one-hour',
    video: mockVideo,
    openSource: async () => mockSource,
    transcribe: async () => [{ start: 0, end: 5, text: 'Speech transcript' }],
    chat: mockChat,
    settings: {
      asr: { baseUrl: 'https://asr.test', model: 'whisper' },
      tts: { baseUrl: 'https://tts.test', model: 'mock-tts', lang: 'ZH', preparationMode: 'progressive', bufferSeconds: 15 }
    },
    signal: abort.signal,
    synthesizeTts: mockTts,
    audioDuration: async () => 4.0,
    cacheGet,
    cacheSet,
    streamPlayback: false, // Explicitly false for pure audio decoupling
    getAudioPlayhead: () => audioPlayhead,
    getAudioScheduledTime: () => audioScheduledTime,
    isAudioActive: () => isAudioActive,
    onEvent: e => {
      emitted.push(e);
      if (e.type === 'dub_segment' && e.segment) {
        if (e.segment.end > audioScheduledTime) {
          audioScheduledTime = e.segment.end;
        }
      }
    },
    createAudio: () => ({ paused: true, play: () => {}, pause: () => {} }),
  });

  // Wait for initial windows (0-60s)
  await until(() => emitted.some(e => e.type === 'dub_segment' && e.segment?.start >= 35), 4000);
  assert(emitted.some(e => e.type === 'dub_segment' && e.segment?.start === 0));

  // Simulate compactStreamPlayer advancing its playback position to 40s (approaching 1 minute)
  audioPlayhead = 40;

  // Verify that planning does NOT stall at 60s, but progresses to produce segments for > 60s
  await until(() => emitted.some(e => e.type === 'dub_segment' && e.segment?.start >= 60), 4000);
  const beyondOneMin = emitted.find(e => e.type === 'dub_segment' && e.segment?.start >= 60);
  assert(beyondOneMin, 'Pure audio must continuously generate segments beyond 1 minute even when video is paused at 0s');
  assert.equal(beyondOneMin.segment.zh, '这是突破一分钟的第三部分');

  // Advance audioPlayhead further to 70s
  audioPlayhead = 70;
  await until(() => emitted.some(e => e.type === 'dub_segment' && e.segment?.start >= 85), 4000);
  const deepSegment = emitted.find(e => e.type === 'dub_segment' && e.segment?.start >= 85);
  assert(deepSegment, 'Pure audio must continue planning deep into the 1-hour source');

  abort.abort();
  try { await run; } catch {}

  console.log('  PASS: 1-Hour pure audio streaming decouples from paused video and continues past 1 minute');
}

// TEST 9: Pausing and Stopping StreamingAudioPlayer ensures absolute silence and blocks background playback
{
  const mockCtx = new MockAudioContext();
  const player = new StreamingAudioPlayer({
    AudioContextClass: function() { return mockCtx; },
    gapMs: 0,
  });

  const blob1 = new Blob(['chunk1']);
  const blob2 = new Blob(['chunk2']);
  const blob3 = new Blob(['chunk3']);

  await player.enqueue({ id: 'p1', blob: blob1, zh: '第一句' });
  await player.play();
  assert.equal(player.state, 'playing');

  // Pause the player
  await player.pause();
  assert.equal(player.state, 'paused');
  assert.equal(player.gainNode.gain.value, 0, 'Gain must be 0 while paused for absolute silence');

  // While paused, background translation pushes a new segment
  await player.enqueue({ id: 'p2', blob: blob2, zh: '第二句' });
  // drainQueue must not auto-start or schedule while paused
  assert.equal(player.state, 'paused', 'Player state must remain paused when chunks are enqueued');
  assert.equal(player.gainNode.gain.value, 0, 'Gain must stay 0');

  // Resume playback
  await player.play();
  assert.equal(player.state, 'playing');
  assert.equal(player.gainNode.gain.value, 1.0, 'Gain restored to volume on play');

  // Stop the player completely
  player.stop();
  assert.equal(player.state, 'stopped');
  assert.equal(player.scheduledItems.length, 0, 'Scheduled items must be cleared on stop');
  assert.equal(player.queue.length, 0, 'Queue must be cleared on stop');

  // Enqueuing after stop is completely ignored
  await player.enqueue({ id: 'p3', blob: blob3, zh: '第三句' });
  assert.equal(player.scheduledItems.length, 0, 'No items scheduled after stop');
  assert.equal(player.state, 'stopped');

  console.log('  PASS: Pausing and stopping StreamingAudioPlayer ensures absolute silence and blocks background playback');
}

console.log('All StreamingAudioPlayer tests passed successfully!');

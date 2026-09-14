import assert from "node:assert";
import { runPlannedInterpret } from "../lib/planned-interpret.js";
import { InterpretController, InterpretState } from "../sidepanel/interpret-controller.js";

console.log("Starting Capability Isolation Test Suite (Video vs Audio)...");

// Helper to wait until condition
async function until(fn, timeoutMs = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timeout waiting for condition");
    await new Promise(r => setTimeout(r, 20));
  }
}

// TEST 1: Video Interpretation MUST ALWAYS run video-sync loop (resume video, hold video, duck audio)
{
  const videoState = {
    ok: true,
    currentTime: 0,
    duration: 60,
    paused: true,
    userPaused: false,
    seekRevision: 0,
    readyState: 4,
    playbackRate: 1,
    audioTracks: [{ enabled: true }],
  };

  const videoActions = [];
  const fakeVideo = async (cmd, arg = {}) => {
    videoActions.push({ cmd, arg });
    if (cmd === 'control') {
      if (arg.action === 'pause') videoState.paused = true;
      if (arg.action === 'play') videoState.paused = false;
    }
    return { ...videoState };
  };

  const cues = [
    { start: 0, end: 4, text: "First sentence of video." },
    { start: 5, end: 9, text: "Second sentence of video." },
  ];

  const blob = new Blob(["speech_data"]);
  const abort = new AbortController();
  const emittedEvents = [];

  class MockAudio {
    constructor(url) {
      this.src = url;
      this.paused = true;
      this.playbackRate = 1;
      this.volume = 1;
      this.currentTime = 0;
      this.duration = 4;
    }
    play() {
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
  }

  const running = runPlannedInterpret({
    tabId: 42,
    sourceUrl: "https://video.test/watch?v=123",
    settings: {
      text: { baseUrl: "https://text.test", model: "m" },
      tts: { baseUrl: "https://tts.test", preparationMode: "progressive", playbackMode: "sync" },
    },
    signal: abort.signal,
    // Note: streamPlayback is false, so it MUST run video-sync loop!
    streamPlayback: false,
    createAudio: () => new MockAudio(),
    audioDuration: async () => 3.0,
    openSource: async () => ({
      duration: 60,
      subtitles: cues,
      close: async () => {},
      analyze: async () => ({ spans: [{ start: 0, end: 60, kind: "unknown", speaker: null }] }),
      slice: async (start, seconds) => ({ start, end: start + seconds, seconds, blob }),
    }),
    video: fakeVideo,
    transcribe: async () => [],
    chat: async (_m, { messages }) => {
      const input = JSON.parse(messages[1].content);
      return JSON.stringify({
        lines: (input.current || []).map(c => ({ ids: [c.id], zh: "译文: " + c.src })),
      });
    },
    synthesizeTts: async (_m, text) => ({ blob }),
    onEvent: ev => { emittedEvents.push(ev); },
  });

  // Verify that the video player is resumed by runPlannedInterpret!
  await until(() => videoActions.some(a => a.cmd === 'control' && a.arg.action === 'play'));
  assert(videoActions.some(a => a.cmd === 'control' && a.arg.action === 'play'), "Video MUST be resumed by planned interpretation loop");
  assert.strictEqual(videoState.paused, false, "Video player state is resumed (playing)");

  // Verify lines are emitted
  await until(() => emittedEvents.some(e => e.type === 'line'));
  const firstLine = emittedEvents.find(e => e.type === 'line');
  assert.strictEqual(firstLine.zh, "译文: First sentence of video.");

  abort.abort();
  await running.catch(err => {
    if (err.name !== 'AbortError') throw err;
  });
  console.log("  PASS: Video interpretation resumes video and follows video timeline");
}

// TEST 2: Video Interpretation enforces video player pause check
{
  const ctrl = new InterpretController();

  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    tabs: {
      get: async id => ({ id, url: "https://video.test" }),
    },
    scripting: {
      executeScript: async ({ args }) => {
        const [cmd, arg] = args || [];
        if (cmd === 'pick') return [{ result: { ok: true } }];
        if (cmd === 'state') return [{ result: { ok: true, paused: false, ended: false, currentTime: 10 } }];
        if (cmd === 'control' && arg?.action === 'pause') return [{ result: { ok: false } }]; // Fails to pause!
        return [{ result: { ok: true } }];
      }
    }
  };

  try {
    let errorNotified = null;
    ctrl.subscribe((ev) => {
      if (ev.type === 'error') errorNotified = ev.error;
    });

    await ctrl.start({
      tab: { id: 99, url: "https://video.test", title: "Test" },
      settings: { text: {}, tts: {} },
    });

    assert(errorNotified, "Must notify error when player fails to pause");
    assert(/播放器未能暂停/.test(errorNotified), `Error message mentions player pause failure, got: ${errorNotified}`);
    assert.strictEqual(ctrl.isRunning(), false, "Task must not start if player pause failed");
  } finally {
    globalThis.chrome = originalChrome;
  }
  console.log("  PASS: Video interpretation enforces player pause verification before start");
}

// TEST 3: Pure streaming mode remains functional when EXPLICITLY requested with streamPlayback: true
{
  const cues = [{ start: 0, end: 5, text: "Audio stream only." }];
  const blob = new Blob(["audio"]);
  const abort = new AbortController();
  let streamPlayerInstance = null;

  class MockAudioEl {
    constructor(url) { this.paused = true; this.playbackRate = 1; this.volume = 1; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  }

  const running = runPlannedInterpret({
    tabId: 88,
    sourceUrl: "https://audio.test/stream",
    settings: {
      text: { baseUrl: "https://text.test", model: "m" },
      tts: { baseUrl: "https://tts.test", preparationMode: "progressive" },
    },
    signal: abort.signal,
    streamPlayback: true, // EXPLICIT streaming request
    AudioContextClass: null,
    createAudioElement: url => new MockAudioEl(url),
    audioDuration: async () => 2.5,
    openSource: async () => ({
      duration: 30,
      subtitles: cues,
      close: async () => {},
      analyze: async () => ({ spans: [{ start: 0, end: 30, kind: "unknown", speaker: null }] }),
      slice: async (start, seconds) => ({ start, end: start + seconds, seconds, blob }),
    }),
    video: async () => ({ ok: true, paused: true, currentTime: 0 }),
    transcribe: async () => [],
    chat: async (_m, { messages }) => JSON.stringify({ lines: [{ ids: [0], zh: "流式纯音频" }] }),
    synthesizeTts: async () => ({ blob }),
    onStreamPlayer: p => { streamPlayerInstance = p; },
  });

  await until(() => streamPlayerInstance !== null);
  assert(streamPlayerInstance, "Explicit streamPlayback: true properly attaches streamPlayer");

  abort.abort();
  await running.catch(err => {
    if (err.name !== 'AbortError') throw err;
  });
  console.log("  PASS: Explicit streamPlayback: true cleanly attaches stream player without leaking into default video interpret");
}

console.log("All Capability Isolation tests passed successfully!");

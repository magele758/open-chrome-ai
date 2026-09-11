import assert from "node:assert";
import {
  assessVoiceQuality,
  computeRms,
  createVadAnalyzer,
  recordSlice,
} from "../lib/tab-audio-record.js";

console.log("Starting VAD & Voice Quality test suite...");

// 1. Test computeRms
{
  assert.strictEqual(computeRms([]), 0, "empty array RMS is 0");
  assert.strictEqual(computeRms(null), 0, "null RMS is 0");
  const zeros = new Float32Array(100);
  assert.strictEqual(computeRms(zeros), 0, "all-zero RMS is 0");

  const ones = new Float32Array([1, 1, 1, 1]);
  assert.strictEqual(computeRms(ones), 1, "all-ones RMS is 1");

  const alternating = new Float32Array([0.5, -0.5, 0.5, -0.5]);
  assert.strictEqual(Math.abs(computeRms(alternating) - 0.5) < 1e-6, true, "alternating 0.5 RMS is 0.5");
  console.log("  PASS: computeRms calculations");
}

// 2. Test assessVoiceQuality
{
  // Silence
  const silent = new Float32Array(44100 * 2);
  const qSilent = assessVoiceQuality(silent, 44100);
  assert.strictEqual(qSilent.ok, false, "silence must not be eligible");
  assert.strictEqual(qSilent.reason, "too_quiet");

  // Extreme clipping / distorted
  const clipped = new Float32Array(44100 * 2).fill(0.99);
  const qClipped = assessVoiceQuality(clipped, 44100);
  assert.strictEqual(qClipped.ok, false, "clipped audio must not be eligible");

  // Constant low-level noise without speech dynamics
  const noise = new Float32Array(44100 * 2);
  for (let i = 0; i < noise.length; i += 1) {
    noise[i] = (Math.random() - 0.5) * 0.02; // very low noise
  }
  const qNoise = assessVoiceQuality(noise, 44100);
  assert.strictEqual(qNoise.ok, false, "flat low noise must not be eligible");

  // Simulated natural speech: burst of syllables (active frames + pauses + high crest factor)
  const speech = new Float32Array(44100 * 2);
  for (let i = 0; i < speech.length; i += 1) {
    const t = i / 44100;
    // Syllables roughly 3 times per second
    const envelope = Math.sin(t * 3 * Math.PI) > 0 ? 0.4 : 0.005;
    // Harmonics around 250Hz, 700Hz
    const wave = Math.sin(2 * Math.PI * 250 * t) * 0.7 + Math.sin(2 * Math.PI * 700 * t) * 0.3;
    speech[i] = envelope * wave;
  }
  const qSpeech = assessVoiceQuality(speech, 44100);
  assert.strictEqual(qSpeech.rms > 0.02, true, "speech has sufficient RMS");
  assert.strictEqual(qSpeech.crestFactor > 1.8, true, "speech has distinct crest factor");
  assert.strictEqual(qSpeech.voiceActivityRatio > 0.15, true, "speech has active frames");
  assert.strictEqual(qSpeech.ok, true, "synthetic speech is eligible for voice cloning");
  console.log("  PASS: assessVoiceQuality eligibility gates");
}

// 3. Test createVadAnalyzer with mocked AudioContext
{
  let currentBuffer = new Float32Array(512);

  class MockAnalyserNode {
    constructor() {
      this.fftSize = 512;
    }
    connect() {}
    disconnect() {}
    getFloatTimeDomainData(buf) {
      buf.set(currentBuffer);
    }
  }

  class MockAudioContext {
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createAnalyser() {
      return new MockAnalyserNode();
    }
    async resume() {}
    async close() {}
  }

  const origAC = globalThis.AudioContext;
  globalThis.AudioContext = MockAudioContext;

  try {
    const fakeStream = {
      getAudioTracks: () => [{ kind: "audio" }],
    };

    const vad = createVadAnalyzer(fakeStream, {
      speechThreshold: 0.03,
      silenceThreshold: 0.015,
      pollIntervalMs: 20,
    });

    assert.strictEqual(vad.isAvailable, true, "vad should be available with mock AudioContext");
    assert.strictEqual(vad.getSpeechDetected(), false, "initial speechDetected is false");

    // Feed speech
    currentBuffer.fill(0.1); // RMS = 0.1 > speechThreshold 0.03
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(vad.getSpeechDetected(), true, "speech should be detected");
    assert.strictEqual(vad.getSilenceDurationMs(), 0, "silence duration resets to 0 during speech");

    // Feed silence and arm pause trigger
    let pauseTriggered = false;
    vad.armPauseTrigger({
      minPassed: true,
      pauseMs: 80,
      onPause: () => {
        pauseTriggered = true;
      },
    });

    currentBuffer.fill(0.005); // RMS = 0.005 <= silenceThreshold 0.015
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(pauseTriggered, true, "pause trigger should fire after required silence");

    vad.dispose();
    console.log("  PASS: createVadAnalyzer speech & pause detection");
  } finally {
    globalThis.AudioContext = origAC;
  }
}

// 4. Test recordSlice fallback behavior
{
  class MockMediaRecorder {
    constructor(stream, opts) {
      this.stream = stream;
      this.opts = opts;
      this.state = "inactive";
      this.mimeType = "audio/webm";
    }
    start() {
      this.state = "recording";
      setTimeout(() => {
        this.ondataavailable?.({ data: new Uint8Array([1, 2, 3]) });
      }, 10);
    }
    stop() {
      this.state = "inactive";
      this.onstop?.();
    }
  }
  const origMR = globalThis.MediaRecorder;
  globalThis.MediaRecorder = MockMediaRecorder;

  try {
    const fakeStream = { id: "test-stream" };
    const t0 = Date.now();
    const res = await recordSlice(fakeStream, 0.8, null, { enableVad: false });
    const elapsed = Date.now() - t0;
    assert.strictEqual(res.mime, "audio/webm", "returns webm mime");
    assert.strictEqual(elapsed >= 700, true, `elapsed ${elapsed}ms >= 700ms`);
    console.log("  PASS: recordSlice fallback timer");

    // Test abort signal
    const abortCtrl = new AbortController();
    const abortPromise = recordSlice(fakeStream, 5, abortCtrl.signal, { enableVad: false });
    abortCtrl.abort();
    const abortRes = await abortPromise;
    assert.strictEqual(Boolean(abortRes), true, "aborted recordSlice resolves cleanly");
    console.log("  PASS: recordSlice abort handling");
  } finally {
    globalThis.MediaRecorder = origMR;
  }
}

console.log("All VAD & Voice Quality tests passed successfully!");

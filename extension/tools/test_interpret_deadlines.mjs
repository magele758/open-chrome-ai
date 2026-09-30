import assert from 'node:assert/strict';
import { withInterpretDeadline } from '../lib/interpret-semantic.js';
import { retryInterpretRequest } from '../lib/interpret-retry.js';
import { transcribeInterpretSlice } from '../lib/interpret-asr.js';
import { prepareDubPlan } from '../lib/planned-interpret.js';
import { mock } from 'node:test';

// A transport that rejects on abort must see a timeout, not user cancellation.
let transportSignal;
const abortAware = signal => new Promise((_, reject) => {
  transportSignal = signal;
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});
for (const stage of ['ASR 语音识别', '文本模型：口播翻译', 'Index-TTS 配音']) {
  await assert.rejects(withInterpretDeadline(abortAware, undefined, 5, { stage }), error => {
    assert.equal(error.name, 'TimeoutError');
    assert.equal(error.stage, stage);
    assert.equal(error.timeoutMs, 5);
    assert.equal(transportSignal.reason, error);
    assert(error.message.includes(stage));
    assert(!error.message.includes('已跳过'), 'the deadline cannot claim that its caller skipped a segment');
    return true;
  });
}

let attempts = 0;
const retries = [];
const recovered = await retryInterpretRequest(signal => ++attempts === 1 ? abortAware(signal) : 'recovered', {
  stage: 'Index-TTS 配音', timeoutMs: 5, delayMs: 0, onRetry: event => retries.push(event),
});
assert.equal(recovered, 'recovered');
assert.equal(attempts, 2);
assert.equal(retries[0].error.stage, 'Index-TTS 配音');

// ASR retries the same audio once, preserving the stage if both attempts time out.
attempts = 0;
const item = { blob: new Blob(['encoded audio'], { type: 'audio/webm' }), seconds: 5 };
await assert.rejects(transcribeInterpretSlice({}, item, {
  timeoutMs: 5,
  transcribe: (_model, blob, { signal }) => {
    assert.equal(blob, item.blob);
    attempts++;
    return abortAware(signal);
  },
}), { name: 'TimeoutError', stage: 'ASR 语音识别' });
assert.equal(attempts, 2);

// Actual stop/seek cancellation is still immediate and must never be retried.
const controller = new AbortController();
attempts = 0;
await assert.rejects(retryInterpretRequest(signal => {
  attempts++;
  const pending = abortAware(signal);
  controller.abort();
  return pending;
}, { signal: controller.signal, timeoutMs: 1000, delayMs: 0 }), { name: 'AbortError' });
assert.equal(attempts, 1);

// A valid but slow translation must survive the former 30-second cutoff.
mock.timers.enable({ apis: ['setTimeout'] });
const slowController = new AbortController();
let slowSignal, slowCalls = 0;
const planPromise = prepareDubPlan({
  signal: slowController.signal, windowed: true, incrementalContext: '',
  settings: { text: { baseUrl: 'https://text.test', model: 'test' }, tts: { contextMode: 'cue' } },
  source: {
    duration: 5, subtitles: [{ id: 'slow', start: 0, end: 5, src: 'Hello world.' }],
    analyze: async () => ({ duration: 5, fingerprint: 'slow-request', spans: [{ start: 0, end: 5, kind: 'speech', speaker: 'A' }] }),
  },
  cacheGet: async () => null, cacheSet: async () => {},
  chat: (_model, { signal, lowLatency }) => {
    assert.equal(lowLatency, true, 'production dubbing opts into the low-latency model path');
    slowCalls++;
    slowSignal = signal;
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      setTimeout(() => resolve(JSON.stringify({ lines: [{ ids: ['slow'], zh: '你好，世界。' }] })), 31000);
    });
  },
});
const outcome = planPromise.then(value => ({ value }), error => ({ error }));
try {
  for (let i = 0; !slowSignal && i < 1000; i++) await new Promise(setImmediate);
  assert(slowSignal, 'translation was submitted');
  mock.timers.tick(31000);
  assert(!slowSignal.aborted, 'keep the slow request instead of cancelling at 30 seconds');
  const result = await outcome;
  assert.ifError(result.error);
  assert.equal(result.value.lines[0].zh, '你好，世界。');
  assert.equal(slowCalls, 1, 'slow successful replies need no duplicate request');
} finally {
  slowController.abort();
  mock.timers.reset();
  await outcome;
}
console.log('PASS stage-specific deadlines, abort reasons, ASR recovery, TTS retry and user cancellation');

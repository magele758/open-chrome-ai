import assert from 'node:assert/strict';
import { evaluateFixture, scoreTranslations } from './eval_interpret_quality.mjs';
import { runLive, wavSeconds } from './test_interpret_functional.mjs';
import { pcmWav } from '../lib/downloaded-audio-source.js';
import { settings } from './interpret-test-harness.mjs';

const fixture = { id: 'protocol', duration: 8,
  subtitles: [{ id: 'a', start: 0, end: 4, src: 'First sentence.' }, { id: 'b', start: 4, end: 8, src: 'Second sentence.' }],
  spans: [{ start: 0, end: 8, kind: 'speech', speaker: 'A' }] };
const mock = await evaluateFixture(fixture, 'sentence');
assert.equal(mock.translationKind, 'placeholder');
await assert.rejects(scoreTranslations([mock], settings.text), /placeholder/);
let calls = 0;
const actual = await evaluateFixture(fixture, 'sentence', { live: true, model: settings.text,
  chat: async (_, { messages }) => {
    const input = JSON.parse(messages[1].content); calls++;
    assert(Array.isArray(input.current));
    return JSON.stringify({ lines: input.current.map(c => ({ ids: [c.id], zh: '真实模型输出。' })) });
  } });
assert(calls > 0); assert(actual.lines.every(l => l.zh === '真实模型输出。'));
await scoreTranslations([actual], settings.text, async (_, { messages }) => {
  assert(messages[1].content.includes('真实模型输出。'));
  assert(!messages[1].content.includes('占位'));
  return JSON.stringify({ scores: [{ candidate: 'candidate-1', faithfulness: 4, fluency: 4, terminology: 4 }] });
});
const wav = pcmWav([new Uint8Array(32000)]);
assert.equal(wavSeconds(await wav.arrayBuffer()), 1);
const passing = await runLive(settings, { referenceBlob: wav,
  chat: async () => '{"ok":true}', asr: async () => [], tts: async () => ({ blob: wav }),
});
assert(passing.every(row => row.status === 'PASS'));
const broken = await runLive(settings, { referenceBlob: wav,
  chat: async () => 'not JSON', asr: async () => ({ status: 'HTTP 200' }), tts: async () => ({ blob: new Blob(['HTML error page']) }),
});
assert(broken.every(row => row.status === 'FAIL'));
console.log('PASS evaluation: production scheduling, live translator actually called, no scoring placeholders, real protocol/WAV validation');

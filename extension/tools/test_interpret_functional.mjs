#!/usr/bin/env node
// Deterministic playback acceptance by default. Live protocol checks are opt-in.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { continuousPlayback } from './interpret-test-harness.mjs';
import { normalizeSettings, isAsrReady, isTtsReady, resolveModel, isModelReady } from '../lib/storage.js';
import { completeChat } from '../lib/openai.js';
import { transcribeAudio, silentWav } from '../lib/asr.js';
import { synthesizeTts } from '../lib/tts.js';

export async function runOffline(overrides = {}) {
  const result = [];
  for (const rate of [1, 2]) result.push(await continuousPlayback({ rate, override: overrides }));
  return result;
}

export function wavSeconds(buffer) {
  const view = new DataView(buffer);
  const text = (i, n) => String.fromCharCode(...new Uint8Array(buffer, i, n));
  if (buffer.byteLength < 44 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') throw new Error('Invalid WAV');
  let bytesPerSecond = 0, bytes = 0;
  for (let i = 12; i + 8 <= buffer.byteLength;) {
    const size = view.getUint32(i + 4, true);
    if (i + 8 + size > buffer.byteLength) throw new Error('Truncated WAV');
    if (text(i, 4) === 'fmt ' && size >= 16) {
      if (![1, 3].includes(view.getUint16(i + 8, true))) throw new Error('Unsupported WAV encoding');
      bytesPerSecond = view.getUint32(i + 16, true);
    }
    if (text(i, 4) === 'data') bytes += size;
    i += size + 8 + size % 2;
  }
  if (!(bytes > 0 && bytesPerSecond > 0)) throw new Error('Empty WAV');
  return bytes / bytesPerSecond;
}

export async function runLive(settings, { chat = completeChat, asr = transcribeAudio, tts = synthesizeTts, referenceBlob } = {}) {
  const model = resolveModel(settings, 'text');
  const checks = [
    ['ASR', isAsrReady(settings.asr), async () => {
      const segments = await asr(settings.asr, silentWav(.5), { signal: AbortSignal.timeout(15000), allowEmpty: true });
      assert(Array.isArray(segments));
      assert(segments.every(s => typeof s.text === 'string'));
    }],
    ['Text', isModelReady(model), async () => {
      const raw = await chat(model, { messages: [{ role: 'user', content: '只返回 JSON：{"ok":true}' }], signal: AbortSignal.timeout(15000), maxTokens: 80 });
      assert.equal(JSON.parse(raw).ok, true);
    }],
    ['TTS', isTtsReady(settings.tts), async () => {
      // A configured service with missing reference fails explicitly. Never
      // claim connectivity from a 404 or send private audio automatically.
      if (!referenceBlob) throw new Error('Reference fixture required');
      const output = await tts(settings.tts, '这是同声传译测试。', { referenceBlob, signal: AbortSignal.timeout(20000) });
      assert(output?.blob instanceof Blob);
      assert(wavSeconds(await output.blob.arrayBuffer()) > 0);
    }],
  ];
  const results = [];
  for (const [name, enabled, run] of checks) {
    if (!enabled) { results.push({ name, status: 'SKIP' }); continue; }
    const began = Date.now();
    try { await run(); results.push({ name, status: 'PASS', durationMs: Date.now() - began }); }
    catch { results.push({ name, status: 'FAIL', reason: '协议、响应或测试参考音校验失败' }); }
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--live', '--mock'].includes(arg)) || args.includes('--live') && args.includes('--mock')) throw new Error('Usage: --mock OR --live');
    if (args.includes('--live')) {
      const cfg = normalizeSettings(JSON.parse(await readFile(new URL('../local-settings.json', import.meta.url), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return '{}'; throw error;
      })));
      const referenceBlob = process.env.INTERPRET_TEST_REFERENCE ? new Blob([await readFile(process.env.INTERPRET_TEST_REFERENCE)], { type: 'audio/wav' }) : undefined;
      const results = await runLive(cfg, { referenceBlob });
      for (const result of results) console.log(JSON.stringify(result));
      if (results.some(r => r.status === 'FAIL')) process.exitCode = 1;
    } else {
      await runOffline();
      console.log('PASS offline functional: 9 utterances across multiple windows, 1x/2x, real play/ended transitions, no repeats or silent degradation');
    }
  } catch {
    console.error('FAIL interpretation acceptance (use --mock or --live; live TTS requires INTERPRET_TEST_REFERENCE)');
    process.exitCode = 1;
  }
}

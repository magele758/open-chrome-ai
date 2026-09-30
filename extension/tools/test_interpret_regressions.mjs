import assert from 'node:assert/strict';
import { prepareDubPlan } from '../lib/planned-interpret.js';
import { linesToCaptions } from '../lib/interpret.js';
import { knownQuietUntil, subtitleLeadGap, validateDubTranslation, fitDub } from '../lib/dub-timeline.js';
import { stableAudioIdentity, safeBudgetRewrite, speechUnits, bufferingTarget } from '../lib/interpret-policy.js';
import { dubKey } from '../lib/dub-cache.js';
import { createInterpretContext } from '../lib/interpret-context.js';
import { session, source, settings, blob, gate, until, sleep, chat, continuousPlayback } from './interpret-test-harness.mjs';
import { runLive, runOffline } from './test_interpret_functional.mjs';

const noCache = { cacheGet: async () => null, cacheSet: async () => {} };
const subs = Array.from({ length: 3 }, (_, i) => ({ id: `s${i}`, start: i * 4, end: i * 4 + 4, src: 'A complete sentence.' }));
// Real-time translation delivers all confirmed lines without serial rewrites.
{
  let repairs = 0, calls = 0;
  const s = session({ openSource: async () => source(subs, 12),
    chat: async (_, { messages }) => {
      const input = JSON.parse(messages[1].content);
      if (!input.current) { repairs++; return new Promise(() => {}); }
      return JSON.stringify({ lines: input.current.map(c => ({ ids: [c.id], zh: '长'.repeat(30) })) });
    }, synthesizeTts: async () => { calls++; return { blob }; },
  });
  try {
    await until(() => calls === 3);
    assert.equal(repairs, 0, 'live speech is not held behind budget rewrites');
    await until(() => s.events.filter(e => e.type === 'dub_segment').length === 3);
  } finally { await s.stop(); }
}

// Exact audio-cache reuse must never call reference extraction or TTS.
{
  const line = { id: 'cached', start: 0, end: 12, src: 'Cached sentence.', zh: '缓存译文。', speaker: 'A' };
  const plan = { lines: [line], spans: [], sourceKey: 'probe', background: false };
  const key = await dubKey(stableAudioIdentity({ source: plan.sourceKey, line, tts: settings.tts, configuredKey: 'none', background: false }));
  let references = 0, tts = 0;
  const s = session({ plan, openSource: async () => source([line], 12),
    cacheGet: async k => k === key ? { ...fitDub(line, 2), blob } : null,
    voiceRef: async () => { references++; return new Promise(() => {}); },
    synthesizeTts: async () => { tts++; throw Error('cache miss'); },
  });
  try {
    await until(() => s.events.some(e => e.type === 'dub_segment'));
    assert.equal(references, 0); assert.equal(tts, 0);
  } finally { await s.stop(); }
}

// Internal fragments retain text, immutable source provenance and timing all
// the way through the production planner and exported captions.
{
  const inputs = [];
  const plan = await prepareDubPlan({ source: { duration: 8, subtitles: [
    { id: 'a', start: 0, end: 4, src: 'hello world' }, { id: 'b', start: 4, end: 8, src: 'again' },
  ], analyze: async () => ({ duration: 8, spans: [{ start: 0, end: 8, kind: 'speech', speaker: 'A' }] }) },
  settings, signal: new AbortController().signal, skipBrief: true, ...noCache,
  chat: async (_, { messages }) => {
    const input = JSON.parse(messages[1].content);
    if (!input.current) return '{"breaks":[5]}';
    inputs.push(...input.current);
    return JSON.stringify({ lines: input.current.map(c => ({ ids: [c.id], zh: '译文。' })) });
  } });
  assert.deepEqual(plan.lines.map(c => c.src), inputs.map(c => c.src));
  assert.deepEqual(plan.lines.map(c => [c.start, c.end]), inputs.map(c => [c.start, c.end]));
  assert.equal(plan.lines[1].timingQuality, 'estimated');
  assert.equal(plan.lines[1].captionSources[0].originalCueId, 'a');
  assert.equal(plan.lines[1].captionSources[0].charStart, 5);
  assert.equal(linesToCaptions(plan.lines).cues[1].start, 4 * 5 / 11);
}

// Invalid output is explicit failure, not a successful cacheable translation.
{
  const saved = [];
  const plan = await prepareDubPlan({ source: { duration: 4, subtitles: [subs[0]],
    analyze: async () => ({ duration: 4, spans: [{ start: 0, end: 4, kind: 'speech', speaker: 'A' }] }) },
    settings, signal: new AbortController().signal, windowed: true, ...noCache,
    cacheSet: async (_, value) => saved.push(value),
    chat: async () => JSON.stringify({ lines: [{ ids: ['unrelated'], zh: '错误译文。' }] }),
  });
  assert.equal(plan.incompleteTranslation, true);
  assert.equal(plan.lines[0].translationStatus, 'failed'); assert.equal(plan.lines[0].zh, '');
  assert(!saved.some(v => v?.lines || Array.isArray(v) && v.some(c => c.zh !== undefined)));
  for (const ids of [['wrong'], [], ['s1', 's0'], ['s0', 's0']]) {
    assert.throws(() => validateDubTranslation({ lines: ids.map(id => ({ ids: [id], zh: '译文' })) }, subs.slice(0, 2)));
  }
}

assert.equal(knownQuietUntil(1, { spans: [{ start: 0, end: 10, kind: 'unknown' }, { start: 10, end: 20, kind: 'speech' }] }), null);
assert.equal(knownQuietUntil(1, { spans: [{ start: 0, end: 2, kind: 'music' }, { start: 10, end: 20, kind: 'music' }] }), 2);
assert.equal(subtitleLeadGap([], 0, 10), null);
assert.equal(subtitleLeadGap([{ start: 8, end: 10, src: 'Later' }], 0, 10, { subtitlesComplete: true, spans: [{ start: 0, end: 8, kind: 'speech' }] }), null);
assert.equal(speechUnits('AI 123'), 4);
assert.equal(safeBudgetRewrite('收入至少100美元，不能删除条件。', '收入100美元。', 20), false);
assert(bufferingTarget({ refill: true, latencySeconds: 8 }) > bufferingTarget({ refill: false }));
assert.equal(bufferingTarget({ refill: true, remaining: 2, playbackRate: 2 }), 1);

// Confirmed glossary entries survive window boundaries and are explicitly reset.
{
  const context = createInterpretContext();
  const captured = [];
  for (let n = 0; n < 3; n++) {
    await prepareDubPlan({ source: { duration: 4, subtitles: [{ ...subs[0], src: 'Model Alpha.' }],
      analyze: async () => ({ duration: 4, fingerprint: String(n), spans: [{ start: 0, end: 4, kind: 'speech', speaker: 'A' }] }) },
      settings, signal: new AbortController().signal, windowed: true, translationContext: context, ...noCache,
      chat: async (_, { messages }) => { const input = JSON.parse(messages[1].content); captured.push(input);
        return JSON.stringify({ lines: input.current.map(c => ({ ids: [c.id], zh: '阿尔法模型。', terms: [{ source: 'Alpha', target: '阿尔法' }] })) }); },
    });
  }
  assert.deepEqual(captured[2].glossary, [{ source: 'Alpha', target: '阿尔法' }]);
  context.reset(); assert.equal(context.terms().length, 0);
}

// Late analysis must preserve ready inventory and never duplicate generation.
{
  const analysis = gate(); let tts = 0;
  const s = session({ openSource: async () => source(subs, 12, { analyze: () => analysis.promise }),
    synthesizeTts: async () => { tts++; return { blob }; },
  });
  try {
    await until(() => tts === 3);
    analysis.release({ duration: 12, spans: [{ start: 0, end: 12, kind: 'speech', speaker: 'A' }] });
    await until(() => s.events.some(e => e.type === 'metric' && e.stage === 'analysis'));
    s.state.currentTime = 4; s.state.seekRevision++;
    await until(() => s.audios.some(a => a.dubItem?.start === 4 && a.played));
    assert.equal(tts, 3); assert.equal(s.events.filter(e => e.type === 'dub_segment').length, 3);
  } finally { analysis.release({ duration: 12, spans: [] }); await s.stop(); }
}

// Exhausted TTS retries pause the video and report failure; they must not
// silently advance with original speech or publish an archiveable success.
{
  const s = session({ openSource: async () => source(subs, 12), ttsTimeoutMs: 40,
    synthesizeTts: async () => new Promise(() => {}),
  });
  try {
    const result = await s.outcome;
    assert.match(result.error?.message || '', /配音.*失败/);
    assert(s.events.some(e => e.type === 'dub_gap'));
    assert.equal(s.state.paused, true); assert.equal(s.audios.length, 0);
    assert(!s.events.some(e => e.type === 'dub_complete' || e.type === 'archive_saved'));
  } finally { s.abort.abort(); await s.outcome; }
}

// A translation window that fails both attempts is retried with the picture
// held; it must neither end the session nor let speech play undubbed.
{
  const flaky = failing => { let calls = 0; return async (model, options) => {
    if (!JSON.parse(options.messages[1].content).current) return '';
    if (failing(++calls)) throw Object.assign(new Error('503 upstream'), { status: 503 });
    return chat(model, options);
  }; };
  const recovered = await continuousPlayback({ override: { chat: flaky(n => n === 3 || n === 4), hedgeMs: Infinity, windowRetryDelayMs: 5 } });
  assert(recovered, 'session survives a fully failed translation window');
}
{
  const s = session({ openSource: async () => source(subs, 12), hedgeMs: Infinity, windowRetryDelayMs: 5,
    chat: async () => { throw Object.assign(new Error('503 upstream'), { status: 503 }); } });
  try {
    const result = await s.outcome;
    assert.match(result.error?.message || '', /翻译失败/);
    assert(s.events.some(e => e.type === 'dub_gap'));
    assert.equal(s.state.paused, true); assert.equal(s.audios.length, 0);
  } finally { s.abort.abort(); await s.outcome; }
}

// Long audio must be delivered in both cold and cached-plan playback.
for (const warm of [false, true]) {
  const lines = subs.map(c => ({ ...c, zh: '缓存译文。', speaker: 'A' }));
  const s = session({ ...(warm ? { plan: { lines, spans: [], sourceKey: 'warm', background: false } } : {}),
    openSource: async () => source(subs, 12), audioDuration: async () => 12 });
  try {
    await until(() => s.audios.some(a => a.played));
    assert.equal(s.audios[0].dubItem.start, 0);
    assert(!s.events.some(e => e.type === 'warn' && e.message.includes('译音过长')));
  } finally { await s.stop(); }
}

// Service diagnostics count configured protocol failures as failures.
{
  const result = await runLive(settings, { referenceBlob: blob,
    asr: async () => { throw Error('offline'); }, chat: async () => { throw Error('offline'); }, tts: async () => { throw Error('offline'); },
  });
  assert(result.every(r => r.status === 'FAIL'));
  const skipped = await runLive({}); assert(skipped.every(r => r.status === 'SKIP'));
}
// Mutation gate: TTS that never resolves must NOT pass continuous-playback acceptance.
await assert.rejects(runOffline({ ttsTimeoutMs: 30, playbackWaitMs: 50, synthesizeTts: async () => new Promise(() => {}) }));
console.log('PASS regression gates: incremental readiness, cache-first, provenance, strict IDs, quiet evidence, glossary, forward analysis, timeout hold and long-audio playback, live failures and dead-TTS mutation');

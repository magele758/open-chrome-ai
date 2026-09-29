#!/usr/bin/env node
// Uses the production scheduler. Mock runs report structure ONLY. --live sends
// fixture text to the configured text service and scores actual translations.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runPlannedInterpret } from '../lib/planned-interpret.js';
import { completeChat } from '../lib/openai.js';
import { parseTolerantJson } from '../lib/dub-timeline.js';
import { speechUnits } from '../lib/interpret-policy.js';

export async function evaluateFixture(fixture, mode, { live = false, model, chat = completeChat } = {}) {
  const requests = [], events = [];
  const samples = new Blob([new Uint8Array(100)]);
  const settings = { text: model || { baseUrl: 'https://text.test', model: 'mock', apiKey: 'test' },
    asr: { baseUrl: 'https://asr.test', model: 'mock' },
    tts: { baseUrl: 'https://tts.test', preparationMode: 'progressive', contextMode: mode } };
  const run = await runPlannedInterpret({ tabId: 1, settings, audioOnly: true, generateFull: true,
    signal: AbortSignal.timeout(live ? 180000 : 15000),
    video: async () => ({ ok: true, paused: true, currentTime: 0 }),
    openSource: async () => ({ duration: fixture.duration, subtitles: fixture.subtitles || null, subtitlesComplete: true,
      analyze: async () => ({ duration: fixture.duration, spans: fixture.spans }), close: async () => {},
      slice: async (start, seconds) => ({ blob: samples, start, seconds, end: start + seconds }),
    }),
    cacheGet: async () => null, cacheSet: async () => {}, getTtsRef: async () => null, voiceRef: async () => samples,
    transcribe: async (_, slice) => (fixture.asr || [])
      .filter(row => row.start >= slice.start - .001 && row.start < slice.end - .001)
      .map(row => ({ ...row, start: row.start - slice.start, end: Math.min(row.end, slice.end) - slice.start })),
    chat: async (config, options) => {
      const input = JSON.parse(options.messages[1].content);
      requests.push({ current: input?.current?.map(c => c.id) || [], history: input?.history?.length || 0,
        lookahead: input?.lookahead?.length || 0, promptChars: options.messages.reduce((n, m) => n + m.content.length, 0) });
      if (live) return chat(config, options);
      return input?.current ? JSON.stringify({ lines: input.current.map(c => ({ ids: [c.id], zh: '占位译文。' })) }) : '';
    },
    synthesizeTts: async (_, text) => ({ blob: new Blob([text]) }),
    audioDuration: async blob => Math.max(.2, speechUnits(await blob.text()) / 3.8),
    onEvent: event => events.push(event),
  });
  assert(!run.lines.some(l => l.translationStatus === 'failed'), 'evaluation cannot silently score failed translations');
  assert(events.some(e => e.type === 'dub_complete'), 'fixture must fully finish production');
  assert(!events.some(e => e.type === 'dub_partial' || e.type === 'dub_gap'));
  return { fixture: fixture.id, mode, translationKind: live ? 'real-model' : 'placeholder',
    audioTiming: 'estimated-not-measured', requests,
    lines: run.lines.map(l => ({ id: l.id, src: l.src, zh: l.zh, start: l.start, end: l.end, speaker: l.speaker })),
    // Production events are useful for tracing, never presented as real TTS or browser latency.
    generated: events.filter(e => e.type === 'dub_segment').length };
}

export async function scoreTranslations(runs, model, chat = completeChat) {
  if (runs.some(run => run.translationKind !== 'real-model')) throw new Error('Cannot score placeholder translations');
  const blind = runs.map((run, index) => ({ candidate: `candidate-${index + 1}`, pairs: run.lines.map(l => ({ src: l.src, zh: l.zh })) }));
  const raw = await chat(model, { messages: [
    { role: 'system', content: '评估各候选真实译文的忠实度、中文流畅度和术语一致性，分别给1–5分。返回JSON {"scores":[{"candidate":"candidate-1","faithfulness":1,"fluency":1,"terminology":1,"reason":"说明"}]}。不得依据候选编号猜测模式。' },
    { role: 'user', content: JSON.stringify(blind) },
  ], signal: AbortSignal.timeout(30000), temperature: 0, maxTokens: 2500 });
  const result = parseTolerantJson(raw);
  assert.equal(result.scores?.length, blind.length);
  const ids = result.scores.map(row => row.candidate);
  assert.equal(new Set(ids).size, blind.length);
  assert(blind.every(row => ids.includes(row.candidate)));
  for (const row of result.scores) for (const key of ['faithfulness', 'fluency', 'terminology']) assert(Number.isFinite(row[key]) && row[key] >= 1 && row[key] <= 5);
  return { ...result, candidateMapping: runs.map((run, i) => ({ candidate: blind[i].candidate, fixture: run.fixture, mode: run.mode })),
    limitation: 'Model scoring is supplemental; manual review and real audio playback are still required.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some(a => !['--live', '--mock'].includes(a)) || args.includes('--live') && args.includes('--mock')) throw new Error('Invalid arguments');
    const live = args.includes('--live');
    const model = { baseUrl: process.env.INTERPRET_EVAL_TEXT_BASE_URL || process.env.PAGELENS_TEXT_BASE_URL,
      model: process.env.INTERPRET_EVAL_TEXT_MODEL || process.env.PAGELENS_TEXT_MODEL,
      apiKey: process.env.INTERPRET_EVAL_TEXT_API_KEY || process.env.PAGELENS_TEXT_API_KEY };
    if (live && (!model.baseUrl || !model.model || !model.apiKey)) throw new Error('Live model configuration missing');
    const dir = new URL('./fixtures/interpret-quality/', import.meta.url);
    const names = (await readdir(dir)).filter(name => /^\d+.*\.json$/.test(name)).sort();
    const runs = [];
    for (const name of names) {
      const fixture = JSON.parse(await readFile(new URL(name, dir), 'utf8'));
      for (const mode of ['cue', 'sentence']) runs.push(await evaluateFixture(fixture, mode, { live, model: live ? model : undefined }));
    }
    const scores = live ? await scoreTranslations(runs, model) : { skipped: true, reason: 'Mock structure checks do not measure translation quality.' };
    const output = new URL(live ? 'live-evaluation-report.json' : 'mock-evaluation-report.json', dir);
    await writeFile(output, JSON.stringify({ live, runs, scores }, null, 2) + '\n');
    console.log(`PASS ${runs.length} production-scheduler fixture runs; ${live ? 'actual translations scored' : 'structure only, no quality/performance claim'}; report ${fileURLToPath(output)}`);
  } catch {
    console.error('FAIL evaluation: verify fixtures, explicit --live configuration, and translation protocol. No successful quality report was produced.');
    process.exitCode = 1;
  }
}

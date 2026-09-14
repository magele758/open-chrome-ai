import assert from 'node:assert/strict';
import { summarizeTranscript, splitTranscript, SUMMARY_INPUT_TOKENS } from '../lib/summarize-transcript.js';
import { streamChat, estimateTokens } from '../lib/openai.js';
let active = 0, peak = 0, calls = 0;
const deltas = [];
const text = ['BEGIN', 'MIDDLE', 'END'].map(s => s + '文'.repeat(100000)).join('\n');
const result = await summarizeTranscript({ text, model: {}, onDelta: d => deltas.push(d),
  complete: async (_model, { messages }) => {
    const index = calls++;
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, index === 0 ? 25 : 1));
    active--;
    const body = messages.at(-1).content;
    return [...body.matchAll(/BEGIN|MIDDLE|END/g)].map(m => m[0]).join(' ');
  },
  stream: async (_model, { messages }, onDelta) => {
    assert.equal(active, 0, 'final synthesis waits for all reading');
    const prompt = messages.at(-1).content;
    assert(prompt.indexOf('BEGIN') < prompt.indexOf('MIDDLE') && prompt.indexOf('MIDDLE') < prompt.indexOf('END'), 'out-of-order responses preserve source order and the ending');
    assert.match(prompt, /主体按主题/);
    assert.match(prompt, /论据或实例/);
    assert.match(prompt, /时间轴仅作为文末/);
    assert.match(prompt, /没有时间戳就省略/);
    onDelta('主题总结'); onDelta('与论据');
    return '主题总结与论据';
  },
});
assert.equal(peak, 2);
assert.equal(result, deltas.join(''));
let shortCalls = 0;
await summarizeTranscript({ text: '完整的短视频文稿', model: {}, complete: async () => { shortCalls++; return '总结'; } });
assert.equal(shortCalls, 1, 'short transcripts use a single model request');
const abort = new AbortController();
abort.abort();
await assert.rejects(summarizeTranscript({ text, model: {}, signal: abort.signal, complete: async () => { throw Error('must not call'); } }), { name: 'AbortError' });

// Providers can reply with JSON even when streaming was requested.
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  assert.equal(body.stream, true); assert.equal(body.max_tokens, 16384);
  return Response.json({ choices: [{ message: { content: '完整总结' } }] });
};
const shown = [];
assert.equal(await streamChat({ baseUrl: 'https://model.test', model: 'm' }, { messages: [], maxTokens: 16384 }, d => shown.push(d)), '完整总结');
assert.deepEqual(shown, ['完整总结']);
console.log('PASS content summary: thematic format, bounded overlap, full coverage, streaming, cancellation and JSON fallback');

// The old 2/6 case now fits in a single request, with beginning and ending intact.
for (const body of ['文'.repeat(60000), 'x'.repeat(200000), 'x'.repeat(760000)]) {
  let requests = 0;
  const progress = [];
  await summarizeTranscript({ text: body, model: {}, onProgress: s => progress.push(s), complete: async (_m, { messages }) => {
    requests++;
    assert(messages.at(-1).content.includes(body), 'the complete source goes to the model');
    return '内容总结';
  } });
  assert.equal(requests, 1);
  assert(progress.every(s => !/\d+\/\d+/.test(s)), 'no misleading segmented-reading status');
}
assert.equal(estimateTokens('x'.repeat(760000)), SUMMARY_INPUT_TOKENS);
for (const body of ['x'.repeat(760001), '文'.repeat(170000), '😀'.repeat(400000)]) {
  const chunks = splitTranscript(body);
  assert(chunks.length > 1);
  assert.equal(chunks.join(''), body);
  assert(chunks.every(chunk => estimateTokens(chunk) <= SUMMARY_INPUT_TOKENS));
  assert(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk)));
}
console.log('PASS enlarged context: 200k estimated token boundary, Chinese/English, intact Unicode and one-request summaries');

const { defaultSettings, normalizeSettings, saveSettings, loadSettings } = await import('../lib/storage.js');
assert.equal(defaultSettings().text.summaryInputTokens, 200000);
assert.equal(normalizeSettings({ text: { model: 'existing' } }).text.summaryInputTokens, 200000);
for (const invalid of [null, 0, -1, 'bad', Infinity]) assert.equal(normalizeSettings({ text: { summaryInputTokens: invalid } }).text.summaryInputTokens, 200000);
let saved;
globalThis.chrome = { storage: { local: { set: async value => { saved = value; }, get: async () => saved } } };
await saveSettings({ text: { summaryInputTokens: 8000 } });
const settings = await loadSettings();
assert.equal(settings.text.summaryInputTokens, 8000);
let customCalls = 0;
await summarizeTranscript({ text: '文'.repeat(9000), model: settings.text, complete: async () => { customCalls++; return '简明笔记'; } });
assert.equal(customCalls, 3, 'saved custom budget controls chunking and final synthesis');
console.log('PASS configurable summary budget: migration, normalization, persistence and execution');

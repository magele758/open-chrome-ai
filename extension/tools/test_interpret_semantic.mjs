import assert from 'node:assert/strict';
import { createSemanticBuffer, unfinishedSpeech, withInterpretDeadline, validateSemanticTranslation } from '../lib/interpret-semantic.js';
import { createInterpretContext } from '../lib/interpret-context.js';
import { createInterpretPipeline } from '../lib/interpret-pipeline.js';
import { translateToZh, translateSemanticPrefix, cleanTranslation } from '../lib/interpret.js';

console.info = () => {};
const chunk = (src, start = 0, end = start + 5, id = start / 5 + 1) => ({ src, start, end, trace: { chunk: id, generation: 0 }, ownRef: id });
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
const bounded = promise => withInterpretDeadline(() => promise, undefined, 1500);

{
  const buffer = createSemanticBuffer();
  assert.deepEqual(buffer.push(chunk("I don't think.")), []);
  const [unit] = buffer.push(chunk('this is a good idea.', 5));
  assert.equal(unit.src, "I don't think this is a good idea.");
  assert.deepEqual(unit.sourceChunkIds, [1, 2]);
  assert.equal(unit.start, 0); assert.equal(unit.end, 10);
  assert.equal(unit.ownRef, 1);
  assert.equal(buffer.pendingText, '');
  assert.deepEqual(buffer.flush(), []);
}
{
  const buffer = createSemanticBuffer();
  const units = buffer.push(chunk('Dr. Smith measured 3.14. It worked! The reason we'));
  assert.deepEqual(units.map(u => u.src), ['Dr. Smith measured 3.14.', 'It worked!']);
  assert.equal(buffer.pendingText, 'The reason we');
  assert(units[0].end <= units[1].start);
  assert.equal(units[0].timingQuality, 'estimated');
  const tail = buffer.push(chunk('tested it was safety.', 5));
  assert.equal(tail[0].src, 'The reason we tested it was safety.');
  assert.equal(tail[0].end, 10);
}
{
  const buffer = createSemanticBuffer();
  assert.deepEqual(buffer.push(chunk('We discussed the')), []);
  buffer.push(null);
  assert.equal(buffer.push(chunk('The next topic is cost.', 10))[0].src, 'The next topic is cost.');
  buffer.push(chunk('Our plan is', 15));
  buffer.reset(2);
  assert.deepEqual(buffer.flush(), []);
  const [unit] = buffer.push(chunk('A new location.', 50));
  assert.equal(unit.trace.generation, 2);
  assert.equal(unit.utteranceId, '2:1');
}
{
  const buffer = createSemanticBuffer();
  buffer.push(chunk('We will explain the'));
  assert.deepEqual(buffer.push({ empty: true, end: 8 }), []);
  const units = buffer.push({ empty: true, end: 16 });
  assert.equal(units[0].noDub, true, 'incomplete forced tail must not be spoken as a complete claim');
  assert.equal(buffer.pendingText, '');
  buffer.push(chunk('This works without punctuation', 20));
  assert.equal(buffer.flush()[0].src, 'This works without punctuation');
}
{
  const buffer = createSemanticBuffer({ maxChars: 100 });
  const original = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
  const units = buffer.push(chunk(original));
  units.push(...buffer.flush());
  assert.equal(units.map(u => u.src).join(' '), original, 'budgets consume every word exactly once');
  assert(units.every(u => u.src.length <= 100));
  const repeat = createSemanticBuffer().push(chunk('This is very, very important.'));
  assert.equal(repeat[0].src, 'This is very, very important.', 'true emphasis must survive');
  assert(unfinishedSpeech('I do not think.'));
  assert(!unfinishedSpeech('I like it.'));
  assert(!unfinishedSpeech('I agree with that.'));
}
{
  const context = createInterpretContext();
  for (let i = 0; i < 5; i++) context.commit(`source ${i}`, `译文 ${i}`);
  assert.deepEqual(context.snapshot().map(p => p.src), ['source 2', 'source 3', 'source 4']);
  const snapshot = context.snapshot(); snapshot[0].src = 'mutated';
  assert.equal(context.snapshot()[0].src, 'source 2');
  context.reset(); assert.deepEqual(context.snapshot(), []);
  const terms = [{ source: 'attention', target: '注意力' }];
  context.commit('attention is useful', '注意力很有用', [...terms, ...terms]);
  assert.deepEqual(context.terms(), [], 'duplicates in one response cannot confirm a guess');
  context.commit('attention matters', '注意力很重要', terms);
  assert.deepEqual(context.terms(), terms);
  context.commit('attention to detail', '关注细节', [{ source: 'attention', target: '关注' }]);
  assert.deepEqual(context.terms(), [], 'a conflicting meaning revokes the old confirmed mapping');
  context.reset(); assert.deepEqual(context.terms(), []);
}
// The second ASR can finish first, but neither its meaning nor its context can overtake.
{
  const first = gate(), buffer = createSemanticBuffer(), context = createInterpretContext();
  const contexts = [], spoken = [];
  const pipeline = createInterpretPipeline({
    prebuffer: 3,
    prepare: async item => { if (item.start === 0) await first.promise; return item; },
    transform: item => buffer.push(item), flush: () => buffer.flush(),
    synthesize: async item => {
      contexts.push(context.snapshot()); context.commit(item.src, `译文${contexts.length}`); return item;
    },
    play: async item => spoken.push(item),
  });
  pipeline.enqueue(chunk("I don't think"));
  pipeline.enqueue(chunk('this is a good idea. Try again. The final words', 5));
  await tick(); assert.equal(spoken.length, 0); assert.equal(contexts.length, 0);
  first.resolve();
  await bounded(pipeline.finish());
  assert.deepEqual(spoken.map(u => u.src), ["I don't think this is a good idea.", 'Try again.', 'The final words']);
  assert.equal(contexts[0].length, 0);
  assert.equal(contexts[1][0].src, spoken[0].src);
  assert.equal(pipeline.pending, 0);
}
// No complete sentence at startup must release the wait so capture can obtain the continuation.
{
  const buffer = createSemanticBuffer(), spoken = [];
  const pipeline = createInterpretPipeline({ prebuffer: 3, prepare: async i => i,
    transform: i => buffer.push(i), flush: () => buffer.flush(),
    synthesize: async i => i, play: async i => spoken.push(i),
  });
  pipeline.enqueue(chunk('We want to'));
  assert.equal(await bounded(pipeline.waitUntilReady(3)), false);
  pipeline.enqueue(chunk('explain this.', 5));
  assert.equal(await bounded(pipeline.waitUntilReady(3)), false, 'a partial output batch cannot wait for unavailable input');
  await bounded(pipeline.waitUntilPendingAtMost(0));
  await bounded(pipeline.finish());
  assert.equal(spoken.length, 1);
  assert.equal(pipeline.pending, 0);
}
// Fanout respects audio capacity, including when a requested prebuffer exceeds it.
{
  const playing = gate(), spoken = [];
  let synthesized = 0;
  const pipeline = createInterpretPipeline({ capacity: 2, prebuffer: 3,
    prepare: async i => i, transform: () => Array.from({ length: 6 }, (_, start) => ({ start })),
    synthesize: async i => { synthesized++; return i; },
    play: async i => { spoken.push(i.start); await playing.promise; },
  });
  pipeline.enqueue({});
  await tick();
  assert.equal(synthesized, 3, 'one playing plus two ready: fanout cannot grow the audio queue without bound');
  playing.resolve(); await bounded(pipeline.finish());
  assert.deepEqual(spoken, [0, 1, 2, 3, 4, 5]);
  assert.equal(pipeline.pending, 0);
}
// Reset drops the old tail and a late old result, including while ASR is in flight.
{
  const buffer = createSemanticBuffer(), late = gate(), spoken = [];
  const pipeline = createInterpretPipeline({ prebuffer: 1,
    prepare: async i => { if (i.src === 'old continuation.') await late.promise; return i; },
    transform: i => buffer.push(i), flush: () => buffer.flush(), onReset: g => buffer.reset(g),
    synthesize: async i => i, play: async i => spoken.push(i.src),
  });
  pipeline.enqueue(chunk('The old tail is'));
  await tick();
  pipeline.enqueue(chunk('old continuation.', 5)); await tick();
  pipeline.flushAhead();
  pipeline.enqueue(chunk('New sentence.', 50)); late.resolve();
  await bounded(pipeline.finish());
  assert.deepEqual(spoken, ['New sentence.']); assert.equal(pipeline.pending, 0);
}
{
  let inner;
  await assert.rejects(withInterpretDeadline(s => { inner = s; return new Promise(() => {}); }, undefined, 10), /超时/);
  assert(inner.aborted, 'deadline cancels the remote transport as well as releasing the queue');
  const abort = new AbortController();
  const task = withInterpretDeadline(() => new Promise(() => {}), abort.signal);
  abort.abort(); await assert.rejects(task, { name: 'AbortError' });
}
{
  const requests = [];
  const model = { baseUrl: 'https://translation.test/v1', model: 'test', apiKey: 'test' };
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '这不是好主意。' } }] });
  };
  // Avoid the intentional runaway-repetition filter; the long cleanup case is distinct prose.
  const longChinese = Array.from({ length: 100 }, (_, i) => `第${i}项需要检查。`).join('');
  assert.equal(cleanTranslation(longChinese, ''), longChinese, 'do not silently cut Chinese after 240 characters');
  await translateToZh(model, "I don't think this is a good idea.", undefined, {}, [{ src: 'We have a proposal.', zh: '我们有一个提议。' }]);
  assert.equal(requests[0].messages.at(-1).content, "I don't think this is a good idea.");
  assert.equal(requests[0].messages[2].content, '我们有一个提议。');
  globalThis.fetch = async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '这不是' } }] });
  await assert.rejects(translateToZh(model, 'This is not a good idea.'), /输出上限/);
}
{
  const src = 'The first sentence. We need to';
  const valid = { prefix: 'The first sentence. ', translation: '第一句话。', suffix: 'We need to' };
  assert.deepEqual(validateSemanticTranslation(JSON.stringify(valid), src), valid);
  assert.deepEqual(validateSemanticTranslation(`<think>reasoning about translation</think>\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``, src), valid);
  assert.deepEqual(validateSemanticTranslation(`Here is the result:\n${JSON.stringify(valid)}\nHope it helps!`, src), valid);
  assert.throws(() => validateSemanticTranslation(JSON.stringify({ ...valid, suffix: '' }), src), /保留原文/);
  assert.throws(() => validateSemanticTranslation(JSON.stringify({ prefix: 'sent', suffix: 'ence', translation: '句子' }), 'sentence'), /单词/);
  assert.throws(() => validateSemanticTranslation(JSON.stringify({ prefix: 'We need to', suffix: '', translation: '我们需要' }), 'We need to'), /半句话/);
  const model = { baseUrl: 'https://translation.test/v1', model: 'test', apiKey: 'test' };
  let calls = 0;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: ++calls === 1 ? 'invalid JSON' : JSON.stringify(valid) } }] });
  assert.deepEqual(await translateSemanticPrefix(model, src), valid);
  assert.equal(calls, 2, 'invalid structured output gets exactly one repair attempt');
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: 'invalid JSON' } }] });
  await assert.rejects(translateSemanticPrefix(model, src));
  const buffer = createSemanticBuffer({ modelBoundaries: true });
  assert.deepEqual(buffer.push(chunk('The first sentence. We need to')), []);
  assert.equal(buffer.commitPrefix(valid.prefix).src, 'The first sentence.');
  assert.equal(buffer.pendingText, 'We need to');
}
console.log('ok semantic interpretation: boundaries, lossless budgets, timing, context, ordered fanout, startup, gap, seek, tail, deadlines, truncation');

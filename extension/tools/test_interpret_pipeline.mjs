import assert from 'node:assert/strict';
import { createInterpretPipeline } from '../lib/interpret-pipeline.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const a = gate(), b = gate(), playing = gate();
const prepared = [], synthesized = [], played = [];
const pipeline = createInterpretPipeline({
  prepare: async item => { prepared.push(item.id); await (item.id === 1 ? a.promise : b.promise); return item; },
  synthesize: async item => { synthesized.push([item.id, item.ref]); return item; },
  play: async item => { played.push(item.id); if (item.id === 1) await playing.promise; },
});
pipeline.enqueue({ id: 1, ref: 'voice-A' });
pipeline.enqueue({ id: 2, ref: 'voice-B' });
await tick();
assert.deepEqual(prepared, [1, 2], 'two preparation jobs overlap');
b.resolve();
await tick();
assert.deepEqual(synthesized, [], 'later ASR result must not overtake the first');
a.resolve();
await tick();
assert.deepEqual(synthesized, [[1, 'voice-A'], [2, 'voice-B']], 'reference stays paired with segment');
assert.deepEqual(played, [1], 'second audio is synthesized while first is playing');
pipeline.enqueue({ id: 3, ref: 'voice-C' });
await tick();
assert.equal(synthesized.length, 3, 'synthesis continues during playback');
const finishing = pipeline.finish();
playing.resolve();
await finishing;
assert.deepEqual(played, [1, 2, 3], 'natural end drains all segments in order');
assert.equal(pipeline.pending, 0);

const singlePlayed = [];
const single = createInterpretPipeline({ prepare: async x => x, synthesize: async x => x, play: async x => singlePlayed.push(x) });
single.enqueue('last');
await tick();
assert.deepEqual(singlePlayed, [], 'wait for two segments at startup');
await single.finish();
assert.deepEqual(singlePlayed, ['last'], 'short video still plays its final segment');

const abort = new AbortController(), blocked = gate();
let cancelledPlayback = false;
const cancelled = createInterpretPipeline({ signal: abort.signal, prepare: () => blocked.promise,
  synthesize: async x => x, play: async () => { cancelledPlayback = true; }, capacity: 2 });
cancelled.enqueue(1); cancelled.enqueue(2);
assert.equal(cancelled.full, true);
assert.throws(() => cancelled.enqueue(3), /积压/, 'memory is bounded, never silently drop');
const room = cancelled.waitForRoom();
abort.abort();
await cancelled.finish();
await room;
blocked.resolve('late');
await tick();
assert.equal(cancelledPlayback, false, 'late completions do not play after stop');

const errors = [], recovered = [];
const failure = createInterpretPipeline({ prepare: async x => { if (x === 1) throw new Error('ASR failed'); return x; },
  synthesize: async x => x, play: async x => recovered.push(x), onError: e => errors.push(e.message) });
failure.enqueue(1); failure.enqueue(2);
await failure.finish();
assert.deepEqual(errors, ['ASR failed']);
assert.deepEqual(recovered, [2]);
assert.equal(failure.pending, 0);

const settleGate = gate();
let settledFlag = false;
const settling = createInterpretPipeline({
  prepare: async item => { await settleGate.promise; return item; },
  synthesize: async item => item,
  play: async () => {},
  prebuffer: 1,
});
settling.enqueue('first');
const settledWait = settling.waitUntilSettled(1).then(ok => { settledFlag = ok; return ok; });
await tick();
assert.equal(settledFlag, false, 'opening wait stays blocked until first segment settles');
settleGate.resolve();
assert.equal(await settledWait, true);
await settling.finish();

const playingFlush = gate(), latePrepare = gate();
const flushedPlayed = [];
let secondSignal;
const flusher = createInterpretPipeline({
  prepare: async (item, job) => {
    if (item.id === 2) {
      secondSignal = job.signal;
      await latePrepare.promise;
      return item;
    }
    return item;
  },
  synthesize: async item => item,
  play: async item => { flushedPlayed.push(item.id); if (item.id === 1) await playingFlush.promise; },
  prebuffer: 1,
});
flusher.enqueue({ id: 1 });
flusher.enqueue({ id: 2 });
flusher.enqueue({ id: 3 });
for (let i = 0; i < 20 && !flushedPlayed.includes(1); i++) await tick();
assert.deepEqual(flushedPlayed, [1], 'first segment is already playing');
assert.equal(flusher.generation, 0);
flusher.flushAhead();
assert.equal(flusher.generation, 1);
assert(secondSignal?.aborted, 'in-flight prepare is aborted on flush');
latePrepare.resolve();
flusher.enqueue({ id: 4 });
await tick();
playingFlush.resolve();
await flusher.finish();
assert.deepEqual(flushedPlayed, [1, 4], 'flush drops waiting+ready and never plays stale segments');

const readyGate = gate();
const readyPipe = createInterpretPipeline({
  prepare: async item => item,
  synthesize: async item => { await readyGate.promise; return item.id === 'text' ? null : item; },
  play: async () => {},
  prebuffer: 1,
});
readyPipe.enqueue({ id: 'text', start: 0 });
let readyFlag = 'pending';
const readyWait = readyPipe.waitUntilReady(1).then(ok => { readyFlag = ok; return ok; });
await tick();
assert.equal(readyFlag, 'pending', 'null TTS must not count as ready audio');
readyGate.resolve();
assert.equal(await readyWait, false, 'failed dub does not release the picture as if audio arrived');
await readyPipe.finish();

const dubGate = gate();
const dubbed = [];
const audioPipe = createInterpretPipeline({
  prepare: async item => item,
  synthesize: async item => { await dubGate.promise; return item; },
  play: async item => dubbed.push(item.start),
  prebuffer: 1,
});
audioPipe.enqueue({ id: 1, start: 4 });
const hasWait = audioPipe.waitUntilHasAudio(4);
await tick();
assert.equal(audioPipe.hasAudio(4), false);
dubGate.resolve();
assert.equal(await hasWait, true);
assert.equal(audioPipe.hasAudio(4), true);
await audioPipe.finish();

console.log('ok interpretation pipeline: overlap, order, references, buffering, drain, abort, capacity, recovery, generation flush');

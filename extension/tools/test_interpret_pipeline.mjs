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
console.log('ok interpretation pipeline: overlap, order, references, buffering, drain, abort, capacity, recovery');

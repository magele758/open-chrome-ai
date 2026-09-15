import assert from 'node:assert/strict';
import { transcribeInterpretSlice } from '../lib/interpret-asr.js';
import { pcmWav, readPcmWav } from '../lib/downloaded-audio-source.js';
const bytes = new Uint8Array(160000);
bytes.fill(11, 0, 80000); bytes.fill(22, 80000);
const blob = pcmWav([bytes]);
const item = { blob, seconds: 5, start: 30, end: 35 };
const calls = [];
const result = await transcribeInterpretSlice({}, item, { transcribe: async (_model, audio) => {
  const pcm = readPcmWav(await audio.arrayBuffer());
  calls.push(pcm);
  return [{ start: 0, text: calls.length === 1 ? 'study '.repeat(20) : calls.length === 2 ? 'First half.' : 'Second half.' }];
} });
assert.deepEqual(calls.map(p => p.length), [160000, 80000, 80000]);
assert(calls[1].every(b => b === 11)); assert(calls[2].every(b => b === 22));
assert.deepEqual(result, [{ start: 0, end: 2.5, text: 'First half.' }, { start: 2.5, end: 5, text: 'Second half.' }]);
let attempts = 0;
await assert.rejects(transcribeInterpretSlice({}, item, { transcribe: async () => {
  attempts++; return [{ start: 0, text: 'study '.repeat(20) }];
} }), /重试后仍无法确认/);
assert.equal(attempts, 2, 'bounded retries even if the model always loops');
const abort = new AbortController();
attempts = 0;
await assert.rejects(transcribeInterpretSlice({}, item, { signal: abort.signal, transcribe: async () => {
  attempts++; abort.abort(); return [{ text: 'study '.repeat(20) }];
} }), { name: 'AbortError' });
assert.equal(attempts, 1, 'seek/stop must not submit retries');
attempts = 0;
await assert.rejects(transcribeInterpretSlice({}, item, { transcribe: async () => {
  attempts++; throw new Error('401 unauthorized');
} }), /401/);
assert.equal(attempts, 1);
console.log('PASS ASR recovery: exact audio coverage, local timestamps, bounded retries, abort, auth failure');

let silentRequests = 0;
assert.deepEqual(await transcribeInterpretSlice({}, { blob: pcmWav([new Uint8Array(160000)]) }, {
  transcribe: async () => { silentRequests++; return []; },
}), []);
assert.equal(silentRequests, 0, 'digital silence must not trigger model hallucinations');

// Recover the good half even when one short span remains undecodable.
const missed = [];
let recoveryCalls = 0;
const partial = await transcribeInterpretSlice({}, item, {
  onUnrecognized: range => missed.push(range),
  transcribe: async () => {
    recoveryCalls++;
    return [{ start: 0, text: recoveryCalls < 3 ? 'study '.repeat(20) : 'Recovered ending.' }];
  },
});
assert.equal(recoveryCalls, 3);
assert.deepEqual(missed, [{ start: 0, end: 2.5 }]);
assert.deepEqual(partial, [{ start: 2.5, end: 5, text: 'Recovered ending.' }]);
const longBlob = pcmWav([new Uint8Array(320000).fill(20)]);
let recursiveCalls = 0;
const recovered = await transcribeInterpretSlice({}, { blob: longBlob }, {
  transcribe: async (_model, audio) => {
    recursiveCalls++;
    const pcm = readPcmWav(await audio.arrayBuffer());
    return [{ start: 0, text: pcm.length > 80000 ? 'study '.repeat(20) : 'Recovered speech.' }];
  },
});
assert.equal(recursiveCalls, 7);
assert.deepEqual(recovered.map(s => [s.start, s.end]), [[0, 2.5], [2.5, 5], [5, 7.5], [7.5, 10]]);
console.log('PASS bounded recursive recovery and isolated unrecoverable spans');

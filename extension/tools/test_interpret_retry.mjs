import assert from 'node:assert/strict';
import { retryInterpretRequest, isTransientInterpretError } from '../lib/interpret-retry.js';

for (const message of ['Failed to fetch', 'fetch failed', 'Load failed', 'terminated', '连接中断', '同传请求超时', '503 unavailable', '429 rate limited']) {
  assert(isTransientInterpretError(new Error(message)), message);
}
for (const message of ['401 Unauthorized', '403 Forbidden', '400 bad request', '配音生成失败：404', '口播稿为空']) {
  assert(!isTransientInterpretError(new Error(message)), message);
}
let calls = 0;
const notices = [];
assert.equal(await retryInterpretRequest(async () => {
  if (++calls < 3) throw new TypeError('Failed to fetch');
  return '完整译文';
}, { delayMs: 0, onRetry: n => notices.push(n.attempt) }), '完整译文');
assert.deepEqual(notices, [1, 2]);
calls = 0;
await assert.rejects(retryInterpretRequest(async () => { calls++; throw Error('503 unavailable'); }, { delayMs: 0 }), /503/);
assert.equal(calls, 3, 'outages exhaust a bounded retry budget');
calls = 0;
await assert.rejects(retryInterpretRequest(async () => { calls++; throw Error('401 Unauthorized'); }), /401/);
assert.equal(calls, 1);
const abort = new AbortController();
calls = 0;
await assert.rejects(retryInterpretRequest(async () => { calls++; throw Error('Failed to fetch'); }, {
  signal: abort.signal, onRetry: () => abort.abort(), delayMs: 60000,
}), { name: 'AbortError' });
assert.equal(calls, 1, 'stop interrupts the backoff without a further request');
calls = 0;
await assert.rejects(retryInterpretRequest(() => { calls++; return new Promise(() => {}); }, {
  timeoutMs: 5, delayMs: 0,
}), /超时/);
assert.equal(calls, 3, 'uncooperative requests cannot permanently block the queue');
console.log('PASS bounded recovery: transient errors, auth, cancellation and deadlines');

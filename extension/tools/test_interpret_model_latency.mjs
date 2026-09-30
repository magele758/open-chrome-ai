import assert from 'node:assert/strict';
import { completeChat } from '../lib/openai.js';

const model = { baseUrl: 'https://text.test/v1', model: 'deepseek-v4-flash-0731' };
const request = { messages: [{ role: 'user', content: 'Translate this sentence.' }], lowLatency: true };
const bodies = [];
let respond = () => ({ choices: [{ message: { content: '译文。' }, finish_reason: 'stop' }] });
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  bodies.push(body);
  return Response.json(respond(body));
};

await completeChat(model, request);
assert.deepEqual(bodies.pop().thinking, { type: 'disabled' }, 'interpretation disables DeepSeek thinking');
await completeChat(model, { ...request, lowLatency: false });
assert(!('thinking' in bodies.pop()), 'ordinary chat preserves the configured/default model behavior');
await completeChat({ ...model, model: 'gpt-test' }, request);
assert(!('thinking' in bodies.pop()), 'unrelated providers never receive the DeepSeek field');
await completeChat({ ...model, model: 'deepseek-ai/deepseek-v4-pro' }, request);
assert.deepEqual(bodies.pop().thinking, { type: 'disabled' });

let calls = 0;
respond = () => ++calls === 1
  ? { choices: [{ message: { content: '' }, finish_reason: 'length' }] }
  : { choices: [{ message: { content: '完整译文。' }, finish_reason: 'stop' }] };
assert.equal(await completeChat(model, request), '完整译文。');
assert.equal(bodies.length, 2);
assert(bodies.every(body => body.thinking?.type === 'disabled'), 'token-budget retry keeps low latency');

bodies.length = 0;
respond = body => ({ choices: [{ message: { content: body.stream ? '恢复的译文。' : '' }, finish_reason: 'stop' }] });
assert.equal(await completeChat(model, request), '恢复的译文。');
assert.equal(bodies.length, 2);
assert.equal(bodies[1].stream, true);
assert(bodies.every(body => body.thinking?.type === 'disabled'), 'stream fallback keeps low latency');
console.log('PASS interpretation thinking control, normal-chat isolation, provider isolation, retry and stream fallback');

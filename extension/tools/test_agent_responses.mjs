import assert from 'node:assert/strict';
import { streamTurn } from '../lib/openai.js';
import { createAgentLoop } from '../lib/agent/loop.js';

const model = { baseUrl: 'https://mock.test/v1', model: 'mock', apiKey: 'local' };
const originalFetch = globalThis.fetch;
const calls = [
  { id: 'one', type: 'function', function: { name: 'first_tool', arguments: '{"n":1}' } },
  { id: 'two', type: 'function', function: { name: 'second_tool', arguments: '{"n":2}' } },
];
try {
  for (const streaming of [false, true]) {
    let requests = 0;
    const executed = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      requests++;
      const message = requests === 1 ? { content: '', tool_calls: calls } : { content: '工具调用完成' };
      if (requests === 2) {
        assert.deepEqual(body.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['one', 'two']);
      }
      if (!streaming) return Response.json({ choices: [{ message, finish_reason: 'stop' }] });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: message, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };
    const loop = createAgentLoop({
      systemPrompt: 'test',
      tools: ['first_tool', 'second_tool'].map(name => ({
        name, execute: async args => { executed.push([name, args.n]); return 'ok'; },
      })),
      model: { runTurn: input => streamTurn(model, input, input.onTextDelta) },
    });
    let visible = '';
    const out = await loop.run('运行两个工具', { onTextDelta: delta => { visible += delta; } });
    assert.equal(out.text, '工具调用完成');
    assert.equal(visible, out.text);
    assert.equal(requests, 2);
    assert.deepEqual(executed, [['first_tool', 1], ['second_tool', 2]]);
  }
  console.log('PASS agent JSON/SSE responses and multiple unindexed tool calls');
} finally {
  globalThis.fetch = originalFetch;
}

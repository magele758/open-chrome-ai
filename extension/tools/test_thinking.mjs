import assert from 'node:assert/strict';
import { splitThinking } from '../lib/markdown.js';
import { streamTurn } from '../lib/openai.js';
import { createAgentLoop } from '../lib/agent/loop.js';

// 1. Test splitThinking unit behaviors
{
  // Plain answer
  const res1 = splitThinking("你好，这是回答。");
  assert.equal(res1.thinking, "");
  assert.equal(res1.answer, "你好，这是回答。");
  assert.equal(res1.isStreamingThinking, false);

  // Explicit reasoning from API
  const res2 = splitThinking("最终结果", "先检查用户意图，再分析问题");
  assert.equal(res2.thinking, "先检查用户意图，再分析问题");
  assert.equal(res2.answer, "最终结果");
  assert.equal(res2.isStreamingThinking, false);

  // Closed <think> tags in text
  const res3 = splitThinking("<think>\n第一步：分析网页结构\n第二步：提取要点\n</think>\n\n这是总结结果。");
  assert.equal(res3.thinking, "第一步：分析网页结构\n第二步：提取要点");
  assert.equal(res3.answer, "这是总结结果。");
  assert.equal(res3.isStreamingThinking, false);

  // Closed <thought> tags in text
  const res4 = splitThinking("<thought>思考中...</thought>正文内容");
  assert.equal(res4.thinking, "思考中...");
  assert.equal(res4.answer, "正文内容");
  assert.equal(res4.isStreamingThinking, false);

  // Streaming unclosed <think> tag
  const res5 = splitThinking("<think>\n正在深度思考步骤 1...");
  assert.equal(res5.thinking, "正在深度思考步骤 1...");
  assert.equal(res5.answer, "");
  assert.equal(res5.isStreamingThinking, true);

  // Combined explicit reasoning and closed tag
  const res6 = splitThinking("<think>标签内思考</think>回答内容", "API字段思考");
  assert.equal(res6.thinking, "API字段思考\n\n标签内思考");
  assert.equal(res6.answer, "回答内容");
  assert.equal(res6.isStreamingThinking, false);

  console.log("PASS splitThinking unit tests");
}

// 2. Test streamTurn with onReasoningDelta
{
  const sseResponse = (chunks) => new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );

  const model = { baseUrl: 'https://mock.test/v1', model: 'deepseek-r1', apiKey: 'mock' };
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "让我思考" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "一下这个问题" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "这是正式回答" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "的完整内容。" }, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);

    const textDeltas = [];
    const reasoningDeltas = [];

    const result = await streamTurn(
      model,
      {
        messages: [{ role: "user", content: "test" }],
        onReasoningDelta: (d) => reasoningDeltas.push(d),
      },
      (d) => textDeltas.push(d),
    );

    assert.equal(result.content, "这是正式回答的完整内容。");
    assert.equal(result.reasoning, "让我思考一下这个问题");
    assert.deepEqual(reasoningDeltas, ["让我思考", "一下这个问题"]);
    assert.deepEqual(textDeltas, ["这是正式回答", "的完整内容。"]);

    console.log("PASS streamTurn reasoning & content streaming tests");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// 3. Test agent loop with onReasoningDelta
{
  const sseResponse = (chunks) => new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );

  const model = { baseUrl: 'https://mock.test/v1', model: 'mock', apiKey: 'mock' };
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "思考分析页面" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "分析结果如下" }, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);

    const loop = createAgentLoop({
      systemPrompt: 'test',
      tools: [],
      model: {
        runTurn: (input) => streamTurn(model, input, input.onTextDelta),
      },
    });

    const collectedReasoning = [];
    const collectedText = [];
    const events = [];

    const out = await loop.run("请分析", {
      onReasoningDelta: (d) => collectedReasoning.push(d),
      onTextDelta: (d) => collectedText.push(d),
      onEvent: (ev) => events.push(ev),
    });

    assert.equal(out.text, "分析结果如下");
    assert.equal(out.reasoning, "思考分析页面");
    assert.deepEqual(collectedReasoning, ["思考分析页面"]);
    assert.deepEqual(collectedText, ["分析结果如下"]);

    const modelDone = events.find((e) => e.type === "model_done");
    assert.ok(modelDone, "model_done event emitted");
    assert.equal(modelDone.reasoning, "思考分析页面");

    console.log("PASS agent loop reasoning propagation tests");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("ALL THINKING TESTS PASSED!");

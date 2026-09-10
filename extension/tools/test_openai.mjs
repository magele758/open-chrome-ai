import assert from "node:assert/strict";
import { chatCompletionsUrl, completeChat, messageText, streamTurn } from "../lib/openai.js";
import { summarizeTranscript } from "../lib/summarize-transcript.js";

assert.equal(
  chatCompletionsUrl("https://generativelanguage.googleapis.com/v1beta/openai"),
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
);

assert.equal(messageText({ choices: [{ message: { content: "  hi  " } }] }), "hi");
assert.equal(messageText({
  choices: [{ message: { content: [{ type: "thinking", text: "scratch" }, { type: "text", text: "笔记" }] } }],
}), "笔记");
assert.equal(messageText({
  choices: [{ message: { content: "" }, finish_reason: "length" }],
}), "");
assert.equal(messageText({
  choices: [{ message: { content: null, reasoning_content: "  分段笔记  " } }],
}), "分段笔记");

const model = {
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  model: "gemini-2.5-flash",
  apiKey: "x",
};

let n = 0;
const bodies = [];
globalThis.fetch = async (_url, opts) => {
  const body = JSON.parse(opts.body);
  bodies.push(body);
  n += 1;
  if (n === 1) {
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 1200);
    return Response.json({
      choices: [{ message: { content: "" }, finish_reason: "length" }],
      usage: { completion_tokens_details: { reasoning_tokens: 1200 } },
    });
  }
  if (!body.stream) {
    assert.ok(body.max_tokens >= 8192, `retry budget ${body.max_tokens}`);
    return Response.json({
      choices: [{ message: { content: "要点：开场" }, finish_reason: "stop" }],
    });
  }
  throw new Error("should not stream after non-stream retry succeeds");
};

const note = await completeChat(model, {
  maxTokens: 1200,
  messages: [{ role: "user", content: "sum" }],
});
assert.equal(note, "要点：开场");
assert.equal(n, 2, "thinking-exhausted empty content must retry with a larger budget");

n = 0;
globalThis.fetch = async (_url, opts) => {
  const body = JSON.parse(opts.body);
  n += 1;
  if (!body.stream) {
    return Response.json({
      choices: [{ message: { content: null }, finish_reason: "stop" }],
    });
  }
  const ev = JSON.stringify({ choices: [{ delta: { content: "章节 00:01" } }] });
  return new Response(`data: ${ev}\n\ndata: [DONE]\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });
};
assert.equal(await completeChat(model, { messages: [{ role: "user", content: "sum" }] }), "章节 00:01");
assert.ok(n >= 2, "empty non-stream content falls back to the streaming path");

globalThis.fetch = async () => Response.json({
  choices: [{ message: { content: [{ type: "text", text: "hello " }, { text: "world" }] } }],
});
assert.equal(await completeChat(model, { messages: [] }), "hello world");

const long = Array.from({ length: 3 }, (_, i) => `[${i}:00] MARKER_${i} ${"words ".repeat(1700)}\n`).join("");
globalThis.fetch = async (_url, opts) => {
  const body = JSON.parse(opts.body);
  const user = body.messages.at(-1).content;
  if (body.stream) throw new Error("summarize should succeed on the larger non-stream retry");
  if (body.max_tokens && body.max_tokens <= 4000) {
    return Response.json({ choices: [{ message: { content: "" }, finish_reason: "length" }] });
  }
  if (user.includes("提取本段要点")) {
    return Response.json({ choices: [{ message: { content: user.match(/MARKER_\d/)?.[0] || "note" } }] });
  }
  return Response.json({ choices: [{ message: { content: "要点：全文\n\n00:00 开场" } }] });
};
assert.match(await summarizeTranscript({ text: long, title: "v", model }), /要点：全文/);

function sseResponse(chunks, { close = true } = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      if (close) controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(label || `timeout ${ms}ms`)), ms);
    }),
  ]);
}

function trackReads(response) {
  const inner = response.body.getReader();
  let reads = 0;
  let readsAfterDone = 0;
  let sawDone = false;
  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (sawDone) readsAfterDone += 1;
            reads += 1;
            const result = await inner.read();
            if (result.value && new TextDecoder().decode(result.value).includes("[DONE]")) {
              sawDone = true;
            }
            return result;
          },
          cancel: (reason) => inner.cancel(reason),
        };
      },
    },
    get reads() { return reads; },
    get readsAfterDone() { return readsAfterDone; },
  };
}

function delayedSse(chunks, { delayMs = 25, close = false } = {}) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(c));
        await new Promise((r) => setTimeout(r, delayMs));
      }
      if (close) controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

const liveDeltas = [];
let sawFirstDelta;
const firstDelta = new Promise((resolve) => { sawFirstDelta = resolve; });
globalThis.fetch = async () => delayedSse([
  `data: ${JSON.stringify({ choices: [{ delta: { content: "你" } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: { content: "好" } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: { content: "啊" } }] })}\n\n`,
  "data: [DONE]\n\n",
]);
const liveTurn = streamTurn(model, { messages: [{ role: "user", content: "hi" }] }, (d) => {
  liveDeltas.push(d);
  if (liveDeltas.length === 1) sawFirstDelta();
});
await withTimeout(firstDelta, 400, "first SSE chunk did not emit onTextDelta before [DONE]");
assert.deepEqual(liveDeltas, ["你"]);
const liveResult = await withTimeout(liveTurn, 800, "streamTurn hung after [DONE]");
assert.deepEqual(liveDeltas, ["你", "好", "啊"]);
assert.equal(liveResult.content, "你好啊");

const tracked = trackReads(sseResponse([
  `data: ${JSON.stringify({ choices: [{ delta: { content: "你好" } }] })}\n\n`,
  "data: [DONE]\n\n",
], { close: false }));
globalThis.fetch = async () => tracked;
const streamed = await withTimeout(
  streamTurn(model, { messages: [{ role: "user", content: "hi" }] }),
  400,
  "streamTurn hung after [DONE]",
);
assert.equal(streamed.content, "你好");
assert.equal(streamed.toolCalls.length, 0);
assert.equal(tracked.readsAfterDone, 0, "must not reader.read() after [DONE]");

const deltas = [];
globalThis.fetch = async () => sseResponse([
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "c1", function: { name: "extract_page", arguments: "{" } }] } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { arguments: "}" } }] } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ finish_reason: "stop", delta: {} }] })}\n\n`,
  "data: [DONE]\n\n",
], { close: false });
const tooled = await withTimeout(
  streamTurn(model, { messages: [], tools: [{ type: "function", function: { name: "extract_page" } }] }, (d) => deltas.push(d)),
  400,
  "streamTurn hung on Gemini tool SSE",
);
assert.equal(tooled.toolCalls.length, 1);
assert.equal(tooled.toolCalls[0].name, "extract_page");
assert.equal(tooled.toolCalls[0].arguments, "{}");
assert.equal(tooled.finishReason, "tool_calls");

const thoughtDeltas = [];
globalThis.fetch = async () => sseResponse([
  `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "先看" } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "标题" } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ finish_reason: "stop", delta: {} }] })}\n\n`,
  "data: [DONE]\n\n",
]);
const thought = await streamTurn(model, { messages: [] }, (d) => thoughtDeltas.push(d));
assert.equal(thought.content, "先看标题");
assert.deepEqual(thoughtDeltas, ["先看", "标题"]);

globalThis.fetch = async () => Response.json({
  choices: [{ message: { content: "非流式正文" }, finish_reason: "stop" }],
});
assert.equal((await streamTurn(model, { messages: [] })).content, "非流式正文");

console.log("PASS openai content parse, thinking-budget retry, stream fallback");

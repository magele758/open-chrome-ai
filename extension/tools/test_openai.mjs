import assert from "node:assert/strict";
import { chatCompletionsUrl, completeChat, messageText } from "../lib/openai.js";
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

console.log("PASS openai content parse, thinking-budget retry, stream fallback");

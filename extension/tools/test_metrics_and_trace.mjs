import assert from "node:assert/strict";
import { estimateTokens, estimateMessagesTokens } from "../lib/openai.js";
import { createAgentLoop } from "../lib/agent/loop.js";
import { normalizeMessage, normalizeSession, saveSession, loadSession } from "../lib/sessions.js";
import { installMemoryIndexedDB } from "./idb_mem.mjs";

console.log("Starting metrics and trace tests...");

// 1. Test token estimation
assert.equal(estimateTokens(""), 0);
assert.ok(estimateTokens("Hello world") > 0, "English token estimate");
assert.ok(estimateTokens("你好世界，这是一个测试") >= 10, "Chinese token estimate");

const msgs = [
  { role: "user", content: "请帮我分析这篇文章" },
  { role: "assistant", content: "好的，这篇文章讨论了人工智能在浏览器插件中的应用。" },
];
const estimatedMsgTokens = estimateMessagesTokens(msgs);
assert.ok(estimatedMsgTokens > 20, "Messages token estimate");

// 2. Test Agent Loop metrics & traceSteps
const loop = createAgentLoop({
  maxTurns: 3,
  systemPrompt: "You are a test agent.",
  tools: [
    {
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
      execute: async (args) => {
        await new Promise((r) => setTimeout(r, 20));
        return JSON.stringify({ temp: 25, condition: "Sunny", city: args.city });
      },
    },
  ],
  model: {
    async runTurn({ messages }) {
      const last = messages[messages.length - 1];
      if (last.role === "tool") {
        return {
          content: "北京今天天气晴朗，气温25度。",
          toolCalls: [],
          finishReason: "stop",
          usage: { promptTokens: 120, completionTokens: 25, totalTokens: 145 },
        };
      }
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "call_1", name: "get_weather", arguments: JSON.stringify({ city: "Beijing" }) }],
        usage: { promptTokens: 80, completionTokens: 15, totalTokens: 95 },
      };
    },
  },
});

const runResult = await loop.run("北京今天天气怎么样？", { sessionId: "test-sess-1" });

assert.equal(runResult.reason, "stop");
assert.match(runResult.text, /北京今天天气晴朗/);
assert.ok(runResult.metrics, "metrics object should exist");
assert.ok(runResult.metrics.durationMs > 20, "durationMs should reflect tool and loop time");
assert.equal(runResult.metrics.inputTokens, 200, "total inputTokens should be 80 + 120 = 200");
assert.equal(runResult.metrics.outputTokens, 40, "total outputTokens should be 15 + 25 = 40");
assert.equal(runResult.metrics.totalTokens, 240, "totalTokens should be 240");
assert.equal(runResult.metrics.finishReason, "stop", "finishReason should be stop");

assert.ok(Array.isArray(runResult.traceSteps), "traceSteps should be an array");
const toolSteps = runResult.traceSteps.filter((s) => s.type === "tool_exec");
assert.equal(toolSteps.length, 1, "should have 1 tool_exec step");
assert.equal(toolSteps[0].name, "get_weather");
assert.ok(toolSteps[0].durationMs >= 15, "tool duration recorded");
assert.equal(toolSteps[0].ok, true);

// 3. Test Session persistence of metrics and traceLog
const idb = installMemoryIndexedDB();
const bag = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === "string") return { [keys]: bag[keys] };
        if (Array.isArray(keys)) {
          const out = {};
          for (const k of keys) out[k] = bag[k];
          return out;
        }
        return { ...bag };
      },
      set: async (obj) => Object.assign(bag, obj),
      remove: async (keys) => {
        for (const k of [].concat(keys)) delete bag[k];
      },
    },
  },
};

const normalized = normalizeMessage({
  role: "bot",
  text: runResult.text,
  trace: [{ name: "get_weather", ok: true }],
  metrics: runResult.metrics,
  traceLog: {
    version: "1.0",
    sessionId: "test-sess-1",
    metrics: runResult.metrics,
    steps: runResult.traceSteps,
  },
});

assert.ok(normalized.metrics, "normalizeMessage keeps metrics");
assert.equal(normalized.metrics.durationMs, runResult.metrics.durationMs);
assert.equal(normalized.metrics.inputTokens, 200);
assert.equal(normalized.metrics.outputTokens, 40);
assert.equal(normalized.metrics.finishReason, "stop");
assert.ok(normalized.traceLog, "normalizeMessage keeps traceLog");
assert.equal(normalized.traceLog.steps.length, runResult.traceSteps.length);

await saveSession({
  id: "test-sess-1",
  messages: [
    { role: "user", text: "北京天气" },
    normalized,
  ],
});

const loaded = await loadSession("test-sess-1");
assert.equal(loaded.messages.length, 2);
const loadedBot = loaded.messages[1];
assert.ok(loadedBot.metrics, "loaded session preserves bot metrics");
assert.equal(loadedBot.metrics.inputTokens, 200);
assert.equal(loadedBot.metrics.outputTokens, 40);
assert.equal(loadedBot.metrics.finishReason, "stop");
assert.ok(loadedBot.traceLog, "loaded session preserves bot traceLog");
assert.equal(loadedBot.traceLog.steps[0].type, runResult.traceSteps[0].type);

console.log("PASS test_metrics_and_trace: durationMs, tokens, finishReason, and traceLog verified!");

import assert from "node:assert/strict";
import { defaultSettings, normalizeSettings } from "../lib/storage.js";
import { formatTracePayload, sendTraceToLangfuse, testLangfuseConnection, isLangfuseConfigured } from "../lib/langfuse.js";

console.log("Starting Langfuse integration tests...");

// 0. Test isLangfuseConfigured guard
assert.equal(isLangfuseConfigured(null), false);
assert.equal(isLangfuseConfigured({}), false);
assert.equal(isLangfuseConfigured({ enabled: false, baseUrl: "http://localhost:3000", publicKey: "pk", secretKey: "sk" }), false);
assert.equal(isLangfuseConfigured({ enabled: true, baseUrl: "", publicKey: "pk", secretKey: "sk" }), false);
assert.equal(isLangfuseConfigured({ enabled: true, baseUrl: "http://localhost:3000", publicKey: "", secretKey: "sk" }), false);
assert.equal(isLangfuseConfigured({ enabled: true, baseUrl: "http://localhost:3000", publicKey: "pk", secretKey: "" }), false);
assert.equal(isLangfuseConfigured({ enabled: true, baseUrl: "http://localhost:3000", publicKey: "pk", secretKey: "sk" }), true);


// 1. Test storage normalization for Langfuse settings
const def = defaultSettings();
assert.ok(def.langfuse, "defaultSettings should have langfuse");
assert.equal(def.langfuse.enabled, false);
assert.equal(def.langfuse.baseUrl, "http://localhost:3000");
assert.equal(def.langfuse.publicKey, "");
assert.equal(def.langfuse.secretKey, "");

const normalized = normalizeSettings({
  langfuse: {
    enabled: true,
    baseUrl: "http://127.0.0.1:3000///",
    publicKey: "  pk-lf-12345  ",
    secretKey: "  sk-lf-67890  ",
    environment: "production",
  },
});
assert.equal(normalized.langfuse.enabled, true);
assert.equal(normalized.langfuse.baseUrl, "http://127.0.0.1:3000", "trailing slashes stripped");
assert.equal(normalized.langfuse.publicKey, "pk-lf-12345", "whitespace trimmed");
assert.equal(normalized.langfuse.secretKey, "sk-lf-67890", "whitespace trimmed");
assert.equal(normalized.langfuse.environment, "production");

// 2. Test formatTracePayload
const sampleTraceLog = {
  version: "1.0",
  sessionId: "sess-abc-123",
  timestamp: "2026-09-22T10:00:00.000Z",
  model: "gpt-4o-mini",
  durationMs: 1500,
  userPrompt: "分析当前页面结构",
  botResponse: "页面包含3个主要模块。",
  thinking: "正在思考页面结构...",
  metrics: {
    durationMs: 1500,
    inputTokens: 120,
    outputTokens: 45,
    totalTokens: 165,
    finishReason: "stop",
  },
  page: { url: "https://example.com", title: "Example Page" },
  steps: [
    {
      type: "model_turn",
      turn: 1,
      durationMs: 500,
      finishReason: "tool_calls",
      usage: { promptTokens: 60, completionTokens: 20, totalTokens: 80 },
      toolCalls: [{ id: "call_1", name: "read_page", arguments: "{}" }],
      timestamp: 1790071200500,
    },
    {
      type: "tool_exec",
      name: "read_page",
      args: { maxChars: 5000 },
      ok: true,
      durationMs: 250,
      resultPreview: "<html>...</html>",
      timestamp: 1790071200750,
    },
    {
      type: "compressed",
      turn: 1,
      before: 8000,
      after: 4000,
      timestamp: 1790071200800,
    },
    {
      type: "tool_intercepted",
      name: "run_shell",
      args: { command: "rm -rf /" },
      reason: "高危命令已被安全策略拦截",
      timestamp: 1790071200850,
    },
    {
      type: "model_turn",
      turn: 2,
      durationMs: 600,
      finishReason: "stop",
      usage: { promptTokens: 60, completionTokens: 25, totalTokens: 85 },
      contentLength: 28,
      timestamp: 1790071201450,
    },
  ],
};

const formatted = formatTracePayload(sampleTraceLog, { environment: "test", release: "0.12.0" });
assert.ok(formatted.traceId, "traceId generated");
assert.equal(formatted.batch.length, 8, "1 trace + 2 turn spans + 2 generations + 1 tool span + 2 events = 8 batch items");

const traceItem = formatted.batch.find((item) => item.type === "trace-create");
assert.ok(traceItem, "trace-create exists");
assert.equal(traceItem.body.id, formatted.traceId);
assert.equal(traceItem.body.sessionId, "sess-abc-123");
assert.equal(traceItem.body.input, "分析当前页面结构");
assert.equal(traceItem.body.output, "页面包含3个主要模块。");
assert.equal(traceItem.body.metadata.model, "gpt-4o-mini");
assert.equal(traceItem.body.metadata.tokens.totalTokens, 165);

const turnSpans = formatted.batch.filter((item) => item.type === "span-create" && item.body.name.startsWith("Turn "));
assert.equal(turnSpans.length, 2, "2 Turn Spans (Turn 1 and Turn 2)");
const turn1Span = turnSpans.find((s) => s.body.name === "Turn 1");
assert.ok(turn1Span, "Turn 1 span exists");

const genItems = formatted.batch.filter((item) => item.type === "generation-create");
assert.equal(genItems.length, 2, "2 generation items");
assert.equal(genItems[0].body.name, "model_turn_1");
assert.equal(genItems[0].body.model, "gpt-4o-mini");
assert.equal(genItems[0].body.usage.totalTokens, 80);
assert.equal(genItems[0].body.parentObservationId, turn1Span.body.id, "Generation nested under Turn 1");
assert.equal(genItems[1].body.name, "model_turn_2");
assert.equal(genItems[1].body.usage.totalTokens, 85);

const toolSpans = formatted.batch.filter((item) => item.type === "span-create" && item.body.name.startsWith("tool:"));
assert.equal(toolSpans.length, 1, "1 span item for tool_exec");
assert.equal(toolSpans[0].body.name, "tool:read_page");
assert.equal(toolSpans[0].body.input.maxChars, 5000);
assert.equal(toolSpans[0].body.level, "DEFAULT");
assert.equal(toolSpans[0].body.statusMessage, "success");
assert.equal(toolSpans[0].body.parentObservationId, turn1Span.body.id, "Tool span nested under Turn 1");

const eventItems = formatted.batch.filter((item) => item.type === "event-create");
assert.equal(eventItems.length, 2, "2 event items (compressed + intercepted)");
const interceptEvent = eventItems.find((e) => e.body.name === "guardrail:intercepted:run_shell");
assert.ok(interceptEvent);
assert.equal(interceptEvent.body.level, "WARNING");
assert.equal(interceptEvent.body.output, "高危命令已被安全策略拦截");
assert.equal(interceptEvent.body.parentObservationId, turn1Span.body.id, "Intercepted event nested under Turn 1");

// 3. Test sendTraceToLangfuse behavior
// 3a. Skipped if disabled
const disabledRes = await sendTraceToLangfuse(sampleTraceLog, { enabled: false });
assert.equal(disabledRes.ok, false);
assert.equal(disabledRes.skipped, true);
assert.equal(disabledRes.reason, "disabled");

// 3b. Skipped if missing credentials
const noCredsRes = await sendTraceToLangfuse(sampleTraceLog, { enabled: true, baseUrl: "http://localhost:3000" });
assert.equal(noCredsRes.ok, false);
assert.equal(noCredsRes.skipped, true);
assert.equal(noCredsRes.reason, "missing_credentials");

// 3c. Mock fetch for successful ingestion
const originalFetch = globalThis.fetch;
let capturedRequest = null;
globalThis.fetch = async (url, options) => {
  capturedRequest = { url, options };
  return {
    ok: true,
    status: 200,
    json: async () => ({ successes: [{ id: "1" }], errors: [] }),
    text: async () => JSON.stringify({ successes: [{ id: "1" }], errors: [] }),
  };
};

try {
  const uploadRes = await sendTraceToLangfuse(
    sampleTraceLog,
    {
      enabled: true,
      baseUrl: "http://localhost:3000",
      publicKey: "pk-123",
      secretKey: "sk-456",
    }
  );
  assert.equal(uploadRes.ok, true);
  assert.equal(capturedRequest.url, "http://localhost:3000/api/public/ingestion");
  assert.equal(capturedRequest.options.method, "POST");
  const authHeader = capturedRequest.options.headers.Authorization;
  assert.ok(authHeader.startsWith("Basic "));
  const decodedAuth = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
  assert.equal(decodedAuth, "pk-123:sk-456");

  const bodyObj = JSON.parse(capturedRequest.options.body);
  assert.ok(Array.isArray(bodyObj.batch));
  assert.equal(bodyObj.batch.length, 8);
} finally {
  globalThis.fetch = originalFetch;
}

// 4. Test testLangfuseConnection
// 4a. Missing fields
const missingHost = await testLangfuseConnection({ baseUrl: "" });
assert.equal(missingHost.ok, false);
assert.match(missingHost.message, /请填写 Langfuse Host 地址/);

const missingKeys = await testLangfuseConnection({ baseUrl: "http://localhost:3000" });
assert.equal(missingKeys.ok, false);
assert.match(missingKeys.message, /请填写 Public Key 和 Secret Key/);

// 4b. Mock 401 Unauthorized
globalThis.fetch = async () => ({
  ok: false,
  status: 401,
  statusText: "Unauthorized",
});
try {
  const connRes = await testLangfuseConnection({
    baseUrl: "http://localhost:3000",
    publicKey: "bad-pk",
    secretKey: "bad-sk",
  });
  assert.equal(connRes.ok, false);
  assert.match(connRes.message, /认证失败/);
} finally {
  globalThis.fetch = originalFetch;
}

// 4c. Mock 200 OK
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => ({ status: "OK" }),
});
try {
  const connRes = await testLangfuseConnection({
    baseUrl: "http://localhost:3000",
    publicKey: "pk-123",
    secretKey: "sk-456",
  });
  assert.equal(connRes.ok, true);
  assert.match(connRes.message, /连接成功/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("PASS test_langfuse: formatting, ingestion, error handling, and connectivity verified!");

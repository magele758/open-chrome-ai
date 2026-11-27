import assert from "node:assert/strict";
import { test } from "node:test";
import { isContextWindowError, resolveModelContext } from "../lib/model-context.js";
import { normalizeSettings } from "../lib/storage.js";
import { mergeScannedModels, parseRemoteModelList, textSlotFromRef } from "../lib/text-providers.js";

test("selected model keeps provider limits across scanning and storage, without inheriting another model's window", async () => {
  const models = mergeScannedModels([], parseRemoteModelList({ data: [
    { id: "small", context_length: 32000, top_provider: { context_length: 8000, max_completion_tokens: 1000 } },
    { id: "large", context_window: 200000, max_output_tokens: 8192 },
    { id: "custom" },
  ] }));
  const providers = [{ id: "p", baseUrl: "https://models.invalid/v1", models }];
  const refreshed = mergeScannedModels(models, [{ id: "small" }, { id: "large", contextWindowTokens: 100000 }]);
  assert.equal(refreshed[0].contextWindowTokens, 8000);
  assert.equal(refreshed[1].contextWindowTokens, 100000);
  const small = normalizeSettings({ textProviders: providers, textRef: { providerId: "p", modelId: "small" } }).text;
  const noFetch = () => assert.fail("cached catalog must not cause another metadata request");
  assert.deepEqual(await resolveModelContext(small, { fetchImpl: noFetch }), {
    contextTokens: 8000, outputTokens: 1000, inputTokens: 6650, source: "provider-catalog",
  });
  const large = textSlotFromRef(providers, { providerId: "p", modelId: "large" }, small);
  assert.equal((await resolveModelContext(large, { fetchImpl: noFetch })).contextTokens, 200000);
  const custom = textSlotFromRef(providers, { providerId: "p", modelId: "custom" }, large);
  assert.equal(custom.contextWindowTokens, null);
  assert.equal(custom.maxOutputTokens, null);
  assert.equal(normalizeSettings({ text: small }).text.contextWindowTokens, 8000);
});

test("existing settings query only their configured provider once and honor smaller gateway limits", async () => {
  const model = { model: "claude-opus-5", baseUrl: "https://own-provider.invalid/v1/chat/completions", apiKey: "fixture" };
  let requests = 0;
  const fetchImpl = async (url, init) => {
    requests++;
    assert.equal(url, "https://own-provider.invalid/v1/models");
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.equal(init.headers.Authorization, "Bearer fixture");
    return Response.json({ data: [
      { id: "unrelated", max_model_len: 500000 },
      { id: model.model, max_model_len: 16384, max_input_tokens: 4096, max_output_tokens: 512 },
    ] });
  };
  const expected = { contextTokens: 16384, inputTokens: 3891, outputTokens: 512, source: "provider" };
  assert.deepEqual(await resolveModelContext(model, { fetchImpl }), expected);
  assert.deepEqual(await resolveModelContext(model, { fetchImpl }), expected);
  assert.equal(requests, 1);
});

test("uses published model defaults and distinguishes unreported custom limits, aborts, and genuine window overflows", async () => {
  assert.equal((await resolveModelContext({ model: "anthropic/claude-opus-5" })).contextTokens, 1000000);
  assert.equal((await resolveModelContext({ model: "deepseek-flash" })).contextTokens, 1048576);
  assert.equal((await resolveModelContext({ model: "deepseek-flash" })).source, "model-spec");
  const fallback = await resolveModelContext({ model: "custom" });
  assert.equal(fallback.source, "estimate");
  assert.ok(fallback.inputTokens + fallback.outputTokens < fallback.contextTokens);
  assert.equal((await resolveModelContext({ model: "input-only", maxInputTokens: 10000, maxOutputTokens: 512 })).inputTokens, 9500);
  await assert.rejects(resolveModelContext({ model: "custom" }, { signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(isContextWindowError(new Error("This model's maximum context length is 8192 tokens")), true);
  assert.equal(isContextWindowError({ code: "context_length_exceeded" }), true);
  assert.equal(isContextWindowError(new Error("prompt is too long: 8050 tokens > 8000 maximum")), true);
  assert.equal(isContextWindowError(new Error("413 Request Entity Too Large")), true);
  assert.equal(isContextWindowError({ status: 413 }), true);
  assert.equal(isContextWindowError(new Error("rate_limit_exceeded: too many tokens per minute")), false);
  assert.equal(isContextWindowError(new Error("HTTP 403 invalid API key")), false);
});

import assert from "node:assert/strict";
import { normalizeSettings } from "../lib/storage.js";
import {
  addProviderModel,
  enabledModelOptions,
  hydrateTextCatalog,
  mergeScannedModels,
  modelsUrl,
  parseRemoteModelList,
  pickDefaultRef,
  providerFromLegacyText,
  invertProviderModelsEnabled,
  setAllProviderModelsEnabled,
  setProviderModelEnabled,
  suggestProviderName,
} from "../lib/text-providers.js";

assert.equal(modelsUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/models");
assert.equal(modelsUrl("https://api.openai.com/v1/models"), "https://api.openai.com/v1/models");
assert.equal(suggestProviderName("https://openrouter.ai/api/v1"), "Openrouter");
assert.equal(suggestProviderName("http://127.0.0.1:11434/v1"), "本地服务");

assert.deepEqual(
  parseRemoteModelList({ data: [{ id: "gpt-4o-mini", owned_by: "openai" }, { id: "gpt-4o-mini" }, "claude"] }),
  [{ id: "gpt-4o-mini", ownedBy: "openai" }, { id: "claude" }],
);
assert.deepEqual(parseRemoteModelList({ models: ["a", "b"] }), [{ id: "a" }, { id: "b" }]);

const merged = mergeScannedModels(
  [{ id: "keep", enabled: false, ownedBy: "old" }, { id: "gone", enabled: true }],
  [{ id: "keep", ownedBy: "new" }, { id: "fresh" }],
);
assert.equal(merged[0].id, "keep");
assert.equal(merged[0].enabled, false);
assert.equal(merged[0].ownedBy, "new");
assert.equal(merged[1].id, "fresh");
assert.equal(merged[1].enabled, true);
assert.equal(merged[2].id, "gone");

const legacy = providerFromLegacyText({
  preset: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "sk-test",
  model: "gpt-4o-mini",
});
assert.equal(legacy.models[0].id, "gpt-4o-mini");
assert.equal(legacy.models[0].enabled, true);

const migrated = hydrateTextCatalog({}, {
  preset: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-x",
  model: "gpt-4o-mini",
  summaryInputTokens: 8000,
});
assert.equal(migrated.textProviders.length, 1);
assert.equal(migrated.textRef.modelId, "gpt-4o-mini");
assert.equal(migrated.text.model, "gpt-4o-mini");
assert.equal(migrated.text.apiKey, "sk-x");
assert.equal(migrated.text.summaryInputTokens, 8000);

const two = [
  { id: "p1", name: "A", preset: "custom", baseUrl: "https://a.example/v1", apiKey: "1", models: [{ id: "m1", enabled: true }, { id: "m2", enabled: false }] },
  { id: "p2", name: "B", preset: "custom", baseUrl: "https://b.example/v1", apiKey: "2", models: [{ id: "n1", enabled: true }] },
];
assert.deepEqual(enabledModelOptions(two).map((o) => o.modelId), ["m1", "n1"]);
assert.deepEqual(pickDefaultRef(two, { providerId: "p2", modelId: "n1" }), { providerId: "p2", modelId: "n1" });
assert.deepEqual(pickDefaultRef(two, { providerId: "p1", modelId: "m2" }), { providerId: "p1", modelId: "m1" });

const toggled = setProviderModelEnabled(two[0], "m2", true);
assert.equal(toggled.models[1].enabled, true);
const allOn = setAllProviderModelsEnabled(two[0], true);
assert.ok(allOn.models.every((m) => m.enabled), "select all");
const inverted = invertProviderModelsEnabled(allOn);
assert.ok(inverted.models.every((m) => !m.enabled), "invert all");
const partial = setAllProviderModelsEnabled(two[0], true, ["m2"]);
assert.equal(partial.models[0].enabled, true);
assert.equal(partial.models[1].enabled, true);
const added = addProviderModel(two[0], "m3");
assert.equal(added.models.at(-1).id, "m3");
assert.equal(added.models.at(-1).enabled, true);

const saved = normalizeSettings({
  text: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "sk-d" },
});
assert.equal(saved.textProviders.length, 1);
assert.equal(saved.text.model, "deepseek-chat");
assert.equal(saved.textRef.modelId, "deepseek-chat");

const empty = normalizeSettings({});
assert.equal(empty.textProviders.length, 0);
assert.equal(empty.textRef, null);

console.log("PASS text-providers");

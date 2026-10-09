import assert from "node:assert";
import { defaultSettings, normalizeSettings } from "../lib/storage.js";
import {
  AGENT_SETTINGS_SCHEMA,
  createSettingsTools,
  isSensitiveSetting,
  maskSecret,
  planSettingsChange,
  redactSettingsArgs,
} from "../lib/agent/settings-tools.js";
import { createAgentTools, resolveActiveTools, checkHitlRequirement } from "../lib/agent/tools.js";
import { systemPrompt } from "../lib/prompts.js";

const SECRET = "sk-test-abcdefghijklmnop1234";

function makeStore(overrides = {}) {
  let stored = normalizeSettings({
    ...defaultSettings(),
    hitlMode: "autonomous",
    multimodal: { preset: "custom", baseUrl: "https://api.example.com/v1", model: "vl", apiKey: SECRET },
    textProviders: [
      { id: "p1", name: "One", baseUrl: "https://one.example/v1", apiKey: "k1", models: [{ id: "m-a", enabled: true }, { id: "m-b", enabled: true }] },
    ],
    textRef: { providerId: "p1", modelId: "m-a" },
    ...overrides,
  });
  const calls = { saves: 0, confirms: [], changed: [] };
  return {
    calls,
    get stored() {
      return stored;
    },
    set stored(v) {
      stored = v;
    },
    ctx(decide = () => ({ allow: true })) {
      return {
        loadSettings: async () => structuredClone(stored),
        saveSettings: async (next) => {
          calls.saves++;
          stored = normalizeSettings(next);
          return stored;
        },
        confirmSettingsChange: async (req) => {
          calls.confirms.push(req);
          return decide(req);
        },
        onSettingsChanged: (saved) => calls.changed.push(saved),
      };
    },
  };
}

const tool = (tools, name) => tools.find((t) => t.name === name);

// Schema: safety settings are flagged; secrets are masked.
for (const key of ["hitlMode", "hitlTimeoutSeconds", "nativeShell", "cdpInput", "agentInboxEnabled", "agentBridgeEnabled", "agentBridgeOrigins", "asr.apiKey", "jev.baseUrl", "langfuse.secretKey", "langfuse.enabled"]) {
  assert(isSensitiveSetting(key), `${key} must be sensitive`);
}
assert(!isSensitiveSetting("uiTheme"), "uiTheme is not sensitive");
assert(isSensitiveSetting("someFutureApiKey"), "unknown key-like names are flagged by pattern");
for (const f of AGENT_SETTINGS_SCHEMA.filter((f) => /apiKey|Key$/.test(f.key))) {
  assert(f.secret, `${f.key} is secret`);
}
assert.equal(maskSecret(""), "（未设置）");
assert(!maskSecret(SECRET).includes(SECRET.slice(0, 10)), "mask hides the key body");

// Inbox: opt-in goes through a sensitive confirmation and survives the storage migration; the version marker is not writable.
{
  const store = makeStore();
  const t = tool(createSettingsTools(store.ctx()), "update_settings");
  assert.equal(store.stored.agentInboxEnabled, false, "inbox is off by default");
  let out = await t.execute({ changes: [{ key: "agentInboxVersion", value: 0 }] });
  assert(/未修改/.test(out) && store.calls.confirms.length === 0, "agentInboxVersion is not agent-writable");
  out = await t.execute({ changes: [{ key: "agentInboxEnabled", value: true }] });
  assert.equal(store.calls.confirms.length, 1, "enabling inbox asks the user");
  assert(store.calls.confirms[0].sensitive, "inbox toggle is confirmed as sensitive");
  assert.equal(store.stored.agentInboxEnabled, true, "confirmed inbox opt-in is saved");
}

// get_settings never echoes full keys.
{
  const store = makeStore();
  const out = await tool(createSettingsTools(store.ctx()), "get_settings").execute({});
  assert(!out.includes(SECRET), "get_settings must not leak the API key");
  assert(!out.includes('"k1"'), "provider key not listed");
  const data = JSON.parse(out);
  assert(data.settings.find((s) => s.key === "uiTheme").allowed.includes("cyber"));
  assert(data.textModels.some((m) => m.startsWith("p1::m-b")));
}

// Validation: unknown keys, bad values, and no-op changes never reach the dialog.
{
  const store = makeStore();
  const t = tool(createSettingsTools(store.ctx()), "update_settings");
  let out = await t.execute({ changes: [{ key: "settings", value: {} }] });
  assert(/未修改/.test(out) && store.calls.confirms.length === 0, "unknown key rejected");
  out = await t.execute({ changes: [{ key: "uiTheme", value: "neon" }] });
  assert(/只能是/.test(out), "invalid enum rejected");
  out = await t.execute({ changes: [{ key: "hitlTimeoutSeconds", value: 1 }] });
  assert(/范围/.test(out), "out-of-range rejected");
  out = await t.execute({ changes: [{ key: "asr.baseUrl", value: "javascript:alert(1)" }] });
  assert(/http/.test(out), "non-http url rejected");
  out = await t.execute({ changes: [{ key: "jev.baseUrl", value: "https://u:p@evil.example" }] });
  assert(/用户名或密码/.test(out), "credentials in url rejected");
  out = await t.execute({ changes: [{ key: "agentBridgeOrigins", value: ["evil"] }] });
  assert(/无效的 origin/.test(out), "bad origin rejected");
  out = await t.execute({ changes: [{ key: "uiTheme", value: "cyber" }, { key: "uiFont", value: "huge" }] });
  assert(/未修改/.test(out) && store.stored.uiTheme === "default", "batch is atomic");
  out = await t.execute({ changes: [{ key: "uiTheme", value: "default" }] });
  assert(/无需修改/.test(out), "no-op detected");
  assert.equal(store.calls.confirms.length, 0);
  assert.equal(store.calls.saves, 0);
}

// Without a confirmation UI the tool refuses (e.g. headless callers).
{
  const store = makeStore();
  const ctx = store.ctx();
  delete ctx.confirmSettingsChange;
  const out = await tool(createSettingsTools(ctx), "update_settings").execute({ changes: [{ key: "uiTheme", value: "cyber" }] });
  assert(/无法弹出确认/.test(out));
  assert.equal(store.calls.saves, 0);
}

// Rejection keeps settings untouched.
{
  const store = makeStore();
  const t = tool(createSettingsTools(store.ctx(() => ({ allow: false, reason: "用户拒绝" }))), "update_settings");
  const out = await t.execute({ changes: [{ key: "nativeShell", value: false }] });
  assert(/未确认/.test(out));
  assert.equal(store.calls.saves, 0);
  assert.equal(store.stored.nativeShell, true);
}

// Confirmation is shown even in autonomous mode, with a masked before/after diff.
{
  const store = makeStore();
  assert.equal(store.stored.hitlMode, "autonomous");
  assert.equal(checkHitlRequirement({ toolName: "update_settings", hitlMode: "autonomous" }).needsConfirmation, false);
  const t = tool(createSettingsTools(store.ctx()), "update_settings");
  const NEW = "sk-new-zyxwvutsrqponm9876";
  const out = await t.execute({
    changes: [
      { key: "uiTheme", value: "Cyber" },
      { key: "hitlMode", value: "strict" },
      { key: "multimodal.apiKey", value: NEW },
      { key: "textModel", value: "m-b" },
    ],
    reason: "用户要求",
  });
  assert.equal(store.calls.confirms.length, 1, "always asks the human");
  const req = store.calls.confirms[0];
  assert(req.sensitive, "sensitive change flagged");
  const theme = req.diff.find((d) => d.key === "uiTheme");
  assert.deepEqual([theme.before, theme.after, theme.sensitive], ["default", "cyber", false]);
  const hitl = req.diff.find((d) => d.key === "hitlMode");
  assert.deepEqual([hitl.before, hitl.after, hitl.sensitive], ["autonomous", "strict", true]);
  assert(req.text.includes("之前：autonomous") && req.text.includes("之后：strict"));
  for (const blob of [JSON.stringify(req), out]) {
    assert(!blob.includes(SECRET) && !blob.includes(NEW), "keys never echoed");
  }
  assert(!req.diff.some((d) => "value" in d), "raw values are not passed to the dialog");
  assert.equal(store.stored.uiTheme, "cyber");
  assert.equal(store.stored.hitlMode, "strict");
  assert.equal(store.stored.multimodal.apiKey, NEW);
  assert.deepEqual(store.stored.textRef, { providerId: "p1", modelId: "m-b" });
  assert.equal(store.stored.text.model, "m-b", "active text slot follows textRef");
  assert.equal(store.calls.changed.length, 1, "UI notified for live apply");
  assert(/已保存并生效/.test(out));
}

// Edits made while the dialog was open are preserved.
{
  const store = makeStore();
  const t = tool(
    createSettingsTools(
      store.ctx(() => {
        store.stored = normalizeSettings({ ...store.stored, uiFont: "xl" });
        return { allow: true };
      }),
    ),
    "update_settings",
  );
  await t.execute({ changes: [{ key: "answerLanguage", value: "en" }] });
  assert.equal(store.stored.answerLanguage, "en");
  assert.equal(store.stored.uiFont, "xl");
}

// Tool-card args mask secrets.
{
  const shown = JSON.stringify(redactSettingsArgs({ changes: [{ key: "jev.apiKey", value: SECRET }, { key: "uiFont", value: "lg" }] }));
  assert(!shown.includes(SECRET) && shown.includes('"lg"'));
}

// planSettingsChange accepts an object map and normalizes origins.
{
  const plan = planSettingsChange(defaultSettings(), { agentBridgeOrigins: "https://a.example, http://localhost:*" });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.next.agentBridgeOrigins, ["https://a.example", "http://localhost:*"]);
}

// Wired into the agent: registered, routed by intent, advertised in the system prompt.
{
  const all = createAgentTools({ getTabId: () => 1, getWindowId: () => 1, settings: {} });
  assert(tool(all, "get_settings") && tool(all, "update_settings"));
  const names = resolveActiveTools({ userText: "把主题改成 cyber，字体调大", tools: all }).map((t) => t.name);
  assert(names.includes("update_settings") && names.includes("get_settings"));
  const reader = resolveActiveTools({ userText: "总结一下这篇文章", tools: all }).map((t) => t.name);
  assert(!reader.includes("update_settings"), "not mounted for plain reading");
  const meta = tool(all, "request_toolsets");
  assert(meta.parameters.properties.toolsets.items.enum.includes("settings"));
  assert(/update_settings/.test(systemPrompt(defaultSettings())));
}

console.log("test_settings_tools: ok");

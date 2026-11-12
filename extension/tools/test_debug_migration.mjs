import assert from "node:assert/strict";
import {
  DEBUG_SCHEMA_VERSION,
  migrateLegacyDebugSettings,
} from "../lib/debug/policy.js";
import {
  compactStoredTraceLog,
  normalizeMessage,
  sessionsToJSON,
} from "../lib/sessions.js";

function makeMigrationEnv({ installType = "normal", localInit = {}, sessionInit = {}, initialAlarms = [] } = {}) {
  const localBag = structuredClone(localInit);
  const sessionBag = structuredClone(sessionInit);
  const alarmsSet = new Set(initialAlarms);

  const chromeRef = {
    localBag,
    sessionBag,
    alarmsSet,
    management: { getSelf: async () => ({ installType }) },
    runtime: { getManifest: () => ({ version: "0.12.1" }) },
    storage: {
      local: {
        get: async (keys) => {
          if (keys == null) return structuredClone(localBag);
          if (typeof keys === "string") return keys in localBag ? { [keys]: structuredClone(localBag[keys]) } : {};
          const out = {};
          for (const k of keys) if (k in localBag) out[k] = structuredClone(localBag[k]);
          return out;
        },
        set: async (patch) => {
          for (const [k, v] of Object.entries(patch)) localBag[k] = structuredClone(v);
        },
        remove: async (keys) => {
          for (const k of [].concat(keys)) delete localBag[k];
        },
      },
      session: {
        remove: async (keys) => {
          for (const k of [].concat(keys)) delete sessionBag[k];
        },
      },
    },
    alarms: {
      clear: async (name) => alarmsSet.delete(name),
    },
  };
  return chromeRef;
}

// 1. development 解包环境迁移：保留开发者旧键开启态到 settings.debug，清理根级冗余键，二次调用幂等
{
  const devChrome = makeMigrationEnv({
    installType: "development",
    localInit: {
      devAutoReloadEnabled: true,
      autoExportRunBundle: false,
      settings: {
        uiTheme: "cyber",
        dev: { autoReload: true },
        diagnostics: { autoExportRunBundle: true },
      },
    },
  });

  const first = await migrateLegacyDebugSettings({ chromeRef: devChrome });
  assert.equal(first.migrated, true);
  assert.equal(first.installType, "development");
  assert.equal(devChrome.localBag.devAutoReloadEnabled, undefined, "legacy root devAutoReloadEnabled removed");
  assert.equal(devChrome.localBag.autoExportRunBundle, undefined, "legacy root autoExportRunBundle removed");

  const saved = devChrome.localBag.settings;
  assert.equal(saved.debugSchemaVersion, DEBUG_SCHEMA_VERSION);
  assert.equal(saved.dev, undefined);
  assert.equal(saved.diagnostics, undefined);
  assert.equal(saved.debug.enabled, true);
  assert.equal(saved.debug.traceLevel, "full");
  assert.equal(saved.debug.devAutoReload, true);
  assert.equal(saved.debug.writeStartupReceipt, true);
  assert.equal(saved.debug.autoExportRunBundle, true);

  // 再次执行幂等（不再重复写盘）
  const second = await migrateLegacyDebugSettings({ chromeRef: devChrome });
  assert.equal(second.migrated, false);
  console.log("PASS 1: development install smoothly migrates legacy opt-in flags and cleans up root keys idempotently");
}

// 2. normal 正式安装环境迁移：强制关闭 debug 与 langfuse，清理残留热重载闹钟与 pl.debug.log 会话内存
{
  const normalChrome = makeMigrationEnv({
    installType: "normal",
    localInit: {
      devAutoReloadEnabled: true,
      autoExportRunBundle: true,
      settings: {
        dev: { autoReload: true },
        diagnostics: { autoExportRunBundle: true },
        langfuse: {
          enabled: true,
          baseUrl: "https://lf.example.com",
          publicKey: "pk-lf-old",
          secretKey: "sk-lf-old",
        },
      },
    },
    sessionInit: {
      "pl.debug.log": { entries: [{ event: "stale" }] },
    },
    initialAlarms: ["pagelens-dev-reload"],
  });

  const res = await migrateLegacyDebugSettings({ chromeRef: normalChrome });
  assert.equal(res.migrated, true);
  assert.equal(res.installType, "normal");
  assert.equal(normalChrome.localBag.devAutoReloadEnabled, undefined);
  assert.equal(normalChrome.localBag.autoExportRunBundle, undefined);

  const saved = normalChrome.localBag.settings;
  assert.equal(saved.debug.enabled, false, "normal install resets debug.enabled to false");
  assert.equal(saved.debug.traceLevel, "minimal");
  assert.equal(saved.debug.devAutoReload, false);
  assert.equal(saved.debug.autoExportRunBundle, false);
  assert.equal(saved.langfuse.enabled, false, "normal install disables accidental background Langfuse export");
  assert.equal(normalChrome.alarmsSet.has("pagelens-dev-reload"), false, "residual dev-reload alarm cleared");
  assert.equal(normalChrome.sessionBag["pl.debug.log"], undefined, "residual session debug log cleared");
  console.log("PASS 2: normal install forces debug OFF and purges residual alarms & session logs");
}

// 3. IndexedDB 历史会话瘦身迁移与用户对话导出剥离 traceLog
{
  const inlineShot = `data:image/png;base64,${"B".repeat(20_000)}`;
  const bloatedLegacyMsg = {
    role: "bot",
    text: "历史回复",
    traceLog: {
      version: "2.0",
      runId: "run_legacy_bloated",
      status: "done",
      durationMs: 1234,
      systemPrompt: "S".repeat(30_000),
      conversationMessages: Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        content: "M".repeat(10_000),
      })),
      conversationContext: { fullHistory: ["H".repeat(10_000)] },
      steps: [
        {
          type: "model_turn",
          turn: 1,
          messages: [{ role: "user", content: "X".repeat(10_000) }],
          messagesDelta: [{ role: "user", content: "Y".repeat(10_000) }],
          tools: [{ name: "extract_page" }],
        },
        {
          type: "tool_exec",
          turn: 1,
          toolName: "screenshot",
          ok: true,
          screenshotDataUrl: inlineShot,
          archivedContent: "A".repeat(24_000),
          resultSummary: ` captured ${inlineShot} `,
        },
      ],
      toolSteps: [
        {
          toolName: "screenshot",
          ok: true,
          screenshotArtifact: inlineShot,
        },
        {
          toolName: "click",
          ok: true,
          screenshotArtifact: "pagelens-runs/pagelens-artifact-1.png",
        },
      ],
    },
  };

  const rawSize = JSON.stringify(bloatedLegacyMsg.traceLog).length;
  const compacted = compactStoredTraceLog(bloatedLegacyMsg.traceLog);
  const compactSize = JSON.stringify(compacted).length;

  assert.ok(compactSize < rawSize * 0.05, `compacted traceLog shrunk from ${rawSize}B to ${compactSize}B (>95% reduction)`);
  assert.equal(compacted.runId, "run_legacy_bloated");
  assert.equal(compacted.conversationMessages, undefined);
  assert.equal(compacted.conversationContext, undefined);
  assert.equal(compacted.systemPrompt, undefined);
  assert.equal(compacted.steps[0].messages, undefined);
  assert.equal(compacted.steps[0].messagesDelta, undefined);
  assert.equal(compacted.steps[1].screenshotDataUrl, undefined);
  assert.equal(compacted.steps[1].archivedContent, undefined);
  assert.ok(!JSON.stringify(compacted).includes("BBBBBBBBBB"), "all inline base64 images scrubbed");
  assert.equal(compacted.toolSteps[0].screenshotArtifact, undefined, "inline base64 artifact dropped");
  assert.equal(compacted.toolSteps[1].screenshotArtifact, "pagelens-runs/pagelens-artifact-1.png", "file path reference kept");

  const normalizedMsg = normalizeMessage(bloatedLegacyMsg);
  assert.equal(normalizedMsg.traceLog.conversationMessages, undefined);

  // 用户手动导出聊天 JSON 时完全剔除内部 traceLog
  const exportedChatJson = sessionsToJSON([
    {
      id: "sess_export_1",
      title: "测试导出",
      createdAt: 1700000000000,
      updatedAt: 1700000001000,
      messages: [
        { role: "user", text: "你好" },
        normalizedMsg,
      ],
    },
  ]);
  const parsedExport = JSON.parse(exportedChatJson);
  assert.equal(parsedExport.sessions[0].messages[1].traceLog, undefined, "sessionsToJSON strips internal traceLog");
  console.log("PASS 3: legacy bloated session traceLog shrunk >95% and stripped from user chat JSON exports");
}

console.log("ALL PASS test_debug_migration.mjs");

/**
 * 调试能力按需动态加载编排器（SW 与侧栏共用）。
 *
 * 核心保证：
 * - L0 默认态（settings.debug.enabled === false）：绝不动态加载 reload-dev.js / run-recorder.js / langfuse-exporter.js，
 *   零热重载闹钟、零文件探测、零自动下载、零远程上报。
 * - L1 手动诊断态（traceLevel === "manual"）：仅在内存维护最近 3 轮严格脱敏运行摘要，支持零权限 <a download> 导出。
 * - L2 全量调试态（traceLevel === "full"）：按需动态 import("./run-recorder.js") 与 ("./langfuse-exporter.js")。
 */

import {
  detectInstallType,
  isProdBuild,
  migrateLegacyDebugSettings,
  requestLangfuseHostPermission,
  resolveDebugPolicy,
} from "./policy.js";
import {
  configureDebugLog,
  debugLog,
  exportDebugLogFresh,
  exportL1DiagnosticBundle,
  recordL1RunSummary,
} from "./ring-log.js";
import { sanitizePayload, sanitizeString } from "./sanitizer.js";
import {
  classifyToolOutcome,
  createRunId,
  downloadViaAnchor,
  formatTimestampForFilename,
  stripAttachedPageContext,
} from "./trace-utils.js";

const __PL_PROD_BUILD__ = false;

const swWiredChromeRefs = new WeakSet();
const swReloadControllers = new WeakMap();
const registeredSwModules = {
  reloadDev: null,
  runRecorder: null,
  langfuseExporter: null,
};

export function registerSwDebugModules(mods = {}) {
  if (mods.reloadDev) registeredSwModules.reloadDev = mods.reloadDev;
  if (mods.runRecorder) registeredSwModules.runRecorder = mods.runRecorder;
  if (mods.langfuseExporter) registeredSwModules.langfuseExporter = mods.langfuseExporter;
}

async function loadReloadDevModule() {
  if (__PL_PROD_BUILD__) return null;
  if (registeredSwModules.reloadDev) return registeredSwModules.reloadDev;
  return import("./reload-dev.js");
}

async function loadRunRecorderModule() {
  if (registeredSwModules.runRecorder) return registeredSwModules.runRecorder;
  return import("./run-recorder.js");
}

async function loadLangfuseExporterModule() {
  if (registeredSwModules.langfuseExporter) return registeredSwModules.langfuseExporter;
  return import("./langfuse-exporter.js");
}

function deriveRunStatus(explicitStatus, endReason, hasError) {
  if (explicitStatus) return String(explicitStatus);
  if (endReason === "abort") return "cancelled";
  if (endReason === "needs_approval") return "needs_approval";
  if (endReason === "error" || hasError) return "failed";
  return "done";
}

function buildLightweightRunSummary(runInput = {}, { version = "2.0-minimal" } = {}) {
  const endedAtMs = runInput.endedAt ? new Date(runInput.endedAt).getTime() || Date.now() : Date.now();
  const startedAtMs = runInput.startedAt
    ? new Date(runInput.startedAt).getTime() || endedAtMs
    : Math.max(0, endedAtMs - (Number(runInput.durationMs || runInput.metrics?.durationMs) || 0));
  const durationMs = Math.max(
    0,
    Number(runInput.durationMs ?? runInput.metrics?.durationMs ?? endedAtMs - startedAtMs) || 0,
  );
  const endReason = String(
    runInput.endReason || runInput.metrics?.finishReason || (runInput.error ? "error" : "stop"),
  );
  const status = deriveRunStatus(runInput.status, endReason, Boolean(runInput.error));
  const inputTokens = Math.max(0, Number(runInput.metrics?.inputTokens) || 0);
  const outputTokens = Math.max(0, Number(runInput.metrics?.outputTokens) || 0);
  const totalTokens = Math.max(
    0,
    Number(runInput.metrics?.totalTokens) || inputTokens + outputTokens,
  );
  const { cleanPrompt, strippedChars } = stripAttachedPageContext(String(runInput.userPrompt ?? ""));
  const modelName = String(
    (typeof runInput.model === "object" ? runInput.model?.model : runInput.model) || "unknown",
  );

  return {
    version,
    runId: String(runInput.runId || createRunId("run")),
    source: runInput.source === "sw-delegate" ? "sw-delegate" : "sidepanel",
    taskId: runInput.taskId ? String(runInput.taskId) : null,
    sessionId: String(runInput.sessionId || "default"),
    timestamp: new Date(endedAtMs).toISOString(),
    status,
    endReason,
    model: modelName,
    durationMs,
    metrics: {
      durationMs,
      inputTokens,
      outputTokens,
      totalTokens,
      finishReason: String(runInput.metrics?.finishReason || endReason),
    },
    userPrompt: sanitizeString(cleanPrompt, { profile: "strict", maxChars: 500, maskPii: true }),
    attachedContextChars: Math.max(0, Number(runInput.attachedContextChars) || strippedChars || 0),
  };
}

function summarizeStepsForL1(steps = []) {
  const out = [];
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || (s.type !== "tool_exec" && s.type !== "tool_intercepted")) continue;
    const toolName = String(s.toolName || s.name || "unknown");
    const wasIntercepted = s.type === "tool_intercepted";
    const outcome = classifyToolOutcome(
      toolName,
      s.resultSummary ?? s.result ?? s.reason ?? "",
      s.jsOk !== undefined ? Boolean(s.jsOk) : s.ok !== false,
      wasIntercepted,
    );
    out.push({
      toolName,
      ok: outcome.ok,
      jsOk: outcome.jsOk,
      durationMs: Math.max(0, Number(s.durationMs) || 0),
      failureReason: outcome.ok
        ? null
        : sanitizeString(outcome.failureReason || "tool_failed", {
            profile: "strict",
            maxChars: 160,
            maskPii: true,
          }),
    });
    if (out.length >= 25) break;
  }
  return out;
}

export async function syncSwDebugRuntime({
  chromeRef = globalThis.chrome,
  fetchImpl = globalThis.fetch,
  settings = null,
} = {}) {
  const policy = await resolveDebugPolicy({ settings, chromeRef });
  configureDebugLog({
    enabled: policy.enabled,
    traceLevel: policy.traceLevel,
    chromeRef,
  });

  if (!__PL_PROD_BUILD__ && !isProdBuild()) {
    if (policy.canUseDevReload) {
      try {
        const reloadMod = await loadReloadDevModule();
        let ctrl = chromeRef ? swReloadControllers.get(chromeRef) : null;
        if (!ctrl) {
          ctrl =
            chromeRef === globalThis.chrome && fetchImpl === globalThis.fetch && typeof reloadMod.installDevAutoReload === "function"
              ? reloadMod.installDevAutoReload()
              : reloadMod.createDevReloadController({ chromeRef, fetchImpl });
          if (chromeRef && typeof chromeRef === "object") {
            swReloadControllers.set(chromeRef, ctrl);
          }
        }
        ctrl.wire();
        await ctrl.init();
        await ctrl.syncAlarm();
      } catch {
        /* debug reload must never break SW startup */
      }
    } else {
      try {
        await chromeRef?.alarms?.clear?.("pagelens-dev-reload");
      } catch {
        /* ignore */
      }
    }
  }

  return policy;
}

export async function initSwDebugRuntime({
  chromeRef = globalThis.chrome,
  fetchImpl = globalThis.fetch,
  applyLocalSettingsFn = null,
} = {}) {
  await migrateLegacyDebugSettings({ chromeRef });
  const installType = await detectInstallType({ chromeRef });

  if (!__PL_PROD_BUILD__ && !isProdBuild() && installType === "development") {
    if (typeof applyLocalSettingsFn === "function") {
      await applyLocalSettingsFn().catch(() => {});
    }
  }

  if (
    chromeRef &&
    typeof chromeRef === "object" &&
    !swWiredChromeRefs.has(chromeRef) &&
    typeof chromeRef?.storage?.onChanged?.addListener === "function"
  ) {
    swWiredChromeRefs.add(chromeRef);
    chromeRef.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      const bag = changes || {};
      if (!("settings" in bag) && !("devAutoReloadEnabled" in bag)) return;
      syncSwDebugRuntime({ chromeRef, fetchImpl }).catch(() => {});
    });
  }

  return syncSwDebugRuntime({ chromeRef, fetchImpl });
}

export async function syncSidepanelDebugRuntime({
  settings = null,
  chromeRef = globalThis.chrome,
} = {}) {
  const policy = await resolveDebugPolicy({ settings, chromeRef });
  configureDebugLog({
    enabled: policy.enabled,
    traceLevel: policy.traceLevel,
    chromeRef,
  });
  return policy;
}

/**
 * Agent 运行结束统一观测入口（侧栏与 SW Delegate 共用）。
 * - L0 (minimal): 零动态模块加载，仅返回轻量元数据，零磁盘/会话存储副作用。
 * - L1 (manual): 零动态模块加载，写入最近 3 轮严格脱敏内存摘要。
 * - L2 (full): 按需动态 import("./run-recorder.js") 构建全量 Trace 并在授权时落盘，按需上报 Langfuse。
 */
export async function onAgentRunCompleted(
  runInput = {},
  {
    chromeRef = globalThis.chrome,
    fetchImpl = globalThis.fetch,
    exportDebugFn = exportDebugLogFresh,
    logDebug = debugLog,
  } = {},
) {
  const settings = runInput.settings || null;
  const policy = await resolveDebugPolicy({ settings, chromeRef });

  if (!policy.enabled) {
    const traceLog = buildLightweightRunSummary(runInput, { version: "2.0-minimal" });
    return {
      ok: true,
      exported: false,
      traceLevel: "minimal",
      traceLog,
      persisted: null,
    };
  }

  if (policy.traceLevel === "manual") {
    const traceLog = buildLightweightRunSummary(runInput, { version: "2.0-manual" });
    recordL1RunSummary({
      runId: traceLog.runId,
      source: traceLog.source,
      status: traceLog.status,
      endReason: traceLog.endReason,
      model: traceLog.model,
      durationMs: traceLog.durationMs,
      metrics: traceLog.metrics,
      userPrompt: traceLog.userPrompt,
      error: runInput.error || null,
      toolSteps: summarizeStepsForL1(runInput.steps),
    });
    return {
      ok: true,
      exported: false,
      traceLevel: "manual",
      traceLog,
      persisted: null,
    };
  }

  // L2: traceLevel === "full" -> 按需动态加载重型录制模块（SW 走已注册模块）
  const recorderMod = await loadRunRecorderModule();
  const persisted = await recorderMod.persistRunBundle(runInput, {
    chromeRef,
    fetchImpl,
    exportDebugFn,
    logDebug,
    autoExport: policy.autoExportRunBundle,
  });

  const traceRecord =
    persisted?.traceRecord || buildLightweightRunSummary(runInput, { version: "2.0" });

  let langfuseResult = null;
  if (policy.langfuseEnabled && settings?.langfuse) {
    try {
      const lfMod = await loadLangfuseExporterModule();
      if (lfMod.isLangfuseConfigured(settings.langfuse)) {
        langfuseResult = await lfMod.sendTraceToLangfuse(
          {
            ...traceRecord,
            sessionTitle: runInput.sessionTitle,
            page: traceRecord.finalPage || traceRecord.initialPage || null,
          },
          settings.langfuse,
          {
            chromeRef,
            fetchImpl,
            release: traceRecord.extensionVersion || "0.0.0",
          },
        );
      }
    } catch (err) {
      logDebug("langfuse.hook_error", { error: err?.message || String(err) });
    }
  }

  return {
    ok: Boolean(persisted?.ok),
    exported: Boolean(persisted?.exported),
    traceLevel: "full",
    traceLog: traceRecord,
    persisted,
    langfuseResult,
  };
}

export function exportManualDiagnosticL1({
  extensionVersion = "0.0.0",
  sessionMeta = null,
} = {}) {
  const jsonText = exportL1DiagnosticBundle({ extensionVersion, sessionMeta });
  const ts = formatTimestampForFilename(Date.now());
  const filename = `pagelens-diagnostic-l1-${ts}.json`;
  const downloaded = downloadViaAnchor(filename, jsonText, "application/json;charset=utf-8");
  return { ok: downloaded, filename, jsonText };
}

export async function exportManualDebugLogFile({ chromeRef = globalThis.chrome } = {}) {
  const jsonText = await exportDebugLogFresh({ chromeRef });
  const ts = formatTimestampForFilename(Date.now());
  const filename = `pagelens-debug-${ts}.json`;
  const downloaded = downloadViaAnchor(filename, jsonText, "application/json;charset=utf-8");
  return { ok: downloaded, filename, jsonText };
}

export async function exportManualMessageTrace(
  msg,
  {
    settings = null,
    sessionId = "unknown",
    chromeRef = globalThis.chrome,
  } = {},
) {
  if (!msg?.traceLog) return { ok: false, reason: "no_trace" };
  const policy = await resolveDebugPolicy({ settings, chromeRef });
  const payload =
    policy.enabled && policy.traceLevel === "full"
      ? sanitizePayload(msg.traceLog, { profile: "loop", maxDepth: 16, maxChars: 0, maskPii: false })
      : sanitizePayload(msg.traceLog, { profile: "strict", maxDepth: 8, maxChars: 1000, maskPii: true });
  const jsonText = JSON.stringify(payload, null, 2);
  const ts = formatTimestampForFilename(Date.now());
  const safeSid = String(sessionId || "unknown").slice(0, 8);
  const filename = `pagelens-trace-${safeSid}-${ts}.json`;
  const downloaded = downloadViaAnchor(filename, jsonText, "application/json;charset=utf-8");
  return { ok: downloaded, filename };
}

export async function testLangfuseInDebugMode(
  langfuseConfig,
  {
    chromeRef = globalThis.chrome,
    fetchImpl = globalThis.fetch,
    requestPermission = true,
  } = {},
) {
  if (requestPermission && langfuseConfig?.baseUrl) {
    const grant = await requestLangfuseHostPermission(langfuseConfig.baseUrl, { chromeRef });
    if (!grant.granted) {
      return { ok: false, message: grant.message || "未授予 Langfuse 服务网络访问权限" };
    }
  }
  const lfMod = await loadLangfuseExporterModule();
  return lfMod.testLangfuseConnection(langfuseConfig, { chromeRef, fetchImpl });
}

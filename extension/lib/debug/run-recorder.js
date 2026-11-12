/**
 * L2 调试模式全量 Trace 构建与成对落盘模块（按需动态加载，默认态 L0 不加载本模块）。
 *
 * 关键不变量：
 * 1. 默认态（L0）绝不静态 import 本模块；工具层纯函数已下沉至 ./trace-utils.js。
 * 2. 自动落盘（persistRunBundle）严格校验 settings.debug.enabled && settings.debug.autoExportRunBundle
 *    以及 chrome.permissions.contains({ permissions: ["downloads"] })；未获授权时绝不退化为隐藏 <a download> 弹窗。
 * 3. 本模块自身不包含 .dev-reload-stamp 或 local-settings.json 静态字符串，生产构建无死代码残留。
 */

import { debugLog, exportDebugLogFresh } from "./ring-log.js";
import {
  hasDownloadsPermission,
  isDevelopmentInstall,
  isProdBuild,
  normalizeDebugSettings,
} from "./policy.js";
import {
  SENSITIVE_KEY_LOOP_RE,
  isSensitiveFieldKey as isSanitizerSensitiveKey,
  sanitizeTraceString,
  sanitizeTraceValue,
} from "./sanitizer.js";
import {
  classifyToolOutcome,
  compactResultSummary,
  createRunId,
  downloadViaAnchor,
  encodeUtf8DataUrl,
  formatTimestampForFilename,
  stripAttachedPageContext,
  unwrapUntrustedOutput,
} from "./trace-utils.js";

const __PL_PROD_BUILD__ = false;

export const TRACE_SCHEMA_VERSION = "2.0";
export const RUN_OUTPUT_DIR = "pagelens-runs";
export const IMAGE_DETACH_THRESHOLD = 4096;
export const AUTO_EXPORT_RUN_BUNDLE_DEFAULT = false;
export const AUTO_EXPORT_RUN_BUNDLE_STORAGE_KEY = "autoExportRunBundle";
export const SENSITIVE_KEY_RE = SENSITIVE_KEY_LOOP_RE;

export {
  classifyToolOutcome,
  compactResultSummary,
  createRunId,
  encodeUtf8DataUrl,
  formatTimestampForFilename,
  sanitizeTraceString,
  sanitizeTraceValue,
  stripAttachedPageContext,
  unwrapUntrustedOutput,
};

export function isSensitiveFieldKey(key) {
  return isSanitizerSensitiveKey(key, { profile: "loop" });
}

const DATA_IMAGE_GLOBAL_RE = /data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)/gi;

function readManifestVersion(chromeRef = globalThis.chrome) {
  try {
    return String(chromeRef?.runtime?.getManifest?.()?.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

async function resolveRuntimeBuildInfo({ chromeRef = globalThis.chrome, fetchImpl = globalThis.fetch } = {}) {
  const extensionVersion = readManifestVersion(chromeRef);
  if (!__PL_PROD_BUILD__ && !isProdBuild() && (await isDevelopmentInstall({ chromeRef }))) {
    try {
      const reloadMod = await import("./reload-dev.js");
      return await reloadMod.resolveBuildInfo({ chromeRef, fetchImpl });
    } catch {
      return { extensionVersion, gitCommit: "dev-local", stampTimestamp: "" };
    }
  }
  return { extensionVersion, gitCommit: "release", stampTimestamp: "" };
}

export async function isAutoExportRunBundleEnabled({
  chromeRef = globalThis.chrome,
  settings = null,
  defaultEnabled = AUTO_EXPORT_RUN_BUNDLE_DEFAULT,
} = {}) {
  if (settings && typeof settings === "object") {
    if (settings.debug && typeof settings.debug === "object") {
      const d = normalizeDebugSettings(settings);
      return Boolean(d.enabled && d.autoExportRunBundle);
    }
    if (typeof settings?.diagnostics?.autoExportRunBundle === "boolean") {
      return settings.diagnostics.autoExportRunBundle;
    }
    if (typeof settings?.autoExportRunBundle === "boolean") {
      return settings.autoExportRunBundle;
    }
  }
  try {
    const data = await chromeRef?.storage?.local?.get?.([AUTO_EXPORT_RUN_BUNDLE_STORAGE_KEY, "settings"]);
    const storedSettings = data?.settings;
    if (storedSettings?.debug && typeof storedSettings.debug === "object") {
      const d = normalizeDebugSettings(storedSettings);
      return Boolean(d.enabled && d.autoExportRunBundle);
    }
    if (data && typeof data[AUTO_EXPORT_RUN_BUNDLE_STORAGE_KEY] === "boolean") {
      return data[AUTO_EXPORT_RUN_BUNDLE_STORAGE_KEY];
    }
    if (storedSettings && typeof storedSettings?.diagnostics?.autoExportRunBundle === "boolean") {
      return storedSettings.diagnostics.autoExportRunBundle;
    }
    if (storedSettings && typeof storedSettings?.autoExportRunBundle === "boolean") {
      return storedSettings.autoExportRunBundle;
    }
  } catch {
    /* ignore storage read errors */
  }
  return Boolean(defaultEnabled);
}

export async function setAutoExportRunBundleEnabled(
  enabled,
  { chromeRef = globalThis.chrome } = {},
) {
  const flag = Boolean(enabled);
  try {
    const local = chromeRef?.storage?.local;
    if (local?.get && local?.set) {
      const got = (await local.get("settings")) || {};
      const prevSettings = got.settings && typeof got.settings === "object" ? got.settings : {};
      const prevDebug = normalizeDebugSettings(prevSettings);
      await local.set({
        [AUTO_EXPORT_RUN_BUNDLE_STORAGE_KEY]: flag,
        settings: {
          ...prevSettings,
          debug: {
            ...prevDebug,
            enabled: flag ? true : prevDebug.enabled,
            traceLevel: flag ? "full" : prevDebug.traceLevel,
            autoExportRunBundle: flag,
          },
        },
      });
    }
  } catch {
    /* ignore storage write errors */
  }
  return flag;
}

function sanitizeFileSlug(value, fallback = "unknown") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || fallback;
}

function createImageDetacher({ tsSlug, safeSource, safeRunId, threshold = IMAGE_DETACH_THRESHOLD }) {
  const byDataUrl = new Map();
  const detachedImages = [];

  function replaceImagesInString(str) {
    if (typeof str !== "string" || str.length < threshold || !str.includes("data:image/")) {
      return str;
    }
    return str.replace(DATA_IMAGE_GLOBAL_RE, (fullMatch, rawExt, b64Body) => {
      if (fullMatch.length < threshold) return fullMatch;
      const existing = byDataUrl.get(fullMatch);
      if (existing) return `[artifact:${existing.filename}]`;

      const index = detachedImages.length + 1;
      const nn = String(index).padStart(2, "0");
      const sub = String(rawExt || "png").toLowerCase();
      const ext = sub === "jpeg" ? "jpg" : sub;
      const mimeType = sub === "jpg" ? "image/jpeg" : `image/${sub}`;
      const filename = `${RUN_OUTPUT_DIR}/pagelens-shot-${tsSlug}-${safeSource}-${safeRunId}-${nn}.${ext}`;
      const padding = b64Body.endsWith("==") ? 2 : b64Body.endsWith("=") ? 1 : 0;
      const byteLength = Math.max(0, Math.floor((b64Body.length * 3) / 4) - padding);
      const item = {
        index,
        kind: "screenshot",
        mimeType,
        filename,
        byteLength,
        dataUrl: fullMatch,
      };
      byDataUrl.set(fullMatch, item);
      detachedImages.push(item);
      return `[artifact:${filename}]`;
    });
  }

  function transform(value, key = "", depth = 0) {
    if (key && isSensitiveFieldKey(key)) return "[REDACTED]";
    if (depth > 16) return "[MaxDepth]";
    if (value == null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return String(value);
    if (typeof value === "string") {
      const detached = replaceImagesInString(value);
      return sanitizeTraceString(detached);
    }
    if (typeof value === "function") return undefined;
    if (value instanceof Error) {
      return {
        name: value.name || "Error",
        message: sanitizeTraceString(replaceImagesInString(value.message || String(value))),
      };
    }
    if (Array.isArray(value)) {
      return value.map((item) => transform(item, "", depth + 1));
    }
    if (typeof value === "object") {
      if (typeof value.key === "string" && "value" in value && isSensitiveFieldKey(value.key)) {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
          out[k] = k === "value" ? "[REDACTED]" : transform(v, k, depth + 1);
        }
        return out;
      }
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (typeof v === "function" || v === undefined) continue;
        out[k] = isSensitiveFieldKey(k) ? "[REDACTED]" : transform(v, k, depth + 1);
      }
      return out;
    }
    return sanitizeTraceString(String(value));
  }

  return {
    transform,
    detachedImages,
    publicArtifacts: () =>
      detachedImages.map(({ index, kind, mimeType, filename, byteLength }) => ({
        index,
        kind,
        mimeType,
        filename,
        byteLength,
      })),
  };
}

export function predictDetachedImagePaths(
  steps = [],
  { tsSlug, source = "sidepanel", runId = "run", threshold = IMAGE_DETACH_THRESHOLD } = {},
) {
  const resolvedSlug = tsSlug || formatTimestampForFilename(Date.now());
  const safeSource = sanitizeFileSlug(source === "sw-delegate" ? "sw-delegate" : "sidepanel", "sidepanel");
  const safeRunId = sanitizeFileSlug(runId, "run");
  const detacher = createImageDetacher({ tsSlug: resolvedSlug, safeSource, safeRunId, threshold });
  for (const s of Array.isArray(steps) ? steps : []) {
    detacher.transform(s);
  }
  return detacher.detachedImages.map((img) => img.filename);
}

function messageSignature(msg) {
  if (!msg || typeof msg !== "object") return String(msg);
  const role = String(msg.role || "");
  const tc = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((c) => `${c?.id || ""}:${c?.function?.name || c?.name || ""}`).join(",")
    : "";
  const tid = String(msg.tool_call_id || "");
  let contentSig = "";
  if (typeof msg.content === "string") {
    contentSig = `${msg.content.length}:${msg.content.slice(0, 120)}`;
  } else if (Array.isArray(msg.content)) {
    contentSig = msg.content
      .map((p) => (typeof p === "string" ? p.slice(0, 60) : `${p?.type || ""}:${String(p?.text || p?.image_url?.url || "").slice(0, 60)}`))
      .join("|");
  }
  return `${role}|${tid}|${tc}|${contentSig}`;
}

function computeMessagesDelta(prevMessages, currMessages) {
  const prev = Array.isArray(prevMessages) ? prevMessages : [];
  const curr = Array.isArray(currMessages) ? currMessages : [];
  let common = 0;
  const limit = Math.min(prev.length, curr.length);
  while (common < limit && messageSignature(prev[common]) === messageSignature(curr[common])) {
    common += 1;
  }
  return curr.slice(common);
}

function normalizePageSnapshot(page) {
  if (!page || typeof page !== "object") return null;
  const tabId = Number.isInteger(page.tabId) ? page.tabId : (Number.isInteger(page.id) ? page.id : null);
  const url = page.url != null ? String(page.url) : "";
  const title = page.title != null ? String(page.title) : "";
  if (tabId == null && !url && !title) return null;
  return {
    tabId,
    url,
    title,
  };
}

function deriveStatus(explicitStatus, endReason, hasError) {
  if (explicitStatus) return String(explicitStatus);
  if (endReason === "abort") return "cancelled";
  if (endReason === "needs_approval") return "needs_approval";
  if (endReason === "error" || hasError) return "failed";
  return "done";
}

function buildFinalConversation({ conversationMessages, history, systemPrompt, lastModelMessages }) {
  if (Array.isArray(conversationMessages) && conversationMessages.length > 0) {
    return conversationMessages;
  }
  const sysMsg =
    systemPrompt
      ? [{ role: "system", content: String(systemPrompt) }]
      : Array.isArray(lastModelMessages) && lastModelMessages[0]?.role === "system"
        ? [lastModelMessages[0]]
        : [];
  if (Array.isArray(history) && history.length > 0) {
    const hasLeadingSystem = history[0]?.role === "system";
    return hasLeadingSystem ? history : [...sysMsg, ...history];
  }
  if (Array.isArray(lastModelMessages) && lastModelMessages.length > 0) {
    return lastModelMessages;
  }
  return sysMsg;
}

export function buildRunRecord(input = {}) {
  const endedAtMs = input.endedAt
    ? new Date(input.endedAt).getTime() || Date.now()
    : Date.now();
  const startedAtMs = input.startedAt
    ? new Date(input.startedAt).getTime() || endedAtMs
    : Math.max(0, endedAtMs - (Number(input.durationMs || input.metrics?.durationMs) || 0));

  const startedAt = new Date(startedAtMs).toISOString();
  const endedAt = new Date(endedAtMs).toISOString();
  const durationMs = Math.max(
    0,
    Number(input.durationMs ?? input.metrics?.durationMs ?? endedAtMs - startedAtMs) || 0,
  );

  const runId = String(input.runId || createRunId("run"));
  const source = input.source === "sw-delegate" ? "sw-delegate" : "sidepanel";
  const tsSlug = input.tsSlug || formatTimestampForFilename(endedAtMs);
  const safeSource = sanitizeFileSlug(source, "sidepanel");
  const safeRunId = sanitizeFileSlug(runId, "run");

  const detacher = createImageDetacher({
    tsSlug,
    safeSource,
    safeRunId,
    threshold: input.imageDetachThreshold ?? IMAGE_DETACH_THRESHOLD,
  });

  const rawSteps = Array.isArray(input.steps) ? input.steps : [];
  let prevModelMessages = [];
  let lastModelMessages = [];

  const compactedSteps = rawSteps.map((rawStep) => {
    if (!rawStep || typeof rawStep !== "object") return rawStep;
    const stepTs = Number(rawStep.timestamp) || endedAtMs;
    const isoTime = rawStep.isoTime || new Date(stepTs).toISOString();

    if (rawStep.type === "model_turn") {
      const currMsgs = Array.isArray(rawStep.messages) ? rawStep.messages : null;
      const deltaRaw = currMsgs
        ? computeMessagesDelta(prevModelMessages, currMsgs)
        : Array.isArray(rawStep.messagesDelta)
          ? rawStep.messagesDelta
          : [];
      if (currMsgs) {
        prevModelMessages = currMsgs;
        lastModelMessages = currMsgs;
      }
      const rawTools = Array.isArray(rawStep.tools) ? rawStep.tools : null;
      const toolNames = rawTools
        ? rawTools.map((t) => (typeof t === "string" ? t : t?.name)).filter(Boolean)
        : Array.isArray(rawStep.toolNames)
          ? rawStep.toolNames
          : [];
      const toolCount = rawTools ? rawTools.length : Number(rawStep.toolCount ?? toolNames.length) || 0;
      const messageCount = currMsgs ? currMsgs.length : Number(rawStep.messageCount ?? deltaRaw.length) || 0;

      const { messages: _dropMessages, tools: _dropTools, ...rest } = rawStep;
      return detacher.transform({
        ...rest,
        timestamp: stepTs,
        isoTime,
        messageCount,
        messagesDelta: deltaRaw,
        toolCount,
        toolNames,
      });
    }

    if (rawStep.type === "tool_exec" || rawStep.type === "tool_intercepted") {
      const toolName = String(rawStep.toolName || rawStep.name || "unknown");
      const wasIntercepted = rawStep.type === "tool_intercepted";
      const hasClassified =
        rawStep.failureReason !== undefined &&
        rawStep.resultSummary !== undefined &&
        rawStep.jsOk !== undefined;
      const outcome = hasClassified
        ? {
            ok: Boolean(rawStep.ok),
            jsOk: Boolean(rawStep.jsOk),
            failureReason: rawStep.ok ? null : (rawStep.failureReason || null),
            resultSummary: String(rawStep.resultSummary || ""),
          }
        : classifyToolOutcome(
            toolName,
            rawStep.archivedContent ?? rawStep.result ?? rawStep.reason ?? "",
            rawStep.jsOk !== undefined ? Boolean(rawStep.jsOk) : rawStep.ok !== false,
            wasIntercepted,
          );

      return detacher.transform({
        ...rawStep,
        name: toolName,
        toolName,
        ok: outcome.ok,
        jsOk: outcome.jsOk,
        failureReason: outcome.ok ? null : (outcome.failureReason || "tool_failed"),
        resultSummary: outcome.resultSummary,
        tabId: rawStep.tabId ?? null,
        pageUrl: rawStep.pageUrl ?? null,
        pageTitle: rawStep.pageTitle ?? null,
        archiveHandle: rawStep.archiveHandle || null,
        timestamp: stepTs,
        isoTime,
      });
    }

    return detacher.transform({
      ...rawStep,
      timestamp: stepTs,
      isoTime,
    });
  });

  const rawConversation = buildFinalConversation({
    conversationMessages: input.conversationMessages,
    history: input.history,
    systemPrompt: input.systemPrompt,
    lastModelMessages,
  });
  const conversationMessages = detacher.transform(rawConversation);

  const toolSteps = [];
  for (const s of compactedSteps) {
    if (!s || (s.type !== "tool_exec" && s.type !== "tool_intercepted")) continue;
    toolSteps.push({
      stepIndex: toolSteps.length + 1,
      turn: Number.isFinite(Number(s.turn)) ? Number(s.turn) : 0,
      timestamp: Number(s.timestamp) || endedAtMs,
      isoTime: s.isoTime || endedAt,
      toolName: String(s.toolName || s.name || "unknown"),
      args: s.args && typeof s.args === "object" ? s.args : {},
      ok: Boolean(s.ok),
      jsOk: s.jsOk !== undefined ? Boolean(s.jsOk) : Boolean(s.ok),
      failureReason: s.ok ? null : (s.failureReason || s.reason || "tool_failed"),
      resultSummary: String(s.resultSummary || ""),
      durationMs: Math.max(0, Number(s.durationMs) || 0),
      tabId: s.tabId ?? null,
      pageUrl: s.pageUrl ?? null,
      pageTitle: s.pageTitle ?? null,
      archiveHandle: s.archiveHandle || null,
      ...(s.stepMeta && typeof s.stepMeta === "object" ? { stepMeta: s.stepMeta } : {}),
      ...(s.workflowStepId ? { workflowStepId: String(s.workflowStepId) } : {}),
      ...(s.expected !== undefined ? { expected: String(s.expected) } : {}),
      ...(s.actual !== undefined ? { actual: String(s.actual) } : {}),
      ...(s.actualReadback !== undefined ? { actualReadback: s.actualReadback } : {}),
      ...(s.blame ? { blame: String(s.blame) } : {}),
      ...(s.screenshotDataUrl ? { screenshotArtifact: String(s.screenshotDataUrl) } : {}),
    });
  }

  const endReason = String(
    input.endReason || input.metrics?.finishReason || (input.error ? "error" : "stop"),
  );
  const hasError = Boolean(input.error) || endReason === "error";
  const status = deriveStatus(input.status, endReason, hasError);

  const metrics = {
    durationMs,
    inputTokens: Math.max(0, Number(input.metrics?.inputTokens) || 0),
    outputTokens: Math.max(0, Number(input.metrics?.outputTokens) || 0),
    totalTokens: Math.max(
      0,
      Number(input.metrics?.totalTokens) ||
        (Math.max(0, Number(input.metrics?.inputTokens) || 0) +
          Math.max(0, Number(input.metrics?.outputTokens) || 0)),
    ),
    finishReason: String(input.metrics?.finishReason || endReason),
  };

  const initialPage = detacher.transform(normalizePageSnapshot(input.initialPage));
  const finalPage = detacher.transform(normalizePageSnapshot(input.finalPage ?? input.initialPage));
  const botResponse = detacher.transform(String(input.botResponse ?? input.content ?? ""));
  const { cleanPrompt: cleanUserPrompt, strippedChars: autoStrippedChars } = stripAttachedPageContext(
    String(input.userPrompt ?? ""),
  );
  const userPrompt = detacher.transform(cleanUserPrompt);
  const attachedContextChars = Math.max(
    0,
    Number(input.attachedContextChars) || autoStrippedChars || 0,
  );
  const thinking = detacher.transform(String(input.thinking ?? ""));
  const rawTrace = Array.isArray(input.trace) ? input.trace : [];
  let toolStepCursor = 0;
  const enrichedRawTrace = rawTrace.map((item) => {
    if (!item || typeof item !== "object") return item;
    if (item.kind === "tool" || item.kind === "blocked") {
      let matched = null;
      if (toolStepCursor < toolSteps.length) {
        const candidate = toolSteps[toolStepCursor];
        if (!item.name || candidate.toolName === item.name) {
          matched = candidate;
          toolStepCursor += 1;
        } else {
          const lookahead = toolSteps.findIndex(
            (ts, idx) => idx >= toolStepCursor && ts.toolName === item.name,
          );
          if (lookahead >= 0) {
            matched = toolSteps[lookahead];
            toolStepCursor = lookahead + 1;
          }
        }
      }
      if (matched) {
        return {
          ...item,
          ok: matched.ok,
          jsOk: matched.jsOk,
          timestamp: item.timestamp ?? matched.timestamp,
          isoTime: item.isoTime ?? matched.isoTime,
          tabId: item.tabId ?? matched.tabId,
          pageUrl: item.pageUrl ?? matched.pageUrl,
          pageTitle: item.pageTitle ?? matched.pageTitle,
          failureReason:
            item.failureReason !== undefined ? item.failureReason : matched.failureReason,
          archiveHandle: item.archiveHandle ?? matched.archiveHandle,
        };
      }
    }
    return item;
  });
  const trace = detacher.transform(enrichedRawTrace);
  const sidepanelErrors = detacher.transform(
    Array.isArray(input.sidepanelErrors) ? input.sidepanelErrors : [],
  );
  const errorValue = input.error != null && input.error !== "" ? detacher.transform(input.error) : null;

  const sessionId = String(input.sessionId || "default");
  const rawContext = input.conversationContext && typeof input.conversationContext === "object"
    ? input.conversationContext
    : {
        sessionId,
        sessionTitle: input.sessionTitle || undefined,
        page: finalPage || initialPage || null,
        messagesSummary: Array.isArray(input.messagesSummary) ? input.messagesSummary : [],
      };
  const conversationContext = detacher.transform(rawContext);
  const artifacts = detacher.publicArtifacts();

  const traceRecord = {
    version: TRACE_SCHEMA_VERSION,
    runId,
    source,
    taskId: input.taskId ? String(input.taskId) : null,
    sessionId,
    timestamp: endedAt,
    startedAt,
    endedAt,
    extensionVersion: String(input.extensionVersion || "0.0.0"),
    gitCommit: String(input.gitCommit || "dev-local"),
    status,
    endReason,
    model: String(
      (typeof input.model === "object" ? input.model?.model : input.model) || "unknown",
    ),
    durationMs,
    metrics,
    initialPage,
    finalPage,
    userPrompt,
    attachedContextChars,
    thinking,
    botResponse,
    content: botResponse,
    error: errorValue,
    sidepanelErrors,
    artifacts,
    toolSteps,
    trace,
    steps: compactedSteps,
    conversationMessages,
    conversationContext,
  };

  return {
    traceRecord,
    detachedImages: detacher.detachedImages,
    tsSlug,
    safeSource,
    safeRunId,
  };
}

export async function downloadFileBestEffort(
  { url, filename, rawText = null, mimeType = "application/json;charset=utf-8", conflictAction = "uniquify" },
  {
    chromeRef = globalThis.chrome,
    logDebug = debugLog,
    allowAnchorFallback = false,
  } = {},
) {
  if (typeof chromeRef?.downloads?.download === "function") {
    try {
      const downloadId = await Promise.resolve(
        chromeRef.downloads.download({
          url,
          filename,
          saveAs: false,
          conflictAction,
        }),
      );
      return { ok: true, via: "downloads", downloadId, filename };
    } catch (err) {
      const reason = String(err?.message || err);
      console.info("[PageLens] downloads.download fallback:", filename, reason);
      logDebug("runRecorder.downloadFallback", { filename, reason });
    }
  }
  if (allowAnchorFallback && rawText != null && downloadViaAnchor(filename, rawText, mimeType)) {
    return { ok: true, via: "anchor", filename };
  }
  console.info("[PageLens] download skipped (no downloads permission or API):", filename);
  logDebug("runRecorder.downloadSkipped", { filename });
  return { ok: false, via: "none", filename };
}

/**
 * 成对落盘：拆离图片（若有） → trace JSON → 脱敏 debug JSON。
 * 全程 try/catch 保护，绝不向外抛错影响主流程；缺少 downloads 权限时静默跳过，绝不弹 <a download>。
 */
export async function persistRunBundle(
  input = {},
  {
    chromeRef = globalThis.chrome,
    fetchImpl = globalThis.fetch,
    exportDebugFn = exportDebugLogFresh,
    logDebug = debugLog,
    autoExport = undefined,
  } = {},
) {
  let fallbackRecord = null;
  try {
    const buildInfo = await resolveRuntimeBuildInfo({ chromeRef, fetchImpl });

    const built = buildRunRecord({
      ...input,
      extensionVersion: input.extensionVersion || buildInfo?.extensionVersion || "0.0.0",
      gitCommit: input.gitCommit || buildInfo?.gitCommit || "dev-local",
    });
    fallbackRecord = built.traceRecord;

    const { traceRecord, detachedImages, tsSlug, safeSource, safeRunId } = built;
    const shouldExport =
      typeof autoExport === "boolean"
        ? autoExport
        : await isAutoExportRunBundleEnabled({
            chromeRef,
            settings: input.settings || null,
          });
    if (!shouldExport) {
      logDebug("runRecorder.autoExportDisabled", {
        runId: traceRecord.runId,
        source: traceRecord.source,
        status: traceRecord.status,
      });
      return {
        ok: true,
        exported: false,
        skippedReason: "auto_export_disabled",
        traceRecord,
        files: [],
      };
    }

    const hasDlPerm = await hasDownloadsPermission({ chromeRef });
    const allowDevAnchor =
      !__PL_PROD_BUILD__ &&
      !isProdBuild() &&
      input?.settings?.debug?.allowDevAnchorExport === true &&
      (await isDevelopmentInstall({ chromeRef }));

    if (!hasDlPerm && !allowDevAnchor) {
      logDebug("runRecorder.missingDownloadsPermission", {
        runId: traceRecord.runId,
        source: traceRecord.source,
      });
      return {
        ok: true,
        exported: false,
        skippedReason: "missing_downloads_permission",
        traceRecord,
        files: [],
      };
    }

    const files = [];

    if (hasDlPerm) {
      for (const img of detachedImages) {
        const res = await downloadFileBestEffort(
          {
            url: img.dataUrl,
            filename: img.filename,
            mimeType: img.mimeType,
            conflictAction: "uniquify",
          },
          { chromeRef, logDebug, allowAnchorFallback: false },
        );
        files.push({ kind: "screenshot", ...res });
      }
    }

    const traceFilename = `${RUN_OUTPUT_DIR}/pagelens-trace-${tsSlug}-${safeSource}-${safeRunId}.json`;
    const traceJson = JSON.stringify(traceRecord, null, 2);
    const traceRes = await downloadFileBestEffort(
      {
        url: hasDlPerm ? encodeUtf8DataUrl(traceJson, "application/json;charset=utf-8") : "",
        filename: hasDlPerm ? traceFilename : traceFilename.split("/").pop(),
        rawText: traceJson,
        mimeType: "application/json;charset=utf-8",
        conflictAction: "uniquify",
      },
      { chromeRef: hasDlPerm ? chromeRef : null, logDebug, allowAnchorFallback: allowDevAnchor },
    );
    files.push({ kind: "trace", ...traceRes });

    const debugFilename = `${RUN_OUTPUT_DIR}/pagelens-debug-${tsSlug}-${safeSource}-${safeRunId}.json`;
    let debugPayload;
    try {
      const rawDebug = await exportDebugFn();
      const parsed = typeof rawDebug === "string" ? JSON.parse(rawDebug) : rawDebug;
      debugPayload = sanitizeTraceValue({
        runId: traceRecord.runId,
        source: traceRecord.source,
        taskId: traceRecord.taskId,
        sessionId: traceRecord.sessionId,
        extensionVersion: traceRecord.extensionVersion,
        gitCommit: traceRecord.gitCommit,
        ...(parsed && typeof parsed === "object" ? parsed : { raw: String(rawDebug ?? "") }),
      });
    } catch (err) {
      debugPayload = {
        runId: traceRecord.runId,
        source: traceRecord.source,
        extensionVersion: traceRecord.extensionVersion,
        gitCommit: traceRecord.gitCommit,
        exportNote: sanitizeTraceString(err?.message || String(err)),
        entries: [],
      };
    }
    const debugJson = JSON.stringify(debugPayload, null, 2);
    const debugRes = await downloadFileBestEffort(
      {
        url: hasDlPerm ? encodeUtf8DataUrl(debugJson, "application/json;charset=utf-8") : "",
        filename: hasDlPerm ? debugFilename : debugFilename.split("/").pop(),
        rawText: debugJson,
        mimeType: "application/json;charset=utf-8",
        conflictAction: "uniquify",
      },
      { chromeRef: hasDlPerm ? chromeRef : null, logDebug, allowAnchorFallback: allowDevAnchor },
    );
    files.push({ kind: "debug", ...debugRes });

    console.info(
      "[PageLens] run-recorder persisted",
      JSON.stringify({
        runId: traceRecord.runId,
        source: traceRecord.source,
        status: traceRecord.status,
        endReason: traceRecord.endReason,
        traceFilename,
        debugFilename,
        artifacts: detachedImages.length,
      }),
    );
    logDebug("runRecorder.persisted", {
      runId: traceRecord.runId,
      source: traceRecord.source,
      status: traceRecord.status,
      endReason: traceRecord.endReason,
      artifacts: detachedImages.length,
    });

    return {
      ok: true,
      exported: true,
      traceRecord,
      traceFilename,
      debugFilename,
      files,
    };
  } catch (err) {
    const reason = String(err?.message || err);
    console.info("[PageLens] run-recorder persist failed safely:", reason);
    logDebug("runRecorder.failed", { reason });
    return {
      ok: false,
      error: reason,
      traceRecord: fallbackRecord,
      files: [],
    };
  }
}

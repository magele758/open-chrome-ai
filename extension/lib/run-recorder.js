/**
 * 运行级 Trace 与调试日志自动落盘模块（同时兼容侧栏与 MV3 Service Worker）。
 *
 * 关键特性：
 * 1. MV3 SW 安全：不依赖 window / document / URL.createObjectURL，统一通过 UTF-8 Base64 data: URL
 *    调用 chrome.downloads.download 落盘到下载目录子目录 pagelens-runs/；侧栏异常时兜底 <a download>。
 * 2. 敏感信息脱敏（sanitizeTraceValue）：脱敏密钥/凭据字段、Bearer/sk- 令牌与 URL 敏感 query 参数，
 *    同时完整保留非敏感页面 URL（含路径、普通 query 参数与 #hash 路由）。
 * 3. 工具业务成败精准判定（classifyToolOutcome）：识别 JSON ok:false / notFound / timedOut / blocked
 *    及常见中文/系统失败前缀，区分业务成败 ok 与 JS 执行成败 jsOk，提取结构化 failureReason。
 * 4. 减重去重：>=4KB 的 data:image/* Base64 截图按内容去重拆离为独立图片文件；model_turn 仅存 messagesDelta，
 *    完整最终对话在顶层 conversationMessages 存一份。
 * 5. 所有预期容错分支仅用 console.info + debugLog，严禁 console.warn / console.error。
 */

import { debugLog, exportDebugLogFresh } from "./debug-log.js";
import { getBuildInfo, resolveBuildInfo } from "./dev-reload.js";

export const TRACE_SCHEMA_VERSION = "2.0";
export const RUN_OUTPUT_DIR = "pagelens-runs";
export const IMAGE_DETACH_THRESHOLD = 4096;

export const SENSITIVE_KEY_RE =
  /^(api[_-]?key|password|passwd|secret|secret[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization|cookie|set-cookie|private[_-]?key|client[_-]?secret)$/i;

const SENSITIVE_QUERY_PARAM_RE =
  /([?&])(token|api_key|apikey|access_token|refresh_token|auth_token|secret|client_secret|password|passwd|signature)=([^&#\s"'<>]*)/gi;

const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SK_TOKEN_RE = /\bsk-[A-Za-z0-9_-]{8,}/g;
const URL_BASIC_AUTH_RE = /(https?:\/\/[^/\s:@]+):([^@\s/]+)@/gi;

const DATA_IMAGE_GLOBAL_RE = /data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)/gi;
const UNTRUSTED_WRAPPER_RE = /^<untrusted_page(?:\s+source="[^"]*")?>\r?\n?([\s\S]*?)\r?\n?<\/untrusted_page>$/i;

const TEXT_TOOL_FAILURE_RE =
  /^(截图失败[：:]|当前页面受系统安全策略保护|已拦截|\[安全拦截\]|unknown tool:|请求失败[：:]|执行失败[：:]|页面上没有匹配的|没有匹配.*的可见控件|(?:NEEDS_WIDER_AUTHORIZATION|EGRESS_NOT_ALLOWED|CONFIRMATION_REQUIRED|ORIGIN_NOT_ALLOWED):)/i;

export function createRunId(prefix = "run") {
  const ts = Date.now().toString(36);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(4);
    globalThis.crypto.getRandomValues(bytes);
    const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${prefix}_${ts}_${rand}`;
  }
  return `${prefix}_${ts}_${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeFileSlug(value, fallback = "unknown") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || fallback;
}

export function formatTimestampForFilename(dateOrMs = Date.now()) {
  const d = dateOrMs instanceof Date ? dateOrMs : new Date(dateOrMs);
  const iso = Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  return iso.replace(/[:.]/g, "-");
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function encodeUtf8DataUrl(text, mimeType = "application/json;charset=utf-8") {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

export function isSensitiveFieldKey(key) {
  const k = String(key || "").trim();
  if (!k) return false;
  if (SENSITIVE_KEY_RE.test(k)) return true;
  const tail = k.split(".").pop() || "";
  return Boolean(tail && SENSITIVE_KEY_RE.test(tail));
}

export function sanitizeTraceString(raw) {
  const str = String(raw ?? "");
  if (!str) return "";
  if (/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(str)) {
    return str;
  }
  return str
    .replace(BEARER_TOKEN_RE, "Bearer [REDACTED]")
    .replace(SK_TOKEN_RE, "[REDACTED]")
    .replace(URL_BASIC_AUTH_RE, "$1:[REDACTED]@")
    .replace(SENSITIVE_QUERY_PARAM_RE, "$1$2=[REDACTED]");
}

export function sanitizeTraceValue(value, key = "", depth = 0) {
  if (key && isSensitiveFieldKey(key)) return "[REDACTED]";
  if (depth > 16) return "[MaxDepth]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string") return sanitizeTraceString(value);
  if (typeof value === "function") return undefined;
  if (value instanceof Error) {
    return {
      name: value.name || "Error",
      message: sanitizeTraceString(value.message || String(value)),
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTraceValue(item, "", depth + 1));
  }
  if (typeof value === "object") {
    if (typeof value.key === "string" && "value" in value && isSensitiveFieldKey(value.key)) {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = k === "value" ? "[REDACTED]" : sanitizeTraceValue(v, k, depth + 1);
      }
      return out;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "function" || v === undefined) continue;
      out[k] = isSensitiveFieldKey(k) ? "[REDACTED]" : sanitizeTraceValue(v, k, depth + 1);
    }
    return out;
  }
  return sanitizeTraceString(String(value));
}

export function unwrapUntrustedOutput(text) {
  const s = String(text ?? "").trim();
  const match = UNTRUSTED_WRAPPER_RE.exec(s);
  return match ? match[1].trim() : s;
}

export function compactResultSummary(raw, maxChars = 300) {
  const unwrapped = unwrapUntrustedOutput(raw);
  const withoutHugeDataUrl = unwrapped.replace(
    /data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]{128,}/gi,
    (_m, sub) => `[data:image/${String(sub).toLowerCase()}]`,
  );
  const singleLine = sanitizeTraceString(withoutHugeDataUrl).replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, Math.max(1, maxChars - 1))}…`;
}

function firstLineSummary(raw, maxChars = 300) {
  const unwrapped = unwrapUntrustedOutput(raw);
  const firstLine = (unwrapped.split(/\r?\n/).find((line) => line.trim()) || unwrapped).trim();
  const cleaned = sanitizeTraceString(firstLine).replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * 精准判定工具调用的业务成败（在 tool-guardian 归档前调用）。
 * @param {string} _toolName
 * @param {unknown} rawContent
 * @param {boolean} [jsOk=true] JS 调用是否未抛未捕获异常
 * @param {boolean} [wasIntercepted=false] 是否被 HITL / 安全护栏 / 频控拦截
 */
export function classifyToolOutcome(_toolName, rawContent, jsOk = true, wasIntercepted = false) {
  const rawString =
    rawContent == null
      ? ""
      : typeof rawContent === "string"
        ? rawContent
        : (() => {
            try {
              return JSON.stringify(rawContent);
            } catch {
              return String(rawContent);
            }
          })();

  const unwrapped = unwrapUntrustedOutput(rawString);
  const resultSummary = compactResultSummary(unwrapped, 300);

  if (wasIntercepted) {
    return {
      ok: false,
      jsOk: Boolean(jsOk),
      failureReason: firstLineSummary(unwrapped, 300) || "intercepted",
      resultSummary,
    };
  }

  if (!jsOk) {
    return {
      ok: false,
      jsOk: false,
      failureReason: firstLineSummary(unwrapped, 300) || "tool_execution_error",
      resultSummary,
    };
  }

  let parsed = null;
  if (rawContent && typeof rawContent === "object" && !Array.isArray(rawContent)) {
    parsed = rawContent;
  } else if (unwrapped.startsWith("{")) {
    try {
      const candidate = JSON.parse(unwrapped);
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsed = candidate;
      }
    } catch {
      parsed = null;
    }
  }

  if (parsed) {
    const failedByFlag =
      parsed.ok === false ||
      parsed.notFound === true ||
      parsed.timedOut === true ||
      parsed.blocked === true ||
      (parsed.ok !== true && typeof parsed.error === "string" && Boolean(parsed.error.trim()));
    if (failedByFlag) {
      const structuredReason =
        parsed.error ||
        parsed.reason ||
        parsed.message ||
        (parsed.timedOut ? "timed_out" : parsed.notFound ? "not_found" : parsed.blocked ? "blocked" : "tool_failed");
      return {
        ok: false,
        jsOk: true,
        failureReason: compactResultSummary(String(structuredReason), 300) || "tool_failed",
        resultSummary,
      };
    }
  }

  if (TEXT_TOOL_FAILURE_RE.test(unwrapped)) {
    return {
      ok: false,
      jsOk: true,
      failureReason: firstLineSummary(unwrapped, 300) || "tool_failed",
      resultSummary,
    };
  }

  return {
    ok: true,
    jsOk: true,
    failureReason: null,
    resultSummary,
  };
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
  const userPrompt = detacher.transform(String(input.userPrompt ?? ""));
  const thinking = detacher.transform(String(input.thinking ?? ""));
  const trace = detacher.transform(Array.isArray(input.trace) ? input.trace : []);
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

function fallbackAnchorDownload(filename, rawText, dataUrl, mimeType) {
  if (
    typeof document === "undefined" ||
    typeof document?.createElement !== "function" ||
    !document?.body
  ) {
    return false;
  }
  try {
    let href = dataUrl;
    let objectUrl = null;
    if (rawText != null && typeof Blob !== "undefined" && typeof URL?.createObjectURL === "function") {
      const blob = new Blob([rawText], { type: mimeType || "application/json;charset=utf-8" });
      objectUrl = URL.createObjectURL(blob);
      href = objectUrl;
    }
    const a = document.createElement("a");
    a.href = href;
    a.download = String(filename || "pagelens-trace.json").split("/").pop();
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try {
        a.remove();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      } catch {
        /* ignore cleanup */
      }
    }, 1000);
    return true;
  } catch {
    return false;
  }
}

export async function downloadFileBestEffort(
  { url, filename, rawText = null, mimeType = "application/json;charset=utf-8", conflictAction = "uniquify" },
  { chromeRef = globalThis.chrome, logDebug = debugLog } = {},
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
  const anchored = fallbackAnchorDownload(filename, rawText, url, mimeType);
  if (anchored) {
    return { ok: true, via: "anchor", filename };
  }
  console.info("[PageLens] download skipped (no downloads API or DOM):", filename);
  logDebug("runRecorder.downloadSkipped", { filename });
  return { ok: false, via: "none", filename };
}

/**
 * 成对落盘：拆离图片（若有） → trace JSON → 脱敏 debug JSON。
 * 全程 try/catch 保护，绝不向外抛错影响主流程。
 */
export async function persistRunBundle(
  input = {},
  {
    chromeRef = globalThis.chrome,
    fetchImpl = globalThis.fetch,
    exportDebugFn = exportDebugLogFresh,
    logDebug = debugLog,
  } = {},
) {
  let fallbackRecord = null;
  try {
    let buildInfo;
    try {
      buildInfo = await resolveBuildInfo({ chromeRef, fetchImpl });
    } catch {
      buildInfo = getBuildInfo({ chromeRef });
    }

    const built = buildRunRecord({
      ...input,
      extensionVersion: input.extensionVersion || buildInfo?.extensionVersion || "0.0.0",
      gitCommit: input.gitCommit || buildInfo?.gitCommit || "dev-local",
    });
    fallbackRecord = built.traceRecord;

    const { traceRecord, detachedImages, tsSlug, safeSource, safeRunId } = built;
    const files = [];

    for (const img of detachedImages) {
      const res = await downloadFileBestEffort(
        {
          url: img.dataUrl,
          filename: img.filename,
          mimeType: img.mimeType,
          conflictAction: "uniquify",
        },
        { chromeRef, logDebug },
      );
      files.push({ kind: "screenshot", ...res });
    }

    const traceFilename = `${RUN_OUTPUT_DIR}/pagelens-trace-${tsSlug}-${safeSource}-${safeRunId}.json`;
    const traceJson = JSON.stringify(traceRecord, null, 2);
    const traceRes = await downloadFileBestEffort(
      {
        url: encodeUtf8DataUrl(traceJson, "application/json;charset=utf-8"),
        filename: traceFilename,
        rawText: traceJson,
        mimeType: "application/json;charset=utf-8",
        conflictAction: "uniquify",
      },
      { chromeRef, logDebug },
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
        url: encodeUtf8DataUrl(debugJson, "application/json;charset=utf-8"),
        filename: debugFilename,
        rawText: debugJson,
        mimeType: "application/json;charset=utf-8",
        conflictAction: "uniquify",
      },
      { chromeRef, logDebug },
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

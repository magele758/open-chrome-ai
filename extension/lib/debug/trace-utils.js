/**
 * 轻量无副作用的运行期辅助工具（<3KB，零 Chrome 监听器、零文件探测）。
 * 供 tools.js、chrome-loop-tools.js、agent-loop.js 在 L0 默认态安全复用，
 * 避免为了纯文本清洗或结果分类而静态加载完整的 run-recorder 模块。
 */

import { sanitizeTraceString } from "./sanitizer.js";

const UNTRUSTED_WRAPPER_RE = /^<untrusted_page(?:\s+source="[^"]*")?>\r?\n?([\s\S]*?)\r?\n?<\/untrusted_page>$/i;

const TEXT_TOOL_FAILURE_RE =
  /^(截图失败[：:]|当前页面受系统安全策略保护|已拦截|\[安全拦截\]|unknown tool:|请求失败[：:]|执行失败[：:]|页面上没有匹配的|没有匹配.*的可见(?:控件|元素)|(?:NEEDS_WIDER_AUTHORIZATION|EGRESS_NOT_ALLOWED|CONFIRMATION_REQUIRED|ORIGIN_NOT_ALLOWED):)/i;

const ATTACHED_CONTEXT_TAIL_RE =
  /\n\n(?:（用户未分享页面）|【(?:用户选区|视频|页面正文|PDF\s*正文|X\s*长文章|X\s*帖子|PDF)】[\s\S]*)$/;

export function stripAttachedPageContext(raw) {
  const s = String(raw ?? "");
  if (!s) return { cleanPrompt: "", strippedChars: 0 };
  const m = ATTACHED_CONTEXT_TAIL_RE.exec(s);
  if (!m) return { cleanPrompt: s, strippedChars: 0 };
  const tail = m[0];
  if (
    tail.includes("（用户未分享页面）") ||
    tail.includes("<untrusted_page") ||
    tail.includes("【PDF】未能抽取：") ||
    tail.includes("【音频文稿】")
  ) {
    return {
      cleanPrompt: s.slice(0, m.index),
      strippedChars: Math.max(0, tail.length - 2),
    };
  }
  return { cleanPrompt: s, strippedChars: 0 };
}

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
 * @param {string} toolName
 * @param {unknown} rawContent
 * @param {boolean} [jsOk=true] JS 调用是否未抛未捕获异常
 * @param {boolean} [wasIntercepted=false] 是否被 HITL / 安全护栏 / 频控拦截
 */
export function classifyToolOutcome(toolName, rawContent, jsOk = true, wasIntercepted = false) {
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

  if (toolName === "run_shell") {
    const exitMatch = /(?:^|\n)exit\s+([1-9]\d*)\b/.exec(unwrapped);
    if (exitMatch) {
      return {
        ok: false,
        jsOk: true,
        failureReason: `shell_exit_${exitMatch[1]}: ${firstLineSummary(unwrapped)}`.slice(0, 300),
        resultSummary,
      };
    }
  }

  return {
    ok: true,
    jsOk: true,
    failureReason: null,
    resultSummary,
  };
}

/**
 * 零权限 DOM <a download> 下载辅助（用于 L1 手动导出，无需申请 chrome.downloads 权限）。
 */
export function downloadViaAnchor(filename, rawText, mimeType = "application/json;charset=utf-8") {
  if (
    typeof document === "undefined" ||
    typeof document?.createElement !== "function" ||
    !document?.body
  ) {
    return false;
  }
  try {
    const safeName = String(filename || "pagelens-diag.json").split("/").pop() || "pagelens-diag.json";
    let href = null;
    let objectUrl = null;
    if (typeof Blob !== "undefined" && typeof URL?.createObjectURL === "function") {
      const blob = new Blob([String(rawText ?? "")], { type: mimeType });
      objectUrl = URL.createObjectURL(blob);
      href = objectUrl;
    } else {
      href = encodeUtf8DataUrl(rawText, mimeType);
    }
    const a = document.createElement("a");
    a.href = href;
    a.download = safeName;
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

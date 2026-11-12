/**
 * Langfuse Trace 导出器（仅在调试模式开启且 Langfuse 显式启用时按需动态加载）。
 *
 * 外发防护：
 * 1. 所有外发到远程 Ingestion API 的字段强制经过严格脱敏（sanitizePayload strict profile）。
 * 2. 在浏览器环境下发送前校验目标域名 optional_host_permissions 已授予。
 */

import { debugLog } from "./ring-log.js";
import { hasOriginPermission } from "./policy.js";
import { sanitizePayload, sanitizeString } from "./sanitizer.js";

function trimSlash(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function generateId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      /* ignore and fallback */
    }
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function encodeBasicAuth(pk, sk) {
  const raw = `${pk || ""}:${sk || ""}`;
  if (typeof btoa === "function") {
    return btoa(raw);
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(raw).toString("base64");
  }
  return "";
}

function cleanExternalValue(value, maxChars = 2000) {
  if (value === undefined) return undefined;
  return sanitizePayload(value, {
    profile: "strict",
    maxDepth: 7,
    maxChars,
    maxArray: 60,
    maxKeys: 50,
    maskPii: true,
  });
}

function cleanExternalText(value, maxChars = 2000) {
  if (value == null) return "";
  return sanitizeString(String(value), {
    profile: "strict",
    maxChars,
    maskPii: true,
  });
}

export function formatTracePayload(traceLog, options = {}) {
  if (!traceLog || typeof traceLog !== "object") {
    return { traceId: generateId(), batch: [] };
  }

  const traceId = traceLog.traceId || generateId();
  const nowIso = new Date().toISOString();
  const traceTimestamp = traceLog.timestamp || nowIso;
  const batch = [];

  const totalTokens = Number(traceLog.metrics?.totalTokens) || 0;
  const inputTokens = Number(traceLog.metrics?.inputTokens) || 0;
  const outputTokens = Number(traceLog.metrics?.outputTokens) || 0;
  const durationMs = Number(traceLog.durationMs || traceLog.metrics?.durationMs) || 0;

  const safeUserPrompt = cleanExternalText(traceLog.userPrompt || "", 2000);
  const safeBotResponse = cleanExternalText(traceLog.botResponse || "", 2000);

  // 1. Top-level Trace
  batch.push({
    id: generateId(),
    type: "trace-create",
    timestamp: traceTimestamp,
    body: {
      id: traceId,
      name: traceLog.sessionTitle
        ? `PageLens: ${cleanExternalText(traceLog.sessionTitle, 120)}`
        : "PageLens Agent Run",
      sessionId: String(traceLog.sessionId || "default"),
      input: safeUserPrompt,
      output: safeBotResponse,
      metadata: {
        model: traceLog.model,
        finishReason: traceLog.metrics?.finishReason,
        durationMs,
        tokens: { totalTokens, inputTokens, outputTokens },
        page: traceLog.page ? cleanExternalValue(traceLog.page, 500) : null,
        thinkingPreview: traceLog.thinking ? cleanExternalText(traceLog.thinking, 500) : null,
        error: traceLog.error ? cleanExternalValue(traceLog.error, 500) : null,
      },
      tags: ["pagelens", "chrome-extension", traceLog.model].filter(Boolean),
      release: options.release || "0.12.0",
      environment: options.environment || "development",
    },
  });

  // 2. Pre-scan steps to create Turn Spans
  const steps = Array.isArray(traceLog.steps) ? traceLog.steps : [];
  const turnSpanMap = new Map();

  function resolveTurnNum(s, fallback) {
    if (s && Number.isFinite(Number(s.turn))) {
      const n = Number(s.turn);
      if (s.type === "turn_start") return n + 1;
      if (n > 0) return n;
    }
    return fallback;
  }

  let curTurn = 1;
  for (const s of steps) {
    if (!s || typeof s !== "object") continue;
    curTurn = resolveTurnNum(s, curTurn);
    if (curTurn > 0 && !turnSpanMap.has(curTurn)) {
      turnSpanMap.set(curTurn, generateId());
    }
  }

  for (const [turnNum, turnSpanId] of turnSpanMap.entries()) {
    let turnActive = 1;
    const turnSteps = steps.filter((st) => {
      turnActive = resolveTurnNum(st, turnActive);
      return turnActive === turnNum;
    });
    const startCandidate = turnSteps.map((st) => Number(st.timestamp) - (Number(st.durationMs) || 0)).filter(Boolean);
    const endCandidate = turnSteps.map((st) => Number(st.timestamp)).filter(Boolean);
    const turnStartMs = startCandidate.length ? Math.min(...startCandidate) : Date.now();
    const turnEndMs = endCandidate.length ? Math.max(...endCandidate) : Date.now();

    batch.push({
      id: generateId(),
      type: "span-create",
      timestamp: new Date(turnStartMs).toISOString(),
      body: {
        id: turnSpanId,
        traceId,
        name: `Turn ${turnNum}`,
        startTime: new Date(turnStartMs).toISOString(),
        endTime: new Date(turnEndMs).toISOString(),
        input: turnNum === 1 ? safeUserPrompt : undefined,
        metadata: {
          turn: turnNum,
          stepCount: turnSteps.length,
        },
      },
    });
  }

  // 3. Step-level Generations, Spans, and Events nested under Turn Spans
  let stepTurn = 1;
  for (let idx = 0; idx < steps.length; idx++) {
    const s = steps[idx];
    if (!s || typeof s !== "object") continue;
    stepTurn = resolveTurnNum(s, stepTurn);
    const stepTime = s.timestamp ? new Date(s.timestamp).toISOString() : traceTimestamp;
    const parentObservationId = (Number.isFinite(stepTurn) && stepTurn > 0)
      ? turnSpanMap.get(stepTurn)
      : undefined;

    if (s.type === "model_turn") {
      const turnDuration = Number(s.durationMs) || 0;
      const turnEndTime = s.timestamp ? new Date(s.timestamp).toISOString() : traceTimestamp;
      const turnStartTime = s.timestamp && turnDuration
        ? new Date(s.timestamp - turnDuration).toISOString()
        : turnEndTime;

      const pTok = Number(s.usage?.promptTokens) || 0;
      const cTok = Number(s.usage?.completionTokens) || 0;
      const tTok = Number(s.usage?.totalTokens) || (pTok + cTok);

      let modelOutput = s.content ? cleanExternalText(s.content, 2000) : "";
      if (s.toolCalls && s.toolCalls.length > 0) {
        modelOutput = {
          content: s.content ? cleanExternalText(s.content, 2000) : undefined,
          reasoning: s.reasoning ? cleanExternalText(s.reasoning, 1000) : undefined,
          toolCalls: cleanExternalValue(s.toolCalls, 1000),
        };
      } else if (s.reasoning) {
        modelOutput = {
          content: s.content ? cleanExternalText(s.content, 2000) : "",
          reasoning: cleanExternalText(s.reasoning, 1000),
        };
      } else if (!s.content && s.contentLength) {
        modelOutput = `[content length: ${s.contentLength}]`;
      }

      const rawInput =
        s.messages ||
        s.messagesDelta ||
        s.inputPreview ||
        (s.turn === 1 ? safeUserPrompt : undefined);

      batch.push({
        id: generateId(),
        type: "generation-create",
        timestamp: turnEndTime,
        body: {
          id: generateId(),
          traceId,
          parentObservationId,
          name: `model_turn_${s.turn || idx + 1}`,
          startTime: turnStartTime,
          endTime: turnEndTime,
          model: traceLog.model || "unknown",
          modelParameters: {
            finishReason: s.finishReason,
            toolsCount: Array.isArray(s.tools) ? s.tools.length : s.toolCount,
          },
          input: rawInput !== undefined ? cleanExternalValue(rawInput, 1500) : undefined,
          output: modelOutput,
          usage: {
            promptTokens: pTok,
            completionTokens: cTok,
            totalTokens: tTok,
          },
          metadata: {
            finishReason: s.finishReason,
            turn: s.turn,
            durationMs: turnDuration,
            reasoning: s.reasoning ? cleanExternalText(s.reasoning, 500) : undefined,
            toolsAvailable: Array.isArray(s.tools)
              ? s.tools.map((t) => t.name)
              : Array.isArray(s.toolNames)
                ? s.toolNames
                : undefined,
          },
        },
      });
    } else if (s.type === "tool_exec") {
      const toolDuration = Number(s.durationMs) || 0;
      const toolEndTime = s.timestamp ? new Date(s.timestamp).toISOString() : traceTimestamp;
      const toolStartTime = s.timestamp && toolDuration
        ? new Date(s.timestamp - toolDuration).toISOString()
        : toolEndTime;

      batch.push({
        id: generateId(),
        type: "span-create",
        timestamp: toolEndTime,
        body: {
          id: generateId(),
          traceId,
          parentObservationId,
          name: `tool:${s.name || s.toolName || "unknown"}`,
          startTime: toolStartTime,
          endTime: toolEndTime,
          input: cleanExternalValue(s.args || {}, 1000),
          output: cleanExternalValue(s.resultSummary || s.resultPreview || s.result || "", 1500),
          level: s.ok === false ? "ERROR" : "DEFAULT",
          statusMessage: s.ok === false ? "failed" : "success",
          metadata: {
            ok: s.ok !== false,
            durationMs: toolDuration,
          },
        },
      });
    } else if (s.type === "tool_intercepted") {
      batch.push({
        id: generateId(),
        type: "event-create",
        timestamp: stepTime,
        body: {
          id: generateId(),
          traceId,
          parentObservationId,
          name: `guardrail:intercepted:${s.name || s.toolName || "tool"}`,
          startTime: stepTime,
          input: cleanExternalValue(s.args || {}, 1000),
          output: cleanExternalText(s.reason || "安全拦截", 500),
          level: "WARNING",
          statusMessage: "intercepted",
        },
      });
    } else if (s.type === "compressed") {
      batch.push({
        id: generateId(),
        type: "event-create",
        timestamp: stepTime,
        body: {
          id: generateId(),
          traceId,
          parentObservationId,
          name: "context_compressed",
          startTime: stepTime,
          metadata: {
            turn: s.turn,
            before: s.before,
            after: s.after,
          },
        },
      });
    } else if (s.type === "summarize_transcript") {
      batch.push({
        id: generateId(),
        type: "generation-create",
        timestamp: stepTime,
        body: {
          id: generateId(),
          traceId,
          name: "summarize_transcript",
          startTime: s.timestamp && s.durationMs
            ? new Date(s.timestamp - s.durationMs).toISOString()
            : stepTime,
          endTime: stepTime,
          model: traceLog.model || "unknown",
          input: safeUserPrompt,
          output: safeBotResponse,
          usage: {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            totalTokens,
          },
          metadata: {
            durationMs: s.durationMs,
          },
        },
      });
    }
  }

  return { traceId, batch };
}

export function isLangfuseConfigured(config) {
  if (!config || typeof config !== "object") return false;
  if (!config.enabled) return false;
  const baseUrl = trimSlash(config.baseUrl || "");
  const pk = String(config.publicKey || "").trim();
  const sk = String(config.secretKey || "").trim();
  return Boolean(baseUrl && pk && sk);
}

export async function sendTraceToLangfuse(traceLog, config, options = {}) {
  try {
    if (!traceLog) return { ok: false, skipped: true, reason: "no_trace" };
    if (!config?.enabled) return { ok: false, skipped: true, reason: "disabled" };

    const baseUrl = trimSlash(config.baseUrl || "http://localhost:3000");
    const pk = String(config.publicKey || "").trim();
    const sk = String(config.secretKey || "").trim();

    if (!pk || !sk) {
      debugLog("langfuse.skipped", { reason: "missing_credentials" });
      return { ok: false, skipped: true, reason: "missing_credentials" };
    }

    const chromeRef = options.chromeRef || globalThis.chrome;
    if (!(await hasOriginPermission(baseUrl, { chromeRef }))) {
      debugLog("langfuse.skipped", { reason: "missing_host_permission" });
      return { ok: false, skipped: true, reason: "missing_host_permission" };
    }

    const payload = formatTracePayload(traceLog, {
      ...options,
      environment: config.environment || "development",
      release: config.release || "0.12.0",
    });

    const url = `${baseUrl}/api/public/ingestion`;
    const t0 = Date.now();
    const fetchImpl = options.fetchImpl || globalThis.fetch;

    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${encodeBasicAuth(pk, sk)}`,
      },
      body: JSON.stringify({ batch: payload.batch }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      debugLog("langfuse.error", { status: res.status, error: errText, durationMs: Date.now() - t0 });
      return { ok: false, status: res.status, error: errText };
    }

    const data = await res.json().catch(() => ({}));
    debugLog("langfuse.uploaded", {
      traceId: payload.traceId,
      batchCount: payload.batch.length,
      durationMs: Date.now() - t0,
    });
    return { ok: true, traceId: payload.traceId, data };
  } catch (err) {
    debugLog("langfuse.network_error", { error: err?.message || String(err) });
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function testLangfuseConnection(config, { chromeRef = globalThis.chrome, fetchImpl = globalThis.fetch } = {}) {
  const rawBase = config?.baseUrl !== undefined ? config.baseUrl : "http://localhost:3000";
  const baseUrl = trimSlash(rawBase);
  const pk = String(config?.publicKey || "").trim();
  const sk = String(config?.secretKey || "").trim();

  if (!baseUrl) {
    return { ok: false, message: "请填写 Langfuse Host 地址" };
  }
  if (!pk || !sk) {
    return { ok: false, message: "请填写 Public Key 和 Secret Key" };
  }

  if (!(await hasOriginPermission(baseUrl, { chromeRef }))) {
    return { ok: false, message: `未授予 ${baseUrl} 的网络访问权限，请在弹窗中允许后重试` };
  }

  const url = `${baseUrl}/api/public/ingestion`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${encodeBasicAuth(pk, sk)}`,
      },
      body: JSON.stringify({ batch: [] }),
    });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: "认证失败：Public Key 或 Secret Key 无效" };
    }
    if (res.status === 404) {
      return { ok: false, message: "地址错误：/api/public/ingestion 不存在，请检查 Host 地址" };
    }
    if (!res.ok) {
      return { ok: false, message: `连接异常：HTTP ${res.status} ${res.statusText}` };
    }
    return { ok: true, message: "连接成功！Langfuse 服务与密钥正常" };
  } catch (err) {
    return {
      ok: false,
      message: `无法连接到 ${baseUrl}：${err?.message || "请确认本地 Langfuse 已启动"}`,
    };
  }
}

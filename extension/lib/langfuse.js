import { debugLog } from "./debug-log.js";

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

/**
 * Transforms PageLens traceLog structure into Langfuse Ingestion API batch payload.
 *
 * @param {object} traceLog PageLens traceLog object
 * @param {object} [options]
 * @returns {{ traceId: string, batch: Array<object> }}
 */
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

  // 1. Top-level Trace
  batch.push({
    id: generateId(),
    type: "trace-create",
    timestamp: traceTimestamp,
    body: {
      id: traceId,
      name: traceLog.sessionTitle ? `PageLens: ${traceLog.sessionTitle}` : "PageLens Agent Run",
      sessionId: traceLog.sessionId || "default",
      input: traceLog.userPrompt || "",
      output: traceLog.botResponse || "",
      metadata: {
        model: traceLog.model,
        finishReason: traceLog.metrics?.finishReason,
        durationMs,
        tokens: { totalTokens, inputTokens, outputTokens },
        page: traceLog.page || null,
        thinkingPreview: traceLog.thinking ? String(traceLog.thinking).slice(0, 500) : null,
        error: traceLog.error || null,
      },
      tags: ["pagelens", "chrome-extension", traceLog.model].filter(Boolean),
      release: options.release || "0.12.0",
      environment: options.environment || "development",
    },
  });

  // 2. Pre-scan steps to create Turn Spans for a clear hierarchical tree in Langfuse
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

  // Create Turn Spans in batch
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
        input: turnNum === 1 ? traceLog.userPrompt : undefined,
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

      let modelOutput = s.content || "";
      if (s.toolCalls && s.toolCalls.length > 0) {
        modelOutput = {
          content: s.content || undefined,
          reasoning: s.reasoning || undefined,
          toolCalls: s.toolCalls,
        };
      } else if (s.reasoning) {
        modelOutput = {
          content: s.content || "",
          reasoning: s.reasoning,
        };
      } else if (!s.content && s.contentLength) {
        modelOutput = `[content length: ${s.contentLength}]`;
      }

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
            toolsCount: Array.isArray(s.tools) ? s.tools.length : undefined,
          },
          input: s.messages || s.inputPreview || (s.turn === 1 ? traceLog.userPrompt : undefined),
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
            reasoning: s.reasoning || undefined,
            toolsAvailable: Array.isArray(s.tools) ? s.tools.map((t) => t.name) : undefined,
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
          name: `tool:${s.name || "unknown"}`,
          startTime: toolStartTime,
          endTime: toolEndTime,
          input: s.args || {},
          output: s.result || s.resultPreview || "",
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
          name: `guardrail:intercepted:${s.name || "tool"}`,
          startTime: stepTime,
          input: s.args || {},
          output: s.reason || "安全拦截",
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
          input: traceLog.userPrompt,
          output: traceLog.botResponse,
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

/**
 * Checks whether Langfuse is fully configured and enabled.
 * Returns true only when enabled is true and baseUrl, publicKey, secretKey are non-empty.
 *
 * @param {object} [config]
 * @returns {boolean}
 */
export function isLangfuseConfigured(config) {
  if (!config || typeof config !== "object") return false;
  if (!config.enabled) return false;
  const baseUrl = trimSlash(config.baseUrl || "");
  const pk = String(config.publicKey || "").trim();
  const sk = String(config.secretKey || "").trim();
  return Boolean(baseUrl && pk && sk);
}

/**
 * Sends a traceLog to the configured Langfuse instance asynchronously.
 * Guarantees zero unhandled exceptions and silent skip if unconfigured.
 *
 * @param {object} traceLog
 * @param {object} config Langfuse configuration from settings
 * @param {object} [options]
 * @returns {Promise<{ ok: boolean, skipped?: boolean, reason?: string, traceId?: string, error?: string }>}
 */
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

    const payload = formatTracePayload(traceLog, {
      ...options,
      environment: config.environment || "development",
      release: config.release || "0.12.0",
    });

    const url = `${baseUrl}/api/public/ingestion`;
    const t0 = Date.now();

    const res = await fetch(url, {
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
    debugLog("langfuse.network_error", { error: err.message || String(err) });
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Tests connection to the Langfuse instance using provided credentials.
 *
 * @param {object} config
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function testLangfuseConnection(config) {
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

  const url = `${baseUrl}/api/public/ingestion`;
  try {
    const res = await fetch(url, {
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

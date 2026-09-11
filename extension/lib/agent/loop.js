/**
 * Browser-safe distill of ppeng-agent-core L4 `createAgentLoop`:
 *   prepare → model → (optional) tools → repeat until stop / maxTurns / abort
 *
 * Packs each model call with repair + compression (payload only).
 * Can resume from a checkpointed history (pending tool_calls are executed first).
 */

import { CHAR_BUDGET, cloneHistory, packForModel, repairMessages } from "./context.js";
import { interceptToolOutput } from "./tool-guardian.js";

const MAX_TURNS = 12;
const TOOL_RESULT_CHARS = 12000;

export function createAgentLoop(host) {
  return {
    async run(userText, options = {}) {
      return runLoop(host, userText, options);
    },
  };
}

async function runLoop(host, userText, options) {
  const signal = options.signal;
  const onEvent = options.onEvent || (() => {});
  const budget = host.charBudget || CHAR_BUDGET;
  const maxTurns = host.maxTurns || MAX_TURNS;
  const sessionId = options.sessionId || host.sessionId || "default";

  let history = cloneHistory(options.history || []);
  if (!options.resume) {
    history.push({ role: "user", content: userText });
  } else if (!history.length && userText) {
    history.push({ role: "user", content: userText });
  }

  let lastText = options.lastText || "";
  let turnsUsed = Number(options.turnsUsed) || 0;
  const startTime = Date.now();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const traceSteps = [];

  const buildMetrics = (finishReason) => ({
    durationMs: Math.max(1, Date.now() - startTime),
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    finishReason: String(finishReason || "stop"),
  });

  const checkpoint = (extra = {}) => {
    onEvent({
      type: "checkpoint",
      history: cloneHistory(history),
      lastText,
      turnsUsed,
      ...extra,
    });
  };

  const repaired = repairMessages(history, { completePending: false });
  history = repaired.messages;
  checkpoint();

  if (repaired.pending.length) {
    const aborted = await appendToolResults(host, repaired.pending, history, signal, onEvent, checkpoint, sessionId, traceSteps);
    if (aborted) {
      onEvent({ type: "abort" });
      return { reason: "abort", text: lastText, history, turnsUsed, metrics: buildMetrics("abort"), traceSteps };
    }
  }

  while (turnsUsed < maxTurns) {
    if (signal?.aborted) {
      onEvent({ type: "abort" });
      return { reason: "abort", text: lastText, history, turnsUsed, metrics: buildMetrics("abort"), traceSteps };
    }
    onEvent({ type: "turn_prepared", turn: turnsUsed });
    traceSteps.push({ type: "turn_start", turn: turnsUsed, timestamp: Date.now() });

    const packedHist = packForModel(history, { budget, sessionId });
    if (packedHist.compressed) {
      onEvent({
        type: "compressed",
        before: packedHist.before,
        after: packedHist.after,
      });
      traceSteps.push({
        type: "compressed",
        turn: turnsUsed,
        before: packedHist.before,
        after: packedHist.after,
        timestamp: Date.now(),
      });
    }
    const packed = [{ role: "system", content: host.systemPrompt }, ...packedHist.messages];

    let result;
    const modelStart = Date.now();
    try {
      const allHostTools = host.allTools || host.tools || [];
      const toolMap = new Map();
      for (const t of host.tools || []) toolMap.set(t.name, t);
      // Ensure all tools referenced in history are present in tools declaration to avoid API 400 rejection
      for (const m of packed) {
        if (Array.isArray(m?.tool_calls)) {
          for (const tc of m.tool_calls) {
            const name = tc?.function?.name || tc?.name;
            if (name && !toolMap.has(name)) {
              const found = allHostTools.find((t) => t.name === name);
              if (found) toolMap.set(name, found);
            }
          }
        }
      }
      const activeTools = Array.from(toolMap.values());
      if (turnsUsed === 0) console.info("[pagelens] model first-turn", activeTools.length, "tools");
      result = await host.model.runTurn({
        messages: packed,
        tools: activeTools.map(toOpenAITool),
        signal,
        onTextDelta: options.onTextDelta,
      });
    } catch (err) {
      const msg = String(err?.message || err);
      if (/tools|tool_choice|functions/i.test(msg) && host.tools?.length) {
        console.warn("[pagelens] model tools rejected, retrying with sanitized messages", msg);
        const fallbackMessages = packed.map((m) => {
          if (m.role === "tool") return { role: "user", content: `[工具结果] ${m.content}` };
          if (m.tool_calls) return { role: "assistant", content: m.content || "（正在调用工具）" };
          return m;
        });
        result = await host.model.runTurn({
          messages: fallbackMessages,
          tools: [],
          signal,
          onTextDelta: options.onTextDelta,
        });
      } else {
        throw err;
      }
    }

    turnsUsed += 1;
    if (!result || typeof result !== "object") result = { content: "", toolCalls: [] };
    const turnInput = Number(result.usage?.promptTokens) || 0;
    const turnOutput = Number(result.usage?.completionTokens) || 0;
    totalInputTokens += turnInput;
    totalOutputTokens += turnOutput;

    lastText = result.content || lastText;
    const finishReason = result.finishReason || (result.toolCalls?.length ? "tool_calls" : "stop");

    traceSteps.push({
      type: "model_turn",
      turn: turnsUsed,
      durationMs: Date.now() - modelStart,
      finishReason,
      usage: result.usage || { promptTokens: turnInput, completionTokens: turnOutput, totalTokens: turnInput + turnOutput },
      toolCalls: (result.toolCalls || []).map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
      contentLength: (result.content || "").length,
      timestamp: Date.now(),
    });

    onEvent({
      type: "model_done",
      stopReason: finishReason,
      content: result.content || "",
    });

    const calls = (result.toolCalls || [])
      .filter((c) => c && c.name)
      .map((c, i) => ({
        id: c.id || `call_${turnsUsed}_${i}`,
        name: c.name,
        arguments: c.arguments || "{}",
      }));

    if (result.content || calls.length) {
      const assistant = { role: "assistant", content: result.content || "" };
      if (calls.length) {
        assistant.tool_calls = calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments || "{}" },
        }));
      }
      history.push(assistant);
    }

    if (!calls.length) {
      onEvent({ type: "ended", reason: "stop" });
      checkpoint({ done: true });
      return { reason: "stop", text: result.content || lastText, history, turnsUsed, metrics: buildMetrics("stop"), traceSteps };
    }

    checkpoint();
    const aborted = await appendToolResults(host, calls, history, signal, onEvent, checkpoint, sessionId, traceSteps);
    if (aborted) {
      onEvent({ type: "abort" });
      return { reason: "abort", text: lastText, history, turnsUsed, metrics: buildMetrics("abort"), traceSteps };
    }
  }

  onEvent({ type: "ended", reason: "max_turns" });
  checkpoint({ done: true });
  return { reason: "max_turns", text: lastText, history, turnsUsed, metrics: buildMetrics("max_turns"), traceSteps };
}

async function appendToolResults(host, calls, history, signal, onEvent, checkpoint, sessionId = "default", traceSteps = []) {
  for (const call of calls) {
    if (signal?.aborted) return true;
    const drained = await runToolList(host, [call], signal, onEvent, sessionId, traceSteps);
    history.push(...drained.results);
    checkpoint();
    if (drained.aborted) return true;
  }
  return false;
}

async function runToolList(host, calls, signal, onEvent, sessionId = "default", traceSteps = []) {
  const results = [];
  const allHostTools = host.allTools || host.tools || [];
  for (const call of calls) {
    if (signal?.aborted) return { results, aborted: true };
    const tool = (host.tools || []).find((t) => t.name === call.name) || allHostTools.find((t) => t.name === call.name);
    let ok = true;
    let content = "";
    let args = {};
    const t0 = Date.now();
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {
      args = {};
    }
    try {
      if (!tool) {
        ok = false;
        content = `unknown tool: ${call.name}`;
      } else {
        if (typeof host.interceptToolCall === "function") {
          const check = await host.interceptToolCall({ tool, args, call, signal });
          if (check && check.allow === false) {
            ok = false;
            content = check.reason || `[安全拦截] 用户拒绝或未授权执行工具: ${call.name}`;
            results.push({
              role: "tool",
              tool_call_id: call.id,
              content,
            });
            onEvent({ type: "tools_intercepted", name: call.name, reason: content });
            onEvent({ type: "tools_done", name: call.name, ok, content: content.slice(0, 1500) });
            traceSteps.push({
              type: "tool_intercepted",
              name: call.name,
              args,
              reason: content,
              durationMs: Date.now() - t0,
              timestamp: Date.now(),
            });
            continue;
          }
        }
        content = await tool.execute(args, { signal });
        if (content != null && typeof content !== "string") {
          content = JSON.stringify(content);
        }
        if (ok && content) {
          const guarded = await interceptToolOutput({
            sessionId,
            toolName: call.name,
            content,
            threshold: host.toolArchiveThreshold,
          });
          if (guarded.intercepted) {
            onEvent({
              type: "tool_archived",
              name: call.name,
              handle: guarded.handle,
              originalLength: guarded.originalLength,
            });
            content = guarded.content;
          }
        }
      }
    } catch (err) {
      ok = false;
      content = err?.message || String(err);
    }
    const durationMs = Date.now() - t0;
    traceSteps.push({
      type: "tool_exec",
      name: call.name,
      args,
      ok,
      durationMs,
      resultPreview: String(content ?? "").slice(0, 500),
      timestamp: Date.now(),
    });
    content = String(content ?? "").slice(0, TOOL_RESULT_CHARS);
    onEvent({ type: "tools_done", name: call.name, ok, content: content.slice(0, 1500) });
    results.push({
      role: "tool",
      tool_call_id: call.id,
      content,
    });
  }
  return { results, aborted: false };
}

function toOpenAITool(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters || { type: "object", properties: {} },
    },
  };
}

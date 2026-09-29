/**
 * PageLens kernel loop: npm `@mage-ai-lab/agent-loop/mini` over Chrome host/tools.
 */

import {
  createDefaultMemoryStore,
  createMiniAssembledLoop,
  DEFAULT_EMBED_AGENT,
} from "../../vendor/agent-loop-mini.mjs";
import { cloneHistory, repairMessages } from "./context.js";
import { debugLog } from "../debug-log.js";
import { MAX_TURNS, resolveMaxTurns } from "./loop.js";
import {
  chromeMessageToParts,
  chromeToolsToContracts,
  foldedToChromeHistory,
  fromChromeModelResult,
  lastAssistantReasoning,
  lastAssistantText,
  toOpenAIMessages,
  toOpenAITools,
} from "./chrome-loop-codec.js";
import { createChromeToolGate, executeChromeToolCalls } from "./chrome-loop-tools.js";

export { MAX_TURNS, resolveMaxTurns };
export const LOOP_ENGINE_ID = "ppeng-agent-loop-mini";

export const CHROME_LAST_TURN_NUDGE =
  "这是本次任务的最后一轮，工具已关闭。请基于已取得的正文和工具结果直接回答用户；明确说明未读取或未完成的部分。不要编造内容，不要继续规划、承诺稍后读取或声称未完成的操作成功。";
export const CHROME_LAST_TURN_FALLBACK =
  "本次读取已达到轮次上限，尚未得到可交付的完整回答。请重试；已完成的读取和失败原因可在 Trace 中查看。";

function mapEndReason(reason) {
  if (reason === "end") return "stop";
  return String(reason || "stop");
}

function seedHistory(store, sessionId, history) {
  for (const msg of history || []) {
    const role = msg.role === "tool" ? "tool" : msg.role === "assistant" ? "assistant" : msg.role === "system" ? "system" : "user";
    store.appendMessage(sessionId, role, chromeMessageToParts(msg));
  }
}

export function createKernelAgentLoop(host) {
  return {
    async run(userText, options = {}) {
      return runKernelLoop(host, userText, options);
    },
  };
}

async function runKernelLoop(host, userText, options) {
  const signal = options.signal;
  const onEvent = options.onEvent || (() => {});
  const sessionId = options.sessionId || host.sessionId || "default";
  const gate = createChromeToolGate();
  const traceSteps = [];
  const startTime = Date.now();
  let turnsUsed = Number(options.turnsUsed) || 0;
  let lastText = options.lastText || "";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const history = cloneHistory(options.history || []);
  if (!options.resume) {
    if (userText) history.push({ role: "user", content: userText });
  } else if (!history.length && userText) {
    history.push({ role: "user", content: userText });
  }

  const repaired = repairMessages(history, { completePending: false });
  history.length = 0;
  history.push(...repaired.messages);

  const agent = {
    ...DEFAULT_EMBED_AGENT,
    id: "pagelens",
    name: "PageLens",
    role: "assistant",
    instructions: host.systemPrompt || "You are PageLens, a Chrome side-panel page agent.",
  };
  const { store, surface } = createDefaultMemoryStore({ agent });
  const session = surface.createSession({
    title: "pagelens",
    mode: "chat",
    agentId: agent.id,
    metadata: { chromeSessionId: sessionId },
  });

  const emitChrome = (ev) => {
    onEvent(ev);
  };

  const checkpoint = (extra = {}) => {
    emitChrome({
      type: "checkpoint",
      history: cloneHistory(history),
      lastText,
      turnsUsed,
      ...extra,
    });
  };

  const buildMetrics = (finishReason) => ({
    durationMs: Math.max(1, Date.now() - startTime),
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    finishReason: String(finishReason || "stop"),
  });

  const listChromeTools = () => {
    const active = Array.isArray(host.tools) ? host.tools : [];
    const all = host.allTools || active;
    const map = new Map();
    for (const t of active) map.set(t.name, t);
    for (const t of all) if (t?.name && !map.has(t.name)) map.set(t.name, t);
    return Array.from(map.values());
  };

  const runTools = (toolCalls) =>
    executeChromeToolCalls({
      host,
      toolCalls,
      foldMessages: store.foldMessages(session.id),
      gate,
      sessionId,
      signal,
      onEvent: emitChrome,
      traceSteps,
      turn: turnsUsed,
    });

  if (repaired.pending.length) {
    const pendingCalls = repaired.pending.map((p) => ({
      toolCallId: p.id,
      name: p.name,
      input: (() => {
        try {
          return JSON.parse(p.arguments || "{}");
        } catch {
          return {};
        }
      })(),
    }));
    seedHistory(store, session.id, history);
    const pendingResults = await runTools(pendingCalls);
    for (const r of pendingResults) {
      history.push({ role: "tool", tool_call_id: r.toolCallId, content: r.content });
      store.appendMessage(session.id, "tool", [
        {
          type: "tool_result",
          toolCallId: r.toolCallId,
          name: r.name,
          ok: r.ok,
          content: r.content,
        },
      ]);
    }
    checkpoint();
    if (signal?.aborted) {
      emitChrome({ type: "abort" });
      return {
        reason: "abort",
        text: lastText,
        history,
        turnsUsed,
        metrics: buildMetrics("abort"),
        traceSteps,
        engine: LOOP_ENGINE_ID,
      };
    }
  } else {
    seedHistory(store, session.id, history);
    checkpoint();
  }

  const maxTurns = resolveMaxTurns(host.maxTurns);
  const abortController = new AbortController();
  if (signal?.aborted) abortController.abort();
  else signal?.addEventListener("abort", () => abortController.abort(), { once: true });
  if (signal?.aborted) {
    emitChrome({ type: "abort" });
    return {
      reason: "abort",
      text: lastText,
      reasoning: "",
      history,
      turnsUsed,
      metrics: buildMetrics("abort"),
      traceSteps,
      engine: LOOP_ENGINE_ID,
    };
  }
  const abortControllers = new Map([[session.id, abortController]]);
  const assembled = createMiniAssembledLoop({
    io: {
      store,
      agent,
      model: {
        name: "pagelens-chrome",
        async runTurn(input) {
          return this.runTurnStream(input);
        },
        async summarizeMessages() {
          return "";
        },
        async runTurnStream(input, onChunk) {
          const stripTools = !(input.tools && input.tools.length);
          const messages = toOpenAIMessages(input.systemPrompt, input.messages, {
            stripTools,
            lastTurnNudge: stripTools ? CHROME_LAST_TURN_NUDGE : "",
          });
          const modelStart = Date.now();
          const result = await host.model.runTurn({
            messages,
            tools: toOpenAITools(input.tools || []),
            signal: input.signal || signal,
            onTextDelta: (delta) => {
              onChunk?.({ type: "text_delta", text: delta });
              options.onTextDelta?.(delta);
            },
            onReasoningDelta: (delta) => {
              onChunk?.({ type: "reasoning_delta", text: delta });
              options.onReasoningDelta?.(delta);
            },
          });
          const mapped = fromChromeModelResult(result);
          const durationMs = Date.now() - modelStart;
          if (mapped.usage) {
            totalInputTokens += mapped.usage.inputTokens;
            totalOutputTokens += mapped.usage.outputTokens;
          }
          const turnIdx = turnsUsed;
          traceSteps.push({
            type: "model_turn",
            turn: turnIdx,
            durationMs,
            messages,
            tools: (input.tools || []).map((t) => ({ name: t.name, description: t.description })),
            content: result?.content || (mapped.assistant?.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("") || "",
            reasoning: result?.reasoning || (mapped.assistant?.parts || []).filter((p) => p.type === "reasoning").map((p) => p.text).join("") || "",
            toolCalls: (result?.toolCalls || []).map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
            finishReason: result?.finishReason || mapped.stopReason || (result?.toolCalls?.length ? "tool_calls" : "stop"),
            usage: result?.usage || (mapped.usage ? { promptTokens: mapped.usage.inputTokens, completionTokens: mapped.usage.outputTokens, totalTokens: mapped.usage.inputTokens + mapped.usage.outputTokens } : { promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
            timestamp: Date.now(),
          });
          return mapped;
        },
      },
      tools: chromeToolsToContracts(listChromeTools()),
      promptBuilder: {
        async buildSystemPrompt() {
          return host.systemPrompt || agent.instructions;
        },
        buildMemoryAppendix() {
          return "";
        },
      },
      maxTurns: Number.isFinite(maxTurns) ? maxTurns : 0,
      loopConfig: {
        maxTurns: Number.isFinite(maxTurns) ? maxTurns : 0,
        recoveryEnabled: false,
        hitlLatch: false,
        forceAnswerOnLastTurn: true,
        lastTurnNudge: CHROME_LAST_TURN_NUDGE,
        lastTurnFallback: CHROME_LAST_TURN_FALLBACK,
      },
      emitTrace(sid, event) {
        traceSteps.push({ ...event, timestamp: Date.now(), sessionId: sid });
      },
      resolveTurnTools() {
        if (gate.forceAnswer) return { tools: [], allowExternalAiTools: false };
        return {
          tools: chromeToolsToContracts(listChromeTools()),
          allowExternalAiTools: false,
        };
      },
      executeToolCalls: (toolCalls) => runTools(toolCalls),
      sessionAbortControllers: abortControllers,
    },
    config: {
      maxTurns: Number.isFinite(maxTurns) ? maxTurns : 0,
      recoveryEnabled: false,
      hitlLatch: false,
      lastTurnNudge: CHROME_LAST_TURN_NUDGE,
      lastTurnFallback: CHROME_LAST_TURN_FALLBACK,
    },
  });

  let endedReason = "stop";
  try {
    const ended = await assembled.run(session.id, {
      onEvent: async (ev) => {
        if (ev.type === "turn_prepared") {
          turnsUsed += 1;
          emitChrome({ type: "turn_prepared", turn: turnsUsed - 1 });
          debugLog("agent.turn", {
            turn: turnsUsed - 1,
            maxTurns: Number.isFinite(maxTurns) ? maxTurns : 0,
            sessionId,
          });
          traceSteps.push({ type: "turn_start", turn: turnsUsed - 1, timestamp: Date.now() });
        } else if (ev.type === "model_done") {
          const content =
            (ev.assistant?.parts || [])
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("") || "";
          const reasoning =
            (ev.assistant?.parts || [])
              .filter((p) => p.type === "reasoning")
              .map((p) => p.text)
              .join("") || "";
          if (content) lastText = content;
          emitChrome({
            type: "model_done",
            stopReason: ev.stopReason || ev.finishReason || "stop",
            content,
            reasoning,
          });
          const folded = store.foldMessages(session.id);
          history.length = 0;
          history.push(...foldedToChromeHistory(folded));
          checkpoint();
        } else if (ev.type === "tools_done") {
          const folded = store.foldMessages(session.id);
          history.length = 0;
          history.push(...foldedToChromeHistory(folded));
          checkpoint();
        } else if (ev.type === "compacted") {
          emitChrome({ type: "compressed", before: ev.replaced?.startSeq, after: ev.replaced?.endSeq });
          traceSteps.push({
            type: "compressed",
            turn: turnsUsed,
            before: ev.replaced?.startSeq,
            after: ev.replaced?.endSeq,
            timestamp: Date.now(),
          });
        } else if (ev.type === "abort") {
          emitChrome({ type: "abort" });
        } else if (ev.type === "ended") {
          endedReason = mapEndReason(ev.reason);
          if (Number.isFinite(maxTurns) && turnsUsed >= maxTurns && (endedReason === "stop" || endedReason === "end")) {
            endedReason = "max_turns";
          }
          const folded = store.foldMessages(session.id);
          history.length = 0;
          history.push(...foldedToChromeHistory(folded));
          lastText = lastAssistantText(folded) || lastText;
          emitChrome({ type: "ended", reason: endedReason });
          checkpoint({ done: true });
        }
      },
    });
    if (signal?.aborted || (ended?.status === "failed" && /abort/i.test(String(endedReason)))) {
      endedReason = "abort";
    } else {
      endedReason = mapEndReason(endedReason);
    }
    const usage = ended?.metadata?.usageTotals;
    if (usage) {
      totalInputTokens = Number(usage.inputTokens) || totalInputTokens;
      totalOutputTokens = Number(usage.outputTokens) || totalOutputTokens;
    }
  } catch (err) {
    if (signal?.aborted || err?.name === "AbortError") {
      emitChrome({ type: "abort" });
      const folded = store.foldMessages(session.id);
      history.length = 0;
      history.push(...foldedToChromeHistory(folded));
      return {
        reason: "abort",
        text: lastAssistantText(folded) || lastText,
        reasoning: lastAssistantReasoning(folded),
        history,
        turnsUsed,
        metrics: buildMetrics("abort"),
        traceSteps,
        engine: LOOP_ENGINE_ID,
      };
    }
    throw err;
  }

  const folded = store.foldMessages(session.id);
  history.length = 0;
  history.push(...foldedToChromeHistory(folded));
  lastText = lastAssistantText(folded) || lastText;
  if (Number.isFinite(maxTurns) && turnsUsed >= maxTurns && (endedReason === "stop" || endedReason === "end")) {
    endedReason = "max_turns";
  }
  debugLog("agent.end", { reason: endedReason, turnsUsed, sessionId, engine: LOOP_ENGINE_ID });
  return {
    reason: signal?.aborted ? "abort" : endedReason,
    text: lastText,
    reasoning: lastAssistantReasoning(folded),
    history,
    turnsUsed,
    metrics: buildMetrics(endedReason),
    traceSteps,
    engine: LOOP_ENGINE_ID,
  };
}

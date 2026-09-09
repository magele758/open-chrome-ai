/**
 * Browser-safe distill of ppeng-agent-core L4 `createAgentLoop`:
 *   prepare → model → (optional) tools → repeat until stop / maxTurns / abort
 *
 * Packs each model call with repair + compression (payload only).
 * Can resume from a checkpointed history (pending tool_calls are executed first).
 */

import { CHAR_BUDGET, cloneHistory, packForModel, repairMessages } from "./context.js";

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

  let history = cloneHistory(options.history || []);
  if (!options.resume) {
    history.push({ role: "user", content: userText });
  } else if (!history.length && userText) {
    history.push({ role: "user", content: userText });
  }

  let lastText = options.lastText || "";
  let turnsUsed = Number(options.turnsUsed) || 0;

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
    const aborted = await appendToolResults(host, repaired.pending, history, signal, onEvent, checkpoint);
    if (aborted) {
      onEvent({ type: "abort" });
      return { reason: "abort", text: lastText, history, turnsUsed };
    }
  }

  while (turnsUsed < maxTurns) {
    if (signal?.aborted) {
      onEvent({ type: "abort" });
      return { reason: "abort", text: lastText, history, turnsUsed };
    }
    onEvent({ type: "turn_prepared", turn: turnsUsed });

    const packedHist = packForModel(history, { budget });
    if (packedHist.compressed) {
      onEvent({
        type: "compressed",
        before: packedHist.before,
        after: packedHist.after,
      });
    }
    const packed = [{ role: "system", content: host.systemPrompt }, ...packedHist.messages];

    let result;
    try {
      result = await host.model.runTurn({
        messages: packed,
        tools: host.tools.map(toOpenAITool),
        signal,
        onTextDelta: options.onTextDelta,
      });
    } catch (err) {
      const msg = String(err?.message || err);
      if (/tools|tool_choice|functions/i.test(msg) && host.tools.length) {
        result = await host.model.runTurn({
          messages: packed,
          tools: [],
          signal,
          onTextDelta: options.onTextDelta,
        });
      } else {
        throw err;
      }
    }

    turnsUsed += 1;
    lastText = result.content || lastText;
    onEvent({
      type: "model_done",
      stopReason: result.finishReason || (result.toolCalls?.length ? "tool_use" : "stop"),
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
      return { reason: "stop", text: result.content || lastText, history, turnsUsed };
    }

    checkpoint();
    const aborted = await appendToolResults(host, calls, history, signal, onEvent, checkpoint);
    if (aborted) {
      onEvent({ type: "abort" });
      return { reason: "abort", text: lastText, history, turnsUsed };
    }
  }

  onEvent({ type: "ended", reason: "max_turns" });
  checkpoint({ done: true });
  return { reason: "max_turns", text: lastText, history, turnsUsed };
}

async function appendToolResults(host, calls, history, signal, onEvent, checkpoint) {
  for (const call of calls) {
    if (signal?.aborted) return true;
    const drained = await runToolList(host, [call], signal, onEvent);
    history.push(...drained.results);
    checkpoint();
    if (drained.aborted) return true;
  }
  return false;
}

async function runToolList(host, calls, signal, onEvent) {
  const results = [];
  for (const call of calls) {
    if (signal?.aborted) return { results, aborted: true };
    const tool = host.tools.find((t) => t.name === call.name);
    let ok = true;
    let content = "";
    let args = {};
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
        content = await tool.execute(args, { signal });
        if (content != null && typeof content !== "string") {
          content = JSON.stringify(content);
        }
      }
    } catch (err) {
      ok = false;
      content = err?.message || String(err);
    }
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

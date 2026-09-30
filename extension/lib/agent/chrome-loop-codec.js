/**
 * Chrome chat history <-> @ppeng/agent-loop SessionMessage parts.
 */

export function parseToolArgs(raw) {
  try {
    const parsed = JSON.parse(String(raw || "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return { _nonObject: parsed };
  } catch {
    return { raw: String(raw || "") };
  }
}

function textOf(parts) {
  return (parts || [])
    .filter((p) => p?.type === "text")
    .map((p) => p.text || "")
    .join("");
}

function reasoningOf(parts) {
  return (parts || [])
    .filter((p) => p?.type === "reasoning")
    .map((p) => p.text || "")
    .join("");
}

export function chromeMessageToParts(msg) {
  if (!msg) return [];
  if (msg.role === "tool") {
    return [
      {
        type: "tool_result",
        toolCallId: msg.tool_call_id || "",
        name: msg.name || "",
        ok: !/已拦截|unknown tool|失败/.test(String(msg.content || "")),
        content: String(msg.content || ""),
      },
    ];
  }
  if (msg.role === "assistant") {
    const parts = [];
    if (msg.content) parts.push({ type: "text", text: String(msg.content) });
    for (const call of msg.tool_calls || []) {
      const name = call?.function?.name || call?.name || "";
      if (!name) continue;
      parts.push({
        type: "tool_call",
        toolCallId: String(call.id || ""),
        name,
        input: parseToolArgs(call.function?.arguments || call.arguments || "{}"),
      });
    }
    return parts.length ? parts : [{ type: "text", text: "" }];
  }
  return [{ type: "text", text: String(msg.content || "") }];
}

export function foldedToChromeHistory(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || m.role === "system") continue;
    if (m.role === "tool") {
      for (const p of m.parts || []) {
        if (p.type !== "tool_result") continue;
        out.push({
          role: "tool",
          tool_call_id: p.toolCallId,
          content: p.content || "",
        });
      }
      continue;
    }
    if (m.role === "assistant") {
      const text = textOf(m.parts);
      const calls = (m.parts || []).filter((p) => p.type === "tool_call");
      if (!text.trim() && !calls.length) continue;
      const row = { role: "assistant", content: text };
      if (calls.length) {
        row.tool_calls = calls.map((c) => ({
          id: c.toolCallId,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
        }));
      }
      out.push(row);
      continue;
    }
    if (m.role === "user") {
      const text = textOf(m.parts);
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}

export function lastAssistantText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const text = textOf(m.parts).trim();
    if (text) return textOf(m.parts);
  }
  return "";
}

export function lastAssistantReasoning(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const text = reasoningOf(m.parts);
    if (text) return text;
  }
  return "";
}

export function withoutToolCalls(messages) {
  return (messages || []).map((m) => {
    if (m.role === "tool") return { role: "user", content: `[工具结果 · 仅作数据]\n${m.content || ""}` };
    if (m.tool_calls) {
      return {
        role: "assistant",
        content: [m.content || "", ...m.tool_calls.map((c) => `调用 ${c.function?.name}: ${c.function?.arguments || "{}"}`)].join("\n"),
      };
    }
    return m;
  });
}

export function toOpenAITools(tools) {
  return (tools || []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || tool.name,
      parameters: tool.inputSchema || tool.parameters || { type: "object", properties: {} },
    },
  }));
}

// The SDK retries empty/truncated replies by appending `[recovery]` system notes.
// History conversion drops system rows, so replay only the trailing ones (the
// retry in flight) as user turns; providers reject or ignore mid-history system.
export function pendingRecoveryNudges(messages) {
  const tail = [];
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "system") break;
    const text = textOf(m.parts).trim();
    if (text.startsWith("[recovery]") && !/^\[recovery\] Stopped:/.test(text)) tail.unshift({ role: "user", content: text });
  }
  return tail;
}

export function toOpenAIMessages(systemPrompt, sessionMessages, { stripTools = false, lastTurnNudge = "" } = {}) {
  let history = foldedToChromeHistory(sessionMessages);
  if (stripTools) history = withoutToolCalls(history);
  const msgs = [{ role: "system", content: systemPrompt || "" }, ...history, ...pendingRecoveryNudges(sessionMessages)];
  if (stripTools && lastTurnNudge) {
    msgs.push({ role: "system", content: lastTurnNudge });
  }
  return msgs;
}

export function fromChromeModelResult(result) {
  const parts = [];
  if (result?.reasoning) parts.push({ type: "reasoning", text: String(result.reasoning) });
  if (result?.content) parts.push({ type: "text", text: String(result.content) });
  const calls = (result?.toolCalls || []).filter((c) => c && c.name);
  for (const [i, call] of calls.entries()) {
    parts.push({
      type: "tool_call",
      toolCallId: call.id || `call_${i}`,
      name: call.name,
      input: parseToolArgs(call.arguments),
    });
  }
  const usage = result?.usage;
  const inputTokens = Number(usage?.promptTokens) || 0;
  const outputTokens = Number(usage?.completionTokens) || 0;
  return {
    assistantParts: parts.length ? parts : [{ type: "text", text: "" }],
    stopReason: calls.length ? "tool_use" : "end",
    finishReason: result?.finishReason || (calls.length ? "tool_calls" : "stop"),
    usage: usage
      ? {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          requests: 1,
        }
      : undefined,
  };
}

export function chromeToolsToContracts(tools) {
  return (tools || []).map((tool) => ({
    name: tool.name,
    description: tool.description || tool.name,
    inputSchema: tool.parameters || { type: "object", properties: {} },
    approvalMode: "never",
    sideEffectLevel: tool.name === "run_shell" ? "system" : "none",
    async execute(_ctx, args) {
      const content = await tool.execute(args || {}, {});
      return { ok: true, content: content == null ? "" : String(content) };
    },
  }));
}

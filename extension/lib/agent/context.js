/**
 * Pack messages for the model: repair tool-call sequences, compress old bulk.
 * Canonical history in the loop stays full; only the API payload is compacted.
 */

export const CHAR_BUDGET = 48000;
export const KEEP_TAIL = 8;
export const RUN_STALE_MS = 24 * 3600 * 1000;

export function stringifyContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text || "";
        if (part?.type === "image_url") return "【截图】";
        return "";
      })
      .join("");
  }
  return String(content);
}

export function messageChars(messages) {
  let n = 0;
  for (const m of messages || []) {
    n += stringifyContent(m.content).length;
    if (m.role === "assistant" && m.tool_calls) {
      for (const call of m.tool_calls) {
        n += (call.id || "").length + (call.function?.name || "").length + (call.function?.arguments || "").length;
      }
    }
    if (m.role === "tool") n += (m.tool_call_id || "").length;
  }
  return n;
}

export function cloneMessage(m) {
  if (!m) return m;
  const out = { role: m.role, content: m.content };
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (Array.isArray(m.tool_calls)) {
    out.tool_calls = m.tool_calls.map((c) => ({
      id: c.id,
      type: c.type || "function",
      function: {
        name: c.function?.name || c.name || "",
        arguments: c.function?.arguments || c.arguments || "{}",
      },
    }));
  }
  return out;
}

export function cloneHistory(list) {
  return (list || []).map(cloneMessage);
}

function normalizeToolCalls(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  return raw
    .map((c, i) => {
      const name = c?.function?.name || c?.name || "";
      if (!name) return null;
      return {
        id: String(c.id || `call_repair_${i}`),
        type: "function",
        function: {
          name,
          arguments: String(c.function?.arguments || c.arguments || "{}"),
        },
      };
    })
    .filter(Boolean);
}

/**
 * Make a history legal for chat/completions tool calling.
 * pending: tool_calls still missing a tool result (resume should execute these).
 */
export function repairMessages(messages, { completePending = false } = {}) {
  const out = [];
  const pending = new Map();
  let seq = 0;

  const flushPending = (reason) => {
    for (const [id, info] of pending) {
      out.push({
        role: "tool",
        tool_call_id: id,
        content: `【已修补】工具 ${info.name || id} 没有返回结果（${reason}）。`,
      });
    }
    pending.clear();
  };

  for (const raw of messages || []) {
    const role = raw?.role;
    if (role === "system") continue;

    if (role === "user") {
      if (completePending) flushPending("被新的用户消息打断");
      else if (pending.size) flushPending("被新的用户消息打断");
      const content = stringifyContent(raw.content);
      if (!content.trim()) continue;
      out.push({ role: "user", content });
      continue;
    }

    if (role === "assistant") {
      if (pending.size) flushPending("被下一条助手消息打断");
      const calls = normalizeToolCalls(raw.tool_calls);
      const content = stringifyContent(raw.content);
      if (!calls.length && !content.trim()) continue;
      const msg = { role: "assistant", content };
      if (calls.length) {
        msg.tool_calls = calls.map((c) => {
          seq += 1;
          const id = c.id || `call_repair_${seq}`;
          return { ...c, id };
        });
        for (const c of msg.tool_calls) {
          pending.set(c.id, {
            name: c.function.name,
            arguments: c.function.arguments || "{}",
          });
        }
      }
      out.push(msg);
      continue;
    }

    if (role === "tool") {
      const id = String(raw.tool_call_id || raw.id || "");
      if (!id || !pending.has(id)) continue;
      pending.delete(id);
      out.push({
        role: "tool",
        tool_call_id: id,
        content: stringifyContent(raw.content),
      });
    }
  }

  if (completePending && pending.size) flushPending("回合中断");

  return {
    messages: out,
    pending: [...pending.entries()].map(([id, info]) => ({ id, ...info })),
  };
}

function shrinkText(text, keep) {
  const s = String(text || "");
  if (s.length <= keep) return s;
  return `【已压缩 ${s.length}→${keep} 字】\n${s.slice(0, keep)}\n…`;
}

/**
 * Shrink old bulk (tool dumps, long user/assistant text). Tail messages stay intact.
 * Does not drop tool_call structure.
 */
export function compressMessages(messages, budget = CHAR_BUDGET, keepTail = KEEP_TAIL) {
  const msgs = cloneHistory(messages);
  const before = messageChars(msgs);
  if (before <= budget) return { messages: msgs, compressed: false, before, after: before };

  const cut = Math.max(0, msgs.length - keepTail);
  for (let i = 0; i < cut; i += 1) {
    const m = msgs[i];
    if (m.role === "tool" && stringifyContent(m.content).length > 480) {
      m.content = shrinkText(m.content, 480);
    } else if ((m.role === "user" || m.role === "assistant") && stringifyContent(m.content).length > 1600) {
      m.content = shrinkText(stringifyContent(m.content), 1200);
    }
  }

  let after = messageChars(msgs);
  if (after <= budget) return { messages: msgs, compressed: true, before, after };

  let keptTools = 0;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i].role !== "tool") continue;
    keptTools += 1;
    if (keptTools > 2 && stringifyContent(msgs[i].content).length > 240) {
      msgs[i].content = shrinkText(msgs[i].content, 240);
    }
  }

  after = messageChars(msgs);
  if (after <= budget) return { messages: msgs, compressed: true, before, after };

  for (const m of msgs) {
    if (m.role === "user" && stringifyContent(m.content).length > 8000) {
      m.content = shrinkText(stringifyContent(m.content), 6000);
    }
  }

  after = messageChars(msgs);
  return { messages: msgs, compressed: after < before, before, after };
}

export function packForModel(history, { budget = CHAR_BUDGET } = {}) {
  const repaired = repairMessages(history, { completePending: true }).messages;
  const compact = compressMessages(repaired, budget);
  return compact;
}

export function isResumableRun(run, now = Date.now()) {
  if (!run || run.status !== "running") return false;
  if (run.startedAt && now - Number(run.startedAt) > RUN_STALE_MS) return false;
  const hist = run.history || [];
  if (!hist.some((m) => m.role === "user")) return false;
  const { messages, pending } = repairMessages(hist, { completePending: false });
  if (pending.length) return true;
  const last = messages[messages.length - 1];
  if (!last) return false;
  if (last.role === "tool" || last.role === "user") return true;
  if (last.role === "assistant" && last.tool_calls?.length) return true;
  return false;
}

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

export function formatToolResultStub(name = "tool", ref = null) {
  const base = `[previous: used ${name} — output dropped from context]`;
  if (ref) return `${base} ref=${ref}`;
  return base;
}

export function extractHandle(text) {
  if (typeof text !== "string") return null;
  const m = /`?(art_[a-zA-Z0-9_-]+)`?/.exec(text);
  return m ? m[1] : null;
}

function findToolCallName(messages, toolCallId) {
  if (!toolCallId) return "tool";
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      const call = m.tool_calls.find((c) => c.id === toolCallId);
      if (call?.function?.name) return call.function.name;
    }
  }
  return "tool";
}

/**
 * Micro-compaction: tool results that have already been acted on by a subsequent assistant
 * are collapsed into lightweight stubs. The model view shrinks while keeping references intact.
 */
export function microCompactMessages(messages, { keepRecent = 2 } = {}) {
  const msgs = cloneHistory(messages);
  const toolIndices = [];
  msgs.forEach((m, idx) => {
    if (m.role === "tool") toolIndices.push(idx);
  });

  if (!toolIndices.length) return msgs;

  const keepFrom = Math.max(0, toolIndices.length - keepRecent);

  toolIndices.forEach((msgIdx, rank) => {
    // If it's within the most recent N tool results, keep it verbatim
    if (rank >= keepFrom) return;

    // Check if an assistant message exists AFTER this tool result (consumed)
    const hasSubsequentAssistant = msgs.slice(msgIdx + 1).some((m) => m.role === "assistant");
    if (!hasSubsequentAssistant) return;

    const m = msgs[msgIdx];
    const content = stringifyContent(m.content);
    // Don't compact already short stubs
    if (content.length <= 160 && content.includes("output dropped from context")) return;

    const name = findToolCallName(msgs, m.tool_call_id);
    const ref = extractHandle(content);
    m.content = formatToolResultStub(name, ref);
  });

  return msgs;
}

/**
 * Safe Session Cut: when session is over budget and has many turns (>= 14),
 * preserve the initial User intent (first user message) and the active tail window,
 * safely pruning intermediate closed turns without orphaning tool calls.
 */
export function safeSessionCut(messages, budget = CHAR_BUDGET, keepTail = KEEP_TAIL) {
  if (messages.length < 14) return messages;
  if (messageChars(messages) <= budget) return messages;

  const msgs = cloneHistory(messages);
  const firstUserIdx = msgs.findIndex((m) => m.role === "user");
  if (firstUserIdx === -1 || msgs.length <= keepTail + 2) return msgs;

  // Search backwards from the target cut point for a clean turn boundary (role === "user")
  let cutEnd = Math.max(firstUserIdx + 1, msgs.length - keepTail);
  while (cutEnd < msgs.length && msgs[cutEnd].role === "tool") {
    cutEnd += 1;
  }

  // Find where the wave before cutEnd starts
  while (cutEnd > firstUserIdx + 1 && msgs[cutEnd]?.role !== "user") {
    cutEnd -= 1;
  }

  if (cutEnd <= firstUserIdx + 1) return msgs;

  const head = msgs.slice(0, firstUserIdx + 1);
  const tail = msgs.slice(cutEnd);

  // Validate tool wave invariant in tail: if tail starts with orphaned tools, drop them
  const validTail = [];
  const pendingCalls = new Set();
  for (const m of tail) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      m.tool_calls.forEach((c) => pendingCalls.add(c.id));
      validTail.push(m);
    } else if (m.role === "tool") {
      if (pendingCalls.has(m.tool_call_id)) {
        pendingCalls.delete(m.tool_call_id);
        validTail.push(m);
      }
    } else {
      validTail.push(m);
    }
  }

  const prunedCount = cutEnd - (firstUserIdx + 1);
  const bridge = [
    {
      role: "user",
      content: `【系统提示：为优化上下文窗口，中间早前轮次已归档截断（共裁剪 ${prunedCount} 条记录），已保留初始目标与最近活跃窗口。可随时使用 search_tool_artifact 查阅早期文档】`,
    },
    {
      role: "assistant",
      content: "已获悉历史背景与初始目标，继续执行当前操作。",
    },
  ];

  return [...head, ...bridge, ...validTail];
}

/**
 * Multi-stage context compacting:
 * 1. Micro-compact / shrink older tool results outside keepTail
 * 2. Second-tier tool shrinking for multiple historical tools
 * 3. Safe Session Cut (preserving initial user goal and clean tail wave on long sessions)
 * 4. Fallback: Shrink remaining oversized text
 */
export function compressMessages(messages, budget = CHAR_BUDGET, keepTail = KEEP_TAIL) {
  let msgs = cloneHistory(messages);
  const before = messageChars(msgs);
  if (before <= budget) return { messages: msgs, compressed: false, before, after: before };

  // Stage 1: Shrink older tool results and long texts outside keepTail
  const cut = Math.max(0, msgs.length - keepTail);
  for (let i = 0; i < cut; i += 1) {
    const m = msgs[i];
    if (m.role === "tool") {
      const content = stringifyContent(m.content);
      if (content.length > 480) {
        const ref = extractHandle(content);
        const name = findToolCallName(msgs, m.tool_call_id);
        if (ref) {
          m.content = formatToolResultStub(name, ref);
        } else {
          m.content = shrinkText(content, 480);
        }
      }
    } else if ((m.role === "user" || m.role === "assistant") && stringifyContent(m.content).length > 1600) {
      m.content = shrinkText(stringifyContent(m.content), 1200);
    }
  }

  let after = messageChars(msgs);
  if (after <= budget) return { messages: msgs, compressed: true, before, after };

  // Stage 2: Shrink older tool results further if multiple tool results exist
  let keptTools = 0;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i].role !== "tool") continue;
    keptTools += 1;
    if (keptTools > 2 && stringifyContent(msgs[i].content).length > 240) {
      const ref = extractHandle(msgs[i].content);
      const name = findToolCallName(msgs, msgs[i].tool_call_id);
      if (ref) {
        msgs[i].content = formatToolResultStub(name, ref);
      } else {
        msgs[i].content = shrinkText(msgs[i].content, 240);
      }
    }
  }

  after = messageChars(msgs);
  if (after <= budget) return { messages: msgs, compressed: true, before, after };

  // Stage 3: For long conversations (>= 14 messages), perform Safe Session Cut
  if (msgs.length >= 14) {
    const sliced = safeSessionCut(msgs, budget, keepTail);
    const slicedChars = messageChars(sliced);
    if (slicedChars < after) {
      msgs = sliced;
      after = slicedChars;
      if (after <= budget) return { messages: msgs, compressed: true, before, after };
    }
  }

  // Stage 4: Remaining oversized text shrink
  for (const m of msgs) {
    if (m.role === "user" && stringifyContent(m.content).length > 8000) {
      m.content = shrinkText(stringifyContent(m.content), 6000);
    } else if (m.role === "assistant" && stringifyContent(m.content).length > 8000) {
      m.content = shrinkText(stringifyContent(m.content), 6000);
    }
  }

  after = messageChars(msgs);
  return { messages: msgs, compressed: after < before, before, after };
}

export function packForModel(history, { budget = CHAR_BUDGET, sessionId = "default" } = {}) {
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

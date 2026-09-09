/**
 * Conversation history. Stored in chrome.storage.local (no extra process).
 * Full session at pl.sessions.item.{id}; list metadata at pl.sessions.index.
 */

export const INDEX_KEY = "pl.sessions.index";
export const ACTIVE_KEY = "pl.sessions.active";
export const ITEM_PREFIX = "pl.sessions.item.";
export const MAX_SESSIONS = 200;
export const RUN_STALE_MS = 24 * 3600 * 1000;
const MAX_TEXT = 100000;
const MAX_RUN_MESSAGES = 80;
const MAX_TOOL_CONTENT = 12000;

export function itemKey(id) {
  return ITEM_PREFIX + id;
}

export function pageHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function mergePage(pages, page) {
  if (!page?.url) return Array.isArray(pages) ? [...pages] : [];
  const list = Array.isArray(pages) ? [...pages] : [];
  const next = {
    url: String(page.url),
    title: String(page.title || "").slice(0, 200),
    hostname: page.hostname || pageHost(page.url),
    kind: page.kind || "page",
  };
  const i = list.findIndex((p) => p.url === next.url);
  if (i === -1) list.push(next);
  else list[i] = { ...list[i], ...next };
  return list;
}

export function sessionTitle(session) {
  const first = (session.messages || []).find((m) => m.role === "user" && String(m.text || "").trim());
  const line = String(first?.text || "").split("\n")[0].trim();
  if (line) return line.slice(0, 48);
  const t = session.pages?.[0]?.title;
  if (t) return String(t).slice(0, 48);
  return "未命名对话";
}

export function formatWhen(ts, now = Date.now()) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const n = new Date(now);
  const today = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
  if (day === today) return `今天 ${hh}:${mm}`;
  return `${day} ${hh}:${mm}`;
}

function stringifyRunContent(content) {
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

export function normalizeLoopMessage(raw) {
  const role = raw?.role;
  if (role === "user" || role === "assistant") {
    const out = {
      role,
      content: stringifyRunContent(raw.content).slice(0, MAX_TEXT),
    };
    if (role === "assistant" && Array.isArray(raw.tool_calls) && raw.tool_calls.length) {
      const calls = raw.tool_calls
        .map((c, i) => {
          const name = c?.function?.name || c?.name || "";
          if (!name) return null;
          return {
            id: String(c.id || `call_${i}`),
            type: "function",
            function: {
              name,
              arguments: String(c.function?.arguments || c.arguments || "{}").slice(0, 8000),
            },
          };
        })
        .filter(Boolean);
      if (calls.length) out.tool_calls = calls;
    }
    return out;
  }
  if (role === "tool") {
    const id = String(raw.tool_call_id || "");
    if (!id) return null;
    return {
      role: "tool",
      tool_call_id: id,
      content: stringifyRunContent(raw.content).slice(0, MAX_TOOL_CONTENT),
    };
  }
  return null;
}

export function normalizeRun(raw, now = Date.now()) {
  if (!raw || raw.status !== "running") return undefined;
  if (!Array.isArray(raw.history) || !raw.history.length) return undefined;
  const startedAt = Number(raw.startedAt) || 0;
  if (startedAt && now - startedAt > RUN_STALE_MS) return undefined;
  const history = raw.history.map(normalizeLoopMessage).filter(Boolean).slice(-MAX_RUN_MESSAGES);
  if (!history.some((m) => m.role === "user")) return undefined;
  return {
    status: "running",
    history,
    lastText: String(raw.lastText || "").slice(0, MAX_TEXT),
    turnsUsed: Math.max(0, Number(raw.turnsUsed) || 0),
    startedAt,
  };
}

export function normalizeMessage(raw) {
  const trace = Array.isArray(raw?.trace)
    ? raw.trace
        .map((t) => ({ name: String(t?.name || ""), ok: t?.ok !== false }))
        .filter((t) => t.name)
        .slice(0, 40)
    : undefined;
  return {
    role: raw?.role === "user" ? "user" : "bot",
    text: String(raw?.text || "").slice(0, MAX_TEXT),
    error: raw?.error ? true : undefined,
    trace: trace?.length ? trace : undefined,
    hasImage: Boolean(raw?.image || raw?.hasImage) || undefined,
  };
}

export function normalizeSession(raw) {
  const now = Date.now();
  let pages = [];
  for (const page of raw?.pages || []) pages = mergePage(pages, page);
  const messages = Array.isArray(raw?.messages) ? raw.messages.map(normalizeMessage) : [];
  const session = {
    id: String(raw?.id || crypto.randomUUID()),
    createdAt: Number(raw?.createdAt) || now,
    updatedAt: Number(raw?.updatedAt) || now,
    pages,
    messages,
  };
  session.title = sessionTitle(session);
  const run = normalizeRun(raw?.run);
  if (run) session.run = run;
  const gid = Number(raw?.taskGroupId);
  if (Number.isInteger(gid) && gid >= 0) session.taskGroupId = gid;
  return session;
}

export function toSummary(session) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    title: session.title,
    messageCount: (session.messages || []).length,
    pages: (session.pages || []).map((p) => ({
      url: p.url,
      title: p.title,
      hostname: p.hostname,
      kind: p.kind,
    })),
  };
}

export function nextIndex(index, summary, max = MAX_SESSIONS) {
  const rest = (index || []).filter((s) => s.id !== summary.id);
  return [summary, ...rest].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, max);
}

export function filterSessions(index, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return index || [];
  return (index || []).filter((s) => {
    const blob = [
      s.title,
      ...(s.pages || []).flatMap((p) => [p.title, p.url, p.hostname]),
    ]
      .join(" ")
      .toLowerCase();
    return blob.includes(q);
  });
}

export function sessionFilename(session, ext) {
  const day = new Date(session.createdAt || Date.now()).toISOString().slice(0, 10);
  const slug = String(session.title || "session")
    .replace(/[\\/:*?"<>|\n\r]+/g, "")
    .trim()
    .slice(0, 32) || "session";
  return `pagelens-${day}-${slug}.${ext}`;
}

export function sessionToMarkdown(session) {
  const s = normalizeSession(session);
  const pages = s.pages.length
    ? s.pages.map((p) => `- ${p.title || p.hostname || "无标题"}\n  ${p.url}`).join("\n")
    : "- （未分享页面）";
  const turns = s.messages.map((m) => {
    const who = m.role === "user" ? "用户" : "PageLens";
    const bits = [`## ${who}`, "", m.text || "（空）"];
    if (m.hasImage) bits.push("", "（含截图，导出时未内嵌图片数据）");
    if (m.trace?.length) {
      bits.push("", `_工具：${m.trace.map((t) => (t.ok === false ? `${t.name} 失败` : t.name)).join(" → ")}_`);
    }
    return bits.join("\n");
  });
  return [
    `# ${s.title}`,
    "",
    `- 创建：${formatWhen(s.createdAt)}`,
    `- 更新：${formatWhen(s.updatedAt)}`,
    `- 消息：${s.messages.length} 条`,
    "",
    "## 页面",
    "",
    pages,
    "",
    ...turns,
    "",
  ].join("\n");
}

export function sessionsToMarkdown(sessions) {
  if (!sessions?.length) return "# PageLens 对话导出\n\n（没有会话）\n";
  const parts = sessions.map(sessionToMarkdown);
  return `# PageLens 对话导出\n\n共 ${sessions.length} 条\n\n---\n\n${parts.join("\n---\n\n")}`;
}

export function sessionsToJSON(sessions) {
  return JSON.stringify(
    {
      app: "PageLens",
      exportedAt: new Date().toISOString(),
      sessions: (sessions || []).map((s) => {
        const n = normalizeSession(s);
        delete n.run;
        return n;
      }),
    },
    null,
    2,
  );
}

async function localGet(keys) {
  return chrome.storage.local.get(keys);
}

async function localSet(obj) {
  await chrome.storage.local.set(obj);
}

async function localRemove(keys) {
  await chrome.storage.local.remove(keys);
}

export async function listSessions() {
  const data = await localGet(INDEX_KEY);
  return Array.isArray(data[INDEX_KEY]) ? data[INDEX_KEY] : [];
}

export async function loadSession(id) {
  if (!id) return null;
  const data = await localGet(itemKey(id));
  const raw = data[itemKey(id)];
  return raw ? normalizeSession(raw) : null;
}

export async function loadActiveSession() {
  const data = await localGet(ACTIVE_KEY);
  return loadSession(data[ACTIVE_KEY]);
}

export async function loadAllSessions() {
  const index = await listSessions();
  if (!index.length) return [];
  const bag = await localGet(index.map((s) => itemKey(s.id)));
  return index.map((s) => bag[itemKey(s.id)]).filter(Boolean).map(normalizeSession);
}

export async function saveSession(raw) {
  const session = normalizeSession(raw);
  session.updatedAt = Date.now();
  session.title = sessionTitle(session);
  if (!session.messages.length) return session;

  const index = await listSessions();
  const next = nextIndex(index, toSummary(session));
  const keep = new Set(next.map((s) => s.id));
  const drop = index.filter((s) => !keep.has(s.id)).map((s) => itemKey(s.id));

  await localSet({
    [INDEX_KEY]: next,
    [itemKey(session.id)]: session,
    [ACTIVE_KEY]: session.id,
  });
  if (drop.length) await localRemove(drop);
  return session;
}

export async function deleteSession(id) {
  const index = (await listSessions()).filter((s) => s.id !== id);
  const data = await localGet(ACTIVE_KEY);
  const patch = { [INDEX_KEY]: index };
  if (data[ACTIVE_KEY] === id) patch[ACTIVE_KEY] = "";
  await localSet(patch);
  await localRemove(itemKey(id));
  return index;
}

export async function clearActiveId() {
  await localSet({ [ACTIVE_KEY]: "" });
}

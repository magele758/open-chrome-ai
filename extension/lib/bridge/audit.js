/**
 * 外部 Agent 调用的持久审计：IndexedDB（pagelens-data / agentAuditLog），滚动保留 AUDIT_CAP 条。
 * 只记参数摘要：正文/代码/输入值只留长度，密钥类整项隐藏，URL 去掉 query 与 hash。
 */

import { idbGet, idbSet } from "../idb-kv.js";

export const AUDIT_KEY = "agentAuditLog";
export const AUDIT_CAP = 2000;
const MAX_STR = 120;

const SECRET_KEY = /token|secret|password|passwd|api.?key|cookie|auth/i;
const SHOWN_STRING_KEYS = new Set(["selector", "editorSelector", "titleSelector", "query", "url", "jobId", "tool", "key", "platform"]);

function stripUrl(value) {
  try {
    const u = new URL(value);
    return `${u.origin}${u.pathname}`;
  } catch {
    return value;
  }
}

function summarizeValue(key, value, depth) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value ?? null;
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") {
    if (!SHOWN_STRING_KEYS.has(key)) return `[${value.length} chars]`;
    const shown = key === "url" ? stripUrl(value) : value;
    return shown.length > MAX_STR ? `${shown.slice(0, MAX_STR)}…` : shown;
  }
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === "object") {
    if (depth >= 1) return "[object]";
    return summarizeArgs(value, depth + 1);
  }
  return `[${typeof value}]`;
}

export function summarizeArgs(args, depth = 0) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const out = {};
  for (const [key, value] of Object.entries(args)) out[key] = summarizeValue(key, value, depth);
  return out;
}

export function originOfUrl(url) {
  try {
    const u = new URL(String(url || ""));
    return u.origin === "null" ? `${u.protocol}//` : u.origin;
  } catch {
    return null;
  }
}

export function auditEntry({ ts, agent, agentId, sessionId, tool, origin, args, ok, code, confirmed = false, irreversible = null, optOut = false, ms }) {
  return {
    ts,
    agent: agent || "unknown",
    agentId: agentId || null,
    sessionId: sessionId || null,
    tool: String(tool || ""),
    origin: origin || null,
    argsSummary: summarizeArgs(args),
    ok: Boolean(ok),
    code: code || null,
    confirmed: Boolean(confirmed),
    ...(irreversible ? { irreversible: String(irreversible) } : {}),
    ...(optOut ? { optOut: true } : {}),
    ...(ms != null ? { ms } : {}),
  };
}

/**
 * 内存镜像 + 串行写回。SW 随时可能被回收，所以每次追加都尽快落盘；写入中又有新条目时合并成下一次写。
 */
export function createAuditLog({ cap = AUDIT_CAP, load = () => idbGet(AUDIT_KEY), save = (v) => idbSet(AUDIT_KEY, v) } = {}) {
  let entries = null;
  let loading = null;
  let writing = null;
  let dirty = false;

  async function ensure() {
    if (entries) return entries;
    loading ||= Promise.resolve()
      .then(load)
      .then((v) => {
        const prior = Array.isArray(v) ? v : [];
        entries = [...prior, ...(entries || [])].slice(-cap);
        return entries;
      })
      .catch(() => (entries ||= []));
    return loading;
  }

  function flush() {
    if (writing) {
      dirty = true;
      return writing;
    }
    writing = Promise.resolve()
      .then(() => save(entries.slice()))
      .catch(() => false)
      .finally(() => {
        writing = null;
        if (dirty) {
          dirty = false;
          flush();
        }
      });
    return writing;
  }

  return {
    async append(entry) {
      await ensure();
      entries.push(entry);
      if (entries.length > cap) entries.splice(0, entries.length - cap);
      await flush();
    },
    async list({ agentId, limit = 50 } = {}) {
      await ensure();
      const n = Math.max(1, Math.min(Number(limit) || 50, cap));
      const filtered = agentId ? entries.filter((e) => e.agentId === agentId) : entries;
      return filtered.slice(-n).reverse();
    },
    async clear() {
      await ensure();
      entries.length = 0;
      await flush();
    },
    async whenIdle() {
      while (writing) await writing;
    },
  };
}

let shared = null;
export function getAuditLog() {
  shared ||= createAuditLog();
  return shared;
}

/**
 * 待批准队列：无人值守时命中不可逆清单的调用返回 CONFIRMATION_REQUIRED + pendingId，
 * 用户事后在侧栏批准；之后同一调用（工具 + 参数一致）可消费一次批准继续执行。
 * 存储通过 { load, save } 适配，侧栏与 SW 可共用 chrome.storage.local。
 */

export const CONFIRMATION_REQUIRED = "CONFIRMATION_REQUIRED";
export const APPROVAL_STORAGE_KEY = "agentApprovalQueue";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX = 50;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** 工具 + 参数的稳定指纹；参数顺序不同视为同一调用 */
export function approvalKey(toolName, args = {}) {
  return `${String(toolName || "")}:${stable(args || {})}`;
}

function preview(args) {
  const text = stable(args || {});
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

function randomId() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `pend_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** chrome.storage 适配器 */
export function chromeStorageAdapter(area = globalThis.chrome?.storage?.local, key = APPROVAL_STORAGE_KEY) {
  return {
    async load() {
      const got = await area.get(key);
      return Array.isArray(got?.[key]) ? got[key] : [];
    },
    async save(list) {
      await area.set({ [key]: list });
    },
  };
}

export function memoryAdapter(initial = []) {
  let list = structuredClone(initial);
  return {
    async load() {
      return structuredClone(list);
    },
    async save(next) {
      list = structuredClone(next);
    },
  };
}

export function createApprovalQueue({ storage = memoryAdapter(), now = () => Date.now(), ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX } = {}) {
  async function read() {
    const t = now();
    return (await storage.load()).filter((e) => e && t - Number(e.createdAt || 0) < ttlMs && e.status !== "used");
  }
  async function write(list) {
    await storage.save(list.slice(-max));
  }
  /** principal 缺省匹配任意委托人；给定时只认该委托人入队的条目（外部 token 与侧栏用户互不消费） */
  const samePrincipal = (e, principal) => principal == null || e.principal === String(principal);
  async function take(status, toolName, args, principal) {
    const list = await read();
    const key = approvalKey(toolName, args);
    const entry = list.find((e) => e.key === key && e.status === status && samePrincipal(e, principal));
    if (!entry) return null;
    entry.status = "used";
    entry.usedAt = now();
    await storage.save(list.slice(-max));
    return entry;
  }
  return {
    /** 入队；同一委托人的同一调用已在等待时复用原条目 */
    async enqueue({ toolName, args = {}, reason = "", item = null, principal = "", sessionId = "" }) {
      const list = await read();
      const key = approvalKey(toolName, args);
      const existing = list.find((e) => e.key === key && e.status === "pending" && samePrincipal(e, principal));
      if (existing) return existing;
      const entry = {
        id: randomId(),
        key,
        toolName: String(toolName || ""),
        argsPreview: preview(args),
        reason: String(reason || "").slice(0, 300),
        item: item ? { id: item.id, label: item.label } : null,
        principal: String(principal || ""),
        sessionId: String(sessionId || ""),
        status: "pending",
        createdAt: now(),
        resolvedAt: null,
      };
      await write([...list, entry]);
      return entry;
    },
    async list({ status } = {}) {
      const list = await read();
      return status ? list.filter((e) => e.status === status) : list;
    },
    async get(id) {
      return (await read()).find((e) => e.id === id) || null;
    },
    /** 用户批准 / 拒绝 */
    async resolve(id, allow) {
      const list = await read();
      const entry = list.find((e) => e.id === id && e.status === "pending");
      if (!entry) return null;
      entry.status = allow ? "approved" : "rejected";
      entry.resolvedAt = now();
      await write(list);
      return entry;
    },
    /** 有匹配的已批准条目则标记为已用并返回（一次批准只放行一次） */
    async consumeApproved(toolName, args = {}, { principal } = {}) {
      return take("approved", toolName, args, principal);
    },
    /** 有匹配的已拒绝条目则标记为已用并返回：把拒绝结果告诉重试的 Agent 一次 */
    async consumeRejected(toolName, args = {}, { principal } = {}) {
      return take("rejected", toolName, args, principal);
    },
  };
}

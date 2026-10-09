/**
 * 网关会话的事件总线：chrome.tabs / webNavigation / downloads / JS 对话框 / bridge 任务进度
 * → 按会话过滤（token scope + origin 范围）→ 每会话环形缓冲（events_poll）+ 推送（port bridge.event）。
 *
 * 过滤规则（不泄露 token 范围外的标签）：
 *   - 事件类型要求的 scope（EVENT_SCOPES）token 必须持有；job.* 只发给同一 token。
 *   - 标签类事件：URL 在 token origins 内才发；标签从范围内跳到范围外时发一次 url/title 置空、redacted:true 的事件；
 *     关闭事件按最后已知 URL 判断。
 *   - 下载：url 或 referrer 在范围内才发，范围外的那个字段置空。
 *   - 对话框：所在标签 URL 在范围内才发。
 *   - 归属类事件（job.* / agent_task.* / approval.*）只发给发起方 token（event.agentId === token id）。
 */

import { BridgeError, ERROR_CODES } from "./protocol.js";
import { scopeAllows, tokenState, tokenUrlAllowed } from "./auth.js";

export const EVENT_TYPES = Object.freeze([
  "tab.created",
  "tab.updated",
  "tab.removed",
  "tab.activated",
  "navigation.completed",
  "download.created",
  "download.changed",
  "dialog.opened",
  "job.progress",
  "job.done",
  "agent_task.started",
  "agent_task.step",
  "agent_task.approval",
  "agent_task.finished",
  "approval.queued",
  "approval.resolved",
]);

/** null = 只要有效会话（归属类事件另按 token 过滤）。 */
export const EVENT_SCOPES = Object.freeze({
  "tab.created": "tabs:read",
  "tab.updated": "tabs:read",
  "tab.removed": "tabs:read",
  "tab.activated": "tabs:read",
  "navigation.completed": "tabs:read",
  "download.created": "downloads",
  "download.changed": "downloads",
  "dialog.opened": "page:read",
  "job.progress": null,
  "job.done": null,
  "agent_task.started": "agent:delegate",
  "agent_task.step": "agent:delegate",
  "agent_task.approval": "agent:delegate",
  "agent_task.finished": "agent:delegate",
  "approval.queued": null,
  "approval.resolved": null,
});

export const RING_SIZE = 200;
export const POLL_DEFAULT = 50;
export const POLL_MAX = 200;

const TAB_TYPES = new Set(["tab.created", "tab.updated", "tab.removed", "tab.activated", "navigation.completed"]);
const OWNED_PREFIXES = ["job.", "agent_task.", "approval."];
const isOwned = (type) => OWNED_PREFIXES.some((p) => type.startsWith(p));

function typeAllowed(record, type) {
  const scope = EVENT_SCOPES[type];
  return scope === null || scopeAllows(record, scope);
}

/** 展开 `*` / `tab.*` 这类通配；未知类型抛 BAD_ARGS。 */
export function expandEventTypes(types) {
  const list = types == null || (Array.isArray(types) && types.length === 0) ? ["*"] : types;
  if (!Array.isArray(list)) throw new BridgeError(ERROR_CODES.BAD_ARGS, "types 必须是字符串数组。");
  const out = new Set();
  for (const raw of list) {
    const t = String(raw || "").trim();
    if (t === "*") EVENT_TYPES.forEach((x) => out.add(x));
    else if (t.endsWith(".*")) {
      const hits = EVENT_TYPES.filter((x) => x.startsWith(t.slice(0, -1)));
      if (!hits.length) throw new BridgeError(ERROR_CODES.BAD_ARGS, `未知事件类型：${t}`, { details: { known: EVENT_TYPES } });
      hits.forEach((x) => out.add(x));
    } else if (EVENT_TYPES.includes(t)) out.add(t);
    else throw new BridgeError(ERROR_CODES.BAD_ARGS, `未知事件类型：${t}`, { details: { known: EVENT_TYPES } });
  }
  return out;
}

/**
 * 纯函数：决定一个事件对某个 token 是否可见，可见时返回（可能脱敏的）副本，否则 null。
 * @param prevUrl 该标签此前的 URL（用于“离开范围”时发脱敏事件）
 */
export function filterEventForToken(event, record, { prevUrl = null } = {}) {
  if (!event || !record || !EVENT_TYPES.includes(event.type)) return null;
  if (!typeAllowed(record, event.type)) return null;
  if (isOwned(event.type)) return event.agentId && event.agentId === record.id ? stripInternal(event) : null;
  const allowed = (u) => Boolean(u) && tokenUrlAllowed(record, u);
  if (TAB_TYPES.has(event.type)) {
    if (allowed(event.url)) return stripInternal(event);
    if (event.type !== "tab.removed" && allowed(prevUrl)) {
      return { ...stripInternal(event), url: null, title: null, redacted: true };
    }
    return null;
  }
  if (event.type === "dialog.opened") {
    return allowed(event.tabUrl || event.url) ? stripInternal(event) : null;
  }
  if (event.type.startsWith("download.")) {
    const urlOk = allowed(event.url) || allowed(event.finalUrl);
    const refOk = allowed(event.referrer);
    if (!urlOk && !refOk) return null;
    const out = stripInternal(event);
    if (!urlOk) {
      if ("url" in out) out.url = null;
      if ("finalUrl" in out) out.finalUrl = null;
      out.redacted = true;
    }
    if (!refOk && "referrer" in out) out.referrer = null;
    return out;
  }
  return null;
}

function stripInternal(event) {
  const { agentId, sessionId, tabUrl, ...rest } = event;
  return rest;
}

function clampInt(value, def, max) {
  const n = Number.isInteger(value) ? value : def;
  return Math.max(1, Math.min(max, n));
}

/**
 * @param loadTokens 每次投递前取最新 token 列表（吊销 / 改 origin 立即生效）
 */
export function createEventBus({ loadTokens = async () => [], now = () => Date.now(), ringSize = RING_SIZE } = {}) {
  const subs = new Map();
  const tabUrls = new Map();
  let sink = null;
  let chain = Promise.resolve();

  function subscribe(auth, types) {
    if (!auth?.sessionId) throw new BridgeError(ERROR_CODES.UNAUTHORIZED, "事件订阅只对网关会话开放。");
    const requested = expandEventTypes(types);
    const explicit = Array.isArray(types) && types.length && !types.includes("*");
    if (explicit) {
      const denied = [...requested].filter((t) => !typeAllowed(auth.record, t));
      if (denied.length) {
        throw new BridgeError(ERROR_CODES.SCOPE_DENIED, `token「${auth.record.name}」没有订阅 ${denied.join(", ")} 所需的权限。`, {
          details: { types: denied, scopes: denied.map((t) => EVENT_SCOPES[t]) },
        });
      }
    }
    let sub = subs.get(auth.sessionId);
    if (!sub) {
      sub = { sessionId: auth.sessionId, agentId: auth.record.id, agentName: auth.agentName, types: new Set(), ring: [], seq: 0 };
      subs.set(auth.sessionId, sub);
    }
    for (const t of requested) if (typeAllowed(auth.record, t)) sub.types.add(t);
    return { types: [...sub.types], since: sub.seq, push: Boolean(sink) };
  }

  function unsubscribe(sessionId, types) {
    const sub = subs.get(sessionId);
    if (!sub) return { types: [] };
    if (types == null || (Array.isArray(types) && types.length === 0)) {
      sub.types.clear();
    } else {
      for (const t of expandEventTypes(types)) sub.types.delete(t);
    }
    return { types: [...sub.types] };
  }

  function poll(sessionId, { since, max } = {}) {
    const sub = subs.get(sessionId);
    if (!sub) return { events: [], next: 0, dropped: false, subscribed: [] };
    const from = Number.isInteger(since) ? since : 0;
    const limit = clampInt(max, POLL_DEFAULT, POLL_MAX);
    const oldest = sub.ring.length ? sub.ring[0].seq : sub.seq + 1;
    const events = sub.ring.filter((e) => e.seq > from).slice(0, limit);
    const next = events.length ? events[events.length - 1].seq : Math.max(from, sub.seq);
    return {
      events,
      next,
      more: sub.ring.some((e) => e.seq > next),
      dropped: from + 1 < oldest,
      subscribed: [...sub.types],
    };
  }

  function deliver(sub, event) {
    sub.seq += 1;
    const out = { seq: sub.seq, ...event };
    sub.ring.push(out);
    while (sub.ring.length > ringSize) sub.ring.shift();
    if (sink) {
      try {
        sink(sub.sessionId, out);
      } catch {
        /* 推送失败不影响缓冲 */
      }
    }
  }

  async function dispatch(raw) {
    const event = { ts: now(), ...raw };
    let prevUrl = null;
    if (event.tabId != null && TAB_TYPES.has(event.type)) {
      prevUrl = tabUrls.get(event.tabId) || null;
      if (!event.url && prevUrl && (event.type === "tab.removed" || event.type === "tab.activated")) event.url = prevUrl;
      if (event.type === "tab.removed") tabUrls.delete(event.tabId);
      else if (event.url) tabUrls.set(event.tabId, event.url);
    }
    if (event.type === "dialog.opened" && event.tabId != null && !event.tabUrl) event.tabUrl = tabUrls.get(event.tabId) || null;
    const interested = [...subs.values()].filter((s) => s.types.has(event.type));
    if (!interested.length) return;
    const tokens = await loadTokens();
    const byId = new Map((tokens || []).map((t) => [t.id, t]));
    for (const sub of interested) {
      const record = byId.get(sub.agentId);
      if (!record || tokenState(record, now()) !== "active") continue;
      const visible = filterEventForToken(event, record, { prevUrl });
      if (visible) deliver(sub, visible);
    }
  }

  /** 事件按到达顺序串行处理（URL 跟踪依赖顺序）；返回该事件处理完的 promise。 */
  function emit(raw) {
    if (!raw?.type || !EVENT_TYPES.includes(raw.type)) return Promise.resolve();
    chain = chain.then(() => dispatch(raw)).catch(() => {});
    return chain;
  }

  return {
    subscribe,
    unsubscribe,
    poll,
    emit,
    /** 推送出口：(sessionId, event) => void；null 关闭推送（仍缓冲）。 */
    setSink(fn) {
      sink = typeof fn === "function" ? fn : null;
    },
    noteTabUrl(tabId, url) {
      if (tabId != null && url) tabUrls.set(tabId, url);
    },
    closeSession(sessionId) {
      subs.delete(sessionId);
    },
    closeAll() {
      subs.clear();
    },
    subscribed: (sessionId) => [...(subs.get(sessionId)?.types || [])],
    sessionCount: () => subs.size,
    idle: () => chain,
  };
}

/** delegate.js 的 agent_task.* 事件 → 总线事件；owner 只在 started 里带，后续按 taskId 记住。 */
export function agentTaskBusEvent(raw, owners) {
  if (!raw?.type || !String(raw.type).startsWith("agent_task.") || !raw.taskId) return null;
  const { type, taskId, at, ...payload } = raw;
  if (type === "agent_task.started") owners.set(taskId, raw.task?.owner || null);
  const agentId = owners.get(taskId) || null;
  if (type === "agent_task.finished") owners.delete(taskId);
  if (!agentId) return null;
  const event = { type, agentId, taskId, ...payload };
  if (at) event.ts = at;
  if (event.task) {
    const { owner, ...task } = event.task;
    event.task = task;
  }
  return event;
}

const TOKEN_PRINCIPAL = "token:";

/** 待批准队列（storage agentApprovalQueue）前后两版的差异 → approval.queued / approval.resolved；只认 token:<id> 委托人。 */
export function approvalEvents(oldList, newList) {
  const before = new Map((Array.isArray(oldList) ? oldList : []).map((e) => [e?.id, e]));
  const out = [];
  for (const e of Array.isArray(newList) ? newList : []) {
    if (!e?.id || !String(e.principal || "").startsWith(TOKEN_PRINCIPAL)) continue;
    const agentId = e.principal.slice(TOKEN_PRINCIPAL.length);
    const prev = before.get(e.id);
    const base = { agentId, pendingId: e.id, tool: e.toolName || "", ...(e.item?.id ? { item: e.item.id } : {}) };
    if (!prev && e.status === "pending") {
      out.push({ type: "approval.queued", ...base, reason: String(e.reason || "").slice(0, 300), ...(String(e.sessionId || "").startsWith("task_") ? { taskId: e.sessionId } : {}) });
    } else if (prev?.status === "pending" && (e.status === "approved" || e.status === "rejected")) {
      out.push({ type: "approval.resolved", ...base, status: e.status });
    }
  }
  return out;
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));

/**
 * 把 chrome.* 事件接到总线。api 缺哪个就跳过哪个（测试里传假对象）。
 * JS 对话框来自 chrome.debugger 的 Page.javascriptDialogOpening：只在 PageLens 已附加调试器的标签上可见。
 */
export function installEventSources(bus, api = globalThis.chrome, { onAgentTaskEvent = null, approvalKey = "agentApprovalQueue" } = {}) {
  const tabs = api?.tabs;
  const downloadUrls = new Map();
  tabs?.onCreated?.addListener?.((tab) => {
    bus.emit({ type: "tab.created", tabId: tab.id, windowId: tab.windowId, url: tab.url || tab.pendingUrl || "", title: tab.title || "" });
  });
  tabs?.onUpdated?.addListener?.((tabId, change, tab) => {
    if (change?.status !== "complete" && !change?.url) return;
    bus.emit({
      type: "tab.updated",
      tabId,
      windowId: tab?.windowId,
      url: change.url || tab?.url || "",
      title: tab?.title || "",
      status: change.status || tab?.status || null,
    });
  });
  tabs?.onRemoved?.addListener?.((tabId, info) => {
    bus.emit({ type: "tab.removed", tabId, windowId: info?.windowId, windowClosing: Boolean(info?.isWindowClosing) });
  });
  tabs?.onActivated?.addListener?.(async ({ tabId, windowId }) => {
    let url = "";
    let title = "";
    try {
      const tab = await tabs.get(tabId);
      url = tab?.url || "";
      title = tab?.title || "";
    } catch {
      /* 标签已关闭 */
    }
    bus.emit({ type: "tab.activated", tabId, windowId, url, title });
  });
  api?.webNavigation?.onCompleted?.addListener?.((d) => {
    if (d?.frameId !== 0) return;
    bus.emit({ type: "navigation.completed", tabId: d.tabId, url: d.url || "" });
  });
  const downloads = api?.downloads;
  downloads?.onCreated?.addListener?.((item) => {
    downloadUrls.set(item.id, pick(item, ["url", "finalUrl", "referrer"]));
    bus.emit({
      type: "download.created",
      downloadId: item.id,
      ...pick(item, ["url", "finalUrl", "referrer", "filename", "mime", "state", "totalBytes"]),
    });
  });
  downloads?.onChanged?.addListener?.(async (delta) => {
    let known = downloadUrls.get(delta.id);
    if (!known && downloads.search) {
      const [item] = await downloads.search({ id: delta.id }).catch(() => []);
      known = item ? pick(item, ["url", "finalUrl", "referrer"]) : {};
      downloadUrls.set(delta.id, known);
    }
    const changes = {};
    for (const key of ["state", "filename", "error", "paused", "exists", "totalBytes", "endTime"]) {
      if (delta[key]?.current !== undefined) changes[key] = delta[key].current;
    }
    if (!Object.keys(changes).length) return;
    if (changes.state === "complete" || changes.state === "interrupted") downloadUrls.delete(delta.id);
    bus.emit({ type: "download.changed", downloadId: delta.id, ...known, ...changes });
  });
  if (typeof onAgentTaskEvent === "function") {
    const owners = new Map();
    onAgentTaskEvent((raw) => {
      const event = agentTaskBusEvent(raw, owners);
      if (event) bus.emit(event);
    });
  }
  api?.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== "local" || !changes?.[approvalKey]) return;
    for (const event of approvalEvents(changes[approvalKey].oldValue, changes[approvalKey].newValue)) bus.emit(event);
  });
  api?.debugger?.onEvent?.addListener?.((source, method, params) => {
    if (method !== "Page.javascriptDialogOpening" || source?.tabId == null) return;
    bus.emit({
      type: "dialog.opened",
      tabId: source.tabId,
      url: params?.url || "",
      dialogType: params?.type || "alert",
      message: String(params?.message || "").slice(0, 500),
    });
  });
}

/**
 * 多会话：标签租约 + 按标签分队的独占输入队列 + 每个 Agent 的标签组。
 *
 * - 租约：会话用 tab_claim 独占一个标签；别的调用方（其他会话或旧的无 token 入口）在该标签上调用
 *   会改动页面的工具（LEASE_GUARDED_SCOPES）时得到 TAB_LEASED。只读工具不受影响。
 *   会话打开的新标签自动归它；会话断开、标签关闭时租约释放。只在内存里：SW 重启时 native port 断开，会话也随之消失。
 * - 队列：exclusive 工具按标签串行，不同标签并行；碰剪贴板的工具额外占全局 "clipboard" 键，抢焦点的占 "focus" 键。
 */

import { BridgeError, ERROR_CODES } from "./protocol.js";

export const LEASE_GUARDED_SCOPES = Object.freeze(["page:act", "page:js", "tabs:manage", "upload"]);
export const CLIPBOARD_TOOLS = Object.freeze(["paste_rich_trusted"]);
export const TAB_OPENING_TOOLS = Object.freeze(["open_tab", "create_window"]);

const GROUP_COLORS = ["blue", "purple", "cyan", "orange", "green", "pink", "yellow", "red"];

export function leaseGuarded(tool) {
  return Boolean(tool?.needsTab) && LEASE_GUARDED_SCOPES.includes(tool.scope);
}

/** 独占队列的键：同一标签串行；剪贴板 / 抢焦点是全局资源。 */
export function queueKeys(tool, args = {}, tabId = null) {
  const keys = [];
  if (tabId != null) keys.push(`tab:${tabId}`);
  if (tool?.scope === "clipboard" || CLIPBOARD_TOOLS.includes(tool?.name)) keys.push("clipboard");
  if (tool?.focus === "activates" || args?.activate === true) keys.push("focus");
  if (!keys.length) keys.push("global");
  return keys;
}

/** 多键串行队列：fn 等所有键上之前的任务结束后才跑；不同键互不阻塞。 */
export function createKeyedQueue() {
  const tails = new Map();
  return {
    run(keys, fn) {
      const prev = keys.map((k) => tails.get(k) || Promise.resolve());
      const run = Promise.all(prev).then(fn, fn);
      const settled = run.catch(() => {});
      for (const k of keys) {
        tails.set(k, settled);
        settled.then(() => {
          if (tails.get(k) === settled) tails.delete(k);
        });
      }
      return run;
    },
    pending: () => tails.size,
  };
}

/** 从工具结果里找出新开的标签 id（open_tab / create_window）。 */
export function openedTabIds(toolName, result) {
  if (!TAB_OPENING_TOOLS.includes(toolName) || !result) return [];
  if (Number.isInteger(result.tabId)) return [result.tabId];
  return (result.tabs || []).map((t) => t?.id).filter(Number.isInteger);
}

/**
 * @param groups 可选标签组 adapter 或返回 adapter 的函数（chrome.tabs.group + chrome.tabGroups）
 */
export function createTabLeases({ now = () => Date.now(), groups = null, tabs = null } = {}) {
  const leases = new Map();
  const groupBySession = new Map();
  const groupedTabs = new Map();
  let colorIdx = 0;

  const getGroups = () => typeof groups === "function" ? groups() : groups;

  function trackTaskGroup(tabIds, groupId) {
    if (groupId != null) for (const id of tabIds) groupedTabs.set(id, { groupId });
  }

  function isTaskGroupedTab(tab) {
    return tab?.groupId >= 0 && groupedTabs.get(tab.id)?.groupId === tab.groupId;
  }

  function takeAdoptedGroup(tabId, lease) {
    const group = groupedTabs.get(tabId);
    if (group?.lease !== lease) return null;
    groupedTabs.delete(tabId);
    return [tabId, group.groupId];
  }

  async function ungroupSafe(entries) {
    const tg = getGroups();
    if (!entries.length || typeof tg?.ungroup !== "function") return;
    const ids = await Promise.all(entries.map(async ([id, groupId]) => {
      if (!tabs?.get) return id;
      try {
        return (await tabs.get(id))?.groupId === groupId ? id : null;
      } catch {
        return null;
      }
    }));
    const remaining = ids.filter((id) => id != null && !groupedTabs.has(id));
    if (remaining.length) await tg.ungroup(remaining);
  }

  const holderInfo = (lease) => ({ agentName: lease.agentName || "agent", since: lease.since });

  function holder(tabId) {
    return leases.get(tabId) || null;
  }

  /** owner: { sessionId, agentId, agentName }；null = 无 token 的旧入口。 */
  function check(tabId, owner) {
    const lease = leases.get(tabId);
    if (!lease || (owner?.sessionId && lease.sessionId === owner.sessionId)) return;
    throw new BridgeError(ERROR_CODES.TAB_LEASED, `标签 ${tabId} 已被「${lease.agentName || "另一个 Agent"}」占用。`, {
      retryable: true,
      hint: "换一个标签，或等对方 tab_release / 断开后重试。",
      details: { tabId, holder: holderInfo(lease) },
    });
  }

  function claim(tabId, owner) {
    if (!owner?.sessionId) throw new BridgeError(ERROR_CODES.UNAUTHORIZED, "标签租约只对网关会话开放。");
    check(tabId, owner);
    const existing = leases.get(tabId);
    if (!existing) leases.set(tabId, { sessionId: owner.sessionId, agentId: owner.agentId, agentName: owner.agentName, since: now() });
    return { tabId, leased: true, since: leases.get(tabId).since };
  }

  function release(tabId, sessionId) {
    const lease = leases.get(tabId);
    if (!lease) return false;
    if (lease.sessionId !== sessionId) check(tabId, { sessionId });
    leases.delete(tabId);
    const grouped = takeAdoptedGroup(tabId, lease);
    if (grouped) ungroupSafe([grouped]).catch(() => {});
    return true;
  }

  function releaseSession(sessionId) {
    const freed = [];
    const toUngroup = [];
    for (const [tabId, lease] of leases) {
      if (lease.sessionId === sessionId) {
        leases.delete(tabId);
        freed.push(tabId);
        const grouped = takeAdoptedGroup(tabId, lease);
        if (grouped) toUngroup.push(grouped);
      }
    }
    groupBySession.delete(sessionId);
    ungroupSafe(toUngroup).catch(() => {});
    return freed;
  }

  function owned(sessionId) {
    return [...leases].filter(([, l]) => l.sessionId === sessionId).map(([tabId]) => tabId);
  }

  /** 会话新开的标签：归它所有，并放进它的标签组（有 tabGroups 时）。失败不影响调用结果。 */
  async function adopt(tabIds, owner) {
    if (!owner?.sessionId || !tabIds.length) return;
    for (const id of tabIds) claim(id, owner);
    const tg = getGroups();
    if (!tg) return;
    const adopted = tabIds.map((id) => [id, leases.get(id)]);
    try {
      const known = groupBySession.get(owner.sessionId);
      const groupId = await tg.group(tabIds, known ?? undefined);
      if (groupId == null) return;
      const orphaned = [];
      for (const [id, lease] of adopted) {
        if (leases.get(id) === lease) groupedTabs.set(id, { groupId, lease });
        else orphaned.push([id, groupId]);
      }
      ungroupSafe(orphaned).catch(() => {});
      if (orphaned.length === adopted.length) return;
      if (groupId !== known) {
        groupBySession.set(owner.sessionId, groupId);
        const color = GROUP_COLORS[colorIdx++ % GROUP_COLORS.length];
        await tg.update(groupId, { title: `Agent: ${owner.agentName || "agent"}`, color });
      }
    } catch {
      groupBySession.delete(owner.sessionId);
    }
  }

  return {
    holder,
    check,
    claim,
    release,
    releaseSession,
    owned,
    adopt,
    trackTaskGroup,
    isTaskGroupedTab,
    dropTab: (tabId) => {
      groupedTabs.delete(tabId);
      return leases.delete(tabId);
    },
    clear: () => {
      const toUngroup = [...leases].map(([id, lease]) => takeAdoptedGroup(id, lease)).filter(Boolean);
      leases.clear();
      groupBySession.clear();
      groupedTabs.clear();
      ungroupSafe(toUngroup).catch(() => {});
    },
    size: () => leases.size,
  };
}

export function chromeTabGroups(api = globalThis.chrome) {
  if (typeof api?.tabs?.group !== "function" || typeof api?.tabGroups?.update !== "function") return null;
  return {
    async group(tabIds, groupId, { strict = false, createProperties } = {}) {
      const target =
        groupId == null
          ? { tabIds, ...(createProperties ? { createProperties } : {}) }
          : { tabIds, groupId };
      try {
        return await api.tabs.group(target);
      } catch (err) {
        if (groupId == null || strict) throw err;
        return api.tabs.group({ tabIds });
      }
    },
    ...(typeof api.tabs?.ungroup === "function" ? { ungroup: (tabIds) => api.tabs.ungroup(tabIds) } : {}),
    ...(typeof api.tabGroups?.get === "function" ? { get: (groupId) => api.tabGroups.get(groupId) } : {}),
    ...(typeof api.tabGroups?.query === "function" ? { query: (queryInfo = {}) => api.tabGroups.query(queryInfo) } : {}),
    update: (groupId, props) => api.tabGroups.update(groupId, props),
    ...(typeof api.tabGroups?.move === "function" ? { move: (groupId, props) => api.tabGroups.move(groupId, props) } : {}),
  };
}

// Side panels and the extension worker share an origin and therefore the same Web Locks.
export function withWindowTask(windowId, run) {
  if (!Number.isInteger(windowId) || windowId < 0) throw new Error("无法确定任务所属窗口。");
  return navigator.locks.request(`pagelens-agent-window-${windowId}`, { ifAvailable: true }, async (lock) => {
    if (!lock) throw Object.assign(new Error("此窗口已有任务运行。请在独立窗口开始另一项任务，或等当前任务结束。"), { code: "WINDOW_BUSY" });
    return run();
  });
}

// Window-bound browser operations always use the window captured by the caller.
export async function tabInWindow(tabId, windowId, api = globalThis.chrome) {
  const tab = await api.tabs.get(tabId);
  if (windowId != null && tab?.windowId !== windowId) {
    throw Object.assign(new Error("标签页不在任务所属窗口，已停止操作该页。"), { code: "WINDOW_SCOPE" });
  }
  return tab;
}

export async function groupInWindow(groupId, windowId, api = globalThis.chrome) {
  const group = await api.tabGroups.get(groupId);
  if (windowId != null && group?.windowId !== windowId) {
    throw Object.assign(new Error("标签组不在任务所属窗口，已停止操作该标签组。"), { code: "WINDOW_SCOPE" });
  }
  return group;
}

export function tabQuery(windowId, currentWindow = true) {
  if (windowId != null) return { windowId };
  return currentWindow ? { currentWindow: true } : {};
}

export function tabGroupQuery(windowId, currentWindow = true, api = globalThis.chrome) {
  if (windowId != null) return { windowId };
  if (currentWindow && api?.windows?.WINDOW_ID_CURRENT != null) {
    return { windowId: api.windows.WINDOW_ID_CURRENT };
  }
  return {};
}

function requireWindow(requested, windowId) {
  if (requested != null && requested !== windowId && requested !== chrome.windows?.WINDOW_ID_CURRENT) {
    throw new Error("只能操作任务所属窗口。");
  }
}

async function checkGroup(id, windowId) {
  const group = await chrome.tabGroups.get(id);
  if (group.windowId !== windowId) throw new Error("标签组不在任务所属窗口。");
}

// Normalize raw Chrome calls too, including optional tab IDs and nested destination IDs.
export async function scopeChromeCall(method, params, windowId, defaultTabId) {
  const [first, second] = params;
  async function checkedIds(ids) {
    for (const id of [].concat(ids)) await tabInWindow(id, windowId);
    return ids;
  }
  switch (method) {
    case "tabs.query": {
      const { currentWindow, lastFocusedWindow, ...query } = first || {};
      requireWindow(query.windowId, windowId);
      return [method, [{ ...query, windowId }]];
    }
    case "tabs.create":
    case "tabs.highlight":
    case "tabGroups.query":
      requireWindow(first?.windowId, windowId);
      if (first?.openerTabId != null) await checkedIds(first.openerTabId);
      return [method, [{ ...first, windowId }]];
    case "tabs.group": {
      await checkedIds(first?.tabIds);
      if (first.groupId != null) {
        await checkGroup(first.groupId, windowId);
        return [method, params];
      }
      requireWindow(first.createProperties?.windowId, windowId);
      return [method, [{ ...first, createProperties: { windowId } }]];
    }
    case "tabGroups.move":
      await checkGroup(first, windowId);
      requireWindow(second?.windowId, windowId);
      return [method, [first, { ...second, windowId }]];
    case "tabGroups.update":
    case "tabGroups.get":
      await checkGroup(first, windowId);
      requireWindow(second?.windowId, windowId);
      return [method, params];
    case "tabs.move":
      await checkedIds(first);
      requireWindow(second?.windowId, windowId);
      return [method, [first, { ...second, windowId }]];
    case "tabs.ungroup":
    case "tabs.remove":
      await checkedIds(first);
      requireWindow(second?.windowId, windowId);
      return [method, params];
    case "tabs.get":
    case "tabs.duplicate":
    case "tabs.update":
    case "tabs.reload":
    case "tabs.goBack":
    case "tabs.goForward":
    case "tabs.detectLanguage":
    case "tabs.getZoom":
    case "tabs.setZoom":
    case "tabs.discard": {
      const implicit = typeof first !== "number" || (method === "tabs.setZoom" && params.length === 1);
      const id = implicit ? defaultTabId : first;
      await checkedIds(id);
      const rest = implicit ? params : params.slice(1);
      if (rest[0]?.openerTabId != null) await checkedIds(rest[0].openerTabId);
      return [method, [id, ...rest]];
    }
    case "windows.getCurrent":
      return ["windows.get", [windowId, ...params]];
    case "windows.get":
      requireWindow(first, windowId);
      return [method, [windowId, ...params.slice(1)]];
    case "webNavigation.getFrame":
    case "webNavigation.getAllFrames":
      await checkedIds(first?.tabId);
      return [method, params];
    case "action.getTitle":
    case "action.getBadgeText":
    case "action.setBadgeText":
      if (first?.tabId != null) await checkedIds(first.tabId);
      return [method, params];
    default:
      if (/^(tabs|tabGroups|windows|webNavigation)\./.test(method)) {
        throw new Error("窗口任务不能通过此操作切换、创建或控制其他窗口。");
      }
      return [method, params];
  }
}

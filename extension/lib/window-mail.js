import { DELEGATE_STORAGE_KEY, MAX_CONCURRENT_TASKS } from "./agent/delegate.js";

export const mailKey = (id) => `pl.windowMail.${id}`;
export const WORK_STATUS = { running: "执行中", done: "已完成", failed: "失败", cancelled: "已取消", needs_approval: "待批准" };

export async function listPeerWindows(from) {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const source = windows.find(w => w.id === from);
  if (!source) throw new Error("发起窗口已关闭。");
  return windows.filter(w => w.id !== from && w.incognito === source.incognito).map(w => w.id);
}

function taskEntry(t) {
  return {
    id: t.id, kind: "task", from: t.requesterWindowId, to: t.windowId, text: t.prompt,
    at: t.finishedAt || t.createdAt, status: t.status,
    result: t.status === "running" ? "" : t.error?.message || t.answer || "",
  };
}

export async function readWindowMail(windowId) {
  const key = mailKey(windowId);
  const data = await chrome.storage.session.get([key, DELEGATE_STORAGE_KEY]);
  const tasks = (data[DELEGATE_STORAGE_KEY] || []).filter(t =>
    Number.isInteger(t.requesterWindowId) && (t.windowId === windowId || t.requesterWindowId === windowId));
  return [...(data[key] || []), ...tasks.map(taskEntry)].sort((a, b) => b.at - a.at);
}

export async function sendWindowMail(from, to, kind, text, capsule, requestKey) {
  const response = await chrome.runtime.sendMessage({ type: "pl.windowMail.send", from, to, kind, text, capsule, requestKey });
  if (!response?.ok) throw new Error(response?.error || "窗口消息发送失败。");
  return response.entry;
}

// Subscribe before the first read so a fast return cannot race the subscription.
export function waitForWindowResult(from, id, signal) {
  return new Promise((resolve, reject) => {
    function finish(fn, value) {
      chrome.storage.onChanged.removeListener(changed);
      signal?.removeEventListener("abort", abort);
      fn(value);
    }
    async function abort() {
      try {
        await chrome.runtime.sendMessage({ type: "pl.windowMail.cancel", from, id });
      } catch { /* 本地等待仍要结束 */ }
      finish(reject, new Error("已停止等待，该委派已取消，不会再有结果进收件箱。"));
    }
    function inspect(tasks) {
      const task = tasks?.find(t => t.id === id && t.requesterWindowId === from);
      if (!task) finish(reject, new Error("委派记录已过期。"));
      else if (task.status !== "running") finish(resolve, taskEntry(task));
    }
    function changed(changes, area) {
      if (area === "session" && changes[DELEGATE_STORAGE_KEY]) inspect(changes[DELEGATE_STORAGE_KEY].newValue);
    }
    chrome.storage.onChanged.addListener(changed);
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    chrome.storage.session.get(DELEGATE_STORAGE_KEY).then(data => inspect(data[DELEGATE_STORAGE_KEY]), err => finish(reject, err));
  });
}

function requireSidePanelSender(sender) {
  const panelUrl = chrome.runtime.getURL("sidepanel/index.html");
  if (!sender || sender.tab || sender.url !== panelUrl) throw new Error("仅侧栏可发送窗口消息。");
}

// Only the context for this sender counts. Missing documentId or windowId -1 is not a match.
async function boundWindowId(sender) {
  if (!sender.documentId) return null;
  const panelUrl = chrome.runtime.getURL("sidepanel/index.html");
  const panels = await chrome.runtime.getContexts({
    contextTypes: ["SIDE_PANEL"], documentUrls: [panelUrl], documentIds: [sender.documentId],
  });
  const mine = panels.find(p => p.documentId === sender.documentId);
  if (!mine || !Number.isInteger(mine.windowId) || mine.windowId < 0) return null;
  return mine.windowId;
}

export function installWindowMail(manager) {
  async function deliver(msg, sender) {
    const { from, to, kind } = msg;
    requireSidePanelSender(sender);
    if (await boundWindowId(sender) !== from) throw new Error("发送侧栏与窗口不匹配。");
    const text = String(msg.text ?? "").trim();
    if (!text || text.length > 8000) throw new Error("消息长度须为 1 至 8000 个字符。");
    const requestKey = typeof msg.requestKey === "string" ? msg.requestKey.slice(0, 500) : "";
    async function startInWindow(windowId) {
      const [tab] = await chrome.tabs.query({ windowId, active: true });
      const task = await manager.start({
        peerRequestKey: requestKey, requesterWindowId: from, windowId, tabId: tab?.id, sourceUrl: tab?.url || "",
        prompt: text, capsule: kind === "auto_task" ? (msg.capsule || {}) : msg.capsule,
        session: { agentName: `窗口 ${from}`, tokenId: `panel-window:${from}`, modelPlanned: kind === "auto_task" || kind === "task" },
      });
      return taskEntry(task);
    }
    if (kind === "auto_task") {
      if (!requestKey) throw new Error("缺少自动分工的任务标识。");
      // Serialize allocation only. Each model run holds its own window lock.
      return navigator.locks.request("pl.windowMail.allocate", async () => {
        const previous = (await manager.list()).find(t => t.requesterWindowId === from &&
          t.peerRequestKey === requestKey && t.prompt === text);
        if (previous) return taskEntry(previous);
        if (manager.runningCount() >= MAX_CONCURRENT_TASKS) throw new Error("后台委托任务已满，请等待已有任务完成。");
        const parent = await chrome.windows.get(from);
        if (parent.type !== "normal") throw new Error("请从普通浏览器窗口发起自动分工。");
        const win = await chrome.windows.create({ type: "normal", incognito: parent.incognito, focused: false, url: "about:blank" });
        try {
          return await startInWindow(win.id);
        } catch (err) {
          // Roll back only the original empty work window if the user hasn't used it.
          const tabs = await chrome.tabs.query({ windowId: win.id }).catch(() => []);
          if (tabs.length === 1 && tabs[0].id === win.tabs?.[0]?.id &&
              tabs[0].url === "about:blank" && !tabs[0].pendingUrl) {
            await chrome.windows.remove(win.id).catch(() => {});
          }
          throw err;
        }
      });
    }
    if (!(await listPeerWindows(from)).includes(to)) throw new Error("请选择同一浏览模式下另一个已打开的窗口。");
    if (kind === "task") return startInWindow(to);
    if (kind !== "message") throw new Error("未知消息类型。");
    return navigator.locks.request("pl.windowMail.write", async () => {
      const keys = [mailKey(from), mailKey(to)];
      const data = await chrome.storage.session.get(keys);
      if (requestKey) {
        const prior = (data[keys[0]] || []).find(e => e.requestKey === requestKey && e.from === from && e.to === to && e.text === text);
        if (prior) return prior;
      }
      const entry = { id: crypto.randomUUID(), kind, from, to, text, at: Date.now(), requestKey };
      const update = {};
      for (const key of keys) update[key] = [...(data[key] || []).slice(-49), entry];
      await chrome.storage.session.set(update);
      return entry;
    });
  }
  async function cancelWaiting(msg, sender) {
    requireSidePanelSender(sender);
    const bound = await boundWindowId(sender);
    if (bound == null || bound !== msg.from) return;
    const task = (await manager.list()).find(t => t.id === msg.id && t.requesterWindowId === bound && t.status === "running");
    if (task) await manager.cancel(task.id);
  }
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (msg?.type === "pl.windowMail.cancel") {
      cancelWaiting(msg, sender).then(() => respond({ ok: true }), err => respond({ ok: false, error: err.message }));
      return true;
    }
    if (msg?.type !== "pl.windowMail.send") return false;
    deliver(msg, sender).then(entry => respond({ ok: true, entry }), err => respond({ ok: false, error: err.message }));
    return true;
  });
  chrome.windows.onRemoved.addListener(async id => {
    try {
      await chrome.storage.session.remove(mailKey(id));
      const tasks = await manager.list();
      await Promise.all(tasks.filter(t => t.requesterWindowId != null && t.status === "running" &&
        (t.windowId === id || t.requesterWindowId === id)).map(t => manager.cancel(t.id)));
    } catch (err) {
      console.warn("[pagelens] 关闭窗口时清理任务失败", err);
    }
  });
}

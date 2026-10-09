/**
 * inbox 页面动作的用户确认：SW 弹出扩展小窗，等用户点允许/拒绝；超时或关窗按拒绝处理。
 * 小窗每隔几秒发 ping，让等待期间的 Service Worker 不被回收。
 */

export const CONFIRM_TIMEOUT_MS = 60 * 1000;
export const CONFIRM_PAGE = "sidepanel/inbox-confirm.html";

export function createConfirmBroker({
  openWindow,
  closeWindow = async () => {},
  timeoutMs = CONFIRM_TIMEOUT_MS,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
}) {
  const pending = new Map();
  let seq = 0;

  function settle(id, approved, reason) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimer(entry.timer);
    if (entry.windowId != null) closeWindow(entry.windowId).catch?.(() => {});
    entry.resolve({ approved, reason });
    return true;
  }

  async function request(summary) {
    seq += 1;
    const id = `c${now()}-${seq}`;
    const result = new Promise((resolve) => {
      const timer = setTimer(() => settle(id, false, "timeout"), timeoutMs);
      pending.set(id, { summary, resolve, timer, windowId: null, deadline: now() + timeoutMs });
    });
    try {
      const windowId = await openWindow(`${CONFIRM_PAGE}?id=${encodeURIComponent(id)}`);
      const entry = pending.get(id);
      if (entry) entry.windowId = windowId ?? null;
      else if (windowId != null) closeWindow(windowId).catch?.(() => {});
    } catch (err) {
      settle(id, false, `confirm window failed: ${err?.message || err}`);
    }
    return result;
  }

  /** 返回 undefined 表示不是本模块的消息。 */
  function handleMessage(msg) {
    const id = String(msg?.id || "");
    if (msg?.type === "pl.inboxConfirm.get") {
      const entry = pending.get(id);
      if (!entry) return { ok: false, error: "确认请求已结束" };
      return { ok: true, summary: entry.summary, remainingMs: Math.max(0, entry.deadline - now()) };
    }
    if (msg?.type === "pl.inboxConfirm.ping") return { ok: pending.has(id) };
    if (msg?.type === "pl.inboxConfirm.answer") {
      return { ok: settle(id, msg.approved === true, msg.approved === true ? "approved" : "rejected") };
    }
    return undefined;
  }

  function onWindowRemoved(windowId) {
    for (const [id, entry] of pending) {
      if (entry.windowId === windowId) settle(id, false, "window closed");
    }
  }

  return { request, handleMessage, onWindowRemoved, pendingCount: () => pending.size };
}

let installed = null;

export function installInboxConfirm() {
  if (installed) return installed;
  const broker = createConfirmBroker({
    openWindow: async (path) => {
      const win = await chrome.windows.create({
        url: chrome.runtime.getURL(path),
        type: "popup",
        width: 460,
        height: 560,
        focused: true,
      });
      return win?.id;
    },
    closeWindow: (windowId) => chrome.windows.remove(windowId),
  });
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender?.id !== chrome.runtime.id || !String(msg?.type || "").startsWith("pl.inboxConfirm.")) return false;
    sendResponse(broker.handleMessage(msg));
    return false;
  });
  chrome.windows?.onRemoved?.addListener((windowId) => broker.onWindowRemoved(windowId));
  installed = broker;
  return broker;
}

export function getInboxConfirm() {
  return installed;
}

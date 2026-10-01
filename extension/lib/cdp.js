/**
 * chrome.debugger（CDP）会话管理：按需附加、空闲自动分离，并记录 JS 对话框与文件选择器事件。
 * 附加期间 Chrome 会在页面顶部显示「正在调试此浏览器」横幅，所以空闲后尽快分离。
 */

const PROTOCOL = "1.3";
export const DEFAULT_IDLE_MS = 20000;

export function cdpAvailable(api = globalThis.chrome?.debugger) {
  return typeof api?.attach === "function" && typeof api?.sendCommand === "function";
}

export function createCdp({
  api = globalThis.chrome?.debugger,
  idleMs = DEFAULT_IDLE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const sessions = new Map();

  const session = (tabId) => {
    let s = sessions.get(tabId);
    if (!s) {
      s = { attached: false, dialog: null, drag: null, dialogWaiters: new Set(), chooserWaiters: new Set(), timer: null };
      sessions.set(tabId, s);
    }
    return s;
  };

  const resetIdle = (tabId) => {
    const s = session(tabId);
    if (s.timer) clearTimer(s.timer);
    s.timer = idleMs > 0 ? setTimer(() => detach(tabId).catch(() => {}), idleMs) : null;
    s.timer?.unref?.();
  };

  const rawSend = (tabId, method, params) => api.sendCommand({ tabId }, method, params);

  async function ensure(tabId) {
    if (!cdpAvailable(api)) throw new Error("当前环境没有 chrome.debugger，无法使用可信输入。");
    const s = session(tabId);
    if (!s.attached) {
      try {
        await api.attach({ tabId }, PROTOCOL);
      } catch (err) {
        const message = err?.message || String(err);
        if (/already attached/i.test(message)) {
          throw new Error("该标签已被 DevTools 或其他调试器占用，请先关闭它的开发者工具。");
        }
        throw new Error(`无法附加调试器：${message}`);
      }
      s.attached = true;
      await rawSend(tabId, "Page.enable").catch(() => {});
    }
    resetIdle(tabId);
    return s;
  }

  async function send(tabId, method, params = {}) {
    await ensure(tabId);
    const result = await rawSend(tabId, method, params);
    resetIdle(tabId);
    return result;
  }

  async function detach(tabId) {
    const s = sessions.get(tabId);
    if (!s?.attached) return;
    if (s.timer) clearTimer(s.timer);
    s.attached = false;
    s.timer = null;
    s.dialog = null;
    try {
      await api.detach({ tabId });
    } catch {
      /* 标签已关闭或已被分离 */
    }
  }

  function pendingDialog(tabId) {
    return sessions.get(tabId)?.dialog || null;
  }

  /** 返回 { promise, cancel }：对话框弹出时 resolve；已有未处理的对话框则立即 resolve。 */
  function watchDialog(tabId) {
    const s = session(tabId);
    let waiter;
    const promise = new Promise((resolve) => {
      waiter = resolve;
      if (s.dialog) resolve(s.dialog);
      else s.dialogWaiters.add(waiter);
    });
    return { promise, cancel: () => s.dialogWaiters.delete(waiter) };
  }

  function takeDragData(tabId) {
    const s = sessions.get(tabId);
    const data = s?.drag || null;
    if (s) s.drag = null;
    return data;
  }

  function waitFileChooser(tabId, timeoutMs = 5000) {
    const s = session(tabId);
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        s.chooserWaiters.delete(waiter);
        reject(new Error("点击后没有弹出文件选择框，目标可能不是上传控件。"));
      }, timeoutMs);
      const waiter = (event) => {
        clearTimer(timer);
        resolve(event);
      };
      s.chooserWaiters.add(waiter);
    });
  }

  function onEvent(source, method, params) {
    const tabId = source?.tabId;
    if (!sessions.has(tabId)) return;
    const s = sessions.get(tabId);
    if (method === "Page.javascriptDialogOpening") {
      s.dialog = {
        type: params?.type || "alert",
        message: params?.message || "",
        defaultPrompt: params?.defaultPrompt || "",
        url: params?.url || "",
      };
      for (const waiter of [...s.dialogWaiters]) waiter(s.dialog);
      s.dialogWaiters.clear();
    } else if (method === "Page.javascriptDialogClosed") {
      s.dialog = null;
    } else if (method === "Input.dragIntercepted") {
      s.drag = params?.data || null;
    } else if (method === "Page.fileChooserOpened") {
      for (const waiter of [...s.chooserWaiters]) waiter(params || {});
      s.chooserWaiters.clear();
    }
  }

  function onDetach(source) {
    const s = sessions.get(source?.tabId);
    if (!s) return;
    if (s.timer) clearTimer(s.timer);
    s.attached = false;
    s.timer = null;
    s.dialog = null;
  }

  api?.onEvent?.addListener?.(onEvent);
  api?.onDetach?.addListener?.(onDetach);

  return { ensure, send, detach, pendingDialog, watchDialog, waitFileChooser, takeDragData, isAttached: (id) => Boolean(sessions.get(id)?.attached) };
}

let shared = null;
export function getCdp() {
  shared ||= createCdp();
  return shared;
}

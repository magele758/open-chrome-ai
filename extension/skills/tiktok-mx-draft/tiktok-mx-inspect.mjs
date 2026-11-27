import { NATIVE_HOST_NAME } from "../../lib/native-host.js";
import { runMxDraftRead } from "./tiktok-mx-editor.mjs";

export async function inspectDraftJob(job, bridge) {
  const { sourceId, draftId } = job;
  if (job.token != null || ![sourceId, draftId].every(id => typeof id === "string" && /^\d{12,22}$/.test(id)))
    throw Error("Expected a local inspection with numeric source and draft IDs");
  const url = "https://seller.tiktokshopglobalselling.com/product/edit-draft/" + draftId + "?shop_region=MX";
  let step = 0, tabId, windowId, read;
  const dispatch = (tool, args) => bridge.call({ id: job.id + "." + ++step, tool, args });
  async function browserRead() {
    const opened = await dispatch("open_tab", { url, active: false, groupTitle: "PageLens · MX " + sourceId.slice(-6), newWindow: true });
    if (!opened.ok) throw Error(opened.error?.message || "Draft did not open");
    tabId = opened.result.tabId;
    windowId = Number.isInteger(opened.result.windowId) ? opened.result.windowId : null;
    return runMxDraftRead({ action: "read_mx_draft", url, tabId }, dispatch, async id => {
      const t = await chrome.tabs.get(id);
      return t.url || t.pendingUrl;
    });
  }
  const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error("PTC inspector timed out")), 55000);
      port.onDisconnect.addListener(() => reject(Error(chrome.runtime.lastError?.message || "PTC host disconnected")));
      port.onMessage.addListener(message => {
        if (message.type === "ptc.done") {
          if (message.ok) resolve(message.result);
          else reject(Error(message.error));
        } else if (message.type === "ptc.read_saved" && !read) {
          read = browserRead();
          read.then(result => port.postMessage({ type: "ptc.read_result", ok: true, result }),
            e => port.postMessage({ type: "ptc.read_result", ok: false, error: e.message })).catch(() => {});
        }
      });
      port.postMessage({ type: "ptc.inspect_mx", sourceId, draftId });
    });
  } finally {
    clearTimeout(timer);
    port.disconnect();
    await read?.catch(() => {});
    if (tabId) {
      const closed = await dispatch("close_tab", { tabId });
      if (!closed.ok) throw Error(closed.error?.message || "Could not close inspection tab");
    }
    if (windowId != null) {
      try {
        const win = await chrome.windows?.get?.(windowId, { populate: true });
        const tabs = win?.tabs || [];
        const onlyAutomation = tabs.every(t => {
          const u = String(t.url || t.pendingUrl || "");
          return t.id === tabId || !u || u === "about:blank" || u.startsWith("chrome://newtab");
        });
        if (win && onlyAutomation) {
          const groupedIds = tabs.filter(t => t.groupId != null && t.groupId >= 0).map(t => t.id);
          if (groupedIds.length && typeof chrome.tabs?.ungroup === "function") {
            await chrome.tabs.ungroup(groupedIds).catch(() => {});
          }
          await chrome.windows.remove(windowId).catch(() => {});
        }
      } catch {}
    }
  }
}

import { handleAudioMessage } from "./lib/tab-audio-sw.js";
import { applyOptionalLocalSettings } from "./lib/storage.js";
import { installBridge } from "./lib/bridge/index.js";
import {
  syncAgentInboxAlarm,
  wireAgentInboxAlarm,
  pollAgentInboxOnce,
} from "./lib/agent/inbox.js";
import { installInboxConfirm } from "./lib/agent/inbox-confirm.js";
import { installAgentGateway } from "./lib/bridge/gateway.js";

applyOptionalLocalSettings().catch(() => {});
installAgentGateway(installBridge());
installInboxConfirm();
wireAgentInboxAlarm();
syncAgentInboxAlarm().catch(() => {});
// Kick once shortly after SW starts so agents do not wait a full alarm period (no-op when disabled).
setTimeout(() => {
  pollAgentInboxOnce().catch(() => {});
}, 1500);

chrome.runtime.onInstalled.addListener(() => {
  applyOptionalLocalSettings().catch(() => {});
  syncAgentInboxAlarm().catch(() => {});
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "pagelens-ask-selection",
      title: "用 PageLens 问选区",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "pagelens-clip",
      title: "剪藏到 PageLens 智库",
      contexts: ["page", "selection"],
    });
  });
});

chrome.runtime.onStartup.addListener(() => {
  applyOptionalLocalSettings().catch(() => {});
  syncAgentInboxAlarm().catch(() => {});
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "pl.agentInbox.poll") {
    pollAgentInboxOnce()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (!msg?.type?.startsWith("pl.audio.")) return;
  handleAudioMessage(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true;
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "pagelens-clip") {
    const text = (info.selectionText || "").trim();
    await chrome.storage.session.set({
      pendingClip: {
        text,
        title: tab.title || "",
        url: tab.url || "",
      },
      pendingTabId: tab.id,
    });
  } else if (info.menuItemId === "pagelens-ask-selection") {
    const text = (info.selectionText || "").trim();
    if (!text) return;
    await chrome.storage.session.set({
      pendingSelection: text,
      pendingTabId: tab.id,
    });
  } else {
    return;
  }

  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch {
      /* side panel API 需要用户手势；右键菜单算手势，失败就只写入 pending */
    }
  }
});

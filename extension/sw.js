import { handleAudioMessage } from "./lib/tab-audio-sw.js";
import { applyOptionalLocalSettings, normalizeSettings } from "./lib/storage.js";
import { installBridge } from "./lib/bridge/index.js";
import { createInterpretRouter } from "./lib/interpret-host-sw.js";
import { installInterpretSync } from "./lib/interpret-sync.js";
import {
  syncAgentInboxAlarm,
  wireAgentInboxAlarm,
  pollAgentInboxOnce,
  manageMxApproval,
  completeAgentPrompt,
  completeHeadlessAgentPrompt,
} from "./lib/agent/inbox.js";
import { installInboxConfirm } from "./lib/agent/inbox-confirm.js";
import { confirmDevelopmentUpdate } from "./lib/agent/inbox-development.js";
import { AGENT_TASK_EVENTS, onAgentTaskEvent } from "./lib/agent/delegate.js";
import { installWindowMail } from "./lib/window-mail.js";
import { installDelegate } from "./lib/agent/delegate-sw.js";
import { installAgentGateway } from "./lib/bridge/gateway.js";
import { createTemporaryMarkerWindow, focusOpenSavedGroup } from "./lib/agent/saved-group-focus.js";
import { chooseNativeProductDirectory, nativeSend } from "./lib/native-host.js";

applyOptionalLocalSettings().catch(() => {});
installWindowMail(installDelegate());
onAgentTaskEvent((ev) => {
  if (ev.type === AGENT_TASK_EVENTS.FINISHED) completeHeadlessAgentPrompt().catch(() => {});
});
installAgentGateway(installBridge());
installInboxConfirm();
createInterpretRouter().install();
const interpretSync = installInterpretSync({ role: "pagelens", normalizeSettings });
setTimeout(() => {
  interpretSync.syncWithPeer({ reason: "sw-boot" }).catch(() => {});
}, 1200);
wireAgentInboxAlarm();
syncAgentInboxAlarm().catch(() => {});
// Kick once shortly after SW starts so agents do not wait a full alarm period (no-op when disabled).
setTimeout(() => {
  pollAgentInboxOnce().catch(() => {});
}, 1500);

chrome.runtime.onInstalled.addListener((details) => {
  confirmDevelopmentUpdate(details).catch(() => {});
  applyOptionalLocalSettings().catch(() => {});
  syncAgentInboxAlarm().catch(() => {});
  interpretSync.syncWithPeer({ reason: "installed" }).catch(() => {});
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
  interpretSync.syncWithPeer({ reason: "startup" }).catch(() => {});
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (typeof msg?.type === "string" && msg.type.startsWith("pl.mxApproval.")) {
    if (_sender?.id !== chrome.runtime.id || _sender?.url !== chrome.runtime.getURL("sidepanel/index.html")) return false;
    manageMxApproval(msg)
      .then(state => sendResponse({ ok: true, state }))
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (msg?.type === "pl.ptc.chooseDirectory") {
    if (_sender?.id !== chrome.runtime.id || _sender?.url !== chrome.runtime.getURL("sidepanel/index.html")) return false;
    chooseNativeProductDirectory().then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (msg?.type === "pl.ptc.readDirectory" || msg?.type === "pl.ptc.readSizeChartChunk") {
    if (_sender?.id !== chrome.runtime.id || _sender?.url !== chrome.runtime.getURL("sidepanel/index.html")) return false;
    const { path, root, folder, expectedPath, offset, revision, asset } = msg;
    const request = msg.type === "pl.ptc.readDirectory"
      ? { op: "fs", action: "loadProductDirectory", path }
      : { op: "fs", action: "readProductSizeChartChunk", root, folder, expectedPath, offset, revision, asset };
    nativeSend(request, { interactive: false })
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (msg?.type === "pl.agentInbox.poll") {
    pollAgentInboxOnce()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (msg?.type === "pl.agentPrompt.done") {
    if (_sender?.id !== chrome.runtime.id) return false;
    completeAgentPrompt(msg)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (msg?.type === "pl.savedGroups.createMarker") {
    if (_sender?.id !== chrome.runtime.id) return false;
    (async () => {
      try {
        sendResponse(await createTemporaryMarkerWindow(msg));
      } catch (err) {
        sendResponse({ ok: false, code: "WINDOW_NOT_FOUND", error: err?.message || String(err) });
      }
    })();
    return true;
  }
  if (msg?.type === "pl.savedGroups.focusOpen") {
    if (_sender?.id !== chrome.runtime.id) return false;
    (async () => {
      try {
        sendResponse(await focusOpenSavedGroup(msg));
      } catch (err) {
        sendResponse({ ok: false, code: "OPEN_FAILED", error: err?.message || String(err) });
      }
    })();
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
  const text = (info.selectionText || "").trim();
  let pending;
  if (info.menuItemId === "pagelens-clip") {
    pending = { clip: { text, title: tab.title || "", url: tab.url || "" } };
  } else if (info.menuItemId === "pagelens-ask-selection" && text) {
    pending = { selection: text };
  } else {
    return;
  }
  // Open during the menu click's user gesture. An already-open panel watches its own storage key.
  const opened = chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  await chrome.storage.session.set({ [`pl.contextMenu.${tab.windowId}`]: pending });
  await opened;
});

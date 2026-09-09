chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "pagelens-ask-selection",
      title: "用 PageLens 问选区",
      contexts: ["selection"],
    });
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "pagelens-ask-selection" || !tab?.id) return;
  const text = (info.selectionText || "").trim();
  if (!text) return;
  await chrome.storage.session.set({
    pendingSelection: text,
    pendingTabId: tab.id,
  });
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

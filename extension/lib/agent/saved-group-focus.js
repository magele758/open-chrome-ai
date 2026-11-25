import { nativeSavedTabGroups } from "../native-host.js";

const MARKER_TITLE = /^PageLens-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function finiteWindowId(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function refocusPanel(chromeApi, panel) {
  if (!panel) return;
  await Promise.resolve(chromeApi.windows?.update?.(panel, { focused: true })).catch(() => {});
}

export async function requestFocusedNativeOpen(chromeApi, callNative, payload, markerWindowId, panelWindowId) {
  const marker = finiteWindowId(markerWindowId);
  const panel = finiteWindowId(panelWindowId);
  const send = chromeApi?.runtime?.sendMessage;
  if (marker && panel && marker !== panel && typeof send === "function") {
    let response;
    try {
      response = await send({
        type: "pl.savedGroups.focusOpen",
        windowId: marker,
        panelWindowId: panel,
        payload,
      });
    } catch (err) {
      return { ok: false, code: "OPEN_FAILED", error: err?.message || String(err) };
    }
    if (response?.ok) return response.result;
    return {
      ok: false,
      code: response?.code || "OPEN_FAILED",
      error: response?.error || "未能打开 Chrome 原生保存组。",
    };
  }
  if (marker && panel && marker !== panel && typeof send !== "function" && typeof chromeApi?.windows?.update === "function") {
    await chromeApi.windows.update(marker, { focused: true }).catch(() => {});
  }
  return callNative(payload);
}

export async function focusOpenSavedGroup(msg, { chromeApi = globalThis.chrome, nativeCall } = {}) {
  const marker = finiteWindowId(msg?.windowId);
  const panel = finiteWindowId(msg?.panelWindowId);
  if (!marker || !panel || msg?.payload?.action !== "open") {
    return { ok: false, code: "OPEN_FAILED", error: "缺少用于聚焦打开的窗口。" };
  }
  const call = nativeCall || nativeSavedTabGroups;
  try {
    await chromeApi.windows.update(marker, { focused: true });
    const result = await call(msg.payload);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, code: "OPEN_FAILED", error: err?.message || String(err) };
  } finally {
    // Refocus before this promise settles. A reply delivered while the marker
    // window is still focused never reaches the frozen side panel.
    await refocusPanel(chromeApi, panel);
  }
}

export async function requestTemporaryMarker(chromeApi, { title, url, panelWindowId }) {
  const send = chromeApi?.runtime?.sendMessage;
  if (typeof send !== "function") return null;
  try {
    const response = await send({
      type: "pl.savedGroups.createMarker",
      title,
      url,
      panelWindowId,
    });
    if (response?.ok && response.tab?.id != null) return response;
    return {
      ok: false,
      code: response?.code || "WINDOW_NOT_FOUND",
      error: response?.error || "未找到用于打开标签组的临时页。",
    };
  } catch (err) {
    return { ok: false, code: "WINDOW_NOT_FOUND", error: err?.message || String(err) };
  }
}

export async function createTemporaryMarkerWindow(msg, { chromeApi = globalThis.chrome } = {}) {
  const panel = finiteWindowId(msg?.panelWindowId);
  const title = typeof msg?.title === "string" ? msg.title : "";
  const url = typeof msg?.url === "string" ? msg.url : "";
  let win = null;
  try {
    if (!MARKER_TITLE.test(title) || !url.startsWith("data:text/html")) {
      return { ok: false, code: "WINDOW_NOT_FOUND", error: "临时页标题无效。" };
    }
    win = await chromeApi.windows.create({
      type: "normal",
      url: "about:blank",
      focused: false,
    });
    const tabs = win?.tabs?.length ? win.tabs : await chromeApi.tabs.query({ windowId: win?.id });
    const tab = tabs?.[0];
    if (tab?.id == null) {
      if (win?.id != null) await chromeApi.windows.remove(win.id).catch(() => {});
      win = null;
      return { ok: false, code: "WINDOW_NOT_FOUND", error: "未找到用于打开标签组的临时页。" };
    }
    const updated = await chromeApi.tabs.update(tab.id, { url, active: true });
    const next = updated
      ? { ...tab, ...updated, windowId: updated.windowId ?? tab.windowId ?? win?.id }
      : null;
    if (!next?.id) {
      if (win?.id != null) await chromeApi.windows.remove(win.id).catch(() => {});
      win = null;
      return { ok: false, code: "WINDOW_NOT_FOUND", error: "未找到用于打开标签组的临时页。" };
    }
    if (next.windowId == null) next.windowId = win.id;
    return { ok: true, tab: next };
  } catch (err) {
    if (win?.id != null) await chromeApi.windows.remove(win.id).catch(() => {});
    return { ok: false, code: "WINDOW_NOT_FOUND", error: err?.message || String(err) };
  } finally {
    // Refocus before this promise settles. Creating the marker must not leave
    // the side panel frozen when its sendMessage callback is delivered.
    await refocusPanel(chromeApi, panel);
  }
}

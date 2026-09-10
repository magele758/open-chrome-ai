/**
 * Chrome MV3 helpers for the page agent.
 * Side-panel and tool code share these; no extra process.
 */

import { plPageAudio, plVideo } from "./video-pick.js";

const BLOCKED_PROTOCOLS = new Set([
  "chrome:",
  "edge:",
  "about:",
  "chrome-extension:",
  "devtools:",
  "data:",
  "blob:",
  "file:",
  "javascript:",
  "view-source:",
  "media:",
  "filesystem:",
]);

const DROP_KEYS = new Set(["favIconUrl", "pendingUrl", "autoDiscardable", "mutedInfo"]);

export const CHROME_CALL_ALLOW = [
  "tabs.query",
  "tabs.get",
  "tabs.create",
  "tabs.duplicate",
  "tabs.update",
  "tabs.move",
  "tabs.reload",
  "tabs.remove",
  "tabs.goBack",
  "tabs.goForward",
  "tabs.detectLanguage",
  "tabs.getZoom",
  "tabs.setZoom",
  "tabs.highlight",
  "tabs.discard",
  "tabs.ungroup",
  "tabs.group",
  "tabGroups.get",
  "tabGroups.query",
  "tabGroups.update",
  "tabGroups.move",
  "windows.get",
  "windows.getCurrent",
  "windows.getLastFocused",
  "windows.getAll",
  "windows.create",
  "windows.update",
  "windows.remove",
  "bookmarks.get",
  "bookmarks.getTree",
  "bookmarks.getChildren",
  "bookmarks.getRecent",
  "bookmarks.search",
  "bookmarks.create",
  "bookmarks.update",
  "bookmarks.move",
  "bookmarks.remove",
  "history.search",
  "history.getVisits",
  "notifications.create",
  "notifications.clear",
  "notifications.getAll",
  "tts.speak",
  "tts.stop",
  "tts.pause",
  "tts.resume",
  "tts.getVoices",
  "runtime.getPlatformInfo",
  "runtime.getURL",
  "i18n.getUILanguage",
  "i18n.getAcceptLanguages",
  "commands.getAll",
  "action.setBadgeText",
  "action.getBadgeText",
  "action.getTitle",
];

export function restrictedUrl(url) {
  if (!url) return true;
  if (/chrome\.google\.com\/webstore|chromewebstore\.google\.com/i.test(url)) return true;
  try {
    const protocol = new URL(url).protocol;
    if (BLOCKED_PROTOCOLS.has(protocol)) return true;
  } catch {
    return true;
  }
  return false;
}

export function isHttpUrl(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function jsonSafe(value, depth = 0) {
  if (depth > 6) return "[…]";
  if (value == null) return value;
  const t = typeof value;
  if (t === "string") return value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
  if (t === "number" || t === "boolean") return value;
  if (t === "bigint") return String(value);
  if (t === "function") return undefined;
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => jsonSafe(item, depth + 1));
  if (t === "object") {
    const out = {};
    let n = 0;
    for (const [key, val] of Object.entries(value)) {
      if (DROP_KEYS.has(key) || typeof val === "function") continue;
      out[key] = jsonSafe(val, depth + 1);
      n += 1;
      if (n >= 80) break;
    }
    return out;
  }
  return String(value);
}

export function compactTab(tab) {
  if (!tab) return null;
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: String(tab.title || "").slice(0, 120),
    url: tab.url || "",
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    audible: Boolean(tab.audible),
    discarded: Boolean(tab.discarded),
    groupId: tab.groupId > -1 ? tab.groupId : undefined,
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extensionUrl(path) {
  try {
    return chrome.runtime.getURL(path);
  } catch {
    return path;
  }
}

export function toToolText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export async function inject(tabId, func, args = [], { world } = {}) {
  if (!tabId) throw new Error("没有可操作的标签");
  const tab = await chrome.tabs.get(tabId);
  if (restrictedUrl(tab?.url)) throw new Error(`受限页，无法注入：${tab?.url || ""}`);
  const opts = { target: { tabId }, func, args };
  if (world) opts.world = world;
  const [entry] = await chrome.scripting.executeScript(opts);
  return entry?.result;
}

export async function injectVideo(tabId, cmd, arg = {}) {
  return inject(tabId, plVideo, [cmd, arg]);
}

export async function injectPageAudio(tabId, cmd, arg = {}) {
  return inject(tabId, plPageAudio, [cmd, arg]);
}

export async function injectMain(tabId, func, args = []) {
  return inject(tabId, func, args, { world: "MAIN" });
}

const GROUP_COLORS = ["orange", "blue", "cyan", "green", "purple", "pink", "yellow", "red"];

export async function ensureTaskGroup(tabId, { groupId, title, color } = {}) {
  if (!tabId || typeof chrome.tabs?.group !== "function") return null;
  try {
    let id = Number.isInteger(groupId) && groupId >= 0 ? groupId : null;
    if (id != null) {
      try {
        if (chrome.tabGroups?.get) await chrome.tabGroups.get(id);
        await chrome.tabs.group({ tabIds: [tabId], groupId: id });
        return id;
      } catch {
        id = null;
      }
    }
    const tab = await chrome.tabs.get(tabId);
    const created = await chrome.tabs.group({
      tabIds: [tabId],
      createProperties: tab.windowId != null ? { windowId: tab.windowId } : undefined,
    });
    if (chrome.tabGroups?.update) {
      const label = String(title || "PageLens").replace(/\s+/g, " ").trim().slice(0, 40);
      await chrome.tabGroups.update(created, {
        title: label || "PageLens",
        color: color || GROUP_COLORS[created % GROUP_COLORS.length] || "orange",
      });
    }
    return created;
  } catch {
    return null;
  }
}

export async function captureTab(tabId, windowId) {
  let win = windowId;
  if (tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (restrictedUrl(tab?.url)) throw new Error(`受限页，无法截图：${tab?.url || ""}`);
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      await sleep(280);
    }
    win = tab.windowId;
  }
  if (win == null) throw new Error("没有可截取的窗口");
  return chrome.tabs.captureVisibleTab(win, { format: "jpeg", quality: 80 });
}

function extractWriteUrls(method, args) {
  if (method === "tabs.create" || method === "windows.create") return [args[0]?.url];
  if (method === "tabs.update") {
    if (args[1] && typeof args[1] === "object") return [args[1].url];
    if (args[0] && typeof args[0] === "object") return [args[0].url];
  }
  return [];
}

function clampHistoryQuery(query) {
  const q = { ...(query || {}) };
  q.maxResults = Math.min(Math.max(Number(q.maxResults) || 20, 1), 30);
  if (q.startTime == null) q.startTime = Date.now() - 7 * 86400000;
  return q;
}

function withNotificationDefaults(method, params) {
  if (method !== "notifications.create") return params;
  const patch = (options) => {
    if (!options || typeof options !== "object") return options;
    return {
      ...options,
      type: options.type || "basic",
      iconUrl: options.iconUrl || extensionUrl("icons/icon48.png"),
      title: options.title || "PageLens",
      message: options.message || options.contextMessage || "",
    };
  };
  if (params.length >= 2) return [params[0], patch(params[1])];
  return [patch(params[0])];
}

export async function chromeCall(method, args) {
  const name = String(method || "").trim();
  if (!CHROME_CALL_ALLOW.includes(name)) {
    return {
      ok: false,
      error: `不允许调用 ${name}。cookies / debugger / downloads / storage / scripting 不开放；截图用 screenshot，读页用 extract_page / run_js。`,
      allowed: CHROME_CALL_ALLOW,
    };
  }
  let params = Array.isArray(args) ? [...args] : args == null ? [] : [args];
  for (const url of extractWriteUrls(name, params)) {
    if (url && !isHttpUrl(url)) {
      return { ok: false, error: `只能打开 http(s) URL，收到：${url}` };
    }
  }
  if (name === "history.search") params[0] = clampHistoryQuery(params[0]);
  params = withNotificationDefaults(name, params);

  const parts = name.split(".");
  let parent = globalThis.chrome;
  for (let i = 0; i < parts.length - 1; i += 1) parent = parent?.[parts[i]];
  const fn = parent?.[parts[parts.length - 1]];
  if (typeof fn !== "function") {
    return { ok: false, error: `当前环境没有 ${name}（未授权或浏览器不支持）` };
  }
  try {
    const result = await fn.apply(parent, params);
    return { ok: true, method: name, result: jsonSafe(result) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

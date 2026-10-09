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
  "alarms.get",
  "alarms.getAll",
  "alarms.clear",
  "alarms.clearAll",
  "webNavigation.getFrame",
  "webNavigation.getAllFrames",
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
    const parsed = new URL(url);
    const protocol = parsed.protocol;
    if (
      protocol.startsWith("chrome-") ||
      protocol.startsWith("edge-") ||
      protocol.startsWith("brave-") ||
      protocol.startsWith("opera-") ||
      BLOCKED_PROTOCOLS.has(protocol)
    ) {
      return true;
    }
    if (parsed.hostname === "newtab") return true;
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

/** Wait until a tab finishes navigating. Default: URL must change, then status=complete. */
export async function waitForTabNavigation(tabId, { timeoutMs = 8000, urlChange = true } = {}) {
  if (!tabId) return { ok: false, error: "没有可操作的标签。" };
  const ms = Math.min(Math.max(Number(timeoutMs) || 8000, 300), 20000);
  let initial;
  try {
    initial = await chrome.tabs.get(tabId);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }

  const started = Date.now();
  const snapshot = (tab, extra = {}) => ({
    ok: true,
    tabId,
    title: tab?.title || "",
    url: tab?.url || "",
    status: tab?.status || "",
    changed: Boolean(tab?.url && tab.url !== initial.url),
    ms: Date.now() - started,
    ...extra,
  });

  if (!urlChange && initial.status === "complete") {
    return snapshot(initial, { timedOut: false });
  }

  if (typeof chrome.tabs?.onUpdated?.addListener !== "function") {
    return snapshot(initial, { timedOut: true, note: "当前环境无法监听导航。" });
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer = 0;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        chrome.tabs.onUpdated.removeListener(onUpdated);
      } catch {
        /* ignore */
      }
      resolve(payload);
    };

    function onUpdated(id, _info, tab) {
      if (id !== tabId || !tab) return;
      if (tab.status && tab.status !== "complete") return;
      const changed = Boolean(tab.url && tab.url !== initial.url);
      if (urlChange && !changed) return;
      finish(snapshot(tab, { timedOut: false }));
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    timer = setTimeout(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        finish(snapshot(tab, { timedOut: true }));
      } catch (err) {
        finish({ ok: false, error: err?.message || String(err) });
      }
    }, ms);
  });
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

async function assertInjectable(tabId) {
  if (!tabId) throw new Error("没有可操作的标签");
  const tab = await chrome.tabs.get(tabId);
  if (restrictedUrl(tab?.url)) throw new Error(`受限页，无法注入：${tab?.url || ""}`);
}

export async function inject(tabId, func, args = [], { world, frameId } = {}) {
  await assertInjectable(tabId);
  const target = Number.isInteger(frameId) && frameId > 0 ? { tabId, frameIds: [frameId] } : { tabId };
  const opts = { target, func, args };
  if (world) opts.world = world;
  const [entry] = await chrome.scripting.executeScript(opts);
  return entry?.result;
}

/** 在标签的所有 frame（含跨域 iframe）里各执行一次，返回 [{ frameId, result }]。 */
export async function injectFrames(tabId, func, args = [], { world } = {}) {
  await assertInjectable(tabId);
  const opts = { target: { tabId, allFrames: true }, func, args };
  if (world) opts.world = world;
  const entries = (await chrome.scripting.executeScript(opts)) || [];
  return entries.map((e) => ({ frameId: Number.isInteger(e.frameId) ? e.frameId : 0, result: e.result }));
}

export const CSP_HINT =
  "页面 CSP 禁止执行动态脚本。改用 snapshot_controls / list_controls / query_dom / find_in_page / click / fill 这类结构化工具（不受 CSP 影响）；" +
  "确实需要执行 JS 时，在 chrome://extensions 打开本扩展的「允许用户脚本」后重试。";

function userScriptSource(code) {
  const body = /^\s*return\b/.test(code) || /[;{}]/.test(code) ? code : `return (${code})`;
  return `(async () => {
  const safe = (v) => {
    try {
      return JSON.parse(JSON.stringify(v, (k, x) => {
        if (typeof x === "bigint") return String(x);
        if (typeof x === "function") return "[Function " + (x.name || "") + "]";
        if (typeof Element !== "undefined" && x instanceof Element) return { tag: x.tagName, id: x.id, text: (x.innerText || "").slice(0, 200) };
        if (typeof x === "string" && x.length > 4000) return x.slice(0, 4000) + "…";
        return x;
      }) ?? null);
    } catch { return String(v); }
  };
  try {
    const value = await (async () => { ${body}
    })();
    return { ok: true, result: safe(value), via: "userScripts" };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), via: "userScripts" };
  }
})()`;
}

/**
 * 在页面里执行 JS。页面 CSP 禁 eval 时，退到 userScripts（USER_SCRIPT 世界不受页面 CSP 限制）。
 * 依次尝试：隔离世界 -> MAIN 世界 -> userScripts。
 */
export async function runJsInTab(tabId, runJsFn, code) {
  let last = await inject(tabId, runJsFn, [code]);
  if (!last?.cspBlocked) return last;
  last = await inject(tabId, runJsFn, [code], { world: "MAIN" });
  if (!last?.cspBlocked) return last;

  if (typeof chrome.userScripts?.execute !== "function") {
    return { ok: false, cspBlocked: true, error: `${last.error || "CSP 拦截"}。${CSP_HINT}` };
  }
  try {
    const [entry] = await chrome.userScripts.execute({
      target: { tabId },
      js: [{ code: userScriptSource(String(code || "")) }],
      world: "USER_SCRIPT",
    });
    if (entry?.error) return { ok: false, error: String(entry.error), via: "userScripts" };
    return entry?.result ?? { ok: false, error: "userScripts 未返回结果" };
  } catch (err) {
    return { ok: false, cspBlocked: true, error: `${err?.message || err}。${CSP_HINT}` };
  }
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
  let targetTab = null;
  if (tabId) {
    try {
      targetTab = await chrome.tabs.get(tabId);
    } catch {
      targetTab = null;
    }
  }
  if (!targetTab && chrome.tabs?.query) {
    try {
      const query = { active: true };
      if (windowId != null) query.windowId = windowId;
      else query.currentWindow = true;
      const [active] = await chrome.tabs.query(query);
      targetTab = active || null;
    } catch {
      targetTab = null;
    }
  }

  if (targetTab) {
    if (restrictedUrl(targetTab.url)) {
      throw new Error(`受限页，无法截图：${targetTab.url || "系统页面"}`);
    }
    if (!targetTab.active && targetTab.id) {
      await chrome.tabs.update(targetTab.id, { active: true });
      await sleep(280);
    }
  }

  const win = targetTab?.windowId ?? windowId;
  if (win == null) throw new Error("没有可截取的窗口");

  try {
    return await chrome.tabs.captureVisibleTab(win, { format: "jpeg", quality: 80 });
  } catch (err) {
    const msg = err?.message || String(err);
    if (/activeTab|permission|cannot access/i.test(msg)) {
      throw new Error("当前页面受系统安全策略保护无法截图，请切换到常规网页后重试。若刚更新插件，请在扩展管理页重新加载插件。");
    }
    throw err;
  }
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
      error: `不允许调用 ${name}。cookies / debugger / downloads / storage / scripting 不开放；cookie 用 get_cookies / set_cookie / remove_cookie，截图用 screenshot，读页用 extract_page / run_js。`,
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

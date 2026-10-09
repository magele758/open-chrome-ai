/**
 * 安装时只保留侧栏能工作的权限。其余 API / 主机权限在第一次用到对应功能时单独申请，
 * 并先告诉用户原因。已经授予的权限（含从旧版 required 升上来的）直接通过，不再弹窗。
 * debugger 与 tts 不能放进 optional_permissions，Chrome 会拒绝加载扩展。
 */

const INSTALL_PERMISSIONS = new Set([
  "activeTab",
  "alarms",
  "contextMenus",
  "debugger",
  "offscreen",
  "scripting",
  "sidePanel",
  "storage",
  "tts",
  "unlimitedStorage",
]);

const OPTIONAL_API = new Set([
  "bookmarks",
  "clipboardRead",
  "clipboardWrite",
  "cookies",
  "downloads",
  "favicon",
  "history",
  "nativeMessaging",
  "notifications",
  "pageCapture",
  "search",
  "sessions",
  "tabCapture",
  "tabGroups",
  "tabs",
  "userScripts",
  "webNavigation",
]);

const REASONS = {
  bookmarks: "需要读取和修改书签，才能搜索或保存书签。",
  clipboardRead: "需要读取剪贴板，才能使用你复制的内容。",
  clipboardWrite: "需要写入剪贴板，才能把内容复制出去。",
  cookies: "需要读写网站 cookie，才能按你的要求查看、写入或删除指定站点的 cookie。",
  downloads: "需要管理下载，才能把文件保存到本机。",
  favicon: "需要读取网站图标，才能显示标签的站点图标。",
  history: "需要读取浏览历史，才能按你的要求搜索曾经打开过的页面。",
  nativeMessaging: "需要连接本机助手，才能执行本地命令或读写你指定的文件夹。",
  notifications: "需要显示系统通知，才能在任务完成时提醒你。",
  pageCapture: "需要读取页面的完整内容，才能把这一页存成离线文件。",
  search: "需要使用浏览器的默认搜索引擎。",
  sessions: "需要读取最近关闭的标签，才能找回刚才关掉的页面。",
  tabCapture: "需要捕获当前标签的音频，才能做同声传译或视频总结。",
  tabGroups: "需要查看和管理标签组，才能把相关标签收在一起。",
  tabs: "需要读取标签的网址和标题，才能知道要操作哪个页面。",
  userScripts: "需要允许用户脚本，才能在拦截普通注入的页面上执行你要求的 JavaScript。授权后，还要在扩展详情页打开「允许用户脚本」。",
  webNavigation: "需要读取页面内嵌框架的网址，才能在框架里定位元素。",
};

const CHROME_NAMESPACE = {
  bookmarks: "bookmarks",
  downloads: "downloads",
  history: "history",
  notifications: "notifications",
  search: "search",
  sessions: "sessions",
  tabGroups: "tabGroups",
  tabs: "tabs",
  webNavigation: "webNavigation",
};

const TITLE = "需要授权";
const inflight = new Map();
const grantedKeys = new Set();
const deniedKeys = new Set();
const watchedApis = new WeakSet();
let prompterOverride = null;
let promptTail = Promise.resolve();
let promptPending = 0;
let listenerInstalled = false;

export function originPatternFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return `${parsed.protocol}//${parsed.host}/*`;
  }
  if (parsed.protocol === "file:") return "file://*/*";
  return null;
}

export function permissionForChromeMethod(method) {
  const namespace = String(method || "").split(".")[0];
  return CHROME_NAMESPACE[namespace] || "";
}

export function isAllowedPermissionQuery(query) {
  if (!query || typeof query !== "object") return false;
  const permissions = Array.isArray(query.permissions) ? query.permissions : [];
  const origins = Array.isArray(query.origins) ? query.origins : [];
  if (permissions.length + origins.length !== 1) return false;
  if (permissions.length === 1) return OPTIONAL_API.has(permissions[0]);
  return isSpecificOrigin(origins[0]);
}

export function setPermissionPrompter(fn) {
  prompterOverride = typeof fn === "function" ? fn : null;
}

export function resetPermissionPrompter() {
  prompterOverride = null;
  grantedKeys.clear();
  deniedKeys.clear();
  inflight.clear();
}

export function ensureOptionalAccess(opts = {}) {
  const prepared = prepare(opts);
  if (prepared.immediate) return Promise.resolve(prepared.result);
  const existing = inflight.get(prepared.key);
  if (existing) return existing;
  const pending = runAccess(prepared, opts);
  inflight.set(prepared.key, pending);
  const finished = pending.finally(() => {
    if (inflight.get(prepared.key) === pending) inflight.delete(prepared.key);
  });
  return finished;
}

export async function requireOptionalFeature(permission, deps = {}) {
  const result = await ensureOptionalAccess({ permission, ...deps });
  if (result.skipped || result.granted || result.required) return "";
  return result.message || "未授予权限。";
}

export async function requireHostUrl(url, deps = {}) {
  const originPattern = originPatternFromUrl(url);
  if (!originPattern) return "";
  const result = await ensureOptionalAccess({ originPattern, url, ...deps });
  if (result.skipped || result.granted || result.required) return "";
  return result.message || "未授予权限。";
}

export async function ensureToolPermissions(permissions, deps = {}) {
  for (const permission of permissions) {
    const denied = await requireOptionalFeature(permission, deps);
    if (denied) return denied;
  }
  return "";
}

export function mountPermissionPrompt(doc, spec) {
  if (promptPending === 0) {
    promptPending += 1;
    const pending = openPermissionPrompt(doc, spec);
    promptTail = pending.finally(() => {
      promptPending -= 1;
    });
    return pending;
  }
  promptPending += 1;
  const queued = promptTail.then(
    () => openPermissionPrompt(doc, spec),
    () => openPermissionPrompt(doc, spec),
  );
  promptTail = queued.finally(() => {
    promptPending -= 1;
  });
  return queued;
}

function openPermissionPrompt(doc, { title = TITLE, reason = "", query, request }) {
  return new Promise((resolve, reject) => {
    if (!doc?.body || typeof request !== "function") {
      resolve(false);
      return;
    }
    ensurePromptStyle(doc);
    const overlay = doc.createElement("div");
    overlay.className = "pl-permission";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    const card = doc.createElement("div");
    card.className = "pl-permission-card";
    const heading = doc.createElement("h2");
    heading.id = "pl-permission-title";
    heading.textContent = title;
    const body = doc.createElement("p");
    body.className = "pl-permission-reason";
    body.textContent = reason;
    const note = doc.createElement("p");
    note.className = "pl-permission-note";
    note.textContent = "点「授权」后，Chrome 会再弹出一次确认。";
    const actions = doc.createElement("div");
    actions.className = "pl-permission-actions";
    const deny = doc.createElement("button");
    deny.type = "button";
    deny.dataset.plPermissionDeny = "true";
    deny.textContent = "暂不";
    const grant = doc.createElement("button");
    grant.type = "button";
    grant.dataset.plPermissionGrant = "true";
    grant.textContent = "授权";
    const close = (settle) => {
      overlay.remove();
      settle();
    };
    deny.addEventListener("click", () => close(() => resolve(false)));
    grant.addEventListener("click", () => {
      grant.disabled = true;
      let pending;
      try {
        pending = request(query);
      } catch (err) {
        close(() => reject(err));
        return;
      }
      Promise.resolve(pending).then(
        (ok) => close(() => resolve(Boolean(ok))),
        (err) => close(() => reject(err)),
      );
    });
    actions.append(deny, grant);
    card.append(heading, body, note, actions);
    overlay.append(card);
    doc.body.append(overlay);
  });
}

export function installPermissionPromptListener(chromeRef = globalThis.chrome, doc = globalThis.document) {
  if (listenerInstalled) return;
  const addListener = chromeRef?.runtime?.onMessage?.addListener;
  if (typeof addListener !== "function") return;
  listenerInstalled = true;
  addListener.call(chromeRef.runtime.onMessage, (msg, sender, sendResponse) => {
    if (msg?.type !== "pl.permission.prompt") return undefined;
    const runtimeId = chromeRef.runtime?.id;
    if (sender?.id && runtimeId && sender.id !== runtimeId) return undefined;
    if (!isAllowedPermissionQuery(msg.query)) {
      sendResponse({ granted: false });
      return undefined;
    }
    mountPermissionPrompt(doc, {
      title: msg.title || TITLE,
      reason: String(msg.reason || ""),
      query: msg.query,
      request: (query) => chromeRef.permissions.request(query),
    }).then(
      (granted) => sendResponse({ granted: Boolean(granted) }),
      () => sendResponse({ granted: false }),
    );
    return true;
  });
}

function prepare(opts) {
  const permission = String(opts.permission || "");
  if (permission && INSTALL_PERMISSIONS.has(permission)) {
    return { immediate: true, result: { granted: true, required: true, reason: "" } };
  }
  if (permission && !OPTIONAL_API.has(permission)) {
    return {
      immediate: true,
      result: {
        granted: false,
        required: false,
        reason: "",
        message: `不会请求未声明的权限：${permission}`,
      },
    };
  }
  const originPattern = opts.originPattern || (opts.url ? originPatternFromUrl(opts.url) : "");
  if (!permission && !originPattern) {
    return { immediate: true, result: { granted: true, skipped: true, reason: "" } };
  }
  const query = {};
  if (permission) query.permissions = [permission];
  if (originPattern) query.origins = [originPattern];
  const reason = permission ? REASONS[permission] : hostReason(opts.url, originPattern);
  const mode = opts.interactive === false ? "silent" : "ask";
  return {
    immediate: false,
    key: `${permission}|${originPattern}|${mode}`,
    permission: permission || null,
    query,
    reason,
    cacheable: !opts.permissionsApi,
  };
}

function hostReason(url, originPattern) {
  if (originPattern === "file://*/*") {
    return "需要读取本机文件，才能打开这个文件地址。";
  }
  let host = originPattern;
  try {
    host = new URL(url).host;
  } catch {
    host = String(originPattern || "").replace(/^\w+:\/\//, "").replace(/\/\*$/, "");
  }
  return `需要访问 ${host}，才能读取或操作这个网站上的页面。`;
}

function denialMessage(reason) {
  return `未授予权限。${reason}`;
}

function failureMessage(prepared, err) {
  const origin = prepared.query.origins?.[0] || "";
  if (origin.startsWith("file:")) {
    return "需要在扩展详情页打开「允许访问文件网址」，才能读取本机文件。Chrome 不能在弹窗里授予文件访问。";
  }
  const detail = err?.message ? `（${err.message}）` : "";
  return `${denialMessage(prepared.reason)}${detail}`;
}

async function runAccess(prepared, opts) {
  const api = opts.permissionsApi || globalThis.chrome?.permissions;
  if (typeof api?.contains !== "function" || typeof api?.request !== "function") {
    return { granted: true, skipped: true, reason: prepared.reason };
  }
  watchRevokes(api);
  if (prepared.cacheable && grantedKeys.has(prepared.key)) {
    return { granted: true, already: true, reason: prepared.reason };
  }
  let has = false;
  try {
    has = await api.contains(prepared.query);
  } catch {
    has = false;
  }
  if (has) {
    if (prepared.cacheable) grantedKeys.add(prepared.key);
    deniedKeys.delete(prepared.key);
    return { granted: true, already: true, reason: prepared.reason };
  }
  if (opts.interactive === false) {
    return { granted: false, already: false, reason: prepared.reason, message: denialMessage(prepared.reason) };
  }
  if (!opts.force && deniedKeys.has(prepared.key)) {
    return { granted: false, suppressed: true, reason: prepared.reason, message: denialMessage(prepared.reason) };
  }

  let didRequest = false;
  let requestError = null;
  const info = {
    permission: prepared.permission,
    origins: prepared.query.origins || [],
    query: prepared.query,
    reason: prepared.reason,
    title: TITLE,
    confirm: async () => {
      didRequest = true;
      return Boolean(await api.request(prepared.query));
    },
  };
  const promptUser = opts.prompt || prompterOverride || defaultPrompt;
  let answer;
  try {
    answer = await promptUser(info);
  } catch (err) {
    requestError = err;
  }
  if (requestError) return { granted: false, reason: prepared.reason, message: failureMessage(prepared, requestError) };

  const obj = answer && typeof answer === "object";
  const granted = obj ? Boolean(answer.granted) : Boolean(answer);
  const alreadyRequested = didRequest || Boolean(obj && answer.requested);
  if (!alreadyRequested) {
    if (!granted) {
      deniedKeys.add(prepared.key);
      return { granted: false, reason: prepared.reason, message: denialMessage(prepared.reason) };
    }
    try {
      const ok = await api.request(prepared.query);
      if (!ok) {
        deniedKeys.add(prepared.key);
        return { granted: false, reason: prepared.reason, message: denialMessage(prepared.reason) };
      }
    } catch (err) {
      return { granted: false, reason: prepared.reason, message: failureMessage(prepared, err) };
    }
  } else if (!granted) {
    deniedKeys.add(prepared.key);
    return { granted: false, reason: prepared.reason, message: denialMessage(prepared.reason) };
  }
  if (prepared.cacheable) grantedKeys.add(prepared.key);
  deniedKeys.delete(prepared.key);
  return { granted: true, already: false, reason: prepared.reason };
}

function watchRevokes(api) {
  if (!api || watchedApis.has(api) || typeof api.onRemoved?.addListener !== "function") return;
  watchedApis.add(api);
  api.onRemoved.addListener(() => {
    grantedKeys.clear();
    deniedKeys.clear();
  });
}

function isSpecificOrigin(origin) {
  if (origin === "file://*/*") return true;
  return /^https?:\/\/[^/*]+\/\*$/.test(origin);
}

function isUserVisibleDocument() {
  if (typeof document === "undefined" || !document.body) return false;
  const path = globalThis.location?.pathname || "";
  if (path.includes("offscreen")) return false;
  return true;
}

async function defaultPrompt(info) {
  if (isUserVisibleDocument()) {
    const granted = await mountPermissionPrompt(document, {
      title: info.title,
      reason: info.reason,
      query: info.query,
      request: () => info.confirm(),
    });
    return { granted, requested: true };
  }
  const runtime = globalThis.chrome?.runtime;
  if (typeof runtime?.sendMessage !== "function") return false;
  try {
    const res = await runtime.sendMessage({
      type: "pl.permission.prompt",
      reason: info.reason,
      title: info.title,
      query: info.query,
    });
    return { granted: Boolean(res?.granted), requested: true };
  } catch {
    return false;
  }
}

function ensurePromptStyle(doc) {
  if (doc.getElementById("pl-permission-style")) return;
  const style = doc.createElement("style");
  style.id = "pl-permission-style";
  style.textContent = `
    .pl-permission { position: fixed; inset: 0; z-index: 2147483646; background: rgba(28, 25, 23, 0.45); display: flex; align-items: flex-end; justify-content: center; padding: 16px; }
    .pl-permission-card { width: min(420px, 100%); background: var(--surface, #fff); color: var(--ink, #1c1917); border: 1px solid var(--line, #e6e1d8); border-radius: 14px; padding: 16px; box-shadow: 0 16px 40px rgba(28, 25, 23, 0.18); }
    .pl-permission-card h2 { margin: 0 0 8px; font-size: 15px; }
    .pl-permission-reason, .pl-permission-note { margin: 0 0 10px; }
    .pl-permission-note { color: var(--muted, #78716c); font-size: 12px; }
    .pl-permission-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .pl-permission-actions button { border-radius: 999px; padding: 6px 12px; border: 1px solid var(--line, #e6e1d8); background: transparent; }
    .pl-permission-actions [data-pl-permission-grant] { background: var(--accent, #c45c26); color: #fff; border-color: transparent; }
  `;
  (doc.head || doc.documentElement).append(style);
}

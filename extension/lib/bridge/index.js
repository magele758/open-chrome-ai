/**
 * 外部 Agent 控制入口：受开关保护（agentBridgeEnabled，默认关闭）+ origin 白名单。
 * 传输：
 *   1. 通过 CDP 对扩展 Service Worker 做 Runtime.evaluate：`await __pl.call({...})`
 *   2. 扩展内部页面 chrome.runtime.sendMessage({ type: "pl.bridge.call", request })
 *   3. 文件 inbox（action: "bridge_call"）
 * 规范见 docs/agent-interop.md。
 */

import { getCdp } from "../cdp.js";
import { inject, injectFrames, restrictedUrl, runJsInTab } from "../chrome.js";
import { createSwClipboard } from "../clipboard-sw.js";
import { loadSettings, saveSettings } from "../storage.js";
import {
  BRIDGE_PROTOCOL,
  BridgeError,
  ERROR_CODES,
  errorResponse,
  okResponse,
  requestFingerprint,
  validateRequest,
} from "./protocol.js";
import { isUrlAllowed } from "./policy.js";
import { createBridgeTools } from "./tools.js";

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const AUDIT_MAX = 100;
const JOB_MAX = 50;

export function createDefaultEnv() {
  return {
    getSettings: loadSettings,
    tabs: {
      get: (id) => chrome.tabs.get(id),
      query: (q) => chrome.tabs.query(q),
      create: (props) => chrome.tabs.create(props),
      update: (id, props) => chrome.tabs.update(id, props),
      reload: (id) => chrome.tabs.reload(id),
      goBack: (id) => chrome.tabs.goBack(id),
      goForward: (id) => chrome.tabs.goForward(id),
      remove: (id) => chrome.tabs.remove(id),
    },
    windows: {
      getAll: (q) => chrome.windows.getAll(q),
      get: (id, q) => chrome.windows.get(id, q),
      create: (props) => chrome.windows.create(props),
      update: (id, props) => chrome.windows.update(id, props),
      remove: (id) => chrome.windows.remove(id),
    },
    downloads: chrome.downloads,
    saveSettings,
    inject,
    injectFrames,
    runJs: runJsInTab,
    cdp: getCdp(),
    clipboard: createSwClipboard(),
    platform: () => (/Mac/i.test(globalThis.navigator?.userAgent || "") ? "mac" : "other"),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    extensionVersion: () => chrome.runtime.getManifest().version,
  };
}

function checkArgs(tool, args) {
  const schema = tool.parameters || {};
  const props = schema.properties || {};
  for (const key of Object.keys(args)) {
    if (!(key in props)) throw new BridgeError(ERROR_CODES.BAD_ARGS, `未知参数：${key}（工具 ${tool.name}）`);
  }
  for (const key of schema.required || []) {
    if (args[key] == null || args[key] === "") throw new BridgeError(ERROR_CODES.BAD_ARGS, `缺少参数：${key}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const type = props[key]?.type;
    if (value == null || !type) continue;
    const ok =
      (type === "string" && typeof value === "string") ||
      (type === "integer" && Number.isInteger(value)) ||
      (type === "number" && typeof value === "number") ||
      (type === "boolean" && typeof value === "boolean") ||
      (type === "array" && Array.isArray(value)) ||
      (type === "object" && typeof value === "object" && !Array.isArray(value));
    if (!ok) throw new BridgeError(ERROR_CODES.BAD_ARGS, `参数 ${key} 类型应为 ${type}。`);
  }
}

export function createBridge(env = createDefaultEnv()) {
  const tools = createBridgeTools(env);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const cache = new Map();
  const jobs = new Map();
  const audit = [];
  let exclusiveTail = Promise.resolve();

  const describe = (t) => ({
    name: t.name,
    description: t.description,
    focus: t.focus,
    needsTab: t.needsTab,
    parameters: t.parameters,
  });
  const metaTools = [
    { name: "list_tools", description: "列出可用工具（同 hello().tools）。", focus: "none", needsTab: false, parameters: { type: "object", properties: {}, additionalProperties: false, required: [] } },
    {
      name: "job_status",
      description: "查询 async 请求的状态；status=done 时 response 即最终响应。",
      focus: "none",
      needsTab: false,
      parameters: { type: "object", properties: { jobId: { type: "string" } }, additionalProperties: false, required: ["jobId"] },
    },
    { name: "audit_log", description: "最近 100 次调用的审计记录（不含参数内容）。", focus: "none", needsTab: false, parameters: { type: "object", properties: {}, additionalProperties: false, required: [] } },
  ];

  async function hello() {
    const settings = await env.getSettings();
    const enabled = settings.agentBridgeEnabled === true;
    return {
      protocol: BRIDGE_PROTOCOL,
      name: "pagelens-bridge",
      extensionVersion: env.extensionVersion?.() ?? null,
      enabled,
      allowedOrigins: enabled ? settings.agentBridgeOrigins : [],
      errorCodes: Object.keys(ERROR_CODES),
      tools: enabled ? [...metaTools, ...tools].map(describe) : [],
    };
  }

  async function authorizeTab(tabId, settings) {
    if (!Number.isInteger(tabId) || tabId < 1) throw new BridgeError(ERROR_CODES.BAD_ARGS, "tabId 必须是正整数。");
    let tab;
    try {
      tab = await env.tabs.get(tabId);
    } catch (err) {
      throw new BridgeError(ERROR_CODES.TAB_NOT_FOUND, `找不到标签 ${tabId}：${err?.message || err}`);
    }
    if (!tab) throw new BridgeError(ERROR_CODES.TAB_NOT_FOUND, `找不到标签 ${tabId}`);
    for (let i = 0; i < 40 && !tab.url && tab.pendingUrl; i += 1) {
      await env.sleep(100);
      tab = await env.tabs.get(tabId);
    }
    if (restrictedUrl(tab.url)) throw new BridgeError(ERROR_CODES.TAB_RESTRICTED, `受限页：${tab.url || "(空)"}`);
    if (!isUrlAllowed(tab.url, settings.agentBridgeOrigins)) {
      let origin = tab.url;
      try {
        origin = new URL(tab.url).origin;
      } catch {
        /* 保留原始 URL */
      }
      throw new BridgeError(ERROR_CODES.ORIGIN_NOT_ALLOWED, `标签 ${tabId} 的 origin 不在白名单：${origin}`, {
        hint: "在设置里把该 origin 加入 agentBridgeOrigins（仅在专用 profile 中启用）。",
        details: { origin },
      });
    }
    return tab;
  }

  function authorizeUrl(url, settings) {
    if (!isUrlAllowed(url, settings.agentBridgeOrigins)) {
      throw new BridgeError(ERROR_CODES.ORIGIN_NOT_ALLOWED, `URL 不在白名单：${url}`, { details: { url: String(url ?? "") } });
    }
    return String(url);
  }

  function withTimeout(promise, ms, tool) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new BridgeError(ERROR_CODES.TIMEOUT, `${tool} 超时（${ms}ms）；操作可能仍在执行，重试前请先回读校验。`)),
        ms,
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function enqueueExclusive(fn) {
    const run = exclusiveTail.then(fn, fn);
    exclusiveTail = run.catch(() => {});
    return run;
  }

  function record(entry) {
    audit.push(entry);
    if (audit.length > AUDIT_MAX) audit.shift();
  }

  function prune() {
    const now = env.now();
    for (const [id, entry] of cache) {
      if (entry.done && now - entry.at > CACHE_TTL_MS) cache.delete(id);
    }
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    while (jobs.size > JOB_MAX) jobs.delete(jobs.keys().next().value);
  }

  async function execute(req, settings) {
    const started = env.now();
    const meta = { tool: req.tool };
    const artifacts = [];
    let tabId = null;
    try {
      if (req.tool === "list_tools") {
        return okResponse(req.id, { tools: [...metaTools, ...tools].map(describe) }, { meta: { ...meta, ms: 0 } });
      }
      if (req.tool === "audit_log") return okResponse(req.id, { entries: [...audit] }, { meta });
      if (req.tool === "job_status") {
        checkArgs(metaTools[1], req.args);
        const job = jobs.get(req.args.jobId);
        if (!job) throw new BridgeError(ERROR_CODES.JOB_NOT_FOUND, `没有任务 ${req.args.jobId}（Service Worker 重启会丢失任务）。`);
        return okResponse(req.id, job.response ? { status: "done", response: job.response } : { status: "running" }, { meta });
      }
      const tool = byName.get(req.tool);
      if (!tool) {
        throw new BridgeError(ERROR_CODES.UNKNOWN_TOOL, `未知工具：${req.tool}`, { hint: "用 list_tools 查看可用工具。" });
      }
      checkArgs(tool, req.args);
      meta.focus = tool.focus;
      const ctx = { settings, artifacts, meta, tab: null, authorizeTab: (id) => authorizeTab(id, settings), authorizeUrl: (url) => authorizeUrl(url, settings) };
      const run = async () => {
        if (tool.needsTab) {
          ctx.tab = await authorizeTab(req.args.tabId, settings);
          tabId = ctx.tab.id;
          meta.tabId = tabId;
        }
        return tool.execute(req.args, ctx);
      };
      const guarded = tool.exclusive ? () => enqueueExclusive(run) : run;
      const result = await withTimeout(guarded(), req.timeoutMs, req.tool);
      meta.ms = env.now() - started;
      record({ ts: started, id: req.id, tool: req.tool, tabId, ok: true, ms: meta.ms });
      return okResponse(req.id, result, { artifacts, meta });
    } catch (err) {
      meta.ms = env.now() - started;
      if (tabId) meta.tabId = tabId;
      const res = errorResponse(req.id, err, { meta });
      record({ ts: started, id: req.id, tool: req.tool, tabId, ok: false, code: res.error.code, ms: meta.ms });
      return res;
    }
  }

  async function call(rawReq) {
    let req;
    try {
      req = validateRequest(rawReq);
    } catch (err) {
      return errorResponse(rawReq?.id, err);
    }
    let settings;
    try {
      settings = await env.getSettings();
    } catch (err) {
      return errorResponse(req.id, err);
    }
    if (settings.agentBridgeEnabled !== true) {
      return errorResponse(
        req.id,
        new BridgeError(ERROR_CODES.DISABLED, "外部控制入口未启用。仅在专用 profile 的设置里打开 agentBridgeEnabled。", { retryable: false }),
      );
    }

    prune();
    const fp = requestFingerprint(req);
    const hit = cache.get(req.id);
    if (hit) {
      if (hit.fp !== fp) {
        return errorResponse(req.id, new BridgeError(ERROR_CODES.ID_CONFLICT, "相同 id 的请求内容不同；请换新 id。", { retryable: false }));
      }
      const res = await hit.promise;
      return { ...res, meta: { ...res.meta, replayed: true } };
    }

    const entry = { fp, at: env.now(), done: false };
    const promise = execute(req, settings).then((res) => {
      entry.done = true;
      entry.at = env.now();
      if (!res.ok && res.error.retryable) cache.delete(req.id);
      return res;
    });
    entry.promise = promise;
    cache.set(req.id, entry);

    if (req.async && !["job_status", "list_tools", "audit_log"].includes(req.tool)) {
      const job = { response: null };
      jobs.set(req.id, job);
      promise.then((res) => {
        job.response = res;
      });
      const ack = okResponse(req.id, { jobId: req.id, status: "running" }, { meta: { async: true, tool: req.tool } });
      entry.promise = Promise.resolve(ack);
      return ack;
    }
    return promise;
  }

  return { hello, call, tools, audit: () => [...audit] };
}

let installed = null;

/** 在 Service Worker 里挂 `globalThis.__pl` 与 runtime 消息入口。 */
export function installBridge(env) {
  if (installed) return installed;
  const bridge = createBridge(env);
  installed = bridge;
  globalThis.__pl = {
    protocol: BRIDGE_PROTOCOL,
    hello: () => bridge.hello(),
    call: (request) => bridge.call(request),
  };
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender?.id !== chrome.runtime.id) return false;
    if (msg?.type === "pl.bridge.hello") {
      bridge.hello().then(sendResponse).catch((err) => sendResponse(errorResponse(null, err)));
      return true;
    }
    if (msg?.type === "pl.bridge.call") {
      bridge.call(msg.request).then(sendResponse);
      return true;
    }
    return false;
  });
  return bridge;
}

export function getBridge() {
  return installed;
}

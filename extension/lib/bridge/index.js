/**
 * 外部 Agent 控制入口。
 * 传输：
 *   1. 通过 CDP 对扩展 Service Worker 做 Runtime.evaluate：`await __pl.call({...})`
 *   2. 扩展内部页面 chrome.runtime.sendMessage({ type: "pl.bridge.call", request })
 *   3. 文件 inbox（action: "bridge_call"）
 *   4. Native Host 网关（MCP 垫片 / 本机 socket → connectNative 长连接），见 ../native-port.js
 * 鉴权：
 *   - 无 session（1–3 无 token）：agentBridgeEnabled 开关 + agentBridgeOrigins 白名单（旧行为）。
 *   - 有 session（4，或 inbox job 带 token）：每次调用都校验 token、工具 scope、token 的 origin 范围。
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
import { publicTokenInfo, requireScope, scopeAllows, tokenUrlAllowed, verifyToken } from "./auth.js";
import { loadAgentTokens } from "./token-store.js";
import { auditEntry, getAuditLog, originOfUrl } from "./audit.js";
import { enforceTokenGuards } from "./trust-guard.js";
import { chromeStorageAdapter, createApprovalQueue } from "../agent/trust/approval-queue.js";

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
    getAgentTokens: () => loadAgentTokens(),
    auditLog: getAuditLog(),
    approvals: createApprovalQueue({ storage: chromeStorageAdapter() }),
  };
}

const META_TOOLS = new Set(["list_tools", "job_status", "audit_log"]);

function originOf(url) {
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    /* 保留原始 URL */
  }
  return origin;
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
  const auditLog = env.auditLog || null;
  const loadTokens = env.getAgentTokens || (async () => []);
  const approvals = env.approvals || createApprovalQueue({ now: () => env.now() });
  let exclusiveTail = Promise.resolve();

  const describe = (t) => ({
    name: t.name,
    description: t.description,
    focus: t.focus,
    needsTab: t.needsTab,
    ...(t.scope ? { scope: t.scope } : {}),
    parameters: t.parameters,
  });
  const visibleTools = (auth) => (auth ? tools.filter((t) => scopeAllows(auth.record, t.scope)) : tools);
  const metaTools = [
    { name: "list_tools", description: "列出可用工具（同 hello().tools）。", focus: "none", needsTab: false, parameters: { type: "object", properties: {}, additionalProperties: false, required: [] } },
    {
      name: "job_status",
      description: "查询 async 请求的状态；status=done 时 response 即最终响应。",
      focus: "none",
      needsTab: false,
      parameters: { type: "object", properties: { jobId: { type: "string" } }, additionalProperties: false, required: ["jobId"] },
    },
    {
      name: "audit_log",
      description: "最近的调用审计记录（参数只有脱敏摘要）。网关会话只返回本 token 的记录。",
      focus: "none",
      needsTab: false,
      parameters: { type: "object", properties: { limit: { type: "integer", description: "默认 50，最大 500" } }, additionalProperties: false, required: [] },
    },
  ];

  async function authenticate(session) {
    const record = await verifyToken(await loadTokens(), session?.token, env.now());
    return {
      record,
      sessionId: String(session?.sessionId || "") || null,
      agentName: String(session?.agentName || "").slice(0, 80) || null,
    };
  }

  const keyFor = (auth, id) => (auth ? `${auth.record.id}\u0000${id}` : id);

  async function hello({ session } = {}) {
    const settings = await env.getSettings();
    if (session) {
      const auth = await authenticate(session);
      return {
        protocol: BRIDGE_PROTOCOL,
        name: "pagelens-bridge",
        extensionVersion: env.extensionVersion?.() ?? null,
        enabled: true,
        agent: publicTokenInfo(auth.record, env.now()),
        allowedOrigins: auth.record.origins,
        errorCodes: Object.keys(ERROR_CODES),
        tools: [...metaTools, ...visibleTools(auth)].map(describe),
      };
    }
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

  function originDenied(what, url, auth, extra = {}) {
    const origin = originOf(url);
    return new BridgeError(ERROR_CODES.ORIGIN_NOT_ALLOWED, `${what} 的 origin 不在${auth ? ` token「${auth.record.name}」的范围` : "白名单"}：${origin}`, {
      hint: auth
        ? "在 PageLens 设置 → 外部 Agent 新建一个 origin 范围包含它的 token。"
        : "在设置里把该 origin 加入 agentBridgeOrigins（仅在专用 profile 中启用）。",
      details: { origin, ...extra },
    });
  }

  function urlAllowed(url, settings, auth) {
    return auth ? tokenUrlAllowed(auth.record, url) : isUrlAllowed(url, settings.agentBridgeOrigins);
  }

  function authorizeUrl(url, settings, auth) {
    const value = String(url || "");
    if (!urlAllowed(value, settings, auth)) throw originDenied("URL", value, auth, { url: value });
    return value;
  }

  async function authorizeTab(tabId, settings, auth) {
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
    if (!urlAllowed(tab.url, settings, auth)) throw originDenied(`标签 ${tabId}`, tab.url, auth);
    return tab;
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

  function record(entry, req, auth, origin) {
    audit.push(entry);
    if (audit.length > AUDIT_MAX) audit.shift();
    persist(req, auth, { ...entry, origin });
  }

  function persist(req, auth, { ts, ok, code, ms, origin, session, trust }) {
    if (!auditLog) return;
    const s = auth || session || null;
    const entry = auditEntry({
      ts: ts ?? env.now(),
      agent: auth ? auth.record.name : session ? s.agentName || "unknown" : "legacy",
      agentId: auth?.record.id || null,
      sessionId: s?.sessionId || null,
      tool: req?.tool,
      origin,
      args: req?.args,
      ok,
      code,
      ms,
      ...trust,
    });
    auditLog.append(entry).catch(() => {});
  }

  function prune() {
    const now = env.now();
    for (const [id, entry] of cache) {
      if (entry.done && now - entry.at > CACHE_TTL_MS) cache.delete(id);
    }
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    while (jobs.size > JOB_MAX) jobs.delete(jobs.keys().next().value);
  }

  async function execute(req, settings, auth) {
    const started = env.now();
    const meta = { tool: req.tool };
    const artifacts = [];
    let tabId = null;
    let origin = originOfUrl(req.args?.url);
    let trust = null;
    try {
      if (req.tool === "list_tools") {
        const result = { tools: [...metaTools, ...visibleTools(auth)].map(describe) };
        if (auth) result.agent = publicTokenInfo(auth.record, env.now());
        return okResponse(req.id, result, { meta: { ...meta, ms: 0 } });
      }
      if (req.tool === "audit_log") {
        checkArgs(metaTools[2], req.args);
        if (!auth) return okResponse(req.id, { entries: [...audit] }, { meta });
        const entries = auditLog ? await auditLog.list({ agentId: auth.record.id, limit: Math.min(req.args.limit || 50, 500) }) : [];
        return okResponse(req.id, { entries }, { meta });
      }
      if (req.tool === "job_status") {
        checkArgs(metaTools[1], req.args);
        const job = jobs.get(keyFor(auth, req.args.jobId));
        if (!job) throw new BridgeError(ERROR_CODES.JOB_NOT_FOUND, `没有任务 ${req.args.jobId}（Service Worker 重启会丢失任务）。`);
        return okResponse(req.id, job.response ? { status: "done", response: job.response } : { status: "running" }, { meta });
      }
      const tool = byName.get(req.tool);
      if (!tool) {
        throw new BridgeError(ERROR_CODES.UNKNOWN_TOOL, `未知工具：${req.tool}`, { hint: "用 list_tools 查看可用工具。" });
      }
      if (auth) requireScope(auth.record, tool.scope, tool.name);
      checkArgs(tool, req.args);
      meta.focus = tool.focus;
      // 会话里工具看到的白名单就是 token 的 origin 范围（list_tabs / open_tab 等直接读 settings）。
      const toolSettings = auth ? { ...settings, agentBridgeOrigins: auth.record.origins } : settings;
      const ctx = {
        settings: toolSettings,
        artifacts,
        meta,
        tab: null,
        session: auth
          ? {
              agentId: auth.record.id,
              agentName: auth.record.name,
              sessionId: auth.sessionId,
              tokenId: auth.record.id,
              egress: auth.record.egress || [],
              skipIrreversible: auth.record.skipIrreversible === true,
            }
          : null,
        authorizeTab: (id) => authorizeTab(id, settings, auth),
        authorizeUrl: (url) => authorizeUrl(url, settings, auth),
      };
      const run = async () => {
        if (tool.needsTab) {
          ctx.tab = await authorizeTab(req.args.tabId, settings, auth);
          tabId = ctx.tab.id;
          meta.tabId = tabId;
          origin = originOfUrl(ctx.tab.url);
        }
        if (auth) {
          trust = await enforceTokenGuards(tool.name, req.args, {
            record: auth.record,
            settings,
            targetUrl: ctx.tab?.url || "",
            elementText: tool.trustHint?.(req.args, ctx) || "",
            approvals,
            sessionId: auth.sessionId,
          });
        }
        return tool.execute(req.args, ctx);
      };
      const guarded = tool.exclusive ? () => enqueueExclusive(run) : run;
      const result = await withTimeout(guarded(), req.timeoutMs, req.tool);
      meta.ms = env.now() - started;
      if (trust?.confirmed) meta.confirmed = true;
      record({ ts: started, id: req.id, tool: req.tool, tabId, ok: true, ms: meta.ms, trust }, req, auth, origin);
      return okResponse(req.id, result, { artifacts, meta });
    } catch (err) {
      meta.ms = env.now() - started;
      if (tabId) meta.tabId = tabId;
      const res = errorResponse(req.id, err, { meta });
      record({ ts: started, id: req.id, tool: req.tool, tabId, ok: false, code: res.error.code, ms: meta.ms, trust }, req, auth, origin);
      return res;
    }
  }

  /**
   * @param rawReq 协议 v1 请求
   * @param opts.session 来自网关或带 token 的 inbox job：{ token, sessionId, agentName }
   */
  async function call(rawReq, { session } = {}) {
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
    let auth = null;
    if (session) {
      try {
        auth = await authenticate(session);
      } catch (err) {
        const res = errorResponse(req.id, err);
        persist(req, null, { ok: false, code: res.error.code, origin: originOfUrl(req.args?.url), session: { sessionId: session.sessionId, agentName: session.agentName } });
        return res;
      }
    } else if (settings.agentBridgeEnabled !== true) {
      return errorResponse(
        req.id,
        new BridgeError(ERROR_CODES.DISABLED, "外部控制入口未启用。仅在专用 profile 的设置里打开 agentBridgeEnabled。", { retryable: false }),
      );
    }

    prune();
    const fp = requestFingerprint(req);
    const key = keyFor(auth, req.id);
    const hit = cache.get(key);
    if (hit) {
      if (hit.fp !== fp) {
        return errorResponse(req.id, new BridgeError(ERROR_CODES.ID_CONFLICT, "相同 id 的请求内容不同；请换新 id。", { retryable: false }));
      }
      const res = await hit.promise;
      return { ...res, meta: { ...res.meta, replayed: true } };
    }

    const entry = { fp, at: env.now(), done: false };
    const promise = execute(req, settings, auth).then((res) => {
      entry.done = true;
      entry.at = env.now();
      if (!res.ok && res.error.retryable) cache.delete(key);
      return res;
    });
    entry.promise = promise;
    cache.set(key, entry);

    if (req.async && !META_TOOLS.has(req.tool)) {
      const job = { response: null };
      jobs.set(key, job);
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

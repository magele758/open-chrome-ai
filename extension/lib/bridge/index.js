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
import { nativeSavedTabGroups } from "../native-host.js";
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
import { flowBridgeCall } from "./tools-flow.js";
import { publicTokenInfo, requireScope, scopeAllows, tokenUrlAllowed, verifyToken } from "./auth.js";
import { loadAgentTokens } from "./token-store.js";
import { auditEntry, getAuditLog, originOfUrl } from "./audit.js";
import { createEventBus, installEventSources } from "./events.js";
import { chromeTabGroups, createKeyedQueue, createTabLeases, leaseGuarded, openedTabIds, queueKeys } from "./leases.js";
import { chromeSessionStorage, createJobStore } from "./jobs.js";
import { SESSION_META, SESSION_META_TOOLS, createSessionMeta, jobView } from "./session-tools.js";
import { enforceTokenGuards } from "./trust-guard.js";
import { chromeStorageAdapter, createApprovalQueue } from "../agent/trust/approval-queue.js";
import { onAgentTaskEvent } from "../agent/delegate.js";

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const AUDIT_MAX = 100;

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
      ungroup: (ids) => chrome.tabs.ungroup(ids),
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
    get cookies() {
      return chrome.cookies;
    },
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
    sessionStorage: chromeSessionStorage(),
    get tabGroups() {
      return chromeTabGroups();
    },
    get savedGroupsStorage() {
      return chrome.storage?.local || null;
    },
    nativeSavedTabGroups,
    approvals: createApprovalQueue({ storage: chromeStorageAdapter() }),
    onFlowProgress: (progress) => chrome.runtime.sendMessage({ type: "pl.flow.progress", ...progress }),
  };
}

const META_TOOLS = new Set(["list_tools", "job_status", "audit_log", ...SESSION_META]);

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
  const audit = [];
  const auditLog = env.auditLog || null;
  const loadTokens = env.getAgentTokens || (async () => []);
  const now = () => env.now?.() ?? Date.now();
  const events = env.events || createEventBus({ loadTokens, now });
  const leases = createTabLeases({ now, groups: () => env.tabGroups || null, tabs: env.tabs });
  const queue = createKeyedQueue();
  const jobs = createJobStore({ storage: env.sessionStorage || null, now });
  const approvals = env.approvals || createApprovalQueue({ now: () => env.now() });
  const flowRuns = new Map();

  const describe = (t) => ({
    name: t.name,
    description: t.description,
    focus: t.focus,
    needsTab: t.needsTab,
    ...(t.scope ? { scope: t.scope } : {}),
    parameters: t.parameters,
  });
  const visibleTools = (auth) => tools.filter((tool) => !tool.flowOnly && (
    auth
      ? scopeAllows(auth.record, tool.scope) && (tool.requiredScopes?.({}) || []).every((scope) => scopeAllows(auth.record, scope))
      : !tool.sessionOnly),
  );
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
    ...SESSION_META_TOOLS,
  ];
  const metaByName = new Map(metaTools.map((t) => [t.name, t]));
  const visibleMeta = (auth) => (auth ? metaTools : metaTools.filter((t) => !SESSION_META.has(t.name)));

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
        tools: [...visibleMeta(auth), ...visibleTools(auth)].map(describe),
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
      tools: enabled ? [...visibleMeta(null), ...visibleTools(null)].map(describe) : [],
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

  function withTimeout(promise, ms, tool, controller) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => {
          const error = new BridgeError(ERROR_CODES.TIMEOUT, `${tool} 超时（${ms}ms）；操作可能仍在执行，重试前请先回读校验。`);
          controller?.abort(error);
          reject(error);
        },
        ms,
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  const owner = (auth) => (auth ? { sessionId: auth.sessionId, agentId: auth.record.id, agentName: auth.agentName || auth.record.name } : null);
  const sessionMeta = createSessionMeta({
    events,
    leases,
    owner,
    authorizeTab: (tabId, auth, settings) => authorizeTab(tabId, settings, auth),
  });

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
  }

  async function guardFlowDialog(tabId, run) {
    const cdp = env.cdp;
    const fail = ({ type, message }) => {
      throw new BridgeError(ERROR_CODES.TOOL_FAILED, "页面弹出了浏览器对话框。", {
        details: { dialog: { type, message: String(message || "").slice(0, 200) } },
      });
    };
    const pending = cdp?.pendingDialog?.(tabId);
    if (pending) fail(pending);
    const watch = cdp?.watchDialog?.(tabId);
    if (!watch) return run();
    try {
      return await Promise.race([run(), watch.promise.then(fail)]);
    } finally {
      watch.cancel();
    }
  }

  async function executeFlow(tool, req, ctx, auth, session, controller) {
    const { id: tabId, url } = ctx.tab;
    if (!auth.sessionId) throw new BridgeError(ERROR_CODES.UNAUTHORIZED, "确定性流程需要外部 Agent 会话。");
    if (flowRuns.has(tabId)) throw new BridgeError(ERROR_CODES.TAB_LEASED, "该标签正在执行流程。", { retryable: true });
    const lock = { controller, signal: controller.signal, url, sessionId: auth.sessionId, runId: crypto.randomUUID() };
    lock.signal.throwIfAborted();

    let temporaryLease = null;
    if (!leases.holder(tabId)) {
      leases.claim(tabId, owner(auth));
      temporaryLease = leases.holder(tabId);
    }
    flowRuns.set(tabId, lock);

    const flowId = String(req.args.flowId).slice(0, 80);
    const announce = (status, { step, tool: stepTool, code } = {}) => {
      const data = {
        flowId, tabId, runId: lock.runId, source: "gateway", status,
        ...(typeof step === "string" ? { step: step.slice(0, 80) } : {}),
        ...(typeof stepTool === "string" ? { tool: stepTool.slice(0, 80) } : {}),
        ...(typeof code === "string" ? { code: code.slice(0, 80) } : {}),
      };
      ctx.progress(data);
      if (env.onFlowProgress) {
        // Progress is observational; a closed side panel must not block action.
        Promise.resolve().then(() => env.onFlowProgress(data)).catch(() => {});
      }
    };

    try {
      announce("running");
      const result = await tool.execute(req.args, {
        ...ctx,
        signal: lock.signal,
        flowProgress: (data) => announce("running", data),
        flowCall: async (name, args) => {
          lock.signal.throwIfAborted();
          const request = flowBridgeCall(name, args, tabId);
          const response = await call({ id: crypto.randomUUID(), ...request, timeoutMs: req.timeoutMs }, { session, flow: lock });
          if (!response.ok) {
            const code = response.error.details?.dialog ? "modal" : response.error.code;
            return { ok: false, code, error: response.error };
          }
          const dialog = response.result?.dialog;
          if (typeof dialog?.type === "string") return { ok: false, code: "modal", error: dialog };
          return response.result;
        },
      });
      lock.signal.throwIfAborted();
      announce(result.status === "verified" ? "verified" : "needs-review", result);
      return result;
    } catch (err) {
      announce("failed", { code: err?.code || ERROR_CODES.TOOL_FAILED });
      throw err;
    } finally {
      flowRuns.delete(tabId);
      if (temporaryLease && leases.holder(tabId) === temporaryLease) leases.release(tabId, auth.sessionId);
    }
  }

  async function execute(req, settings, auth, { session, flow } = {}) {
    const started = env.now();
    const meta = { tool: req.tool };
    const artifacts = [];
    let tabId = null;
    let origin = originOfUrl(req.args?.url);
    let trust = null;
    const controller = req.tool === "run_flow" ? new AbortController() : null;
    try {
      if (req.tool === "list_tools") {
        const result = { tools: [...visibleMeta(auth), ...visibleTools(auth)].map(describe) };
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
        const job = await jobs.get(keyFor(auth, req.args.jobId));
        if (!job) throw new BridgeError(ERROR_CODES.JOB_NOT_FOUND, `没有任务 ${req.args.jobId}（已过期或被更新的任务挤出）。`);
        return okResponse(req.id, jobView(job), { meta });
      }
      if (SESSION_META.has(req.tool)) {
        checkArgs(metaByName.get(req.tool), req.args);
        return okResponse(req.id, await sessionMeta(req.tool, req.args, auth, settings), { meta });
      }
      const tool = byName.get(req.tool);
      if (!tool || tool.flowOnly && !flow) {
        throw new BridgeError(ERROR_CODES.UNKNOWN_TOOL, `未知工具：${req.tool}`, { hint: "用 list_tools 查看可用工具。" });
      }
      if (auth) {
        requireScope(auth.record, tool.scope, tool.name);
      } else if (tool.sessionOnly) {
        throw new BridgeError(ERROR_CODES.UNAUTHORIZED, "此工具需要外部 Agent token。");
      }
      checkArgs(tool, req.args);
      if (auth) {
        for (const scope of tool.requiredScopes?.(req.args) || []) requireScope(auth.record, scope, tool.name);
      }
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
              // 与直调路径（trust-guard tokenEgressPolicy）一致：允许的出站目的地 = origins ∪ egress
              egress: [...auth.record.origins, ...(auth.record.egress || [])],
              skipIrreversible: auth.record.skipIrreversible === true,
            }
          : null,
        authorizeTab: (id) => authorizeTab(id, settings, auth),
        authorizeUrl: (url) => authorizeUrl(url, settings, auth),
        checkTabLease: (id) => {
          leases.check(id, owner(auth));
          const activeFlow = flowRuns.get(id);
          if (activeFlow && activeFlow !== flow) {
            throw new BridgeError(ERROR_CODES.TAB_LEASED, "该标签正在执行流程。", { retryable: true });
          }
        },
        trackTaskGroup: leases.trackTaskGroup,
        isTaskGroupedTab: leases.isTaskGroupedTab,
        progress: (data) => {
          if (req.async && auth) events.emit({ type: "job.progress", agentId: auth.record.id, jobId: req.id, tool: req.tool, status: "running", data });
        },
      };
      const run = async () => {
        flow?.signal.throwIfAborted();
        controller?.signal.throwIfAborted();
        if (tool.needsTab) {
          ctx.tab = await authorizeTab(req.args.tabId, settings, auth);
          tabId = ctx.tab.id;
          meta.tabId = tabId;
          origin = originOfUrl(ctx.tab.url);
          if (flow && flow.url !== ctx.tab.url) {
            throw new BridgeError(ERROR_CODES.BAD_ARGS, "流程目标页面已变化，请核对后重试。");
          }
          if (leaseGuarded(tool)) ctx.checkTabLease(tabId);
        }
        if (auth) {
          let elementText = "";
          if (typeof tool.trustHint === "function") {
            const hinted = await tool.trustHint(req.args, ctx);
            if (typeof hinted === "string") elementText = hinted;
          }
          trust = await enforceTokenGuards(tool.name, req.args, {
            record: auth.record,
            settings,
            targetUrl: ctx.tab?.url || "",
            elementText,
            approvals,
            sessionId: auth.sessionId,
          });
        }
        flow?.signal.throwIfAborted();
        if (controller) return executeFlow(tool, req, ctx, auth, session, controller);
        if (flow) return guardFlowDialog(tabId, () => tool.execute(req.args, ctx));
        return tool.execute(req.args, ctx);
      };
      const guarded = tool.exclusive ? () => queue.run(queueKeys(tool, req.args, tool.needsTab ? req.args.tabId : null), run) : run;
      const result = await withTimeout(guarded(), req.timeoutMs, req.tool, controller);
      if (auth) await leases.adopt(openedTabIds(tool.name, result), owner(auth)).catch(() => {});
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
  async function call(rawReq, { session, flow } = {}) {
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
    const promise = execute(req, settings, auth, { session, flow }).then((res) => {
      entry.done = true;
      entry.at = env.now();
      if (!res.ok && res.error.retryable) cache.delete(key);
      return res;
    });
    entry.promise = promise;
    cache.set(key, entry);

    if (req.async && !META_TOOLS.has(req.tool)) {
      const agentId = auth?.record.id || null;
      jobs.start(key, { tool: req.tool, sessionId: auth?.sessionId || null, agentId });
      if (agentId) events.emit({ type: "job.progress", agentId, jobId: req.id, tool: req.tool, status: "running" });
      promise.then((res) => {
        jobs.finish(key, res);
        if (agentId) events.emit({ type: "job.done", agentId, jobId: req.id, tool: req.tool, ok: res.ok, ...(res.ok ? {} : { code: res.error.code }) });
      });
      const ack = okResponse(req.id, { jobId: req.id, status: "running" }, { meta: { async: true, tool: req.tool } });
      entry.promise = Promise.resolve(ack);
      return ack;
    }
    return promise;
  }

  return {
    hello,
    call,
    tools,
    audit: () => [...audit],
    events,
    leases,
    jobs,
    /** 网关会话断开（socket 关闭）：清掉它的订阅与租约。 */
    closeSession(sessionId) {
      for (const run of flowRuns.values()) {
        if (run.sessionId === sessionId) run.controller.abort(new BridgeError(ERROR_CODES.UNAUTHORIZED, "外部 Agent 会话已断开。"));
      }
      events.closeSession(sessionId);
      leases.releaseSession(sessionId);
    },
    closeAllSessions() {
      for (const run of flowRuns.values()) run.controller.abort(new BridgeError(ERROR_CODES.UNAUTHORIZED, "外部 Agent 会话已断开。"));
      events.closeAll();
      leases.clear();
    },
  };
}

let installed = null;

/** 在 Service Worker 里挂 `globalThis.__pl` 与 runtime 消息入口。 */
export function installBridge(env) {
  if (installed) return installed;
  const bridge = createBridge(env);
  installed = bridge;
  installEventSources(bridge.events, chrome, { onAgentTaskEvent });
  chrome.tabs?.onRemoved?.addListener?.((tabId) => bridge.leases.dropTab(tabId));
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

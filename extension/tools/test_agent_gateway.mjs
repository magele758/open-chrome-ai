import assert from "node:assert/strict";
import { installMemoryIndexedDB } from "./idb_mem.mjs";
import {
  AGENT_SCOPES,
  SCOPE_PRESETS,
  createTokenRecord,
  generateToken,
  hashToken,
  hasActiveToken,
  looksLikeToken,
  normalizeTokenOrigins,
  publicTokenInfo,
  scopeAllows,
  tokenFileName,
  tokenState,
  tokenUrlAllowed,
  verifyToken,
} from "../lib/bridge/auth.js";
import { AUDIT_KEY, auditEntry, createAuditLog, summarizeArgs } from "../lib/bridge/audit.js";
import { createBridge } from "../lib/bridge/index.js";
import { DEFAULT_ALLOWED_ORIGINS, normalizeOriginPatterns, originMatches } from "../lib/bridge/policy.js";
import { createBridgeTools } from "../lib/bridge/tools.js";
import { addAgentToken, listAgentTokens, loadAgentTokens, removeAgentToken, revokeAgentToken } from "../lib/bridge/token-store.js";
import { createNativeGateway, reconnectDelay } from "../lib/native-port.js";
import { shouldRunGateway } from "../lib/bridge/gateway.js";
import { AGENT_HIDDEN_SETTINGS, isSensitiveSetting, planSettingsChange, settingsSnapshot } from "../lib/agent/settings-tools.js";
import { defaultSettings, normalizeSettings } from "../lib/storage.js";

// ---- tokens ----
{
  assert.equal(await hashToken("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const t = generateToken();
  assert.ok(looksLikeToken(t) && t.startsWith("plk_") && t.length === 47, t);
  assert.notEqual(generateToken(), t);

  const { token, record } = await createTokenRecord({ name: " Cursor ", scopes: ["page:read", "bogus", "tabs:read"], origins: ["https://a.com/", "bad", "*"] });
  assert.equal(record.name, "Cursor");
  assert.deepEqual(record.scopes, ["tabs:read", "page:read"], "unknown scopes dropped, canonical order");
  assert.deepEqual(record.origins, ["https://a.com", "*"]);
  assert.equal(record.hash, await hashToken(token));
  assert.ok(!JSON.stringify(record).includes(token), "plain token is never stored");
  assert.ok(!("hash" in publicTokenInfo(record)));

  await assert.rejects(createTokenRecord({ name: "", scopes: ["page:read"] }), /名称/);
  await assert.rejects(createTokenRecord({ name: "x", scopes: [] }), /scope/);

  const ok = await verifyToken([record], token);
  assert.equal(ok.id, record.id);
  for (const bad of ["", "plk_short", generateToken()]) {
    await assert.rejects(verifyToken([record], bad), (e) => e.code === "UNAUTHORIZED", bad);
  }
  await assert.rejects(verifyToken([{ ...record, revokedAt: 1 }], token), /已吊销/);
  await assert.rejects(verifyToken([{ ...record, expiresAt: 1000 }], token, 2000), /已过期/);
  assert.equal(tokenState({ ...record, expiresAt: 3000 }, 2000), "active");
  assert.ok(hasActiveToken([record]));
  assert.ok(!hasActiveToken([{ ...record, revokedAt: 1 }]));

  assert.ok(scopeAllows(record, "page:read") && !scopeAllows(record, "page:act") && !scopeAllows(record, undefined));
  assert.ok(tokenUrlAllowed(record, "https://anything.example/x"), "* covers any http(s) page");
  assert.ok(!tokenUrlAllowed(record, "file:///etc/passwd"), "* does not cover file://");
  const narrow = { ...record, origins: ["http://localhost:*"] };
  assert.ok(tokenUrlAllowed(narrow, "http://localhost:3000/") && !tokenUrlAllowed(narrow, "https://a.com/"));
  assert.ok(!tokenUrlAllowed({ ...record, origins: [] }, "https://a.com/"), "empty origin range allows nothing");

  assert.ok(originMatches("*", "https://x.y/") && !originMatches("*", "chrome://settings"));
  assert.ok(!normalizeOriginPatterns(["*"]).includes("*"), "legacy agentBridgeOrigins never accepts *");
  assert.deepEqual(normalizeTokenOrigins("https://a.com, http://localhost:*\nnope"), ["https://a.com", "http://localhost:*"]);
  assert.ok(!SCOPE_PRESETS.full.includes("agent:delegate"), "delegation stays closed until P4");
  assert.ok(SCOPE_PRESETS["read-only"].every((s) => !s.endsWith(":act")));
  assert.equal(tokenFileName("Claude Code!"), "claude-code");
}

// ---- token store ----
{
  const area = { data: {}, get: async (k) => ({ [k]: area.data[k] }), set: async (v) => Object.assign(area.data, structuredClone(v)) };
  const { token, info } = await addAgentToken({ name: "codex", scopes: SCOPE_PRESETS.operate, origins: ["*"] }, { storage: area });
  assert.ok(looksLikeToken(token));
  assert.equal(info.state, "active");
  assert.ok(!JSON.stringify(area.data).includes(token));
  await revokeAgentToken(info.id, { storage: area });
  assert.equal((await listAgentTokens({ storage: area }))[0].state, "revoked");
  await removeAgentToken(info.id, { storage: area });
  assert.equal((await loadAgentTokens(area)).length, 0);
}

// ---- every bridge tool declares a known scope ----
{
  const tools = createBridgeTools({ sleep: async () => {}, cdp: { send: async () => ({}) }, platform: () => "other" });
  for (const t of tools) assert.ok(AGENT_SCOPES.includes(t.scope), `${t.name} scope ${t.scope}`);
  const scopeOf = Object.fromEntries(tools.map((t) => [t.name, t.scope]));
  assert.equal(scopeOf.list_tabs, "tabs:read");
  assert.equal(scopeOf.open_tab, "tabs:manage");
  assert.equal(scopeOf.run_js, "page:js");
  assert.equal(scopeOf.trusted_click, "page:act");
  assert.equal(scopeOf.screenshot, "page:read");
  assert.equal(scopeOf.copy_selection_trusted, "clipboard");
}

// ---- session call path ----
const reader = await createTokenRecord({ name: "reader", scopes: ["tabs:read", "page:read"], origins: ["http://localhost:*"] });
const writer = await createTokenRecord({ name: "writer", scopes: ["tabs:read", "tabs:manage", "page:read", "page:js"], origins: ["*"] });
const tokens = [reader.record, writer.record];
const TABS = new Map([
  [1, { id: 1, windowId: 1, active: true, title: "Local", url: "http://localhost:8080/" }],
  [3, { id: 3, windowId: 1, active: false, title: "Bank", url: "https://bank.example/" }],
]);
let settings = { agentBridgeEnabled: false, agentBridgeOrigins: [...DEFAULT_ALLOWED_ORIGINS], agentGatewayEnabled: true };
const auditStore = { saved: null };
const audit = createAuditLog({ load: async () => [], save: async (v) => (auditStore.saved = v) });
const bridge = createBridge({
  getSettings: async () => settings,
  getAgentTokens: async () => tokens,
  auditLog: audit,
  tabs: {
    get: async (id) => {
      if (!TABS.has(id)) throw new Error(`No tab with id: ${id}`);
      return TABS.get(id);
    },
    query: async () => [...TABS.values()],
    create: async (props) => ({ id: 50, ...props }),
    update: async (id, props) => ({ id, ...props }),
  },
  inject: async () => ({ count: 0, items: [] }),
  runJs: async () => ({ ok: true, value: 42 }),
  cdp: { send: async () => ({ data: "AAAA" }) },
  clipboard: { write: async () => ({ via: "fake" }) },
  platform: () => "other",
  sleep: async () => {},
  now: () => Date.now(),
  extensionVersion: () => "test",
});
const asReader = { session: { token: reader.token, sessionId: "s-r", agentName: "script" } };
const asWriter = { session: { token: writer.token, sessionId: "s-w", agentName: "cursor" } };
{
  const legacy = await bridge.call({ id: "l1", tool: "list_tabs" });
  assert.equal(legacy.error.code, "DISABLED", "legacy CDP path still needs agentBridgeEnabled");

  const noToken = await bridge.call({ id: "n1", tool: "list_tabs" }, { session: { sessionId: "x" } });
  assert.equal(noToken.error.code, "UNAUTHORIZED");

  const list = await bridge.call({ id: "r1", tool: "list_tools" }, asReader);
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.includes("screenshot") && !names.includes("run_js") && !names.includes("open_tab"));
  assert.ok(names.includes("audit_log") && names.includes("job_status"), "meta tools always listed");
  assert.equal(list.result.agent.name, "reader");
  assert.ok(list.result.tools.find((t) => t.name === "screenshot").scope === "page:read");

  const hello = await bridge.hello(asReader);
  assert.deepEqual(hello.tools.map((t) => t.name), names);
  await assert.rejects(bridge.hello({ session: { token: "plk_bad" } }), (e) => e.code === "UNAUTHORIZED");

  const tabs = await bridge.call({ id: "r2", tool: "list_tabs" }, asReader);
  assert.deepEqual(tabs.result.map((t) => t.id), [1]);
  assert.equal((await bridge.call({ id: "r3", tool: "run_js", args: { tabId: 1, code: "1" } }, asReader)).error.code, "SCOPE_DENIED");
  assert.equal((await bridge.call({ id: "r4", tool: "query_dom", args: { tabId: 3, selector: "a" } }, asReader)).error.code, "ORIGIN_NOT_ALLOWED");
  assert.equal((await bridge.call({ id: "r5", tool: "query_dom", args: { tabId: 1, selector: "a" } }, asReader)).ok, true);

  const js = await bridge.call({ id: "w1", tool: "run_js", args: { tabId: 3, code: "return 42" } }, asWriter);
  assert.equal(js.ok, true, "writer token: page:js on * origins");
  const open = await bridge.call({ id: "w2", tool: "open_tab", args: { url: "https://news.example/?q=secret" } }, asWriter);
  assert.equal(open.ok, true, "open_tab uses the token origin range");

  // same request id from two agents must not collide in the idempotency cache
  const a = await bridge.call({ id: "same", tool: "list_tabs" }, asReader);
  const b = await bridge.call({ id: "same", tool: "list_tabs" }, asWriter);
  assert.ok(a.ok && b.ok && b.result.length === 2 && !b.meta.replayed);
  const replay = await bridge.call({ id: "same", tool: "list_tabs" }, asWriter);
  assert.equal(replay.meta.replayed, true);

  // async jobs are scoped to the token that created them
  const job = await bridge.call({ id: "job1", tool: "list_tabs", async: true }, asWriter);
  assert.equal(job.result.status, "running");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await bridge.call({ id: "js1", tool: "job_status", args: { jobId: "job1" } }, asWriter)).result.status, "done");
  assert.equal((await bridge.call({ id: "js2", tool: "job_status", args: { jobId: "job1" } }, asReader)).error.code, "JOB_NOT_FOUND");

  // revocation applies to the very next call
  tokens[1] = { ...writer.record, revokedAt: Date.now() };
  assert.equal((await bridge.call({ id: "w3", tool: "list_tabs" }, asWriter)).error.code, "UNAUTHORIZED");
  tokens[1] = writer.record;

  // legacy path is unaffected by tokens
  settings = { ...settings, agentBridgeEnabled: true };
  const legacyTabs = await bridge.call({ id: "l2", tool: "list_tabs" });
  assert.deepEqual(legacyTabs.result.map((t) => t.id), [1], "legacy uses agentBridgeOrigins");
  assert.ok((await bridge.call({ id: "l3", tool: "list_tools" })).result.tools.some((t) => t.name === "run_js"));
  settings = { ...settings, agentBridgeEnabled: false };

  const own = await bridge.call({ id: "a1", tool: "audit_log", args: { limit: 100 } }, asReader);
  assert.ok(own.result.entries.length >= 4);
  assert.ok(own.result.entries.every((e) => e.agentId === reader.record.id), "audit_log only shows the session's own agent");
  const denied = own.result.entries.find((e) => e.code === "SCOPE_DENIED");
  assert.equal(denied.tool, "run_js");
  assert.equal(denied.argsSummary.code, "[1 chars]", "code body is redacted");
  assert.equal(denied.sessionId, "s-r");

  await audit.whenIdle();
  const all = auditStore.saved;
  assert.ok(all.some((e) => e.agent === "legacy" && e.tool === "list_tabs"), "legacy calls are audited too");
  assert.ok(all.some((e) => e.code === "UNAUTHORIZED" && e.agentId === null));
  const openEntry = all.find((e) => e.tool === "open_tab");
  assert.equal(openEntry.argsSummary.url, "https://news.example/", "URL query stripped in audit");
  assert.equal(openEntry.origin, "https://news.example");
}

// ---- audit redaction + cap + persistence ----
{
  const s = summarizeArgs({
    tabId: 3,
    html: "<p>secret body</p>",
    selector: "#editor",
    url: "https://x.com/p?token=abc#h",
    apiKey: "sk-123",
    token: "plk_x",
    list: [1, 2, 3],
    source: { tabId: 2, selector: ".a", text: "hello", deep: { x: 1 } },
    activate: true,
  });
  assert.deepEqual(s, {
    tabId: 3,
    html: "[18 chars]",
    selector: "#editor",
    url: "https://x.com/p",
    apiKey: "[redacted]",
    token: "[redacted]",
    list: "[3 items]",
    source: { tabId: 2, selector: ".a", text: "[5 chars]", deep: "[object]" },
    activate: true,
  });
  assert.equal(summarizeArgs({ selector: "x".repeat(500) }).selector.length, 121);

  const small = createAuditLog({ cap: 5, load: async () => [], save: async () => true });
  for (let i = 0; i < 8; i += 1) await small.append(auditEntry({ ts: i, agent: i % 2 ? "a" : "b", agentId: i % 2 ? "A" : "B", tool: `t${i}`, ok: true }));
  const latest = await small.list({ limit: 10 });
  assert.deepEqual(latest.map((e) => e.ts), [7, 6, 5, 4, 3], "rolling cap keeps the newest, newest first");
  assert.deepEqual((await small.list({ agentId: "A" })).map((e) => e.ts), [7, 5, 3]);

  const mem = installMemoryIndexedDB();
  const persisted = createAuditLog();
  await persisted.append(auditEntry({ ts: 1, agent: "x", tool: "list_tabs", ok: true }));
  await persisted.append(auditEntry({ ts: 2, agent: "x", tool: "screenshot", ok: false, code: "SCOPE_DENIED" }));
  await persisted.whenIdle();
  assert.equal(mem.get(AUDIT_KEY).length, 2, "written to IndexedDB");
  const reopened = createAuditLog();
  assert.deepEqual((await reopened.list()).map((e) => e.tool), ["screenshot", "list_tabs"], "survives a SW restart");
  await reopened.clear();
  await reopened.whenIdle();
  assert.equal(mem.get(AUDIT_KEY).length, 0);
  delete globalThis.indexedDB;
}

// ---- native port dispatch with a fake chrome port ----
{
  function fakePort() {
    const port = {
      posted: [],
      disconnected: false,
      msgListeners: [],
      dcListeners: [],
      onMessage: { addListener: (fn) => port.msgListeners.push(fn) },
      onDisconnect: { addListener: (fn) => port.dcListeners.push(fn) },
      postMessage: (m) => port.posted.push(m),
      disconnect: () => {
        port.disconnected = true;
      },
      emit: (m) => port.msgListeners.forEach((fn) => fn(m)),
      hostDisconnect: () => port.dcListeners.forEach((fn) => fn()),
    };
    return port;
  }
  const ports = [];
  const timers = [];
  const statuses = [];
  let lastErr = "";
  const calls = [];
  const gw = createNativeGateway({
    bridge: {
      call: async (request, opts) => {
        calls.push({ request, opts });
        if (request.tool === "boom") throw new Error("kaboom");
        return { v: 1, id: request.id, ok: true, result: "done", meta: {} };
      },
    },
    connect: (name) => {
      assert.equal(name, "com.pagelens.host");
      const p = fakePort();
      ports.push(p);
      return p;
    },
    lastError: () => lastErr,
    onStatus: (s) => statuses.push(s),
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimer: () => {},
    extensionVersion: () => "9.9.9",
    extensionId: () => "abc",
  });
  gw.start();
  assert.deepEqual(ports[0].posted[0], { type: "broker.start", protocol: 2, extensionVersion: "9.9.9" });
  assert.equal(gw.status().state, "connecting");
  ports[0].emit({ type: "broker.ready", socketPath: "/s.sock", version: "1.4.0" });
  assert.equal(gw.status().state, "connected");
  assert.equal(gw.status().socketPath, "/s.sock");

  ports[0].emit({ type: "bridge.call", sessionId: "S1", callId: "b1", token: "plk_t", agentName: "cursor", request: { id: "r", tool: "list_tabs" } });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls[0].opts, { session: { token: "plk_t", sessionId: "S1", agentName: "cursor" } });
  assert.deepEqual(ports[0].posted[1], { type: "bridge.result", sessionId: "S1", callId: "b1", response: { v: 1, id: "r", ok: true, result: "done", meta: {} } });

  ports[0].emit({ type: "bridge.call", sessionId: "S1", callId: "b2", request: { id: "x", tool: "boom" } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ports[0].posted[2].response.ok, false, "a throwing bridge still answers");
  assert.equal(ports[0].posted[2].callId, "b2");

  lastErr = "Native host has exited.";
  ports[0].hostDisconnect();
  assert.equal(gw.status().state, "retrying");
  assert.match(gw.status().error, /意外退出/);
  assert.equal(timers.at(-1).ms, 1000);
  timers.at(-1).fn();
  assert.equal(ports.length, 2, "reconnected after backoff");
  lastErr = "";
  ports[1].emit({ type: "broker.error", error: "已有 PageLens 网关" });
  assert.ok(ports[1].disconnected);
  assert.equal(timers.at(-1).ms, 2000, "exponential backoff");
  assert.match(gw.status().error, /已有 PageLens 网关/);
  timers.at(-1).fn();
  ports[2].emit({ ok: false, error: "未知 op：(空)" });
  assert.match(gw.status().error, /不支持网关/, "old host without broker mode is reported");
  timers.at(-1).fn();
  ports[3].emit({ type: "broker.ready" });
  assert.equal(gw.status().state, "connected");

  // results for a port that went away are dropped, not posted to the new one
  ports[3].emit({ type: "bridge.call", sessionId: "S2", callId: "b9", request: { id: "late", tool: "list_tabs" } });
  gw.stop();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(ports[3].disconnected);
  assert.equal(ports[3].posted.filter((m) => m.type === "bridge.result").length, 0);
  assert.equal(gw.status().state, "stopped");
  const before = timers.length;
  ports[3].hostDisconnect();
  assert.equal(timers.length, before, "no reconnect after stop");
  assert.equal(reconnectDelay(20), 60000);
}

// ---- gateway switch + settings exposure ----
{
  assert.equal(defaultSettings().agentGatewayEnabled, false);
  assert.equal(normalizeSettings({ agentGatewayEnabled: "true" }).agentGatewayEnabled, false);
  assert.equal(normalizeSettings({ agentGatewayEnabled: true }).agentGatewayEnabled, true);
  assert.ok(!shouldRunGateway({ agentGatewayEnabled: true }, []), "needs at least one active token");
  assert.ok(!shouldRunGateway({ agentGatewayEnabled: false }, tokens));
  assert.ok(shouldRunGateway({ agentGatewayEnabled: true }, tokens));

  for (const key of AGENT_HIDDEN_SETTINGS) assert.ok(isSensitiveSetting(key), key);
  const plan = planSettingsChange(defaultSettings(), [{ key: "agentGatewayEnabled", value: true }, { key: "agentTokens", value: [] }]);
  assert.equal(plan.diff.length, 0);
  assert.equal(plan.errors.length, 2);
  assert.ok(plan.errors.every((e) => /外部 Agent/.test(e)));
  const snap = JSON.stringify(settingsSnapshot({ ...defaultSettings(), agentGatewayEnabled: true }));
  assert.ok(!/agentGatewayEnabled|agentTokens/.test(snap), "agents cannot read gateway/token settings");
}

console.log("test_agent_gateway: ok");

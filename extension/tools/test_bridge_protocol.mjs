import assert from "node:assert/strict";
import { BridgeError, ERROR_CODES, makeArtifact, toBridgeError, validateRequest } from "../lib/bridge/protocol.js";
import { DEFAULT_ALLOWED_ORIGINS, isUrlAllowed, normalizeBridgeSettings, originMatches } from "../lib/bridge/policy.js";
import { createBridge } from "../lib/bridge/index.js";
import { defaultSettings, normalizeSettings } from "../lib/storage.js";

// ---- policy ----
assert.ok(originMatches("https://mp.weixin.qq.com", "https://mp.weixin.qq.com/cgi-bin/appmsg?x=1"));
assert.ok(!originMatches("https://mp.weixin.qq.com", "http://mp.weixin.qq.com/"), "scheme must match");
assert.ok(!originMatches("https://mp.weixin.qq.com", "https://mp.weixin.qq.com.evil.com/"), "no suffix spoofing");
assert.ok(originMatches("http://localhost:*", "http://localhost:8080/x"));
assert.ok(!originMatches("http://localhost:8080", "http://localhost:9000/"));
assert.ok(originMatches("http://localhost:8080", "http://localhost:8080/"));
assert.ok(originMatches("https://*.example.com", "https://a.example.com/"));
assert.ok(!originMatches("https://*.example.com", "https://example.com/"));
assert.ok(!originMatches("garbage", "https://a.com"));
assert.ok(isUrlAllowed("http://127.0.0.1:3000/", DEFAULT_ALLOWED_ORIGINS));
assert.ok(!isUrlAllowed("https://bank.example/", DEFAULT_ALLOWED_ORIGINS));
assert.equal(normalizeBridgeSettings({}).agentBridgeEnabled, false, "default off");
assert.equal(normalizeBridgeSettings({ agentBridgeEnabled: "true" }).agentBridgeEnabled, false, "only boolean true enables");
assert.deepEqual(normalizeBridgeSettings({ agentBridgeOrigins: ["bad", "https://a.com/", "https://a.com"] }).agentBridgeOrigins, ["https://a.com"]);
assert.equal(defaultSettings().agentBridgeEnabled, false);
assert.equal(normalizeSettings({}).agentBridgeEnabled, false);
assert.equal(normalizeSettings({ agentBridgeEnabled: true }).agentBridgeEnabled, true);

// ---- protocol ----
assert.throws(() => validateRequest(null), (e) => e.code === ERROR_CODES.BAD_REQUEST);
assert.throws(() => validateRequest({ tool: "x" }), (e) => e.code === ERROR_CODES.BAD_REQUEST);
assert.throws(() => validateRequest({ id: "1" }), (e) => e.code === ERROR_CODES.BAD_REQUEST);
assert.throws(() => validateRequest({ id: "1", tool: "x", v: 2 }), (e) => e.code === ERROR_CODES.PROTOCOL_UNSUPPORTED);
assert.throws(() => validateRequest({ id: "1", tool: "x", args: [] }), (e) => e.code === ERROR_CODES.BAD_REQUEST);
assert.equal(validateRequest({ id: "1", tool: "x", timeoutMs: 9e9 }).timeoutMs, 120000, "timeout clamped");
assert.equal(toBridgeError(new Error("Another debugger is already attached to the tab")).code, ERROR_CODES.DEBUGGER_BUSY);
assert.equal(toBridgeError(new Error("该标签已被 DevTools 或其他调试器占用，请先关闭它的开发者工具。")).retryable, true);
assert.equal(toBridgeError(new Error("boom")).code, ERROR_CODES.TOOL_FAILED);
assert.equal(new BridgeError(ERROR_CODES.VERIFY_FAILED, "x").retryable, false);
assert.equal(makeArtifact("a.bin", "x/y", "AAAA", "base64").size, 3);

// ---- dispatcher with a mock env ----
const TABS = new Map([
  [1, { id: 1, windowId: 1, active: true, title: "Doocs", url: "http://localhost:8080/" }],
  [2, { id: 2, windowId: 1, active: false, title: "WeChat", url: "https://mp.weixin.qq.com/cgi-bin/appmsg" }],
  [3, { id: 3, windowId: 1, active: false, title: "Bank", url: "https://bank.example/" }],
  [4, { id: 4, windowId: 1, active: false, title: "Settings", url: "chrome://settings" }],
]);
let settings = { agentBridgeEnabled: false, agentBridgeOrigins: [...DEFAULT_ALLOWED_ORIGINS] };
let injectImpl = async () => ({ count: 0, items: [] });
const sent = [];
let sendImpl = async () => ({});
let created = 0;
const env = {
  getSettings: async () => settings,
  tabs: {
    get: async (id) => {
      if (!TABS.has(id)) throw new Error(`No tab with id: ${id}`);
      return TABS.get(id);
    },
    query: async () => [...TABS.values()],
    create: async (props) => ({ id: 100 + ++created, ...props }),
    update: async (id, props) => ({ id, ...props }),
  },
  inject: (...a) => injectImpl(...a),
  runJs: async () => ({ ok: true, result: 1 }),
  cdp: {
    send: async (tabId, method, params) => {
      sent.push({ tabId, method, params });
      return sendImpl(tabId, method, params);
    },
    ensure: async () => ({}),
  },
  clipboard: { write: async () => ({ via: "mock" }) },
  platform: () => "mac",
  sleep: async () => {},
  now: () => Date.now(),
  extensionVersion: () => "test",
};
const bridge = createBridge(env);
let n = 0;
const req = (tool, args = {}, extra = {}) => bridge.call({ id: `r${++n}`, tool, args, ...extra });

// disabled by default
let hello = await bridge.hello();
assert.equal(hello.enabled, false);
assert.deepEqual(hello.tools, []);
let res = await req("list_tabs");
assert.equal(res.ok, false);
assert.equal(res.error.code, ERROR_CODES.DISABLED);
assert.equal(res.error.retryable, false);

settings = { ...settings, agentBridgeEnabled: true };
hello = await bridge.hello();
assert.equal(hello.enabled, true);
assert.equal(hello.protocol, 1);
const names = hello.tools.map((t) => t.name);
for (const expected of [
  "list_tools", "job_status", "list_tabs", "open_tab", "query_dom", "run_js", "read_rendered_html", "screenshot",
  "clipboard_write", "set_input_value", "trusted_click", "trusted_type", "press_keys",
  "pick_rich_editor", "wechat_pick_body_editor", "verify_editor_content", "paste_rich_trusted", "copy_selection_trusted",
]) {
  assert.ok(names.includes(expected), `tool ${expected} advertised`);
}
const focusOf = Object.fromEntries(hello.tools.map((t) => [t.name, t.focus]));
assert.equal(focusOf.trusted_click, "emulated");
assert.equal(focusOf.activate_tab, "activates");
assert.equal(focusOf.read_rendered_html, "none");
assert.ok(!names.includes("upload_file"), "local file upload is not exposed");
assert.ok(!names.includes("drag_drop"));

res = await bridge.call({ tool: "list_tabs" });
assert.equal(res.error.code, ERROR_CODES.BAD_REQUEST);
res = await req("nope");
assert.equal(res.error.code, ERROR_CODES.UNKNOWN_TOOL);
res = await req("query_dom", { selector: "p" });
assert.equal(res.error.code, ERROR_CODES.BAD_ARGS, "tabId required");
res = await req("query_dom", { tabId: 1, selector: "p", bogus: 1 });
assert.equal(res.error.code, ERROR_CODES.BAD_ARGS, "unknown arg rejected");
res = await req("query_dom", { tabId: "1", selector: "p" });
assert.equal(res.error.code, ERROR_CODES.BAD_ARGS, "type checked");

// tab / origin authorisation
res = await req("query_dom", { tabId: 3, selector: "p" });
assert.equal(res.error.code, ERROR_CODES.ORIGIN_NOT_ALLOWED);
assert.equal(res.error.details.origin, "https://bank.example");
res = await req("query_dom", { tabId: 4, selector: "p" });
assert.equal(res.error.code, ERROR_CODES.TAB_RESTRICTED);
res = await req("query_dom", { tabId: 99, selector: "p" });
assert.equal(res.error.code, ERROR_CODES.TAB_NOT_FOUND);
res = await req("query_dom", { tabId: 1, selector: "p" });
assert.equal(res.ok, true);
assert.equal(res.meta.tabId, 1);

res = await req("list_tabs");
assert.deepEqual(res.result.map((t) => t.id), [1, 2], "only allow-listed origins are visible");

res = await req("open_tab", { url: "https://bank.example/" });
assert.equal(res.error.code, ERROR_CODES.ORIGIN_NOT_ALLOWED);
res = await req("open_tab", { url: "https://mp.weixin.qq.com/" });
assert.equal(res.ok, true);
assert.equal(res.result.tabId, 101);
res = await req("open_tab", { url: "http://localhost:8080/" });
assert.equal(res.ok, true);

// a freshly opened tab has no url yet (only pendingUrl) → wait for commit instead of failing as "restricted"
{
  let polls = 0;
  const realGet = env.tabs.get;
  env.tabs.get = async (id) => {
    if (id === 77) {
      polls += 1;
      return polls < 3 ? { id: 77, url: "", pendingUrl: "http://localhost:8080/x" } : { id: 77, url: "http://localhost:8080/x" };
    }
    return realGet(id);
  };
  injectImpl = async () => ({ items: [] });
  res = await req("query_dom", { tabId: 77, selector: "p" });
  assert.equal(res.ok, true);
  assert.ok(polls >= 3);
  env.tabs.get = realGet;
}

// idempotency
let calls = 0;
injectImpl = async () => {
  calls += 1;
  return { n: calls };
};
const first = await bridge.call({ id: "idem", tool: "query_dom", args: { tabId: 1, selector: "p" } });
const again = await bridge.call({ id: "idem", tool: "query_dom", args: { tabId: 1, selector: "p" } });
assert.equal(calls, 1, "same id + same payload runs once");
assert.deepEqual(again.result, first.result);
assert.equal(again.meta.replayed, true);
const conflict = await bridge.call({ id: "idem", tool: "query_dom", args: { tabId: 1, selector: "div" } });
assert.equal(conflict.error.code, ERROR_CODES.ID_CONFLICT);

// retryable failures are not cached → same id can be retried
let failOnce = true;
injectImpl = async () => {
  if (failOnce) {
    failOnce = false;
    throw new Error("Another debugger is already attached");
  }
  return { ok: true };
};
const busy1 = await bridge.call({ id: "retry-me", tool: "query_dom", args: { tabId: 1, selector: "p" } });
assert.equal(busy1.error.code, ERROR_CODES.DEBUGGER_BUSY);
assert.equal(busy1.error.retryable, true);
const busy2 = await bridge.call({ id: "retry-me", tool: "query_dom", args: { tabId: 1, selector: "p" } });
assert.equal(busy2.ok, true, "retry with same id re-executes");

// timeout
injectImpl = () => new Promise(() => {});
res = await req("query_dom", { tabId: 1, selector: "p" }, { timeoutMs: 30 });
assert.equal(res.error.code, ERROR_CODES.TIMEOUT);
assert.equal(res.error.retryable, true);

// async jobs
let release;
injectImpl = () => new Promise((resolve) => (release = () => resolve({ done: true })));
const ack = await bridge.call({ id: "job1", tool: "query_dom", args: { tabId: 1, selector: "p" }, async: true });
assert.equal(ack.ok, true);
assert.deepEqual(ack.result, { jobId: "job1", status: "running" });
let status = await req("job_status", { jobId: "job1" });
assert.equal(status.result.status, "running");
release();
await new Promise((r) => setTimeout(r, 5));
status = await req("job_status", { jobId: "job1" });
assert.equal(status.result.status, "done");
assert.equal(status.result.response.ok, true);
assert.deepEqual(status.result.response.result, { done: true });
res = await req("job_status", { jobId: "ghost" });
assert.equal(res.error.code, ERROR_CODES.JOB_NOT_FOUND);

// debugger conflict: one retry, then structured error
sent.length = 0;
sendImpl = async (_t, method) => {
  const err = new Error("该标签已被 DevTools 或其他调试器占用，请先关闭它的开发者工具。");
  err.code = "DEBUGGER_BUSY";
  throw err;
};
res = await req("screenshot", { tabId: 1 });
assert.equal(res.ok, false);
assert.equal(res.error.code, ERROR_CODES.DEBUGGER_BUSY);
assert.equal(res.error.retryable, true);
assert.ok(res.error.hint);
assert.equal(sent.filter((s) => s.method === "Page.captureScreenshot").length, 2, "exactly one retry");

// screenshot returns artifact
sendImpl = async () => ({ data: "QUJD" });
res = await req("screenshot", { tabId: 1 });
assert.equal(res.ok, true);
assert.equal(res.artifacts[0].mime, "image/jpeg");
assert.equal(res.artifacts[0].encoding, "base64");
assert.equal(res.artifacts[0].data, "QUJD");

// read_rendered_html puts HTML in artifacts
injectImpl = async () => ({ ok: true, html: "<div>hi</div>", stats: { chars: 2, tables: 0, imgs: 0 } });
res = await req("read_rendered_html", { tabId: 1, selector: "#out" });
assert.equal(res.result.stats.chars, 2);
assert.equal(res.artifacts[0].data, "<div>hi</div>");
injectImpl = async () => ({ ok: false, error: "没有元素：#out" });
res = await req("read_rendered_html", { tabId: 1, selector: "#out" });
assert.equal(res.error.code, ERROR_CODES.TOOL_FAILED);

// set_input_value verifies read-back
injectImpl = async () => ({ ok: true, value: "abc", matches: false, length: 3 });
res = await req("set_input_value", { tabId: 2, selector: "#title", value: "abcdef" });
assert.equal(res.error.code, ERROR_CODES.VERIFY_FAILED);

// exclusive tools are serialised
const order = [];
env.clipboard.write = async () => {
  order.push("start");
  await new Promise((r) => setTimeout(r, 15));
  order.push("end");
  return { via: "mock" };
};
await Promise.all([req("clipboard_write", { text: "a" }), req("clipboard_write", { text: "b" })]);
assert.deepEqual(order, ["start", "end", "start", "end"], "clipboard writers never interleave");
res = await req("clipboard_write", {});
assert.equal(res.error.code, ERROR_CODES.BAD_ARGS);
env.clipboard.write = async () => {
  const err = new Error("all failed");
  err.attempts = [{ via: "native", ok: false }];
  throw err;
};
res = await req("clipboard_write", { html: "<b>x</b>" });
assert.equal(res.error.code, ERROR_CODES.CLIPBOARD_FAILED);
assert.equal(res.error.retryable, true);

// audit log has no args content
res = await req("audit_log");
assert.ok(res.result.entries.length > 5);
assert.ok(res.result.entries.every((e) => !("args" in e)));
assert.ok(res.result.entries.some((e) => e.code === ERROR_CODES.ORIGIN_NOT_ALLOWED));

// switch off mid-session blocks immediately
settings = { ...settings, agentBridgeEnabled: false };
res = await req("list_tabs");
assert.equal(res.error.code, ERROR_CODES.DISABLED);

console.log("bridge protocol tests passed");

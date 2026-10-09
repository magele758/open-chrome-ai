import assert from "node:assert/strict";
import { createBridge } from "../lib/bridge/index.js";
import { ERROR_CODES } from "../lib/bridge/protocol.js";
import { isSensitiveUploadPath } from "../lib/bridge/tools-browser.js";
import { normalizeSettings } from "../lib/storage.js";

const TABS = new Map([
  [1, { id: 1, windowId: 10, active: true, title: "Local", url: "http://localhost:8080/" }],
  [2, { id: 2, windowId: 10, active: false, title: "Bank", url: "https://bank.example/" }],
  [3, { id: 3, windowId: 20, active: true, title: "Local 2", url: "http://localhost:3000/a" }],
]);
const WINDOWS = new Map([
  [10, { id: 10, focused: true, state: "normal", type: "normal" }],
  [20, { id: 20, focused: false, state: "normal", type: "normal" }],
]);
const withTabs = (w) => ({ ...w, tabs: [...TABS.values()].filter((t) => t.windowId === w.id) });

let stored = normalizeSettings({ agentBridgeEnabled: true, agentBridgeOrigins: ["http://localhost:*"] });
const calls = [];
const log = (...a) => calls.push(a);
let injectImpl = async () => null;
let framesImpl = async () => [];
let sendImpl = async () => ({});
let dialog = null;
const dialogWaiters = new Set();
let downloadsRows = [];

const env = {
  getSettings: async () => stored,
  saveSettings: async (next) => {
    stored = normalizeSettings(next);
    log("save", stored);
    return stored;
  },
  tabs: {
    get: async (id) => {
      if (!TABS.has(id)) throw new Error(`No tab with id: ${id}`);
      return TABS.get(id);
    },
    query: async () => [...TABS.values()],
    create: async (props) => ({ id: 500, ...props }),
    update: async (id, props) => (log("tabs.update", id, props), { id, pendingUrl: props.url }),
    reload: async (id) => log("tabs.reload", id),
    goBack: async (id) => log("tabs.goBack", id),
    goForward: async (id) => log("tabs.goForward", id),
    remove: async (id) => log("tabs.remove", id),
  },
  windows: {
    getAll: async () => [...WINDOWS.values()].map(withTabs),
    get: async (id) => {
      if (!WINDOWS.has(id)) throw new Error(`No window with id: ${id}`);
      return withTabs(WINDOWS.get(id));
    },
    create: async (props) => (log("windows.create", props), { id: 30, tabs: [{ id: 31, windowId: 30, url: props.url }] }),
    update: async (id, props) => log("windows.update", id, props),
    remove: async (id) => log("windows.remove", id),
  },
  downloads: {
    download: async (opts) => (log("downloads.download", opts), 7),
    search: async (q) => (q.id ? [{ id: 7, state: "complete", filename: "/home/u/Downloads/a.pdf", fileSize: 3, url: "http://localhost:8080/a.pdf" }] : downloadsRows),
  },
  inject: (...a) => injectImpl(...a),
  injectFrames: (...a) => framesImpl(...a),
  runJs: async () => ({ ok: true }),
  cdp: {
    send: async (tabId, method, params) => {
      log("cdp", tabId, method, params);
      return sendImpl(tabId, method, params);
    },
    ensure: async () => ({}),
    pendingDialog: () => dialog,
    watchDialog: () => {
      let w;
      const promise = new Promise((resolve) => {
        w = resolve;
        if (dialog) resolve(dialog);
        else dialogWaiters.add(w);
      });
      return { promise, cancel: () => dialogWaiters.delete(w) };
    },
  },
  clipboard: { write: async () => ({ via: "mock" }) },
  platform: () => "mac",
  sleep: async () => {},
  now: () => Date.now(),
  extensionVersion: () => "test",
};

// agent/cdp-tools.js locates elements through chrome.scripting directly.
globalThis.chrome = {
  tabs: { get: env.tabs.get },
  scripting: {
    executeScript: async ({ target, func, args }) => [{ frameId: 0, result: await injectImpl(target.tabId, func, args, { frameId: target.frameIds?.[0] }) }],
  },
};

const bridge = createBridge(env);
let n = 0;
const req = (tool, args = {}, extra = {}) => bridge.call({ id: `b${++n}`, tool, args, ...extra });
const find = (name) => calls.find((c) => c[0] === name);
const reset = () => (calls.length = 0);

// ---- every new tool is advertised with its scope ----
const scopes = Object.fromEntries(bridge.tools.map((t) => [t.name, t.scope]));
const EXPECTED = {
  navigate_tab: "tabs:manage", reload_tab: "tabs:manage", go_back: "tabs:manage", go_forward: "tabs:manage",
  close_tab: "tabs:manage", list_windows: "tabs:read", create_window: "tabs:manage", focus_window: "tabs:manage",
  close_window: "tabs:manage", snapshot_controls: "page:read", extract_page: "page:read", find_in_page: "page:read",
  get_links: "page:read", act_element: "page:act", select_option: "page:act", scroll_page: "page:act",
  drag_drop: "page:act", handle_dialog: "page:act", download_file: "downloads", list_downloads: "downloads",
  upload_file: "upload", get_settings: "settings:read", update_settings: "settings:write",
};
for (const [name, scope] of Object.entries(EXPECTED)) assert.equal(scopes[name], scope, `${name} scope`);
const hello = await bridge.hello();
for (const name of Object.keys(EXPECTED)) assert.ok(hello.tools.some((t) => t.name === name), `${name} advertised`);

// ---- tabs ----
let res = await req("navigate_tab", { tabId: 1, url: "http://localhost:8080/next" });
assert.equal(res.ok, true);
assert.deepEqual(find("tabs.update").slice(1), [1, { url: "http://localhost:8080/next" }]);
reset();
res = await req("navigate_tab", { tabId: 1, url: "https://evil.example/?leak=1" });
assert.equal(res.error.code, ERROR_CODES.ORIGIN_NOT_ALLOWED, "target URL must be allow-listed");
assert.ok(!find("tabs.update"));
res = await req("navigate_tab", { tabId: 2, url: "http://localhost:8080/" });
assert.equal(res.error.code, ERROR_CODES.ORIGIN_NOT_ALLOWED, "source tab must be allow-listed");
res = await req("navigate_tab", { tabId: 1, url: "javascript:alert(1)" });
assert.equal(res.error.code, ERROR_CODES.ORIGIN_NOT_ALLOWED);

for (const [tool, method] of [["reload_tab", "tabs.reload"], ["go_back", "tabs.goBack"], ["go_forward", "tabs.goForward"], ["close_tab", "tabs.remove"]]) {
  reset();
  res = await req(tool, { tabId: 1 });
  assert.equal(res.ok, true, tool);
  assert.deepEqual(find(method).slice(1), [1]);
  res = await req(tool, { tabId: 2 });
  assert.equal(res.error.code, ERROR_CODES.ORIGIN_NOT_ALLOWED, `${tool} denied outside allow-list`);
}

res = await req("list_windows");
assert.deepEqual(res.result.map((w) => [w.id, w.tabs.map((t) => t.id), w.hiddenTabs]), [[10, [1], 1], [20, [3], 0]]);
assert.ok(!JSON.stringify(res.result).includes("bank.example"), "non-allowed tabs stay invisible");

reset();
res = await req("create_window", { url: "http://localhost:8080/w" });
assert.equal(res.result.windowId, 30);
assert.deepEqual(find("windows.create")[1], { url: "http://localhost:8080/w", focused: false });
res = await req("create_window", { url: "https://bank.example/" });
assert.equal(res.error.code, ERROR_CODES.ORIGIN_NOT_ALLOWED);

reset();
res = await req("focus_window", { windowId: 10 });
assert.equal(res.ok, true);
assert.deepEqual(find("windows.update").slice(1), [10, { focused: true }]);
res = await req("focus_window", { windowId: 99 });
assert.equal(res.error.code, ERROR_CODES.TAB_NOT_FOUND);

reset();
res = await req("close_window", { windowId: 10 });
assert.equal(res.error.code, ERROR_CODES.ORIGIN_NOT_ALLOWED, "window with a non-allowed tab cannot be closed");
assert.deepEqual(res.error.details.origins, ["https://bank.example"]);
assert.ok(!find("windows.remove"));
res = await req("close_window", { windowId: 20 });
assert.equal(res.ok, true);
assert.deepEqual(find("windows.remove").slice(1), [20]);

// ---- snapshot + ref resolution ----
const snapItems = [
  { node: 11, role: "button", label: "登录", kind: "click", rect: { x: 1, y: 1, w: 10, h: 10 } },
  { node: 12, role: "textbox", label: "用户名", kind: "fill", value: "", rect: { x: 1, y: 20, w: 10, h: 10 } },
  { node: 13, role: "combobox", label: "城市", kind: "select", value: "北京", options: [{ value: "bj", label: "北京" }], rect: { x: 1, y: 40, w: 10, h: 10 } },
];
framesImpl = async (tabId, func, args) => {
  assert.equal(func.name, "snapshotControls");
  assert.deepEqual(args, [{ limit: 50, textLimit: undefined }]);
  return [
    { frameId: 0, result: { url: "http://localhost:8080/", title: "Local", w: 800, h: 600, scroll: { y: 0, height: 900 }, text: "hello", items: snapItems.slice(0, 2), omitted: 0 } },
    { frameId: 5, result: { w: 300, h: 200, text: "", items: snapItems.slice(2), omitted: 0 } },
  ];
};

res = await req("act_element", { tabId: 1, ref: 1, action: "click" });
assert.equal(res.error.code, ERROR_CODES.BAD_ARGS, "ref before snapshot is rejected");
assert.match(res.error.message, /snapshot_controls/);

res = await req("snapshot_controls", { tabId: 1, limit: 50, format: "text" });
assert.equal(res.ok, true);
assert.deepEqual(res.result.items.map((i) => [i.ref, i.label]), [[1, "登录"], [2, "用户名"], [3, "城市"]]);
assert.ok(res.result.items.every((i) => !("node" in i)), "internal node ids are not leaked");
assert.equal(res.result.items[2].frameId, 5);
assert.match(res.result.table, /\[1\] button\s+登录/);

const injected = [];
injectImpl = async (tabId, func, args, opts) => {
  injected.push({ tabId, func: func.name, args, opts });
  if (func.name === "actOnRef") return { ok: true, action: args[0] };
  if (func.name === "scrollViewport") return { ok: true, action: `scroll_${args[0]}` };
  if (func.name === "scrollContainerOf") return { ok: true };
  return null;
};
res = await req("act_element", { tabId: 1, ref: 2, action: "fill", value: "alice", submit: true });
assert.equal(res.ok, true);
assert.deepEqual(injected.at(-1), { tabId: 1, func: "actOnRef", args: ["fill", { node: 12, label: "用户名", value: "alice", submit: true }], opts: { frameId: 0 } });
res = await req("act_element", { tabId: 1, ref: 3, action: "select", value: "bj" });
assert.equal(injected.at(-1).opts.frameId, 5, "iframe refs run in their frame");
res = await req("act_element", { tabId: 1, ref: 1, action: "fill", value: "x" });
assert.equal(res.error.code, ERROR_CODES.BAD_ARGS, "fill on a button is rejected");
res = await req("act_element", { tabId: 1, ref: 9, action: "click" });
assert.equal(res.error.code, ERROR_CODES.BAD_ARGS);
res = await req("act_element", { tabId: 1, action: "scroll_down" });
assert.equal(injected.at(-1).func, "scrollViewport");
res = await req("act_element", { tabId: 3, ref: 1, action: "click" });
assert.equal(res.error.code, ERROR_CODES.BAD_ARGS, "refs are per tab");

// stale ref → structured failure and snapshot dropped
injectImpl = async () => ({ ok: false, stale: true, error: "目标元素已不在页面上，请重新 snapshot_controls 后再操作" });
res = await req("act_element", { tabId: 1, ref: 1, action: "click" });
assert.equal(res.error.code, ERROR_CODES.TOOL_FAILED);
assert.equal(res.error.details.stale, true);
assert.ok(res.error.hint);
res = await req("act_element", { tabId: 1, ref: 1, action: "click" });
assert.match(res.error.message, /snapshot_controls/, "stale snapshot is discarded");

// trusted_click resolves index through the same snapshot refs
await req("snapshot_controls", { tabId: 1, limit: 50 });
injectImpl = async (tabId, func, args, opts) => {
  injected.push({ func: func.name, args, opts });
  if (func.name === "locateElement") return { ok: true, x: 40, y: 50, tag: "button", text: "登录" };
  return null;
};
reset();
res = await req("trusted_click", { tabId: 1, index: 1 });
assert.equal(res.ok, true, JSON.stringify(res.error));
assert.deepEqual(injected.at(-1).args, [{ node: 11 }]);
assert.ok(calls.some((c) => c[0] === "cdp" && c[2] === "Input.dispatchMouseEvent" && c[3].x === 40));

// drag_drop by refs (trusted)
reset();
res = await req("drag_drop", { tabId: 1, from: { index: 1 }, to: { x: 200, y: 300 } });
assert.equal(res.ok, true, JSON.stringify(res.error));
assert.ok(calls.some((c) => c[2] === "Input.setInterceptDrags" && c[3].enabled === true));
assert.ok(calls.some((c) => c[2] === "Input.dispatchMouseEvent" && c[3].type === "mouseReleased" && c[3].x === 200));

// ---- page read tools ----
injectImpl = async (tabId, func, args) => {
  if (func.name === "extractPage") return { title: "Doc", url: "http://localhost:8080/", text: "x".repeat(1200), kind: "generic" };
  if (func.name === "findInPage") return { query: args[0], count: 1, hits: [{ snippet: "foo bar" }] };
  if (func.name === "getLinks") return [{ text: "a", href: "http://localhost:8080/a" }];
  return null;
};
res = await req("extract_page", { tabId: 1, maxChars: 1000 });
assert.equal(res.result.text.length, 1000);
assert.equal(res.result.truncated, true);
res = await req("extract_page", { tabId: 1, format: "markdown" });
assert.equal(res.artifacts[0].name, "page.md");
assert.match(res.artifacts[0].data, /^# Doc\n/);
res = await req("extract_page", { tabId: 2 });
assert.equal(res.error.code, ERROR_CODES.ORIGIN_NOT_ALLOWED);
res = await req("find_in_page", { tabId: 1, query: "foo" });
assert.equal(res.result.count, 1);
res = await req("get_links", { tabId: 1 });
assert.equal(res.result.links[0].href, "http://localhost:8080/a");
res = await req("get_links", { tabId: 2 });
assert.equal(res.error.code, ERROR_CODES.ORIGIN_NOT_ALLOWED);

// ---- select_option / scroll_page ----
injectImpl = async (tabId, func, args, opts) => {
  injected.push({ func: func.name, args, opts });
  if (func.name === "pageAct") return opts?.frameId ? { ok: true, frame: opts.frameId } : { ok: false, notFound: true, error: "没有匹配元素" };
  if (func.name === "scrollPage") return { ok: true, via: "percent" };
  if (func.name === "scrollViewport") return { ok: true };
  return null;
};
framesImpl = async () => [{ frameId: 0, result: { ok: false } }, { frameId: 4, result: { ok: true } }];
res = await req("select_option", { tabId: 1, selector: "#city", value: "bj" });
assert.equal(res.ok, true);
assert.equal(res.result.frameId, 4, "falls back to the iframe that has the control");
assert.deepEqual(injected.at(-1).args, ["select", { selector: "#city", value: "bj", nth: undefined }]);
framesImpl = async () => [];
res = await req("select_option", { tabId: 1, selector: "#nope", value: "x" });
assert.equal(res.error.code, ERROR_CODES.TOOL_FAILED);
res = await req("scroll_page", { tabId: 1, percent: 50 });
assert.equal(injected.at(-1).func, "scrollPage");
res = await req("scroll_page", { tabId: 1, direction: "up" });
assert.deepEqual([injected.at(-1).func, injected.at(-1).args], ["scrollViewport", ["up"]]);

// ---- dialogs ----
let resolveAct;
injectImpl = async (tabId, func) => (func.name === "actOnRef" ? new Promise((r) => (resolveAct = r)) : null);
framesImpl = async () => [{ frameId: 0, result: { url: "http://localhost:8080/", title: "L", items: snapItems.slice(0, 1), text: "" } }];
await req("snapshot_controls", { tabId: 1 });
const pendingAct = req("act_element", { tabId: 1, ref: 1, action: "click" });
await new Promise((r) => setTimeout(r, 5));
dialog = { type: "confirm", message: "确定删除？" };
for (const w of [...dialogWaiters]) w(dialog);
res = await pendingAct;
assert.equal(res.ok, true, "a dialog does not hang the call");
assert.equal(res.result.dialog.type, "confirm");
assert.match(res.result.hint, /handle_dialog/);
resolveAct?.({ ok: true });

reset();
res = await req("handle_dialog", { tabId: 1, accept: false });
assert.deepEqual(res.result, { handled: "confirm", message: "确定删除？", accepted: false });
assert.deepEqual(find("cdp").slice(2), ["Page.handleJavaScriptDialog", { accept: false }]);
dialog = null;
sendImpl = async (_t, method) => {
  if (method === "Page.handleJavaScriptDialog") throw new Error("No dialog is showing");
  return {};
};
res = await req("handle_dialog", { tabId: 1 });
assert.equal(res.error.code, ERROR_CODES.TOOL_FAILED);
assert.match(res.error.message, /没有待处理/);
sendImpl = async () => ({});
res = await req("handle_dialog", { tabId: 2 });
assert.equal(res.error.code, ERROR_CODES.ORIGIN_NOT_ALLOWED);

// ---- downloads ----
reset();
res = await req("download_file", { url: "http://localhost:8080/a.pdf", filename: "../x/a.pdf" });
assert.equal(res.ok, true, JSON.stringify(res.error));
assert.equal(res.result.filename, "/home/u/Downloads/a.pdf");
assert.equal(find("downloads.download")[1].filename, "x/a.pdf", "filename sanitised");
reset();
res = await req("download_file", { url: "https://evil.example/payload.exe" });
assert.equal(res.error.code, ERROR_CODES.ORIGIN_NOT_ALLOWED);
assert.ok(!find("downloads.download"), "no download for a denied origin");
downloadsRows = [
  { id: 1, state: "complete", filename: "/d/a", url: "http://localhost:8080/a" },
  { id: 2, state: "complete", filename: "/d/b", url: "https://bank.example/statement.pdf" },
];
res = await req("list_downloads", {});
assert.deepEqual(res.result.downloads.map((d) => d.id), [1], "downloads from non-allowed origins hidden");

// ---- upload ----
for (const p of [
  "/home/u/.ssh/id_rsa", "~/.aws/credentials", "/Users/u/.gnupg/pubring.kbx", "/srv/app/.env", "/srv/app/.env.local",
  "/tmp/server.pem", "C:\\Users\\u\\keys\\prod.key", "/home/u/id_ed25519", "/tmp/../home/u/notes.txt",
  "/Users/u/Library/Application Support/Google/Chrome/Default/Login Data", "/home/u/.config/gcloud/x.json",
]) {
  assert.ok(isSensitiveUploadPath(p), `sensitive: ${p}`);
}
for (const p of ["/home/u/Downloads/a.pdf", "/tmp/photo.png", "C:\\Users\\u\\Pictures\\cat.jpg", "/home/u/keynote.txt"]) {
  assert.ok(!isSensitiveUploadPath(p), `allowed: ${p}`);
}
reset();
res = await req("upload_file", { tabId: 1, selector: "input[type=file]", paths: ["/tmp/a.png", "/home/u/.ssh/id_rsa"] });
assert.equal(res.error.code, ERROR_CODES.PATH_NOT_ALLOWED);
assert.deepEqual(res.error.details.paths, ["/home/u/.ssh/id_rsa"]);
assert.ok(!calls.some((c) => c[2] === "DOM.setFileInputFiles"), "nothing handed to the page");
sendImpl = async (_t, method) => {
  if (method === "Runtime.evaluate") return { result: { objectId: "obj1" } };
  if (method === "Runtime.callFunctionOn") return { result: { value: true } };
  return {};
};
res = await req("upload_file", { tabId: 1, selector: "input[type=file]", paths: ["/home/u/Downloads/a.pdf"] });
assert.equal(res.ok, true, JSON.stringify(res.error));
assert.deepEqual(find("cdp") && calls.find((c) => c[2] === "DOM.setFileInputFiles")[3], { files: ["/home/u/Downloads/a.pdf"], objectId: "obj1" });
sendImpl = async () => ({});
res = await req("upload_file", { tabId: 2, selector: "input", paths: ["/tmp/a.png"] });
assert.equal(res.error.code, ERROR_CODES.ORIGIN_NOT_ALLOWED);

// ---- settings ----
stored = normalizeSettings({ ...stored, jev: { ...stored.jev, apiKey: "sk-supersecretvalue1234" } });
res = await req("get_settings");
assert.equal(res.ok, true);
const keys = res.result.settings.map((s) => s.key);
assert.ok(keys.includes("uiTheme"));
for (const k of ["jev.apiKey", "agentBridgeOrigins", "agentBridgeEnabled", "hitlMode", "nativeShell", "cdpInput", "jev.baseUrl"]) {
  assert.ok(!keys.includes(k), `${k} hidden`);
  assert.ok(res.result.protected.includes(k), `${k} listed as protected`);
}
assert.ok(!JSON.stringify(res.result).includes("1234"), "no part of a secret leaks");

reset();
res = await req("update_settings", { changes: [{ key: "uiFont", value: "lg" }] });
assert.equal(res.ok, true, JSON.stringify(res.error));
assert.deepEqual(res.result.changed.map((c) => c.key), ["uiFont"]);
assert.equal(stored.uiFont, "lg");
assert.equal(stored.agentBridgeEnabled, true, "other settings preserved");

for (const key of ["agentBridgeOrigins", "agentBridgeEnabled", "hitlMode", "nativeShell", "cdpInput", "jev.apiKey", "asr.baseUrl", "agentInboxEnabled", "agentTokens"]) {
  reset();
  res = await req("update_settings", { changes: [{ key: "uiFont", value: "xl" }, { key, value: "x" }] });
  assert.equal(res.error.code, ERROR_CODES.SETTING_PROTECTED, `${key} protected`);
  assert.deepEqual(res.error.details.keys, [key]);
  assert.ok(!find("save"), "no partial save");
}
assert.equal(stored.uiFont, "lg");
res = await req("update_settings", { changes: [{ key: "uiFont", value: "huge" }] });
assert.equal(res.error.code, ERROR_CODES.BAD_ARGS);
res = await req("update_settings", { changes: [{ key: "notASetting", value: 1 }] });
assert.equal(res.error.code, ERROR_CODES.BAD_ARGS);

console.log("bridge browser tools tests passed");

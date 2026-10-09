import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { chromeCall, runJsInTab } from "../lib/chrome.js";
import { runJs } from "../lib/agent/page-fns.js";
import { acquireCookiesApi } from "../lib/agent/cookie-tools.js";
import {
  ensureOptionalAccess,
  ensureToolPermissions,
  installPermissionPromptListener,
  isAllowedPermissionQuery,
  mountPermissionPrompt,
  originPatternFromUrl,
  resetPermissionPrompter,
  setPermissionPrompter,
} from "../lib/optional-permissions.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(readFileSync(resolve(root, "extension/manifest.json"), "utf8"));

const PREVIOUS_API = [
  "activeTab",
  "sidePanel",
  "storage",
  "scripting",
  "userScripts",
  "debugger",
  "downloads",
  "sessions",
  "search",
  "pageCapture",
  "tabs",
  "tabGroups",
  "contextMenus",
  "bookmarks",
  "history",
  "notifications",
  "clipboardWrite",
  "clipboardRead",
  "unlimitedStorage",
  "tabCapture",
  "offscreen",
  "nativeMessaging",
  "tts",
  "alarms",
  "webNavigation",
  "favicon",
];
const PREVIOUS_HOSTS = ["<all_urls>", "http://*/*", "https://*/*", "file://*/*"];
const INSTALL_API = [
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
];
const OPTIONAL_API = [
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
];

const declaredApi = new Set([...(manifest.permissions || []), ...(manifest.optional_permissions || [])]);
const declaredHosts = new Set([...(manifest.host_permissions || []), ...(manifest.optional_host_permissions || [])]);

for (const name of PREVIOUS_API) {
  assert.equal(declaredApi.has(name), true, `upgrade keeps ${name}`);
}
for (const pattern of PREVIOUS_HOSTS) {
  assert.equal(declaredHosts.has(pattern), true, `upgrade keeps host ${pattern}`);
}
assert.deepEqual([...manifest.permissions].sort(), [...INSTALL_API].sort());
assert.deepEqual([...(manifest.optional_permissions || [])].sort(), [...OPTIONAL_API].sort());
assert.deepEqual([...(manifest.host_permissions || [])].sort(), []);
assert.deepEqual([...(manifest.optional_host_permissions || [])].sort(), [...PREVIOUS_HOSTS].sort());
assert.equal(manifest.permissions.includes("cookies"), false, "cookies is requested on first use");
assert.equal(manifest.permissions.includes("debugger"), true, "Chrome cannot make debugger optional");
assert.equal(manifest.permissions.includes("tts"), true, "Chrome cannot make tts optional");
assert.equal((manifest.optional_permissions || []).includes("debugger"), false);
assert.equal((manifest.optional_permissions || []).includes("tts"), false);

assert.equal(originPatternFromUrl("https://example.com/a?q=1"), "https://example.com/*");
assert.equal(originPatternFromUrl("https://example.com:8443/a"), "https://example.com:8443/*");
assert.equal(originPatternFromUrl("http://news.example/path"), "http://news.example/*");
assert.equal(originPatternFromUrl("file:///tmp/a.pdf"), "file://*/*");
assert.equal(originPatternFromUrl("chrome://extensions"), null);

function fakeApi(contains) {
  const requests = [];
  return {
    requests,
    async contains(query) {
      return contains(query);
    },
    async request(query) {
      requests.push(query);
      return true;
    },
  };
}

{
  const api = fakeApi(() => true);
  const prompts = [];
  const result = await ensureOptionalAccess({
    permission: "history",
    permissionsApi: api,
    prompt: async (info) => {
      prompts.push(info);
      return true;
    },
  });
  assert.equal(result.granted, true);
  assert.equal(result.already, true);
  assert.equal(prompts.length, 0, "already granted installs are not prompted");
  assert.equal(api.requests.length, 0);
}

{
  const api = fakeApi(() => false);
  let requestedBeforeConfirm = null;
  const result = await ensureOptionalAccess({
    permission: "history",
    permissionsApi: api,
    prompt: async (info) => {
      requestedBeforeConfirm = api.requests.length;
      assert.match(info.reason, /浏览历史/);
      assert.equal(info.permission, "history");
      assert.deepEqual(info.query, { permissions: ["history"] });
      return true;
    },
  });
  assert.equal(requestedBeforeConfirm, 0, "request waits for the user to confirm");
  assert.equal(result.granted, true);
  assert.deepEqual(api.requests, [{ permissions: ["history"] }]);
}

{
  const api = fakeApi(() => false);
  const result = await ensureOptionalAccess({
    permission: "nativeMessaging",
    permissionsApi: api,
    prompt: async (info) => {
      assert.match(info.reason, /本机助手/);
      return false;
    },
  });
  assert.equal(result.granted, false);
  assert.equal(api.requests.length, 0, "declining does not call request");
  assert.match(result.message, /本机助手/);
}

{
  const api = fakeApi(() => false);
  const seen = [];
  await ensureOptionalAccess({
    permission: "history",
    permissionsApi: api,
    prompt: async (info) => {
      seen.push(info.permission);
      return true;
    },
  });
  await ensureOptionalAccess({
    permission: "userScripts",
    permissionsApi: api,
    prompt: async (info) => {
      seen.push(info.permission);
      assert.match(info.reason, /用户脚本/);
      return true;
    },
  });
  assert.deepEqual(seen, ["history", "userScripts"]);
  assert.deepEqual(api.requests, [{ permissions: ["history"] }, { permissions: ["userScripts"] }]);
}

{
  const api = fakeApi(() => false);
  const result = await ensureOptionalAccess({
    url: "https://news.example/story",
    permissionsApi: api,
    prompt: async (info) => {
      assert.match(info.reason, /news\.example/);
      assert.deepEqual(info.query, { origins: ["https://news.example/*"] });
      assert.equal(JSON.stringify(info.query).includes("<all_urls>"), false);
      return false;
    },
  });
  assert.equal(result.granted, false);
  assert.equal(api.requests.length, 0);
}

{
  const api = {
    async contains() {
      return false;
    },
    async request() {
      throw new Error("Cannot request file access");
    },
  };
  const result = await ensureOptionalAccess({
    url: "file:///tmp/a.pdf",
    permissionsApi: api,
    prompt: async () => true,
  });
  assert.equal(result.granted, false);
  assert.match(result.message, /允许访问文件网址/);
}

{
  const api = fakeApi(() => false);
  let containsCalls = 0;
  api.contains = async () => {
    containsCalls += 1;
    return false;
  };
  const result = await ensureOptionalAccess({
    permission: "debugger",
    permissionsApi: api,
    prompt: async () => true,
  });
  assert.equal(result.granted, true);
  assert.equal(result.required, true);
  assert.equal(containsCalls, 0);
  assert.equal(api.requests.length, 0, "debugger stays install-time");
}

{
  const api = fakeApi(() => false);
  const result = await ensureOptionalAccess({
    permission: "management",
    permissionsApi: api,
    prompt: async () => true,
  });
  assert.equal(result.granted, false);
  assert.equal(api.requests.length, 0);
  assert.match(result.message, /management/);
}

{
  const jar = { getAll: async () => [] };
  const denyApi = fakeApi(() => false);
  const denied = await acquireCookiesApi({ cookies: jar }, { permissionsApi: denyApi, prompt: async () => false });
  assert.match(denied.error, /cookie/);
  assert.equal(denyApi.requests.length, 0, "declined cookie prompt does not request");
  resetPermissionPrompter();

  const api = fakeApi(() => false);
  const prompts = [];
  const got = await acquireCookiesApi({ cookies: jar }, { permissionsApi: api, prompt: async (info) => (prompts.push(info), true) });
  assert.equal(got.cookies, jar);
  assert.deepEqual(api.requests, [{ permissions: ["cookies"] }], "cookie tools request cookies on first use");
  assert.match(prompts[0].reason, /cookie/);
}

{
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const api = fakeApi(() => false);
  const prompt = async () => {
    calls += 1;
    await gate;
    return true;
  };
  const first = ensureOptionalAccess({ permission: "downloads", permissionsApi: api, prompt });
  const second = ensureOptionalAccess({ permission: "downloads", permissionsApi: api, prompt });
  await Promise.resolve();
  assert.equal(calls, 1, "one feature shares one prompt");
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.granted, true);
  assert.equal(b.granted, true);
  assert.equal(api.requests.length, 1);
}

{
  const order = [];
  const denied = await ensureToolPermissions(["pageCapture", "downloads"], {
    permissionsApi: fakeApi(() => false),
    prompt: async (info) => {
      order.push(`prompt:${info.permission}`);
      return info.permission === "pageCapture";
    },
  });
  assert.match(denied, /下载/);
  assert.deepEqual(order, ["prompt:pageCapture", "prompt:downloads"]);
}

{
  assert.equal(isAllowedPermissionQuery({ permissions: ["history"] }), true);
  assert.equal(isAllowedPermissionQuery({ origins: ["https://example.com/*"] }), true);
  assert.equal(isAllowedPermissionQuery({ permissions: ["history", "bookmarks"] }), false);
  assert.equal(isAllowedPermissionQuery({ origins: ["<all_urls>"] }), false);
  assert.equal(isAllowedPermissionQuery({ permissions: ["cookies"] }), true);
  assert.equal(isAllowedPermissionQuery({ permissions: ["management"] }), false);
  assert.equal(isAllowedPermissionQuery({ permissions: ["debugger"] }), false);
}

{
  const dom = new JSDOM("<!doctype html><body></body>");
  const requests = [];
  const pending = mountPermissionPrompt(dom.window.document, {
    title: "需要授权",
    reason: "需要读取浏览历史，才能按你的要求搜索曾经打开过的页面。",
    query: { permissions: ["history"] },
    request: (query) => {
      requests.push(query);
      return Promise.resolve(true);
    },
  });
  assert.equal(requests.length, 0);
  assert.match(dom.window.document.body.textContent, /浏览历史/);
  dom.window.document.querySelector("[data-pl-permission-grant]").click();
  assert.equal(await pending, true);
  assert.deepEqual(requests, [{ permissions: ["history"] }]);

  const cancelled = [];
  const deny = mountPermissionPrompt(dom.window.document, {
    title: "需要授权",
    reason: "需要管理下载，才能把文件保存到本机。",
    query: { permissions: ["downloads"] },
    request: (query) => {
      cancelled.push(query);
      return Promise.resolve(true);
    },
  });
  dom.window.document.querySelector("[data-pl-permission-deny]").click();
  assert.equal(await deny, false);
  assert.equal(cancelled.length, 0);
}

{
  const dom = new JSDOM("<!doctype html><body></body>");
  const requests = [];
  const chromeRef = {
    runtime: {
      id: "ext",
      listeners: [],
      onMessage: {
        addListener(fn) {
          this.listeners.push(fn);
        },
      },
    },
    permissions: {
      request(query) {
        requests.push(query);
        return Promise.resolve(true);
      },
    },
  };
  chromeRef.runtime.onMessage.addListener = function add(fn) {
    chromeRef.runtime.listeners.push(fn);
  };
  installPermissionPromptListener(chromeRef, dom.window.document);
  let responded = null;
  const sendResponse = (value) => {
    responded = value;
  };
  const handled = chromeRef.runtime.listeners[0](
    {
      type: "pl.permission.prompt",
      reason: "需要读取浏览历史，才能按你的要求搜索曾经打开过的页面。",
      title: "需要授权",
      query: { permissions: ["history"] },
    },
    { id: "ext" },
    sendResponse,
  );
  assert.equal(handled, true);
  assert.equal(requests.length, 0);
  dom.window.document.querySelector("[data-pl-permission-grant]").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(requests, [{ permissions: ["history"] }]);
  assert.deepEqual(responded, { granted: true });

  const blocked = [];
  chromeRef.permissions.request = (query) => {
    blocked.push(query);
    return Promise.resolve(true);
  };
  let blockedResponse = null;
  chromeRef.runtime.listeners[0](
    { type: "pl.permission.prompt", query: { permissions: ["management"] }, reason: "no" },
    { id: "ext" },
    (value) => {
      blockedResponse = value;
    },
  );
  assert.deepEqual(blockedResponse, { granted: false });
  assert.equal(blocked.length, 0);
}

{
  resetPermissionPrompter();
  const prompts = [];
  const requests = [];
  let userScriptsGranted = false;
  globalThis.chrome = {
    permissions: {
      async contains(query) {
        if (query.permissions?.includes("tabs")) return true;
        if (query.origins?.length) return true;
        if (query.permissions?.includes("userScripts")) return userScriptsGranted;
        return false;
      },
      async request(query) {
        requests.push(query);
        if (query.permissions?.includes("userScripts")) {
          userScriptsGranted = true;
          globalThis.chrome.userScripts = {
            async execute() {
              return [{ result: { ok: true, result: 7, via: "userScripts" } }];
            },
          };
          return true;
        }
        return false;
      },
    },
    tabs: {
      async get() {
        return { id: 3, url: "https://example.com/x" };
      },
    },
    scripting: {
      async executeScript() {
        return [{ result: { ok: false, cspBlocked: true, error: "csp" } }];
      },
    },
  };
  setPermissionPrompter(async (info) => {
    prompts.push(info.permission);
    return info.permission === "userScripts";
  });
  const result = await runJsInTab(3, runJs, "return 1");
  assert.deepEqual(prompts, ["userScripts"]);
  assert.deepEqual(requests, [{ permissions: ["userScripts"] }]);
  assert.equal(result.ok, true);
  assert.equal(result.result, 7);
  resetPermissionPrompter();
}

{
  resetPermissionPrompter();
  const requests = [];
  globalThis.chrome = {
    permissions: {
      async contains() {
        return false;
      },
      async request(query) {
        requests.push(query);
        return true;
      },
    },
    history: {
      async search() {
        return [];
      },
    },
  };
  setPermissionPrompter(async (info) => {
    assert.equal(info.permission, "history");
    assert.match(info.reason, /浏览历史/);
    return false;
  });
  const denied = await chromeCall("history.search", [{ text: "pagelens" }]);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /浏览历史/);
  assert.equal(requests.length, 0);

  setPermissionPrompter(async () => true);
  globalThis.chrome.permissions.contains = async () => true;
  const allowed = await chromeCall("history.search", [{ text: "pagelens", maxResults: 99 }]);
  assert.equal(allowed.ok, true);
  assert.equal(requests.length, 0, "granted history is not requested again");
  resetPermissionPrompter();
}

console.log("PASS optional permissions");

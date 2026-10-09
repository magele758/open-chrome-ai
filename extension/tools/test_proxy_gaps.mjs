import assert from "node:assert/strict";
import { createTokenRecord, SCOPE_PRESETS } from "../lib/bridge/auth.js";
import { createBridge } from "../lib/bridge/index.js";
import { waitForDownload } from "../lib/agent/browser-api-tools.js";
import { resolveClickElementText } from "../lib/agent/click-label.js";
import { createCookieTools } from "../lib/agent/cookie-tools.js";
import { buildEgressPolicy } from "../lib/agent/egress.js";
import { createAgentTools, checkHitlRequirement, resolveActiveTools } from "../lib/agent/tools.js";

const SRC = "https://docs.example.com/article";

// ---- selector clicks: visible text feeds the irreversible check ----
{
  let injected = false;
  const fromIndex = await resolveClickElementText({
    toolName: "trusted_click",
    args: { index: 4, selector: "#publish" },
    tabId: 1,
    refLabel: () => "发表",
    inject: async () => {
      injected = true;
      return { ok: true, text: "别的" };
    },
  });
  assert.equal(fromIndex, "发表");
  assert.equal(injected, false, "snapshot label wins; no DOM read");

  const fromFrame = await resolveClickElementText({
    toolName: "click",
    args: { selector: "#del" },
    tabId: 2,
    inject: async () => ({ ok: false, notFound: true }),
    injectFrames: async () => [
      { frameId: 0, result: { ok: false, notFound: true } },
      { frameId: 7, result: { ok: true, text: "删除" } },
    ],
  });
  assert.equal(fromFrame, "删除");

  const publish = await resolveClickElementText({
    toolName: "trusted_click",
    args: { selector: "#publish" },
    tabId: 1,
    inject: async () => ({ ok: true, text: "发表" }),
  });
  const hit = checkHitlRequirement({
    toolName: "trusted_click",
    args: { selector: "#publish" },
    elementText: publish,
    hitlMode: "autonomous",
    targetUrl: SRC,
    userUrl: SRC,
  });
  assert.equal(hit.decision, "confirm");
  assert.equal(hit.irreversible.id, "publish_send");
  const missed = checkHitlRequirement({
    toolName: "trusted_click",
    args: { selector: "#publish" },
    hitlMode: "autonomous",
    targetUrl: SRC,
    userUrl: SRC,
  });
  assert.equal(missed.decision, "allow", "without the resolved label the publish click is missed");
  assert.equal(
    checkHitlRequirement({
      toolName: "trusted_click",
      args: { selector: "#save" },
      elementText: "保存草稿",
      hitlMode: "autonomous",
      targetUrl: SRC,
      userUrl: SRC,
    }).decision,
    "allow",
  );
}

// ---- download redirects: block the final URL, not only the first one ----
{
  const calls = [];
  const downloads = {
    cancel: async (id) => calls.push(["cancel", id]),
    removeFile: async (id) => calls.push(["removeFile", id]),
    erase: async (query) => calls.push(["erase", query]),
    search: async () => [{ id: 9, state: "complete", url: "https://docs.example.com/a.pdf", finalUrl: "https://evil.com/a.pdf?d=1", filename: "/tmp/a.pdf", fileSize: 4 }],
  };
  const blocked = await waitForDownload(downloads, 9, {
    allowFinalUrl: (url) => buildEgressPolicy({ sourceUrl: SRC }).isAllowed(url),
    requestedUrl: "https://docs.example.com/a.pdf",
    pollMs: 1,
    timeoutMs: 20,
  });
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.error, "EGRESS_NOT_ALLOWED");
  assert.deepEqual(calls.map((c) => c[0]), ["cancel", "removeFile", "erase"]);

  const sameHost = await waitForDownload(
    { search: async () => [{ id: 1, state: "complete", url: "https://docs.example.com/a.pdf", finalUrl: "https://docs.example.com/b.pdf", filename: "/tmp/b.pdf" }] },
    1,
    { allowFinalUrl: (url) => buildEgressPolicy({ sourceUrl: SRC }).isAllowed(url), requestedUrl: "https://docs.example.com/a.pdf", pollMs: 1, timeoutMs: 20 },
  );
  assert.equal(sameHost.state, "complete");
  assert.equal(sameHost.filename, "/tmp/b.pdf");
}

{
  globalThis.chrome = {
    downloads: {
      last: null,
      download: async (opts) => {
        globalThis.chrome.downloads.last = opts;
        return 4;
      },
      search: async () => [{ id: 4, state: "complete", filename: "/home/u/Downloads/a.pdf", url: "https://docs.example.com/a.pdf", finalUrl: "https://evil.com/stolen.pdf", fileSize: 3 }],
      cancel: async () => {},
      removeFile: async () => {},
      erase: async () => {},
    },
  };
  const byName = Object.fromEntries(
    createAgentTools({
      getEgressPolicy: () => buildEgressPolicy({ sourceUrl: SRC }),
    }).map((tool) => [tool.name, tool]),
  );
  const text = await byName.download_file.execute({ url: "https://docs.example.com/a.pdf" });
  const res = JSON.parse(text);
  assert.equal(res.error, "EGRESS_NOT_ALLOWED");
  assert.match(res.reason, /evil\.com/);
  const names = resolveActiveTools({
    userText: "读取 cookie",
    tools: [{ name: "extract_page" }, { name: "get_cookies" }, { name: "set_cookie" }, { name: "request_toolsets" }],
  }).map((tool) => tool.name);
  assert.ok(names.includes("get_cookies"));
}

// ---- cookie tools: permission call site, egress, scope ----
{
  assert.ok(SCOPE_PRESETS.full.includes("cookies"));
  assert.ok(!SCOPE_PRESETS.operate.includes("cookies"));
  assert.ok(!SCOPE_PRESETS["read-only"].includes("cookies"));

  const jar = [];
  const api = {
    cookies: {
      getAll: async ({ url, name }) => jar.filter((c) => c.url === url && (!name || c.name === name)),
      set: async (details) => {
        const cookie = { ...details, domain: new URL(details.url).hostname, path: details.path || "/" };
        jar.push(cookie);
        return cookie;
      },
      remove: async ({ url, name }) => {
        const idx = jar.findIndex((c) => c.url === url && c.name === name);
        if (idx >= 0) jar.splice(idx, 1);
        return { url, name };
      },
    },
  };
  const tools = Object.fromEntries(createCookieTools({}, { api }).map((tool) => [tool.name, tool]));
  assert.match(await tools.get_cookies.execute({ url: "javascript:alert(1)" }), /http/);
  const set = JSON.parse(await tools.set_cookie.execute({ url: SRC, name: "sid", value: "abc", httpOnly: true }));
  assert.equal(set.cookie.httpOnly, true);
  assert.equal(set.cookie.value, "abc");
  const got = JSON.parse(await tools.get_cookies.execute({ url: SRC, name: "sid" }));
  assert.equal(got.cookies[0].value, "abc");
  assert.equal(JSON.parse(await tools.remove_cookie.execute({ url: SRC, name: "sid" })).ok, true);
  assert.equal(JSON.parse(await tools.get_cookies.execute({ url: SRC })).count, 0);
  assert.match(await createCookieTools({}, { api: {} })[0].execute({ url: SRC }), /acquireCookiesApi/);

  const foreign = checkHitlRequirement({
    toolName: "get_cookies",
    args: { url: "https://evil.com/" },
    hitlMode: "autonomous",
    attended: false,
    userUrl: SRC,
  });
  assert.equal(foreign.code, "EGRESS_NOT_ALLOWED");
  const local = checkHitlRequirement({
    toolName: "set_cookie",
    args: { url: SRC, name: "a", value: "b" },
    hitlMode: "autonomous",
    userUrl: SRC,
    targetUrl: SRC,
  });
  assert.equal(local.decision, "allow");
  assert.equal(
    checkHitlRequirement({ toolName: "remove_cookie", args: { url: SRC, name: "a" }, hitlMode: "autonomous", userUrl: SRC }).decision,
    "confirm",
  );
}

// ---- bridge: selector publish is queued; redirect and cookies follow the token ----
{
  const clicks = [];
  const cookieCalls = [];
  const jar = [];
  let downloadItem = null;
  const downloadOps = [];
  const TABS = new Map([[1, { id: 1, url: "https://a.com/edit", title: "edit" }]]);
  const plain = await createTokenRecord({
    name: "cursor",
    scopes: ["page:act", "downloads", "cookies"],
    origins: ["https://a.com"],
    egress: ["https://cdn.ok.io"],
  });
  const noCookies = await createTokenRecord({ name: "reader", scopes: ["downloads"], origins: ["https://a.com"] });
  const bridge = createBridge({
    getSettings: async () => ({ agentBridgeEnabled: true, agentBridgeOrigins: ["https://a.com"], irreversibleActions: {} }),
    getAgentTokens: async () => [plain.record, noCookies.record],
    tabs: { get: async (id) => TABS.get(id) || Promise.reject(new Error("missing")) },
    downloads: {
      download: async (opts) => {
        downloadOps.push(["download", opts.url]);
        return 8;
      },
      search: async (q) => (q.id ? [downloadItem] : []),
      cancel: async (id) => downloadOps.push(["cancel", id]),
      removeFile: async (id) => downloadOps.push(["removeFile", id]),
      erase: async (query) => downloadOps.push(["erase", query.id]),
    },
    cookies: {
      getAll: async (q) => (cookieCalls.push(["getAll", q.url]), jar.filter((c) => !q.name || c.name === q.name)),
      set: async (d) => (cookieCalls.push(["set", d.url]), jar.push(d), d),
      remove: async (d) => (cookieCalls.push(["remove", d.url]), d),
    },
    inject: async (_tabId, _func, args) => ({ ok: true, text: args?.[0]?.selector === "#publish" ? "发表" : "保存草稿" }),
    injectFrames: async () => [],
    cdp: { ensure: async () => {}, send: async (_tab, method) => (clicks.push(method), {}) },
    platform: () => "other",
    sleep: async () => {},
    now: () => 1_000,
    extensionVersion: () => "test",
  });
  const as = (tok) => ({ session: { token: tok.token, sessionId: "s", agentName: "mcp" } });

  const queued = await bridge.call({ id: "p1", tool: "trusted_click", args: { tabId: 1, selector: "#publish" } }, as(plain));
  assert.equal(queued.error.code, "CONFIRMATION_REQUIRED");
  assert.equal(queued.error.details.item.id, "publish_send");
  assert.deepEqual(clicks, [], "publish click does not reach the page");

  downloadItem = { id: 8, state: "complete", filename: "/d/a.pdf", url: "https://a.com/a.pdf", finalUrl: "https://cdn.ok.io/a.pdf", fileSize: 2 };
  const cdn = await bridge.call({ id: "d1", tool: "download_file", args: { url: "https://a.com/a.pdf" } }, as(plain));
  assert.equal(cdn.ok, true, JSON.stringify(cdn.error));
  assert.equal(cdn.result.filename, "/d/a.pdf");

  downloadOps.length = 0;
  downloadItem = { id: 8, state: "in_progress", filename: "", url: "https://a.com/a.pdf", finalUrl: "https://evil.io/a.pdf?x=1" };
  const leaked = await bridge.call({ id: "d2", tool: "download_file", args: { url: "https://a.com/a.pdf" } }, as(plain));
  assert.equal(leaked.error.code, "EGRESS_NOT_ALLOWED");
  assert.equal(leaked.error.details.channel, "download");
  assert.ok(downloadOps.some((op) => op[0] === "cancel"));

  const denied = await bridge.call({ id: "c0", tool: "get_cookies", args: { url: "https://a.com/" } }, as(noCookies));
  assert.equal(denied.error.code, "SCOPE_DENIED");
  assert.equal(denied.error.details.scope, "cookies");
  assert.deepEqual(cookieCalls, []);

  const evilCookie = await bridge.call({ id: "c1", tool: "set_cookie", args: { url: "https://evil.io/", name: "a", value: "b" } }, as(plain));
  assert.equal(evilCookie.error.code, "EGRESS_NOT_ALLOWED");
  assert.equal(evilCookie.error.details.channel, "cookie");
  assert.deepEqual(cookieCalls, []);

  const set = await bridge.call({ id: "c2", tool: "set_cookie", args: { url: "https://a.com/", name: "sid", value: "xyz" } }, as(plain));
  assert.equal(set.ok, true, JSON.stringify(set.error));
  assert.equal(set.result.cookie.value, "xyz");
  const got = await bridge.call({ id: "c3", tool: "get_cookies", args: { url: "https://a.com/", name: "sid" } }, as(plain));
  assert.equal(got.result.cookies[0].value, "xyz");

  const remove = await bridge.call({ id: "c4", tool: "remove_cookie", args: { url: "https://a.com/", name: "sid" } }, as(plain));
  assert.equal(remove.error.code, "CONFIRMATION_REQUIRED");
  assert.equal(remove.error.details.item.id, "delete");
  assert.ok(!cookieCalls.some((c) => c[0] === "remove"));
}

console.log("test_proxy_gaps ok");

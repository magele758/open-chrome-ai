import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentTools } from "../lib/agent/tools.js";
import { loadTabPack } from "../lib/page-pack.js";
import { resetPermissionPrompter } from "../lib/optional-permissions.js";

const statusUrl = "https://x.test/account/status/123";
const chromeDenied = () => new Error(
  "Cannot access contents of the page. Extension manifest must request permission to access the respective host.",
);

function setup(executeScript, options = {}) {
  const tab = { id: 7, windowId: 12, url: statusUrl, title: "Title from Chrome", status: "complete", ...options };
  resetPermissionPrompter();
  globalThis.chrome = {
    tabs: { get: async (id) => { assert.equal(id, 7); return { ...tab }; } },
    permissions: {
      contains: async () => true,
      request: async () => assert.fail("declared host permissions should not prompt again"),
    },
    scripting: {
      async executeScript(spec) {
        assert.deepEqual(spec.target, { tabId: 7 });
        return executeScript(spec, tab);
      },
    },
  };
  const tools = Object.fromEntries(createAgentTools({
    getTabId: () => 7,
    getWindowId: () => 12,
    refreshPack: loadTabPack,
  }).map((tool) => [tool.name, tool]));
  return {
    info: async () => JSON.parse(await tools.get_page_info.execute({})),
    extract: () => tools.extract_page.execute({}),
    tab,
  };
}

test("metadata-only extraction and get_page_info report a Chrome denial even with declared host access", async () => {
  let calls = 0;
  let documentAvailable = false;
  const { extract, info } = setup(({ func }, tab) => {
    calls += 1;
    if (!documentAvailable) throw chromeDenied();
    return [{ result: {
      url: tab.url,
      title: "Title from document",
      ...(func.name === "extractPage" ? { text: "正文已加载" } : { headings: [{ tag: "h1", text: "文章" }], links: 3 }),
    } }];
  });

  assert.match(await extract(), /只取得标签页标题和网址，未能读取页面正文/);
  const fallback = await info();
  assert.equal(calls, 2, "a settled, blocked tab should not be injected repeatedly");
  assert.equal(fallback.source, "tab_metadata");
  assert.equal(fallback.domAvailable, false);
  assert.equal(fallback.reason, "chrome_blocked_document");
  assert.equal(fallback.url, statusUrl);
  assert.equal(fallback.title, "Title from Chrome");
  assert.ok(!Object.hasOwn(fallback, "links"), "unknown counts must remain unknown");

  documentAvailable = true;
  assert.match(await extract(), /正文已加载/);
  const page = await info();
  assert.equal(page.domAvailable, true);
  assert.equal(page.source, "document");
  assert.equal(page.title, "Title from document");
  assert.deepEqual(page.headings, [{ tag: "h1", text: "文章" }]);
  assert.equal(page.links, 3);
});

test("an ordinary still-loading document retries once and returns page info without waiting for complete", async () => {
  let attempts = 0;
  const { info } = setup((spec, tab) => {
    assert.equal(spec.injectImmediately, true);
    if (++attempts === 1) throw chromeDenied();
    return [{ result: { url: tab.url, title: "Article", readyState: "interactive" } }];
  }, { status: "loading" });
  const page = await info();
  assert.equal(attempts, 2);
  assert.equal(page.domAvailable, true);
  assert.equal(page.readyState, "interactive");
});

test("a Chrome network error document falls back without waiting for a new navigation", async () => {
  const { info } = setup(() => { throw new Error("Frame with ID 0 is showing error page"); });
  const page = await info();
  assert.equal(page.source, "tab_metadata");
  assert.equal(page.domAvailable, false);
  assert.equal(page.reason, "chrome_blocked_document");
  assert.equal(page.url, statusUrl);
});

test("withheld site access remains a Chrome permission decision", async () => {
  const { info } = setup(() => assert.fail("withheld access must block page injection"));
  const requests = [];
  chrome.permissions.contains = async (query) => Boolean(query.permissions);
  chrome.permissions.addHostAccessRequest = async (request) => { requests.push(request); };
  const page = await info();
  assert.equal(page.domAvailable, false);
  assert.equal(page.reason, "site_access_required");
  assert.match(page.note, /Chrome 工具栏/);
  assert.deepEqual(requests, [{ tabId: 7, pattern: "https://x.test/*" }]);
});

test("a cross-origin navigation during injection does not return the old DOM or retry on another site", async () => {
  const redirectedUrl = "https://other.test/article";
  let attempts = 0;
  const { info } = setup((_spec, tab) => {
    attempts += 1;
    tab.url = redirectedUrl;
    tab.title = "Redirected";
    return [{ result: { url: statusUrl, title: "Old DOM" } }];
  }, { status: "loading" });
  const page = await info();
  assert.equal(attempts, 1);
  assert.equal(page.domAvailable, false);
  assert.equal(page.source, "unavailable");
  assert.equal(page.reason, "document_changed");
  assert.ok(!Object.hasOwn(page, "url"));
  assert.ok(!Object.hasOwn(page, "title"));
});

test("a tab moved to another window during injection is rejected", async () => {
  const { info } = setup((_spec, tab) => {
    tab.windowId = 13;
    throw chromeDenied();
  });
  await assert.rejects(info(), { code: "WINDOW_SCOPE" });
});

test("Chrome Web Store URLs stay restricted, while an ordinary page mentioning the URL is readable", async () => {
  let attempts = 0;
  const { info, tab } = setup((_spec, tab) => {
    attempts += 1;
    return [{ result: { url: tab.url, title: "Article" } }];
  }, { url: "https://docs.test/page?link=https://chromewebstore.google.com/detail/example" });
  assert.equal((await info()).domAvailable, true);
  tab.url = "https://newtab/articles";
  assert.equal((await info()).domAvailable, true);
  for (const url of ["https://chromewebstore.google.com/detail/example", "https://chrome.google.com/webstore", "chrome://settings/"]) {
    tab.url = url;
    await assert.rejects(info(), /受限页/);
  }
  assert.equal(attempts, 2);
});

test("an unexpected script error is reported as a failure", async () => {
  const { info } = setup(() => { throw new Error("unexpected getPageInfo error"); });
  await assert.rejects(info(), /unexpected getPageInfo error/);
});

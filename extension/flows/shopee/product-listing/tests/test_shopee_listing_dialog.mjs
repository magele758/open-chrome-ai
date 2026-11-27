import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { mountProductListingDialog } from "../sidepanel/dialog.js";
import { bindPtcFlow } from "../sidepanel/flow-ui.js";
import { resetPermissionPrompter } from "../../../../lib/optional-permissions.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const shopUrl = "https://seller.shopee.cn/portal/mtsku/new?cnsc_shop_id=1901697826";
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test("product view requires consent for an explicit size chart even without uploaded images", async () => {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const { document } = window;
  const originalDocument = globalThis.document;
  const originalChrome = globalThis.chrome;
  const activatedListeners = [];
  let accessRequests = 0;
  let tab = { id: 12, windowId: 1, url: shopUrl };

  globalThis.document = document;
  globalThis.chrome = {
    permissions: {
      contains() { accessRequests++; return Promise.resolve(false); },
      request() { accessRequests++; return Promise.resolve(false); },
    },
    tabs: {
      onActivated: { addListener(listener) { activatedListeners.push(listener); } },
      onUpdated: { addListener() {} },
    },
    runtime: { getURL: path => "chrome-extension://test/" + path, onMessage: { addListener() {} } },
  };
  try {
    const open = bindPtcFlow({
      getTargetTab: async () => tab,
      chooseDirectory: async () => ({ root: "/Products", directoryName: "Products",
        products: [{ title: "Shirt", folder: "shirt", input: { sizeChart: {} } }], issues: [] }),
    });
    const byId = id => document.getElementById(id);
    const dialog = byId("ptc-flow-dialog");
    dialog.showModal ??= () => { dialog.open = true; };
    assert.equal(mountProductListingDialog(), dialog);
    assert.equal(document.querySelectorAll('link[rel="stylesheet"]').length, 1);
    assert.equal(open(), true);
    await nextTurn();
    assert.equal(byId("ptc-input"), null);
    assert.equal(byId("ptc-directory-path"), null);
    assert.equal(byId("ptc-batch-start").textContent, "创建商品");
    assert.equal(byId("ptc-batch-publish").textContent, "创建并上架");
    assert.equal(byId("ptc-batch-start").disabled, true);
    assert.equal(byId("ptc-batch-publish").disabled, true);
    byId("ptc-load-directory").click();
    await nextTurn();
    assert.equal(byId("ptc-batch-consent-row").hidden, false);
    assert.match(byId("ptc-batch-consent-text").textContent, /模型估算/u);
    assert.match(byId("ptc-batch-consent-text").textContent, /创建尺码表/u);
    assert.equal(byId("ptc-batch-start").disabled, true);
    assert.equal(byId("ptc-batch-ai-consent").checked, false);

    byId("ptc-batch-form").dispatchEvent(new window.Event("submit", { cancelable: true }));
    assert.equal(accessRequests, 0);

    const consent = byId("ptc-batch-upload-consent");
    consent.checked = true;
    consent.dispatchEvent(new window.Event("change"));
    assert.equal(byId("ptc-batch-start").disabled, false);
    assert.equal(byId("ptc-batch-publish").disabled, false);
    byId("ptc-batch-ai-consent").checked = true;
    tab = { ...tab, url: shopUrl.replace("1901697826", "1234") };
    activatedListeners[0]();
    await nextTurn();
    assert.equal(consent.checked, false);
    assert.equal(byId("ptc-batch-ai-consent").checked, false);
  } finally {
    globalThis.document = originalDocument;
    globalThis.chrome = originalChrome;
    window.close();
  }
});

test("starts the selected write mode with a bounded concurrency and shows verified receipt IDs", async () => {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const { document } = window;
  const originalDocument = globalThis.document;
  const originalChrome = globalThis.chrome;
  const tab = { id: 12, windowId: 1, url: shopUrl };
  const starts = [];
  globalThis.document = document;
  globalThis.chrome = {
    permissions: { contains: async () => true },
    tabs: {
      query: async () => [tab],
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    runtime: { getURL: path => "chrome-extension://test/" + path, onMessage: { addListener() {} } },
  };
  try {
    const open = bindPtcFlow({
      getTargetTab: async () => tab,
      chooseDirectory: async () => ({
        root: "/Products", directoryName: "Products",
        products: [{ title: "Shirt", folder: "shirt", input: {} }], issues: [],
      }),
      startBatch: async ({ mode, concurrency, onJob }) => {
        starts.push({ mode, concurrency });
        const status = mode === "create" ? "created" : "published";
        onJob(0, { phase: status, tabId: null, receipt: { status, globalItemId: "654321" } });
      },
    });
    const byId = id => document.getElementById(id);
    const dialog = byId("ptc-flow-dialog");
    dialog.showModal ??= () => { dialog.open = true; };
    open();
    await nextTurn();
    const concurrency = byId("ptc-batch-concurrency");
    const create = byId("ptc-batch-start");
    const publish = byId("ptc-batch-publish");
    assert.equal(concurrency.valueAsNumber, 5);
    byId("ptc-load-directory").click();
    await nextTurn();
    concurrency.value = "11";
    concurrency.dispatchEvent(new window.Event("input"));
    assert.equal(create.disabled, true);
    assert.equal(publish.disabled, true);
    publish.click();
    assert.deepEqual(starts, []);
    concurrency.value = "5";
    concurrency.dispatchEvent(new window.Event("input"));
    create.click();
    await nextTurn();
    assert.deepEqual(starts, [{ mode: "create", concurrency: 5 }]);
    assert.match(byId("ptc-batch-status").textContent, /已创建 1\/1/u);
    assert.match(byId("ptc-batch-jobs").textContent, /全球商品 ID 654321/u);
    assert.equal(byId("ptc-batch-jobs").querySelector("button").hidden, true);

    concurrency.value = "10";
    concurrency.dispatchEvent(new window.Event("input"));
    publish.click();
    await nextTurn();
    assert.deepEqual(starts, [{ mode: "create", concurrency: 5 }, { mode: "publish", concurrency: 10 }]);
    assert.match(byId("ptc-batch-status").textContent, /已提交上架 1\/1/u);
  } finally {
    globalThis.document = originalDocument;
    globalThis.chrome = originalChrome;
    window.close();
  }
});

test("the receipt opens the retained form from the same shop", async () => {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const { document } = window;
  const originalDocument = globalThis.document;
  const originalChrome = globalThis.chrome;
  const sourceTab = { id: 12, windowId: 1, url: shopUrl };
  const retainedTab = { ...sourceTab, id: 41 };
  const updates = [];
  globalThis.document = document;
  globalThis.chrome = {
    permissions: { contains: async () => true },
    tabs: {
      query: async () => [sourceTab],
      get: async id => id === retainedTab.id ? retainedTab : sourceTab,
      update: async (...args) => updates.push(args),
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    runtime: { getURL: path => "chrome-extension://test/" + path, onMessage: { addListener() {} } },
  };
  try {
    const open = bindPtcFlow({
      getTargetTab: async () => sourceTab,
      chooseDirectory: async () => ({
        root: "/Products", directoryName: "Products",
        products: [{ title: "Shirt", folder: "shirt", input: {} }], issues: [],
      }),
      startBatch: async ({ onJob }) => {
        onJob(0, { phase: "submission-unknown", tabId: retainedTab.id,
          receipt: { status: "submission-unknown", details: { text: "2个错误需调整", issues: [
            { key: "品牌", label: "品牌", kind: "missing", message: "请输入商品品牌名称" },
            { key: "shipDays", label: "发货时间", kind: "invalid", message: "Your days to ship is now out of range" },
          ] } } });
      },
    });
    const byId = id => document.getElementById(id);
    const dialog = byId("ptc-flow-dialog");
    dialog.showModal ??= () => { dialog.open = true; };
    open();
    await nextTurn();
    byId("ptc-load-directory").click();
    await nextTurn();
    byId("ptc-batch-start").click();
    await nextTurn();

    assert.match(byId("ptc-batch-status").textContent, /待处理 1 · 保留 1 个标签/u);
    assert.match(byId("ptc-batch-jobs").textContent, /品牌 · 请输入商品品牌名称/u);
    assert.match(byId("ptc-batch-jobs").textContent, /发货时间 · Your days to ship is now out of range/u);
    const inspect = byId("ptc-batch-jobs").querySelector("button");
    assert.equal(inspect.textContent, "查看表单");
    assert.equal(inspect.hidden, false);
    inspect.click();
    await nextTurn();
    assert.deepEqual(updates, [[41, { active: true }]]);

    retainedTab.url = shopUrl.replace("1901697826", "1234");
    inspect.click();
    await nextTurn();
    assert.deepEqual(updates, [[41, { active: true }]]);
    assert.match(byId("ptc-batch-status").textContent, /已离开本次任务的 Shopee 店铺/u);
  } finally {
    globalThis.document = originalDocument;
    globalThis.chrome = originalChrome;
    window.close();
  }
});

test("starts from a Shopee product list, acknowledges the click, and clears loading on failure", async () => {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const { document } = window;
  const originalDocument = globalThis.document;
  const originalChrome = globalThis.chrome;
  const activate = [];
  const sourceTab = { id: 13, windowId: 1, url: shopUrl.replace("/portal/mtsku/new", "/portal/product/mtsku/list") };
  const starts = [];
  const permission = Promise.withResolvers();
  const batch = Promise.withResolvers();
  let requests = 0;
  let tab = { ...sourceTab, url: sourceTab.url.replace("seller.shopee.cn", "example.com") };
  resetPermissionPrompter();
  globalThis.document = document;
  globalThis.chrome = {
    permissions: { contains: async () => false, request: () => { requests++; return permission.promise; } },
    tabs: {
      get: async () => tab,
      query: async () => [tab],
      onActivated: { addListener(listener) { activate.push(listener); } },
      onUpdated: { addListener() {} },
    },
    runtime: { getURL: path => "chrome-extension://test/" + path, onMessage: { addListener() {} } },
  };
  try {
    const open = bindPtcFlow({
      getTargetTab: async () => tab,
      chooseDirectory: async () => ({
        root: "/Products", directoryName: "Products",
        products: Array.from({ length: 30 }, (_, index) => ({ title: `Product ${index}`, folder: `product-${index}`,
          input: { imagePath: `/Products/product-${index}/cover.jpg` } })), issues: [],
      }),
      startBatch: ({ sourceTab: anchor, shopId, mode, concurrency, products, onJob }) => {
        starts.push({ anchor, shopId, mode, concurrency, count: products.length });
        onJob(0, { phase: "opening" });
        return batch.promise;
      },
    });
    const byId = id => document.getElementById(id);
    const dialog = byId("ptc-flow-dialog");
    dialog.showModal ??= () => { dialog.open = true; };
    open();
    await nextTurn();
    byId("ptc-load-directory").click();
    await nextTurn();
    const create = byId("ptc-batch-start");
    const publish = byId("ptc-batch-publish");
    const consent = byId("ptc-batch-upload-consent");
    const concurrency = byId("ptc-batch-concurrency");
    assert.match(byId("ptc-batch-status").textContent, /已读入 30 个商品/u);

    for (const url of [tab.url, sourceTab.url.split("?")[0], sourceTab.url + "&cnsc_shop_id=42"]) {
      tab = { ...sourceTab, url };
      activate[0]();
      await nextTurn();
      consent.checked = true;
      consent.dispatchEvent(new window.Event("change"));
      assert.equal(create.disabled, true, url);
      assert.equal(publish.disabled, true, url);
      create.click();
    }
    assert.equal(requests, 0);

    tab = sourceTab;
    activate[0]();
    await nextTurn();
    consent.checked = true;
    consent.dispatchEvent(new window.Event("change"));
    concurrency.value = "10";
    concurrency.dispatchEvent(new window.Event("input"));
    assert.equal(create.disabled, false);
    create.click();
    assert.equal(create.getAttribute("aria-busy"), "true");
    assert.match(create.textContent, /启动中/u);
    assert.equal(create.disabled, true);
    assert.equal(publish.disabled, true);
    create.click();
    assert.equal(requests, 1);
    assert.deepEqual(starts, []);

    permission.resolve(true);
    await nextTurn();
    assert.deepEqual(starts, [{ anchor: sourceTab, shopId: "1901697826", mode: "create", concurrency: 10, count: 30 }]);
    assert.equal(create.getAttribute("aria-busy"), "true");
    assert.match(create.textContent, /创建中/u);
    assert.equal(publish.disabled, true);

    batch.reject(new Error("模拟启动失败"));
    await nextTurn();
    assert.notEqual(create.getAttribute("aria-busy"), "true");
    assert.equal(create.textContent.trim(), "创建商品");
    assert.match(byId("ptc-batch-status").textContent, /模拟启动失败/u);
  } finally {
    resetPermissionPrompter();
    globalThis.document = originalDocument;
    globalThis.chrome = originalChrome;
    window.close();
  }
});

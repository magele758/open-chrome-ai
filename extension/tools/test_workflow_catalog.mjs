import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { bindShopeeMarketingPanel } from "../flows/shopee/marketing-panel.js";
import { shortcutsForPage } from "../flows/workflow-context.js";
import { bindWorkflowCatalog } from "../sidepanel/workflow-catalog.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom");

const html = await readFile(new URL("../sidepanel/index.html", import.meta.url), "utf8");
const storageKey = "pagelens.workflowPlatformId";

function mountCatalog(t) {
  const { window } = new JSDOM(html, { url: "https://fixture.invalid/" });
  const { document } = window;
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  const oldChrome = globalThis.chrome;
  t.after(() => {
    globalThis.document = oldDocument;
    globalThis.window = oldWindow;
    globalThis.chrome = oldChrome;
    window.close();
  });
  globalThis.document = document;
  globalThis.window = window;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  return { window, document, byId: id => document.getElementById(id) };
}

const selected = document => [...document.querySelectorAll("#workflow-platform button[aria-pressed=true]")].map(button => button.dataset.platform);

test("selects a platform and opens the requested workflow without running it", async t => {
  const { window, document, byId } = mountCatalog(t);
  const shopId = 42;
  const origin = "https://seller.shopee.cn";
  const tab = { id: 7, url: origin + "/portal/marketing?cnsc_shop_id=" + shopId };
  const listener = { addListener() {} };
  globalThis.chrome = {
    tabs: { query: async () => [tab], onActivated: listener, onUpdated: listener },
    runtime: { onMessage: listener },
  };
  let openCatalog;
  const onBack = () => openCatalog();
  const openMarketing = bindShopeeMarketingPanel({ getTargetTab: async () => tab, onBack });
  let selectedSkill;
  let listingOpened = false;
  let sheinListingOpened = false;
  let capturePlatform;
  let openLibrary = false;
  let temuFlow;
  const openProductListing = () => { listingOpened = true; return true; };
  const openSheinListing = (feature, platform) => {
    assert.equal(feature.id, "shein-product-listing");
    assert.equal(platform, "shein");
    sheinListingOpened = true;
    return true;
  };
  const openTiktokDraft = feature => { selectedSkill = feature; return true; };
  const openProductCapture = (feature, platform) => {
    assert.equal(feature.id, "product-capture");
    capturePlatform = platform;
    return true;
  };
  const openProductLibrary = () => { openLibrary = true; };
  openCatalog = bindWorkflowCatalog({
    openProductListing, openSheinListing, openMarketing, openTiktokDraft, openProductCapture, openProductLibrary,
    openTemuListing: feature => (temuFlow = feature.id, true),
    openTemuOperations: ({ mode }) => (temuFlow = mode, true),
  });

  const picker = byId("workflow-platform");
  const choosePlatform = id => picker.querySelector(`button[data-platform="${id}"]`).click();
  const choices = () => [...document.querySelectorAll("#workflow-feature-list button")];
  const launch = async id => {
    document.querySelector(`#workflow-feature-list button[data-workflow="${id}"]`).click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(byId("workflow-catalog-dialog").open, false);
  };
  byId("btn-ptc-flow").click();
  assert.equal(byId("workflow-catalog-dialog").open, true);
  assert.deepEqual([...picker.querySelectorAll("button")].map(button => button.dataset.platform), [
    "shopee", "temu", "shein", "amazon", "tiktok-shop", "zhfulfill",
  ]);
  assert.deepEqual(selected(document), ["shopee"]);
  choosePlatform("temu");
  assert.deepEqual(selected(document), ["temu"]);
  assert.deepEqual(choices().map(item => item.dataset.workflow), [
    "temu-product-listing", "temu-product-data", "temu-campaign-data", "temu-campaign-draft",
    "temu-marketing-data", "temu-order-data", "temu-finance-data", "product-capture",
  ]);
  assert.equal(byId("workflow-feature-empty").hidden, true);
  assert.equal(window.localStorage.getItem(storageKey), "temu");
  byId("workflow-catalog-close").click();
  byId("btn-ptc-flow").click();
  assert.deepEqual(selected(document), ["temu"]);
  for (const id of ["temu-product-listing", "temu-campaign-draft", "temu-finance-data"]) {
    await launch(id);
    assert.equal(temuFlow, id);
    openCatalog();
  }
  for (const platform of ["temu", "amazon", "zhfulfill"]) {
    choosePlatform(platform);
    assert.ok(choices().some(item => item.dataset.workflow === "product-capture"));
    await launch("product-capture");
    assert.equal(capturePlatform, platform);
    openCatalog();
  }
  byId("workflow-catalog-library").click();
  assert.equal(byId("workflow-catalog-dialog").open, false);
  assert.equal(openLibrary, true);
  openCatalog();
  choosePlatform("shein");
  assert.equal(picker.querySelector('[data-platform="shein"] img').getAttribute("src"), "../flows/icons/shein.png");
  assert.deepEqual(choices().map(item => item.dataset.workflow), ["shein-product-listing"]);
  await launch("shein-product-listing");
  assert.equal(sheinListingOpened, true);
  openCatalog();
  choosePlatform("shopee");
  assert.deepEqual(choices().map(item => item.dataset.workflow), [
    "product-listing", "campaign-data", "campaign-draft", "voucher-data", "voucher-draft",
  ]);

  await launch("product-listing");
  assert.ok(listingOpened);
  openCatalog();

  for (const [id, title, readVisible] of [
    ["campaign-data", "活动数据", true],
    ["campaign-draft", "活动表单试填", false],
    ["voucher-data", "优惠券数据", true],
    ["voucher-draft", "优惠券表单试填", false],
  ]) {
    await launch(id);
    assert.equal(byId("shopee-marketing-dialog").open, true);
    assert.equal(byId("shopee-marketing-title").textContent, title);
    assert.equal(byId("shopee-marketing-read").hidden, !readVisible);
    assert.equal(byId("shopee-marketing-inspect").hidden, readVisible);
    assert.equal(byId("shopee-marketing-report").hidden, true);
    assert.equal(byId("shopee-marketing-preview").hidden, true);
    byId("shopee-marketing-back").click();
    assert.equal(byId("workflow-catalog-dialog").open, true);
  }
  choosePlatform("tiktok-shop");
  assert.deepEqual(choices().map(item => item.dataset.workflow), ["tiktok-mx-draft"]);
  await launch("tiktok-mx-draft");
  assert.equal(selectedSkill.skillName, "TikTok 墨西哥商品草稿");
  assert.equal(byId("shopee-marketing-dialog").open, false);
});

test("shows the SHEIN listing shortcut only on the HTTPS seller site", () => {
  const context = shortcutsForPage("https://sellerhub.shein.com/#/spmp/commdities/list");
  assert.equal(context.page?.surface, "seller");
  assert.deepEqual(context.features.map(feature => feature.id), ["shein-product-listing"]);
  for (const url of ["http://sellerhub.shein.com/", "https://sellerhub.shein.com:444/", "https://sellerhub.shein.com.example.org/", "https://www.shein.com/"]) {
    assert.equal(shortcutsForPage(url).features.length, 0, url);
  }
});

test("restores a saved platform when the sidebar starts", t => {
  const { document, window, byId } = mountCatalog(t);
  window.localStorage.setItem(storageKey, "tiktok-shop");
  bindWorkflowCatalog({});
  byId("btn-ptc-flow").click();
  assert.deepEqual(selected(document), ["tiktok-shop"]);
  assert.ok(document.querySelector('[data-workflow="tiktok-mx-draft"]'));
});

test("defaults to the first platform when the saved platform was removed", t => {
  const { document, window, byId } = mountCatalog(t);
  window.localStorage.setItem(storageKey, "taobao");
  bindWorkflowCatalog({});
  byId("btn-ptc-flow").click();
  assert.deepEqual(selected(document), ["shopee"]);
  assert.ok(document.querySelector('[data-workflow="product-listing"]'));
});

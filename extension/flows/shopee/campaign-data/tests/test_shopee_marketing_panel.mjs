import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { bindShopeeMarketingPanel } from "../../marketing-panel.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const base = "https://seller.shopee.cn/portal/marketing";

test("sidepanel reads a campaign list and exports both records and source metrics", async t => {
  const url = base + "/cmt-cb/list/campaign?source=3&cnsc_shop_id=42";
  const panelHtml = await readFile(new URL("../../../../sidepanel/index.html", import.meta.url), "utf8");
  const panel = new JSDOM(panelHtml);
  const page = new JSDOM(`
    <article class="CampaignGridItemWrapper---itemWrapper--1">
      <img src="/banner.png" alt="11.25 Weekly Mega Sale">
      <div class="CampaignGridItemWrapper---exhibition--1">
        <p>平台大促</p><p>11.25 Weekly Mega Sale</p>
        <span>活动时间</span><span>2026年11月23日 01:00</span>
      </div>
    </article>`, { url, runScripts: "outside-only" });
  const { document } = panel.window;
  const byId = id => document.getElementById("shopee-marketing-" + id);
  byId("dialog").showModal = function () { this.open = true; };
  page.window.HTMLElement.prototype.getClientRects = () => [{}];
  const tab = { id: 3, windowId: 7, url, title: "Shopee 官方活动" };
  const originalChrome = globalThis.chrome;
  const originalDocument = globalThis.document;
  globalThis.document = document;
  globalThis.chrome = {
    permissions: { contains: async () => true }, tabs: { get: async () => tab },
    scripting: { executeScript: async ({ func, args }) => [{
      frameId: 0, documentId: "shop", result: page.window.eval(`(${func.toString()})`)(...args),
    }] },
  };
  t.after(() => {
    globalThis.chrome = originalChrome;
    globalThis.document = originalDocument;
    panel.window.close();
    page.window.close();
  });
  const files = new Map();
  const open = bindShopeeMarketingPanel({
    getTargetTab: async () => tab, isAgentBusy: () => false,
    downloadText: (name, data) => files.set(name.split(".").at(-1), data),
  });
  assert.equal(await open(), true);
  assert.equal(byId("inspect").disabled, true);
  byId("translate").checked = false;
  byId("all-pages").checked = false;
  byId("read").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(byId("rows").textContent, /Weekly Mega Sale/u);
  byId("json").click();
  byId("csv").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(files.get("json")).records[0].title, "11.25 Weekly Mega Sale");
  assert.match(files.get("csv"), /来源页概况/u);
  const link = document.querySelector('a[data-marketing-path*="list/discount"]');
  assert.equal(link.href, base + "/list/discount?cnsc_shop_id=42");
});

test("explicit workflows show only their own controls, find the same shop and return to the catalog", async t => {
  const panelHtml = await readFile(new URL("../../../../sidepanel/index.html", import.meta.url), "utf8");
  const panel = new JSDOM(panelHtml);
  const { document } = panel.window;
  const originalDocument = globalThis.document;
  globalThis.document = document;
  t.after(() => {
    globalThis.document = originalDocument;
    panel.window.close();
  });
  const byId = id => document.getElementById("shopee-marketing-" + id);
  const dialog = byId("dialog");
  dialog.showModal = function () { this.open = true; };
  dialog.close = function () { this.open = false; };
  let tab = { id: 1, url: "https://example.com" };
  let wentBack = false;
  const open = bindShopeeMarketingPanel({ getTargetTab: async () => tab, onBack: () => { wentBack = true; } });
  assert.equal(await open({ mode: "voucher-data", force: true }), true);
  assert.equal(byId("title").textContent, "优惠券数据");
  assert.equal(byId("read").disabled, true);
  assert.equal(byId("inspect").hidden, true);
  assert.equal(byId("links").querySelector("a:not([hidden])").href, "https://seller.shopee.cn/");

  tab = { id: 2, url: base + "?cnsc_shop_id=42" };
  assert.equal(await open({ mode: "voucher-data", force: true }), true);
  assert.equal(byId("read").disabled, true);
  assert.deepEqual([...byId("links").querySelectorAll("a[data-marketing-path]:not([hidden])")].map(link => link.href), [
    base + "/vouchers/list?cnsc_shop_id=42",
  ]);
  tab.url = base + "/vouchers/list?cnsc_shop_id=42";
  assert.equal(await open({ mode: "voucher-data", force: true }), true);
  assert.equal(byId("read").disabled, false);
  assert.match(byId("translate").closest("label").textContent, /优惠券/u);
  assert.equal(await open({ mode: "campaign-data", force: true }), true);
  assert.equal(byId("title").textContent, "活动数据");
  assert.equal(byId("read").disabled, true);
  assert.equal(byId("links").querySelector('[data-marketing-path*="/vouchers/list"]').hidden, true);

  tab.url = base + "/vouchers/new?usecase=1&cnsc_shop_id=42";
  assert.equal(await open({ mode: "voucher-draft", force: true }), true);
  assert.equal(byId("title").textContent, "优惠券表单试填");
  assert.equal(byId("inspect").disabled, false);
  assert.equal(byId("read").hidden, true);
  assert.equal(byId("translate").closest(".shopee-marketing-options").hidden, true);
  assert.equal(await open({ mode: "campaign-draft", force: true }), true);
  assert.equal(byId("inspect").disabled, true);
  assert.equal(byId("links").querySelectorAll("a[data-marketing-path]:not([hidden])").length, 3);

  const back = byId("back");
  assert.ok(back, "the catalog provides a visible way back from the work panel");
  assert.equal(back.hidden, false);
  back.click();
  assert.equal(wentBack, true);
  assert.equal(dialog.open, false);
});

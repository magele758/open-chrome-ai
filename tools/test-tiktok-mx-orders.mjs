import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { readMxOrders } from "../native/mx-ptc-orders.mjs";

const orderUrl = "https://seller.tiktokshopglobalselling.com/order?shop_region=MX";
const toShipUrl = "https://seller.tiktokshopglobalselling.com/order?order_status%5B%5D=1&selected_sort=1&tab=to_ship";
const allOrdersUrl = "https://seller.tiktokshopglobalselling.com/order?selected_sort=6&tab=all";
const options = { all: "全部订单", to_ship: "待发货", shipped: "已发货", completed: "已完成", cancelled: "已取消" };

function orderBrowser({ refreshCount = 0, refreshSummary, badRegion = false, duplicate = false, urlSelectionOnly = false, ignoredClicks = 0 } = {}) {
  const calls = [];
  const tabId = 7;
  let status = "to_ship";
  let timeOrigin = 200;
  let refreshPending = false;
  let page;
  const statusUrl = () => ({ all: allOrdersUrl, to_ship: toShipUrl })[status] ?? orderUrl + "&tab=" + status;
  function install(count, summary) {
    page?.window.close();
    const buttons = Object.entries(options).map(([key, label]) =>
      `<button role="tab" data-status="${key}" aria-selected="${!urlSelectionOnly && key === status}">${label}</button>`);
    if (duplicate) buttons.push('<button role="tab">全部</button>');
    const url = badRegion ? orderUrl.replace("MX", "GB") : statusUrl();
    page = new JSDOM(`<!doctype html><h1>管理订单</h1>
    <section role="tablist">${buttons.join("")}</section>
    ${summary ?? `<div>${count} 个订单</div>
    <div>${count ? "Receiver fixture (never expose)" : "暂无订单"}</div>`}`, { url, runScripts: "outside-only" });
    const { window } = page;
    Object.defineProperty(window.document, "readyState", { value: "complete" });
    Object.defineProperty(window.performance, "timeOrigin", { value: timeOrigin });
    Object.defineProperty(window.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
    window.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
    for (const element of window.document.querySelectorAll("[data-status]")) {
      element.addEventListener("click", () => {
        calls.push("select:" + element.dataset.status);
        if (ignoredClicks > 0) {
          ignoredClicks -= 1;
          return;
        }
        status = element.dataset.status;
        for (const button of window.document.querySelectorAll("[data-status]"))
          button.setAttribute("aria-selected", String(!urlSelectionOnly && button.dataset.status === status));
        window.history.replaceState(null, "", statusUrl());
      });
    }
  }
  async function send(tool, args) {
    calls.push(tool);
    switch (tool) {
      case "open_tab":
        assert.deepEqual(args, { url: orderUrl, active: false });
        install(4);
        return { tabId };
      case "list_tabs":
        return [{ id: 5, url: orderUrl }, { id: tabId, url: page.window.location.href }];
      case "reload_tab":
        assert.equal(args.tabId, tabId);
        refreshPending = true;
        return { tabId, done: "reload" };
      case "run_js": {
        assert.equal(args.tabId, tabId);
        const result = page.window.eval("(function() {" + args.code + "})()");
        if (refreshPending) {
          assert.equal(result, null, "the previous document must be ignored");
          refreshPending = false;
          timeOrigin += 1;
          install(refreshCount, refreshSummary);
        }
        return { ok: true, result: structuredClone(result) };
      }
      case "close_tab":
        assert.equal(args.tabId, tabId);
        page.window.close();
        return { tabId, closed: true };
      default:
        assert.fail("Unexpected order tool: " + tool);
    }
  }
  return { calls, send };
}

test("switches the exact status and counts only the fresh task document", async () => {
  const { calls, send } = orderBrowser({ refreshCount: "1,234" });
  assert.deepEqual(await readMxOrders(send), {
    verified: true, orderStatus: "all", count: 1234, supportedOptions: Object.keys(options),
  });
  assert.ok(calls.indexOf("select:all") < calls.indexOf("reload_tab"));
  assert.equal(calls.at(-1), "close_tab");
});

test("accepts the observed to_ship redirect with an explicit empty state", async () => {
  const { calls, send } = orderBrowser({ urlSelectionOnly: true });
  assert.deepEqual(await readMxOrders(send, { orderStatus: "to_ship" }), {
    verified: true, orderStatus: "to_ship", count: 0, supportedOptions: Object.keys(options),
  });
  assert.ok(!calls.some(call => call.startsWith("select:")));
  assert.equal(calls.at(-1), "close_tab");
});

test("retries the exact All selection when the first click has no effect", async () => {
  const { calls, send } = orderBrowser({ ignoredClicks: 1 });
  assert.equal((await readMxOrders(send)).orderStatus, "all");
  assert.equal(calls.filter(call => call === "select:all").length, 2);
  assert.ok(calls.lastIndexOf("select:all") < calls.indexOf("reload_tab"));
});

test("checks All using the observed seller URL with an exact visible control", async () => {
  const { send } = orderBrowser({ urlSelectionOnly: true });
  assert.equal((await readMxOrders(send)).orderStatus, "all");
});

test("accepts a fresh exact filtered zero count without the generic empty label", async () => {
  const { send } = orderBrowser({
    refreshSummary: "<div>找到\n0 个订单</div>\n<div>0 个订单</div>",
  });
  assert.equal((await readMxOrders(send, { orderStatus: "to_ship" })).count, 0);
});

test("refuses a conflicting exact filtered count and standalone count", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => (now += 4000));
  const { calls, send } = orderBrowser({
    refreshSummary: "<div>找到 0 个订单</div>\n<div>1 个订单</div>\n<div>暂无订单</div>",
  });
  await assert.rejects(readMxOrders(send, { orderStatus: "to_ship" }), /Fresh seller order status or count could not be verified/);
  assert.equal(calls.at(-1), "close_tab");
});

test("stops on ambiguous visible status controls and closes only its tab", async () => {
  const { calls, send } = orderBrowser({ duplicate: true });
  await assert.rejects(readMxOrders(send), /status controls are ambiguous/);
  assert.deepEqual(calls, ["open_tab", "list_tabs", "run_js", "close_tab"]);
});

test("refuses an explicit non-MX shop before reading the page", async () => {
  const { calls, send } = orderBrowser({ badRegion: true });
  await assert.rejects(readMxOrders(send), /unexpected page/);
  assert.deepEqual(calls, ["open_tab", "list_tabs", "close_tab"]);
});

test("rejects unsupported and inexact arguments before opening Chrome", async () => {
  const send = () => assert.fail("Order browser must stay unopened");
  await assert.rejects(readMxOrders(send, { productId: "1738630710999877196" }), /Exact product ID order filtering is unavailable/);
  await assert.rejects(readMxOrders(send, { productId: 1738630710999877196 }), /Invalid seller product ID/);
  await assert.rejects(readMxOrders(send, { orderStatus: "fulfilled" }), /Unsupported seller order status/);
  await assert.rejects(readMxOrders(send, { orderStatus: ["all"] }), /Unsupported seller order status/);
});

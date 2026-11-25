import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readOpenMxApprovalStatus } from "../lib/agent/mx-approval-read.js";

const manage = "https://seller.tiktokshopglobalselling.com/product/manage";
const all = manage + "?tab=all&shop_region=MX";
const productId = "1738659711601444428";
const other = "1738660882404640332";
const tab = (id, url = all, options) => ({ id, url, status: "complete", ...options });
const row = (id, status) => `<tr><td>Una lámpara\nID: ${id}</td><td>${status}</td></tr>`;
const table = rows => `<h1>商品管理</h1><table><thead><tr><th>商品</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table>`;

async function read(tabs, documents = {}, since = 0) {
  const reads = [];
  const browser = {
    tabs: { async query(filter) { assert.equal(filter.url, manage + "*"); return tabs; } },
    scripting: {
      async executeScript({ target, func, args }) {
        reads.push(target.tabId);
        assert.deepEqual(Object.keys(target), ["tabId"]);
        const entry = documents[target.tabId];
        if (!entry) throw Error("Tab closed or host permission unavailable");
        const dom = new JSDOM(entry.html, { url: entry.url || all });
        const win = dom.window;
        const before = win.document.documentElement.outerHTML;
        Object.defineProperty(win.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
        win.HTMLElement.prototype.getClientRects = () => ({ length: 1 });
        Object.defineProperty(win.performance, "timeOrigin", { value: entry.documentAt ?? 1000 });
        globalThis.window = win;
        globalThis.location = win.location;
        globalThis.document = win.document;
        globalThis.getComputedStyle = win.getComputedStyle.bind(win);
        globalThis.chrome = { runtime: { getURL(resource) { return new URL("../" + resource, import.meta.url).href; } } };
        try {
          const result = await func(...args);
          assert.equal(win.document.documentElement.outerHTML, before);
          return [{ result }];
        } finally {
          for (const key of ["window", "location", "document", "getComputedStyle", "chrome"]) delete globalThis[key];
          win.close();
        }
      },
    },
  };
  return { result: await readOpenMxApprovalStatus(productId, browser, since), reads };
}

{
  const tabs = [tab(1, manage + "?shop_region=MX&tab=draft"), tab(2, manage + "?tab=all&shop_region=JP"),
    tab(3, all + "&tab=active"), tab(4, all.replace("seller.", "other.")), tab(5, all.replace("manage", "edit"))];
  const { result, reads } = await read(tabs);
  assert.equal(result.status, "no_page");
  assert.deepEqual(reads, []);
}
{
  const { result, reads } = await read([tab(1, all, { frozen: true }), tab(2, all, { discarded: true }),
    tab(3, all, { pendingUrl: manage }), tab(4, all, { status: "loading" })]);
  assert.equal(result.status, "unreadable");
  assert.deepEqual(reads, []);
}
{
  const { result, reads } = await read([tab(1), tab(2)], {
    1: { html: table(row(other, "审核中")) },
    2: { html: table(row(productId, "在售") + row(other, "审核中")) },
  });
  assert.deepEqual(result, { productId, status: "active", verified: true, title: "Una lámpara", documentAt: 1000 });
  assert.deepEqual(reads, [1, 2]);
}
for (const html of [table(row(other, "审核中")), "<h1>商品管理</h1><p>暂无商品</p>"]) {
  const { result } = await read([tab(1)], { 1: { html } });
  assert.deepEqual(result, { productId, status: "not_found", verified: false, documentAt: 1000 });
}
for (const entry of [
  { html: table(row(productId, "审核中")), url: all.replace("all", "active") },
  { html: table(row(productId, "在售") + row(productId, "审核中")) },
  { html: table(row(productId, "未知")) }, { html: "<h1>商品管理</h1>" },
  { html: table(row(productId, "在售")) + "<div role=progressbar></div>" },
  { html: table(row(productId, "在售")) + "<p>请完成下列验证</p>" },
  undefined,
]) {
  const { result } = await read([tab(1)], { 1: entry });
  assert.deepEqual(result, { productId, status: "unreadable", verified: false });
}
{
  const { result } = await read([tab(1), tab(2)], {
    1: { html: table(row(productId, "审核中")) }, 2: { html: table(row(productId, "在售")) },
  });
  assert.equal(result.status, "unreadable");
}
for (const [label, status] of [["审核未通过", "rejected"], ["审核未通过 查看原因", "rejected"], ["需要关注", "attention"]]) {
  const { result } = await read([tab(1)], { 1: { html: table(row(productId, label)) } });
  assert.equal(result.status, status);
}
{
  const { result } = await read([tab(1), tab(2)], {
    1: { html: table(row(productId, "需要关注")) }, 2: { html: table(row(productId, "审核未通过")) },
  });
  assert.equal(result.status, "unreadable");
}
{
  const docs = {
    1: { html: table(row(productId, "在售")), documentAt: 3000 },
    2: { html: table(row(productId, "审核中")), documentAt: 4000 },
    3: { html: table(row(productId, "审核中")), documentAt: 5000 },
  };
  assert.deepEqual((await read([tab(1)], docs, 3500)).result,
    { productId, status: "stale_page", verified: false, documentAt: 3000 });
  for (const tabs of [[tab(1), tab(2), tab(3)], [tab(3), tab(2), tab(1)]]) {
    const { result } = await read(tabs, docs, 3500);
    assert.equal(result.status, "under_review");
    assert.equal(result.documentAt, 5000);
  }
}
// The same deadline covers discovery and all reads. Resolving either blocked API
// after the deadline must not issue a script injection on a subsequent tab.
await Promise.all(["query", "injection"].map(async blocked => {
  let resume;
  const eventual = new Promise(resolve => { resume = resolve; });
  const tabs = [tab(1), tab(2)];
  const calls = [];
  const browser = {
    tabs: { async query() { return blocked === "query" ? eventual : tabs; } },
    scripting: { async executeScript({ target }) { calls.push(target.tabId); return eventual; } },
  };
  const result = await readOpenMxApprovalStatus(productId, browser);
  assert.equal(result.status, "unreadable");
  resume(blocked === "query" ? tabs : []);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, blocked === "query" ? [] : [1]);
}));
console.log("Passive MX approval checks only read existing matching lists");

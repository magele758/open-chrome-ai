import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { readShopeeSellerPromotions } from "../seller-promotions.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const origin = "https://seller.shopee.cn";
const urlFor = route => `${origin}/portal/marketing/${route}?cnsc_shop_id=123`;
const page = (url, html) => {
  const { window } = new JSDOM(html, { url, runScripts: "outside-only" });
  window.HTMLElement.prototype.getClientRects = function () {
    return this.closest("[hidden]") ? [] : [{ width: 10, height: 10 }];
  };
  return { window, run: window.eval(`(${readShopeeSellerPromotions.toString()})`) };
};
const headers = values => `<table><thead><tr>${values.map(value => `<th>${value}</th>`).join("")}</tr></thead></table>`;
const discountHeaders = ["全部", "促销活动类型", "商品", "活动期间", "操作"];
const globalHeaders = ["市场", "活动名称", "商品", "状态", "活动期间", "操作"];

test("extracts scoped discount rows and performance metrics, preserving dates and currency", () => {
  const url = urlFor("list/discount");
  const body = `
    <aside><p>暂无数据</p><button aria-label="下一页">其它下一页</button></aside>
    <section>
      <h2>营销活动表现</h2><span>过去 7 天</span>
      <ul>
        <li><span>销售</span><strong>PHP 1,205.50</strong></li>
        <li><span>订单</span><strong>14</strong></li>
        <li><span>售出件数</span><strong>31</strong></li>
        <li><span>买家</span><strong>12</strong></li>
      </ul>
    </section>
    <section>
      ${headers(discountHeaders)}
      <table><tbody><tr>
        <td>Summer Deal\n进行中</td><td>店铺折扣</td><td>Voucher PHP 799.00 + 12 件</td>
        <td>2026-11-18 08:20 ~ 2026-11-21 19:55</td>
        <td><button>复制</button></td>
      </tr></tbody></table>
      <nav aria-label="分页">
        <span>共 31 条</span><span aria-current="page">1</span><button aria-label="下一页">›</button>
      </nav>
    </section>`;
  const { window, run } = page(url, body);
  const result = run(url);
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].title, "Summer Deal");
  assert.equal(result.rows[0].status, "进行中");
  assert.equal(result.rows[0].type, "店铺折扣");
  assert.equal(result.rows[0].fields.商品, "Voucher PHP 799.00 + 12 件");
  assert.equal(result.rows[0].fields.活动期间, "2026-11-18 08:20 ~ 2026-11-21 19:55");
  assert.equal(Object.hasOwn(result.rows[0].fields, "操作"), false);
  assert.equal(result.meta.stats.销售, "PHP 1,205.50");
  assert.equal(result.meta.stats.订单, "14");
  assert.equal(result.meta.stats.售出件数, "31");
  assert.equal(result.meta.stats.买家, "12");
  assert.equal(result.meta.period, "过去 7 天");
  assert.equal(result.meta.currentPage, 1);
  assert.equal(result.meta.totalRecords, 31);
  assert.equal(result.next.action, "next-page");
  assert.equal(result.warnings.length, 0);
  let clicks = 0;
  for (const button of window.document.querySelectorAll("button")) {
    button.addEventListener("click", () => {
      assert.ok(button.closest("nav"));
      clicks++;
    });
  }
  assert.equal(run(url.replace("=123", "=999"), "next-page").code, "page-changed");
  assert.equal(run(url, "submit").code, "unsupported-action");
  assert.equal(clicks, 0);
  assert.equal(run(url, "next-page").ok, true);
  assert.equal(clicks, 1);
  window.document.querySelector("nav button").disabled = true;
  assert.equal(run(url, "next-page").code, "next-page-unavailable");
  assert.equal(clicks, 1);
  window.close();
});

test("reads the global discount empty result and rejects ambiguous tables or next controls", () => {
  const url = urlFor("global-discount/list");
  const { window, run } = page(url, `<section>${headers(globalHeaders)}<p>0 个结果</p></section>`);
  const result = run(url);
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 0);
  assert.equal(result.meta.totalRecords, 0);
  assert.equal(result.meta.emptyMessage, "0 个结果");
  assert.equal(result.next, null);
  assert.match(result.warnings.join(" "), /0 个结果/);
  assert.equal(run(url, "next-page").ok, false);
  window.close();

  const filled = `<section>${headers(globalHeaders)}
    <table><tbody><tr><td>PH</td><td>Oferta</td><td>2</td><td>Ongoing</td><td>18/11 ~ 21/11</td><td>操作</td></tr></tbody></table>
    <nav aria-label="分页"><button aria-label="下一页">A</button><button aria-label="下一页">B</button></nav></section>`;
  const ambiguous = page(url, filled);
  assert.equal(ambiguous.run(url).rows[0].fields.市场, "PH");
  assert.equal(ambiguous.run(url, "next-page").code, "next-page-unavailable");
  ambiguous.window.close();
});

test("recognizes the flash sale guide with a trailing slash and requires the exact URL and unique shop ID", () => {
  const url = urlFor("shop-flash-sale/list/");
  const guide = `<section><h2>店铺限时抢购</h2><p>创建你的第一个店铺限时抢购</p></section>
    <section><h3>营销活动表现</h3>
      <p><span>点击率</span><strong>8.50%</strong></p>
      <p><span>转化率</span><strong>2.10%</strong></p>
    </section>`;
  const { window, run } = page(url, guide);
  const result = run(url);
  assert.equal(result.ok, true);
  assert.equal(result.meta.url, url);
  assert.equal(result.rows.length, 0);
  assert.equal(result.meta.stats.点击率, "8.50%");
  assert.equal(result.meta.stats.转化率, "2.10%");
  assert.equal(result.meta.emptyMessage, "创建你的第一个店铺限时抢购");
  assert.match(result.warnings.join(" "), /店铺限时抢购/);
  assert.equal(run(urlFor("shop-flash-sale/list")).code, "page-changed");
  window.close();
  const duplicateUrl = url + "&cnsc_shop_id=456";
  const duplicate = page(duplicateUrl, guide);
  assert.equal(duplicate.run(duplicateUrl).code, "page-changed");
  duplicate.window.close();
});

test("recognizes the empty flash sale table", () => {
  const url = `${urlFor("shop-flash-sale/list")}&type=0`;
  const label = "未发现任何店内秒杀活动";
  const columns = ["开始/结束时间", "商品", "已设置提醒的数量：", "商品的点击数/浏览数", "状态", "开启/关闭", "操作"];
  const { window, run } = page(url, `<main><section>
    <h2>活动列表</h2>
    <div>${headers(columns)}</div>
    <div id="empty"><img alt=""><span>${label}</span></div>
  </section><aside></aside></main>`);
  const result = run(url);
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 0);
  assert.deepEqual([...result.meta.columns], columns);
  assert.equal(result.meta.emptyMessage, label);
  assert.equal(result.warnings.join(""), label);
  assert.equal(result.next, null);
  window.document.querySelector("aside").append(window.document.querySelector("#empty"));
  assert.equal(run(url).meta.emptyMessage, null);
  window.close();
});

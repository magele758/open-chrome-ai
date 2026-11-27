import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { readShopeeCampaigns } from "../page-state.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const base = "https://seller.shopee.cn/portal/marketing";
const start = `${base}?cnsc_shop_id=123`;
const catalog = `${base}/cmt-cb/list/campaign?cnsc_shop_id=123`;
const nominations = `${base}/cmt-cb/list?cnsc_shop_id=123`;

function launch(t, url, html) {
  const { window } = new JSDOM(html, { url, runScripts: "outside-only" });
  t.after(() => window.close());
  window.HTMLElement.prototype.getClientRects = function () {
    return this.closest("[hidden]") ? [] : [{ width: 10, height: 10 }];
  };
  const read = window.eval(`(${readShopeeCampaigns.toString()})`);
  return {
    document: window.document,
    run: (input = url, action = "read") => JSON.parse(JSON.stringify(read(input, action))),
  };
}

const exampleCard = `
  <article class="CampaignGridItemWrapper---itemWrapper--abc">
    <img src="/banner.png" alt="11.25 Weekly Mega Sale">
    <div class="CampaignGridItemWrapper---exhibition--abc">
      <p>平台大促</p>
      <p>11.25 Weekly Mega Sale</p>
      <div><span>活动时间</span><span>2026/11/25 00:00 - 2026/11/26 23:59 (GMT+8)</span></div>
      <div>提名截止：2026/11/23 23:59 (GMT+8)</div>
    </div>
    <div class="CampaignGridItemWrapper---actions--abc">
      <span>可报名：3</span><button id="signup">立即报名</button>
    </div>
  </article>`;

test("reads displayed overview cards, keeping source URLs and skipping inactive cards", t => {
  const { run } = launch(t, start, `
    <article class="events-card" data-campaign-id="8579">
      <div class="content-wrapper">
        <h2 class="title">Weekly Mega Sale</h2><p class="description">Save up to 40%</p>
        <p>活动时间：11/25</p>
      </div>
      <a href="/portal/marketing/cmt-cb/list/campaign?cnsc_shop_id=123">查看详情</a>
    </article>
    <article class="events-card" hidden><div class="content-wrapper"><div class="title">Hidden</div></div></article>
    <article class="events-card"><div class="content-wrapper"><h2 class="title">另一张卡片</h2></div>
      <a href="/portal/marketing/cmt-cb/list/campaign?cnsc_shop_id=999">查看详情</a></article>
  `);
  const result = run();
  assert.equal(result.kind, "marketing-overview");
  assert.equal(result.meta.shopId, "123");
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows[0], {
    id: "8579", title: "Weekly Mega Sale", summary: "Save up to 40%", url: catalog, sourceUrl: start,
    campaignTime: "11/25", signupEnd: "", fields: { 活动时间: "11/25" },
  });
  assert.equal(result.rows[1].url, "");
});

test("reads catalog category, dates, listed counts and only changes the requested read-only tab", t => {
  const { run, document } = launch(t, catalog, `
    <div role="tablist">
      <button class="eds-react-tabs-tab" role="tab" aria-selected="true">可报名 (4)</button>
      <button class="eds-react-tabs-tab" role="tab" id="pending" aria-selected="false">待确认（0）</button>
    </div>
    ${exampleCard}
    <div class="driver-popover"><button id="tutorial-next" class="driver-popover-next-btn">下一页</button></div>
  `);
  const actions = [];
  for (const id of ["signup", "pending", "tutorial-next"]) {
    document.getElementById(id).addEventListener("click", () => actions.push(id));
  }
  const result = run();
  assert.equal(result.kind, "campaign-catalog");
  assert.deepEqual(result.meta.stats, { 可报名: 4, 待确认: 0 });
  assert.deepEqual(result.rows[0], {
    id: "", title: "11.25 Weekly Mega Sale", category: "平台大促",
    campaignTime: "2026/11/25 00:00 - 2026/11/26 23:59 (GMT+8)", nominationDeadline: "2026/11/23 23:59 (GMT+8)",
    status: "可报名", url: "", sourceUrl: catalog,
    fields: { 活动时间: "2026/11/25 00:00 - 2026/11/26 23:59 (GMT+8)", 提名截止: "2026/11/23 23:59 (GMT+8)", 可报名: "3" },
  });
  assert.equal(result.next, null);
  assert.equal(run(catalog, "next-page").changed, false);
  assert.equal(run(catalog, { type: "select-tab", label: "立即报名" }).changed, false);
  assert.equal(run(catalog.replace("=123", "=999"), { type: "select-tab", label: "待确认" }).kind, "unsupported");
  assert.equal(run(catalog, { type: "select-tab", label: "待确认" }).changed, true);
  assert.deepEqual(actions, ["pending"]);
});

test("limits next-page action to a single enabled control in table pagination", t => {
  const { run, document } = launch(t, catalog, `
    <div class="driver-popover"><button>下一页</button></div>
    <nav class="eds-react-pagination"><button aria-current="page">2</button><button aria-label="下一页" id="next">›</button></nav>`);
  const next = document.querySelector("#next");
  let clicks = 0;
  next.addEventListener("click", () => clicks++);
  const result = run();
  assert.equal(result.meta.page, 2);
  assert.deepEqual(result.next, { action: "next-page" });
  assert.equal(run(catalog, "next-page").changed, true);
  next.setAttribute("aria-disabled", "true");
  assert.equal(run(catalog, "next-page").changed, false);
  assert.equal(clicks, 1);
});

test("aligns separate nomination table panes without treating actions as report columns", t => {
  const { run } = launch(t, nominations, `
    <div class="eds-react-table">
      <div><table><thead><tr><th>报名名称</th><th>报名描述</th></tr></thead></table>
        <table><tbody><tr data-campaign-id="9"><td>June Campaign</td><td>Discount for the month</td></tr></tbody></table></div>
      <div><table><thead><tr><th>优先级</th><th>报名进度</th><th>报名方式</th><th>可报名店铺</th><th>是否支持 SIP</th>
        <th>状态</th><th>报名时间</th><th>操作</th></tr></thead></table>
        <table><tbody><tr><td>一级</td><td>0/5</td><td>平台邀请</td><td>1</td><td>是</td>
        <td>进行中</td><td>11/20 至 11/23</td><td><button>立即报名</button></td></tr></tbody></table></div>
    </div>`);
  const result = run();
  assert.equal(result.kind, "campaign-nominations");
  assert.deepEqual(result.rows, [{
    id: "9", title: "June Campaign", summary: "Discount for the month", status: "进行中", campaignTime: "11/20 至 11/23",
    url: "", sourceUrl: nominations,
    fields: { 报名名称: "June Campaign", 报名描述: "Discount for the month", 优先级: "一级", 报名进度: "0/5",
      报名方式: "平台邀请", 可报名店铺: "1", 是否支持SIP: "是", 状态: "进行中", 报名时间: "11/20 至 11/23" },
  }]);
});

test("reports an explicit empty nomination list without mistaking it for a loading failure", t => {
  const { run } = launch(t, nominations, '<p>暂无可提报活动</p>');
  const result = run();
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.warnings, []);
});

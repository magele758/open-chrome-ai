import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { inspectShopeeMarketingForm, trialShopeeMarketingForm } from "../../marketing-runtime.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const origin = "https://seller.shopee.cn";
const formByRoute = new Map([
  ["discount/create", '<section><div><label>活动名称</label><div><input maxlength="150" placeholder=" "><span>0/150</span></div></div><p>活动期间必须小于180天</p></section>'],
  ["global-discount/create", '<section><div><div>* 活动名称</div><div><span><input maxlength="150"></span></div></div><input placeholder="Select Date" value="2026-11-18 11:30"><input placeholder="Select Date" value="2026-11-18 12:30"></section>'],
  ["shop-flash-sale/create", '<section><button type="button">选择时间段</button><button type="button" disabled>添加商品</button></section>'],
]);

function environment(t, route, html = formByRoute.get(route)) {
  const url = `${origin}/portal/marketing/${route}?cnsc_shop_id=123`;
  const tab = { id: 53, url };
  const { window } = new JSDOM(`<form>${html}<button type="submit">确认</button></form>`, { url, runScripts: "outside-only" });
  window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  let writes = 0;
  let submits = 0;
  let clicks = 0;
  window.document.addEventListener("input", () => { writes++; });
  window.document.addEventListener("click", () => { clicks++; });
  window.document.addEventListener("submit", event => { event.preventDefault(); submits++; });
  const oldChrome = globalThis.chrome;
  globalThis.chrome = {
    permissions: { contains: async () => true },
    tabs: { get: async id => {
      assert.equal(id, tab.id);
      return { ...tab, url: window.location.href };
    } },
    scripting: { executeScript: async ({ target, func, args }) => {
      assert.equal(target.tabId, tab.id);
      assert.deepEqual(target.documentIds || target.frameIds, target.documentIds ? ["document"] : [0]);
      const result = await window.eval(`(${func.toString()})`)(...args);
      return [{ documentId: "document", frameId: 0, result: JSON.parse(JSON.stringify(result)) }];
    } },
  };
  t.after(() => { globalThis.chrome = oldChrome; window.close(); });
  return { window, tab, events: () => ({ writes, clicks, submits }) };
}

for (const route of ["discount/create", "global-discount/create"]) {
  test(`shows fields and fills only the activity name with readback on ${route}`, async t => {
    const { window, tab, events } = environment(t, route);
    const initial = await inspectShopeeMarketingForm({ tab });
    assert.equal(initial.fields.filter(field => !field.readOnly).length, 1);
    assert.equal(initial.fields[0].key, "name");
    if (route.startsWith("global")) assert.equal(initial.fields[1].value, "2026-11-18 11:30");
    const sample = { name: "PageLens 试填" };
    const result = await trialShopeeMarketingForm({ tab, input: sample });
    assert.deepEqual(result.filled, [{ label: "活动名称", value: sample.name }]);
    assert.equal(result.submitted, false);
    assert.equal(window.document.querySelector("input").value, sample.name);
    assert.deepEqual(events(), { writes: 1, clicks: 0, submits: 0 });
    const overwrite = await trialShopeeMarketingForm({ tab, input: { name: "Other" } });
    assert.equal(overwrite.code, "campaign-draft-not-empty");
    assert.deepEqual(events(), { writes: 1, clicks: 0, submits: 0 });
  });
}

test("identifies flash-sale prerequisites while blocking writes and navigation", async t => {
  const { window, tab, events } = environment(t, "shop-flash-sale/create");
  const report = await inspectShopeeMarketingForm({ tab });
  assert.equal(report.fields[0].key, "timeSlot");
  assert.equal(report.fields.every(field => field.readOnly), true);
  assert.match(report.blockers[0], /选择可用时间段/u);
  assert.equal((await trialShopeeMarketingForm({ tab, input: { timeSlot: "18:00" } })).ok, false);
  window.history.replaceState({}, "", "?cnsc_shop_id=456");
  await assert.rejects(inspectShopeeMarketingForm({ tab }), /店铺已变化/u);
  assert.deepEqual(events(), { writes: 0, clicks: 0, submits: 0 });
});

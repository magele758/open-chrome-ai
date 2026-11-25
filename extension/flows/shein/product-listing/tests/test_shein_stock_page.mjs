import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { sheinStockPage } from "../stock-page.js";

const href = "https://sellerhub.shein.com/#/spmp/commoditiesInfo?mode=add&last_page=page_commodities_category";
const categoryPath = ["家居&生活", "厨房&餐厅", "饮具", "真空瓶和保温杯"];
const stock = (quantity, siteLabel = "美国", options = ["黑色"]) => ({ options, quantity, siteLabel });

function mount(t, { save = true, rowControls = "", defaultSku = "", modalSku = defaultSku } = {}) {
  const stockCell = id => rowControls === "anchor" ? `美国 -- <a id="${id}" href="/unrelated">编辑库存</a>` :
    rowControls === "button" ? `美国 -- <button id="${id}"><span>编辑库存</span></button>` : "0";
  const dom = new JSDOM(`
    <div class="spmp_style__commodityCategoryItem--fixture"><div class="spmp_style__categoryInfo--fixture"></div></div>
    <button id="publish">发布商品</button><button id="draft">保存草稿</button><button id="other">确定</button>
    <div class="spmp_style__supplyInfoTable--fixture">
      ${rowControls ? "" : '<button id="edit">编辑库存</button>'}
      <table><thead><tr><th>${defaultSku ? "主规格" : "颜色"}</th><th>库存</th></tr></thead><tbody>
        ${defaultSku ? `<tr><td>SKC：<span>${defaultSku}</span></td><td>${stockCell("edit-default")}</td></tr>` : `
        <tr><td><div>黑色</div><div>SKC：<span>fixture-black</span></div></td><td>${stockCell("edit-black")}</td></tr>
        <tr><td><div>白色</div><div>SKC：<span>fixture-white</span></div></td><td>${stockCell("edit-white")}</td></tr>`}
      </tbody></table>
    </div>`, { url: href, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  document.querySelector('[class*="spmp_style__categoryInfo--"]').textContent = categoryPath.join(" > ");
  dom.window.HTMLElement.prototype.getClientRects = function () {
    return this.closest("[hidden]") ? [] : [{ width: 40, height: 30 }];
  };
  const remote = defaultSku ? { "默认:美国": "0", "默认:墨西哥": "7" } :
    { "黑色:美国": "0", "黑色:墨西哥": "7", "白色:美国": "0", "白色:墨西哥": "8" };
  const actions = [];
  for (const id of ["publish", "draft", "other"]) document.getElementById(id).onclick = () => actions.push(id);
  const openModal = event => {
    actions.push(rowControls ? event.currentTarget.id : "open");
    const stockModal = document.createElement("div");
    stockModal.className = "so-modal so-modal-show";
    stockModal.innerHTML = `<div class="so-modal-mask"><section class="so-modal-panel">
      <div class="so-card-header so-modal-title">${rowControls === "anchor" ? "编辑库存" : "库存维护"}</div>
      <div class="so-table">
      <div class="so-table-simple-header"><table><thead><tr><th>${defaultSku ? "主规格" : "颜色"}</th><th>库存</th></tr></thead></table></div>
      <div class="so-table-simple-body"><table><tbody>
        ${(defaultSku ? ["默认"] : ["黑色", "白色"]).map(color => `<tr>
          ${defaultSku ? `<td>SKC：<span>${modalSku}</span></td>` : `<td><span>${color}</span><div>SKC：<span>fixture</span></div></td>`}<td>
          ${["美国", "墨西哥"].map(site => `<div><div>${site}</div><span><input type="text" placeholder="请输入" data-stock="${color}:${site}" value="${remote[`${color}:${site}`]}" /></span></div>`).join("")}
        </td></tr>`).join("")}
      </tbody></table></div></div>
      <footer><button data-cancel>取消</button><button data-confirm>确定</button></footer>
    </section></div>`;
    stockModal.querySelector("[data-cancel]").onclick = () => { actions.push("cancel"); stockModal.remove(); };
    stockModal.querySelector("[data-confirm]").onclick = () => {
      actions.push("confirm");
      if (save) for (const control of stockModal.querySelectorAll("input")) remote[control.dataset.stock] = control.value;
      stockModal.remove();
    };
    for (const control of stockModal.querySelectorAll("input")) control.oninput = () => actions.push(control.dataset.stock);
    document.body.append(stockModal);
  };
  for (const id of rowControls ? defaultSku ? ["edit-default"] : ["edit-black", "edit-white"] : ["edit"]) {
    document.getElementById(id).onclick = openModal;
  }
  const run = async args => JSON.parse(JSON.stringify(await dom.window.eval(
    `(${sheinStockPage})(${JSON.stringify({ href, categoryPath, ...args })})`,
  )));
  return { run, remote, actions, document };
}

test("opens the exact SKU’s 编辑库存 anchor for a shared dialog and leaves unrelated actions untouched", async t => {
  const { run, remote, actions, document } = mount(t, { rowControls: "anchor" });
  const result = await run({ rows: [stock(7, "美国", ["白色"]), stock(3)] });
  assert.equal(result.ok, true);
  assert.deepEqual(actions, ["edit-white", "白色:美国", "黑色:美国", "confirm", "edit-white", "cancel"]);
  assert.equal(document.location.href, href);
  assert.equal(remote["白色:美国"], "7");
  assert.equal(remote["黑色:美国"], "3");
});

test("handles both SKU rows from one shared 库存维护 dialog when each SKU has its own 编辑库存 button", async t => {
  const { run, remote, actions } = mount(t, { rowControls: "button" });
  const result = await run({ rows: [stock(2), stock(5, "美国", ["白色"])] });
  assert.equal(result.ok, true);
  assert.deepEqual(actions, ["edit-black", "黑色:美国", "白色:美国", "confirm", "edit-black", "cancel"]);
  assert.deepEqual(remote, { "黑色:美国": "2", "黑色:墨西哥": "7", "白色:美国": "5", "白色:墨西哥": "8" });
});

test("writes only requested SKU and site, reopens the owned dialog for readback, and skips a redundant confirmation", async t => {
  const { run, remote, actions } = mount(t);
  const filled = await run({ rows: [stock(1)] });
  assert.equal(filled.ok, true);
  assert.deepEqual(filled.items.map(({ label, status, value }) => [label, status, value]), [["黑色 · 美国库存", "verified", 1]]);
  assert.deepEqual(actions, ["open", "黑色:美国", "confirm", "open", "cancel"]);
  assert.deepEqual(remote, { "黑色:美国": "1", "黑色:墨西哥": "7", "白色:美国": "0", "白色:墨西哥": "8" });
  actions.length = 0;
  const unchanged = await run({ rows: [stock(1)] });
  assert.equal(unchanged.items[0].status, "unchanged");
  assert.deepEqual(actions, ["open", "cancel"]);
});

test("prevalidates all requested site and spec bindings before writing", async t => {
  const { run, remote, actions } = mount(t);
  assert.equal((await run({ rows: [stock(3), stock(2, "加拿大", ["白色"])] })).code, "STOCK_TARGET_MISSING");
  assert.equal((await run({ rows: [stock(3), stock(2)] })).code, "STOCK_INPUT_INVALID");
  assert.equal((await run({ rows: [stock(-1)] })).code, "STOCK_INPUT_INVALID");
  assert.equal((await run({ rows: [stock(3, "美国", ["蓝色"])] })).code, "STOCK_ROW_NOT_FOUND");
  assert.equal((await run({ rows: [stock(3)], categoryPath: ["别的类目"] })).code, "CATEGORY_CHANGED");
  assert.deepEqual(actions, ["open", "cancel"]);
  assert.equal(remote["黑色:美国"], "0");
});

test("fills multiple matched rows and an explicitly supplied zero in the same confirmation", async t => {
  const { run, remote, actions } = mount(t);
  const outcome = await run({ rows: [stock(3), stock(0, "墨西哥", ["白色"])] });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.items.map(item => item.value), [3, 0]);
  assert.equal(remote["黑色:美国"], "3");
  assert.equal(remote["白色:墨西哥"], "0");
  assert.equal(actions.filter(action => action === "confirm").length, 1);
});

test("fills only the requested site on a unique pinned default SKU", async t => {
  const defaultSku = "se261119171434502395170";
  const { run, remote, actions, document } = mount(t, { rowControls: "anchor", defaultSku });
  const rows = [stock(3, "美国", [])];
  assert.equal((await run({ rows })).code, "STOCK_INPUT_INVALID");
  assert.equal((await run({ rows, defaultSku: "stale-key" })).code, "STOCK_ROW_NOT_FOUND");
  assert.deepEqual(actions, []);
  const result = await run({ rows, defaultSku });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map(item => item.value), [3]);
  assert.deepEqual(remote, { "默认:美国": "3", "默认:墨西哥": "7" });
  assert.equal(document.location.href, href);
});

test("refuses a default stock dialog that shows a different SKC", async t => {
  const defaultSku = "se261119171434502395170";
  const { run, remote, actions } = mount(t, { rowControls: "anchor", defaultSku, modalSku: "another-sku" });
  assert.equal((await run({ rows: [stock(3, "美国", [])], defaultSku })).code, "STOCK_TARGET_MISSING");
  assert.deepEqual(remote, { "默认:美国": "0", "默认:墨西哥": "7" });
  assert.deepEqual(actions, ["edit-default", "cancel"]);
});

test("does not report success if the confirmed stock does not persist in the dialog", async t => {
  const { run, remote, actions } = mount(t, { save: false });
  const failed = await run({ rows: [stock(3)] });
  assert.equal(failed.code, "STOCK_SAVE_UNVERIFIED");
  assert.equal(failed.items.length, 0);
  assert.equal(remote["黑色:美国"], "0");
  assert.deepEqual(actions, ["open", "黑色:美国", "confirm", "open", "cancel"]);
});

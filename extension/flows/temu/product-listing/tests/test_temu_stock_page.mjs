import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { temuStockPage } from "../stock-page.js";

const href = "https://agentseller.temu.com/goods/edit?productDraftId=42";
const dom = new JSDOM(`
  <main id="page_container_id">
    <div id="sku_stock_10004_16066">
      <span class="sku-stock-input_stockView__mock">-</span>
      <svg data-testid="beast-core-icon-edit"></svg>
    </div>
    <div id="sku_stock_other">
      <span class="sku-stock-input_stockView__mock">4</span>
      <svg data-testid="beast-core-icon-edit"></svg>
    </div>
    <button id="publish">创建</button>
  </main>`, { url: href, runScripts: "outside-only" });
const { document } = dom.window;
dom.window.Element.prototype.getClientRects = function () {
  return this.closest("[hidden]") ? [] : [{}];
};
const call = args => dom.window.eval(
  `(${temuStockPage.toString()})(${JSON.stringify({ href, key: "10004_16066", ...args })})`,
);
const display = document.querySelector("#sku_stock_10004_16066 span");
const otherDisplay = document.querySelector("#sku_stock_other span");
let confirmed = 0;
let cancelled = 0;
let otherClicked = 0;
let publishClicked = 0;
let rejectedConfirmation = false;
let missingCurrentSku = false;
let warehouseConflict = false;
let multipleSkus = false;

const title = '<div class="MDL_header_mock"><span>填写库存</span></div>';
const input = (id, value = "") =>
  `<input id="${id}" type="text" data-testid="beast-core-inputNumber-htmlInput" placeholder="请输入" value="${value}">`;
document.querySelector("#sku_stock_other svg").addEventListener("click", () => otherClicked++);
document.querySelector("#publish").addEventListener("click", () => publishClicked++);
document.querySelector("#sku_stock_10004_16066 svg").addEventListener("click", () => {
  const dialog = document.createElement("div");
  dialog.className = "MDL_inner_mock";
  dialog.dataset.testid = "beast-core-modal-inner";
  const currentSku = missingCurrentSku ? "" : "<em>当前SKU</em>";
  const otherRow = warehouseConflict
    ? `<tr><td>456</td><td>${input("other")}</td><td>美国站</td></tr>`
    : multipleSkus ? `<tr><td>橙色</td><td>123</td><td>${input("other")}</td><td>美国站</td></tr>` : "";
  dialog.innerHTML = `
    ${title}
    <section>${input("bulk")}<button>批量填写</button></section>
    <table class="another-class performance-table_performanceTable__mock"><thead><tr><th>颜色</th><th>尺码</th><th>发货仓</th>
      <th>当前库存 （选填，若填写请确保库存数准确）</th><th>覆盖站点</th></tr></thead><tbody>
      <tr><td rowspan="${warehouseConflict ? 2 : 1}">花色</td><td rowspan="${otherRow ? 2 : 1}">S ${currentSku}</td>
        <td>123</td><td>${input("current")}</td><td>美国站</td></tr>
      ${otherRow}</tbody></table>
    <button id="confirm">确认</button><button id="cancel">取消</button>`;
  // Match the live React tree, where the header cells are direct children.
  const head = dialog.querySelector("thead");
  head.replaceChildren(...head.rows[0].cells);
  assert.equal(head.rows.length, 0);
  dialog.querySelector("#confirm").addEventListener("click", () => {
    confirmed++;
    assert.equal(dialog.querySelector("#bulk").value, "");
    if (!rejectedConfirmation) {
      display.textContent = dialog.querySelector("#current").value || "-";
      // The live dialog saves the complete grid, clearing unfilled rows.
      if (multipleSkus) otherDisplay.textContent = dialog.querySelector("#other").value || "-";
    }
    dialog.remove();
  });
  dialog.querySelector("#cancel").addEventListener("click", () => {
    cancelled++;
    assert.equal(dialog.querySelector("#current").value, "");
    dialog.remove();
  });
  document.body.append(dialog);
});

assert.equal((await call({ kind: "inspect" })).value, undefined);
assert.equal((await call({ kind: "write", value: "1.5" })).code, "VALUE_INVALID");
assert.equal((await call({ kind: "write", value: "1", href: href.replace("42", "43") })).code, "PAGE_CHANGED");
assert.equal((await call({ kind: "write", value: "1" })).status, "verified");
assert.equal((await call({ kind: "inspect" })).value, "1");
assert.equal((await call({ kind: "write", value: "1" })).status, "unchanged");
assert.equal(confirmed, 1);
assert.equal((await call({ kind: "write", value: "0" })).value, "0");

const foreign = document.createElement("div");
foreign.className = "MDL_inner_foreign";
foreign.textContent = "活动确认";
document.body.append(foreign);
assert.equal((await call({ kind: "write", value: "1" })).code, "MODAL_BLOCKED");
assert.ok(foreign.isConnected);
foreign.remove();

missingCurrentSku = true;
assert.equal((await call({ kind: "write", value: "1" })).code, "SKU_STOCK_WAREHOUSE_REQUIRED");
missingCurrentSku = false;
assert.equal(cancelled, 1);
assert.equal(confirmed, 2);
assert.equal(display.textContent, "0");

warehouseConflict = true;
assert.equal((await call({ kind: "write", value: "1", warehouse: "123" })).code, "SKU_STOCK_WAREHOUSE_REQUIRED");
warehouseConflict = false;
assert.equal(cancelled, 2);

multipleSkus = true;
assert.equal((await call({ kind: "write", value: "1" })).code, "SKU_STOCK_WAREHOUSE_REQUIRED");
const rows = [
  { key: "10004_16066", labels: ["花色", "S", "美国站"], value: 1 },
  { key: "other", labels: ["橙色", "S"], value: 2 },
];
const batch = await call({ kind: "write-batch", rows });
assert.equal(batch.status, "verified");
assert.deepEqual({ ...batch.values }, { "10004_16066": "1", other: "2" });
assert.equal(confirmed, 3);
assert.equal((await call({ kind: "write-batch", rows })).status, "unchanged");

const invalidRows = [{ ...rows[0], value: 5 }, { ...rows[1], labels: ["黑色", "S"] }];
assert.equal((await call({ kind: "write-batch", rows: invalidRows })).code, "SKU_STOCK_WAREHOUSE_REQUIRED");
assert.equal(display.textContent, "1");
assert.equal(otherDisplay.textContent, "2");
assert.equal(cancelled, 4);

rejectedConfirmation = true;
assert.equal((await call({ kind: "write-batch", rows: [{ ...rows[0], value: 5 }, rows[1]] })).code, "SKU_QUANTITY_UNVERIFIED");
assert.equal(confirmed, 4);
assert.equal(otherClicked, 0);
assert.equal(publishClicked, 0);
assert.equal(display.textContent, "1");
assert.equal(otherDisplay.textContent, "2");
dom.window.close();
console.log("Temu confirms and verifies the whole SKU warehouse stock grid without touching bulk fields.");

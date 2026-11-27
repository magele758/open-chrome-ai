import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { temuApparelPage } from "../apparel-page.js";

const href = "https://agentseller.temu.com/goods/edit?productDraftId=active-sizes";

test("reads and checks all enabled sizes inside the active group only", async t => {
  const dom = new JSDOM(`<main id="page_container_id">
    <div class="product-skc_specItem__size">
      <div data-testid="beast-core-form-item">
        <label>尺码</label><input data-testid="beast-core-select-htmlInput" value="欧美尺码" readonly>
      </div>
      <label><input type="radio" name="group" aria-controls="regular" checked>常规</label>
      <label><input type="radio" name="group" aria-controls="petite">娇小女装</label>
      <label><input type="radio" name="group" aria-controls="tall">Tall</label>
      <div id="regular">
        <label><input type="checkbox">全选</label>
        <label><input type="checkbox">XXS</label>
        <label><input type="checkbox" checked>S<span>HOT</span></label>
        <label><input type="checkbox">M</label>
        <label><input type="checkbox" disabled>L</label>
        <label aria-disabled="true"><input type="checkbox">XL</label>
      </div>
      <div id="petite"><label><input type="checkbox">S</label><label><input type="checkbox">2P</label></div>
      <div id="tall"><label><input type="checkbox">MT</label></div>
    </div></main>`, { url: href, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.HTMLElement.prototype.getClientRects = function () { return this.closest("[hidden]") ? [] : [{}]; };
  const run = async request => JSON.parse(JSON.stringify(await window.eval(
    `(${temuApparelPage.toString()})(${JSON.stringify({ href, ...request })})`,
  )));
  const choices = await run({ kind: "inspect-sizes" });
  assert.equal(choices.ok, true);
  assert.equal(choices.system, "欧美尺码");
  assert.equal(choices.group, "常规");
  assert.deepEqual(choices.groups, [
    { name: "常规", selected: true }, { name: "娇小女装", selected: false }, { name: "Tall", selected: false },
  ]);
  assert.deepEqual(choices.sizes, ["XXS", "S", "M"]);
  assert.deepEqual(choices.selectedSizes, ["S"]);

  const result = await run({ kind: "set-sizes", value: { system: "欧美尺码", all: true } });
  assert.equal(result.status, "verified");
  assert.equal(result.group, "常规");
  assert.deepEqual(result.sizes, ["XXS", "S", "M"]);
  assert.deepEqual(result.items.map(({ label, status }) => [label, status]), [
    ["欧美尺码", "verified"], ["XXS", "filled"], ["S", "unchanged"], ["M", "filled"],
  ]);
  const { document } = window;
  assert.equal(document.querySelectorAll("#regular input:checked").length, 3);
  assert.equal(document.querySelector("#regular input[type=checkbox]").checked, false);
  assert.equal(document.querySelectorAll("#petite input:checked, #tall input:checked").length, 0);
  assert.equal(document.querySelector('input[name="group"]:checked').getAttribute("aria-controls"), "regular");
  assert.equal((await run({ kind: "set-sizes", value: { all: true, sizes: ["S"] } })).code, "VALUE_INVALID");
});

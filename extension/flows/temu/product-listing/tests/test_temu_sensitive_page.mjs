import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { temuSensitivePage } from "../sensitive-page.js";

const href = "https://agentseller.temu.com/goods/edit?productDraftId=42";
const key = "productSkuMap.123_456.sensitiveAttr";

function fixture({ duplicate = false, focusOpens = false, chipShows = true } = {}) {
  const dom = new JSDOM(`
    <main id="page_container_id">
      <table>
        <thead><tr><th>颜色</th><th id="sensitive-head"><span>敏感属性</span><a href="#help">说明</a></th></tr></thead>
        <tbody>
          <tr><td>白色</td><td><div id="${key}"><span id="selected"></span><input id="target" type="text" placeholder="敏感属性"></div></td></tr>
          <tr><td>橙色</td><td><div id="productSkuMap.111_222.sensitiveAttr"><input id="other" type="text" placeholder="敏感属性"></div></td></tr>
        </tbody>
      </table>
      <button id="publish">创建</button>
    </main>
    <div data-testid="beast-core-portal" class="PP_popover_mock" hidden>
      <section class="PP_popoverContent_mock">
        <div id="sensitive-title">是否敏感品</div>
        <label><input type="radio" name="sensitive" id="no"><span>否</span></label>
        ${duplicate ? '<label><input type="radio" name="another"><span>否</span></label>' : ""}
        <label><input type="radio" name="sensitive" id="yes" checked><span>是</span></label>
        <label><input type="checkbox" id="component"><span>纯电</span></label>
        <button id="popover-save">保存</button>
      </section>
    </div>
    <div class="MDL_inner_other" hidden><button>确认</button></div>`, { url: href, runScripts: "outside-only" });
  dom.window.Element.prototype.getClientRects = function () { return this.closest("[hidden]") ? [] : [{}]; };
  const doc = dom.window.document;
  const portal = doc.querySelector('[data-testid="beast-core-portal"]');
  const target = doc.querySelector("#target");
  const events = [];
  target.addEventListener(focusOpens ? "focus" : "click", () => {
    events.push("open");
    dom.window.setTimeout(() => { portal.hidden = false; }, 30);
  });
  doc.querySelector("#no").addEventListener("change", () => {
    events.push("no");
    dom.window.setTimeout(() => {
      doc.querySelector("#sensitive-title").textContent = "是否敏感品： 否";
      if (!chipShows) return;
      target.placeholder = "";
      const selected = doc.querySelector("#selected");
      selected.className = "ST_selectValueMultipleItem_mock";
      selected.textContent = "否";
    }, 35);
  });
  doc.querySelector("#sensitive-head").addEventListener("mousedown", event => {
    assert.equal(event.target.id, "sensitive-head");
    events.push("close");
    portal.hidden = true;
  });
  for (const id of ["other", "yes", "component", "popover-save", "publish"]) {
    doc.querySelector("#" + id).addEventListener("click", () => events.push(id));
  }
  const run = request => dom.window.eval(
    `(${temuSensitivePage.toString()})(${JSON.stringify({ href, key, value: "非敏感品", ...request })})`,
  );
  return { dom, doc, portal, events, run };
}

for (const focusOpens of [true, false]) {
  const { dom, portal, events, run } = fixture({ focusOpens });
  const result = await run();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.status, "verified");
  assert.equal(result.value, "非敏感品");
  assert.deepEqual(events, ["open", "no", "close"]);
  assert.equal(portal.hidden, true);
  assert.equal((await run({ value: "否" })).status, "unchanged");
  assert.deepEqual(events, ["open", "no", "close"]);
  dom.window.close();
}

{
  const { dom, doc, portal, events, run } = fixture();
  assert.equal((await run({ value: "是" })).code, "VALUE_INVALID");
  assert.equal((await run({ key: "productTitle" })).code, "VALUE_INVALID");
  assert.equal((await run({ href: href + "&changed=1" })).code, "PAGE_CHANGED");
  doc.querySelector(".MDL_inner_other").hidden = false;
  assert.equal((await run()).code, "MODAL_BLOCKED");
  doc.querySelector(".MDL_inner_other").hidden = true;
  portal.hidden = false;
  assert.equal((await run()).code, "MENU_STILL_OPEN");
  assert.deepEqual(events, []);
  dom.window.close();
}

{
  const { dom, portal, events, run } = fixture({ duplicate: true });
  assert.equal((await run()).code, "SENSITIVE_CONTROL_MISSING");
  assert.equal(portal.hidden, true);
  assert.deepEqual(events, ["open", "close"]);
  dom.window.close();
}

{
  const { dom, portal, events, run } = fixture({ chipShows: false });
  assert.equal((await run()).code, "READBACK_MISMATCH");
  assert.equal(portal.hidden, true);
  assert.deepEqual(events, ["open", "no", "close"]);
  dom.window.close();
}

console.log("Temu sensitive attributes are selected and verified only for the requested SKU.");

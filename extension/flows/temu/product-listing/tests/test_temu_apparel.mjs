import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { temuApparelPage } from "../apparel-page.js";

const href = "https://agentseller.temu.com/goods/edit?productDraftId=101";

function fixture(markup) {
  const dom = new JSDOM(`<main id="page_container_id">${markup}</main>`, { url: href, runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLElement.prototype.getClientRects = function () {
    return this.closest("[hidden]") ? [] : [{}];
  };
  return {
    doc: window.document,
    run: request => window.eval(`(${temuApparelPage.toString()})(${JSON.stringify({ href, ...request })})`),
    close: () => window.close(),
  };
}

function sizeFixture(labels) {
  return fixture(`<div class="product-skc_specItem__size">
    <div data-testid="beast-core-form-item">
      <span>*尺码</span><span>建议发布精准信息</span>
      <input data-testid="beast-core-select-htmlInput" value="欧美尺码" readonly>
    </div>
    ${labels.map(label => `<label><input type="checkbox">${label}</label>`).join("")}
  </div>`);
}

{
  const page = sizeFixture(["S<span>HOT</span>", "M", "L", "XL", "XXL", "3XL"]);
  const result = await page.run({
    kind: "set-sizes",
    value: { system: "欧美尺码", sizes: ["Small", "Medium", "Large", "X-Large", "XX-Large"] },
  });
  assert.equal(result.status, "verified");
  assert.deepEqual(Array.from(result.items, row => row.label), ["欧美尺码", "S", "M", "L", "XL", "XXL"]);
  assert.equal(page.doc.querySelectorAll("input[type=checkbox]:checked").length, 5);
  assert.equal(page.doc.querySelectorAll("input[type=checkbox]")[5].checked, false);
  page.close();
}

{
  const page = sizeFixture(["S", "XXL", "2XL", "L"]);
  const result = await page.run({
    kind: "set-sizes",
    value: { system: "欧美尺码", sizes: ["XX-Large", "Small", "42", "Large"] },
  });
  assert.equal(result.code, "SPEC_OPTION_MISSING");
  assert.match(result.message, /XX-LARGE、42/u);
  assert.deepEqual(Array.from(page.doc.querySelectorAll("input[type=checkbox]:checked"), box => box.parentElement.textContent), ["S", "L"]);
  const duplicate = await page.run({ kind: "set-sizes", value: { system: "欧美尺码", sizes: ["L", "Large"] } });
  assert.equal(duplicate.code, "VALUE_INVALID");
  const exact = await page.run({ kind: "set-sizes", value: { system: "欧美尺码", sizes: ["XXL"] } });
  assert.equal(exact.status, "verified");
  assert.equal(page.doc.querySelectorAll("input[type=checkbox]")[2].checked, false);
  page.close();
}

{
  const key = "productSkcList[0].mainSpec[0]";
  const page = fixture(`<div id="${key}">
    <div class="colour-spec-select_colorSpecSelect__test"><input placeholder="选择或自定义颜色"></div>
    </div><div id="productSkcList[1].mainSpec[0]">
    <div class="colour-spec-select_colorSpecSelect__test"><input placeholder="选择或自定义颜色"></div>
    </div><div data-testid="beast-core-portal">
    <div class="PP_popoverContent_test">
      <div class="colour-spec-select_searchContainer__test" hidden>
        <input type="search"><div class="colour-spec-select_selectItem__test" hidden>花色</div>
      </div>
    </div></div><div id="foreign" role="listbox">其他列表</div>`);
  const { doc } = page;
  const [input, other] = doc.querySelectorAll('input[placeholder]');
  const menu = doc.querySelector('[class*="colour-spec-select_searchContainer__"]');
  const option = menu.lastElementChild;
  const search = menu.querySelector("input");
  let clicks = 0;
  let scrolls = 0;
  doc.elementFromPoint = () => input;
  input.getBoundingClientRect = () => ({ left: 120, top: 300, width: 90, height: 30 });
  input.scrollIntoView = () => { scrolls++; };
  input.addEventListener("click", () => { assert.fail("the authorized continuation must not replay a synthetic opener"); });
  search.addEventListener("input", () => { option.hidden = search.value !== "花色"; });
  option.addEventListener("click", () => {
    clicks++;
    input.placeholder = "花色";
    input.value = "";
    menu.hidden = true;
  });
  assert.equal((await page.run({ kind: "color-target", key })).code, "MENU_STILL_OPEN");
  doc.getElementById("foreign").hidden = true;
  input.value = "in-progress";
  assert.equal((await page.run({ kind: "color-target", key })).code, "SPEC_CONTROL_MISSING");
  input.value = "";
  const point = await page.run({ kind: "color-target", key });
  assert.equal(point.ok, true, point.message);
  assert.equal(point.x, 165);
  assert.equal(point.y, 315);
  assert.equal(scrolls, 1);
  other.focus();
  menu.hidden = false;
  assert.equal((await page.run({ kind: "set-color", key, value: "花色", allowOpened: true })).code, "MENU_STILL_OPEN");
  assert.equal(clicks, 0);
  input.focus();
  const committed = await page.run({ kind: "set-color", key, value: "花色", allowOpened: true });
  assert.equal(committed.status, "filled", committed.message);
  assert.equal(clicks, 1);
  assert.equal(other.placeholder, "选择或自定义颜色");
  page.close();
}

{
  const key = "productSkcList[0].mainSpec[0]";
  const page = fixture(`<div id="${key}">
      <div class="ST_outerWrapper_test"><div class="ST_head_test">
        <input placeholder="选择或自定义颜色" aria-controls="colors" value="typed filter">
      </div></div>
    </div>
    <div data-testid="beast-core-portal">
      <div role="listbox" id="colors" hidden>
        <span role="option">E - White Stripe</span>
        <span role="option">E - White Stripe Blue</span>
      </div>
    </div>`);
  const input = page.doc.querySelector("input");
  const menu = page.doc.getElementById("colors");
  const options = Array.from(menu.querySelectorAll('[role="option"]'));
  let wrongClicks = 0;
  input.addEventListener("focus", () => { menu.hidden = false; });
  input.addEventListener("keydown", event => { if (event.key === "Escape") menu.hidden = true; });
  options[0].addEventListener("click", () => {
    input.parentElement.insertAdjacentHTML("beforeend", '<span class="ST_selectValueSingle_test">E - White Stripe</span>');
    menu.hidden = true;
  });
  options[1].addEventListener("click", () => { wrongClicks++; });
  const start = await page.run({ kind: "inspect" });
  assert.equal(start.rows[0].value, "", "The search text is not the committed SKC color");
  assert.equal((await page.run({ kind: "set-color", key, value: "E - White Stripe" })).status, "filled");
  assert.equal((await page.run({ kind: "inspect" })).rows[0].value, "E - White Stripe");
  assert.equal((await page.run({ kind: "set-color", key, value: "Black" })).code, "SPEC_VALUES_OCCUPIED");
  assert.equal(wrongClicks, 0);
  page.close();
}

{
  const key = "productSkcList[0].mainSpec[0]";
  const color = "E - White Stripe";
  const page = fixture(`<span class="STP_stepsItemTitle_test">基本信息</span>
    <div id="${key}"><div class="ST_outerWrapper_test"><div class="ST_head_test">
      <input placeholder="选择或自定义颜色" aria-controls="custom-colors">
    </div></div></div>
    <div data-testid="beast-core-portal"><div role="listbox" id="custom-colors" hidden>
      <span role="option">白色</span>
    </div></div>`);
  const { doc } = page;
  const input = doc.querySelector("input");
  const menu = doc.getElementById("custom-colors");
  let wrongClicks = 0;
  let tabbed = false;
  input.addEventListener("focus", () => { menu.hidden = false; });
  input.addEventListener("keydown", event => { if (event.key === "Tab") tabbed = true; });
  menu.querySelector("span").addEventListener("click", () => { wrongClicks++; });
  input.addEventListener("blur", () => { menu.hidden = true; });
  doc.querySelector(".STP_stepsItemTitle_test").addEventListener("mousedown", () => {
    if (!tabbed || input.value !== color || doc.activeElement === input) return;
    input.placeholder = color;
    input.value = "";
    menu.hidden = true;
  });
  assert.equal((await page.run({ kind: "set-color", key, value: color })).status, "filled");
  assert.equal((await page.run({ kind: "inspect" })).rows[0].value, color);
  assert.equal((await page.run({ kind: "set-color", key, value: color })).status, "unchanged");
  assert.equal(wrongClicks, 0);
  page.close();
}

{
  const key = "productSkcList[0].mainSpec[0]";
  const page = fixture(`<div id="${key}">
    <div class="additional colour-spec-select_colorSpecSelect__test">
      <span data-testid="beast-core-popover-trigger-wrapper"><input placeholder="选择或自定义颜色" readonly></span>
    </div></div>
    <div data-testid="beast-core-portal" hidden>
      <div class="additional colour-spec-select_searchContainer__test">
        <input type="search"><div class="additional colour-spec-select_selectItem__test" hidden>花色</div>
        <div class="additional colour-spec-select_selectItem__test" hidden>花色条纹</div>
      </div>
    </div>`);
  const { doc } = page;
  const initial = doc.querySelector("input[readonly]");
  const trigger = initial.parentElement;
  const portal = doc.querySelector('[data-testid="beast-core-portal"]');
  const search = portal.querySelector("input");
  const options = portal.querySelectorAll('[class*="colour-spec-select_selectItem__"]');
  let opened = 0;
  let wrongClicks = 0;
  trigger.addEventListener("click", event => {
    if (event.target !== trigger) return;
    opened++;
    initial.replaceWith(initial.cloneNode(true));
    setTimeout(() => {
      portal.hidden = false;
      search.focus();
    }, 80);
  });
  search.addEventListener("input", () => {
    for (const option of options) option.hidden = search.value !== "花色";
  });
  options[0].addEventListener("click", () => {
    trigger.querySelector("input").placeholder = "花色";
    portal.hidden = true;
  });
  options[1].addEventListener("click", () => { wrongClicks++; });
  const result = await page.run({ kind: "set-color", key, value: "花色" });
  assert.equal(result.status, "filled", result.message);
  assert.equal(result.value, "花色");
  assert.equal(search.value, "花色");
  assert.equal(opened, 1);
  assert.equal(wrongClicks, 0);
  assert.equal(initial.isConnected, false);
  page.close();
}

{
  const key = "productSkcList[0].mainSpec[0]";
  const page = fixture(`<div id="${key}">
    <div class="colour-spec-select_colorSpecSelect__test">
      <span data-testid="beast-core-popover-trigger-wrapper"><input placeholder="选择或自定义颜色"></span>
    </div></div>
    <div data-testid="beast-core-portal"><div class="PP_popoverContent_test">
      <div class="colour-spec-select_allItemContainer__test" id="all-colors" hidden>
        <div class="colour-spec-select_leftContainer__test"><div class="colour-spec-select_groupItem__test">黑色</div></div>
      </div>
      <div class="colour-spec-select_searchContainer__test" id="alternate-colors" hidden>
        <div class="colour-spec-select_selectItem__test">黑色</div>
      </div>
    </div></div>`);
  const input = page.doc.querySelector("input");
  const allItems = page.doc.getElementById("all-colors");
  const menu = page.doc.getElementById("alternate-colors");
  const option = menu.firstElementChild;
  let groupClicks = 0;
  allItems.querySelector('[class*="colour-spec-select_groupItem__"]').addEventListener("click", () => { groupClicks++; });
  input.addEventListener("focus", () => { allItems.hidden = false; });
  input.addEventListener("input", () => {
    if (allItems.hidden || input.value !== "黑色") return;
    allItems.hidden = true;
    menu.hidden = false;
  });
  option.addEventListener("click", () => {
    menu.hidden = true;
    input.value = "";
    input.placeholder = "黑色";
  });
  const result = await page.run({ kind: "set-color", key, value: "B - Black", alternate: "黑色" });
  assert.equal(result.value, "黑色");
  assert.equal(result.status, "filled");
  assert.equal(groupClicks, 0);
  assert.equal(input.value, "");
  page.close();
}

{
  const page = fixture(`<div class="product-skc_specItem__size">
    <div data-testid="beast-core-form-item">
      <label>尺码</label>
      <div class="ST_head_test">
        <input placeholder="请选择" readonly>
      </div>
    </div>
  </div>`);
  const { doc } = page;
  const sizeSection = doc.querySelector(".product-skc_specItem__size");
  const input = sizeSection.querySelector("input");
  const head = sizeSection.querySelector(".ST_head_test");
  head.addEventListener("click", () => {
    sizeSection.insertAdjacentHTML("beforeend", '<div role="listbox"><div role="option">亚洲尺码</div><div role="option">欧美尺码</div></div>');
    const list = sizeSection.querySelector('[role="listbox"]');
    list.lastElementChild.addEventListener("click", () => {
      input.placeholder = "欧美尺码";
      list.remove();
      sizeSection.insertAdjacentHTML("beforeend", '<label><input type="checkbox">XS</label><label><input type="checkbox">M</label>');
    });
  });
  const result = await page.run({ kind: "set-sizes", value: { system: "欧美尺码", sizes: ["Medium"] } });
  assert.equal(result.status, "verified");
  assert.equal(sizeSection.querySelectorAll('input[type="checkbox"]')[1].checked, true);
  assert.equal(sizeSection.querySelectorAll('input[type="checkbox"]')[0].checked, false);
  page.close();
}

console.log("Temu apparel verifies selected colors and maps sizes against visible exact labels and unique aliases.");

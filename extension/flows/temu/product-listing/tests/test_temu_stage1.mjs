import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { isTemuCategoryPage, temuStagePage } from "../stage1.js";

const category = "https://agentseller.temu.com/goods/create/category";
const editor = "https://agentseller.temu.com/goods/edit?productDraftId=42";
const header = 'data-testid="beast-core-select-header"';

function page(url, markup) {
  const dom = new JSDOM(markup, { url, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getClientRects = function () { return this.closest("[hidden]") ? [] : [{}]; };
  const document = dom.window.document;
  return {
    document,
    run: request => dom.window.eval(`(${temuStagePage.toString()})(${JSON.stringify({ expectedHref: url, ...request })})`),
    close: () => dom.window.close(),
  };
}

function dropdown(input, names, onSelect, { closeDelay = 0 } = {}) {
  const head = input.parentElement;
  head.addEventListener("click", () => {
    const existingId = input.getAttribute("aria-controls");
    const existing = existingId && input.ownerDocument.getElementById(existingId);
    if (existing) { existing.remove(); return; }
    const menu = input.ownerDocument.createElement("div");
    menu.id = head.id + "-popup";
    menu.setAttribute("role", "listbox");
    input.setAttribute("aria-controls", menu.id);
    for (const [label, disabled] of names) {
      const option = input.ownerDocument.createElement("div");
      option.setAttribute("role", "option");
      if (disabled) option.setAttribute("aria-disabled", "true");
      option.textContent = label;
      option.onclick = () => {
        assert.equal(disabled, undefined, "disabled choices must not be clicked");
        input.value = label;
        onSelect?.(label);
        if (closeDelay) setTimeout(() => menu.remove(), closeDelay);
        else menu.remove();
      };
      menu.append(option);
    }
    input.ownerDocument.body.append(menu);
  });
}

{
  assert.equal(isTemuCategoryPage(category), true);
  assert.equal(isTemuCategoryPage(category.replace("://", "://untrusted@")), false);
  const fixture = page(category, `
    <section id="site"><label>* 经营站点</label></section>
    <ul id="categories"><li><input placeholder="搜索类目"><div>服装</div></li></ul>
    <ul hidden id="child"><li><input placeholder="搜索类目"><div>夹克</div></li></ul>
    <div id="path"></div><div id="picked"></div>
    <button type="button">下一步</button>`);
  const { document } = fixture;
  document.querySelector("#categories li div").onclick = () => { document.querySelector("#child").hidden = false; };
  document.querySelector("#child li div").onclick = () => {
    document.querySelector("#path").innerHTML = "<span>&gt;服装</span><span>&gt;夹克</span>";
    document.querySelector("#picked").textContent = "已选分类：夹克";
  };
  setTimeout(() => {
    document.querySelector("#site").insertAdjacentHTML("beforeend", `<div id="site-field" ${header}><input placeholder="请选择"></div>`);
    dropdown(document.querySelector("#site input"), [["美国站"], ["英国站", true]]);
  }, 80);
  const request = { siteId: "美国站", category: ["服装", "夹克"] };
  const selected = await fixture.run({ ...request, kind: "select" });
  assert.equal(selected.ok, true, selected.message);
  let advances = 0;
  document.querySelector("button").onclick = () => { advances++; };
  assert.equal((await fixture.run({ ...request, kind: "next" })).ok, true);
  assert.equal(advances, 1);
  assert.equal((await fixture.run({ ...request, kind: "next", category: ["宠物用品", "夹克"] })).ok, false);
  assert.equal(advances, 1);
  fixture.close();
}

{
  const fixture = page(editor, `
    <main id="productOriginCode"><label><span>* 商品产地</span></label>
      <div id="country" ${header}><input placeholder="请选择"></div>
      <div hidden id="region" ${header}><input placeholder="请选择省份"></div>
    </main><div id="country-popup" role="listbox" hidden><div role="option">中国大陆</div></div>`);
  const { document } = fixture;
  const country = document.querySelector("#country input");
  const province = document.querySelector("#region input");
  const menu = document.querySelector("#country-popup");
  const title = document.querySelector("main label span");
  let countryChoices = 0;
  let clickAway = 0;
  country.setAttribute("aria-controls", menu.id);
  country.parentElement.addEventListener("click", () => { menu.hidden = false; });
  menu.querySelector("[role=option]").onclick = () => {
    countryChoices++;
    country.value = "中国大陆";
    province.parentElement.hidden = false;
  };
  title.addEventListener("mousedown", () => {
    clickAway++;
    menu.hidden = true;
  });
  dropdown(province, [["浙江"]]);
  const result = await fixture.run({ kind: "origin", origin: [["中国大陆"], ["浙江省"]] });
  assert.equal(result.ok, true, result.message);
  assert.equal(countryChoices, 1);
  assert.equal(clickAway, 1);
  assert.equal(province.value, "浙江");
  assert.equal(menu.hidden, true);
  menu.hidden = false;
  assert.equal((await fixture.run({ kind: "origin", origin: [["中国大陆"], ["浙江省"]] })).ok, true);
  assert.equal(menu.hidden, true);
  assert.equal(countryChoices, 1);
  assert.equal(clickAway, 2);
  fixture.close();
}

{
  const fixture = page(editor, `
    <main id="productOriginCode"><label>商品产地</label>
      <div id="country" ${header}><input placeholder="请选择"></div>
      <div hidden id="region" ${header}><input placeholder="请选择省份"></div>
    </main>
    <div id="elsewhere"><input placeholder="请选择省份"></div>`);
  const { document } = fixture;
  const request = { kind: "origin", origin: [["中国大陆"], ["浙江省"]] };
  const country = document.querySelector("#country input");
  const region = document.querySelector("#region input");
  dropdown(country, [["中国大陆"]], () => { region.parentElement.hidden = false; }, { closeDelay: 120 });
  dropdown(region, [["浙江", true], ["浙江"], ["广东"]]);
  const selected = await fixture.run(request);
  assert.equal(selected.ok, true, selected.message);
  assert.equal(country.value, "中国大陆");
  assert.equal(region.value, "浙江");
  assert.equal(document.querySelector("#elsewhere input").value, "");
  assert.equal(document.querySelector('[role="listbox"]'), null);
  fixture.close();
}

{
  const fixture = page(editor, `
    <main id="productOriginCode"><label>商品产地</label>
      <div id="country" ${header}><input placeholder="请选择"></div>
    </main>
    <div role="listbox" id="unrelated"><div role="option">中国大陆</div></div>`);
  const { document } = fixture;
  let unrelated = 0;
  document.querySelector("#unrelated [role=option]").onclick = () => { unrelated++; };
  const selected = await fixture.run({ kind: "origin", origin: [["中国大陆"]] });
  assert.equal(selected.ok, false);
  assert.match(selected.message, /下拉/);
  assert.equal(unrelated, 0);
  assert.equal(document.querySelector("#country input").value, "");
  fixture.close();
}

console.log("Temu stage one hydration, category commitment and origin control ownership verified.");

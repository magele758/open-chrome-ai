import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { sheinEditorPage } from "../editor-page.js";

const href = "https://sellerhub.shein.com/#/spmp/commoditiesInfo?mode=add&last_page=page_commodities_category";
const categoryPath = ["家居&生活", "厨房&餐厅", "饮具", "真空瓶和保温杯"];

function fixture(t) {
  const dom = new JSDOM(`<main>
    <h1>发布商品</h1>
    <div class="spmp_style__commodityCategoryItem--test"><span class="spmp_style__categoryInfo--test"></span></div>
    <input placeholder="请输入关键字">
    <div class="so-form-item main_name"><input placeholder="最多输入250个字符"></div>
    <div class="so-form-item main_desc"><textarea placeholder="最多输入5000个字符"></textarea></div>
    <div class="so-form-item supplier_code"><input placeholder="此商家自用编码，可自行编码输入"></div>
    <div class="item productAttrItem--hash soui-form-item-wrapper soui-form-item-wrapper-required">
      <div class="soui-form-item-label-wrapper">产品型号 <span>Product Model</span></div>
      <div class="soui-form-item-control"><input type="text"></div>
    </div>
    <div class="item productAttrItem--hash soui-form-item-wrapper soui-form-item-wrapper-required">
      <div class="soui-form-item-label-wrapper">产品功能 <span>Product Features</span></div>
      <div class="soui-form-item-control"><div id="features" class="soui-select soui-select-multiple soui-select-wrapper-empty">
        <div class="soui-select-result-wrapper"><div class="soui-select-result"><input type="text"></div></div>
      </div></div>
    </div>
    <div class="spmp_style__specContentRow--test"></div>
    <div class="so-form-item publish_site"><label><input type="checkbox">美国站</label></div>
    <button id="publish">发布商品</button><button id="save">保存草稿</button>
  </main>`, { url: href, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { document, HTMLElement } = dom.window;
  document.querySelector('[class*="spmp_style__categoryInfo--"]').textContent = categoryPath.join(">");
  HTMLElement.prototype.getClientRects = function () {
    return this.closest('[hidden]') ? [] : [{ left: 1, top: 1, width: 50, height: 10 }];
  };
  let publications = 0;
  let saves = 0;
  let selectClicks = 0;
  const received = [];
  const searchQueries = [];
  document.querySelector("#publish").onclick = () => publications++;
  document.querySelector("#save").onclick = () => saves++;
  document.querySelector(".main_name input").oninput = ev => received.push(ev.target.value);
  function setOptions(names, { commit = true, searchResults, debounce = 250 } = {}) {
    const select = document.querySelector("#features");
    const opener = select.querySelector(".soui-select-result-wrapper");
    const display = select.querySelector(".soui-select-result");
    const search = display.querySelector("input");
    let menu;
    let searchTimer;
    function render(visibleNames) {
      if (!menu?.isConnected) return;
      menu.querySelector("ul").replaceChildren(...visibleNames.map(name => {
        const row = Object.assign(document.createElement("li"), { className: "soui-select-option" });
        row.innerHTML = '<div class="soui-select-option-inner"><div class="attrValRenderItem--test"></div></div>';
        const title = row.querySelector('[class*="attrValRenderItem--"]');
        const bilingual = /^(.*\p{Script=Han})(\s+[A-Za-z].*)$/u.exec(name);
        title.textContent = bilingual?.[1] ?? name;
        if (bilingual) title.append(Object.assign(document.createElement('span'), {
          className: "attrValRenderItemEnText--test", textContent: bilingual[2],
        }));
        row.onclick = () => {
          selectClicks++;
          if (!commit) return;
          const chip = document.createElement("span");
          chip.className = "soui-select-multiple-result-item";
          chip.textContent = name;
          display.prepend(chip);
          select.classList.remove("soui-select-wrapper-empty");
          if (searchResults) {
            clearTimeout(searchTimer);
            search.value = "";
            render(names);
          }
        };
        return row;
      }));
    }
    if (searchResults) search.oninput = () => {
      const term = search.value;
      searchQueries.push(term);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => render(term ? searchResults[term] ?? [] : names), debounce);
    };
    opener.onclick = () => {
      if (menu?.isConnected) {
        clearTimeout(searchTimer);
        search.value = "";
        menu.remove();
        return;
      }
      menu = document.createElement("div");
      menu.className = "soui-select-picker-wrapper merchant-ui-select-options";
      menu.style.opacity = "0";
      menu.innerHTML = '<div class="soui-select-list"><ul class="soui-select-virtual-list"><li class="soui-select-option">旧菜单</li></ul></div>';
      document.body.append(menu);
      setTimeout(() => {
        menu.style.opacity = "1";
        render(names);
      }, 70);
    };
  }
  const run = async args => {
    const result = await dom.window.eval(`(${sheinEditorPage})(${JSON.stringify({ href, ...args,
      input: { categoryPath, ...args?.input } })})`);
    return JSON.parse(JSON.stringify(result));
  };
  return { run, document, setOptions, received, searchQueries, publications: () => publications, saves: () => saves, selectClicks: () => selectClicks };
}

test("fills English copy and live bilingual attributes and verifies selected chips", async t => {
  const { run, document, setOptions, received, publications, saves, selectClicks } = fixture(t);
  assert.deepEqual((await run()).fields.map(field => field.key), ["englishTitle", "englishDescription", "sellerSku",
    "attribute:产品型号 Product Model", "attribute:产品功能 Product Features"]);
  setOptions(["防漏", "保温", "便携"]);
  const result = await run({ kind: "fill", input: { englishTitle: "Steel Travel Tumbler", englishDescription: "Travel mug.", sellerSku: "SKU-01",
    attributes: { 产品型号: "T-01", "Product Features": ["保温", "便携"] } } });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.fields.at(-1).value, ["便携", "保温"]);
  assert.equal(result.items.length, 5);
  assert.deepEqual(received, ["Steel Travel Tumbler"]);
  assert.equal(document.querySelector('input[placeholder="请输入关键字"]').value, "");
  assert.equal(selectClicks(), 2);
  assert.equal(publications() + saves(), 0);
});

test("reports ambiguous options, missing required and oversized inputs", async t => {
  const { run, setOptions, selectClicks } = fixture(t);
  setOptions(["防漏", "防漏"]);
  const result = await run({ kind: "fill", input: { englishTitle: "x".repeat(251), attributes: { 产品功能: ["防漏"] } } });
  assert.equal(selectClicks(), 0);
  assert.deepEqual(result.issues.map(issue => issue.code), ["VALUE_TOO_LONG", "OPTION_AMBIGUOUS", "VALUE_REQUIRED", "VALUE_REQUIRED"]);
});

test("resolves the whole multiselect request before making changes", async t => {
  const { run, setOptions, selectClicks } = fixture(t);
  setOptions(["保温 Insulated", "防漏 Leakproof"]);
  const result = await run({ kind: "fill", input: { attributes: { 产品功能: ["保温", "不存在"] } } });
  assert.ok(result.issues.some(issue => issue.code === "OPTION_MISSING"));
  assert.equal(selectClicks(), 0);
  const first = await run({ kind: "fill", input: { attributes: { 产品功能: ["保温"] } } });
  assert.deepEqual(first.fields.at(-1).value, ["保温 Insulated"]);
  const next = await run({ kind: "fill", input: { attributes: { 产品功能: ["保温", "Leakproof"] } } });
  assert.deepEqual(next.fields.at(-1).value, ["防漏 Leakproof", "保温 Insulated"]);
  assert.equal(selectClicks(), 2);
});

test("resolves separately rendered English labels when the localized label starts with Latin text", async t => {
  const { run, setOptions, selectClicks } = fixture(t);
  setOptions(["Wi-Fi 功能 WiFi Function", "无 None"]);
  const result = await run({ kind: "fill", input: { attributes: { 产品功能: "WiFi Function" } } });
  assert.deepEqual(result.fields.at(-1).value, ["Wi-Fi 功能 WiFi Function"]);
  assert.equal(selectClicks(), 1);
});

test("searches the bound food-contact attribute for a delayed exact result outside the initial menu", async t => {
  const { run, document, setOptions, searchQueries, selectClicks, publications, saves } = fixture(t);
  const select = document.querySelector("#features");
  select.closest(".soui-form-item-wrapper").querySelector(".soui-form-item-label-wrapper").innerHTML =
    "食品接触面材质 <span>Food Contact Materials</span>";
  select.querySelector("input").removeAttribute("type");
  const siteSearch = document.querySelector('input[placeholder="请输入关键字"]');
  siteSearch.value = "保留全站搜索内容";
  setOptions(["塑料 Plastic"], { searchResults: {
    "纯金属": ["纯金属复合材料 Metal Composite", "纯金属 Pure Metal"],
  } });

  const result = await run({ kind: "fill", input: { attributes: { 食品接触面材质: ["纯金属"] } } });
  assert.deepEqual(result.fields.at(-1).value, ["纯金属 Pure Metal"]);
  assert.ok(result.items.some(item => item.label === "食品接触面材质 Food Contact Materials"));
  assert.ok(searchQueries.includes("纯金属"));
  assert.equal(siteSearch.value, "保留全站搜索内容");
  assert.equal(selectClicks(), 1);
  assert.equal(publications() + saves(), 0);
});

test("preflights searchable multiselect values before clicking and retains chips when results reset", async t => {
  const { run, setOptions, searchQueries, selectClicks } = fixture(t);
  setOptions(["塑料 Plastic"], { searchResults: {
    "纯金属": ["纯金属 Pure Metal"],
    "陶瓷": ["陶瓷 Ceramic"],
  } });
  const fill = values => run({ kind: "fill", input: { attributes: { 产品功能: values } } });
  assert.deepEqual((await fill(["塑料"])).fields.at(-1).value, ["塑料 Plastic"]);
  assert.equal(selectClicks(), 1);

  const failed = await fill(["塑料", "纯金属", "不存在"]);
  assert.ok(failed.issues.some(issue => issue.code === "OPTION_MISSING"));
  assert.deepEqual(failed.fields.at(-1).value, ["塑料 Plastic"]);
  assert.equal(selectClicks(), 1);

  const result = await fill(["塑料", "纯金属", "陶瓷"]);
  assert.deepEqual(new Set(result.fields.at(-1).value), new Set(["塑料 Plastic", "纯金属 Pure Metal", "陶瓷 Ceramic"]));
  assert.ok(searchQueries.includes("纯金属") && searchQueries.includes("陶瓷"));
  assert.equal(selectClicks(), 3);
});

test("does not count a choice without actual readback", async t => {
  const { run, setOptions, selectClicks } = fixture(t);
  setOptions(["保温"], { commit: false });
  const result = await run({ kind: "fill", input: { attributes: { 产品功能: "保温" } } });
  assert.equal(selectClicks(), 1);
  assert.ok(result.issues.some(issue => issue.code === "VALUE_UNVERIFIED"));
  assert.deepEqual(result.items, []);
});

test("leaves a changed or blocked page untouched", async t => {
  const { run, document, received } = fixture(t);
  assert.deepEqual((await run()).categoryPath, categoryPath);
  assert.equal((await run({ kind: "fill", input: { categoryPath: [], englishTitle: "Do not write" } })).code, "CATEGORY_CHANGED");
  assert.equal((await run({ kind: "fill", input: { categoryPath: ["另外的类目"], englishTitle: "Do not write" } })).code, "CATEGORY_CHANGED");
  assert.equal((await run({ href: href.replace("mode=add", "mode=edit") })).code, "PAGE_CHANGED");
  const dialog = document.createElement("div");
  dialog.setAttribute("aria-modal", "true");
  document.body.append(dialog);
  assert.equal((await run({ kind: "fill", input: { englishTitle: "Do not write" } })).code, "MODAL_BLOCKED");
  assert.deepEqual(received, []);
});

test("waits for linked controls, accepts visually hidden checkboxes and closes only the listing tip", async t => {
  const { run, document, received } = fixture(t);
  const sites = document.querySelector(".publish_site");
  sites.hidden = true;
  assert.equal((await run({ kind: "fill", input: { englishTitle: "Pending" } })).code, "EDITOR_NOT_READY");
  assert.deepEqual(received, []);
  sites.hidden = false;
  sites.querySelector("input").hidden = true;
  const tip = document.createElement("div");
  tip.innerHTML = '<div>建议完善尺码数据</div><button>关闭</button>';
  const unrelated = document.createElement("button");
  unrelated.textContent = "关闭";
  document.querySelector("main").append(tip, unrelated);
  let dismissed = 0;
  tip.querySelector("button").onclick = () => { dismissed++; tip.remove(); };
  unrelated.onclick = () => { dismissed += 10; };
  assert.equal((await run({ kind: "fill", input: { englishTitle: "Ready" } })).ok, true);
  assert.equal(dismissed, 1);
  assert.deepEqual(received, ["Ready"]);
});

test("expands the product attribute group and reads required labels without validation errors", async t => {
  const { run, document, publications, saves } = fixture(t);
  const header = document.createElement("div");
  header.className = "shein-components_soc-fe-sso-sdk_userInfo";
  header.innerHTML = '<span class="shein-components_soc-fe-sso-sdk_companyName">GS12345678</span>';
  document.querySelector("main").prepend(header);
  const group = document.createElement("section");
  const attribute = document.querySelector("#features").closest(".productAttrItem--hash");
  attribute.classList.remove("soui-form-item-wrapper-required");
  const heading = attribute.querySelector(".soui-form-item-label-wrapper");
  heading.insertAdjacentHTML("afterbegin", '<i aria-hidden="true" style="color: rgb(235, 30, 30)">*</i>');
  attribute.before(group);
  group.append(attribute);
  const toggle = document.createElement("div");
  toggle.innerHTML = '<span>展开所有属性</span>';
  group.append(toggle);
  const outside = document.createElement("button");
  outside.textContent = "展开所有属性";
  document.querySelector("main").append(outside);
  let expansions = 0;
  outside.onclick = () => { expansions += 10; };
  toggle.onclick = () => {
    expansions++;
    toggle.textContent = "收起所有属性";
    setTimeout(() => toggle.insertAdjacentHTML("beforebegin", `
      <div class="productAttrItem--test soui-form-item-wrapper">
        <label class="soui-form-item-label-wrapper">材质 Material</label><input>
      </div>
      <div class="productAttrItem--test soui-form-item-wrapper">
        <label class="soui-form-item-label-wrapper pseudo-star">连接方式 Connectivity Technology</label><input>
      </div>
      <div class="productAttrItem--test soui-form-item-wrapper">
        <label class="soui-form-item-label-wrapper">键数 Keys Qty</label><input aria-required="true">
      </div>
      <div class="productAttrItem--test soui-form-item-wrapper soui-form-item-wrapper-hide-required">
        <label class="soui-form-item-label-wrapper pseudo-star">键盘类型 Keyboard Types</label><input>
      </div>
      <div class="productAttrItem--test soui-form-item-wrapper">
        <label class="soui-form-item-label-wrapper pseudo-star pseudo-hidden">协议 Protocol</label><input>
      </div>
      <div class="productAttrItem--test soui-form-item-wrapper soui-form-item-wrapper-hide-required">
        <label class="soui-form-item-label-wrapper">原生必填 Native Required</label><input required>
      </div>`), 55);
  };
  const win = document.defaultView;
  const styles = win.getComputedStyle.bind(win);
  win.CSS = { supports: () => true };
  win.getComputedStyle = (node, pseudo) => pseudo ? node.classList.contains("pseudo-star") && pseudo === "::before"
    ? { content: '"*"', color: "rgb(230, 40, 40)", display: node.classList.contains("pseudo-hidden") ? "none" : "inline" }
    : { content: "none", color: "rgb(0, 0, 0)" } : styles(node);

  const result = await run({ kind: "review" });
  const byName = Object.fromEntries(result.fields.map(field => [field.label, field]));
  assert.equal(expansions, 1);
  assert.equal(result.storeKey, "GS12345678");
  assert.equal(byName["产品功能 Product Features"].required, true);
  assert.equal(byName["产品功能 Product Features"].error, undefined);
  assert.equal(byName["连接方式 Connectivity Technology"].required, true);
  assert.equal(byName["键数 Keys Qty"].required, true);
  assert.equal(byName["材质 Material"].required, false);
  assert.equal(byName["键盘类型 Keyboard Types"].required, false);
  assert.equal(byName["协议 Protocol"].required, false);
  assert.equal(byName["原生必填 Native Required"].required, true);
  assert.equal(publications() + saves(), 0);
});

test("repairs empty optional fields and preserves valid values already entered", async t => {
  const { run, document, setOptions } = fixture(t);
  const section = document.querySelector("#features").closest(".productAttrItem--hash");
  section.classList.remove("soui-form-item-wrapper-required");
  section.querySelector(".soui-form-item-label-wrapper").textContent = "连接方式 Connectivity Technology";
  setOptions(["有线 Wired", "无线 Wireless"]);
  const description = document.querySelector(".main_desc textarea");
  description.value = "已有描述";
  const repaired = await run({ kind: "repair", input: { values: {
    "attribute:连接方式 Connectivity Technology": ["有线 Wired"], englishDescription: "另一个描述",
  } } });
  assert.deepEqual(repaired.fields.at(-1).value, ["有线 Wired"]);
  assert.equal(repaired.fields.at(-1).required, false);
  assert.equal(description.value, "已有描述");
  assert.equal(repaired.items.length, 1);
});

test("separates same-name product fields using stable controls and never guesses a label binding", async t => {
  const { run, document } = fixture(t);
  const first = document.querySelector(".productAttrItem--hash");
  const second = first.cloneNode(true);
  first.dataset.attrId = "base-model";
  second.dataset.attrId = "variant-model";
  first.after(second);
  const snapshot = await run();
  const modelKeys = snapshot.fields.filter(field => field.label === "产品型号 Product Model").map(field => field.key);
  assert.deepEqual(modelKeys, ["attribute:产品型号 Product Model [base-model]", "attribute:产品型号 Product Model [variant-model]"]);
  await run({ kind: "fill", input: { attributes: { 产品型号: "AMBIGUOUS" } } });
  const intended = await run({ kind: "repair", input: { values: { [modelKeys[1]]: "VARIANT" } } });
  assert.equal(intended.fields.find(field => field.key === modelKeys[0]).value, "");
  assert.equal(intended.fields.find(field => field.key === modelKeys[1]).value, "VARIANT");
});

test("requires distinct source names when two bilingual controls share a translated label", async t => {
  const { run, document } = fixture(t);
  const first = document.querySelector(".productAttrItem--hash");
  const second = first.cloneNode(true);
  first.querySelector(".soui-form-item-label-wrapper").textContent = "连接方式 Connectivity Technology";
  second.querySelector(".soui-form-item-label-wrapper").textContent = "连接方式 Connection Method";
  first.after(second);

  await run({ kind: "fill", input: { attributes: { 连接方式: "有线" } } });
  assert.equal(first.querySelector("input").value, "");
  assert.equal(second.querySelector("input").value, "");
  await run({ kind: "fill", input: { attributes: {
    连接方式: "通用值", "连接方式 Connectivity Technology": "有线", "Connection Method": "USB-C",
  } } });
  assert.equal(first.querySelector("input").value, "有线");
  assert.equal(second.querySelector("input").value, "USB-C");
});

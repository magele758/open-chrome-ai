import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createTemuOptionCache } from "../attribute-cache.js";
import { temuControls } from "../controls.js";
import { normalizeTemuListingInput, readTemuAttributeValue, suggestTemuFields } from "../input.js";

test("resolves bilingual attribute aliases and declared keys without using ambiguous source values", async () => {
  const product = normalizeTemuListingInput({
    title: "Striped shirt",
    manufacturerSuggestedRetailPrice: "25.75",
    packageContents: "1",
    sourcePrice: { amount: "9.49", currency: "USD" },
    attributes: { "Fabric Type": "95% Polyester, 5% Spandex", 衣领: "圆领", 保养说明: "机洗", 袖子长度: "短袖" },
    temu: { attributes: { "productProperties[22]": "聚酯纤维", 品牌: "A brand", Brand: "Conflicting brand" } },
    skus: [{ id: "one", options: { Size: "S" }, packageContents: "2" }],
  });
  const collar = { key: "productProperties[64]", label: "领型 Collar Style", kind: "select",
    options: [{ value: "crew", label: "圆领 Crew Neck", aliases: ["圆领", "Crew Neck"] }] };
  assert.equal(readTemuAttributeValue(product, collar), "圆领");
  assert.equal(readTemuAttributeValue(product, { key: "productProperties[22]", label: "材质 Material" }), "聚酯纤维");
  assert.equal(readTemuAttributeValue(product, { label: "护理说明 Operation Instruction" }), "机洗");
  assert.equal(readTemuAttributeValue(product, { label: "袖长 Sleeve Length" }), "短袖");
  assert.equal(readTemuAttributeValue(product, { label: "品牌名 Brand" }), undefined);
  assert.equal(readTemuAttributeValue(product, { label: "印花类型 Printing Type" }), undefined);
  assert.deepEqual(product.composition, [{ material: "Polyester", percent: "95" }, { material: "Spandex", percent: "5" }]);
  assert.equal(product.price, undefined);
  assert.equal(product.retailPrice, "25.75");
  assert.equal(product.skus[0].retailPrice, "25.75");
  assert.equal(product.skus[0].packageContents, "2");
  assert.deepEqual((await suggestTemuFields(product, { fields: [collar] }, { useModel: false })).values, { [collar.key]: "crew" });
  assert.equal(normalizeTemuListingInput({ title: "Incomplete shirt", attributes: { Composition: "95% polyester" } }).composition, undefined);
});

test("only retains directory-validated shared and per-variant gallery paths", () => {
  const product = normalizeTemuListingInput({
    title: "Shirt",
    temu: { sharedGalleryImages: ["/items/shirt/detail.jpg", "/items/other/other.jpg"] },
    variantGroups: [{ name: "Color", options: [
      { value: "Blue", imagePath: "/items/shirt/blue.jpg", galleryImages: ["/items/shirt/material.jpg", "/items/shirt/../private.jpg"] },
      { value: "Orange", imagePath: "/items/shirt/orange.jpg" },
    ] }],
  }, { root: "/items", folder: "shirt" });
  assert.deepEqual(product.sharedGalleryImages, ["/items/shirt/detail.jpg"]);
  assert.deepEqual(product.variantGroups[0].options[0].galleryImages, ["/items/shirt/material.jpg"]);
  assert.equal(product.variantGroups[0].options[1].galleryImages, undefined);
  assert.deepEqual(product.variantImages, ["/items/shirt/detail.jpg", "/items/shirt/blue.jpg", "/items/shirt/material.jpg", "/items/shirt/orange.jpg"]);
});

test("identifies required attributes from their own group inside a shared form item", async t => {
  const href = "https://agentseller.temu.com/goods/edit?productDraftId=required";
  const dom = new JSDOM(`<main id="page_container_id"><div data-testid="beast-core-form-item">
    <div id="productProperties[25]"><div><span aria-hidden="true" class="Form_itemLabelRequired_test">*</span>
    <span class="Form_itemLabelContent_test">细节 Details</span></div>
    <div class="ST_outerWrapper_test"><div class="ST_head_test"><input readonly></div></div></div>
    <div id="productProperties[28]"><span class="Form_itemLabelContent_test">袖型 Sleeve Type</span>
    <div class="ST_outerWrapper_test"><div class="ST_head_test"><input readonly>
    <span class="ST_selectValue_test">帽袖</span></div></div></div>
    </div></main>`, { url: href, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  dom.window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  const run = request => dom.window.eval(`(${temuControls.toString()})(${JSON.stringify({ ...request, scope: { href } })})`);
  const result = await run({ kind: "inspect" });
  assert.deepEqual(JSON.parse(JSON.stringify(result.fields.map(({ label, required, value }) => [label, required, value]))),
    [["细节 Details", true, ""], ["袖型 Sleeve Type", false, "帽袖"]]);
});

test("searches the active form control, waits for filtered options, and verifies the exact selection", async t => {
  const href = "https://agentseller.temu.com/goods/edit?productDraftId=test";
  const dom = new JSDOM(`<main id="page_container_id"><div data-testid="beast-core-form-item">
    <label>材质 Material</label><div id="productProperties[22]">
    <div class="ST_outerWrapper_test"><div class="ST_head_test"><input aria-controls="materials" readonly>
    <span class="ST_selectValueSingle_test"></span></div></div>
    </div></div></main><div data-testid="beast-core-portal" hidden>
    <input type="search"><div id="materials" role="listbox"></div>
    </div><div class="MDL_inner_unexpected" hidden>其他操作提示</div>`, { url: href, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  const document = window.document;
  const input = document.querySelector("main input");
  const search = document.querySelector('input[type="search"]');
  const menu = document.querySelector('[role="listbox"]');
  const portal = menu.parentElement;
  const overlay = document.querySelector(".MDL_inner_unexpected");
  const selection = document.querySelector('[class^="ST_selectValueSingle_"]');
  let clicks = 0;
  let dismissed = 0;
  let inputEvents = 0;
  let materialScrolled = false;
  menu.getBoundingClientRect = () => ({ height: 80, top: 100, bottom: 180 });
  function show(items) {
    menu.innerHTML = items.map(([id, name]) => `<div role="option" data-value="${id}">${name}</div>`).join("");
    const material = menu.querySelector('[data-value="temu-poly"]');
    if (material) {
      const name = document.createElement("span");
      name.className = "name-label_name__test";
      name.textContent = material.textContent;
      const translation = document.createElement("span");
      translation.className = "name-label_enName__test";
      translation.textContent = "Polyester";
      name.append(translation);
      material.replaceChildren(name);
      material.getBoundingClientRect = () => materialScrolled ? { height: 28, top: 130, bottom: 158 } : { height: 28, top: 220, bottom: 248 };
      material.scrollIntoView = () => { materialScrolled = true; };
    }
  }
  input.addEventListener("focus", () => {
    portal.hidden = false;
    search.value = "";
    show([["cotton", "棉 Cotton"]]);
  });
  document.querySelector("main label").addEventListener("mousedown", () => {
    dismissed++;
    portal.hidden = true;
  });
  search.addEventListener("input", () => {
    inputEvents++;
    if (search.value === "blocked") {
      window.setTimeout(() => { overlay.hidden = false; }, 40);
      return;
    }
    window.setTimeout(() => show(search.value.toLowerCase() === "polyester"
      ? [["temu-poly", "聚酯纤维(涤纶）Polyester"], ["temu-recycled-poly", "再生聚酯纤维 Recycled Polyester"]] : []), 210);
  });
  menu.addEventListener("click", event => {
    assert.equal(materialScrolled, true, "a clipped material option is revealed before selection");
    clicks++;
    selection.textContent = event.target.querySelector(".name-label_name__test")?.firstChild.textContent || event.target.textContent;
  });
  const run = request => window.eval(`(${temuControls.toString()})(${JSON.stringify({ ...request, scope: { href } })})`);
  const [field] = (await run({ kind: "inspect" })).fields;
  const probe = await run({ kind: "probe", query: "Polyester", field });
  assert.equal(probe.ok, true);
  assert.equal(probe.filtered, true);
  assert.ok(probe.options[0].aliases.includes("聚酯纤维"));
  assert.ok(probe.options[0].aliases.includes("Polyester"));
  assert.equal(clicks, 0);
  assert.equal(portal.hidden, true);
  assert.equal((await run({ kind: "select", value: "聚酯纤维", query: "Polyester", field })).status, "filled");
  assert.equal(clicks, 1);
  assert.equal(selection.textContent, "聚酯纤维(涤纶）Polyester");
  assert.equal(dismissed, 2);
  assert.equal(inputEvents, 2);
  assert.equal((await run({ kind: "select", value: "poly", field })).code, "OPTION_MISSING");
  assert.equal(clicks, 1);
  assert.equal((await run({ kind: "select", value: "blocked", field })).code, "PAGE_CHANGED");
  assert.equal(clicks, 1);
  assert.equal(dismissed, 3);
  assert.equal(overlay.hidden, false);
});

test("looks up Temu's local composition term for a sourced English fiber name", async t => {
  const href = "https://agentseller.temu.com/goods/edit?productDraftId=fiber";
  const dom = new JSDOM(`<main id="page_container_id"><div id="productProperties[15]"><table><tbody><tr><td>
    <div class="ST_outerWrapper_test"><div class="ST_head_test"><input placeholder="请选择" aria-controls="fibers" readonly>
    <span class="ST_selectValueSingle_test"></span></div></div></td><td><input placeholder="请输入"></td>
    </tr></tbody></table></div></main><div class="ST_dropdown_test" hidden>
    <input type="search"><div role="listbox" id="fibers"></div></div>`, { url: href, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  const { document } = window;
  const menu = document.getElementById("fibers");
  const dropdown = menu.parentElement;
  const search = dropdown.querySelector("input");
  const selection = document.querySelector('[class^="ST_selectValueSingle_"]');
  const queries = [];
  const clicks = [];
  document.querySelector('input[readonly]').addEventListener("focus", () => {
    dropdown.hidden = false;
    menu.innerHTML = '<div role="option" data-value="cotton">棉 Cotton</div>';
  });
  search.addEventListener("input", () => {
    queries.push(search.value);
    window.setTimeout(() => {
      menu.innerHTML = search.value === "氨纶" ?
        '<div role="option" data-value="fiber-4"><span class="name-label_name__test">氨纶<span class="name-label_enName__test">Spandex</span></span></div>' : "";
    }, 30);
  });
  menu.addEventListener("click", event => {
    clicks.push(event.target.dataset.value);
    selection.innerHTML = event.target.innerHTML;
    dropdown.hidden = true;
  });
  const run = request => window.eval(`(${temuControls.toString()})(${JSON.stringify({ ...request, scope: { href } })})`);
  const [field] = (await run({ kind: "inspect" })).fields;
  assert.equal(field.key, "composition-material-0");
  assert.equal((await run({ kind: "select", value: "Elastane", field })).status, "filled");
  assert.deepEqual(queries, ["Elastane", "氨纶"]);
  assert.deepEqual(clicks, ["fiber-4"]);
  assert.equal((await run({ kind: "inspect" })).fields[0].value, "氨纶");
});

test("resolves a full multiselect request before changing choices and verifies the selected chips", async t => {
  const href = "https://agentseller.temu.com/goods/edit?productDraftId=multiple";
  const dom = new JSDOM(`<main id="page_container_id"><div id="productProperties[51]">
    <label>季节Season</label>
    <div class="ST_outerWrapper_test"><div class="ST_head_test"><input aria-controls="seasons">
    <span class="ST_selectValueMultiple_test"></span></div></div>
    </div></main><div class="ST_dropdown_test" hidden>
    <div id="seasons" role="listbox" aria-multiselectable="true"></div></div>`, { url: href, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  const document = window.document;
  const input = document.querySelector("main input");
  const menu = document.querySelector('[role="listbox"]');
  const portal = menu.parentElement;
  const chips = document.querySelector('[class^="ST_selectValueMultiple_"]');
  const names = new Map([["spring", "春Spring"], ["summer", "夏Summer"], ["winter", "冬Winter"]]);
  const selected = new Set(["spring"]);
  let clicks = 0;
  let ignoreClick = false;
  function show(query) {
    const visibleOptions = query
      ? [...names].filter(([, label]) => label.toLowerCase().includes(query.toLowerCase())) : [["spring", names.get("spring")]];
    menu.innerHTML = visibleOptions.map(([id, label]) =>
      `<div data-testid="beast-core-select-option" data-value="${id}" aria-selected="${selected.has(id)}">${label}</div>`).join("");
    chips.innerHTML = [...selected].map(id => `<span class="ST_selectValueMultipleItem_test">${names.get(id)}</span>`).join("");
  }
  const open = () => {
    portal.hidden = false;
    input.value = "";
    show("");
  };
  input.addEventListener("focus", open);
  input.addEventListener("click", () => { if (portal.hidden) open(); });
  input.addEventListener("keydown", event => { if (event.key === "Escape") portal.hidden = true; });
  input.addEventListener("input", () => { window.setTimeout(() => show(input.value), 40); });
  menu.addEventListener("click", event => {
    clicks++;
    if (ignoreClick) return;
    const id = event.target.dataset.value;
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    show(input.value);
  });
  show("");
  const run = request => window.eval(`(${temuControls.toString()})(${JSON.stringify({ ...request, scope: { href } })})`);
  const [field] = (await run({ kind: "inspect" })).fields;
  assert.equal((await run({ kind: "select", value: ["Summer", "Unlisted"], field })).code, "OPTION_MISSING");
  assert.equal(clicks, 0);
  assert.equal((await run({ kind: "select", value: ["Winter", "夏季"], field })).status, "filled");
  assert.equal(clicks, 3);
  assert.deepEqual([...selected], ["winter", "summer"]);
  assert.equal(portal.hidden, true);
  ignoreClick = true;
  assert.equal((await run({ kind: "select", value: ["夏季"], field })).code, "READBACK_MISMATCH");
  assert.equal(clicks, 4, "a multiselect with unverified state never retries its toggle");
  assert.deepEqual([...selected], ["winter", "summer"]);
});

test("keeps similar bilingual fiber rows distinct and accepts an exact rendered name", async t => {
  const href = "https://agentseller.temu.com/goods/edit?productDraftId=duplicate-fibers";
  const dom = new JSDOM(`<main id="page_container_id"><div id="productProperties[15]"><table><tbody><tr><td>
    <div class="ST_outerWrapper_test"><div class="ST_head_test"><input placeholder="请选择" aria-controls="fibers" readonly>
    <span class="ST_selectValueSingle_test"></span></div></div></td><td><input placeholder="请输入"></td>
    </tr></tbody></table></div></main><div class="ST_dropdown_test" hidden><div role="listbox" id="fibers">
      <div role="option" data-value="p1"><span class="name-label_name__test">聚酯纤维(涤纶)Polyester<span class="name-label_enName__test">Polyester</span></span></div>
      <div role="option" data-value="p2">聚酯纤维(涤纶）Polyester</div>
    </div></div>`, { url: href, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { window } = dom;
  const { document } = window;
  window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  const menu = document.getElementById("fibers");
  const input = document.querySelector("input");
  const selected = [];
  const open = () => { menu.parentElement.hidden = false; };
  input.addEventListener("focus", open);
  input.addEventListener("click", open);
  input.addEventListener("keydown", event => { if (event.key === "Escape") menu.parentElement.hidden = true; });
  menu.addEventListener("click", event => {
    selected.push(event.target.dataset.value);
    document.querySelector(".ST_selectValueSingle_test").innerHTML = event.target.innerHTML;
    menu.parentElement.hidden = true;
  });
  const run = request => window.eval(`(${temuControls.toString()})(${JSON.stringify({ ...request, scope: { href } })})`);
  const [field] = (await run({ kind: "inspect" })).fields;
  const [first, second] = menu.children;
  const ambiguous = await run({ kind: "select", field, value: "Polyester" });
  assert.equal(ambiguous.code, "OPTION_AMBIGUOUS");
  assert.match(ambiguous.message, /\[p1\].*\[p2\]/u);
  assert.deepEqual(selected, []);
  assert.equal((await run({ kind: "select", field, value: first.textContent })).status, "filled");
  assert.deepEqual(selected, [first.dataset.value]);
  document.querySelector(".ST_selectValueSingle_test").replaceChildren();
  assert.equal((await run({ kind: "select", field, value: second.textContent })).status, "filled");
  assert.deepEqual(selected, [first.dataset.value, second.dataset.value]);
});

test("waits for the active menu and option to finish opening before clicking and verifies a delayed write", async t => {
  const href = "https://agentseller.temu.com/goods/edit?productDraftId=animated";
  const dom = new JSDOM(`<main id="page_container_id"><div id="productProperties[24]">
    <label>门襟类型Placket Type</label><div class="ST_outerWrapper_test"><div class="ST_head_test">
    <input aria-controls="plackets" readonly><span class="ST_selectValueSingle_test"></span></div></div>
    </div></main><div class="ST_dropdown_test" style="opacity:0;pointer-events:none">
    <div role="listbox" id="plackets"></div></div>`, { url: href, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  const { document } = window;
  const menu = document.getElementById("plackets");
  const shell = menu.parentElement;
  const selected = document.querySelector(".ST_selectValueSingle_test");
  let ready = false;
  let clicks = 0;
  menu.getBoundingClientRect = () => ({ left: 0, right: 200, top: 50, bottom: 220 });
  document.querySelector("input").addEventListener("focus", () => {
    shell.style.opacity = "0.4";
    menu.innerHTML = '<div role="option" data-value="pullovers" aria-selected="false" style="pointer-events:none">套头衫Pullovers</div>';
    menu.firstElementChild.getBoundingClientRect = () =>
      ({ left: 20, right: 180, top: ready ? 100 : 70, bottom: ready ? 120 : 90, width: 160, height: 20 });
    window.setTimeout(() => {
      shell.style.opacity = "1";
      shell.style.pointerEvents = "auto";
    }, 110);
    window.setTimeout(() => {
      ready = true;
      menu.firstElementChild.style.pointerEvents = "auto";
    }, 280);
  });
  document.elementFromPoint = () => ready ? menu.firstElementChild : null;
  menu.addEventListener("click", () => {
    clicks++;
    if (!ready) return;
    window.setTimeout(() => {
      selected.textContent = "套头衫";
      shell.style.opacity = "0";
      shell.style.pointerEvents = "none";
    }, 230);
  });
  const run = request => window.eval(`(${temuControls.toString()})(${JSON.stringify({ ...request, scope: { href } })})`);
  const [field] = (await run({ kind: "inspect" })).fields;
  assert.equal((await run({ kind: "select", field, value: "套头" })).status, "filled");
  assert.equal(clicks, 1);
  assert.equal(selected.textContent, "套头衫");
  assert.equal(shell.style.opacity, "0");
});

test("matches the compound Temu SKU option title and retries only a provably unapplied single click", async t => {
  const href = "https://agentseller.temu.com/goods/edit?productDraftId=retry";
  const dom = new JSDOM(`<main id="page_container_id"><div id="productSkuMap.red.productSkuMultiPack.skuClassification">
    <div class="ST_outerWrapper_test"><div class="ST_head_test">
    <input aria-controls="sku-menu" readonly><span class="ST_selectValueSingle_test"></span></div></div>
    </div></main><div class="ST_dropdown_test" hidden><div role="listbox" id="sku-menu">
    <div role="option" data-value="single" aria-selected="false">单品<div>仅1件商品 (如1个碗、1对耳环)</div></div>
    <div role="option" data-value="same" aria-selected="false">同款多件装<div>多件同规格同种类单品</div></div>
    </div></div>`, { url: href, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  const { document } = window;
  const menu = document.getElementById("sku-menu");
  const shell = menu.parentElement;
  const confirmed = [];
  document.querySelector("input").addEventListener("focus", () => { shell.hidden = false; });
  menu.addEventListener("click", event => {
    confirmed.push(event.target.dataset.value);
    if (confirmed.length !== 2) return;
    document.querySelector(".ST_selectValueSingle_test").textContent = "单品";
    shell.hidden = true;
  });
  const run = request => window.eval(`(${temuControls.toString()})(${JSON.stringify({ ...request, scope: { href } })})`);
  const [field] = (await run({ kind: "inspect" })).fields;
  assert.equal((await run({ kind: "select", field, value: "单品" })).status, "filled");
  assert.deepEqual(confirmed, ["single", "single"]);
});

test("caches category attribute observations only within a site and exact category path", async () => {
  const state = {};
  const storage = {
    async get() { return structuredClone(state); },
    async set(next) { Object.assign(state, structuredClone(next)); },
  };
  let time = 100;
  const cache = createTemuOptionCache({ storage, now: () => time });
  const field = { key: "productProperties[22]", label: "材质 Material" };
  const scope = { site: "US", categoryPath: ["Clothing", "Shirts"] };
  const options = [{ value: "polyester", label: "聚酯纤维 Polyester", aliases: ["Polyester"] }];
  const alternate = { ...field, key: "productProperties[23]" };
  await Promise.all([cache.write(scope, field, options), cache.write(scope, alternate, options)]);
  assert.deepEqual(await cache.read(scope, field), options);
  assert.deepEqual(await cache.read(scope, alternate), options);
  assert.equal(await cache.read({ ...scope, site: "CA" }, field), undefined);
  assert.equal(await cache.read({ ...scope, categoryPath: ["Fashion", "Shirts"] }, field), undefined);
  const template = { key: "freightTemplateId", label: "运费模板" };
  await cache.write(scope, template, options);
  await cache.write(scope, field, []);
  assert.equal(await cache.read(scope, template), undefined);
  assert.deepEqual(await cache.read(scope, field), options);
  time += 7 * 24 * 60 * 60_000;
  assert.equal(await cache.read(scope, field), undefined);
});

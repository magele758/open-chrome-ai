import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { runMxDraftReprice } from "../native/mx-ptc-reprice.mjs";
import { commerceScript, setDraftSkuPrice } from "./tiktok-mx-commerce.mjs";
import { sellerVerification } from "./tiktok-mx-editor.mjs";

const sourceId = "1738630710999877195";
const draftId = "1738630710999877196";
const link = `https://seller.tiktokshopglobalselling.com/product/edit-draft/${draftId}?shop_region=MX`;
const title = "Cuchilla para pan";
const baselinePricesMXN = [{ label: "Silver / 1 piece", priceMXN: 120 }, { label: "Dorado", priceMXN: 9.99 }];
const args = { sourceId, draftId, baselinePricesMXN, multiplier: 100 };
const longPriceScript = commerceScript(setDraftSkuPrice, "A".repeat(80), 120, 12000, true, { before: 75, after: 10 });
const guardLength = (`if(location.href!==${JSON.stringify(link)})throw Error('Wrong draft editor');` +
  sellerVerification.toString() + "\nif(sellerVerification())throw Error('Seller verification is required');").length;
assert.ok(guardLength + longPriceScript.length < 8000, "Long SKU labels must fit the guarded PageLens script");
const original = [
  { label: "Silver / 1 piece", option: "Plata / 1 pza", stock: 0, priceMXN: 120 },
  { label: "Gold", option: "Dorado", stock: 3, priceMXN: 9.99 },
];
const listing = { title, salesAndShipping: { skus: original.map(({ option, stock, priceMXN }) => ({ option, stock, priceMXN })),
  origins: { "Plata / 1 pza.stock": { kind: "estimated", basis: "fixture" } } } };
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pagelens-reprice-test-"));
const home = process.env.PAGELENS_HOME;
process.env.PAGELENS_HOME = tmp;
const listingFile = path.join(tmp, "listing.json");
const readJson = async file => JSON.parse(await fs.readFile(file, "utf8"));
await fs.writeFile(listingFile, JSON.stringify(listing));

function buildEditor(rows, documentEpoch) {
  const input = value => `<input role="spinbutton" value="${value}">`;
  const field = (id, value) => `<div data-id="product.publish.${id}">${value}</div>`;
  const attribute = (name, id, options) => `<section>${name}\n<div><div><div>
    <div role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}">
    <button class="core-select-view">${name}</button></div></div></div></div></section>
    <ul id="${id}" hidden>${options.map(([label, selected]) =>
      `<li role="option" aria-selected="${selected}">${label}</li>`).join("")}</ul>`;
  const metal = documentEpoch % 2 ? "Stainless steel\nAcero inoxidable" : "Acero inoxidable\nStainless steel";
  const dom = new JSDOM(`<body>
    <input data-id="product.publish.product_name" value="${title}">
    <input data-id="product.publish.title.input_lang" value="Bread lame">
    <div id="product-cascader-select-view">Cocina</div>
    ${field("description.local_lang", '<div class="ProseMirror">Cuchilla</div>')}
    <div data-id="product.widget.main_image.0"><img src="/test.jpg"></div>
    ${field("brand", '<span class="core-select-view-value">Marca</span>')}
    <div id="focus-status" role="combobox" aria-haspopup="dialog">Cargando ${documentEpoch}</div>
    ${attribute("Material", "material", [[metal, true], ["Plastic\nPlástico", false]])}
    ${attribute("Función", "function", [["Reusable\nReutilizable", persistedFunction]])}
    ${field("sale_property.name.1", '<span class="core-cascader-view-value">Color</span>')}
    ${rows.map(({ label, option }, id) => field("sale_property.value.name." + id,
      `<span class="pulse-input-tag-item">${label}</span><span class="pulse-input-tag-item">${option}</span>`)).join("")}
    ${showBatch ? field("skus.batch_edit", `全部\n${field("skus.batch_edit.price", input(""))}
      ${field("skus.batch_edit.stock", input(batchStock))}<button disabled>应用</button>`) : ""}
    <span class="text-critical-on-surface">价格不能超过1</span>
    <table>${rows.toReversed().map(({ label, stock, priceMXN }, id) => `<tr data-label="${label}"><td>${label}</td>
      <td>${field("skus.stock." + id, input(stock))}</td><td>${field("skus.sale_price." + id, input(priceMXN))}</td></tr>`).join("")}</table>
    <button id="draft">另存为草稿</button><button id="publish">提交</button></body>`, { url: link, runScripts: "outside-only" });
  const win = dom.window;
  Object.defineProperty(win.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
  Object.defineProperty(win.performance, "timeOrigin", { value: documentEpoch });
  win.HTMLElement.prototype.scrollIntoView = () => {};
  win.HTMLElement.prototype.getClientRects = function () { return this.closest("[hidden]") ? [] : [{}]; };
  win.HTMLElement.prototype.getBoundingClientRect = function () { return { width: this.closest("[hidden]") ? 0 : 100 }; };
  // React-controlled price inputs carry the seller's sale price limitation in
  // their component props even while the ceiling hint span stays unrendered.
  if (priceLimit !== null) for (const field of win.document.querySelectorAll('[data-id^="product.publish.skus.sale_price."]')) {
    const rules = priceLimit === "ambiguous"
      ? [{ max_sale_price: "4672.5" }, { max_sale_price: "9999" }]
      : [{ warehouse_sub_type: 3, min_dutiable_price: "1", max_sale_price: String(priceLimit) }];
    field.querySelector("input").__reactFiber$fixture = {
      memoizedProps: { currency: { price_limitation: rules } }, return: null,
    };
  }
  return dom;
}

let persisted = structuredClone(original), dom, epoch = 0, open = false, clicks = 0, reloads = 0;
let corruptStock = false, priceChangedAfterRead = false, changeFunctionBeforeSave = false;
let persistedFunction = false, changeFunctionAfterSave = false;
let showBatch = false, batchStock = "";
let priceLimit = null;
const writes = [], batchApplies = [], batchStockApplies = [];
function render() {
  dom?.window.close();
  dom = buildEditor(persisted, ++epoch);
  const doc = dom.window.document;
  for (const box of doc.querySelectorAll('[role="combobox"][aria-haspopup="listbox"]')) {
    const menu = doc.getElementById(box.getAttribute("aria-controls"));
    box.querySelector("button").onclick = () => {
      box.setAttribute("aria-expanded", String(menu.hidden));
      menu.hidden = !menu.hidden;
    };
    for (const option of menu.querySelectorAll('[role="option"]'))
      option.onclick = () => assert.fail("The repricing workflow must only read category options");
  }
  const batch = doc.querySelector('[data-id="product.publish.skus.batch_edit"]');
  const batchPrice = batch?.querySelector('[data-id$=".batch_edit.price"] input');
  const batchStockInput = batch?.querySelector('[data-id$=".batch_edit.stock"] input');
  const apply = batch?.querySelector("button");
  const skuInput = '[data-id*=".skus.sale_price."] input,[data-id*=".skus.stock."] input,[data-id*=".skus.batch_edit."] input';
  let appliedPrice, appliedStock;
  if (batch) apply.onclick = () => {
    assert.equal(persisted.length, 1, "Batch mutation must never run on multiple SKUs");
    if (batchStockInput.value !== "") {
      appliedStock = Number(batchStockInput.value);
      assert.ok(appliedStock <= persisted[0].stock, "Batch stock must never increase");
      doc.querySelector('[data-id*=".skus.stock."] input').value = appliedStock;
      batchStockApplies.push(appliedStock);
    }
    if (!batchPrice.value) return;
    const input = doc.querySelector('[data-id*=".skus.sale_price."] input');
    const price = Number(batchPrice.value.replaceAll(",", ""));
    input.value = price.toLocaleString("en-US");
    batchApplies.push(price);
    const priceField = input.closest("[data-id]");
    priceField.querySelector(".text-critical-on-surface")?.remove();
    if (price > 4672.5) {
      dom.window.setTimeout(() => priceField.insertAdjacentHTML("beforeend",
        '<span class="break-normal text-critical-on-surface">价格不能超过\n4,672.5</span>'), 300);
    } else appliedPrice = price;
  };
  doc.addEventListener("input", event => {
    assert.ok(event.target.matches(skuInput), "Only SKU price or stock inputs may be edited");
    event.target.dataset.proposed = event.target.value;
  });
  doc.addEventListener("keyup", event => {
    if (event.target.matches(skuInput) && event.key === "Enter") event.target.dataset.commitKey = "Enter";
  });
  doc.addEventListener("change", event => {
    if (event.target.matches(skuInput)) event.target.dataset.changed = "true";
  });
  doc.addEventListener("blur", event => {
    const input = event.target;
    if (!input.matches(skuInput) || !input.dataset.proposed) return;
    assert.equal(input.dataset.commitKey, "Enter");
    assert.equal(input.dataset.changed, "true");
    const price = input.dataset.proposed;
    if (input === batchPrice || input === batchStockInput) {
      input.value = Number(price).toLocaleString("en-US");
      apply.disabled = false;
      return;
    }
    const label = input.closest("tr").dataset.label;
    const field = input.closest("[data-id]").dataset.id.includes(".stock.") ? "stock" : "priceMXN";
    const replacement = input.cloneNode();
    replacement.removeAttribute("data-proposed");
    replacement.value = persisted.find(row => row.label === label)[field];
    input.replaceWith(replacement);
    // Restore the pre-edit value while seller state catches up with blur.
    dom.window.setTimeout(() => {
      replacement.value = price;
      doc.querySelector("#focus-status").textContent = "Editando precio";
      if (changeFunctionBeforeSave) doc.querySelector('#function [role="option"]').setAttribute("aria-selected", "true");
      for (const field of doc.querySelectorAll('[data-id*=".skus."]')) field.dataset.id += "-r";
      if (field === "priceMXN") writes.push({ label, price });
    }, 300);
  }, true);
  doc.querySelector("#publish").onclick = () => assert.fail("Repricing must never publish");
  doc.querySelector("#draft").onclick = () => {
    clicks++;
    for (const tr of doc.querySelectorAll("tbody tr")) {
      const row = persisted.find(row => row.label === tr.dataset.label);
      if (batch && persisted.length === 1) {
        // Direct row input appears changed, but only explicit batch Apply commits this flow.
        if (appliedPrice !== undefined) row.priceMXN = appliedPrice;
        if (appliedStock !== undefined) row.stock = appliedStock;
      } else {
        row.priceMXN = Number(tr.querySelector('[data-id*="sale_price"] input').value);
        row.stock = Number(tr.querySelector('[data-id*=".skus.stock."] input').value);
      }
    }
    if (corruptStock) persisted[0].stock++;
    if (changeFunctionAfterSave) persistedFunction = true;
    doc.body.insertAdjacentHTML("beforeend", `<p role="alert">草稿保存成功<a href="${link}"></a></p>`);
  };
}
const hooks = {
  async registeredListing(sid, did) {
    assert.deepEqual([sid, did], [sourceId, draftId]);
    assert.ok((await fs.stat(path.join(tmp, `tiktok-mx-${sourceId}.lock`))).isDirectory());
    return { copy: await readJson(listingFile), dir: tmp };
  },
  async request({ action, request: { tool, args } }) {
    assert.equal(action, "bridge_call");
    if (tool === "open_tab") {
      assert.equal(args.url, link);
      open = true;
      render();
      return { tabId: 7, groupId: 9 };
    }
    if (tool === "list_tabs") return open ? [{ id: 7, groupId: 9, url: link }] : [];
    assert.equal(args.tabId, 7);
    if (tool === "close_tab") { open = false; return {}; }
    if (tool === "reload_tab") { reloads++; render(); return {}; }
    if (tool === "trusted_type") {
      const input = dom.window.document.querySelector(args.selector);
      assert.ok(input, "missing " + args.selector);
      input.value = String(args.value);
      const label = input.closest("tr")?.dataset.label;
      if (label && input.closest("[data-id]")?.dataset.id.includes("sale_price"))
        writes.push({ label, price: String(args.value) });
      return { ok: true, action: "type" };
    }
    if (tool === "press_keys") {
      if (changeFunctionBeforeSave)
        dom.window.document.querySelector('#function [role="option"]').setAttribute("aria-selected", "true");
      return { ok: true, action: "press_keys" };
    }
    if (tool === "run_js") {
      assert.ok(args.code.length <= 8000);
      if (priceChangedAfterRead && args.code.includes("function readDraftSkuNumbers"))
        dom.window.document.querySelector('[data-label="Silver / 1 piece"] [data-id*="sale_price"] input').value = "222";
      return { ok: true, result: await dom.window.eval("(async()=>{" + args.code + "})()") };
    } else assert.equal(tool, "activate_tab");
    return { ok: true };
  },
};

try {
  await assert.rejects(runMxDraftReprice({ ...args, baselinePricesMXN: baselinePricesMXN.slice(0, 1) }, hooks), /every SKU/);
  await assert.rejects(runMxDraftReprice({ ...args, baselinePricesMXN: [{ label: "Silver / 1 piece", priceMXN: 121 }, baselinePricesMXN[1]] }, hooks),
    /baseline and target/);
  priceChangedAfterRead = true;
  await assert.rejects(runMxDraftReprice(args, hooks), /SKU price changed before editing/);
  priceChangedAfterRead = false;
  assert.equal(clicks, 0);
  assert.deepEqual(writes, []);

  reloads = 0;
  const receipt = await runMxDraftReprice(args, hooks);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.changed, true);
  assert.equal(receipt.multiplier, 100);
  assert.equal(receipt.expectedPlanUpdated, true);
  assert.deepEqual(receipt.prices, [
    { label: "Silver / 1 piece", stock: 0, beforeMXN: 120, afterMXN: 12000 },
    { label: "Gold", stock: 3, beforeMXN: 9.99, afterMXN: 999 },
  ]);
  assert.deepEqual(writes, [{ label: "Silver / 1 piece", price: "12000" }, { label: "Gold", price: "999" }]);
  assert.deepEqual([clicks, reloads], [1, 2]);
  assert.equal((await readJson(receipt.receiptFile)).draftId, draftId);
  const updated = await readJson(listingFile);
  assert.deepEqual(updated.salesAndShipping.skus.map(({ stock, priceMXN }) => [stock, priceMXN]), [[0, 12000], [3, 999]]);
  assert.equal(updated.salesAndShipping.origins["Dorado.priceMXN"].verified, true);
  assert.match(updated.salesAndShipping.origins["Dorado.priceMXN"].basis, /× 100/);
  assert.deepEqual(updated.salesAndShipping.origins["Plata / 1 pza.stock"], listing.salesAndShipping.origins["Plata / 1 pza.stock"]);

  const repeated = await runMxDraftReprice(args, hooks);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.expectedPlanUpdated, false);
  assert.deepEqual([clicks, writes.length], [1, 2]);

  persisted = structuredClone(original);
  changeFunctionBeforeSave = true;
  await assert.rejects(runMxDraftReprice(args, hooks), /Category attribute Función changed before saving/);
  assert.equal(clicks, 1);
  changeFunctionBeforeSave = false;

  changeFunctionAfterSave = true;
  await assert.rejects(runMxDraftReprice(args, hooks), /Category attribute Función changed after refresh/);
  assert.equal(clicks, 2);
  changeFunctionAfterSave = false;
  persistedFunction = false;

  persisted = structuredClone(original);
  corruptStock = true;
  await assert.rejects(runMxDraftReprice(args, hooks), /Unexpected stock change/);
  assert.equal(clicks, 3);
  assert.deepEqual(await readJson(listingFile), updated);

  corruptStock = false;
  showBatch = true;
  persisted = [{ ...original[0], stock: 75 }];
  const single = { ...args, baselinePricesMXN: baselinePricesMXN.slice(0, 1) };
  const rowWrites = writes.length;
  batchStock = "0";
  await assert.rejects(runMxDraftReprice(single, hooks), /Batch SKU stock must be empty/);
  assert.deepEqual(batchApplies, []);
  assert.equal(clicks, 3);
  batchStock = "";
  const capped = await runMxDraftReprice(single, hooks);
  assert.equal(capped.verified, true);
  assert.equal(capped.prices[0].afterMXN, 4672.5);
  assert.deepEqual(batchApplies, [12000, 4672.5]);
  assert.equal(writes.length, rowWrites);
  assert.deepEqual([persisted[0].priceMXN, persisted[0].stock, clicks], [4672.5, 75, 4]);

  const cappedStock = await runMxDraftReprice({ ...single, maxTotalStock: 10 }, hooks);
  assert.equal(cappedStock.savedTotalStock, 10);
  assert.deepEqual(batchApplies, [12000, 4672.5]);
  assert.deepEqual(batchStockApplies, [10]);
  assert.deepEqual([persisted[0].priceMXN, persisted[0].stock], [4672.5, 10]);

  persisted = [{ ...original[0], stock: 75 }];
  const combined = await runMxDraftReprice({ ...single, maxTotalStock: 10 }, hooks);
  assert.equal(combined.savedTotalStock, 10);
  assert.deepEqual(batchApplies, [12000, 4672.5, 12000, 4672.5]);
  assert.deepEqual(batchStockApplies, [10, 10, 10]);
  assert.deepEqual([persisted[0].priceMXN, persisted[0].stock], [4672.5, 10]);

  // The ceiling hint span may never render for direct per-row price edits.
  // The control's own price limit configuration then supplies the ceiling.
  showBatch = false;
  persisted = structuredClone(original);
  await fs.writeFile(listingFile, JSON.stringify(listing));
  priceLimit = 4672.5;
  const configured = await runMxDraftReprice(args, hooks);
  assert.equal(configured.verified, true);
  assert.equal(configured.changed, true);
  assert.deepEqual(configured.prices, [
    { label: "Silver / 1 piece", stock: 0, beforeMXN: 120, afterMXN: 4672.5, requestedMXN: 12000, maxPriceMXN: 4672.5 },
    { label: "Gold", stock: 3, beforeMXN: 9.99, afterMXN: 999 },
  ]);
  assert.deepEqual(persisted.map(row => row.priceMXN), [4672.5, 999]);
  assert.match((await readJson(listingFile)).salesAndShipping.origins["Plata / 1 pza.priceMXN"].basis,
    /上限 MXN 4672\.5/);

  // Ambiguous configured limits keep the unconfirmed ceiling out of the flow.
  persisted = structuredClone(original);
  priceLimit = "ambiguous";
  const ambiguous = await runMxDraftReprice(args, hooks);
  assert.equal(ambiguous.verified, true);
  assert.ok(ambiguous.prices.every(row => row.maxPriceMXN === undefined));
  assert.deepEqual(ambiguous.prices.map(row => [row.label, row.afterMXN]), [["Silver / 1 piece", 12000], ["Gold", 999]]);
  assert.deepEqual(persisted.map(row => row.priceMXN), [12000, 999]);
  priceLimit = null;

  const savedStocks = [81, 19];
  persisted = original.map((row, index) => ({ ...row, priceMXN: [12000, 999][index], stock: savedStocks[index] }));
  const multiple = await runMxDraftReprice({ ...args, maxTotalStock: 10 }, hooks);
  assert.equal(multiple.savedTotalStock, 10);
  assert.deepEqual(persisted.map(row => row.stock), [8, 2]);
  assert.ok(persisted.every((row, index) => row.stock <= savedStocks[index]));
  assert.deepEqual(persisted.map(row => row.priceMXN), [12000, 999]);
  assert.deepEqual(batchStockApplies, [10, 10, 10]);
  assert.ok(!(await fs.readdir(tmp)).some(name => name.endsWith(".lock")));
  console.log("MX draft repricing verified only exact SKU targets, readback, and idempotent retries");
} finally {
  dom?.window.close();
  if (home === undefined) delete process.env.PAGELENS_HOME;
  else process.env.PAGELENS_HOME = home;
  await fs.rm(tmp, { recursive: true, force: true });
}

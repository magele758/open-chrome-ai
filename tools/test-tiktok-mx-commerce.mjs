import assert from "node:assert/strict";
import { attributeCode, checkAttributes, mxEditor, runMxDraftJob, runMxDraftRead } from "./tiktok-mx-editor.mjs";
import { JSDOM } from "jsdom";
import {
  commercialPlan,
  commercialDifferences,
  commerceScript,
  locateSkuInput,
  sellerVariants,
  sellerNumbers,
} from "./tiktok-mx-commerce.mjs";

const skus = [
  { sourceSkuId: "1", option: "A", priceMXN: 299, stock: 0 },
  { sourceSkuId: "2", option: "B", priceMXN: 399, stock: 5 },
];
const source = { skus: [{ id: "1" }, { id: "2" }] };
const data = {
  brand: "Marca",
  axis: "Modelo",
  skus,
  packagedWeightGrams: 650,
  packageCm: { length: 19, width: 14, height: 15 },
  origins: {},
};
for (const field of [
  "brand",
  "packagedWeightGrams",
  "packageCm.length",
  "packageCm.width",
  "packageCm.height",
  ...skus.flatMap((r) =>
    ["option", "priceMXN", "stock"].map((k) => r.option + "." + k),
  ),
])
  data.origins[field] = { kind: "estimated", basis: "fixture estimate" };
const plan = commercialPlan({ salesAndShipping: data }, source);
assert.equal(plan.origins["B.priceMXN"].value, 399);
const invalid = structuredClone(data);
delete invalid.origins["A.stock"];
assert.throws(
  () => commercialPlan({ salesAndShipping: invalid }, source),
  /A.stock/,
);
assert.throws(
  () => commercialPlan({ salesAndShipping: data }, { skus: [{ id: "1" }] }),
  /source SKU/,
);
assert.throws(
  () =>
    commercialPlan(
      {
        salesAndShipping: {
          brand: "无品牌",
          sourceNote: "legacy",
          variant: { Modelo: "S" },
          stock: 1,
          priceMXN: 20,
          packagedWeightGrams: 100,
          packageCm: { length: 1, width: 1, height: 1 },
        },
      },
      { skus: [{ id: "s" }, { id: "m" }] },
    ),
  /Missing source SKU/,
);
{
  const dropped = structuredClone(data);
  dropped.skus = [dropped.skus[0]];
  dropped.excludedSkus = { 2: "任意理由" };
  assert.throws(
    () => commercialPlan({ salesAndShipping: dropped }, source),
    /Cannot drop source SKU 2/,
  );
  const nameless = structuredClone(data);
  delete nameless.skus[0].sourceSkuId;
  assert.throws(
    () => commercialPlan({ salesAndShipping: nameless }, source),
    /Missing source SKU/,
  );
  const foreign = structuredClone(data);
  foreign.origins["A.priceMXN"] = { kind: "seller", basis: "未核对的日元价" };
  assert.throws(
    () =>
      commercialPlan(
        { salesAndShipping: foreign },
        { skus: [{ id: "1", currency: "JPY", price: "1000" }, { id: "2" }] },
      ),
    /not a seller price/,
  );
  const thin = structuredClone(data);
  thin.origins["A.priceMXN"] = { kind: "converted", basis: "JPY 100 × 0.1" };
  assert.throws(
    () => commercialPlan({ salesAndShipping: thin }, source),
    /rate, date and source/,
  );
  assert.throws(
    () =>
      commercialPlan(
        { salesAndShipping: data },
        { skus: [{ id: "1", stock: 4 }, { id: "2", stock: 5 }] },
      ),
    /Stock does not match source SKU 1/,
  );
  const fractional = structuredClone(data);
  fractional.packagedWeightGrams = 650.4;
  assert.throws(
    () => commercialPlan({ salesAndShipping: fractional }, source),
    /Invalid package weight/,
  );
}

const dom = new JSDOM('<input data-id="product.publish.product_name">', {
  url: "https://seller.tiktokshopglobalselling.com/product/edit-draft/123?shop_region=MX",
  runScripts: "outside-only",
});
const { window: w } = dom;
const field = (id, body) =>
  '<div data-id="product.publish.' + id + '">' + body + "</div>";
const row = (id, label) =>
  "<tr><td>" +
  label +
  "</td><td>" +
  field("skus.stock." + id, '<input role="spinbutton">') +
  "</td><td>" +
  field("skus.sale_price." + id, '<input role="spinbutton">') +
  "</td></tr>";
w.document.body.insertAdjacentHTML(
  "beforeend",
  [
    field(
      "brand",
      '<div role="combobox"><span class="core-select-view-value">Marca</span></div>',
    ),
    field(
      "sale_property.name.1",
      '<div role="combobox"><span class="core-cascader-view-value">Modelo</span></div>',
    ),
    ...skus.map((r, i) =>
      field(
        "sale_property.value.name." + i,
        '<span class="pulse-input-tag-item">' + r.option + "</span>",
      ),
    ),
    "<table>" + row(2, '<div data-tid="m4b_overflow_text"><span>B</span><span>Traducción B</span></div>') +
      row(1, "A") + "</table>",
    field(
      "package_weight",
      '<div role="combobox">千克 (kg)</div><input role="spinbutton">',
    ),
    ...["length", "width", "height"].map((k) =>
      field("package_" + k, '厘米<input role="spinbutton">'),
    ),
  ].join(""),
);
async function execute(mode) {
  const run = (fn, ...args) =>
    w.eval("(async()=>{" + commerceScript(fn, ...args) + "})()");
  if (mode === "read") return run(sellerNumbers, mode);
  await run(sellerVariants, {
    axis: plan.axis,
    brand: plan.brand,
    skus: plan.skus.map(({ option }) => ({ option })),
  });
  return run(sellerNumbers, mode, {
    skus: plan.skus,
    total: plan.skus.length,
    packagedWeightGrams: plan.packagedWeightGrams,
    packageCm: plan.packageCm,
  });
}
assert(commercialDifferences(await execute("read"), plan).includes("A stock"));
const after = await execute("write", plan);
assert.deepEqual(commercialDifferences(after, plan), []);
assert.equal(after.skus[0].priceMXN, 399);
assert.equal(
  w.document.querySelector('[data-id$="package_weight"] input').value,
  "0.65",
);
{
  const weight = w.document.querySelector('[data-id$="package_weight"] input');
  weight.value = "1.001";
  const heavy = { ...plan, packagedWeightGrams: 1001 };
  const readHeavy = await execute("read");
  assert.equal(readHeavy.packagedWeightGrams, 1001);
  assert.equal(
    commercialDifferences(readHeavy, heavy).includes("packagedWeightGrams"),
    false,
  );
  assert.equal(
    commercialDifferences(
      { ...readHeavy, packagedWeightGrams: 1000.9999999999999 },
      heavy,
    ).includes("packagedWeightGrams"),
    false,
  );
  const kept = await w.eval(
    "(async()=>{" +
      commerceScript(sellerNumbers, "write", {
        skus: plan.skus,
        total: plan.skus.length,
        brand: plan.brand,
        axis: plan.axis,
        packagedWeightGrams: 1001,
        packageCm: plan.packageCm,
      }) +
      "})()",
  );
  assert.equal(kept.packagedWeightGrams, 1001);
  assert.equal(weight.value, "1.001");
  weight.value = "0.65";
}
// Full edit-page job with reversed SKU rows, different values, and an actual
// document readback. Browser I/O is mocked here. Navigation must stop all writes.
{
  Object.defineProperty(w.HTMLElement.prototype, "innerText", { configurable: true, get() { return this.textContent; } });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const title = w.document.querySelector('[data-id$="product_name"]');
  title.value = "Molde";
  w.document.body.insertAdjacentHTML("beforeend", '<div id="product-cascader-select-view">Cocina</div>' +
    field("description.local_lang", '<div class="ProseMirror">Hielo</div>') +
    '<div data-id="product.widget.main_image.0"><img src="/one.jpg"></div>');
  const copy = { title: "Molde", description: "Hielo", gallery: ["one.jpg"], category: { label: "Cocina" } };
  const job = { tabId: 1, url: w.location.href, copy, gallery: ["/one.jpg"], details: [], plan };
  const actions = [];
  const dispatch = async (tool, args) => {
    actions.push(tool);
    if (tool === "run_js") {
      assert.ok(args.code.length <= 8000);
      return { ok: true, result: { ok: true, result: await w.eval("(async()=>{" + args.code + "})()") } };
    }
    if (tool === "trusted_type") w.document.querySelector(args.selector).value = args.value;
    else assert.equal(tool, "press_keys");
    return { ok: true, result: { ok: true } };
  };
  for (const e of w.document.querySelectorAll('[data-id*="skus."] input')) e.value = "";
  const result = await runMxDraftJob(job, dispatch, () => job.url);
  assert.deepEqual(commercialDifferences(result.commerce.state, plan), []);
  assert.equal(actions.filter(a => a === "trusted_type").length, 4);
  // Reload may finish scheduling before Chrome replaces the old document.
  // Exercise the generated page code and verify the old snapshot is discarded.
  const fillActions = actions.length;
  const url = job.url;
  let reads = 0, documentEpoch = 12;
  Object.defineProperty(w.performance, "timeOrigin", { configurable: true, get: () => documentEpoch });
  const refreshed = await runMxDraftRead({ tabId: 1, url }, async (tool, args) => {
    if (tool === "reload_tab") return { ok: true, result: {} };
    if (!args.code.endsWith("return performance.timeOrigin") && ++reads === 2) documentEpoch++;
    return dispatch(tool, args);
  }, () => url);
  assert.equal(reads, 2);
  assert.equal(refreshed.url, url);
  assert.deepEqual(commercialDifferences(refreshed.salesAndShipping, plan), []);
  await assert.rejects(runMxDraftRead({ tabId: 1, url }, dispatch, () => url.replace("123", "987")), /URL changed/);
  const listUrl = "https://seller.tiktokshopglobalselling.com/product/manage?shop_region=MX&tab=draft";
  const listRequest = { action: "refresh_mx_draft_list", tabId: 1, url: listUrl, title: "Rack" };
  const listCalls = [];
  const rows = { matches: [{ id: "321" }], ids: ["321"] };
  const listRead = await runMxDraftRead(listRequest, async (tool, args) => {
    listCalls.push(tool);
    if (tool === "reload_tab") return { ok: true, result: {} };
    const result = args.code.endsWith("return performance.timeOrigin") ? 10 : rows;
    if (result === rows) assert.ok(args.code.includes("performance.timeOrigin===10"));
    return { ok: true, result: { ok: true, result } };
  }, () => listUrl);
  assert.deepEqual(listRead, rows);
  assert.deepEqual(listCalls, ["run_js", "reload_tab", "run_js"]);
  await assert.rejects(runMxDraftRead({ ...listRequest, url: listUrl.replace("draft", "live") },
    dispatch, () => listUrl), /Expected a saved MX draft/);
  const count = actions.length;
  await assert.rejects(runMxDraftJob(job, dispatch, () => job.url.replace("123", "987")), /editor changed/);
  assert.equal(actions.length, count);
  assert.equal(result.steps.length, fillActions);

  // A SKU gets a server ID after the first commit. Only the lost value is retyped.
  const slot = w.document.querySelector('[data-id="product.publish.skus.stock.2"]');
  slot.querySelector("input").value = "";
  const writes = [];
  const rerender = async (tool, args) => {
    const reply = await dispatch(tool, args);
    if (tool === "trusted_type") {
      writes.push(args.selector);
      if (writes.length === 1) {
        slot.dataset.id = "product.publish.skus.stock.server2";
        w.document.querySelector('[data-id="product.publish.skus.sale_price.2"]').dataset.id =
          "product.publish.skus.sale_price.server2";
        slot.querySelector("input").value = "0";
      }
    }
    return reply;
  };
  const recovered = await runMxDraftJob(job, rerender, () => job.url);
  assert.deepEqual(writes, ['[data-id="product.publish.skus.stock.2"] input',
    '[data-id="product.publish.skus.stock.server2"] input']);
  assert.deepEqual(JSON.parse(JSON.stringify(recovered.skuWrites.find(row => row.option === "B").attempts)),
    [{ stock: 0, priceMXN: 399 }, { stock: 5, priceMXN: 399 }]);
  slot.dataset.id = "product.publish.skus.stock.2";
  w.document.querySelector('[data-id="product.publish.skus.sale_price.server2"]').dataset.id =
    "product.publish.skus.sale_price.2";

  const createUrl = job.url.replace("edit-draft/123", "create");
  dom.reconfigure({ url: createUrl });
  const doc = w.document;
  doc.querySelector('[data-id^="product.widget.main_image."]').remove();
  doc.querySelector("#product-cascader-select-view").textContent = "";
  doc.body.insertAdjacentHTML("beforeend", "<section>Cocina<span><button>应用</button></span></section>");
  doc.querySelector("button").onclick = () => {
    doc.querySelector("#product-cascader-select-view").textContent = "Cocina";
    const shipping = doc.querySelector('[data-id="product.publish.package_weight"]');
    shipping.remove();
    setTimeout(() => doc.body.append(shipping), 350);
  };
  for (const e of doc.querySelectorAll('[data-id*="skus."] input')) e.value = "";
  let mainImages = 0;
  const upload = async (tool, args) => {
    if (tool === "upload_file") {
      for (const file of args.paths) {
        if (args.selector.includes("description")) doc.querySelector(".ProseMirror").insertAdjacentHTML("beforeend", '<img src="' + file + '">');
        else doc.body.insertAdjacentHTML("beforeend", '<div data-id="product.widget.main_image.' + mainImages++ + '"><img src="' + file + '"></div>');
      }
    } else if (tool === "wait_for") assert.ok(doc.querySelector(args.selector));
    else return dispatch(tool, args);
    return { ok: true, result: { ok: true } };
  };
  const created = await runMxDraftJob({ ...job, url: createUrl, copy: { ...copy, details: ["detail.jpg"] }, details: ["/detail.jpg"] }, upload, () => createUrl);
  assert.equal(created.category.shown, "Cocina");
  assert.deepEqual([created.state.gallery, created.state.detailImages], [1, 1]);
  assert.deepEqual(commercialDifferences(created.commerce.state, plan), []);
  assert.equal(created.steps.filter(s => s.tool === "upload_file").length, 2);
  // The first slot is slower than the last. Each selection waits for the previous batch.
  doc.querySelector('[data-id^="product.widget.main_image."]').remove();
  doc.body.insertAdjacentHTML("beforeend", '<input type="file" accept=".jpg,.png,.jpeg" multiple>');
  const nine = Array.from({ length: 9 }, (_, i) => "/gallery-" + i + ".jpg");
  const selections = [];
  const delayed = async (tool, args) => {
    if (tool !== "upload_file") return dispatch(tool, args);
    assert.equal(doc.querySelectorAll('[data-id^="product.widget.main_image."] [role="progressbar"]').length, 0);
    selections.push(args.paths);
    args.paths.forEach((file, i) => {
      const slot = doc.createElement("div");
      slot.dataset.id = "product.widget.main_image." + doc.querySelectorAll('[data-id^="product.widget.main_image."]').length;
      doc.body.append(slot);
      if (i === 0) {
        slot.innerHTML = '<img src="' + file + '"><span role="progressbar"></span>';
        setTimeout(() => slot.querySelector("span").remove(), 400);
      }
      else slot.innerHTML = '<img src="' + file + '">';
    });
    return { ok: true, result: { ok: true } };
  };
  const bulk = await runMxDraftJob({ ...job, url: createUrl, gallery: nine, copy: { ...copy, gallery: nine } }, delayed, () => createUrl);
  assert.deepEqual(selections, [nine.slice(0, 3), nine.slice(3, 6), nine.slice(6)]);
  assert.equal(bulk.state.gallery, 9);
  assert.equal(bulk.state.category, "Cocina");
  doc.querySelectorAll('[data-id^="product.widget.main_image."]').forEach(slot => slot.remove());
  doc.querySelectorAll(".ProseMirror img").forEach(img => img.remove());
  doc.body.insertAdjacentHTML("beforeend", field("description.input_lang", '<input type="file"><div class="ProseMirror">Ice</div>'));
  const shared = "/shared.jpg";
  const order = [];
  const overlapping = async (tool, args) => {
    if (tool !== "upload_file") return dispatch(tool, args);
    if (args.selector.includes("description")) {
      assert.ok(!doc.querySelector('[role="progressbar"]'));
      order.push("detail");
      assert.ok(args.selector.includes("description.input_lang"));
      const local = doc.querySelector('[data-id="product.publish.description.local_lang"] .ProseMirror');
      local.insertAdjacentHTML("beforeend", '<img src="blob:temporary">');
      setTimeout(() => { local.querySelector("img").src = "/shared.jpg"; }, 350);
    } else {
      order.push("gallery");
      doc.body.insertAdjacentHTML("beforeend", '<div data-id="product.widget.main_image.0"><img src="/shared.jpg"><i role="progressbar"></i></div>');
      setTimeout(() => doc.querySelector('[role="progressbar"]').remove(), 700);
    }
    return { ok: true, result: { ok: true } };
  };
  const sharedResult = await runMxDraftJob({ ...job, url: createUrl, gallery: [shared], details: [shared],
    copy: { ...copy, enDescription: "Ice", gallery: [shared], details: [shared] } }, overlapping, () => createUrl);
  assert.deepEqual(order, ["gallery", "detail"]);
  assert.ok(!doc.querySelector('.ProseMirror img[src^="blob:"]'));
  assert.deepEqual([sharedResult.state.gallery, sharedResult.state.detailImages], [1, 1]);
  dom.reconfigure({ url: job.url });
}
// Forced re-entry on an existing draft must still select the right row at an unchanged value.
w.HTMLElement.prototype.scrollIntoView = () => {};
const locate = (force) => w.eval("(async()=>{" + commerceScript(locateSkuInput, "B", "priceMXN", 399, force) + "})()");
assert.equal(await locate(false), null);
assert.equal(await locate(true), '[data-id="product.publish.skus.sale_price.2"] input');
// Simulate a seller save that retains the similarly named row but drops one value on refresh.
w.document.querySelector('[data-id$="skus.stock.1"] input').value = "";
assert.deepEqual(commercialDifferences(await execute("read"), plan), [
  "A stock",
]);
w.document.querySelector("tr td").textContent = "A";
assert(
  commercialDifferences(await execute("read"), plan).includes("variant A"),
);
// Empty editor: choosing a brand, creating a custom axis, then committing two
// new options on blur should produce two priced rows in the same product.
const doc = w.document;
doc.querySelector("tbody").replaceChildren();
doc
  .querySelectorAll('[data-id*="sale_property.value.name"]')
  .forEach((e) => e.remove());
w.HTMLElement.prototype.getBoundingClientRect = function () {
  return { width: 100 };
};
doc.execCommand = (command, ui, value) => {
  assert.equal(command, "insertText");
  doc.activeElement.value = value;
  doc.activeElement.dispatchEvent(new w.Event("input", { bubbles: true }));
  return true;
};
const brandBox = doc.querySelector('[data-id$=".brand"] [role=combobox]');
brandBox.innerHTML =
  '<div class="core-select-view"><span class="core-select-view-value"></span></div>';
brandBox.setAttribute("aria-controls", "brands");
brandBox.onclick = () => {
  const menu = doc.createElement("div");
  menu.id = "brands";
  menu.innerHTML = '<div role="option">Marca</div>';
  menu.firstChild.onclick = () => {
    brandBox.firstChild.firstChild.textContent = "Marca";
    menu.remove();
  };
  doc.body.append(menu);
};
const axisBox = doc.querySelector(
  '[data-id*="sale_property.name"] [role=combobox]',
);
axisBox.innerHTML = '<input><span class="core-cascader-view-value"></span>';
axisBox.setAttribute("aria-controls", "axes");
axisBox.firstChild.onclick = () => {
  const menu = doc.createElement("div");
  menu.id = "axes";
  menu.innerHTML = "<button>新增</button>";
  menu.firstChild.onclick = () => {
    menu.innerHTML = "<div><input><button>添加</button></div>";
    menu.querySelector("button").onclick = () => {
      axisBox.lastChild.textContent = menu.querySelector("input").value;
      menu.remove();
    };
  };
  doc.body.append(menu);
};
let index = 0;
function appendOption() {
  const n = ++index;
  doc.body.insertAdjacentHTML(
    "beforeend",
    field("sale_property.value.name." + n, "<input>"),
  );
  const slot = doc.body.lastElementChild;
  let typedAt = null, accepted = false;
  slot.firstChild.oninput = () => { typedAt = Date.now(); };
  slot.firstChild.onkeydown = event => {
    if (event.key === "Enter" && typedAt !== null && Date.now() - typedAt >= 300)
      accepted = true;
  };
  slot.firstChild.onblur = () => {
    if (!accepted) return;
    const value = slot.firstChild.value;
    slot.innerHTML = '<span class="pulse-input-tag-item"></span>';
    slot.firstChild.textContent = value;
    doc.querySelector("tbody").insertAdjacentHTML("afterbegin", row(n, value));
  };
}
appendOption();
const add = doc.createElement("button");
add.textContent = "添加选项";
add.onclick = appendOption;
doc.body.append(add);
assert.deepEqual(commercialDifferences(await execute("write", plan), plan), []);
assert.equal(index, 2);
doc.querySelector("tbody").replaceChildren();
for (const slot of doc.querySelectorAll('[data-id^="product.publish.sale_property.value.name."]')) slot.remove();
appendOption();
const entered = [];
doc.addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.closest('[data-id*="sale_property.value.name"]'))
    entered.push(e.target.value);
});
const editor = mxEditor(async (tool, args) => {
  if (tool === "trusted_type") {
    const el = doc.querySelector(args.selector);
    assert.ok(el.closest('[data-id*="skus."]'), "Variant labels must commit inside their own input");
    el.focus(); el.value = args.value;
  } else if (tool === "press_keys") doc.activeElement.blur();
  else throw Error("Unexpected test action " + tool);
  return { ok: true };
}, async (_tab, code) => w.eval("(async()=>{" + code + "})()"), []);
const typedVariants = await editor.commercialState(1, plan, true);
assert.deepEqual(entered, ["A", "B"]);
assert.deepEqual(commercialDifferences(typedVariants.state, plan), []);
dom.window.close();
console.log(
  "MX commerce: source identity, provenance, per-SKU writes, units, zero and incomplete readback passed",
);

// Bilingual option text and a localized, nonempty control can describe different choices.
{
  const fixture = new JSDOM('<body><section>Material\n<div><div><div><div role="combobox" aria-haspopup="listbox" aria-controls="materials" aria-expanded="false"><button class="core-select-view">Vidrio</button></div></div></div></div></section><ul id="materials"><li role="option" aria-selected="true">Glass\nVidrio</li><li role="option">Metal</li></ul></body>',
    { url: "https://seller.tiktokshopglobalselling.com/product/create?shop_region=MX", runScripts: "outside-only" });
  const win = fixture.window, doc = win.document;
  Object.defineProperty(win.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
  win.HTMLElement.prototype.getClientRects = () => [{}];
  const box = doc.querySelector('[role=combobox]');
  box.querySelector("button").onclick = () => box.setAttribute("aria-expanded", String(box.getAttribute("aria-expanded") !== "true"));
  let clicks = 0;
  for (const li of doc.querySelectorAll("li")) li.onclick = () => {
    clicks++;
    for (const option of doc.querySelectorAll("li")) option.setAttribute("aria-selected", String(option === li));
  };
  const read = plan => win.eval("(async()=>{" + attributeCode(win.location.href, plan) + "})()");
  const plan = { Material: ["Metal"] };
  assert.throws(() => checkAttributes(plan, [{name:"Material",options:["Glass\nVidrio","Metal"],selected:["Glass\nVidrio"]}]), /Material/);
  checkAttributes(plan, await read(plan));
  checkAttributes(plan, await read(plan));
  assert.equal(clicks, 1);
  checkAttributes({ Material: ["Glass\nVidrio"] }, [{name:"Material", options:["玻璃\nVidrio", "Metal"], selected:["玻璃\nVidrio"]}]);
  assert.throws(() => checkAttributes({ Material: ["Glass\nVidrio"] }, [{name:"Material",
    options:["A\nVidrio", "B\nVidrio"], selected:["A\nVidrio"]}]), /Material/);
  await assert.rejects(read({ Material: ["Plastic"] }), /option changed/);
  assert.equal(box.getAttribute("aria-expanded"), "false");
  const driver = mxEditor(null, async (_tab, code) => win.eval("(async()=>{" + code + "})()"), []);
  doc.body.insertAdjacentHTML("beforeend", '<div id="product-cascader-select-view">Old</div><div>Kitchen / Racks<span><button id="apply">应用</button></span></div>');
  doc.querySelector("#apply").onclick = () => {
    doc.body.insertAdjacentHTML("beforeend", '<div role="dialog">更改商品类目？属性信息将被清除<button>继续</button></div>');
    const dialog = doc.querySelector('[role=dialog]');
    dialog.querySelector("button").onclick = () => { doc.querySelector("#product-cascader-select-view").textContent="Kitchen - Racks"; dialog.remove(); };
  };
  assert.equal((await driver.category(1, { label:"Kitchen / Racks",search:"Racks" })).selected,true);
  fixture.window.close();
}

import assert from "node:assert/strict";
import { attributeCode, checkAttributes, mxEditor, repairCategoryOptionsCode, repairCategorySearchCode, sellerCategorySearchCode,
  runMxDraftJob, runMxDraftRead, saveDraftCode } from "./tiktok-mx-editor.mjs";
import { JSDOM } from "jsdom";
import {
  commercialPlan,
  commercialDifferences,
  commerceScript,
  locateSkuInput,
  sellerBrand,
  sellerVariantAxis,
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
  await run(sellerBrand, plan.brand);
  await run(sellerVariantAxis, plan.axis);
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
  const loginUrl = "https://seller.tiktokshopglobalselling.com/account/login";
  const cannotDispatch = async () => assert.fail("Seller login redirect must fail before using page tools");
  const loginError = /SELLER_LOGIN_REQUIRED: TikTok Seller Center is not logged in; please sign in to the MX seller shop and retry/;
  await assert.rejects(runMxDraftRead({ tabId: 1, url }, cannotDispatch, () => loginUrl), loginError);
  await assert.rejects(runMxDraftJob(job, cannotDispatch, () => loginUrl), loginError);
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
    assert.ok(args.selector.includes(`main_image.${selections.length}"]`));
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
  assert.deepEqual(selections, nine.map(file => [file]));
  assert.equal(bulk.state.gallery, 9);
  assert.equal(bulk.state.category, "Cocina");
  doc.querySelectorAll('[data-id^="product.widget.main_image."]').forEach(slot => slot.remove());
  doc.querySelectorAll(".ProseMirror img").forEach(img => img.remove());
  doc.body.insertAdjacentHTML("beforeend", field("description.input_lang", '<input type="file"><div class="ProseMirror">Ice</div>'));
  doc.body.insertAdjacentHTML("beforeend", '<input data-id="product.publish.title.input_lang" value="Mold">');
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
      setTimeout(() => doc.querySelector('[role="progressbar"]').remove(), 2000);
    }
    return { ok: true, result: { ok: true } };
  };
  const sharedResult = await runMxDraftJob({ ...job, url: createUrl, gallery: [shared], details: [shared],
    copy: { ...copy, enTitle: "Mold", enDescription: "Ice", gallery: [shared], details: [shared] } }, overlapping, () => createUrl);
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
doc.body.insertAdjacentHTML("afterbegin", '<div id="attribute-menu"><div><input maxlength="30"><button>添加</button></div></div>');
let foreignClicks = 0;
doc.querySelector("#attribute-menu button").onclick = () => foreignClicks++;
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
assert.equal(foreignClicks, 0, "Adding a custom variant must not click a category attribute action");
assert.equal(doc.querySelector("#attribute-menu input").value, "");
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

// The built-in Color axis is saved under its localized label in Seller Center.
doc.querySelector("tbody").replaceChildren();
for (const slot of doc.querySelectorAll('[data-id^="product.publish.sale_property.value.name."]')) slot.remove();
appendOption();
axisBox.lastChild.textContent = "";
let exactClicks = 0;
let parentClicks = 0;
axisBox.firstChild.onclick = () => {
  const menu = doc.createElement("div");
  menu.id = "axes";
  menu.innerHTML = '<ul><li><span>Common axes</span><ul><li role="option"><span>颜色</span></li></ul></li></ul>';
  menu.querySelector("li").onclick = () => parentClicks++;
  menu.querySelector('[role="option"]').onclick = event => {
    event.stopPropagation();
    exactClicks++;
    axisBox.lastChild.innerHTML = '<span>颜色</span><span class="pl-8"></span>';
    menu.remove();
  };
  doc.body.append(menu);
};
const colorPlan = { ...plan, axis: "Color" };
const coloredVariants = await editor.commercialState(1, colorPlan, true);
assert.equal(exactClicks, 1);
assert.equal(parentClicks, 0);
assert.deepEqual(commercialDifferences(coloredVariants.state, colorPlan), []);

// A no-op built-in selection can remount the same empty field and its owned menu.
const axisField = axisBox.parentElement;
const axisFieldId = axisField.dataset.id;
const placeholder = "请选择或输入销售属性";
const runAxis = () => w.eval("(async()=>{" + commerceScript(sellerVariantAxis, colorPlan.axis) + "})()");
function resetColorSkus() {
  doc.querySelector("tbody").replaceChildren();
  for (const slot of doc.querySelectorAll('[data-id^="product.publish.sale_property.value.name."]')) slot.remove();
  appendOption();
}
function mockNoopColor(afterStandard) {
  const clicks = { standard: 0, create: 0, add: 0 };
  function mount(id, open, label = placeholder) {
    doc.querySelector('[id^="color-axis-menu-"]')?.remove();
    axisField.innerHTML = `<div role="combobox" aria-controls="${id}" aria-expanded="${open}">
      <input class="core-cascader-view-input" placeholder="${placeholder}">
      <span class="core-cascader-view-value"><span>${label}</span><span class="pl-8"></span></span>
    </div>`;
    const box = axisField.firstElementChild;
    const show = () => {
      box.setAttribute("aria-expanded", "true");
      const menu = doc.createElement("div");
      menu.id = id;
      menu.innerHTML = '<div role="option">颜色</div><div class="core-cascader-list-footer"><button>新增</button></div>';
      menu.firstElementChild.onclick = () => {
        clicks.standard++;
        mount("color-axis-menu-next", true);
        afterStandard?.();
      };
      const footer = menu.lastElementChild;
      footer.firstElementChild.onclick = () => {
        clicks.create++;
        footer.innerHTML = '<div><input class="core-input" maxlength="30"><button disabled>添加</button></div>';
        footer.querySelector("input").oninput = event => {
          const typed = event.target.value;
          footer.innerHTML = '<div><input class="core-input" maxlength="30"><button>添加</button></div>';
          footer.querySelector("input").value = typed;
          footer.querySelector("button").onclick = () => {
            clicks.add++;
            assert.equal(typed, "Color");
            axisField.dataset.id = "product.publish.sale_property.name.881";
            mount("color-axis-menu-chosen", false, "颜色");
          };
        };
      };
      doc.body.append(menu);
    };
    box.querySelector("input").onclick = show;
    if (open) show();
  }
  axisField.dataset.id = axisFieldId;
  mount("color-axis-menu-first", false);
  return clicks;
}
resetColorSkus();
await assert.rejects(w.eval("(async()=>{" + commerceScript(sellerVariantAxis, "Modelo") + "})()"), /Existing variant name differs: 颜色/);
const replaced = mockNoopColor(() => { axisField.dataset.id = "product.publish.sale_property.name.999"; });
await assert.rejects(runAxis(), /Variant name slot changed/);
assert.deepEqual(replaced, { standard: 1, create: 0, add: 0 });
const withRows = mockNoopColor(() => doc.querySelector("tbody").insertAdjacentHTML("afterbegin", row(99, "Existing")));
await assert.rejects(runAxis(), /Existing variant name differs/);
assert.deepEqual(withRows, { standard: 1, create: 0, add: 0 });
resetColorSkus();
brandBox.firstChild.firstChild.textContent = "  MARCA  ";
const fallback = mockNoopColor();
const recoveredColor = await editor.commercialState(1, colorPlan, true);
assert.deepEqual(fallback, { standard: 1, create: 1, add: 1 });
assert.deepEqual(commercialDifferences(recoveredColor.state, colorPlan), []);
for (const input of doc.querySelectorAll("input")) input.defaultValue = input.value;
const reloaded = new JSDOM(dom.serialize(), { url: doc.URL, runScripts: "outside-only" });
const refreshedEditor = mxEditor(async () => assert.fail("Refreshing readback must not write"),
  async (_tab, code) => reloaded.window.eval("(async()=>{" + code + "})()"), []);
const { state: freshColor } = await refreshedEditor.commercialState(1, colorPlan, false);
assert.deepEqual([...freshColor.axes], ["颜色"]);
assert.deepEqual(commercialDifferences({ ...freshColor, axisLabels: undefined }, colorPlan), []);
assert.deepEqual(commercialDifferences(freshColor, { ...colorPlan, axis: "Color secundario" }), ["variant name"]);
reloaded.window.close();
dom.window.close();
console.log(
  "MX commerce: source identity, provenance, per-SKU writes, units, zero and incomplete readback passed",
);

// Bilingual option text and a localized, nonempty control can describe different choices.
{
  const fixture = new JSDOM('<body><section>Material\n<div><div><div><div role="combobox" aria-haspopup="listbox" aria-controls="materials" aria-expanded="false"><button class="core-select-view">Vidrio</button></div></div></div></div></section><ul id="materials" hidden><li role="option" aria-selected="true">Glass\nVidrio</li><li role="option">Metal</li></ul></body>',
    { url: "https://seller.tiktokshopglobalselling.com/product/create?shop_region=MX", runScripts: "outside-only" });
  const win = fixture.window, doc = win.document;
  Object.defineProperty(win.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
  win.HTMLElement.prototype.getClientRects = function () { return this.closest("[hidden]") ? [] : [{}]; };
  const box = doc.querySelector('[role=combobox]');
  box.querySelector("button").onclick = () => {
    const open = box.getAttribute("aria-expanded") !== "true";
    box.setAttribute("aria-expanded", String(open));
    doc.querySelector("#materials").hidden = !open;
  };
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
  assert.throws(() => checkAttributes(plan, [{ name: "Material", options: ["Metal", "Cantidad"],
    selected: ["Metal", "Cantidad"] }], { exact: true }), /Draft attribute differs: Material/);
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

// Seller updates can replace a single-select control while its portal fades out.
// The next control must wait for that old portal, and a foreign menu stays untouched.
{
  const url = "https://seller.tiktokshopglobalselling.com/product/create?shop_region=MX";
  const fixture = new JSDOM('<body><ul id="foreign"><li role="option">Unrelated</li></ul></body>',
    { url, runScripts: "outside-only" });
  const win = fixture.window, doc = win.document;
  Object.defineProperty(win.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
  win.HTMLElement.prototype.getClientRects = function () { return this.closest("[hidden]") ? [] : [{}]; };
  assert.equal(doc.hidden, true);
  win.HTMLElement.prototype.checkVisibility = function () {
    // A background tab can keep an open option transparent while it has layout.
    return !this.closest("[hidden]") && !this.matches('[role="option"]');
  };
  const portals = [];
  const opens = [], escaped = [];
  const control = (name, choices, multiple) => {
    const section = doc.createElement("section");
    section.innerHTML = name + "\n<div><div><div></div></div></div>";
    doc.body.append(section);
    const selected = new Set();
    const render = () => {
      const holder = section.querySelector("div > div > div");
      holder.innerHTML = '<div role="combobox" aria-haspopup="listbox" aria-expanded="false"><button class="core-select-view"></button></div>';
      const box = holder.firstChild;
      if (multiple) box.className = "core-select-multiple";
      const portal = doc.createElement("ul");
      portal.id = `attribute-popup-${portals.length}`;
      portal.hidden = true;
      portals.push(portal);
      doc.body.append(portal);
      box.setAttribute("aria-controls", portal.id);
      const close = () => {
        box.setAttribute("aria-expanded", "false");
        win.setTimeout(() => { portal.hidden = true; }, 35);
      };
      for (const choice of choices) {
        const item = doc.createElement("li");
        item.setAttribute("role", "option");
        item.textContent = choice;
        item.setAttribute("aria-selected", String(selected.has(choice)));
        item.onclick = () => {
          selected.add(choice);
          item.setAttribute("aria-selected", "true");
          if (!multiple) { close(); render(); }
        };
        portal.append(item);
      }
      if (multiple) box.insertAdjacentHTML("beforeend", '<input type="hidden"><input type="search">');
      const input = box.querySelector('input[type="search"]');
      if (input) input.onkeydown = event => {
        if (event.key === "Escape" && event.code === "Escape" && event.keyCode === 27 &&
            event.target === input && doc.activeElement === input && event.bubbles) {
          escaped.push(name);
          close();
          input.blur();
        }
      };
      box.firstChild.onclick = () => {
        if (box.getAttribute("aria-expanded") === "true") {
          if (!multiple) close();
        } else {
          opens.push({ name, overlapping: portals.some(menu => !menu.hidden) });
          box.setAttribute("aria-expanded", "true");
          portal.hidden = false;
          input?.focus();
        }
      };
    };
    render();
  };
  control("Function", ["Durable", "Reusable"], false);
  control("Material", ["Glass", "Plastic"], true);
  const plan = { Function: ["Reusable"], Material: ["Glass", "Plastic"] };
  const catalog = await win.eval("(async()=>{" + attributeCode(url, plan) + "})()");
  assert.deepEqual(opens, [
    { name: "Function", overlapping: false },
    { name: "Function", overlapping: false },
    { name: "Material", overlapping: false },
  ]);
  assert.deepEqual(escaped, ["Material"], "a multi-select that ignores trigger clicks closes by scoped Escape");
  assert.ok(portals.every(menu => menu.hidden), "the final delayed close must finish before returning");
  assert.equal(doc.querySelector("#foreign").hidden, false);
  assert.deepEqual(JSON.parse(JSON.stringify(catalog.map(({ name, selected }) => [name, selected]))), Object.entries(plan));
  fixture.window.close();
}

// Targeted repair uses the existing editor's exact search choices and save button.
{
  const url = "https://seller.tiktokshopglobalselling.com/product/edit-draft/1738598470326847052?shop_region=MX";
  const choice = "Pet Supplies - Pet Accessories - Keepsakes";
  const unavailable = "Pet Supplies - Pet Accessories - Decorations";
  const disabledClass = "Pet Supplies - Pet Accessories - Gifts";
  const fixture = new JSDOM('<body><div id="product-cascader-select-view">Old</div>' +
    '<div class="core-cascader-list-search-item" title="Other - Portal - Item"></div>' +
    '<button id="save">另存为草稿</button><button id="submit">提交</button></body>', { url, runScripts: "outside-only" });
  const win = fixture.window, doc = win.document;
  Object.defineProperty(win.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
  win.HTMLElement.prototype.getClientRects = function () { return this.closest("[hidden]") ? [] : [{}]; };
  const control = doc.querySelector("#product-cascader-select-view");
  let selected = 0;
  control.onclick = () => {
    if (control.querySelector("input")) return;
    control.insertAdjacentHTML("beforeend", '<input class="core-cascader-view-input" aria-controls="category-results">');
    const panel = doc.createElement("ul");
    panel.id = "category-results";
    doc.body.append(panel);
    for (const [label, disabled] of [[choice, null], [unavailable, "aria"], [disabledClass, "class"]]) {
      const row = doc.createElement("li");
      row.className = "core-cascader-list-search-item";
      row.title = label;
      if (disabled === "aria") row.setAttribute("aria-disabled", "true");
      if (disabled === "class") row.classList.add("core-cascader-list-search-item-disabled");
      row.onclick = () => {
        assert.equal(disabled, null);
        doc.body.insertAdjacentHTML("beforeend", '<div role="dialog">更改商品类目？属性信息将被清除<button>继续</button></div>');
        const dialog = doc.querySelector('[role="dialog"]');
        dialog.querySelector("button").onclick = () => {
          control.textContent = choice;
          panel.remove();
          dialog.remove();
          selected++;
        };
      };
      panel.append(row);
    }
  };
  const run = code => win.eval("(async()=>{" + code + "})()");
  assert.throws(() => repairCategorySearchCode(url.replace("edit-draft/1738598470326847052", "create")), /existing MX/);
  assert.equal(typeof sellerCategorySearchCode(url.replace("edit-draft/1738598470326847052", "create")), "string");
  await assert.rejects(run(repairCategoryOptionsCode(url)), /Search the current draft/);
  const search = await run(repairCategorySearchCode(url));
  const input = doc.querySelector(search.selector);
  assert.equal(input, doc.activeElement);
  input.value = "Pet";
  const choices = await run(repairCategoryOptionsCode(url));
  assert.deepEqual([...choices.choices], [choice]);
  assert.equal(choices.choice, null);
  await assert.rejects(run(repairCategoryOptionsCode(url, unavailable)), /disabled/);
  await assert.rejects(run(repairCategoryOptionsCode(url, disabledClass)), /disabled/);
  await assert.rejects(run(repairCategoryOptionsCode(url, "Keepsakes")), /full category path/);
  assert.equal(selected, 0);
  assert.equal((await run(repairCategoryOptionsCode(url, choice.replaceAll(" - ", "/")))).choice, choice);
  assert.equal(selected, 1);
  doc.querySelector("#submit").onclick = () => assert.fail("Draft repair must not submit a product");
  doc.querySelector("#save").onclick = () => {
    doc.body.insertAdjacentHTML("beforeend", '<div role="alert">草稿保存成功</div>');
  };
  await assert.rejects(run(saveDraftCode(url.replace("1738598470326847052", "1738598470326847053"))), /changed/);
  assert.equal((await run(saveDraftCode(url))).message, "草稿保存成功");
  fixture.window.close();
}

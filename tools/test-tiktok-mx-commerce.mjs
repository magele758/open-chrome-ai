import assert from "node:assert/strict";
import { runMxDraftJob } from "./tiktok-mx-editor.mjs";
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
  const count = actions.length;
  await assert.rejects(runMxDraftJob(job, dispatch, () => job.url.replace("123", "987")), /editor changed/);
  assert.equal(actions.length, count);
  assert.equal(result.steps.length, actions.length);

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
  doc.querySelector("button").onclick = () => { doc.querySelector("#product-cascader-select-view").textContent = "Cocina"; };
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
  slot.firstChild.onblur = () => {
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
dom.window.close();
console.log(
  "MX commerce: source identity, provenance, per-SKU writes, units, zero and incomplete readback passed",
);

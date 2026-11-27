import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { sheinRowsPage } from "../rows-page.js";

const href = "https://sellerhub.shein.com/#/spmp/commoditiesInfo?mode=add&last_page=page_commodities_category";
const categoryPath = ["家居&生活", "厨房&餐厅", "饮具", "真空瓶和保温杯"];

function simulateFileInput(window, input) {
  Object.defineProperty(window.crypto, "subtle", { value: webcrypto.subtle });
  for (const [property, value] of [["complete", true], ["naturalWidth", 1000]]) {
    Object.defineProperty(window.HTMLImageElement.prototype, property, { configurable: true,
      get() { return /^https:\/\//u.test(this.src) ? value : property === "complete" ? false : 0; } });
  }
  window.DataTransfer = class {
    files = [];
    items = { add: file => this.files.push(file) };
  };
  Object.defineProperty(input, "files", { value: [], writable: true });
}

function appendThumbnail(input, src) {
  const holder = Object.assign(input.ownerDocument.createElement("div"), { className: "spmp_style__uploadImgItemExist--test" });
  const image = Object.assign(input.ownerDocument.createElement("img"), { src });
  holder.append(image);
  input.parentElement.append(holder);
  return { holder, image };
}

function fixture(t) {
  const dom = new JSDOM(`<main>
    <h1>发布商品</h1>
    <div class="spmp_style__commodityCategoryItem--test"><span class="spmp_style__categoryInfo--test"></span></div>
    <div class="so-table spmp_style__supplyInfoTable--test" id="supply"></div>
    <div class="so-table" id="package"></div>
    <div class="spmp_style__sizeContentBox--test"><div class="so-table" id="size"></div></div>
    <div class="detail_img_container"><div class="so-table" id="media"></div></div>
    <button id="publish">发布商品</button><button id="save">保存草稿</button>
  </main>`, { url: href, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { document, HTMLElement } = dom.window;
  document.querySelector('[class*="spmp_style__categoryInfo--"]').textContent = categoryPath.join(">");
  HTMLElement.prototype.getClientRects = function () {
    return this.closest('[hidden]') ? [] : [{ left: 1, top: 1, width: 50, height: 10 }];
  };
  let publishes = 0;
  let saves = 0;
  document.getElementById("publish").onclick = () => publishes++;
  document.getElementById("save").onclick = () => saves++;
  function table(id, headers, rows) {
    // SHEIN uses separate tables for the fixed header and scrollable body.
    document.getElementById(id).innerHTML = `<div class="so-table-head"><table><thead><tr>${headers.map(header => `<th>${header}</th>`).join("")}</tr></thead></table></div>
      <div class="so-table-body"><table><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  const packageDimensions = '<input placeholder="长(最长边)"><input placeholder="宽(次长边)"><input placeholder="高(最短边)">';
  table("supply", ["颜色", "尺码", "价格(USD)", "商家SKU", "SKU图"], [
    ["黑色 SKC: existing-key", "500 ml", '<input id="black-price">', '<input id="black-code">', '<input type="file" accept="image/png,image/jpeg">'],
    ["红色", "500 ml", '<input id="red-price">', '<input id="red-code">', '<input type="file" accept="image/png,image/jpeg">'],
  ]);
  table("package", ["含包装尺寸", "颜色", "含包装重量 (g)", "尺码", "包装类型"], [
    [packageDimensions, "红色", '<input id="red-weight">', "500 ml", "-"],
    [packageDimensions, "黑色", '<input id="black-weight">', "500 ml", "-"],
  ]);
  table("size", ["宽度 (cm)", "长度 (cm)", "高度 (cm)", "直径 (cm)"], [Array(4).fill("<input>")]);
  const mediaInput = id => `<div class="spmp_style__uploadHandle--test"><input type="file" id="${id}" accept="image/png,image/jpeg"></div>`;
  table("media", ["颜色", "SKC标题", "细节图", "方形图", "色块图"], [
    ["黑色", "黑色杯", mediaInput("black-detail"), mediaInput("black-square"), mediaInput("black-swatch")],
    ["红色", "红色杯", mediaInput("red-detail"), mediaInput("red-square"), mediaInput("red-swatch")],
  ]);
  const run = async args => {
    const result = await dom.window.eval(`(${sheinRowsPage})(${JSON.stringify({ href, categoryPath, ...args })})`);
    return JSON.parse(JSON.stringify(result));
  };
  return { run, table, document, window: dom.window, publishes: () => publishes, saves: () => saves };
}

test("reads split SHEIN tables and updates only the matching SKU across different header and row orders", async t => {
  const { run, document, publishes, saves } = fixture(t);
  const inspected = await run();
  assert.deepEqual(inspected.tables.supply, [["黑色", "500 ml"], ["红色", "500 ml"]]);
  assert.deepEqual(inspected.tables.package, [["红色", "500 ml"], ["黑色", "500 ml"]]);
  const row = { options: ["黑色", "500 ml"], priceUsd: "12.50", sellerSku: "PL-01", weightG: 331, lengthCm: 22, widthCm: 10, heightCm: 9 };
  const result = await run({ kind: "fill", rows: [row], dimensions: { widthCm: 9, lengthCm: 21, heightCm: 8, diameterCm: 7 } });
  assert.deepEqual(result.issues, []);
  assert.equal(result.items.length, 10);
  assert.equal(document.getElementById("black-price").value, "12.50");
  assert.equal(document.getElementById("black-code").value, "PL-01");
  assert.equal(document.getElementById("black-weight").value, "331");
  assert.deepEqual([...document.querySelectorAll("#package tbody tr")].map(row => [...row.cells[0].querySelectorAll("input")].map(input => input.value)), [
    ["", "", ""], ["22", "10", "9"],
  ]);
  assert.deepEqual([...document.querySelectorAll("#size input")].map(input => input.value), ["9", "21", "8", "7"]);
  assert.equal(document.getElementById("red-price").value, "");
  assert.equal(document.getElementById("red-weight").value, "");
  const repeated = await run({ kind: "fill", rows: [row] });
  assert.equal(repeated.items.length, 6);
  assert.ok(repeated.items.every(item => item.status === "unchanged"));
  assert.equal(publishes() + saves(), 0);
});

test("rejects unbound categories, duplicate SKU rows and invalid positive amounts", async t => {
  const { run, document } = fixture(t);
  const request = { kind: "fill", rows: [{ options: ["黑色", "500 ml"], priceUsd: "-1" }] };
  assert.equal((await run({ ...request, categoryPath: ["鞋子"] })).code, "SHEIN_EDIT_CONTEXT_CHANGED");
  assert.equal((await run(request)).issues[0].code, "SHEIN_ROW_FIELD");
  const table = document.querySelector("#supply tbody");
  table.append(table.rows[0].cloneNode(true));
  const duplicate = await run({ kind: "fill", expectSupply: true, rows: [{ options: ["黑色", "500 ml"], priceUsd: "1.29" }] });
  assert.deepEqual(duplicate.items, []);
  assert.equal(duplicate.issues[0].code, "SHEIN_ROW_FIELD");
  assert.ok([...document.querySelectorAll("#supply input")].every(input => input.value === ""));
});

test("writes the supplied sock shaft height in its own centimeter column", async t => {
  const { run, table, document } = fixture(t);
  table("size", ["宽度 (cm)", "筒高(cm)", "长度 (cm)", "高度 (cm)"], [Array(4).fill("<input>")]);
  const heights = () => [...document.querySelectorAll("#size input")].map(input => input.value);
  assert.deepEqual((await run({ kind: "fill", dimensions: { widthCm: 8, lengthCm: 21, heightCm: 10 } })).issues, []);
  assert.deepEqual(heights(), ["8", "", "21", "10"]);
  const supplied = await run({ kind: "fill", dimensions: { shaftHeightCm: 17.5 } });
  assert.deepEqual(supplied.issues, []);
  assert.deepEqual(supplied.items, [{ label: "产品筒高 (cm)", status: "filled" }]);
  assert.deepEqual(heights(), ["8", "17.5", "21", "10"]);
});

test("binds a default row to a unique visible SKC, reports required image headers, and uploads to the same row", async t => {
  const { run, table, document, window, publishes, saves } = fixture(t);
  const id = "se261119171434502395170";
  const key = `SKC：${id}`;
  table("supply", ["主规格", "价格(USD)", "商家SKU", "SKU图"], [[key, '<input id="price">', '<input id="code">', ""]]);
  table("package", ["主规格", "含包装重量 (g)", "含包装尺寸"], [[key, '<input id="weight">', ""]]);
  table("media", ["主规格", "SKC标题（商详标题）", '<div class="spmp_style__requiredTitle--test">方形图</div>', "色块图"],
    [[key, '<textarea id="skc-title" placeholder="非必填，不填则默认展示SPU标题"></textarea><textarea id="translation"></textarea>',
      '<div><input type="file" accept="image/png"></div>', ""]]);
  const field = document.querySelector('#media input[type="file"]');
  simulateFileInput(window, field);
  field.onchange = () => appendThumbnail(field, "https://img.ltwebstatic.com/v4/j/spmp/fixture.png");
  const initial = await run();
  assert.equal(initial.tables.defaultSku, id);
  assert.equal(initial.tables.defaultPackageSku, id);
  assert.equal(initial.tables.defaultSellerSku, undefined);
  assert.deepEqual(initial.tables.supply, [[]]);
  assert.deepEqual(initial.tables.media, [[]]);
  assert.equal(initial.tables.swatchRequired, false);
  assert.deepEqual(initial.validation.map(({ code, label }) => [code, label]), [["IMAGE_REQUIRED", "方形图"]]);

  const rows = [{ options: [], priceUsd: "39.90", sellerSku: "PL-KB-TKL-01", weightG: "800" }];
  await run({ kind: "fill", defaultSku: "another-sku", rows });
  assert.equal(document.getElementById("price").value, "");
  const filled = await run({ kind: "fill", defaultSku: id, rows, skcTitle: "Compact wired keyboard" });
  assert.deepEqual(filled.issues, []);
  assert.equal(filled.tables.defaultSellerSku, "PL-KB-TKL-01");
  assert.deepEqual(["price", "code", "weight"].map(name => document.getElementById(name).value), ["39.90", "PL-KB-TKL-01", "800"]);
  assert.equal(document.getElementById("skc-title").value, "Compact wired keyboard");
  assert.equal(document.getElementById("translation").value, "");
  await run({ kind: "fill", defaultSku: id, rows, skcTitle: "Do not replace a nonempty title" });
  assert.equal(document.getElementById("skc-title").value, "Compact wired keyboard");
  const upload = { role: "square", options: [], files: [{ name: "photo.png", type: "image/png", base64: "aGVsbG8=" }] };
  assert.equal((await run({ kind: "upload", upload })).ok, false);
  assert.equal((await run({ kind: "upload", defaultSku: id, upload })).status, "verified");
  assert.deepEqual((await run()).validation, []);
  document.getElementById("media").hidden = true;
  const partial = await run();
  assert.equal(partial.tables.defaultPackageSku, id);
  assert.equal(partial.tables.defaultSku, undefined);
  assert.equal(partial.tables.defaultSellerSku, "PL-KB-TKL-01");
  document.getElementById("media").hidden = false;
  document.querySelector("#package tbody td").textContent = "SKC: different-id";
  assert.equal((await run()).tables.defaultSku, undefined);
  assert.equal((await run({ kind: "upload", defaultSku: id, upload })).ok, false);
  assert.equal(publishes() + saves(), 0);
});

test("waits for the requested supply row and its price and merchant-code inputs, even when other SKUs are already visible", async t => {
  const { run, document, publishes, saves } = fixture(t);
  const body = document.querySelector("#supply tbody");
  const black = body.rows[0];
  const price = document.getElementById("black-price");
  const code = document.getElementById("black-code");
  black.remove();
  price.remove();
  code.disabled = true;
  setTimeout(() => body.prepend(black), 90);
  setTimeout(() => black.cells[2].append(price), 210);
  setTimeout(() => { code.disabled = false; }, 280);

  const result = await run({ kind: "fill", expectSupply: true, rows: [
    { options: ["黑色", "500 ml"], priceUsd: "39.50", sellerSku: "PL-SHEIN-BK" },
    { options: ["红色", "500 ml"], priceUsd: "42.00", sellerSku: "PL-SHEIN-RD" },
  ] });
  assert.deepEqual(result.issues, []);
  assert.equal(result.items.length, 4);
  assert.equal(price.value, "39.50");
  assert.equal(code.value, "PL-SHEIN-BK");
  assert.equal(document.getElementById("red-price").value, "42.00");
  assert.equal(document.getElementById("red-code").value, "PL-SHEIN-RD");
  assert.equal(publishes() + saves(), 0);
});

test("retries only deferred supply fields when the first SKU row reappears after media processing", async t => {
  const { run, document, publishes, saves } = fixture(t);
  const options = ["黑色", "500 ml"];
  const early = document.getElementById("black-code");
  early.disabled = true;
  const first = await run({ kind: "fill", rows: [{ options, priceUsd: 39.5, sellerSku: "PL-01", weightG: 340 }] });
  assert.deepEqual(first.issues.map(issue => issue.supply), [{ options, key: "sellerSku" }]);
  assert.equal(document.getElementById("black-price").value, "39.5");
  assert.equal(document.getElementById("black-weight").value, "340");
  early.disabled = false;
  const retry = await run({ kind: "retrySupply", expectSupply: true, rows: [{ options, sellerSku: "PL-01", weightG: 400 }] });
  assert.deepEqual(retry.issues, []);
  assert.deepEqual(retry.items.map(item => item.label), ["黑色 / 500 ml 商家 SKU"]);
  assert.equal(early.value, "PL-01");
  assert.equal(document.getElementById("black-price").value, "39.5");
  assert.equal(document.getElementById("black-weight").value, "340");
  assert.equal(document.getElementById("red-code").value, "");
  assert.equal(publishes() + saves(), 0);
});

test("binds the selected SKC image cell and waits for the remote preview instead of counting the local blob", async t => {
  const { run, document, window } = fixture(t);
  const black = document.getElementById('black-detail');
  const red = document.getElementById('red-detail');
  simulateFileInput(window, black);
  let called = 0;
  let serverPreview = false;
  black.onchange = () => {
    called++;
    const { image: preview } = appendThumbnail(black, "blob:https://sellerhub.shein.com/local");
    setTimeout(() => {
      serverPreview = true;
      preview.src = "https://example.test/confirmed.png";
    }, 110);
  };
  red.onchange = () => assert.fail("different SKC upload attempted");
  const upload = await run({ kind: "upload", upload: { role: "detail", options: ["黑色"],
    files: [{ name: "sample.png", type: "image/png", base64: "iVBORw0KGgo=" }] } });
  assert.deepEqual(upload, { ok: true, status: "verified" });
  assert.equal(called, 1);
  assert.equal(serverPreview, true);
  assert.equal(black.files[0].name, "sample.png");
  assert.equal(red.files.length, 0);
});

test("recognizes the required swatch column and verifies removal of the matching row's upload error", async t => {
  const { run, document, window, publishes, saves } = fixture(t);
  const black = document.getElementById("black-swatch");
  const red = document.getElementById("red-swatch");
  simulateFileInput(window, black);
  const error = document.createElement("span");
  error.textContent = "请上传色块图";
  black.closest("td").append(error);
  red.closest("td").append(error.cloneNode(true));
  assert.equal((await run()).tables.swatchRequired, true);
  assert.deepEqual((await run()).tables.swatches, []);
  appendThumbnail(red, "https://cdn.test/manual-red.png");
  assert.deepEqual((await run()).tables.swatches, []);
  let cleared = false;
  black.onchange = () => {
    assert.equal(black.files.length, 1);
    appendThumbnail(black, "https://cdn.test/verified-black.png");
    setTimeout(() => { error.remove(); cleared = true; }, 360);
  };
  const result = await run({ kind: "upload", upload: { role: "swatch", options: ["黑色"],
    files: [{ name: "black-swatch.png", type: "image/png", base64: "iVBORw0KGgo=" }] } });
  assert.deepEqual(result, { ok: true, status: "verified" });
  assert.equal(cleared, true);
  assert.deepEqual((await run()).tables.swatches, [["黑色"]]);
  assert.match(red.closest("td").textContent, /请上传色块图/u);
  assert.equal(publishes() + saves(), 0);
});

test("replays a main-spec image batch idempotently while its previews remain in the same cell", async t => {
  const { run, document, window, publishes, saves } = fixture(t);
  const black = document.getElementById('black-detail');
  const red = document.getElementById('red-detail');
  simulateFileInput(window, black);
  black.accept = "image/jpeg,image/png,image/gif";
  appendThumbnail(red, "https://example.test/unverified-red-hero.png");
  red.onchange = () => assert.fail("unverified red cover should not be altered");
  const files = [
    { name: "front.jpg", type: "image/jpeg", base64: "/9j/2Q==" },
    { name: "detail.png", type: "image/png", base64: "iVBORw0KGgo=" },
    { name: "gallery.gif", type: "image/gif", base64: "R0lGODlh" },
  ];
  const uploaded = [];
  black.onchange = () => {
    assert.equal(black.files.length, 1);
    const [file] = black.files;
    uploaded.push(file.name);
    appendThumbnail(black, `https://example.test/shein/${uploaded.length}/${file.name}`);
  };
  const gallery = files => run({ kind: "upload", upload: { role: "detail", options: ["黑色"], files } });
  assert.equal((await run({ kind: "upload", upload: { role: "detail", options: ["红色"], files: [files[0]] } })).code,
    "SHEIN_IMAGE_REVIEW");
  assert.deepEqual(await gallery(files), { ok: true, status: "verified" });
  assert.deepEqual(uploaded, ["front.jpg", "detail.png", "gallery.gif"]);
  assert.deepEqual(await gallery(files), { ok: true, status: "unchanged" });
  assert.equal((await gallery(files.slice().reverse())).code, "SHEIN_IMAGE_REVIEW");
  assert.deepEqual(await gallery([{ ...files[0], name: "same-photo.jpg" }]), { ok: true, status: "unchanged" });
  assert.equal(uploaded.length, 3);
  black.parentElement.lastElementChild.remove();
  assert.deepEqual(await gallery(files), { ok: true, status: "verified" });
  assert.deepEqual(uploaded, ["front.jpg", "detail.png", "gallery.gif", "gallery.gif"]);
  black.parentElement.querySelector('[class*="uploadImgItemExist"]').remove();
  assert.equal((await gallery(files)).code, "SHEIN_IMAGE_REVIEW");
  assert.equal(uploaded.length, 4);
  assert.equal(publishes() + saves(), 0);
});

test("requires currently accepted media types and a unique SKU image slot", async t => {
  const { run, document, window } = fixture(t);
  const variant = document.querySelector('#supply tbody tr:first-child td:nth-child(5) input');
  simulateFileInput(window, variant);
  let changed = 0;
  variant.onchange = () => {
    changed++;
    variant.parentElement.append(Object.assign(document.createElement("img"), { src: "https://example.test/shein/sku.png" }));
  };
  const submit = files => run({ kind: "upload", upload: { role: "variant", options: ["黑色", "500 ml"], files } });
  assert.equal((await submit([{ name: "not-allowed.gif", type: "image/gif", base64: "R0lGODlh" }])).code, "SHEIN_IMAGE_FORMAT");
  const file = { name: "sku.png", type: "image/png", base64: "iVBORw0KGgo=" };
  assert.deepEqual(await submit([file]), { ok: true, status: "verified" });
  assert.equal(changed, 1);
  assert.deepEqual(await submit([file]), { ok: true, status: "unchanged" });
  assert.equal((await submit([{ ...file, base64: "iVBORw0KGgoA" }])).code, "SHEIN_IMAGE_OCCUPIED");
  assert.equal(changed, 1);
});

test("verifies a SHEIN-generated square only for its known hero in the same SKC row", async t => {
  const { run, document, window } = fixture(t);
  const detail = document.getElementById("black-detail");
  const square = document.getElementById("black-square");
  const redSquare = document.getElementById("red-square");
  simulateFileInput(window, detail);
  const base = "https://img.ltwebstatic.com/v4/j/spmp/photo";
  const file = { name: "hero.png", type: "image/png", base64: "iVBORw0KGgo=" };
  const visited = [];
  for (const input of [detail, square, redSquare]) {
    input.closest("td").scrollIntoView = () => visited.push(input.id);
  }
  detail.onchange = () => {
    const { holder, image } = appendThumbnail(detail, "blob:https://sellerhub.shein.com/processing");
    const notice = document.createTextNode("加载中...");
    holder.append(notice);
    setTimeout(() => {
      notice.remove();
      image.src = base + "_square.png";
      appendThumbnail(square, base + ".png");
      appendThumbnail(redSquare, base + ".png");
      square.remove();
    }, 150);
  };
  square.onchange = redSquare.onchange = () => assert.fail("should not overwrite an existing square preview");
  const change = (role, options, file) => run({ kind: "upload", upload: { role, options, files: [file] } });
  assert.deepEqual(await change("detail", ["黑色"], file), { ok: true, status: "verified" });
  assert.deepEqual(await change("square", ["黑色"], file), { ok: true, status: "verified" });
  assert.deepEqual(await change("square", ["黑色"], file), { ok: true, status: "unchanged" });
  assert.equal((await change("square", ["红色"], file)).code, "SHEIN_IMAGE_OCCUPIED");
  assert.equal((await change("square", ["黑色"], { ...file, base64: "iVBORw0KGgoA" })).code, "SHEIN_IMAGE_OCCUPIED");
  assert.ok(visited.includes("black-detail") && visited.includes("black-square"));
});

test("waits for an existing gallery upload to settle before deciding whether to upload", async t => {
  const { run, document, window } = fixture(t);
  const detail = document.getElementById("black-detail");
  simulateFileInput(window, detail);
  const { holder, image } = appendThumbnail(detail, "blob:https://sellerhub.shein.com/processing");
  const notice = document.createTextNode("加载中...");
  holder.append(notice);
  detail.onchange = () => assert.fail("an unverifiable previous upload should be left alone");
  let loaded = false;
  setTimeout(() => {
    notice.remove();
    image.src = "https://img.ltwebstatic.com/v4/j/spmp/other_square.jpg";
    loaded = true;
  }, 300);
  const result = await run({ kind: "upload", upload: { role: "detail", options: ["黑色"],
    files: [{ name: "hero.png", type: "image/png", base64: "iVBORw0KGgo=" }] } });
  assert.equal(loaded, true);
  assert.equal(result.code, "SHEIN_IMAGE_REVIEW");
});

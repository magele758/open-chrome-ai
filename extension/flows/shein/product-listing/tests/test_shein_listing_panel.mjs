import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { readSheinProductDirectory, readSheinProductImages } from "../sidepanel/product-directory.js";
import { bindSheinListingPanel } from "../sidepanel/listing-panel.js";

const html = await readFile(new URL("../../../../sidepanel/index.html", import.meta.url), "utf8");
const list = "https://sellerhub.shein.com/#/spmp/commdities/list";
const tick = () => new Promise(resolve => setImmediate(resolve));
const absent = () => Object.assign(new Error("missing"), { name: "NotFoundError" });

function directory(name, children) {
  return {
    name, kind: "directory",
    async getFileHandle(key) {
      if (children[key]?.kind !== "file") throw absent();
      return children[key];
    },
    async getDirectoryHandle(key) {
      if (children[key]?.kind !== "directory") throw absent();
      return children[key];
    },
    async *values() { yield* Object.values(children); },
  };
}

const file = (name, data, type) => ({ kind: "file", name, getFile: async () => new File([data], name, { type }) });
const product = (name, input, images = {}) => directory(name, {
  "product.json": file("product.json", JSON.stringify(input), "application/json"),
  images: directory("images", images),
});
const image = file("hero.jpg", "binary", "image/jpeg");

test("loads the selected JSON and only accesses manifest images contained in the selected product folder", async () => {
  const first = product("first", {
    title: "Shirt", imagePath: "images/hero.jpg", mainImages: ["images/hero.jpg", "https://example.com/p.jpg"],
    detailImages: ["../outside.jpg", "images/absent.jpg"], skus: [{ imagePath: "images/hero.jpg" }],
  }, { "hero.jpg": image });
  const root = directory("Catalog", { first, bad: product("bad", { title: "" }), ".private": product(".private", { title: "Hidden" }) });
  const result = await readSheinProductDirectory(root);
  assert.deepEqual(result.products.map(({ title }) => title), ["Shirt"]);
  assert.match(result.issues[0], /bad.*标题/);
  const images = await readSheinProductImages(result.products[0]);
  assert.deepEqual(images.images.map(({ name, role }) => [name, role]), [["hero.jpg", "main"], ["hero.jpg", "variant"]]);
  assert.equal(images.images[0].file.name, "hero.jpg");
  assert.deepEqual(images.issues, ["图片 images/absent.jpg · 目录中未找到"]);
});

test("preserves separate color hero, square, swatch and SKU assets plus shared gallery paths", async () => {
  const root = directory("Shirt", {
    "product.json": file("product.json", JSON.stringify({
      title: "Shirt",
      detailImages: ["images/common.jpg"],
      variantGroups: [{ name: "Color", options: [{ value: "Black", imagePath: "black/hero.jpg" }] }],
      skus: [{ imagePath: "black/sku.jpg" }],
      shein: {
        sharedGalleryImages: ["images/common.jpg", "black/hero.jpg", "../other/private.jpg"],
        variantGroups: [{ name: "Color", options: [
          { value: "Black", imagePath: "black/hero.jpg", squareImagePath: "black/detail.jpg", swatchImagePath: "black/detail.jpg" },
          { value: "White", imagePath: "white/hero.jpg", squareImagePath: "white/detail.jpg" },
        ] }],
        skus: [{ imagePath: "white/sku.jpg" }],
      },
    }), "application/json"),
    images: directory("images", { "common.jpg": file("common.jpg", "shared", "image/jpeg") }),
    black: directory("black", {
      "hero.jpg": file("hero.jpg", "black", "image/jpeg"), "detail.jpg": file("detail.jpg", "detail black", "image/jpeg"),
      "sku.jpg": file("sku.jpg", "sku black", "image/jpeg"),
    }),
    white: directory("white", {
      "hero.jpg": file("hero.jpg", "white", "image/jpeg"), "detail.jpg": file("detail.jpg", "detail white", "image/jpeg"),
      "sku.jpg": file("sku.jpg", "sku white", "image/jpeg"),
    }),
  });
  const { products: [selected] } = await readSheinProductDirectory(root);
  const result = await readSheinProductImages(selected);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.images.map(({ path, role }) => [path, role]), [
    ["images/common.jpg", "detail"], ["images/common.jpg", "shared-gallery"], ["black/hero.jpg", "shared-gallery"],
    ["black/hero.jpg", "variant"], ["black/detail.jpg", "variant-square"], ["black/detail.jpg", "variant-swatch"],
    ["white/hero.jpg", "variant"], ["white/detail.jpg", "variant-square"],
    ["black/sku.jpg", "variant"], ["white/sku.jpg", "variant"],
  ]);
  const heroes = result.images.filter(image => image.role === "variant" && image.name === "hero.jpg");
  assert.deepEqual(await Promise.all(heroes.map(({ file }) => file.text())), ["black", "white"]);
  assert.equal(result.images.find(image => image.role === "detail").file, result.images.find(image => image.role === "shared-gallery").file);
});

test("imports a photo-only product directory without guessing its variants", async () => {
  const folder = directory("陶瓷马克杯", {
    "01-front.jpg": file("01-front.jpg", "front", "image/jpeg"),
    ".hidden.jpg": file(".hidden.jpg", "hidden", "image/jpeg"),
    images: directory("images", { "hero.jpg": image }),
    "notes.txt": file("notes.txt", "not an image", "text/plain"),
  });
  const { products, issues } = await readSheinProductDirectory(folder);
  assert.deepEqual(issues, []);
  assert.equal(products.length, 1);
  assert.deepEqual(products[0].input, { title: "陶瓷马克杯", imagePath: "images/hero.jpg", detailImages: ["01-front.jpg"] });
  const { images, issues: imageIssues } = await readSheinProductImages(products[0]);
  assert.deepEqual(imageIssues, []);
  assert.deepEqual(images.map(({ path, role }) => [path, role]), [["images/hero.jpg", "main"], ["01-front.jpg", "detail"]]);
});

function mount(t) {
  const { window } = new JSDOM(html);
  const previous = globalThis.document;
  globalThis.document = window.document;
  t.after(() => { globalThis.document = previous; window.close(); });
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const get = key => document.getElementById(`shein-listing-${key}`);
  const describe = text => {
    get("description").value = text;
    get("description").dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  return { get, describe };
}

test("starts with one customer action, scopes photos separately, and displays only problems", async t => {
  const { get, describe } = mount(t);
  let tab = { id: 13, url: list };
  const calls = [];
  let approvalCount = 0;
  let photoReads = 0;
  let issues = [];
  const categoryPath = ["家居", "水具"];
  const open = bindSheinListingPanel({
    getTargetTab: async () => tab,
    authorize: async (url, options) => {
      approvalCount++;
      assert.equal(url, tab.url);
      assert.deepEqual(options, { userGesture: true, tabId: 13 });
    },
    pickDirectory: async () => product("first", {
      title: "Cup", description: "Original listing description", imagePath: "images/hero.jpg", shein: { categoryPath },
    }, {
      "hero.jpg": { ...image, getFile: () => { photoReads++; return image.getFile(); } },
    }),
    replay: async spec => {
      calls.push(spec);
      spec.onStep({ label: "正在填写商品", categoryPath: ["家居", "马克杯"] });
      return { ok: true, items: [{ label: "商品标题", status: "filled" }], issues };
    },
  });
  await open();
  assert.equal(get("dialog").open, true);
  assert.equal(approvalCount, 0);
  assert.equal(get("run").disabled, true);
  assert.equal(get("run").textContent, "开始上品");
  assert.equal(get("open"), null);
  assert.equal(get("inspect"), null);
  assert.equal(get("json"), null);
  assert.doesNotMatch(get("dialog").textContent, /JSON|试填/);
  describe("上一件商品的描述");
  get("pick").click();
  await tick();
  assert.equal(get("directory-status").textContent, "Cup");
  assert.equal(get("description").value, "");
  assert.equal(get("upload-row").hidden, false);
  assert.match(get("category").textContent, /家居 › 水具/);
  describe("杯身是不锈钢");
  get("run").click();
  await tick();
  assert.deepEqual(calls[0].images, []);
  assert.deepEqual(calls[0].referenceImages, []);
  assert.equal(calls[0].allowAI, false);
  assert.equal(photoReads, 0);
  assert.equal(calls[0].input.operatorNotes, "杯身是不锈钢");
  assert.equal(calls[0].input.description, "Original listing description");
  assert.equal(calls[0].url, list);
  assert.equal(get("status").dataset.state, "verified");
  assert.match(get("category").textContent, /家居 › 马克杯/);
  assert.equal(get("results").hidden, true);
  assert.equal(get("results").textContent, "");
  issues = [{ label: "材质", message: "请补充杯身材质。" }];
  get("ai").checked = true;
  get("run").click();
  await tick();
  assert.deepEqual(calls[1].images, []);
  assert.equal(calls[1].allowAI, true);
  assert.equal(calls[1].referenceImages[0].file.name, "hero.jpg");
  assert.equal(photoReads, 1);
  assert.equal(get("results").hidden, false);
  assert.equal(get("results").textContent, "材质 · 请补充杯身材质。");
  assert.equal(get("status").dataset.state, "needs-review");
  get("ai").checked = false;
  get("upload").checked = true;
  get("run").click();
  await tick();
  assert.equal(calls[2].images[0].file.name, "hero.jpg");
  assert.deepEqual(calls[2].referenceImages, []);
  assert.equal(get("upload").checked, false);
  tab = { ...tab, url: "https://www.shein.com/" };
  get("run").click();
  await tick();
  assert.equal(calls.length, 3);
  assert.equal(approvalCount, 3);
  assert.match(get("status").textContent, /切回 SHEIN 商家后台/);
});

test("uses a natural-language description without a directory", async t => {
  const { get, describe } = mount(t);
  const calls = [];
  const open = bindSheinListingPanel({
    getTargetTab: async () => ({ id: 13, url: list }),
    probeAccess: async () => true,
    replay: async request => { calls.push(request); return { ok: true }; },
  });
  await open();
  assert.equal(get("run").disabled, true);
  assert.equal(get("upload-row").hidden, true);
  describe("  白色陶瓷杯。容量 350 毫升。  ");
  assert.equal(get("run").disabled, false);
  get("run").click();
  await tick();
  assert.deepEqual(calls[0].input, {
    title: "白色陶瓷杯", description: "白色陶瓷杯。容量 350 毫升。", operatorNotes: "白色陶瓷杯。容量 350 毫升。",
  });
  assert.equal(calls[0].useActiveTab, true);
  assert.equal(get("results").hidden, true);
});

test("requires a default SKU choice on the same editor tab and renews consent for image upload", async t => {
  const { get } = mount(t);
  const editor = "https://sellerhub.shein.com/#/spmp/commoditiesInfo?mode=add";
  let tab = { id: 13, url: list };
  const calls = [];
  const choices = [{ sellerSku: "KB-BK", label: "黑色 · KB-BK" }, { sellerSku: "KB-WH", label: "白色 · KB-WH" }];
  const input = { title: "Keyboard", imagePath: "images/hero.jpg", shein: { englishTitle: "USB Keyboard" } };
  const open = bindSheinListingPanel({
    getTargetTab: async () => tab,
    probeAccess: async () => true,
    pickDirectory: async () => directory("Catalog", { first: product("first", input, { "hero.jpg": image }),
      second: product("second", { title: "Cup" }) }),
    replay: async request => {
      calls.push(request);
      return calls.length === 1
        ? { ok: true, tabId: 42, url: editor, defaultSkuChoices: choices }
        : { ok: true };
    },
  });
  await open();
  assert.equal(get("default-sku-row").hidden, true);
  get("pick").click();
  await tick();
  get("upload").checked = true;
  get("run").click();
  await tick();
  assert.deepEqual(calls[0].input, input);
  assert.equal(calls[0].uploadRequested, true);
  assert.equal(calls[0].images.length, 1);
  assert.equal(get("default-sku-row").hidden, false);
  assert.equal(get("default-sku").value, "");
  assert.deepEqual(Array.from(get("default-sku").options, option => option.value), ["", "KB-BK", "KB-WH"]);
  assert.equal(get("default-sku-upload").hidden, false);
  assert.equal(get("upload").checked, true);
  assert.equal(get("run").disabled, true);
  assert.equal(get("status").dataset.state, "needs-review");

  get("default-sku").value = "KB-WH";
  get("default-sku").dispatchEvent(new document.defaultView.Event("change"));
  assert.equal(get("run").disabled, false);
  tab = { id: 13, url: editor };
  get("run").click();
  await tick();
  assert.equal(calls.length, 1);
  assert.match(get("status").textContent, /切回刚才/);
  tab = { id: 42, url: editor };
  get("run").click();
  await tick();
  assert.equal(calls[1].tabId, 42);
  assert.deepEqual(calls[1].input.shein, { ...input.shein, defaultSku: "KB-WH" });
  assert.equal(calls[1].images.length, 1);
  assert.equal(calls[1].uploadRequested, true);
  assert.equal(get("status").dataset.state, "verified");
  assert.equal(get("default-sku-row").hidden, true);

  get("product").value = "1";
  get("product").dispatchEvent(new document.defaultView.Event("change"));
  assert.equal(get("default-sku").value, "");
  get("run").click();
  await tick();
  assert.deepEqual(calls[2].input, { title: "Cup" });
});

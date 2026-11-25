import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chooseTemuProductDirectory, createTemuSuggestionFilter, loadTemuProductDirectory, normalizeTemuListingInput, suggestTemuFields } from "../input.js";
import { loadProductDirectory } from "../../../../../native/product-directory.mjs";
import { handleRequest } from "../../../../../native/pagelens-host.mjs";
import { pickProductDirectory } from "../../../../../native/product-directory-picker.mjs";

test("normalizes the desktop listing format and converts kg to g without changing SKU values", () => {
  const product = normalizeTemuListingInput({
    title: " Beach Cup ", description: "Insulated travel cup", category: "家居 > 餐饮 > 运动杯", site: "美国站",
    origin: { country: "中国", province: "浙江省" }, weight: "0.22", length: 28, width: 24, height: 4, shipDays: 1,
    imagePath: "/products/cup/main.jpg", freightTemplate: "美国站模板", handlingTime: "1个工作日",
    variant: { name: "颜色", options: [
      { option: "白色", sku: "CUP-WHITE-1", price: "39.90", quantity: "0", imagePath: "/products/cup/white.jpg" },
      { option: "橙色", sku: "CUP-ORANGE-1", price: "42.90", quantity: 18, imagePath: "/products/other/orange.jpg" },
    ] },
  }, { root: "/products", folder: "cup" });
  assert.equal(product.title, "Beach Cup");
  assert.deepEqual(product.sites, ["美国站"]);
  assert.deepEqual(product.categoryPath, ["家居", "餐饮", "运动杯"]);
  assert.deepEqual(product.origin, { country: "中国", region: "浙江省" });
  assert.equal(product.weightG, "220");
  assert.equal(product.shipDays, "1");
  assert.deepEqual(product.mainImages, ["/products/cup/main.jpg"]);
  assert.deepEqual(product.variantImages, ["/products/cup/white.jpg"]);
  assert.equal(product.skus[0].price, "39.90");
  assert.equal(product.skus[0].quantity, "0");
  assert.equal(product.skus[0].lengthCm, "28");
  assert.equal(product.skus[1].sellerSku, "CUP-ORANGE-1");
  assert.equal(product.skus[1].imagePath, undefined);
  assert.equal(normalizeTemuListingInput({ title: "pasted", imagePath: "/private/image.jpg" }).mainImages.length, 0);
});

test("retains exact captured variants without using retail price, origin hints, ASINs or shipping stock as listing values", () => {
  const product = normalizeTemuListingInput({
    title: "Catalog tee", sourceCategory: "T-Shirts", countryOfOrigin: "Imported", sourcePrice: { amount: "9.49", currency: "USD" },
    variantGroups: [{ name: "Color", options: ["White", "Orange"] }, { name: "Size", options: ["S", "M"] }],
    skus: [
      { id: "B0CMNBJKPG", options: { Color: "White", Size: "M" }, sourcePrice: { amount: "9.49" } },
      { id: "B0F0000001", options: { Color: "Orange", Size: "S" }, inventory: [{ shipFrom: "US", quantity: "20" }] },
    ],
    temu: { categoryPath: ["女士服装", "上衣"], sites: ["美国站", "美国站"] },
  });
  assert.deepEqual(product.categoryPath, ["女士服装", "上衣"]);
  assert.deepEqual(product.sites, ["美国站"]);
  assert.equal(product.origin, undefined);
  assert.equal(product.sizes, undefined);
  assert.equal(product.composition, undefined);
  assert.equal(product.price, undefined);
  assert.equal(product.skus[0].price, undefined);
  assert.equal(product.skus[0].sellerSku, undefined);
  assert.equal(product.skus[1].quantity, undefined);
  assert.deepEqual(product.skus.map(({ id, options }) => ({ id, options })), [
    { id: "B0CMNBJKPG", options: { Color: "White", Size: "M" } },
    { id: "B0F0000001", options: { Color: "Orange", Size: "S" } },
  ]);
});

test("keeps explicit apparel, shipping and SKU settings separate from source evidence", () => {
  const product = normalizeTemuListingInput({
    title: "Women's top", sizes: ["XS"], composition: [{ material: "棉", percent: "100" }],
    temu: {
      sizes: [" S ", "M", "S"], composition: [{ material: "聚酯纤维", percent: "95.00" }, { material: "氨纶", percent: 5 }],
      origin: { country: "中国大陆", region: "广东省" }, manufacturingLocation: "中国大陆",
      skuClassification: "单品", sensitiveAttribute: "非敏感品", handlingTime: "2个工作日", freightTemplate: "示例模板",
    },
    skus: [{ id: "row-1", options: { Size: "S" }, skuClassification: "混合套装", sensitiveAttribute: "示例敏感属性" }],
  });
  assert.deepEqual(product.sizes, ["S", "M"]);
  assert.deepEqual(product.composition, [{ material: "聚酯纤维", percent: "95.00" }, { material: "氨纶", percent: "5" }]);
  assert.deepEqual(product.origin, { country: "中国大陆", region: "广东省" });
  assert.equal(product.manufacturingLocation, "中国大陆");
  assert.equal(product.skuClassification, "单品");
  assert.equal(product.sensitiveAttribute, "非敏感品");
  assert.equal(product.skus[0].skuClassification, "混合套装");
  assert.equal(product.skus[0].sensitiveAttribute, "示例敏感属性");
  assert.equal(product.freightTemplate, "示例模板");
  assert.equal(product.handlingTime, "2个工作日");
  assert.throws(() => normalizeTemuListingInput({ title: "Invalid top", composition: [{ material: "棉", percent: 150 }] }), /百分比/u);
});

test("native importer verifies auxiliary capture images and reports missing or symbolic files without dropping the product", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pagelens-temu-input-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, "shirt");
  await mkdir(join(folder, "images"), { recursive: true });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
  await Promise.all([writeFile(join(folder, "images/main.jpg"), jpeg), writeFile(join(folder, "images/detail.jpg"), jpeg),
    writeFile(join(root, "outside.jpg"), jpeg)]);
  await symlink(join(root, "outside.jpg"), join(folder, "images/alias.jpg"));
  await writeFile(join(folder, "product.json"), JSON.stringify({
    title: "Tee", imagePath: "images/main.jpg", mainImages: ["images/main.jpg", "images/alias.jpg"],
    detailImages: ["https://example.com/retail-detail.jpg", "images/detail.jpg"],
    imageFiles: [{ role: "detail", path: "images/detail.jpg" }, { role: "variant", path: "images/alias.jpg" }],
    variantGroups: [{ name: "Color", options: [{ value: "White", imagePath: "images/detail.jpg" }] }],
    skus: [{ id: "sku_1", options: { Color: "White" }, imagePath: "images/absent.jpg" }],
  }));
  const loaded = await loadTemuProductDirectory(root, { send: async ({ path }) => loadProductDirectory(path) });
  assert.deepEqual(loaded.issues, []);
  assert.deepEqual(loaded.products[0].missingImages, ["images/alias.jpg", "images/absent.jpg"]);
  const input = loaded.products[0].input;
  assert.deepEqual(input.mainImages, [join(folder, "images/main.jpg")]);
  assert.deepEqual(input.detailImages, [join(folder, "images/detail.jpg")]);
  assert.deepEqual(input.variantImages, [join(folder, "images/detail.jpg")]);
  assert.equal(input.skus[0].imagePath, undefined);
  assert.equal(input.variantGroups[0].options[0].imagePath, join(folder, "images/detail.jpg"));
});

test("picks a product folder and loads its validated manifest and images in the same action", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pagelens-temu-picker-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, "跨境商品 ");
  await mkdir(folder);
  await writeFile(join(folder, "product.json"), JSON.stringify({ title: "运动水杯", imagePath: "main.jpg" }));
  await writeFile(join(folder, "main.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]));
  const options = {
    authorize: async (permission, options) => {
      assert.equal(permission, "nativeMessaging");
      assert.deepEqual(options, { userGesture: true });
      return "";
    },
    choose: () => handleRequest({ op: "chooseProductDirectory", path: "/ignored" }, { pickDirectory: async () => folder }),
  };
  const selected = await chooseTemuProductDirectory(options);
  assert.equal(selected.directoryName, "跨境商品 ");
  assert.equal(selected.root, root);
  assert.deepEqual(selected.products[0].input.mainImages, [join(folder, "main.jpg")]);
  const invalid = join(root, "不完整商品");
  await mkdir(invalid);
  await writeFile(join(invalid, "product.json"), JSON.stringify({ title: "衣服", temu: { composition: "棉" } }));
  const batch = await chooseTemuProductDirectory({ ...options,
    choose: () => handleRequest({ op: "chooseProductDirectory" }, { pickDirectory: async () => root }),
  });
  assert.deepEqual(batch.products.map(product => product.folder), ["跨境商品 "]);
  assert.match(batch.issues[0].error, /商品成分/u);
  assert.equal(await chooseTemuProductDirectory({ ...options, choose: async () => ({ ok: true, cancelled: true }) }), null);
  await assert.rejects(chooseTemuProductDirectory({ ...options, authorize: async () => "拒绝连接本机助手",
    choose: () => assert.fail("the native dialog needs permission before opening"),
  }), /拒绝连接本机助手/u);
  assert.equal((await handleRequest({ op: "chooseProductDirectory", scope: "agent" }, {
    pickDirectory: () => assert.fail("the agent cannot open the native dialog"),
  })).ok, false);
});

test("native picker preserves paths and recognizes cancellation on macOS and Linux", async () => {
  const picked = await pickProductDirectory({ platform: "darwin", execute: async (program, args, options) => {
    assert.equal(program, "/usr/bin/osascript");
    assert.deepEqual(args.slice(0, 3), ["-l", "JavaScript", "-e"]);
    assert.ok(options.timeout <= 120_000);
    return { stdout: '"/商品目录 /"\n' };
  } });
  assert.equal(picked, "/商品目录 /");
  const linuxPrograms = [];
  const linuxPicked = await pickProductDirectory({ platform: "linux", execute: async program => {
    linuxPrograms.push(program);
    if (program === "zenity") throw Object.assign(new Error("absent"), { code: "ENOENT" });
    return { stdout: "/商品目录 \n" };
  } });
  assert.deepEqual(linuxPrograms, ["zenity", "kdialog"]);
  assert.equal(linuxPicked, "/商品目录 ");
  assert.equal(await pickProductDirectory({ platform: "linux", execute: async () => {
    throw Object.assign(new Error("cancel"), { code: 1 });
  } }), null);
});

test("suggests only live allowed option IDs and descriptive fields, preserving technical values and using one model call", async () => {
  const product = normalizeTemuListingInput({ title: "运动水杯", brand: "Test Brand", description: "蓝色波点，夏日户外使用。",
    attributes: { 材质: "塑料" }, temu: { attributes: { 季节: "夏季", 特点: "户外、通勤" } } });
  const schema = { fields: [
    { key: "english", label: "商品名称（英文）", kind: "text", required: true, maxLength: 35 },
    { key: "style", label: "风格", kind: "select", required: true, options: [{ label: "户外风", value: "5" }] },
    { key: "season", label: "季节", kind: "select", required: true, options: [{ label: "夏季", value: "12" }] },
    { key: "fabric", label: "材质", kind: "select", required: true, options: [{ label: "塑料", value: "plastic" }] },
    { key: "features", label: "特点", kind: "select", multiple: true, options: [{ label: "户外", value: "out" }, { label: "通勤", value: "work" }] },
    { key: "origin", label: "产地", kind: "select", required: true, options: [{ label: "中国", value: "cn" }] },
    { key: "length", label: "包裹长度", kind: "number", required: true },
    { key: "file", label: "商品描述", kind: "file", required: true },
    { key: "valid", label: "图案", kind: "select", required: true, value: "dots", options: [{ label: "波点", value: "dots" }] },
  ] };
  let calls = 0;
  const result = await suggestTemuFields(product, schema, {
    settings: { text: { baseUrl: "https://model.example", model: "configured-model", apiKey: "placeholder" } },
    request: async (model, { messages }) => {
      calls += 1;
      assert.equal(model.model, "configured-model");
      assert.deepEqual(JSON.parse(messages[1].content).fields.map(field => field.key), ["english", "style"]);
      return '{"english":"Outdoor Water Bottle","style":"NOT-LIVE","origin":"cn","length":"25","season":"BAD"}';
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.values, { season: "12", fabric: "plastic", features: ["out", "work"], english: "Outdoor Water Bottle" });
  assert.deepEqual(result.missing.map(field => field.key), ["style", "origin", "length"]);
  assert.deepEqual(result.rejected, [{ key: "style", label: "风格" }]);
});


test("probes only fields supported by product evidence or enabled text suggestions", () => {
  const product = { title: "Water Bottle", attributes: { 主体材质: "不锈钢" } };
  const material = { label: "主体材质", kind: "select" };
  const location = { label: "制造地点", kind: "select" };
  const season = { label: "季节", kind: "select" };
  const local = createTemuSuggestionFilter(product, { useModel: false });
  const withModel = createTemuSuggestionFilter(product);
  assert.equal(local(material), true);
  assert.equal(local(location), false);
  assert.equal(local(season), false);
  assert.equal(withModel(location), false);
  assert.equal(withModel(season), true);
});

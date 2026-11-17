import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
const flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagelens-flow-test-"));
process.env.PAGELENS_MX_FLOW_DIR = flowDir;
process.on("exit", () => rmSync(flowDir, { recursive: true, force: true }));
import { commercialPlan, sourceVariants } from "./tiktok-mx-commerce.mjs";
import { generateListing, matchingPlan, rememberPlan, chooseCategory, validateTranslatedTitle, selectDetails } from "./tiktok-mx-ptc.mjs";
const row = { sourceSkuId: "111", option: "M", stock: 5, priceMXN: 100 };
const origins = Object.fromEntries(
  [
    "brand",
    "packagedWeightGrams",
    "packageCm.length",
    "packageCm.width",
    "packageCm.height",
    "M.option",
    "M.stock",
    "M.priceMXN",
  ].map((k) => [
    k,
    {
      kind: k.endsWith(".priceMXN") ? "converted" : "estimated",
      basis: "test",
    },
  ]),
);
const previous = {
  title: "Old",
  description: "Old",
  salesAndShipping: {
    brand: "无品牌",
    axis: "Modelo",
    skus: [row],
    packagedWeightGrams: 500,
    packageCm: { length: 10, width: 8, height: 7 },
    origins,
  },
};
const source = {
  id: "1",
  skus: [{ id: "111", price: "1896", currency: "JPY" }],
};
let inFlight = 0,
  peak = 0;
const generated = await generateListing(
  source,
  previous,
  0.1161,
  async (prompt) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 8));
    inFlight--;
    return JSON.stringify({
      title: prompt.startsWith("Produce English") ? "English" : "Español",
      description: "Modelo M.",
    });
  },
);
assert.equal(peak, 2);
assert.equal(generated.copy.enTitle, "English");
assert.equal(generated.copy.title, "Español");
assert.equal(generated.copy.salesAndShipping.skus[0].priceMXN, 220);
assert.equal(row.priceMXN, 100);
assert.equal(generated.ptc.tool, "ptc_exec");
await assert.rejects(
  generateListing(source, previous, 0.1161, async () => "{}"),
  /Invalid generated/,
);
console.log(
  "PTC parallel generation, field merge, pricing and failure propagation passed",
);

const cloth = { id: "extra", options: ["専用クリーニングクロス【本商品は独立した単品で/布1枚のみとなります】"] };
const withAccessory = { ...source, title: "ボトル型製氷皿", skus: [...source.skus, cloth] };
const filtered = await generateListing(withAccessory, previous, 0.1161, async prompt => {
  assert.ok(!prompt.includes(cloth.options[0]));
  return JSON.stringify({ title: "Molde", description: "Hielo" });
});
assert.deepEqual(filtered.copy.salesAndShipping.skus.map(r => r.sourceSkuId), ["111"]);
assert.ok(filtered.copy.salesAndShipping.excludedSkus.extra.includes(cloth.options[0]));
assert.throws(() => commercialPlan({salesAndShipping:{...previous.salesAndShipping, skus:[{...row,sourceSkuId:"extra"}]}},withAccessory), /Standalone accessory/);
for (const label of ["Blanco", "製氷皿＋クリーニングクロス付き", "クリーニングクロス", "単品販売・ピンク"])
  assert.equal(sourceVariants({...source,title:"製氷皿",skus:[{id:"test",options:[label]}]}).skus.length, 1);
assert.equal(sourceVariants({...withAccessory,title:"クリーニングクロス"}).skus.length, 2);
{
  const titled = sourceVariants({
    title: "製氷皿（清潔布付き）",
    skus: [
      { id: "ice", options: ["ブルー"] },
      { id: "cloth", options: ["専用クリーニングクロス【本商品は独立した単品で/布1枚のみとなります】"] },
    ],
  });
  assert.deepEqual(titled.skus.map((sku) => sku.id), ["ice"]);
  assert.match(titled.excludedSkus.cloth, /クリーニングクロス/);
}
{
  const filter = sourceVariants({
    title: "空気清浄機 交換用フィルター",
    skus: [{ id: "filter", options: ["交換用フィルター 別売"] }],
  });
  assert.deepEqual(filter.skus.map((sku) => sku.id), ["filter"]);
  assert.equal(filter.excludedSkus.filter, undefined);
  const attached = sourceVariants({
    title: "空気清浄機 交換用フィルター付き",
    skus: [
      { id: "machine", options: ["本体"] },
      { id: "filter", options: ["交換用フィルター 別売"] },
    ],
  });
  assert.deepEqual(attached.skus.map((sku) => sku.id), ["machine"]);
  assert.match(attached.excludedSkus.filter, /交換用フィルター/);
}
{
  const detailUrls = [1, 2, 3, 4, 5].map((n) => "https://p16.tiktokcdn.com/d" + n + ".jpg");
  const rich = {
    id: "1",
    title: "製氷皿",
    gallery: ["https://p16.tiktokcdn.com/g.jpg"],
    detail: detailUrls,
    assets: [
      { name: "g.jpg", url: "https://p16.tiktokcdn.com/g.jpg" },
      ...detailUrls.map((url, index) => ({ name: "d" + (index + 1) + ".jpg", url })),
    ],
    skus: [
      { id: "111", options: ["Red"], stock: 7, price: "1000", currency: "JPY" },
      { id: "222", options: ["Blue"], stock: 3, price: "2000", currency: "JPY" },
    ],
  };
  const model = JSON.stringify({
    category: { search: "molde", label: "Cocina / Moldes" },
    attributes: {},
    salesAndShipping: {
      brand: "无品牌",
      axis: "Modelo",
      skus: [{ sourceSkuId: "111", option: "Blue", stock: 99, priceMXN: 1 }],
      excludedSkus: { 222: "任意排除" },
      packagedWeightGrams: 400,
      packageCm: { length: 10, width: 8, height: 6 },
      origins: {
        brand: { kind: "estimated", basis: "无品牌" },
        packagedWeightGrams: { kind: "estimated", basis: "估算包装" },
        "packageCm.length": { kind: "estimated", basis: "估算" },
        "packageCm.width": { kind: "estimated", basis: "估算" },
        "packageCm.height": { kind: "estimated", basis: "估算" },
        "Blue.option": { kind: "estimated", basis: "模型" },
        "Blue.stock": { kind: "source", basis: "模型库存" },
        "Blue.priceMXN": { kind: "seller", basis: "模型售价" },
      },
    },
  });
  const bound = await generateListing(rich, null, { value: 0.1161, date: "2026-11-17", source: "Banxico" }, async (prompt) =>
    prompt.startsWith("Prepare") ? model : JSON.stringify({ title: "Titulo", description: "Texto del producto." }));
  const rows = bound.copy.salesAndShipping.skus;
  assert.deepEqual(rows.map((sku) => sku.sourceSkuId), ["111", "222"]);
  assert.deepEqual(rows.map((sku) => sku.option), ["Red", "Blue"]);
  assert.deepEqual(rows.map((sku) => sku.stock), [7, 3]);
  assert.deepEqual(rows.map((sku) => sku.priceMXN), [116, 232]);
  assert.equal(bound.copy.salesAndShipping.excludedSkus["222"], undefined);
  for (const option of ["Red", "Blue"]) {
    const price = bound.copy.salesAndShipping.origins[option + ".priceMXN"];
    const stock = bound.copy.salesAndShipping.origins[option + ".stock"];
    assert.equal(price.kind, "converted");
    assert.match(price.basis, /汇率 0\.1161/);
    assert.match(price.basis, /日期 2026-11-17/);
    assert.match(price.basis, /来源 Banxico/);
    assert.equal(stock.kind, "estimated");
  }
  assert.deepEqual(bound.copy.details, ["d1.jpg", "d2.jpg", "d3.jpg", "d4.jpg", "d5.jpg"]);
  assert.deepEqual(bound.copy.missing, []);
  assert.deepEqual(selectDetails(rich, 2), {
    details: ["d1.jpg", "d2.jpg"],
    missing: ["d3.jpg", "d4.jpg", "d5.jpg"],
  });
}
{
  const priced = {
    id: "1",
    skus: [{ id: "111", options: ["M"], stock: 4, price: "1896", currency: "JPY" }],
  };
  const copyText = async (prompt) =>
    JSON.stringify({
      title: prompt.startsWith("Produce English") ? "English" : "Español",
      description: "Modelo M.",
    });
  const unverified = structuredClone(previous);
  unverified.salesAndShipping.skus = [{ sourceSkuId: "111", option: "M", stock: 9, priceMXN: 50 }];
  unverified.salesAndShipping.origins["M.stock"] = { kind: "seller", basis: "未核对库存" };
  unverified.salesAndShipping.origins["M.priceMXN"] = { kind: "seller", basis: "未核对售价" };
  const rate = { value: 0.1161, date: "2026-11-17", source: "Banxico" };
  const again = await generateListing(priced, unverified, rate, copyText);
  assert.equal(again.copy.salesAndShipping.skus[0].stock, 4);
  assert.equal(again.copy.salesAndShipping.skus[0].priceMXN, 220);
  assert.equal(again.copy.salesAndShipping.origins["M.stock"].kind, "estimated");
  assert.notEqual(again.copy.salesAndShipping.origins["M.stock"].verified, true);
  assert.equal(again.copy.salesAndShipping.origins["M.priceMXN"].kind, "converted");
  assert.notEqual(again.copy.salesAndShipping.origins["M.priceMXN"].verified, true);
  const verifiedPrior = structuredClone(unverified);
  verifiedPrior.salesAndShipping.origins["M.stock"] = { kind: "seller", basis: "已核对库存", verified: true };
  verifiedPrior.salesAndShipping.origins["M.priceMXN"] = { kind: "seller", basis: "已核对售价", verified: true };
  const keptSales = await generateListing(priced, verifiedPrior, rate, copyText);
  assert.equal(keptSales.copy.salesAndShipping.skus[0].stock, 9);
  assert.equal(keptSales.copy.salesAndShipping.skus[0].priceMXN, 50);
  assert.equal(keptSales.copy.salesAndShipping.origins["M.stock"].verified, true);
  assert.equal(keptSales.copy.salesAndShipping.origins["M.priceMXN"].verified, true);
  const explicit = await generateListing(priced, unverified, { ...rate, sellerPrices: { 111: 80 } }, copyText);
  assert.equal(explicit.copy.salesAndShipping.skus[0].priceMXN, 80);
  assert.equal(explicit.copy.salesAndShipping.origins["M.priceMXN"].kind, "seller");
  assert.equal(explicit.copy.salesAndShipping.origins["M.priceMXN"].verified, true);
  assert.equal(explicit.copy.salesAndShipping.skus[0].stock, 4);
}
{
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pagelens-mx-draft-"));
  process.env.PAGELENS_HOME = home;
  const draft = await import("./tiktok-mx-draft.mjs?draft-test");
  const sameTitle = "Vaso de vidrio\n商品ID：111\n草稿ID：222\nMX$ 10";
  const longer = "Vaso de vidrio templado\n商品ID：333\n草稿ID：444";
  assert.deepEqual(draft.selectDraftRows([{ text: longer }, { text: sameTitle }], "Vaso de vidrio"), [
    { text: sameTitle.slice(0, 450), id: "222" },
  ]);
  assert.equal(draft.draftIdOf("SKU ID：999\nID：222"), null);
  assert.equal(draft.draftTitleOf("Vaso de vidrio\ntemplado\n草稿ID：444"), "Vaso de vidrio templado");
  assert.notEqual(draft.draftTitleOf("Vaso de vidrio\ntemplado\n草稿ID：444"), "Vaso de vidrio");
  assert.deepEqual(draft.selectDraftRows([{ text: "Vaso de vidrio\ntemplado\n草稿ID：444" }], "Vaso de vidrio"), []);
  assert.deepEqual(draft.selectDraftRows([{ text: "新品\nVaso de vidrio\n草稿ID：222" }], "Vaso de vidrio"), []);
  assert.equal(draft.draftIdOf("草稿ID：111 草稿ID：222"), null);
  assert.equal(draft.draftIdOf("草稿ID：111\ndraft ID：222"), null);
  assert.equal(draft.draftIdOf("商品ID：111\n草稿ID：222"), "222");
  assert.equal(draft.draftListReady("总行数 1\nTotal rows", 0), false);
  assert.equal(draft.draftListReady("暂无商品", 0), true);
  assert.throws(
    () => draft.writableDraftId({
      matches: [{ id: "999", text: "Vaso de vidrio" }],
      previous: { startedTab: 4, draftIdsBefore: ["999"] },
    }),
    /Refusing to edit another draft/,
  );
  assert.throws(
    () => draft.writableDraftId({
      matches: [{ id: "999", text: "Vaso de vidrio" }],
      previous: { saving: true },
    }),
    /Refusing to edit another draft/,
  );
  assert.equal(draft.writableDraftId({
    matches: [{ id: "1000", text: "Vaso de vidrio" }],
    previous: { saving: true, draftIdsBefore: ["999"] },
  }), "1000");
  assert.equal(draft.imageHostAllowed("p16-sign.tiktokcdn-us.com"), true);
  assert.equal(draft.imageHostAllowed("img.tiktokcdn.com"), true);
  assert.equal(draft.imageHostAllowed("p16.ibyteimg.com"), true);
  assert.equal(draft.imageHostAllowed("img.tiktokcdn.eu"), true);
  assert.equal(draft.imageHostAllowed("tiktokcdnattacker.com"), false);
  assert.equal(draft.imageHostAllowed("tiktokcdn.com.evil.example"), false);
  assert.equal(draft.imageHostAllowed("tiktokcdn-evil.com"), false);
  assert.equal(draft.imageHostAllowed("tiktokcdn-attacker.com"), false);
  assert.equal(draft.imageHostAllowed("a.tiktokcdn-evil.com"), false);
  const run = await fs.mkdtemp(path.join(os.tmpdir(), "pagelens-mx-run-"));
  const image = path.join(run, "image-01.jpg");
  await fs.writeFile(image, "jpg");
  const outside = path.join(os.tmpdir(), "pagelens-mx-outside-" + process.pid + ".jpg");
  await fs.writeFile(outside, "secret");
  await fs.symlink(outside, path.join(run, "linked.jpg"));
  const assets = [{ name: "image-01.jpg" }, { name: "linked.jpg" }, { name: "/etc/passwd" }, { name: "../secret.jpg" }];
  assert.equal(path.basename(await draft.listingImage(run, "image-01.jpg", assets)), "image-01.jpg");
  await assert.rejects(draft.listingImage(run, "linked.jpg", assets), /symlink escapes/);
  await assert.rejects(draft.listingImage(run, "/etc/passwd", assets), /file name/);
  await assert.rejects(draft.listingImage(run, "../secret.jpg", assets), /file name/);
  await fs.unlink(outside);
  const product = "1729600000000000001";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pagelens-mx-verify-"));
  await fs.writeFile(path.join(dir, "image-01.jpg"), "jpg");
  const sourceFile = {
    id: product,
    url: "https://shop.tiktok.com/mx/pdp/" + product,
    assets: [{ name: "image-01.jpg", url: "https://p16.tiktokcdn.com/a.jpg" }],
    skus: [{ id: "111" }],
  };
  const listing = {
    title: "Molde",
    description: "Hielo",
    enTitle: "Mold",
    enDescription: "Ice",
    gallery: ["image-01.jpg"],
    details: [],
    category: { label: "Cocina" },
    salesAndShipping: {
      brand: "无品牌",
      axis: "Modelo",
      skus: [{ sourceSkuId: "111", option: "M", stock: 5, priceMXN: 100 }],
      packagedWeightGrams: 500,
      packageCm: { length: 10, width: 8, height: 7 },
      origins: Object.fromEntries(["brand", "packagedWeightGrams", "packageCm.length", "packageCm.width", "packageCm.height", "M.option", "M.stock", "M.priceMXN"].map((key) => [key, { kind: "estimated", basis: "fixture" }])),
    },
  };
  await fs.writeFile(path.join(dir, "source.json"), JSON.stringify(sourceFile));
  await fs.writeFile(path.join(dir, "listing.json"), JSON.stringify(listing));
  const receipt = { id: "555", verified: true, title: "Molde" };
  const record = { dir, id: "555", title: "Molde" };
  await fs.writeFile(path.join(dir, "receipt.json"), JSON.stringify(receipt));
  const recordDir = path.join(home, "mx-draft-sources");
  await fs.mkdir(recordDir, { recursive: true });
  const recordFile = path.join(recordDir, product + ".json");
  await fs.writeFile(recordFile, JSON.stringify(record));
  const beforeReceipt = await fs.readFile(path.join(dir, "receipt.json"));
  const beforeRecord = await fs.readFile(recordFile);
  const link = "https://seller.tiktokshopglobalselling.com/product/edit-draft/555?shop_region=MX";
  let scripts = 0;
  draft.setDraftBridgeForTests(async (tool, args) => {
    if (tool === "open_tab") return { tabId: args.url.includes("edit-draft") ? 8 : 7, groupId: 1 };
    if (tool === "run_js") {
      scripts += 1;
      if (scripts === 1) return { ok: true, result: { matches: [{ id: "555", text: "Molde" }], ids: ["555"] } };
      return { ok: false, error: "captcha" };
    }
    return { ok: true };
  });
  const logs = [];
  const log = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await assert.rejects(draft.save(dir, true), /captcha/);
    assert.deepEqual(await fs.readFile(path.join(dir, "receipt.json")), beforeReceipt);
    assert.deepEqual(await fs.readFile(recordFile), beforeRecord);
    assert.equal(logs.some((line) => line.includes('"verified"')), false);
    scripts = 0;
    let snapshots = 0, reloads = 0;
    draft.setDraftBridgeForTests(async (tool, args) => {
      if (tool === "open_tab") return { tabId: args.url.includes("edit-draft") ? 8 : 7, groupId: 1 };
      if (tool === "reload_tab") { if (args.tabId === 8) reloads++; return {}; }
      if (tool === "run_js") {
        if (String(args.code).includes("readDraftList"))
          return { ok: true, result: { matches: [{ id: "555", text: "Molde" }], ids: ["555"] } };
        if (args.code.endsWith("return performance.timeOrigin")) return { ok: true, result: 1000 };
        snapshots++;
        return {
          ok: true,
          result: {
            url: link,
            title: "Molde",
            description: "Hielo",
            enTitle: snapshots === 2 ? "Old translation" : "Mold",
            enDescription: "Ice",
            gallery: 1,
            detailImages: 0,
            category: "Cocina",
            captcha: false,
            salesAndShipping: {
              brand: "无品牌",
              axes: ["Modelo"],
              options: [["M"]],
              skus: snapshots === 1 ? [] : [{ label: "M", stock: 5, priceMXN: 100 }],
              packagedWeightGrams: 500,
              dimensionsInCm: true,
              packageCm: { length: 10, width: 8, height: 7 },
            },
          },
        };
      }
      if (tool === "close_tab") return { ok: true };
      if (tool === "list_tabs") return [];
      return { ok: true };
    });
    await draft.save(dir, true);
    assert.equal(snapshots, 3);
    assert.ok(reloads >= 3);
    assert.deepEqual(await fs.readFile(path.join(dir, "receipt.json")), beforeReceipt);
    assert.deepEqual(await fs.readFile(recordFile), beforeRecord);
    assert.equal(logs.some((line) => line.includes('"verified":true') || line.includes('"verified": true')), true);
  } finally {
    console.log = log;
    draft.setDraftBridgeForTests(null);
  }
  const retryProduct = "1729600000000000002";
  const retryDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagelens-mx-retry-"));
  await fs.writeFile(path.join(retryDir, "image-01.jpg"), "jpg");
  await fs.writeFile(path.join(retryDir, "source.json"), JSON.stringify({
    ...sourceFile,
    id: retryProduct,
    url: "https://shop.tiktok.com/mx/pdp/" + retryProduct,
  }));
  await fs.writeFile(path.join(retryDir, "listing.json"), JSON.stringify(listing));
  const opened = [];
  draft.setDraftBridgeForTests(async (tool, args) => {
    if (tool === "open_tab") {
      opened.push(args.url);
      return { tabId: 7, groupId: 1 };
    }
    if (tool === "run_js") return { ok: true, result: { matches: [], ids: [] } };
    if (tool === "list_tabs") return [];
    if (tool === "close_tab") return { ok: true };
    return { ok: true };
  });
  await fs.writeFile(path.join(retryDir, "receipt.json"), JSON.stringify({
    startedTab: 4,
    groupOwned: true,
    title: "Molde",
  }));
  await assert.rejects(draft.save(retryDir, false, false, null, null, null, 99), /Previous save pending/);
  assert.equal(opened.some((url) => url.includes("/product/create")), false);
  const reuseProduct = "1729600000000000003";
  const reuseDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagelens-mx-reuse-"));
  await fs.writeFile(path.join(reuseDir, "image-01.jpg"), "jpg");
  await fs.writeFile(path.join(reuseDir, "source.json"), JSON.stringify({
    ...sourceFile,
    id: reuseProduct,
    url: "https://shop.tiktok.com/mx/pdp/" + reuseProduct,
  }));
  await fs.writeFile(path.join(reuseDir, "listing.json"), JSON.stringify(listing));
  await fs.writeFile(path.join(reuseDir, "receipt.json"), JSON.stringify({
    startedTab: 4,
    groupOwned: true,
    title: "Molde",
  }));
  opened.length = 0;
  await assert.rejects(draft.save(reuseDir), /agent-inbox|ENOENT/);
  assert.equal(opened.some((url) => url.includes("/product/create")), false);
  assert.equal(JSON.parse(await fs.readFile(path.join(reuseDir, "receipt.json"), "utf8")).startedTab, 4);
  draft.setDraftBridgeForTests(null);
}

const file = generated.ptc.file;
const originalProgram = await fs.readFile(file, "utf8");
await fs.writeFile(file, originalProgram.replace("Produce English", "Local English"));
const updated = await generateListing(source, previous, 0.1161, async prompt => JSON.stringify({
  title: prompt.startsWith("Local English") ? "Hot-loaded" : "Local", description: "OK",
}));
assert.equal(updated.copy.enTitle, "Hot-loaded");
assert.notEqual(updated.ptc.revision, generated.ptc.revision);
assert.equal(await fs.readFile(generated.ptc.snapshot, "utf8"), originalProgram);
await fs.writeFile(file, "return [];");
await assert.rejects(generateListing(source, previous, 0.1161, async () => "{}"), /omitted required/);
const category = await chooseCategory(source, ["Cookware / Racks", "Electronics / Ovens"], async () => '{"index":0}');
assert.equal(category.choice.label, "Cookware / Racks");
await assert.rejects(chooseCategory(source, ["Ovens"], async () => '{"index":2}'), /No suitable/);
await assert.rejects(validateTranslatedTitle(updated.copy, "Something else", async () => '{"valid":false}'), /translation differs/);
const sample = { ...source, id: "1733781903228241493", gallery: [], detail: [], skus: [{...source.skus[0],stock:4}] };
const link = "https://seller.tiktokshopglobalselling.com/product/edit-draft/123?shop_region=MX";
const receipt = { verified:true, id:"123", link, readback:{url:link, title:updated.copy.title, enTitle:updated.copy.enTitle} };
await rememberPlan(sample, updated.copy, receipt);
assert.equal((await matchingPlan(sample)).salesAndShipping.skus[0].stock, 4);
assert.equal(await matchingPlan({...sample, title:"Changed product"}), null);
await assert.rejects(rememberPlan(sample, updated.copy, {...receipt,verified:false}), /verified/);
console.log("PTC local revision replay, missing workers, confirmed category, title checks and cache invalidation passed");

const evidence = { kind: "estimated", basis: "Test estimate for this fixture" };
let active = 0, highest = 0;
const cold = await generateListing({ ...sample, assets: [] }, null, .1161, async prompt => {
  active++;
  highest = Math.max(active, highest);
  await new Promise(resolve => setTimeout(resolve, 8));
  active--;
  if (!prompt.startsWith("Prepare")) return JSON.stringify({title:"Rack",description:"Six slots"});
  return JSON.stringify({ category:{label:"Kitchen / Racks", search:"Racks"}, attributes:{},
    salesAndShipping:{brand:"无品牌",axis:"Modelo",packagedWeightGrams:300,packageCm:{length:18,width:11,height:13},
      evidence:{brand:evidence,weight:evidence,box:evidence}} });
});
assert.equal(highest, 3);
assert.equal(cold.copy.salesAndShipping.skus[0].stock, 4);
assert.equal(cold.copy.salesAndShipping.origins["packageCm.width"].basis, evidence.basis);
assert.equal(cold.copy.salesAndShipping.skus[0].priceMXN, 220);

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { rmSync } from "node:fs";
const flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagelens-flow-test-"));
process.env.PAGELENS_MX_FLOW_DIR = flowDir;
process.on("exit", () => rmSync(flowDir, { recursive: true, force: true }));
import { commercialPlan, sourceVariants } from "./tiktok-mx-commerce.mjs";
import { DraftTabs } from "./tiktok-mx-tabs.mjs";
import { generateListing, matchingPlan, rememberPlan, chooseCategory, categorySearchQuery, validateTranslatedTitle, selectDetails } from "./tiktok-mx-ptc.mjs";
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

  const quantities = {
    ...rich,
    title: "ご飯保存容器",
    skus: [
      { ...rich.skus[0], options: ["1 個"] },
      { ...rich.skus[1], options: ["3個"] },
      { id: "333", options: ["6 個"], stock: 4, price: "3000", currency: "JPY" },
    ],
  };
  const quantityOptions = [
    { sourceSkuId: "222", label: "3 piezas" },
    { sourceSkuId: "333", label: "6 piezas" },
    { sourceSkuId: "111", label: "1 pieza", stock: 99, priceMXN: 1 },
  ];
  const translate = (product, options) => generateListing(product, null, 0.1161, async prompt => {
    if (!prompt.startsWith("Prepare")) return JSON.stringify({ title: "Recipientes", description: "Texto del producto." });
    assert.match(prompt, /top-level variantOptions array/);
    assert.deepEqual(JSON.parse(prompt.split("\n").at(-1)).source.skus.map(sku => sku.id),
      sourceVariants(product).skus.map(sku => sku.id));
    return JSON.stringify({ ...JSON.parse(model), variantOptions: options });
  });
  const createCell = bound.ptc.file;
  const builtIn = await fs.readFile(createCell, "utf8");
  const legacyCell = `const workers = [
  { name: "es", instruction: "Produce Mexican Spanish" },
  { name: "en", instruction: "Produce English" },
  { name: "commerce", instruction: "Prepare the locally customized sales plan; omit SKU rows." },
];
await Promise.all(workers.map(worker => agent({task: JSON.stringify(worker), allowed_tools: []})));`;
  try {
    await fs.writeFile(createCell, legacyCell);
    const localized = await translate(quantities, quantityOptions);
    assert.equal(await fs.readFile(createCell, "utf8"), legacyCell, "preserves an installed custom PTC cell");
    assert.deepEqual(localized.copy.salesAndShipping.skus, [
      { sourceSkuId: "111", option: "1 pieza", stock: 7, priceMXN: 116 },
      { sourceSkuId: "222", option: "3 piezas", stock: 3, priceMXN: 232 },
      { sourceSkuId: "333", option: "6 piezas", stock: 4, priceMXN: 348 },
    ]);
    assert.match(localized.copy.salesAndShipping.origins["1 pieza.option"].basis, /1 個.*1 pieza/);
    assert.equal(localized.copy.variantOptions, undefined);
    const rerun = await generateListing(quantities, localized.copy, 0.1161, async () => '{"title":"Otra vez","description":"Texto."}');
    assert.deepEqual(rerun.copy.salesAndShipping.skus, localized.copy.salesAndShipping.skus);
  } finally {
    await fs.writeFile(createCell, builtIn);
  }

  const colorsAndSizes = {
    ...rich,
    skus: [
      { ...rich.skus[0], options: ["青", "M"] },
      { ...rich.skus[1], options: ["白", "L"] },
      cloth,
    ],
  };
  const combinations = await translate(colorsAndSizes, [
    { sourceSkuId: "222", label: "Blanco / L" },
    { sourceSkuId: "111", label: "Azul / M" },
  ]);
  assert.deepEqual(combinations.copy.salesAndShipping.skus.map(sku => sku.option), ["Azul / M", "Blanco / L"]);
  assert.ok(combinations.copy.salesAndShipping.excludedSkus.extra);
  await assert.rejects(translate(quantities), /no Mexican Spanish variant label/);
  await assert.rejects(translate(quantities, quantityOptions.slice(1)), /cover every eligible source SKU/);
  await assert.rejects(translate(quantities, quantityOptions.map(row => ({ ...row, label: "X" }))), /unique option/);
  await assert.rejects(translate(quantities, [{ ...quantityOptions[0], label: "3個" }, ...quantityOptions.slice(1)]), /Invalid Mexican Spanish variant label/);
  await assert.rejects(translate(quantities, [{ ...quantityOptions[0], sourceSkuId: "unrelated" }, ...quantityOptions.slice(1)]), /unknown or duplicate source SKU/);
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
  {
    const source = String(1783000000000000000n + BigInt(process.pid));
    const prefix = "pagelens-mx-" + source + "-";
    const title = "Recorded draft";
    const priorId = "1738598351871051340";
    const url = "https://shop.tiktok.com/jp/pdp/example-product/" + source;
    const link = "https://seller.tiktokshopglobalselling.com/product/edit-draft/" + priorId + "?shop_region=MX";
    const receipt = { id: priorId, link, title, verified: true, readback: { url: link, title } };
    const fixture = async (capture, savedReceipt) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      await fs.writeFile(path.join(dir, "source.json"), JSON.stringify(capture));
      await fs.writeFile(path.join(dir, "listing.json"), JSON.stringify({ title }));
      await fs.writeFile(path.join(dir, "receipt.json"), savedReceipt);
    };
    let browserCalls = 0;
    const create = () => draft.createHostedDraft(source, 0.1161, async () => {
      browserCalls++;
      throw Error("Reached the browser fixture");
    });
    try {
      await fixture({ id: source + "0", url: url + "0" }, JSON.stringify(receipt));
      await fixture({ id: source, url: url + "0" }, JSON.stringify(receipt));
      await fixture({ id: source, url }, "{truncated");
      await fixture({ id: source, url }, JSON.stringify(receipt) + " ".repeat(1024 * 1024));
      await fixture({ id: source, url }, JSON.stringify({
        ...receipt, link: link.replace("shop_region=MX", "shop_region=GB"),
      }));
      await assert.rejects(create, /Reached the browser fixture/);
      await fixture({ id: source, url }, JSON.stringify(receipt));
      await assert.rejects(create, /Verified local history includes draft IDs 1738598351871051340/);
      assert.equal(browserCalls, 1, "historical evidence stops creation before the browser is called");
      await assert.rejects(fs.stat(path.join(home, "mx-draft-sources", source + ".json")), { code: "ENOENT" });
    } finally {
      for (const entry of await fs.readdir(os.tmpdir(), { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith(prefix))
          await fs.rm(path.join(os.tmpdir(), entry.name), { recursive: true, force: true });
      }
    }
  }
  {
    const create = "https://seller.tiktokshopglobalselling.com/product/create?shop_region=MX";
    const saved = "https://seller.tiktokshopglobalselling.com/product/edit-draft/1738623714154153548?shop_region=MX";
    const tabs = new Map();
    const opens = [];
    const navigations = [];
    const group = new DraftTabs("1736073370556597841", async (tool, args) => {
      if (tool === "list_tabs") return [...tabs.values()];
      if (tool === "navigate_tab") {
        navigations.push(args.url);
        tabs.get(args.tabId).url = args.url;
        return;
      }
      if (tool !== "open_tab") assert.fail(tool);
      const id = opens.push(args);
      tabs.set(id, { id, groupId: 5, url: args.url });
      return { tabId: id, groupId: 5 };
    });
    const productUrl = "https://shop.tiktok.com/jp/pdp/1736073370556597841";
    const edit = await group.open(productUrl);
    assert.equal(opens[0].active, false);
    assert.equal(await group.navigate(edit, create), edit);
    assert.equal(group.tabs.has(productUrl), false);
    assert.equal(await group.reopenSavedDraft(edit, saved), edit);
    assert.equal(group.tabs.get(saved), edit);
    assert.equal(group.tabs.has(create), false);
    await group.navigate(edit, create);
    tabs.get(edit).url = saved;
    const explicitNavigations = navigations.length;
    assert.equal(await group.reopenSavedDraft(edit, saved), edit);
    assert.equal(navigations.length, explicitNavigations, "Seller Center already navigated to the saved draft");
    assert.equal(group.tabs.get(saved), edit);
    assert.equal(group.tabs.has(create), false);
    for (const search of ["tab=draft&shop_region=MX", "shop_region=MX"]) {
      tabs.get(edit).url = "https://seller.tiktokshopglobalselling.com/product/manage?" + search;
      assert.equal(await group.reopenSavedDraft(edit, saved), edit);
      assert.equal(tabs.get(edit).url, saved);
    }
    assert.equal(opens.length, 1, "save and refresh stay in the visible editor tab");
    tabs.delete(edit);
    assert.equal(await group.reopenSavedDraft(edit, saved), 2);
    assert.equal(opens[1].active, false, "if Chrome closed the editor, recovery opens in background");
    assert.equal(opens[1].groupWithTab, undefined);
    const unrelated = "https://seller.tiktokshopglobalselling.com/product/manage?shop_region=MX&tab=active";
    tabs.get(2).url = unrelated;
    assert.equal(await group.reopenSavedDraft(2, saved), 3);
    assert.equal(tabs.get(2).url, unrelated, "leave a tab navigated outside the draft flow untouched");
    assert.equal(opens[2].active, false);
  }
  {
    const create = "https://seller.tiktokshopglobalselling.com/product/create?shop_region=MX";
    const login = "https://seller.tiktokshopglobalselling.com/account/login";
    const productUrl = "https://shop.tiktok.com/jp/pdp/1736073370556597841";
    let url = productUrl;
    let polls = 0;
    const task = new DraftTabs("1736073370556597841", async tool => {
      if (tool === "open_tab") return { tabId: 14, windowId: 6 };
      if (tool === "navigate_tab") { url = login; return {}; }
      if (tool === "list_tabs") { polls++; return [{ id: 14, windowId: 6, url }]; }
      assert.fail(tool);
    });
    assert.equal(await task.open(productUrl), 14);
    assert.equal(task.windowId, 6);
    await assert.rejects(task.navigate(14, create), {
      message: "SELLER_LOGIN_REQUIRED: TikTok Seller Center is not logged in; please sign in to the MX seller shop and retry",
    });
    assert.equal(polls, 1, "login redirect fails on the first navigation read");
  }
  const navigationUrl = "https://shop.tiktok.com/jp/pdp/1722345678901234567";
  let navigationReads = 0;
  await draft.waitForSourceTab(55, navigationUrl, async () => (
    ++navigationReads === 1 ? [{ id: 56, url: navigationUrl }] : [{ id: 55, url: navigationUrl }]
  ));
  assert.equal(navigationReads, 2);
  await assert.rejects(draft.waitForSourceTab(55, navigationUrl, async () => [
    { id: 55, url: "https://shop.tiktok.com/jp/pdp/1722345678901234568" },
  ]), /another product/);

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
  const stale = { ids: ["999"], matches: [{ id: "999", text: "same" }] };
  const current = await draft.confirmCreateList(stale, async () => ({ ids: ["600"], matches: [] }));
  assert.deepEqual(current, { ids: ["999", "600"], matches: [] });
  assert.equal(draft.writableDraftId(current), null);
  assert.throws(() => draft.writableDraftId(stale), /already exists/);
  assert.deepEqual(await draft.confirmCreateList(stale, async () => stale), stale);
  assert.deepEqual(await draft.confirmCreateList(current, async () => stale), { ...stale, ids: current.ids });
  const binding = { category: "A > B", values: { Material: ["Glass\nVidrio"] } };
  const catalog = [{ name: "Material", options: ["玻璃\nVidrio"] }];
  assert.equal(draft.compatibleAttributePlan(binding, "A - B", catalog), true);
  assert.equal(draft.compatibleAttributePlan(binding, "C - B", catalog), false);
  assert.equal(draft.compatibleAttributePlan(binding, "A - B", [{ ...catalog[0], options: ["Metal"] }]), false);
  assert.equal(draft.compatibleAttributePlan(binding, "A - B", [...catalog, { name: "Size", options: [] }]), false);
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
  // Native hosts have independent browser sessions and share their title lock directory.
  {
    const fixture = await fs.mkdtemp(path.join(home, "title-contention-"));
    async function runDirectory(suffix, title) {
      const id = "17296000000000000" + suffix;
      const dir = path.join(fixture, suffix);
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, "image-01.jpg"), "jpg");
      await fs.writeFile(path.join(dir, "source.json"), JSON.stringify({
        ...sourceFile, id, url: "https://shop.tiktok.com/jp/pdp/" + id,
      }));
      await fs.writeFile(path.join(dir, "listing.json"), JSON.stringify({ ...listing, title }));
      return dir;
    }
    const [owner, contender, independent, ownerDir, contenderDir, independentDir] = await Promise.all([
      import("./tiktok-mx-draft.mjs?title-lock-owner"),
      import("./tiktok-mx-draft.mjs?title-lock-contender"),
      import("./tiktok-mx-draft.mjs?title-lock-independent"),
      runDirectory("11", "Molde nuevo"),
      runDirectory("12", "Ｍolde   nuevo"),
      runDirectory("13", "Otro molde"),
    ]);
    const save = (runner, dir) => runner.save(dir, false, false, null, null, null, 4, false,
      Promise.resolve({ matches: [], ids: [] }));
    const refreshing = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const listBridge = read => async (tool, args) => {
      if (tool === "open_tab" && args.url.includes("/product/manage")) return { tabId: 7, groupId: 1 };
      if (tool === "reload_tab" && args.tabId === 7) return {};
      if (tool === "run_js" && args.tabId === 7 && args.code.includes("readDraftList"))
        return { ok: true, result: await read() };
      assert.fail("Unexpected seller write while checking duplicate titles: " + tool);
    };
    owner.setDraftBridgeForTests(listBridge(async () => {
      refreshing.resolve();
      await finish.promise;
      throw Error("owner fixture stopped during list refresh");
    }));
    contender.setDraftBridgeForTests(() => assert.fail("Lock refusal must precede browser calls"));
    independent.setDraftBridgeForTests(listBridge(async () => {
      throw Error("different title reached refreshing");
    }));
    const ownerRun = assert.rejects(save(owner, ownerDir), /owner fixture stopped/);
    try {
      await Promise.race([refreshing.promise, ownerRun]);
      await assert.rejects(save(contender, contenderDir), /already owns this title/);
      await assert.rejects(save(independent, independentDir), /different title reached refreshing/);
      await assert.rejects(save(contender, contenderDir), /already owns this title/);
    } finally {
      finish.resolve();
      await ownerRun;
    }
    contender.setDraftBridgeForTests(listBridge(() => ({
      matches: [{ id: "556", text: "Molde nuevo" }], ids: ["556"],
    })));
    await assert.rejects(save(contender, contenderDir), /A matching draft already exists: 556/);
    for (const dir of [ownerDir, contenderDir, independentDir])
      await assert.rejects(fs.stat(path.join(dir, "receipt.json")), { code: "ENOENT" });
    assert.ok(!(await fs.readdir(home)).some(name => name.endsWith(".lock")));
    await fs.rm(fixture, { recursive: true });
  }
  {
    const { inspectWithPtc } = await import("../native/mx-ptc-inspect.mjs");
    const { createDraftTransport, japaneseSourceId } = await import("../extension/skills/tiktok-mx-draft/tiktok-mx-native.mjs");
    assert.equal(japaneseSourceId("https://shop.tiktok.com/jp/pdp/test/" + product + "?feed=1"), product);
    assert.throws(() => japaneseSourceId("https://example.com/jp/pdp/" + product));
    const draftId = "1234567890123456789";
    const url = "https://seller.tiktokshopglobalselling.com/product/edit-draft/" + draftId + "?shop_region=MX";
    const state = { url, title: listing.title, enTitle: listing.enTitle, description: listing.description,
      enDescription: listing.enDescription, gallery: 1, detailImages: 0, category: "Cocina",
      salesAndShipping: { brand: "无品牌", axes: ["Modelo"], options: [["M"]], skus: [{ label: "M", stock: 5, priceMXN: 100 }],
        packagedWeightGrams: 500, dimensionsInCm: true, packageCm: listing.salesAndShipping.packageCm } };
    const inspect = () => inspectWithPtc({ sourceId: product, draftId }, async () => state, async () => ({ source: sourceFile, copy: listing }));
    assert.equal((await inspect()).verified, true);
    listing.attributePlan = { category: "Cocina", values: { Material: ["Glass"] } };
    state.attributeCatalog = [{ name: "Material", options: ["Glass", "Wood"], selected: ["Wood"] }];
    await assert.rejects(inspect(), /Draft attribute differs: Material/);
    state.attributeCatalog[0].selected = ["Glass"];
    assert.equal((await inspect()).verified, true);
    delete listing.attributePlan;
    state.salesAndShipping.skus[0].stock = 2;
    await assert.rejects(inspect(), /M stock/);
    let calls = 0;
    let currentUrl = url;
    const execute = createDraftTransport(product, async () => { calls++; return { ok: true, result: { tabId: 51 } }; }, async () => currentUrl);
    const bridge = (tool, args) => execute({ action: "bridge_call", request: { tool, args } });
    await assert.rejects(bridge("run_js", { tabId: 51 }), /outside draft task/);
    await assert.rejects(bridge("open_tab", { url: "https://example.com" }), /destination/);
    await bridge("open_tab", { url });
    await assert.rejects(bridge("run_shell", { tabId: 51 }), /Unexpected draft tool/);
    await assert.rejects(bridge("navigate_tab", { tabId: 50, url }), /outside draft task/);
    await assert.rejects(bridge("navigate_tab", { tabId: 51, url: "https://example.com" }), /destination/);
    assert.equal(calls, 1);
    await bridge("navigate_tab", { tabId: 51, url });
    assert.equal(calls, 2);
    currentUrl = "https://seller.tiktokshopglobalselling.com/product/manage?shop_region=MX";
    await assert.rejects(bridge("run_js", { tabId: 51 }), /outside draft workflow/);
    await assert.rejects(bridge("navigate_tab", { tabId: 51, url: "https://seller.tiktokshopglobalselling.com/product/create?shop_region=MX" }), /outside draft workflow/);
    await bridge("navigate_tab", { tabId: 51, url });
    assert.equal(calls, 3);
    currentUrl += "&tab=active";
    await assert.rejects(bridge("navigate_tab", { tabId: 51, url }), /outside draft workflow/);
    assert.equal(calls, 3);
  }
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
    if (tool === "run_js") return { ok: true, result: args.tabId === 4
      ? { url: "https://seller.tiktokshopglobalselling.com/product/create?shop_region=MX", gallery: 0 }
      : { matches: [], ids: [] } };
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

  // Resume the same retained form. Save only after the category and sales readback match.
  const createUrl = "https://seller.tiktokshopglobalselling.com/product/create?shop_region=MX";
  let clicks = 0, showSaved = false, category = "", fieldsPersist = false, mediaPersist = true;
  const commerce = {
    brand: "无品牌",
    axes: ["Modelo"],
    options: [["M"]],
    skus: [{ label: "M", stock: 5, priceMXN: 100 }],
    packagedWeightGrams: 500,
    dimensionsInCm: true,
    packageCm: { length: 10, width: 8, height: 7 },
  };
  draft.setDraftBridgeForTests(async (tool, args) => {
    if (tool === "open_tab") {
      assert.ok(args.url.includes("/product/manage") || args.url.includes("/edit-draft/556"));
      return { tabId: args.url.includes("/edit-draft/") ? 8 : 7, groupId: 1 };
    }
    if (tool === "run_js") {
      if (args.tabId === 8) throw Error("stop at persisted draft");
      if (args.code.includes("readDraftList")) return { ok: true, result: showSaved
        ? { ids: ["556"], matches: [{ id: "556", text: "Molde" }] } : { ids: [], matches: [] } };
      if (args.code.includes("另存为草稿")) { clicks++; return { ok: true, result: "" }; }
      assert.equal(args.tabId, 4);
      if (args.code.includes("return await (function sellerRead")) return { ok: true, result: commerce };
      const lostMedia = !mediaPersist && args.code.includes("let seen=0");
      return { ok: true, result: { url: createUrl, ...listing, gallery: lostMedia ? 0 : 1, detailImages: 0, category,
        salesAndShipping: fieldsPersist ? commerce : { ...commerce, skus: [] } } };
    }
    return { ok: true };
  });
  await assert.rejects(draft.save(reuseDir), /Category did not match before saving/);
  category = "Cocina";
  await assert.rejects(draft.save(reuseDir), /Commercial fields differ before saving:.*SKU count/);
  fieldsPersist = true;
  mediaPersist = false;
  await assert.rejects(draft.save(reuseDir), /Seller readback differs/);
  assert.equal(clicks, 0);
  mediaPersist = true;
  await assert.rejects(draft.save(reuseDir), /draft ID not yet confirmed/);
  const staged = JSON.parse(await fs.readFile(path.join(reuseDir, "receipt.json"), "utf8"));
  assert.deepEqual([staged.startedTab, staged.saving, staged.verified, clicks], [4, true, false, 1]);
  showSaved = true;
  await assert.rejects(draft.save(reuseDir), /stop at persisted draft/);
  assert.equal(clicks, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(recordDir, reuseProduct + ".json"), "utf8")).id, "556");

  // A failed variant commit with no verifiable category must leave the editor open without submitting.
  category = "";
  const firstProduct = "1729600000000000004";
  const firstDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagelens-mx-checkpoint-"));
  await fs.writeFile(path.join(firstDir, "source.json"), JSON.stringify({
    ...sourceFile, id: firstProduct, url: "https://shop.tiktok.com/jp/pdp/" + firstProduct,
  }));
  await fs.writeFile(path.join(firstDir, "listing.json"), JSON.stringify(listing));
  await fs.copyFile(path.join(reuseDir, "image-01.jpg"), path.join(firstDir, "image-01.jpg"));
  const inboxDir = path.join(home, "agent-inbox"), outboxDir = path.join(home, "agent-outbox");
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(outboxDir, { recursive: true });
  showSaved = false;
  const filling = assert.rejects(draft.save(firstDir, false, false, null, null, null, 4), /committed option M/);
  let message;
  for (let i = 0; i < 100 && !message; i++) {
    const file = (await fs.readdir(inboxDir)).find(name => name.endsWith(".json"));
    if (file) message = JSON.parse(await fs.readFile(path.join(inboxDir, file), "utf8"));
    else await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(message?.action, "fill_mx_draft");
  await fs.writeFile(path.join(outboxDir, message.id + ".json"), JSON.stringify({
    ok: false, error: "Seller control not ready: committed option M",
  }));
  await filling;
  const firstReceipt = JSON.parse(await fs.readFile(path.join(firstDir, "receipt.json"), "utf8"));
  assert.deepEqual([firstReceipt.partial, firstReceipt.verified, firstReceipt.startedTab, clicks], [undefined, false, 4, 1]);

  // Only an explicitly rejected save with its original editor gone can be replaced.
  const rejected = { ...firstReceipt, saving: true, saveMessage: "提交失败", startedGroup: 1,
    draftIdsBefore: ["500"] };
  await fs.writeFile(path.join(firstDir, "receipt.json"), JSON.stringify(rejected));
  let tabs = [{ id: 4, groupId: 2, url: createUrl }], ids = ["500"], replacements = 0;
  draft.setDraftBridgeForTests(async (tool, args) => {
    if (tool === "open_tab" && args.url === createUrl) {
      replacements++;
      throw Error("replacement opened");
    }
    if (tool === "list_tabs") return tabs;
    if (tool === "run_js") return { ok: true, result: { ids, matches: [] } };
    return { ok: true, tabId: 7, groupId: 1 };
  });
  const retryClosed = () => draft.save(firstDir, false, false, null, null, null, null, true);
  await assert.rejects(retryClosed(), /reconcile the draft list/);
  tabs = [];
  await assert.rejects(draft.save(firstDir), /reconcile the draft list/);
  ids = ["500", "501"];
  await assert.rejects(retryClosed(), /reconcile the draft list/);
  ids = ["500"];
  await assert.rejects(retryClosed(), /replacement opened/);
  assert.equal(replacements, 1);

  const closed = [];
  const workTabs = new DraftTabs(reuseProduct, async (tool, args) => {
    if (tool === "close_tab") closed.push(args.tabId);
    if (tool === "list_tabs") return [{ id: 4 }];
  });
  workTabs.owned = new Set([4, 7]);
  workTabs.pendingForm = 4;
  await workTabs.close();
  assert.deepEqual(closed, [7]);
  assert.ok(workTabs.owned.has(4));
  draft.setDraftBridgeForTests(null);
}

// An editable cell can chain a parameter worker into two copy workers and choose media.
{
  const program = generated.ptc.planner.file;
  const original = await fs.readFile(program, "utf8");
  const custom = `const spec = await fieldAgent("parameters.units", "Read package units", { product: input.source.id });
const [es, en] = await Promise.all(["es", "en"].map(name => fieldAgent(name, "Write " + name, spec)));
return { ...input.previous, title: es.title, enTitle: en.title, description: es.description, enDescription: en.description,
  gallery: input.gallery.slice(-1), details: [] };`;
  const product = { ...source, gallery: ["a", "b"], assets: [{url:"a",name:"a.jpg"},{url:"b",name:"b.jpg"}] };
  try {
    await fs.writeFile(program, custom);
    const run = await generateListing(product, previous, .1161, async prompt => {
      const data = JSON.parse(prompt.split("\n").at(-1));
      if (prompt.startsWith("Read package")) {
        assert.equal(data.params.product, source.id);
        return '{"unit":"pair"}';
      }
      assert.equal(data.params.unit, "pair");
      return JSON.stringify({ title: "Pair", description: "x".repeat(4999) });
    });
    assert.deepEqual(run.copy.gallery, ["b.jpg"]);
    assert.equal(run.copy.enDescription.length, 4999); // Large PTC return is spilled.
    assert.ok(run.ptc.workers["parameters.units"].end <= run.ptc.workers.en.start);
    await fs.writeFile(program, custom.replace("input.gallery.slice(-1)", '["unrelated.jpg"]'));
    await assert.rejects(generateListing(product, previous, .1161, async () => '{"title":"T","description":"D"}'), /Invalid listing plan images/);
  } finally { await fs.writeFile(program, original); }
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
const searched = await categorySearchQuery(source, async () => '{"query":"刷"}');
assert.equal(searched.query, "刷");
assert.deepEqual(searched.queries, ["刷"]);
const multiSearched = await categorySearchQuery(source, async () => '{"queries":["蛋","厨具","刷"]}');
assert.equal(multiSearched.query, "蛋");
assert.deepEqual(multiSearched.queries, ["蛋", "厨具", "刷"]);
await assert.rejects(categorySearchQuery(source, async () => '{"query":"egg brush"}'), /Simplified Chinese/);

{
  const draft = await import("./tiktok-mx-draft.mjs?resolve-cat-test");
  const createUrl = "https://seller.tiktokshopglobalselling.com/product/create?shop_region=MX";
  const typedCalls = [];
  const menuByTerm = {
    "蛋": ["厨具 - 厨房用具与小工具 - 蛋类料理工具"],
    "厨具": ["厨具 - 厨房用具与小工具 - 蛋类料理工具", "厨具 - 厨房用具与小工具 - 清洁刷"],
  };
  let activeTerm = "";
  const mockCopy = { category: { searches: ["蛋", "厨具"] } };
  const catDir = await fs.mkdtemp(path.join(flowDir, "resolve-cat-"));
  draft.setDraftBridgeForTests(async (tool, args) => {
    if (tool === "trusted_type") {
      typedCalls.push(args);
      assert.equal(args.selector, undefined, "cascader search must not re-click wrapper selector");
      assert.equal(args.clear, undefined, "cascader search clears in page without Control+A");
      activeTerm = args.value;
      return { ok: true };
    }
    if (tool === "run_js") {
      if (args.code.includes("应用")) return { ok: true, result: [] };
      if (args.code.includes("Draft category search did not open")) return { ok: true, result: { selector: "focused" } };
      if (args.code.includes("Expected a full category path")) {
        if (args.code.endsWith('("厨具 - 厨房用具与小工具 - 蛋类料理工具")')) {
          assert.equal(activeTerm, "蛋");
          return { ok: true, result: { choice: "厨具 - 厨房用具与小工具 - 蛋类料理工具" } };
        }
        return { ok: true, result: { choices: menuByTerm[activeTerm] || [] } };
      }
    }
    throw Error("Unexpected bridge tool in resolveCategory test: " + tool);
  });
  try {
    const resolved = await draft.resolveCategory(9, createUrl, source, mockCopy, catDir, false, {
      chooseCategory: async (_s, candidates) => {
        assert.deepEqual(candidates, [
          "厨具 - 厨房用具与小工具 - 蛋类料理工具",
          "厨具 - 厨房用具与小工具 - 清洁刷",
        ]);
        return { choice: { label: "厨具 - 厨房用具与小工具 - 蛋类料理工具" }, ptc: { ok: true } };
      },
    });
    assert.equal(resolved.selected, true);
    assert.equal(mockCopy.category.search, "蛋");
    assert.deepEqual(typedCalls.map(c => c.value), ["蛋", "厨具", "蛋"]);

    // Transient popup blur on initial CDP attach should retry once cleanly.
    let blurReads = 0;
    const retryCopy = { category: { searches: ["蛋"] } };
    draft.setDraftBridgeForTests(async (tool, args) => {
      if (tool === "trusted_type") {
        activeTerm = args.value;
        return { ok: true };
      }
      if (tool === "run_js") {
        if (args.code.includes("应用")) return { ok: true, result: [] };
        if (args.code.includes("Draft category search did not open")) return { ok: true, result: { selector: "focused" } };
        if (args.code.includes("Expected a full category path")) {
          if (args.code.endsWith('("厨具 - 厨房用具与小工具 - 蛋类料理工具")'))
            return { ok: true, result: { choice: "厨具 - 厨房用具与小工具 - 蛋类料理工具" } };
          if (blurReads++ === 0) throw Error("Search the current draft category before reading choices");
          return { ok: true, result: { choices: menuByTerm[activeTerm] || [] } };
        }
      }
      throw Error("Unexpected bridge tool in resolveCategory retry test: " + tool);
    });
    const retried = await draft.resolveCategory(9, createUrl, source, retryCopy, catDir, false, {
      chooseCategory: async (_s, candidates) => ({ choice: { label: candidates[0] }, ptc: { ok: true } }),
    });
    assert.equal(retried.selected, true);
    assert.equal(blurReads, 2);
  } finally {
    draft.setDraftBridgeForTests(null);
  }
}
const category = await chooseCategory(source, ["Cookware / Racks", "Electronics / Ovens"], async () => '{"index":0}');
assert.equal(category.choice.label, "Cookware / Racks");
let sawFlexibleScopePrompt = false;
const flexCategory = await chooseCategory(source, ["厨具 / 厨房用具与小工具 / 烹饪器具"], async prompt => {
  sawFlexibleScopePrompt = /permitted to sell/.test(prompt);
  return '{"index":0}';
}, { flexibleScope: true });
assert.equal(sawFlexibleScopePrompt, true);
assert.equal(flexCategory.choice.label, "厨具 / 厨房用具与小工具 / 烹饪器具");
await assert.rejects(chooseCategory(source, ["Ovens"], async () => '{"index":2}'), /No suitable/);
{
  const originalFetch = globalThis.fetch;
  const config = {
    ANTHROPIC_BASE_URL: "https://ptc-usage.fixture.invalid",
    ANTHROPIC_AUTH_TOKEN: "fixture",
    PAGELENS_PTC_MODEL: "fixture-model",
    PAGELENS_PTC_CLI_ONLY: "",
  };
  const previousEnv = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
  Object.assign(process.env, config);
  const { chooseCategory, getPtcTokenLedger } = await import("./tiktok-mx-ptc.mjs?token-usage-test");
  try {
    globalThis.fetch = async (endpoint, { body }) => {
      assert.equal(endpoint, config.ANTHROPIC_BASE_URL + "/v1/messages");
      const { messages } = JSON.parse(body);
      const input = messages[0].content.includes("First product") ? 21 : 31;
      return { ok: true, json: async () => ({
        model: config.PAGELENS_PTC_MODEL,
        content: [{ type: "text", text: '{"index":0}' }],
        usage: { input_tokens: input, output_tokens: 4, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
      }) };
    };
    const [first, second] = await Promise.all(
      ["First product", "Second product"].map(title => chooseCategory({ title }, ["Category"])),
    );
    assert.deepEqual([first.ptc.tokenUsage.totalTokens, second.ptc.tokenUsage.totalTokens], [30, 40]);
    assert.equal(getPtcTokenLedger().totalTokens, 70);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
await assert.rejects(validateTranslatedTitle(updated.copy, "Something else", async () => '{"valid":false}'), /translation differs/);
const sample = { ...source, id: "1729600000000000005", gallery: [], detail: [], skus: [{...source.skus[0],stock:4}] };
const link = "https://seller.tiktokshopglobalselling.com/product/edit-draft/123?shop_region=MX";
const receipt = { verified:true, id:"123", link, readback:{url:link, title:updated.copy.title, enTitle:updated.copy.enTitle} };
await rememberPlan(sample, updated.copy, receipt, updated.ptc.versions);
assert.equal((await matchingPlan(sample)).salesAndShipping.skus[0].stock, 4);
assert.equal(await matchingPlan({...sample, title:"Changed product"}), null);
const { chooseAttributes } = await import("./tiktok-mx-ptc.mjs");
const { confirmedControls } = await import("./tiktok-mx-flows.mjs");
const material = [{ name: "材质", options: ["Glass\nVidrio", "Metal"] }, { name: "风格", options: ["Modern"] }];
const select = fields => chooseAttributes({ title: "Glass jar" }, material, async () => JSON.stringify({ fields }));
const picked = await select([{ index: 0, evidence: "Glass" }, { index: null, evidence: null }]);
assert.deepEqual(picked.values, { 材质: ["Glass\nVidrio"], 风格: [] });
const pickedArrayEvidence = await select([{ index: 0, evidence: ["Glass"] }, { index: null, evidence: null }]);
assert.deepEqual(pickedArrayEvidence.values, { 材质: ["Glass\nVidrio"], 风格: [] });
const singleClamp = await select([[{ index: 0, evidence: "Glass" }, { index: 1, evidence: "Glass" }], [{ index: null, evidence: null }]]);
assert.deepEqual(singleClamp.values, { 材质: ["Glass\nVidrio"], 风格: [] });
await assert.rejects(select([{ index: 1, evidence: "Steel" }, {index:null}]), /Unsupported attribute/);
await assert.rejects(select([{ index: 5, evidence: "Glass" }, {index:null}]), /Unsupported attribute/);
await assert.rejects(select([]), /Incomplete attribute/);
const plannerBefore = await fs.readFile(updated.ptc.planner.file, "utf8");
await fs.appendFile(updated.ptc.planner.file, "\n// revision");
assert.equal(await matchingPlan(sample), null);
assert.equal((await confirmedControls(sample)).options.get("111"), "M");
assert.equal(await confirmedControls({ ...sample, title: "Different product" }), null);
await fs.writeFile(updated.ptc.planner.file, plannerBefore);
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

// Exercise the in-place host workflow without a store session.
{
  const { repairHostedDraft } = await import("../native/mx-ptc-repair.mjs");
  const home = await fs.mkdtemp(path.join(flowDir, "repair-"));
  const oldHome = process.env.PAGELENS_HOME;
  process.env.PAGELENS_HOME = home;
  const sourceId = sample.id;
  const draftId = "1729600000000000006";
  const link = "https://seller.tiktokshopglobalselling.com/product/edit-draft/" + draftId + "?shop_region=MX";
  const title = "Known household grinder";
  const label = "Cookware - Kitchen Utensils - Specialty Kitchen Utensils";
  const values = { Function: ["Reusable"], Material: ["Plastic"] };
  const before = { url: link, title, category: label, description: "Original", gallery: 2, detailImages: 1,
    salesAndShipping: { brand: "", packageCm: {}, skus: [{ label: "Standard", stock: 4, priceMXN: 140 }] } };
  let clicks = 0, reloads = 0, closing = 0, selected = false, failReload = false;
  let useCategory = false, categorySelected = false;
  const request = async ({ action, request: { tool, args } }) => {
    assert.equal(action, "bridge_call");
    if (tool === "open_tab") {
      assert.equal(args.url, link);
      return { tabId: 7, groupId: 9 };
    }
    if (tool === "list_tabs") return closing ? [] : [{ id: 7, groupId: 9, url: link }];
    assert.equal(args.tabId, 7);
    if (tool === "close_tab") { closing++; return {}; }
    if (tool === "reload_tab") { reloads++; return {}; }
    if (tool === "activate_tab") return {};
    if (tool === "trusted_type") { assert.equal(args.value, "Frame"); return { ok: true }; }
    assert.equal(tool, "run_js");
    const code = args.code;
    assert.ok(code.length <= 8000, "Repair script exceeds the bridge limit");
    if (code.endsWith("return performance.timeOrigin")) return { ok: true, result: 1 };
    if (code.includes("Expected a full category path")) {
      const path = "Home - Home Decor - Frames";
      if (code.endsWith('("' + path + '")')) { categorySelected = true; return { ok: true, result: { choice: path } }; }
      return { ok: true, result: { choices: [path] } };
    }
    if (code.includes("Draft category search did not open")) return { ok: true, result: { selector: "fixture" } };
    if (code.includes("另存为草稿")) {
      clicks++;
      return { ok: true, result: { message: "草稿保存成功", url: link } };
    }
    if (code.includes("sellerAttributes(")) {
      if (code.endsWith("," + JSON.stringify(values) + ")")) selected = true;
      const choices = Object.entries(values).map(([name, options]) =>
        ({ name, options, selected: selected && !(failReload && reloads) ? options : [] }));
      return { ok: true, result: choices };
    }
    return { ok: true, result: useCategory ? { ...before, category: categorySelected ? "Home - Home Decor - Frames" : "" } : before };
  };
  const planners = {
    registeredListing: async (sid, did) => { assert.deepEqual([sid, did], [sourceId, draftId]); return { source, copy: { title }, dir: home }; },
    chooseAttributes: async (_source, [field]) => ({ values: { [field.name]: values[field.name] } }),
    chooseCategory: async (_source, choices) => ({ choice: { label: choices[0] } }),
  };
  try {
    const repair = await repairHostedDraft({ sourceId, draftId, repair: "attributes" }, request, planners);
    assert.deepEqual(repair.attributes, values);
    assert.equal(repair.verified, true);
    assert.equal(repair.draftId, draftId);
    assert.deepEqual([clicks, reloads, closing], [1, 1, 1]);
    assert.equal(JSON.parse(await fs.readFile(path.join(home, "repair-attributes-receipt.json"))).verified, true);
    selected = false; closing = 0; reloads = 0; failReload = true;
    await assert.rejects(repairHostedDraft({ sourceId, draftId, repair: "attributes" }, request, planners), /attribute selection differs/);
    assert.equal(clicks, 2);
    useCategory = true; closing = 0;
    const category = await repairHostedDraft({ sourceId, draftId, repair: "category", queries: ["Frame"] }, request, planners);
    assert.equal(category.category, "Home - Home Decor - Frames");
    assert.equal(clicks, 3);
  } finally {
    if (oldHome == null) delete process.env.PAGELENS_HOME;
    else process.env.PAGELENS_HOME = oldHome;
  }
}

// Exercise the public create entry with an isolated inbox and a persisted native receipt.
{
  const home = path.join(flowDir, "cli-home");
  for (const sub of ["agent-inbox", "agent-outbox", "mx-draft-sources"])
    await fs.mkdir(path.join(home, sub), { recursive: true });
  const url = "https://shop.tiktok.com/jp/pdp/" + sample.id;
  const saved = { ...receipt, origins: {}, estimates: {}, skuWrites: [], firstPersisted: { matched: true },
    readback: { ...receipt.readback, salesAndShipping: { skus: [], options: [] } } };
  await fs.writeFile(path.join(home, "receipt.json"), JSON.stringify(saved));
  await fs.writeFile(path.join(home, "mx-draft-sources", sample.id + ".json"), JSON.stringify({dir:home,id:saved.id}));
  const cli = promisify(execFile)(process.execPath, [fileURLToPath(new URL("./tiktok-mx-draft.mjs", import.meta.url)),
    "create", url + "?tracking=fixture#campaign", "0.1161", "--summary"], { env:{...process.env,PAGELENS_HOME:home}, timeout:8000 });
  cli.catch(() => {});
  const queue = path.join(home, "agent-inbox");
  let request;
  for (const deadline = Date.now() + 5000; Date.now() < deadline && !request;) {
    const file = (await fs.readdir(queue)).find(name => name.endsWith(".json"));
    if (file) request = JSON.parse(await fs.readFile(path.join(queue, file)));
    else await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(request?.action, "ptc_create_mx_draft");
  assert.equal(request.sourceId, sample.id);
  assert.ok(!JSON.stringify(request).includes("tracking"));
  assert.equal(request.rate, 0.1161);
  await fs.writeFile(path.join(home, "agent-outbox", request.id + ".json"),
    JSON.stringify({ ok:true, result:{ verified:true, draftId:saved.id } }));
  const summary = JSON.parse((await cli).stdout);
  assert.equal(summary.id, saved.id);
  assert.equal(summary.firstRefreshMatched, true);
  assert.deepEqual(await fs.readdir(queue), [request.id + ".json"]);
}

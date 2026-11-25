import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleFs, handleRequest } from "../../../../../native/pagelens-host.mjs";
import { chooseShopeeProductDirectory, completeDirectorySizeChartInput, directoryAttributeAdvice,
  loadProductDirectory, prepareSizeChartInput, readSizeChartImage } from "../sidepanel/product-directory.js";

const root = "/Users/example/Desktop/跨境";
const product = {
  folder: "demo",
  title: "示例",
  input: {
    imagePath: root + "/demo/main.jpg",
    variant: { options: [{ imagePath: root + "/demo/sku/color-a.jpg" }] },
  },
};
const issues = [{ folder: "待补", error: "缺少 product.json" }];

let sent = 0;
const loaded = await loadProductDirectory(` ${root} `, {
  send: async (request, options) => {
    sent += 1;
    assert.deepEqual(request, { op: "fs", action: "loadProductDirectory", path: root });
    assert.deepEqual(options, { interactive: false });
    return { ok: true, root, products: [product], issues };
  },
});
assert.deepEqual(loaded, { root, products: [product], issues });
assert.equal(sent, 1);

assert.equal(await chooseShopeeProductDirectory({
  authorize: async (permission, { userGesture }) => { assert.equal(permission, "nativeMessaging"); assert.equal(userGesture, true); },
  choose: async () => ({ ok: true, cancelled: true }),
}), null);
assert.deepEqual(await chooseShopeeProductDirectory({
  authorize: async () => "",
  choose: async () => ({ ok: true, root, products: [product], issues, directoryName: "跨境" }),
}), { ...loaded, directoryName: "跨境" });

for (const path of ["", "Desktop/跨境", root + "/../elsewhere", root + "\0suffix"]) {
  await assert.rejects(loadProductDirectory(path, { send: () => { throw new Error("不应请求本机助手"); } }), /绝对路径/);
}
await assert.rejects(loadProductDirectory(root, {
  send: async () => ({ ok: false, error: "本机助手没有读取权限" }),
}), /本机助手没有读取权限/);
await assert.rejects(loadProductDirectory(root, {
  send: async () => ({ ok: true, root, products: {} }),
}), /目录格式无效/);
for (const imagePath of [root + "/demo/../other/file.jpg", root + "/demo-other/file.jpg", root + "/other/file.jpg"]) {
  await assert.rejects(loadProductDirectory(root, {
    send: async () => ({
      ok: true, root,
      products: [{ ...product, input: { variant: { options: [{ imagePath }] } } }],
    }),
  }), /图片超出了此商品目录/);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pl-size-directory-"));
try {
  const folder = "apparel";
  const dir = path.join(temp, folder);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "product.json"), JSON.stringify({ title: "Shirt", imagePath: "main.jpg" }));
  const main = Buffer.alloc(60, 49);
  Buffer.from([255, 216, 255]).copy(main);
  fs.writeFileSync(path.join(dir, "main.jpg"), main);
  const size = path.join(dir, "size.png");
  const original = Buffer.alloc(620 * 1024, 49);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(original);
  fs.writeFileSync(size, original);

  const fromHost = request => handleFs(request);
  const listed = await loadProductDirectory(temp, { send: fromHost });
  const single = await loadProductDirectory(dir, { send: fromHost });
  assert.deepEqual(single, listed);
  const [item] = single.products;
  assert.equal(item.input.sizeChartImagePath, path.join(single.root, folder, "size.png"));
  assert.equal(item.input.sizeChart, undefined);

  const sizeChart = { name: "Shirt 尺码表", unit: "cm", columns: ["尺寸（国际）", "胸围"], rows: [{ "尺寸（国际）": "S", 胸围: "90" }] };
  const settings = { multimodal: { model: "image-model" } };
  let chunkCount = 0;
  const input = await prepareSizeChartInput(item, {
    root: single.root,
    getSettings: async () => settings,
    readImage: args => readSizeChartImage({ ...args, send: chunk => {
      chunkCount += 1;
      const request = { action: "readProductSizeChartChunk", ...chunk };
      assert.equal(handleFs({ ...request, scope: "agent" }).ok, false);
      return handleFs(request);
    } }),
    parse: async spec => {
      assert.equal(spec.settings, settings);
      assert.equal(spec.name, sizeChart.name);
      assert.equal(spec.imageDataUrl, "data:image/png;base64," + original.toString("base64"));
      return sizeChart;
    },
  });
  assert.equal(chunkCount, 2);
  assert.deepEqual(input.sizeChart, sizeChart);
  assert.equal((await prepareSizeChartInput({ ...item, input })).sizeChart, sizeChart);
  let mainReads = 0;
  const supply = ({ requiredColumns, optionsByColumn }) => completeDirectorySizeChartInput(item, {
    root: single.root, chart: sizeChart, requiredColumns, optionsByColumn,
    async readImage({ root, folder, path, asset }) {
      mainReads++;
      assert.equal(asset, "main");
      const request = { action: "readProductSizeChartChunk", root, folder, offset: 0, asset };
      assert.equal(handleFs({ ...request, expectedPath: item.input.sizeChartImagePath }).ok, false);
      assert.equal(handleFs({ ...request, expectedPath: path, scope: "agent" }).ok, false);
      const response = handleFs({ ...request, expectedPath: path });
      assert.equal(response.mime, "image/jpeg");
      assert.equal(response.base64, main.toString("base64"));
      return `data:${response.mime};base64,${response.base64}`;
    },
    async complete({ productImageDataUrl }) {
      return productImageDataUrl;
    },
  });
  assert.equal(await supply({
    requiredColumns: ["尺寸（美国）"], optionsByColumn: { "尺寸（美国）": ["2"] },
  }), undefined);
  assert.equal(mainReads, 0);
  assert.equal(await supply({ requiredColumns: ["肩宽"] }), "data:image/jpeg;base64," + main.toString("base64"));
  assert.equal(mainReads, 1);
  let advisorReads = 0;
  const advise = directoryAttributeAdvice(item, {
    root: single.root,
    getSettings: async () => settings,
    async readImage(spec) {
      advisorReads++;
      assert.equal(spec.path, item.input.imagePath);
      const response = handleFs({ action: "readProductSizeChartChunk", root: spec.root, folder: spec.folder,
        expectedPath: spec.path, offset: 0, asset: spec.asset });
      assert.equal(response.mime, "image/jpeg");
      return `data:${response.mime};base64,${response.base64}`;
    },
    createAdvisor({ product, referenceImages }) {
      assert.equal(product, item.input);
      return {
        async fields(fields) {
          assert.deepEqual(Buffer.from(await referenceImages[0].file.arrayBuffer()), main);
          return { [fields[0].key]: "棉" };
        },
      };
    },
  });
  assert.equal(advisorReads, 0);
  assert.deepEqual(await advise([{ key: "材质" }]), { 材质: "棉" });
  assert.deepEqual(await advise([{ key: "袖口" }]), { 袖口: "棉" });
  assert.equal(advisorReads, 1);

  const reference = path.join(single.root, folder, "detail.jpg");
  fs.writeFileSync(reference, main);
  fs.writeFileSync(path.join(dir, "product.json"), JSON.stringify({ title: "Shirt", detailImages: ["detail.jpg"] }));
  const readReference = expectedPath => handleFs({ action: "readProductSizeChartChunk", root: single.root,
    folder, offset: 0, asset: "main", expectedPath });
  assert.equal(readReference(reference).base64, main.toString("base64"));
  assert.equal(readReference(item.input.imagePath).ok, false);

  const previousChrome = globalThis.chrome;
  const storage = {};
  let modelRequests = 0;
  try {
    globalThis.chrome = { storage: { local: {
      get: async key => ({ [key]: storage[key] }),
      set: async values => Object.assign(storage, values),
    } } };
    const prepare = data => prepareSizeChartInput(item, {
      root: single.root,
      getSettings: async () => settings,
      readImage: async () => data,
      parse: async () => { modelRequests += 1; return sizeChart; },
    });
    await prepare("data:image/png;base64,QUJD");
    await prepare("data:image/png;base64,QUJD");
    assert.equal(modelRequests, 1);
    await prepare("data:image/png;base64,REVG");
    assert.equal(modelRequests, 2);
    assert.doesNotMatch(JSON.stringify(storage), /data:image/u);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }

  assert.equal(handleFs({
    action: "readProductSizeChartChunk", root: single.root, folder: "..", offset: 0, expectedPath: item.input.sizeChartImagePath,
  }).ok, false);
  fs.renameSync(size, path.join(dir, "unlisted.png"));
  await assert.rejects(readSizeChartImage({
    root: single.root, folder, path: item.input.sizeChartImagePath, send: args => handleFs({ action: "readProductSizeChartChunk", ...args }),
  }), /尺码图已变化/u);
  fs.symlinkSync(path.join(dir, "unlisted.png"), size);
  assert.match(handleFs({ action: "loadProductDirectory", path: dir }).issues[0].error, /文件路径超出/u);
  fs.writeFileSync(path.join(dir, "product.json"), JSON.stringify({ title: "Shirt", sizeChart }));
  const cached = await loadProductDirectory(dir, { send: fromHost });
  assert.deepEqual(cached.products[0].input.sizeChart, sizeChart);
  assert.equal(cached.products[0].input.sizeChartImagePath, undefined);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

const largeBatch = fs.mkdtempSync(path.join(os.tmpdir(), "pl-bulk-directory-"));
try {
  const folders = Array.from({ length: 30 }, (_, index) => String(index + 1).padStart(2, "0"));
  const picker = () => handleRequest({ op: "chooseProductDirectory" }, { pickDirectory: async () => largeBatch });
  const request = { action: "loadProductDirectory", path: largeBatch };
  for (const folder of folders) {
    const dir = path.join(largeBatch, folder);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "product.json"), JSON.stringify({ title: `商品 ${folder}` }));
  }
  const manual = handleFs(request);
  assert.equal(manual.ok, true);
  assert.deepEqual(manual.products.map(({ folder }) => folder), folders);
  assert.deepEqual(await picker(), { ...manual, directoryName: path.basename(largeBatch) });

  fs.mkdirSync(path.join(largeBatch, "31"));
  assert.match(handleFs(request).error, /最多读取 30 个商品子目录/u);
  fs.rmdirSync(path.join(largeBatch, "31"));
  for (const folder of folders) {
    fs.writeFileSync(path.join(largeBatch, folder, "product.json"), JSON.stringify({ title: `商品 ${folder}`, description: "商品详情".repeat(3500) }));
  }
  assert.match(handleFs(request).error, /Chrome 单次读取上限/u);
  assert.match((await picker()).error, /Chrome 单次读取上限/u);
} finally {
  fs.rmSync(largeBatch, { recursive: true, force: true });
}
console.log("OK native PTC product directory responses");

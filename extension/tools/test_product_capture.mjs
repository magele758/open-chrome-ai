import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assetUrl, captureAssets, exportCapturedProduct, normalizeCapturedProduct, sameProduct } from "../flows/product-capture.js";
import { identifyWorkflowPage, shortcutsForPage } from "../flows/workflow-context.js";
import { loadProductDirectory } from "../../native/product-directory.mjs";

const amazon = "https://www.amazon.com/Example/dp/B07MW4YRY9/ref=promo?tag=discard";
const main = "https://m.media-amazon.com/images/I/main.jpg";
const variant = "https://m.media-amazon.com/images/I/variant.jpg";
const detail = "https://m.media-amazon.com/images/I/detail.jpg";
const sizeChart = "https://m.media-amazon.com/images/I/size.jpg";
const fixedDate = new Date("2026-11-18T00:00:00Z");

function featureIds(url) {
  return shortcutsForPage(url).features.map(feature => feature.id);
}

test("only exposes capabilities that match each site's surface and current route", () => {
  assert.deepEqual(featureIds("https://seller.shopee.cn/portal/marketing"), [
    "product-listing", "campaign-data", "campaign-draft", "voucher-data", "voucher-draft",
  ]);
  assert.deepEqual(featureIds("https://shopee.sg/product/1/2"), []);
  assert.deepEqual(featureIds("https://seller.shopee.cn.evil.test/portal/marketing"), []);
  for (const url of ["https://www.temu.com/", "https://agentseller.temu.com/goods/edit?goods_id=123",
    "https://agentseller-us.temu.com/", "https://www.amazon.com/s?k=gloves", "https://erp.zhfulfill.com/#/catalog"]) {
    assert.deepEqual(featureIds(url), [], url);
  }
  assert.equal(identifyWorkflowPage("https://agentseller.temu.com/").surface, "seller");
  assert.equal(identifyWorkflowPage("https://www.temu.com/").surface, "retail");
  assert.deepEqual(featureIds("https://agentseller.temu.com/goods/list"), ["temu-product-listing", "temu-product-data"]);
  assert.deepEqual(featureIds("https://agentseller.temu.com/activity/marketing-activity"), ["temu-campaign-data", "temu-campaign-draft"]);
  assert.deepEqual(featureIds("https://seller.kuajingmaihuo.com/labor/account"), ["temu-finance-data"]);
  assert.deepEqual(featureIds("https://seller.kuajingmaihuo.com/labor/withdraw/apply"), []);
  assert.equal(identifyWorkflowPage("javascript:alert(1)"), null);

  const temu = "https://www.temu.com/ca/scarf-g-607461633310534.html?_x_sessn_id=sensitive";
  const warehouse = "https://erp.zhfulfill.com/#/catalog/detail/?id=2121853980010233856&token=sensitive";
  for (const url of [amazon, temu, "https://www.temu.com/ca/goods.html?goods_id=607461633310534", warehouse]) {
    assert.deepEqual(featureIds(url), ["product-capture"], url);
  }
  assert.equal(identifyWorkflowPage(amazon).sourceUrl, "https://www.amazon.com/dp/B07MW4YRY9");
  assert.equal(identifyWorkflowPage(temu).sourceUrl, "https://www.temu.com/ca/scarf-g-607461633310534.html");
  assert.equal(identifyWorkflowPage(warehouse).sourceUrl, "https://erp.zhfulfill.com/#/catalog/detail/?id=2121853980010233856");
  assert.equal(sameProduct(identifyWorkflowPage(amazon), identifyWorkflowPage("https://www.amazon.com/dp/B07MW4YRY9?th=1")), true);
  assert.equal(sameProduct(identifyWorkflowPage(amazon), identifyWorkflowPage("https://www.amazon.com/dp/B0GPXFNJRK")), false);
});

test("normalizes source evidence and limits image URLs to the matching platform", () => {
  const page = identifyWorkflowPage(amazon);
  for (const url of ["http://m.media-amazon.com/images/I/main.jpg", "https://m.media-amazon.com.evil.test/a.jpg",
    "https://m.media-amazon.com:444/a.jpg", "https://username@m.media-amazon.com/a.jpg", "file:///Users/test/a.jpg",
    "https://img.kwcdn.com/product/a.jpg"]) {
    assert.equal(assetUrl(url, "amazon"), "", url);
  }
  assert.equal(assetUrl("//img.kwcdn.com/product/a.jpg#ignored", "temu", "https://www.temu.com/"), "https://img.kwcdn.com/product/a.jpg");
  assert.equal(assetUrl("https://zh-img-com.oss-accelerate.aliyuncs.com/foo", "zhfulfill"), "https://zh-img-com.oss-accelerate.aliyuncs.com/foo");

  const captured = normalizeCapturedProduct(page, {
    title: "  Example shirt  ", description: " Description ", brand: "Example", category: "Shirts",
    attributes: { Fabric: ["Cotton", "Spandex"], Origin: "Imported", ignored: { private: true } },
    images: [main, main + "#same", "https://evil.test/i.jpg"], detailImages: [detail, main],
    sizeChartImage: sizeChart,
    variantGroups: [{ name: "Color", options: [{ value: "Red", image: variant }] }, { name: "Empty", options: [] }],
    skus: [{ id: "B07MW4YRY9", options: { Color: "Red" }, price: { amount: "19.50", currency: "USD" }, image: variant }, { options: {} }],
    price: { display: "$19.50", amount: 19.5, currency: "USD" },
  }, fixedDate);
  assert.deepEqual(captured.source, {
    platform: "amazon", productId: "B07MW4YRY9", url: "https://www.amazon.com/dp/B07MW4YRY9", capturedAt: fixedDate.toISOString(),
  });
  assert.equal(captured.title, "Example shirt");
  assert.equal(captured.description, "Description");
  assert.equal(captured.sourceCategory, "Shirts");
  assert.equal(captured.category, undefined);
  assert.equal(captured.countryOfOrigin, "");
  assert.deepEqual(captured.attributes, { Fabric: "Cotton、Spandex", Origin: "Imported" });
  assert.deepEqual(captured.sourcePrice, { amount: "19.5", currency: "USD", display: "$19.50" });
  assert.equal(captured.price, undefined);
  assert.deepEqual(captured.variantGroups, [{ name: "Color", options: [{ value: "Red", image: variant }] }]);
  assert.deepEqual(captured.skus, [{ id: "B07MW4YRY9", options: { Color: "Red" }, image: variant, sourcePrice: { amount: "19.50", currency: "USD" } }]);
  assert.deepEqual(captureAssets(captured), [[main, "main"], [sizeChart, "size-chart"], [detail, "detail"], [variant, "variant"]]);
  assert.throws(() => normalizeCapturedProduct(page, { title: " " }), /商品详情/u);
});

function directoryHandle(path) {
  // Back the File System Access API's test double with a real temporary folder so the existing importer can read it.
  return {
    async getDirectoryHandle(name) {
      const child = join(path, name);
      await mkdir(child, { recursive: true });
      return directoryHandle(child);
    },
    async getFileHandle(name) {
      return {
        async createWritable() {
          return {
            write: async data => writeFile(join(path, name), typeof data === "string" ? data : new Uint8Array(await data.arrayBuffer())),
            close: async () => {},
            abort: async () => {},
          };
        },
      };
    },
  };
}

test("exports product.json and downloaded assets for the existing directory importer", async t => {
  const root = await mkdtemp(join(tmpdir(), "pagelens-product-capture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const captured = normalizeCapturedProduct(identifyWorkflowPage(amazon), {
    title: "A shirt", images: [main], detailImages: [detail], sizeChartImage: sizeChart,
    skus: [{ id: "B07MW4YRY9", image: variant }],
  }, fixedDate);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
  const result = await exportCapturedProduct(directoryHandle(root), captured, {
    readImage: async url => {
      if (url === detail) throw new Error("unavailable");
      return { blob: new Blob([jpeg]), ext: "jpg" };
    },
  });
  assert.match(result.folderName, /^amazon-B07MW4YRY9-\d+$/u);
  assert.equal(result.downloaded, 3);
  assert.deepEqual(result.failed, [detail]);
  const folder = join(root, result.folderName);
  const exported = JSON.parse(await readFile(join(folder, "product.json"), "utf8"));
  assert.equal(exported.imagePath, "images/main.jpg");
  assert.equal(exported.sizeChartImagePath, "images/size-chart.jpg");
  assert.deepEqual(exported.detailImages, [detail]);
  assert.ok(!exported.imageFiles.some(file => file.url === detail));
  assert.match(exported.skus[0].imagePath, /^images\/variant-\d+\.jpg$/u);
  assert.deepEqual(await readFile(join(folder, exported.imagePath)), Buffer.from(jpeg));
  const imported = loadProductDirectory(root);
  assert.ok(imported.ok);
  assert.deepEqual(imported.issues, []);
  assert.equal(imported.products[0].input.title, "A shirt");
  assert.equal(imported.products[0].input.source.productId, "B07MW4YRY9");
  assert.equal(imported.products[0].input.imagePath, await realpath(join(folder, exported.imagePath)));
});

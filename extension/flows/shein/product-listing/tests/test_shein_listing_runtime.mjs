import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSheinListingInput, replaySheinListing } from "../runtime.js";

const url = "https://sellerhub.shein.com/#/spmp/commoditiesInfo?mode=add&last_page=page_commodities_category";
const categoryPath = ["服饰", "袜子"];
const offering = (color, value = color) => ({ value, imagePath: `${color}.jpg`, squareImagePath: `${color}.jpg` });
const sku = color => ({ options: { "颜色": color }, sellerSku: `SKU-${color}`, priceUsd: 5.9, quantity: 1, imagePath: `${color}.jpg` });
const fixture = (options = ["Black"], dimensions = {}) => ({
  shein: {
    categoryPath, variantGroups: [{ name: "颜色", options: options.map(color => offering(color)) }], sites: ["美国站"],
    dimensions, skus: options.map(sku), sharedGalleryImages: ["detail.jpg"],
  },
});
const tableState = ({ media = [], supply = [], package: packaging = [] } = {}) => ({
  ok: true, tables: { media, supply, package: packaging, swatchRequired: false },
});
const variantState = (groups, issues = []) => ({ ok: true, groups, issues, sites: [{ name: "美国站", checked: true }] });

function runtime({ variant, snapshots = [], current = tableState() }) {
  const calls = [];
  const api = {
    tabs: { get: async () => ({ id: 1, active: true, url }) },
    scripting: {
      async executeScript({ func, args: [request] }) {
        calls.push({ page: func.name, ...request });
        const result = {
          sheinEditorPage: () => ({ ok: true, fields: [], items: [], issues: [] }),
          sheinVariantPage: () => variant,
          sheinRowsPage: () => request.kind === "inspect" ? snapshots.shift() || current : current,
          sheinStockPage: () => ({ ok: true, items: [], issues: [] }),
        }[func.name]();
        return [{ result }];
      },
    },
  };
  return { calls, replay: (input, images) => replaySheinListing({ tabId: 1, url, input, api, images }) };
}

test("skips dependent writes while the main variant is empty, even if a secondary value and old rows exist", async () => {
  const primaryIssue = { label: "颜色 · Black", code: "OPTION_NOT_VERIFIED", message: "未回显颜色。" };
  const app = runtime({ variant: variantState([
    { label: "主规格", name: "颜色", values: [] }, { label: "规格类型2", name: "尺码", values: ["均码"] },
  ], [primaryIssue]), current: tableState({ media: [["Black"]], supply: [["Black"]] }) });
  const result = await app.replay(fixture(["Black"], { widthCm: 8 }));
  assert.deepEqual(result.issues, [primaryIssue]);
  const writes = app.calls.filter(call => call.page === "sheinRowsPage" && call.kind !== "inspect");
  assert.deepEqual(writes.map(({ kind, rows, dimensions }) => ({ kind, rows, dimensions })), [
    { kind: "fill", rows: [], dimensions: { widthCm: 8 } },
  ]);
  assert.equal(app.calls.some(call => call.page === "sheinStockPage"), false);
});

test("waits for newly rendered SKU and media rows, then binds prices and uploads to the confirmed localized variant", async () => {
  const current = tableState({ media: [["黑色"]], supply: [["黑色"]], package: [["黑色"]] });
  const app = runtime({ variant: variantState([
    { label: "主规格", name: "颜色 Color", values: ["黑色"], matches: [{ requested: "Black", value: "黑色" }] },
  ]), snapshots: [tableState(), tableState({ media: [["黑色"]] }), current], current });
  const image = (path, role) => ({ path, role, file: new File([path], path, { type: "image/jpeg" }) });
  const result = await app.replay(fixture(), [image("Black.jpg", "variant"), image("Black.jpg", "variant-square"), image("detail.jpg", "shared-gallery")]);
  assert.deepEqual(result.issues, []);
  const calls = app.calls.filter(call => call.page === "sheinRowsPage" || call.page === "sheinStockPage");
  assert.deepEqual(calls.map(call => call.kind), ["inspect", "inspect", "inspect", "fill", "fill", "upload", "upload", "upload", "inspect"]);
  assert.deepEqual(calls[3].rows[0].options, ["黑色"]);
  assert.deepEqual(calls[4].rows, [{ options: ["黑色"], quantity: 1, siteLabel: "美国" }]);
  assert.deepEqual(calls.slice(5, 8).map(call => [call.upload.role, call.upload.options, call.upload.files.length]), [
    ["detail", ["黑色"], 2], ["square", ["黑色"], 1], ["variant", ["黑色"], 1],
  ]);
});

test("fills rows with verified variant values and keeps unmatched SKU values untouched", async () => {
  const current = tableState({ media: [["黑色"], ["白色"]], supply: [["黑色"], ["白色"]] });
  const app = runtime({ variant: variantState([
    { label: "主规格", name: "颜色", values: ["黑色"], matches: [{ requested: "黑色", value: "黑色" }] },
  ]), current });
  const result = await app.replay(fixture(["黑色", "白色"]));
  assert(result.issues.some(issue => issue.code === "SKU_SPEC_UNVERIFIED"));
  for (const call of app.calls.filter(call => call.rows?.length)) {
    assert.deepEqual(call.rows.map(row => row.options), [["黑色"]]);
  }
});

test("requires an explicit source SKU for multiple products on a default-only page and reports the blocked upload", async () => {
  const variant = { ...variantState([{ label: "主规格", name: "默认", values: ["默认"] }]), defaultOnly: true };
  const app = runtime({ variant });
  const file = { path: "Black.jpg", role: "variant", file: new File(["image"], "Black.jpg", { type: "image/jpeg" }) };
  const result = await app.replay(fixture(["Black", "White"]), [file]);
  assert.deepEqual(result.defaultSkuChoices, [{ sellerSku: "SKU-Black", label: "Black" }, { sellerSku: "SKU-White", label: "White" }]);
  assert.equal(result.tabId, 1);
  assert.ok(result.issues.some(issue => issue.code === "MEDIA_UPLOAD_NOT_BOUND"));
  assert.ok(!app.calls.some(call => call.kind === "upload" || call.page === "sheinStockPage"));
});

test("rebinds only the declared color and uploads its images to the same default platform SKC", async () => {
  const platformSku = "se261119171434502395170";
  const current = tableState({ media: [[]], package: [[]], supply: [[]] });
  current.tables.defaultSku = platformSku;
  const variant = { ...variantState([{ label: "主规格", name: "默认", values: ["默认"] }]), defaultOnly: true };
  const app = runtime({ variant, current });
  const input = fixture(["Black", "White"]);
  input.shein.defaultSku = "SKU-White";
  const image = (path, role) => ({ path, role, file: new File([path], path, { type: "image/jpeg" }) });
  const result = await app.replay(input, [image("Black.jpg", "variant"), image("White.jpg", "variant"),
    image("White.jpg", "variant-square"), image("detail.jpg", "shared-gallery")]);
  const pinned = app.calls.filter(call => call.rows?.length || call.kind === "upload");
  assert.equal(result.issues[0].code, "DEFAULT_SKU_ONLY");
  assert.ok(pinned.every(call => call.defaultSku === platformSku));
  assert.deepEqual(pinned[0].rows.map(row => [row.sellerSku, row.options]), [["SKU-White", []]]);
  const uploads = pinned.filter(call => call.kind === "upload");
  assert.deepEqual(uploads.map(call => [call.upload.role, call.upload.options, call.upload.files.map(file => file.name)]), [
    ["detail", [], ["White.jpg", "detail.jpg"]], ["square", [], ["White.jpg"]], ["variant", [], ["White.jpg"]],
  ]);
});

test("does not infer dangerous-goods classification from product prose or the absence of batteries", () => {
  assert.deepEqual(normalizeSheinListingInput({ description: "无内置电池，该商品不属于危险品" }).attributes, {});
  assert.deepEqual(normalizeSheinListingInput({ operatorNotes: "危险品分类：该商品不属于危险品。" }).attributes,
    { 危险品分类: "该商品不属于危险品" });
});

test("does not replace a different seller SKU already associated with a default SKC", async () => {
  const current = tableState({ media: [[]], package: [[]], supply: [[]] });
  Object.assign(current.tables, { defaultSku: "se261119171434502395170", defaultSellerSku: "SKU-Black" });
  const variant = { ...variantState([{ label: "主规格", name: "默认", values: ["默认"] }]), defaultOnly: true };
  const app = runtime({ variant, current });
  const input = fixture(["Black", "White"]);
  input.shein.defaultSku = "SKU-White";
  const result = await app.replay(input);
  assert.ok(result.issues.some(issue => issue.code === "SKU_DEFAULT_ALREADY_BOUND"));
  assert.ok(!app.calls.some(call => call.rows?.length || call.kind === "upload"));
});

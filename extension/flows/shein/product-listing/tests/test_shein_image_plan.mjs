import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildSheinImagePlan } from "../image-plan.js";

const variant = { groups: [{ name: "颜色", values: ["黑色", "白色"],
  matches: [{ requested: "Black", value: "黑色" }, { requested: "White", value: "白色" }] }] };
const tables = { media: [["黑色"], ["白色"]], supply: [["黑色", "S"], ["白色", "S"], ["白色", "M"]] };
const rows = [
  { options: ["黑色", "S"], imagePath: "black/hero.png" },
  { options: ["白色", "S"], imagePath: "white/small.png" },
  { options: ["白色", "M"], imagePath: "white/medium.png" },
];
const product = {
  sharedGalleryImages: ["shared/side.png"],
  detailImages: ["shared/material.png", "shared/side.png"],
  variantGroups: [{ name: "颜色", options: [
    { value: "Black", source: "Black", squareImagePath: "black/square.png", swatchImagePath: "black/swatch.png" },
    { value: "White", source: "White", imagePath: "white/hero.png", squareImagePath: "white/square.png", swatchImagePath: "white/swatch.png" },
  ] }],
};
const assets = [
  ["detail", "shared/material.png"], ["variant", "black/hero.png"], ["variant", "white/hero.png"],
  ["variant", "white/small.png"], ["variant", "white/medium.png"], ["shared-gallery", "shared/side.png"],
  ["variant-square", "black/square.png"], ["variant-square", "white/square.png"],
  ["variant-swatch", "black/swatch.png"], ["variant-swatch", "white/swatch.png"],
];
const descriptor = ([role, path]) => ({ role, path, name: path.split("/").at(-1) });
const planSummary = plan => plan.tasks.map(({ role, options, image }) => [role, options, image.path]);
const samples = new Map([
  ["black", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=="],
  ["white", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII="],
  ["shared", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNI6TnxHwAFyAK47P4J0AAAAABJRU5ErkJggg=="],
]);

test("plans different color covers and swatches, identical ordered shared pictures, and SKU-specific files from a real temporary directory", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pagelens-shein-color-gallery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [, path] of assets) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(samples.get(path.split("/")[0]), "base64"));
  }
  const images = await Promise.all(assets.map(async pair => {
    const details = descriptor(pair);
    return { ...details, file: new File([await readFile(join(dir, details.path))], details.name, { type: "image/png" }) };
  }));
  const plan = buildSheinImagePlan({ product, variant, rows, images, tables });
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(planSummary(plan), [
    ["detail", ["黑色"], "black/hero.png"], ["detail", ["黑色"], "shared/side.png"], ["detail", ["黑色"], "shared/material.png"],
    ["square", ["黑色"], "black/square.png"], ["swatch", ["黑色"], "black/swatch.png"],
    ["detail", ["白色"], "white/hero.png"], ["detail", ["白色"], "shared/side.png"], ["detail", ["白色"], "shared/material.png"],
    ["square", ["白色"], "white/square.png"], ["swatch", ["白色"], "white/swatch.png"],
    ["variant", ["黑色", "S"], "black/hero.png"], ["variant", ["白色", "S"], "white/small.png"], ["variant", ["白色", "M"], "white/medium.png"],
  ]);
  assert.ok(plan.tasks.every(task => images.includes(task.image)));
  const covers = plan.tasks.filter(task => task.role === "detail" && task.image.name === "hero.png");
  const swatches = plan.tasks.filter(task => task.role === "swatch");
  assert.ok(swatches.every(task => !task.deriveSwatch));
  for (const [first, second] of [covers, swatches]) {
    assert.equal(first.image.name, second.image.name, "same base name stays separate by declared path");
    assert.notDeepEqual(await first.image.file.arrayBuffer(), await second.image.file.arrayBuffer());
  }
});

test("never assigns one color's cover, a top-level square, or an ambiguous supply row to another color", () => {
  const images = assets.map(descriptor).concat(descriptor(["square", "square.png"]));
  const uncertain = structuredClone(product);
  uncertain.variantGroups[0].options[0].squareImagePath = "";
  uncertain.variantGroups[0].options[0].swatchImagePath = "";
  uncertain.variantGroups[0].options[1].imagePath = "black/hero.png";
  const plan = buildSheinImagePlan({ product: uncertain, variant, rows, images,
    tables: { ...tables, supply: [["黑色", "S"], ["黑色", "S"], ["白色", "M"]] } });
  assert.equal(plan.tasks.some(task => task.role === "detail"), false);
  assert.deepEqual(planSummary(plan).filter(row => row[1][0] === "黑色"), []);
  assert.ok(plan.issues.some(issue => issue.code === "MEDIA_SQUARE_MISSING"));
  assert.ok(plan.issues.some(issue => issue.code === "MEDIA_SWATCH_MISSING"));
  assert.equal(plan.issues.filter(issue => issue.code === "MEDIA_HERO_UNVERIFIED").length, 2);
  assert.equal(plan.issues.filter(issue => issue.code === "MEDIA_SKU_ROW_AMBIGUOUS").length, 2);
});

test("uses declared single-row image roles and stops a gallery at the real slot capacity", () => {
  const order = ["1.png", "2.png", "3.png", "4.png", "5.png", "6.png"];
  const images = [descriptor(["main", "cover.png"]), descriptor(["square", "square.png"]), descriptor(["swatch", "swatch.png"]),
    ...order.map(path => descriptor(["detail", path]))];
  const plan = buildSheinImagePlan({ product: { detailImages: order }, variant: { groups: [{ values: ["白色"] }] }, images,
    tables: { media: [["白色"]] } });
  assert.deepEqual(planSummary(plan).filter(([role]) => role === "detail").map(([, , path]) => path), ["cover.png", ...order.slice(0, 4)]);
  assert.deepEqual(plan.tasks.slice(-2).map(({ role }) => role), ["square", "swatch"]);
  assert.equal(plan.issues[0].code, "MEDIA_GALLERY_LIMIT");
});

test("requires a unique committed color and a declared source path instead of guessing by file name", () => {
  const missing = structuredClone(product);
  missing.variantGroups[0].options[1].imagePath = "whiteFolder/hero.png";
  const images = assets.map(descriptor).concat({ role: "variant", name: "hero.png" });
  const plan = buildSheinImagePlan({ product: missing, variant, rows, images, tables });
  assert.ok(plan.issues.some(issue => issue.code === "MEDIA_ASSET_MISSING"));
  assert.equal(plan.tasks.some(task => task.role === "detail" && task.options[0] === "白色"), false);
  const ambiguous = buildSheinImagePlan({ product, variant, rows, images, tables: { ...tables, media: [["黑色"], ["黑色"]] } });
  assert.equal(ambiguous.tasks.some(task => task.role === "detail"), false);
  assert.ok(ambiguous.issues.some(issue => issue.code === "MEDIA_COLOR_ROW_AMBIGUOUS"));
});

test("reports missing required image inputs for the current color and SKU, including when the directory is absent", () => {
  const plan = buildSheinImagePlan({ product: { variantGroups: [{ options: [{ value: "Black" }] }] },
    variant: { groups: [{ values: ["黑色"], matches: [{ requested: "Black", value: "黑色" }] }] },
    rows: [{ options: ["黑色", "S"] }], tables: { media: [["黑色"]], supply: [["黑色", "S"], ["黑色", "M"]] } });
  assert.deepEqual(plan.tasks, []);
  assert.deepEqual(plan.issues.map(({ code }) => code), [
    "MEDIA_SHARED_MISSING", "MEDIA_HERO_UNVERIFIED", "MEDIA_SQUARE_MISSING", "MEDIA_SWATCH_MISSING",
    "MEDIA_SKU_IMAGE_MISSING", "MEDIA_SKU_IMAGE_MISSING",
  ]);
});

test("reports missing and unreadable swatches for the exact colors and ignores a generic multicolor swatch", () => {
  const incomplete = structuredClone(product);
  delete incomplete.variantGroups[0].options[0].swatchImagePath;
  incomplete.variantGroups[0].options[1].swatchImagePath = "white/unreadable.png";
  const images = assets.map(descriptor).filter(image => image.path !== "black/hero.png")
    .concat(descriptor(["swatch", "generic.png"]));
  const plan = buildSheinImagePlan({ product: { ...incomplete, swatchImagePath: "generic.png" }, variant, rows, images, tables });
  assert.deepEqual(plan.tasks.filter(task => task.role === "swatch"), []);
  assert.deepEqual(plan.issues.filter(issue => issue.label.endsWith("色块图")).map(({ label, code }) => [label, code]), [
    ["Black 色块图", "MEDIA_SWATCH_MISSING"], ["White 色块图", "MEDIA_ASSET_MISSING"],
  ]);
});

test("does not substitute a generic single-color swatch for an unsafe explicit path", () => {
  const selected = { groups: [{ values: ["黑色"] }] };
  const images = [descriptor(["swatch", "generic.png"])];
  const plan = buildSheinImagePlan({ product: { variantGroups: [{ options: [{ value: "黑色", swatchImagePath: "../unsafe.png" }] }] },
    variant: selected, images, tables: { media: [["黑色"]] } });
  assert.equal(plan.tasks.some(task => task.role === "swatch"), false);
  assert.ok(plan.issues.some(issue => issue.code === "MEDIA_SWATCH_PATH_INVALID"));
});

test("derives an omitted swatch only from the matched color's own unique hero", () => {
  const incomplete = structuredClone(product);
  for (const option of incomplete.variantGroups[0].options) delete option.swatchImagePath;
  const images = assets.map(descriptor).concat(descriptor(["swatch", "generic.png"]));
  const plan = buildSheinImagePlan({ product: incomplete, variant, rows, images, tables });
  const swatches = plan.tasks.filter(task => task.role === "swatch");
  assert.deepEqual(swatches.map(task => [task.options, task.image.path, task.deriveSwatch]), [
    [["黑色"], "black/hero.png", true], [["白色"], "white/hero.png", true],
  ]);
  assert.deepEqual(plan.issues, []);
});

test("uses only live swatches on the exact row and reports an additional media row without source data", () => {
  const incomplete = structuredClone(product);
  delete incomplete.variantGroups[0].options[0].swatchImagePath;
  const images = assets.map(descriptor);
  const plan = buildSheinImagePlan({ product: incomplete, variant, rows, images, tables: {
    ...tables, media: [...tables.media, ["蓝色"]], swatches: [["黑色"]],
  } });
  assert.deepEqual(plan.tasks.filter(task => task.role === "swatch").map(task => task.options), [["白色"]]);
  assert.deepEqual(plan.issues.map(({ label, code }) => [label, code]), [["蓝色 色块图", "MEDIA_SWATCH_MISSING"]]);
});

test("skips swatches when the current SHEIN media table has no swatch column", () => {
  const plan = buildSheinImagePlan({ product, variant, rows, images: assets.map(descriptor),
    tables: { ...tables, media: [...tables.media, ["蓝色"]], swatchRequired: false } });
  assert.equal(plan.tasks.some(task => task.role === "swatch"), false);
  assert.deepEqual(plan.issues, []);
});

test("plans the explicit representative color only for the pinned default SKU", () => {
  const defaultSku = "se261119171434502395170";
  const chosen = structuredClone(product);
  chosen.variantGroups[0].options = [{ ...product.variantGroups[0].options[1], swatchImagePath: undefined }];
  const params = { product: chosen, rows: [{ options: [], imagePath: "white/hero.png" }], images: assets.map(descriptor), defaultSku,
    tables: { media: [[]], supply: [[]], defaultSku, swatchRequired: false, swatchAvailable: true } };
  const plan = buildSheinImagePlan(params);
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(planSummary(plan), [["detail", [], "white/hero.png"], ["detail", [], "shared/side.png"],
    ["detail", [], "shared/material.png"], ["square", [], "white/square.png"],
    ["swatch", [], "white/hero.png"], ["variant", [], "white/hero.png"]]);
  assert.equal(plan.tasks.find(task => task.role === "swatch").deriveSwatch, true);
  assert.deepEqual(buildSheinImagePlan({ ...params, product }).tasks, []);
  assert.deepEqual(buildSheinImagePlan({ ...params, defaultSku: "stale" }).tasks, []);
});

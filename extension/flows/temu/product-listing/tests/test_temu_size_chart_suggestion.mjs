import assert from "node:assert/strict";
import { suggestTemuSizeChart } from "../size-chart-suggestion.js";

const imageDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFesAAAAASUVORK5CYII=";
const input = {
  title: "WIHOLL 上衣",
  categoryPath: ["女装", "女装T恤"],
  sizes: ["S"],
  sizeChart: {
    unit: "inch",
    columns: ["Size", "Bust", "Length"],
    rows: [["S", "37.80", "26.38"]],
    body: { unit: "cm", columns: ["尺寸（国际）", "胸围"], rows: [["S", [80, 86]]] },
  },
};
const original = structuredClone(input);
const result = await suggestTemuSizeChart(input, {
  imageDataUrl,
  request({ imageDataUrl: suppliedImage, prompt }) {
    assert.equal(suppliedImage, imageDataUrl);
    assert.deepEqual(prompt.measured, [{ size: "S", garment: { chest: "96.01", length: "67.01" }, body: { chest: ["80", "86"] } }]);
    assert.deepEqual(prompt.requests, [{ size: "S", garment: [], body: ["waist", "hip", "height"] }]);
    return { rows: [{ size: "S", body: { waist: ["64", 70], hip: [86, 92], height: [155, 165] } }] };
  },
});
assert.equal(result.ok, true);
assert.match(result.chart.name, /-试填[a-f0-9]{8}$/u);
assert.ok(result.chart.name.length <= 20);
assert.deepEqual(result.chart.rows[0], {
  size: "S", garment: { chest: "96.01", length: "67.01" },
  body: { chest: ["80", "86"], waist: ["64", "70"], hip: ["86", "92"], height: ["155", "165"] },
});
assert.deepEqual(result.estimatedCells, ["waist", "hip", "height"].map(field => ({ size: "S", scope: "body", field })));
assert.deepEqual(result.missingCells, []);
assert.deepEqual(input, original);

const completeInput = {
  ...input,
  sizeChart: {
    ...input.sizeChart,
    body: {
      unit: "cm",
      columns: ["尺寸（国际）", "胸围", "腰围", "臀围", "身高"],
      rows: [["S", [80, 86], [65, 70], [86, 92], [155, 165]]],
    },
  },
};
const noRequest = () => assert.fail("model should not be called");
const complete = await suggestTemuSizeChart(completeInput, { readImage: noRequest, request: noRequest });
assert.equal(complete.ok, true);
assert.deepEqual(complete.estimatedCells, []);
assert.deepEqual((await suggestTemuSizeChart(input, { request: noRequest })).code, "SIZE_CHART_PRODUCT_PHOTO_REQUIRED");
assert.deepEqual((await suggestTemuSizeChart({ ...input, sizes: ["S", "s"] }, { imageDataUrl, request: noRequest })).code, "SIZE_CHART_INPUT_INVALID");

const raw = await suggestTemuSizeChart({ title: "Test", sizes: ["S"] }, {
  readImage: async () => imageDataUrl,
  request({ prompt, imageDataUrl: suppliedImage }) {
    assert.equal(suppliedImage, imageDataUrl);
    assert.deepEqual(prompt.measured, [{ size: "S", garment: {}, body: {} }]);
    return { rows: [{ size: "S", garment: { length: 61, chest: 95 }, body: { waist: [65, 72], hip: null, chest: null, height: [155, 165] } }] };
  },
});
assert.equal(raw.ok, true);
assert.deepEqual(raw.chart.rows[0].garment, { chest: "95", length: "61" });
assert.deepEqual(raw.chart.rows[0].body, { waist: ["65", "72"], height: ["155", "165"] });
assert.deepEqual(raw.missingCells, ["hip", "chest"].map(field => ({ size: "S", scope: "body", field })));

const sparse = await suggestTemuSizeChart({
  ...input, sizes: ["S", "M"],
  sizeChart: { ...input.sizeChart, rows: [["S", "37.80", ""]] },
}, {
  imageDataUrl,
  request({ prompt }) {
    assert.deepEqual(prompt.requests, [
      { size: "S", garment: ["length"], body: ["waist", "hip", "height"] },
      { size: "M", garment: ["chest", "length"], body: ["waist", "hip", "chest", "height"] },
    ]);
    return { rows: [
      { size: "S", garment: { length: 63 }, body: { waist: [63, 69], hip: [85, 91], height: [150, 164] } },
      { size: "M", garment: { chest: 100, length: 66 }, body: { waist: [69, 75], hip: [91, 97], chest: [86, 92], height: [151, 165] } },
    ] };
  },
});
assert.equal(sparse.ok, true);
assert.deepEqual(sparse.chart.rows[0].garment, { chest: "96.01", length: "63" });
assert.deepEqual(sparse.chart.rows[0].body.chest, ["80", "86"]);
assert.equal(sparse.chart.rows[1].garment.chest, "100");

for (const row of [
  { size: "M", body: { waist: [64, 70], hip: [86, 92], height: [155, 165] } },
  { size: "S", garment: { chest: 99 }, body: { waist: [64, 70], hip: [86, 92], height: [155, 165] } },
  { size: "S", body: { waist: [64, 70], hip: [86, 92], height: [155, 165], cup: "A" } },
  { size: "S", body: { waist: [70, 64], hip: [86, 92], height: [155, 165] } },
  { size: "S", body: { waist: [0, 70], hip: [86, 92], height: [155, 165] } },
  { size: "S", body: { waist: [64, 310], hip: [86, 92], height: [155, 165] } },
]) {
  const rejected = await suggestTemuSizeChart(input, { imageDataUrl, request: () => ({ rows: [row] }) });
  assert.equal(rejected.code, "SIZE_CHART_ESTIMATE_FAILED");
}

const controller = new AbortController();
await assert.rejects(suggestTemuSizeChart(input, {
  imageDataUrl,
  signal: controller.signal,
  request() { controller.abort(); },
}), { name: "AbortError" });

console.log("Temu chart estimates use one image request, retain measured cells, and track exact estimate provenance.");

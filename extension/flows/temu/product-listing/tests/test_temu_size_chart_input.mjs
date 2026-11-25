import assert from "node:assert/strict";
import { prepareTemuSizeChart, temuSizeKey } from "../size-chart-input.js";

const garment = {
  unit: "inch",
  columns: ["SIZE", "BUST", "HEM", "LENGTH"],
  rows: [
    ["S", "37.80", "40.55", "26.38"],
    ["M", "40.16", "42.91", "26.77"],
    ["L", "42.52", "45.28", "27.17"],
    ["XL", "45.67", "48.43", "27.76"],
    ["2XL", "48.82", "52.36", "28.35"],
  ],
};

const input = { title: "WIHOLL 上衣", categoryId: "123", sizeSystem: "欧美尺码", sizes: ["S"], sizeChart: garment };
const result = prepareTemuSizeChart(input);
assert.equal(result.ok, true);
assert.equal(result.chart.unit, "cm");
assert.deepEqual(result.chart.rows, [{
  size: "S", garment: { chest: "96.01", length: "67.01", hem: "103.00" }, body: {},
}]);
assert.match(result.chart.name, /^WIHOLL 上衣-[a-f0-9]{8}$/u);
assert.equal(prepareTemuSizeChart(input).chart.name, result.chart.name);
assert.notEqual(prepareTemuSizeChart({ ...input, categoryId: "456" }).chart.name, result.chart.name);
assert.notEqual(prepareTemuSizeChart({ ...input, sizes: ["M"] }).chart.name, result.chart.name);
assert.equal(prepareTemuSizeChart({ ...input, sizes: ["XXL", "S"] }).chart.rows[0].garment.chest, "124.00");
assert.equal(prepareTemuSizeChart({ ...input, sizes: ["XXL", "2XL"] }).code, "SIZE_CHART_INPUT_INVALID");
assert.equal(prepareTemuSizeChart({ ...input, sizes: ["XS"] }).code, "SIZE_CHART_INPUT_INVALID");
assert.notEqual(temuSizeKey("1-2"), temuSizeKey("12"));

const sourcedBody = {
  unit: "cm",
  columns: ["尺寸（国际）", "胸围（CM）", "腰围", "臀围", "身高"],
  rows: [{ "尺寸（国际）": "S", "胸围（CM）": "83", 腰围: "65", 臀围: "90", 身高: "162" }],
};
const converted = prepareTemuSizeChart({
  ...input,
  sizeChart: {
    ...garment,
    name: "女装".repeat(24) + "🐱",
    body: sourcedBody,
  },
});
assert.equal(converted.ok, true);
assert.ok(converted.chart.name.length <= 50);
assert.deepEqual(converted.chart.rows[0].body, { waist: "65", hip: "90", chest: "83", height: "162" });
assert.equal(converted.chart.rows[0].garment.chest, "96.01");
assert.equal(prepareTemuSizeChart({ ...input, sizeChart: { ...garment, body: { ...sourcedBody, unit: "feet" } } }).code, "SIZE_CHART_INPUT_INVALID");
assert.equal(prepareTemuSizeChart({ ...input, sizeChart: { ...garment, body: { ...sourcedBody, unit: "inch" } } }).code, "SIZE_CHART_INPUT_INVALID");

const normalizedShared = {
  name: "上衣尺码图",
  unit: "cm",
  columns: ["尺寸（美国）", "尺寸（国际）", "胸围", "长度", "下摆宽度", "肩宽"],
  rows: [
    { "尺寸（美国）": "8", "尺寸（国际）": "S", 胸围: "95", 长度: "64", 下摆宽度: "52", 肩宽: "38" },
    { "尺寸（美国）": "10", "尺寸（国际）": "M", 胸围: "100", 长度: "66", 下摆宽度: "54", 肩宽: "39" },
  ],
  estimatedColumns: ["尺寸（美国）", "肩宽"],
};
const shared = prepareTemuSizeChart({ ...input, sizeChart: normalizedShared });
assert.deepEqual(shared.chart.rows, [{ size: "S", garment: { chest: "95", length: "64" }, body: {} }]);
assert.deepEqual(prepareTemuSizeChart({ sizeChart: { ...normalizedShared, estimatedColumns: [] } }).chart.rows.map(row => row.size), ["S", "M"]);
assert.equal(prepareTemuSizeChart({ sizes: ["8"], sizeChart: normalizedShared }).code, "SIZE_CHART_INPUT_INVALID");

const invalidMeasurements = { unit: "cm", columns: ["Size", "Chest"], rows: [["S", "0"]] };
assert.equal(prepareTemuSizeChart({ ...input, sizeChart: invalidMeasurements }).code, "SIZE_CHART_INPUT_INVALID");
const conflict = { unit: "cm", columns: ["尺码", "US", "胸围"], rows: [["S", "M", 80], ["M", "S", 85]] };
assert.equal(prepareTemuSizeChart({ ...input, sizeChart: conflict }).code, "SIZE_CHART_INPUT_INVALID");
assert.equal(prepareTemuSizeChart({ sizes: ["S"] }).code, "SIZE_CHART_INPUT_MISSING");

console.log("Temu size input converts sourced measurements and preserves separate body sizing.");

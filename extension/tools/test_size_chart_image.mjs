import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { completeSizeChart, normalizeSizeChart, parseSizeChartImage, parseSizeChartResponse } from "../lib/size-chart.mjs";

const name = "上衣试验尺码表";
const instructionUrl = "chrome-extension://test/skills/size-chart-image/SKILL.md";
const visionUrl = "https://vision.example/v1/chat/completions";
const imageDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Xlt0AAAAASUVORK5CYII=";
const settings = {
  text: { baseUrl: "https://text.example/v1", model: "text-model", apiKey: "not-used" },
  multimodal: { baseUrl: "https://vision.example/v1", model: "vision-model", apiKey: "test-key" },
};
const chart = {
  unit: "inches",
  columns: ["SIZE", "BUST", "HEM", "LENGTH"],
  rows: [["S", "35.20", "42", "25"], ["2XL", "44.5", "51", "28"]],
};
const expected = {
  name,
  unit: "inch",
  columns: ["尺寸（国际）", "胸围", "下摆宽度", "长度"],
  rows: [
    { "尺寸（国际）": "S", "胸围": "35.20", "下摆宽度": "42", "长度": "25" },
    { "尺寸（国际）": "2XL", "胸围": "44.5", "下摆宽度": "51", "长度": "28" },
  ],
};

test("preserves decimal precision and distinct garment dimensions in a model result", () => {
  const wrapped = "```json\n" + JSON.stringify(chart) + "\n```";
  assert.deepEqual(parseSizeChartResponse(wrapped, { name }), expected);
  assert.deepEqual(normalizeSizeChart(expected), expected);
});

test("stops on ambiguous numeric sizes, incomplete cells, and duplicate aliases", () => {
  assert.throws(() => normalizeSizeChart({ ...chart, rows: [["4", "35.20", "42", "25"]] }, { name }), /尺码体系/);
  assert.throws(() => normalizeSizeChart({ ...chart, rows: [["S", "35.20", null, "25"]] }, { name }), /第 1 行「下摆宽度」/);
  assert.throws(() => normalizeSizeChart({ ...chart, columns: ["SIZE", "BUST", "胸围", "LENGTH"] }, { name }), /互不重复/);
  assert.throws(() => normalizeSizeChart({ ...chart, rows: [["S", "35–38", "42", "25"]] }, { name }), /大于零的测量值/);
  assert.throws(() => normalizeSizeChart({ ...chart, unit: null }, { name }), /厘米.*英寸/);
});

async function mockVision(t, generate) {
  const skill = await readFile(new URL("../skills/size-chart-image/SKILL.md", import.meta.url), "utf8");
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.chrome = {
    runtime: { getURL: file => `chrome-extension://test/${file}` },
    permissions: { contains: async () => true },
  };
  globalThis.fetch = async (url, options) => {
    requests.push(url);
    if (url === instructionUrl) return new Response(skill);
    assert.equal(url, visionUrl);
    const request = JSON.parse(options.body);
    assert.equal(request.model, "vision-model");
    assert.match(request.messages[0].content, /逐格读取/);
    assert.equal(request.tools, undefined);
    const response = generate(request.messages[1].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) }, finish_reason: "stop" }] }));
  };
  t.after(() => {
    delete globalThis.chrome;
    globalThis.fetch = originalFetch;
  });
  return requests;
}

test("sends only the bundled instructions and image to the configured vision model", async t => {
  const requests = await mockVision(t, content => {
    assert.equal(content[1].image_url.url, imageDataUrl);
    return chart;
  });
  assert.deepEqual(await parseSizeChartImage({ settings, imageDataUrl, name }), expected);
  await assert.rejects(parseSizeChartImage({ settings, imageDataUrl: "https://not-a-local-image/", name }), /PNG、JPEG 或 WebP/);
  await assert.rejects(parseSizeChartImage({ settings: {}, imageDataUrl, name }), /多模态模型/);
  assert.deepEqual(requests, [instructionUrl, visionUrl]);
});

test("adds only missing columns, keeps originals, and restricts generated sizes to unique page options", async t => {
  const us = "尺寸（美国）";
  const requiredColumns = [us, "长度", "肩宽"];
  const optionsByColumn = { [us]: ["4", "6", "16", "18"] };
  let response = { columns: [us, "肩宽"], rows: [[1, "4", "14.25"], [2, "16", "17.5"]] };
  const requests = await mockVision(t, content => {
    const prompt = JSON.parse(content[0].text);
    assert.equal(prompt.mode, "complete");
    assert.equal(prompt.unit, "inch");
    assert.deepEqual(prompt.sourceRows, [[1, "S", "35.20", "42", "25"], [2, "2XL", "44.5", "51", "28"]]);
    assert.deepEqual(prompt.missingColumns, [us, "肩宽"]);
    assert.deepEqual(prompt.optionsByColumn, optionsByColumn);
    assert.equal(content[1].image_url.url, imageDataUrl);
    return response;
  });
  const input = { settings, chart: expected, requiredColumns, optionsByColumn, productImageDataUrl: imageDataUrl };
  const result = await completeSizeChart(input);
  assert.deepEqual(result.estimatedColumns, [us, "肩宽"]);
  assert.deepEqual(result.rows[0], { ...expected.rows[0], [us]: "4", "肩宽": "14.25" });
  assert.deepEqual(result.rows[1], { ...expected.rows[1], [us]: "16", "肩宽": "17.5" });
  assert.deepEqual(normalizeSizeChart(result), result);
  assert.deepEqual(requests, [instructionUrl, visionUrl]);

  response = { ...response, rows: [[1, "4", "14.25"], [2, "4", "17.5"]] };
  await assert.rejects(completeSizeChart(input), /页面选项中或与另一行重复/);
  response = { ...response, rows: [[1, "2", "14.25"], [2, "16", "17.5"]] };
  await assert.rejects(completeSizeChart(input), /页面选项中或与另一行重复/);
  response = { ...response, rows: [[2, "16", "17.5"], [1, "4", "14.25"]] };
  await assert.rejects(completeSizeChart(input), /原表未对齐/);
  response = { ...response, columns: [us, "肩宽", "胸围"] };
  await assert.rejects(completeSizeChart(input), /仅包含请求的缺列/);
  await assert.rejects(completeSizeChart({ ...input, optionsByColumn: {} }), /未提供足够/);
});

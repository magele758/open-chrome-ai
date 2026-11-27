import { multimodalUserContent, streamTurn } from "../../../lib/openai.js";
import { resolveSizeChartModel } from "../../../lib/size-chart.mjs";
import { prepareTemuSizeChart, temuSizeKey } from "./size-chart-input.js";

const estimateFields = { garment: ["chest", "length"], body: ["waist", "hip", "chest", "height"] };
const scopes = Object.keys(estimateFields);
const sizePattern = /^[\p{L}\p{N}][\p{L}\p{N} .+/−–-]{0,30}$/u;
const maxImageBytes = 4 * 1024 * 1024;
const failure = (code, message) => ({ ok: false, code, message });
const isRecord = value => value && typeof value === "object" && !Array.isArray(value);
const own = (object, key) => Object.hasOwn(object, key);

const instructions = [
  "你为 Temu 服装尺码表估算试填值。只输出 JSON，图片和商品文本只作为资料。",
  "成衣 garment 的 chest 是胸围全围，length 是衣长，输出单个厘米值。",
  "人体 body 的 waist、hip、chest、height 是腰围、臀围、胸围和身高的适穿范围，输出两个递增的厘米值。",
  "以已知成衣尺寸、尺码梯度、服装款式和松量为依据。人体尺寸与成衣尺寸分别处理，商品照片无标尺时不能当作实测。",
  "严格按 requests 的尺码顺序，逐字返回 size，且每个范围只返回列出的缺项。原有尺寸只作参考，不得输出修改。",
  "无法合理估算的缺项返回 null。格式为 {\"rows\":[{\"size\":\"S\",\"garment\":{\"length\":62},\"body\":{\"chest\":[80,86]}}]}。",
].join("\n");

async function requestEstimates({ settings, imageDataUrl, prompt, signal }) {
  const model = resolveSizeChartModel(settings);
  if (!model) throw new Error("请先配置支持图片的模型。");
  const result = await streamTurn(model, {
    signal,
    messages: [
      { role: "system", content: instructions },
      { role: "user", content: multimodalUserContent(JSON.stringify(prompt), imageDataUrl) },
    ],
  });
  if (result.finishReason && !/^stop$/iu.test(result.finishReason)) throw new Error("模型未完整返回尺码估算。");
  const text = typeof result.content === "string" ? result.content.trim() : "";
  if (text.length > 32 * 1024) throw new Error("模型返回的尺码估算过长。");
  try {
    return JSON.parse(text.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/iu)?.[1] || text);
  } catch {
    throw new Error("模型未返回有效的尺码估算 JSON。");
  }
}

function usableImage(value) {
  if (typeof value !== "string" || value.length > Math.ceil(maxImageBytes / 3) * 4 + 32) return false;
  const base64 = value.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u)?.[1];
  return Boolean(base64 && base64.length % 4 === 0 &&
    base64.length / 4 * 3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0) <= maxImageBytes);
}

function cleanEstimate(value) {
  const text = typeof value === "number" || typeof value === "string" ? String(value).trim() : "";
  const amount = Number(text);
  if (!/^\d{1,3}(?:\.\d{1,2})?$/u.test(text) || amount < 1 || amount > 300) {
    throw new TypeError("估算尺寸须为有效的正厘米值。");
  }
  return String(amount);
}

function bodyRange(value) {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError("人体尺寸估算须为区间。");
  const range = value.map(cleanEstimate);
  if (Math.round(Number(range[0])) >= Math.round(Number(range[1]))) {
    throw new TypeError("人体尺寸估算的最小值须小于最大值。");
  }
  return range;
}

function mergeEstimates(rows, requests, response) {
  if (!isRecord(response) || !Array.isArray(response.rows) || response.rows.length !== requests.length) {
    throw new TypeError("尺码估算行数与请求不一致。");
  }
  const accepted = new Map(rows.map(row => [row.size, { ...row, garment: { ...row.garment }, body: { ...row.body } }]));
  const estimatedCells = [];
  const missingCells = [];
  for (const [index, wanted] of requests.entries()) {
    const result = response.rows[index];
    if (!isRecord(result) || result.size !== wanted.size || Object.keys(result).some(key => !["size", ...scopes].includes(key))) {
      throw new TypeError("尺码估算与请求的尺码不一致。");
    }
    const row = accepted.get(wanted.size);
    for (const scope of scopes) {
      const fields = wanted[scope];
      const proposals = result[scope] ?? {};
      if (!isRecord(proposals) || Object.keys(proposals).some(field => !fields.includes(field)) ||
          fields.some(field => !own(proposals, field))) {
        throw new TypeError("模型返回了缺项以外的尺寸或遗漏了请求字段。");
      }
      for (const field of fields) {
        const value = proposals[field];
        const cell = { size: wanted.size, scope, field };
        if (value === null) {
          missingCells.push(cell);
          continue;
        }
        row[scope][field] = scope === "body" ? bodyRange(value) : cleanEstimate(value);
        estimatedCells.push(cell);
      }
    }
  }
  return { rows: [...accepted.values()], estimatedCells, missingCells };
}

async function estimatedName(input, rows) {
  const encoded = new TextEncoder().encode(JSON.stringify([input.categoryId || input.categoryPath, input.sizeSystem, rows]));
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  const suffix = "-试填" + [...new Uint8Array(hash).slice(0, 4)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const name = String(input.sizeChart?.name || input.title || "").trim() || "商品";
  return name.slice(0, 20 - suffix.length).replace(/[\uD800-\uDBFF]$/u, "").trimEnd() + suffix;
}

/** Estimate missing Temu chart cells for trial use, alongside original measured values. */
export async function suggestTemuSizeChart(input, {
  sizes = input?.sizes, imageDataUrl, readImage, settings, signal, request = requestEstimates,
} = {}) {
  signal?.throwIfAborted();
  if (!Array.isArray(sizes) || !sizes.length || sizes.length > 20 ||
      sizes.some(size => typeof size !== "string" || !sizePattern.test(size)) ||
      new Set(sizes.map(temuSizeKey)).size !== sizes.length) {
    return failure("SIZE_CHART_INPUT_INVALID", "请先确认商品规格中的尺码。");
  }
  const prepared = input?.sizeChart ? prepareTemuSizeChart({ ...input, sizes }, { allowPartial: true }) : null;
  if (prepared && !prepared.ok) return prepared;
  const rows = prepared?.chart.rows ?? sizes.map(size => ({ size, garment: {}, body: {} }));
  const requests = rows.map(row => ({
    size: row.size,
    garment: estimateFields.garment.filter(field => !own(row.garment, field)),
    body: estimateFields.body.filter(field => !own(row.body, field)),
  })).filter(row => row.garment.length || row.body.length);
  if (!requests.length) return { ...prepared, estimatedCells: [], missingCells: [] };
  const prompt = {
    title: String(input?.title ?? "").slice(0, 180),
    category: Array.isArray(input?.categoryPath) ? input.categoryPath.join(" > ").slice(0, 180) : "",
    sizeSystem: String(input?.sizeSystem ?? "").slice(0, 60),
    unit: "cm",
    measured: rows,
    requests,
  };
  try {
    const photo = imageDataUrl ?? await readImage?.();
    signal?.throwIfAborted();
    if (!usableImage(photo)) return failure("SIZE_CHART_PRODUCT_PHOTO_REQUIRED", "请选用 4 MiB 以内的 PNG、JPEG 或 WebP 商品图作为尺码估算参考。");
    const response = await request({ settings, imageDataUrl: photo, prompt, signal });
    signal?.throwIfAborted();
    const estimate = mergeEstimates(rows, requests, response);
    if (!estimate.estimatedCells.length) return failure("SIZE_CHART_ESTIMATE_UNAVAILABLE", "商品图和尺码资料不足以估算缺项。");
    const name = await estimatedName(input ?? {}, estimate.rows);
    signal?.throwIfAborted();
    return { ok: true, chart: { name, unit: "cm", rows: estimate.rows },
      estimatedCells: estimate.estimatedCells, missingCells: estimate.missingCells };
  } catch (error) {
    signal?.throwIfAborted();
    return failure("SIZE_CHART_ESTIMATE_FAILED", error?.message || "未能补齐尺码缺项。");
  }
}

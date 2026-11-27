import { multimodalUserContent, streamTurn } from "./openai.js";
import { ensureSkillBody } from "./skill-folder.js";
import { isModelReady, resolveModel } from "./storage.js";

const SIZE_CHART_SKILL = "size-chart-image";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_URL_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 32;
const sizeColumns = new Map([
  ["尺寸（国际）", ["size", "国际尺码", "尺码", "尺寸", "international size", "intl size", "alpha size"]],
  ["尺寸（美国）", ["us", "us size", "size us", "美国尺码"]],
  ["尺寸（英国）", ["uk", "uk size", "size uk", "英国尺码"]],
  ["尺寸（欧盟）", ["eu", "eu size", "size eu", "欧洲尺码", "欧盟尺码"]],
  ["尺寸（巴西）", ["br", "br size", "size br", "巴西尺码"]],
  ["尺寸（哥伦比亚）", ["co size", "colombia size", "哥伦比亚尺码"]],
  ["尺寸（厘米）", ["size cm", "cm size"]],
  ["尺寸（英寸）", ["size inch", "inch size"]],
  ["尺寸（年龄）", ["age", "size age", "age size", "年龄尺码"]],
  ["尺寸（毫米）", ["size mm", "mm size"]],
]);
const measurements = new Map([
  ["宽度", ["width"]],
  ["肩宽", ["shoulder", "shoulder width"]],
  ["上衣长度", ["top length", "shirt length", "t-shirt length", "衣长", "上衣长"]],
  ["胸围", ["bust", "bust circumference", "chest", "chest circumference"]],
  ["腰围", ["waist", "waist circumference"]],
  ["袖长", ["sleeve", "sleeve length"]],
  ["模特身高", ["model height"]],
  ["模特体重", ["model weight"]],
  ["颈宽", ["neck width"]],
  ["领长", ["collar length"]],
  ["后背宽", ["back width"]],
  ["下摆宽度", ["hem", "hem width", "下摆宽"]],
  ["领口宽度", ["neckline width", "collar width"]],
  ["袖口宽", ["cuff width", "sleeve opening width"]],
  ["后衣长", ["back length", "back top length"]],
  ["支数纱支数", ["yarn count"]],
  ["磅数", ["pounds"]],
  ["长度", ["length", "garment length"]],
  ["臀围", ["hip", "hips", "hip circumference"]],
  ["周长", ["circumference"]],
  ["体重", ["weight"]],
  ["身高", ["height"]],
  ["下胸围", ["underbust", "under bust"]],
  ["裤长", ["pant length", "pants length", "trouser length"]],
  ["裤内长", ["inseam", "inside leg length", "内侧裤长"]],
  ["大腿围", ["thigh circumference", "thigh"]],
  ["裤口宽", ["leg opening", "leg opening width"]],
]);

function headingKey(value) {
  return String(value ?? "").normalize("NFKC").trim().toLowerCase().replace(/[\s()_\-]+/gu, "");
}

const columnsByHeading = new Map([...sizeColumns, ...measurements].flatMap(([label, aliases]) =>
  [label, ...aliases].map(alias => [headingKey(alias), label])));
const genericSize = new Set(["size", "尺码", "尺寸"]);
const sizePattern = /^[\p{L}\p{N}][\p{L}\p{N} .+/−–-]{0,30}$/u;
const alphaSize = /^(?:[0-9]*x{0,2}[smlx]|[0-9]+x[lst]|xxxl|xxxxl|one size|os|均码)$/iu;

function sizeError(message) {
  return new Error(`尺码图解析失败 · ${message}`);
}

function unitFor(value) {
  const label = String(value ?? "").normalize("NFKC").trim().toLowerCase();
  if (["cm", "厘米", "centimeter", "centimeters"].includes(label)) return "cm";
  if (["inch", "inches", "in", '"', "英寸"].includes(label)) return "inch";
  throw sizeError("请明确使用厘米（cm）或英寸（inch）");
}

function cellText(value, column, row, inferredInternational) {
  if (typeof value !== "number" && typeof value !== "string") {
    throw sizeError(`第 ${row} 行「${column}」缺少可辨认的值`);
  }
  const text = String(value).normalize("NFKC").trim();
  if (sizeColumns.has(column)) {
    if (!sizePattern.test(text)) throw sizeError(`第 ${row} 行「${column}」不是有效的尺码`);
    if (inferredInternational && !alphaSize.test(text)) {
      throw sizeError(`第 ${row} 行数字尺码需要明确标注尺码体系`);
    }
  } else if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(text) || !Number.isFinite(Number(text)) || Number(text) <= 0) {
    throw sizeError(`第 ${row} 行「${column}」须提供一个大于零的测量值`);
  }
  return text;
}

export function normalizeSizeChart(value, { name } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw sizeError("结果不是尺码表");
  if (typeof value.error === "string" && value.error.trim()) throw sizeError(value.error.trim().slice(0, 200));
  const chartName = String(value.name ?? name ?? "").trim();
  if (!chartName || [...chartName].length > 50) throw sizeError("尺码表名称须有 1–50 个字符");
  const unit = unitFor(value.unit);
  if (!Array.isArray(value.columns) || value.columns.length < 2 || !Array.isArray(value.rows) || !value.rows.length) {
    throw sizeError("尺码表须有尺码列、测量列和至少一行数据");
  }
  const columns = value.columns.map(source => {
    if (typeof source !== "string") throw sizeError("尺码列名称须为文字");
    const label = columnsByHeading.get(headingKey(source));
    if (!label) throw sizeError(`无法识别列「${source.slice(0, 60)}」`);
    return label;
  });
  const sizing = columns.filter(label => sizeColumns.has(label));
  if (!sizing.length || sizing.length === columns.length || new Set(columns).size !== columns.length) {
    throw sizeError("须包含互不重复的尺码列和测量列");
  }

  const seenSizes = new Set();
  const rows = value.rows.map((raw, index) => {
    if (!raw || typeof raw !== "object" || (Array.isArray(raw) && raw.length !== columns.length)) {
      throw sizeError(`第 ${index + 1} 行与表头的列数不一致`);
    }
    const row = Object.fromEntries(columns.map((column, position) => {
      const source = value.columns[position];
      const cell = Array.isArray(raw) ? raw[position] : Object.hasOwn(raw, source) ? raw[source] : raw[column];
      return [column, cellText(cell, column, index + 1, genericSize.has(headingKey(source)))];
    }));
    const size = JSON.stringify(sizing.map(column => row[column].toUpperCase()));
    if (seenSizes.has(size)) throw sizeError(`第 ${index + 1} 行与前面的尺码重复`);
    seenSizes.add(size);
    return row;
  });
  const generated = Array.isArray(value.estimatedColumns) ? value.estimatedColumns : [];
  const estimated = new Set(generated.map(label => columnsByHeading.get(headingKey(label))));
  const estimatedColumns = columns.filter(column => estimated.has(column));
  return { name: chartName, unit, columns, rows, ...(estimatedColumns.length ? { estimatedColumns } : {}) };
}

function parseModelJson(content) {
  const text = typeof content === "string" ? content.trim() : "";
  if (text.length > 64 * 1024) throw sizeError("识别结果过长");
  const json = text.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/iu)?.[1] ?? text;
  try {
    return JSON.parse(json);
  } catch {
    throw sizeError("识别模型未返回有效的尺码表 JSON");
  }
}

export function parseSizeChartResponse(content, { name } = {}) {
  return normalizeSizeChart(parseModelJson(content), { name });
}

function validateImageDataUrl(value) {
  if (typeof value !== "string" || value.length > MAX_IMAGE_URL_LENGTH) throw sizeError("图片不可用或超过 4 MiB");
  const image = value.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u)?.[1];
  if (!image || image.length % 4 !== 0) throw sizeError("请提供 PNG、JPEG 或 WebP 图片");
  const bytes = image.length / 4 * 3 - (image.endsWith("==") ? 2 : image.endsWith("=") ? 1 : 0);
  if (bytes > MAX_IMAGE_BYTES) throw sizeError("图片超过 4 MiB");
}

export function resolveSizeChartModel(settings = {}) {
  const configured = resolveModel(settings, "multimodal");
  if (isModelReady(configured)) return configured;
  const selected = resolveModel(settings, "text");
  const visualSeed = /^doubao-seed-(?:evolving|2-[01]-(?:pro|lite|mini)(?:-\d+)?)$/iu;
  return isModelReady(selected) && visualSeed.test(selected.model) ? selected : null;
}

async function requestSizeChart({ settings, content, signal }) {
  signal?.throwIfAborted();
  const model = resolveSizeChartModel(settings);
  if (!isModelReady(model)) throw sizeError("请先在 PageLens 设置中配置支持图片的多模态模型");
  const skill = await ensureSkillBody({ id: SIZE_CHART_SKILL, source: "bundled" });
  if (!skill?.body) throw sizeError("未能加载内置的服装尺码图解析 Skill");
  signal?.throwIfAborted();
  const result = await streamTurn(model, {
    signal,
    messages: [
      { role: "system", content: skill.body },
      { role: "user", content },
    ],
  });
  if (result.finishReason && !/^stop$/iu.test(result.finishReason)) throw sizeError("识别模型未完整返回尺码表");
  return parseModelJson(result.content);
}

export async function parseSizeChartImage({ settings, imageDataUrl, name, signal } = {}) {
  validateImageDataUrl(imageDataUrl);
  const content = multimodalUserContent("逐行提取图片中的尺码表，按指定格式返回 JSON。", imageDataUrl);
  const source = await requestSizeChart({ settings, content, signal });
  return normalizeSizeChart(source, { name });
}

export async function completeSizeChart({ settings, chart, requiredColumns, optionsByColumn = {}, productImageDataUrl, signal } = {}) {
  signal?.throwIfAborted();
  const base = normalizeSizeChart(chart);
  if (!Array.isArray(requiredColumns)) throw sizeError("缺少页面要求的尺码列");
  const missing = [];
  for (const label of new Set(requiredColumns)) {
    const column = columnsByHeading.get(headingKey(label));
    if (!column) throw sizeError(`无法补全页面列「${String(label).slice(0, 60)}」`);
    if (!base.columns.includes(column) && !missing.includes(column)) missing.push(column);
  }
  if (!missing.length) return base;
  if (productImageDataUrl) validateImageDataUrl(productImageDataUrl);

  const choices = new Map();
  for (const column of missing.filter(label => sizeColumns.has(label))) {
    const options = optionsByColumn?.[column];
    if (!Array.isArray(options) || options.some(option => typeof option !== "string" || !option.trim()) ||
        new Set(options).size < base.rows.length) {
      throw sizeError(`页面未提供足够的「${column}」尺码选项`);
    }
    choices.set(column, new Set(options));
  }
  const prompt = JSON.stringify({
    mode: "complete",
    unit: base.unit,
    sourceColumns: base.columns,
    sourceRows: base.rows.map((row, index) => [index + 1, ...base.columns.map(column => row[column])]),
    missingColumns: missing,
    optionsByColumn: Object.fromEntries([...choices].map(([column, options]) => [column, [...options]])),
  });
  const content = multimodalUserContent(prompt, productImageDataUrl);
  const result = await requestSizeChart({ settings, content, signal });
  if (typeof result?.error === "string" && result.error.trim()) throw sizeError(result.error.trim().slice(0, 200));
  if (!Array.isArray(result?.columns) || result.columns.length !== missing.length ||
      !missing.every((column, index) => result.columns[index] === column) ||
      !Array.isArray(result.rows) || result.rows.length !== base.rows.length) {
    throw sizeError("补全结果须逐行对应原表，且仅包含请求的缺列");
  }

  const used = new Map([...choices.keys()].map(column => [column, new Set()]));
  const rows = result.rows.map((row, index) => {
    if (!Array.isArray(row) || row.length !== missing.length + 1 || row[0] !== index + 1) {
      throw sizeError(`补全结果第 ${index + 1} 行和原表未对齐`);
    }
    const cells = Object.fromEntries(missing.map((column, position) => {
      const value = cellText(row[position + 1], column, index + 1, false);
      if (choices.has(column)) {
        if (!choices.get(column).has(value) || used.get(column).has(value)) {
          throw sizeError(`第 ${index + 1} 行「${column}」的尺码不在页面选项中或与另一行重复`);
        }
        used.get(column).add(value);
      }
      return [column, value];
    }));
    return { ...base.rows[index], ...cells };
  });
  return {
    ...base,
    columns: [...base.columns, ...missing],
    rows,
    estimatedColumns: [...(base.estimatedColumns ?? []), ...missing],
  };
}

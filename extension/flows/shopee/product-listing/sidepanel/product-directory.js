import { loadSettings } from "../../../../lib/storage.js";
import { requireOptionalFeature } from "../../../../lib/optional-permissions.js";
import { parseSizeChartImage, resolveSizeChartModel } from "../../../../lib/size-chart.mjs";
import { createListingAdvisor } from "../../../shared/listing/listing-advisor.js";

const absolute = /^(?:\/|[A-Za-z]:[\\/])/u;

const readFromHost = ({ path }) => chrome.runtime.sendMessage({ type: "pl.ptc.readDirectory", path });
const readChartChunk = (args) => chrome.runtime.sendMessage({ type: "pl.ptc.readSizeChartChunk", ...args });
const MAX_SIZE_CHART_IMAGE = 4 * 1024 * 1024;
const SIZE_CHART_CHUNK = 600 * 1024;
const CHART_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const CHART_CACHE_KEY = "ptcShopeeSizeChartCacheV1";
const MAX_CACHED_CHARTS = 24;
let chartCacheWrites = Promise.resolve();

function isAbsolutePath(value) {
  return typeof value === "string" && absolute.test(value) && !value.includes("\0") &&
    !value.split(/[/\\]/u).includes("..");
}

function withinFolder(path, root, folder) {
  if (!isAbsolutePath(path)) return false;
  const slash = /^\w:/u.test(root) ? (value) => value.replace(/\\/gu, "/") : (value) => value;
  const prefix = `${slash(root).replace(/\/+$/u, "")}/${folder}/`;
  return slash(path).startsWith(prefix);
}

export async function loadProductDirectory(path, { send = readFromHost } = {}) {
  if (typeof path !== "string" || !isAbsolutePath(path.trim())) {
    throw new Error("请输入商品目录的绝对路径。");
  }
  const loaded = await send({ op: "fs", action: "loadProductDirectory", path: path.trim() }, { interactive: false });
  return validateProductDirectory(loaded);
}

export async function chooseShopeeProductDirectory({
  authorize = requireOptionalFeature, choose = () => chrome.runtime.sendMessage({ type: "pl.ptc.chooseDirectory" }),
} = {}) {
  const denied = await authorize("nativeMessaging", { userGesture: true });
  if (denied) throw new Error(denied);
  const selected = await choose();
  if (selected?.ok === true && selected.cancelled) return null;
  const loaded = validateProductDirectory(selected);
  if (typeof selected.directoryName !== "string" || !selected.directoryName.trim()) {
    throw new Error("本机助手未返回商品目录名称。");
  }
  return { ...loaded, directoryName: selected.directoryName };
}

export function validateProductDirectory(loaded) {
  if (loaded?.ok !== true) throw new Error(loaded?.error || "无法从本机读取商品目录。");
  const { root, products, issues = [] } = loaded;
  if (!isAbsolutePath(root) || !Array.isArray(products) || !Array.isArray(issues)) {
    throw new Error("本机助手返回的商品目录格式无效。");
  }
  for (const product of products) {
    const { folder, title, input } = product || {};
    if (typeof folder !== "string" || !folder || /^\.{1,2}$/u.test(folder) || /[/\\\0]/u.test(folder) ||
      typeof title !== "string" || !title.trim() || !input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("本机助手返回的商品数据格式无效。");
    }
    const variants = Array.isArray(input.variant?.options) ? input.variant.options : [input.variant];
    const images = [input.imagePath, ...(Array.isArray(input.galleryImages) ? input.galleryImages : []),
      ...variants.map((row) => row?.imagePath), input.sizeChartImagePath];
    if (images.some((image) => image != null && !withinFolder(image, root, folder))) {
      throw new Error(`「${folder}」的图片超出了此商品目录。`);
    }
  }
  return { root, products, issues };
}

export async function readProductImage({ root, folder, path, asset, signal, send = readChartChunk }) {
  const label = asset === "main" ? "商品主图" : "尺码图";
  if (!isAbsolutePath(root) || typeof folder !== "string" || !folder ||
      /^\.{1,2}$/u.test(folder) || /[/\\\0]/u.test(folder) || !withinFolder(path, root, folder)) {
    throw new Error(`${label}超出了此商品目录。`);
  }
  let offset = 0;
  let expected;
  const segments = [];
  do {
    signal?.throwIfAborted();
    const response = await send({ root, folder, expectedPath: path, offset, revision: expected?.revision, asset });
    signal?.throwIfAborted();
    if (response?.ok !== true) throw new Error(response?.error || `无法读取${label}。`);
    const { mime, revision, size, length, base64 } = response;
    if (!CHART_IMAGE_TYPES.has(mime) || !Number.isInteger(size) || size <= 0 || size > MAX_SIZE_CHART_IMAGE ||
        typeof revision !== "string" || !revision || size <= offset || response.offset !== offset ||
        expected && (expected.size !== size || expected.mime !== mime || expected.revision !== revision) ||
        length !== Math.min(SIZE_CHART_CHUNK, size - offset) ||
        typeof base64 !== "string" || base64.length !== Math.ceil(length / 3) * 4) {
      throw new Error(`本机助手返回的${label}不完整，请重新读取商品目录。`);
    }
    expected ??= { mime, revision, size };
    segments.push(base64);
    offset += length;
  } while (offset < expected.size);
  return `data:${expected.mime};base64,${segments.join("")}`;
}

export function readSizeChartImage(args) {
  return readProductImage({ ...args, asset: "sizeChart" });
}

export function directoryAttributeAdvice(product, {
  root, signal, readImage = readProductImage, getSettings = loadSettings, createAdvisor = createListingAdvisor,
} = {}) {
  let advisor;
  async function prepare() {
    const { folder, input } = product;
    const settings = await getSettings();
    const referenceImages = [];
    if (input.imagePath) {
      const image = await readImage({ root, folder, path: input.imagePath, asset: "main", signal });
      const blob = await (await fetch(image, { signal })).blob();
      referenceImages.push({ role: "main", file: blob });
    }
    return createAdvisor({ settings, product: input, referenceImages, signal, categoryPlatform: "Shopee" });
  }
  const getAdvisor = () => (advisor ??= prepare());
  const fields = async list => (await getAdvisor()).fields(list);
  fields.chooseCategory = async info => (await getAdvisor()).chooseCategory(info);
  fields.chooseCachedCategory = async info => (await getAdvisor()).chooseCachedCategory(info);
  fields.categoryKeywords = async info => (await getAdvisor()).categoryKeywords(info);
  return fields;
}

export async function completeDirectorySizeChartInput(product, {
  root, readImage = readProductImage, complete = completeSizeChartInput, ...requirements
}) {
  const { folder, input } = product;
  const { requiredColumns, optionsByColumn = {}, signal } = requirements;
  const needsMeasurements = requiredColumns.some(label => !/^尺寸[（(]/u.test(label) &&
    !Object.hasOwn(optionsByColumn, label) && !requirements.chart.columns.includes(label));
  const productImageDataUrl = needsMeasurements && input.imagePath
    ? await readImage({ root, folder, path: input.imagePath, asset: "main", signal })
    : undefined;
  return complete({ ...requirements, productImageDataUrl });
}

export async function prepareSizeChartInput(product, {
  root, signal, getSettings = loadSettings, readImage = readSizeChartImage, parse = parseSizeChartImage,
} = {}) {
  const { folder, input } = product;
  if (input.sizeChart != null || !input.sizeChartImagePath) return input;
  const [settings, imageDataUrl] = await Promise.all([
    getSettings(),
    readImage({ root, folder, path: input.sizeChartImagePath, signal }),
  ]);
  const name = input.sizeChartName ?? [...input.title].slice(0, 21).join("").trimEnd() + " 尺码表";
  const sizeChart = await cachedChart(settings, ["image", input.category, name, imageDataUrl], () =>
    parse({ settings, imageDataUrl, name, signal }));
  return { ...input, sizeChart };
}

async function cachedChart(settings, keyParts, compute, compatible) {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage || !globalThis.crypto?.subtle) return compute();
  const model = resolveSizeChartModel(settings);
  const source = JSON.stringify([model?.baseUrl, model?.model, ...keyParts]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const key = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const stored = await storage.get(CHART_CACHE_KEY).catch(() => ({}));
  const storedEntries = stored[CHART_CACHE_KEY];
  const hit = Array.isArray(storedEntries) && (storedEntries.find((entry) => entry?.key === key) ||
    (compatible && storedEntries.find((entry) => compatible(entry?.chart))));
  if (hit) return hit.chart;
  const chart = await compute();
  const commit = chartCacheWrites.then(async () => {
    const data = await storage.get(CHART_CACHE_KEY);
    const entries = Array.isArray(data[CHART_CACHE_KEY]) ? data[CHART_CACHE_KEY] : [];
    await storage.set({
      [CHART_CACHE_KEY]: [{ key, chart }, ...entries.filter((entry) => entry?.key && entry.key !== key)].slice(0, MAX_CACHED_CHARTS),
    });
  });
  chartCacheWrites = commit.catch(() => {});
  await chartCacheWrites;
  return chart;
}

export async function completeSizeChartInput({ chart, category, requiredColumns, optionsByColumn, productImageDataUrl, signal }) {
  const settings = await loadSettings();
  const { completeSizeChart } = await import("../../../../lib/size-chart.mjs");
  const orderedOptions = Object.fromEntries(Object.entries(optionsByColumn ?? {}).map(([label, options]) =>
    [label, [...options].sort()]));
  const key = ["missing-required", category, chart, requiredColumns, orderedOptions];
  if (productImageDataUrl) key.push(productImageDataUrl);
  const us = "尺寸（美国）";
  // Older cache entries may contain the same source chart and a wider option list.
  // Reuse only if every original cell and each accepted size still match.
  const compatible = !productImageDataUrl && requiredColumns.length === 1 && requiredColumns[0] === us &&
    /^女装\s*>\s*上衣\s*>/u.test(category || "") && orderedOptions[us] ? candidate => {
      if (candidate?.name !== chart.name || candidate.unit !== chart.unit ||
          !candidate.rows || candidate.rows.length !== chart.rows.length ||
          candidate.estimatedColumns?.length !== 1 || candidate.estimatedColumns[0] !== us) return false;
      const seen = new Set();
      return candidate.rows.every((row, index) => {
        const estimate = row[us];
        if (!orderedOptions[us].includes(estimate) || seen.has(estimate)) return false;
        seen.add(estimate);
        return chart.columns.every(label => row[label] === chart.rows[index][label]);
      });
    } : null;
  return cachedChart(settings, key, () => completeSizeChart({
    settings, chart, requiredColumns, optionsByColumn, productImageDataUrl, signal,
  }), compatible);
}

import { requireHostUrl } from "../lib/optional-permissions.js";
import { idbSet, idbValuesWithPrefix } from "../lib/idb-kv.js";
import { identifyWorkflowPage } from "./workflow-context.js";
import { readAmazonProduct } from "./amazon/product-capture/page-state.js";
import { readTemuProduct } from "./temu/product-capture/page-state.js";
import { readZhFulfillProduct } from "./zhfulfill/product-capture/page-state.js";

const READERS = { amazon: readAmazonProduct, temu: readTemuProduct, zhfulfill: readZhFulfillProduct };
const LIBRARY_PREFIX = "captured-product:";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const text = value => typeof value === "number" && Number.isFinite(value) ? String(value)
  : typeof value === "string" ? value.trim() : "";

export function assetUrl(value, platform, base) {
  try {
    if (!text(value)) return "";
    const url = new URL(value, base);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return "";
    const host = url.hostname;
    const allowed = platform === "amazon" && (host === "m.media-amazon.com" ||
      host === "images.amazon.com" || /(?:^|\.)ssl-images-amazon\.com$|(?:^|\.)images-amazon\.com$/u.test(host)) ||
      platform === "temu" && /(?:^|\.)kwcdn\.com$/u.test(host) ||
      platform === "zhfulfill" && ["erp.zhfulfill.com", "cdn.zhfulfill.com", "zh-img-com.oss-accelerate.aliyuncs.com"].includes(host);
    if (!allowed) return "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function labels(value) {
  return Object.fromEntries(Object.entries(value || {}).flatMap(([key, v]) => {
    const label = text(key);
    const result = Array.isArray(v) ? v.map(text).filter(Boolean).join("、") : text(v);
    return label && result ? [[label, result]] : [];
  }));
}

function priceOf(value, currency, display) {
  const amount = text(value?.amount ?? value);
  const unit = text(value?.currency ?? currency);
  const shown = text(value?.display ?? display);
  if (!amount && !shown) return undefined;
  return { ...(amount && { amount }), ...(/^[A-Z]{3}$/u.test(unit) && { currency: unit }), ...(shown && { display: shown }) };
}

export function normalizeCapturedProduct(page, raw, now = new Date()) {
  if (!raw?.title || !text(raw.title)) throw new Error("商品详情还没加载，或网页要求登录或验证。打开可见的商品详情后重试。");
  const image = value => assetUrl(value, page.platform, page.sourceUrl);
  const urls = values => [...new Set((Array.isArray(values) ? values : []).map(image).filter(Boolean))];
  const variantGroups = Array.isArray(raw.variantGroups) ? raw.variantGroups.flatMap(group => {
    const name = text(group?.name);
    const options = Array.isArray(group?.options) ? group.options.flatMap(option => {
      const value = text(option?.value ?? option);
      const url = image(option?.image);
      return value ? [{ value, ...(url && { image: url }) }] : [];
    }) : [];
    return name && options.length ? [{ name, options }] : [];
  }) : [];
  const skus = Array.isArray(raw.skus) ? raw.skus.flatMap(sku => {
    const id = text(sku?.id);
    if (!id) return [];
    const url = image(sku.image);
    const price = priceOf(sku.price, sku.currency, sku.priceText);
    const inventory = Array.isArray(sku.inventory) ? sku.inventory.flatMap(row => {
      const shipFrom = text(row?.shipFrom);
      const quantity = text(row?.quantity);
      const inventoryId = text(row?.inventoryId);
      return shipFrom || quantity || inventoryId ? [{ shipFrom, quantity, inventoryId }] : [];
    }) : [];
    return [{ id, options: labels(sku.options), ...(url && { image: url }),
      ...(price && { sourcePrice: price }), ...(inventory.length && { inventory }) }];
  }) : [];
  const sizeChartImage = image(raw.sizeChartImage);
  const sourcePrice = priceOf(raw.price, raw.currency, raw.priceText);
  return {
    schemaVersion: 1,
    source: { platform: page.platform, productId: page.productId, url: page.sourceUrl, capturedAt: now.toISOString() },
    title: text(raw.title),
    description: text(raw.description),
    brand: text(raw.brand),
    sourceCategory: text(raw.category),
    countryOfOrigin: text(raw.countryOfOrigin),
    attributes: labels(raw.attributes),
    images: urls(raw.images),
    detailImages: urls(raw.detailImages),
    variantGroups,
    skus,
    ...(text(raw.descriptionSource) && { descriptionSource: text(raw.descriptionSource) }),
    ...(sourcePrice && { sourcePrice }),
    ...(sizeChartImage && { sizeChartImage }),
  };
}

export function sameProduct(a, b) {
  return Boolean(a?.productId && a.platform === b?.platform && a.surface === b.surface &&
    a.productId === b.productId && a.sourceUrl === b.sourceUrl);
}

export async function captureProduct(tab) {
  const page = identifyWorkflowPage(tab?.url);
  const reader = READERS[page?.platform];
  if (!page?.productId || !reader || !Number.isInteger(tab.id)) {
    throw new Error("请先打开 Amazon、Temu 或智猴云仓的商品详情。");
  }
  const verify = async () => {
    const current = await chrome.tabs.get(tab.id);
    if (!current.active || !sameProduct(page, identifyWorkflowPage(current.url))) {
      throw new Error("当前商品标签已变化，请回到要提取的商品页。");
    }
  };
  const read = async () => {
    await verify();
    const [entry] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] }, world: "MAIN", func: reader,
    });
    return entry?.result;
  };
  let result;
  try {
    result = await read();
  } catch (error) {
    if (!/cannot access contents of url|cannot access contents of the page|missing host permission/i.test(error?.message || "")) throw error;
    const denied = await requireHostUrl(tab.url, { tabId: tab.id, userGesture: true });
    if (denied) throw new Error(denied);
    result = await read();
  }
  await verify();
  if (result?.productId && String(result.productId) !== page.productId) {
    throw new Error("页面商品资料仍在切换，请重新提取。");
  }
  return normalizeCapturedProduct(page, result);
}

export async function saveCapturedProduct(product) {
  const { platform, productId } = product.source;
  if (!await idbSet(`${LIBRARY_PREFIX}${platform}:${productId}`, product)) {
    throw new Error("商品库写入失败，请下载 JSON 或保存到目录。");
  }
}

export async function listCapturedProducts() {
  const rows = await idbValuesWithPrefix(LIBRARY_PREFIX);
  return rows.sort((a, b) => b.source.capturedAt.localeCompare(a.source.capturedAt));
}

export function captureFolderName(product) {
  return `${product.source.platform}-${product.source.productId}`;
}

export function captureAssets(product) {
  const assets = new Map();
  function add(url, kind) {
    if (url && !assets.has(url)) assets.set(url, kind);
  }
  add(product.images[0] || product.detailImages[0], "main");
  add(product.sizeChartImage, "size-chart");
  product.images.forEach(url => add(url, "gallery"));
  product.detailImages.forEach(url => add(url, "detail"));
  product.variantGroups.forEach(group => group.options.forEach(option => add(option.image, "variant")));
  product.skus.forEach(sku => add(sku.image, "variant"));
  return [...assets];
}

async function imageFile(url) {
  const response = await fetch(url, {
    credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(12000),
  });
  if (!response.ok || !response.body) throw new Error("图片下载失败");
  if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) throw new Error("图片过大");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error("图片过大");
    }
    chunks.push(value);
  }
  const blob = new Blob(chunks);
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const mime = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff ? "jpg"
    : [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => header[i] === byte) ? "png"
    : String.fromCharCode(...header.slice(0, 4)) === "RIFF" && String.fromCharCode(...header.slice(8, 12)) === "WEBP" ? "webp"
    : "";
  if (!mime || header.length < 12) throw new Error("图片格式不受支持");
  return { blob, ext: mime };
}

async function writeFile(dir, filename, data) {
  const file = await dir.getFileHandle(filename, { create: true });
  const stream = await file.createWritable();
  try {
    await stream.write(data);
    await stream.close();
  } catch (err) {
    await stream.abort().catch(() => {});
    throw err;
  }
}

export async function exportCapturedProduct(root, product, { readImage = imageFile } = {}) {
  const folderName = `${captureFolderName(product)}-${Date.now()}`;
  const directory = await root.getDirectoryHandle(folderName, { create: true });
  const files = await directory.getDirectoryHandle("images", { create: true });
  const assets = captureAssets(product);
  const paths = new Map();
  const failed = [];
  let sizeChartForListing;
  let cursor = 0;
  async function download() {
    while (cursor < assets.length) {
      const index = cursor++;
      const [url, kind] = assets[index];
      try {
        if (!assetUrl(url, product.source.platform)) throw new Error("图片地址不受支持");
        const { blob, ext } = await readImage(url);
        const stem = kind === "main" || kind === "size-chart" ? kind : `${kind}-${index + 1}`;
        const filename = `${stem}.${ext}`;
        await writeFile(files, filename, blob);
        paths.set(url, `images/${filename}`);
        if (url === product.sizeChartImage && blob.size <= 4 * 1024 * 1024) sizeChartForListing = paths.get(url);
      } catch {
        failed.push(url);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, assets.length) }, download));
  const data = {
    ...product,
    imagePath: paths.get(product.images[0] || product.detailImages[0]),
    sizeChartImagePath: sizeChartForListing,
    imageFiles: assets.flatMap(([url, role]) => paths.has(url) ? [{ url, role, path: paths.get(url) }] : []),
    variantGroups: product.variantGroups.map(group => ({
      ...group, options: group.options.map(option => ({ ...option, imagePath: paths.get(option.image) })),
    })),
    skus: product.skus.map(sku => ({ ...sku, imagePath: paths.get(sku.image) })),
  };
  await writeFile(directory, "product.json", JSON.stringify(data, null, 2) + "\n");
  return { folderName, downloaded: paths.size, failed };
}

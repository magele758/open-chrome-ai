import fs from "node:fs";
import path from "node:path";

const MAX_PRODUCTS = 30;
const MAX_JSON = 512 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;
const MAX_SIZE_CHART_IMAGE = 4 * 1024 * 1024;
// A multiple of three keeps each non-final base64 segment unpadded.
const SIZE_CHART_CHUNK = 600 * 1024;
const IMAGE_MIME = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"],
]);

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function normalFile(root, relative, max) {
  if (typeof relative !== "string" || !relative.length || relative.includes("\\") ||
      relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("文件须使用商品目录内的相对路径。");
  }
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (!inside(root, current) || fs.lstatSync(current).isSymbolicLink()) throw new Error("商品文件路径超出目录。");
  }
  const stat = fs.statSync(current);
  if (!stat.isFile() || !stat.size || stat.size > max) throw new Error("文件类型或大小不符合要求：" + relative);
  return current;
}

function image(root, relative, max = MAX_IMAGE) {
  const target = normalFile(root, relative, max);
  const fd = fs.openSync(target, "r");
  const head = Buffer.alloc(12);
  try {
    if (fs.readSync(fd, head) < 12) throw new Error("图片无有效内容：" + relative);
  } finally {
    fs.closeSync(fd);
  }
  const ext = path.extname(target).toLowerCase();
  const valid = [".jpg", ".jpeg"].includes(ext) && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff ||
    ext === ".png" && head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    ext === ".webp" && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP";
  if (!valid) throw new Error("图片格式与文件内容不匹配：" + relative);
  return target;
}

function readManifest(dir) {
  const file = normalFile(dir, "product.json", MAX_JSON);
  const input = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.title !== "string" || !input.title.trim()) {
    throw new Error("product.json 缺少商品标题。");
  }
  return input;
}

function chartImage(dir, input) {
  if (input.sizeChart != null) return null;
  if (input.sizeChartImagePath != null) return image(dir, input.sizeChartImagePath, MAX_SIZE_CHART_IMAGE);
  const candidates = fs.readdirSync(dir).filter((name) => /^size\.(?:png|jpe?g|webp)$/iu.test(name));
  if (candidates.length > 1) throw new Error("找到多张尺码图，请在 product.json 指定 sizeChartImagePath。");
  return candidates.length ? image(dir, candidates[0], MAX_SIZE_CHART_IMAGE) : null;
}

function productReferenceImage(dir, input, expectedPath) {
  const array = value => Array.isArray(value) ? value : [];
  const roleImages = array(input.imageFiles).filter(file => ["main", "gallery", "detail", "variant"].includes(file?.role))
    .map(file => file.path);
  const variants = array(input.variantGroups).flatMap(group => array(group?.options)).map(option => option?.imagePath);
  const references = [input.imagePath, ...array(input.mainImages), ...array(input.detailImages), ...roleImages,
    ...variants, ...array(input.skus).map(sku => sku?.imagePath)];
  const file = references.find(relative => typeof relative === "string" && !/^https:\/\//u.test(relative) &&
    path.join(dir, relative) === expectedPath);
  return file && image(dir, file, MAX_SIZE_CHART_IMAGE);
}

function resolveAdditionalImages(dir, input) {
  const checked = new Map();
  const missing = [];
  function resolve(relative) {
    if (typeof relative !== "string" || !relative) return undefined;
    if (checked.has(relative)) return checked.get(relative);
    let result;
    try {
      result = image(dir, relative);
    } catch {
      missing.push(relative);
    }
    checked.set(relative, result);
    return result;
  }
  function replacePath(item, key) {
    if (!item || typeof item !== "object" || !Object.hasOwn(item, key)) return;
    const result = resolve(item[key]);
    if (result) item[key] = result;
    else delete item[key];
  }
  for (const file of Array.isArray(input.imageFiles) ? input.imageFiles : []) replacePath(file, "path");
  function resolveGallery(item, key) {
    if (Array.isArray(item?.[key])) item[key] = item[key].map(resolve).filter(Boolean);
  }
  for (const group of Array.isArray(input.variantGroups) ? input.variantGroups : []) {
    for (const option of Array.isArray(group?.options) ? group.options : []) {
      replacePath(option, "imagePath");
      resolveGallery(option, "galleryImages");
    }
  }
  resolveGallery(input, "sharedGalleryImages");
  resolveGallery(input, "galleryImages");
  resolveGallery(input.temu, "sharedGalleryImages");
  for (const sku of Array.isArray(input.skus) ? input.skus : []) replacePath(sku, "imagePath");
  for (const key of ["mainImages", "detailImages"]) {
    if (Array.isArray(input[key])) {
      // Product capture keeps the source URLs as provenance even if the local file is missing.
      input[key] = input[key].flatMap(value => {
        if (typeof value === "string" && /^https:\/\//u.test(value)) return [value];
        const result = resolve(value);
        return result ? [result] : [];
      });
    }
  }
  return missing;
}

export function loadProductDirectory(root) {
  const canonical = fs.realpathSync(root);
  if (canonical === path.parse(canonical).root || !fs.statSync(canonical).isDirectory()) throw new Error("请选择商品根目录。");
  const entries = fs.readdirSync(canonical, { withFileTypes: true });
  const single = entries.some((entry) => entry.name === "product.json");
  const selectedRoot = single ? path.dirname(canonical) : canonical;
  const folders = (single ? [{ name: path.basename(canonical) }] : entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN")));
  if (folders.length > MAX_PRODUCTS) throw new Error(`单批最多读取 ${MAX_PRODUCTS} 个商品子目录。`);
  const issues = [];
  const products = [];
  for (const { name: folder } of folders) {
    try {
      const dir = path.join(selectedRoot, folder);
      const input = readManifest(dir);
      const sizeChartImagePath = chartImage(dir, input);
      delete input.sizeChartImagePath;
      if (sizeChartImagePath) input.sizeChartImagePath = sizeChartImagePath;
      if (input.imagePath != null) input.imagePath = image(dir, input.imagePath);
      if (Array.isArray(input.variant?.options)) {
        for (const option of input.variant.options) {
          if (!option || typeof option !== "object" || Array.isArray(option)) throw new Error("规格选项格式错误。");
          if (option.imagePath != null) option.imagePath = image(dir, option.imagePath);
        }
      } else if (input.variant?.imagePath != null) {
        input.variant.imagePath = image(dir, input.variant.imagePath);
      }
      const missingImages = resolveAdditionalImages(dir, input);
      products.push({ folder, title: input.title, input, ...(missingImages.length && { missingImages }) });
    } catch (error) {
      const message = error?.code === "ENOENT" ? "缺少 product.json 或它引用的图片文件。" : error.message;
      issues.push({ folder, error: message });
    }
  }
  return { ok: true, root: selectedRoot, products, issues };
}

export function readProductSizeChartChunk({ root, folder, expectedPath, offset, revision, asset = "sizeChart" }) {
  const label = asset === "main" ? "商品主图" : "尺码图";
  if (typeof folder !== "string" || !folder || /^\.{1,2}$/u.test(folder) || /[/\\\0]/u.test(folder) ||
      !["main", "sizeChart"].includes(asset) ||
      !Number.isInteger(offset) || offset < 0 || offset >= MAX_SIZE_CHART_IMAGE || offset % SIZE_CHART_CHUNK !== 0) {
    throw new Error(`${label}读取参数无效。`);
  }
  const canonical = fs.realpathSync(root);
  if (canonical === path.parse(canonical).root) throw new Error("请选择商品目录。");
  const dir = path.join(canonical, folder);
  const dirStat = fs.lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || fs.realpathSync(dir) !== dir) throw new Error("商品目录已变化。");
  const input = readManifest(dir);
  const file = asset === "main" ? productReferenceImage(dir, input, expectedPath) : chartImage(dir, input);
  if (!file || file !== expectedPath) throw new Error(`${label}已变化，请重新读取商品目录。`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    const currentRevision = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
    if (!stat.isFile() || stat.size > MAX_SIZE_CHART_IMAGE || offset >= stat.size ||
        (offset > 0 && revision !== currentRevision)) throw new Error(`${label}已变化，请重新读取商品目录。`);
    const chunk = Buffer.alloc(Math.min(SIZE_CHART_CHUNK, stat.size - offset));
    const length = fs.readSync(fd, chunk, 0, chunk.length, offset);
    if (length !== chunk.length) throw new Error(`${label}未能完整读取。`);
    return {
      ok: true, mime: IMAGE_MIME.get(path.extname(file).toLowerCase()), size: stat.size,
      offset, length, revision: currentRevision, base64: chunk.toString("base64"),
    };
  } finally {
    fs.closeSync(fd);
  }
}

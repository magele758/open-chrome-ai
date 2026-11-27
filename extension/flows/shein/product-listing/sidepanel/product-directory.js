const MAX_PRODUCTS = 20;
const MAX_PRODUCT_SIZE = 512 * 1024;
const MAX_IMAGES = 100;
const IMAGE_ROLES = new Map([["main", "main"], ["gallery", "main"], ["detail", "detail"],
  ["variant", "variant"], ["variant-square", "variant-square"], ["variant-swatch", "variant-swatch"],
  ["shared-gallery", "shared-gallery"], ["square", "square"], ["swatch", "swatch"], ["size-chart", "size-chart"]]);
const localImagePath = value => typeof value === "string" && value.length <= 512 &&
  /\.(?:png|jpe?g|gif)$/iu.test(value) && !/[\0\\:]/u.test(value) &&
  value.split("/").every(segment => segment && segment !== "." && segment !== "..");
const array = value => Array.isArray(value) ? value : [];

async function productFile(directory) {
  try {
    return await directory.getFileHandle("product.json");
  } catch (error) {
    if (error.name === "NotFoundError") return null;
    throw error;
  }
}

function parseProductFile(value) {
  let data;
  try {
    data = JSON.parse(value);
  } catch {
    throw new Error("商品资料文件无法读取，请重新导出商品资料。");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("商品资料格式有误，请重新导出。");
  return data;
}

async function photoOnlyProduct(root, signal) {
  const paths = [];
  async function scan(directory, prefix) {
    for await (const entry of directory.values()) {
      signal?.throwIfAborted();
      if (paths.length === MAX_IMAGES) break;
      const path = prefix + entry.name;
      if (entry.kind === "file" && !entry.name.startsWith(".") && localImagePath(path)) paths.push(path);
    }
  }
  await scan(root, "");
  if (paths.length < MAX_IMAGES) {
    let images;
    try { images = await root.getDirectoryHandle("images"); }
    catch (error) { if (!["NotFoundError", "TypeMismatchError"].includes(error.name)) throw error; }
    if (images) await scan(images, "images/");
  }
  if (!paths.length) return null;
  paths.sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
  const imagePath = paths.find(path => /^(?:主图|main|hero|cover)(?=[\d_. -])/iu.test(path.split("/").at(-1))) || paths[0];
  return { directory: root, title: root.name, input: { title: root.name, imagePath, detailImages: paths.filter(path => path !== imagePath) } };
}

/** Read PageLens product exports, or images in the selected single-product folder. */
export async function readSheinProductDirectory(root, { signal } = {}) {
  signal?.throwIfAborted();
  const candidates = [];
  const issues = [];
  const single = await productFile(root);
  if (single) {
    candidates.push([root, single]);
  } else {
    for await (const child of root.values()) {
      signal?.throwIfAborted();
      if (child.kind !== "directory" || child.name.startsWith(".")) continue;
      const manifest = await productFile(child);
      if (!manifest) continue;
      if (candidates.length === MAX_PRODUCTS) {
        throw new Error(`一次最多读取 ${MAX_PRODUCTS} 个商品，请选择较小的目录。`);
      }
      candidates.push([child, manifest]);
    }
  }

  const products = [];
  candidates.sort(([left], [right]) => left.name.localeCompare(right.name, "zh-CN"));
  for (const [directory, handle] of candidates) {
    signal?.throwIfAborted();
    try {
      const file = await handle.getFile();
      if (!file.size || file.size > MAX_PRODUCT_SIZE) throw new Error("商品资料文件为空或超过 512 KB。");
      const input = parseProductFile(await file.text());
      if (typeof input.title !== "string" || !input.title.trim()) throw new Error("商品资料缺少标题。");
      products.push({ directory, input, title: input.title.trim() });
    } catch (error) {
      issues.push(`${directory.name} · ${error.message || "读取失败"}`);
    }
  }
  if (!candidates.length) {
    const photoProduct = await photoOnlyProduct(root, signal);
    if (photoProduct) products.push(photoProduct);
  }
  signal?.throwIfAborted();
  return { name: root.name, products, issues };
}

export function productImagePaths(input) {
  const variantImages = option => [
    ["variant", option?.imagePath], ["variant-square", option?.squareImagePath], ["variant-swatch", option?.swatchImagePath],
  ];
  const groups = [...array(input.shein?.variantGroups), ...array(input.variantGroups)];
  const pairs = [
    ["main", input.shein?.imagePath ?? input.imagePath],
    ...array(input.shein?.mainImages ?? input.mainImages).map(path => ["main", path]),
    ...array(input.shein?.detailImages ?? input.detailImages).map(path => ["detail", path]),
    ...array(input.shein?.sharedGalleryImages ?? input.sharedGalleryImages).map(path => ["shared-gallery", path]),
    ...groups.flatMap(group => array(group?.options).flatMap(variantImages)),
    ...array(input.variant?.options).flatMap(variantImages),
    ...variantImages(input.variant),
    ...array(input.skus).map(sku => ["variant", sku?.imagePath]),
    ...array(input.shein?.skus).map(sku => ["variant", sku?.imagePath]),
    ["square", input.shein?.squareImagePath ?? input.squareImagePath],
    ["swatch", input.shein?.swatchImagePath ?? input.swatchImagePath],
    ["size-chart", input.sizeChartImagePath],
    ...array(input.imageFiles).map(row => [IMAGE_ROLES.get(row?.role), row?.path]),
  ];
  return [...new Map(pairs.filter(([role, path]) => role && localImagePath(path))
    .map(([role, path]) => [`${role}:${path}`, { role, path }])).values()].slice(0, MAX_IMAGES);
}

/** Load only files listed by this product within the user-selected folder. */
export async function readSheinProductImages(product, { signal } = {}) {
  const images = [];
  const issues = [];
  const files = new Map();
  for (const { role, path } of productImagePaths(product.input)) {
    signal?.throwIfAborted();
    const parts = path.split("/");
    const name = parts.pop();
    if (!files.has(path)) {
      try {
        let directory = product.directory;
        for (const segment of parts) directory = await directory.getDirectoryHandle(segment);
        const entry = await directory.getFileHandle(name);
        const file = await entry.getFile();
        if (!file.size || !/^image\/(?:png|jpeg|gif)$/u.test(file.type)) throw new Error("图片格式无效。");
        files.set(path, file);
      } catch (error) {
        files.set(path, null);
        issues.push(`图片 ${path} · ${error.name === "NotFoundError" ? "目录中未找到" : error.message || "无法读取"}`);
      }
    }
    const file = files.get(path);
    if (file) images.push({ role, file, name, path });
  }
  signal?.throwIfAborted();
  return { images, issues };
}

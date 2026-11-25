const edge = 80;
const maximumSwatchBytes = 3 * 1024 * 1024;
const maximumSourceBytes = 8 * 1024 * 1024;
const signatures = {
  "image/jpeg": [255, 216, 255],
  "image/png": [137, 80, 78, 71, 13, 10, 26, 10],
};

async function checkSwatchFormat(file) {
  const suffix = file.type === "image/png" ? /\.png$/iu : /\.jpe?g$/iu;
  const signature = Object.hasOwn(signatures, file.type) ? signatures[file.type] : null;
  if (signature && suffix.test(file.name)) {
    const prefix = new Uint8Array(await file.slice(0, signature.length).arrayBuffer());
    if (signature.every((byte, index) => prefix[index] === byte)) return;
  }
  throw new Error("色块图须使用 JPG、JPEG 或 PNG 格式。");
}

/** Validate an explicit swatch or crop the selected color's own primary image. */
export async function prepareSheinSwatch(file, { derive = false } = {}) {
  if (!file?.size) throw new Error("色块图源文件为空或无法读取。");
  if (file.size > (derive ? maximumSourceBytes : maximumSwatchBytes)) {
    throw new Error(derive ? "生成色块图的主图不能超过 8 MB。" : "色块图不能超过 3 MB。");
  }
  if (!derive) await checkSwatchFormat(file);

  let image;
  try {
    image = await createImageBitmap(file);
  } catch {
    throw new Error(derive ? "无法解码该颜色的主图。" : "无法解码色块图。");
  }
  try {
    if (!derive) {
      if (image.width !== edge || image.height !== edge) throw new Error("色块图须为 80 × 80 像素。");
      return file;
    }

    const side = Math.max(1, Math.round(Math.min(image.width, image.height) * 0.16));
    const left = Math.floor((image.width - side) / 2);
    const top = Math.floor((image.height - side) / 2);
    try {
      const canvas = new OffscreenCanvas(edge, edge);
      canvas.getContext("2d").drawImage(image, left, top, side, side, 0, 0, edge, edge);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      const stem = file.name.replace(/\.[^.]*$/u, "").slice(0, 100);
      return new File([blob], `${stem || "main"}-swatch.png`, { type: "image/png" });
    } catch {
      throw new Error("无法从该颜色的主图生成色块图。");
    }
  } finally {
    image.close();
  }
}

/**
 * 系统剪贴板的富文本读写：text/plain + text/html + 图片。
 * 只能在有文档的扩展页（侧栏）里用；clipboardRead / clipboardWrite 权限已声明。
 */

const MAX_HTML = 20000;
const IMAGE_TYPE = /^image\//;

export function htmlToPlainText(html) {
  return String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

/** 返回 { text, html, htmlTruncated, image }；image 是 dataURL，没有则为 null。 */
export async function readClipboardRich({ clipboard = navigator.clipboard, toDataUrl = blobToDataUrl } = {}) {
  const out = { text: "", html: "", htmlTruncated: false, image: null };
  if (typeof clipboard?.read === "function") {
    try {
      const items = await clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          if (type === "text/plain" && !out.text) out.text = await (await item.getType(type)).text();
          else if (type === "text/html" && !out.html) out.html = await (await item.getType(type)).text();
          else if (IMAGE_TYPE.test(type) && !out.image) out.image = await toDataUrl(await item.getType(type));
        }
      }
    } catch (err) {
      if (typeof clipboard.readText !== "function") throw err;
    }
  }
  if (!out.text && !out.html && !out.image && typeof clipboard?.readText === "function") {
    out.text = await clipboard.readText();
  }
  if (out.html.length > MAX_HTML) {
    out.html = out.html.slice(0, MAX_HTML);
    out.htmlTruncated = true;
  }
  return out;
}

async function pngBlob(dataUrlOrBlob, { fetchImpl = fetch } = {}) {
  const blob =
    typeof dataUrlOrBlob === "string" ? await (await fetchImpl(dataUrlOrBlob)).blob() : dataUrlOrBlob;
  if (blob.type === "image/png") return blob;
  // 剪贴板只接受 PNG，其他格式转一次。
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

/** 至少给 text / html / image 之一。html 和 text 同时写入，粘贴端自己挑能吃的格式。 */
export async function writeClipboardRich(
  { text = "", html = "", image = "" } = {},
  { clipboard = navigator.clipboard, ClipboardItemCtor = globalThis.ClipboardItem, fetchImpl = fetch } = {},
) {
  if (!text && !html && !image) throw new Error("没有可复制的内容。");
  const plain = text || htmlToPlainText(html);
  if (!html && !image) {
    await clipboard.writeText(plain);
    return { text: plain.length, html: 0, image: false };
  }
  if (typeof ClipboardItemCtor !== "function" || typeof clipboard?.write !== "function") {
    if (!plain) throw new Error("当前环境不支持写入富文本或图片。");
    await clipboard.writeText(plain);
    return { text: plain.length, html: 0, image: false, downgraded: true };
  }
  const data = {};
  if (plain) data["text/plain"] = new Blob([plain], { type: "text/plain" });
  if (html) data["text/html"] = new Blob([html], { type: "text/html" });
  if (image) data["image/png"] = await pngBlob(image, { fetchImpl });
  await clipboard.write([new ClipboardItemCtor(data)]);
  return { text: plain.length, html: html.length, image: Boolean(image) };
}

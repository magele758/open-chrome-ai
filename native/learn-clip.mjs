// The extension sends only a clipping. The write-only credential and fixed destination stay on this Mac.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const learningConfigPath = () => path.join(os.homedir(), ".pagelens", "learn-agent-clip.json");

function publicSource(raw) {
  let source;
  try { source = new URL(raw); } catch { throw Error("请填写剪藏的原文网址。"); }
  if (!["http:", "https:"].includes(source.protocol) || source.username || source.password) {
    throw Error("请选择没有登录凭据的 HTTP 或 HTTPS 网页。");
  }
  // Keep conventional document section IDs, avoiding arbitrary fragment payloads or routed URLs.
  if (!/^#(?:ch|sec|section|chapter)[-_.:][a-z\d][a-z\d_.-]{0,64}$/i.test(source.hash)) source.hash = "";
  for (const key of [...source.searchParams.keys()]) {
    if (/^(?:utm_|x-amz-|x-goog-)|(?:access.?token|api.?key|password|passwd|oauth|secret|signature|credential|authorization|session.?id)|^(?:token|key|sig|session|auth|code|ticket|fbclid|gclid|state)$/i.test(key)) {
      source.searchParams.delete(key);
    }
  }
  return source.href;
}

function bounded(value, limit, message) {
  const s = typeof value === "string" ? value.trim() : "";
  if (Buffer.byteLength(s) > limit) throw new Error(message);
  return s;
}

function learningPage(value, endpoint) {
  if (typeof value !== "string" || !value) return null;
  const url = URL.parse(value, endpoint);
  return url && url.origin === endpoint.origin && url.pathname === "/learn" && !url.username && !url.password ? url : null;
}

export async function writeLearningClip(raw, { configPath = learningConfigPath(), request = fetch } = {}) {
  try {
    const clip = {
      url: publicSource(raw?.url),
      title: bounded(raw?.title, 2048, "标题太长，请缩短后重试。"),
      quote: bounded(raw?.quote, 16 * 1024, "选区超过 16 KiB，请选取较短的段落。"),
      note: bounded(raw?.note, 16 * 1024, "备注超过 16 KiB，请缩短后重试。"),
      content: bounded(raw?.content, 256 * 1024, "内容超过 256 KiB，请截取想学的部分。"),
    };
    if (!clip.quote && !clip.content) throw Error("请先选中要学的文字，或从有正文的页面打开剪藏。");
    let file;
    try { file = await open(configPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); }
    catch { throw Error("此 Mac 尚未连接学习资料库，请设置 PageLens 的剪藏连接文件。"); }
    let config;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 8192 || (process.platform !== "win32" && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) {
        throw Error("剪藏连接文件必须仅当前用户可读写。");
      }
      try { config = JSON.parse(await file.readFile("utf8")); } catch { throw Error("剪藏连接文件格式无效。"); }
    } finally { await file.close(); }
    const endpoint = URL.parse(config?.endpoint);
    const privateHost = /^(?:localhost|127\.0\.0\.1|\[::1\]|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})$/i;
    if (!endpoint || !(endpoint.protocol === "https:" || endpoint.protocol === "http:" && privateHost.test(endpoint.hostname)) ||
      endpoint.pathname !== "/api/learn/clips" || endpoint.username || endpoint.password || endpoint.hash || endpoint.search ||
      typeof config?.token !== "string" || !/^[\x21-\x7e]{32,256}$/.test(config.token)) {
      throw Error("学习资料库的连接地址或剪藏密钥无效。");
    }
    let response;
    try {
      response = await request(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.token },
        redirect: "error", signal: AbortSignal.timeout(25000), body: JSON.stringify(clip) });
    } catch { throw Error("连不上学习资料库，请检查网络后重试。"); }
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw Error("学习资料库没有接受本机连接，请检查剪藏密钥和设备授权。");
      throw Error("学习资料库未保存剪藏（HTTP " + response.status + "），可以重试。");
    }
    const result = await response.json().catch(() => null);
    const next = learningPage(result?.readerUrl, endpoint);
    if (!next) throw Error("学习资料库未返回有效的阅读地址，可以重试。");
    const receipt = { ok: true, readerUrl: next.href, duplicate: result.duplicate === true };
    const review = learningPage(result.reviewUrl, endpoint);
    if (review?.searchParams.get("tab") === "knowledge" && next.searchParams.has("clip") &&
        review.searchParams.get("clip") === next.searchParams.get("clip")) {
      receipt.reviewUrl = review.href;
      if (["ready", "queued"].includes(result.matchingStatus)) receipt.matchingStatus = result.matchingStatus;
      if (Number.isSafeInteger(result.pendingCount) && result.pendingCount >= 0) receipt.pendingCount = result.pendingCount;
    }
    return receipt;
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

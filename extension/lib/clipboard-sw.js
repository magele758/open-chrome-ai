/**
 * 在 Service Worker 里写系统剪贴板（SW 没有 DOM）：
 *   1. offscreen 文档里 execCommand("copy") + copy 事件塞 text/html、text/plain（不需要文档焦点）
 *   2. offscreen 文档里 navigator.clipboard.write（需要文档焦点，常失败）
 *   3. Native Host（macOS NSPasteboard）
 * 只有一个 offscreen 文档额度：已有非剪贴板的 offscreen（例如配音播放）时不会去关它，直接走 native。
 */

import { nativeSend } from "./native-host.js";

const CLIPBOARD_PAGE = "offscreen/clipboard.html";
export const CLIPBOARD_STRATEGIES = ["offscreen-copy", "offscreen-api", "native"];

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createSwClipboard({
  chromeApi = globalThis.chrome,
  native = nativeSend,
  sleep = defaultSleep,
} = {}) {
  async function offscreenState() {
    const url = chromeApi.runtime.getURL(CLIPBOARD_PAGE);
    const contexts = (await chromeApi.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"] })) || [];
    if (!contexts.length) return "none";
    return contexts.some((c) => c.documentUrl === url) ? "clipboard" : "other";
  }

  async function withOffscreen(fn) {
    if (!chromeApi.offscreen?.createDocument) throw new Error("当前环境没有 offscreen API");
    const state = await offscreenState();
    if (state === "other") throw new Error("offscreen 文档被其他功能占用（配音/录音），不抢占");
    let created = false;
    if (state === "none") {
      await chromeApi.offscreen.createDocument({
        url: CLIPBOARD_PAGE,
        reasons: ["CLIPBOARD"],
        justification: "外部 Agent 桥接：写入富文本剪贴板以便可信粘贴",
      });
      created = true;
    }
    try {
      let lastErr = null;
      for (let i = 0; i < 6; i += 1) {
        await sleep(40 * (i + 1));
        try {
          const res = await fn();
          if (res?.ok) return res;
          lastErr = new Error(res?.error || "offscreen 写剪贴板失败");
          if (res && res.retry === false) break;
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr || new Error("offscreen 写剪贴板失败");
    } finally {
      if (created) await chromeApi.offscreen.closeDocument().catch(() => {});
    }
  }

  const strategies = {
    "offscreen-copy": (payload) =>
      withOffscreen(() => chromeApi.runtime.sendMessage({ type: "pl.clipboard.copyEvent", payload })),
    "offscreen-api": (payload) =>
      withOffscreen(() => chromeApi.runtime.sendMessage({ type: "pl.clipboard.write", payload })),
    native: async (payload) => {
      if (payload.image) throw new Error("native 不支持图片");
      const res = await native({ op: "clipboard_write", text: payload.text, html: payload.html });
      if (!res?.ok) throw new Error(res?.error || "native 写剪贴板失败");
      return res;
    },
  };

  /** 返回 { via, attempts }；全部失败则抛出带 attempts 的错误。 */
  async function write({ text = "", html = "", image = "" } = {}, { order = CLIPBOARD_STRATEGIES } = {}) {
    const payload = { text: String(text || ""), html: String(html || ""), image: String(image || "") };
    if (!payload.text && !payload.html && !payload.image) throw new Error("clipboard_write: 内容为空");
    const attempts = [];
    for (const name of order) {
      const run = strategies[name];
      if (!run) continue;
      try {
        await run(payload);
        attempts.push({ via: name, ok: true });
        return { via: name, attempts, text: payload.text.length, html: payload.html.length };
      } catch (err) {
        attempts.push({ via: name, ok: false, error: err?.message || String(err) });
      }
    }
    const error = new Error(`所有剪贴板写入方式都失败：${attempts.map((a) => `${a.via}: ${a.error}`).join("；")}`);
    error.attempts = attempts;
    throw error;
  }

  return { write };
}

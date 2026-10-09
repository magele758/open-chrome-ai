/**
 * Service-worker side lifecycle of the shared offscreen audio document, which
 * hosts both tab recording (`offscreen/audio.js`) and video interpretation
 * (`interpret-host.js`). Chrome allows one offscreen document per extension, so
 * neither feature may close it while the other is still using it.
 */
import { INTERPRET_HOST } from "./interpret-messages.js";

export const AUDIO_PAGE = "offscreen/audio.html";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createOffscreenDoc({ chromeApi, sleep = wait } = {}) {
  const api = () => chromeApi || globalThis.chrome;
  let lifecycle = Promise.resolve();
  /** Serializes create/close so a start cannot be forwarded into a closing document. */
  const exclusive = fn => {
    const run = lifecycle.then(fn, fn);
    lifecycle = run.catch(() => {});
    return run;
  };

  async function state() {
    let contexts;
    try {
      contexts = await api().runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    } catch {
      return (await api().offscreen?.hasDocument?.().catch(() => false)) ? "audio" : "none";
    }
    if (!contexts?.length) return "none";
    const url = api().runtime.getURL(AUDIO_PAGE);
    return contexts.some(c => c.documentUrl === url) ? "audio" : "other";
  }

  async function send(payload) {
    let last = null;
    for (let i = 0; i < 8; i += 1) {
      try {
        const res = await api().runtime.sendMessage(payload);
        if (res) return res;
      } catch (err) {
        last = err;
      }
      await sleep(60);
    }
    throw last || new Error("offscreen 未响应");
  }

  async function ensure() {
    for (let i = 0; i < 30; i += 1) {
      const current = await state();
      if (current === "audio") return;
      if (current === "none") {
        try {
          await api().offscreen.createDocument({
            url: AUDIO_PAGE,
            reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
            justification: "录制标签声音用于转写；在后台调度同声传译并播放配音",
          });
          return;
        } catch (err) {
          if (/already|exists|single/i.test(err?.message || "")) continue;
          throw err;
        }
      }
      // A short-lived clipboard document; it closes itself after one write.
      await sleep(100);
    }
    throw new Error("offscreen 文档被其他功能占用，请稍后重试");
  }

  async function busy() {
    const res = await api().runtime.sendMessage({ type: INTERPRET_HOST, op: "busy" }).catch(() => null);
    // No answer means the host is not listening; keeping the page is the safe side.
    return res?.ok ? Boolean(res.busy) : true;
  }

  /** Closes the audio document only when neither recording nor interpretation is using it. */
  function release({ force = false } = {}) {
    return exclusive(async () => {
      if ((await state()) !== "audio") return false;
      if (!force && await busy()) return false;
      await api().offscreen.closeDocument().catch(() => {});
      return true;
    });
  }

  return {
    state,
    exists: async () => (await state()) === "audio",
    ensure: () => exclusive(ensure),
    withDocument: fn => exclusive(async () => { await ensure(); return fn(); }),
    send,
    release,
  };
}

export const offscreenDoc = createOffscreenDoc();

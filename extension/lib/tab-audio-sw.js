import { sleep } from "./chrome.js";

let offscreenBusy = false;

async function sendToOffscreen(payload) {
  let last = null;
  for (let i = 0; i < 8; i += 1) {
    try {
      const res = await chrome.runtime.sendMessage(payload);
      if (res) return res;
    } catch (err) {
      last = err;
      await sleep(60);
    }
  }
  throw last || new Error("offscreen 未响应");
}

async function ensureOffscreen() {
  try {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (ctxs?.length) return;
  } catch {
    /* getContexts 不可用时直接创建 */
  }
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen/audio.html",
      reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
      justification: "录制当前标签声音并转写成字幕",
    });
  } catch (err) {
    if (!/already|exists/i.test(err?.message || "")) throw err;
  }
}

export async function handleAudioMessage(msg) {
  if (msg?.type === "pl.audio.start") {
    if (offscreenBusy) return { ok: false, error: "已经在录音" };
    if (!msg.tabId) return { ok: false, error: "缺少 tabId" };
    await ensureOffscreen();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: Number(msg.tabId) });
    const res = await sendToOffscreen({ type: "pl.offscreen.start", streamId });
    if (!res?.ok) return { ok: false, error: res?.error || "offscreen 未能开始录音" };
    offscreenBusy = true;
    return { ok: true };
  }
  if (msg?.type === "pl.audio.stop") {
    try {
      if (!offscreenBusy) return { ok: false, error: "没有在录音" };
      return await sendToOffscreen({ type: "pl.offscreen.stop" });
    } finally {
      offscreenBusy = false;
      try {
        await chrome.offscreen.closeDocument();
      } catch {
        /* ignore */
      }
    }
  }
  if (msg?.type === "pl.audio.status") {
    return { ok: true, recording: offscreenBusy };
  }
  return { ok: false, error: `未知消息 ${msg?.type || ""}` };
}

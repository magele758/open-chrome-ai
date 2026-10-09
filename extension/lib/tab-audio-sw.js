import { offscreenDoc } from "./offscreen-doc.js";

let offscreenBusy = false;

export async function handleAudioMessage(msg) {
  if (msg?.type === "pl.audio.start") {
    if (offscreenBusy) return { ok: false, error: "已经在录音" };
    if (!msg.tabId) return { ok: false, error: "缺少 tabId" };
    await offscreenDoc.ensure();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: Number(msg.tabId) });
    const res = await offscreenDoc.send({ type: "pl.offscreen.start", streamId });
    if (!res?.ok) return { ok: false, error: res?.error || "offscreen 未能开始录音" };
    offscreenBusy = true;
    return { ok: true };
  }
  if (msg?.type === "pl.audio.stop") {
    try {
      if (!offscreenBusy) return { ok: false, error: "没有在录音" };
      return await offscreenDoc.send({ type: "pl.offscreen.stop" });
    } finally {
      offscreenBusy = false;
      await offscreenDoc.release().catch(() => {});
    }
  }
  if (msg?.type === "pl.audio.status") {
    return { ok: true, recording: offscreenBusy };
  }
  return { ok: false, error: `未知消息 ${msg?.type || ""}` };
}

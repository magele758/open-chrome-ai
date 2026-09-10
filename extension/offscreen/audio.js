import { captureWithRecorder, getTabStream, playThrough } from "../lib/tab-audio-record.js";

let session = null;

async function start(streamId) {
  if (session) throw new Error("已在录音");
  if (!streamId) throw new Error("缺少 streamId");
  const stream = await getTabStream(streamId);
  const playback = playThrough(stream);
  const rec = captureWithRecorder(stream);
  session = { stream, playback, rec };
}

async function stop() {
  if (!session) throw new Error("没有在录音");
  const { stream, playback, rec } = session;
  session = null;
  try {
    const result = await rec.stop();
    const buffer = await result.blob.arrayBuffer();
    return { ok: true, mime: result.mime, buffer, seconds: result.seconds };
  } finally {
    playback.dispose();
    stream.getTracks().forEach((t) => t.stop());
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "pl.offscreen.start") {
    start(msg.streamId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (msg?.type === "pl.offscreen.stop") {
    stop()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  return false;
});

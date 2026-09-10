import { inject, restrictedUrl, sleep } from "./chrome.js";
import { controlVideo, readVideoState } from "./agent/page-fns.js";
import { captureWithRecorder, getTabStream, playThrough } from "./tab-audio-record.js";

export const MAX_RECORD_SECONDS = 1800;

let localActive = null;

function clampMax(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return MAX_RECORD_SECONDS;
  return Math.min(Math.max(Math.floor(n), 15), MAX_RECORD_SECONDS);
}

function captureHint(err) {
  const msg = err?.message || String(err || "");
  if (/user gesture|not (been )?invoked|activeTab|permission|gesture/i.test(msg)) {
    return "请在侧栏点「转写此视频」以允许录制标签声音。";
  }
  return msg || "无法录制标签声音。";
}

async function playMedia(tabId, fromStart) {
  try {
    return await inject(tabId, controlVideo, [{ action: "play", fromStart: fromStart !== false }]);
  } catch {
    return { ok: false };
  }
}

async function waitAndStop(rec, { tabId, maxSeconds, onProgress, signal }) {
  const capMs = clampMax(maxSeconds) * 1000;
  const t0 = Date.now();
  let pausedSince = null;
  let limitMs = Math.min(capMs, 10 * 60 * 1000);
  while (!signal?.aborted) {
    const elapsed = Date.now() - t0;
    if (elapsed >= limitMs) break;
    let st = null;
    try {
      st = await inject(tabId, readVideoState);
    } catch {
      st = null;
    }
    if (st?.ok) {
      if (st.duration > 1) {
        const remain = Math.max(5, (st.duration - (st.currentTime || 0) + 2) * 1000);
        limitMs = Math.min(capMs, elapsed + remain);
      }
      const hint = st.paused && elapsed > 4000 ? "请在页面上点播放" : "";
      onProgress?.({
        status: "recording",
        currentTime: st.currentTime,
        duration: st.duration,
        paused: st.paused,
        ended: st.ended,
        hint,
      });
      if (st.ended) break;
      if (st.paused) {
        if (pausedSince == null) pausedSince = Date.now();
        if (elapsed > 12000 && Date.now() - pausedSince > 90000) break;
      } else {
        pausedSince = null;
      }
    } else {
      onProgress?.({ status: "recording", currentTime: elapsed / 1000, duration: capMs / 1000 });
    }
    await sleep(1000);
  }
  return rec.stop();
}

function tooQuiet(blob) {
  return !blob || blob.size < 1500;
}

async function recordLocal({ tabId, maxSeconds, fromStart, onProgress, signal }) {
  if (!chrome.tabCapture?.getMediaStreamId) throw new Error("当前 Chrome 不支持 tabCapture。");
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const stream = await getTabStream(streamId);
  const playback = playThrough(stream);
  const rec = captureWithRecorder(stream);
  try {
    await playMedia(tabId, fromStart);
    const result = await waitAndStop(rec, { tabId, maxSeconds, onProgress, signal });
    if (tooQuiet(result.blob)) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      throw new Error("没有录到声音。请确认视频已播放、不是静音，且站点没有 DRM（如 Netflix）。");
    }
    return result;
  } finally {
    playback.dispose();
    stream.getTracks().forEach((t) => t.stop());
  }
}

async function recordOffscreen({ tabId, maxSeconds, fromStart, onProgress, signal }) {
  const start = await chrome.runtime.sendMessage({ type: "pl.audio.start", tabId });
  if (!start?.ok) throw new Error(start?.error || "无法开始后台录音");
  try {
    await playMedia(tabId, fromStart);
    const dummy = {
      stop: async () => {
        const stopped = await chrome.runtime.sendMessage({ type: "pl.audio.stop" });
        if (!stopped?.ok) throw new Error(stopped?.error || "停止录音失败");
        if (!stopped.buffer) throw new Error("录音数据没传回来。");
        const mime = stopped.mime || "audio/webm";
        return {
          blob: new Blob([stopped.buffer], { type: mime }),
          mime,
          seconds: stopped.seconds,
        };
      },
    };
    const result = await waitAndStop(dummy, { tabId, maxSeconds, onProgress, signal });
    if (tooQuiet(result.blob)) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      throw new Error("没有录到声音。请确认视频已播放、不是静音，且站点没有 DRM（如 Netflix）。");
    }
    return result;
  } catch (err) {
    chrome.runtime.sendMessage({ type: "pl.audio.stop" }).catch(() => {});
    throw err;
  }
}

export async function recordTabAudio({ tabId, maxSeconds, fromStart = true, onProgress, signal } = {}) {
  if (!tabId) throw new Error("没有可录音的标签。");
  const tab = await chrome.tabs.get(tabId);
  if (restrictedUrl(tab?.url)) throw new Error(`受限页无法录音：${tab?.url || ""}`);
  if (localActive) throw new Error("已经在录音。");
  const localAbort = new AbortController();
  const onAbort = () => localAbort.abort();
  signal?.addEventListener("abort", onAbort);
  localActive = { abort: localAbort };
  try {
    try {
      return await recordLocal({
        tabId,
        maxSeconds,
        fromStart,
        onProgress,
        signal: localAbort.signal,
      });
    } catch (err) {
      if (signal?.aborted || localAbort.signal.aborted) throw err;
      const msg = err?.message || String(err);
      if (/没有录到声音|DRM|已经在录音|受限页/.test(msg)) throw err;
      try {
        return await recordOffscreen({
          tabId,
          maxSeconds,
          fromStart,
          onProgress,
          signal: localAbort.signal,
        });
      } catch (err2) {
        throw new Error(captureHint(err2) || captureHint(err));
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    localActive = null;
  }
}

export function abortRecording() {
  localActive?.abort.abort();
}

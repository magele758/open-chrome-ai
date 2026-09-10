import { injectPageAudio, injectVideo, sleep } from "./chrome.js";
import { captureWithRecorder, getTabStream, isQuietBlob, playThrough } from "./tab-audio-record.js";

export const MAX_RECORD_SECONDS = 1800;

let localActive = null;

function clampSeconds(seconds, minSeconds = 15) {
  const min = Math.max(1, Number(minSeconds) || 15);
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return Math.min(MAX_RECORD_SECONDS, Math.max(min, 15));
  return Math.min(Math.max(Math.floor(n), min), MAX_RECORD_SECONDS);
}

export function captureHint(err) {
  const msg = err?.message || String(err || "");
  if (/user gesture|not (been )?invoked|activeTab|permission|gesture|current page/i.test(msg)) {
    return `无法取到当前标签的声音（${msg}）。请再点一次「一键总结」或「同声传译」。若刚更新过扩展，先到 chrome://extensions 重新加载 PageLens。`;
  }
  return msg || "无法取到当前标签的声音。";
}

async function playMedia(tabId, fromStart) {
  try {
    return await injectVideo(tabId, "control", { action: "play", fromStart: fromStart !== false });
  } catch {
    return { ok: false };
  }
}

async function waitAndStop(rec, { tabId, maxSeconds, minSeconds, onProgress, signal }) {
  const capMs = clampSeconds(maxSeconds, minSeconds) * 1000;
  const t0 = Date.now();
  let pausedSince = null;
  let limitMs = Math.min(capMs, 10 * 60 * 1000);
  while (!signal?.aborted) {
    const elapsed = Date.now() - t0;
    if (elapsed >= limitMs) break;
    let st = null;
    try {
      st = await injectVideo(tabId, "state");
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
  return isQuietBlob(blob);
}

export function getActiveCapture() {
  return localActive?.session || null;
}

export function isCapturing() {
  return Boolean(localActive?.session && !localActive.session.done);
}

async function recordOffscreen({ tabId, maxSeconds, minSeconds, fromStart, onProgress, signal }) {
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
    const result = await waitAndStop(dummy, { tabId, maxSeconds, minSeconds, onProgress, signal });
    if (tooQuiet(result.blob)) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      throw new Error("没有取到声音。请确认视频已播放、不是静音，且站点没有 DRM（如 Netflix）。");
    }
    return result;
  } catch (err) {
    chrome.runtime.sendMessage({ type: "pl.audio.stop" }).catch(() => {});
    throw err;
  }
}

/**
 * Must run in the same turn as a user click. Stream IDs expire in a few seconds
 * and Chrome drops the gesture after other awaits (captions fetch, etc.).
 */
export async function beginTabCapture(tabId) {
  if (!tabId) throw new Error("没有可取声音的标签。");
  if (!chrome.tabCapture?.getMediaStreamId) {
    throw new Error("当前 Chrome 不支持 tabCapture。请到 chrome://extensions 重新加载 PageLens。");
  }
  if (localActive) throw new Error("已经在处理当前标签声音。");
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    throw new Error(captureHint(err));
  }
  if (!streamId) throw new Error("没有拿到标签声音许可。请再点一次「一键总结」或「同声传译」。");
  let stream;
  try {
    stream = await getTabStream(streamId);
  } catch (err) {
    throw new Error(`拿到许可后无法打开音轨：${err?.message || err}`);
  }
  const playback = playThrough(stream);
  const abort = new AbortController();
  const session = { tabId, stream, playback, rec: null, abort, done: false };
  localActive = { abort, session };
  return session;
}

export async function discardCapture(session) {
  if (!session || session.done) return;
  session.done = true;
  if (localActive?.session === session) localActive = null;
  if (session.pageAudio && session.tabId) {
    try {
      await injectPageAudio(session.tabId, "stop");
    } catch {
      /* ignore */
    }
    try {
      await injectVideo(session.tabId, "restore");
    } catch {
      /* ignore */
    }
  }
  try {
    session.stream?.getTracks?.().forEach((t) => t.stop());
  } catch {
    /* ignore */
  }
  try {
    session.playback?.dispose();
  } catch {
    /* ignore */
  }
  try {
    await session.rec?.stop();
  } catch {
    /* ignore */
  }
}

async function recordFromPageCapture(session, { maxSeconds, fromStart = true, onProgress, signal } = {}) {
  const localAbort = session.abort || new AbortController();
  const onAbort = () => localAbort.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    await injectVideo(session.tabId, "control", { action: "play", fromStart: fromStart !== false });
    const capMs = (Number(maxSeconds) > 0 ? Math.min(maxSeconds, MAX_RECORD_SECONDS) : MAX_RECORD_SECONDS) * 1000;
    const t0 = Date.now();
    while (!localAbort.signal.aborted) {
      const elapsed = Date.now() - t0;
      if (elapsed >= capMs) break;
      let st = { ok: false };
      try {
        st = await injectVideo(session.tabId, "state");
      } catch {
        st = { ok: false };
      }
      onProgress?.({
        status: "recording",
        currentTime: st.currentTime,
        duration: st.duration,
        paused: st.paused,
        ended: st.ended,
        hint: st.paused ? "请在页面上点播放" : "",
      });
      if (st.ended) break;
      await sleep(1000);
    }
    const taken = await injectPageAudio(session.tabId, "take");
    if (!taken?.ok) throw new Error(taken?.error || "取声失败。");
    const blob = b64ToBlob(taken.b64, taken.mime);
    if (tooQuiet(blob)) throw new Error("没有取到声音。请确认视频已播放、不是静音。");
    return { blob, mime: taken.mime || "audio/webm", seconds: taken.seconds };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await discardCapture(session);
  }
}

export async function recordFromCapture(session, { maxSeconds, minSeconds, fromStart = true, onProgress, signal } = {}) {
  if (session?.pageAudio) return recordFromPageCapture(session, { maxSeconds, fromStart, onProgress, signal });
  if (!session?.stream) throw new Error("没有进行中的标签声音。");
  if (!session.rec) session.rec = captureWithRecorder(session.stream);
  const localAbort = localActive?.session === session ? localActive.abort : new AbortController();
  const onAbort = () => localAbort.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    await playMedia(session.tabId, fromStart);
    const result = await waitAndStop(session.rec, {
      tabId: session.tabId,
      maxSeconds,
      minSeconds,
      onProgress,
      signal: localAbort.signal,
    });
    if (tooQuiet(result.blob)) {
      if (signal?.aborted || localAbort.signal.aborted) throw new DOMException("Aborted", "AbortError");
      throw new Error("没有取到声音。请确认视频已播放、不是静音，且站点没有 DRM（如 Netflix）。");
    }
    return result;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await discardCapture(session);
  }
}

export async function recordTabAudio({ tabId, maxSeconds, minSeconds = 15, fromStart = true, onProgress, signal } = {}) {
  if (!tabId) throw new Error("没有可取声音的标签。");
  try {
    const session = await beginTabCapture(tabId);
    return await recordFromCapture(session, { maxSeconds, minSeconds, fromStart, onProgress, signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    const msg = err?.message || String(err);
    if (/没有取到声音|没有录到声音|DRM|已经在处理|受限页|无法开始|无法打开音轨|无法取到/.test(msg)) throw err;
    try {
      return await recordOffscreen({
        tabId,
        maxSeconds,
        minSeconds,
        fromStart,
        onProgress,
        signal,
      });
    } catch (err2) {
      throw new Error(captureHint(err2) || captureHint(err));
    }
  }
}

export function abortRecording() {
  localActive?.abort.abort();
}

function tabCaptureBlocked(err) {
  return /invoked|activeTab|Chrome pages cannot be captured|gesture/i.test(err?.message || String(err || ""));
}

function b64ToBlob(b64, mime) {
  const bin = atob(String(b64 || ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || "audio/webm" });
}

export async function beginPageCapture(tabId, { fromStart = false } = {}) {
  if (!tabId) throw new Error("没有可取声音的标签。");
  await injectVideo(tabId, "pick");
  await injectVideo(tabId, "silence");
  const started = await injectPageAudio(tabId, "start", { fromStart });
  if (!started?.ok) throw new Error(started?.error || "无法从播放器取声。");
  const abort = new AbortController();
  const session = {
    tabId,
    pageAudio: true,
    stream: { id: "page-audio" },
    playback: { setGain() {}, dispose() {} },
    rec: null,
    abort,
    done: false,
  };
  localActive = { abort, session };
  return session;
}

export async function recordPageSlice(tabId, seconds, signal) {
  const ms = Math.max(800, (Number(seconds) || 5) * 1000);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await sleep(200);
  }
  const taken = await injectPageAudio(tabId, "take");
  if (!taken?.ok) throw new Error(taken?.error || "取声失败。");
  return {
    blob: b64ToBlob(taken.b64, taken.mime),
    mime: taken.mime || "audio/webm",
    seconds: taken.seconds || seconds,
  };
}

export async function beginCapture(tabId, { fromStart = false } = {}) {
  try {
    return await beginTabCapture(tabId);
  } catch (err) {
    if (!tabCaptureBlocked(err)) throw err;
    return beginPageCapture(tabId, { fromStart });
  }
}

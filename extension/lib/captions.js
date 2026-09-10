import { inject, restrictedUrl } from "./chrome.js";
import { readTextTracks } from "./agent/page-fns.js";
import { loadYoutubeCaptions } from "./youtube.js";
import { filenameForMime, formatTranscript, transcribeAudio } from "./asr.js";
import { isAsrReady, loadSettings } from "./storage.js";
import { recordTabAudio } from "./tab-audio.js";
import { readVideoDocFromLibrary, syncPackToLibrary, videoIdentity } from "./library.js";

export { videoIdentity };

const INDEX_KEY = "pl.asr.index";
const ITEM_PREFIX = "pl.asr.item.";
const MAX_CACHE = 24;

async function cacheId(url) {
  const id = videoIdentity(url);
  if (globalThis.crypto?.subtle) {
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(id));
    return [...new Uint8Array(buf)]
      .slice(0, 10)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  return encodeURIComponent(id).slice(0, 80);
}

export async function getCachedTranscript(url) {
  if (!url || !chrome.storage?.local) return null;
  const id = await cacheId(url);
  const key = ITEM_PREFIX + id;
  const data = await chrome.storage.local.get(key);
  const hit = data?.[key];
  if (!hit?.text) return null;
  return {
    status: "ready",
    text: String(hit.text),
    cues: Array.isArray(hit.cues) ? hit.cues : [],
    source: "asr-cache",
  };
}

export async function setCachedTranscript(url, payload) {
  if (!url || !payload?.text || !chrome.storage?.local) return;
  const id = await cacheId(url);
  const key = ITEM_PREFIX + id;
  const item = {
    id,
    url: videoIdentity(url),
    text: String(payload.text).slice(0, 20000),
    cues: Array.isArray(payload.cues) ? payload.cues.slice(0, 800) : [],
    at: Date.now(),
  };
  const { [INDEX_KEY]: index } = await chrome.storage.local.get(INDEX_KEY);
  const next = (Array.isArray(index) ? index : []).filter((x) => x.id !== id);
  next.unshift({ id, at: item.at });
  const drop = next.splice(MAX_CACHE);
  await chrome.storage.local.set({ [key]: item, [INDEX_KEY]: next });
  if (drop.length) {
    await chrome.storage.local.remove(drop.map((x) => ITEM_PREFIX + x.id));
  }
}

export async function loadPageCaptions(tabId, pageUrl) {
  if (!tabId) return { status: "missing", cues: [], text: "", source: "none" };
  if (restrictedUrl(pageUrl)) return { status: "n/a", cues: [], text: "", source: "restricted" };
  if (/youtube\.com|youtu\.be/i.test(pageUrl || "")) {
    try {
      const caps = await loadYoutubeCaptions(tabId, pageUrl);
      if (caps.status === "ready" && caps.text) return { ...caps, source: "youtube" };
    } catch {
      /* fall through */
    }
  }
  try {
    const tracks = await inject(tabId, readTextTracks);
    if (tracks?.status === "ready" && tracks.text) return { ...tracks, source: "textTracks" };
  } catch {
    /* fall through */
  }
  const fromLib = await readVideoDocFromLibrary(pageUrl);
  if (fromLib?.status === "ready" && fromLib.text) return fromLib;
  const cached = await getCachedTranscript(pageUrl);
  if (cached) return cached;
  return { status: "missing", cues: [], text: "", source: "missing" };
}

export async function transcribeTab({
  tabId,
  settings,
  force = false,
  fromStart = true,
  maxSeconds,
  onProgress,
  signal,
  stopRecording,
} = {}) {
  if (!tabId) throw new Error("没有可转写的标签。");
  const asr = settings?.asr || (await loadSettings()).asr;
  if (!isAsrReady(asr)) {
    throw new Error("未配置语音转写。到设置填写 ASR 的 base_url 和 model；本地 Whisper 可以不填 api_key。");
  }
  const tab = await chrome.tabs.get(tabId);
  if (restrictedUrl(tab?.url)) throw new Error(`受限页无法转写：${tab?.url || ""}`);
  if (!force) {
    const existing = await loadPageCaptions(tabId, tab.url);
    if (existing.status === "ready" && existing.text) return { ...existing, reused: true };
  }
  onProgress?.({ status: "recording" });
  const audio = await recordTabAudio({
    tabId,
    fromStart: fromStart !== false,
    maxSeconds,
    onProgress,
    signal: stopRecording || signal,
  });
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  onProgress?.({ status: "uploading", seconds: audio.seconds });
  const segments = await transcribeAudio(asr, audio.blob, {
    filename: filenameForMime(audio.mime),
    signal,
  });
  const formatted = formatTranscript(segments);
  formatted.source = "asr";
  if (formatted.status !== "ready") throw new Error("转写结果是空的。");
  await setCachedTranscript(tab.url, formatted);
  const saved = await syncPackToLibrary({
    url: tab.url,
    title: tab.title,
    captionsStatus: "ready",
    captionsText: formatted.text,
    captionsCues: formatted.cues,
    captionsSource: "asr",
    video: { duration: audio.seconds },
  });
  formatted.library = saved?.ok ? saved.folder : "";
  if (saved?.ok === false && saved.error && !saved.skipped) formatted.libraryError = saved.error;
  onProgress?.({ status: "done" });
  return formatted;
}

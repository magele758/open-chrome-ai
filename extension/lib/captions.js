import { injectVideo, restrictedUrl } from "./chrome.js";
import { loadYoutubeCaptions } from "./youtube.js";
import { formatTranscript } from "./asr.js";
import { loadSettings } from "./storage.js";
import { acquireFullTranscript, subtitleCues } from "./full-transcript.js";
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
    complete: hit.complete === true,
    duration: hit.duration,
  };
}

export async function setCachedTranscript(url, payload) {
  if (!url || !payload?.text || !chrome.storage?.local) return;
  const id = await cacheId(url);
  const key = ITEM_PREFIX + id;
  const item = {
    id,
    url: videoIdentity(url),
    text: String(payload.text),
    complete: payload.complete === true,
    duration: payload.duration,
    cues: Array.isArray(payload.cues) ? payload.cues : [],
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
    const tracks = await injectVideo(tabId, "tracks");
    if (tracks?.status === "ready" && tracks.text) return { ...tracks, source: "textTracks" };
  } catch {
    /* fall through */
  }
  const fullCached = await getCachedTranscript(pageUrl);
  if (fullCached?.complete) return fullCached;
  const fromLib = await readVideoDocFromLibrary(pageUrl);
  if (fromLib?.status === "ready" && fromLib.text) return fromLib;
  const cached = await getCachedTranscript(pageUrl);
  if (cached) return cached;
  return { status: "missing", cues: [], text: "", source: "missing" };
}

export async function transcribeTab({ tabId, settings, force = false, onProgress, signal } = {}) {
  if (!tabId) throw new Error("没有可转写的标签。");
  const tab = await chrome.tabs.get(tabId);
  if (restrictedUrl(tab?.url)) throw new Error(`受限页无法转写：${tab?.url || ""}`);
  signal?.throwIfAborted();
  if (!force) {
    const existing = await loadPageCaptions(tabId, tab.url);
    if (existing.complete && existing.status === "ready" && existing.text) {
      signal?.throwIfAborted();
      await setCachedTranscript(tab.url, existing);
      return { ...existing, reused: true };
    }
    // Legacy recordings and progressively loaded tracks are not full transcripts.
    const cached = await getCachedTranscript(tab.url);
    if (cached?.complete) return { ...cached, reused: true };
  }
  onProgress?.({ status: "extracting", hint: "正在获取完整字幕或音轨" });
  const media = await injectVideo(tabId, "media").catch(() => null);
  if (media?.live) throw new Error("直播尚未结束，暂时无法获取完整音轨。");
  let formatted;
  for (const url of media?.tracks || []) {
    try {
      const response = await fetch(url, { signal });
      if (!response.ok) continue;
      const result = formatTranscript(subtitleCues({ format: 'vtt', body: await response.text() }));
      if (result.status === 'ready') {
        formatted = { ...result, complete: true, source: 'downloaded-subtitles', duration: media.duration };
        break;
      }
    } catch (error) { signal?.throwIfAborted(); }
  }
  if (!formatted) {
    formatted = await acquireFullTranscript({
      url: tab.url,
      mediaUrl: !/youtube\.com|youtu\.be|bilibili\.com/i.test(tab.url) && /^https?:/.test(media?.src || '') ? media.src : undefined,
      asr: settings?.asr || (await loadSettings()).asr,
      signal, onProgress,
    });
  }
  signal?.throwIfAborted();
  await setCachedTranscript(tab.url, formatted);
  const saved = await syncPackToLibrary({
    url: tab.url, title: tab.title,
    captionsStatus: "ready", captionsText: formatted.text, captionsCues: formatted.cues,
    captionsSource: formatted.source, captionsComplete: true,
    video: { duration: formatted.duration },
  });
  formatted.library = saved?.ok ? saved.folder : "";
  if (saved?.ok === false && saved.error && !saved.skipped) formatted.libraryError = saved.error;
  onProgress?.({ status: "done" });
  return formatted;
}

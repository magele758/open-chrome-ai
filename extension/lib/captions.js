import { debugLog } from "./debug-log.js";
import { injectVideo, restrictedUrl } from "./chrome.js";
import { loadSettings } from "./storage.js";
import { acquireFullTranscript } from "./full-transcript.js";
import { readVideoDocFromLibrary, syncPackToLibrary, videoIdentity } from "./library.js";
import { idbDel, idbGet, idbSet } from "./idb-kv.js";

export { videoIdentity };

const INDEX_KEY = "pl.asr.index";
const ITEM_PREFIX = "pl.asr.item.";
const MAX_CACHE = 24;

async function readCachedItem(key) {
  const fromIdb = await idbGet(key);
  if (fromIdb != null) return fromIdb;
  if (!chrome.storage?.local) return null;
  const data = await chrome.storage.local.get(key);
  const hit = data?.[key];
  if (hit == null) return null;
  if (await idbSet(key, hit)) await chrome.storage.local.remove(key);
  return hit;
}

async function writeCachedItem(key, item) {
  if (await idbSet(key, item)) {
    if (chrome.storage?.local) await chrome.storage.local.remove(key);
    return;
  }
  if (chrome.storage?.local) await chrome.storage.local.set({ [key]: item });
}

async function dropCachedItems(keys) {
  if (!keys?.length) return;
  await idbDel(keys);
  if (chrome.storage?.local) await chrome.storage.local.remove(keys);
}

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
  if (!url) return null;
  const id = await cacheId(url);
  const key = ITEM_PREFIX + id;
  const hit = await readCachedItem(key);
  if (!hit?.text || hit.audioOnly !== true) return null;
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
  if (!url || !payload?.text || !isAudioTranscript(payload) || !chrome.storage?.local) return;
  const id = await cacheId(url);
  const key = ITEM_PREFIX + id;
  const item = {
    id,
    audioOnly: true,
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
  await chrome.storage.local.set({ [INDEX_KEY]: next });
  await writeCachedItem(key, item);
  await dropCachedItems(drop.map((x) => ITEM_PREFIX + x.id));
}

export async function loadPageCaptions(tabId, pageUrl) {
  if (!tabId) return { status: "missing", cues: [], text: "", source: "none" };
  if (restrictedUrl(pageUrl)) return { status: "n/a", cues: [], text: "", source: "restricted" };
  const fullCached = await getCachedTranscript(pageUrl);
  if (fullCached?.complete) { debugLog("transcript.cache-hit", { url: pageUrl, source: fullCached.source, complete: true }); return fullCached; }
  const fromLib = await readVideoDocFromLibrary(pageUrl);
  if (fromLib?.status === "ready" && fromLib.text && isAudioTranscript(fromLib)) {
    debugLog("transcript.library-hit", { url: pageUrl, source: fromLib.source, complete: fromLib.complete });
    return fromLib;
  }
  const cached = await getCachedTranscript(pageUrl);
  if (cached) return cached;
  return { status: "missing", cues: [], text: "", source: "missing" };
}

export function isAudioTranscript(caps) {
  return ["asr-full", "asr", "asr-cache", "interpret"].includes(caps?.source);
}

export function usableTranscript(caps) {
  const text = String(caps?.text || "").trim();
  if (!text || caps?.status === "n/a" || !isAudioTranscript(caps)) return null;
  return {
    status: "ready",
    text,
    cues: Array.isArray(caps.cues) ? caps.cues : [],
    source: caps.source || "unknown",
    complete: caps.complete === true,
    duration: caps.duration,
  };
}

export function isReusablePageTranscript(caps) {
  return Boolean(usableTranscript(caps) && caps.complete === true);
}

export async function transcribeTab({ tabId, settings, force = false, onProgress, signal } = {}) {
  if (!tabId) throw new Error("没有可转写的标签。");
  const tab = await chrome.tabs.get(tabId);
  if (restrictedUrl(tab?.url)) throw new Error(`受限页无法转写：${tab?.url || ""}`);
  signal?.throwIfAborted();
  if (!force) {
    const existing = await loadPageCaptions(tabId, tab.url);
    if (isReusablePageTranscript(existing)) {
      signal?.throwIfAborted();
      await setCachedTranscript(tab.url, existing);
      return { ...existing, reused: true };
    }
    // Partial audio recordings are not full transcripts.
    const cached = await getCachedTranscript(tab.url);
    if (cached?.complete) return { ...cached, reused: true };
  }
  onProgress?.({ status: "extracting", hint: "正在获取完整音轨" });
  const media = await injectVideo(tabId, "media").catch(() => null);
  if (media?.live) throw new Error("直播尚未结束，暂时无法获取完整音轨。");
  const formatted = await acquireFullTranscript({
    url: tab.url,
    mediaUrl: !/youtube\.com|youtu\.be|bilibili\.com/i.test(tab.url) && /^https?:/.test(media?.src || '') ? media.src : undefined,
    asr: settings?.asr || (await loadSettings()).asr,
    signal, onProgress,
  });
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

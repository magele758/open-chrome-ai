import { checkSmartRecall } from "./clippings-ui.js";
import {
  clearCompactSegments,
  compactController,
  compactSessionOpen,
  discardCompactProgress,
  interpretController,
  renderCompactPlayer,
  stopCompactPlayback,
  stopDubPlayback,
} from "./compact-player.js";
import { $ } from "./dom.js";
import { isTranscribing, renderContext } from "./media-chrome.js";
import { renderSkills } from "./messages.js";
import { state } from "./state.js";
import { loadFullMediaArchive } from "../lib/audio-composer.js";
import { loadPageCaptions } from "../lib/captions.js";
import { restrictedUrl } from "../lib/chrome.js";
import { syncPackToLibrary, videoIdentity } from "../lib/library.js";
import { loadTabPack } from "../lib/page-pack.js";

async function pickTargetTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && !restrictedUrl(active.url)) return active;
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs.find((t) => t.url && !restrictedUrl(t.url)) || active || null;
}

async function refreshTab() {
  ensureMediaSourceFromPlayback(state.tab);

  const mediaId = state.mediaTab?.id;
  const mediaUrl = state.mediaTab?.url;
  const sourceTab = mediaId ? await chrome.tabs.get(mediaId).catch(() => null) : null;
  const sourceStillSame = Boolean(sourceTab && sourceTab.url === mediaUrl);
  const mediaAlive = Boolean(mediaId && isMediaPlaybackActive(mediaId));

  if (mediaAlive && (!sourceTab || !sourceStillSame)) {
    interpretController.stop(mediaId);
    compactController.stop(mediaId);
    stopCompactPlayback();
    stopDubPlayback();
    discardCompactProgress();
    state.mediaTab = null;
    state.mediaPack = null;
  }

  const tab = await pickTargetTab();
  if (!state.share && state.dismissedPage && tab && (tab.id !== state.dismissedPage.id || tab.url !== state.dismissedPage.url)) {
    state.share = true;
    state.dismissedPage = null;
  }
  const prevId = state.tab?.id;
  const prevUrl = state.tab?.url;
  const changed = tab?.id !== prevId || tab?.url !== prevUrl;
  const keepMedia = Boolean(state.mediaTab?.id && isMediaPlaybackActive(state.mediaTab.id) && sourceStillSame);
  const recording = typeof isTranscribing === "function" ? isTranscribing() : false;
  const interpretingOnPage = interpretController.isRunning(tab?.id);

  if (!recording && !interpretingOnPage && tab?.id !== prevId) state.transcribe = null;
  if (recording && changed) {
    state.workAbort?.abort();
    state.workAbort = null;
  }
  if (changed && !keepMedia) {
    if (state.dubPlaying) stopDubPlayback();
    stopCompactPlayback();
    clearCompactSegments();
  }

  const revision = ++state.pageRevision;
  state.tab = tab || null;
  if (Number.isInteger(tab?.windowId) && tab.windowId >= 0) state.windowId = tab.windowId;
  if (keepMedia) {
    state.interpret = interpretController.getState(state.mediaTab.id);
    state.originalAudioOn = interpretController.getTask?.(state.mediaTab.id)?.originalAudioOn ?? state.originalAudioOn;
  } else {
    state.interpret = interpretController.getState(tab?.id);
    state.originalAudioOn = interpretController.getTask?.(tab?.id)?.originalAudioOn ?? true;
  }

  if (keepMedia && tab?.id === state.mediaTab.id && state.mediaPack) {
    state.pack = state.mediaPack;
    renderContext();
    renderSkills();
    if (tab?.url) checkSmartRecall(tab.url).catch(() => {});
    return;
  }

  if (!state.share || !tab || restrictedUrl(tab.url)) {
    state.pack = null;
    $("recall-banner")?.classList.add("hidden");
    renderContext();
    renderSkills();
    return;
  }

  if (changed) {
    state.pack = {
      title: tab.title || "",
      url: tab.url || "",
      text: "",
      quotes: [],
      video: null,
      loading: true,
      tab,
    };
    renderContext();
  }

  try {
    const result = await loadTabPack(tab.id);
    if (revision !== state.pageRevision) return;
    if (tab?.id !== state.tab?.id || tab?.url !== state.tab?.url) return;
    state.pack = result || {
      title: tab.title,
      url: tab.url,
      text: "",
      quotes: [],
      video: null,
    };
    if (state.mediaTab?.id === tab.id) state.mediaPack = state.pack;
    if (result && (result.videoIsPrimary || result.video || /youtube\.com|youtu\.be|bilibili\.com/.test(tab.url || ""))) {
      const caps = await loadPageCaptions(tab.id, tab.url);
      if (revision !== state.pageRevision) return;
      if (tab?.id !== state.tab?.id || tab?.url !== state.tab?.url) return;
      state.pack.captionsStatus = caps.status;
      state.pack.captionsText = caps.text;
      state.pack.captionsSource = caps.source;
      state.pack.captionsCues = caps.cues;
      state.pack.captionsComplete = caps.complete === true;
      if (caps.status === "ready") syncPackToLibrary(state.pack).catch(() => {});
    }

    if (tab.url && (state.pack?.hasVideo || state.pack?.video || /youtube\.com|youtu\.be|bilibili\.com/.test(tab.url))) {
      const videoId = videoIdentity(tab.url);
      if (videoId) {
        try {
          const archive = await loadFullMediaArchive(videoId);
          if (revision !== state.pageRevision) return;
          if (tab?.id !== state.tab?.id || tab?.url !== state.tab?.url) return;
          if (archive && (archive.hasAudio || archive.hasCompactAudio)) {
            state.pack = state.pack || {};
            state.pack.archive = archive;
            renderCompactPlayer();
            if (!state.pack.captionsText && archive.lines?.length) {
              state.pack.captionsStatus = "ready";
              state.pack.captionsSource = "dub-archive";
              state.pack.captionsText = archive.lines.map((l) => l.zh).join("\n");
              state.pack.captionsCues = archive.cues;
              state.pack.captionsComplete = archive.complete === true;
            }
          }
        } catch (err) {
          console.warn("[pagelens] load archive error", err);
        }
      }
    }
  } catch {
    if (revision !== state.pageRevision) return;
    if (tab?.id !== state.tab?.id || tab?.url !== state.tab?.url) return;
    state.pack = {
      title: tab.title,
      url: tab.url,
      text: "",
      quotes: [],
      video: null,
    };
  }
  renderContext();
  renderSkills();
  if (tab?.url) {
    checkSmartRecall(tab.url).catch(() => {});
  } else {
    $("recall-banner")?.classList.add("hidden");
  }
}

function snapshotTab(tab) {
  if (!tab) return null;
  return { id: tab.id, url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl, windowId: tab.windowId };
}

function isVideoUrl(url) {
  return /youtube\.com|youtu\.be|bilibili\.com|vimeo\.com|tiktok\.com/.test(url || "");
}

function isVideoPack(pack) {
  return Boolean(pack?.isVideoPage || pack?.hasVideo || pack?.video || pack?.videoIsPrimary || pack?.kind === "video" || isVideoUrl(pack?.tab?.url || pack?.url));
}

function isMediaPlaybackActive(tabId) {
  if (tabId != null) {
    return Boolean(
      interpretController.isRunning(tabId) ||
      compactController.isRunning(tabId) ||
      (typeof compactSessionOpen !== "undefined" && compactSessionOpen && state.mediaTab?.id === tabId) ||
      (state.dubPlaying && state.mediaTab?.id === tabId)
    );
  }
  return Boolean(
    (state.mediaTab?.id && (interpretController.isRunning(state.mediaTab.id) || compactController.isRunning(state.mediaTab.id))) ||
    (typeof compactSessionOpen !== "undefined" && compactSessionOpen) ||
    state.dubPlaying
  );
}

function bindMediaSource(tab, pack) {
  if (!tab) return;
  state.mediaTab = snapshotTab(tab);
  if (pack) state.mediaPack = pack;
}

function ensureMediaSourceFromPlayback(fallbackTab) {
  if (state.mediaTab?.id) return state.mediaTab;
  const running = interpretController.getRunningTasks?.() || [];
  const active = running.find((t) => t?.tabId) || running[0];
  if (active?.tabId) {
    bindMediaSource({ id: active.tabId, url: active.url, title: active.title }, state.mediaPack);
    return state.mediaTab;
  }
  const tab = fallbackTab || state.tab;
  if (!tab?.id) return null;
  if (isMediaPlaybackActive(tab.id) || isVideoPack(state.pack) || isVideoUrl(tab.url)) {
    if (isMediaPlaybackActive(tab.id) || compactSessionOpen || state.dubPlaying) {
      bindMediaSource(tab, isVideoPack(state.pack) ? state.pack : state.mediaPack);
      return state.mediaTab;
    }
  }
  if (compactSessionOpen || state.dubPlaying) {
    bindMediaSource(tab, isVideoPack(state.pack) ? state.pack : state.mediaPack);
    return state.mediaTab;
  }
  return null;
}

function packForMedia() {
  if (state.mediaTab && state.tab?.id === state.mediaTab.id) return state.pack || state.mediaPack;
  return state.mediaPack || null;
}

function packForMediaWrite(tabId) {
  if (tabId == null) {
    if (state.mediaTab && state.tab?.id !== state.mediaTab.id) return (state.mediaPack ||= {});
    return (state.pack ||= {});
  }
  if (state.tab?.id === tabId) {
    state.pack ||= {};
    if (state.mediaTab?.id === tabId) state.mediaPack = state.pack;
    return state.pack;
  }
  if (state.mediaTab?.id === tabId) return (state.mediaPack ||= {});
  return null;
}

function mediaActionTab() {
  if (isVideoPack(state.pack) || isVideoUrl(state.tab?.url)) return state.tab;
  return state.mediaTab || state.tab;
}

function releaseMediaSourceIfIdle() {
  if (isMediaPlaybackActive()) return;
  if (state.tab?.id && state.mediaTab?.id === state.tab.id) {
    state.mediaPack = state.pack;
    return;
  }
  if (state.mediaTab && state.tab?.id !== state.mediaTab.id) {
    state.mediaTab = null;
    state.mediaPack = null;
  }
}


export {
  pickTargetTab,
  refreshTab,
  snapshotTab,
  isVideoUrl,
  isVideoPack,
  isMediaPlaybackActive,
  bindMediaSource,
  ensureMediaSourceFromPlayback,
  packForMedia,
  packForMediaWrite,
  mediaActionTab,
  releaseMediaSourceIfIdle,
};

import { debugLog, exportDebugLogFresh, DEBUG_BUILD, hydrateDebugLog } from "../lib/debug-log.js";
hydrateDebugLog();
debugLog("panel.loaded", { build: DEBUG_BUILD, source: "sidepanel" });
import { defaultSettings, loadSettings, saveSettings, applyOptionalLocalSettings, resolveModel, isModelReady, isAsrReady, isTtsReady, isSkillsEnabled, presetsFor } from "../lib/storage.js";
import { streamTurn, testConnection, listRemoteModels, multimodalUserContent, estimateTokens } from "../lib/openai.js";
import {
  addProviderModel,
  enabledModelOptions,
  hydrateTextCatalog,
  mergeScannedModels,
  newProviderId,
  normalizeProvider,
  invertProviderModelsEnabled,
  setAllProviderModelsEnabled,
  setProviderModelEnabled,
  suggestProviderName,
} from "../lib/text-providers.js";
import { testTranscriptions } from "../lib/asr.js";
import { testTts, synthesizeTts, getTtsRef, setTtsRef, clearTtsRef, blobToWav, TTS_LANGS } from "../lib/tts.js";
import { highlightQuote } from "../lib/extract.js";
import { loadTabPack } from "../lib/page-pack.js";
import { systemPrompt, packToContext, visibleSkills, formatTime } from "../lib/prompts.js";
import { summarizeTranscript } from "../lib/summarize-transcript.js";
import { loadPageCaptions, transcribeTab, usableTranscript } from "../lib/captions.js";
import { abortRecording, beginCapture, beginTabCapture, discardCapture, recordFromCapture } from "../lib/tab-audio.js";
import { injectVideo } from "../lib/chrome.js";
import { runInterpret } from "../lib/interpret.js";
import { InterpretController } from "./interpret-controller.js";
import { createMessageScroll } from "./message-scroll.js";
let messageScroll;
const thinkingScrolls = new WeakMap();
import { loadFullMediaArchive, cleanExpiredMediaArchives, deleteMediaArchive } from "../lib/audio-composer.js";
import { clearVideoDubCache } from "../lib/dub-cache.js";
import { StreamingAudioPlayer, getSharedAudioContext } from "../lib/streaming-audio-player.js";
import {
  libraryStatus,
  pickLibraryFolder,
  setLibraryPath,
  clearSavedHandle,
  syncPackToLibrary,
  writeSessionNote,
  writeSessionNotes,
  videoIdentity,
} from "../lib/library.js";
import {
  dailyNoteRelPath,
  executeClipping,
  getClippingsForUrl,
  clippingPageKey,
  listAllClippings,
  deleteClippingRecord,
  deleteClippingFull,
} from "../lib/clippings.js";
import {
  getReviewPeriod,
  filterClippingsForPeriod,
  getClippingsMetadata,
  generateReviewSummary,
  listAllReviews,
  getReviewByKey,
  saveReviewRecord,
  deleteReviewRecord,
  writeReviewToObsidian,
  appendReviewToDailyNote,
} from "../lib/reviews.js";
import { initMarkdown, formatAnswer, splitThinking, decorateInlines, bindMarkdownLinks, enhanceMermaid } from "../lib/markdown.js";
import { createAgentLoop } from "../lib/agent/loop.js";
import { createAgentTools, resolveActiveTools, checkHitlRequirement } from "../lib/agent/tools.js";
import { deleteSessionArtifacts } from "../lib/agent/artifact-store.js";
import { auditToolCall } from "../lib/agent/guardrail.js";
import { loadRuntimeSkills, shortcutsAsSkills, skillCatalogText } from "../lib/agent/skills.js";
import { applySlashItem, composeSkillPrompt, filterSlashItems, parseSlashToken, slashItemsFromSkills, userInvokedSkill } from "../lib/slash.js";
import { pickSkillFolder, clearSkillFolderHandle, setSkillFolderPath, ensureSkillBody, skillFolderStatus } from "../lib/skill-folder.js";
import { installHint, pingNativeHost } from "../lib/native-host.js";
import { restrictedUrl, captureTab as captureVisible } from "../lib/chrome.js";
import {
  clearActiveId,
  deleteSession,
  filterSessions,
  formatWhen,
  listSessions,
  loadAllSessions,
  loadActiveSession,
  loadSession,
  mergePage,
  saveSession,
  sessionFilename,
  sessionToMarkdown,
  sessionsToJSON,
  sessionsToMarkdown,
} from "../lib/sessions.js";
import { isResumableRun } from "../lib/agent/context.js";

console.info("[pagelens] module start");

const $ = (id) => document.getElementById(id);

function on(id, event, handler) {
  const el = $(id);
  if (!el) {
    console.warn("[pagelens] wire missing", id);
    return null;
  }
  el.addEventListener(event, handler);
  return el;
}

let composerBound = false;

const state = {
  settings: defaultSettings(),
  tab: null,
  pack: null,
  share: true,
  messages: [],
  image: null,
  busy: false,
  view: "chat",
  abort: null,
  skills: [],
  skillsMetaReady: false,
  skillsMetaLoading: false,
  skillsMetaError: "",
  sessionId: null,
  windowId: null,
  sessionCreatedAt: null,
  sessionPages: [],
  histQuery: "",
  run: null,
  stopIntent: null,
  taskGroupId: null,
  transcribe: null,
  recordAbort: null,
  workAbort: null,
  interpret: null,
  siAbort: null,
  siCapture: null,
  originalAudioOn: true,
  library: { configured: false, granted: false, name: "" },
  textProviderUi: { adding: false, editingId: "", query: "", addModel: {}, msg: "", err: "" },
  skillFolder: { configured: false, granted: false, name: "", count: 0 },
  nativeHost: { ok: false, checked: false },
  sessionHitlOverride: null,
  dubPlaying: false,
  activeToolDomains: new Set(),
  currentClipMsg: null,
  activeRecallClippings: [],
  dismissedRecallUrls: new Set(),
  review: {
    type: "daily",
    date: Date.now(),
    selectedClippingIds: new Set(),
    activeClippings: [],
    activeReview: null,
    generating: false,
    abort: null,
    lastPeriodKey: null,
  },
  mediaExpanded: true,
  toolsExpanded: false,
  tasksExpanded: true,
  chatRef: null,
  videoSummary: null,
  mediaTab: null,
  mediaPack: null,
  pageRevision: 0,
  dismissedPage: null,
};

const interpretController = new InterpretController();
const compactController = new InterpretController({ audioOnly: true });

compactController.setAudioProviders({
  getPlayhead: () => {
    if (compactStreamPlayer) {
      return compactStreamPlayer.getCurrentSourceTime();
    }
    return 0;
  },
  getScheduledTime: () => {
    if (compactStreamPlayer) {
      return compactStreamPlayer.getScheduledSourceTime();
    }
    if (compactSegments.length > 0) {
      const last = compactSegments[compactSegments.length - 1];
      return Number.isFinite(last.end) ? last.end : 0;
    }
    return 0;
  },
  isActive: () => {
    return Boolean(
      compactPlaying ||
      compactPendingAutoplay ||
      (compactStreamPlayer && compactStreamPlayer.state !== "stopped" && compactStreamPlayer.state !== "idle" && compactStreamPlayer.state !== "paused")
    );
  }
});

interpretController.subscribe((event, taskState) => {
  if (taskState?.tabId && state.mediaTab?.id && taskState.tabId !== state.mediaTab.id) {
    renderContext();
    return;
  }
  if (taskState?.tabId && !state.mediaTab) {
    state.mediaTab = { id: taskState.tabId, url: taskState.url, title: taskState.title };
    state.mediaPack = state.mediaPack || state.pack;
  }
  state.interpret = taskState;
  if (event?.type === "archive_saved") {
    const pack = packForMediaWrite(taskState.tabId);
    if (pack) pack.archive = event.archive;
  }
  if (event?.type === "generation_progress") {
    taskState.hint = `已复用 ${event.reused} 段 · 新生成 ${event.generated} 段`;
  }
  if (taskState?.status === "running") state.originalAudioOn = taskState.originalAudioOn;
  renderContext();
});

compactController.subscribe((event, taskState) => {
  if (taskState?.tabId && state.mediaTab?.id && taskState.tabId !== state.mediaTab.id) return;
  if (!compactSessionOpen) return;
  if (event?.type === "status") compactGenerationMessage = event.status?.message || "";
  if (event?.type === "generation_progress") {
    compactGenerationMessage = `已就绪 ${event.ready}/${event.total} 段 · 已复用 ${event.reused} 段 · 新生成 ${event.generated} 段`;
    if (event.covered < event.duration) compactGenerationMessage += ` · 已规划至 ${formatTime(event.covered)} / ${formatTime(event.duration)}`;
  }
  if (event?.type === "warn") compactGenerationMessage = event.message;
  if (event?.type === "dub_segment" && event.segment) {
    compactSegments.push(event.segment);
    if (compactStreamPlayer) {
      void compactStreamPlayer.enqueue(event.segment);
    }
    if (compactPendingAutoplay && compactSegments.length >= 1) {
      compactPendingAutoplay = false;
      void startCompactStreamPlayback().catch(err => { stopCompactPlayback(); pushError("纯享播放失败：" + err.message); });
    }
    renderCompactPlayer();
    renderTranscribeAction();
  }
  if (event?.type === "dub_complete") {
    compactGenerationComplete = true;
    if (compactStreamPlayer) {
      compactStreamPlayer.closeStream();
    }
  }
  if (event?.type === "archive_saved" && event.archive) {
    const pack = packForMediaWrite(taskState?.tabId);
    if (pack) pack.archive = event.archive;
    compactFullGenerating = false;
    compactGenerationMessage = "完整音频已保存，可播放或下载（缓存保留 7 天）";
    renderTranscribeAction();
    renderCompactPlayer();
    if (compactPendingAutoplay) {
      compactPendingAutoplay = false;
      void toggleCompactPlayback();
    }
  }
  if (event?.type === "line") {
    renderCompactPlayer();
    renderTranscribeAction();
  }
  if (["stopped", "idle", "error"].includes(event?.type)) {
    if (event?.type === "error" || event?.type === "stopped") {
      compactPendingAutoplay = false;
      if (compactFullGenerating && !packForMedia()?.archive?.complete && !compactGenerationMessage.includes("失败")) {
        compactGenerationMessage = event?.type === "error" ? event.error : "尚未保存完整音频，请重试；已完成的分段缓存会复用。";
      }
      compactFullGenerating = false;
      compactGenerationComplete = event?.type === "stopped";
      compactStreamPlayer?.closeStream();
      if (event?.type === "error") pushError("纯享音频：" + event.error);
    }
    renderCompactPlayer();
    renderTranscribeAction();
  }
  renderCompactPlayer();
  renderContext();
});

let dubPlayerAudio = null;
let dubPlayerBlobUrl = null;
let dubPlayerTimer = null;

let compactPlayerAudio = null;
let compactPlayerBlobUrl = null;
let compactPlayerTimer = null;
let compactStreamPlayer = null;
let compactSegments = [];
let compactPlaying = false;
let compactPendingAutoplay = false;
let compactRate = 1.0;
let compactSessionOpen = false;
let compactGenerationComplete = false;
let compactActionPending = false;
let compactRevision = 0;
let compactFullGenerating = false;
let compactGenerationMessage = "";
const COMPACT_RATES = [1.0, 1.25, 1.5, 2.0];

function stopCompactAudioElement() {
  if (compactPlayerTimer) {
    clearInterval(compactPlayerTimer);
    compactPlayerTimer = null;
  }
  if (compactPlayerAudio) {
    try {
      compactPlayerAudio.onended = compactPlayerAudio.onerror = compactPlayerAudio.ontimeupdate = null;
      compactPlayerAudio.pause();
      compactPlayerAudio.src = "";
    } catch { /* ignore */ }
    compactPlayerAudio = null;
  }
  if (compactPlayerBlobUrl) {
    const u = compactPlayerBlobUrl;
    setTimeout(() => { try { URL.revokeObjectURL(u); } catch {} }, 2000);
    compactPlayerBlobUrl = null;
  }
}

function stopCompactPlayback() {
  compactRevision++;
  compactSessionOpen = false;
  compactFullGenerating = false;
  compactGenerationMessage = "";
  if (!compactGenerationComplete) compactSegments = [];
  void compactController.stop((typeof mediaActionTab === "function" ? mediaActionTab()?.id : null) ?? state.mediaTab?.id ?? state.tab?.id);
  compactPendingAutoplay = false;
  compactPlaying = false;
  if (compactStreamPlayer) {
    try { compactStreamPlayer.stop(); } catch {}
    compactStreamPlayer = null;
  }
  stopCompactAudioElement();
  if (typeof mediaShouldShow === "function" && mediaShouldShow() && state.mediaExpanded) {
    $("compact-player-bar")?.classList.remove("hidden");
  } else {
    $("compact-player-bar")?.classList.add("hidden");
  }
  renderCompactPlayer();
  renderTranscribeAction();
}

function getCompactDuration() {
  if (compactStreamPlayer) {
    return compactStreamPlayer.getTotalDuration();
  }
  if (compactPlayerAudio) {
    return (Number.isFinite(compactPlayerAudio.duration) && compactPlayerAudio.duration > 0)
      ? compactPlayerAudio.duration
      : (((typeof packForMedia === "function" && packForMedia()) || state.pack)?.archive?.compactDuration
        || ((typeof packForMedia === "function" && packForMedia()) || state.pack)?.archive?.duration || 0);
  }
  if (compactSegments.length > 0) {
    return compactSegments.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
  }
  const mediaArchive = ((typeof packForMedia === "function" && packForMedia()) || state.pack)?.archive;
  return mediaArchive?.compactDuration || mediaArchive?.duration || 0;
}

function getCompactCurrentTime() {
  if (compactStreamPlayer) {
    return compactStreamPlayer.getCurrentPlaybackTime();
  }
  if (compactPlayerAudio) {
    return compactPlayerAudio.currentTime || 0;
  }
  return 0;
}

function renderCompactPlayer() {
  const bar = $("compact-player-bar");
  const playBtn = $("cp-play-btn");
  const timeEl = $("cp-time");
  const rateBtn = $("cp-rate-btn");
  const slider = $("cp-slider");

  if (!bar) return;
  if (playBtn) {
    playBtn.title = compactPendingAutoplay ? "取消准备" : compactPlaying ? "暂停" : "播放";
    playBtn.setAttribute("aria-label", playBtn.title);
  }
  if (slider) slider.disabled = getCompactDuration() <= 0;
  const download = $("cp-download-btn");
  const playerArchive = ((typeof packForMedia === "function" && packForMedia()) || state.pack)?.archive;
  if (download) download.disabled = !(playerArchive?.complete && playerArchive?.compactAudioBlob);
  const status = $("cp-generation-status");
  if (status) status.textContent = compactGenerationMessage || (playerArchive?.complete ? "已缓存完整音频 · 可直接播放或下载" : "边生成边听；需要完整文件可点「完整生成」");
  const fullButton = $("btn-generate-full");
  if (fullButton) {
    fullButton.textContent = compactFullGenerating ? "取消完整生成" : playerArchive?.complete ? "查看完整音频" : "完整生成";
    fullButton.classList.toggle("busy", compactFullGenerating);
  }

  if (compactPendingAutoplay) {
    bar.classList.remove("hidden");
    if (playBtn) playBtn.textContent = "⏳";
    if (rateBtn) rateBtn.textContent = `${compactRate.toFixed(1)}x`;
    const buffered = compactSegments.length;
    if (timeEl) timeEl.textContent = buffered > 0 ? `⏳ 纯享缓冲中 (${buffered}/1 段)…` : "⏳ 纯享准备中，首段就绪后自动开播…";
    if (slider && !slider.dataset.dragging) slider.value = "0";
    return;
  }

  if (compactPlaying) {
    bar.classList.remove("hidden");
    if (playBtn) playBtn.textContent = "⏸";
  } else {
    if (playBtn) playBtn.textContent = "▶";
  }

  if (rateBtn) rateBtn.textContent = `${compactRate.toFixed(1)}x`;

  const cur = getCompactCurrentTime();
  const dur = getCompactDuration();

  if (timeEl) {
    if (dur > 0) {
      timeEl.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
    } else {
      timeEl.textContent = "00:00 / 00:00";
    }
  }

  if (slider && !slider.dataset.dragging) {
    if (dur > 0) {
      slider.value = String(Math.floor(Math.max(0, Math.min(1000, (cur / dur) * 1000))));
    } else {
      slider.value = "0";
    }
  }
}

async function startCompactStreamPlayback() {
  const revision = compactRevision;
  stopCompactAudioElement();

  if (!compactStreamPlayer) {
    compactStreamPlayer = new StreamingAudioPlayer({
      gapMs: 0,
      initialBufferCount: 1,
      playbackRate: compactRate,
      AudioContextClass: typeof AudioContext !== 'undefined' ? AudioContext : null,
      onItemStart: (item) => {
        const live = $("cp-caption");
        const zh = $("cp-zh");
        const src = $("cp-src");
        if (live && zh && src) {
          live.classList.remove("hidden");
          zh.textContent = item.zh || "";
          src.textContent = item.src || "";
        }
        renderCompactPlayer();
      },
      onQueueUpdate: () => {
        renderCompactPlayer();
      },
      onEnded: () => {
        compactPlaying = false;
        if (compactPlayerTimer) {
          clearInterval(compactPlayerTimer);
          compactPlayerTimer = null;
        }
        renderCompactPlayer();
        renderTranscribeAction();
      },
      onError: (err) => {
        console.warn("[compact-stream] error", err);
        stopCompactPlayback();
      }
    });

    const player = compactStreamPlayer;
    for (const seg of [...compactSegments]) {
      await player.enqueue(seg);
      if (compactStreamPlayer !== player) return;
    }
    if (compactGenerationComplete) player.closeStream();
  }

  if (state.tab?.id) {
    try {
      await injectVideo(state.tab.id, "control", { action: "pause", system: false });
    } catch {}
  }

  if (revision !== compactRevision || !compactStreamPlayer) return;
  $("compact-player-bar")?.classList.remove("hidden");
  compactPlaying = true;
  await compactStreamPlayer.play();
  if (compactPlayerTimer) clearInterval(compactPlayerTimer);
  compactPlayerTimer = setInterval(() => {
    if (!compactPlaying || !compactStreamPlayer) {
      if (compactPlayerTimer) clearInterval(compactPlayerTimer);
      compactPlayerTimer = null;
      return;
    }
    renderCompactPlayer();
  }, 250);
  renderCompactPlayer();
  renderTranscribeAction();
}

async function startCompactArchivePlayback(audioBlob, archive) {
  const revision = compactRevision;
  if (compactStreamPlayer) {
    try { compactStreamPlayer.stop(); } catch {}
    compactStreamPlayer = null;
  }
  stopCompactAudioElement();

  try {
    compactPlayerBlobUrl = URL.createObjectURL(audioBlob);
    compactPlayerAudio = new Audio(compactPlayerBlobUrl);
    compactPlayerAudio.playbackRate = compactRate;
    compactPlayerAudio.preservesPitch = true;

    if (state.tab?.id) {
      try {
        await injectVideo(state.tab.id, "control", { action: "pause", system: false });
      } catch {}
    }

    if (revision !== compactRevision || !compactPlayerAudio) return;
    $("compact-player-bar")?.classList.remove("hidden");
    compactPlaying = true;
    renderCompactPlayer();
    renderTranscribeAction();

    try {
      await compactPlayerAudio.play();
    } catch (playErr) {
      compactPlaying = false;
      renderCompactPlayer();
      renderTranscribeAction();
      console.warn("[compact-player] Autoplay blocked, will play on next user gesture:", playErr);
    }

    compactPlayerAudio.onended = () => {
      compactPlaying = false;
      renderCompactPlayer();
      renderTranscribeAction();
    };

    compactPlayerAudio.onerror = (e) => {
      console.warn("[compact-player] error", e);
      stopCompactPlayback();
      pushError("纯享音频播放失败");
    };

    compactPlayerAudio.ontimeupdate = () => {
      if (!compactPlayerAudio) {
        if (compactPlayerTimer) clearInterval(compactPlayerTimer);
        compactPlayerTimer = null;
        return;
      }
      renderCompactPlayer();

      const cur = compactPlayerAudio.currentTime || 0;
      const cues = archive?.compactCues?.length ? archive.compactCues : archive?.cues;
      if (Array.isArray(cues) && cues.length > 0) {
        const activeCue = cues.find(c => {
          const s = Number.isFinite(c.compactStart) ? c.compactStart : c.start;
          const e = Number.isFinite(c.compactEnd) ? c.compactEnd : c.end;
          return s <= cur && e >= cur;
        });
        if (activeCue) {
          const live = $("cp-caption");
          const zh = $("cp-zh");
          const src = $("cp-src");
          if (live && zh && src) {
            live.classList.remove("hidden");
            zh.textContent = activeCue.zh || "";
            src.textContent = activeCue.src || "";
          }
        }
      }
    };
  } catch (err) {
    stopCompactPlayback();
    pushError("启动纯享播放失败：" + (err?.message || err));
  }
}

async function toggleCompactPlayback() {
  if (compactActionPending) return;
  compactActionPending = true;
  try { await performCompactToggle(); }
  catch (err) { stopCompactPlayback(); pushError("纯享音频：" + (err?.message || err)); }
  finally { compactActionPending = false; }
}

async function performCompactToggle() {
  const revision = compactRevision;
  compactSessionOpen = true;
  if (compactPendingAutoplay) {
    stopCompactPlayback();
    $("compact-player-bar")?.classList.add("hidden");
    renderCompactPlayer();
    renderTranscribeAction();
    return;
  }

  if (compactPlaying) {
    if (compactStreamPlayer) {
      await compactStreamPlayer.pause();
    }
    if (compactPlayerAudio) {
      compactPlayerAudio.pause();
    }
    compactPlaying = false;
    if (compactPlayerTimer) {
      clearInterval(compactPlayerTimer);
      compactPlayerTimer = null;
    }
    renderCompactPlayer();
    renderTranscribeAction();
    return;
  }

  try {
    const ctx = typeof getSharedAudioContext === 'function' ? getSharedAudioContext() : null;
    if (ctx && ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }
  } catch {}

  if (state.dubPlaying) stopDubPlayback();
  if (revision !== compactRevision) return;
  const compactTab = (typeof mediaActionTab === "function" ? mediaActionTab() : state.tab);
  if (interpretController.isRunning(compactTab?.id)) await interpretController.stop(compactTab.id);
  if (revision !== compactRevision) return;

  if (compactStreamPlayer && compactStreamPlayer.state === 'idle' && compactGenerationComplete) {
    compactStreamPlayer.stop();
    compactStreamPlayer = null;
  }
  if (compactStreamPlayer && compactStreamPlayer.state === 'paused') {
    if (compactTab?.id) {
      try { await injectVideo(compactTab.id, "control", { action: "pause", system: false }); } catch {}
    }
    await compactStreamPlayer.play();
    compactPlaying = true;
    if (compactPlayerTimer) clearInterval(compactPlayerTimer);
    compactPlayerTimer = setInterval(() => {
      if (!compactPlaying || !compactStreamPlayer) {
        if (compactPlayerTimer) clearInterval(compactPlayerTimer);
        compactPlayerTimer = null;
        return;
      }
      renderCompactPlayer();
    }, 250);
    renderCompactPlayer();
    renderTranscribeAction();
    return;
  }

  if (compactPlayerAudio && compactPlayerAudio.paused) {
    if (compactTab?.id) {
      try { await injectVideo(compactTab.id, "control", { action: "pause", system: false }); } catch {}
    }
    try {
      await compactPlayerAudio.play();
      compactPlaying = true;
      renderCompactPlayer();
      renderTranscribeAction();
      return;
    } catch {
      stopCompactAudioElement();
    }
  }

  if (compactSegments.length > 0) {
    await startCompactStreamPlayback();
    return;
  }

  const archive = ((typeof packForMedia === "function" && packForMedia()) || state.pack)?.archive;
  let audioBlob = archive?.compactAudioBlob || archive?.audioBlob;
  if (audioBlob) {
    try {
      const buf = await audioBlob.slice(0, 16).arrayBuffer();
      if (!buf || buf.byteLength === 0) throw new Error('Unreadable blob');
      await startCompactArchivePlayback(audioBlob, archive);
      return;
    } catch {
      console.warn('[compact-player] Archive audioBlob unreadable/stale, dropping');
      if (state.pack?.archive) {
        state.pack.archive.compactAudioBlob = null;
        state.pack.archive.audioBlob = null;
      }
      audioBlob = null;
    }
  }

  if (!compactTab?.id) return;
  if (!requireModel("text")) { pushError(needModelMessage("text")); return; }
  if (!isTtsReady(state.settings.tts)) { pushError("纯享音频需要先配置语音合成（TTS）"); return; }
  compactPendingAutoplay = true;
  compactGenerationComplete = false;
  $("compact-player-bar")?.classList.remove("hidden");
  renderCompactPlayer();
  renderTranscribeAction();
  if (!compactController.isRunning(compactTab.id)) {
    await compactController.stop(compactTab.id);
    if (revision !== compactRevision) return;
    if (typeof bindMediaSource === "function") bindMediaSource(compactTab, state.mediaPack || state.pack);
    void compactController.start({ tab: { ...compactTab }, settings: state.settings }).catch(err => {
      if (revision !== compactRevision) return;
      stopCompactPlayback();
      pushError("纯享启动失败：" + (err?.message || err));
    });
  }
}

function seekCompactPlayback(ratio) {
  const r = Math.max(0, Math.min(1, Number(ratio) || 0));

  if (compactStreamPlayer) {
    const total = compactStreamPlayer.getTotalDuration();
    if (total > 0) {
      void compactStreamPlayer.seekToTime(r * total);
      renderCompactPlayer();
      return;
    }
  }

  if (compactPlayerAudio) {
    const dur = (Number.isFinite(compactPlayerAudio.duration) && compactPlayerAudio.duration > 0)
      ? compactPlayerAudio.duration
      : (state.pack?.archive?.compactDuration || state.pack?.archive?.duration || 0);
    if (dur > 0) {
      compactPlayerAudio.currentTime = Math.max(0, Math.min(dur, r * dur));
      renderCompactPlayer();
      return;
    }
  }
}

function changeCompactRate() {
  const idx = COMPACT_RATES.indexOf(compactRate);
  compactRate = COMPACT_RATES[(idx + 1) % COMPACT_RATES.length];
  if (compactStreamPlayer) {
    compactStreamPlayer.setPlaybackRate(compactRate);
  }
  if (compactPlayerAudio) {
    compactPlayerAudio.playbackRate = compactRate;
  }
  renderCompactPlayer();
}

function downloadCompactAudio() {
  const archive = state.pack?.archive;
  const audioBlob = archive?.compactAudioBlob || archive?.audioBlob;
  if (!archive?.complete || !archive.compactAudioBlob) { pushError("请先完整生成音频，完成后即可下载。"); return; }
  const url = URL.createObjectURL(archive.compactAudioBlob);
  const a = document.createElement("a");
  a.href = url;
  const title = (state.pack?.title || "中文配音").replace(/[\\/:*?"<>|]/g, "_").trim();
  a.download = `${title}_纯享中文配音.wav`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}

function closeCompactPlayer() {
  stopCompactPlayback();
  $("compact-player-bar")?.classList.add("hidden");
}

async function clearCurrentDubbingCache() {
  const tab = (typeof mediaActionTab === "function" ? mediaActionTab() : state.tab);
  if (!tab?.id) return false;
  const snap = { ...tab };
  stopCompactPlayback();
  stopDubPlayback();
  await Promise.all([interpretController.stop(snap.id), compactController.stop(snap.id)]);
  const videoId = videoIdentity(snap.url);
  if (!videoId) return false;
  await clearVideoDubCache(videoId);
  await deleteMediaArchive(videoId);
  const pack = typeof packForMediaWrite === "function" ? packForMediaWrite(snap.id) : state.pack;
  if (pack) pack.archive = null;
  compactSegments = [];
  compactGenerationComplete = false;
  compactGenerationMessage = "已清除当前视频的翻译与配音缓存，其他视频不受影响。";
  $("compact-player-bar")?.classList.remove("hidden");
  renderCompactPlayer();
  renderContext();
  return true;
}

async function regenerateCurrentDubbing() {
  if (await clearCurrentDubbingCache()) await generateFullCompactAudio();
}

async function generateFullCompactAudio() {
  if (compactFullGenerating) { stopCompactPlayback(); return; }
  const source = (typeof mediaActionTab === "function" ? mediaActionTab() : state.tab);
  if (compactActionPending || !source?.id) return;
  compactActionPending = true;
  const tab = { ...source };
  try {
    stopCompactPlayback();
    const revision = compactRevision;
    stopDubPlayback();
    await Promise.all([interpretController.stop(tab.id), compactController.stop(tab.id)]);
    if (revision !== compactRevision) return;
    if (typeof bindMediaSource === "function") bindMediaSource(tab, state.mediaPack || (state.tab?.id === tab.id ? state.pack : null));
    const archive = await loadFullMediaArchive(videoIdentity(tab.url));
    if (revision !== compactRevision) return;
    compactSessionOpen = true;
    $("compact-player-bar")?.classList.remove("hidden");
    if (archive?.complete && archive.compactAudioBlob) {
      const pack = typeof packForMediaWrite === "function" ? packForMediaWrite(tab.id) : (state.pack ||= {});
      if (pack) pack.archive = archive;
      compactGenerationMessage = "已复用完整音频，无需重新翻译或合成；可直接播放或下载。";
      renderCompactPlayer();
      return;
    }
    if (!requireModel("text")) { pushError(needModelMessage("text")); return; }
    if (!isTtsReady(state.settings.tts)) { pushError("请先配置语音合成（TTS）"); return; }
    compactSegments = [];
    compactGenerationComplete = false;
    compactFullGenerating = true;
    compactGenerationMessage = "正在准备整段音频，不需要保持播放；请保持侧栏开启。";
    renderCompactPlayer();
    void compactController.start({ tab, settings: state.settings, generateFull: true }).catch(err => {
      if (revision !== compactRevision) return;
      compactFullGenerating = false;
      compactGenerationMessage = "完整生成失败：" + err.message;
      renderCompactPlayer();
    });
  } finally { compactActionPending = false; }
}

function stopDubPlayback() {
  if (dubPlayerTimer) {
    clearInterval(dubPlayerTimer);
    dubPlayerTimer = null;
  }
  if (dubPlayerAudio) {
    try {
      dubPlayerAudio.pause();
      dubPlayerAudio.src = "";
    } catch { /* ignore */ }
    dubPlayerAudio = null;
  }
  if (dubPlayerBlobUrl) {
    const u = dubPlayerBlobUrl;
    setTimeout(() => { try { URL.revokeObjectURL(u); } catch {} }, 2000);
    dubPlayerBlobUrl = null;
  }
  state.dubPlaying = false;
  const restoreId = state.mediaTab?.id || state.tab?.id;
  if (restoreId) {
    injectVideo(restoreId, "restore").catch(() => {});
  }
  renderTranscribeAction();
}

async function toggleDubPlayback() {
  const dubTab = (typeof mediaActionTab === "function" ? mediaActionTab() : state.tab);
  stopCompactPlayback();
  await compactController.stop(dubTab?.id);
  const archive = ((typeof packForMedia === "function" && packForMedia()) || state.pack)?.archive;
  if (!archive?.audioBlob) return;
  if (state.dubPlaying) {
    stopDubPlayback();
    return;
  }

  const tabId = dubTab?.id;
  if (!tabId) return;

  try {
    const buf = await archive.audioBlob.slice(0, 16).arrayBuffer();
    if (!buf || buf.byteLength === 0) throw new Error('Unreadable blob');
  } catch {
    console.warn('[dub-player] Archive audioBlob unreadable, dropping');
    if (state.pack?.archive) state.pack.archive.audioBlob = null;
    return;
  }

  try {
    if (dubPlayerBlobUrl) {
      const u = dubPlayerBlobUrl;
      setTimeout(() => { try { URL.revokeObjectURL(u); } catch {} }, 2000);
      dubPlayerBlobUrl = null;
    }
    dubPlayerBlobUrl = URL.createObjectURL(archive.audioBlob);
    dubPlayerAudio = new Audio(dubPlayerBlobUrl);
    state.dubPlaying = true;
    renderTranscribeAction();

    await injectVideo(tabId, "silence");
    const st = await injectVideo(tabId, "state");
    const startTime = Number(st?.currentTime) || 0;
    dubPlayerAudio.currentTime = startTime;

    if (st?.ok && !st.paused) {
      dubPlayerAudio.play().catch(() => {});
    }

    dubPlayerAudio.onended = () => {
      stopDubPlayback();
    };

    if (dubPlayerTimer) clearInterval(dubPlayerTimer);
    dubPlayerTimer = setInterval(async () => {
      if (!state.dubPlaying || !dubPlayerAudio) {
        if (dubPlayerTimer) clearInterval(dubPlayerTimer);
        dubPlayerTimer = null;
        return;
      }
      try {
        const liveSt = await injectVideo(tabId, "state");
        if (!liveSt?.ok) {
          stopDubPlayback();
          return;
        }
        if (liveSt.paused && !dubPlayerAudio.paused) {
          dubPlayerAudio.pause();
        } else if (!liveSt.paused && dubPlayerAudio.paused) {
          dubPlayerAudio.play().catch(() => {});
        }
        const delta = Math.abs(dubPlayerAudio.currentTime - (Number(liveSt.currentTime) || 0));
        if (delta > 0.4) {
          dubPlayerAudio.currentTime = Number(liveSt.currentTime) || 0;
        }
      } catch {
        stopDubPlayback();
      }
    }, 500);

  } catch (err) {
    stopDubPlayback();
    pushError("播放配音失败：" + (err?.message || err));
  }
}


function modelLineMetaEl() {
  return $("model-line-meta") || $("model-line");
}

function setModelLineMeta(text) {
  const el = modelLineMetaEl();
  if (el) el.textContent = text || "";
}

function modelExtras() {
  const mm = resolveModel(state.settings, "multimodal");
  const same = state.settings.multimodalSameAsText;
  const m = isModelReady(mm) ? mm.model : "未配多模态";
  const asr = isAsrReady(state.settings.asr) ? ` · ASR ${state.settings.asr.model || "自建"}` : "";
  const tts = isTtsReady(state.settings.tts) ? " · TTS" : "";
  const lib = state.library?.granted ? ` · 文稿夹 ${state.library.name}` : "";
  const sk = skillsOn()
    ? ` · Skills${state.skillsMetaReady ? ` ${state.skills.length}` : ""}`
    : "";
  const sh = state.settings.nativeShell !== false && state.nativeHost?.ok ? " · Shell" : "";
  const mmBit = same ? "多模态同文本" : `多模态 ${m}`;
  return `${mmBit}${asr}${tts}${lib}${sk}${sh}`;
}

function modelSummary() {
  const text = resolveModel(state.settings, "text");
  if (!isModelReady(text)) return `未配置文本模型 · 先到设置添加服务商 · ${modelExtras()}`;
  return `${modelExtras()}`;
}

function skillsOn() {
  return isSkillsEnabled(state.settings);
}

function renderModelLine() {
  const pick = $("text-model-pick");
  const options = enabledModelOptions(state.settings.textProviders);
  const ref = state.settings.textRef;
  if (pick) {
    const groups = new Map();
    for (const opt of options) {
      const list = groups.get(opt.providerName) || [];
      list.push(opt);
      groups.set(opt.providerName, list);
    }
    pick.innerHTML = [...groups.entries()].map(([name, items]) => (
      `<optgroup label="${escapeAttr(name)}">${items.map((item) => {
        const value = `${item.providerId}::${item.modelId}`;
        const selected = ref?.providerId === item.providerId && ref?.modelId === item.modelId ? " selected" : "";
        return `<option value="${escapeAttr(value)}"${selected}>${escapeAttr(item.modelId)}</option>`;
      }).join("")}</optgroup>`
    )).join("");
    pick.classList.toggle("hidden", !options.length);
    pick.value = ref ? `${ref.providerId}::${ref.modelId}` : "";
  }
  setModelLineMeta(modelSummary());
}

function syncComposerHints() {
  const input = $("input");
  if (input) {
    if (!state.share && !state.chatRef) {
      input.placeholder = skillsOn()
        ? "直接交代任务 · / 选 skill · Enter 发送"
        : "直接交代任务，不带当前网页 · Enter 发送";
    } else {
      input.placeholder = skillsOn()
        ? "问这页 · / 选 skill · Enter 发送 · ⇧Enter 换行"
        : "问这页 · Enter 发送 · ⇧Enter 换行";
    }
  }
}

function syncSkillFolderControls() {
  $("block-skill-folder")?.classList.toggle("skills-off", !skillsOn());
  syncComposerHints();
}

function readUiPref(key, fallback) {
  try {
    const value = localStorage.getItem(`pagelens.${key}`);
    if (value === "1") return true;
    if (value === "0") return false;
  } catch { /* ignore */ }
  return fallback;
}

function writeUiPref(key, value) {
  try { localStorage.setItem(`pagelens.${key}`, value ? "1" : "0"); } catch { /* ignore */ }
}

function setSendButton(stopping) {
  const btn = $("btn-send");
  if (!btn) return;
  if (stopping) {
    btn.textContent = "■";
    btn.setAttribute("data-tooltip", "停止");
    btn.setAttribute("aria-label", "停止");
    return;
  }
  btn.innerHTML = '<svg class="ico" viewBox="0 0 24 24"><use href="#i-up"/></svg>';
  btn.setAttribute("data-tooltip", "发送");
  btn.setAttribute("aria-label", "发送");
}

function currentMediaTitle() {
  if (state.mediaTab) {
    return state.mediaPack?.title || state.mediaTab.title || "当前视频";
  }
  if (state.pack?.video || state.pack?.videoIsPrimary) {
    return state.pack?.title || state.tab?.title || "当前视频";
  }
  const running = interpretController.getRunningTasks?.() || [];
  return running[0]?.title || state.tab?.title || "尚未选择视频";
}

function mediaShouldShow() {
  const videoCount = Number(state.pack?.videoCount) || (Array.isArray(state.pack?.videos) ? state.pack.videos.length : 0);
  const hasPlayer = Boolean(state.pack?.video) || videoCount > 0 || isVideoUrl(state.tab?.url) || Boolean(state.mediaTab);
  const running = interpretController.getRunningTasks?.() || [];
  const compact = Boolean(compactSessionOpen || compactPlaying || compactPendingAutoplay);
  return hasPlayer || running.length > 0 || compact || Boolean(state.videoSummary) || isMediaPlaybackActive();
}

function applyMediaLayout() {
  const zone = $("media-zone");
  const body = $("media-body");
  const toggle = $("btn-media-toggle");
  if (!zone) return;
  const show = mediaShouldShow();
  zone.classList.toggle("hidden", !show);
  zone.classList.toggle("collapsed", !state.mediaExpanded);
  if (body) body.classList.toggle("hidden", !state.mediaExpanded);
  $("media-collapsed-title")?.classList.toggle("hidden", state.mediaExpanded);
  $("btn-media-mini-pause")?.classList.toggle("hidden", state.mediaExpanded || !show);
  $("media-tools")?.classList.toggle("hidden", !state.toolsExpanded);
  $("media-tasks")?.classList.toggle("hidden", !state.tasksExpanded);
  if (toggle) {
    toggle.setAttribute("aria-expanded", String(state.mediaExpanded));
    const label = state.mediaExpanded ? "收起音视频工具" : "展开音视频工具";
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("data-tooltip", label);
    toggle.removeAttribute("title");
  }
  const ico = $("media-toggle-ico");
  if (ico) ico.innerHTML = `<use href="${state.mediaExpanded ? "#i-chevron-up" : "#i-chevron"}"/>`;
  const toolsBtn = $("btn-media-tools");
  if (toolsBtn) {
    toolsBtn.setAttribute("aria-expanded", String(state.toolsExpanded));
    toolsBtn.innerHTML = `${state.toolsExpanded ? "收起工具" : "文稿与工具"} <svg class="ico tiny"><use href="${state.toolsExpanded ? "#i-chevron-up" : "#i-chevron"}"/></svg>`;
  }
  $("btn-tasks-toggle")?.setAttribute("aria-expanded", String(state.tasksExpanded));
  const bar = $("compact-player-bar");
  if (bar && mediaShouldShow() && state.mediaExpanded) bar.classList.remove("hidden");
}

function paintVideoSummary() {
  const box = $("video-summary-result");
  const summary = state.videoSummary;
  if (!box) return;
  box.classList.toggle("hidden", !summary);
  if (!summary) return;
  if ($("video-summary-source")) $("video-summary-source").textContent = summary.title ? `来源：${summary.title}` : "";
  if ($("video-summary-body")) $("video-summary-body").textContent = summary.text || "";
  const metrics = summary.metrics;
  if ($("video-summary-usage")) {
    if (metrics) {
      const total = (Number(metrics.inputTokens) || 0) + (Number(metrics.outputTokens) || 0);
      $("video-summary-usage").textContent = `${formatTokenCount(total)} Tokens · ${formatDuration(metrics.durationMs)} · 估算`;
    } else {
      $("video-summary-usage").textContent = summary.error ? "失败" : "生成中…";
    }
  }
  if ($("video-summary-usage-detail")) {
    $("video-summary-usage-detail").textContent = metrics
      ? `输入 ${formatTokenCount(metrics.inputTokens)} · 输出 ${formatTokenCount(metrics.outputTokens)}（本地估算，非服务端用量）`
      : "";
  }
}

function setChipAction(el, label, tooltip) {
  if (!el) return;
  el.textContent = label;
  el.classList.remove("hidden");
  el.setAttribute("aria-label", tooltip);
  el.setAttribute("data-tooltip", tooltip);
}

function renderComposerChip() {
  const label = $("compose-chip-label");
  const chip = $("compose-chip");
  const clear = $("btn-clear-ref");
  const note = $("compose-note");
  const follow = $("chat-follow");
  const input = $("input");
  const ref = state.chatRef;
  const pageTitle = state.pack?.title || state.tab?.title || "当前网页";
  chip?.classList.toggle("is-ref", Boolean(ref));
  chip?.classList.toggle("is-off", !ref && !state.share);
  if (ref) {
    const kind = ref.kind === "summary" ? "摘要" : "文稿";
    if (label) label.textContent = `已引用：${ref.title} · ${kind}`;
    setChipAction(clear, "×", "移除引用");
    if (note) note.textContent = "视频引用";
    if (follow) follow.textContent = "主动引用优先于当前网页";
    if (input && !input.value) input.placeholder = "针对已引用的视频内容提问…";
    return;
  }
  if (state.share) {
    if (label) label.textContent = `当前网页：${pageTitle}`;
    setChipAction(clear, "×", "去掉网页上下文");
    if (note) note.textContent = "当前网页";
    if (follow) follow.textContent = "跟随当前标签页";
  } else {
    if (label) label.textContent = "未带网页";
    setChipAction(clear, "带上", "带上当前网页");
    if (note) note.textContent = "不使用网页";
    if (follow) follow.textContent = "已去掉网页，切到其他页会再带上";
  }
  if (input) syncComposerHints();
}

function citeTranscript() {
  const text = state.pack?.captionsText;
  if (!text) {
    pushError("还没有可引用的文稿。先点「只要文稿」，或等同传出字幕。");
    return;
  }
  const title = currentMediaTitle();
  state.chatRef = {
    kind: "transcript",
    title,
    context: `【主动引用视频文稿】标题：${title}\nURL：${state.pack?.url || state.tab?.url || ""}\n\n${text.slice(0, 12000)}`,
  };
  setView("chat");
  renderComposerChip();
  $("input")?.focus();
  if ($("media-note")) $("media-note").textContent = `已引用「${title}」文稿，移除后恢复跟随网页`;
}

function citeVideoSummary() {
  const summary = state.videoSummary;
  if (!summary?.text || summary.text === "正在阅读完整文稿…") return;
  state.chatRef = {
    kind: "summary",
    title: summary.title || "视频摘要",
    context: `【主动引用视频摘要】标题：${summary.title || ""}\n\n${summary.text}`,
  };
  setView("chat");
  renderComposerChip();
  $("input")?.focus();
}

function clearChatRef() {
  state.chatRef = null;
  renderComposerChip();
  if ($("media-note")) $("media-note").textContent = "已移除引用，下次提问跟随当前网页";
}

function dismissPageContext() {
  state.share = false;
  state.dismissedPage = snapshotTab(state.tab);
  state.pack = null;
  $("recall-banner")?.classList.add("hidden");
  renderContext();
  renderComposerChip();
  renderSkills();
}

async function restorePageContext() {
  state.share = true;
  state.dismissedPage = null;
  renderComposerChip();
  if (typeof refreshTab === "function") await refreshTab();
  else {
    renderContext();
    renderSkills();
  }
}

function onComposerChipAction() {
  if (state.chatRef) {
    clearChatRef();
    return;
  }
  if (state.share) dismissPageContext();
  else restorePageContext();
}

function renderMediaChrome() {
  applyMediaLayout();
  paintVideoSummary();
  renderComposerChip();
  const title = currentMediaTitle();
  if ($("media-active-title")) {
    $("media-active-title").textContent = title;
    $("media-active-title").title = title;
  }
  if ($("media-collapsed-title")) {
    $("media-collapsed-title").textContent = title;
    $("media-collapsed-title").title = title;
  }
  const mediaId = state.mediaTab?.id || state.tab?.id;
  const interpreting = interpretController.isRunning(mediaId);
  const compactActive = Boolean(compactPlaying || compactPendingAutoplay);
  const running = interpretController.getRunningTasks?.() || [];
  const status = interpreting ? "同传中" : compactPendingAutoplay ? "纯享准备中" : compactPlaying ? "纯享播放中" : running.length ? "后台处理中" : "就绪";
  if ($("media-status-label")) $("media-status-label").textContent = status;
  if ($("media-heading")) {
    $("media-heading").textContent = state.mediaExpanded
      ? "音视频工具"
      : `${Math.max(running.length, mediaShouldShow() ? 1 : 0)} 个视频 · ${Math.max(0, running.filter((t) => t.tabId !== mediaId).length)} 个后台`;
  }
  $("btn-interpret")?.setAttribute("aria-pressed", String(interpreting || !compactActive));
  $("btn-compact-player")?.setAttribute("aria-pressed", String(compactActive));
  const count = running.length || (mediaShouldShow() ? 1 : 0);
  if ($("task-count")) $("task-count").textContent = String(count);
  if ($("media-task-heading")) {
    $("media-task-heading").textContent = running.length
      ? `播放 ${interpreting || compactActive ? 1 : 0} 个 · 后台 ${Math.max(0, running.length - (interpreting ? 1 : 0))} 个`
      : "没有后台任务";
  }
  const usage = $("media-usage");
  if (usage) {
    const summary = state.videoSummary?.metrics;
    if (summary) {
      const total = (Number(summary.inputTokens) || 0) + (Number(summary.outputTokens) || 0);
      usage.textContent = `${formatTokenCount(total)} Tokens · ${formatDuration(summary.durationMs)}（估算）`;
    }
  }
}

async function startSummarizePage() {
  if (!state.share) await restorePageContext();
  const title = state.pack?.title || state.tab?.title || "本页";
  const prompt = state.pack?.kind === "pdf"
    ? `总结这份 PDF「${title}」的核心观点和结构。`
    : `总结这篇文章，给我三个要点。`;
  await sendPrompt(prompt);
}

async function backToVideoTab() {
  const running = interpretController.getRunningTasks?.() || [];
  const id = state.mediaTab?.id || (state.pack?.video || state.pack?.videoIsPrimary ? state.tab?.id : null) || running[0]?.tabId || state.tab?.id;
  if (!id || typeof chrome === "undefined" || !chrome.tabs?.update) return;
  try { await chrome.tabs.update(id, { active: true }); } catch { /* ignore */ }
}

function toggleMiniPlayback() {
  if (compactPlaying || compactPendingAutoplay || compactSessionOpen) {
    void toggleCompactPlayback();
    return;
  }
  const mediaId = state.mediaTab?.id || state.tab?.id;
  if (interpretController.isRunning(mediaId)) {
    void interpretController.stop(mediaId);
    return;
  }
  getSharedAudioContext();
  startInterpret();
}

async function toggleVideoPicker() {
  const box = $("media-task-picker");
  const list = $("media-task-picker-list");
  if (!box || !list) return;
  const opening = box.classList.contains("hidden");
  box.classList.toggle("hidden", !opening);
  if (!opening) return;
  list.textContent = "正在查找已打开的视频…";
  if (typeof chrome === "undefined" || !chrome.tabs?.query) {
    list.textContent = "当前环境无法读取标签页。";
    return;
  }
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const videos = (tabs || []).filter((tab) => tab.url && /youtube\.com|youtu\.be|bilibili\.com|vimeo\.com/.test(tab.url));
  list.innerHTML = "";
  if (!videos.length) {
    list.textContent = "没有发现已打开的视频页。";
    return;
  }
  for (const tab of videos) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "task-pick-item";
    btn.innerHTML = `<span></span><span>后台准备</span>`;
    btn.firstChild.textContent = tab.title || tab.url;
    btn.addEventListener("click", () => startBackgroundInterpret(tab));
    list.appendChild(btn);
  }
}

async function startBackgroundInterpret(tab) {
  if (!isAsrReady(state.settings.asr)) {
    needAsrSettings("后台准备需要先配置语音转写（ASR）");
    return;
  }
  if (!requireModel("text")) {
    pushError(needModelMessage("text"));
    return;
  }
  try {
    await interpretController.start({
      tab,
      settings: state.settings,
      onCaptionsReady: (captions) => {
        applyCaptions({ ...captions, tabId: captions.tabId ?? tab.id });
      },
    });
    $("media-task-picker")?.classList.add("hidden");
    if ($("media-note")) $("media-note").textContent = `已添加后台任务：${tab.title || ""}（需源视频保持打开）`;
    renderContext();
  } catch (err) {
    pushError("无法添加任务：" + (err?.message || err));
  }
}

function formatStatusError(err) {
  if (!err) return "";
  const msg = typeof err === "string" ? err : (err.message || String(err));
  if (/JSON|position \d+|column \d+|SyntaxError/i.test(msg)) {
    return "口播稿格式异常";
  }
  if (/fetch|network|timeout|Failed to fetch|Load failed/i.test(msg)) {
    return "网络连接异常";
  }
  if (/quota|rate limit|429/i.test(msg)) {
    return "模型配额不足或请求受限";
  }
  return msg;
}

function renderContext() {
  const tab = state.tab;
  $("btn-unpin")?.classList.toggle("hidden", !state.share);
  $("btn-pin-page")?.classList.toggle("hidden", Boolean(state.share));
  if (!tab || !state.share) {
    $("ctx-label").textContent = "未带网页";
    $("ctx-title").textContent = tab?.title || "当前页";
    $("ctx-sub").textContent = "对话不使用此页，可直接交代任务。切换到其他网页后会自动带上。";
    if ($("ctx-source-hint")) $("ctx-source-hint").textContent = "";
    renderTranscribeAction();
    renderComposerChip();
    return;
  }
  const video = state.pack?.videoIsPrimary && state.pack?.video;
  $("ctx-label").textContent = video
    ? "正在观看"
    : state.pack?.kind === "x"
      ? "正在看帖"
      : state.pack?.kind === "pdf"
        ? "正在读 PDF"
        : "正在阅读";
  $("ctx-title").textContent = tab.title || "无标题";
  const bits = [hostOf(tab.url)];
  if (state.pack?.kind === "x") bits.push("已提取帖子");
  if (state.pack?.kind === "pdf") {
    bits.push("已提取 PDF");
    if (state.pack.pdfPages) bits.push(`${state.pack.pdfPages} 页`);
  } else if (state.pack?.pdfError) {
    bits.push("PDF 未抽出");
  }
  if (state.pack?.text) bits.push(`${state.pack.text.length} 字`);
  if (video) {
    bits.push(formatTime(video.duration));
    const src = state.pack?.captionsSource;
    if (state.pack?.captionsStatus === "ready") {
      bits.push(src === "subtitles" ? "含完整字幕" : "已转写");
    } else {
      bits.push("尚未转写");
    }
    const tr = state.transcribe;
    const si = state.interpret;
    if (si?.status === "running") {
      bits.push("同传中（按声音）");
      if (si.hint) bits.push(si.hint);
    } else {
      bits.push("同传按声音切句");
    }
    if (tr?.status === "recording") {
      bits.push(`提取中 ${formatTime(tr.currentTime || 0)}/${formatTime(tr.duration || video.duration || 0)}`);
      if (tr.hint) bits.push(tr.hint);
    }
    if (tr?.status === "extracting" || tr?.status === "uploading") bits.push(tr.hint || "正在识别完整音轨");
    if (tr?.status === "error" && tr.error) bits.push(formatStatusError(tr.error));
    if (si?.status === "error" && si.error) bits.push(formatStatusError(si.error));
    if ((src === "asr-full" || src === "asr" || src === "asr-cache" || src === "interpret" || src === "subtitles" || src === "subtitles-full") && (!tr || tr.status === "done" || tr.status === "idle")) {
      bits.push("可以直接问总结或章节");
    }
    const n = Number(state.pack?.videoCount) || (Array.isArray(state.pack?.videos) ? state.pack.videos.length : 0);
    if (n > 1) {
      const idx = Number.isInteger(state.pack?.videoIndex) ? state.pack.videoIndex + 1 : 1;
      bits.push(`画面 ${idx}/${n}`);
    }
  }
  $("ctx-sub").textContent = bits.filter(Boolean).join(" · ");
  if ($("ctx-source-hint")) $("ctx-source-hint").textContent = "本次总结与提问的来源";
  renderTranscribeAction();
  renderComposerChip();
}

const isTranscribing = () => ["extracting", "recording", "uploading"].includes(state.transcribe?.status);

function renderTranscribeAction() {
  const actions = $("ctx-actions");
  const btn = $("btn-transcribe");
  const sum = $("btn-summarize-video");
  const siBtn = $("btn-interpret");
  const audioBtn = $("btn-original-audio");
  const bar = $("btn-summarize-bar");
  const siBar = $("btn-interpret-bar");
  const sw = $("btn-video-switch");
  const live = $("si-live");
  const tr = state.transcribe;
  const recording = isTranscribing();
  const mediaId = state.mediaTab?.id || state.tab?.id;
  const mediaPack = (typeof packForMedia === "function" && packForMedia()) || state.pack;
  const interpreting = interpretController.isRunning(mediaId);
  const si = interpretController.getState(mediaId);
  const asrCaps = ["asr-full", "asr", "asr-cache", "interpret", "subtitles", "subtitles-full"].includes(mediaPack?.captionsSource);
  const capsReady = mediaPack?.captionsStatus === "ready";
  const canShare = Boolean(state.share && state.tab);
  const videoCount = Number(state.pack?.videoCount) || (Array.isArray(state.pack?.videos) ? state.pack.videos.length : 0);
  const hasPlayer = Boolean(state.pack?.video) || videoCount > 0 || interpreting || Boolean(state.mediaTab);
  if (actions) actions.classList.toggle("hidden", !canShare && !recording && !interpreting && !hasPlayer);
  const draftLabel = recording ? "停止" : asrCaps ? "重新取文稿" : "只要文稿";
  if (btn) {
    btn.textContent = draftLabel;
    btn.classList.toggle("busy", Boolean(recording));
    btn.disabled = !hasPlayer && !canShare && !recording;
  }
  if (sum) {
    sum.innerHTML = recording
      ? "提取中…"
      : '<svg class="ico"><use href="#i-spark"/></svg>一键总结视频';
    sum.disabled = recording || state.busy || (!hasPlayer && !canShare);
  }
  const pageSum = $("btn-summarize-page");
  if (pageSum) pageSum.disabled = state.busy || !state.tab;
  $("btn-generate-full")?.classList.toggle("hidden", !hasPlayer);
  $("btn-clear-dub-cache")?.classList.toggle("hidden", !hasPlayer);
  if (siBtn) {
    siBtn.innerHTML = interpreting
      ? "停止同传"
      : '<svg class="ico"><use href="#i-lang"/></svg>同声传译';
    siBtn.title = interpreting ? "停止同传" : "按声音识别并翻译，可与一键总结同时进行。";
    siBtn.classList.toggle("busy", Boolean(interpreting));
    siBtn.disabled = !hasPlayer && !canShare && !interpreting;
  }
  const compactBtn = $("btn-compact-player");
  const compactBarBtn = $("btn-compact-bar");
  const hasCompact = Boolean(mediaPack?.archive?.hasCompactAudio || mediaPack?.archive?.hasAudio || state.pack?.archive?.hasCompactAudio || state.pack?.archive?.hasAudio);
  const isPendingAuto = typeof compactPendingAutoplay !== 'undefined' ? compactPendingAutoplay : false;
  const isCompactPlaying = typeof compactPlaying !== 'undefined' ? compactPlaying : false;
  const isCompactActive = isCompactPlaying || isPendingAuto;
  if (compactBtn) {
    compactBtn.classList.toggle("hidden", !hasPlayer && !(typeof mediaShouldShow === "function" && mediaShouldShow()));
    if (isCompactActive) {
      compactBtn.textContent = isPendingAuto ? "取消准备" : "⏸ 暂停纯享";
      compactBtn.classList.add("busy");
    } else if (compactStreamPlayer || compactPlayerAudio) {
      compactBtn.innerHTML = '<svg class="ico"><use href="#i-play"/></svg>继续纯享';
      compactBtn.title = "从暂停位置继续播放";
      compactBtn.classList.remove("busy");
    } else if (hasCompact) {
      compactBtn.innerHTML = '<svg class="ico"><use href="#i-headphone"/></svg>纯享音频';
      compactBtn.title = "无缝连续播放中文配音（像听播客一样，无原视频静音等待）";
      compactBtn.classList.remove("busy");
    } else if (interpreting) {
      compactBtn.innerHTML = '<svg class="ico"><use href="#i-headphone"/></svg>开启纯享';
      compactBtn.title = "切换到纯享音频，暂停视频并连续收听中文配音";
      compactBtn.classList.remove("busy");
    } else {
      compactBtn.innerHTML = '<svg class="ico"><use href="#i-headphone"/></svg>纯享音频';
      compactBtn.title = "独立生成并连续收听中文配音";
      compactBtn.classList.remove("busy");
    }
  }
  if (compactBarBtn) {
    compactBarBtn.classList.toggle("busy", Boolean(isCompactActive));
  }
  const archiveBtn = $("btn-play-archive");
  const regenBtn = $("btn-regen-dub");
  const hasArchive = Boolean(mediaPack?.archive?.hasAudio || state.pack?.archive?.hasAudio);
  if (archiveBtn) {
    archiveBtn.classList.toggle("hidden", !hasArchive || (!canShare && !state.dubPlaying));
    if (hasArchive) {
      const days = mediaPack?.archive?.remainingDays ?? state.pack?.archive?.remainingDays ?? 7;
      archiveBtn.textContent = state.dubPlaying ? "停止对齐" : `对齐配音 (剩${days}天)`;
      archiveBtn.title = `与原视频画面时间轴对齐播放配音 (剩余${days}天)`;
      archiveBtn.classList.toggle("busy", Boolean(state.dubPlaying));
    }
  }
  if (regenBtn) {
    regenBtn.classList.toggle("hidden", !hasPlayer || (!hasCompact && !hasArchive));
    regenBtn.disabled = Boolean(interpreting);
  }
  if (bar) {
    bar.textContent = recording ? "■" : "总";
    bar.title = recording ? "停止提取" : "一键总结";
    bar.classList.toggle("busy", Boolean(recording));
    bar.disabled = state.busy && !recording;
  }
  if (siBar) {
    siBar.textContent = interpreting ? "■" : "译";
    siBar.title = interpreting ? "停止同传" : "同声传译";
    siBar.classList.toggle("busy", Boolean(interpreting));
    siBar.disabled = !canShare && !interpreting;
  }
  if (audioBtn) {
    const on = state.originalAudioOn !== false;
    audioBtn.classList.toggle("hidden", (!hasPlayer && !(typeof mediaShouldShow === "function" && mediaShouldShow())) || (!canShare && !interpreting));
    audioBtn.innerHTML = on
      ? '<svg class="ico"><use href="#i-volume"/></svg>原音：开'
      : '<svg class="ico"><use href="#i-mute"/></svg>原音：关';
    audioBtn.title = on ? "关闭原视频声音" : "开启原视频声音";
    audioBtn.setAttribute?.("aria-pressed", String(on));
    audioBtn.classList.toggle("busy", !on);
    audioBtn.disabled = !mediaId;
  }
  if (sw) {
    const idx = Number.isInteger(state.pack?.videoIndex) ? state.pack.videoIndex : 0;
    sw.classList.toggle("hidden", videoCount < 2);
    sw.textContent = videoCount > 1 ? `画面 ${idx + 1}/${videoCount}` : "画面";
    sw.disabled = recording || interpreting;
  }

  const bgTasksEl = $("ctx-bg-tasks");
  if (bgTasksEl) {
    const runningTasks = interpretController.getRunningTasks();
    const otherTasks = runningTasks.filter((t) => t.tabId !== mediaId);
    bgTasksEl.classList.toggle("hidden", otherTasks.length === 0);
    bgTasksEl.innerHTML = "";
    for (const t of otherTasks) {
      const row = document.createElement("div");
      row.className = "bg-task-item";
      const tag = document.createElement("span");
      tag.className = "bg-task-tag";
      tag.textContent = "后台同传中";
      const title = document.createElement("span");
      title.className = "bg-task-title";
      title.textContent = t.title || "标签页 " + t.tabId;
      title.title = t.title || t.url || "";
      const switchBtn = document.createElement("button");
      switchBtn.type = "button";
      switchBtn.className = "bg-task-btn";
      switchBtn.textContent = "切到该页";
      switchBtn.onclick = () => {
        if (typeof chrome !== "undefined" && chrome.tabs?.update) {
          chrome.tabs.update(t.tabId, { active: true }).catch(() => {});
        }
      };
      const stopBtn = document.createElement("button");
      stopBtn.type = "button";
      stopBtn.className = "bg-task-btn danger";
      stopBtn.textContent = "停止";
      stopBtn.onclick = () => {
        interpretController.stop(t.tabId).catch(() => {});
      };
      row.append(tag, title, switchBtn, stopBtn);
      bgTasksEl.appendChild(row);
    }
  }

  if (live) {
    live.classList.toggle("hidden", !interpreting && !si?.zh);
    if (si?.zh) $("si-zh").textContent = si.zh;
    if (si?.src) $("si-src").textContent = (si.speaker && !/^(asr|unassigned):/.test(si.speaker) ? `${si.speaker.replace(/^SPEAKER_(\d+)$/, (_, n) => '说话人 ' + (Number(n) + 1))} · ` : '') + si.src;
    const edit = $('btn-si-edit');
    if (edit) {
      edit.classList.toggle('hidden', !interpreting || !si?.lineId);
      edit.onclick = async () => {
        const text = window.prompt('修改本句中文口播稿（只重新生成这一句配音）', si.zh);
        if (text === null) return;
        try { await interpretController.editCurrentLine(si.tabId, text); }
        catch (error) { window.alert(error.message); }
      };
    }
    if (interpreting && !si?.zh) {
      $("si-zh").textContent = si?.message || "同传已开始…";
      $("si-src").textContent = si?.hint || "";
    }
  }
  if (typeof renderMediaChrome === "function") renderMediaChrome();
}

function applyUiFont(size) {
  const next = ["md", "lg", "xl"].includes(size) ? size : "md";
  document.documentElement.dataset.font = next;
}

function fitInput() {
  const el = $("input");
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(160, Math.max(38, el.scrollHeight))}px`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function renderSkills() {
  const el = $("skills");
  if (!el) {
    console.warn("[pagelens] wire missing", "skills");
    return;
  }
  el.innerHTML = "";
  visibleSkills(state.settings).forEach((skill) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = skill.label;
    if (skill.custom) btn.classList.add("custom");
    btn.addEventListener("click", () => {
      runSkill(skill).catch((err) => {
        console.error("[pagelens] chip failed", err);
        pushError("发送失败：" + (err.message || err));
      });
    });
    el.appendChild(btn);
  });
  const add = document.createElement("button");
  add.type = "button";
  add.className = "add-shortcut";
  add.title = "添加快捷问题";
  add.textContent = "+";
  add.addEventListener("click", () => openShortcutSettings());
  el.appendChild(add);
}

function formatTokenCount(num) {
  const n = Math.max(0, Number(num) || 0);
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function formatDuration(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

function isMetaTrace(item) {
  return item?.kind === "meta" || ["思考", "压缩上下文", "从中断处继续"].includes(item?.name);
}

function truncateToolText(text, max = 80) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function toolArgHint(item) {
  const args = item?.args || {};
  if (item?.name === "run_shell" && args.command) return truncateToolText(args.command, 88);
  if (args.url) return truncateToolText(args.url, 72);
  if (args.selector) return truncateToolText(args.selector, 56);
  if (args.path) return truncateToolText(args.path, 56);
  if (args.handle) return String(args.handle);
  if (args.query) return truncateToolText(args.query, 48);
  if (args.code) return truncateToolText(args.code, 56);
  return "";
}

function hasToolArgs(args) {
  return Boolean(args && typeof args === "object" && Object.keys(args).length);
}

function formatToolArgs(name, args) {
  if (!hasToolArgs(args)) return "（无输入）";
  if (name === "run_shell") {
    return [
      args.command || "",
      args.cwd ? `cwd: ${args.cwd}` : "",
      args.timeoutMs ? `timeout: ${args.timeoutMs}ms` : "",
    ].filter(Boolean).join("\n") || "（无输入）";
  }
  try {
    return JSON.stringify(args, (_k, v) => (
      typeof v === "string" && v.length > 1200 ? `${v.slice(0, 1200)}…` : v
    ), 2);
  } catch {
    return String(args);
  }
}

function pickToolArgs(ev, fallback) {
  return hasToolArgs(ev?.args) ? ev.args : (hasToolArgs(fallback) ? fallback : {});
}

function toolStatusLabel(item) {
  if (item.status === "running") return "进行中";
  if (item.ok === false || item.status === "fail") {
    return /拦截/.test(String(item.preview || "")) ? "已拦截" : "失败";
  }
  const dur = Number(item.durationMs);
  const time = Number.isFinite(dur) && dur > 0 ? formatDuration(dur) : "";
  if (item.archived) return time ? `已归档 · ${time}` : "已归档";
  return time || "完成";
}

function pushTraceItem(botMsg, item) {
  if (!botMsg.trace) botMsg.trace = [];
  botMsg._traceSeq = (botMsg._traceSeq || 0) + 1;
  botMsg.trace.push({ id: String(botMsg._traceSeq), ...item });
}

function finishTraceTool(botMsg, ev) {
  const running = [...(botMsg.trace || [])].reverse().find((t) => t.name === ev.name && t.status === "running");
  const next = {
    kind: "tool",
    name: ev.name,
    ok: ev.ok,
    status: ev.ok ? "ok" : "fail",
    args: pickToolArgs(ev, running?.args),
    preview: ev.content || "",
    durationMs: ev.durationMs || 0,
    archived: Boolean(ev.archived),
  };
  if (running) Object.assign(running, next);
  else pushTraceItem(botMsg, next);
}

function fillToolTrace(root, items, { live = false } = {}) {
  const openIds = new Set(
    [...root.querySelectorAll("details.tool-card[open]")].map((el) => el.dataset.id)
  );
  root.innerHTML = "";
  const list = Array.isArray(items) ? items : [];
  const meta = list.filter(isMetaTrace);
  const tools = list.filter((t) => !isMetaTrace(t));
  if (meta.length) {
    const row = document.createElement("div");
    row.className = "tool-trace-meta";
    row.textContent = meta.map((t) => t.name).join(" · ");
    root.appendChild(row);
  }
  for (const item of tools) {
    const id = String(item.id || item.name);
    const shouldOpen = true;
    root.appendChild(createToolCard(item, { open: shouldOpen || openIds.has(id), live }));
  }
}

function createToolCard(item, { open = false } = {}) {
  const details = document.createElement("details");
  const status = item.status || (item.ok === false ? "fail" : "ok");
  details.className = `tool-card ${status}`;
  details.dataset.id = String(item.id || item.name);
  if (open) details.open = true;

  const summary = document.createElement("summary");
  summary.className = "tool-card-summary";
  const title = document.createElement("span");
  title.className = "tool-card-title";
  title.textContent = item.name || "tool";
  const hint = document.createElement("span");
  hint.className = "tool-card-hint";
  hint.textContent = toolArgHint(item);
  const meta = document.createElement("span");
  meta.className = "tool-card-meta";
  meta.textContent = toolStatusLabel(item);
  if (status === "running") {
    const pulse = document.createElement("span");
    pulse.className = "tool-card-pulse";
    meta.prepend(pulse);
  }
  summary.append(title, hint, meta);

  const body = document.createElement("div");
  body.className = "tool-card-body";
  const inputLabel = document.createElement("div");
  inputLabel.className = "tool-card-label";
  inputLabel.textContent = "输入";
  const input = document.createElement("pre");
  input.className = "tool-card-pre";
  input.textContent = formatToolArgs(item.name, item.args);
  body.append(inputLabel, input);
  const resultLabel = document.createElement("div");
  resultLabel.className = "tool-card-label";
  resultLabel.textContent = status === "running" ? "输出（进行中）" : "输出";
  const result = document.createElement("pre");
  result.className = "tool-card-pre";
  result.textContent = status === "running" && !item.preview ? "执行中…" : String(item.preview || "（无输出）");
  body.append(resultLabel, result);

  details.append(summary, body);
  return details;
}

function finishReasonLabel(reason) {
  const map = {
    stop: "正常结束",
    max_turns: "轮次上限",
    abort: "已中断",
    error: "异常退出",
    tool_calls: "工具调用",
    length: "超长截断",
  };
  return map[reason] || reason || "结束";
}

function createMessageFooter(msg) {
  const footer = document.createElement("div");
  footer.className = "msg-footer";

  const stats = document.createElement("div");
  stats.className = "msg-stats";

  if (msg.metrics) {
    const dur = document.createElement("span");
    dur.className = "stat-item stat-duration";
    dur.title = `运行时长：${msg.metrics.durationMs}ms`;
    dur.innerHTML = `<span class="stat-icon">⏱️</span><span class="stat-val">${formatDuration(msg.metrics.durationMs)}</span>`;
    stats.appendChild(dur);

    const inTok = document.createElement("span");
    inTok.className = "stat-item stat-tokens-in";
    inTok.title = `输入 Token：${msg.metrics.inputTokens}`;
    inTok.innerHTML = `<span class="stat-icon">📥</span><span class="stat-val">${formatTokenCount(msg.metrics.inputTokens)}</span>`;
    stats.appendChild(inTok);

    const outTok = document.createElement("span");
    outTok.className = "stat-item stat-tokens-out";
    outTok.title = `输出 Token：${msg.metrics.outputTokens}`;
    outTok.innerHTML = `<span class="stat-icon">📤</span><span class="stat-val">${formatTokenCount(msg.metrics.outputTokens)}</span>`;
    stats.appendChild(outTok);

    const reason = document.createElement("span");
    reason.className = `stat-item stat-reason ${msg.metrics.finishReason || ""}`;
    reason.title = `结束原因：${msg.metrics.finishReason || "未知"}`;
    reason.innerHTML = `<span class="stat-icon">🏁</span><span class="stat-val">${finishReasonLabel(msg.metrics.finishReason)}</span>`;
    stats.appendChild(reason);
  }
  footer.appendChild(stats);

  if (msg.sourceTitle) {
    const source = document.createElement("div");
    source.className = "msg-source";
    source.textContent = `来源：${msg.sourceTitle}`;
    footer.appendChild(source);
  }

  const actions = document.createElement("div");
  actions.className = "msg-actions";

  if (msg.text && !msg.error && msg.text !== "…") {
    const clipBtn = document.createElement("button");
    clipBtn.type = "button";
    clipBtn.className = "btn-clip-card";
    clipBtn.title = "剪藏此回答至 Obsidian 卡片与 Chrome 书签";
    clipBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg><span>剪藏</span>`;
    clipBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openClipModal(msg);
    });
    actions.appendChild(clipBtn);

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn-copy-answer";
    copyBtn.title = "复制回答";
    copyBtn.innerHTML = `<svg class="ico tiny"><use href="#i-copy"/></svg><span>复制</span>`;
    copyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await copyText(msg.text);
        copyBtn.querySelector("span").textContent = "已复制";
        setTimeout(() => { copyBtn.querySelector("span").textContent = "复制"; }, 1200);
      } catch (err) {
        flashStatus(err.message || String(err), false);
      }
    });
    actions.appendChild(copyBtn);

    const obsidianBtn = document.createElement("button");
    obsidianBtn.type = "button";
    obsidianBtn.className = "btn-obsidian-answer";
    obsidianBtn.title = "把当前整段对话写入文稿文件夹";
    obsidianBtn.innerHTML = `<svg class="ico tiny"><use href="#i-book"/></svg><span>写入 Obsidian</span>`;
    obsidianBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      importCurrentToLibrary();
    });
    actions.appendChild(obsidianBtn);
  }

  if (msg.traceLog || msg.metrics) {
    const dlBtn = document.createElement("button");
    dlBtn.type = "button";
    dlBtn.className = "btn-download-trace";
    dlBtn.title = "下载本次会话执行 Trace 日志（JSON）";
    dlBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>Trace</span>`;
    dlBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      downloadMessageTrace(msg);
    });
    actions.appendChild(dlBtn);
  }

  footer.appendChild(actions);

  return footer;
}

function downloadMessageTrace(msg) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const sid = state.sessionId ? state.sessionId.slice(0, 8) : "session";
  const filename = `pagelens-trace-${sid}-${ts}.json`;

  const traceData = msg.traceLog || {
    version: "1.0",
    sessionId: state.sessionId,
    timestamp: new Date().toISOString(),
    metrics: msg.metrics,
    trace: msg.trace,
    content: msg.text,
    steps: [],
  };

  const exportPayload = {
    ...traceData,
    conversationContext: {
      sessionId: state.sessionId,
      sessionTitle: state.sessionTitle,
      page: state.tab ? { url: state.tab.url, title: state.tab.title } : null,
      messagesSummary: (state.messages || []).map((m) => ({
        role: m.role,
        textPreview: String(m.text || "").slice(0, 100),
        metrics: m.metrics,
      })),
    },
  };

  const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}

function renderMessages() {
  const root = $("msgs");
  if (!root) return;
  const scrollTop = messageScroll?.beforeRender();
  root.innerHTML = "";
  if (!state.messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = isModelReady(resolveModel(state.settings, "text"))
      ? "直接问这页，或点「总结本页」。视频总结在上方音视频区，不会覆盖这里的对话。"
      : "先到设置里添加文本服务商并勾选模型。";
    root.appendChild(empty);
    const first = visibleSkills(state.settings).slice(0, 4);
    if (first.length) {
      const actions = document.createElement("div");
      actions.className = "big-actions";
      first.forEach((skill) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = skill.label;
        b.addEventListener("click", () => {
          runSkill(skill).catch((err) => {
            console.error("[pagelens] chip failed", err);
            pushError("发送失败：" + (err.message || err));
          });
        });
        actions.appendChild(b);
      });
      root.appendChild(actions);
    }
    messageScroll?.reset();
    messageScroll?.afterRender();
    return;
  }
  for (const msg of state.messages) {
    const wrap = document.createElement("div");
    wrap.className = `msg ${msg.role}${msg.error ? " error" : ""}`;
    if (msg.role === "user") {
      if (msg.image) {
        const img = document.createElement("img");
        img.className = "thumb";
        img.src = msg.image;
        wrap.appendChild(img);
      }
      wrap.appendChild(document.createTextNode(msg.text));
    } else {
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = "PageLens";
      wrap.appendChild(who);
      const isLast = msg === state.messages[state.messages.length - 1];
      const streamingThis = state.busy && isLast && !msg.metrics;
      if (msg.trace?.length) {
        const tr = document.createElement("div");
        tr.className = "tool-trace";
        fillToolTrace(tr, msg.trace, { live: streamingThis });
        wrap.appendChild(tr);
      }
      const { thinking, answer, isStreamingThinking } = splitThinking(msg.text, msg.thinking);
      const isThinkingNow = streamingThis && (isStreamingThinking || (!answer && Boolean(thinking)));

      if (thinking) {
        wrap.appendChild(createThinkingBox(thinking, { isStreaming: isThinkingNow }));
      }

      const displayText = answer || (isThinkingNow ? "" : (msg.text || (state.busy ? "…" : "")));
      if (displayText) {
        const body = document.createElement("div");
        body.className = "body";
        fillBotBody(body, displayText, { mermaid: !streamingThis && !msg.error });
        wrap.appendChild(body);
      }
      if (msg.metrics || (!streamingThis && displayText && !msg.error && displayText !== "…")) {
        wrap.appendChild(createMessageFooter(msg));
      }
    }
    root.appendChild(wrap);
  }
  messageScroll?.afterRender(scrollTop);
}

function createThinkingBox(thinking, { isStreaming = false } = {}) {
  const details = document.createElement("details");
  details.className = "thinking-box";
  if (isStreaming) {
    details.open = true;
    details.dataset.autoOpen = "true";
  }

  const summary = document.createElement("summary");
  summary.className = "thinking-summary";

  const chevronSvg = `<svg class="thinking-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>`;

  summary.innerHTML = `
    ${chevronSvg}
    <span class="thinking-title">
      <span class="thinking-icon">💭</span>
      <span class="thinking-label">${isStreaming ? "正在思考" : "思考过程"}</span>
      ${isStreaming ? '<span class="thinking-pulse"></span>' : ""}
    </span>
    <span class="thinking-badge">${isStreaming ? "思考中" : "点击展开/收起"}</span>
  `;

  const content = document.createElement("div");
  content.className = "thinking-content";
  content.textContent = thinking;

  details.addEventListener("toggle", () => {
    if (!details.open) {
      delete details.dataset.autoOpen;
    }
    if (messageScroll?.isFollowing()) {
      messageScroll.scrollToBottom({ smooth: false });
    }
  });

  details.appendChild(summary);
  details.appendChild(content);
  thinkingScrolls.set(details, createMessageScroll(content));
  return details;
}

function updateThinkingBox(details, thinking, { isStreaming = false } = {}) {
  const content = details.querySelector(".thinking-content");
  if (content && content.textContent !== thinking) {
    const scroll = thinkingScrolls.get(details);
    const top = scroll?.beforeRender();
    content.textContent = thinking;
    scroll?.afterRender(top);
  }

  const label = details.querySelector(".thinking-label");
  if (label) {
    label.textContent = isStreaming ? "正在思考" : "思考过程";
  }

  const pulse = details.querySelector(".thinking-pulse");
  if (isStreaming && !pulse) {
    const p = document.createElement("span");
    p.className = "thinking-pulse";
    details.querySelector(".thinking-title")?.appendChild(p);
  } else if (!isStreaming && pulse) {
    pulse.remove();
  }

  const badge = details.querySelector(".thinking-badge");
  if (badge) {
    badge.textContent = isStreaming ? "思考中" : "点击展开/收起";
  }

  if (isStreaming && !details.open && details.dataset.autoOpen === "true") {
    details.open = true;
  } else if (!isStreaming && details.dataset.autoOpen === "true") {
    details.open = false;
    delete details.dataset.autoOpen;
  }
}

function fillBotBody(body, text, { mermaid = false } = {}) {
  body.innerHTML = formatAnswer(text);
  decorateInlines(body, { baseUrl: state.pack?.url || state.tab?.url });
  bindMarkdownLinks(body);
  bindAnswerActions(body);
  if (mermaid) enhanceMermaid(body);
}

function parseTimestamp(raw) {
  const parts = raw.split(":").map((n) => Number(n));
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function bindAnswerActions(root) {
  root.querySelectorAll(".ts").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const seconds = parseTimestamp(btn.dataset.t);
      if (seconds == null || !state.tab?.id) return;
      try {
        await injectVideo(state.tab.id, "seek", { seconds });
      } catch (err) {
        pushError("无法跳转播放器：" + err.message);
      }
    });
  });
  root.querySelectorAll(".ref").forEach((el) => {
    el.addEventListener("click", async () => {
      const idx = Number(el.dataset.q) - 1;
      const quote = state.pack?.quotes?.[idx];
      if (!quote || !state.tab?.id) return;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: state.tab.id },
          func: highlightQuote,
          args: [quote.text],
        });
      } catch {
        /* ignore */
      }
    });
  });
}

function pushError(text) {
  messageScroll?.reset();
  state.messages.push({ role: "bot", text, error: true });
  renderMessages();
}

function pushNotice(text) {
  flashStatus(text, true);
}

function setView(view) {
  state.view = view;
  $("view-chat")?.classList.toggle("hidden", view !== "chat");
  $("view-settings")?.classList.toggle("hidden", view !== "settings");
  $("view-history")?.classList.toggle("hidden", view !== "history");
  $("view-review")?.classList.toggle("hidden", view !== "review");
  const current = { history: "btn-history", settings: "btn-settings", review: "btn-review" }[view];
  for (const id of ["btn-history", "btn-settings", "btn-review"]) {
    $(id)?.setAttribute?.("aria-current", id === current ? "page" : "false");
  }
  if (view !== "chat") hideSlashMenu();
  if (view === "chat") messageScroll?.updateButton();
  if (view === "review") refreshReviewView();
}

function currentPageMeta() {
  if (!state.share) return null;
  const url = state.pack?.url || state.tab?.url;
  if (!url || restrictedUrl(url)) return null;
  return {
    url,
    title: state.pack?.title || state.tab?.title || "",
    hostname: hostOf(url),
    kind: state.pack?.videoIsPrimary ? "video" : state.pack?.kind || "page",
  };
}

let persistChain = Promise.resolve();

function persistSession() {
  persistChain = persistChain.then(persistSessionNow, persistSessionNow);
  return persistChain;
}

function ensureSessionId() {
  if (!state.sessionId) {
    state.sessionId = crypto.randomUUID();
    state.sessionCreatedAt = state.sessionCreatedAt || Date.now();
  }
  return state.sessionId;
}

async function resolveWindowId() {
  if (Number.isInteger(state.windowId) && state.windowId >= 0) return state.windowId;
  if (Number.isInteger(state.tab?.windowId) && state.tab.windowId >= 0) {
    state.windowId = state.tab.windowId;
    return state.windowId;
  }
  try {
    const win = await chrome.windows?.getCurrent?.();
    if (Number.isInteger(win?.id) && win.id >= 0) {
      state.windowId = win.id;
      return state.windowId;
    }
  } catch { /* ignore */ }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (Number.isInteger(tab?.windowId) && tab.windowId >= 0) {
      state.windowId = tab.windowId;
      return state.windowId;
    }
  } catch { /* ignore */ }
  return null;
}

async function settleBusy() {
  if (!state.busy) return;
  state.stopIntent = "user";
  state.abort?.abort();
  const t0 = Date.now();
  while (state.busy && Date.now() - t0 < 4000) {
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function persistSessionNow() {
  if (!state.messages.some((m) => m.role === "user" && String(m.text || "").trim())) return;
  ensureSessionId();
  const page = currentPageMeta();
  if (page) state.sessionPages = mergePage(state.sessionPages, page);
  const saved = await saveSession({
    id: state.sessionId,
    createdAt: state.sessionCreatedAt || Date.now(),
    pages: state.sessionPages,
    messages: state.messages,
    run: state.run,
    taskGroupId: state.taskGroupId,
  }, { windowId: await resolveWindowId() });
  state.sessionPages = saved.pages;
}

function applySession(session) {
  if (!session) return;
  messageScroll?.reset();
  state.sessionId = session.id;
  state.sessionCreatedAt = session.createdAt;
  state.sessionPages = session.pages || [];
  state.messages = (session.messages || []).map((m) => ({
    role: m.role,
    text: m.text || "",
    thinking: m.thinking || "",
    error: m.error,
    trace: m.trace,
    metrics: m.metrics,
    traceLog: m.traceLog,
    image: null,
  }));
  state.image = null;
  state.run = session.run || null;
  state.taskGroupId = Number.isInteger(session.taskGroupId) ? session.taskGroupId : null;
  renderAttach();
  renderMessages();
}

function updateHitlBadge() {
  const badge = $("hitl-badge");
  if (!badge) return;
  const isAuto = state.settings.hitlMode === "autonomous" || state.sessionHitlOverride === true;
  badge.classList.toggle("hidden", !isAuto);
  if (state.sessionHitlOverride === true) {
    badge.textContent = "⚡️本场免确认";
    badge.title = "本场会话已信任，点击切回智能模式";
  } else if (state.settings.hitlMode === "autonomous") {
    badge.textContent = "⚡️全自动";
    badge.title = "当前处于全自动模式，点击切回智能模式";
  }
}

function showTransientAuditNotice(text) {
  let el = $("audit-notice");
  if (!el) {
    el = document.createElement("div");
    el.id = "audit-notice";
    el.className = "audit-notice";
    const composer = document.querySelector(".composer");
    if (composer) composer.insertBefore(el, composer.firstChild);
  }
  el.textContent = text;
  el.classList.add("visible");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.classList.remove("visible");
  }, 2800);
}

function showHitlModal({ toolName, args, reason, signal, timeoutSeconds, onDecision }) {
  const modal = $("hitl-modal");
  const descEl = $("hitl-desc");
  const cmdEl = $("hitl-cmd");
  const timerEl = $("hitl-timer");
  const rememberEl = $("hitl-session-remember");
  const btnApprove = $("btn-hitl-approve");
  const btnReject = $("btn-hitl-reject");

  if (!modal) {
    onDecision({ allow: false, reason: "无法弹出授权确认窗口" });
    return;
  }

  if (descEl) descEl.textContent = reason || `模型申请执行特权操作: ${toolName}`;
  const cmd = args?.command || (toolName === "run_shell" ? "" : JSON.stringify(args, null, 2));
  if (cmd && cmdEl) {
    cmdEl.textContent = cmd;
    cmdEl.classList.remove("hidden");
  } else if (cmdEl) {
    cmdEl.classList.add("hidden");
  }

  if (rememberEl) rememberEl.checked = false;
  modal.classList.remove("hidden");

  let timeLeft = timeoutSeconds || 30;
  if (timerEl) timerEl.textContent = `${timeLeft}s`;

  let timerId = null;
  let finished = false;

  const cleanup = () => {
    if (finished) return;
    finished = true;
    if (timerId) clearInterval(timerId);
    modal.classList.add("hidden");
    btnApprove?.removeEventListener("click", handleApprove);
    btnReject?.removeEventListener("click", handleReject);
  };

  const handleApprove = () => {
    cleanup();
    if (rememberEl?.checked) {
      state.sessionHitlOverride = true;
      updateHitlBadge();
    }
    onDecision({ allow: true });
  };

  const handleReject = () => {
    cleanup();
    onDecision({ allow: false, reason: "用户在侧栏主动拒绝执行该特权操作。" });
  };

  btnApprove?.addEventListener("click", handleApprove);
  btnReject?.addEventListener("click", handleReject);

  timerId = setInterval(() => {
    timeLeft -= 1;
    if (timeLeft <= 0) {
      cleanup();
      onDecision({ allow: false, reason: "授权超时未确认，操作已取消。" });
    } else if (timerEl) {
      timerEl.textContent = `${timeLeft}s`;
    }
  }, 1000);

  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        cleanup();
        onDecision({ allow: false, reason: "操作已被用户中止。" });
      },
      { once: true },
    );
  }
}

async function startNewSession() {
  await settleBusy();
  await persistSession();
  state.sessionId = null;
  state.sessionCreatedAt = null;
  state.sessionPages = [];
  state.messages = [];
  state.image = null;
  state.run = null;
  state.taskGroupId = null;
  state.transcribe = null;
  state.activeToolDomains = new Set();
  state.sessionHitlOverride = null;
  updateHitlBadge();
  state.recordAbort?.abort();
  state.workAbort?.abort();
  abortRecording();
  await clearActiveId(await resolveWindowId());
  state.chatRef = null;
  if ($("input")) $("input").value = "";
  renderAttach();
  renderComposerChip();
  messageScroll?.reset();
  renderMessages();
  setView("chat");
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 800);
}

function histStatus(text, ok) {
  const el = $("hist-status");
  if (!el) return;
  el.textContent = text || "";
  el.className = "status" + (ok === true ? " ok" : ok === false ? " bad" : "");
}

function pageLines(pages, limit = 3) {
  const list = pages || [];
  const shown = list.slice(0, limit).map((p) => {
    const title = p.title || p.hostname || "无标题";
    return p.url ? `${title}\n${p.url}` : title;
  });
  if (list.length > limit) shown.push(`等 ${list.length} 个网页`);
  return shown.join("\n");
}

async function renderHistory() {
  const root = $("hist-list");
  if (!root) return;
  const index = filterSessions(await listSessions(), state.histQuery);
  root.innerHTML = "";
  if (!index.length) {
    const empty = document.createElement("p");
    empty.className = "hist-empty";
    empty.textContent = state.histQuery ? "没有匹配的对话。" : "还没有历史。问完就会自动保存，并记下当时的网页。";
    root.appendChild(empty);
    return;
  }
  for (const item of index) {
    const row = document.createElement("div");
    row.className = "hist-item" + (item.id === state.sessionId ? " active" : "");
    const main = document.createElement("button");
    main.type = "button";
    main.className = "hist-main";
    main.title = "打开这条对话";
    const hosts = [...new Set((item.pages || []).map((p) => p.hostname).filter(Boolean))];
    const hostLabel = hosts.length === 1 ? hosts[0] : hosts.length ? `${hosts[0]} 等 ${hosts.length} 站` : "未分享页面";
    main.innerHTML = `
      <div class="t"></div>
      <div class="s"></div>
      <div class="pages"></div>
    `;
    main.querySelector(".t").textContent = item.title || "未命名对话";
    main.querySelector(".s").textContent = [hostLabel, formatWhen(item.updatedAt), `${item.messageCount || 0} 条`]
      .filter(Boolean)
      .join(" · ");
    main.querySelector(".pages").textContent = pageLines(item.pages);
    main.addEventListener("click", () => openHistoryItem(item.id));
    const ops = document.createElement("div");
    ops.className = "hist-ops";
    const exp = document.createElement("button");
    exp.type = "button";
    exp.className = "mini";
    exp.textContent = "导出";
    exp.title = "导出 Markdown";
    exp.addEventListener("click", (e) => {
      e.stopPropagation();
      exportOne(item.id);
    });
    const obsidian = document.createElement("button");
    obsidian.type = "button";
    obsidian.className = "mini";
    obsidian.textContent = "入库";
    obsidian.title = "写入文稿文件夹（Obsidian 可直接打开）";
    obsidian.addEventListener("click", (e) => {
      e.stopPropagation();
      importOneToLibrary(item.id);
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "mini";
    del.textContent = "删";
    del.title = "删除";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removeHistoryItem(item.id);
    });
    ops.append(obsidian, exp, del);
    row.append(main, ops);
    root.appendChild(row);
  }
}

async function openHistoryItem(id) {
  await settleBusy();
  await persistSession();
  const session = await loadSession(id);
  if (!session) {
    histStatus("找不到这条对话", false);
    return;
  }
  applySession(session);
  await saveSession(session, { windowId: await resolveWindowId() });
  setView("chat");
}

async function exportOne(id) {
  if (id === state.sessionId) await persistSession();
  const data = await loadSession(id);
  if (!data) {
    histStatus("没有可导出的内容", false);
    return;
  }
  downloadText(sessionFilename(data, "md"), sessionToMarkdown(data), "text/markdown");
  histStatus("已导出 Markdown", true);
}

async function exportAll(kind) {
  await persistSession();
  const all = await loadAllSessions();
  if (!all.length) {
    histStatus("没有可导出的对话", false);
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  if (kind === "json") {
    downloadText(`pagelens-sessions-${day}.json`, sessionsToJSON(all), "application/json");
    histStatus(`已导出 ${all.length} 条 JSON`, true);
    return;
  }
  downloadText(`pagelens-sessions-${day}.md`, sessionsToMarkdown(all), "text/markdown");
  histStatus(`已导出 ${all.length} 条 Markdown`, true);
}

function flashStatus(text, ok) {
  if (state.view === "history") {
    histStatus(text, ok);
    return;
  }
  setModelLineMeta(text || "");
  window.setTimeout(() => renderModelLine(), 2600);
}

async function ensureLibraryForWrite() {
  let info = await libraryStatus({ request: true });
  if (!info.configured) {
    const picked = await pickLibraryFolder();
    info = { configured: true, granted: true, name: picked.name };
  }
  state.library = info;
  paintLibraryStatus(state.library);
  renderModelLine();
  if (!info.granted) {
    throw new Error(info.mode === "path"
      ? (info.error || "文稿路径不可用。确认已安装 Native Host，并到设置重新填路径。")
      : "文稿文件夹未授权。到设置点「重新授权」。");
  }
  return info;
}

async function importOneToLibrary(id) {
  if (id === state.sessionId) await persistSession();
  const data = await loadSession(id);
  if (!data) {
    flashStatus("没有可导入的内容", false);
    return;
  }
  try {
    await ensureLibraryForWrite();
    const saved = await writeSessionNote(data, { request: true });
    flashStatus(`已写入 ${saved.path}`, true);
  } catch (err) {
    if (err?.name === "AbortError") return;
    flashStatus(err.message || String(err), false);
  }
}

async function importAllToLibrary() {
  await persistSession();
  const all = await loadAllSessions();
  if (!all.length) {
    histStatus("没有可导入的对话", false);
    return;
  }
  try {
    await ensureLibraryForWrite();
    const saved = await writeSessionNotes(all, { request: true });
    histStatus(`已写入 ${saved.count} 条到 PageLens/sessions/`, true);
  } catch (err) {
    if (err?.name === "AbortError") return;
    histStatus(err.message || String(err), false);
  }
}

async function importCurrentToLibrary() {
  await persistSession();
  if (!state.sessionId) {
    flashStatus("还没有可保存的对话", false);
    return;
  }
  await importOneToLibrary(state.sessionId);
}

function openClipModal(msg) {
  if (!msg) return;
  state.currentClipMsg = msg;
  const modal = $("clip-modal");
  if (!modal) return;

  const defaultTitle = state.pack?.title || state.tab?.title || "未命名网页";
  const defaultUrl = state.pack?.url || state.tab?.url || "";

  const titleInput = $("clip-input-title");
  const urlInput = $("clip-input-url");
  const noteInput = $("clip-input-note");
  const tagsInput = $("clip-input-tags");
  const preview = $("clip-content-preview");

  if (titleInput) titleInput.value = defaultTitle;
  if (urlInput) urlInput.value = defaultUrl;
  if (noteInput) noteInput.value = "";
  if (tagsInput) tagsInput.value = "";
  if (preview) preview.textContent = msg.text || "";

  const dailyFolder = state.settings?.dailyNotesFolder ?? "Daily";
  const dailyRel = dailyNoteRelPath(dailyFolder, Date.now(), state.library?.path);
  const dailyPreview = $("clip-daily-path-preview");
  if (dailyPreview) dailyPreview.textContent = dailyRel;

  modal.classList.remove("hidden");
  setTimeout(() => noteInput?.focus(), 60);
}

function closeClipModal() {
  state.currentClipMsg = null;
  $("clip-modal")?.classList.add("hidden");
}

async function submitClipModal() {
  const msg = state.currentClipMsg;
  if (!msg) {
    closeClipModal();
    return;
  }
  const title = $("clip-input-title")?.value?.trim() || "未命名网页";
  const url = $("clip-input-url")?.value?.trim() || "";
  const note = $("clip-input-note")?.value?.trim() || "";
  const tags = $("clip-input-tags")?.value?.trim() || "";
  const saveObsidian = $("clip-check-obsidian")?.checked ?? true;
  const saveDaily = $("clip-check-daily")?.checked ?? true;
  const saveBookmark = $("clip-check-bookmark")?.checked ?? true;
  const dailyFolder = state.settings?.dailyNotesFolder ?? "Daily";

  const confirmBtn = $("btn-clip-confirm");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "保存中…";
  }

  try {
    if (saveObsidian || saveDaily) {
      await ensureLibraryForWrite();
    }
    const res = await executeClipping({
      title,
      url,
      note,
      content: msg.text || "",
      tags,
      saveObsidian,
      saveDaily,
      dailyFolder,
      libraryRoot: state.library?.path || "",
      saveBookmark,
    });

    closeClipModal();

    const notices = [];
    if (saveObsidian) {
      if (res.clipping.obsidianPath) {
        notices.push(`已写入 ${res.clipping.obsidianPath}`);
      } else if (res.obsidianError) {
        notices.push(`Obsidian 写入失败：${res.obsidianError}`);
      }
    }
    if (saveDaily) {
      if (res.clipping.dailySkipped) {
        notices.push("今日日记已存在此采摘（已自动去重）");
      } else if (res.clipping.dailyPath) {
        notices.push(`已追加至今日日记 ${res.clipping.dailyPath}`);
      } else if (res.dailyError) {
        notices.push(`日记追加失败：${res.dailyError}`);
      }
    }
    if (saveBookmark) {
      if (res.clipping.bookmarkId) {
        notices.push("已加入「PageLens 智库」书签");
      } else if (res.bookmarkError) {
        notices.push(`书签保存失败：${res.bookmarkError}`);
      }
    }
    if (!notices.length) notices.push("已记录剪藏");
    flashStatus(notices.join(" · "), !res.obsidianError && !res.dailyError);

    if (state.tab?.url) {
      checkSmartRecall(state.tab.url).catch(() => {});
    }
  } catch (err) {
    if (err?.name === "AbortError") return;
    console.error("[pagelens] clip submit error", err);
    flashStatus("剪藏失败：" + (err?.message || err), false);
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "确认保存";
    }
  }
}

function recallDismissKey(url) {
  return clippingPageKey(url) || url;
}

async function checkSmartRecall(url) {
  const banner = $("recall-banner");
  if (!banner) return;
  if (!url || state.dismissedRecallUrls?.has(recallDismissKey(url))) {
    banner.classList.add("hidden");
    return;
  }
  try {
    const clips = await getClippingsForUrl(url);
    if (!clips || !clips.length) {
      banner.classList.add("hidden");
      state.activeRecallClippings = [];
      return;
    }
    state.activeRecallClippings = clips;
    const count = clips.length;
    const latest = clips[0];
    const when = formatWhen(latest.createdAt);
    const summary = latest.note ? `：“${latest.note.slice(0, 16)}${latest.note.length > 16 ? "…" : ""}”` : "";
    const textEl = $("recall-text");
    if (textEl) {
      textEl.textContent = `本页曾剪藏 ${count} 条笔记${summary} (${when})`;
    }
    banner.classList.remove("hidden");
  } catch (err) {
    console.warn("[pagelens] checkSmartRecall error", err);
    banner.classList.add("hidden");
  }
}

function dismissRecallBanner() {
  if (state.tab?.url) {
    if (!state.dismissedRecallUrls) state.dismissedRecallUrls = new Set();
    state.dismissedRecallUrls.add(recallDismissKey(state.tab.url));
  }
  $("recall-banner")?.classList.add("hidden");
}

function openClipViewModal() {
  const clips = state.activeRecallClippings;
  if (!clips?.length) {
    closeClipViewModal();
    return;
  }
  const modal = $("clip-view-modal");
  const body = $("clip-view-body");
  if (!modal || !body) return;

  body.innerHTML = "";
  clips.forEach((c) => {
    const item = document.createElement("div");
    item.className = "clip-view-item";

    const top = document.createElement("div");
    top.className = "clip-view-top";

    const metaLeft = document.createElement("div");
    metaLeft.style.display = "flex";
    metaLeft.style.alignItems = "center";
    metaLeft.style.gap = "8px";
    metaLeft.style.flexWrap = "wrap";

    const dateSpan = document.createElement("span");
    dateSpan.className = "clip-view-date";
    dateSpan.textContent = formatWhen(c.createdAt);
    metaLeft.appendChild(dateSpan);

    if (Array.isArray(c.tags) && c.tags.length) {
      const tagsSpan = document.createElement("div");
      tagsSpan.style.display = "flex";
      tagsSpan.style.gap = "4px";
      tagsSpan.style.flexWrap = "wrap";
      c.tags.forEach((t) => {
        const tag = document.createElement("span");
        tag.className = "clip-view-tag";
        tag.textContent = `#${t}`;
        tagsSpan.appendChild(tag);
      });
      metaLeft.appendChild(tagsSpan);
    }
    top.appendChild(metaLeft);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn-clip-delete";
    delBtn.title = "删除此条剪藏";
    delBtn.textContent = "🗑️ 删除";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("确定删除这条剪藏笔记吗？")) return;
      await handleDeleteClipping(c);
    });
    top.appendChild(delBtn);

    item.appendChild(top);

    if (c.note) {
      const noteEl = document.createElement("div");
      noteEl.className = "clip-view-note";
      noteEl.textContent = `💡 备注：${c.note}`;
      item.appendChild(noteEl);
    }

    if (c.content) {
      const contentEl = document.createElement("div");
      contentEl.className = "clip-view-content";
      contentEl.textContent = c.content;
      item.appendChild(contentEl);
    }

    if (c.obsidianPath) {
      const pathEl = document.createElement("div");
      pathEl.className = "clip-view-path";
      pathEl.textContent = `📁 Obsidian: ${c.obsidianPath}`;
      item.appendChild(pathEl);
    }

    body.appendChild(item);
  });

  modal.classList.remove("hidden");
}

async function handleDeleteClipping(clipping) {
  try {
    await deleteClippingFull(clipping);
    state.activeRecallClippings = (state.activeRecallClippings || []).filter((item) => item.id !== clipping.id);
    pushNotice("已删除剪藏笔记");
    if (state.activeRecallClippings.length > 0) {
      openClipViewModal();
      if (state.tab?.url) checkSmartRecall(state.tab.url).catch(() => {});
    } else {
      closeClipViewModal();
      $("recall-banner")?.classList.add("hidden");
    }
  } catch (err) {
    console.error("[pagelens] delete clipping error", err);
    flashStatus("删除失败：" + (err?.message || err), false);
    pushError("删除失败：" + (err?.message || err));
  }
}

function closeClipViewModal() {
  $("clip-view-modal")?.classList.add("hidden");
}

async function removeHistoryItem(id) {
  if (!confirm("删除这条对话？不可恢复。")) return;
  if (id === state.sessionId) await settleBusy();
  await deleteSession(id);
  await deleteSessionArtifacts(id);
  if (state.sessionId === id) {
    state.sessionId = null;
    state.sessionCreatedAt = null;
    state.sessionPages = [];
    state.messages = [];
    state.image = null;
    state.run = null;
    state.taskGroupId = null;
    state.activeToolDomains = new Set();
    renderAttach();
    renderMessages();
  }
  await renderHistory();
  histStatus("已删除", true);
}

async function openHistoryView() {
  await persistSession();
  $("hist-q").value = state.histQuery;
  histStatus("");
  await renderHistory();
  setView("history");
}

async function openReviewView() {
  await persistSession();
  setView("review");
}

function setReviewStatus(msg, ok = true) {
  const el = $("review-status");
  if (!el) return;
  el.textContent = msg;
  el.className = `status ${ok ? "ok" : "bad"}`;
  if (msg) {
    setTimeout(() => {
      if (el.textContent === msg) el.textContent = "";
    }, 4000);
  }
}

async function refreshReviewView() {
  const tabs = document.querySelectorAll(".review-tab");
  tabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.type === state.review.type);
  });

  const periodBar = $("review-period-bar");
  const clipDrawer = $("review-clip-drawer");
  const actionsBar = $("review-actions-bar");
  const outputContainer = $("review-output-container");
  const historyContainer = $("review-history-container");

  if (state.review.type === "history") {
    periodBar?.classList.add("hidden");
    clipDrawer?.classList.add("hidden");
    actionsBar?.classList.add("hidden");
    outputContainer?.classList.add("hidden");
    historyContainer?.classList.remove("hidden");
    await renderReviewHistory();
    return;
  }

  periodBar?.classList.remove("hidden");
  clipDrawer?.classList.remove("hidden");
  actionsBar?.classList.remove("hidden");
  outputContainer?.classList.remove("hidden");
  historyContainer?.classList.add("hidden");

  const period = getReviewPeriod(state.review.type, state.review.date);
  const labelEl = $("review-period-label");
  const statsEl = $("review-period-stats");
  if (labelEl) labelEl.textContent = period.label;

  // Load clippings
  let allClippings = [];
  try {
    allClippings = await listAllClippings();
  } catch (err) {
    console.error("[pagelens] load clippings error", err);
  }

  const periodClippings = filterClippingsForPeriod(allClippings, period);
  state.review.activeClippings = periodClippings;

  // Sync selected clipping IDs on period change
  if (state.review.lastPeriodKey !== period.key || !state.review.selectedClippingIds) {
    state.review.selectedClippingIds = new Set(periodClippings.map((c) => c.id));
    state.review.lastPeriodKey = period.key;
  }

  // Update Drawer Title & Stats
  const drawerTitle = $("clip-drawer-title");
  if (drawerTitle) {
    drawerTitle.textContent = `📌 本期收藏内容 (${periodClippings.length})`;
  }
  if (statsEl) {
    statsEl.textContent = `共 ${periodClippings.length} 篇收藏 · 已勾选 ${state.review.selectedClippingIds.size} 篇`;
  }

  // Render Clipping List inside Drawer
  const listEl = $("review-clip-list");
  if (listEl) {
    listEl.innerHTML = "";
    if (!periodClippings.length) {
      listEl.innerHTML = `<div class="hist-empty">本周期内暂无收藏。在浏览网页时点「🔖 剪藏本页」或回答下方点「剪藏」即可收集知识。</div>`;
    } else {
      for (const clip of periodClippings) {
        const item = document.createElement("div");
        item.className = "review-clip-item";

        const chk = document.createElement("input");
        chk.type = "checkbox";
        chk.checked = state.review.selectedClippingIds.has(clip.id);
        chk.addEventListener("change", () => {
          if (chk.checked) state.review.selectedClippingIds.add(clip.id);
          else state.review.selectedClippingIds.delete(clip.id);
          if (statsEl) {
            statsEl.textContent = `共 ${periodClippings.length} 篇收藏 · 已勾选 ${state.review.selectedClippingIds.size} 篇`;
          }
        });

        const detail = document.createElement("div");
        detail.className = "review-clip-detail";

        const titleDiv = document.createElement("div");
        titleDiv.className = "review-clip-title";
        if (clip.url) {
          titleDiv.innerHTML = `<a href="${escapeAttr(clip.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(clip.title || "未命名网页")}</a>`;
        } else {
          titleDiv.textContent = clip.title || "未命名网页";
        }
        detail.appendChild(titleDiv);

        const metaDiv = document.createElement("div");
        metaDiv.className = "review-clip-meta";
        const dStr = clip.createdAt
          ? new Date(clip.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
          : "";
        if (dStr) {
          const timeSpan = document.createElement("span");
          timeSpan.textContent = `⏱️ ${dStr}`;
          metaDiv.appendChild(timeSpan);
        }
        const tags = Array.isArray(clip.tags) ? clip.tags : String(clip.tags || "").split(/[,，\s]+/);
        const validTags = tags.filter(Boolean);
        if (validTags.length) {
          const tagSpan = document.createElement("span");
          tagSpan.textContent = validTags.map((t) => `#${t.replace(/^#/, "")}`).join(" ");
          metaDiv.appendChild(tagSpan);
        }
        detail.appendChild(metaDiv);

        if (clip.note && clip.note.trim()) {
          const noteDiv = document.createElement("div");
          noteDiv.className = "review-clip-note";
          noteDiv.textContent = `💡 ${clip.note.trim()}`;
          detail.appendChild(noteDiv);
        }

        item.appendChild(chk);
        item.appendChild(detail);
        listEl.appendChild(item);
      }
    }
  }

  // Load existing review for this period
  let existingReview = null;
  try {
    existingReview = await getReviewByKey(period.key);
  } catch {
    existingReview = null;
  }
  state.review.activeReview = existingReview;

  const emptyEl = $("review-output-empty");
  const outputEl = $("review-output");
  const genBtn = $("btn-review-generate");
  const obsBtn = $("btn-review-obsidian");
  const dailyBtn = $("btn-review-daily-note");
  const copyBtn = $("btn-review-copy");
  const delBtn = $("btn-review-delete");

  if (existingReview && existingReview.content) {
    emptyEl?.classList.add("hidden");
    outputEl?.classList.remove("hidden");
    if (outputEl) {
      outputEl.innerHTML = formatAnswer(existingReview.content);
      bindMarkdownLinks(outputEl);
      enhanceMermaid(outputEl);
    }
    if (genBtn) genBtn.textContent = "🔄 重新生成复盘";
    obsBtn?.classList.remove("hidden");
    copyBtn?.classList.remove("hidden");
    delBtn?.classList.remove("hidden");
    dailyBtn?.classList.toggle("hidden", state.review.type !== "daily");
  } else {
    emptyEl?.classList.remove("hidden");
    outputEl?.classList.add("hidden");
    if (genBtn) genBtn.textContent = "✨ 开始 AI 深度复盘";
    obsBtn?.classList.add("hidden");
    copyBtn?.classList.add("hidden");
    delBtn?.classList.add("hidden");
    dailyBtn?.classList.add("hidden");
  }
}

async function startGenerateReview() {
  if (state.review.generating) return;

  const model = resolveModel(state.settings, "text");
  if (!isModelReady(model)) {
    alert("请先在设置中添加文本服务商并勾选模型。");
    setView("settings");
    return;
  }

  const period = getReviewPeriod(state.review.type, state.review.date);
  const selected = (state.review.activeClippings || []).filter((c) =>
    state.review.selectedClippingIds.has(c.id),
  );

  if (!selected.length) {
    setReviewStatus("请至少勾选一篇收藏内容进行复盘", false);
    return;
  }

  state.review.generating = true;
  state.review.abort = new AbortController();

  const genBtn = $("btn-review-generate");
  const stopBtn = $("btn-review-stop");
  const emptyEl = $("review-output-empty");
  const outputEl = $("review-output");
  const obsBtn = $("btn-review-obsidian");
  const copyBtn = $("btn-review-copy");
  const delBtn = $("btn-review-delete");
  const dailyBtn = $("btn-review-daily-note");

  if (genBtn) genBtn.disabled = true;
  stopBtn?.classList.remove("hidden");
  emptyEl?.classList.add("hidden");
  outputEl?.classList.remove("hidden");
  obsBtn?.classList.add("hidden");
  copyBtn?.classList.add("hidden");
  delBtn?.classList.add("hidden");
  dailyBtn?.classList.add("hidden");

  if (outputEl) {
    outputEl.innerHTML = `<p style="color:var(--muted)"><em>🧠 正在研读并深度串联 ${selected.length} 篇收藏与个人思考，准备撰写复盘…</em></p>`;
  }

  try {
    const reviewRecord = await generateReviewSummary({
      type: state.review.type,
      dateInput: state.review.date,
      clippings: selected,
      model,
      language: state.settings?.answerLanguage || "zh-CN",
      signal: state.review.abort.signal,
      onDelta: (delta, fullText) => {
        if (outputEl) {
          outputEl.innerHTML = formatAnswer(fullText);
          bindMarkdownLinks(outputEl);
        }
      },
    });

    state.review.activeReview = reviewRecord;
    if (outputEl) {
      outputEl.innerHTML = formatAnswer(reviewRecord.content);
      bindMarkdownLinks(outputEl);
      enhanceMermaid(outputEl);
    }
    setReviewStatus("复盘生成成功并已自动保存！", true);
  } catch (err) {
    if (err?.name === "AbortError") {
      setReviewStatus("已停止生成", false);
    } else {
      console.error("[pagelens] review generation error", err);
      setReviewStatus("生成失败：" + (err?.message || err), false);
    }
  } finally {
    state.review.generating = false;
    state.review.abort = null;
    if (genBtn) {
      genBtn.disabled = false;
      genBtn.textContent = "🔄 重新生成复盘";
    }
    stopBtn?.classList.add("hidden");
    if (state.review.activeReview?.content) {
      obsBtn?.classList.remove("hidden");
      copyBtn?.classList.remove("hidden");
      delBtn?.classList.remove("hidden");
      dailyBtn?.classList.toggle("hidden", state.review.type !== "daily");
    }
  }
}

function stopGenerateReview() {
  if (state.review.abort) {
    state.review.abort.abort();
  }
}

async function handleExportReviewToObsidian() {
  const review = state.review.activeReview;
  if (!review) return;
  try {
    await ensureLibraryForWrite();
    const res = await writeReviewToObsidian(review, { request: true });
    setReviewStatus(`已写入 Obsidian：${res.path}`, true);
  } catch (err) {
    if (err?.name === "AbortError") return;
    console.error("[pagelens] Obsidian review export failed:", err);
    setReviewStatus(`导出失败：${err?.message || err}`, false);
  }
}

async function handleAppendReviewToDailyNote() {
  const review = state.review.activeReview;
  if (!review) return;
  try {
    await ensureLibraryForWrite();
    const folder = state.settings?.dailyNotesFolder || "Daily";
    const res = await appendReviewToDailyNote(review, {
      folder,
      libraryRoot: state.library?.path || "",
      request: true,
    });
    if (res.skipped) {
      setReviewStatus("今日日记中已存在该复盘总结", true);
    } else {
      setReviewStatus(`已追加至今日日记：${res.path}`, true);
    }
  } catch (err) {
    if (err?.name === "AbortError") return;
    console.error("[pagelens] Daily note append failed:", err);
    setReviewStatus(`追加日记失败：${err?.message || err}`, false);
  }
}

async function handleCopyReview() {
  const review = state.review.activeReview;
  if (!review || !review.content) return;
  try {
    await navigator.clipboard.writeText(review.content);
    setReviewStatus("已复制 Markdown 到剪贴板", true);
  } catch (err) {
    setReviewStatus("复制失败：" + (err?.message || err), false);
  }
}

async function handleDeleteActiveReview() {
  const review = state.review.activeReview;
  if (!review) return;
  if (!confirm(`确定删除 ${review.periodLabel || "此条"} 复盘记录吗？`)) return;
  try {
    await deleteReviewRecord(review.id);
    state.review.activeReview = null;
    setReviewStatus("已删除该复盘记录", true);
    await refreshReviewView();
  } catch (err) {
    setReviewStatus("删除失败：" + (err?.message || err), false);
  }
}

async function renderReviewHistory() {
  const container = $("review-history-list");
  if (!container) return;
  container.innerHTML = `<div class="hist-empty">正在加载历史复盘记录…</div>`;

  let list = [];
  try {
    list = await listAllReviews();
  } catch {
    list = [];
  }

  if (!list.length) {
    container.innerHTML = `<div class="hist-empty">暂无已生成的复盘记录。请切换到「每日/每周/每月复盘」点击生成。</div>`;
    return;
  }

  container.innerHTML = "";
  for (const item of list) {
    const card = document.createElement("div");
    card.className = "review-hist-card";

    const main = document.createElement("div");
    main.className = "review-hist-main";

    const title = document.createElement("div");
    title.className = "review-hist-title";
    const typeLabel = item.type === "daily" ? "📅 日" : item.type === "weekly" ? "📆 周" : "🗓️ 月";
    title.textContent = `${typeLabel} · ${item.title || item.periodLabel || "复盘总结"}`;
    main.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "review-hist-meta";
    const timeStr = item.createdAt ? new Date(item.createdAt).toLocaleString("zh-CN") : "";
    const tags = Array.isArray(item.tags) ? item.tags.filter(Boolean) : [];
    const count = Number(item.clippingCount || item.clippingIds?.length || 0);
    meta.textContent = `${timeStr} · 包含 ${count} 篇收藏${tags.length ? " · " + tags.map((t) => "#" + t).join(" ") : ""}`;
    main.appendChild(meta);

    const ops = document.createElement("div");
    ops.className = "review-hist-ops";

    const viewBtn = document.createElement("button");
    viewBtn.className = "secondary mini";
    viewBtn.textContent = "查看";
    viewBtn.addEventListener("click", () => {
      state.review.type = item.type || "daily";
      state.review.date = item.dateRange?.start || item.createdAt || Date.now();
      refreshReviewView();
    });
    ops.appendChild(viewBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "secondary mini";
    delBtn.textContent = "删除";
    delBtn.addEventListener("click", async () => {
      if (!confirm("确定删除这条历史复盘吗？")) return;
      await deleteReviewRecord(item.id);
      await renderReviewHistory();
    });
    ops.appendChild(delBtn);

    card.appendChild(main);
    card.appendChild(ops);
    container.appendChild(card);
  }
}

async function handleClipCurrentPage() {
  if (!state.share) await restorePageContext();
  const defaultTitle = state.pack?.title || state.tab?.title || "未命名网页";
  const defaultUrl = state.pack?.url || state.tab?.url || "";
  let excerpt = "";
  if (state.pack?.text) {
    excerpt = state.pack.text.slice(0, 1200);
    if (state.pack.text.length > 1200) excerpt += "\n\n…（正文较长，已截取前文）";
  }
  openClipModal({
    text: excerpt,
    title: defaultTitle,
    url: defaultUrl,
  });
}

function initReviewView() {
  // Review tab switching
  const tabs = document.querySelectorAll(".review-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      state.review.type = tab.dataset.type;
      refreshReviewView();
    });
  });

  // Period navigation
  $("btn-period-prev")?.addEventListener("click", () => {
    const period = getReviewPeriod(state.review.type, state.review.date);
    if (period.prevDate) {
      state.review.date = period.prevDate;
      refreshReviewView();
    }
  });

  $("btn-period-next")?.addEventListener("click", () => {
    const period = getReviewPeriod(state.review.type, state.review.date);
    if (period.nextDate) {
      state.review.date = period.nextDate;
      refreshReviewView();
    }
  });

  // Calendar picker
  const picker = $("review-date-picker");
  $("btn-period-pick")?.addEventListener("click", () => {
    if (picker) {
      picker.showPicker ? picker.showPicker() : picker.click();
    }
  });
  picker?.addEventListener("change", (e) => {
    if (e.target.value) {
      const parts = e.target.value.split("-").map(Number);
      if (parts.length === 3) {
        state.review.date = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0).getTime();
        refreshReviewView();
      }
    }
  });

  // Drawer toggle
  $("clip-drawer-toggle")?.addEventListener("click", () => {
    const content = $("clip-drawer-content");
    const arrow = $("clip-drawer-arrow");
    if (content) content.classList.toggle("hidden");
    if (arrow) arrow.classList.toggle("open");
  });

  // Select all / Deselect all
  $("btn-clip-select-all")?.addEventListener("click", () => {
    state.review.selectedClippingIds = new Set((state.review.activeClippings || []).map((c) => c.id));
    refreshReviewView();
  });
  $("btn-clip-deselect-all")?.addEventListener("click", () => {
    state.review.selectedClippingIds = new Set();
    refreshReviewView();
  });

  // Review Actions
  $("btn-review-generate")?.addEventListener("click", () => startGenerateReview());
  $("btn-review-stop")?.addEventListener("click", () => stopGenerateReview());
  $("btn-review-obsidian")?.addEventListener("click", () => handleExportReviewToObsidian());
  $("btn-review-daily-note")?.addEventListener("click", () => handleAppendReviewToDailyNote());
  $("btn-review-copy")?.addEventListener("click", () => handleCopyReview());
  $("btn-review-delete")?.addEventListener("click", () => handleDeleteActiveReview());
  $("btn-review-back")?.addEventListener("click", () => setView("chat"));
  $("btn-review")?.addEventListener("click", () => openReviewView());
  $("btn-clip-page")?.addEventListener("click", () => handleClipCurrentPage());
}

function fieldBlock(prefix, model, hints = {}) {
  const presetOpts = presetsFor(prefix).map(
    (p) => `<option value="${p.id}" ${p.id === model.preset ? "selected" : ""}>${p.name}</option>`,
  ).join("");
  return `
    <label class="field">预设
      <select data-k="${prefix}.preset">${presetOpts}</select>
    </label>
    <label class="field">base_url
      <input data-k="${prefix}.baseUrl" value="${escapeAttr(model.baseUrl)}" placeholder="${escapeAttr(hints.baseUrl || "https://api.example.com/v1")}" />
    </label>
    <label class="field">model_name
      <input data-k="${prefix}.model" value="${escapeAttr(model.model)}" placeholder="${escapeAttr(hints.model || "gpt-4o-mini")}" />
    </label>
    <label class="field">api_key
      <input data-k="${prefix}.apiKey" type="password" value="${escapeAttr(model.apiKey)}" placeholder="${escapeAttr(hints.key || "sk-…")}" autocomplete="off" />
    </label>
    ${prefix === 'text' ? `<label class="field">视频总结：单次正文上限（token）
      <input data-k="text.summaryInputTokens" type="number" min="1000" max="2000000" step="1000" value="${Number(model.summaryInputTokens) || 200000}" />
      <small>默认 200,000；超过才分段。按中英文估算，不含提示词和输出。</small>
    </label>` : ''}
    <div class="row-btns">
      <button class="secondary" type="button" data-test="${prefix}">测试连接</button>
      <span class="status" data-test-status="${prefix}"></span>
    </div>
  `;
}

function escapeAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function syncTextCatalog() {
  const tokens = state.settings.text?.summaryInputTokens;
  const catalog = hydrateTextCatalog(state.settings, state.settings.text);
  state.settings.textProviders = catalog.textProviders;
  state.settings.textRef = catalog.textRef;
  state.settings.text = { ...catalog.text, summaryInputTokens: tokens };
}

function persistTextCatalog() {
  syncTextCatalog();
  return saveSettings(state.settings).then((saved) => {
    state.settings = saved;
    renderTextProviders();
    renderModelLine();
    return saved;
  });
}

function providerById(id) {
  return (state.settings.textProviders || []).find((p) => p.id === id);
}

function replaceProvider(next) {
  state.settings.textProviders = (state.settings.textProviders || []).map((p) => (p.id === next.id ? next : p));
}

function visibleProviderModelIds(provider) {
  const q = String(state.textProviderUi?.query || "").trim().toLowerCase();
  return (provider.models || [])
    .filter((m) => !q || m.id.toLowerCase().includes(q) || String(m.ownedBy || "").toLowerCase().includes(q))
    .map((m) => m.id);
}

function renderTextProviders() {
  const root = $("text-providers");
  if (!root) return;
  bindTextProvidersOnce();
  syncTextCatalog();
  const providers = state.settings.textProviders || [];
  const ui = state.textProviderUi;
  const current = state.settings.textRef;
  const presetOpts = presetsFor("text").map((p) => `<option value="${escapeAttr(p.id)}">${escapeAttr(p.name)}</option>`).join("");
  const q = String(ui.query || "").trim().toLowerCase();
  const cards = providers.map((p) => {
    const models = q
      ? p.models.filter((m) => m.id.toLowerCase().includes(q) || String(m.ownedBy || "").toLowerCase().includes(q))
      : p.models;
    const editing = ui.editingId === p.id;
    const modelRows = models.map((m) => {
      const isCurrent = current?.providerId === p.id && current?.modelId === m.id;
      return `<li>
        <label class="check">
          <input type="checkbox" data-tp="toggle" data-id="${escapeAttr(p.id)}" data-model="${escapeAttr(m.id)}" ${m.enabled ? "checked" : ""} />
          <span><code>${escapeAttr(m.id)}</code>${m.ownedBy ? ` <span class="muted">· ${escapeAttr(m.ownedBy)}</span>` : ""}${isCurrent ? " · 当前" : ""}</span>
        </label>
        <button type="button" class="secondary" data-tp="current" data-id="${escapeAttr(p.id)}" data-model="${escapeAttr(m.id)}" ${m.enabled ? "" : "disabled"}>设为当前</button>
      </li>`;
    }).join("");
    return `<article class="provider-card">
      <div class="provider-head">
        <strong>${escapeAttr(p.name)}</strong>
        <span class="muted">${escapeAttr(p.preset)} · ${p.apiKey ? "已填密钥" : "无密钥"}</span>
      </div>
      <div class="muted provider-url">${escapeAttr(p.baseUrl || "—")}${p.scannedAt ? ` · 扫描于 ${escapeAttr(p.scannedAt.slice(0, 19).replace("T", " "))}` : ""}</div>
      ${p.scanError ? `<div class="status bad">${escapeAttr(p.scanError)}</div>` : ""}
      <div class="row-btns">
        <button type="button" class="secondary" data-tp="scan" data-id="${escapeAttr(p.id)}">扫描模型</button>
        <button type="button" class="secondary" data-tp="edit" data-id="${escapeAttr(p.id)}">${editing ? "取消编辑" : "改地址/密钥"}</button>
        <button type="button" class="secondary" data-tp="delete" data-id="${escapeAttr(p.id)}">删除</button>
      </div>
      ${editing ? `<div class="provider-edit">
        <label class="field">base_url<input data-tp-edit="baseUrl" data-id="${escapeAttr(p.id)}" value="${escapeAttr(p.baseUrl)}" /></label>
        <label class="field">api_key<input data-tp-edit="apiKey" data-id="${escapeAttr(p.id)}" type="password" value="" placeholder="留空则不改" autocomplete="off" /></label>
        <button type="button" class="secondary" data-tp="save-edit" data-id="${escapeAttr(p.id)}">保存并扫描</button>
      </div>` : ""}
      <div class="path-row">
        <input data-tp-add-model="${escapeAttr(p.id)}" value="${escapeAttr(ui.addModel[p.id] || "")}" placeholder="手填模型名后添加" />
        <button type="button" class="secondary" data-tp="add-model" data-id="${escapeAttr(p.id)}">添加</button>
      </div>
      ${p.models.length > 8 ? `<label class="field">筛选模型<input data-tp-query="1" value="${escapeAttr(ui.query)}" placeholder="搜索模型名" /></label>` : ""}
      ${modelRows ? `<div class="row-btns model-bulk">
        <button type="button" class="secondary" data-tp="select-all" data-id="${escapeAttr(p.id)}">全选</button>
        <button type="button" class="secondary" data-tp="invert" data-id="${escapeAttr(p.id)}">反选</button>
        <span class="muted">${models.filter((m) => m.enabled).length}/${models.length}${q ? "（当前筛选）" : ""}</span>
      </div>
      <ul class="model-scan-list">${modelRows}</ul>` : `<p class="muted">尚未发现模型，可扫描或手填。</p>`}
    </article>`;
  }).join("");
  root.innerHTML = `
    <div class="row-btns">
      <button type="button" class="secondary" data-tp="toggle-add">${ui.adding ? "收起新增" : "新增服务商"}</button>
      <span class="muted">已有 ${providers.length} 条</span>
    </div>
    ${ui.msg ? `<p class="status ok">${escapeAttr(ui.msg)}</p>` : ""}
    ${ui.err ? `<p class="status bad">${escapeAttr(ui.err)}</p>` : ""}
    ${ui.adding ? `<div class="provider-add">
      <label class="field">预设<select data-tp-draft="preset">${presetOpts}</select></label>
      <label class="field">名称<input data-tp-draft="name" placeholder="可空，自动从地址生成" /></label>
      <label class="field">base_url<input data-tp-draft="baseUrl" placeholder="https://api.example.com/v1" /></label>
      <label class="field">api_key<input data-tp-draft="apiKey" type="password" placeholder="sk-…" autocomplete="off" /></label>
      <label class="field">先手填一个模型（可选）<input data-tp-draft="model" placeholder="gpt-4o-mini" /></label>
      <div class="row-btns">
        <button type="button" class="primary" data-tp="add">添加并扫描</button>
      </div>
    </div>` : ""}
    ${cards || `<p class="muted">还没有服务商。点「新增服务商」加入 OpenAI / OpenRouter / 本地 Ollama 等。</p>`}
    <label class="field">视频总结：单次正文上限（token）
      <input data-k="text.summaryInputTokens" type="number" min="1000" max="2000000" step="1000" value="${Number(state.settings.text?.summaryInputTokens) || 200000}" />
      <small>默认 200,000；超过才分段。按中英文估算，不含提示词和输出。</small>
    </label>
  `;
  const draftPreset = root.querySelector("[data-tp-draft=preset]");
  if (draftPreset && ui.draftPreset) draftPreset.value = ui.draftPreset;
  const token = root.querySelector("[data-k='text.summaryInputTokens']");
  if (token) {
    token.addEventListener("change", () => writeField(token));
    token.addEventListener("input", () => writeField(token));
  }
}

function bindTextProvidersOnce() {
  const root = $("text-providers");
  if (!root || root.dataset.bound) return;
  root.dataset.bound = "1";
  root.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tp]");
    if (!btn) return;
    handleTextProviderAction(btn.dataset.tp, btn.dataset.id, btn.dataset.model).catch((err) => {
      state.textProviderUi.err = err.message || String(err);
      renderTextProviders();
    });
  });
  root.addEventListener("change", (e) => {
    const box = e.target.closest("[data-tp=toggle]");
    if (box) {
      handleTextProviderAction("toggle", box.dataset.id, box.dataset.model, box.checked).catch((err) => {
        state.textProviderUi.err = err.message || String(err);
        renderTextProviders();
      });
    }
    const draft = e.target.closest("[data-tp-draft=preset]");
    if (draft) {
      const preset = presetsFor("text").find((p) => p.id === draft.value);
      state.textProviderUi.draftPreset = draft.value;
      if (preset) {
        const url = root.querySelector("[data-tp-draft=baseUrl]");
        if (url) url.value = preset.baseUrl || "";
      }
    }
  });
  root.addEventListener("input", (e) => {
    const add = e.target.closest("[data-tp-add-model]");
    if (add) state.textProviderUi.addModel[add.getAttribute("data-tp-add-model")] = add.value;
    if (e.target.closest("[data-tp-query]")) state.textProviderUi.query = e.target.value;
  });
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const add = e.target.closest("[data-tp-add-model]");
    if (!add) return;
    e.preventDefault();
    handleTextProviderAction("add-model", add.getAttribute("data-tp-add-model")).catch((err) => {
      state.textProviderUi.err = err.message || String(err);
      renderTextProviders();
    });
  });
}

async function scanTextProvider(id) {
  const provider = providerById(id);
  if (!provider) throw new Error("找不到服务商");
  if (!provider.baseUrl.trim()) throw new Error("请先填 base_url");
  const result = await listRemoteModels({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
  replaceProvider({
    ...provider,
    models: mergeScannedModels(provider.models, result.models),
    scannedAt: new Date().toISOString(),
    scanError: "",
  });
  state.textProviderUi.msg = `已扫描 ${result.models.length} 个模型`;
  state.textProviderUi.err = "";
}

async function handleTextProviderAction(action, id, modelId, enabled) {
  const ui = state.textProviderUi;
  const root = $("text-providers");
  if (action === "toggle-add") {
    ui.adding = !ui.adding;
    ui.err = "";
    renderTextProviders();
    return;
  }
  if (action === "add") {
    const preset = root.querySelector("[data-tp-draft=preset]")?.value || "custom";
    const baseUrl = root.querySelector("[data-tp-draft=baseUrl]")?.value.trim() || "";
    const apiKey = root.querySelector("[data-tp-draft=apiKey]")?.value || "";
    const model = root.querySelector("[data-tp-draft=model]")?.value.trim() || "";
    const name = root.querySelector("[data-tp-draft=name]")?.value.trim() || suggestProviderName(baseUrl, preset);
    if (!baseUrl) throw new Error("请填写 base_url");
    const provider = normalizeProvider({
      id: newProviderId(),
      name,
      preset,
      baseUrl,
      apiKey,
      models: model ? [{ id: model, enabled: true }] : [],
    });
    state.settings.textProviders = [...(state.settings.textProviders || []), provider];
    if (model) state.settings.textRef = { providerId: provider.id, modelId: model };
    ui.adding = false;
    ui.msg = `已新增「${provider.name}」`;
    ui.err = "";
    if (baseUrl) {
      try {
        await scanTextProvider(provider.id);
      } catch (err) {
        const cur = providerById(provider.id);
        if (cur) replaceProvider({ ...cur, scanError: err.message || String(err) });
        ui.err = err.message || String(err);
      }
    }
    await persistTextCatalog();
    return;
  }
  if (action === "edit") {
    ui.editingId = ui.editingId === id ? "" : id;
    renderTextProviders();
    return;
  }
  if (action === "save-edit") {
    const provider = providerById(id);
    if (!provider) return;
    const baseUrl = root.querySelector(`[data-tp-edit=baseUrl][data-id="${CSS.escape(id)}"]`)?.value.trim() || provider.baseUrl;
    const apiKeyRaw = root.querySelector(`[data-tp-edit=apiKey][data-id="${CSS.escape(id)}"]`)?.value || "";
    replaceProvider({
      ...provider,
      baseUrl,
      apiKey: apiKeyRaw.trim() ? apiKeyRaw : provider.apiKey,
      name: provider.name || suggestProviderName(baseUrl, provider.preset),
    });
    ui.editingId = "";
    try {
      await scanTextProvider(id);
    } catch (err) {
      const cur = providerById(id);
      if (cur) replaceProvider({ ...cur, scanError: err.message || String(err) });
      ui.err = err.message || String(err);
    }
    await persistTextCatalog();
    return;
  }
  if (action === "delete") {
    state.settings.textProviders = (state.settings.textProviders || []).filter((p) => p.id !== id);
    if (state.settings.textRef?.providerId === id) state.settings.textRef = null;
    ui.msg = "已删除";
    ui.err = "";
    await persistTextCatalog();
    return;
  }
  if (action === "scan") {
    ui.err = "";
    try {
      await scanTextProvider(id);
    } catch (err) {
      const cur = providerById(id);
      if (cur) replaceProvider({ ...cur, scanError: err.message || String(err) });
      throw err;
    }
    await persistTextCatalog();
    return;
  }
  if (action === "toggle") {
    const provider = providerById(id);
    if (!provider) return;
    replaceProvider(setProviderModelEnabled(provider, modelId, enabled));
    await persistTextCatalog();
    return;
  }
  if (action === "select-all" || action === "invert") {
    const provider = providerById(id);
    if (!provider) return;
    const visibleIds = visibleProviderModelIds(provider);
    replaceProvider(action === "select-all"
      ? setAllProviderModelsEnabled(provider, true, visibleIds)
      : invertProviderModelsEnabled(provider, visibleIds));
    ui.msg = action === "select-all" ? "已全选当前列表" : "已反选当前列表";
    await persistTextCatalog();
    return;
  }
  if (action === "current") {
    state.settings.textRef = { providerId: id, modelId };
    ui.msg = `已设为当前：${modelId}`;
    await persistTextCatalog();
    return;
  }
  if (action === "add-model") {
    const provider = providerById(id);
    if (!provider) return;
    const raw = String(ui.addModel[id] || root.querySelector(`[data-tp-add-model="${CSS.escape(id)}"]`)?.value || "").trim();
    if (!raw) throw new Error("请填写模型 ID");
    replaceProvider(addProviderModel(provider, raw));
    ui.addModel[id] = "";
    ui.msg = `已加入 ${raw}`;
    if (!state.settings.textRef) state.settings.textRef = { providerId: id, modelId: raw };
    await persistTextCatalog();
  }
}

function renderSettingsForm() {
  renderTextProviders();
  $("block-asr").querySelectorAll(".field, .row-btns").forEach((n) => n.remove());
  $("block-asr").insertAdjacentHTML(
    "beforeend",
    fieldBlock("asr", state.settings.asr, {
      baseUrl: "http://127.0.0.1:8002",
      model: "可空（自建已加载）",
      key: "可空",
    }) + asrExtraFields(state.settings.asr),
  );
  $("block-tts").querySelectorAll(".field, .row-btns, .tts-ref").forEach((n) => n.remove());
  $("block-tts").insertAdjacentHTML("beforeend", ttsFields(state.settings.tts));
  refreshTtsRefLabel();
  $("mm-same").checked = state.settings.multimodalSameAsText;
  $("mm-fields").innerHTML = fieldBlock("multimodal", state.settings.multimodal);
  $("mm-fields").classList.toggle("hidden", state.settings.multimodalSameAsText);
  $("answer-lang").value = state.settings.answerLanguage;
  $("ui-font").value = state.settings.uiFont || "md";
  if ($("native-shell")) $("native-shell").checked = state.settings.nativeShell !== false;
  if ($("hitl-mode")) $("hitl-mode").value = state.settings.hitlMode || "balanced";
  if ($("skills-enabled")) $("skills-enabled").checked = skillsOn();
  if ($("daily-notes-folder")) $("daily-notes-folder").value = state.settings.dailyNotesFolder ?? "Daily";
  syncSkillFolderControls();
  renderLibraryStatus();
  renderSkillFolderStatus();
  hydrateSkillFolderStatus().catch(() => {});
  renderNativeHostStatus();
  renderShortcutList();
  bindSettingFields();
  bindTtsRefControls();
}

function paintLibraryStatus(info, extra = "") {
  const el = $("library-status");
  if (!el) return;
  const reauth = $("btn-library-reauth");
  const input = $("library-path");
  if (info?.mode === "path" && info.path && input && document.activeElement !== input) {
    input.value = info.path;
  }
  if (!info?.configured) {
    el.textContent = extra || "尚未选择";
    el.className = "status";
    reauth?.classList.add("hidden");
    return;
  }
  if (info.mode === "path") {
    reauth?.classList.add("hidden");
    if (info.granted) {
      el.textContent = extra || `路径 · ${info.path || info.name}`;
      el.className = "status ok";
      return;
    }
    el.textContent = extra || info.error || `路径不可用 · ${info.path || info.name}`;
    el.className = "status bad";
    return;
  }
  if (info.granted) {
    el.textContent = extra || `已授权 · ${info.name}（浏览器不显示完整路径）`;
    el.className = "status ok";
    reauth?.classList.add("hidden");
    return;
  }
  el.textContent = extra || `已选 ${info.name}，需要重新授权`;
  el.className = "status bad";
  reauth?.classList.remove("hidden");
}

async function refreshLibraryStatus({ request = false } = {}) {
  try {
    state.library = await libraryStatus({ request });
  } catch {
    state.library = { configured: false, granted: false, name: "" };
  }
  paintLibraryStatus(state.library);
  renderModelLine();
}

function renderLibraryStatus() {
  paintLibraryStatus(state.library);
}

function paintSkillFolderStatus(info, extra = "") {
  const el = $("skill-folder-status");
  if (!el) return;
  const reauth = $("btn-skills-reauth");
  const refresh = $("btn-skills-refresh");
  const input = $("skill-path");
  if (info?.mode === "path" && info.path && input && document.activeElement !== input) {
    input.value = info.path;
  }
  if (!skillsOn()) {
    const path = info?.path || info?.name;
    el.textContent = extra || (info?.configured ? `已关闭 · 路径仍保留${path ? ` · ${path}` : ""}` : "已关闭（默认）");
    el.className = "status";
    reauth?.classList.add("hidden");
    refresh?.classList.add("hidden");
    return;
  }
  if (!info?.configured) {
    el.textContent = extra || "尚未选择";
    el.className = "status";
    reauth?.classList.add("hidden");
    refresh?.classList.add("hidden");
    return;
  }
  if (info.mode === "path") {
    reauth?.classList.add("hidden");
    if (info.granted) {
      const n = Number(info.count) || 0;
      const cap = info.truncated ? "，已达扫描上限" : "";
      el.textContent = extra || (state.skillsMetaReady
        ? `路径 · ${info.path || info.name} · ${n} 个 skill${cap}`
        : `路径 · ${info.path || info.name} · 输入 / 时再扫描`);
      el.className = "status ok";
      refresh?.classList.remove("hidden");
      return;
    }
    el.textContent = extra || info.error || `路径不可用 · ${info.path || info.name}`;
    el.className = "status bad";
    refresh?.classList.remove("hidden");
    return;
  }
  if (info.granted) {
    const n = Number(info.count) || 0;
    const cap = info.truncated ? "，已达扫描上限" : "";
    el.textContent = extra || (state.skillsMetaReady
      ? `已授权 · ${info.name} · ${n} 个 skill${cap}（浏览器不显示完整路径）`
      : `已授权 · ${info.name} · 输入 / 时再扫描`);
    el.className = "status ok";
    reauth?.classList.add("hidden");
    refresh?.classList.remove("hidden");
    return;
  }
  el.textContent = extra || `已选 ${info.name}，需要重新授权`;
  el.className = "status bad";
  reauth?.classList.remove("hidden");
  refresh?.classList.add("hidden");
}

function renderSkillFolderStatus() {
  paintSkillFolderStatus(state.skillFolder);
}

function folderPathDirty(raw, current) {
  const next = String(raw || "").trim();
  const cur = String(current || "").trim();
  if (!next) return "";
  return next === cur ? "" : next;
}

async function applyFolderPathsFromInputs() {
  const errors = [];
  const libRaw = folderPathDirty($("library-path")?.value, state.library?.path);
  if (libRaw) {
    try {
      paintLibraryStatus(state.library, "正在验证路径…");
      state.library = await setLibraryPath(libRaw);
      paintLibraryStatus(state.library);
      if (state.pack?.captionsStatus === "ready") syncPackToLibrary(state.pack).catch(() => {});
    } catch (err) {
      const msg = err.message || String(err);
      paintLibraryStatus(state.library, msg);
      errors.push(`文稿：${msg}`);
    }
  }
  const skillRaw = folderPathDirty($("skill-path")?.value, state.skillFolder?.path);
  if (skillRaw) {
    try {
      paintSkillFolderStatus(state.skillFolder, "正在验证路径…");
      const next = await setSkillFolderPath(skillRaw);
      state.skillFolder = { ...next, count: 0 };
      clearSkillsCache();
      paintSkillFolderStatus(state.skillFolder, `已设置 ${next.path}，输入 / 时再扫描`);
    } catch (err) {
      const msg = err.message || String(err);
      paintSkillFolderStatus(state.skillFolder, msg);
      errors.push(`Skill：${msg}`);
    }
  }
  renderModelLine();
  return errors;
}

function nativeInstallCommand() {
  const id = chrome.runtime?.id || "";
  return `node native/install-native-host.mjs${id ? ` --extension-id ${id}` : ""}`;
}

function paintNativeHostStatus(info, extra = "") {
  const el = $("native-host-status");
  const idEl = $("native-host-id");
  if (idEl && chrome.runtime?.id) {
    idEl.textContent = `扩展 ID：${chrome.runtime.id}。在仓库根目录执行：${nativeInstallCommand()}`;
  } else if (idEl) {
    idEl.textContent = installHint("");
  }
  if (!el) return;
  if (extra) {
    el.textContent = extra;
    el.className = /失败|未安装|关闭|对不上|错误/.test(extra) ? "status bad" : /可用|已接通/.test(extra) ? "status ok" : "status";
    return;
  }
  if (state.settings.nativeShell === false) {
    el.textContent = "已关闭";
    el.className = "status";
    return;
  }
  if (!info?.checked) {
    el.textContent = "未检测";
    el.className = "status";
    return;
  }
  if (info.ok) {
    el.textContent = `已接通 · ${info.version || "host"}${info.ms != null ? ` · ${info.ms}ms` : ""}`;
    el.className = "status ok";
    return;
  }
  el.textContent = info.error || "未安装";
  el.className = "status bad";
}

function renderNativeHostStatus() {
  paintNativeHostStatus(state.nativeHost);
}

async function refreshNativeHost({ silent = false } = {}) {
  if (!silent) paintNativeHostStatus(state.nativeHost, "测试中…");
  const res = await pingNativeHost();
  state.nativeHost = {
    checked: true,
    ok: res.ok === true,
    version: res.version || "",
    error: res.ok ? "" : res.error || "未安装",
    ms: res.ms,
  };
  paintNativeHostStatus(state.nativeHost);
  renderModelLine();
  return state.nativeHost;
}

async function copyText(text) {
  const value = String(text || "");
  if (!value) return;
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  throw new Error("剪贴板不可用。");
}

let skillScanGen = 0;
let slash = { open: false, items: [], index: 0, token: null };

function hideSlashMenu() {
  slash = { open: false, items: [], index: 0, token: null };
  const el = $("slash-menu");
  if (!el) return;
  el.innerHTML = "";
  el.classList.add("hidden");
}

function renderSlashMenu() {
  const el = $("slash-menu");
  if (!el) return;
  el.innerHTML = "";
  if (!slash.open) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  if (!slash.items.length) {
    const empty = document.createElement("div");
    empty.className = "slash-empty";
    empty.textContent = state.skillsMetaLoading
      ? "正在扫描 skill…"
      : state.skillsMetaError
        ? state.skillsMetaError
        : (state.skills || []).length
          ? "没有匹配的 skill"
          : "没有可用 skill。到设置选择 skill 目录。";
    el.appendChild(empty);
    return;
  }
  slash.items.forEach((item, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slash-item" + (i === slash.index ? " active" : "");
    btn.setAttribute("role", "option");
    const n = document.createElement("div");
    n.className = "n";
    n.textContent = item.name;
    btn.appendChild(n);
    const detail = [item.id !== item.name ? item.id : "", item.hint].filter(Boolean).join(" · ");
    if (detail) {
      const d = document.createElement("div");
      d.className = "d";
      d.textContent = detail;
      btn.appendChild(d);
    }
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      pickSlashItem(item);
    });
    el.appendChild(btn);
  });
  el.querySelector(".slash-item.active")?.scrollIntoView({ block: "nearest" });
}

function updateSlashMenu() {
  const input = $("input");
  if (!input || state.view !== "chat" || !skillsOn()) {
    hideSlashMenu();
    return;
  }
  const token = parseSlashToken(input.value, input.selectionStart);
  if (!token) {
    hideSlashMenu();
    return;
  }
  if (state.skillsMetaLoading || !state.skillsMetaReady) {
    slash = { open: true, items: [], index: 0, token };
    renderSlashMenu();
    if (!state.skillsMetaLoading && !state.skillsMetaError) ensureSkillsMeta();
    return;
  }
  const items = filterSlashItems(slashItemsFromSkills(state.skills), token.query);
  const sameQuery = slash.open && slash.token && slash.token.query === token.query;
  slash = {
    open: true,
    items,
    index: sameQuery ? Math.min(slash.index, Math.max(0, items.length - 1)) : 0,
    token,
  };
  renderSlashMenu();
}

function pickSlashItem(item) {
  const input = $("input");
  if (!input || !item) {
    hideSlashMenu();
    return;
  }
  const token = slash.token || parseSlashToken(input.value, input.selectionStart);
  if (!token) {
    hideSlashMenu();
    return;
  }
  const next = applySlashItem(input.value, token, item);
  input.value = next.text;
  input.setSelectionRange(next.cursor, next.cursor);
  hideSlashMenu();
  fitInput();
  input.focus();
  if (item.skill) ensureSkillBody(item.skill).catch(() => {});
}

function handleSlashKey(e) {
  if (!slash.open || e.isComposing) return false;
  if (e.key === "Escape") {
    e.preventDefault();
    hideSlashMenu();
    return true;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!slash.items.length) return true;
    const delta = e.key === "ArrowDown" ? 1 : -1;
    slash.index = (slash.index + delta + slash.items.length) % slash.items.length;
    renderSlashMenu();
    return true;
  }
  if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
    if (!slash.items.length) return false;
    e.preventDefault();
    pickSlashItem(slash.items[slash.index]);
    return true;
  }
  return false;
}

let skillsMetaPromise = null;

function clearSkillsCache() {
  skillScanGen += 1;
  skillsMetaPromise = null;
  state.skills = [];
  state.skillsMetaReady = false;
  state.skillsMetaLoading = false;
  state.skillsMetaError = "";
}

async function hydrateSkillFolderStatus() {
  try {
    const status = await skillFolderStatus();
    state.skillFolder = {
      configured: status.configured,
      granted: status.granted,
      mode: status.mode || "",
      name: status.name || "",
      path: status.path || "",
      count: state.skillsMetaReady ? state.skillFolder.count || status.count || 0 : 0,
      truncated: state.skillFolder.truncated === true,
      error: status.error || "",
    };
    paintSkillFolderStatus(state.skillFolder);
  } catch (err) {
    console.warn("[pagelens] skill status", err);
  }
}

async function ensureSkillsMeta({ force = false, timeoutMs = 8000, request = false } = {}) {
  if (!skillsOn()) {
    console.info("[pagelens] skill scan skip");
    state.skills = [];
    state.skillsMetaReady = true;
    state.skillsMetaLoading = false;
    state.skillsMetaError = "";
    return state.skillFolder;
  }
  if (state.skillsMetaReady && !force) return state.skillFolder;
  if (skillsMetaPromise && !force) return skillsMetaPromise;
  const gen = ++skillScanGen;
  state.skillsMetaLoading = true;
  state.skillsMetaError = "";
  if (force) state.skillsMetaReady = false;
  if (state.skillFolder?.configured) {
    paintSkillFolderStatus(state.skillFolder, "正在扫描…");
  }
  const run = (async () => {
    try {
      const loaded = await withTimeout(
        loadRuntimeSkills({ request, timeoutMs }),
        timeoutMs,
        "扫描 skill 超时",
      );
      if (gen !== skillScanGen) return state.skillFolder;
      state.skillFolder = {
        configured: loaded.folder.configured,
        granted: loaded.folder.granted,
        mode: loaded.folder.mode || "",
        name: loaded.folder.name || "",
        path: loaded.folder.path || "",
        count: loaded.folder.count || 0,
        truncated: loaded.folder.truncated === true,
        error: loaded.folder.error || "",
      };
      state.skills = loaded.skills;
      state.skillsMetaReady = true;
      state.skillsMetaError = loaded.folder.error || "";
    } catch (err) {
      if (gen !== skillScanGen) return state.skillFolder;
      console.warn("[pagelens] skill scan timeout/error", err);
      state.skillsMetaError = err?.message || String(err);
      state.skillsMetaReady = false;
    } finally {
      if (gen === skillScanGen) {
        state.skillsMetaLoading = false;
        if (skillsMetaPromise === run) skillsMetaPromise = null;
        paintSkillFolderStatus(state.skillFolder);
        renderModelLine();
        if (slash.open) updateSlashMenu();
      }
    }
    return state.skillFolder;
  })();
  skillsMetaPromise = run;
  return run;
}

function renderShortcutList() {
  const list = $("shortcut-list");
  if (!list) return;
  list.innerHTML = "";
  if (!Array.isArray(state.settings.shortcuts)) state.settings.shortcuts = [];
  state.settings.shortcuts.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    row.innerHTML = `
      <input class="shortcut-label" data-si="${index}" data-sk="label" value="${escapeAttr(item.label)}" placeholder="芯片名，如 找槽点" />
      <textarea class="shortcut-prompt" data-si="${index}" data-sk="prompt" rows="2" placeholder="点芯片时发给模型的完整问题">${escapeAttr(item.prompt)}</textarea>
      <button type="button" class="shortcut-del" data-del="${index}" title="删除">删</button>
    `;
    list.appendChild(row);
  });
  if (!state.settings.shortcuts.length) {
    const empty = document.createElement("p");
    empty.className = "lead";
    empty.textContent = "还没有自定义问题。";
    list.appendChild(empty);
  }
  list.querySelectorAll("[data-sk]").forEach((el) => {
    el.addEventListener("input", () => {
      const i = Number(el.dataset.si);
      const key = el.dataset.sk;
      if (!state.settings.shortcuts[i]) return;
      state.settings.shortcuts[i][key] = el.value;
    });
  });
  list.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.del);
      state.settings.shortcuts.splice(i, 1);
      renderShortcutList();
    });
  });
}

function openShortcutSettings() {
  renderSettingsForm();
  setView("settings");
  $("block-shortcuts")?.scrollIntoView({ block: "start" });
}

function asrExtraFields(asr) {
  const lang = asr?.language || "";
  return `
    <label class="field">识别语言
      <select data-k="asr.language">
        <option value="" ${lang === "" ? "selected" : ""}>自动</option>
        <option value="zh" ${lang === "zh" ? "selected" : ""}>中文</option>
        <option value="en" ${lang === "en" ? "selected" : ""}>English</option>
      </select>
    </label>
  `;
}

function ttsFields(tts) {
  const presetOpts = presetsFor("tts").map(
    (p) => `<option value="${p.id}" ${p.id === tts.preset ? "selected" : ""}>${p.name}</option>`,
  ).join("");
  const langOpts = TTS_LANGS.map(
    (l) => `<option value="${l}" ${l === tts.lang ? "selected" : ""}>${l}</option>`,
  ).join("");
  return `
    <label class="field">预设
      <select data-k="tts.preset">${presetOpts}</select>
    </label>
    <label class="field">base_url
      <input data-k="tts.baseUrl" value="${escapeAttr(tts.baseUrl)}" placeholder="http://127.0.0.1:7860" />
    </label>
    <label class="field">语言
      <select data-k="tts.lang">${langOpts}</select>
    </label>
    <label class="field">时长系数 duration_factor
      <input data-k="tts.durationFactor" type="number" min="0.5" max="2" step="0.05" value="${escapeAttr(tts.durationFactor)}" />
    </label>
    <label class="field">配音准备方式
      <select data-k="tts.preparationMode">
        <option value="progressive" ${tts.preparationMode === 'progressive' ? 'selected' : ''}>快速起播，后台持续翻译与配音（推荐）</option>
        <option value="full" ${tts.preparationMode === 'full' ? 'selected' : ''}>完整配音后播放（播放时无需等待生成）</option>
        <option value="buffered" ${tts.preparationMode === 'buffered' ? 'selected' : ''}>全文翻译后，边准备配音边播放</option>
      </select>
    </label>
    <label class="field">连续配音预缓存（秒，快速模式中途缓冲时也使用）
      <input data-k="tts.bufferSeconds" type="number" min="5" max="120" step="5" value="${Number(tts.bufferSeconds) || 30}" />
    </label>
    <div class="tts-ref">
      <label class="field">参考音色
        <input id="tts-ref-file" type="file" accept="audio/wav,audio/x-wav,audio/mpeg,.wav,.mp3" />
      </label>
      <div class="row-btns">
        <button class="secondary" type="button" id="btn-tts-ref-video">从当前视频截取音色</button>
        <button class="secondary" type="button" id="btn-tts-ref-clear">清除参考音</button>
        <span class="status" id="tts-ref-status"></span>
      </div>
    </div>
    <div class="row-btns">
      <button class="secondary" type="button" data-test="tts">测试连接</button>
      <button class="secondary" type="button" id="btn-tts-preview">试听一句</button>
      <span class="status" data-test-status="tts"></span>
    </div>
  `;
}

async function refreshTtsRefLabel() {
  const el = $("tts-ref-status");
  if (!el) return;
  const rec = await getTtsRef();
  if (!rec) {
    el.textContent = "未上传";
    el.className = "status";
    return;
  }
  const kb = Math.max(1, Math.round((rec.bytes || 0) / 1024));
  el.textContent = `${rec.name || "ref.wav"} · ${kb} KB`;
  el.className = "status ok";
}

function bindTtsRefControls() {
  $("tts-ref-file")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    const el = $("tts-ref-status");
    if (!file) return;
    try {
      await setTtsRef({ blob: file, name: file.name, type: file.type });
      await refreshTtsRefLabel();
    } catch (err) {
      if (el) {
        el.textContent = err.message || String(err);
        el.className = "status bad";
      }
    }
  });
  $("btn-tts-ref-clear")?.addEventListener("click", async () => {
    await clearTtsRef();
    const input = $("tts-ref-file");
    if (input) input.value = "";
    await refreshTtsRefLabel();
  });
  $("btn-tts-ref-video")?.addEventListener("click", () => captureVoiceRef());
  $("btn-tts-preview")?.addEventListener("click", () => previewTts());
}

async function captureVoiceRef() {
  const el = $("tts-ref-status");
  if (!state.tab?.id) {
    if (el) {
      el.textContent = "先打开要配音的视频标签";
      el.className = "status bad";
    }
    return;
  }
  if (el) {
    el.textContent = "正在从当前画面录约 7 秒，请让人声清楚播放…";
    el.className = "status";
  }
  let capture = null;
  try {
    capture = await beginTabCapture(state.tab.id);
    const rec = await recordFromCapture(capture, { maxSeconds: 7, minSeconds: 3, fromStart: false });
    capture = null;
    const wav = await blobToWav(rec.blob);
    const saved = await setTtsRef({ blob: wav, name: "video-ref.wav", type: "audio/wav" });
    await refreshTtsRefLabel();
    if (el) {
      el.textContent = `已截取 ${saved.name} · 可点试听（用译文合成这个音色）`;
      el.className = "status ok";
    }
  } catch (err) {
    if (el) {
      el.textContent = err.message || String(err);
      el.className = "status bad";
    }
  } finally {
    await discardCapture(capture);
  }
}

async function previewTts() {
  const status = document.querySelector(`[data-test-status="tts"]`);
  if (!isTtsReady(state.settings.tts)) {
    if (status) {
      status.textContent = "先填配音 base_url 并上传参考音";
      status.className = "status bad";
    }
    return;
  }
  if (status) {
    status.textContent = "合成中…";
    status.className = "status";
  }
  try {
    const rec = await getTtsRef();
    if (!rec) throw new Error("请先上传参考音色 wav");
    const out = await synthesizeTts(state.settings.tts, "你好，这是 PageLens 试听。");
    const url = URL.createObjectURL(out.blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
    if (status) {
      status.textContent = "已播放";
      status.className = "status ok";
    }
  } catch (err) {
    if (status) {
      status.textContent = err.message || String(err);
      status.className = "status bad";
    }
  }
}

function bindSettingFields() {
  document.querySelectorAll("[data-k]").forEach((el) => {
    el.addEventListener("change", () => writeField(el));
    el.addEventListener("input", () => writeField(el));
  });
  document.querySelectorAll("[data-test]").forEach((btn) => {
    btn.addEventListener("click", () => runTest(btn.dataset.test));
  });
}

function writeField(el) {
  const [group, key] = el.dataset.k.split(".");
  if (!state.settings[group]) state.settings[group] = {};
  if (key === "durationFactor") state.settings[group][key] = Number(el.value) || 1;
  else if (key === "summaryInputTokens") state.settings[group][key] = Number(el.value) || 200000;
  else if (key === "bufferSegments" || key === "bufferSeconds") state.settings[group][key] = Number(el.value) || 5;
  else state.settings[group][key] = el.value;
  if (key === "preset") {
    const preset = presetsFor(group).find((p) => p.id === el.value);
    if (preset) {
      state.settings[group].baseUrl = preset.baseUrl || "";
      const input = document.querySelector(`[data-k="${group}.baseUrl"]`);
      if (input) input.value = preset.baseUrl || "";
    }
  }
}

async function runTest(group) {
  const status = document.querySelector(`[data-test-status="${group}"]`);
  const model = group === "multimodal" && state.settings.multimodalSameAsText
    ? state.settings.text
    : state.settings[group];
  if (group === "asr") {
    if (!isAsrReady(model)) {
      status.textContent = "请先填 ASR 的 base_url";
      status.className = "status bad";
      return;
    }
  } else if (group === "tts") {
    if (!isTtsReady(model)) {
      status.textContent = "请先填配音 base_url";
      status.className = "status bad";
      return;
    }
  } else if (!isModelReady(model)) {
    status.textContent = "请先填满 base_url、model_name、api_key";
    status.className = "status bad";
    return;
  }
  status.textContent = "测试中…";
  status.className = "status";
  try {
    let result;
    if (group === "asr") result = await testTranscriptions(model);
    else if (group === "tts") result = await testTts(model);
    else result = await testConnection(model);
    status.textContent = `可用 · ${result.ms}ms${result.note ? ` · ${result.note}` : ""}`;
    status.className = "status ok";
  } catch (err) {
    status.textContent = err.message || String(err);
    status.className = "status bad";
  }
}

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
    compactSegments = [];
    compactGenerationMessage = "";
    compactFullGenerating = false;
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
    compactSegments = [];
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

function currentKind(wantImage) {
  return wantImage || state.image ? "multimodal" : "text";
}

function needModelMessage(kind) {
  return kind === "multimodal"
    ? "未配置多模态模型。点右上角「设」，或勾选「与文本模型相同」。"
    : "未配置文本模型。点右上角「设」添加服务商并勾选模型。";
}

function requireModel(kind) {
  const model = resolveModel(state.settings, kind);
  if (isModelReady(model)) return model;
  console.warn("[pagelens] no-model", kind);
  const el = $("save-status");
  if (el) {
    el.textContent = needModelMessage(kind);
    el.className = "status bad";
  }
  return null;
}

function isPlaceholderBotText(text) {
  const s = String(text || "").trim();
  return !s || s === "…";
}

function paintBot(botMsg) {
  const bots = document.querySelectorAll("#msgs .msg.bot");
  const wrap = bots[bots.length - 1];
  if (!wrap) return;
  const trace = Array.isArray(botMsg.trace) ? botMsg.trace : [];
  let traceEl = wrap.querySelector(".tool-trace") || wrap.querySelector(".trace");
  if (trace.length) {
    if (!traceEl) {
      traceEl = document.createElement("div");
      traceEl.className = "tool-trace";
      wrap.querySelector(".who")?.after(traceEl);
    }
    traceEl.className = "tool-trace";
    const sig = trace.map((t) => [t.id, t.status, t.ok, t.preview?.length, t.durationMs].join(":")).join("|");
    if (traceEl.dataset.sig !== sig) {
      fillToolTrace(traceEl, trace, { live: true });
      traceEl.dataset.sig = sig;
    }
  }

  const { thinking, answer, isStreamingThinking } = splitThinking(botMsg.text, botMsg.thinking);
  const isThinkingNow = state.busy && (isStreamingThinking || (!answer && Boolean(thinking)));

  let thinkingEl = wrap.querySelector(".thinking-box");
  if (thinking) {
    if (!thinkingEl) {
      thinkingEl = createThinkingBox(thinking, { isStreaming: isThinkingNow });
      const anchor = wrap.querySelector(".tool-trace") || wrap.querySelector(".trace") || wrap.querySelector(".who");
      anchor ? anchor.after(thinkingEl) : wrap.prepend(thinkingEl);
    } else {
      updateThinkingBox(thinkingEl, thinking, { isStreaming: isThinkingNow });
    }
  } else if (thinkingEl) {
    thinkingEl.remove();
    thinkingEl = null;
  }

  let body = wrap.querySelector(".body");
  const displayText = answer || (isThinkingNow ? "" : (botMsg.text || "…"));
  if (displayText) {
    if (!body) {
      body = document.createElement("div");
      body.className = "body";
      const afterEl = thinkingEl || wrap.querySelector(".tool-trace") || wrap.querySelector(".trace") || wrap.querySelector(".who");
      if (afterEl) afterEl.after(body);
      else wrap.appendChild(body);
    }
    fillBotBody(body, displayText, { mermaid: false });
  } else if (body && !displayText) {
    body.innerHTML = "";
  }

  if (botMsg.metrics) {
    const existing = wrap.querySelector(".msg-footer");
    if (existing) existing.remove();
    wrap.appendChild(createMessageFooter(botMsg));
  }
  messageScroll?.onContentGrow();
}

function lastUserAskedForSkill() {
  const lastUser = [...state.messages].reverse().find((m) => m.role === "user" && m.text);
  return userInvokedSkill(lastUser?.text || "");
}

async function executeLoop({ userText, history, resume, turnsUsed, lastText, botMsg, model, clearImage }) {
  const useSkills = skillsOn() && lastUserAskedForSkill();
  const skills = useSkills ? [...(state.skills || []), ...shortcutsAsSkills(state.settings)] : [];
  let tools;
  let loop;
  try {
    const requestedDomains = new Set(state.activeToolDomains || []);
    tools = createAgentTools({
      getTabId: () => state.tab?.id,
      getWindowId: () => state.tab?.windowId,
      refreshPack: async (tabId) => {
        // Always re-extract the task's page. refreshTab can return a stale
        // pack during transcription, or switch targets when the user browses.
        const pack = await loadTabPack(tabId);
        if (state.tab?.id === tabId) state.pack = { ...state.pack, ...pack };
        return pack;
      },
      capture: captureTab,
      setImage: (url) => {
        state.image = url;
        renderAttach();
      },
      onTabsMutated: async () => {
        await refreshTab();
      },
      getTaskGroupId: () => state.taskGroupId,
      setTaskGroupId: (id) => {
        state.taskGroupId = id;
      },
      getTaskGroupTitle: () => {
        const user = [...state.messages].reverse().find((m) => m.role === "user" && m.text);
        const line = String(user?.text || "任务").split("\n")[0].trim().slice(0, 24);
        return `PL · ${line || "任务"}`;
      },
      getAbortSignal: () => state.abort?.signal,
      getSessionId: () => state.sessionId,
      setCaptions: applyCaptions,
      onTranscribeProgress: (info) => {
        state.transcribe = { ...(state.transcribe || {}), ...info };
        renderContext();
      },
      onRequestToolsets: (domains) => {
        for (const d of domains) {
          requestedDomains.add(d);
          state.activeToolDomains?.add?.(d);
        }
      },
      skills,
      settings: state.settings,
      nativeShell: state.settings.nativeShell !== false,
      enableSkills: useSkills,
    });

    loop = createAgentLoop({
      maxTurns: 0,
      allTools: tools,
      systemPrompt: [systemPrompt(state.settings, { useSkills }), useSkills ? skillCatalogText(skills) : ""].filter(Boolean).join("\n\n"),
      get tools() {
        const lastUser = [...state.messages].reverse().find((m) => m.role === "user" && m.text);
        return resolveActiveTools({
          userText: userText || lastUser?.text || "",
          history,
          tools,
          hasVideo: Boolean(state.pack?.hasVideo),
          requestedDomains: Array.from(requestedDomains),
        });
      },
      async interceptToolCall({ tool, args, call, signal }) {
        const hitlMode = state.settings.hitlMode || "balanced";
        const sessionOverride = Boolean(state.sessionHitlOverride);
        const req = checkHitlRequirement({
          toolName: tool.name,
          args,
          hitlMode,
          sessionOverride,
        });
        if (!req.needsConfirmation) {
          if (tool.name === "run_shell") {
            debugLog("hitl.skip", { tool: tool.name, command: args?.command || "", hitlMode });
          }
          return { allow: true };
        }

        // AI 审查中间态 (Guardrail Audit)
        if (req.needsAudit && isModelReady(resolveModel(state.settings, "text"))) {
          const lastUser = [...state.messages].reverse().find((m) => m.role === "user" && m.text);
          const audit = await auditToolCall({
            toolName: tool.name,
            args,
            userText: userText || lastUser?.text || "",
            model: resolveModel(state.settings, "text"),
            signal,
          });

          if (audit.verdict === "SAFE") {
            const shortCmd = args?.command ? ` (${String(args.command).slice(0, 24)})` : "";
            showTransientAuditNotice(`🛡️ AI 审查已放行: ${tool.name}${shortCmd}`);
            debugLog("hitl.audit", { tool: tool.name, command: args?.command || "", verdict: "SAFE", reason: audit.reason });
            return { allow: true, reason: audit.reason, audited: true };
          }

          req.reason = `⚠️ AI 审查预警 [${audit.risk.toUpperCase()}]：${audit.reason}，请人工核查！`;
          debugLog("hitl.audit", { tool: tool.name, command: args?.command || "", verdict: audit.verdict, risk: audit.risk, reason: audit.reason });
        }

        return new Promise((resolve) => {
          showHitlModal({
            toolName: tool.name,
            args,
            reason: req.reason,
            signal,
            timeoutSeconds: state.settings.hitlTimeoutSeconds || 30,
            onDecision: (decision) => {
              debugLog("hitl.decision", {
                tool: tool.name,
                command: args?.command || "",
                allow: Boolean(decision?.allow),
                reason: decision?.reason || req.reason || "",
              });
              resolve(decision);
            },
          });
        });
      },
      model: {
        async runTurn({ messages, tools: turnTools, signal, onTextDelta, onReasoningDelta }) {
          const visionReady = Boolean(state.image) && isModelReady(resolveModel(state.settings, "multimodal"));
          const active = visionReady ? resolveModel(state.settings, "multimodal") : model;
          let msgs = messages;
          if (visionReady) {
            msgs = [
              ...messages,
              { role: "user", content: multimodalUserContent("当前标签页截图：", state.image) },
            ];
          }
          return streamTurn(active, {
            messages: msgs,
            tools: turnTools,
            signal,
            onReasoningDelta,
          }, onTextDelta);
        },
      },
    });
  } catch (err) {
    console.error("[pagelens] executeLoop setup", err);
    botMsg.text = "请求失败：" + (err.message || String(err));
    botMsg.error = true;
    renderMessages();
    return;
  }
  console.info("[pagelens] executeLoop", { tools: tools.length, useSkills });

  state.busy = true;
  state.abort = new AbortController();
  state.run = {
    status: "running",
    history: history || [],
    lastText: lastText || "",
    turnsUsed: turnsUsed || 0,
    startedAt: resume && state.run?.startedAt ? state.run.startedAt : Date.now(),
  };
  setSendButton(true);

  let result = null;
  let failed = false;
  const loopStartTime = Date.now();
  try {
    try {
      renderMessages();
    } catch (err) {
      console.error("[pagelens] renderMessages", err);
    }
    ensureSessionId();
    persistSession();
    result = await loop.run(userText, {
      sessionId: state.sessionId,
      history,
      resume: Boolean(resume),
      turnsUsed: turnsUsed || 0,
      lastText: lastText || "",
      signal: state.abort.signal,
      onReasoningDelta: (delta) => {
        if (!botMsg.thinking) botMsg.thinking = "";
        botMsg.thinking += delta;
        try {
          paintBot(botMsg);
        } catch (err) {
          console.warn("[pagelens] paintBot", err);
        }
      },
      onTextDelta: (delta) => {
        if (isPlaceholderBotText(botMsg.text)) botMsg.text = "";
        botMsg.text += delta;
        try {
          paintBot(botMsg);
        } catch (err) {
          console.warn("[pagelens] paintBot", err);
        }
      },
      onEvent: (ev) => {
        try {
          if (ev.type === "checkpoint" && !ev.done) {
            state.run = {
              status: "running",
              history: ev.history,
              lastText: ev.lastText,
              turnsUsed: ev.turnsUsed,
              startedAt: state.run?.startedAt || Date.now(),
            };
            persistSession();
          }
          if (ev.type === "compressed") {
            pushTraceItem(botMsg, { kind: "meta", name: "压缩上下文", ok: true });
            paintBot(botMsg);
          }
          if (ev.type === "turn_prepared") {
            if (botMsg.thinking && !botMsg.thinking.endsWith("\n\n")) {
              botMsg.thinking += "\n\n";
            }
            if (!isPlaceholderBotText(botMsg.text)) {
              pushTraceItem(botMsg, { kind: "meta", name: "思考", ok: true });
              botMsg.text = "";
            }
            paintBot(botMsg);
          }
          if (ev.type === "model_done" && ev.content && isPlaceholderBotText(botMsg.text)) {
            botMsg.text = ev.content;
            paintBot(botMsg);
          }
          if (ev.type === "tools_start") {
            pushTraceItem(botMsg, {
              kind: "tool",
              name: ev.name,
              args: ev.args || {},
              status: "running",
              ok: null,
              preview: "",
            });
            paintBot(botMsg);
          }
          if (ev.type === "tools_done") {
            finishTraceTool(botMsg, ev);
            paintBot(botMsg);
          }
        } catch (err) {
          console.warn("[pagelens] onEvent", err);
        }
      },
    });
    if (!botMsg.error) {
      if (result?.text) botMsg.text = result.text;
      if (result?.reasoning && !botMsg.thinking) botMsg.thinking = result.reasoning;
      const parsed = splitThinking(botMsg.text, botMsg.thinking);
      if (parsed.thinking) botMsg.thinking = parsed.thinking;
      if (parsed.answer) botMsg.text = parsed.answer;
      else if (isPlaceholderBotText(botMsg.text)) {
        botMsg.text = result?.reason === "abort"
          ? "已停止。"
          : (botMsg.thinking ? "（已完成思考，未输出进一步正文）" : "模型未返回正文，请重试或检查模型服务。");
        botMsg.error = result?.reason !== "abort" && !botMsg.thinking;
      }
      if (result?.metrics) {
        botMsg.metrics = result.metrics;
        botMsg.traceLog = {
          version: "1.0",
          sessionId: state.sessionId,
          timestamp: new Date().toISOString(),
          model: (typeof model === "object" ? model?.model : String(model)) || "unknown",
          durationMs: result.metrics.durationMs,
          metrics: result.metrics,
          userPrompt: userText || "",
          thinking: botMsg.thinking || "",
          botResponse: botMsg.text || "",
          trace: botMsg.trace ? [...botMsg.trace] : [],
          steps: result.traceSteps || [],
        };
      }
      renderMessages();
    }
  } catch (err) {
    const durMs = Math.max(1, Date.now() - loopStartTime);
    const isAbort = err?.name === "AbortError" || state.stopIntent === "user";
    if (err?.name === "AbortError") {
      console.warn("[pagelens] executeLoop abort");
      botMsg.text = botMsg.text || (state.stopIntent === "user" ? "已停止。" : "已中断，重新打开侧栏会继续。");
    } else {
      console.error("[pagelens] executeLoop", err);
      botMsg.text = "请求失败：" + (err.message || String(err));
      botMsg.error = true;
      failed = true;
    }
    botMsg.metrics = {
      durationMs: durMs,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      finishReason: isAbort ? "abort" : "error",
    };
    botMsg.traceLog = {
      version: "1.0",
      sessionId: state.sessionId,
      timestamp: new Date().toISOString(),
      model: (typeof model === "object" ? model?.model : String(model)) || "unknown",
      durationMs: durMs,
      metrics: botMsg.metrics,
      userPrompt: userText || "",
      botResponse: botMsg.text || "",
      trace: botMsg.trace ? [...botMsg.trace] : [],
      steps: [],
      error: err?.message || String(err),
    };
    renderMessages();
  } finally {
    const userStop = state.stopIntent === "user";
    const finished = result?.reason === "stop" || result?.reason === "max_turns";
    if (userStop || finished || failed) state.run = null;
    state.busy = false;
    state.abort = null;
    state.stopIntent = null;
    setSendButton(false);
    if (clearImage) {
      state.image = null;
      renderAttach();
    }
    renderMessages();
    await persistSession();
    console.info("[pagelens] executeLoop done", failed ? "fail" : result?.reason || "ok");
    debugLog("agent.loop", {
      reason: failed ? "fail" : result?.reason || "ok",
      turns: result?.turnsUsed,
      sessionId: state.sessionId,
      windowId: state.windowId,
    });
  }
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label || `超时 ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function sendPrompt(userText, options = {}) {
  const text = String(userText || "").trim();
  console.info("[pagelens] sendPrompt", text.slice(0, 80) || "(empty)");
  debugLog("prompt.send", {
    chars: text.length,
    preview: text.slice(0, 80),
    sessionId: state.sessionId,
    windowId: state.windowId,
  });
  if (!text && !options.image && !state.image) {
    console.warn("[pagelens] sendPrompt empty");
    return;
  }
  if (state.view !== "chat") setView("chat");
  if (state.busy) {
    console.warn("[pagelens] sendPrompt busy, abort previous then send");
    state.stopIntent = "user";
    state.abort?.abort();
    await settleBusy();
    if (state.busy) {
      console.warn("[pagelens] sendPrompt force-clear busy");
      state.busy = false;
      state.abort = null;
      state.stopIntent = null;
    }
  }

  const image = options.image || state.image;
  messageScroll?.reset();
  state.messages.push({ role: "user", text: text || userText, image: image || null });
  const botMsg = { role: "bot", text: "…", trace: [], thinking: "" };
  state.messages.push(botMsg);
  try {
    renderMessages();
  } catch (err) {
    console.error("[pagelens] renderMessages", err);
  }

  const wantImage = Boolean(image);
  const kind = currentKind(wantImage);
  const model = requireModel(kind);
  if (!model) {
    console.warn("[pagelens] sendPrompt no-model");
    botMsg.text = needModelMessage(kind);
    botMsg.error = true;
    renderMessages();
    return;
  }

  try {
    console.info("[pagelens] sendPrompt executeLoop");
    if (state.share && state.tab) {
      try {
        await withTimeout(refreshTab(), 8000, "读当前页超时，先用已缓存内容。");
      } catch (err) {
        console.warn("[pagelens] refreshTab", err);
        pushTraceItem(botMsg, { kind: "meta", name: "读页", ok: false });
      }
    }
    const pack = state.share ? state.pack : null;
    const context = state.chatRef?.context
      || (pack ? packToContext(pack) : "（用户未分享页面）");
    botMsg.sourceTitle = state.chatRef?.title
      || (state.share ? (state.pack?.title || state.tab?.title || "") : "");
    const prior = [];
    for (const m of state.messages.slice(0, -2)) {
      if (m.error || (m.role === "bot" && !m.text)) continue;
      if (m.role === "user") prior.push({ role: "user", content: m.text });
      if (m.role === "bot") prior.push({ role: "assistant", content: m.text });
    }
    let loopText = text || userText;
    if (skillsOn() && userInvokedSkill(loopText)) {
      try {
        await ensureSkillsMeta();
      } catch (err) {
        console.warn("[pagelens] skills meta", err);
        pushTraceItem(botMsg, { kind: "meta", name: "skill 扫描", ok: false });
      }
      const runtimeSkills = [...(state.skills || []), ...shortcutsAsSkills(state.settings)];
      try {
        loopText = await withTimeout(
          composeSkillPrompt(loopText, runtimeSkills, { loadBody: ensureSkillBody }),
          8000,
          "读取 skill 超时",
        );
      } catch (err) {
        console.warn("[pagelens] skill body", err);
        pushTraceItem(botMsg, { kind: "meta", name: "读取 skill", ok: false });
      }
    }
    await executeLoop({
      userText: context ? `${loopText}\n\n${context}` : loopText,
      history: prior,
      resume: false,
      botMsg,
      model,
      clearImage: options.clearImage,
    });
    console.info("[pagelens] sendPrompt ok");
  } catch (err) {
    console.error("[pagelens] sendPrompt fail", err);
    botMsg.text = "请求失败：" + (err.message || String(err));
    botMsg.error = true;
    state.busy = false;
    renderMessages();
  }
}

async function resumeInterruptedRun() {
  const run = state.run;
  if (!isResumableRun(run)) return;
  const model = requireModel("text");
  if (!model) return;
  if (state.share && state.tab) await refreshTab();

  let botMsg = state.messages[state.messages.length - 1];
  if (!botMsg || botMsg.role !== "bot") {
    botMsg = { role: "bot", text: run.lastText || "", trace: [] };
    state.messages.push(botMsg);
  } else if (!botMsg.text) {
    botMsg.text = run.lastText || "";
  }
  botMsg.trace = Array.isArray(botMsg.trace) ? botMsg.trace : [];
  if (!botMsg.trace.some((t) => t.name === "从中断处继续")) {
    botMsg.trace.unshift({ kind: "meta", name: "从中断处继续", ok: true });
  }

  await executeLoop({
    userText: "",
    history: run.history,
    resume: true,
    turnsUsed: run.turnsUsed,
    lastText: run.lastText,
    botMsg,
    model,
  });
}

async function runSkill(skill) {
  const prompt = String(skill?.prompt || "").trim();
  console.info("[pagelens] chip", skill?.label || "", prompt.slice(0, 80));
  if (!prompt) {
    console.warn("[pagelens] chip empty prompt");
    return;
  }
  if (skill.image) {
    const shot = await captureTab();
    if (!shot) return;
    state.image = shot;
    renderAttach();
    await sendPrompt(prompt, { image: shot, clearImage: true });
    return;
  }
  await sendPrompt(prompt);
}

function applyCaptions(caps) {
  if (!caps) return;
  const capTabId = caps.tabId;
  let pack = null;
  if (typeof packForMediaWrite === "function") {
    pack = packForMediaWrite(capTabId);
  } else if (capTabId == null || capTabId === state.tab?.id) {
    pack = (state.pack ||= {});
  } else if (state.mediaTab?.id === capTabId) {
    pack = (state.mediaPack ||= {});
  }
  if (!pack) return;
  if (pack.captionsComplete && caps.complete !== true && caps.source === "interpret") {
    renderContext();
    return;
  }
  pack.captionsStatus = caps.status;
  pack.captionsText = caps.text;
  pack.captionsSource = caps.source;
  pack.captionsCues = caps.cues;
  pack.captionsComplete = caps.complete === true;
  renderContext();
  if (caps.status === "ready") syncPackToLibrary(pack).catch(() => {});
}

function stopInterpret(tabId) {
  const targetId = tabId || state.mediaTab?.id || state.tab?.id;
  interpretController.stop(targetId).catch(() => {});
}


function needAsrSettings(message) {
  renderSettingsForm();
  setView("settings");
  $("save-status").textContent = message || "先配置语音转写（ASR）的 base_url";
  $("save-status").className = "status bad";
  $("block-asr")?.scrollIntoView({ block: "start" });
}

async function startTranscribe({ force = false } = {}) {
  const target = (typeof mediaActionTab === "function" ? mediaActionTab() : null) || state.tab;
  if (!target?.id) return null;
  if (isTranscribing()) {
    state.workAbort?.abort();
    return null;
  }
  if (state.busy) return null;
  const tab = { ...target };
  const abort = new AbortController();
  state.workAbort = abort;
  state.transcribe = { status: "extracting", hint: "正在优先获取完整字幕" };
  renderContext();
  try {
    const caps = await transcribeTab({
      tabId: tab.id, settings: state.settings, force, signal: abort.signal,
      onProgress: (info) => {
        if (state.workAbort !== abort) return;
        state.transcribe = { ...(state.transcribe || {}), ...info };
        renderContext();
      },
    });
    abort.signal.throwIfAborted();
    applyCaptions({ ...caps, tabId: caps.tabId ?? tab.id });
    state.transcribe = { status: "done" };
    renderContext();
    return caps;
  } catch (err) {
    state.transcribe = err?.name === "AbortError" ? { status: "idle" } : { status: "error", error: err.message || String(err) };
    renderContext();
    return null;
  } finally {
    if (state.workAbort === abort) state.workAbort = null;
  }
}

async function startSummarizeVideo() {
  if (isTranscribing()) {
    state.workAbort?.abort();
    return;
  }
  if (state.busy) return;
  const model = requireModel("text");
  if (!model) {
    pushError(needModelMessage("text"));
    return;
  }
  const sourcePack = (typeof packForMedia === "function" && packForMedia()) || state.pack;
  const packed = usableTranscript({
    status: sourcePack?.captionsStatus,
    text: sourcePack?.captionsText,
    cues: sourcePack?.captionsCues,
    source: sourcePack?.captionsSource,
    complete: sourcePack?.captionsComplete === true,
  });
  let caps = packed?.complete ? packed : null;
  if (!caps?.text) {
    const extracted = await startTranscribe();
    if (!extracted && state.transcribe?.status === "idle") return;
    caps = extracted?.complete ? usableTranscript(extracted) : null;
  }
  if (!caps?.text) {
    pushError(state.transcribe?.error || "没有可总结的完整文稿。请配置 ASR 并启动本机媒体服务，或确认视频包含字幕。");
    return;
  }
  const title = sourcePack?.title || state.mediaTab?.title || state.pack?.title || state.tab?.title;
  const abort = new AbortController();
  state.busy = true;
  state.abort = abort;
  state.videoSummary = { title, text: "正在阅读完整文稿…", metrics: null, error: false };
  if (typeof paintVideoSummary === "function") paintVideoSummary();
  if (typeof messageScroll !== "undefined") messageScroll?.reset();
  state.messages.push({ role: "user", text: "总结视频内容，重点解释核心观点、论据和结论，时间轴仅作为文末补充。" });
  const botMsg = { role: "bot", text: "正在阅读完整文稿…", trace: [], sourceTitle: title };
  state.messages.push(botMsg);
  if ($("btn-send")) {
    $("btn-send").textContent = "■";
    $("btn-send").title = "停止";
  }
  renderMessages();
  renderContext();
  const sumStart = Date.now();
  let summaryText = "";
  try {
    botMsg.text = await summarizeTranscript({
      text: caps.text, title, model, language: state.settings.answerLanguage, signal: abort.signal,
      onProgress: hint => { botMsg.text = hint; paintBot(botMsg); },
      onDelta: delta => { summaryText += delta; botMsg.text = summaryText; paintBot(botMsg); },
    });
    const durMs = Math.max(1, Date.now() - sumStart);
    const inTok = estimateTokens(caps.text + " " + (title || ""));
    const outTok = estimateTokens(botMsg.text || "");
    botMsg.metrics = {
      durationMs: durMs,
      inputTokens: inTok,
      outputTokens: outTok,
      totalTokens: inTok + outTok,
      finishReason: "stop",
    };
    botMsg.traceLog = {
      version: "1.0",
      sessionId: state.sessionId,
      timestamp: new Date().toISOString(),
      model: model?.model || "unknown",
      durationMs: durMs,
      metrics: botMsg.metrics,
      userPrompt: "总结视频内容，重点解释核心观点、论据和结论，时间轴仅作为文末补充。",
      botResponse: botMsg.text,
      trace: [{ name: "总结文稿", ok: true }],
      steps: [{ type: "summarize_transcript", durationMs: durMs, timestamp: Date.now() }],
    };
    state.videoSummary = { title, text: botMsg.text, metrics: botMsg.metrics, error: false };
    if (typeof paintVideoSummary === "function") paintVideoSummary();
  } catch (error) {
    const durMs = Math.max(1, Date.now() - sumStart);
    botMsg.text = error?.name === 'AbortError' ? '已停止总结，完整文稿已保留。' : `全文总结失败：${error.message || error}`;
    botMsg.error = error?.name !== 'AbortError';
    botMsg.metrics = {
      durationMs: durMs,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      finishReason: error?.name === 'AbortError' ? 'abort' : 'error',
    };
    botMsg.traceLog = {
      version: "1.0",
      sessionId: state.sessionId,
      timestamp: new Date().toISOString(),
      model: model?.model || "unknown",
      durationMs: durMs,
      metrics: botMsg.metrics,
      userPrompt: "总结视频内容，重点解释核心观点、论据和结论，时间轴仅作为文末补充。",
      botResponse: botMsg.text,
      trace: [{ name: "总结文稿", ok: false }],
      steps: [],
      error: error?.message || String(error),
    };
    state.videoSummary = { title, text: botMsg.text, metrics: botMsg.metrics, error: botMsg.error };
    if (typeof paintVideoSummary === "function") paintVideoSummary();
  } finally {
    state.busy = false;
    state.abort = null;
    state.stopIntent = null;
    if ($("btn-send")) {
      $("btn-send").textContent = "↑";
      $("btn-send").title = "发送（Enter）";
    }
    renderMessages();
    renderContext();
    await persistSession();
  }
}

async function toggleOriginalAudio() {
  const id = state.mediaTab?.id || state.tab?.id;
  if (!id) return;
  try {
    const next = await interpretController.toggleOriginalAudio(id);
    state.originalAudioOn = next;
    renderContext();
  } catch (err) {
    pushError("无法切换原声：" + (err?.message || err));
  }
}

async function startInterpret() {
  const target = (typeof mediaActionTab === "function" ? mediaActionTab() : null) || state.tab;
  try { if (typeof getSharedAudioContext === 'function') getSharedAudioContext(); } catch {}
  stopCompactPlayback();
  await compactController.stop(target?.id);
  if (!target?.id) return;
  if (interpretController.isRunning(target.id)) {
    await interpretController.stop(target.id);
    if (typeof releaseMediaSourceIfIdle === "function") releaseMediaSourceIfIdle();
    return;
  }
  compactSegments = [];
  if (!isAsrReady(state.settings.asr)) {
    needAsrSettings("按声音同传需要先配置语音转写（ASR）");
    return;
  }
  if (!requireModel("text")) {
    pushError(needModelMessage("text"));
    return;
  }

  if (typeof bindMediaSource === "function") {
    bindMediaSource(target, (state.tab?.id === target.id ? state.pack : state.mediaPack) || state.pack);
  }
  try {
    await interpretController.start({
      tab: target,
      settings: state.settings,
      onCaptionsReady: (captions) => {
        const id = captions.tabId ?? target.id;
        const pack = state.tab?.id === id ? state.pack : (state.mediaTab?.id === id ? state.mediaPack : state.pack);
        if (pack?.captionsComplete && captions.complete !== true) return;
        applyCaptions({ ...captions, tabId: id });
      },
    });
  } catch (err) {
    pushError("同传启动失败：" + (err?.message || err));
  }
}

async function captureTab(tabId) {
  if (!tabId && !state.tab) await refreshTab();
  const id = tabId || state.tab?.id;
  if (!id && state.tab?.windowId == null) {
    pushError("没有可截取的标签");
    return null;
  }
  try {
    return await captureVisible(id, state.tab?.windowId);
  } catch (err) {
    pushError("截图失败：" + err.message);
    return null;
  }
}

function renderAttach() {
  const row = $("attach-row");
  if (!row) return;
  row.classList.toggle("hidden", !state.image);
  if (state.image && $("attach-thumb")) $("attach-thumb").src = state.image;
}

async function consumePending() {
  const data = await chrome.storage.session.get(["pendingSelection", "pendingClip", "pendingReview"]);
  if (data.pendingClip) {
    await chrome.storage.session.remove("pendingClip");
    openClipModal(data.pendingClip);
    return;
  }
  if (data.pendingReview) {
    await chrome.storage.session.remove("pendingReview");
    setView("review");
    return;
  }
  const pendingSelection = data.pendingSelection;
  if (!pendingSelection) return;
  await chrome.storage.session.remove("pendingSelection");
  if ($("input")) {
    $("input").value = `关于这段选区：\n${pendingSelection}\n\n请解释它在本页里的含义。`;
    $("input").focus();
  }
}

function bindComposer() {
  if (composerBound) return;
  composerBound = true;
  on("btn-send", "click", () => {
    try {
      const text = $("input")?.value?.trim();
      if (!text) {
        if (state.busy) {
          console.info("[pagelens] sendPrompt busy-stop");
          state.stopIntent = "user";
          state.abort?.abort();
          setModelLineMeta("已请求停止上一轮");
        } else {
          console.info("[pagelens] sendPrompt empty");
        }
        return;
      }
      if ($("input")) $("input").value = "";
      hideSlashMenu();
      fitInput();
      sendPrompt(text, { clearImage: true }).catch((err) => {
        console.error("[pagelens] send", err);
        pushError("发送失败：" + (err.message || err));
      });
    } catch (err) {
      console.error("[pagelens] click send", err);
      pushError("发送失败：" + (err.message || err));
    }
  });
  on("input", "keydown", (e) => {
    if (handleSlashKey(e)) return;
    if (e.key !== "Enter" || e.isComposing) return;
    if (e.shiftKey) return;
    e.preventDefault();
    $("btn-send")?.click();
  });
  on("input", "input", () => {
    fitInput();
    updateSlashMenu();
  });
  on("input", "click", updateSlashMenu);
  on("input", "keyup", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
      updateSlashMenu();
    }
  });
  $("text-model-pick")?.addEventListener("change", async (e) => {
    const value = String(e.target.value || "");
    const sep = value.indexOf("::");
    if (sep < 0) return;
    state.settings.textRef = { providerId: value.slice(0, sep), modelId: value.slice(sep + 2) };
    syncTextCatalog();
    try {
      state.settings = await saveSettings(state.settings);
    } catch {
      /* keep local selection */
    }
    renderModelLine();
  });
  console.info("[pagelens] wire send", Boolean($("btn-send")), "shortcuts", Boolean($("skills")));
}

function wire() {
  messageScroll ||= createMessageScroll($("msgs"), $("btn-messages-bottom"));
  $("btn-debug-export")?.addEventListener("click", async () => {
    const json = await exportDebugLogFresh();
    downloadText(`pagelens-debug-${Date.now()}.json`, json, "application/json");
  });
  bindComposer();
  try {
  on("btn-settings", "click", () => {
    if (state.view === "settings") {
      setView("chat");
      return;
    }
    renderSettingsForm();
    setView("settings");
  });
  on("btn-media-toggle", "click", () => {
    state.mediaExpanded = !state.mediaExpanded;
    writeUiPref("mediaExpanded", state.mediaExpanded);
    applyMediaLayout();
    renderMediaChrome();
  });
  on("btn-media-tools", "click", () => {
    state.toolsExpanded = !state.toolsExpanded;
    writeUiPref("toolsExpanded", state.toolsExpanded);
    applyMediaLayout();
  });
  on("btn-tasks-toggle", "click", () => {
    state.tasksExpanded = !state.tasksExpanded;
    writeUiPref("tasksExpanded", state.tasksExpanded);
    applyMediaLayout();
  });
  on("btn-media-mini-pause", "click", () => toggleMiniPlayback());
  on("btn-back-video", "click", () => backToVideoTab());
  on("btn-summarize-page", "click", () => startSummarizePage());
  on("btn-cite-transcript", "click", () => citeTranscript());
  on("btn-clear-ref", "click", () => onComposerChipAction());
  on("btn-video-summary-cite", "click", () => citeVideoSummary());
  on("btn-video-summary-close", "click", () => {
    $("video-summary-result")?.classList.add("hidden");
  });
  on("btn-video-summary-clip", "click", () => {
    if (!state.videoSummary?.text) return;
    openClipModal({ role: "bot", text: state.videoSummary.text, metrics: state.videoSummary.metrics });
  });
  on("btn-add-video", "click", () => toggleVideoPicker());
  on("btn-download-audio", "click", () => downloadCompactAudio());
  on("btn-back", "click", async () => {
    try {
      const pathErrors = await applyFolderPathsFromInputs();
      if (pathErrors.length) flashStatus(pathErrors.join(" "), false);
    } catch (err) {
      console.warn("[pagelens] apply paths", err);
    }
    renderSkills();
    renderMessages();
    setView("chat");
  });
  on("btn-add-shortcut", "click", () => {
    if (!Array.isArray(state.settings.shortcuts)) state.settings.shortcuts = [];
    state.settings.shortcuts.push({ id: crypto.randomUUID(), label: "", prompt: "" });
    renderShortcutList();
  });
  on("btn-new", "click", () => {
    startNewSession();
  });
  on("btn-history", "click", () => {
    if (state.view === "history") {
      setView("chat");
      return;
    }
    openHistoryView();
  });
  on("btn-hist-back", "click", () => {
    setView("chat");
  });
  on("btn-export-all-md", "click", () => exportAll("md"));
  on("btn-export-all-json", "click", () => exportAll("json"));
  on("btn-import-all-obsidian", "click", () => importAllToLibrary());
  on("btn-obsidian", "click", () => importCurrentToLibrary());
  on("btn-clip-cancel", "click", () => closeClipModal());
  on("btn-clip-cancel-x", "click", () => closeClipModal());
  on("btn-clip-confirm", "click", () => submitClipModal());
  on("btn-recall-open", "click", () => openClipViewModal());
  on("btn-recall-dismiss", "click", () => dismissRecallBanner());
  on("btn-clip-view-close", "click", () => closeClipViewModal());
  on("btn-clip-view-done", "click", () => closeClipViewModal());
  initReviewView();
  on("hist-q", "input", () => {
    state.histQuery = $("hist-q").value;
    renderHistory();
  });
  on("btn-unpin", "click", () => dismissPageContext());
  on("btn-pin-page", "click", () => restorePageContext());
  on("btn-transcribe", "click", () => {
    const capsReady = state.pack?.captionsStatus === "ready";
    startTranscribe({ force: capsReady });
  });
  $("btn-summarize-video")?.addEventListener("click", () => startSummarizeVideo());
  $("btn-interpret")?.addEventListener("click", () => {
    getSharedAudioContext();
    startInterpret();
  });
  $("btn-compact-player")?.addEventListener("click", () => {
    getSharedAudioContext();
    $("compact-player-bar")?.classList.remove("hidden");
    void toggleCompactPlayback();
  });
  $("btn-compact-bar")?.addEventListener("click", () => {
    getSharedAudioContext();
    $("compact-player-bar")?.classList.remove("hidden");
    void toggleCompactPlayback();
  });
  $("cp-play-btn")?.addEventListener("click", () => {
    toggleCompactPlayback();
  });
  $("cp-rate-btn")?.addEventListener("click", () => changeCompactRate());
  $("btn-generate-full")?.addEventListener("click", () => generateFullCompactAudio().catch(err => pushError(err.message)));
  $("btn-clear-dub-cache")?.addEventListener("click", () => clearCurrentDubbingCache().catch(err => pushError(err.message)));
  $("cp-regen-btn")?.addEventListener("click", () => regenerateCurrentDubbing());
  $("btn-regen-dub")?.addEventListener("click", () => regenerateCurrentDubbing());
  $("cp-download-btn")?.addEventListener("click", () => downloadCompactAudio());
  $("cp-close-btn")?.addEventListener("click", () => closeCompactPlayer());
  const cpSlider = $("cp-slider");
  if (cpSlider) {
    cpSlider.addEventListener("input", (e) => {
      cpSlider.dataset.dragging = "true";
      const ratio = Number(e.target.value) / 1000;
      const dur = getCompactDuration();
      const timeEl = $("cp-time");
      if (timeEl && dur > 0) {
        timeEl.textContent = `${formatTime(ratio * dur)} / ${formatTime(dur)}`;
      }
    });
    cpSlider.addEventListener("change", (e) => {
      delete cpSlider.dataset.dragging;
      const ratio = Number(e.target.value) / 1000;
      seekCompactPlayback(ratio);
    });

  }
  $("btn-play-archive")?.addEventListener("click", () => toggleDubPlayback());
  $("btn-original-audio")?.addEventListener("click", () => toggleOriginalAudio());
  const primeAudioContext = () => {
    try {
      const ctx = typeof getSharedAudioContext === 'function' ? getSharedAudioContext() : null;
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
    } catch {}
  };
  window.addEventListener("click", primeAudioContext, { capture: true, passive: true });
  window.addEventListener("pointerdown", primeAudioContext, { capture: true, passive: true });
  window.addEventListener("keydown", primeAudioContext, { capture: true, passive: true });

  $("btn-summarize-bar")?.addEventListener("click", () => startSummarizeVideo());
  $("btn-interpret-bar")?.addEventListener("click", () => {
    getSharedAudioContext();
    startInterpret();
  });
  $("btn-video-switch")?.addEventListener("click", async () => {
    if (!state.tab?.id) return;
    const n = Number(state.pack?.videoCount) || (Array.isArray(state.pack?.videos) ? state.pack.videos.length : 0);
    if (n < 2) return;
    const cur = Number.isInteger(state.pack?.videoIndex) ? state.pack.videoIndex : 0;
    const next = (cur + 1) % n;
    try {
      await injectVideo(state.tab.id, "select", { index: next });
      await refreshTab();
    } catch (err) {
      pushError("无法切换画面：" + (err?.message || err));
    }
  });
  on("btn-library-pick", "click", async () => {
    const el = $("library-status");
    try {
      const picked = await pickLibraryFolder();
      if ($("library-path")) $("library-path").value = "";
      state.library = { configured: true, granted: true, mode: "picker", name: picked.name, path: "" };
      paintLibraryStatus(state.library, `已选择 ${picked.name}`);
      renderModelLine();
      if (state.pack?.captionsStatus === "ready") syncPackToLibrary(state.pack).catch(() => {});
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (el) {
        el.textContent = err.message || String(err);
        el.className = "status bad";
      }
    }
  });
  on("btn-library-path", "click", async () => {
    const el = $("library-status");
    const raw = $("library-path")?.value.trim() || "";
    if (!raw) {
      if (el) {
        el.textContent = "先填绝对路径或 ~ 路径。";
        el.className = "status bad";
      }
      return;
    }
    try {
      paintLibraryStatus(state.library, "正在验证路径…");
      const next = await setLibraryPath(raw);
      state.library = next;
      paintLibraryStatus(state.library);
      renderModelLine();
      if (state.pack?.captionsStatus === "ready") syncPackToLibrary(state.pack).catch(() => {});
    } catch (err) {
      if (el) {
        el.textContent = err.message || String(err);
        el.className = "status bad";
      }
    }
  });
  $("library-path")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("btn-library-path")?.click();
    }
  });
  on("btn-library-reauth", "click", async () => {
    const el = $("library-status");
    try {
      await refreshLibraryStatus({ request: true });
      if (state.library?.granted) {
        if (state.pack?.captionsStatus === "ready") syncPackToLibrary(state.pack).catch(() => {});
        return;
      }
      const picked = await pickLibraryFolder();
      if ($("library-path")) $("library-path").value = "";
      state.library = { configured: true, granted: true, mode: "picker", name: picked.name, path: "" };
      paintLibraryStatus(state.library, `已重新授权 · ${picked.name}`);
      renderModelLine();
      if (state.pack?.captionsStatus === "ready") syncPackToLibrary(state.pack).catch(() => {});
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (el) {
        el.textContent = err.message || String(err);
        el.className = "status bad";
      }
    }
  });
  on("btn-library-clear", "click", async () => {
    await clearSavedHandle();
    if ($("library-path")) $("library-path").value = "";
    state.library = { configured: false, granted: false, name: "", path: "", mode: "" };
    paintLibraryStatus(state.library, "已清除（磁盘上的文件还在）");
    renderModelLine();
  });
  $("btn-skills-pick")?.addEventListener("click", async () => {
    const el = $("skill-folder-status");
    try {
      const picked = await pickSkillFolder();
      if ($("skill-path")) $("skill-path").value = "";
      state.skillFolder = { configured: true, granted: true, mode: "picker", name: picked.name, path: "", count: 0 };
      clearSkillsCache();
      paintSkillFolderStatus(state.skillFolder, `已选择 ${picked.name}，输入 / 时再扫描`);
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (el) {
        el.textContent = err.message || String(err);
        el.className = "status bad";
      }
    }
  });
  $("btn-skills-path")?.addEventListener("click", async () => {
    const el = $("skill-folder-status");
    const raw = $("skill-path")?.value.trim() || "";
    if (!raw) {
      if (el) {
        el.textContent = "先填绝对路径或 ~ 路径。";
        el.className = "status bad";
      }
      return;
    }
    try {
      paintSkillFolderStatus(state.skillFolder, "正在验证路径…");
      const next = await setSkillFolderPath(raw);
      state.skillFolder = { ...next, count: 0 };
      clearSkillsCache();
      paintSkillFolderStatus(state.skillFolder, `已设置 ${next.path}，输入 / 时再扫描`);
    } catch (err) {
      if (el) {
        el.textContent = err.message || String(err);
        el.className = "status bad";
      }
    }
  });
  $("skill-path")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("btn-skills-path")?.click();
    }
  });
  $("btn-skills-reauth")?.addEventListener("click", async () => {
    if (!skillsOn()) return;
    const el = $("skill-folder-status");
    try {
      const res = await skillFolderStatus({ request: true });
      if (!res?.granted) {
        const picked = await pickSkillFolder();
        state.skillFolder = { configured: true, granted: true, mode: "picker", name: picked.name, path: "", count: 0 };
      }
      clearSkillsCache();
      await hydrateSkillFolderStatus();
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (el) {
        el.textContent = err.message || String(err);
        el.className = "status bad";
      }
    }
  });
  $("btn-skills-refresh")?.addEventListener("click", async () => {
    if (!skillsOn()) return;
    await ensureSkillsMeta({ force: true, timeoutMs: 15000, request: true });
  });
  $("btn-skills-clear")?.addEventListener("click", async () => {
    await clearSkillFolderHandle();
    if ($("skill-path")) $("skill-path").value = "";
    state.skillFolder = { configured: false, granted: false, name: "", path: "", mode: "", count: 0 };
    clearSkillsCache();
    paintSkillFolderStatus(state.skillFolder, "已清除（磁盘上的 skill 还在）");
    renderModelLine();
  });
  $("skills-enabled")?.addEventListener("change", (e) => {
    state.settings.skillsEnabled = e.target.checked;
    clearSkillsCache();
    if (!e.target.checked) hideSlashMenu();
    syncSkillFolderControls();
    paintSkillFolderStatus(state.skillFolder);
    renderModelLine();
  });
  on("btn-save", "click", async () => {
    if ($("daily-notes-folder")) {
      state.settings.dailyNotesFolder = $("daily-notes-folder").value.trim();
    }
    const pathErrors = await applyFolderPathsFromInputs();
    state.settings = await saveSettings(state.settings);
    applyUiFont(state.settings.uiFont);
    renderModelLine();
    renderShortcutList();
    if (pathErrors.length) {
      $("save-status").textContent = `设置已保存，路径未生效：${pathErrors.join(" ")}`;
      $("save-status").className = "status bad";
      return;
    }
    $("save-status").textContent = "已保存到本机";
    $("save-status").className = "status ok";
  });
  on("mm-same", "change", (e) => {
    state.settings.multimodalSameAsText = e.target.checked;
    $("mm-fields")?.classList.toggle("hidden", e.target.checked);
  });
  on("answer-lang", "change", (e) => {
    state.settings.answerLanguage = e.target.value;
  });
  on("ui-font", "change", (e) => {
    state.settings.uiFont = e.target.value;
    applyUiFont(state.settings.uiFont);
  });
  $("native-shell")?.addEventListener("change", (e) => {
    state.settings.nativeShell = e.target.checked;
    paintNativeHostStatus(state.nativeHost);
    renderModelLine();
  });
  $("hitl-mode")?.addEventListener("change", (e) => {
    state.settings.hitlMode = e.target.value;
    updateHitlBadge();
  });
  $("hitl-badge")?.addEventListener("click", () => {
    state.sessionHitlOverride = false;
    state.settings.hitlMode = "balanced";
    saveSettings(state.settings).catch(() => {});
    updateHitlBadge();
    if ($("hitl-mode")) $("hitl-mode").value = "balanced";
  });
  $("btn-native-copy-id")?.addEventListener("click", async () => {
    try {
      await copyText(chrome.runtime.id);
      paintNativeHostStatus(state.nativeHost, "已复制扩展 ID");
    } catch (err) {
      paintNativeHostStatus(state.nativeHost, err.message || String(err));
    }
  });
  $("btn-native-copy-install")?.addEventListener("click", async () => {
    try {
      await copyText(nativeInstallCommand());
      paintNativeHostStatus(state.nativeHost, "已复制安装命令");
    } catch (err) {
      paintNativeHostStatus(state.nativeHost, err.message || String(err));
    }
  });
  $("btn-native-test")?.addEventListener("click", async () => {
    await refreshNativeHost();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!slash.open) return;
    const menu = $("slash-menu");
    const input = $("input");
    if (menu?.contains(e.target) || input?.contains(e.target)) return;
    hideSlashMenu();
  });
  on("btn-shot", "click", async () => {
    const shot = await captureTab();
    if (!shot) return;
    state.image = shot;
    renderAttach();
  });
  on("btn-clear-attach", "click", () => {
    state.image = null;
    renderAttach();
  });
  chrome.tabs?.onActivated?.addListener(() => {
    refreshTab();
  });
  chrome.tabs?.onUpdated?.addListener((tabId, info, tab) => {
    if (tab.active && (info.status === "complete" || info.title || info.url)) {
      refreshTab();
    }
  });
  window.addEventListener("pagehide", () => {
    persistSession();
    state.recordAbort?.abort();
    state.workAbort?.abort();
    state.siAbort?.abort();
    abortRecording();
  });
  } catch (err) {
    console.error("[pagelens] wire rest", err);
  }
}

function markWired() {
  document.documentElement.dataset.pagelensWired = "1";
  const line = $("model-line");
  if (line) line.dataset.pagelensBoot = "1";
}

setTimeout(() => {
  if (document.documentElement.dataset.pagelensWired) return;
  const line = $("model-line");
  if (!line || line.dataset.pagelensBoot) return;
  line.textContent = "侧栏脚本未启动。请在侧栏空白处右键→检查，看 [pagelens] 日志（不要看 chrome://extensions 的 Service Worker）。";
}, 3000);

async function boot() {
  console.info("[pagelens] boot");
  try {
    try {
      initMarkdown();
    } catch (err) {
      console.warn("[pagelens] initMarkdown", err);
    }
    try {
      state.settings = (await applyOptionalLocalSettings()) || (await loadSettings());
      applyUiFont(state.settings.uiFont);
    } catch (err) {
      console.error("[pagelens] boot settings", err);
      state.settings = defaultSettings();
    }
    state.mediaExpanded = readUiPref("mediaExpanded", true);
    state.toolsExpanded = readUiPref("toolsExpanded", false);
    state.tasksExpanded = readUiPref("tasksExpanded", true);
    wire();
    markWired();
    applyMediaLayout();
    renderComposerChip();
    syncComposerHints();
    renderModelLine();
    updateHitlBadge();
    renderSkills();
    renderMessages();
    console.info("[pagelens] wired");
  } catch (err) {
    console.error("[pagelens] boot ui", err);
    try {
      bindComposer();
      markWired();
    } catch (bindErr) {
      console.error("[pagelens] bindComposer", bindErr);
    }
    setModelLineMeta("启动失败：" + (err?.message || err));
  }
  refreshLibraryStatus().catch((err) => console.warn("[pagelens] library", err));
  refreshNativeHost({ silent: true }).catch(() => {});
  try {
    await resolveWindowId();
    const active = await loadActiveSession(state.windowId);
    debugLog("session.boot", {
      windowId: state.windowId,
      sessionId: active?.id || null,
      restored: Boolean(active?.messages?.length),
    });
    if (active?.messages?.length) {
      applySession(active);
      renderMessages();
    }
  } catch (err) {
    console.warn("[pagelens] session", err);
  }
  refreshTab().catch((err) => console.warn("[pagelens] tab", err));
  cleanExpiredMediaArchives().catch(() => {});
  consumePending().catch(() => {});
  if (!isModelReady(resolveModel(state.settings, "text"))) {
    console.warn("[pagelens] boot no-model");
    try {
      renderSettingsForm();
    } catch (err) {
      console.warn("[pagelens] settings form", err);
    }
    setView("settings");
    return;
  }
  if (isResumableRun(state.run) && skillsOn() && lastUserAskedForSkill()) {
    resumeInterruptedRun().catch((err) => console.warn("[pagelens] resume", err));
  } else if (state.run) {
    state.run = null;
    persistSession();
  }
}

boot().catch((err) => {
  console.error("[pagelens] boot", err);
  try {
    bindComposer();
    markWired();
  } catch {
    /* ignore */
  }
  setModelLineMeta("启动失败：" + (err?.message || err));
});

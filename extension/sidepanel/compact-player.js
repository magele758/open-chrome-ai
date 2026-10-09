import { needModelMessage, requireModel } from "./agent-loop.js";
import { $ } from "./dom.js";
import { RemoteInterpretController } from "./interpret-client.js";
import { mediaShouldShow, renderContext, renderTranscribeAction } from "./media-chrome.js";
import { pushError } from "./messages.js";
import { state } from "./state.js";
import { bindMediaSource, mediaActionTab, packForMedia, packForMediaWrite } from "./tab-context.js";
import { deleteMediaArchive, loadFullMediaArchive } from "../lib/audio-composer.js";
import { injectVideo } from "../lib/chrome.js";
import { clearVideoDubCache } from "../lib/dub-cache.js";
import { InterpretController } from "../lib/interpret-controller.js";
import { DUB_ARCHIVE_VERSION } from "../lib/interpret-policy.js";
import { videoIdentity } from "../lib/library.js";
import { formatTime } from "../lib/prompts.js";
import { isTtsReady } from "../lib/storage.js";
import { StreamingAudioPlayer, getSharedAudioContext } from "../lib/streaming-audio-player.js";

// Video interpretation runs in the offscreen document and survives closing the
// panel. Pure-audio mode plays through the panel's own player, so it stays local.

const interpretController = new RemoteInterpretController();
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
  if (event?.type === "dub_partial") {
    compactGenerationComplete = false;
    compactFullGenerating = false;
    compactGenerationMessage = "部分片段未能生成，可播放已完成内容；重试会复用已完成缓存。";
    compactStreamPlayer?.closeStream();
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
      compactGenerationComplete = event?.type === "stopped" && event.result?.complete !== false;
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
  // Older archives keep the previous voice/segmentation; regenerate (segment caches are reused).
  const currentArchive = archive?.processingVersion === DUB_ARCHIVE_VERSION ? archive : null;
  let audioBlob = currentArchive?.compactAudioBlob || currentArchive?.audioBlob;
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
    if (archive?.complete && archive.compactAudioBlob && archive.processingVersion === DUB_ARCHIVE_VERSION) {
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

function discardCompactProgress() {
  compactSegments = [];
  compactGenerationMessage = "";
  compactFullGenerating = false;
}

function clearCompactSegments() {
  compactSegments = [];
}


export {
  interpretController,
  compactController,
  dubPlayerAudio,
  dubPlayerBlobUrl,
  dubPlayerTimer,
  compactPlayerAudio,
  compactPlayerBlobUrl,
  compactPlayerTimer,
  compactStreamPlayer,
  compactSegments,
  compactPlaying,
  compactPendingAutoplay,
  compactRate,
  compactSessionOpen,
  compactGenerationComplete,
  compactActionPending,
  compactRevision,
  compactFullGenerating,
  compactGenerationMessage,
  COMPACT_RATES,
  stopCompactAudioElement,
  stopCompactPlayback,
  getCompactDuration,
  getCompactCurrentTime,
  renderCompactPlayer,
  startCompactStreamPlayback,
  startCompactArchivePlayback,
  toggleCompactPlayback,
  performCompactToggle,
  seekCompactPlayback,
  changeCompactRate,
  downloadCompactAudio,
  closeCompactPlayer,
  clearCurrentDubbingCache,
  regenerateCurrentDubbing,
  generateFullCompactAudio,
  stopDubPlayback,
  toggleDubPlayback,
  discardCompactProgress,
  clearCompactSegments,
};

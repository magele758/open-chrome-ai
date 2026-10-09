import { needModelMessage, requireModel, sendPrompt } from "./agent-loop.js";
import {
  compactPendingAutoplay,
  compactPlayerAudio,
  compactPlaying,
  compactSessionOpen,
  compactStreamPlayer,
  interpretController,
  toggleCompactPlayback,
} from "./compact-player.js";
import { $ } from "./dom.js";
import { formatDuration, formatTokenCount, hostOf, pushError, renderSkills } from "./messages.js";
import { syncComposerHints } from "./model-line.js";
import { setView } from "./session.js";
import { state } from "./state.js";
import { isMediaPlaybackActive, isVideoUrl, packForMedia, refreshTab, snapshotTab } from "./tab-context.js";
import { applyCaptions, needAsrSettings, startInterpret } from "./video-actions.js";
import { formatTime } from "../lib/prompts.js";
import { isAsrReady } from "../lib/storage.js";
import { getSharedAudioContext } from "../lib/streaming-audio-player.js";
import { wrapUntrusted } from "../lib/untrusted.js";

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

function pageContextBits() {
  const tab = state.tab;
  if (!tab || !state.share) return state.share ? [] : ["不使用网页"];
  const bits = [];
  const host = hostOf(tab.url);
  if (host) bits.push(host);
  if (state.pack?.kind === "x") bits.push("已提取帖子");
  if (state.pack?.kind === "pdf") {
    bits.push("已提取 PDF");
    if (state.pack.pdfPages) bits.push(`${state.pack.pdfPages} 页`);
  } else if (state.pack?.pdfError) {
    bits.push("PDF 未抽出");
  }
  if (state.pack?.text) bits.push(`${state.pack.text.length} 字`);
  return bits;
}

function videoContextBits() {
  const video = state.pack?.videoIsPrimary && state.pack?.video;
  const mediaId = state.mediaTab?.id || state.tab?.id;
  const si = interpretController.getState?.(mediaId) || state.interpret;
  const tr = state.transcribe;
  const bits = [];
  if (video) {
    bits.push(formatTime(video.duration));
    const src = state.pack?.captionsSource;
    if (state.pack?.captionsStatus === "ready") {
      bits.push(src === "subtitles" ? "含完整字幕" : "已转写");
    } else {
      bits.push("尚未转写");
    }
  }
  if (si?.status === "running") {
    bits.push("同传中（按声音）");
    if (si.hint) bits.push(si.hint);
  } else if (video) {
    bits.push("同传按声音切句");
  }
  if (tr?.status === "recording") {
    bits.push(`提取中 ${formatTime(tr.currentTime || 0)}/${formatTime(tr.duration || video?.duration || 0)}`);
    if (tr.hint) bits.push(tr.hint);
  }
  if (tr?.status === "extracting" || tr?.status === "uploading") bits.push(tr.hint || "正在识别完整音轨");
  if (tr?.status === "error" && tr.error) bits.push(formatStatusError(tr.error));
  if (si?.status === "error" && si.error) bits.push(formatStatusError(si.error));
  const src = state.pack?.captionsSource;
  if (video && (src === "asr-full" || src === "asr" || src === "asr-cache" || src === "interpret" || src === "subtitles" || src === "subtitles-full") && (!tr || tr.status === "done" || tr.status === "idle")) {
    bits.push("可以直接问总结或章节");
  }
  const n = Number(state.pack?.videoCount) || (Array.isArray(state.pack?.videos) ? state.pack.videos.length : 0);
  if (n > 1) {
    const idx = Number.isInteger(state.pack?.videoIndex) ? state.pack.videoIndex + 1 : 1;
    bits.push(`画面 ${idx}/${n}`);
  }
  return bits;
}

function renderMediaProgress() {
  const el = $("media-progress");
  const bits = videoContextBits();
  if (el) {
    el.textContent = bits.join(" · ");
    el.hidden = !bits.length;
  }
}

function renderComposerChip() {
  const label = $("compose-chip-label");
  const chip = $("compose-chip");
  const clear = $("btn-clear-ref");
  const note = $("compose-note");
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
    if (input && !input.value) input.placeholder = "针对已引用的视频内容提问…";
    return;
  }
  if (state.share) {
    if (label) label.textContent = `当前网页：${pageTitle}`;
    setChipAction(clear, "×", "去掉网页上下文");
    if (note) {
      const bits = pageContextBits();
      note.textContent = bits.length ? bits.join(" · ") : "当前网页";
    }
  } else {
    if (label) label.textContent = "未带网页";
    setChipAction(clear, "带上", "带上当前网页");
    if (note) note.textContent = "不使用网页，切到其他页会再带上";
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
    context: `【主动引用视频文稿】URL：${state.pack?.url || state.tab?.url || ""}\n${wrapUntrusted(`标题：${title}\n\n${text.slice(0, 12000)}`, "captions")}`,
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
  const progress = videoContextBits();
  const status = interpreting ? "同传中" : compactPendingAutoplay ? "纯享准备中" : compactPlaying ? "纯享播放中" : running.length ? "后台处理中" : "就绪";
  if ($("media-status-label")) {
    $("media-status-label").textContent = !state.mediaExpanded && progress.length
      ? `${status} · ${progress.slice(0, 2).join(" · ")}`
      : status;
  }
  renderMediaProgress();
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
  renderTranscribeAction();
  renderComposerChip();
  renderMediaProgress();
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


export {
  currentMediaTitle,
  mediaShouldShow,
  applyMediaLayout,
  paintVideoSummary,
  setChipAction,
  pageContextBits,
  videoContextBits,
  renderMediaProgress,
  renderComposerChip,
  citeTranscript,
  citeVideoSummary,
  clearChatRef,
  dismissPageContext,
  restorePageContext,
  onComposerChipAction,
  renderMediaChrome,
  startSummarizePage,
  backToVideoTab,
  toggleMiniPlayback,
  toggleVideoPicker,
  startBackgroundInterpret,
  formatStatusError,
  renderContext,
  isTranscribing,
  renderTranscribeAction,
};

import { needModelMessage, paintBot, requireModel } from "./agent-loop.js";
import { clearCompactSegments, compactController, interpretController, stopCompactPlayback } from "./compact-player.js";
import { $ } from "./dom.js";
import { isTranscribing, paintVideoSummary, renderContext } from "./media-chrome.js";
import { maybeUploadTraceToLangfuse, pushError, renderMessages } from "./messages.js";
import { messageScroll, settingsPage } from "./panel-refs.js";
import { persistSession, setView } from "./session.js";
import { renderSettingsForm } from "./settings-form.js";
import { state } from "./state.js";
import {
  bindMediaSource,
  mediaActionTab,
  packForMedia,
  packForMediaWrite,
  refreshTab,
  releaseMediaSourceIfIdle,
} from "./tab-context.js";
import { transcribeTab, usableTranscript } from "../lib/captions.js";
import { captureTab as captureVisible } from "../lib/chrome.js";
import { syncPackToLibrary } from "../lib/library.js";
import { estimateTokens } from "../lib/openai.js";
import { isAsrReady } from "../lib/storage.js";
import { getSharedAudioContext } from "../lib/streaming-audio-player.js";
import { summarizeTranscript } from "../lib/summarize-transcript.js";

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
  settingsPage?.reveal("block-asr");
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
    if (typeof maybeUploadTraceToLangfuse === "function") maybeUploadTraceToLangfuse(botMsg.traceLog);
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
    if (typeof maybeUploadTraceToLangfuse === "function") maybeUploadTraceToLangfuse(botMsg.traceLog);
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
  clearCompactSegments();
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


export {
  applyCaptions,
  stopInterpret,
  needAsrSettings,
  startTranscribe,
  startSummarizeVideo,
  toggleOriginalAudio,
  startInterpret,
  captureTab,
};

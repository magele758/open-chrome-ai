import "./panel-log.js";
import { createAgentGatewayPanel } from "./agent-gateway-panel.js";
import { lastUserAskedForSkill, resumeInterruptedRun } from "./agent-loop.js";
import {
  closeClipModal,
  closeClipViewModal,
  dismissRecallBanner,
  openClipModal,
  openClipViewModal,
  submitClipModal,
} from "./clippings-ui.js";
import {
  changeCompactRate,
  clearCurrentDubbingCache,
  closeCompactPlayer,
  downloadCompactAudio,
  generateFullCompactAudio,
  getCompactDuration,
  regenerateCurrentDubbing,
  seekCompactPlayback,
  toggleCompactPlayback,
  toggleDubPlayback,
} from "./compact-player.js";
import { bindComposer, consumePending, renderAttach } from "./composer.js";
import { $, on } from "./dom.js";
import {
  exportAll,
  flashStatus,
  importAllToLibrary,
  importCurrentToLibrary,
  openHistoryView,
  renderHistory,
} from "./history.js";
import { updateHitlBadge } from "./hitl-ui.js";
import { paintLibraryStatus, refreshLibraryStatus } from "./library-ui.js";
import {
  applyMediaLayout,
  backToVideoTab,
  citeTranscript,
  citeVideoSummary,
  onComposerChipAction,
  renderComposerChip,
  renderMediaChrome,
  toggleMiniPlayback,
  toggleVideoPicker,
} from "./media-chrome.js";
import { createMessageScroll } from "./message-scroll.js";
import { pushError, renderMessages, renderSkills } from "./messages.js";
import {
  applyUiFont,
  readUiPref,
  renderModelLine,
  setModelLineMeta,
  skillsOn,
  syncComposerHints,
  syncSkillFolderControls,
  writeUiPref,
} from "./model-line.js";
import { copyText, nativeInstallCommand, paintNativeHostStatus, refreshNativeHost } from "./native-host-ui.js";
import { bindMessageScroll, bindSettingsPage, messageScroll, settingsPage } from "./panel-refs.js";
import { initReviewView } from "./review-view.js";
import { applySession, downloadText, persistSession, resolveWindowId, setView, startNewSession } from "./session.js";
import { renderSettingsForm } from "./settings-form.js";
import { createSettingsPage } from "./settings-page.js";
import { applyFolderPathsFromInputs, paintSkillFolderStatus } from "./skill-folder-ui.js";
import {
  clearSkillsCache,
  ensureSkillsMeta,
  hideSlashMenu,
  hydrateSkillFolderStatus,
  renderShortcutList,
  slash,
} from "./slash-menu.js";
import { state } from "./state.js";
import { refreshTab } from "./tab-context.js";
import { applyUiTheme, bindThemeEditor } from "./theme.js";
import { delegatePanel, trustPanel } from "./trust-runtime.js";
import {
  captureTab,
  startInterpret,
  startSummarizeVideo,
  startTranscribe,
  toggleOriginalAudio,
} from "./video-actions.js";
import { isResumableRun } from "../lib/agent/context.js";
import { DELEGATE_STORAGE_KEY } from "../lib/agent/delegate.js";
import { APPROVAL_STORAGE_KEY } from "../lib/agent/trust/approval-queue.js";
import { cleanExpiredMediaArchives } from "../lib/audio-composer.js";
import { injectVideo } from "../lib/chrome.js";
import { debugLog, exportDebugLogFresh } from "../lib/debug-log.js";
import { testLangfuseConnection } from "../lib/langfuse.js";
import { clearSavedHandle, pickLibraryFolder, setLibraryPath, syncPackToLibrary } from "../lib/library.js";
import { initMarkdown } from "../lib/markdown.js";
import { formatTime } from "../lib/prompts.js";
import { loadActiveSession } from "../lib/sessions.js";
import { clearSkillFolderHandle, pickSkillFolder, setSkillFolderPath, skillFolderStatus } from "../lib/skill-folder.js";
import {
  applyOptionalLocalSettings,
  defaultSettings,
  isModelReady,
  loadSettings,
  resolveModel,
  saveSettings,
} from "../lib/storage.js";
import { getSharedAudioContext } from "../lib/streaming-audio-player.js";
import { abortRecording } from "../lib/tab-audio.js";

function wire() {
  if (!settingsPage) bindSettingsPage(createSettingsPage({
    root: $("view-settings"),
    getSettings: () => state.settings,
    onModelChange: (value) => {
      const select = $("text-model-pick");
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
  }));
  if (!messageScroll) bindMessageScroll(createMessageScroll($("msgs"), $("btn-messages-bottom")));
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
  $("daily-notes-folder")?.addEventListener("input", (event) => {
    state.settings.dailyNotesFolder = event.target.value;
  });
  on("btn-save", "click", async () => {
    const button = $("btn-save");
    button.disabled = true;
    try {
      if ($("daily-notes-folder")) {
        state.settings.dailyNotesFolder = $("daily-notes-folder").value.trim();
      }
      if ($("langfuse-enabled")) {
        if (!state.settings.langfuse) state.settings.langfuse = {};
        state.settings.langfuse.enabled = $("langfuse-enabled").checked;
        if ($("langfuse-url")) state.settings.langfuse.baseUrl = $("langfuse-url").value.trim();
        if ($("langfuse-pk")) state.settings.langfuse.publicKey = $("langfuse-pk").value.trim();
        if ($("langfuse-sk")) state.settings.langfuse.secretKey = $("langfuse-sk").value.trim();
        if ($("langfuse-env")) state.settings.langfuse.environment = $("langfuse-env").value.trim();
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
      settingsPage?.refreshSummary();
    } catch (error) {
      $("save-status").textContent = "保存失败，请重试：" + (error.message || String(error));
      $("save-status").className = "status bad";
    } finally { button.disabled = false; }
  });
  $("langfuse-enabled")?.addEventListener("change", (e) => {
    if (!state.settings.langfuse) state.settings.langfuse = {};
    state.settings.langfuse.enabled = e.target.checked;
  });
  $("langfuse-url")?.addEventListener("input", (e) => {
    if (!state.settings.langfuse) state.settings.langfuse = {};
    state.settings.langfuse.baseUrl = e.target.value.trim();
  });
  $("langfuse-pk")?.addEventListener("input", (e) => {
    if (!state.settings.langfuse) state.settings.langfuse = {};
    state.settings.langfuse.publicKey = e.target.value.trim();
  });
  $("langfuse-sk")?.addEventListener("input", (e) => {
    if (!state.settings.langfuse) state.settings.langfuse = {};
    state.settings.langfuse.secretKey = e.target.value.trim();
  });
  $("langfuse-env")?.addEventListener("input", (e) => {
    if (!state.settings.langfuse) state.settings.langfuse = {};
    state.settings.langfuse.environment = e.target.value.trim();
  });
  $("btn-langfuse-test")?.addEventListener("click", async () => {
    const status = $("langfuse-status");
    if (!status) return;
    status.textContent = "连接测试中…";
    status.className = "status";
    const cfg = {
      baseUrl: $("langfuse-url")?.value?.trim() || state.settings?.langfuse?.baseUrl,
      publicKey: $("langfuse-pk")?.value?.trim() || state.settings?.langfuse?.publicKey,
      secretKey: $("langfuse-sk")?.value?.trim() || state.settings?.langfuse?.secretKey,
    };
    const res = await testLangfuseConnection(cfg);
    status.textContent = res.message;
    status.className = res.ok ? "status ok" : "status bad";
  });
  on("mm-same", "change", (e) => {
    state.settings.multimodalSameAsText = e.target.checked;
    $("mm-fields")?.classList.toggle("hidden", e.target.checked);
  });
  on("answer-lang", "change", (e) => {
    state.settings.answerLanguage = e.target.value;
  });
  bindThemeEditor(state);
  on("ui-font", "change", (e) => {
    state.settings.uiFont = e.target.value;
    applyUiFont(state.settings.uiFont);
  });
  $("native-shell")?.addEventListener("change", (e) => {
    state.settings.nativeShell = e.target.checked;
    paintNativeHostStatus(state.nativeHost);
    renderModelLine();
  });
  $("cdp-input")?.addEventListener("change", (e) => {
    state.settings.cdpInput = e.target.checked;
  });
  $("agent-bridge")?.addEventListener("change", (e) => {
    state.settings.agentBridgeEnabled = e.target.checked;
  });
  $("agent-inbox")?.addEventListener("change", (e) => {
    state.settings.agentInboxEnabled = e.target.checked;
  });
  $("hitl-mode")?.addEventListener("change", (e) => {
    state.settings.hitlMode = e.target.value;
    updateHitlBadge();
  });
  trustPanel.bind();
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes[APPROVAL_STORAGE_KEY]) trustPanel.render();
    if (area === "session" && changes[DELEGATE_STORAGE_KEY]) delegatePanel.render();
  });
  trustPanel.render();
  delegatePanel.render();
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
  createAgentGatewayPanel({
    root: $("view-settings"),
    copyText,
    onGatewayChanged: (enabled) => {
      state.settings.agentGatewayEnabled = enabled;
    },
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
    applyUiTheme(state.settings.uiTheme, state.settings.uiThemeColors);
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

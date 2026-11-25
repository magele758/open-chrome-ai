import { renderAttach } from "./composer.js";
import { $ } from "./dom.js";
import { capsuleFromMessages, updateHitlBadge } from "./hitl-ui.js";
import { renderComposerChip } from "./media-chrome.js";
import { hostOf, renderMessages } from "./messages.js";
import { messageScroll } from "./panel-refs.js";
import { refreshReviewView } from "./review-view.js";
import { hideSlashMenu } from "./slash-menu.js";
import { state } from "./state.js";
import { trustPanel } from "./trust-runtime.js";
import { createTaintState } from "../lib/agent/trust/taint.js";
import { restrictedUrl } from "../lib/chrome.js";
import { clearActiveId, mergePage, saveSession } from "../lib/sessions.js";
import { abortRecording } from "../lib/tab-audio.js";

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
let lastPersistedFingerprint = "";

function sessionStateFingerprint() {
  return JSON.stringify({
    id: state.sessionId || "",
    pages: state.sessionPages || [],
    messages: (state.messages || []).map((m) => ({
      id: m.id || "",
      role: m.role,
      text: m.text || "",
      error: Boolean(m.error),
      hasImage: Boolean(m.image || m.hasImage),
      trace: m.trace || null,
      metrics: m.metrics || null,
      traceLog: m.traceLog || null,
    })),
    sideChats: state.sideChats || [],
    run: state.run || null,
    taskGroupId: state.taskGroupId ?? null,
  });
}

function persistSession(options = {}) {
  const run = () => persistSessionNow(options);
  persistChain = persistChain.then(run, run);
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
  const win = await chrome.windows.getCurrent();
  if (!Number.isInteger(win?.id) || win.id < 0) throw new Error("无法确定 PageLens 所属窗口，请重新打开侧栏。");
  state.windowId = win.id;
  return state.windowId;
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

async function persistSessionNow(options = {}) {
  if (!state.messages.some((m) => m.role === "user" && String(m.text || "").trim())) return;
  if (options.ifDirty && state.sessionId && sessionStateFingerprint() === lastPersistedFingerprint) return;
  ensureSessionId();
  const page = currentPageMeta();
  if (page) state.sessionPages = mergePage(state.sessionPages, page);
  const saved = await saveSession({
    id: state.sessionId,
    createdAt: state.sessionCreatedAt || Date.now(),
    pages: state.sessionPages,
    messages: state.messages,
    sideChats: state.sideChats,
    run: state.run,
    taskGroupId: state.taskGroupId,
  }, { windowId: await resolveWindowId() });
  state.sessionPages = saved.pages;
  for (let i = 0; i < state.messages.length; i += 1) {
    if (!state.messages[i].id && saved.messages[i]?.id) {
      state.messages[i].id = saved.messages[i].id;
    }
  }
  lastPersistedFingerprint = sessionStateFingerprint();
}

function abortAllSideChats() {
  const aborts = state.sideChatUi?.aborts;
  if (aborts && typeof aborts.forEach === "function") {
    aborts.forEach((ctrl) => {
      try { ctrl.abort(); } catch { /* ignore */ }
    });
    aborts.clear();
  }
  state.sideChatUi?.runningIds?.clear?.();
}

function notifySideChatSync() {
  if (typeof document !== "undefined") {
    document.dispatchEvent(new CustomEvent("pagelens:sidechat-sync"));
  }
}

function applySession(session) {
  if (!session) return;
  abortAllSideChats();
  messageScroll?.reset();
  state.sessionId = session.id;
  state.sessionCreatedAt = session.createdAt;
  state.sessionPages = session.pages || [];
  state.messages = (session.messages || []).map((m, idx) => ({
    id: m.id || `m-${idx}`,
    role: m.role,
    text: m.text || "",
    thinking: m.thinking || "",
    error: m.error,
    trace: m.trace,
    metrics: m.metrics,
    traceLog: m.traceLog,
    image: null,
  }));
  state.sideChats = Array.isArray(session.sideChats)
    ? session.sideChats.map((sc) => ({
        ...sc,
        anchor: sc.anchor ? { ...sc.anchor } : { quoteText: "", status: "attached" },
        messages: Array.isArray(sc.messages) ? sc.messages.map((m) => ({ ...m })) : [],
      }))
    : [];
  if (state.sideChatUi) {
    state.sideChatUi.activeId = state.sideChats[0]?.id || "";
    state.sideChatUi.view = state.sideChats.length ? "thread" : "list";
    state.sideChatUi.open = Boolean(state.sideChatUi.wide && state.sideChats.length);
    state.sideChatUi.pendingSelection = null;
  }
  state.image = null;
  state.run = session.run || null;
  state.taskGroupId = Number.isInteger(session.taskGroupId) ? session.taskGroupId : null;
  state.capsule = capsuleFromMessages(state.messages);
  state.taint = createTaintState();
  state.injectionSuspected = null;
  state.hitlApprovedOrigins = new Set();
  renderAttach();
  renderMessages();
  trustPanel.render();
  notifySideChatSync();
  lastPersistedFingerprint = sessionStateFingerprint();
}

async function startNewSession() {
  await settleBusy();
  await persistSession({ ifDirty: true });
  lastPersistedFingerprint = "";
  abortAllSideChats();
  state.sessionId = null;
  state.sessionCreatedAt = null;
  state.sessionPages = [];
  state.messages = [];
  state.sideChats = [];
  if (state.sideChatUi) {
    state.sideChatUi.activeId = "";
    state.sideChatUi.open = false;
    state.sideChatUi.view = "list";
    state.sideChatUi.pendingSelection = null;
  }
  state.image = null;
  state.run = null;
  state.taskGroupId = null;
  state.transcribe = null;
  state.activeToolDomains = new Set();
  state.sessionHitlOverride = null;
  state.hitlApprovedOrigins = new Set();
  state.injectionSuspected = null;
  state.capsule = null;
  state.taint = createTaintState();
  updateHitlBadge();
  trustPanel.render();
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
  notifySideChatSync();
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


export {
  setView,
  currentPageMeta,
  persistChain,
  persistSession,
  ensureSessionId,
  resolveWindowId,
  settleBusy,
  persistSessionNow,
  abortAllSideChats,
  notifySideChatSync,
  applySession,
  startNewSession,
  downloadText,
};

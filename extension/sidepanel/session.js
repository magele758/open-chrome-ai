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
  state.capsule = capsuleFromMessages(state.messages);
  state.taint = createTaintState();
  state.injectionSuspected = null;
  state.hitlApprovedOrigins = new Set();
  renderAttach();
  renderMessages();
  trustPanel.render();
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
  applySession,
  startNewSession,
  downloadText,
};

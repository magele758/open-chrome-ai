/**
 * SideChat panel & margin-annotation UI controller.
 * Manages selection-fork popover, responsive wide split-view vs narrow slide-over
 * drawer, multi-thread manager list, bi-directional anchor jumping, and micro-skills.
 */

import { $ } from "./dom.js";
import { flashStatus } from "./history.js";
import { formatDuration, formatTokenCount, syncMessageAnchors } from "./messages.js";
import { ensureSessionId, persistSession, setView } from "./session.js";
import { distillSideChatNote, isSideChatRunning, sendSideChatTurn, stopSideChatTurn } from "./sidechat-runner.js";
import { state } from "./state.js";
import { writeClipboardRich } from "../lib/clipboard.js";
import { bindMarkdownLinks, decorateInlines, enhanceMermaid, formatAnswer, splitThinking } from "../lib/markdown.js";
import { captureSelectionAnchor } from "../lib/sidechat-anchor.js";
import { MICRO_SKILL_PROMPTS, deriveSideChatTitle } from "../lib/sidechat-context.js";

const WIDE_SPLIT_THRESHOLD = 680;
const DEFAULT_SPLIT_WIDTH = 340;
const MIN_SIDECHAT_WIDTH = 220;
const MIN_MAIN_SPLIT_WIDTH = 240;
const MIN_NARROW_MARGIN = 24;
const STORAGE_SPLIT_WIDTH = "pagelens.sidechat.splitWidth";
const STORAGE_DRAWER_WIDTH = "pagelens.sidechat.drawerWidth";

let initialized = false;
let streamPaintTimer = 0;
let distillingId = "";
let resizeObserver = null;
let selectionBarResizeObserver = null;
let armedDeleteTimer = 0;
const composerDrafts = new Map();

function draftKey(threadId) {
  return JSON.stringify([ensureSessionId(), threadId]);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function readWidthPref(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    const num = Number(raw);
    return Number.isFinite(num) && num >= MIN_SIDECHAT_WIDTH ? num : fallback;
  } catch {
    return fallback;
  }
}

function writeWidthPref(key, value) {
  try {
    if (!value || value <= 0) localStorage.removeItem(key);
    else localStorage.setItem(key, String(Math.round(value)));
  } catch {
    /* ignore */
  }
}

function byId(id) {
  return (state.sideChats || []).find((sc) => sc.id === id) || null;
}

function getMessageDisplayNum(parentMessageId) {
  if (!parentMessageId) return 0;
  let botRound = 0;
  for (const m of state.messages || []) {
    if (m.role === "bot" && !m.error) {
      botRound += 1;
      if (m.id === parentMessageId) return botRound;
    }
  }
  return 0;
}

function getMessagePlainOrder(sideChat) {
  const msgIdx = (state.messages || []).findIndex((m) => m.id === sideChat.parentMessageId);
  const offset = Number.isInteger(sideChat.anchor?.plainStart) ? sideChat.anchor.plainStart : 999999;
  return (msgIdx === -1 ? 99999 : msgIdx) * 1000000 + offset;
}

function sortSideChats(list) {
  const copy = [...(list || [])];
  if (state.sideChatUi.sort === "recent") {
    return copy.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  return copy.sort((a, b) => getMessagePlainOrder(a) - getMessagePlainOrder(b) || (a.createdAt || 0) - (b.createdAt || 0));
}

function formatShortTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function hideSelectionPopover() {
  const bar = $("sc-selection-bar");
  if (bar) bar.classList.add("hidden");
  state.sideChatUi.pendingSelection = null;
}

function findExistingMatchingSideChat(parentMessageId, quoteText) {
  const clean = String(quoteText || "").trim();
  if (!clean) return null;
  return (state.sideChats || []).find(
    (sc) =>
      sc.parentMessageId === parentMessageId &&
      sc.forkType === "selection" &&
      String(sc.anchor?.quoteText || "").trim() === clean,
  ) || null;
}

function placeSelectionBar(area, bar, selRect) {
  const areaRect = area.getBoundingClientRect();
  const clientWidth = area.clientWidth || 0;
  const maxBarW = Math.max(0, clientWidth - 16);
  bar.style.maxWidth = `${maxBarW}px`;
  let barW = bar.offsetWidth;
  if (!(barW > 0)) barW = Math.min(240, maxBarW);
  if (barW > maxBarW) barW = maxBarW;
  const barH = bar.offsetHeight || 34;

  let top = selRect.top - areaRect.top - barH - 8;
  if (top < 6) top = selRect.bottom - areaRect.top + 8;
  top = Math.max(6, Math.min(top, areaRect.height - barH - 6));

  let left = selRect.left - areaRect.left + (selRect.width - barW) / 2;
  const maxLeft = clientWidth - 8 - barW;
  left = maxLeft >= 8 ? clamp(left, 8, maxLeft) : 8;

  bar.style.top = `${Math.round(top)}px`;
  bar.style.left = `${Math.round(left)}px`;
}

function repositionOpenSelectionBar() {
  const bar = $("sc-selection-bar");
  if (!bar || bar.classList.contains("hidden")) return;
  const area = document.querySelector(".messages-area");
  if (!area) return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  let selRect;
  try {
    selRect = sel.getRangeAt(0).getBoundingClientRect();
  } catch {
    return;
  }
  if (!selRect || (selRect.width === 0 && selRect.height === 0)) return;
  placeSelectionBar(area, bar, selRect);
}

function handleTextSelection() {
  if (state.view !== "chat") return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    hideSelectionPopover();
    return;
  }
  const range = sel.getRangeAt(0);
  const startEl = range.startContainer?.nodeType === 1 ? range.startContainer : range.startContainer?.parentElement;
  const endEl = range.endContainer?.nodeType === 1 ? range.endContainer : range.endContainer?.parentElement;
  const msgWrap = startEl?.closest?.(".msg.bot[data-msg-id]");
  if (!msgWrap || msgWrap !== endEl?.closest?.(".msg.bot[data-msg-id]")) {
    hideSelectionPopover();
    return;
  }
  if (msgWrap.classList.contains("error")) {
    hideSelectionPopover();
    return;
  }
  const msgId = msgWrap.dataset.msgId;
  const msgIdx = Number(msgWrap.dataset.msgIndex);
  const msgObj = Number.isInteger(msgIdx) ? state.messages[msgIdx] : state.messages.find((m) => m.id === msgId);
  const isLast = msgObj && msgObj === state.messages[state.messages.length - 1];
  if (state.busy && isLast && !msgObj.metrics) {
    hideSelectionPopover();
    return;
  }
  const bodyEl = msgWrap.querySelector(":scope > .body");
  if (!bodyEl || !bodyEl.contains(startEl) || !bodyEl.contains(endEl)) {
    hideSelectionPopover();
    return;
  }

  const anchor = captureSelectionAnchor(bodyEl, sel);
  if (!anchor) {
    hideSelectionPopover();
    return;
  }

  const area = document.querySelector(".messages-area");
  const bar = $("sc-selection-bar");
  if (!area || !bar) return;

  const selRect = range.getBoundingClientRect();
  if (!selRect || (selRect.width === 0 && selRect.height === 0)) {
    hideSelectionPopover();
    return;
  }

  state.sideChatUi.pendingSelection = {
    parentMessageId: msgId,
    anchor,
  };

  const existing = findExistingMatchingSideChat(msgId, anchor.quoteText);
  const existingBtn = $("btn-sc-sel-existing");
  const delSelBtn = $("btn-sc-sel-delete");
  if (existingBtn) {
    if (existing) {
      existingBtn.classList.remove("hidden");
      existingBtn.dataset.scId = existing.id;
    } else {
      existingBtn.classList.add("hidden");
      delete existingBtn.dataset.scId;
    }
  }
  if (delSelBtn) {
    if (existing) {
      delSelBtn.classList.remove("hidden");
      delSelBtn.dataset.scId = existing.id;
      const armed = state.sideChatUi.armedDeleteId === existing.id;
      delSelBtn.textContent = armed ? "确认删除?" : "🗑 删除";
      delSelBtn.classList.toggle("is-armed", armed);
    } else {
      delSelBtn.classList.add("hidden");
      delete delSelBtn.dataset.scId;
    }
  }

  bar.classList.remove("hidden");
  placeSelectionBar(area, bar, selRect);
}

export function createSideChat({
  forkType = "selection",
  parentMessageId = "",
  anchor = null,
  title = "",
  autoPrompt = "",
} = {}) {
  const now = Date.now();
  let targetMsg = (state.messages || []).find((m) => m.id === parentMessageId);
  if (!targetMsg) {
    targetMsg = [...(state.messages || [])].reverse().find((m) => m.role === "bot" && !m.error && m.text && m.text !== "…");
  }
  if (!targetMsg) {
    flashStatus("请先在主线发送一轮对话后即可裂变 SideChat", false);
    return null;
  }

  const msgIdx = state.messages.indexOf(targetMsg);
  const resolvedAnchor = anchor || {
    quoteText: String(targetMsg.text || "").replace(/\s+/g, " ").trim().slice(0, 320),
    status: "attached",
  };
  const thread = {
    id: crypto.randomUUID(),
    parentMessageId: targetMsg.id,
    forkType,
    anchor: resolvedAnchor,
    title: title || deriveSideChatTitle({ quoteText: resolvedAnchor.quoteText, userText: autoPrompt, forkType }),
    status: "active",
    pinnedNote: "",
    snapshotMessageCount: msgIdx >= 0 ? msgIdx + 1 : state.messages.length,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };

  state.sideChats.push(thread);
  state.sideChatUi.activeId = thread.id;
  state.sideChatUi.view = "thread";
  state.sideChatUi.open = true;
  hideSelectionPopover();
  try {
    window.getSelection()?.removeAllRanges?.();
  } catch {
    /* ignore */
  }

  syncMessageAnchors();
  renderSideChatPane();
  persistSession().catch(() => {});

  if (autoPrompt) {
    triggerSideChatSend(thread.id, autoPrompt);
  } else {
    $("sc-input")?.focus();
  }
  return thread;
}

export function openSideChatThread(sideChatId, { jumpAnchor = false } = {}) {
  const target = byId(sideChatId);
  if (!target) {
    state.sideChatUi.open = true;
    state.sideChatUi.view = "list";
    renderSideChatPane();
    return;
  }
  state.sideChatUi.activeId = target.id;
  state.sideChatUi.view = "thread";
  state.sideChatUi.open = true;
  syncMessageAnchors();
  renderSideChatPane();
  if (jumpAnchor) {
    jumpToAnchor(target.id, { keepOpen: true });
  }
}

export function toggleSideChatPanel(forceOpen) {
  const next = typeof forceOpen === "boolean" ? forceOpen : !state.sideChatUi.open;
  state.sideChatUi.open = next;
  if (next) {
    if (state.sideChatUi.activeId && byId(state.sideChatUi.activeId)) {
      state.sideChatUi.view = "thread";
    } else if (state.sideChats.length) {
      state.sideChatUi.activeId = state.sideChats[0].id;
      state.sideChatUi.view = "list";
    } else {
      state.sideChatUi.view = "list";
    }
  }
  renderSideChatPane();
}

function triggerSideChatSend(sideChatId, text) {
  sendSideChatTurn(sideChatId, text, {
    onUpdate: (id, opts) => {
      if (id !== state.sideChatUi.activeId) {
        renderQuickStrip();
        return;
      }
      if (opts?.streaming) {
        if (!streamPaintTimer) {
          streamPaintTimer = setTimeout(() => {
            streamPaintTimer = 0;
            renderThreadMessages({ preserveScroll: true });
            renderComposerState();
          }, 55);
        }
      } else {
        renderSideChatPane();
      }
    },
    onDone: () => {
      if (streamPaintTimer) {
        clearTimeout(streamPaintTimer);
        streamPaintTimer = 0;
      }
      syncMessageAnchors();
      renderSideChatPane();
    },
  });
}

function jumpToAnchor(sideChatId, { keepOpen = false } = {}) {
  const sc = byId(sideChatId);
  if (!sc) return;
  if (!state.sideChatUi.wide && !keepOpen) {
    state.sideChatUi.open = false;
    renderSideChatPane();
  }
  const msgsRoot = $("msgs");
  if (!msgsRoot) return;

  const mark = [...msgsRoot.querySelectorAll("mark.sc-anchor")].find((el) => {
    const ids = String(el.dataset.scIds || el.dataset.scId || "").split(",");
    return ids.includes(sc.id);
  });
  const chip = msgsRoot.querySelector(`.sc-msg-fork-chip[data-sc-id="${CSS.escape(sc.id)}"]`);
  const msgWrap = sc.parentMessageId
    ? msgsRoot.querySelector(`.msg.bot[data-msg-id="${CSS.escape(sc.parentMessageId)}"]`)
    : null;
  const target = mark || chip || msgWrap;
  if (!target) {
    flashStatus("原句位置未找到（可能原回复已变更）", false);
    return;
  }
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  target.classList.remove("sc-pulse");
  void target.offsetWidth;
  target.classList.add("sc-pulse");
  setTimeout(() => target.classList.remove("sc-pulse"), 1400);
}

function renderHeaderAndRail() {
  const count = (state.sideChats || []).length;
  const unresolved = (state.sideChats || []).filter((s) => s.status !== "resolved").length;
  const headerBtn = $("btn-sidechat-header");
  const headerCount = $("sc-header-count");
  if (headerBtn) {
    headerBtn.classList.toggle("is-active", Boolean(state.sideChatUi.open));
    headerBtn.classList.toggle("has-items", count > 0);
    headerBtn.setAttribute("aria-expanded", String(Boolean(state.sideChatUi.open)));
    headerBtn.title = count
      ? `SideChat 旁注 (${count} 条，${unresolved} 条思考中)`
      : "打开 SideChat 旁注分支";
  }
  if (headerCount) {
    headerCount.textContent = count ? String(count) : "";
    headerCount.classList.toggle("hidden", count === 0);
  }

  const rail = $("sc-margin-rail");
  if (rail) {
    rail.replaceChildren();
    const showRail = !state.sideChatUi.wide && !state.sideChatUi.open && count > 0;
    rail.classList.toggle("hidden", !showRail);
    if (showRail) {
      sortSideChats(state.sideChats).slice(0, 12).forEach((sc, idx) => {
        const dot = document.createElement("button");
        dot.type = "button";
        dot.className = "sc-rail-tick" + (sc.status === "resolved" ? " is-resolved" : "") + (sc.id === state.sideChatUi.activeId ? " is-active" : "");
        dot.title = `${idx + 1}. ${sc.title}`;
        dot.addEventListener("click", () => openSideChatThread(sc.id));
        rail.appendChild(dot);
      });
    }
  }
}

function renderQuickStrip() {
  const strip = $("sc-quick-strip");
  if (!strip) return;
  const list = sortSideChats(state.sideChats || []);
  const showStrip = state.sideChatUi.view === "thread" && list.length > 0;
  strip.classList.toggle("hidden", !showStrip);
  if (!showStrip) return;

  strip.replaceChildren();
  list.forEach((sc, idx) => {
    const wrap = document.createElement("span");
    const active = sc.id === state.sideChatUi.activeId;
    const running = isSideChatRunning(sc.id);
    const armed = state.sideChatUi.armedDeleteId === sc.id;
    wrap.className = "sc-pill-wrap" + (active ? " is-active" : "") + (sc.status === "resolved" ? " is-resolved" : "");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sc-pill-tab" + (active ? " is-active" : "") + (sc.status === "resolved" ? " is-resolved" : "");
    btn.title = sc.title;
    const icon = running ? "◌" : sc.status === "resolved" ? "✓" : sc.pinnedNote ? "📌" : "💬";
    const shortTitle = sc.title.length > 10 ? `${sc.title.slice(0, 10)}…` : sc.title;
    btn.textContent = `${icon} ${idx + 1}. ${shortTitle}`;
    btn.addEventListener("click", () => {
      state.sideChatUi.activeId = sc.id;
      state.sideChatUi.view = "thread";
      syncMessageAnchors();
      renderSideChatPane();
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "sc-pill-del" + (armed ? " is-armed" : "");
    del.textContent = armed ? "确认" : "×";
    del.title = armed ? "再次点击确认删除此旁注" : `删除旁注：${sc.title}`;
    del.setAttribute("aria-label", del.title);
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      requestDeleteSideChat(sc.id);
    });

    wrap.append(btn, del);
    strip.appendChild(wrap);
  });
}

function renderListView() {
  const listEl = $("sc-list-items");
  if (!listEl) return;

  document.querySelectorAll(".sc-filter-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.scFilter === state.sideChatUi.filter);
  });

  const sortBtn = $("btn-sc-sort");
  if (sortBtn) {
    sortBtn.textContent = state.sideChatUi.sort === "recent" ? "按最近更新" : "按原文顺序";
  }

  const searchInput = $("sc-search");
  if (searchInput && searchInput.value !== state.sideChatUi.query) {
    searchInput.value = state.sideChatUi.query;
  }

  const q = state.sideChatUi.query.trim().toLowerCase();
  const sorted = sortSideChats(state.sideChats || []);
  const filtered = sorted.filter((sc) => {
    if (state.sideChatUi.filter === "active" && sc.status === "resolved") return false;
    if (state.sideChatUi.filter === "resolved" && sc.status !== "resolved") return false;
    if (state.sideChatUi.filter === "pinned" && !sc.pinnedNote) return false;
    if (!q) return true;
    const msgBlob = (sc.messages || []).map((m) => m.text).join(" ");
    const blob = [sc.title, sc.anchor?.quoteText, sc.pinnedNote, msgBlob].join(" ").toLowerCase();
    return blob.includes(q);
  });

  listEl.replaceChildren();
  if (!sorted.length) {
    listEl.innerHTML = `
      <div class="sc-empty-box">
        <div class="sc-empty-title">还没有旁注分支</div>
        <p class="sc-empty-desc">在主回复中<strong>划选任意词句</strong>，或点击回答底部的 <strong>「⑂ 裂变」</strong>，即可在不打断主线的情况下开一条独立旁注子会话。</p>
      </div>
    `;
    return;
  }

  if (!filtered.length) {
    listEl.innerHTML = `<div class="sc-empty-box"><div class="sc-empty-desc">没有匹配当前筛选条件的旁注分支</div></div>`;
    return;
  }

  filtered.forEach((sc, idx) => {
    const card = document.createElement("div");
    card.className = "sc-card" + (sc.id === state.sideChatUi.activeId ? " is-active" : "") + (sc.status === "resolved" ? " is-resolved" : "");

    const head = document.createElement("div");
    head.className = "sc-card-head";

    const titleEl = document.createElement("div");
    titleEl.className = "sc-card-title";
    titleEl.textContent = `${idx + 1}. ${sc.title}`;

    const badge = document.createElement("span");
    badge.className = "sc-status-tag " + (sc.status === "resolved" ? "is-resolved" : "is-active");
    badge.textContent = isSideChatRunning(sc.id) ? "生成中…" : sc.status === "resolved" ? "已掌握 ✓" : "思考中";
    head.append(titleEl, badge);
    card.appendChild(head);

    if (sc.anchor?.quoteText) {
      const quote = document.createElement("div");
      quote.className = "sc-card-quote";
      quote.textContent = `“${sc.anchor.quoteText}”`;
      card.appendChild(quote);
    }

    if (sc.pinnedNote) {
      const pinned = document.createElement("div");
      pinned.className = "sc-card-pinned";
      pinned.textContent = `📌 ${sc.pinnedNote}`;
      card.appendChild(pinned);
    }

    const foot = document.createElement("div");
    foot.className = "sc-card-foot";
    const meta = document.createElement("span");
    const turns = Math.ceil((sc.messages || []).filter((m) => m.role === "user").length);
    const kind = sc.forkType === "selection" ? "划词" : "节点";
    meta.textContent = `${kind} · ${turns} 轮 · ${formatShortTime(sc.updatedAt)}`;

    const ops = document.createElement("div");
    ops.className = "sc-card-ops";

    const jumpBtn = document.createElement("button");
    jumpBtn.type = "button";
    jumpBtn.className = "sc-mini-btn";
    jumpBtn.textContent = "↗";
    jumpBtn.title = "定位回原文";
    jumpBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.sideChatUi.activeId = sc.id;
      jumpToAnchor(sc.id, { keepOpen: state.sideChatUi.wide });
    });

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "sc-mini-btn";
    toggleBtn.textContent = sc.status === "resolved" ? "↺" : "✓";
    toggleBtn.title = sc.status === "resolved" ? "重设为思考中" : "标记已掌握";
    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      sc.status = sc.status === "resolved" ? "active" : "resolved";
      sc.updatedAt = Date.now();
      syncMessageAnchors();
      renderSideChatPane();
      persistSession().catch(() => {});
    });

    const armed = state.sideChatUi.armedDeleteId === sc.id;
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "sc-mini-btn is-danger" + (armed ? " is-armed" : "");
    delBtn.textContent = armed ? "确认?" : "🗑 删除";
    delBtn.title = armed ? "再次点击确认删除" : "删除此旁注分支";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      requestDeleteSideChat(sc.id);
    });

    ops.append(jumpBtn, toggleBtn, delBtn);
    foot.append(meta, ops);
    card.appendChild(foot);

    card.addEventListener("click", () => openSideChatThread(sc.id));
    listEl.appendChild(card);
  });
}

function clearArmedDelete() {
  if (armedDeleteTimer) {
    clearTimeout(armedDeleteTimer);
    armedDeleteTimer = 0;
  }
  state.sideChatUi.armedDeleteId = "";
}

export function requestDeleteSideChat(sideChatId, { force = false } = {}) {
  const sc = byId(sideChatId);
  if (!sc) return false;
  const hasMessages = (sc.messages || []).length > 0;
  if (force || !hasMessages || state.sideChatUi.armedDeleteId === sideChatId) {
    clearArmedDelete();
    deleteSideChat(sideChatId);
    return true;
  }
  clearArmedDelete();
  state.sideChatUi.armedDeleteId = sideChatId;
  renderSideChatPane();
  const selDel = $("btn-sc-sel-delete");
  if (selDel && selDel.dataset.scId === sideChatId) {
    selDel.textContent = "确认删除?";
    selDel.classList.add("is-armed");
  }
  armedDeleteTimer = setTimeout(() => {
    armedDeleteTimer = 0;
    if (state.sideChatUi.armedDeleteId === sideChatId) {
      state.sideChatUi.armedDeleteId = "";
      renderSideChatPane();
      if (selDel && selDel.dataset.scId === sideChatId) {
        selDel.textContent = "🗑 删除";
        selDel.classList.remove("is-armed");
      }
    }
  }, 2600);
  return false;
}

function deleteSideChat(sideChatId) {
  composerDrafts.delete(draftKey(sideChatId));
  stopSideChatTurn(sideChatId);
  state.sideChats = (state.sideChats || []).filter((sc) => sc.id !== sideChatId);
  if (state.sideChatUi.activeId === sideChatId) {
    state.sideChatUi.activeId = state.sideChats[0]?.id || "";
    if (!state.sideChats.length) {
      state.sideChatUi.view = "list";
    }
  }
  if (state.sideChatUi.pendingSelection) hideSelectionPopover();
  syncMessageAnchors();
  renderSideChatPane();
  persistSession().catch(() => {});
  flashStatus("已删除旁注", true);
}

function renderThreadHeader(sc) {
  const badge = $("sc-detail-badge");
  const meta = $("sc-detail-meta");
  const quoteEl = $("sc-detail-quote");
  const resBtn = $("btn-sc-resolve");
  const pinnedBox = $("sc-pinned-box");
  const pinnedText = $("sc-pinned-text");
  const titleBtn = $("sc-thread-title");

  if (titleBtn) titleBtn.textContent = sc.title || "旁注分支";
  if (badge) {
    badge.textContent = sc.forkType === "selection" ? "划词批注" : "节点裂变";
  }
  const round = getMessageDisplayNum(sc.parentMessageId);
  const parentExists = (state.messages || []).some((m) => m.id === sc.parentMessageId);
  if (meta) {
    meta.textContent = !parentExists
      ? "原回复已变更（历史快照）"
      : round
        ? `来自第 ${round} 轮回复`
        : "来自当前会话";
  }
  if (quoteEl) {
    const q = String(sc.anchor?.quoteText || "").trim();
    quoteEl.textContent = q ? `“${q}”` : "（整轮回复分支）";
    quoteEl.classList.toggle("hidden", !q);
  }
  if (resBtn) {
    const resolved = sc.status === "resolved";
    resBtn.textContent = resolved ? "✓ 已掌握" : "✓ 标记掌握";
    resBtn.classList.toggle("is-resolved", resolved);
  }
  if (pinnedBox && pinnedText) {
    const hasPinned = Boolean(sc.pinnedNote);
    pinnedBox.classList.toggle("hidden", !hasPinned);
    pinnedText.textContent = sc.pinnedNote || "";
  }
  const delBtn = $("btn-sc-delete");
  if (delBtn) {
    const armed = state.sideChatUi.armedDeleteId === sc.id;
    delBtn.textContent = armed ? "确认删除?" : "🗑 删除";
    delBtn.classList.toggle("is-armed", armed);
    delBtn.title = armed ? "再次点击确认删除此旁注" : "删除此旁注及原文高亮";
  }
}

function citeBackToMain(sc, text) {
  const input = $("input");
  if (!input) return;
  const snippet = String(text || "").trim().slice(0, 600);
  const quoteHeader = `> 【旁注「${sc.title}」参考结论】\n> ${snippet.split("\n").join("\n> ")}\n\n`;
  input.value = input.value ? `${input.value.trimEnd()}\n\n${quoteHeader}` : quoteHeader;
  input.dispatchEvent(new Event("input"));
  if (!state.sideChatUi.wide) {
    state.sideChatUi.open = false;
    renderSideChatPane();
  }
  input.focus();
  flashStatus("已引用到主线输入框，可补充问题后发送", true);
}

function renderThreadMessages({ preserveScroll = false } = {}) {
  const sc = byId(state.sideChatUi.activeId);
  const box = $("sc-messages");
  if (!box || !sc) return;

  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  box.replaceChildren();

  if (!sc.messages?.length) {
    const hint = document.createElement("div");
    hint.className = "sc-empty-thread";
    hint.innerHTML = `已继承主线截至此处的上下文快照。<br/>直接在下方输入你的疑问，或点击上方快捷芯片（通俗类比 / 举个例子）开始追问。`;
    box.appendChild(hint);
    return;
  }

  const running = isSideChatRunning(sc.id);
  sc.messages.forEach((m, idx) => {
    const isLast = idx === sc.messages.length - 1;
    const streamingThis = running && isLast && m.role === "bot";

    if (m.role === "user") {
      const row = document.createElement("div");
      row.className = "sc-msg sc-msg-user";
      row.textContent = m.text || "";
      box.appendChild(row);
      return;
    }

    const row = document.createElement("div");
    row.className = "sc-msg sc-msg-bot" + (m.error ? " is-error" : "");

    const head = document.createElement("div");
    head.className = "sc-msg-head";
    head.innerHTML = `<span class="sc-msg-who">SideChat</span><span class="sc-msg-tag">${streamingThis ? "正在思考/输出…" : "分支独立上下文"}</span>`;
    row.appendChild(head);

    const { thinking, answer } = splitThinking(m.text, m.thinking);
    if (thinking) {
      const details = document.createElement("details");
      details.className = "sc-thinking";
      if (streamingThis && !answer) details.open = true;
      const sum = document.createElement("summary");
      sum.textContent = streamingThis && !answer ? "正在思考…" : "思考过程";
      const content = document.createElement("div");
      content.className = "sc-thinking-body";
      content.textContent = thinking;
      details.append(sum, content);
      row.appendChild(details);
    }

    const bodyText = answer && answer !== "…" ? answer : (streamingThis ? "" : (m.text || ""));
    if (bodyText) {
      const body = document.createElement("div");
      body.className = "sc-msg-body body";
      body.innerHTML = formatAnswer(bodyText);
      decorateInlines(body, { baseUrl: state.pack?.url || state.tab?.url });
      bindMarkdownLinks(body);
      if (!streamingThis && !m.error) enhanceMermaid(body);
      row.appendChild(body);
    } else if (streamingThis && !thinking) {
      const wait = document.createElement("div");
      wait.className = "sc-streaming-dots";
      wait.textContent = "正在生成旁注解答…";
      row.appendChild(wait);
    }

    if (!streamingThis && !m.error && bodyText) {
      const foot = document.createElement("div");
      foot.className = "sc-msg-foot";
      const stats = document.createElement("span");
      stats.className = "sc-msg-stats";
      if (m.metrics) {
        stats.textContent = `${formatDuration(m.metrics.durationMs)} · 入 ${formatTokenCount(m.metrics.inputTokens)} · 出 ${formatTokenCount(m.metrics.outputTokens)}`;
      }
      const ops = document.createElement("div");
      ops.className = "sc-msg-ops";

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "sc-mini-btn";
      copyBtn.textContent = "复制";
      copyBtn.addEventListener("click", async () => {
        await writeClipboardRich({ text: m.text, html: formatAnswer(m.text) }).catch(() => {});
        copyBtn.textContent = "已复制";
        setTimeout(() => { copyBtn.textContent = "复制"; }, 1000);
      });

      const citeBtn = document.createElement("button");
      citeBtn.type = "button";
      citeBtn.className = "sc-mini-btn";
      citeBtn.textContent = "↩ 引用回主线";
      citeBtn.title = "把这段旁注结论带入主线输入框";
      citeBtn.addEventListener("click", () => citeBackToMain(sc, m.text));

      ops.append(copyBtn, citeBtn);
      foot.append(stats, ops);
      row.appendChild(foot);
    }

    box.appendChild(row);
  });

  if (!preserveScroll || nearBottom) {
    box.scrollTop = box.scrollHeight;
  }
}

function renderComposerState() {
  const sc = byId(state.sideChatUi.activeId);
  const input = $("sc-input");
  if (input && sc) {
    const key = draftKey(sc.id);
    if (input.dataset.draftOwner !== key) {
      input.dataset.draftOwner = key;
      input.value = composerDrafts.get(key) || "";
    }
  }
  const sendBtn = $("btn-sc-send");
  const distillBtn = $("btn-sc-distill");
  const running = sc ? isSideChatRunning(sc.id) : false;

  if (sendBtn) {
    sendBtn.textContent = running ? "停止" : "发送";
    sendBtn.classList.toggle("is-stop", running);
    sendBtn.title = running ? "停止生成" : "发送追问 (Enter)";
  }
  if (distillBtn) {
    const busyDistill = Boolean(sc && distillingId === sc.id);
    distillBtn.disabled = busyDistill || running;
    distillBtn.textContent = busyDistill ? "📌 凝练中…" : "📌 凝练一句话批注";
  }
}

function applyPaneWidth() {
  const viewChat = $("view-chat");
  const pane = $("sidechat-pane");
  if (!viewChat || !pane) return;
  const containerW = viewChat.clientWidth || (typeof window !== "undefined" ? window.innerWidth : 0) || 0;
  if (state.sideChatUi.wide) {
    const maxW = containerW > 0 ? Math.max(MIN_SIDECHAT_WIDTH, containerW - MIN_MAIN_SPLIT_WIDTH) : 960;
    const w = clamp(state.sideChatUi.splitWidth || DEFAULT_SPLIT_WIDTH, MIN_SIDECHAT_WIDTH, maxW);
    pane.style.width = `${Math.round(w)}px`;
  } else if (state.sideChatUi.drawerWidth > 0) {
    const maxW = containerW > 0 ? Math.max(MIN_SIDECHAT_WIDTH, containerW - MIN_NARROW_MARGIN) : 640;
    const w = clamp(state.sideChatUi.drawerWidth, MIN_SIDECHAT_WIDTH, maxW);
    pane.style.width = `${Math.round(w)}px`;
  } else {
    pane.style.width = "";
  }
}

export function renderSideChatPane() {
  const viewChat = $("view-chat");
  const pane = $("sidechat-pane");
  const backdrop = $("sc-drawer-backdrop");
  if (!viewChat || !pane) return;

  const isOpen = Boolean(state.sideChatUi.open);
  const isWide = Boolean(state.sideChatUi.wide);

  viewChat.classList.toggle("is-wide-split", isWide && isOpen);
  pane.classList.toggle("hidden", !isOpen);
  pane.classList.toggle("is-drawer", !isWide);
  pane.classList.toggle("is-split", isWide);
  applyPaneWidth();

  if (backdrop) {
    backdrop.classList.toggle("hidden", !isOpen || isWide);
  }

  renderHeaderAndRail();
  if (!isOpen) return;

  const listBtn = $("btn-sc-list");
  const totalCountEl = $("sc-total-count");
  if (totalCountEl) totalCountEl.textContent = String((state.sideChats || []).length);

  if (!byId(state.sideChatUi.activeId) && state.sideChats.length) {
    state.sideChatUi.activeId = state.sideChats[0].id;
  }
  if (!state.sideChats.length) {
    state.sideChatUi.view = "list";
  }

  const isList = state.sideChatUi.view === "list" || !byId(state.sideChatUi.activeId);
  if (listBtn) listBtn.classList.toggle("is-active", isList);

  $("sc-list-view")?.classList.toggle("hidden", !isList);
  $("sc-thread-view")?.classList.toggle("hidden", isList);

  const titleBtn = $("sc-thread-title");
  if (titleBtn) titleBtn.classList.toggle("hidden", isList);

  renderQuickStrip();

  if (isList) {
    renderListView();
  } else {
    const sc = byId(state.sideChatUi.activeId);
    renderThreadHeader(sc);
    renderThreadMessages();
    renderComposerState();
  }
}

function submitSideChatInput() {
  const input = $("sc-input");
  const sc = byId(state.sideChatUi.activeId);
  if (!sc || !input) return;
  if (isSideChatRunning(sc.id)) {
    stopSideChatTurn(sc.id);
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  composerDrafts.delete(input.dataset.draftOwner);
  input.value = "";
  triggerSideChatSend(sc.id, text);
}

function bindEvents() {
  const msgs = $("msgs");
  if (msgs) {
    msgs.addEventListener("mouseup", () => {
      setTimeout(handleTextSelection, 10);
    });
    msgs.addEventListener("keyup", (e) => {
      if (e.shiftKey) setTimeout(handleTextSelection, 10);
    });
    msgs.addEventListener("scroll", () => {
      if (!$("sc-selection-bar")?.classList.contains("hidden")) {
        hideSelectionPopover();
      }
    });
    msgs.addEventListener("click", (e) => {
      const delTarget = e.target.closest(".sc-anno-del, .sc-msg-fork-del");
      if (delTarget) {
        e.stopPropagation();
        const scId = delTarget.dataset.scId;
        if (scId) requestDeleteSideChat(scId);
        return;
      }
      if (e.target.closest("a, button:not(.sc-anno-badge):not(.sc-msg-fork-chip)")) return;
      const target = e.target.closest(".sc-anno-badge, mark.sc-anchor, .sc-msg-fork-chip");
      if (!target) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim().length >= 2) return;
      const scId = target.dataset.scId;
      if (scId) {
        e.stopPropagation();
        openSideChatThread(scId);
      }
    });
  }

  const messagesArea = document.querySelector(".messages-area");
  if (messagesArea && typeof ResizeObserver === "function") {
    selectionBarResizeObserver?.disconnect?.();
    selectionBarResizeObserver = new ResizeObserver(() => {
      repositionOpenSelectionBar();
    });
    selectionBarResizeObserver.observe(messagesArea);
  }

  document.addEventListener("mousedown", (e) => {
    const bar = $("sc-selection-bar");
    if (!bar || bar.classList.contains("hidden")) return;
    if (bar.contains(e.target)) return;
    if (!$("msgs")?.contains(e.target)) hideSelectionPopover();
  });

  $("btn-sc-sel-ask")?.addEventListener("click", () => {
    const pending = state.sideChatUi.pendingSelection;
    if (!pending) return;
    createSideChat({
      forkType: "selection",
      parentMessageId: pending.parentMessageId,
      anchor: pending.anchor,
    });
  });

  $("btn-sc-sel-explain")?.addEventListener("click", () => {
    const pending = state.sideChatUi.pendingSelection;
    if (!pending) return;
    createSideChat({
      forkType: "selection",
      parentMessageId: pending.parentMessageId,
      anchor: pending.anchor,
      autoPrompt: MICRO_SKILL_PROMPTS.explain(pending.anchor.quoteText),
    });
  });

  $("btn-sc-sel-existing")?.addEventListener("click", (e) => {
    const id = e.currentTarget?.dataset?.scId;
    hideSelectionPopover();
    if (id) openSideChatThread(id);
  });

  $("btn-sc-sel-delete")?.addEventListener("click", (e) => {
    const id = e.currentTarget?.dataset?.scId;
    if (id) requestDeleteSideChat(id);
  });

  $("btn-sc-sel-copy")?.addEventListener("click", async () => {
    const text = state.sideChatUi.pendingSelection?.anchor?.quoteText || "";
    if (text) await navigator.clipboard?.writeText?.(text).catch(() => {});
    hideSelectionPopover();
  });

  $("btn-sidechat-header")?.addEventListener("click", () => {
    if (state.view !== "chat") setView("chat");
    toggleSideChatPanel();
  });

  $("sc-drawer-backdrop")?.addEventListener("click", () => toggleSideChatPanel(false));
  $("btn-sc-close")?.addEventListener("click", () => toggleSideChatPanel(false));

  $("btn-sc-list")?.addEventListener("click", () => {
    if (!state.sideChats.length) {
      state.sideChatUi.view = "list";
    } else {
      state.sideChatUi.view = state.sideChatUi.view === "list" ? "thread" : "list";
    }
    renderSideChatPane();
  });

  $("btn-sc-new")?.addEventListener("click", () => {
    createSideChat({ forkType: "session" });
  });

  $("btn-sc-sort")?.addEventListener("click", () => {
    state.sideChatUi.sort = state.sideChatUi.sort === "position" ? "recent" : "position";
    renderListView();
  });

  document.querySelectorAll(".sc-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.sideChatUi.filter = btn.dataset.scFilter || "all";
      renderListView();
    });
  });

  $("sc-search")?.addEventListener("input", (e) => {
    state.sideChatUi.query = e.target.value || "";
    renderListView();
  });

  $("btn-sc-jump")?.addEventListener("click", () => {
    if (state.sideChatUi.activeId) jumpToAnchor(state.sideChatUi.activeId);
  });

  $("btn-sc-resolve")?.addEventListener("click", () => {
    const sc = byId(state.sideChatUi.activeId);
    if (!sc) return;
    sc.status = sc.status === "resolved" ? "active" : "resolved";
    sc.updatedAt = Date.now();
    syncMessageAnchors();
    renderSideChatPane();
    persistSession().catch(() => {});
  });

  $("btn-sc-delete")?.addEventListener("click", () => {
    const sc = byId(state.sideChatUi.activeId);
    if (!sc) return;
    requestDeleteSideChat(sc.id);
  });

  $("btn-sc-pinned-clear")?.addEventListener("click", () => {
    const sc = byId(state.sideChatUi.activeId);
    if (!sc) return;
    sc.pinnedNote = "";
    sc.updatedAt = Date.now();
    syncMessageAnchors();
    renderSideChatPane();
    persistSession().catch(() => {});
  });

  $("sc-thread-title")?.addEventListener("click", () => {
    const sc = byId(state.sideChatUi.activeId);
    if (!sc || typeof prompt !== "function") return;
    const next = prompt("重命名旁注标题", sc.title);
    if (next && next.trim()) {
      sc.title = next.trim().slice(0, 80);
      sc.updatedAt = Date.now();
      syncMessageAnchors();
      renderSideChatPane();
      persistSession().catch(() => {});
    }
  });

  $("btn-sc-pinned-edit")?.addEventListener("click", () => {
    const sc = byId(state.sideChatUi.activeId);
    if (!sc || typeof prompt !== "function") return;
    const next = prompt("编辑一句话批注（留空则清除）", sc.pinnedNote || "");
    if (next !== null) {
      sc.pinnedNote = next.trim().slice(0, 300);
      sc.updatedAt = Date.now();
      syncMessageAnchors();
      renderSideChatPane();
      persistSession().catch(() => {});
    }
  });

  document.querySelectorAll("[data-sc-micro]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sc = byId(state.sideChatUi.activeId);
      if (!sc) return;
      const key = btn.dataset.scMicro;
      const factory = MICRO_SKILL_PROMPTS[key];
      if (!factory) return;
      triggerSideChatSend(sc.id, factory(sc.anchor?.quoteText || ""));
    });
  });

  $("btn-sc-distill")?.addEventListener("click", async () => {
    const sc = byId(state.sideChatUi.activeId);
    if (!sc || distillingId === sc.id) return;
    distillingId = sc.id;
    renderComposerState();
    try {
      await distillSideChatNote(sc.id, {
        onDone: () => {
          syncMessageAnchors();
          renderSideChatPane();
        },
      });
      flashStatus("已凝练为一句话批注并固定到原文", true);
    } catch (err) {
      flashStatus(err?.message || String(err), false);
    } finally {
      distillingId = "";
      renderComposerState();
    }
  });

  $("btn-sc-send")?.addEventListener("click", submitSideChatInput);
  $("sc-input")?.addEventListener("input", ({ target }) => {
    const key = target.dataset.draftOwner;
    if (!key) return;
    if (target.value) composerDrafts.set(key, target.value);
    else composerDrafts.delete(key);
  });
  $("sc-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitSideChatInput();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.sideChatUi.open && !state.sideChatUi.wide && state.view === "chat") {
      toggleSideChatPanel(false);
    }
  });

  document.addEventListener("pagelens:sidechat-fork", (e) => {
    const detail = e.detail || {};
    createSideChat({
      forkType: detail.forkType || "message",
      parentMessageId: detail.messageId || "",
      anchor: detail.quoteText
        ? { quoteText: detail.quoteText, status: "attached" }
        : null,
    });
  });

  document.addEventListener("pagelens:sidechat-open", (e) => {
    const { sideChatId, jump } = e.detail || {};
    if (sideChatId) openSideChatThread(sideChatId, { jumpAnchor: Boolean(jump) });
  });

  document.addEventListener("pagelens:sidechat-delete", (e) => {
    const { sideChatId, force } = e.detail || {};
    if (sideChatId) requestDeleteSideChat(sideChatId, { force: Boolean(force) });
  });

  document.addEventListener("pagelens:sidechat-sync", () => {
    hideSelectionPopover();
    renderSideChatPane();
  });
}

function bindPanelResizer() {
  const resizer = $("sc-resizer");
  const pane = $("sidechat-pane");
  const viewChat = $("view-chat");
  if (!resizer || !pane || !viewChat) return;

  const usePointer = typeof window !== "undefined" && "PointerEvent" in window;
  const downEv = usePointer ? "pointerdown" : "mousedown";
  const moveEv = usePointer ? "pointermove" : "mousemove";
  const upEv = usePointer ? "pointerup" : "mouseup";

  const commitWidth = (widthPx, isWide) => {
    if (isWide) {
      state.sideChatUi.splitWidth = widthPx;
      writeWidthPref(STORAGE_SPLIT_WIDTH, widthPx);
    } else {
      state.sideChatUi.drawerWidth = widthPx;
      writeWidthPref(STORAGE_DRAWER_WIDTH, widthPx);
    }
    applyPaneWidth();
  };

  resizer.addEventListener(downEv, (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();

    const isWide = Boolean(state.sideChatUi.wide);
    const startX = e.clientX;
    const rectW = pane.getBoundingClientRect?.().width || 0;
    const styleW = parseFloat(pane.style.width) || 0;
    const startWidth = rectW > 0 ? rectW : (styleW > 0 ? styleW : DEFAULT_SPLIT_WIDTH);
    const containerW = viewChat.clientWidth || (typeof window !== "undefined" ? window.innerWidth : 800) || 800;
    const maxW = isWide
      ? Math.max(MIN_SIDECHAT_WIDTH, containerW - MIN_MAIN_SPLIT_WIDTH)
      : Math.max(MIN_SIDECHAT_WIDTH, containerW - MIN_NARROW_MARGIN);

    let latestWidth = clamp(startWidth, MIN_SIDECHAT_WIDTH, maxW);
    pane.classList.add("is-resizing");
    document.body.classList.add("sc-is-resizing");
    if (usePointer && e.pointerId != null) {
      try { resizer.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    }

    const onMove = (moveEvent) => {
      const delta = startX - moveEvent.clientX;
      latestWidth = clamp(startWidth + delta, MIN_SIDECHAT_WIDTH, maxW);
      if (isWide) state.sideChatUi.splitWidth = latestWidth;
      else state.sideChatUi.drawerWidth = latestWidth;
      pane.style.width = `${Math.round(latestWidth)}px`;
    };

    const onUp = () => {
      window.removeEventListener(moveEv, onMove);
      window.removeEventListener(upEv, onUp);
      if (usePointer) window.removeEventListener("pointercancel", onUp);
      if (usePointer && e.pointerId != null) {
        try { resizer.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
      }
      pane.classList.remove("is-resizing");
      document.body.classList.remove("sc-is-resizing");
      commitWidth(latestWidth, isWide);
    };

    window.addEventListener(moveEv, onMove);
    window.addEventListener(upEv, onUp);
    if (usePointer) window.addEventListener("pointercancel", onUp);
  });

  resizer.addEventListener("dblclick", () => {
    if (state.sideChatUi.wide) {
      state.sideChatUi.splitWidth = DEFAULT_SPLIT_WIDTH;
      writeWidthPref(STORAGE_SPLIT_WIDTH, DEFAULT_SPLIT_WIDTH);
    } else {
      state.sideChatUi.drawerWidth = 0;
      writeWidthPref(STORAGE_DRAWER_WIDTH, 0);
    }
    applyPaneWidth();
  });

  resizer.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    const isWide = Boolean(state.sideChatUi.wide);
    const containerW = viewChat.clientWidth || window.innerWidth || 800;
    const maxW = isWide
      ? Math.max(MIN_SIDECHAT_WIDTH, containerW - MIN_MAIN_SPLIT_WIDTH)
      : Math.max(MIN_SIDECHAT_WIDTH, containerW - MIN_NARROW_MARGIN);
    const cur = pane.getBoundingClientRect?.().width || parseFloat(pane.style.width) || DEFAULT_SPLIT_WIDTH;
    const step = e.key === "ArrowLeft" ? 24 : -24;
    const next = clamp(cur + step, MIN_SIDECHAT_WIDTH, maxW);
    commitWidth(next, isWide);
  });
}

function bindResponsiveObserver() {
  const viewChat = $("view-chat");
  if (!viewChat) return;
  const updateWidth = () => {
    if (viewChat.classList.contains("hidden")) return;
    const w = viewChat.clientWidth || window.innerWidth || 0;
    const wide = w >= WIDE_SPLIT_THRESHOLD;
    const changed = state.sideChatUi.wide !== wide;
    state.sideChatUi.wide = wide;
    if (changed) {
      renderSideChatPane();
    } else if (state.sideChatUi.open) {
      applyPaneWidth();
    }
  };
  updateWidth();
  if (typeof ResizeObserver === "function") {
    resizeObserver?.disconnect?.();
    resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(viewChat);
  } else {
    window.addEventListener("resize", updateWidth);
  }
}

export function initSideChat() {
  if (initialized) {
    renderSideChatPane();
    return;
  }
  initialized = true;
  state.sideChatUi.splitWidth = readWidthPref(STORAGE_SPLIT_WIDTH, DEFAULT_SPLIT_WIDTH);
  state.sideChatUi.drawerWidth = readWidthPref(STORAGE_DRAWER_WIDTH, 0);
  bindEvents();
  bindPanelResizer();
  bindResponsiveObserver();
  renderSideChatPane();
}

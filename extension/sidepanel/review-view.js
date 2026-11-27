import { $ } from "./dom.js";
import { ensureLibraryForWrite, openHistoryItem } from "./history.js";
import { settingsPage } from "./panel-refs.js";
import { persistSession, setView } from "./session.js";
import { renderSettingsForm } from "./settings-form.js";
import { state } from "./state.js";
import { escapeAttr } from "./text-providers-ui.js";
import { listAllClippings } from "../lib/clippings.js";
import { bindMarkdownLinks, enhanceMermaid, formatAnswer } from "../lib/markdown.js";
import { collectAllSideChats, formatWhen, loadAllSessions, loadSession, saveSession } from "../lib/sessions.js";
import {
  appendReviewToDailyNote,
  deleteReviewRecord,
  filterClippingsForPeriod,
  generateReviewSummary,
  getReviewByKey,
  getReviewPeriod,
  listAllReviews,
  writeReviewToObsidian,
} from "../lib/reviews.js";
import { isModelReady, resolveModel } from "../lib/storage.js";

async function openReviewView() {
  await persistSession({ ifDirty: true });
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
  const sidechatsContainer = $("review-sidechats-container");

  if (state.review.type === "sidechats") {
    periodBar?.classList.add("hidden");
    clipDrawer?.classList.add("hidden");
    actionsBar?.classList.add("hidden");
    outputContainer?.classList.add("hidden");
    historyContainer?.classList.add("hidden");
    sidechatsContainer?.classList.remove("hidden");
    await renderReviewSideChats();
    return;
  }

  if (state.review.type === "history") {
    periodBar?.classList.add("hidden");
    clipDrawer?.classList.add("hidden");
    actionsBar?.classList.add("hidden");
    outputContainer?.classList.add("hidden");
    sidechatsContainer?.classList.add("hidden");
    historyContainer?.classList.remove("hidden");
    await renderReviewHistory();
    return;
  }

  periodBar?.classList.remove("hidden");
  clipDrawer?.classList.remove("hidden");
  actionsBar?.classList.remove("hidden");
  outputContainer?.classList.remove("hidden");
  historyContainer?.classList.add("hidden");
  sidechatsContainer?.classList.add("hidden");

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
    renderSettingsForm();
    setView("settings");
    settingsPage?.reveal("block-text");
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

let reviewScFilter = "all";
let reviewScQuery = "";
let cachedAllSideChats = null;

function paintReviewSideChatsList(list) {
  const container = $("review-sc-list");
  if (!container) return;

  document.querySelectorAll("[data-review-sc-filter]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.reviewScFilter === reviewScFilter);
  });

  const q = reviewScQuery.trim().toLowerCase();
  const filtered = (list || []).filter(({ sessionTitle, pages, sideChat }) => {
    if (reviewScFilter === "active" && sideChat.status === "resolved") return false;
    if (reviewScFilter === "resolved" && sideChat.status !== "resolved") return false;
    if (reviewScFilter === "pinned" && !sideChat.pinnedNote) return false;
    if (!q) return true;
    const blob = [
      sessionTitle,
      ...(pages || []).map((p) => p.title || p.url || ""),
      sideChat.title,
      sideChat.anchor?.quoteText,
      sideChat.pinnedNote,
      ...(sideChat.messages || []).map((m) => m.text),
    ]
      .join(" ")
      .toLowerCase();
    return blob.includes(q);
  });

  container.replaceChildren();
  if (!list?.length) {
    container.innerHTML = `<div class="hist-empty">还没有跨会话旁注笔记。在对话回复里划词或点击「⑂ 裂变」即可沉淀到这里。</div>`;
    return;
  }
  if (!filtered.length) {
    container.innerHTML = `<div class="hist-empty">没有符合当前筛选条件的旁注笔记。</div>`;
    return;
  }

  for (const entry of filtered) {
    const { sessionId, sessionTitle, sideChat } = entry;
    const card = document.createElement("div");
    card.className = "review-sc-card";

    const head = document.createElement("div");
    head.className = "review-sc-head";
    const title = document.createElement("div");
    title.className = "sc-card-title";
    title.textContent = sideChat.title || "旁注分支";
    const status = document.createElement("span");
    status.className = "sc-status-tag " + (sideChat.status === "resolved" ? "is-resolved" : "is-active");
    status.textContent = sideChat.status === "resolved" ? "已掌握 ✓" : "思考中";
    head.append(title, status);
    card.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "review-sc-meta";
    meta.textContent = `会话：${sessionTitle || "未命名对话"} · ${formatWhen(sideChat.updatedAt)}`;
    card.appendChild(meta);

    if (sideChat.anchor?.quoteText) {
      const quote = document.createElement("div");
      quote.className = "sc-card-quote";
      quote.textContent = `“${sideChat.anchor.quoteText}”`;
      card.appendChild(quote);
    }

    if (sideChat.pinnedNote) {
      const pinned = document.createElement("div");
      pinned.className = "sc-card-pinned";
      pinned.textContent = `📌 ${sideChat.pinnedNote}`;
      card.appendChild(pinned);
    } else {
      const lastBot = [...(sideChat.messages || [])].reverse().find((m) => m.role === "bot" && !m.error && m.text);
      if (lastBot) {
        const ans = document.createElement("div");
        ans.className = "review-sc-answer";
        ans.textContent = lastBot.text;
        card.appendChild(ans);
      }
    }

    const foot = document.createElement("div");
    foot.className = "sc-card-foot";
    const turns = (sideChat.messages || []).filter((m) => m.role === "user").length;
    const info = document.createElement("span");
    info.textContent = `${turns} 轮追问`;

    const ops = document.createElement("div");
    ops.className = "sc-card-ops";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "secondary mini";
    openBtn.textContent = "打开并定位 ↗";
    openBtn.addEventListener("click", async () => {
      await openHistoryItem(sessionId);
      document.dispatchEvent(new CustomEvent("pagelens:sidechat-open", {
        detail: { sideChatId: sideChat.id, jump: true },
      }));
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "sc-mini-btn is-danger";
    delBtn.textContent = "删";
    delBtn.title = "删除此旁注笔记";
    let armed = false;
    let armTimer = 0;
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const hasTurns = (sideChat.messages || []).length > 0;
      if (hasTurns && !armed) {
        armed = true;
        delBtn.textContent = "确认?";
        delBtn.classList.add("is-armed");
        armTimer = setTimeout(() => {
          armed = false;
          delBtn.textContent = "删";
          delBtn.classList.remove("is-armed");
        }, 2600);
        return;
      }
      clearTimeout(armTimer);
      await deleteSideChatFromReview(sessionId, sideChat.id);
    });

    ops.append(openBtn, delBtn);
    foot.append(info, ops);
    card.appendChild(foot);
    container.appendChild(card);
  }
}

async function deleteSideChatFromReview(sessionId, sideChatId) {
  if (sessionId === state.sessionId) {
    document.dispatchEvent(new CustomEvent("pagelens:sidechat-delete", {
      detail: { sideChatId, force: true },
    }));
  } else {
    const sess = await loadSession(sessionId);
    if (sess) {
      sess.sideChats = (sess.sideChats || []).filter((sc) => sc.id !== sideChatId);
      await saveSession(sess, { keepActive: true });
    }
  }
  if (Array.isArray(cachedAllSideChats)) {
    cachedAllSideChats = cachedAllSideChats.filter(
      (entry) => !(entry.sessionId === sessionId && entry.sideChat.id === sideChatId),
    );
    paintReviewSideChatsList(cachedAllSideChats);
  }
}

async function renderReviewSideChats() {
  const container = $("review-sc-list");
  if (!container) return;
  container.innerHTML = `<div class="hist-empty">正在聚合全部会话的旁注笔记…</div>`;
  try {
    const sessions = await loadAllSessions();
    cachedAllSideChats = collectAllSideChats(sessions);
  } catch {
    cachedAllSideChats = [];
  }
  paintReviewSideChatsList(cachedAllSideChats);
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

  $("review-sc-search")?.addEventListener("input", (e) => {
    reviewScQuery = e.target.value || "";
    if (cachedAllSideChats) paintReviewSideChatsList(cachedAllSideChats);
  });
  document.querySelectorAll("[data-review-sc-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      reviewScFilter = btn.dataset.reviewScFilter || "all";
      if (cachedAllSideChats) paintReviewSideChatsList(cachedAllSideChats);
    });
  });
}


export {
  openReviewView,
  setReviewStatus,
  refreshReviewView,
  startGenerateReview,
  stopGenerateReview,
  handleExportReviewToObsidian,
  handleAppendReviewToDailyNote,
  handleCopyReview,
  handleDeleteActiveReview,
  renderReviewHistory,
  initReviewView,
};

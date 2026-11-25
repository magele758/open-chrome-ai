import { nativeSend } from "../lib/native-host.js";
import { $ } from "./dom.js";
import { ensureLibraryForWrite, flashStatus } from "./history.js";
import { restorePageContext } from "./media-chrome.js";
import { pushError, pushNotice } from "./messages.js";
import { state } from "./state.js";
import {
  clippingPageKey,
  dailyNoteRelPath,
  deleteClippingFull,
  executeClipping,
  getClippingsForUrl,
} from "../lib/clippings.js";
import { formatWhen } from "../lib/sessions.js";

function openClipModal(msg) {
  if (!msg) return;
  state.currentClipMsg = msg;
  const modal = $("clip-modal");
  if (!modal) return;

  const defaultTitle = msg.title || state.pack?.title || state.tab?.title || "未命名网页";
  const defaultUrl = msg.url || state.pack?.url || state.tab?.url || "";

  const titleInput = $("clip-input-title");
  const urlInput = $("clip-input-url");
  const noteInput = $("clip-input-note");
  const tagsInput = $("clip-input-tags");
  const preview = $("clip-content-preview");

  if (titleInput) titleInput.value = defaultTitle;
  if (urlInput) urlInput.value = defaultUrl;
  if (noteInput) noteInput.value = "";
  if (tagsInput) tagsInput.value = "";
  const previewText = msg.text || (state.share && defaultUrl === state.pack?.url ? state.pack?.text?.slice(0, 1200) : "") || "";
  state.currentClipMsg = { ...msg, text: previewText };
  if (preview) preview.textContent = previewText;
  $("clip-learning-status")?.replaceChildren();
  if ($("btn-clip-learning")) $("btn-clip-learning").disabled = false;

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

async function sendClipToLearning() {
  const msg = state.currentClipMsg;
  const button = $("btn-clip-learning"), status = $("clip-learning-status");
  if (!msg || !button || button.disabled || !status) return;
  const content = msg.text || "";
  const clip = {
    url: $("clip-input-url")?.value.trim(), title: $("clip-input-title")?.value.trim(),
    note: $("clip-input-note")?.value.trim(), ...(msg.selection ? { quote: content } : { content }),
  };
  button.disabled = true;
  status.textContent = "正在保存并查找联系…";
  try {
    const result = await nativeSend({ op: "learn_clip", clip }, { timeoutMs: 30000 });
    if (state.currentClipMsg !== msg) return;
    if (!result.ok) throw Error(result.error || "发送失败，可以重试。");
    const saved = result.duplicate ? "资料库已有这条剪藏" : "已保存到学习资料库";
    const details = document.createElement("a");
    details.href = result.readerUrl; details.target = "_blank"; details.rel = "noopener noreferrer";
    details.textContent = "打开剪藏";
    if (!result.reviewUrl) {
      status.replaceChildren(saved + " · ", details);
      return;
    }
    const review = details.cloneNode();
    review.href = result.reviewUrl;
    review.textContent = "在图谱里查看";
    let summary = saved;
    if (result.matchingStatus === "queued") summary += "，等待匹配";
    else if (Number.isInteger(result.pendingCount))
      summary += result.pendingCount ? "，" + result.pendingCount + " 条联系待确认" : "，当前没有待确认联系";
    status.replaceChildren(summary + " · ", review, " · ", details);
  } catch (error) {
    if (state.currentClipMsg === msg) status.textContent = error.message || "发送失败，可以重试。";
  } finally {
    if (state.currentClipMsg === msg) button.disabled = false;
  }
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
      confirmBtn.textContent = "保存到所选位置";
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


export {
  openClipModal,
  closeClipModal,
  submitClipModal,
  sendClipToLearning,
  recallDismissKey,
  checkSmartRecall,
  dismissRecallBanner,
  openClipViewModal,
  handleDeleteClipping,
  closeClipViewModal,
  handleClipCurrentPage,
};

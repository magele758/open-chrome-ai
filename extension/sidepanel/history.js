import { renderAttach } from "./composer.js";
import { $ } from "./dom.js";
import { paintLibraryStatus } from "./library-ui.js";
import { renderMessages } from "./messages.js";
import { renderModelLine, setModelLineMeta } from "./model-line.js";
import { applySession, downloadText, persistSession, resolveWindowId, setView, settleBusy } from "./session.js";
import { state } from "./state.js";
import { deleteSessionArtifacts } from "../lib/agent/artifact-store.js";
import { libraryStatus, pickLibraryFolder, writeSessionNote, writeSessionNotes } from "../lib/library.js";
import {
  deleteSession,
  filterSessions,
  formatWhen,
  listSessions,
  loadAllSessions,
  loadSession,
  saveSession,
  sessionFilename,
  sessionToMarkdown,
  sessionsToJSON,
  sessionsToMarkdown,
} from "../lib/sessions.js";

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


export {
  histStatus,
  pageLines,
  renderHistory,
  openHistoryItem,
  exportOne,
  exportAll,
  flashStatus,
  ensureLibraryForWrite,
  importOneToLibrary,
  importAllToLibrary,
  importCurrentToLibrary,
  removeHistoryItem,
  openHistoryView,
};

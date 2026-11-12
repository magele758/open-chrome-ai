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

const HIST_DISCLOSURE_PREFIX = "pagelens.histGroupDisclosure.";
const RELATION_BOARD = 280;
const RELATION_NODE_CAP = 8;
const SVG_NS = "http://www.w3.org/2000/svg";

function sessionHosts(item) {
  return [...new Set((item.pages || []).map((page) => page.hostname).filter(Boolean))];
}

function primaryHost(item) {
  return sessionHosts(item)[0] || "未分享页面";
}

function histGroupOpen(name) {
  try {
    return localStorage.getItem(HIST_DISCLOSURE_PREFIX + encodeURIComponent(name)) !== "collapsed";
  } catch {
    return true;
  }
}

function setHistGroupOpen(name, open) {
  try {
    const key = HIST_DISCLOSURE_PREFIX + encodeURIComponent(name);
    if (open) localStorage.removeItem(key);
    else localStorage.setItem(key, "collapsed");
  } catch {
    // 存储不可用时仍允许当场收起。
  }
}

function placeRelationNodes(ids) {
  const count = ids.length;
  const center = RELATION_BOARD / 2;
  const radius = count <= 1 ? 0 : Math.min(98, 36 + count * 6);
  return ids.map((id, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / Math.max(count, 1);
    return {
      id,
      x: count === 1 ? center : center + radius * Math.cos(angle),
      y: count === 1 ? center : center + radius * Math.sin(angle),
    };
  });
}

function relationCurve(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.max(1, Math.hypot(dx, dy));
  const cx = (from.x + to.x) / 2 - (14 * dy) / dist;
  const cy = (from.y + to.y) / 2 + (14 * dx) / dist;
  return `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`;
}

function relationGraph(items) {
  const counts = new Map();
  const pairs = new Map();
  for (const item of items) {
    const hosts = sessionHosts(item);
    const nodes = hosts.length ? hosts : ["未分享页面"];
    for (const host of nodes) counts.set(host, (counts.get(host) || 0) + 1);
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const key = [nodes[i], nodes[j]].sort().join("\0");
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }
    }
  }
  const ids = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
    .slice(0, RELATION_NODE_CAP)
    .map(([id]) => id);
  const visible = new Set(ids);
  const edges = [...pairs.keys()]
    .map((key) => key.split("\0"))
    .filter(([from, to]) => visible.has(from) && visible.has(to));
  return { ids, points: placeRelationNodes(ids), edges };
}

function groupSessions(items) {
  const groups = new Map();
  for (const item of items) {
    const name = primaryHost(item);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  return [...groups.entries()].sort((a, b) => {
    if (a[0] === "未分享页面") return 1;
    if (b[0] === "未分享页面") return -1;
    return b[1].length - a[1].length || a[0].localeCompare(b[0], "zh");
  });
}

function groupForHost(host, items) {
  if (items.some((item) => primaryHost(item) === host)) return host;
  const related = items.find((item) => sessionHosts(item).includes(host));
  return related ? primaryHost(related) : host;
}

function revealHistGroup(root, name) {
  const section = [...root.querySelectorAll("[data-hist-group]")].find((node) => node.dataset.histGroup === name);
  if (!section) return;
  const toggle = section.querySelector(".lab-toggle");
  if (toggle?.getAttribute("aria-expanded") !== "true") toggle.click();
  section.scrollIntoView({ block: "nearest" });
}

function historyRow(item) {
  const row = document.createElement("div");
  row.className = "hist-item" + (item.id === state.sessionId ? " active" : "");
  const main = document.createElement("button");
  main.type = "button";
  main.className = "hist-main";
  main.title = "打开这条对话";
  const hosts = sessionHosts(item);
  const hostLabel = hosts.length === 1 ? hosts[0] : hosts.length ? `${hosts[0]} 等 ${hosts.length} 站` : "未分享页面";
  const title = document.createElement("div");
  title.className = "t";
  title.textContent = item.title || "未命名对话";
  const meta = document.createElement("div");
  meta.className = "s";
  meta.textContent = [hostLabel, formatWhen(item.updatedAt), `${item.messageCount || 0} 条`].filter(Boolean).join(" · ");
  const pages = document.createElement("div");
  pages.className = "pages";
  pages.textContent = pageLines(item.pages);
  main.append(title, meta, pages);
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
  return row;
}

function historyGroup(name, items, index) {
  const open = histGroupOpen(name);
  const section = document.createElement("section");
  section.className = "lab-group";
  section.dataset.histGroup = name;
  const heading = document.createElement("div");
  heading.className = "lab-heading";
  const title = document.createElement("h3");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "lab-toggle";
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-controls", `hist-group-${index}`);
  toggle.title = `${open ? "收起" : "展开"} ${name}`;
  const chevron = document.createElement("span");
  chevron.className = "lab-chevron";
  chevron.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = name;
  toggle.append(chevron, label);
  title.append(toggle);
  const count = document.createElement("span");
  count.className = "lab-count";
  count.textContent = String(items.length);
  heading.append(title, count);
  const body = document.createElement("div");
  body.id = `hist-group-${index}`;
  body.className = "lab-group-body";
  body.hidden = !open;
  for (const item of items) body.append(historyRow(item));
  toggle.addEventListener("click", () => {
    const next = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(next));
    toggle.title = `${next ? "收起" : "展开"} ${name}`;
    body.hidden = !next;
    setHistGroupOpen(name, next);
  });
  section.append(heading, body);
  return section;
}

function relationBoard(items, root) {
  const graph = relationGraph(items);
  if (!graph.ids.length) return null;
  const byId = new Map(graph.points.map((point) => [point.id, point]));
  const section = document.createElement("section");
  section.className = "lab-network";
  section.setAttribute("aria-label", "网页关系");
  const board = document.createElement("div");
  board.className = "lab-board";
  const viewport = document.createElement("div");
  viewport.className = "lab-viewport";
  const stage = document.createElement("div");
  stage.className = "lab-stage";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${RELATION_BOARD} ${RELATION_BOARD}`);
  svg.setAttribute("aria-hidden", "true");
  for (const [from, to] of graph.edges) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", relationCurve(byId.get(from), byId.get(to)));
    path.setAttribute("class", "lab-edge");
    svg.append(path);
  }
  stage.append(svg);
  for (const point of graph.points) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "lab-node";
    node.style.left = `${(100 * point.x) / RELATION_BOARD}%`;
    node.style.top = `${(100 * point.y) / RELATION_BOARD}%`;
    node.title = point.id;
    node.setAttribute("aria-label", `查看 ${point.id}`);
    const face = document.createElement("span");
    face.className = "lab-face";
    face.textContent = [...point.id][0] || "·";
    const caption = document.createElement("span");
    caption.className = "lab-caption";
    caption.textContent = point.id;
    node.append(face, caption);
    node.addEventListener("click", () => revealHistGroup(root, groupForHost(point.id, items)));
    stage.append(node);
  }
  const hint = document.createElement("span");
  hint.className = "lab-pan-hint";
  hint.textContent = graph.edges.length ? "同一场对话里一起出现的网站" : "按网站陈列；跨站的一场对话会连成线";
  viewport.append(stage);
  board.append(viewport, hint);
  section.append(board);
  if (graph.edges.length) {
    const legend = document.createElement("div");
    legend.className = "lab-legend";
    const item = document.createElement("span");
    item.textContent = "同场出现";
    legend.append(item);
    section.append(legend);
  }
  return section;
}

async function renderHistory() {
  const root = $("hist-list");
  if (!root) return;
  const index = filterSessions(await listSessions(), state.histQuery);
  root.replaceChildren();
  if (!index.length) {
    const empty = document.createElement("p");
    empty.className = "hist-empty";
    empty.textContent = state.histQuery ? "没有匹配的对话。" : "还没有历史。问完就会自动保存，并记下当时的网页。";
    root.appendChild(empty);
    return;
  }
  const board = relationBoard(index, root);
  if (board) root.append(board);
  groupSessions(index).forEach(([name, items], indexInList) => {
    root.append(historyGroup(name, items, indexInList));
  });
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

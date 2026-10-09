import { $ } from "./dom.js";
import { renderModelLine } from "./model-line.js";
import { state } from "./state.js";
import { libraryStatus } from "../lib/library.js";

function paintLibraryStatus(info, extra = "") {
  const el = $("library-status");
  const displayName = $("library-display-name");
  const descEl = $("library-status-desc");
  if (displayName) {
    displayName.textContent = info?.name || info?.path || "Obsidian / Notes";
  }
  if (descEl) {
    descEl.textContent = info?.configured
      ? (info.granted ? "用于剪藏和对话笔记 · 已授权" : "用于剪藏和对话笔记 · 需要重新授权")
      : "用于剪藏和对话笔记";
  }
  if (!el) return;
  const reauth = $("btn-library-reauth");
  const input = $("library-path");
  if (info?.mode === "path" && info.path && input && document.activeElement !== input) {
    input.value = info.path;
  }
  if (!info?.configured) {
    el.textContent = extra || "尚未选择";
    el.className = "status";
    reauth?.classList.add("hidden");
    return;
  }
  if (info.mode === "path") {
    reauth?.classList.add("hidden");
    if (info.granted) {
      el.textContent = extra || `路径 · ${info.path || info.name}`;
      el.className = "status ok";
      return;
    }
    el.textContent = extra || info.error || `路径不可用 · ${info.path || info.name}`;
    el.className = "status bad";
    return;
  }
  if (info.granted) {
    el.textContent = extra || `已授权 · ${info.name}（浏览器不显示完整路径）`;
    el.className = "status ok";
    reauth?.classList.add("hidden");
    return;
  }
  el.textContent = extra || `已选 ${info.name}，需要重新授权`;
  el.className = "status bad";
  reauth?.classList.remove("hidden");
}

async function refreshLibraryStatus({ request = false } = {}) {
  try {
    state.library = await libraryStatus({ request });
  } catch {
    state.library = { configured: false, granted: false, name: "" };
  }
  paintLibraryStatus(state.library);
  renderModelLine();
}

function renderLibraryStatus() {
  paintLibraryStatus(state.library);
}


export {
  paintLibraryStatus,
  refreshLibraryStatus,
  renderLibraryStatus,
};

import { $ } from "./dom.js";
import { paintLibraryStatus } from "./library-ui.js";
import { renderModelLine, skillsOn } from "./model-line.js";
import { clearSkillsCache } from "./slash-menu.js";
import { state } from "./state.js";
import { setLibraryPath, syncPackToLibrary } from "../lib/library.js";
import { setSkillFolderPath } from "../lib/skill-folder.js";

function paintSkillFolderStatus(info, extra = "") {
  const el = $("skill-folder-status");
  if (!el) return;
  const reauth = $("btn-skills-reauth");
  const refresh = $("btn-skills-refresh");
  const input = $("skill-path");
  if (info?.mode === "path" && info.path && input && document.activeElement !== input) {
    input.value = info.path;
  }
  if (!skillsOn()) {
    const path = info?.path || info?.name;
    el.textContent = extra || (info?.configured ? `已关闭 · 路径仍保留${path ? ` · ${path}` : ""}` : "已关闭（默认）");
    el.className = "status";
    reauth?.classList.add("hidden");
    refresh?.classList.add("hidden");
    return;
  }
  if (!info?.configured) {
    el.textContent = extra || "尚未选择";
    el.className = "status";
    reauth?.classList.add("hidden");
    refresh?.classList.add("hidden");
    return;
  }
  if (info.mode === "path") {
    reauth?.classList.add("hidden");
    if (info.granted) {
      const n = Number(info.count) || 0;
      const cap = info.truncated ? "，已达扫描上限" : "";
      el.textContent = extra || (state.skillsMetaReady
        ? `路径 · ${info.path || info.name} · ${n} 个 skill${cap}`
        : `路径 · ${info.path || info.name} · 输入 / 时再扫描`);
      el.className = "status ok";
      refresh?.classList.remove("hidden");
      return;
    }
    el.textContent = extra || info.error || `路径不可用 · ${info.path || info.name}`;
    el.className = "status bad";
    refresh?.classList.remove("hidden");
    return;
  }
  if (info.granted) {
    const n = Number(info.count) || 0;
    const cap = info.truncated ? "，已达扫描上限" : "";
    el.textContent = extra || (state.skillsMetaReady
      ? `已授权 · ${info.name} · ${n} 个 skill${cap}（浏览器不显示完整路径）`
      : `已授权 · ${info.name} · 输入 / 时再扫描`);
    el.className = "status ok";
    reauth?.classList.add("hidden");
    refresh?.classList.remove("hidden");
    return;
  }
  el.textContent = extra || `已选 ${info.name}，需要重新授权`;
  el.className = "status bad";
  reauth?.classList.remove("hidden");
  refresh?.classList.add("hidden");
}

function renderSkillFolderStatus() {
  paintSkillFolderStatus(state.skillFolder);
}

function folderPathDirty(raw, current) {
  const next = String(raw || "").trim();
  const cur = String(current || "").trim();
  if (!next) return "";
  return next === cur ? "" : next;
}

async function applyFolderPathsFromInputs() {
  const errors = [];
  const libRaw = folderPathDirty($("library-path")?.value, state.library?.path);
  if (libRaw) {
    try {
      paintLibraryStatus(state.library, "正在验证路径…");
      state.library = await setLibraryPath(libRaw);
      paintLibraryStatus(state.library);
      if (state.pack?.captionsStatus === "ready") syncPackToLibrary(state.pack).catch(() => {});
    } catch (err) {
      const msg = err.message || String(err);
      paintLibraryStatus(state.library, msg);
      errors.push(`文稿：${msg}`);
    }
  }
  const skillRaw = folderPathDirty($("skill-path")?.value, state.skillFolder?.path);
  if (skillRaw) {
    try {
      paintSkillFolderStatus(state.skillFolder, "正在验证路径…");
      const next = await setSkillFolderPath(skillRaw);
      state.skillFolder = { ...next, count: 0 };
      clearSkillsCache();
      paintSkillFolderStatus(state.skillFolder, `已设置 ${next.path}，输入 / 时再扫描`);
    } catch (err) {
      const msg = err.message || String(err);
      paintSkillFolderStatus(state.skillFolder, msg);
      errors.push(`Skill：${msg}`);
    }
  }
  renderModelLine();
  return errors;
}


export {
  paintSkillFolderStatus,
  renderSkillFolderStatus,
  folderPathDirty,
  applyFolderPathsFromInputs,
};

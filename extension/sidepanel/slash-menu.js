import { withTimeout } from "./agent-loop.js";
import { $ } from "./dom.js";
import { fitInput, renderModelLine, skillsOn } from "./model-line.js";
import { settingsPage } from "./panel-refs.js";
import { setView } from "./session.js";
import { renderSettingsForm } from "./settings-form.js";
import { paintSkillFolderStatus } from "./skill-folder-ui.js";
import { state } from "./state.js";
import { escapeAttr } from "./text-providers-ui.js";
import { loadRuntimeSkills } from "../lib/agent/skills.js";
import { ensureSkillBody, skillFolderStatus } from "../lib/skill-folder.js";
import { applySlashItem, filterSlashItems, parseSlashToken, slashItemsFromSkills } from "../lib/slash.js";

let skillScanGen = 0;
let slash = { open: false, items: [], index: 0, token: null };

function hideSlashMenu() {
  slash = { open: false, items: [], index: 0, token: null };
  const el = $("slash-menu");
  if (!el) return;
  el.innerHTML = "";
  el.classList.add("hidden");
}

function renderSlashMenu() {
  const el = $("slash-menu");
  if (!el) return;
  el.innerHTML = "";
  if (!slash.open) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  if (!slash.items.length) {
    const empty = document.createElement("div");
    empty.className = "slash-empty";
    empty.textContent = state.skillsMetaLoading
      ? "正在扫描 skill…"
      : state.skillsMetaError
        ? state.skillsMetaError
        : (state.skills || []).length
          ? "没有匹配的 skill"
          : "没有可用 skill。到设置选择 skill 目录。";
    el.appendChild(empty);
    return;
  }
  slash.items.forEach((item, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slash-item" + (i === slash.index ? " active" : "");
    btn.setAttribute("role", "option");
    const n = document.createElement("div");
    n.className = "n";
    n.textContent = item.name;
    btn.appendChild(n);
    const detail = [item.id !== item.name ? item.id : "", item.hint].filter(Boolean).join(" · ");
    if (detail) {
      const d = document.createElement("div");
      d.className = "d";
      d.textContent = detail;
      btn.appendChild(d);
    }
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      pickSlashItem(item);
    });
    el.appendChild(btn);
  });
  el.querySelector(".slash-item.active")?.scrollIntoView({ block: "nearest" });
}

function updateSlashMenu() {
  const input = $("input");
  if (!input || state.view !== "chat" || !skillsOn()) {
    hideSlashMenu();
    return;
  }
  const token = parseSlashToken(input.value, input.selectionStart);
  if (!token) {
    hideSlashMenu();
    return;
  }
  if (state.skillsMetaLoading || !state.skillsMetaReady) {
    slash = { open: true, items: [], index: 0, token };
    renderSlashMenu();
    if (!state.skillsMetaLoading && !state.skillsMetaError) ensureSkillsMeta();
    return;
  }
  const items = filterSlashItems(slashItemsFromSkills(state.skills), token.query);
  const sameQuery = slash.open && slash.token && slash.token.query === token.query;
  slash = {
    open: true,
    items,
    index: sameQuery ? Math.min(slash.index, Math.max(0, items.length - 1)) : 0,
    token,
  };
  renderSlashMenu();
}

function pickSlashItem(item) {
  const input = $("input");
  if (!input || !item) {
    hideSlashMenu();
    return;
  }
  const token = slash.token || parseSlashToken(input.value, input.selectionStart);
  if (!token) {
    hideSlashMenu();
    return;
  }
  const next = applySlashItem(input.value, token, item);
  input.value = next.text;
  input.setSelectionRange(next.cursor, next.cursor);
  hideSlashMenu();
  fitInput();
  input.focus();
  if (item.skill) ensureSkillBody(item.skill).catch(() => {});
}

function handleSlashKey(e) {
  if (!slash.open || e.isComposing) return false;
  if (e.key === "Escape") {
    e.preventDefault();
    hideSlashMenu();
    return true;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!slash.items.length) return true;
    const delta = e.key === "ArrowDown" ? 1 : -1;
    slash.index = (slash.index + delta + slash.items.length) % slash.items.length;
    renderSlashMenu();
    return true;
  }
  if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
    if (!slash.items.length) return false;
    e.preventDefault();
    pickSlashItem(slash.items[slash.index]);
    return true;
  }
  return false;
}

let skillsMetaPromise = null;

function clearSkillsCache() {
  skillScanGen += 1;
  skillsMetaPromise = null;
  state.skills = [];
  state.skillsMetaReady = false;
  state.skillsMetaLoading = false;
  state.skillsMetaError = "";
}

async function hydrateSkillFolderStatus() {
  try {
    const status = await skillFolderStatus();
    state.skillFolder = {
      configured: status.configured,
      granted: status.granted,
      mode: status.mode || "",
      name: status.name || "",
      path: status.path || "",
      count: state.skillsMetaReady ? state.skillFolder.count || status.count || 0 : 0,
      truncated: state.skillFolder.truncated === true,
      error: status.error || "",
    };
    paintSkillFolderStatus(state.skillFolder);
  } catch (err) {
    console.warn("[pagelens] skill status", err);
  }
}

async function ensureSkillsMeta({ force = false, timeoutMs = 8000, request = false } = {}) {
  if (!skillsOn()) {
    console.info("[pagelens] skill scan skip");
    state.skills = [];
    state.skillsMetaReady = true;
    state.skillsMetaLoading = false;
    state.skillsMetaError = "";
    return state.skillFolder;
  }
  if (state.skillsMetaReady && !force) return state.skillFolder;
  if (skillsMetaPromise && !force) return skillsMetaPromise;
  const gen = ++skillScanGen;
  state.skillsMetaLoading = true;
  state.skillsMetaError = "";
  if (force) state.skillsMetaReady = false;
  if (state.skillFolder?.configured) {
    paintSkillFolderStatus(state.skillFolder, "正在扫描…");
  }
  const run = (async () => {
    try {
      const loaded = await withTimeout(
        loadRuntimeSkills({ request, timeoutMs }),
        timeoutMs,
        "扫描 skill 超时",
      );
      if (gen !== skillScanGen) return state.skillFolder;
      state.skillFolder = {
        configured: loaded.folder.configured,
        granted: loaded.folder.granted,
        mode: loaded.folder.mode || "",
        name: loaded.folder.name || "",
        path: loaded.folder.path || "",
        count: loaded.folder.count || 0,
        truncated: loaded.folder.truncated === true,
        error: loaded.folder.error || "",
      };
      state.skills = loaded.skills;
      state.skillsMetaReady = true;
      state.skillsMetaError = loaded.folder.error || "";
    } catch (err) {
      if (gen !== skillScanGen) return state.skillFolder;
      console.warn("[pagelens] skill scan timeout/error", err);
      state.skillsMetaError = err?.message || String(err);
      state.skillsMetaReady = false;
    } finally {
      if (gen === skillScanGen) {
        state.skillsMetaLoading = false;
        if (skillsMetaPromise === run) skillsMetaPromise = null;
        paintSkillFolderStatus(state.skillFolder);
        renderModelLine();
        if (slash.open) updateSlashMenu();
      }
    }
    return state.skillFolder;
  })();
  skillsMetaPromise = run;
  return run;
}

function renderShortcutList() {
  const list = $("shortcut-list");
  if (!list) return;
  list.innerHTML = "";
  if (!Array.isArray(state.settings.shortcuts)) state.settings.shortcuts = [];
  state.settings.shortcuts.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    row.innerHTML = `
      <input class="shortcut-label" data-si="${index}" data-sk="label" value="${escapeAttr(item.label)}" placeholder="芯片名，如 找槽点" />
      <textarea class="shortcut-prompt" data-si="${index}" data-sk="prompt" rows="2" placeholder="点芯片时发给模型的完整问题">${escapeAttr(item.prompt)}</textarea>
      <button type="button" class="shortcut-del" data-del="${index}" title="删除">删</button>
    `;
    list.appendChild(row);
  });
  if (!state.settings.shortcuts.length) {
    const empty = document.createElement("p");
    empty.className = "lead";
    empty.textContent = "还没有自定义问题。";
    list.appendChild(empty);
  }
  list.querySelectorAll("[data-sk]").forEach((el) => {
    el.addEventListener("input", () => {
      const i = Number(el.dataset.si);
      const key = el.dataset.sk;
      if (!state.settings.shortcuts[i]) return;
      state.settings.shortcuts[i][key] = el.value;
    });
  });
  list.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.del);
      state.settings.shortcuts.splice(i, 1);
      renderShortcutList();
    });
  });
}

function openShortcutSettings() {
  renderSettingsForm();
  setView("settings");
  settingsPage?.reveal("block-shortcuts");
}


export {
  skillScanGen,
  slash,
  hideSlashMenu,
  renderSlashMenu,
  updateSlashMenu,
  pickSlashItem,
  handleSlashKey,
  skillsMetaPromise,
  clearSkillsCache,
  hydrateSkillFolderStatus,
  ensureSkillsMeta,
  renderShortcutList,
  openShortcutSettings,
};

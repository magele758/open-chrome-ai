import { $ } from "./dom.js";
import { resolveWindowId } from "./session.js";
import { isHttpUrl } from "../lib/chrome.js";
import { nativeSavedTabGroups } from "../lib/native-host.js";
import {
  listSavedTabGroups,
  saveTabGroupRecord,
} from "../lib/saved-tab-groups.js";
import {
  createSavedTabGroupTools,
  deleteSingleNativeSavedGroup,
  matchOpenGroupForNative,
} from "../lib/agent/saved-tab-group-tools.js";
import { normalizeGroupTitle } from "../lib/agent/tab-group-tools.js";

const COLOR_HEX = Object.freeze({
  grey: "#7f8c8d",
  blue: "#3b82f6",
  red: "#ef4444",
  yellow: "#eab308",
  green: "#22c55e",
  pink: "#ec4899",
  purple: "#a855f7",
  cyan: "#06b6d4",
  orange: "#f97316",
});

function defaultApi() {
  return globalThis.chrome;
}

function defaultStorage(api) {
  return api?.storage?.local;
}

async function fetchOpenSnapshot(api) {
  const [openGroups, openTabs] = await Promise.all([api.tabGroups.query({}), api.tabs.query({})]);
  const byGroup = new Map();
  for (const tab of openTabs) {
    if (Number.isInteger(tab.groupId) && tab.groupId >= 0) {
      if (!byGroup.has(tab.groupId)) byGroup.set(tab.groupId, []);
      byGroup.get(tab.groupId).push(tab);
    }
  }
  return { openGroups, byGroup };
}

export function bindSavedGroupsPanel({
  api,
  storage,
  nativeCall,
  getWindowId,
} = {}) {
  const panel = $("saved-groups-panel");
  if (!panel || panel.dataset.sgBound === "1") return null;
  panel.dataset.sgBound = "1";

  const getApi = () => api || defaultApi();
  const getStorage = () => storage || defaultStorage(getApi());
  const callNative = (payload) => (nativeCall ? nativeCall(payload) : nativeSavedTabGroups(payload));
  const resolveWin = getWindowId || resolveWindowId;
  const dialog = $("sg-dialog");
  const nameInput = $("sg-dialog-name");

  function askInPanel(message, currentName) {
    if (dialog.open) return Promise.resolve(null);
    const renaming = currentName !== undefined;
    $("sg-dialog-message").textContent = message;
    $("sg-dialog-accept").textContent = renaming ? "保存名称" : "永久删除";
    nameInput.hidden = !renaming;
    nameInput.value = currentName || "";
    dialog.returnValue = "";
    const result = new Promise((resolve) => {
      let settled = false;
      const form = $("sg-dialog-form");
      const onClose = () => {
        const accepted = dialog.returnValue === "accept";
        dialog.returnValue = "";
        finish(accepted ? (renaming ? nameInput.value : true) : null);
      };
      // Chrome can close method=dialog and leave returnValue set without a close
      // event. Settle from submit, but do not preventDefault or call close().
      const onSubmit = (event) => {
        if (event.submitter?.value !== "accept") return;
        finish(renaming ? nameInput.value : true);
      };
      function finish(value) {
        if (settled) return;
        settled = true;
        dialog.removeEventListener("close", onClose);
        form.removeEventListener("submit", onSubmit);
        resolve(value);
      }
      // Read returnValue here. Esc sets none, and a stale value must not leak.
      dialog.addEventListener("close", onClose);
      form.addEventListener("submit", onSubmit);
    });
    dialog.showModal();
    if (renaming) {
      nameInput.focus();
      nameInput.select();
    } else {
      $("sg-dialog-cancel").focus();
    }
    return result;
  }

  $("sg-dialog-cancel").addEventListener("click", () => dialog.close("cancel"));

  async function actOnItem(name, item, args) {
    const windowId = await resolveWin();
    const ctx = { getWindowId: () => windowId, detectOpenedInOtherWindow: true };
    if (item.source === "chrome_native" && item.isOpen) {
      ctx.expectedOpenGroup = { profile: item.profile, guid: item.guid, id: item.openGroupId, windowId: item.openWindowId };
    }
    let result;
    if (name === "delete_saved_tab_group" && item.source === "chrome_native") {
      result = await deleteSingleNativeSavedGroup({
        chromeApi: getApi(), callNative, ctx, target: item, profile: item.profile,
      });
    } else {
      const tools = createSavedTabGroupTools(ctx, { api: getApi(), storage: getStorage(), nativeCall: callNative });
      const target = item.source === "pagelens"
        ? { source: item.source, id: item.id }
        : { source: item.source, guid: item.guid, profile: item.profile };
      const text = await tools.find((tool) => tool.name === name).execute({ ...target, ...args });
      try { result = JSON.parse(text); } catch { throw new Error(text); }
    }
    if (!result?.ok) {
      const hint = result.code === "WINDOW_SCOPE" ? "请回到此侧栏核对目标组及其所在窗口。" : result.hint;
      const message = [result.error || "操作失败。", hint].filter(Boolean).join(" ");
      throw Object.assign(new Error(message), { code: result.code });
    }
    return result;
  }

  let allItems = [];
  let filterMode = "all"; // all | open | pagelens
  let searchQuery = "";
  let selectedKeys = new Set();
  let loadedProfile = "";
  let panelWindowId;
  let busy = false;
  let deleting = false;
  let stopRequested = false;
  let loadError = "";
  let loadSeq = 0;

  function setStatus(text, ok) {
    const el = $("sg-status");
    if (!el) return;
    el.textContent = text || "";
    el.className = "status sg-status" + (ok === true ? " ok" : ok === false ? " bad" : "");
  }

  function isClosedNative(item) {
    return item.source === "chrome_native" && item.openState === "closed";
  }

  function canDelete(item) {
    return item.source === "pagelens" || (item.source === "chrome_native" && item.isOpen);
  }

  function nativeBlockedMessage(item) {
    if (item.source === "pagelens" || item.isOpen) return "";
    if (item.openState === "unknown") return "无法确认该组是否已打开，请刷新后再试。";
    return "请先在 Chrome 中打开该组。";
  }

  function filteredItems() {
    const q = String(searchQuery || "").trim().toLowerCase();
    return allItems.filter((item) => {
      if (filterMode === "open" && !item.isOpen) return false;
      if (filterMode === "pagelens" && item.source !== "pagelens") return false;
      if (q) {
        const hay = `${item.title || ""} ${(item.tabs || []).map((t) => `${t.title || ""} ${t.url || ""}`).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function keepVisibleSelection() {
    selectedKeys = new Set(filteredItems().filter((item) => selectedKeys.has(item.key)).map((item) => item.key));
  }

  function updateBatchControls(visibleItems) {
    const selected = visibleItems.filter((item) => selectedKeys.has(item.key));
    const deletableCount = selected.filter(canDelete).length;
    const unavailableCount = selected.length - deletableCount;

    const selectAll = $("sg-select-all");
    if (selectAll) {
      selectAll.disabled = busy || visibleItems.length === 0;
      selectAll.checked = visibleItems.length > 0 && selected.length === visibleItems.length;
      selectAll.indeterminate = selected.length > 0 && selected.length < visibleItems.length;
    }
    const countEl = $("sg-selected-count");
    if (countEl) {
      countEl.title = loadedProfile ? `Chrome 配置：${loadedProfile}` : "";
      countEl.textContent = visibleItems.length
        ? `显示 ${visibleItems.length} / 共 ${allItems.length} · 已选 ${selected.length}`
        : `共 ${allItems.length} 个`;
    }
    const closedCount = selected.filter(isClosedNative).length;
    const unknownCount = unavailableCount - closedCount;
    const hints = [];
    if (closedCount) hints.push(`${closedCount} 个未打开的 Chrome 保存组需先在 Chrome 中打开。`);
    if (unknownCount) hints.push(`${unknownCount} 个所选组的打开状态无法确认。请刷新列表。`);
    $("sg-selection-hint").textContent = hints.join("");
    const delBtn = $("btn-sg-batch-delete");
    if (delBtn) {
      delBtn.classList.toggle("hidden", selected.length === 0);
      delBtn.disabled = busy || deletableCount === 0;
      delBtn.textContent = unavailableCount ? `删除 (${deletableCount})` : `删除已选 (${deletableCount})`;
    }
    const stopBtn = $("btn-sg-stop");
    if (stopBtn) {
      stopBtn.classList.toggle("hidden", !deleting);
    }
    const badge = $("saved-groups-badge");
    if (badge) {
      badge.textContent = allItems.length ? String(allItems.length) : "";
    }
  }

  function renderList() {
    const root = $("sg-list");
    if (!root) return;
    const visible = filteredItems();
    updateBatchControls(visible);
    root.replaceChildren();

    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "hist-empty sg-empty";
      empty.textContent = loadError ? "当前可读取的列表中没有匹配的标签组。" : allItems.length ? "没有符合筛选条件的标签组。" : "暂无已保存的标签组或插件库记录。";
      root.appendChild(empty);
      return;
    }

    for (const item of visible) {
      const row = document.createElement("div");
      row.className = "sg-item";
      row.dataset.sgKey = item.key;

      const locked = item.source === "chrome_native" && !item.isOpen;
      const unknown = locked && item.openState === "unknown";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "sg-check";
      cb.checked = selectedKeys.has(item.key);
      cb.disabled = busy;
      cb.setAttribute("aria-label", `选择 ${item.title || "未命名标签组"}`);
      cb.addEventListener("change", () => {
        if (cb.checked) selectedKeys.add(item.key);
        else selectedKeys.delete(item.key);
        updateBatchControls(filteredItems());
      });

      const dot = document.createElement("span");
      dot.className = "sg-dot";
      dot.style.background = COLOR_HEX[item.color] || COLOR_HEX.grey;
      dot.setAttribute("aria-hidden", "true");

      const info = document.createElement("div");
      info.className = "sg-info";

      const titleLine = document.createElement("div");
      titleLine.className = "sg-title";
      titleLine.textContent = item.title || "未命名标签组";
      titleLine.title = (item.tabs || []).slice(0, 5).map((t) => `${t.title || t.url}\n${t.url}`).join("\n");

      const meta = document.createElement("div");
      meta.className = "sg-meta";
      const tag = item.source === "pagelens"
        ? "插件库"
        : item.isOpen
          ? "已打开"
          : item.openState === "unknown"
            ? "状态未知"
            : "未打开";
      meta.textContent = `${tag} · ${item.tabCount || 0} 个标签`;
      info.append(titleLine, meta);

      const ops = document.createElement("div");
      ops.className = "sg-ops";

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "mini";
      openBtn.disabled = busy || locked;
      openBtn.textContent = item.isOpen ? "定位" : unknown ? "状态未知" : locked ? "未打开" : "打开";
      openBtn.title = item.isOpen
        ? "展开并切换到该标签组"
        : unknown
          ? "无法确认该组是否已打开，请刷新后再试。"
          : locked
            ? "请先在 Chrome 中打开该组"
            : "重新打开该标签组";
      openBtn.addEventListener("click", () => { void openItem(item); });

      const renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.className = "mini";
      renameBtn.disabled = busy || locked;
      renameBtn.textContent = "改名";
      renameBtn.title = locked ? openBtn.title : "重命名标签组";
      renameBtn.addEventListener("click", () => { void renameItem(item); });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "mini sg-del-btn";
      delBtn.disabled = busy || !canDelete(item);
      delBtn.textContent = "删";
      delBtn.title = !canDelete(item) ? nativeBlockedMessage(item) : "永久删除该标签组";
      delBtn.addEventListener("click", () => { void deleteItems([item]); });

      ops.append(openBtn, renameBtn, delBtn);
      row.append(cb, dot, info, ops);
      root.appendChild(row);
    }
  }

  async function refresh({ silent = false } = {}) {
    const seq = ++loadSeq;
    if (!silent) $("sg-selected-count").textContent = "正在读取已保存标签组…";
    $("sg-list").setAttribute("aria-busy", "true");
    const chromeApi = getApi();
    const [nativeRes, plRes, openSnap, windowId] = await Promise.all([
      callNative({ action: "list" }).catch((err) => ({ ok: false, error: err?.message || String(err) })),
      listSavedTabGroups({ storage: getStorage() }).then((groups) => ({ groups }), (err) => ({ error: err?.message || String(err) })),
      fetchOpenSnapshot(chromeApi).catch((err) => ({ error: err?.message || String(err) })),
      Promise.resolve().then(resolveWin).catch(() => null),
    ]);
    if (seq !== loadSeq) return;

    loadedProfile = nativeRes?.profile || "";
    panelWindowId = windowId;
    const items = [];
    if (nativeRes?.ok) {
      for (const g of nativeRes.groups || []) {
        const matched = openSnap.error
          ? null
          : matchOpenGroupForNative(g, openSnap.openGroups, openSnap.byGroup, nativeRes.groups);
        const openState = matched ? "open" : (openSnap.error ? "unknown" : "closed");
        items.push({
          key: `native:${g.guid}`,
          source: "chrome_native",
          guid: g.guid,
          profile: nativeRes.profile,
          title: g.title || "",
          color: g.color || "grey",
          tabCount: g.tabCount ?? (g.tabs || []).length,
          tabs: g.tabs || [],
          isOpen: Boolean(matched),
          openState,
          ...(matched ? { openGroupId: matched.id, openWindowId: matched.windowId } : {}),
          updatedAt: g.updatedAt || g.createdAt || 0,
        });
      }
    }
    for (const g of plRes.groups || []) {
      items.push({
        key: `pl:${g.id}`,
        source: "pagelens",
        id: g.id,
        title: g.title || "",
        color: g.color || "blue",
        tabCount: g.tabCount ?? (g.tabs || []).length,
        tabs: g.tabs || [],
        isOpen: false,
        updatedAt: g.updatedAt || g.createdAt || 0,
      });
    }

    allItems = items;
    keepVisibleSelection();
    loadError = [
      nativeRes?.ok ? "" : `Chrome 原生组读取失败：${nativeRes?.error || "Native Host 不可用"}`,
      plRes.error ? `插件库读取失败：${plRes.error}` : "",
      openSnap.error ? `标签组打开状态读取失败：${openSnap.error}` : "",
    ].filter(Boolean).join("。");
    $("sg-load-error").textContent = loadError;
    renderList();
    $("sg-list").setAttribute("aria-busy", "false");
    return true;
  }

  function otherWindowNote(items) {
    const windows = new Set(items.filter((item) => item.source === "chrome_native" && item.isOpen &&
      Number.isInteger(item.openWindowId) && item.openWindowId !== panelWindowId).map((item) => item.openWindowId));
    return windows.size ? `目标组位于${panelWindowId == null ? "Chrome 窗口" : "其他 Chrome 窗口"}（${[...windows].join("、")}）。` : "";
  }

  async function openItem(item) {
    const blocked = nativeBlockedMessage(item);
    if (busy || blocked) {
      if (blocked) setStatus(blocked, false);
      return;
    }
    busy = true;
    renderList();
    try {
      const result = await actOnItem("open_saved_tab_group", item, { collapsed: false });
      if (result.group?.id != null) {
        const api = getApi();
        const tabs = await api.tabs.query({ groupId: result.group.id });
        if (tabs[0]?.id != null) await api.tabs.update(tabs[0].id, { active: true });
        if (result.group.windowId != null) await api.windows.update(result.group.windowId, { focused: true });
      }
      setStatus(`已打开「${item.title || "未命名标签组"}」`, true);
    } catch (err) {
      setStatus(`打开失败：${err?.message || err}`, false);
    } finally {
      busy = false;
      await refresh({ silent: true });
    }
  }

  async function renameItem(item) {
    const blocked = nativeBlockedMessage(item);
    if (busy || blocked) {
      if (blocked) setStatus(blocked, false);
      return;
    }
    const raw = await askInPanel(`${otherWindowNote([item])}输入新的标签组名称`, item.title || "");
    if (raw == null || busy) return;
    const nextTitle = normalizeGroupTitle(raw);
    if (!nextTitle) {
      setStatus("标题不能为空。", false);
      return;
    }
    busy = true;
    renderList();
    try {
      const result = await actOnItem("update_saved_tab_group", item, { title: nextTitle });
      setStatus(`已${result.openedForUpdate ? "打开并" : ""}重命名为「${nextTitle}」`, true);
    } catch (err) {
      setStatus(`改名失败：${err?.message || err}`, false);
    } finally {
      busy = false;
      await refresh({ silent: true });
    }
  }

  async function deleteItems(targets) {
    if (busy || !targets.length) return;
    const actionable = targets.filter(canDelete);
    if (!actionable.length) {
      setStatus(nativeBlockedMessage(targets[0]), false);
      return;
    }
    const unavailableCount = targets.length - actionable.length;
    targets = actionable;
    const description = targets.length === 1
      ? `「${targets[0].title || "未命名标签组"}」`
      : `选中的 ${targets.length} 个标签组`;
    const warning = targets.some((item) => item.source === "chrome_native")
      ? "目标组内的 Chrome 标签页也会关闭。"
      : "";
    const skipped = unavailableCount ? `另外 ${unavailableCount} 个所选组会保留。` : "";
    const confirmed = await askInPanel(`永久删除${description}？${otherWindowNote(targets)}${warning}${skipped}此操作不可恢复。`);
    if (!confirmed || busy) return;

    busy = true;
    deleting = targets.length > 1;
    stopRequested = false;
    renderList();
    let deleted = 0;
    let failed = 0;
    let lastError = "";
    let closeError = "";
    for (const [index, item] of targets.entries()) {
      if (stopRequested) break;
      setStatus(`正在删除 ${index + 1}/${targets.length}：${item.title || "未命名标签组"}…`);
      try {
        const result = await actOnItem("delete_saved_tab_group", item, {});
        deleted += 1;
        if (result.closeError) closeError = `部分标签页未关闭：${result.closeError}`;
        selectedKeys.delete(item.key);
      } catch (err) {
        failed += 1;
        lastError = err?.message || String(err);
      }
    }

    const pending = targets.length - deleted - failed;
    busy = false;
    deleting = false;
    await refresh({ silent: true });
    if (failed || pending || closeError) {
      const parts = [`已删除 ${deleted} 个`];
      if (failed) parts.push(`失败 ${failed} 个`);
      if (pending) parts.push(`未处理 ${pending} 个`);
      setStatus([parts.join("，"), lastError, closeError].filter(Boolean).join("。"), false);
    } else {
      setStatus(`已永久删除 ${deleted} 个标签组`, true);
    }
  }

  async function stashOpenGroups() {
    if (busy) return;
    const chromeApi = getApi();
    busy = true;
    renderList();
    try {
      const winId = await resolveWin();
      const openGroups = (await chromeApi.tabGroups?.query?.(winId != null ? { windowId: winId } : {})) || [];
      if (!openGroups.length) {
        setStatus("当前窗口没有已打开的标签组可收纳。", false);
        return;
      }
      let savedCount = 0;
      for (const g of openGroups) {
        const tabs = ((await chromeApi.tabs?.query?.({ groupId: g.id })) || [])
          .map((t) => ({ url: t.url || t.pendingUrl || "", title: String(t.title || "").slice(0, 160) }))
          .filter((t) => isHttpUrl(t.url));
        if (!tabs.length) continue;
        await saveTabGroupRecord(
          { title: g.title || "未命名标签组", color: g.color || "blue", tabs },
          { storage: getStorage() },
        );
        savedCount += 1;
      }
      setStatus(savedCount ? `已将当前窗口 ${savedCount} 个打开的标签组快照到插件库` : "打开的标签组中没有可保存的 http(s) 网页。", savedCount > 0);
    } catch (err) {
      setStatus(`收纳失败：${err?.message || err}`, false);
    } finally {
      busy = false;
      await refresh({ silent: true });
    }
  }

  panel.addEventListener("toggle", () => {
    if (panel.open) void refresh();
  });

  $("sg-search")?.addEventListener("input", () => {
    searchQuery = $("sg-search").value;
    keepVisibleSelection();
    renderList();
  });

  $("btn-sg-refresh")?.addEventListener("click", () => {
    void refresh();
  });

  document.querySelectorAll("button[data-sg-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      filterMode = btn.dataset.sgFilter || "all";
      keepVisibleSelection();
      document.querySelectorAll("button[data-sg-filter]").forEach((b) => {
        const active = b.dataset.sgFilter === filterMode;
        b.classList.toggle("is-active", active);
        b.setAttribute("aria-pressed", String(active));
      });
      renderList();
    });
  });

  $("sg-select-all")?.addEventListener("change", () => {
    const checked = Boolean($("sg-select-all")?.checked);
    for (const item of filteredItems()) {
      if (checked) selectedKeys.add(item.key);
      else selectedKeys.delete(item.key);
    }
    renderList();
  });

  $("btn-sg-batch-delete")?.addEventListener("click", () => {
    const targets = filteredItems().filter((item) => selectedKeys.has(item.key));
    void deleteItems(targets);
  });

  $("btn-sg-stop")?.addEventListener("click", () => {
    stopRequested = true;
    setStatus("正在停止批量删除…");
  });

  $("btn-sg-stash-open")?.addEventListener("click", () => {
    void stashOpenGroups();
  });

  return { refresh, deleteItems, openItem, renameItem };
}

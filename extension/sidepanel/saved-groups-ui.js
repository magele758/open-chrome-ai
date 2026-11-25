import { $ } from "./dom.js";
import { resolveWindowId } from "./session.js";
import { isHttpUrl } from "../lib/chrome.js";
import { nativeSavedTabGroups } from "../lib/native-host.js";
import {
  SAVED_GROUPS_USE_HELPER_KEY,
  isSavedGroupsHelperEnabled,
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
const HELPER_ERRORS = new Set([
  "ACCESSIBILITY_REQUIRED", "UNSUPPORTED_PLATFORM", "HELPER_LAUNCH_FAILED", "HELPER_TIMEOUT", "HELPER_BUSY",
  "HELPER_GATEKEEPER_BLOCKED",
]);
const MANUAL_RETRY_ERRORS = new Set([
  ...HELPER_ERRORS, "NOT_FOUND_IN_UI", "OPEN_UNVERIFIED", "OPENED_IN_OTHER_WINDOW", "OPEN_IN_CHROME_REQUIRED",
  "OPEN_GROUP_CHANGED", "CANDIDATE_MISMATCH", "WINDOW_SCOPE", "ALREADY_OPEN", "AMBIGUOUS_TARGET",
]);

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
  const useHelper = $("sg-use-helper");
  let manualTask = null;
  let helperPreferenceChanged = false;
  let preferenceWrite = Promise.resolve();

  function saveHelperPreference() {
    helperPreferenceChanged = true;
    const enabled = useHelper.checked;
    preferenceWrite = preferenceWrite.then(() => getStorage()?.set({ [SAVED_GROUPS_USE_HELPER_KEY]: enabled })).catch(() => {});
  }

  function disableHelper() {
    if (!useHelper.checked) return;
    useHelper.checked = false;
    saveHelperPreference();
  }

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

  async function actOnItem(name, item, args, allowNativeOpen) {
    const windowId = await resolveWin();
    const ctx = { getWindowId: () => windowId, allowNativeOpen, detectOpenedInOtherWindow: true };
    if (item.source === "chrome_native" && item.isOpen) {
      ctx.expectedOpenGroup = { profile: item.profile, guid: item.guid, id: item.openGroupId, windowId: item.openWindowId };
    }
    let result;
    if (name === "delete_saved_tab_group" && item.source === "chrome_native") {
      result = await deleteSingleNativeSavedGroup({
        chromeApi: getApi(), callNative, ctx, target: item, profile: item.profile, closedOnly: args.closedOnly,
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
      if (HELPER_ERRORS.has(result?.code)) {
        setAxState(result);
        const reason = result.error && !axState.hint.includes(result.error)
          ? `${result.error} ${axState.hint}`
          : axState.hint;
        throw Object.assign(new Error(reason), { code: result.code });
      }
      const hint = result.code === "WINDOW_SCOPE" ? "请回到此侧栏核对目标组及其所在窗口。" : result.hint;
      const message = [result.error || "操作失败。", hint].filter(Boolean).join(" ");
      throw Object.assign(new Error(message), { code: result.code });
    }
    return result;
  }

  let allItems = [];
  let filterMode = "all"; // all | closed | open | pagelens
  let searchQuery = "";
  let selectedKeys = new Set();
  let axState = null;
  let pendingAxCheck = null;
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

  function hasClosedNative() {
    return allItems.some((item) => item.source === "chrome_native" && item.isOpen === false);
  }

  function setAxState(result) {
    const permission = result?.code === "ACCESSIBILITY_REQUIRED" || (result?.ok && result.trusted === false);
    const unsupported = result?.code === "UNSUPPORTED_PLATFORM";
    const prepareHelper = result?.helperUnavailable === true;
    let hint;
    if (result?.code === "HELPER_GATEKEEPER_BLOCKED") {
      hint = result.error || "macOS 阻止了 PageLens Helper。请从 Chrome 菜单打开目标组后继续。";
    } else if (permission) {
      hint = "请在 macOS「辅助功能」中允许「PageLens Helper」。若开关已开启仍提示未授权，点「定位 Helper」，将旧授权项替换为当前应用，再点「重新检测」。";
    } else if (unsupported) {
      hint = result.error;
    } else if (!result?.ok) {
      const reason = result?.error || "未能检测辅助功能权限。";
      const recovery = result?.code === "HELPER_LAUNCH_FAILED"
        ? "请稍后点「重新检测」。若仍提示找不到应用，点「定位 Helper」核对当前应用，并检查高级配置中的本机助手安装。"
        : "请检查高级配置中的本机助手连接，修复后点「重新检测」。";
      hint = [reason, result?.hint || recovery].join(" ");
    }
    axState = { trusted: result?.ok && result?.trusted === true, permission, unsupported, prepareHelper, hint };
    if (!axState.trusted) disableHelper();
    updateAxBanner();
  }

  function updateAxBanner(explicit = false) {
    const show = explicit || manualTask || hasClosedNative() || useHelper.checked || (axState && !axState.trusted);
    $("sg-ax-banner").classList.toggle("hidden", !show);
    // A busy render sets this. Hiding the banner must still clear it, or the next click is a no-op.
    useHelper.disabled = busy;
    if (!show) return;
    const helperError = axState && !axState.trusted;
    $("sg-ax-banner").classList.toggle("sg-helper-error", Boolean(helperError));
    $("sg-ax-text").textContent = axState?.hint || "";
    $("sg-ax-text").classList.toggle("hidden", !helperError);
    $("sg-ax-prepare").classList.toggle("hidden", !axState?.prepareHelper);
    $("btn-sg-ax-open").classList.toggle("hidden", !axState?.permission);
    $("btn-sg-ax-reveal").classList.toggle("hidden", !helperError || axState.unsupported);
    $("btn-sg-ax-recheck").classList.toggle("hidden", !helperError);
    $("btn-sg-manual-refresh").textContent = manualTask ? "我已打开，核对并继续" : "刷新已打开的组";
    $("btn-sg-manual-refresh").disabled = busy;
    $("btn-sg-manual-cancel").classList.toggle("hidden", !manualTask);
    $("sg-manual-target").classList.toggle("hidden", !manualTask);
  }

  function checkAxStatus() {
    if (pendingAxCheck) return pendingAxCheck;
    const previous = axState;
    pendingAxCheck = callNative({ action: "ax_status" })
      .catch((err) => ({ ok: false, error: err?.message || String(err) }))
      .then((result) => {
        // A foreground action or diagnosis may have supplied newer evidence.
        if (axState === previous) setAxState(result);
      })
      .finally(() => { pendingAxCheck = null; });
    return pendingAxCheck;
  }

  function filteredItems() {
    const q = String(searchQuery || "").trim().toLowerCase();
    return allItems.filter((item) => {
      if (filterMode === "closed" && !(item.source === "chrome_native" && item.isOpen === false)) return false;
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
    const selectedVisible = visibleItems.filter((i) => selectedKeys.has(i.key));
    const totalSelected = selectedKeys.size;

    const selectAll = $("sg-select-all");
    if (selectAll) {
      selectAll.disabled = busy || visibleItems.length === 0;
      selectAll.checked = visibleItems.length > 0 && selectedVisible.length === visibleItems.length;
      selectAll.indeterminate = selectedVisible.length > 0 && selectedVisible.length < visibleItems.length;
    }
    const countEl = $("sg-selected-count");
    if (countEl) {
      countEl.title = loadedProfile ? `Chrome 配置：${loadedProfile}` : "";
      countEl.textContent = visibleItems.length
        ? `显示 ${visibleItems.length} / 共 ${allItems.length} · 已选 ${totalSelected}`
        : `共 ${allItems.length} 个`;
    }
    const delBtn = $("btn-sg-batch-delete");
    if (delBtn) {
      delBtn.classList.toggle("hidden", totalSelected === 0);
      delBtn.disabled = busy;
      delBtn.textContent = `删除已选 (${totalSelected})`;
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
    updateAxBanner();
    root.replaceChildren();

    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "hist-empty sg-empty";
      empty.textContent = loadError ? "当前可读取的列表中没有匹配的标签组。" : allItems.length ? "没有符合筛选条件的标签组。" : "暂无已保存的标签组。";
      root.appendChild(empty);
      return;
    }

    for (const item of visible) {
      const row = document.createElement("div");
      row.className = "sg-item";
      row.dataset.sgKey = item.key;

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
      const tag = item.source === "pagelens" ? "插件库" : item.isOpen == null ? "Chrome · 打开状态未知" : item.isOpen ? "已打开" : "Chrome 已保存";
      meta.textContent = `${tag} · ${item.tabCount || 0} 个标签`;
      info.append(titleLine, meta);

      const ops = document.createElement("div");
      ops.className = "sg-ops";

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "mini";
      openBtn.disabled = busy;
      openBtn.textContent = item.isOpen ? "定位" : "打开";
      openBtn.title = item.isOpen ? "展开并切换到该标签组" : "重新打开该标签组";
      openBtn.addEventListener("click", () => { void openItem(item); });

      const renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.className = "mini";
      renameBtn.disabled = busy;
      renameBtn.textContent = "改名";
      renameBtn.title = "重命名标签组";
      renameBtn.addEventListener("click", () => { void renameItem(item); });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "mini sg-del-btn";
      delBtn.disabled = busy;
      delBtn.textContent = "删";
      delBtn.title = "永久删除该标签组";
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
        const matched = !openSnap.error && matchOpenGroupForNative(g, openSnap.openGroups, openSnap.byGroup, nativeRes.groups);
        items.push({
          key: `native:${g.guid}`,
          source: "chrome_native",
          guid: g.guid,
          profile: nativeRes.profile,
          title: g.title || "",
          color: g.color || "grey",
          tabCount: g.tabCount ?? (g.tabs || []).length,
          tabs: g.tabs || [],
          isOpen: openSnap.error ? null : Boolean(matched),
          openGroupId: matched?.id,
          openWindowId: matched?.windowId,
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
    const liveKeys = new Set(items.map((i) => i.key));
    selectedKeys = new Set([...selectedKeys].filter((k) => liveKeys.has(k)));
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

  function showManualTask(items, action, toOpen) {
    manualTask = { items, action };
    const shown = toOpen.length ? toOpen : items;
    const names = shown.slice(0, 5).map((item) => `「${item.title || "未命名标签组"}」`).join("、");
    const suffix = shown.length > 5 ? ` 等 ${shown.length} 个组` : "";
    $("sg-manual-target").textContent = toOpen.length
      ? `请在 Chrome 中打开 ${names}${suffix}，也可以在新窗口打开。回到这里核对后继续${action}。`
      : `${names}${suffix} 已打开。请核对后继续${action}。`;
    updateAxBanner();
    $("btn-sg-manual-refresh").focus();
  }

  function guideClosed(items, action, allowNativeOpen) {
    const closed = items.filter((item) => item.source === "chrome_native" && !item.isOpen);
    manualTask = null;
    if (allowNativeOpen || !closed.length) { updateAxBanner(); return false; }
    setStatus("");
    showManualTask(items, action, closed);
    return true;
  }

  function guideRetry(items, action) {
    const toOpen = items.filter((item) => !allItems.some((fresh) =>
      fresh.key === item.key && fresh.profile === item.profile && fresh.isOpen));
    showManualTask(items, action, toOpen);
  }

  function otherWindowNote(items) {
    const windows = new Set(items.filter((item) => item.source === "chrome_native" && item.isOpen &&
      Number.isInteger(item.openWindowId) && item.openWindowId !== panelWindowId).map((item) => item.openWindowId));
    return windows.size ? `目标组位于${panelWindowId == null ? "Chrome 窗口" : "其他 Chrome 窗口"}（${[...windows].join("、")}）。` : "";
  }

  async function openItem(item, allowNativeOpen = useHelper.checked) {
    if (busy) return;
    if (guideClosed([item], "定位", allowNativeOpen)) return;
    busy = true;
    renderList();
    let retry = false;
    try {
      const result = await actOnItem("open_saved_tab_group", item, { collapsed: false }, allowNativeOpen);
      if (result.group?.id != null) {
        const api = getApi();
        const tabs = await api.tabs.query({ groupId: result.group.id });
        if (tabs[0]?.id != null) await api.tabs.update(tabs[0].id, { active: true });
        if (result.group.windowId != null) await api.windows.update(result.group.windowId, { focused: true });
      }
      setStatus(`已打开「${item.title || "未命名标签组"}」`, true);
    } catch (err) {
      retry = item.source === "chrome_native" && MANUAL_RETRY_ERRORS.has(err?.code);
      setStatus(`打开失败：${err?.message || err}`, false);
    } finally {
      busy = false;
      await refresh({ silent: true });
      if (retry) guideRetry([item], "定位");
    }
  }

  async function renameItem(item, allowNativeOpen = useHelper.checked) {
    if (busy) return;
    if (guideClosed([item], "改名", allowNativeOpen)) return;
    const raw = await askInPanel(`${otherWindowNote([item])}输入新的标签组名称`, item.title || "");
    if (raw == null || busy) return;
    const nextTitle = normalizeGroupTitle(raw);
    if (!nextTitle) {
      setStatus("标题不能为空。", false);
      return;
    }
    busy = true;
    renderList();
    let retry = false;
    try {
      const result = await actOnItem("update_saved_tab_group", item, { title: nextTitle }, allowNativeOpen);
      setStatus(`已${result.openedForUpdate ? "打开并" : ""}重命名为「${nextTitle}」`, true);
    } catch (err) {
      retry = item.source === "chrome_native" && MANUAL_RETRY_ERRORS.has(err?.code);
      setStatus(`改名失败：${err?.message || err}`, false);
    } finally {
      busy = false;
      await refresh({ silent: true });
      if (retry) guideRetry([item], "改名");
    }
  }

  async function deleteItems(targets, allowNativeOpen = useHelper.checked, closedOnly = filterMode === "closed") {
    if (busy || !targets.length) return;
    if (guideClosed(targets, "删除", allowNativeOpen)) return;
    const description = targets.length === 1
      ? `「${targets[0].title || "未命名标签组"}」`
      : `选中的 ${targets.length} 个标签组`;
    const warning = targets.some((item) => item.source === "chrome_native")
      ? "Chrome 中已打开的目标组也会关闭。"
      : "";
    const confirmed = await askInPanel(`永久删除${description}？${otherWindowNote(targets)}${warning}此操作不可恢复。`);
    if (!confirmed || busy) return;

    busy = true;
    deleting = targets.length > 1;
    stopRequested = false;
    renderList();
    let deleted = 0;
    let failed = 0;
    let lastError = "";
    let closeError = "";
    let helperBlocked = false;
    let awaitingConfirmation = 0;
    const retryItems = [];
    for (const [index, item] of targets.entries()) {
      if (stopRequested) break;
      if (helperBlocked && item.source === "chrome_native" && item.isOpen === false) {
        retryItems.push(item);
        continue;
      }
      setStatus(`正在删除 ${index + 1}/${targets.length}：${item.title || "未命名标签组"}…`);
      try {
        const result = await actOnItem("delete_saved_tab_group", item, { closedOnly }, allowNativeOpen);
        deleted += 1;
        if (result.closeError) closeError = `部分标签页未关闭：${result.closeError}`;
        selectedKeys.delete(item.key);
      } catch (err) {
        if (err?.code === "OPENED_IN_OTHER_WINDOW") awaitingConfirmation += 1;
        else failed += 1;
        lastError = err?.message || String(err);
        if (item.source === "chrome_native" && MANUAL_RETRY_ERRORS.has(err?.code)) retryItems.push(item);
        if (HELPER_ERRORS.has(err?.code)) {
          helperBlocked = true;
        }
      }
    }

    const pending = targets.length - deleted - failed - awaitingConfirmation;
    busy = false;
    deleting = false;
    await refresh({ silent: true });
    if (retryItems.length) guideRetry(retryItems, "删除");
    if (failed || pending || awaitingConfirmation || closeError) {
      const parts = [`已删除 ${deleted} 个`];
      if (failed) parts.push(`失败 ${failed} 个`);
      if (pending) parts.push(`未处理 ${pending} 个`);
      if (awaitingConfirmation) parts.push(`待核对 ${awaitingConfirmation} 个`);
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

  useHelper.addEventListener("change", () => {
    manualTask = null;
    saveHelperPreference();
    updateAxBanner();
  });
  void isSavedGroupsHelperEnabled(getStorage()).then((enabled) => {
    if (!helperPreferenceChanged) useHelper.checked = enabled;
    updateAxBanner();
  });
  getApi()?.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local" || !(SAVED_GROUPS_USE_HELPER_KEY in changes)) return;
    helperPreferenceChanged = true;
    useHelper.checked = changes[SAVED_GROUPS_USE_HELPER_KEY].newValue === true;
    updateAxBanner();
  });

  $("btn-sg-manual-cancel").addEventListener("click", () => {
    manualTask = null;
    updateAxBanner();
    setStatus("");
  });

  $("btn-sg-manual-refresh").addEventListener("click", async () => {
    if (busy) return;
    const task = manualTask;
    if (!task) {
      $("sg-search").value = "";
      searchQuery = "";
      document.querySelector('button[data-sg-filter="open"]').click();
      await refresh();
      return;
    }
    busy = true;
    renderList();
    const targets = [];
    try {
      const loaded = await refresh({ silent: true });
      if (!loaded || manualTask !== task) return;
      for (const prev of task.items) {
        const fresh = allItems.find((item) => item.key === prev.key && item.profile === prev.profile);
        if (!fresh) {
          setStatus(loadError || "所选标签组已不在列表中，请重新选择。", false);
          if (!loadError) manualTask = null;
          return;
        }
        if (fresh.source === "chrome_native" && !fresh.isOpen) {
          setStatus(`尚未核对到「${fresh.title || "未命名标签组"}」的已打开标签。请在 Chrome 中打开所选原组后再试。`, false);
          return;
        }
        if (fresh.title !== prev.title) {
          manualTask = null;
          setStatus("所选标签组已改名，请核对最新名称后重新选择。", false);
          return;
        }
        // Keep the originally selected snapshot for the final delete recheck.
        targets.push({ ...prev, isOpen: fresh.isOpen, openGroupId: fresh.openGroupId, openWindowId: fresh.openWindowId });
      }
      manualTask = null;
    } catch (err) {
      setStatus(`核对失败：${err?.message || err}`, false);
      return;
    } finally {
      busy = false;
      renderList();
    }
    if (task.action === "删除") await deleteItems(targets, false, false);
    else if (task.action === "改名") await renameItem(targets[0], false);
    else await openItem(targets[0], false);
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
    const targets = allItems.filter((item) => selectedKeys.has(item.key));
    void deleteItems(targets);
  });

  $("btn-sg-stop")?.addEventListener("click", () => {
    stopRequested = true;
    setStatus("正在停止批量删除…");
  });

  $("btn-sg-stash-open")?.addEventListener("click", () => {
    void stashOpenGroups();
  });

  $("btn-sg-ax-open")?.addEventListener("click", async () => {
    setStatus("正在准备 PageLens Helper 并打开 macOS 辅助功能设置…");
    const res = await callNative({ action: "request_accessibility" }).catch((err) => ({ ok: false, error: err?.message || String(err) }));
    setAxState(res);
    if (axState.trusted) {
      setStatus("PageLens Helper 已获得 macOS 辅助功能权限。", true);
    } else if (res?.openedSettings) {
      setStatus("已打开系统设置 → 辅助功能。授权后请点「重新检测」。", true);
    } else {
      setStatus(axState.hint, false);
    }
  });

  $("btn-sg-ax-reveal")?.addEventListener("click", async () => {
    setStatus("正在访达中定位 PageLens Helper.app…");
    const res = await callNative({ action: "reveal_helper" }).catch((err) => ({ ok: false, error: err?.message || String(err) }));
    if (res?.ok) {
      setStatus(`已在访达定位 ${res.helperAppPath || "~/.pagelens/PageLens Helper.app"}，可直接拖入「系统设置 → 辅助功能」列表后点「重新检测」。`, true);
    } else {
      setStatus(`定位失败：${res?.error || "未知错误"}`, false);
    }
  });

  $("btn-sg-ax-recheck")?.addEventListener("click", async () => {
    setStatus("正在重新检测 PageLens Helper…");
    await checkAxStatus();
    setStatus(axState.trusted ? "检测通过：PageLens Helper 已获得 macOS 辅助功能权限。" : axState.hint, axState.trusted);
  });

  $("btn-sg-ax-diagnose")?.addEventListener("click", async () => {
    setStatus("正在诊断 Chrome 标签页分组菜单…");
    const diag = await callNative({ action: "diagnose" }).catch((err) => ({ ok: false, error: err?.message || String(err) }));
    setAxState(diag);
    if (!diag?.ok || !axState.trusted) {
      updateAxBanner(true);
      setStatus(`诊断结果：${axState.hint}`, false);
      return;
    }
    if (diag.error) {
      setStatus(`诊断结果：${diag.error}`, false);
      return;
    }
    const tgCount = (diag.tabGroupsButtons || []).length;
    const appCount = (diag.appMenuButtons || []).length;
    const sample = tgCount === 0 && appCount === 0 && Array.isArray(diag.sampleChromeButtons) && diag.sampleChromeButtons.length
      ? `（可见按钮样本：${diag.sampleChromeButtons.slice(0, 8).join(" / ")}）`
      : "";
    const found = tgCount > 0 || appCount > 0;
    const status = found ? "已找到菜单入口" : "未找到标签组菜单入口";
    setStatus(`${status}：窗口「${diag.standardWindowTitle || "Chrome"}」· 标签页分组按钮 ${tgCount} 个 · 应用菜单按钮 ${appCount} 个${sample}`, found);
  });

  return { refresh, deleteItems, openItem, renameItem };
}

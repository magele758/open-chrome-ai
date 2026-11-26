/**
 * 已保存标签组（Saved Tab Groups）增删改查工具：
 *  - Chrome 原生已保存标签组（source: "chrome_native"）：
 *      查：通过 Native Host 只读解析 Chrome profile 的 Sync Data/LevelDB（零写盘、不加锁），返回全部已保存组；未打开的组 isOpen 为 false；
 *      增：通过 Chrome 原生 tabs.group + tabGroups.update 创建（Chrome 自动保存）；
 *      改 / 删：通过 chrome.tabGroups / chrome.tabs 操作已打开的组。
 *      未打开的组只列出，不打开、不改名、不删除。
 *  - PageLens 插件内保存组库（source: "pagelens"，chrome.storage.local）：
 *      零系统权限、跨会话持久化的完整增删改查 + 一键收纳（保存并关闭）/ 一键恢复为 Chrome 标签组。
 */

import { isHttpUrl, toToolText } from "../chrome.js";
import { nativeSavedTabGroups } from "../native-host.js";
import { requireHostUrl } from "../optional-permissions.js";
import {
  deleteSavedTabGroupRecord,
  getSavedTabGroup,
  listSavedTabGroups,
  saveTabGroupRecord,
  updateSavedTabGroupRecord,
} from "../saved-tab-groups.js";
import { groupInWindow } from "../window-scope.js";
import {
  TAB_GROUP_COLORS,
  acquireTabGroupsApi,
  compactTabGroup,
  normalizeGroupTitle,
  parseGroupColor,
  parseGroupId,
  ungroupAndRemoveTabs,
  removeUngroupedTabs,
  verifyGroupMembers,
} from "./tab-group-tools.js";

function obj(properties, required = []) {
  return { type: "object", properties, additionalProperties: false, required };
}

function isWindowScopeError(err) {
  return err?.code === "WINDOW_SCOPE" || /任务所属窗口/.test(String(err?.message || ""));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TAB_ITEM_SCHEMA = {
  oneOf: [
    { type: "string" },
    {
      type: "object",
      properties: {
        url: { type: "string" },
        title: { type: "string" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  ],
};

// Chrome's extension API exposes a session ID, not the saved GUID. Never act on a
// title, a partial overlap, or the first newly created group. Match both sides
// uniquely using the complete URL multiset (including repeated URLs).
function groupSignature(group, tabs) {
  const urls = tabs.map((t) => t.pendingUrl || t.url);
  if (!urls.length || urls.some((url) => !url)) return null;
  return JSON.stringify([group.title || "", group.color, urls.sort()]);
}

function sameMembers(ids, tabs) {
  if (!ids?.length || ids.length !== tabs.length) return false;
  const members = new Set(ids);
  return tabs.every((t) => members.has(t.id));
}

function conflictsWithSession(record, group, tabs) {
  return (record.sessionWindowId != null && record.sessionWindowId !== group.windowId) ||
    (record.sessionTabIds != null && !sameMembers(record.sessionTabIds, tabs));
}

export function matchOpenGroupForNative(target, openGroups, byGroup, nativeGroups = [target]) {
  const signature = groupSignature(target, target.tabs || []);
  if (!signature) return null;
  const matches = openGroups.filter((g) => groupSignature(g, byGroup.get(g.id) || []) === signature);
  const bound = (record, group) => record.sessionWindowId === group.windowId && sameMembers(record.sessionTabIds, byGroup.get(group.id) || []);
  const confirmed = matches.filter((g) => bound(target, g));
  if (confirmed.length === 1 && !nativeGroups.some((g) => g.guid !== target.guid && bound(g, confirmed[0]))) return confirmed[0];
  if (matches.length !== 1 || nativeGroups.some((g) => g.guid !== target.guid && (bound(g, matches[0]) || groupSignature(g, g.tabs || []) === signature))) return null;
  return matches[0];
}

async function fetchOpenGroupSnapshot(chromeApi) {
  const openGroups = await chromeApi.tabGroups.query({});
  const openTabs = await chromeApi.tabs.query({});
  const byGroup = new Map();
  for (const tab of openTabs) {
    if (Number.isInteger(tab.groupId) && tab.groupId >= 0) {
      if (!byGroup.has(tab.groupId)) byGroup.set(tab.groupId, []);
      byGroup.get(tab.groupId).push(tab);
    }
  }
  return { openGroups, byGroup };
}

export function findNativeTarget(groups, { guid, title }) {
  const needle = String(title || "").trim().toLowerCase();
  const matches = guid
    ? groups.filter((g) => g.guid === String(guid).trim())
    : groups.filter((g) => needle && g.title.toLowerCase() === needle);
  return matches.length === 1 ? { target: matches[0] } : null;
}

function nativeFailure(code, error, hint) {
  return { ok: false, source: "chrome_native", code, error, ...(hint ? { hint } : {}) };
}

export const CLOSED_NATIVE_MESSAGE = "此操作需要已打开的 Chrome 保存组。请先在 Chrome 中打开该组。";

function retiredSavedGroupRequest(args) {
  if (args?.closedOnly === true || args?.checkAccessibility === true || args?.requestAccessibility === true || args?.diagnoseUi === true) {
    return nativeFailure("OPEN_IN_CHROME_REQUIRED", CLOSED_NATIVE_MESSAGE);
  }
  return null;
}

async function createChromeGroupFromUrls(chromeApi, { urls, title, color, collapsed = false, windowId }) {
  const validUrls = [];
  for (const raw of urls) {
    const u = String(typeof raw === "string" ? raw : raw?.url || "").trim();
    if (!isHttpUrl(u)) continue;
    const hostDenied = await requireHostUrl(u);
    if (hostDenied) throw new Error(hostDenied);
    validUrls.push(u);
  }
  if (!validUrls.length) throw new Error("没有可打开的 http(s) 标签 URL。");

  const tabIds = [];
  let targetWin = windowId;
  for (const url of validUrls) {
    const created = await chromeApi.tabs.create({
      url,
      active: false,
      ...(targetWin != null ? { windowId: targetWin } : {}),
    });
    if (targetWin == null && created?.windowId != null) targetWin = created.windowId;
    if (created?.id != null) tabIds.push(created.id);
  }
  const groupId = await chromeApi.tabs.group({
    tabIds,
    ...(targetWin != null ? { createProperties: { windowId: targetWin } } : {}),
  });
  const props = {};
  if (title !== undefined) props.title = normalizeGroupTitle(title);
  if (color !== undefined) props.color = color;
  if (typeof collapsed === "boolean") props.collapsed = collapsed;
  let group = null;
  if (Object.keys(props).length && typeof chromeApi.tabGroups?.update === "function") {
    group = await chromeApi.tabGroups.update(groupId, props);
  }
  if (!group && typeof chromeApi.tabGroups?.get === "function") {
    group = await chromeApi.tabGroups.get(groupId).catch(() => null);
  }
  return { group: compactTabGroup(group || { id: groupId, windowId: targetWin, ...props }), tabIds };
}

function openedInOtherWindow(target, windowId) {
  return nativeFailure("OPENED_IN_OTHER_WINDOW",
    `Chrome 已在窗口 ${windowId} 打开「${target.title || "未命名标签组"}」。请在侧栏核对后继续。`);
}

export async function openNativeSavedGroup({ chromeApi, callNative, target, nativeList, ctx = {} }) {
  const snapshot = await fetchOpenGroupSnapshot(chromeApi);
  let windowId = ctx.getWindowId?.();
  const already = matchOpenGroupForNative(target, snapshot.openGroups, snapshot.byGroup, nativeList.groups);
  // The panel can bind a user-selected row to one open Chrome group. Resolve
  // its saved GUID again before accepting that destination across windows.
  const expected = ctx.expectedOpenGroup;
  const members = already && snapshot.byGroup.get(already.id);
  // Chrome keeps the pre-close Session_* binding for about 2.5s after restore.
  // Wait only when the selected group, window, and profile already match.
  if (expected && already && nativeList.profile &&
      expected.profile === nativeList.profile &&
      expected.guid === target.guid &&
      expected.id === already.id &&
      expected.windowId === already.windowId &&
      conflictsWithSession(target, already, members)) {
    const deadline = Date.now() + 5000;
    do {
      const listed = await callNative({ action: "list", profile: nativeList.profile }).catch(() => null);
      const record = listed?.ok && listed.profile === nativeList.profile
        ? listed.groups?.find((group) => group.guid === target.guid)
        : null;
      if (record && record.sessionWindowId === already.windowId && sameMembers(record.sessionTabIds, members)) {
        const fields = {
          sessionWindowId: record.sessionWindowId,
          sessionTabIds: record.sessionTabIds,
          sessionUpdatedAt: record.sessionUpdatedAt,
        };
        Object.assign(target, fields);
        const entry = nativeList.groups.find((group) => group.guid === target.guid);
        if (entry && entry !== target) Object.assign(entry, fields);
        break;
      }
      if (Date.now() >= deadline) break;
      await sleep(250);
    } while (Date.now() < deadline);
  }
  if (expected && (!already || !nativeList.profile || expected.profile !== nativeList.profile ||
      expected.guid !== target.guid || expected.id !== already.id || expected.windowId !== already.windowId ||
      conflictsWithSession(target, already, members))) {
    return nativeFailure("OPEN_GROUP_CHANGED", "所选标签组的打开状态或所在窗口已变化。请刷新列表后重新选择；若组已关闭，可从 Chrome 的标签页分组菜单打开它。");
  }
  if (already) {
    if (!expected && ctx.detectOpenedInOtherWindow === true && windowId != null && already.windowId !== windowId &&
        !conflictsWithSession(target, already, snapshot.byGroup.get(already.id))) {
      return openedInOtherWindow(target, already.windowId);
    }
    if (!expected && windowId != null && already.windowId !== windowId) return nativeFailure("WINDOW_SCOPE", "标签组不在任务所属窗口。");
    return { ok: true, group: already, alreadyOpen: true };
  }
  return nativeFailure("OPEN_IN_CHROME_REQUIRED", CLOSED_NATIVE_MESSAGE);
}

async function verifySavedRecord(callNative, guid, profile, matches) {
  for (let attempt = 0; attempt < 10; ++attempt) {
    if (attempt) await sleep(350);
    const listed = await callNative({ action: "list", profile }).catch(() => null);
    if (!listed?.ok || !Array.isArray(listed.groups) || listed.profile !== profile) return { checked: false };
    if (matches(listed.groups.find((g) => g.guid === guid))) return { checked: true, matched: true };
  }
  return { checked: true, matched: false };
}

export async function verifyNativeGroupRemoved(callNative, guid, profile) {
  const verified = await verifySavedRecord(callNative, guid, profile, (record) => !record);
  return { checked: verified.checked, removed: verified.matched };
}

export async function verifyNativeGroupUpdated(callNative, guid, profile, group, tabs) {
  const expected = groupSignature(group, tabs);
  if (!expected) return false;
  const verified = await verifySavedRecord(callNative, guid, profile, (g) => g && groupSignature(g, g.tabs || []) === expected);
  return verified.matched === true;
}

export async function deleteSingleNativeSavedGroup({ chromeApi, callNative, target, profile, ctx = {}, authorizeOpenGroup }) {
  const list = () => callNative({ action: "list", profile }).catch(() => null);
  const nativeList = await list();
  if (!nativeList?.ok || !Array.isArray(nativeList.groups) || !nativeList.profile || (profile && profile !== nativeList.profile)) {
    return nativeFailure("NATIVE_READ_FAILED", nativeList?.error || "无法重新读取目标 Chrome 配置中的保存组。");
  }
  profile = nativeList.profile;
  const current = nativeList.groups.find((g) => g.guid === target.guid);
  if (!current) return nativeFailure("GROUP_NOT_FOUND", "目标保存组已不存在。");
  if (!groupSignature(current, current.tabs || [])) return nativeFailure("INCOMPLETE_TARGET", "无法核对保存组中的标签。");
  // A gateway caller authorizes the selected snapshot before entry. If it changed
  // since then, require a fresh selection and authorization before any UI action.
  if (groupSignature(current, current.tabs) !== groupSignature(target, target.tabs || [])) {
    return nativeFailure("GROUP_CHANGED", "该保存组已发生变化，请刷新列表后重试。");
  }
  const opened = await openNativeSavedGroup({ chromeApi, callNative, target: current, nativeList, ctx });
  if (!opened.ok) return { ...opened, guid: current.guid, title: current.title };
  const fresh = await list();
  if (!fresh?.ok || !Array.isArray(fresh.groups) || fresh.profile !== profile) {
    return nativeFailure("NATIVE_READ_FAILED", fresh?.error || "无法重新核对目标保存组。");
  }
  const liveTarget = fresh.groups.find((g) => g.guid === current.guid);
  const { openGroups, byGroup } = await fetchOpenGroupSnapshot(chromeApi);
  const matched = openGroups.find((g) => g.id === opened.group.id && g.windowId === opened.group.windowId);
  const tabs = matched ? byGroup.get(matched.id) || [] : [];
  const stillMatched = liveTarget && matched &&
    matchOpenGroupForNative(liveTarget, openGroups, byGroup, fresh.groups)?.id === matched.id;
  if (!stillMatched || (ctx.expectedOpenGroup && conflictsWithSession(liveTarget, matched, tabs)) ||
      groupSignature(liveTarget, liveTarget.tabs) !== groupSignature(current, current.tabs)) {
    return nativeFailure("GROUP_CHANGED", "标签组已变化，无法安全删除，请刷新列表后重试。");
  }
  if (authorizeOpenGroup) await authorizeOpenGroup(matched, tabs);
  const ids = tabs.map((t) => t.id);
  // Ungroup is the operation that removes the saved group. If Chrome rejects
  // it, leave all its tabs open instead of falling back to a plain tabs.remove.
  try {
    await verifyGroupMembers(chromeApi.tabs, ids, matched);
    await chromeApi.tabs.ungroup(ids);
  } catch (err) {
    return nativeFailure("UNGROUP_FAILED", `无法取消分组，已保留标签页：${err?.message || err}`);
  }
  let closeError;
  try {
    await removeUngroupedTabs(chromeApi.tabs, ids, matched.windowId);
  } catch (err) {
    closeError = String(err?.message || err);
  }
  if (ctx.getTaskGroupId?.() === matched.id) ctx.setTaskGroupId?.(null);
  await ctx.onTabsMutated?.();
  const verified = await verifyNativeGroupRemoved(callNative, current.guid, profile);
  if (!verified.removed) return nativeFailure(
    verified.checked ? "NOT_REMOVED_AFTER_UI_ACTION" : "DELETE_UNVERIFIED",
    verified.checked ? "已取消标签分组，但 Chrome 仍列出该保存组，请刷新后检查。" : "已取消标签分组，但无法回读目标配置确认删除结果。",
  );
  return {
    ok: true, source: "chrome_native", guid: current.guid, title: current.title, verifiedRemoved: true,
    via: "ungroup_and_close_open_tabs",
    ...(closeError ? { closeError } : { closedTabIds: ids }),
  };
}

export function createSavedTabGroupTools(ctx = {}, { api, storage, nativeCall } = {}) {
  const getApi = () => api || globalThis.chrome;
  const getStorage = () => storage || getApi()?.storage?.local;
  const callNative = (payload) => (nativeCall ? nativeCall(payload) : nativeSavedTabGroups(payload));

  async function resolveLibraryTitle(title, source) {
    const needle = String(title).trim().toLowerCase();
    const rows = (await listSavedTabGroups({ storage: getStorage() })).filter((g) => g.title.toLowerCase() === needle);
    if (rows.length > 1) return { error: "有多个同名 PageLens 保存组，请使用列表中的 id。" };
    if (rows.length === 1 && source === "auto") {
      const native = await callNative({ action: "list", query: title });
      if (!native?.ok || native.groups.some((g) => g.title.toLowerCase() === needle)) {
        return { error: "无法按标题唯一确定保存位置，请指定 source 或列表中的 id / guid。" };
      }
    }
    return { record: rows[0] };
  }

  return [
    {
      name: "list_saved_tab_groups",
      description:
        "查询 Chrome 原生保存组和 PageLens 插件内保存组库。未打开的 Chrome 保存组也会列出，isOpen 为 false。Chrome 原生组经 Native Host 只读解析 Sync Data/LevelDB，再与当前会话中的打开组核对。",
      parameters: obj({
        source: {
          type: "string",
          enum: ["all", "chrome_native", "pagelens"],
          description: "查询来源：all（默认，同时查原生保存组和插件库）、chrome_native（Chrome 原生保存组，含未打开）、pagelens（仅插件内保存库）",
        },
        query: { type: "string", description: "按组标题或组内标签标题/URL 子串过滤" },
        color: { type: "string", enum: TAB_GROUP_COLORS, description: "按颜色过滤" },
        profile: { type: "string", description: "可选：指定 Chrome profile 目录名（如 Default、Profile 1）；省略则自动识别当前扩展所在 profile" },
        includeTabs: { type: "boolean", description: "是否附带组内标签 URL 列表，默认 true；组数很多（>20）时建议传 false 先浏览标题与 guid" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "可选：每个来源最多返回的组数" },
      }),
      async execute(args = {}) {
        const retired = retiredSavedGroupRequest(args);
        if (retired) return toToolText(retired);
        const chromeApi = getApi();
        const source = args?.source || "all";
        const parsedColor = parseGroupColor(args?.color);
        if (parsedColor.error) return parsedColor.error;
        const includeTabs = args?.includeTabs !== false;
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 200) : null;

        const out = {};
        let total = 0;

        if (source === "all" || source === "chrome_native") {
          const nativeRes = await callNative({
            action: "list",
            profile: args?.profile || undefined,
            query: args?.query || undefined,
            color: parsedColor.color || undefined,
          });
          if (!nativeRes?.ok) {
            out.chromeNative = { ok: false, error: nativeRes?.error || "无法读取 Chrome 原生保存标签组。", count: 0, groups: [] };
          } else {
            const snapshot = await fetchOpenGroupSnapshot(chromeApi).catch(() => null);
            const openStateUnknown = !snapshot;
            let rows = (nativeRes.groups || []).flatMap((g) => {
              const matched = snapshot
                ? matchOpenGroupForNative(g, snapshot.openGroups, snapshot.byGroup, nativeRes.groups)
                : null;
              const item = {
                guid: g.guid,
                title: g.title,
                color: g.color,
                tabCount: g.tabCount,
                isOpen: Boolean(matched),
                ...(matched ? { openGroupId: matched.id, openWindowId: matched.windowId } : {}),
                ...(openStateUnknown ? { openState: "unknown" } : {}),
                ...(g.createdAt != null ? { createdAt: g.createdAt } : {}),
                ...(g.updatedAt != null ? { updatedAt: g.updatedAt } : {}),
                source: "chrome_native",
              };
              if (includeTabs) item.tabs = g.tabs || [];
              return [item];
            });
            const listedCount = rows.length;
            if (limit != null && rows.length > limit) rows = rows.slice(0, limit);
            total += listedCount;
            out.chromeNative = {
              ok: true,
              ...(openStateUnknown ? { openState: "unknown", warning: "无法核对当前窗口的打开状态。" } : {}),
              profile: nativeRes.profile,
              profiles: nativeRes.profiles,
              count: rows.length,
              ...(listedCount !== rows.length ? { totalMatched: listedCount, truncated: true } : {}),
              groups: rows,
            };
          }
        }

        if (source === "all" || source === "pagelens") {
          try {
            const list = await listSavedTabGroups({
              query: args?.query,
              color: parsedColor.color,
              storage: getStorage(),
            });
            const allRows = list.map((g) => {
              const item = {
                id: g.id,
                title: g.title,
                color: g.color,
                tabCount: g.tabCount,
                createdAt: g.createdAt,
                updatedAt: g.updatedAt,
                source: "pagelens",
              };
              if (includeTabs) item.tabs = g.tabs;
              return item;
            });
            const rows = limit != null && allRows.length > limit ? allRows.slice(0, limit) : allRows;
            total += allRows.length;
            out.pagelens = {
              count: rows.length,
              ...(allRows.length !== rows.length ? { totalMatched: allRows.length, truncated: true } : {}),
              groups: rows,
            };
          } catch (err) {
            out.pagelens = { ok: false, error: err?.message || String(err), count: 0, groups: [] };
          }
        }

        out.totalCount = total;
        return toToolText(out);
      },
    },
    {
      name: "save_tab_group",
      description:
        "保存/收纳一个标签组（增）：传 groupId 可把当前已打开的 Chrome 标签组快照存进 PageLens 保存库（可选 closeAfterSave=true 保存后关闭释放标签栏）；或直接传 title + tabs 新建保存组（target=chrome_native 时会直接在 Chrome 打开成原生保存组）。",
      parameters: obj({
        groupId: { type: "integer", minimum: 0, description: "要快照保存的已打开 Chrome 标签组 id" },
        id: { type: "string", description: "可选：覆盖更新指定的 PageLens 已保存组 id" },
        title: { type: "string", description: "标签组名称（不传 groupId 时必填；传 groupId 时可覆盖原标题）" },
        color: { type: "string", enum: TAB_GROUP_COLORS, description: "标签组颜色" },
        tabs: { type: "array", items: TAB_ITEM_SCHEMA, description: "不传 groupId 时的标签 URL 列表（字符串或 {url, title}）" },
        closeAfterSave: { type: "boolean", description: "仅传 groupId 时有效：保存进 PageLens 库后关闭原打开组里的标签，默认 false" },
        target: {
          type: "string",
          enum: ["pagelens", "chrome_native"],
          description: "保存位置：pagelens（默认，存入插件库）；chrome_native（直接按 tabs 在 Chrome 新建原生标签组）",
        },
        collapsed: { type: "boolean", description: "仅 target=chrome_native 时有效：新建后是否折叠" },
      }),
      async execute(args = {}) {
        const chromeApi = getApi();
        const parsedColor = parseGroupColor(args?.color);
        if (parsedColor.error) return parsedColor.error;
        const target = args?.target || "pagelens";

        if (args?.groupId !== undefined && args?.groupId !== null) {
          const parsedGroup = parseGroupId(args.groupId);
          if (parsedGroup.error) return parsedGroup.error;
          const { tabs, error } = await acquireTabGroupsApi(chromeApi);
          if (error) return error;
          const windowId = ctx.getWindowId?.();
          try {
            const group = await groupInWindow(parsedGroup.groupId, windowId, chromeApi);
            const q = { ...(windowId != null ? { windowId } : {}), groupId: parsedGroup.groupId };
            const groupTabs = ((await tabs.query(q)) || []).filter((t) => t.groupId === parsedGroup.groupId);
            const httpTabs = groupTabs
              .map((t) => ({ url: t.url || t.pendingUrl || "", title: String(t.title || "").slice(0, 160) }))
              .filter((t) => isHttpUrl(t.url));
            if (!httpTabs.length) return "该标签组里没有可保存的 http(s) 网页。";
            const title = args?.title !== undefined ? normalizeGroupTitle(args.title) : normalizeGroupTitle(group.title || "未命名标签组");
            const color = parsedColor.color || group.color || "blue";
            const { record, replaced } = await saveTabGroupRecord(
              { id: args?.id, title: title || "未命名标签组", color, tabs: httpTabs },
              { storage: getStorage() },
            );
            let closedCount = 0;
            if (args?.closeAfterSave === true) {
              const ids = groupTabs.map((t) => t.id).filter((id) => Number.isInteger(id));
              if (ids.length) {
                await ungroupAndRemoveTabs(tabs, ids, group);
                closedCount = ids.length;
              }
              if (ctx.getTaskGroupId?.() === parsedGroup.groupId) ctx.setTaskGroupId?.(null);
              await ctx.onTabsMutated?.();
            }
            return toToolText({
              ok: true,
              source: "pagelens",
              replaced,
              group: record,
              skippedNonHttp: groupTabs.length - httpTabs.length,
              ...(args?.closeAfterSave === true ? { closedAfterSave: true, closedCount } : {}),
            });
          } catch (err) {
            if (isWindowScopeError(err)) throw err;
            return `保存标签组失败：${err?.message || err}`;
          }
        }

        const title = normalizeGroupTitle(args?.title);
        if (!title) return "需要提供 groupId 或 title。";
        if (!Array.isArray(args?.tabs) || !args.tabs.length) return "不传 groupId 时，必须提供非空的 tabs 列表。";

        if (target === "chrome_native") {
          const { error } = await acquireTabGroupsApi(chromeApi);
          if (error) return error;
          try {
            const opened = await createChromeGroupFromUrls(chromeApi, {
              urls: args.tabs,
              title,
              color: parsedColor.color || "blue",
              collapsed: Boolean(args?.collapsed),
              windowId: ctx.getWindowId?.(),
            });
            await ctx.onTabsMutated?.();
            return toToolText({ ok: true, source: "chrome_native", ...opened });
          } catch (err) {
            if (isWindowScopeError(err)) throw err;
            return `新建原生标签组失败：${err?.message || err}`;
          }
        }

        try {
          const { record, replaced } = await saveTabGroupRecord(
            { id: args?.id, title, color: parsedColor.color || "blue", tabs: args.tabs },
            { storage: getStorage() },
          );
          return toToolText({ ok: true, source: "pagelens", replaced, group: record });
        } catch (err) {
          return `保存标签组失败：${err?.message || err}`;
        }
      },
    },
    {
      name: "open_saved_tab_group",
      description:
        "定位已经打开的 Chrome 原生保存组，或按 PageLens 保存库里的 URL 新建一个 Chrome 标签组。未打开的 Chrome 原生保存组不会被打开或重建，需先在 Chrome 中打开。",
      parameters: obj({
        source: { type: "string", enum: ["auto", "chrome_native", "pagelens"], description: "来源，默认 auto" },
        id: { type: "string", description: "PageLens 保存组 id（stg_...）" },
        guid: { type: "string", description: "Chrome 原生保存组 guid（来自 list_saved_tab_groups）" },
        title: { type: "string", description: "按标题匹配已保存标签组" },
        profile: { type: "string", description: "可选：Chrome profile 名称" },
        mode: {
          type: "string",
          enum: ["native", "recreate"],
          description: "仅 chrome_native 有效。native（默认）只定位已经打开的组。recreate 不再为未打开的原生组按 URL 新建副本。",
        },
        collapsed: { type: "boolean", description: "打开后是否保持折叠，默认 false" },
      }),
      async execute(args = {}) {
        const chromeApi = getApi();
        const { error } = await acquireTabGroupsApi(chromeApi);
        if (error) return error;

        const explicit = args?.source || "auto";
        const resolvedSource =
          explicit !== "auto"
            ? explicit
            : args?.id
              ? "pagelens"
              : args?.guid
                ? "chrome_native"
                : null;

        // 1. Try PageLens saved store first when resolvedSource is pagelens or auto
        if (resolvedSource === "pagelens" || resolvedSource === null) {
          let record = args?.id ? await getSavedTabGroup(args.id, { storage: getStorage() }) : null;
          if (!args.id && args.title) {
            const result = await resolveLibraryTitle(args.title, explicit);
            if (result.error) return result.error;
            record = result.record;
          }
          if (record) {
            try {
              const opened = await createChromeGroupFromUrls(chromeApi, {
                urls: record.tabs,
                title: record.title,
                color: record.color,
                collapsed: Boolean(args?.collapsed),
                windowId: ctx.getWindowId?.(),
              });
              await ctx.onTabsMutated?.();
              return toToolText({ ok: true, source: "pagelens", savedId: record.id, ...opened });
            } catch (err) {
              if (isWindowScopeError(err)) throw err;
              return `打开已保存标签组失败：${err?.message || err}`;
            }
          }
          if (resolvedSource === "pagelens") return `在 PageLens 保存库里找不到目标标签组（id=${args?.id || ""} title=${args?.title || ""}）。`;
        }

        // 2. Chrome native saved tab group
        const nativeList = await callNative({ action: "list", profile: args?.profile || undefined });
        if (!nativeList?.ok) return `无法读取 Chrome 原生保存组：${nativeList?.error || "Native Host 不可用"}`;
        const hit = findNativeTarget(nativeList.groups || [], { guid: args?.guid, title: args?.title });
        if (!hit) return `Chrome 原生保存组无唯一匹配，请使用列表中的 GUID（guid=${args?.guid || ""} title=${args?.title || ""}）。`;

        const mode = args?.mode || "native";
        if (mode === "recreate" && !ctx.expectedOpenGroup) {
          const { openGroups, byGroup } = await fetchOpenGroupSnapshot(chromeApi);
          const already = matchOpenGroupForNative(hit.target, openGroups, byGroup, nativeList.groups);
          if (already) {
            if (ctx.getWindowId?.() != null && ctx.getWindowId() !== already.windowId) return "标签组不在任务所属窗口。";
            if (args?.collapsed !== undefined) await chromeApi.tabGroups.update(already.id, { collapsed: args.collapsed });
            return toToolText({ ok: true, source: "chrome_native", guid: hit.target.guid, alreadyOpen: true, group: compactTabGroup(already) });
          }
          return toToolText(nativeFailure("OPEN_IN_CHROME_REQUIRED", CLOSED_NATIVE_MESSAGE));
        }

        const opened = await openNativeSavedGroup({ chromeApi, callNative, target: hit.target, nativeList, ctx });
        if (!opened.ok) return toToolText(opened);
        let group = opened.group;
        if (typeof args.collapsed === "boolean" && group.collapsed !== args.collapsed) {
          group = await chromeApi.tabGroups.update(group.id, { collapsed: args.collapsed });
        }
        await ctx.onTabsMutated?.();
        return toToolText({ ...opened, ok: true, source: "chrome_native", mode: "native", guid: hit.target.guid, group: compactTabGroup(group) });
      },
    },
    {
      name: "update_saved_tab_group",
      description:
        "更新已保存标签组（改）：修改标题、颜色或增删 URL。PageLens 保存库直接改存储。Chrome 原生保存组只更新已经打开的组；未打开的组需先在 Chrome 中打开。",
      parameters: obj({
        source: { type: "string", enum: ["auto", "chrome_native", "pagelens"], description: "来源，默认 auto" },
        id: { type: "string", description: "PageLens 保存组 id（stg_...）" },
        guid: { type: "string", description: "Chrome 原生保存组 guid" },
        matchTitle: { type: "string", description: "按当前标题定位目标组（当改名且未传 id/guid 时使用）" },
        title: { type: "string", description: "新标题" },
        color: { type: "string", enum: TAB_GROUP_COLORS, description: "新颜色" },
        tabs: { type: "array", items: TAB_ITEM_SCHEMA, description: "仅 pagelens：完整替换组内标签列表" },
        addUrls: { type: "array", items: { type: "string" }, description: "追加到组内的 http(s) URL 列表" },
        removeUrls: { type: "array", items: { type: "string" }, description: "从组内移除的 URL 列表" },
        profile: { type: "string", description: "可选：Chrome profile 名称" },
      }),
      async execute(args = {}) {
        const parsedColor = parseGroupColor(args?.color);
        if (parsedColor.error) return parsedColor.error;
        const hasChange =
          args?.title !== undefined ||
          parsedColor.color !== undefined ||
          args?.tabs !== undefined ||
          (Array.isArray(args?.addUrls) && args.addUrls.length > 0) ||
          (Array.isArray(args?.removeUrls) && args.removeUrls.length > 0);
        if (!hasChange) return "至少需要提供 title、color、tabs、addUrls 或 removeUrls 之一。";

        const explicit = args?.source || "auto";
        const resolvedSource =
          explicit !== "auto"
            ? explicit
            : args?.id
              ? "pagelens"
              : args?.guid
                ? "chrome_native"
                : null;

        if (resolvedSource === "pagelens" || resolvedSource === null) {
          let targetId = args?.id || "";
          if (!targetId && args?.matchTitle) {
            const result = await resolveLibraryTitle(args.matchTitle, explicit);
            if (result.error) return result.error;
            targetId = result.record?.id || "";
          }
          if (targetId) {
            try {
              const updated = await updateSavedTabGroupRecord(
                targetId,
                {
                  title: args?.title,
                  color: parsedColor.color,
                  tabs: args?.tabs,
                  addTabs: args?.addUrls,
                  removeUrls: args?.removeUrls,
                },
                { storage: getStorage() },
              );
              return toToolText({ ok: true, source: "pagelens", group: updated });
            } catch (err) {
              return `更新已保存标签组失败：${err?.message || err}`;
            }
          }
          if (resolvedSource === "pagelens") return "在 PageLens 保存库里找不到要更新的标签组（请传 id 或 matchTitle）。";
        }

        // Chrome native saved tab group update
        const chromeApi = getApi();
        const { error } = await acquireTabGroupsApi(chromeApi);
        if (error) return error;
        const nativeList = await callNative({ action: "list", profile: args?.profile || undefined });
        if (!nativeList?.ok) return `无法读取 Chrome 原生保存组：${nativeList?.error || "Native Host 不可用"}`;
        const hit = findNativeTarget(nativeList.groups || [], { guid: args?.guid, title: args?.matchTitle });
        if (!hit) return `Chrome 原生保存组无唯一匹配，请使用列表中的 GUID（guid=${args?.guid || ""} matchTitle=${args?.matchTitle || ""}）。`;

        if (args.tabs !== undefined) return "Chrome 原生保存组请使用 addUrls 或 removeUrls 修改网页。";
        const addUrls = (args.addUrls || []).map((url) => String(url || "").trim());
        for (const url of addUrls) {
          if (!isHttpUrl(url)) return `只能添加 http(s) URL，收到：${url}`;
          const denied = await requireHostUrl(url);
          if (denied) return denied;
        }
        const drop = new Set((args.removeUrls || []).map((url) => String(url || "").trim()));
        if (drop.size && [...hit.target.tabs.map((t) => t.url), ...addUrls].every((url) => drop.has(url))) {
          return "removeUrls 会移除组内全部标签；如需删除请改用 delete_saved_tab_group。";
        }
        const opened = await openNativeSavedGroup({ chromeApi, callNative, target: hit.target, nativeList, ctx });
        if (!opened.ok) return toToolText(opened);
        const openGroup = opened.group;
        const openedForUpdate = !opened.alreadyOpen;

        const updateProps = {};
        if (args?.title !== undefined) updateProps.title = normalizeGroupTitle(args.title);
        if (parsedColor.color !== undefined) updateProps.color = parsedColor.color;
        let finalGroup = openGroup;
        if (Object.keys(updateProps).length) {
          finalGroup = (await chromeApi.tabGroups.update(openGroup.id, updateProps)) || { ...openGroup, ...updateProps };
        }

        const addedTabIds = [];
        for (const url of addUrls) {
          const created = await chromeApi.tabs.create({ url, active: false, windowId: openGroup.windowId });
          addedTabIds.push(created.id);
        }
        if (addedTabIds.length) await chromeApi.tabs.group({ tabIds: addedTabIds, groupId: openGroup.id });

        const removedTabIds = [];
        if (Array.isArray(args?.removeUrls) && args.removeUrls.length) {
          const currentTabs = ((await chromeApi.tabs.query({ groupId: openGroup.id })) || []).filter((t) => t.groupId === openGroup.id);
          const toRemove = currentTabs.filter((t) => drop.has(t.pendingUrl || t.url)).map((t) => t.id);
          if (toRemove.length >= currentTabs.length) {
            return "removeUrls 会移除组内全部标签并导致 Chrome 删除整个保存组；如需删除请改用 delete_saved_tab_group。";
          }
          if (toRemove.length) {
            await chromeApi.tabs.remove(toRemove);
            removedTabIds.push(...toRemove);
          }
        }

        await ctx.onTabsMutated?.();
        const currentTabs = (await chromeApi.tabs.query({ groupId: openGroup.id })).filter((t) => t.groupId === openGroup.id);
        const verified = await verifyNativeGroupUpdated(callNative, hit.target.guid, nativeList.profile, finalGroup, currentTabs);
        if (!verified) return toToolText(nativeFailure("UPDATE_UNVERIFIED", "已修改打开的标签组，但尚未在 Chrome 保存组中核实更改。请刷新列表查看。"));
        return toToolText({
          ok: true,
          verifiedUpdated: true,
          source: "chrome_native",
          guid: hit.target.guid,
          openedForUpdate,
          group: compactTabGroup(finalGroup),
          ...(addedTabIds.length ? { addedTabIds } : {}),
          ...(removedTabIds.length ? { removedTabIds } : {}),
        });
      },
    },
    {
      name: "delete_saved_tab_group",
      description:
        "永久删除一个或多个已保存标签组（删，不可逆，只在用户明确要求时调用）：支持单个（id / guid / title）或批量（ids / guids / query）。PageLens 保存库直接删除记录。已经打开的 Chrome 原生保存组先取消分组再关闭标签，并按 GUID 回读确认。未打开的原生组不会被删除。",
      parameters: obj({
        source: { type: "string", enum: ["auto", "chrome_native", "pagelens"], description: "来源，默认 auto" },
        id: { type: "string", description: "单个删除：PageLens 保存组 id（stg_...）" },
        ids: { type: "array", items: { type: "string" }, description: "批量删除：PageLens 保存组 id 列表" },
        guid: { type: "string", description: "单个删除：Chrome 原生保存组 guid" },
        guids: { type: "array", items: { type: "string" }, description: "批量删除：Chrome 原生保存组 guid 列表" },
        title: { type: "string", description: "单个删除：要删除的标签组精确标题" },
        query: { type: "string", description: "批量删除：按标题/URL 子串匹配要删除的保存组" },
        color: { type: "string", enum: TAB_GROUP_COLORS, description: "批量删除时可选：按颜色进一步筛选" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "批量删除上限，默认 50" },
        profile: { type: "string", description: "可选：Chrome profile 名称" },
      }),
      async execute(args = {}) {
        const retired = retiredSavedGroupRequest(args);
        if (retired) return toToolText(retired);
        const parsedColor = parseGroupColor(args?.color);
        if (parsedColor.error) return parsedColor.error;

        const batchIds = Array.isArray(args?.ids) ? args.ids.map((x) => String(x || "").trim()).filter(Boolean) : [];
        const batchGuids = Array.isArray(args?.guids) ? args.guids.map((x) => String(x || "").trim()).filter(Boolean) : [];
        const batchQuery = String(args?.query || "").trim();
        const isBatch = batchIds.length > 0 || batchGuids.length > 0 || Boolean(batchQuery);

        const source = args.source || "auto";
        if ((source === "chrome_native" && (args.id || batchIds.length)) ||
            (source === "pagelens" && (args.guid || batchGuids.length))) {
          return toToolText({ ok: false, code: "INVALID_SELECTOR", error: "指定的保存位置与 id / guid 类型不符。" });
        }
        if ((args.id && args.guid) || (isBatch && (args.id || args.guid || args.title)) ||
            (batchQuery && (batchIds.length || batchGuids.length))) {
          return toToolText({ ok: false, code: "INVALID_SELECTOR", error: "请按单个目标、明确的 ID 列表或查询条件选择一种删除方式。" });
        }

        if (isBatch) {
          const chromeApi = getApi();
          const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 50;
          const results = [];
          let deletedCount = 0;
          let failedCount = 0;

          // 1) PageLens batch deletion
          const wantPagelens = source === "pagelens" || (source === "auto" && (batchIds.length > 0 || Boolean(batchQuery)));
          if (wantPagelens) {
            const targets = [];
            if (batchIds.length) {
              for (const id of [...new Set(batchIds)]) targets.push({ id });
            } else if (batchQuery) {
              const matched = await listSavedTabGroups({ query: batchQuery, color: parsedColor.color, storage: getStorage() });
              for (const g of matched.slice(0, limit)) targets.push({ id: g.id, title: g.title });
            }
            for (const t of targets.slice(0, limit)) {
              try {
                const removed = await deleteSavedTabGroupRecord(t.id, { storage: getStorage() });
                deletedCount += 1;
                results.push({ ok: true, source: "pagelens", id: removed.id, title: removed.title });
              } catch (err) {
                failedCount += 1;
                results.push({ ok: false, source: "pagelens", id: t.id, error: err?.message || String(err) });
              }
            }
          }

          // 2) Chrome native batch deletion
          const wantNative = source === "chrome_native" || (source === "auto" && (batchGuids.length > 0 || Boolean(batchQuery)));
          if (wantNative) {
            const { error } = await acquireTabGroupsApi(chromeApi);
            if (error) {
              failedCount += 1;
              results.push({ ok: false, source: "chrome_native", error });
            } else {
              const nativeList = await callNative({
                action: "list",
                profile: args?.profile || undefined,
                query: batchGuids.length ? undefined : batchQuery || undefined,
                color: parsedColor.color || undefined,
              });
              if (!nativeList?.ok) {
                failedCount += 1;
                results.push({ ok: false, source: "chrome_native", error: nativeList?.error || "无法读取 Chrome 原生保存组。" });
              } else {
                const allNative = nativeList.groups || [];
                let nativeTargets = [];
                if (batchGuids.length) {
                  const wantSet = new Set(batchGuids);
                  nativeTargets = allNative.filter((g) => wantSet.has(g.guid));
                  for (const gId of wantSet) {
                    if (!nativeTargets.some((g) => g.guid === gId)) {
                      failedCount += 1;
                      results.push({ ok: false, source: "chrome_native", guid: gId, error: "找不到该原生保存组。" });
                    }
                  }
                } else {
                  nativeTargets = batchQuery ? allNative : [];
                }
                const remainingCap = Math.max(0, limit - results.length);
                const queue = nativeTargets.slice(0, remainingCap);
                for (const target of queue) {
                  const res = await deleteSingleNativeSavedGroup({
                    chromeApi, callNative, target, profile: nativeList.profile, ctx,
                  }).catch((err) => nativeFailure("DELETE_FAILED", String(err?.message || err)));
                  results.push(res);
                  if (res.ok) deletedCount += 1;
                  else failedCount += 1;
                }
              }
            }
          }

          return toToolText({
            ok: deletedCount > 0 && failedCount === 0,
            batch: true,
            deletedCount,
            failedCount,
            results,
          });
        }

        const explicit = args?.source || "auto";
        const resolvedSource =
          explicit !== "auto"
            ? explicit
            : args?.id
              ? "pagelens"
              : args?.guid
                ? "chrome_native"
                : null;

        if (resolvedSource === "pagelens" || resolvedSource === null) {
          let targetId = args?.id || "";
          if (!targetId && args?.title) {
            const result = await resolveLibraryTitle(args.title, explicit);
            if (result.error) return result.error;
            targetId = result.record?.id || "";
          }
          if (targetId) {
            try {
              const removed = await deleteSavedTabGroupRecord(targetId, { storage: getStorage() });
              return toToolText({ ok: true, source: "pagelens", deleted: removed });
            } catch (err) {
              return `删除已保存标签组失败：${err?.message || err}`;
            }
          }
          if (resolvedSource === "pagelens") return "在 PageLens 保存库里找不到要删除的标签组。";
        }

        // Chrome native saved tab group single deletion
        const chromeApi = getApi();
        const { error } = await acquireTabGroupsApi(chromeApi);
        if (error) return error;
        const nativeList = await callNative({ action: "list", profile: args?.profile || undefined });
        if (!nativeList?.ok) return `无法读取 Chrome 原生保存组：${nativeList?.error || "Native Host 不可用"}`;
        const hit = findNativeTarget(nativeList.groups || [], { guid: args?.guid, title: args?.title });
        if (!hit) return `Chrome 原生保存组无唯一匹配，请使用列表中的 GUID（guid=${args?.guid || ""} title=${args?.title || ""}）。`;

        const res = await deleteSingleNativeSavedGroup({
          chromeApi,
          callNative,
          target: hit.target,
          profile: nativeList.profile,
          ctx,
        });
        return toToolText(res);
      },
    },
  ];
}

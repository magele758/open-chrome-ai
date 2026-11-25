/**
 * Chrome 标签组管理工具（查、建/加、改/移动、移出/解散、关闭删除）。
 * 依赖可选权限 tabGroups 与 tabs；仅作用于当前已打开窗口里的标签组（含已折叠 collapsed=true 的组）。
 * Chrome 扩展 API 不暴露书签栏里「已保存但关闭」的原生标签组。
 */

import { compactTab, restrictedUrl, toToolText } from "../chrome.js";
import { requireOptionalFeature } from "../optional-permissions.js";
import { groupInWindow, tabGroupQuery, tabInWindow, tabQuery } from "../window-scope.js";

export const TAB_GROUP_COLORS = Object.freeze([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
]);

const COLOR_SET = new Set(TAB_GROUP_COLORS);
const MAX_TITLE = 64;

function obj(properties, required = []) {
  return { type: "object", properties, additionalProperties: false, required };
}

function missingApi() {
  return "当前环境没有 chrome.tabGroups / chrome.tabs。tabGroups 权限授予后若仍不可用，请重新加载扩展再试。";
}

function isWindowScopeError(err) {
  return err?.code === "WINDOW_SCOPE" || /任务所属窗口/.test(String(err?.message || ""));
}

export function normalizeGroupTitle(raw) {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
}

export function parseGroupId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 0) return { error: "groupId 必须是非负整数（来自 list_tab_groups）。" };
  return { groupId: id };
}

export function parseTabIds(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "tabIds 必须是非空的标签 id 数组。" };
  const ids = [];
  const seen = new Set();
  for (const item of raw) {
    const id = Number(item);
    if (!Number.isInteger(id) || id < 1) return { error: `无效的标签 id：${item}` };
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return { ids };
}

export function parseGroupColor(raw) {
  if (raw === undefined) return { color: undefined };
  const color = String(raw || "").trim().toLowerCase();
  if (!COLOR_SET.has(color)) {
    return { error: `不支持的标签组颜色：${raw}。可选：${TAB_GROUP_COLORS.join(", ")}` };
  }
  return { color };
}

export function compactTabGroup(group, extra = {}) {
  if (!group) return null;
  const out = {
    id: group.id,
    windowId: group.windowId,
    title: String(group.title || ""),
    color: group.color || "grey",
    collapsed: Boolean(group.collapsed),
  };
  if (typeof group.shared === "boolean") out.shared = group.shared;
  if (extra.tabCount != null) out.tabCount = extra.tabCount;
  if (Array.isArray(extra.tabs)) out.tabs = extra.tabs;
  if (extra.restrictedTabCount > 0) out.restrictedTabCount = extra.restrictedTabCount;
  if (extra.hiddenTabs != null) out.hiddenTabs = extra.hiddenTabs;
  return out;
}

/**
 * 删除并关闭已打开的 Chrome 标签组时，必须先 ungroup 再 remove tabs：
 * 否则在 Chrome（启用 Saved Tab Groups 后），当该组是窗口最后一组标签时直接 tabs.remove
 * 会触发窗口关闭保护，反而留下一个 tabCount=1 的幽灵已保存标签组。
 */
export async function ungroupAndRemoveTabs(tabsApi, ids, group) {
  const clean = (ids || []).filter((id) => Number.isInteger(id));
  if (!clean.length) return [];
  await verifyGroupMembers(tabsApi, clean, group);
  await tabsApi.ungroup(clean);
  await removeUngroupedTabs(tabsApi, clean, group.windowId);
  return clean;
}

export async function verifyGroupMembers(tabsApi, ids, group) {
  const tabs = await tabsApi.query({ windowId: group.windowId, groupId: group.id });
  const current = (tabs || []).filter((t) => t.groupId === group.id && t.windowId === group.windowId);
  const expected = new Set(ids);
  if (expected.size !== current.length || current.some((t) => !expected.has(t.id))) {
    throw new Error("标签组成员已变化，请刷新后重试。");
  }
}

export async function removeUngroupedTabs(tabsApi, ids, windowId) {
  const tabs = await Promise.all(ids.map((id) => tabsApi.get(id)));
  if (tabs.some((t) => t?.groupId !== -1 || t?.windowId !== windowId)) {
    throw new Error("标签已重新分组，已停止关闭网页。");
  }
  await tabsApi.remove(ids);
}

/**
 * 申请并获取 chrome.tabGroups + chrome.tabs。
 * tabGroups 是可选权限，授权后 chrome.tabGroups 才挂载，所以每次调用时现取。
 * group_tabs / update_tab_group / ungroup_tabs / close_tab_group 不读 tab.url/title，
 * 只需 tabGroups 权限；list_tab_groups 附带标签标题/URL 时再按需申请 tabs 权限。
 */
export async function acquireTabGroupsApi(api = globalThis.chrome, deps = {}) {
  const denied = await requireOptionalFeature("tabGroups", deps);
  if (denied) return { error: denied };
  const tabGroups = api?.tabGroups;
  const tabs = api?.tabs;
  if (!tabGroups || !tabs) return { error: missingApi() };
  return { tabGroups, tabs };
}

export function createTabGroupTools(ctx = {}, { api } = {}) {
  const getApi = () => api || globalThis.chrome;
  return [
    {
      name: "list_tab_groups",
      description:
        "列出当前已打开的 Chrome 标签组（包含已折叠 collapsed=true 的组），返回 id、标题、颜色、折叠状态、窗口和组内标签。注意：Chrome 扩展 API 看不到书签栏里已保存但关闭的原生标签组。",
      parameters: obj({
        query: { type: "string", description: "按标签组标题或组内标签标题/URL 子串过滤" },
        color: { type: "string", enum: TAB_GROUP_COLORS, description: "按颜色过滤" },
        collapsed: { type: "boolean", description: "true 只看已折叠，false 只看已展开" },
        currentWindow: { type: "boolean", description: "窗口任务只查看所属窗口；非窗口任务默认 true，false 查全部窗口" },
        includeTabs: { type: "boolean", description: "是否附带组内标签摘要列表，默认 true" },
      }),
      async execute(args = {}) {
        const chromeApi = getApi();
        const { tabGroups, tabs, error } = await acquireTabGroupsApi(chromeApi);
        if (error) return error;
        if (typeof tabGroups.query !== "function") return missingApi();
        const parsedColor = parseGroupColor(args?.color);
        if (parsedColor.error) return parsedColor.error;
        if (args?.collapsed !== undefined && typeof args.collapsed !== "boolean") {
          return "collapsed 必须是布尔值。";
        }
        const windowId = ctx.getWindowId?.();
        const currentWindow = args?.currentWindow !== false;
        const includeTabs = args?.includeTabs !== false;
        const needle = String(args?.query || "").trim().toLowerCase();
        const tabsDenied = includeTabs || needle ? await requireOptionalFeature("tabs") : "";
        const queryInfo = tabGroupQuery(windowId, currentWindow, chromeApi);
        if (parsedColor.color) queryInfo.color = parsedColor.color;
        if (typeof args?.collapsed === "boolean") queryInfo.collapsed = args.collapsed;

        try {
          let groups = (await tabGroups.query(queryInfo)) || [];
          groups = groups.filter((g) => {
            if (windowId != null && g.windowId !== windowId) return false;
            if (parsedColor.color && g.color !== parsedColor.color) return false;
            if (typeof args?.collapsed === "boolean" && Boolean(g.collapsed) !== args.collapsed) return false;
            return true;
          });
          const openTabs = typeof tabs.query === "function" ? (await tabs.query(tabQuery(windowId, currentWindow))) || [] : [];
          const byGroup = new Map();
          for (const tab of openTabs) {
            if (Number.isInteger(tab.groupId) && tab.groupId >= 0) {
              if (!byGroup.has(tab.groupId)) byGroup.set(tab.groupId, []);
              byGroup.get(tab.groupId).push(tab);
            }
          }
          const rows = [];
          for (const group of groups) {
            const rawTabs = byGroup.get(group.id) || [];
            const visibleTabs = tabsDenied
              ? rawTabs.map(compactTab)
              : rawTabs.filter((tab) => !restrictedUrl(tab.url) || tab.active).map(compactTab);
            if (needle) {
              const haystack = `${group.title || ""} ${visibleTabs.map((t) => `${t.title || ""} ${t.url || ""}`).join(" ")}`.toLowerCase();
              if (!haystack.includes(needle)) continue;
            }
            rows.push(
              compactTabGroup(group, {
                tabCount: rawTabs.length,
                ...(includeTabs ? { tabs: visibleTabs } : {}),
                restrictedTabCount: tabsDenied ? 0 : rawTabs.length - visibleTabs.length,
              }),
            );
          }
          return toToolText({
            count: rows.length,
            groups: rows,
            ...(tabsDenied ? { note: "未授予 tabs 权限，组内标签不含标题与 URL（标签组本身仍可正常查询和管理）。" } : {}),
          });
        } catch (err) {
          if (isWindowScopeError(err)) throw err;
          return `查询标签组失败：${err?.message || err}`;
        }
      },
    },
    {
      name: "group_tabs",
      description: "把一个或多个标签新建成 Chrome 标签组，或加入已有标签组（传 groupId）。可同时设置标题、颜色和折叠状态。",
      parameters: obj(
        {
          tabIds: {
            type: "array",
            items: { type: "integer", minimum: 1 },
            description: "要分组的标签 id 列表（来自 list_tabs / list_tab_groups）",
          },
          groupId: { type: "integer", minimum: 0, description: "已有标签组 id；省略则新建标签组" },
          title: { type: "string", description: "标签组名称（最多 64 字）" },
          color: { type: "string", enum: TAB_GROUP_COLORS, description: "标签组颜色" },
          collapsed: { type: "boolean", description: "是否折叠该标签组" },
        },
        ["tabIds"],
      ),
      async execute(args = {}) {
        const chromeApi = getApi();
        const { tabGroups, tabs, error } = await acquireTabGroupsApi(chromeApi);
        if (error) return error;
        if (typeof tabs.group !== "function") return missingApi();
        const parsedIds = parseTabIds(args?.tabIds);
        if (parsedIds.error) return parsedIds.error;
        const parsedColor = parseGroupColor(args?.color);
        if (parsedColor.error) return parsedColor.error;
        if (args?.collapsed !== undefined && typeof args.collapsed !== "boolean") {
          return "collapsed 必须是布尔值。";
        }
        let targetGroupId = null;
        if (args?.groupId !== undefined && args?.groupId !== null) {
          const parsedGroup = parseGroupId(args.groupId);
          if (parsedGroup.error) return parsedGroup.error;
          targetGroupId = parsedGroup.groupId;
        }
        const windowId = ctx.getWindowId?.();
        try {
          let firstTab = null;
          for (const id of parsedIds.ids) {
            const tab = await tabInWindow(id, windowId, chromeApi);
            if (!firstTab) firstTab = tab;
          }
          if (targetGroupId != null) await groupInWindow(targetGroupId, windowId, chromeApi);
          const createWin = windowId ?? firstTab?.windowId;
          const groupOpts =
            targetGroupId != null
              ? { tabIds: parsedIds.ids, groupId: targetGroupId }
              : { tabIds: parsedIds.ids, ...(createWin != null ? { createProperties: { windowId: createWin } } : {}) };
          const id = await tabs.group(groupOpts);
          const props = {};
          if (args?.title !== undefined) props.title = normalizeGroupTitle(args.title);
          if (parsedColor.color !== undefined) props.color = parsedColor.color;
          if (typeof args?.collapsed === "boolean") props.collapsed = args.collapsed;
          let group = null;
          if (Object.keys(props).length && typeof tabGroups.update === "function") {
            group = await tabGroups.update(id, props);
          }
          if (!group && typeof tabGroups.get === "function") {
            group = await tabGroups.get(id).catch(() => null);
          }
          await ctx.onTabsMutated?.();
          return toToolText({
            ok: true,
            created: targetGroupId == null,
            group: compactTabGroup(group || { id, windowId, ...props }),
            tabIds: parsedIds.ids,
          });
        } catch (err) {
          if (isWindowScopeError(err)) throw err;
          return `分组失败：${err?.message || err}`;
        }
      },
    },
    {
      name: "update_tab_group",
      description:
        "更新已有 Chrome 标签组的标题、颜色、展开/折叠状态（collapsed=false 展开，collapsed=true 折叠），或按 index 移动它在标签栏中的位置（0 为最前，-1 为末尾）。",
      parameters: obj(
        {
          groupId: { type: "integer", minimum: 0, description: "目标标签组 id（来自 list_tab_groups）" },
          title: { type: "string", description: "新的标签组名称（传空字符串可清空标题）" },
          color: { type: "string", enum: TAB_GROUP_COLORS, description: "新的颜色" },
          collapsed: { type: "boolean", description: "true 折叠，false 展开" },
          index: { type: "integer", minimum: -1, description: "可选：移动标签组到标签栏的新位置（0 为最前，-1 为末尾）" },
        },
        ["groupId"],
      ),
      async execute(args = {}) {
        const chromeApi = getApi();
        const { tabGroups, error } = await acquireTabGroupsApi(chromeApi);
        if (error) return error;
        const parsedGroup = parseGroupId(args?.groupId);
        if (parsedGroup.error) return parsedGroup.error;
        const parsedColor = parseGroupColor(args?.color);
        if (parsedColor.error) return parsedColor.error;
        if (args?.collapsed !== undefined && typeof args.collapsed !== "boolean") {
          return "collapsed 必须是布尔值。";
        }
        if (args?.index !== undefined && (!Number.isInteger(args.index) || args.index < -1)) {
          return "index 必须是大于等于 -1 的整数。";
        }
        const updateProps = {};
        if (args?.title !== undefined) updateProps.title = normalizeGroupTitle(args.title);
        if (parsedColor.color !== undefined) updateProps.color = parsedColor.color;
        if (typeof args?.collapsed === "boolean") updateProps.collapsed = args.collapsed;
        const wantsUpdate = Object.keys(updateProps).length > 0;
        const wantsMove = args?.index !== undefined;
        if (!wantsUpdate && !wantsMove) {
          return "至少需要提供 title、color、collapsed 或 index 之一。";
        }
        if (wantsUpdate && typeof tabGroups.update !== "function") return missingApi();
        if (wantsMove && typeof tabGroups.move !== "function") return missingApi();

        const windowId = ctx.getWindowId?.();
        try {
          let group = await groupInWindow(parsedGroup.groupId, windowId, chromeApi);
          if (wantsUpdate) {
            group = (await tabGroups.update(parsedGroup.groupId, updateProps)) || { ...group, ...updateProps };
          }
          if (wantsMove) {
            const moveProps = { index: args.index, ...(windowId != null ? { windowId } : {}) };
            group = (await tabGroups.move(parsedGroup.groupId, moveProps)) || group;
          }
          await ctx.onTabsMutated?.();
          return toToolText({ ok: true, group: compactTabGroup(group) });
        } catch (err) {
          if (isWindowScopeError(err)) throw err;
          return `更新标签组失败：${err?.message || err}`;
        }
      },
    },
    {
      name: "ungroup_tabs",
      description: "把指定标签移出标签组，或传 groupId 解散整个标签组（所有标签保持打开，不会关闭网页）。tabIds 和 groupId 只能传一个。",
      parameters: obj({
        tabIds: {
          type: "array",
          items: { type: "integer", minimum: 1 },
          description: "要移出分组的标签 id 列表",
        },
        groupId: { type: "integer", minimum: 0, description: "要整组解散的标签组 id（保留组内所有网页不关闭）" },
      }),
      async execute(args = {}) {
        const chromeApi = getApi();
        const { tabs, error } = await acquireTabGroupsApi(chromeApi);
        if (error) return error;
        if (typeof tabs.ungroup !== "function") return missingApi();
        const hasTabs = args?.tabIds !== undefined && args?.tabIds !== null;
        const hasGroup = args?.groupId !== undefined && args?.groupId !== null;
        if (hasTabs === hasGroup) return "tabIds 和 groupId 必须且只能提供一个。";
        const windowId = ctx.getWindowId?.();
        try {
          if (hasGroup) {
            const parsedGroup = parseGroupId(args.groupId);
            if (parsedGroup.error) return parsedGroup.error;
            await groupInWindow(parsedGroup.groupId, windowId, chromeApi);
            const q = { ...(windowId != null ? { windowId } : {}), groupId: parsedGroup.groupId };
            const rows = ((await tabs.query(q)) || []).filter((t) => t.groupId === parsedGroup.groupId);
            const ids = rows.map((t) => t.id).filter((id) => Number.isInteger(id));
            if (ids.length) await tabs.ungroup(ids);
            if (ctx.getTaskGroupId?.() === parsedGroup.groupId) ctx.setTaskGroupId?.(null);
            await ctx.onTabsMutated?.();
            return toToolText({ ok: true, groupId: parsedGroup.groupId, ungrouped: ids, dissolved: true });
          }
          const parsedIds = parseTabIds(args.tabIds);
          if (parsedIds.error) return parsedIds.error;
          for (const id of parsedIds.ids) await tabInWindow(id, windowId, chromeApi);
          await tabs.ungroup(parsedIds.ids);
          await ctx.onTabsMutated?.();
          return toToolText({ ok: true, ungrouped: parsedIds.ids });
        } catch (err) {
          if (isWindowScopeError(err)) throw err;
          return `移出标签组失败：${err?.message || err}`;
        }
      },
    },
    {
      name: "close_tab_group",
      description:
        "删除并关闭指定 Chrome 标签组及其中的全部标签页（会关闭网页）。如果只想取消分组但保留标签页，请用 ungroup_tabs。只在用户明确要求时调用。",
      parameters: obj(
        {
          groupId: { type: "integer", minimum: 0, description: "要关闭并删除的标签组 id（来自 list_tab_groups）" },
        },
        ["groupId"],
      ),
      async execute(args = {}) {
        const chromeApi = getApi();
        const { tabs, error } = await acquireTabGroupsApi(chromeApi);
        if (error) return error;
        const parsedGroup = parseGroupId(args?.groupId);
        if (parsedGroup.error) return parsedGroup.error;
        const windowId = ctx.getWindowId?.();
        try {
          const group = await groupInWindow(parsedGroup.groupId, windowId, chromeApi);
          const q = { ...(windowId != null ? { windowId } : {}), groupId: parsedGroup.groupId };
          const rows = ((await tabs.query(q)) || []).filter((t) => t.groupId === parsedGroup.groupId);
          const ids = rows.map((t) => t.id).filter((id) => Number.isInteger(id));
          if (ids.length) await ungroupAndRemoveTabs(tabs, ids, group);
          if (ctx.getTaskGroupId?.() === parsedGroup.groupId) ctx.setTaskGroupId?.(null);
          await ctx.onTabsMutated?.();
          return toToolText({
            ok: true,
            groupId: parsedGroup.groupId,
            title: String(group?.title || ""),
            closedTabIds: ids,
            closedCount: ids.length,
          });
        } catch (err) {
          if (isWindowScopeError(err)) throw err;
          return `关闭标签组失败：${err?.message || err}`;
        }
      },
    },
  ];
}

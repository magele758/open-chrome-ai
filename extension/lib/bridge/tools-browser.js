/**
 * 浏览器级 bridge 工具：标签/窗口、页面快照与按 ref 操作、下载、上传、对话框、设置。
 * 复用内部 Agent 的页面函数与 CDP / downloads / settings 实现；全部经 env 注入，便于用假 env 测试。
 * 每个工具带 scope（见 docs/agent-interop.md §1）。
 */

import { restrictedUrl } from "../chrome.js";
import { extractPage } from "../extract.js";
import { formatSnapshot, mergeFrameSnapshots } from "../jev-actions.js";
import { createBrowserApiTools } from "../agent/browser-api-tools.js";
import { createCookieTools } from "../agent/cookie-tools.js";
import {
  TAB_GROUP_COLORS,
  compactTabGroup,
  normalizeGroupTitle,
  parseGroupColor,
  parseGroupId,
  parseTabIds,
} from "../agent/tab-group-tools.js";
import {
  deleteSingleNativeSavedGroup,
  matchOpenGroupForNative,
  openNativeSavedGroup,
  verifyNativeGroupUpdated,
} from "../agent/saved-tab-group-tools.js";
import {
  deleteSavedTabGroupRecord,
  getSavedTabGroup,
  listSavedTabGroups,
  saveTabGroupRecord,
  updateSavedTabGroupRecord,
} from "../saved-tab-groups.js";
import { buildEgressPolicy } from "../agent/egress.js";
import { findInPage, getLinks, pageAct, scrollPage } from "../agent/page-fns.js";
import { actOnRef, scrollContainerOf, scrollViewport, snapshotControls } from "../agent/page-snapshot.js";
import { isSensitiveSetting, planSettingsChange, settingsSnapshot } from "../agent/settings-tools.js";
import { modifySettings } from "../storage.js";
import { isSensitivePath } from "../agent/shell-policy.js";
import { BridgeError, ERROR_CODES, makeArtifact } from "./protocol.js";
import { isUrlAllowed } from "./policy.js";

const EXTRA_SENSITIVE_UPLOAD =
  /(?:^|[/\\])(?:credentials|known_hosts|authorized_keys|\.bash_history|\.zsh_history|\.git-credentials|login data|cookies|local state|web data|[^/\\]*\.keychain(?:-db)?|shadow|sudoers|master\.key)$/i;

/** 上传前的硬拒绝：密钥、凭据、浏览器 profile 数据库等。与 scope 无关。 */
export function isSensitiveUploadPath(p) {
  const s = String(p || "");
  if (s.split(/[/\\]/).includes("..")) return true;
  return isSensitivePath(s) || EXTRA_SENSITIVE_UPLOAD.test(s);
}

/** 每个标签最近一次 snapshot_controls 的结果；trusted_* 与 act_element 用 index/ref 定位时查这里。 */
export function createSnapshotRefs() {
  const byTab = new Map();
  return {
    set: (tabId, snap) => byTab.set(tabId, snap),
    drop: (tabId) => byTab.delete(tabId),
    get(tabId, index) {
      const snap = byTab.get(tabId);
      if (!snap) return { error: "该标签还没有控件快照；先调用 snapshot_controls。" };
      const item = snap.items.find((x) => x.index === Number(index));
      return item ? { item } : { error: `快照里没有 ref ${index}；重新调用 snapshot_controls。` };
    },
  };
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return String(url || "");
  }
}

function parseToolText(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new BridgeError(ERROR_CODES.TOOL_FAILED, String(text).slice(0, 300));
  }
}

function publicItem(item) {
  const { node: _node, index, ...rest } = item;
  return { ref: index, ...rest };
}

export function createBrowserTools(env, { obj, TAB_ID, refs, trusted, wrapCdpTool }) {
  const tools = [];
  const add = (def) => tools.push(def);
  const allowed = (url, ctx) => Boolean(url) && !restrictedUrl(url) && isUrlAllowed(url, ctx.settings.agentBridgeOrigins);
  const compact = (t) => ({ id: t.id, windowId: t.windowId, active: Boolean(t.active), title: t.title || "", url: t.url || t.pendingUrl || "" });

  /** 动作可能弹出 alert/confirm，注入的脚本会被卡住；先返回对话框信息，让调用方用 handle_dialog。 */
  async function guardDialog(tabId, run) {
    const cdp = env.cdp;
    if (!cdp?.watchDialog) return run();
    try {
      await cdp.ensure(tabId);
    } catch {
      return run();
    }
    const watch = cdp.watchDialog(tabId);
    const pending = run();
    pending.catch(() => {});
    try {
      const first = await Promise.race([pending.then((value) => ({ value })), watch.promise.then((dialog) => ({ dialog }))]);
      const dialog = first.dialog || cdp.pendingDialog?.(tabId);
      if (!dialog) return first.value;
      return { ...(first.value && typeof first.value === "object" ? first.value : {}), dialog, hint: "页面弹出了对话框，用 handle_dialog 处理后再继续。" };
    } finally {
      watch.cancel();
    }
  }

  function checkResult(res, fallback) {
    if (res?.ok === false) {
      throw new BridgeError(ERROR_CODES.TOOL_FAILED, res.error || fallback, {
        details: res,
        ...(res.stale ? { hint: "页面已变化，重新 snapshot_controls 后再操作。" } : {}),
      });
    }
    return res;
  }

  async function actInFrames(tabId, kind, spec) {
    const first = await env.inject(tabId, pageAct, [kind, spec], { world: "MAIN" });
    if (!first || first.ok !== false || !first.notFound || !env.injectFrames) return first;
    const probes = await env.injectFrames(tabId, pageAct, ["probe", spec], { world: "MAIN" }).catch(() => []);
    const hit = probes.find((p) => p.frameId > 0 && p.result?.ok);
    if (!hit) return first;
    const res = await env.inject(tabId, pageAct, [kind, spec], { world: "MAIN", frameId: hit.frameId });
    return { ...res, frameId: hit.frameId };
  }

  // ---- tabs:manage / tabs:read ----

  add({
    name: "navigate_tab",
    description: "让白名单标签跳转到新 URL（目标 URL 也必须在白名单）。",
    parameters: obj({ tabId: TAB_ID, url: { type: "string" } }, ["tabId", "url"]),
    scope: "tabs:manage",
    needsTab: true,
    async execute(args, ctx) {
      const url = ctx.authorizeUrl(args.url);
      refs.drop(ctx.tab.id);
      const tab = await env.tabs.update(ctx.tab.id, { url });
      return { tabId: ctx.tab.id, url: tab?.pendingUrl || tab?.url || url };
    },
  });

  for (const [name, method, description] of [
    ["reload_tab", "reload", "刷新标签。"],
    ["go_back", "goBack", "标签后退一步（落地页可能不在白名单，之后的调用会被拒绝）。"],
    ["go_forward", "goForward", "标签前进一步（落地页可能不在白名单，之后的调用会被拒绝）。"],
  ]) {
    add({
      name,
      description,
      parameters: obj({ tabId: TAB_ID }, ["tabId"]),
      scope: "tabs:manage",
      needsTab: true,
      async execute(_args, ctx) {
        refs.drop(ctx.tab.id);
        await env.tabs[method](ctx.tab.id);
        return { tabId: ctx.tab.id, done: method };
      },
    });
  }

  add({
    name: "close_tab",
    description: "关闭白名单 origin 内的标签。",
    parameters: obj({ tabId: TAB_ID }, ["tabId"]),
    scope: "tabs:manage",
    needsTab: true,
    async execute(_args, ctx) {
      refs.drop(ctx.tab.id);
      await ungroupTaskTabs([ctx.tab], ctx);
      await env.tabs.remove(ctx.tab.id);
      return { tabId: ctx.tab.id, closed: true };
    },
  });

  async function ungroupTaskTabs(tabs, ctx) {
    const ids = tabs.filter(ctx.isTaskGroupedTab).map((tab) => tab.id);
    if (!ids.length || typeof env.tabs.ungroup !== "function") return;
    try {
      await env.tabs.ungroup(ids);
    } catch {
      // The tab or its group may have closed in the meantime.
    }
  }

  async function authorizeWindow(windowId, ctx, { all = false } = {}) {
    let win;
    try {
      win = await env.windows.get(windowId, { populate: true });
    } catch (err) {
      throw new BridgeError(ERROR_CODES.TAB_NOT_FOUND, `找不到窗口 ${windowId}：${err?.message || err}`);
    }
    const tabs = win?.tabs || [];
    const inScope = (t) => allowed(t.url || t.pendingUrl, ctx) && (!t.pendingUrl || allowed(t.pendingUrl, ctx));
    const ok = all ? tabs.length > 0 && tabs.every(inScope) : tabs.some(inScope);
    if (!ok) {
      const blocked = tabs.filter((t) => !inScope(t)).map((t) => originOf(t.pendingUrl || t.url));
      throw new BridgeError(
        ERROR_CODES.ORIGIN_NOT_ALLOWED,
        all ? `窗口 ${windowId} 含白名单外的标签，不能整窗关闭。` : `窗口 ${windowId} 没有白名单内的标签。`,
        { details: { origins: [...new Set(blocked)] } },
      );
    }
    return win;
  }

  add({
    name: "list_windows",
    description: "列出窗口及其中白名单内的标签（白名单外的标签只计数）。",
    parameters: obj({}),
    scope: "tabs:read",
    async execute(_args, ctx) {
      const wins = await env.windows.getAll({ populate: true });
      return wins.map((w) => {
        const tabs = (w.tabs || []).filter((t) => allowed(t.url, ctx));
        return {
          id: w.id,
          focused: Boolean(w.focused),
          state: w.state || "normal",
          type: w.type || "normal",
          incognito: Boolean(w.incognito),
          tabs: tabs.map(compact),
          hiddenTabs: (w.tabs || []).length - tabs.length,
        };
      });
    },
  });

  add({
    name: "create_window",
    description: "新开窗口并打开 URL（URL 必须在白名单）。默认 focused=false（不抢焦点）。",
    parameters: obj(
      {
        url: { type: "string" },
        focused: { type: "boolean" },
        state: { type: "string", enum: ["normal", "minimized", "maximized"] },
        width: { type: "integer" },
        height: { type: "integer" },
      },
      ["url"],
    ),
    scope: "tabs:manage",
    async execute(args, ctx) {
      const url = ctx.authorizeUrl(args.url);
      const props = { url, focused: args.focused === true };
      if (args.state && args.state !== "normal") {
        props.state = args.state;
        props.focused = args.state === "maximized";
      } else {
        if (args.width) props.width = args.width;
        if (args.height) props.height = args.height;
      }
      const win = await env.windows.create(props);
      return { windowId: win.id, tabs: (win.tabs || []).map(compact) };
    },
  });

  add({
    name: "focus_window",
    description: "把窗口切到前台（会抢焦点）。窗口里必须有白名单内的标签。",
    parameters: obj({ windowId: { type: "integer" } }, ["windowId"]),
    scope: "tabs:manage",
    focus: "activates",
    async execute(args, ctx) {
      await authorizeWindow(args.windowId, ctx);
      await env.windows.update(args.windowId, { focused: true });
      return { windowId: args.windowId, focused: true };
    },
  });

  add({
    name: "close_window",
    description: "关闭窗口；窗口内所有标签都必须在白名单内。",
    parameters: obj({ windowId: { type: "integer" } }, ["windowId"]),
    scope: "tabs:manage",
    async execute(args, ctx) {
      const win = await authorizeWindow(args.windowId, ctx, { all: true });
      const tabs = win.tabs || [];
      for (const t of tabs) ctx.checkTabLease(t.id);
      for (const t of tabs) refs.drop(t.id);
      await ungroupTaskTabs(tabs, ctx);
      await env.windows.remove(args.windowId);
      return { windowId: args.windowId, closed: true };
    },
  });

  function requireTabGroupsApi(method) {
    const tg = env.tabGroups;
    if (!tg || (method && typeof tg[method] !== "function")) {
      throw new BridgeError(
        ERROR_CODES.TOOL_FAILED,
        "当前环境没有 tabGroups 权限或接口：请先在 PageLens 侧栏里授权标签组权限后再试。",
      );
    }
    return tg;
  }

  async function authorizeGroup(groupId, ctx, { all = true, checkLease = false } = {}) {
    const parsed = parseGroupId(groupId);
    if (parsed.error) throw new BridgeError(ERROR_CODES.BAD_ARGS, parsed.error);
    const tg = requireTabGroupsApi("get");
    let group;
    try {
      group = await tg.get(parsed.groupId);
    } catch (err) {
      throw new BridgeError(ERROR_CODES.TAB_NOT_FOUND, `找不到标签组 ${parsed.groupId}：${err?.message || err}`);
    }
    if (!group) throw new BridgeError(ERROR_CODES.TAB_NOT_FOUND, `找不到标签组 ${parsed.groupId}`);
    const tabs = ((await env.tabs.query({})) || []).filter((t) => t.groupId === parsed.groupId);
    const inScope = (t) => allowed(t.url || t.pendingUrl, ctx) && (!t.pendingUrl || allowed(t.pendingUrl, ctx));
    const ok = all ? tabs.length > 0 && tabs.every(inScope) : tabs.some(inScope);
    if (!ok) {
      const blocked = tabs.filter((t) => !inScope(t)).map((t) => originOf(t.pendingUrl || t.url));
      throw new BridgeError(
        ERROR_CODES.ORIGIN_NOT_ALLOWED,
        all ? `标签组 ${parsed.groupId} 含白名单外的标签，不能操作整组。` : `标签组 ${parsed.groupId} 没有白名单内的标签。`,
        { details: { origins: [...new Set(blocked)] } },
      );
    }
    if (checkLease) {
      for (const t of tabs) ctx.checkTabLease(t.id);
    }
    return { group, tabs };
  }

  add({
    name: "list_tab_groups",
    description:
      "列出当前已打开（含已折叠）且包含白名单标签的 Chrome 标签组（白名单外的标签只计入 hiddenTabs）。Chrome 扩展 API 看不到书签栏里已保存但关闭的原生标签组。",
    parameters: obj({
      query: { type: "string", description: "按组标题或白名单标签标题/URL 子串过滤" },
      color: { type: "string", enum: TAB_GROUP_COLORS },
      collapsed: { type: "boolean", description: "true 只看已折叠，false 只看已展开" },
      windowId: { type: "integer", description: "只看指定窗口的标签组" },
      includeTabs: { type: "boolean", description: "是否附带组内白名单标签列表，默认 true" },
    }),
    scope: "tabs:read",
    async execute(args, ctx) {
      const tg = requireTabGroupsApi("query");
      const parsedColor = parseGroupColor(args.color);
      if (parsedColor.error) throw new BridgeError(ERROR_CODES.BAD_ARGS, parsedColor.error);
      const queryInfo = {};
      if (args.windowId != null) queryInfo.windowId = args.windowId;
      if (parsedColor.color) queryInfo.color = parsedColor.color;
      if (typeof args.collapsed === "boolean") queryInfo.collapsed = args.collapsed;

      const rawGroups = ((await tg.query(queryInfo)) || []).filter((g) => {
        if (args.windowId != null && g.windowId !== args.windowId) return false;
        if (parsedColor.color && g.color !== parsedColor.color) return false;
        if (typeof args.collapsed === "boolean" && Boolean(g.collapsed) !== args.collapsed) return false;
        return true;
      });
      const allTabs = (await env.tabs.query({})) || [];
      const byGroup = new Map();
      for (const tab of allTabs) {
        if (Number.isInteger(tab.groupId) && tab.groupId >= 0) {
          if (!byGroup.has(tab.groupId)) byGroup.set(tab.groupId, []);
          byGroup.get(tab.groupId).push(tab);
        }
      }
      const needle = String(args.query || "").trim().toLowerCase();
      const includeTabs = args.includeTabs !== false;
      const out = [];
      for (const g of rawGroups) {
        const groupTabs = byGroup.get(g.id) || [];
        const visibleTabs = groupTabs.filter((t) => allowed(t.url, ctx));
        if (!visibleTabs.length) continue;
        if (needle) {
          const hay = `${g.title || ""} ${visibleTabs.map((t) => `${t.title || ""} ${t.url || ""}`).join(" ")}`.toLowerCase();
          if (!hay.includes(needle)) continue;
        }
        out.push(
          compactTabGroup(g, {
            tabCount: groupTabs.length,
            hiddenTabs: groupTabs.length - visibleTabs.length,
            ...(includeTabs ? { tabs: visibleTabs.map((t) => ({ ...compact(t), groupId: t.groupId })) } : {}),
          }),
        );
      }
      return out;
    },
  });

  add({
    name: "group_tabs",
    description: "把一个或多个白名单标签新建成 Chrome 标签组，或加入已有标签组（传 groupId）；可同时设置标题、颜色与折叠状态。",
    parameters: obj(
      {
        tabIds: { type: "array", items: { type: "integer", minimum: 1 } },
        groupId: { type: "integer", minimum: 0 },
        title: { type: "string" },
        color: { type: "string", enum: TAB_GROUP_COLORS },
        collapsed: { type: "boolean" },
      },
      ["tabIds"],
    ),
    scope: "tabs:manage",
    async execute(args, ctx) {
      const tg = requireTabGroupsApi("group");
      const parsedIds = parseTabIds(args.tabIds);
      if (parsedIds.error) throw new BridgeError(ERROR_CODES.BAD_ARGS, parsedIds.error);
      const parsedColor = parseGroupColor(args.color);
      if (parsedColor.error) throw new BridgeError(ERROR_CODES.BAD_ARGS, parsedColor.error);

      let firstTab = null;
      for (const id of parsedIds.ids) {
        const tab = await ctx.authorizeTab(id);
        if (!firstTab) firstTab = tab;
        ctx.checkTabLease(tab.id);
      }
      if (args.groupId != null) {
        await authorizeGroup(args.groupId, ctx, { all: true, checkLease: true });
      }
      const createProperties =
        args.groupId == null && firstTab?.windowId != null ? { windowId: firstTab.windowId } : undefined;
      const id = await tg.group(parsedIds.ids, args.groupId ?? undefined, { strict: true, createProperties });
      const props = {};
      if (args.title !== undefined) props.title = normalizeGroupTitle(args.title);
      if (parsedColor.color !== undefined) props.color = parsedColor.color;
      if (typeof args.collapsed === "boolean") props.collapsed = args.collapsed;
      let group = null;
      if (Object.keys(props).length) {
        requireTabGroupsApi("update");
        group = await tg.update(id, props);
      }
      if (!group && typeof tg.get === "function") {
        group = await tg.get(id).catch(() => null);
      }
      return {
        created: args.groupId == null,
        group: compactTabGroup(group || { id, ...props }),
        tabIds: parsedIds.ids,
      };
    },
  });

  add({
    name: "update_tab_group",
    description:
      "更新白名单标签组的标题、颜色、展开/折叠状态（collapsed=false 展开），或按 index / windowId 移动标签组位置（传 windowId 未传 index 时默认移到目标窗口末尾 -1）。",
    parameters: obj(
      {
        groupId: { type: "integer", minimum: 0 },
        title: { type: "string" },
        color: { type: "string", enum: TAB_GROUP_COLORS },
        collapsed: { type: "boolean" },
        index: { type: "integer", minimum: -1 },
        windowId: { type: "integer" },
      },
      ["groupId"],
    ),
    scope: "tabs:manage",
    async execute(args, ctx) {
      const parsedColor = parseGroupColor(args.color);
      if (parsedColor.error) throw new BridgeError(ERROR_CODES.BAD_ARGS, parsedColor.error);
      if (args.index !== undefined && (!Number.isInteger(args.index) || args.index < -1)) {
        throw new BridgeError(ERROR_CODES.BAD_ARGS, "index 必须是大于等于 -1 的整数。");
      }
      const updateProps = {};
      if (args.title !== undefined) updateProps.title = normalizeGroupTitle(args.title);
      if (parsedColor.color !== undefined) updateProps.color = parsedColor.color;
      if (typeof args.collapsed === "boolean") updateProps.collapsed = args.collapsed;
      const wantsUpdate = Object.keys(updateProps).length > 0;
      const wantsMove = args.index !== undefined || args.windowId !== undefined;
      if (!wantsUpdate && !wantsMove) {
        throw new BridgeError(ERROR_CODES.BAD_ARGS, "至少需要提供 title、color、collapsed、index 或 windowId 之一。");
      }
      const { group: existing } = await authorizeGroup(args.groupId, ctx, { all: true, checkLease: true });
      if (args.windowId !== undefined) await authorizeWindow(args.windowId, ctx);
      let group = existing;
      if (wantsUpdate) {
        const tg = requireTabGroupsApi("update");
        group = (await tg.update(args.groupId, updateProps)) || { ...group, ...updateProps };
      }
      if (wantsMove) {
        const tg = requireTabGroupsApi("move");
        const moveProps = {
          index: args.index ?? -1,
          ...(args.windowId !== undefined ? { windowId: args.windowId } : {}),
        };
        group = (await tg.move(args.groupId, moveProps)) || group;
      }
      return { group: compactTabGroup(group) };
    },
  });

  add({
    name: "ungroup_tabs",
    description: "把指定白名单标签移出标签组，或传 groupId 解散整个白名单标签组（不关闭网页）。tabIds 与 groupId 只能传一个。",
    parameters: obj({
      tabIds: { type: "array", items: { type: "integer", minimum: 1 } },
      groupId: { type: "integer", minimum: 0 },
    }),
    scope: "tabs:manage",
    async execute(args, ctx) {
      const tg = requireTabGroupsApi("ungroup");
      const hasTabs = args.tabIds !== undefined && args.tabIds !== null;
      const hasGroup = args.groupId !== undefined && args.groupId !== null;
      if (hasTabs === hasGroup) {
        throw new BridgeError(ERROR_CODES.BAD_ARGS, "tabIds 和 groupId 必须且只能提供一个。");
      }
      if (hasGroup) {
        const { tabs } = await authorizeGroup(args.groupId, ctx, { all: true, checkLease: true });
        const ids = tabs.map((t) => t.id);
        if (ids.length) await tg.ungroup(ids);
        return { groupId: args.groupId, ungrouped: ids, dissolved: true };
      }
      const parsedIds = parseTabIds(args.tabIds);
      if (parsedIds.error) throw new BridgeError(ERROR_CODES.BAD_ARGS, parsedIds.error);
      for (const id of parsedIds.ids) {
        const tab = await ctx.authorizeTab(id);
        ctx.checkTabLease(tab.id);
      }
      await tg.ungroup(parsedIds.ids);
      return { ungrouped: parsedIds.ids };
    },
  });

  async function ungroupAndRemoveBridgeTabs(tabs) {
    const ids = tabs.map((t) => t.id).filter((id) => Number.isInteger(id));
    if (!ids.length) return [];
    await requireTabGroupsApi("ungroup").ungroup(ids);
    for (const id of ids) refs.drop(id);
    for (const id of ids) await env.tabs.remove(id);
    return ids;
  }

  add({
    name: "close_tab_group",
    description: "关闭并删除整个白名单标签组及其中的全部标签（组内所有标签都必须在白名单内）。只解散不关闭网页请用 ungroup_tabs。",
    parameters: obj({ groupId: { type: "integer", minimum: 0 } }, ["groupId"]),
    scope: "tabs:manage",
    async execute(args, ctx) {
      const { group, tabs } = await authorizeGroup(args.groupId, ctx, { all: true, checkLease: true });
      const closedIds = await ungroupAndRemoveBridgeTabs(tabs);
      return {
        groupId: args.groupId,
        title: String(group?.title || ""),
        closedTabIds: closedIds,
        closedCount: closedIds.length,
        closed: true,
      };
    },
  });

  // ---- saved tab groups（Chrome 原生 LevelDB/AX + PageLens 保存库）----

  const SAVED_TAB_ITEM = {
    oneOf: [
      { type: "string" },
      { type: "object", properties: { url: { type: "string" }, title: { type: "string" } }, required: ["url"], additionalProperties: false },
    ],
  };

  function requireSavedStorage() {
    if (!env.savedGroupsStorage) {
      throw new BridgeError(ERROR_CODES.TOOL_FAILED, "当前环境没有 savedGroupsStorage（chrome.storage.local）。");
    }
    return env.savedGroupsStorage;
  }

  async function callNativeSaved(payload) {
    if (typeof env.nativeSavedTabGroups !== "function") {
      return { ok: false, error: "当前环境未配置 Native Host 原生标签组接口。" };
    }
    return env.nativeSavedTabGroups(payload);
  }

  function authorizeSavedGroupTabs(tabs, ctx, label) {
    const urls = (tabs || []).flatMap((t) => t.pendingUrl ? [t.url || t.pendingUrl, t.pendingUrl] : [t.url]);
    const blocked = urls.filter((url) => !allowed(url, ctx)).map(originOf);
    if (!urls.length || blocked.length) {
      throw new BridgeError(
        ERROR_CODES.ORIGIN_NOT_ALLOWED,
        `${label} 含白名单外的标签，不能操作。`,
        { details: { origins: [...new Set(blocked)] } },
      );
    }
  }

  async function bridgeOpenSnapshot() {
    const tg = env.tabGroups;
    if (!tg?.query || !env.tabs?.query) throw new BridgeError(ERROR_CODES.TOOL_FAILED, "无法读取已打开的标签组。");
    const openGroups = await tg.query({});
    const openTabs = await env.tabs.query({});
    const byGroup = new Map();
    for (const t of openTabs) {
      if (Number.isInteger(t.groupId) && t.groupId >= 0) {
        if (!byGroup.has(t.groupId)) byGroup.set(t.groupId, []);
        byGroup.get(t.groupId).push(t);
      }
    }
    return { openGroups, byGroup };
  }

  async function findSavedTarget(args, title, ctx) {
    const source = args.source || "auto";
    if (!["auto", "pagelens", "chrome_native"].includes(source) || (args.id && args.guid)
      || (source === "pagelens" && args.guid) || (source === "chrome_native" && args.id)) {
      throw new BridgeError(ERROR_CODES.BAD_ARGS, "请指定一个来源，并使用对应的 id 或 guid。");
    }
    const name = String(title || "").trim().toLowerCase();
    if (!args.id && !args.guid && !name) throw new BridgeError(ERROR_CODES.BAD_ARGS, "需要提供标签组 id、guid 或标题。");
    const byName = (g) => name && String(g.title || "").trim().toLowerCase() === name;
    const matches = [];
    if (source !== "chrome_native" && !args.guid) {
      const storage = env.savedGroupsStorage;
      const records = args.id
        ? [await getSavedTabGroup(args.id, { storage })].filter(Boolean)
        : (await listSavedTabGroups({ storage })).filter(byName);
      for (const record of records) matches.push({ record, storage });
    }
    if (source !== "pagelens" && !args.id) {
      const list = await callNativeSaved({ action: "list", profile: args.profile || undefined });
      if (!list?.ok) {
        throw new BridgeError(ERROR_CODES.TOOL_FAILED, list?.error || "无法读取 Chrome 原生保存组。", {
          hint: matches.length ? "如要操作 PageLens 保存库，请指定 source=pagelens 或传入 id。" : list?.hint,
        });
      }
      const nativeGroups = list.groups || [];
      const records = nativeGroups.filter((g) => args.guid ? g.guid === args.guid : byName(g));
      for (const target of records) matches.push({ target, nativeList: list });
    }
    if (matches.length > 1) throw new BridgeError(ERROR_CODES.BAD_ARGS, "有多个同名标签组，请从列表中选择 id 或 guid。");
    if (!matches.length) throw new BridgeError(ERROR_CODES.TAB_NOT_FOUND, "找不到指定的已保存标签组。");
    const found = matches[0];
    authorizeSavedGroupTabs((found.target || found.record).tabs, ctx, "已保存标签组");
    return found;
  }

  function savedGroupChromeApi() {
    const tg = env.tabGroups;
    return {
      tabGroups: tg,
      windows: env.windows,
      tabs: {
        ...env.tabs,
        ...(tg?.ungroup ? { ungroup: (ids) => tg.ungroup(ids) } : {}),
        remove: async (ids) => {
          await env.tabs.remove(ids);
          for (const id of [ids].flat()) refs.drop(id);
        },
      },
    };
  }

  function nativeActionContext(ctx) {
    return { authorizeNativeCandidate: (record) => authorizeSavedGroupTabs(record.tabs, ctx, "Chrome 候选标签组") };
  }

  function requireNativeAction(result, fallback) {
    if (!result?.ok) {
      throw new BridgeError(ERROR_CODES.TOOL_FAILED, result?.error || fallback, {
        details: { code: result?.code || "NATIVE_ACTION_FAILED" },
        ...(result?.hint ? { hint: result.hint } : {}),
      });
    }
    return result;
  }

  async function bridgeCreateGroupFromUrls(urls, { title, color, collapsed = false }, ctx) {
    const tg = requireTabGroupsApi("group");
    const valid = urls.map((raw) => {
      const u = typeof raw === "string" ? raw : raw?.url;
      return ctx.authorizeUrl(u);
    });
    if (!valid.length) throw new BridgeError(ERROR_CODES.BAD_ARGS, "至少需要一个有效的 http(s) URL。");
    const tabIds = [];
    let winId;
    for (const url of valid) {
      const created = await env.tabs.create({ url, active: false, ...(winId != null ? { windowId: winId } : {}) });
      if (winId == null && created?.windowId != null) winId = created.windowId;
      tabIds.push(created.id);
    }
    const groupId = await tg.group(tabIds, undefined, {
      strict: true,
      ...(winId != null ? { createProperties: { windowId: winId } } : {}),
    });
    const props = {};
    if (title !== undefined) props.title = normalizeGroupTitle(title);
    if (color !== undefined) props.color = color;
    if (typeof collapsed === "boolean") props.collapsed = collapsed;
    let group = null;
    if (Object.keys(props).length && typeof tg.update === "function") group = await tg.update(groupId, props);
    if (!group && typeof tg.get === "function") group = await tg.get(groupId).catch(() => null);
    return { group: compactTabGroup(group || { id: groupId, windowId: winId, ...props }), tabIds };
  }

  add({
    name: "list_saved_tab_groups",
    description:
      "查询已保存的标签组（含 Chrome 原生已关闭保存组与 PageLens 保存库），仅返回含白名单标签的组，白名单外标签计入 hiddenTabs。",
    parameters: obj({
      source: { type: "string", enum: ["all", "chrome_native", "pagelens"] },
      query: { type: "string" },
      color: { type: "string", enum: TAB_GROUP_COLORS },
      closedOnly: { type: "boolean" },
      profile: { type: "string" },
      includeTabs: { type: "boolean" },
    }),
    scope: "tabs:read",
    async execute(args, ctx) {
      const source = args.source || "all";
      const parsedColor = parseGroupColor(args.color);
      if (parsedColor.error) throw new BridgeError(ERROR_CODES.BAD_ARGS, parsedColor.error);
      const includeTabs = args.includeTabs !== false;
      const closedOnly = args.closedOnly === true;
      const needle = String(args.query || "").trim().toLowerCase();
      const out = {};
      let total = 0;

      if (source === "all" || source === "chrome_native") {
        const res = await callNativeSaved({ action: "list", profile: args.profile || undefined });
        if (!res?.ok) {
          out.chromeNative = { ok: false, error: res?.error || "无法读取 Chrome 原生保存组。", count: 0, groups: [] };
        } else {
          const open = await bridgeOpenSnapshot().catch(() => null);
          const rows = [];
          for (const g of res.groups || []) {
            if (parsedColor.color && g.color !== parsedColor.color) continue;
            const rawTabs = g.tabs || [];
            const visibleTabs = rawTabs.filter((t) => allowed(t.url, ctx));
            if (!visibleTabs.length) continue;
            if (needle) {
              const hay = `${g.title || ""} ${visibleTabs.map((t) => `${t.title || ""} ${t.url}`).join(" ")}`.toLowerCase();
              if (!hay.includes(needle)) continue;
            }
            const matched = open && matchOpenGroupForNative(g, open.openGroups, open.byGroup, res.groups);
            if (closedOnly && (!open || matched)) continue;
            rows.push({
              guid: g.guid,
              title: g.title,
              color: g.color,
              tabCount: rawTabs.length,
              hiddenTabs: rawTabs.length - visibleTabs.length,
              isOpen: open ? Boolean(matched) : null,
              ...(matched ? { openGroupId: matched.id, openWindowId: matched.windowId } : {}),
              ...(includeTabs ? { tabs: visibleTabs } : {}),
              source: "chrome_native",
            });
          }
          total += rows.length;
          out.chromeNative = {
            ok: true, profile: res.profile, profiles: res.profiles, count: rows.length, groups: rows,
            ...(!open ? { openStateError: "无法确认原生保存组的打开状态。" } : {}),
          };
        }
      }

      if (source === "all" || source === "pagelens") {
        const list = env.savedGroupsStorage
          ? await listSavedTabGroups({ color: parsedColor.color, storage: env.savedGroupsStorage })
          : [];
        const rows = [];
        for (const g of list) {
          const visibleTabs = g.tabs.filter((t) => allowed(t.url, ctx));
          if (!visibleTabs.length) continue;
          if (needle) {
            const hay = `${g.title || ""} ${visibleTabs.map((t) => `${t.title || ""} ${t.url}`).join(" ")}`.toLowerCase();
            if (!hay.includes(needle)) continue;
          }
          rows.push({
            id: g.id,
            title: g.title,
            color: g.color,
            tabCount: g.tabs.length,
            hiddenTabs: g.tabs.length - visibleTabs.length,
            createdAt: g.createdAt,
            updatedAt: g.updatedAt,
            ...(includeTabs ? { tabs: visibleTabs } : {}),
            source: "pagelens",
          });
        }
        total += rows.length;
        out.pagelens = { count: rows.length, groups: rows };
      }

      out.totalCount = total;
      return out;
    },
  });

  add({
    name: "save_tab_group",
    description: "保存白名单标签组到 PageLens 保存库（可传 groupId 快照并可选 closeAfterSave），或传 title+tabs 新建保存组。",
    parameters: obj({
      groupId: { type: "integer", minimum: 0 },
      id: { type: "string" },
      title: { type: "string" },
      color: { type: "string", enum: TAB_GROUP_COLORS },
      tabs: { type: "array", items: SAVED_TAB_ITEM },
      closeAfterSave: { type: "boolean" },
      target: { type: "string", enum: ["pagelens", "chrome_native"] },
      collapsed: { type: "boolean" },
    }),
    scope: "tabs:manage",
    async execute(args, ctx) {
      const parsedColor = parseGroupColor(args.color);
      if (parsedColor.error) throw new BridgeError(ERROR_CODES.BAD_ARGS, parsedColor.error);

      if (args.id && (args.groupId != null || args.target !== "chrome_native")) {
        const previous = await getSavedTabGroup(args.id, { storage: requireSavedStorage() });
        if (previous) authorizeSavedGroupTabs(previous.tabs, ctx, "要覆盖的已保存标签组");
      }
      if (args.groupId != null) {
        const storage = requireSavedStorage();
        const { group, tabs } = await authorizeGroup(args.groupId, ctx, { all: true, checkLease: true });
        const title = args.title !== undefined ? normalizeGroupTitle(args.title) : normalizeGroupTitle(group.title || "未命名标签组");
        const color = parsedColor.color || group.color || "blue";
        const { record, replaced } = await saveTabGroupRecord(
          { id: args.id, title: title || "未命名标签组", color, tabs: tabs.map((t) => ({ url: t.url, title: t.title || "" })) },
          { storage, now: () => env.now() },
        );
        let closedCount = 0;
        if (args.closeAfterSave === true) {
          const closedIds = await ungroupAndRemoveBridgeTabs(tabs);
          closedCount = closedIds.length;
        }
        return { source: "pagelens", replaced, group: record, ...(args.closeAfterSave === true ? { closedAfterSave: true, closedCount } : {}) };
      }

      const title = normalizeGroupTitle(args.title);
      if (!title || !Array.isArray(args.tabs) || !args.tabs.length) {
        throw new BridgeError(ERROR_CODES.BAD_ARGS, "需要提供 groupId，或同时提供 title 与非空 tabs。");
      }
      const normalized = args.tabs.map((item) => {
        const url = ctx.authorizeUrl(typeof item === "string" ? item : item?.url);
        return { url, title: typeof item === "string" ? "" : String(item?.title || "").slice(0, 160) };
      });
      if (args.target === "chrome_native") {
        const opened = await bridgeCreateGroupFromUrls(
          normalized,
          { title, color: parsedColor.color || "blue", collapsed: Boolean(args.collapsed) },
          ctx,
        );
        return { source: "chrome_native", ...opened };
      }
      const storage = requireSavedStorage();
      const { record, replaced } = await saveTabGroupRecord(
        { id: args.id, title, color: parsedColor.color || "blue", tabs: normalized },
        { storage, now: () => env.now() },
      );
      return { source: "pagelens", replaced, group: record };
    },
  });

  add({
    name: "open_saved_tab_group",
    description: "打开已保存的白名单标签组（组内所有 URL 都必须在白名单内）：支持 PageLens 保存库与 Chrome 原生保存组（mode=native/recreate）。",
    parameters: obj({
      source: { type: "string", enum: ["auto", "chrome_native", "pagelens"] },
      id: { type: "string" },
      guid: { type: "string" },
      title: { type: "string" },
      profile: { type: "string" },
      mode: { type: "string", enum: ["native", "recreate"] },
      collapsed: { type: "boolean" },
    }),
    scope: "tabs:manage",
    async execute(args, ctx) {
      const found = await findSavedTarget(args, args.title, ctx);
      if (found.record) {
        const { record } = found;
        const opened = await bridgeCreateGroupFromUrls(
          record.tabs, { title: record.title, color: record.color, collapsed: Boolean(args.collapsed) }, ctx,
        );
        return { source: "pagelens", savedId: record.id, ...opened };
      }
      const { target, nativeList } = found;
      const chromeApi = savedGroupChromeApi();
      if (args.mode === "recreate") {
        const { openGroups, byGroup } = await bridgeOpenSnapshot();
        const existing = matchOpenGroupForNative(target, openGroups, byGroup, nativeList.groups);
        if (!existing) {
          const opened = await bridgeCreateGroupFromUrls(
            target.tabs, { title: target.title, color: target.color, collapsed: Boolean(args.collapsed) }, ctx,
          );
          return { source: "chrome_native", mode: "recreate", guid: target.guid, ...opened };
        }
      }
      const opened = requireNativeAction(
        await openNativeSavedGroup({ chromeApi, callNative: callNativeSaved, target, nativeList, ctx: nativeActionContext(ctx) }),
        "无法打开 Chrome 原生保存组。",
      );
      const { group } = await authorizeGroup(opened.group.id, ctx, { checkLease: true });
      const finalGroup = typeof args.collapsed === "boolean" && group.collapsed !== args.collapsed
        ? await env.tabGroups.update(group.id, { collapsed: args.collapsed }) : group;
      return {
        source: "chrome_native", mode: "native", guid: target.guid, title: target.title,
        alreadyOpen: opened.alreadyOpen, via: opened.via, group: compactTabGroup(finalGroup),
      };
    },
  });

  add({
    name: "update_saved_tab_group",
    description: "更新已保存的白名单标签组（标题、颜色、增删 URL）；组内全部已有与新增 URL 都须在白名单内。",
    parameters: obj({
      source: { type: "string", enum: ["auto", "chrome_native", "pagelens"] },
      id: { type: "string" },
      guid: { type: "string" },
      matchTitle: { type: "string" },
      title: { type: "string" },
      color: { type: "string", enum: TAB_GROUP_COLORS },
      tabs: { type: "array", items: SAVED_TAB_ITEM },
      addUrls: { type: "array", items: { type: "string" } },
      removeUrls: { type: "array", items: { type: "string" } },
      profile: { type: "string" },
    }),
    scope: "tabs:manage",
    async execute(args, ctx) {
      const parsedColor = parseGroupColor(args.color);
      if (parsedColor.error) throw new BridgeError(ERROR_CODES.BAD_ARGS, parsedColor.error);
      const hasChange =
        args.title !== undefined ||
        parsedColor.color !== undefined ||
        args.tabs !== undefined ||
        (Array.isArray(args.addUrls) && args.addUrls.length > 0) ||
        (Array.isArray(args.removeUrls) && args.removeUrls.length > 0);
      if (!hasChange) throw new BridgeError(ERROR_CODES.BAD_ARGS, "至少需要提供一个更新字段。");

      if (args.tabs !== undefined) {
        for (const item of args.tabs) ctx.authorizeUrl(typeof item === "string" ? item : item?.url);
      }
      if (Array.isArray(args.addUrls)) {
        for (const url of args.addUrls) ctx.authorizeUrl(url);
      }

      const found = await findSavedTarget(args, args.matchTitle, ctx);
      if (found.record) {
        const updated = await updateSavedTabGroupRecord(
          found.record.id,
          { title: args.title, color: parsedColor.color, tabs: args.tabs, addTabs: args.addUrls, removeUrls: args.removeUrls },
          { storage: found.storage, now: () => env.now() },
        );
        return { source: "pagelens", group: updated };
      }

      if (args.tabs !== undefined) throw new BridgeError(ERROR_CODES.BAD_ARGS, "原生保存组请用 addUrls 和 removeUrls 更新标签。");
      const { target, nativeList } = found;
      const opened = requireNativeAction(await openNativeSavedGroup({
        chromeApi: savedGroupChromeApi(), callNative: callNativeSaved, target, nativeList, ctx: nativeActionContext(ctx),
      }), "无法打开 Chrome 原生保存组以执行更新。");
      const { group: openGroup, tabs: originalTabs } = await authorizeGroup(opened.group.id, ctx, { checkLease: true });
      const drop = new Set((args.removeUrls || []).map((u) => String(u || "").trim()));
      const remainingUrls = [...originalTabs.map((t) => t.pendingUrl || t.url), ...(args.addUrls || [])].filter((u) => !drop.has(u));
      if (!remainingUrls.length) {
        throw new BridgeError(ERROR_CODES.BAD_ARGS, "不能移除组内全部标签。如需删除整个组请用 delete_saved_tab_group。");
      }

      const tg = requireTabGroupsApi("update");
      const props = {};
      if (args.title !== undefined) props.title = normalizeGroupTitle(args.title);
      if (parsedColor.color !== undefined) props.color = parsedColor.color;
      let finalGroup = openGroup;
      if (Object.keys(props).length) finalGroup = (await tg.update(openGroup.id, props)) || { ...openGroup, ...props };

      const addedTabIds = [];
      if (Array.isArray(args.addUrls) && args.addUrls.length) {
        requireTabGroupsApi("group");
        for (const url of args.addUrls) {
          const created = await env.tabs.create({ url, active: false, windowId: openGroup.windowId });
          addedTabIds.push(created.id);
        }
        if (addedTabIds.length) await tg.group(addedTabIds, openGroup.id, { strict: true });
      }
      const removedTabIds = [];
      if (Array.isArray(args.removeUrls) && args.removeUrls.length) {
        const { tabs: curTabs } = await authorizeGroup(openGroup.id, ctx, { checkLease: true });
        const toRemove = curTabs.filter((t) => drop.has(t.pendingUrl || t.url)).map((t) => t.id);
        if (toRemove.length >= curTabs.length) {
          throw new BridgeError(ERROR_CODES.BAD_ARGS, "不能移除组内全部标签；如需删除整个组请用 delete_saved_tab_group。");
        }
        for (const id of toRemove) {
          refs.drop(id);
          await env.tabs.remove(id);
          removedTabIds.push(id);
        }
      }
      const { tabs: finalTabs } = await authorizeGroup(openGroup.id, ctx, { checkLease: true });
      if (!await verifyNativeGroupUpdated(callNativeSaved, target.guid, nativeList.profile, finalGroup, finalTabs)) {
        throw new BridgeError(ERROR_CODES.VERIFY_FAILED, "已更新打开的标签组，尚未在原生保存组中确认变更。请刷新后检查。");
      }
      return {
        source: "chrome_native",
        guid: target.guid,
        openedForUpdate: !opened.alreadyOpen,
        group: compactTabGroup(finalGroup),
        ...(addedTabIds.length ? { addedTabIds } : {}),
        ...(removedTabIds.length ? { removedTabIds } : {}),
      };
    },
  });

  add({
    name: "delete_saved_tab_group",
    description: "永久删除已保存的白名单标签组（不可逆，组内所有 URL 必须在白名单内）。",
    parameters: obj({
      source: { type: "string", enum: ["auto", "chrome_native", "pagelens"] },
      id: { type: "string" },
      guid: { type: "string" },
      title: { type: "string" },
      profile: { type: "string" },
    }),
    scope: "tabs:manage",
    async execute(args, ctx) {
      const found = await findSavedTarget(args, args.title, ctx);
      if (found.record) {
        const deleted = await deleteSavedTabGroupRecord(found.record.id, { storage: found.storage });
        return { source: "pagelens", deleted, closed: true };
      }
      const { target, nativeList } = found;
      const deleted = requireNativeAction(await deleteSingleNativeSavedGroup({
        chromeApi: savedGroupChromeApi(), callNative: callNativeSaved, target, profile: nativeList.profile,
        ctx: nativeActionContext(ctx),
        authorizeOpenGroup: (group, tabs) => {
          authorizeSavedGroupTabs(tabs, ctx, `标签组 ${group.id}`);
          for (const tab of tabs) ctx.checkTabLease(tab.id);
        },
      }), "无法删除指定的 Chrome 原生保存组。");
      return { ...deleted, deleted: true };
    },
  });

  // ---- page:read ----

  add({
    name: "snapshot_controls",
    description:
      "视口内可操作控件快照（含 shadow DOM 与 iframe），每个控件带 ref 编号；随后用 act_element {ref} 或 trusted_click/hover/drag_drop 的 index 操作。翻页、弹窗、导航后需重新快照。",
    parameters: obj(
      {
        tabId: TAB_ID,
        limit: { type: "integer", description: "默认 120，最大 250" },
        textLimit: { type: "integer", description: "视口文字上限，默认 3000，最大 6000" },
        format: { type: "string", enum: ["json", "text"], description: "text 额外返回人读的编号表" },
      },
      ["tabId"],
    ),
    scope: "page:read",
    needsTab: true,
    async execute(args, ctx) {
      const frames = await env.injectFrames(ctx.tab.id, snapshotControls, [{ limit: args.limit, textLimit: args.textLimit }]);
      const snap = mergeFrameSnapshots(frames);
      if (!snap) throw new BridgeError(ERROR_CODES.TOOL_FAILED, "页面还没有可读内容（可能未加载完）。");
      refs.set(ctx.tab.id, snap);
      return {
        url: snap.url,
        title: snap.title,
        scroll: snap.scroll,
        items: snap.items.map(publicItem),
        omitted: snap.omitted,
        subframes: snap.subframes,
        text: snap.text,
        ...(args.format === "text" ? { table: formatSnapshot(snap) } : {}),
      };
    },
  });

  add({
    name: "extract_page",
    description: "抽取页面干净正文（去导航/侧栏）。format=markdown 时正文放在 artifact page.md。",
    parameters: obj(
      {
        tabId: TAB_ID,
        maxChars: { type: "integer", description: "默认 20000，最大 200000" },
        format: { type: "string", enum: ["text", "markdown"] },
      },
      ["tabId"],
    ),
    scope: "page:read",
    needsTab: true,
    async execute(args, ctx) {
      const pack = (await env.inject(ctx.tab.id, extractPage)) || {};
      const max = Math.min(Math.max(Number(args.maxChars) || 20000, 500), 200000);
      const full = String(pack.text || "");
      const out = {
        title: pack.title || ctx.tab.title || "",
        url: pack.url || ctx.tab.url,
        kind: pack.kind || "generic",
        chars: full.length,
        truncated: full.length > max || Boolean(pack.textTruncated),
      };
      const text = full.slice(0, max);
      if (args.format === "markdown") {
        const md = `# ${out.title}\n\n<${out.url}>\n\n${text}\n`;
        ctx.artifacts.push(makeArtifact("page.md", "text/markdown", md));
        return { ...out, artifact: "page.md" };
      }
      return { ...out, text };
    },
  });

  add({
    name: "find_in_page",
    description: "在页面文本里搜索关键词，返回上下文片段。",
    parameters: obj({ tabId: TAB_ID, query: { type: "string" }, limit: { type: "integer", description: "默认 8，最大 20" } }, ["tabId", "query"]),
    scope: "page:read",
    needsTab: true,
    async execute(args, ctx) {
      return checkResult(await env.inject(ctx.tab.id, findInPage, [args.query, args.limit]), "搜索失败");
    },
  });

  add({
    name: "get_links",
    description: "列出页面链接（文本 + 绝对 href）。",
    parameters: obj({ tabId: TAB_ID, limit: { type: "integer", description: "默认 40，最大 80" } }, ["tabId"]),
    scope: "page:read",
    needsTab: true,
    async execute(args, ctx) {
      return { links: (await env.inject(ctx.tab.id, getLinks, [args.limit])) || [] };
    },
  });

  // ---- page:act ----

  add({
    name: "act_element",
    description:
      "按 snapshot_controls 的 ref 操作控件（页面内合成事件）。action: click | fill（需 value）| select（需 value）| scroll_down | scroll_up（带 ref 滚动其内部滚动容器）。目标过期返回 TOOL_FAILED 且 details.stale=true。",
    parameters: obj(
      {
        tabId: TAB_ID,
        ref: { type: "integer", minimum: 1 },
        action: { type: "string", enum: ["click", "fill", "select", "scroll_down", "scroll_up"] },
        value: { type: "string" },
        submit: { type: "boolean" },
      },
      ["tabId", "action"],
    ),
    scope: "page:act",
    needsTab: true,
    trustHint: (args, ctx) => (args.ref != null ? refs.get(ctx.tab.id, args.ref).item?.label || "" : ""),
    async execute(args, ctx) {
      const tabId = ctx.tab.id;
      const action = args.action;
      const scroll = action === "scroll_down" || action === "scroll_up";
      if (!scroll && args.ref == null) throw new BridgeError(ERROR_CODES.BAD_ARGS, `${action} 需要 ref。`);
      let item = null;
      if (args.ref != null) {
        const found = refs.get(tabId, args.ref);
        if (found.error) throw new BridgeError(ERROR_CODES.BAD_ARGS, found.error);
        item = found.item;
      }
      if (action === "fill" && item.kind !== "fill") throw new BridgeError(ERROR_CODES.BAD_ARGS, `ref ${item.index} 不是可输入控件。`);
      if (action === "select" && item.kind !== "select") throw new BridgeError(ERROR_CODES.BAD_ARGS, `ref ${item.index} 不是下拉框。`);
      if ((action === "fill" || action === "select") && args.value == null) throw new BridgeError(ERROR_CODES.BAD_ARGS, `${action} 需要 value。`);
      const run = () => {
        if (scroll) {
          const dir = action === "scroll_up" ? "up" : "down";
          return item
            ? env.inject(tabId, scrollContainerOf, [item.node, dir], { frameId: item.frameId })
            : env.inject(tabId, scrollViewport, [dir]);
        }
        return env.inject(tabId, actOnRef, [action, { node: item.node, label: item.label, value: args.value, submit: args.submit }], {
          frameId: item.frameId,
        });
      };
      const res = await guardDialog(tabId, run);
      if (res?.stale) refs.drop(tabId);
      return checkResult(res, "操作失败");
    },
  });

  add({
    name: "select_option",
    description: "在 <select> 里选一项；value 可为 option 的 value 或可见文本。找不到时会探测 iframe。",
    parameters: obj({ tabId: TAB_ID, selector: { type: "string" }, value: { type: "string" }, nth: { type: "integer" } }, ["tabId", "selector", "value"]),
    scope: "page:act",
    needsTab: true,
    async execute(args, ctx) {
      const spec = { selector: args.selector, value: args.value, nth: args.nth };
      return checkResult(await guardDialog(ctx.tab.id, () => actInFrames(ctx.tab.id, "select", spec)), "选择失败");
    },
  });

  add({
    name: "scroll_page",
    description: "滚动页面：selector（滚到元素）/ percent（0–100）/ y（像素）/ direction（up|down 一屏）。",
    parameters: obj(
      {
        tabId: TAB_ID,
        selector: { type: "string" },
        percent: { type: "number" },
        y: { type: "number" },
        direction: { type: "string", enum: ["up", "down"] },
        block: { type: "string", enum: ["start", "center", "end", "nearest"] },
      },
      ["tabId"],
    ),
    scope: "page:act",
    needsTab: true,
    async execute(args, ctx) {
      if (args.direction && args.selector == null && args.percent == null && args.y == null) {
        return checkResult(await env.inject(ctx.tab.id, scrollViewport, [args.direction]), "滚动失败");
      }
      const opts = { selector: args.selector, percent: args.percent, y: args.y, block: args.block };
      return checkResult(await env.inject(ctx.tab.id, scrollPage, [opts]), "滚动失败");
    },
  });

  const dragInner = trusted.get("drag_drop");
  if (dragInner) {
    const def = wrapCdpTool(dragInner);
    add({ ...def, scope: "page:act", execute: (args, ctx) => guardDialog(ctx.tab.id, () => def.execute(args, ctx)) });
  }

  add({
    name: "handle_dialog",
    description: "处理页面的 alert / confirm / prompt / beforeunload。accept=true 确认（默认），false 取消；prompt 可带 promptText。",
    parameters: obj({ tabId: TAB_ID, accept: { type: "boolean" }, promptText: { type: "string" } }, ["tabId"]),
    scope: "page:act",
    needsTab: true,
    async execute(args, ctx) {
      const tabId = ctx.tab.id;
      await env.cdp.ensure?.(tabId);
      const dialog = env.cdp.pendingDialog?.(tabId) || null;
      const accept = args.accept !== false;
      try {
        await env.cdp.send(tabId, "Page.handleJavaScriptDialog", {
          accept,
          ...(args.promptText != null ? { promptText: args.promptText } : {}),
        });
      } catch (err) {
        if (/no dialog/i.test(err?.message || "")) throw new BridgeError(ERROR_CODES.TOOL_FAILED, "当前没有待处理的对话框。");
        throw err;
      }
      return { handled: dialog?.type || "dialog", message: dialog?.message ?? null, accepted: accept };
    },
  });

  // ---- downloads ----

  const apiTools = new Map(
    createBrowserApiTools({}, { resolveTabId: async (a) => Number(a.tabId), api: { downloads: env.downloads }, pollMs: env.downloadPollMs }).map(
      (t) => [t.name, t],
    ),
  );

  function downloadDestinationAllowed(url, ctx) {
    const patterns = ctx.session?.egress?.length ? ctx.session.egress : ctx.settings?.agentBridgeOrigins || [];
    return buildEgressPolicy({ tokenEgress: patterns }).isAllowed(url);
  }

  add({
    name: "download_file",
    description: "下载 http(s) 链接到本机下载目录（URL 必须在白名单），完成后返回本机路径。重定向后的最终 URL 若不在允许的目的地内会取消下载。较大文件请用 async:true。",
    parameters: obj(
      {
        url: { type: "string" },
        filename: { type: "string", description: "下载目录下的相对路径" },
        timeoutMs: { type: "integer", description: "等待完成，默认 30000，最大 120000" },
      },
      ["url"],
    ),
    scope: "downloads",
    async execute(args, ctx) {
      const url = ctx.authorizeUrl(args.url);
      if (!env.downloads?.download) throw new BridgeError(ERROR_CODES.TOOL_FAILED, "当前环境没有 chrome.downloads。");
      const text = await apiTools.get("download_file").execute(
        { ...args, url },
        { allowFinalUrl: (finalUrl) => downloadDestinationAllowed(finalUrl, ctx) },
      );
      const res = parseToolText(text);
      if (res.state === "blocked" || res.error === "EGRESS_NOT_ALLOWED") {
        throw new BridgeError(ERROR_CODES.EGRESS_NOT_ALLOWED, res.reason || `出站拦截：下载被重定向到未声明的目的地 ${res.url || ""}`, {
          hint: "最终地址不在 token 的网站范围或出站白名单里。不要换别的方式把文件拉下来。",
          details: { channel: "download", destination: res.url || null, origin: originOf(res.url) || null },
        });
      }
      if (res.state === "interrupted" || res.state === "missing") {
        throw new BridgeError(ERROR_CODES.TOOL_FAILED, `下载失败：${res.error || res.state}`, { details: res });
      }
      return res;
    },
  });

  add({
    name: "list_downloads",
    description: "最近的下载（只列来源 URL 在白名单内的）。",
    parameters: obj({ query: { type: "string" }, limit: { type: "integer", description: "默认 10，最大 30" } }),
    scope: "downloads",
    async execute(args, ctx) {
      if (!env.downloads?.search) throw new BridgeError(ERROR_CODES.TOOL_FAILED, "当前环境没有 chrome.downloads。");
      const rows = parseToolText(await apiTools.get("list_downloads").execute(args));
      return { downloads: rows.filter((d) => allowed(d.url, ctx)) };
    },
  });

  // ---- cookies（高危 scope；chrome_call 不开放 cookies.*）----

  const cookieTools = new Map(
    createCookieTools({}, { api: { get cookies() { return env.cookies; } } }).map((tool) => [tool.name, tool]),
  );
  for (const name of ["get_cookies", "set_cookie", "remove_cookie"]) {
    const inner = cookieTools.get(name);
    add({
      name: inner.name,
      description: inner.description,
      parameters: inner.parameters,
      scope: "cookies",
      async execute(args, ctx) {
        ctx.authorizeUrl(args.url);
        if (!env.cookies) throw new BridgeError(ERROR_CODES.TOOL_FAILED, "cookies 是可选权限，尚未授予：请先在 PageLens 侧栏里用一次 cookie 工具完成授权。");
        return parseToolText(await inner.execute(args));
      },
    });
  }

  // ---- upload ----

  const uploadInner = trusted.get("upload_file");
  if (uploadInner) {
    const def = wrapCdpTool(uploadInner);
    add({
      ...def,
      description: `${uploadInner.description} 密钥/凭据类路径（.ssh、.aws、.gnupg、.env、*.pem、*.key、id_* 等）一律拒绝（PATH_NOT_ALLOWED）。`,
      scope: "upload",
      async execute(args, ctx) {
        const blocked = (args.paths || []).map(String).filter(isSensitiveUploadPath);
        if (blocked.length) {
          throw new BridgeError(ERROR_CODES.PATH_NOT_ALLOWED, "拒绝上传敏感本机文件。", { details: { paths: blocked } });
        }
        return guardDialog(ctx.tab.id, () => def.execute(args, ctx));
      },
    });
  }

  // ---- settings ----

  add({
    name: "get_settings",
    description: "读取 PageLens 可调设置（非敏感项）。密钥、地址、安全开关等敏感项不返回，只在 protected 列出键名。",
    parameters: obj({}),
    scope: "settings:read",
    async execute() {
      const snap = settingsSnapshot(await env.getSettings());
      const visible = snap.settings.filter((s) => !s.sensitive && !isSensitiveSetting(s.key));
      const hidden = snap.settings.filter((s) => !visible.includes(s)).map((s) => s.key);
      return { settings: visible, protected: hidden, textModels: snap.textModels };
    },
  });

  add({
    name: "update_settings",
    description: "修改非敏感设置（键见 get_settings）。任一键属于敏感项则整批拒绝（SETTING_PROTECTED），不做部分修改。",
    parameters: obj(
      {
        changes: {
          type: "array",
          items: obj({ key: { type: "string" }, value: {} }, ["key", "value"]),
        },
      },
      ["changes"],
    ),
    scope: "settings:write",
    async execute(args) {
      const changes = args.changes;
      const protectedKeys = changes.map((c) => String(c?.key || "")).filter((k) => isSensitiveSetting(k));
      if (protectedKeys.length) {
        throw new BridgeError(ERROR_CODES.SETTING_PROTECTED, `受保护的设置不能由外部 Agent 修改：${protectedKeys.join(", ")}`, {
          details: { keys: protectedKeys },
          hint: "请用户在 PageLens 设置页手动修改。",
        });
      }
      let plan;
      await modifySettings(async (latest) => {
        plan = planSettingsChange(latest, changes);
        if (plan.errors.length) throw new BridgeError(ERROR_CODES.BAD_ARGS, plan.errors.join("\n"), { details: { errors: plan.errors } });
        if (!plan.diff.length) return null;
        return plan.next;
      }, {
        load: () => env.getSettings(),
        save: (next) => env.saveSettings(next),
      });
      return { changed: (plan?.diff || []).map(({ key, before, after }) => ({ key, before, after })) };
    },
  });

  return tools;
}

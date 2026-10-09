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
import { buildEgressPolicy } from "../agent/egress.js";
import { findInPage, getLinks, pageAct, scrollPage } from "../agent/page-fns.js";
import { actOnRef, scrollContainerOf, scrollViewport, snapshotControls } from "../agent/page-snapshot.js";
import { isSensitiveSetting, planSettingsChange, settingsSnapshot } from "../agent/settings-tools.js";
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
      await env.tabs.remove(ctx.tab.id);
      return { tabId: ctx.tab.id, closed: true };
    },
  });

  async function authorizeWindow(windowId, ctx, { all = false } = {}) {
    let win;
    try {
      win = await env.windows.get(windowId, { populate: true });
    } catch (err) {
      throw new BridgeError(ERROR_CODES.TAB_NOT_FOUND, `找不到窗口 ${windowId}：${err?.message || err}`);
    }
    const tabs = win?.tabs || [];
    const ok = all ? tabs.length > 0 && tabs.every((t) => allowed(t.url, ctx)) : tabs.some((t) => allowed(t.url, ctx));
    if (!ok) {
      const blocked = tabs.filter((t) => !allowed(t.url, ctx)).map((t) => originOf(t.url));
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
      for (const t of win.tabs || []) refs.drop(t.id);
      await env.windows.remove(args.windowId);
      return { windowId: args.windowId, closed: true };
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
        if (!env.cookies) throw new BridgeError(ERROR_CODES.TOOL_FAILED, "当前环境没有 chrome.cookies。");
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
      const plan = planSettingsChange(await env.getSettings(), changes);
      if (plan.errors.length) throw new BridgeError(ERROR_CODES.BAD_ARGS, plan.errors.join("\n"), { details: { errors: plan.errors } });
      if (!plan.diff.length) return { changed: [] };
      await env.saveSettings(plan.next);
      return { changed: plan.diff.map(({ key, before, after }) => ({ key, before, after })) };
    },
  });

  return tools;
}

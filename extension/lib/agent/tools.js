import { seekVideo, highlightQuote, extractPage } from "../extract.js";
import { loadYoutubeCaptions } from "../youtube.js";
import {
  CHROME_CALL_ALLOW,
  captureTab,
  chromeCall,
  compactTab,
  ensureTaskGroup,
  extensionUrl,
  inject,
  injectMain,
  isHttpUrl,
  restrictedUrl,
  toToolText,
} from "../chrome.js";
import {
  findInPage,
  getLinks,
  getPageInfo,
  getSelectionText,
  listControls,
  pageAct,
  queryDom,
  readTextTracks,
  runJs,
  scrollPage,
} from "./page-fns.js";
import { findSkill } from "./skills.js";
import {
  COMPANIONS,
  automaExecute,
  coseGetAccounts,
  cosePublish,
  probeCompanions,
} from "./companions.js";

const NOTES_KEY = "pagelensNotes";

function obj(properties, required = []) {
  return { type: "object", properties, additionalProperties: false, required };
}

function tabIdProp() {
  return { type: "integer", description: "标签 id；省略则用当前侧栏绑定的标签" };
}

function formatPack(pack) {
  if (!pack?.text && !pack?.title) return "未能抽取到正文。页面可能未加载完、需要登录，或是受限页。";
  const head = [
    pack.kind === "x" ? "类型：X 帖子" : "类型：网页",
    pack.title ? `标题：${pack.title}` : "",
    pack.url ? `URL：${pack.url}` : "",
    pack.selection ? `选区：${pack.selection}` : "",
  ].filter(Boolean);
  return [...head, "", (pack.text || "").slice(0, 9000)].join("\n");
}

async function resolveTabId(ctx, args) {
  const raw = args?.tabId;
  const id = raw != null && raw !== "" ? Number(raw) : ctx.getTabId?.();
  if (!id) throw new Error("没有可操作的标签。");
  return id;
}

async function defaultBookmarkParentId(parentId) {
  if (parentId) return String(parentId);
  try {
    const [bar] = await chrome.bookmarks.get("1");
    if (bar) return "1";
  } catch {
    /* ignore */
  }
  try {
    const tree = await chrome.bookmarks.getTree();
    return tree[0]?.children?.[0]?.id || "1";
  } catch {
    return "1";
  }
}

async function attachTabToTask(ctx, tabId) {
  if (!tabId) return null;
  const groupId = await ensureTaskGroup(tabId, {
    groupId: ctx.getTaskGroupId?.(),
    title: ctx.getTaskGroupTitle?.() || "PageLens",
  });
  if (groupId != null) ctx.setTaskGroupId?.(groupId);
  return groupId;
}

async function loadNotes() {
  const data = await chrome.storage.local.get(NOTES_KEY);
  const notes = data?.[NOTES_KEY];
  return notes && typeof notes === "object" ? notes : {};
}

export function createAgentTools(ctx) {
  return [
    {
      name: "extract_page",
      description: "抽取标签页干净正文（去导航/侧栏）。阅读或总结页面前应先调用。可传 tabId 读其他已打开的标签。",
      parameters: obj({ tabId: tabIdProp() }),
      async execute(args) {
        const tabId = args?.tabId != null ? Number(args.tabId) : ctx.getTabId?.();
        if (!tabId) return "没有可操作的标签。";
        const current = ctx.getTabId?.();
        if (!args?.tabId || tabId === current) {
          const pack = await ctx.refreshPack();
          return formatPack(pack);
        }
        const tab = await chrome.tabs.get(tabId);
        if (restrictedUrl(tab.url)) return `受限页，无法抽取：${tab.url}`;
        const pack = await inject(tabId, extractPage);
        return formatPack(pack || { title: tab.title, url: tab.url, text: "" });
      },
    },
    {
      name: "get_page_info",
      description: "轻量页信息：标题、URL、标题层级、选区、链接/图片数、视频进度。不需要全文时优先用这个。",
      parameters: obj({ tabId: tabIdProp() }),
      async execute(args) {
        return toToolText(await inject(await resolveTabId(ctx, args), getPageInfo));
      },
    },
    {
      name: "screenshot",
      description: "截取标签页可见画面，附加到本轮对话。非当前可见标签会先切过去再截。适合图、报错、视频画面。",
      parameters: obj({ tabId: tabIdProp() }),
      async execute(args) {
        const tabId = args?.tabId != null ? Number(args.tabId) : ctx.getTabId?.();
        const dataUrl = ctx.capture
          ? await ctx.capture(tabId)
          : await captureTab(tabId, ctx.getWindowId?.());
        if (!dataUrl) return "截图失败。";
        ctx.setImage?.(dataUrl);
        return "已截取当前画面，已附加到本轮对话。请用文字描述你看到的关键信息，或继续回答用户。";
      },
    },
    {
      name: "get_selection",
      description: "读取页面当前选中的文字。",
      parameters: obj({ tabId: tabIdProp() }),
      async execute(args) {
        const text = await inject(await resolveTabId(ctx, args), getSelectionText);
        return text ? String(text) : "没有选区。";
      },
    },
    {
      name: "get_links",
      description: "列出页面链接（文本 + href）。",
      parameters: obj({
        tabId: tabIdProp(),
        limit: { type: "integer", description: "最多返回多少条，默认 40" },
      }),
      async execute(args) {
        return toToolText(await inject(await resolveTabId(ctx, args), getLinks, [args?.limit]));
      },
    },
    {
      name: "find_in_page",
      description: "在页面文本里搜索关键词，返回上下文片段。",
      parameters: obj(
        {
          query: { type: "string", description: "要找的文字" },
          tabId: tabIdProp(),
          limit: { type: "integer", description: "最多几条，默认 8" },
        },
        ["query"],
      ),
      async execute(args) {
        return toToolText(
          await inject(await resolveTabId(ctx, args), findInPage, [String(args.query || ""), args.limit]),
        );
      },
    },
    {
      name: "query_dom",
      description: "用 CSS 选择器读取 DOM 节点的 tag/文本/href，适合找按钮、标题、列表。",
      parameters: obj(
        {
          selector: { type: "string", description: "CSS 选择器" },
          tabId: tabIdProp(),
          limit: { type: "integer", description: "最多节点数，默认 20" },
        },
        ["selector"],
      ),
      async execute(args) {
        return toToolText(
          await inject(await resolveTabId(ctx, args), queryDom, [String(args.selector || ""), args.limit]),
        );
      },
    },
    {
      name: "list_controls",
      description: "列出当前页可见的按钮、链接、输入框，带建议选择器。要点击或填写前先看这个。",
      parameters: obj({
        tabId: tabIdProp(),
        limit: { type: "integer", description: "默认 40" },
      }),
      async execute(args) {
        return toToolText(await inject(await resolveTabId(ctx, args), listControls, [args?.limit]));
      },
    },
    {
      name: "click",
      description: "点击页面上的按钮或链接。用 selector（CSS）或 text（可见文字）。操作前可用 list_controls / query_dom 定位。",
      parameters: obj({
        tabId: tabIdProp(),
        selector: { type: "string", description: "CSS 选择器" },
        text: { type: "string", description: "按钮/链接上的可见文字" },
        nth: { type: "integer", description: "多个匹配时取第几个，从 0 开始" },
      }),
      async execute(args) {
        const tabId = await resolveTabId(ctx, args);
        await attachTabToTask(ctx, tabId);
        return toToolText(
          await injectMain(tabId, pageAct, [
            "click",
            { selector: args.selector, text: args.text, nth: args.nth },
          ]),
        );
      },
    },
    {
      name: "fill",
      description: "向输入框填文字。用 selector 或 text 定位。submit=true 时尝试回车/提交表单。",
      parameters: obj(
        {
          tabId: tabIdProp(),
          selector: { type: "string" },
          text: { type: "string", description: "用可见文字定位控件" },
          value: { type: "string", description: "要填入的内容" },
          submit: { type: "boolean", description: "填完是否提交" },
          nth: { type: "integer" },
        },
        ["value"],
      ),
      async execute(args) {
        const tabId = await resolveTabId(ctx, args);
        await attachTabToTask(ctx, tabId);
        return toToolText(
          await injectMain(tabId, pageAct, [
            "fill",
            {
              selector: args.selector,
              text: args.text,
              value: args.value,
              submit: args.submit,
              nth: args.nth,
            },
          ]),
        );
      },
    },
    {
      name: "select_option",
      description: "在 <select> 里选一项，value 可以是 option 的 value 或可见文本。",
      parameters: obj(
        {
          tabId: tabIdProp(),
          selector: { type: "string" },
          value: { type: "string" },
          nth: { type: "integer" },
        },
        ["selector", "value"],
      ),
      async execute(args) {
        const tabId = await resolveTabId(ctx, args);
        await attachTabToTask(ctx, tabId);
        return toToolText(
          await injectMain(tabId, pageAct, [
            "select",
            { selector: args.selector, value: args.value, nth: args.nth },
          ]),
        );
      },
    },
    {
      name: "press_key",
      description: "对当前焦点或指定元素发送按键，如 Enter、Escape、Tab、ArrowDown。",
      parameters: obj(
        {
          tabId: tabIdProp(),
          key: { type: "string", description: "如 Enter" },
          selector: { type: "string" },
        },
        ["key"],
      ),
      async execute(args) {
        const tabId = await resolveTabId(ctx, args);
        await attachTabToTask(ctx, tabId);
        return toToolText(
          await injectMain(tabId, pageAct, [
            "press",
            { key: args.key, selector: args.selector },
          ]),
        );
      },
    },
    {
      name: "wait_for",
      description: "等待某个选择器或文字出现，默认最多 8 秒。点击后页面还在加载时用。",
      parameters: obj({
        tabId: tabIdProp(),
        selector: { type: "string" },
        text: { type: "string" },
        timeoutMs: { type: "integer", description: "默认 8000，最大 20000" },
      }),
      async execute(args) {
        return toToolText(
          await injectMain(await resolveTabId(ctx, args), pageAct, [
            "wait",
            { selector: args.selector, text: args.text, timeoutMs: args.timeoutMs },
          ]),
        );
      },
    },
    {
      name: "scroll_page",
      description: "滚动页面到选择器、百分比或 y 像素。",
      parameters: obj({
        tabId: tabIdProp(),
        selector: { type: "string", description: "滚到这个元素" },
        percent: { type: "number", description: "0–100，页高百分比" },
        y: { type: "number", description: "绝对像素" },
        block: { type: "string", description: "scrollIntoView block，默认 center" },
      }),
      async execute(args) {
        return toToolText(
          await inject(await resolveTabId(ctx, args), scrollPage, [
            { selector: args.selector, percent: args.percent, y: args.y, block: args.block },
          ]),
        );
      },
    },
    {
      name: "seek_video",
      description: "把页面视频跳到指定秒数。",
      parameters: obj(
        {
          seconds: { type: "number", description: "目标时间，秒" },
          tabId: tabIdProp(),
        },
        ["seconds"],
      ),
      async execute(args) {
        try {
          await inject(await resolveTabId(ctx, args), seekVideo, [Number(args.seconds)]);
        } catch (err) {
          if (/NO_PLAYER/.test(err?.message || "")) return "当前页没有可跳转的视频。";
          throw err;
        }
        return `已跳到 ${Number(args.seconds)} 秒。`;
      },
    },
    {
      name: "highlight_quote",
      description: "在页面上高亮一段原文。",
      parameters: obj(
        {
          text: { type: "string", description: "要高亮的原文片段" },
          tabId: tabIdProp(),
        },
        ["text"],
      ),
      async execute(args) {
        const hit = await inject(await resolveTabId(ctx, args), highlightQuote, [String(args.text || "")]);
        return hit ? "已高亮。" : "没有在页面上找到这段文字。";
      },
    },
    {
      name: "get_captions",
      description: "读取视频字幕。YouTube 走 timedtext；其他页尝试 HTML5 textTracks。",
      parameters: obj({ tabId: tabIdProp() }),
      async execute(args) {
        const tabId = await resolveTabId(ctx, args);
        const tab = await chrome.tabs.get(tabId);
        if (/youtube\.com|youtu\.be/i.test(tab.url || "")) {
          const caps = await loadYoutubeCaptions(tabId, tab.url);
          if (caps.status !== "ready" || !caps.text) return `字幕不可用（${caps.status || "missing"}）。`;
          return caps.text.slice(0, 9000);
        }
        const tracks = await inject(tabId, readTextTracks);
        if (tracks?.status === "ready" && tracks.text) return String(tracks.text).slice(0, 9000);
        return toToolText(tracks || { status: "missing" });
      },
    },
    {
      name: "run_js",
      description:
        "在目标标签执行 JavaScript，返回 JSON 可序列化结果。读 DOM 用 return。点击/填表请优先用 click、fill。登录、支付、下单只在用户明确要求时做。",
      parameters: obj(
        {
          code: { type: "string", description: "JS 源码，例如 return document.title" },
          tabId: tabIdProp(),
        },
        ["code"],
      ),
      async execute(args) {
        return toToolText(await inject(await resolveTabId(ctx, args), runJs, [String(args.code || "")]));
      },
    },
    {
      name: "list_tabs",
      description: "列出已打开的标签（id / 标题 / URL / groupId）。对比多页前先调这个。",
      parameters: obj({
        currentWindow: { type: "boolean", description: "默认 true，只看当前窗口" },
        query: { type: "string", description: "按标题或 URL 子串过滤" },
      }),
      async execute(args) {
        const currentWindow = args?.currentWindow !== false;
        const tabs = await chrome.tabs.query(currentWindow ? { currentWindow: true } : {});
        const needle = String(args?.query || "").trim().toLowerCase();
        const rows = tabs
          .filter((tab) => !restrictedUrl(tab.url) || tab.active)
          .filter((tab) => {
            if (!needle) return true;
            return `${tab.title || ""} ${tab.url || ""}`.toLowerCase().includes(needle);
          })
          .map(compactTab);
        return toToolText({ count: rows.length, tabs: rows });
      },
    },
    {
      name: "open_tab",
      description: "打开一个新标签。默认不抢焦点（active=false）。只接受 http(s)。",
      parameters: obj(
        {
          url: { type: "string", description: "http(s) URL" },
          active: { type: "boolean", description: "是否立即切过去，默认 false" },
        },
        ["url"],
      ),
      async execute(args) {
        const url = String(args.url || "").trim();
        if (!isHttpUrl(url)) return `只能打开 http(s) URL，收到：${url}`;
        const tab = await chrome.tabs.create({ url, active: Boolean(args.active) });
        const groupId = await attachTabToTask(ctx, tab.id);
        await ctx.onTabsMutated?.();
        return toToolText({ opened: compactTab(tab), groupId });
      },
    },
    {
      name: "switch_tab",
      description: "切到指定标签，并让侧栏绑定它。",
      parameters: obj({ tabId: { type: "integer", description: "目标标签 id" } }, ["tabId"]),
      async execute(args) {
        const tabId = Number(args.tabId);
        const tab = await chrome.tabs.update(tabId, { active: true });
        if (tab?.windowId != null) {
          try {
            await chrome.windows.update(tab.windowId, { focused: true });
          } catch {
            /* 无窗口权限时忽略 */
          }
        }
        await ctx.onTabsMutated?.();
        return toToolText({ active: compactTab(tab) });
      },
    },
    {
      name: "close_tab",
      description: "关闭指定标签。只在用户明确要求时调用。",
      parameters: obj({ tabId: { type: "integer", description: "要关闭的标签 id" } }, ["tabId"]),
      async execute(args) {
        const tabId = Number(args.tabId);
        await chrome.tabs.remove(tabId);
        await ctx.onTabsMutated?.();
        return `已关闭标签 ${tabId}。`;
      },
    },
    {
      name: "close_task_group",
      description: "关闭本轮 PageLens 任务分组里的全部标签。用户说「关掉这批」「结束任务」时用。",
      parameters: obj({}),
      async execute() {
        const groupId = ctx.getTaskGroupId?.();
        if (groupId == null || groupId < 0) return "当前任务还没有标签分组。";
        const tabs = await chrome.tabs.query({ groupId });
        const ids = tabs.map((t) => t.id).filter((id) => id != null);
        if (ids.length) await chrome.tabs.remove(ids);
        ctx.setTaskGroupId?.(null);
        await ctx.onTabsMutated?.();
        return `已关闭任务分组（${ids.length} 个标签）。`;
      },
    },
    {
      name: "reload_tab",
      description: "刷新标签页。",
      parameters: obj({ tabId: tabIdProp() }),
      async execute(args) {
        const tabId = await resolveTabId(ctx, args);
        await chrome.tabs.reload(tabId);
        await ctx.onTabsMutated?.();
        return `已刷新标签 ${tabId}。`;
      },
    },
    {
      name: "navigate_tab",
      description: "让标签跳到新的 http(s) URL。只在用户明确要求时调用。",
      parameters: obj(
        {
          url: { type: "string", description: "目标 http(s) URL" },
          tabId: tabIdProp(),
        },
        ["url"],
      ),
      async execute(args) {
        const url = String(args.url || "").trim();
        if (!isHttpUrl(url)) return `只能打开 http(s) URL，收到：${url}`;
        const tabId = await resolveTabId(ctx, args);
        const tab = await chrome.tabs.update(tabId, { url });
        const groupId = await attachTabToTask(ctx, tabId);
        await ctx.onTabsMutated?.();
        return toToolText({ navigated: compactTab(tab), groupId });
      },
    },
    {
      name: "search_bookmarks",
      description: "搜索浏览器书签。",
      parameters: obj({ query: { type: "string", description: "标题或 URL 关键词" } }, ["query"]),
      async execute(args) {
        if (!chrome.bookmarks?.search) return "当前未授权 bookmarks。";
        const hits = await chrome.bookmarks.search(String(args.query || ""));
        return toToolText(
          hits.slice(0, 30).map((b) => ({ id: b.id, title: b.title, url: b.url, parentId: b.parentId })),
        );
      },
    },
    {
      name: "create_bookmark_folder",
      description: "新建书签文件夹。默认建在书签栏下，返回文件夹 id。",
      parameters: obj(
        {
          title: { type: "string", description: "文件夹名称" },
          parentId: { type: "string", description: "父文件夹 id，默认书签栏" },
        },
        ["title"],
      ),
      async execute(args) {
        if (!chrome.bookmarks?.create) return "当前未授权 bookmarks。";
        const title = String(args.title || "").trim();
        if (!title) return "需要文件夹名称。";
        const parentId = await defaultBookmarkParentId(args.parentId);
        const node = await chrome.bookmarks.create({ parentId, title });
        return toToolText({ id: node.id, title: node.title, parentId: node.parentId });
      },
    },
    {
      name: "add_bookmark",
      description: "把 URL 加到书签。省略 url 则收藏当前标签。可指定 parentId 放进某个文件夹。",
      parameters: obj({
        title: { type: "string" },
        url: { type: "string" },
        parentId: { type: "string", description: "文件夹 id，默认书签栏" },
      }),
      async execute(args) {
        if (!chrome.bookmarks?.create) return "当前未授权 bookmarks。";
        let url = String(args.url || "").trim();
        let title = String(args.title || "").trim();
        if (!url) {
          const tabId = ctx.getTabId?.();
          if (!tabId) return "没有当前标签可收藏。";
          const tab = await chrome.tabs.get(tabId);
          url = tab.url || "";
          title = title || tab.title || url;
        }
        if (!isHttpUrl(url)) return `只能收藏 http(s) URL，收到：${url}`;
        const parentId = await defaultBookmarkParentId(args.parentId);
        const node = await chrome.bookmarks.create({ parentId, title: title || url, url });
        return toToolText({ id: node.id, title: node.title, url: node.url, parentId: node.parentId });
      },
    },
    {
      name: "bookmark_open_tabs",
      description:
        "新建一个书签文件夹，把当前窗口（或全部窗口）已打开的 http(s) 标签收藏进去。适合「把这一批标签存成收藏夹」。chrome:// 等受限页会跳过。",
      parameters: obj(
        {
          title: { type: "string", description: "文件夹名称，例如 今天研究" },
          currentWindow: { type: "boolean", description: "默认 true，只收当前窗口" },
          parentId: { type: "string", description: "父文件夹 id，默认书签栏" },
        },
        ["title"],
      ),
      async execute(args) {
        if (!chrome.bookmarks?.create) return "当前未授权 bookmarks。";
        const title = String(args.title || "").trim();
        if (!title) return "需要文件夹名称。";
        const parentId = await defaultBookmarkParentId(args.parentId);
        const folder = await chrome.bookmarks.create({ parentId, title });
        const query = args.currentWindow === false ? {} : { currentWindow: true };
        const tabs = await chrome.tabs.query(query);
        const added = [];
        const skipped = [];
        const seen = new Set();
        for (const tab of tabs) {
          const url = tab.url || "";
          if (!isHttpUrl(url)) {
            skipped.push({ title: tab.title || "", url, reason: "非 http(s)" });
            continue;
          }
          if (seen.has(url)) continue;
          seen.add(url);
          const node = await chrome.bookmarks.create({
            parentId: folder.id,
            title: tab.title || url,
            url,
          });
          added.push({ id: node.id, title: node.title, url: node.url });
        }
        return toToolText({
          folder: { id: folder.id, title: folder.title, parentId: folder.parentId },
          added: added.length,
          skipped: skipped.length,
          bookmarks: added,
        });
      },
    },
    {
      name: "search_history",
      description: "搜索最近浏览历史（默认 7 天、最多 20 条）。",
      parameters: obj({
        query: { type: "string", description: "关键词，可空" },
        maxResults: { type: "integer", description: "默认 20，最大 30" },
      }),
      async execute(args) {
        if (!chrome.history?.search) return "当前未授权 history。";
        const hits = await chrome.history.search({
          text: String(args.query || ""),
          maxResults: Math.min(Math.max(Number(args.maxResults) || 20, 1), 30),
          startTime: Date.now() - 7 * 86400000,
        });
        return toToolText(
          hits.map((h) => ({
            title: h.title,
            url: h.url,
            visitCount: h.visitCount,
            lastVisitTime: h.lastVisitTime,
          })),
        );
      },
    },
    {
      name: "remember",
      description: "把短笔记存到本机扩展存储，之后可用 recall 读回。不要存密钥。",
      parameters: obj(
        {
          key: { type: "string", description: "笔记键" },
          value: { type: "string", description: "笔记内容" },
        },
        ["key", "value"],
      ),
      async execute(args) {
        const key = String(args.key || "").trim().slice(0, 80);
        if (!key) return "key 不能为空。";
        const notes = await loadNotes();
        notes[key] = String(args.value || "").slice(0, 4000);
        await chrome.storage.local.set({ [NOTES_KEY]: notes });
        return `已记住 ${key}。`;
      },
    },
    {
      name: "recall",
      description: "读取 remember 存下的笔记。不传 key 则列出全部键。",
      parameters: obj({ key: { type: "string", description: "笔记键；省略则列出键名" } }),
      async execute(args) {
        const notes = await loadNotes();
        const key = String(args.key || "").trim();
        if (!key) return toToolText({ keys: Object.keys(notes) });
        if (!(key in notes)) return `没有叫 ${key} 的笔记。`;
        return String(notes[key]);
      },
    },
    {
      name: "clipboard_write",
      description: "把文本写入系统剪贴板。",
      parameters: obj({ text: { type: "string", description: "要复制的文本" } }, ["text"]),
      async execute(args) {
        const text = String(args.text || "");
        if (!text) return "没有可复制的文本。";
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          return `已复制 ${text.length} 字。`;
        }
        return "当前环境无法写剪贴板。";
      },
    },
    {
      name: "notify",
      description: "弹出一条系统通知。",
      parameters: obj(
        {
          title: { type: "string" },
          message: { type: "string", description: "通知正文" },
        },
        ["message"],
      ),
      async execute(args) {
        if (!chrome.notifications?.create) return "当前未授权 notifications。";
        const id = await chrome.notifications.create({
          type: "basic",
          iconUrl: extensionUrl("icons/icon48.png"),
          title: String(args.title || "PageLens"),
          message: String(args.message || ""),
        });
        return `已通知（${id || "ok"}）。`;
      },
    },
    {
      name: "list_companion_extensions",
      description:
        "探测当前页能否调用已安装的 Automa / COSE。Chrome 不允许扩展互调，只有这两个在页面上暴露了公开接口。",
      parameters: obj({ tabId: tabIdProp() }),
      async execute(args) {
        const tabId = await resolveTabId(ctx, args);
        let probe = { automa: false, cose: false };
        try {
          probe = (await injectMain(tabId, probeCompanions)) || probe;
        } catch (err) {
          return toToolText({ ok: false, error: err?.message || String(err), companions: COMPANIONS });
        }
        return toToolText({
          automa: { installedOnPage: Boolean(probe.automa), tools: ["automa_execute"] },
          cose: { installedOnPage: Boolean(probe.cose), tools: ["cose_accounts", "cose_publish"] },
          note: "未列出的已装扩展没有对外接口，PageLens 调不到。",
        });
      },
    },
    {
      name: "automa_execute",
      description:
        "在当前页触发 Automa 工作流。需要 Automa 已注入本页，并提供工作流 id 或 publicId（Automa 工作流设置里复制）。",
      parameters: obj({
        tabId: tabIdProp(),
        id: { type: "string", description: "Automa 本地工作流 id" },
        publicId: { type: "string", description: "公开 ID，优先于 id" },
        data: { type: "object", additionalProperties: true, description: "传给工作流的变量，可选" },
      }),
      async execute(args) {
        const tabId = await resolveTabId(ctx, args);
        const detail = {
          id: args.id || undefined,
          publicId: args.publicId || undefined,
          data: args.data && typeof args.data === "object" ? args.data : {},
        };
        return toToolText(await injectMain(tabId, automaExecute, [detail]));
      },
    },
    {
      name: "cose_accounts",
      description: "读取 COSE 各平台登录状态。用于多平台文章同步前确认账号。",
      parameters: obj({ tabId: tabIdProp() }),
      async execute(args) {
        const tabId = await resolveTabId(ctx, args);
        return toToolText(await injectMain(tabId, coseGetAccounts));
      },
    },
    {
      name: "cose_publish",
      description:
        "用 COSE 把一篇 Markdown 同步到指定平台草稿。只在用户明确要求「发到掘金/知乎/公众号」等时调用。platforms 用平台 id，如 zhihu、juejin、wechat、csdn。",
      parameters: obj(
        {
          tabId: tabIdProp(),
          title: { type: "string" },
          markdown: { type: "string", description: "正文 Markdown" },
          platforms: {
            type: "array",
            items: { type: "string" },
            description: "平台 id 列表",
          },
          desc: { type: "string", description: "摘要，可选" },
        },
        ["title", "markdown", "platforms"],
      ),
      async execute(args) {
        const tabId = await resolveTabId(ctx, args);
        return toToolText(
          await injectMain(tabId, cosePublish, [
            {
              title: args.title,
              markdown: args.markdown,
              platforms: args.platforms,
              desc: args.desc,
            },
          ]),
        );
      },
    },
    {
      name: "load_skill",
      description: "加载一个 skill 的完整说明并遵循它完成本轮任务。",
      parameters: obj({ id: { type: "string", description: "skill id 或中文名" } }, ["id"]),
      async execute(args) {
        const skill = findSkill(ctx.skills || [], args.id);
        if (!skill) {
          const names = (ctx.skills || []).map((s) => s.id).join(", ");
          return `未找到 skill ${args.id}。可用：${names || "无"}`;
        }
        return `【skill:${skill.id} ${skill.name}】\n${skill.body}`;
      },
    },
    {
      name: "chrome_call",
      description:
        "调用扩展已授权的 Chrome API（白名单）。高层工具够用时不要用这个。args 与官方签名一致，例如 tabs.query 传 [{currentWindow:true}]。不能调用 cookies/debugger/downloads/storage/scripting。",
      parameters: obj(
        {
          method: {
            type: "string",
            enum: CHROME_CALL_ALLOW,
            description: "如 tabs.query、bookmarks.getTree、history.search、tts.speak",
          },
          args: {
            type: "array",
            description: "Chrome API 参数列表",
            items: {},
          },
        },
        ["method"],
      ),
      async execute(args) {
        const result = await chromeCall(args.method, args.args || []);
        return toToolText(result);
      },
    },
  ];
}

/** @deprecated 用 createAgentTools */
export const createPageTools = createAgentTools;

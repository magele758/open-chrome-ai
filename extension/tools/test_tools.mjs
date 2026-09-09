import { createAgentLoop } from "../lib/agent/loop.js";
import { createAgentTools, createPageTools } from "../lib/agent/tools.js";
import {
  CHROME_CALL_ALLOW,
  chromeCall,
  isHttpUrl,
  jsonSafe,
  restrictedUrl,
  compactTab,
} from "../lib/chrome.js";
import { runJs } from "../lib/agent/page-fns.js";

const notes = {};
const tabs = [
  {
    id: 1,
    windowId: 10,
    title: "Alpha",
    url: "https://a.example/post",
    active: true,
    pinned: false,
    audible: false,
    discarded: false,
    groupId: -1,
    favIconUrl: "data:image/png;base64,xxxx",
  },
  {
    id: 2,
    windowId: 10,
    title: "Beta",
    url: "https://b.example/",
    active: false,
    pinned: true,
    groupId: -1,
  },
];

globalThis.chrome = {
  tabs: {
    query: async (q = {}) => {
      let rows = tabs;
      if (q.currentWindow) rows = tabs.filter((t) => t.windowId === 10);
      if (q.active) rows = rows.filter((t) => t.active);
      return rows;
    },
    get: async (id) => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) throw new Error("No tab " + id);
      return tab;
    },
    create: async (opts) => ({
      id: 3,
      windowId: 10,
      title: "New",
      url: opts.url,
      active: Boolean(opts.active),
      pinned: false,
      groupId: -1,
    }),
    update: async (id, opts) => {
      const tab = tabs.find((t) => t.id === id) || tabs[0];
      return { ...tab, ...opts, id };
    },
    remove: async () => {},
    reload: async () => {},
    captureVisibleTab: async () => "data:image/jpeg;base64,xx",
    group: async ({ groupId }) => (groupId == null ? 42 : groupId),
  },
  tabGroups: {
    get: async (id) => ({ id, title: "PL", color: "orange" }),
    update: async () => ({}),
  },
  windows: { update: async () => ({}) },
  scripting: {
    executeScript: async ({ func, args = [] }) => {
      if (func.name === "extractPage") {
        return [{ result: { title: "Alpha", url: "https://a.example/post", text: "正文一段", kind: "generic" } }];
      }
      if (func.name === "getPageInfo") {
        return [{ result: { title: "Alpha", url: "https://a.example/post", headings: [], links: 4, images: 1, video: null } }];
      }
      if (func.name === "getSelectionText") return [{ result: "选中的字" }];
      if (func.name === "getLinks") return [{ result: [{ text: "Home", href: "https://a.example/" }] }];
      if (func.name === "findInPage") return [{ result: { query: args[0], count: 1, hits: [{ snippet: "…正文一段…" }] } }];
      if (func.name === "queryDom") return [{ result: [{ i: 0, tag: "h1", text: "Alpha" }] }];
      if (func.name === "scrollPage") return [{ result: { ok: true, via: "percent" } }];
      if (func.name === "listControls") return [{ result: [{ i: 0, tag: "button", text: "搜索", selector: "button" }] }];
      if (func.name === "pageAct") return [{ result: { ok: true, action: args[0] } }];
      if (func.name === "highlightQuote") return [{ result: true }];
      if (func.name === "seekVideo") return [{ result: true }];
      if (func.name === "readTextTracks") return [{ result: { status: "missing" } }];
      if (func.name === "runJs") return [{ result: { ok: true, result: "ok" } }];
      if (func.name === "probeCompanions") return [{ result: { automa: true, cose: false } }];
      if (func.name === "automaExecute") return [{ result: { ok: true, dispatched: true, id: "w1" } }];
      if (func.name === "coseGetAccounts") return [{ result: { ok: true, platforms: [] } }];
      if (func.name === "cosePublish") return [{ result: { ok: true, platforms: ["zhihu"] } }];
      return [{ result: null }];
    },
  },
  bookmarks: {
    search: async () => [{ id: "b1", title: "MDN", url: "https://developer.mozilla.org/" }],
    get: async (id) => [{ id: String(id), title: "书签栏" }],
    getTree: async () => [{ id: "0", children: [{ id: "1", title: "书签栏" }] }],
    create: async (n) => ({ id: n.url ? "b-" + n.url.slice(-4) : "folder-1", parentId: n.parentId || "1", ...n }),
  },
  history: {
    search: async () => [
      { title: "Alpha", url: "https://a.example/post", visitCount: 3, lastVisitTime: Date.now() },
    ],
  },
  notifications: { create: async () => "nid" },
  storage: {
    local: {
      get: async (key) => (typeof key === "string" ? { [key]: notes[key] } : { ...notes }),
      set: async (obj) => Object.assign(notes, obj),
    },
  },
  runtime: {
    getPlatformInfo: async () => ({ os: "mac", arch: "arm" }),
    getURL: (p) => "chrome-extension://x/" + p,
  },
  i18n: { getUILanguage: () => "zh-CN", getAcceptLanguages: async () => ["zh-CN"] },
  tts: { speak: () => {}, stop: () => {}, getVoices: async () => [] },
  commands: { getAll: async () => [] },
  action: {
    setBadgeText: async () => {},
    getBadgeText: async () => "",
    getTitle: async () => "PageLens",
  },
};

const ctx = {
  getTabId: () => 1,
  getWindowId: () => 10,
  refreshPack: async () => ({
    title: "Alpha",
    url: "https://a.example/post",
    text: "正文一段",
    kind: "generic",
  }),
  capture: async () => "data:image/jpeg;base64,xx",
  setImage: () => {},
  getTaskGroupId: () => 42,
  setTaskGroupId: () => {},
  getTaskGroupTitle: () => "PL · 测试",
  skills: [{ id: "summarize", name: "总结此页", body: "总结当前页。" }],
};

const tools = createAgentTools(ctx);
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const names = tools.map((t) => t.name);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(createPageTools === createAgentTools, "alias");
assert(new Set(names).size === names.length, "duplicate tool names: " + names);
assert(new Set(CHROME_CALL_ALLOW).size === CHROME_CALL_ALLOW.length, "duplicate chrome_call methods");
assert(names.length >= 20, "too few tools: " + names.length);
for (const t of tools) {
  assert(t.name && t.description && t.parameters?.type === "object" && typeof t.execute === "function", t.name);
}

assert(restrictedUrl("chrome://extensions"), "chrome url");
assert(restrictedUrl("file:///tmp/x"), "file url");
assert(!restrictedUrl("https://example.com/a"), "https ok");
assert(isHttpUrl("https://x.com"), "http url");
assert(!isHttpUrl("javascript:alert(1)"), "js url");

const scrubbed = jsonSafe({ favIconUrl: "data:xx", title: "A", nested: { favIconUrl: "y", n: 1 } });
assert(scrubbed.favIconUrl === undefined, "drop favIconUrl");
assert(scrubbed.nested.n === 1, "keep nested");

const compact = compactTab(tabs[0]);
assert(compact.id === 1 && compact.favIconUrl === undefined, "compact tab");

const denied = await chromeCall("cookies.getAll", [{ domain: "x.com" }]);
assert(denied.ok === false && /不允许/.test(denied.error), "deny cookies");

const listed = await chromeCall("tabs.query", [{ currentWindow: true }]);
assert(listed.ok && listed.result.length === 2, "tabs.query");

const badNav = await chromeCall("tabs.create", [{ url: "javascript:alert(1)" }]);
assert(badNav.ok === false, "deny javascript url");

const hist = await chromeCall("history.search", [{ text: "", maxResults: 99 }]);
assert(hist.ok, "history.search");

const js = await runJs("return 1+1");
assert(js.ok && js.result === 2, "runJs return");
const jsExpr = await runJs("3*3");
assert(jsExpr.ok && jsExpr.result === 9, "runJs expr");
assert((await runJs("")).ok === false, "runJs empty");

const extracted = await byName.extract_page.execute({});
assert(/正文一段/.test(extracted), "extract_page");

tabs.push({
  id: 9,
  windowId: 10,
  title: "Settings",
  url: "chrome://settings",
  active: false,
  pinned: false,
  groupId: -1,
});
let deniedInject = false;
try {
  await byName.get_page_info.execute({ tabId: 9 });
} catch (err) {
  deniedInject = /受限/.test(err.message || "");
}
assert(deniedInject, "inject blocked on chrome://");

const info = await byName.get_page_info.execute({});
assert(/Alpha/.test(info), "get_page_info");

const listedTabs = JSON.parse(await byName.list_tabs.execute({}));
assert(listedTabs.count === 2, "list_tabs");

const clicked = JSON.parse(await byName.click.execute({ text: "搜索" }));
assert(clicked.ok && clicked.action === "click", "click");
const filled = JSON.parse(await byName.fill.execute({ selector: "input", value: "hi" }));
assert(filled.ok && filled.action === "fill", "fill");

const folder = JSON.parse(await byName.create_bookmark_folder.execute({ title: "今天研究" }));
assert(folder.title === "今天研究" && folder.id, "create folder");
const batched = JSON.parse(await byName.bookmark_open_tabs.execute({ title: "这批标签" }));
assert(batched.folder.title === "这批标签" && batched.added === 2, "bookmark open tabs");
assert(batched.bookmarks.every((b) => b.url.startsWith("https://")), "only http(s)");

const opened = JSON.parse(await byName.open_tab.execute({ url: "https://c.example/" }));
assert(opened.opened.id === 3, "open_tab");
assert(opened.groupId === 42, "open_tab grouped");

const blockedOpen = await byName.open_tab.execute({ url: "chrome://settings" });
assert(/http/.test(blockedOpen), "open_tab block");

await byName.remember.execute({ key: "k1", value: "v1" });
assert((await byName.recall.execute({ key: "k1" })) === "v1", "remember/recall");
const keys = JSON.parse(await byName.recall.execute({}));
assert(keys.keys.includes("k1"), "recall keys");

const skill = await byName.load_skill.execute({ id: "summarize" });
assert(/总结当前页/.test(skill), "load_skill");

const call = JSON.parse(await byName.chrome_call.execute({ method: "tabs.query", args: [{}] }));
assert(call.ok === true, "chrome_call tabs.query");

const loop = createAgentLoop({
  maxTurns: 4,
  systemPrompt: "test",
  tools: [
    {
      name: "list_tabs",
      description: "list",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ count: 1, tabs: [{ id: 1 }] }),
    },
  ],
  model: {
    async runTurn({ messages }) {
      const last = messages[messages.length - 1];
      if (last.role === "tool") {
        return { content: `FINAL:${last.content}`, toolCalls: [], finishReason: "stop" };
      }
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "c1", name: "list_tabs", arguments: "{}" }],
      };
    },
  },
});
const out = await loop.run("有哪些标签");
assert(out.reason === "stop" && /FINAL:\{"count":1/.test(out.text), "loop json tool result");

console.log("PASS", names.length, "tools:", names.join(", "));

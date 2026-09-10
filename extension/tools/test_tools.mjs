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
      if (func.name === "plVideo") {
        const cmd = args[0];
        if (cmd === "state") return [{ result: { ok: true, currentTime: 1, duration: 10, paused: false, ended: false, count: 1 } }];
        if (cmd === "control") return [{ result: { ok: true, paused: false } }];
        if (cmd === "seek") return [{ result: { ok: true } }];
        if (cmd === "tracks") return [{ result: { status: "missing" } }];
        if (cmd === "pick" || cmd === "list") return [{ result: { ok: true, videos: [], count: 0 } }];
        return [{ result: { ok: true } }];
      }
      if (func.name === "readTextTracks") return [{ result: { status: "missing" } }];
      if (func.name === "readVideoState") return [{ result: { ok: true, currentTime: 1, duration: 10, paused: false, ended: false } }];
      if (func.name === "controlVideo") return [{ result: { ok: true, paused: false } }];
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
    id: "abcdefghijklmnopqrstuvwxyzabcdef",
    getPlatformInfo: async () => ({ os: "mac", arch: "arm" }),
    getURL: (p) => "chrome-extension://x/" + p,
    sendMessage: async () => ({ ok: false, error: "test-no-audio" }),
    sendNativeMessage: async (name, msg) => {
      if (name !== "com.pagelens.host") throw new Error("Specified native messaging host not found.");
      if (msg?.op === "ping") return { ok: true, op: "ping", name, version: "1.0.0" };
      if (msg?.op === "exec") {
        return {
          ok: true,
          op: "exec",
          code: 0,
          stdout: "hi\n",
          stderr: "",
          timedOut: false,
          ms: 1,
          cwd: "/tmp",
        };
      }
      return { ok: false, error: "unknown op" };
    },
  },
  tabCapture: { getMediaStreamId: async () => "sid" },
  offscreen: {
    createDocument: async () => {},
    closeDocument: async () => {},
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
const noSkill = createAgentTools({ ...ctx, enableSkills: false }).map((t) => t.name);
assert(!noSkill.includes("load_skill") && noSkill.includes("extract_page"), "skills off");
const offBySetting = createAgentTools({ ...ctx, enableSkills: true, settings: { skillsEnabled: false } }).map((t) => t.name);
assert(!offBySetting.includes("load_skill"), "skills setting off");

assert(names.includes("run_shell"), "has run_shell");
const sh = await byName.run_shell.execute({ command: "echo hi" });
assert(/exit 0/.test(sh) && /hi/.test(sh), "run_shell exec: " + sh);
ctx.nativeShell = false;
const shOff = await byName.run_shell.execute({ command: "echo hi" });
assert(/关闭/.test(shOff), "run_shell disabled: " + shOff);
ctx.nativeShell = undefined;
const savedNative = chrome.runtime.sendNativeMessage;
chrome.runtime.sendNativeMessage = async () => {
  throw new Error("Specified native messaging host not found.");
};
const shMiss = await byName.run_shell.execute({ command: "echo hi" });
chrome.runtime.sendNativeMessage = savedNative;
assert(/未安装 Native Host/.test(shMiss), "run_shell missing host: " + shMiss);

assert(names.includes("transcribe_video"), "has transcribe_video");
assert(names.includes("tts_speak"), "has tts_speak");
assert(names.includes("capture_voice_ref"), "has capture_voice_ref");
const noTts = await byName.tts_speak.execute({ text: "hi" });
assert(/未配置配音/.test(noTts), "tts optional: " + noTts);
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new TypeError("offline"); };
const noMedia = await byName.transcribe_video.execute({});
globalThis.fetch = savedFetch;
assert(/完整媒体服务未启动/.test(noMedia), "transcribe_video requires full media, no recording fallback: " + noMedia);
const caps = await byName.get_captions.execute({});
assert(/字幕不可用|transcribe_video/.test(caps), "get_captions missing: " + caps);

assert(names.includes("list_library") && names.includes("save_video_doc") && names.includes("save_session_note"), "library tools");
const noNote = await byName.save_session_note.execute({});
assert(/没有可保存的对话|无法入库|文稿文件夹/.test(noNote), "save_session_note needs session or folder: " + noNote);
const libInfo = JSON.parse(await byName.library_info.execute({}));
assert(libInfo.configured === false, "library empty in tests");
const libList = await byName.list_library.execute({});
assert(/文稿文件夹/.test(libList), "list_library needs folder: " + libList);
const libWrite = await byName.write_library.execute({ path: "x.md", text: "hi" });
assert(/无法写入|文稿文件夹/.test(libWrite), "write_library needs folder");

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

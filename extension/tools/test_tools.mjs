import "./fixtures/web-locks.mjs";
import { createAgentLoop } from "../lib/agent/loop.js";
import { checkHitlRequirement, createAgentTools, createPageTools, createTaskTabGroups, resolveHitlTargetUrl } from "../lib/agent/tools.js";
import { resetPermissionPrompter, setPermissionPrompter } from "../lib/optional-permissions.js";
import {
  CHROME_CALL_ALLOW,
  chromeCall,
  isHttpUrl,
  jsonSafe,
  restrictedUrl,
  compactTab,
  captureTab,
} from "../lib/chrome.js";
import { runJs } from "../lib/agent/page-fns.js";

const notes = {};
const groupCalls = [];
let nextTabId = 10;
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
      if (q.groupId != null) rows = rows.filter((t) => t.groupId === q.groupId);
      return rows;
    },
    get: async (id) => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) throw new Error("No tab " + id);
      return tab;
    },
    create: async (opts) => {
      const tab = {
        id: nextTabId++,
        windowId: 10,
        title: "New",
        url: opts.url,
        active: Boolean(opts.active),
        pinned: false,
        groupId: -1,
      };
      tabs.push(tab);
      return tab;
    },
    update: async (id, opts) => {
      const tab = tabs.find((t) => t.id === id) || tabs[0];
      return { ...tab, ...opts, id };
    },
    onUpdated: {
      addListener() {},
      removeListener() {},
    },
    remove: async (ids) => {
      for (const id of ids) tabs.splice(tabs.findIndex((tab) => tab.id === id), 1);
    },
    reload: async () => {},
    captureVisibleTab: async () => "data:image/jpeg;base64,xx",
    group: async ({ tabIds, groupId }) => {
      groupCalls.push({ tabIds, groupId });
      const id = groupId ?? 42;
      for (const tab of tabs.filter((tab) => tabIds.includes(tab.id))) tab.groupId = id;
      return id;
    },
    ungroup: async (tabIds) => {
      for (const tab of tabs.filter((tab) => tabIds.includes(tab.id))) tab.groupId = -1;
    },
  },
  tabGroups: {
    get: async (id) => ({ id, windowId: 10, title: "PL", color: "orange" }),
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
        if (cmd === "pick" || cmd === "list") return [{ result: { ok: true, videos: [], count: 0 } }];
        return [{ result: { ok: true } }];
      }
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
      if (msg?.op === "fs") {
        const target = String(msg.root || msg.path || "");
        if (msg.scope === "agent" && (target === "/" || target === "/Users" || /\/\.ssh(\/|$)/.test(target))) {
          return { ok: false, error: "已拦截：只能访问家目录、下载/桌面/文档、临时目录、字幕缓存或 ~/.agent-reach。" };
        }
        if (msg.action === "readdir") {
          return {
            ok: true,
            action: "readdir",
            folder: "Downloads",
            abs: "/tmp/Downloads",
            count: 1,
            entries: [{ name: "a.md", kind: "file", path: "a.md" }],
          };
        }
        if (msg.action === "readText") {
          return { ok: true, text: "file body", bytes: 9, path: "a.md", abs: "/tmp/Downloads/a.md" };
        }
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

Object.defineProperty(globalThis.navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: async () => {},
    readText: async () => "https://clip.example/x",
  },
});

const taskTabGroups = createTaskTabGroups({ getWindowId: () => 10, getTitle: () => "PL · 测试" });
const ctx = {
  getTabId: () => 1,
  getWindowId: () => 10,
  refreshPack: async () => ({
    title: "Alpha",
    url: "https://a.example/post",
    text: "正文一段",
    kind: "generic",
  }),
  capture: async (id) => captureTab(id, 10),
  setImage: () => {},
  taskTabGroups,
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
assert(restrictedUrl("chrome-search://local-ntp/local-ntp.html"), "chrome-search url");
assert(restrictedUrl("chrome-untrusted://new-tab-page/"), "chrome-untrusted url");
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

const shotNormal = await byName.screenshot.execute({ tabId: 1 });
assert(/已截取当前画面/.test(shotNormal), "screenshot normal ok: " + shotNormal);

const shotBlocked = await byName.screenshot.execute({ tabId: 9 });
assert(/受限|截图失败/.test(shotBlocked), "screenshot blocked on restricted tab: " + shotBlocked);

const shotAuto = await captureTab();
assert(shotAuto === "data:image/jpeg;base64,xx", "captureTab auto resolves active tab");

const origCapture = chrome.tabs.captureVisibleTab;
chrome.tabs.captureVisibleTab = async () => {
  throw new Error("Either the '' or 'activeTab' permission is required.");
};
let caughtPermission = "";
try {
  await captureTab(1);
} catch (e) {
  caughtPermission = e.message;
}
chrome.tabs.captureVisibleTab = origCapture;
assert(/系统安全策略保护/.test(caughtPermission), "captureTab translates activeTab error: " + caughtPermission);

const info = await byName.get_page_info.execute({});
assert(/Alpha/.test(info), "get_page_info");

const listedTabs = JSON.parse(await byName.list_tabs.execute({}));
assert(listedTabs.count === 2, "list_tabs");

const clicked = JSON.parse(await byName.click.execute({ text: "搜索" }));
assert(clicked.ok && clicked.action === "click", "click");
const filled = JSON.parse(await byName.fill.execute({ selector: "input", value: "hi" }));
assert(filled.ok && filled.action === "fill", "fill");
const navigated = JSON.parse(await byName.navigate_tab.execute({ url: "https://a.example/doc.pdf" }));
assert(navigated.navigated.url.endsWith("doc.pdf"), "navigate_tab still navigates the existing tab");
assert(navigated.groupId === null && groupCalls.length === 0, "read, click, fill and navigation preserve the current tab layout");

const folder = JSON.parse(await byName.create_bookmark_folder.execute({ title: "今天研究" }));
assert(folder.title === "今天研究" && folder.id, "create folder");
const batched = JSON.parse(await byName.bookmark_open_tabs.execute({ title: "这批标签" }));
assert(batched.folder.title === "这批标签" && batched.added === 2, "bookmark open tabs");
assert(batched.bookmarks.every((b) => b.url.startsWith("https://")), "only http(s)");

const opened = JSON.parse(await byName.open_tab.execute({ url: "https://c.example/source.pdf" }));
assert(opened.opened.url === "https://c.example/source.pdf", "open_tab");
assert(opened.groupId === null && groupCalls.length === 0, "opening an individual source does not create a task group");

const firstOptIn = JSON.parse(await byName.open_tab.execute({ url: "https://c.example/task/first", taskGroup: true }));
assert(firstOptIn.groupId === null && groupCalls.length === 0, "the first opt-in alone never creates a group");
const grouped = await Promise.all(["two", "three"].map(async (path) => JSON.parse(await byName.open_tab.execute({
  url: `https://c.example/task/${path}`,
  taskGroup: true,
}))));
assert(grouped.every((result) => result.groupId === 42 && result.opened.groupId === 42), "parallel opt-in opens share one group");
assert(groupCalls.length === 2 && groupCalls[0].groupId == null && groupCalls[1].groupId === 42, "the group is created once and reused");
assert(groupCalls[0].tabIds.length === 2 && groupCalls[0].tabIds.includes(firstOptIn.opened.id), "the first two tabs group together");
const another = JSON.parse(await byName.open_tab.execute({ url: "https://c.example/ordinary", taskGroup: false }));
assert(another.groupId === null && groupCalls.length === 2, "an existing task group does not absorb an ordinary open");
await byName.click.execute({ text: "搜索", tabId: 1 });
assert(tabs[0].groupId === -1 && groupCalls.length === 2, "operating an existing tab does not move it into an active task group");
const taskTabIds = [firstOptIn, ...grouped].map(({ opened }) => opened.id);
const movedByUser = await chrome.tabs.get(taskTabIds[2]);
movedByUser.groupId = 77;
tabs[1].groupId = 42; // The user added this existing tab to the temporary group.
const beforeCleanup = tabs.map(({ id }) => id).join(",");
await taskTabGroups.cleanup();
assert(tabs.map(({ id }) => id).join(",") === beforeCleanup, "cleanup keeps all tabs open");
assert((await chrome.tabs.get(taskTabIds[0])).groupId === -1 && (await chrome.tabs.get(taskTabIds[1])).groupId === -1, "cleanup detaches only the owned tabs still in the temporary group");
assert(movedByUser.groupId === 77 && tabs[1].groupId === 42, "cleanup preserves manually changed memberships");
assert(await taskTabGroups.add(movedByUser) === null, "cleanup blocks late attachments");
tabs[1].groupId = -1;
await chrome.tabs.remove([opened.opened.id, another.opened.id, ...taskTabIds]);

const interruptedGroups = createTaskTabGroups({ getWindowId: () => 10 });
const firstPending = await chrome.tabs.create({ url: "https://c.example/interrupted/first" });
const secondPending = await chrome.tabs.create({ url: "https://c.example/interrupted/second" });
assert(await interruptedGroups.add(firstPending) === null, "an incomplete batch remains ungrouped");
const groupEntered = Promise.withResolvers();
const groupAllowed = Promise.withResolvers();
const realGroup = chrome.tabs.group;
chrome.tabs.group = async (args) => {
  groupEntered.resolve();
  await groupAllowed.promise;
  return realGroup(args);
};
try {
  const grouping = interruptedGroups.add(secondPending);
  await Promise.race([
    groupEntered.promise,
    grouping.then(() => { throw new Error("test grouping did not reach Chrome"); }),
  ]);
  const cleanup = interruptedGroups.cleanup();
  groupAllowed.resolve();
  await Promise.all([grouping, cleanup]);
  assert(firstPending.groupId === -1 && secondPending.groupId === -1, "cleanup waits for the browser grouping call already in flight and then removes it");
} finally {
  chrome.tabs.group = realGroup;
  groupAllowed.resolve();
  await interruptedGroups.cleanup();
  await chrome.tabs.remove([firstPending.id, secondPending.id]);
}

const blockedOpen = await byName.open_tab.execute({ url: "chrome://settings" });
assert(/http/.test(blockedOpen), "open_tab block");

await byName.remember.execute({ key: "k1", value: "v1" });
assert((await byName.recall.execute({ key: "k1" })) === "v1", "remember/recall");
await Promise.all(["handoff-a", "handoff-b"].map(key => byName.remember.execute({ key, value: key })));
assert((await byName.recall.execute({ key: "handoff-a" })) === "handoff-a", "first simultaneous note retained");
assert((await byName.recall.execute({ key: "handoff-b" })) === "handoff-b", "second simultaneous note retained");
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
const shOpen = await byName.run_shell.execute({ command: "open /tmp" });
assert(/已拦截/.test(shOpen) && /open/.test(shOpen), "run_shell blocks open: " + shOpen);
const shFind = await byName.run_shell.execute({ command: "find /" });
assert(/已拦截/.test(shFind), "run_shell blocks unbounded find: " + shFind);
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

const pages = JSON.parse(await byName.extract_pages.execute({}));
assert(pages.count === 2 && pages.pages[0].text, "extract_pages batch: " + JSON.stringify(pages).slice(0, 200));

const clip = await byName.clipboard_read.execute({});
assert(clip === "https://clip.example/x", "clipboard_read: " + clip);

const listedDir = JSON.parse(await byName.list_directory.execute({ path: "downloads" }));
assert(listedDir.count === 1 && listedDir.entries[0].name === "a.md", "list_directory alias");
const listedRoot = await byName.list_directory.execute({ path: "/" });
assert(/已拦截/.test(listedRoot), "list_directory blocks /");
const readMd = await byName.read_file.execute({ path: "~/Downloads/a.md" });
assert(/file body/.test(readMd), "read_file: " + readMd);
const readBin = await byName.read_file.execute({ path: "~/Downloads/secret.pem" });
assert(/已拦截/.test(readBin), "read_file blocks pem");

const navWait = JSON.parse(await byName.wait_for_navigation.execute({ timeoutMs: 300, urlChange: true }));
assert(navWait.ok && navWait.timedOut === true, "wait_for_navigation timeout: " + JSON.stringify(navWait));
const origOnUpdated = chrome.tabs.onUpdated;
chrome.tabs.onUpdated = {
  addListener(fn) {
    queueMicrotask(() => fn(1, { status: "complete" }, { id: 1, title: "Next", url: "https://a.example/next", status: "complete" }));
  },
  removeListener() {},
};
const navOk = JSON.parse(await byName.wait_for_navigation.execute({}));
chrome.tabs.onUpdated = origOnUpdated;
assert(navOk.changed && navOk.url.includes("/next"), "wait_for_navigation url change: " + JSON.stringify(navOk));

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

chrome.sessions = {
  getRecentlyClosed: async () => [
    { tab: { sessionId: "s-pay", windowId: 10, url: "https://shop.example/checkout?cart=1" } },
    { tab: { sessionId: "s-home", windowId: 10, url: "https://a.example/old" } },
    { tab: { sessionId: "s-other", windowId: 10, url: "https://other.example/page" } },
  ],
  restore: async () => {
    throw new Error("window task must not call sessions.restore");
  },
};
const payArgs = { sessionId: "s-pay" };
assert((await resolveHitlTargetUrl("restore_closed_tab", payArgs, {})) === "https://shop.example/checkout?cart=1", "resolve closed checkout url");
assert(payArgs.url === "https://shop.example/checkout?cart=1", "closed url is visible to trust");
const checkout = checkHitlRequirement({
  toolName: "restore_closed_tab",
  args: payArgs,
  userUrl: "https://a.example/post",
  hitlMode: "autonomous",
});
assert(checkout.needsConfirmation === true, "checkout restore still confirms in autonomous mode");
assert(checkout.irreversible?.id === "checkout_pay", "checkout restore hits the pay list");
const homeArgs = { sessionId: "s-home" };
assert((await resolveHitlTargetUrl("restore_closed_tab", homeArgs, {})) === "https://a.example/old", "resolve same-origin closed url");
assert(
  checkHitlRequirement({
    toolName: "restore_closed_tab",
    args: homeArgs,
    userUrl: "https://a.example/post",
    hitlMode: "balanced",
  }).needsConfirmation === false,
  "same-origin restore does not ask again",
);
const cross = checkHitlRequirement({
  toolName: "restore_closed_tab",
  args: { url: "https://other.example/page" },
  userUrl: "https://a.example/post",
  hitlMode: "balanced",
});
assert(cross.needsConfirmation === true, "cross-origin restore confirms like open_tab: " + cross.reason);
assert(/跨源/.test(cross.reason), "cross-origin reason");

const tabCreates = [];
const savedCreate = chrome.tabs.create;
chrome.tabs.create = async (opts) => {
  tabCreates.push(opts);
  return savedCreate(opts);
};
chrome.permissions = {
  contains: async (query) => !query?.origins?.some((origin) => String(origin).includes("shop.example")),
  request: async () => false,
};
const blockedArgs = { sessionId: "s-pay" };
assert(
  (await resolveHitlTargetUrl("restore_closed_tab", blockedArgs, {})) === "https://shop.example/checkout?cart=1",
  "trust sees the closed checkout url before execute",
);
const blocked = await byName.restore_closed_tab.execute(blockedArgs);
assert(/未授予权限/.test(blocked), "host permission blocks restore: " + blocked);
assert(blockedArgs.url === "https://shop.example/checkout?cart=1", "execute exposes the closed url");
assert(tabCreates.length === 0, "denied host permission does not open a tab");
chrome.permissions.contains = async () => true;
const reopenArgs = { sessionId: "s-home" };
assert(
  (await resolveHitlTargetUrl("restore_closed_tab", reopenArgs, {})) === "https://a.example/old",
  "trust sees the same-origin closed url before reopen",
);
const reopened = JSON.parse(await byName.restore_closed_tab.execute(reopenArgs));
assert(reopened.mode === "reopened_url" && reopened.tab.url === "https://a.example/old", "window restore reopens the url");
assert(tabCreates.at(-1).windowId === 10 && tabCreates.at(-1).url === "https://a.example/old" && tabCreates.at(-1).active === false, "reopen stays in the task window");
chrome.sessions.restore = async (id) => ({ tab: { id: 77, title: "T", url: "https://a.example/old" }, id });
const legacyTools = createAgentTools({ getTabId: () => 1, settings: { cdpInput: false } });
const legacyArgs = { sessionId: "s-home" };
assert(
  (await resolveHitlTargetUrl("restore_closed_tab", legacyArgs, {})) === "https://a.example/old",
  "trust confirms the url before sessions.restore",
);
const legacy = JSON.parse(await legacyTools.find((tool) => tool.name === "restore_closed_tab").execute(legacyArgs));
assert(legacy.tab.id === 77, "no-window path still uses sessions.restore");
assert(tabCreates.length === 1, "sessions.restore does not call tabs.create");

// 第一次 sessions 查询抛错，参数里夹着同源假网址；授权后第二次才返回结账页。
resetPermissionPrompter();
let sessionsGranted = false;
let closedReads = 0;
const checkoutUrl = "https://shop.example/checkout?cart=1";
const fakeUrl = "https://a.example/old";
chrome.sessions.getRecentlyClosed = async () => {
  closedReads += 1;
  if (closedReads === 1) throw new Error("The 'sessions' permission has not been granted.");
  return [{ tab: { sessionId: "s-pay", windowId: 10, url: checkoutUrl } }];
};
chrome.permissions.contains = async (query) => {
  if (query?.permissions?.includes("sessions")) return sessionsGranted;
  return true;
};
chrome.permissions.request = async (query) => {
  if (query?.permissions?.includes("sessions")) {
    sessionsGranted = true;
    return true;
  }
  return true;
};
setPermissionPrompter(async (info) => info.confirm());
const sneakArgs = { sessionId: "s-pay", url: fakeUrl };
const resolved = await resolveHitlTargetUrl("restore_closed_tab", sneakArgs, {});
assert(resolved !== fakeUrl, "resolve must not return the caller url");
assert(resolved === checkoutUrl, "retry before trust returns the closed checkout url");
assert(sneakArgs.url === checkoutUrl, "trust writes the closed url, not the caller url");
assert(closedReads === 2, "sessions is queried again after the permission grant");
const unseenArgs = { sessionId: "s-pay", url: fakeUrl };
const createdBefore = tabCreates.length;
const unseen = await byName.restore_closed_tab.execute(unseenArgs);
assert(typeof unseen === "string", "untrusted restore does not open a tab");
assert(
  !tabCreates.slice(createdBefore).some((tab) => tab.url === checkoutUrl),
  "execute does not open a checkout url the trust phase did not see",
);
assert(unseenArgs.url === fakeUrl, "execute does not adopt a checkout url trust did not write");
resetPermissionPrompter();
chrome.tabs.create = savedCreate;

console.log("PASS", names.length, "tools:", names.join(", "));

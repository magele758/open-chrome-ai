import "./fixtures/web-locks.mjs";
import assert from "node:assert/strict";
import { withWindowTask } from "../lib/window-scope.js";
import { createAgentTools } from "../lib/agent/tools.js";

const tabs = [
  { id: 1, windowId: 10, active: true, url: "https://a.example/", groupId: -1 },
  { id: 2, windowId: 20, active: true, url: "https://b.example/", groupId: 7 },
];
const queries = [];
const mutations = [];
globalThis.chrome = {
  permissions: { contains: async () => true, request: async () => true },
  tabs: {
    async query(query) {
      queries.push(query);
      return tabs.filter((t) => (query.windowId == null || t.windowId === query.windowId) &&
        (query.groupId == null || t.groupId === query.groupId));
    },
    async get(id) {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) throw new Error("tab closed");
      return tab;
    },
    async create(props) {
      const tab = { ...props, id: tabs.length + 1 };
      tabs.push(tab);
      return tab;
    },
    async update(id, props) {
      mutations.push(["update", id]);
      return Object.assign(await this.get(id), props);
    },
    async remove(ids) { mutations.push(["remove", ids]); },
    async move(ids, props) { mutations.push(["move", ids, props]); },
    async group(props) { mutations.push(["group", props]); return 8; },
  },
  tabGroups: { get: async () => ({ windowId: 20 }), update: async () => {} },
  windows: {
    WINDOW_ID_CURRENT: -2,
    update: () => assert.fail("task took window focus"),
    get: async (id) => ({ id, type: "normal", incognito: false }),
    getCurrent: async () => ({ id: 1, type: "normal", incognito: false }),
  },
  search: { async query(props) { mutations.push(["search", props]); } },
};
const tools = createAgentTools({
  getWindowId: () => 10, getTabId: () => 1, getTaskGroupId: () => 7,
  settings: { cdpInput: false },
});
const run = (name, args = {}) => tools.find((t) => t.name === name).execute(args);
const raw = async (method, ...args) => JSON.parse(await run("chrome_call", { method, args }));

assert.deepEqual(JSON.parse(await run("list_tabs", { currentWindow: false })).tabs.map(t => t.id), [1]);
assert.deepEqual(queries.at(-1), { windowId: 10 });
const { opened } = JSON.parse(await run("open_tab", { url: "https://a.example/new" }));
assert.equal(opened.windowId, 10);
assert.deepEqual(mutations, [], "ordinary open does not create a group");
await run("switch_tab", { tabId: opened.id });
assert.deepEqual(mutations.at(-1), ["update", opened.id]);
const search = JSON.parse(await run("web_search", { text: "new search" }));
assert.equal((await chrome.tabs.get(search.tabId)).windowId, 10);
assert.deepEqual(mutations.at(-1), ["search", { text: "new search", tabId: search.tabId }]);
await run("web_search", { text: "same tab", newTab: false });
assert.deepEqual(mutations.at(-1), ["search", { text: "same tab", tabId: 1 }]);

const mutationCount = mutations.length;
(await chrome.tabs.get(opened.id)).windowId = 20; // User dragged the tab while the model was thinking.
for (const name of ["close_tab", "switch_tab", "get_page_info", "click", "extract_page", "screenshot"]) {
  await assert.rejects(run(name, { tabId: opened.id }), /任务所属窗口/);
}
const batch = JSON.parse(await run("extract_pages", { tabIds: [opened.id] }));
assert.match(batch.pages[0].error, /任务所属窗口/);
assert.equal(batch.pages[0].url, undefined);
await run("close_task_group");
assert.deepEqual(queries.at(-1), { windowId: 10, groupId: 7 });
for (const [method, ...args] of [
  ["tabs.remove", [1, 2]], ["tabs.create", { windowId: 20 }], ["tabs.get", 2],
  ["tabs.move", 1, { windowId: 20, index: 0 }], ["tabs.group", { tabIds: [1], groupId: 7 }],
  ["tabs.update", 1, { openerTabId: 2 }], ["windows.update", 20, { focused: true }],
  ["webNavigation.getAllFrames", { tabId: 2 }],
]) assert.equal((await raw(method, ...args)).ok, false, method);
assert.equal(mutations.length, mutationCount);
assert.equal((await raw("tabs.move", 1, { windowId: -2, index: 0 })).ok, true);
assert.deepEqual(mutations.at(-1), ["move", 1, { windowId: 10, index: 0 }]);
assert.equal((await raw("tabs.query", { lastFocusedWindow: true })).ok, true);
assert.deepEqual(queries.at(-1), { windowId: 10 });
const createdWindows = [];
chrome.windows.create = async (props) => {
  createdWindows.push(props);
  return { id: 30 };
};
assert.deepEqual(JSON.parse(await run("create_window")), { windowId: 30 });
assert.deepEqual(createdWindows[0], { type: "normal", focused: false, incognito: false });
await run("create_window", { url: "https://a.example/", focused: true });
assert.deepEqual(createdWindows[1], { type: "normal", focused: true, url: "https://a.example/", incognito: false });
assert.match(await run("create_window", { url: "chrome://settings" }), /http/);
assert.equal((await raw("windows.create", { tabId: 2 })).ok, false);
assert.equal(createdWindows.length, 2);
chrome.windows.get = async (id) => ({ id, type: "normal", incognito: true });
await run("create_window");
assert.equal(createdWindows.at(-1).incognito, true, "new window copies the task window incognito flag");
const rejected = [];
chrome.windows.create = async (props) => {
  rejected.push(props);
  throw new Error("Incognito windows are disabled");
};
const failedWindow = await run("create_window", { url: "https://a.example/secret" });
assert.match(failedWindow, /无法创建窗口/);
assert.equal(rejected.length, 1);
assert.equal(rejected[0].incognito, true);
assert.equal(createdWindows.length, 3, "a failed incognito create does not fall back to a normal window");
chrome.windows.create = async (props) => {
  createdWindows.push(props);
  return { id: 30 };
};
chrome.windows.get = async (id) => ({ id, type: "normal", incognito: false });

const otherTools = createAgentTools({ getWindowId: () => 30, settings: { cdpInput: false } });
const otherOpen = otherTools.find(t => t.name === "open_tab");
const ready = Promise.withResolvers();
const release = Promise.withResolvers();
const firstTask = withWindowTask(10, async () => {
  ready.resolve();
  await release.promise;
  return JSON.parse(await run("open_tab", { url: "https://a.example/first" })).opened;
});
await ready.promise;
let second;
try {
  await assert.rejects(withWindowTask(10, () => assert.fail("ran two tasks in one window")), { code: "WINDOW_BUSY" });
  second = await withWindowTask(30, async () => JSON.parse(await otherOpen.execute({ url: "https://b.example/second" })).opened);
} finally {
  release.resolve();
}
assert.equal((await firstTask).windowId, 10);
assert.equal(second.windowId, 30);
await assert.rejects(withWindowTask(10, () => { throw new Error("cancelled run"); }), /cancelled run/);
assert.equal(await withWindowTask(10, () => "available"), "available");
console.log("PASS independent window creation, exclusive tasks and scoped tab operations");

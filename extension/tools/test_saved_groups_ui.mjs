import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const html = readFileSync(new URL("../sidepanel/index.html", import.meta.url), "utf8");
const dom = new JSDOM(html, { url: "https://extension.invalid/sidepanel/index.html" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Event = dom.window.Event;
globalThis.CustomEvent = dom.window.CustomEvent;
const $ = (id) => document.getElementById(id);
// jsdom does not implement the dialog top layer. Drive its real form and cancel controls.
const dialog = $("sg-dialog");
dialog.showModal = () => { dialog.open = true; };
dialog.close = (value = "") => {
  dialog.returnValue = value;
  dialog.open = false;
  dialog.dispatchEvent(new Event("close"));
};
// jsdom recognizes method=dialog but does not implement requestSubmit, so the
// accept click never closes the dialog. Mirror the platform close here.
// mirrorDialogClose false is the Chrome case that sets returnValue and closes
// without dispatching close. The test still preventDefault so jsdom does not navigate.
let mirrorDialogClose = true;
$("sg-dialog-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!mirrorDialogClose) {
    dialog.returnValue = event.submitter?.value || "";
    dialog.open = false;
    return;
  }
  dialog.close(event.submitter?.value || "");
});

async function until(test, reason) {
  const deadline = Date.now() + 6500;
  while (!test()) {
    assert.ok(Date.now() < deadline, reason);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}


const mem = {};
const storage = {
  get: async (k) => ({ [k]: structuredClone(mem[k]) }),
  set: async (obj) => Object.assign(mem, structuredClone(obj)),
};

const openGroups = new Map([
  [10, { id: 10, windowId: 1, title: "Open Group", color: "blue", collapsed: true }],
]);
const openTabs = new Map([
  [1, { id: 1, windowId: 1, title: "Open Tab", url: "https://open.example/1", groupId: 10, active: false }],
]);
const nativeStore = [
  { guid: "g-open", title: "Open Group", color: "blue", tabCount: 1, tabs: [{ guid: "t1", title: "Open Tab", url: "https://open.example/1" }] },
  { guid: "g-closed-1", title: "PageLens · MX 111", color: "green", tabCount: 1, tabs: [{ guid: "t2", title: "MX1", url: "https://mx.example/1" }] },
  { guid: "g-closed-2", title: "PageLens · MX 222", color: "green", tabCount: 1, tabs: [{ guid: "t3", title: "MX2", url: "https://mx.example/2" }] },
];

let axTrusted = false;
let listGate = null;
let diagnoseFailure = null;
let listFailure = "";
let deleteFailure = "";
let nativeOpenWindow = 1;

const tabOps = [];
let nextTabId = 20;
let nextGroupId = 30;
const nativeGuidByOpenId = new Map([[10, "g-open"]]);

const mockChrome = {
  permissions: { contains: async () => true, request: async () => true },
  storage: { local: storage },
  windows: {
    getCurrent: async () => ({ id: 1 }),
    update: async () => ({}),
  },
  tabs: {
    get: async (id) => ({ ...openTabs.get(id) }),
    query: async (q = {}) =>
      [...openTabs.values()].filter((t) => (q.windowId == null || t.windowId === q.windowId) && (q.groupId == null || t.groupId === q.groupId)),
    create: async (opts) => {
      const id = nextTabId++;
      const t = { id, windowId: opts.windowId ?? 1, title: opts.url.startsWith("data:") ? decodeURIComponent(opts.url).match(/<title>(.*?)<\/title>/i)?.[1] || opts.url : opts.url, url: opts.url, groupId: -1, active: Boolean(opts.active) };
      openTabs.set(id, t);
      return t;
    },
    update: async (id, patch) => Object.assign(openTabs.get(id), patch),
    group: async (opts) => {
      const gid = opts.groupId ?? nextGroupId++;
      const windowId = openTabs.get([].concat(opts.tabIds)[0]).windowId;
      if (!openGroups.has(gid)) openGroups.set(gid, { id: gid, windowId, title: "", color: "grey", collapsed: false });
      for (const id of [].concat(opts.tabIds)) openTabs.get(id).groupId = gid;
      return gid;
    },
    ungroup: async (rawIds) => {
      const ids = [].concat(rawIds);
      tabOps.push({ op: "ungroup", ids });
      for (const id of ids) {
        const t = openTabs.get(id);
        if (t) {
          const gid = t.groupId;
          t.groupId = -1;
          if (gid >= 0 && ![...openTabs.values()].some((x) => x.groupId === gid)) {
            openGroups.delete(gid);
            const i = nativeStore.findIndex((group) => group.guid === nativeGuidByOpenId.get(gid));
            if (i >= 0) nativeStore.splice(i, 1);
          }
        }
      }
    },
    remove: async (rawIds) => {
      const ids = [].concat(rawIds);
      tabOps.push({ op: "remove", ids });
      for (const id of ids) {
        const t = openTabs.get(id);
        if (t) {
          const gid = t.groupId;
          openTabs.delete(id);
          if (gid >= 0 && ![...openTabs.values()].some((x) => x.groupId === gid)) openGroups.delete(gid);
        }
      }
    },
  },
  tabGroups: {
    get: async (id) => ({ ...openGroups.get(id) }),
    query: async () => [...openGroups.values()].map((g) => ({ ...g })),
    update: async (id, props) => {
      const g = openGroups.get(id);
      Object.assign(g, props);
      const saved = nativeStore.find((row) => row.guid === nativeGuidByOpenId.get(id));
      if (saved && props.title !== undefined) saved.title = props.title;
      return { ...g };
    },
  },
};
globalThis.chrome = mockChrome;

const { saveTabGroupRecord } = await import("../lib/saved-tab-groups.js");
await saveTabGroupRecord(
  { title: "插件库收藏", color: "purple", tabs: [{ url: "https://pl.example/a", title: "A" }] },
  { storage, now: () => 1000 },
);

const nativeCalls = [];
const openedForDeletion = [];
const nativeCall = async (req) => {
  nativeCalls.push(req);
  if (req.action === "list" && listGate) await listGate;
  if (req.action === "list" && listFailure) throw new Error(listFailure);
  if (req.action === "list") return { ok: true, supportsBoundOpen: true, profile: "Default", groups: structuredClone(nativeStore) };
  if (req.action === "ax_status") return { ok: true, trusted: axTrusted, ...(!axTrusted ? { code: "ACCESSIBILITY_REQUIRED", hint: "请开启 Google Chrome 辅助功能" } : {}) };
  if (req.action === "request_accessibility") {
    axTrusted = true;
    return { ok: true, trusted: true, openedSettings: false };
  }
  if (req.action === "reveal_helper") {
    return { ok: true, helperName: "PageLens Helper", helperAppPath: "/Users/test/.pagelens/PageLens Helper.app" };
  }
  if (req.action === "open") {
    if (!axTrusted) return { ok: false, code: "ACCESSIBILITY_REQUIRED", error: "未授权辅助功能" };
    if (deleteFailure) return typeof deleteFailure === "string" ? { ok: false, code: "HELPER_LAUNCH_FAILED", error: deleteFailure } : deleteFailure;
    const saved = nativeStore.find((row) => row.guid === req.guid);
    assert.ok(saved, "panel opens the selected native GUID");
    assert.equal(req.profile, "Default");
    assert.ok([...openTabs.values()].some((tab) => tab.title === req.windowMarker && tab.windowId === nativeOpenWindow));
    const previous = openedForDeletion.at(-1);
    if (previous) assert.ok(!nativeStore.some((row) => row.guid === previous.guid), "next group opens after the previous GUID disappears");
    const tab = await mockChrome.tabs.create({ url: saved.tabs[0].url, windowId: nativeOpenWindow });
    const gid = await mockChrome.tabs.group({ tabIds: [tab.id] });
    await mockChrome.tabGroups.update(gid, { title: saved.title, color: saved.color });
    nativeGuidByOpenId.set(gid, saved.guid);
    Object.assign(saved, { sessionWindowId: nativeOpenWindow, sessionTabIds: [tab.id], sessionUpdatedAt: Date.now() });
    openedForDeletion.push({ guid: req.guid, tabId: tab.id });
    return { ok: true, guid: req.guid, profile: req.profile, windowMarker: req.windowMarker };
  }
  if (req.action === "diagnose" && diagnoseFailure) return diagnoseFailure;
  if (req.action === "diagnose") {
    return { ok: true, trusted: axTrusted, standardWindowTitle: "Chrome", tabGroupsButtons: [{ role: "AXButton", texts: ["标签页分组"] }], appMenuButtons: [{ role: "AXButton", texts: ["自定义及控制 Google Chrome"] }] };
  }
  return { ok: false };
};

const { bindSavedGroupsPanel } = await import("../sidepanel/saved-groups-ui.js");
const ctrl = bindSavedGroupsPanel({
  api: mockChrome,
  storage,
  nativeCall,
  getWindowId: () => 1,
});

// Refresh lists every saved native group, including closed ones, plus the PageLens library.
const closedRows = nativeStore.filter((row) => row.guid !== "g-open");
await ctrl.refresh();
assert.equal(nativeCalls.filter((req) => req.action !== "list").length, 0);
assert.equal(document.querySelectorAll("#sg-list .sg-item").length, 4);
assert.equal($("saved-groups-badge").textContent, "4");
const closedRow = document.querySelector('[data-sg-key="native:g-closed-1"]');
assert.equal(closedRow.querySelector(".sg-meta").textContent.startsWith("未打开"), true);
assert.equal(closedRow.querySelector(".sg-ops button").textContent, "未打开");
assert.equal(closedRow.querySelector(".sg-ops button").disabled, true);
assert.equal(closedRow.querySelector(".sg-check").disabled, false);
const ungroupBefore = tabOps.filter((op) => op.op === "ungroup").length;
// HTMLElement.click() does not activate a disabled control. Dispatch the event
// so the handler still refuses a closed native group.
for (const button of closedRow.querySelectorAll(".sg-ops button:not(.sg-del-btn)")) {
  button.dispatchEvent(new dom.window.Event("click"));
}
assert.match($("sg-status").textContent, /请先在 Chrome 中打开该组/);
assert.equal(dialog.open, false);
assert.equal(nativeCalls.filter((req) => req.action !== "list").length, 0);
assert.equal(tabOps.filter((op) => op.op === "ungroup").length, ungroupBefore);
assert.equal(document.querySelector('button[data-sg-filter="closed"]'), null);
assert.equal($("sg-use-helper"), null);
assert.equal($("sg-ax-banner"), null);
const singleDelete = closedRow.querySelector(".sg-del-btn");
assert.equal(singleDelete.disabled, true);
assert.match(singleDelete.title, /请先在 Chrome 中打开该组/);
singleDelete.dispatchEvent(new dom.window.Event("click"));
assert.match($("sg-status").textContent, /请先在 Chrome 中打开该组/);
assert.equal(dialog.open, false);
assert.equal(nativeCalls.filter((req) => req.action === "open").length, 0);

document.querySelector('button[data-sg-filter="open"]').click();
assert.equal(document.querySelectorAll("#sg-list .sg-item").length, 1);
assert.equal(document.querySelector(".sg-item .sg-meta").textContent.startsWith("已打开"), true);
document.querySelector('button[data-sg-filter="pagelens"]').click();
assert.equal(document.querySelectorAll("#sg-list .sg-item").length, 1);
document.querySelector('button[data-sg-filter="all"]').click();

const search = document.getElementById("sg-search");
const selectAll = $("sg-select-all");
const batchDelete = $("btn-sg-batch-delete");
const checkFor = (key) => document.querySelector(`[data-sg-key="${key}"] .sg-check`);
search.value = "PageLens";
search.dispatchEvent(new dom.window.Event("input"));
assert.equal(document.querySelectorAll("#sg-list .sg-item").length, 2);
assert.equal(selectAll.disabled, false, "closed-only results can be selected");
checkFor("native:g-closed-1").click();
assert.equal(checkFor("native:g-closed-1").checked, true);
assert.equal(selectAll.indeterminate, true);
assert.match($("sg-selected-count").textContent, /已选 1$/);
assert.equal(batchDelete.disabled, true);
assert.match($("sg-selection-hint").textContent, /1 个未打开的 Chrome 保存组需先在 Chrome 中打开/);
batchDelete.dispatchEvent(new dom.window.Event("click"));
assert.equal(dialog.open, false);
assert.match($("sg-status").textContent, /请先在 Chrome 中打开该组/);
assert.equal(nativeCalls.filter((req) => req.action === "open").length, 0, "a closed selection is not opened");
await ctrl.refresh();
assert.equal(checkFor("native:g-closed-1").checked, true, "selection persists on refresh");
selectAll.click();
assert.equal(checkFor("native:g-closed-1").checked, true);
assert.equal(checkFor("native:g-closed-2").checked, true);
assert.match($("sg-selected-count").textContent, /已选 2$/);
selectAll.click();
assert.equal(checkFor("native:g-closed-1").checked, false);
assert.equal(checkFor("native:g-closed-2").checked, false);
assert.equal($("sg-selection-hint").textContent, "");

search.value = "MX 111";
search.dispatchEvent(new dom.window.Event("input"));
assert.equal(document.querySelectorAll("#sg-list .sg-item").length, 1, "a closed native group stays searchable");
assert.equal(document.querySelector(".sg-item .sg-meta").textContent.startsWith("未打开"), true);
search.value = "Open Group";
search.dispatchEvent(new dom.window.Event("input"));
assert.equal(document.querySelectorAll("#sg-list .sg-item").length, 1);
search.value = "";
search.dispatchEvent(new dom.window.Event("input"));

const openRow = document.querySelector('.sg-item[data-sg-key="native:g-open"]');
assert.equal(openRow.querySelector(".sg-ops button").textContent, "定位");
openRow.querySelector(".sg-ops button").click();
await until(() => $("sg-status").textContent.includes("已打开"), "open group is focused");

document.querySelectorAll('.sg-item[data-sg-key="native:g-open"] button')[1].click();
assert.equal($("sg-dialog-name").value, "Open Group");
$("sg-dialog-name").value = "打开的组新名称";
$("sg-dialog-accept").click();
await until(() => document.querySelector('.sg-item[data-sg-key="native:g-open"] .sg-title')?.textContent === "打开的组新名称", "open native group renamed");

nativeStore.push({ guid: "g-remote", title: "远处的组", color: "cyan", tabCount: 1, tabs: [{ url: "https://remote.example/" }] });
const remoteTab = await mockChrome.tabs.create({ url: "https://remote.example/", windowId: 2 });
const remoteGid = await mockChrome.tabs.group({ tabIds: [remoteTab.id] });
await mockChrome.tabGroups.update(remoteGid, { title: "远处的组", color: "cyan" });
nativeGuidByOpenId.set(remoteGid, "g-remote");
await ctrl.refresh();
document.querySelector('.sg-item[data-sg-key="native:g-remote"] .sg-del-btn').click();
assert.ok(dialog.open);
assert.match($("sg-dialog-message").textContent, /其他 Chrome 窗口（2）/);
$("sg-dialog-cancel").click();
await Promise.resolve();
assert.ok(nativeStore.some((row) => row.guid === "g-remote"));

document.querySelector('.sg-item[data-sg-key="native:g-open"] .sg-del-btn').click();
nativeStore.find((row) => row.guid === "g-open").tabs[0].url = "https://changed.example/";
$("sg-dialog-accept").click();
await until(() => $("sg-status").textContent.includes("发生变化"), "changed snapshot is rejected");
nativeStore.find((row) => row.guid === "g-open").tabs[0].url = "https://open.example/1";
await ctrl.refresh();

selectAll.click();
assert.equal(checkFor("native:g-closed-1").checked, true);
assert.match($("sg-selected-count").textContent, /已选 5$/);
assert.equal(batchDelete.textContent, "删除 (3)");
assert.match($("sg-selection-hint").textContent, /2 个未打开的 Chrome 保存组需先在 Chrome 中打开/);
batchDelete.click();
assert.match($("sg-dialog-message").textContent, /选中的 3 个标签组/);
assert.match($("sg-dialog-message").textContent, /另外 2 个所选组会保留/);
assert.match($("sg-dialog-message").textContent, /也会关闭/);
assert.doesNotMatch($("sg-dialog-message").textContent, /逐个打开/);
$("sg-dialog-cancel").click();
await Promise.resolve();
assert.ok(nativeStore.some((row) => row.guid === "g-open"));

checkFor("native:g-remote").click();
document.querySelector('[data-sg-key^="pl:"] .sg-check').click();
checkFor("native:g-closed-1").click();
checkFor("native:g-closed-2").click();
batchDelete.click();
assert.match($("sg-dialog-message").textContent, /打开的组新名称/);
assert.match($("sg-dialog-message").textContent, /也会关闭/);
$("sg-dialog-accept").click();
await until(() => $("sg-status").textContent === "已永久删除 1 个标签组", "open group deletion completed");
assert.equal(openGroups.has(10), false, "open group deleted");
assert.deepEqual(tabOps.filter((op) => op.ids.includes(1)).map((x) => x.op), ["ungroup", "remove"], "ungrouped before removing open group tabs");
assert.ok(closedRows.every((row) => nativeStore.includes(row)), "unselected groups are left untouched");

search.value = "PageLens · MX";
search.dispatchEvent(new dom.window.Event("input"));
selectAll.click();
assert.equal(batchDelete.disabled, true);
assert.match($("sg-selection-hint").textContent, /2 个未打开的 Chrome 保存组需先在 Chrome 中打开/);
batchDelete.dispatchEvent(new dom.window.Event("click"));
assert.equal(dialog.open, false);
assert.equal(nativeCalls.filter((req) => req.action === "open").length, 0);
assert.ok(closedRows.every((row) => nativeStore.includes(row)));
assert.equal(checkFor("native:g-closed-1").checked, true);
assert.equal(checkFor("native:g-closed-2").checked, true);
search.value = "";
search.dispatchEvent(new dom.window.Event("input"));

nativeStore.push({ guid: "g-single", title: "未打开的单组", color: "red", tabCount: 1, tabs: [{ url: "https://single.example/" }] });
await ctrl.refresh();
const singleRowDelete = document.querySelector('[data-sg-key="native:g-single"] .sg-del-btn');
assert.equal(singleRowDelete.disabled, true);
singleRowDelete.dispatchEvent(new dom.window.Event("click"));
assert.match($("sg-status").textContent, /请先在 Chrome 中打开该组/);
assert.equal(dialog.open, false);
assert.ok(nativeStore.some((row) => row.guid === "g-single"));

const plRowRename = [...document.querySelectorAll('.sg-item[data-sg-key^="pl:"] button')].find((b) => b.textContent === "改名");
plRowRename.click();
assert.equal($("sg-dialog-name").value, "插件库收藏");
$("sg-dialog-name").value = "改名后的插件库";
$("sg-dialog-accept").click();
await until(() => document.querySelector('.sg-item[data-sg-key^="pl:"] .sg-title')?.textContent === "改名后的插件库", "renamed row is refreshed");

listFailure = "测试助手未安装";
await ctrl.refresh();
assert.match($("sg-load-error").textContent, /Chrome 原生组读取失败.*测试助手未安装/);
assert.equal(document.querySelector('[data-sg-key="native:g-remote"]'), null, "a failed native read does not invent rows");
document.querySelector('.sg-item[data-sg-key^="pl:"] .sg-del-btn').click();
$("sg-dialog-accept").click();
await until(() => !document.querySelector('.sg-item[data-sg-key^="pl:"]') && $("sg-status").textContent === "已永久删除 1 个标签组", "local deletion still succeeds");
assert.match($("sg-load-error").textContent, /测试助手未安装/);
assert.equal(nativeCalls.filter((req) => req.action === "ax_status").length, 0);

listFailure = "";
await saveTabGroupRecord(
  { title: "关闭事件丢失", color: "grey", tabs: [{ url: "https://pl.example/drop-close", title: "D" }] },
  { storage, now: () => 2000 },
);
await ctrl.refresh();
mirrorDialogClose = false;
document.querySelector('.sg-item[data-sg-key^="pl:"] .sg-del-btn').click();
assert.equal(dialog.open, true, "dropped-close delete still asks");
$("sg-dialog-accept").click();
await until(
  () => !document.querySelector('.sg-item[data-sg-key^="pl:"]') && $("sg-status").textContent === "已永久删除 1 个标签组",
  "accept resumes when the dialog closes without a close event",
);
assert.equal(dialog.open, false);
assert.equal(dialog.returnValue, "accept", "submit fallback must leave returnValue for a close listener that never runs");
mirrorDialogClose = true;

dom.window.close();
console.log("PASS test_saved_groups_ui.mjs");

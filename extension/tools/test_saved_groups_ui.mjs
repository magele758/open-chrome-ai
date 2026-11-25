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
    const tab = await mockChrome.tabs.create({ url: saved.tabs[0].url, windowId: nativeOpenWindow });
    const gid = await mockChrome.tabs.group({ tabIds: [tab.id] });
    await mockChrome.tabGroups.update(gid, { title: saved.title, color: saved.color });
    nativeGuidByOpenId.set(gid, saved.guid);
    Object.assign(saved, { sessionWindowId: nativeOpenWindow, sessionTabIds: [tab.id], sessionUpdatedAt: Date.now() });
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

// Opening and refreshing a panel must never launch the optional macOS app.
const closedRows = nativeStore.splice(1);
await ctrl.refresh();
assert.equal(nativeCalls.filter((req) => req.action === "ax_status").length, 0);
nativeStore.push(...closedRows);
const firstLoad = ctrl.refresh();
await until(() => document.querySelectorAll("#sg-list .sg-item").length === 4, "list renders while helper is pending");
await firstLoad;
assert.equal($("saved-groups-badge").textContent, "4");
assert.equal($("sg-list").getAttribute("aria-busy"), "false");
await ctrl.refresh();
assert.ok(nativeCalls.every((req) => req.action === "list"));
assert.ok(!$("sg-ax-banner").classList.contains("hidden"), "manual controls are available on first load");
assert.equal($("sg-use-helper").checked, false);

const useNativeHelper = () => {
  if (!$("sg-use-helper").checked) $("sg-use-helper").click();
};

// An explicitly requested diagnostic survives an ordinary list refresh.
let resolveList;
listGate = new Promise((resolve) => { resolveList = resolve; });
const pendingList = ctrl.refresh();
diagnoseFailure = { ok: false, code: "HELPER_LAUNCH_FAILED", error: "NSPOSIXErrorDomain Code=16 Resource busy" };
$("btn-sg-ax-diagnose").click();
await until(() => $("sg-status").textContent.includes("Code=16"), "launch failure shown");
resolveList();
listGate = null;
await pendingList;
assert.match($("sg-ax-text").textContent, /Code=16.*重新检测/);
assert.match($("sg-status").textContent, /Code=16/);
assert.ok(!$("sg-ax-banner").classList.contains("hidden"));
assert.ok($("sg-ax-prepare").classList.contains("hidden"), "a busy app does not need to be rebuilt");
assert.equal($("sg-ax-prepare").querySelector("code").textContent, "node native/install-native-host.mjs --prepare-helper");

// Explicit recheck obtains the current grant; ordinary refreshes reuse it.
diagnoseFailure = null;
$("btn-sg-ax-recheck").click();
await until(() => $("sg-status").textContent.includes("旧授权项"), "stale grant recovery is visible");
assert.ok(!$("sg-ax-banner").classList.contains("hidden"));
assert.ok($("sg-ax-prepare").classList.contains("hidden"), "a denied grant does not require rebuilding");
assert.match($("sg-ax-manual").textContent, /Chrome.*标签页分组.*改名或删除/);
assert.equal(nativeCalls.filter((req) => req.action === "ax_status").length, 1);

// 2. Filter closed native groups & search
document.querySelector('button[data-sg-filter="closed"]').click();
assert.equal(document.querySelectorAll("#sg-list .sg-item").length, 2);

const search = document.getElementById("sg-search");
search.value = "MX 111";
search.dispatchEvent(new dom.window.Event("input"));
assert.equal(document.querySelectorAll("#sg-list .sg-item").length, 1);
search.value = "";
search.dispatchEvent(new dom.window.Event("input"));

// 2b. Clicking "定位 Helper" triggers reveal_helper
document.getElementById("btn-sg-ax-reveal").click();
await new Promise((r) => setTimeout(r, 20));
assert.ok(nativeCalls.some((c) => c.action === "reveal_helper"), "triggers reveal_helper");
assert.ok(document.getElementById("sg-status").textContent.includes("PageLens Helper.app"));

// 3. Explicit helper authorization leaves the fallback and opt-in available.
document.getElementById("btn-sg-ax-open").click();
await new Promise((r) => setTimeout(r, 30));
assert.equal(document.getElementById("sg-ax-text").classList.contains("hidden"), true, "hides AX error once trusted");
assert.equal(document.getElementById("btn-sg-ax-diagnose").closest(".hidden"), null, "diagnose button stays visible in toolbar after banner hides");
useNativeHelper();

// 4. Select all closed MX groups and batch delete
const selectAll = document.getElementById("sg-select-all");
selectAll.checked = true;
selectAll.dispatchEvent(new dom.window.Event("change"));
assert.equal(document.getElementById("btn-sg-batch-delete").textContent, "删除已选 (2)");
// Narrowing the filter drops hidden selections before the destructive action.
search.value = "MX 111";
search.dispatchEvent(new Event("input"));
assert.equal($("btn-sg-batch-delete").textContent, "删除已选 (1)");
$("btn-sg-batch-delete").click();
assert.ok(dialog.open);
assert.match($("sg-dialog-message").textContent, /MX 111/);
$("sg-dialog-cancel").click();
await Promise.resolve();
assert.equal(nativeStore.length, 3);
assert.ok(!nativeCalls.some((req) => ["open", "delete"].includes(req.action)));

search.value = "";
search.dispatchEvent(new Event("input"));
selectAll.checked = true;
selectAll.dispatchEvent(new Event("change"));
$("btn-sg-batch-delete").click();
assert.match($("sg-dialog-message").textContent, /2 个标签组/);
$("sg-dialog-accept").click();
await until(() => $("sg-status").textContent === "已永久删除 2 个标签组", "batch deletion completed");
assert.ok(nativeCalls.some((req) => req.action === "list" && req.profile === "Default"), "action checks the displayed profile");
assert.deepEqual(nativeCalls.filter((req) => req.action === "open").map((req) => req.guid), ["g-closed-1", "g-closed-2"]);
assert.equal(nativeStore.length, 1, "both closed native groups deleted");
assert.equal(mem.savedGroupsUseHelper, true);
assert.equal(document.getElementById("saved-groups-badge").textContent, "2");

// 5. Switch to "all", delete the open Chrome native group -> calls ungroup before remove
document.querySelector('button[data-sg-filter="all"]').click();
const openRowDel = document.querySelector('.sg-item[data-sg-key="native:g-open"] .sg-del-btn');
openRowDel.click();
assert.ok(dialog.open);
assert.match($("sg-dialog-message").textContent, /也会关闭/);
$("sg-dialog-accept").click();
await until(() => $("sg-status").textContent === "已永久删除 1 个标签组", "open group deletion completed");
assert.equal(openGroups.size, 0, "open group deleted");
assert.deepEqual(tabOps.filter((op) => op.ids.includes(1)).map((x) => x.op), ["ungroup", "remove"], "ungrouped before removing open group tabs");

// 6. Rename PageLens saved group
const plRowRename = [...document.querySelectorAll('.sg-item[data-sg-key^="pl:"] button')].find((b) => b.textContent === "改名");
plRowRename.click();
assert.ok(dialog.open);
assert.equal($("sg-dialog-name").value, "插件库收藏");
$("sg-dialog-name").value = "改名后的插件库";
$("sg-dialog-accept").click();
await until(() => document.querySelector('.sg-item[data-sg-key^="pl:"] .sg-title')?.textContent === "改名后的插件库", "renamed row is refreshed");
assert.ok(document.querySelector('.sg-item[data-sg-key^="pl:"] .sg-title').textContent.includes("改名后的插件库"));

// 7. Diagnose button works
document.getElementById("btn-sg-ax-diagnose").click();
await new Promise((r) => setTimeout(r, 30));
assert.ok(document.getElementById("sg-status").textContent.includes("标签页分组按钮 1 个"));

// Rename a closed native group. The reopened group and stored GUID retain the new title.
nativeStore.push({ guid: "g-rename", title: "待改名", color: "green", tabCount: 1, tabs: [{ url: "https://rename.example/" }] });
await ctrl.refresh();
const renameRow = '.sg-item[data-sg-key="native:g-rename"]';
document.querySelectorAll(`${renameRow} button`)[1].click();
$("sg-dialog-name").value = "原生组新名称";
$("sg-dialog-accept").click();
await until(() => document.querySelector(`${renameRow} .sg-title`)?.textContent === "原生组新名称", "updated native GUID reloaded");
assert.equal(nativeStore[0].guid, "g-rename");
document.querySelector(`${renameRow} .sg-del-btn`).click();
$("sg-dialog-accept").click();
await until(() => !document.querySelector(renameRow), "renamed fixture deleted");

// A rejected native delete must preserve the row and explain the failure.
nativeStore.push({ guid: "g-failure", title: "Failure", color: "red", tabCount: 1, tabs: [{ url: "https://failure.example/" }] });
await ctrl.refresh();
deleteFailure = "NSPOSIXErrorDomain Code=2 No such file or directory";
document.querySelector('.sg-item[data-sg-key="native:g-failure"] .sg-del-btn').click();
$("sg-dialog-accept").click();
await until(() => $("sg-status").textContent.includes(deleteFailure), "rejected native action is reported");
assert.match($("sg-status").textContent, /失败 1 个.*Code=2.*重新检测/);
await ctrl.refresh();
assert.match($("sg-status").textContent, /Code=2/);
assert.match($("sg-ax-text").textContent, /Code=2/);
assert.ok(document.querySelector('.sg-item[data-sg-key="native:g-failure"]'));

// A group changed since the user saw the confirmation. Keep the new contents.
deleteFailure = "";
assert.equal($("sg-use-helper").checked, false, "automatically stop using a helper that cannot launch");
useNativeHelper();
document.querySelector('.sg-item[data-sg-key="native:g-failure"] .sg-del-btn').click();
nativeStore[0].tabs[0].url = "https://changed.example/";
$("sg-dialog-accept").click();
await until(() => $("sg-status").textContent.includes("发生变化"), "changed snapshot is rejected");
assert.equal(nativeStore.length, 1);

// A rejected native open must not silently create a new group using the saved URLs.
axTrusted = false;
await ctrl.refresh();
document.querySelector('.sg-item[data-sg-key="native:g-failure"] .sg-ops button').click();
await until(() => $("sg-status").textContent.includes("未授权辅助功能"), "native open refused");
assert.equal(openGroups.size, 0);
assert.equal(openTabs.size, 0, "temporary window marker cleaned up and no copy created");

// Lack of AX can skip another closed native group, but local records in the batch still complete.
nativeStore.push({ guid: "g-failure-2", title: "Failure 2", color: "green", tabCount: 1, tabs: [{ url: "https://failure.example/b" }] });
await saveTabGroupRecord({ id: "mixed-pl", title: "Failure local", tabs: ["https://local.example/b"] }, { storage });
await ctrl.refresh();
search.value = "Failure";
search.dispatchEvent(new Event("input"));
selectAll.checked = true;
selectAll.dispatchEvent(new Event("change"));
useNativeHelper();
$("btn-sg-batch-delete").click();
$("sg-dialog-accept").click();
await until(() => $("sg-status").textContent.includes("未处理 1 个"), "mixed batch completed");
assert.match($("sg-status").textContent, /已删除 1 个，失败 1 个，未处理 1 个/);
assert.ok(!document.querySelector('.sg-item[data-sg-key="pl:mixed-pl"]'));
assert.equal($("btn-sg-manual-refresh").textContent, "我已打开，核对并继续");
assert.match($("sg-manual-target").textContent, /「Failure」.*「Failure 2」/);
assert.doesNotMatch($("sg-manual-target").textContent, /Failure local/);

// A user reselection is unnecessary during the manual route. Open only the
// wrong identical sibling first; the original GUID stays selected.
const recovered = nativeStore.find((row) => row.guid === "g-failure");
const sibling = { ...structuredClone(recovered), guid: "g-identical" };
nativeStore.push(sibling);
await ctrl.refresh();
const recoveredRow = '.sg-item[data-sg-key="native:g-failure"]';
const nativeOpens = nativeCalls.filter((req) => req.action === "open").length;
document.querySelector(`${recoveredRow} .sg-del-btn`).click();
assert.equal(dialog.open, false, "guide appears before irreversible confirmation");
assert.match($("sg-manual-target").textContent, /Failure.*删除/);
assert.equal($("btn-sg-manual-refresh").textContent, "我已打开，核对并继续");
const tab = await mockChrome.tabs.create({ url: recovered.tabs[0].url, windowId: 1 });
const gid = await mockChrome.tabs.group({ tabIds: [tab.id] });
await mockChrome.tabGroups.update(gid, { title: recovered.title, color: recovered.color });
Object.assign(sibling, { sessionWindowId: 1, sessionTabIds: [tab.id] });
$("btn-sg-manual-refresh").click();
await until(() => $("sg-status").textContent.includes("尚未核对到"), "wrong sibling rejected");
assert.equal(dialog.open, false);
delete sibling.sessionTabIds;
Object.assign(recovered, { sessionWindowId: 2, sessionTabIds: [tab.id] });
nativeGuidByOpenId.set(gid, recovered.guid);
openGroups.get(gid).windowId = 2;
tab.windowId = 2;
$("btn-sg-manual-refresh").click();
await until(() => dialog.open, "the matching group can stay in its new window");
assert.match($("sg-dialog-message").textContent, /其他 Chrome 窗口（2）/);
// Approval covers the displayed destination. A move during the prompt needs fresh confirmation.
openGroups.get(gid).windowId = 3;
tab.windowId = 3;
recovered.sessionWindowId = 3;
$("sg-dialog-accept").click();
await until(() => $("sg-status").textContent.includes("失败 1 个") && !$("sg-manual-target").classList.contains("hidden"), "stale destination requires recheck");
assert.equal(nativeCalls.filter((req) => req.action === "open").length, nativeOpens);
assert.ok(nativeStore.some((row) => row.guid === recovered.guid));
$("btn-sg-manual-refresh").click();
await until(() => dialog.open, "moved target can be reconfirmed in place");
assert.match($("sg-dialog-message").textContent, /其他 Chrome 窗口（3）/);
$("sg-dialog-accept").click();
await until(() => $("sg-status").textContent === "已永久删除 1 个标签组", "manually reopened group deleted");
assert.ok(nativeStore.some((row) => row.guid === "g-identical"));
assert.equal(nativeCalls.filter((req) => req.action === "open").length, nativeOpens);
assert.equal(mem.savedGroupsUseHelper, false);

// The last closed native group hides the helper banner. A busy render during
// that hide must not leave the checkbox disabled, or a later click cannot turn it on.
const parkedGroups = nativeStore.splice(0);
nativeStore.push({
  guid: "g-last-closed",
  title: "最后关闭组",
  color: "grey",
  tabCount: 1,
  tabs: [{ url: "https://last.example/" }],
});
search.value = "";
search.dispatchEvent(new Event("input"));
document.querySelector('button[data-sg-filter="all"]').click();
await ctrl.refresh();
assert.equal($("sg-use-helper").checked, false);
$("btn-sg-ax-open").click();
await until(() => $("sg-status").textContent.includes("已获得 macOS 辅助功能权限"), "trusted grant without another status probe");
assert.equal($("sg-use-helper").checked, false, "trust does not turn the helper on");
assert.equal(nativeCalls.filter((req) => req.action === "ax_status").length, 1);
const lastRow = '.sg-item[data-sg-key="native:g-last-closed"]';
document.querySelector(`${lastRow} .sg-del-btn`).click();
assert.equal(dialog.open, false, "helper off still guides the last closed group");
const lastTab = await mockChrome.tabs.create({ url: "https://last.example/", windowId: 1 });
const lastGid = await mockChrome.tabs.group({ tabIds: [lastTab.id] });
await mockChrome.tabGroups.update(lastGid, { title: "最后关闭组", color: "grey" });
Object.assign(nativeStore.find((row) => row.guid === "g-last-closed"), { sessionWindowId: 1, sessionTabIds: [lastTab.id] });
nativeGuidByOpenId.set(lastGid, "g-last-closed");
$("btn-sg-manual-refresh").click();
await until(() => dialog.open, "the last opened group reaches confirmation");
$("sg-dialog-accept").click();
await until(
  () => !document.querySelector(lastRow) && $("sg-status").textContent === "已永久删除 1 个标签组",
  "last closed group deleted and banner can hide",
);
assert.ok($("sg-ax-banner").classList.contains("hidden"), "no closed native group keeps the helper banner hidden");
assert.equal($("sg-use-helper").disabled, false, "hiding the banner clears the busy-disabled helper checkbox");
$("sg-use-helper").click();
assert.equal($("sg-use-helper").checked, true, "an enabled checkbox toggles on");
$("sg-use-helper").click();
assert.equal($("sg-use-helper").checked, false);
if (openTabs.has(lastTab.id)) await mockChrome.tabs.remove(lastTab.id);
nativeStore.splice(0, nativeStore.length, ...parkedGroups);
await ctrl.refresh();

// The same guided action resumes the name form for the original saved GUID.
search.value = "";
search.dispatchEvent(new Event("input"));
const renameManual = { guid: "g-manual-rename", title: "手动改名", color: "pink", tabCount: 1, tabs: [{ url: "https://manual.example/" }] };
nativeStore.push(renameManual);
await ctrl.refresh();
const manualRow = '.sg-item[data-sg-key="native:g-manual-rename"]';
document.querySelectorAll(`${manualRow} .sg-ops button`)[1].click();
assert.match($("sg-manual-target").textContent, /手动改名.*改名/);
assert.equal(dialog.open, false);
const renameTab = await mockChrome.tabs.create({ url: renameManual.tabs[0].url, windowId: 5 });
const renameGid = await mockChrome.tabs.group({ tabIds: [renameTab.id] });
await mockChrome.tabGroups.update(renameGid, { title: renameManual.title, color: renameManual.color });
nativeGuidByOpenId.set(renameGid, renameManual.guid);
$("btn-sg-manual-refresh").click();
await until(() => dialog.open && !$("sg-dialog-name").hidden, "manual rename resumed");
assert.match($("sg-dialog-message").textContent, /其他 Chrome 窗口（5）/);
$("sg-dialog-name").value = "已手动改名";
$("sg-dialog-accept").click();
await until(() => document.querySelector(`${manualRow} .sg-title`)?.textContent === "已手动改名", "manual rename persisted");
assert.equal(renameManual.title, "已手动改名");
assert.equal(nativeCalls.filter((req) => req.action === "open").length, nativeOpens);

// A menu miss for a batch keeps just the two unresolved GUIDs. They can be
// opened in different windows; the local record is never retried.
const retryRows = [7, 8].map((win) => ({
  guid: `g-retry-${win}`, title: `跨窗重试 ${win}`, color: "blue", tabCount: 1, tabs: [{ url: `https://retry.example/${win}` }],
}));
nativeStore.push(...retryRows);
await saveTabGroupRecord({ id: "retry-local", title: "跨窗重试插件库", tabs: ["https://local.example/retry"] }, { storage });
await ctrl.refresh();
search.value = "跨窗重试";
search.dispatchEvent(new Event("input"));
selectAll.checked = true;
selectAll.dispatchEvent(new Event("change"));
axTrusted = true;
useNativeHelper();
deleteFailure = { ok: false, code: "NOT_FOUND_IN_UI", error: "未在请求窗口的 Chrome 标签组菜单中找到可打开的目标。" };
$("btn-sg-batch-delete").click();
$("sg-dialog-accept").click();
await until(() => $("sg-status").textContent.includes("已删除 1 个，失败 2 个"), "native menu miss offers manual batch retry");
assert.match($("sg-manual-target").textContent, /「跨窗重试 7」.*「跨窗重试 8」/);
assert.doesNotMatch($("sg-manual-target").textContent, /插件库/);
const attempts = nativeCalls.filter((req) => req.action === "open").length;
for (const [i, row] of retryRows.entries()) {
  const retryTab = await mockChrome.tabs.create({ url: row.tabs[0].url, windowId: 7 + i });
  const retryGid = await mockChrome.tabs.group({ tabIds: [retryTab.id] });
  await mockChrome.tabGroups.update(retryGid, { title: row.title, color: row.color });
  nativeGuidByOpenId.set(retryGid, row.guid);
}
$("btn-sg-manual-refresh").click();
await until(() => dialog.open, "remaining batch targets in both new windows are verified");
assert.match($("sg-dialog-message").textContent, /2 个标签组.*其他 Chrome 窗口（7、8）/);
$("sg-dialog-accept").click();
await until(() => $("sg-status").textContent === "已永久删除 2 个标签组", "remaining batch deleted without relaunching helper");
assert.ok(nativeStore.every((row) => !retryRows.includes(row)));
assert.ok(nativeStore.includes(renameManual), "another window's open group is preserved");
assert.equal(nativeCalls.filter((req) => req.action === "open").length, attempts);
deleteFailure = "";

// Chrome handled the native menu action but restored the group in a new
// window. The original confirmation must not close its tabs at that location.
const autoNew = { guid: "g-auto-new", title: "跨窗重试自动打开", color: "pink", tabCount: 1, tabs: [{ url: "https://auto.example/" }] };
nativeStore.push(autoNew);
await ctrl.refresh();
nativeOpenWindow = 9;
document.querySelector('.sg-item[data-sg-key="native:g-auto-new"] .sg-del-btn').click();
$("sg-dialog-accept").click();
await until(() => $("sg-status").textContent.includes("待核对 1 个"), "automatically restored in a different window");
assert.ok(nativeStore.includes(autoNew));
assert.ok(nativeCalls.some((req) => req.action === "open" && req.guid === autoNew.guid && req.allowNewWindow));
assert.match($("sg-manual-target").textContent, /自动打开」 已打开/);
$("btn-sg-manual-refresh").click();
await until(() => dialog.open, "new destination needs a second confirmation");
assert.match($("sg-dialog-message").textContent, /其他 Chrome 窗口（9）/);
$("sg-dialog-accept").click();
await until(() => $("sg-status").textContent === "已永久删除 1 个标签组", "confirmed automatic cross-window restoration deleted");
assert.ok(!nativeStore.includes(autoNew));
assert.equal(nativeCalls.filter((req) => req.action === "open" && req.guid === autoNew.guid).length, 1);
nativeOpenWindow = 1;

diagnoseFailure = { ok: false, code: "HELPER_GATEKEEPER_BLOCKED", error: "macOS 无法验证 PageLens Helper。" };
$("btn-sg-ax-diagnose").click();
await until(() => $("sg-ax-text").textContent.includes("macOS 无法验证"), "Gatekeeper failure explained");
assert.ok($("sg-ax-prepare").classList.contains("hidden"), "a blocked signature should not suggest rerunning the build");
assert.ok(!$("btn-sg-manual-refresh").closest(".hidden"), "manual workflow stays available");
search.value = "";
search.dispatchEvent(new Event("input"));
document.querySelector('button[data-sg-filter="all"]').click();

listFailure = "测试助手未安装";
await ctrl.refresh();
assert.match($("sg-load-error").textContent, /Chrome 原生组读取失败.*测试助手未安装/);
document.querySelector('.sg-item[data-sg-key^="pl:"] .sg-del-btn').click();
$("sg-dialog-accept").click();
await until(() => !document.querySelector('.sg-item[data-sg-key^="pl:"]') && $("sg-status").textContent === "已永久删除 1 个标签组", "local deletion still succeeds");
assert.match($("sg-load-error").textContent, /测试助手未安装/);
assert.equal(document.querySelectorAll("#sg-list .sg-item").length, 0);

assert.equal(nativeCalls.filter((req) => req.action === "ax_status").length, 1, "mutations and refreshes do not relaunch the status helper");

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

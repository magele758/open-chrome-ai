import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { installMemoryIndexedDB } from "./idb_mem.mjs";

installMemoryIndexedDB();

const html = readFileSync(new URL("../sidepanel/index.html", import.meta.url), "utf8");
const dom = new JSDOM(html, { url: "https://extension.invalid/sidepanel/index.html" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.Event = dom.window.Event;
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

const bag = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === "string") return { [keys]: bag[keys] };
        if (Array.isArray(keys)) {
          const out = {};
          for (const k of keys) out[k] = bag[k];
          return out;
        }
        return { ...bag };
      },
      set: async (obj) => Object.assign(bag, obj),
      remove: async (keys) => {
        for (const k of [].concat(keys)) delete bag[k];
      },
    },
  },
  windows: {
    getCurrent: async () => ({ id: 1 }),
    getAll: async () => [{ id: 1 }],
  },
};

const { saveSession, listSessions, loadSession } = await import("../lib/sessions.js");
const { state } = await import("../sidepanel/state.js");
const {
  HIST_SORT_KEY,
  openHistoryItem,
  openHistoryView,
  renderHistory,
  setHistorySortMode,
} = await import("../sidepanel/history.js");

const seeds = [
  {
    id: "s-old-gh",
    createdAt: 1000,
    updatedAt: 1000,
    pages: [{ url: "https://github.com/org/old", title: "Old Repo", hostname: "github.com" }],
    messages: [{ role: "user", text: "旧的 GitHub 讨论" }, { role: "bot", text: "旧回复" }],
  },
  {
    id: "s-mid-gh",
    createdAt: 3000,
    updatedAt: 3000,
    pages: [{ url: "https://github.com/org/new", title: "New Repo", hostname: "github.com" }],
    messages: [{ role: "user", text: "较新的 GitHub 讨论" }, { role: "bot", text: "较新回复" }],
  },
  {
    id: "s-newer-doc",
    createdAt: 4000,
    updatedAt: 4000,
    pages: [{ url: "https://docs.example.com/guide", title: "Guide", hostname: "docs.example.com" }],
    messages: [{ role: "user", text: "刚看的文档问答" }, { role: "bot", text: "文档回复" }],
  },
  {
    id: "s-latest-plain",
    createdAt: 5000,
    updatedAt: 5000,
    pages: [],
    messages: [{ role: "user", text: "刚刚聊的纯文本对话" }, { role: "bot", text: "纯文本回复" }],
  },
];

for (const seed of seeds) {
  await saveSession(seed, { windowId: 1, keepActive: true, preserveUpdatedAt: true });
}

function renderedIds() {
  return [...document.querySelectorAll("#hist-list .hist-item")].map((el) => el.dataset.sessionId);
}

// 1. Default mode is recent (newest first), no domain grouping or relation board.
await openHistoryView();
const listEl = document.getElementById("hist-list");
const recentBtn = document.getElementById("btn-hist-sort-recent");
const domainBtn = document.getElementById("btn-hist-sort-domain");
const countEl = document.getElementById("hist-count");

assert.equal(listEl.dataset.sortMode, "recent", "default sort mode is recent");
assert.equal(recentBtn.getAttribute("aria-pressed"), "true", "recent button pressed by default");
assert.equal(domainBtn.getAttribute("aria-pressed"), "false", "domain button not pressed by default");
assert.equal(listEl.getAttribute("aria-pressed"), null, "list container does not receive aria-pressed");
assert.equal(document.querySelectorAll(".lab-group").length, 0, "no domain groups in recent mode");
assert.equal(document.querySelectorAll(".lab-network").length, 0, "no relation board in recent mode");
assert.deepEqual(
  renderedIds(),
  ["s-latest-plain", "s-newer-doc", "s-mid-gh", "s-old-gh"],
  "recent mode puts newest sessions first regardless of domain",
);
assert.equal(countEl.textContent, "共 4 条", "shows total session count");

// 2. Switching to domain mode groups by host, persists preference, and keeps items newest-first inside groups.
await setHistorySortMode("domain");
assert.equal(localStorage.getItem(HIST_SORT_KEY), "domain", "persists domain mode in localStorage");
assert.equal(listEl.dataset.sortMode, "domain");
assert.equal(domainBtn.getAttribute("aria-pressed"), "true");
assert.equal(recentBtn.getAttribute("aria-pressed"), "false");
assert.equal(document.querySelectorAll(".lab-network").length, 1, "shows relation board in domain mode");
const groupNames = [...document.querySelectorAll("[data-hist-group]")].map((el) => el.dataset.histGroup);
assert.deepEqual(
  groupNames,
  ["github.com", "docs.example.com", "未分享页面"],
  "domain mode orders groups by count then recency, with unshared last",
);
const ghIds = [...document.querySelectorAll('[data-hist-group="github.com"] .hist-item')].map((el) => el.dataset.sessionId);
assert.deepEqual(ghIds, ["s-mid-gh", "s-old-gh"], "items inside each domain group stay newest first");

// 3. Reopening history restores persisted domain mode.
state.histSort = "recent";
await openHistoryView();
assert.equal(listEl.dataset.sortMode, "domain", "reopening restores persisted sort preference");

// 4. Search filtering works in both modes and updates count.
state.histQuery = "GitHub";
await renderHistory();
assert.equal(countEl.textContent, "2 / 4 条", "shows filtered / total count");
assert.deepEqual(renderedIds(), ["s-mid-gh", "s-old-gh"]);

await setHistorySortMode("recent");
assert.equal(localStorage.getItem(HIST_SORT_KEY), "recent", "persists recent mode in localStorage");
assert.equal(document.querySelectorAll(".lab-group").length, 0);
assert.deepEqual(renderedIds(), ["s-mid-gh", "s-old-gh"]);

state.histQuery = "";
await renderHistory();
assert.equal(countEl.textContent, "共 4 条");
assert.deepEqual(renderedIds(), ["s-latest-plain", "s-newer-doc", "s-mid-gh", "s-old-gh"]);

// 5. Opening an older session just to view it does NOT jump it to the top or attach an unrelated active tab.
state.tab = { url: "https://unrelated.example/tab", title: "Unrelated Tab" };
state.share = true;
await openHistoryItem("s-old-gh");
assert.equal(state.sessionId, "s-old-gh");
assert.equal(state.view, "chat");

await openHistoryView();
assert.deepEqual(
  renderedIds(),
  ["s-latest-plain", "s-newer-doc", "s-mid-gh", "s-old-gh"],
  "read-only reopen preserves chronological order",
);
const oldAfter = await loadSession("s-old-gh");
assert.equal(oldAfter.updatedAt, 1000, "read-only reopen preserves updatedAt");
assert.deepEqual(
  oldAfter.pages.map((p) => p.hostname),
  ["github.com"],
  "read-only reopen does not attach unrelated active tab",
);
assert.equal(
  (await listSessions()).find((s) => s.id === "s-old-gh")?.updatedAt,
  1000,
  "index keeps original updatedAt",
);

dom.window.close();
console.log("PASS history sort");

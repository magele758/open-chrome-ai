import assert from "node:assert/strict";
import "./fixtures/web-locks.mjs";
import { DELEGATE_STORAGE_KEY } from "../lib/agent/delegate.js";
import { windowMailTools } from "../sidepanel/window-mail.js";
import { resolveActiveTools } from "../lib/agent/tools.js";
import { extractCapsule, capsuleCovers } from "../lib/agent/trust/capsule.js";
import { installWindowMail, listPeerWindows, readWindowMail, sendWindowMail, waitForWindowResult } from "../lib/window-mail.js";

function event() {
  const listeners = new Set();
  return { listeners, addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) };
}

const db = {};
const panelUrl = "chrome-extension://fixture/sidepanel/index.html";
const senderFor = windowId => ({ id: "fixture", url: panelUrl, documentId: `doc-${windowId}` });
let sender = senderFor(1);
let contextRows = [{ windowId: -1 }];
const cancelled = [];
const windows = [1, 2, 3].map(id => ({ id, incognito: false })).concat({ id: 4, incognito: true });
globalThis.chrome = {
  runtime: {
    id: "fixture", onMessage: event(), getURL: () => panelUrl,
    getContexts: async () => contextRows,
    sendMessage: async msg => new Promise(resolve => {
      for (const receive of chrome.runtime.onMessage.listeners) receive(msg, sender, resolve);
    }),
  },
  windows: { getAll: async () => windows, onRemoved: event() },
  tabs: { query: async q => [{ id: q.windowId * 10, url: "https://example.org/" }] },
  storage: {
    onChanged: event(),
    session: {
      get: async keys => Object.fromEntries([].concat(keys).map(k => [k, structuredClone(db[k])])),
      set: async data => {
        Object.assign(db, structuredClone(data));
        const changes = Object.fromEntries(Object.entries(data).map(([k,v]) => [k, { newValue: v }]));
        for (const notify of chrome.storage.onChanged.listeners) notify(changes, "session");
      },
      remove: async key => { delete db[key]; },
    },
  },
};
let task;
installWindowMail({
  async start(args) {
    task = { ...args, id: "task-123", createdAt: 123, status: "running" };
    await chrome.storage.session.set({ [DELEGATE_STORAGE_KEY]: [task] });
    return task;
  },
  list: async () => [task],
  cancel: async id => cancelled.push(id),
});

assert.deepEqual(await listPeerWindows(1), [2, 3]);
await assert.rejects(sendWindowMail(1, 2, "message", "unbound"), /不匹配/);
contextRows = [{ documentId: "doc-1", windowId: -1 }, { documentId: "doc-2", windowId: 1 }];
await assert.rejects(sendWindowMail(1, 2, "message", "negative"), /不匹配/);
contextRows = [
  { documentId: "doc-1", windowId: 1 },
  { documentId: "doc-2", windowId: 2 },
  { documentId: "doc-4", windowId: 4 },
];
await assert.rejects(sendWindowMail(2, 1, "message", "spoof"), /不匹配/);
sender = { id: "fixture", url: panelUrl };
await assert.rejects(sendWindowMail(1, 2, "message", "no-doc"), /不匹配/);
sender = senderFor(1);
await assert.rejects(sendWindowMail(1, 1, "message", "self"), /另一个/);
await assert.rejects(sendWindowMail(1, 4, "message", "private"), /另一个/);
await assert.rejects(sendWindowMail(1, 2, "message", "  "), /长度/);
sender = { ...senderFor(1), tab: { id: 7 } };
await assert.rejects(sendWindowMail(1, 2, "message", "web tab"), /仅侧栏/);
sender = senderFor(1);
await sendWindowMail(1, 2, "message", "left");
sender = senderFor(2);
await sendWindowMail(2, 1, "message", "right");
sender = senderFor(1);
for (const id of [1, 2]) assert.deepEqual((await readWindowMail(id)).map(e => e.text).sort(), ["left", "right"]);
assert.deepEqual(await readWindowMail(3), []);
const repeated = await Promise.all([1, 2].map(() => sendWindowMail(1, 2, "message", "once", undefined, "turn/call")));
assert.equal(repeated[0].id, repeated[1].id);
assert.equal((await readWindowMail(2)).filter(e => e.text === "once").length, 1);
const entry = await sendWindowMail(1, 2, "task", "总结本页", { actions: [] });
assert.equal(entry.from, 1);
assert.equal(task.tabId, 20);
assert.equal(task.windowId, 2);
assert.equal(task.session.modelPlanned, true);
assert.deepEqual(task.capsule, { actions: [] });
const receipt = waitForWindowResult(1, entry.id);
const ctrl = new AbortController();
const aborted = waitForWindowResult(1, entry.id, ctrl.signal);
ctrl.abort();
await assert.rejects(aborted, (err) => {
  assert.match(err.message, /已停止等待/);
  assert.equal(err.message, "已停止等待，该委派已取消，不会再有结果进收件箱。");
  return true;
});
assert.deepEqual(cancelled, [entry.id]);
await assert.rejects(waitForWindowResult(3, entry.id), /过期/);
cancelled.length = 0;
for (const onClose of chrome.windows.onRemoved.listeners) await onClose(1);
assert.deepEqual(cancelled, [entry.id]);
cancelled.length = 0;
for (const onClose of chrome.windows.onRemoved.listeners) await onClose(2);
assert.deepEqual(cancelled, [entry.id]);
await chrome.storage.session.set({ [DELEGATE_STORAGE_KEY]: [{ ...task, status: "failed", error: { message: "窗口正忙" } }] });
assert.equal((await receipt).result, "窗口正忙");
assert.equal((await waitForWindowResult(1, entry.id)).status, "failed");
assert.deepEqual(await readWindowMail(3), []);
assert.equal(chrome.storage.onChanged.listeners.size, 0);
console.log("PASS cross-window messages, task delivery, failure receipts, cancellation and isolation");

// Auto allocation belongs to the sender's browsing mode, never to an existing peer.
chrome.runtime.onMessage.listeners.clear();
const jobs = [];
const opened = [];
const removed = [];
const capsule = extractCapsule("比较 https://a.example/report 和 https://b.example/report");
assert.equal(capsuleCovers(capsule, { toolName: "run_parallel_tasks" }).covered, true);
let capacityUsed = 0;
let rejectStart = false;
chrome.windows.get = async id => ({ id, type: "normal", incognito: id === 4 });
chrome.windows.create = async props => {
  const id = 20 + opened.length;
  opened.push({ id, ...props });
  return { id, tabs: [{ id: id * 10 }] };
};
chrome.tabs.query = async ({ windowId }) => [{ id: windowId * 10, url: "about:blank" }];
chrome.windows.remove = async id => { removed.push(id); };
installWindowMail({
  list: async () => jobs,
  runningCount: () => capacityUsed,
  async start(args) {
    if (rejectStart) throw new Error("start failed");
    const job = { ...args, id: `job-${jobs.length}`, createdAt: Date.now(), status: "done", answer: args.prompt };
    jobs.push(job);
    await chrome.storage.session.set({ [DELEGATE_STORAGE_KEY]: jobs });
    return job;
  },
});
sender = senderFor(4);
const available = resolveActiveTools({ userText: "对照两份报告", tools: windowMailTools(4, () => capsule, "turn-1") });
const batch = available.find(t => t.name === "run_parallel_tasks");
assert.ok(batch, "planning is discoverable without window-related keywords");
await assert.rejects(batch.execute({ tasks: ["one"] }), /2 至/);
assert.equal(opened.length, 0);
const runBatch = () => batch.execute({ tasks: ["报告一", "报告二"] }, { callId: "call-1" }).then(JSON.parse);
const [first, replay] = await Promise.all([runBatch(), runBatch()]);
assert.deepEqual(first, replay);
assert.deepEqual(first.map(t => t.to), [20, 21]);
assert.equal(opened.length, 2);
assert.ok(opened.every(w => w.incognito && !w.focused && w.url === "about:blank"));
assert.ok(jobs.every(j => j.capsule.urls.length === 2 && j.session.modelPlanned));
capacityUsed = 7;
const busy = await batch.execute({ tasks: ["三", "四"] }, { callId: "call-2" }).then(JSON.parse);
assert.ok(busy.every(t => t.status === "failed"));
assert.equal(opened.length, 2);
capacityUsed = 0;
rejectStart = true;
await assert.rejects(sendWindowMail(4, null, "auto_task", "失败", capsule, "new"), /start failed/);
assert.deepEqual(removed, [22]);
console.log("PASS automatic window allocation, joining, checkpoint replay and rollback");

// Background delegate_window_task must follow the same stop signal after it returns.
chrome.runtime.onMessage.listeners.clear();
sender = senderFor(1);
const bgTasks = [];
const bgCancelled = [];
let abortDuringStart = null;
installWindowMail({
  list: async () => bgTasks,
  async start(args) {
    const job = { ...args, id: `bg-${bgTasks.length + 1}`, createdAt: Date.now(), status: "running" };
    bgTasks.push(job);
    await chrome.storage.session.set({ [DELEGATE_STORAGE_KEY]: bgTasks });
    abortDuringStart?.abort();
    return job;
  },
  async cancel(id) {
    const job = bgTasks.find(item => item.id === id && item.status === "running");
    if (!job || bgCancelled.includes(id)) return;
    bgCancelled.push(id);
  },
});
const cancelMessages = [];
const deliverMessage = chrome.runtime.sendMessage;
chrome.runtime.sendMessage = async msg => {
  if (msg?.type === "pl.windowMail.cancel") cancelMessages.push(msg.id);
  return deliverMessage(msg);
};
async function until(fn) {
  for (let i = 0; i < 30; i++) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error("condition not met");
}
const delegate = windowMailTools(1, () => ({ actions: [] }), "turn-bg").find(tool => tool.name === "delegate_window_task");
await assert.rejects(
  delegate.execute({ windowId: 2, text: "停在发出前", background: true }, { signal: AbortSignal.abort(), callId: "pre" }),
  err => err?.name === "AbortError",
);
assert.equal(bgTasks.length, 0);
assert.deepEqual(bgCancelled, []);

const mid = new AbortController();
abortDuringStart = mid;
await assert.rejects(
  delegate.execute({ windowId: 2, text: "发出时已停止", background: true }, { signal: mid.signal, callId: "mid" }),
  err => err?.name === "AbortError",
);
abortDuringStart = null;
assert.deepEqual(bgCancelled, ["bg-1"]);
assert.deepEqual(cancelMessages, ["bg-1"]);

const live = new AbortController();
const dispatched = JSON.parse(await delegate.execute(
  { windowId: 2, text: "后台继续", background: true },
  { signal: live.signal, callId: "bg-live" },
));
assert.equal(dispatched.taskId, "bg-2");
assert.equal(dispatched.status, "running");
assert.deepEqual(bgCancelled, ["bg-1"]);
live.abort();
await until(() => bgCancelled.includes("bg-2"));
assert.deepEqual(bgCancelled, ["bg-1", "bg-2"]);

const stop = new AbortController();
const finished = JSON.parse(await delegate.execute(
  { windowId: 2, text: "已经做完", background: true },
  { signal: stop.signal, callId: "done-one" },
));
const running = JSON.parse(await delegate.execute(
  { windowId: 2, text: "仍在执行", background: true },
  { signal: stop.signal, callId: "run-one" },
));
const doneTask = bgTasks.find(item => item.id === finished.taskId);
doneTask.status = "done";
doneTask.answer = "ok";
await chrome.storage.session.set({ [DELEGATE_STORAGE_KEY]: bgTasks });
const sentBeforeStop = cancelMessages.length;
stop.abort();
await until(() => bgCancelled.includes(running.taskId));
assert.deepEqual(cancelMessages.slice(sentBeforeStop), [running.taskId]);
assert.equal(bgCancelled.includes(finished.taskId), false);
assert.equal(bgTasks.find(item => item.id === finished.taskId).status, "done");

const foreground = new AbortController();
const waiting = delegate.execute(
  { windowId: 2, text: "前台等待", background: false },
  { signal: foreground.signal, callId: "fg" },
);
await until(() => bgTasks.some(item => item.prompt === "前台等待"));
await new Promise(resolve => setTimeout(resolve, 0));
foreground.abort();
await assert.rejects(waiting, /已停止等待，该委派已取消，不会再有结果进收件箱/);
assert.equal(bgCancelled.includes(bgTasks.find(item => item.prompt === "前台等待").id), true);
chrome.runtime.sendMessage = deliverMessage;
console.log("PASS background delegation follows stop without cancelling finished tasks");

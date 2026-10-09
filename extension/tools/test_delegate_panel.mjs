import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createDelegatePanel, stepLine, visibleDelegateTasks } from "../sidepanel/delegate-panel.js";

const dom = new JSDOM(`<div class="delegate-tasks hidden" id="delegate-tasks"></div>`);
globalThis.document = dom.window.document;

const now = Date.now();
const capsule = { version: 1, principal: "agent", actions: ["publish"], origins: ["zhihu.com"], urls: [], platforms: ["zhihu"], recipients: [], paths: [], commands: [], widened: false };
const tasks = [
  { id: "t_old", status: "done", prompt: "old", capsule, createdAt: now - 7200e3, finishedAt: now - 7000e3, steps: [] },
  {
    id: "t_run",
    status: "running",
    agentName: "cursor",
    prompt: "总结这个视频并发布到知乎",
    capsule,
    createdAt: now - 1000,
    steps: [
      { n: 1, kind: "tool", name: "get_captions", ok: true },
      { n: 2, kind: "blocked", name: "cose_publish", code: "CONFIRMATION_REQUIRED", pendingId: "pend_1" },
    ],
    pending: [{ pendingId: "pend_1", toolName: "cose_publish" }],
  },
  { id: "t_wait", status: "needs_approval", prompt: "w", capsule, createdAt: now - 9000e3, finishedAt: now - 8000e3, steps: [] },
];

const shown = visibleDelegateTasks(tasks, now);
assert.deepEqual(shown.map((t) => t.id), ["t_run", "t_wait"], "running + needs_approval kept, stale finished dropped");
assert.equal(stepLine(tasks[1].steps[0]), "✓ get_captions");
assert.equal(stepLine(tasks[1].steps[1]), "⛔ cose_publish CONFIRMATION_REQUIRED · pend_1");

const cancelled = [];
let store = tasks;
const panel = createDelegatePanel({
  load: async () => store,
  cancel: async (id) => {
    cancelled.push(id);
    store = store.map((t) => (t.id === id ? { ...t, status: "cancelled", finishedAt: Date.now() } : t));
  },
});
await panel.render();
const box = document.getElementById("delegate-tasks");
assert.equal(box.classList.contains("hidden"), false);
assert.match(box.textContent, /外部委托任务 · 1 个运行中/);
assert.match(box.textContent, /cursor/);
assert.match(box.textContent, /授权：动作：发布/);
assert.match(box.textContent, /1 个操作等你/);
const btn = [...box.querySelectorAll("button")].find((b) => b.textContent === "取消");
assert.ok(btn, "running task has cancel button");
btn.click();
await new Promise((r) => setTimeout(r, 10));
assert.deepEqual(cancelled, ["t_run"]);
assert.match(box.textContent, /已取消/);

store = [];
await panel.render();
assert.equal(box.classList.contains("hidden"), true);
console.log("PASS delegate side panel list + cancel");

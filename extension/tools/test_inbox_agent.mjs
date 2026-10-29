import assert from "node:assert/strict";

const store = {};
const sent = [];
let panel = { ok: true, busy: false, windowId: 1 };
let runReply = { ok: true };
let tabs = [{ id: 7, windowId: 1, url: "http://localhost:8080/", status: "complete" }];
const updated = [];

globalThis.chrome = {
  storage: {
    local: { get: async () => ({}) },
    session: {
      get: async (k) => ({ [k]: store[k] }),
      set: async (o) => Object.assign(store, o),
      remove: async (k) => { delete store[k]; },
    },
  },
  runtime: {
    sendMessage: async (msg) => {
      sent.push(msg.type);
      if (msg.type === "pl.agentPrompt.ping") {
        if (!panel) throw new Error("Could not establish connection. Receiving end does not exist.");
        return panel;
      }
      if (msg.type === "pl.agentPrompt.run") return runReply;
      return { ok: true };
    },
  },
  windows: { getLastFocused: async () => ({ id: 1 }) },
  sidePanel: { open: async () => { throw new Error("user gesture required"); } },
  tabs: {
    get: async (id) => tabs.find((t) => t.id === id) || null,
    query: async ({ windowId } = {}) => tabs.filter((t) => windowId == null || t.windowId === windowId),
    update: async (id, props) => { updated.push([id, props]); },
    create: async () => assert.fail("must not create a tab"),
  },
};

const { startAgentPrompt, takeCompletion, takeExpired, cancelAgentPrompt, settleHeadless } = await import(
  "../lib/agent/inbox-agent.js"
);
const { setDelegateManager, TASK_STATUS } = await import("../lib/agent/delegate.js");

// empty prompt
{
  const r = await startAgentPrompt({ prompt: "  " }, "j0");
  assert.equal(r.done.errorCode, "BAD_JOB");
}

// happy path: tab focused, run dispatched, state stored
{
  const r = await startAgentPrompt(
    { prompt: "describe title", tabUrlIncludes: "localhost:8080", metadata: { run: 1 }, timeoutMs: 60000 },
    "j1",
  );
  assert.deepEqual(r, { started: true, runtime: "panel" });
  assert.deepEqual(updated, [[7, { active: true }]]);
  assert.ok(sent.includes("pl.agentPrompt.run"));
  assert.equal(store.agentPromptActive.id, "j1");
}

// second job queues while one is active
{
  const r = await startAgentPrompt({ prompt: "other" }, "j2");
  assert.deepEqual(r, { queued: true });
}

// completion for a stale id is ignored; matching id returns outbox payload with metadata
{
  assert.equal(await takeCompletion({ id: "nope", ok: true }), null);
  const out = await takeCompletion({ id: "j1", ok: true, summary: "标题是 X", steps: [{ name: "read", ok: true }] });
  assert.equal(out.ok, true);
  assert.equal(out.action, "agent_prompt");
  assert.equal(out.result.summary, "标题是 X");
  assert.deepEqual(out.metadata, { run: 1 });
  assert.equal(store.agentPromptActive, undefined);
}

// expiry: cancels in panel and reports TIMEOUT
{
  store.agentPromptActive = { id: "j3", startedAt: Date.now() - 2000, deadline: Date.now() - 1, metadata: null };
  sent.length = 0;
  const out = await takeExpired();
  assert.equal(out.errorCode, "TIMEOUT");
  assert.ok(sent.includes("pl.agentPrompt.cancel"));
  assert.equal(await takeExpired(), null);
}

// cancel: nothing running, id mismatch, then real cancel with CANCELLED outbox payload
{
  assert.equal((await cancelAgentPrompt()).result.cancelled, false);
  store.agentPromptActive = { id: "j9", startedAt: Date.now() - 1000, deadline: Date.now() + 60000, metadata: { m: 1 } };
  const bad = await cancelAgentPrompt("other");
  assert.equal(bad.result.errorCode, "ID_MISMATCH");
  assert.ok(store.agentPromptActive);
  sent.length = 0;
  const ok = await cancelAgentPrompt("j9");
  assert.equal(ok.result.cancelled, true);
  assert.equal(ok.output.errorCode, "CANCELLED");
  assert.equal(ok.output.id, "j9");
  assert.deepEqual(ok.output.metadata, { m: 1 });
  assert.ok(sent.includes("pl.agentPrompt.cancel"));
  assert.equal(store.agentPromptActive, undefined);
}

// panel busy (user chatting) -> AGENT_BUSY, nothing dispatched
{
  panel = { ok: true, busy: true, windowId: 1 };
  sent.length = 0;
  const r = await startAgentPrompt({ prompt: "x" }, "j4");
  assert.equal(r.done.errorCode, "AGENT_BUSY");
  assert.ok(!sent.includes("pl.agentPrompt.run"));
  panel = { ok: true, busy: false, windowId: 1 };
}

// missing tab / wrong window
{
  let r = await startAgentPrompt({ prompt: "x", tabUrlIncludes: "nowhere.example" }, "j5");
  assert.equal(r.done.errorCode, "TAB_NOT_FOUND");
  tabs = [{ id: 9, windowId: 2, url: "http://localhost:8080/", status: "complete" }];
  r = await startAgentPrompt({ prompt: "x", tabId: 9 }, "j6");
  assert.equal(r.done.errorCode, "WRONG_WINDOW");
}

// panel rejects run
{
  tabs = [];
  runReply = { ok: false, code: "AGENT_BUSY", error: "busy" };
  const r = await startAgentPrompt({ prompt: "x" }, "j7");
  assert.equal(r.done.errorCode, "AGENT_BUSY");
  assert.equal(store.agentPromptActive, undefined);
}

// runtime "panel" and panel closed -> SIDEPANEL_NOT_OPEN (never a silent fallback)
{
  panel = null;
  const r = await startAgentPrompt({ prompt: "x", runtime: "panel" }, "j8");
  assert.equal(r.done.errorCode, "SIDEPANEL_NOT_OPEN");
  assert.match(r.done.hint, /headless/);
}

// bad runtime value
{
  const r = await startAgentPrompt({ prompt: "x", runtime: "popup" }, "j8b");
  assert.equal(r.done.errorCode, "BAD_JOB");
}

// ---- headless runtime (service-worker delegate runner) ----

let started = [];
let cancelled = [];
let startError = null;
let task = null;
const manager = {
  async start(args) {
    if (startError) throw startError;
    started.push(args);
    task = { id: "task_1", status: TASK_STATUS.RUNNING, steps: [], pending: [], denied: [], answer: "" };
    return { id: task.id, status: task.status };
  },
  async status(id) {
    if (!task || task.id !== id) throw Object.assign(new Error("none"), { code: "TASK_NOT_FOUND" });
    return structuredClone(task);
  },
  async cancel(id) {
    cancelled.push(id);
    return {};
  },
};

// no delegate runner installed -> explicit failure, not SIDEPANEL_NOT_OPEN
{
  panel = null;
  const r = await startAgentPrompt({ prompt: "x" }, "h0");
  assert.equal(r.done.errorCode, "HEADLESS_UNAVAILABLE");
}

setDelegateManager(manager);

// auto + panel closed -> falls back to headless, no panel run message, tab found in any window
{
  panel = null;
  sent.length = 0;
  updated.length = 0;
  tabs = [{ id: 21, windowId: 5, url: "http://localhost:8080/cose", status: "complete" }];
  const r = await startAgentPrompt(
    {
      prompt: "发布",
      tabUrlIncludes: "localhost:8080",
      capsule: { actions: ["publish"], platforms: ["zhihu"] },
      maxSteps: 20,
      metadata: { slot: "0945" },
    },
    "h1",
  );
  assert.deepEqual(r, { started: true, runtime: "headless" });
  assert.ok(!sent.includes("pl.agentPrompt.run"));
  assert.deepEqual(updated, [[21, { active: true }]]);
  const call = started.at(-1);
  assert.equal(call.tabId, 21);
  assert.equal(call.sourceUrl, "http://localhost:8080/cose");
  assert.equal(call.maxSteps, 20);
  assert.deepEqual(call.capsule, { actions: ["publish"], platforms: ["zhihu"] });
  assert.equal(call.session.agentName, "inbox");
  assert.equal(call.session.sessionId, "inbox:h1");
  assert.equal(call.session.skipIrreversible, false);
  assert.equal(call.session.allowUrl("http://localhost:8080/x"), true, "bridge allowlist covers localhost");
  assert.equal(call.session.allowUrl("https://evil.example/"), false);
  assert.equal(store.agentPromptActive.runtime, "headless");
  assert.equal(store.agentPromptActive.taskId, "task_1");
  tabs = [{ id: 7, windowId: 1, url: "http://localhost:8080/", status: "complete" }];
}

// another prompt queues while the headless run is active; settle is a no-op until the task finishes
{
  assert.deepEqual(await startAgentPrompt({ prompt: "other" }, "h2"), { queued: true });
  assert.equal(await settleHeadless(), null);
  assert.ok(store.agentPromptActive);
  // a stray panel completion must not close a headless run
  assert.equal(await takeCompletion({ id: "h1", ok: true }), null);
  assert.ok(store.agentPromptActive);
}

// done -> ok outbox with summary, tool steps, metadata
{
  Object.assign(task, {
    status: TASK_STATUS.DONE,
    answer: "五平台已提交",
    steps: [
      { n: 1, kind: "tool", name: "trusted_click", ok: true, summary: "clicked" },
      { n: 2, kind: "blocked", name: "x", code: "NEEDS_WIDER_AUTHORIZATION", summary: "no" },
      { n: 3, kind: "answer", summary: "五平台已提交" },
    ],
  });
  const out = await settleHeadless();
  assert.equal(out.ok, true);
  assert.equal(out.id, "h1");
  assert.equal(out.result.summary, "五平台已提交");
  assert.deepEqual(out.result.steps, [{ name: "trusted_click", ok: true, preview: "clicked" }]);
  assert.equal(out.result.runtime, "headless");
  assert.deepEqual(out.metadata, { slot: "0945" });
  assert.equal(store.agentPromptActive, undefined);
  assert.equal(await settleHeadless(), null);
}

// needs_approval -> CONFIRMATION_REQUIRED with pending list; failed -> task error code
{
  panel = null;
  await startAgentPrompt({ prompt: "发布", runtime: "headless" }, "h3");
  Object.assign(task, {
    status: TASK_STATUS.NEEDS_APPROVAL,
    pending: [{ pendingId: "pa_1", toolName: "trusted_click", reason: "发布", approval: "pending" }],
  });
  let out = await settleHeadless();
  assert.equal(out.ok, false);
  assert.equal(out.errorCode, "CONFIRMATION_REQUIRED");
  assert.deepEqual(out.result.pending, [{ pendingId: "pa_1", toolName: "trusted_click", reason: "发布" }]);

  await startAgentPrompt({ prompt: "x", runtime: "headless" }, "h4");
  Object.assign(task, { status: TASK_STATUS.FAILED, error: { code: "MODEL_NOT_READY", message: "未配置模型" } });
  out = await settleHeadless();
  assert.equal(out.errorCode, "MODEL_NOT_READY");
  assert.equal(out.error, "未配置模型");
}

// panel open + auto -> panel wins; panel busy -> AGENT_BUSY (no headless takeover)
{
  panel = { ok: true, busy: false, windowId: 1 };
  runReply = { ok: true };
  started = [];
  let r = await startAgentPrompt({ prompt: "x" }, "h5");
  assert.deepEqual(r, { started: true, runtime: "panel" });
  assert.equal(started.length, 0);
  await takeCompletion({ id: "h5", ok: true, summary: "" });
  panel = { ok: true, busy: true, windowId: 1 };
  r = await startAgentPrompt({ prompt: "x" }, "h6");
  assert.equal(r.done.errorCode, "AGENT_BUSY");
  panel = { ok: true, busy: false, windowId: 1 };
}

// token job: session uses token origins / egress / skipIrreversible
{
  panel = null;
  const auth = { record: { id: "tok1", name: "cose", origins: ["https://cose.example"], egress: ["https://api.example"], skipIrreversible: true } };
  await startAgentPrompt({ prompt: "x" }, "h7", { auth });
  const { session } = started.at(-1);
  assert.equal(session.tokenId, "tok1");
  assert.equal(session.agentName, "cose");
  assert.equal(session.skipIrreversible, true);
  assert.equal(session.allowUrl("https://cose.example/a"), true);
  assert.equal(session.allowUrl("http://localhost:8080/"), false);
  assert.deepEqual(session.egress, ["https://cose.example", "https://api.example"]);
  await cancelAgentPrompt();
}

// timeout and cancel stop the delegate task, not the panel
{
  panel = null;
  cancelled = [];
  await startAgentPrompt({ prompt: "x", runtime: "headless" }, "h8");
  store.agentPromptActive.deadline = Date.now() - 1;
  sent.length = 0;
  const out = await takeExpired();
  assert.equal(out.errorCode, "TIMEOUT");
  assert.deepEqual(cancelled, ["task_1"]);
  assert.ok(!sent.includes("pl.agentPrompt.cancel"));

  await startAgentPrompt({ prompt: "x", runtime: "headless" }, "h9");
  const c = await cancelAgentPrompt("h9");
  assert.equal(c.output.errorCode, "CANCELLED");
  assert.deepEqual(cancelled, ["task_1", "task_1"]);
  assert.ok(!sent.includes("pl.agentPrompt.cancel"));
}

// headless: missing tab, runner busy, bad capsule
{
  panel = null;
  tabs = [];
  let r = await startAgentPrompt({ prompt: "x", tabUrlIncludes: "nowhere.example" }, "h10");
  assert.equal(r.done.errorCode, "TAB_NOT_FOUND");
  assert.equal(store.agentPromptActive, undefined);
  startError = Object.assign(new Error("busy"), { code: "BUSY" });
  assert.deepEqual(await startAgentPrompt({ prompt: "x" }, "h11"), { queued: true });
  startError = Object.assign(new Error("bad capsule"), { code: "BAD_ARGS" });
  r = await startAgentPrompt({ prompt: "x", capsule: [1] }, "h12");
  assert.equal(r.done.errorCode, "BAD_JOB");
  startError = null;
}

console.log("test_inbox_agent ok");

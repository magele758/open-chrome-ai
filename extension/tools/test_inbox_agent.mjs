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
    query: async ({ windowId }) => tabs.filter((t) => t.windowId === windowId),
    update: async (id, props) => { updated.push([id, props]); },
    create: async () => assert.fail("must not create a tab"),
  },
};

const { startAgentPrompt, takeCompletion, takeExpired, cancelAgentPrompt } = await import("../lib/agent/inbox-agent.js");

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
  assert.deepEqual(r, { started: true });
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

// side panel not open -> SIDEPANEL_NOT_OPEN
{
  panel = null;
  const r = await startAgentPrompt({ prompt: "x" }, "j8");
  assert.equal(r.done.errorCode, "SIDEPANEL_NOT_OPEN");
}

console.log("test_inbox_agent ok");

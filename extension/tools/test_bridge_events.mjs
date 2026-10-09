import assert from "node:assert/strict";
import { createTokenRecord } from "../lib/bridge/auth.js";
import { createBridge } from "../lib/bridge/index.js";
import { createBridgeTools } from "../lib/bridge/tools.js";
import { DEFAULT_ALLOWED_ORIGINS } from "../lib/bridge/policy.js";
import { EVENT_TYPES, RING_SIZE, agentTaskBusEvent, approvalEvents, createEventBus, expandEventTypes, filterEventForToken, installEventSources } from "../lib/bridge/events.js";
import { createDelegateManager, memoryTaskStorage } from "../lib/agent/delegate.js";
import { createApprovalQueue, memoryAdapter } from "../lib/agent/trust/approval-queue.js";
import { createKeyedQueue, createTabLeases, leaseGuarded, openedTabIds, queueKeys } from "../lib/bridge/leases.js";
import { JOBS_KEY, PERSIST_ARTIFACT_MAX, createJobStore } from "../lib/bridge/jobs.js";
import { createNativeGateway } from "../lib/native-port.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

const { token: localTok, record: local } = await createTokenRecord({ name: "local", scopes: ["tabs:read", "page:read", "page:act", "tabs:manage"], origins: ["http://localhost:*"] });
const { record: noTabs } = await createTokenRecord({ name: "dl-only", scopes: ["downloads"], origins: ["http://localhost:*"] });
const { record: other } = await createTokenRecord({ name: "other", scopes: ["tabs:read", "page:read", "page:act", "downloads"], origins: ["https://a.example"] });
const { token: readTok, record: reader } = await createTokenRecord({ name: "reader", scopes: ["tabs:read", "page:read"], origins: ["*"] });

// ---- filterEventForToken ----
{
  const ev = { ts: 1, type: "tab.updated", tabId: 5, url: "http://localhost:3000/x", title: "L", status: "complete" };
  assert.deepEqual(filterEventForToken(ev, local), ev);
  assert.equal(filterEventForToken(ev, other), null, "outside token origins → dropped");
  assert.equal(filterEventForToken(ev, noTabs), null, "tab events need tabs:read");

  const left = { type: "tab.updated", tabId: 5, url: "https://bank.example/", title: "Bank" };
  assert.equal(filterEventForToken(left, local), null, "never in range → nothing");
  assert.deepEqual(filterEventForToken(left, local, { prevUrl: "http://localhost:3000/" }), { type: "tab.updated", tabId: 5, url: null, title: null, redacted: true }, "leaving range → redacted once");
  assert.equal(filterEventForToken({ type: "tab.removed", tabId: 5, url: "https://bank.example/" }, local, { prevUrl: "https://bank.example/" }), null);
  assert.ok(filterEventForToken({ type: "tab.removed", tabId: 5, url: "http://localhost:1/" }, local));

  const dl = { type: "download.created", downloadId: 1, url: "https://cdn.example/f.zip", referrer: "http://localhost:8080/page", filename: "/d/f.zip" };
  assert.deepEqual(filterEventForToken(dl, local), null, "download needs downloads scope");
  const dlOther = filterEventForToken({ ...dl, referrer: "https://a.example/p" }, other);
  assert.equal(dlOther.url, null, "download URL outside range redacted");
  assert.equal(dlOther.referrer, "https://a.example/p");
  assert.equal(dlOther.redacted, true);
  assert.equal(filterEventForToken(dl, other), null, "neither url nor referrer in range");

  const dialog = { type: "dialog.opened", tabId: 5, url: "http://localhost:3000/", tabUrl: "http://localhost:3000/", dialogType: "confirm", message: "Sure?" };
  const shown = filterEventForToken(dialog, local);
  assert.equal(shown.message, "Sure?");
  assert.ok(!("tabUrl" in shown), "internal fields stripped");
  assert.equal(filterEventForToken(dialog, other), null);

  const job = { type: "job.done", agentId: local.id, jobId: "j1", ok: true };
  assert.deepEqual(filterEventForToken(job, local), { type: "job.done", jobId: "j1", ok: true });
  assert.equal(filterEventForToken(job, other), null, "jobs only for the owning token");
  assert.equal(filterEventForToken({ type: "bogus" }, local), null);

  assert.deepEqual([...expandEventTypes(["tab.*"])], EVENT_TYPES.filter((t) => t.startsWith("tab.")));
  assert.equal(expandEventTypes(undefined).size, EVENT_TYPES.length);
  assert.throws(() => expandEventTypes(["nope"]), (e) => e.code === "BAD_ARGS");
}

// ---- bus: subscribe / poll / ring / push / revoke ----
{
  let tokens = [local, other, noTabs];
  const pushed = [];
  const bus = createEventBus({ loadTokens: async () => tokens, ringSize: 5 });
  bus.setSink((sid, e) => pushed.push([sid, e]));
  const authL = { record: local, sessionId: "sL", agentName: "L" };
  const authO = { record: other, sessionId: "sO", agentName: "O" };

  assert.throws(() => bus.subscribe({ record: local }, ["tab.updated"]), (e) => e.code === "UNAUTHORIZED");
  assert.throws(() => bus.subscribe({ record: noTabs, sessionId: "sN" }, ["tab.updated"]), (e) => e.code === "SCOPE_DENIED");
  const all = bus.subscribe({ record: noTabs, sessionId: "sN" });
  assert.deepEqual(all.types, ["download.created", "download.changed", "job.progress", "job.done", "approval.queued", "approval.resolved"], "wildcard keeps only permitted types");

  const sub = bus.subscribe(authL, ["tab.updated", "tab.removed"]);
  assert.deepEqual(sub, { types: ["tab.updated", "tab.removed"], since: 0, push: true });
  bus.subscribe(authO, ["tab.*"]);

  await bus.emit({ type: "tab.updated", tabId: 1, url: "http://localhost:3000/", title: "a", status: "complete" });
  await bus.emit({ type: "tab.updated", tabId: 2, url: "https://a.example/", title: "b", status: "complete" });
  await bus.emit({ type: "tab.created", tabId: 3, url: "http://localhost:3000/new" });
  await bus.emit({ type: "tab.updated", tabId: 1, url: "https://bank.example/", title: "bank" });
  await bus.emit({ type: "tab.removed", tabId: 1 });

  let p = bus.poll("sL");
  assert.deepEqual(p.events.map((e) => [e.seq, e.type, e.tabId, e.url]), [
    [1, "tab.updated", 1, "http://localhost:3000/"],
    [2, "tab.updated", 1, null],
  ], "L sees its tab, then a redacted leave; not tab 2, not tab.created (unsubscribed), not removal of an out-of-range tab");
  assert.equal(p.next, 2);
  assert.equal(p.dropped, false);
  const pO = bus.poll("sO");
  assert.deepEqual(pO.events.map((e) => e.tabId), [2], "O only sees a.example");
  assert.deepEqual(pushed.map(([sid, e]) => `${sid}:${e.seq}`), ["sL:1", "sO:1", "sL:2"], "push mirrors the ring per session");

  assert.deepEqual(bus.unsubscribe("sL", ["tab.removed"]).types, ["tab.updated"]);
  for (let i = 0; i < 7; i += 1) await bus.emit({ type: "tab.updated", tabId: 9, url: `http://localhost:1/${i}` });
  p = bus.poll("sL", { since: 2, max: 3 });
  assert.equal(p.dropped, true, "ring of 5 lost seq 3-4");
  assert.deepEqual(p.events.map((e) => e.seq), [5, 6, 7]);
  assert.equal(p.more, true);
  p = bus.poll("sL", { since: p.next });
  assert.deepEqual(p.events.map((e) => e.seq), [8, 9]);
  assert.equal(p.more, false);
  assert.equal(bus.poll("sL", { since: 9 }).events.length, 0);

  tokens = [{ ...local, revokedAt: 1 }, other];
  await bus.emit({ type: "tab.updated", tabId: 9, url: "http://localhost:1/z" });
  assert.equal(bus.poll("sL", { since: 9 }).events.length, 0, "revoked token gets nothing");

  bus.unsubscribe("sO");
  assert.deepEqual(bus.subscribed("sO"), []);
  bus.closeSession("sL");
  assert.deepEqual(bus.poll("sL"), { events: [], next: 0, dropped: false, subscribed: [] });
  assert.equal(RING_SIZE, 200);
}

// ---- chrome event sources ----
{
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
  const fakeChrome = {
    tabs: { onCreated: on("created"), onUpdated: on("updated"), onRemoved: on("removed"), onActivated: on("activated"), get: async (id) => ({ id, url: "http://localhost:3000/act", title: "act" }) },
    webNavigation: { onCompleted: on("nav") },
    downloads: { onCreated: on("dlc"), onChanged: on("dlx"), search: async ({ id }) => [{ id, url: "http://localhost:3000/f.bin" }] },
    debugger: { onEvent: on("cdp") },
  };
  const got = [];
  const bus = { emit: (e) => got.push(e) };
  installEventSources(bus, fakeChrome);
  listeners.updated(4, { title: "x" }, { url: "http://localhost:3000/" });
  listeners.updated(4, { status: "complete" }, { url: "http://localhost:3000/", title: "T", windowId: 1, status: "complete" });
  listeners.nav({ frameId: 1, tabId: 4, url: "http://localhost:3000/frame" });
  listeners.nav({ frameId: 0, tabId: 4, url: "http://localhost:3000/" });
  listeners.removed(4, { windowId: 1, isWindowClosing: false });
  await listeners.activated({ tabId: 6, windowId: 1 });
  await listeners.dlx({ id: 11, state: { previous: "in_progress", current: "complete" } });
  listeners.cdp({ tabId: 4 }, "Page.javascriptDialogOpening", { type: "alert", message: "hi", url: "http://localhost:3000/" });
  listeners.cdp({ tabId: 4 }, "Network.requestWillBeSent", {});
  assert.deepEqual(got.map((e) => e.type), ["tab.updated", "navigation.completed", "tab.removed", "tab.activated", "download.changed", "dialog.opened"], "title-only updates and subframes ignored");
  assert.equal(got[3].url, "http://localhost:3000/act");
  assert.deepEqual(got[4], { type: "download.changed", downloadId: 11, url: "http://localhost:3000/f.bin", state: "complete" });
  assert.equal(got[5].dialogType, "alert");

  // tab.removed carries no URL: the bus fills in the last known one
  const tokens = [local];
  const real = createEventBus({ loadTokens: async () => tokens });
  real.subscribe({ record: local, sessionId: "s" }, ["tab.removed", "dialog.opened"]);
  await real.emit({ type: "tab.updated", tabId: 4, url: "http://localhost:3000/" });
  await real.emit({ type: "dialog.opened", tabId: 4, url: "", dialogType: "alert", message: "m" });
  await real.emit({ type: "tab.removed", tabId: 4 });
  await real.emit({ type: "tab.removed", tabId: 77 });
  assert.deepEqual(real.poll("s").events.map((e) => [e.type, e.url]), [["dialog.opened", ""], ["tab.removed", "http://localhost:3000/"]], "unknown tab removal is not reported");
}

// ---- keyed queue: per-tab serial, cross-tab parallel, clipboard global ----
{
  const q = createKeyedQueue();
  const log = [];
  const gate = () => {
    let open;
    const p = new Promise((r) => (open = r));
    return { p, open };
  };
  const g1 = gate();
  const a = q.run(["tab:1"], async () => {
    log.push("a+");
    await g1.p;
    log.push("a-");
  });
  const b = q.run(["tab:2"], async () => log.push("b"));
  const c = q.run(["tab:1"], async () => log.push("c"));
  await b;
  await tick();
  assert.deepEqual(log, ["a+", "b"], "tab 2 not blocked by tab 1; second tab-1 job waits");
  g1.open();
  await Promise.all([a, c]);
  assert.deepEqual(log, ["a+", "b", "a-", "c"]);

  const g2 = gate();
  const order = [];
  const p1 = q.run(["tab:1", "clipboard"], async () => {
    order.push("paste1");
    await g2.p;
  });
  const p2 = q.run(["tab:2", "clipboard"], async () => order.push("paste2"));
  const p3 = q.run(["tab:3"], async () => order.push("click3"));
  await p3;
  assert.deepEqual(order, ["paste1", "click3"], "clipboard users serialize across tabs");
  g2.open();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["paste1", "click3", "paste2"]);
  const failing = q.run(["tab:9"], async () => {
    throw new Error("boom");
  });
  await assert.rejects(failing, /boom/);
  assert.equal(await q.run(["tab:9"], async () => "after"), "after", "a failure does not wedge the key");
  await tick();
  assert.equal(q.pending(), 0);

  const byName = new Map(createBridgeTools({ platform: () => "other", tabs: {}, cdp: {} }).map((t) => [t.name, t]));
  assert.deepEqual(queueKeys(byName.get("trusted_click"), { tabId: 1 }, 1), ["tab:1"]);
  assert.deepEqual(queueKeys(byName.get("trusted_click"), { tabId: 1, activate: true }, 1), ["tab:1", "focus"]);
  assert.deepEqual(queueKeys(byName.get("paste_rich_trusted"), { tabId: 2 }, 2), ["tab:2", "clipboard"]);
  assert.deepEqual(queueKeys(byName.get("clipboard_write"), {}, null), ["clipboard"]);
  assert.deepEqual(queueKeys(byName.get("copy_selection_trusted"), { tabId: 3 }, 3), ["tab:3", "clipboard"]);
  assert.ok(leaseGuarded(byName.get("trusted_click")) && leaseGuarded(byName.get("run_js")) && leaseGuarded(byName.get("navigate_tab")));
  assert.ok(!leaseGuarded(byName.get("screenshot")) && !leaseGuarded(byName.get("list_tabs")));
  assert.deepEqual(openedTabIds("open_tab", { tabId: 4 }), [4]);
  assert.deepEqual(openedTabIds("create_window", { tabs: [{ id: 5 }, { id: 6 }] }), [5, 6]);
  assert.deepEqual(openedTabIds("list_tabs", [{ id: 1 }]), []);
}

// ---- leases (unit) ----
{
  const grouped = [];
  const leases = createTabLeases({
    now: () => 100,
    groups: {
      group: async (tabIds, groupId) => {
        grouped.push([tabIds, groupId ?? null]);
        return groupId ?? 7;
      },
      update: async (groupId, props) => grouped.push(["title", groupId, props.title]),
    },
  });
  const A = { sessionId: "A", agentId: "x", agentName: "cursor" };
  const B = { sessionId: "B", agentId: "y", agentName: "claude" };
  assert.throws(() => leases.claim(1, null), (e) => e.code === "UNAUTHORIZED");
  assert.deepEqual(leases.claim(1, A), { tabId: 1, leased: true, since: 100 });
  leases.claim(1, A);
  assert.throws(() => leases.claim(1, B), (e) => e.code === "TAB_LEASED" && e.details.holder.agentName === "cursor" && !("sessionId" in e.details.holder));
  assert.throws(() => leases.check(1, null), (e) => e.code === "TAB_LEASED", "legacy caller blocked too");
  leases.check(1, A);
  leases.check(2, B);
  assert.throws(() => leases.release(1, "B"), (e) => e.code === "TAB_LEASED");
  await leases.adopt([3, 4], A);
  await leases.adopt([5], A);
  assert.deepEqual(grouped, [[[3, 4], null], ["title", 7, "Agent: cursor"], [[5], 7]], "one tab group per session, titled once");
  assert.deepEqual(leases.owned("A"), [1, 3, 4, 5]);
  assert.ok(leases.release(1, "A"));
  leases.dropTab(3);
  assert.deepEqual(leases.releaseSession("A"), [4, 5]);
  assert.equal(leases.size(), 0);
}

// ---- job store: persistence + interrupted on restart ----
{
  const area = {};
  const storage = { get: async (k) => ({ [k]: area[k] }), set: async (o) => Object.assign(area, o) };
  const s1 = createJobStore({ storage, now: () => 10 });
  await s1.ready;
  s1.start("a\u0000j1", { tool: "screenshot", agentId: "a" });
  s1.start("a\u0000j2", { tool: "read_rendered_html", agentId: "a" });
  s1.finish("a\u0000j1", { ok: true, artifacts: [{ name: "big", mime: "image/png", encoding: "base64", size: 1, data: "x".repeat(PERSIST_ARTIFACT_MAX + 1) }, { name: "s", mime: "text/plain", encoding: "utf8", size: 2, data: "hi" }] });
  await s1.flush();
  assert.equal(area[JOBS_KEY].length, 2);
  assert.equal((await s1.get("a\u0000j1")).response.artifacts[0].data.length, PERSIST_ARTIFACT_MAX + 1, "memory keeps full artifact");

  const s2 = createJobStore({ storage, now: () => 20 });
  const j1 = await s2.get("a\u0000j1");
  const j2 = await s2.get("a\u0000j2");
  assert.equal(j1.status, "done");
  assert.deepEqual(j1.response.artifacts[0], { name: "big", mime: "image/png", encoding: "base64", size: 1, data: "", omitted: true });
  assert.equal(j1.response.artifacts[1].data, "hi");
  assert.equal(j2.status, "interrupted");
  assert.equal(j2.interruptedAt, 20);
  await s2.flush();
  assert.equal(area[JOBS_KEY].find(([k]) => k === "a\u0000j2")[1].status, "interrupted", "interrupted state written back");

  const capped = createJobStore({ max: 2 });
  for (const k of ["1", "2", "3"]) capped.start(k, { tool: "t" });
  assert.equal(await capped.get("1"), null);
  assert.equal(capped.size(), 2);
}

// ---- bridge integration: sessions, leases, events, jobs ----
function makeBridge({ sessionStorage = null, tabGroups = null, slowJs = null } = {}) {
  const TABS = new Map([
    [1, { id: 1, windowId: 1, url: "http://localhost:3000/", title: "L1" }],
    [2, { id: 2, windowId: 1, url: "http://localhost:3000/b", title: "L2" }],
    [3, { id: 3, windowId: 1, url: "https://a.example/", title: "A" }],
  ]);
  let nextId = 50;
  return createBridge({
    getSettings: async () => ({ agentBridgeEnabled: true, agentBridgeOrigins: [...DEFAULT_ALLOWED_ORIGINS] }),
    getAgentTokens: async () => [local, other, reader],
    sessionStorage,
    tabGroups,
    tabs: {
      get: async (id) => {
        if (!TABS.has(id)) throw new Error(`No tab with id: ${id}`);
        return TABS.get(id);
      },
      query: async () => [...TABS.values()],
      create: async (props) => {
        const tab = { id: nextId++, windowId: 1, url: props.url, title: "" };
        TABS.set(tab.id, tab);
        return tab;
      },
      update: async (id, props) => ({ ...TABS.get(id), ...props }),
    },
    inject: async () => ({ ok: true, matches: true, count: 1, items: [] }),
    runJs: async () => {
      if (slowJs) await slowJs();
      return { ok: true, value: 1 };
    },
    cdp: { send: async () => ({ data: "AAAA" }) },
    clipboard: { write: async () => ({ via: "fake" }) },
    platform: () => "other",
    sleep: async () => {},
    now: () => Date.now(),
    extensionVersion: () => "test",
  });
}

{
  const grouped = [];
  const bridge = makeBridge({ tabGroups: { group: async (ids, g) => (grouped.push(ids), g ?? 3), update: async () => {} } });
  const sA = { token: localTok, sessionId: "sess-A", agentName: "cursor" };
  const sB = { token: localTok, sessionId: "sess-B", agentName: "codex" };
  const sR = { token: readTok, sessionId: "sess-R", agentName: "watcher" };
  const call = (session, tool, args = {}, extra = {}) => bridge.call({ id: `${session?.sessionId || "legacy"}-${tool}-${Math.random()}`, tool, args, ...extra }, { session });

  const hello = await bridge.hello({ session: sA });
  const names = hello.tools.map((t) => t.name);
  for (const n of ["events_subscribe", "events_unsubscribe", "events_poll", "tab_claim", "tab_release"]) assert.ok(names.includes(n), n);
  const legacyHello = await bridge.hello();
  assert.ok(!legacyHello.tools.some((t) => t.name.startsWith("events_") || t.name.startsWith("tab_claim")), "session tools hidden from legacy entry");
  assert.ok(hello.errorCodes.includes("TAB_LEASED"));

  const legacySub = await call(null, "events_subscribe", { types: ["tab.updated"] });
  assert.equal(legacySub.error.code, "UNAUTHORIZED");
  const badArg = await call(sA, "events_poll", { since: "x" });
  assert.equal(badArg.error.code, "BAD_ARGS");

  // leases: A claims tab 1; B (same token, different session) cannot act on it, can still read it
  const claim = await call(sA, "tab_claim", { tabId: 1 });
  assert.ok(claim.ok && claim.result.leased, JSON.stringify(claim));
  const blocked = await call(sB, "set_input_value", { tabId: 1, selector: "#q", value: "x" });
  assert.equal(blocked.error.code, "TAB_LEASED");
  assert.equal(blocked.error.retryable, true);
  assert.equal(blocked.error.details.holder.agentName, "cursor");
  const readOk = await call(sB, "query_dom", { tabId: 1, selector: "h1" });
  assert.ok(readOk.ok, "read-only tools ignore leases");
  const own = await call(sA, "set_input_value", { tabId: 1, selector: "#q", value: "x" });
  assert.ok(own.ok, JSON.stringify(own));
  assert.equal((await call(sB, "tab_claim", { tabId: 1 })).error.code, "TAB_LEASED");
  assert.equal((await call(null, "set_input_value", { tabId: 1, selector: "#q", value: "x" })).error.code, "TAB_LEASED", "legacy CDP entry respects leases");
  assert.equal((await call(sR, "tab_claim", { tabId: 1 })).error.code, "SCOPE_DENIED", "read-only token cannot lease");
  assert.equal((await call(sA, "tab_claim", { tabId: 3 })).error.code, "ORIGIN_NOT_ALLOWED");
  assert.ok((await call(sB, "set_input_value", { tabId: 2, selector: "#q", value: "y" })).ok, "other tabs unaffected");

  // tabs opened by a session become its lease + tab group
  const opened = await call(sB, "open_tab", { url: "http://localhost:3000/new" });
  assert.ok(opened.ok);
  assert.deepEqual(grouped, [[opened.result.tabId]]);
  assert.equal(bridge.leases.holder(opened.result.tabId).sessionId, "sess-B");
  assert.equal((await call(sA, "set_input_value", { tabId: opened.result.tabId, selector: "#q", value: "z" })).error.code, "TAB_LEASED");

  // session close releases its leases
  bridge.closeSession("sess-A");
  assert.ok((await call(sB, "set_input_value", { tabId: 1, selector: "#q", value: "x" })).ok);
  const rel = await call(sB, "tab_release", {});
  assert.deepEqual(rel.result.released, [opened.result.tabId]);

  // events through the bridge: per-session filtering + job events
  const pushed = [];
  bridge.events.setSink((sid, e) => pushed.push([sid, e.type]));
  assert.deepEqual((await call(sR, "events_subscribe", { types: ["tab.*", "job.*"] })).result.types.sort(), ["job.done", "job.progress", "tab.activated", "tab.created", "tab.removed", "tab.updated"]);
  assert.equal((await call(sR, "events_subscribe", { types: ["download.changed"] })).error.code, "SCOPE_DENIED");
  await call(sB, "events_subscribe", { types: ["tab.updated", "job.done"] });
  await bridge.events.emit({ type: "tab.updated", tabId: 3, url: "https://a.example/", status: "complete" });
  await bridge.events.emit({ type: "tab.updated", tabId: 1, url: "http://localhost:3000/", status: "complete" });
  const pollR = await call(sR, "events_poll", {});
  assert.deepEqual(pollR.result.events.map((e) => e.tabId), [3, 1], "reader token (*) sees both");
  const pollB = await call(sB, "events_poll", { since: 0 });
  assert.deepEqual(pollB.result.events.map((e) => e.tabId), [1], "localhost token never sees a.example");

  const job = await call(sB, "query_dom", { tabId: 1, selector: "h1" }, { async: true, id: "job-1" });
  assert.equal(job.result.status, "running");
  await tick();
  await bridge.events.idle();
  const st = await call(sB, "job_status", { jobId: "job-1" });
  assert.equal(st.result.status, "done");
  assert.equal(st.result.response.ok, true);
  const jobEvents = (await call(sB, "events_poll", { since: pollB.result.next })).result.events;
  assert.deepEqual(jobEvents.map((e) => [e.type, e.jobId, e.ok]), [["job.done", "job-1", true]]);
  const rJobs = (await call(sR, "events_poll", { since: pollR.result.next })).result.events;
  assert.equal(rJobs.length, 0, "other token never sees B's jobs");
  assert.ok(pushed.some(([sid, t]) => sid === "sess-B" && t === "job.done"));
  assert.equal((await call(sB, "events_unsubscribe", {})).result.types.length, 0);
}

// ---- bridge: exclusive tools on different tabs run in parallel; same tab serial ----
{
  let running = 0;
  let peak = 0;
  const release = [];
  const bridge = makeBridge({
    slowJs: async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => release.push(r));
      running -= 1;
    },
  });
  const tool = bridge.tools.find((t) => t.name === "run_js");
  tool.exclusive = true;
  const call = (tabId, id) => bridge.call({ id, tool: "run_js", args: { tabId, code: "1" } });
  const p1 = call(1, "x1");
  const p2 = call(2, "x2");
  const p3 = call(1, "x3");
  for (let i = 0; i < 20 && release.length < 2; i += 1) await tick();
  assert.equal(peak, 2, "tab 1 and tab 2 overlap");
  assert.equal(release.length, 2, "second tab-1 call still queued");
  release.shift()();
  release.shift()();
  for (let i = 0; i < 20 && release.length < 1; i += 1) await tick();
  release.shift()();
  const all = await Promise.all([p1, p2, p3]);
  assert.ok(all.every((r) => r.ok), JSON.stringify(all));
}

// ---- bridge: job_status survives SW restart; in-flight jobs become interrupted ----
{
  const area = {};
  const sessionStorage = { get: async (k) => ({ [k]: area[k] }), set: async (o) => Object.assign(area, o) };
  let hang;
  const b1 = makeBridge({ sessionStorage, slowJs: () => new Promise((r) => (hang = r)) });
  const s = { token: localTok, sessionId: "s1", agentName: "a" };
  await b1.call({ id: "done-1", tool: "query_dom", args: { tabId: 1, selector: "h1" }, async: true }, { session: s });
  await b1.call({ id: "hang-1", tool: "run_js", args: { tabId: 1, code: "1" }, async: true });
  await tick();
  await b1.jobs.flush();
  const b2 = makeBridge({ sessionStorage });
  const s2 = { ...s, sessionId: "s2" };
  const done = await b2.call({ id: "q1", tool: "job_status", args: { jobId: "done-1" } }, { session: s2 });
  assert.equal(done.result.status, "done", "same token, new session, new SW → result still there");
  const lost = await b2.call({ id: "q2", tool: "job_status", args: { jobId: "hang-1" } });
  assert.equal(lost.result.status, "interrupted");
  assert.match(lost.result.hint, /回读/);
  const foreign = await b2.call({ id: "q3", tool: "job_status", args: { jobId: "done-1" } });
  assert.equal(foreign.error.code, "JOB_NOT_FOUND", "legacy entry cannot read token jobs");
  hang?.();
}

// ---- native port: push sink + session close ----
{
  const posted = [];
  const listeners = {};
  const port = {
    postMessage: (m) => posted.push(m),
    disconnect: () => {},
    onMessage: { addListener: (fn) => (listeners.msg = fn) },
    onDisconnect: { addListener: (fn) => (listeners.dis = fn) },
  };
  const bridge = makeBridge();
  const closed = [];
  const origClose = bridge.closeSession;
  bridge.closeSession = (id) => {
    closed.push(id);
    origClose(id);
  };
  const gw = createNativeGateway({ bridge, connect: () => port, setTimer: () => 0, clearTimer: () => {} });
  gw.start();
  bridge.events.subscribe({ record: local, sessionId: "S" }, ["tab.updated"]);
  await bridge.events.emit({ type: "tab.updated", tabId: 1, url: "http://localhost:3000/" });
  assert.ok(!posted.some((m) => m.type === "bridge.event"), "no push before broker.ready");
  listeners.msg({ type: "broker.ready", socketPath: "/x" });
  await bridge.events.emit({ type: "tab.updated", tabId: 1, url: "http://localhost:3000/2" });
  const ev = posted.find((m) => m.type === "bridge.event");
  assert.equal(ev.sessionId, "S");
  assert.equal(ev.event.url, "http://localhost:3000/2");
  bridge.leases.claim(1, { sessionId: "S", agentName: "x" });
  listeners.msg({ type: "bridge.session.closed", sessionId: "S" });
  assert.deepEqual(closed, ["S"]);
  assert.equal(bridge.events.sessionCount(), 0);
  assert.equal(bridge.leases.size(), 0);
  bridge.events.subscribe({ record: local, sessionId: "T" }, ["tab.updated"]);
  listeners.dis();
  assert.equal(bridge.events.sessionCount(), 0, "port loss drops every session");
  gw.stop();
}

// ---- P5 agent_task.* + approval events: owning token only ----
{
  const { token: delTok, record: delegator } = await createTokenRecord({ name: "delegator", scopes: ["agent:delegate", "tabs:read", "page:act"], origins: ["http://localhost:*"] });
  const owners = new Map();
  const started = agentTaskBusEvent({ type: "agent_task.started", taskId: "task_1", at: 5, task: { id: "task_1", owner: delegator.id, prompt: "p" } }, owners);
  assert.deepEqual(started, { type: "agent_task.started", agentId: delegator.id, taskId: "task_1", ts: 5, task: { id: "task_1", prompt: "p" } }, "owner stripped from payload");
  assert.equal(agentTaskBusEvent({ type: "agent_task.step", taskId: "task_1", step: { n: 1 } }, owners).agentId, delegator.id, "owner remembered by taskId");
  assert.ok(agentTaskBusEvent({ type: "agent_task.finished", taskId: "task_1", status: "done" }, owners));
  assert.equal(owners.size, 0, "forgotten after finished");
  assert.equal(agentTaskBusEvent({ type: "agent_task.started", taskId: "task_2", task: { owner: null } }, owners), null, "legacy (ownerless) tasks are not routed");
  assert.equal(agentTaskBusEvent({ type: "job.done", taskId: "x" }, owners), null);

  const evs = approvalEvents(
    [{ id: "p1", status: "pending", principal: `token:${delegator.id}`, toolName: "cose_publish" }],
    [
      { id: "p1", status: "approved", principal: `token:${delegator.id}`, toolName: "cose_publish", item: { id: "publish" } },
      { id: "p2", status: "pending", principal: `token:${delegator.id}`, toolName: "trusted_click", reason: "提交", sessionId: "task_9" },
      { id: "p3", status: "pending", principal: "user", toolName: "x" },
    ],
  );
  assert.deepEqual(evs, [
    { type: "approval.resolved", agentId: delegator.id, pendingId: "p1", tool: "cose_publish", item: "publish", status: "approved" },
    { type: "approval.queued", agentId: delegator.id, pendingId: "p2", tool: "trusted_click", reason: "提交", taskId: "task_9" },
  ], "side-panel principals are ignored");

  const tokens = [delegator, local];
  const bus = createEventBus({ loadTokens: async () => tokens });
  assert.throws(() => bus.subscribe({ record: local, sessionId: "L" }, ["agent_task.*"]), (e) => e.code === "SCOPE_DENIED", "agent_task needs agent:delegate");
  bus.subscribe({ record: local, sessionId: "L" }, ["approval.*"]);
  bus.subscribe({ record: delegator, sessionId: "D1" }, ["agent_task.*", "approval.*"]);
  bus.subscribe({ record: delegator, sessionId: "D2" }, ["agent_task.finished"]);

  const listeners = [];
  const storageListeners = [];
  installEventSources(bus, { storage: { onChanged: { addListener: (fn) => storageListeners.push(fn) } } }, { onAgentTaskEvent: (fn) => listeners.push(fn) });
  listeners[0]({ type: "agent_task.started", taskId: "task_7", at: 1, task: { id: "task_7", owner: delegator.id } });
  listeners[0]({ type: "agent_task.approval", taskId: "task_7", pendingId: "p9", toolName: "cose_publish", reason: "发布" });
  listeners[0]({ type: "agent_task.finished", taskId: "task_7", status: "done", answer: "ok" });
  storageListeners[0]({ agentApprovalQueue: { oldValue: [], newValue: [{ id: "p9", status: "pending", principal: `token:${delegator.id}`, toolName: "cose_publish" }] } }, "local");
  storageListeners[0]({ agentApprovalQueue: { oldValue: [], newValue: [{ id: "p10", status: "pending", principal: `token:${delegator.id}` }] } }, "session");
  await bus.idle();
  assert.deepEqual(bus.poll("D1").events.map((e) => e.type), ["agent_task.started", "agent_task.approval", "agent_task.finished", "approval.queued"]);
  assert.deepEqual(bus.poll("D2").events.map((e) => e.type), ["agent_task.finished"], "every session of the owning token, per its subscription");
  assert.equal(bus.poll("L").events.length, 0, "other tokens never see the delegator's tasks or approvals");

  // CONFIRMATION_REQUIRED from a direct bridge call lands in the queue → approval.queued for that token
  const area = { list: [] };
  const approvals = createApprovalQueue({
    storage: {
      load: async () => area.list,
      save: async (list) => {
        const old = area.list;
        area.list = structuredClone(list);
        for (const e of approvalEvents(old, area.list)) bridgeA.events.emit(e);
      },
    },
  });
  const bridgeA = createBridge({
    getSettings: async () => ({ agentBridgeEnabled: false, agentBridgeOrigins: [], agentIrreversible: ["publish"] }),
    getAgentTokens: async () => [delegator],
    approvals,
    tabs: { get: async (id) => ({ id, windowId: 1, url: "http://localhost:3000/", title: "x" }), query: async () => [] },
    inject: async () => ({ ok: true }),
    cdp: { send: async () => ({}) },
    platform: () => "other",
    sleep: async () => {},
    now: () => Date.now(),
  });
  const sD = { token: delTok, sessionId: "sD", agentName: "d" };
  await bridgeA.call({ id: "sub", tool: "events_subscribe", args: { types: ["approval.queued"] } }, { session: sD });
  const pending = await approvals.enqueue({ toolName: "cose_publish", args: {}, principal: `token:${delegator.id}` });
  await bridgeA.events.idle();
  const queued = (await bridgeA.call({ id: "poll", tool: "events_poll", args: {} }, { session: sD })).result.events;
  assert.deepEqual(queued.map((e) => [e.type, e.pendingId]), [["approval.queued", pending.id]]);
}

// ---- delegated runs respect tab leases ----
{
  const { token: delTok, record: delegator } = await createTokenRecord({ name: "delegator", scopes: ["agent:delegate", "tabs:read", "page:act"], origins: ["http://localhost:*"] });
  let captured = null;
  const bridge = createBridge({
    getSettings: async () => ({ agentBridgeEnabled: false, agentBridgeOrigins: [] }),
    getAgentTokens: async () => [delegator, local],
    delegate: {
      start: async (p) => {
        captured = p.session;
        return { id: "task_x", status: "running", tabId: p.tabId, capsule: {}, capsuleSummary: [], droppedOrigins: [], maxSteps: 12 };
      },
    },
    tabs: { get: async (id) => ({ id, windowId: 1, url: "http://localhost:3000/", title: "x" }), query: async () => [] },
    inject: async () => ({ ok: true, matches: true }),
    cdp: { send: async () => ({}) },
    platform: () => "other",
    sleep: async () => {},
    now: () => Date.now(),
  });
  const sD = { token: delTok, sessionId: "sD", agentName: "delegator" };
  const sOther = { token: localTok, sessionId: "sO", agentName: "other" };
  const run = await bridge.call({ id: "r1", tool: "run_agent_task", args: { prompt: "在搜索框填 hi", tabId: 1 } }, { session: sD });
  assert.ok(run.ok, JSON.stringify(run));
  assert.equal(typeof captured.tabLease, "function");
  assert.equal(captured.tabLease(1), null, "unleased tab → allowed");
  await bridge.call({ id: "c1", tool: "tab_claim", args: { tabId: 1 } }, { session: sOther });
  assert.equal(captured.tabLease(1).code, "TAB_LEASED", "tab leased by another session → blocked");
  assert.equal(captured.tabLease(null), null);
  await bridge.call({ id: "r1", tool: "tab_release", args: {} }, { session: sOther });
  await bridge.call({ id: "c2", tool: "tab_claim", args: { tabId: 1 } }, { session: sD });
  assert.equal(captured.tabLease(1), null, "delegating session holds it → allowed");

  // inside the delegate loop: a write tool on a leased tab becomes a blocked step; reads still run
  const log = [];
  const def = (name) => ({ name, description: name, parameters: { type: "object", properties: {} }, execute: async (a) => (log.push(name), `${name} ok`) });
  let turn = 0;
  const manager = createDelegateManager({
    storage: memoryTaskStorage(),
    approvals: createApprovalQueue({ storage: memoryAdapter() }),
    loadSettings: async () => ({ hitlMode: "balanced" }),
    createRun: async () => ({
      tools: [def("extract_page"), def("fill")],
      systemPrompt: "t",
      getTabUrl: async () => "http://localhost:3000/",
      model: {
        async runTurn({ tools }) {
          turn += 1;
          if (turn === 1 && tools?.length) {
            return { content: "", finishReason: "tool_calls", toolCalls: [
              { id: "a", name: "extract_page", arguments: "{}" },
              { id: "b", name: "fill", arguments: JSON.stringify({ selector: "#q", value: "hi" }) },
            ] };
          }
          return { content: "done", finishReason: "stop", toolCalls: [] };
        },
      },
    }),
  });
  const task = await manager.start({
    prompt: "在这个页面的搜索框填写 hi",
    tabId: 7,
    sourceUrl: "http://localhost:3000/",
    session: { tokenId: delegator.id, agentName: "delegator", tabLease: (id) => (id === 7 ? { code: "TAB_LEASED", reason: "标签 7 已被「other」占用。" } : null) },
  });
  await manager.status(task.id);
  for (let i = 0; i < 50; i += 1) {
    const st = await manager.status(task.id);
    if (st.status !== "running") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const st = await manager.status(task.id);
  assert.deepEqual(log, ["extract_page"], "fill on the leased tab never ran");
  assert.ok(st.steps.some((s) => s.kind === "blocked" && s.name === "fill" && s.code === "TAB_LEASED"), JSON.stringify(st.steps));
}

console.log("PASS bridge-events");

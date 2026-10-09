/**
 * 网关端到端：spawn pagelens-host（模拟 Chrome connectNative 的 stdio 端口）→ broker socket →
 * 直连客户端 / MCP 垫片。扩展一侧用真实 createBridge + token 鉴权，chrome API 用假的。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeMessage, tryReadMessage } from "./pagelens-host.mjs";
import { connectGateway, defaultSocketPath } from "./gateway.mjs";
import { agentSlug, mcpConfigSnippets, saveTokenFile, writeCursorConfig } from "./install-native-host.mjs";
import { createBridge } from "../extension/lib/bridge/index.js";
import { createTokenRecord, generateToken } from "../extension/lib/bridge/auth.js";
import { createAuditLog } from "../extension/lib/bridge/audit.js";
import { DEFAULT_ALLOWED_ORIGINS } from "../extension/lib/bridge/policy.js";

const hostPath = fileURLToPath(new URL("./pagelens-host.mjs", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pagelens-gw-"));
const socketPath = path.join(tmp, "bridge.sock");
const children = [];

function cleanup() {
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`timeout: ${what}`)), ms);
    }),
  ]);
}

// ---- fake extension side ----
const tokens = [];
async function mint(name, scopes, origins) {
  const { token, record } = await createTokenRecord({ name, scopes, origins });
  tokens.push(record);
  return { token, record };
}
const readOnly = await mint("reader", ["tabs:read", "page:read"], ["http://localhost:*"]);
const full = await mint("cursor", ["tabs:read", "page:read", "page:act", "host:fs"], ["*"]);

const TABS = new Map([
  [1, { id: 1, windowId: 1, active: true, title: "Local", url: "http://localhost:8080/" }],
  [3, { id: 3, windowId: 1, active: false, title: "Bank", url: "https://bank.example/" }],
]);
const audit = createAuditLog({ load: async () => [], save: async () => true });
const bridge = createBridge({
  getSettings: async () => ({ agentBridgeEnabled: false, agentBridgeOrigins: [...DEFAULT_ALLOWED_ORIGINS], agentGatewayEnabled: true }),
  getAgentTokens: async () => tokens,
  auditLog: audit,
  tabs: {
    get: async (id) => {
      if (!TABS.has(id)) throw new Error(`No tab with id: ${id}`);
      return TABS.get(id);
    },
    query: async () => [...TABS.values()],
    create: async (props) => ({ id: 99, ...props }),
    update: async (id, props) => ({ id, ...props }),
  },
  inject: async () => ({ count: 0, items: [] }),
  runJs: async () => ({ ok: true, value: 1 }),
  cdp: { send: async (_tabId, method) => (method === "Page.captureScreenshot" ? { data: "/9j/AAAA" } : {}) },
  clipboard: { write: async () => ({ via: "fake" }) },
  platform: () => "other",
  sleep: async () => {},
  now: () => Date.now(),
  extensionVersion: () => "test",
});

/** 像 Chrome 一样拉起 host 并通过 stdio 帧对话；bridge.call 交给真实 bridge。 */
function spawnHostAsChrome(sock = socketPath) {
  const child = spawn(process.execPath, [hostPath, "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PAGELENS_SOCKET: sock },
  });
  children.push(child);
  const waiters = [];
  const inbox = [];
  let buf = Buffer.alloc(0);
  child.stdout.on("data", async (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let parsed;
    while ((parsed = tryReadMessage(buf))) {
      buf = parsed.rest;
      const msg = parsed.msg;
      if (msg.type === "bridge.call") {
        const response = await bridge.call(msg.request, {
          session: { token: msg.token, sessionId: msg.sessionId, agentName: msg.agentName },
        });
        child.stdin.write(encodeMessage({ type: "bridge.result", sessionId: msg.sessionId, callId: msg.callId, response }));
        continue;
      }
      if (msg.type === "bridge.session.closed") {
        bridge.closeSession(msg.sessionId);
        continue;
      }
      const i = waiters.findIndex((w) => w.match(msg));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
      else inbox.push(msg);
    }
  });
  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += c;
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return {
    child,
    exited,
    stderr: () => stderr,
    send: (msg) => child.stdin.write(encodeMessage(msg)),
    next(match) {
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
  };
}

function spawnMcp(args, env) {
  const child = spawn(process.execPath, [hostPath, "--mcp", ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PAGELENS_TOKEN: "", ...env },
  });
  children.push(child);
  let buf = "";
  const pending = new Map();
  const notes = [];
  const noteWaiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id == null && msg.method) {
        notes.push(msg);
        for (const w of noteWaiters.splice(0)) w();
        continue;
      }
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  let seq = 0;
  return {
    child,
    rpc(method, params = {}) {
      const id = ++seq;
      const p = new Promise((resolve) => pending.set(id, resolve));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return withTimeout(p, 8000, `mcp ${method}`);
    },
    notes,
    async waitNotes(n) {
      while (notes.length < n) await withTimeout(new Promise((r) => noteWaiters.push(r)), 5000, `mcp notifications (${notes.length}/${n})`);
      return notes;
    },
  };
}

try {
  assert.equal(defaultSocketPath({ env: {}, platform: "linux", home: "/home/u" }), "/home/u/.pagelens/bridge.sock");
  assert.equal(defaultSocketPath({ env: {}, platform: "win32", user: "a b" }), "\\\\.\\pipe\\pagelens-bridge-a_b");
  assert.equal(defaultSocketPath({ env: { PAGELENS_SOCKET: "/x.sock" } }), "/x.sock");

  // ---- gateway not running: clear MCP error ----
  {
    const mcp = spawnMcp([], { PAGELENS_TOKEN: full.token, PAGELENS_SOCKET: path.join(tmp, "missing.sock") });
    const init = await mcp.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    assert.equal(init.result.protocolVersion, "2024-11-05");
    const list = await mcp.rpc("tools/list");
    assert.ok(list.error && /网关未运行/.test(list.error.message), "gateway down → clear error: " + JSON.stringify(list));
    mcp.child.kill();
  }

  // ---- broker start ----
  const host = spawnHostAsChrome();
  bridge.events.setSink((sessionId, event) => host.send({ type: "bridge.event", sessionId, event }));
  host.send({ type: "broker.start", protocol: 2 });
  const ready = await withTimeout(host.next((m) => m.type === "broker.ready" || m.type === "broker.error"), 5000, "broker.ready");
  assert.equal(ready.type, "broker.ready", JSON.stringify(ready));
  assert.equal(ready.socketPath, socketPath);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600, "socket is 0600");

  // one-shot ops still work on the long-lived port
  host.send({ op: "ping" });
  const pong = await withTimeout(host.next((m) => m.op === "ping"), 5000, "ping on port");
  assert.ok(pong.ok);

  // second broker on the same socket refuses instead of hijacking it
  {
    const other = spawnHostAsChrome();
    other.send({ type: "broker.start" });
    const res = await withTimeout(other.next((m) => m.type), 5000, "second broker");
    assert.equal(res.type, "broker.error");
    assert.match(res.error, /已有 PageLens 网关/);
    other.child.stdin.end();
    await other.exited;
    assert.ok(fs.existsSync(socketPath), "losing broker must not unlink the live socket");
  }

  // ---- direct socket client ----
  await assert.rejects(connectGateway({ socketPath, token: "plk_nope" }), (e) => e.code === "UNAUTHORIZED");
  const reader = await connectGateway({ socketPath, token: readOnly.token, agentName: "script" });
  const names = reader.tools.map((t) => t.name);
  assert.ok(names.includes("list_tabs") && names.includes("screenshot") && names.includes("audit_log"), names.join());
  assert.ok(!names.includes("run_js") && !names.includes("paste_rich_trusted"), "scope-filtered tools");
  assert.equal(reader.agent.name, "reader");
  assert.ok(!("hash" in reader.agent), "hash never leaves the extension");

  const tabs = await reader.call({ id: "t1", tool: "list_tabs", args: {} });
  assert.ok(tabs.ok);
  assert.deepEqual(tabs.result.map((t) => t.id), [1], "only token origins visible");
  const js = await reader.call({ id: "t2", tool: "run_js", args: { tabId: 1, code: "1" } });
  assert.equal(js.error.code, "SCOPE_DENIED");
  const bank = await reader.call({ id: "t3", tool: "screenshot", args: { tabId: 3 } });
  assert.equal(bank.error.code, "ORIGIN_NOT_ALLOWED");
  const log = await reader.call({ id: "t4", tool: "audit_log", args: {} });
  assert.ok(log.ok && log.result.entries.length >= 3 && log.result.entries.every((e) => e.agent === "reader"));

  // ---- MCP shim (token file) ----
  const tokenFile = path.join(tmp, "cursor.token");
  fs.writeFileSync(tokenFile, `${full.token}\n`, { mode: 0o600 });
  const mcp = spawnMcp(["--token-file", tokenFile], { PAGELENS_SOCKET: socketPath });
  const mcpInit = await mcp.rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { experimental: { "pagelens/events": {} } },
    clientInfo: { name: "cursor", version: "1" },
  });
  assert.deepEqual(mcpInit.result.capabilities.logging, {}, "logging capability declared for event notifications");
  assert.ok(mcpInit.result.capabilities.experimental["pagelens/events"]);
  const list = await mcp.rpc("tools/list");
  const mcpNames = list.result.tools.map((t) => t.name);
  assert.ok(mcpNames.includes("screenshot") && mcpNames.includes("trusted_click"), mcpNames.join());
  assert.ok(mcpNames.includes("read_file") && !mcpNames.includes("exec_command"), "host:fs yes, host:shell no");
  assert.ok(!mcpNames.includes("list_tools"));
  assert.ok(list.result.tools.every((t) => t.inputSchema?.type === "object"));

  const shot = await mcp.rpc("tools/call", { name: "screenshot", arguments: { tabId: 3 } });
  assert.equal(shot.result.isError, false, JSON.stringify(shot));
  const image = shot.result.content.find((c) => c.type === "image");
  assert.ok(image && image.mimeType === "image/jpeg" && image.data === "/9j/AAAA", "screenshot → MCP image");

  const shell = await mcp.rpc("tools/call", { name: "exec_command", arguments: { command: "echo hi" } });
  assert.ok(shell.result.isError && /SCOPE_DENIED/.test(shell.result.content[0].text));
  fs.writeFileSync(path.join(tmp, "note.md"), "hello-fs");
  const file = await mcp.rpc("tools/call", { name: "read_file", arguments: { path: tmp, rel: "note.md" } });
  assert.equal(file.result.content[0].text, "hello-fs");

  const bad = await mcp.rpc("tools/call", { name: "run_js", arguments: { tabId: 1, code: "1" } });
  assert.ok(bad.result.isError && /SCOPE_DENIED/.test(bad.result.content[0].text));

  // ---- P3: two concurrent socket sessions + events + leases + MCP notifications ----
  {
    const seenR = [];
    const seenF = [];
    const r2 = await connectGateway({ socketPath, token: readOnly.token, agentName: "watcher", onEvent: (e) => seenR.push(e) });
    const f2 = await connectGateway({ socketPath, token: full.token, agentName: "claude", onEvent: (e) => seenF.push(e) });
    assert.notEqual(r2.sessionId, f2.sessionId);
    assert.ok(r2.tools.some((t) => t.name === "events_poll") && f2.tools.some((t) => t.name === "tab_claim"));
    const [subR, subF] = await Promise.all([
      r2.call({ id: "s1", tool: "events_subscribe", args: { types: ["tab.updated"] } }),
      f2.call({ id: "s1", tool: "events_subscribe", args: { types: ["tab.*", "dialog.opened"] } }),
    ]);
    assert.ok(subR.ok && subF.ok, JSON.stringify([subR, subF]));
    assert.equal(subR.result.push, true);
    const mcpSub = await mcp.rpc("tools/call", { name: "events_subscribe", arguments: { types: ["tab.updated"] } });
    assert.equal(mcpSub.result.isError, false, JSON.stringify(mcpSub));

    await bridge.events.emit({ type: "tab.updated", tabId: 3, url: "https://bank.example/", title: "Bank", status: "complete" });
    await bridge.events.emit({ type: "tab.updated", tabId: 1, url: "http://localhost:8080/", title: "Local", status: "complete" });
    const until = async (fn, what) => {
      for (let i = 0; i < 100 && !fn(); i += 1) await new Promise((r) => setTimeout(r, 20));
      assert.ok(fn(), what);
    };
    await until(() => seenF.length >= 2 && seenR.length >= 1, "event frames relayed to both sessions");
    assert.deepEqual(seenR.map((e) => e.url), ["http://localhost:8080/"], "localhost token never gets the bank tab");
    assert.deepEqual(seenF.map((e) => [e.seq, e.tabId]), [[1, 3], [2, 1]]);
    const polled = await r2.call({ id: "p1", tool: "events_poll", args: {} });
    assert.deepEqual(polled.result.events.map((e) => e.seq), [1], "ring buffer matches pushed frames");

    const notes = await mcp.waitNotes(4);
    const logs = notes.filter((n) => n.method === "notifications/message");
    const custom = notes.filter((n) => n.method === "notifications/pagelens/event");
    assert.equal(logs.length, 2);
    assert.equal(logs[0].params.level, "info");
    assert.equal(logs[0].params.logger, "pagelens");
    assert.equal(logs[0].params.data.url, "https://bank.example/");
    assert.deepEqual(custom.map((n) => n.params.event.tabId), [3, 1]);
    const setLevel = await mcp.rpc("logging/setLevel", { level: "warning" });
    assert.deepEqual(setLevel.result, {});
    await bridge.events.emit({ type: "tab.updated", tabId: 1, url: "http://localhost:8080/2", status: "complete" });
    await mcp.waitNotes(5);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(mcp.notes.slice(4).map((n) => n.method), ["notifications/pagelens/event"], "level above info mutes notifications/message");

    // leases across sessions
    const claim = await f2.call({ id: "c1", tool: "tab_claim", args: { tabId: 1 } });
    assert.ok(claim.ok, JSON.stringify(claim));
    const leased = await mcp.rpc("tools/call", { name: "set_input_value", arguments: { tabId: 1, selector: "#q", value: "x" } });
    assert.ok(leased.result.isError && /TAB_LEASED/.test(leased.result.content[0].text) && /claude/.test(leased.result.content[0].text), JSON.stringify(leased));
    const readStill = await mcp.rpc("tools/call", { name: "query_dom", arguments: { tabId: 1, selector: "h1" } });
    assert.equal(readStill.result.isError, false, "reads ignore leases");

    // closing a socket session releases its lease and subscription in the extension
    f2.close();
    r2.close();
    await until(() => bridge.leases.size() === 0 && bridge.events.sessionCount() === 1, "session close propagated to the extension");
    const freed = await mcp.rpc("tools/call", { name: "set_input_value", arguments: { tabId: 1, selector: "#q", value: "x" } });
    assert.ok(!/TAB_LEASED/.test(freed.result.content[0].text), JSON.stringify(freed));
  }

  // revoke takes effect on the next call of an open session
  tokens.splice(tokens.indexOf(full.record), 1, { ...full.record, revokedAt: Date.now() });
  const revoked = await mcp.rpc("tools/call", { name: "list_tabs", arguments: {} });
  assert.ok(revoked.result.isError && /UNAUTHORIZED/.test(revoked.result.content[0].text));

  const entries = await audit.list({ agentId: full.record.id });
  assert.ok(entries.some((e) => e.tool === "screenshot" && e.ok && e.origin === "https://bank.example"));
  assert.ok(entries.some((e) => e.code === "UNAUTHORIZED") || (await audit.list()).some((e) => e.code === "UNAUTHORIZED"));

  // ---- Chrome disconnects → broker exits and removes the socket ----
  reader.close();
  host.child.stdin.end();
  const code = await withTimeout(host.exited, 5000, "host exit");
  assert.equal(code, 0);
  assert.ok(!fs.existsSync(socketPath), "socket removed on exit");

  const after = await mcp.rpc("tools/call", { name: "list_tabs", arguments: {} });
  assert.ok(after.result.isError && /网关未运行|断开/.test(after.result.content[0].text), JSON.stringify(after));
  mcp.child.kill();

  // ---- installer: token file 0600 + MCP config snippets ----
  const fakeHome = path.join(tmp, "home");
  const plain = generateToken();
  assert.equal(agentSlug("My Cursor!"), "my-cursor");
  assert.throws(() => saveTokenFile("cursor", "not-a-token", fakeHome), /plk_/);
  const saved = saveTokenFile("Cursor", plain, fakeHome);
  assert.equal(saved, path.join(fakeHome, ".pagelens", "agents", "cursor.token"));
  assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(saved)).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(saved, "utf8").trim(), plain);
  const snip = mcpConfigSnippets("cursor", { home: fakeHome, nodePath: "/usr/bin/node", host: "/opt/pl/host.mjs" });
  assert.deepEqual(snip.cursor.mcpServers.pagelens, {
    command: "/usr/bin/node",
    args: ["/opt/pl/host.mjs", "--mcp", "--token-file", saved],
  });
  assert.equal(snip.claude, `claude mcp add --scope user pagelens -- /usr/bin/node /opt/pl/host.mjs --mcp --token-file ${saved}`);
  assert.match(snip.codex, /^\[mcp_servers\.pagelens\]/);
  const cursorFile = path.join(fakeHome, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
  fs.writeFileSync(cursorFile, JSON.stringify({ mcpServers: { other: { command: "x" } }, extra: 1 }));
  writeCursorConfig(snip.cursor, cursorFile);
  const merged = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.equal(merged.extra, 1);
  assert.ok(merged.mcpServers.other && merged.mcpServers.pagelens);
  fs.writeFileSync(cursorFile, "{broken");
  assert.throws(() => writeCursorConfig(snip.cursor, cursorFile), /不是合法 JSON/);
  assert.equal(fs.readFileSync(cursorFile, "utf8"), "{broken");

  console.log("PASS native-gateway");
} finally {
  cleanup();
}
process.exit(0);

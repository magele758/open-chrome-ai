#!/usr/bin/env node
/**
 * 端到端：真实 Chrome（临时 profile）+ Native Host 网关 + MCP 垫片。
 *
 *   CHROME_BIN=/usr/bin/google-chrome node extension/tools/e2e_gateway.mjs [--keep]
 *
 * 流程：加载解包扩展 → 在临时 profile 登记 com.pagelens.host → 在设置页 UI 里创建 token →
 * 打开网关 → MCP 垫片 initialize / tools/list / list_tabs / screenshot / query_dom / run_js（应 SCOPE_DENIED）
 * → 事件推送（MCP notifications、范围外标签不泄露）、第二个会话的标签租约、会话标签组、async 任务写入 storage.session
 * → 吊销 token 后调用被拒 → 关网关后 socket 消失。
 * 只用 mkdtemp 的 --user-data-dir 与临时 socket，不碰日常 profile 和 ~/.pagelens。不属于 run-tests。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CdpConnection, connectBridge } from "../../tools/pl-bridge.mjs";
import { connectGateway } from "../../native/gateway.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.E2E_CDP_PORT) || 9334;
const keep = process.argv.includes("--keep");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FIXTURE = `<!doctype html><meta charset="utf-8"><title>Gateway fixture</title>
<h1 id="hello">你好，外部 Agent</h1><ul><li class="item">one</li><li class="item">two</li></ul>`;

async function waitFor(fn, ms, what) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(200);
  }
  throw new Error(`等待超时：${what}（${last?.message || last}）`);
}

function launchChrome(profile, env) {
  const child = spawn(
    CHROME,
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      `--remote-debugging-port=${PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1100,800",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], env },
  );
  return new Promise((resolveLoad, reject) => {
    let buffer = "";
    child.stdio[4].on("data", (chunk) => {
      buffer += chunk.toString();
      for (const part of buffer.split("\0")) {
        if (!part.startsWith("{")) continue;
        const msg = JSON.parse(part);
        if (msg.id === 1) {
          if (msg.error) reject(new Error(`Extensions.loadUnpacked 失败：${JSON.stringify(msg.error)}`));
          else resolveLoad({ child, extensionId: msg.result.id });
        }
      }
    });
    child.on("exit", (code) => reject(new Error(`Chrome 提前退出：${code}`)));
    setTimeout(() => {
      child.stdio[3].write(`${JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path: join(ROOT, "extension") } })}\0`);
    }, 2500);
  });
}

function registerHost(profile, extensionId, work) {
  const runner = join(work, "pagelens-host");
  writeFileSync(runner, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, "native/pagelens-host.mjs"))} "$@"\n`);
  chmodSync(runner, 0o755);
  const dir = join(profile, "NativeMessagingHosts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "com.pagelens.host.json"),
    JSON.stringify({ name: "com.pagelens.host", description: "e2e", path: runner, type: "stdio", allowed_origins: [`chrome-extension://${extensionId}/`] }),
  );
}

function spawnMcp(env) {
  const child = spawn(process.execPath, [join(ROOT, "native/pagelens-host.mjs"), "--mcp"], { stdio: ["pipe", "pipe", "inherit"], env });
  let buf = "";
  const pending = new Map();
  const notes = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id == null && msg.method) notes.push(msg);
      else pending.get(msg.id)?.(msg);
    }
  });
  let seq = 0;
  return {
    child,
    notes,
    rpc(method, params = {}) {
      const id = ++seq;
      const p = new Promise((r) => pending.set(id, r));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return Promise.race([p, sleep(30000).then(() => ({ timeout: method }))]);
    },
  };
}

const results = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name} (${Date.now() - started}ms)${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}: ${err?.stack || err}`);
    throw err;
  }
}

const work = mkdtempSync(join(tmpdir(), "pagelens-e2e-gw-"));
const profile = join(work, "profile");
const socketPath = join(work, "bridge.sock");
const env = { ...process.env, PAGELENS_SOCKET: socketPath };
const server = http.createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(FIXTURE));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;

let chrome;
let bridge;
let mcp;
let token = "";
try {
  const launched = await launchChrome(profile, env);
  chrome = launched.child;
  const { extensionId } = launched;
  registerHost(profile, extensionId, work);
  console.log(`extension ${extensionId}, socket ${socketPath}`);

  const conn = await waitFor(() => CdpConnection.connect({ port: PORT }), 15000, "CDP");
  bridge = await connectBridge({ port: PORT, extensionId });
  await conn.send("Target.createTarget", { url: fixtureUrl });

  let page;
  await step("设置页 UI 创建 token", async () => {
    const { targetId } = await conn.send("Target.createTarget", { url: `chrome-extension://${extensionId}/sidepanel/index.html` });
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
    page = async (expression) => {
      const res = await conn.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
      return res.result.value;
    };
    page.sessionId = sessionId;
    page.cdp = (method, params) => conn.send(method, params, sessionId);
    await waitFor(() => page(`Boolean(document.querySelector("#btn-agent-token-create"))`), 10000, "settings DOM");
    await sleep(800);
    const blocked = await page(`(async () => {
      const box = document.querySelector("#agent-gateway");
      box.checked = true; box.dispatchEvent(new Event("change"));
      await new Promise(r => setTimeout(r, 300));
      return { checked: box.checked, status: document.querySelector("#agent-gateway-status").textContent };
    })()`);
    assert.equal(blocked.checked, false, "gateway cannot be enabled without a token");
    assert.match(blocked.status, /token/);
    token = await page(`(async () => {
      document.querySelector("#agent-token-name").value = "e2e-cursor";
      document.querySelector("#agent-token-preset").value = "operate";
      document.querySelector("#agent-token-origins").value = "http://127.0.0.1:*";
      document.querySelector("#btn-agent-token-create").click();
      for (let i = 0; i < 30 && !document.querySelector("#agent-token-value").textContent; i++) await new Promise(r => setTimeout(r, 100));
      return document.querySelector("#agent-token-value").textContent;
    })()`);
    assert.match(token, /^plk_[A-Za-z0-9_-]{43}$/);
    const stored = await bridge.evaluate(`chrome.storage.local.get("agentTokens").then(v => v.agentTokens)`);
    assert.equal(stored.length, 1);
    assert.ok(!JSON.stringify(stored).includes(token), "only the hash is stored");
    const listed = await page(`document.querySelector("#agent-token-list").textContent`);
    assert.match(listed, /e2e-cursor/);
    return `token ${token.slice(0, 8)}…, scopes ${stored[0].scopes.join(",")}`;
  });

  await step("UI 打开网关 → connectNative → broker socket", async () => {
    await page(`(() => { const b = document.querySelector("#agent-gateway"); b.checked = true; b.dispatchEvent(new Event("change")); })()`);
    await waitFor(() => existsSync(socketPath), 15000, "bridge.sock");
    const status = await waitFor(
      () => page(`document.querySelector("#agent-gateway-status").textContent`).then((t) => (/运行中/.test(t) ? t : null)),
      10000,
      "UI 显示运行中",
    );
    return status;
  });

  let tabId;
  await step("MCP 垫片 tools/list + list_tabs", async () => {
    mcp = spawnMcp({ ...env, PAGELENS_TOKEN: token });
    const init = await mcp.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { experimental: { "pagelens/events": {} } },
      clientInfo: { name: "e2e", version: "1" },
    });
    assert.equal(init.result.protocolVersion, "2024-11-05");
    assert.ok(init.result.capabilities.logging, "logging capability declared");
    const list = await mcp.rpc("tools/list");
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes("screenshot") && names.includes("trusted_click"), names.join());
    assert.ok(!names.includes("run_js") && !names.includes("exec_command"), "operate preset hides page:js / host:shell");
    const tabs = await mcp.rpc("tools/call", { name: "list_tabs", arguments: {} });
    const parsed = JSON.parse(tabs.result.content[0].text);
    assert.ok(parsed.every((t) => t.url.startsWith("http://127.0.0.1:")), "only token origins visible");
    tabId = parsed.find((t) => t.title === "Gateway fixture")?.id;
    assert.ok(tabId, JSON.stringify(parsed));
    return `${names.length} tools, fixture tab ${tabId}`;
  });

  await step("query_dom / screenshot（image）/ run_js 拒绝", async () => {
    const dom = await mcp.rpc("tools/call", { name: "query_dom", arguments: { tabId, selector: ".item" } });
    assert.equal(dom.result.isError, false, JSON.stringify(dom));
    assert.match(dom.result.content[0].text, /one/);
    const shot = await mcp.rpc("tools/call", { name: "screenshot", arguments: { tabId } });
    const img = shot.result.content.find((c) => c.type === "image");
    assert.ok(img && img.mimeType === "image/jpeg" && img.data.length > 1000, JSON.stringify(shot).slice(0, 300));
    writeFileSync(join(work, "shot.jpg"), Buffer.from(img.data, "base64"));
    const js = await mcp.rpc("tools/call", { name: "run_js", arguments: { tabId, code: "return 1" } });
    assert.ok(js.result.isError && /SCOPE_DENIED/.test(js.result.content[0].text));
    return `screenshot ${img.data.length} b64 chars`;
  });

  await step("事件推送 + 第二会话租约 + 标签组 + job 持久化", async () => {
    const sub = await mcp.rpc("tools/call", { name: "events_subscribe", arguments: { types: ["tab.*", "navigation.completed"] } });
    assert.equal(sub.result.isError, false, JSON.stringify(sub));
    const outside = fixtureUrl.replace("127.0.0.1", "localhost") + "outside";
    await conn.send("Target.createTarget", { url: outside });
    const opened = await mcp.rpc("tools/call", { name: "open_tab", arguments: { url: `${fixtureUrl}p3` } });
    assert.equal(opened.result.isError, false, JSON.stringify(opened));
    const newTab = JSON.parse(opened.result.content[0].text).tabId;
    const nav = await waitFor(
      () => mcp.notes.find((n) => n.method === "notifications/message" && n.params.data.type === "navigation.completed" && n.params.data.tabId === newTab),
      10000,
      "navigation.completed notification",
    );
    assert.equal(nav.params.level, "info");
    await waitFor(() => mcp.notes.some((n) => n.method === "notifications/pagelens/event" && n.params.event.tabId === newTab), 5000, "custom notification");
    await sleep(500);
    assert.ok(!JSON.stringify(mcp.notes).includes("localhost"), "out-of-range tab never leaks");
    const polled = await mcp.rpc("tools/call", { name: "events_poll", arguments: {} });
    const pollEvents = JSON.parse(polled.result.content[0].text).events;
    assert.ok(pollEvents.length > 0 && pollEvents.every((e) => e.url === null || e.url.startsWith("http://127.0.0.1:")), JSON.stringify(pollEvents));

    const groupId = await bridge.evaluate(`chrome.tabs.get(${newTab}).then(t => t.groupId)`);
    assert.ok(groupId > -1, "session-opened tab is grouped");
    const groupTitle = await bridge.evaluate(`chrome.tabGroups.get(${groupId}).then(g => g.title)`);
    assert.match(groupTitle, /^Agent: /);

    const second = await connectGateway({ socketPath, token, agentName: "e2e-second" });
    try {
      const claim = await second.call({ id: "claim-1", tool: "tab_claim", args: { tabId } });
      assert.ok(claim.ok, JSON.stringify(claim));
      const click = await mcp.rpc("tools/call", { name: "trusted_click", arguments: { tabId, selector: "#hello" } });
      assert.ok(click.result.isError && /TAB_LEASED/.test(click.result.content[0].text) && /e2e-second/.test(click.result.content[0].text), JSON.stringify(click));
      const read = await mcp.rpc("tools/call", { name: "query_dom", arguments: { tabId, selector: "#hello" } });
      assert.equal(read.result.isError, false);
      const ownOpened = await second.call({ id: "c-own", tool: "trusted_click", args: { tabId: newTab, selector: "h1" } });
      assert.equal(ownOpened.error?.code, "TAB_LEASED", "tab opened by the MCP session belongs to it");

      const job = await second.call({ id: "job-p3", tool: "query_dom", args: { tabId, selector: ".item" }, async: true });
      assert.equal(job.result.status, "running");
      const done = await waitFor(async () => {
        const st = await second.call({ id: `st-${Date.now()}`, tool: "job_status", args: { jobId: "job-p3" } });
        return st.result?.status === "done" ? st : null;
      }, 5000, "job done");
      assert.ok(done.result.response.ok);
      const persisted = await bridge.evaluate(`chrome.storage.session.get("agentBridgeJobs").then(v => (v.agentBridgeJobs || []).map(([k, j]) => [k.split("\u0000")[1], j.status]))`);
      assert.ok(persisted.some(([id, st]) => id === "job-p3" && st === "done"), JSON.stringify(persisted));
      const hang = await second.call({ id: "job-hang", tool: "wait_for", args: { tabId, selector: "#never", timeoutMs: 60000 }, async: true });
      assert.equal(hang.result.status, "running");
    } finally {
      second.close();
    }
    await waitFor(async () => {
      const r = await mcp.rpc("tools/call", { name: "trusted_click", arguments: { tabId, selector: "#hello" } });
      return !/TAB_LEASED/.test(r.result.content[0].text);
    }, 5000, "lease released when the second session disconnects");
    await mcp.rpc("tools/call", { name: "close_tab", arguments: { tabId: newTab } });
    return `${mcp.notes.length} notifications, group "${groupTitle}"`;
  });

  if (process.env.E2E_SHOT) {
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 420, height: 1500, deviceScaleFactor: 1, mobile: false });
    await page(`(async () => {
      // 没配模型时侧栏一打开就是设置页，按钮是开关
      if (document.querySelector("#view-settings").classList.contains("hidden")) document.querySelector("#btn-settings").click();
      await new Promise(r => setTimeout(r, 500));
      document.querySelector("#settings-tab-advanced").click();
      const g = document.querySelector("#settings-group-agents");
      g.open = true;
      document.querySelector("#btn-agent-audit-view").click();
      await new Promise(r => setTimeout(r, 500));
      g.scrollIntoView({ block: "start" });
    })()`);
    await sleep(300);
    const { data } = await page.cdp("Page.captureScreenshot", { format: "png" });
    writeFileSync(process.env.E2E_SHOT, Buffer.from(data, "base64"));
    console.log(`screenshot → ${process.env.E2E_SHOT}`);
  }

  await step("审计（UI 查看）", async () => {
    const text = await page(`(async () => {
      document.querySelector("#btn-agent-audit-view").click();
      for (let i = 0; i < 30 && !document.querySelector("#agent-audit-view").textContent; i++) await new Promise(r => setTimeout(r, 100));
      return document.querySelector("#agent-audit-view").textContent;
    })()`);
    assert.match(text, /e2e-cursor · screenshot @ http:\/\/127\.0\.0\.1/);
    assert.match(text, /run_js.*SCOPE_DENIED/);
    return text.split("\n")[0];
  });

  await step("UI 吊销 → 下一次调用 UNAUTHORIZED；最后一个 token 吊销后网关停止", async () => {
    await page(`(async () => {
      document.querySelector("#agent-token-name").value = "e2e-other";
      document.querySelector("#agent-token-preset").value = "read-only";
      document.querySelector("#btn-agent-token-create").click();
    })()`);
    await waitFor(() => page(`document.querySelector("#agent-token-list").textContent.includes("e2e-other")`), 5000, "second token listed");
    const revoke = (name) =>
      page(`(async () => {
        window.confirm = () => true;
        const li = [...document.querySelectorAll("#agent-token-list li")].find(li => li.textContent.includes(${JSON.stringify(name)}));
        [...li.querySelectorAll("button")].find(b => b.textContent === "吊销").click();
        await new Promise(r => setTimeout(r, 500));
      })()`);
    await revoke("e2e-cursor");
    const res = await mcp.rpc("tools/call", { name: "list_tabs", arguments: {} });
    assert.ok(res.result.isError && /UNAUTHORIZED/.test(res.result.content[0].text), JSON.stringify(res));
    assert.ok(existsSync(socketPath), "gateway keeps running while another token is active");
    await revoke("e2e-other");
    await waitFor(() => !existsSync(socketPath), 10000, "没有有效 token 后网关停止");
  });

  await step("SW 重启 → storage.session 里进行中的任务标 interrupted，已完成的保留", async () => {
    const before = await page(`chrome.storage.session.get("agentBridgeJobs").then(v => (v.agentBridgeJobs || []).map(([k, j]) => [k.split("\\u0000")[1], j.status]))`);
    assert.ok(before.some(([id, st]) => id === "job-hang" && st === "running"), JSON.stringify(before));
    bridge.close();
    await page.cdp("ServiceWorker.enable");
    await page.cdp("ServiceWorker.stopAllWorkers");
    await sleep(500);
    await page(`chrome.runtime.sendMessage({ type: "pl.agentGateway.status" }).catch(() => null)`);
    const after = await waitFor(async () => {
      const list = await page(`chrome.storage.session.get("agentBridgeJobs").then(v => (v.agentBridgeJobs || []).map(([k, j]) => [k.split("\\u0000")[1], j.status]))`);
      return list.some(([id, st]) => id === "job-hang" && st === "interrupted") ? list : null;
    }, 10000, "job-hang interrupted");
    assert.ok(after.some(([id, st]) => id === "job-p3" && st === "done"), JSON.stringify(after));
    return JSON.stringify(after);
  });

  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed${keep ? `; artifacts in ${work}` : ""}`);
} finally {
  mcp?.child.kill();
  bridge?.close();
  chrome?.kill();
  server.close();
  await sleep(500);
  if (!keep) rmSync(work, { recursive: true, force: true });
}
process.exit(results.every((r) => r.ok) ? 0 : 1);

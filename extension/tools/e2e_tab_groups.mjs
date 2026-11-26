#!/usr/bin/env node
/**
 * 端到端自动化测试：真实 Chrome（独立临时 profile）+ 解包加载当前 extension/，
 * 全程零弹窗、零人工操作，验证：
 *   1. 默认权限已一次性生效（tabGroups / tabs / nativeMessaging / cookies / host_permissions）
 *   2. 侧栏内部 Agent 全部 5 个标签组工具（含已折叠组查询、按组内 URL 检索、加组、更新展开/改名/改色/移位、移出、解散、关闭删除）
 *   3. 外部 Bridge 全部 5 个标签组工具 + origin 白名单隔离（私有组不可见、混合组隐藏域外标签并拒绝改/删）
 *   4. 侧栏读取当前文档和打开一个参考页时保持标签未分组
 *   5. 侧栏列出未打开的原生组且不能代开或删除，删除网页仍在加载的已打开组并保留同名的另一组
 *   6. 点击自定义「总结文章」，验证模型只读原文且全程未创建标签
 *
 *   node extension/tools/e2e_tab_groups.mjs [--headed] [--keep]
 *
 * 安全：只用 mkdtemp 的 --user-data-dir，不碰日常 Chrome profile，不改系统剪贴板。
 * 不属于 run-tests（文件名不以 test_ 开头）。
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CdpConnection, connectBridge } from "../../tools/pl-bridge.mjs";
import { readNativeSavedTabGroups } from "../../native/saved-tab-groups.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const keep = process.argv.includes("--keep");
const headed = keep || process.argv.includes("--headed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const summaryPrompt = "帮我看看这个网页文章讲了什么，总结内容，重点解释核心观点、论据和结论";
const articleFact = "研究人员在潮汐池观察了四十七只寄居蟹。";
const articleSummary = "研究在潮汐池观察了四十七只寄居蟹。";
const articleTail = "末尾的观测记录确认，降潮时它们会退回石缝。";
const summaryRequests = [];

function registerTempNativeHost(profile, extensionId, workDir) {
  const runner = join(workDir, "pagelens-host-e2e.sh");
  writeFileSync(
    runner,
    `#!/bin/sh\nexport PAGELENS_CHROME_USER_DATA_DIR=${JSON.stringify(profile)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, "native/pagelens-host.mjs"))} "$@"\n`,
  );
  chmodSync(runner, 0o755);
  const dir = join(profile, "NativeMessagingHosts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "com.pagelens.host.json"),
    JSON.stringify({
      name: "com.pagelens.host",
      description: "PageLens E2E temp host",
      path: runner,
      type: "stdio",
      allowed_origins: [`chrome-extension://${extensionId}/`],
    }),
  );
}

function startFixtureServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      summaryRequests.push(request);
      const hasTail = request.messages.at(-1)?.content?.includes(articleTail);
      const delta = { content: hasTail ? articleSummary : "正文末尾缺失。" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "article-fixture", context_length: 65536 }] }));
      return;
    }
    if (req.url === "/summary-article") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset="utf-8"><title>潮汐池观察</title><article><h1>潮汐池观察</h1><p>${articleFact}</p><p>${"Researchers recorded food, habitat and activity daily. ".repeat(210)}</p><p>${articleTail}</p></article>`);
      return;
    }
    const slug = (req.url || "/").replace(/[^a-z0-9/_-]/gi, "") || "/";
    const page = `<!doctype html><meta charset="utf-8"><title>Fixture ${slug}</title><h1>${slug}</h1>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (slug.startsWith("/open-delete/loading/")) {
      res.write(`${page}${" ".repeat(2048)}`);
      const finish = setTimeout(() => res.end(), 30000);
      res.once("close", () => clearTimeout(finish));
      return;
    }
    res.end(page);
  });
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen(server));
  });
}

function launchChrome(profile) {
  const args = [
    ...(headed ? [] : ["--headless=new"]),
    `--user-data-dir=${profile}`,
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1100,800",
    "--lang=zh-CN",
    "about:blank",
  ];
  const child = spawn(CHROME, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  return new Promise((resolveLoad, reject) => {
    let buffer = "";
    const fail = (error) => {
      clearTimeout(timer);
      child.kill("SIGTERM");
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("Extensions.loadUnpacked 超时")), 15000);
    child.stdio[4].on("data", (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split("\0");
      buffer = parts.pop();
      for (const part of parts) {
        if (!part) continue;
        const msg = JSON.parse(part);
        if (msg.id === 1) {
          clearTimeout(timer);
          if (msg.error) fail(new Error(`Extensions.loadUnpacked 失败：${JSON.stringify(msg.error)}`));
          else resolveLoad({ child, extensionId: msg.result.id });
        }
      }
    });
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Chrome 提前退出：${signal || code}`));
    });
    child.stdio[3].on("error", fail);
    const request = { id: 1, method: "Extensions.loadUnpacked", params: { path: join(ROOT, "extension") } };
    child.stdio[3].write(JSON.stringify(request) + "\0");
  });
}

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

const results = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name} (${Date.now() - started}ms)${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    results.push({ name, ok: false, error: err?.message || String(err) });
    console.log(`FAIL ${name}: ${err?.stack || err}`);
  }
}

const server = await startFixtureServer();
const work = mkdtempSync(join(tmpdir(), "pl-e2e-tabgroups-"));
const profile = join(work, "profile");
mkdirSync(profile, { recursive: true });
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const privateBase = `http://localhost:${port}`;
let chrome = null;
let conn = null;
let bridge = null;

try {
  const launched = await launchChrome(profile);
  chrome = launched.child;
  const { extensionId } = launched;
  registerTempNativeHost(profile, extensionId, work);
  console.log(`Chrome 已启动（${headed ? "有头" : "无头"}，临时 profile），扩展 ${extensionId}`);
  await sleep(1000);

  const debugPort = await waitFor(() => {
    const [port] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n");
    return Number(port);
  }, 15000, "临时 Chrome 的 CDP 端口");
  conn = await waitFor(() => CdpConnection.connect({ port: debugPort }), 15000, "CDP");
  bridge = await connectBridge({ port: debugPort, extensionId });

  const { targetId: panelTarget } = await conn.send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/sidepanel/index.html`,
  });
  const { sessionId: panelSession } = await conn.send("Target.attachToTarget", { targetId: panelTarget, flatten: true });
  const evalPanel = async (expression, { timeoutMs = 15000 } = {}) => {
    const res = await Promise.race([
      conn.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, panelSession),
      sleep(timeoutMs).then(() => {
        throw new Error(`panel evaluate 超时（${timeoutMs}ms）`);
      }),
    ]);
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || "panel evaluate 失败");
    }
    return res.result.value;
  };
  await waitFor(
    () => evalPanel(`document.readyState === "complete" && location.protocol === "chrome-extension:" && Boolean(chrome?.permissions?.contains)`),
    10000,
    "sidepanel ready",
  );

  await step("默认权限已全部生效（零弹窗）", async () => {
    const perms = await bridge.evaluate(`(async () => ({
      tabGroups: await chrome.permissions.contains({ permissions: ["tabGroups"] }),
      tabs: await chrome.permissions.contains({ permissions: ["tabs"] }),
      nativeMessaging: await chrome.permissions.contains({ permissions: ["nativeMessaging"] }),
      cookies: await chrome.permissions.contains({ permissions: ["cookies"] }),
      host: await chrome.permissions.contains({ origins: ["http://127.0.0.1/*"] }),
      apiReady: typeof chrome.tabGroups?.query === "function" && typeof chrome.tabs?.group === "function",
    }))()`);
    for (const [k, v] of Object.entries(perms)) assert.equal(v, true, `permission ${k} should be granted by default`);
    const promptCount = await evalPanel(`document.querySelectorAll(".pl-permission").length`);
    assert.equal(promptCount, 0, "sidepanel shows zero permission popups");
    return JSON.stringify(perms);
  });

  await bridge.evaluate(`chrome.storage.local.set({ settings: { agentBridgeEnabled: true, agentBridgeOrigins: ["http://127.0.0.1:*"] } })`);

  await step("hello 暴露全部 10 个标签组 + 已保存标签组 Bridge 工具", async () => {
    const hello = await bridge.hello();
    assert.equal(hello.enabled, true);
    const names = hello.tools.map((t) => t.name);
    for (const tool of [
      "list_tab_groups", "group_tabs", "update_tab_group", "ungroup_tabs", "close_tab_group",
      "list_saved_tab_groups", "save_tab_group", "open_saved_tab_group", "update_saved_tab_group", "delete_saved_tab_group",
    ]) {
      assert.ok(names.includes(tool), `missing ${tool}`);
    }
    return `${hello.tools.length} tools`;
  });

  let tabA;
  let tabB;
  let tabC;
  let privateTab;
  await step("打开测试标签页并验证可直接读取标题与 URL", async () => {
    tabA = await bridge.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(`${base}/alpha`)}, active: false }).then(t => t.id)`);
    tabB = await bridge.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(`${base}/beta`)}, active: false }).then(t => t.id)`);
    tabC = await bridge.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(`${base}/gamma`)}, active: false }).then(t => t.id)`);
    privateTab = await bridge.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(`${privateBase}/secret`)}, active: false }).then(t => t.id)`);
    await waitFor(
      () => bridge.evaluate(`chrome.tabs.get(${tabA}).then(t => t.status === "complete" && t.title.includes("/alpha"))`),
      8000,
      "fixture tabs loaded",
    );
    await waitFor(
      () => bridge.evaluate(`chrome.tabs.get(${privateTab}).then(t => t.status === "complete" && t.url.includes("localhost"))`),
      8000,
      "private tab loaded",
    );
    return `tabs=[${tabA},${tabB},${tabC}], private=${privateTab}`;
  });

  await step("总结当前文档和打开单个参考链接均不建组", async () => {
    const result = await evalPanel(`(async () => {
      const { createAgentTools } = await import("../lib/agent/tools.js");
      const { loadTabPack } = await import("../lib/page-pack.js");
      const windowId = (await chrome.tabs.get(${tabA})).windowId;
      const tools = createAgentTools({ getTabId: () => ${tabA}, getWindowId: () => windowId, refreshPack: loadTabPack });
      const run = (name, args = {}) => tools.find(tool => tool.name === name).execute(args);
      const groupsBefore = await chrome.tabGroups.query({ windowId });
      const info = JSON.parse(await run("get_page_info"));
      const documentText = await run("extract_page");
      const { opened } = JSON.parse(await run("open_tab", { url: ${JSON.stringify(`${base}/single-reference`)} }));
      try {
        return {
          info,
          documentText,
          groupCountBefore: groupsBefore.length,
          groupCountAfter: (await chrome.tabGroups.query({ windowId })).length,
          sourceGroup: (await chrome.tabs.get(${tabA})).groupId,
          referenceGroup: (await chrome.tabs.get(opened.id)).groupId,
        };
      } finally {
        await chrome.tabs.remove(opened.id);
      }
    })()`);
    assert.equal(result.info.domAvailable, true);
    assert.equal(result.info.url, `${base}/alpha`);
    assert.deepEqual(result.info.headings, [{ tag: "h1", text: "/alpha" }]);
    assert.match(result.documentText, /\n\n\/alpha/);
    assert.equal(result.groupCountAfter, result.groupCountBefore);
    assert.equal(result.sourceGroup, -1);
    assert.equal(result.referenceGroup, -1);
  });

  await step("批量自动化使用临时组，收尾解组并保留网页和手动组", async () => {
    const result = await evalPanel(`(async () => {
      const { createAgentTools, createTaskTabGroups } = await import("../lib/agent/tools.js");
      const windowId = (await chrome.tabs.get(${tabA})).windowId;
      const taskTabGroups = createTaskTabGroups({ getWindowId: () => windowId, getTitle: () => "E2E 批量自动化" });
      const tools = createAgentTools({ getTabId: () => ${tabA}, getWindowId: () => windowId, taskTabGroups });
      const open = async url => JSON.parse(await tools.find(tool => tool.name === "open_tab").execute({ url, taskGroup: true }));
      const manual = await chrome.tabs.create({ windowId, url: ${JSON.stringify(`${base}/manual-group`)}, active: false });
      const manualGroup = await chrome.tabs.group({ tabIds: [manual.id], createProperties: { windowId } });
      const first = await open(${JSON.stringify(`${base}/batch-task-1`)});
      const firstGroup = (await chrome.tabs.get(first.opened.id)).groupId;
      const second = await open(${JSON.stringify(`${base}/batch-task-2`)});
      const openedIds = [first.opened.id, second.opened.id];
      try {
        const grouped = await chrome.tabs.query({ windowId, groupId: second.groupId });
        await taskTabGroups.cleanup();
        return {
          firstGroup,
          groupId: second.groupId,
          grouped: grouped.map(tab => tab.id),
          openedIds,
          after: await Promise.all(openedIds.map(id => chrome.tabs.get(id).then(tab => tab.groupId))),
          manualGroup,
          manualAfter: (await chrome.tabs.get(manual.id)).groupId,
          temporaryGroupGone: await chrome.tabGroups.get(second.groupId).then(() => false, () => true),
        };
      } finally {
        await taskTabGroups.cleanup();
        await chrome.tabs.ungroup([manual.id]);
        await chrome.tabs.remove([...openedIds, manual.id]);
      }
    })()`);
    assert.equal(result.firstGroup, -1);
    assert.ok(Number.isInteger(result.groupId) && result.groupId >= 0);
    assert.deepEqual(result.grouped, result.openedIds);
    assert.deepEqual(result.after, [-1, -1]);
    assert.equal(result.manualAfter, result.manualGroup);
    assert.equal(result.temporaryGroupGone, true);
  });

  await step("侧栏内部 Agent 5 工具全流程（含折叠组、按组内 URL 检索、更新、解散、删除）", async () => {
    const out = await evalPanel(`(async () => {
      const { createTabGroupTools } = await import("../lib/agent/tab-group-tools.js");
      const win = await chrome.windows.getCurrent();
      const tools = createTabGroupTools({ getWindowId: () => win.id });
      const run = async (name, args = {}) => JSON.parse(await tools.find(t => t.name === name).execute(args));

      // 1. 新建已折叠的标签组
      const created = await run("group_tabs", { tabIds: [${tabA}, ${tabB}], title: "E2E 折叠组", color: "blue", collapsed: true });
      const gid = created.group.id;

      // 2. 查询已折叠标签组（按组内 URL 子串 alpha 命中）
      const listedCollapsed = await run("list_tab_groups", { collapsed: true, query: "alpha" });

      // 3. 加入已有标签组
      const added = await run("group_tabs", { tabIds: [${tabC}], groupId: gid });
      const afterAdd = await run("list_tab_groups", { query: "E2E" });

      // 4. 更新名称、颜色、展开、移到最前
      const updated = await run("update_tab_group", { groupId: gid, title: "E2E 已展开", color: "green", collapsed: false, index: 0 });
      const realGroupAfterUpdate = await chrome.tabGroups.get(gid);

      // 5. 移出单个标签（保留网页）
      const ungroupedOne = await run("ungroup_tabs", { tabIds: [${tabC}] });
      const tabCAfterUngroup = await chrome.tabs.get(${tabC});

      // 6. 新建第二组并整组解散（不关网页）
      const g2 = await run("group_tabs", { tabIds: [${tabC}], title: "临时解散组", color: "pink" });
      const dissolved = await run("ungroup_tabs", { groupId: g2.group.id });
      const tabCAfterDissolve = await chrome.tabs.get(${tabC});

      // 7. 删除并关闭第一组
      const closed = await run("close_tab_group", { groupId: gid });
      let gidStillExists = true;
      try { await chrome.tabGroups.get(gid); } catch { gidStillExists = false; }

      return {
        created,
        listedCollapsed,
        added,
        afterAddTabs: afterAdd.groups[0]?.tabs.map(t => t.id),
        updated,
        realGroupAfterUpdate,
        ungroupedOne,
        tabCAfterUngroupGroupId: tabCAfterUngroup.groupId,
        dissolved,
        tabCAfterDissolveGroupId: tabCAfterDissolve.groupId,
        closed,
        gidStillExists,
        promptCount: document.querySelectorAll(".pl-permission").length,
      };
    })()`);

    assert.equal(out.promptCount, 0, "zero permission prompts during full flow");
    assert.equal(out.created.ok, true);
    assert.equal(out.created.group.collapsed, true);
    assert.equal(out.listedCollapsed.count, 1);
    assert.equal(out.listedCollapsed.groups[0].collapsed, true);
    assert.equal(out.listedCollapsed.groups[0].tabCount, 2);
    assert.equal(out.listedCollapsed.groups[0].tabs.some((t) => t.url.includes("/alpha")), true);
    assert.equal(out.added.ok, true);
    assert.equal(out.afterAddTabs.length, 3);
    assert.equal(out.updated.ok, true);
    assert.equal(out.realGroupAfterUpdate.title, "E2E 已展开");
    assert.equal(out.realGroupAfterUpdate.color, "green");
    assert.equal(out.realGroupAfterUpdate.collapsed, false);
    assert.deepEqual(out.ungroupedOne.ungrouped, [tabC]);
    assert.equal(out.tabCAfterUngroupGroupId, -1);
    assert.equal(out.dissolved.dissolved, true);
    assert.equal(out.tabCAfterDissolveGroupId, -1);
    assert.equal(out.closed.closedCount, 2);
    assert.equal(out.gidStillExists, false);
    return `groupId=${out.created.group.id}, collapsed→expanded, 2→3→2→closed, prompts=0`;
  });

  await step("外部 Bridge 5 工具全流程 + 白名单隔离（私有组不可见、混合组拒改/拒删）", async () => {
    const t1 = (await bridge.call("open_tab", { url: `${base}/b1` })).result.tabId;
    const t2 = (await bridge.call("open_tab", { url: `${base}/b2` })).result.tabId;
    const tMix = (await bridge.call("open_tab", { url: `${base}/mix` })).result.tabId;
    await waitFor(
      () => bridge.evaluate(`Promise.all([${t1},${t2},${tMix}].map(id => chrome.tabs.get(id))).then(ts => ts.every(t => t.url.includes("127.0.0.1")))`),
      8000,
      "bridge tabs committed",
    );

    // 私有组（全白名单外）与混合组（白名单内 + 白名单外）
    const { privGid, mixGid } = await bridge.evaluate(`(async () => {
      const privGid = await chrome.tabs.group({ tabIds: [${privateTab}] });
      await chrome.tabGroups.update(privGid, { title: "Private Bank", color: "red", collapsed: true });
      const mixGid = await chrome.tabs.group({ tabIds: [${tMix}] });
      await chrome.tabGroups.update(mixGid, { title: "Mixed", color: "yellow" });
      const extraPriv = await chrome.tabs.create({ url: ${JSON.stringify(`${privateBase}/mixed-secret`)}, active: false });
      await chrome.tabs.group({ tabIds: [extraPriv.id], groupId: mixGid });
      return { privGid, mixGid, extraPrivId: extraPriv.id };
    })()`);
    await sleep(500);

    // 1. Bridge 新建折叠组
    const created = (await bridge.call("group_tabs", { tabIds: [t1, t2], title: "Bridge Group", color: "purple", collapsed: true })).result;
    assert.equal(created.created, true);
    assert.equal(created.group.title, "Bridge Group");
    assert.equal(created.group.collapsed, true);
    const gid = created.group.id;

    // 2. Bridge list_tab_groups：可见白名单折叠组 & 混合组（hiddenTabs=1），私有组完全不可见
    const listedAll = (await bridge.call("list_tab_groups", {})).result;
    assert.ok(listedAll.some((g) => g.id === gid && g.collapsed === true && g.tabCount === 2 && g.hiddenTabs === 0));
    const mixRow = listedAll.find((g) => g.id === mixGid);
    assert.ok(mixRow && mixRow.tabCount === 2 && mixRow.hiddenTabs === 1 && mixRow.tabs.length === 1);
    assert.ok(!listedAll.some((g) => g.id === privGid), "private group must not leak");
    assert.ok(!JSON.stringify(listedAll).includes("Private Bank"));
    assert.ok(!JSON.stringify(listedAll).includes("mixed-secret"));

    // 3. 私有组和混合组一律拒绝更新 / 解散 / 删除
    for (const blockedGid of [privGid, mixGid]) {
      assert.equal((await bridge.callRaw("update_tab_group", { groupId: blockedGid, title: "Hacked" })).error.code, "ORIGIN_NOT_ALLOWED");
      assert.equal((await bridge.callRaw("ungroup_tabs", { groupId: blockedGid })).error.code, "ORIGIN_NOT_ALLOWED");
      assert.equal((await bridge.callRaw("close_tab_group", { groupId: blockedGid })).error.code, "ORIGIN_NOT_ALLOWED");
    }

    // 4. Bridge 更新允许的标签组：展开、改名、改色、移位
    const updated = (await bridge.call("update_tab_group", { groupId: gid, title: "Bridge Open", color: "orange", collapsed: false, index: -1 })).result;
    assert.equal(updated.group.title, "Bridge Open");
    assert.equal(updated.group.color, "orange");
    assert.equal(updated.group.collapsed, false);

    // 5. Bridge 移出单个标签
    const ungrouped = (await bridge.call("ungroup_tabs", { tabIds: [t2] })).result;
    assert.deepEqual(ungrouped.ungrouped, [t2]);
    assert.equal(await bridge.evaluate(`chrome.tabs.get(${t2}).then(t => t.groupId)`), -1);

    // 6. Bridge 删除并关闭标签组
    const closed = (await bridge.call("close_tab_group", { groupId: gid })).result;
    assert.equal(closed.closed, true);
    assert.deepEqual(closed.closedTabIds, [t1]);
    assert.equal(await bridge.evaluate(`chrome.tabGroups.get(${gid}).then(() => true, () => false)`), false);

    return `bridge groupId=${gid} full CRUD ok; privGid=${privGid} & mixGid=${mixGid} isolated`;
  });

  await step("已保存标签组：单行和批量确认、取消，PageLens 保存库 CRUD", async () => {
    // 1. 在新窗口创建 Chrome 原生标签组并关闭该窗口，使其成为真正的「已保存但已关闭」原生标签组
    await bridge.evaluate(`(async () => {
      const w = await chrome.windows.create({ url: ${JSON.stringify(`${base}/tiktok-mx-1`)}, focused: false });
      const t2 = await chrome.tabs.create({ windowId: w.id, url: ${JSON.stringify(`${base}/tiktok-mx-2`)}, active: false });
      const g = await chrome.tabs.group({ tabIds: [w.tabs[0].id, t2.id], createProperties: { windowId: w.id } });
      await chrome.tabGroups.update(g, { title: "TikTok MX 测试组", color: "orange" });
      await new Promise(r => setTimeout(r, 800));
      await chrome.windows.remove(w.id);
      await new Promise(r => setTimeout(r, 800));
    })()`);

    // 2. 侧栏工具通过真实 Chrome Native Messaging 读取 Sync Data/LevelDB 查出已关闭原生组，并测试重建 + PageLens 库增删改查
    const out = await evalPanel(`(async () => {
      const { createSavedTabGroupTools } = await import("../lib/agent/saved-tab-group-tools.js");
      const { nativeSavedTabGroups } = await import("../lib/native-host.js");
      const firstRead = await nativeSavedTabGroups({ action: "list" });
      if (!firstRead.ok) throw Error(firstRead.error);
      const { savedTabGroupsProfileMarker } = await chrome.storage.local.get("savedTabGroupsProfileMarker");
      if (!savedTabGroupsProfileMarker || firstRead.profileMarker !== savedTabGroupsProfileMarker || firstRead.profile !== "Default") {
        throw Error("真实 Native Host 未返回临时 Chrome 配置中的扩展标识");
      }
      const win = await chrome.windows.getCurrent();
      const tools = createSavedTabGroupTools({ getWindowId: () => win.id });
      const run = async (name, args = {}) => JSON.parse(await tools.find(t => t.name === name).execute(args));

      const openNow = await chrome.tabGroups.query({});
      const closedList = await run("list_saved_tab_groups", { source: "chrome_native", query: "TikTok" });
      const closedOnly = await run("list_saved_tab_groups", { source: "chrome_native", closedOnly: true, query: "TikTok" });

      const stashed = await run("save_tab_group", {
        title: "PL 归档组",
        tabs: [${JSON.stringify(`${base}/tiktok-mx-1`)}, ${JSON.stringify(`${base}/tiktok-mx-2`)}],
      });

      // 更新 PageLens 保存库（改名、改色、加 URL）
      const updated = await run("update_saved_tab_group", {
        id: stashed.group.id,
        title: "PL 归档组 v2",
        color: "cyan",
        addUrls: [${JSON.stringify(`${base}/tiktok-mx-3`)}],
      });

      // 一键恢复打开为真实 Chrome 标签组
      const reopened = await run("open_saved_tab_group", { id: stashed.group.id });
      const realReopened = await chrome.tabGroups.get(reopened.group.id);
      const realTabs = await chrome.tabs.query({ groupId: reopened.group.id });

      // 清理打开的测试标签与保存库记录
      await chrome.tabs.remove(realTabs.map(t => t.id));
      const deleted = await run("delete_saved_tab_group", { id: stashed.group.id });
      const afterDel = await run("list_saved_tab_groups", { source: "pagelens" });

      return {
        openHasTikTok: openNow.some(g => g.title === "TikTok MX 测试组"),
        closedList,
        closedOnly,
        stashed,
        updated,
        realReopened,
        realTabCount: realTabs.length,
        deleted,
        afterDelCount: afterDel.pagelens.count,
      };
    })()`);

    assert.equal(out.openHasTikTok, false, "native group is genuinely closed in Chrome");
    const closedTikTok = out.closedList.chromeNative.groups.find((g) => g.title === "TikTok MX 测试组");
    assert.ok(out.closedList.chromeNative.count >= 1, "a closed native group stays listed");
    assert.equal(closedTikTok.isOpen, false);
    assert.equal(closedTikTok.openGroupId, undefined);
    assert.equal(out.closedOnly.code, "OPEN_IN_CHROME_REQUIRED");
    const closedRow = JSON.stringify(`[data-sg-key="native:${closedTikTok.guid}"]`);
    await evalPanel(`document.querySelector("#saved-groups-panel").open = true;
      document.querySelector("#btn-sg-refresh").click()`);
    await waitFor(() => evalPanel(`Boolean(document.querySelector(${closedRow}))`), 12000, "侧栏显示未打开的测试组");
    const single = await evalPanel(`(() => {
      const row = document.querySelector(${closedRow});
      const checked = row.querySelector(".sg-check").checked;
      const del = row.querySelector(".sg-del-btn");
      const dialog = document.querySelector("#sg-dialog");
      return {
        checked,
        deleteDisabled: del.disabled,
        deleteTitle: del.title,
        dialogClosed: !dialog.open,
      };
    })()`);
    assert.equal(single.checked, false);
    assert.equal(single.deleteDisabled, true);
    assert.match(single.deleteTitle, /请先在 Chrome 中打开该组/);
    assert.equal(single.dialogClosed, true);
    const selection = await evalPanel(`(() => {
      const search = document.querySelector("#sg-search");
      const setSearch = value => { search.value = value; search.dispatchEvent(new Event("input")); };
      const selectAll = document.querySelector("#sg-select-all");
      const checkbox = () => document.querySelector(${closedRow}).querySelector(".sg-check");
      setSearch("TikTok MX 测试组");
      checkbox().click();
      const singlySelected = checkbox().checked;
      selectAll.click();
      const cleared = !checkbox().checked;
      selectAll.click();
      const selectedAll = checkbox().checked && selectAll.checked;
      const batchDelete = document.querySelector("#btn-sg-batch-delete");
      const deleteEnabled = !batchDelete.disabled;
      const hint = document.querySelector("#sg-selection-hint").textContent;
      batchDelete.click();
      const confirmation = document.querySelector("#sg-dialog").open
        ? document.querySelector("#sg-dialog-message").textContent : "";
      selectAll.click();
      setSearch("");
      return { singlySelected, cleared, selectedAll, deleteEnabled, confirmation, hint };
    })()`);
    assert.equal(selection.singlySelected, true);
    assert.equal(selection.cleared, true);
    assert.equal(selection.selectedAll, true);
    assert.equal(selection.deleteEnabled, false);
    assert.equal(selection.confirmation, "");
    assert.match(selection.hint, /1 个未打开的 Chrome 保存组需先在 Chrome 中打开/);
    const afterCancel = await bridge.evaluate("chrome.tabGroups.query({})");
    assert.ok(afterCancel.every(group => group.title !== closedTikTok.title), "the closed group stays closed");
    assert.equal(out.stashed.ok, true);
    assert.equal(out.stashed.source, "pagelens");
    assert.equal(out.updated.group.title, "PL 归档组 v2");
    assert.equal(out.updated.group.tabCount, 3);
    assert.equal(out.realReopened.title, "PL 归档组 v2");
    assert.equal(out.realReopened.color, "cyan");
    assert.equal(out.realTabCount, 3);
    assert.equal(out.deleted.ok, true);
    assert.equal(out.afterDelCount, 0);

    // 3. 验证单组窗口里用 delete_saved_tab_group 删除已打开原生组时，先 ungroup 再 remove 不会在 Chrome LevelDB 留下幽灵保存组
    const ghostCheck = await evalPanel(`(async () => {
      const { createSavedTabGroupTools } = await import("../lib/agent/saved-tab-group-tools.js");
      const w = await chrome.windows.create({ url: ${JSON.stringify(`${base}/single-win-1`)}, focused: false });
      const t2 = await chrome.tabs.create({ windowId: w.id, url: ${JSON.stringify(`${base}/single-win-2`)}, active: false });
      const g = await chrome.tabs.group({ tabIds: [w.tabs[0].id, t2.id], createProperties: { windowId: w.id } });
      await chrome.tabGroups.update(g, { title: "SingleWin Ghost Check", color: "red" });
      await new Promise(r => setTimeout(r, 1000));
      const tools = createSavedTabGroupTools({ getWindowId: () => w.id });
      const run = async (name, args = {}) => JSON.parse(await tools.find(t => t.name === name).execute(args));
      const before = await run("list_saved_tab_groups", { source: "chrome_native", query: "SingleWin Ghost Check" });
      const targetGuid = before.chromeNative.groups[0]?.guid;
      const del = await run("delete_saved_tab_group", { guid: targetGuid });
      await new Promise(r => setTimeout(r, 1000));
      const after = await run("list_saved_tab_groups", { source: "chrome_native", query: "SingleWin Ghost Check" });
      return { beforeCount: before.chromeNative.count, del, afterCount: after.chromeNative.count };
    })()`);
    assert.equal(ghostCheck.beforeCount, 1, "SingleWin group exists in Chrome Sync LevelDB before delete");
    assert.equal(ghostCheck.del.ok, true);
    assert.equal(ghostCheck.del.verifiedRemoved, true, "reported success requires a GUID readback");
    assert.equal(ghostCheck.afterCount, 0, "SingleWin group completely removed from Chrome Sync LevelDB (no ghost group!)");

    // 4. Bridge list_saved_tab_groups 也经真实 Native Messaging 查到白名单原生关闭组，并屏蔽私有 localhost 组
    const bridgeSaved = (await bridge.call("list_saved_tab_groups", { source: "chrome_native", query: "TikTok" })).result;
    const bridgeTikTok = bridgeSaved.chromeNative.groups.find((g) => g.title === "TikTok MX 测试组");
    assert.ok(bridgeSaved.chromeNative.count >= 1);
    assert.equal(bridgeTikTok.guid, closedTikTok.guid, "the closed GUID stays saved");
    assert.deepEqual(bridgeTikTok.tabs.map((tab) => tab.url), closedTikTok.tabs.map((tab) => tab.url));
    assert.equal(bridgeTikTok.isOpen, false);
    assert.equal(bridgeTikTok.openGroupId, undefined);
    assert.ok(!JSON.stringify(bridgeSaved).includes("Private Bank"), "private closed/open group stays isolated");
    const rejectedClosed = await bridge.callRaw("list_saved_tab_groups", { source: "chrome_native", closedOnly: true });
    assert.equal(rejectedClosed.ok, false);
    assert.equal(rejectedClosed.error.code, "BAD_ARGS");
    return "未打开的组会列出并保持关闭，侧栏不能代开或删除。原 GUID 与成员保留";
  });

  await step("侧栏删除成员页仍在加载的 Chrome 原生组", async () => {
    const targetTitle = `PageLens E2E delete ${randomUUID()}`;
    const keepTitle = `PageLens E2E keep ${randomUUID()}`;
    const targetUrl = `${base}/open-delete/loading/${randomUUID()}`;
    const anotherUrl = `${base}/open-delete/member/${randomUUID()}`;
    const keepUrl = `${base}/open-keep/${randomUUID()}`;
    const fixture = await bridge.evaluate(`(async () => {
      const w = await chrome.windows.create({ url: ${JSON.stringify(targetUrl)}, focused: false });
      const member = await chrome.tabs.create({ windowId: w.id, url: ${JSON.stringify(anotherUrl)}, active: false });
      const other = await chrome.tabs.create({ windowId: w.id, url: ${JSON.stringify(keepUrl)}, active: false });
      const targetTabIds = [w.tabs[0].id, member.id];
      for (const [tabIds, title] of [[targetTabIds, ${JSON.stringify(targetTitle)}], [[other.id], ${JSON.stringify(keepTitle)}]]) {
        const id = await chrome.tabs.group({ tabIds, createProperties: { windowId: w.id } });
        await chrome.tabGroups.update(id, { title, color: "blue" });
      }
      return { windowId: w.id, targetTabIds, survivorTabId: other.id };
    })()`);
    const groups = () => {
      const listed = readNativeSavedTabGroups({ userDataDir: profile, profile: "Default" });
      assert.ok(listed.ok, listed.error);
      return listed.groups;
    };
    const [target, survivor] = await waitFor(() => {
      const pair = [targetTitle, keepTitle].map((title) => groups().find((group) => group.title === title));
      const urls = pair[0]?.tabs.map((tab) => tab.url);
      return urls?.length === 2 && urls.includes(targetUrl) && urls.includes(anotherUrl) && pair[1]?.tabs[0]?.url === keepUrl && pair;
    }, 12000, "临时 profile 中的两个已打开原生 GUID");
    const targetRow = JSON.stringify(`[data-sg-key="native:${target.guid}"]`);
    const survivorRow = JSON.stringify(`[data-sg-key="native:${survivor.guid}"]`);
    await evalPanel(`document.querySelector("#saved-groups-panel").open = true`);
    await evalPanel(`document.querySelector("#btn-sg-refresh").click()`);
    await waitFor(() => evalPanel(`Boolean(document.querySelector(${targetRow}) && document.querySelector(${survivorRow}))`), 12000, "侧栏显示两个已打开的测试组");
    assert.equal(await evalPanel(`document.querySelector("#sg-use-helper")`), null);
    await evalPanel(`document.querySelector(${targetRow}).querySelector(".sg-del-btn").click()`);
    const message = await waitFor(() => evalPanel(`document.querySelector("#sg-dialog").open &&
      document.querySelector("#sg-dialog-message").textContent`), 10000, "删除确认");
    assert.ok(message.includes(targetTitle), message);
    assert.ok(message.includes(String(fixture.windowId)), message);
    assert.equal(await bridge.evaluate(`chrome.tabs.get(${fixture.targetTabIds[0]}).then(tab => tab.status)`), "loading");
    await evalPanel(`document.querySelector("#sg-dialog-accept").click()`);
    await waitFor(async () => {
      const state = await evalPanel(`({
        hasTarget: Boolean(document.querySelector(${targetRow})),
        hasSurvivor: Boolean(document.querySelector(${survivorRow})),
        status: document.querySelector("#sg-status").textContent,
        failed: document.querySelector("#sg-status").classList.contains("bad"),
      })`);
      if (state.failed) throw new Error(state.status);
      return !state.hasTarget && state.hasSurvivor;
    }, 20000, "侧栏删除目标并保留相邻组");
    const remaining = groups();
    assert.ok(!remaining.some((group) => group.guid === target.guid));
    assert.ok(remaining.some((group) => group.guid === survivor.guid));
    const remainingTabs = await bridge.evaluate(`chrome.tabs.query({ windowId: ${fixture.windowId} })`);
    assert.deepEqual(remainingTabs.map((tab) => tab.id), [fixture.survivorTabId]);
    assert.notEqual(remainingTabs[0].groupId, -1, "the surviving tab stays grouped");
    await bridge.evaluate(`chrome.windows.remove(${fixture.windowId})`);
  });

  await step("侧栏按 GUID 删除已经打开的同名组", async () => {
    const sharedTitle = `PageLens E2E twin ${randomUUID()}`;
    const olderUrl = `${base}/twin-older/${randomUUID()}`;
    const newerUrl = `${base}/twin-newer/${randomUUID()}`;
    const fixtureWindow = await bridge.evaluate(`(async () => {
      const w = await chrome.windows.create({ url: ${JSON.stringify(olderUrl)}, focused: false });
      const olderId = await chrome.tabs.group({ tabIds: [w.tabs[0].id], createProperties: { windowId: w.id } });
      await chrome.tabGroups.update(olderId, { title: ${JSON.stringify(sharedTitle)}, color: "green" });
      await new Promise(r => setTimeout(r, 1100));
      const newerTab = await chrome.tabs.create({ windowId: w.id, url: ${JSON.stringify(newerUrl)}, active: false });
      const newerId = await chrome.tabs.group({ tabIds: [newerTab.id], createProperties: { windowId: w.id } });
      await chrome.tabGroups.update(newerId, { title: ${JSON.stringify(sharedTitle)}, color: "green" });
      return w.id;
    })()`);
    const twins = await waitFor(() => {
      const listed = readNativeSavedTabGroups({ userDataDir: profile, profile: "Default" });
      if (!listed.ok) return null;
      const groups = listed.groups.filter((group) => group.title === sharedTitle);
      const older = groups.find((group) => group.tabs[0]?.url === olderUrl);
      const newer = groups.find((group) => group.tabs[0]?.url === newerUrl);
      return groups.length === 2 && older && newer && older.createdAt < newer.createdAt ? { older, newer } : null;
    }, 12000, "同名的两个已打开原生 GUID");
    const olderRow = JSON.stringify(`[data-sg-key="native:${twins.older.guid}"]`);
    const newerRow = JSON.stringify(`[data-sg-key="native:${twins.newer.guid}"]`);
    await evalPanel(`document.querySelector("#saved-groups-panel").open = true`);
    await evalPanel(`document.querySelector("#btn-sg-refresh").click()`);
    await waitFor(() => evalPanel(`Boolean(document.querySelector(${olderRow}) && document.querySelector(${newerRow}))`), 12000, "侧栏显示两个同名已打开组");
    await evalPanel(`document.querySelector(${olderRow}).querySelector(".sg-del-btn").click()`);
    const message = await waitFor(() => evalPanel(`document.querySelector("#sg-dialog").open &&
      document.querySelector("#sg-dialog-message").textContent`), 10000, "同名组删除确认");
    assert.ok(message.includes(sharedTitle), message);
    await evalPanel(`document.querySelector("#sg-dialog-accept").click()`);
    await waitFor(async () => {
      const state = await evalPanel(`({
        hasOlder: Boolean(document.querySelector(${olderRow})),
        hasNewer: Boolean(document.querySelector(${newerRow})),
        status: document.querySelector("#sg-status").textContent,
        failed: document.querySelector("#sg-status").classList.contains("bad"),
      })`);
      if (state.failed) throw new Error(state.status);
      return !state.hasOlder && state.hasNewer;
    }, 20000, "侧栏只删除所选的同名组");
    const remaining = readNativeSavedTabGroups({ userDataDir: profile, profile: "Default" });
    assert.ok(remaining.ok, remaining.error);
    assert.ok(!remaining.groups.some((group) => group.guid === twins.older.guid), "所选同名 GUID 必须消失");
    assert.ok(remaining.groups.some((group) => group.guid === twins.newer.guid && group.tabs[0]?.url === newerUrl), "另一条 URL 的同名 GUID 必须保留");
    await bridge.evaluate(`chrome.windows.remove(${fixtureWindow})`);
  });

  await step("点击「总结文章」直接读取原文章，模型看不到开页工具，全程不增标签", async () => {
    await bridge.evaluate(`chrome.storage.local.set({settings: ${JSON.stringify({
      agentBridgeEnabled: true,
      agentBridgeOrigins: ["http://127.0.0.1:*"],
      text: { baseUrl: `${base}/v1`, model: "article-fixture" },
      shortcuts: [{ id: "article-summary", label: "总结文章", prompt: summaryPrompt }],
    })}})`);
    await conn.send("Page.reload", {}, panelSession);
    await waitFor(() => evalPanel(`document.documentElement.dataset.pagelensWired === "1" &&
      [...document.querySelectorAll("#skills button")].some(button => button.textContent === "总结文章")`), 10000, "侧栏加载测试快捷按钮");
    const panelWindowId = await evalPanel("chrome.tabs.getCurrent().then(tab => tab.windowId)");
    const articleTabId = await bridge.evaluate(`chrome.tabs.create({windowId: ${panelWindowId}, url: ${JSON.stringify(`${base}/summary-article`)}, active: true}).then(tab => tab.id)`);
    try {
      await waitFor(() => evalPanel(`import("./state.js").then(({state}) =>
        state.tab?.id === ${articleTabId} && state.pack?.text?.includes(${JSON.stringify(articleFact)}))`), 10000, "侧栏读取原文章");
      const snapshot = () => evalPanel(`(async () => ({
        tabs: (await chrome.tabs.query({currentWindow:true})).map(tab => tab.id).sort(),
        groups: (await chrome.tabGroups.query({})).map(group => group.id).sort()
      }))()`);
      const before = await snapshot();
      await evalPanel(`(() => {
        window.summaryTabsCreated = [];
        window.recordSummaryTab = tab => window.summaryTabsCreated.push(tab.id);
        chrome.tabs.onCreated.addListener(window.recordSummaryTab);
        const chip = [...document.querySelectorAll("#skills button")].find(el => el.textContent === "总结文章");
        if (!chip) throw new Error("未渲染总结文章按钮");
        chip.click();
      })()`);
      await waitFor(() => evalPanel(`document.querySelector("#msgs").textContent.includes(${JSON.stringify(articleSummary)})`),
        20000, "显示从原文章得到的测试模型回复");
      assert.equal(summaryRequests.length, 1);
      const firstUser = summaryRequests[0].messages.filter(message => message.role === "user").at(-1);
      assert.ok(firstUser.content.includes(summaryPrompt));
      assert.ok(firstUser.content.includes(articleFact));
      assert.ok(firstUser.content.includes(articleTail));
      assert.ok(firstUser.content.includes(`${base}/summary-article`));
      assert.deepEqual(summaryRequests[0].tools ?? [], []);
      assert.deepEqual(await evalPanel("window.summaryTabsCreated"), []);
      assert.deepEqual(await snapshot(), before);
    } finally {
      await evalPanel(`if (window.recordSummaryTab) chrome.tabs.onCreated.removeListener(window.recordSummaryTab)`);
      await bridge.evaluate(`chrome.tabs.remove(${articleTabId})`);
    }
  });
} finally {
  bridge?.close?.();
  conn?.close?.();
  server.close();
  if (!keep) {
    if (chrome) {
      chrome.kill("SIGTERM");
      await sleep(500);
    }
    rmSync(work, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);

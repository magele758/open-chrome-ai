#!/usr/bin/env node
/**
 * 端到端自动化测试：真实 Chrome（无头模式 + 独立临时 profile）+ 解包加载当前 extension/，
 * 全程零弹窗、零人工操作，验证：
 *   1. 默认权限已一次性生效（tabGroups / tabs / nativeMessaging / cookies / host_permissions）
 *   2. 侧栏内部 Agent 全部 5 个标签组工具（含已折叠组查询、按组内 URL 检索、加组、更新展开/改名/改色/移位、移出、解散、关闭删除）
 *   3. 外部 Bridge 全部 5 个标签组工具 + origin 白名单隔离（私有组不可见、混合组隐藏域外标签并拒绝改/删）
 *   4. 通过 Chrome 的 sessions.restore 在另一窗口恢复保存组，从原侧栏核对并删除，验证相邻保存组和未分组标签页仍在原处
 *
 *   node extension/tools/e2e_tab_groups.mjs [--headed] [--keep]
 *   node extension/tools/e2e_tab_groups.mjs --native-ui
 *   --native-ui 需要 macOS 图形会话和已授权辅助功能的 PageLens Helper，并验证侧栏删除真正已关闭的原生组。
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
const nativeUi = process.argv.includes("--native-ui");
const headed = nativeUi || keep || process.argv.includes("--headed");
if (nativeUi && process.platform !== "darwin") throw new Error("--native-ui 需要 macOS");
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
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(`<!doctype html><meta charset="utf-8"><title>Fixture ${slug}</title><h1>${slug}</h1>`);
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
    // The helper only sees the saved-group toolbar in the requesting window's
    // language. Match the zh-Hans menu the product is verified against.
    ...(nativeUi ? ["--lang=zh-CN"] : []),
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
if (nativeUi) {
  // A fresh profile hides the bookmark bar, so the saved-group toolbar and its
  // everything button are absent and the helper reports NOT_FOUND_IN_UI.
  const defaults = join(profile, "Default");
  mkdirSync(defaults, { recursive: true });
  writeFileSync(join(defaults, "Preferences"), JSON.stringify({
    bookmark_bar: { show_on_all_tabs: true },
  }));
}
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

  await step("已保存标签组真机全流程：Chrome 原生已关闭保存组（Native Host 读 LevelDB）+ PageLens 保存库 CRUD", async () => {
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
      const closedNative = await run("list_saved_tab_groups", { source: "chrome_native", closedOnly: true, query: "TikTok" });
      const target = closedNative.chromeNative.groups[0];

      // 按原 URL 重建打开（零辅助功能依赖）
      const recreated = await run("open_saved_tab_group", { guid: target.guid, mode: "recreate", collapsed: true });

      // 收纳进 PageLens 保存库并关闭打开组
      const stashed = await run("save_tab_group", { groupId: recreated.group.id, title: "PL 归档组", closeAfterSave: true });
      const groupGone = await chrome.tabGroups.get(recreated.group.id).then(() => false, () => true);

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
        closedNative,
        recreated,
        stashed,
        groupGone,
        updated,
        realReopened,
        realTabCount: realTabs.length,
        deleted,
        afterDelCount: afterDel.pagelens.count,
      };
    })()`);

    assert.equal(out.openHasTikTok, false, "native group is genuinely closed in Chrome");
    assert.equal(out.closedNative.chromeNative.ok, true);
    assert.equal(out.closedNative.chromeNative.count, 1);
    assert.equal(out.closedNative.chromeNative.groups[0].title, "TikTok MX 测试组");
    assert.equal(out.closedNative.chromeNative.groups[0].color, "orange");
    assert.equal(out.closedNative.chromeNative.groups[0].isOpen, false);
    assert.equal(out.closedNative.chromeNative.groups[0].tabCount, 2);
    assert.equal(out.recreated.ok, true);
    assert.equal(out.stashed.closedAfterSave, true);
    assert.equal(out.groupGone, true);
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
    const bridgeSaved = (await bridge.call("list_saved_tab_groups", { source: "chrome_native", closedOnly: true })).result;
    assert.equal(bridgeSaved.chromeNative.ok, true);
    assert.ok(bridgeSaved.chromeNative.groups.some((g) => g.title === "TikTok MX 测试组" && g.isOpen === false));
    assert.ok(!JSON.stringify(bridgeSaved).includes("Private Bank"), "private closed/open group stays isolated");
    return `closed native group guid=${out.closedNative.chromeNative.groups[0].guid.slice(0, 8)}… + single-window ghost-free delete verified`;
  });

  for (const useHelper of nativeUi ? [false, true] : [false]) {
    const mode = useHelper ? "显式启用 Helper" : "从原侧栏核对另一窗口的组";
    await step(`侧栏删除已关闭的 Chrome 原生组（${mode}）`, async () => {
      const targetTitle = `PageLens E2E delete ${randomUUID()}`;
      const keepTitle = `PageLens E2E keep ${randomUUID()}`;
      const targetUrl = `${base}/closed-delete/${randomUUID()}`;
      const keepUrl = `${base}/closed-keep/${randomUUID()}`;
      const ungroupedUrl = `${base}/ungrouped-keep/${randomUUID()}`;
      const fixtureWindow = await bridge.evaluate(`(async () => {
        const w = await chrome.windows.create({ url: ${JSON.stringify(targetUrl)}, focused: false });
        const other = await chrome.tabs.create({ windowId: w.id, url: ${JSON.stringify(keepUrl)} });
        for (const [tabId, title] of [[w.tabs[0].id, ${JSON.stringify(targetTitle)}], [other.id, ${JSON.stringify(keepTitle)}]]) {
          const id = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: w.id } });
          await chrome.tabGroups.update(id, { title, color: "blue" });
        }
        await chrome.tabs.create({ windowId: w.id, url: ${JSON.stringify(ungroupedUrl)}, active: false });
        return w.id;
      })()`);
      const tempGroups = () => {
        const listed = readNativeSavedTabGroups({ userDataDir: profile, profile: "Default" });
        assert.ok(listed.ok, listed.error);
        return listed.groups;
      };
      const [target, survivor] = await waitFor(() => {
        const groups = tempGroups();
        const pair = [targetTitle, keepTitle].map(title => groups.find(group => group.title === title));
        return pair[0]?.tabs[0]?.url === targetUrl && pair[1]?.tabs[0]?.url === keepUrl && pair;
      }, 12000, "临时 profile 中的两个原生 GUID");
      await waitFor(() => bridge.evaluate(`chrome.tabs.query({windowId: ${fixtureWindow}})
        .then(tabs => tabs.some(t => t.url === ${JSON.stringify(ungroupedUrl)} && t.status === "complete"))`),
        10000, "未分组测试标签完成加载");
      await bridge.evaluate(`chrome.windows.remove(${fixtureWindow})`);
      const openGroups = await bridge.evaluate("chrome.tabGroups.query({})");
      assert.ok(openGroups.every(group => group.title !== targetTitle && group.title !== keepTitle));
      const targetRow = JSON.stringify(`[data-sg-key="native:${target.guid}"]`);
      const survivorRow = JSON.stringify(`[data-sg-key="native:${survivor.guid}"]`);
      await evalPanel(`document.querySelector("#saved-groups-panel").open = true`);
      await evalPanel(`document.querySelector("#btn-sg-refresh").click()`);
      await waitFor(() => evalPanel(`Boolean(document.querySelector(${targetRow}) && document.querySelector(${survivorRow}))`), 12000, "侧栏显示两个已关闭的测试组");
      assert.equal(await evalPanel(`document.querySelector("#sg-use-helper").checked`), false, "Helper is opt-in");
      if (useHelper) await evalPanel(`document.querySelector("#sg-use-helper").click()`);
      await evalPanel(`document.querySelector(${targetRow}).querySelector(".sg-del-btn").click()`);
      let restoredWindowId;
      let protectedTabs;
      const panelTab = await evalPanel("chrome.tabs.getCurrent().then(({id, windowId}) => ({id, windowId}))");
      if (!useHelper) {
        assert.ok(await evalPanel(`!document.querySelector("#sg-dialog").open &&
          document.querySelector("#sg-manual-target").textContent.includes(${JSON.stringify(targetTitle)})`));
        const sessionId = await waitFor(() => bridge.evaluate(`(async () => {
          const entries = await chrome.sessions.getRecentlyClosed();
          return entries.find(entry => entry.window?.tabs?.length === 3 &&
            ${JSON.stringify([targetUrl, keepUrl, ungroupedUrl])}.every(url =>
              entry.window.tabs.some(tab => tab.url === url)))?.window.sessionId;
        })()`), 10000, "Chrome 最近关闭的测试窗口");
        restoredWindowId = await bridge.evaluate(`chrome.sessions.restore(${JSON.stringify(sessionId)}).then(s => s.window.id)`);
        assert.notEqual(restoredWindowId, panelTab.windowId, "目标组应在侧栏以外的窗口");
        protectedTabs = await waitFor(() => bridge.evaluate(`(async () => {
          const groups = await chrome.tabGroups.query({windowId: ${restoredWindowId}});
          const tabs = await chrome.tabs.query({windowId: ${restoredWindowId}});
          const target = groups.find(g => g.title === ${JSON.stringify(targetTitle)});
          const survivor = groups.find(g => g.title === ${JSON.stringify(keepTitle)});
          const sibling = tabs.find(t => t.url === ${JSON.stringify(keepUrl)} && t.groupId === survivor?.id);
          const ungrouped = tabs.find(t => t.url === ${JSON.stringify(ungroupedUrl)} && t.groupId === -1);
          if (!target || !tabs.some(t => t.url === ${JSON.stringify(targetUrl)} && t.groupId === target.id) || !sibling || !ungrouped) return null;
          return [sibling, ungrouped].map(({id, windowId, groupId, url}) => ({id, windowId, groupId, url}));
        })()`), 10000, "Chrome 在另一窗口恢复原组、相邻组和未分组标签页");
        await evalPanel(`document.querySelector("#btn-sg-manual-refresh").click()`);
      }
      async function acceptTargetConfirmation(windowId) {
        const message = await waitFor(() => evalPanel(`document.querySelector("#sg-dialog").open &&
          document.querySelector("#sg-dialog-message").textContent`), 10000, "核对原组后呈现删除确认");
        assert.ok(message.includes(targetTitle), message);
        if (windowId != null) assert.ok(message.includes("其他 Chrome 窗口") && message.includes(String(windowId)), message);
        await evalPanel(`document.querySelector("#sg-dialog-accept").click()`);
      }
      const readPanelState = () => evalPanel(`({
          hasTarget: Boolean(document.querySelector(${targetRow})),
          hasSurvivor: Boolean(document.querySelector(${survivorRow})),
          status: document.querySelector("#sg-status").textContent,
          failed: document.querySelector("#sg-status").classList.contains("bad"),
          resumeVisible: document.querySelector("#sg-manual-target").checkVisibility() &&
            document.querySelector("#sg-manual-target").textContent.includes(${JSON.stringify(targetTitle)}) &&
            document.querySelector("#btn-sg-manual-refresh").checkVisibility() &&
            !document.querySelector("#btn-sg-manual-refresh").disabled,
        })`);
      const statusBeforeAccept = useHelper
        ? await evalPanel(`document.querySelector("#sg-status").textContent`)
        : "";
      await acceptTargetConfirmation(restoredWindowId);
      if (useHelper) {
        const result = await waitFor(async () => {
          const state = await readPanelState();
          const settledFailed = state.failed && state.status !== statusBeforeAccept;
          return (state.resumeVisible || settledFailed || (!state.hasTarget && state.hasSurvivor)) &&
            { ...state, failed: settledFailed };
        }, 45000, "自动打开后的删除结果或跨窗口核对提示");
        if (result.resumeVisible) {
          // Only continue if the helper really opened the selected GUID. A
          // genuine menu miss must fail this test without a simulated reopen.
          const destination = await evalPanel(`(async () => {
            const { createSavedTabGroupTools } = await import("../lib/agent/saved-tab-group-tools.js");
            const list = createSavedTabGroupTools().find(tool => tool.name === "list_saved_tab_groups");
            const rows = JSON.parse(await list.execute({source: "chrome_native"})).chromeNative.groups;
            return rows.find(row => row.guid === ${JSON.stringify(target.guid)} && row.isOpen)?.openWindowId;
          })()`);
          assert.ok(Number.isInteger(destination) && destination !== panelTab.windowId, result.status);
          await evalPanel(`document.querySelector("#btn-sg-manual-refresh").click()`);
          await acceptTargetConfirmation(destination);
        } else {
          assert.ok(!result.failed, result.status);
        }
      }
      await waitFor(async () => {
        const state = await readPanelState();
        if (state.failed) throw new Error(state.status);
        return !state.hasTarget && state.hasSurvivor;
      }, 45000, "侧栏删除目标并刷新列表");
      const remaining = tempGroups();
      assert.ok(!remaining.some(group => group.guid === target.guid), "目标 GUID 必须从临时 Chrome 原生库消失");
      assert.ok(remaining.some(group => group.guid === survivor.guid), "未选中的保存组必须保留");
      if (protectedTabs) {
        const liveTabs = await bridge.evaluate("chrome.tabs.query({})");
        assert.ok(!liveTabs.some(t => t.url === targetUrl), "目标标签页应已关闭");
        for (const before of protectedTabs) {
          const actual = liveTabs.find(t => t.id === before.id);
          assert.ok(actual, `未选中的标签页 ${before.id} 应保留在恢复窗口`);
          assert.equal(actual.windowId, before.windowId);
          assert.equal(actual.groupId, before.groupId);
          assert.equal(actual.url, before.url);
        }
        const stillPanel = await evalPanel("chrome.tabs.getCurrent().then(({id, windowId}) => ({id, windowId}))");
        assert.deepEqual(stillPanel, panelTab, "确认和删除期间侧栏所在窗口和标签不变");
      }
    });
  }

  if (nativeUi) {
    await step("侧栏用 Helper 按创建时间删除同名已关闭组", async () => {
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
        const groups = listed.groups.filter(group => group.title === sharedTitle);
        const older = groups.find(group => group.tabs[0]?.url === olderUrl);
        const newer = groups.find(group => group.tabs[0]?.url === newerUrl);
        return groups.length === 2 && older && newer && older.createdAt < newer.createdAt ? { older, newer } : null;
      }, 12000, "同名的两个原生 GUID");
      await bridge.evaluate(`chrome.windows.remove(${fixtureWindow})`);
      const openGroups = await bridge.evaluate("chrome.tabGroups.query({})");
      assert.ok(openGroups.every(group => group.title !== sharedTitle));
      const olderRow = JSON.stringify(`[data-sg-key="native:${twins.older.guid}"]`);
      const newerRow = JSON.stringify(`[data-sg-key="native:${twins.newer.guid}"]`);
      await evalPanel(`document.querySelector("#saved-groups-panel").open = true`);
      await evalPanel(`document.querySelector("#btn-sg-refresh").click()`);
      await waitFor(() => evalPanel(`Boolean(document.querySelector(${olderRow}) && document.querySelector(${newerRow}))`), 12000, "侧栏显示两个同名已关闭组");
      if (!await evalPanel(`document.querySelector("#sg-use-helper").checked`)) {
        await evalPanel(`document.querySelector("#sg-use-helper").click()`);
      }
      await waitFor(() => evalPanel(`(() => {
        const row = document.querySelector(${olderRow});
        const button = row && row.querySelector(".sg-del-btn");
        return Boolean(button && !button.disabled && !document.querySelector("#sg-dialog").open);
      })()`), 20000, "上一次删除结束后同名组删除按钮可点");
      await evalPanel(`document.querySelector(${olderRow}).querySelector(".sg-del-btn").click()`);
      const message = await waitFor(() => evalPanel(`document.querySelector("#sg-dialog").open &&
        document.querySelector("#sg-dialog-message").textContent`), 10000, "同名组删除确认");
      assert.ok(message.includes(sharedTitle), message);
      await evalPanel(`document.querySelector("#sg-dialog-accept").click()`);
      const readPanelState = () => evalPanel(`({
          hasOlder: Boolean(document.querySelector(${olderRow})),
          hasNewer: Boolean(document.querySelector(${newerRow})),
          status: document.querySelector("#sg-status").textContent,
          failed: document.querySelector("#sg-status").classList.contains("bad"),
          dialogOpen: Boolean(document.querySelector("#sg-dialog")?.open),
          returnValue: document.querySelector("#sg-dialog")?.returnValue || "",
          resumeVisible: document.querySelector("#sg-manual-target").checkVisibility() &&
            document.querySelector("#btn-sg-manual-refresh").checkVisibility() &&
            !document.querySelector("#btn-sg-manual-refresh").disabled,
        })`);
      const panelTab = await evalPanel("chrome.tabs.getCurrent().then(({id, windowId}) => ({id, windowId}))");
      const samples = [];
      const noteSample = (state) => {
        const now = Date.now();
        if (samples.length && now - samples.at(-1).t < 5000) return;
        samples.push({
          t: now,
          status: state.status,
          failed: state.failed,
          dialogOpen: state.dialogOpen,
          returnValue: state.returnValue,
          hasOlder: state.hasOlder,
          hasNewer: state.hasNewer,
          resumeVisible: state.resumeVisible,
        });
      };
      const helperLines = () => {
        try {
          return execFileSync("/usr/bin/pgrep", ["-lf", "PageLens Helper"], { encoding: "utf8" })
            .trim()
            .split("\n")
            .filter((line) => line.includes("PageLens Helper") && !line.includes("e2e_tab_groups"));
        } catch {
          return [];
        }
      };
      const twinDump = async (why) => {
        let panel = null;
        let panelError = null;
        let windows = null;
        let windowsError = null;
        try {
          panel = await readPanelState();
        } catch (err) {
          panelError = err?.message || String(err);
        }
        try {
          windows = await evalPanel(`chrome.windows.getAll({populate:true}).then(list => list.map(win => ({
            id: win.id,
            focused: Boolean(win.focused),
            tabs: (win.tabs || []).map(tab => ({
              title: tab.title || "",
              url: String(tab.url || tab.pendingUrl || "").slice(0, 80),
            })),
          })))`);
        } catch (err) {
          windowsError = err?.message || String(err);
        }
        const markers = [];
        for (const win of windows || []) {
          for (const tab of win.tabs || []) {
            if (/^PageLens-[0-9a-f-]{36}$/.test(tab.title)) {
              markers.push({ windowId: win.id, focused: win.focused, title: tab.title });
            }
          }
        }
        const helpers = helperLines();
        const line = JSON.stringify({
          why,
          samples,
          panel,
          panelError,
          markers,
          helperCount: helpers.length,
          helpers: helpers.map((line) => line.slice(0, 160)),
          windowsError,
        });
        console.log(`TWINDUMP ${line}`);
        return line;
      };
      let result;
      try {
        result = await waitFor(async () => {
          const state = await readPanelState();
          noteSample(state);
          return (state.resumeVisible || state.failed || (!state.hasOlder && state.hasNewer)) && state;
        }, 45000, "同名组自动打开后的删除结果");
      } catch (err) {
        const line = await twinDump("auto-open");
        throw new Error(`${err.message} | ${line.slice(0, 900)}`);
      }
      if (result.resumeVisible) {
        const destination = await evalPanel(`(async () => {
          const { createSavedTabGroupTools } = await import("../lib/agent/saved-tab-group-tools.js");
          const list = createSavedTabGroupTools().find(tool => tool.name === "list_saved_tab_groups");
          const rows = JSON.parse(await list.execute({source: "chrome_native"})).chromeNative.groups;
          return rows.find(row => row.guid === ${JSON.stringify(twins.older.guid)} && row.isOpen)?.openWindowId;
        })()`);
        assert.ok(Number.isInteger(destination) && destination !== panelTab.windowId, result.status);
        await evalPanel(`document.querySelector("#btn-sg-manual-refresh").click()`);
        const again = await waitFor(() => evalPanel(`document.querySelector("#sg-dialog").open &&
          document.querySelector("#sg-dialog-message").textContent`), 10000, "同名组跨窗口核对确认");
        assert.ok(again.includes(sharedTitle) && again.includes(String(destination)), again);
        await evalPanel(`document.querySelector("#sg-dialog-accept").click()`);
      } else {
        assert.ok(!result.failed, result.status);
      }
      await waitFor(async () => {
        const state = await readPanelState();
        if (state.failed) throw new Error(state.status);
        return !state.hasOlder && state.hasNewer;
      }, 45000, "侧栏只删除较旧的同名组");
      const remaining = readNativeSavedTabGroups({ userDataDir: profile, profile: "Default" });
      assert.ok(remaining.ok, remaining.error);
      assert.ok(!remaining.groups.some(group => group.guid === twins.older.guid), "较旧的同名 GUID 必须消失");
      assert.ok(remaining.groups.some(group => group.guid === twins.newer.guid), "较新的同名 GUID 必须保留");
    });
  }

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

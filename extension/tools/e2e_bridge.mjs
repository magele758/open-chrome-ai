#!/usr/bin/env node
/**
 * 端到端冒烟：专用临时 profile 的 Chrome + 本地 fixture（Doocs 渲染页 / ProseMirror 类编辑器），
 * 外部 CDP 客户端 → 扩展 Service Worker 的 __pl → 可信复制/粘贴 → 回读校验。
 *
 *   node extension/tools/e2e_bridge.mjs [--keep]
 *
 * 安全：只用 mkdtemp 出来的 --user-data-dir，不碰日常 Chrome 的 Default profile；不联网访问微信。
 * 注意：可信粘贴走系统剪贴板，脚本会先备份文本剪贴板、结束后还原（非文本内容无法还原）。
 * 不属于 run-tests（文件名不以 test_ 开头）。
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectBridge } from "../../tools/pl-bridge.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.E2E_CDP_PORT) || 9333;
const keep = process.argv.includes("--keep");

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TITLE = "每日 LLM 简报";

const DOOCS_HTML = `<!doctype html><meta charset="utf-8"><title>Doocs fixture</title>
<style>
  #output { color: rgb(51, 51, 51); font-size: 15px; line-height: 1.75; font-family: Georgia, serif; }
  #output h2 { color: rgb(0, 102, 204); border-bottom: 2px solid rgb(0, 102, 204); padding-bottom: 4px; }
  #output table { border-collapse: collapse; width: 100%; }
  #output th, #output td { border: 1px solid rgb(204, 204, 204); padding: 6px 10px; }
  #output th { background-color: rgb(238, 244, 255); }
  #output strong { color: rgb(200, 30, 30); }
</style>
<aside id="sidebar">导航 · 设置 · 主题（不应出现在正文）</aside>
<div id="output">
  <h2>今日要闻</h2>
  <p>${"大模型每日简报正文，包含 <strong>重点结论</strong> 与数据。".repeat(20)}</p>
  <table><thead><tr><th>模型</th><th>得分</th></tr></thead><tbody><tr><td>A</td><td>90</td></tr><tr><td>B</td><td>85</td></tr></tbody></table>
  <p><img src="data:image/png;base64,${PNG}" width="40" height="40" alt="chart1"> <img src="data:image/png;base64,${PNG}" width="40" height="40" alt="chart2"></p>
  <p>结尾段落 <a href="https://example.com/ref">参考链接</a></p>
</div>`;

const EDITOR_HTML = `<!doctype html><meta charset="utf-8"><title>Editor fixture</title>
<style>
  .title-editor__input textarea { width: 600px; height: 40px; }
  .ProseMirror { width: 600px; min-height: 300px; border: 1px solid #999; padding: 8px; }
  .ProseMirror p.is-empty::before { content: attr(data-placeholder); color: #aaa; }
  #side { width: 200px; height: 24px; border: 1px solid #ccc; }
</style>
<div class="title-editor__input"><textarea id="title" placeholder="请在这里输入标题"></textarea></div>
<div id="side" contenteditable="true">备注</div>
<div id="pm" class="ProseMirror" contenteditable="true"><p data-placeholder="从这里开始写正文" class="is-empty"><br></p></div>
<script>
  window.__pasteLog = [];
  window.__ignorePastes = 0;
  const pm = document.getElementById("pm");
  // 模拟 ProseMirror：只接受可信（isTrusted）粘贴；合成事件一律忽略；可配置前 N 次粘贴被吞掉。
  pm.addEventListener("paste", (e) => {
    const html = e.clipboardData.getData("text/html");
    window.__pasteLog.push({ trusted: e.isTrusted, types: [...e.clipboardData.types], htmlLength: html.length });
    if (!e.isTrusted) { e.preventDefault(); return; }
    if (window.__ignorePastes > 0) { window.__ignorePastes -= 1; e.preventDefault(); return; }
    if (!html) return;
    e.preventDefault();
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, style, meta").forEach((n) => n.remove());
    document.execCommand("insertHTML", false, doc.body.innerHTML);
  });
</script>`;

function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const body = req.url.startsWith("/editor") ? EDITOR_HTML : req.url.startsWith("/doocs") ? DOOCS_HTML : null;
    if (!body) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  return new Promise((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen(server)));
}

function launchChrome(profile) {
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
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
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

const backup = (() => {
  try {
    return execFileSync("pbpaste", { encoding: "utf8" });
  } catch {
    return null;
  }
})();
const profile = mkdtempSync(join(tmpdir(), "pl-e2e-profile-"));
const server = await startFixtureServer();
const base = `http://127.0.0.1:${server.address().port}`;
let chrome = null;
let bridge = null;

try {
  const launched = await launchChrome(profile);
  chrome = launched.child;
  console.log(`Chrome 已启动（专用 profile ${profile}），扩展 ${launched.extensionId}`);
  await new Promise((r) => setTimeout(r, 1500));
  bridge = await connectBridge({ port: PORT, extensionId: launched.extensionId });

  await step("默认关闭：hello 无工具，call 返回 DISABLED", async () => {
    const hello = await bridge.hello();
    assert.equal(hello.enabled, false);
    assert.deepEqual(hello.tools, []);
    const res = await bridge.callRaw("list_tabs");
    assert.equal(res.error.code, "DISABLED");
  });

  await bridge.evaluate(`chrome.storage.local.set({ settings: { agentBridgeEnabled: true, agentBridgeOrigins: ["http://127.0.0.1:*"] } })`);

  await step("启用后 hello 列出工具与版本", async () => {
    const hello = await bridge.hello();
    assert.equal(hello.enabled, true);
    assert.equal(hello.protocol, 1);
    assert.ok(hello.tools.some((t) => t.name === "paste_rich_trusted"));
    return `${hello.tools.length} 个工具，extension ${hello.extensionVersion}`;
  });

  let doocsTab;
  let editorTab;
  await step("open_tab 后台打开 fixture（不抢焦点）", async () => {
    doocsTab = (await bridge.call("open_tab", { url: `${base}/doocs` })).result.tabId;
    editorTab = (await bridge.call("open_tab", { url: `${base}/editor` })).result.tabId;
    await bridge.call("wait_for", { tabId: doocsTab, selector: "#output", timeoutMs: 8000 });
    await bridge.call("wait_for", { tabId: editorTab, selector: "#pm", timeoutMs: 8000 });
    const { result: tabs } = await bridge.call("list_tabs");
    assert.equal(tabs.filter((t) => t.url.startsWith(base)).length, 2);
    assert.ok(tabs.every((t) => !t.active || !t.url.startsWith(base)), "fixture tabs are in the background");
    const blocked = await bridge.callRaw("open_tab", { url: "https://mp.weixin.qq.com/" });
    assert.equal(blocked.error.code, "ORIGIN_NOT_ALLOWED", "origin outside allow-list refused");
  });

  await step("read_rendered_html：样式内联、侧栏被排除", async () => {
    const res = await bridge.call("read_rendered_html", { tabId: doocsTab, selector: "#output" });
    const html = res.artifacts[0].data;
    assert.ok(html.includes("rgb(0, 102, 204)"), "heading colour inlined");
    assert.ok(/<td[^>]*style="[^"]*border/.test(html), "cell border inlined");
    assert.ok(!html.includes("导航"));
    assert.equal(res.result.stats.tables, 1);
    assert.equal(res.result.stats.imgs, 2);
    return `${res.result.stats.htmlLength} bytes`;
  });

  await step("黑名单手段：合成 paste 事件被（可信校验的）编辑器忽略", async () => {
    await bridge.call("run_js", {
      tabId: editorTab,
      code: `const pm = document.getElementById('pm'); pm.focus(); const dt = new DataTransfer(); dt.setData('text/html', '<p>synthetic</p>'); dt.setData('text/plain','synthetic'); pm.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return window.__pasteLog.at(-1);`,
    });
    const { result } = await bridge.call("run_js", { tabId: editorTab, code: "return { log: window.__pasteLog, text: document.getElementById('pm').innerText.trim() }" });
    assert.equal(result.result.log.at(-1).trusted, false);
    assert.ok(!result.result.text.includes("synthetic"));
  });

  await step("标题：set_input_value 原生 setter，pick 排除标题并选中正文", async () => {
    await bridge.call("set_input_value", { tabId: editorTab, selector: "#title", value: TITLE });
    const { result } = await bridge.call("wechat_pick_body_editor", { tabId: editorTab });
    assert.ok(result.reasons.includes("placeholder"));
    assert.equal(result.rect.w > 400, true, "picked the large body editor, not #side");
    assert.equal(result.excludedCount, 0);
  });

  let pasteRes;
  await step("paste_rich_trusted（来源页 → 编辑页，后台标签）→ 回读校验通过", async () => {
    pasteRes = await bridge.call("paste_rich_trusted", {
      tabId: editorTab,
      source: { tabId: doocsTab, selector: "#output" },
      titleEquals: TITLE,
      includeHtml: true,
    });
    const r = pasteRes.result;
    assert.equal(r.method, "trusted_paste");
    assert.equal(r.verify.stats.tables, 1);
    assert.equal(r.verify.stats.imgs, 2);
    assert.equal(r.verify.title, TITLE);
    const { result } = await bridge.call("run_js", { tabId: editorTab, code: "return window.__pasteLog.at(-1)" });
    assert.equal(result.result.trusted, true, "paste event isTrusted === true");
    assert.ok(result.result.types.includes("text/html"));
    const { result: tabs } = await bridge.call("list_tabs");
    assert.ok(!tabs.find((t) => t.id === editorTab).active, "editor tab was not brought to front");
    return `clipboard via ${r.clipboard.via}, attempts ${r.attempts.length}, chars ${r.verify.stats.chars}`;
  });

  await step("样式经剪贴板保留（h2 颜色 / 表格边框 / 链接）", async () => {
    const html = pasteRes.artifacts.find((a) => a.name === "editor.html").data;
    assert.ok(html.includes("rgb(0, 102, 204)"), "heading colour survived");
    assert.ok(/<td[^>]*style="[^"]*border/.test(html), "table cell style survived");
    assert.ok(html.includes("https://example.com/ref"));
  });

  await step("重试：前 1 次粘贴被编辑器吞掉 → 第 2 次成功（幂等替换，不重复内容）", async () => {
    await bridge.call("run_js", { tabId: editorTab, code: "window.__ignorePastes = 1; return true" });
    const res = await bridge.call("paste_rich_trusted", {
      tabId: editorTab,
      source: { tabId: doocsTab, selector: "#output" },
      titleEquals: TITLE,
      expect: { minChars: 100 },
    });
    assert.equal(res.result.attempts.length, 2);
    assert.equal(res.result.attempts[0].ok, false);
    const verify = await bridge.call("verify_editor_content", { tabId: editorTab, expect: { minTables: 1, minImages: 2 } });
    assert.equal(verify.result.stats.tables, 1, "replace=true keeps a single copy of the table");
    assert.equal(verify.result.stats.imgs, 2);
  });

  await step("失败路径：断言不可能满足 → VERIFY_FAILED（≤3 次尝试后停止）", async () => {
    const res = await bridge.callRaw("paste_rich_trusted", {
      tabId: editorTab,
      source: { tabId: doocsTab, selector: "#output" },
      expect: { minChars: 9999999 },
      settleMs: 200,
    });
    assert.equal(res.error.code, "VERIFY_FAILED");
    assert.equal(res.error.details.attempts.length, 3);
  });

  await step("路线二：copy_selection_trusted（Chrome 原生序列化）→ useClipboard 粘贴", async () => {
    await bridge.call("run_js", { tabId: editorTab, code: "document.getElementById('pm').innerHTML = '<p data-placeholder=\"从这里开始写正文\" class=\"is-empty\"><br></p>'; return true" });
    const copied = await bridge.call("copy_selection_trusted", { tabId: doocsTab, selector: "#output" });
    assert.equal(copied.result.selected.tables, 1);
    const res = await bridge.call("paste_rich_trusted", { tabId: editorTab, useClipboard: true, expect: { minChars: 100, minTables: 1, minImages: 2 }, titleEquals: TITLE, includeHtml: true });
    const html = res.artifacts[0].data;
    return `native copy keeps heading colour: ${html.includes("rgb(0, 102, 204)")}`;
  });

  await step("外部 CDP 客户端同时附加到编辑页：与 chrome.debugger 共存", async () => {
    const { targetInfos } = await bridge.conn.send("Target.getTargets");
    const target = targetInfos.find((t) => t.type === "page" && t.url.startsWith(`${base}/editor`));
    const { sessionId } = await bridge.conn.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    await bridge.conn.send("Runtime.enable", {}, sessionId);
    await bridge.conn.send("Page.enable", {}, sessionId);
    const res = await bridge.call("paste_rich_trusted", { tabId: editorTab, source: { tabId: doocsTab, selector: "#output" }, titleEquals: TITLE });
    assert.equal(res.result.verify.ok, true);
    const own = await bridge.conn.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sessionId);
    assert.equal(own.result.value, "Editor fixture", "external client still works");
    await bridge.conn.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  });

  await step("screenshot artifact（JPEG）", async () => {
    const res = await bridge.call("screenshot", { tabId: editorTab });
    const bytes = Buffer.from(res.artifacts[0].data, "base64");
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);
    return `${bytes.length} bytes`;
  });

  await step("async 长任务 + job_status 轮询", async () => {
    const ack = await bridge.callRaw("paste_rich_trusted", { tabId: editorTab, source: { tabId: doocsTab, selector: "#output" } }, { async: true });
    assert.equal(ack.result.status, "running");
    const done = await bridge.pollJob(ack.result.jobId, { timeoutMs: 30000 });
    assert.equal(done.ok, true, JSON.stringify(done.error));
  });

  await step("幂等：相同 id 重放返回缓存，不重复粘贴", async () => {
    const before = (await bridge.call("run_js", { tabId: editorTab, code: "return window.__pasteLog.length" })).result.result;
    const id = "e2e-idem-1";
    const args = { tabId: editorTab, source: { tabId: doocsTab, selector: "#output" } };
    const first = await bridge.callRaw("paste_rich_trusted", args, { id });
    const second = await bridge.callRaw("paste_rich_trusted", args, { id });
    assert.equal(first.ok, true);
    assert.equal(second.meta.replayed, true);
    const after = (await bridge.call("run_js", { tabId: editorTab, code: "return window.__pasteLog.length" })).result.result;
    assert.equal(after - before, 1);
  });

  await step("非白名单标签不可见/不可操作", async () => {
    await bridge.evaluate(`chrome.storage.local.set({ settings: { agentBridgeEnabled: true, agentBridgeOrigins: ["https://mp.weixin.qq.com"] } })`);
    const res = await bridge.callRaw("query_dom", { tabId: editorTab, selector: "body" });
    assert.equal(res.error.code, "ORIGIN_NOT_ALLOWED");
    const { result: tabs } = await bridge.call("list_tabs");
    assert.equal(tabs.filter((t) => t.url.startsWith(base)).length, 0);
  });
} finally {
  try {
    bridge?.close();
  } catch {
    /* ignore */
  }
  chrome?.kill();
  server.close();
  await new Promise((r) => setTimeout(r, 500));
  if (backup != null) {
    try {
      execFileSync("pbcopy", { input: backup });
    } catch {
      /* ignore */
    }
  }
  if (!keep) rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);

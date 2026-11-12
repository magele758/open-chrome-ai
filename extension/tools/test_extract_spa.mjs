import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { extractPage } from "../lib/extract.js";
import { createAgentTools } from "../lib/agent/tools.js";
import { buildRunRecord } from "../lib/run-recorder.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

// ── 1. extractPage self-contained structured fallback for SPA tables / dialogs / forms ──
{
  async function runSerializedExtract(html, url = "http://192.0.2.10:5173/#/tasks/board", setup = () => {}) {
    const dom = new JSDOM(html, { url, runScripts: "outside-only" });
    Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
      get() {
        return this.textContent;
      },
    });
    setup(dom.window);
    try {
      return await dom.window.eval(`(${extractPage.toString()})()`);
    } finally {
      dom.window.close();
    }
  }

  // 1a. Generic SPA with table + open dialog form + hidden modal + password input (zero <p> tags)
  const spaHtml = `
    <!doctype html>
    <html>
      <head><title>工单看板 - 运维工作台</title></head>
      <body>
        <div id="app">
          <nav class="layout-sider">侧栏导航噪音菜单</nav>
          <main class="layout-content">
            <div role="tablist">
              <div role="tab">待处理 30</div>
              <div role="tab">执行中 0</div>
              <div role="tab">已归档 0</div>
            </div>
            <table>
              <thead>
                <tr><th>工单编号</th><th>任务标题</th><th>部署节点</th><th>状态</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td>TASK-101</td>
                  <td>分布式缓存集群巡检</td>
                  <td>华东节点</td>
                  <td>待处理</td>
                </tr>
                <tr>
                  <td>TASK-102</td>
                  <td>网关证书轮换核验</td>
                  <td>华北节点</td>
                  <td>待处理</td>
                </tr>
              </tbody>
            </table>
          </main>
        </div>
        <div class="drawer-panel" role="dialog" aria-modal="true">
          <header>编辑巡检工单</header>
          <form>
            <div class="field-item">
              <label>*任务标题</label>
              <input type="text" value="分布式缓存集群每日例行巡检" />
            </div>
            <div class="field-item">
              <label>*部署集群</label>
              <select><option value="east" selected>华东生产集群</option></select>
            </div>
            <div class="field-item">
              <label>外站授权口令</label>
              <input type="password" value="NEVER_LEAK_SECRET_999" />
            </div>
            <div class="field-item">
              <label>自动重试勾选</label>
              <input type="checkbox" checked />
            </div>
          </form>
        </div>
        <div role="dialog" style="display: none;">
          已关闭隐藏弹窗内容_不应被抽取
        </div>
      </body>
    </html>
  `;

  const spaPack = await runSerializedExtract(spaHtml);
  assert.equal(spaPack.kind, "generic");
  assert.equal(spaPack.textTruncated, false);
  assert.match(spaPack.text, /\[dialog\]/);
  assert.match(spaPack.text, /编辑巡检工单/);
  assert.match(spaPack.text, /分布式缓存集群每日例行巡检/, "extracts live input value inside form");
  assert.match(spaPack.text, /华东生产集群/, "extracts selected option text");
  assert.match(spaPack.text, /\[checked\]/, "extracts checked checkbox state");
  assert.match(spaPack.text, /工单编号 \| 任务标题 \| 部署节点 \| 状态/, "formats table header with pipe separator");
  assert.match(spaPack.text, /TASK-101 \| 分布式缓存集群巡检 \| 华东节点 \| 待处理/, "formats table row cells");
  assert.match(spaPack.text, /待处理 30/);
  assert.ok(!spaPack.text.includes("侧栏导航噪音菜单"), "skips nav sidebar in main app container");
  assert.ok(!spaPack.text.includes("已关闭隐藏弹窗内容_不应被抽取"), "skips display:none hidden modal");
  assert.ok(!spaPack.text.includes("NEVER_LEAK_SECRET_999"), "never extracts password input values");

  const toolsForExtract = createAgentTools({
    getTabId: () => 21,
    refreshPack: async () => spaPack,
  });
  const formattedPage = await toolsForExtract.find((t) => t.name === "extract_page").execute({});
  assert.match(formattedPage, /类型：网页/);
  assert.match(formattedPage, /TASK-101 \| 分布式缓存集群巡检/);
  assert.match(formattedPage, /分布式缓存集群每日例行巡检/);

  // 1b. Large SPA table > 9000 chars sets textTruncated = true
  const manyRows = Array.from(
    { length: 220 },
    (_, i) => `<tr><td>TASK-${20000 + i}</td><td>超长运维工单摘要条目编号_${i}_容器节点健康检查与日志采样</td><td>华东节点</td><td>待处理</td></tr>`,
  ).join("");
  const hugeSpaPack = await runSerializedExtract(
    `<div id="app"><table><thead><tr><th>编号</th><th>标题</th><th>节点</th><th>状态</th></tr></thead><tbody>${manyRows}</tbody></table></div>`,
  );
  assert.equal(hugeSpaPack.text.length, 9000);
  assert.equal(hugeSpaPack.textTruncated, true);
  assert.ok(hugeSpaPack.textLength > 9000);

  // 1c. Traditional article page (>= 80 chars in <p>) keeps primary prose extractor unchanged
  const proseHtml = `
    <main>
      <article>
        <h1>传统技术博客文章标题说明</h1>
        <p>${"这是一段标准的技术博客正文段落，用于验证文章抽取主路径在字数充足时保持完全不变。".repeat(3)}</p>
        <form><input type="text" value="SEARCH_BOX_NOISE" /></form>
      </article>
    </main>
  `;
  const prosePack = await runSerializedExtract(proseHtml, "https://blog.example.com/post");
  assert.match(prosePack.text, /标准的技术博客正文段落/);
  assert.ok(!prosePack.text.includes("SEARCH_BOX_NOISE"), "article path still ignores inline search forms");
}

// ── 2. run-recorder trace[] enrichment with timestamp, pageUrl, failureReason from toolSteps ──
{
  const built = buildRunRecord({
    runId: "run_extract_trace_enrich",
    source: "sidepanel",
    startedAt: "2026-11-11T16:00:00.000Z",
    endedAt: "2026-11-11T16:00:05.000Z",
    extensionVersion: "0.12.1",
    gitCommit: "00c8b15",
    endReason: "stop",
    userPrompt: "截图并查看页面",
    botResponse: "已完成",
    trace: [
      { kind: "thinking", text: "先截图" },
      { kind: "tool", name: "screenshot", ok: false, status: "fail", args: {}, preview: "截图失败：未获取到页面画面。" },
      { kind: "tool", name: "extract_page", ok: true, status: "ok", args: {}, preview: "类型：网页\nTASK-101" },
    ],
    steps: [
      {
        type: "tool_exec",
        turn: 1,
        timestamp: 1794412801000,
        isoTime: "2026-11-11T16:00:01.000Z",
        toolName: "screenshot",
        args: {},
        ok: false,
        jsOk: true,
        failureReason: "截图失败：未获取到页面画面。",
        resultSummary: "截图失败：未获取到页面画面。",
        durationMs: 25,
        tabId: 21,
        pageUrl: "http://192.0.2.10:5173/#/tasks/board",
        pageTitle: "工单看板",
      },
      {
        type: "tool_exec",
        turn: 1,
        timestamp: 1794412802000,
        isoTime: "2026-11-11T16:00:02.000Z",
        toolName: "extract_page",
        args: {},
        ok: true,
        jsOk: true,
        failureReason: null,
        resultSummary: "类型：网页 TASK-101",
        durationMs: 18,
        tabId: 21,
        pageUrl: "http://192.0.2.10:5173/#/tasks/board",
        pageTitle: "工单看板",
        archiveHandle: "tool_2_extract_page",
      },
    ],
  });

  const toolTraceItems = built.traceRecord.trace.filter((x) => x.kind === "tool");
  assert.equal(toolTraceItems.length, 2);
  assert.equal(toolTraceItems[0].timestamp, 1794412801000);
  assert.equal(toolTraceItems[0].isoTime, "2026-11-11T16:00:01.000Z");
  assert.equal(toolTraceItems[0].tabId, 21);
  assert.equal(toolTraceItems[0].pageUrl, "http://192.0.2.10:5173/#/tasks/board");
  assert.equal(toolTraceItems[0].failureReason, "截图失败：未获取到页面画面。");
  assert.equal(toolTraceItems[1].timestamp, 1794412802000);
  assert.equal(toolTraceItems[1].pageUrl, "http://192.0.2.10:5173/#/tasks/board");
  assert.equal(toolTraceItems[1].failureReason, null);
  assert.equal(toolTraceItems[1].archiveHandle, "tool_2_extract_page");
}

console.log("PASS test_extract_spa.mjs");

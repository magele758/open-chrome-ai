import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { extractPage } from "../lib/extract.js";
import { createAgentTools } from "../lib/agent/tools.js";
import { buildRunRecord } from "../lib/run-recorder.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

// ── 1. ADR-003: screenshot automatic CDP fallback + captureTab({ silent }) suppressing UI errors ──
{
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='msgs'></div><button id='send'></button><div id='save-status'></div></body></html>",
    { url: "chrome-extension://ext-r1-test/sidepanel/index.html" },
  );
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;

  const tabsById = new Map([
    [
      21,
      {
        id: 21,
        windowId: 1,
        active: true,
        title: "妙手采集箱",
        url: "http://10.2.31.12:5173/#/goods/collect",
      },
    ],
    [
      99,
      {
        id: 99,
        windowId: 1,
        active: false,
        title: "Settings",
        url: "chrome://settings",
      },
    ],
  ]);

  let captureVisibleImpl = async () => {
    throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
  };

  globalThis.chrome = {
    tabs: {
      get: async (id) => {
        const t = tabsById.get(Number(id));
        if (!t) throw new Error(`No tab with id: ${id}`);
        return t;
      },
      query: async () => [tabsById.get(21)],
      update: async (id, patch) => ({ ...tabsById.get(Number(id)), ...patch }),
      captureVisibleTab: async (...args) => captureVisibleImpl(...args),
      onUpdated: { addListener() {}, removeListener() {} },
    },
    windows: { update: async () => ({}) },
    debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
    runtime: {
      id: "ext-r1-test",
      getManifest: () => ({ version: "0.12.1" }),
      getURL: (p) => `chrome-extension://ext-r1-test/${p}`,
      sendMessage: async () => ({ ok: true }),
    },
  };

  const { state } = await import("../sidepanel/state.js");
  const { setUiErrorObserver } = await import("../sidepanel/messages.js");
  const { captureTab: sidepanelCaptureTab } = await import("../sidepanel/video-actions.js");

  state.tab = tabsById.get(21);
  state.pack = { url: state.tab.url, title: state.tab.title };

  const observedUiErrors = [];
  setUiErrorObserver((msg) => observedUiErrors.push(msg));

  const origWarn = console.warn;
  const origError = console.error;
  const warnAndErrors = [];
  console.warn = (...a) => warnAndErrors.push(["warn", ...a]);
  console.error = (...a) => warnAndErrors.push(["error", ...a]);

  try {
    // 1a. Default silent=false keeps legacy manual button behavior: calls pushError and returns null
    const legacyOut = await sidepanelCaptureTab(21);
    assert.equal(legacyOut, null);
    assert.equal(observedUiErrors.length, 1);
    assert.match(observedUiErrors[0], /截图失败：.*系统安全策略保护/);
    observedUiErrors.length = 0;

    // 1b. silent=true suppresses pushError and rethrows underlying error for caller fallback
    await assert.rejects(
      () => sidepanelCaptureTab(21, { silent: true }),
      /系统安全策略保护/,
    );
    assert.equal(observedUiErrors.length, 0, "silent=true must not pollute sidepanelErrors");

    // 1c. screenshot tool automatically falls back to cdpScreenshot with ZERO sidepanelErrors
    let cdpCalls = [];
    let attachedImage = null;
    const mockCdp = {
      async send(tabId, method, params) {
        cdpCalls.push({ tabId, method, params });
        if (method === "Page.captureScreenshot") {
          return { data: "R0lGODlhAQABAAAAACw=" };
        }
        throw new Error(`unexpected CDP method ${method}`);
      },
    };

    const agentTools = createAgentTools({
      getTabId: () => 21,
      getWindowId: () => 1,
      cdp: mockCdp,
      settings: { cdpInput: true },
      capture: (id, opts) => sidepanelCaptureTab(id, opts),
      setImage: (url) => {
        attachedImage = url;
      },
    });
    const screenshotTool = agentTools.find((t) => t.name === "screenshot");

    const okMsg = await screenshotTool.execute({});
    assert.match(okMsg, /已截取当前画面/);
    assert.equal(attachedImage, "data:image/jpeg;base64,R0lGODlhAQABAAAAACw=");
    assert.equal(cdpCalls.length, 1);
    assert.equal(cdpCalls[0].tabId, 21);
    assert.equal(cdpCalls[0].method, "Page.captureScreenshot");
    assert.equal(observedUiErrors.length, 0, "CDP fallback must emit zero UI errors");
    assert.equal(warnAndErrors.length, 0, "expected fallback must not call console.warn/error");

    // 1d. Empty null return from ctx.capture also triggers CDP fallback
    attachedImage = null;
    cdpCalls = [];
    captureVisibleImpl = async () => null;
    const okFromNull = await screenshotTool.execute({});
    assert.match(okFromNull, /已截取当前画面/);
    assert.equal(attachedImage, "data:image/jpeg;base64,R0lGODlhAQABAAAAACw=");
    assert.equal(cdpCalls.length, 1);
    assert.equal(observedUiErrors.length, 0);

    // 1e. Restricted chrome:// tab skips CDP attach and returns explicit restricted error
    cdpCalls = [];
    captureVisibleImpl = async () => {
      throw new Error("should not reach captureVisibleTab on chrome://");
    };
    const restrictedMsg = await screenshotTool.execute({ tabId: 99 });
    assert.match(restrictedMsg, /^截图失败：受限页/);
    assert.equal(cdpCalls.length, 0, "must not attempt CDP screenshot on chrome:// restricted tab");
    assert.equal(observedUiErrors.length, 0);

    // 1f. When both captureVisibleTab and CDP fail, returns combined failure reason cleanly
    captureVisibleImpl = async () => {
      throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
    };
    const failingTools = createAgentTools({
      getTabId: () => 21,
      getWindowId: () => 1,
      cdp: {
        async send() {
          throw new Error("debugger detached");
        },
      },
      settings: { cdpInput: true },
      capture: (id, opts) => sidepanelCaptureTab(id, opts),
      setImage: () => {},
    });
    const bothFailMsg = await failingTools.find((t) => t.name === "screenshot").execute({});
    assert.match(bothFailMsg, /^截图失败：debugger detached/);
    assert.equal(observedUiErrors.length, 0);
  } finally {
    setUiErrorObserver(null);
    console.warn = origWarn;
    console.error = origError;
    dom.window.close();
  }
  console.log("PASS 1. screenshot automatic CDP fallback + silent captureTab");
}

// ── 2. ADR-004: extractPage self-contained structured fallback for SPA tables / drawers / forms ──
{
  async function runSerializedExtract(html, url = "http://10.2.31.12:5173/#/goods/collect", setup = () => {}) {
    const dom = new JSDOM(html, { url, runScripts: "outside-only" });
    Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
      get() {
        return this.textContent;
      },
    });
    setup(dom.window);
    try {
      // Execute via Function.prototype.toString() just like chrome.scripting.executeScript!
      return await dom.window.eval(`(${extractPage.toString()})()`);
    } finally {
      dom.window.close();
    }
  }

  // 2a. Ant Design SPA with table + open drawer form + hidden modal + password input (zero <p> tags)
  const spaHtml = `
    <!doctype html>
    <html>
      <head><title>采集箱 - 跨境ERP</title></head>
      <body>
        <div id="app">
          <nav class="ant-layout-sider">侧栏导航噪音菜单</nav>
          <div class="ant-layout-content">
            <div class="ant-tabs-nav">
              <div class="ant-tabs-tab">未发布 30</div>
              <div class="ant-tabs-tab">发布中 0</div>
              <div class="ant-tabs-tab">已发布 0</div>
            </div>
            <table>
              <thead>
                <tr><th>商品ID</th><th>商品标题</th><th>站点</th><th>状态</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td>SPU-10086</td>
                  <td>便携式折叠收纳箱大容量</td>
                  <td>美国站</td>
                  <td>未发布</td>
                </tr>
                <tr>
                  <td>SPU-10087</td>
                  <td>不锈钢保温杯车载水杯</td>
                  <td>欧洲站</td>
                  <td>未发布</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="ant-drawer-content" role="dialog" aria-modal="true">
          <div class="ant-drawer-header">编辑采集商品</div>
          <form class="ant-form">
            <div class="ant-form-item">
              <label>*商品标题</label>
              <input type="text" value="便携式折叠收纳箱大容量家用储物盒" />
            </div>
            <div class="ant-form-item">
              <label>*发布站点</label>
              <select><option value="us" selected>Temu 美国半托管</option></select>
            </div>
            <div class="ant-form-item">
              <label>外站授权口令</label>
              <input type="password" value="NEVER_LEAK_SECRET_999" />
            </div>
            <div class="ant-form-item">
              <label>包邮勾选</label>
              <input type="checkbox" checked />
            </div>
          </form>
        </div>
        <div class="ant-modal-content" role="dialog" style="display: none;">
          已关闭隐藏弹窗内容_不应被抽取
        </div>
      </body>
    </html>
  `;

  const spaPack = await runSerializedExtract(spaHtml);
  assert.equal(spaPack.kind, "generic");
  assert.equal(spaPack.textTruncated, false);
  assert.match(spaPack.text, /【弹窗\/抽屉】/);
  assert.match(spaPack.text, /编辑采集商品/);
  assert.match(spaPack.text, /便携式折叠收纳箱大容量家用储物盒/, "extracts live input value inside form");
  assert.match(spaPack.text, /Temu 美国半托管/, "extracts selected option text");
  assert.match(spaPack.text, /\[已勾选\]/, "extracts checked checkbox state");
  assert.match(spaPack.text, /商品ID \| 商品标题 \| 站点 \| 状态/, "formats table header with pipe separator");
  assert.match(spaPack.text, /SPU-10086 \| 便携式折叠收纳箱大容量 \| 美国站 \| 未发布/, "formats table row cells");
  assert.match(spaPack.text, /未发布 30/);
  assert.ok(!spaPack.text.includes("侧栏导航噪音菜单"), "skips nav sidebar in main app container");
  assert.ok(!spaPack.text.includes("已关闭隐藏弹窗内容_不应被抽取"), "skips display:none hidden modal");
  assert.ok(!spaPack.text.includes("NEVER_LEAK_SECRET_999"), "never extracts password input values");

  // Verify extract_page tool formats the SPA pack with full body
  const toolsForExtract = createAgentTools({
    getTabId: () => 21,
    refreshPack: async () => spaPack,
  });
  const formattedPage = await toolsForExtract.find((t) => t.name === "extract_page").execute({});
  assert.match(formattedPage, /类型：网页/);
  assert.match(formattedPage, /SPU-10086 \| 便携式折叠收纳箱大容量/);
  assert.match(formattedPage, /便携式折叠收纳箱大容量家用储物盒/);

  // 2b. Large SPA table > 9000 chars sets textTruncated = true
  const manyRows = Array.from(
    { length: 220 },
    (_, i) => `<tr><td>SPU-${20000 + i}</td><td>超长跨境商品标题测试条目编号_${i}_防水耐磨收纳袋户外旅行装备</td><td>美国站</td><td>未发布</td></tr>`,
  ).join("");
  const hugeSpaPack = await runSerializedExtract(
    `<div id="app"><table><thead><tr><th>ID</th><th>标题</th><th>站点</th><th>状态</th></tr></thead><tbody>${manyRows}</tbody></table></div>`,
  );
  assert.equal(hugeSpaPack.text.length, 9000);
  assert.equal(hugeSpaPack.textTruncated, true);
  assert.ok(hugeSpaPack.textLength > 9000);

  // 2c. Traditional article page (>= 80 chars in <p>) keeps primary prose extractor unchanged
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
  console.log("PASS 2. extractPage structured SPA table/drawer/form fallback");
}

// ── 3. run-recorder trace[] enrichment with timestamp, pageUrl, failureReason from toolSteps ──
{
  const built = buildRunRecord({
    runId: "run_r1_trace_enrich",
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
      { kind: "tool", name: "extract_page", ok: true, status: "ok", args: {}, preview: "类型：网页\nSPU-10086" },
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
        pageUrl: "http://10.2.31.12:5173/#/goods/collect",
        pageTitle: "采集箱",
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
        resultSummary: "类型：网页 SPU-10086",
        durationMs: 18,
        tabId: 21,
        pageUrl: "http://10.2.31.12:5173/#/goods/collect",
        pageTitle: "采集箱",
        archiveHandle: "tool_2_extract_page",
      },
    ],
  });

  const toolTraceItems = built.traceRecord.trace.filter((x) => x.kind === "tool");
  assert.equal(toolTraceItems.length, 2);
  assert.equal(toolTraceItems[0].timestamp, 1794412801000);
  assert.equal(toolTraceItems[0].isoTime, "2026-11-11T16:00:01.000Z");
  assert.equal(toolTraceItems[0].tabId, 21);
  assert.equal(toolTraceItems[0].pageUrl, "http://10.2.31.12:5173/#/goods/collect");
  assert.equal(toolTraceItems[0].failureReason, "截图失败：未获取到页面画面。");
  assert.equal(toolTraceItems[1].timestamp, 1794412802000);
  assert.equal(toolTraceItems[1].pageUrl, "http://10.2.31.12:5173/#/goods/collect");
  assert.equal(toolTraceItems[1].failureReason, null);
  assert.equal(toolTraceItems[1].archiveHandle, "tool_2_extract_page");
  console.log("PASS 3. run-recorder trace[] enrichment from toolSteps");
}

console.log("ALL PASS test_round01_fixes.mjs");

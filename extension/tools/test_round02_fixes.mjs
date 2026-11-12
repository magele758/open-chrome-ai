import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pageAct, runJs, scrollPage } from "../lib/agent/page-fns.js";
import { createAgentTools, resolveActiveTools } from "../lib/agent/tools.js";
import { extractCapsule } from "../lib/agent/trust/capsule.js";
import { packToContext } from "../lib/prompts.js";
import { buildRunRecord, classifyToolOutcome } from "../lib/run-recorder.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

// ── 1. ADR-007a: pageAct("wait", { text }) matches modal titles / headings / text nodes (deepest visible),
//    while click stays strictly on CONTROLS, and already-visible / oversized modals do not scrollIntoView ──
{
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div id="app">
        <div class="ant-modal-wrap" role="dialog" aria-modal="true">
          <div class="ant-modal collection-create-modal">
            <div class="ant-modal-header">
              <div class="ant-modal-title" id="modal-title">编辑商品</div>
            </div>
            <div class="ant-modal-body">
              <span class="field-label">*商品名称</span>
              <button id="cancel-btn" type="button">取消</button>
            </div>
          </div>
        </div>
        <div id="below-fold">底部延迟块</div>
      </div>
    </body></html>`,
    { url: "https://10.2.31.12:21006/ai-shop-cross-country/#/ai-tools-kj-cross", runScripts: "outside-only" },
  );

  try {
    const win = dom.window;
    Object.defineProperty(win, "innerHeight", { value: 900, configurable: true });
    Object.defineProperty(win, "innerWidth", { value: 1440, configurable: true });
    Object.defineProperty(win.HTMLElement.prototype, "innerText", {
      get() {
        return this.textContent;
      },
    });

    const scrollCalls = [];
    win.HTMLElement.prototype.scrollIntoView = function (opts) {
      scrollCalls.push({ id: this.id || this.className || this.tagName, opts });
    };

    // Give visible layout rects: modal wrap is tall (800px > 900 * 0.6), modal title is inside viewport, below-fold is at y=1400
    win.HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.style?.display === "none") return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
      if (this.id === "below-fold") {
        return { top: 1400, bottom: 1432, left: 40, right: 240, width: 200, height: 32 };
      }
      if (this.classList.contains("ant-modal-wrap") || this.classList.contains("ant-modal")) {
        return { top: 40, bottom: 840, left: 100, right: 1300, width: 1200, height: 800 };
      }
      return { top: 64, bottom: 92, left: 120, right: 320, width: 200, height: 28 };
    };

    const runPageAct = (kind, spec) =>
      win.eval(`(${pageAct.toString()})(${JSON.stringify(kind)}, ${JSON.stringify(spec)})`);

    // 1a. wait({ text: "编辑商品" }) matches deepest visible <div id="modal-title" class="ant-modal-title">编辑商品</div>
    //     and does NOT call scrollIntoView because it is already in viewport!
    const waitHit = await runPageAct("wait", { text: "编辑商品", timeoutMs: 500 });
    assert.equal(waitHit.ok, true);
    assert.equal(waitHit.match.tag, "div");
    assert.equal(waitHit.match.id, "modal-title", "must pick deepest matching element rather than outer dialog wrapper");
    assert.equal(waitHit.match.text, "编辑商品");
    assert.equal(scrollCalls.length, 0, "must not scrollIntoView when element is already inside viewport");

    // 1b. click({ text: "编辑商品" }) still strictly searches CONTROLS only and refuses to click non-control title div
    const clickTitle = await runPageAct("click", { text: "编辑商品" });
    assert.equal(clickTitle.ok, false);
    assert.equal(clickTitle.notFound, true);
    assert.match(clickTitle.error, /没有匹配「编辑商品」的可见控件/);

    // 1c. click({ text: "取消" }) still clicks real button control normally
    const clickCancel = await runPageAct("click", { text: "取消" });
    assert.equal(clickCancel.ok, true);
    assert.equal(clickCancel.match.id, "cancel-btn");
    scrollCalls.length = 0;

    // 1d. Below-fold non-control element DOES scrollIntoView({ block: "nearest", behavior: "instant" }) on wait
    const waitBelow = await runPageAct("wait", { text: "底部延迟块", timeoutMs: 400 });
    assert.equal(waitBelow.ok, true);
    assert.equal(waitBelow.match.id, "below-fold");
    assert.equal(scrollCalls.length, 1);
    assert.deepEqual({ ...scrollCalls[0].opts }, { block: "nearest", behavior: "instant" });

    // 1e. Delayed dynamic modal render succeeds within timeoutMs; missing text reports updated error classified as failure
    win.setTimeout(() => {
      const toast = win.document.createElement("div");
      toast.id = "async-banner";
      toast.textContent = "分配商品图片";
      win.document.getElementById("app").appendChild(toast);
    }, 60);
    const delayedWait = await runPageAct("wait", { text: "分配商品图片", timeoutMs: 1200 });
    assert.equal(delayedWait.ok, true);
    assert.equal(delayedWait.match.id, "async-banner");

    const missWait = await runPageAct("wait", { text: "不存在的文案XYZ", timeoutMs: 220 });
    assert.equal(missWait.ok, false);
    assert.equal(missWait.notFound, true);
    assert.match(missWait.error, /没有匹配「不存在的文案XYZ」的可见元素或文字/);
    assert.equal(classifyToolOutcome("wait_for", JSON.stringify(missWait), false).ok, false);
    assert.equal(classifyToolOutcome("wait_for", missWait.error, false).ok, false);

    // 1f. waitProbe works for cross-frame actInFrames fallback in tools.js
    const probeHit = await runPageAct("waitProbe", { text: "编辑商品" });
    assert.equal(probeHit.ok, true);
    assert.equal(probeHit.match.id, "modal-title");
  } finally {
    dom.window.close();
  }

  // Verify tools.js wait_for falls back across frames using waitProbe
  const seenFrameCalls = [];
  globalThis.chrome = {
    tabs: {
      get: async (id) => ({ id, windowId: 1, url: "https://10.2.31.12:21006/app", active: true }),
      query: async () => [{ id: 5, windowId: 1, url: "https://10.2.31.12:21006/app", active: true }],
    },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        seenFrameCalls.push({ allFrames: Boolean(target.allFrames), frameIds: target.frameIds, kind: args?.[0], funcName: func.name });
        if (!target.allFrames && !target.frameIds) {
          return [{ frameId: 0, result: { ok: false, notFound: true, error: "没有匹配「子帧标题」的可见元素或文字" } }];
        }
        if (target.allFrames) {
          assert.equal(args[0], "waitProbe", "wait_for cross-frame probe must use waitProbe");
          return [
            { frameId: 0, result: { ok: false, notFound: true } },
            { frameId: 3, result: { ok: true, count: 1, match: { tag: "h2", text: "子帧标题" } } },
          ];
        }
        return [{ frameId: 3, result: { ok: true, waitedMs: 12, match: { tag: "h2", text: "子帧标题" }, count: 1 } }];
      },
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: { id: "ext-r2" },
  };
  const frameTools = createAgentTools({ getTabId: () => 5, getWindowId: () => 1, settings: { cdpInput: false } });
  const frameWaitOut = JSON.parse(await frameTools.find((t) => t.name === "wait_for").execute({ text: "子帧标题", timeoutMs: 300 }));
  assert.equal(frameWaitOut.ok, true);
  assert.equal(frameWaitOut.frameId, 3);
  console.log("PASS 1. wait_for({ text }) modal title / text container & cross-frame waitProbe");
}

// ── 2. ADR-007b: scrollPage scrolls active modal internal scroller with behavior: "auto" ──
{
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div id="page-el">页面节点</div>
      <div class="ant-modal-wrap" role="dialog" style="z-index: 1000;">
        <div class="ant-modal collection-create-modal">
          <div class="collection-create-modal__content" id="modal-scroller" style="overflow-y: auto;">内容</div>
        </div>
      </div>
    </body></html>`,
    { url: "https://10.2.31.12:21006/app", runScripts: "outside-only" },
  );
  try {
    const win = dom.window;
    const windowScrollCalls = [];
    const elScrollIntoViewCalls = [];
    let modalScrollToArgs = null;

    win.scrollTo = (arg) => windowScrollCalls.push(arg);
    win.HTMLElement.prototype.scrollIntoView = function (opts) {
      elScrollIntoViewCalls.push(opts);
    };
    win.HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.style?.display === "none") return { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
      return { width: 800, height: 500, top: 40, bottom: 540, left: 80, right: 880 };
    };

    const scroller = win.document.getElementById("modal-scroller");
    Object.defineProperty(scroller, "scrollHeight", { value: 2200, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true });
    scroller.scrollTo = function (opts) {
      modalScrollToArgs = opts;
      this.scrollTop = opts.top;
    };

    const runScroll = (opts) => win.eval(`(${scrollPage.toString()})(${JSON.stringify(opts)})`);

    // 2a. scrollPage({ y: 600 }) scrolls .collection-create-modal__content with behavior: "instant"
    const resY = runScroll({ y: 600 });
    assert.equal(resY.ok, true);
    assert.equal(resY.via, "modal-y");
    assert.equal(scroller.scrollTop, 600);
    assert.equal(modalScrollToArgs?.behavior, "instant");
    assert.equal(windowScrollCalls.length, 0, "must scroll modal container rather than window");

    // 2b. scrollPage({ percent: 50 }) scrolls modal container to 50% of (2200 - 500) = 850
    const resPct = runScroll({ percent: 50 });
    assert.equal(resPct.ok, true);
    assert.equal(resPct.via, "modal-percent");
    assert.equal(scroller.scrollTop, 850);
    assert.equal(modalScrollToArgs?.behavior, "instant");

    // 2c. When modal is hidden, scrollPage({ y: 300 }) falls back to window with behavior: "instant"
    win.document.querySelector(".ant-modal-wrap").style.display = "none";
    const resWin = runScroll({ y: 300 });
    assert.equal(resWin.ok, true);
    assert.equal(resWin.via, "y");
    assert.deepEqual({ ...windowScrollCalls[0] }, { top: 300, behavior: "instant" });

    // 2d. selector scroll uses behavior: "instant"
    const resSel = runScroll({ selector: "#page-el" });
    assert.equal(resSel.ok, true);
    assert.equal(resSel.via, "selector");
    assert.equal(elScrollIntoViewCalls[0].behavior, "instant");
  } finally {
    dom.window.close();
  }
  console.log("PASS 2. scrollPage modal internal scroller & behavior === 'instant'");
}

// ── 3. ADR-008: runJs returns value for sync IIFE, async IIFE, object literal, trailing semicolon, and multi-statement ──
{
  const iifeSync = await runJs("(() => { const x = 42; return { x, ok: true }; })()");
  assert.deepEqual(iifeSync, { ok: true, result: { x: 42, ok: true } });

  const iifeAsyncSemi = await runJs("(async () => ({ ok: 1, tag: 'temu' }))();");
  assert.deepEqual(iifeAsyncSemi, { ok: true, result: { ok: 1, tag: "temu" } });

  const iifeWithComment = await runJs("(() => { const hits = [1, 2]; return { count: hits.length }; })(); // R2 inspect");
  assert.deepEqual(iifeWithComment, { ok: true, result: { count: 2 } });

  const objLiteral = await runJs("{ a: 1, b: 'two' }");
  assert.deepEqual(objLiteral, { ok: true, result: { a: 1, b: "two" } });

  const multiStmt = await runJs("const a = 2; const b = 3; return a * b;");
  assert.deepEqual(multiStmt, { ok: true, result: 6 });

  const sideEffectOnce = (() => {
    globalThis.__plR2Count = 0;
    return runJs("globalThis.__plR2Count += 1; return globalThis.__plR2Count;");
  })();
  assert.deepEqual(await sideEffectOnce, { ok: true, result: 1 }, "multi-statement fallback must execute only once");
  delete globalThis.__plR2Count;

  const syntaxBad = await runJs("function ( {");
  assert.equal(syntaxBad.ok, false);
  console.log("PASS 3. runJs sync/async IIFE, object literal, and multi-statement return values");
}

// ── 4. ADR-009a: sendPrompt / executeLoop / buildRunRecord isolate userPrompt & resolveActiveTools from 【页面正文】<untrusted_page> ──
{
  const rawPrompt = "请核对当前采集箱第一行商品标题并点击编辑按钮（保留此句首尾精确字符）";
  const noisyPack = {
    title: "探果采集箱",
    url: "https://10.2.31.12:21006/ai-shop-cross-country/#/ai-tools-kj-cross?view=tools&menu=collectionBox",
    kind: "generic",
    // Contains noisy keywords from the web page that previously polluted resolveActiveTools:
    text: "全部 30 | 未发布 30 | 历史记录 | 书签同步 | 产品视频 | 字幕文稿 | 保存到文稿知识库 | 切换深色主题设置",
  };
  const pageContext = packToContext(noisyPack);
  const combinedText = `${rawPrompt}\n\n${pageContext}`;

  // 4a. buildRunRecord strips accidental attached page context while keeping attachedContextChars
  const directBundle = buildRunRecord({
    runId: "run_r2_prompt_clean",
    source: "sidepanel",
    startedAt: "2026-11-11T16:40:00.000Z",
    endedAt: "2026-11-11T16:40:02.000Z",
    userPrompt: combinedText,
    botResponse: "已核对",
    history: [{ role: "user", content: combinedText }, { role: "assistant", content: "已核对" }],
  });
  assert.equal(directBundle.traceRecord.userPrompt, rawPrompt, "buildRunRecord keeps verbatim raw userPrompt");
  assert.equal(directBundle.traceRecord.attachedContextChars, pageContext.length);
  assert.ok(
    directBundle.traceRecord.conversationMessages[0].content.includes("<untrusted_page"),
    "conversationMessages still retains full model input",
  );

  // 4b. resolveActiveTools ignores <untrusted_page> in userText AND tool messages in history
  const allTools = createAgentTools({ getTabId: () => 1, getWindowId: () => 1, settings: {} });
  const routed = resolveActiveTools({
    userText: combinedText,
    history: [
      {
        role: "tool",
        content: '<untrusted_page source="extract_page">\n历史记录 产品视频 保存到文稿 深色主题设置 shell 命令\n</untrusted_page>',
      },
    ],
    tools: allTools,
    hasVideo: false,
  }).map((t) => t.name);
  assert.ok(routed.includes("extract_page") && routed.includes("click"), "keeps core_reader + dom_interact");
  assert.ok(!routed.includes("seek_video"), "untrusted page 视频/字幕 must not activate media_player");
  assert.ok(!routed.includes("search_history"), "untrusted page 历史记录/书签 must not activate browser_mgmt");
  assert.ok(!routed.includes("write_library") && !routed.includes("run_shell"), "untrusted page 文稿/shell must not activate system_ops");
  assert.ok(!routed.includes("update_settings"), "untrusted page 深色主题设置 must not activate settings");

  // 4c. Real sidepanel sendPrompt -> executeLoop -> persistRunBundle end-to-end check
  const spDom = new JSDOM(
    "<!doctype html><html><body><div id='msgs'></div><button id='send'></button><div id='save-status'></div></body></html>",
    { url: "chrome-extension://ext-r2-sp/sidepanel/index.html" },
  );
  globalThis.window = spDom.window;
  globalThis.document = spDom.window.document;
  globalThis.NodeFilter = spDom.window.NodeFilter;

  const downloads = [];
  globalThis.chrome = {
    tabs: {
      get: async (id) => ({ id, windowId: 1, url: noisyPack.url, title: noisyPack.title, active: true }),
      query: async () => [{ id: 31, windowId: 1, url: noisyPack.url, title: noisyPack.title, active: true }],
    },
    scripting: {
      executeScript: async () => [{ result: noisyPack }],
    },
    downloads: {
      download: async (opts) => {
        downloads.push(opts);
        return downloads.length;
      },
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
    runtime: {
      id: "ext-r2-sp",
      getManifest: () => ({ version: "0.12.1" }),
      getURL: (p) => `chrome-extension://ext-r2-sp/${p}`,
      sendMessage: async () => ({ ok: true }),
    },
  };

  let capturedTurnToolCount = 0;
  let capturedModelUserContent = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith(".dev-reload-stamp")) {
      return new Response(JSON.stringify({ gitCommit: "711d81c" }), { status: 200 });
    }
    const reqBody = JSON.parse(init.body);
    capturedTurnToolCount = Array.isArray(reqBody.tools) ? reqBody.tools.length : 0;
    const userMsg = [...reqBody.messages].reverse().find((m) => m.role === "user");
    capturedModelUserContent = String(userMsg?.content || "");
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: "核验完毕" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  try {
    const { state } = await import("../sidepanel/state.js");
    const { sendPrompt } = await import("../sidepanel/agent-loop.js");

    state.sessionId = "sess_r2_prompt_isolation";
    state.share = true;
    state.tab = { id: 31, windowId: 1, url: noisyPack.url, title: noisyPack.title };
    state.pack = { ...noisyPack, hasVideo: false };
    state.messages = [];
    state.capsule = null;
    state.settings = {
      ...state.settings,
      skillsEnabled: false,
      diagnostics: { autoExportRunBundle: false },
      providers: [{ id: "p1", name: "Test", baseUrl: "https://llm.example/v1", apiKey: "sk-unit-test-only", models: [{ id: "m1" }] }],
      textRef: { providerId: "p1", modelId: "m1" },
      text: { baseUrl: "https://llm.example/v1", apiKey: "sk-unit-test-only", model: "m1" },
    };

    await sendPrompt(rawPrompt);
    assert.equal(downloads.length, 0, "persistRunBundle does not auto-download when autoExportRunBundle is false");
    assert.equal(state.messages.at(-1)?.traceLog?.userPrompt, rawPrompt, "in-memory traceLog still populated");

    state.settings = {
      ...state.settings,
      diagnostics: { autoExportRunBundle: true },
    };
    await sendPrompt(rawPrompt);

    const traceDl = downloads.find((d) => d.filename.includes("pagelens-trace-"));
    assert.ok(traceDl, "sidepanel trace persisted when autoExportRunBundle is explicitly enabled");
    const b64 = traceDl.url.split(",")[1];
    const persistedTrace = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));

    assert.equal(persistedTrace.userPrompt, rawPrompt, "persisted trace.userPrompt equals raw user input 100% verbatim");
    assert.ok(persistedTrace.attachedContextChars > 50, "attachedContextChars recorded");
    assert.ok(capturedModelUserContent.includes("【页面正文】"), "model still receives attached page context");
    assert.ok(capturedTurnToolCount <= 40, `noisy page context must not bloat active tools to 70+, got ${capturedTurnToolCount}`);
  } finally {
    globalThis.fetch = origFetch;
    spDom.window.close();
  }
  console.log("PASS 4. sendPrompt / executeLoop / buildRunRecord userPrompt verbatim isolation");
}

// ── 5. Generic prohibition clause stripping & active tool routing verification ──
{
  const promptText = [
    "请留在当前页面（https://192.0.2.10:8080/workspace/#/items）填写表单字段并点击下一步按钮。",
    "绝对禁止点击任何行的「发布」或「删除」或「上传文件」按钮！绝对禁止打开或跳转到 external.example.org！严禁运行 shell 命令或修改插件设置！",
  ].join("\n");

  const allTools = createAgentTools({ getTabId: () => 1, getWindowId: () => 1, settings: {} });
  const cap = extractCapsule(promptText);
  assert.deepEqual([...cap.actions].sort(), ["input", "navigate"]);
  for (const unwanted of ["write", "close", "publish", "delete", "upload", "send", "shell", "automation", "settings"]) {
    assert.ok(!cap.actions.includes(unwanted), `must not grant ${unwanted}`);
  }
  assert.deepEqual(cap.origins, ["192.0.2.10"]);

  const active = resolveActiveTools({ userText: promptText, tools: allTools, hasVideo: false });
  const activeNames = active.map((t) => t.name);
  assert.ok(activeNames.includes("extract_page") && activeNames.includes("click") && activeNames.includes("request_toolsets"));
  assert.ok(!activeNames.includes("open_tab"), "prohibited navigation clause does not activate browser_mgmt");
  assert.ok(!activeNames.includes("run_shell") && !activeNames.includes("write_library"), "no system_ops bloat");
  assert.ok(!activeNames.includes("seek_video"), "no media_player bloat");
  assert.ok(!activeNames.includes("update_settings"), "no settings bloat");
  assert.ok(active.length <= 40, `active tools trimmed to core_reader + dom_interact, got ${active.length}`);

  console.log("PASS 5. Generic prohibition clause capsule & active tool routing verified");
}

console.log("ALL PASS test_round02_fixes.mjs");

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { recordDelegateTaskFinish } from "../lib/agent/delegate-sw.js";
import { runDeterministicWorkflow } from "../lib/agent/workflow/engine.js";
import {
   exportManualDiagnosticL1,
  onAgentRunCompleted,
} from "../lib/debug/hooks.js";
import {
  DEBUG_LIMIT,
  DEBUG_LIMIT_L0,
  DEBUG_LIMIT_L1,
  DEBUG_SESSION_STORAGE_KEY,
  L1_RUN_SUMMARY_LIMIT,
  configureDebugLog,
  debugLog,
  exportDebugLog,
  exportDebugLogFresh,
  hydrateDebugLog,
  resetDebugLogForTests,
} from "../lib/debug/ring-log.js";

function makeSessionArea(initial = {}) {
  const bag = { ...initial };
  let writes = 0;
  return {
    bag,
    get writes() {
      return writes;
    },
    async get(key) {
      if (key == null) return { ...bag };
      if (typeof key === "string") return key in bag ? { [key]: structuredClone(bag[key]) } : {};
      return {};
    },
    async set(patch) {
      writes += 1;
      for (const [k, v] of Object.entries(patch)) {
        bag[k] = structuredClone(v);
      }
    },
    async remove(key) {
      for (const k of [].concat(key)) delete bag[k];
    },
  };
}

// 1. L0 默认态（minimal）：RingBuffer(200)、零 console.info、零 storage.session 写入、零 run-recorder 动态落盘、零 .dev-reload-stamp 请求
{
  resetDebugLogForTests();
  const sessionArea = makeSessionArea();
  const downloads = [];
  const fetchedUrls = [];
  const fakeChrome = {
    management: { getSelf: async () => ({ installType: "development" }) },
    runtime: {
      getManifest: () => ({ version: "0.12.1" }),
      getURL: (p) => `chrome-extension://ext-l0/${p}`,
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      session: sessionArea,
    },
    downloads: {
      download: async (opts) => {
        downloads.push(opts);
        return downloads.length;
      },
    },
  };

  configureDebugLog({ enabled: false, traceLevel: "minimal", chromeRef: fakeChrome });

  const origInfo = console.info;
  const infoCalls = [];
  console.info = (...args) => infoCalls.push(args);
  try {
    for (let i = 0; i < DEBUG_LIMIT_L0 + 35; i++) {
      debugLog("agent.step", { idx: i, note: "X".repeat(900) });
    }
    assert.equal(infoCalls.length, 0, "L0 must never spam console.info");
    assert.equal(sessionArea.writes, 0, "L0 must never write storage.session");
    assert.equal(sessionArea.bag[DEBUG_SESSION_STORAGE_KEY], undefined);

    const parsed = JSON.parse(exportDebugLog());
    assert.equal(parsed.entries.length, DEBUG_LIMIT_L0, "L0 caps ring buffer at 200");
    assert.ok(parsed.entries[0].note.length < 560, "L0 truncates per-field string to ~512 chars");
  } finally {
    console.info = origInfo;
  }

  // L0 下侧栏与 SW delegate 结束钩子：不探测 .dev-reload-stamp，不触发下载，不挂全量 conversationMessages
  const l0Run = await onAgentRunCompleted(
    {
      runId: "run_l0_1",
      source: "sidepanel",
      settings: { debug: { enabled: false, traceLevel: "minimal", autoExportRunBundle: false } },
      sessionId: "sess_l0",
      userPrompt: "查看 https://shop.example.com/orders?token=sec123#tab=2 的状态",
      botResponse: "已完成",
      history: [
        { role: "user", content: "查看订单" },
        { role: "assistant", content: "已完成" },
      ],
      steps: [{ type: "tool_exec", toolName: "extract_page", ok: true, durationMs: 12 }],
    },
    {
      chromeRef: fakeChrome,
      fetchImpl: async (url) => {
        fetchedUrls.push(url);
        return { ok: false, status: 404 };
      },
    },
  );

  assert.equal(l0Run.exported, false);
  assert.equal(l0Run.traceLevel, "minimal");
  assert.equal(l0Run.traceLog.version, "2.0-minimal");
  assert.equal(l0Run.traceLog.conversationMessages, undefined, "L0 traceLog omits bloated conversationMessages");
  assert.equal(l0Run.traceLog.systemPrompt, undefined);
  assert.ok(!l0Run.traceLog.userPrompt.includes("token=sec123"), "L0 traceLog strictly strips URL query secrets");
  assert.equal(downloads.length, 0);
  assert.equal(fetchedUrls.length, 0, "L0 must never fetch .dev-reload-stamp");

  const swTaskRes = await recordDelegateTaskFinish(
    {
      task: {
        id: "task_l0_sw",
        status: "done",
        prompt: "后台巡检",
        answer: "ok",
        createdAt: Date.now() - 50,
        finishedAt: Date.now(),
      },
      status: "done",
      settings: { debug: { enabled: false, traceLevel: "minimal", autoExportRunBundle: false } },
    },
    {
      chromeRef: fakeChrome,
      fetchImpl: async (url) => {
        fetchedUrls.push(url);
        return { ok: false, status: 404 };
      },
    },
  );
  assert.equal(swTaskRes.exported, false);
  assert.equal(downloads.length, 0);
  assert.equal(fetchedUrls.length, 0);
  console.log("PASS 1: L0 minimal enforces 200-entry silent buffer, zero session writes, zero stamp fetch, zero downloads");
}

// 2. Workflow 失败自动截图门禁：L0 默认不抓屏且不污染 state.image；开启 debug.captureFailureScreenshot 后恢复自动取证截图
{
  let screenshotCalls = 0;
  const rawTools = [
    {
      name: "click",
      execute: async () => JSON.stringify({ ok: false, error: "element_not_found" }),
    },
    {
      name: "screenshot",
      execute: async () => {
        screenshotCalls += 1;
        return JSON.stringify({
          ok: true,
          dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        });
      },
    },
  ];

  const failingWorkflowText = [
    "/workflow",
    "```json",
    JSON.stringify({
      id: "wf_shot_gate",
      steps: [{ id: "s1", op: "click", params: { selector: "#missing-btn" } }],
    }),
    "```",
  ].join("\n");

  // 2a. 默认关闭调试模式 -> 报错时不调用 screenshot
  const resOff = await runDeterministicWorkflow({
    rawText: failingWorkflowText,
    rawTools,
    settings: { debug: { enabled: false, captureFailureScreenshot: false } },
    resolvePageSnapshot: async () => ({ tabId: 1, url: "https://example.com/item", title: "Item" }),
  });
  assert.equal(resOff.ok, false);
  assert.equal(screenshotCalls, 0, "workflow failure must NOT call screenshot when debug mode is OFF");
  assert.equal(resOff.failure?.hasScreenshot, false);

  // 2b. 解析错误时默认关闭调试模式同样不调用 screenshot
  const parseFailOff = await runDeterministicWorkflow({
    rawText: "/workflow\n```json\n{ broken json }\n```",
    rawTools,
    settings: { debug: { enabled: false, captureFailureScreenshot: false } },
    resolvePageSnapshot: async () => ({ tabId: 1, url: "https://example.com/item", title: "Item" }),
  });
  assert.equal(parseFailOff.ok, false);
  assert.equal(screenshotCalls, 0, "workflow parse failure must NOT call screenshot when debug mode is OFF");

  // 2c. 开启调试模式 + captureFailureScreenshot -> 恢复失败自动抓屏取证
  const fakeShotUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const resOn = await runDeterministicWorkflow({
    rawText: failingWorkflowText,
    rawTools,
    getLastCapturedImage: () => fakeShotUrl,
    settings: { debug: { enabled: true, traceLevel: "full", captureFailureScreenshot: true } },
    resolvePageSnapshot: async () => ({ tabId: 1, url: "https://example.com/item", title: "Item" }),
  });
  assert.equal(resOn.ok, false);
  assert.equal(screenshotCalls, 1, "workflow failure captures screenshot when debug.captureFailureScreenshot is ON");
  assert.equal(resOn.failure?.hasScreenshot, true);
  console.log("PASS 2: workflow failure auto-screenshot strictly gated by settings.debug");
}

// 3. L1 手动诊断态（manual）：RingBuffer(1000)、保留最近 3 轮严格脱敏摘要、零权限 <a download> 导出
{
  resetDebugLogForTests();
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "chrome-extension://ext-l1/sidepanel/index.html",
  });
  const prevDoc = globalThis.document;
  const prevUrl = globalThis.URL;
  const prevBlob = globalThis.Blob;
  let anchorDownloadAttr = "";
  let anchorClicked = false;

  const origCreateElement = dom.window.document.createElement.bind(dom.window.document);
  dom.window.document.createElement = (tag) => {
    const el = origCreateElement(tag);
    if (String(tag).toLowerCase() === "a") {
      el.click = () => {
        anchorDownloadAttr = el.download;
        anchorClicked = true;
      };
    }
    return el;
  };
  globalThis.document = dom.window.document;
  globalThis.Blob = dom.window.Blob;
  globalThis.URL = {
    ...prevUrl,
    createObjectURL: () => "blob:chrome-extension://ext-l1/diag-1",
    revokeObjectURL: () => {},
  };

  try {
    const sessionArea = makeSessionArea();
    const l1Chrome = {
      management: { getSelf: async () => ({ installType: "normal" }) },
      runtime: { getManifest: () => ({ version: "0.12.1" }) },
      storage: { local: { get: async () => ({}) }, session: sessionArea },
      permissions: { contains: async () => false },
    };

    configureDebugLog({ enabled: true, traceLevel: "manual", chromeRef: l1Chrome });
    for (let i = 0; i < DEBUG_LIMIT_L1 + 25; i++) {
      debugLog("agent.l1", { idx: i, email: "buyer@example.com" });
    }
    const l1Snap = JSON.parse(exportDebugLog());
    assert.equal(l1Snap.entries.length, DEBUG_LIMIT_L1, "L1 caps ring buffer at 1000");
    assert.equal(sessionArea.writes, 0, "L1 still does not write storage.session");

    // 连续运行 4 轮 -> 只保留最近 3 轮摘要
    for (let r = 1; r <= 4; r++) {
      await onAgentRunCompleted(
        {
          runId: `run_l1_${r}`,
          source: "sidepanel",
          settings: { debug: { enabled: true, traceLevel: "manual", autoExportRunBundle: false } },
          userPrompt: `第 ${r} 轮联系 13812345678 查看 https://a.example/p?secret=tok_${r}#hash`,
          steps: [{ type: "tool_exec", toolName: "click", ok: false, resultSummary: "Bearer secret_tok_999" }],
        },
        { chromeRef: l1Chrome },
      );
    }

    const exported = exportManualDiagnosticL1({
      extensionVersion: "0.12.1",
      sessionMeta: { sessionId: "sess_1", pageUrl: "https://a.example/item?code=oauth123#frag" },
    });
    assert.equal(exported.ok, true);
    assert.equal(anchorClicked, true);
    assert.match(anchorDownloadAttr, /^pagelens-diagnostic-l1-.*\.json$/);

    const bundle = JSON.parse(exported.jsonText);
    assert.equal(bundle.schema, "pagelens-diagnostic-l1");
    assert.equal(bundle.recentRuns.length, L1_RUN_SUMMARY_LIMIT, "retains only last 3 runs");
    assert.deepEqual(
      bundle.recentRuns.map((x) => x.runId),
      ["run_l1_2", "run_l1_3", "run_l1_4"],
    );
    assert.ok(!exported.jsonText.includes("13812345678"), "PII phone redacted in L1 export");
    assert.ok(!exported.jsonText.includes("buyer@example.com"), "PII email redacted in L1 export");
    assert.ok(!exported.jsonText.includes("oauth123"), "URL query stripped in L1 export");
    assert.ok(!exported.jsonText.includes("secret_tok_999"), "Bearer token redacted in L1 export");
  } finally {
    globalThis.document = prevDoc;
    globalThis.URL = prevUrl;
    globalThis.Blob = prevBlob;
    dom.window.close();
  }
  console.log("PASS 3: L1 manual mode caps 1000 entries + 3 run summaries and exports strict-sanitized JSON with zero permissions");
}

// 4. L2 全量调试态（full）：RingBuffer(4000) + SW 与 Sidepanel 并发写 storage.session 合并无覆盖丢失
{
  resetDebugLogForTests();
  const sharedSession = makeSessionArea({
    [DEBUG_SESSION_STORAGE_KEY]: {
      build: "agent-debug-v2",
      session: "sw-other-context",
      updatedAt: "2026-11-12T08:00:00.000Z",
      entries: [
        {
          time: "2026-11-12T07:59:59.000Z",
          session: "sw-ctx-1",
          event: "sw.background_event",
          cat: "app",
          seq: 1,
          note: "from_service_worker",
        },
      ],
    },
  });
  const l2Chrome = {
    management: { getSelf: async () => ({ installType: "development" }) },
    storage: { session: sharedSession, local: { get: async () => ({}) } },
  };

  configureDebugLog({ enabled: true, traceLevel: "full", chromeRef: l2Chrome });
  await hydrateDebugLog({ chromeRef: l2Chrome });

  const origInfo = console.info;
  console.info = () => {};
  try {
    debugLog("sidepanel.turn_done", { turn: 1 });
    // 模拟在侧栏尚未 flush 前，SW 又往 storage.session 追加了一条新记录
    sharedSession.bag[DEBUG_SESSION_STORAGE_KEY].entries.push({
      time: "2026-11-12T08:00:01.000Z",
      session: "sw-ctx-1",
      event: "sw.concurrent_write",
      cat: "agent",
      seq: 2,
      note: "concurrent_from_sw",
    });

    const freshJson = await exportDebugLogFresh({ chromeRef: l2Chrome });
    const fresh = JSON.parse(freshJson);
    assert.equal(fresh.limit, DEBUG_LIMIT);
    const events = fresh.entries.map((e) => e.event);
    assert.ok(events.includes("sw.background_event"), "hydrated existing SW entry");
    assert.ok(events.includes("sw.concurrent_write"), "merge-before-write preserved concurrent SW entry");
    assert.ok(events.includes("sidepanel.turn_done"), "preserved local Sidepanel entry");
  } finally {
    console.info = origInfo;
    resetDebugLogForTests();
  }
  console.log("PASS 4: L2 full mode merges SW + Sidepanel concurrent storage.session entries without overwrite loss");
}

console.log("ALL PASS test_debug_trace_levels.mjs");

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createKernelAgentLoop } from "../lib/agent/loop-kernel.js";
import {
  TASK_STATUS,
  createDelegateManager,
  memoryTaskStorage,
} from "../lib/agent/delegate.js";
import { recordDelegateTaskFinish } from "../lib/agent/delegate-sw.js";
import { createApprovalQueue, memoryAdapter } from "../lib/agent/trust/approval-queue.js";
import { formatTracePayload } from "../lib/langfuse.js";
import {
  AUTO_EXPORT_RUN_BUNDLE_DEFAULT,
  IMAGE_DETACH_THRESHOLD,
  RUN_OUTPUT_DIR,
  TRACE_SCHEMA_VERSION,
  buildRunRecord,
  classifyToolOutcome,
  encodeUtf8DataUrl,
  isAutoExportRunBundleEnabled,
  persistRunBundle,
  sanitizeTraceValue,
  unwrapUntrustedOutput,
} from "../lib/run-recorder.js";
import { withUntrustedOutput } from "../lib/untrusted.js";

function decodeDataUrlJson(dataUrl) {
  assert.match(dataUrl, /^data:application\/json;charset=utf-8;base64,/);
  const b64 = dataUrl.slice("data:application/json;charset=utf-8;base64,".length);
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function makeFakeChrome({ stampJson = null, throwOnDownload = false, tabsMap = new Map() } = {}) {
  const downloads = [];
  const sessionStore = {};
  const localStore = {};
  const makeArea = (store) => ({
    async get(keys) {
      if (keys == null) return { ...store };
      if (typeof keys === "string") return keys in store ? { [keys]: store[keys] } : {};
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (k in store) out[k] = store[k];
        return out;
      }
      const out = { ...keys };
      for (const k of Object.keys(keys)) if (k in store) out[k] = store[k];
      return out;
    },
    async set(obj) {
      Object.assign(store, obj);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
    },
  });

  const chromeRef = {
    runtime: {
      id: "ext-unit-test",
      getManifest: () => ({ version: "0.12.1" }),
      getURL: (p) => `chrome-extension://ext-unit-test/${String(p).replace(/^\//, "")}`,
      sendMessage: async () => ({ ok: true }),
      onMessage: { addListener: () => {} },
      getPlatformInfo: async () => ({ os: "mac" }),
    },
    storage: {
      session: makeArea(sessionStore),
      local: makeArea(localStore),
    },
    downloads: {
      async download(opts) {
        if (throwOnDownload) throw new Error("Download interrupted by policy");
        downloads.push(opts);
        return downloads.length;
      },
    },
    tabs: {
      async get(tabId) {
        if (tabsMap.has(tabId)) return tabsMap.get(tabId);
        return { id: tabId, windowId: 1, url: "https://agentseller.temu.com/mmsos/goods.html#/list", title: "商品列表" };
      },
      async query() {
        return [...tabsMap.values()];
      },
    },
    windows: {
      async getCurrent() {
        return { id: 1 };
      },
    },
  };

  const fetchImpl = async (url) => {
    if (String(url).endsWith(".dev-reload-stamp")) {
      if (!stampJson) return { ok: false, status: 404, text: async () => "" };
      const raw = typeof stampJson === "string" ? stampJson : JSON.stringify(stampJson);
      return { ok: true, status: 200, text: async () => raw };
    }
    if (String(url).endsWith("local-settings.json")) {
      return { ok: false, status: 404, text: async () => "" };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  return { chromeRef, fetchImpl, downloads, sessionStore, localStore };
}

assert.equal(AUTO_EXPORT_RUN_BUNDLE_DEFAULT, false, "autoExportRunBundle must default to false");

// ── 0. 默认不自动导出到下载目录（仍构建内存 traceRecord 供手动导出） ──
{
  const { chromeRef, fetchImpl, downloads } = makeFakeChrome({
    stampJson: { timestamp: "2026-11-11T14:25:00Z", gitCommit: "000111a" },
  });
  assert.equal(await isAutoExportRunBundleEnabled({ chromeRef, fetchImpl }), false);
  const res = await persistRunBundle(
    {
      runId: "run_default_silent",
      source: "sidepanel",
      userPrompt: "总结当前页",
      botResponse: "已完成总结。",
    },
    { chromeRef, fetchImpl },
  );
  assert.equal(res.ok, true);
  assert.equal(res.exported, false);
  assert.equal(downloads.length, 0, "no chrome.downloads call when autoExportRunBundle is false");
  assert.equal(res.traceRecord.runId, "run_default_silent");
  assert.equal(res.traceRecord.gitCommit, "000111a");
  console.log("PASS 0. persistRunBundle disabled by default while keeping in-memory traceRecord");
}

// ── 1. Schema v2.0 字段完整性、版本哈希联动与 Langfuse 向后兼容 ──
{
  const { chromeRef, fetchImpl, downloads } = makeFakeChrome({
    stampJson: {
      timestamp: "2026-11-11T14:30:00Z",
      gitCommit: "abc1234",
      gitBranch: "feat/temu-e2e-loop",
    },
  });

  const persisted = await persistRunBundle(
    {
      runId: "run_schema_check",
      source: "sidepanel",
      sessionId: "sess_001",
      startedAt: "2026-11-11T14:31:00.000Z",
      endedAt: "2026-11-11T14:31:03.250Z",
      status: "done",
      endReason: "stop",
      model: "gpt-test-model",
      metrics: {
        durationMs: 3250,
        inputTokens: 120,
        outputTokens: 45,
        totalTokens: 165,
        finishReason: "stop",
      },
      initialPage: { tabId: 42, url: "https://agentseller.temu.com/mmsos/goods.html#/home", title: "卖家首页" },
      finalPage: { tabId: 42, url: "https://agentseller.temu.com/mmsos/goods.html#/edit?id=9", title: "编辑商品" },
      userPrompt: "请打开编辑页",
      thinking: "先定位按钮再点击",
      botResponse: "已进入编辑商品页。",
      steps: [
        {
          type: "model_turn",
          turn: 1,
          timestamp: 1794407461000,
          messages: [
            { role: "system", content: "你是助手" },
            { role: "user", content: "请打开编辑页" },
          ],
          tools: [{ name: "click" }],
          response: { content: "", finishReason: "tool_calls", toolCalls: [{ id: "tc1", name: "click", arguments: "{\"selector\":\"#edit\"}" }] },
        },
        {
          type: "tool_exec",
          turn: 1,
          name: "click",
          args: { selector: "#edit", apiKey: "FAKE_TEST_KEY_DO_NOT_USE" },
          result: "{\"ok\":true,\"clicked\":\"#edit\"}",
          ok: true,
          jsOk: true,
          durationMs: 85,
          tabId: 42,
          pageUrl: "https://agentseller.temu.com/mmsos/goods.html#/edit?id=9",
          pageTitle: "编辑商品",
          timestamp: 1794407461100,
        },
      ],
      history: [
        { role: "user", content: "请打开编辑页" },
        { role: "assistant", content: "已进入编辑商品页。" },
      ],
      systemPrompt: "你是助手",
    },
    {
      chromeRef,
      fetchImpl,
      autoExport: true,
      exportDebugFn: async () =>
        JSON.stringify({
          entries: [{ event: "sw.startup", authorization: "Bearer fake_unit_test_jwt_000" }],
        }),
    },
  );

  assert.equal(persisted.ok, true);
  assert.equal(downloads.length, 2, "trace + debug files downloaded");
  assert.ok(downloads[0].filename.startsWith(`${RUN_OUTPUT_DIR}/pagelens-trace-`));
  assert.ok(downloads[0].filename.endsWith("-sidepanel-run_schema_check.json"));
  assert.equal(downloads[0].saveAs, false);
  assert.ok(downloads[1].filename.startsWith(`${RUN_OUTPUT_DIR}/pagelens-debug-`));
  assert.ok(downloads[1].filename.endsWith("-sidepanel-run_schema_check.json"));

  const traceJson = decodeDataUrlJson(downloads[0].url);
  assert.equal(traceJson.version, TRACE_SCHEMA_VERSION);
  assert.equal(traceJson.runId, "run_schema_check");
  assert.equal(traceJson.source, "sidepanel");
  assert.equal(traceJson.taskId, null);
  assert.equal(traceJson.extensionVersion, "0.12.1");
  assert.equal(traceJson.gitCommit, "abc1234");
  assert.equal(traceJson.startedAt, "2026-11-11T14:31:00.000Z");
  assert.equal(traceJson.endedAt, "2026-11-11T14:31:03.250Z");
  assert.equal(traceJson.status, "done");
  assert.equal(traceJson.endReason, "stop");
  assert.equal(traceJson.initialPage.url, "https://agentseller.temu.com/mmsos/goods.html#/home");
  assert.equal(traceJson.finalPage.url, "https://agentseller.temu.com/mmsos/goods.html#/edit?id=9");
  assert.equal(traceJson.botResponse, "已进入编辑商品页。");
  assert.equal(traceJson.content, "已进入编辑商品页。");
  assert.ok(Array.isArray(traceJson.sidepanelErrors));
  assert.ok(Array.isArray(traceJson.artifacts));
  assert.equal(traceJson.toolSteps.length, 1);
  const ts0 = traceJson.toolSteps[0];
  assert.equal(ts0.stepIndex, 1);
  assert.equal(ts0.turn, 1);
  assert.equal(ts0.toolName, "click");
  assert.equal(ts0.args.selector, "#edit");
  assert.equal(ts0.args.apiKey, "[REDACTED]");
  assert.equal(ts0.ok, true);
  assert.equal(ts0.jsOk, true);
  assert.equal(ts0.failureReason, null);
  assert.equal(ts0.durationMs, 85);
  assert.equal(ts0.tabId, 42);
  assert.equal(ts0.pageUrl, "https://agentseller.temu.com/mmsos/goods.html#/edit?id=9");
  assert.equal(ts0.pageTitle, "编辑商品");
  assert.equal(ts0.archiveHandle, null);

  const debugJson = decodeDataUrlJson(downloads[1].url);
  assert.equal(debugJson.runId, "run_schema_check");
  assert.equal(debugJson.gitCommit, "abc1234");
  assert.equal(debugJson.entries[0].authorization, "[REDACTED]");

  const lf = formatTracePayload(traceJson);
  assert.ok(Array.isArray(lf.batch) && lf.batch.length > 0, "Langfuse compatible with v2.0 traceRecord");
  console.log("PASS 1. schema v2.0, build info linkage, and Langfuse compatibility");
}

// ── 2. 工具业务成败精准判定（classifyToolOutcome）与归档前原始输出保留 ──
{
  const cJsonErr = classifyToolOutcome("click", JSON.stringify({ ok: false, error: "Element #save is disabled" }), true);
  assert.equal(cJsonErr.ok, false);
  assert.equal(cJsonErr.jsOk, true);
  assert.match(cJsonErr.failureReason, /disabled/);

  const cNotFound = classifyToolOutcome("query_dom", "<untrusted_page source=\"query_dom\">\n{\"notFound\":true,\"selector\":\".sku-row\"}\n</untrusted_page>", true);
  assert.equal(cNotFound.ok, false);
  assert.equal(cNotFound.jsOk, true);
  assert.equal(cNotFound.failureReason, "not_found");

  const cTimedOut = classifyToolOutcome("wait_for", "{\"timedOut\":true,\"waitedMs\":5000}", true);
  assert.equal(cTimedOut.ok, false);
  assert.equal(cTimedOut.jsOk, true);
  assert.equal(cTimedOut.failureReason, "timed_out");

  const cBlocked = classifyToolOutcome("run_js", "{\"blocked\":true,\"reason\":\"csp_restricted\"}", true);
  assert.equal(cBlocked.ok, false);
  assert.equal(cBlocked.jsOk, true);
  assert.equal(cBlocked.failureReason, "csp_restricted");

  for (const textFail of [
    "截图失败：当前窗口未激活",
    "当前页面受系统安全策略保护，无法注入脚本",
    "已拦截潜在危险命令",
    "没有匹配「确认提交」的可见控件",
    "CONFIRMATION_REQUIRED: 需要人工确认",
  ]) {
    const r = classifyToolOutcome("act_element", textFail, true);
    assert.equal(r.ok, false, `must classify as business failure: ${textFail}`);
    assert.equal(r.jsOk, true);
    assert.ok(r.failureReason && r.failureReason.length > 0);
  }

  const cThrown = classifyToolOutcome("run_js", "TypeError: Cannot read properties of null", false);
  assert.equal(cThrown.ok, false);
  assert.equal(cThrown.jsOk, false);
  assert.match(cThrown.failureReason, /TypeError/);

  assert.equal(unwrapUntrustedOutput("<untrusted_page source=\"extract_page\">\nhello\n</untrusted_page>"), "hello");

  // 验证 tool-guardian 归档时：classifyToolOutcome 在归档前执行，且 traceSteps 保留 archivedContent（<=24000），模型上下文不膨胀
  const hugeFailurePayload = JSON.stringify({
    ok: false,
    error: "batch_upload_failed_on_item_3",
    dump: "X".repeat(30_000),
  });
  let secondTurnToolMessage = "";
  let turnIdx = 0;
  const traceSteps = [];
  const wrappedTools = withUntrustedOutput([
    {
      name: "extract_page",
      description: "extract",
      parameters: { type: "object", properties: {} },
      async execute() {
        return hugeFailurePayload;
      },
    },
  ]);
  const kernel = createKernelAgentLoop({
    maxTurns: 4,
    allTools: wrappedTools,
    tools: wrappedTools,
    systemPrompt: "guardian test",
    getToolPageContext: async () => ({
      tabId: 99,
      url: "https://agentseller.temu.com/mmsos/goods.html#/ai-tools-kj-cross?view=tools",
      title: "AI 跨境工具箱",
    }),
    model: {
      async runTurn({ messages }) {
        turnIdx += 1;
        if (turnIdx === 1) {
          return {
            content: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: "tc_big", name: "extract_page", arguments: "{}" }],
          };
        }
        const toolMsg = messages.find((m) => m.role === "tool");
        secondTurnToolMessage = String(toolMsg?.content || "");
        return { content: "已知晓失败原因", finishReason: "stop", toolCalls: [] };
      },
    },
  });
  await kernel.run("检查页面上传结果", { sessionId: "sess_guardian", traceSteps });
  const execStep = traceSteps.find((s) => s.type === "tool_exec");
  assert.ok(execStep, "tool_exec recorded");
  assert.equal(execStep.ok, false, "business failure detected BEFORE tool-guardian archiving");
  assert.equal(execStep.jsOk, true);
  assert.equal(execStep.failureReason, "batch_upload_failed_on_item_3");
  assert.ok(execStep.archiveHandle, "archiveHandle recorded when tool-guardian archives large output");
  assert.ok(execStep.originalLength > 30_000);
  assert.equal(execStep.archivedContent.length, 24_000, "archivedContent capped at 24000 chars");
  assert.ok(secondTurnToolMessage.length < 4_000, "model context receives compact summary, NOT archivedContent");
  assert.equal(execStep.tabId, 99);
  assert.equal(execStep.pageUrl, "https://agentseller.temu.com/mmsos/goods.html#/ai-tools-kj-cross?view=tools");

  const built = buildRunRecord({ runId: "run_guardian", steps: traceSteps });
  assert.equal(built.traceRecord.toolSteps[0].ok, false);
  assert.equal(built.traceRecord.toolSteps[0].failureReason, "batch_upload_failed_on_item_3");
  assert.equal(built.traceRecord.toolSteps[0].archiveHandle, execStep.archiveHandle);
  console.log("PASS 2. classifyToolOutcome + pre-archive business failure detection + archivedContent");
}

// ── 3. 敏感参数脱敏与非敏感完整 URL（含 query 与 #hash）保留 ──
{
  const temuHashUrl =
    "https://agentseller.temu.com/mmsos/goods.html?mallId=8899&pageSize=50#/ai-tools-kj-cross?view=tools&menu=collectionBox";
  const urlWithSensitiveQuery =
    "https://example.com/callback?mallId=8899&access_token=tok_fake_query_000&signature=sig_fake_000#/dashboard?tab=1";

  const sanitized = sanitizeTraceValue({
    apiKey: "FAKE_API_KEY_000",
    nested: {
      password: "FAKE_PASSWORD_000",
      client_secret: "FAKE_SECRET_000",
      cookie: "sid=fake_cookie_000",
      settingItem: { key: "openai.api_key", value: "FAKE_SETTING_KEY_000", label: "OpenAI" },
    },
    headers: {
      Authorization: "Bearer fake_unit_test_jwt_000",
    },
    inlineNote: "Using key sk-fakeTestOnly0000000000 and https://admin:fake_pass_000@internal.example/v1",
    pageUrl: temuHashUrl,
    callbackUrl: urlWithSensitiveQuery,
  });

  assert.equal(sanitized.apiKey, "[REDACTED]");
  assert.equal(sanitized.nested.password, "[REDACTED]");
  assert.equal(sanitized.nested.client_secret, "[REDACTED]");
  assert.equal(sanitized.nested.cookie, "[REDACTED]");
  assert.equal(sanitized.nested.settingItem.value, "[REDACTED]");
  assert.equal(sanitized.nested.settingItem.label, "OpenAI");
  assert.equal(sanitized.headers.Authorization, "[REDACTED]");
  assert.ok(!sanitized.inlineNote.includes("sk-fakeTestOnly0000000000"));
  assert.ok(!sanitized.inlineNote.includes("fake_pass_000"));
  assert.equal(
    sanitized.pageUrl,
    temuHashUrl,
    "non-sensitive URL with normal query params and #hash route must be 100% preserved",
  );
  assert.equal(
    sanitized.callbackUrl,
    "https://example.com/callback?mallId=8899&access_token=[REDACTED]&signature=[REDACTED]#/dashboard?tab=1",
  );
  console.log("PASS 3. sensitive redaction + 100% preservation of non-sensitive URLs & #hash routes");
}

// ── 4. 大体积 Base64 截图去重拆离 + model_turn 增量 messagesDelta ──
{
  const bigPng = `data:image/png;base64,${"A".repeat(IMAGE_DETACH_THRESHOLD + 512)}`;
  const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const { chromeRef, fetchImpl, downloads } = makeFakeChrome();

  const msgSys = { role: "system", content: "sys" };
  const msgU1 = { role: "user", content: "看图分析" };
  const msgA1 = { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "screenshot", arguments: "{}" } }] };
  const msgT1 = { role: "tool", tool_call_id: "c1", content: `截图结果：${bigPng}` };
  const msgA2 = { role: "assistant", content: "分析完成" };

  const persisted = await persistRunBundle(
    {
      runId: "run_shot_delta",
      source: "sidepanel",
      userPrompt: `小图标 ${tinyPng}`,
      steps: [
        {
          type: "model_turn",
          turn: 1,
          timestamp: 1794408000000,
          messages: [msgSys, msgU1],
          tools: [{ name: "screenshot", description: "big schema" }],
          response: { content: "", finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "screenshot", arguments: "{}" }] },
        },
        {
          type: "tool_exec",
          turn: 1,
          name: "screenshot",
          args: {},
          result: bigPng,
          ok: true,
          jsOk: true,
          durationMs: 120,
          timestamp: 1794408000200,
        },
        {
          type: "model_turn",
          turn: 2,
          timestamp: 1794408000500,
          messages: [msgSys, msgU1, msgA1, msgT1],
          tools: [{ name: "screenshot", description: "big schema" }],
          response: { content: "分析完成", finishReason: "stop", toolCalls: [] },
        },
      ],
      history: [msgU1, msgA1, msgT1, msgA2],
      systemPrompt: "sys",
      botResponse: "分析完成",
    },
    { chromeRef, fetchImpl, autoExport: true, exportDebugFn: async () => ({ entries: [] }) },
  );

  assert.equal(persisted.ok, true);
  assert.equal(downloads.length, 3, "1 deduplicated screenshot + 1 trace + 1 debug");
  assert.match(downloads[0].filename, /^pagelens-runs\/pagelens-shot-.*-sidepanel-run_shot_delta-01\.png$/);
  assert.equal(downloads[0].url, bigPng);

  const traceRecord = decodeDataUrlJson(downloads[1].url);
  assert.equal(traceRecord.artifacts.length, 1, "identical bigPng across tool_exec, model_turn, and conversationMessages deduplicated to 1 artifact");
  assert.equal(traceRecord.artifacts[0].filename, downloads[0].filename);
  assert.ok(traceRecord.userPrompt.includes(tinyPng), "<4KB image kept inline");

  const rawTraceStr = JSON.stringify(traceRecord);
  assert.ok(!rawTraceStr.includes("A".repeat(500)), "huge base64 body completely removed from trace JSON");
  assert.ok(rawTraceStr.includes(`[artifact:${downloads[0].filename}]`));

  const mt1 = traceRecord.steps.find((s) => s.type === "model_turn" && s.turn === 1);
  const mt2 = traceRecord.steps.find((s) => s.type === "model_turn" && s.turn === 2);
  assert.equal(mt1.messages, undefined, "full messages array dropped from model_turn");
  assert.equal(mt1.tools, undefined, "full tool schemas dropped from model_turn");
  assert.deepEqual(mt1.toolNames, ["screenshot"]);
  assert.equal(mt1.messageCount, 2);
  assert.equal(mt1.messagesDelta.length, 2);
  assert.equal(mt2.messageCount, 4);
  assert.equal(mt2.messagesDelta.length, 2, "turn 2 only stores the 2 newly appended messages");
  assert.equal(traceRecord.conversationMessages.length, 5, "full conversation stored once at top level");
  console.log("PASS 4. >=4KB screenshot detachment/dedup + O(N) incremental messagesDelta");
}

// ── 5. SW 委托路径全终态落盘（DONE / FAILED / CANCELLED / NEEDS_APPROVAL）+ 零 console.warn/error 容错 ──
{
  // 5a. 容错分支零 console.warn / console.error 校验（无 DOM 的纯 SW 环境且 downloads 抛错）
  const failingEnv = makeFakeChrome({ throwOnDownload: true });
  const origWarn = console.warn;
  const origError = console.error;
  let warnCalls = 0;
  let errorCalls = 0;
  console.warn = () => { warnCalls += 1; };
  console.error = () => { errorCalls += 1; };
  try {
    const degraded = await persistRunBundle(
      { runId: "run_degraded", source: "sw-delegate", botResponse: "ok" },
      { chromeRef: failingEnv.chromeRef, fetchImpl: failingEnv.fetchImpl, autoExport: true, exportDebugFn: async () => ({ entries: [] }) },
    );
    assert.equal(degraded.ok, true);
    assert.equal(degraded.files.every((f) => f.ok === false && f.via === "none"), true);
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }
  assert.equal(warnCalls, 0, "persistRunBundle fault-tolerant path must NOT call console.warn");
  assert.equal(errorCalls, 0, "persistRunBundle fault-tolerant path must NOT call console.error");

  // 5b. SW Delegate 四种终态全覆盖落盘
  const swEnv = makeFakeChrome({
    stampJson: { timestamp: "2026-11-11T15:00:00Z", gitCommit: "def5678" },
    tabsMap: new Map([
      [7, { id: 7, windowId: 1, url: "https://agentseller.temu.com/mmsos/goods.html#/list", title: "Temu 列表" }],
    ]),
  });

  function createRecordedDelegate({ model, approvals = createApprovalQueue({ storage: memoryAdapter() }) }) {
    const tools = [
      {
        name: "extract_page",
        description: "extract",
        parameters: { type: "object", properties: {} },
        async execute() {
          return "商品标题：测试保温杯";
        },
      },
      {
        name: "cose_publish",
        description: "publish",
        parameters: { type: "object", properties: {} },
        async execute() {
          return "published";
        },
      },
    ];
    return createDelegateManager({
      storage: memoryTaskStorage(),
      approvals,
      loadSettings: async () => ({
        hitlMode: "balanced",
        diagnostics: { autoExportRunBundle: true },
      }),
      createRun: async ({ task }) => ({
        tools,
        systemPrompt: "sw delegate sys",
        modelName: "sw-model-v1",
        initialPage: { tabId: task.tabId, url: task.sourceUrl, title: "Temu 列表" },
        getToolPageContext: async () => ({
          tabId: 7,
          url: "https://agentseller.temu.com/mmsos/goods.html#/list",
          title: "Temu 列表",
        }),
        getFinalPage: async () => ({
          tabId: 7,
          url: "https://agentseller.temu.com/mmsos/goods.html#/detail?id=1",
          title: "Temu 详情",
        }),
        getTabUrl: async () => "https://agentseller.temu.com/mmsos/goods.html#/list",
        model,
      }),
      onTaskFinished: (payload) =>
        recordDelegateTaskFinish(payload, {
          chromeRef: swEnv.chromeRef,
          fetchImpl: swEnv.fetchImpl,
          exportDebugFn: async () => ({ entries: [{ event: "delegate.done" }] }),
        }),
    });
  }

  // (i) DONE
  {
    let turn = 0;
    const mgr = createRecordedDelegate({
      model: {
        async runTurn() {
          turn += 1;
          if (turn === 1) {
            return {
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "d1", name: "extract_page", arguments: "{}" }],
              usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
            };
          }
          return { content: "委托完成", finishReason: "stop", toolCalls: [] };
        },
      },
    });
    const started = await mgr.start({
      prompt: "读取商品标题",
      tabId: 7,
      sourceUrl: "https://agentseller.temu.com/mmsos/goods.html#/list",
    });
    const done = await mgr.wait(started.id);
    assert.equal(done.status, TASK_STATUS.DONE);
  }

  // (ii) FAILED (mid-run throw AFTER step 1 succeeded — must preserve completed toolSteps!)
  {
    let turn = 0;
    const mgr = createRecordedDelegate({
      model: {
        async runTurn() {
          turn += 1;
          if (turn === 1) {
            return {
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "f1", name: "extract_page", arguments: "{}" }],
            };
          }
          throw new Error("Upstream 502 Bad Gateway");
        },
      },
    });
    const started = await mgr.start({
      prompt: "中途报错任务",
      tabId: 7,
      sourceUrl: "https://agentseller.temu.com/mmsos/goods.html#/list",
    });
    const failed = await mgr.wait(started.id);
    assert.equal(failed.status, TASK_STATUS.FAILED);
  }

  // (iii) CANCELLED (aborted AFTER step 1 succeeded — must preserve completed toolSteps!)
  {
    let turn = 0;
    let notifyTurn2;
    const turn2Entered = new Promise((r) => { notifyTurn2 = r; });
    const mgr = createRecordedDelegate({
      model: {
        async runTurn({ signal }) {
          turn += 1;
          if (turn === 1) {
            return {
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "c1", name: "extract_page", arguments: "{}" }],
            };
          }
          notifyTurn2();
          return new Promise((_, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              { once: true },
            );
          });
        },
      },
    });
    const started = await mgr.start({
      prompt: "中途取消任务",
      tabId: 7,
      sourceUrl: "https://agentseller.temu.com/mmsos/goods.html#/list",
    });
    await turn2Entered;
    const cancelled = await mgr.cancel(started.id);
    assert.equal(cancelled.status, TASK_STATUS.CANCELLED);
  }

  // (iv) NEEDS_APPROVAL
  {
    let turn = 0;
    const mgr = createRecordedDelegate({
      model: {
        async runTurn() {
          turn += 1;
          if (turn === 1) {
            return {
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "p1", name: "cose_publish", arguments: "{\"platforms\":[\"zhihu\"]}" }],
            };
          }
          return { content: "等待人工批准发布", finishReason: "stop", toolCalls: [] };
        },
      },
    });
    const started = await mgr.start({
      prompt: "发布到知乎",
      capsule: { actions: ["publish"], platforms: ["zhihu"] },
      tabId: 7,
      sourceUrl: "https://agentseller.temu.com/mmsos/goods.html#/list",
    });
    const pending = await mgr.wait(started.id);
    assert.equal(pending.status, TASK_STATUS.NEEDS_APPROVAL);
  }

  assert.equal(swEnv.downloads.length, 8, "4 delegate runs * (1 trace + 1 debug) = 8 files");
  const swTraces = swEnv.downloads
    .filter((d) => d.filename.includes("pagelens-trace-"))
    .map((d) => decodeDataUrlJson(d.url));
  assert.deepEqual(
    swTraces.map((t) => t.status),
    ["done", "failed", "cancelled", "needs_approval"],
  );
  for (const t of swTraces) {
    assert.equal(t.source, "sw-delegate");
    assert.ok(t.taskId && t.taskId.startsWith("task_"));
    assert.equal(t.gitCommit, "def5678");
    assert.equal(t.toolSteps.length, 1, `completed/intercepted step preserved for status=${t.status}`);
    assert.equal(t.toolSteps[0].tabId, 7);
    assert.equal(t.toolSteps[0].pageUrl, "https://agentseller.temu.com/mmsos/goods.html#/list");
    assert.equal(t.toolSteps[0].pageTitle, "Temu 列表");
  }
  assert.equal(swTraces[1].endReason, "error");
  assert.match(swTraces[1].error.message, /502 Bad Gateway/);
  assert.equal(swTraces[2].endReason, "abort");
  assert.equal(swTraces[3].endReason, "needs_approval");
  assert.equal(swTraces[3].toolSteps[0].ok, false);
  assert.match(swTraces[3].toolSteps[0].failureReason, /CONFIRMATION_REQUIRED/);
  console.log("PASS 5. SW delegate all 4 terminal states + zero console.warn/error fault tolerance");
}

// ── 6. 侧栏 executeLoop 真实链路（中途异常保留已完成步骤 + pushError 同步 + 用户取消落盘）──
{
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='msgs'></div><button id='send'></button><div id='save-status'></div></body></html>",
    { url: "chrome-extension://ext-unit-test/sidepanel/index.html" },
  );
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;

  const spEnv = makeFakeChrome({
    stampJson: { timestamp: "2026-11-11T15:10:00Z", gitCommit: "9876fed" },
    tabsMap: new Map([
      [11, { id: 11, windowId: 1, url: "https://agentseller.temu.com/mmsos/goods.html#/box", title: "采集箱" }],
    ]),
  });
  globalThis.chrome = spEnv.chromeRef;

  function makeSseResponse(chunks) {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  const { state } = await import("../sidepanel/state.js");
  const { pushError } = await import("../sidepanel/messages.js");
  const { executeLoop } = await import("../sidepanel/agent-loop.js");

  state.sessionId = "sess_sidepanel_test";
  state.settings = {
    ...state.settings,
    diagnostics: { autoExportRunBundle: true },
  };
  state.tab = { id: 11, windowId: 1, url: "https://agentseller.temu.com/mmsos/goods.html#/box", title: "采集箱" };
  state.pack = { url: state.tab.url, title: state.tab.title, hasVideo: false };

  // 6a. 第 1 轮执行 list_tabs 工具成功，运行期间触发 pushError，第 2 轮模型请求抛异常 -> 验证 steps 不丢失且 sidepanelErrors 落盘
  let llmCallCount = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith(".dev-reload-stamp")) return spEnv.fetchImpl(url);
    llmCallCount += 1;
    if (llmCallCount === 1) {
      return makeSseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_sp_1", type: "function", function: { name: "list_tabs", arguments: "{}" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 55, completion_tokens: 12, total_tokens: 67 },
        },
      ]);
    }
    pushError("侧栏提示：上游网关临时超时");
    return new Response("gateway error", { status: 503 });
  };

  const botMsgFail = { role: "bot", text: "…", trace: [], thinking: "" };
  state.messages = [{ role: "user", text: "列出当前标签页" }, botMsgFail];
  await executeLoop({
    userText: "列出当前标签页",
    history: [],
    resume: false,
    botMsg: botMsgFail,
    model: { baseUrl: "https://llm.example/v1", apiKey: "FAKE_SP_KEY_000", model: "sp-test-model" },
  });

  assert.equal(botMsgFail.error, true);
  assert.ok(botMsgFail.traceLog, "botMsg.traceLog populated on mid-run failure");
  assert.equal(botMsgFail.traceLog.version, "2.0");
  assert.equal(botMsgFail.traceLog.status, "failed");
  assert.equal(botMsgFail.traceLog.endReason, "error");
  assert.equal(botMsgFail.traceLog.gitCommit, "9876fed");
  assert.equal(botMsgFail.traceLog.toolSteps.length, 1, "completed list_tabs step preserved on mid-run error (not steps: [])");
  assert.equal(botMsgFail.traceLog.toolSteps[0].toolName, "list_tabs");
  assert.equal(botMsgFail.traceLog.toolSteps[0].tabId, 11);
  assert.equal(botMsgFail.traceLog.toolSteps[0].pageUrl, "https://agentseller.temu.com/mmsos/goods.html#/box");
  assert.equal(botMsgFail.traceLog.toolSteps[0].pageTitle, "采集箱");
  assert.equal(botMsgFail.traceLog.sidepanelErrors.length, 1);
  assert.match(botMsgFail.traceLog.sidepanelErrors[0].message, /上游网关临时超时/);
  assert.ok(botMsgFail.traceLog.steps.some((s) => s.type === "ui_error"));
  assert.equal(botMsgFail.traceLog.metrics.inputTokens, 55, "partial token metrics preserved on mid-run error");
  assert.equal(spEnv.sessionStore["pl.agent.busy"]?.busy, false, "pl.agent.busy cleared after failure");

  // 6b. 用户主动取消（第 1 轮工具完成后在第 2 轮 abort）-> status=cancelled, 已完成步骤保留且成对落盘
  let cancelTurn = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith(".dev-reload-stamp")) return spEnv.fetchImpl(url);
    cancelTurn += 1;
    if (cancelTurn === 1) {
      return makeSseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_sp_2", type: "function", function: { name: "list_tabs", arguments: "{}" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]);
    }
    state.stopIntent = "user";
    state.abort?.abort();
    return new Promise((_, reject) => {
      if (init?.signal?.aborted) {
        reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
        return;
      }
      init?.signal?.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })),
        { once: true },
      );
    });
  };

  const botMsgCancel = { role: "bot", text: "…", trace: [], thinking: "" };
  state.messages = [{ role: "user", text: "取消测试" }, botMsgCancel];
  await executeLoop({
    userText: "取消测试",
    history: [],
    resume: false,
    botMsg: botMsgCancel,
    model: { baseUrl: "https://llm.example/v1", apiKey: "FAKE_SP_KEY_000", model: "sp-test-model" },
  });

  assert.equal(botMsgCancel.traceLog.status, "cancelled");
  assert.equal(botMsgCancel.traceLog.endReason, "abort");
  assert.equal(botMsgCancel.traceLog.toolSteps.length, 1, "completed tool step preserved on user cancel");
  assert.equal(spEnv.downloads.length, 4, "2 sidepanel runs * (1 trace + 1 debug) = 4 files");
  assert.equal(spEnv.sessionStore["pl.agent.busy"]?.busy, false, "pl.agent.busy cleared after cancel");
  console.log("PASS 6. sidepanel executeLoop mid-run error + pushError + user cancel auto-persistence");
}

console.log("ALL PASS test_run_recorder.mjs");

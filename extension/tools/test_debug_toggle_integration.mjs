/**
 * 调试模式开/关全链路集成测试（纯 Node + JSDOM，不启动任何浏览器进程）。
 *
 * 覆盖：
 * 1. 默认关闭态（L0）：
 *    - 侧栏「调试模式」总开关默认未勾选，顶部导出按钮与 Langfuse 面板均隐藏，状态徽章显示「未启用」；
 *    - SW 端无 pagelens-dev-reload 闹钟、无 pl.debug.log 会话持久化、无启动回执；
 *    - 运行完整 Agent Loop 与失败的工作流后：零 downloads.download 调用、零失败自动截图、消息气泡零「Trace」按钮；
 *    - L1 免权限手动诊断包仍可通过 <a download> 正常导出并严格脱敏。
 * 2. 开启调试模式（L2 + development 安装态）：
 *    - 用户手势内按需申请 downloads 权限；
 *    - UI 同步显示顶部导出按钮、展开 Langfuse 配置区、徽章变为「已开启」；
 *    - SW 挂载 pagelens-dev-reload 闹钟，检测 stamp 变更后触发 reload 并写入启动回执；
 *    - 运行 Agent Loop 与失败工作流后：自动落盘 pagelens-trace-* / pagelens-debug-*，失败步骤自动捕获截图，消息气泡出现「Trace」按钮。
 * 3. 关闭调试模式（回收态）：
 *    - 自动回收 downloads 可选权限（保留用户服务商已用 origin）；
 *    - 立即清除 pagelens-dev-reload 闹钟并清空 storage.session["pl.debug.log"]；
 *    - 侧栏 UI 隐藏顶部导出按钮、Langfuse 面板与消息气泡「Trace」按钮。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(resolve(__dirname, "../sidepanel/index.html"), "utf8");
const stylesCss = readFileSync(resolve(__dirname, "../sidepanel/styles.css"), "utf8");
const themesCss = readFileSync(resolve(__dirname, "../sidepanel/themes.css"), "utf8");

const dom = new JSDOM(indexHtml, {
  url: "https://ext-debug-int.local/sidepanel/index.html",
});
const styleEl = dom.window.document.createElement("style");
styleEl.textContent = `${stylesCss}\n${themesCss}`;
dom.window.document.head.appendChild(styleEl);

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Option = dom.window.Option;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.Event = dom.window.Event;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.localStorage = dom.window.localStorage;

const clickedAnchors = [];
const origCreateElement = dom.window.document.createElement.bind(dom.window.document);
dom.window.document.createElement = (tag, opts) => {
  const el = origCreateElement(tag, opts);
  if (String(tag).toLowerCase() === "a") {
    el.click = () => {
      clickedAnchors.push({ download: el.download, href: el.href });
    };
  }
  return el;
};

const localStore = {};
const sessionStore = {};
const alarmsMap = new Map();
const downloadsCalls = [];
const grantedPermissions = new Set(["tabs"]);
const grantedOrigins = new Set(["https://llm.example/*", "https://portal.example.test/*"]);
const storageListeners = [];
let reloadCount = 0;
let captureVisibleCount = 0;
let currentStamp = null;

const chromeMock = {
  management: {
    async getSelf() {
      return { installType: "development" };
    },
  },
  permissions: {
    async contains(query = {}) {
      if (Array.isArray(query.permissions) && query.permissions.length) {
        return query.permissions.every((p) => grantedPermissions.has(p));
      }
      if (Array.isArray(query.origins) && query.origins.length) {
        return query.origins.every((o) => grantedOrigins.has(o));
      }
      return false;
    },
    async request(query = {}) {
      for (const p of query.permissions || []) grantedPermissions.add(p);
      for (const o of query.origins || []) grantedOrigins.add(o);
      return true;
    },
    async remove(query = {}) {
      for (const p of query.permissions || []) grantedPermissions.delete(p);
      for (const o of query.origins || []) grantedOrigins.delete(o);
      return true;
    },
    async getAll() {
      return {
        permissions: [...grantedPermissions],
        origins: [...grantedOrigins],
      };
    },
  },
  alarms: {
    async create(name, info = {}) {
      alarmsMap.set(name, { name, ...info });
    },
    async clear(name) {
      return alarmsMap.delete(name);
    },
    async get(name) {
      return alarmsMap.get(name) || null;
    },
    async getAll() {
      return [...alarmsMap.values()];
    },
    onAlarm: {
      addListener() {},
    },
  },
  downloads: {
    async download(opts) {
      downloadsCalls.push(opts);
      return downloadsCalls.length;
    },
  },
  storage: {
    local: {
      async get(key) {
        if (!key) return { ...localStore };
        if (typeof key === "string") return key in localStore ? { [key]: localStore[key] } : {};
        if (Array.isArray(key)) {
          const out = {};
          for (const k of key) if (k in localStore) out[k] = localStore[k];
          return out;
        }
        return { ...key, ...localStore };
      },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj || {})) {
          changes[k] = { oldValue: localStore[k], newValue: v };
          localStore[k] = structuredClone(v);
        }
        for (const fn of storageListeners) fn(changes, "local");
      },
      async remove(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) delete localStore[k];
      },
    },
    session: {
      async get(key) {
        if (!key) return { ...sessionStore };
        if (typeof key === "string") return key in sessionStore ? { [key]: sessionStore[key] } : {};
        if (Array.isArray(key)) {
          const out = {};
          for (const k of key) if (k in sessionStore) out[k] = sessionStore[k];
          return out;
        }
        return {};
      },
      async set(obj) {
        Object.assign(sessionStore, structuredClone(obj || {}));
      },
      async remove(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) delete sessionStore[k];
      },
    },
    onChanged: {
      addListener(fn) {
        storageListeners.push(fn);
      },
    },
  },
  tabs: {
    async get(id) {
      return {
        id,
        windowId: 1,
        active: true,
        url: "https://portal.example.test/items?token=secret_q_999#priv_hash",
        title: "测试控制台",
      };
    },
    async query() {
      return [
        {
          id: 11,
          windowId: 1,
          active: true,
          url: "https://portal.example.test/items?token=secret_q_999#priv_hash",
          title: "测试控制台",
        },
      ];
    },
    async captureVisibleTab() {
      captureVisibleCount += 1;
      return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    },
  },
  scripting: {
    async executeScript(details = {}) {
      const args = Array.isArray(details.args) ? details.args : [];
      if (args[0] === "click") {
        return [{ result: { ok: false, notFound: true, error: "Element not found: #missing-btn" } }];
      }
      return [
        {
          result: {
            title: "测试控制台",
            url: "https://portal.example.test/items?token=secret_q_999#priv_hash",
            kind: "generic",
            text: "测试页面内容 13800138000",
          },
        },
      ];
    },
  },
  runtime: {
    id: "ext-debug-int",
    getManifest: () => ({ version: "0.12.1" }),
    getURL: (p) => `chrome-extension://ext-debug-int/${p}`,
    async sendMessage() {
      return { ok: true };
    },
    reload() {
      reloadCount += 1;
    },
    onMessage: { addListener() {} },
  },
};

globalThis.chrome = chromeMock;

const origFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const s = String(url);
  if (s.endsWith(".dev-reload-stamp")) {
    if (!currentStamp) return new Response("Not Found", { status: 404 });
    return new Response(JSON.stringify(currentStamp), { status: 200 });
  }
  if (s.endsWith("local-settings.json")) {
    return new Response("Not Found", { status: 404 });
  }
  const sse = `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content: "已完成页面核验回复。" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
  })}\n\ndata: [DONE]\n\n`;
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
};

try {
  const { loadSettings, saveSettings } = await import("../lib/storage.js");
  const {
    requestDownloadsPermissionInGesture,
    revokeDebugPermissions,
    isDevelopmentInstall,
  } = await import("../lib/debug/policy.js");
  const { checkDevReloadOnce, resetDevReloadForTests } = await import("../lib/debug/reload-dev.js");
  const { initSwDebugRuntime, syncSwDebugRuntime } = await import("../lib/debug/sw-entry.js");
  const { exportManualDiagnosticL1, syncSidepanelDebugRuntime } = await import("../lib/debug/hooks.js");
  const { state } = await import("../sidepanel/state.js");
  const { bindSettingsPage } = await import("../sidepanel/panel-refs.js");
  const { createSettingsPage } = await import("../sidepanel/settings-page.js");
  const { renderSettingsForm, syncDebugModeUi } = await import("../sidepanel/settings-form.js");
  const { renderMessages } = await import("../sidepanel/messages.js");
  const { sendPrompt } = await import("../sidepanel/agent-loop.js");

  // ── 阶段 A：默认关闭态（L0）验收 ──
  state.settings = await loadSettings();
  state.settings.skillsEnabled = false;
  state.settings.nativeShell = false;
  state.settings.textProviders = [
    {
      id: "p1",
      name: "UnitLLM",
      preset: "custom",
      baseUrl: "https://llm.example/v1",
      apiKey: "sk-unit-fake-token-999999",
      models: [{ id: "unit-model", enabled: true }],
    },
  ];
  state.settings.textRef = { providerId: "p1", modelId: "unit-model" };
  state.settings.text = {
    preset: "custom",
    baseUrl: "https://llm.example/v1",
    apiKey: "sk-unit-fake-token-999999",
    model: "unit-model",
    summaryInputTokens: 200000,
  };
  state.settings = await saveSettings(state.settings);

  await initSwDebugRuntime({ chromeRef: chromeMock, fetchImpl: globalThis.fetch });
  await syncSidepanelDebugRuntime({ settings: state.settings, chromeRef: chromeMock });

  const settingsPage = createSettingsPage({
    root: document.getElementById("view-settings"),
    getSettings: () => state.settings,
    onModelChange: () => {},
  });
  bindSettingsPage(settingsPage);
  renderSettingsForm();
  syncDebugModeUi();

  assert.equal(state.settings.debug.enabled, false);
  assert.equal(document.getElementById("debug-mode-enabled").checked, false);
  assert.equal(document.getElementById("btn-debug-export").classList.contains("hidden"), true);
  assert.equal(document.getElementById("block-langfuse").classList.contains("hidden"), true);
  assert.equal(document.getElementById("settings-state-trace").textContent, "未启用");
  assert.equal(grantedPermissions.has("downloads"), false);
  assert.equal(alarmsMap.has("pagelens-dev-reload"), false);
  assert.equal(Boolean(sessionStore["pl.debug.log"]), false);

  state.sessionId = "sess_toggle_int";
  state.share = true;
  state.tab = {
    id: 11,
    windowId: 1,
    url: "https://portal.example.test/items?token=secret_q_999#priv_hash",
    title: "测试控制台",
  };
  state.pack = {
    url: state.tab.url,
    title: state.tab.title,
    kind: "generic",
    text: "测试页面内容",
    hasVideo: false,
  };
  state.messages = [];

  await sendPrompt("请核验当前控制台状态");
  assert.equal(downloadsCalls.length, 0, "OFF 模式下 Agent Loop 绝不触发 downloads.download");
  assert.equal(document.querySelectorAll(".btn-download-trace").length, 0, "OFF 模式下不渲染 Trace 下载按钮");

  await sendPrompt(
    '/workflow\n```json\n{"schemaVersion":"1.0","id":"wf_fail_off","steps":[{"id":"s1","op":"click_selector","params":{"selector":"#missing-btn","timeoutMs":30}}]}\n```',
  );
  assert.equal(captureVisibleCount, 0, "OFF 模式下工作流失败绝不自动截屏");

  const l1Res = exportManualDiagnosticL1({
    extensionVersion: "0.12.1",
    sessionMeta: { sessionId: state.sessionId, title: "诊断会话" },
  });
  assert.equal(l1Res.ok, true, "L1 免权限诊断包在无 downloads 权限时正常通过 <a download> 导出");
  assert.equal(clickedAnchors.length, 1);
  assert.ok(!l1Res.jsonText.includes("secret_q_999"), "L1 诊断包剥离 URL 敏感 query");
  assert.ok(!l1Res.jsonText.includes("sk-unit-fake-token"), "L1 诊断包脱敏 API Key");

  // ── 阶段 B：开启调试模式（L2 + 热重载 + 失败截图 + 自动落盘）验收 ──
  const dlGrant = await requestDownloadsPermissionInGesture({ chromeRef: chromeMock });
  assert.equal(dlGrant.granted, true);
  assert.equal(grantedPermissions.has("downloads"), true);

  const devInstall = await isDevelopmentInstall({ chromeRef: chromeMock });
  assert.equal(devInstall, true);

  state.settings.debug = {
    enabled: true,
    traceLevel: "full",
    autoExportRunBundle: true,
    captureFailureScreenshot: true,
    devAutoReload: true,
    writeStartupReceipt: true,
    showLocalMockPreset: true,
  };
  state.settings = await saveSettings(state.settings);
  await syncSwDebugRuntime({ settings: state.settings, chromeRef: chromeMock, fetchImpl: globalThis.fetch });
  await syncSidepanelDebugRuntime({ settings: state.settings, chromeRef: chromeMock });
  syncDebugModeUi();
  renderMessages();

  assert.equal(document.getElementById("debug-mode-enabled").checked, true);
  assert.equal(document.getElementById("btn-debug-export").classList.contains("hidden"), false);
  assert.equal(document.getElementById("block-langfuse").classList.contains("hidden"), false);
  assert.equal(document.getElementById("settings-state-trace").textContent, "已开启");
  assert.equal(alarmsMap.has("pagelens-dev-reload"), true, "开启后注册热重载闹钟");

  await sendPrompt("调试模式开启后再次核验控制台状态");
  assert.ok(
    downloadsCalls.some((d) => d.filename.includes("pagelens-trace-")),
    "开启 L2 后自动落盘 pagelens-trace-*",
  );
  assert.ok(
    downloadsCalls.some((d) => d.filename.includes("pagelens-debug-")),
    "开启 L2 后自动落盘 pagelens-debug-*",
  );
  assert.ok(
    document.querySelectorAll(".btn-download-trace").length >= 1,
    "开启调试模式后消息尾栏渲染 Trace 按钮",
  );

  // 验证开启调试模式后工作流失败自动截图恢复
  await sendPrompt(
    '/workflow\n```json\n{"schemaVersion":"1.0","id":"wf_fail_on","steps":[{"id":"s1","op":"click_selector","params":{"selector":"#missing-btn","timeoutMs":30}}]}\n```',
  );
  assert.ok(captureVisibleCount >= 1, "ON 模式下工作流步骤失败自动触发截屏取证");
  assert.equal(document.getElementById("attach-row").classList.contains("hidden"), true, "失败取证截图不污染对话附件栏");

  // 验证热重载 stamp 检测 -> reload -> 重启写入回执
  currentStamp = {
    timestamp: "2026-11-12T09:30:00Z",
    epochMs: 1794475800000,
    gitCommit: "0d51092",
    gitBranch: "feat/pagelens-debug-mode",
  };
  const checkRes = await checkDevReloadOnce();
  assert.equal(checkRes.action, "reload");
  assert.equal(reloadCount, 1, "检测到 stamp 变化后触发 runtime.reload()");

  // 模拟 SW 重启为全新进程实例后读取新 stamp 并写入启动回执
  delete sessionStore["pl.devReloadSession"];
  resetDevReloadForTests();
  await syncSwDebugRuntime({ settings: state.settings, chromeRef: { ...chromeMock }, fetchImpl: globalThis.fetch });
  assert.equal(localStore["pl.debug.lastStartupReceipt"]?.gitCommit, "0d51092");
  assert.ok(
    downloadsCalls.some((d) => d.filename === "pagelens-runs/sw-startup-latest.json"),
    "有 downloads 权限时同步写出 sw-startup-latest.json",
  );

  // ── 阶段 C：关闭调试模式（权限与闹钟回收 + 会话日志清理）验收 ──
  state.settings.debug = {
    ...state.settings.debug,
    enabled: false,
    traceLevel: "minimal",
    autoExportRunBundle: false,
    captureFailureScreenshot: false,
    devAutoReload: false,
    writeStartupReceipt: false,
    showLocalMockPreset: false,
  };
  state.settings = await saveSettings(state.settings);
  await revokeDebugPermissions({ settings: state.settings, chromeRef: chromeMock });
  await syncSwDebugRuntime({ settings: state.settings, chromeRef: chromeMock, fetchImpl: globalThis.fetch });
  await syncSidepanelDebugRuntime({ settings: state.settings, chromeRef: chromeMock });
  syncDebugModeUi();
  renderMessages();

  assert.equal(grantedPermissions.has("downloads"), false, "关闭后回收 downloads 权限");
  assert.equal(grantedOrigins.has("https://llm.example/*"), true, "保留用户模型服务商 origin 权限");
  assert.equal(alarmsMap.has("pagelens-dev-reload"), false, "关闭后清除热重载闹钟");
  assert.equal(Boolean(sessionStore["pl.debug.log"]), false, "关闭后清空 storage.session 调试日志");
  assert.equal(document.getElementById("debug-mode-enabled").checked, false);
  assert.equal(document.getElementById("btn-debug-export").classList.contains("hidden"), true);
  assert.equal(document.getElementById("block-langfuse").classList.contains("hidden"), true);
  assert.equal(document.querySelectorAll(".btn-download-trace").length, 0, "关闭后隐藏消息气泡 Trace 按钮");
} finally {
  globalThis.fetch = origFetch;
  dom.window.close();
}

console.log("PASS test_debug_toggle_integration.mjs");
process.exit(0);

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createAgentTools } from "../lib/agent/tools.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

// ── screenshot automatic CDP fallback + captureTab({ silent }) suppressing UI errors ──
{
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='msgs'></div><button id='send'></button><div id='save-status'></div></body></html>",
    { url: "chrome-extension://ext-shot-unit/sidepanel/index.html" },
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
        title: "工单巡检看板",
        url: "http://192.0.2.10:5173/#/tasks/board",
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
      id: "ext-shot-unit",
      getManifest: () => ({ version: "0.12.1" }),
      getURL: (p) => `chrome-extension://ext-shot-unit/${p}`,
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
}

console.log("PASS test_screenshot_fallback.mjs");

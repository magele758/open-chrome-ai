import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { sendTraceToLangfuse } from "../lib/debug/langfuse-exporter.js";
import {
  collectActiveNonDebugOrigins,
  hasDownloadsPermission,
  hasOriginPermission,
  requestDownloadsPermissionInGesture,
  requestLangfuseHostPermission,
  revokeDebugPermissions,
} from "../lib/debug/policy.js";
import { persistRunBundle } from "../lib/debug/run-recorder.js";

function makePermissionsChrome({
  grantedPermissions = [],
  grantedOrigins = [],
  allowPermissionPrompt = true,
  allowOriginPrompt = true,
} = {}) {
  const permSet = new Set(grantedPermissions);
  const originSet = new Set(grantedOrigins);
  const requests = [];
  const removals = [];
  const downloads = [];

  const chromeRef = {
    requests,
    removals,
    downloadsList: downloads,
    permSet,
    originSet,
    management: { getSelf: async () => ({ installType: "development" }) },
    runtime: {
      getManifest: () => ({ version: "0.12.1" }),
      getURL: (p) => `chrome-extension://ext-perm/${p}`,
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
    downloads: {
      download: async (opts) => {
        downloads.push(opts);
        return downloads.length;
      },
    },
    permissions: {
      contains: async ({ permissions = [], origins = [] } = {}) => {
        for (const p of permissions) if (!permSet.has(p)) return false;
        for (const o of origins) if (!originSet.has(o)) return false;
        return true;
      },
      request: async ({ permissions = [], origins = [] } = {}) => {
        requests.push({ permissions, origins });
        if (permissions.length && !allowPermissionPrompt) return false;
        if (origins.length && !allowOriginPrompt) return false;
        for (const p of permissions) permSet.add(p);
        for (const o of origins) originSet.add(o);
        return true;
      },
      remove: async ({ permissions = [], origins = [] } = {}) => {
        removals.push({ permissions, origins });
        for (const p of permissions) permSet.delete(p);
        for (const o of origins) originSet.delete(o);
        return true;
      },
    },
  };
  return chromeRef;
}

// 1. 开启调试模式自动落盘时按需手势申请 downloads：授权成功 vs 用户拒绝优雅回滚为 L1
{
  const allowChrome = makePermissionsChrome({ allowPermissionPrompt: true });
  assert.equal(await hasDownloadsPermission({ chromeRef: allowChrome }), false);
  const granted = await requestDownloadsPermissionInGesture({ chromeRef: allowChrome });
  assert.equal(granted.granted, true);
  assert.equal(await hasDownloadsPermission({ chromeRef: allowChrome }), true);
  assert.deepEqual(allowChrome.requests, [{ permissions: ["downloads"], origins: [] }]);

  const denyChrome = makePermissionsChrome({ allowPermissionPrompt: false });
  const denied = await requestDownloadsPermissionInGesture({ chromeRef: denyChrome });
  assert.equal(denied.granted, false);
  assert.match(denied.message, /免权限手动导出模式（L1）/);
  assert.equal(await hasDownloadsPermission({ chromeRef: denyChrome }), false);
  console.log("PASS 1: downloads permission requested in gesture with clean L1 fallback on denial");
}

// 2. 开启 Langfuse 时按需申请 optional_host_permissions，且未获授权时 sendTraceToLangfuse 拒绝越权联网
{
  const lfChrome = makePermissionsChrome({ allowOriginPrompt: true });
  let networkFetches = 0;
  const fetchImpl = async () => {
    networkFetches += 1;
    return { ok: true, status: 200, text: async () => "{}", json: async () => ({}) };
  };

  // 未授权 origin 前调用 sendTraceToLangfuse -> 直接拦截，不发起 fetch
  const blockedSend = await sendTraceToLangfuse(
    { sessionId: "s1", userPrompt: "hello", botResponse: "world", steps: [] },
    {
      enabled: true,
      baseUrl: "https://langfuse.internal.example",
      publicKey: "pk-lf-123456",
      secretKey: "sk-lf-654321",
    },
    { chromeRef: lfChrome, fetchImpl },
  );
  assert.equal(blockedSend.ok, false);
  assert.equal(blockedSend.reason, "missing_host_permission");
  assert.equal(networkFetches, 0, "must NOT send HTTP request without granted host permission");

  // 手势申请授权后 -> 允许正常发送
  const hostGrant = await requestLangfuseHostPermission("https://langfuse.internal.example", {
    chromeRef: lfChrome,
  });
  assert.equal(hostGrant.granted, true);
  assert.equal(hostGrant.originPattern, "https://langfuse.internal.example/*");
  assert.equal(await hasOriginPermission("https://langfuse.internal.example", { chromeRef: lfChrome }), true);

  const allowedSend = await sendTraceToLangfuse(
    { sessionId: "s1", userPrompt: "hello", botResponse: "world", steps: [] },
    {
      enabled: true,
      baseUrl: "https://langfuse.internal.example",
      publicKey: "pk-lf-123456",
      secretKey: "sk-lf-654321",
    },
    { chromeRef: lfChrome, fetchImpl },
  );
  assert.equal(allowedSend.ok, true);
  assert.equal(networkFetches, 1);
  console.log("PASS 2: Langfuse host permission requested on-demand and enforced prior to fetch");
}

// 3. 关闭调试模式时自动回收 downloads 与独享 Langfuse 源站权限（同时保护正在使用的主模型 Provider origin）
{
  const activeSettings = {
    text: { baseUrl: "https://api.openai.com/v1" },
    textProviders: [{ baseUrl: "https://openrouter.ai/api/v1" }],
  };
  const keepOrigins = collectActiveNonDebugOrigins(activeSettings);
  assert.ok(keepOrigins.has("https://api.openai.com/*"));
  assert.ok(keepOrigins.has("https://openrouter.ai/*"));

  // 3a. 独享 Langfuse 域名 -> 连同 downloads 一并回收
  const exclusiveChrome = makePermissionsChrome({
    grantedPermissions: ["downloads"],
    grantedOrigins: ["https://api.openai.com/*", "https://langfuse.internal.example/*"],
  });
  const revokedExclusive = await revokeDebugPermissions({
    chromeRef: exclusiveChrome,
    langfuseUrl: "https://langfuse.internal.example",
    keepOrigins,
    revokeDownloads: true,
  });
  assert.equal(revokedExclusive.downloadsRemoved, true);
  assert.equal(revokedExclusive.originRemoved, true);
  assert.equal(exclusiveChrome.permSet.has("downloads"), false);
  assert.equal(exclusiveChrome.originSet.has("https://langfuse.internal.example/*"), false);
  assert.equal(exclusiveChrome.originSet.has("https://api.openai.com/*"), true, "active LLM origin kept intact");

  // 3b. 若 Langfuse 与主模型共用同一源站 -> 只回收 downloads，不误删主模型 origin
  const sharedChrome = makePermissionsChrome({
    grantedPermissions: ["downloads"],
    grantedOrigins: ["https://api.openai.com/*"],
  });
  const revokedShared = await revokeDebugPermissions({
    chromeRef: sharedChrome,
    langfuseUrl: "https://api.openai.com",
    keepOrigins,
    revokeDownloads: true,
  });
  assert.equal(revokedShared.downloadsRemoved, true);
  assert.equal(revokedShared.originRemoved, false, "must NOT remove origin shared with active LLM provider");
  assert.equal(sharedChrome.originSet.has("https://api.openai.com/*"), true);
  console.log("PASS 3: revokeDebugPermissions reclaims downloads & exclusive Langfuse origin while protecting active providers");
}

// 4. 自动落盘（persistRunBundle）在缺少 downloads 权限时绝不退化为隐藏 <a download> 弹窗轰炸用户
{
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "chrome-extension://ext-perm/sidepanel/index.html",
  });
  const prevDoc = globalThis.document;
  let anchorClicks = 0;
  const origCreate = dom.window.document.createElement.bind(dom.window.document);
  dom.window.document.createElement = (tag) => {
    const el = origCreate(tag);
    if (String(tag).toLowerCase() === "a") {
      el.click = () => {
        anchorClicks += 1;
      };
    }
    return el;
  };
  globalThis.document = dom.window.document;

  try {
    const noDlPermChrome = makePermissionsChrome({ grantedPermissions: [] });
    const res = await persistRunBundle(
      {
        runId: "run_no_dl_perm",
        source: "sidepanel",
        settings: {
          debug: { enabled: true, traceLevel: "full", autoExportRunBundle: true },
        },
        userPrompt: "测试无权限静默跳过",
        botResponse: "ok",
      },
      {
        chromeRef: noDlPermChrome,
        fetchImpl: async () => ({ ok: false, status: 404 }),
        autoExport: true,
      },
    );
    assert.equal(res.exported, false);
    assert.equal(res.skippedReason, "missing_downloads_permission");
    assert.equal(noDlPermChrome.downloadsList.length, 0);
    assert.equal(anchorClicks, 0, "must NEVER fall back to hidden <a download> click during background auto-export");
  } finally {
    globalThis.document = prevDoc;
    dom.window.close();
  }
  console.log("PASS 4: persistRunBundle never triggers unrequested <a download> popups without downloads permission");
}

console.log("ALL PASS test_debug_permissions_lifecycle.mjs");

import assert from "node:assert/strict";
import {
  DEFAULT_DEBUG_SETTINGS,
  detectInstallType,
  isDevelopmentInstall,
  normalizeDebugSettings,
  resolveDebugPolicy,
  resolveEffectiveDebugPolicy,
} from "../lib/debug/policy.js";
import {
  DEV_RELOAD_ALARM_NAME,
  createDevReloadController,
  resetDevReloadForTests,
} from "../lib/debug/reload-dev.js";
import { applyOptionalLocalSettings, defaultSettings, presetsFor } from "../lib/storage.js";

// 1. 默认安全基线：全新安装全部关闭，traceLevel = minimal
{
  const def = defaultSettings();
  assert.deepEqual(def.debug, DEFAULT_DEBUG_SETTINGS);
  assert.equal(def.debug.enabled, false);
  assert.equal(def.debug.traceLevel, "minimal");
  assert.equal(def.debug.autoExportRunBundle, false);
  assert.equal(def.debug.captureFailureScreenshot, false);
  assert.equal(def.debug.devAutoReload, false);
  assert.equal(def.debug.writeStartupReceipt, false);
  assert.equal(def.debug.showLocalMockPreset, false);
  console.log("PASS 1: defaultSettings() enforces L0 minimal safe baseline");
}

// 2. installType 检测与回退
{
  for (const kind of ["development", "normal", "admin", "sideload", "other"]) {
    const chromeRef = {
      management: { getSelf: async () => ({ installType: kind }) },
      runtime: { getManifest: () => ({ version: "0.12.1" }) },
    };
    assert.equal(await detectInstallType({ chromeRef }), kind);
    assert.equal(await isDevelopmentInstall({ chromeRef }), kind === "development");
  }

  // manifest 含 update_url 时（CWS 打包扩展）回退判定为 normal
  const cwsFallbackChrome = {
    runtime: { getManifest: () => ({ version: "0.12.1", update_url: "https://clients2.google.com/service/update2/crx" }) },
  };
  assert.equal(await detectInstallType({ chromeRef: cwsFallbackChrome }), "normal");
  assert.equal(await isDevelopmentInstall({ chromeRef: cwsFallbackChrome }), false);
  console.log("PASS 2: detectInstallType covers management.getSelf + manifest update_url fallback");
}

// 3. resolveEffectiveDebugPolicy 全排列矩阵（installType × prodBuild × settings.debug）
{
  const allOnSettings = {
    debug: {
      enabled: true,
      traceLevel: "full",
      autoExportRunBundle: true,
      captureFailureScreenshot: true,
      devAutoReload: true,
      writeStartupReceipt: true,
      showLocalMockPreset: true,
    },
    langfuse: { enabled: true },
  };

  // 3a. development + 非生产构建 + 开启调试 -> 全部调试子能力可用
  const devOn = resolveEffectiveDebugPolicy(allOnSettings, { installType: "development", prodBuild: false });
  assert.equal(devOn.enabled, true);
  assert.equal(devOn.isDevInstall, true);
  assert.equal(devOn.traceLevel, "full");
  assert.equal(devOn.canUseDevReload, true);
  assert.equal(devOn.canReadLocalSettingsFile, true);
  assert.equal(devOn.canWriteStartupReceipt, true);
  assert.equal(devOn.autoExportRunBundle, true);
  assert.equal(devOn.captureFailureScreenshot, true);
  assert.equal(devOn.persistDebugLogToSession, true);
  assert.equal(devOn.printDebugConsole, true);
  assert.equal(devOn.showDebugUi, true);
  assert.equal(devOn.showLocalMockPreset, true);
  assert.equal(devOn.langfuseEnabled, true);

  // 3b. normal / admin / sideload / other 下即使 settings.debug.devAutoReload=true，热重载与启动回执也强制锁死为 false
  for (const nonDevType of ["normal", "admin", "sideload", "other"]) {
    const p = resolveEffectiveDebugPolicy(allOnSettings, { installType: nonDevType, prodBuild: false });
    assert.equal(p.isDevInstall, false, `${nonDevType}: isDevInstall must be false`);
    assert.equal(p.canUseDevReload, false, `${nonDevType}: canUseDevReload must be hard-locked false`);
    assert.equal(p.canReadLocalSettingsFile, false, `${nonDevType}: canReadLocalSettingsFile must be false`);
    assert.equal(p.canWriteStartupReceipt, false, `${nonDevType}: canWriteStartupReceipt must be false`);
  }

  // 3c. prodBuild = true 下即便 installType 伪造为 "development" 也硬性锁死所有仅开发期能力
  const prodOn = resolveEffectiveDebugPolicy(allOnSettings, { installType: "development", prodBuild: true });
  assert.equal(prodOn.isDevInstall, false);
  assert.equal(prodOn.canUseDevReload, false);
  assert.equal(prodOn.canReadLocalSettingsFile, false);
  assert.equal(prodOn.canWriteStartupReceipt, false);
  assert.equal(prodOn.showLocalMockPreset, false);

  // 3d. enabled = false 时所有子项（含 langfuseEnabled）一律归零
  const devOff = resolveEffectiveDebugPolicy(
    {
      debug: { ...allOnSettings.debug, enabled: false },
      langfuse: { enabled: true },
    },
    { installType: "development", prodBuild: false },
  );
  assert.equal(devOff.enabled, false);
  assert.equal(devOff.traceLevel, "minimal");
  assert.equal(devOff.canUseDevReload, false);
  assert.equal(devOff.autoExportRunBundle, false);
  assert.equal(devOff.captureFailureScreenshot, false);
  assert.equal(devOff.persistDebugLogToSession, false);
  assert.equal(devOff.printDebugConsole, false);
  assert.equal(devOff.showDebugUi, false);
  assert.equal(devOff.showLocalMockPreset, false);
  assert.equal(devOff.langfuseEnabled, false);

  console.log("PASS 3: resolveEffectiveDebugPolicy matrix enforces installType & prodBuild hard locks");
}

// 4. local-mock 预设隐藏与 local-settings.json 仅解包态读取门禁
{
  const defaultPresets = presetsFor("text", defaultSettings());
  assert.ok(!defaultPresets.some((p) => p.id === "local-mock"), "local-mock hidden by default");

  const devPresets = presetsFor("text", {
    debug: { enabled: true, showLocalMockPreset: true },
  });
  assert.ok(devPresets.some((p) => p.id === "local-mock"), "local-mock visible when debug.showLocalMockPreset is on");

  let normalFetchedUrls = [];
  const normalChrome = {
    management: { getSelf: async () => ({ installType: "normal" }) },
    runtime: { getURL: (rel) => `chrome-extension://ext/${rel}` },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };
  const normalRes = await applyOptionalLocalSettings({
    chromeRef: normalChrome,
    fetchImpl: async (u) => {
      normalFetchedUrls.push(u);
      return { ok: true, json: async () => ({ rev: 1, debug: { enabled: true } }) };
    },
  });
  assert.equal(normalRes, null);
  assert.equal(normalFetchedUrls.length, 0, "normal install must never fetch local-settings.json");

  console.log("PASS 4: local-mock preset & local-settings.json gated behind debug / development install");
}

// 5. reload-dev 在非 development 安装形态下硬短路（零 stamp 请求、零闹钟、零重载）
{
  resetDevReloadForTests();
  const clearedAlarms = [];
  const createdAlarms = [];
  const fetchedUrls = [];
  let reloads = 0;

  const normalChrome = {
    management: { getSelf: async () => ({ installType: "normal" }) },
    runtime: {
      getManifest: () => ({ version: "0.12.1" }),
      getURL: (rel) => `chrome-extension://ext/${rel}`,
      reload: () => {
        reloads += 1;
      },
    },
    storage: {
      local: {
        get: async () => ({
          devAutoReloadEnabled: true,
          settings: {
            debug: normalizeDebugSettings({
              debug: { enabled: true, traceLevel: "full", devAutoReload: true, writeStartupReceipt: true },
            }),
          },
        }),
        set: async () => {},
      },
      session: { get: async () => ({}), set: async () => {} },
    },
    alarms: {
      clear: async (name) => {
        clearedAlarms.push(name);
        return true;
      },
      create: async (name) => {
        createdAlarms.push(name);
      },
    },
  };

  const ctrl = createDevReloadController({
    chromeRef: normalChrome,
    fetchImpl: async (url) => {
      fetchedUrls.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify({ gitCommit: "deadbeef" }) };
    },
  });

  const initRes = await ctrl.init();
  assert.equal(initRes.enabled, false);
  assert.equal(initRes.blockedByInstallType, true);
  assert.equal(createdAlarms.length, 0, "must not create pagelens-dev-reload alarm in normal install");
  assert.ok(clearedAlarms.includes(DEV_RELOAD_ALARM_NAME));
  assert.equal(fetchedUrls.length, 0, "must not fetch .dev-reload-stamp in normal install");

  const checkRes = await ctrl.checkOnce();
  assert.equal(checkRes.action, "disabled");
  assert.equal(checkRes.reason, "non_development_install");
  assert.equal(reloads, 0);

  const resolvedPolicy = await resolveDebugPolicy({ chromeRef: normalChrome });
  assert.equal(resolvedPolicy.canUseDevReload, false);
  console.log("PASS 5: reload-dev controller hard-blocks non-development installs");
}

console.log("ALL PASS test_debug_policy.mjs");

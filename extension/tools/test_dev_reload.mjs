import assert from "node:assert/strict";
import {
  ABSENT_STAMP_RAW,
  AGENT_BUSY_SESSION_KEY,
  AGENT_BUSY_TTL_MS,
  DEV_AUTO_RELOAD_DEFAULT,
  DEV_AUTO_RELOAD_STORAGE_KEY,
  DEV_RELOAD_ALARM_NAME,
  DEV_RELOAD_PERIOD_MINUTES,
  DEV_RELOAD_SESSION_KEY,
  SW_STARTUP_RECEIPT_FILENAME,
  createDevReloadController,
  getBuildInfo,
  isDevAutoReloadEnabled,
  readDevReloadStamp,
  resetDevReloadForTests,
  resolveBuildInfo,
  setDevAutoReloadEnabled,
} from "../lib/debug/reload-dev.js";

function makeStorageArea(initial = {}) {
  const bag = { ...initial };
  return {
    bag,
    async get(keys) {
      if (keys == null) return { ...bag };
      if (typeof keys === "string") return keys in bag ? { [keys]: bag[keys] } : {};
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (k in bag) out[k] = bag[k];
        return out;
      }
      return { ...bag };
    },
    async set(patch) {
      Object.assign(bag, patch);
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete bag[k];
    },
    clear() {
      for (const k of Object.keys(bag)) delete bag[k];
    },
  };
}

function makeFakeChrome({ version = "0.12.1", localInit = {}, sessionInit = {} } = {}) {
  const local = makeStorageArea(localInit);
  const session = makeStorageArea(sessionInit);
  const alarms = new Map();
  const alarmListeners = [];
  const storageListeners = [];
  const downloads = [];
  let reloadCount = 0;

  const chromeRef = {
    local,
    session,
    alarmsMap: alarms,
    alarmListeners,
    downloadsList: downloads,
    get reloadCount() {
      return reloadCount;
    },
    runtime: {
      id: "ext-test",
      getManifest: () => ({ version }),
      getURL: (rel) => `chrome-extension://ext-test/${rel}`,
      reload: () => {
        reloadCount += 1;
        // MV3 runtime.reload() clears storage.session on the new extension lifecycle
        session.clear();
      },
    },
    storage: {
      local: {
        get: (k) => local.get(k),
        set: async (patch) => {
          const changes = {};
          for (const [k, v] of Object.entries(patch)) {
            changes[k] = { oldValue: local.bag[k], newValue: v };
          }
          await local.set(patch);
          for (const fn of storageListeners) fn(changes, "local");
        },
        remove: (k) => local.remove(k),
      },
      session,
      onChanged: {
        addListener(fn) {
          storageListeners.push(fn);
        },
      },
    },
    alarms: {
      async get(name) {
        return alarms.get(name) || null;
      },
      async create(name, info) {
        alarms.set(name, { name, ...info });
      },
      async clear(name) {
        return alarms.delete(name);
      },
      onAlarm: {
        addListener(fn) {
          alarmListeners.push(fn);
        },
      },
    },
    downloads: {
      async download(opts) {
        downloads.push(opts);
        return downloads.length;
      },
    },
  };
  return chromeRef;
}

function decodeDataUrlJson(dataUrl) {
  const m = /^data:application\/json;charset=utf-8;base64,(.+)$/.exec(dataUrl);
  assert.ok(m, "expected base64 JSON data URL");
  return JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
}

assert.equal(DEV_AUTO_RELOAD_DEFAULT, false, "dev-reload must be disabled by default");

// 0. 默认关闭：无配置开关时不注册 alarm、不写 sw-startup-latest.json、不触发重载；支持 local-settings.json 显式开启
{
  resetDevReloadForTests();
  const chromeRef = makeFakeChrome();
  const fetchImpl = async (url) => {
    if (String(url).endsWith(".dev-reload-stamp")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ timestamp: "2026-11-12T00:00:00Z", gitCommit: "111aaaa" }),
      };
    }
    return { ok: false, status: 404, text: async () => "" };
  };

  assert.equal(await isDevAutoReloadEnabled({ chromeRef, fetchImpl }), false);
  const defaultCtrl = createDevReloadController({ chromeRef, fetchImpl });
  const initOff = await defaultCtrl.init();
  assert.equal(initOff.enabled, false);
  assert.equal(chromeRef.alarmsMap.has(DEV_RELOAD_ALARM_NAME), false, "no alarm when disabled by default");
  assert.equal(chromeRef.downloadsList.length, 0, "no startup receipt when disabled by default");
  assert.equal((await defaultCtrl.checkOnce()).action, "disabled");
  assert.equal(chromeRef.reloadCount, 0);

  // 通过 local-settings.json 显式开启 dev.autoReload
  resetDevReloadForTests();
  const localCfgChrome = makeFakeChrome();
  const localCfgFetch = async (url) => {
    if (String(url).endsWith("local-settings.json")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ rev: 1, dev: { autoReload: true } }) };
    }
    if (String(url).endsWith(".dev-reload-stamp")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ timestamp: "2026-11-12T00:01:00Z", gitCommit: "222bbbb" }) };
    }
    return { ok: false, status: 404, text: async () => "" };
  };
  assert.equal(await isDevAutoReloadEnabled({ chromeRef: localCfgChrome, fetchImpl: localCfgFetch }), true);
  const localCfgCtrl = createDevReloadController({ chromeRef: localCfgChrome, fetchImpl: localCfgFetch });
  const initLocal = await localCfgCtrl.init();
  assert.equal(initLocal.enabled, true);
  assert.equal(localCfgChrome.alarmsMap.has(DEV_RELOAD_ALARM_NAME), true);
  assert.equal(localCfgChrome.downloadsList.length, 1);
  console.log("PASS 0: disabled by default and opt-in via local-settings.json or storage");
}

// 1. 显式开启后，无 .dev-reload-stamp 时静默运行，不写回执、不误重载
{
  resetDevReloadForTests();
  const chromeRef = makeFakeChrome({ localInit: { [DEV_AUTO_RELOAD_STORAGE_KEY]: true } });
  const logs = [];
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => "" });

  const stamp = await readDevReloadStamp({ chromeRef, fetchImpl });
  assert.equal(stamp, null);

  const ctrl = createDevReloadController({
    chromeRef,
    fetchImpl,
    logDebug: (event, detail) => logs.push({ event, detail }),
  });
  const initRes = await ctrl.init();
  assert.equal(initRes.wokeFromHibernation, false);
  assert.equal(initRes.session.baselineRaw, ABSENT_STAMP_RAW);
  assert.equal(initRes.session.gitCommit, "dev-local");
  assert.equal(chromeRef.downloadsList.length, 0, "no startup receipt when stamp is absent");
  assert.deepEqual(chromeRef.alarmsMap.get(DEV_RELOAD_ALARM_NAME), {
    name: DEV_RELOAD_ALARM_NAME,
    periodInMinutes: DEV_RELOAD_PERIOD_MINUTES,
  });
  assert.ok(logs.some((l) => l.event === "sw.startup" && l.detail.version === "0.12.1" && l.detail.gitCommit === "dev-local"));

  const checkRes = await ctrl.checkOnce();
  assert.equal(checkRes.action, "noop");
  assert.equal(chromeRef.reloadCount, 0);
  console.log("PASS 1: absent stamp stays silent without reloading");
}

// 2. 首次启动记录 session 基线 + 打印版本与 git 短哈希 + 写出 sw-startup-latest.json；
//    模拟 SW 休眠唤醒：同一 stamp 不误重载，休眠期间 stamp 更新也绝不覆盖 baselineRaw！
{
  resetDevReloadForTests();
  const chromeRef = makeFakeChrome({ localInit: { [DEV_AUTO_RELOAD_STORAGE_KEY]: true } });
  const logs = [];
  let currentStampObj = {
    timestamp: "2026-11-11T14:00:00.000Z",
    epochMs: 1794405600000,
    gitCommit: "ddf1eaa",
    gitBranch: "feat/dev-reload-test",
    note: "boot",
  };
  const fetchImpl = async (url) => {
    if (!String(url).endsWith(".dev-reload-stamp")) {
      return { ok: false, status: 404, text: async () => "" };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(currentStampObj),
    };
  };

  // SW 首次启动
  const swBoot1 = createDevReloadController({
    chromeRef,
    fetchImpl,
    now: () => 1_700_000_000_000,
    logDebug: (event, detail) => logs.push({ event, detail }),
  });
  const boot1 = await swBoot1.init();
  assert.equal(boot1.wokeFromHibernation, false);
  assert.equal(boot1.session.gitCommit, "ddf1eaa");
  assert.equal(boot1.session.extensionVersion, "0.12.1");
  assert.equal(chromeRef.downloadsList.length, 1, "dev stamp writes startup receipt");
  assert.equal(chromeRef.downloadsList[0].filename, SW_STARTUP_RECEIPT_FILENAME);
  assert.equal(chromeRef.downloadsList[0].conflictAction, "overwrite");
  assert.equal(chromeRef.downloadsList[0].saveAs, false);
  const receipt = decodeDataUrlJson(chromeRef.downloadsList[0].url);
  assert.deepEqual(receipt, {
    event: "sw.startup",
    version: "0.12.1",
    gitCommit: "ddf1eaa",
    stampTimestamp: "2026-11-11T14:00:00.000Z",
    bootedAt: new Date(1_700_000_000_000).toISOString(),
  });

  const buildInfo = await resolveBuildInfo({ chromeRef, fetchImpl });
  assert.deepEqual(buildInfo, {
    extensionVersion: "0.12.1",
    gitCommit: "ddf1eaa",
    stampTimestamp: "2026-11-11T14:00:00.000Z",
  });
  assert.deepEqual(getBuildInfo({ chromeRef }), buildInfo);

  // 模拟 SW 休眠后唤醒（新建 controller 实例，但共享同一个 chrome.storage.session），stamp 未变 -> 不重载
  const swWakeSame = createDevReloadController({
    chromeRef,
    fetchImpl,
    logDebug: (event, detail) => logs.push({ event, detail }),
  });
  const wake1 = await swWakeSame.init();
  assert.equal(wake1.wokeFromHibernation, true);
  assert.equal(chromeRef.downloadsList.length, 1, "hibernation wake must not re-emit startup receipt");
  const checkSame = await swWakeSame.checkOnce();
  assert.equal(checkSame.action, "noop");
  assert.equal(chromeRef.reloadCount, 0);

  // 关键场景：SW 处于休眠态时外部脚本执行了 reload.sh 更新了 .dev-reload-stamp，随后 alarm 唤醒新 SW 实例！
  // 新实例 init() 绝不能用新 stamp 覆盖 session 中的 baselineRaw，否则会漏检更新！
  currentStampObj = {
    timestamp: "2026-11-11T14:05:00.000Z",
    epochMs: 1794405900000,
    gitCommit: "a1b2c3d",
    gitBranch: "feat/dev-reload-test",
    note: "commit-1",
  };
  const swWakeAfterUpdate = createDevReloadController({
    chromeRef,
    fetchImpl,
    logDebug: (event, detail) => logs.push({ event, detail }),
  });
  // 直接模拟 alarm 先触发 checkOnce（内部等待 init）
  const checkChanged = await swWakeAfterUpdate.checkOnce();
  assert.equal(checkChanged.action, "reload");
  assert.equal(checkChanged.from, "ddf1eaa");
  assert.equal(checkChanged.to, "a1b2c3d");
  assert.equal(chromeRef.reloadCount, 1);

  // 重载完成后新生命周期启动（session 已被 reload 清空）：建立新基线 a1b2c3d，后续 alarm 不再死循环重载
  const swAfterReload = createDevReloadController({
    chromeRef,
    fetchImpl,
    logDebug: (event, detail) => logs.push({ event, detail }),
  });
  const afterReloadCheck = await swAfterReload.checkOnce();
  assert.equal(afterReloadCheck.action, "noop");
  assert.equal(chromeRef.reloadCount, 1, "must not reload again once new baseline is established");
  assert.equal(chromeRef.session.bag[DEV_RELOAD_SESSION_KEY].gitCommit, "a1b2c3d");
  console.log("PASS 2: baseline preserved across SW hibernation and no infinite reload loop");
}

// 3. 忙碌时延后重载（SW 委托任务 / 侧栏 pl.agent.busy / Inbox agentPromptActive），空闲后触发 reload
{
  resetDevReloadForTests();
  const chromeRef = makeFakeChrome({ localInit: { [DEV_AUTO_RELOAD_STORAGE_KEY]: true } });
  const logs = [];
  let nowMs = 1_700_000_100_000;
  let delegateRunning = 0;
  let stampCommit = "1111111";

  const fetchImpl = async (url) => {
    if (!String(url).endsWith(".dev-reload-stamp")) {
      return { ok: false, status: 404, text: async () => "" };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ timestamp: "2026-11-11T14:10:00Z", gitCommit: stampCommit }),
    };
  };

  const ctrl = createDevReloadController({
    chromeRef,
    fetchImpl,
    now: () => nowMs,
    getDelegateRunningCount: () => delegateRunning,
    logDebug: (event, detail) => logs.push({ event, detail }),
  });
  await ctrl.init();

  // 更新 stamp
  stampCommit = "2222222";

  // 3a. SW 委托任务忙碌
  delegateRunning = 1;
  let res = await ctrl.checkOnce();
  assert.equal(res.action, "deferred");
  assert.deepEqual(res.reasons, ["sw-delegate"]);
  assert.equal(chromeRef.reloadCount, 0);
  delegateRunning = 0;

  // 3b. 侧栏忙碌（新鲜的 pl.agent.busy）
  await chromeRef.session.set({
    [AGENT_BUSY_SESSION_KEY]: { busy: true, runId: "run_1", updatedAt: nowMs - 5000 },
  });
  res = await ctrl.checkOnce();
  assert.equal(res.action, "deferred");
  assert.deepEqual(res.reasons, ["sidepanel"]);
  assert.equal(chromeRef.reloadCount, 0);

  // 3c. Inbox agent_prompt 忙碌
  await chromeRef.session.set({
    [AGENT_BUSY_SESSION_KEY]: { busy: false, runId: "run_1", updatedAt: nowMs },
    agentPromptActive: { id: "job_1", startedAt: nowMs, deadline: nowMs + 60_000 },
  });
  res = await ctrl.checkOnce();
  assert.equal(res.action, "deferred");
  assert.deepEqual(res.reasons, ["inbox"]);
  assert.equal(chromeRef.reloadCount, 0);

  // 3d. 侧栏标记超过 30 分钟 TTL 视为过期遗留，且 Inbox 已结束 -> 空闲，立即重载！
  await chromeRef.session.remove("agentPromptActive");
  await chromeRef.session.set({
    [AGENT_BUSY_SESSION_KEY]: { busy: true, runId: "stale", updatedAt: nowMs - AGENT_BUSY_TTL_MS - 1000 },
  });
  res = await ctrl.checkOnce();
  assert.equal(res.action, "reload");
  assert.equal(res.from, "1111111");
  assert.equal(res.to, "2222222");
  assert.equal(chromeRef.reloadCount, 1);
  assert.ok(logs.some((l) => l.event === "devReload.deferred"));
  assert.ok(logs.some((l) => l.event === "devReload.reload"));
  console.log("PASS 3: busy tasks defer reload and idle triggers runtime.reload()");
}

// 4. 一键启停开关（storage 显式开启与关闭均生效并同步管理 alarm）
{
  resetDevReloadForTests();
  const chromeRef = makeFakeChrome({ localInit: { [DEV_AUTO_RELOAD_STORAGE_KEY]: true } });
  let stampCommit = "aaaaaaa";
  const fetchImpl = async (url) => {
    if (!String(url).endsWith(".dev-reload-stamp")) {
      return { ok: false, status: 404, text: async () => "" };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ timestamp: "2026-11-11T14:20:00Z", gitCommit: stampCommit }),
    };
  };

  const ctrl = createDevReloadController({ chromeRef, fetchImpl });
  ctrl.wire();
  await ctrl.init();
  assert.equal(chromeRef.alarmsMap.has(DEV_RELOAD_ALARM_NAME), true);

  // storage 置 false -> 立即清理 alarm，且即使 stamp 改变也不重载
  await setDevAutoReloadEnabled(false, { chromeRef, fetchImpl });
  assert.equal(await isDevAutoReloadEnabled({ chromeRef, fetchImpl }), false);
  assert.equal(chromeRef.alarmsMap.has(DEV_RELOAD_ALARM_NAME), false);

  stampCommit = "bbbbbbb";
  const disabledCheck = await ctrl.checkOnce();
  assert.equal(disabledCheck.action, "disabled");
  assert.equal(chromeRef.reloadCount, 0);

  // 重新置 true -> 恢复 alarm 并在下一轮检测到新 stamp 后重载
  await setDevAutoReloadEnabled(true, { chromeRef, fetchImpl });
  assert.equal(await isDevAutoReloadEnabled({ chromeRef, fetchImpl }), true);
  assert.equal(chromeRef.alarmsMap.has(DEV_RELOAD_ALARM_NAME), true);
  const reenabledCheck = await ctrl.checkOnce();
  assert.equal(reenabledCheck.action, "reload");
  assert.equal(chromeRef.reloadCount, 1);
  console.log("PASS 4: explicit toggle switch manages alarm and reload lifecycle");
}

console.log("ALL PASS test_dev_reload");

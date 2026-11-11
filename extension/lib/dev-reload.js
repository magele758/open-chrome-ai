/**
 * 开发态自动热重载（零端口、零守护进程、纯 MV3 chrome.alarms + 静态 stamp 文件对比）。
 *
 * 关键不变量：
 * 1. 利用 chrome.storage.session["pl.devReloadSession"] 跨 MV3 SW 休眠唤醒保留基线，
 *    绝不在 alarm 唤醒时覆盖 baselineRaw；扩展 reload() 后 session 自动清空，新实例重新建立基线。
 * 2. 发现 stamp 变化时先检查 SW 委托任务、侧栏 pl.agent.busy、Inbox agent_prompt 是否忙碌；
 *    忙碌则延后到下一轮 alarm，空闲才调用 chrome.runtime.reload()。
 * 3. 所有预期容错分支仅使用 console.info + debugLog，严禁 console.warn / console.error。
 */

import { getDelegateManager } from "./agent/delegate.js";
import { isInboxPromptActive } from "./agent/inbox-agent.js";
import { debugLog } from "./debug-log.js";

export const DEV_AUTO_RELOAD_DEFAULT = true;
export const DEV_AUTO_RELOAD_STORAGE_KEY = "devAutoReloadEnabled";
export const DEV_RELOAD_ALARM_NAME = "pagelens-dev-reload";
export const DEV_RELOAD_PERIOD_MINUTES = 0.25;
export const DEV_RELOAD_SESSION_KEY = "pl.devReloadSession";
export const AGENT_BUSY_SESSION_KEY = "pl.agent.busy";
export const AGENT_BUSY_TTL_MS = 30 * 60 * 1000;
export const ABSENT_STAMP_RAW = "__absent__";
export const SW_STARTUP_RECEIPT_FILENAME = "pagelens-runs/sw-startup-latest.json";

let cachedBuildInfo = {
  extensionVersion: "",
  gitCommit: "",
  stampTimestamp: "",
};

function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function jsonToDataUrl(payload) {
  const text = JSON.stringify(payload, null, 2);
  const bytes = new TextEncoder().encode(text);
  return `data:application/json;charset=utf-8;base64,${bytesToBase64(bytes)}`;
}

function readManifestVersion(chromeRef = globalThis.chrome) {
  try {
    return String(chromeRef?.runtime?.getManifest?.()?.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

export function parseDevReloadStampText(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        raw,
        timestamp: String(parsed.timestamp || ""),
        epochMs: Number(parsed.epochMs) || 0,
        gitCommit: String(parsed.gitCommit || "").trim(),
        gitBranch: String(parsed.gitBranch || "").trim(),
        note: String(parsed.note || ""),
      };
    }
  } catch {
    /* 纯文本 stamp 兜底 */
  }
  return {
    raw,
    timestamp: raw,
    epochMs: 0,
    gitCommit: "",
    gitBranch: "",
    note: "",
  };
}

export async function readDevReloadStamp({
  chromeRef = globalThis.chrome,
  fetchImpl = globalThis.fetch,
} = {}) {
  try {
    const getUrl = chromeRef?.runtime?.getURL;
    if (typeof getUrl !== "function" || typeof fetchImpl !== "function") return null;
    const url = getUrl.call(chromeRef.runtime, ".dev-reload-stamp");
    if (!url) return null;
    const res = await fetchImpl(url, { cache: "no-store" });
    if (!res || !res.ok) return null;
    const text = await res.text();
    return parseDevReloadStampText(text);
  } catch {
    return null;
  }
}

export function getBuildInfo({ chromeRef = globalThis.chrome } = {}) {
  return {
    extensionVersion: cachedBuildInfo.extensionVersion || readManifestVersion(chromeRef),
    gitCommit: cachedBuildInfo.gitCommit || "dev-local",
    stampTimestamp: cachedBuildInfo.stampTimestamp || "",
  };
}

export async function resolveBuildInfo({
  chromeRef = globalThis.chrome,
  fetchImpl = globalThis.fetch,
} = {}) {
  const extensionVersion = readManifestVersion(chromeRef);
  try {
    const sessionData = await chromeRef?.storage?.session?.get?.(DEV_RELOAD_SESSION_KEY);
    const saved = sessionData?.[DEV_RELOAD_SESSION_KEY];
    if (saved && typeof saved === "object" && saved.gitCommit) {
      cachedBuildInfo = {
        extensionVersion: String(saved.extensionVersion || extensionVersion),
        gitCommit: String(saved.gitCommit || "dev-local"),
        stampTimestamp: String(saved.stampTimestamp || ""),
      };
      return { ...cachedBuildInfo };
    }
  } catch {
    /* ignore session read failure */
  }
  const stamp = await readDevReloadStamp({ chromeRef, fetchImpl });
  cachedBuildInfo = {
    extensionVersion,
    gitCommit: stamp?.gitCommit || cachedBuildInfo.gitCommit || "dev-local",
    stampTimestamp: stamp?.timestamp || cachedBuildInfo.stampTimestamp || "",
  };
  return { ...cachedBuildInfo };
}

export async function isDevAutoReloadEnabled({
  chromeRef = globalThis.chrome,
  defaultEnabled = DEV_AUTO_RELOAD_DEFAULT,
} = {}) {
  if (!defaultEnabled) return false;
  try {
    const data = await chromeRef?.storage?.local?.get?.(DEV_AUTO_RELOAD_STORAGE_KEY);
    if (data && data[DEV_AUTO_RELOAD_STORAGE_KEY] === false) return false;
  } catch {
    /* ignore local storage errors */
  }
  return true;
}

export async function clearDevReloadAlarm({ chromeRef = globalThis.chrome } = {}) {
  try {
    if (typeof chromeRef?.alarms?.clear === "function") {
      await Promise.resolve(chromeRef.alarms.clear(DEV_RELOAD_ALARM_NAME));
    }
  } catch {
    /* ignore alarm clear failure */
  }
}

export async function syncDevReloadAlarm({
  chromeRef = globalThis.chrome,
  defaultEnabled = DEV_AUTO_RELOAD_DEFAULT,
} = {}) {
  const enabled = await isDevAutoReloadEnabled({ chromeRef, defaultEnabled });
  if (!enabled) {
    await clearDevReloadAlarm({ chromeRef });
    return { enabled: false };
  }
  try {
    const alarms = chromeRef?.alarms;
    if (!alarms?.create) return { enabled: true, created: false };
    const existing = typeof alarms.get === "function"
      ? await Promise.resolve(alarms.get(DEV_RELOAD_ALARM_NAME)).catch(() => null)
      : null;
    if (existing?.periodInMinutes !== DEV_RELOAD_PERIOD_MINUTES) {
      if (existing && typeof alarms.clear === "function") {
        await Promise.resolve(alarms.clear(DEV_RELOAD_ALARM_NAME)).catch(() => {});
      }
      await Promise.resolve(alarms.create(DEV_RELOAD_ALARM_NAME, { periodInMinutes: DEV_RELOAD_PERIOD_MINUTES }));
    }
    return { enabled: true, periodInMinutes: DEV_RELOAD_PERIOD_MINUTES, created: !existing };
  } catch {
    return { enabled: true, created: false };
  }
}

export async function setDevAutoReloadEnabled(
  enabled,
  {
    chromeRef = globalThis.chrome,
    defaultEnabled = DEV_AUTO_RELOAD_DEFAULT,
  } = {},
) {
  const flag = Boolean(enabled);
  try {
    await chromeRef?.storage?.local?.set?.({ [DEV_AUTO_RELOAD_STORAGE_KEY]: flag });
  } catch {
    /* ignore storage write error */
  }
  const alarmState = await syncDevReloadAlarm({ chromeRef, defaultEnabled });
  debugLog("devReload.toggle", { enabled: flag, effective: alarmState.enabled });
  console.info("[PageLens] devReload.toggle", JSON.stringify({ enabled: flag, effective: alarmState.enabled }));
  return { enabled: flag, effective: alarmState.enabled };
}

async function writeStartupReceipt(chromeRef, { extensionVersion, gitCommit, stampTimestamp, bootedAt }) {
  if (typeof chromeRef?.downloads?.download !== "function") return false;
  try {
    const payload = {
      event: "sw.startup",
      version: extensionVersion,
      gitCommit,
      stampTimestamp,
      bootedAt,
    };
    await Promise.resolve(
      chromeRef.downloads.download({
        url: jsonToDataUrl(payload),
        filename: SW_STARTUP_RECEIPT_FILENAME,
        conflictAction: "overwrite",
        saveAs: false,
      }),
    );
    return true;
  } catch (err) {
    const reason = String(err?.message || err);
    console.info("[PageLens] sw.startup receipt skipped:", reason);
    debugLog("sw.startup.receiptSkipped", { reason });
    return false;
  }
}

export function createDevReloadController({
  chromeRef = globalThis.chrome,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  defaultEnabled = DEV_AUTO_RELOAD_DEFAULT,
  getDelegateRunningCount = () => getDelegateManager()?.runningCount?.() || 0,
  checkInboxBusy = (area, ts) => isInboxPromptActive(area, ts),
  logDebug = debugLog,
} = {}) {
  let initPromise = null;
  let memorySession = null;
  let reloading = false;
  let checking = false;
  let listenersWired = false;

  async function readSession() {
    try {
      const area = chromeRef?.storage?.session;
      if (area?.get) {
        const got = await area.get(DEV_RELOAD_SESSION_KEY);
        if (got?.[DEV_RELOAD_SESSION_KEY]) return got[DEV_RELOAD_SESSION_KEY];
        return null;
      }
    } catch {
      /* fallback to memorySession */
    }
    return memorySession;
  }

  async function writeSession(value) {
    memorySession = value;
    try {
      const area = chromeRef?.storage?.session;
      if (area?.set) {
        await area.set({ [DEV_RELOAD_SESSION_KEY]: value });
      }
    } catch {
      /* keep memorySession */
    }
  }

  async function collectBusyReasons(currentNow) {
    const reasons = [];
    try {
      if ((Number(getDelegateRunningCount()) || 0) > 0) {
        reasons.push("sw-delegate");
      }
    } catch {
      /* ignore */
    }
    try {
      const sessionArea = chromeRef?.storage?.session;
      if (sessionArea?.get) {
        const data = await sessionArea.get(AGENT_BUSY_SESSION_KEY);
        const busyState = data?.[AGENT_BUSY_SESSION_KEY];
        if (
          busyState &&
          busyState.busy === true &&
          currentNow - (Number(busyState.updatedAt) || 0) < AGENT_BUSY_TTL_MS
        ) {
          reasons.push("sidepanel");
        }
      }
    } catch {
      /* ignore */
    }
    try {
      if (await checkInboxBusy(chromeRef?.storage?.session, currentNow)) {
        reasons.push("inbox");
      }
    } catch {
      /* ignore */
    }
    return reasons;
  }

  function init() {
    if (!initPromise) {
      initPromise = (async () => {
        const extensionVersion = readManifestVersion(chromeRef);
        const existing = await readSession();
        if (existing && typeof existing === "object" && !existing.reloading) {
          cachedBuildInfo = {
            extensionVersion: String(existing.extensionVersion || extensionVersion),
            gitCommit: String(existing.gitCommit || "dev-local"),
            stampTimestamp: String(existing.stampTimestamp || ""),
          };
          await syncDevReloadAlarm({ chromeRef, defaultEnabled });
          return { initialized: true, wokeFromHibernation: true, session: existing };
        }

        const stamp = await readDevReloadStamp({ chromeRef, fetchImpl });
        const gitCommit = stamp?.gitCommit || "dev-local";
        const stampTimestamp = stamp?.timestamp || "";
        const bootedAt = new Date(now()).toISOString();
        const session = {
          baselineRaw: stamp?.raw ?? ABSENT_STAMP_RAW,
          gitCommit,
          stampTimestamp,
          extensionVersion,
          bootedAt,
        };
        await writeSession(session);
        cachedBuildInfo = { extensionVersion, gitCommit, stampTimestamp };

        console.info(
          `[PageLens] sw.startup v${extensionVersion} (${gitCommit})${stampTimestamp ? ` @ ${stampTimestamp}` : ""}`,
        );
        logDebug("sw.startup", {
          version: extensionVersion,
          gitCommit,
          stampTimestamp,
        });

        if (stamp?.raw) {
          await writeStartupReceipt(chromeRef, {
            extensionVersion,
            gitCommit,
            stampTimestamp,
            bootedAt,
          });
        }

        await syncDevReloadAlarm({ chromeRef, defaultEnabled });
        return { initialized: true, wokeFromHibernation: false, session };
      })();
    }
    return initPromise;
  }

  async function checkOnce() {
    if (reloading) return { action: "reloading" };
    if (checking) return { action: "checking" };
    checking = true;
    try {
      await init();
      const enabled = await isDevAutoReloadEnabled({ chromeRef, defaultEnabled });
      if (!enabled) {
        await clearDevReloadAlarm({ chromeRef });
        return { action: "disabled" };
      }

      const session = (await readSession()) || memorySession;
      if (!session || session.reloading) return { action: "reloading" };

      const stamp = await readDevReloadStamp({ chromeRef, fetchImpl });
      const currentRaw = stamp?.raw ?? ABSENT_STAMP_RAW;
      const baselineRaw = session.baselineRaw ?? ABSENT_STAMP_RAW;
      if (currentRaw === baselineRaw) {
        return { action: "noop", reason: "unchanged", baselineRaw };
      }

      const currentNow = now();
      const reasons = await collectBusyReasons(currentNow);
      const from = session.gitCommit || "dev-local";
      const to = stamp?.gitCommit || "unknown";
      if (reasons.length > 0) {
        console.info(`[PageLens] devReload.deferred ${from} -> ${to} (busy: ${reasons.join(",")})`);
        logDebug("devReload.deferred", { from, to, reasons });
        return { action: "deferred", from, to, reasons };
      }

      reloading = true;
      await writeSession({
        ...session,
        reloading: true,
        reloadToCommit: to,
        reloadedAt: new Date(currentNow).toISOString(),
      });
      console.info(`[PageLens] devReload.reload ${from} -> ${to}`);
      logDebug("devReload.reload", {
        from,
        to,
        stampTimestamp: stamp?.timestamp || "",
      });
      if (typeof chromeRef?.runtime?.reload === "function") {
        chromeRef.runtime.reload();
      }
      return { action: "reload", from, to };
    } finally {
      checking = false;
    }
  }

  function wire() {
    if (listenersWired) return;
    listenersWired = true;
    if (typeof chromeRef?.alarms?.onAlarm?.addListener === "function") {
      chromeRef.alarms.onAlarm.addListener((alarm) => {
        if (alarm?.name !== DEV_RELOAD_ALARM_NAME) return;
        checkOnce().catch(() => {});
      });
    }
    if (typeof chromeRef?.storage?.onChanged?.addListener === "function") {
      chromeRef.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !(DEV_AUTO_RELOAD_STORAGE_KEY in (changes || {}))) return;
        syncDevReloadAlarm({ chromeRef, defaultEnabled }).catch(() => {});
      });
    }
  }

  function install() {
    wire();
    init().catch(() => {});
  }

  return {
    init,
    checkOnce,
    wire,
    install,
    syncAlarm: () => syncDevReloadAlarm({ chromeRef, defaultEnabled }),
  };
}

let defaultController = null;

function ensureDefaultController() {
  if (!defaultController) {
    defaultController = createDevReloadController();
  }
  return defaultController;
}

export function initDevAutoReload() {
  return ensureDefaultController().init();
}

export function checkDevReloadOnce() {
  return ensureDefaultController().checkOnce();
}

export function installDevAutoReload() {
  const ctrl = ensureDefaultController();
  ctrl.install();
  return ctrl;
}

export function resetDevReloadForTests() {
  defaultController = null;
  cachedBuildInfo = {
    extensionVersion: "",
    gitCommit: "",
    stampTimestamp: "",
  };
}

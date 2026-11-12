/**
 * 调试模式单一策略源（Single Source of Truth）、安装形态硬门禁、按需权限管理与存量配置迁移。
 */

import { originPatternFromUrl, requireHostUrl, requireOptionalFeature } from "../optional-permissions.js";

const __PL_PROD_BUILD__ = false;

export const DEBUG_SCHEMA_VERSION = 1;
export const DEBUG_TRACE_LEVELS = Object.freeze(["minimal", "manual", "full"]);

export const DEFAULT_DEBUG_SETTINGS = Object.freeze({
  enabled: false,
  traceLevel: "minimal",
  autoExportRunBundle: false,
  captureFailureScreenshot: false,
  devAutoReload: false,
  writeStartupReceipt: false,
  showLocalMockPreset: false,
});

export function isProdBuild() {
  return __PL_PROD_BUILD__;
}

/**
 * 零权限检测当前扩展安装形态（chrome.management.getSelf 无需声明 management 权限）。
 * - 未打包开发态返回 "development"
 * - Web Store / crx 正常安装返回 "normal"（企业策略 "admin"、侧载 "sideload"、其他 "other"）
 */
export async function detectInstallType({ chromeRef = globalThis.chrome } = {}) {
  if (__PL_PROD_BUILD__) return "normal";
  try {
    const self = await chromeRef?.management?.getSelf?.();
    if (self && typeof self.installType === "string" && self.installType.trim()) {
      return self.installType.trim();
    }
  } catch {
    /* ignore and fall back to manifest inspection */
  }
  try {
    if (chromeRef?.runtime?.getManifest?.()?.update_url) {
      return "normal";
    }
  } catch {
    /* ignore */
  }
  return "development";
}

export async function isDevelopmentInstall(opts = {}) {
  if (__PL_PROD_BUILD__) return false;
  return (await detectInstallType(opts)) === "development";
}

/**
 * 归一化 settings.debug 子对象。
 * 兼容尚未执行异步迁移的旧版配置（仅当 raw.debug 未定义且无 debugSchemaVersion 时映射旧字段）。
 */
export function normalizeDebugSettings(raw = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  if (src.debug && typeof src.debug === "object") {
    const d = src.debug;
    const enabled = d.enabled === true;
    const rawLevel = String(d.traceLevel || "");
    const traceLevel = DEBUG_TRACE_LEVELS.includes(rawLevel)
      ? rawLevel
      : (enabled ? "full" : "minimal");
    return {
      enabled,
      traceLevel: enabled ? (traceLevel === "minimal" ? "manual" : traceLevel) : "minimal",
      autoExportRunBundle: d.autoExportRunBundle === true,
      captureFailureScreenshot: d.captureFailureScreenshot === true,
      devAutoReload: __PL_PROD_BUILD__ ? false : d.devAutoReload === true,
      writeStartupReceipt: __PL_PROD_BUILD__ ? false : d.writeStartupReceipt === true,
      showLocalMockPreset: __PL_PROD_BUILD__ ? false : d.showLocalMockPreset === true,
      ...( !__PL_PROD_BUILD__ && d.allowDevAnchorExport === true ? { allowDevAnchorExport: true } : {} ),
    };
  }

  if (!__PL_PROD_BUILD__ && !(Number(src.debugSchemaVersion) >= DEBUG_SCHEMA_VERSION)) {
    const legacyAutoReload = src?.dev?.autoReload === true || src?.devAutoReload === true;
    const legacyAutoExport =
      src?.diagnostics?.autoExportRunBundle === true || src?.autoExportRunBundle === true;
    if (legacyAutoReload || legacyAutoExport) {
      return {
        enabled: true,
        traceLevel: "full",
        autoExportRunBundle: legacyAutoExport,
        captureFailureScreenshot: legacyAutoExport || legacyAutoReload,
        devAutoReload: legacyAutoReload,
        writeStartupReceipt: legacyAutoReload,
        showLocalMockPreset: true,
      };
    }
  }

  return { ...DEFAULT_DEBUG_SETTINGS };
}

/**
 * 纯函数：根据归一化配置、安装形态与构建宏计算最终生效的调试策略。
 * 任何非 development 安装形态或生产构建一律硬性锁死热重载、本地配置探测与启动回执。
 */
export function resolveEffectiveDebugPolicy(
  settings = {},
  { installType = "normal", prodBuild = __PL_PROD_BUILD__ } = {},
) {
  const isDevInstall = !prodBuild && installType === "development";
  const debug = normalizeDebugSettings(settings);
  const enabled = debug.enabled === true;

  if (!enabled) {
    return Object.freeze({
      enabled: false,
      installType,
      isDevInstall,
      prodBuild: Boolean(prodBuild),
      traceLevel: "minimal",
      canUseDevReload: false,
      canReadLocalSettingsFile: isDevInstall,
      canWriteStartupReceipt: false,
      autoExportRunBundle: false,
      captureFailureScreenshot: false,
      persistDebugLogToSession: false,
      printDebugConsole: false,
      showDebugUi: false,
      showLocalMockPreset: false,
      langfuseEnabled: false,
    });
  }

  const traceLevel = debug.traceLevel === "full" ? "full" : "manual";
  const isFull = traceLevel === "full";

  return Object.freeze({
    enabled: true,
    installType,
    isDevInstall,
    prodBuild: Boolean(prodBuild),
    traceLevel,
    canUseDevReload: isDevInstall && debug.devAutoReload === true,
    canReadLocalSettingsFile: isDevInstall,
    canWriteStartupReceipt: isDevInstall && debug.writeStartupReceipt === true,
    autoExportRunBundle: isFull && debug.autoExportRunBundle === true,
    captureFailureScreenshot: debug.captureFailureScreenshot === true,
    persistDebugLogToSession: isFull,
    printDebugConsole: isFull,
    showDebugUi: true,
    showLocalMockPreset: !prodBuild && debug.showLocalMockPreset === true,
    langfuseEnabled: Boolean(settings?.langfuse?.enabled === true),
  });
}

export async function resolveDebugPolicy({
  settings = null,
  chromeRef = globalThis.chrome,
  prodBuild = __PL_PROD_BUILD__,
} = {}) {
  const installType = await detectInstallType({ chromeRef });
  let resolvedSettings = settings;
  if (!resolvedSettings && chromeRef?.storage?.local?.get) {
    try {
      const got = await chromeRef.storage.local.get("settings");
      resolvedSettings = got?.settings || {};
    } catch {
      resolvedSettings = {};
    }
  }
  return resolveEffectiveDebugPolicy(resolvedSettings || {}, { installType, prodBuild });
}

export async function hasDownloadsPermission({ chromeRef = globalThis.chrome } = {}) {
  const contains = chromeRef?.permissions?.contains;
  if (typeof contains !== "function") {
    // 单元测试或无 permissions API 模拟环境：以 downloads.download 是否存在为准
    return typeof chromeRef?.downloads?.download === "function";
  }
  try {
    return Boolean(await contains.call(chromeRef.permissions, { permissions: ["downloads"] }));
  } catch {
    return false;
  }
}

export async function hasOriginPermission(url, { chromeRef = globalThis.chrome } = {}) {
  const originPattern = originPatternFromUrl(url);
  if (!originPattern) return false;
  const contains = chromeRef?.permissions?.contains;
  if (typeof contains !== "function") return true;
  try {
    return Boolean(await contains.call(chromeRef.permissions, { origins: [originPattern] }));
  } catch {
    return false;
  }
}

/**
 * 在用户手势（click / change）同步调用栈内申请 downloads 可选权限。
 */
export async function requestDownloadsPermissionInGesture({
  chromeRef = globalThis.chrome,
  fallbackRequireFeature = requireOptionalFeature,
} = {}) {
  const api = chromeRef?.permissions;
  if (typeof api?.request === "function") {
    try {
      const ok = await api.request({ permissions: ["downloads"] });
      return {
        granted: Boolean(ok),
        message: ok ? "" : "未授予下载权限，已切换为免权限手动导出模式（L1）。",
      };
    } catch (err) {
      if (typeof fallbackRequireFeature === "function") {
        const deniedMsg = await fallbackRequireFeature("downloads", { permissionsApi: api });
        return { granted: !deniedMsg, message: deniedMsg || "" };
      }
      return {
        granted: false,
        message: `申请下载权限失败：${err?.message || String(err)}`,
      };
    }
  }
  return { granted: true, skipped: true, message: "" };
}

/**
 * 在用户手势内申请 Langfuse 目标服务的 optional_host_permissions。
 */
export async function requestLangfuseHostPermission(
  baseUrl,
  {
    chromeRef = globalThis.chrome,
    fallbackRequireHost = requireHostUrl,
  } = {},
) {
  const originPattern = originPatternFromUrl(baseUrl);
  if (!originPattern) {
    return { granted: false, message: "无效的 Langfuse Host 地址。" };
  }
  const api = chromeRef?.permissions;
  if (typeof api?.request === "function") {
    try {
      const ok = await api.request({ origins: [originPattern] });
      return {
        granted: Boolean(ok),
        originPattern,
        message: ok ? "" : `未授予 ${originPattern} 的网络访问权限。`,
      };
    } catch (err) {
      if (typeof fallbackRequireHost === "function") {
        const deniedMsg = await fallbackRequireHost(baseUrl, { permissionsApi: api });
        return { granted: !deniedMsg, originPattern, message: deniedMsg || "" };
      }
      return {
        granted: false,
        originPattern,
        message: `申请网络权限失败：${err?.message || String(err)}`,
      };
    }
  }
  return { granted: true, skipped: true, originPattern, message: "" };
}

export function collectActiveNonDebugOrigins(settings = {}) {
  const urls = [
    settings?.text?.baseUrl,
    settings?.multimodal?.baseUrl,
    settings?.asr?.baseUrl,
    settings?.tts?.baseUrl,
    settings?.jev?.baseUrl,
    ...(Array.isArray(settings?.textProviders) ? settings.textProviders.map((p) => p?.baseUrl) : []),
  ];
  const out = new Set();
  for (const u of urls) {
    const pat = originPatternFromUrl(u);
    if (pat) out.add(pat);
  }
  return out;
}

/**
 * 关闭调试模式或关闭自动落盘时，自动回收不再使用的 downloads 权限与独享 Langfuse 域名权限。
 * chrome.permissions.remove 无需用户手势。
 */
export async function revokeDebugPermissions({
  chromeRef = globalThis.chrome,
  langfuseUrl = "",
  keepOrigins = new Set(),
  revokeDownloads = true,
} = {}) {
  const api = chromeRef?.permissions;
  const result = { downloadsRemoved: false, originRemoved: false };
  if (typeof api?.remove !== "function") return result;

  if (revokeDownloads) {
    try {
      const hasDl =
        typeof api.contains === "function"
          ? await api.contains({ permissions: ["downloads"] })
          : true;
      if (hasDl) {
        result.downloadsRemoved = Boolean(await api.remove({ permissions: ["downloads"] }));
      }
    } catch {
      /* ignore remove failure */
    }
  }

  if (langfuseUrl) {
    const originPattern = originPatternFromUrl(langfuseUrl);
    const keepSet = keepOrigins instanceof Set ? keepOrigins : new Set(keepOrigins || []);
    if (originPattern && !keepSet.has(originPattern)) {
      try {
        const hasOrigin =
          typeof api.contains === "function"
            ? await api.contains({ origins: [originPattern] })
            : false;
        if (hasOrigin) {
          result.originRemoved = Boolean(await api.remove({ origins: [originPattern] }));
        }
      } catch {
        /* ignore origin remove failure */
      }
    }
  }

  return result;
}

/**
 * 幂等一次性迁移旧版散落配置键（devAutoReloadEnabled / autoExportRunBundle / settings.dev / settings.diagnostics）：
 * - development 解包态：平滑保留已显式开启的开发开关到 settings.debug
 * - normal / admin / sideload 等正式安装态：强制归零 settings.debug.enabled = false，清理残留闹钟与会话日志
 */
export async function migrateLegacyDebugSettings({ chromeRef = globalThis.chrome } = {}) {
  const local = chromeRef?.storage?.local;
  if (!local?.get || !local?.set) return { migrated: false, installType: "normal" };

  const installType = await detectInstallType({ chromeRef });
  const isDevInstall = !__PL_PROD_BUILD__ && installType === "development";
  const legacyRootKeys = ["devAutoReloadEnabled", "autoExportRunBundle"];

  let bag = {};
  try {
    bag = (await local.get(["settings", ...legacyRootKeys])) || {};
  } catch {
    return { migrated: false, installType };
  }

  const rawSettings = bag.settings && typeof bag.settings === "object" ? bag.settings : null;
  const hasRootLegacy = legacyRootKeys.some((k) => k in bag);
  const hasNestedLegacy = Boolean(rawSettings && ("dev" in rawSettings || "diagnostics" in rawSettings));
  const alreadyMigrated = Number(rawSettings?.debugSchemaVersion) >= DEBUG_SCHEMA_VERSION;

  if (alreadyMigrated && !hasRootLegacy && !hasNestedLegacy) {
    if (!isDevInstall && rawSettings?.debug?.enabled) {
      // 非开发安装态仍须清理仅限开发态的子项与残留资源
      if (!__PL_PROD_BUILD__) {
        try {
          await chromeRef?.alarms?.clear?.("pagelens-dev-reload");
        } catch {
          /* ignore */
        }
      }
    }
    return { migrated: false, installType, settings: rawSettings };
  }

  const hadAutoReload =
    bag.devAutoReloadEnabled === true ||
    rawSettings?.dev?.autoReload === true ||
    rawSettings?.devAutoReload === true ||
    rawSettings?.debug?.devAutoReload === true;

  const hadAutoExport =
    bag.autoExportRunBundle === true ||
    rawSettings?.diagnostics?.autoExportRunBundle === true ||
    rawSettings?.autoExportRunBundle === true ||
    rawSettings?.debug?.autoExportRunBundle === true;

  const nextSettings = { ...(rawSettings || {}) };
  delete nextSettings.dev;
  delete nextSettings.diagnostics;
  delete nextSettings.devAutoReload;
  delete nextSettings.autoExportRunBundle;

  if (isDevInstall && (hadAutoReload || hadAutoExport || rawSettings?.debug?.enabled === true)) {
    nextSettings.debug = {
      enabled: true,
      traceLevel: "full",
      autoExportRunBundle: Boolean(hadAutoExport),
      captureFailureScreenshot:
        rawSettings?.debug?.captureFailureScreenshot ?? Boolean(hadAutoExport || hadAutoReload),
      devAutoReload: Boolean(hadAutoReload),
      writeStartupReceipt:
        rawSettings?.debug?.writeStartupReceipt ?? Boolean(hadAutoReload),
      showLocalMockPreset: true,
    };
  } else {
    nextSettings.debug = { ...DEFAULT_DEBUG_SETTINGS };
    if (nextSettings.langfuse && typeof nextSettings.langfuse === "object") {
      nextSettings.langfuse = { ...nextSettings.langfuse, enabled: false };
    }
    if (!__PL_PROD_BUILD__) {
      try {
        await chromeRef?.alarms?.clear?.("pagelens-dev-reload");
      } catch {
        /* ignore */
      }
    }
    try {
      await chromeRef?.storage?.session?.remove?.("pl.debug.log");
    } catch {
      /* ignore */
    }
  }

  nextSettings.debugSchemaVersion = DEBUG_SCHEMA_VERSION;

  try {
    await local.set({ settings: nextSettings });
    if (hasRootLegacy && typeof local.remove === "function") {
      await local.remove(legacyRootKeys);
    }
  } catch {
    return { migrated: false, installType, settings: nextSettings };
  }

  return { migrated: true, installType, settings: nextSettings };
}

/**
 * 分级有界诊断环形日志（L0 / L1 / L2）。
 *
 * - L0 默认态（minimal，enabled=false）：纯内存 RingBuffer(200)，每字段最长 512 字符，
 *   不打印 console.info 刷屏，不读写 chrome.storage.session。
 * - L1 手动诊断态（manual）：纯内存 RingBuffer(1000) + 最近 3 轮严格脱敏运行摘要，
 *   支持零权限（无需 downloads 权限）一键导出脱敏诊断包，仍不写 storage.session。
 * - L2 全量调试态（full）：扩容至 RingBuffer(4000)，开启 console.info 镜像，
 *   并在写入 chrome.storage.session["pl.debug.log"] 前先读取合并，彻底消除 SW 与侧栏双写互冲竞态。
 */

import { sanitizePayload } from "./sanitizer.js";

export const DEBUG_BUILD = "agent-debug-v2";
export const DEBUG_LIMIT_L0 = 200;
export const DEBUG_LIMIT_L1 = 1000;
export const DEBUG_LIMIT = 4000;
export const L1_RUN_SUMMARY_LIMIT = 3;
export const DEBUG_SESSION_STORAGE_KEY = "pl.debug.log";

const MEDIA_EVENT = /^(translation\.|audio\.|playback\.|tts\.|asr\.|transcript\.|interpret\.|semantic\.)/;

const entries = [];
const recentRunSummaries = [];
let sequence = 0;
let persistTimer = 0;
let hydrated = false;
let hydratePromise = null;
const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let runtimeConfig = {
  enabled: false,
  traceLevel: "minimal", // "minimal" | "manual" | "full"
};

function currentLimit() {
  if (!runtimeConfig.enabled || runtimeConfig.traceLevel === "minimal") return DEBUG_LIMIT_L0;
  if (runtimeConfig.traceLevel === "manual") return DEBUG_LIMIT_L1;
  return DEBUG_LIMIT;
}

function currentMaxChars() {
  if (!runtimeConfig.enabled || runtimeConfig.traceLevel === "minimal") return 512;
  if (runtimeConfig.traceLevel === "manual") return 1000;
  return 4000;
}

function isFullMode() {
  return runtimeConfig.enabled === true && runtimeConfig.traceLevel === "full";
}

export function debugId(prefix = "job") {
  return `${session}:${prefix}:${++sequence}`;
}

function safeDetail(detail) {
  return sanitizePayload(detail, {
    profile: "strict",
    maxDepth: 5,
    maxChars: currentMaxChars(),
    maxArray: 30,
    maxKeys: 40,
    maskPii: true,
    redactErrorMessage: true,
    keepYoutubeVideoId: isFullMode(),
    redactedToken: "[redacted]",
  });
}

function category(event) {
  if (/^(agent|hitl|session|prompt|model)\./.test(event)) return "agent";
  if (MEDIA_EVENT.test(event)) return "media";
  return "app";
}

function evictToLimit(limit = currentLimit()) {
  while (entries.length > limit) {
    const noisy = entries.findIndex((e) => e.cat === "media" || MEDIA_EVENT.test(e.event));
    if (noisy >= 0) entries.splice(noisy, 1);
    else entries.shift();
  }
}

function entryKey(e) {
  return `${e?.time || ""}|${e?.session || ""}|${e?.event || ""}|${e?.seq ?? ""}`;
}

function mergeIncomingEntries(incoming = []) {
  if (!Array.isArray(incoming) || !incoming.length) return;
  const seen = new Set(entries.map(entryKey));
  for (const e of incoming) {
    if (!e || typeof e !== "object") continue;
    const k = entryKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    entries.push(e);
  }
  entries.sort(
    (a, b) =>
      String(a.time || "").localeCompare(String(b.time || "")) ||
      (Number(a.seq) || 0) - (Number(b.seq) || 0),
  );
  evictToLimit();
}

function canStore(chromeRef = globalThis.chrome) {
  return Boolean(chromeRef?.storage?.session?.get && chromeRef?.storage?.session?.set);
}

export function configureDebugLog({
  enabled = false,
  traceLevel = "minimal",
  chromeRef = globalThis.chrome,
} = {}) {
  const nextEnabled = Boolean(enabled);
  const nextLevel = nextEnabled
    ? (traceLevel === "full" ? "full" : "manual")
    : "minimal";

  runtimeConfig = {
    enabled: nextEnabled,
    traceLevel: nextLevel,
  };
  evictToLimit();

  if (!isFullMode()) {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = 0;
    }
    if (chromeRef?.storage?.session?.remove) {
      Promise.resolve(chromeRef.storage.session.remove(DEBUG_SESSION_STORAGE_KEY)).catch(() => {});
    }
  } else {
    hydrateDebugLog({ chromeRef }).catch(() => {});
  }
  return { ...runtimeConfig, limit: currentLimit() };
}

export function getDebugLogConfig() {
  return { ...runtimeConfig, limit: currentLimit() };
}

export async function clearDebugLogSession({ chromeRef = globalThis.chrome } = {}) {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = 0;
  }
  try {
    await chromeRef?.storage?.session?.remove?.(DEBUG_SESSION_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export async function hydrateDebugLog({ chromeRef = globalThis.chrome } = {}) {
  if (!isFullMode()) return;
  if (hydrated) return;
  if (hydratePromise) return hydratePromise;
  if (!canStore(chromeRef)) {
    hydrated = true;
    return;
  }
  hydratePromise = (async () => {
    try {
      const data = await chromeRef.storage.session.get(DEBUG_SESSION_STORAGE_KEY);
      const stored = data?.[DEBUG_SESSION_STORAGE_KEY];
      mergeIncomingEntries(stored?.entries);
    } catch {
      /* diagnostics must never throw */
    } finally {
      hydrated = true;
      hydratePromise = null;
    }
  })();
  return hydratePromise;
}

async function persistNow({ chromeRef = globalThis.chrome } = {}) {
  if (!isFullMode() || !canStore(chromeRef)) return;
  try {
    // 写入前先合并其他上下文（如 SW vs Sidepanel）写入的日志，防止整包覆盖竞态
    const existing = await chromeRef.storage.session.get(DEBUG_SESSION_STORAGE_KEY);
    mergeIncomingEntries(existing?.[DEBUG_SESSION_STORAGE_KEY]?.entries);
    await chromeRef.storage.session.set({
      [DEBUG_SESSION_STORAGE_KEY]: {
        build: DEBUG_BUILD,
        session,
        updatedAt: new Date().toISOString(),
        entries: entries.slice(-DEBUG_LIMIT),
      },
    });
  } catch {
    /* ignore quota / missing session store */
  }
}

function schedulePersist() {
  if (!isFullMode() || !canStore() || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    persistNow();
  }, 400);
}

export function debugLog(event, detail = {}) {
  try {
    const sanitized = safeDetail(detail);
    const entry = {
      time: new Date().toISOString(),
      session,
      event: String(event || "unknown"),
      cat: category(event),
      seq: ++sequence,
      ...(sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
        ? sanitized
        : { value: sanitized }),
    };
    entries.push(entry);
    evictToLimit();
    if (isFullMode()) {
      console.info("[PageLens debug]", JSON.stringify(entry));
      hydrateDebugLog();
      schedulePersist();
    }
  } catch {
    /* Diagnostics must never stop the app. */
  }
}

function snapshot() {
  const counts = {};
  for (const e of entries) counts[e.event] = (counts[e.event] || 0) + 1;
  return JSON.stringify(
    {
      build: DEBUG_BUILD,
      session,
      level: runtimeConfig.traceLevel,
      debugEnabled: runtimeConfig.enabled,
      exportedAt: new Date().toISOString(),
      limit: currentLimit(),
      persisted: isFullMode() && canStore(),
      counts,
      entries,
    },
    null,
    2,
  );
}

export function exportDebugLog() {
  return snapshot();
}

export async function exportDebugLogFresh({ chromeRef = globalThis.chrome } = {}) {
  if (isFullMode()) {
    await hydrateDebugLog({ chromeRef });
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = 0;
    }
    await persistNow({ chromeRef });
  }
  return snapshot();
}

/**
 * 记录最近 3 轮严格脱敏的运行摘要（供 L1 零权限手动诊断包使用，不含截图与网页 DOM 正文）。
 */
export function recordL1RunSummary(rawSummary = {}) {
  try {
    const cleaned = sanitizePayload(rawSummary, {
      profile: "strict",
      maxDepth: 5,
      maxChars: 300,
      maxArray: 25,
      maxKeys: 30,
      maskPii: true,
    });
    recentRunSummaries.push({
      recordedAt: new Date().toISOString(),
      ...(cleaned && typeof cleaned === "object" ? cleaned : {}),
    });
    while (recentRunSummaries.length > L1_RUN_SUMMARY_LIMIT) {
      recentRunSummaries.shift();
    }
  } catch {
    /* ignore */
  }
}

export function exportL1DiagnosticBundle({
  extensionVersion = "0.0.0",
  sessionMeta = null,
} = {}) {
  const counts = {};
  for (const e of entries) counts[e.event] = (counts[e.event] || 0) + 1;
  const payload = {
    schema: "pagelens-diagnostic-l1",
    build: DEBUG_BUILD,
    extensionVersion: String(extensionVersion || "0.0.0"),
    exportedAt: new Date().toISOString(),
    traceLevel: runtimeConfig.traceLevel,
    sanitizationProfile: "strict",
    note: "严格脱敏诊断包（已剥离 URL 参数/锚点、凭据、内联截图与长正文，无需 downloads 权限）",
    session: sessionMeta
      ? sanitizePayload(sessionMeta, { profile: "strict", maxChars: 200, maskPii: true })
      : null,
    recentRuns: [...recentRunSummaries],
    logSummary: {
      limit: currentLimit(),
      entryCount: entries.length,
      counts,
    },
    entries: entries.map((e) =>
      sanitizePayload(e, { profile: "strict", maxChars: 500, maskPii: true }),
    ),
  };
  return JSON.stringify(payload, null, 2);
}

export function resetDebugLogForTests() {
  entries.length = 0;
  recentRunSummaries.length = 0;
  sequence = 0;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = 0;
  }
  hydrated = false;
  hydratePromise = null;
  runtimeConfig = {
    enabled: false,
    traceLevel: "minimal",
  };
}

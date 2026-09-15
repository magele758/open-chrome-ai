// Bounded diagnostic log. Memory + chrome.storage.session so export survives
// sidepanel reloads in the same Chrome session. No credentials or audio bodies.

export const DEBUG_BUILD = "agent-debug-v1";
export const DEBUG_LIMIT = 1200;
const STORAGE_KEY = "pl.debug.log";
const MEDIA_EVENT = /^(translation\.|audio\.|playback\.|tts\.|asr\.|transcript\.|interpret\.|semantic\.)/;

const entries = [];
let sequence = 0;
let persistTimer = 0;
let hydrated = false;
let hydratePromise = null;
const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function debugId(prefix = "job") {
  return `${session}:${prefix}:${++sequence}`;
}

function safe(value, key = "", depth = 0) {
  if (/api.?key|authorization|cookie|password|secret|token|headers|blob|buffer|base64/i.test(key)) return "[redacted]";
  if (depth > 5) return "[depth limit]";
  if (typeof value === "string") {
    const text = value.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
    const cleaned = text.replace(/https?:\/\/[^\s"<>]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        const video = /(^|\.)youtube\.com$/.test(url.hostname) ? url.searchParams.get("v") : null;
        return `${url.origin}${url.pathname}${video ? "?v=" + encodeURIComponent(video) : ""}`;
      } catch {
        return "[url]";
      }
    });
    return cleaned.length > 4000 ? cleaned.slice(0, 4000) + "…[truncated]" : cleaned;
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((v) => safe(v, "", depth + 1));
  if (value instanceof Error) return { name: value.name };
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([k, v]) => [k, safe(v, k, depth + 1)]));
  }
  return String(value);
}

function category(event) {
  if (/^(agent|hitl|session|prompt|model)\./.test(event)) return "agent";
  if (MEDIA_EVENT.test(event)) return "media";
  return "app";
}

function evict() {
  while (entries.length > DEBUG_LIMIT) {
    const noisy = entries.findIndex((e) => e.cat === "media" || MEDIA_EVENT.test(e.event));
    if (noisy >= 0) entries.splice(noisy, 1);
    else entries.shift();
  }
}

function snapshot() {
  const counts = {};
  for (const e of entries) counts[e.event] = (counts[e.event] || 0) + 1;
  return JSON.stringify({
    build: DEBUG_BUILD,
    session,
    exportedAt: new Date().toISOString(),
    limit: DEBUG_LIMIT,
    persisted: Boolean(typeof chrome !== "undefined" && chrome.storage?.session),
    counts,
    entries,
  }, null, 2);
}

function canStore() {
  return typeof chrome !== "undefined" && Boolean(chrome.storage?.session?.get);
}

export async function hydrateDebugLog() {
  if (hydrated) return;
  if (hydratePromise) return hydratePromise;
  if (!canStore()) {
    hydrated = true;
    return;
  }
  hydratePromise = (async () => {
    try {
      const data = await chrome.storage.session.get(STORAGE_KEY);
      const stored = data?.[STORAGE_KEY];
      const incoming = Array.isArray(stored?.entries) ? stored.entries : [];
      if (!incoming.length) return;
      const seen = new Set(entries.map((e) => `${e.time}|${e.event}|${e.seq ?? ""}`));
      for (const e of incoming) {
        if (!e || typeof e !== "object") continue;
        const k = `${e.time}|${e.event}|${e.seq ?? ""}`;
        if (seen.has(k)) continue;
        seen.add(k);
        entries.push(e);
      }
      entries.sort((a, b) => String(a.time).localeCompare(String(b.time)) || (Number(a.seq) || 0) - (Number(b.seq) || 0));
      evict();
    } catch {
      /* diagnostics must never throw */
    } finally {
      hydrated = true;
    }
  })();
  return hydratePromise;
}

async function persistNow() {
  if (!canStore()) return;
  try {
    await chrome.storage.session.set({
      [STORAGE_KEY]: {
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
  if (!canStore() || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    persistNow();
  }, 400);
}

export function debugLog(event, detail = {}) {
  try {
    const entry = {
      time: new Date().toISOString(),
      event: String(event || "unknown"),
      cat: category(event),
      seq: ++sequence,
      ...safe(detail),
    };
    entries.push(entry);
    evict();
    console.info("[PageLens debug]", JSON.stringify(entry));
    hydrateDebugLog();
    schedulePersist();
  } catch { /* Diagnostics must never stop the app. */ }
}

export function exportDebugLog() {
  return snapshot();
}

export async function exportDebugLogFresh() {
  await hydrateDebugLog();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = 0;
  }
  await persistNow();
  return snapshot();
}

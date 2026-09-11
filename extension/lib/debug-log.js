// Local, bounded diagnostic log. No persistence, requests, credentials or audio bodies.
export const DEBUG_BUILD = 'audio-only-debug-1';
const LIMIT = 600;
const entries = [];
let sequence = 0;
const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function debugId(prefix = 'job') {
  return `${session}:${prefix}:${++sequence}`;
}

function safe(value, key = '', depth = 0) {
  if (/api.?key|authorization|cookie|password|secret|token|headers|blob|buffer|base64/i.test(key)) return '[redacted]';
  if (depth > 5) return '[depth limit]';
  if (typeof value === 'string') {
    const text = value.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
    // Do not retain signed media URLs or credentials embedded in endpoint URLs.
    const cleaned = text.replace(/https?:\/\/[^\s"<>]+/gi, raw => {
      try {
        const url = new URL(raw);
        const video = /(^|\.)youtube\.com$/.test(url.hostname) ? url.searchParams.get("v") : null;
        return `${url.origin}${url.pathname}${video ? "?v=" + encodeURIComponent(video) : ""}`;
      } catch { return '[url]'; }
    });
    return cleaned.length > 4000 ? cleaned.slice(0, 4000) + '…[truncated]' : cleaned;
  }
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 30).map(v => safe(v, '', depth + 1));
  if (value instanceof Error) return { name: value.name }; // Server errors may echo request secrets.
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40).map(([k, v]) => [k, safe(v, k, depth + 1)]));
  return String(value);
}

export function debugLog(event, detail = {}) {
  try {
    const entry = { time: new Date().toISOString(), event, ...safe(detail) };
    entries.push(entry);
    if (entries.length > LIMIT) entries.shift();
    console.info('[PageLens debug]', JSON.stringify(entry));
  } catch { /* Diagnostics must never stop transcription. */ }
}

export function exportDebugLog() {
  return JSON.stringify({ build: DEBUG_BUILD, session, exportedAt: new Date().toISOString(), limit: LIMIT, entries }, null, 2);
}

/** Persistent activity log + toolbar badge for external-agent inbox jobs. No job payloads are stored. */

export const ACTIVITY_KEY = "agentInboxActivity";
const MAX_ENTRIES = 50;
const BADGE_CLEAR_MS = 8000;

let badgeTimer = null;

function setBadge(text, color) {
  try {
    chrome.action?.setBadgeText?.({ text });
    if (color) chrome.action?.setBadgeBackgroundColor?.({ color });
  } catch {
    /* ignore */
  }
}

export function describeJob(job) {
  const action = String(job?.action || "").trim() || "(empty)";
  const tool = action === "bridge_call" ? String(job?.request?.tool || "") : "";
  return { id: String(job?.id || ""), action, tool };
}

export async function readActivity() {
  const data = await chrome.storage.local.get(ACTIVITY_KEY);
  return Array.isArray(data?.[ACTIVITY_KEY]) ? data[ACTIVITY_KEY] : [];
}

export async function clearActivity() {
  await chrome.storage.local.remove(ACTIVITY_KEY);
}

async function appendActivity(entry) {
  const list = await readActivity();
  list.unshift(entry);
  await chrome.storage.local.set({ [ACTIVITY_KEY]: list.slice(0, MAX_ENTRIES) });
}

export function markJobStarted() {
  clearTimeout(badgeTimer);
  setBadge("...", "#2563eb");
}

export async function recordJobFinished(job, result, startedAt) {
  const ok = result?.ok === true;
  const info = describeJob(job);
  const rawError = result?.error;
  const error = ok
    ? ""
    : String(typeof rawError === "string" ? rawError : rawError?.message || rawError?.code || "failed").slice(0, 300);
  const entry = {
    ...info,
    ok,
    error,
    startedAt: new Date(startedAt).toISOString(),
    ms: Date.now() - startedAt,
  };
  try {
    await appendActivity(entry);
  } catch {
    /* activity logging must never break job handling */
  }
  setBadge(ok ? "OK" : "ERR", ok ? "#16a34a" : "#dc2626");
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => setBadge(""), BADGE_CLEAR_MS);
}

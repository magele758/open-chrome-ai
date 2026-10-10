/**
 * Inbox action `agent_prompt`: hand a natural-language task to the side panel's LLM agent.
 * The agent loop lives in the side panel page, so the panel must be open; the SW only
 * dispatches the prompt and later receives `pl.agentPrompt.done`. Run state is kept in
 * storage.session so a recycled SW can still finish or time out the job.
 */

import { loadSettings } from "../storage.js";

const ACTIVE_KEY = "agentPromptActive";
const DEFAULT_TIMEOUT_MS = 180000;
const MIN_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 600000;
const PANEL_WAIT_MS = 6000;
const TAB_LOAD_WAIT_MS = 15000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function failure(code, message, extra = {}) {
  return { ok: false, errorCode: code, error: message, ...extra };
}

async function getActive() {
  const data = await chrome.storage.session.get(ACTIVE_KEY);
  return data?.[ACTIVE_KEY] || null;
}

async function setActive(value) {
  if (value) await chrome.storage.session.set({ [ACTIVE_KEY]: value });
  else await chrome.storage.session.remove(ACTIVE_KEY);
}

async function sendToPanel(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return null;
  }
}

async function pingPanel() {
  const res = await sendToPanel({ type: "pl.agentPrompt.ping" });
  return res?.ok ? res : null;
}

async function ensurePanel() {
  let pong = await pingPanel();
  if (pong) return pong;
  // sidePanel.open normally needs a user gesture; best effort only.
  try {
    const win = await chrome.windows.getLastFocused();
    await chrome.sidePanel.open({ windowId: win.id });
  } catch {
    /* expected without a user gesture */
  }
  const deadline = Date.now() + PANEL_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(500);
    pong = await pingPanel();
    if (pong) return pong;
  }
  return null;
}

async function waitTabComplete(tabId) {
  const deadline = Date.now() + TAB_LOAD_WAIT_MS;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.status === "complete") return;
    await sleep(300);
  }
}

/** Returns a failure object, or null when the requested tab is now active (or none was requested). */
async function focusTarget(job, windowId) {
  const wantsTab = Number.isInteger(job.tabId) || job.tabUrlIncludes;
  if (!wantsTab) return null;
  let tab = null;
  if (Number.isInteger(job.tabId)) {
    tab = await chrome.tabs.get(job.tabId).catch(() => null);
  } else {
    const needle = String(job.tabUrlIncludes);
    const tabs = await chrome.tabs.query({ windowId });
    tab = tabs.find((t) => String(t.url || "").includes(needle)) || null;
    if (!tab && job.url) {
      tab = await chrome.tabs.create({ windowId, url: String(job.url), active: true });
      await waitTabComplete(tab.id);
    }
  }
  if (!tab) return failure("TAB_NOT_FOUND", "没有找到匹配的标签页（需与侧栏在同一窗口）");
  if (tab.windowId !== windowId) {
    return failure("WRONG_WINDOW", "目标标签页与已打开的侧栏不在同一窗口");
  }
  await chrome.tabs.update(tab.id, { active: true });
  return null;
}

/**
 * Start a job. Resolves to one of:
 *   { queued: true }  another agent_prompt is running; leave the job in the inbox
 *   { done: result }  failed before the agent started; write this result
 *   { started: true } the panel accepted the prompt; completion arrives via message
 */
export async function startAgentPrompt(job, jobId) {
  const prompt = String(job?.prompt || "").trim();
  if (!prompt) return { done: failure("BAD_JOB", "agent_prompt 需要非空 prompt") };

  const settings = await loadSettings();
  if (settings.agentPromptEnabled === false) {
    return { done: failure("DISABLED", "agentPromptEnabled 已关闭") };
  }

  const active = await getActive();
  if (active) return { queued: true };

  const pong = await ensurePanel();
  if (!pong) {
    return {
      done: failure(
        "SIDEPANEL_NOT_OPEN",
        "侧栏未打开，扩展无法在后台拉起侧栏。",
        { hint: "请先点一次扩展图标打开侧栏并保持打开。" },
      ),
    };
  }
  if (pong.busy) {
    return { done: failure("AGENT_BUSY", "侧栏 Agent 正在执行其他任务（可能是用户手动对话）") };
  }

  const focusError = await focusTarget(job, pong.windowId);
  if (focusError) return { done: focusError };

  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(MIN_TIMEOUT_MS, Number(job.timeoutMs) || DEFAULT_TIMEOUT_MS),
  );
  const startedAt = Date.now();
  const accepted = await sendToPanel({ type: "pl.agentPrompt.run", id: jobId, prompt });
  if (!accepted?.ok) {
    return {
      done: failure(accepted?.code || "RUN_REJECTED", accepted?.error || "侧栏没有接受该任务"),
    };
  }
  await setActive({
    id: jobId,
    action: "agent_prompt",
    startedAt,
    deadline: startedAt + timeoutMs,
    metadata: job.metadata ?? null,
  });
  return { started: true };
}

function buildOutput(active, payload) {
  const now = Date.now();
  const out = {
    id: active.id,
    ok: payload.ok === true,
    finishedAt: new Date(now).toISOString(),
    action: "agent_prompt",
    result: payload.result ?? null,
    metadata: active.metadata ?? null,
    meta: { action: "agent_prompt", ms: now - active.startedAt },
  };
  if (!out.ok) {
    out.error = payload.error || "failed";
    out.errorCode = payload.errorCode || "AGENT_FAILED";
  }
  return out;
}

/** Match a `pl.agentPrompt.done` message to the active run; returns the outbox payload or null. */
export async function takeCompletion(msg) {
  const active = await getActive();
  if (!active || active.id !== msg?.id) return null;
  await setActive(null);
  return buildOutput(active, {
    ok: msg.ok === true,
    error: msg.error,
    errorCode: msg.code,
    result: { summary: String(msg.summary || ""), steps: Array.isArray(msg.steps) ? msg.steps : [] },
  });
}

async function waitPanelIdle(maxMs = 3000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const pong = await pingPanel();
    if (!pong || !pong.busy) return;
    await sleep(200);
  }
}

/**
 * Inbox action `agent_cancel`: stop the running agent_prompt (optionally only if its id equals targetId).
 * Returns { result, output? }: `result` answers the cancel job; `output` is the cancelled run's outbox payload.
 */
export async function cancelAgentPrompt(targetId) {
  const active = await getActive();
  if (!active) {
    return { result: { ok: true, cancelled: false, note: "没有正在执行的 agent_prompt" } };
  }
  const want = targetId ? String(targetId) : "";
  if (want && active.id !== want) {
    return {
      result: {
        ok: false,
        cancelled: false,
        errorCode: "ID_MISMATCH",
        error: `当前运行的是 ${active.id}，不是 ${want}`,
        activeId: active.id,
      },
    };
  }
  await setActive(null);
  await sendToPanel({ type: "pl.agentPrompt.cancel", id: active.id });
  await waitPanelIdle();
  return {
    result: { ok: true, cancelled: true, id: active.id },
    output: buildOutput(active, {
      ok: false,
      errorCode: "CANCELLED",
      error: "已被外部 agent 取消",
      result: null,
    }),
  };
}

/** If the active run passed its deadline, cancel it in the panel and return a timeout payload. */
export async function takeExpired() {
  const active = await getActive();
  if (!active || Date.now() < active.deadline) return null;
  await setActive(null);
  await sendToPanel({ type: "pl.agentPrompt.cancel", id: active.id });
  return buildOutput(active, {
    ok: false,
    errorCode: "TIMEOUT",
    error: `Agent 执行超过 ${Math.round((active.deadline - active.startedAt) / 1000)}s，已取消`,
    result: null,
  });
}
/**
 * Inbox action `agent_prompt`: hand a natural-language task to PageLens' LLM agent.
 *
 * Two runtimes:
 *  - panel: the side panel's own session (same path as a user typing). Needs the panel open;
 *    the SW only dispatches the prompt and later receives `pl.agentPrompt.done`.
 *  - headless: the Service Worker delegate runner (agent/delegate.js). No side panel UI needed,
 *    but runs unattended under the trust rules (capsule / origin allowlist / approval queue).
 *
 * `runtime: "auto"` (default) uses the panel when it answers a ping and otherwise falls back to
 * headless: Chrome refuses `chrome.sidePanel.open()` without a user gesture, so the SW can never
 * open the panel by itself. Run state is kept in storage.session so a recycled SW can still
 * finish or time out the job.
 */

import { isUrlAllowed } from "../bridge/policy.js";
import { loadSettings } from "../storage.js";
import { TASK_STATUS, getDelegateManager } from "./delegate.js";

const ACTIVE_KEY = "agentPromptActive";
const DEFAULT_TIMEOUT_MS = 180000;
const MIN_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 600000;
const PANEL_WAIT_MS = 6000;
const TAB_LOAD_WAIT_MS = 15000;
const RUNTIMES = Object.freeze(["auto", "panel", "headless"]);

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

/**
 * Activates the requested tab (if any). `windowId` pins the lookup to the side panel's window;
 * headless runs pass null and may use any window.
 * Returns { error } on failure, otherwise { tab } (tab is null when no tab was requested).
 */
async function focusTarget(job, windowId) {
  const wantsTab = Number.isInteger(job.tabId) || job.tabUrlIncludes;
  if (!wantsTab) return { tab: null };
  const scoped = windowId != null;
  let tab = null;
  if (Number.isInteger(job.tabId)) {
    tab = await chrome.tabs.get(job.tabId).catch(() => null);
  } else {
    const needle = String(job.tabUrlIncludes);
    const tabs = await chrome.tabs.query(scoped ? { windowId } : {});
    tab = tabs.find((t) => String(t.url || "").includes(needle)) || null;
    if (!tab && job.url) {
      tab = await chrome.tabs.create({ ...(scoped ? { windowId } : {}), url: String(job.url), active: true });
      await waitTabComplete(tab.id);
    }
  }
  if (!tab) {
    return {
      error: failure(
        "TAB_NOT_FOUND",
        scoped ? "没有找到匹配的标签页（需与侧栏在同一窗口）" : "没有找到匹配的标签页",
      ),
    };
  }
  if (scoped && tab.windowId !== windowId) {
    return { error: failure("WRONG_WINDOW", "目标标签页与已打开的侧栏不在同一窗口") };
  }
  await chrome.tabs.update(tab.id, { active: true });
  return { tab };
}

function clampTimeout(job) {
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Number(job.timeoutMs) || DEFAULT_TIMEOUT_MS));
}

/** Session handed to the delegate runner: token jobs use the token's origins, others the bridge allowlist. */
function headlessSession(jobId, settings, auth) {
  const record = auth?.record;
  const origins = record ? record.origins || [] : settings.agentBridgeOrigins || [];
  return {
    agentName: record?.name || "inbox",
    sessionId: `inbox:${jobId}`,
    tokenId: record?.id || "",
    egress: [...origins, ...(record?.egress || [])],
    skipIrreversible: record?.skipIrreversible === true,
    allowUrl: (url) => isUrlAllowed(url, origins),
  };
}

async function startHeadless(job, jobId, prompt, settings, auth) {
  const manager = getDelegateManager();
  if (!manager) {
    return {
      done: failure("HEADLESS_UNAVAILABLE", "后台 Agent 运行环境未就绪（Service Worker 尚未安装委托模块）", {
        hint: "重载扩展后重试；或点一次扩展图标打开侧栏。",
      }),
    };
  }
  const focus = await focusTarget(job, null);
  if (focus.error) return { done: focus.error };

  const timeoutMs = clampTimeout(job);
  const startedAt = Date.now();
  let task;
  try {
    task = await manager.start({
      prompt,
      capsule: job.capsule,
      tabId: focus.tab?.id ?? null,
      sourceUrl: focus.tab?.url || "",
      maxSteps: job.maxSteps,
      model: job.model,
      session: headlessSession(jobId, settings, auth),
    });
  } catch (err) {
    if (err?.code === "BUSY") return { queued: true };
    const code = err?.code === "BAD_ARGS" ? "BAD_JOB" : err?.code || "HEADLESS_FAILED";
    return { done: failure(code, String(err?.message || err)) };
  }
  await setActive({
    id: jobId,
    action: "agent_prompt",
    runtime: "headless",
    taskId: task.id,
    startedAt,
    deadline: startedAt + timeoutMs,
    metadata: job.metadata ?? null,
  });
  return { started: true, runtime: "headless" };
}

/**
 * Start a job. Resolves to one of:
 *   { queued: true }  another agent_prompt is running; leave the job in the inbox
 *   { done: result }  failed before the agent started; write this result
 *   { started: true, runtime } the run began; completion arrives via panel message (panel)
 *                     or is collected by settleHeadless() (headless)
 */
export async function startAgentPrompt(job, jobId, { auth = null } = {}) {
  const prompt = String(job?.prompt || "").trim();
  if (!prompt) return { done: failure("BAD_JOB", "agent_prompt 需要非空 prompt") };

  const runtime = job?.runtime == null ? "auto" : String(job.runtime);
  if (!RUNTIMES.includes(runtime)) {
    return { done: failure("BAD_JOB", `runtime 只能是 ${RUNTIMES.join(" / ")}`) };
  }

  const settings = await loadSettings();
  if (settings.agentPromptEnabled === false) {
    return { done: failure("DISABLED", "agentPromptEnabled 已关闭") };
  }

  const active = await getActive();
  if (active) return { queued: true };

  if (runtime === "headless") return startHeadless(job, jobId, prompt, settings, auth);

  // Only an explicit `panel` run waits for a panel to appear; sidePanel.open() cannot succeed
  // without a user gesture, so `auto` just pings once and falls back.
  const pong = runtime === "panel" ? await ensurePanel() : await pingPanel();
  if (!pong) {
    if (runtime === "auto") return startHeadless(job, jobId, prompt, settings, auth);
    return {
      done: failure(
        "SIDEPANEL_NOT_OPEN",
        "侧栏未打开，扩展无法在后台拉起侧栏。",
        { hint: 'Chrome 不允许无手势打开侧栏。去掉 runtime:"panel"（或设为 "auto" / "headless"）可在后台运行；或先点一次扩展图标打开侧栏。' },
      ),
    };
  }
  if (pong.busy) {
    return { done: failure("AGENT_BUSY", "侧栏 Agent 正在执行其他任务（可能是用户手动对话）") };
  }

  const focus = await focusTarget(job, pong.windowId);
  if (focus.error) return { done: focus.error };

  const timeoutMs = clampTimeout(job);
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
    runtime: "panel",
    startedAt,
    deadline: startedAt + timeoutMs,
    metadata: job.metadata ?? null,
  });
  return { started: true, runtime: "panel" };
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
  if (!active || active.runtime === "headless" || active.id !== msg?.id) return null;
  await setActive(null);
  return buildOutput(active, {
    ok: msg.ok === true,
    error: msg.error,
    errorCode: msg.code,
    result: { summary: String(msg.summary || ""), steps: Array.isArray(msg.steps) ? msg.steps : [] },
  });
}

function headlessSteps(task) {
  return (task.steps || [])
    .filter((st) => st.kind === "tool")
    .map((st) => ({ name: st.name, ok: st.ok !== false, preview: String(st.summary || "").slice(0, 200) }));
}

function headlessPayload(task) {
  const result = {
    summary: String(task.answer || ""),
    steps: headlessSteps(task),
    runtime: "headless",
    taskId: task.id,
  };
  if (task.pending?.length) {
    result.pending = task.pending.map(({ pendingId, toolName, reason }) => ({ pendingId, toolName, reason }));
  }
  if (task.denied?.length) result.denied = task.denied;
  switch (task.status) {
    case TASK_STATUS.DONE:
      return { ok: true, result };
    case TASK_STATUS.NEEDS_APPROVAL:
      return {
        ok: false,
        errorCode: "CONFIRMATION_REQUIRED",
        error: "有不可逆操作等待用户批准（侧栏待批准队列）；批准后重新投递同一任务",
        result,
      };
    case TASK_STATUS.CANCELLED:
      return { ok: false, errorCode: "CANCELLED", error: "任务被取消", result };
    case TASK_STATUS.FAILED:
      return {
        ok: false,
        errorCode: task.error?.code || "AGENT_FAILED",
        error: task.error?.message || "failed",
        result,
      };
    case TASK_STATUS.RUNNING:
      return null;
    default:
      return { ok: false, errorCode: "AGENT_FAILED", error: `未知任务状态 ${task.status}`, result };
  }
}

/**
 * If the active run is headless and its delegate task has finished, clear it and return the outbox
 * payload; otherwise null. Called from the delegate FINISHED event and from every inbox poll (the poll
 * also covers a Service Worker that was recycled before the event fired).
 */
let settling = false;

export async function settleHeadless() {
  if (settling) return null;
  settling = true;
  try {
    return await settleHeadlessOnce();
  } finally {
    settling = false;
  }
}

async function settleHeadlessOnce() {
  const active = await getActive();
  if (!active || active.runtime !== "headless") return null;
  const manager = getDelegateManager();
  let payload;
  try {
    const task = manager ? await manager.status(active.taskId) : null;
    payload = task ? headlessPayload(task) : { ok: false, errorCode: "AGENT_FAILED", error: "后台任务记录丢失" };
  } catch (err) {
    payload = { ok: false, errorCode: err?.code || "AGENT_FAILED", error: String(err?.message || err) };
  }
  if (!payload) return null;
  await setActive(null);
  return buildOutput(active, payload);
}

async function stopRun(active) {
  if (active.runtime === "headless") {
    await getDelegateManager()?.cancel(active.taskId).catch(() => {});
  } else {
    await sendToPanel({ type: "pl.agentPrompt.cancel", id: active.id });
  }
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
  await stopRun(active);
  if (active.runtime !== "headless") await waitPanelIdle();
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
  await stopRun(active);
  return buildOutput(active, {
    ok: false,
    errorCode: "TIMEOUT",
    error: `Agent 执行超过 ${Math.round((active.deadline - active.startedAt) / 1000)}s，已取消`,
    result: null,
  });
}
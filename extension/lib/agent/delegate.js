/**
 * 委托任务（P5）：外部 Agent 把高层任务交给扩展内 LLM Agent，在 Service Worker 里跑（脱离侧栏页）。
 *
 * - 胶囊只来自委托人：显式 capsule（normalizeCapsule）或从 prompt 抽取（extractCapsule），任务开始后冻结；
 *   工具结果 / 页面内容永远不会并入胶囊。
 * - 每个工具调用走 decideToolCall（attended:false）：胶囊内自动执行；胶囊外有副作用 → NEEDS_WIDER_AUTHORIZATION；
 *   不可逆清单 → 进待批准队列（CONFIRMATION_REQUIRED + pendingId），任务结束时状态为 needs_approval。
 * - 任务状态持久化在 chrome.storage.session（SW 重启后仍可查询；正在跑的任务标为中断）。
 * - 进度事件：onAgentTaskEvent(listener)，P3 的事件系统可直接订阅。
 *
 * 环境相关部分（工具、模型、标签 URL）由 createRun 注入；SW 里的实现见 delegate-sw.js。
 */

import { createKernelAgentLoop } from "./loop-kernel.js";
import { resolveHitlTargetUrl } from "./tools.js";
import { describeCapsule, extractCapsule, normalizeCapsule } from "./trust/capsule.js";
import { CONFIRMATION_REQUIRED, NEEDS_WIDER_AUTHORIZATION, decideToolCall, formatTrustDenial } from "./trust/decide.js";
import { createTaintState, ingestData, markHighTaint, taintLevel } from "./trust/taint.js";
import { withUntrustedOutput } from "../untrusted.js";

export const DELEGATE_STORAGE_KEY = "agentDelegateTasks";

export const TASK_STATUS = Object.freeze({
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
  NEEDS_APPROVAL: "needs_approval",
  CANCELLED: "cancelled",
});

export const AGENT_TASK_EVENTS = Object.freeze({
  STARTED: "agent_task.started",
  STEP: "agent_task.step",
  APPROVAL: "agent_task.approval",
  FINISHED: "agent_task.finished",
});

export const DEFAULT_MAX_STEPS = 12;
export const MAX_MAX_STEPS = 40;
const MAX_STEPS_KEPT = 200;
const MAX_TASKS_KEPT = 30;
const MAX_PROMPT_CHARS = 8000;
const SUMMARY_CHARS = 300;
const CANCEL_GRACE_MS = 3000;

export class DelegateError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "DelegateError";
    this.code = code;
    this.retryable = retryable;
  }
}

const listeners = new Set();

/**
 * 订阅委托任务事件；返回取消订阅函数。
 * 事件：{ type: AGENT_TASK_EVENTS.*, taskId, at, ...payload }
 *   started  { task }                    任务摘要（不含 steps）
 *   step     { step }                    新增一步（tool / blocked / answer / note）
 *   approval { pendingId, toolName, reason }
 *   finished { status, answer, error }
 */
export function onAgentTaskEvent(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event) {
  for (const fn of [...listeners]) {
    try {
      fn(event);
    } catch (err) {
      console.warn("[pagelens] agent task listener", err);
    }
  }
}

function clip(value, n = SUMMARY_CHARS) {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 解析委托胶囊：显式胶囊校验后使用，否则只从委托人 prompt 抽取 */
export function resolveDelegateCapsule({ prompt, capsule } = {}) {
  if (capsule != null) {
    if (typeof capsule !== "object" || Array.isArray(capsule)) {
      throw new DelegateError("BAD_ARGS", "capsule 必须是对象（actions / origins / urls / platforms / recipients / paths / commands）。");
    }
    return { capsule: normalizeCapsule(capsule, { principal: "agent" }), source: "explicit" };
  }
  return { capsule: extractCapsule(prompt, { principal: "agent" }), source: "prompt" };
}

export function clampMaxSteps(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_STEPS;
  return Math.min(MAX_MAX_STEPS, Math.max(1, Math.floor(n)));
}

/** chrome.storage.session 适配器 */
export function sessionTaskStorage(area = globalThis.chrome?.storage?.session, key = DELEGATE_STORAGE_KEY) {
  return {
    async load() {
      const got = await area.get(key);
      return Array.isArray(got?.[key]) ? got[key] : [];
    },
    async save(list) {
      await area.set({ [key]: list });
    },
  };
}

export function memoryTaskStorage(initial = []) {
  let list = structuredClone(initial);
  return {
    async load() {
      return structuredClone(list);
    },
    async save(next) {
      list = structuredClone(next);
    },
  };
}

function randomTaskId() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `task_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** 给调用方 / 侧栏看的任务视图 */
export function publicTask(task, { sinceStep = 0, withSteps = true } = {}) {
  if (!task) return null;
  const { steps = [], ...rest } = task;
  const out = { ...rest, capsuleSummary: describeCapsule(task.capsule), stepCount: steps.length };
  if (withSteps) {
    const from = Math.max(0, Number(sinceStep) || 0);
    out.steps = steps.filter((s) => s.n > from);
  }
  return out;
}

/**
 * @param {object} deps
 * @param {{ load(): Promise<object[]>, save(list: object[]): Promise<void> }} deps.storage
 * @param {{ enqueue: Function, consumeApproved: Function, get?: Function }} deps.approvals 待批准队列（trust/approval-queue.js）
 * @param {() => Promise<object>} deps.loadSettings
 * @param {(p: { task: object, settings: object, signal: AbortSignal }) => Promise<{
 *   tools: object[], systemPrompt: string, model: { runTurn: Function },
 *   getTabUrl?: (tabId: number) => Promise<string>, refLabel?: (tabId: number, index: number) => string,
 *   activeTools?: (tools: object[]) => object[] }>} deps.createRun
 * @param {(host: object) => { run: Function }} [deps.createLoop]
 */
export function createDelegateManager({
  storage = memoryTaskStorage(),
  approvals,
  loadSettings = async () => ({}),
  createRun,
  createLoop = createKernelAgentLoop,
  now = () => Date.now(),
  newId = randomTaskId,
  maxConcurrent = 3,
  onActivityChange = () => {},
} = {}) {
  const tasks = new Map();
  const controllers = new Map();
  let loaded = null;
  let writeTail = Promise.resolve();

  function ensureLoaded() {
    if (!loaded) {
      loaded = (async () => {
        let list = [];
        try {
          list = await storage.load();
        } catch {
          list = [];
        }
        let interrupted = false;
        for (const t of list) {
          if (!t?.id) continue;
          if (t.status === TASK_STATUS.RUNNING) {
            interrupted = true;
            Object.assign(t, {
              status: TASK_STATUS.FAILED,
              error: { code: "INTERRUPTED", message: "扩展 Service Worker 重启，任务中断；已完成的步骤保留在 steps。" },
              finishedAt: now(),
              updatedAt: now(),
            });
          }
          tasks.set(t.id, t);
        }
        if (interrupted) await persist();
      })();
    }
    return loaded;
  }

  function persist() {
    const run = writeTail.then(async () => {
      const list = [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
      while (list.length > MAX_TASKS_KEPT) {
        const idx = list.findIndex((t) => t.status !== TASK_STATUS.RUNNING);
        if (idx < 0) break;
        tasks.delete(list[idx].id);
        list.splice(idx, 1);
      }
      await storage.save(list);
    });
    writeTail = run.catch((err) => console.warn("[pagelens] delegate persist", err));
    return run;
  }

  function runningCount() {
    return controllers.size;
  }

  function touch(task) {
    task.updatedAt = now();
    return persist().catch(() => {});
  }

  function addStep(task, step) {
    const entry = { n: (task.steps.at(-1)?.n || 0) + 1, at: now(), ...step };
    task.steps.push(entry);
    if (task.steps.length > MAX_STEPS_KEPT) task.steps.splice(0, task.steps.length - MAX_STEPS_KEPT);
    emit({ type: AGENT_TASK_EVENTS.STEP, taskId: task.id, at: entry.at, step: entry });
    touch(task);
    return entry;
  }

  function finish(task, status, { answer, error, endReason } = {}) {
    if (task.status !== TASK_STATUS.RUNNING) return Promise.resolve();
    Object.assign(task, {
      status,
      answer: answer != null ? String(answer) : task.answer,
      error: error || null,
      endReason: endReason || task.endReason || "",
      finishedAt: now(),
    });
    controllers.delete(task.id);
    onActivityChange(runningCount());
    emit({ type: AGENT_TASK_EVENTS.FINISHED, taskId: task.id, at: now(), status, answer: task.answer, error: task.error });
    return touch(task);
  }

  function ownedBy(task, owner) {
    return !owner || !task.owner || task.owner === owner;
  }

  async function getTask(taskId, owner) {
    await ensureLoaded();
    const task = tasks.get(String(taskId || ""));
    if (!task || !ownedBy(task, owner)) throw new DelegateError("TASK_NOT_FOUND", `没有委托任务 ${taskId}。`);
    return task;
  }

  function interceptorFor(task, run, settings, session, getTaint) {
    const hitlMode = settings?.hitlMode === "strict" ? "strict" : "balanced";
    return async ({ tool, args }) => {
      const toolName = tool.name;
      const targetUrl = await resolveHitlTargetUrl(toolName, args, {
        getTabId: () => task.tabId,
        getTabUrl: run.getTabUrl,
      });
      if (/^https?:/i.test(targetUrl) && typeof session?.allowUrl === "function" && !session.allowUrl(targetUrl)) {
        const denial = { code: "ORIGIN_NOT_ALLOWED", reason: `${targetUrl} 不在委托方可访问的 origin 范围内。[${toolName}]` };
        task.denied.push({ toolName, code: denial.code, reason: clip(denial.reason) });
        if (task.denied.length > 20) task.denied.shift();
        addStep(task, { kind: "blocked", name: toolName, code: denial.code, summary: clip(denial.reason) });
        return { allow: false, reason: formatTrustDenial(denial) };
      }
      const refTab = args?.tabId != null && args?.tabId !== "" ? Number(args.tabId) : task.tabId;
      const elementText = args?.index != null && run.refLabel ? run.refLabel(refTab, args.index) : "";
      const d = decideToolCall({
        toolName,
        args,
        hitlMode,
        targetUrl,
        userUrl: task.sourceUrl,
        capsule: task.capsule,
        taint: getTaint(),
        attended: false,
        settings,
        tokenEgress: Array.isArray(session?.egress) ? session.egress : [],
        skipIrreversible: session?.skipIrreversible === true,
        elementText,
      });
      if (d.decision === "allow") return { allow: true };

      if (d.decision === "queue") {
        // 与 bridge 直调同一 principal：侧栏批准后，同一 token 的委托重跑或直调都能消费
        const principal = session?.tokenId ? `token:${session.tokenId}` : `agent:${task.agentName || "external"}`;
        const approved = await approvals?.consumeApproved?.(toolName, args, { principal }).catch(() => null);
        if (approved) {
          addStep(task, { kind: "note", name: toolName, summary: `使用用户已批准的待办 ${approved.id}` });
          return { allow: true };
        }
        const entry = await approvals
          ?.enqueue?.({
            toolName,
            args,
            reason: d.reason,
            item: d.irreversible,
            principal,
            sessionId: task.id,
          })
          .catch(() => null);
        const pendingId = entry?.id || "";
        if (pendingId && !task.pending.some((p) => p.pendingId === pendingId)) {
          task.pending.push({ pendingId, toolName, reason: clip(d.reason) });
          emit({ type: AGENT_TASK_EVENTS.APPROVAL, taskId: task.id, at: now(), pendingId, toolName, reason: d.reason });
        }
        addStep(task, { kind: "blocked", name: toolName, code: CONFIRMATION_REQUIRED, pendingId, summary: clip(d.reason) });
        return { allow: false, reason: formatTrustDenial({ ...d, code: CONFIRMATION_REQUIRED }, { pendingId }) };
      }

      // 无人值守下 decide 不会返回 confirm；兜底按需要扩大授权处理，绝不弹窗
      const denial = d.decision === "confirm" ? { ...d, code: NEEDS_WIDER_AUTHORIZATION } : d;
      task.denied.push({ toolName, code: denial.code, reason: clip(denial.reason) });
      if (task.denied.length > 20) task.denied.shift();
      addStep(task, { kind: "blocked", name: toolName, code: denial.code, summary: clip(denial.reason) });
      return { allow: false, reason: formatTrustDenial(denial) };
    };
  }

  async function execute(task, controller, session) {
    const signal = controller.signal;
    let taint = createTaintState();
    try {
      const settings = await loadSettings();
      const run = await createRun({ task, settings, signal });
      const tools = withUntrustedOutput(run.tools || [], {
        onIngest: (info) => {
          taint = ingestData(taint, info);
          task.taint = taintLevel(taint);
        },
        onInjection: (hit) => {
          taint = markHighTaint(taint, hit);
          task.taint = taintLevel(taint);
          addStep(task, { kind: "note", name: hit.tool || "", summary: "工具结果疑似含提示词注入；会话标为高污染，胶囊外动作一律拒绝" });
        },
      });
      const loop = createLoop({
        maxTurns: task.maxSteps,
        allTools: tools,
        tools: run.activeTools ? run.activeTools(tools) : tools,
        systemPrompt: run.systemPrompt,
        interceptToolCall: interceptorFor(task, run, settings, session, () => taint),
        model: run.model,
      });
      const result = await loop.run(task.prompt, {
        sessionId: task.id,
        signal,
        onEvent: (ev) => {
          if (ev.type === "tools_done") {
            if (task.steps.at(-1)?.kind === "blocked" && task.steps.at(-1)?.name === ev.name && !ev.ok) return;
            addStep(task, { kind: "tool", name: ev.name, ok: Boolean(ev.ok), args: clip(ev.args, 200), summary: clip(ev.content) });
          } else if (ev.type === "model_done" && ev.content) {
            task.answer = String(ev.content);
            addStep(task, { kind: "answer", summary: clip(ev.content) });
          }
        },
      });
      if (signal.aborted || result?.reason === "abort") {
        await finish(task, TASK_STATUS.CANCELLED, { answer: result?.text || task.answer, endReason: "abort" });
        return;
      }
      const stillPending = task.pending.length > 0;
      await finish(task, stillPending ? TASK_STATUS.NEEDS_APPROVAL : TASK_STATUS.DONE, {
        answer: result?.text || task.answer || "",
        endReason: result?.reason || "stop",
      });
    } catch (err) {
      if (signal.aborted) {
        await finish(task, TASK_STATUS.CANCELLED, { endReason: "abort" });
        return;
      }
      await finish(task, TASK_STATUS.FAILED, {
        error: { code: err?.code || "TASK_FAILED", message: String(err?.message || err).slice(0, 500) },
      });
    }
  }

  return {
    /**
     * 启动委托任务；立即返回（不等任务结束）。
     * @param {object} p
     * @param {string} p.prompt
     * @param {object} [p.capsule] 显式意图胶囊
     * @param {number|null} [p.tabId] 任务标签（已鉴权）
     * @param {string} [p.sourceUrl] 任务标签 URL
     * @param {number} [p.maxSteps]
     * @param {string} [p.model] 覆盖文本模型名
     * @param {{ agentName?: string, sessionId?: string, tokenId?: string, egress?: string[], skipIrreversible?: boolean }} [p.session]
     * @param {(capsule: object) => object} [p.restrictCapsule] 按调用方 origin 范围收窄胶囊
     */
    async start({ prompt, capsule, tabId = null, sourceUrl = "", maxSteps, model = "", session = null, restrictCapsule } = {}) {
      await ensureLoaded();
      const text = String(prompt || "").trim();
      if (!text) throw new DelegateError("BAD_ARGS", "prompt 不能为空。");
      if (text.length > MAX_PROMPT_CHARS) throw new DelegateError("BAD_ARGS", `prompt 过长（上限 ${MAX_PROMPT_CHARS} 字）。`);
      if (typeof createRun !== "function") throw new DelegateError("UNAVAILABLE", "委托任务运行环境未就绪。");
      if (runningCount() >= maxConcurrent) {
        throw new DelegateError("BUSY", `已有 ${runningCount()} 个委托任务在运行（上限 ${maxConcurrent}），稍后再试或先取消。`, { retryable: true });
      }
      const resolved = resolveDelegateCapsule({ prompt: text, capsule });
      const restricted = typeof restrictCapsule === "function" ? restrictCapsule(resolved.capsule) : { capsule: resolved.capsule, dropped: [] };
      const owner = session?.tokenId || session?.agentName || null;
      const task = {
        id: newId(),
        status: TASK_STATUS.RUNNING,
        prompt: text,
        capsule: Object.freeze(structuredClone(restricted.capsule)),
        capsuleSource: resolved.source,
        droppedOrigins: restricted.dropped || [],
        agentName: String(session?.agentName || "").slice(0, 80),
        sessionId: String(session?.sessionId || ""),
        owner,
        tabId: Number.isInteger(tabId) ? tabId : null,
        sourceUrl: String(sourceUrl || ""),
        maxSteps: clampMaxSteps(maxSteps),
        model: String(model || "").slice(0, 120),
        taint: "clean",
        steps: [],
        pending: [],
        denied: [],
        answer: "",
        error: null,
        endReason: "",
        createdAt: now(),
        updatedAt: now(),
        finishedAt: null,
      };
      tasks.set(task.id, task);
      const controller = new AbortController();
      controllers.set(task.id, controller);
      onActivityChange(runningCount());
      await persist();
      emit({ type: AGENT_TASK_EVENTS.STARTED, taskId: task.id, at: now(), task: publicTask(task, { withSteps: false }) });
      const done = execute(task, controller, session);
      Object.defineProperty(task, "done", { value: done, enumerable: false, configurable: true });
      return publicTask(task, { withSteps: false });
    },

    /** 任务状态；pending 附带待批准条目的当前状态（pending / approved / rejected / gone） */
    async status(taskId, { sinceStep = 0, owner = null } = {}) {
      const task = await getTask(taskId, owner);
      const view = publicTask(task, { sinceStep });
      if (approvals?.get && view.pending?.length) {
        view.pending = await Promise.all(
          view.pending.map(async (p) => {
            const entry = await approvals.get(p.pendingId).catch(() => null);
            return { ...p, approval: entry?.status || "gone" };
          }),
        );
      }
      return view;
    },

    async cancel(taskId, { owner = null } = {}) {
      const task = await getTask(taskId, owner);
      if (task.status !== TASK_STATUS.RUNNING) return { ...publicTask(task, { withSteps: false }), alreadyFinished: true };
      const controller = controllers.get(task.id);
      if (controller) {
        controller.abort();
        let timer;
        const grace = new Promise((r) => (timer = setTimeout(r, CANCEL_GRACE_MS)));
        await Promise.race([task.done?.catch?.(() => {}), grace]);
        clearTimeout(timer);
      }
      if (task.status === TASK_STATUS.RUNNING) await finish(task, TASK_STATUS.CANCELLED, { endReason: "abort" });
      return publicTask(task, { withSteps: false });
    },

    async list({ owner = null } = {}) {
      await ensureLoaded();
      return [...tasks.values()]
        .filter((t) => ownedBy(t, owner))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((t) => publicTask(t, { withSteps: false }));
    },

    /** 测试 / 内部：等任务跑完 */
    async wait(taskId) {
      const task = await getTask(taskId);
      await task.done;
      return publicTask(task);
    },

    runningCount,
  };
}

let installedManager = null;

/** SW 安装后注册；bridge 工具从这里取 */
export function setDelegateManager(manager) {
  installedManager = manager;
}

export function getDelegateManager() {
  return installedManager;
}

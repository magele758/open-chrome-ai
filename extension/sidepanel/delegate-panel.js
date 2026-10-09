/** 侧栏：外部 Agent 委托给内部 Agent 的后台任务（来源、授权范围、步骤），可取消。数据来自 chrome.storage.session。 */
import { describeCapsule } from "../lib/agent/trust/capsule.js";
import { TASK_STATUS } from "../lib/agent/delegate.js";

const RECENT_MS = 30 * 60 * 1000;
const MAX_SHOWN = 5;
const STEPS_SHOWN = 12;

export const STATUS_LABELS = {
  [TASK_STATUS.RUNNING]: "运行中",
  [TASK_STATUS.DONE]: "已完成",
  [TASK_STATUS.FAILED]: "失败",
  [TASK_STATUS.NEEDS_APPROVAL]: "待你批准",
  [TASK_STATUS.CANCELLED]: "已取消",
};

/** 要显示的任务：运行中 / 待批准的全部，加最近 30 分钟内结束的；新的在前 */
export function visibleDelegateTasks(list, now = Date.now()) {
  return (Array.isArray(list) ? list : [])
    .filter((t) => t && (t.status === TASK_STATUS.RUNNING || t.status === TASK_STATUS.NEEDS_APPROVAL || now - Number(t.finishedAt || t.updatedAt || 0) < RECENT_MS))
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, MAX_SHOWN);
}

export function stepLine(step) {
  if (step.kind === "blocked") {
    const extra = step.pendingId ? ` · ${step.pendingId}` : "";
    return `⛔ ${step.name || ""} ${step.code || ""}${extra}`;
  }
  if (step.kind === "answer") return `💬 ${step.summary || ""}`;
  if (step.kind === "note") return `ℹ️ ${step.summary || ""}`;
  return `${step.ok ? "✓" : "✗"} ${step.name || ""}`;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "className") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

/**
 * @param {{ load: () => Promise<object[]>, cancel: (taskId: string) => Promise<unknown> }} deps
 */
export function createDelegatePanel(deps) {
  const $ = (id) => document.getElementById(id);
  let open = false;

  function taskNode(task) {
    const running = task.status === TASK_STATUS.RUNNING;
    const steps = Array.isArray(task.steps) ? task.steps.slice(-STEPS_SHOWN) : [];
    const head = el("div", { className: "delegate-head" }, [
      el("strong", { text: task.agentName || "外部 Agent" }),
      el("span", { className: `delegate-status ${task.status}`, text: STATUS_LABELS[task.status] || task.status }),
    ]);
    if (running) {
      head.append(
        el("button", {
          type: "button",
          className: "trust-btn",
          text: "取消",
          onClick: async (e) => {
            e.currentTarget.disabled = true;
            await deps.cancel(task.id).catch(() => {});
            render();
          },
        }),
      );
    }
    const children = [
      head,
      el("div", { className: "delegate-prompt", text: String(task.prompt || "").slice(0, 160), title: task.prompt || "" }),
      el("div", { className: "delegate-capsule", text: `授权：${describeCapsule(task.capsule).join(" · ")}` }),
    ];
    if (task.pending?.length) {
      children.push(el("div", { className: "delegate-pending", text: `${task.pending.length} 个操作等你在上方「待批准」里处理` }));
    }
    if (task.error?.message) children.push(el("div", { className: "delegate-error", text: task.error.message }));
    if (steps.length) {
      children.push(
        el("details", { className: "delegate-steps" }, [
          el("summary", { text: `步骤 ${task.steps.length}` }),
          ...steps.map((s) => el("div", { className: "delegate-step", text: stepLine(s), title: s.summary || "" })),
        ]),
      );
    }
    return el("div", { className: "delegate-item" }, children);
  }

  async function render() {
    const box = $("delegate-tasks");
    if (!box) return;
    let list = [];
    try {
      list = visibleDelegateTasks(await deps.load());
    } catch {
      list = [];
    }
    box.classList.toggle("hidden", list.length === 0);
    if (!list.length) {
      box.replaceChildren();
      return;
    }
    const running = list.filter((t) => t.status === TASK_STATUS.RUNNING).length;
    const details = el("details", { className: "delegate-box", ...(open ? { open: "" } : {}) }, [
      el("summary", { text: `🤖 外部委托任务 · ${running ? `${running} 个运行中` : `最近 ${list.length} 个`}` }),
      ...list.map(taskNode),
    ]);
    details.addEventListener("toggle", () => {
      open = details.open;
    });
    box.replaceChildren(details);
  }

  return { render };
}

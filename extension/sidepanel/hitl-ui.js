import { $ } from "./dom.js";
import { pushTraceItem } from "./messages.js";
import { state } from "./state.js";
import { trustPanel } from "./trust-runtime.js";
import { extractCapsule, mergeCapsules } from "../lib/agent/trust/capsule.js";
import { ingestData, markHighTaint } from "../lib/agent/trust/taint.js";
import { debugLog } from "../lib/debug-log.js";

function updateHitlBadge() {
  const badge = $("hitl-badge");
  if (!badge) return;
  const isAuto = state.settings.hitlMode === "autonomous" || state.sessionHitlOverride === true;
  badge.classList.toggle("hidden", !isAuto);
  if (state.sessionHitlOverride === true) {
    badge.textContent = "⚡️本场免确认";
    badge.title = "本场会话已信任，点击切回智能模式";
  } else if (state.settings.hitlMode === "autonomous") {
    badge.textContent = "⚡️全自动";
    badge.title = "当前处于全自动模式，点击切回智能模式";
  }
}

/** 注入特征命中：会话标为高污染（告警 + 审计）。胶囊内动作照常放行，胶囊外有副作用的动作逐项确认。 */
function flagInjection(hit, botMsg) {
  if (!hit || state.injectionSuspected) return;
  state.injectionSuspected = hit;
  state.taint = markHighTaint(state.taint, hit);
  state.sessionHitlOverride = null;
  updateHitlBadge();
  debugLog("hitl.injection", { tool: hit.tool, match: hit.match, excerpt: String(hit.excerpt || "").slice(0, 120) });
  if (botMsg) pushTraceItem(botMsg, { kind: "meta", name: "疑似提示词注入：会话已标为高污染，授权范围外的操作需确认", ok: false });
  trustPanel.render();
}

function ingestTaint(info) {
  const before = state.taint?.level;
  state.taint = ingestData(state.taint, info);
  if (state.taint.level !== before) trustPanel.render();
}

function capsuleFromMessages(messages) {
  return (messages || [])
    .filter((m) => m.role === "user" && m.text)
    .reduce((acc, m) => mergeCapsules(acc, extractCapsule(m.text)), null);
}

function showHitlModal({ toolName, args, reason, signal, timeoutSeconds, onDecision, title, detail, allowRemember = true, approveLabel, armMs = 0 }) {
  const modal = $("hitl-modal");
  const descEl = $("hitl-desc");
  const cmdEl = $("hitl-cmd");
  const timerEl = $("hitl-timer");
  const rememberEl = $("hitl-session-remember");
  const btnApprove = $("btn-hitl-approve");
  const btnReject = $("btn-hitl-reject");
  const titleEl = $("hitl-title");

  if (!modal) {
    onDecision({ allow: false, reason: "无法弹出授权确认窗口" });
    return;
  }

  if (descEl) descEl.textContent = reason || `模型申请执行特权操作: ${toolName}`;
  if (titleEl) titleEl.textContent = title || "特权操作需要授权";
  $("hitl-session-label")?.classList.toggle("hidden", !allowRemember);
  if (btnApprove) {
    btnApprove.textContent = approveLabel || "允许执行";
    btnApprove.disabled = armMs > 0;
    if (armMs > 0) setTimeout(() => { btnApprove.disabled = false; }, armMs);
  }
  const cmd = detail || args?.command || (toolName === "run_shell" ? "" : JSON.stringify(args, null, 2));
  if (cmd && cmdEl) {
    cmdEl.textContent = cmd;
    cmdEl.classList.remove("hidden");
  } else if (cmdEl) {
    cmdEl.classList.add("hidden");
  }

  if (rememberEl) rememberEl.checked = false;
  modal.classList.remove("hidden");

  let timeLeft = timeoutSeconds || 30;
  if (timerEl) timerEl.textContent = `${timeLeft}s`;

  let timerId = null;
  let finished = false;

  const cleanup = () => {
    if (finished) return;
    finished = true;
    if (timerId) clearInterval(timerId);
    modal.classList.add("hidden");
    btnApprove?.removeEventListener("click", handleApprove);
    btnReject?.removeEventListener("click", handleReject);
  };

  const handleApprove = () => {
    if (btnApprove?.disabled) return;
    cleanup();
    if (allowRemember && rememberEl?.checked) {
      state.sessionHitlOverride = true;
      updateHitlBadge();
    }
    onDecision({ allow: true });
  };

  const handleReject = () => {
    cleanup();
    onDecision({ allow: false, reason: "用户在侧栏主动拒绝执行该特权操作。" });
  };

  btnApprove?.addEventListener("click", handleApprove);
  btnReject?.addEventListener("click", handleReject);

  timerId = setInterval(() => {
    timeLeft -= 1;
    if (timeLeft <= 0) {
      cleanup();
      onDecision({ allow: false, timedOut: true, reason: "授权超时未确认，操作已取消。" });
    } else if (timerEl) {
      timerEl.textContent = `${timeLeft}s`;
    }
  }, 1000);

  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        cleanup();
        onDecision({ allow: false, reason: "操作已被用户中止。" });
      },
      { once: true },
    );
  }
}


export {
  updateHitlBadge,
  flagInjection,
  ingestTaint,
  capsuleFromMessages,
  showHitlModal,
};

/** 侧栏授权条：展示意图胶囊与会话污点，用户可扩大/收窄授权、批准待办、撤销自动生效的设置。 */
import { ACTION_LABELS, describeCapsule, setCapsuleActions, widenCapsule } from "../lib/agent/trust/capsule.js";
import { ACTION_CATEGORIES } from "../lib/agent/trust/tool-classes.js";
import { TAINT_CLEAN, TAINT_HIGH, describeTaint, taintLevel } from "../lib/agent/trust/taint.js";

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
 * @param {{ getCapsule: () => object|null, setCapsule: (c: object) => void, getTaint: () => object,
 *   approvals: { list: Function, resolve: Function }, onChange?: () => void }} deps
 */
export function createTrustPanel(deps) {
  const $ = (id) => document.getElementById(id);
  let undoTimer = null;
  let visible = false;

  function openEditor() {
    const box = $("trust-actions");
    if (!box) return;
    const current = new Set(deps.getCapsule()?.actions || []);
    box.replaceChildren(
      ...ACTION_CATEGORIES.map((a) =>
        el("label", { className: "check trust-check" }, [
          el("input", { type: "checkbox", value: a, ...(current.has(a) ? { checked: "" } : {}) }),
          ACTION_LABELS[a] || a,
        ]),
      ),
    );
    if ($("trust-extra")) $("trust-extra").value = "";
    $("trust-editor")?.classList.remove("hidden");
  }

  function closeEditor() {
    $("trust-editor")?.classList.add("hidden");
  }

  function saveEditor() {
    const checked = [...($("trust-actions")?.querySelectorAll("input:checked") || [])].map((i) => i.value);
    let next = setCapsuleActions(deps.getCapsule(), checked);
    next = widenCapsule(next, { text: $("trust-extra")?.value || "" });
    deps.setCapsule(next);
    closeEditor();
    render();
  }

  async function renderPending() {
    const box = $("trust-pending");
    if (!box) return 0;
    let pending = [];
    try {
      pending = await deps.approvals.list({ status: "pending" });
    } catch {
      pending = [];
    }
    box.classList.toggle("hidden", pending.length === 0);
    box.replaceChildren(
      ...pending.map((p) =>
        el("div", { className: "trust-pending-item" }, [
          el("div", { className: "trust-pending-text" }, [
            el("strong", { text: `待批准：${p.toolName}` }),
            el("span", { text: ` ${p.item?.label || p.reason || ""}` }),
            el("code", { className: "trust-pending-args", text: p.argsPreview }),
          ]),
          el("div", { className: "trust-pending-ops" }, [
            el("button", { type: "button", className: "secondary", text: "拒绝", onClick: () => resolve(p.id, false) }),
            el("button", { type: "button", className: "primary", text: "批准一次", onClick: () => resolve(p.id, true) }),
          ]),
        ]),
      ),
    );
    return pending.length;
  }

  async function resolve(id, allow) {
    await deps.approvals.resolve(id, allow);
    await render();
  }

  async function render() {
    const bar = $("trust-bar");
    if (!bar) return;
    const capsule = deps.getCapsule();
    const taint = deps.getTaint();
    const level = taintLevel(taint);
    const lines = describeCapsule(capsule);
    if ($("trust-summary")) {
      $("trust-summary").textContent = `授权范围 · ${lines.join(" · ")}`;
      $("trust-summary").title = lines.join("\n");
    }
    const tag = $("trust-taint");
    if (tag) {
      tag.textContent = level === TAINT_CLEAN ? "" : level === TAINT_HIGH ? "⚠️ 高污染" : "已读外部数据";
      tag.title = describeTaint(taint);
      tag.classList.toggle("high", level === TAINT_HIGH);
      tag.classList.toggle("hidden", level === TAINT_CLEAN);
    }
    const pendingCount = await renderPending();
    const show = visible || Boolean(capsule) || pendingCount > 0 || level !== TAINT_CLEAN;
    bar.classList.toggle("hidden", !show);
    deps.onChange?.();
  }

  function showUndo({ text, undo }) {
    const box = $("trust-undo");
    if (!box) return;
    if (undoTimer) clearTimeout(undoTimer);
    $("trust-undo-text").textContent = `设置已直接生效：${String(text || "").replace(/\s+/g, " ").slice(0, 120)}`;
    const btn = $("btn-trust-undo");
    const fresh = btn.cloneNode(true);
    btn.replaceWith(fresh);
    fresh.addEventListener("click", async () => {
      fresh.disabled = true;
      const ok = await undo().catch(() => false);
      $("trust-undo-text").textContent = ok ? "已撤销。" : "撤销失败：设置已在别处变化。";
      undoTimer = setTimeout(() => box.classList.add("hidden"), 2500);
    });
    box.classList.remove("hidden");
    $("trust-bar")?.classList.remove("hidden");
    undoTimer = setTimeout(() => box.classList.add("hidden"), 30000);
  }

  function bind() {
    $("btn-trust-edit")?.addEventListener("click", () => {
      if ($("trust-editor")?.classList.contains("hidden")) openEditor();
      else closeEditor();
    });
    $("btn-trust-cancel")?.addEventListener("click", closeEditor);
    $("btn-trust-save")?.addEventListener("click", saveEditor);
  }

  return {
    bind,
    render,
    showUndo,
    setVisible(v) {
      visible = Boolean(v);
    },
  };
}

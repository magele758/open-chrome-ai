/**
 * 通用确定性工作流执行引擎（零业务语义、零站点硬编码）。
 *
 * 仅提供通用交互、同步、查询、数据绑定与控制流原语：
 * assert_url / wait_for / close_modals_if_present / scroll_container / ensure_tab /
 * click_and_wait / fill_input / ensure_select / ensure_cascader / ensure_radio /
 * ensure_checkboxes / row_action / query_dom / set_binds / assert_state /
 * if_state / foreach / call_macro / fail
 */

import { evaluateClickPolicy, evaluateUrlPolicy } from "../policy-guard.js";
import { matchIrreversible } from "../trust/irreversible.js";
import { DEFAULT_ADAPTER_SPEC, buildAssertStateBatches } from "./assert-batches.js";
import {
  applyBindTransforms,
  evaluateWhenPredicate,
  interpolateParams,
  lookupBindValue,
  setBindValue,
} from "./binds.js";
import {
  WorkflowError,
  detectExternalBlocker,
  normalizeCjkText,
  normalizeSpaces,
} from "./errors.js";
import { parseWorkflowDirective } from "./parser.js";

const UNTRUSTED_TAG_RE = /^<untrusted_page(?:\s+source="[^"]*")?>\r?\n?([\s\S]*?)\r?\n?<\/untrusted_page>$/i;
const FILE_CHOOSER_ERR_RE = /文件上传控件|文件选择框|file\s*chooser|blockedFileChooser/i;

function checkAbort(signal) {
  if (signal?.aborted) {
    const err = new Error("Aborted");
    err.name = "AbortError";
    throw err;
  }
}

function sleepWithAbort(ms, signal) {
  const delay = Math.max(0, Number(ms) || 0);
  if (delay === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    checkAbort(signal);
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error("Aborted");
      err.name = "AbortError";
      reject(err);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, delay);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function parseToolOutput(rawOut) {
  if (rawOut == null) return { parsed: null, text: "" };
  if (typeof rawOut === "object") {
    return { parsed: rawOut, text: JSON.stringify(rawOut) };
  }
  let text = String(rawOut).trim();
  const untrusted = UNTRUSTED_TAG_RE.exec(text);
  if (untrusted) text = untrusted[1].trim();
  try {
    return { parsed: JSON.parse(text), text };
  } catch {
    return { parsed: null, text };
  }
}

function buildToolMap(rawTools = []) {
  const map = new Map();
  if (Array.isArray(rawTools)) {
    for (const tool of rawTools) {
      if (tool?.name && typeof tool.execute === "function") {
        map.set(tool.name, tool);
      }
    }
  }
  return map;
}

function saveToBinds(binds, keyPath, value) {
  const k = String(keyPath || "").trim();
  if (!k) return;
  setBindValue(binds, k, value);
  if (!k.includes(".") && binds.runtime && typeof binds.runtime === "object") {
    binds.runtime[k] = value;
  }
}

function normalizePathText(v) {
  return String(v ?? "")
    .replace(/\s*(?:->|\/|>|›)\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim();
}

function assertUrlNotForbidden(url, forbidPatterns = [], stepCtx = {}) {
  const verdict = evaluateUrlPolicy(url, { forbidUrlPatterns: forbidPatterns });
  if (!verdict.allowed) {
    throw new WorkflowError({
      code: "WORKFLOW_FORBIDDEN_URL",
      blame: "workflow",
      stepIndex: stepCtx.stepIndex || 0,
      stepId: stepCtx.stepId || "",
      op: stepCtx.op || "",
      expected: `页面 URL 不命中禁止模式 ${JSON.stringify(forbidPatterns)}`,
      actual: String(url || ""),
      message: `页面 URL 命中禁止访问模式 "${verdict.matched}": ${url}`,
    });
  }
}

function assertClickTargetSafe({
  labelText = "",
  domElementText = "",
  selector = "",
  policy = {},
  settings = {},
  targetUrl = "",
  stepCtx = {},
}) {
  const verdict = evaluateClickPolicy({ text: labelText, domElementText, selector }, policy);
  if (!verdict.allowed) {
    if (verdict.code === "POLICY_FORBIDDEN_SELECTOR") {
      throw new WorkflowError({
        code: "WORKFLOW_FORBIDDEN_SELECTOR",
        blame: "workflow",
        stepIndex: stepCtx.stepIndex || 0,
        stepId: stepCtx.stepId || "",
        op: stepCtx.op || "",
        expected: `禁止选择器列表不包含 "${verdict.matched}"`,
        actual: String(selector),
        message: `策略守卫拦截：禁止操作选择器 "${verdict.matched}"`,
      });
    }
    throw new WorkflowError({
      code: "WORKFLOW_FORBIDDEN_ACTION",
      blame: "workflow",
      stepIndex: stepCtx.stepIndex || 0,
      stepId: stepCtx.stepId || "",
      op: stepCtx.op || "",
      expected: `禁止点击文本列表不包含 "${verdict.matched}"`,
      actual: `尝试点击 "${labelText || domElementText}"`,
      message: `策略守卫拦截：禁止点击 "${verdict.matched}"`,
    });
  }

  const forbidTexts = Array.isArray(policy.forbidClickTexts) ? policy.forbidClickTexts : [];
  const irr = matchIrreversible(
    "click",
    { text: labelText || domElementText, selector },
    { domElementText: domElementText || labelText, targetUrl, settings },
  );
  if (irr?.matched) {
    const allowCancel = /^(?:取消|关闭|close|cancel)$/i.test(normalizeCjkText(labelText || domElementText));
    if (!allowCancel && forbidTexts.some((f) => normalizeCjkText(irr.reason || "").includes(normalizeCjkText(f)))) {
      throw new WorkflowError({
        code: "WORKFLOW_IRREVERSIBLE_BLOCKED",
        blame: "workflow",
        stepIndex: stepCtx.stepIndex || 0,
        stepId: stepCtx.stepId || "",
        op: stepCtx.op || "",
        expected: "不触发受保护的不可逆提交动作",
        actual: `${labelText || domElementText} (${irr.reason || "irreversible"})`,
        message: `不可逆动作守卫拦截: ${labelText || domElementText}`,
      });
    }
  }
}

function buildDomPreamble(adapterSpec = DEFAULT_ADAPTER_SPEC) {
  return `const ADAPTER = ${JSON.stringify(adapterSpec)};
const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
const normBtn = (s) => norm(s).replace(/([\\u4e00-\\u9fff])\\s+(?=[\\u4e00-\\u9fff])/g, "$1");
const normLabel = (s) => norm(s).replace(/^\\*\\s*/, "").replace(/\\s*[:：]\\s*$/, "").trim();
const stripHint = (s) => normLabel(s).replace(/\\s*[（(][^）)]*[）)]\\s*$/, "").trim();
const leaveRe = ADAPTER.leaveClassPattern ? new RegExp(ADAPTER.leaveClassPattern) : null;
const hasRunningAnim = (el) => {
  try {
    return typeof el.getAnimations === "function" && el.getAnimations({ subtree: false }).some((a) => a.playState === "running");
  } catch {
    return false;
  }
};
const isBox = (el, allowLeaving = 0) => {
  if (!el) return false;
  for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
    if (p.hidden || p.getAttribute("aria-hidden") === "true") return false;
    const cls = String(p.className || "");
    if (!allowLeaving && leaveRe && leaveRe.test(cls)) return false;
    const s = typeof getComputedStyle === "function" ? getComputedStyle(p) : null;
    if (s && (s.display === "none" || s.visibility === "hidden" || (!allowLeaving && Number(s.opacity) === 0 && !hasRunningAnim(p)))) return false;
  }
  if (!el.getBoundingClientRect) return true;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};
const maxZ = (el) => {
  let b = 0;
  for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
    const z = parseInt(typeof getComputedStyle === "function" ? getComputedStyle(p).zIndex : "0", 10);
    if (Number.isFinite(z) && z > b) b = z;
  }
  return b;
};
const getDialogs = (allowLeaving = 0) => {
  const raw = [...document.querySelectorAll(ADAPTER.dialogSelector)].filter((m) => isBox(m, allowLeaving));
  const outer = raw.filter((m) => !raw.some((o) => o !== m && o.contains(m)));
  return outer
    .map((m, i) => ({ m, i, z: maxZ(m) }))
    .sort((a, b) => (a.z !== b.z ? a.z - b.z : a.i - b.i))
    .map((x) => x.m);
};
const dialogTitle = (m) => {
  const lblId = m?.getAttribute?.("aria-labelledby");
  if (lblId) {
    const lblEl = document.getElementById(lblId);
    if (lblEl) return norm(lblEl.innerText || lblEl.textContent);
  }
  const h = m?.querySelector?.(ADAPTER.dialogTitleSelector);
  return norm(h ? (h.innerText || h.textContent) : m?.getAttribute?.("aria-label") || "");
};
const resolveScope = (scopeSpec) => {
  if (!scopeSpec) return document.body || document.documentElement || document;
  if (scopeSpec === "@topDialog") return getDialogs(0).slice(-1)[0] || null;
  const vis = [...document.querySelectorAll(scopeSpec)].filter((e) => isBox(e, 0));
  if (vis.length) return vis[vis.length - 1];
  const any = document.querySelector(scopeSpec);
  return isBox(any, 0) ? any : null;
};
const CTRL_SEL = 'select, input, textarea, [role="combobox"], [role="checkbox"], [role="radio"], ' + (ADAPTER.comboboxRootSelector || "select");
const qSelfOrAll = (root, sel) => {
  if (!root || !sel) return [];
  const out = [];
  if (root.matches?.(sel)) out.push(root);
  if (root.querySelectorAll) out.push(...root.querySelectorAll(sel));
  return out;
};
const hasFormCtrl = (el) => Boolean(el && (el.matches?.(CTRL_SEL) || el.querySelector?.(CTRL_SEL)));
const findFieldScope = (root, rawLabel) => {
  const want = normLabel(rawLabel);
  const wantShort = stripHint(rawLabel);
  if (!want || !root) return null;
  const pri = [...root.querySelectorAll(ADAPTER.fieldLabelSelector || "label, legend")].filter((e) => !e.closest("th, td, thead") && isBox(e, 0));
  const sec = [...root.querySelectorAll("div, span, p, dt")].filter((e) => !e.closest("th, td, thead, button, [role='option'], li") && e.children.length <= 3 && isBox(e, 0));
  for (const lbl of [...pri, ...sec]) {
    const txt = normLabel(lbl.innerText || lbl.textContent);
    const txtS = stripHint(txt);
    if (txt !== want && txtS !== want && txt !== wantShort) continue;
    const wrap = ADAPTER.fieldContainerSelector ? lbl.closest(ADAPTER.fieldContainerSelector) : null;
    if (wrap && root.contains(wrap)) return wrap;
    if (hasFormCtrl(lbl)) return lbl;
    if (lbl.tagName === "LABEL" && lbl.htmlFor) {
      const t = document.getElementById(lbl.htmlFor);
      if (t) return t.parentElement || t;
    }
    let sib = lbl.nextElementSibling;
    while (sib) {
      if (hasFormCtrl(sib)) return sib;
      sib = sib.nextElementSibling;
    }
    let cur = lbl.parentElement;
    for (let d = 0; d < 3 && cur && cur !== root; d += 1, cur = cur.parentElement) {
      if (hasFormCtrl(cur)) return cur;
    }
  }
  return null;
};
const itemText = (el) => {
  if (!el) return "";
  const t = norm(el.getAttribute?.("title") || "");
  if (t) return t;
  const sub = ADAPTER.selectedItemContentSelector ? el.querySelector(ADAPTER.selectedItemContentSelector) : null;
  if (sub) return norm(sub.textContent);
  const cl = el.cloneNode(true);
  if (ADAPTER.selectedItemRemoveSelector) cl.querySelectorAll(ADAPTER.selectedItemRemoveSelector).forEach((x) => x.remove());
  return norm(cl.textContent);
};
const readSingleRootSelected = (root) => {
  if (!root) return [];
  if (root.tagName === "SELECT") {
    return [...(root.selectedOptions || [])].map((o) => norm(o.label || o.textContent || o.value)).filter(Boolean);
  }
  const out = [...root.querySelectorAll(ADAPTER.selectedItemSelector)].map(itemText).filter(Boolean);
  if (out.length) return out;
  const ctrlId = (root.getAttribute?.("aria-controls") || root.querySelector?.("[aria-controls]")?.getAttribute("aria-controls") || "").split(/\\s+/)[0];
  if (ctrlId) {
    const lb = document.getElementById(ctrlId);
    if (lb) {
      const ar = [...lb.querySelectorAll('[role="option"][aria-selected="true"]')].map((o) => norm(o.textContent)).filter(Boolean);
      if (ar.length) return ar;
    }
  }
  if (root.matches?.('input[role="combobox"], [role="combobox"]')) {
    const v = norm(root.value ?? "");
    if (v) return [v];
  }
  return [];
};`;
}

function summarizeStepArgs(stepId, params = {}) {
  const out = { stepId };
  for (const [k, v] of Object.entries(params)) {
    if (v == null || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (typeof v === "string") {
      out[k] = v.length <= 120 ? v : `${v.slice(0, 117)}...`;
    } else if (Array.isArray(v)) {
      out[k] = v.length <= 6 && v.every((x) => typeof x !== "object") ? v : `[Array(${v.length})]`;
    }
  }
  return out;
}

export async function runDeterministicWorkflow({
  rawText = "",
  directive: preParsedDirective = null,
  rawTools = [],
  adapterSpec = DEFAULT_ADAPTER_SPEC,
  getLastCapturedImage = () => null,
  clearLastCapturedImage = () => {},
  resolvePageSnapshot = async () => null,
  settings = {},
  captureFailureEvidence = undefined,
  signal = null,
  traceSteps = [],
  onStepStart = null,
  onStepDone = null,
} = {}) {
  const startedMs = Date.now();
  const toolMap = buildToolMap(rawTools);
  const shouldCaptureFailureEvidence = Boolean(
    captureFailureEvidence ??
      (settings?.debug?.enabled === true && settings?.debug?.captureFailureScreenshot !== false),
  );
  const executedSingleShots = new Set();
  const preamble = buildDomPreamble(adapterSpec);
  let nonceCounter = 0;

  async function invokeRawTool(toolName, args, stepCtx) {
    checkAbort(signal);
    const tool = toolMap.get(toolName);
    if (!tool) {
      throw new WorkflowError({
        code: "WORKFLOW_TOOL_MISSING",
        blame: "工具",
        stepIndex: stepCtx.stepIndex,
        stepId: stepCtx.stepId,
        op: stepCtx.op,
        expected: `底层工具 "${toolName}" 可用`,
        actual: `未注册工具 "${toolName}"`,
        message: `缺少底层工具: ${toolName}`,
      });
    }
    let rawOut;
    try {
      rawOut = await tool.execute(args || {});
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      const msg = err?.message || String(err);
      throw new WorkflowError({
        code: "WORKFLOW_TOOL_EXCEPTION",
        blame: "工具",
        stepIndex: stepCtx.stepIndex,
        stepId: stepCtx.stepId,
        op: stepCtx.op,
        expected: `${toolName} 正常执行`,
        actual: msg,
        message: `${toolName} 抛出异常: ${msg}`,
      });
    }
    const { parsed, text } = parseToolOutput(rawOut);
    if (FILE_CHOOSER_ERR_RE.test(text) || parsed?.blockedFileChooser === true) {
      throw new WorkflowError({
        code: "WORKFLOW_FILE_CHOOSER_BLOCKED",
        blame: "工具",
        stepIndex: stepCtx.stepIndex,
        stepId: stepCtx.stepId,
        op: stepCtx.op,
        expected: "点击不触发原生文件选择框",
        actual: text.slice(0, 300),
        message: `底层拦截到原生文件选择框触发: ${text.slice(0, 200)}`,
      });
    }
    return { parsed, text };
  }

  async function evalJs(bodyCode, stepCtx) {
    const { parsed, text } = await invokeRawTool("run_js", { code: `${preamble}\n${bodyCode}` }, stepCtx);
    if (!parsed || parsed.ok === false) {
      const errDetail = parsed?.error || text || "run_js 返回失败";
      throw new WorkflowError({
        code: "WORKFLOW_DOM_EVAL_FAILED",
        blame: "工具",
        stepIndex: stepCtx.stepIndex,
        stepId: stepCtx.stepId,
        op: stepCtx.op,
        expected: "页面脚本正常返回 { ok: true }",
        actual: String(errDetail).slice(0, 400),
        message: `页面实读脚本异常: ${String(errDetail).slice(0, 240)}`,
      });
    }
    return parsed.result;
  }

  async function evalRawJs(code, stepCtx) {
    const { parsed, text } = await invokeRawTool("run_js", { code }, stepCtx);
    if (!parsed || parsed.ok === false) {
      const errDetail = parsed?.error || text || "run_js 返回失败";
      throw new WorkflowError({
        code: "WORKFLOW_DOM_EVAL_FAILED",
        blame: "工具",
        stepIndex: stepCtx.stepIndex,
        stepId: stepCtx.stepId,
        op: stepCtx.op,
        expected: "页面脚本正常返回 { ok: true }",
        actual: String(errDetail).slice(0, 400),
        message: `页面实读脚本异常: ${String(errDetail).slice(0, 240)}`,
      });
    }
    return parsed.result;
  }

  async function cleanupAttr(attrName, nonce, stepCtx) {
    await invokeRawTool(
      "run_js",
      {
        code: `for (const el of document.querySelectorAll(${JSON.stringify(`[${attrName}="${nonce}"]`)})) el.removeAttribute(${JSON.stringify(attrName)}); return true;`,
      },
      stepCtx,
    ).catch(() => {});
  }

  async function captureStepScreenshot(stepCtx) {
    if (!toolMap.has("screenshot")) return null;
    try {
      clearLastCapturedImage();
      const { text } = await invokeRawTool("screenshot", {}, stepCtx);
      const dataUrl = getLastCapturedImage();
      if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) return dataUrl;
      if (typeof text === "string" && text.startsWith("data:image/")) return text;
    } catch (err) {
      if (err?.name === "AbortError") throw err;
    }
    return null;
  }

  let directive = preParsedDirective;
  if (!directive) {
    try {
      directive = parseWorkflowDirective(rawText);
    } catch (err) {
      const wfErr =
        err instanceof WorkflowError
          ? err
          : new WorkflowError({
              code: "WORKFLOW_PARSE_ERROR",
              blame: "workflow",
              stepIndex: 0,
              stepId: "workflow.parse",
              op: "parse",
              expected: "合法 /workflow JSON 指令",
              actual: err?.message || String(err),
              message: err?.message || String(err),
            });
      const now = Date.now();
      const shotUrl = shouldCaptureFailureEvidence
        ? await captureStepScreenshot({ stepIndex: 1, stepId: wfErr.stepId, op: wfErr.op })
        : null;
      const snap = await resolvePageSnapshot().catch(() => null);
      traceSteps.push({
        type: "tool_exec",
        turn: 0,
        name: wfErr.op || "parse",
        toolName: wfErr.op || "parse",
        workflowStepId: wfErr.stepId || "workflow.parse",
        args: { stepId: wfErr.stepId || "workflow.parse" },
        ok: false,
        jsOk: true,
        failureReason: wfErr.message,
        resultSummary: wfErr.actual || wfErr.message,
        expected: wfErr.expected,
        actual: wfErr.actual,
        blame: wfErr.blame,
        ...(shotUrl ? { screenshotDataUrl: shotUrl } : {}),
        durationMs: Math.max(1, now - startedMs),
        tabId: snap?.tabId ?? null,
        pageUrl: snap?.url ?? null,
        pageTitle: snap?.title ?? null,
        timestamp: now,
        isoTime: new Date(now).toISOString(),
      });
      return {
        ok: false,
        aborted: false,
        workflowId: "invalid-workflow",
        totalSteps: 1,
        executedSteps: 0,
        skippedSteps: 0,
        durationMs: Math.max(1, Date.now() - startedMs),
        errorMessage: wfErr.message,
        failure: {
          stepIndex: 1,
          stepId: wfErr.stepId || "workflow.parse",
          op: wfErr.op || "parse",
          code: wfErr.code,
          expected: wfErr.expected,
          actual: wfErr.actual,
          blame: wfErr.blame,
          message: wfErr.message,
          hasScreenshot: Boolean(shotUrl),
        },
      };
    }
  }

  const runtimeBinds = {
    ...(directive.binds && typeof directive.binds === "object" ? structuredClone(directive.binds) : {}),
    steps: {},
    workflow: { mutationsCount: 0, anyMutated: false },
  };
  if (!runtimeBinds.runtime || typeof runtimeBinds.runtime !== "object") {
    runtimeBinds.runtime = {};
  }

  async function checkEnvironmentAndUrl(stepCtx) {
    const snap = await resolvePageSnapshot().catch(() => null);
    if (snap?.url) {
      assertUrlNotForbidden(snap.url, directive.policy?.forbidUrlPatterns || directive.forbidUrlSubstrings, stepCtx);
      const extBlock = detectExternalBlocker({ url: snap.url, title: snap.title || "", text: "" });
      if (extBlock) {
        throw new WorkflowError({
          code: "WORKFLOW_EXTERNAL_BLOCKER",
          blame: "其他",
          stepIndex: stepCtx.stepIndex,
          stepId: stepCtx.stepId,
          op: stepCtx.op,
          expected: "目标站点正常可访问且无安全挑战或网关故障",
          actual: extBlock,
          message: extBlock,
        });
      }
    }
    return snap;
  }

  async function clickMarkedElement({ markNonce, buttonText = "", selectorOverride = null, stepCtx, targetUrl = "" }) {
    const sel = selectorOverride || `[data-pl-wf-act="${markNonce}"]`;
    try {
      assertClickTargetSafe({
        labelText: buttonText,
        domElementText: buttonText,
        selector: sel,
        policy: directive.policy,
        settings,
        targetUrl,
        stepCtx,
      });
      const clickArgs = buttonText ? { selector: sel, text: String(buttonText) } : { selector: sel };
      const { parsed, text } = await invokeRawTool("click", clickArgs, stepCtx);
      if (!parsed || parsed.ok !== true) {
        throw new WorkflowError({
          code: "WORKFLOW_CLICK_FAILED",
          blame: "工具",
          stepIndex: stepCtx.stepIndex,
          stepId: stepCtx.stepId,
          op: stepCtx.op,
          expected: `成功点击控件 "${buttonText || sel}"`,
          actual: text.slice(0, 350),
          message: `点击控件失败 (${buttonText || sel}): ${text.slice(0, 200)}`,
        });
      }
      return parsed;
    } finally {
      if (!selectorOverride && markNonce) {
        await cleanupAttr("data-pl-wf-act", markNonce, stepCtx);
      }
    }
  }

  async function waitForDialogsCount({ wantCount, timeoutMs = 10000, actionLabel = "", stepCtx }) {
    const deadline = Date.now() + Math.max(200, Number(timeoutMs) || 10000);
    const seenAlerts = new Set();
    let lastInfo = null;
    while (true) {
      lastInfo = await evalJs(
        `const want = ${Number(wantCount)};
        const ds = getDialogs(want === 0 ? 1 : 0);
        const alerts = [...document.querySelectorAll(ADAPTER.alertSelector)]
          .filter((a) => isBox(a, 0))
          .map((a) => norm(a.innerText || a.textContent))
          .filter(Boolean);
        return { count: ds.length, titles: ds.map(dialogTitle), alerts };`,
        stepCtx,
      );
      for (const al of lastInfo?.alerts || []) seenAlerts.add(al);
      if (lastInfo?.count === Number(wantCount)) {
        return { ok: true, count: lastInfo.count, seenAlerts: [...seenAlerts] };
      }
      if (Date.now() >= deadline) {
        throw new WorkflowError({
          code: "WORKFLOW_WAIT_DIALOGS_TIMEOUT",
          blame: "workflow",
          stepIndex: stepCtx.stepIndex,
          stepId: stepCtx.stepId,
          op: stepCtx.op,
          expected: `${actionLabel ? `点击 "${actionLabel}" 后` : ""}可见对话框数 === ${wantCount}`,
          actual: `当前可见对话框 ${lastInfo?.count} (${JSON.stringify(lastInfo?.titles || [])})，提示消息: ${JSON.stringify([...seenAlerts])}`,
          message: `等待对话框数量变为 ${wantCount} 超时`,
        });
      }
      await sleepWithAbort(150, signal);
    }
  }

  let totalMutations = 0;

  async function executePrimitive(step, params, stepCtx, currentUrl) {
    switch (step.op) {
      case "assert_url": {
        const snap = await resolvePageSnapshot().catch(() => null);
        const actualUrl = String(snap?.url || currentUrl || "");
        assertUrlNotForbidden(actualUrl, params.forbidSubstrings || [], stepCtx);
        if (params.mustEqual && actualUrl !== String(params.mustEqual)) {
          throw new WorkflowError({
            code: "WORKFLOW_URL_MISMATCH",
            blame: "workflow",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: step.op,
            expected: `URL === ${params.mustEqual}`,
            actual: actualUrl,
            message: params.wrongHostHint ? `${params.wrongHostHint}（当前: ${actualUrl}）` : `当前 URL 不匹配: ${actualUrl}`,
          });
        }
        if (params.mustStartWith && !actualUrl.startsWith(String(params.mustStartWith))) {
          throw new WorkflowError({
            code: "WORKFLOW_URL_MISMATCH",
            blame: "workflow",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: step.op,
            expected: `URL 前缀为 ${params.mustStartWith}`,
            actual: actualUrl,
            message: params.wrongHostHint ? `${params.wrongHostHint}（当前: ${actualUrl}）` : `当前 URL 前缀不匹配: ${actualUrl}`,
          });
        }
        if (params.mustInclude && !actualUrl.includes(String(params.mustInclude))) {
          throw new WorkflowError({
            code: "WORKFLOW_URL_MISMATCH",
            blame: "workflow",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: step.op,
            expected: `URL 包含 ${params.mustInclude}`,
            actual: actualUrl,
            message: `当前 URL 未包含期望子串: ${actualUrl}`,
          });
        }
        return { ok: true, url: actualUrl, didMutate: false };
      }

      case "wait_for": {
        const timeoutMs = Math.max(200, Number(params.timeoutMs) || 10000);
        const deadline = Date.now() + timeoutMs;
        const scopeSpec = params.scope || params.containerSelector || "";
        const wantSel = params.selector ? String(params.selector) : "";
        const wantText = params.text ? String(params.text) : "";
        const notLoading = Boolean(params.notLoading);
        const settleAnimations = Boolean(params.settleAnimations);
        const minRows = params.minRows !== undefined ? Number(params.minRows) : null;
        const rowSelector = String(params.rowSelector || "tbody tr, [role='row']");
        const rowMustInclude = Array.isArray(params.rowMustInclude) ? params.rowMustInclude.map(String).filter(Boolean) : [];
        const ignoreTexts = Array.isArray(params.ignoreTexts) ? params.ignoreTexts.map(String).filter(Boolean) : [];
        const modalsCount = params.modalsCount !== undefined ? Number(params.modalsCount) : null;

        let lastProbe = null;
        while (true) {
          lastProbe = await evalJs(
            `const dialogs = getDialogs(${modalsCount === 0 ? 1 : 0});
            if (${modalsCount !== null} && dialogs.length !== ${Number(modalsCount ?? 0)}) {
              return { ready: false, reason: "modals_count", modalsCount: dialogs.length, titles: dialogs.map(dialogTitle) };
            }
            const scope = resolveScope(${JSON.stringify(scopeSpec)});
            if (${Boolean(scopeSpec)} && !scope) {
              return { ready: false, reason: "scope_missing", scope: ${JSON.stringify(scopeSpec)} };
            }
            const root = scope || document.body || document.documentElement;
            if (${notLoading}) {
              const busy = [...root.querySelectorAll(ADAPTER.loadingSelector)].some((el) => isBox(el, 0));
              if (busy) return { ready: false, reason: "loading" };
            }
            if (${settleAnimations} && hasRunningAnim(root)) {
              return { ready: false, reason: "animating" };
            }
            if (${Boolean(wantSel)}) {
              const hit = [...root.querySelectorAll(${JSON.stringify(wantSel)})].some((el) => isBox(el, 0));
              if (!hit) return { ready: false, reason: "selector_missing", selector: ${JSON.stringify(wantSel)} };
            }
            if (${Boolean(wantText)}) {
              const txt = norm(root.innerText || root.textContent);
              if (!txt.includes(norm(${JSON.stringify(wantText)}))) {
                return { ready: false, reason: "text_missing", sample: txt.slice(0, 200) };
              }
            }
            if (${minRows !== null}) {
              const emptyClasses = ADAPTER.emptyRowClasses || [];
              const ignoreList = ${JSON.stringify(ignoreTexts)};
              const reqInc = ${JSON.stringify(rowMustInclude)};
              const allRows = [...root.querySelectorAll(${JSON.stringify(rowSelector)})].filter((r) => {
                if (!isBox(r, 0)) return false;
                if (r.closest("thead")) return false;
                const cls = String(r.className || "");
                if (emptyClasses.some((c) => cls.includes(c))) return false;
                const t = norm(r.innerText || r.textContent);
                if (!t) return false;
                if (ignoreList.some((ig) => t === norm(ig) || t.includes(norm(ig)))) return false;
                return true;
              });
              const matched = reqInc.length
                ? allRows.filter((r) => {
                    const t = norm(r.innerText || r.textContent);
                    return reqInc.every((sub) => t.includes(norm(sub)));
                  })
                : allRows;
              if (matched.length < ${Number(minRows ?? 0)}) {
                return {
                  ready: false,
                  reason: "rows_not_hydrated",
                  rowCount: matched.length,
                  sampleRows: [...root.querySelectorAll(${JSON.stringify(rowSelector)})].slice(0, 5).map((r) => norm(r.innerText || r.textContent).slice(0, 120)),
                };
              }
              return { ready: true, rowCount: matched.length };
            }
            return { ready: true, modalsCount: dialogs.length };`,
            stepCtx,
          );
          if (lastProbe?.ready) {
            return { ok: true, ...lastProbe, didMutate: false };
          }
          if (Date.now() >= deadline) {
            throw new WorkflowError({
              code: "WORKFLOW_WAIT_TIMEOUT",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: step.op,
              expected: `在 ${timeoutMs}ms 内满足等待条件 (${JSON.stringify({ scope: scopeSpec, selector: wantSel, text: wantText, minRows, rowMustInclude, modalsCount })})`,
              actual: JSON.stringify(lastProbe),
              message: `等待条件超时 (${lastProbe?.reason || "timeout"})`,
            });
          }
          await sleepWithAbort(150, signal);
        }
      }

      case "close_modals_if_present": {
        const cancelText = String(params.cancelText || "取消");
        const maxRounds = Math.max(1, Number(params.maxRounds ?? params.maxAttempts) || 4);
        let closedCount = 0;

        for (let round = 0; round < maxRounds; round += 1) {
          const nonce = `close_${++nonceCounter}`;
          const probe = await evalJs(
            `const ds = getDialogs(0);
            if (!ds.length) return { count: 0 };
            const top = ds[ds.length - 1];
            const want = normBtn(${JSON.stringify(cancelText)});
            const btns = [...top.querySelectorAll("button, [role='button']")].filter((b) => isBox(b, 0) && !b.disabled);
            let target = btns.find((b) => normBtn(b.innerText || b.textContent) === want);
            if (!target) {
              target = top.querySelector("button[aria-label='Close'], button[aria-label='关闭']");
              if (target && !isBox(target, 0)) target = null;
            }
            if (!target) {
              return { count: ds.length, title: dialogTitle(top), foundClose: false, buttons: btns.map((b) => norm(b.innerText || b.textContent)).slice(0, 10) };
            }
            target.setAttribute("data-pl-wf-act", ${JSON.stringify(nonce)});
            return { count: ds.length, title: dialogTitle(top), foundClose: true, btnText: norm(target.innerText || target.textContent || target.getAttribute("aria-label") || ${JSON.stringify(cancelText)}) };`,
            stepCtx,
          );
          if (!probe?.count) break;
          if (!probe.foundClose) {
            throw new WorkflowError({
              code: "WORKFLOW_MODAL_CLOSE_NOT_FOUND",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: step.op,
              expected: `顶层对话框 "${probe.title}" 存在可点击的 "${cancelText}" 或关闭按钮`,
              actual: JSON.stringify(probe),
              message: `无法安全关闭顶层对话框 "${probe.title}"`,
            });
          }
          const beforeCount = probe.count;
          await clickMarkedElement({ markNonce: nonce, buttonText: probe.btnText || cancelText, stepCtx, targetUrl: currentUrl });
          await waitForDialogsCount({
            wantCount: Math.max(0, beforeCount - 1),
            timeoutMs: Number(params.timeoutMs) || 5000,
            actionLabel: probe.btnText || cancelText,
            stepCtx,
          });
          closedCount += 1;
        }
        if (params.waitModalsCount !== undefined) {
          await waitForDialogsCount({
            wantCount: Number(params.waitModalsCount),
            timeoutMs: Number(params.timeoutMs) || 6000,
            stepCtx,
          });
        }
        return { ok: true, closedCount, didMutate: false };
      }

      case "scroll_container": {
        const res = await evalJs(
          `const scope = resolveScope(${JSON.stringify(params.scope || "")}) || document;
          const el = (${JSON.stringify(params.selector || "")} && scope.querySelector(${JSON.stringify(params.selector || "")}))
            || (${JSON.stringify(params.fallbackSelector || "")} && scope.querySelector(${JSON.stringify(params.fallbackSelector || "")}))
            || (scope !== document ? scope : document.scrollingElement);
          if (!el) return { ok: false, reason: "container_not_found" };
          if (${JSON.stringify(params.scrollLeft ?? null)} !== null) {
            el.scrollLeft = ${JSON.stringify(params.scrollLeft)} === "max" ? el.scrollWidth : Number(${JSON.stringify(params.scrollLeft || 0)});
          }
          if (${JSON.stringify(params.scrollTop ?? null)} !== null) {
            el.scrollTop = ${JSON.stringify(params.scrollTop)} === "max" ? el.scrollHeight : Number(${JSON.stringify(params.scrollTop || 0)});
          }
          el.dispatchEvent(new Event("scroll", { bubbles: true }));
          return { ok: true, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop };`,
          stepCtx,
        );
        if (!res?.ok) {
          throw new WorkflowError({
            code: "WORKFLOW_SCROLL_TARGET_MISSING",
            blame: "workflow",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: step.op,
            expected: `滚动容器存在 (${params.selector || params.fallbackSelector || params.scope})`,
            actual: JSON.stringify(res),
            message: "未找到目标滚动容器",
          });
        }
        await sleepWithAbort(120, signal);
        return { ...res, didMutate: false };
      }

      case "ensure_tab": {
        const nonce = `tab_${++nonceCounter}`;
        const probe = await evalJs(
          `const scope = resolveScope(${JSON.stringify(params.scope || "")}) || document;
          const root = ${JSON.stringify(params.containerSelector || "")} ? scope.querySelector(${JSON.stringify(params.containerSelector || "")}) : scope;
          if (!root) return { found: false };
          const tabSel = ${JSON.stringify(params.tabSelector || "[role='tab']")};
          const activeCls = ${JSON.stringify(params.activeClass || "")};
          const allowed = ${JSON.stringify(params.allowedPrefixes || [])};
          const targetPrefix = ${JSON.stringify(params.targetPrefix || "")};
          const tabs = [...root.querySelectorAll(tabSel)].filter((t) => isBox(t, 0));
          const isActive = (t) => t.getAttribute("aria-selected") === "true" || (activeCls && String(t.className || "").includes(activeCls));
          const activeTab = tabs.find(isActive);
          const activeText = activeTab ? norm(activeTab.innerText || activeTab.textContent) : "";
          if (allowed.length && allowed.some((p) => activeText.startsWith(String(p)))) {
            return { found: true, alreadyActive: true, activeText };
          }
          if (targetPrefix && activeText.startsWith(targetPrefix)) {
            return { found: true, alreadyActive: true, activeText };
          }
          const wantTab = tabs.find((t) => norm(t.innerText || t.textContent).startsWith(targetPrefix));
          if (!wantTab) return { found: false, activeText, available: tabs.map((t) => norm(t.innerText || t.textContent)) };
          wantTab.setAttribute("data-pl-wf-act", ${JSON.stringify(nonce)});
          return { found: true, alreadyActive: false, targetText: norm(wantTab.innerText || wantTab.textContent) };`,
          stepCtx,
        );
        if (!probe?.found) {
          if (params.optional) return { ok: true, skipped: true, didMutate: false };
          throw new WorkflowError({
            code: "WORKFLOW_TAB_NOT_FOUND",
            blame: "workflow",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: step.op,
            expected: `存在页签 "${params.targetPrefix || ""}"`,
            actual: JSON.stringify(probe),
            message: `未找到目标页签 "${params.targetPrefix || ""}"`,
          });
        }
        if (probe.alreadyActive) {
          return { ok: true, alreadyActive: true, activeText: probe.activeText, didMutate: false };
        }
        await clickMarkedElement({ markNonce: nonce, buttonText: probe.targetText, stepCtx, targetUrl: currentUrl });
        await sleepWithAbort(Number(params.postDelayMs) || 300, signal);
        return { ok: true, alreadyActive: false, activeText: probe.targetText, didMutate: true };
      }

      case "click_and_wait": {
        if (params.singleShotKey) {
          const key = String(params.singleShotKey);
          if (executedSingleShots.has(key)) {
            throw new WorkflowError({
              code: "WORKFLOW_SINGLE_SHOT_VIOLATION",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: step.op,
              expected: `单次动作锁 "${key}" 仅执行 1 次`,
              actual: `检测到重复执行 "${key}"`,
              message: `单次动作锁拦截重复点击: ${key}`,
            });
          }
        }

        const beforeDialogs = await evalJs(`return getDialogs(0).length;`, stepCtx);

        if (params.groupSelector && params.groupMustInclude) {
          const gNonce = `grp_${++nonceCounter}`;
          const grpProbe = await evalJs(
            `const groups = [...document.querySelectorAll(${JSON.stringify(params.groupSelector)})].filter((g) => isBox(g, 0));
            const must = norm(${JSON.stringify(params.groupMustInclude)}).toLowerCase();
            const excl = norm(${JSON.stringify(params.groupExclude || "")}).toLowerCase();
            const grp = groups.find((g) => {
              const t = norm(g.innerText || g.textContent).toLowerCase();
              return t.includes(must) && (!excl || !t.includes(excl));
            });
            if (!grp) return { foundGroup: false };
            const itemSel = ${JSON.stringify(params.selector || "a, button, [role='menuitem']")};
            const wantTxt = normBtn(${JSON.stringify(params.text || "")});
            let item = [...grp.querySelectorAll(itemSel)].find((el) => isBox(el, 0) && (!wantTxt || normBtn(el.innerText || el.textContent) === wantTxt));
            if (item) {
              item.setAttribute("data-pl-wf-act", ${JSON.stringify(gNonce)});
              return { foundGroup: true, itemReady: true, text: norm(item.innerText || item.textContent) };
            }
            const tog = grp.querySelector(${JSON.stringify(params.groupToggleSelector || "button, [role='button']")});
            if (tog && isBox(tog, 0)) {
              tog.setAttribute("data-pl-wf-act", ${JSON.stringify(gNonce)});
              return { foundGroup: true, itemReady: false, toggleReady: true, text: norm(tog.innerText || tog.textContent) };
            }
            return { foundGroup: true, itemReady: false, toggleReady: false };`,
            stepCtx,
          );
          if (!grpProbe?.foundGroup) {
            throw new WorkflowError({
              code: "WORKFLOW_MENU_GROUP_NOT_FOUND",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: step.op,
              expected: `存在导航分组包含 "${params.groupMustInclude}"`,
              actual: JSON.stringify(grpProbe),
              message: `未找到目标导航分组 "${params.groupMustInclude}"`,
            });
          }
          if (!grpProbe.itemReady && grpProbe.toggleReady) {
            await clickMarkedElement({ markNonce: gNonce, buttonText: grpProbe.text, stepCtx, targetUrl: currentUrl });
            await sleepWithAbort(350, signal);
            const subNonce = `sub_${++nonceCounter}`;
            const subProbe = await evalJs(
              `const groups = [...document.querySelectorAll(${JSON.stringify(params.groupSelector)})].filter((g) => isBox(g, 0));
              const must = norm(${JSON.stringify(params.groupMustInclude)}).toLowerCase();
              const excl = norm(${JSON.stringify(params.groupExclude || "")}).toLowerCase();
              const grp = groups.find((g) => {
                const t = norm(g.innerText || g.textContent).toLowerCase();
                return t.includes(must) && (!excl || !t.includes(excl));
              });
              const item = grp ? [...grp.querySelectorAll(${JSON.stringify(params.selector || "a, button")})].find((el) => isBox(el, 0) && normBtn(el.innerText || el.textContent) === normBtn(${JSON.stringify(params.text || "")})) : null;
              if (!item) return { found: false };
              item.setAttribute("data-pl-wf-act", ${JSON.stringify(subNonce)});
              return { found: true, text: norm(item.innerText || item.textContent) };`,
              stepCtx,
            );
            if (!subProbe?.found) {
              throw new WorkflowError({
                code: "WORKFLOW_MENU_ITEM_NOT_FOUND",
                blame: "workflow",
                stepIndex: stepCtx.stepIndex,
                stepId: stepCtx.stepId,
                op: step.op,
                expected: `分组 "${params.groupMustInclude}" 下存在菜单项 "${params.text}"`,
                actual: JSON.stringify(subProbe),
                message: `展开分组后未找到菜单项 "${params.text}"`,
              });
            }
            await clickMarkedElement({ markNonce: subNonce, buttonText: params.text || subProbe.text, stepCtx, targetUrl: currentUrl });
          } else if (grpProbe.itemReady) {
            await clickMarkedElement({ markNonce: gNonce, buttonText: params.text || grpProbe.text, stepCtx, targetUrl: currentUrl });
          }
        } else {
          const nonce = `clk_${++nonceCounter}`;
          const scopeSpec = params.scope || params.containerSelector || "";
          const fieldLabel = params.fieldLabel ? String(params.fieldLabel) : "";
          const wantText = params.text ? String(params.text) : "";
          const sel = params.selector ? String(params.selector) : "button, [role='button'], a";

          const markRes = await evalJs(
            `const base = resolveScope(${JSON.stringify(scopeSpec)});
            if (${Boolean(scopeSpec)} && !base) return { found: false, reason: "scope_missing" };
            const scope = ${Boolean(fieldLabel)} ? findFieldScope(base || document.body, ${JSON.stringify(fieldLabel)}) : (base || document.body);
            if (!scope) return { found: false, reason: "field_scope_missing" };
            const want = normBtn(${JSON.stringify(wantText)});
            const cands = [...scope.querySelectorAll(${JSON.stringify(sel)})].filter((el) => isBox(el, 0) && !el.disabled && el.getAttribute("aria-disabled") !== "true");
            const exact = want ? cands.filter((el) => normBtn(el.innerText || el.textContent || el.getAttribute("aria-label")) === want) : cands;
            const target = exact[Number(${Number(params.nth || 0)})] || null;
            if (!target) return { found: false, available: cands.slice(0, 12).map((el) => norm(el.innerText || el.textContent || el.getAttribute("aria-label"))) };
            target.setAttribute("data-pl-wf-act", ${JSON.stringify(nonce)});
            return { found: true, text: norm(target.innerText || target.textContent || target.getAttribute("aria-label")) };`,
            stepCtx,
          );

          if (!markRes?.found) {
            if (params.onlyIfVisible) {
              return { ok: true, skipped: true, didMutate: false };
            }
            throw new WorkflowError({
              code: "WORKFLOW_CLICK_TARGET_NOT_FOUND",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: step.op,
              expected: `可见可点击控件 (${wantText || sel})`,
              actual: JSON.stringify(markRes),
              message: `未找到目标点击控件: ${wantText || sel}`,
            });
          }

          if (params.singleShotKey) executedSingleShots.add(String(params.singleShotKey));
          await clickMarkedElement({ markNonce: nonce, buttonText: wantText || markRes.text, stepCtx, targetUrl: currentUrl });
        }

        if (params.waitModalsCount !== undefined) {
          await waitForDialogsCount({
            wantCount: Number(params.waitModalsCount),
            timeoutMs: Number(params.timeoutMs) || 10000,
            actionLabel: params.text || params.selector || "",
            stepCtx,
          });
        } else if (params.waitModalsDelta !== undefined) {
          await waitForDialogsCount({
            wantCount: Math.max(0, Number(beforeDialogs) + Number(params.waitModalsDelta)),
            timeoutMs: Number(params.timeoutMs) || 10000,
            actionLabel: params.text || params.selector || "",
            stepCtx,
          });
        }

        if (params.waitText || params.waitSelector) {
          const timeoutMs = Math.max(300, Number(params.timeoutMs) || 10000);
          const deadline = Date.now() + timeoutMs;
          const seenAlerts = new Set();
          while (true) {
            const check = await evalJs(
              `const alerts = [...document.querySelectorAll(ADAPTER.alertSelector)].filter((a) => isBox(a, 0)).map((a) => norm(a.innerText || a.textContent)).filter(Boolean);
              const txtOk = !${Boolean(params.waitText)} || norm(document.body?.innerText || document.body?.textContent || "").includes(norm(${JSON.stringify(params.waitText || "")}));
              const selOk = !${Boolean(params.waitSelector)} || Boolean(resolveScope(${JSON.stringify(params.waitSelector || "")}));
              return { ok: txtOk && selOk, alerts };`,
              stepCtx,
            );
            for (const al of check?.alerts || []) seenAlerts.add(al);
            if (check?.ok) break;
            if (Date.now() >= deadline) {
              throw new WorkflowError({
                code: "WORKFLOW_CLICK_WAIT_TIMEOUT",
                blame: "workflow",
                stepIndex: stepCtx.stepIndex,
                stepId: stepCtx.stepId,
                op: step.op,
                expected: `点击 "${params.text || params.selector}" 后出现 ${params.waitText || params.waitSelector}`,
                actual: `等待超时；捕获提示: ${JSON.stringify([...seenAlerts])}`,
                message: seenAlerts.size > 0
                  ? `点击后未进入目标状态，页面提示: ${[...seenAlerts].join("；")}`
                  : `点击 "${params.text || params.selector}" 后等待 "${params.waitText || params.waitSelector}" 超时`,
              });
            }
            await sleepWithAbort(150, signal);
          }
        }

        if (params.postDelayMs) {
          await sleepWithAbort(Number(params.postDelayMs), signal);
        }
        return { ok: true, clicked: params.text || params.selector || true, didMutate: Boolean(params.countsAsMutation) };
      }

      case "fill_input": {
        const rawItems = Array.isArray(params.items) ? params.items : [params];
        const itemResults = [];
        let changedTotal = 0;

        for (const item of rawItems) {
          const scopeSpec = item.scope || params.scope || params.containerSelector || "";
          const fieldLabel = item.fieldLabel ? String(item.fieldLabel) : "";
          const sel = item.selector ? String(item.selector) : "input, textarea";
          const wantVal = String(item.value ?? "");
          const fillAll = Boolean(item.all);
          const nth = Number(item.nth || 0);
          const nonce = `inp_${++nonceCounter}`;

          const probe = await evalJs(
            `const base = resolveScope(${JSON.stringify(scopeSpec)});
            if (${Boolean(scopeSpec)} && !base) return { found: false, reason: "scope_missing" };
            const scope = ${Boolean(fieldLabel)} ? findFieldScope(base || document.body, ${JSON.stringify(fieldLabel)}) : (base || document.body);
            if (!scope) return { found: false, reason: "field_not_found", fieldLabel: ${JSON.stringify(fieldLabel)} };
            const allInputs = qSelfOrAll(scope, ${JSON.stringify(sel)}).filter((el) => {
              if (!isBox(el, 0) || el.disabled || el.readOnly) return false;
              const tp = String(el.type || "").toLowerCase();
              if (${Boolean(fieldLabel)} && ["hidden", "checkbox", "radio", "search", "file", "button", "submit"].includes(tp)) return false;
              if (${Boolean(fieldLabel)} && el.closest(ADAPTER.comboboxRootSelector || "select") && tp === "search") return false;
              return true;
            });
            const targets = ${fillAll} ? allInputs : (allInputs[${nth}] ? [allInputs[${nth}]] : []);
            if (!targets.length) return { found: false, count: 0 };
            targets.forEach((el, idx) => el.setAttribute("data-pl-wf-inp", ${JSON.stringify(nonce)} + "_" + idx));
            return { found: true, count: targets.length, values: targets.map((el) => String(el.value ?? "")) };`,
            stepCtx,
          );

          if (!probe?.found) {
            throw new WorkflowError({
              code: "WORKFLOW_INPUT_NOT_FOUND",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: step.op,
              expected: `输入框存在 (${fieldLabel || sel})`,
              actual: JSON.stringify(probe),
              message: `未找到可编辑输入框: ${fieldLabel || sel}`,
            });
          }

          try {
            let itemChanged = 0;
            for (let idx = 0; idx < probe.count; idx += 1) {
              if (probe.values[idx] === wantVal) continue;
              const targetSel = `[data-pl-wf-inp="${nonce}_${idx}"]`;
              const { parsed, text } = await invokeRawTool("fill", { selector: targetSel, value: wantVal }, stepCtx);
              if (!parsed || parsed.ok === false) {
                throw new WorkflowError({
                  code: "WORKFLOW_FILL_FAILED",
                  blame: "工具",
                  stepIndex: stepCtx.stepIndex,
                  stepId: stepCtx.stepId,
                  op: step.op,
                  expected: `成功填入 "${wantVal}" (${fieldLabel || sel})`,
                  actual: text.slice(0, 300),
                  message: `输入框填写失败 (${fieldLabel || sel}): ${text.slice(0, 200)}`,
                });
              }
              if (item.blur) {
                await evalRawJs(
                  `const el = document.querySelector(${JSON.stringify(targetSel)});
                  if (el) { el.dispatchEvent(new Event("change", { bubbles: true })); el.blur?.(); }
                  return true;`,
                  stepCtx,
                );
              }
              itemChanged += 1;
            }

            const readback = await evalRawJs(
              `const vals = [];
              for (let i = 0; i < ${probe.count}; i += 1) {
                const el = document.querySelector(${JSON.stringify(`[data-pl-wf-inp="${nonce}_`)} + i + '"]');
                vals.push(el ? String(el.value ?? "") : null);
              }
              return vals;`,
              stepCtx,
            );
            if (!Array.isArray(readback) || readback.some((v) => v !== wantVal)) {
              throw new WorkflowError({
                code: "WORKFLOW_INPUT_READBACK_MISMATCH",
                blame: "workflow",
                stepIndex: stepCtx.stepIndex,
                stepId: stepCtx.stepId,
                op: step.op,
                expected: `${fieldLabel || sel} 回读值全部 === "${wantVal}"`,
                actual: `实读序列: ${JSON.stringify(readback)}`,
                message: `填写后回读校验不一致 (${fieldLabel || sel})`,
              });
            }
            changedTotal += itemChanged;
            itemResults.push({
              target: fieldLabel || sel,
              count: probe.count,
              changed: itemChanged,
              skipped: itemChanged === 0,
              value: wantVal,
            });
          } finally {
            await invokeRawTool(
              "run_js",
              {
                code: `for (const el of document.querySelectorAll('[data-pl-wf-inp^="${nonce}_"]')) el.removeAttribute('data-pl-wf-inp'); return true;`,
              },
              stepCtx,
            ).catch(() => {});
          }
        }

        return { ok: true, items: itemResults, changed: changedTotal, didMutate: changedTotal > 0 };
      }

      case "ensure_select": {
        if (params.groupSelector && Array.isArray(params.groupValues)) {
          const scopeSpec = params.scope || params.containerSelector || "@topDialog";
          const groupSel = String(params.groupSelector);
          const selectSel = String(params.selectSelector || adapterSpec.comboboxRootSelector);
          const groupVals = params.groupValues.map(String);
          const nonce = `gsel_${++nonceCounter}`;

          const probe = await evalJs(
            `const scope = resolveScope(${JSON.stringify(scopeSpec)}) || document.body;
            const groups = [...scope.querySelectorAll(${JSON.stringify(groupSel)})].filter((g) => isBox(g, 0));
            if (!groups.length) return { found: false, groupCount: 0 };
            const tasks = [];
            groups.forEach((g, gi) => {
              const sels = [...g.querySelectorAll(${JSON.stringify(selectSel)})].filter((s) => isBox(s, 0));
              for (let vi = 0; vi < ${groupVals.length}; vi += 1) {
                const s = sels[vi];
                if (!s) continue;
                const cur = readSingleRootSelected(s)[0] || "";
                const tag = ${JSON.stringify(nonce)} + "_" + gi + "_" + vi;
                s.setAttribute("data-pl-wf-sel", tag);
                tasks.push({ tag, groupIndex: gi, selectIndex: vi, current: cur, want: ${JSON.stringify(groupVals)}[vi] });
              }
            });
            return { found: tasks.length > 0, groupCount: groups.length, tasks };`,
            stepCtx,
          );

          if (!probe?.found) {
            throw new WorkflowError({
              code: "WORKFLOW_SELECT_GROUP_NOT_FOUND",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: step.op,
              expected: `存在可见下拉组 ${groupSel}`,
              actual: JSON.stringify(probe),
              message: `未找到目标下拉分组 ${groupSel}`,
            });
          }

          const results = [];
          try {
            for (const task of probe.tasks) {
              if (task.current === task.want) {
                results.push({ ...task, alreadySelected: true });
                continue;
              }
              const selAttr = `[data-pl-wf-sel="${task.tag}"]`;
              const { parsed, text } = await invokeRawTool("select_option", { selector: selAttr, value: task.want }, stepCtx);
              if (!parsed || parsed.ok !== true) {
                throw new WorkflowError({
                  code: "WORKFLOW_SELECT_FAILED",
                  blame: "workflow",
                  stepIndex: stepCtx.stepIndex,
                  stepId: stepCtx.stepId,
                  op: step.op,
                  expected: `${groupSel}[${task.groupIndex}][${task.selectIndex}] 选择 "${task.want}"`,
                  actual: text.slice(0, 350),
                  message: `分组下拉选择失败 (${task.want}): ${text.slice(0, 200)}`,
                });
              }
              await sleepWithAbort(120, signal);
              results.push({ ...task, alreadySelected: false });
            }
          } finally {
            await invokeRawTool(
              "run_js",
              { code: `for (const el of document.querySelectorAll('[data-pl-wf-sel^="${nonce}_"]')) el.removeAttribute('data-pl-wf-sel'); return true;` },
              stepCtx,
            ).catch(() => {});
          }
          const mutated = results.some((r) => !r.alreadySelected);
          return { ok: true, results, didMutate: mutated };
        }

        const rawItems = Array.isArray(params.items) ? params.items : [params];
        const results = [];

        for (const item of rawItems) {
          const scopeSpec = item.scope || params.scope || params.containerSelector || "@topDialog";
          const fieldLabel = item.fieldLabel || item.label ? String(item.fieldLabel || item.label) : "";
          const labelAliases = Array.isArray(item.labelAliases) ? item.labelAliases.map(String) : [];
          const rowText = item.rowText ? String(item.rowText) : "";
          const sel = item.selector ? String(item.selector) : "";
          const nth = Number(item.nth || 0);
          const wantVal = String(item.value ?? "");
          const syncActionText = item.syncActionText ? String(item.syncActionText) : "";
          const hydrateWaitMs = Number(item.hydrateWaitMs || params.hydrateWaitMs || 0);
          const nonce = `sel_${++nonceCounter}`;

          const probeSelectControl = () =>
            evalJs(
              `const base = resolveScope(${JSON.stringify(scopeSpec)}) || document.body;
              const candidates = [${JSON.stringify(fieldLabel)}, ...${JSON.stringify(labelAliases)}].filter(Boolean);
              let fieldBox = null;
              let matchedLabel = "";
              for (const cand of candidates) {
                fieldBox = findFieldScope(base, cand);
                if (fieldBox) { matchedLabel = cand; break; }
              }
              if (candidates.length > 0 && !fieldBox && !${Boolean(sel)}) {
                return { found: false, reason: "field_label_not_found", triedLabels: candidates };
              }
              let searchRoot = fieldBox || base;
              if (${Boolean(rowText)} && fieldBox) {
                const rowHit = [...fieldBox.querySelectorAll("tbody tr, [role='row']")].find((r) => isBox(r, 0) && norm(r.innerText || r.textContent).includes(norm(${JSON.stringify(rowText)})));
                if (rowHit) searchRoot = rowHit;
              }
              const rawMatches = ${Boolean(sel)}
                ? qSelfOrAll(searchRoot, ${JSON.stringify(sel)}).filter((e) => isBox(e, 0))
                : qSelfOrAll(searchRoot, ADAPTER.comboboxRootSelector).filter((e) => isBox(e, 0));
              const target = rawMatches[${nth}] || null;
              if (!target) {
                return { found: false, reason: "select_control_not_found", matchedLabel, count: rawMatches.length };
              }
              const root = target.tagName === "SELECT" ? target : (target.closest(ADAPTER.comboboxRootSelector) || target);
              root.setAttribute("data-pl-wf-sel", ${JSON.stringify(nonce)});
              if (fieldBox) fieldBox.setAttribute("data-pl-wf-fbox", ${JSON.stringify(nonce)});
              const currentItems = readSingleRootSelected(root);
              return { found: true, matchedLabel, currentItems };`,
              stepCtx,
            );

          const probe = await probeSelectControl();

          if (!probe?.found) {
            throw new WorkflowError({
              code: "WORKFLOW_SELECT_NOT_FOUND",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: step.op,
              expected: `存在下拉控件 (${fieldLabel || sel})`,
              actual: JSON.stringify(probe),
              message: `下拉定位失败 (${fieldLabel || sel})`,
            });
          }

          try {
            const curItems = Array.isArray(probe.currentItems) ? probe.currentItems : [];
            if (item.preserveExistingNonEmpty && curItems.length > 0) {
              if (item.saveSelectedBindKey) saveToBinds(runtimeBinds, item.saveSelectedBindKey, curItems);
              results.push({ target: fieldLabel || sel, alreadySelected: true, selected: curItems });
              continue;
            }
            if (curItems.length === 1 && curItems[0] === wantVal) {
              if (item.saveSelectedBindKey) saveToBinds(runtimeBinds, item.saveSelectedBindKey, curItems);
              results.push({ target: fieldLabel || sel, alreadySelected: true, selected: curItems });
              continue;
            }
            if (curItems.includes(wantVal) && item.allowAdditionalSelected) {
              if (item.saveSelectedBindKey) saveToBinds(runtimeBinds, item.saveSelectedBindKey, curItems);
              results.push({ target: fieldLabel || sel, alreadySelected: true, selected: curItems });
              continue;
            }

            const selAttr = `[data-pl-wf-sel="${nonce}"]`;
            let pickOut = await invokeRawTool("select_option", { selector: selAttr, value: wantVal }, stepCtx);

            if ((!pickOut.parsed || pickOut.parsed.ok !== true) && syncActionText) {
              const syncNonce = `sync_${++nonceCounter}`;
              const syncMarked = await evalJs(
                `const fbox = document.querySelector(${JSON.stringify(`[data-pl-wf-fbox="${nonce}"]`)}) || resolveScope(${JSON.stringify(scopeSpec)}) || document.body;
                const want = normBtn(${JSON.stringify(syncActionText)});
                const btn = [...fbox.querySelectorAll("button, a, [role='button'], span")].find((el) => isBox(el, 0) && normBtn(el.innerText || el.textContent) === want);
                if (!btn) return { found: false };
                btn.setAttribute("data-pl-wf-act", ${JSON.stringify(syncNonce)});
                return { found: true, text: norm(btn.innerText || btn.textContent) };`,
                stepCtx,
              );
              if (syncMarked?.found) {
                await clickMarkedElement({ markNonce: syncNonce, buttonText: syncActionText, stepCtx, targetUrl: currentUrl });
                await sleepWithAbort(Math.max(800, hydrateWaitMs || 1500), signal);
                await probeSelectControl();
                pickOut = await invokeRawTool("select_option", { selector: selAttr, value: wantVal }, stepCtx);
              }
            }

            if (!pickOut.parsed || pickOut.parsed.ok !== true) {
              throw new WorkflowError({
                code: "WORKFLOW_SELECT_OPTION_FAILED",
                blame: "workflow",
                stepIndex: stepCtx.stepIndex,
                stepId: stepCtx.stepId,
                op: step.op,
                expected: `下拉 (${fieldLabel || sel}) 成功选择 "${wantVal}"`,
                actual: pickOut.text.slice(0, 350),
                message: `下拉选择失败 (${fieldLabel || sel} -> ${wantVal}): ${pickOut.text.slice(0, 200)}`,
              });
            }

            if (hydrateWaitMs > 0) {
              await sleepWithAbort(hydrateWaitMs, signal);
            }

            const postProbe = await probeSelectControl();
            const postItems = Array.isArray(postProbe?.currentItems) ? postProbe.currentItems : [];
            if (!Array.isArray(postItems) || !postItems.includes(wantVal)) {
              throw new WorkflowError({
                code: "WORKFLOW_SELECT_READBACK_MISMATCH",
                blame: "workflow",
                stepIndex: stepCtx.stepIndex,
                stepId: stepCtx.stepId,
                op: step.op,
                expected: `下拉 (${fieldLabel || sel}) 已选项包含 "${wantVal}"`,
                actual: `实读已选: ${JSON.stringify(postItems)}`,
                message: `下拉选择后回读不一致 (${fieldLabel || sel})`,
              });
            }

            if (item.saveSelectedBindKey) saveToBinds(runtimeBinds, item.saveSelectedBindKey, postItems);
            results.push({ target: fieldLabel || sel, alreadySelected: Boolean(pickOut.parsed.alreadySelected), selected: postItems });
          } finally {
            await cleanupAttr("data-pl-wf-sel", nonce, stepCtx);
            await cleanupAttr("data-pl-wf-fbox", nonce, stepCtx);
          }
        }

        const didMutate = results.some((r) => !r.alreadySelected);
        return { ok: true, results, didMutate };
      }

      case "ensure_cascader": {
        const scopeSpec = params.scope || params.containerSelector || "@topDialog";
        const sel = String(params.selector || "");
        const fieldLabel = params.fieldLabel ? String(params.fieldLabel) : "";
        const expectedNorm = normalizePathText(params.expectedText || "");
        const nonce = `cas_${++nonceCounter}`;

        const probeCascader = () =>
          evalJs(
            `const base = resolveScope(${JSON.stringify(scopeSpec)}) || document.body;
            const scope = ${Boolean(fieldLabel)} ? findFieldScope(base, ${JSON.stringify(fieldLabel)}) : base;
            if (!scope) return { found: false };
            const inp = ${Boolean(sel)} ? scope.querySelector(${JSON.stringify(sel)}) : scope.querySelector(ADAPTER.comboboxRootSelector);
            if (!inp) return { found: false };
            const root = inp.closest(ADAPTER.comboboxRootSelector) || inp;
            root.setAttribute("data-pl-wf-cas", ${JSON.stringify(nonce)});
            if (inp.tagName === "INPUT") inp.setAttribute("data-pl-wf-cas-inp", ${JSON.stringify(nonce)});
            const current = readSingleRootSelected(root)[0] || norm(inp.value || "");
            return { found: true, current, hasInput: inp.tagName === "INPUT" };`,
            stepCtx,
          );

        const probe = await probeCascader();

        if (!probe?.found) {
          throw new WorkflowError({
            code: "WORKFLOW_CASCADER_NOT_FOUND",
            blame: "workflow",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: step.op,
            expected: `存在级联选择控件 (${fieldLabel || sel})`,
            actual: JSON.stringify(probe),
            message: `未找到级联控件: ${fieldLabel || sel}`,
          });
        }

        try {
          if (expectedNorm && normalizePathText(probe.current) === expectedNorm) {
            return { ok: true, skipped: true, alreadySelected: true, value: probe.current, didMutate: false };
          }

          if (params.mode === "search") {
            const inpSel = probe.hasInput ? `[data-pl-wf-cas-inp="${nonce}"]` : `[data-pl-wf-cas="${nonce}"]`;
            await invokeRawTool("click", { selector: `[data-pl-wf-cas="${nonce}"]` }, stepCtx);
            await sleepWithAbort(150, signal);
            await invokeRawTool("fill", { selector: inpSel, value: String(params.searchValue || "") }, stepCtx);

            const timeoutMs = Math.max(1000, Number(params.timeoutMs) || 12000);
            const deadline = Date.now() + timeoutMs;
            const optNonce = `casopt_${++nonceCounter}`;
            const wantSegs = expectedNorm.split(" / ").filter(Boolean);
            let matchedOpt = null;

            while (Date.now() < deadline) {
              matchedOpt = await evalJs(
                `const optSel = ${JSON.stringify(params.optionSelector || "[role='menuitemcheckbox'], [role='option'], li")};
                const segs = ${JSON.stringify(wantSegs)};
                const cands = [...document.querySelectorAll(optSel)].filter((el) => isBox(el, 0));
                const hit = cands.find((el) => {
                  const t = norm(el.innerText || el.textContent).replace(/\\s*(?:->|\\/|›|>)\\s*/g, " / ");
                  return segs.every((s) => t.includes(s));
                });
                if (!hit) return { found: false, sample: cands.slice(0, 6).map((e) => norm(e.innerText || e.textContent)) };
                hit.setAttribute("data-pl-wf-act", ${JSON.stringify(optNonce)});
                return { found: true, text: norm(hit.innerText || hit.textContent) };`,
                stepCtx,
              );
              if (matchedOpt?.found) break;
              await sleepWithAbort(200, signal);
            }

            if (!matchedOpt?.found) {
              throw new WorkflowError({
                code: "WORKFLOW_CASCADER_OPTION_NOT_FOUND",
                blame: "workflow",
                stepIndex: stepCtx.stepIndex,
                stepId: stepCtx.stepId,
                op: step.op,
                expected: `检索 "${params.searchValue}" 后出现级联路径 "${params.expectedText}"`,
                actual: JSON.stringify(matchedOpt),
                message: `未找到匹配级联路径 "${params.expectedText}"`,
              });
            }

            await clickMarkedElement({ markNonce: optNonce, buttonText: "", stepCtx, targetUrl: currentUrl });
          } else {
            const levels = Array.isArray(params.levels) ? params.levels.map(String).filter(Boolean) : [];
            await invokeRawTool("click", { selector: `[data-pl-wf-cas="${nonce}"]` }, stepCtx);
            await sleepWithAbort(200, signal);
            for (const lvl of levels) {
              const { parsed, text } = await invokeRawTool("click", { text: lvl }, stepCtx);
              if (!parsed || parsed.ok !== true) {
                throw new WorkflowError({
                  code: "WORKFLOW_CASCADER_LEVEL_FAILED",
                  blame: "workflow",
                  stepIndex: stepCtx.stepIndex,
                  stepId: stepCtx.stepId,
                  op: step.op,
                  expected: `点击级联层级 "${lvl}"`,
                  actual: text.slice(0, 300),
                  message: `点击级联层级 "${lvl}" 失败`,
                });
              }
              await sleepWithAbort(200, signal);
            }
          }

          if (params.postWaitSelector) {
            const waitDl = Date.now() + (Number(params.timeoutMs) || 10000);
            while (Date.now() < waitDl) {
              const okPost = await evalJs(
                `const base = resolveScope(${JSON.stringify(scopeSpec)}) || document.body;
                return [...base.querySelectorAll(${JSON.stringify(params.postWaitSelector)})].some((e) => isBox(e, 0));`,
                stepCtx,
              );
              if (okPost) break;
              await sleepWithAbort(180, signal);
            }
          }

          const postProbe = await probeCascader();
          const postVal = postProbe?.current || "";
          if (expectedNorm && normalizePathText(postVal) !== expectedNorm) {
            throw new WorkflowError({
              code: "WORKFLOW_CASCADER_READBACK_MISMATCH",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: step.op,
              expected: `级联回读路径 === "${expectedNorm}"`,
              actual: `实读路径 === "${normalizePathText(postVal)}"`,
              message: `级联选择后回读不一致 (${fieldLabel || sel})`,
            });
          }
          return { ok: true, skipped: false, alreadySelected: false, value: postVal, didMutate: true };
        } finally {
          await cleanupAttr("data-pl-wf-cas", nonce, stepCtx);
          await cleanupAttr("data-pl-wf-cas-inp", nonce, stepCtx);
        }
      }

      case "ensure_radio": {
        const scopeSpec = params.scope || params.containerSelector || "@topDialog";
        const fieldLabel = params.fieldLabel ? String(params.fieldLabel) : "";
        const preferList = Array.isArray(params.preferValues)
          ? params.preferValues.map(String).filter(Boolean)
          : params.value !== undefined
            ? [String(params.value)]
            : [];
        const groupIndex = params.groupIndex !== undefined ? Number(params.groupIndex) : null;
        const nonce = `rad_${++nonceCounter}`;

        const probe = await evalJs(
          `const base = resolveScope(${JSON.stringify(scopeSpec)}) || document.body;
          const scope = ${Boolean(fieldLabel)} ? (findFieldScope(base, ${JSON.stringify(fieldLabel)}) || base) : base;
          let radioRoot = scope;
          if (${groupIndex !== null}) {
            const groups = [...scope.querySelectorAll(ADAPTER.radioGroupSelector || '[role="radiogroup"]')].filter((g) => isBox(g, 0));
            if (groups[${Number(groupIndex ?? 0)}]) radioRoot = groups[${Number(groupIndex ?? 0)}];
          }
          const inputs = [...radioRoot.querySelectorAll('input[type="radio"], [role="radio"]')];
          const options = inputs.map((r) => {
            const wrap = r.closest("label") || (r.id ? radioRoot.querySelector('label[for="' + CSS.escape(r.id) + '"]') : null) || r;
            const text = normBtn(r.getAttribute("aria-label") || wrap.innerText || wrap.textContent);
            const checked = r.tagName === "INPUT" ? r.checked : r.getAttribute("aria-checked") === "true";
            return { r, wrap, text, checked };
          }).filter((o) => o.text && isBox(o.wrap, 0));
          if (!options.length) return { found: false, options: [] };
          const prefers = ${JSON.stringify(preferList)}.map(normBtn);
          let chosen = null;
          for (const p of prefers) {
            chosen = options.find((o) => o.text === p);
            if (chosen) break;
          }
          if (!chosen && ${Boolean(params.fallbackFirstOption)}) chosen = options[0];
          if (!chosen) return { found: false, available: options.map((o) => o.text) };
          if (chosen.checked) return { found: true, alreadyChecked: true, value: chosen.text };
          chosen.wrap.setAttribute("data-pl-wf-act", ${JSON.stringify(nonce)});
          return { found: true, alreadyChecked: false, value: chosen.text };`,
          stepCtx,
        );

        if (!probe?.found) {
          throw new WorkflowError({
            code: "WORKFLOW_RADIO_NOT_FOUND",
            blame: "workflow",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: step.op,
            expected: `单选项存在 (${JSON.stringify(preferList)})`,
            actual: JSON.stringify(probe),
            message: `未找到目标单选项 (${JSON.stringify(preferList)})`,
          });
        }

        if (params.saveSelectedBindKey) saveToBinds(runtimeBinds, params.saveSelectedBindKey, probe.value);
        if (probe.alreadyChecked) {
          return { ok: true, skipped: true, value: probe.value, didMutate: false };
        }
        await clickMarkedElement({ markNonce: nonce, buttonText: probe.value, stepCtx, targetUrl: currentUrl });
        await sleepWithAbort(120, signal);
        return { ok: true, skipped: false, value: probe.value, didMutate: true };
      }

      case "ensure_checkboxes": {
        const scopeSpec = params.scope || params.containerSelector || "@topDialog";
        const fieldLabel = params.fieldLabel ? String(params.fieldLabel) : "";
        const wantList = Array.isArray(params.equals) ? params.equals.map(String) : [];
        const excludeLabels = Array.isArray(params.excludeLabels) ? params.excludeLabels.map(String) : ["全选"];
        const nonce = `chk_${++nonceCounter}`;

        const probe = await evalJs(
          `const base = resolveScope(${JSON.stringify(scopeSpec)}) || document.body;
          let scope = base;
          if (${Boolean(fieldLabel)}) {
            scope = findFieldScope(base, ${JSON.stringify(fieldLabel)});
            if (!scope) return { found: false, reason: "field_label_not_found", fieldLabel: ${JSON.stringify(fieldLabel)} };
          }
          const ignore = new Set(${JSON.stringify(excludeLabels)}.map(norm));
          const wantSet = new Set(${JSON.stringify(wantList)}.map(norm));
          const boxes = [...scope.querySelectorAll('input[type="checkbox"], [role="checkbox"]')];
          const items = [];
          for (const cb of boxes) {
            const wrap = cb.closest("label") || (cb.id ? scope.querySelector('label[for="' + CSS.escape(cb.id) + '"]') : null) || cb;
            if (!isBox(wrap, 0)) continue;
            const label = norm(cb.getAttribute("aria-label") || wrap.innerText || wrap.textContent);
            if (!label || ignore.has(label)) continue;
            const checked = cb.tagName === "INPUT" ? cb.checked : cb.getAttribute("aria-checked") === "true";
            const shouldCheck = wantSet.has(label);
            items.push({ wrap, label, checked, shouldCheck, delta: checked !== shouldCheck });
          }
          const missingLabels = [...wantSet].filter((w) => !items.some((it) => it.label === w));
          if (missingLabels.length) return { found: false, reason: "checkbox_label_missing", missingLabels, available: items.slice(0, 20).map((x) => x.label) };
          const deltas = items.filter((it) => it.delta);
          deltas.forEach((it, idx) => it.wrap.setAttribute("data-pl-wf-chk", ${JSON.stringify(nonce)} + "_" + idx));
          return {
            found: true,
            deltaCount: deltas.length,
            deltas: deltas.map((d, idx) => ({ idx, label: d.label, from: d.checked, to: d.shouldCheck })),
            checkedBefore: items.filter((x) => x.checked).map((x) => x.label),
          };`,
          stepCtx,
        );

        if (!probe?.found) {
          throw new WorkflowError({
            code: "WORKFLOW_CHECKBOXES_NOT_FOUND",
            blame: "workflow",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: step.op,
            expected: `复选框组 (${fieldLabel || scopeSpec}) 包含 ${JSON.stringify(wantList)}`,
            actual: JSON.stringify(probe),
            message: `复选框定位失败 (${fieldLabel || scopeSpec})`,
          });
        }

        try {
          for (const d of probe.deltas || []) {
            await clickMarkedElement({
              markNonce: null,
              selectorOverride: `[data-pl-wf-chk="${nonce}_${d.idx}"]`,
              buttonText: d.label,
              stepCtx,
              targetUrl: currentUrl,
            });
            await sleepWithAbort(100, signal);
          }
          if (probe.deltaCount > 0 && params.hydrateWaitMs) {
            await sleepWithAbort(Number(params.hydrateWaitMs), signal);
          }
          return {
            ok: true,
            mutatedCount: probe.deltaCount,
            equals: wantList,
            didMutate: probe.deltaCount > 0,
          };
        } finally {
          await invokeRawTool(
            "run_js",
            { code: `for (const el of document.querySelectorAll('[data-pl-wf-chk^="${nonce}_"]')) el.removeAttribute('data-pl-wf-chk'); return true;` },
            stepCtx,
          ).catch(() => {});
        }
      }

      case "row_action": {
        const scopeSpec = params.scope || params.containerSelector || "";
        const rowSel = String(params.rowSelector || "tbody tr, [role='row']");
        const mustAll = (params.mustIncludeAll || []).map(String).filter(Boolean);
        const excl = (params.excludeSubstrings || []).map(String).filter(Boolean);
        const btnText = String(params.buttonText || "");
        const mode = String(params.mode || "click");
        const nonce = `row_${++nonceCounter}`;
        const beforeDialogs = await evalJs(`return getDialogs(0).length;`, stepCtx);

        const probe = await evalJs(
          `const scope = resolveScope(${JSON.stringify(scopeSpec)}) || document.body;
          const rows = [...scope.querySelectorAll(${JSON.stringify(rowSel)})].filter((r) => isBox(r, 0) && !r.closest("thead"));
          const matched = rows.filter((r) => {
            const t = norm(r.innerText || r.textContent);
            return ${JSON.stringify(mustAll)}.every((k) => t.includes(norm(k)))
              && !${JSON.stringify(excl)}.some((ex) => ex && t.includes(norm(ex)));
          });
          if (matched.length !== 1) {
            return { ok: false, count: matched.length, sampleRows: rows.slice(0, 6).map((r) => norm(r.innerText || r.textContent).slice(0, 180)) };
          }
          const row = matched[0];
          const wantBtn = normBtn(${JSON.stringify(btnText)});
          const btns = [...row.querySelectorAll("button, a, [role='button']")].filter((b) => isBox(b, 0) && !b.disabled);
          const btn = btns.find((b) => normBtn(b.innerText || b.textContent) === wantBtn);
          if (!btn) {
            return { ok: false, count: 1, buttonMissing: true, buttons: btns.map((b) => norm(b.innerText || b.textContent)) };
          }
          if (${JSON.stringify(mode)} === "click") {
            btn.setAttribute("data-pl-wf-act", ${JSON.stringify(nonce)});
          }
          return { ok: true, rowText: norm(row.innerText || row.textContent).slice(0, 400), buttonText: norm(btn.innerText || btn.textContent) };`,
          stepCtx,
        );

        if (!probe?.ok) {
          throw new WorkflowError({
            code: probe?.buttonMissing ? "WORKFLOW_ROW_BUTTON_MISSING" : "WORKFLOW_ROW_MATCH_FAILED",
            blame: "workflow",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: step.op,
            expected: `唯一匹配 1 行 (${JSON.stringify(mustAll)}) 且存在按钮 "${btnText}"`,
            actual: JSON.stringify(probe),
            message: probe?.buttonMissing
              ? `目标行缺少可用按钮 "${btnText}"`
              : `表格行复合键匹配行数为 ${probe?.count ?? 0}（期望唯一 1 行）`,
          });
        }

        if (mode === "verify_only") {
          return { ok: true, verifiedOnly: true, rowText: probe.rowText, didMutate: false };
        }

        await clickMarkedElement({ markNonce: nonce, buttonText: btnText, stepCtx, targetUrl: currentUrl });

        if (params.waitModalsDelta !== undefined) {
          await waitForDialogsCount({
            wantCount: Math.max(0, Number(beforeDialogs) + Number(params.waitModalsDelta)),
            timeoutMs: Number(params.timeoutMs) || 10000,
            actionLabel: btnText,
            stepCtx,
          });
        }

        if (params.waitText || params.waitSelector) {
          const timeoutMs = Math.max(300, Number(params.timeoutMs) || 12000);
          const deadline = Date.now() + timeoutMs;
          while (true) {
            const okWait = await evalJs(
              `const txtOk = !${Boolean(params.waitText)} || norm(document.body?.innerText || document.body?.textContent || "").includes(norm(${JSON.stringify(params.waitText || "")}));
              const selOk = !${Boolean(params.waitSelector)} || Boolean(resolveScope(${JSON.stringify(params.waitSelector || "")}));
              return txtOk && selOk;`,
              stepCtx,
            );
            if (okWait) break;
            if (Date.now() >= deadline) {
              throw new WorkflowError({
                code: "WORKFLOW_ROW_OPEN_TIMEOUT",
                blame: "workflow",
                stepIndex: stepCtx.stepIndex,
                stepId: stepCtx.stepId,
                op: step.op,
                expected: `点击行按钮 "${btnText}" 后出现 ${params.waitText || params.waitSelector}`,
                actual: "等待超时",
                message: `点击行内 "${btnText}" 后等待弹窗或目标元素超时`,
              });
            }
            await sleepWithAbort(150, signal);
          }
        }
        return { ok: true, rowText: probe.rowText, didMutate: Boolean(params.countsAsMutation) };
      }

      case "query_dom": {
        const mode = String(params.mode || "page");
        const scopeSpec = params.scope || params.containerSelector || "";
        let data = null;

        if (mode === "page") {
          data = await evalJs(
            `const href = String(location.href || "");
            const hashIdx = href.indexOf("#");
            const hashPart = hashIdx >= 0 ? href.slice(hashIdx + 1) : "";
            const qIdx = hashPart.indexOf("?");
            const hashQuery = qIdx >= 0 ? hashPart.slice(qIdx + 1) : "";
            const hashParams = Object.fromEntries(new URLSearchParams(hashQuery).entries());
            const searchParams = Object.fromEntries(new URLSearchParams(location.search || "").entries());
            return {
              url: href,
              pathname: location.pathname || "",
              hash: location.hash || "",
              hashParams,
              searchParams,
              title: document.title || "",
              text: norm(document.body?.innerText || document.body?.textContent || "").slice(0, 8000),
              modalsCount: getDialogs(0).length,
            };`,
            stepCtx,
          );
        } else if (mode === "table") {
          const rowSel = String(params.rowSelector || "tbody tr");
          const itemTitleSel = String(params.itemTitleSelector || "");
          data = await evalJs(
            `const scope = resolveScope(${JSON.stringify(scopeSpec)}) || document.body;
            const emptyClasses = ADAPTER.emptyRowClasses || [];
            const ths = [...scope.querySelectorAll("thead th, [role='columnheader']")].map((th) => norm(th.innerText || th.textContent));
            const rawRows = [...scope.querySelectorAll(${JSON.stringify(rowSel)})].filter((r) => {
              if (!isBox(r, 0) || r.closest("thead")) return false;
              const cls = String(r.className || "");
              if (emptyClasses.some((c) => cls.includes(c))) return false;
              return Boolean(norm(r.innerText || r.textContent));
            });
            const rows = rawRows.map((r, idx) => {
              const tds = [...r.querySelectorAll("td, [role='cell']")];
              const cells = tds.map((td) => norm(td.innerText || td.textContent));
              const namedCells = {};
              ths.forEach((h, hi) => { if (h && cells[hi] !== undefined) namedCells[h] = cells[hi]; });
              const titleEl = ${Boolean(itemTitleSel)} ? r.querySelector(${JSON.stringify(itemTitleSel)}) : null;
              const primaryText = titleEl ? norm(titleEl.innerText || titleEl.textContent) : (cells.find(Boolean) || "");
              const hrefs = [...r.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") || "").join(" ");
              const buttons = [...r.querySelectorAll("button, a, [role='button']")].filter((b) => isBox(b, 0) && !b.disabled).map((b) => normBtn(b.innerText || b.textContent)).filter(Boolean);
              return { index: idx, text: norm(r.innerText || r.textContent), primaryText, hrefs, cells, namedCells, buttons };
            });
            return { count: rows.length, headers: ths, rows };`,
            stepCtx,
          );
        } else if (mode === "fields") {
          const fSel = String(params.fieldSelector || adapterSpec.fieldContainerSelector);
          const lSel = String(params.labelSelector || adapterSpec.fieldLabelSelector);
          data = await evalJs(
            `const scope = resolveScope(${JSON.stringify(scopeSpec || "@topDialog")});
            if (!scope) return { count: 0, fields: [] };
            const blocks = [...scope.querySelectorAll(${JSON.stringify(fSel)})].filter((b) => isBox(b, 0));
            const fields = blocks.map((b, idx) => {
              const lblEl = b.querySelector(${JSON.stringify(lSel)});
              const label = norm(lblEl ? (lblEl.innerText || lblEl.textContent) : "");
              const cleanLabel = stripHint(label);
              const starred = label.startsWith("*") || Boolean(b.querySelector(ADAPTER.requiredSelector));
              const selects = [...b.querySelectorAll(ADAPTER.comboboxRootSelector)].filter((s) => isBox(s, 0));
              const selectedItems = selects.flatMap((s) => readSingleRootSelected(s)).filter(Boolean);
              const inputs = [...b.querySelectorAll("input, textarea")].filter((inp) => {
                if (!isBox(inp, 0)) return false;
                const tp = String(inp.type || "").toLowerCase();
                if (["hidden", "checkbox", "radio", "search", "file", "button", "submit"].includes(tp)) return false;
                if (inp.closest(ADAPTER.comboboxRootSelector) && tp === "search") return false;
                return true;
              });
              const inputValues = inputs.map((inp) => norm(inp.value ?? "")).filter(Boolean);
              return {
                index: idx,
                label,
                cleanLabel,
                starred,
                selectedItems,
                inputValues,
                isFilled: selectedItems.length > 0 || inputValues.length > 0,
                selectCount: selects.length,
                inputCount: inputs.length,
              };
            });
            return { count: fields.length, fields };`,
            stepCtx,
          );
        } else if (mode === "controls") {
          data = await evalJs(
            `const scope = resolveScope(${JSON.stringify(scopeSpec || "@topDialog")});
            if (!scope) return { exists: false };
            const queries = ${JSON.stringify(params.queries || {})};
            const out = { exists: true, text: norm(scope.innerText || scope.textContent).slice(0, 6000) };
            for (const [key, q] of Object.entries(queries)) {
              if (!q || typeof q !== "object") continue;
              if (q.kind === "input_value") {
                const el = scope.querySelector(q.selector);
                out[key] = el ? String(el.value ?? "") : "";
              } else if (q.kind === "input_values_by_placeholder") {
                out[key] = [...scope.querySelectorAll("input, textarea")]
                  .filter((i) => isBox(i, 0) && i.getAttribute("placeholder") === String(q.placeholder))
                  .map((i) => String(i.value ?? ""));
              } else if (q.kind === "selected_value") {
                const el = scope.querySelector(q.selector);
                const root = el ? (el.closest(ADAPTER.comboboxRootSelector) || el) : null;
                out[key] = root ? (readSingleRootSelected(root)[0] || norm(el?.value || "")) : "";
              } else if (q.kind === "table_cells") {
                const sub = q.selector ? scope.querySelector(q.selector) : scope;
                out[key] = sub
                  ? [...sub.querySelectorAll("tbody td, [role='cell']")]
                      .map((td) => norm(td.innerText || td.textContent))
                      .filter((t) => t && t.length <= 40 && !t.includes("\\n"))
                  : [];
              }
            }
            return out;`,
            stepCtx,
          );
        } else {
          data = await evalJs(
            `const base = resolveScope(${JSON.stringify(scopeSpec || "@topDialog")});
            if (!base) return { exists: false, text: "", value: "", selectedItems: [] };
            const target = ${Boolean(params.fieldLabel)}
              ? findFieldScope(base, ${JSON.stringify(params.fieldLabel || "")})
              : (${Boolean(params.selector)} ? base.querySelector(${JSON.stringify(params.selector || "")}) : base);
            if (!target) return { exists: false, text: "", value: "", selectedItems: [] };
            const root = target.closest?.(ADAPTER.comboboxRootSelector) || target;
            return {
              exists: true,
              text: norm(target.innerText || target.textContent).slice(0, 4000),
              value: String(target.value ?? ""),
              selectedItems: readSingleRootSelected(root),
            };`,
            stepCtx,
          );
        }

        if (params.saveBindKey) {
          saveToBinds(runtimeBinds, params.saveBindKey, data);
        }
        return { ok: true, mode, data, didMutate: false };
      }

      case "set_binds": {
        const rawTransforms = Array.isArray(step.params?.transforms) ? step.params.transforms : [];
        const updated = applyBindTransforms(rawTransforms, runtimeBinds, stepCtx);
        return { ok: true, updated, didMutate: false };
      }

      case "assert_state": {
        const containerSelector = params.scope || params.containerSelector || "";
        const checks = Array.isArray(params.checks) ? params.checks : [];
        const timeoutMs = Math.max(0, Number(params.timeoutMs) || 0);
        const deadline = Date.now() + timeoutMs;
        const batches = buildAssertStateBatches(containerSelector, checks, 6000, adapterSpec);

        while (true) {
          let failedEval = null;
          const mergedEvidence = [];
          for (const batch of batches) {
            const evalRes = await evalRawJs(batch.code, stepCtx);
            if (!evalRes?.pass) {
              failedEval = evalRes;
              break;
            }
            if (Array.isArray(evalRes.evidence)) mergedEvidence.push(...evalRes.evidence);
          }
          if (!failedEval) {
            return { ok: true, checkedCount: checks.length, evidence: mergedEvidence, didMutate: false };
          }
          if (Date.now() >= deadline) {
            throw new WorkflowError({
              code: "WORKFLOW_ASSERT_FAILED",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: step.op,
              expected: failedEval?.expected || "所有状态断言通过",
              actual: failedEval?.actual || JSON.stringify(failedEval),
              message: `断言未通过 [${failedEval?.kind || "check"}]: 期望 ${failedEval?.expected}，实读 ${failedEval?.actual}`,
            });
          }
          await sleepWithAbort(150, signal);
        }
      }

      case "if_state": {
        const condExpr = step.params?.condition !== undefined ? step.params.condition : params.condition;
        const matched = evaluateWhenPredicate(condExpr, runtimeBinds, stepCtx);
        const branchSteps = matched
          ? (Array.isArray(step.params?.thenSteps) ? step.params.thenSteps : [])
          : (Array.isArray(step.params?.elseSteps) ? step.params.elseSteps : []);
        const subRes = await runSubSteps(branchSteps, stepCtx);
        return { ok: true, branch: matched ? "then" : "else", subSteps: subRes.executed, didMutate: subRes.didMutate };
      }

      case "foreach": {
        const listKey = String(interpolateParams(params.over ?? "", runtimeBinds, stepCtx));
        const itemVar = String(interpolateParams(params.as ?? "item", runtimeBinds, stepCtx));
        const indexVar = String(interpolateParams(params.indexAs ?? "itemIndex", runtimeBinds, stepCtx));
        const rawItemsParam = params.items !== undefined ? interpolateParams(params.items, runtimeBinds, stepCtx) : undefined;
        const hit = Array.isArray(rawItemsParam)
          ? { found: true, value: rawItemsParam }
          : lookupBindValue(runtimeBinds, listKey);
        const arr = Array.isArray(hit.value) ? hit.value : [];
        const bodySteps = Array.isArray(step.params?.steps) ? step.params.steps : [];
        const prevItem = runtimeBinds[itemVar];
        const prevIdx = runtimeBinds[indexVar];
        let anyMut = false;
        let ran = 0;
        try {
          for (let idx = 0; idx < arr.length; idx += 1) {
            runtimeBinds[itemVar] = arr[idx];
            runtimeBinds[indexVar] = idx;
            const subRes = await runSubSteps(bodySteps, stepCtx);
            ran += subRes.executed;
            if (subRes.didMutate) anyMut = true;
          }
        } finally {
          if (prevItem === undefined) delete runtimeBinds[itemVar];
          else runtimeBinds[itemVar] = prevItem;
          if (prevIdx === undefined) delete runtimeBinds[indexVar];
          else runtimeBinds[indexVar] = prevIdx;
        }
        return { ok: true, iterations: arr.length, subSteps: ran, didMutate: anyMut };
      }

      case "call_macro": {
        const macroName = String(params.macro || "");
        const macroDef = directive.macros?.[macroName];
        if (!macroDef || !Array.isArray(macroDef.steps)) {
          throw new WorkflowError({
            code: "WORKFLOW_MACRO_NOT_FOUND",
            blame: "workflow",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: step.op,
            expected: `已注册宏定义 "${macroName}"`,
            actual: JSON.stringify(Object.keys(directive.macros || {})),
            message: `未定义的宏: ${macroName}`,
          });
        }
        const withArgs = params.with && typeof params.with === "object" ? params.with : {};
        const prevMacro = runtimeBinds.macro;
        runtimeBinds.macro = { ...(macroDef.defaults || {}), ...withArgs };
        try {
          const subRes = await runSubSteps(macroDef.steps, stepCtx);
          return { ok: true, macro: macroName, subSteps: subRes.executed, didMutate: subRes.didMutate };
        } finally {
          if (prevMacro === undefined) delete runtimeBinds.macro;
          else runtimeBinds.macro = prevMacro;
        }
      }

      case "fail": {
        throw new WorkflowError({
          code: String(params.code || "WORKFLOW_EXPLICIT_FAIL"),
          blame: String(params.blame || "workflow"),
          stepIndex: stepCtx.stepIndex,
          stepId: stepCtx.stepId,
          op: step.op,
          expected: String(params.expected || "满足业务前置条件"),
          actual: String(params.actual || params.message || "前置校验未通过"),
          message: String(params.message || params.actual || "工作流显式中止"),
        });
      }

      default:
        throw new WorkflowError({
          code: "WORKFLOW_UNKNOWN_OP",
          blame: "workflow",
          stepIndex: stepCtx.stepIndex,
          stepId: stepCtx.stepId,
          op: step.op,
          expected: "已注册的通用步骤原语 op",
          actual: step.op,
          message: `未知步骤原语 op: ${step.op}`,
        });
    }
  }

  async function runSubSteps(rawSubSteps = [], parentCtx) {
    let executed = 0;
    let didMutate = false;
    for (let j = 0; j < rawSubSteps.length; j += 1) {
      checkAbort(signal);
      const rawSub = rawSubSteps[j];
      const subId = String(rawSub.id || `${parentCtx.stepId}.sub_${j + 1}`);
      const subOp = String(rawSub.op || "");
      const subCtx = { stepIndex: parentCtx.stepIndex, stepId: subId, op: subOp };
      const shouldRun = evaluateWhenPredicate(rawSub.when, runtimeBinds, subCtx);
      if (!shouldRun) {
        setBindValue(runtimeBinds, `steps.${subId}`, { executed: false, skipped: true, didMutate: false });
        continue;
      }
      const rawParams = rawSub.params && typeof rawSub.params === "object" ? { ...rawSub.params } : {};
      if (rawSub.macro && !rawParams.macro) rawParams.macro = rawSub.macro;
      if (rawSub.with && !rawParams.with) rawParams.with = rawSub.with;
      if (rawSub.scope && !rawParams.scope) rawParams.scope = rawSub.scope;
      const subStepObj = { ...rawSub, id: subId, op: subOp, params: rawParams };
      const interp = subOp === "set_binds" || subOp === "if_state" || subOp === "foreach"
        ? rawParams
        : interpolateParams(rawParams, runtimeBinds, subCtx);
      const snap = await checkEnvironmentAndUrl(subCtx);
      const out = await executePrimitive(subStepObj, interp, subCtx, snap?.url || "");
      await checkEnvironmentAndUrl(subCtx);
      executed += 1;
      const mutated = Boolean(out?.didMutate);
      if (mutated) {
        didMutate = true;
        totalMutations += 1;
        runtimeBinds.workflow = { mutationsCount: totalMutations, anyMutated: totalMutations > 0 };
        if (runtimeBinds.runtime && typeof runtimeBinds.runtime === "object") {
          runtimeBinds.runtime.wasModified = true;
        }
      }
      setBindValue(runtimeBinds, `steps.${subId}`, {
        executed: true,
        skipped: false,
        didMutate: mutated,
      });
    }
    return { executed, didMutate };
  }

  let executedSteps = 0;
  let skippedSteps = 0;

  for (let i = 0; i < directive.steps.length; i += 1) {
    checkAbort(signal);
    const step = directive.steps[i];
    const stepIndex = i + 1;
    const stepCtx = { stepIndex, stepId: step.id, op: step.op };
    const stepStartMs = Date.now();
    let summaryArgs = { stepId: step.id };
    let startedEmitted = false;

    try {
      const shouldRun = evaluateWhenPredicate(step.when, runtimeBinds, stepCtx);
      if (!shouldRun) {
        skippedSteps += 1;
        setBindValue(runtimeBinds, `steps.${step.id}`, { executed: false, skipped: true, didMutate: false });
        const skipTs = Date.now();
        const snap = await resolvePageSnapshot().catch(() => null);
        const skipSummary = JSON.stringify({ ok: true, skippedByWhen: step.when });
        onStepStart?.({ stepIndex, stepId: step.id, name: step.op, args: { stepId: step.id, when: step.when } });
        onStepDone?.({
          stepIndex,
          stepId: step.id,
          name: step.op,
          ok: true,
          durationMs: Math.max(1, skipTs - stepStartMs),
          result: skipSummary,
        });
        traceSteps.push({
          type: "tool_exec",
          turn: 0,
          name: step.op,
          toolName: step.op,
          workflowStepId: step.id,
          args: { stepId: step.id, when: step.when },
          ok: true,
          jsOk: true,
          failureReason: null,
          resultSummary: skipSummary,
          durationMs: Math.max(1, skipTs - stepStartMs),
          tabId: snap?.tabId ?? null,
          pageUrl: snap?.url ?? null,
          pageTitle: snap?.title ?? null,
          timestamp: skipTs,
          isoTime: new Date(skipTs).toISOString(),
        });
        continue;
      }

      const params =
        step.op === "set_binds" || step.op === "if_state" || step.op === "foreach"
          ? (step.params || {})
          : interpolateParams(step.params || {}, runtimeBinds, stepCtx);
      summaryArgs = summarizeStepArgs(step.id, params);
      onStepStart?.({ stepIndex, stepId: step.id, name: step.op, args: summaryArgs });
      startedEmitted = true;

      const preSnap = await checkEnvironmentAndUrl(stepCtx);
      const out = await executePrimitive(step, params, stepCtx, preSnap?.url || "");
      const stepMutated = Boolean(out?.didMutate);
      if (stepMutated && step.op !== "call_macro" && step.op !== "if_state" && step.op !== "foreach") {
        totalMutations += 1;
        runtimeBinds.workflow = { mutationsCount: totalMutations, anyMutated: totalMutations > 0 };
        if (runtimeBinds.runtime && typeof runtimeBinds.runtime === "object") {
          runtimeBinds.runtime.wasModified = true;
        }
      }
      setBindValue(runtimeBinds, `steps.${step.id}`, {
        executed: true,
        skipped: false,
        didMutate: stepMutated,
      });

      const postSnap = await checkEnvironmentAndUrl(stepCtx);
      let shotDataUrl = null;
      if (step.screenshot) {
        shotDataUrl = await captureStepScreenshot(stepCtx);
      }

      const endTs = Date.now();
      const durMs = Math.max(1, endTs - stepStartMs);
      const fullOut = out ?? { ok: true };
      const outText = JSON.stringify(fullOut).slice(0, 4000);
      executedSteps += 1;

      onStepDone?.({
        stepIndex,
        stepId: step.id,
        name: step.op,
        ok: true,
        durationMs: durMs,
        result: outText,
      });

      traceSteps.push({
        type: "tool_exec",
        turn: 0,
        name: step.op,
        toolName: step.op,
        workflowStepId: step.id,
        args: summaryArgs,
        ok: true,
        jsOk: true,
        failureReason: null,
        resultSummary: outText,
        actualReadback: fullOut,
        ...(shotDataUrl ? { screenshotDataUrl: shotDataUrl } : {}),
        durationMs: durMs,
        tabId: postSnap?.tabId ?? preSnap?.tabId ?? null,
        pageUrl: postSnap?.url ?? preSnap?.url ?? null,
        pageTitle: postSnap?.title ?? preSnap?.title ?? null,
        timestamp: endTs,
        isoTime: new Date(endTs).toISOString(),
      });
    } catch (err) {
      if (err?.name === "AbortError" || signal?.aborted) {
        return {
          ok: false,
          aborted: true,
          workflowId: directive.id,
          totalSteps: directive.steps.length,
          executedSteps,
          skippedSteps,
          durationMs: Math.max(1, Date.now() - startedMs),
          errorMessage: "已停止。",
          failure: null,
        };
      }

      const wfErr =
        err instanceof WorkflowError
          ? err
          : new WorkflowError({
              code: "WORKFLOW_UNEXPECTED_ERROR",
              blame: "工具",
              stepIndex,
              stepId: step.id,
              op: step.op,
              expected: "步骤无异常完成",
              actual: err?.message || String(err),
              message: err?.message || String(err),
            });

      if (!startedEmitted) {
        onStepStart?.({ stepIndex, stepId: step.id, name: step.op, args: summaryArgs });
      }
      if (shouldCaptureFailureEvidence && toolMap.has("screenshot")) {
        await sleepWithAbort(200, signal).catch(() => {});
      }
      const failShotUrl = shouldCaptureFailureEvidence ? await captureStepScreenshot(stepCtx) : null;
      const failSnap = await resolvePageSnapshot().catch(() => null);
      const endTs = Date.now();
      const durMs = Math.max(1, endTs - stepStartMs);
      const failSummary = `${wfErr.code}: ${wfErr.actual || wfErr.message}`.slice(0, 500);

      onStepDone?.({
        stepIndex,
        stepId: step.id,
        name: step.op,
        ok: false,
        durationMs: durMs,
        result: failSummary,
      });

      traceSteps.push({
        type: "tool_exec",
        turn: 0,
        name: step.op,
        toolName: step.op,
        workflowStepId: step.id,
        args: summaryArgs,
        ok: false,
        jsOk: true,
        failureReason: wfErr.message,
        resultSummary: failSummary,
        expected: wfErr.expected,
        actual: wfErr.actual,
        blame: wfErr.blame,
        ...(failShotUrl ? { screenshotDataUrl: failShotUrl } : {}),
        durationMs: durMs,
        tabId: failSnap?.tabId ?? null,
        pageUrl: failSnap?.url ?? null,
        pageTitle: failSnap?.title ?? null,
        timestamp: endTs,
        isoTime: new Date(endTs).toISOString(),
      });

      return {
        ok: false,
        aborted: false,
        workflowId: directive.id,
        totalSteps: directive.steps.length,
        executedSteps,
        skippedSteps,
        durationMs: Math.max(1, Date.now() - startedMs),
        summaryLines: directive.summaryLines || [],
        binds: runtimeBinds,
        errorMessage: wfErr.message,
        failure: {
          stepIndex,
          stepId: step.id,
          op: step.op,
          code: wfErr.code,
          expected: wfErr.expected,
          actual: wfErr.actual,
          blame: wfErr.blame,
          message: wfErr.message,
          hasScreenshot: Boolean(failShotUrl),
        },
      };
    }
  }

  return {
    ok: true,
    aborted: false,
    workflowId: directive.id,
    totalSteps: directive.steps.length,
    executedSteps,
    skippedSteps,
    durationMs: Math.max(1, Date.now() - startedMs),
    mutationsCount: totalMutations,
    summaryLines: directive.summaryLines || [],
    binds: runtimeBinds,
    runtime: runtimeBinds.runtime,
    errorMessage: null,
    failure: null,
  };
}

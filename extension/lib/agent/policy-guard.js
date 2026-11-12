/**
 * 声明式任务级执行策略护栏（ExecutionPolicy）与单一文件上传触发器检测。
 *
 * 职责：
 * 1. 统一执行外部传入的 `forbidClickTexts`、`forbidSelectors`、`forbidUrlPatterns`、`fileChooserPolicy`。
 * 2. 提供全仓唯一的 `isFileUploadTrigger(node, adapterSpec)` 拓扑识别函数（配合 UploadAdapter 选择器）。
 */

import { DEFAULT_COMPOSITE_ADAPTER_SPEC } from "./ui-adapters/index.js";

export const FILE_CHOOSER_BLOCKED_MESSAGE =
  "目标位置命中文件上传控件（点击会弹出系统文件选择框），已拦截；如需上传文件请使用 upload_file 工具，如系滚动后坐标偏移请改用 selector 定位目标控件";

export const DEFAULT_EXECUTION_POLICY = Object.freeze({
  forbidClickTexts: Object.freeze([]),
  forbidSelectors: Object.freeze([]),
  forbidUrlPatterns: Object.freeze([]),
  fileChooserPolicy: "deny",
  uiAdapters: null,
});

function compactCjk(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, "$1");
}

function toStringList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item || "").trim()).filter(Boolean);
}

export function normalizeExecutionPolicy(rawPolicy) {
  if (!rawPolicy || typeof rawPolicy !== "object") return DEFAULT_EXECUTION_POLICY;
  const fileChooserPolicy = rawPolicy.fileChooserPolicy === "allow" ? "allow" : "deny";
  const uiAdapters = Array.isArray(rawPolicy.uiAdapters) && rawPolicy.uiAdapters.length
    ? toStringList(rawPolicy.uiAdapters)
    : null;
  return {
    forbidClickTexts: toStringList(rawPolicy.forbidClickTexts),
    forbidSelectors: toStringList(rawPolicy.forbidSelectors),
    forbidUrlPatterns: toStringList(rawPolicy.forbidUrlPatterns),
    fileChooserPolicy,
    uiAdapters,
  };
}

export function shouldBlockFileChooser(rawPolicy) {
  return normalizeExecutionPolicy(rawPolicy).fileChooserPolicy !== "allow";
}

export function evaluateUrlPolicy(url, rawPolicy) {
  const policy = normalizeExecutionPolicy(rawPolicy);
  const target = String(url || "").trim();
  if (!target || !policy.forbidUrlPatterns.length) return { allowed: true };
  const lower = target.toLowerCase();
  for (const pattern of policy.forbidUrlPatterns) {
    if (pattern && lower.includes(pattern.toLowerCase())) {
      return {
        allowed: false,
        code: "POLICY_FORBIDDEN_URL",
        matched: pattern,
        url: target,
        error: `策略守卫拦截：禁止访问匹配「${pattern}」的 URL（${target}）`,
      };
    }
  }
  return { allowed: true };
}

export function evaluateClickPolicy({ text = "", domElementText = "", selector = "" } = {}, rawPolicy) {
  const policy = normalizeExecutionPolicy(rawPolicy);
  const candidates = [compactCjk(text), compactCjk(domElementText)].filter(Boolean);

  for (const forbidden of policy.forbidClickTexts) {
    const want = compactCjk(forbidden);
    if (!want) continue;
    if (candidates.some((cand) => cand === want || cand.includes(want))) {
      return {
        allowed: false,
        code: "POLICY_FORBIDDEN_CLICK_TEXT",
        matched: forbidden,
        actual: text || domElementText,
        error: `策略守卫拦截：禁止点击文本「${forbidden}」`,
      };
    }
  }

  if (selector) {
    const rawSel = String(selector);
    for (const forbiddenSel of policy.forbidSelectors) {
      if (forbiddenSel && rawSel.includes(forbiddenSel)) {
        return {
          allowed: false,
          code: "POLICY_FORBIDDEN_SELECTOR",
          matched: forbiddenSel,
          actual: rawSel,
          error: `策略守卫拦截：禁止操作选择器「${forbiddenSel}」`,
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * 全仓唯一的文件上传触发器 DOM 拓扑判定（供同进程与 UploadAdapter 测试调用）。
 */
export function isFileUploadTrigger(node, adapterSpec = DEFAULT_COMPOSITE_ADAPTER_SPEC) {
  const start = node && node.nodeType === 1 ? node : node?.parentElement || null;
  if (!start) return false;
  if (
    start.tagName === "INPUT" &&
    String(start.type || start.getAttribute?.("type") || "").toLowerCase() === "file" &&
    !start.disabled
  ) {
    return true;
  }
  const spec = adapterSpec || DEFAULT_COMPOSITE_ADAPTER_SPEC;
  const listSel = spec?.uploadListSelector || '[role="list"][data-upload-list], [class*="upload-list"]';
  const trigSel = spec?.uploadTriggerSelector || 'button, [role="button"]';
  const doc = start.ownerDocument || globalThis.document || null;

  for (
    let cur = start;
    cur && cur !== doc?.body && cur !== doc?.documentElement;
    cur = cur.parentElement || cur.getRootNode?.()?.host || null
  ) {
    if (listSel && cur.matches?.(listSel)) break;
    if (cur.tagName === "LABEL") {
      const forId = cur.getAttribute?.("for");
      const ctrl = cur.control || (forId && doc ? doc.getElementById(forId) : null);
      if (
        (ctrl?.tagName === "INPUT" &&
          String(ctrl.type || ctrl.getAttribute?.("type") || "").toLowerCase() === "file" &&
          !ctrl.disabled) ||
        cur.querySelector?.('input[type="file"]:not([disabled])')
      ) {
        return true;
      }
    }
    if (trigSel && cur.matches?.(trigSel) && cur.querySelector?.('input[type="file"]:not([disabled])')) {
      return true;
    }
  }
  return false;
}

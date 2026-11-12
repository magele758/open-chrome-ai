/**
 * 确定性工作流通用错误模型、文本规范化与外部环境阻断探测（零业务语义）。
 */

export const WORKFLOW_MODEL_ID = "deterministic-workflow";
export const WORKFLOW_SCHEMA_VERSION = "1.0";

const EXTERNAL_CHALLENGE_RE =
  /(?:请完成安全验证|拖动下方滑块|滑块验证|人脸识别验证|登录已过期[，,\s]*请重新登录|会话已过期[，,\s]*请重新登录|账号已被限制|访问过于频繁|\bverify\s+you\s+are\s+human\b)/i;
const GATEWAY_ERR_RE =
  /\b(?:502\s+Bad\s+Gateway|503\s+Service\s+Temporarily\s+Unavailable|504\s+Gateway\s+Time-?out)\b/i;
const LOGIN_PATH_RE = /\/(?:login|signin|passport|sso)(?:[/?#]|$)/i;

export class WorkflowError extends Error {
  constructor({
    message,
    code = "WORKFLOW_STEP_FAILED",
    blame = "workflow",
    expected = "",
    actual = "",
    stepIndex = 0,
    stepId = "",
    op = "",
  } = {}) {
    super(String(message || code));
    this.name = "WorkflowError";
    this.code = String(code);
    this.blame = String(blame || "workflow");
    this.expected = String(expected || "");
    this.actual = String(actual || "");
    this.stepIndex = Number(stepIndex) || 0;
    this.stepId = String(stepId || "");
    this.op = String(op || "");
  }
}

export function normalizeSpaces(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function normalizeCjkText(value) {
  return normalizeSpaces(value).replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, "$1");
}

/**
 * 仅在明确命中登录重定向路由、网关故障页或全屏安全挑战提示时返回阻断原因；
 * 普通正文提及一般词汇不会误停机。
 */
export function detectExternalBlocker({ url = "", title = "", text = "" } = {}) {
  const u = String(url || "");
  let pathname = "";
  try {
    pathname = new URL(u).pathname || "";
  } catch {
    pathname = u;
  }
  if (LOGIN_PATH_RE.test(pathname)) {
    return `检测到登录重定向 URL: ${u}`;
  }
  const titleStr = normalizeSpaces(title);
  const bodyHead = normalizeSpaces(String(text || "").slice(0, 1200));
  const gw = GATEWAY_ERR_RE.exec(`${titleStr}\n${bodyHead}`);
  if (gw) {
    return `检测到网关异常页面: ${gw[0]}`;
  }
  const chTitle = EXTERNAL_CHALLENGE_RE.exec(titleStr);
  if (chTitle) {
    return `检测到外部安全挑战或会话失效标题: ${chTitle[0]}`;
  }
  if (bodyHead.length > 0 && bodyHead.length <= 600) {
    const chBody = EXTERNAL_CHALLENGE_RE.exec(bodyHead);
    if (chBody) {
      return `检测到外部安全挑战或会话失效提示: ${chBody[0]}`;
    }
  }
  return null;
}

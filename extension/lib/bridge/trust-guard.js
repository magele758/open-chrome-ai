/**
 * 持 token 的外部 Agent 直调工具 = 委托人动作（不经 LLM 确认），但两条护栏始终保留：
 *  1. 出站：目的地 ∉ token origins ∪ token egress → EGRESS_NOT_ALLOWED
 *  2. 不可逆清单：命中且 token 未显式免清单 → CONFIRMATION_REQUIRED + pendingId（进待批准队列，侧栏批准）；
 *     Agent 用相同参数重试时消费一次批准并执行。从不阻塞等待。
 * bridge 工具名到 P4 判定用的工具名的映射都在这里；bridge/index.js 与 inbox 只调用 enforceTokenGuards。
 */
import { checkEgress, buildEgressPolicy } from "../agent/egress.js";
import { IRREVERSIBLE_ITEMS, matchIrreversible, normalizeIrreversibleActions } from "../agent/trust/irreversible.js";
import { isSensitiveSetting } from "../agent/settings-tools.js";
import { BridgeError, ERROR_CODES } from "./protocol.js";
import { isSensitiveUploadPath } from "./tools-browser.js";

/** bridge 工具 → checkEgress 认识的同类工具 */
const EGRESS_ALIASES = Object.freeze({
  create_window: "open_tab",
  set_input_value: "fill",
  select_option: "fill",
  paste_rich_trusted: "paste_into_page",
  "inbox.paste_html": "paste_into_page",
  "inbox.wechat_fill_draft": "paste_into_page",
});

/** bridge 工具 → matchIrreversible 认识的同类工具 */
const IRREVERSIBLE_ALIASES = Object.freeze({
  create_window: "open_tab",
  set_input_value: "fill",
  paste_rich_trusted: "paste_into_page",
  "inbox.cose_publish": "cose_publish",
  "inbox.paste_html": "paste_into_page",
  "inbox.wechat_fill_draft": "paste_into_page",
});

/** P4 清单里没有、bridge 才有的删除类工具 */
const DELETE_TOOLS = Object.freeze({
  close_tab: "关闭标签",
  close_window: "关闭整个窗口",
});

/** 工具自己会硬拒绝的调用（受保护设置、敏感上传路径）不进待批准队列，让 Agent 直接拿到真正的错误 */
function toolWillReject(toolName, args) {
  if (toolName === "update_settings") return (Array.isArray(args?.changes) ? args.changes : []).some((c) => isSensitiveSetting(String(c?.key || "")));
  if (toolName === "upload_file") return (Array.isArray(args?.paths) ? args.paths : []).map(String).some(isSensitiveUploadPath);
  return false;
}

export function approvalPrincipal(record) {
  return `token:${record?.id || ""}`;
}

export function tokenEgressPolicy(record) {
  return buildEgressPolicy({ tokenEgress: [...(record?.origins || []), ...(record?.egress || [])] });
}

/** 命中的不可逆清单项（尊重用户在设置里关掉的项）；null 表示未命中 */
export function matchTokenIrreversible(toolName, args = {}, settings = {}, { targetUrl = "", elementText = "" } = {}) {
  if (DELETE_TOOLS[toolName]) {
    if (!normalizeIrreversibleActions(settings?.irreversibleActions).delete) return null;
    const { id, label } = IRREVERSIBLE_ITEMS.find((i) => i.id === "delete");
    return { id, label, reason: DELETE_TOOLS[toolName] };
  }
  const name = IRREVERSIBLE_ALIASES[toolName] || toolName;
  return matchIrreversible(name, args, settings, { targetUrl, elementText });
}

/**
 * 纯判定。
 * @returns {{ ok: true, irreversible: object|null, optOut?: boolean }
 *   | { ok: false, code: "EGRESS_NOT_ALLOWED", egress: object }
 *   | { ok: false, code: "CONFIRMATION_REQUIRED", irreversible: object }}
 */
export function checkTokenCall(toolName, args = {}, { record, settings = {}, targetUrl = "", elementText = "" } = {}) {
  const egress = checkEgress(EGRESS_ALIASES[toolName] || toolName, args, { targetUrl, policy: tokenEgressPolicy(record) });
  if (!egress.ok) return { ok: false, code: ERROR_CODES.EGRESS_NOT_ALLOWED, egress };
  const irreversible = toolWillReject(toolName, args) ? null : matchTokenIrreversible(toolName, args, settings, { targetUrl, elementText });
  if (!irreversible) return { ok: true, irreversible: null };
  if (record?.skipIrreversible === true) return { ok: true, irreversible, optOut: true };
  return { ok: false, code: ERROR_CODES.CONFIRMATION_REQUIRED, irreversible };
}

/**
 * 判定并落实：放行返回 { confirmed, irreversible, optOut }；否则抛 BridgeError。
 * approvals：approval-queue（enqueue / consumeApproved / consumeRejected）。
 */
export async function enforceTokenGuards(toolName, args = {}, { record, settings = {}, targetUrl = "", elementText = "", approvals, sessionId = "" } = {}) {
  const verdict = checkTokenCall(toolName, args, { record, settings, targetUrl, elementText });
  if (verdict.ok) return { confirmed: false, irreversible: verdict.irreversible?.id || null, optOut: verdict.optOut === true };

  if (verdict.code === ERROR_CODES.EGRESS_NOT_ALLOWED) {
    const { destination, origin, channel, reason } = verdict.egress;
    throw new BridgeError(ERROR_CODES.EGRESS_NOT_ALLOWED, `出站拦截：${reason}`, {
      hint: "目的地不在 token 的网站范围或出站白名单里。不要换别的方式外发；请用户在 PageLens 设置 → 外部 Agent 新建一个出站白名单包含它的 token。",
      details: { channel, destination: destination || null, origin: origin || null },
    });
  }

  const item = verdict.irreversible;
  const principal = approvalPrincipal(record);
  if (!approvals) {
    throw new BridgeError(ERROR_CODES.CONFIRMATION_REQUIRED, `不可逆操作需用户批准：${item.reason}（待批准队列不可用）`, {
      retryable: false,
      details: { item: { id: item.id, label: item.label } },
    });
  }
  if (await approvals.consumeApproved(toolName, args, { principal })) return { confirmed: true, irreversible: item.id, optOut: false };
  if (await approvals.consumeRejected(toolName, args, { principal })) {
    throw new BridgeError(ERROR_CODES.CONFIRMATION_REJECTED, `用户拒绝了这次操作：${item.reason}`, {
      hint: "不要换别的工具绕过。再次用相同参数调用会重新进入待批准队列。",
      details: { item: { id: item.id, label: item.label } },
    });
  }
  const entry = await approvals.enqueue({
    toolName,
    args,
    reason: `外部 Agent「${record?.name || "?"}」：${item.reason}`,
    item,
    principal,
    sessionId: sessionId || "",
  });
  throw new BridgeError(ERROR_CODES.CONFIRMATION_REQUIRED, `不可逆操作需用户批准：${item.reason}`, {
    hint: "已放入待批准队列。请用户在 PageLens 侧栏「待批准」里批准，然后用完全相同的参数重试（每次批准只放行一次）。",
    details: { pendingId: entry.id, item: { id: item.id, label: item.label } },
  });
}

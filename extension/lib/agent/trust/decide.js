/**
 * 按来源授权的工具调用判定（内部 LLM 路径）。纯函数。
 *
 * 顺序：
 *  1. 敏感文件上传 → 硬拒绝
 *  2. 出站守卫 / 敏感本机路径 / 不可逆清单 → 必须确认（全自动、本场免确认、胶囊都跳不过）；
 *     无人值守：出站 EGRESS_NOT_ALLOWED、敏感路径 SENSITIVE_PATH、不可逆 CONFIRMATION_REQUIRED（进待批准队列）
 *  3. 本场免确认 → 放行
 *  4. 胶囊内 → 放行（严格模式下特权操作仍确认）
 *  5. 只读 → 放行
 *  6. 高污染（命中注入特征）且胶囊外有副作用 → 确认（含全自动）；无人值守 NEEDS_WIDER_AUTHORIZATION
 *  7. 无人值守且已读入数据、胶囊外有副作用 → NEEDS_WIDER_AUTHORIZATION
 *  8. 其余按确认模式（严格 / 智能审查 / 全自动）与跨源规则；智能审查下 run_shell 用白名单分类
 * AI 审查只给确认框补充风险提示，不能放行。
 */
import { capsuleCovers } from "./capsule.js";
import { matchIrreversible } from "./irreversible.js";
import { TAINT_CLEAN, TAINT_DATA, TAINT_HIGH, taintLevel } from "./taint.js";
import {
  ORIGIN_SCOPED_NAV_TOOLS,
  ORIGIN_SCOPED_TAB_TOOLS,
  READ_ONLY_TOOLS,
  crossOriginTarget,
  isToolPrivileged,
  urlOrigin,
} from "./tool-classes.js";
import { buildEgressPolicy, checkEgress, checkSensitivePaths } from "../egress.js";
import { isShellCommandWhitelisted } from "../shell-policy.js";
import { CONFIRMATION_REQUIRED } from "./approval-queue.js";

export const NEEDS_WIDER_AUTHORIZATION = "NEEDS_WIDER_AUTHORIZATION";

/** 设置工具自带强制确认弹窗，HITL 层不再重复弹 */
const SELF_CONFIRMING_TOOLS = new Set(["update_settings"]);

function allow(extra = {}) {
  return { decision: "allow", needsConfirmation: false, ...extra };
}

function confirm(reason, extra = {}) {
  return { decision: "confirm", needsConfirmation: true, reason, ...extra };
}

function deny(code, reason, extra = {}) {
  return { decision: "deny", needsConfirmation: false, code, reason, ...extra };
}

function injectionReason(injection, toolName) {
  const from = injection?.tool
    ? `（来源 ${injection.tool}：「${String(injection.excerpt || injection.match || "").slice(0, 60)}」）`
    : "";
  return `检测到外部内容疑似提示词注入${from}，本会话已标为高污染；胶囊外的操作需要确认：[${toolName}]`;
}

/**
 * @param {object} p
 * @param {string} p.toolName
 * @param {object} [p.args]
 * @param {"strict"|"balanced"|"autonomous"} [p.hitlMode]
 * @param {boolean} [p.sessionOverride]
 * @param {string} [p.targetUrl] 目标标签 / 导航 URL
 * @param {string} [p.userUrl] 任务源页面 URL
 * @param {Set<string>} [p.approvedOrigins] 本会话用户已放行的 origin
 * @param {object|null} [p.injectionSuspected] 旧参数：等价于 taint=high
 * @param {object|null} [p.capsule] 意图胶囊
 * @param {object|string|null} [p.taint] 污点状态或级别
 * @param {boolean} [p.attended] 是否有人可以确认（侧栏 true；委托任务 false）
 * @param {object} [p.settings] 读取 irreversibleActions
 * @param {string[]} [p.tokenEgress] token 出站白名单（P1）
 * @param {boolean} [p.skipIrreversible] token 显式免清单确认（P1）
 * @param {string} [p.elementText] 按编号点击时控件文字
 */
export function decideToolCall({
  toolName,
  args = {},
  hitlMode = "balanced",
  sessionOverride = false,
  targetUrl = "",
  userUrl = "",
  approvedOrigins,
  injectionSuspected = null,
  capsule = null,
  taint = null,
  attended = true,
  settings = {},
  tokenEgress = [],
  skipIrreversible = false,
  elementText = "",
} = {}) {
  if (!targetUrl && (ORIGIN_SCOPED_NAV_TOOLS.has(toolName) || toolName === "download_file")) targetUrl = String(args?.url || "").trim();
  let level = taintLevel(taint);
  if (injectionSuspected) level = TAINT_HIGH;
  const injection = injectionSuspected || (typeof taint === "object" ? taint?.injection : null);
  const base = { taint: level, inCapsule: false, irreversible: null, egress: null };
  const auditable = hitlMode === "balanced";

  // 1. 敏感文件上传：硬拒绝
  const sensitive = checkSensitivePaths(toolName, args);
  if (!sensitive.ok && sensitive.hard) return deny(sensitive.code, sensitive.reason, { ...base, sensitive });

  // 2. 出站 / 敏感路径 / 不可逆清单
  const policy = buildEgressPolicy({ capsule, tokenEgress, sourceUrl: userUrl, approvedOrigins, taint: level });
  const egress = checkEgress(toolName, args, { targetUrl, policy });
  const irreversible = skipIrreversible ? null : matchIrreversible(toolName, args, settings, { elementText, targetUrl });
  const coverage = capsuleCovers(capsule, { toolName, args, targetUrl, sourceUrl: userUrl });
  Object.assign(base, { egress: egress.ok ? null : egress, irreversible, inCapsule: coverage.covered });

  if (!attended) {
    if (!egress.ok) return deny(egress.code, egress.reason, base);
    if (!sensitive.ok) return deny(sensitive.code, sensitive.reason, { ...base, sensitive });
    if (irreversible) {
      return { ...base, decision: "queue", needsConfirmation: false, code: CONFIRMATION_REQUIRED, reason: `不可逆操作需用户批准：${irreversible.reason}` };
    }
  } else {
    const reasons = [];
    if (!egress.ok) reasons.push(`出站拦截：${egress.reason}`);
    if (!sensitive.ok) reasons.push(`敏感路径：${sensitive.reason}`);
    if (irreversible && !SELF_CONFIRMING_TOOLS.has(toolName)) reasons.push(`不可逆操作：${irreversible.reason}（在你的确认清单里）`);
    if (reasons.length) {
      return confirm(`${reasons.join("；")}。[${toolName}]`, {
        ...base,
        needsAudit: hitlMode !== "strict",
        allowRemember: false,
        approveOrigin: !egress.ok && egress.origin ? egress.origin : undefined,
      });
    }
  }

  // 3. 本场免确认
  if (sessionOverride && attended) return allow(base);

  const crossOpts = { targetUrl, userUrl, approvedOrigins, isAllowed: (u) => policy.isAllowed(u) };
  const privileged = isToolPrivileged(toolName, args, crossOpts);

  // 4. 胶囊内
  if (coverage.covered) {
    if (hitlMode === "strict" && privileged && attended) {
      return confirm(`严格模式：特权操作 [${toolName}] 需手动授权（已在你的授权范围内）`, { ...base, needsAudit: false });
    }
    return allow({ ...base, why: coverage.why });
  }

  // 5. 只读
  if (READ_ONLY_TOOLS.has(toolName)) return allow(base);

  // 6. 高污染
  if (level === TAINT_HIGH) {
    if (!attended) return deny(NEEDS_WIDER_AUTHORIZATION, injectionReason(injection, toolName), base);
    return confirm(injectionReason(injection, toolName), { ...base, needsAudit: auditable });
  }

  // 7. 无人值守且已读入数据
  if (!attended && level === TAINT_DATA) {
    return deny(NEEDS_WIDER_AUTHORIZATION, `会话已读入外部数据，[${toolName}] 不在委托人的授权范围内（${coverage.why}）`, base);
  }

  // 8. 确认模式
  const legacy = legacyModeDecision({ toolName, args, hitlMode, privileged, crossOpts, base });
  if (legacy.decision === "confirm" && !attended) {
    return deny(NEEDS_WIDER_AUTHORIZATION, `${legacy.reason}；无人值守，需要委托人扩大授权`, base);
  }
  return legacy;
}

function legacyModeDecision({ toolName, args, hitlMode, privileged, crossOpts, base }) {
  if (hitlMode === "autonomous") return allow(base);
  if (!privileged) return allow(base);
  const isOriginTool = ORIGIN_SCOPED_TAB_TOOLS.has(toolName) || ORIGIN_SCOPED_NAV_TOOLS.has(toolName);
  const crossOrigin = isOriginTool ? crossOriginTarget(crossOpts) : null;
  if (crossOrigin !== null) {
    const where = crossOrigin || "未知来源";
    return confirm(
      `跨源操作：[${toolName}] 作用于 ${where}，不在你的授权范围内，也与你当前所在页面（${urlOrigin(crossOpts.userUrl) || "未知"}）不同，需手动授权`,
      {
        ...base,
        needsAudit: hitlMode !== "strict",
        // 只有明确的 http(s) origin 才能记入“本会话已放行”
        approveOrigin: crossOrigin || undefined,
      },
    );
  }
  if (hitlMode === "strict") {
    return confirm(`严格模式：特权操作 [${toolName}] 需手动授权`, { ...base, needsAudit: false });
  }
  if (toolName === "run_shell") {
    const cmd = args?.command;
    if (isShellCommandWhitelisted(cmd, { cwd: args?.cwd })) return allow(base);
    return confirm(`智能审查模式：非白名单命令待安全审核 [${cmd || ""}]`, { ...base, needsAudit: true });
  }
  return confirm(`智能审查模式：特权操作 [${toolName}] 待安全审核`, { ...base, needsAudit: true });
}

/** 给 LLM / 外部委托人的结构化拒绝结果 */
export function formatTrustDenial(decision, { pendingId = "" } = {}) {
  const code = decision?.code || NEEDS_WIDER_AUTHORIZATION;
  const hint = {
    [CONFIRMATION_REQUIRED]: "已放入待批准队列。请告诉用户在 PageLens 侧栏批准后再重试同一调用（参数保持一致）。",
    [NEEDS_WIDER_AUTHORIZATION]: "这一步不在委托人的授权范围内。不要换别的工具绕过；请回报委托人，说明需要扩大授权的动作与目标。",
    EGRESS_NOT_ALLOWED: "目的地不在声明范围内。不要换别的方式外发；请回报委托人确认目的地。",
    SENSITIVE_PATH: "涉及敏感本机文件，已拒绝。",
  }[code] || "";
  return JSON.stringify({
    ok: false,
    code,
    reason: decision?.reason || "",
    ...(pendingId ? { pendingId } : {}),
    ...(decision?.egress?.destination ? { destination: decision.egress.destination } : {}),
    hint,
  });
}

export { CONFIRMATION_REQUIRED, TAINT_CLEAN, TAINT_DATA, TAINT_HIGH };

/**
 * 确定性工作流 JSON 指令解析器与结构化摘要格式化（零业务语义、零落盘路径耦合）。
 */

import { interpolateParams } from "./binds.js";
import { WORKFLOW_SCHEMA_VERSION, WorkflowError } from "./errors.js";

export function isWorkflowDirectiveText(rawText) {
  return /^\s*\/workflow(?:\s|$)/i.test(String(rawText ?? ""));
}

function normalizeStepList(rawSteps, pathLabel = "steps") {
  if (!Array.isArray(rawSteps)) return [];
  return rawSteps.map((rawStep, idx) => {
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) {
      throw new WorkflowError({
        code: "WORKFLOW_INVALID_STEP",
        blame: "workflow",
        stepIndex: idx + 1,
        stepId: `${pathLabel}_${idx + 1}`,
        op: "parse",
        expected: "步骤为对象 { id, op, params }",
        actual: JSON.stringify(rawStep),
        message: `${pathLabel}[${idx}] 定义非法`,
      });
    }
    const stepId = String(rawStep.id || `${pathLabel}_${idx + 1}`).trim();
    const op = String(rawStep.op || "").trim();
    if (!op) {
      throw new WorkflowError({
        code: "WORKFLOW_MISSING_OP",
        blame: "workflow",
        stepIndex: idx + 1,
        stepId,
        op: "parse",
        expected: "非空步骤原语 op",
        actual: JSON.stringify(rawStep.op),
        message: `步骤 ${stepId} 缺少 op`,
      });
    }
    const params = rawStep.params && typeof rawStep.params === "object" ? { ...rawStep.params } : {};
    if (rawStep.macro && !params.macro) params.macro = rawStep.macro;
    if (rawStep.with && !params.with) params.with = rawStep.with;
    if (Array.isArray(rawStep.thenSteps) && !Array.isArray(params.thenSteps)) params.thenSteps = rawStep.thenSteps;
    if (Array.isArray(rawStep.elseSteps) && !Array.isArray(params.elseSteps)) params.elseSteps = rawStep.elseSteps;
    if (Array.isArray(rawStep.steps) && !Array.isArray(params.steps)) params.steps = rawStep.steps;
    if (rawStep.scope && !params.scope) params.scope = rawStep.scope;

    return {
      id: stepId,
      op,
      description: rawStep.description ? String(rawStep.description) : "",
      when: rawStep.when,
      screenshot: Boolean(rawStep.screenshot),
      params,
    };
  });
}

export function parseWorkflowDirective(rawText) {
  const raw = String(rawText ?? "");
  if (!isWorkflowDirectiveText(raw)) return null;

  let body = raw.replace(/^\s*\/workflow\b/i, "").trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/i.exec(body);
  if (fenced) body = fenced[1].trim();

  if (!body) {
    throw new WorkflowError({
      code: "WORKFLOW_EMPTY_BODY",
      blame: "workflow",
      stepIndex: 0,
      stepId: "workflow.parse",
      op: "parse",
      expected: "/workflow 后紧跟 schemaVersion=1.0 的 JSON 定义",
      actual: "指令正文为空",
      message: "工作流指令正文为空",
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new WorkflowError({
      code: "WORKFLOW_INVALID_JSON",
      blame: "workflow",
      stepIndex: 0,
      stepId: "workflow.parse",
      op: "parse",
      expected: "合法 JSON 对象",
      actual: `JSON 解析失败: ${err?.message || String(err)}`,
      message: `工作流 JSON 解析失败: ${err?.message || String(err)}`,
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowError({
      code: "WORKFLOW_INVALID_ROOT",
      blame: "workflow",
      stepIndex: 0,
      stepId: "workflow.parse",
      op: "parse",
      expected: "顶层为 JSON 对象",
      actual: typeof parsed,
      message: "工作流顶层必须为 JSON 对象",
    });
  }

  if (parsed.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    throw new WorkflowError({
      code: "WORKFLOW_UNSUPPORTED_SCHEMA",
      blame: "workflow",
      stepIndex: 0,
      stepId: "workflow.parse",
      op: "parse",
      expected: `schemaVersion === "${WORKFLOW_SCHEMA_VERSION}"`,
      actual: `schemaVersion === ${JSON.stringify(parsed.schemaVersion)}`,
      message: `不支持的 schemaVersion: ${String(parsed.schemaVersion)}`,
    });
  }

  const id = String(parsed.id || "").trim();
  if (!id) {
    throw new WorkflowError({
      code: "WORKFLOW_MISSING_ID",
      blame: "workflow",
      stepIndex: 0,
      stepId: "workflow.parse",
      op: "parse",
      expected: "非空字符串 id",
      actual: JSON.stringify(parsed.id),
      message: "工作流缺少非空 id",
    });
  }

  const binds = parsed.binds == null ? {} : parsed.binds;
  if (typeof binds !== "object" || Array.isArray(binds)) {
    throw new WorkflowError({
      code: "WORKFLOW_INVALID_BINDS",
      blame: "workflow",
      stepIndex: 0,
      stepId: "workflow.parse",
      op: "parse",
      expected: "binds 为键值对象",
      actual: Array.isArray(binds) ? "array" : typeof binds,
      message: "工作流 binds 必须为对象",
    });
  }

  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new WorkflowError({
      code: "WORKFLOW_EMPTY_STEPS",
      blame: "workflow",
      stepIndex: 0,
      stepId: "workflow.parse",
      op: "parse",
      expected: "非空 steps 数组",
      actual: JSON.stringify(parsed.steps),
      message: "工作流 steps 必须为非空数组",
    });
  }

  const steps = normalizeStepList(parsed.steps, "step");

  const macros = {};
  if (parsed.macros && typeof parsed.macros === "object" && !Array.isArray(parsed.macros)) {
    for (const [mName, mRaw] of Object.entries(parsed.macros)) {
      const mStepsRaw = Array.isArray(mRaw) ? mRaw : mRaw?.steps;
      if (Array.isArray(mStepsRaw)) {
        macros[mName] = {
          defaults: mRaw && !Array.isArray(mRaw) && typeof mRaw.defaults === "object" ? mRaw.defaults : {},
          steps: normalizeStepList(mStepsRaw, `macro_${mName}`),
        };
      }
    }
  }

  const policyObj = parsed.policy && typeof parsed.policy === "object" ? parsed.policy : {};
  const forbidClickTexts = [
    ...(Array.isArray(parsed.forbidClickTexts) ? parsed.forbidClickTexts : []),
    ...(Array.isArray(policyObj.forbidClickTexts) ? policyObj.forbidClickTexts : []),
  ]
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  const forbidSelectors = [
    ...(Array.isArray(parsed.forbidSelectors) ? parsed.forbidSelectors : []),
    ...(Array.isArray(policyObj.forbidSelectors) ? policyObj.forbidSelectors : []),
  ]
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  const forbidUrlSubstrings = [
    ...(Array.isArray(parsed.forbidUrlSubstrings) ? parsed.forbidUrlSubstrings : []),
    ...(Array.isArray(policyObj.forbidUrlPatterns) ? policyObj.forbidUrlPatterns : []),
  ]
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  const fileChooserPolicy = String(policyObj.fileChooserPolicy || parsed.fileChooserPolicy || "deny");

  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id,
    name: parsed.name ? String(parsed.name) : id,
    binds,
    macros,
    steps,
    summaryLines: Array.isArray(parsed.summaryLines) ? parsed.summaryLines.map(String) : [],
    policy: {
      forbidClickTexts,
      forbidSelectors,
      forbidUrlPatterns: forbidUrlSubstrings,
      fileChooserPolicy,
    },
    forbidClickTexts,
    forbidSelectors,
    forbidUrlSubstrings,
  };
}

export function formatWorkflowSummary({
  ok,
  aborted = false,
  workflowId = "",
  totalSteps = 0,
  executedSteps = 0,
  skippedSteps = 0,
  durationMs = 0,
  mutationsCount = 0,
  summaryLines = [],
  binds = {},
  screenshots = [],
  failure = null,
} = {}) {
  if (aborted) {
    return `已停止确定性工作流 \`${workflowId || "workflow"}\`（已完成 ${executedSteps}/${totalSteps} 步）。`;
  }
  if (!ok && failure) {
    const lines = [
      `❌ 确定性工作流执行失败（\`${workflowId || "workflow"}\`）`,
      `- 失败步骤: 第 ${failure.stepIndex} 步 (${failure.stepId} · ${failure.op})`,
      `- 错误代码: ${failure.code || "WORKFLOW_STEP_FAILED"}`,
      `- 期望条件: ${failure.expected || "步骤执行通过"}`,
      `- 实际回读: ${failure.actual || failure.message || "未知异常"}`,
    ];
    if (failure.hasScreenshot) {
      lines.push(`- 现场证据: 已捕获内存诊断截图`);
    }
    return lines.join("\n");
  }

  const lines = [`✅ 确定性工作流执行通过（\`${workflowId}\`）`];
  if (Array.isArray(summaryLines) && summaryLines.length > 0) {
    for (const tpl of summaryLines) {
      const rendered = String(interpolateParams(tpl, binds, {}, { allowMissing: true }) || "").trim();
      if (rendered) lines.push(`- ${rendered}`);
    }
  }
  lines.push(`- 执行步数: ${executedSteps}/${totalSteps}（条件跳过 ${skippedSteps} 步，状态变更 ${mutationsCount} 项）`);
  lines.push(`- 总耗时: ${Math.max(0, Math.round(durationMs))} ms`);
  lines.push(`- 模型调用: 0 回合 / 0 词元`);
  if (Array.isArray(screenshots) && screenshots.length > 0) {
    lines.push(`- 诊断截图: 内存保留 ${screenshots.length} 张`);
  }
  return lines.join("\n");
}

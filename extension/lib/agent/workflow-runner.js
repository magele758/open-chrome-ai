/**
 * 确定性工作流模块统一导出入口（通用原语与控制流，零业务语义）。
 */

export {
  WORKFLOW_MODEL_ID,
  WORKFLOW_SCHEMA_VERSION,
  WorkflowError,
  detectExternalBlocker,
  normalizeCjkText,
  normalizeSpaces,
} from "./workflow/errors.js";

export {
  applyBindTransforms,
  evaluateDataTransform,
  evaluateWhenPredicate,
  interpolateParams,
  lookupBindValue,
  setBindValue,
} from "./workflow/binds.js";

export {
  ASSERT_KIND_SNIPPETS,
  DEFAULT_ADAPTER_SPEC,
  buildAssertStateBatches,
  buildSingleAssertScript,
} from "./workflow/assert-batches.js";

export {
  formatWorkflowSummary,
  isWorkflowDirectiveText,
  parseWorkflowDirective,
} from "./workflow/parser.js";

export { runDeterministicWorkflow } from "./workflow/engine.js";

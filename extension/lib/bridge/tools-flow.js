import { createShopeeListingBridgeTools, SHOPEE_LISTING_BRIDGE_TOOL_NAMES } from "../../flows/shopee/product-listing/bridge-tools.js";
import { listFlows, matchesFlowTarget, runFlow } from "../flow/runtime.js";
import { BridgeError, ERROR_CODES } from "./protocol.js";

const FLOW_CHILDREN = new Set([
  ...SHOPEE_LISTING_BRIDGE_TOOL_NAMES,
  "query_dom", "wait_for", "fill", "trusted_click", "trusted_type", "press_keys", "upload_file",
]);

/** Adapt fixed flow operations to the existing bridge tools, with their own scopes and guards. */
export function flowBridgeCall(tool, args, tabId) {
  if (!FLOW_CHILDREN.has(tool) || args?.tabId !== tabId) {
    throw new BridgeError(ERROR_CODES.BAD_ARGS, "流程工具或目标标签不符合当前任务。");
  }
  if (tool === "fill") {
    if (args.submit !== false) throw new BridgeError(ERROR_CODES.BAD_ARGS, "流程填写步骤不能提交表单。");
    return { tool: "set_input_value", args: { tabId, selector: args.selector, value: args.value } };
  }
  if (tool === "trusted_type" && args.submit) {
    throw new BridgeError(ERROR_CODES.BAD_ARGS, "流程输入步骤不能提交表单。");
  }
  return { tool, args };
}

function assertFlowPage(flowId, url, shopId) {
  if (!matchesFlowTarget(flowId, url, shopId)) {
    throw new BridgeError(ERROR_CODES.BAD_ARGS, "当前标签页或店铺与指定的内置流程不匹配。");
  }
}

function includesUpload(input) {
  const variant = input?.variant;
  return input?.imagePath != null || variant?.imagePath != null ||
    (Array.isArray(variant?.options) && variant.options.some((item) => item?.imagePath != null));
}

export function createFlowTools(env, { obj, TAB_ID }) {
  return [
    ...createShopeeListingBridgeTools(env, { obj, TAB_ID, assertFlowPage }),
    {
      name: "list_flows",
      sessionOnly: true,
      scope: "page:read",
      description: "列出 PageLens 内置的确定性流程、目标网站和页面。",
      parameters: obj({}),
      execute: (_args, ctx) => ({
        flows: listFlows().filter(({ origin, path }) => {
          try {
            ctx.authorizeUrl(origin + path);
            return true;
          } catch {
            return false;
          }
        }),
      }),
    },
    {
      name: "run_flow",
      sessionOnly: true,
      scope: "page:act",
      needsTab: true,
      requiredScopes: (args) => ["page:read", ...(includesUpload(args.input) ? ["upload"] : [])],
      description: "在当前标签按 flowId 和参数运行内置流程。可用 async 和 job_status 查询进度，异常返回 needs-review。",
      parameters: obj({
        flowId: { type: "string", description: "list_flows 返回的流程 ID" },
        tabId: TAB_ID,
        input: { type: "object", description: "流程参数 JSON。Shopee 接收店铺 ID、标题、描述、类目、属性、图片、规格和运费。" },
      }, ["flowId", "tabId", "input"]),
      async execute({ flowId, tabId, input }, ctx) {
        assertFlowPage(flowId, ctx.tab.url, input.shopId);
        return runFlow({ flowId, tabId, input, call: ctx.flowCall, onStep: ctx.flowProgress, signal: ctx.signal });
      },
    },
  ];
}

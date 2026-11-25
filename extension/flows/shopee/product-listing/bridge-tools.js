import { BridgeError, ERROR_CODES } from "../../../lib/bridge/protocol.js";
import { operateShopeeSizeChart } from "./page-size-chart.mjs";
import { clickCategoryRecommendation, clickListingControl, readPage, writeListingVariant } from "./page-state.mjs";

export const SHOPEE_LISTING_BRIDGE_TOOL_NAMES = [
  "flow_page_state",
  "flow_size_chart_state",
  "flow_size_chart_action",
  "flow_category_click",
  "flow_control_click",
  "flow_variant_write",
];

export function createShopeeListingBridgeTools(env, { obj, TAB_ID, assertFlowPage }) {
  return [
    {
      name: "flow_page_state",
      sessionOnly: true,
      scope: "page:read",
      needsTab: true,
      description: "读取 Shopee 商品上架的固定表单状态。仅在该流程适用的页面可用。",
      parameters: obj({
        tabId: TAB_ID,
        category: { type: "string", description: "待匹配的完整类目路径" },
        verifySummary: { type: "boolean" },
      }, ["tabId", "category"]),
      async execute({ tabId, category }, ctx) {
        if (category.length > 220) throw new BridgeError(ERROR_CODES.BAD_ARGS, "类目路径长度超过 220 字符。");
        assertFlowPage("shopee-listing", ctx.tab.url);
        return env.inject(tabId, readPage, [category]);
      },
    },
    {
      name: "flow_category_click",
      sessionOnly: true,
      flowOnly: true,
      scope: "page:act",
      needsTab: true,
      parameters: obj({
        tabId: TAB_ID,
        category: { type: "string" },
        selector: { type: "string" },
      }, ["tabId", "category", "selector"]),
      async execute({ tabId, selector, category }, ctx) {
        if (category.length > 220 || selector.length > 2048) {
          throw new BridgeError(ERROR_CODES.BAD_ARGS, "类目路径或控件定位超出限制。");
        }
        assertFlowPage("shopee-listing", ctx.tab.url);
        return env.inject(tabId, clickCategoryRecommendation, [selector, category, ctx.tab.url], { world: "MAIN" });
      },
    },
    {
      name: "flow_control_click",
      sessionOnly: true,
      flowOnly: true,
      scope: "page:act",
      needsTab: true,
      parameters: obj({
        tabId: TAB_ID,
        action: { type: "string" },
        category: { type: "string" },
        selector: { type: "string" },
        label: { type: "string" },
        text: { type: "string" },
      }, ["tabId", "action", "category", "selector", "label"]),
      async execute({ tabId, ...target }, ctx) {
        if (!["attribute-trigger", "attribute-option", "variant-enable"].includes(target.action) ||
            target.category.length > 220 || target.selector.length > 2048 || target.label.length > 220 || target.text?.length > 400) {
          throw new BridgeError(ERROR_CODES.BAD_ARGS, "流程控件参数超出限制。");
        }
        assertFlowPage("shopee-listing", ctx.tab.url);
        return env.inject(tabId, clickListingControl, [target, ctx.tab.url], { world: "MAIN" });
      },
    },
    {
      name: "flow_variant_write",
      sessionOnly: true,
      flowOnly: true,
      scope: "page:act",
      needsTab: true,
      parameters: obj({
        tabId: TAB_ID,
        kind: { type: "string" },
        category: { type: "string" },
        selector: { type: "string" },
        name: { type: "string" },
        option: { type: "string" },
        existingOptions: { type: "array", items: { type: "string" } },
      }, ["tabId", "kind", "category", "selector", "name", "existingOptions"]),
      async execute({ tabId, ...target }, ctx) {
        if (!["name", "option"].includes(target.kind) || target.category.length > 220 || target.selector.length > 2048 ||
            target.name.length > 14 || target.option?.length > 30 ||
            target.existingOptions.some((option) => typeof option !== "string" || option.length > 30)) {
          throw new BridgeError(ERROR_CODES.BAD_ARGS, "规格输入参数超出限制。");
        }
        assertFlowPage("shopee-listing", ctx.tab.url);
        return env.inject(tabId, writeListingVariant, [target, ctx.tab.url], { world: "MAIN" });
      },
    },
    {
      name: "flow_size_chart_state",
      sessionOnly: true,
      flowOnly: true,
      scope: "page:read",
      needsTab: true,
      parameters: obj({ tabId: TAB_ID, category: { type: "string" } }, ["tabId", "category"]),
      async execute({ tabId, category }, ctx) {
        assertFlowPage("shopee-listing", ctx.tab.url);
        return env.inject(tabId, operateShopeeSizeChart, [{ category }, ctx.tab.url]);
      },
    },
    {
      name: "flow_size_chart_action",
      sessionOnly: true,
      flowOnly: true,
      scope: "page:act",
      needsTab: true,
      parameters: obj({
        tabId: TAB_ID,
        action: { type: "string" },
        category: { type: "string" },
        name: { type: "string" },
        label: { type: "string" },
        unit: { type: "string" },
        checked: { type: "boolean" },
        rowCount: { type: "integer" },
        rows: { type: "array", items: { type: "object" } },
      }, ["tabId", "action", "category"]),
      async execute({ tabId, ...args }, ctx) {
        assertFlowPage("shopee-listing", ctx.tab.url);
        return env.inject(tabId, operateShopeeSizeChart, [args, ctx.tab.url], { world: "MAIN" });
      },
    },
  ];
}

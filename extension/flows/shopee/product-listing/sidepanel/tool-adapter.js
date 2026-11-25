import { operateShopeeSizeChart } from "../page-size-chart.mjs";
import { completeSizeChartInput } from "./product-directory.js";
import { clickCategoryRecommendation, clickListingControl, operateShopeeCategory, readPage, writeListingVariant } from "../page-state.mjs";
import { withShopeeTabFocus } from "../submit-listing.mjs";
import { createCdpTools, dialogNote, withDialogGuard } from "../../../../lib/agent/cdp-tools.js";
import { queryDom } from "../../../../lib/agent/page-fns.js";
import { matchIrreversible } from "../../../../lib/agent/trust/irreversible.js";
import { plSetInputValue, plWaitFor } from "../../../../lib/bridge/editor-fns.js";
import { isSensitiveUploadPath } from "../../../../lib/bridge/tools-browser.js";
import { getCdp } from "../../../../lib/cdp.js";
import { matchesFlowTarget } from "../../../../lib/flow/runtime.js";
import { ensureOptionalAccess } from "../../../../lib/optional-permissions.js";

const INPUTS = new Set(["fill", "trusted_type"]);
const CDP_TOOLS = new Set(["trusted_click", "trusted_type", "press_keys", "upload_file"]);
const TOOL_SETTINGS = {};
const unsafeClick = /^(?:创建|取消|保存|提交|create|cancel|save|submit)(?:$|并)/iu;
const categoryPath = value => typeof value === "string" && value.length <= 220 && value.includes(" > ");
let categoryCacheWrites = Promise.resolve();

function fail(code, error) {
  return { ok: false, code, error };
}

export function createPtcToolCaller({ tabId, signal, confirmUpload, completeChart = completeSizeChartInput,
  adviseAttributes, allowFreshVariantReset = false, url: expectedUrl } = {}) {
  let url = expectedUrl;
  let documentId;
  const cdp = getCdp();
  const resolveTabId = async () => tabId;
  const available = createCdpTools({}, { cdp, resolveTabId, attachTabToTask: async () => {}, getRefItem: () => ({ error: "流程使用当前页面的选择器定位" }) });
  const tools = new Map(withDialogGuard(available, { cdp, resolveTabId, enabled: true })
    .filter(({ name }) => CDP_TOOLS.has(name)).map((tool) => [tool.name, tool]));

  const readTab = async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!matchesFlowTarget("shopee-listing", tab?.url) || url && url !== tab.url) return fail("page-changed", "页面或店铺已变化");
    url = tab.url;
    const access = await ensureOptionalAccess({ url, tabId, interactive: false, force: true });
    return access.granted ? null : fail("permission-denied", access.message || "Chrome 未授予此站点访问权限");
  };

  const exec = async (func, args, world) => {
    const target = documentId ? { tabId, documentIds: [documentId] } : { tabId };
    const [reply] = await chrome.scripting.executeScript({ target, func, args, ...(world ? { world } : {}) });
    if (!reply || reply.frameId !== 0 || documentId && reply.documentId !== documentId) throw new Error("当前页面文档已变化");
    documentId ||= reply.documentId;
    return reply.result;
  };

  return async (tool, args) => {
    signal?.throwIfAborted();
    if (args?.tabId !== tabId) return fail("page-changed", "工作流标签已变化");
    const denied = await readTab();
    if (denied) return denied;
    const dialog = cdp.pendingDialog(tabId);
    if (dialog) return fail("modal", dialogNote(dialog));
    switch (tool) {
      case "flow_attribute_advice": {
        if (!adviseAttributes) return fail("attribute-advice-not-approved", "请允许已配置的 AI 分析本次商品。");
        try { return { values: await adviseAttributes(args.fields) }; }
        catch (error) {
          if (signal?.aborted) throw error;
          return fail("attribute-advice-unavailable", error?.message || "商品属性识别暂不可用。");
        }
      }
      case "flow_page_state":
        if (args.verifySummary !== true) return exec(readPage, [args.category]);
        return withShopeeTabFocus(chrome.tabs, tabId, async () => {
          const changed = await readTab();
          if (changed) return changed;
          await chrome.tabs.update(tabId, { active: true }).catch(() => {});
          return exec(readPage, [args.category]);
        }, signal);
      case "flow_size_chart_state":
        return exec(operateShopeeSizeChart, [{ category: args.category }, url]);
      case "flow_size_chart_action": {
        const result = await exec(operateShopeeSizeChart, [args, url], "MAIN");
        if (result?.ok && ["save", "dismiss"].includes(args.action)) {
          // Chrome may postpone the modal-close animation until the tab is visible.
          await withShopeeTabFocus(chrome.tabs, tabId, async () => {
            if (!await readTab()) await chrome.tabs.update(tabId, { active: true }).catch(() => {});
          }, signal);
        }
        return result;
      }
      case "flow_size_chart_complete": {
        try {
          const { chart, requiredColumns, category, title } = args;
          const sizeChart = await completeChart({
            chart, category, title, signal,
            requiredColumns: requiredColumns.map(column => column.label),
            optionsByColumn: Object.fromEntries(requiredColumns.filter(column => column.options)
              .map(column => [column.label, column.options])),
          });
          return { sizeChart };
        } catch (error) {
          if (signal?.aborted) throw error;
          return fail("size-chart-inference-failed", error?.message || "无法补齐尺码表。");
        }
      }
      case "flow_category_click":
        signal?.throwIfAborted();
        return exec(clickCategoryRecommendation, [args.selector, args.category, url], "MAIN");
      case "flow_category_picker_action":
        return exec(operateShopeeCategory, [args, url], "MAIN");
      case "flow_category_advice": {
        if (!adviseAttributes) return { index: null, keywords: [] };
        const hints = Array.isArray(args.hints) ? args.hints.slice(0, 10) : [];
        const shop = new URL(url).searchParams.get("cnsc_shop_id");
        const key = `pagelens.shopee.categories.v1.${shop}`;
        try {
          if (args.mode === "cache") {
            const stored = (await chrome.storage.local.get(key))?.[key];
            const paths = (Array.isArray(stored) ? stored : []).filter(categoryPath).slice(0, 12);
            if (paths.length) {
              const decision = await adviseAttributes.chooseCachedCategory({ candidates: paths.map(path => path.split(" > ")), hints });
              return { path: paths[decision.index], keywords: decision.keywords };
            }
            return { keywords: [] };
          }
          if (args.mode === "keywords") return { keywords: await adviseAttributes.categoryKeywords({ hints }) };
          const candidates = Array.isArray(args.candidates) ? args.candidates.slice(0, 24) : [];
          return { index: await adviseAttributes.chooseCategory({ candidates, hints }) };
        } catch (error) {
          signal?.throwIfAborted();
          return { index: null, keywords: [] };
        }
      }
      case "flow_category_remember": {
        if (!categoryPath(args.category)) return { ok: true };
        const current = await exec(readPage, [args.category]);
        if (current?.category !== args.category || !current.categoryReady) return { ok: true };
        const shop = new URL(url).searchParams.get("cnsc_shop_id");
        const key = `pagelens.shopee.categories.v1.${shop}`;
        const write = categoryCacheWrites.then(async () => {
          const stored = (await chrome.storage.local.get(key))?.[key];
          const paths = (Array.isArray(stored) ? stored : []).filter(path => categoryPath(path) && path !== args.category);
          await chrome.storage.local.set({ [key]: [args.category, ...paths].slice(0, 40) });
        });
        categoryCacheWrites = write.catch(() => {});
        await categoryCacheWrites;
        return { ok: true };
      }
      case "flow_control_click":
        if (args.action === "variant-reset" && !allowFreshVariantReset) {
          return fail("tool-not-allowed", "仅允许清除当前批次新打开表单的预带规格。");
        }
        signal?.throwIfAborted();
        return exec(clickListingControl, [args, url], "MAIN");
      case "flow_variant_write":
        signal?.throwIfAborted();
        return exec(writeListingVariant, [args, url], "MAIN");
      case "query_dom":
        return exec(queryDom, [args.selector, args.limit]);
      case "wait_for":
        return exec(plWaitFor, [args]);
      default:
        break;
    }
    if (!tools.has(tool) && tool !== "fill") return fail("tool-not-allowed", "工作流没有权限调用该工具");

    if (INPUTS.has(tool) || tool === "trusted_click" || tool === "upload_file") {
      const targets = await exec(queryDom, [args.selector, 2]);
      const target = Array.isArray(targets) && targets.length === 1 ? targets[0] : null;
      if (!target) return fail("control-changed", "页面控件已变化");
      if (INPUTS.has(tool) && (!["input", "textarea"].includes(target.tag) || ["file", "password", "hidden"].includes(target.type) || args.submit)) {
        return fail("field-kind-changed", "页面输入控件类型已变化");
      }
      if (tool === "trusted_click" && (target.text !== args.text || unsafeClick.test(target.text) ||
          matchIrreversible(tool, args, TOOL_SETTINGS, { targetUrl: url, elementText: target.text }))) {
        return fail("click-label-changed", "按钮文字发生变化或属于提交操作");
      }
      if (tool === "upload_file") {
        if (target.tag !== "input" || target.type !== "file" || args.paths?.length !== 1 ||
            isSensitiveUploadPath(args.paths[0])) return fail("upload-denied", "文件或上传控件不在本次流程范围内");
        if (!(await confirmUpload?.(args))) return fail("upload-denied", "此主图尚未获同意上传");
      }
    }
    if (tool === "press_keys" && (args.keys?.length !== 1 || !["Escape", "Tab"].includes(args.keys[0]))) {
      return fail("tool-not-allowed", "此按键不在流程范围内");
    }

    signal?.throwIfAborted();
    if (tool === "fill") {
      const applied = await exec(plSetInputValue, [{ selector: args.selector, value: args.value,
        commit: args.commit === true }], "MAIN");
      if (!applied?.matches) return fail("readback-mismatch", applied?.error || "页面没有接受填写值");
      return applied;
    }
    const result = await tools.get(tool).execute(args);
    if (typeof result === "string" && result.includes("页面弹出了")) return fail("modal", result);
    return result;
  };
}

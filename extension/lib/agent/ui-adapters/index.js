/**
 * 可插拔 UI 组件适配器注册表与跨 executeScript 纯数据描述符（UIAdapterSpec）合成器。
 *
 * 原则：
 * 1. `aria-native` 始终作为最高优先级默认底座；`antd`、`element-plus` 作为插件叠加。
 * 2. 合成出的 `UIAdapterSpec` 纯 JSON 可序列化，可直接透传给 `chrome.scripting.executeScript({ func, args })`。
 */

import { ANTD_ADAPTER } from "./antd.js";
import { ARIA_NATIVE_ADAPTER } from "./aria-native.js";
import { ELEMENT_PLUS_ADAPTER } from "./element-plus.js";

const registry = new Map();

function uniq(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const item = String(raw || "").trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function joinSel(list) {
  return uniq(list).join(", ");
}

export function registerUIAdapter(adapter) {
  if (!adapter || typeof adapter.id !== "string" || !adapter.id.trim()) {
    throw new Error("UIAdapter requires a non-empty id");
  }
  registry.set(adapter.id.trim(), adapter);
  return adapter;
}

export function unregisterUIAdapter(id) {
  return registry.delete(String(id || "").trim());
}

export function getUIAdapter(id) {
  return registry.get(String(id || "").trim()) || null;
}

export function listUIAdapters() {
  return [...registry.values()].sort((a, b) => (b.priority || 0) - (a.priority || 0));
}

registerUIAdapter(ARIA_NATIVE_ADAPTER);
registerUIAdapter(ANTD_ADAPTER);
registerUIAdapter(ELEMENT_PLUS_ADAPTER);

/**
 * 将一个或多个 UIAdapter 合成为纯数据描述符 UIAdapterSpec（保证始终包含 aria-native 底座）。
 */
export function composeUIAdapterSpec(adaptersOrIds) {
  let adapters;
  if (Array.isArray(adaptersOrIds) && adaptersOrIds.length > 0) {
    const resolved = adaptersOrIds
      .map((entry) => (typeof entry === "string" ? getUIAdapter(entry) : entry))
      .filter(Boolean);
    if (!resolved.some((a) => a.id === "aria-native")) {
      resolved.unshift(ARIA_NATIVE_ADAPTER);
    }
    adapters = resolved.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  } else {
    adapters = listUIAdapters();
  }

  const pick = (section, field) => adapters.flatMap((a) => a?.[section]?.[field] || []);

  const leavePatterns = uniq(pick("modal", "leaveClassPatterns"));

  return Object.freeze({
    adapterIds: Object.freeze(adapters.map((a) => a.id)),

    // 1. Modal / Drawer
    dialogSelector: joinSel(pick("modal", "dialogSelectors")),
    dialogWrapSelector: joinSel(pick("modal", "wrapSelectors")),
    dialogTitleSelector: joinSel(pick("modal", "titleSelectors")),
    dialogBodySelector: joinSel(pick("modal", "bodySelectors")),
    dialogCloseSelector: joinSel(pick("modal", "closeButtonSelectors")),
    appRootSelector: joinSel(pick("modal", "appRootSelectors")),
    leaveClassPattern: leavePatterns.length ? `(?:${leavePatterns.join("|")})` : "",
    hiddenPortalClasses: Object.freeze(uniq(pick("modal", "hiddenPortalClasses"))),

    // 2. Combobox / Select
    comboboxRootSelector: joinSel(pick("combobox", "rootSelectors")),
    comboboxRootClasses: Object.freeze(uniq(pick("combobox", "rootClasses"))),
    excludeCascaderSelector: joinSel(pick("combobox", "excludeCascaderSelectors")),
    triggerSubSelector: joinSel(pick("combobox", "triggerSubSelectors")),
    proxyTriggerSelector: joinSel(pick("combobox", "proxyTriggerSelectors")),
    proxySecondarySelector: joinSel(pick("combobox", "proxySecondarySelectors")),
    openRootSelector: joinSel(pick("combobox", "openRootSelectors")),
    openDescendantSelector: joinSel(pick("combobox", "openDescendantSelectors")),
    searchableRootClasses: Object.freeze(uniq(pick("combobox", "searchableRootClasses"))),
    popupSelector: joinSel(pick("combobox", "popupSelectors")),
    popupLayerSelector: joinSel(pick("combobox", "popupLayerSelectors")),
    optionSelector: joinSel(pick("combobox", "optionSelectors")),
    optionContentSelector: joinSel(pick("combobox", "optionContentSelectors")),
    selectedItemSelector: joinSel(pick("combobox", "selectedItemSelectors")),
    selectedItemContentSelector: joinSel(pick("combobox", "selectedItemContentSelectors")),
    selectedItemRemoveSelector: joinSel(pick("combobox", "selectedItemRemoveSelectors")),
    placeholderSelector: joinSel(pick("combobox", "placeholderSelectors")),
    searchInputSelector: joinSel(pick("combobox", "searchInputSelectors")),

    // 3. Cascader
    cascaderRootSelector: joinSel(pick("cascader", "rootSelectors")),
    cascaderColumnSelector: joinSel(pick("cascader", "columnSelectors")),
    cascaderItemSelector: joinSel(pick("cascader", "itemSelectors")),
    cascaderExpandedSelector: joinSel(pick("cascader", "expandedItemSelectors")),

    // 4. Table
    tableRowSelector: joinSel(pick("table", "rowSelectors")),
    tableCellSelector: joinSel(pick("table", "cellSelectors")),
    emptyRowClasses: Object.freeze(uniq(pick("table", "emptyRowClasses"))),

    // 5. Upload
    uploadListSelector: joinSel(pick("upload", "uploadedListSelectors")),
    uploadTriggerSelector: joinSel(pick("upload", "triggerSelectors")),

    // 6. FormField & Feedback
    fieldContainerSelector: joinSel(pick("formAndFeedback", "fieldContainerSelectors")),
    fieldLabelSelector: joinSel(pick("formAndFeedback", "labelSelectors")),
    radioGroupSelector: joinSel(pick("formAndFeedback", "radioGroupSelectors")),
    requiredSelector: joinSel(pick("formAndFeedback", "requiredIndicators")),
    loadingSelector: joinSel(pick("formAndFeedback", "loadingSelectors")),
    alertSelector: joinSel(pick("formAndFeedback", "errorAlertSelectors")),
  });
}

export const ARIA_NATIVE_SPEC = composeUIAdapterSpec(["aria-native"]);
export const DEFAULT_COMPOSITE_ADAPTER_SPEC = composeUIAdapterSpec(["aria-native", "antd", "element-plus"]);

export function getCompositeUIAdapterSpec(adapterIds) {
  if (!Array.isArray(adapterIds) || adapterIds.length === 0) {
    return DEFAULT_COMPOSITE_ADAPTER_SPEC;
  }
  return composeUIAdapterSpec(adapterIds);
}

// 供同进程 Node / JSDOM 直接调用页面函数时自动读取合成描述符；跨 realm 注入时通过 args 显式传递。
globalThis.__pagelensAdapterSpec = DEFAULT_COMPOSITE_ADAPTER_SPEC;

export { ARIA_NATIVE_ADAPTER, ANTD_ADAPTER, ELEMENT_PLUS_ADAPTER };

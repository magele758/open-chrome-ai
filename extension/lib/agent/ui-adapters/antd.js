/**
 * Ant Design (v4 / v5) 组件库适配器插件。
 * 仅修补 Ant Design 偏离 WAI-ARIA 标准的实现细节（如未卸载的隐藏浮层、自定义回显区、级联菜单列等），不含任何业务语义。
 */

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

const ANTD_LEAVE_RE = /\b(?:ant|rc)-[a-z0-9-]*-leave(?:-active|-to)?\b/;
const ANTD_HIDDEN_PORTAL_CLASSES = Object.freeze([
  "ant-select-dropdown-hidden",
  "ant-dropdown-hidden",
  "ant-popover-hidden",
  "ant-picker-dropdown-hidden",
  "ant-tooltip-hidden",
]);

export const ANTD_ADAPTER = Object.freeze({
  id: "antd",
  priority: 50,

  modal: Object.freeze({
    dialogSelectors: Object.freeze([".ant-modal", ".ant-drawer", ".ant-modal-content", ".ant-drawer-content"]),
    wrapSelectors: Object.freeze([".ant-modal-wrap", ".ant-drawer-content-wrapper"]),
    titleSelectors: Object.freeze([
      ".ant-modal-title",
      ".ant-modal-header",
      ".ant-drawer-title",
      ".ant-drawer-header",
    ]),
    bodySelectors: Object.freeze([".ant-modal-content", ".ant-drawer-content", ".ant-modal-body", ".ant-drawer-body"]),
    closeButtonSelectors: Object.freeze([".ant-modal-close", ".ant-drawer-close"]),
    leaveClassPatterns: Object.freeze(["\\b(?:ant|rc)-[a-z0-9-]*-leave(?:-active|-to)?\\b"]),
    hiddenPortalClasses: ANTD_HIDDEN_PORTAL_CLASSES,
    appRootSelectors: Object.freeze([".ant-layout-content"]),
    isLeavingOrHidden(el) {
      if (!el || el.nodeType !== 1) return true;
      for (const cls of ANTD_HIDDEN_PORTAL_CLASSES) {
        if (el.classList?.contains(cls)) return true;
      }
      const clsName = typeof el.className === "string" ? el.className : "";
      return Boolean(clsName && ANTD_LEAVE_RE.test(clsName));
    },
  }),

  combobox: Object.freeze({
    rootSelectors: Object.freeze([".ant-select"]),
    rootClasses: Object.freeze(["ant-select"]),
    excludeCascaderSelectors: Object.freeze([".ant-cascader"]),
    triggerSubSelectors: Object.freeze([".ant-select-selector"]),
    proxyTriggerSelectors: Object.freeze([
      ".ant-select-selector",
      ".ant-cascader-picker",
      ".ant-picker",
      ".ant-checkbox-wrapper",
      ".ant-radio-wrapper",
      ".ant-switch",
    ]),
    proxySecondarySelectors: Object.freeze([".ant-select", ".ant-cascader"]),
    openRootSelectors: Object.freeze([".ant-select-open"]),
    openDescendantSelectors: Object.freeze([]),
    searchableRootClasses: Object.freeze(["ant-select-show-search"]),
    popupSelectors: Object.freeze([".ant-select-dropdown:not(.ant-select-dropdown-hidden)"]),
    popupLayerSelectors: Object.freeze([
      ".ant-select-dropdown:not(.ant-select-dropdown-hidden)",
      ".ant-cascader-dropdown:not(.ant-select-dropdown-hidden)",
      ".ant-dropdown:not(.ant-dropdown-hidden)",
    ]),
    optionSelectors: Object.freeze([".ant-select-item-option:not(.ant-select-item-option-disabled)"]),
    optionContentSelectors: Object.freeze([".ant-select-item-option-content"]),
    selectedItemSelectors: Object.freeze([".ant-select-selection-item"]),
    selectedItemContentSelectors: Object.freeze([".ant-select-selection-item-content"]),
    selectedItemRemoveSelectors: Object.freeze([".ant-select-selection-item-remove"]),
    placeholderSelectors: Object.freeze([".ant-select-selection-placeholder"]),
    searchInputSelectors: Object.freeze(["input.ant-select-selection-search-input"]),

    resolveTrigger(el) {
      if (!el || el.nodeType !== 1) return null;
      return (
        el.querySelector?.(".ant-select-selector") ||
        el.closest?.(".ant-select-selector, .ant-cascader-picker, .ant-picker") ||
        el.closest?.(".ant-select, .ant-cascader") ||
        null
      );
    },

    isOpen(root) {
      if (!root || root.nodeType !== 1) return false;
      return Boolean(
        root.classList?.contains("ant-select-open") ||
          root.querySelector?.("input")?.getAttribute?.("aria-expanded") === "true",
      );
    },

    findOwnedPopup(root, doc = root?.ownerDocument || document) {
      if (!root || !doc) return null;
      const inp = root.querySelector?.("input[aria-controls], input[aria-owns]") || root;
      const rawId = clean(inp?.getAttribute?.("aria-controls") || inp?.getAttribute?.("aria-owns") || "");
      const id = rawId ? rawId.split(/\s+/)[0] : "";
      if (id) {
        const listEl = doc.getElementById(id);
        const dd = listEl?.closest?.(".ant-select-dropdown") || listEl;
        if (dd && !dd.classList?.contains("ant-select-dropdown-hidden")) return dd;
      }
      const all = [...doc.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")];
      return all.length ? all[all.length - 1] : null;
    },

    readSelectedLabels(root) {
      if (!root || root.nodeType !== 1) return [];
      const items = [...(root.querySelectorAll?.(".ant-select-selection-item") || [])];
      const out = [];
      for (const item of items) {
        const tAttr = clean(item.getAttribute?.("title"));
        if (tAttr) {
          out.push(tAttr);
          continue;
        }
        const content = item.querySelector?.(".ant-select-selection-item-content");
        if (content) {
          const ct = clean(content.textContent);
          if (ct) out.push(ct);
          continue;
        }
        const clone = item.cloneNode(true);
        clone.querySelectorAll?.('.ant-select-selection-item-remove, [aria-hidden="true"]').forEach((n) => n.remove());
        const txt = clean(clone.textContent);
        if (txt) out.push(txt);
      }
      return out;
    },

    findSearchInput(root) {
      if (!root?.classList?.contains("ant-select-show-search")) return null;
      const inp = root.querySelector?.("input.ant-select-selection-search-input");
      return inp && !inp.disabled ? inp : null;
    },
  }),

  cascader: Object.freeze({
    rootSelectors: Object.freeze([".ant-cascader", ".ant-select.ant-cascader"]),
    columnSelectors: Object.freeze(["ul.ant-cascader-menu"]),
    itemSelectors: Object.freeze(["li.ant-cascader-menu-item:not(.ant-cascader-menu-item-disabled)"]),
    expandedItemSelectors: Object.freeze([".ant-cascader-menu-item-active", ".ant-cascader-menu-item-expand"]),

    findColumns(popup) {
      if (!popup || popup.nodeType !== 1) return [];
      return [...popup.querySelectorAll("ul.ant-cascader-menu")];
    },

    isExpandedItem(item) {
      return Boolean(
        item?.classList?.contains("ant-cascader-menu-item-active") ||
          item?.getAttribute?.("aria-expanded") === "true",
      );
    },
  }),

  table: Object.freeze({
    rowSelectors: Object.freeze(["tbody tr.ant-table-row", "tbody tr"]),
    cellSelectors: Object.freeze(["td.ant-table-cell", "td", "th"]),
    emptyRowClasses: Object.freeze(["ant-table-measure-row", "ant-table-placeholder"]),
    isEmptyPlaceholder(row) {
      if (!row || row.nodeType !== 1) return true;
      return Boolean(
        row.classList?.contains("ant-table-measure-row") || row.classList?.contains("ant-table-placeholder"),
      );
    },
  }),

  upload: Object.freeze({
    uploadedListSelectors: Object.freeze([".ant-upload-list"]),
    triggerSelectors: Object.freeze([
      ".ant-upload-btn",
      ".ant-upload:not(.ant-upload-wrapper):not(.ant-upload-picture-card-wrapper)",
    ]),
  }),

  formAndFeedback: Object.freeze({
    fieldContainerSelectors: Object.freeze([".ant-form-item"]),
    labelSelectors: Object.freeze([".ant-form-item-label"]),
    radioGroupSelectors: Object.freeze([".ant-radio-group"]),
    requiredIndicators: Object.freeze([".ant-form-item-required"]),
    loadingSelectors: Object.freeze([".ant-spin-spinning", ".ant-skeleton", ".ant-btn-loading"]),
    errorAlertSelectors: Object.freeze([
      ".ant-message-notice-content",
      ".ant-notification-notice",
      ".ant-form-item-explain-error",
    ]),
  }),
});

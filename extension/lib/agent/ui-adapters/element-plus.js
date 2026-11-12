/**
 * Element Plus 组件库适配器插件。
 * 仅修补 Element Plus 偏离 WAI-ARIA 标准的实现细节，不含任何业务语义。
 */

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const EL_LEAVE_RE = /\bel-[a-z0-9-]*-leave(?:-active|-to)?\b/;

export const ELEMENT_PLUS_ADAPTER = Object.freeze({
  id: "element-plus",
  priority: 40,

  modal: Object.freeze({
    dialogSelectors: Object.freeze([".el-dialog", ".el-drawer"]),
    wrapSelectors: Object.freeze([".el-overlay-dialog", ".el-overlay"]),
    titleSelectors: Object.freeze([
      ".el-dialog__title",
      ".el-dialog__header",
      ".el-drawer__title",
      ".el-drawer__header",
    ]),
    bodySelectors: Object.freeze([".el-dialog__body", ".el-drawer__body"]),
    closeButtonSelectors: Object.freeze([".el-dialog__headerbtn", ".el-drawer__close-btn"]),
    leaveClassPatterns: Object.freeze(["\\bel-[a-z0-9-]*-leave(?:-active|-to)?\\b"]),
    hiddenPortalClasses: Object.freeze([]),
    appRootSelectors: Object.freeze([".el-main"]),
    isLeavingOrHidden(el) {
      if (!el || el.nodeType !== 1) return true;
      const clsName = typeof el.className === "string" ? el.className : "";
      return Boolean(clsName && EL_LEAVE_RE.test(clsName));
    },
  }),

  combobox: Object.freeze({
    rootSelectors: Object.freeze([".el-select"]),
    rootClasses: Object.freeze(["el-select"]),
    excludeCascaderSelectors: Object.freeze([".el-cascader"]),
    triggerSubSelectors: Object.freeze([".el-select__wrapper", ".el-input__wrapper"]),
    proxyTriggerSelectors: Object.freeze([
      ".el-select__wrapper",
      ".el-input__wrapper",
      ".el-checkbox",
      ".el-radio",
      ".el-switch",
    ]),
    proxySecondarySelectors: Object.freeze([".el-select", ".el-cascader"]),
    openRootSelectors: Object.freeze([".el-select--open"]),
    openDescendantSelectors: Object.freeze([".el-select__caret.is-reverse", ".el-select__wrapper.is-focused"]),
    searchableRootClasses: Object.freeze([]),
    popupSelectors: Object.freeze([".el-select-dropdown"]),
    popupLayerSelectors: Object.freeze([".el-select-dropdown", ".el-cascader__dropdown", ".el-dropdown-menu"]),
    optionSelectors: Object.freeze([".el-select-dropdown__item:not(.is-disabled)"]),
    optionContentSelectors: Object.freeze([]),
    selectedItemSelectors: Object.freeze([
      ".el-select__tags-text",
      ".el-select__selected-item:not(.el-select__input-wrapper):not(.el-select__placeholder)",
    ]),
    selectedItemContentSelectors: Object.freeze([]),
    selectedItemRemoveSelectors: Object.freeze([".el-tag__close"]),
    placeholderSelectors: Object.freeze([".el-select__placeholder"]),
    searchInputSelectors: Object.freeze(["input.el-select__input"]),

    resolveTrigger(el) {
      if (!el || el.nodeType !== 1) return null;
      return (
        el.querySelector?.(".el-select__wrapper, .el-input__wrapper") ||
        el.closest?.(".el-select__wrapper, .el-input__wrapper") ||
        el.closest?.(".el-select, .el-cascader") ||
        null
      );
    },

    isOpen(root) {
      if (!root || root.nodeType !== 1) return false;
      return Boolean(
        root.classList?.contains("el-select--open") ||
          root.querySelector?.(".el-select__caret.is-reverse, .el-select__wrapper.is-focused") ||
          root.getAttribute?.("aria-expanded") === "true",
      );
    },

    findOwnedPopup(root, doc = root?.ownerDocument || document) {
      if (!root || !doc) return null;
      const inp = root.querySelector?.("input[aria-controls], input[aria-owns], [aria-controls]") || root;
      const rawId = clean(inp?.getAttribute?.("aria-controls") || inp?.getAttribute?.("aria-owns") || "");
      const id = rawId ? rawId.split(/\s+/)[0] : "";
      if (id) {
        const listEl = doc.getElementById(id);
        const dd = listEl?.closest?.(".el-select-dropdown") || listEl;
        if (dd) return dd;
      }
      const all = [...doc.querySelectorAll(".el-select-dropdown")].filter((el) => {
        const win = doc.defaultView || globalThis;
        const st = typeof win.getComputedStyle === "function" ? win.getComputedStyle(el) : null;
        return !st || (st.display !== "none" && st.visibility !== "hidden");
      });
      return all.length ? all[all.length - 1] : null;
    },

    readSelectedLabels(root) {
      if (!root || root.nodeType !== 1) return [];
      const items = [
        ...(root.querySelectorAll?.(
          ".el-select__tags-text, .el-select__selected-item:not(.el-select__input-wrapper):not(.el-select__placeholder)",
        ) || []),
      ];
      const out = [];
      for (const item of items) {
        const clone = item.cloneNode(true);
        clone.querySelectorAll?.('.el-tag__close, [aria-hidden="true"]').forEach((n) => n.remove());
        const txt = clean(clone.textContent);
        if (txt) out.push(txt);
      }
      if (!out.length) {
        const innerInp = root.querySelector?.("input.el-input__inner");
        const val = clean(innerInp?.value || "");
        const ph = clean(innerInp?.getAttribute?.("placeholder") || "");
        if (val && val !== ph) out.push(val);
      }
      return out;
    },

    findSearchInput(root) {
      const inp = root?.querySelector?.("input.el-select__input");
      return inp && !inp.disabled && !inp.readOnly ? inp : null;
    },
  }),

  cascader: Object.freeze({
    rootSelectors: Object.freeze([".el-cascader"]),
    columnSelectors: Object.freeze([".el-cascader-menu"]),
    itemSelectors: Object.freeze([".el-cascader-node:not(.is-disabled)"]),
    expandedItemSelectors: Object.freeze([".in-active-path", ".is-active"]),

    findColumns(popup) {
      if (!popup || popup.nodeType !== 1) return [];
      return [...popup.querySelectorAll(".el-cascader-menu")];
    },

    isExpandedItem(item) {
      return Boolean(
        item?.classList?.contains("in-active-path") ||
          item?.classList?.contains("is-active") ||
          item?.getAttribute?.("aria-expanded") === "true",
      );
    },
  }),

  table: Object.freeze({
    rowSelectors: Object.freeze(["tbody tr.el-table__row", "tbody tr"]),
    cellSelectors: Object.freeze(["td.el-table__cell", "td", "th"]),
    emptyRowClasses: Object.freeze(["el-table__empty-block"]),
    isEmptyPlaceholder(row) {
      if (!row || row.nodeType !== 1) return true;
      return Boolean(
        row.classList?.contains("el-table__empty-block") || row.querySelector?.(".el-table__empty-block"),
      );
    },
  }),

  upload: Object.freeze({
    uploadedListSelectors: Object.freeze([".el-upload-list"]),
    triggerSelectors: Object.freeze([".el-upload"]),
  }),

  formAndFeedback: Object.freeze({
    fieldContainerSelectors: Object.freeze([".el-form-item"]),
    labelSelectors: Object.freeze([".el-form-item__label"]),
    radioGroupSelectors: Object.freeze([".el-radio-group"]),
    requiredIndicators: Object.freeze([".is-required"]),
    loadingSelectors: Object.freeze([".el-loading-mask"]),
    errorAlertSelectors: Object.freeze([".el-message", ".el-notification", ".el-form-item__error"]),
  }),
});

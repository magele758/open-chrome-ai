/**
 * 标准 HTML + WAI-ARIA 一等公民组件适配器（默认底座，零第三方组件库私有类名）。
 */

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

const hasRunningAnimation = (el) => {
  try {
    return typeof el?.getAnimations === "function" && el.getAnimations({ subtree: false }).some((a) => a.playState === "running");
  } catch {
    return false;
  }
};

export const ARIA_NATIVE_ADAPTER = Object.freeze({
  id: "aria-native",
  priority: 100,

  modal: Object.freeze({
    dialogSelectors: Object.freeze([
      "dialog[open]",
      '[role="dialog"]',
      '[role="alertdialog"]',
      '[aria-modal="true"]',
    ]),
    wrapSelectors: Object.freeze([]),
    titleSelectors: Object.freeze(['[role="heading"]', "h1", "h2", "h3", "header"]),
    bodySelectors: Object.freeze(["article", "section"]),
    closeButtonSelectors: Object.freeze([
      'button[aria-label*="关闭" i]',
      'button[aria-label*="close" i]',
      '[role="button"][aria-label*="关闭" i]',
      '[role="button"][aria-label*="close" i]',
    ]),
    leaveClassPatterns: Object.freeze([]),
    hiddenPortalClasses: Object.freeze([]),
    appRootSelectors: Object.freeze(["main", '[role="main"]', "#app", "#root"]),
    isLeavingOrHidden(el) {
      if (!el || el.nodeType !== 1) return true;
      if (el.hidden || el.getAttribute("aria-hidden") === "true" || el.hasAttribute("inert")) return true;
      const win = el.ownerDocument?.defaultView || globalThis;
      const st = typeof win.getComputedStyle === "function" ? win.getComputedStyle(el) : null;
      if (st && (st.display === "none" || st.visibility === "hidden")) return true;
      if (st && Number(st.opacity) === 0 && !hasRunningAnimation(el)) return true;
      return false;
    },
  }),

  combobox: Object.freeze({
    rootSelectors: Object.freeze(["select", '[role="combobox"]', "[data-radix-select-trigger]"]),
    rootClasses: Object.freeze([]),
    excludeCascaderSelectors: Object.freeze(['[role="combobox"][aria-haspopup="tree"]', '[role="menubar"]']),
    triggerSubSelectors: Object.freeze([]),
    proxyTriggerSelectors: Object.freeze([
      '[role="combobox"]',
      '[role="listbox"]',
      '[role="switch"]',
      '[role="checkbox"]',
      '[role="radio"]',
    ]),
    proxySecondarySelectors: Object.freeze(["label"]),
    openRootSelectors: Object.freeze(['[role="combobox"][aria-expanded="true"]', '[data-state="open"]']),
    openDescendantSelectors: Object.freeze(['[aria-expanded="true"]']),
    searchableRootClasses: Object.freeze([]),
    popupSelectors: Object.freeze(['[role="listbox"]', "[data-radix-popper-content-wrapper]"]),
    popupLayerSelectors: Object.freeze(['[role="listbox"]', '[role="menu"]', '[role="tree"]']),
    optionSelectors: Object.freeze(["option:not([disabled])", '[role="option"]:not([aria-disabled="true"])']),
    optionContentSelectors: Object.freeze([]),
    selectedItemSelectors: Object.freeze(['[role="option"][aria-selected="true"]']),
    selectedItemContentSelectors: Object.freeze([]),
    selectedItemRemoveSelectors: Object.freeze(['[aria-hidden="true"]']),
    placeholderSelectors: Object.freeze([]),
    searchInputSelectors: Object.freeze(['input[type="search"]', 'input[role="combobox"]']),

    resolveTrigger(el) {
      if (!el || el.nodeType !== 1) return null;
      if (el.tagName === "SELECT") return el;
      const anc = el.closest?.('[role="combobox"], [data-radix-select-trigger], label');
      return anc || el;
    },

    isOpen(root) {
      if (!root || root.nodeType !== 1) return false;
      return Boolean(
        root.getAttribute("aria-expanded") === "true" ||
          root.getAttribute("data-state") === "open" ||
          root.querySelector?.('[aria-expanded="true"]'),
      );
    },

    findOwnedPopup(root, doc = root?.ownerDocument || document) {
      if (!root || !doc) return null;
      const owner = root.querySelector?.("input[aria-controls], input[aria-owns], [aria-controls], [aria-owns]") || root;
      const rawId = clean(owner?.getAttribute?.("aria-controls") || owner?.getAttribute?.("aria-owns") || "");
      const id = rawId ? rawId.split(/\s+/)[0] : "";
      if (id) {
        const linked = doc.getElementById(id);
        if (linked) return linked.closest?.("[data-radix-popper-content-wrapper]") || linked;
      }
      const inline = root.querySelector?.('[role="listbox"]');
      if (inline) return inline;
      const all = [...doc.querySelectorAll('[role="listbox"]')];
      return all.length ? all[all.length - 1] : null;
    },

    readSelectedLabels(root) {
      if (!root || root.nodeType !== 1) return [];
      if (root.tagName === "SELECT") {
        const opts = root.selectedOptions ? [...root.selectedOptions] : [...(root.options || [])].filter((o) => o.selected);
        return opts.map((o) => clean(o.label || o.textContent || o.value)).filter(Boolean);
      }
      const doc = root.ownerDocument || document;
      const out = [];
      for (const opt of root.querySelectorAll?.('[role="option"][aria-selected="true"]') || []) {
        const t = clean(opt.getAttribute("aria-label") || opt.textContent);
        if (t) out.push(t);
      }
      if (!out.length) {
        const popup = this.findOwnedPopup(root, doc);
        if (popup && popup !== root) {
          for (const opt of popup.querySelectorAll?.('[role="option"][aria-selected="true"]') || []) {
            const t = clean(opt.getAttribute("aria-label") || opt.textContent);
            if (t) out.push(t);
          }
        }
      }
      if (!out.length) {
        const inp = root.tagName === "INPUT" ? root : root.querySelector?.('input[role="combobox"], input[type="search"]');
        const ph = clean(root.getAttribute("placeholder") || root.getAttribute("data-placeholder") || inp?.getAttribute("placeholder") || "");
        if (inp && clean(inp.value) && clean(inp.value) !== ph) {
          out.push(clean(inp.value));
        } else if (!root.querySelector?.('[role="listbox"], [role="option"]') && root.getAttribute("data-placeholder") == null) {
          const clone = root.cloneNode(true);
          clone.querySelectorAll?.('[aria-hidden="true"]').forEach((n) => n.remove());
          const txt = clean(root.value ?? clone.textContent);
          if (txt && txt !== ph) out.push(txt);
        }
      }
      return out;
    },

    findSearchInput(root, popup = null) {
      const cand =
        root?.querySelector?.('input[type="search"], input[role="combobox"]') ||
        (root?.tagName === "INPUT" ? root : null) ||
        popup?.querySelector?.('input[type="search"], input[role="searchbox"]') ||
        null;
      return cand && !cand.disabled && !cand.readOnly ? cand : null;
    },
  }),

  cascader: Object.freeze({
    rootSelectors: Object.freeze(['[role="combobox"][aria-haspopup="tree"]', '[role="menubar"]']),
    columnSelectors: Object.freeze(['[role="menu"]', '[role="tree"]', '[role="listbox"]', "ul"]),
    itemSelectors: Object.freeze(['[role="menuitemcheckbox"]', '[role="treeitem"]', '[role="menuitem"]']),
    expandedItemSelectors: Object.freeze(['[aria-expanded="true"]', '[aria-checked="true"]']),

    findColumns(popup) {
      if (!popup || popup.nodeType !== 1) return [];
      const cols = [...popup.querySelectorAll('[role="menu"], [role="tree"], [role="listbox"], ul')].filter(
        (c) => c.querySelector('[role="menuitemcheckbox"], [role="treeitem"], [role="menuitem"], [role="option"]'),
      );
      return cols.filter((c) => !cols.some((other) => other !== c && c.contains(other)));
    },

    isExpandedItem(item) {
      if (!item || item.nodeType !== 1) return false;
      return item.getAttribute("aria-expanded") === "true" || item.getAttribute("aria-checked") === "true";
    },
  }),

  table: Object.freeze({
    rowSelectors: Object.freeze(["tbody tr", '[role="row"]']),
    cellSelectors: Object.freeze(["td", "th", '[role="cell"]', '[role="gridcell"]', '[role="columnheader"]']),
    emptyRowClasses: Object.freeze([]),
    isEmptyPlaceholder(row) {
      if (!row || row.nodeType !== 1) return true;
      const tbl = row.closest?.('table, [role="table"], [role="grid"]');
      if (tbl?.getAttribute?.("aria-rowcount") === "0") return true;
      return row.getAttribute("data-empty") === "true";
    },
  }),

  upload: Object.freeze({
    uploadedListSelectors: Object.freeze(['[role="list"][data-upload-list]', '[class*="upload-list"]']),
    triggerSelectors: Object.freeze(["button", '[role="button"]']),
  }),

  formAndFeedback: Object.freeze({
    fieldContainerSelectors: Object.freeze([
      "fieldset",
      '[role="group"]',
      '[class*="__field"]',
      '[class*="-field"]',
      '[class*="__item"]',
    ]),
    labelSelectors: Object.freeze(["label", "legend", '[class*="__label"]', '[class*="-label"]']),
    radioGroupSelectors: Object.freeze(['[role="radiogroup"]', "fieldset"]),
    requiredIndicators: Object.freeze(["[required]", '[aria-required="true"]']),
    loadingSelectors: Object.freeze(['[aria-busy="true"]', '[role="progressbar"]']),
    errorAlertSelectors: Object.freeze(['[role="alert"]']),
  }),
});

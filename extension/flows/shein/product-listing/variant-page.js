/** Configures live SHEIN specs and listing sites in the new-product form. */
export async function sheinVariantPage({ href, categoryPath, kind = "inspect", input = {} } = {}) {
  const clean = value => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const key = value => clean(value).replace(/\s+/gu, "").toLowerCase();
  const text = node => clean(node?.innerText ?? node?.textContent);
  const fail = (code, message) => ({ ok: false, code, message });
  const one = entries => entries.length === 1 ? entries[0] : null;
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length &&
    !node.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(node).visibility !== "hidden");
  const enabled = node => visible(node) && !node.closest(':disabled,[aria-disabled="true"],.so-select-disabled,.soui-select-wrapper-disabled');
  const scan = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);
  const active = selector => scan(document, selector);
  const yieldControl = ms => new Promise(resolve => setTimeout(resolve, ms));
  const categorySelector = '[class*="commodityCategoryItem--"] [class*="categoryInfo--"]';
  const category = () => text(one(active(categorySelector))).split(/\s*>\s*/u).filter(Boolean);
  const desiredCategory = Array.isArray(categoryPath) ? categoryPath.map(clean) : [];
  const modalSelector = 'dialog[open],[role="alertdialog"],[aria-modal="true"],.soui-modal-wrapper,.so-dialog,.so-modal.so-modal-show .so-modal-panel';
  const blocked = () => active(modalSelector).length > 0;
  const isRoute = () => {
    const [path, search = ""] = location.hash.slice(1).split("?");
    return window === window.top && location.href === href && location.origin === "https://sellerhub.shein.com" &&
      location.pathname === "/" && path === "/spmp/commoditiesInfo" &&
      new URLSearchParams(search).getAll("mode").join("|") === "add";
  };
  const onPage = () => isRoute() && !blocked() && (kind === "inspect" || desiredCategory.length > 0 &&
    desiredCategory.join("\n") === category().join("\n"));
  const specRowSelector = '[class*="specContentRow--"]';
  const specLabelSelector = '[class*="specContentLabel--"]';
  const typeSelector = '[class*="specAttrSelect--"]';
  const selectSelector = '.so-select,.soui-select';
  const menuSelector = '.so-select-box-list,.so-select-options,.soui-select-picker-wrapper.merchant-ui-select-options,.soui-select-dropdown,[role="listbox"]';
  const closedMenu = '.so-hidable-hidden,[aria-hidden="true"],[hidden]';
  const optionSelector = '[role="option"],.so-select-dropdown-item,.so-select-option,.soui-select-dropdown-item,.soui-select-option';
  const resultSelector = '.so-select-result,.soui-select-result-wrapper';
  const trigger = select => select.querySelector(resultSelector + ',.so-select-selection,.so-select-result-wrapper') || select;

  if (!isRoute()) return fail("PAGE_CHANGED", "SHEIN 新建商品页面已切换。");
  if (!["inspect", "fill", "refreshSite"].includes(kind)) return fail("ACTION_UNSUPPORTED", "不支持此 SHEIN 规格操作。");
  if (blocked()) return fail("MODAL_BLOCKED", "请关闭当前 SHEIN 弹窗后再继续。");
  if (!onPage()) return fail("CATEGORY_CHANGED", "当前 SHEIN 商品分类与待填资料不一致，请核对。");

  const specLabel = node => text(node).replace(/^[*＊]\s*|\s*[:：]$/gu, "");
  const withoutBadge = value => clean(value).replace(/\s*(?:重要|Important)$/iu, "");
  const typeKeys = new Map([["color", "颜色"], ["colour", "颜色"], ["size", "尺码"]]);
  const sameType = (left, right) => same(left, right) || (typeKeys.get(key(left)) || key(left)) === (typeKeys.get(key(right)) || key(right));
  const results = select => one(scan(select, resultSelector).filter(node => node.closest(selectSelector) === select));
  const placeholder = node => clean(node.getAttribute('placeholder') || node.getAttribute('data-placeholder') || text(node));
  const valuePlaceholder = value => /^(?:请选择或自定义|Please select or customize)$/iu.test(value);
  const emptyResult = (select, result) => select.matches('.soui-select-wrapper-empty') || result?.matches('.so-select-empty');
  const selectedValues = select => {
    const result = results(select);
    if (!result || emptyResult(select, result)) return [];
    const valueNodes = scan(result, '.so-select-input[title],.so-select-ellipsis[title],.soui-select-ellipsis,.soui-select-result-label,.soui-select-result-text,.soui-select-multiple-result-item');
    return [...new Set(valueNodes.filter(node => !valueNodes.some(other => other !== node && node.contains(other)))
      .map(node => clean(node.getAttribute('title')) || text(node)).filter(value => value && !valuePlaceholder(value)))];
  };
  const groupLabel = row => specLabel(one(scan(row, specLabelSelector).filter(node => node.closest(specRowSelector) === row)));
  const groupRows = () => active(specRowSelector).flatMap(row => {
    const label = groupLabel(row);
    if (!/^(?:主规格|(?:规格类型|次规格|副规格|子规格)\s*[\d一二]*)$/u.test(label)) return [];
    const controls = scan(row, selectSelector).filter(node => node.closest(specRowSelector) === row && !node.parentElement.closest(selectSelector));
    const type = one(controls.filter(node => node.matches(typeSelector)));
    if (!type) return [];
    const valueControls = controls.filter(node => node !== type);
    const values = one(valueControls.filter(select => {
      const result = results(select);
      return result && (scan(result, 'input[placeholder],[data-placeholder],.so-input-placeholder,.soui-select-placeholder')
        .some(node => valuePlaceholder(placeholder(node))) ||
        emptyResult(select, result) && Boolean(select.closest('[class*="specValueItem--"]')));
    }));
    const selected = valueControls.filter(select => select !== values).flatMap(selectedValues);
    const typeResult = results(type);
    const name = emptyResult(type, typeResult) ? "" : selectedValues(type)[0] || withoutBadge(text(typeResult));
    return [{ row, label, type, values, name, selected }];
  });

  function siteRows() {
    const area = one(active('.so-form-item.publish_site'));
    if (!area) return [];
    return [...area.querySelectorAll('input[type="checkbox"],[role="checkbox"]')].flatMap(control => {
      if (control.matches('[role="checkbox"]') && control.querySelector('input[type="checkbox"]')) return [];
      const hit = (control.labels?.length === 1 && control.labels[0]) || control.closest('label,.so-checkbox') || control;
      const name = clean(control.getAttribute("aria-label")) || text(hit.querySelector('.so-checkbox-label')) || text(hit);
      if (!visible(hit) || !name || /^(?:全选|全不选|select all)$/iu.test(name)) return [];
      return [{ name, hit, control, disabled: control.matches(':disabled,[aria-disabled="true"]'),
        checked: control.matches('input') ? control.checked : control.getAttribute("aria-checked") === "true" }];
    });
  }

  const items = [];
  const issues = [];
  const mappings = new Map();
  const report = (label, code, message) => issues.push({ label, code, message });
  const record = (label, status = "verified") => items.push({ label, status });
  const defaultOnly = () => /无主规格发品.{0,24}默认生成\s*1\s*个\s*SKC.{0,24}不支持复色/iu.test(text(one(active('.spec_info_body'))));
  const receipt = () => ({ ok: true, categoryPath: category(), items, issues,
    defaultOnly: defaultOnly(),
    groups: groupRows().map(({ label, name, selected }) => ({ label, name, values: selected,
      ...(mappings.has(label) && { matches: mappings.get(label).filter(({ value }) => selected.includes(value)) }) })),
    sites: siteRows().map(({ name, checked }) => ({ name, checked })) });
  if (kind === "inspect") return receipt();

  const requested = input.variantGroups ?? [];
  const requestedSites = input.sites ?? [];
  const ifValidName = value => typeof value === "string" && clean(value).length > 0 && clean(value).length <= 100;
  const unique = list => new Set(list.map(key)).size === list.length;
  if (!Array.isArray(requested) || requested.length > 2 || requested.some(group =>
    !ifValidName(group?.name) || !Array.isArray(group.options) || !group.options.length || group.options.length > 30 ||
    group.options.some(option => !ifValidName(option?.value)) || !unique(group.options.map(option => option.value))) ||
    !unique(requested.map(group => group.name)) || !Array.isArray(requestedSites) || requestedSites.length > 30 ||
    requestedSites.some(site => !ifValidName(site)) || !unique(requestedSites)) {
    return fail("VARIANT_INPUT_INVALID", "商品规格和站点需提供页面上的准确名称，且不能有重名项。");
  }

  if (kind === "refreshSite") {
    const name = requestedSites.length === 1 ? clean(requestedSites[0]) : "";
    const readSite = () => one(siteRows().filter(site => site.name === name && !site.disabled &&
      site.control.matches('input[type="checkbox"]') && site.hit.matches('label') && enabled(site.hit)));
    const media = one(active('.detail_img_container'));
    const initial = name && readSite();
    if (!defaultOnly() || !initial?.checked || siteRows().filter(site => site.checked).length !== 1 || !media ||
        media.childElementCount || text(media) || active('[class*="supplyInfoTable--"]').length || menus().length) {
      return fail("SITE_REFRESH_NOT_NEEDED", "当前上架站点和空白表格不符合重新加载条件。");
    }
    initial.hit.click();
    const wasUnchecked = await stable(() => readSite()?.checked === false ? "unchecked" : "", 1000, 60);
    const after = readSite();
    if (!after || !onPage()) return fail("SITE_REFRESH_UNVERIFIED", "上架站点未能恢复，请检查当前页面。");
    if (!after.checked) after.hit.click();
    if (!await stable(() => readSite()?.checked === true ? name : "", 1200)) {
      return fail("SITE_REFRESH_UNVERIFIED", "上架站点未能恢复，请检查当前页面。");
    }
    if (!wasUnchecked) return fail("SITE_REFRESH_UNVERIFIED", "已核对上架站点仍然选中，但未观察到站点切换。");
    record(name + " · 重新加载表格");
    return receipt();
  }

  const currentGroup = index => {
    const rows = groupRows();
    const primary = rows.filter(row => row.label === "主规格");
    return index === 0 ? one(primary) : one(rows.filter(row => row.label !== "主规格"));
  };

  async function addSecondaryGroup(index) {
    const section = currentGroup(0)?.row.closest('.spec_info_body');
    const button = section && one(scan(section, 'button').filter(node => enabled(node) && /^\+?\s*添加规格类型$/u.test(text(node))));
    if (!button || !onPage() || menus().length) return null;
    button.click();
    return await stable(() => currentGroup(index) ? "mounted" : "", 1800) ? currentGroup(index) : null;
  }

  for (const [index, group] of requested.entries()) {
    if (!onPage()) return fail("PAGE_CHANGED", "SHEIN 商品表单已变化。");
    let row = currentGroup(index);
    if (index && !row) row = await addSecondaryGroup(index);
    if (!row) {
      report(group.name, "SPEC_CONTROL_MISSING", index ? "请先在 SHEIN 添加另一种规格类型。" : "当前分类没有可识别的主规格控件。");
      continue;
    }
    if (row.name) {
      if (!sameType(row.name, group.name)) {
        report(group.name, "SPEC_ALREADY_SET", `此规格已设为「${row.name}」，请在页面核对。`);
        continue;
      }
      record(row.label + " · " + row.name, "unchanged");
    } else {
      const result = await choose(row.type, group.name, () => [currentGroup(index)?.name].filter(Boolean));
      if (!result.ok) {
        report(group.name, result.code, result.message);
        if (result.code === "MENU_STILL_OPEN") return receipt();
        continue;
      }
      record(row.label + " · " + group.name);
    }
    const matched = [];
    mappings.set(row.label, matched);
    for (const option of group.options) {
      row = currentGroup(index);
      if (!row || !row.name || !sameType(row.name, group.name)) return fail("PAGE_CHANGED", "SHEIN 规格行已变化。");
      const label = group.name + " · " + option.value;
      const existing = one(row.selected.filter(value => same(value, option.value)));
      if (existing) {
        matched.push({ requested: option.value, value: existing });
        record(label, "unchanged");
        continue;
      }
      if (!row.values) {
        report(label, "SPEC_VALUE_CONTROL_MISSING", "未读取到可新增规格值的 SHEIN 下拉。");
        continue;
      }
      const result = await choose(row.values, option.value, () => currentGroup(index)?.selected || []);
      if (result.ok) {
        matched.push({ requested: option.value, value: result.value });
        record(label, result.status);
      }
      else report(label, result.code, result.message);
      if (result.code === "MENU_STILL_OPEN") return receipt();
    }
  }

  for (const value of requestedSites) {
    if (!onPage()) return fail("PAGE_CHANGED", "SHEIN 商品表单已变化。");
    const name = clean(value);
    const findSite = () => one(siteRows().filter(site => site.name === name));
    const site = findSite();
    if (!site) {
      report(name, "SITE_MISSING", "SHEIN 页面没有唯一匹配的可上架站点。");
      continue;
    }
    if (site.checked) {
      record(name, "unchanged");
      continue;
    }
    if (site.disabled || !enabled(site.hit)) {
      report(name, "SITE_DISABLED", "此站点当前不可操作。");
      continue;
    }
    site.hit.click();
    if (await stable(() => findSite()?.checked ? name : "")) record(name);
    else report(name, "SITE_NOT_VERIFIED", "SHEIN 尚未回显上架站点。");
  }
  return receipt();

  function namesFor(value) {
    const label = withoutBadge(value);
    const bilingual = /^([\p{Script=Han}\d\s]+?)\s*([a-z][\w\s/&-]*)$/iu.exec(label);
    return new Set([label, ...(bilingual?.slice(1) ?? [])].map(key));
  }

  function same(observed, wanted) {
    return namesFor(observed).has(key(wanted)) || namesFor(wanted).has(key(observed));
  }

  async function stable(read, timeout = 1350, minimumStableMs = 120) {
    let last;
    let since = 0;
    const deadline = Date.now() + timeout;
    do {
      if (!onPage()) return null;
      const current = read();
      if (!current || current !== last) {
        last = current;
        since = Date.now();
      } else if (Date.now() - since >= minimumStableMs) return current;
      await yieldControl(50);
    } while (Date.now() < deadline);
    return null;
  }

  function menus() {
    const present = active(menuSelector).filter(menu => {
      const style = getComputedStyle(menu);
      return !menu.closest(closedMenu) && style.opacity !== "0" && style.pointerEvents !== "none";
    });
    const showing = present.filter(menu => menu.classList.contains('so-hidable-show'));
    const visibleMenus = showing.length ? showing : present;
    return visibleMenus.filter(menu => !visibleMenus.some(parent => parent !== menu && parent.contains(menu)));
  }

  function optionLabel(node) {
    const titled = clean(node?.querySelector('[class*="renderItemEllipsis--"][title]')?.getAttribute("title"));
    if (titled) return titled;
    const english = node?.querySelector('[class*="attrValRenderItemEnText--"]');
    if (english) {
      const englishName = text(english);
      const display = text(node);
      return englishName && display.endsWith(englishName) ? clean(display.slice(0, -englishName.length)) + " " + englishName : display;
    }
    return text(node?.querySelector('.so-select-option-label,.so-select-dropdown-item-label,.soui-select-option-label,.soui-select-dropdown-item-label')) || text(node);
  }

  function optionRows(menu) {
    return scan(menu, optionSelector).filter(node => enabled(node) && !node.parentElement.closest(optionSelector));
  }

  async function closeMenu(select, menu) {
    if (!menu || !menus().includes(menu)) return true;
    const focused = document.activeElement;
    if (focused?.matches('input,textarea,[contenteditable]') && (select.contains(focused) || menu.contains(focused))) {
      focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      focused.blur();
    }
    if (await stable(() => !menus().includes(menu) ? "closed" : "", 420, 60)) return true;
    if (!onPage() || one(menus()) !== menu || !enabled(trigger(select))) return false;
    trigger(select).click();
    return Boolean(await stable(() => !menus().includes(menu) ? "closed" : "", 650));
  }

  async function choose(select, wanted, readValues) {
    const control = trigger(select);
    if (!onPage() || !enabled(control) || menus().length) return fail("MENU_STILL_OPEN", "请关闭其他下拉菜单再继续。");
    control.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    control.click();
    let menu;
    const menuState = () => {
      menu = one(menus());
      if (!menu || menu.getAttribute('aria-busy') === 'true') return "";
      const options = optionRows(menu).map(optionLabel).filter(Boolean);
      if (!options.length && !searchControl(select, menu)) return "";
      const { top, left } = menu.getBoundingClientRect();
      return JSON.stringify([options, Math.round(top), Math.round(left)]);
    };
    const stableOptions = await stable(menuState, 1600, 240);
    let result = fail("OPTIONS_NOT_READY", "SHEIN 下拉没有稳定的选项列表。");
    if (stableOptions && menu && one(menus()) === menu) {
      const matching = await findOptions(select, menu, wanted);
      const target = one(matching);
      const picked = optionLabel(target);
      const existing = one(readValues().filter(value => same(picked, value)));
      if (!target) {
        result = fail(matching.length ? "OPTION_AMBIGUOUS" : "OPTION_MISSING", `SHEIN 无法唯一匹配「${wanted}」。`);
      } else if (existing) {
        result = { ok: true, status: "unchanged", value: existing };
      } else if (target.matches('[aria-selected="true"],[data-selected="true"],.so-select-option-selected,.soui-select-dropdown-item-selected')) {
        result = fail("OPTION_ALREADY_SELECTED", "选项可能已选中，未重复点击。");
      } else if (onPage() && enabled(target) && one(menus()) === menu) {
        target.scrollIntoView?.({ block: "nearest" });
        // Legacy link options handle selection in the app. Keep default link navigation from changing the editor route.
        if (target.matches('a')) target.addEventListener("click", event => event.preventDefault(), { once: true });
        const hit = one(scan(target, '.soui-select-option-inner')) || target;
        if (enabled(hit)) {
          hit.click();
          const selected = await stable(() => {
            const observed = readValues().filter(value => same(picked, value) || same(value, wanted));
            return observed.length === 1 ? observed[0] : "";
          });
          result = selected ? { ok: true, value: selected } : fail("OPTION_NOT_VERIFIED", `选中「${wanted}」后，SHEIN 未显示选中结果。`);
        }
      }
    }
    return await closeMenu(select, menu) ? result : fail("MENU_STILL_OPEN", "SHEIN 选项菜单仍打开，请核对页面。");
  }

  function searchControl(select, menu) {
    const selector = 'input,textarea,[contenteditable="true"],[contenteditable="plaintext-only"]';
    return one([...new Set([...scan(menu, selector), ...scan(select, selector)])].filter(node =>
      enabled(node) && !node.readOnly && (!node.matches('input') || /^(?:text|search)$/u.test(node.type))));
  }

  function typeSearch(search, value) {
    search.focus();
    if (search.matches('[contenteditable]')) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(search);
      selection?.removeAllRanges();
      selection?.addRange(range);
      if (document.execCommand?.('insertText', false, value)) return;
      search.textContent = value;
    } else {
      const proto = search.matches('textarea') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(search, value);
    }
    search.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: value, inputType: 'insertText' }));
  }

  async function findOptions(select, menu, wanted) {
    const matches = () => {
      const rows = optionRows(menu);
      const exact = rows.filter(node => key(optionLabel(node)) === key(wanted));
      return exact.length ? exact : rows.filter(node => same(optionLabel(node), wanted));
    };
    const initial = matches();
    if (initial.length) return initial;
    const search = searchControl(select, menu);
    if (!search || !enabled(search) || one(menus()) !== menu || !onPage()) return [];
    typeSearch(search, wanted);
    const loaded = await stable(() => {
      if (one(menus()) !== menu || menu.getAttribute('aria-busy') === 'true') return "";
      const matching = matches();
      return matching.length ? JSON.stringify(matching.map(optionLabel)) : "";
    }, 1900, 240);
    return loaded && one(menus()) === menu ? matches() : [];
  }
}

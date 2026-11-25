/** Reads and fills the new-product editor. The injected function has no external dependencies. */
export async function sheinEditorPage({ href, kind = "inspect", input = {} } = {}) {
  const clean = value => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const fieldKey = value => clean(value).replace(/^[*＊]\s*/u, "").replace(/\s+/gu, "").toLowerCase();
  const text = node => clean(node?.innerText ?? node?.textContent);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fail = (code, message) => ({ ok: false, code, message });
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length &&
    !node.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(node).visibility !== "hidden");
  const enabled = node => visible(node) && !node.closest(':disabled,[aria-disabled="true"],.soui-select-wrapper-disabled');
  const query = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);
  const one = items => items.length === 1 ? items[0] : null;
  const modal = 'dialog[open],[role="alertdialog"],[aria-modal="true"],.soui-modal-wrapper,.so-dialog';
  const dropdown = '.soui-select-picker-wrapper.merchant-ui-select-options,.soui-select-dropdown,[role="listbox"]';
  const option = '[role="option"],.soui-select-dropdown-item,.soui-select-option';
  const attributeItem = '[class*="productAttrItem--"].soui-form-item-wrapper';
  const requiredItem = '.soui-form-item-wrapper-required,.so-form-item-required,[aria-required="true"],[data-required="true"]';
  const labelSelector = '.soui-form-item-label,.soui-form-item-label-wrapper,.so-form-label,[class*="productAttrLabel--"],label';
  const starMarkers = new WeakMap();
  const basic = [
    ["englishTitle", "商品标题（英语）", ".main_name", "input", true, 250],
    ["englishDescription", "商品描述（英语）", ".main_desc", "textarea", false, 5000],
    ["sellerSku", "货号", ".supplier_code", "input", true, 100],
    ["origin", "产地", ".origin_code", ".soui-select", false],
  ];
  const isRoute = () => {
    const [path, search = ""] = location.hash.slice(1).split("?");
    return window === window.top && location.href === href && location.origin === "https://sellerhub.shein.com" &&
      location.pathname === "/" && path === "/spmp/commoditiesInfo" &&
      new URLSearchParams(search).getAll("mode").join("|") === "add";
  };
  const pageMarkers = () => query(document, 'button,[role="button"]').some(node => text(node) === "发布商品") &&
    query(document, 'button,[role="button"]').some(node => text(node) === "保存草稿");
  const fullEditor = () => query(document, '[class*="specContentRow--"]').length > 0 &&
    query(document, '.so-form-item.publish_site').some(area => area.querySelector('input[type="checkbox"]'));
  const blocked = () => query(document, modal).length > 0;
  const categorySelector = '[class*="spmp_style__commodityCategoryItem--"] [class*="spmp_style__categoryInfo--"]';
  const readCategoryPath = () => text(one(query(document, categorySelector))).split(/\s*>\s*/u).filter(Boolean);
  const expectedPath = Array.isArray(input?.categoryPath) && input.categoryPath.every(value => typeof value === "string")
    ? input.categoryPath.map(clean) : [];
  const categoryMatches = () => expectedPath.length > 0 && expectedPath.every(Boolean) &&
    JSON.stringify(expectedPath) === JSON.stringify(readCategoryPath());
  const editContext = () => isRoute() && (kind === "inspect" || categoryMatches());

  if (!isRoute()) return fail("PAGE_CHANGED", "SHEIN 新建商品页面已切换。");
  if (!["inspect", "fill", "options", "repair", "review"].includes(kind)) return fail("ACTION_UNSUPPORTED", "不支持此 SHEIN 编辑操作。");
  if (!pageMarkers()) return fail("EDITOR_NOT_READY", "SHEIN 商品编辑器仍在加载。");
  if (kind === "fill" && !fullEditor()) return fail("EDITOR_NOT_READY", "正在等待 SHEIN 规格和上架站点加载。");
  if (blocked()) return fail("MODAL_BLOCKED", "请关闭当前 SHEIN 弹窗后再继续。");
  if (!editContext()) return fail("CATEGORY_CHANGED", "当前 SHEIN 商品分类与待填资料不一致，请核对。");

  function dismissListingTips() {
    for (const message of ["建议完善尺码数据", "拖动图片可进行排序"]) {
      const matches = query(document, "button").filter(button => {
        if (!/^关闭\s*(?:\d+s)?$/iu.test(text(button))) return false;
        for (let area = button.parentElement, depth = 0; area && depth < 5; area = area.parentElement, depth++) {
          const description = text(area);
          if (description.length > 150 || area.matches("form,main,section,dialog,[aria-modal=true]")) break;
          if (description.includes(message)) return true;
        }
        return false;
      });
      if (matches.length === 1 && editContext() && !blocked()) matches[0].click();
    }
  }

  if (kind === "fill") dismissListingTips();

  function optionValue(node) {
    return text(node.querySelector('[class*="attrValRenderItem--"],.soui-select-dropdown-item-label,.soui-select-option-label')) || text(node);
  }

  function namesFor(label) {
    const bilingual = /^([^a-z]+?)\s*([a-z].*)$/iu.exec(label);
    return new Set([label, ...(bilingual?.slice(1) || [])].map(fieldKey).filter(Boolean));
  }

  function optionNames(node) {
    const label = optionValue(node);
    const names = namesFor(label);
    const english = text(node.querySelector('[class*="attrValRenderItemEnText--"]'));
    if (english && label.endsWith(english)) {
      names.add(fieldKey(english));
      const localized = fieldKey(label.slice(0, -english.length));
      if (localized) names.add(localized);
    }
    return names;
  }

  function matchOptions(nodes, value) {
    const key = fieldKey(value);
    const exact = nodes.filter(node => fieldKey(optionValue(node)) === key);
    return exact.length ? exact : nodes.filter(node => optionNames(node).has(key));
  }

  const optionNodes = menu => query(menu, option).filter(node => enabled(node) && !node.parentElement.closest(option));

  function chosen(select) {
    const result = select.querySelector('.soui-select-result-wrapper') ?? select;
    const tokens = query(result, '.soui-select-ellipsis,.soui-select-result-label,.soui-select-result-text,.soui-select-multiple-result-item,.soui-select-multiple-result-label,.soui-select-result-item,.soui-tag');
    const labels = tokens.filter(node => !tokens.some(other => node !== other && node.contains(other)))
      .map(node => clean(node.getAttribute("title")) || text(node)).filter(Boolean);
    if (!labels.length && !select.classList.contains('soui-select-wrapper-empty')) {
      const visibleLabel = text(result.querySelector('.soui-select-result-text-wrapper,.soui-select-result'));
      if (visibleLabel && visibleLabel !== clean(result.querySelector('input')?.placeholder)) labels.push(visibleLabel);
    }
    return [...new Set(labels.filter(label => !/^(?:请(?:输入|选择)(?:或搜索)?|please (?:enter|select)(?: or search)?)$/iu.test(label)))];
  }

  function red(color) {
    const rgb = String(color || "").match(/rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/u);
    return rgb && Number(rgb[1]) >= 155 && Number(rgb[1]) - Math.max(Number(rgb[2]), Number(rgb[3])) >= 75;
  }

  function requiredField(section, node, heading) {
    if (section.matches(requiredItem) || node.matches('[required],[aria-required="true"],[data-required="true"]') ||
        node.querySelector('[required],[aria-required="true"]')) return true;
    if (!heading || !visible(heading)) return false;
    if (heading.matches(requiredItem)) return true;
    if (section.matches('.soui-form-item-wrapper-hide-required')) return false;
    if (/^[*＊]\s*\S/u.test(text(heading))) return true;
    const signature = section.className + "\n" + heading.outerHTML;
    const previous = starMarkers.get(heading);
    if (previous?.signature === signature) return previous.required;
    const star = value => /^[*＊]$/u.test(clean(value).replace(/^["']|["']$/gu, ""));
    const labelParts = [heading, ...query(heading, 'span,i,em,b,label,[class*="required" i]')];
    const required = labelParts.some(part => {
      if (part.matches('.soui-form-item-label-required,.so-form-label-required,[aria-required="true"]')) return true;
      if (star(text(part)) && (red(getComputedStyle(part).color) || /required|asterisk/iu.test(part.className))) return true;
      if (typeof globalThis.CSS?.supports !== "function") return false;
      return ['::before', '::after'].some(pseudo => {
        const style = getComputedStyle(part, pseudo);
        return star(style?.content) && style.display !== "none" && style.visibility !== "hidden" &&
          style.opacity !== "0" && red(style.color);
      });
    });
    starMarkers.set(heading, { signature, required });
    return required;
  }

  function inlineError(section, node) {
    const error = query(section, '[role="alert"],[class*="form-item-error"],.soui-form-item-explain-error,[class*="errorMessage--"],[class*="errorTip--"]')
      .map(text).filter(message => message && message.length < 230);
    if (error.length) return [...new Set(error)].slice(0, 2).join(" ");
    const invalid = node.matches('[aria-invalid="true"]') ||
      section.matches('.soui-form-item-wrapper-error,.so-form-item-has-error,[aria-invalid="true"]') ||
      section.querySelector('[aria-invalid="true"]');
    const border = [node, node.querySelector('.soui-select-result-wrapper')].filter(Boolean)
      .some(control => red(getComputedStyle(control).borderTopColor));
    return invalid || border ? "SHEIN 标记此项需要核对。" : "";
  }

  function describe(section, node, key, label, required, limit) {
    const select = node.matches('.soui-select');
    const multiple = select && node.classList.contains('soui-select-multiple');
    const values = select ? chosen(node) : [];
    const type = select ? "select" : node.type === "number" ? "number" : node.type === "checkbox" ? "checkbox" : "text";
    const group = key.startsWith("attribute:") ? required ? "必填商品属性" : "商品属性" : "基础信息";
    const error = inlineError(section, node);
    return { section, node, limit, field: { key, label, type, required, section: group, maxLength: limit,
      value: select ? multiple ? values : values[0] ?? "" : type === "checkbox" ? node.checked : node.value,
      ...(type === "number" && { min: node.min ? Number(node.min) : undefined, max: node.max ? Number(node.max) : undefined }),
      ...(multiple && { multiple }), ...(error && { error }) } };
  }

  function controls() {
    const entries = basic.flatMap(([key, label, selector, control, required, limit]) => {
      const section = one(query(document, `.so-form-item${selector}`));
      const node = section && one(query(section, control).filter(enabled));
      return node && (control === '.soui-select' || !node.readOnly) ? [describe(section, node, key, label,
        required || requiredField(section, node, section.querySelector(labelSelector)), limit)] : [];
    });
    for (const section of query(document, attributeItem).slice(0, 100)) {
      const heading = section.querySelector(labelSelector);
      const label = text(heading).replace(/^(?:[*＊]\s*)+|\s*[*＊]$/gu, "");
      const nodes = query(section, '.soui-select,input,textarea').filter(node => enabled(node) &&
        (node.matches('.soui-select') || /^(?:text|search|number|textarea|checkbox)$/u.test(node.type) && !node.readOnly && !node.closest('.soui-select')));
      const node = one(nodes);
      if (!label || !node || label.length > 140) continue;
      const required = requiredField(section, node, heading);
      entries.push(describe(section, node, `attribute:${label}`, label, required,
        node.maxLength > 0 ? Math.min(node.maxLength, 500) : 500));
    }
    const groupBy = (list, identify) => {
      const groups = new Map();
      for (const item of list) {
        const id = identify(item);
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(item);
      }
      return groups;
    };
    return [...groupBy(entries, entry => fieldKey(entry.field.key)).values()].flatMap(group => {
      if (group.length === 1) return group;
      const byId = groupBy(group, ({ section, node }) => clean(section.getAttribute("data-attribute-id") ||
        section.getAttribute("data-attr-id") || node.getAttribute("name")));
      return [...byId].flatMap(([id, matches]) => /^[\p{L}\d_.:-]{1,100}$/u.test(id) && matches.length === 1
        ? [{ ...matches[0], explicitKeyOnly: true,
          field: { ...matches[0].field, key: `${matches[0].field.key} [${id}]` } }] : []);
    });
  }

  function requestedValue(entry, available) {
    const { key, label } = entry.field;
    if (!key.startsWith("attribute:")) return input[key];
    if (entry.explicitKeyOnly) return input.attributes?.[key];
    const supplied = Object.entries(input.attributes ?? {});
    const exact = new Set([fieldKey(key), fieldKey(label)]);
    const fullMatches = supplied.filter(([name]) => exact.has(fieldKey(name)));
    const aliases = namesFor(label);
    const matches = fullMatches.length ? fullMatches : supplied.filter(([name]) => {
      const alias = fieldKey(name);
      return aliases.has(alias) && !available.some(other => other !== entry &&
        other.field.key.startsWith("attribute:") && namesFor(other.field.label).has(alias));
    });
    const values = matches.map(([, value]) => value);
    return values.length && values.every(value => JSON.stringify(value) === JSON.stringify(values[0])) ? values[0] : undefined;
  }

  // Require repeated agreement so a CSS-transition frame or a transient search result cannot become a click target.
  async function stable(read, timeout = 1250) {
    const deadline = Date.now() + timeout;
    let since = 0;
    let previous;
    do {
      if (!editContext() || blocked()) return null;
      const state = read();
      if (!state || state.key !== previous) {
        since = Date.now();
        previous = state?.key;
      } else if (Date.now() - since >= 120) return state;
      await delay(45);
    } while (Date.now() < deadline);
    return null;
  }

  async function expandAttributes() {
    const label = /^(?:展开所有属性|Expand all attributes)$/iu;
    const matches = query(document, 'button,a,[role="button"],span,div').filter(node => enabled(node) &&
      label.test(text(node)) && ![...node.children].some(child => visible(child) && label.test(text(child))));
    const toggle = one(matches.filter(node => {
      for (let area = node.parentElement, depth = 0; area && area !== document.body && depth < 7; area = area.parentElement, depth++) {
        if (area.matches('form,main,[role="dialog"]')) break;
        if (area.querySelector(attributeItem)) return true;
      }
      return false;
    }));
    if (!toggle || !editContext() || blocked() || menus().length) return;
    const before = query(document, attributeItem).length;
    toggle.click();
    await stable(() => {
      const after = query(document, attributeItem).length;
      return after > before || toggle.isConnected && /^(?:收起所有属性|Collapse all attributes)$/iu.test(text(toggle))
        ? { key: String(after) } : null;
    }, 1300);
  }

  function menus() {
    const containers = query(document, dropdown).filter(node => {
      const style = getComputedStyle(node);
      return style.pointerEvents !== "none" && style.opacity !== "0";
    });
    return containers.filter(node => !containers.some(parent => parent !== node && parent.contains(node)));
  }

  function searchField(control, menu) {
    const candidates = new Set([...query(control, "input"), ...query(menu, "input")]);
    return one([...candidates].filter(node => /^(?:text|search)$/u.test(node.type) &&
      enabled(node) && !node.readOnly));
  }

  async function closeMenu(node, menu) {
    if (!menu?.isConnected || !menus().includes(menu)) return true;
    const control = node.querySelector('.soui-select-result-wrapper') ?? node;
    const focused = document.activeElement;
    if (node.contains(focused) || menu.contains(focused)) {
      focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      focused.blur();
    }
    if (await stable(() => !menus().includes(menu) ? { key: "closed" } : null, 310)) return true;
    if (!editContext() || blocked() || !enabled(control) || one(menus()) !== menu) return false;
    control.click();
    return Boolean(await stable(() => !menus().includes(menu) ? { key: "closed" } : null, 600));
  }

  async function inspectChoices(entry) {
    const { node } = entry;
    if (menus().length) return fail("MENU_STILL_OPEN", "请先关闭 SHEIN 当前的下拉菜单。");
    const control = node.querySelector('.soui-select-result-wrapper') ?? node;
    control.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    if (!enabled(control) || !editContext()) return fail("PAGE_CHANGED", "SHEIN 商品控件已变化。");
    control.click();
    const found = await stable(() => {
      const menu = one(menus());
      const options = menu && optionNodes(menu).map(optionValue).filter(Boolean);
      return options?.length ? { key: JSON.stringify(options), menu, options } : null;
    }, 1800);
    const menu = found?.menu ?? one(menus());
    if (!found) {
      if (menu) await closeMenu(node, menu);
      return fail("OPTIONS_UNAVAILABLE", "暂时没有读到该字段的可用选项。");
    }
    const choices = new Set(found.options);
    const scroller = [menu, ...query(menu, '.soui-select-list,.soui-select-virtual-list,[role="listbox"]')]
      .find(element => element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 4);
    const original = scroller?.scrollTop;
    let closed;
    try {
      for (let index = 0; scroller && index < 9 && choices.size < 140; index++) {
        const next = Math.min(scroller.scrollTop + Math.max(1, scroller.clientHeight * 0.85), scroller.scrollHeight - scroller.clientHeight);
        if (scroller.scrollTop >= next || one(menus()) !== menu) break;
        scroller.scrollTop = next;
        const read = await stable(() => {
          if (one(menus()) !== menu) return null;
          const options = optionNodes(menu).map(optionValue).filter(Boolean);
          return options.length ? { key: JSON.stringify(options), options } : null;
        }, 550);
        for (const option of read?.options || []) choices.add(option);
      }
    } finally {
      if (scroller?.isConnected && one(menus()) === menu) scroller.scrollTop = original;
      closed = await closeMenu(node, menu);
    }
    if (!closed) return fail("MENU_STILL_OPEN", "未确认该字段下拉菜单已关闭。");
    return { ok: true, options: [...choices].slice(0, 140) };
  }

  async function fillSelect(entry, supplied) {
    const { node, field } = entry;
    const values = Array.isArray(supplied) ? supplied : [supplied];
    const wanted = values.map(clean);
    if ((!field.multiple && wanted.length !== 1) || !wanted.length || wanted.length > 20 ||
        values.some(value => typeof value !== "string") || wanted.some(value => !value || value.length > 140) ||
        new Set(wanted).size !== wanted.length) return fail("VALUE_INVALID", "下拉选项需使用页面中的准确名称。");
    const previous = chosen(node);
    const alreadyChosen = value => previous.filter(label => namesFor(label).has(fieldKey(value))).length === 1;
    if (wanted.every(alreadyChosen)) return { ok: true, status: "unchanged" };
    if (menus().length || (!field.multiple && previous.length && !(kind === "repair" && field.error))) {
      return fail("SELECT_NOT_EMPTY", "该选项已有值或另一个菜单打开，请核对。");
    }
    const control = node.querySelector('.soui-select-result-wrapper') ?? node;
    control.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    if (!editContext() || !enabled(control)) return fail("PAGE_CHANGED", "SHEIN 商品控件已变化。");
    control.click();
    let menu;
    const selected = await stable(() => {
      menu = one(menus());
      if (!menu) return null;
      const options = optionNodes(menu);
      if (!options.length && !searchField(control, menu)) return null;
      const names = options.map(optionValue);
      const { top, left } = menu.getBoundingClientRect();
      return { key: JSON.stringify([names, Math.round(top), Math.round(left)]) };
    });
    if (!selected) {
      if (menu && !await closeMenu(node, menu)) return fail("MENU_STILL_OPEN", "下拉未完成加载，且无法确认已关闭。");
      return fail("OPTIONS_UNAVAILABLE", "SHEIN 下拉选项未稳定加载。");
    }
    const menuIsCurrent = () => editContext() && !blocked() && control.isConnected && one(menus()) === menu;
    async function resolve(value) {
      if (!menuIsCurrent()) return fail("MENU_CHANGED", "选项菜单已变化。");
      const direct = matchOptions(optionNodes(menu), value);
      if (direct.length) return one(direct) ? { ok: true, target: direct[0] } : missingOption(value, direct);
      const search = searchField(control, menu);
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!search || !set) return missingOption(value, direct);

      if (search.value !== value) {
        search.focus({ preventScroll: true });
        if (!menuIsCurrent() || searchField(control, menu) !== search) return fail("MENU_CHANGED", "下拉搜索框已变化。");
        set.call(search, value);
        search.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      }
      const result = await stable(() => {
        if (!menuIsCurrent() || searchField(control, menu)?.value !== value) return null;
        const options = optionNodes(menu);
        const matches = matchOptions(options, value);
        return matches.length ? { key: JSON.stringify(options.map(optionValue)), matches } : null;
      }, 2500);
      if (!menuIsCurrent()) return fail("MENU_CHANGED", "选项菜单已变化。");
      const matches = result?.matches ?? [];
      return one(matches) ? { ok: true, target: matches[0] } : missingOption(value, matches, true);
    }

    try {
      const pending = wanted.filter(value => !alreadyChosen(value));
      const verifiedLabels = new Set();
      for (const value of pending) {
        const resolved = await resolve(value);
        if (!resolved.ok) return resolved;
        const label = fieldKey(optionValue(resolved.target));
        if (verifiedLabels.has(label)) return fail("OPTION_AMBIGUOUS", "多个输入映射到了同一个 SHEIN 选项。");
        verifiedLabels.add(label);
      }
      for (const value of pending) {
        const resolved = await resolve(value);
        if (!resolved.ok) return resolved;
        const { target } = resolved;
        const expected = optionNames(target);
        expected.add(fieldKey(value));
        const retained = field.multiple ? chosen(node) : [];
        if (target.matches('[aria-selected="true"],[data-selected="true"],.soui-select-dropdown-item-selected') ||
            retained.some(prior => expected.has(fieldKey(prior)))) {
          return fail("EXISTING_VALUE_UNVERIFIED", "该选项可能已选中，已停止重复点击以免取消现有值。");
        }
        target.scrollIntoView?.({ block: 'nearest' });
        if (!editContext() || !enabled(target)) return fail("MENU_CHANGED", "目标选项已变化。");
        const hit = one(query(target, '.soui-select-option-inner')) ?? target;
        if (!enabled(hit)) return fail("MENU_CHANGED", "目标选项当前不可点击。");
        hit.click();
        const read = await stable(() => {
          const live = controls().find(control => control.field.key === field.key);
          const values = live && chosen(live.node);
          return values?.some(actual => expected.has(fieldKey(actual))) &&
            retained.every(prior => values.includes(prior)) ? { key: JSON.stringify(values) } : null;
        }, 2400);
        if (!read) return fail("VALUE_UNVERIFIED", `选择「${value}」后未回读到实际选中值。`);
      }
      return { ok: true, status: "filled" };
    } finally {
      await closeMenu(node, menu);
    }
  }

  function missingOption(value, matches, searched = false) {
    const source = searched ? "SHEIN 搜索结果" : "当前已加载的选项";
    return fail(matches.length ? "OPTION_AMBIGUOUS" : "OPTION_MISSING", `${source}中${matches.length ? "有多个" : "未找到"}准确选项「${value}」。`);
  }

  async function fillText(entry, value) {
    const { node, limit, field } = entry;
    if (typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) {
      return fail("VALUE_INVALID", "请提供文本或数字。");
    }
    const target = String(value).trim();
    if (target.length > limit) return fail("VALUE_TOO_LONG", `字段最多支持 ${limit} 个字符。`);
    if (node.value === target) return { ok: true, status: "unchanged" };
    const prototype = node.localName === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!set || !enabled(node)) return fail("FIELD_UNAVAILABLE", "字段当前不可编辑。");
    node.focus({ preventScroll: true });
    set.call(node, target);
    node.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    node.blur();
    const read = await stable(() => controls().find(control => control.field.key === field.key)?.node.value === target
      ? { key: target } : null);
    return read ? { ok: true, status: "filled" } : fail("VALUE_UNVERIFIED", "写入后未回读到实际值。");
  }

  if (kind === "fill" || kind === "review") await expandAttributes();
  if (!editContext() || blocked()) return fail("PAGE_CHANGED", "SHEIN 商品页面、分类或弹窗状态变化。");

  const items = [];
  const issues = [];
  const initial = controls();
  if (!initial.some(({ field }) => field.key === "englishTitle")) return fail("EDITOR_NOT_READY", "未找到 SHEIN 商品标题控件。");
  function view(entries) {
    const fields = entries.map(({ field }) => field);
    const ids = new Set(query(document, 'span,div,p').flatMap(node => {
      const label = text(node);
      return label.length < 80 && label.match(/店铺\s*(GS\d{3,})\b/u) ? [label.match(/店铺\s*(GS\d{3,})\b/u)[1]] : [];
    }));
    const shopHeader = '[class*="soc-fe-sso-sdk_userInfo"] [class*="soc-fe-sso-sdk_companyName"]';
    for (const node of query(document, shopHeader)) {
      if (/^GS\d{4,20}$/iu.test(text(node))) ids.add(text(node).toUpperCase());
    }
    return { ok: true, status: "inspected", categoryPath: readCategoryPath(), fields, items, issues,
      storeKey: ids.size === 1 ? [...ids][0] : "" };
  }
  if (kind === "inspect" || kind === "review") return view(initial);
  if (kind === "options") {
    const entry = initial.find(entry => entry.field.key === input.fieldKey && entry.field.type === "select");
    return entry ? inspectChoices(entry) : fail("FIELD_UNAVAILABLE", "当前页未找到对应下拉字段。");
  }
  async function apply(entry, value) {
    const { field, node } = entry;
    if (field.type === "select") return fillSelect(entry, value);
    if (field.type === "checkbox") {
      if (typeof value !== "boolean") return fail("VALUE_INVALID", "复选框需要明确的勾选状态。");
      if (node.checked === value) return { ok: true, status: "unchanged" };
      if (!enabled(node) || !editContext()) return fail("FIELD_UNAVAILABLE", "复选框当前不可编辑。");
      node.click();
      const read = await stable(() => controls().find(entry => entry.field.key === field.key)?.node.checked === value ? { key: value } : null);
      return read ? { ok: true, status: "filled" } : fail("VALUE_UNVERIFIED", "未回读到复选框状态。");
    }
    return fillText(entry, value);
  }
  const attempted = new Set();
  const blank = field => ![].concat(field.value).some(value => clean(value));
  for (let round = 0; round < 3; round++) {
    const pending = controls().filter(entry => !attempted.has(entry.field.key));
    if (!pending.length) break;
    for (const { field } of pending) {
      if (!editContext() || blocked()) return fail("PAGE_CHANGED", "SHEIN 商品页面、分类或弹窗状态变化。");
      attempted.add(field.key);
      const available = controls();
      const entry = available.find(control => control.field.key === field.key);
      if (!entry) continue;
      const value = kind === "repair" ? (entry.field.error || blank(entry.field))
        && Object.hasOwn(input.values || {}, field.key) ? input.values[field.key] : undefined : requestedValue(entry, available);
      if (value == null || value === "" || Array.isArray(value) && !value.length) continue;
      const { ok, status, code, message } = await apply(entry, value);
      if (ok) items.push({ key: field.key, label: field.label, status });
      else issues.push({ key: field.key, label: field.label, code, message });
      if (menus().length) return { ok: false, code: "MENU_STILL_OPEN", message: "请关闭当前 SHEIN 下拉菜单。", items, issues };
    }
  }
  const fields = controls().map(({ field }) => field);
  for (const field of fields) if (field.required && blank(field) &&
      !issues.some(issue => issue.key === field.key)) {
    issues.push({ key: field.key, label: field.label, code: "VALUE_REQUIRED", message: "SHEIN 当前类目要求填写此项。" });
  }
  if (!editContext()) return fail("PAGE_CHANGED", "SHEIN 商品页面或分类变化。");
  return { ok: true, status: "filled", categoryPath: readCategoryPath(), fields, items, issues };
}

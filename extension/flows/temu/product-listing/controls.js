// This function is serialized by chrome.scripting. Keep its helpers inside it.
export async function temuControls(request) {
  const ORIGIN = "https://agentseller.temu.com";
  const PATH = "/goods/edit";
  const WRAPPER = '[class*="ST_outerWrapper_"]';
  const HEAD = '[class*="ST_head_"]';
  const FORM_CONTROLS = 'input,textarea,select,[role="combobox"],[role="radio"],[role="checkbox"],[contenteditable="true"]';
  const MENU = '[data-testid="beast-core-portal"] [role="listbox"],[class*="ST_dropdown_"] [role="listbox"]';
  const OPTION = '[role="option"],[data-testid="beast-core-select-option"]';
  const LABEL = 'label,[data-field-label],[class*="Form_itemLabelContent_"],[class*="STF_label_"]';
  const FORM_ITEM = '[data-testid="beast-core-form-item"],[class*="Form_item_"]';
  const REQUIRED = '[class*="Form_required"],[class*="itemLabelRequired"],[data-required="true"]';
  const MODAL = 'dialog[open],[role="alertdialog"],[aria-modal="true"],[data-testid="beast-core-modal-container"],[class*="MDL_inner_"]';
  const MAX_FIELDS = 100;
  const MAX_OPTIONS = 400;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value, limit = 300) => String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, limit);
  const key = (value) => clean(value, 1000).normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
  const fail = (code, message, changed = false) => ({ ok: false, code, message, ...(changed ? { changed } : {}) });
  const scope = request.scope || {};
  const validPage = () => window === window.top && location.origin === ORIGIN && location.pathname === PATH &&
    scope.href === location.href;
  const visible = (element) => Boolean(element?.isConnected && element.getClientRects().length &&
    !element.closest('[hidden],[inert],[aria-hidden="true"]') &&
    getComputedStyle(element).visibility !== "hidden" && (getComputedStyle(element).opacity || "1") !== "0");
  const blocked = () => Array.from(document.querySelectorAll(MODAL)).some(visible);
  const editable = (input) => !input.disabled && !input.closest('[aria-disabled="true"],[aria-readonly="true"],[class*="ST_disabled_"]') &&
    /^(?:text|search)$/.test(input.type);
  const groups = (element) => {
    const result = [];
    for (let node = element.parentElement, i = 0; node && i < 14; node = node.parentElement, i++) {
      if (node.matches("body,main")) break;
      if (/^[A-Za-z_][A-Za-z0-9_[\].:-]{1,110}$/.test(node.id) && document.getElementById(node.id) === node) result.push(node);
    }
    return result;
  };
  const labelText = (node) => clean(node?.textContent).replace(/^[*＊]\s*/u, "").replace(/[：:]$/u, "");

  function labelFor(input, group) {
    if (/^productSkcList\[\d{1,3}\]\.mainSpec\[0\]$/u.test(group.id) &&
        input.placeholder === "选择或自定义颜色") return "服装颜色";
    const parent = /^minorSpec\.(\d+)\.selectedRootSpecId$/u.exec(group.id);
    if (parent) return `父规格 ${Number(parent[1]) + 1}`;
    const fixed = {
      productOriginCode: "商品产地", manufacturingLocation: "制造地点",
      shipmentLimitSecond: "承诺发货时效", freightTemplateId: "运费模板",
    }[group.id];
    if (fixed) return fixed;
    if (/^productSkuMap\.[\w-]*\.sensitiveAttr$/u.test(group.id)) return "敏感属性";
    if (/^productSkuMap\.[\w-]*\.productSkuMultiPack\.skuClassification$/u.test(group.id)) return "SKU 分类";
    const aria = clean(input.getAttribute("aria-label"));
    if (aria) return aria;
    const ids = clean(input.getAttribute("aria-labelledby")).split(/\s+/);
    const fromIds = ids.map((id) => labelText(document.getElementById(id))).filter(Boolean).join(" ");
    if (fromIds) return fromIds;
    for (const label of group.querySelectorAll(LABEL)) {
      const name = labelText(label);
      if (name && !label.closest(WRAPPER) && !label.querySelector("input,select,textarea")) return name;
    }
    let child = group;
    for (let depth = 0; depth < 3 && child.parentElement; depth++, child = child.parentElement) {
      if (child.parentElement.querySelectorAll(WRAPPER).length > 1) break;
      const sibling = child.previousElementSibling;
      const label = sibling?.matches(LABEL) ? sibling : sibling?.querySelector(LABEL);
      if (labelText(label)) return labelText(label);
    }
    const header = group.closest("td")?.closest("table")?.tHead?.rows[0]?.cells[group.closest("td")?.cellIndex];
    return labelText(header);
  }

  function rowLabelsFor(input) {
    const row = input.closest("tr");
    if (!row) return [];
    const cells = [...row.cells];
    for (let index = row.sectionRowIndex - 1; index >= 0; index--) {
      for (const cell of row.parentElement.rows[index]?.cells || []) {
        if (cell.rowSpan === 0 || index + cell.rowSpan > row.sectionRowIndex) cells.push(cell);
      }
    }
    return cells.filter(cell => !cell.querySelector(`${FORM_CONTROLS},button,a`))
      .map(cell => clean(cell.dataset.value || cell.getAttribute("aria-label") || cell.textContent))
      .filter(text => text && !/^[-–—]+$/u.test(text)).slice(0, 12);
  }

  function structural(input) {
    const root = document.getElementById("page_container_id");
    if (!root?.contains(input) || input.placeholder !== "请选择") return null;
    const composition = input.closest('[id="productProperties[15]"]');
    const row = input.closest("tbody tr");
    const item = input.closest('[data-testid="beast-core-form-item"]');
    let label;
    let fieldKey;
    let holder;
    if (composition?.contains(row) && row.querySelectorAll('input[placeholder="请选择"]').length === 1) {
      fieldKey = `composition-material-${row.sectionRowIndex}`;
      label = "成分材料";
      holder = composition;
    } else if (item && /^[*＊]?\s*尺码\s*建议发布/u.test(clean(item.innerText || item.textContent)) &&
        item.querySelectorAll('input[placeholder="请选择"]').length === 1) {
      fieldKey = "apparel-size";
      label = "尺码";
      holder = item;
    } else return null;
    const segments = [];
    for (let node = input; node && node !== root; node = node.parentElement) {
      segments.unshift(`${node.localName}:nth-child(${[...node.parentElement.children].indexOf(node) + 1})`);
    }
    const selector = `#page_container_id > ${segments.join(" > ")}`;
    return { holder, selector, fieldKey, label, requiredHint: true };
  }

  function materialLabelParts(node) {
    const labels = [...node.querySelectorAll('[class^="name-label_name__"]')];
    const label = labels.length === 1 ? labels[0] : null;
    const primary = label && clean([...label.childNodes].filter(child => child.nodeType === 3)
      .map(child => child.textContent).join(" "), 500);
    const translation = label && clean(label.querySelector('[class^="name-label_enName__"]')?.textContent);
    return { primary, translation };
  }

  const readSelected = wrapper => {
    const selected = [...wrapper.querySelectorAll('[class*="ST_selectValueSingle_"],[class*="ST_selectValueMultipleItem_"]')]
      .filter(visible).map(node => materialLabelParts(node).primary || clean(node.textContent)).filter(Boolean);
    if (selected.length) return selected;
    const fallback = wrapper.querySelector('[class*="ST_selectValue_"]');
    const value = visible(fallback) && (materialLabelParts(fallback).primary || clean(fallback.textContent));
    return value ? [value] : [];
  };
  const labelItems = area => [...area?.querySelectorAll(LABEL) || []].filter(node => visible(node) &&
    !node.closest(WRAPPER) && !node.querySelector(FORM_CONTROLS));
  const requiredMarker = area => [...area?.querySelectorAll(REQUIRED) || []].some(node =>
    node.getClientRects().length && !node.closest('[hidden],[inert]') && getComputedStyle(node).visibility !== "hidden");

  function isRequired(input, area, label) {
    if (input.required || input.getAttribute("aria-required") === "true" || area?.matches('[data-required="true"]')) return true;
    const labels = labelItems(area);
    const match = labels.filter(node => key(labelText(node)) === key(label));
    if (match.some(node => /^[*＊]/u.test(clean(node.textContent)) || node.matches(REQUIRED) || requiredMarker(node))) return true;
    const labelNames = new Set(labels.map(labelText).filter(Boolean).map(key));
    return Boolean(area && labelNames.size <= 1 && area.querySelectorAll(`${WRAPPER} ${HEAD} input`).length === 1 &&
      requiredMarker(area));
  }

  function describe(input, wrapper, { holder: group, selector, fieldKey, label, requiredHint = false }) {
    const item = group.closest(FORM_ITEM) || input.closest(FORM_ITEM) || group;
    const required = requiredHint || isRequired(input, group, label) || (item !== group && isRequired(input, item, label)) ||
      /^(?:productOriginCode|manufacturingLocation|shipmentLimitSecond|freightTemplateId)$/u.test(group.id) ||
      /^productSkuMap\.[\w-]*\.sensitiveAttr$/u.test(group.id);
    const multiple = Boolean(wrapper.querySelector('[class*="ST_selectValueMultiple_"]') || input.getAttribute("aria-multiselectable") === "true");
    const locator = { adapter: "temu-select", tag: "input", type: input.type, role: "combobox", selector, label };
    const selected = readSelected(wrapper);
    const sku = /^productSkuMap\.([\w-]*)\.(sensitiveAttr|productSkuMultiPack\.skuClassification)$/u.exec(group.id);
    return { input, wrapper, holder: group, field: {
      key: fieldKey || group.id, kind: "select", label, locator, required: Boolean(required), multiple, value: multiple ? selected : selected[0] || "",
      constraints: { ...(required ? { required: true } : {}), ...(multiple ? { multiple: true } : {}) }, options: [],
      ...(sku && { skuGroup: sku[1], skuMember: sku[2], rowLabels: rowLabelsFor(group) }),
    } };
  }

  function info(input) {
    if (!input || !visible(input) || !editable(input)) return null;
    const wrapper = input.closest(WRAPPER);
    if (!wrapper || input.closest(HEAD)?.closest(WRAPPER) !== wrapper) return null;
    const special = structural(input);
    if (special) return describe(input, wrapper, special);
    for (const group of groups(wrapper)) {
      if (/^(?:page_container_id|sku_table_node|root|app)$/i.test(group.id)) continue;
      const selector = `[id="${group.id}"] ${WRAPPER} ${HEAD} input`;
      const candidates = Array.from(document.querySelectorAll(selector)).filter((node) => visible(node) && editable(node));
      if (candidates.length !== 1 || candidates[0] !== input) continue;
      const label = labelFor(input, group);
      if (!label || /密码|验证码|安全码|动态口令|\b(?:password|captcha|passcode|otp)\b/i.test(label)) continue;
      return describe(input, wrapper, { holder: group, selector, label });
    }
    return null;
  }

  function scan() {
    const root = document.getElementById("page_container_id");
    const candidates = [...root?.querySelectorAll(`${WRAPPER} ${HEAD} input`) || []].filter(visible);
    const order = new Map([...root?.querySelectorAll(FORM_CONTROLS) || []].map((element, index) => [element, index]));
    const controls = [];
    const unsupported = [];
    for (const input of candidates) {
      const candidate = info(input);
      if (candidate) {
        candidate.field.order = order.get(input);
        controls.push(candidate);
      } else if (editable(input)) {
        const item = input.closest(FORM_ITEM);
        const labels = [...new Set(labelItems(item).map(labelText).filter(Boolean))];
        const label = clean(input.getAttribute("aria-label")) || (labels.length === 1 ? labels[0] : "未命名下拉");
        const selected = readSelected(input.closest(WRAPPER));
        unsupported.push({ label, kind: "custom-select", reason: "无法唯一定位此下拉控件。",
          required: isRequired(input, item, label), valuePresent: selected.length ? true : input.value ? null : false });
      }
    }
    return { controls: controls.slice(0, MAX_FIELDS), unsupported: unsupported.slice(0, MAX_FIELDS),
      truncated: controls.length > MAX_FIELDS || unsupported.length > MAX_FIELDS };
  }

  function locate(field) {
    const locator = field?.locator;
    if (locator?.adapter !== "temu-select" || typeof locator.selector !== "string") return null;
    try {
      const matches = Array.from(document.querySelectorAll(locator.selector)).map(info).filter(Boolean)
        .filter((candidate) => candidate.field.locator.selector === locator.selector && key(candidate.field.label) === key(locator.label));
      return matches.length === 1 ? matches[0] : null;
    } catch {
      return null;
    }
  }

  const popupFor = menu => menu.closest('[class*="ST_dropdown_"]') || menu.closest('[data-testid="beast-core-portal"]') || menu;
  const menuShells = menu => {
    const shell = menu.closest('[data-testid="beast-core-portal"]') || popupFor(menu);
    const parts = [];
    for (let node = menu; node; node = node.parentElement) {
      parts.push(node);
      if (node === shell) break;
    }
    return parts;
  };
  const menuVisible = menu => Boolean(visible(menu) && menuShells(menu).every(node => getComputedStyle(node).opacity !== "0"));
  const menus = () => {
    const lists = [...document.querySelectorAll(MENU)].filter(menuVisible);
    const dropdowns = [...document.querySelectorAll('[class*="ST_dropdown_"]')].filter(node =>
      menuVisible(node) && node.querySelector(OPTION) && !lists.some(list => node.contains(list)));
    return [...lists, ...dropdowns.filter(node => !dropdowns.some(parent => parent !== node && parent.contains(node)))];
  };
  const interactive = 'a,button,input,select,textarea,summary,[role="button"],[role="tab"],[role="link"],[role="option"],[contenteditable="true"]';
  function* outsideTargets({ wrapper, holder, field }, menu) {
    const popup = popupFor(menu);
    const isStatic = node => visible(node) && !wrapper.contains(node) && !popup.contains(node) &&
      !node.closest(interactive) && !node.querySelector(interactive) && !node.closest("label")?.control;
    const label = key(field.label);
    const root = document.getElementById("page_container_id");
    for (let area = holder, depth = 0; area && area !== root && depth < 4; area = area.parentElement, depth++) {
      const labels = [...area.querySelectorAll(`${LABEL},span,div`)].filter(node =>
        key(labelText(node)) === label && isStatic(node) && ![...node.children].some(child => key(labelText(child)) === label));
      if (labels.length === 1) {
        yield labels[0];
        break;
      }
      if (area.matches(FORM_ITEM) || labels.length > 1) break;
    }
    const headings = [...root?.querySelectorAll('h1,h2,h3,[role="heading"],[class*="STP_stepsItemTitle_"]') || []];
    for (const title of ["商品属性", "基本信息"]) {
      const matches = headings.filter(node => clean(node.textContent) === title && isStatic(node) &&
        ![...node.children].some(child => clean(child.textContent) === title));
      if (matches.length === 1) yield matches[0];
    }
    yield document.body;
  }
  async function poll(pick, ms = 280) {
    const deadline = Date.now() + ms;
    do {
      if (!validPage() || blocked()) return null;
      const value = pick();
      if (value) return value;
      await wait(20);
    } while (Date.now() < deadline);
    return null;
  }

  async function settle(sample, timeout = 1400) {
    let prior;
    let since;
    return poll(() => {
      const current = sample();
      if (!current) {
        prior = undefined;
        return null;
      }
      if (current.node !== prior?.node || current.signature !== prior.signature) {
        since = Date.now();
        prior = current;
      }
      return Date.now() - since >= 75 ? current : null;
    }, timeout);
  }

  const geometry = box => [box.left, box.top, box.right, box.bottom].map(position => Math.round(position * 2));
  const interactionState = node => {
    const style = getComputedStyle(node);
    const animating = node.getAnimations?.().some(animation => animation.playState === "running" &&
      Number.isFinite(animation.effect?.getComputedTiming().endTime));
    return animating || style.pointerEvents === "none" || style.opacity === "0" || node.getAttribute("aria-busy") === "true"
      ? null : [style.opacity, ...geometry(node.getBoundingClientRect())];
  };
  const owns = menu => {
    const openMenus = menus();
    return openMenus.length === 1 && openMenus[0] === menu;
  };

  async function readyOptions(control, menu, { allowEmpty = false } = {}) {
    return settle(() => {
      const current = owns(menu) ? menu : associatedMenu(control);
      if (!current || !owns(current)) return null;
      const states = menuShells(current).map(interactionState);
      if (states.includes(null)) return null;
      const rows = choices(current, control.field);
      if (!allowEmpty && !rows.length) return null;
      return { node: current, rows, signature: JSON.stringify([states, rows.map(({ value, label, disabled }) => [value, label, disabled])]) };
    });
  }

  function associatedMenu({ input, wrapper }) {
    const openMenus = menus();
    const ids = [input, input.closest(HEAD), wrapper].flatMap((node) =>
      clean(node?.getAttribute("aria-controls") || node?.getAttribute("aria-owns")).split(/\s+/)).filter(Boolean);
    const associated = openMenus.filter(menu => wrapper.contains(menu) ||
      ids.some(id => menu.id === id || document.getElementById(id)?.contains(menu)));
    if (associated.length) return associated.length === 1 ? associated[0] : null;
    return !ids.length && openMenus.length === 1 && (wrapper.contains(document.activeElement) || popupFor(openMenus[0]).contains(document.activeElement))
      ? openMenus[0] : null;
  }

  async function open(control) {
    if (!validPage() || blocked() || !control?.input?.isConnected) return null;
    if (menus().length && !await poll(() => !menus().length, 400)) return null;
    if (!control.input.isConnected || !visible(control.input)) return null;
    const { input, wrapper } = control;
    const boundary = input.closest(HEAD) || wrapper;
    const rect = boundary.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (rect.width && rect.height && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight &&
      typeof document.elementFromPoint === "function") {
      const hit = document.elementFromPoint(x, y);
      if (hit && !wrapper.contains(hit) && !hit.contains(wrapper)) return null;
    }
    const findMenu = () => associatedMenu(control);
    input.focus({ preventScroll: true });
    let menu = findMenu();
    if (!menu) menu = await poll(findMenu, 100);
    if (!menu && !menus().length && validPage() && !blocked()) {
      input.click();
      menu = await poll(findMenu, 350);
    }
    if (!menu && !menus().length && validPage() && !blocked()) {
      const head = input.closest(HEAD);
      if (head && head.closest(WRAPPER) === wrapper) {
        head.click();
        menu = await poll(findMenu, 1400);
      }
    }
    return menu;
  }

  async function close(control, menu) {
    if (!validPage() || !menu || !menuVisible(menu)) return true;
    const ownsMenu = () => {
      if (!validPage() || blocked()) return false;
      return owns(menu);
    };
    if (!ownsMenu()) return false;
    const input = control.input;
    const active = document.activeElement;
    if (control.wrapper.contains(active) || popupFor(menu).contains(active)) {
      active.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      if (ownsMenu()) active.blur();
      if (await poll(() => !menuVisible(menu), 100)) return true;
    }
    // The active field label is outside the portal and uses its normal outside-press handling.
    for (const outside of outsideTargets(control, menu)) {
      if (!ownsMenu()) break;
      const rect = outside.getBoundingClientRect();
      const eventOptions = { bubbles: true, cancelable: true, composed: true,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
      const Pointer = globalThis.PointerEvent || MouseEvent;
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        if (!ownsMenu()) break;
        const EventType = type.startsWith("pointer") ? Pointer : MouseEvent;
        outside.dispatchEvent(new EventType(type, { ...eventOptions, pointerType: "mouse", isPrimary: true }));
        await wait(0);
      }
      if (await poll(() => !menuVisible(menu), 120)) return true;
    }
    if (ownsMenu()) {
      const sink = document.createElement("span");
      sink.tabIndex = -1;
      sink.style.cssText = "position:fixed;width:0;height:0;top:0;left:0;pointer-events:none";
      document.body.append(sink);
      try {
        sink.focus({ preventScroll: true });
        await wait(0);
      } finally {
        sink.remove();
      }
    }
    if (menuVisible(menu)) await poll(() => !menuVisible(menu), 220);
    if (ownsMenu()) {
      const head = input.closest(HEAD);
      if (head?.closest(WRAPPER) === control.wrapper && visible(head)) {
        head.click();
        await poll(() => !menuVisible(menu), 180);
      }
    }
    return !menuVisible(menu);
  }

  function exactAliases(field, value) {
    const groups = /^(?:季节(?:\s*season)?|season)$/iu.test(field.label) ? [
      ["春", "春季", "Spring"], ["夏", "夏季", "Summer"], ["秋", "秋季", "Autumn", "Fall"], ["冬", "冬季", "Winter"],
    ] : /^(?:门襟类型(?:\s*placket\s*type)?|placket\s*type)$/iu.test(field.label) ? [
      ["套头", "套头衫", "Pullover", "Pullovers"],
    ] : /^composition-material-\d+$/u.test(field.key) ? [
      ["聚酯纤维", "涤纶", "Polyester"], ["氨纶", "Spandex", "Elastane"],
    ] : [];
    return groups.find(group => group.some(alias => key(alias) === key(value))) || [];
  }

  function choices(menu, field) {
    return [...menu.querySelectorAll(OPTION)].filter(element => visible(element) && !menu.contains(element.parentElement.closest(OPTION))).map(element => {
      const { primary, translation } = materialLabelParts(element);
      const rendered = clean(element.textContent, 500);
      const label = primary || rendered;
      const value = clean(element.getAttribute("data-value") || element.getAttribute("value") || rendered, 1000);
      const normalized = label.normalize("NFKC");
      const parts = /^([\p{Script=Han}\d\s]+?(?:\([\p{Script=Han}\d\s]+\))?)\s*[(\[]?([a-z][a-z\d\s?'’/-]*?)[)\]]?$/iu.exec(normalized);
      const qualified = /^([\p{Script=Han}\d\s]+?)\s*\([\p{Script=Han}\d\s]+\)$/u.exec(parts?.[1] || normalized);
      const childLabels = Array.from(element.querySelectorAll("span,[aria-label]"))
        .map((node) => clean(node.getAttribute("aria-label") || node.textContent));
      const skuTitle = field.skuMember === "productSkuMultiPack.skuClassification" &&
        /^(单品|同款多件装|混合套装)/u.exec(rendered)?.[1];
      const names = [element.getAttribute("aria-label"), rendered, ...(parts?.slice(1) || []), qualified?.[1], translation, skuTitle, ...childLabels];
      const aliases = [...new Set([...names, ...[label, ...names].flatMap(name => exactAliases(field, name))])]
        .map(alias => clean(alias)).filter(alias => alias && key(alias) !== key(label)).slice(0, 16);
      const status = element.getAttribute("data-checked") ?? element.getAttribute("aria-selected");
      const disabled = element.matches('[data-disabled="true"],[aria-disabled="true"],[disabled],a[href]') ||
        Boolean(element.querySelector('a[href]'));
      return { element, label, rendered, value, aliases, status, disabled };
    }).filter((entry) => entry.label);
  }

  function observed(control, menu, rows = choices(menu, control.field)) {
    const multiple = control.field.constraints.multiple || menu.getAttribute("aria-multiselectable") === "true";
    return {
      ...control.field,
      multiple,
      constraints: { ...control.field.constraints, ...(multiple ? { multiple: true } : {}) },
      options: rows.slice(0, MAX_OPTIONS).map(({ label, value, aliases, disabled }) =>
        ({ label, value, ...(aliases.length && { aliases }), ...(disabled && { disabled }) })),
    };
  }

  function matchingOptions(rows, value) {
    const normalized = key(value);
    for (const name of ["value", "rendered", "label"]) {
      const exact = rows.filter(entry => key(entry[name]) === normalized);
      if (exact.length) return exact;
    }
    return rows.filter(entry => entry.aliases.some(alias => key(alias) === normalized));
  }

  function pickOption(rows, value) {
    const matches = matchingOptions(rows, value);
    return matches.length === 1 && !matches[0].disabled ? matches[0] : null;
  }

  function searchInput(control, menu) {
    const popup = popupFor(menu);
    const editableInputs = node => [...node.querySelectorAll("input")].filter(input =>
      visible(input) && editable(input) && !input.readOnly && !input.closest(OPTION));
    const inputs = editableInputs(popup);
    if (inputs.length) return inputs.length === 1 ? inputs[0] : null;
    const inline = editableInputs(control.wrapper);
    return inline.length === 1 ? inline[0] : null;
  }

  async function search(control, menu, query, expected) {
    const input = searchInput(control, menu);
    const active = () => {
      if (!validPage() || blocked() || menus().length !== 1) return null;
      return owns(menu) ? menu : associatedMenu(control);
    };
    if (!input || !validPage() || blocked() || menus().length !== 1) return null;
    if (input.value === query) return menu;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!set) return null;
    const signature = (rows) => JSON.stringify(rows.map(({ label, value }) => [label, value]));
    const before = signature(choices(menu, control.field));
    input.focus({ preventScroll: true });
    set.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    let previous = before;
    let since = Date.now();
    const settled = await poll(() => {
      const current = active();
      if (!current) return null;
      const rows = choices(current, control.field);
      if (expected !== undefined && pickOption(rows, expected)) return current;
      const next = signature(rows);
      if (previous !== next) {
        previous = next;
        since = Date.now();
      }
      return next !== before && Date.now() - since >= 160 ? current : null;
    }, expected !== undefined ? 1000 : 1250);
    return settled || active();
  }

  async function probe(control, query) {
    let menu = await open(control);
    if (!menu) return fail("MENU_UNAVAILABLE", "无法安全打开该下拉选项列表。");
    let result;
    let closed;
    try {
      const term = clean(query, 120);
      const initial = await readyOptions(control, menu, { allowEmpty: Boolean(term) });
      if (initial) menu = initial.node;
      let ready = initial;
      if (term && initial) {
        const searched = await search(control, menu, term);
        if (searched) {
          menu = searched;
          ready = await readyOptions(control, menu, { allowEmpty: true });
        } else {
          ready = null;
          result = fail("SEARCH_UNAVAILABLE", "该下拉没有可安全输入的搜索框。");
        }
      }
      if (ready) menu = ready.node;
      if (!validPage()) result = fail("PAGE_CHANGED", "当前 Temu 商品草稿已变化。");
      else if (blocked()) result = fail("MODAL_BLOCKED", "Temu 表单上有弹窗，请核对后继续。");
      else if (!result) {
        if (!ready) result = fail("OPTIONS_NOT_READY", "Temu 下拉选项尚未完成加载。");
        else {
          const field = observed(control, menu, ready.rows);
          result = { ok: true, field, options: field.options, ...(term && { filtered: true }) };
        }
      }
    } finally {
      closed = await close(control, menu);
    }
    return closed || result?.code === "MODAL_BLOCKED" ? result : fail("MENU_STILL_OPEN", "Temu 的选项菜单尚未关闭。");
  }

  function checkValues(field, value) {
    const multiple = Boolean(field.constraints.multiple);
    const values = Array.isArray(value) ? value : [value];
    if ((!multiple && values.length !== 1) || values.some((item) => (typeof item !== "string" && typeof item !== "number") || !key(item)) ||
      values.length > MAX_OPTIONS || new Set(values.map(key)).size !== values.length) {
      return fail("INPUT_TYPE", multiple ? "此多选下拉需要不重复的选项数组。" : "此下拉需要一个选项名称或选项值。");
    }
    if (!values.length && field.constraints.required) return fail("INPUT_REQUIRED", "当前下拉至少需要一个选项。");
    return { ok: true, values, multiple };
  }

  async function select(control, field, value, query) {
    let menu = await open(control);
    if (!menu) return fail("MENU_UNAVAILABLE", "无法安全打开该下拉选项列表。");
    let changed = false;
    let live = control;
    let ambiguous = [];
    const same = (first, second) => key(first.value) === key(second.value) && key(first.label) === key(second.label);
    const selected = (rows) => rows.filter((row) => row.status === "true" || row.status === "checked");
    const matchesLabel = (value, option) => key(value) === key(option.label) || option.aliases.some(alias => key(value) === key(alias));
    const labelsMatch = (values, expected) => values.length === expected.length &&
      new Set(values.map(value => {
        const matches = expected.filter(option => matchesLabel(value, option));
        return matches.length === 1 ? matches[0] : null;
      }).filter(Boolean)).size === expected.length;
    let result;
    let closed;
    try {
      result = await apply();
    } finally {
      closed = await close(live || control, menu);
    }
    if (!validPage() || blocked()) return fail("PAGE_CHANGED", "页面或弹窗发生变化，请检查填写结果。", changed);
    if (!closed) return fail("MENU_STILL_OPEN", "Temu 的选项菜单尚未关闭。", changed);
    return result?.ok ? { ...result, options: result.observed.options } : result;

    async function find(value, term = value, known) {
      ambiguous = [];
      const option = rows => {
        const matches = known ? rows.filter(row => same(row, known)) : matchingOptions(rows, value);
        if (matches.length > 1) ambiguous = matches;
        return matches.length === 1 && !matches[0].disabled ? matches[0] : null;
      };
      if (!validPage() || blocked()) return null;
      if (!menuVisible(menu)) {
        live = locate(field);
        menu = live && await open(live);
      }
      if (!menu) return null;
      const direct = option(choices(menu, field));
      if (direct || ambiguous.length) return direct;
      if (!query && !/^(?:productProperties\[\d+\]|composition-material-\d+)$/u.test(field.key)) return null;
      const terms = new Set([term, ...exactAliases(field, value)].map(item => clean(item, 120)).filter(Boolean));
      for (const candidate of terms) {
        const searched = await search(live, menu, candidate, value);
        if (!searched) return null;
        menu = searched;
        const match = option(choices(menu, field));
        if (match || ambiguous.length) return match;
      }
      return null;
    }

    function clipped({ element }) {
      const rect = element.getBoundingClientRect();
      const viewport = menu.getBoundingClientRect();
      return (rect.height && (rect.top < Math.max(0, viewport.top) || rect.bottom > Math.min(innerHeight, viewport.bottom))) ||
        (rect.width && (rect.left < Math.max(0, viewport.left) || rect.right > Math.min(innerWidth, viewport.right)));
    }

    async function readyToClick(choice, term) {
      const current = await find(choice.value, term, choice);
      if (!current) return null;
      if (clipped(current)) current.element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      return settle(() => {
        if (!owns(menu)) return null;
        const matches = choices(menu, field).filter(row => same(row, choice));
        if (matches.length !== 1 || matches[0].disabled) return null;
        const [option] = matches;
        const states = [...menuShells(menu), option.element].map(interactionState);
        if (states.includes(null)) return null;
        const rect = option.element.getBoundingClientRect();
        if (rect.width && rect.height && typeof document.elementFromPoint === "function") {
          const viewport = menu.getBoundingClientRect();
          const left = Math.max(0, rect.left, viewport.left);
          const right = Math.min(innerWidth, rect.right, viewport.right);
          const top = Math.max(0, rect.top, viewport.top);
          const bottom = Math.min(innerHeight, rect.bottom, viewport.bottom);
          if (left >= right || top >= bottom) return null;
          const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
          if (!hit || !option.element.contains(hit)) return null;
        } else if (clipped(option)) return null;
        return { node: option.element, option, signature: JSON.stringify([states, option.value, option.label]) };
      }, 1200);
    }

    function currentSelection(choice) {
      const control = locate(field);
      if (!control) return null;
      live = control;
      const labels = readSelected(live.wrapper);
      const matches = owns(menu) ? choices(menu, field).filter(row => same(row, choice)) : [];
      return { labels, status: matches.length === 1 ? matches[0].status : null,
        present: labels.some(label => matchesLabel(label, choice)) };
    }

    async function applyChoice(choice, term, wanted, multiple) {
      const ready = await readyToClick(choice, term);
      if (!ready) return fail("OPTION_NOT_READY", "Temu 下拉选项还不可点击或已变化。", changed);
      const before = currentSelection(choice);
      if (!before) return fail("FIELD_MISSING", "填写前无法重新定位此字段。", changed);
      const checked = status => status === "true" || status === "checked";
      const unchecked = status => status === "false" || status === "unchecked";
      const initialLabels = JSON.stringify(before.labels);
      const waitForSelected = () => settle(() => {
        const actual = currentSelection(choice);
        if (!actual) return null;
        const labelChanged = JSON.stringify(actual.labels) !== initialLabels;
        const confirmed = wanted ? checked(actual.status) || actual.present && labelChanged :
          unchecked(actual.status) || before.present && !actual.present;
        return confirmed && { node: live.wrapper, signature: JSON.stringify([actual.labels, actual.status]) };
      }, 850);
      ready.node.click();
      changed = true;
      if (await waitForSelected()) return { ok: true };
      const unchanged = currentSelection(choice);
      // A multiselect click toggles the option. Only retry a single value which is still visibly unchecked.
      if (!multiple && wanted && unchanged && !unchanged.present && unchecked(unchanged.status) &&
          JSON.stringify(unchanged.labels) === initialLabels) {
        const retry = await readyToClick(choice, term);
        const state = retry && currentSelection(choice);
        if (state && !state.present && unchecked(state.status) && JSON.stringify(state.labels) === initialLabels) {
          retry.node.click();
        }
        if (await waitForSelected()) return { ok: true };
      }
      return fail("READBACK_MISMATCH", `Temu 未确认「${choice.label}」的选中状态。`, changed);
    }

    async function apply() {
      const ready = await readyOptions(control, menu);
      if (!ready) return fail("OPTIONS_NOT_READY", "Temu 下拉选项尚未完成加载。");
      menu = ready.node;
      const rows = ready.rows;
      const snapshot = observed(control, menu, rows);
      const checked = checkValues(snapshot, value);
      if (!checked.ok) return checked;
      const desired = [];
      for (const item of checked.values) {
        ambiguous = matchingOptions(rows, item);
        const choice = ambiguous.length > 1 ? null :
          pickOption(rows, item) || await find(item, checked.multiple ? item : clean(query, 120) || item);
        if (ambiguous.length > 1) {
          const alternatives = ambiguous.slice(0, 4).map(({ rendered, value }) => `「${rendered}」[${value}]`).join("、");
          return fail("OPTION_AMBIGUOUS", `匹配到多个选项，请提供完整名称或选项值。可用项 ${alternatives}`);
        }
        if (!choice || desired.some(earlier => same(earlier, choice))) {
          return fail("OPTION_MISSING", `当前下拉没有唯一匹配「${clean(query, 80) || clean(item, 80)}」的选项。`);
        }
        desired.push(choice);
      }
      if (!checked.multiple && labelsMatch([control.field.value], desired) &&
          rows.filter(row => matchesLabel(control.field.value, row)).length === 1) {
        return { ok: true, status: "unchanged", observed: snapshot };
      }
      const prior = selected(rows);
      const chips = checked.multiple ? readSelected(control.wrapper) : [];
      for (const chip of chips) {
        const visibleChoices = rows.filter(row => matchesLabel(chip, row));
        const choice = (visibleChoices.length === 1 && visibleChoices[0]) || await find(chip);
        if (!choice) return fail("SELECTION_UNVERIFIED", "无法核对已选项，需要手动确认。");
        if (!prior.some(row => same(row, choice))) prior.push(choice);
      }
      if (checked.multiple && !chips.length && rows.some((row) => row.status == null)) {
        return fail("SELECTION_UNVERIFIED", "此多选下拉没有公开可读的选中状态，需要手动确认。");
      }
      if (prior.length === desired.length && desired.every((choice) => prior.some((row) => same(choice, row)))) {
        return { ok: true, status: "unchanged", observed: snapshot };
      }
      const unwanted = checked.multiple ? prior.filter((row) => !desired.some((choice) => same(row, choice))) : [];
      if (unwanted.some((row) => row.disabled)) return fail("OPTION_DISABLED", "当前包含无法取消的选项。");
      const wanted = desired.filter((row) => !prior.some((choice) => same(row, choice)));
      for (const choice of [...wanted, ...unwanted]) {
        const term = clean(query, 120) && !checked.multiple ? query : choice.aliases[0] || choice.label;
        const outcome = await applyChoice(choice, term, wanted.includes(choice), checked.multiple);
        if (!outcome.ok) return outcome;
      }
      if (!validPage() || blocked()) return fail("PAGE_CHANGED", "页面或弹窗发生变化，请检查填写结果。", changed);
      live = locate(field);
      if (!live) return fail("READBACK_MISMATCH", "选择后无法重新定位此字段。", changed);
      if (await poll(() => {
        live = locate(field) || live;
        return labelsMatch(readSelected(live.wrapper), desired);
      }, 400)) {
        return { ok: true, status: "filled", observed: snapshot };
      }
      if (!menuVisible(menu)) menu = await open(live);
      const verified = menu && await poll(() => {
        const actual = selected(choices(menu, field));
        return actual.length === desired.length && desired.every((option) => actual.some((row) => same(option, row)));
      }, 900);
      if (!verified) return fail("READBACK_MISMATCH", "平台未确认目标选项，请检查下拉当前值。", changed);
      return { ok: true, status: "filled", observed: snapshot };
    }
  }

  if (!validPage()) return fail("PAGE_CHANGED", "当前 Temu 商品草稿已变化。");
  if (!document.body || blocked()) return fail("MODAL_BLOCKED", "目标表单未就绪或有弹窗遮挡。");
  if (request.kind === "inspect") {
    const { controls, unsupported, truncated } = scan();
    return { ok: true, fields: controls.map(({ field }) => field), unsupported, truncated };
  }

  const { field, value, query } = request;
  const control = locate(field);
  if (!control) return fail("FIELD_MISSING", "无法在当前 Temu 表单唯一定位这个下拉控件。");
  if (request.kind === "probe") return probe(control, query);
  if (request.kind === "select") return select(control, field, value, query);
  return fail("ACTION_UNSUPPORTED", "无效的 Temu 控件操作。");
}

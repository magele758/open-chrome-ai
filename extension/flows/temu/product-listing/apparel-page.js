/** The apparel editor renders SKC colors separately from its size selector. */
export async function temuApparelPage({ href, kind, key, value, alternate, allowOpened = false }) {
  const onPage = () => window === window.top && location.origin === "https://agentseller.temu.com" &&
    location.pathname === "/goods/edit" && location.href === href;
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length &&
    !node.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(node).visibility !== "hidden");
  const clean = value => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const sizeLabel = candidate => clean(candidate).replace(/\s*HOT$/iu, "").trim().toUpperCase();
  const sizeAliases = {
    EXTRASMALL: "XS", XSMALL: "XS", SMALL: "S", MEDIUM: "M", LARGE: "L",
    EXTRALARGE: "XL", XLARGE: "XL", XXLARGE: "2XL", "2XLARGE": "2XL", XXL: "2XL",
    XXXLARGE: "3XL", "3XLARGE": "3XL", XXXL: "3XL", XXXXLARGE: "4XL", "4XLARGE": "4XL", XXXXL: "4XL",
  };
  const sizeKey = candidate => {
    const label = sizeLabel(candidate);
    const compact = label.replace(/[\s-]+/gu, "");
    return Object.hasOwn(sizeAliases, compact) ? sizeAliases[compact] : label;
  };
  const blocked = () => [...document.querySelectorAll('[class*="MDL_inner_"],dialog[open],[role="alertdialog"],[aria-modal="true"]')].some(visible);
  const fail = (code, message) => ({ ok: false, code, message });
  const root = document.getElementById("page_container_id");
  const colorSelector = '[id^="productSkcList["][id$=".mainSpec[0]"]';
  const emptyColor = "选择或自定义颜色";
  const colorField = holder => {
    const inputs = [...holder?.querySelectorAll('input') || []].filter(node => visible(node) && /^(?:text|search)$/u.test(node.type));
    const exact = inputs.filter(node => node.placeholder === emptyColor);
    return exact.length === 1 ? exact[0] : !exact.length && inputs.length === 1 ? inputs[0] : null;
  };
  const colorComponent = '[class*="colour-spec-select_colorSpecSelect__"]';
  const colorPopover = '[class*="colour-spec-select_allItemContainer__"],[class*="colour-spec-select_searchContainer__"]';
  const colorOption = '[class*="colour-spec-select_selectItem__"]';
  const triggerSelector = '[class*="ST_head_"],[data-testid="beast-core-popover-trigger-wrapper"]';
  const colorWrapper = input => input?.closest(colorComponent) || input?.closest('[class*="ST_outerWrapper_"]');
  const visiblePopup = node => {
    if (!visible(node)) return false;
    const host = node.closest('[data-testid="beast-core-portal"]') || node;
    return [node, host].every(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (style.opacity || "1") !== "0" && style.pointerEvents !== "none" &&
        (!rect.width || !rect.height || rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth);
    });
  };
  const standardMenus = () => {
    const listboxes = [...document.querySelectorAll('[role="listbox"]')].filter(visiblePopup);
    const fallbacks = [...document.querySelectorAll('[class*="ST_dropdown_"]')].filter(menu => visiblePopup(menu) &&
      menu.querySelector('[role="option"],[data-testid="beast-core-select-option"]') && !listboxes.some(listbox => menu.contains(listbox)));
    return [...listboxes, ...fallbacks.filter(menu => !fallbacks.some(parent => parent !== menu && parent.contains(menu)))];
  };
  const nativeMenus = () => [...document.querySelectorAll(colorPopover)].filter(menu =>
    visiblePopup(menu) && (menu.closest('[data-testid="beast-core-portal"]') || root?.contains(menu)));
  const holders = () => [...root?.querySelectorAll(colorSelector) || []].filter(holder => visible(holder) &&
    /^productSkcList\[\d{1,3}\]\.mainSpec\[0\]$/u.test(holder.id) &&
    (colorField(holder)?.placeholder === emptyColor || selectedColor(holder)));
  const selectedColor = holder => {
    const input = colorField(holder);
    const selected = [...holder.querySelectorAll('[class*="ST_selectValueSingle_"]')].find(visible);
    if (selected) return clean(selected.textContent);
    if (!colorWrapper(input)) return clean(input?.value);
    // Temu changes this prompt to the saved color when a custom value is accepted.
    const prompt = clean(input.placeholder);
    return prompt && ![emptyColor, "请选择", "请选择颜色", "请输入"].includes(prompt) &&
      (!input.value || clean(input.value) === prompt) ? prompt : "";
  };
  const rows = () => holders().map(holder => ({
    key: holder.id,
    value: selectedColor(holder),
  }));
  const target = () => holders().find(row => row.id === key);
  const findAnchor = () => {
    const holder = target();
    const input = colorField(holder);
    const wrapper = colorWrapper(input);
    if (!wrapper || !input || input.disabled || input.closest('[aria-disabled="true"],[data-disabled="true"]')) return null;
    return { holder, input, wrapper, trigger: input.closest(triggerSelector) };
  };

  if (kind === "dismiss-size-tip") return dismissSizeTip();
  if (!onPage() || blocked()) return fail("PAGE_CHANGED", "Temu 服装规格页已切换或有弹窗。");
  if (["composition-inspect", "composition-add", "composition-percentage"].includes(kind)) return composition();
  if (kind === "set-sizes" || kind === "inspect-sizes") return setSizes();
  if (kind === "select-size-chart" || kind === "create-size-chart") return selectChart();
  if (kind === "inspect") return { ok: true, rows: rows() };
  if (kind === "color-target") return colorTarget();
  if (kind === "set-color") return setColor();
  if (kind !== "add-color") return fail("ACTION_UNSUPPORTED", "此操作不属于服装规格试填。");
  const before = holders();
  if (!before.length || before.length >= 20) return fail("SPEC_VALUES_NOT_RENDERED", "当前服装颜色表缺失或已达到试填上限。");
  const first = before[0];
  for (let area = first.parentElement, depth = 0; area && area !== root && depth < 10; area = area.parentElement, depth++) {
    const links = [...area.querySelectorAll('[class^="product-skc_specItem__"] a,a[class^="product-skc_specItem__"]')].filter(node => visible(node) &&
      !node.matches('[disabled],[aria-disabled="true"]') && /^\+\s*添加$/u.test(clean(node.textContent)) &&
      (!node.hasAttribute("href") || node.getAttribute("href") === "#"));
    if (links.length > 1) return fail("SPEC_VALUES_NOT_RENDERED", "服装颜色表内有多个添加入口。");
    if (links.length === 1 && before.every(holder => area.contains(holder))) {
      links[0].click();
      const deadline = Date.now() + 2200;
      do {
        if (!onPage() || blocked()) return fail("PAGE_CHANGED", "服装颜色页已切换。");
        const after = rows();
        if (after.length === before.length + 1 && after.some(row => !before.some(holder => holder.id === row.key))) {
          return { ok: true, status: "verified", rows: after };
        }
        await new Promise(resolve => setTimeout(resolve, 60));
      } while (Date.now() < deadline);
      break;
    }
  }
  return fail("SPEC_VALUES_NOT_RENDERED", "添加后没有出现新的服装颜色行。");

  async function colorTarget() {
    const anchor = findAnchor();
    const resting = current => current?.wrapper.matches(colorComponent) && !selectedColor(current.holder) &&
      current.input.placeholder === emptyColor && !clean(current.input.value);
    const menuOpen = () => standardMenus().length || nativeMenus().length;
    if (menuOpen()) return fail("MENU_STILL_OPEN", "存在下拉选项打开，请关闭后再选择颜色。");
    if (!resting(anchor)) return fail("SPEC_CONTROL_MISSING", "当前颜色行没有可安全点按的空白输入框。");
    anchor.input.scrollIntoView?.({ block: "center", inline: "nearest" });
    let previousPoint;
    const deadline = Date.now() + 600;
    do {
      if (!onPage() || blocked()) return fail("PAGE_CHANGED", "准备点按服装颜色时页面已切换。");
      if (menuOpen()) return fail("MENU_STILL_OPEN", "存在下拉选项打开，请关闭后再选择颜色。");
      const current = findAnchor();
      if (!resting(current)) return fail("SPEC_CONTROL_MISSING", "当前颜色行的输入框已变化。");
      const rect = current.input.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (rect.width && rect.height && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight &&
          (typeof document.elementFromPoint !== "function" || document.elementFromPoint(x, y) === current.input)) {
        if (previousPoint?.x === x && previousPoint.y === y && previousPoint.input === current.input) return { ok: true, x, y };
        previousPoint = { x, y, input: current.input };
      } else previousPoint = undefined;
      await new Promise(resolve => setTimeout(resolve, 40));
    } while (Date.now() < deadline);
    return fail("SPEC_CONTROL_MISSING", "颜色输入框被遮挡或仍在视口外。");
  }

  async function setColor() {
    if (typeof value !== "string" || !clean(value) || value.length > 80) return fail("VALUE_INVALID", "颜色值为空或超过长度限制。");
    const holder = target();
    const input = colorField(holder);
    if (!holder) return fail("SPEC_CONTROL_MISSING", "服装颜色输入已变化。");
    const wanted = clean(value);
    const alternateLabel = typeof alternate === "string" && alternate.length <= 80 ? clean(alternate) : "";
    const prior = selectedColor(holder);
    if (prior && (prior === wanted || prior === alternateLabel)) return { ok: true, status: "unchanged", value: prior };
    if (prior) return fail("SPEC_VALUES_OCCUPIED", "目标服装颜色行已有内容。");
    if (!input || input.disabled) return fail("SPEC_CONTROL_MISSING", "服装颜色输入已变化。");
    if (input.maxLength > 0 && value.length > input.maxLength) return fail("VALUE_INVALID", "颜色值超过 Temu 字数限制。");

    const setText = (control, text) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set.call(control, text);
      control.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      if (control.isConnected && onPage()) control.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const wrapper = colorWrapper(input);
    if (allowOpened && !wrapper?.matches(colorComponent)) return fail("SPEC_CONTROL_MISSING", "当前颜色行已变化。");
    let committed = wanted;
    if (wrapper) {
      const picked = await pickColor();
      if (!picked.ok) return picked;
      committed = picked.value;
    } else {
      if (input.readOnly) return fail("SPEC_CONTROL_MISSING", "服装颜色输入已变化。");
      input.focus();
      setText(input, value);
      input.blur();
    }
    const deadline = Date.now() + 1900;
    let sawCommit = false;
    do {
      if (!onPage() || blocked()) return fail("PAGE_CHANGED", "填写服装颜色时页面已切换。");
      const current = target();
      const field = colorField(current);
      if (current && selectedColor(current) === committed &&
          field?.getAttribute("aria-invalid") !== "true" && field?.validity?.valid !== false) {
        if (sawCommit) return { ok: true, status: "filled", value: committed };
        sawCommit = true;
      } else sawCommit = false;
      await new Promise(resolve => setTimeout(resolve, 80));
    } while (Date.now() < deadline);
    return fail("READBACK_MISMATCH", "Temu 未保留输入的服装颜色。");

    async function pickColor() {
      const nativePopover = wrapper.matches(colorComponent);
      const menus = () => (nativePopover ? nativeMenus() : standardMenus()).filter(menu =>
        (target()?.contains(menu) || menu.closest('[data-testid="beast-core-portal"],[class*="ST_dropdown_"]')));
      let trustedMenu;
      const related = () => {
        const anchor = findAnchor();
        const visibleMenus = menus();
        if (!anchor || visibleMenus.length !== 1) return null;
        const ids = [anchor.input, anchor.trigger, anchor.wrapper].flatMap(node =>
          clean(node?.getAttribute("aria-controls") || node?.getAttribute("aria-owns")).split(/\s+/u)).filter(Boolean);
        const [menu] = visibleMenus;
        const owned = anchor.holder.contains(menu) || ids.some(id => menu.id === id || document.getElementById(id)?.contains(menu));
        if (allowOpened) {
          if (!nativePopover || standardMenus().some(other => other !== menu && !menu.contains(other) && !other.contains(menu))) return null;
          const active = document.activeElement;
          if (!anchor.wrapper.contains(active) && !((owned || trustedMenu === menu) && menu.contains(active))) return null;
          trustedMenu = menu;
          return menu;
        }
        // The color-specific portal was absent before opening this single pinned row.
        return owned || nativePopover || !ids.length &&
          (anchor.holder.contains(document.activeElement) || menu.contains(document.activeElement)) ? menu : null;
      };
      let menu;
      if (allowOpened) {
        menu = await waitFor(related, 1250);
        if (!menu && menus().length) return fail("MENU_STILL_OPEN", "无法确认已打开的颜色菜单属于当前行。");
      } else {
        if (!await waitFor(() => !menus().length && (!nativePopover || !standardMenus().length), 600)) {
          return fail("MENU_STILL_OPEN", "页面已有下拉选项打开。");
        }
        input.focus({ preventScroll: true });
        menu = await waitFor(related, 180);
        if (!menu && !menus().length && onPage() && !blocked()) {
          const anchor = findAnchor();
          (anchor?.trigger || anchor?.input)?.click();
          menu = await waitFor(related, 650);
        }
        if (!menu && !menus().length && onPage() && !blocked()) {
          const anchor = findAnchor();
          if (anchor?.trigger && anchor.input) anchor.input.click();
          menu = await waitFor(related, 800);
        }
      }
      if (!onPage() || blocked()) return fail("PAGE_CHANGED", "填写服装颜色时页面已切换。");
      if (!menu) return fail("COLOR_MENU_UNAVAILABLE", "Temu 没有打开当前服装颜色的选项列表。");

      function exactChoice() {
        const menu = related();
        const options = [...menu?.querySelectorAll(nativePopover ? colorOption :
          '[role="option"],[data-testid="beast-core-select-option"]') || []].filter(visible);
        for (const label of new Set([wanted, ...(alternateLabel ? [alternateLabel] : [])])) {
          const matches = options.filter(node => clean(node.textContent) === label);
          if (!matches.length) continue;
          if (matches.length !== 1) return false;
          const option = matches[0];
          if (!option.matches('[aria-disabled="true"],[data-disabled="true"],[disabled],a[href]') && !option.querySelector('a[href]')) {
            option.click();
            return { ok: true, value: label, selectedMenu: menu };
          }
          return false;
        }
        return null;
      }
      async function search(label, timeout) {
        const currentMenu = related();
        const editable = control => visible(control) && !control.readOnly && !control.disabled && /^(?:text|search)$/u.test(control.type);
        const inputs = [...currentMenu?.querySelectorAll("input") || []].filter(editable);
        const editor = inputs.length === 1 ? inputs[0] : !inputs.length && findAnchor()?.input;
        if (editor && editable(editor) && onPage() && !blocked()) {
          editor.focus({ preventScroll: true });
          if (editor.value !== label) setText(editor, label);
        }
        const until = Date.now() + timeout;
        do {
          if (!onPage() || blocked()) return fail("PAGE_CHANGED", "填写服装颜色时页面已切换。");
          const found = exactChoice();
          if (found !== null) return found;
          await new Promise(resolve => setTimeout(resolve, 60));
        } while (Date.now() < until);
        return null;
      }

      async function waitFor(find, timeout) {
        const deadline = Date.now() + timeout;
        do {
          if (!onPage() || blocked()) return null;
          const resolved = find();
          if (resolved) return resolved;
          await new Promise(resolve => setTimeout(resolve, 35));
        } while (Date.now() < deadline);
        return null;
      }

      async function finish(pick) {
        if (!pick.ok) return pick;
        const portal = pick.selectedMenu?.closest('[data-testid="beast-core-portal"]');
        const sameMenu = () => menus().find(mode => mode === pick.selectedMenu || portal?.contains(mode));
        if (!await waitFor(() => !sameMenu(), 420) && menus().length === 1) {
          const label = [...root.querySelectorAll('th,[role="columnheader"]')].filter(element =>
            visible(element) && /^\*?\s*色值$/u.test(clean(element.textContent)) && !element.querySelector('input,button,a'));
          const outside = label.length === 1 && label[0];
          if (outside) for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
            if (!onPage() || blocked() || !sameMenu() || menus().length !== 1) break;
            const EventType = type.startsWith("pointer") ? globalThis.PointerEvent || MouseEvent : MouseEvent;
            outside.dispatchEvent(new EventType(type, { bubbles: true, cancelable: true, composed: true, pointerType: "mouse" }));
          }
        }
        if (!await waitFor(() => !sameMenu(), 650)) {
          return fail("MENU_STILL_OPEN", "已选色值，当前颜色菜单尚未收起。");
        }
        return { ok: true, value: pick.value };
      }
      let pick = alternateLabel ? await search(alternateLabel, 1000) : null;
      if (pick) return finish(pick);
      if (pick !== false) pick = await search(value, 1450);
      if (pick) return finish(pick);

      menu = related();
      const current = colorField(target());
      if (pick !== false && current && !current.readOnly && !current.disabled && current.placeholder === emptyColor &&
          clean(current.value) === wanted && onPage() && !blocked()) {
        current.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true }));
        current.blur();
        // Complete the click-away on the page without invoking another form control.
        const neutral = [...root.querySelectorAll('[class*="STP_stepsItemTitle_"]')]
          .filter(node => visible(node) && !node.childElementCount && clean(node.textContent) === "基本信息" &&
            !node.closest('a,button,input,label,[role="button"],[role="link"],[tabindex]'));
        const outside = neutral.length === 1 ? neutral[0] : document.body;
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          if (!onPage() || blocked()) return fail("PAGE_CHANGED", "确认自定义颜色时页面已切换。");
          const EventType = type.startsWith("pointer") ? globalThis.PointerEvent || MouseEvent : MouseEvent;
          outside.dispatchEvent(new EventType(type, { bubbles: true, cancelable: true, composed: true, pointerType: "mouse" }));
        }
        return { ok: true, value: wanted };
      }
      const active = document.activeElement;
      if (current && (findAnchor()?.wrapper.contains(active) || menu?.contains(active))) {
        active.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        active.blur();
      }
      if (visible(menu)) return fail("MENU_STILL_OPEN", "服装颜色下拉尚未关闭，请核对当前页。");
      return fail("SPEC_OPTION_MISSING", `Temu 没有唯一匹配的「${wanted}」颜色。`);
    }
  }

  function sizeTip() {
    const title = "【新功能】高合身率TOP商品";
    const isTitle = node => visible(node) && clean(node.textContent).replace(/\s+/gu, "") === title;
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(node => visible(node) &&
      clean(node.textContent) === "我知道了" && !node.disabled && !node.matches('[aria-disabled="true"],[data-disabled="true"]'));
    const matches = buttons.filter(node => {
      for (let area = node.parentElement, depth = 0; area && depth < 7 && !area.matches("body,main") && area !== root; area = area.parentElement, depth++) {
        if (buttons.some(other => other !== node && area.contains(other))) return false;
        const headings = [...area.querySelectorAll("h1,h2,h3,h4,[role=heading],span,div")].filter(isTitle);
        if (headings.length) return true;
      }
      return false;
    });
    return matches.length === 1 ? matches[0] : null;
  }

  async function dismissSizeTip() {
    if (!onPage()) return fail("PAGE_CHANGED", "Temu 商品草稿已变化。");
    const tip = sizeTip();
    if (!tip) return { ok: true, status: "unchanged" };
    tip.click();
    const deadline = Date.now() + 2800;
    let absent = 0;
    do {
      if (!onPage()) return fail("PAGE_CHANGED", "关闭尺码提示时 Temu 商品草稿已变化。");
      absent = sizeTip() ? 0 : absent + 1;
      if (absent >= 2) return { ok: true, status: "verified" };
      await new Promise(resolve => setTimeout(resolve, 75));
    } while (Date.now() < deadline);
    return fail("MODAL_BLOCKED", "尺码表新功能提示尚未关闭。");
  }

  async function selectChart() {
    const creating = kind === "create-size-chart";
    const name = clean(creating ? value?.name : value);
    const chart = creating && value;
    if (!name || name.length > 50 || (!creating && typeof value !== "string") || creating &&
        (chart.unit !== "cm" || !Array.isArray(chart.rows) || !chart.rows.length || chart.rows.length > 20)) {
      return fail("VALUE_INVALID", "需要提供准确的 Temu 尺码表模板名，手动录入时还需要厘米尺码数据。");
    }
    const exact = (scope, selector, name) => {
      const matches = [...scope?.querySelectorAll(selector) || []].filter(node => {
        const text = clean(node.textContent);
        return visible(node) && (name instanceof RegExp ? name.test(text) : text === name) &&
          !node.disabled && !node.matches('[aria-disabled="true"],[data-disabled="true"]');
      });
      return matches.length === 1 ? matches[0] : null;
    };
    const modalSelector = '[class*="MDL_inner_"],dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
    const modals = () => [...document.querySelectorAll(modalSelector)].filter(visible);
    const button = (scope, label) => exact(scope, 'button,[role="button"]', label);
    const heading = 'h1,h2,h3,[role="heading"],[class*="MDL_title_"],[class*="MDL_header_"]';
    function titledDialog(title, selector = heading) {
      const matches = modals().filter(node => [...node.querySelectorAll(selector)].some(label =>
        visible(label) && clean(label.textContent) === title));
      return matches.find(node => matches.every(other => other === node || other.contains(node))) || null;
    }
    const picker = () => titledDialog("选择尺码表模板", heading + ",span,div");
    let activeEditor;
    let activeTitle;
    const editor = () => {
      if (visiblePopup(activeEditor) && visiblePopup(activeTitle) && activeEditor.contains(activeTitle) &&
          clean(activeTitle.textContent) === "创建模板") return activeEditor;
      const drawerTitles = [...document.querySelectorAll(heading + ",span,div")].filter(node =>
        clean(node.textContent) === "创建模板" && !node.closest('a,button,[role="link"],[role="button"]') && visiblePopup(node));
      const editors = new Map();
      for (const title of drawerTitles) {
        for (let area = title.parentElement, depth = 0; area && depth < 8 && area !== root && !area.matches("main,body"); area = area.parentElement, depth++) {
          const actions = [...area.querySelectorAll('button,[role="button"]')].filter(visible).map(node => clean(node.textContent));
          if (["确认", "取消"].some(label => actions.filter(text => text === label).length !== 1)) continue;
          const labels = [...area.querySelectorAll("label,span,div")].filter(visible)
            .map(node => clean(node.textContent).replace(/^\*\s*/u, ""));
          if (["模板名称", "系统默认", "手动录入"].every(label => labels.includes(label))) {
            editors.set(area, title);
            break;
          }
        }
      }
      const matches = [...editors.keys()];
      activeEditor = matches.find(node => matches.every(other => other === node || other.contains(node))) || null;
      activeTitle = editors.get(activeEditor);
      return activeEditor;
    };
    const switcher = () => {
      const matches = modals().filter(node => {
        const message = clean(node.textContent).replace(/\s+/gu, "");
        return message.includes("确认切换填写方式?") && message.includes("切换后将清空原填写的尺码和参数信息") &&
          button(node, "确认") && button(node, "取消");
      });
      return matches.find(node => matches.every(other => other === node || other.contains(node))) || null;
    };
    const openMenu = () => standardMenus();
    async function waitFor(check, timeout = 2400) {
      const deadline = Date.now() + timeout;
      do {
        if (!onPage()) return null;
        const found = check();
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 60));
      } while (Date.now() < deadline);
      return null;
    }
    const target = button(root, /^\+?\s*添加尺码表$/u);
    if (!target) return attachedChart() ? fail("SIZE_CHART_ALREADY_ATTACHED", "页面已有尺码表，请核对现有模板。") :
      fail("SIZE_CHART_MISSING", "当前服装页没有可用的添加尺码表按钮。");
    if (openMenu().length) return fail("MENU_STILL_OPEN", "请关闭其他下拉后再添加尺码表。");
    target.click();
    const modal = await waitFor(picker);
    if (!modal) return fail("SIZE_CHART_MISSING", "未打开选择尺码表模板弹窗。");
    let verified = false;
    let created = false;
    try {
      const tip = await dismissSizeTip();
      if (!tip.ok) return tip;
      let selection = await selectExisting(modal);
      if (!selection?.ok && selection?.code !== "SIZE_CHART_NOT_FOUND") return selection;
      if (!selection.ok) {
        if (!creating) return fail("SIZE_CHART_MISSING", "Temu 没有唯一匹配的尺码表模板。");
        const edited = await createChart(modal);
        if (!edited?.ok) return edited;
        created = true;
        selection = await selectExisting(modal);
        if (!selection?.ok) return fail("SIZE_CHART_SAVED_UNVERIFIED", "模板保存后未能核对到同名选项，请检查尺码表模板后再重试。");
      }
      const confirm = button(modal, "确认");
      if (!confirm || picker() !== modal || editor()) return fail("READBACK_MISMATCH", "未能核对已选尺码表模板。");
      confirm.click();
      verified = Boolean(await waitFor(() => !picker() && attachedChart(), 3500));
      return verified ? { ok: true, status: "verified", name, created } : fail("READBACK_MISMATCH", "模板确认后未能核对商品关联的尺码表。");
    } finally {
      if (!verified && onPage()) {
        for (const owned of [switcher, editor, picker]) {
          const dialog = owned();
          if (dialog) button(dialog, "取消")?.click();
        }
      }
    }

    function selected(modal) {
      const displays = [...modal.querySelectorAll('input[data-testid="beast-core-select-htmlInput"],input[readonly],[class*="ST_selectValueSingle_"]')];
      return displays.some(node => visible(node) && clean(node.value || node.textContent) === name);
    }
    async function selectExisting(modal) {
      if (!onPage() || picker() !== modal || editor()) return fail("PAGE_CHANGED", "当前尺码表弹窗已变化。");
      if (selected(modal)) return { ok: true };
      const inputs = [...modal.querySelectorAll('input[data-testid="beast-core-select-htmlInput"],[role="combobox"] input')]
        .filter(node => visible(node) && !node.disabled);
      const input = inputs.length === 1 ? inputs[0] : null;
      const trigger = exact(modal, '[data-testid="beast-core-input-suffix"]', "") || input?.closest('[class*="ST_head_"]') || input;
      if (!trigger || openMenu().length) return fail("SIZE_CHART_MISSING", "尺码表模板列表控件尚未显示。");
      trigger.click();
      const menu = await waitFor(() => {
        const matches = openMenu();
        return picker() === modal && matches.length === 1 ? matches[0] : null;
      });
      if (!menu) return fail("SIZE_CHART_MISSING", "未打开当前尺码表模板选项。");
      const selector = '[role="option"],[data-testid="beast-core-select-option"]';
      const candidates = () => [...menu.querySelectorAll(selector)].filter(visiblePopup);
      let previous;
      let stableSince = 0;
      const seen = await waitFor(() => {
        if (picker() !== modal || !openMenu().includes(menu)) return false;
        const options = candidates();
        const text = clean(menu.textContent);
        if (!options.length && !/^(?:没有数据|暂无数据|无数据|暂无模板|没有可选模板|未找到任何结果)$/u.test(text)) return false;
        if (text !== previous) {
          previous = text;
          stableSince = Date.now();
        }
        return Date.now() - stableSince >= 120;
      }, 1800);
      if (!seen) return fail("SIZE_CHART_MISSING", "Temu 尚未返回尺码表模板列表。");
      const option = exact(menu, selector, name);
      if (!option && candidates().some(node => clean(node.textContent) === name)) {
        return fail("SIZE_CHART_MISSING", "Temu 同名尺码模板不唯一或暂不可选。");
      }
      if (!option) {
        trigger.click();
        if (!await waitFor(() => !openMenu().length, 900)) return fail("MENU_STILL_OPEN", "尺码表模板菜单尚未收起。");
        return fail("SIZE_CHART_NOT_FOUND", "Temu 模板列表中没有同名尺码表。");
      }
      if (picker() !== modal || !openMenu().includes(menu)) return fail("PAGE_CHANGED", "尺码表模板列表已变化。");
      option.click();
      return await waitFor(() => picker() === modal && selected(modal) && !openMenu().length)
        ? { ok: true } : fail("READBACK_MISMATCH", "Temu 未确认选中的尺码表模板。");
    }

    function attachedChart() {
      const labels = [...root?.querySelectorAll("label,span,div") || []].filter(node => visible(node) && !node.childElementCount &&
        /^\*?\s*尺码表$/u.test(clean(node.textContent)));
      const actions = 'a,button,[role="button"],[role="link"]';
      return labels.some(label => {
        for (let area = label.parentElement, depth = 0; area && area !== root && depth < 6; area = area.parentElement, depth++) {
          const status = [...area.querySelectorAll("span,div")].find(node => visible(node) && !node.childElementCount &&
            clean(node.textContent) === "已添加");
          if (status && ["查看", "编辑", "删除"].every(action => exact(area, actions, action))) return true;
        }
        return false;
      });
    }

    async function createChart(modal) {
      const sizes = chart.rows.map(row => sizeKey(row?.size));
      if (sizes.some(size => !size) || new Set(sizes).size !== sizes.length) {
        return fail("VALUE_INVALID", "商品尺码表需要对应不重复的商品尺码。");
      }
      const hasBody = Object.keys(bodyColumns()).some(field => chart.rows.every(row => measurement(row?.body?.[field], field)));
      if (!hasBody) return fail("SIZE_CHART_BODY_REQUIRED", "Temu 新建尺码表需要至少一列可核对的身体参数，例如身高、胸围或腰围。");
      const create = exact(modal, 'button,[role="button"],a,[role="link"]', "创建模板");
      if (!create || picker() !== modal) {
        return fail("SIZE_CHART_CREATE_MISSING", "当前尺码表弹窗没有可用的创建模板入口。");
      }
      const preventNavigation = event => {
        if (create.contains(event.target)) event.preventDefault();
      };
      if (create.matches("a[href]")) window.addEventListener("click", preventNavigation);
      try {
        create.click();
      } finally {
        window.removeEventListener("click", preventNavigation);
      }
      const form = await waitFor(editor);
      if (!form) return fail("SIZE_CHART_CREATE_MISSING", "未打开 Temu 尺码表模板编辑窗。");
      const tip = await dismissSizeTip();
      if (!tip.ok) return tip;
      return fillChart(form);
    }

    function bodyColumns() {
      return { waist: ["腰围", "腰围全围"], hip: ["臀围", "臀围全围"], chest: ["胸围", "胸围全围"],
        height: ["身高"], underbust: ["下胸围"], cup: ["罩杯", "杯型", "内衣罩杯"] };
    }

    function measurement(raw, field) {
      const text = value => {
        const number = clean(value);
        if (field === "cup") return /^[A-Z]{1,3}$/u.test(number.toUpperCase()) ? number.toUpperCase() : "";
        const amount = Math.round(Number(number));
        return /^\d+(?:\.\d+)?$/u.test(number) && Number.isSafeInteger(amount) && amount > 0 ? String(amount) : "";
      };
      if (!Array.isArray(raw)) return text(raw) || null;
      const [first, last] = raw.map(text);
      return field !== "cup" && raw.length === 2 && first && last && Number(first) < Number(last) ? [first, last] : null;
    }

    async function fillChart(form) {
      const garmentColumns = { chest: ["胸围全围", "胸围"], length: ["衣长", "上衣长度"], hem: ["下摆围"],
        shoulder: ["肩宽"], sleeve: ["袖长"], waist: ["腰围全围", "腰围"], neck: ["领围"],
        underbust: ["下胸围"], cuff: ["袖口围"] };
      const rows = new Map(chart.rows.map(row => [sizeKey(row?.size), row]));
      const inputSelector = 'input:not([type]),input[type="text"],input[type="number"]';
      const belongs = node => visible(node) && form.contains(node);
      const active = () => onPage() && editor() === form && !switcher() && !sizeTip();
      const enabled = node => !node.disabled && !node.readOnly && !node.closest('[aria-disabled="true"],[data-disabled="true"]');
      const labelKey = text => clean(text).replace(/\s+/gu, "").replace(/^\*/u, "").replace(/\((?:cm|厘米)\)$/iu, "");
      const textLabels = node => [node.getAttribute("aria-label"), node.textContent,
        ...[...node.querySelectorAll("span,div")].filter(child => !child.childElementCount && belongs(child)).map(child => child.textContent)]
        .filter(Boolean).map(labelKey);
      const withLabel = (scope, type, names) => {
        const entries = [...scope.querySelectorAll('input[type="' + type + '"],[role="' + type + '"]')].flatMap(node => {
          if (node.getAttribute("role") === type && node.querySelector('input[type="' + type + '"]')) return [];
          const label = node.closest("label") || [...(node.labels || [])].find(belongs) || node;
          if (!belongs(label) || !names.some(candidate => textLabels(label).includes(labelKey(candidate)))) return [];
          return [{ node, label, checked: node.checked ?? (node.getAttribute("aria-checked") === "true") }];
        });
        return entries.length === 1 ? entries[0] : null;
      };
      const write = (input, text) => {
        if (!active() || !belongs(input) || !enabled(input)) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (!setter || input.maxLength > 0 && text.length > input.maxLength) return false;
        input.focus({ preventScroll: true });
        setter.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        if (active() && input.isConnected) input.dispatchEvent(new Event("change", { bubbles: true }));
        if (input.isConnected) input.blur();
        return active();
      };
      const findName = () => {
        const labels = [...form.querySelectorAll('label,[data-testid="beast-core-form-item-label"],span,div')].filter(node =>
          belongs(node) && labelKey(node.textContent) === "模板名称");
        for (const label of labels) {
          if (label.control && belongs(label.control) && enabled(label.control)) return label.control;
          for (let area = label.parentElement, depth = 0; area && area !== form && depth < 4; area = area.parentElement, depth++) {
            const fields = [...area.querySelectorAll(inputSelector)].filter(node => belongs(node) && enabled(node));
            if (fields.length > 1) break;
            if (fields.length === 1) return fields[0];
          }
        }
        const fields = [...form.querySelectorAll(inputSelector)].filter(node => belongs(node) && enabled(node) &&
          /模板名称/u.test(clean(node.getAttribute("aria-label") || node.placeholder)));
        return fields.length === 1 ? fields[0] : null;
      };
      let manual = withLabel(form, "radio", ["手动录入"]);
      if (!manual?.checked) {
        if (!manual || !enabled(manual.node) || !active()) return fail("SIZE_CHART_CREATE_MISSING", "Temu 未提供手动录入尺码表。");
        manual.label.click();
        await waitFor(() => switcher() || withLabel(form, "radio", ["手动录入"])?.checked);
        const change = switcher();
        if (change) button(change, "确认")?.click();
        manual = await waitFor(() => active() && withLabel(form, "radio", ["手动录入"])?.checked);
        if (!manual) return fail("SIZE_CHART_CREATE_MISSING", "Temu 未切换到手动录入尺码表。");
      }
      const nameInput = findName();
      if (!write(nameInput, name) || clean(findName()?.value) !== name) return fail("READBACK_MISMATCH", "模板名称未回显。");

      function segment(title) {
        const titles = [...form.querySelectorAll("div,span,h2,h3,h4")].filter(node =>
          belongs(node) && !node.childElementCount && title.test(clean(node.textContent)));
        for (const heading of titles) {
          for (let area = heading.parentElement; area && area !== form; area = area.parentElement) {
            if (area.querySelector("table") && area.querySelector('input[type="checkbox"],[role="checkbox"]')) return area;
          }
        }
        return null;
      }
      const sections = [
        { name: "成衣尺码表", type: "garment", columns: garmentColumns, scope: /^(?:(?:商品尺码表|成衣尺码表)(?:\s*商品各个部位对应的长度.*)?|尺码表)$/u },
        { name: "基码表", type: "body", columns: bodyColumns(), scope: /^基码表(?:\s*商品所适用的身体三围参数.*)?$/u },
      ];
      const tablePlans = [];
      for (const section of sections) {
        const getArea = () => segment(section.scope);
        const area = await waitFor(() => active() && getArea());
        if (!area) return fail("SIZE_CHART_CREATE_MISSING", "Temu 未显示" + section.name + "的参数表。");
        const values = field => [...rows.values()].map(row => measurement(row[section.type]?.[field], field));
        const requested = new Map(Object.keys(section.columns).flatMap(field => {
          const measures = values(field);
          const isRange = Array.isArray(measures[0]);
          return measures.every(item => item && Array.isArray(item) === isRange) ? [[field, isRange]] : [];
        }));
        for (const [field, labels] of Object.entries(section.columns)) {
          const control = getArea() && withLabel(getArea(), "checkbox", labels);
          const include = requested.has(field);
          if (!control) continue;
          if (control.checked === include) continue;
          if (!enabled(control.node)) {
            if (control.checked) return fail("SIZE_CHART_MEASUREMENT_MISSING", "商品资料缺少必填参数：" + labels[0] + "。");
            continue;
          }
          if (!active()) return fail("PAGE_CHANGED", "选择尺码参数时页面发生变化。");
          control.label.click();
          if (!await waitFor(() => active() && getArea() && withLabel(getArea(), "checkbox", labels)?.checked === include, 1000)) {
            return fail("READBACK_MISMATCH", "未核对尺码参数：" + labels[0] + "。");
          }
        }
        const tableHeaders = () => active() && getArea() && layout(getArea(), section);
        const header = await waitFor(tableHeaders, 1700);
        if (!header) return fail("SIZE_CHART_ROWS_MISSING", "未能核对" + section.name + "的测量列。");
        for (const { field } of header) {
          if (!requested.has(field)) return fail("SIZE_CHART_MEASUREMENT_MISSING", "商品资料缺少可核对的「" + section.columns[field][0] + "」。");
          const range = () => {
            const column = tableHeaders()?.find(column => column.field === field);
            return column && withLabel(column.cell, "checkbox", ["范围"]);
          };
          const control = range();
          const isRange = requested.get(field);
          if (Boolean(control?.checked) === isRange) continue;
          if (!control || !enabled(control.node) || !active()) return fail("SIZE_CHART_MEASUREMENT_MISSING", "Temu 不支持此尺码参数的范围格式。");
          control.label.click();
          if (!await waitFor(() => active() && range()?.checked === isRange, 1000)) {
            return fail("READBACK_MISMATCH", "Temu 未切换此尺码参数的范围格式。");
          }
        }
        const plan = await waitFor(() => active() && getArea() && matchTables(getArea(), section, requested), 1700);
        if (!plan) return fail("SIZE_CHART_ROWS_MISSING", "未能按尺码唯一对应" + section.name + "的可见表格。");
        tablePlans.push({ section, getArea, requested });
      }
      for (const { getArea, section, requested } of tablePlans) {
        const current = () => active() && getArea() && matchTables(getArea(), section, requested);
        const plan = current();
        if (!plan) return fail("SIZE_CHART_ROWS_MISSING", "填写前的尺码表格布局已变化。");
        for (const entry of plan) {
          const fresh = current()?.find(candidate => candidate.label === entry.label);
          if (!fresh || !write(fresh.input, fresh.value)) return fail("READBACK_MISMATCH", "Temu 未写入「" + entry.label + "」的测量值。");
        }
        if (!await waitFor(() => current()?.every(({ input, value }) => input.value === value &&
            input.getAttribute("aria-invalid") !== "true" && input.validity?.valid !== false), 1000)) {
          return fail("READBACK_MISMATCH", "Temu 未保留" + section.name + "的测量值。");
        }
      }
      const confirm = active() && button(form, "确认");
      if (!confirm) return fail("SIZE_CHART_CREATE_MISSING", "尺码表模板确认按钮不可用。");
      confirm.click();
      return await waitFor(() => !editor() && picker(), 5500) ? { ok: true } :
        fail("SIZE_CHART_SAVE_UNVERIFIED", "Temu 未确认保存尺码表模板，请核对页面标出的尺码参数。");

      function layout(area, section) {
        const tables = [...area.querySelectorAll("table")].filter(belongs);
        const byHeader = cell => {
          const matching = Object.entries(section.columns).filter(([, labels]) =>
            labels.some(label => textLabels(cell).includes(labelKey(label))));
          return matching.length === 1 ? matching[0][0] : null;
        };
        const layouts = tables.flatMap(table => {
          const textRows = [...table.rows].filter(row => belongs(row) && !row.querySelector(inputSelector));
          return textRows.flatMap(row => {
            const cells = [...row.cells];
            const fields = cells.map(cell => ({ cell, field: byHeader(cell) }));
            const [first] = fields;
            if (!first?.field && /^(?:尺码|尺寸)?$/u.test(clean(first?.cell.textContent))) fields.shift();
            return fields.length && fields.every(({ field }) => field) &&
              new Set(fields.map(({ field }) => field)).size === fields.length ? [fields] : [];
          });
        });
        return layouts.length === 1 ? layouts[0] : null;
      }

      function matchTables(area, section, requested) {
        const columns = layout(area, section);
        if (!columns) return null;
        const tables = [...area.querySelectorAll("table")].filter(belongs);
        const fields = columns.map(({ field }) => field);
        const sizeAt = row => {
          const known = [...new Set([...row.cells].filter(cell => !cell.querySelector(inputSelector)).flatMap(cell =>
            [cell.textContent, ...[...cell.querySelectorAll("span,div")].filter(node => !node.childElementCount && belongs(node))
              .map(node => node.textContent)]).map(sizeKey).filter(size => rows.has(size)))];
          return known.length === 1 ? known[0] : null;
        };
        const grids = tables.map(table => [...table.rows].filter(belongs).flatMap(row => {
          const fieldsByCell = [...row.cells].map(cell => [...cell.querySelectorAll(inputSelector)].filter(node => belongs(node) && enabled(node)))
            .filter(inputs => inputs.length);
          if (fieldsByCell.length !== fields.length || fieldsByCell.some((inputs, i) => inputs.length !== (requested.get(fields[i]) ? 2 : 1))) return [];
          return [{ inputs: fieldsByCell, size: sizeAt(row) }];
        })).filter(grid => grid.length === rows.size);
        if (grids.length !== 1) return null;
        const [grid] = grids;
        const labels = tables.flatMap(table => {
          const result = [...table.rows].filter(row => belongs(row) && !row.querySelector(inputSelector)).map(sizeAt).filter(Boolean);
          return result.length === rows.size && new Set(result).size === result.length ? [result] : [];
        });
        const inline = grid.map(row => row.size);
        const sizes = inline.every(Boolean) && new Set(inline).size === inline.length ? inline :
          inline.every(size => !size) && labels.length === 1 ? labels[0] : null;
        if (!sizes) return null;
        const result = grid.flatMap(({ inputs }, rowIndex) => inputs.flatMap((cells, columnIndex) => {
          const size = sizes[rowIndex];
          const field = fields[columnIndex];
          const value = measurement(rows.get(size)[section.type]?.[field], field);
          const label = size + " " + section.columns[field][0];
          if (!Array.isArray(value)) return [{ input: cells[0], value, label }];
          return ["最小值", "最大值"].map((limit, index) => ({
            input: cells.find(input => clean(input.placeholder) === limit), value: value[index], label: label + " " + limit,
          }));
        }));
        return result.every(entry => entry.input && entry.value) ? result : null;
      }
    }
  }

  async function setSizes() {
    const items = [];
    const finish = (code, message) => ({ ...fail(code, message), items });
    const inspect = kind === "inspect-sizes";
    const all = value?.all === true;
    let desired = Array.isArray(value?.sizes) ? value.sizes.map(sizeLabel) : [];
    if (!inspect && (all ? desired.length : !desired.length || desired.length > 20 ||
        new Set(desired.map(sizeKey)).size !== desired.length || desired.some(size => !size))) {
      return finish("VALUE_INVALID", "需要提供不重复的实际尺码，或选择当前分组的全部可用尺码。");
    }
    const inputSelector = 'input[data-testid="beast-core-select-htmlInput"],input[readonly]';
    const systemInput = area => {
      const inputs = [...area?.querySelectorAll(inputSelector) || []].filter(visible);
      return inputs.length === 1 ? inputs[0] : null;
    };
    const region = () => {
      const candidates = [...root?.querySelectorAll('[data-testid="beast-core-form-item"]') || []]
        .filter(item => visible(item) && (/^[*＊]?\s*尺码\s*建议/u.test(clean(item.innerText || item.textContent)) ||
          [...item.querySelectorAll("label,span")].some(label => visible(label) && !label.childElementCount &&
            /^[*＊]?\s*尺码$/u.test(clean(label.textContent)))) &&
          systemInput(item) &&
          item.closest('[class^="product-skc_specItem__"]'));
      return candidates.length === 1 ? candidates[0] : null;
    };
    const sizingArea = () => region()?.closest('[class^="product-skc_specItem__"]');
    const associatedLabel = node => node.closest("label") || [...(node.labels || [])].find(visible);
    const disabled = node => node.matches(":disabled") || Boolean(node.closest('[aria-disabled="true"],[data-disabled="true"]'));
    const groupControls = area => [...area?.querySelectorAll('input[type="radio"],[role="radio"],[role="tab"]') || []].flatMap(node => {
      const label = associatedLabel(node);
      const hit = visible(label) ? label : node;
      const name = clean(node.getAttribute("aria-label") || hit.textContent);
      if (!name || !visible(hit) || node.matches('[role="radio"]') && node.querySelector('input[type="radio"]')) return [];
      return [{ name, selected: node.checked ?? (node.getAttribute("aria-checked") === "true" ||
        node.getAttribute("aria-selected") === "true"), target: clean(node.getAttribute("aria-controls") || hit.getAttribute("aria-controls")) }];
    });
    const groupState = () => {
      const area = sizingArea();
      const groups = groupControls(area);
      const active = groups.filter(group => group.selected);
      const group = active.length === 1 ? active[0] : null;
      const panel = group?.target ? document.getElementById(group.target) : area;
      return { group, groups: groups.map(({ name, selected }) => ({ name, selected })), panel,
        valid: Boolean(area && visible(panel) && area.contains(panel) && (!groups.length || group)) };
    };
    const controls = (panel = sizingArea()) => [...panel?.querySelectorAll('input[type="checkbox"],[role="checkbox"]') || []].flatMap(node => {
      const label = associatedLabel(node);
      const hit = visible(label) ? label : visible(node) ? node : null;
      if (!hit || disabled(node) || disabled(hit)) return [];
      if (node.matches('[role="checkbox"]') && hit.querySelector('input[type="checkbox"]') && node !== hit.querySelector('input[type="checkbox"]')) return [];
      const size = sizeLabel(node.getAttribute("aria-label") || hit.textContent || node.getAttribute("value"));
      if (!size || /^(?:全选|取消全选|全不选|SELECT ALL|DESELECT ALL)$/u.test(size)) return [];
      return [{ size, hit, checked: node.checked ?? node.getAttribute("aria-checked") === "true" }];
    });
    async function waitFor(check, timeout = 2200) {
      const deadline = Date.now() + timeout;
      do {
        if (!onPage() || blocked()) return null;
        const result = check();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 60));
      } while (Date.now() < deadline);
      return null;
    }
    const area = region();
    const input = systemInput(area);
    const systems = ["欧美尺码", "亚洲尺码"];
    const chosenSystem = () => {
      const currentArea = region();
      const field = systemInput(currentArea);
      const selected = [...currentArea?.querySelectorAll('[class*="ST_selectValueSingle_"]') || []].find(visible);
      return [clean(field?.value), clean(selected?.textContent), clean(field?.placeholder)].find(name => systems.includes(name));
    };
    if (inspect) {
      if (!input) return fail("SPEC_CONTROL_MISSING", "当前类目没有可核对的服装尺码控件。");
      const { group, groups, panel, valid } = groupState();
      const options = valid ? controls(panel) : [];
      return { ok: true, system: chosenSystem(), group: group?.name, groups,
        sizes: options.map(({ size }) => size), selectedSizes: options.filter(({ checked }) => checked).map(({ size }) => size) };
    }
    const system = clean(value?.system || chosenSystem());
    if (!input || !systems.includes(system)) return finish("SPEC_CONTROL_MISSING", "请提供当前类目使用的 欧美尺码 或 亚洲尺码。");
    const prior = chosenSystem();
    if (prior && prior !== system) return finish("SPEC_VALUES_OCCUPIED", "页面已选用了不同的尺码体系。");
    if (prior !== system) {
      const options = () => [...document.querySelectorAll('[role="option"],[data-testid="beast-core-select-option"]')]
        .filter(node => visible(node) && (getComputedStyle(node).opacity || "1") !== "0");
      if (options().length) return finish("MENU_STILL_OPEN", "页面已有下拉选项打开。");
      const suffix = [...area.querySelectorAll('[data-testid="beast-core-input-suffix"]')].filter(visible);
      const head = input.closest('[class*="ST_head_"],[data-testid="beast-core-select-header"],[role="combobox"]');
      const trigger = suffix.length === 1 ? suffix[0] : area.contains(head) && visible(head) ? head : input;
      input.focus({ preventScroll: true });
      if (!await waitFor(() => options().length, 180) && onPage() && !blocked() && visible(trigger)) trigger.click();
      const option = await waitFor(() => {
        const matches = options().filter(node => clean(node.textContent) === system);
        return matches.length === 1 && !matches[0].matches('[aria-disabled="true"],[data-disabled="true"],[disabled],a[href]')
          ? matches[0] : null;
      });
      if (!option) return finish("SPEC_OPTION_MISSING", "没有唯一匹配的可用尺码体系。");
      option.click();
    }
    const initial = await waitFor(() => {
      const state = groupState();
      const options = all ? (state.valid ? controls(state.panel) : []) : controls();
      return chosenSystem() === system && options.length > 0 ? { ...state, options } : null;
    });
    if (!initial) return finish("SPEC_VALUES_NOT_RENDERED", "尚未核对尺码体系和当前分组对应的可用尺码。");
    const currentOptions = () => {
      if (!all) return controls();
      const state = groupState();
      return state.valid && chosenSystem() === system && state.group?.name === initial.group?.name ? controls(state.panel) : [];
    };
    if (all) {
      desired = initial.options.map(({ size }) => size);
      if (new Set(desired).size !== desired.length) {
        return finish("SPEC_OPTION_MISSING", "当前尺码分组含有同名选项，无法逐项核对。");
      }
    }
    items.push({ label: system, status: "verified" });
    const unmatched = [];
    for (const size of desired) {
      if (!onPage() || blocked()) return finish("PAGE_CHANGED", "填写服装尺码时页面已切换或有弹窗。");
      const current = currentOptions();
      if (!current.length) return finish("SPEC_VALUES_NOT_RENDERED", "当前尺码分组已变化或不再显示可用选项。");
      const exact = current.filter(entry => entry.size === size);
      const matches = exact.length ? exact : current.filter(entry => sizeKey(entry.size) === sizeKey(size));
      if (matches.length !== 1) {
        unmatched.push(size);
        continue;
      }
      const [match] = matches;
      if (match.checked) {
        items.push({ label: match.size, status: "unchanged" });
        continue;
      }
      match.hit.click();
      if (!await waitFor(() => {
        const readback = currentOptions().filter(entry => entry.size === match.size);
        return readback.length === 1 && readback[0].checked;
      })) {
        return finish("READBACK_MISMATCH", `Temu 未确认选择「${match.size}」尺码。`);
      }
      items.push({ label: match.size, status: "filled" });
    }
    if (unmatched.length) return finish("SPEC_OPTION_MISSING", `Temu 没有唯一匹配的尺码：${unmatched.join("、")}。`);
    const final = currentOptions();
    if (all && (!final.length || final.some(({ checked }) => !checked))) {
      return finish("READBACK_MISMATCH", "未能核对当前尺码分组的全部选项。");
    }
    return { ok: true, status: "verified", items, system, group: initial.group?.name,
      sizes: final.filter(({ checked }) => checked).map(({ size }) => size) };
  }

  async function composition() {
    const holder = document.getElementById("productProperties[15]");
    if (!holder || !root?.contains(holder) || !visible(holder)) return fail("COMPOSITION_MISSING", "当前类目没有可核对的成分比例表。");
    const fields = () => [...holder.querySelectorAll("tbody tr")].flatMap(row => {
      const fields = [...row.querySelectorAll('input[placeholder="请输入"]')].filter(node =>
        visible(node) && !node.disabled && !node.readOnly && ["text", "number"].includes(node.type));
      const material = row.querySelectorAll('input[placeholder="请选择"]');
      if (fields.length !== 1 || material.length !== 1) return [];
      return [{ index: row.sectionRowIndex, field: fields[0] }];
    });
    const snapshot = () => fields().map(({ index, field }) => ({ index, percent: field.value }));
    if (kind === "composition-inspect") return { ok: true, rows: snapshot() };
    const completed = async (check) => {
      const deadline = Date.now() + 1600;
      do {
        await new Promise(resolve => setTimeout(resolve, 70));
        if (!onPage() || blocked()) return false;
        if (check()) return true;
      } while (Date.now() < deadline);
      return false;
    };
    if (kind === "composition-add") {
      const count = fields().length;
      const links = [...holder.querySelectorAll("a,button")].filter(node => visible(node) && !node.disabled &&
        !node.matches('[aria-disabled="true"]') && clean(node.textContent) === "添加" &&
        (!node.hasAttribute("href") || node.getAttribute("href") === "#"));
      if (count >= 8 || links.length !== 1) return fail("COMPOSITION_MISSING", "成分比例表没有唯一可用的添加按钮。");
      links[0].click();
      return await completed(() => fields().length === count + 1)
        ? { ok: true, rows: snapshot() } : fail("COMPOSITION_MISSING", "添加后未显示新成分行。");
    }
    if (!/^(?:\d+)(?:\.\d{1,2})?$/u.test(value) || Number(value) <= 0 || Number(value) > 100) {
      return fail("VALUE_INVALID", "成分百分比必须在 0 至 100 之间。");
    }
    const match = fields().filter(({ index }) => index === key);
    if (match.length !== 1) return fail("COMPOSITION_MISSING", "未找到唯一对应的成分百分比。");
    const [{ field }] = match;
    if (field.value && Number(field.value) === Number(value)) return { ok: true, status: "unchanged" };
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    if (field.isConnected && onPage()) field.dispatchEvent(new Event("change", { bubbles: true }));
    field.blur();
    return await completed(() => fields().some(({ index, field }) => index === key && field.value &&
      Number(field.value) === Number(value) && field.getAttribute("aria-invalid") !== "true"))
      ? { ok: true, status: "filled" } : fail("READBACK_MISMATCH", "成分百分比未能读回。");
  }
}

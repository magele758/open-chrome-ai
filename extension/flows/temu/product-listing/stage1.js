
const ORIGIN = "https://agentseller.temu.com";
const CATEGORY_PATH = "/goods/create/category";

export function isTemuCategoryPage(value) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && url.origin === ORIGIN && url.pathname === CATEGORY_PATH;
  } catch {
    return false;
  }
}

// Serialized and injected into the bound top-level document by chrome.scripting.
export async function temuStagePage({ kind, expectedHref, siteId, category = [], origin = [] }) {
  const originMode = kind === "origin";
  const path = originMode ? "/goods/edit" : "/goods/create/category";
  const onPage = () => location.origin === "https://agentseller.temu.com" && location.pathname === path && location.href === expectedHref;
  const clean = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const shown = (element) => Boolean(element?.isConnected && element.getClientRects().length &&
    !element.closest('[hidden],[aria-hidden="true"],[inert]') && getComputedStyle(element).visibility !== "hidden" &&
    (getComputedStyle(element).opacity || "1") !== "0");
  const modal = () => [...document.querySelectorAll('dialog[open],[role="alertdialog"],[aria-modal="true"],[data-testid="beast-core-modal-container"]')].some(shown);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const unique = (items) => items.length === 1 ? items[0] : null;
  const fail = (message) => ({ ok: false, message });
  const groupSelector = '[data-testid="beast-core-select-header"],[class*="ST_head_"]';
  const optionSelector = '[role="option"],[data-testid="beast-core-select-option"]';
  const categorySearch = 'input[placeholder="搜索类目"]';
  const interactive = 'a,button,input,select,textarea,summary,[role="button"],[role="tab"],[role="link"],[contenteditable="true"]';
  const labelOf = element => clean(element.textContent).replace(/^[*＊]\s*/u, "").replace(/[:：]$/u, "");

  async function until(get, timeout = 1800) {
    const end = Date.now() + timeout;
    do {
      if (!onPage() || modal()) return null;
      const value = get();
      if (value) return value;
      await pause(35);
    } while (Date.now() < end);
    return null;
  }

  function fieldFromInput(input) {
    if (!input || input.disabled || input.closest('[aria-disabled="true"],[data-disabled="true"]')) return null;
    const head = input.closest(groupSelector) || input;
    return { input, head, wrapper: head.closest('[class*="ST_outerWrapper_"],[role="combobox"]') || head };
  }

  function field(label, placeholder, holder) {
    const within = group => unique([...group.querySelectorAll('input')].filter((element) =>
      shown(element) && (!placeholder || element.placeholder === placeholder)));
    const pinned = holder && fieldFromInput(within(holder));
    if (pinned) return pinned;
    const tags = [...document.querySelectorAll('label,[data-field-label],[class*="Form_itemLabelContent_"],span,div')].filter((element) =>
      shown(element) && element.childElementCount <= 1 && labelOf(element) === label);
    const results = new Map();
    for (const tag of tags) {
      for (let group = tag.parentElement, depth = 0; group && group !== document.body && depth < 7; group = group.parentElement, depth++) {
        const target = fieldFromInput(within(group));
        if (target) { results.set(target.input, target); break; }
      }
    }
    return unique([...results.values()]);
  }

  function portalMenus() {
    const visibleLists = [...document.querySelectorAll('[role="listbox"]')].filter(shown);
    return [...visibleLists, ...[...document.querySelectorAll('[class*="ST_dropdown_"]')].filter(node =>
      shown(node) && node.querySelector(optionSelector) && !visibleLists.some(list => node.contains(list)))];
  }

  const choices = menu => [...menu.querySelectorAll(optionSelector)].filter(shown);
  const unavailable = entry => entry.matches('[aria-disabled="true"],[data-disabled="true"],[disabled],a[href]') ||
    Boolean(entry.querySelector("a[href]"));
  function selected(field) {
    return clean(field.head.querySelector('[class*="ST_selectValueSingle_"],[class*="ST_selectValue_"]')?.textContent || field.input.value);
  }

  function relatedMenu(field) {
    const menus = portalMenus();
    const referenced = [field.input, field.head, field.wrapper].flatMap(node =>
      clean(node.getAttribute("aria-controls") || node.getAttribute("aria-owns")).split(/\s+/u).filter(Boolean));
    const associated = menus.filter(menu => field.wrapper.contains(menu) ||
      referenced.some(id => document.getElementById(id)?.contains(menu)));
    return unique(associated) || (!associated.length && !referenced.length &&
      field.wrapper.contains(document.activeElement) ? unique(menus) : null);
  }

  async function open(field) {
    if (portalMenus().length) {
      const existing = relatedMenu(field);
      return existing ? { menu: existing, options: choices(existing) } : null;
    }
    field.input.focus({ preventScroll: true });
    await pause(0);
    if (!onPage() || modal()) return null;
    if (!portalMenus().length) field.head.click();
    const menu = await until(() => {
      const current = relatedMenu(field);
      return current && choices(current).length ? current : null;
    }, 2200);
    return menu && { menu, options: choices(menu) };
  }

  async function close(field, menu) {
    if (!shown(menu)) return true;
    const ownsMenu = () => onPage() && !modal() && unique(portalMenus()) === menu;
    if (!ownsMenu()) return false;
    const active = document.activeElement;
    if (field.wrapper.contains(active) || menu.contains(active)) {
      active.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      if (shown(menu)) active.blur();
    }
    if (await until(() => !shown(menu), 160)) return true;
    if (ownsMenu()) {
      // Choosing a country can leave the portal mounted while Temu renders the province.
      // A pointer event on the static field label follows the portal's outside-press handling.
      const title = originMode ? "商品产地" : "经营站点";
      const targets = [...document.querySelectorAll('label,[data-field-label],[class*="Form_itemLabelContent_"],span,div')].filter(element =>
        shown(element) && labelOf(element) === title && !field.wrapper.contains(element) && !menu.contains(element) &&
        !element.closest(interactive) && !element.querySelector(interactive) && !element.closest("label")?.control &&
        ![...element.children].some(child => labelOf(child) === title));
      const outside = unique(targets) || document.body;
      const rect = outside.getBoundingClientRect();
      const options = { bubbles: true, composed: true, cancelable: true, button: 0,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        if (!ownsMenu()) break;
        const OutsideEvent = type.startsWith("pointer") ? globalThis.PointerEvent || MouseEvent : MouseEvent;
        outside.dispatchEvent(new OutsideEvent(type, { ...options, pointerType: "mouse", isPrimary: true }));
        await pause(0);
      }
      if (await until(() => !shown(menu), 250)) return true;
    }
    if (ownsMenu() && shown(field.head)) field.head.click();
    return Boolean(await until(() => !shown(menu), 450));
  }

  const categoryColumns = () => [...document.querySelectorAll(categorySearch)].filter(shown);

  function categoryOption(input, label) {
    for (let parent = input?.parentElement, depth = 0; parent && depth < 12; parent = parent.parentElement, depth++) {
      if (parent.querySelectorAll(categorySearch).length !== 1) break;
      const matches = [...parent.querySelectorAll('*')].filter((item) => item.childElementCount <= 3 &&
        clean(item.textContent) === clean(label) && shown(item) &&
        ![...item.children].some((node) => clean(node.textContent) === clean(label)));
      if (matches.length) return unique(matches);
    }
    return null;
  }

  function setSearch(input, value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function pickedCategory(labels) {
    const exact = (element) => clean(element.textContent);
    const key = value => clean(value).replace(/\s+/gu, "").replace(/[＞›→]/gu, ">");
    const textNodes = [...document.querySelectorAll('div,span')].filter((element) => shown(element) && element.childElementCount <= 6);
    const picked = textNodes.some(element => key(exact(element)) === `已选分类:${key(labels.at(-1))}`);
    const trail = labels.map(key).join(">");
    const compact = textNodes.map(element => key(exact(element)));
    const displays = compact.some(value => value === trail || value === ">" + trail) ||
      labels.every(label => compact.includes(">" + key(label)));
    return displays && picked;
  }

  if (!onPage() || modal()) return fail("Temu 页面已切换或有弹窗挡住，请返回目标页面后重试。");

  if (originMode) {
    const mainland = origin[0]?.some(label => /^(?:CN|China|中国|中国大陆|中国\(大陆\))$/iu.test(clean(label)));
    const regionName = label => mainland
      ? clean(label).replace(/(?:壮族自治区|维吾尔自治区|回族自治区|自治区|省|市)$/u, "")
      : clean(label);
    for (const [index, labels] of origin.entries()) {
      const matches = value => labels.some(label => index === 0 ? clean(value) === clean(label) : regionName(value) === regionName(label));
      const currentField = () => {
        const holder = document.getElementById("productOriginCode");
        if (index === 0) return field("商品产地", "请选择", holder);
        for (const area of [holder, document]) {
          const input = area && unique([...area.querySelectorAll('input[placeholder="请选择省份"]')].filter(shown));
          if (input) return fieldFromInput(input);
        }
        return null;
      };
      const target = await until(currentField, 5000);
      if (!target) return fail("找不到当前类目的商品产地控件，请在 Temu 核对。");
      if (matches(selected(target))) {
        const existing = relatedMenu(target);
        if (existing && !await close(target, existing)) return fail(`产地「${labels[0]}」已选择，下拉尚未关闭。`);
        continue;
      }
      const opened = await open(target);
      if (!opened) return fail("无法确认产地下拉属于当前字段，请关闭其他下拉后重试。");
      const option = await until(() => unique(choices(opened.menu).filter(entry => !unavailable(entry) && matches(entry.textContent))));
      if (!option) {
        await close(target, opened.menu);
        return fail(`Temu 当前找不到唯一可选的产地「${labels[0]}」。`);
      }
      option.click();
      const confirmed = await until(() => {
        const fresh = currentField();
        return fresh && matches(selected(fresh)) ? fresh : null;
      });
      if (!await close(confirmed || target, opened.menu)) return fail(`产地「${labels[0]}」下拉尚未关闭。`);
      if (!confirmed) return fail(`Temu 尚未确认产地「${labels[0]}」。`);
    }
    return { ok: true };
  }

  const siteField = () => field("经营站点", "请选择") || field("经营站点");
  const site = await until(siteField, kind === "next" ? 2000 : 10000);
  if (!site) return fail("未找到经营站点，请等 Temu 第一步加载后重试。");
  if (kind === "sites") {
    const opened = await open(site);
    if (!opened) return fail("未能定位经营站点下拉，请关闭其他下拉后重试。");
    const names = opened.options.map(entry => ({ label: clean(entry.textContent),
      selected: ["true", "checked"].includes(entry.getAttribute("aria-selected") || entry.getAttribute("data-checked")) || selected(site) === clean(entry.textContent),
      disabled: unavailable(entry) }));
    if (!await close(site, opened.menu)) return fail("经营站点下拉尚未关闭。");
    const sites = names.filter(entry => entry.label && names.filter(other => other.label === entry.label).length === 1)
      .map(entry => ({ id: entry.label, ...entry }));
    return sites.length ? { ok: true, sites } : fail("经营站点列表未加载或没有可识别的选项。");
  }
  if (kind === "next") {
    const next = unique([...document.querySelectorAll('button')].filter((element) => shown(element) && !element.disabled && clean(element.textContent) === "下一步"));
    if (!next || selected(site) !== clean(siteId) || !pickedCategory(category)) return fail("经营站点或完整分类尚未确认，请先检查选择结果。");
    next.click();
    return { ok: true };
  }
  if (kind !== "select" || !category.length) return fail("请选择一个完整的商品类目。");

  if (selected(site) !== clean(siteId)) {
    const opened = await open(site);
    if (!opened) return fail("未能定位经营站点下拉，请关闭其他下拉后重试。");
    const option = await until(() => unique(choices(opened.menu).filter(entry => !unavailable(entry) && clean(entry.textContent) === clean(siteId))));
    if (!option) {
      await close(site, opened.menu);
      return fail(`该店铺当前没有可选的「${siteId}」。`);
    }
    option.click();
    if (!await until(() => {
      const fresh = siteField();
      return fresh && selected(fresh) === clean(siteId);
    })) return fail(`Temu 尚未确认经营站点「${siteId}」。`);
    if (!await close(site, opened.menu)) return fail("经营站点已选择，下拉尚未关闭。");
  }
  const siteMenu = relatedMenu(site);
  if (siteMenu && !await close(site, siteMenu)) return fail("请关闭当前经营站点菜单后再选类目。");
  if (!pickedCategory(category)) {
    for (const [index, label] of category.entries()) {
      const column = await until(() => categoryColumns()[index], 3500);
      if (!column) return fail(`当前站点尚未加载类目「${label}」所在层。`);
      const find = () => categoryOption(categoryColumns()[index], label);
      let option = find();
      if (!option) {
        setSearch(column, label);
        option = await until(find);
      }
      if (!option) return fail(`当前站点没有唯一匹配的类目「${label}」。`);
      option.click();
    }
  }
  return await until(() => pickedCategory(category)) ? { ok: true } : fail("Temu 未确认完整类目，请检查当前站点的分类是否已更新。");
}

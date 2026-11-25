/** Set the explicitly sourced non-sensitive choice for one SKU in the pinned Temu draft. */
export async function temuSensitivePage({ href, key, value }) {
  const clean = text => String(text ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const onPage = () => window === window.top && location.origin === "https://agentseller.temu.com" &&
    location.pathname === "/goods/edit" && location.href === href;
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length &&
    !node.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(node).visibility !== "hidden" &&
    (getComputedStyle(node).opacity || "1") !== "0");
  const enabled = node => visible(node) && !node.matches(":disabled") && !node.closest('[aria-disabled="true"]');
  const unique = nodes => nodes.length === 1 ? nodes[0] : null;
  const fail = (code, message) => ({ ok: false, code, message });
  const blocked = () => [...document.querySelectorAll(
    '[class*="MDL_inner_"],dialog[open],[role="alertdialog"],[aria-modal="true"],[data-testid="beast-core-modal-container"]',
  )].some(visible);
  const textNodes = 'span,div,p,em,strong,th,h2,h3,h4,[data-testid="beast-core-popover"]';
  const portalSelector = '[data-testid="beast-core-portal"]';
  const titlePattern = /^是否敏感品(?:\s*:\s*(?:是|否)?)?$/u;
  const modalTitle = portal => [...portal.querySelectorAll(textNodes)].some(node =>
    visible(node) && !node.closest("label,button,[role=radio]") && titlePattern.test(clean(node.textContent)));
  const popovers = () => [...document.querySelectorAll(portalSelector)].filter(portal =>
    visible(portal) && modalTitle(portal) && portal.querySelector('input[type="radio"],[role="radio"]'));

  function field() {
    const root = document.getElementById("page_container_id");
    return root && unique([...root.querySelectorAll(`[id="${key}"]`)].filter(visible));
  }

  function anchor(holder, readback = false) {
    return holder && unique([...holder.querySelectorAll('input[type="text"],input:not([type])')].filter(input =>
      enabled(input) && !input.closest(portalSelector) &&
      (clean(input.placeholder) === "敏感属性" || readback && !clean(input.placeholder))));
  }

  function negativeSelected(holder) {
    const input = anchor(holder, true);
    if (!input) return false;
    if (["否", "非敏感品"].includes(clean(input.value))) return true;
    const chips = [...holder.querySelectorAll('[class*="ST_selectValueMultipleItem_"],[class*="ST_selectValueSingle_"]')].filter(node =>
      visible(node) && !node.closest(`${portalSelector},label,[role=radio]`) &&
      ["否", "非敏感品"].includes(clean(node.textContent)));
    if (chips.length) return chips.length === 1;
    return [...holder.querySelectorAll('span,div')].some(node =>
      visible(node) && !node.childElementCount && !node.closest(`${portalSelector},label,[role=radio]`) &&
      ["否", "非敏感品"].includes(clean(node.textContent)));
  }

  function radioChoice(portal, name) {
    const choices = [...portal.querySelectorAll('input[type="radio"],[role="radio"]')].flatMap(radio => {
      if (radio.matches(':disabled,[aria-disabled="true"]') || radio.matches('[role="radio"]') && radio.querySelector("input")) return [];
      const label = [...radio.labels || []].find(node => portal.contains(node) && enabled(node) && clean(node.textContent) === name);
      if (label) return [{ radio, target: label }];
      const named = clean(radio.getAttribute("aria-label")) || (radio.getAttribute("role") === "radio" ? clean(radio.textContent) : "");
      if (enabled(radio) && named === name) return [{ radio, target: radio }];
      return [];
    });
    return unique(choices);
  }

  function checked(choice) {
    return choice?.radio.checked === true || choice?.radio.getAttribute("aria-checked") === "true";
  }

  async function waitFor(check, timeout = 1900) {
    const deadline = Date.now() + timeout;
    do {
      if (!onPage() || blocked()) return null;
      const state = check();
      if (state) return state;
      await new Promise(resolve => setTimeout(resolve, 65));
    } while (Date.now() < deadline);
    return null;
  }

  function dismiss(holder, portal) {
    const table = holder?.closest("table");
    const header = table && unique([...table.querySelectorAll("thead th")].filter(node =>
      visible(node) && [node, ...node.querySelectorAll(textNodes)].some(label =>
        visible(label) && clean(label.textContent) === "敏感属性" &&
        !label.closest('a,button,label,[role="button"]'))));
    const outside = header || holder?.closest("td");
    if (!visible(outside) || portal.contains(outside) || outside.closest('a,button,label,[role="button"]')) return false;
    const { x, y, width, height } = outside.getBoundingClientRect();
    const event = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: x + width / 2, clientY: y + height / 2 };
    if (typeof PointerEvent === "function") outside.dispatchEvent(new PointerEvent("pointerdown", { ...event, pointerType: "mouse", isPrimary: true }));
    outside.dispatchEvent(new MouseEvent("mousedown", event));
    outside.dispatchEvent(new MouseEvent("mouseup", event));
    outside.dispatchEvent(new MouseEvent("click", event));
    return true;
  }

  if (!onPage()) return fail("PAGE_CHANGED", "Temu 草稿页已变化。");
  if (blocked()) return fail("MODAL_BLOCKED", "Temu 商品页当前有弹窗。");
  if (typeof key !== "string" || !/^productSkuMap\.[\w-]{0,80}\.sensitiveAttr$/u.test(key) ||
      !["否", "非敏感品"].includes(clean(value))) {
    return fail("VALUE_INVALID", "请先根据商品资料确认该 SKU 为非敏感品。");
  }
  if (popovers().length) return fail("MENU_STILL_OPEN", "Temu 已打开敏感属性弹层，无法核对当前 SKU。");
  if (negativeSelected(field())) return { ok: true, status: "unchanged", value: "非敏感品" };
  const input = anchor(field());
  if (!input) return fail("SENSITIVE_CONTROL_MISSING", "找不到当前 SKU 的敏感属性控件。");
  input.focus({ preventScroll: true });
  let portal = await waitFor(() => unique(popovers()), 100);
  if (!portal && !popovers().length && onPage() && !blocked() && anchor(field()) === input) {
    input.click();
    portal = await waitFor(() => unique(popovers()));
  }
  if (!onPage() || blocked()) return fail("PAGE_CHANGED", "核对这条 SKU 时 Temu 草稿页已变化或弹出其他窗口。");
  if (!portal || !anchor(field(), true)) {
    return popovers().length ? fail("MENU_STILL_OPEN", "Temu 敏感属性弹层仍在，无法核对当前 SKU。") :
      fail("SENSITIVE_CONTROL_MISSING", "没有打开可核对的 SKU 敏感属性弹层。");
  }
  const close = async () => !visible(portal) ||
    Boolean(!blocked() && dismiss(field(), portal) && await waitFor(() => !visible(portal) && !popovers().length));
  const negative = radioChoice(portal, "否");
  const affirmative = radioChoice(portal, "是");
  if (!negative || !affirmative || negative.radio === affirmative.radio) {
    return await close() ? fail("SENSITIVE_CONTROL_MISSING", "敏感属性弹层缺少唯一的「是／否」选项。") :
      fail("MENU_STILL_OPEN", "当前 SKU 的敏感属性弹层尚未关闭。");
  }
  if (!checked(negative)) negative.target.click();
  const applied = await waitFor(() => negativeSelected(field()) &&
    (!visible(portal) || checked(radioChoice(portal, "否")) ||
      [...portal.querySelectorAll(textNodes)].some(node => visible(node) && /^是否敏感品\s*:\s*否$/u.test(clean(node.textContent)))));
  if (!onPage() || blocked()) return fail("PAGE_CHANGED", "核对这条 SKU 时 Temu 草稿页已变化或弹出其他窗口。");
  if (!await close()) {
    return fail("MENU_STILL_OPEN", "当前 SKU 的敏感属性弹层尚未关闭。");
  }
  if (!applied) return fail("READBACK_MISMATCH", "Temu 尚未回显此 SKU 的「否」。");
  return await waitFor(() => negativeSelected(field()) && !popovers().length)
    ? { ok: true, status: "verified", value: "非敏感品" }
    : fail("READBACK_MISMATCH", "关闭弹层后未能核对此 SKU 的敏感属性。");
}

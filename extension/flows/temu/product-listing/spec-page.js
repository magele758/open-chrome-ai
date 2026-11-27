/** Add only child rows in the verified parent-variation table of this draft. */
export async function temuSpecPage({ href, parentIndex, labels, values }) {
  const clean = value => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const keyOf = value => clean(value).replace(/\s+/gu, "").toLowerCase();
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length &&
    !node.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(node).visibility !== "hidden");
  const onPage = () => window === window.top && location.origin === "https://agentseller.temu.com" &&
    location.pathname === "/goods/edit" && location.href === href;
  const blocked = () => [...document.querySelectorAll('[class*="MDL_inner_"],dialog[open],[role="alertdialog"],[aria-modal="true"]')].some(visible);
  const fail = (code, message) => ({ ok: false, code, message, items });
  const items = [];
  const labelSet = new Set((labels || []).map(keyOf));
  const root = document.getElementById("page_container_id");
  const unique = nodes => nodes.length === 1 ? nodes[0] : null;
  const parent = () => document.getElementById(`minorSpec.${parentIndex}.selectedRootSpecId`);

  function siblingTable() {
    const holder = parent();
    if (!holder || !root?.contains(holder)) return null;
    for (let ancestor = holder.parentElement, i = 0; ancestor && ancestor !== root && i < 8; ancestor = ancestor.parentElement, i++) {
      const matches = [...ancestor.querySelectorAll("table")].filter(table => {
        const headers = [...table.querySelectorAll("thead th")].filter(visible).map(node =>
          keyOf(clean(node.textContent).replace(/^[*＊]\s*/u, "")));
        return headers.some(label => labelSet.has(label)) && headers.includes("操作") && headers.length <= 4;
      });
      if (matches.length) return unique(matches);
    }
    return null;
  }

  function inputs() {
    const table = siblingTable();
    return [...table?.querySelectorAll('tbody input[placeholder="请输入"]') || []].filter(node =>
      visible(node) && !node.disabled && !node.readOnly && node.type === "text" &&
      !node.closest('[class*="ST_outerWrapper_"],[role="combobox"]'));
  }

  async function waitFor(check) {
    const deadline = Date.now() + 1800;
    do {
      if (!onPage() || blocked()) return null;
      const state = check();
      if (state) return state;
      await new Promise(resolve => setTimeout(resolve, 45));
    } while (Date.now() < deadline);
    return null;
  }

  if (!onPage() || blocked()) return fail("PAGE_CHANGED", "商品规格页已变化或有弹窗。");
  if (![0, 1].includes(parentIndex) || !labelSet.size || !Array.isArray(values) || !values.length || values.length > 20 ||
      values.some(value => typeof value !== "string" || !clean(value) || value.length > 100) ||
      new Set(values.map(keyOf)).size !== values.length) return fail("VALUE_INVALID", "商品规格值为空、重复或超出数量。");
  if (!await waitFor(siblingTable)) return fail("SPEC_TABLE_MISSING", "当前父规格没有显示可核对的子规格表。");
  for (const value of values) {
    if (!onPage() || blocked()) return fail("PAGE_CHANGED", "填写规格时标签页已变化。");
    if (inputs().some(input => keyOf(input.value) === keyOf(value))) {
      items.push({ label: value, status: "unchanged" });
      continue;
    }
    let input = inputs().find(input => !input.value);
    if (!input) {
      const table = siblingTable();
      const add = unique([...table?.querySelectorAll('button,[role="button"]') || []].filter(node =>
        visible(node) && !node.disabled && /^\+?\s*继续添加子规格$/u.test(clean(node.textContent))));
      if (!add) return fail("SPEC_VALUES_NOT_RENDERED", "没有可用的继续添加子规格按钮。");
      add.click();
      input = await waitFor(() => inputs().find(input => !input.value));
    }
    if (!input) return fail("SPEC_VALUES_NOT_RENDERED", "未出现可填写的子规格输入。");
    if (input.maxLength > 0 && value.length > input.maxLength) return fail("VALUE_INVALID", `规格「${value}」超过字数限制。`);
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    if (input.isConnected && onPage()) input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
    await new Promise(resolve => setTimeout(resolve, 100));
    if (!await waitFor(() => inputs().some(node => keyOf(node.value) === keyOf(value) &&
      node.getAttribute("aria-invalid") !== "true" && node.validity?.valid !== false))) {
      return fail("READBACK_MISMATCH", `规格「${value}」未能回读。`);
    }
    items.push({ label: value, status: "filled" });
  }
  return { ok: true, status: "verified", items };
}

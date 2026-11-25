/** Verify all inventory affected by one stock confirmation in the pinned draft. */
export async function temuStockPage({ href, kind, key, value, rows, warehouse }) {
  const onPage = () => window === window.top && location.origin === "https://agentseller.temu.com" &&
    location.pathname === "/goods/edit" && location.href === href;
  const clean = text => String(text ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length &&
    !node.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(node).visibility !== "hidden");
  const enabled = node => visible(node) && !node.matches(':disabled,[readonly]') && !node.closest('[aria-disabled="true"]');
  const unique = list => list.length === 1 ? list[0] : null;
  const fail = (code, message) => ({ ok: false, code, message });
  const root = document.getElementById("page_container_id");
  const modals = () => [...document.querySelectorAll(
    '[class*="MDL_inner_"],dialog[open],[role="alertdialog"],[aria-modal="true"],[data-testid="beast-core-modal-container"]',
  )].filter(visible);
  const labelKey = text => clean(text).toLowerCase();
  const exact = (node, text) => [node, ...node.querySelectorAll("*")].some(el => {
    if (!visible(el)) return false;
    const direct = [...el.childNodes].filter(child => child.nodeType === Node.TEXT_NODE)
      .map(child => child.textContent).join("");
    return labelKey(el.textContent) === labelKey(text) || labelKey(direct) === labelKey(text);
  });
  const activeStock = () => {
    return unique(modals().filter(node => node.matches('[data-testid="beast-core-modal-inner"]') &&
      [...node.children].some(child => child.matches('[class*="MDL_header_"]') && clean(child.textContent) === "填写库存")));
  };
  const onlyStock = dialog => dialog && modals().every(node => node === dialog || node.contains(dialog));
  const action = (dialog, label) => unique([...dialog.querySelectorAll('button,[role="button"]')]
    .filter(node => enabled(node) && clean(node.textContent) === label));
  const numeric = value => (typeof value === "string" || typeof value === "number") &&
    /^\d+$/u.test(clean(value)) && Number.isSafeInteger(Number(value));
  const validKey = value => typeof value === "string" && /^[\w-]{1,80}$/u.test(value);

  function headerCells(table) {
    const head = table.tHead;
    if (!head) return [];
    const lastRow = head.rows[head.rows.length - 1];
    // Temu's React table also mounts the header cells directly into <thead>.
    return lastRow ? [...lastRow.cells] : [...head.children].filter(cell => cell.matches("th,td"));
  }

  function columns(table, names) {
    return headerCells(table).filter(cell => cell.colSpan === 1 && visible(cell) && names.some(name =>
      exact(cell, name) || name === "当前库存" && /^当前库存\s*\(选填[^()]*\)$/u.test(labelKey(cell.textContent))));
  }

  function columnIndex(table, header) {
    const cells = headerCells(table);
    return cells.slice(0, cells.indexOf(header)).reduce((total, cell) => total + cell.colSpan, 0);
  }

  function tableRows(table) {
    return [...table.tBodies].flatMap(body => {
      const carried = new Map();
      return [...body.rows].map((row, index) => {
        const cells = [];
        for (const [column, { cell, end }] of carried) {
          if (index < end) cells[column] = cell;
        }
        let column = 0;
        for (const cell of row.cells) {
          while (cells[column]) column++;
          const end = cell.rowSpan === 0 ? body.rows.length : index + cell.rowSpan;
          for (let covered = 0; covered < cell.colSpan; covered++, column++) {
            cells[column] = cell;
            carried.set(column, { cell, end });
          }
        }
        return { row, cells };
      });
    });
  }

  function listingCell(skuKey) {
    if (!root) return null;
    return unique([...root.querySelectorAll(`[id="sku_stock_${skuKey}"]`)].filter(visible));
  }

  function listingStock(cell) {
    const display = cell && unique([...cell.querySelectorAll('span[class^="sku-stock-input_stockView__"]')].filter(visible));
    const current = clean(display?.textContent);
    return numeric(current) ? current : undefined;
  }

  function modalTargets(dialog, requested) {
    const table = unique([...dialog.querySelectorAll('table[class*="performance-table_performanceTable__"]')].filter(node =>
      visible(node) && columns(node, ["当前库存"]).length === 1 && columns(node, ["发货仓"]).length === 1 &&
      columns(node, ["覆盖站点"]).length === 1));
    if (!table) return null;
    const [stock] = columns(table, ["当前库存"]);
    const [warehouseColumn] = columns(table, ["发货仓"]);
    const marker = unique([...table.querySelectorAll("tbody td")].filter(cell => visible(cell) && exact(cell, "当前sku")));
    if (!marker) return null;
    const warehouseIndex = columnIndex(table, warehouseColumn);
    const stockIndex = columnIndex(table, stock);
    const activeRows = tableRows(table).filter(({ row }) => visible(row));
    // The popup confirms the whole table. Every active row must be accounted for, including
    // rows with shared size cells, before making any changes.
    if (activeRows.length !== requested.length) return null;
    const candidates = activeRows.map(({ row, cells }) => ({
      row,
      variation: cells.slice(0, warehouseIndex).map(cell => labelKey(cell?.textContent).replace(/\s*当前sku$/u, "")),
      depot: clean(cells[warehouseIndex]?.textContent),
      stock: cells[stockIndex],
    }));
    const targets = new Map();
    const matchedRows = new Set();
    for (const request of requested) {
      const match = request.labels.size ? unique(candidates.filter(({ variation }) =>
        variation.length > 0 && variation.every(label => label && request.labels.has(label)))) : candidates[0];
      if (!match || matchedRows.has(match.row) || !match.depot || (warehouse != null && match.depot !== clean(warehouse)) ||
          !match.stock || match.stock.parentElement !== match.row ||
          (request.key === key && match.row !== marker.parentElement)) return null;
      const input = unique([...match.stock.querySelectorAll(
        'input[data-testid="beast-core-inputNumber-htmlInput"][placeholder="请输入"]',
      )].filter(enabled));
      if (!input) return null;
      matchedRows.add(match.row);
      targets.set(request.key, input);
    }
    return targets;
  }

  async function waitFor(check) {
    const deadline = Date.now() + 2200;
    do {
      if (!onPage()) return null;
      const outcome = check();
      if (outcome) return outcome;
      await new Promise(resolve => setTimeout(resolve, 55));
    } while (Date.now() < deadline);
    return null;
  }

  if (!onPage()) return fail("PAGE_CHANGED", "Temu 商品草稿已切换。");
  if (modals().length) return fail("MODAL_BLOCKED", "当前页已有弹窗，暂不能操作 SKU 库存。");
  if (!validKey(key)) return fail("VALUE_INVALID", "未提供唯一的 SKU 标识。");
  const cell = listingCell(key);
  if (!cell) return fail("SKU_STOCK_CONTROL_MISSING", "未找到当前 SKU 的库存列。");
  if (kind === "inspect") return { ok: true, value: listingStock(cell) };
  const batch = kind === "write-batch";
  const changes = kind === "write" ? [{ key, value }] : rows;
  if ((!batch && kind !== "write") || !Array.isArray(changes) || changes[0]?.key !== key ||
      changes.some(request => !validKey(request?.key) || !numeric(request.value) ||
        batch && (!Array.isArray(request.labels) || !request.labels.length ||
          request.labels.some(label => typeof label !== "string" || !clean(label)))) ||
      new Set(changes.map(request => request.key)).size !== changes.length) {
    return fail("VALUE_INVALID", "请提供无重复、数量为非负整数的 SKU 库存。");
  }
  const requested = changes.map(({ key, value, labels }) => ({ key, value: Number(value), labels: new Set(labels?.map(labelKey)) }));
  if (requested.some(request => !listingCell(request.key))) return fail("SKU_STOCK_CONTROL_MISSING", "有 SKU 库存列无法核对。");
  const readback = () => {
    const values = requested.map(request => [request.key, listingStock(listingCell(request.key))]);
    return values.every(([, amount], index) => amount != null && Number(amount) === requested[index].value)
      ? Object.fromEntries(values) : null;
  };
  const success = (status, values) => ({ ok: true, status, ...(batch ? { values } : { value: values[key] }) });
  const alreadySet = readback();
  if (alreadySet) return success("unchanged", alreadySet);

  const trigger = unique([...cell.querySelectorAll('svg[data-testid="beast-core-icon-edit"]')].filter(enabled));
  if (!trigger) return fail("SKU_STOCK_CONTROL_MISSING", "未找到当前 SKU 唯一的库存编辑入口。");
  trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  const dialog = await waitFor(activeStock);
  if (!onlyStock(dialog)) return modals().length ? fail("MODAL_BLOCKED", "当前页弹窗已变化。")
    : fail("SKU_STOCK_CONTROL_MISSING", "未能打开当前 SKU 的填写库存弹窗。");
  let sent = false;
  try {
    const targets = () => onlyStock(dialog) && activeStock() === dialog ? modalTargets(dialog, requested) : null;
    let plan = await waitFor(targets);
    if (!plan) return fail("SKU_STOCK_WAREHOUSE_REQUIRED", "无法逐一核对弹窗中的所有 SKU 与发货仓，库存未更改。");
    for (const request of requested) {
      if (!onPage() || !onlyStock(dialog) || activeStock() !== dialog) {
        return fail("SKU_QUANTITY_UNVERIFIED", "填写时 SKU 或发货仓已变化。");
      }
      if (!enabled(plan.get(request.key))) plan = targets();
      const input = plan?.get(request.key);
      if (!enabled(input)) return fail("SKU_QUANTITY_UNVERIFIED", "该 SKU 的库存输入已变化。");
      const desired = String(request.value);
      if (input.maxLength > 0 && desired.length > input.maxLength) return fail("VALUE_INVALID", "库存超出 Temu 输入范围。");
      if (input.value === desired) continue;
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, desired);
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      if (input.isConnected && onPage() && onlyStock(dialog)) input.dispatchEvent(new Event("change", { bubbles: true }));
      input.blur();
    }
    const confirm = await waitFor(() => {
      const finalTargets = targets();
      if (!finalTargets) return null;
      const valid = requested.every(request => {
        const input = finalTargets.get(request.key);
        return numeric(input.value) && Number(input.value) === request.value && input.validity?.valid !== false &&
          input.getAttribute("aria-invalid") !== "true";
      });
      return valid && action(dialog, "确认");
    });
    if (!confirm) return fail("SKU_QUANTITY_UNVERIFIED", "库存未能通过弹窗校验，或当前发货仓已变化。");
    sent = true;
    confirm.click();
    const verified = await waitFor(() => !modals().length && readback());
    return verified ? success("verified", verified)
      : fail("SKU_QUANTITY_UNVERIFIED", "库存确认后，部分 SKU 未回显指定数量。");
  } finally {
    if (!sent && onPage() && onlyStock(dialog) && activeStock() === dialog) action(dialog, "取消")?.click();
  }
}

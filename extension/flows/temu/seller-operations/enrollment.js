// Executed in the checked seller page. This operation fills an enrollment form and
// can follow a verified non-final step, but contains no submission action.
export function operateTemuEnrollment({ expectedUrl, action = "inspect", expectedKey, items } = {}) {
  const error = (code, message) => ({ ok: false, code, error: message });
  if (location.href !== expectedUrl || location.origin !== "https://agentseller.temu.com" ||
      !/^\/activity\/marketing-activity(?:\/detail)?\/?$/u.test(location.pathname)) {
    return error("page-changed", "Temu 活动页面已变化。");
  }
  const compact = value => String(value ?? "").replace(/\s+/gu, " ").trim();
  const text = node => compact(node?.innerText ?? node?.textContent);
  const visible = node => {
    for (let current = node; current?.nodeType === 1; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (current.hidden || current.getAttribute("aria-hidden") === "true" || style.display === "none" ||
          style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return Boolean(node?.isConnected);
  };
  const blocked = node => Boolean(node?.closest("fieldset[disabled],[disabled],[readonly],[aria-disabled='true'],[inert]")) ||
    /disabled/iu.test(String(node?.className || ""));
  const enabled = node => visible(node) && !blocked(node);
  if ([...document.querySelectorAll("input[type='password']")].some(visible)) {
    return error("login-required", "Temu 会话已失效，请登录后重新打开活动报名表。");
  }

  const priceHeader = /^(活动(?:申报)?价(?:格)?|Campaign (?:offer )?price)(?:\s|[:：]|[\(（]|$)/iu;
  const stockHeader = /^(活动库存|报名库存|Campaign (?:stock|inventory))(?:\s|[:：]|[\(（]|$)/iu;
  const priceSuggestionHeader = /^(建议申报(?:价|价格)|建议活动价|参考价|建议价)/u;
  const stockSuggestionHeader = /^(建议(?:活动)?库存|推荐库存|参考库存)/u;
  const enrollmentHeading = /^(选择活动商品|活动报名|报名活动|Select campaign products|Campaign enrollment)(?:\s|[:：]|$)/iu;
  const dialogSelectors = "dialog[open],[aria-modal='true'],[role='dialog']";
  const contexts = [...document.querySelectorAll(dialogSelectors)].filter(visible);
  const hasNoEligibleProducts = context =>
    /(?:没有|暂无|无)(?:符合条件的|可)报名商品|(?:共|有)\s*0\s*个商品可报名/u.test(text(context));
  if (!contexts.length) contexts.push(document.body);
  function rowCells(row) {
    return [...row.children].filter(cell => cell.matches("th,td,[role='gridcell'],[role='cell'],[role='columnheader']"));
  }
  function tableRows(table) {
    return [...table.querySelectorAll("tr,[role='row']")].filter(row =>
      visible(row) && row.closest("table,[role='grid'],[role='table']") === table);
  }
  const isHeader = row => rowCells(row).some(cell => cell.matches("th,[role='columnheader']"));
  const cellSpans = (row, span) => Math.max(1, Math.min(100, Number(row.getAttribute(span) || row.getAttribute("aria-" + span)) || 1));

  function expandedRows(rows) {
    const grid = [];
    for (const [rowIndex, row] of rows.entries()) {
      const current = grid[rowIndex] ||= [];
      let offset = 0;
      for (const cell of rowCells(row)) {
        while (current[offset]) offset++;
        const horizontal = cellSpans(cell, "colspan");
        const vertical = Math.min(rows.length - rowIndex, cellSpans(cell, "rowspan"));
        for (let height = 0; height < vertical; height++) {
          const target = grid[rowIndex + height] ||= [];
          for (let width = 0; width < horizontal; width++) target[offset + width] = cell;
        }
        offset += horizontal;
      }
    }
    return grid;
  }

  const matches = [];
  for (const context of contexts) {
    const headings = [...context.querySelectorAll("h1,h2,h3,h4,[role='heading'],[class*='title' i],strong")]
      .filter(visible).map(text).filter(value => value.length <= 100);
    const title = headings.find(value => enrollmentHeading.test(value)) ||
      [...context.querySelectorAll("span,div")].find(node => node.children.length === 0 && enrollmentHeading.test(text(node)) && visible(node))?.textContent?.trim();
    if (!title) continue;
    const tables = [...context.querySelectorAll("table,[role='grid'],[role='table']")].filter(visible);
    for (const [i, table] of tables.entries()) {
      const allRows = tableRows(table);
      const headers = expandedRows(allRows.filter(isHeader));
      const width = Math.max(0, ...headers.map(row => row.length));
      const columns = Array.from({ length: width }, (_, index) =>
        [...new Set(headers.map(row => text(row[index])).filter(Boolean))]);
      const price = columns.findIndex(column => column.some(label => priceHeader.test(label)));
      const inventory = columns.findIndex(column => column.some(label => stockHeader.test(label)));
      if (price === -1 || inventory === -1 || price === inventory) continue;
      let bodyRows = allRows.filter(row => !isHeader(row));
      const following = tables[i + 1];
      if (!bodyRows.length && following && following.parentElement?.parentElement === table.parentElement?.parentElement) {
        const candidates = tableRows(following);
        if (!candidates.some(isHeader)) bodyRows = candidates;
      }
      matches.push({
        context, title, bodyRows, price, inventory,
        selectedId: columns.findIndex(column => column.some(label => /^(SKU ID|SKU编号)$/iu.test(label))),
        priceSuggestion: columns.findIndex(column => column.some(label => priceSuggestionHeader.test(label))),
        stockSuggestion: columns.findIndex(column => column.some(label => stockSuggestionHeader.test(label))),
      });
    }
  }

  if (matches.length !== 1) {
    if (action === "inspect" && matches.length === 0) {
      return {
        ok: true, ready: false, items: [],
        reason: hasNoEligibleProducts(contexts.at(-1)) ? "当前活动没有可报名商品。" : "请先打开明确显示活动申报价和活动库存的报名表。",
      };
    }
    return error("enrollment-form-changed", "无法确认唯一的活动报名表。");
  }

  const match = matches[0];
  const numericText = node => {
    const value = text(node);
    const parsed = value.match(/^[¥￥$]?\s*(\d+(?:,\d{3})*(?:\.\d+)?)(?:\s*件)?$/u);
    return parsed ? parsed[1].replaceAll(",", "") : "";
  };
  const editable = cell => [...(cell?.querySelectorAll("input:not([type]),input[type='text'],input[type='number'],input[type='tel']") || [])]
    .filter(input => visible(input) && !input.readOnly);
  const seen = new Map();
  const rows = expandedRows(match.bodyRows.slice(0, 200)).flatMap((cells, i) => {
    const row = match.bodyRows[i];
    const price = editable(cells[match.price]);
    const inventory = editable(cells[match.inventory]);
    const checks = [...row.querySelectorAll("input[type='checkbox'],[role='checkbox']")].filter(visible);
    const ownInputs = price.concat(inventory).every(input => row.contains(input));
    if (price.length !== 1 || inventory.length !== 1 || price[0] === inventory[0] || !ownInputs || checks.length > 1) return [];
    const sources = [...new Set(cells.slice(0, Math.min(match.price, match.inventory)).map(text).filter(Boolean))];
    const label = sources.slice(0, 5).join(" · ").slice(0, 250);
    if (!label) return [];
    const sku = text(cells[match.selectedId]);
    const id = sku ? "sku:" + sku : "row:" + label;
    const count = (seen.get(id) || 0) + 1;
    seen.set(id, count);
    return [{
      id, label, check: checks[0], price: price[0], inventory: inventory[0],
      priceSuggestion: numericText(cells[match.priceSuggestion]),
      inventorySuggestion: numericText(cells[match.stockSuggestion]),
    }];
  });
  const uniqueRows = rows.filter(row => seen.get(row.id) === 1);
  const scope = match.context;
  const activity = [...scope.querySelectorAll("h1,h2,h3,[role='heading'],[class*='campaignTitle'],[class*='activityTitle']")]
    .filter(visible).map(text).filter(value => value && value.length <= 180).slice(0, 12);
  const key = JSON.stringify([match.title, activity, uniqueRows.map(row => row.id)]);
  const selected = node => node?.checked === true || node?.getAttribute("aria-checked") === "true";
  const possibleNext = [...scope.querySelectorAll("button[type='button']")]
    .filter(button => enabled(button) && /^(下一步|继续填写|Next step)$/iu.test(text(button)));
  const stepSelector = "li,[role='listitem'],[data-step],[class*='step-item']";
  const wizard = [...scope.querySelectorAll("[aria-current='step'],[class*='step-process'],[class*='step-active']")].some(active => {
    const step = active.closest(stepSelector) || active;
    const following = step.nextElementSibling;
    return visible(step) && following?.matches(stepSelector) && visible(following);
  });
  const canNext = wizard && possibleNext.length === 1;
  const readRow = row => ({
    id: row.id, label: row.label, selected: !row.check || selected(row.check),
    selectable: Boolean(row.check && enabled(row.check)),
    price: row.price.value, inventory: row.inventory.value,
    priceSuggestion: row.priceSuggestion, inventorySuggestion: row.inventorySuggestion,
    editable: enabled(row.price) && enabled(row.inventory),
  });
  const snapshot = () => ({
    ok: true, ready: true, title: match.title, key, canNext, items: uniqueRows.map(readRow),
    ...(uniqueRows.length ? {} : {
      reason: hasNoEligibleProducts(scope) ? "当前活动没有可报名商品。" : "这个报名表没有唯一且可填写的商品行。",
    }),
  });
  if (action === "inspect") return snapshot();
  if (key !== expectedKey) return error("enrollment-form-changed", "活动商品或步骤已更新，请先重新读取。");
  if (!["fill", "next"].includes(action)) return error("unsupported-action", "活动流程只支持试填和明确的下一步。");
  if (!Array.isArray(items) || !items.length || items.length > 200) return error("no-items", "请选择要试填的活动商品。");
  const verified = [];
  const failures = [];
  const write = (input, value) => {
    if (!enabled(input)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) return false;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.isConnected && Number(input.value) === Number(value) && input.value !== "" && input.validity.valid;
  };

  const inputIds = new Set(items.map(item => item?.id));
  if (inputIds.size !== items.length) return error("duplicate-items", "试填数据含重复的商品行。");
  const inputs = [];
  for (const item of items) {
    const row = uniqueRows.find(candidate => candidate.id === item?.id);
    if (!row) return error("row-changed", "试填商品行已变化，请重新读取。");
    const price = String(item.price ?? "");
    const inventory = String(item.inventory ?? "");
    if (!/^\d+(?:\.\d{1,4})?$/u.test(price) || Number(price) <= 0 ||
        !/^\d+$/u.test(inventory) || !Number.isSafeInteger(Number(inventory)) || Number(inventory) <= 0) {
      return error("invalid-values", "活动申报价必须大于 0，活动库存必须为正整数。");
    }
    inputs.push({ row, price, inventory });
  }
  for (const { row, price, inventory } of inputs) {
    const current = readRow(row);
    if (action === "next") {
      if (!current.selected || Number(current.price) !== Number(price) || Number(current.inventory) !== Number(inventory)) {
        return error("unverified-fields", "当前表单回读值和试填结果不同，已停在当前步骤。");
      }
      continue;
    }
    if (!current.selected && current.selectable) row.check.click();
    const chosen = !row.check || selected(row.check);
    const ok = chosen && write(row.price, price) && write(row.inventory, inventory);
    (ok ? verified : failures).push({ id: row.id, label: row.label });
  }
  if (action === "next") {
    if (!canNext) return error("final-step", "这个页面没有可验证的下一步，已停在提交前。");
    possibleNext[0].click();
    return { ok: true, advanced: true };
  }
  return { ...snapshot(), verified, failures };
}

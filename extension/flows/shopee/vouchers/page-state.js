/** Read the rendered Shopee voucher page. Chrome injects this function without its module scope. */
export function readShopeeVouchers(expectedUrl, options = {}) {
  const shopIds = new URL(location.href).searchParams.getAll("cnsc_shop_id");
  if (location.href !== expectedUrl || location.origin !== "https://seller.shopee.cn" ||
      location.pathname !== "/portal/marketing/vouchers/list" || shopIds.length !== 1 || !/^\d+$/.test(shopIds[0])) {
    return { ok: false, code: "page-changed", error: "优惠券列表、店铺或标签页已变化。" };
  }
  if (options.action && options.action !== "read" && options.action !== "next-page") {
    return { ok: false, code: "unknown-action", error: "不支持此优惠券列表操作。" };
  }

  const labelsByKey = {
    identity: /优惠券活动名称|优惠券名称|Voucher Name/i,
    voucherType: /优惠券类型|Voucher Type/i,
    productScope: /适用商品范围|Applicable Products/i,
    discount: /折扣金额|Discount Amount/i,
    quantity: /可使用总数|Usage Quantity|Total Usage/i,
    used: /^已使用|^Used\b/i,
    validPeriod: /优惠券领取期间|Voucher Claim Period/i,
    status: /^状态$|^Status$/i,
  };
  const rowValues = ["voucherType", "productScope", "discount", "quantity", "used", "validPeriod", "status"];
  const typeLabels = [
    "商店优惠券", "商品优惠券", "非公开优惠券", "直播优惠券", "短视频优惠券", "关注礼优惠券",
    "新买家优惠券", "新客优惠券", "老买家优惠券", "回购优惠券", "回头客优惠券", "潜在买家优惠券",
  ];
  const clean = value => String(value ?? "").replace(/\s+/gu, " ").trim();
  const text = node => clean(node?.innerText ?? node?.textContent);
  const lines = node => String(node?.innerText ?? node?.textContent ?? "").split(/\n/u).map(clean).filter(Boolean);
  const visible = node => Boolean(node?.getClientRects().length) && getComputedStyle(node).visibility !== "hidden" &&
    !node.closest("[inert],[hidden],[aria-hidden=true]");
  const all = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);
  const exactlyOne = items => items.length === 1 ? items[0] : null;
  const columnKey = label => Object.keys(labelsByKey).find(key => labelsByKey[key].test(label));
  const headersOf = table => all(table, "thead th,[role=columnheader]").map(text);

  const tables = all(document, "table,[role=table]");
  const headerTable = exactlyOne(tables.filter(table => {
    const keys = headersOf(table).map(columnKey);
    return keys.includes("identity") && keys.includes("voucherType") && keys.includes("validPeriod");
  }));
  if (!headerTable) {
    return { ok: false, code: "voucher-list-unavailable", error: "暂未读到优惠券列表。请等页面加载完毕后重试。" };
  }
  const headers = headersOf(headerTable);
  const rowNodes = table => all(table, "tbody tr,[role=row]").filter(row => row.querySelector("td,[role=cell]"));
  const cellsOf = row => [...row.children].filter(cell => cell.matches("td,[role=cell]"));
  const emptyPattern = /^(?:未创建优惠券|暂无数据|暂无优惠券|未找到优惠券|No Vouchers(?: Found| Yet)?|No Data)$/iu;
  const region = exactlyOne(all(document, "h1,h2,h3").filter(node => /^(?:优惠券列表|Voucher List)$/i.test(text(node))));
  const section = region?.parentElement?.contains(headerTable) ? region.parentElement : null;
  const bodyHasResults = table => rowNodes(table).some(row => cellsOf(row).length === headers.length || emptyPattern.test(text(row)));

  // The rendered Shopee list has separate header and body tables in a single wrapper.
  let listRoot = headerTable.parentElement;
  let bodyTable = bodyHasResults(headerTable) ? headerTable : null;
  for (let parent = listRoot; !bodyTable && parent && parent !== document.body; parent = parent.parentElement) {
    const found = all(parent, "table,[role=table]").filter(table => table !== headerTable && bodyHasResults(table));
    if (!found.length) continue;
    listRoot = parent;
    bodyTable = exactlyOne(found);
    break;
  }
  const scope = section || listRoot;
  const emptyMessage = (bodyTable ? rowNodes(bodyTable).map(text).find(value => emptyPattern.test(value)) : null) ||
    all(scope, 'div,span,p').map(text).find(value => emptyPattern.test(value)) || null;
  if (!bodyTable && !emptyMessage) {
    return { ok: false, code: "voucher-list-loading", error: "暂未读到优惠券结果。请等页面加载完毕后重试。" };
  }

  const selected = exactlyOne(all(scope, "[role=tab][aria-selected=true]"));
  const filter = text(selected) || null;
  const rows = [];
  const statusCounts = new Map();
  for (const row of bodyTable ? rowNodes(bodyTable) : []) {
    const cells = cellsOf(row);
    if (cells.length !== headers.length) continue;
    const fields = Object.fromEntries(cells.flatMap((cell, index) => {
      const key = columnKey(headers[index]);
      return key ? [[key, cell]] : [];
    }));
    const identity = fields.identity;
    if (!text(identity)) continue;

    const codeLabel = /^(?:优惠券码|Voucher Code)\s*[：:]\s*(.+)$/iu;
    const identityLines = lines(identity);
    const codeLine = identityLines.find(value => codeLabel.test(value));
    const codeAttr = identity.querySelector("[data-voucher-code]");
    const code = codeLine?.match(codeLabel)?.[1] || codeAttr?.getAttribute("data-voucher-code") || null;
    const title = identityLines.find(value => !codeLabel.test(value)) || text(identity);
    const record = { title, code, identity: text(identity), shopId: shopIds[0] };
    for (const key of rowValues) record[key] = text(fields[key]) || null;
    if (!record.status && filter && !/^(?:全部|All)$/i.test(filter)) record.status = filter;
    const status = record.status || "未知";
    statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
    record.summary = [record.voucherType, record.discount, record.validPeriod].filter(Boolean).join(" · ");
    rows.push(record);
  }

  const typeCards = all(document, "[role=button],button").flatMap(button => {
    const contents = text(button);
    const name = typeLabels.find(label => contents.startsWith(label) && /创建\s*$/u.test(contents));
    if (!name) return [];
    return [{ name, description: clean(contents.slice(name.length).replace(/创建\s*$/u, "")) }];
  }).filter(({ name }, index, cards) => cards.findIndex(card => card.name === name) === index);
  const paginationSelector = '[class*="pagination"],[aria-label="分页"]';
  const pagers = all(scope, paginationSelector);
  const pagination = exactlyOne(pagers.filter(node => !pagers.some(other => other !== node && other.contains(node))));
  const activePage = pagination?.querySelector('[aria-current=page],[class*="page"][class*="active"]');
  const currentPage = parseInt(text(activePage), 10) || null;
  const totalMatch = text(pagination).match(/(?:共\s*)([\d,]+)\s*(?:条|项|个结果)/u);
  const total = totalMatch ? Number(totalMatch[1].replace(/,/gu, "")) : null;
  const next = pagination && exactlyOne(all(pagination, 'button,[role=button]').filter(node =>
    /^(?:下一页|Next Page)$/iu.test(node.getAttribute("aria-label") || node.title || text(node))));
  const hasNextPage = next ? !(next.closest(":disabled,[aria-disabled=true]") || next.className.includes("disabled")) : null;

  if (options.action === "next-page") {
    if (!hasNextPage || !rows.length) {
      return { ok: false, code: "no-next-page", error: "当前优惠券列表没有可确认的下一页。" };
    }
    next.click();
    return { ok: true, kind: "vouchers-next-page", previousPage: currentPage };
  }

  return {
    ok: true,
    kind: "vouchers",
    title: "Shopee 优惠券列表",
    url: location.href,
    rows,
    meta: {
      shopId: shopIds[0], filter, count: rows.length, statusCounts: Object.fromEntries(statusCounts), currentPage, totalRecords: total,
      hasNextPage, scope: "current-page", emptyMessage, voucherTypes: typeCards,
    },
  };
}

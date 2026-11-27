/** Reads the active seller promotion list. Chrome serializes this function into the tab. */
export function readShopeeSellerPromotions(expectedUrl, action = "read") {
  const routes = {
    "/portal/marketing/list/discount": {
      title: "Shopee 折扣活动",
      type: "折扣活动",
      columns: ["全部", "促销活动类型", "商品", "活动期间", "操作"],
    },
    "/portal/marketing/shop-flash-sale/list": {
      title: "Shopee 店铺限时抢购",
      type: "店铺限时抢购",
      emptyLabel: "未发现任何店内秒杀活动",
      tableColumns: ["开始/结束时间", "商品", "已设置提醒的数量：", "商品的点击数/浏览数", "状态", "开启/关闭", "操作"],
    },
    "/portal/marketing/global-discount/list": {
      title: "Shopee 全球商品折扣",
      type: "全球商品折扣",
      columns: ["市场", "活动名称", "商品", "状态", "活动期间", "操作"],
    },
  };
  const route = routes[location.pathname.replace(/\/$/, "")];
  const shopIds = new URL(location.href).searchParams.getAll("cnsc_shop_id");
  if (location.href !== expectedUrl || location.origin !== "https://seller.shopee.cn" ||
      !route || shopIds.length !== 1 || !/^\d+$/.test(shopIds[0])) {
    return { ok: false, code: "page-changed", error: "促销活动页面、店铺或标签页已变化。" };
  }
  if (action !== "read" && action !== "next-page") {
    return { ok: false, code: "unsupported-action", error: "此入口仅支持读取列表和查看下一页。" };
  }

  const raw = node => String(node?.innerText ?? node?.textContent ?? "").trim();
  const text = node => raw(node).replace(/\s+/gu, " ");
  const lines = node => raw(node).split(/\n/u).map(value => value.trim()).filter(Boolean);
  const visible = node => Boolean(node?.getClientRects().length) &&
    getComputedStyle(node).visibility !== "hidden" && !node.closest("[hidden],[inert],[aria-hidden=true]");
  const all = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);
  const one = items => items.length === 1 ? items[0] : null;
  const rowCells = row => [...row.children].filter(cell => cell.matches("td,[role=cell],[role=gridcell]"));
  const rowsOf = table => all(table, "tbody tr,[role=row]").filter(row => rowCells(row).length && row.closest("table,[role=table],[role=grid]") === table);
  const headersOf = table => all(table, "thead th,[role=columnheader]").map(text);
  const titleColumn = label => /^(?:全部|活动名称|促销活动名称|限时抢购名称)$/u.test(label);
  const empty = /^(?:暂无数据|暂无活动|无活动|未找到活动|未创建活动|暂无促销活动|[没沒]有折扣活动|No Data|No Results|0\s*个结果)[。.!]?$/iu;
  const isEmpty = value => value === route.emptyLabel || empty.test(value);
  const sameColumns = (candidate, expected) => candidate.length === expected.length &&
    expected.every((label, index) => candidate[index] === label);
  const dataMatches = candidate => route.columns
    ? sameColumns(candidate, route.columns)
    : sameColumns(candidate.filter(Boolean), route.tableColumns) ||
      (candidate.some(titleColumn) && candidate.includes("商品") && candidate.includes("活动期间") && candidate.includes("操作"));
  const tables = all(document, "table,[role=table],[role=grid]");
  const header = one(tables.filter(table => dataMatches(headersOf(table))));
  const columns = header ? headersOf(header) : [];
  const looksLikeBody = table => rowsOf(table).some(row => rowCells(row).length === columns.length || isEmpty(text(row)));

  // Shopee can render the header and body in separate tables.
  let tableRoot = header?.parentElement;
  let body = header && looksLikeBody(header) ? header : null;
  for (; header && !body && tableRoot && tableRoot !== document.body; tableRoot = tableRoot.parentElement) {
    const bodies = all(tableRoot, "table,[role=table],[role=grid]").filter(
      candidate => candidate !== header && !headersOf(candidate).length && looksLikeBody(candidate),
    );
    if (!bodies.length) continue;
    body = one(bodies);
    break;
  }
  const titleIndex = columns.findIndex(titleColumn);
  const knownStatus = /^(?:未开始|进行中|即将开始|即将结束|已结束|已终止|待审核|已暂停|Ongoing|Upcoming|Expired|Ended)$/iu;
  const rows = [];
  let emptyMessage = "";
  for (const row of body ? rowsOf(body) : []) {
    if (isEmpty(text(row))) {
      emptyMessage = text(row);
      continue;
    }
    const cells = rowCells(row);
    if (cells.length !== columns.length || titleIndex < 0) continue;
    const identity = lines(cells[titleIndex]);
    const title = identity.find(part => !knownStatus.test(part));
    if (!title) continue;
    const fields = Object.fromEntries(columns.flatMap((label, index) =>
      label === "操作" ? [] : [[label, raw(cells[index])]]));
    const status = fields.状态 || identity.find(part => knownStatus.test(part));
    const type = fields.促销活动类型 || route.type;
    rows.push({ title, type, ...(status ? { status } : {}), fields });
  }

  const paginationSelector = "nav[aria-label=分页],nav[aria-label=Pagination],[class*=pagination]";
  let pagination = null;
  for (let region = tableRoot; body && region && region !== document.body; region = region.parentElement) {
    const otherHeaders = all(region, "table,[role=table],[role=grid]").filter(node => node !== header && node !== body && headersOf(node).length);
    if (otherHeaders.length) break;
    const candidates = all(region, paginationSelector).filter(node =>
      !node.parentElement?.closest(paginationSelector) && all(node, "button,[role=button],a").some(isNext));
    if (!candidates.length) continue;
    pagination = one(candidates);
    break;
  }
  function isNext(node) {
    return /^(?:下一页|Next Page)$/iu.test(node.getAttribute("aria-label") || node.getAttribute("title") || text(node)) &&
      !node.closest("[role=dialog],[aria-modal=true],.eds-modal__mask");
  }
  const button = pagination ? one(all(pagination, "button,[role=button]").filter(isNext)) : null;
  const nextButton = button && !button.matches(":disabled,[aria-disabled=true],[disabled],[class*=disabled]") &&
    !button.closest("a") && (!button.closest("form") || button.matches("button[type=button]")) ? button : null;
  const next = nextButton ? { action: "next-page" } : null;
  if (action === "next-page") {
    if (!nextButton || all(document, "[role=dialog],[aria-modal=true],.eds-modal__mask").length) {
      return { ok: false, code: "next-page-unavailable", error: "当前列表没有可安全访问的下一页。" };
    }
    nextButton.click();
    return { ok: true, action };
  }

  const metrics = new Set(["销售", "订单", "售出件数", "买家", "点击率", "转化率"]);
  const candidates = all(document, "h1,h2,h3,h4,div,span,p").filter(node => node.children.length <= 1);
  const perfTitle = candidates.find(node => /^营销活动表现(?:$|\s*[（(])/u.test(text(node)));
  let performance = perfTitle?.parentElement;
  while (performance && performance !== document.body &&
      !candidates.some(node => performance.contains(node) && metrics.has(text(node)))) {
    performance = performance.parentElement;
  }
  const metricLabels = performance && performance !== document.body
    ? candidates.filter(node => performance.contains(node) && metrics.has(text(node))) : [];
  const stats = {};
  const metricText = value => /^(?:(?:[\p{Sc}]|[A-Z]{1,3}\$?|RM)\s*)?[+-]?[\d,.]+(?:\s*(?:%|[A-Z]{1,3}))?$|^[-—–]$/u.test(value);
  for (const label of metricLabels) {
    const key = text(label);
    const card = label.closest("li,[role=listitem]") || label.parentElement;
    if (!card || Object.hasOwn(stats, key)) continue;
    const values = lines(card).filter(metricText);
    const leafValue = all(card, "div,span,p,strong,b,output")
      .find(node => !node.children.length && metricText(text(node)));
    const value = values[0] || text(leafValue);
    if (value) stats[key] = value;
  }
  const periodText = /(?:从\s*)?\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\s*[~～至–]\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s*GMT[+-]\d{1,2}(?::\d{2})?)?|^(?:过去|最近|近)\s*\d+\s*天$/u;
  const period = performance && performance !== document.body
    ? candidates.filter(node => performance.contains(node)).map(node => text(node).match(periodText)?.[0]).find(Boolean)
    : null;
  if (!rows.length && !emptyMessage && tableRoot) {
    emptyMessage = candidates.filter(node => tableRoot.contains(node)).map(text)
      .find(value => empty.test(value)) || "";
  }
  if (!rows.length && !emptyMessage && route.emptyLabel) {
    for (let region = header?.parentElement; region && region !== document.body; region = region.parentElement) {
      const labels = candidates.filter(node => region.contains(node)).map(text);
      if (!labels.includes("活动列表")) continue;
      if (labels.includes(route.emptyLabel)) emptyMessage = route.emptyLabel;
      break;
    }
  }
  const flashGuide = !header && location.pathname.includes("/shop-flash-sale/") &&
    candidates.map(text).find(value => /^(?:快速上手|开始使用|创建你的第一个店铺限时抢购)$/u.test(value));
  const totalPattern = /^(?:共\s*)?([\d,]+)\s*(?:条记录|条|个结果)[。.!]?$/u;
  const totalText = pagination ? all(pagination, "span,p,div").map(text).find(value => totalPattern.test(value)) : emptyMessage;
  const total = totalText?.match(totalPattern)?.[1];
  const current = pagination?.querySelector("[aria-current=page],[class*=page][class*=active]");
  return {
    ok: true,
    kind: "seller-promotions",
    title: route.title,
    rows,
    meta: {
      url: location.href, shopId: shopIds[0], count: rows.length, columns,
      stats, period: period || null, currentPage: Number(text(current)) || null,
      totalRecords: total == null ? null : Number(total.replaceAll(",", "")),
      emptyMessage: emptyMessage || flashGuide || null,
    },
    warnings: emptyMessage || flashGuide ? [emptyMessage || flashGuide] :
      !body || !rows.length ? ["未找到可确认的活动记录。页面仍在加载或列表布局已变化。"] : [],
    next,
  };
}

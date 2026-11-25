// Executed in the seller tab. Keep this function independent of extension state.
export function operateTemuSellerData({ expectedUrl, kind, action = "read", expectedPageKey } = {}) {
  const origin = location.origin;
  if (location.href !== expectedUrl || !["https://agentseller.temu.com", "https://seller.kuajingmaihuo.com",
      "https://ads.temu.com"].includes(origin)) {
    return { ok: false, code: "page-changed", error: "Temu 页面已切换，请回到要读取的页面。" };
  }

  const compact = value => String(value ?? "").replace(/\s+/gu, " ").trim();
  const text = node => compact(node?.innerText ?? node?.textContent);
  const rendered = node => {
    for (let current = node; current?.nodeType === 1; current = current.parentElement) {
      if (current.hidden || current.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return Boolean(node?.isConnected);
  };
  const disabled = node => Boolean(node?.closest("[disabled],[aria-disabled='true'],[inert]")) ||
    /disabled/iu.test(String(node?.className || ""));

  if ([...document.querySelectorAll("input[type='password']")].some(rendered)) {
    return { ok: false, code: "login-required", error: "Temu 会话已失效，请登录后重新读取。" };
  }
  if ([...document.querySelectorAll("dialog[open],[aria-modal='true'],[role='dialog']")].some(rendered)) {
    return { ok: false, code: "dialog-open", error: "当前有弹窗，请回到列表或报表后读取。" };
  }

  const main = [...document.querySelectorAll("main,[role='main']")].find(rendered) ||
    [...document.querySelectorAll("#app [class*='page-content'],#root [class*='page-content']")].find(rendered) ||
    document.body;

  function tableParts(table) {
    const all = [...table.querySelectorAll("tr,[role='row']")];
    const content = all.filter(row => rendered(row) && row.closest("table,[role='table'],[role='grid']") === table);
    const headings = content.filter(row => row.parentElement?.tagName === "THEAD" ||
      [...row.children].some(cell => cell.matches("th:not([scope='row']),[role='columnheader']")));
    return { table, headings, body: content.filter(row => !headings.includes(row)) };
  }

  function flattened(rows) {
    const expanded = [];
    for (const [index, row] of rows.entries()) {
      const output = expanded[index] ||= [];
      const cells = [...row.children].filter(cell => cell.matches("td,th,[role='cell'],[role='gridcell'],[role='rowheader'],[role='columnheader']"));
      let column = 0;
      for (const cell of cells) {
        while (output[column] !== undefined) column++;
        const colSpan = Math.min(100, Math.max(1, Number(cell.getAttribute("colspan") || cell.getAttribute("aria-colspan")) || 1));
        const rowSpan = Math.min(rows.length - index, Math.max(1, Number(cell.getAttribute("rowspan") || cell.getAttribute("aria-rowspan")) || 1));
        const value = text(cell).slice(0, 4000);
        for (let rowOffset = 0; rowOffset < rowSpan; rowOffset++) {
          const target = expanded[index + rowOffset] ||= [];
          for (let displacement = 0; displacement < colSpan; displacement++) {
            target[column + displacement] = value;
          }
        }
        column += colSpan;
      }
    }
    return expanded;
  }

  function columnNames(headings, width) {
    const counts = new Map();
    return Array.from({ length: width }, (_, i) => {
      const labels = [...new Set(headings.map(row => row[i]).filter(Boolean))];
      const label = labels.join(" / ") || "列 " + (i + 1);
      const occurrence = (counts.get(label) || 0) + 1;
      counts.set(label, occurrence);
      const controls = /^(操作|勾选|选择|订单操作|Actions?)$/iu.test(labels.at(-1) || "");
      const recipient = kind === "orders" && labels.some(part =>
        /^(收货信息|收件信息|收货人|收件人|买家联系方式|收货地址|联系地址|联系电话|手机号码|收货电话|Recipient|Shipping address|Phone(?: number)?)$/iu.test(part)
      );
      return { label: occurrence === 1 ? label : label + " (" + occurrence + ")", visible: !controls && !recipient };
    });
  }

  function structuredFields(fields) {
    if (kind !== "products" || !fields.商品信息) return fields;
    const value = fields.商品信息;
    const productName = value.match(/^(.*?)\s*类目\s*[:：]/u)?.[1];
    const category = value.match(/类目\s*[:：]\s*(.+?)(?=\s+(?:商品)?SPU\s*ID|$)/iu)?.[1];
    const spu = value.match(/(?:商品)?SPU\s*ID\s*[:：]\s*(\d+)/iu)?.[1];
    const skc = value.match(/(?:商品)?SKC\s*ID\s*[:：]\s*(\d+)/iu)?.[1];
    return {
      ...(productName && { 商品名称: productName.trim() }),
      ...(category && { 类目: category.trim() }),
      ...(spu && { "SPU ID": spu }),
      ...(skc && { "SKC ID": skc }),
      ...fields,
    };
  }

  const warnings = [];
  const groups = [];
  const parts = [...main.querySelectorAll("table,[role='grid'],[role='table']")]
    .filter(table => rendered(table) && !table.parentElement?.closest("table,[role='grid'],[role='table']"))
    .map(tableParts);
  const emptyHint = /^(暂无(?:相关)?(?:数据|记录|商品|订单|活动|结果)|未查询到(?:数据|订单|商品)|没有(?:数据|订单|商品)|无数据|No (?:data|results|orders)(?: found)?)[。.!！]?$/iu;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const headings = flattened(part.headings);
    if (!headings.length) continue;
    const headerWidth = Math.max(...headings.map(row => row.length));
    let body = part.body;
    const next = parts[i + 1];
    if (!body.length && next && next.headings.length === 0 && next.body.length) {
      // Temu uses separate fixed headers and scrollable rows for wide seller tables.
      const wrapper = part.table.parentElement?.parentElement;
      const related = wrapper && (wrapper.contains(next.table) || wrapper.parentElement?.contains(next.table));
      const bodyWidth = flattened(next.body.slice(0, 1))[0]?.length;
      if (related || headerWidth === bodyWidth) {
        body = next.body;
        i++;
      }
    }
    if (body.length > 500) warnings.push("表格每页最多读取 500 行。");
    const expanded = flattened(body.slice(0, 500));
    const width = Math.max(headerWidth, 0, ...expanded.map(row => row.length));
    const columns = columnNames(headings, width);
    const records = expanded.filter(row => row.some(Boolean) &&
      !(new Set(row.filter(Boolean)).size === 1 && emptyHint.test(row.find(Boolean)))).map(row =>
      Object.fromEntries(columns.flatMap((column, index) =>
        column.visible && (row[index] || !/^列 \d+$/u.test(column.label)) ? [[column.label, row[index] || ""]] : [])));
    const filtered = records.filter(row => Object.values(row).some(Boolean)).map(structuredFields);
    const caption = text(part.table.querySelector("caption")) || part.table.getAttribute("aria-label") ||
      "表格 " + (groups.length + 1);
    if (columns.some(column => !/^列 \d+$/u.test(column.label))) {
      groups.push({ table: compact(caption), records: filtered });
    }
  }

  const lines = String(main.innerText || main.textContent || "").split(/\r?\n/u).map(compact).filter(Boolean);
  const indicatesEmpty = line => emptyHint.test(line) || /^共有?\s*0\s*(条|笔|个)(?:记录|订单|商品)?$/u.test(line);
  const emptyMessage = lines.find(indicatesEmpty) || text([...main.querySelectorAll("p,span,td,[role='status']")].find(
    node => indicatesEmpty(text(node)) && rendered(node)
  )) || undefined;
  const overlayLoading = [...main.querySelectorAll("[role='progressbar'],[aria-busy='true'],[class*='spinning']")]
    .some(rendered);
  if (overlayLoading && !groups.some(group => group.records.length)) {
    return { ok: false, code: "loading", error: "Temu 正在加载数据。" };
  }

  function recordsForCampaignCards() {
    const cards = [];
    const seen = new Set();
    const actions = [...main.querySelectorAll("button,a,[role='button']")].filter(rendered).filter(button =>
      /^(报名|查看详情|活动详情|去报名|立即报名|查看|已报名)$/u.test(text(button)));
    for (const button of actions) {
      let node = button.parentElement;
      for (let depth = 0; depth < 5 && node && node !== main; depth++, node = node.parentElement) {
        const block = text(node);
        const controls = actions.filter(action => node.contains(action));
        if (block.length > 1000 || controls.length > 3) break;
        if (!/(活动时间|报名时间|报名截止|申报价格|库存条件|活动站点|\d{2}-\d{2}\s+\d{2}:\d{2})/u.test(block)) continue;
        const title = text(node.querySelector("h1,h2,h3,h4,[role='heading'],[class*='campaignTitle'],[class*='activityTitle']"));
        const original = String(node.innerText || node.textContent || "").split(/\r?\n/u).map(compact).filter(Boolean);
        const name = title || original.find(line => line.length > 5 && !/^(报名|活动时间|报名时间|库存条件|已报名|申报价格)/u.test(line));
        if (name && !seen.has(name)) {
          const values = Object.create(null);
          for (const line of original) {
            const match = line.match(/^(活动时间|报名时间|报名截止|活动站点|申报价格条件|库存条件|已报名|活动状态)[:：]\s*(.+)$/u);
            if (match?.[2]) values[match[1]] = match[2];
          }
          cards.push({ 活动名称: name, ...values, 活动信息: original.join("\n") });
          seen.add(name);
        }
        break;
      }
    }
    return cards.slice(0, 100);
  }

  if (kind === "campaigns" && !groups.some(group => group.records.length)) {
    const cards = recordsForCampaignCards();
    if (cards.length) groups.push({ table: "活动", records: cards });
  }

  function financeBalances() {
    const label = /^(总金额|可用余额|账户预留金额|预留额度)(?:\s*[(（]\s*([A-Z]{3})\s*[)）])?\s*[:：]?\s*(.*)$/u;
    const amount = /^(?:(?:[+-]\s*)?[¥￥$€]\s*|[¥￥$€]\s*[+-]\s*|[+-]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,4})?(?:\s*(?:[A-Z]{3}|元))?$|^(?:—|--|暂无)$/u;
    const values = new Map();
    let hasMerchandiseAccount = false;
    const metricLabel = node => text(node).replace(/([）)])\s*收支明细$/u, "$1");

    function record(name, value) {
      if (!values.has(name)) values.set(name, new Set());
      values.get(name).add(value);
    }

    for (const node of main.querySelectorAll("dt,th,label,h2,h3,h4,span,div,p")) {
      const content = metricLabel(node);
      if (content === "货款账户" && rendered(node)) hasMerchandiseAccount = true;
      const match = content.length <= 60 && content.match(label);
      if (!match || !rendered(node)) continue;
      const tail = match[3].trim();
      const key = match[2] ? match[1] + " (" + match[2] + ")" : match[1];
      if (tail) {
        if (amount.test(tail)) record(key, tail);
        continue;
      }
      // Temu can render a balance label in one child and the number in the next.
      // Only pair an adjacent amount while the parent still represents that metric.
      for (let cardLabel = node, depth = 0; cardLabel && depth < 3; depth++, cardLabel = cardLabel.parentElement) {
        if (metricLabel(cardLabel) !== content) break;
        const next = cardLabel.nextElementSibling;
        const value = text(next);
        if (amount.test(value) && rendered(next)) {
          record(key, value);
          break;
        }
      }
    }
    return [
      ...(hasMerchandiseAccount ? [["账户类型", "货款账户"]] : []),
      ...[...values].flatMap(([key, candidates]) => candidates.size === 1 ? [[key, [...candidates][0]]] : []),
    ];
  }

  const definitionStats = [...main.querySelectorAll("dl")].filter(rendered).flatMap(list =>
    [...list.querySelectorAll("dt")].flatMap(term => term.nextElementSibling?.tagName === "DD" && rendered(term)
      ? [[text(term), text(term.nextElementSibling)]] : [])
  ).filter(([label, value]) => label && value).slice(0, 80);
  const stats = Object.fromEntries([...definitionStats, ...(kind === "finance" ? financeBalances() : [])]);

  const sectionHeadings = [...main.querySelectorAll("h1,h2,h3,[role='heading'],[class*='pageTitle']")]
    .filter(rendered).map(text).filter(Boolean).slice(0, 20);
  const filters = [...main.querySelectorAll("[role='tab'][aria-selected='true'],select")]
    .filter(rendered).map(control => control.tagName === "SELECT"
      ? text(control.selectedOptions[0]) : text(control)).filter(Boolean).slice(0, 25);
  const pagers = [...main.querySelectorAll("[data-testid='beast-core-pagination'],[class*='pagination' i],[aria-label*='分页']")].filter(rendered);

  function safePaginationTarget(node) {
    const submit = node.closest("button,input");
    if (!rendered(node) || disabled(node) || submit?.form && submit.type === "submit" ||
        /提现|退货|退款|提交|Withdraw|Refund|Confirm/iu.test(text(node))) return false;
    const anchor = node.closest("a[href]") || node.querySelector("a[href]");
    if (!anchor) return true;
    const href = anchor.getAttribute("href")?.trim();
    if (/^(#|javascript:\s*(?:void\(0\))?\s*;?)$/iu.test(href || "")) return true;
    let destination;
    try { destination = new URL(href, location.href); } catch { return false; }
    if (destination.origin !== origin || destination.pathname !== location.pathname ||
        destination.hash !== location.hash || destination.username || destination.password) return false;
    const current = new URL(location.href);
    const names = ["page", "pageNum", "pageNo", "pageIndex", "currentPage", "current", "pn"];
    for (const name of names) {
      current.searchParams.delete(name);
      destination.searchParams.delete(name);
    }
    current.searchParams.sort();
    destination.searchParams.sort();
    return current.href === destination.href;
  }

  const nextCandidates = [...new Set(pagers.flatMap(pager =>
    [...pager.querySelectorAll("button,a,[role='button'],li[title],[data-testid='beast-core-pagination-next']")]))].filter(node => {
    const isNext = /^(下一页|Next page|Next|Go to next page)$/iu.test(compact(node.getAttribute("title") || node.getAttribute("aria-label") || text(node))) ||
      /\bpagination[-_]+next\b/iu.test(String(node.className || "")) ||
      node.getAttribute("data-testid") === "beast-core-pagination-next";
    return isNext && safePaginationTarget(node);
  });
  const nextButtons = nextCandidates.filter(candidate => !nextCandidates.some(other => other !== candidate && candidate.contains(other)));
  const activePageNode = pagers.flatMap(pager => [...pager.querySelectorAll("[aria-current='page'],[class*='item-active'],[class*='PGT_pagerItemActive_']")])
    .find(node => rendered(node) && /^\d+$/u.test(text(node)));
  const page = activePageNode ? Number(text(activePageNode)) : null;
  const countLine = lines.find(line => /^共有?\s*[\d,]+\s*(条|个|笔)/u.test(line));
  const total = countLine ? Number(countLine.match(/[\d,]+/u)[0].replaceAll(",", "")) : null;
  const records = groups.flatMap(group => group.records.map(row => ({
    table: group.table, fields: row,
  })));
  const reportKey = JSON.stringify([page, records.length, records.slice(0, 2), records.at(-1)]);
  if (action === "next-page") {
    if (!records.length || nextButtons.length !== 1 || expectedPageKey !== reportKey) {
      return { ok: false, code: "pager-changed", error: "未能验证当前表格的下一页，已停止翻页。" };
    }
    nextButtons[0].click();
    return { ok: true };
  }
  if (action !== "read") return { ok: false, code: "unsupported-action", error: "无效的读取操作。" };

  // Dashboards sometimes render cards, dates and charts outside data tables. Preserve
  // their visible text separately instead of generating amounts or graph coordinates.
  const readOverview = kind === "marketing" || kind === "finance" || kind === "campaigns" && !records.length;
  const ignoredOverview = /^(Temu|账户资金|资金管理|经营分析|商品推广|店铺营销|首页|客服|反馈|消息|规则中心|履约中心|服务市场|全部|刷新|下载)$/iu;
  const overview = readOverview
    ? [...new Set(lines.filter(line => line.length < 1300 && !ignoredOverview.test(line)))].slice(0, 220)
    : [];
  if (!records.length && !groups.length && !overview.length && !emptyMessage) {
    return { ok: false, code: "loading", error: "当前页面没有可识别的数据，请等页面加载后重试。" };
  }
  if (kind === "marketing" && [...main.querySelectorAll("canvas")].some(rendered)) {
    warnings.push("保留页面文字指标和表格，图表没有可读取的时间序列时不计算图点。");
  }
  if (nextButtons.length > 1) warnings.push("页面有多个可用的分页控件，仅保留已读数据。");
  return {
    ok: true, title: document.title, sectionHeadings, records, filters, stats, overview, emptyMessage,
    page, total, pageKey: reportKey, next: nextButtons.length === 1, warnings,
  };
}

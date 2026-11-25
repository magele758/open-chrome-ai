// Injected into the seller page. Dependencies must stay inside the function.
export function readShopeeCampaigns(expectedUrl, action = "read") {
  const origin = "https://seller.shopee.cn";
  const routes = {
    "/portal/marketing": ["marketing-overview", "Shopee 营销中心"],
    "/portal/marketing/cmt-cb/list/campaign": ["campaign-catalog", "Shopee 官方活动"],
    "/portal/marketing/cmt-cb/list": ["campaign-nominations", "Shopee 商品提报"],
  };
  const warning = message => ({
    kind: "unsupported", title: "Shopee 活动", rows: [], meta: {}, warnings: [message], next: null,
  });
  const page = new URL(location.href);
  let expected;
  try {
    expected = new URL(expectedUrl);
  } catch {
    return warning("无法确认 Shopee 标签页地址。");
  }
  const route = routes[page.pathname.replace(/\/$/, "")];
  const shops = page.searchParams.getAll("cnsc_shop_id");
  if (page.href !== expected.href || page.origin !== origin || page.username || page.password ||
      !route || shops.length !== 1 || !/^\d+$/.test(shops[0])) {
    return warning("当前页已变化，或无法确认 Shopee 活动页和店铺。");
  }

  const [kind, title] = route;
  const clean = value => String(value ?? "").replace(/\s+/gu, " ").trim();
  const get = node => clean(node?.innerText ?? node?.textContent);
  const visible = node => node.getClientRects().length > 0 &&
    !node.closest("[hidden],[aria-hidden=true],[inert]") && getComputedStyle(node).visibility !== "hidden";
  const shown = (selector, root = document) => [...root.querySelectorAll(selector)].filter(visible);
  const one = items => items.length === 1 ? items[0] : null;
  const first = (selector, root) => shown(selector, root)[0];
  const enabled = node => !node.matches(":disabled,[aria-disabled=true],.disabled,.is-disabled") &&
    !node.closest("[aria-disabled=true],.eds-react-pagination-disabled,.eds-pagination__disabled");
  const linesIn = node => {
    if (!node) return [];
    if (typeof node.innerText === "string") return node.innerText.split(/\n+/u).map(clean).filter(Boolean);
    // DOM fixtures may not provide innerText. Keep adjacent elements separate.
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const lines = [];
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if (clean(current.textContent) && visible(current.parentElement)) lines.push(clean(current.textContent));
    }
    return lines;
  };

  function campaignHref(value) {
    if (!value || value.startsWith("#")) return "";
    try {
      const target = new URL(value, page.href);
      const targetShops = target.searchParams.getAll("cnsc_shop_id");
      return target.origin === origin && !target.username && !target.password &&
        target.pathname.startsWith("/portal/marketing/") &&
        (!targetShops.length || targetShops.length === 1 && targetShops[0] === shops[0]) ? target.href : "";
    } catch {
      return "";
    }
  }

  function rowLink(root) {
    const links = [...new Set(shown("a[href]", root)
      .filter(link => !/^(?:立即报名|立即购买|创建活动)$/u.test(get(link)))
      .map(link => campaignHref(link.getAttribute("href"))).filter(Boolean))];
    return one(links) || "";
  }

  function rowId(node, url) {
    const fromNode = clean(node.getAttribute("data-campaign-id"));
    if (fromNode) return fromNode;
    if (!url) return "";
    const params = new URL(url).searchParams;
    return clean(params.get("campaign_id") ?? params.get("campaignId"));
  }

  const knownLabels = ["活动时间", "提名截止时间", "提名截止", "报名截止时间", "报名截止",
    "报名时间", "可报名店铺", "报名状态", "活动状态", "可报名", "待确认", "已报名"];
  function cardFields(lines) {
    const keyAt = line => knownLabels.find(label => line === label ||
      line.startsWith(label + "：") || line.startsWith(label + ":") || line.startsWith(label + " "));
    const fields = {};
    for (const [index, line] of lines.entries()) {
      const label = keyAt(line);
      if (!label) continue;
      const rest = line.slice(label.length).replace(/^[\s：:]+/u, "");
      const nextLine = lines[index + 1];
      if (rest || nextLine && !keyAt(nextLine) && !/^(?:立即报名|立即购买|查看详情)$/u.test(nextLine)) {
        fields[label] = rest || nextLine;
      }
    }
    return fields;
  }

  function overviewRows() {
    return shown(".events-card").flatMap(card => {
      const content = first(".content-wrapper", card) ?? card;
      const name = get(first(".content-wrapper .title,.title", card));
      if (!name) return [];
      const lines = linesIn(content);
      const fields = cardFields(lines);
      const summary = get(first(".description,.desc,.summary", content)) || lines
        .filter(line => line !== name && !/^(?:更多|查看更多|查看详情|立即报名|立即购买)$/u.test(line))
        .join(" · ");
      const url = rowLink(card);
      return [{
        id: rowId(card, url), title: name, summary, url, sourceUrl: page.href,
        campaignTime: fields.活动时间 || "", signupEnd: fields.报名截止时间 || fields.报名截止 || "", fields,
      }];
    });
  }

  function catalogRows() {
    return shown("[class*='CampaignGridItemWrapper---itemWrapper--']").flatMap(card => {
      const display = first("[class*='CampaignGridItemWrapper---exhibition--']", card);
      const name = clean(first("img[alt]", card)?.getAttribute("alt"));
      if (!display || !name) return [];
      const lines = linesIn(display);
      const fields = { ...cardFields(linesIn(card)), ...cardFields(lines) };
      const nameIndex = lines.findIndex(line => line === name || line.endsWith(name));
      const category = nameIndex > 0 ? lines.slice(0, nameIndex).at(-1) : "";
      const url = rowLink(card);
      return [{
        id: rowId(card, url), title: name, category,
        campaignTime: fields.活动时间 || "",
        nominationDeadline: fields.提名截止时间 || fields.提名截止 || fields.报名截止时间 || fields.报名截止 || "",
        status: fields.报名状态 || fields.活动状态 || tabs.find(tab => tab.selected)?.label || "",
        url, sourceUrl: page.href, fields,
      }];
    });
  }

  const nominationColumns = new Set([
    "报名名称", "报名描述", "优先级", "报名进度", "报名方式", "可报名店铺", "是否支持SIP", "状态", "报名时间", "操作", "",
  ]);
  const columnName = cell => get(cell).replace(/是否支持\s+SIP/iu, "是否支持SIP");
  function nominationRows() {
    const headers = shown("thead tr").filter(row =>
      [...row.cells].some(cell => columnName(cell) === "报名名称"));
    if (!headers.length) return [];
    // EDS can split the sticky and scrollable panes into separate tables.
    const start = headers[0];
    let scope = start.closest(".eds-react-table,.eds-table") ?? start.closest("table");
    if (!scope) return [];
    const tableHeaders = root => shown("thead tr", root)
      .map(row => ({ row, names: [...row.cells].map(columnName) }))
      .filter(({ names }) => names.length && names.every(name => nominationColumns.has(name)));
    const hasNominationColumns = root => {
      const names = tableHeaders(root).flatMap(segment => segment.names);
      return names.includes("报名名称") && names.includes("报名描述") && names.includes("报名方式");
    };
    for (let level = 0; level < 5 && !hasNominationColumns(scope); level++) {
      if (!scope.parentElement || scope.parentElement === document.body) return [];
      scope = scope.parentElement;
    }
    if (!hasNominationColumns(scope)) return [];
    const segments = tableHeaders(scope);
    const availableBodies = shown("tbody", scope);
    const usedBodies = new Set();
    const paneRows = [];
    for (const { row, names } of segments) {
      const ownTable = row.closest("table");
      const ownBody = ownTable?.tBodies[0];
      let match = availableBodies.includes(ownBody) && !usedBodies.has(ownBody) ? ownBody : null;
      if (!match) {
        const candidates = availableBodies.filter(body => !usedBodies.has(body) &&
          shown(":scope > tr", body).some(item => item.cells.length === names.length));
        // Match the closest split pane. Equal-sized unrelated panes are ambiguous.
        for (let pane = ownTable?.parentElement; pane && scope.contains(pane); pane = pane.parentElement) {
          const inside = candidates.filter(candidate => pane.contains(candidate));
          if (!inside.length) continue;
          match = one(inside);
          break;
        }
      }
      if (!match) return [];
      usedBodies.add(match);
      paneRows.push({
        names,
        rows: shown(":scope > tr", match).filter(item =>
          item.cells.length === names.length && ![...item.cells].some(cell => cell.colSpan > 1)),
      });
    }
    if (!paneRows.length || paneRows.some(pane => pane.rows.length !== paneRows[0].rows.length)) return [];
    const output = [];
    for (let index = 0; index < paneRows[0].rows.length; index++) {
      const pairs = [];
      for (const pane of paneRows) {
        for (const [column, key] of pane.names.entries()) {
          if (key && key !== "操作") pairs.push([key, get(pane.rows[index].cells[column])]);
        }
      }
      const fields = Object.fromEntries(pairs);
      if (pairs.some(([key, value]) => fields[key] !== value)) return [];
      if (!fields.报名名称 || fields.报名名称 === "暂无可提报活动") continue;
      const titlePane = paneRows.find(pane => pane.names.includes("报名名称"));
      const titleCell = titlePane.rows[index].cells[titlePane.names.indexOf("报名名称")];
      const url = rowLink(titleCell);
      output.push({
        id: rowId(titlePane.rows[index], url), title: fields.报名名称, summary: fields.报名描述 || "",
        status: fields.状态 || "", campaignTime: fields.报名时间 || "", url, sourceUrl: page.href, fields,
      });
    }
    return output;
  }

  const tabControls = kind === "campaign-catalog"
    ? shown("[role=tab].eds-react-tabs-tab").flatMap(node => {
      const match = get(node).match(/^(可报名|已邀请|待确认|已报名)(?:\s*[(（]\s*(\d+)\s*[)）])?$/u);
      return match ? [{
        node, label: match[1], count: match[2] == null ? null : Number(match[2]),
        selected: node.getAttribute("aria-selected") === "true",
      }] : [];
    }) : [];
  const tabs = tabControls.map(({ label, count, selected }) => ({ label, count, selected }));
  const pager = kind !== "marketing-overview" ? one(shown(".eds-react-pagination,.eds-pagination")) : null;
  const nextButton = pager && one(shown("button", pager).filter(node => enabled(node) &&
    /^(?:下一页|Next Page|Next)$/iu.test(clean(node.getAttribute("aria-label") || node.getAttribute("title") || get(node)))));
  const selectedPage = pager && first("[aria-current=page],.eds-react-pagination-item-active,.eds-pagination__item--active", pager);
  const number = Number(get(selectedPage));
  const next = nextButton ? { action: "next-page" } : null;
  const warnings = [];
  const rows = kind === "marketing-overview" ? overviewRows() :
    kind === "campaign-catalog" ? catalogRows() : nominationRows();
  const stats = Object.fromEntries(tabs.filter(tab => tab.count != null).map(tab => [tab.label, tab.count]));
  if (!rows.length) {
    const selected = tabs.find(tab => tab.selected);
    const text = get(document.body);
    const empty = selected?.count === 0 || /暂无可提报活动|暂无活动|没有可报名活动/gu.test(text);
    if (!empty) warnings.push("当前页面没有可识别的活动记录。页面可能还在加载。");
  }
  const result = {
    kind, title, rows, meta: { shopId: shops[0], url: page.href, tabs, page: number > 0 ? number : 1, stats },
    warnings, next,
  };
  if (action === "read") return result;

  const operation = typeof action === "string" ? action : action?.type ?? action?.action;
  let control;
  if (operation === "next-page") control = nextButton;
  if (operation === "select-tab") {
    control = one(tabControls.filter(tab => enabled(tab.node) && !tab.selected && tab.label === action.label))?.node;
  }
  if (!control) return { ...result, changed: false, warnings: [...warnings, "页面未提供可识别的读取导航。"] };
  control.click();
  return { ...result, changed: true };
}

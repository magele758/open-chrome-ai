import { $ } from "../../sidepanel/dom.js";
import {
  canInspectShopeeMarketing, canReadShopeeMarketing, inspectShopeeMarketingForm,
  readShopeeMarketing, trialShopeeMarketingForm,
} from "./marketing-runtime.js";

const MARKETING_ORIGIN = "https://seller.shopee.cn";
const MARKETING_PATH = "/portal/marketing";
const MARKETING_FEATURES = {
  "campaign-data": {
    title: "活动数据",
    action: "read",
    voucher: false,
    hint: "请打开 Shopee 营销中心、官方活动或促销活动列表。",
  },
  "campaign-draft": {
    title: "活动表单试填",
    action: "draft",
    voucher: false,
    hint: "请打开 Shopee 折扣活动、全球商品折扣或店铺限时抢购的新建页。",
  },
  "voucher-data": {
    title: "优惠券数据",
    action: "read",
    voucher: true,
    hint: "请打开 Shopee 优惠券列表。",
  },
  "voucher-draft": {
    title: "优惠券表单试填",
    action: "draft",
    voucher: true,
    hint: "请打开 Shopee 新建商店优惠券表单。",
  },
};
const COLUMN_LABELS = {
  titleZh: "中文名称",
  nameZh: "中文名称",
  descriptionZh: "中文说明",
  summaryZh: "中文说明",
  title: "名称",
  name: "名称",
  description: "说明",
  summary: "概要",
  id: "编号",
  shopId: "店铺",
  code: "优惠码",
  type: "类型",
  category: "活动分类",
  campaignTime: "活动时间",
  nominationDeadline: "提名截止",
  source: "来源名称",
  sourceKind: "来源类别",
  sourcePage: "来源页码",
  fields: "页面字段",
  recordType: "记录类型",
  recordCount: "读取条数",
  period: "统计区间",
  metrics: "统计指标",
  filter: "当前筛选",
  sourceNotes: "读取提示",
  voucherType: "优惠券类型",
  productScope: "适用商品",
  validPeriod: "领取期间",
  status: "状态",
  startAt: "开始时间",
  endAt: "结束时间",
  signupStart: "报名开始",
  signupEnd: "报名截止",
  discount: "优惠",
  used: "已使用",
  quantity: "数量",
  site: "站点",
  sourceUrl: "来源",
  url: "链接",
  href: "链接",
};
const COLUMN_ORDER = ["titleZh", "nameZh", "title", "name", "descriptionZh", "summaryZh", "description"];

function columnLabel(key) {
  return Object.hasOwn(COLUMN_LABELS, key) ? COLUMN_LABELS[key] : key;
}

function sellerUrl(raw) {
  try {
    const url = new URL(raw);
    return url.origin === MARKETING_ORIGIN && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function isMarketingPath(url) {
  return Boolean(url && (url.pathname === MARKETING_PATH || url.pathname.startsWith(MARKETING_PATH + "/")));
}

function isFeaturePath(url, feature) {
  if (!feature) return isMarketingPath(url);
  if (!url || url.pathname.startsWith(MARKETING_PATH + "/vouchers/") !== feature.voucher) return false;
  return feature.action === "read" ? canReadShopeeMarketing(url) : canInspectShopeeMarketing(url);
}

function shopLink(url, path) {
  const shops = url.searchParams.getAll("cnsc_shop_id");
  if (shops.length !== 1 || !/^\d+$/.test(shops[0])) return null;
  const dest = new URL(path, MARKETING_ORIGIN);
  dest.searchParams.set("cnsc_shop_id", shops[0]);
  return dest.href;
}

function textValue(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(" · ");
  if (typeof value === "object") {
    return Object.entries(value).map(([key, item]) => `${columnLabel(key)}${item === "" ? "" : " · " + textValue(item)}`).join("\n");
  }
  return String(value);
}

function noticeText(notice) {
  return typeof notice === "object" && notice
    ? textValue(notice.message || notice.error || notice.reason || notice)
    : textValue(notice);
}

function reportColumns(report) {
  const columns = new Map((report.columns || []).map(column => [
    typeof column === "string" ? column : column.key,
    typeof column === "string" ? columnLabel(column) : column.label || columnLabel(column.key),
  ]).filter(([key]) => key));
  const keys = new Set(report.records.flatMap(row => Object.keys(row || {})));
  for (const key of COLUMN_ORDER) {
    if (keys.delete(key) && !columns.has(key)) columns.set(key, COLUMN_LABELS[key]);
  }
  for (const key of keys) {
    if (!columns.has(key)) columns.set(key, columnLabel(key));
  }
  return [...columns].map(([key, label]) => ({ key, label }));
}

function csvCell(value) {
  const text = textValue(value);
  const guarded = typeof value !== "number" && /^[\s\u0000-\u001f]*[=+@-]/u.test(text) ? "'" + text : text;
  return '"' + guarded.replaceAll('"', '""') + '"';
}

function asCsv(report) {
  const records = report.records.map(record => ({ recordType: "活动或优惠券", ...record }));
  for (const source of report.sources || []) {
    records.push({
      recordType: "来源页概况",
      source: source.label, sourceUrl: source.url, recordCount: source.count,
      period: source.meta?.period, metrics: source.meta?.stats,
      filter: source.meta?.filter || source.meta?.tabs?.find(tab => tab.selected)?.label,
      sourceNotes: [...new Set([source.meta?.emptyMessage, ...(source.warnings || [])])].filter(Boolean).join(" · "),
    });
  }
  const columns = reportColumns({ ...report, records });
  const rows = [
    columns.map(column => csvCell(column.label)),
    ...records.map(record => columns.map(column => csvCell(record[column.key]))),
  ];
  return "\ufeff" + rows.map(row => row.join(",")).join("\r\n");
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function renderTable(container, report) {
  if (!report.records.length) {
    container.replaceChildren(element("p", "当前范围内没有记录。", "shopee-marketing-empty"));
    return;
  }
  const columns = reportColumns(report);
  const table = element("table");
  table.setAttribute("aria-label", "营销数据记录");
  const heading = table.createTHead().insertRow();
  for (const { label } of columns) {
    const cell = element("th", label);
    cell.scope = "col";
    heading.append(cell);
  }
  const body = table.createTBody();
  for (const record of report.records) {
    const row = body.insertRow();
    for (const { key } of columns) row.insertCell().textContent = textValue(record[key]);
  }
  container.replaceChildren(table);
}

function makeFieldControl(field) {
  const kind = field.kind || field.type;
  if (Array.isArray(field.options) && field.options.length) {
    const select = element("select");
    const blank = element("option", "请选择");
    blank.value = "";
    select.append(blank);
    for (const entry of field.options) {
      const value = typeof entry === "object" && entry ? entry.value ?? entry.label : entry;
      if (value == null || value === "") continue;
      const option = element("option", typeof entry === "object" && entry ? entry.label ?? value : value);
      option.value = textValue(value);
      select.append(option);
    }
    select.value = textValue(field.value);
    return select;
  }
  if (kind === "textarea") {
    const textarea = element("textarea");
    textarea.value = textValue(field.value);
    return textarea;
  }
  const input = element("input");
  input.type = ["number", "date", "time", "datetime-local", "checkbox"].includes(kind) ? kind : "text";
  if (kind === "checkbox") input.checked = field.value === true || field.value === "true";
  else input.value = textValue(field.value);
  if (kind === "number") input.step = "any";
  if (Number.isInteger(field.maxLength)) input.maxLength = field.maxLength;
  return input;
}

function fieldValue(control) {
  return control.type === "checkbox" ? control.checked : control.value;
}

function showReceipt(box, receipt) {
  const filled = receipt.filled || receipt.verified;
  const blockers = receipt.blockers || receipt.skipped;
  const lines = [
    receipt.summary && noticeText(receipt.summary),
    Array.isArray(filled) && filled.length ? "已填写并回读\n" + filled.map(noticeText).join("\n") : "",
    Array.isArray(blockers) && blockers.length ? "待处理\n" + blockers.map(noticeText).join("\n") : "",
    receipt.error && noticeText(receipt.error),
  ].filter(Boolean);
  box.textContent = lines.join("\n\n");
  box.hidden = !lines.length;
}

export function bindShopeeMarketingPanel({ getTargetTab, getSettings, isAgentBusy, downloadText, onBack }) {
  const dialog = $("shopee-marketing-dialog");
  if (!dialog) return async () => false;
  const at = (id) => $("shopee-marketing-" + id);
  const target = at("target");
  const title = at("title");
  const defaultTitle = title.textContent;
  const navigation = at("links");
  const navigationGroups = [...navigation.children];
  const navigationLinks = [...navigation.querySelectorAll("[data-marketing-path]")];
  const sellerLink = element("a", "打开 Shopee 卖家中心");
  sellerLink.href = MARKETING_ORIGIN;
  sellerLink.target = "_blank";
  sellerLink.rel = "noopener";
  const sellerFallback = element("div", null, "shopee-marketing-links");
  sellerFallback.append(sellerLink);
  navigation.append(sellerFallback);
  const read = at("read");
  const inspect = at("inspect");
  const stop = at("stop");
  const close = at("close");
  const back = at("back");
  if (back) back.hidden = typeof onBack !== "function";
  const status = at("status");
  const warnings = at("warnings");
  const translation = at("translate");
  const allPages = at("all-pages");
  const options = translation.closest(".shopee-marketing-options");
  const translationLabel = translation.closest("label");
  const pageLabel = allPages.closest("label");
  const defaultPageLabel = pageLabel.textContent.trim();
  const reportPanel = at("report");
  const reportTitle = at("report-title");
  const summary = at("report-summary");
  const source = at("source");
  const rows = at("rows");
  const sample = at("sample");
  const preview = at("preview");
  const trialForm = at("trial");
  const trialRun = at("run");
  const trialJson = at("trial-json");
  const fields = at("fields");
  const receipt = at("receipt");
  const json = at("json");
  const csv = at("csv");
  let working = null;
  let report = null;
  let form = null;
  let targetUrl = null;
  let targetTabId = null;
  let feature = null;

  function showStatus(state, message) {
    status.dataset.state = state;
    status.textContent = message;
  }

  function showNotices(entries) {
    const items = (Array.isArray(entries) ? entries : entries ? [entries] : []).map(noticeText).filter(Boolean);
    warnings.replaceChildren(...items.map(item => element("li", item)));
    warnings.hidden = !items.length;
  }

  function refreshControls() {
    const busy = Boolean(working);
    read.disabled = read.hidden || busy || !canReadShopeeMarketing(targetUrl);
    inspect.disabled = inspect.hidden || busy || !canInspectShopeeMarketing(targetUrl);
    trialRun.disabled = busy || !form?.controls.size || form.url !== targetUrl?.href || form.tabId !== targetTabId;
    for (const { control } of form?.controls.values() || []) control.disabled = busy;
    translation.disabled = allPages.disabled = busy || !canReadShopeeMarketing(targetUrl);
    sample.disabled = trialJson.disabled = close.disabled = busy;
    if (back) back.disabled = busy;
    stop.hidden = !busy;
    stop.disabled = Boolean(working?.signal.aborted);
    json.disabled = !report || busy;
    csv.disabled = !(report?.records.length || report?.sources?.length) || busy;
  }

  function clearResult() {
    report = form = null;
    reportPanel.hidden = preview.hidden = true;
    if (!working) {
      showNotices([]);
      showStatus("", "");
    }
  }

  function selectFeature(nextFeature) {
    if (feature !== nextFeature) clearResult();
    feature = nextFeature;
    title.textContent = feature?.title || defaultTitle;
    read.hidden = options.hidden = feature?.action === "draft";
    inspect.hidden = feature?.action === "read";
    inspect.classList.toggle("primary", feature?.action === "draft");
    inspect.classList.toggle("secondary", feature?.action !== "draft");
    for (const group of navigationGroups.filter(group => group.tagName === "DETAILS")) {
      group.open = Boolean(feature);
    }
    translationLabel.replaceChildren(translation, document.createTextNode(
      feature?.voucher ? "翻译非中文优惠券名称和说明" : "翻译非中文活动名称和说明",
    ));
    pageLabel.replaceChildren(allPages, document.createTextNode(
      feature?.voucher ? "读取当前筛选的各页" : defaultPageLabel,
    ));
  }

  function showTarget(tab) {
    const seller = sellerUrl(tab?.url);
    const nextUrl = isFeaturePath(seller, feature) ? seller : null;
    const nextTabId = nextUrl ? tab.id : null;
    if (targetTabId !== nextTabId || targetUrl?.href !== nextUrl?.href) clearResult();
    targetUrl = nextUrl;
    targetTabId = nextTabId;
    const knownShop = Boolean(seller && shopLink(seller, MARKETING_PATH));
    for (const link of navigationLinks) {
      const href = knownShop ? shopLink(seller, link.dataset.marketingPath) : null;
      link.hidden = !href || !isFeaturePath(new URL(href), feature);
      if (link.hidden) link.removeAttribute("href");
      else link.href = href;
    }
    for (const group of navigationGroups) {
      group.hidden = !group.querySelector("[data-marketing-path]:not([hidden])");
    }
    sellerFallback.hidden = knownShop;
    navigation.hidden = false;
    const pageTitle = typeof tab?.title === "string" ? tab.title.trim() : "";
    const hint = feature?.hint || "请打开 Shopee 活动中心或优惠券页面。";
    target.textContent = targetUrl ? pageTitle || "Shopee 卖家中心 · 营销" : tab?.id && !tab.url
      ? "请在 Chrome 工具栏允许 PageLens 读取当前站点。" + hint
      : hint;
    refreshControls();
    return Boolean(targetUrl);
  }

  function onProgress(progress) {
    const page = typeof progress === "number" ? progress : progress?.page ?? progress?.pages;
    const message = typeof progress === "string" ? progress : progress?.message
      || (page ? `已读取 ${page} 页，正在整理。` : "");
    if (message) showStatus("running", message);
  }

  async function operate(message, action) {
    if (working) return;
    if (isAgentBusy?.()) {
      showStatus("needs-review", "侧栏 Agent 正在执行其他任务。");
      return;
    }
    const controller = new AbortController();
    working = controller;
    refreshControls();
    showNotices([]);
    showStatus("running", message);
    try {
      const tab = await getTargetTab();
      if (!showTarget(tab)) throw new Error(feature?.hint || "请在 Shopee 营销页面重试。");
      controller.signal.throwIfAborted();
      await action({ tab, signal: controller.signal, onProgress });
      controller.signal.throwIfAborted();
    } catch (error) {
      const stopped = controller.signal.aborted;
      showStatus(stopped ? "cancelled" : "needs-review", stopped ? "已停止。" : noticeText(error));
    } finally {
      working = null;
      refreshControls();
    }
  }

  function showReport(result) {
    if (result.ok === false) throw new Error(noticeText(result.error) || "读取营销数据失败。");
    report = { ...result, records: Array.isArray(result.records) ? result.records : [] };
    reportTitle.textContent = result.title || "营销数据";
    summary.textContent = textValue(result.summary);
    summary.hidden = !summary.textContent;
    const sourceUrl = sellerUrl(result.sourceUrl || result.url);
    source.hidden = !sourceUrl;
    if (sourceUrl) {
      source.href = sourceUrl.href;
      source.title = sourceUrl.href;
    }
    renderTable(rows, report);
    reportPanel.hidden = false;
    showNotices(result.warnings);
    showStatus(report.records.length ? "verified" : "", `已整理 ${report.records.length} 条记录。`);
  }

  function showForm(result, tab) {
    if (result.ok === false) throw new Error(noticeText(result.error) || "无法探测当前表单。");
    const controls = new Map();
    const fragments = [];
    for (const field of result.fields || []) {
      const key = field.key || field.name || field.id;
      if (typeof key !== "string" || !key || controls.has(key)) continue;
      const wrapper = element("label");
      const label = element("span", (field.label || key) + (field.required ? " *" : ""));
      const control = makeFieldControl(field);
      control.disabled = Boolean(field.readOnly || field.disabled);
      const note = element("small", " " + key, "shopee-marketing-field-key");
      wrapper.append(label, note, control);
      fragments.push(wrapper);
      if (!control.disabled) controls.set(key, { control, original: fieldValue(control) });
    }
    fields.replaceChildren(...fragments);
    if (!fragments.length) fields.append(element("p", "当前页面没有发现可试填的字段。"));
    form = { url: tab.url, tabId: tab.id, controls, sample: result.sample };
    sample.hidden = !result.sample || !Object.keys(result.sample).length;
    trialJson.value = "";
    receipt.hidden = true;
    preview.hidden = false;
    showNotices([...(result.warnings || []), ...(result.blockers || [])]);
    showStatus(controls.size ? "verified" : "needs-review", `当前表单可试填 ${controls.size} 个字段。`);
  }

  function trialInput() {
    const entries = [...form.controls].flatMap(([key, { control, original }]) => {
      const value = fieldValue(control);
      return value === original ? [] : [[key, value]];
    });
    const draft = trialJson.value.trim();
    if (draft) {
      let overrides;
      try { overrides = JSON.parse(draft); } catch { throw new Error("试填 JSON 格式无效。"); }
      if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
        throw new Error("试填 JSON 需为对象。");
      }
      for (const [key, value] of Object.entries(overrides)) {
        if (!form.controls.has(key)) throw new Error(`字段「${key}」不在当前表单的可试填列表里。`);
        entries.push([key, value]);
      }
    }
    const values = Object.fromEntries(entries);
    if (!Object.keys(values).length) throw new Error("请先输入要试填的值，或载入演示数据。");
    return values;
  }

  read.addEventListener("click", () => void operate("正在读取营销数据…", async (context) => {
    const data = await readShopeeMarketing({
      ...context, getSettings, translate: translation.checked, allPages: allPages.checked,
      includeVouchers: feature?.voucher !== false,
    });
    await recheckTarget(context, data.lastReadPageUrl);
    showReport(data);
  }));
  inspect.addEventListener("click", () => void operate("正在探测当前表单…", async (context) => {
    const data = await inspectShopeeMarketingForm(context);
    await recheckTarget(context);
    showForm(data, context.tab);
  }));
  sample.addEventListener("click", () => {
    if (!form?.sample) return;
    trialJson.value = JSON.stringify(form.sample, null, 2);
    const details = trialJson.closest("details");
    if (details) details.open = true;
  });
  trialForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void operate("正在试填并回读…", async (context) => {
      if (!form || form.url !== context.tab.url || form.tabId !== context.tab.id) {
        throw new Error("表单标签页已变化，请重新探测。");
      }
      const result = await trialShopeeMarketingForm({ ...context, input: trialInput() });
      await recheckTarget(context);
      showReceipt(receipt, result);
      showNotices(result.warnings);
      const blocked = Boolean(result.ok === false || result.blockers?.length || result.error || result.status === "needs-review");
      showStatus(blocked ? "needs-review" : "verified", blocked ? "试填有待处理项。" : "试填完成，已回读表单。");
    });
  });
  for (const [button, ext, mime, serialize] of [
    [json, "json", "application/json", value => JSON.stringify(value, null, 2)],
    [csv, "csv", "text/csv", asCsv],
  ]) {
    button.addEventListener("click", async () => {
      const snapshot = report;
      if (!snapshot) return;
      showTarget(await getTargetTab().catch(() => null));
      if (report !== snapshot) return;
      const kind = report.kind === "vouchers" ? "vouchers" : "campaigns";
      const date = new Date().toISOString().slice(0, 10);
      downloadText(`shopee-${kind}-${date}.${ext}`, serialize(report), mime);
    });
  }
  async function recheckTarget({ tab, signal }, expectedUrl = tab.url) {
    signal.throwIfAborted();
    const current = await getTargetTab().catch(() => null);
    showTarget(current);
    if (current?.id !== tab.id || current.url !== expectedUrl) {
      throw new Error("营销标签页已变化。请返回要处理的页面后重试。");
    }
    signal.throwIfAborted();
  }
  stop.addEventListener("click", () => {
    working?.abort();
    refreshControls();
    showStatus("running", "正在停止…");
  });
  close.addEventListener("click", () => dialog.close());
  if (typeof onBack === "function") {
    back?.addEventListener("click", () => {
      if (working) return;
      dialog.close();
      onBack();
    });
  }
  dialog.addEventListener("cancel", (event) => { if (working) event.preventDefault(); });

  const updateTarget = () => {
    if (dialog.open && !working) void getTargetTab().then(showTarget).catch(() => {});
  };
  globalThis.chrome?.tabs?.onActivated?.addListener(updateTarget);
  globalThis.chrome?.tabs?.onUpdated?.addListener((_tabId, changes) => {
    if (changes.url || changes.status === "complete") updateTarget();
  });
  return async ({ mode, force = false } = {}) => {
    if (working || (mode && !Object.hasOwn(MARKETING_FEATURES, mode))) return false;
    selectFeature(mode ? MARKETING_FEATURES[mode] : null);
    const tab = await getTargetTab().catch(() => null);
    if (!showTarget(tab) && !force) return false;
    if (!dialog.open) dialog.showModal();
    return true;
  };
}

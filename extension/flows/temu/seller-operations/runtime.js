import { requireHostUrl } from "../../../lib/optional-permissions.js";
import { waitForTemu } from "../workflow-tab.js";
import { operateTemuEnrollment } from "./enrollment.js";
import { operateTemuSellerData } from "./page-state.js";
import { isTemuEnrollmentPage, temuSellerDataPage } from "./routes.js";

const PAGE_LIMIT = 25;
const PAGING_PARAMS = ["page", "pageNum", "pageNo", "pageIndex", "currentPage", "current", "pn"];

function filterUrl(url) {
  const normalized = new URL(url);
  for (const name of PAGING_PARAMS) normalized.searchParams.delete(name);
  normalized.searchParams.sort();
  return normalized.href;
}

export function canReadTemuSellerData(url, kind) {
  const page = temuSellerDataPage(url);
  return Boolean(page && (!kind || page.kind === kind));
}

async function bind(tab, accepts, signal) {
  const url = tab?.url;
  if (!url || !Number.isInteger(tab.id) || !accepts(url)) {
    throw new Error("Temu 页面已变化，请重新读取。");
  }
  signal?.throwIfAborted();
  const denied = await requireHostUrl(url, { tabId: tab.id, userGesture: true });
  if (denied) throw new Error(denied);
  return { id: tab.id, url, accepts, signal, documentId: null };
}

async function getBoundTab(target, { pagination = false, nextStep = false } = {}) {
  target.signal?.throwIfAborted();
  const tab = await chrome.tabs.get(target.id);
  if (!tab.active || !target.accepts(tab.url)) throw new Error("Temu 标签已切换、跳转或退出登录。");
  if (tab.url === target.url) return tab;
  if (pagination && filterUrl(tab.url) === filterUrl(target.url)) return tab;
  if (nextStep && new URL(tab.url).origin === new URL(target.url).origin) return tab;
  throw new Error("Temu 页面或查询条件已变化，请重新读取。");
}

async function inject(target, func, args, options = {}) {
  const tab = await getBoundTab(target, options);
  const locator = target.documentId ? { documentIds: [target.documentId] } : { frameIds: [0] };
  target.signal?.throwIfAborted();
  const [outcome] = await chrome.scripting.executeScript({
    target: { tabId: target.id, ...locator }, world: "ISOLATED", func,
    args: [{ ...args, expectedUrl: tab.url }],
  });
  target.signal?.throwIfAborted();
  if (outcome?.frameId !== 0 || !outcome.documentId ||
      (target.documentId && outcome.documentId !== target.documentId) || !outcome.result) {
    throw new Error("未能验证 Temu 标签的数据来源，请重新读取。");
  }
  target.documentId = outcome.documentId;
  target.url = tab.url;
  return outcome.result;
}

async function waitForPage(target, kind, { oldKey, opened = false } = {}) {
  const deadline = Date.now() + (opened ? 12000 : 5200);
  let snapshot;
  do {
    snapshot = await inject(target, operateTemuSellerData, { kind }, { pagination: Boolean(oldKey) });
    if (!snapshot.ok && snapshot.code !== "loading") throw new Error(snapshot.error);
    if (snapshot.ok && (oldKey
      ? snapshot.records.length && snapshot.pageKey !== oldKey
      : snapshot.records.length || (kind === "finance" || kind === "marketing") && Object.keys(snapshot.stats).length)) return snapshot;
    // The seller can show an empty table before its initial fetch returns rows.
    await waitForTemu(target.signal, 250);
  } while (Date.now() < deadline);
  if (oldKey) return null;
  if (snapshot?.ok) return snapshot;
  throw new Error(snapshot?.error || "Temu 页面数据加载超时。");
}

export async function readTemuSellerData({ tab, kind, allPages = false, opened = false, signal, onProgress } = {}) {
  kind ||= temuSellerDataPage(tab?.url)?.kind;
  const target = await bind(tab, url => canReadTemuSellerData(url, kind), signal);
  const sourceUrl = target.url;
  const first = await waitForPage(target, kind, { opened });
  const records = [];
  const pageKeys = new Set();
  const warnings = [...first.warnings];
  const filterKey = snapshot => JSON.stringify(snapshot.filters);
  let page = first;
  let pages = 0;
  function append() {
    pages++;
    pageKeys.add(page.pageKey);
    records.push(...page.records.map(row => ({ ...row, page: page.page || pages })));
    onProgress?.({ pages, count: records.length });
  }
  append();
  while (allPages && page.next && pages < PAGE_LIMIT) {
    try {
      const advance = await inject(target, operateTemuSellerData, {
        kind, action: "next-page", expectedPageKey: page.pageKey,
      });
      if (!advance.ok) throw new Error(advance.error);
      const result = await waitForPage(target, kind, { oldKey: page.pageKey });
      if (!result || pageKeys.has(result.pageKey)) throw new Error("翻页后数据没有更新。");
      if (filterKey(result) !== filterKey(first)) throw new Error("翻页时筛选条件发生变化。");
      page = result;
      warnings.push(...page.warnings);
      append();
    } catch (error) {
      signal?.throwIfAborted();
      warnings.push(error.message + " 已保留之前读取的记录。");
      break;
    }
  }
  if (page.next && pages === PAGE_LIMIT) warnings.push("已到每次读取 25 页的上限。");
  return {
    platform: "temu", kind, sourceUrl, title: first.title, collectedAt: new Date().toISOString(),
    pages, total: first.total, hasMore: page.next, records, filters: first.filters, sections: first.sectionHeadings,
    stats: first.stats, overview: first.overview, emptyMessage: first.emptyMessage,
    warnings: [...new Set(warnings)],
  };
}

export async function inspectTemuEnrollment({ tab, signal } = {}) {
  const target = await bind(tab, isTemuEnrollmentPage, signal);
  const snapshot = await inject(target, operateTemuEnrollment, {});
  if (!snapshot.ok) throw new Error(snapshot.error);
  return { ...snapshot, tabId: target.id, url: target.url, documentId: target.documentId };
}

export async function trialTemuEnrollment({ tab, snapshot, values, next = false, signal } = {}) {
  if (!snapshot?.ready || snapshot.tabId !== tab?.id || snapshot.url !== tab.url || !snapshot.documentId) {
    throw new Error("活动报名表已切换，请重新读取。");
  }
  const target = await bind(tab, isTemuEnrollmentPage, signal);
  target.documentId = snapshot.documentId;
  const applied = await inject(target, operateTemuEnrollment, {
    action: "fill", expectedKey: snapshot.key, items: values,
  });
  if (!applied.ok) throw new Error(applied.error);
  const confirmed = await inject(target, operateTemuEnrollment, {});
  if (!confirmed.ok || !confirmed.ready || confirmed.key !== snapshot.key) {
    throw new Error("活动报名表在填写后发生变化，请检查页面中的现有值。");
  }
  const expected = new Map(values.map(item => [item.id, item]));
  const verified = [];
  const failures = [];
  for (const item of confirmed.items.filter(row => expected.has(row.id))) {
    const input = expected.get(item.id);
    const same = item.selected && item.price && item.inventory &&
      Number(item.price) === Number(input.price) && Number(item.inventory) === Number(input.inventory);
    (same ? verified : failures).push({ id: item.id, label: item.label });
  }
  const receipt = { ...confirmed, verified, failures, tabId: target.id, url: target.url, documentId: target.documentId };
  if (!next || !receipt.canNext || receipt.failures.length || !receipt.verified.length) {
    return { ...receipt, advanced: false, stopped: true };
  }

  const advanced = await inject(target, operateTemuEnrollment, {
    action: "next", expectedKey: receipt.key, items: values,
  });
  if (!advanced.ok) return { ...receipt, advanced: false, stopped: true, reason: advanced.error };
  target.documentId = null;
  const following = await getBoundTab(target, { nextStep: true });
  return { ...receipt, advanced: true, stopped: false, url: following.url };
}

function csvCell(input) {
  const value = String(input ?? "");
  const formula = typeof input === "string" && /^[\s\u0000-\u001f]*[=+@-]/u.test(value);
  return '"' + ((formula ? "'" : "") + value).replaceAll('"', '""') + '"';
}

export function temuSellerCsv(report) {
  const records = report.records.map(record => ({
    "记录类型": "记录", "表格": record.table, "页码": record.page,
    ...Object.fromEntries(Object.entries(record.fields).map(([key, value]) => ["页面 · " + key, value])),
  }));
  for (const [metric, value] of Object.entries(report.stats || {})) {
    records.push({ "记录类型": "指标", "项目": metric, "内容": value });
  }
  for (const item of report.overview || []) records.push({ "记录类型": "页面概况", "内容": item });
  records.push({
    "记录类型": "来源", "表格": report.title, "页码": report.pages,
    "来源": report.sourceUrl, "筛选": report.filters?.join(" · "),
    "内容": [report.emptyMessage, ...(report.warnings || [])].filter(Boolean).join(" · "),
  });
  const columns = [...new Set(records.flatMap(record => Object.keys(record)))];
  return "\ufeff" + [columns.map(csvCell).join(","), ...records.map(record =>
    columns.map(column => csvCell(record[column])).join(","))].join("\r\n");
}

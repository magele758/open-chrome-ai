import { requireHostUrl } from "../../lib/optional-permissions.js";
import { operateShopeeCampaignDraft } from "./campaign-draft/page-state.js";
import { readShopeeCampaigns } from "./campaign-data/page-state.js";
import { readShopeeSellerPromotions } from "./campaign-data/seller-promotions.js";
import { translateCampaigns } from "./campaign-data/translate.js";
import { operateShopeeVoucherDraft } from "./vouchers/draft.js";
import { readShopeeVouchers } from "./vouchers/page-state.js";

const origin = "https://seller.shopee.cn";
const overview = "/portal/marketing";
const sources = [
  { path: overview + "/cmt-cb/list/campaign", query: { source: "3" }, label: "官方活动", read: readShopeeCampaigns },
  { path: overview + "/cmt-cb/list", label: "商品提报", read: readShopeeCampaigns },
  { path: overview + "/list/discount", label: "折扣活动", read: readShopeeSellerPromotions },
  { path: overview + "/shop-flash-sale/list", label: "店铺限时抢购", read: readShopeeSellerPromotions },
  { path: overview + "/global-discount/list", label: "全球商品折扣", read: readShopeeSellerPromotions },
  { path: overview + "/vouchers/list", label: "优惠券", read: readShopeeVouchers },
];
const reads = new Map([{ path: overview, label: "推荐活动", read: readShopeeCampaigns }, ...sources]
  .map(source => [source.path, source]));
const drafts = new Map([
  [overview + "/discount/create", operateShopeeCampaignDraft],
  [overview + "/shop-flash-sale/create", operateShopeeCampaignDraft],
  [overview + "/global-discount/create", operateShopeeCampaignDraft],
  [overview + "/vouchers/new", operateShopeeVoucherDraft],
]);
const maxPages = 25;

function pageContext(value) {
  try {
    const url = new URL(value);
    const ids = url.searchParams.getAll("cnsc_shop_id");
    if (url.origin === origin && !url.username && !url.password && !url.hash && ids.length === 1 && /^\d+$/.test(ids[0])) {
      return { url: url.href, path: url.pathname.replace(/\/$/, ""), shopId: ids[0] };
    }
  } catch { /* Chrome can omit the URL before it grants site access. */ }
  return null;
}

export function canReadShopeeMarketing(url) {
  return reads.has(pageContext(url)?.path);
}

export function canInspectShopeeMarketing(url) {
  const page = pageContext(url);
  if (!drafts.has(page?.path)) return false;
  if (drafts.get(page.path) !== operateShopeeVoucherDraft) return true;
  const useCases = new URL(page.url).searchParams.getAll("usecase");
  return useCases.length === 1 && useCases[0] === "1";
}

function abortableDelay(signal, ms) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function bind(tab, supported, signal) {
  const page = pageContext(tab?.url);
  if (!page || !Number.isInteger(tab.id) || !supported.has(page.path)) {
    throw new Error("请打开带店铺信息的 Shopee 活动、优惠券列表或所支持的新建表单。");
  }
  signal?.throwIfAborted();
  const access = await requireHostUrl(page.url, { tabId: tab.id, userGesture: true });
  if (access) throw new Error(access);
  return { id: tab.id, ...page, signal, documentId: null };
}

async function inject(target, func, args, { canFollowPage = false } = {}) {
  target.signal?.throwIfAborted();
  const tab = await chrome.tabs.get(target.id);
  const page = pageContext(tab.url);
  if (!page || page.path !== target.path || page.shopId !== target.shopId ||
      (!canFollowPage && page.url !== target.url)) {
    throw new Error("Shopee 页面或店铺已变化，请重新打开对应流程。");
  }
  const frame = target.documentId ? { documentIds: [target.documentId] } : { frameIds: [0] };
  target.signal?.throwIfAborted();
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId: target.id, ...frame }, world: "MAIN", func, args: args(page.url),
  });
  target.signal?.throwIfAborted();
  if (!injected || injected.frameId !== 0 || !injected.documentId ||
      (target.documentId && target.documentId !== injected.documentId) || !injected.result) {
    throw new Error("无法确认 Shopee 标签页或读取结果，请重试。");
  }
  target.documentId = injected.documentId;
  target.url = page.url;
  return injected.result;
}

function readArgs(source, url, next) {
  const action = next ? "next-page" : "read";
  return source.read === readShopeeVouchers ? [url, { action }] : [url, action];
}

function needsLoad(snapshot) {
  return (snapshot.ok === false && /loading|unavailable/.test(snapshot.code)) ||
    (!snapshot.rows?.length && snapshot.warnings?.some(message => /加载/u.test(message)));
}

async function waitForSnapshot(target, source, previous, { followStartupUrl = false } = {}) {
  const stopAt = Date.now() + 4800;
  let snapshot;
  do {
    snapshot = await inject(target, source.read, url => readArgs(source, url, false), {
      canFollowPage: followStartupUrl || Boolean(previous),
    });
    const startupRace = followStartupUrl && snapshot.code === "page-changed";
    if (!startupRace && !needsLoad(snapshot) && (!previous || (snapshot.rows?.length && pageKey(snapshot) !== pageKey(previous)))) return snapshot;
    await abortableDelay(target.signal, 270);
  } while (Date.now() < stopAt);
  if (previous) return null;
  if (!needsLoad(snapshot)) return snapshot;
  if (snapshot.ok === false) throw new Error(snapshot.error);
  return snapshot;
}

function pageKey(snapshot) {
  return JSON.stringify([snapshot.meta?.page ?? snapshot.meta?.currentPage, snapshot.rows]);
}

async function collect(target, source, allPages, notify, { followStartupUrl = false } = {}) {
  const first = await waitForSnapshot(target, source, null, { followStartupUrl });
  if (!first || needsLoad(first) || first.ok === false || first.kind === "unsupported") {
    throw new Error(first?.error || first?.warnings?.[0] || "当前页面没有可读取的营销数据。");
  }
  let snapshot = first;
  const selectedFilter = page => page.meta?.filter || page.meta?.tabs?.find(tab => tab.selected)?.label;
  const filter = selectedFilter(first);
  let pages = 1;
  const hasNext = page => Boolean(page?.next || page?.meta?.hasNextPage);
  const warnings = [...(snapshot.warnings || [])];
  const records = [];
  const seen = new Set();
  function append(page) {
    const sourcePage = page.meta?.page ?? page.meta?.currentPage ?? pages;
    for (const row of page.rows || []) {
      records.push({
        ...row, source: source.label, sourceKind: first.kind,
        sourceUrl: page.meta?.url || page.url || target.url, sourcePage,
      });
    }
    seen.add(pageKey(page));
  }
  append(snapshot);
  while (allPages && hasNext(snapshot) && pages < maxPages) {
    try {
      const afterClick = await inject(target, source.read, url => readArgs(source, url, true));
      if (afterClick.ok === false || afterClick.changed === false) {
        warnings.push(afterClick.error || "页面未提供可识别的下一页。");
        break;
      }
      const next = await waitForSnapshot(target, source, snapshot);
      if (next && selectedFilter(next) !== filter) {
        warnings.push("翻页时筛选条件发生变化，已保留上一个筛选的记录。");
        break;
      }
      if (!next || seen.has(pageKey(next))) {
        warnings.push("翻页后数据没有更新，已保留当前读到的记录。");
        break;
      }
      snapshot = next;
      pages += 1;
      append(snapshot);
      notify?.({ message: `${source.label}已读取 ${pages} 页。` });
    } catch (error) {
      target.signal?.throwIfAborted();
      warnings.push(`翻页停止。 ${error.message}`);
      break;
    }
  }
  if (allPages && pages === maxPages && hasNext(snapshot)) {
    warnings.push(`已读取 ${maxPages} 页，请缩小筛选范围后继续。`);
  } else if (allPages && first.meta?.totalRecords > records.length && !hasNext(snapshot)) {
    warnings.push("页面显示的总数大于已读取记录数，请核对当前筛选和分页。");
  }
  return {
    kind: first.kind, label: source.label, title: first.title, records, pages, warnings, meta: first.meta || {},
    url: first.meta?.url || first.url || target.url,
  };
}

async function collectBackground(source, tab, target, notify) {
  const url = new URL(source.path, origin);
  for (const [key, value] of Object.entries(source.query || {})) url.searchParams.set(key, value);
  url.searchParams.set("cnsc_shop_id", target.shopId);
  let child;
  try {
    target.signal?.throwIfAborted();
    child = await chrome.tabs.create({ url: url.href, active: false, windowId: tab.windowId });
    const deadline = Date.now() + 12000;
    do {
      target.signal?.throwIfAborted();
      const state = await chrome.tabs.get(child.id);
      const landed = pageContext(state.url);
      if (state.status === "complete" && landed?.path === source.path && landed.shopId === target.shopId) {
        // Shopee's list can add its default filters after Chrome reports the tab loaded.
        return await collect({ ...landed, id: child.id, signal: target.signal, documentId: null }, source, true, notify, {
          followStartupUrl: true,
        });
      }
      if (state.status === "complete" && state.url?.startsWith("https:") && !landed) {
        throw new Error("页面需要重新登录或选择店铺。");
      }
      await abortableDelay(target.signal, 220);
    } while (Date.now() < deadline);
    throw new Error("页面加载超时或离开指定店铺。");
  } catch (error) {
    target.signal?.throwIfAborted();
    return { label: source.label, url: url.href, title: source.label, records: [], pages: 0, warnings: [error.message], failed: true, meta: {} };
  } finally {
    if (child?.id != null) await chrome.tabs.remove(child.id).catch(() => {});
  }
}

function sourceSummary(part) {
  const { stats, period, emptyMessage, voucherTypes } = part.meta;
  const metrics = Object.entries(stats || {}).map(([key, value]) => `${key} ${value}`).join(" · ");
  const selectedFilter = part.meta.filter || part.meta.tabs?.find(tab => tab.selected)?.label;
  return [
    `${part.label} · ${part.failed ? "读取失败" : `${part.records.length} 条，${part.pages} 页`}`,
    selectedFilter && `筛选 ${selectedFilter}`, period, metrics, emptyMessage,
    voucherTypes?.length && `可用类型 ${voucherTypes.map(type => type.name).join("、")}`,
  ].filter(Boolean).join(" · ");
}

export async function readShopeeMarketing({
  tab, getSettings, signal, onProgress, translate = true, allPages = false, includeVouchers = true,
}) {
  const target = await bind(tab, reads, signal);
  const sourcesReport = [];
  const combined = target.path === overview && allPages;
  if (combined) {
    // Official catalog supersedes the same cards in the marketing overview.
    const relevantSources = includeVouchers ? sources : sources.filter(source => source.read !== readShopeeVouchers);
    for (let i = 0; i < relevantSources.length; i += 2) {
      const batch = relevantSources.slice(i, i + 2);
      onProgress?.({ message: `正在读取${batch.map(source => source.label).join("和")}…` });
      const group = await Promise.allSettled(batch.map(source => collectBackground(source, tab, target, onProgress)));
      signal?.throwIfAborted();
      for (const result of group) {
        if (result.status === "rejected") throw result.reason;
        sourcesReport.push(result.value);
      }
    }
    if (sourcesReport[0].failed) {
      const recommended = await collect(target, reads.get(overview), false, onProgress);
      sourcesReport.unshift(recommended);
    }
  } else {
    sourcesReport.push(await collect(target, reads.get(target.path), allPages, onProgress));
  }
  let records = sourcesReport.flatMap(source => source.records);
  let translation = { status: "off", requested: 0, translated: 0, failed: 0 };
  const warnings = sourcesReport.flatMap(source => source.warnings.map(warning => `${source.label} · ${warning}`));
  if (translate && records.length) {
    onProgress?.({ message: "正在把非中文名称和说明翻译成中文…" });
    try {
      ({ records, translation } = await translateCampaigns(records, { settings: await getSettings?.(), signal }));
      if (translation.failed) warnings.push(`有 ${translation.failed} 条翻译未完成，已保留对应原文。`);
    } catch {
      signal?.throwIfAborted();
      translation.status = "failed";
      warnings.push("中文翻译暂不可用，已保留原文。");
    }
  }
  return {
    kind: combined ? "marketing-report" : sourcesReport[0].kind,
    title: combined ? "Shopee 营销数据汇总" : sourcesReport[0].title,
    shopId: target.shopId, sourceUrl: tab.url, lastReadPageUrl: target.url, capturedAt: new Date().toISOString(),
    scope: allPages ? "current-filters" : "current-page", records, translation, warnings,
    summary: sourcesReport.map(sourceSummary).join("\n"),
    sources: sourcesReport.map(({ records: rows, ...source }) => ({ ...source, count: rows.length })),
  };
}

async function getDraftState(target, operation, input) {
  const draft = drafts.get(target.path);
  return inject(target, draft, url => [{ expectedUrl: url, operation, ...(input ? { values: input } : {}) }]);
}

function presentDraft(result) {
  if (result.ok === false) return result;
  const voucher = result.kind === "voucher-draft";
  const fields = result.fields.map(field => ({
    ...field,
    readOnly: field.readOnly || field.editable === false,
    kind: "text",
  }));
  const examples = { name: "PageLens 试填 店铺优惠券", codeSuffix: "TEST1", discountAmount: "10", minimumSpend: "99", quantity: "20", perBuyerLimit: "1" };
  const sample = result.sample || (voucher
    ? Object.fromEntries(fields.filter(field => !field.readOnly && Object.hasOwn(examples, field.key)).map(field => [field.key, examples[field.key]]))
    : null);
  const warnings = [...(result.warnings || [])];
  if (voucher && result.meta?.codePrefix) warnings.push(`店铺固定优惠码前缀为 ${result.meta.codePrefix}。`);
  if (voucher) {
    const setup = [result.meta?.rewardType, result.meta?.discountType, ...(result.meta?.display || []), result.meta?.productScope];
    const description = setup.filter(Boolean).join(" · ");
    if (description) warnings.push(description);
  }
  return { ...result, fields, sample, warnings };
}

export async function inspectShopeeMarketingForm({ tab, signal }) {
  return presentDraft(await getDraftState(await bind(tab, drafts, signal), "read"));
}

export async function trialShopeeMarketingForm({ tab, input, signal }) {
  const target = await bind(tab, drafts, signal);
  const applied = await getDraftState(target, "fill", input);
  const fields = new Map((applied.fields || []).map(field => [field.key, field]));
  const receipt = { ...applied, filled: (applied.applied || []).map(key => ({ label: fields.get(key)?.label || key, value: fields.get(key)?.value })) };
  if (applied.ok === false) return receipt;
  const readback = await getDraftState(target, "read");
  const current = new Map((readback.fields || []).map(field => [field.key, field]));
  const pending = (applied.applied || []).filter(key => current.get(key)?.value !== fields.get(key)?.value);
  return {
    ...receipt,
    filled: receipt.filled.filter(field => !pending.some(key => fields.get(key)?.label === field.label)),
    ok: readback.ok !== false && !pending.length,
    blockers: [...(applied.blockers || []), ...pending.map(key => `${fields.get(key)?.label || key}未通过二次回读。`)],
    warnings: presentDraft(applied).warnings,
    ...(readback.ok === false ? { error: readback.error } : {}),
  };
}

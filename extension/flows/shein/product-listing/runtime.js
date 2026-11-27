import { sheinCategoryPage } from "./category-page.js";
import { sheinEditorPage } from "./editor-page.js";
import { sheinVariantPage } from "./variant-page.js";
import { sheinRowsPage } from "./rows-page.js";
import { sheinStockPage } from "./stock-page.js";
import { buildSheinImagePlan } from "./image-plan.js";
import { prepareSheinSwatch } from "./swatch-image.js";
import { rememberVerifiedSheinCategory, resolveSheinCategory } from "./category-search.js";
import { createListingFieldCache, recoverListingFields } from "../../shared/listing/adaptive-fields.js";
import { createListingAdvisor } from "../../shared/listing/listing-advisor.js";
import { getCdp } from "../../../lib/cdp.js";

const sellerOrigin = "https://sellerhub.shein.com";
export const sheinCategoryUrl = sellerOrigin + "/#/spmc/commodities-category/followsales-pro/list?externalSystem=spmp&last_page=page_commodities_list";
const editorPath = "/spmp/commoditiesInfo";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = (code, message) => ({ ok: false, code, message });
const clean = value => typeof value === "string" ? value.trim() :
  typeof value === "number" && Number.isFinite(value) ? String(value) : "";
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const array = value => Array.isArray(value) ? value : [];
const english = value => /[a-z]/iu.test(clean(value)) && !/\p{Script=Han}/u.test(clean(value)) ? clean(value) : "";
const key = value => clean(value).normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
const optionKey = value => {
  const name = key(value);
  const bilingual = /^([\p{Script=Han}]+)[a-z][a-z-]*$/u.exec(name);
  return ({ color: "颜色", colour: "颜色", size: "尺码" })[name] || bilingual?.[1] || name;
};
const unique = values => values.length === 1 ? values[0] : undefined;

function route(href) {
  try {
    const parsed = new URL(href);
    if (parsed.origin !== sellerOrigin || parsed.username || parsed.password || parsed.pathname !== "/") return "";
    const [path, query] = parsed.hash.slice(1).split("?");
    if (["/spmc/commodities-category/followsales-pro/list", "/spmp/commoditiesCategory/followsales-pro/list"].includes(path)) return "category";
    if (path === editorPath && new URLSearchParams(query).get("mode") === "add") return "editor";
    if (path === editorPath + "/add") return "opening";
    return "seller";
  } catch {
    return "";
  }
}

export function normalizeSheinListingInput(raw) {
  const seller = object(raw?.shein);
  const path = seller.categoryPath ?? raw?.categoryPath;
  const categoryPath = (Array.isArray(path) ? path : clean(path).split(/[>›＞]/u)).map(clean).filter(Boolean);
  const origin = clean(seller.origin ?? raw?.origin?.country ?? raw?.origin ?? raw?.countryOfOrigin);
  const brand = clean(seller.brand);
  const attributes = { ...object(raw?.attributes), ...object(seller.attributes) };
  const declaredHazard = clean(raw?.operatorNotes).split(/[\r\n；;。]/u).map(clean)
    .find(line => /^危险品分类\s*[:：]\s*该商品不属于危险品$/u.test(line));
  if (declaredHazard && !Object.keys(attributes).some(label => /危险品分类|hazardous materials classification/iu.test(label))) {
    attributes.危险品分类 = "该商品不属于危险品";
  }
  const groups = seller.variantGroups ?? raw?.variantGroups ?? (raw?.variant?.name ? [raw.variant] : []);
  const variantGroups = array(groups).flatMap(group => {
    const name = clean(group?.name);
    const options = array(group?.options).flatMap(option => {
      const source = clean(option?.value ?? option?.name ?? option?.option ?? option);
      const value = clean(option?.sheinValue) || source;
      return value ? [{ value, source, imagePath: clean(option?.imagePath),
        squareImagePath: clean(option?.squareImagePath), swatchImagePath: clean(option?.swatchImagePath) }] : [];
    });
    return name && options.length ? [{ name, options }] : [];
  });
  const suppliedSkus = array(seller.skus ?? raw?.skus);
  const packaging = object(seller.package ?? raw?.package);
  const skus = suppliedSkus.map(row => {
    const byName = new Map(Object.entries(object(row?.options)).map(([name, value]) => [optionKey(name), clean(value)]));
    const options = Array.isArray(row?.options) ? row.options.map(clean) : variantGroups.map(group => {
      const source = byName.get(optionKey(group.name));
      return group.options.find(option => key(option.source) === key(source))?.value || source || "";
    });
    return { options, sellerSku: clean(row?.sellerSku ?? row?.sku), priceUsd: clean(row?.priceUsd ?? seller.priceUsd),
      quantity: row?.quantity ?? row?.stock, siteLabel: clean(row?.stockSite),
      weightG: clean(row?.weightG ?? packaging.weightG), lengthCm: clean(row?.lengthCm ?? packaging.lengthCm),
      widthCm: clean(row?.widthCm ?? packaging.widthCm), heightCm: clean(row?.heightCm ?? packaging.heightCm),
      imagePath: clean(row?.imagePath) };
  });
  if (!skus.length && variantGroups.length && variantGroups.every(group => group.options.length === 1)) {
    skus.push({ options: variantGroups.map(group => group.options[0].value), sellerSku: clean(seller.skuCode),
      priceUsd: clean(seller.priceUsd), quantity: seller.quantity, siteLabel: clean(seller.stockSite), ...packaging });
  }
  return {
    englishTitle: clean(seller.englishTitle ?? raw?.englishTitle) || english(raw?.title),
    englishDescription: clean(seller.englishDescription ?? raw?.englishDescription) || english(raw?.description),
    sellerSku: clean(seller.sellerSku ?? seller.supplierCode ?? raw?.sellerSku ?? raw?.sku),
    origin: /^(?:进口|imported|unknown|未知)$/iu.test(origin) ? "" : origin,
    brand: /^(?:无品牌|nobrand|unbranded)$/iu.test(brand) ? "" : brand,
    categoryPath,
    attributes,
    imagePath: clean(seller.imagePath ?? raw?.imagePath),
    mainImages: array(seller.mainImages ?? raw?.mainImages).map(clean).filter(Boolean),
    detailImages: array(seller.detailImages ?? raw?.detailImages).map(clean).filter(Boolean),
    sharedGalleryImages: array(seller.sharedGalleryImages ?? raw?.sharedGalleryImages).map(clean).filter(Boolean),
    squareImagePath: clean(seller.squareImagePath ?? raw?.squareImagePath),
    swatchImagePath: clean(seller.swatchImagePath ?? raw?.swatchImagePath),
    variantGroups, skus, defaultSellerSku: clean(seller.defaultSku),
    sites: array(seller.sites).map(clean).filter(Boolean), dimensions: object(seller.dimensions),
  };
}

function pageOption(value, group) {
  const requested = key(value);
  if (!requested) return;
  const mapped = array(group?.matches).filter(match => key(match.requested) === requested);
  const expected = mapped.length ? key(unique(mapped)?.value) : requested;
  if (expected) return unique(array(group?.values).filter(name => key(name) === expected));
}

const rowId = options => JSON.stringify(array(options).map(key));
const hasRow = (rows, options) => array(rows).filter(row => rowId(row) === rowId(options)).length === 1;

async function waitForListingRows(inspect, { rows, primary, expectSupply, expectDefault, signal }) {
  const deadline = Date.now() + 5000;
  do {
    const snapshot = await inspect();
    if (!snapshot.ok) return snapshot;
    const tables = snapshot.tables || {};
    const mediaReady = primary.every(value => array(tables.media).filter(row => key(row[0]) === key(value)).length === 1);
    const rowsReady = rows.every(({ options }) => expectSupply ? hasRow(tables.supply, options) : hasRow(tables.package, options));
    if (mediaReady && rowsReady && (!expectDefault || tables.defaultSku) || Date.now() >= deadline) return snapshot;
    await wait(140);
    signal?.throwIfAborted();
  } while (true);
}

async function encodeImage({ file, name }) {
  if (!file?.size || file.size > 8 * 1024 * 1024 || !/^image\/(?:jpeg|png|gif)$/u.test(file.type)) {
    throw new Error("请使用 8 MB 以内的 JPEG、PNG 或 GIF 图片。");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 32768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  }
  return { name: name || file.name, type: file.type, base64: btoa(binary) };
}

function requireTab(tab, expected) {
  if (!Number.isInteger(tab?.id) || !route(tab.url) || tab.active === false || expected && tab.url !== expected) {
    throw new Error("当前 SHEIN 标签或页面已切换，请在目标页重新试填。");
  }
  return tab;
}

async function currentTab(tabId, expected, api, signal) {
  signal?.throwIfAborted();
  const tab = requireTab(await api.tabs.get(tabId), expected);
  signal?.throwIfAborted();
  return tab;
}

async function pageCall(api, tab, func, request, signal) {
  await currentTab(tab.id, tab.url, api, signal);
  const [entry] = await api.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    func,
    args: [{ ...request, href: tab.url }],
  });
  signal?.throwIfAborted();
  return entry?.result ?? fail("NO_PAGE_RESULT", "未收到 SHEIN 页面返回结果。");
}

async function waitForPage(api, tabId, stage, signal, fallback) {
  const deadline = Date.now() + 12000;
  do {
    signal?.throwIfAborted();
    const tab = await api.tabs.get(tabId);
    if (tab?.active === false || tab?.url && !["about:blank", "chrome://newtab/"].includes(tab.url) && !route(tab.url)) {
      throw new Error("SHEIN 标签已切换或已退出登录，请返回卖家后台重试。");
    }
    if (route(tab?.url) === stage && tab.status !== "loading") {
      return requireTab(tab);
    }
    await wait(120);
  } while (Date.now() < deadline);
  throw new Error(fallback);
}

async function editorCall(api, tab, request, signal) {
  const deadline = Date.now() + 8000;
  do {
    const result = await pageCall(api, tab, sheinEditorPage, request, signal);
    if (result.code !== "EDITOR_NOT_READY" || Date.now() >= deadline) return result;
    await wait(150);
  } while (true);
}

async function replayInventory(api, tab, request, signal, onNativeInput) {
  const page = (kind, index, cleanup = false) => pageCall(api, tab, sheinStockPage, { ...request, kind, index }, cleanup ? undefined : signal);
  const written = await page("fill");
  if (written.ok || !["STOCK_SAVE_UNVERIFIED", "STOCK_READBACK_MISMATCH"].includes(written.code)) return written;
  onNativeInput?.();
  const cdp = getCdp();
  const alreadyAttached = cdp.isAttached(tab.id);
  let opened = false;
  async function send(method, params) {
    await currentTab(tab.id, tab.url, api, signal);
    return cdp.send(tab.id, method, params);
  }
  async function click({ x, y }) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x, y });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x, y });
  }
  try {
    await currentTab(tab.id, tab.url, api, signal);
    await cdp.ensure(tab.id);
    const ready = await page("open");
    opened = true;
    if (!ready.ok) return ready;
    const modifiers = /Mac/iu.test(globalThis.navigator?.platform || "") ? 4 : 2;
    for (const [index, row] of request.rows.entries()) {
      const found = await page("focus", index);
      if (!found.ok) return found;
      await click(found.target);
      const focused = await page("focused", index);
      if (!focused.ok) return focused;
      const selectAll = { key: "a", code: "KeyA", modifiers, windowsVirtualKeyCode: 65, commands: ["selectAll"] };
      await send("Input.dispatchKeyEvent", { ...selectAll, type: "rawKeyDown" });
      await send("Input.dispatchKeyEvent", { key: "a", code: "KeyA", modifiers, type: "keyUp" });
      await send("Input.insertText", { text: String(row.quantity) });
    }
    const confirm = await page("confirm");
    if (!confirm.ok) return confirm;
    await click(confirm.target);
    return await page("verify");
  } catch (error) {
    signal?.throwIfAborted();
    return fail(error?.code || "STOCK_NATIVE_INPUT_FAILED", error.message || "未能核对 SHEIN 库存。");
  } finally {
    if (opened) await page("cancel", undefined, true).catch(() => {});
    if (!alreadyAttached && cdp.isAttached(tab.id)) await cdp.detach(tab.id);
  }
}

export async function openSheinListingEditor({ tabId, url, signal, useActiveTab = false, api = chrome } = {}) {
  const tab = await currentTab(tabId, url, api, signal);
  if (["category", "editor"].includes(route(tab.url))) {
    return { ok: true, stage: route(tab.url), tabId, url: tab.url };
  }
  const created = useActiveTab ? await api.tabs.update(tabId, { url: sheinCategoryUrl }) :
    await api.tabs.create({ url: sheinCategoryUrl, openerTabId: tabId, active: true });
  const next = await waitForPage(api, created.id, "category", signal, "未能打开 SHEIN 商品发布分类页。");
  return { ok: true, stage: "category", tabId: next.id, url: next.url, message: "已打开 SHEIN 商品发布分类页。" };
}

export async function inspectSheinListing({ tabId, url, signal, api = chrome } = {}) {
  const tab = await currentTab(tabId, url, api, signal);
  const stage = route(tab.url);
  if (stage === "category") return { ...await pageCall(api, tab, sheinCategoryPage, { kind: "inspect" }, signal), stage };
  if (stage === "editor") return { ...await editorCall(api, tab, { kind: "inspect" }, signal), stage };
  return fail("WORKFLOW_PAGE_REQUIRED", "请先打开 SHEIN 商品发布页，再读取当前分类或表单。");
}

export async function replaySheinListing({ tabId, url, input, images = [], referenceImages = images, allowAI = false,
  uploadRequested = images.length > 0,
  settings, signal, onStep, useActiveTab, api = chrome } = {}) {
  const product = normalizeSheinListingInput(input);
  const advisor = allowAI ? createListingAdvisor({ settings, product: input, referenceImages, signal }) : null;
  const report = label => onStep?.({ label, categoryPath: product.categoryPath });
  const fields = [];
  const items = [];
  const issues = [];
  let defaultSkuChoices;
  let tab = await currentTab(tabId, url, api, signal);
  const outcome = (error, label) => {
    if (error) issues.push({ label, code: error.code, message: error.message });
    return { ok: !error, tabId: tab.id, url: tab.url, categoryPath: product.categoryPath, fields, items, issues,
      ...(defaultSkuChoices?.length && { defaultSkuChoices }) };
  };

  if (!["category", "editor"].includes(route(tab.url))) {
    report("打开 SHEIN 商品发布分类页");
    const opened = await openSheinListingEditor({ tabId, url, signal, useActiveTab, api });
    if (!opened.ok) return outcome(opened, "商品发布");
    tab = await currentTab(opened.tabId, opened.url, api, signal);
  }
  if (route(tab.url) === "category") {
    report("核对 SHEIN 商品类目");
    const categoryPage = request => pageCall(api, tab, sheinCategoryPage, request, signal);
    const categoryAdvisor = advisor?.isAvailable ? advisor : null;
    const categoryModelStep = (label, method) => categoryAdvisor && (args => {
      report(label);
      return categoryAdvisor[method](args);
    });
    const category = product.categoryPath.length
      ? await categoryPage({ kind: "select", categoryPath: product.categoryPath, brand: product.brand })
      : await resolveSheinCategory({ callPage: categoryPage, input,
        suggestKeywords: categoryModelStep("让 AI 生成 SHEIN 类目搜索词", "categoryKeywords"),
        chooseCachedCategory: categoryModelStep("让 AI 核对店铺已用类目", "chooseCachedCategory"),
        chooseCategory: categoryModelStep("让 AI 从 SHEIN 搜索结果选择类目", "chooseCategory"),
        storage: api.storage?.local, signal });
    if (!category.ok) return outcome(category, "商品类目");
    if (!category.selectedPath?.length || !category.canAdvance) {
      return outcome(fail("CATEGORY_NOT_CONFIRMED", "请在 SHEIN 选择商品的末级类目后继续。"), "商品类目");
    }
    await rememberVerifiedSheinCategory(api.storage?.local, category);
    const advanced = await categoryPage({ kind: "advance", categoryPath: category.selectedPath, brand: product.brand });
    if (!advanced.ok) return outcome(advanced, "商品类目");
    tab = await waitForPage(api, tab.id, "editor", signal, "SHEIN 未进入发布表单，请核对类目和品牌。");
    product.categoryPath = category.selectedPath;
    items.push({ label: category.selectedPath.join(" › "), status: "verified" });
  } else if (!product.categoryPath.length) {
    const current = await editorCall(api, tab, { kind: "inspect" }, signal);
    if (!current.ok) return outcome(current, "商品类目");
    product.categoryPath = current.categoryPath || [];
  }
  report("填写基础信息和当前类目属性");
  const result = await editorCall(api, tab, { kind: "fill", input: product }, signal);
  if (!result.ok) return outcome(result, "商品表单");
  fields.push(...result.fields || []);
  items.push(...result.items || []);
  issues.push(...result.issues || []);
  const pinned = { categoryPath: product.categoryPath };
  report("填写商品规格和上架站点");
  const variant = await pageCall(api, tab, sheinVariantPage, { ...pinned, kind: "fill", input: product }, signal);
  if (!variant.ok) return outcome(variant, "商品规格");
  items.push(...variant.items || []);
  const defaultOnly = variant.defaultOnly === true;
  issues.push(...array(variant.issues).filter(issue => !defaultOnly || issue.code !== "SPEC_ALREADY_SET"));
  const primary = unique(array(variant.groups).filter(group => group.label === "主规格"));
  const primaryInput = product.variantGroups[0];
  const primaryValues = !defaultOnly && (!primaryInput || optionKey(primaryInput.name) === optionKey(primary?.name))
    ? (primaryInput ? primaryInput.options.map(option => pageOption(option.value, primary)).filter(Boolean) : array(primary?.values))
    : [];
  if (!defaultOnly && !primaryValues.length && !array(variant.issues).some(issue => /^(?:SPEC_|OPTION|MENU_)/u.test(issue.code))) {
    issues.push({ label: "主规格", code: "REQUIRED", message: "SHEIN 未回显主规格值，请先补齐主规格，随后才能填写 SKU 和图片。" });
  }
  const groups = primary ? [primary, ...array(variant.groups).filter(group => group !== primary && group.values?.length)] : [];
  const requestedGroups = product.variantGroups;
  const groupsAgree = !requestedGroups.length || requestedGroups.length === groups.length &&
    requestedGroups.every((group, index) => optionKey(group.name) === optionKey(groups[index]?.name));
  const activeSites = (variant.sites || []).filter(site => site.checked).map(site => site.name);
  if (!activeSites.length) issues.push({ label: "上架站点", code: "REQUIRED", message: "请指定当前商品的上架站点。" });
  const selectedDefault = defaultOnly && (product.defaultSellerSku
    ? unique(product.skus.filter(row => row.sellerSku === product.defaultSellerSku)) : unique(product.skus));
  const defaultAllowed = defaultOnly && (Boolean(selectedDefault) || !product.skus.length && !primaryInput);
  const describeSku = row => row.options.filter(Boolean).join(" / ") || row.sellerSku;
  if (defaultOnly && !defaultAllowed) {
    defaultSkuChoices = product.skus.filter(row => row.sellerSku &&
      product.skus.filter(other => other.sellerSku === row.sellerSku).length === 1)
      .map(row => ({ sellerSku: row.sellerSku, label: describeSku(row) }));
    issues.push({ label: "默认 SKU", code: "DEFAULT_SKU_SELECTION_REQUIRED", message: defaultSkuChoices.length
      ? "SHEIN 此类目只生成一个 SKC，请选择用于当前商品的规格。"
      : "SHEIN 此类目只生成一个 SKC，请在资料中提供一个有唯一货号的 SKU。" });
  }
  const candidates = defaultAllowed ? [{ ...(selectedDefault || {}), options: [] }] : primaryValues.length && groupsAgree ? product.skus.flatMap(row => {
    if (row.options.length !== groups.length) return [];
    const options = row.options.map((name, index) => pageOption(name, groups[index]));
    return options.every(Boolean) && primaryValues.some(value => key(value) === key(options[0])) ? [{ ...row, options }] : [];
  }) : [];
  if (primaryValues.length && candidates.length < product.skus.length) {
    issues.push({ label: "SKU 规格", code: "SKU_SPEC_UNVERIFIED",
      message: `有 ${product.skus.length - candidates.length} 个 SKU 的规格组合尚未在 SHEIN 核对。` });
  }
  const rowIds = candidates.map(row => rowId(row.options));
  if (rowIds.length !== new Set(rowIds).size) return outcome(fail("SKU_DUPLICATE", "存在规格完全相同的多行 SKU，请核对资料。"), "SKU");
  let defaultSku = "";
  const rowPin = () => ({ ...pinned, ...(defaultSku && { defaultSku }) });
  const inspectRows = () => pageCall(api, tab, sheinRowsPage, { ...rowPin(), kind: "inspect" }, signal);
  let rows = [];
  if (primaryValues.length || defaultAllowed) {
    report("等待 SHEIN 生成规格图片和 SKU 表格");
    const waitForRows = () => waitForListingRows(inspectRows, { rows: candidates, primary: primaryValues,
      expectSupply: activeSites.length > 0, expectDefault: defaultAllowed, signal });
    let current = await waitForRows();
    if (!current.ok) return outcome(current, "SKU 表格");
    const beforeRefresh = current.tables?.defaultPackageSku;
    if (defaultAllowed && !current.tables?.defaultSku && beforeRefresh &&
        product.sites.length === 1 && activeSites.length === 1 && product.sites[0] === activeSites[0]) {
      report("刷新 SHEIN 默认规格对应的站点表格");
      const refreshed = await pageCall(api, tab, sheinVariantPage, { ...pinned, kind: "refreshSite", input: { sites: product.sites } }, signal);
      if (refreshed.ok) current = await waitForRows();
      else if (refreshed.code !== "SITE_REFRESH_NOT_NEEDED") issues.push({ label: "上架站点", code: refreshed.code, message: refreshed.message });
    }
    if (!current.ok) return outcome(current, "SKU 表格");
    const existingSellerSku = clean(current.tables?.defaultSellerSku);
    const conflicts = defaultAllowed && existingSellerSku && selectedDefault?.sellerSku && existingSellerSku !== selectedDefault.sellerSku;
    if (conflicts) {
      issues.push({ label: "默认 SKU", code: "SKU_DEFAULT_ALREADY_BOUND", message:
        `当前 SHEIN 商品已有 SKU「${existingSellerSku}」，请另开商品填写其他规格。` });
    } else if (defaultAllowed && (!beforeRefresh || beforeRefresh === current.tables?.defaultSku)) {
      defaultSku = current.tables?.defaultSku || "";
    }
    if (!defaultAllowed || defaultSku) {
      rows = candidates.filter(({ options }) => hasRow(current.tables?.supply, options) || hasRow(current.tables?.package, options));
    }
    if (!conflicts && rows.length < candidates.length) issues.push({ label: "SKU 表格", code: "SKU_ROWS_NOT_READY",
      message: `SHEIN 未生成 ${candidates.length - rows.length} 个规格对应的唯一 SKU 行。` });
    if (defaultSku && rows.length && product.skus.length > 1) {
      issues.push({ label: "默认 SKU", code: "DEFAULT_SKU_ONLY", message:
        `SHEIN 此类目只生成一个 SKC，本页使用「${describeSku(selectedDefault)}」。其余规格需另建商品。` });
    }
  }
  report("填写价格、包装和产品尺寸");
  const table = await pageCall(api, tab, sheinRowsPage, {
    ...rowPin(), kind: "fill", rows, dimensions: product.dimensions, skcTitle: product.englishTitle,
    expectSupply: activeSites.length > 0,
  }, signal);
  if (!table.ok) return outcome(table, "SKU 表格");
  items.push(...table.items || []);
  const pendingSupply = (table.issues || []).filter(issue => issue.supply);
  issues.push(...(table.issues || []).filter(issue => !issue.supply));
  const requestedStock = rows.filter(row => row.quantity !== undefined && row.quantity !== null && row.quantity !== "");
  const stock = requestedStock.filter(row => hasRow(table.tables?.supply, row.options)).map(row => ({
    options: row.options, quantity: row.quantity, siteLabel: row.siteLabel || (activeSites.length === 1 ? activeSites[0].replace(/站$/u, "") : ""),
  }));
  if (stock.length < requestedStock.length) issues.push({ label: "库存", code: "SKU_STOCK_ROWS_NOT_READY",
    message: `SHEIN 尚未显示 ${requestedStock.length - stock.length} 个可核对的库存行。` });
  if (stock.length) {
    report("填写并核对各规格库存");
    const inventory = await replayInventory(api, tab, { ...rowPin(), rows: stock }, signal, () => report("用浏览器原生输入复核库存"));
    if (inventory.ok) {
      items.push(...inventory.items || []);
      issues.push(...inventory.issues || []);
    } else issues.push({ label: "库存", code: inventory.code, message: inventory.message });
  }
  let imageProduct = product;
  if (defaultSku) {
    const option = unique(array(primaryInput?.options).filter(entry => key(entry.value) === key(selectedDefault?.options[0])));
    imageProduct = { ...product, variantGroups: option ? [{ ...primaryInput, options: [option] }] : [],
      ...(product.skus.length > 1 && { imagePath: selectedDefault?.imagePath, mainImages: [], squareImagePath: "", swatchImagePath: "" }) };
  }
  const canBindImages = primaryValues.length || defaultSku;
  const plan = uploadRequested && canBindImages ? buildSheinImagePlan({ product: imageProduct, variant: { ...variant, groups },
    rows, images, tables: table.tables, defaultSku }) : { issues: [], tasks: [] };
  if (uploadRequested && (!canBindImages || !images.length)) {
    issues.push({ label: "商品图片", code: "MEDIA_UPLOAD_NOT_BOUND", message: !images.length
      ? "已勾选上传图片，但本次未读取到图片文件。" : "已勾选上传图片，但尚无可安全匹配的规格图片行。" });
  }
  issues.push(...plan.issues);
  const uploads = new Map();
  for (const { role, options, image, deriveSwatch } of plan.tasks) {
    const id = JSON.stringify([role, options]);
    if (!uploads.has(id)) uploads.set(id, { role, options, deriveSwatch, images: [] });
    uploads.get(id).images.push(image);
  }
  const mediaLabels = { detail: "细节图", square: "方形图", swatch: "色块图", variant: "SKU 图" };
  for (const { role, options, deriveSwatch, images: selected } of uploads.values()) {
    const label = (options.join(" / ") || "默认 SKU") + " · " + mediaLabels[role];
    report("上传并核对 " + label);
    let files;
    try {
      if (role === "swatch") {
        const file = await prepareSheinSwatch(selected[0].file, { derive: deriveSwatch });
        files = [await encodeImage({ file })];
      } else files = await Promise.all(selected.map(encodeImage));
    }
    catch (error) { issues.push({ label, code: "IMAGE_FORMAT", message: error.message }); continue; }
    const uploaded = await pageCall(api, tab, sheinRowsPage, {
      ...rowPin(), kind: "upload", upload: { role, options, files },
    }, signal);
    if (uploaded.ok) {
      items.push({ label: `${label}（${files.length} 张）`, status: uploaded.status || "verified" });
    } else {
      issues.push({ label, code: uploaded.code, message: uploaded.message });
    }
  }
  if (pendingSupply.length) {
    const retryRows = rows.flatMap(row => {
      const target = JSON.stringify(row.options);
      const fields = pendingSupply.filter(issue => JSON.stringify(issue.supply.options) === target)
        .map(({ supply }) => [supply.key, row[supply.key]]);
      return fields.length ? [{ options: row.options, ...Object.fromEntries(fields) }] : [];
    });
    if (retryRows.length) {
      report("复核刚加载的价格与商家 SKU");
      const retry = await pageCall(api, tab, sheinRowsPage, {
        ...rowPin(), kind: "retrySupply", rows: retryRows, expectSupply: activeSites.length > 0,
      }, signal);
      if (retry.ok) {
        items.push(...retry.items || []);
        issues.push(...retry.issues || []);
      } else issues.push(...pendingSupply);
    } else issues.push(...pendingSupply);
  }
  report("核对当前表单");
  const review = async () => {
    const snapshot = await editorCall(api, tab, { kind: "review", input: pinned }, signal);
    if (!snapshot.ok) return snapshot;
    const chosen = snapshot.fields.filter(field => field.type === "select" && [].concat(field.value).some(Boolean));
    return { ...snapshot, fields: snapshot.fields.map(field => ({ ...field, dependency: JSON.stringify(chosen
      .filter(other => other.key !== field.key).map(({ key, value }) => [key, value])) })) };
  };
  let final = await review();
  if (!final.ok) return outcome(final, "SHEIN 页面");
  const repairedKeys = new Set();
  if (advisor) {
    try {
      const recovery = await recoverListingFields({
        snapshot: final, read: review, signal, includeOptional: true,
        cache: createListingFieldCache({ storage: api.storage?.local }),
        scope: { platform: "shein", store: final.storeKey, market: activeSites.join("/"), categoryPath: product.categoryPath },
        async readOptions(field) {
          const read = await editorCall(api, tab, { kind: "options", input: { ...pinned, fieldKey: field.key } }, signal);
          if (["MENU_STILL_OPEN", "PAGE_CHANGED", "CATEGORY_CHANGED", "MODAL_BLOCKED"].includes(read.code)) throw new Error(read.message);
          return read.options;
        },
        apply: values => editorCall(api, tab, { kind: "repair", input: { ...pinned, values, includeOptional: true } }, signal),
        suggest: advisor.fields,
        onPhase: () => report("根据商品资料补齐当前表单"),
      });
      final = recovery.state;
      if (!final?.ok) return outcome(final || fail("REVIEW_UNAVAILABLE", "未读到最新表单。"), "SHEIN 页面");
      items.push(...recovery.items);
      issues.push(...recovery.issues);
      for (const item of recovery.items) repairedKeys.add(item.key);
    } catch (error) {
      signal?.throwIfAborted();
      issues.push({ label: "上品助手", code: "ASSIST_UNAVAILABLE", message: error.message || "无法补齐当前表单。" });
    }
  }
  fields.splice(0, fields.length, ...final.fields);
  const blank = field => field.type === "checkbox" ? !field.value : ![].concat(field.value).some(value => clean(value));
  for (const field of fields) {
    const pending = field.error || field.required && blank(field);
    if (!pending && repairedKeys.has(field.key)) {
      for (let index = issues.length - 1; index >= 0; index--) if (issues[index].key === field.key) issues.splice(index, 1);
    } else if (pending && !issues.some(issue => issue.key === field.key)) {
      issues.push({ key: field.key, label: field.label, code: "FIELD_NEEDS_REVIEW", message: field.error || "SHEIN 当前类目要求填写此项。" });
    }
  }
  if (advisor && referenceImages.length && !advisor.canInspectImages &&
      fields.some(field => /材质|\bmaterials?\b/iu.test(field.label) && !/危险品|hazardous/iu.test(field.label) &&
        (field.error || field.required && blank(field)))) {
    issues.push({ label: "商品材质", code: "VISION_UNAVAILABLE", message: "当前未配置识图模型，可补充材质说明或在设置中配置识图模型。" });
  }
  const mediaReview = await inspectRows();
  if (!mediaReview.ok) return outcome(mediaReview, "图片核对");
  for (const issue of mediaReview.validation || []) {
    if (!issues.some(existing => existing.label === issue.label && existing.message === issue.message)) issues.push(issue);
  }
  await currentTab(tab.id, tab.url, api, signal);
  return outcome();
}

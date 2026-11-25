const ORIGIN = 'https://seller.shopee.cn';
const NEW = '/portal/mtsku/new';
const GLOBAL_LIST = '/portal/product/mtsku/list';
const SHOP_LIST = '/portal/product/list/all';
const PUBLISH = '/portal/product-distribute/single-product-publish/';
const RECORDS = '/portal/product-distribute/publish-record';
const clean = value => String(value ?? '').trim().replace(/\s+/gu, ' ');
const ledgerKey = (shopId, sku) => `pl.shopee.submission.v1.${shopId}.${encodeURIComponent(sku)}`;
const globalListUrl = shopId => `${ORIGIN}${GLOBAL_LIST}?cnsc_shop_id=${shopId}&page=1&size=48`;
const PENDING_CREATE_MIN_AGE = 5 * 60 * 1000;
const CREATE_RETRY_SETTLE_MS = 1000;
const CREATE_FOCUS_WAIT_MS = 1600;
const sameNumber = (value, expected) => clean(value) !== '' && Number(value) === Number(expected);

function salesAndShippingMatch(form, input, expectedRows = []) {
  const rows = form.variant?.rows ?? [];
  if (rows.length !== expectedRows.length) return false;
  if (expectedRows.length) {
    const options = form.variant?.options ?? [];
    if (options.length !== expectedRows.length || expectedRows.some(expected => {
      const matches = rows.filter(row => row.option === expected.option);
      const row = matches[0];
      return !options.includes(expected.option) || matches.length !== 1 || row.sku !== expected.sku ||
        !sameNumber(row.price, expected.price) || !sameNumber(row.quantity, expected.quantity) ||
        expected.imageVerified && !row.image?.present;
    })) return false;
  } else if (form.fields.variantName || form.variant?.options?.length) return false;
  const keys = ['weight', 'width', 'length', 'height', 'shipDays'];
  if (!expectedRows.length) keys.push('price', 'quantity');
  return keys.every(key => input[key] == null || sameNumber(form.fields[key]?.value, input[key]));
}

function target(url, shopId) {
  try {
    const parsed = new URL(url);
    const shops = parsed.searchParams.getAll('cnsc_shop_id');
    return parsed.origin === ORIGIN && shops.length === 1 && shops[0] === String(shopId) ? parsed : null;
  } catch {
    return null;
  }
}

// Runs in the seller tab. All mutations are bound to an exact page, SKU and control.
export function sellerSubmitPage({ action, expectedUrl, title, sku, expectedPage, allowCleanRetry = false,
  allowReviewSummary = false }) {
  const trim = value => String(value ?? '').trim().replace(/\s+/gu, ' ');
  const visible = el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible' &&
    !el.closest('[hidden],[inert],[aria-hidden=true]');
  const nodes = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);
  const unique = values => values.length === 1 ? values[0] : null;
  const label = el => trim(el.innerText ?? el.textContent);
  const buttons = (root, text) => nodes(root, 'button').filter(el => label(el) === text &&
    !el.disabled && !el.closest('[aria-disabled=true],.disabled,.eds-button--disabled'));
  const modals = nodes(document, '.eds-modal__content,[role=dialog],dialog[open]').filter(el =>
    !el.parentElement?.closest('.eds-modal__content,[role=dialog],dialog[open]'));
  const body = trim(document.body.innerText ?? document.body.textContent);
  if (location.href !== expectedUrl || location.origin !== 'https://seller.shopee.cn') return { stage: 'page-changed' };
  const path = location.pathname;
  if (path === '/portal/mtsku/new') {
    const field = key => unique(nodes(document, '.edit-row').filter(row => {
      const text = trim(row.querySelector(':scope > .edit-label')?.textContent).replace(/^[*＊]\s*/u, '');
      return text === key;
    }))?.querySelector('input:not([type=hidden])');
    const titlePresent = trim(field('商品名称')?.value) === title;
    const skuPresent = !sku || trim(field('全球商品货号')?.value) === sku;
    const summaryPattern = /[1-9]\d*\s*个错误需调整/u;
    const reviewSummary = body.match(summaryPattern)?.[0];
    const fieldSummary = body.match(/仍有\s*[1-9]\d*\s*个必填字段为空[^。]*。?/u)?.[0];
    const failedRequest = body.match(/(?:创建|提交)失败[^。]*。?/u)?.[0];
    const notices = nodes(document, '.eds-message--error,.eds-toast,[role=alert]').map(label);
    const requests = reviewSummary ? [...notices, body] : notices;
    const requestError = requests.map(text =>
      text.match(/(?:(?:操作|请求|提交)(?:过于|太)?频繁|网络(?:异常|错误)|请求超时)[^。]*。?/u)?.[0]).find(Boolean);
    const inlineErrors = nodes(document, '.eds-form-item__error,.eds-input__error')
      .filter(el => el.closest('.edit-row,.product-sales-info,.mtsku-product-shipping'));
    const toastErrors = nodes(document, '.eds-message--error').map(label)
      .filter(text => text && text.replace(/[。！!]$/u, '') !== reviewSummary);
    const fieldErrors = [...new Set([...inlineErrors.map(label), ...toastErrors].filter(Boolean))].slice(0, 3);
    const formSection = '.edit-row,.product-sales-info,.mtsku-product-shipping';
    const invalidField = nodes(document, '[aria-invalid=true],.eds-form-item--error,.eds-input--error,.eds-selector--error')
      .some(el => el.closest(formSection));
    const red = color => {
      const [r = 0, g = r, b = r, opacity = 1] = color.match(/\d+(?:\.\d+)?/gu)?.map(Number) ?? [];
      return opacity > 0 && r >= 150 && r > g + 65 && r > b + 65;
    };
    const inForm = el => el.closest(formSection) && !el.closest('.eds-popper,.eds-modal');
    const busy = nodes(document,
      '[aria-busy=true],.eds-spin--spinning,.eds-react-spin-spinning,.eds-button--loading,.eds-button.is-loading').length > 0 ||
      /正在(?:创建|提交)|(?:创建|提交)中/u.test(body);
    const accepted = nodes(document, '.eds-message--success,.eds-toast,[role=alert],[aria-live=polite]').some(el =>
      /(?:创建|提交)成功|已(?:提交|创建)/u.test(label(el)));
    const paintOnly = action === 'read' && !busy && !accepted && !modals.length && titlePresent && skuPresent &&
      !reviewSummary && !fieldSummary && !inlineErrors.length && !invalidField;
    const paintedBorder = paintOnly && nodes(document, 'input,.eds-input,.eds-selector,textarea').some(el => {
      if (!inForm(el) || el.contains(document.activeElement)) return false;
      const style = getComputedStyle(el);
      return red(style.borderTopColor) && !['none', 'hidden'].includes(style.borderTopStyle) &&
        Number.parseFloat(style.borderTopWidth) > 0;
    });
    const paintedMessage = paintOnly && !paintedBorder && [...document.querySelectorAll('p,small,span,div')].find(el => {
      if (!inForm(el) || el.closest('.edit-label')) return false;
      const text = trim([...el.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join(' '));
      return /(?:请(?:输入|填写|选择|上传).+|不可空白|不能为?空|超出范围|out of range|is required|please (?:enter|select|upload).+)/iu.test(text) &&
        visible(el) && red(getComputedStyle(el).color);
    });
    const error = [failedRequest || requestError || fieldSummary, reviewSummary, ...fieldErrors, paintedMessage && label(paintedMessage)]
      .filter(Boolean).join(' · ').slice(0, 300);
    const button = unique(buttons(document, ['publish', 'prepare-publish'].includes(action) ? '创建并发布' : '创建'));
    const foreground = document.visibilityState === 'visible';
    const ready = titlePresent && skuPresent && !busy && !accepted && !modals.length;
    const fieldRejection = Boolean(!failedRequest && !requestError && !toastErrors.length &&
      (fieldSummary || inlineErrors.length || invalidField || paintedBorder || paintedMessage));
    const reviewOnly = Boolean(reviewSummary && !failedRequest && !requestError && !fieldSummary &&
      !fieldErrors.length && !invalidField);
    const retryable = Boolean(reviewOnly && sku && ready && button);
    if (['prepare-create', 'prepare-publish'].includes(action) && foreground && ready && button) {
      // A frontend pointer click moves focus off the last edited control before submitting.
      button.focus({ preventScroll: true });
    }
    const cleanForm = !error && !invalidField;
    const verifiedReview = allowReviewSummary && reviewOnly;
    if (foreground && ready && button && (
      action === 'create' && (cleanForm || verifiedReview) ||
      action === 'publish' && cleanForm ||
      action === 'retry-create' && sku && (verifiedReview || allowCleanRetry && cleanForm)
    )) {
      button.click();
      return { stage: 'clicked' };
    }
    const unavailable = ['create', 'publish', 'retry-create'].includes(action) && !button && 'Shopee 提交按钮尚不可用。';
    return { stage: 'form', foreground, busy, accepted, reviewOnly, fieldRejection, retryable, buttonReady: Boolean(button),
      error: error || (modals.length ? label(modals[0]).slice(0, 160) : unavailable || undefined) };
  }
  if (/^\/portal\/product\/(?:mtsku\/list|list(?:\/all)?)\/?$/u.test(path)) {
    const global = path.includes('/mtsku/');
    const rows = [...document.querySelectorAll('tr,[role=row]')].filter(row =>
      !row.closest('[hidden],[inert],[aria-hidden=true]') && !row.querySelector('tr,[role=row]'));
    const records = [];
    const inventory = global && ['list-receipts', 'list-next-page'].includes(action);
    for (const row of rows) {
      const record = label(row) || trim(row.textContent);
      const match = record.match(/全球商品货号\s*[：:]\s*(.*?)\s*商品\s*ID\s*[：:]\s*(\d+)/iu);
      if (!match) continue;
      if (inventory || (sku ? match[1] === sku : nodes(row, 'a').some(a => label(a) === title))) {
        records.push({ sku: match[1], itemId: match[2] });
      }
    }
    if (inventory) {
      const count = unique([...body.matchAll(/(?:^|\s)([\d,]+)\s*全球商品(?=\s|$)/gu)]);
      const total = count ? Number(count[1].replace(/,/gu, '')) : null;
      const loading = modals.length || nodes(document, '[aria-busy=true],.eds-spin--spinning,.eds-react-spin-spinning').length;
      const unfiltered = [...new URL(location.href).searchParams.keys()].every(key => ['cnsc_shop_id', 'page', 'size'].includes(key)) &&
        !nodes(document, 'input[placeholder="请输入单字的至少首 2 个字符"]').some(el => trim(el.value));
      const identified = !loading && unfiltered && body.includes('新增全球商品') &&
        (total === 0 && records.length === 0 && body.includes('找不到商品') || total > 0 && records.length > 0);
      const pager = unique(nodes(document, '.eds-react-pagination,.eds-pagination'));
      const selected = pager && unique(nodes(pager, '[aria-current=page],.eds-react-pagination-item-active,.eds-pagination__item--active'));
      const page = selected ? Number(label(selected)) : null;
      const next = pager && unique(nodes(pager, 'button,[role=button]').filter(el =>
        !el.disabled && !el.closest('[aria-disabled=true],.eds-react-pagination-disabled,.eds-pagination__disabled') &&
        /^(?:下一页|Next Page|Next)$/iu.test(el.getAttribute('aria-label') || el.title || label(el))));
      if (action === 'list-next-page' && identified && page === expectedPage && next) {
        next.click();
        return { stage: 'list-advanced' };
      }
      return { stage: 'list-receipts', records, total: identified ? total : null, page, hasNext: Boolean(next) };
    }
    const ids = new Set(records.map(record => record.itemId));
    if (ids.size > 1) return { stage: 'ambiguous' };
    if (ids.size === 1) return { stage: global ? 'global-item' : 'shop-item', itemId: [...ids][0] };
    if (['prepare-search', 'search-record'].includes(action) && !modals.length) {
      const field = unique(nodes(document, 'input').filter(el => !el.disabled && !el.readOnly &&
        (global ? el.placeholder === '请输入单字的至少首 2 个字符' :
          trim(el.placeholder) === '搜索商品名称, 全球商品货号, 规格货号, 商品ID')));
      const keyword = global ? title : sku || title;
      if (action === 'prepare-search' && field && keyword) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, keyword);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return { stage: 'search-ready' };
      }
      const apply = unique(buttons(document, global ? '应用' : '套用'));
      if (action === 'search-record' && field?.value === keyword && apply) {
        apply.click();
        return { stage: 'searched' };
      }
    }
    return { stage: global ? 'global-list' : 'shop-list' };
  }
  if (path === '/portal/product-distribute/publish-record') return { stage: 'publish-record' };
  if (path.startsWith('/portal/product-distribute/single-product-publish/')) {
    const itemId = path.match(/\/(\d+)\/?$/u)?.[1];
    if (unique(buttons(document, '下一步：确认商品价格'))) {
      const single = /发布至\s*1\s*店铺/u.test(body);
      if (action === 'next' && single && !modals.length) {
        unique(buttons(document, '下一步：确认商品价格')).click();
        return { stage: 'clicked', itemId };
      }
      return { stage: 'select-shop', itemId, single };
    }
    if (/第2步\s*[：:]\s*确认店铺商品信息/u.test(body)) {
      const shop = body.match(/发布至\s+([A-Z]{2})\s*-\s*([^\s]+)/u)?.slice(1);
      const confirmation = unique(modals.filter(modal =>
        /item will be published to\s+1\s+shop\s+[A-Z]{2}\s+\S+/iu.test(label(modal))));
      if (confirmation) {
        const actual = label(confirmation).match(/item will be published to\s+1\s+shop\s+([A-Z]{2})\s+(\S+)/iu)?.slice(1);
        const sameShop = shop && actual && actual[0] === shop[0] && actual[1] === shop[1];
        const button = unique(buttons(confirmation, '确认'));
        if (action === 'confirm' && sameShop && button) {
          button.click();
          return { stage: 'clicked', itemId };
        }
        return { stage: 'confirm-publish', itemId, sameShop };
      }
      const button = unique(buttons(document, '确认发布'));
      const settled = shop && body.match(/发布至\s+[A-Z]{2}\s*-/gu)?.length === 1;
      if (action === 'review' && settled && button && !modals.length) {
        button.click();
        return { stage: 'clicked', itemId };
      }
      return { stage: 'review-prices', itemId, ready: Boolean(settled && button && !modals.length) };
    }
    return { stage: 'publish-loading', itemId };
  }
  return { stage: 'unrecognized' };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function withShopeeTabFocus(tabs, tabId, callback, signal) {
  const tab = await tabs.get(tabId);
  const locks = globalThis.navigator?.locks;
  return locks ? locks.request(`pl.shopee.foreground.${tab?.windowId ?? tabId}`, { signal }, callback) : callback();
}

async function scanGlobalInventory({ tabId, shopId, signal, tabs, scripting, timeout = 10000 }) {
  const records = new Map();
  const deadline = Date.now() + timeout;
  let total = null;
  let page = 1;
  let previous;
  let stableSince = 0;
  let complete = false;
  while (!signal?.aborted && Date.now() < deadline) {
    const tab = await tabs.get(tabId);
    const url = target(tab?.url, shopId);
    if (tab?.status === 'complete' && url?.pathname === GLOBAL_LIST) {
      const read = async action => {
        const [reply] = await scripting.executeScript({ target: { tabId, frameIds: [0] }, func: sellerSubmitPage,
          args: [{ action, expectedUrl: url.href, expectedPage: page }] });
        return reply?.result;
      };
      try {
        const current = await read('list-receipts');
        if (current?.stage === 'list-receipts' && (current.page === page ||
            page === 1 && current.page == null && !current.hasNext)) {
          const signature = JSON.stringify(current);
          if (signature !== previous) {
            previous = signature;
            stableSince = Date.now();
          } else if (Date.now() - stableSince >= (current.total === 0 ? 1000 : 250)) {
            if (total !== null && total !== current.total) break;
            total = current.total;
            for (const record of current.records) records.set(record.itemId, record.sku);
            if (total === records.size && !current.hasNext) {
              complete = true;
              break;
            }
            if (total !== null && current.hasNext && page < 10) {
              const advanced = await read('list-next-page');
              if (advanced?.stage !== 'list-advanced') break;
              page++;
              previous = null;
            } else if (total !== null) {
              break;
            }
          }
        } else {
          previous = null;
        }
      } catch {
        previous = null;
      }
    } else if (tab?.status === 'complete' && tab.url !== 'about:blank') {
      break;
    }
    await wait(250);
  }
  const idsBySku = new Map();
  for (const [itemId, sku] of records) {
    if (!idsBySku.has(sku)) idsBySku.set(sku, []);
    idsBySku.get(sku).push(itemId);
  }
  return { complete, idsBySku };
}

export async function prepareShopeeCreationCheck({ windowId, shopId, skus, signal, tabs = chrome.tabs,
  scripting = chrome.scripting, storage = chrome.storage.local }) {
  const keys = [...new Set(skus.map(clean).filter(Boolean).map(sku => ledgerKey(shopId, sku)))];
  if (!keys.length || signal?.aborted) return null;
  const prior = await storage.get(keys);
  if (!keys.some(key => ['created', 'creating'].includes(prior[key]?.stage))) return null;
  const tab = await tabs.create({ windowId, url: globalListUrl(shopId), active: false });
  try {
    const inventory = await scanGlobalInventory({ tabId: tab.id, shopId, signal, tabs, scripting });
    return { ...inventory, prior, checkedAt: Date.now() };
  } catch {
    return null;
  } finally {
    await tabs.remove(tab.id);
  }
}

export async function reconcileShopeeCreated({ tabId, shopId, skus, signal, tabs = chrome.tabs,
  scripting = chrome.scripting, storage = chrome.storage.local }) {
  const matches = new Map();
  const pending = new Set(skus.map(clean).filter(Boolean));
  for (const delay of [0, 1500, 3500, 7000]) {
    if (!pending.size || signal?.aborted) break;
    if (delay) {
      await wait(delay);
      if (signal?.aborted) break;
      const url = globalListUrl(shopId);
      if ((await tabs.get(tabId))?.url === url) await tabs.reload(tabId);
      else await tabs.update(tabId, { url });
    }
    const { idsBySku } = await scanGlobalInventory({ tabId, shopId, signal, tabs, scripting, timeout: 8000 });
    for (const sku of pending) {
      const ids = idsBySku.get(sku);
      if (ids?.length !== 1) continue;
      const [globalItemId] = ids;
      const key = ledgerKey(shopId, sku);
      const settle = async () => {
        const prior = (await storage.get(key))[key];
        if (prior?.stage === 'creating') {
          await storage.set({ [key]: { stage: 'created', globalItemId, updatedAt: Date.now() } });
        }
      };
      const locks = globalThis.navigator?.locks;
      await (locks ? locks.request(key, settle) : settle());
      matches.set(sku, globalItemId);
      pending.delete(sku);
    }
  }
  return matches;
}

export function checkShopeeSubmission(args) {
  return submitShopeeListing({ ...args, preflight: true });
}

export async function submitShopeeListing({ tabId, shopId, input, mode, replayReceipt, signal, call, onStep, preflight = false, inventory,
  recoverForm, tabs = chrome.tabs, scripting = chrome.scripting, storage = chrome.storage.local }) {
  if (!['create', 'publish'].includes(mode) || !preflight && replayReceipt?.status !== 'verified') {
    return { status: 'needs-review', details: '商品表单尚未核对。' };
  }
  const sku = clean(input.sku), title = clean(input.title);
  const key = ledgerKey(shopId, sku || title);
  async function run() {
    let globalItemId;
    let clicked = false;
    let repairAttempted = false;
    const result = (status, details, extra = {}) => ({
      ...replayReceipt, ...extra, status, ...(globalItemId && { globalItemId }), ...(details && { details }),
    });
    const readTab = async (requireComplete = false, requireActive = false) => {
      const tab = await tabs.get(tabId);
      if (requireActive && tab?.active !== true) return null;
      return !requireComplete || tab?.status === 'complete' && !tab.pendingUrl ? target(tab?.url, shopId) : null;
    };
    const reached = async pathname => {
      const tab = await tabs.get(tabId);
      if (!tab?.url) return false;
      const url = new URL(tab.url);
      return url.origin === ORIGIN && url.pathname === pathname &&
        (!url.searchParams.has('cnsc_shop_id') || Boolean(target(url, shopId)));
    };
    const operate = async (action, route, binding, { foreground = false, allowCleanRetry = false,
      allowReviewSummary = false } = {}) => {
      signal?.throwIfAborted();
      const url = await readTab(Boolean(binding) || foreground, foreground);
      if (!url || !route(url.pathname) || binding && url.href !== binding.url) return { stage: 'page-changed' };
      try {
        const [reply] = await scripting.executeScript({
          target: binding ? { tabId, documentIds: [binding.documentId] } : { tabId, frameIds: [0] },
          world: 'MAIN', func: sellerSubmitPage,
          args: [{ action, expectedUrl: url.href, sku, title, allowCleanRetry, allowReviewSummary }],
        });
        if (reply && reply.frameId !== 0 || binding && reply?.documentId !== binding.documentId) {
          return { stage: 'page-changed' };
        }
        const state = reply?.result ?? { stage: 'loading' };
        return state.stage === 'form' && reply?.documentId
          ? { ...state, binding: { url: url.href, documentId: reply.documentId } } : state;
      } catch (error) {
        if (action === 'read' && /(?:frame|document).*(?:removed|not found|unloaded|changed)|no (?:frame|document) with id/iu
          .test(error?.message ?? '')) {
          return { stage: 'loading' };
        }
        throw error;
      }
    };
    const until = async (check, timeout = 14000, cadence = 350) => {
      const deadline = Date.now() + timeout;
      do {
        signal?.throwIfAborted();
        const state = await check();
        if (state) return state;
        await wait(cadence);
      } while (Date.now() < deadline);
      return null;
    };
    const listingRoute = route => route === GLOBAL_LIST || route === SHOP_LIST || route === '/portal/product/list';
    const publishRoute = route => route.startsWith(PUBLISH);
    const creationRoute = route => route === NEW;
    const persist = (stage, extra = {}) => storage.set({ [key]: {
      stage, ...(globalItemId && { globalItemId }), updatedAt: Date.now(), ...extra,
    } });
    const checkCreateForm = async (binding, ignoredSummary) => {
      const form = await call('flow_page_state', { tabId, category: replayReceipt.category });
      const invalid = '创建前核对未通过，请检查必填项、图片及货号。';
      if (!form?.categoryReady || form.category !== replayReceipt.category || form.modal || form.url !== binding.url ||
          clean(form.fields?.title?.value) !== title || sku && clean(form.fields?.sku?.value) !== sku) {
        return { error: invalid };
      }
      const issues = Array.isArray(form.requiredIssues) ? form.requiredIssues : [];
      if (issues.length) return { error: 'Shopee 表单有必填项待核对。', issues };
      const validation = form.validation?.filter(message => !ignoredSummary ||
        clean(message).replace(/[。！!]$/u, '') !== ignoredSummary);
      if (form.missingRequired > 0 || validation?.length ||
          input.description != null && clean(form.fields?.description?.value) !== clean(input.description) ||
          input.imagePath && (!form.image?.coverReady || form.image.readyCount !== form.image.count ||
            replayReceipt.coverUploaded && form.image.count !== 1 + (replayReceipt.galleryUploaded ?? 0))) {
        return { error: validation?.join(' · ') || invalid };
      }
      if (!salesAndShippingMatch(form, input, replayReceipt.skuRows)) {
        return { error: '创建前发现规格、价格、库存或运费字段已变化，请核对。' };
      }
      return null;
    };
    const clickVerifiedForm = async (action, expectedBinding, allowCleanRetry = false) =>
      withShopeeTabFocus(tabs, tabId, async () => {
        signal?.throwIfAborted();
        const current = await readTab(true);
        if (current?.pathname !== NEW || expectedBinding && current.href !== expectedBinding.url) {
          return { stage: 'page-changed', error: 'Shopee 新增商品页已变化。' };
        }
        await tabs.update(tabId, { active: true });
        let visibleForm;
        const preparation = await until(async () => {
          const page = await operate(action === 'publish' ? 'prepare-publish' : 'prepare-create', creationRoute,
            expectedBinding, { foreground: true });
          if (page.stage !== 'form' || !page.binding || !page.foreground) {
            visibleForm = undefined;
            return null;
          }
          visibleForm = page;
          return page.buttonReady || page.accepted || page.fieldRejection ? page : null;
        }, CREATE_FOCUS_WAIT_MS, 100) ?? visibleForm;
        if (!preparation) return { stage: 'page-changed', error: '未能确认当前 Shopee 商品表单。' };
        if (preparation.busy || preparation.accepted) {
          return { stage: 'loading', error: 'Shopee 正在处理该商品，请核对提交结果。' };
        }
        const { binding } = preparation;
        const ignoredSummary = action !== 'publish' && preparation.reviewOnly ? preparation.error : undefined;
        const problem = await checkCreateForm(binding, ignoredSummary);
        if (problem) return { stage: 'form', binding, ...problem };
        if (!preparation.buttonReady) return { stage: 'form', error: 'Shopee 提交按钮尚不可用。' };
        if (!clicked) {
          onStep?.({ step: 'submit-create' });
          await persist('creating');
          clicked = true;
        }
        const click = await operate(action, creationRoute, binding, {
          foreground: true, allowCleanRetry, allowReviewSummary: Boolean(ignoredSummary),
        });
        return { ...click, binding };
      }, signal);
    const repairRejectedForm = async (outcome, phase) => {
      if (repairAttempted || !recoverForm || !outcome.binding || !outcome.issues?.length) return false;
      repairAttempted = true;
      signal?.throwIfAborted();
      try {
        return await recoverForm({ issues: outcome.issues, tabId, phase, binding: outcome.binding }) === true;
      } catch (error) {
        signal?.throwIfAborted();
        outcome.error = [outcome.error, error?.message || 'Shopee 必填项补填失败。'].filter(Boolean).join(' · ');
        return false;
      }
    };
    const clickWithRecovery = async (action, binding, phase) => {
      let attempt = await clickVerifiedForm(action, binding);
      if (await repairRejectedForm(attempt, phase)) {
        attempt = await clickVerifiedForm(action, attempt.binding, phase === 'after-validation');
      }
      return attempt;
    };
    const reportForm = (status, outcome, fallback) => {
      const detail = outcome?.error || fallback;
      return outcome?.issues?.length
        ? result(status, { text: detail, issues: outcome.issues }, { requiredIssues: outcome.issues })
        : result(status, detail);
    };
    const waitForCreateOutcome = async (binding, allowRetry = true) => {
      let candidate;
      let sawAmbiguousState = false;
      let lastError;
      const outcome = await until(async () => {
        if (await reached(GLOBAL_LIST)) return { stage: 'list' };
        const current = await operate('read', creationRoute, binding);
        if (current.stage !== 'form' || current.accepted) sawAmbiguousState = true;
        if (current.accepted) lastError = null;
        else if (current.error || current.fieldRejection) lastError = {
          stage: 'form', error: current.error, fieldRejection: current.fieldRejection,
        };
        if (current.stage !== 'form' || current.busy || current.accepted || !current.error && !current.fieldRejection) {
          candidate = null;
          return null;
        }
        if (!binding || !sku || sawAmbiguousState || !(current.reviewOnly || current.fieldRejection)) return lastError;
        if (!current.retryable && !current.fieldRejection) {
          candidate = null;
          return null;
        }
        // Retry needs an idle validation summary that remains unchanged in the original document.
        if (!candidate || candidate.error !== current.error) candidate = { at: Date.now(), error: current.error };
        return Date.now() - candidate.at >= CREATE_RETRY_SETTLE_MS
          ? { ...lastError, ...(allowRetry && { binding }) } : null;
      }, 30000);
      return outcome ?? lastError;
    };
    const lookup = async (stage, { applySearch = true, timeout = 19000 } = {}) => {
      let search = applySearch ? 'prepare-search' : null;
      const wakeAt = Date.now() + 4500;
      let woke = false;
      return until(async () => {
        const snapshot = await operate('read', listingRoute);
        if (snapshot.stage === stage || snapshot.stage === 'ambiguous') return snapshot;
        if (!woke && Date.now() >= wakeAt && snapshot.stage.endsWith('-list')) {
          // Some seller views defer rendering in a background tab. Bring only the
          // owned verification tab forward if the normal readback has stalled.
          woke = true;
          await withShopeeTabFocus(tabs, tabId, () => tabs.update(tabId, { active: true }), signal);
        }
        if (search && snapshot.stage.endsWith('-list')) {
          const current = await operate(search, listingRoute);
          if (current.stage === 'search-ready') search = 'search-record';
          if (current.stage === 'searched') search = null;
        }
        return null;
      }, timeout);
    };
    try {
      const prior = (await storage.get(key))[key];
      globalItemId = /^\d+$/u.test(prior?.globalItemId) ? prior.globalItemId : undefined;
      if (preflight && mode === 'create' && sku && inventory?.complete) {
        const ids = inventory.idsBySku.get(sku);
        if (ids?.length > 1) return result('submission-unknown', '全球商品列表中有多个同货号商品，请核对。');
        if (ids?.length === 1 && !['publishing', 'published'].includes(prior?.stage)) {
          globalItemId = ids[0];
          await persist('created');
          return result('skipped', '已在 Shopee 全球商品列表核对到相同货号。');
        }
        const checked = inventory.prior[key];
        if (!ids && checked && prior?.updatedAt === checked.updatedAt && prior?.stage === checked.stage &&
            prior?.globalItemId === checked.globalItemId &&
            (prior.stage === 'created' || prior.stage === 'creating' && inventory.checkedAt - prior.updatedAt >= PENDING_CREATE_MIN_AGE)) {
          await storage.remove(key);
          return null;
        }
      }
      if (preflight && (!prior || mode === 'publish' && globalItemId && prior.stage === 'created')) return null;
      if (prior?.stage === 'creating' || prior?.stage === 'publishing') {
        const recoveringPublish = prior.stage === 'publishing';
        await tabs.update(tabId, { url: recoveringPublish ? `${ORIGIN}${SHOP_LIST}?cnsc_shop_id=${shopId}` : globalListUrl(shopId) });
        const found = await lookup(recoveringPublish ? 'shop-item' : 'global-item');
        if (!found?.itemId || (!sku && !recoveringPublish)) {
          return result('submission-unknown', '此前提交尚未核实，请先在 Shopee 后台核对。');
        }
        if (!recoveringPublish) globalItemId = found.itemId;
        await persist(recoveringPublish ? 'published' : 'created', recoveringPublish ? { shopItemId: found.itemId } : {});
        return result('skipped', '已在 Shopee 核对到此前提交的记录。', recoveringPublish ? { shopItemId: found.itemId } : {});
      }
      if (globalItemId && (mode === 'create' || prior.stage === 'published')) {
        return result('skipped', '该货号已有本店的创建记录。');
      }
      if (preflight) return null;
      if (!globalItemId) {
        const click = await clickWithRecovery(mode, undefined, 'before-create');
        if (click.stage !== 'clicked') {
          if (clicked) {
            clicked = false;
            await storage.remove(key);
          }
          return reportForm('needs-review', click, 'Shopee 创建按钮未确认。');
        }
        if (mode === 'create') {
          let outcome = await waitForCreateOutcome(click.binding);
          if (outcome?.binding) {
            const retry = await clickWithRecovery('retry-create', outcome.binding, 'after-validation');
            // Always keep the original creating receipt while confirmation is uncertain.
            if (retry.stage === 'clicked') {
              outcome = await waitForCreateOutcome(retry.binding, false);
            } else {
              const error = [...new Set([outcome.error, retry.error].filter(Boolean))].join(' · ');
              outcome = { ...outcome, ...retry, stage: 'form', error };
            }
          }
          if (outcome?.fieldRejection && !outcome.issues?.length) {
            const problem = await checkCreateForm(click.binding).catch(() => null);
            if (problem?.issues?.length) outcome = { ...outcome, issues: problem.issues };
          }
          if (outcome?.stage === 'form') return reportForm('submission-unknown', outcome, 'Shopee 表单有必填项待核对。');
          if (outcome?.stage === 'list' && !(await readTab())) await tabs.update(tabId, { url: globalListUrl(shopId) });
          const found = outcome?.stage === 'list' && await lookup('global-item', sku ? { applySearch: false, timeout: 3000 } : undefined);
          if (found?.stage !== 'global-item') return result('submission-unknown', '创建按钮已点击，全球商品列表尚未核对到唯一编号。');
          globalItemId = found.itemId;
          await persist('created');
          return result('created');
        }
        const selected = await until(async () => {
          const current = (await tabs.get(tabId))?.url;
          if (!current) return null;
          const route = new URL(current);
          const itemId = route.origin === ORIGIN && route.pathname.startsWith(PUBLISH) &&
            (!route.searchParams.has('cnsc_shop_id') || target(route, shopId)) && route.pathname.match(/\/(\d+)\/?$/u)?.[1];
          if (!itemId) return null;
          if (!route.searchParams.has('cnsc_shop_id')) {
            route.searchParams.set('cnsc_shop_id', shopId);
            await tabs.update(tabId, { url: route.href });
          }
          return itemId;
        });
        if (!selected) return result('submission-unknown', '创建按钮已点击，尚未获取全球商品编号。');
        globalItemId = selected;
        await persist('created');
      } else {
        await tabs.update(tabId, { url: `${ORIGIN}${PUBLISH}select-shop/${globalItemId}?cnsc_shop_id=${shopId}` });
      }
      onStep?.({ step: 'submit-publish' });
      const routeForItem = route => publishRoute(route) && route.endsWith('/' + globalItemId);
      const select = await until(async () => {
        const state = await operate('read', routeForItem);
        return state.stage === 'select-shop' ? state : null;
      });
      if (!select?.single || (await operate('next', routeForItem)).stage !== 'clicked') {
        return result('needs-review', '商品已创建，请在 Shopee 确认唯一目标店铺。');
      }
      const pricing = await until(async () => {
        const state = await operate('read', routeForItem);
        return state.stage === 'review-prices' && state.ready;
      });
      if (!pricing || (await operate('review', routeForItem)).stage !== 'clicked') {
        return result('needs-review', '商品已创建，Shopee 尚未显示可确认的店铺售价。');
      }
      const confirmation = await until(async () => {
        const state = await operate('read', routeForItem);
        return state.stage === 'confirm-publish' ? state : null;
      });
      if (!confirmation?.sameShop) return result('needs-review', '商品已创建，店铺发布确认未匹配。');
      await persist('publishing');
      clicked = true;
      if ((await operate('confirm', routeForItem)).stage !== 'clicked') {
        await persist('created');
        return result('needs-review', '商品已创建，发布确认按钮已变化。');
      }
      const records = await until(() => reached(RECORDS));
      if (!records) return result('submission-unknown', '已点击确认发布，Shopee 尚未返回发布记录。');
      await tabs.update(tabId, { url: `${ORIGIN}${SHOP_LIST}?cnsc_shop_id=${shopId}` });
      const found = await lookup('shop-item');
      if (found?.stage !== 'shop-item') return result('submission-unknown', '已提交上架，店铺商品列表尚未查到该货号。');
      await persist('published', { shopItemId: found.itemId });
      return result('published', undefined, { shopItemId: found.itemId });
    } catch (error) {
      return result(clicked ? 'submission-unknown' : signal?.aborted ? 'cancelled' : 'needs-review',
        error?.message || 'Shopee 提交状态无法核对。');
    }
  }
  const locks = globalThis.navigator?.locks;
  return locks ? locks.request(key, { ifAvailable: true }, lock => lock
    ? run() : { status: 'needs-review', details: '同一店铺的该货号正在处理。' }) : run();
}

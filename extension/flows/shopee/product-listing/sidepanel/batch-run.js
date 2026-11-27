import { matchesFlowTarget, runFlow } from "../../../../lib/flow/runtime.js";
import { shopeeShopId } from "../definition.js";
import { checkShopeeSubmission, prepareShopeeCreationCheck, reconcileShopeeCreated, submitShopeeListing } from "../submit-listing.mjs";
import { createPtcToolCaller } from "./tool-adapter.js";

const READY =
  '.product-basic-info:has(.edit-row input:is([type="text"],:not([type])):not([disabled],[readonly])) ' +
  '.edit-row :is(textarea,[contenteditable="true"]):not([disabled],[readonly])';
const TAB_READY_TIMEOUT = 45000;
const FORM_READY_TIMEOUT = 30000;
const EARLY_FORM_ERRORS = new Set(["control-changed", "control-missing", "field-missing", "field-kind-changed", "readback-mismatch"]);
export const DEFAULT_CONCURRENCY = 5;
export const MAX_CONCURRENCY = 10;

export function isReviewStatus(status) {
  return status === "needs-review" || status === "deferred" || status === "submission-unknown";
}

export function imagePathsFor(input) {
  const variants = Array.isArray(input?.variant?.options) ? input.variant.options : [input?.variant];
  return [...new Set([input?.imagePath, ...(Array.isArray(input?.galleryImages) ? input.galleryImages : []),
    ...variants.map((item) => item?.imagePath)]
    .filter((path) => typeof path === "string" && path.trim()))];
}

async function waitForTab(tabs, tabId, flowId, shopId, signal) {
  const deadline = Date.now() + TAB_READY_TIMEOUT;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const tab = await tabs.get(tabId);
    if (tab?.status === "complete" && tab.url && tab.url !== "about:blank") {
      if (matchesFlowTarget(flowId, tab.url, shopId)) return tab;
      throw new Error("标签没有停在当前店铺的新增商品页，请检查 Shopee 登录。");
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return null;
}

function canTryNewForm(receipt) {
  return receipt.code === "batch-page-timeout" || receipt.code === "batch-form-timeout" ||
    ["bind-page", "basic"].includes(receipt.step) && EARLY_FORM_ERRORS.has(receipt.code);
}

async function isUntouchedForm({ tabs, tabId, expectedUrl, windowId, call, beforeFilling, signal }) {
  const withinTarget = tab => tab?.windowId === windowId &&
    (!tab.pendingUrl || tab.pendingUrl === expectedUrl) &&
    (tab.url === expectedUrl || tab.pendingUrl === expectedUrl && (!tab.url || tab.url === "about:blank"));
  const tab = await tabs.get(tabId).catch(() => null);
  if (!withinTarget(tab)) return false;
  if (beforeFilling && tab.status === "loading" && tab.url !== expectedUrl) return true;
  const state = await call("flow_page_state", { tabId }).catch(() => null);
  signal.throwIfAborted();
  if (state?.url !== expectedUrl || !state.fields || state.modal || state.category || state.image?.cover ||
      state.image?.readyCount > 0 || state.variant?.options?.length || state.variant?.rows?.length ||
      Number(state.fields.quantity?.value) > 0 ||
      ["title", "description", "sku", "price", "weight", "width", "length", "height"]
        .some(key => String(state.fields[key]?.value ?? "").trim())) return false;
  const emptyImages = state.image?.count === 0;
  const stillLoading = beforeFilling && !state.fields.title && !state.fields.description && state.image?.count == null;
  return (emptyImages || stillLoading) && withinTarget(await tabs.get(tabId).catch(() => null));
}

async function closeWorkerTab(tabs, tabId) {
  try {
    await tabs.remove(tabId);
    return true;
  } catch {
    try {
      return !(await tabs.get(tabId));
    } catch (error) {
      return /\bNo tab with id:/iu.test(error?.message ?? "");
    }
  }
}

export async function runProductBatch({
  flow, shopId, sourceTab, products, uploadApproved, signal, onJob, mode = "create", concurrency = DEFAULT_CONCURRENCY,
  prepareInput, completeChart, createAttributeAdvisor, tabs = chrome.tabs, replay = runFlow, createCall = createPtcToolCaller,
  submit = submitShopeeListing, reconcile = submit === submitShopeeListing ? reconcileShopeeCreated : null,
  checkPrevious = submit === submitShopeeListing ? checkShopeeSubmission : null,
  prepareCreationCheck = checkPrevious === checkShopeeSubmission ? prepareShopeeCreationCheck : null,
}) {
  if (mode !== "create" && mode !== "publish") throw new TypeError("请选择创建商品或创建并上架。");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new RangeError(`并发标签数须在 1 到 ${MAX_CONCURRENCY} 之间。`);
  }
  const source = await tabs.get(sourceTab.id);
  const sourceShop = shopeeShopId(source?.url);
  if (source?.id !== sourceTab.id || source.windowId !== sourceTab.windowId ||
      !sourceShop || sourceShop !== shopId) {
    throw new Error("源标签或店铺已变化。");
  }
  const url = new URL(flow.path, flow.origin);
  url.searchParams.set("cnsc_shop_id", shopId);
  const inventory = mode === "create" ? await prepareCreationCheck?.({
    windowId: source.windowId, shopId, tabs, signal, skus: products.map(({ input }) => input.sku),
  }) : undefined;
  let next = 0;
  const uncertainCreations = [];

  async function work(index) {
    const product = products[index];
    const { input } = product;
    let tabId = null;
    let receipt;
    let submissionStarted = false;
    try {
      signal.throwIfAborted();
      const approvedPaths = new Set(imagePathsFor(input));
      if ((approvedPaths.size || input.sizeChartImagePath || input.sizeChart != null) && !uploadApproved) {
        throw new Error("请先确认本次图片和尺码表的处理。");
      }
      if (input.shopId != null && String(input.shopId) !== shopId) {
        throw new Error("目录商品的店铺与当前店铺不一致。");
      }
      const needsChart = input.sizeChartImagePath && input.sizeChart == null;
      if (needsChart && !prepareInput) throw new Error("当前未能解析尺码图。");
      if (needsChart) onJob(index, { phase: "preparing" });
      const prepared = needsChart ? await prepareInput(product, signal) : input;
      signal.throwIfAborted();
      if (needsChart && prepared?.sizeChart == null) throw new Error("尺码图解析未返回数据。");
      const productInput = {
        ...prepared, shopId, completeMissingSizeChart: Boolean(prepared.sizeChart && uploadApproved),
        completeMissingAttributes: Boolean(createAttributeAdvisor),
        resetUnownedDraftVariants: true,
      };
      let call;
      let recoverForm;
      for (let attempt = 0; attempt < 2; attempt++) {
        recoverForm = undefined;
        onJob(index, { phase: attempt ? "reopening" : "opening", step: "", tool: "", tabId: null });
        const created = await tabs.create({ windowId: source.windowId, url: url.href, active: false });
        if (!Number.isInteger(created?.id)) throw new Error("Chrome 没有返回已创建标签的编号。");
        tabId = created.id;
        onJob(index, { tabId });
        const tab = await waitForTab(tabs, tabId, flow.id, shopId, signal);
        receipt = tab ? await checkPrevious?.({ tabId, shopId, input: prepared, mode, signal, tabs, inventory })
          : { status: "needs-review", step: "bind-page", code: "batch-page-timeout" };
        const workerTabId = tabId;
        const buildCall = () => createCall({
          tabId: workerTabId, url: tab?.url ?? url.href, signal, allowFreshVariantReset: true,
          confirmUpload: ({ tabId: requestedTab, paths }) => uploadApproved &&
            requestedTab === workerTabId && paths?.length === 1 && approvedPaths.has(paths[0]),
          adviseAttributes: createAttributeAdvisor?.(product, signal),
          completeChart: prepared.sizeChart && uploadApproved && completeChart
            ? requirements => completeChart(product, requirements)
            : undefined,
        });
        let beforeFilling = true;
        if (!receipt) {
          call = buildCall();
          const ready = await call("wait_for", { tabId, selector: READY, timeoutMs: FORM_READY_TIMEOUT });
          signal.throwIfAborted();
          if (ready?.ok === true) {
            beforeFilling = false;
            receipt = await replay({
              flowId: flow.id, tabId, input: productInput, signal, call,
              onStep: ({ step, tool }) => onJob(index, { phase: "running", step, tool }),
              registerRecovery: recover => { recoverForm = recover; },
            });
          } else {
            const timedOut = ready?.error === "等待超时";
            receipt = { status: "needs-review", step: "bind-page",
              code: timedOut ? "batch-form-timeout" : ready?.code || "batch-product-error",
              details: timedOut ? undefined : ready?.error || "没有读到 Shopee 新增商品表单。" };
          }
        }
        if (attempt || !receipt || !canTryNewForm(receipt)) break;
        if (!await isUntouchedForm({ tabs, tabId, expectedUrl: url.href, windowId: source.windowId,
          call: tab ? call : buildCall(), beforeFilling, signal })) break;
        signal.throwIfAborted();
        if (!await closeWorkerTab(tabs, tabId)) {
          receipt = { ...receipt, tabCleanupFailed: true };
          break;
        }
        tabId = null;
        signal.throwIfAborted();
      }
      if (receipt?.status === "verified") {
        signal.throwIfAborted();
        onJob(index, { phase: "submitting" });
        submissionStarted = true;
        receipt = await submit({
          tabId, shopId, input: productInput, mode, replayReceipt: receipt, signal, call, recoverForm,
          onStep: ({ step, tool }) => onJob(index, { phase: "submitting", step, tool }),
        });
      }
      if (!receipt?.status || receipt.status === "verified") throw new Error("工作流未返回可核对的商品结果。");
    } catch (error) {
      if (submissionStarted) {
        receipt = { status: "submission-unknown", code: "batch-submit-unknown", details: error?.message || String(error) };
      } else {
        receipt = signal.aborted
          ? { status: "cancelled" }
          : { status: "needs-review", code: "batch-product-error", details: error?.message || String(error) };
      }
    }
    // A retained form is available for inspection and no longer counts as an active worker.
    const keepForReview = tabId !== null && isReviewStatus(receipt.status);
    const released = keepForReview || tabId === null || await closeWorkerTab(tabs, tabId);
    if (!released) receipt = { ...receipt, tabCleanupFailed: true };
    if (released && !keepForReview) tabId = null;
    onJob(index, { phase: receipt.status, tabId, receipt });
    if (mode === "create" && !receipt.globalItemId && receipt.status === "submission-unknown" && input.sku) {
      uncertainCreations.push({ index, sku: input.sku, tabId, receipt });
    }
    return released;
  }

  await Promise.all(Array.from({ length: Math.min(products.length, concurrency) }, async () => {
    while (next < products.length && !signal.aborted) {
      const index = next++;
      if (!(await work(index))) break;
    }
  }));
  for (; next < products.length; next++) {
    const receipt = signal.aborted ? { status: "cancelled" } : {
      status: "needs-review", code: "batch-tabs-not-closed", details: "工作标签未能自动关闭，暂未开始此商品。",
    };
    onJob(next, { phase: receipt.status, tabId: null, receipt });
  }
  if (reconcile && uncertainCreations.length && !signal.aborted) {
    let verificationTab;
    try {
      const list = new URL('/portal/product/mtsku/list', flow.origin);
      list.search = new URLSearchParams({ cnsc_shop_id: shopId, page: '1', size: '48' });
      verificationTab = await tabs.create({ windowId: source.windowId, url: list.href, active: true });
      const matches = await reconcile({ tabId: verificationTab.id, shopId, tabs, signal, skus: uncertainCreations.map(job => job.sku) });
      for (const { index, sku, tabId, receipt } of uncertainCreations) {
        const globalItemId = matches.get(sku);
        if (globalItemId) {
          const closed = tabId === null || await closeWorkerTab(tabs, tabId);
          const { code, details, ...verified } = receipt;
          onJob(index, { phase: 'created', tabId: closed ? null : tabId,
            receipt: { ...verified, status: 'created', globalItemId, ...(!closed && { tabCleanupFailed: true }) } });
        }
      }
    } catch {
      // Keep the original uncertain receipts if the read-only check could not complete.
    } finally {
      if (verificationTab?.id) await closeWorkerTab(tabs, verificationTab.id);
    }
  }
}

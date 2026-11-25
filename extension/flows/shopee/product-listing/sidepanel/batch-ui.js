import { matchesFlowTarget } from "../../../../lib/flow/runtime.js";
import { ensureOptionalAccess } from "../../../../lib/optional-permissions.js";
import { $ } from "../../../../sidepanel/dom.js";
import { shopeeShopId } from "../definition.js";
import { imagePathsFor, isReviewStatus, runProductBatch } from "./batch-run.js";
import { chooseShopeeProductDirectory, completeDirectorySizeChartInput, directoryAttributeAdvice, loadProductDirectory, prepareSizeChartInput } from "./product-directory.js";

const STATUS = new Map([
  ["pending", "待执行"],
  ["preparing", "正在解析尺码图"],
  ["opening", "正在打开表单"],
  ["reopening", "正在重新打开表单"],
  ["running", "正在填写"],
  ["submitting", "正在提交"],
  ["verified", "已填写并核对"],
  ["created", "已创建"],
  ["published", "已提交上架"],
  ["skipped", "已跳过"],
  ["deferred", "待处理"],
  ["submission-unknown", "提交结果待核实"],
  ["needs-review", "待处理"],
  ["cancelled", "已停止"],
]);

function newButton(text) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary mini";
  button.textContent = text;
  return button;
}

export function bindPtcBatch({
  flow, getTarget, isBlocked, onChange, onReview, stepLabel, errorText,
  chooseDirectory = chooseShopeeProductDirectory, startBatch = runProductBatch,
}) {
  const form = $("ptc-batch-form");
  const scan = $("ptc-load-directory");
  const manualDirectory = $("ptc-manual-directory");
  const manualLoad = $("ptc-load-manual-directory");
  const create = $("ptc-batch-start");
  const publish = $("ptc-batch-publish");
  const concurrencyInput = $("ptc-batch-concurrency");
  const stop = $("ptc-batch-stop");
  const consent = $("ptc-batch-upload-consent");
  const consentRow = $("ptc-batch-consent-row");
  const consentText = $("ptc-batch-consent-text");
  const ai = $("ptc-batch-ai-consent");
  const aiRow = $("ptc-batch-ai-row");
  const status = $("ptc-batch-status");
  const importIssues = $("ptc-batch-import-issues");
  const items = $("ptc-batch-jobs");
  let products = [];
  let jobs = [];
  let selectedRoot = "";
  let reading = false;
  let run = null;
  let lastShop = "";

  function setStatus(kind, text) {
    status.dataset.state = kind;
    status.textContent = text;
  }

  function consentActions() {
    const hasChart = products.some(({ input }) => input.sizeChart != null || input.sizeChartImagePath);
    const hasChartWithCover = products.some(({ input }) => (input.sizeChart != null || input.sizeChartImagePath) && input.imagePath);
    return [
      products.some(({ input }) => imagePathsFor(input).length) && "将下方商品的主图、详情图和 SKU 图上传到当前 Shopee 店铺",
      products.some(({ input }) => input.sizeChartImagePath && input.sizeChart == null) && "用已配置的识图模型解析尺码图",
      hasChart && (hasChartWithCover
        ? "在需估算缺少的测量值时，将该商品主图发给已配置的识图模型"
        : "在需要时由模型估算缺少的必填尺码值"),
      hasChart && "为当前 Shopee 店铺选择或创建尺码表",
    ].filter(Boolean);
  }

  function updateControls() {
    const busy = Boolean(reading || run);
    const { tab, shopId } = getTarget();
    const actions = consentActions();
    scan.disabled = busy || isBlocked();
    manualLoad.disabled = scan.disabled || !manualDirectory.value.trim();
    manualDirectory.disabled = busy;
    create.disabled = publish.disabled = busy || isBlocked() || !selectedRoot || !products.length || !tab?.id ||
      Boolean(tab.url && !shopId) ||
      actions.length > 0 && !consent.checked || !concurrencyInput.validity.valid;
    for (const [button, mode, label, running] of [
      [create, "create", "创建商品", "创建中…"],
      [publish, "publish", "创建并上架", "上架中…"],
    ]) {
      const submitting = run?.mode === mode;
      if (submitting) button.setAttribute("aria-busy", "true");
      else button.removeAttribute("aria-busy");
      button.textContent = !submitting ? label : run.phase === "starting" ? "启动中…" :
        run.phase === "stopping" ? "正在停止…" : running;
    }
    concurrencyInput.disabled = busy;
    consent.disabled = busy;
    consentRow.hidden = !selectedRoot || !actions.length;
    consentText.textContent = actions.length ? `同意${actions.join("，并")}` : "";
    ai.disabled = busy;
    aiRow.hidden = !selectedRoot;
    stop.hidden = !run;
    stop.disabled = run?.phase === "stopping";
  }

  function clearPreview() {
    products = [];
    jobs = [];
    selectedRoot = "";
    lastShop = "";
    consent.checked = false;
    ai.checked = false;
    importIssues.textContent = "";
    importIssues.hidden = true;
    items.replaceChildren();
    items.hidden = true;
  }

  function paintJob(job, showLinks = false) {
    job.node.dataset.state = job.phase;
    const label = STATUS.get(job.phase) || "";
    job.progress.textContent = [label, !job.receipt && stepLabel(job.step)].filter(Boolean).join(" · ");
    const status = job.receipt?.status;
    const hasIssue = isReviewStatus(status);
    const id = job.receipt?.globalItemId;
    job.details.textContent = [
      id && `全球商品 ID ${id}`,
      hasIssue && errorText(job.receipt),
      status === "skipped" && job.receipt.code && errorText(job.receipt),
      job.receipt?.tabCleanupFailed && "此商品的标签未能自动关闭。",
    ].filter(Boolean).join("\n");
    job.details.hidden = !job.details.textContent;
    job.inspect.hidden = !showLinks || !job.tabId;
    job.review.hidden = !showLinks || !job.tabId || !onReview || job.phase !== "needs-review";
  }

  function addJob({ title }) {
    const row = document.createElement("li");
    row.className = "ptc-batch-job";
    const name = document.createElement("strong");
    name.textContent = title;
    const progress = document.createElement("p");
    progress.className = "ptc-batch-progress";
    const details = document.createElement("p");
    details.className = "ptc-batch-details";
    const actions = document.createElement("div");
    actions.className = "ptc-actions";
    const inspect = newButton("查看表单");
    const review = newButton("检查异常");
    actions.append(inspect, review);
    row.append(name, progress, details, actions);
    const job = { node: row, progress, details, inspect, review, phase: "pending", tabId: null };
    async function showTab(askAgent) {
      try {
        const tab = await chrome.tabs.get(job.tabId);
        const onForm = matchesFlowTarget(flow.id, tab?.url, lastShop);
        const url = new URL(tab?.url);
        const sameShop = url.origin === flow.origin && url.searchParams.getAll("cnsc_shop_id").length === 1 &&
          url.searchParams.get("cnsc_shop_id") === lastShop;
        if ((askAgent && !onForm) || !sameShop) {
          setStatus("needs-review", "该标签已离开本次任务的 Shopee 店铺。");
          return;
        }
        await chrome.tabs.update(job.tabId, { active: true });
        if (askAgent) onReview({
          tabId: job.tabId, step: stepLabel(job.receipt?.step || job.step),
          code: job.receipt?.code, details: errorText(job.receipt),
        });
      } catch {
        setStatus("needs-review", "这个商品的 Shopee 标签已关闭。");
      }
    }
    inspect.addEventListener("click", () => { void showTab(false); });
    review.addEventListener("click", () => { void showTab(true); });
    paintJob(job);
    items.append(row);
    return job;
  }

  async function importDirectory(load, message) {
    if (reading || run || isBlocked()) return;
    reading = true;
    setStatus("running", message);
    onChange();
    try {
      const loaded = await load();
      if (!loaded) {
        setStatus("idle", "");
        return;
      }
      clearPreview();
      products = loaded.products || [];
      const issues = Array.isArray(loaded.issues) ? loaded.issues : [];
      if (issues.length) {
        importIssues.textContent = issues.map((issue) => typeof issue === "string" ? issue :
          [issue.folder, issue.message || issue.error].filter(Boolean).join(" · ")).join("\n").replaceAll("product.json", "商品资料文件");
        importIssues.hidden = !importIssues.textContent;
      }
      if (!products.length) {
        setStatus("needs-review", "没有可读取的商品。请选择 PageLens 导出的商品目录。");
        return;
      }
      selectedRoot = loaded.root;
      jobs = products.map(addJob);
      items.hidden = false;
      scan.textContent = "更换商品目录";
      setStatus("ready", `已读入 ${products.length} 个商品${issues.length ? `，另有 ${issues.length} 个目录待处理` : ""}。`);
    } catch (error) {
      setStatus("needs-review", (error?.message || String(error)).replaceAll("product.json", "商品资料文件"));
    } finally {
      reading = false;
      onChange();
    }
  }
  scan.addEventListener("click", () => void importDirectory(chooseDirectory, "正在选择商品目录…"));
  manualDirectory.addEventListener("input", updateControls);
  manualDirectory.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    manualLoad.click();
  });
  manualLoad.addEventListener("click", () => {
    if (!manualLoad.disabled) void importDirectory(() => loadProductDirectory(manualDirectory.value), "正在读取商品目录…");
  });

  consent.addEventListener("change", updateControls);
  concurrencyInput.addEventListener("input", updateControls);
  stop.addEventListener("click", () => {
    if (!run) return;
    run.phase = "stopping";
    run.controller.abort();
    setStatus("running", "正在停止批量任务。");
    updateControls();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (run || reading || isBlocked() || ![create, publish].includes(event.submitter) || event.submitter.disabled) return;
    const mode = event.submitter === publish ? "publish" : "create";
    const concurrency = concurrencyInput.valueAsNumber;
    if (!concurrencyInput.validity.valid || !Number.isInteger(concurrency)) return;
    const { tab: sourceTab, shopId: originalShop } = getTarget();
    const uploadApproved = consent.checked;
    const modelApproved = ai.checked;
    const root = selectedRoot;
    if (!sourceTab || consentActions().length && !uploadApproved) return;
    const controller = new AbortController();
    run = { controller, mode, phase: "starting", shopId: originalShop };
    lastShop = "";
    for (const job of jobs) {
      Object.assign(job, { phase: "pending", tabId: null, receipt: null, step: "", tool: "" });
      paintJob(job);
    }
    const runLabel = mode === "publish" ? "创建并上架" : "创建商品";
    let settled = 0;
    setStatus("running", `正在启动${runLabel}，检查 Shopee 站点权限…`);
    onChange();
    try {
      const access = await ensureOptionalAccess({ url: flow.origin, tabId: sourceTab.id, userGesture: true, force: true });
      controller.signal.throwIfAborted();
      if (!access.granted && !access.required) throw new Error(access.message || "Chrome 未授予此站点访问权限。");
      const [current] = await chrome.tabs.query({ active: true, windowId: sourceTab.windowId });
      controller.signal.throwIfAborted();
      const shopId = shopeeShopId(current?.url);
      if (current?.id !== sourceTab.id || !shopId || originalShop && shopId !== originalShop) {
        throw new Error("当前标签或店铺已变化，请回到要操作的 Shopee 店铺后重试。");
      }
      lastShop = shopId;
      run.shopId = shopId;
      run.phase = "running";
      setStatus("running", `${runLabel} · 0/${products.length} 已处理 · ${concurrency} 并发`);
      onChange();
      await startBatch({
        flow, shopId, sourceTab: current, products, uploadApproved, mode, concurrency, signal: controller.signal,
        prepareInput: (product, signal) => prepareSizeChartInput(product, { root, signal }),
        completeChart: (product, requirements) => completeDirectorySizeChartInput(product, { ...requirements, root }),
        createAttributeAdvisor: modelApproved ? (product, signal) => directoryAttributeAdvice(product, { root, signal }) : undefined,
        onJob(index, event) {
          const job = jobs[index];
          if (event.receipt && !job.receipt) settled++;
          Object.assign(job, event);
          if (event.receipt) {
            job.tool = "";
            if (!controller.signal.aborted) {
              setStatus("running", `${runLabel} · ${settled}/${jobs.length} 已处理 · ${concurrency} 并发`);
            }
          }
          paintJob(job);
        },
      });
      const successfulPhase = mode === "publish" ? "published" : "created";
      const done = jobs.filter((job) => job.phase === successfulPhase).length;
      const blockedJobs = jobs.filter((job) => isReviewStatus(job.phase));
      const blocked = blockedJobs.length;
      const retained = blockedJobs.filter((job) => job.tabId).length;
      const stopped = jobs.filter((job) => job.phase === "cancelled").length;
      const skipped = jobs.filter((job) => job.phase === "skipped").length;
      const summary = [
        `${STATUS.get(successfulPhase)} ${done}/${jobs.length}`, blocked ? `待处理 ${blocked}` : "",
        retained ? `保留 ${retained} 个标签` : "",
        stopped ? `已停止 ${stopped}` : "", skipped ? `已跳过 ${skipped}` : "",
      ].filter(Boolean).join(" · ");
      setStatus(blocked ? "needs-review" : stopped ? "cancelled" : "verified", summary);
    } catch (error) {
      setStatus(controller.signal.aborted ? "cancelled" : "needs-review",
        controller.signal.aborted ? "已停止。" : error?.message || String(error));
    } finally {
      run = null;
      consent.checked = false;
      ai.checked = false;
      for (const job of jobs) paintJob(job, true);
      onChange();
    }
  });

  return {
    get busy() { return Boolean(run || reading); },
    get runningShop() { return run?.shopId; },
    resetConsent: () => { consent.checked = ai.checked = false; },
    updateControls,
  };
}

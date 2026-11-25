import { requireHostUrl } from "../../../../lib/optional-permissions.js";
import { $ } from "../../../../sidepanel/dom.js";
import { productImagePaths, readSheinProductDirectory, readSheinProductImages } from "./product-directory.js";

function isSheinTab(tab) {
  try {
    const url = new URL(tab?.url);
    return Number.isInteger(tab.id) && url.origin === "https://sellerhub.shein.com" && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function pickSheinDirectory() {
  if (typeof window.showDirectoryPicker !== "function") {
    throw new Error("当前 Chrome 无法打开目录选择器，可以直接输入商品描述。");
  }
  return window.showDirectoryPicker({ id: "pagelens-shein-products", mode: "read" });
}

async function currentTabAccess(tab) {
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: () => location.href });
    return result?.result === tab.url;
  } catch {
    return false;
  }
}

export function bindSheinListingPanel({
  getTargetTab, isAgentBusy, onBack, pickDirectory = pickSheinDirectory,
  authorize = requireHostUrl, probeAccess = currentTabAccess, replay,
}) {
  const get = name => $(`shein-listing-${name}`);
  const dialog = get("dialog");
  const target = get("target");
  const status = get("status");
  const results = get("results");
  const product = get("product");
  const defaultSku = get("default-sku");
  const defaultSkuRow = get("default-sku-row");
  const defaultSkuUpload = get("default-sku-upload");
  const category = get("category");
  const upload = get("upload");
  const assist = get("ai");
  const description = get("description");
  const notes = () => description.value.trim().slice(0, 1800);
  const stop = get("stop");
  let targetTab;
  let products = [];
  let pendingSku;
  let operation;
  let revision = 0;
  const customerText = value => typeof value === "string" ? value.replaceAll("试填", "填写") : "";

  function report(message = "", state = "") {
    status.textContent = customerText(message);
    status.dataset.state = state;
  }

  function renderTarget() {
    const supported = isSheinTab(targetTab);
    target.hidden = supported || !targetTab;
    target.textContent = "切回已登录的 SHEIN 商家后台后即可开始上品。";
    get("link").hidden = supported;
    get("source").disabled = Boolean(operation);
    const runButton = get("run");
    runButton.disabled = Boolean(operation) || !supported || (!selectedProduct() && !notes()) ||
      Boolean(pendingSku && !selectedDefaultSku());
    runButton.textContent = pendingSku && !defaultSkuRow.hidden ? "继续填写" : "开始上品";
    stop.hidden = !operation;
    stop.disabled = Boolean(operation?.signal.aborted);
  }

  function renderResults(lines = []) {
    const rows = [...new Set(lines.map(customerText).filter(line => line.trim()))].slice(0, 90);
    results.hidden = !rows.length;
    results.replaceChildren(...rows.map(line => Object.assign(document.createElement("li"), { textContent: line })));
  }

  const selectedProduct = () => products[Number(product.value)];
  const selectedDefaultSku = () => pendingSku?.choices.has(defaultSku.value) ? defaultSku.value : "";

  function showDefaultSkuUpload(show) {
    defaultSkuUpload.hidden = !show;
    if (show) defaultSku.setAttribute("aria-describedby", defaultSkuUpload.id);
    else defaultSku.removeAttribute("aria-describedby");
  }

  function clearDefaultSku() {
    pendingSku = undefined;
    defaultSku.replaceChildren();
    defaultSkuRow.hidden = true;
    showDefaultSkuUpload(false);
  }

  function requestDefaultSku(outcome, seller, uploadAllowed) {
    const anchor = { id: outcome.tabId ?? seller.tabId, url: outcome.url ?? seller.url };
    const choices = new Map();
    for (const choice of outcome.defaultSkuChoices) {
      if (typeof choice?.sellerSku !== "string" || !choice.sellerSku.trim()) continue;
      const label = typeof choice.label === "string" && choice.label.trim() ? choice.label : choice.sellerSku;
      choices.set(choice.sellerSku, label);
    }
    if (!choices.size || !isSheinTab(anchor)) return false;
    const previous = pendingSku?.anchor.id === anchor.id && pendingSku.anchor.url === anchor.url ? selectedDefaultSku() : "";
    pendingSku = { anchor, choices };
    targetTab = anchor;
    defaultSku.replaceChildren(Object.assign(document.createElement("option"), { value: "", textContent: "请选择 SKU" }),
      ...Array.from(choices, ([value, textContent]) => Object.assign(document.createElement("option"), { value, textContent })));
    defaultSku.value = choices.has(previous) ? previous : "";
    defaultSkuRow.hidden = false;
    upload.checked = uploadAllowed;
    showDefaultSkuUpload(uploadAllowed);
    return true;
  }

  function renderCategory(path) {
    const parts = Array.isArray(path) ? path : typeof path === "string" ? path.split(/[>›＞]/u) : [];
    const trail = parts.filter(part => typeof part === "string" && part.trim()).map(part => part.trim()).join(" › ");
    category.hidden = !trail;
    category.textContent = trail ? `类目 ${trail}` : "";
  }

  function updateSelectedProduct() {
    const input = selectedProduct()?.input;
    clearDefaultSku();
    renderCategory(input?.shein?.categoryPath ?? input?.categoryPath);
    upload.checked = false;
    assist.checked = false;
    get("upload-row").hidden = !input || productImagePaths(input).length === 0;
    renderTarget();
  }

  function buildInput(selected, operatorNotes, sku) {
    if (selected?.input) {
      const input = operatorNotes ? { ...selected.input, operatorNotes } : selected.input;
      return sku ? { ...input, shein: { ...input.shein, defaultSku: sku } } : input;
    }
    if (!operatorNotes) throw new Error("请选择商品目录或输入商品描述。");
    const lead = operatorNotes.split(/[。\r\n]/u, 1)[0].trim();
    return { title: (lead || operatorNotes).slice(0, 160), description: operatorNotes, operatorNotes };
  }

  async function run(label, action) {
    if (operation || isAgentBusy?.()) return report("请等当前任务完成。", "needs-review");
    const controller = new AbortController();
    const { signal } = controller;
    const current = () => dialog.open && !signal.aborted;
    operation = controller;
    renderTarget();
    renderResults();
    report(label, "running");
    try {
      await action({ signal, current });
    } catch (error) {
      if (current()) report(error.name === "AbortError" ? "" : error.message || "操作失败，请重试。",
        error.name === "AbortError" ? "" : "needs-review");
    } finally {
      operation = undefined;
      if (dialog.open) {
        if (signal.aborted) report("操作已停止。");
        renderTarget();
      }
    }
  }

  async function withSeller(signal, anchor) {
    const tab = await getTargetTab();
    signal.throwIfAborted();
    if (anchor && (tab?.id !== anchor.id || tab.url !== anchor.url)) throw new Error("请切回刚才的 SHEIN 商品编辑页，再继续填写所选 SKU。");
    targetTab = tab;
    if (!isSheinTab(tab)) throw new Error("当前标签已切换，请切回 SHEIN 商家后台。");
    if (await probeAccess(tab)) {
      signal.throwIfAborted();
      return { tabId: tab.id, url: tab.url, signal, useActiveTab: true };
    }
    const denied = await authorize(tab.url, { userGesture: true, tabId: tab.id });
    signal.throwIfAborted();
    if (denied) throw new Error(denied);
    return { tabId: tab.id, url: tab.url, signal };
  }

  get("pick").addEventListener("click", () => void run("正在读取商品目录…", async ({ signal, current }) => {
    const directory = await pickDirectory();
    if (!current()) return;
    if (!directory) return report();
    const loaded = await readSheinProductDirectory(directory, { signal });
    if (!current()) return;
    products = loaded.products;
    product.replaceChildren(...products.map((entry, index) =>
      Object.assign(document.createElement("option"), { value: index, textContent: entry.title })));
    get("product-row").hidden = products.length < 2;
    const summary = get("directory-status");
    summary.hidden = !products.length;
    if (loaded.products.length) {
      summary.textContent = products.length === 1 ? products[0].title : `${loaded.name} · ${products.length} 件商品`;
      get("pick").textContent = "更换商品目录";
      description.value = "";
      report(loaded.issues.length ? "已导入可读取的商品。" : "");
    } else {
      get("pick").textContent = "选择商品目录";
      report("目录中没有可读取的商品资料。请选择商品目录，或输入商品描述。", "needs-review");
    }
    updateSelectedProduct();
    renderResults(loaded.issues);
  }));
  description.addEventListener("input", () => {
    if (!selectedProduct()) renderCategory([]);
    report();
    renderResults();
    renderTarget();
  });
  product.addEventListener("change", () => {
    description.value = "";
    report();
    renderResults();
    updateSelectedProduct();
  });
  defaultSku.addEventListener("change", renderTarget);
  upload.addEventListener("change", () => {
    if (pendingSku) showDefaultSkuUpload(upload.checked);
  });

  get("run").addEventListener("click", () => void run("正在核对商品资料…", async ({ signal, current }) => {
    const selected = selectedProduct();
    const sku = selectedDefaultSku();
    if (pendingSku && !sku) throw new Error("请先选择要填写的 SKU。");
    const input = buildInput(selected, notes(), sku);
    const uploadAllowed = upload.checked;
    const allowAI = assist.checked;
    const seller = await withSeller(signal, pendingSku?.anchor);
    upload.checked = false;
    const files = selected && (uploadAllowed || allowAI) ? await readSheinProductImages(selected, { signal }) : { images: [], issues: [] };
    const outcome = await replay({ ...seller, input, uploadRequested: uploadAllowed, images: uploadAllowed ? files.images : [], allowAI,
      referenceImages: allowAI ? files.images : [], onStep(progress) {
        if (!current()) return;
        if (progress?.categoryPath) renderCategory(progress.categoryPath);
        report(typeof progress === "string" ? progress : progress?.label, "running");
      },
    });
    if (!current()) return;
    if (outcome?.categoryPath) renderCategory(outcome.categoryPath);
    const needsSku = Array.isArray(outcome?.defaultSkuChoices) && requestDefaultSku(outcome, seller, uploadAllowed);
    const issues = (outcome?.issues || []).map(issue => typeof issue === "string" ? issue :
      [issue?.label, issue?.message].filter(Boolean).join(" · "));
    renderResults([...files.issues, ...issues]);
    const blockingIssues = (outcome?.issues || []).some(issue => issue?.code !== "DEFAULT_SKU_ONLY");
    const state = outcome?.ok && !needsSku && !blockingIssues && !files.issues.length ? "verified" : "needs-review";
    if (state === "verified") {
      clearDefaultSku();
    }
    report(state === "verified" ? "商品资料已填写，请在 SHEIN 核对并发布。" :
      needsSku ? "选择一个 SKU 后继续填写。" : outcome?.message || "还有需要处理的问题，请查看下方提示。", state);
  }));

  stop.addEventListener("click", () => {
    operation?.abort();
    report("正在停止…", "running");
    renderTarget();
  });
  function close() {
    revision++;
    operation?.abort();
    upload.checked = false;
    assist.checked = false;
    clearDefaultSku();
    if (dialog.open) dialog.close();
  }
  get("close").addEventListener("click", close);
  get("back").addEventListener("click", () => { close(); onBack?.(); });
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });

  return async function openSheinListing() {
    const opening = ++revision;
    targetTab = undefined;
    clearDefaultSku();
    report();
    renderResults();
    renderTarget();
    if (!dialog.open) dialog.showModal();
    try {
      const tab = await getTargetTab();
      if (opening === revision && dialog.open) {
        targetTab = tab;
        renderTarget();
      }
    } catch (error) {
      if (opening === revision && dialog.open) report(error.message || "暂时无法读取当前标签。", "needs-review");
    }
    return true;
  };
}

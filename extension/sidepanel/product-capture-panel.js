import {
  captureFolderName, captureProduct, exportCapturedProduct, listCapturedProducts, saveCapturedProduct,
} from "../flows/product-capture.js";
import { workflowPlatforms } from "../flows/catalog.js";
import { identifyWorkflowPage } from "../flows/workflow-context.js";
import { $ } from "./dom.js";

const platformName = id => workflowPlatforms.find(item => item.id === id)?.name || id;

export function bindProductCapturePanel({ getTargetTab, downloadText }) {
  const dialog = $("product-capture-dialog");
  const title = $("product-capture-title");
  const status = $("product-capture-status");
  const library = $("product-capture-library");
  const preview = $("product-capture-preview");
  const fields = $("product-capture-fields");
  const save = $("product-capture-save");
  const download = $("product-capture-download");
  const directory = $("product-capture-directory");
  const back = $("product-capture-back");
  const actions = [save, download, directory, back];
  let selected = null;
  let revision = 0;

  function show(message) {
    revision++;
    title.textContent = message;
    status.textContent = "";
    delete status.dataset.error;
    selected = null;
    library.hidden = true;
    library.replaceChildren();
    preview.hidden = true;
    preview.querySelector("details").open = false;
    actions.forEach(button => { button.disabled = false; });
    if (!dialog.open) dialog.showModal();
    return revision;
  }

  function report(message, error = false) {
    status.textContent = message;
    if (error) status.dataset.error = "true";
    else delete status.dataset.error;
  }

  function showProduct(product, fromLibrary) {
    selected = product;
    const { platform, productId } = product.source;
    title.textContent = fromLibrary ? "商品库" : "商品资料";
    $("product-capture-name").textContent = product.title;
    $("product-capture-summary").textContent = [
      platformName(platform),
      `商品 ${productId}`,
      `主图 ${product.images.length} · 详情图 ${product.detailImages.length}`,
      `规格 ${product.variantGroups.length} · SKU ${product.skus.length}`,
    ].join(" ｜ ");
    const price = product.sourcePrice;
    const rows = [
      ["品牌", product.brand], ["来源类目", product.sourceCategory],
      ["产地", product.countryOfOrigin],
      ["来源价格", price?.display || [price?.amount, price?.currency].filter(Boolean).join(" ")],
    ];
    fields.replaceChildren(...rows.flatMap(([name, value]) => {
      if (!value) return [];
      const term = document.createElement("dt");
      term.textContent = name;
      const description = document.createElement("dd");
      description.textContent = value;
      return [term, description];
    }));
    $("product-capture-json").textContent = JSON.stringify(product, null, 2);
    save.hidden = fromLibrary;
    back.hidden = !fromLibrary;
    preview.hidden = false;
    report("");
  }

  async function openProductCapture(_feature, expectedPlatform) {
    const run = show("提取商品");
    report("正在读取当前商品…");
    try {
      const tab = await getTargetTab();
      const page = identifyWorkflowPage(tab?.url);
      if (!page?.productId || expectedPlatform && page.platform !== expectedPlatform) {
        throw new Error("请在当前标签打开对应平台的商品详情。");
      }
      const product = await captureProduct(tab);
      if (run === revision && dialog.open) showProduct(product, false);
    } catch (error) {
      if (run === revision && dialog.open) report(error?.message || "无法提取当前商品。", true);
    }
    return true;
  }

  async function openProductLibrary() {
    const run = show("商品库");
    report("正在读取商品库…");
    try {
      const products = await listCapturedProducts();
      if (run !== revision || !dialog.open) return true;
      for (const product of products) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "workflow-feature";
        const name = document.createElement("strong");
        name.textContent = product.title;
        const source = document.createElement("span");
        source.textContent = [platformName(product.source.platform), product.source.productId,
          new Date(product.source.capturedAt).toLocaleDateString()].filter(Boolean).join(" · ");
        button.append(name, source);
        button.addEventListener("click", () => {
          library.hidden = true;
          showProduct(product, true);
        });
        item.append(button);
        library.append(item);
      }
      library.hidden = !products.length;
      report(products.length ? "" : "还没有保存的商品。");
    } catch (error) {
      if (run === revision && dialog.open) report(error?.message || "无法读取商品库。", true);
    }
    return true;
  }

  async function runAction(label, action) {
    const product = selected;
    if (!product) return;
    const run = revision;
    actions.forEach(button => { button.disabled = true; });
    report(label);
    try {
      const result = await action(product, message => {
        if (run === revision && dialog.open) report(message);
      });
      if (run === revision && dialog.open) report(result || "");
    } catch (error) {
      if (run === revision && dialog.open) {
        if (error?.name === "AbortError") report("");
        else report(error?.message || "操作失败，请重试。", true);
      }
    } finally {
      if (run === revision) actions.forEach(button => { button.disabled = false; });
    }
  }

  $("product-capture-close").addEventListener("click", () => dialog.close());
  back.addEventListener("click", () => void openProductLibrary());
  save.addEventListener("click", () => void runAction("正在保存商品…", async product => {
    await saveCapturedProduct(product);
    return "已保存到插件商品库。";
  }));
  download.addEventListener("click", () => void runAction("", product => {
    downloadText(`${captureFolderName(product)}.json`, JSON.stringify(product, null, 2) + "\n", "application/json");
    return "已下载商品数据。";
  }));
  directory.addEventListener("click", () => void runAction("正在准备导出…", async (product, progress) => {
    if (typeof window.showDirectoryPicker !== "function") throw new Error("当前浏览器不支持目录选择，请下载 JSON。");
    const folder = await window.showDirectoryPicker({ id: "pagelens-captured-products", mode: "readwrite" });
    progress("正在保存商品图片和 product.json…");
    const { folderName, downloaded, failed } = await exportCapturedProduct(folder, product);
    return `已保存至「${folderName}」，下载 ${downloaded} 张图。${failed.length ? ` ${failed.length} 张未下载，已保留源地址。` : ""}`;
  }));
  return { openProductCapture, openProductLibrary };
}

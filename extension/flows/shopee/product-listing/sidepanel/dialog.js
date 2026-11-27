import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from "./batch-run.js";

const markup = `
<dialog id="ptc-flow-dialog" aria-labelledby="ptc-title">
    <header class="ptc-heading">
      <div>
        <p class="ptc-site" id="ptc-site">Shopee</p>
        <h2 id="ptc-title">商品上架</h2>
      </div>
      <div class="workflow-dialog-actions">
        <button type="button" id="ptc-back" class="secondary mini" hidden>返回工作流</button>
        <button type="button" id="ptc-close" class="icon-btn" aria-label="关闭商品上架">×</button>
      </div>
    </header>
    <p class="ptc-target" id="ptc-target">正在读取当前标签页</p>
    <a id="ptc-product-link" target="_blank" rel="noopener" hidden></a>
    <section id="ptc-batch-pane">
      <form id="ptc-batch-form">
        <button type="button" id="ptc-load-directory" class="secondary">选择商品目录</button>
        <p class="ptc-directory-hint">支持单个商品目录或包含多个商品的目录。</p>
        <details class="ptc-directory-hint">
          <summary>目录选择器不可用时</summary>
          <input id="ptc-manual-directory" aria-label="本地商品目录" placeholder="粘贴本地商品目录路径" type="text" autocomplete="off" />
          <button type="button" id="ptc-load-manual-directory" class="secondary mini">读取目录</button>
        </details>
        <label class="ptc-consent" id="ptc-batch-consent-row" hidden>
          <input id="ptc-batch-upload-consent" type="checkbox" />
          <span id="ptc-batch-consent-text">同意将下方商品的主图和 SKU 图上传到当前 Shopee 店铺</span>
        </label>
        <label class="ptc-consent" id="ptc-batch-ai-row" hidden>
          <input id="ptc-batch-ai-consent" type="checkbox" />
          允许已配置的 AI 分析商品资料及主图，补齐类目属性
        </label>
        <label class="ptc-concurrency">
          <span>并发数量（1–${MAX_CONCURRENCY}）</span>
          <input id="ptc-batch-concurrency" type="number" min="1" max="${MAX_CONCURRENCY}" step="1" value="${DEFAULT_CONCURRENCY}" required />
        </label>
        <div class="ptc-actions">
          <button type="submit" id="ptc-batch-start" class="primary" disabled>创建商品</button>
          <button type="submit" id="ptc-batch-publish" class="secondary" disabled>创建并上架</button>
          <button type="button" id="ptc-batch-stop" class="secondary" hidden>停止</button>
        </div>
      </form>
      <p id="ptc-batch-status" class="ptc-status" role="status" aria-atomic="true"></p>
      <p id="ptc-batch-import-issues" class="ptc-status" data-state="needs-review" hidden></p>
      <ol id="ptc-batch-jobs" class="ptc-batch-list" aria-label="各商品执行结果" hidden></ol>
    </section>
    <section id="ptc-remote-pane" hidden>
      <p id="ptc-status" class="ptc-status" role="status" aria-atomic="true"></p>
      <p id="ptc-result" class="ptc-result" hidden></p>
      <button type="button" id="ptc-review" class="secondary" hidden>检查异常</button>
    </section>
  </dialog>
`;

/** Mount the product workflow once in the side panel. */
export function mountProductListingDialog() {
  const existing = document.getElementById("ptc-flow-dialog");
  if (existing) return existing;
  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = chrome.runtime.getURL("flows/shopee/product-listing/sidepanel/dialog.css");
  document.head.append(style);
  const template = document.createElement("template");
  template.innerHTML = markup;
  const dialog = template.content.firstElementChild;
  document.body.append(dialog);
  return dialog;
}

import { chooseTemuProductDirectory, createTemuSuggestionFilter, normalizeTemuListingInput, suggestTemuFields } from "../flows/temu/product-listing/input.js";
import { replayTemuListing } from "../flows/temu/product-listing/listing.flow.mjs";
import { isTemuCategoryPage } from "../flows/temu/product-listing/stage1.js";
import { createTemuListingToolCaller } from "../flows/temu/product-listing/tool-adapter.js";
import { loadTemuCategoryChildren, loadTemuOrigins, resolveTemuOrigin, searchTemuCategories } from "../flows/temu/product-listing/taxonomy.js";
import { suggestTemuCategory } from "../flows/temu/product-listing/category-suggestion.js";
import { openTemuWorkflowTab } from "../flows/temu/workflow-tab.js";
import { requireHostUrl } from "../lib/optional-permissions.js";
import { bindTemuListingSelect } from "./temu-listing-select.js";
import { prepareSizeChartInput, readProductImage } from "../flows/shopee/product-listing/sidepanel/product-directory.js";
import { suggestTemuSizeChart } from "../flows/temu/product-listing/size-chart-suggestion.js";

const startUrl = "https://agentseller.temu.com/goods/create/category";
const sitePreference = "pagelens.temu.listingSite";
const defaultOrigin = { country: "中国大陆", region: "浙江省" };
// Snapshot of the seller's Step 1 options. Replay verifies the choice against the current store.
const knownSites = [
  "美国站", "加拿大站", "英国站", "澳大利亚站、新西兰站", "欧盟地区", "墨西哥站", "瑞士站", "日本站", "沙特站",
  "阿联酋站", "科威特站", "挪威站", "智利站", "马来西亚站", "菲律宾站", "泰国站", "卡塔尔站", "约旦站", "阿曼站",
  "巴林站", "以色列站", "南非站", "塞尔维亚", "摩尔多瓦", "黑山", "冰岛", "波黑", "阿尔巴尼亚",
  "秘鲁", "哥伦比亚", "格鲁吉亚", "亚美尼亚", "阿塞拜疆", "乌克兰", "毛里求斯", "摩洛哥", "巴拿马站",
  "厄瓜多尔站", "斯里兰卡站", "越南站", "文莱站", "北马其顿", "吉尔吉斯斯坦站", "列支敦士登站",
];
const icon = name => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function field(id, label, { search, trail = false, hidden = false } = {}) {
  return `<div class="temu-field" id="temu-${id}" ${hidden ? "hidden" : ""}>
    <span class="temu-label" id="temu-${id}-label">${label}</span>
    <button class="temu-select-trigger" type="button" aria-labelledby="temu-${id}-label temu-${id}-value">
      <span id="temu-${id}-value"></span>${icon("chevron")}
    </button>
    <div class="temu-select-menu" id="temu-${id}-menu" hidden>
      ${search ? `<input type="search" aria-label="${search}" placeholder="${search}" autocomplete="off" />` : ""}
      ${trail ? '<nav class="temu-category-trail" aria-label="当前分类层级" hidden></nav>' : ""}
      <div class="temu-select-options"></div>
    </div>
  </div>`;
}

export function bindTemuListingPanel({
  getTargetTab, getSettings, isAgentBusy, onBack,
  chooseDirectory = chooseTemuProductDirectory, suggestCategory = suggestTemuCategory,
  fetchImpl = fetch, openTab = openTemuWorkflowTab, replay = replayTemuListing,
}) {
  const dialog = document.createElement("dialog");
  dialog.className = "temu-listing-dialog";
  dialog.setAttribute("aria-labelledby", "temu-listing-title");
  dialog.innerHTML = `
    <header class="temu-listing-header">
      <button class="icon-btn" type="button" data-action="back" aria-label="返回工作流" title="返回工作流">${icon("back")}</button>
      <h2 id="temu-listing-title">Temu 商品上架</h2>
      <button class="icon-btn" type="button" data-action="close" aria-label="关闭" title="关闭">${icon("close")}</button>
    </header>
    <div class="temu-listing-body">
      <fieldset class="temu-listing-source" aria-label="商品资料">
        <div class="temu-field">
          <span class="temu-label">商品目录</span>
          <button class="temu-listing-action temu-directory-button" type="button" data-action="choose">
            ${icon("folder")}<span>选择商品目录</span>
          </button>
          <p id="temu-directory-summary" class="temu-hint" role="status">可选单个商品目录或包含多个商品的文件夹。</p>
        </div>
        ${field("product-item", "目录中的商品", { search: "搜索商品", hidden: true })}
        ${field("listing-site", "经营站点", { search: "搜索站点" })}
        <div>
          ${field("listing-category", "商品类目", { search: "搜索商品类目", trail: true })}
          <p id="temu-category-hint" class="temu-hint" aria-live="polite"></p>
        </div>
        <div class="temu-listing-grid">
          ${field("listing-origin", "商品产地", { search: "搜索国家或地区" })}
          ${field("listing-region", "省份或地区", { search: "搜索省份或地区" })}
        </div>
        <label class="temu-listing-check" id="temu-upload-option" hidden><input id="temu-listing-upload" type="checkbox" />上传商品目录中的图片</label>
        <label for="temu-product-notes">补充商品描述</label>
        <textarea id="temu-product-notes" rows="3" maxlength="1800" placeholder="例如商品名称、材质、规格或用途"></textarea>
        <label class="temu-listing-check"><input id="temu-listing-ai" type="checkbox" />允许将商品资料和图片发送给已配置的模型，用于匹配类目和补齐表单</label>
      </fieldset>
      <div id="temu-listing-message" role="status" aria-live="polite"></div>
      <ul id="temu-listing-issues"></ul>
    </div>
    <footer class="temu-listing-footer">
      <button class="temu-listing-action primary" type="button" data-action="run" disabled>开始上品</button>
      <button class="temu-listing-action" type="button" data-action="stop" hidden>停止</button>
    </footer>`;
  document.body.append(dialog);

  const find = id => dialog.querySelector(`#temu-${id}`);
  const action = name => dialog.querySelector(`[data-action="${name}"]`);
  const message = find("listing-message");
  const issues = find("listing-issues");
  const source = dialog.querySelector("fieldset");
  const directorySummary = find("directory-summary");
  const categoryHint = find("category-hint");
  const categoryTrail = dialog.querySelector(".temu-category-trail");
  const upload = find("listing-upload");
  const notes = find("product-notes");
  let products = [];
  let directoryRoot;
  let productIndex = 0;
  let origins;
  let originsPending;
  let chosenOrigin = { ...defaultOrigin };
  let chosenSite = knownSites[0];
  let chosenCategory;
  let manualCategory = false;
  let manualOrigin = false;
  let categoryRequest;
  let categoryTrailParts = [];
  let categoryQuery = 0;
  let categoryTimer;
  let notesTimer;
  let directoryRequest;
  let run;

  try {
    const saved = document.defaultView.localStorage.getItem(sitePreference);
    if (knownSites.includes(saved)) chosenSite = saved;
  } catch { /* The preference remains available in the current panel. */ }

  function tell(text, error = false) {
    message.textContent = text;
    message.toggleAttribute("data-error", error);
  }

  function select(id, label, placeholder, render) {
    return bindTemuListingSelect(find(id), { label, placeholder, search: render, onOpen: () => render("") });
  }

  function renderChoices(control, values, query, pick) {
    control.render(values.filter(label => label.toLowerCase().includes(query.toLowerCase()))
      .map(label => ({ key: label, label, pick: () => pick(label) })));
  }

  const site = select("listing-site", "经营站点", "选择站点", query => renderChoices(site, knownSites, query, value => {
    chosenSite = value;
    site.setValue(value);
    try { document.defaultView.localStorage.setItem(sitePreference, value); } catch { /* Keep the current selection. */ }
  }));
  site.setValue(chosenSite);

  const country = select("listing-origin", "商品产地", "选择产地", async query => {
    try {
      await ensureOrigins();
      if (!country.isOpen() || find("listing-origin").querySelector("input").value.trim() !== query) return;
      renderChoices(country, origins.filter(row =>
        !query || [row.country, ...row.aliases].some(name => name.toLowerCase().includes(query.toLowerCase()))
      ).map(row => row.country), "", value => {
        manualOrigin = true;
        setOrigin(value === defaultOrigin.country ? defaultOrigin : { country: value });
      });
    } catch {
      if (country.isOpen()) country.render([], "无法加载产地目录，请重新打开选择器。");
    }
  });
  const region = select("listing-region", "省份或地区", "选择省份或地区", async query => {
    try {
      await ensureOrigins();
      if (!region.isOpen() || find("listing-region").querySelector("input").value.trim() !== query) return;
      renderChoices(region, regions(), query, value => {
        manualOrigin = true;
        setOrigin({ ...chosenOrigin, region: value });
      });
    } catch {
      if (region.isOpen()) region.render([], "无法加载产地目录，请重新打开选择器。");
    }
  });

  function regions() {
    return origins?.find(row => row.country === chosenOrigin.country)?.regions || [];
  }

  function setOrigin(value) {
    chosenOrigin = { ...value };
    country.setValue(chosenOrigin.country);
    region.setValue(chosenOrigin.region);
    const unavailable = Boolean(origins && !regions().length);
    region.setDisabled(unavailable);
    if (unavailable) region.setValue("此产地无需选择");
  }
  setOrigin(defaultOrigin);

  function ensureOrigins() {
    if (origins) return Promise.resolve(origins);
    if (!originsPending) originsPending = loadTemuOrigins({ fetchImpl }).then(rows => {
      origins = rows;
      setOrigin(chosenOrigin);
      return rows;
    }).finally(() => { originsPending = undefined; });
    return originsPending;
  }

  const productItem = select("product-item", "目录中的商品", "选择商品", query => {
    productItem.render(products.flatMap(({ title }, index) => title.toLowerCase().includes(query.toLowerCase())
      ? [{ key: String(index), label: title, pick: () => setProduct(index) }]
      : []));
  });

  const category = bindTemuListingSelect(find("listing-category"), {
    label: "商品类目",
    placeholder: "选择类目",
    onOpen: () => {
      categoryTrailParts = (chosenCategory?.ids || []).slice(0, -1)
        .map((id, index) => ({ id, label: chosenCategory.path[index] }));
      showCategoryLevel("");
    },
    search: query => {
      clearTimeout(categoryTimer);
      ++categoryQuery;
      category.render([], "正在查找类目…");
      categoryTimer = setTimeout(() => showCategoryLevel(query), query ? 160 : 0);
    },
  });

  function syncRunButton() {
    action("run").disabled = Boolean(run || directoryRequest || !chosenCategory);
  }

  function updateCategory(value) {
    chosenCategory = value;
    syncRunButton();
    const path = value?.path.join(" › ");
    category.setValue(path, value?.id || "");
  }

  function pickCategory(value) {
    manualCategory = true;
    categoryRequest?.abort();
    updateCategory(value);
    categoryHint.textContent = "";
  }

  function showTrail(searching) {
    categoryTrail.replaceChildren();
    categoryTrail.hidden = searching || !categoryTrailParts.length;
    if (categoryTrail.hidden) return;
    categoryTrail.append(...["全部类目", ...categoryTrailParts.map(part => part.label)].map((name, index) => {
      const bread = document.createElement("button");
      bread.type = "button";
      bread.textContent = name;
      bread.addEventListener("click", () => {
        categoryTrailParts = categoryTrailParts.slice(0, index);
        find("listing-category").querySelector("input").focus();
        void showCategoryLevel("");
      });
      return bread;
    }));
  }

  async function showCategoryLevel(query) {
    clearTimeout(categoryTimer);
    const revision = ++categoryQuery;
    const trail = categoryTrailParts;
    const ids = trail.map(part => part.id);
    showTrail(Boolean(query));
    category.render([], "正在加载类目…");
    try {
      const rows = query
        ? (await searchTemuCategories(query, { withIds: true, fetchImpl })).map(value => ({
          key: value.id, label: value.path.join(" › "), pick: () => pickCategory(value),
        }))
        : (await loadTemuCategoryChildren(ids, { fetchImpl })).map(node => ({
          key: node.id, label: node.label, branch: !node.leaf, pick: () => {
            if (node.leaf) {
              pickCategory({ id: node.id, ids: [...ids, node.id], path: [...trail.map(part => part.label), node.label] });
            } else {
              categoryTrailParts = [...trail, node];
              void showCategoryLevel("");
            }
          },
        }));
      if (revision === categoryQuery && category.isOpen()) category.render(rows, "没有匹配的商品类目。");
    } catch {
      if (revision === categoryQuery && category.isOpen()) category.render([], "无法加载类目，请重新打开选择器。");
    }
  }

  function selected() {
    return products[productIndex]?.input;
  }

  function sourceInput() {
    const description = notes.value.trim();
    const base = selected();
    if (!base && !description) throw new Error("请选择商品目录或填写商品描述。");
    const title = base?.title || description.split(/[\n。]/u)[0].slice(0, 100);
    const normalized = normalizeTemuListingInput({ ...base, title, description: base?.description || description });
    const filled = { ...base };
    filled.operatorNotes = description;
    for (const [key, value] of Object.entries(normalized)) {
      if (value == null || value === "" || (Array.isArray(value) && !value.length)) continue;
      filled[key] = value;
    }
    filled.attributes = { ...base?.attributes, ...normalized.attributes };
    filled.listingAttributes = { ...base?.listingAttributes, ...normalized.listingAttributes };
    for (const key of ["mainImages", "detailImages", "variantImages", "sharedGalleryImages", "sizeChartImagePath"]) {
      filled[key] = base?.[key] ?? normalized[key];
    }
    for (const key of ["skus", "variantGroups"]) filled[key] = base?.[key]?.length ? base[key] : normalized[key];
    return filled;
  }

  async function recommend() {
    categoryRequest?.abort();
    let product;
    try { product = sourceInput(); } catch { return; }
    const controller = new AbortController();
    categoryRequest = controller;
    const { signal } = controller;

    void ensureOrigins().then(rows => {
      if (signal.aborted || manualOrigin || !dialog.open) return;
      const exact = product.origin && resolveTemuOrigin(rows, product.origin);
      setOrigin(exact?.country === defaultOrigin.country ? { ...defaultOrigin, ...exact } : exact || defaultOrigin);
    }).catch(() => { /* Default display stays available while the packaged catalog retries. */ });

    if (manualCategory) return;
    updateCategory(undefined);
    categoryHint.textContent = "正在根据商品推荐类目…";
    try {
      const result = await suggestCategory(product, { settings: getSettings?.(), signal, fetchImpl, useModel: find("listing-ai").checked });
      if (signal.aborted || manualCategory || !dialog.open) return;
      updateCategory(result.category);
      categoryHint.textContent = result.source === "model" ? "AI 推荐，可修改。"
        : result.source === "provided" ? "已匹配商品资料中的类目。"
        : result.category ? "已按商品资料匹配，可修改。" : "暂无合适推荐，请从类目列表选择。";
    } catch {
      if (!signal.aborted && dialog.open) categoryHint.textContent = "类目推荐暂不可用，可手动选择。";
    }
  }

  function setProduct(index) {
    productIndex = index;
    const product = products[index];
    productItem.setValue(product.title, String(index));
    manualCategory = false;
    manualOrigin = false;
    setOrigin(defaultOrigin);
    updateCategory(undefined);
    const { mainImages, detailImages, variantImages, sizeChartImagePath } = product.input;
    const hasImages = mainImages.length + detailImages.length + variantImages.length > 0 || Boolean(sizeChartImagePath);
    find("upload-option").hidden = !hasImages;
    if (!hasImages) upload.checked = false;
    tell("");
    void recommend();
  }

  action("choose").addEventListener("click", async () => {
    if (directoryRequest || run) return;
    const pending = { open: true };
    directoryRequest = pending;
    action("choose").disabled = true;
    action("run").disabled = true;
    action("choose").querySelector("span").textContent = "正在选择目录…";
    try {
      const result = await chooseDirectory();
      if (!result || !pending.open || !dialog.open) return;
      products = result.products;
      directoryRoot = result.root;
      productIndex = 0;
      find("product-item").hidden = products.length < 2;
      directorySummary.textContent = products.length === 1 ? products[0].title : `${result.directoryName} · ${products.length} 件商品`;
      upload.checked = false;
      issues.replaceChildren();
      if (products.length) {
        setProduct(0);
      } else {
        categoryRequest?.abort();
        categoryHint.textContent = "";
        manualCategory = manualOrigin = false;
        updateCategory(undefined);
        setOrigin(defaultOrigin);
        find("upload-option").hidden = true;
        upload.checked = false;
        tell("该目录没有可读取的商品资料。可以更换目录或填写商品描述。", true);
      }
      renderIssues(result.issues.map(item => `${item.folder}：${item.error}`));
    } catch (error) {
      if (pending.open && dialog.open) tell(error.message, true);
    } finally {
      directoryRequest = undefined;
      action("choose").disabled = false;
      syncRunButton();
      action("choose").querySelector("span").textContent = products.length ? "更换商品目录" : "选择商品目录";
    }
  });

  notes.addEventListener("input", () => {
    if (!manualCategory) {
      categoryRequest?.abort();
      updateCategory(undefined);
      categoryHint.textContent = "";
    }
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => void recommend(), 400);
  });
  find("listing-ai").addEventListener("change", () => void recommend());

  function renderIssues(receipts) {
    issues.replaceChildren(...[...new Set(receipts)].map(textContent => Object.assign(document.createElement("li"), { textContent })));
  }

  action("run").addEventListener("click", async () => {
    if (run || directoryRequest || isAgentBusy?.()) return tell("请等当前任务结束后再试。", true);
    const signal = (run = new AbortController()).signal;
    for (const control of [site, category, country, region, productItem]) control.close();
    source.disabled = action("run").disabled = true;
    action("stop").hidden = false;
    issues.replaceChildren();
    try {
      const input = sourceInput();
      if (!chosenCategory) throw new Error("请选择完整的商品类目。");
      categoryRequest?.abort();
      clearTimeout(notesTimer);
      input.sites = [chosenSite];
      input.categoryPath = chosenCategory.path;
      input.categoryId = chosenCategory.id;
      input.origin = { ...chosenOrigin };
      tell("正在打开 Temu 新建商品页…");
      const active = await getTargetTab();
      signal.throwIfAborted();
      let canAccess = false;
      if (isTemuCategoryPage(active?.url)) {
        canAccess = await chrome.scripting.executeScript({ target: { tabId: active.id }, func: () => true })
          .then(() => true, () => false);
      }
      if (!canAccess) {
        const permission = await requireHostUrl(startUrl, { userGesture: true, tabId: active?.id });
        if (permission) throw new Error(permission);
      }
      const tab = await openTab({ tab: active, href: startUrl, accepts: isTemuCategoryPage, signal });
      signal.throwIfAborted();
      const approved = upload.checked;
      input.uploadImages = approved;
      const useModel = find("listing-ai").checked;
      const selectedProduct = products[productIndex];
      const referenceImage = input.mainImages?.[0] || input.detailImages?.[0] || input.variantImages?.[0];
      const readSizeChart = useModel && selectedProduct && input.sizeChartImagePath
        ? async () => (await prepareSizeChartInput({ ...selectedProduct, input }, {
          root: directoryRoot, signal, getSettings: getSettings ? async () => getSettings() : undefined,
        })).sizeChart
        : undefined;
      let imageRead;
      const readImage = useModel && selectedProduct && referenceImage ? () => imageRead ??= readProductImage({
        root: directoryRoot, folder: selectedProduct.folder, path: referenceImage, asset: "main", signal,
      }) : undefined;
      const suggestSizeChart = useModel ? async (product, { sizes, signal }) => suggestTemuSizeChart(product, {
        sizes, signal, settings: await getSettings?.(), readImage,
      }) : undefined;
      const imagePaths = new Set([...(input.mainImages || []), ...(input.detailImages || []), ...(input.variantImages || []), input.sizeChartImagePath]);
      const call = createTemuListingToolCaller({
        tabId: tab.id, url: tab.url, signal,
        confirmUpload: ({ paths }) => approved && paths.every(file => imagePaths.has(file)),
      });
      const result = await replay({
        tabId: tab.id, input, call, signal, readSizeChart, suggestSizeChart,
        shouldSuggestField: createTemuSuggestionFilter(input, { useModel, visual: Boolean(readImage) }),
        suggestFields: (product, schema, { signal }) =>
          suggestTemuFields(product, schema, { signal, settings: getSettings?.(), useModel, readImage }),
        onStep: ({ label }) => tell(label),
      });
      tell(result.status === "cancelled" ? "上品已停止。" : result.status === "needs-review"
        ? "请处理下方待核对事项。" : "商品资料已填写，请在 Temu 核对并发布。", result.status === "needs-review");
      renderIssues([...result.issues.map(({ label, message }) => `${label}：${message}`), ...result.missing.map(({ label }) => `待填：${label}`)]);
    } catch (error) {
      tell(signal.aborted ? "上品已停止。" : error.message || "暂时无法完成 Temu 上品。", !signal.aborted);
    } finally {
      run = undefined;
      source.disabled = false;
      syncRunButton();
      action("stop").hidden = true;
    }
  });

  function cancelPending() {
    for (const control of [site, category, country, region, productItem]) control.close();
    clearTimeout(categoryTimer);
    clearTimeout(notesTimer);
    if (directoryRequest) directoryRequest.open = false;
    categoryRequest?.abort();
    run?.abort();
  }

  function dismiss() {
    cancelPending();
    dialog.close();
  }

  action("stop").addEventListener("click", () => run?.abort());
  action("close").addEventListener("click", dismiss);
  action("back").addEventListener("click", () => { dismiss(); onBack?.(); });
  dialog.addEventListener("cancel", cancelPending);

  return async function open() {
    if (!dialog.open) {
      dialog.showModal();
      void ensureOrigins().catch(() => {});
      if (!chosenCategory && !manualCategory && (selected() || notes.value.trim())) void recommend();
    }
    return true;
  };
}

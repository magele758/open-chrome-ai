/** Reads a Temu consumer product already open in the browser. */
export function readTemuProduct() {
  const page = new URL(location.href);
  if (!/^(?:www\.|m\.)?temu\.com$/u.test(page.hostname)) return null;
  const productId = page.pathname.match(/-g-(\d+)\.html$/u)?.[1] ||
    (/\/goods(?:\.html)?\/?$/u.test(page.pathname) ? page.searchParams.get("goods_id") : null);
  if (!/^\d+$/u.test(productId || "")) return null;

  const normalizeText = value => typeof value === "string"
    ? value.replace(/[\u200B-\u200D\uFEFF]/gu, "").replace(/\s+/gu, " ").trim()
    : "";
  const cleanText = node => normalizeText(node?.innerText || node?.textContent);
  const bodyStart = normalizeText((document.body?.innerText || document.body?.textContent || "").slice(0, 8192));
  if (/^(?:security verification|安全验证)\b|please complete the verification to continue/iu.test(bodyStart.slice(0, 1800))) return null;

  const meta = key => document.querySelector(`meta[property="${key}"], meta[name="${key}"]`)?.content || "";
  const asArray = value => Array.isArray(value) ? value : value == null ? [] : [value];
  const unique = values => [...new Set(values.filter(Boolean))];
  const stringId = value => typeof value === "string" ? value.trim() : Number.isSafeInteger(value) ? String(value) : "";
  const scalar = (...values) => values.map(value => normalizeText(typeof value === "number" ? String(value) : value)).find(Boolean) || "";
  const isGroup = (value, name) => asArray(value?.["@type"]).some(type => type === name || type === `https://schema.org/${name}`);
  const productMedia = value => {
    const source = typeof value === "string" ? value : scalar(value?.contentUrl, value?.url, value?.imageUrl, value?.imgUrl, value?.src, value?.img, value?.image);
    if (!source || !/^(?:https?:)?\/\//iu.test(source)) return "";
    try {
      const url = new URL(source, page);
      if (url.protocol !== "https:" || url.username || url.password || url.port) return "";
      if (!/(?:^|\.)kwcdn\.com$/iu.test(url.hostname) && url.hostname !== page.hostname) return "";
      return url.href;
    } catch { return ""; }
  };
  const urlsFrom = (...fields) => unique(fields.flatMap(field => asArray(field).map(productMedia)));
  const metaProducts = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    if (script.textContent.length > 300_000) continue;
    try {
      const roots = asArray(JSON.parse(script.textContent));
      for (const root of roots.flatMap(item => [item, ...asArray(item?.["@graph"])])) {
        for (const item of [root, root?.mainEntity]) {
          if (isGroup(item, "Product") || isGroup(item, "ProductGroup")) metaProducts.push(item);
        }
      }
    } catch { /* Other JSON-LD can still describe the page. */ }
  }
  function refersToPage(value) {
    if (typeof value !== "string") return false;
    try {
      const url = new URL(value, page);
      return /^(?:www\.|m\.)?temu\.com$/u.test(url.hostname) &&
        (url.pathname.endsWith(`-g-${productId}.html`) ||
          /\/goods(?:\.html)?\/?$/u.test(url.pathname) && url.searchParams.get("goods_id") === productId);
    } catch { return false; }
  }
  const schema = metaProducts.find(item => stringId(item.productID) === productId || refersToPage(item.url) || refersToPage(item["@id"])) ||
    (metaProducts.length === 1 && !metaProducts[0]?.url ? metaProducts[0] : null);

  // Limit discovery to loaded page state, and only accept matching product IDs.
  function productData() {
    const pending = [window.rawData?.store, window.__INITIAL_PROPS__].map(data => ({ data, depth: 0 }));
    const checked = new WeakSet();
    let best = null;
    let bestScore = 0;
    for (let index = 0; index < pending.length && index < 1400; index++) {
      const { data, depth } = pending[index];
      if (!data || typeof data !== "object" || checked.has(data)) continue;
      checked.add(data);
      if ([data.goodsId, data.goods_id, data.productId].map(stringId).includes(productId)) {
        const score = Number(Boolean(scalar(data.goodsName, data.goods_name, data.title, data.name))) +
          Number(Boolean(data.goodsGallery || data.gallery || data.goodsImages)) +
          Number(Boolean(data.skuList || data.skus));
        if (score > bestScore) {
          best = data;
          bestScore = score;
        }
      }
      if (depth >= 6 || Array.isArray(data) && data.length > 240) continue;
      for (const key of Object.keys(data).slice(0, 100)) {
        if (/recommend|review|related|history|i18n|translation/iu.test(key)) continue;
        const child = Object.getOwnPropertyDescriptor(data, key)?.value;
        if (child && typeof child === "object") pending.push({ data: child, depth: depth + 1 });
      }
    }
    return best || {};
  }
  const embedded = productData();
  const heading = [...document.querySelectorAll("h1, [role=heading][aria-level='1']")]
    .find(node => cleanText(node) && !node.closest("[hidden], [aria-hidden=true]"));
  const titleNode = heading?.cloneNode(true);
  titleNode?.querySelectorAll("button, [role=button], [aria-hidden=true], svg, script, style").forEach(node => node.remove());
  const actualTitle = scalar(cleanText(titleNode), schema?.name, embedded.goodsName, embedded.goods_name, embedded.title);
  const ogTitle = scalar(meta("og:title")).replace(/\s*[-|–]\s*Temu(?:\s+[^|–]+)?$/iu, "");
  const title = actualTitle || (meta("og:type") === "product" ? ogTitle : "");
  if (!title || /^(?:temu|404|page not found|security verification|item unavailable)$/iu.test(title)) return null;

  const isDetails = text => /^(?:product details|item details|specifications|商品详情|商品信息|产品详情|détails du produit)(?:\s*[：:])?$/iu.test(text);
  const isDescription = text => /^(?:product description|item description|description|商品描述|产品描述|description du produit)(?:\s*[：:])?$/iu.test(text);
  const visible = node => !node.closest("[hidden], [aria-hidden=true]");
  function sectionHeading(matches) {
    const headings = [...document.querySelectorAll("h2,h3,h4,[role=heading],summary")];
    return headings.find(node => visible(node) && matches(cleanText(node))) ||
      [...document.querySelectorAll("div,span,p")].find(node =>
        !node.childElementCount && visible(node) && matches(cleanText(node)));
  }
  const detailsHeading = sectionHeading(isDetails);
  const attributes = new Map();
  const addAttribute = (name, value) => {
    const key = scalar(name).replace(/[：:]$/u, "").trim();
    const entry = scalar(value);
    if (key && key.length <= 65 && entry && entry.length <= 600 && !attributes.has(key)) {
      attributes.set(key, entry);
    }
  };
  for (const entry of asArray(schema?.additionalProperty)) addAttribute(entry?.name, entry?.value);
  for (const entry of asArray(embedded.goodsProperty ?? embedded.goodsProperties)) {
    addAttribute(scalar(entry?.name, entry?.key, entry?.propName), scalar(entry?.value, entry?.propValue));
  }
  const readDetailRows = node => {
    const rows = [];
    for (const term of node.querySelectorAll("dt")) {
      if (term.nextElementSibling?.tagName === "DD") rows.push([cleanText(term), cleanText(term.nextElementSibling)]);
    }
    for (const row of node.querySelectorAll("tr")) {
      if (row.cells.length === 2) rows.push([cleanText(row.cells[0]), cleanText(row.cells[1])]);
    }
    const knownLabel = /^(?:brand|material|composition|pattern|color|colour|style|suitable types|weaving method|item id|country of origin|made in|fiber content|care instructions|品牌|材质|成分|图案|颜色|产地|原产国)(?:[：:])?$/iu;
    for (const label of node.querySelectorAll("span,div,b,strong,p")) {
      if (label.children.length) continue;
      const key = cleanText(label);
      const value = label.nextElementSibling;
      if (knownLabel.test(key) && value && value.childElementCount <= 2) {
        rows.push([key, cleanText(value)]);
      } else if (label.parentElement.childElementCount === 1 && knownLabel.test(key) && label.parentElement.nextElementSibling) {
        rows.push([key, cleanText(label.parentElement.nextElementSibling)]);
      }
    }
    return rows;
  };
  let details;
  for (let ancestor = detailsHeading?.parentElement, step = 0; ancestor && step < 4; ancestor = ancestor.parentElement, step++) {
    if (["MAIN", "BODY", "HTML"].includes(ancestor.tagName) || cleanText(ancestor).length > 18000) break;
    const rows = readDetailRows(ancestor);
    if (rows.length) {
      details = ancestor;
      for (const row of rows) addAttribute(...row);
      break;
    }
  }

  const descriptionHeading = sectionHeading(isDescription);
  const descriptionText = cleanText(descriptionHeading?.nextElementSibling ?? descriptionHeading?.parentElement.nextElementSibling);
  const actualDescription = scalar(cleanText(document.querySelector('[itemprop="description"]')), descriptionText,
    schema?.description, embedded.goodsDescription, embedded.description);
  const description = actualDescription || scalar(meta("og:description"), meta("description"));
  const imageFor = node => {
    const image = node?.matches("img") ? node : node?.querySelector("img");
    return urlsFrom(image?.currentSrc, image?.getAttribute("data-src"), image?.getAttribute("src"))[0] || "";
  };
  const label = node => scalar(node.getAttribute("aria-label"), node.getAttribute("alt"), node.getAttribute("title"));
  const photoNodes = [...document.querySelectorAll("[aria-label], img[alt]")];
  const galleryNodes = photoNodes.filter(node => /^(?:product image|商品图片|商品图|image du produit)\s*\d/iu.test(label(node)));
  const detailNodes = photoNodes.filter(node => /(?:product details|商品详情|détails du produit)\s*\d+$/iu.test(label(node)));
  const detailImages = unique([
    ...urlsFrom(embedded.detailImages, embedded.goodsDetailImages, embedded.detailGallery),
    ...detailNodes.map(imageFor),
    ...[...details?.querySelectorAll("img") || []].map(imageFor),
  ]);
  const images = unique([
    ...urlsFrom(schema?.image, embedded.goodsGallery, embedded.goodsGalleryList, embedded.goodsImages, embedded.gallery,
      meta("og:image")),
    ...galleryNodes.map(imageFor),
  ]).filter(url => !detailImages.includes(url));

  const variantGroups = new Map();
  const skus = new Map();
  const addOption = (name, value, image) => {
    const key = scalar(name).replace(/[：:]$/u, "").trim();
    const display = scalar(value);
    if (!key || key.length > 65 || !display || display.length > 160) return;
    const group = variantGroups.get(key) ?? new Map();
    const previous = group.get(display);
    group.set(display, { value: display, ...((image || previous?.image) ? { image: image || previous.image } : {}) });
    variantGroups.set(key, group);
  };
  function readSpecs(list) {
    return Object.fromEntries(asArray(list).map(row => [
      scalar(row?.specKey, row?.parentSpecName, row?.key, row?.name),
      scalar(row?.specValue, row?.specName, row?.value),
    ]).filter(([key, value]) => key && value));
  }
  for (const row of asArray(embedded.skuList ?? embedded.skus)) {
    const id = stringId(row?.skuId ?? row?.sku_id);
    if (!id) continue;
    const options = readSpecs(row.specs ?? row.specList ?? row.spec);
    const image = urlsFrom(row.image, row.imageUrl, row.thumbUrl, row.skuThumbUrl)[0];
    for (const [name, value] of Object.entries(options)) addOption(name, value, image);
    skus.set(id, { id, options, ...(image ? { image } : {}) });
  }
  for (const row of [
    ...asArray(schema?.hasVariant),
    ...(schema?.sku && (!schema.hasVariant || !schema.hasVariant.length) ? [schema] : []),
  ]) {
    const id = stringId(row?.sku);
    if (!id) continue;
    const offer = asArray(row.offers)[0];
    const options = Object.fromEntries([
      ["Color", scalar(row.color)], ["Size", scalar(row.size)],
      ...asArray(row.additionalProperty).map(entry => [scalar(entry?.name), scalar(entry?.value)]),
    ].filter(([key, value]) => key && value));
    const image = urlsFrom(row.image)[0];
    for (const [name, value] of Object.entries(options)) addOption(name, value, image);
    const price = scalar(offer?.price);
    const currency = scalar(offer?.priceCurrency);
    skus.set(id, { ...skus.get(id), id, options: { ...skus.get(id)?.options, ...options },
      ...(image ? { image } : {}), ...(price ? { price } : {}), ...(currency ? { currency } : {}) });
  }
  const optionName = /^(?:color|colour|size(?:\([^)]+\)|\s*\([^)]+\))?|model|style|quantity|颜色|顏色|尺码|尺寸|样式|couleur|taille)$/iu;
  for (const group of document.querySelectorAll("[role=group][aria-label], [role=radiogroup], [role=listbox]")) {
    if (details?.contains(group)) continue;
    const name = label(group) || cleanText(document.getElementById(group.getAttribute("aria-labelledby")));
    if (!optionName.test(name)) continue;
    for (const option of group.querySelectorAll('button,[role="option"],[role="radio"]')) {
      const value = label(option) || cleanText(option);
      if (!/^(?:see more|show more|size guide|voir plus)$/iu.test(value)) addOption(name, value, imageFor(option));
    }
  }
  let purchaseScope = heading?.parentElement;
  let priceText = "";
  for (let step = 0; step < 5 && purchaseScope && !["BODY", "MAIN", "HTML"].includes(purchaseScope.tagName); step++, purchaseScope = purchaseScope.parentElement) {
    const scopeText = cleanText(purchaseScope);
    if (scopeText.length > 9500) break;
    if (!/(?:add to cart|buy now|加入购物车|ajouter au panier)/iu.test(scopeText)) continue;
    const purchaseText = purchaseScope.innerText || purchaseScope.textContent || "";
    // Only read the explicitly labelled selection. Do not infer SKU combinations
    // or use recommendation/tracking query parameters as identifiers.
    for (const source of purchaseText.split(/\n/u).slice(0, 170)) {
      for (const part of source.split(/[,，]\s*(?=(?:Color|Colour|Size|颜色|尺码|尺寸|Couleur|Taille)[^:：]*[:：])/iu)) {
        const [name, ...value] = part.split(/[:：]/u);
        if (optionName.test(normalizeText(name)) && value.length) addOption(name, value.join(":"));
      }
    }
    const leaves = [...purchaseScope.querySelectorAll("div,span,p,b,strong")].filter(node =>
      !node.childElementCount && visible(node) && !details?.contains(node));
    for (const node of leaves) {
      const name = cleanText(node).replace(/[：:]$/u, "").trim();
      const value = node.nextElementSibling;
      if (optionName.test(name) && value && visible(value) && value.childElementCount <= 1) {
        addOption(name, cleanText(value), imageFor(value));
      }
    }
    const displayedPrices = unique(leaves.filter(node => !node.closest("del,s,strike") &&
        !window.getComputedStyle(node).textDecorationLine.includes("line-through"))
      .map(cleanText).filter(value => /^(?:(?:[A-Z]{2,3}\s*)?[$€£¥])\s*\d+(?:[,.]\d{2})$/u.test(value)));
    if (displayedPrices.length === 1) priceText = displayedPrices[0];
    break;
  }
  const attribute = pattern => [...attributes].find(([key]) => pattern.test(key))?.[1] || "";
  const brand = scalar(schema?.brand?.name, schema?.brand, embedded.brandName, attribute(/^(?:brand|品牌|marque)$/iu));
  const category = scalar(schema?.category, embedded.categoryName, embedded.catName);
  const countryOfOrigin = scalar(schema?.countryOfOrigin?.name, schema?.countryOfOrigin, embedded.countryOfOrigin,
    attribute(/^(?:country\s+of\s+origin|made in|原产国|产地|pays d.origin[e]?)$/iu));
  const offers = asArray(schema?.offers);
  const offer = offers.find(value => scalar(value?.price));
  const price = scalar(offer?.price, meta("product:price:amount"));
  const currency = scalar(offer?.priceCurrency, meta("product:price:currency"));
  return {
    productId, title, description,
    ...(description && !actualDescription ? { descriptionSource: "metadata" } : {}),
    ...(brand ? { brand } : {}), ...(category ? { category } : {}),
    ...(countryOfOrigin ? { countryOfOrigin } : {}),
    ...(price ? { price } : {}), ...(currency ? { currency } : {}),
    ...(priceText ? { priceText } : {}),
    attributes: Object.fromEntries(attributes), images, detailImages,
    variantGroups: [...variantGroups].map(([name, options]) => ({ name, options: [...options.values()] })),
    skus: [...skus.values()],
  };
}

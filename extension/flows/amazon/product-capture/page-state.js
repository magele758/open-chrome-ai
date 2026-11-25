// This function is injected as a standalone, read-only browser script.
export function readAmazonProduct() {
  const productId = location.pathname
    .match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([a-z0-9]{10})(?:\/|$)/i)?.[1].toUpperCase();
  if (!productId) return null;

  const clean = (value, limit = 1000) => typeof value === "string"
    ? value.replace(/[\u200e\u200f]/gu, "").replace(/\s+/gu, " ").trim().slice(0, limit)
    : "";
  const text = (element, limit) => clean(element?.innerText || element?.textContent, limit);
  const parse = (value) => {
    try { return JSON.parse(value); } catch { return null; }
  };
  const list = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const unlabel = (value) => clean(value, 120).replace(/\s*[:：]+\s*$/u, "");
  const asin = (value) => typeof value === "string" && /^[a-z0-9]{10}$/i.test(value) ? value.toUpperCase() : "";
  const records = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

  // Extract inert JSON out of Amazon's setup scripts without evaluating any page code.
  function jsonProperty(source, key) {
    const marker = new RegExp('["\\x27]' + key + '["\\x27]\\s*:\\s*([\\[{])').exec(source);
    if (!marker) return null;
    const start = marker.index + marker[0].length - 1;
    let depth = 0;
    let quoted = false;
    for (let offset = start; offset < source.length; offset++) {
      const token = source[offset];
      if (quoted && token === "\\") { offset++; continue; }
      if (token === '"') { quoted = !quoted; continue; }
      if (quoted) continue;
      if (token === "{" || token === "[") depth++;
      if ((token === "}" || token === "]") && --depth === 0) {
        return parse(source.slice(start, offset + 1));
      }
    }
    return null;
  }

  const dataScripts = list("script").map(script => script.textContent)
    .filter(source => source.length < 1000000 && /dimensionValuesDisplayData|colorImages/.test(source));
  const twister = dataScripts.find(source => source.includes('"dimensionValuesDisplayData"')) || "";
  const dimensions = jsonProperty(twister, "dimensions");
  const dimensionValues = records(jsonProperty(twister, "dimensionValuesDisplayData"));
  const variationValues = records(jsonProperty(twister, "variationValues"));

  const structuredProducts = list('script[type="application/ld+json"]')
    .map(script => parse(script.textContent))
    .flatMap(value => Array.isArray(value) ? value : value?.["@graph"] || [value])
    .filter(value => [value?.["@type"]].flat().includes("Product"));
  const pageTitle = text(document.querySelector("#productTitle"), 800);
  const structured = structuredProducts.find(item =>
    asin(item.sku) === productId || clean(item.url).toUpperCase().includes("/DP/" + productId)) ||
    (pageTitle && structuredProducts.length === 1 ? structuredProducts[0] : undefined);
  const title = pageTitle || clean(structured?.name, 800);
  if (!title) return null;

  const attributes = Object.create(null);
  function addAttribute(label, value) {
    const key = unlabel(label);
    const fact = clean(value, 1200);
    if (key && fact && !Object.hasOwn(attributes, key)) attributes[key] = fact;
  }
  for (const row of list("#productFactsDesktopExpander .a-fixed-left-grid-inner")) {
    addAttribute(text(row.querySelector(".a-col-left")), text(row.querySelector(".a-col-right")));
  }
  for (const row of list("#prodDetails tr, #productOverview_feature_div tr, #productDetails_detailBullets_sections1 tr")) {
    const [label, value] = Array.from(row.cells);
    addAttribute(text(label), text(value));
  }
  for (const row of list("#detailBullets_feature_div li, #detailBulletsWrapper_feature_div #detailBullets li")) {
    const label = row.querySelector(".a-list-item > .a-text-bold");
    const value = label?.nextElementSibling;
    addAttribute(text(label), text(value));
  }
  function attribute(pattern) {
    return Object.entries(attributes).find(([key]) => pattern.test(key))?.[1];
  }

  const features = list("#productFactsDesktopExpander ul > li > .a-list-item, #feature-bullets ul > li > .a-list-item")
    .map(element => text(element, 2000)).filter(Boolean);
  const description = Array.from(new Set([
    text(document.querySelector("#productDescription"), 6000) || clean(structured?.description, 6000),
    ...features,
  ].filter(Boolean))).join("\n").slice(0, 12000);
  const byline = text(document.querySelector("#bylineInfo"));
  const brand = clean(structured?.brand?.name ?? structured?.brand, 120) ||
    attribute(/^(?:brand|ブランド|品牌)$/iu) ||
    byline.match(/^Visit the (.+) Store$/iu)?.[1] ||
    byline.match(/^访问\s*(.*?)\s*品牌旗舰店$/u)?.[1] ||
    byline.match(/^(?:Brand|品牌)\s*[:：]\s*(.+)$/iu)?.[1];
  const category = list("#wayfinding-breadcrumbs_feature_div a").map(link => text(link, 150))
    .filter(Boolean).join(" > ") || clean(structured?.category, 700);
  const origin = attribute(/^(?:origin|country of origin|country\/region of origin|原产地|原產地|产地)$/iu) ||
    clean(structured?.countryOfOrigin?.name ?? structured?.countryOfOrigin, 100);
  const countryOfOrigin = origin && !/^(?:imported|进口|進口|unknown|not specified|n\/a|[-—])$/iu.test(origin)
    ? origin : undefined;

  function imageUrl(raw) {
    if (!raw || typeof raw !== "string") return "";
    try {
      const url = new URL(raw, location.href);
      if (url.protocol !== "https:" || url.username || url.password ||
          !/(?:^|\.)(?:media-amazon|ssl-images-amazon|images-amazon)\.com$/i.test(url.hostname) ||
          /(?:grey-pixel|transparent\.|sprite|play-button-overlay)/i.test(url.pathname)) return "";
      return url.href;
    } catch { return ""; }
  }

  function imageOf(element) {
    return imageUrl(element?.getAttribute("data-old-hires")) ||
      imageUrl(element?.getAttribute("data-src")) ||
      imageUrl(Object.entries(records(parse(element?.getAttribute("data-a-dynamic-image"))))
        .sort(([, a], [, b]) => Number(b?.[0]) * Number(b?.[1]) - Number(a?.[0]) * Number(a?.[1]))[0]?.[0]) ||
      imageUrl(element?.currentSrc || element?.getAttribute("src"));
  }
  const galleryItem = item => imageUrl(item?.hiRes) || imageUrl(item?.large) || imageUrl(item?.thumb);

  function embeddedImageData(source) {
    // ImageBlockATF and ImageBlockBTF both pass a quoted JSON string to parseJSON.
    const literal = source.match(/parseJSON\('((?:\\[\s\S]|[^'\\])*)'\)/u)?.[1];
    if (!literal) return null;
    const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
    const decoded = literal.replace(/\\(?:u([0-9a-f]{4})|x([0-9a-f]{2})|([\s\S]))/gi,
      (_, unicode, hex, char) => unicode || hex ? String.fromCharCode(parseInt(unicode || hex, 16))
        : escapes[char] ?? char);
    return parse(decoded);
  }

  const galleries = new Map();
  let initialGallery = [];
  for (const source of dataScripts.filter(item => item.includes("colorImages"))) {
    const payload = embeddedImageData(source);
    if (Array.isArray(payload)) {
      if (source.includes("ImageBlockATF")) initialGallery = payload;
      continue;
    }
    const gallery = records(payload?.colorImages || jsonProperty(source, "colorImages"));
    for (const [color, items] of Object.entries(gallery)) {
      if (Array.isArray(items) && items.length) galleries.set(clean(color.replace(/\\\//gu, "/")), items);
    }
    if (!initialGallery.length) {
      initialGallery = galleries.get(clean(payload?.landingAsinColor).replace(/\\\//gu, "/")) ||
        galleries.get("initial") || [];
    }
  }

  function uniqueImages(urls, limit, key = value => value) {
    const seen = new Set();
    return urls.filter(value => {
      if (!value || seen.has(key(value))) return false;
      seen.add(key(value));
      return true;
    }).slice(0, limit);
  }
  const mainImage = imageOf(document.querySelector("#landingImage, #imgBlkFront"));
  const listedImages = [structured?.image].flat().map(item => imageUrl(item?.url || item));
  const imageKey = value => value.match(/\/images\/I\/([^/._]+)/i)?.[1] || value;
  const images = uniqueImages([mainImage, ...initialGallery.map(galleryItem), ...listedImages,
    ...(!initialGallery.length ? list("#altImages img").map(imageOf) : [])], 50, imageKey);
  const detailImages = uniqueImages(list("#productDescription img, #aplus img, #aplus_feature_div img")
    .filter(image => !image.closest('[id^="comparison-table-"], .apm-comparison-table, #apm-brand-story-carousel'))
    .map(imageOf), 60);

  const differentDimensions = new Map();
  for (const row of list('[id^="inline-twister-row-"], [id^="variation_"]')) {
    const key = row.id.replace(/^(?:inline-twister-row-|variation_)/u, "");
    const heading = row.querySelector(".dimension-heading .dimension-text .a-color-secondary, label.a-form-label, .a-form-label");
    const selected = row.querySelector(".inline-twister-dim-title-value, .selection");
    const name = unlabel(text(heading)) || key.replace(/_name$/u, "").replace(/_/gu, " ");
    const options = new Map();
    const swatches = new Map();
    for (const item of list("li[data-asin], li[data-defaultasin], option", row)) {
      const swatch = item.querySelector("img");
      const value = clean(swatch?.alt, 200) ||
        text(item.querySelector(".swatch-title-text-display"), 200) ||
        clean(item.getAttribute("data-variation-value"), 200) ||
        (item.matches("option") && item.value !== "-1" ? text(item, 200) : "");
      if (!value) continue;
      const image = galleryItem(galleries.get(value)?.[0]) || imageOf(swatch);
      options.set(value, { value, ...(image ? { image } : {}) });
      const id = asin(item.getAttribute("data-asin") || item.getAttribute("data-defaultasin"));
      if (id) swatches.set(id, value);
    }
    differentDimensions.set(key, { name, selected: text(selected, 200), options, swatches });
  }
  const keys = Array.isArray(dimensions) ? dimensions.filter(key => typeof key === "string") : [];
  const names = keys.map(key => differentDimensions.get(key)?.name || key.replace(/_name$/u, "").replace(/_/gu, " "));
  for (const [index, key] of keys.entries()) {
    if (!differentDimensions.has(key)) {
      differentDimensions.set(key, { name: names[index], selected: "", options: new Map(), swatches: new Map() });
    }
    const group = differentDimensions.get(key);
    const values = Array.isArray(variationValues[key]) ? variationValues[key] : [];
    for (const value of values.map(item => clean(item, 200)).filter(Boolean)) {
      if (!group.options.has(value)) group.options.set(value, { value });
    }
  }

  const offer = Array.isArray(structured?.offers) ? structured.offers[0] : structured?.offers;
  const displayPrice = list("#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen, #corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price) .a-offscreen, #priceblock_ourprice")
    .map(item => text(item, 80)).find(Boolean);
  const amount = displayPrice?.match(/\d[\d,]*(?:\.\d{1,3})?/u)?.[0]?.replace(/,/gu, "") ||
    (/^\d+(?:\.\d+)?$/u.test(offer?.price ?? "") ? String(offer.price) : "");
  const currency = displayPrice?.match(/\b[A-Z]{3}(?=\s*\d)/u)?.[0] ||
    (/^[A-Z]{3}$/u.test(offer?.priceCurrency ?? "") ? offer.priceCurrency : undefined);
  const price = amount ? { amount, ...(currency ? { currency } : {}), ...(displayPrice ? { display: displayPrice } : {}) } : undefined;

  const selectedId = asin(document.getElementById("ASIN")?.value) || productId;
  const selectedOptions = Object.fromEntries(Array.from(differentDimensions.values())
    .filter(group => group.selected).map(group => [group.name, group.selected]));
  const skuRows = new Map();
  const colorIndex = keys.findIndex(key => /colou?r/iu.test(key));
  for (const [id, displayed] of Object.entries(dimensionValues)) {
    if (!asin(id) || !keys.length || !Array.isArray(displayed) || displayed.length !== keys.length) continue;
    const values = displayed.map(value => clean(value, 200));
    if (values.some(value => !value)) continue;
    const options = Object.fromEntries(names.map((name, index) => [name, values[index]]));
    const image = differentDimensions.get(keys[colorIndex])?.options.get(values[colorIndex])?.image ||
      galleryItem(galleries.get(values[colorIndex])?.[0]);
    for (const [index, key] of keys.entries()) {
      const { options: choices } = differentDimensions.get(key);
      const value = values[index];
      if (!choices.has(value)) choices.set(value, { value, ...(index === colorIndex && image ? { image } : {}) });
    }
    skuRows.set(asin(id), { id: asin(id), options, ...(image ? { image } : {}) });
  }
  // A single swatch dimension also identifies complete variants without the embedded twister table.
  if (!skuRows.size && differentDimensions.size === 1) {
    const [group] = differentDimensions.values();
    for (const [id, value] of group.swatches) {
      const image = group.options.get(value)?.image;
      skuRows.set(id, { id, options: { [group.name]: value }, ...(image ? { image } : {}) });
    }
  }
  const selectedSku = skuRows.get(selectedId) || { id: selectedId, options: selectedOptions };
  skuRows.set(selectedId, { ...selectedSku, ...(mainImage ? { image: mainImage } : {}), ...(price ? { price } : {}) });
  const variantGroups = Array.from(differentDimensions.values()).filter(group => group.options.size)
    .map(group => ({ name: group.name, options: Array.from(group.options.values()).slice(0, 120) }));
  const skus = [skuRows.get(selectedId), ...Array.from(skuRows.values()).filter(row => row.id !== selectedId)].slice(0, 250);
  return { productId, title, description, brand, category, countryOfOrigin, attributes, images, detailImages,
    variantGroups, skus, price };
}

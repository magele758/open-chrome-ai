/**
 * Read the current Zhifulfill catalog detail. A browser-injected function
 * must keep its selectors and helpers inside the exported function.
 */
export function readZhFulfillProduct() {
  if (location.origin !== "https://erp.zhfulfill.com") return null;
  const route = new URL(location.hash.slice(1), location.origin);
  const productId = route.searchParams.get("id");
  if (!/^\/catalog\/detail\/?$/u.test(route.pathname) || !/^\d+$/u.test(productId || "")) return null;
  const page = document.querySelector(".detailPage");
  if (!page || page.closest("[hidden]")) return null;

  const list = (value) => Array.isArray(value) ? value : [];
  const text = (value) => typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  const identifier = (value) => typeof value === "string" ? value.trim() : Number.isSafeInteger(value) ? String(value) : "";
  const number = (value) => value != null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : undefined;
  const unique = (values) => [...new Set(values.filter(Boolean))];
  const imageUrl = (source, prefix) => {
    const value = text(typeof source === "string" ? source : source?.uri || source?.originFileUrl);
    if (!value) return undefined;
    try {
      const url = new URL(value, prefix || location.origin);
      return /^https?:$/u.test(url.protocol) && !url.username && !url.password ? url.href : undefined;
    } catch {
      return undefined;
    }
  };
  const domImages = (parent, selector) => [...(parent?.querySelectorAll(selector) || [])]
    .map((image) => imageUrl(image.getAttribute("data-src") || image.currentSrc || image.getAttribute("src")));
  const structuredText = (node) => {
    if (!node) return "";
    const copy = node.cloneNode(true);
    copy.querySelectorAll("script, style, noscript").forEach((child) => child.remove());
    copy.querySelectorAll("br, p, li, blockquote, div, h1, h2, h3, h4, tr")
      .forEach((child) => child.after(document.createTextNode("\n")));
    return copy.textContent.split("\n").map(text).filter(Boolean).join("\n");
  };

  let component;
  for (let node = page; node && node !== document.body && !component; node = node.parentElement) {
    for (let vue = node.__vue__, depth = 0; vue && depth < 12; vue = vue.$parent, depth += 1) {
      if (vue.$options?.name === "CatalogDetail") {
        component = vue;
        break;
      }
    }
  }
  if (component?.loading || (component && identifier(component.$route?.query?.id) !== productId)) return null;
  const detail = component?.detail;
  const loadedId = identifier(detail?.id);
  if (loadedId && loadedId !== productId) return null;
  const heading = page.querySelector(".detailTitle")?.cloneNode(true);
  heading?.querySelectorAll(".el-tag").forEach((badge) => badge.remove());
  const title = text(component?.title) || text(heading?.textContent);
  if (!title) return null;

  // The site uses its image prefix for relative URIs. The main gallery already
  // exposes the full URLs in the same component that renders the current item.
  const prefix = component?.aliImgPrefix || "https://zh-img-com.oss-accelerate.aliyuncs.com/";
  const gallery = list(detail?.images).map((image) => imageUrl(image, prefix)).filter(Boolean);
  const images = unique(gallery.length ? gallery : domImages(page, ".leftWrap img"));
  const descriptionNode = page.querySelector(".productDetail .description");
  const detailImages = unique(domImages(descriptionNode, "img"));
  const sizeChartImage = imageUrl(detail?.sizeChart, prefix) ||
    domImages(page, ".productDetail #pane-third img")[0];

  const attributePairs = detail?.customAttributes
    ? list(detail.customAttributes).map((entry) => [text(entry?.attributeName), text(entry?.attributeValue)])
    : [...page.querySelectorAll(".productDetail .desc-label, .productDetail .el-descriptions-item__label")].map((label) => {
      const value = label.closest("th")?.nextElementSibling ||
        label.parentElement?.querySelector(".el-descriptions-item__content") || label.nextElementSibling;
      return [text(label.textContent), text(value?.textContent)];
    });
  const attributes = Object.fromEntries(attributePairs.filter(([name, value]) => name && value));
  const brand = Object.entries(attributes).find(([name]) => /^(品牌|品牌名|brand)$/iu.test(name))?.[1];
  const countryOfOrigin = Object.entries(attributes).find(([name]) => /^(原产地|原产国|产地|製造國|country of origin|made in)$/iu.test(name))?.[1];
  const category = Object.entries(attributes).find(([name]) => /^(商品分类|分类|类目|category)$/iu.test(name))?.[1];

  const groups = list(detail?.variants).map((group) => ({
    name: text(group?.name),
    options: list(group?.values).map((value) => ({
      id: identifier(value?.id),
      value: text(value?.name),
      image: imageUrl(value?.image, prefix),
    })).filter((option) => option.value),
  }));
  const variantGroups = groups.length
    ? groups.filter((group) => group.name && group.options.length).map(({ name, options }) => ({
      name, options: options.map(({ value, image }) => ({ value, ...(image ? { image } : {}) })),
    }))
    : [...page.querySelectorAll(".detailSku .skuItem")].flatMap((group) => {
      const name = text(group.querySelector(".text")?.textContent);
      if (!name || /发货|发貨|deliver|ship/iu.test(name)) return [];
      const options = unique([...group.querySelectorAll(".listSku .sku")].map((item) => text(item.textContent)));
      return options.length ? [{ name, options: options.map((value) => ({ value })) }] : [];
    });

  const deliveries = new Map(list(detail?.delivers).map((entry) => [
    identifier(entry?.code), text(entry?.chineseName) || text(entry?.englishName),
  ]));
  const skus = new Map();
  for (const item of list(detail?.inventories)) {
    const inventoryId = identifier(item?.id);
    const id = identifier(item?.variantSku) || inventoryId;
    if (!id) continue;
    let pairs = [];
    if (groups.length) {
      const selection = identifier(item.spec).split(",");
      pairs = groups.map((group, index) => [group.name, group.options.find((option) => option.id && option.id === text(selection[index]))?.value]);
      if (selection.length !== groups.length || pairs.some(([name, value]) => !name || !value)) continue;
    }
    const options = Object.fromEntries(pairs);
    const key = JSON.stringify([id, options]);
    const image = imageUrl(item.image, prefix);
    const sku = skus.get(key) || { id, options, inventory: [] };
    if (image && !sku.image) sku.image = image;
    const countryCode = identifier(item.contactsCountry);
    const shipFrom = deliveries.get(countryCode) || countryCode;
    const shareQuantity = number(item.shareQuantity);
    const freezeQuantity = number(item.shareFreezeQuantity);
    const quantity = shareQuantity != null && freezeQuantity != null ? shareQuantity - freezeQuantity : undefined;
    if (shipFrom || inventoryId || quantity != null) {
      sku.inventory.push({
        ...(shipFrom ? { shipFrom } : {}),
        ...(inventoryId ? { inventoryId } : {}),
        ...(quantity == null ? {} : { quantity }),
      });
    }
    skus.set(key, sku);
  }
  const domPrice = [...page.querySelectorAll(".rightWrap .detailData")].find((row) =>
    /^(价格|價格|price)[:：]?$/iu.test(text(row.querySelector(".label")?.textContent)));
  const priceText = text(domPrice?.querySelector(".price")?.textContent);
  const displayed = priceText.match(/^(\$|USD)\s*([\d,.]+)$/u);
  const amount = number(displayed?.[2].replaceAll(",", ""));
  return {
    productId, title, description: structuredText(descriptionNode), attributes,
    images, detailImages, variantGroups, skus: [...skus.values()],
    ...(brand ? { brand } : {}), ...(category ? { category } : {}),
    ...(countryOfOrigin ? { countryOfOrigin } : {}),
    ...(sizeChartImage ? { sizeChartImage } : {}),
    ...(amount == null ? {} : { price: displayed[2].replaceAll(",", ""), priceText }),
    ...(displayed?.[1] === "USD" ? { currency: "USD" } : {}),
  };
}

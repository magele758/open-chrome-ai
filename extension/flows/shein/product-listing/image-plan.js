const maxGalleryImages = 5;
const array = value => Array.isArray(value) ? value : [];
const nameKey = name => String(name ?? "").normalize("NFKC").trim().replace(/\s+/gu, "").toLowerCase();
const optionKey = options => JSON.stringify(array(options).map(nameKey));
const validOptions = (options, allowDefault) => Array.isArray(options) && (options.length > 0 || allowDefault) &&
  options.every(option => typeof option === "string" && nameKey(option));
const pathValue = path => typeof path === "string" && path.length > 0 && !/[\0\\:]/u.test(path) &&
  path.split("/").every(segment => segment && segment !== "." && segment !== "..") ? path : "";
const paths = values => [...new Set(array(values).map(pathValue).filter(Boolean))];
const one = values => values.length === 1 ? values[0] : undefined;

/** Bind product assets to the committed SHEIN media and SKU table rows. */
export function buildSheinImagePlan({ product = {}, variant = {}, rows = [], images = [], tables = {}, defaultSku = "" } = {}) {
  const tasks = [];
  const issues = [];
  const available = array(images).filter(image => pathValue(image?.path));

  const isDefault = Boolean(defaultSku && tables.defaultSku === defaultSku);
  const media = array(tables.media).filter(options => validOptions(options, isDefault));
  const supply = array(tables.supply).filter(options => validOptions(options, isDefault));
  const swatchRequired = tables.swatchRequired !== false;
  const swatches = array(tables.swatches).filter(options => validOptions(options, isDefault));
  const primary = variant.groups?.[0];
  const sourceOptions = array(product.variantGroups?.[0]?.options);
  const imagePaths = roles => paths(available.filter(image => roles.includes(image.role)).map(image => image.path));
  const hasSwatch = options => swatches.filter(row => optionKey(row) === optionKey(options)).length === 1;
  const add = (role, options, image, deriveSwatch = false) =>
    tasks.push({ role, options, image, ...(deriveSwatch && { deriveSwatch }) });
  const report = (label, code, message) => issues.push({ label, code, message });
  if (defaultSku && (!isDefault || sourceOptions.length > 1 || rows.length > 1)) {
    report("默认 SKU", "MEDIA_DEFAULT_SKU_UNVERIFIED", "SHEIN 仅支持默认 SKU，图片资料须明确对应同一个商品规格。");
    return { tasks, issues };
  }

  function lookup(path, roles, label) {
    for (const role of roles) {
      const matches = available.filter(image => image.path === path && image.role === role);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        report(label, "MEDIA_ASSET_AMBIGUOUS", `目录有多条相同用途的图片记录，请核对 ${path}。`);
        return;
      }
    }
    report(label, "MEDIA_ASSET_MISSING", `未读取到登记的图片 ${path}。`);
  }

  const mappedOptions = sourceOptions.map(option => {
    const mapped = array(primary?.matches).filter(match => nameKey(match.requested) === nameKey(option.value));
    const committed = array(primary?.values);
    const name = mapped.length ? one(mapped)?.value : option.value;
    return { option, name: one(committed.filter(value => nameKey(value) && nameKey(value) === nameKey(name))) };
  });
  const single = isDefault || media.length === 1 && sourceOptions.length <= 1 && array(primary?.values).length === 1;
  const galleryRows = isDefault ? [{ option: sourceOptions[0] || {}, name: "" }] : mappedOptions.length ? mappedOptions
    : array(primary?.values).map(name => ({ option: {}, name }));
  const plans = [];

  for (const { option, name } of galleryRows) {
    const label = isDefault ? "默认 SKU" : cleanLabel(option.source || option.value || name);
    if (!isDefault && (!name || galleryRows.filter(row => nameKey(row.name) === nameKey(name)).length !== 1)) {
      report(label, "MEDIA_COLOR_UNVERIFIED", "主规格未唯一匹配到 SHEIN 已选值，图片尚未关联。");
      continue;
    }
    const options = one(media.filter(row => isDefault ? row.length === 0 : nameKey(row[0]) === nameKey(name)));
    if (!options) {
      report(label, "MEDIA_COLOR_ROW_AMBIGUOUS", "未读取到主规格对应的唯一图片行。");
      continue;
    }
    const skuImages = paths(array(rows).filter(row => isDefault ? row.options?.length === 0 :
      nameKey(row.options?.[0]) === nameKey(name)).map(row => row.imagePath));
    const defaults = paths(product.mainImages ?? product.shein?.mainImages);
    const main = pathValue(product.imagePath ?? product.shein?.imagePath) || defaults[0] || one(imagePaths(["main"]));
    const heroPath = pathValue(option.imagePath) || one(skuImages) || (single ? main : "");
    plans.push({ option, options, label, heroPath });
  }

  const galleryRoles = ["shared-gallery", "detail"];
  const sharedPaths = paths([
    ...array(product.sharedGalleryImages ?? product.shein?.sharedGalleryImages),
    ...array(product.detailImages ?? product.shein?.detailImages),
    ...imagePaths(galleryRoles),
  ]).filter(path => !plans.some(plan => plan.heroPath === path));
  const shared = plans.some(plan => plan.heroPath)
    ? sharedPaths.map(path => lookup(path, galleryRoles, "公共详情图")).filter(Boolean) : [];
  if (plans.length && !shared.length) {
    report("公共详情图", "MEDIA_SHARED_MISSING", "本次未读取到可复用的详情图，请在卖家页核对各主规格的详情图。");
  } else if (shared.length >= maxGalleryImages) {
    report("公共详情图", "MEDIA_GALLERY_LIMIT", `本次试填为每个主规格安排 ${maxGalleryImages} 张细节图，其中第一张是首图。`);
  }

  for (const { option, options, label, heroPath } of plans) {
    let hero;
    if (!heroPath || plans.filter(plan => plan.heroPath === heroPath).length !== 1) {
      report(label + " 详情图首图", "MEDIA_HERO_UNVERIFIED", "请为每个主规格登记唯一的首图，公共详情图不会补入首图位置。");
    } else {
      hero = lookup(heroPath, single ? ["variant", "main"] : ["variant"], label + " 详情图首图");
      if (hero) for (const image of [hero, ...shared.slice(0, maxGalleryImages - 1)]) add("detail", options, image);
    }

    for (const [role, field, title] of [["square", "squareImagePath", "方形图"], ["swatch", "swatchImagePath", "色块图"]]) {
      if (role === "swatch" && !swatchRequired && !tables.swatchAvailable) continue;
      const topLevel = single ? product[field] ?? product.shein?.[field] : "";
      const declared = option[field] || topLevel;
      const imageLabel = label + " " + title;
      if (role === "swatch" && declared && !pathValue(declared)) {
        report(imageLabel, "MEDIA_SWATCH_PATH_INVALID", "色块图须使用商品目录内的相对路径。");
        continue;
      }
      const fallback = single ? pathValue(topLevel) || one(imagePaths([role])) : "";
      const imagePath = pathValue(option[field]) || fallback;
      if (!imagePath) {
        if (role === "square") report(imageLabel, "MEDIA_SQUARE_MISSING", "请为该主规格单独登记方形图。");
        else if (!hasSwatch(options)) {
          if (hero) add("swatch", options, hero, true);
          else if (swatchRequired) report(imageLabel, "MEDIA_SWATCH_MISSING", "色块图为必填项，请提供该主规格的色块图或主图。");
        }
        continue;
      }
      const image = lookup(imagePath, single ? [`variant-${role}`, role] : [`variant-${role}`], imageLabel);
      if (image) add(role, options, image);
    }
  }

  for (const options of swatchRequired ? media : []) {
    const key = optionKey(options);
    if (plans.some(plan => optionKey(plan.options) === key) || media.filter(row => optionKey(row) === key).length !== 1 ||
        hasSwatch(options)) continue;
    report(options.join(" / ") + " 色块图", "MEDIA_SWATCH_MISSING", "SHEIN 页面已有该主规格，请提供对应色块图。");
  }

  const skuRows = array(rows).filter(row => validOptions(row.options, isDefault));
  const skuByPage = new Set(skuRows.map(row => optionKey(row.options)));
  for (const row of skuRows) {
    const key = optionKey(row.options);
    const label = (row.options.join(" / ") || "默认 SKU") + " SKU 图";
    if (!pathValue(row.imagePath)) {
      report(label, "MEDIA_SKU_IMAGE_MISSING", "本次未登记该 SKU 的图片，请在卖家页核对。");
      continue;
    }
    const options = one(supply.filter(options => optionKey(options) === key));
    if (!options || skuRows.filter(row => optionKey(row.options) === key).length !== 1) {
      report(label, "MEDIA_SKU_ROW_AMBIGUOUS", "未读取到 SKU 对应的唯一供货行。");
      continue;
    }
    const image = lookup(row.imagePath, ["variant"], label);
    if (image) add("variant", options, image);
  }
  for (const options of supply) {
    const key = optionKey(options);
    if (skuByPage.has(key)) continue;
    report((options.join(" / ") || "默认 SKU") + " SKU 图", "MEDIA_SKU_IMAGE_MISSING", "本次未登记该 SKU 的图片，请在卖家页核对。");
    skuByPage.add(key);
  }

  if (!plans.length && !available.length) {
    const requiredImages = swatchRequired ? "详情图、方形图、色块图和 SKU 图" : "详情图、方形图和 SKU 图";
    report("商品图片", "MEDIA_ASSET_MISSING", `本次未读取到图片，请在卖家页核对必填的${requiredImages}。`);
  } else if (!tasks.length && !issues.length) {
    report("商品图片", "MEDIA_MAPPING_REQUIRED", "未找到图片与已确认规格的唯一对应关系。");
  }
  return { tasks, issues };
}

function cleanLabel(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "主规格";
}

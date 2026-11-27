const normalize = value => String(value ?? "").normalize("NFKC").trim();
const keyOf = value => normalize(value).replace(/[\s()_-]+/gu, "").toLowerCase();
const sizeNameKey = value => normalize(value).replace(/\s+/gu, "").toLowerCase();
const sizeAliases = new Map([
  ["extra small", "XS"], ["x-small", "XS"], ["small", "S"], ["medium", "M"], ["large", "L"],
  ["extra large", "XL"], ["x-large", "XL"], ["xx-large", "XXL"], ["2XL", "XXL"], ["2X", "XXL"],
  ["xxx-large", "XXXL"], ["3XL", "XXXL"], ["3X", "XXXL"],
].map(([alias, size]) => [sizeNameKey(alias), sizeNameKey(size)]));
export const temuSizeKey = value => sizeAliases.get(sizeNameKey(value)) || sizeNameKey(value);

const internationalHeadings = new Set([
  "尺寸（国际）", "尺寸", "国际尺码", "尺码", "size", "international size", "intl size", "alpha size",
].map(keyOf));
const sizeHeadings = new Set([...internationalHeadings, ...[
  "尺寸（美国）", "美国尺码", "us size", "size us", "us",
  "尺寸（英国）", "英国尺码", "uk size", "size uk", "uk",
  "尺寸（欧盟）", "欧盟尺码", "欧洲尺码", "eu size", "size eu", "eu",
].map(keyOf)]);

const garmentLabels = {
  chest: ["胸围全围", "胸围", "bust", "bust circumference", "chest", "chest circumference"],
  length: ["衣长", "长度", "上衣长度", "上衣长", "length", "garment length", "top length", "shirt length", "t-shirt length"],
  hem: ["下摆围", "下摆全围", "hem", "hem circumference"],
  shoulder: ["肩宽", "shoulder", "shoulder width"],
  sleeve: ["袖长", "sleeve", "sleeve length"],
  waist: ["腰围", "腰围全围", "waist", "waist circumference"],
  neck: ["领围", "颈围", "neck circumference", "collar circumference"],
  underbust: ["下胸围", "underbust", "under bust circumference"],
  cuff: ["袖口围", "cuff circumference", "sleeve opening circumference"],
};

const bodyLabels = {
  waist: garmentLabels.waist,
  hip: ["臀围", "hip", "hips", "hip circumference"],
  chest: garmentLabels.chest,
  height: ["身高", "高度", "height", "body height"],
  underbust: garmentLabels.underbust,
  cup: ["罩杯", "cup"],
};

const failure = (code, message) => ({ ok: false, code, message });
const sizeLabel = /^[\p{L}\p{N}][\p{L}\p{N} .+/−–-]{0,30}$/u;
const unitSuffix = /\s*\((cm|inch|inches|in|厘米|英寸)\)$/iu;
const measurementKey = value => keyOf(normalize(value).replace(unitSuffix, ""));

function unitFactor(unit) {
  const label = normalize(unit).toLowerCase();
  if (["cm", "厘米", "centimeter", "centimeters"].includes(label)) return 1;
  if (["inch", "inches", "in", '"', "英寸"].includes(label)) return 2.54;
  throw new TypeError("尺码表须明确使用厘米或英寸。");
}

function cmValue(value, factor) {
  const text = typeof value === "number" || typeof value === "string" ? normalize(value) : "";
  const number = Number(text) * factor;
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(text) || !Number.isFinite(number) || number <= 0) {
    throw new TypeError("对应尺码的测量值必须是大于零的数字。");
  }
  const cm = factor === 1 ? text : number.toFixed(2);
  if (!(Number(cm) > 0)) throw new TypeError("换算后的测量值必须大于零。");
  return cm;
}

function chartRows(chart, requestedSizes, labels, inheritedUnit, allowPartial) {
  if (!chart || !Array.isArray(chart.columns) || chart.columns.some(label => typeof label !== "string") ||
      !Array.isArray(chart.rows) || !chart.rows.length ||
      chart.rows.some(row => !row || typeof row !== "object" || (Array.isArray(row) && row.length !== chart.columns.length))) {
    throw new TypeError("尺码表须包含有效的表头和数据行。");
  }
  const factor = unitFactor(chart.unit ?? inheritedUnit);
  const estimated = new Set((Array.isArray(chart.estimatedColumns) ? chart.estimatedColumns : []).map(keyOf));
  const headings = chart.columns.map((label, index) => ({ index, label, key: keyOf(label) })).filter(heading => !estimated.has(heading.key));
  const read = (row, heading) => Array.isArray(row) ? row[heading.index] : Object.hasOwn(row, heading.label) ? row[heading.label] : undefined;
  let axes = headings.filter(heading => sizeHeadings.has(heading.key));
  if (!requestedSizes.length && axes.some(heading => internationalHeadings.has(heading.key))) {
    axes = axes.filter(heading => internationalHeadings.has(heading.key));
  }
  const found = axes.map(heading => {
    const entries = chart.rows.map(row => {
      const value = read(row, heading);
      return { row, size: typeof value === "string" || typeof value === "number" ? normalize(value) : "" };
    });
    if (entries.some(entry => !sizeLabel.test(entry.size))) return null;
    const bySize = new Map(entries.map(entry => [temuSizeKey(entry.size), entry]));
    const matches = requestedSizes.filter(size => bySize.has(temuSizeKey(size))).length;
    return bySize.size === entries.length && (matches === requestedSizes.length || allowPartial && matches > 0) ? { bySize, matches } : null;
  }).filter(Boolean);
  const best = Math.max(...found.map(axis => axis.matches));
  const comparableAxes = found.filter(axis => axis.matches === best).map(axis => axis.bySize);
  const [bySize] = comparableAxes;
  if (!bySize) throw new TypeError("尺码表中找不到与商品规格唯一对应的尺码。");
  const sizes = requestedSizes.length ? requestedSizes : [...bySize.values()].map(entry => entry.size);
  if (comparableAxes.some(axis =>
    sizes.some(size => axis.get(temuSizeKey(size))?.row !== bySize.get(temuSizeKey(size))?.row))) {
    throw new TypeError("不同尺码列与商品规格的对应关系冲突。");
  }
  const measurementHeadings = Object.entries(labels).flatMap(([field, aliases]) => {
    const names = new Set(aliases.map(keyOf));
    const matching = headings.filter(heading => names.has(measurementKey(heading.label)));
    if ([...estimated].some(label => names.has(label))) return [];
    if (matching.length > 1) throw new TypeError(`测量列「${matching[0].label}」重复。`);
    const declaredUnit = matching[0] && normalize(matching[0].label).match(unitSuffix)?.[1];
    if (declaredUnit && unitFactor(declaredUnit) !== factor) {
      throw new TypeError(`测量列「${matching[0].label}」的单位与尺码表不一致。`);
    }
    return matching.length ? [[field, matching[0]]] : [];
  });
  if (!measurementHeadings.length) throw new TypeError("尺码表缺少可用于 Temu 的实测尺寸列。");
  return sizes.map(size => {
    const row = bySize.get(temuSizeKey(size))?.row;
    const measurements = Object.fromEntries(measurementHeadings.flatMap(([field, heading]) => {
      if (!row) return [];
      const value = read(row, heading);
      if (allowPartial && (value == null || typeof value === "string" && !value.trim())) return [];
      const range = labels === bodyLabels && (Array.isArray(value) ? value : typeof value === "string" &&
        value.match(/^\s*(\d+(?:\.\d+)?)\s*[-–—~～]\s*(\d+(?:\.\d+)?)\s*$/u)?.slice(1));
      if (!range) return [[field, cmValue(value, factor)]];
      if (range.length !== 2) throw new TypeError("人体尺寸区间须包含最小值和最大值。");
      const [min, max] = range.map(bound => cmValue(bound, factor));
      if (Number(min) >= Number(max)) throw new TypeError("人体尺寸区间的最小值须小于最大值。");
      return [[field, [min, max]]];
    }));
    return { size, measurements };
  });
}

function templateName(input, rows) {
  const prefix = normalize(input.sizeChart.name ?? input.title) || "商品尺码表";
  const source = JSON.stringify([input.categoryId || input.categoryPath || "", input.sizeSystem || "", rows]);
  let hash = 2166136261;
  for (const char of source) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
  const suffix = `-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  return prefix.slice(0, 20 - suffix.length).replace(/[\uD800-\uDBFF]$/u, "").trimEnd() + suffix;
}

/** Project sourced garment and optional separate body measurements onto confirmed Temu sizes. */
export function prepareTemuSizeChart(input, { allowPartial = false } = {}) {
  if (!input?.sizeChart) return failure("SIZE_CHART_INPUT_MISSING", "没有提取到结构化尺码数据。");
  const sizes = Array.isArray(input.sizes) ? input.sizes.map(normalize) : [];
  if (sizes.some(size => !sizeLabel.test(size)) || new Set(sizes.map(temuSizeKey)).size !== sizes.length) {
    return failure("SIZE_CHART_INPUT_INVALID", "商品规格尺码无效或重复。");
  }
  try {
    const garment = chartRows(input.sizeChart, sizes, garmentLabels, undefined, allowPartial);
    const body = input.sizeChart.body == null ? [] :
      chartRows(input.sizeChart.body, garment.map(row => row.size), bodyLabels, input.sizeChart.unit, allowPartial);
    const rows = garment.map(({ size, measurements }, index) => ({
      size, garment: measurements, body: body[index]?.measurements ?? {},
    }));
    return { ok: true, chart: { name: templateName(input, rows), unit: "cm", rows } };
  } catch (error) {
    return failure("SIZE_CHART_INPUT_INVALID", error.message);
  }
}

import { createTemuSuggestionFilter, readTemuAttributeValue } from "./input.js";
import { isTemuServiceField, planTemuServiceField } from "./service.js";
import { prepareTemuSizeChart, temuSizeKey as sizeKey } from "./size-chart-input.js";

export const id = "temu-listing";
export const version = 1;

const keyOf = value => String(value ?? "").trim().normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
const hasValue = value => Array.isArray(value) ? value.length > 0 : value != null && (typeof value !== "string" || value.trim() !== "");
const fatal = new Set(["PAGE_CHANGED", "MODAL_BLOCKED", "EDITOR_LOADING", "FLOW_BUSY", "MENU_STILL_OPEN"]);
const standardColors = new Map([
  ["black", "黑色"], ["white", "白色"], ["red", "红色"], ["blue", "蓝色"], ["green", "绿色"],
  ["pink", "粉色"], ["yellow", "黄色"], ["orange", "橙色"], ["purple", "紫色"], ["gray", "灰色"], ["grey", "灰色"],
]);
const standardColor = label => standardColors.get(keyOf(label.replace(/^[a-z]\s+-\s+/iu, "")));
const stockMembers = new Set(["stock", "quantity"]);
const categoryAttribute = /^productProperties\[\d+\]$/u;
const validationOf = state => Array.isArray(state.validation) ? state.validation :
  (state.issues || []).map(message => ({ message }));

function recoveryValue(field, raw) {
  if (!hasValue(raw)) return undefined;
  if (field.kind === "text") return typeof raw === "string" || Number.isFinite(raw) ? raw : undefined;
  if (field.kind !== "select") return typeof raw === "boolean" ? raw : undefined;
  const requested = Array.isArray(raw) ? raw : [raw];
  if (!field.multiple && requested.length !== 1) return undefined;
  const selected = requested.map(value => {
    const matches = field.options.filter(option => !option.disabled &&
      [option.value, option.label, ...(option.aliases || [])].some(name => keyOf(name) === keyOf(value)));
    return matches.length === 1 ? matches[0].value : undefined;
  });
  return selected.every(Boolean) && new Set(selected).size === selected.length
    ? field.multiple ? selected : selected[0] : undefined;
}

function verifiesRecovery(field, wanted, actual) {
  if (!hasValue(actual)) return false;
  const observed = (Array.isArray(actual) ? actual : [actual]).map(keyOf);
  const expected = Array.isArray(wanted) ? wanted : [wanted];
  const unmatched = new Set(observed);
  return observed.length === expected.length && unmatched.size === observed.length && expected.every(value => {
    const option = field.options?.find(option => option.value === value);
    const accepted = [...new Set([value, option?.label, ...(option?.aliases || [])].map(keyOf))]
      .filter(name => name && unmatched.has(name));
    return accepted.length === 1 && unmatched.delete(accepted[0]);
  });
}

function optionAliases(value) {
  const alias = keyOf(value);
  for (const group of [["颜色", "color", "colour"], ["尺码", "尺寸", "size"], ["款式", "style"], ["材质", "material"]]) {
    if (group.includes(alias)) return group;
  }
  return [alias];
}

function skuValue(field, row, input) {
  const dims = [row.lengthCm ?? input.lengthCm, row.widthCm ?? input.widthCm, row.heightCm ?? input.heightCm]
    .map(Number).sort((a, b) => b - a);
  const validDimensions = dims.every(value => Number.isFinite(value) && value > 0);
  const values = {
    skuCode: row.sellerSku, inputLen: validDimensions ? dims[0] : undefined,
    inputWidth: validDimensions ? dims[1] : undefined, inputHeight: validDimensions ? dims[2] : undefined,
    inputWeight: row.weightG ?? input.weightG, quantity: row.quantity ?? input.quantity, stock: row.quantity ?? input.quantity,
    usSuggestSalesPrice: row.retailPrice ?? input.retailPrice,
    "productSkuSameReferPrice.url": input.referenceUrl,
    sensitiveAttr: row.sensitiveAttribute ?? input.sensitiveAttribute,
    "productSkuMultiPack.skuClassification": row.skuClassification ?? input.skuClassification,
    "productSkuMultiPack.packIncludeInfo": row.packageContents ?? input.packageContents,
  };
  const result = field.skuMember.startsWith("siteSupplierPriceMap.") ? row.price ?? input.price : values[field.skuMember];
  return field.multiple && hasValue(result) && !Array.isArray(result) ? [result] : result;
}

function matchingSku(field, rows, rowCount, colors) {
  const labels = new Set((field.rowLabels || []).map(keyOf));
  if (rows.length === 1 && rowCount === 1 && (!Object.keys(rows[0].options || {}).length || !labels.size)) return rows[0];
  const matches = rows.filter(row => {
    const values = Object.entries(row.options || {});
    return values.length > 0 && values.every(([kind, value]) => {
      const aliases = optionAliases(kind);
      if (aliases.includes("颜色") && colors.has(keyOf(value))) return labels.has(keyOf(colors.get(keyOf(value))));
      return labels.has(keyOf(value)) || aliases.includes("尺码") && [...labels].some(label => sizeKey(label) === sizeKey(value));
    });
  });
  if (matches.length === 1) return matches[0];
  return null;
}

function matchedSkuGroups(state, sources, colors) {
  const rows = state.skuRows || [...new Map(state.fields.filter(field => field.skuMember && field.skuGroup).map(field =>
    [field.skuGroup, { id: field.skuGroup, labels: field.rowLabels }])).values()];
  const matched = new Map();
  for (const row of rows) {
    const source = matchingSku({ rowLabels: row.labels }, sources, rows.length, colors);
    if (source) matched.set(source, matched.has(source) ? null : row.id);
  }
  return matched;
}

export async function replayTemuListing({ tabId, input, call, onStep, signal, suggestFields, shouldSuggestField,
  readSizeChart, suggestSizeChart } = {}) {
  const start = Date.now();
  const items = [];
  const issues = [];
  const attempted = new Set();
  const colorLabels = new Map();
  const popupStock = new Set();
  let step = "validate";
  let draftUrl;
  let missing = [];
  let verificationComplete = false;
  let verifiedSkuCount;
  let lastState;
  let apparelHandledSizeChart = false;
  const run = (tool, args) => {
    signal?.throwIfAborted();
    return call(tool, { tabId, ...args });
  };
  const report = (next, label) => {
    step = next;
    onStep?.({ step, label, completed: items.filter(item => ["filled", "verified", "unchanged"].includes(item.status)),
      issues: [...issues] });
  };
  const asIssue = (label, result, key) => ({
    ...(key && { key }), label, code: result?.code || "UNVERIFIED", message: result?.message || "没有收到可核对的结果。",
  });
  const result = (status, code) => ({
    status, step, ...(code && { code }), ...(draftUrl && { draftUrl }), items, issues, missing, verificationComplete, verifiedSkuCount,
    elapsedMs: Date.now() - start, fieldCount: lastState?.fields.length || 0,
  });
  const stop = (label, failure) => {
    const problem = asIssue(label, failure);
    issues.push(problem);
    return result("needs-review", problem.code);
  };
  const listMissing = () => (lastState?.fields || []).filter(field => field.required && !hasValue(field.value))
    .map(({ key, label }) => ({ key, label }));
  const record = (label, outcome, key) => {
    const status = outcome?.ok ? outcome.status || "verified" : "needs-review";
    items.push({ ...(key && { key }), label, status });
    if (!outcome?.ok) {
      const problem = asIssue(label, outcome, key);
      issues.push(problem);
      if (fatal.has(problem.code)) throw Object.assign(new Error(problem.message), { workflowCode: problem.code });
    }
  };
  async function readEditor({ wait = false } = {}) {
    const deadline = Date.now() + (wait ? 12000 : 0);
    do {
      const state = await run("temu_editor_state");
      if (state?.ok) {
        lastState = state;
        return state;
      }
      if (state?.code !== "EDITOR_LOADING" || Date.now() + 250 >= deadline) return state;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (true);
  }
  async function applyField(field, value, { recovery = false } = {}) {
    if (!hasValue(value) || !recovery && attempted.has(field.key)) return;
    attempted.add(field.key);
    const select = options => run("temu_select", { key: field.key, ...options });
    const requested = Array.isArray(value) ? value : [value];
    const hints = requested.map(item => (field.options || []).find(option => keyOf(option.value) === keyOf(item)));
    const args = { value, ...(hints.length === 1 && hints[0]?.label && { query: hints[0].label }) };
    let outcome = field.locator ? await select(args) : await run("temu_write", { key: field.key, value });
    if (!recovery && field.locator && outcome?.code === "OPTION_MISSING" && !outcome.changed) {
      const current = await run("temu_field_options", { key: field.key, forceLive: true });
      if (!current?.ok && fatal.has(current?.code)) outcome = current;
      if (current?.ok) {
        const choices = requested.map((item, index) => {
          const hint = hints[index];
          const options = (current.options || []).filter(option => !option.disabled &&
            [option.label, ...(option.aliases || []), ...(!hint ? [option.value] : [])]
              .some(name => keyOf(name) === keyOf(hint?.label ?? item)));
          return options.length === 1 ? options[0] : null;
        });
        if (choices.every(Boolean) && new Set(choices.map(option => option.value)).size === choices.length) {
          outcome = await select({ value: Array.isArray(value) ? choices.map(option => option.value) : choices[0].value,
            ...(choices.length === 1 && { query: choices[0].label }) });
        }
      }
    }
    record(field.label, outcome, field.key);
    return outcome;
  }
  async function chooseCurrentOption(field, wanted) {
    if (!field.locator || !wanted) return wanted;
    const result = await run("temu_field_options", { key: field.key });
    if (!result?.ok) { record(field.label, result, field.key); return undefined; }
    const aliases = optionAliases(wanted);
    const matches = (result.options || []).filter(option => !option.disabled && [option.value, option.label, ...(option.aliases || [])]
      .some(value => aliases.includes(keyOf(value))));
    return matches.length === 1 ? matches[0].value : undefined;
  }
  async function applyApparel(apparel, groups) {
    const color = groups.find(group => optionAliases(group.name).includes("颜色"));
    let rows = apparel.rows;
    const colors = color?.options || [];
    if (colors.length > 20) {
      record("服装颜色", { code: "COLOR_LIMIT", message: `商品资料有 ${colors.length} 个颜色，超过当前试填的 20 色上限。已保留原始规格，请精简该商品的颜色后再试填规格。` });
    }
    const targets = colors.map(option => keyOf(option.temuValue || option.value));
    if (new Set(targets).size !== targets.length) {
      record("服装颜色", { code: "COLOR_MAPPING_CONFLICT", message: "多个货源颜色映射到同一 Temu 色值，请为每色指定不同选项。" });
      return;
    }
    for (const option of colors.length <= 20 ? colors : []) {
      const wanted = option.temuValue || option.value;
      const exists = rows.find(row => keyOf(row.value) === keyOf(wanted));
      if (exists) {
        colorLabels.set(keyOf(option.value), exists.value);
        continue;
      }
      let blank = rows.find(row => !hasValue(row.value));
      if (!blank) {
        const added = await run("temu_apparel", { kind: "add-color" });
        if (!added?.ok) { record("服装颜色", added); break; }
        rows = added.rows;
        blank = rows.find(row => !hasValue(row.value));
      }
      if (!blank) {
        record(option.value, { code: "SPEC_CONTROL_MISSING", message: "服装颜色表没有空白可填写行。" });
        break;
      }
      const candidate = !option.temuValue && standardColor(wanted);
      const alternate = candidate && !colors.some(other => other !== option &&
        (keyOf(other.temuValue || other.value) === keyOf(candidate) || standardColor(other.value) === candidate)) ? candidate : undefined;
      const applied = await run("temu_apparel", { kind: "set-color", key: blank.key, value: wanted, alternate });
      record(option.value, applied, blank.key);
      if (!applied?.ok) continue;
      colorLabels.set(keyOf(option.value), applied.value || wanted);
      const live = await run("temu_apparel", { kind: "inspect" });
      if (!live?.ok) { record("服装颜色", live); break; }
      rows = live.rows;
    }
    const sizeGroup = groups.find(group => optionAliases(group.name).includes("尺码"));
    const skuSizes = (input.skus || []).flatMap(row => Object.entries(row.options || {}).flatMap(([name, value]) =>
      optionAliases(name).includes("尺码") ? [value] : []));
    const sizes = [...new Set(input.sizes?.length ? input.sizes : sizeGroup?.options.length
      ? sizeGroup.options.map(option => option.value) : skuSizes)];
    const system = input.sizeSystem || ((input.sites || [input.site]).includes("美国站") ? "欧美尺码" : "");
    const outcome = await run("temu_apparel", { kind: "set-sizes", value: { system, sizes, ...(!sizes.length && { all: true }) } });
    for (const item of outcome?.items || []) items.push(item);
    record("尺码", outcome);
    apparelHandledSizeChart = true;
    if (outcome?.ok) await applySizeChart(outcome.sizes || sizes);
  }
  async function applySizeChart(sizes) {
    const label = "尺码表模板";
    if (input.sizeChartTemplate) {
      record(label, await run("temu_apparel", { kind: "select-size-chart", value: input.sizeChartTemplate }));
      return;
    }
    let sizeChart = input.sizeChart;
    let imageError;
    if (!sizeChart && input.sizeChartImagePath && readSizeChart) {
      report("size-chart", "识别目录中的尺码图");
      try {
        sizeChart = await readSizeChart();
      } catch (error) {
        signal?.throwIfAborted();
        imageError = error;
      }
    }
    if (suggestSizeChart && !imageError) {
      report("size-chart", "按当前尺码补齐成衣和人体参考数据");
      try {
        const suggested = await suggestSizeChart({ ...input, sizeChart, sizes }, { sizes, signal });
        if (!suggested?.ok) { record(label, suggested); return; }
        const chart = suggested.chart;
        const outcome = await run("temu_apparel", { kind: "create-size-chart", value: chart });
        record(label, outcome);
        if (outcome?.ok && suggested.estimatedCells?.length) {
          issues.push(asIssue(label, { code: "SIZE_CHART_ESTIMATED",
            message: `有 ${suggested.estimatedCells.length} 个尺码单元格使用 AI 参考值，请核对后再创建商品。` }));
        }
        if (outcome?.ok && suggested.missingCells?.length) {
          issues.push(asIssue(label, { code: "SIZE_CHART_ESTIMATE_INCOMPLETE",
            message: `有 ${suggested.missingCells.length} 个尺码单元格缺少可用数据，请核对。` }));
        }
        return;
      } catch (error) {
        signal?.throwIfAborted();
        if (error?.workflowCode) throw error;
        record(label, { code: "SIZE_CHART_SUGGEST_FAILED", message: error?.message || "尺码建议未完成。" });
        return;
      }
    }
    if (imageError) {
      record(label, { code: "SIZE_CHART_IMAGE_UNREADABLE", message: imageError.message || "无法识别目录尺码图。" });
      return;
    }
    if (!sizeChart) {
      record(label, { code: "SIZE_CHART_INPUT_MISSING", message: input.sizeChartImagePath
        ? "已找到尺码图。可开启 AI 识图，或补充结构化尺码表、店铺已有模板名。"
        : "请提供成衣与人体尺寸，或店铺已有尺码表模板名。" });
      return;
    }
    const prepared = prepareTemuSizeChart({ ...input, sizes, sizeChart });
    if (!prepared.ok) { record(label, prepared); return; }
    report("size-chart", "添加并核对商品尺码表");
    record(label, await run("temu_apparel", { kind: "create-size-chart", value: prepared.chart }));
  }
  async function applyService(fields) {
    for (const field of fields.filter(isTemuServiceField)) {
      const plan = await planTemuServiceField(input, field, () => field.locator
        ? run("temu_field_options", { key: field.key, forceLive: true })
        : { ok: true, options: field.options });
      if (plan.kind === "select") await applyField(field, plan.value);
      else if (plan.kind === "keep") record(field.label, { ok: true, status: "unchanged" }, field.key);
      else record(field.label, plan, field.key);
    }
  }
  async function applyComposition() {
    const entries = input.composition || [];
    if (!entries.length) return;
    if (entries.length > 8 || entries.some(entry => !entry.material || !(Number(entry.percent) > 0)) ||
        Math.abs(entries.reduce((sum, entry) => sum + Number(entry.percent), 0) - 100) > 0.001) {
      record("成分比例", { code: "COMPOSITION_INVALID", message: "请按商品资料提供总计 100% 的材料及比例。" });
      return;
    }
    let current = await run("temu_apparel", { kind: "composition-inspect" });
    for (const [index, entry] of entries.entries()) {
      if (current?.ok && index >= current.rows.length) current = await run("temu_apparel", { kind: "composition-add" });
      if (!current?.ok) { record("成分比例", current); return; }
      const row = current.rows[index];
      const fresh = await readEditor();
      if (!fresh?.ok) { record("成分比例", fresh); return; }
      const key = `composition-material-${row?.index}`;
      const field = fresh.fields.find(field => field.key === key);
      if (!field) {
        record(entry.material, { code: "COMPOSITION_MISSING", message: "成分选项行尚未渲染。" });
        return;
      }
      const applied = await applyField(field, entry.material);
      if (!applied?.ok) return;
      const percent = await run("temu_apparel", { kind: "composition-percentage", key: row.index, value: entry.percent });
      record(`${entry.material} · ${entry.percent}%`, percent);
      if (!percent?.ok) return;
    }
  }
  async function applyVariantGroups() {
    if (!input.variantGroups?.length && !input.sizes?.length && !lastState.hasApparelSizes &&
        !lastState.fields.some(field => field.key === "apparel-size")) return;
    const parentFields = state => state.fields.filter(field => /^父规格\s*[12]/u.test(field.label));
    const groups = (input.variantGroups || []).slice(0, 2);
    if (!parentFields(lastState).length) {
      const apparel = await run("temu_apparel", { kind: "inspect" });
      if (!apparel?.ok) { record("商品规格", apparel); return; }
      if (apparel.rows.length) {
        await applyApparel(apparel, groups);
        return;
      }
    }
    for (const [index, group] of groups.entries()) {
      let live = await readEditor();
      if (!live?.ok) { record("商品规格", live); return; }
      if (index === 1 && parentFields(live).length === 1) {
        const added = await run("temu_add_parent_spec");
        record("添加父规格 2", added);
        if (!added?.ok) break;
        live = await readEditor();
        if (!live?.ok) { record("商品规格", live); return; }
      }
      const parentFieldsAtIndex = parentFields(live).filter(field => keyOf(field.label).startsWith(`父规格${index + 1}`));
      if (parentFieldsAtIndex.length !== 1) {
        record(group.name, { code: "SPEC_CONTROL_MISSING", message: "未定位到可用的父规格下拉，请在 Temu 核对此类目的规格。" });
        continue;
      }
      const parent = parentFieldsAtIndex[0];
      if (!optionAliases(group.name).includes(keyOf(parent.value))) {
        const value = await chooseCurrentOption(parent, group.name);
        if (!value) {
          record(group.name, { code: "SPEC_OPTION_MISSING", message: "Temu 没有唯一匹配的父规格选项。" });
          continue;
        }
        await applyField(parent, value);
      }
      const fresh = await readEditor();
      if (!fresh?.ok) { record("商品规格", fresh); return; }
      const typed = await run("temu_spec_values", { parentIndex: index,
        labels: optionAliases(group.name), values: group.options.map(option => option.value) });
      for (const item of typed?.items || []) items.push(item);
      if (typed?.ok) {
        record(group.name, typed);
        continue;
      }
      if (typed?.items?.length || fatal.has(typed?.code)) { record(group.name, typed); continue; }
      const containers = fresh.fields.filter(field => field.multiple && field.locator && field.key !== parent.key &&
        optionAliases(group.name).includes(keyOf(field.label)));
      if (containers.length === 1) {
        const [target] = containers;
        await applyField(target, group.options.map(option => option.value));
      } else if (group.options.length) {
        const prefix = index === 0 ? /^productSkcList\[\d+\]\.mainSpec\[0\]$/u : /\.subSpec\[\d+\]/u;
        const values = fresh.fields.filter(field => prefix.test(field.key));
        const confirmed = new Set(values.flatMap(field => [keyOf(field.value)]));
        const available = values.filter(field => !hasValue(field.value));
        for (const option of group.options.filter(option => !confirmed.has(keyOf(option.value)))) {
          const target = available.shift();
          if (!target) {
            record(group.name, { code: "SPEC_VALUES_NOT_RENDERED", message: "部分规格值没有可填写的控件，需核对生成的 SKU 行。" });
            break;
          }
          await applyField(target, option.value);
        }
      }
    }
  }
  async function uploadImages(role, paths, state, variant, targetKey) {
    if (input.uploadImages === false || !paths?.length) return;
    const label = variant ? `${variant}规格图` : { main: "商品轮播图", detail: "详情图", "size-chart": "尺码图", variant: "规格图" }[role];
    const targets = state.uploads.filter(target => target.role === role &&
      (!targetKey || target.key === targetKey) && (!variant || keyOf(target.variant) === keyOf(variant)));
    if (targets.length !== 1) {
      record(label, { code: "UPLOAD_CONTROL_MISSING", message: "未找到唯一匹配的图片上传控件。" });
      return;
    }
    const [target] = targets;
    const capacity = role === "main" ? 10 : 8;
    const files = [...new Set(paths)].slice(0, capacity);
    const batches = target.multiple ? [files] : files.map(file => [file]);
    for (const paths of batches) {
      const outcome = await run("temu_upload", { role, key: target.key, identifier: target.variant, paths });
      record(label, outcome, target.key);
      if (!outcome?.ok) break;
    }
  }
  function explicitValue(field) {
    if (field.skuMember) {
      const rows = input.skus?.length ? input.skus : [input];
      const keys = new Set(lastState.fields.filter(entry => entry.skuMember).map(entry => entry.skuGroup));
      const row = matchingSku(field, rows, keys.size, colorLabels);
      return row && skuValue(field, row, input);
    }
    if (isTemuServiceField(field)) return undefined;
    const direct = readTemuAttributeValue(input, field);
    if (hasValue(direct)) return direct;
    if (/^productEnName$|^英文(?:商品)?名称$/u.test(field.key === "productEnName" ? field.key : field.label)) {
      return input.englishTitle || (/[a-z]/iu.test(input.title) && !/\p{Script=Han}/u.test(input.title) ? input.title : null);
    }
    if (field.key === "productName" || /^(?:中文)?商品(?:名称|标题)$/u.test(field.label)) return input.title;
    if (/^(?:中文|英文)?商品(?:描述|详情描述)$/u.test(field.label)) return input.description;
    if (/^(?:商家货号|商品货号)$/u.test(field.label)) return input.sku;
    if (field.key === "manufacturingLocation" && input.manufacturingLocation) {
      return field.multiple ? [input.manufacturingLocation] : input.manufacturingLocation;
    }
    return undefined;
  }

  async function recoverAttributes(state) {
    const invalid = new Set(validationOf(state).filter(issue => issue.key && issue.kind !== "upload").map(issue => issue.key));
    const canSuggest = shouldSuggestField ?? createTemuSuggestionFilter(input);
    const candidates = state.fields.filter(field => categoryAttribute.test(field.key) && !field.skuMember &&
      ["select", "text", "checkbox", "radio"].includes(field.kind) && !isTemuServiceField(field) &&
      state.fields.filter(other => other.key === field.key).length === 1 &&
      (invalid.has(field.key) || field.required && !hasValue(field.value)) &&
      (hasValue(explicitValue(field)) ||
        typeof suggestFields === "function" && canSuggest(field))).slice(0, 10);
    if (!candidates.length) return state;
    report("repair", "补齐 Temu 当前类目遗漏的属性");
    const pending = [];
    const plan = [];
    for (const field of candidates) {
      let live = { ...field, options: field.options || [] };
      if (field.locator) {
        const observed = await run("temu_field_options", { key: field.key, forceLive: true });
        if (!observed?.ok) {
          record(field.label, observed, field.key);
          continue;
        }
        live = { ...live, options: observed.options || [] };
      }
      const direct = explicitValue(field);
      const value = recoveryValue(live, direct);
      if (hasValue(value)) plan.push({ field: live, value });
      else if (!hasValue(direct) && typeof suggestFields === "function") {
        pending.push({ ...live, required: true, value: "" });
      }
    }
    if (pending.length) {
      try {
        const suggestion = await suggestFields(input, { fields: pending }, { signal });
        for (const field of pending) {
          const value = recoveryValue(field, suggestion?.values?.[field.key]);
          if (hasValue(value)) plan.push({ field, value });
        }
      } catch (error) {
        if (signal?.aborted || error?.workflowCode) throw error;
        issues.push(asIssue("类目资料补齐", { code: "SUGGEST_FAILED", message: error?.message }));
      }
    }
    if (!plan.length) return state;

    const successful = [];
    for (const { field, value } of plan) {
      if ((await applyField(field, value, { recovery: true }))?.ok) successful.push({ field, value, receipt: items.at(-1) });
    }
    const after = await readEditor();
    if (!after?.ok) return after;
    const remaining = new Set(validationOf(after).map(issue => issue.key));
    const resolved = new Set();
    for (const { field, value, receipt } of successful) {
      const actual = after.fields.filter(other => other.key === field.key);
      if (actual.length === 1 && !remaining.has(field.key) && verifiesRecovery(field, value, actual[0].value)) {
        resolved.add(field.key);
      } else {
        receipt.status = "needs-review";
        if (!remaining.has(field.key)) issues.push(asIssue(field.label, {
          code: "READBACK_MISMATCH", message: "Temu 未回读到已补齐的属性值。",
        }, field.key));
      }
    }
    for (let index = issues.length - 1; index >= 0; index--) if (resolved.has(issues[index].key)) issues.splice(index, 1);
    for (let index = items.length - 1; index >= 0; index--) {
      if (items[index].status === "needs-review" && resolved.has(items[index].key)) items.splice(index, 1);
    }
    return after;
  }

  try {
    const sites = input?.sites?.length ? input.sites : input?.site ? [input.site] : [];
    if (!Number.isSafeInteger(tabId) || tabId < 1 || typeof call !== "function" ||
        typeof input?.title !== "string" || !input.title.trim() || !sites[0] || sites.length !== 1 ||
        !Array.isArray(input?.categoryPath) || input.categoryPath.length < 1 || !input.categoryPath.every(item => typeof item === "string" && item.trim())) {
      return stop("试填参数", { code: "INPUT_REQUIRED", message: "选择一个经营站点和完整商品类目，再检查商品名称。" });
    }

    report("category", "选择经营站点和商品分类");
    const moved = await run("temu_category", { site: sites[0], categoryPath: input.categoryPath });
    if (!moved?.ok) return stop("经营站点与商品分类", moved);
    draftUrl = moved.href;
    record("经营站点与商品分类", moved);

    report("editor", "读取商品类目表单");
    let first = await readEditor({ wait: true });
    const hasApparelSizes = first?.hasApparelSizes || first?.fields?.some(field => field.key === "apparel-size");
    if (hasApparelSizes || first?.code === "MODAL_BLOCKED") {
      const tip = await run("temu_apparel", { kind: "dismiss-size-tip" });
      if (!tip?.ok && fatal.has(tip?.code)) return stop("尺码教学提示", tip);
      if (tip?.status === "verified") {
        record("尺码教学提示", tip);
        first = await readEditor({ wait: true });
      }
    }
    if (!first?.ok) return stop("商品表单", first);
    const country = input.origin?.country || (typeof input.origin === "string" ? input.origin.trim() : "");
    if (country) {
      const countryNames = /^(CN|中国|China|中国大陆)$/iu.test(country) ? [country, "中国", "中国大陆", "China", "中国（大陆）"] : [country];
      const origin = [countryNames];
      if (input.origin?.region) origin.push([input.origin.region]);
      const outcome = await run("temu_origin", { origin });
      record("商品产地", outcome, "productOriginCode");
      attempted.add("productOriginCode");
    }

    report("basic", "填写商品名称和类目属性");
    for (let round = 0; round < 3; round++) {
      const live = round === 0 && !country ? first : await readEditor();
      if (!live?.ok) return stop("商品表单", live);
      const explicit = live.fields.filter(field => !field.skuMember && !attempted.has(field.key) && hasValue(explicitValue(field)));
      if (!explicit.length) break;
      for (const field of explicit) await applyField(field, explicitValue(field));
    }
    const afterBasic = await readEditor();
    if (!afterBasic?.ok) return stop("已填商品复核", afterBasic);
    await applyComposition();
    await applyService(afterBasic.fields);

    if (typeof suggestFields === "function") {
      report("suggest", "补齐当前类目字段");
      const current = await readEditor();
      if (!current?.ok) return stop("类目资料补齐", current);
      const candidates = current.fields.filter(field => field.required && !field.skuMember && !isTemuServiceField(field) &&
        !attempted.has(field.key) && !hasValue(field.value) && (shouldSuggestField?.(field) ?? true)).slice(0, 30);
      const fields = [];
      for (const field of candidates) {
        if (field.locator && !field.options?.length) {
          const probed = await run("temu_field_options", { key: field.key });
          if (!probed?.ok && fatal.has(probed?.code)) return stop(field.label, probed);
          if (probed?.ok && probed.options?.length) fields.push({ ...field, ...probed.field, options: probed.options });
        } else fields.push(field);
      }
      if (fields.length) {
        try {
          const suggestion = await suggestFields(input, { fields }, { signal });
          for (const field of fields) if (Object.hasOwn(suggestion?.values || {}, field.key)) {
            await applyField(field, suggestion.values[field.key]);
          }
        } catch (error) {
          if (signal?.aborted || error?.workflowCode) throw error;
          issues.push(asIssue("类目资料补齐", { code: "SUGGEST_FAILED", message: error?.message }));
        }
      }
    }

    report("variants", "按当前类目准备规格并填写匹配的 SKU 行");
    await applyVariantGroups();
    const afterVariants = await readEditor();
    if (!afterVariants?.ok) return stop("商品规格", afterVariants);
    const classification = afterVariants.fields.filter(field => field.skuMember === "productSkuMultiPack.skuClassification" &&
      hasValue(explicitValue(field)));
    for (const field of classification) await applyField(field, explicitValue(field));
    const skuEditor = classification.length ? await readEditor() : afterVariants;
    if (!skuEditor?.ok) return stop("SKU 联动字段", skuEditor);
    for (const field of skuEditor.fields.filter(field => field.skuMember)) await applyField(field, explicitValue(field));
    const sources = input.skus?.length ? input.skus : [input];
    const stockPlan = [];
    for (const [source, key] of matchedSkuGroups(skuEditor, sources, colorLabels)) {
      const quantity = source.quantity ?? input.quantity;
      if (!key || !hasValue(quantity) || skuEditor.fields.some(field => field.skuGroup === key && stockMembers.has(field.skuMember))) continue;
      const labels = skuEditor.skuRows?.find(row => row.id === key)?.labels ||
        skuEditor.fields.find(field => field.skuGroup === key)?.rowLabels || [];
      stockPlan.push({ key, labels, value: quantity, label: `${source.sellerSku || "SKU"} 库存` });
    }
    if (stockPlan.length) {
      const [{ key, value }] = stockPlan;
      const outcome = stockPlan.length === 1 ? await run("temu_stock", { kind: "write", key, value })
        : await run("temu_stock", { kind: "write-batch", key, rows: stockPlan.map(({ key, labels, value }) => ({ key, labels, value })) });
      for (const entry of stockPlan) {
        record(entry.label, outcome, entry.key);
        if (outcome?.ok) popupStock.add(entry.key);
      }
    }
    if (input.skus?.length && !input.price && input.skus.every(row => !row.price)) {
      issues.push(asIssue("申报价格", { code: "SKU_PRICE_MISSING", message: "该商品资料没有卖家申报价。请使用实际的人民币申报价，来源平台售价不会作为申报价。" }));
    }
    report("images", "上传本商品图片并核对页面回显");
    const beforeImages = await readEditor();
    if (!beforeImages?.ok) return stop("图片控件", beforeImages);
    const gallery = input.mainImages || (input.imagePath ? [input.imagePath] : []);
    const apparelGalleries = beforeImages.uploads.filter(target => /^productSkcList\[/u.test(target.key) && target.role === "variant");
    if (!apparelGalleries.length || beforeImages.uploads.some(target => target.role === "main")) {
      await uploadImages("main", gallery, beforeImages);
    }
    const detailUpload = beforeImages.uploads.some(target => target.role === "detail");
    if (detailUpload) await uploadImages("detail", input.detailImages, beforeImages);
    if (input.uploadImages !== false && input.sizeChartImagePath && !apparelHandledSizeChart &&
        beforeImages.uploads.some(target => target.role === "size-chart")) {
      await uploadImages("size-chart", [input.sizeChartImagePath], beforeImages);
    }
    const groups = input.variantGroups || [];
    const skuImages = beforeImages.uploads.filter(target => target.role === "variant" && target.rowLabels);
    for (const target of skuImages) {
      const row = matchingSku(target, input.skus?.length ? input.skus : [input], skuImages.length, colorLabels);
      if (!row) continue;
      const optionImages = groups.flatMap(group => group.options.filter(option =>
        option.imagePath && Object.values(row.options || {}).some(value => keyOf(value) === keyOf(option.value))).map(option => option.imagePath));
      const image = row.imagePath || optionImages[0] || gallery[0];
      if (image) await uploadImages("variant", [image], beforeImages, undefined, target.key);
    }
    for (const group of groups) for (const option of group.options || []) {
      const label = colorLabels.get(keyOf(option.value)) || option.value;
      const matching = beforeImages.uploads.filter(target => target.role === "variant" && keyOf(target.variant) === keyOf(label));
      if (matching.length === 1) {
        const [target] = matching;
        const image = option.imagePath || (apparelGalleries.length === 1 && group.options.length === 1 ? gallery[0] : "");
        if (!apparelGalleries.includes(target)) {
          if (image) await uploadImages("variant", [image], beforeImages, label, target.key);
          continue;
        }
        if (input.uploadImages === false || target.markers >= target.minimum) continue;
        const supporting = option.galleryImages ?? input.sharedGalleryImages ?? [];
        const carousel = image ? [...new Set([image, ...supporting])].slice(0, 5) : [];
        if (carousel.length < target.minimum || target.markers) {
          record(`${label}规格图`, { code: "SKC_GALLERY_INCOMPLETE", message: target.markers
            ? "此规格已有部分图片，请先核对现有槽位及顺序。"
            : `请准备此色主图和共用素材，按主图、材质、版型、细节、工艺排列，最少 ${target.minimum} 张。` }, target.key);
          continue;
        }
        await uploadImages("variant", carousel, beforeImages, label, target.key);
      }
    }

    const hasDirectDescription = beforeImages.fields.some(field =>
      /^(?:中文|英文)?商品(?:描述|详情描述)$/u.test(field.label) && field.value === input.description);
    const decorImages = !detailUpload && input.uploadImages !== false ? [...new Set(input.detailImages || [])].slice(0, 10) : [];
    if (input.description && !hasDirectDescription || decorImages.length) {
      report("description", "填写商品详情图文");
      const description = await run("temu_description", { description: hasDirectDescription ? "" : input.description, paths: decorImages });
      record("详情图文", description);
      if (description?.imageIssue) record("详情图", description.imageIssue);
      if (description?.detailIssue) record("详情文字", description.detailIssue);
    }

    report("verify", "复核试填表单");
    let final = await readEditor();
    if (!final?.ok) return stop("试填回读", final);
    final = await recoverAttributes(final);
    if (!final?.ok) return stop("试填回读", final);
    if (step !== "verify") report("verify", "复核试填表单");
    const skuFields = final.fields.filter(field => field.skuMember && field.skuGroup);
    const matched = matchedSkuGroups(final, sources, colorLabels);
    if (input.skus?.length) {
      verifiedSkuCount = sources.filter(source => matched.get(source)).length;
      if (verifiedSkuCount < sources.length) issues.push(asIssue("SKU", { code: "SKU_ROWS_MISSING",
        message: `有 ${sources.length - verifiedSkuCount} 个源 SKU 未唯一匹配到当前表格。` }));
    }
    let missingStock = 0;
    for (const source of sources) {
      const expected = source.quantity ?? input.quantity;
      if (!hasValue(expected)) continue;
      const key = matched.get(source);
      const inline = skuFields.some(field => field.skuGroup === key && stockMembers.has(field.skuMember) &&
        hasValue(field.value) && Number(field.value) === Number(expected));
      if (inline) continue;
      const stock = popupStock.has(key) && await run("temu_stock", { kind: "inspect", key });
      if (!stock?.ok || !hasValue(stock.value) || Number(stock.value) !== Number(expected)) missingStock++;
    }
    if (missingStock) issues.push(asIssue("库存", { code: "SKU_QUANTITY_UNVERIFIED",
      message: `有 ${missingStock} 个 SKU 未回读到指定库存，请在 Temu 核对库存列。` }));
    missing = listMissing();
    verificationComplete = !final.truncated;
    const unsupportedRequired = final.unsupported?.filter(field => field.required) || [];
    for (const [index, field] of unsupportedRequired.entries()) {
      if (field.valuePresent === false && !missing.some(item => item.label === field.label)) {
        missing.push({ key: `unsupported-required-${index}`, label: field.label });
      }
    }
    const unknownRequired = unsupportedRequired.filter(field => field.valuePresent == null);
    if (unknownRequired.length) {
      verificationComplete = false;
      issues.push(asIssue("必填控件", { code: "REQUIRED_CONTROL_UNKNOWN",
        message: `有 ${unknownRequired.length} 个必填控件无法核对，请在 Temu 表单检查。` }));
    }
    for (const upload of final.uploads || []) {
      if (upload.minimum && upload.markers < upload.minimum) {
        missing.push({ key: upload.key, label: `${upload.variant ? upload.variant + "规格图" : "商品轮播图"}需至少 ${upload.minimum} 张，已显示 ${upload.markers} 张` });
      }
    }
    for (const { key, label, message } of validationOf(final)) {
      issues.push(asIssue(label || final.fields.find(field => field.key === key)?.label || "Temu 页面提示", { code: "VALIDATION", message }, key));
    }
    if (final.truncated) issues.push(asIssue("商品表单", { code: "FIELD_LIMIT", message: "当前表单超出一次试填支持的控件数量。" }));
    return result(issues.length || missing.length ? "needs-review" : "ready-for-review");
  } catch (error) {
    if (signal?.aborted) return result("cancelled", "CANCELLED");
    if (error?.workflowCode) return result("needs-review", error.workflowCode);
    return stop("Temu 试填", { code: "ACTION_FAILED", message: error?.message });
  }
}

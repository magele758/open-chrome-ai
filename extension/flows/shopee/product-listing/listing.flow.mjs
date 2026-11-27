import { normalizeSizeChart } from '../../../lib/size-chart.mjs';
import { recoverListingFields } from '../../shared/listing/adaptive-fields.js';

export const id = 'shopee-listing';
export const version = 1;
const origin = 'https://seller.shopee.cn';
const imageReadbackMs = 45000;
const imagePollMs = 250;

class Pause extends Error {
  constructor(code, details) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

const norm = (value) => String(value ?? '').trim().replace(/\s*[＞>›»]\s*/g, ' > ');
const matchedNumber = (actual, wanted) => actual != null && actual !== '' && Number(actual) === Number(wanted);
const positive = value => /^(?:\d+\.?\d*|\.\d+)$/.test(String(value)) && Number.isFinite(Number(value)) && Number(value) > 0;
const validImage = path => path == null || typeof path === 'string' && /^(?:\/|[A-Za-z]:[\\/]).+\.(?:png|jpe?g|webp)$/i.test(path);
const nonemptyText = value => typeof value === 'string' && value.trim() === value && value !== '';
const namedShippingFields = ['weight', 'width', 'length', 'height', 'shipDays'];
const requiredIssues = current => current?.requiredIssues ?? [];
const issueIdentity = ({ section, key, option }) => JSON.stringify([section, key, option]);
const isValidationSummary = message => /^\s*[1-9]\d*\s*个错误需调整[。！!]?\s*$/u.test(message);
const onlyValidationSummary = current => current.validation?.length === 1 &&
  isValidationSummary(current.validation[0]) && !current.missingRequired && !requiredIssues(current).length;

function normalizeVariants(variant) {
  if (variant == null) return [];
  if (!nonemptyText(variant.name) || variant.name.length > 14) throw new TypeError('规格名称格式不符');
  const rawOptions = variant.options === undefined ? [variant] : variant.options;
  if (!Array.isArray(rawOptions) || !rawOptions.length) throw new TypeError('至少需要一个规格选项');
  const names = new Set();
  const skus = new Set();
  for (const item of rawOptions) {
    if (!nonemptyText(item?.option) || item.option.length > 30 || !nonemptyText(item.sku)) {
      throw new TypeError('规格选项与货号格式不符');
    }
    if (names.has(item.option) || skus.has(item.sku)) throw new TypeError('同一商品的规格选项和货号不能重复');
    names.add(item.option);
    skus.add(item.sku);
    if (!validImage(item.imagePath)) throw new TypeError('SKU 图片应为本地图片的绝对路径');
  }
  return rawOptions;
}

function validate(input, tabId) {
  if (!Number.isSafeInteger(tabId) || tabId <= 0) throw new TypeError('需要明确的 tabId');
  for (const key of ['shopId', 'title', 'description']) {
    if (typeof input?.[key] !== 'string' || !input[key].trim()) throw new TypeError('缺少参数 ' + key);
  }
  if (!/^\d+$/.test(input.shopId) || input.title.length > 180 || input.description.length > 4000 ||
      input.category != null && (typeof input.category !== 'string' || input.category.length > 220)) {
    throw new TypeError('店铺、标题、描述或类目参数格式不符');
  }
  const fields = input.attributes ?? {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) ||
    Object.entries(fields).some(([label, value]) => !label.trim() ||
      (typeof value === 'string' ? !value.trim() : typeof value !== 'boolean' && !Number.isFinite(value) &&
        !(Array.isArray(value) && value.length && value.every(nonemptyText))))) {
    throw new TypeError('attributes 应为页面标签到选项文本的映射');
  }
  const variants = normalizeVariants(input.variant);
  if (!positive(input.weight)) throw new TypeError('重量应为正数');
  for (const sales of variants.length ? variants : [input]) {
    if (!positive(sales.price)) throw new TypeError('价格应为正数');
    if (!/^\d+$/.test(String(sales.quantity))) throw new TypeError('库存应为非负整数');
  }
  for (const key of ['width', 'length', 'height', 'shipDays']) {
    if (input[key] != null && (!/^\d+$/.test(String(input[key])) || Number(input[key]) <= 0)) throw new TypeError('无效参数 ' + key);
  }
  if (!validImage(input.imagePath) || input.galleryImages != null && (!Array.isArray(input.galleryImages) ||
      input.galleryImages.length > 8 || input.galleryImages.some(path => !path || !validImage(path)))) {
    throw new TypeError('商品主图和详情图应为本地图片的绝对路径');
  }
  return variants;
}

const sizeChartLabel = label => norm(label).normalize('NFKC').replace(/\s+/gu, '')
  .replaceAll('下擺寬度', '下摆宽度').replaceAll('長', '长').replaceAll('國際', '国际');

async function scopedSizeChartName(chart, category) {
  const payload = [category, chart.unit, chart.rows.map(row => Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))];
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
  const fingerprint = [...new Uint8Array(digest).subarray(0, 6)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const prefix = chart.name.length > 37 ? chart.name.slice(0, 37).trimEnd() : chart.name;
  return prefix + '-' + fingerprint;
}

function sameSizeChartRows(actual, desired) {
  return actual.length === desired.length && desired.every((row, index) => Object.entries(row).every(([label, value]) => {
    const key = sizeChartLabel(label);
    const observed = norm(actual[index][label]);
    if (key === '尺寸(国际)' && value === '2XL' && observed === 'XXL') return true;
    return value && !key.startsWith('尺寸(') ? matchedNumber(observed, value) : observed === value;
  }));
}

function sizeChartSources(chart, dialog) {
  const sourceColumns = new Map(chart.columns.map(label => [sizeChartLabel(label), label]));
  const kind = dialog.kind ?? norm(dialog.title).split(/\s+/u).at(-1);
  return dialog.columns.filter(column => column.checked).map(column => {
    const key = sizeChartLabel(column.label);
    const source = sourceColumns.get(key) || (kind === '上衣' && key === '上衣长度' ? sourceColumns.get('长度') : undefined);
    return { ...column, source };
  });
}

function validateCompletedChart(original, completed, requiredColumns) {
  const result = normalizeSizeChart(completed);
  const originalLabels = new Set(original.columns);
  const additions = result.columns.filter(label => !originalLabels.has(label));
  const required = new Map(requiredColumns.map(({ label, options }) => [sizeChartLabel(label), options]));
  if (result.name !== original.name || result.unit !== original.unit || result.rows.length !== original.rows.length ||
      additions.length !== required.size || additions.some(label => !required.has(sizeChartLabel(label))) ||
      !original.columns.every(label => result.columns.includes(label))) throw new Pause('size-chart-inference-changed');
  for (const [index, row] of result.rows.entries()) {
    if (original.columns.some(label => row[label] !== original.rows[index][label])) throw new Pause('size-chart-inference-changed');
    for (const label of additions) {
      const options = required.get(sizeChartLabel(label));
      if (options && !options.includes(row[label])) throw new Pause('size-chart-inference-option', { label, actual: row[label] });
    }
  }
  return { chart: result, estimatedColumns: additions };
}

async function replaySizeChart({ chart, category, title, allowInference, native, pause }) {
  const read = () => native('flow_size_chart_state', { category });
  const act = (action, args) => native('flow_size_chart_action', { category, action, ...args });
  async function waitFor(predicate, timeoutMs = 1600) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const current = await read();
      if (predicate(current) || Date.now() >= deadline) return current;
      await pause(100);
    }
  }
  let availableTemplates = [];
  async function selectExisting(name) {
    await act('open-options');
    const menu = await waitFor(current => Array.isArray(current.options));
    if (!Array.isArray(menu.options)) throw new Pause('size-chart-options-unavailable');
    availableTemplates = menu.options;
    const matches = availableTemplates.filter(option => option === name);
    if (matches.length > 1) throw new Pause('size-chart-template-ambiguous', { name });
    if (!matches.length) return false;
    await act('select', { name });
    const result = await waitFor(current => current.selectedName === name);
    if (result.selectedName !== name) throw new Pause('size-chart-selection-unverified', { name });
    return true;
  }

  let name = await scopedSizeChartName(chart, category);
  const first = await read();
  if (!first.available) throw new Pause('size-chart-control-unavailable');
  if (first.dialog) throw new Pause('size-chart-dialog-already-open');
  if (first.selectedName && first.selectedName !== name) {
    throw new Pause('size-chart-selection-conflict', { name, actual: first.selectedName });
  }
  let estimatedColumns = [];
  const receipt = reused => ({ name, unit: chart.unit, rows: chart.rows.length, reused,
    ...(estimatedColumns.length ? { estimatedColumns } : {}) });
  if (first.selectedName === name || await selectExisting(name)) return receipt(true);

  let dialog;
  async function expectDialog(predicate, code, details) {
    ({ dialog } = await waitFor(current => current.dialog && predicate(current.dialog)));
    if (!dialog || !predicate(dialog)) throw new Pause(code, details);
  }
  async function toggle(label, checked) {
    await act('toggle-column', { label, checked });
    await expectDialog(current => current.columns.some(column => column.label === label && column.checked === checked),
      'size-chart-column-unverified', { label });
  }
  async function openAndConfigureColumns() {
    await act('open');
    await expectDialog(current => current.columns?.length && current.rows?.length, 'size-chart-dialog-unavailable');
    if (dialog.name) throw new Pause('size-chart-dialog-name-conflict', { actual: dialog.name });
    const configured = new Set();
    for (const label of chart.columns) {
      const matches = dialog.columns.filter(column => sizeChartLabel(column.label) === sizeChartLabel(label));
      if (matches.length !== 1) throw new Pause('size-chart-column-unavailable', { label });
      configured.add(matches[0].label);
    }
    for (const label of configured) {
      const column = dialog.columns.find(candidate => candidate.label === label);
      if (!column?.checked) await toggle(label, true);
    }
    for (const { label } of dialog.columns) {
      const column = dialog.columns.find(candidate => candidate.label === label);
      if (column?.checked && !column.locked && !configured.has(label)) await toggle(label, false);
    }
  }

  await openAndConfigureColumns();
  let active = sizeChartSources(chart, dialog);
  const missing = active.filter(column => !column.source && column.required !== false);
  if (missing.length && allowInference) {
    const requiredColumns = [];
    for (const { label } of missing) {
      const field = { label };
      if (sizeChartLabel(label).startsWith('尺寸(')) {
        const values = await act('column-options', { label });
        if (!Array.isArray(values.options) || !values.options.length ||
            values.options.some(option => typeof option !== 'string' || !option.trim())) {
          throw new Pause('size-chart-inference-options-unavailable', { label });
        }
        field.options = [...new Set(values.options)];
      }
      requiredColumns.push(field);
    }
    const completion = await native('flow_size_chart_complete', { category, title, chart, requiredColumns });
    ({ chart, estimatedColumns } = validateCompletedChart(chart, completion.sizeChart, requiredColumns));
    name = await scopedSizeChartName(chart, category);
    if (availableTemplates.includes(name)) {
      await act('dismiss');
      if ((await waitFor(current => !current.dialog, 12000)).dialog) throw new Pause('size-chart-dismiss-unverified');
      if (await selectExisting(name)) return receipt(true);
      await openAndConfigureColumns();
    }
    active = sizeChartSources(chart, dialog);
  }
  for (const column of active) {
    if (!column.source && column.required !== false) throw new Pause('size-chart-required-column', { label: column.label });
  }

  await act('set-name', { name });
  await expectDialog(current => current.name === name, 'size-chart-name-unverified', { name });
  if (dialog.unit !== chart.unit) {
    await act('set-unit', { unit: chart.unit });
    await expectDialog(current => current.unit === chart.unit, 'size-chart-unit-unverified', { unit: chart.unit });
  }
  const rows = chart.rows.map(row => Object.fromEntries(active.map(({ label, source }) => [label, source ? row[source] : ''])));
  if (dialog.rows.length > rows.length) throw new Pause('size-chart-row-count-changed', { expected: rows.length, actual: dialog.rows.length });
  while (dialog.rows.length < rows.length) {
    const rowCount = dialog.rows.length;
    await act('add-row', { rowCount });
    await expectDialog(current => current.rows.length === rowCount + 1, 'size-chart-row-add-unverified', { rowCount });
  }
  await act('fill-rows', { rows });
  await expectDialog(current => current.name === name && current.unit === chart.unit && sameSizeChartRows(current.rows, rows),
    'size-chart-readback', { name });
  if (dialog.validation?.length) throw new Pause('size-chart-validation', dialog.validation);
  await act('save', { name, unit: chart.unit, rows });
  const saved = await waitFor(current => !current.dialog || current.dialog.validation?.length, 22000);
  if (saved.dialog?.validation?.length) throw new Pause('size-chart-validation', saved.dialog.validation);
  if (saved.dialog) throw new Pause('size-chart-save-unverified', { name });
  if (saved.selectedName !== name && !await selectExisting(name)) throw new Pause('size-chart-selection-unverified', { name });
  return receipt(false);
}

// call 由宿主提供，经 PageLens 现有工具包装后返回原始结果或抛出工具错误。
export async function replayShopeeListing({ call, tabId, input, onStep = () => {}, registerRecovery, signal }) {
  const variants = validate(input, tabId);
  const sizeChart = input.sizeChart == null ? null : normalizeSizeChart(input.sizeChart);
  const completed = [];
  const began = Date.now();
  let step = 'bind-page';
  let originalUrl;
  let state;
  let freshForm = false;
  let observedShipDays;
  let repairingRequired = false;
  let recoveringSubmission = false;
  let coverUploaded = false;
  let galleryUploaded = 0;
  let skuRows;
  let sizeChartReceipt;
  let category = norm(input.category);
  const allowAttributeAdvice = input.completeMissingAttributes === true;
  const hints = Array.isArray(input.categoryKeywords) ? input.categoryKeywords.filter(nonemptyText).slice(0, 6) : [];
  const uploadedOptions = new Set();
  const native = async (tool, args) => {
    signal?.throwIfAborted();
    if (!recoveringSubmission) onStep({ step, tool });
    const raw = await call(tool, { tabId, ...args });
    signal?.throwIfAborted();
    let response = raw;
    if (typeof raw === 'string') {
      try { response = JSON.parse(raw); } catch { throw new Pause('tool-failed', { tool, error: raw.slice(0, 300) }); }
    }
    if (response?.ok === false) {
      throw new Pause(response.code || response.error?.code || 'tool-failed', { tool, error: response.error });
    }
    return response;
  };
  const checkpoint = (next) => {
    completed.push(step);
    step = next;
  };
  const read = async (verifySummary = false, inspectRequired = false) => {
    const current = await native('flow_page_state', { category, ...(verifySummary && { verifySummary }) });
    const url = new URL(current.url);
    if (url.origin !== origin || url.pathname !== '/portal/mtsku/new' ||
      url.searchParams.getAll('cnsc_shop_id').length !== 1 || url.searchParams.get('cnsc_shop_id') !== input.shopId ||
      originalUrl && current.url !== originalUrl) throw new Pause('page-changed', { url: url.origin + url.pathname });
    originalUrl = current.url;
    if (current.modal) throw new Pause('modal', current.modal);
    const inOwnedDataPass = freshForm && ['sales', 'shipping', 'size-chart'].includes(step);
    if (inOwnedDataPass && (current.fields.title?.value !== input.title ||
        current.fields.sku?.value && input.sku != null && current.fields.sku.value !== input.sku)) {
      throw new Pause('page-changed', { text: '商品名称或货号已变化' });
    }
    if (!['bind-page', 'basic', 'category'].includes(step) && norm(current.category) !== category) {
      throw new Pause('different-category', { actual: current.category });
    }
    state = current;
    const validation = (inOwnedDataPass && current.categoryReady ? current.validationOutsideSalesAndShipping : undefined) ??
      current.unscopedValidation ?? current.validation;
    if (!repairingRequired && !(inspectRequired && requiredIssues(current).length) &&
        !(inOwnedDataPass && onlyValidationSummary(current)) && validation?.length) {
      throw new Pause('page-validation', validation);
    }
    return state;
  };
  const pause = async (ms) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    signal?.throwIfAborted();
  };
  const rememberShippingDefault = () => {
    if (!freshForm || !state.categoryReady || input.shipDays != null || observedShipDays != null) return;
    const value = state.fields.shipDays?.value;
    if (/^[1-9]\d*$/u.test(value ?? '') &&
        !requiredIssues(state).some(issue => issue.section === 'shipping' && issue.key === 'shipDays')) {
      observedShipDays = value;
    }
  };
  const readUntil = async (predicate, timeoutMs = 1600, pollMs = 100) => {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      await read();
      if (predicate(state) || Date.now() >= deadline) return;
      await pause(pollMs);
    }
  };
  const unique = async (selector, tag) => {
    if (!selector) throw new Pause('control-missing');
    const targets = await native('query_dom', { selector, limit: 2 });
    if (!Array.isArray(targets) || targets.length !== 1 || tag && targets[0].tag !== tag) {
      throw new Pause('control-changed', { selector });
    }
    return targets[0];
  };
  const fill = async (field, value, commit = false) => {
    if (!field) throw new Pause('field-missing');
    if (field.value === String(value)) return;
    const target = await unique(field.selector);
    if (!['input', 'textarea'].includes(target.tag) || target.type === 'file') {
      throw new Pause('field-kind-changed', { selector: field.selector });
    }
    await native('fill', { selector: field.selector, value: String(value), submit: false, ...(commit && { commit }) });
  };
  const movedControl = new Set(['control-changed', 'control-missing', 'field-missing', 'field-kind-changed']);
  const fillNamedField = async (key, value, commit = false) => {
    const ready = current => Boolean(current.fields[key]?.selector);
    if (!ready(state)) await readUntil(ready, 3000);
    if (!ready(state)) throw new Pause('field-missing', { key });
    try {
      await fill(state.fields[key], value, commit);
    } catch (error) {
      if (!movedControl.has(error.code)) throw error;
      await readUntil(ready, 3000);
      try {
        await fill(state.fields[key], value, commit);
      } catch (retry) {
        if (!movedControl.has(retry.code)) throw retry;
        throw new Pause(retry.code, { key });
      }
    }
  };
  const click = async (selector, label) => {
    const target = await unique(selector);
    if (norm(target.text) !== norm(label)) throw new Pause('click-label-changed', { expected: label, actual: target.text });
    await native('trusted_click', { selector, text: target.text });
  };
  const clickAttribute = async (label, selector) => {
    const target = await unique(selector);
    await native('flow_control_click', { action: 'attribute-trigger', selector, category, label, text: target.text });
  };
  const menuOpen = (current = state) => Boolean(current.options.length || current.optionSearch);
  const currentAttribute = label => {
    const matches = state.attributes.filter(field => field.label === label);
    if (matches.length !== 1) throw new Pause('attribute-changed', { label });
    return matches[0];
  };
  const openAttribute = async label => {
    if (menuOpen() && state.optionOwner !== label) throw new Pause('unexpected-open-menu', { label });
    if (!menuOpen()) {
      await clickAttribute(label, currentAttribute(label).selector);
      await pause(200);
      await readUntil(current => current.optionOwner === label && menuOpen(current), 1300);
    }
    if (menuOpen() && state.optionOwner !== label) throw new Pause('unexpected-open-menu', { label });
  };
  const closeAttribute = async label => {
    if (!menuOpen()) return;
    if (state.optionOwner !== label) throw new Pause('unexpected-open-menu', { label });
    await native('press_keys', { keys: ['Escape'] });
    await pause(180);
    await read();
    if (!menuOpen()) return;
    if (state.optionOwner !== label) throw new Pause('unexpected-open-menu', { label });
    await clickAttribute(label, currentAttribute(label).selector);
    await readUntil(current => !menuOpen(current), 650);
    if (menuOpen()) throw new Pause('unexpected-open-menu', { label });
  };
  const present = value => Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '';
  const equalValue = (field, choice) => field.type === 'number' ? matchedNumber(field.value, choice) :
    Array.isArray(choice) ? Array.isArray(field.value) && choice.length === field.value.length && choice.every(value => field.value.includes(value)) :
      field.value === choice;
  const setAttribute = async (label, choice, { preserve = false } = {}) => {
    const field = currentAttribute(label);
    if (equalValue(field, choice)) {
      if (menuOpen() && state.optionOwner === label) await closeAttribute(label);
      return 'unchanged';
    }
    if (preserve && present(field.value) && !field.error) throw new Pause('attribute-changed', { label });
    if (!field.selector || field.type === 'unsupported') throw new Pause('attribute-changed', { label });
    if (['number', 'text', 'checkbox'].includes(field.type) || field.nativeOptions) {
      await native('flow_control_click', { action: 'attribute-set', selector: field.selector, category, label, value: choice });
      await readUntil(current => current.attributes.some(attribute => attribute.label === label && equalValue(attribute, choice)));
      if (!equalValue(currentAttribute(label), choice)) throw new Pause('attribute-readback', { label, choice });
      return 'verified';
    }
    if (field.multiple && Array.isArray(choice)) {
      if (Array.isArray(field.value) && field.value.some(value => !choice.includes(value))) throw new Pause('attribute-changed', { label });
      for (const value of choice) {
        if (currentAttribute(label).value?.includes(value)) continue;
        await openAttribute(label);
        const found = current => current.optionOwner === label && current.options.some(item => item.text === value);
        if (!found(state) && state.optionSearch) await fill({ selector: state.optionSearch }, value);
        await readUntil(found, 1700);
        const matches = state.optionOwner === label ? state.options.filter(option => option.text === value) : [];
        if (matches.length !== 1) { await closeAttribute(label); throw new Pause('attribute-option-changed', { label, choice: value }); }
        await native('flow_control_click', { action: 'attribute-option', selector: matches[0].selector, category, label, text: value });
        await readUntil(current => current.attributes.some(attribute => attribute.label === label && attribute.value?.includes(value)));
      }
      await closeAttribute(label);
      if (!equalValue(currentAttribute(label), choice)) throw new Pause('attribute-readback', { label, choice });
      return 'verified';
    }
    await openAttribute(label);
    const matching = current => current.optionOwner === label && current.options.some(({ text }) => text === choice);
    if (!matching(state) && state.optionSearch && state.optionOwner === label) {
      await fill({ selector: state.optionSearch }, choice);
      await readUntil(matching, 2300);
    } else if (!matching(state)) {
      await readUntil(matching);
    }
    const matches = state.optionOwner === label ? state.options.filter(({ text }) => text === choice) : [];
    if (matches.length !== 1) {
      await closeAttribute(label);
      throw new Pause('attribute-option-changed', { label, choice });
    }
    await native('flow_control_click', {
      action: 'attribute-option', selector: matches[0].selector, category, label, text: choice,
    });
    await pause(180);
    await readUntil(current => current.attributes.find(attribute => attribute.label === label)?.value === choice);
    if (currentAttribute(label).value !== choice) throw new Pause('attribute-readback', { label, choice });
    await closeAttribute(label);
    return 'verified';
  };
  const expected = (key, value, normalize = (actual, desired) => String(actual) === String(desired)) => {
    const actual = state.fields[key]?.value;
    if (actual == null || !normalize(actual, value)) throw new Pause('readback-mismatch', { key, expected: value, actual: actual || '空' });
  };
  const rowFor = (option, current = state) => {
    const candidates = current.variant.rows.filter(row => row.option === option);
    return candidates.length === 1 ? candidates[0] : null;
  };
  const salesKeys = ['price', 'quantity', 'sku'];
  const saleMatches = (row, key, wanted) => Boolean(row &&
    (key === 'sku' ? row.sku === wanted : matchedNumber(row[key], wanted)));
  const rowMatches = (row, wanted) => salesKeys.every(key => saleMatches(row, key, wanted[key]));
  function skuReadbackError(row, wanted, keys = salesKeys) {
    const key = keys.find(key => !saleMatches(row, key, wanted[key]));
    return new Pause('sku-readback', { option: wanted.option, key, actual: row?.[key] || '空', expected: String(wanted[key]) });
  }
  async function fillSkuRow(wanted, commit, keys = salesKeys) {
    const row = () => rowFor(wanted.option);
    const verified = current => keys.every(key => saleMatches(rowFor(wanted.option, current), key, wanted[key]));
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const key of keys) {
        if (!row()?.selectors?.[key]) await readUntil(current => Boolean(rowFor(wanted.option, current)?.selectors?.[key]), 2500);
        const current = row();
        if (!current?.selectors?.[key]) throw new Pause('sku-control-missing', { option: wanted.option, key });
        if (saleMatches(current, key, wanted[key])) continue;
        try {
          await fill({ selector: current.selectors[key], value: current[key] }, wanted[key], commit);
        } catch (error) {
          if (!movedControl.has(error.code) && error.code !== 'readback-mismatch') throw error;
        }
        // Committing one cell can rebuild the SKU table and change every selector.
        await read();
      }
      await readUntil(verified, 2100);
      if (verified(state)) return;
    }
    throw skuReadbackError(row(), wanted, keys);
  }
  async function pickCategory(path, searchWords = []) {
    const operate = (action, args = {}) => native('flow_category_picker_action', { action, ...args });
    async function readPicker(check, timeout = 2400) {
      const deadline = Date.now() + timeout;
      do {
        const picker = await operate('read');
        if (check(picker) || Date.now() >= deadline) return picker;
        await pause(100);
      } while (true);
    }
    let picker = await operate('read');
    if (!picker.open) {
      await operate('open');
      picker = await readPicker(current => current.open && current.levels?.[0]?.length);
    }
    if (path && picker.query) {
      await operate('search', { query: '', expectedPath: picker.selectedPath });
      picker = await readPicker(current => current.query === '' && current.levels?.[0]?.length);
    }
    for (const query of path ? [] : searchWords.slice(0, 4)) {
      const before = JSON.stringify(picker.levels?.[0]);
      await operate('search', { query, expectedPath: picker.selectedPath });
      picker = await readPicker(current => current.query === query &&
        (current.noResults || current.levels?.[0]?.length && JSON.stringify(current.levels[0]) !== before), 1600);
      if (picker.query === query && picker.levels?.[0]?.length && JSON.stringify(picker.levels[0]) !== before) break;
    }
    if (!path && picker.query && !picker.levels?.[0]?.length) {
      await operate('search', { query: '', expectedPath: picker.selectedPath });
      picker = await readPicker(current => current.query === '' && current.levels?.[0]?.length);
    }
    const wanted = path ? path.split(' > ') : [];
    let selected = picker.selectedPath ?? [];
    for (let level = 0; level < 6; level++) {
      const choices = (picker.levels?.[level] ?? []).filter(option => !option.disabled);
      if (!choices.length) break;
      let label = wanted[level];
      if (!wanted.length && allowAttributeAdvice) {
        const options = choices.slice(0, 24);
        const match = await native('flow_category_advice', { candidates: options.map(option => [...selected, option.label]), hints });
        label = Number.isInteger(match?.index) ? options[match.index]?.label : undefined;
      }
      if (!label || choices.filter(option => option.label === label).length !== 1) {
        throw new Pause('category-option-missing', { category: path, candidates: choices.map(option => option.label) });
      }
      await operate('select', { level, label, expectedPath: selected });
      picker = await readPicker(current => current.selectedPath?.[level] === label &&
        (current.canConfirm || current.levels?.[level + 1]?.length));
      selected = picker.selectedPath ?? [];
      if (selected[level] !== label) throw new Pause('category-not-ready', { category: path, selected });
      if (picker.canConfirm && (!wanted.length || selected.length === wanted.length)) {
        const chosen = selected.join(' > ');
        if (path && chosen !== path) throw new Pause('category-not-ready', { category: path, actual: chosen });
        await operate('confirm', { category: chosen });
        const closed = await readPicker(current => !current.open);
        if (closed.open) throw new Pause('category-not-ready', { category: chosen });
        return chosen;
      }
    }
    throw new Pause('category-not-ready', { category: path, selected });
  }
  try {
    await readUntil(current => Boolean(current.fields.title?.selector && current.fields.description?.selector), 5000);
    freshForm = input.resetUnownedDraftVariants === true && state.fields.title?.value === '';
    checkpoint('basic');
    if (state.category && category && norm(state.category) !== category) throw new Pause('different-category', { actual: state.category });
    await fillNamedField('title', input.title);
    await fillNamedField('description', input.description);
    await read();
    expected('title', input.title);
    expected('description', input.description);

    checkpoint('category');
    let usedPicker = false;
    category ||= norm(state.category);
    if (!state.category) {
      if (!state.recommendation) {
        await readUntil(current => Boolean(current.recommendation || current.category || !category && current.categoryRecommendations?.length), 3800);
      }
      if (!state.category) {
        let recommendation = state.recommendation;
        let searchWords = hints;
        if (!category && allowAttributeAdvice) {
          const cached = await native('flow_category_advice', { mode: 'cache', hints });
          category = norm(cached?.path);
          if (cached?.keywords?.length) searchWords = [...cached.keywords, ...hints];
          if (!category && state.categoryRecommendations?.length) {
            const options = state.categoryRecommendations.slice(0, 24);
            const suggestion = await native('flow_category_advice', { candidates: options.map(item => norm(item.path).split(' > ')), hints });
            const chosen = Number.isInteger(suggestion?.index) ? options[suggestion.index] : null;
            if (chosen) { category = norm(chosen.path); recommendation = chosen.selector; }
          }
          if (!category && searchWords === hints) {
            const proposed = await native('flow_category_advice', { mode: 'keywords', hints });
            searchWords = [...(proposed?.keywords ?? []), ...hints];
          }
        }
        if (recommendation && category) {
          try {
            await click(recommendation, category);
            await readUntil(current => Boolean(current.category));
          } catch (error) {
            if (!movedControl.has(error.code) && error.code !== 'click-label-changed') throw error;
            await read();
            recommendation = state.recommendation ?? state.categoryRecommendations?.find(item => norm(item.path) === category)?.selector;
          }
        }
        if (!state.category && recommendation && category) {
          const target = await unique(recommendation);
          if (norm(target.text) !== category) throw new Pause('category-control-changed', { category, actual: target.text });
          await native('flow_category_click', { selector: recommendation, category });
        } else if (!state.category) {
          if (!state.categoryPickerAvailable || !category && !allowAttributeAdvice) {
            throw new Pause('category-option-missing', { category, recommendations: state.recommendations ?? [] });
          }
          category = await pickCategory(category, [...new Set(searchWords)].filter(nonemptyText));
          usedPicker = true;
        }
      }
      if (!state.categoryReady) await readUntil(current => current.categoryReady, 3800);
    }
    if (norm(state.category) !== category || !state.categoryReady) {
      throw new Pause('category-not-ready', { category, actual: state.category, recommendations: state.recommendations ?? [] });
    }
    rememberShippingDefault();
    if (usedPicker || !input.category && allowAttributeAdvice) await native('flow_category_remember', { category });

    checkpoint('category-attributes');
    const supplied = input.attributes ?? {};
    const attributeTargets = new Map(Object.entries(supplied));
    const attributeFailures = new Map();
    let adviceFailure;
    const deferAttribute = async (label, error) => {
      const controlChanged = ['control-changed', 'field-kind-changed'].includes(error.code);
      if (!controlChanged && !['attribute-changed', 'attribute-option-changed', 'attribute-readback'].includes(error.code)) throw error;
      if (controlChanged) await read();
      if (menuOpen()) await closeAttribute(label);
      attributeFailures.set(label, error);
    };
    // Shopee can render sales controls before the category attribute panel is hydrated.
    // Wait for these category-specific controls instead of immediately treating them as missing.
    const requestedAttributes = Object.keys(supplied);
    if (requestedAttributes.some(label => !state.attributes.some(field => field.label === label && field.selector))) {
      await readUntil(current => requestedAttributes.every(label =>
        current.attributes.some(field => field.label === label && field.selector)), 4800);
    }
    for (const [label, choice] of Object.entries(supplied)) {
      try { await setAttribute(label, choice); }
      catch (error) { await deferAttribute(label, error); }
    }

    if (allowAttributeAdvice) {
      const snapshot = () => ({ ok: true, fields: state.attributes.filter(field => ['text', 'number', 'checkbox', 'select'].includes(field.type) && field.selector &&
          !/品牌|\bbrand\b/iu.test(field.label) && (!Object.hasOwn(supplied, field.label) || attributeFailures.has(field.label)) &&
          state.attributes.filter(other => other.label === field.label).length === 1)
          .map(field => ({ key: field.label, label: field.label, section: 'category-attributes',
            type: field.type, value: field.value, required: field.required, multiple: field.multiple,
            min: field.min, max: field.max, maxLength: field.maxLength, nativeOptions: field.nativeOptions,
            error: field.error || (attributeFailures.has(field.label) && !present(field.value) ? '未能填写原值' : undefined) })) });
      await recoverListingFields({
        scope: { platform: 'shopee', store: input.shopId, categoryPath: category.split(' > ') },
        snapshot: snapshot(), signal, includeOptional: true,
        read: async () => { await read(); return snapshot(); },
        async readOptions(field) {
          if (field.nativeOptions) return field.nativeOptions;
          try {
            await openAttribute(field.label);
            const choices = state.optionOwner === field.label ? state.options.map(item => item.text) : [];
            await closeAttribute(field.label);
            return choices;
          } catch (error) {
            await deferAttribute(field.label, error);
            return [];
          }
        },
        async suggest(fields) {
          try {
            return (await native('flow_attribute_advice', { fields })).values;
          } catch (error) {
            if (!['attribute-advice-not-approved', 'attribute-advice-unavailable'].includes(error.code)) throw error;
            adviceFailure = error.details?.error;
            return {};
          }
        },
        async apply(values) {
          const issues = [];
          for (const [label, choice] of Object.entries(values)) {
            try {
              await setAttribute(label, choice, { preserve: true });
              attributeTargets.set(label, choice);
              attributeFailures.delete(label);
            }
            catch (error) {
              await deferAttribute(label, error);
              issues.push({ key: label, code: error.code === 'attribute-option-changed' ? 'OPTION_MISSING' : 'ATTRIBUTE_UNVERIFIED' });
            }
          }
          return { ok: true, issues };
        },
      });
    }

    checkpoint('image');
    const gallery = [...new Set(input.galleryImages ?? [])].filter(path => path !== input.imagePath);
    const photosReady = (current, expectedCount) => current.image.cover && current.image.coverReady &&
      current.image.count === expectedCount && current.image.readyCount === expectedCount;
    if (input.imagePath && state.image.count == null) throw new Pause('cover-count-unknown');
    if (input.imagePath && state.image.count && !input.retainExistingCover) throw new Pause('cover-already-present');
    if (input.imagePath && !state.image.count) {
      await unique(state.image.selector, 'input');
      await native('upload_file', { selector: state.image.selector, paths: [input.imagePath] });
      await readUntil(current => photosReady(current, 1), imageReadbackMs, imagePollMs);
      coverUploaded = photosReady(state, 1);
      if (!coverUploaded) throw new Pause('cover-readback');
    }
    if (gallery.length && (!input.imagePath || !photosReady(state, 1))) {
      throw new Pause('gallery-cover-unverified', { count: state.image.count });
    }
    for (const path of gallery) {
      const previous = state.image.count;
      await unique(state.image.selector, 'input');
      await native('upload_file', { selector: state.image.selector, paths: [path] });
      await readUntil(current => photosReady(current, previous + 1), imageReadbackMs, imagePollMs);
      if (!photosReady(state, previous + 1)) throw new Pause('gallery-upload-unverified', { count: state.image.readyCount });
      galleryUploaded++;
    }

    checkpoint('sales');
    const variant = input.variant;
    const allowedOptions = new Set(variants.map(item => item.option));
    const hasVariant = current => Boolean(current.fields.variantName || current.variant.options.length || current.variant.rows.length);
    const otherVariant = current => Boolean(variant && (
      current.variant.options.some(option => !allowedOptions.has(option)) ||
      variant.name !== '规格' && current.fields.variantName?.value && current.fields.variantName.value !== variant.name
    ));
    const resetNeeded = current => hasVariant(current) && (!variant || otherVariant(current));
    function assertVariation() {
      if (!resetNeeded(state)) return;
      if (!variant) throw new Pause('variants-already-enabled');
      throw new Pause('different-variant', {
        actual: [state.fields.variantName?.value, ...state.variant.options].filter(Boolean),
        expected: [variant.name, ...allowedOptions],
      });
    }
    async function clearCarriedVariant() {
      for (let attempt = 0; attempt < 2 && freshForm && resetNeeded(state); attempt++) {
        if (!state.variant.reset) await readUntil(current => !resetNeeded(current) || Boolean(current.variant.reset), 3500);
        if (!resetNeeded(state) || !state.variant.reset) return;
        try {
          await native('flow_control_click', {
            action: 'variant-reset', selector: state.variant.reset, category, label: '清除新表单预带规格',
            value: input.title, variantName: state.fields.variantName?.value ?? '', variantOptions: state.variant.options,
          });
        } catch (error) {
          if (!movedControl.has(error.code)) throw error;
          await read();
          continue;
        }
        uploadedOptions.clear();
        await readUntil(current => !hasVariant(current) &&
          Boolean(variant ? current.variant.enable : current.fields.price), 4500);
      }
    }
    async function openVariationEditor() {
      if (!state.fields.variantName && !state.variant.enable) {
        await readUntil(current => Boolean(current.fields.variantName || current.variant.enable), 3500);
      }
      if (state.variant.enable && !hasVariant(state)) {
        await native('flow_control_click', {
          action: 'variant-enable', selector: state.variant.enable, category, label: '开启商品规格', text: '开启商品规格',
        });
        await readUntil((current) => Boolean(current.fields.variantName), 3500);
      }
    }
    async function fillSales() {
      await read();
      // The default can appear after the initial category render. Remember it before changing SKU rows.
      rememberShippingDefault();
      await clearCarriedVariant();
      if (!variant) {
        assertVariation();
        await fillNamedField('price', input.price, freshForm);
        await fillNamedField('quantity', input.quantity, freshForm);
        return;
      }
      await openVariationEditor();
      // Opening the editor can restore options after the initial sales section was read.
      if (freshForm && otherVariant(state)) {
        await clearCarriedVariant();
        await openVariationEditor();
      }
      // A category can start with an empty, predefined variation axis. A generic
      // one-axis import can use that label without changing any of its option values.
      const name = variant.name === '规格' && state.variant.options.every(option => allowedOptions.has(option)) && state.fields.variantName?.value
        ? state.fields.variantName.value : variant.name;
      assertVariation();
      if (state.fields.variantName?.value !== name) {
        if (!state.fields.variantName?.selector) throw new Pause('variant-control-changed', { kind: 'name' });
        await native('flow_variant_write', {
          kind: 'name', selector: state.fields.variantName.selector, category, name, existingOptions: state.variant.options,
        });
        await readUntil(current => resetNeeded(current) || current.fields.variantName?.value === name);
        assertVariation();
        if (state.fields.variantName?.value !== name) throw new Pause('variant-name-readback', { name });
      }
      for (const { option } of variants) {
        if (state.variant.options.includes(option)) continue;
        if (!state.fields.variantOption?.selector) {
          await readUntil(current => resetNeeded(current) || current.variant.options.includes(option) ||
            Boolean(current.fields.variantOption?.selector), 2600);
          assertVariation();
          if (state.variant.options.includes(option)) continue;
        }
        if (!state.fields.variantOption?.selector) throw new Pause('variant-control-changed', { kind: 'option', option });
        await native('flow_variant_write', {
          kind: 'option', selector: state.fields.variantOption.selector, category, name, option,
          existingOptions: state.variant.options,
        });
        await readUntil(current => resetNeeded(current) || Boolean(rowFor(option, current)), 3500);
        assertVariation();
        if (!rowFor(option)) throw new Pause('sku-row-not-unique', { option });
      }
      if (state.variant.rows.length !== variants.length || variants.some(({ option }) => !rowFor(option))) {
        throw new Pause('sku-row-not-unique');
      }
      for (const item of variants) {
        const { option } = item;
        await fillSkuRow(item, freshForm);
        assertVariation();
        if (!item.imagePath) continue;
        const image = rowFor(option).image;
        if (image?.present) {
          if (!item.retainExistingImage && !uploadedOptions.has(option)) throw new Pause('sku-image-already-present', { option });
          continue;
        }
        if (!image?.selector) throw new Pause('sku-image-control-missing', { option });
        await unique(image.selector, 'input');
        await native('upload_file', { selector: image.selector, paths: [item.imagePath] });
        const imageReady = current => resetNeeded(current) || Boolean(rowFor(option, current)?.image?.present);
        await readUntil(imageReady, imageReadbackMs - 10000, imagePollMs);
        assertVariation();
        if (!rowFor(option)?.image?.present && rowFor(option)?.image?.pending) {
          if (freshForm) await read(true);
          await readUntil(imageReady, 10000, imagePollMs);
          assertVariation();
        }
        if (!rowFor(option)?.image?.present) throw new Pause('sku-image-readback', { option });
        uploadedOptions.add(option);
      }
    }

    const shipping = namedShippingFields.filter((key) => input[key] != null);
    function verifySalesAndShipping() {
      assertVariation();
      for (const key of shipping) expected(key, input[key], matchedNumber);
      if (input.sku != null) expected('sku', input.sku);
      if (!variant) {
        expected('price', input.price, matchedNumber);
        expected('quantity', input.quantity, matchedNumber);
      }
      if (state.variant.rows.length !== variants.length) throw new Pause('sku-row-not-unique');
      skuRows = variants.map(item => {
        const row = rowFor(item.option);
        if (!rowMatches(row, item)) throw skuReadbackError(row, item);
        const { option, price, quantity, sku } = row;
        if (!item.imagePath) return { option, price, quantity, sku };
        if (!row.image?.present) throw new Pause('sku-image-readback', { option });
        return { option, price, quantity, sku, imageVerified: true, imageUploaded: uploadedOptions.has(option) };
      });
    }
    async function fillRequiredField({ section, key, option }) {
      if (section === 'category-attributes' && attributeTargets.has(key)) {
        const field = currentAttribute(key);
        // Preserve a selection already made on the page, including a label with a transient error marker.
        if (present(field.value)) return;
        await setAttribute(key, attributeTargets.get(key), { preserve: true });
        return;
      }
      if (section === 'sales' && option != null && salesKeys.includes(key)) {
        const wanted = variants.find(item => item.option === option);
        const row = rowFor(option);
        if (wanted && row && (!row.sku || row.sku === wanted.sku)) await fillSkuRow(wanted, true, [key]);
        return;
      }
      const desired = input[key] ?? (key === 'shipDays' ? observedShipDays : undefined);
      const numeric = section === 'shipping' && namedShippingFields.includes(key) ||
        section === 'sales' && !variant && (key === 'price' || key === 'quantity');
      const text = section === 'basic' && key === 'description' || section === 'sales' && key === 'sku';
      if (option != null || !numeric && !text || desired == null) return;
      if (numeric && matchedNumber(state.fields[key]?.value, desired) || text && present(state.fields[key]?.value)) return;
      await fillNamedField(key, desired, true);
    }
    async function repairRequiredFields({ submission = false } = {}) {
      repairingRequired = true;
      recoveringSubmission = submission;
      try {
        await read();
        if (!state.categoryReady) return false;
        assertVariation();
        const targets = new Set(requiredIssues(state).map(issueIdentity));
        if (!targets.size) return !state.missingRequired && !state.validation?.some(message => !isValidationSummary(message));
        for (const target of targets) {
          const current = requiredIssues(state).find(issue => issueIdentity(issue) === target);
          if (!current) continue;
          try { await fillRequiredField(current); }
          catch (error) {
            if (current.section === 'category-attributes') await deferAttribute(current.key, error);
            else if (!movedControl.has(error.code) && !['readback-mismatch', 'sku-control-missing', 'sku-readback'].includes(error.code)) throw error;
          }
          await read();
          assertVariation();
        }
        // Give inline validation time to clear after a corrected field commits.
        const clear = current => !requiredIssues(current).length && !current.missingRequired &&
          !current.validation?.some(message => !isValidationSummary(message));
        if (!clear(state)) await readUntil(clear, 1600);
        return clear(state);
      } finally {
        recoveringSubmission = false;
        repairingRequired = false;
      }
    }
    async function fillShipping() {
      for (const key of shipping) {
        if (matchedNumber(state.fields[key]?.value, input[key])) continue;
        await fillNamedField(key, input[key], freshForm);
        // Re-rendering a shipping field can move the next control.
        if (freshForm) await read();
      }
      if (input.sku != null) await fillNamedField('sku', input.sku);
      await read();
      assertVariation();
      if (!variant && freshForm) {
        for (const key of ['price', 'quantity']) {
          if (matchedNumber(state.fields[key]?.value, input[key])) continue;
          await fillNamedField(key, input[key], true);
          await readUntil(current => resetNeeded(current) || matchedNumber(current.fields[key]?.value, input[key]));
          assertVariation();
        }
      }
    }
    const retryableVariation = new Set(['different-variant', 'variants-already-enabled', 'variant-control-changed']);
    const retryableValues = new Set(['sku-control-missing', 'sku-row-not-unique', 'sku-readback', 'field-missing', 'readback-mismatch']);
    const completedBeforeSales = completed.length;
    let requiredRepairTried = false;
    async function repairRequiredOnce() {
      if (!freshForm || requiredRepairTried || !requiredIssues(state).length) return;
      requiredRepairTried = true;
      await repairRequiredFields();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await fillSales();
        checkpoint('shipping');
        await fillShipping();
        await repairRequiredOnce();
        verifySalesAndShipping();
        if (sizeChart) {
          checkpoint('size-chart');
          sizeChartReceipt = await replaySizeChart({
            chart: sizeChart, category, title: input.title, allowInference: input.completeMissingSizeChart === true, native, pause,
          });
        }
        await read(false, true);
        assertVariation();
        if (state.missingRequired > 0 && !requiredIssues(state).length) await read(true, true);
        await repairRequiredOnce();
        if (state.missingRequired > 0 && !requiredIssues(state).length) {
          await readUntil(current => resetNeeded(current) || !current.missingRequired, 2500);
        }
        verifySalesAndShipping();
        break;
      } catch (error) {
        // SKU and shipping values can disappear even when the same option labels remain.
        if (attempt || !freshForm || !state.categoryReady ||
            !(retryableValues.has(error.code) || resetNeeded(state) && retryableVariation.has(error.code))) throw error;
        expected('title', input.title);
        if (input.sku != null && state.fields.sku?.value) expected('sku', input.sku);
        completed.length = completedBeforeSales;
        skuRows = undefined;
        step = 'sales';
      }
    }
    if (input.imagePath && (!state.image.coverReady || state.image.readyCount !== state.image.count ||
        (coverUploaded && !photosReady(state, gallery.length + 1)))) {
      throw new Pause('gallery-upload-unverified', { count: state.image.readyCount });
    }
    completed.push(step);
    const receipt = { completed, category, coverUploaded, ...(galleryUploaded && { galleryUploaded }), skuRows,
      ...(sizeChartReceipt ? { sizeChart: sizeChartReceipt } : {}),
      elapsedMs: Date.now() - began };
    if (requiredIssues(state).length) {
      const issues = requiredIssues(state);
      const { section, key, label, option, kind } = issues[0];
      return { ...receipt, status: 'needs-review', step: section,
        code: kind === 'invalid' ? 'page-validation' : 'required-fields-remain',
        details: { ...(section === 'category-attributes' ? { label } : { key }), ...(option != null && { option }), issues } };
    }
    const attributeIssues = new Map(state.attributes.filter(field => field.required && !present(field.value))
      .map(field => [field.label, { label: field.label, code: 'required-attribute-missing' }]));
    for (const [label, choice] of attributeTargets) {
      const matches = state.attributes.filter(field => field.label === label);
      if (!attributeIssues.has(label) && (matches.length !== 1 || !equalValue(matches[0], choice))) {
        attributeIssues.set(label, { label, code: attributeFailures.get(label)?.code ?? 'attribute-readback' });
      }
    }
    // A form that passed all readbacks can proceed to the submitter's same-document check of an isolated summary.
    if (attributeIssues.size || state.validation?.length && !(freshForm && onlyValidationSummary(state))) {
      const issues = [...attributeIssues.values()];
      const first = issues[0];
      const pendingLabels = issues.slice(1).map(issue => issue.label).join('、');
      const text = [pendingLabels && `还有 ${pendingLabels} 待核对。`, ...(state.validation ?? [])].filter(Boolean).join('\n');
      return { ...receipt, status: 'needs-review', step: 'category-attributes', code: first?.code ?? 'page-validation',
        details: { label: first?.label, issues, text, validation: state.validation, ...(adviceFailure && { adviceFailure }) } };
    }
    if (state.missingRequired > 0) {
      return { ...receipt, status: 'needs-review', code: 'required-fields-remain',
        details: { text: `Shopee 提示仍有 ${state.missingRequired} 个必填字段为空。` } };
    }
    if (freshForm && registerRecovery) {
      let used = false;
      registerRecovery(async ({ tabId: requestedTabId, binding } = {}) => {
        if (used || requestedTabId !== tabId || binding?.url !== originalUrl) return false;
        used = true;
        return repairRequiredFields({ submission: true });
      });
    }
    return { ...receipt, status: 'verified' };
  } catch (error) {
    return {
      status: signal?.aborted ? 'cancelled' : 'needs-review', step, completed,
      code: signal?.aborted ? 'cancelled' : error.code || 'tool-error',
      details: error.details ?? error.message, elapsedMs: Date.now() - began,
      ...(requiredIssues(state).length && { requiredIssues: requiredIssues(state) }),
      ...(skuRows ? { category, coverUploaded, skuRows } : {}),
      ...(sizeChartReceipt ? { sizeChart: sizeChartReceipt } : {}),
    };
  }
}

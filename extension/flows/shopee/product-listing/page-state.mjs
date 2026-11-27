// Injected by PageLens. Keep this function self-contained and read-only.
export function readPage(category) {
  const clean = value => String(value ?? '').trim().replace(/\s+/gu, ' ');
  const pathText = value => clean(value).replace(/\s*[＞>›»]\s*/gu, ' > ');
  const ownText = node => [...node.childNodes].filter(child => child.nodeType === 3)
    .map(child => child.nodeValue).join(' ');
  const styles = new Map();
  const styleOf = node => {
    if (!styles.has(node)) styles.set(node, getComputedStyle(node));
    return styles.get(node);
  };
  const visible = node => node.getClientRects().length && styleOf(node).visibility === 'visible' &&
    !node.closest('[aria-hidden=true],[inert]');
  const all = (q, root = document) => [...(root?.querySelectorAll(q) ?? [])];
  const shown = (q, root) => all(q, root).filter(visible);
  const only = items => items.length === 1 ? items[0] : null;
  const one = (q, root) => only(shown(q, root));
  function value(node) {
    if (!node) return null;
    if (node.matches('input[type=checkbox],input[type=radio]') && !node.checked) return '';
    return String(node.value ?? node.textContent);
  }

  const out = {
    url: location.href, modal: null, validation: [], unscopedValidation: [], category: null, recommendation: null, recommendations: [],
    categoryRecommendations: [], categoryPickerAvailable: false,
    categoryReady: false, fields: {}, attributes: [], options: [], optionSearch: null, requiredIssues: [],
    image: { count: null, cover: false, selector: null },
    variant: { enable: null, options: [], rows: [] },
  };
  if (location.origin !== 'https://seller.shopee.cn' || location.pathname !== '/portal/mtsku/new') return out;

  const panels = ['.product-basic-info', '.product-specification-new', '.product-sales-info', '.mtsku-product-shipping'];
  function selectorOf(node) {
    if (!node) return null;
    const steps = [];
    for (let el = node; el && el !== document.body; el = el.parentElement) {
      const anchor = panels.find(selector => el.matches(selector) && only(all(selector)) === el);
      if (anchor) return [anchor, ...steps].join(' > ');
      const index = Array.from(el.parentElement.children).indexOf(el) + 1;
      steps.unshift(el.localName + ':nth-child(' + index + ')');
    }
    return ['body', ...steps].join(' > ');
  }

  const basic = one(panels[0]), sales = one(panels[2]);
  const labelText = node => clean(node.querySelector('.item-title-text')?.textContent ||
    all(':scope > span', node).find(span => !/^[*＊]$/u.test(clean(span.textContent)))?.textContent ||
    clean(ownText(node)) || node.textContent).replace(/^[*＊]\s*|\s*\d+\/\d+$/gu, '');
  const labelNode = row => row?.querySelector(':scope > .edit-label');
  const rowsWithLabels = root => shown('.edit-row', root).filter(row => labelNode(row));
  const labels = {
    商品名称: 'title', 商品描述: 'description', 全球商品价格: 'price', 商品数量: 'quantity',
    重量: 'weight', 发货时间: 'shipDays', 全球商品货号: 'sku',
  };
  const edits = ':is(input:not([type=file],[type=checkbox],[type=radio]),textarea,[contenteditable=true]):not([disabled],[readonly])';
  const fields = new Map();
  function add(key, node) {
    if (node) fields.set(key, fields.has(key) ? null : node);
  }
  for (const row of rowsWithLabels(document)) {
    if (row.closest(panels[1])) continue;
    const label = labelText(labelNode(row));
    const controls = shown(edits, row).filter(el => el.closest('.edit-row') === row &&
      !el.closest('.eds-popper,.eds-modal,.batch-edit-row,.variation-model-table'));
    if (Object.hasOwn(labels, label)) add(labels[label], only(controls));
    if (label === '包裹尺寸大小') {
      const dims = { 宽: 'width', 长: 'length', 高: 'height' };
      for (const el of controls) {
        const key = dims[el.getAttribute('placeholder')?.[0]];
        if (key) add(key, el);
      }
    }
  }

  const nameFields = shown('.variation-name-panel input', sales);
  const optionFields = shown('.variation-option-panel .options-item input', sales);
  const options = optionFields.map(el => clean(value(el))).filter(Boolean);
  add('variantName', only(nameFields));
  const blankOptions = optionFields.filter(el => value(el) === '');
  add('variantOption', !options.length && only(blankOptions.filter(el => el.closest('.drag-item') &&
    !el.closest('.virtual-options-item'))) || only(blankOptions.filter(el => el.closest('.virtual-options-item'))));
  const salesAndShippingControls = new Set();
  for (const [key, node] of fields) {
    if (!node) continue;
    out.fields[key] = { selector: selectorOf(node), value: value(node) };
    if (['price', 'quantity', 'weight', 'width', 'length', 'height', 'shipDays', 'sku'].includes(key)) {
      const row = node.closest('.edit-row');
      if (row) salesAndShippingControls.add(row);
    }
  }

  const categoryNode = one('.product-category-text', basic);
  const selected = pathText(categoryNode?.textContent).replace(/^(?:Please set category|请选择(?:商品)?类[别目])$/iu, '');
  out.category = selected || null;
  const wanted = pathText(category);
  if (!out.category && categoryNode) {
    const row = categoryNode.closest('.edit-row');
    out.categoryPickerAvailable = Boolean(one('.product-category-box-inner', row));
    const radios = shown('.recommend-category-container .category-select-radio', row)
      .filter(el => el.querySelector(':scope > .radio-indicator') && el.querySelector(':scope > .radio-text'));
    const fallbackRadios = shown('label,[role=radio]', row)
      .filter(node => node.matches('[role=radio]') || node.control?.matches('input[type=radio]') || node.querySelector('input[type=radio]'));
    const candidates = (radios.length ? radios : fallbackRadios)
      .filter(node => !node.closest('[disabled],[aria-disabled=true],[inert]') && !node.querySelector('input[type=radio]:disabled'))
      .map(el => ({ el, text: pathText(el.textContent) }))
      .filter(({ text }) => text.length <= 220 && text.includes(' > ') && text.split(' > ').every(Boolean));
    const items = candidates.filter(({ el, text }) => !candidates.some(other =>
      other.el !== el && el.contains(other.el) && (other.text === text || text.includes(other.text))));
    out.recommendations = [...new Set(items.map(({ text }) => text))].slice(0, 20);
    out.categoryRecommendations = out.recommendations.flatMap(path => {
      const exact = only(items.filter(({ text }) => text === path));
      return exact ? [{ path, selector: selectorOf(exact.el) }] : [];
    });
    const match = only(items.filter(({ text }) => text === wanted));
    out.recommendation = selectorOf(match?.el);
  }

  const opened = [];
  const attributeRows = new Set();
  const inspectedRows = new Set();
  const validationMarker = '[aria-invalid=true],.eds-form-item__error,.eds-input__error,.eds-message--error,[role=alert]';
  const errorClass = '[aria-invalid=true],.eds-form-item--error,.eds-input--error,.eds-selector--error';
  const requiredMarker = '[required],[aria-required=true]';
  const entryControls = '.eds-selector,select,input,textarea,[contenteditable=true]';
  const inactive = '[disabled],[readonly],[aria-disabled=true],.eds-selector--disabled';
  const numericLabels = {
    price: '全球商品价格', quantity: '商品数量', weight: '重量', shipDays: '发货时间',
    width: '包裹宽度', length: '包裹长度', height: '包裹高度',
  };
  const validationText = el => clean(el.textContent || el.getAttribute('aria-label') ||
    labelNode(el.closest('.edit-row'))?.textContent);
  const red = color => {
    const [r = 0, g = r, b = r, opacity = 1] = color?.match(/\d+(?:\.\d+)?/gu)?.map(Number) ?? [];
    return opacity > 0 && r >= 150 && r > g + 65 && r > b + 65;
  };
  function labelStar(label) {
    if (!label || !visible(label)) return false;
    if (shown('.mandatory,.required-star,.eds-form-item__required', label).length || /^\s*[＊*]/u.test(ownText(label))) return true;
    if (shown('span,i,sup', label).some(node => /^[＊*]$/u.test(clean(node.textContent)) &&
        red(styleOf(node).color))) return true;
    if (typeof globalThis.CSS?.supports !== 'function') return false;
    const isRedStar = (node, pseudo) => {
      const { content, display, visibility, color } = getComputedStyle(node, pseudo);
      return display !== 'none' && visibility === 'visible' && /^['"]?[＊*]['"]?$/u.test(content) && red(color);
    };
    const title = one('.item-title-text', label);
    return (title ? [label, title] : [label]).some(node =>
      isRedStar(node, '::before') || isRedStar(node, '::after'));
  }
  const controlsIn = row => all(entryControls, row).filter(el => el.closest('.edit-row') === row &&
    !el.closest('.eds-popper,.eds-modal') && !el.parentElement.closest('.eds-selector,select') &&
    !el.matches('input[type=hidden]'));
  const activeControl = el => visible(el) && !el.closest(inactive);
  const markedRequired = (scope, control, label = labelNode(scope)) =>
    Boolean(labelStar(label) || scope?.matches(requiredMarker) || control?.matches(requiredMarker));
  const filled = raw => Array.isArray(raw) ? raw.some(filled) : raw === true ||
    Boolean(raw !== false && clean(raw).replace(/^(?:请选择|Please (?:select|choose))$/iu, ''));
  const errorWording = /(?:请(?:输入|填写|选择|上传).+|必填|不可空白|不能为?空|不得为空|超出范围|out of range|required field|is required|please (?:enter|select|upload).+|invalid)/iu;
  function validationFor(scope, control) {
    if (!scope) return {};
    const scopeSelector = '.edit-row,.table-cell,.first-variation-cell';
    const ownScope = scope.closest(scopeSelector);
    const inScope = el => !el.closest('.eds-popper,.eds-modal') && el.closest(scopeSelector) === ownScope;
    const markers = shown(validationMarker, scope).filter(inScope);
    const linked = clean(control?.getAttribute('aria-errormessage')).split(/\s+/u)
      .map(id => document.getElementById(id)).filter(el => el && visible(el) && !el.closest('.eds-popper,.eds-modal'));
    const messages = [...new Set([...markers.filter(el => !el.matches('[aria-invalid=true]') &&
      (!el.matches('[role=alert]') || errorWording.test(el.textContent) || red(styleOf(el).color))), ...linked]
      .map(el => clean(el.textContent || el.getAttribute('aria-label'))).filter(Boolean))];
    // Some Seller Centre errors have neither ARIA nor error classes.
    if (!messages.length) {
      const redMessage = shown('p,small,span,div', scope).find(el => {
        const localText = clean(ownText(el));
        return el !== control && !labelNode(scope)?.contains(el) && inScope(el) &&
          errorWording.test(localText) &&
          red(styleOf(el).color);
      });
      if (redMessage) messages.push(clean(ownText(redMessage)));
    }
    for (let node = control; node && scope.contains(node); node = node.parentElement) {
      if (node.matches(errorClass)) return { invalid: true, message: messages.join(' · ').slice(0, 220) };
      // An ordinary focused input can use Shopee's orange border. Read color on
      // an unfocused control or its immediate wrappers, never the whole panel.
      if (node !== scope && !node.contains(document.activeElement)) {
        const style = styleOf(node);
        if (['Top', 'Right', 'Bottom', 'Left'].some(side => red(style['border' + side + 'Color']) &&
            !['none', 'hidden'].includes(style['border' + side + 'Style']) &&
            Number.parseFloat(style['border' + side + 'Width']) > 0)) {
          return { invalid: true, message: messages.join(' · ').slice(0, 220) };
        }
      }
    }
    return { invalid: Boolean(messages.length) || markers.some(el => el.matches(errorClass)),
      message: messages.join(' · ').slice(0, 220) };
  }
  function inspect({ section, key, label, option, scope, control, raw, required, validation = validationFor(scope, control) }) {
    if (!label || control?.closest(inactive)) return;
    const missing = !filled(raw);
    const nativeInvalid = !missing && control?.willValidate && !control.validity.valid;
    const days = key === 'shipDays' && scope?.textContent.match(/可以填写\s*(\d+)\s*[,，、]\s*(\d+)\s*(?:到|至|[-–])\s*(\d+)/u);
    const amount = typeof raw === 'string' && /^-?\d+(?:\.\d+)?$/u.test(clean(raw)) ? Number(raw) : NaN;
    const invalidAmount = !missing && (days && (amount !== Number(days[1]) &&
      (!Number.isInteger(amount) || amount < Number(days[2]) || amount > Number(days[3]))) ||
      ['price', 'weight', 'shipDays'].includes(key) && amount <= 0);
    if (!(required && missing || validation.invalid || nativeInvalid || invalidAmount)) return;
    const message = validation.message || (nativeInvalid ? clean(control.validationMessage) : '');
    out.requiredIssues.push({ section, key, label, ...(option != null && { option }),
      kind: missing ? 'missing' : 'invalid', ...(message && { message }), value: raw });
  }
  for (const row of all('.edit-row', one(panels[1]))) {
    const label = labelNode(row);
    if (!label || !visible(row)) continue;
    const controls = controlsIn(row);
    const control = only(controls.filter(activeControl));
    const required = markedRequired(row, control, label) || controls.some(el => el.matches(requiredMarker));
    if (!control && !required) continue;
    attributeRows.add(row);
    const controlLabel = labelText(label);
    const selection = control?.querySelector('.eds-selector__inner,.scroll-selector-content') ?? control;
    const customSelect = control?.matches('.eds-selector');
    const nativeSelect = control?.matches('select');
    const multiple = control?.matches('select[multiple],[aria-multiselectable=true],.eds-selector--multiple') ||
      Boolean(control?.closest('.eds-select--multiple,[aria-multiselectable=true]'));
    const explicitTokens = selection ? shown('.eds-tag__text,.eds-tag__content,[data-selected-value]', selection) : [];
    const tokens = [...new Set(explicitTokens.map(node => clean(node.getAttribute('data-selected-value') || node.textContent)).filter(Boolean))];
    const type = customSelect || nativeSelect ? 'select'
      : control?.matches('input[type=file]') ? 'upload'
        : control?.matches('input[type=checkbox]') ? 'checkbox'
          : control?.matches('input[type=number]') ? 'number'
            : control?.matches('input[type=text],input:not([type]),textarea,[contenteditable=true]') ? 'text' : 'unsupported';
    if (customSelect && (control.getAttribute('aria-expanded') === 'true' || control.closest('.eds-select.is-show'))) {
      opened.push(controlLabel);
    }
    const validation = validationFor(row, control);
    const error = validation.message || (validation.invalid ? '当前商品属性显示校验错误' : '');
    const scalar = selection?.matches('.placeholder') ? '' : clean(value(selection)).replace(/^请选择$/u, '');
    const nativeOptions = nativeSelect ? [...control.options].filter(option => option.value && !option.disabled &&
      !option.closest('optgroup[disabled]')).map(option => clean(option.label)).filter(Boolean) : undefined;
    const selectedValues = nativeSelect ? [...control.selectedOptions].filter(option => option.value).map(option => clean(option.label)) : tokens;
    const unknownMultipleSelection = customSelect && multiple && scalar && !tokens.length;
    const raw = type === 'checkbox' ? control.checked : unknownMultipleSelection ? scalar
      : multiple ? selectedValues : nativeSelect ? selectedValues[0] || '' : scalar;
    out.attributes.push({ key: controlLabel, label: controlLabel, required, selector: selectorOf(control), error,
      type: unknownMultipleSelection ? 'unsupported' : type,
      ...(multiple && { multiple: true }), ...(nativeOptions && { nativeOptions }),
      ...(type === 'number' && control.min !== '' && { min: Number(control.min) }),
      ...(type === 'number' && control.max !== '' && { max: Number(control.max) }),
      ...(type === 'text' && control.maxLength > 0 && { maxLength: control.maxLength }),
      value: raw });
    if (control) inspect({ section: 'category-attributes', key: controlLabel, label: controlLabel, scope: row,
      control, raw, required, validation });
  }
  for (const [key, control] of fields) {
    const row = control?.closest('.edit-row');
    if (!row || key === 'variantOption' || key === 'variantName') continue;
    const section = control.closest(panels[3]) ? 'shipping' : control.closest(panels[2]) ? 'sales' : 'basic';
    const label = numericLabels[key] ?? labelText(labelNode(row));
    const scope = ['width', 'length', 'height'].includes(key) ? control.closest('.eds-input') ?? control : row;
    inspectedRows.add(row);
    inspect({ section, key, label, scope, control, raw: value(control), required: markedRequired(row, control) });
  }
  if (categoryNode) {
    const row = categoryNode.closest('.edit-row');
    const control = categoryNode.closest('.product-category-box-inner') ?? categoryNode;
    if (row) inspectedRows.add(row);
    inspect({ section: 'basic', key: 'category', label: '商品类目', scope: row, control,
      raw: out.category, required: markedRequired(row, control) });
  }
  out.categoryReady = Boolean(out.category && (!wanted || out.category === wanted) &&
    (out.attributes.some(attribute => attribute.selector) || out.fields.price || out.fields.variantName));

  const menu = only(shown('.eds-select-popover-content:not(.slide-fast-leave-active)')
    .filter(el => el.getClientRects().length && el.querySelector('.eds-option,[role=option],input:not([type=hidden])')));
  if (menu) {
    const active = shown(':is(.eds-option,[role=option]):not([aria-disabled=true],.eds-option--disabled,.is-disabled)', menu);
    out.options = active.slice(0, 100).map(el => ({ text: clean(el.textContent), selector: selectorOf(el) }));
    out.optionSearch = selectorOf(one('input:not([type=hidden],[disabled],[readonly])', menu));
    out.optionOwner = only(opened);
  }

  const media = one('.shopee-image-manager', basic);
  if (media) {
    const upload = '.product-basic-info .shopee-image-manager__upload input[type=file][accept="image/*"]';
    const count = media.querySelector('.shopee-image-manager__upload__content__text')?.textContent
      .match(/\((\d+)\s*\/\s*\d+\)/u)?.[1];
    const ready = shown('.shopee-image-manager__itembox .shopee-image-manager__image', media).filter(img =>
      img.complete && img.naturalWidth > 0 && /^https?:\/\//iu.test(img.currentSrc || img.src) &&
      !img.closest('.ignore-item,.eds-modal'));
    const control = only(all(upload).filter(el => !el.disabled));
    out.image = {
      count: count == null ? null : Number(count),
      cover: /封面/u.test(media.innerText ?? media.textContent),
      readyCount: ready.length,
      coverReady: ready.some(img => /封面/u.test(img.closest('.shopee-image-manager__itembox')?.textContent)),
      selector: selectorOf(control),
    };
    const row = media.closest('.edit-row');
    if (row) inspectedRows.add(row);
    inspect({ section: 'image', key: 'image', label: '商品图片', scope: row ?? media, control: media,
      raw: out.image.coverReady, required: markedRequired(row ?? media, control) });
  }
  const remainingSections = [[basic, 'basic'], [sales, 'sales'], [one(panels[3]), 'shipping']];
  for (const [panel, section] of remainingSections) {
    for (const row of rowsWithLabels(panel).filter(node => !inspectedRows.has(node))) {
      const control = only(controlsIn(row).filter(activeControl));
      if (!control) continue;
      const label = labelText(labelNode(row));
      const selected = control.matches('.eds-selector')
        ? control.querySelector('.eds-selector__inner,.scroll-selector-content') ?? control : control;
      inspect({ section, key: Object.hasOwn(labels, label) ? labels[label] : label, label, scope: row, control,
        raw: value(selected), required: markedRequired(row, control) });
    }
  }

  function button(q, label) {
    const node = one(q, sales);
    return clean(node?.textContent) === label ? selectorOf(node) : null;
  }
  out.variant.enable = button('.variation-add-button button.primary-dash-button', '开启商品规格');
  out.variant.reset = selectorOf(only(shown('.variation-edit-item .variation-delete-btn', sales)));
  out.variant.options = options;
  const leftBody = one('.variation-model-table-fixed-left .variation-model-table-body', sales);
  const middleBody = one('.variation-model-table-middle-scroll .variation-model-table-body', sales);
  const firstCells = shown('.first-variation-cell', leftBody);
  const price = '.table-cell .model-edit-input .price-input input';
  const groups = shown('.data-group', middleBody).filter(group => group.querySelector(price));
  const choices = firstCells.map(el => clean(ownText(el)));
  const skuLabels = { price: numericLabels.price, quantity: numericLabels.quantity, sku: '规格货号', image: '规格图片' };
  const skuHeaders = shown('th,[role=columnheader],.variation-model-table-header .table-cell,.variation-model-table-head .table-cell', sales);
  const skuLabel = key => only(skuHeaders.filter(head => labelText(head) === skuLabels[key]));
  // Shopee renders variation labels/images in a fixed table and the editable
  // columns in a separate scrollable table. Confirm they describe the same rows.
  if (nameFields.length === 1 && groups.length === choices.length && choices.length === options.length &&
      choices.every((option, index) => option === options[index])) {
    out.variant.rows = groups.map((group, index) => {
      const fields = {
        price: one(price, group),
        quantity: one('.table-cell.stock-column input', group),
        sku: one('.table-cell .sku-textarea textarea', group),
      };
      for (const [key, control] of Object.entries(fields)) {
        const cell = control?.closest('.table-cell');
        if (!cell) continue;
        salesAndShippingControls.add(cell);
        inspect({ section: 'sales', key, label: skuLabels[key], option: choices[index], scope: cell, control,
          raw: value(control), required: markedRequired(cell, control, skuLabel(key)) });
      }
      const images = one('.shopee-image-manager', firstCells[index]);
      const uploads = all('.shopee-image-manager__upload input[type=file][accept="image/*"]', images)
        .filter(el => !el.disabled);
      const previews = shown('.shopee-image-manager__itembox img', images).filter(img =>
        !img.closest('.shopee-image-manager__upload,.eds-modal,.image-cropper-modal'));
      const thumbnails = previews.filter(img => !/^data:image\/gif[;,]/iu.test(img.currentSrc || img.src));
      const present = thumbnails.some(img => img.complete && img.naturalWidth > 0);
      const pending = !present && (thumbnails.some(img => !img.complete || img.loading === 'lazy') ||
        previews.some(img => img.getAttribute('src')?.startsWith('blob:')) ||
        shown('.shopee-image-manager__itembox [aria-busy=true],.eds-loading', images).length > 0);
      if (images) inspect({ section: 'sales', key: 'image', label: skuLabels.image, option: choices[index],
        scope: firstCells[index], control: images, raw: present,
        required: markedRequired(images, only(uploads), skuLabel('image')) });
      return {
        option: choices[index],
        price: value(fields.price),
        quantity: value(fields.quantity),
        sku: value(fields.sku),
        selectors: Object.fromEntries(Object.entries(fields).map(([key, el]) => [key, selectorOf(el)])),
        image: { selector: selectorOf(only(uploads)), present, pending },
      };
    });
  }

  const modal = shown('.eds-modal__mask,[role=dialog],[aria-modal=true],dialog[open]').at(-1) ??
    shown('.eds-popper:has(.pulse-popover-button)').at(-1);
  if (modal) out.modal = { text: clean(modal.innerText ?? modal.textContent).slice(0, 200) || '页面弹窗' };
  out.missingRequired = Number(document.body.innerText?.match(/仍有\s*(\d+)\s*个必填字段为空/u)?.[1] ?? 0);
  const validationNodes = shown(validationMarker);
  const validation = nodes => [...new Set(nodes.map(validationText).filter(Boolean))].slice(0, 12);
  const unscoped = validationNodes.filter(node => !attributeRows.has(node.closest('.edit-row')));
  out.validation = validation(validationNodes);
  out.unscopedValidation = validation(unscoped);
  out.validationOutsideSalesAndShipping = validation(unscoped.filter(node =>
    !salesAndShippingControls.has(node.closest('.edit-row,.table-cell'))));
  return out;
}

// The retry is limited to a current, exact recommendation in the shop category row.
export function clickCategoryRecommendation(selector, category, expectedUrl) {
  const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim().replace(/\s*[＞>›»]\s*/gu, ' > ');
  const rejected = error => ({ ok: false, code: 'category-control-changed', error });
  if (location.href !== expectedUrl || location.origin !== 'https://seller.shopee.cn' || location.pathname !== '/portal/mtsku/new') {
    return rejected('页面已离开 Shopee 新增商品表单。');
  }
  const displays = [...document.querySelectorAll('.product-basic-info .product-category-text')]
    .filter(node => node.getClientRects().length);
  const display = displays.length === 1 ? displays[0] : null;
  const row = display?.closest('.edit-row');
  if (!row || !/^(?:Please set category|请选择(?:商品)?类[别目])$/iu.test(clean(display.textContent))) {
    return rejected('类别字段已改变。');
  }
  const matches = [...document.querySelectorAll(selector)];
  const item = matches.length === 1 ? matches[0] : null;
  if (!item || !row.contains(item) || item.closest('.product-category-box') || clean(item.textContent) !== clean(category) ||
      !item.getClientRects().length || getComputedStyle(item).visibility !== 'visible') {
    return rejected('推荐类目的位置或文字已改变。');
  }
  const custom = item.closest('.recommend-category-container .category-select-radio');
  if (custom) {
    const text = custom.querySelector(':scope > .radio-text');
    if (!row.contains(custom) || (custom !== item && !text?.contains(item)) || clean(text?.textContent) !== clean(category) ||
        !custom.querySelector(':scope > .radio-indicator') || custom.closest('[disabled],[aria-disabled=true],[inert]') ||
        !custom.getClientRects().length || getComputedStyle(custom).visibility !== 'visible') {
      return rejected('推荐类目的单选控件不可用。');
    }
    custom.click();
    return { ok: true };
  }
  const label = item.closest('label,[role=radio]');
  if (!label || !row.contains(label) || clean(label.textContent) !== clean(category) ||
      label.closest('[aria-disabled=true],[inert]')) {
    return rejected('推荐类目没有可确认的单选控件。');
  }
  const radio = label.matches('label') ? label.control || label.querySelector('input[type=radio]') : label;
  if (!radio || !row.contains(radio) || !radio.matches('input[type=radio],[role=radio]') || radio.matches(':disabled')) {
    return rejected('推荐类目的单选控件不可用。');
  }
  radio.click();
  return { ok: true };
}

// The category editor is separate from listing submission. Every write is matched
// to the current dialog, category level, and observed selection before clicking.
export function operateShopeeCategory({ action = 'read', query, level, label, expectedPath, category } = {}, expectedUrl) {
  const clean = value => String(value ?? '').trim().replace(/\s+/gu, ' ');
  const split = value => (Array.isArray(value) ? value : clean(value).split(/[＞>›»]/u)).map(clean);
  const visible = node => node.getClientRects().length && getComputedStyle(node).visibility === 'visible' &&
    !node.closest('[hidden],[aria-hidden=true],[inert]');
  const enabled = node => node && visible(node) &&
    !node.closest(':disabled,[aria-disabled=true],.is-disabled,.disabled,.eds-button--disabled');
  const shown = (selector, root = document) => [...root.querySelectorAll(selector)].filter(visible);
  const only = items => items.length === 1 ? items[0] : null;
  const denied = (code, error) => ({ ok: false, code, error });
  if (location.href !== expectedUrl || location.origin !== 'https://seller.shopee.cn' ||
      location.pathname !== '/portal/mtsku/new') return denied('category-page-changed', 'Shopee 商品类目页面已改变。');

  const trigger = only(shown('.product-basic-info .edit-row .product-category-box-inner').filter(node => {
    const field = only(shown('.product-category-text', node)) ?? only(shown('.product-category-placeholder', node));
    return /^(?:Please set category|请选择(?:商品)?类[别目])$/iu.test(clean(field?.textContent));
  }));
  const modal = only(shown('.eds-modal__content').filter(node =>
    only(shown('.eds-modal__title', node).filter(title => /^(?:编辑类目|Edit Category)$/iu.test(clean(title.textContent))))));
  const container = modal?.closest('.eds-modal') ?? modal;
  const unrelated = shown('.eds-modal__mask,[role=dialog],[aria-modal=true],dialog[open],.eds-popper:has(.pulse-popover-button)')
    .some(node => !container || !container.contains(node) && !node.contains(container));
  if (unrelated) return denied('modal', '请先处理当前 Shopee 弹窗。');
  if (!modal) {
    if (action === 'read') return { ok: true, open: false, available: Boolean(enabled(trigger)), selectedPath: [], levels: [] };
    if (action !== 'open' || !enabled(trigger)) return denied('category-picker-not-ready', '没有定位到当前商品的空白类目编辑框。');
    trigger.click();
    return { ok: true };
  }

  const picker = only(shown('.category-selector', modal));
  if (!picker) return denied('category-picker-not-ready', '正在等待 Shopee 类目选项。');
  const search = only(shown('.category-search input[placeholder="请输入至少 1 个字"]', picker));
  const confirm = only(shown('.eds-modal__footer-buttons button', modal).filter(node =>
    /^(?:Confirm|确认|确定)$/iu.test(clean(node.textContent))));
  const levels = shown('.category-list .scroll-item', picker).slice(0, 8).map(column =>
    shown('li.category-item', column).filter(node => node.parentElement === column).slice(0, 200)
      .flatMap(node => {
        const item = only(shown('p.text-overflow', node));
        const label = clean(item?.textContent);
        if (!label || label.length > 110) return [];
        const selected = node.matches('.selected,[aria-selected=true]');
        const leaf = !shown('.category-item-right', node).length;
        return [{ label, selected, leaf, disabled: !enabled(node), node }];
      }));
  const selectedLevels = levels.map(items => items.filter(item => item.selected));
  const selectedItems = selectedLevels.map(only);
  const firstPending = selectedItems.findIndex(item => !item);
  const selectedPath = selectedItems.slice(0, firstPending < 0 ? selectedItems.length : firstPending).map(item => item.label);
  const terminal = selectedItems[selectedPath.length - 1];
  const canConfirm = Boolean(enabled(confirm) && terminal?.selected && !terminal.disabled &&
    levels.slice(selectedPath.length).every(items => !items.length));
  if (action === 'read') {
    return { ok: true, open: true, available: true, selectedPath, canConfirm,
      query: search?.value ?? null, noResults: !levels.some(items => items.length) && /当前搜索暂无结果/u.test(picker.textContent),
      levels: levels.map(items => items.map(({ label, selected, leaf, disabled }) => ({ label, selected, leaf, disabled }))) };
  }
  const samePath = parts => Array.isArray(parts) && parts.length === selectedPath.length &&
    parts.every((name, index) => typeof name === 'string' && clean(name) === selectedPath[index]);
  if (action === 'search') {
    if (!samePath(expectedPath) || !enabled(search) || search.readOnly || typeof query !== 'string' ||
        query.length > 80 || /[\u0000-\u001f]/u.test(query) || query !== query.trim()) {
      return denied('category-picker-changed', '类目搜索框或当前类目已变化。');
    }
    if (search.value !== query) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!setter) return denied('category-picker-not-ready', '未能定位类目搜索输入框。');
      setter.call(search, query);
      search.dispatchEvent(new Event('input', { bubbles: true }));
      search.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { ok: true };
  }
  if (action === 'select') {
    if (!samePath(expectedPath) || !Number.isInteger(level) || level < 0 || level > selectedPath.length ||
        typeof label !== 'string' || !label || label !== clean(label)) {
      return denied('category-picker-changed', '当前选择的类目层级已变化。');
    }
    const target = only((levels[level] ?? []).filter(item => item.label === label));
    if (!target || !enabled(target.node)) return denied('category-option-missing', '当前类目层级没有唯一可选的匹配项。');
    if (!target.selected) target.node.click();
    return { ok: true };
  }
  if (action === 'confirm') {
    if ((typeof category !== 'string' && !Array.isArray(category)) || !selectedPath.length || !canConfirm || !samePath(split(category))) {
      return denied('category-not-ready', 'Shopee 类目路径或最终选择尚未核对。');
    }
    confirm.click();
    return { ok: true };
  }
  return denied('category-operation-not-allowed', '当前操作不属于 Shopee 类目选择。');
}

// These specific Shopee controls can be operated in either foreground or background tabs.
export function clickListingControl({ action, selector, category, label, text, value, variantName, variantOptions }, expectedUrl) {
  const clean = value => String(value ?? '').trim().replace(/\s+/gu, ' ');
  const pathText = value => clean(value).replace(/\s*[＞>›»]\s*/gu, ' > ');
  const visible = node => node.getClientRects().length && getComputedStyle(node).visibility === 'visible' &&
    !node.closest('[aria-hidden=true],[inert]');
  const shown = query => [...document.querySelectorAll(query)].filter(visible);
  const only = items => items.length === 1 ? items[0] : null;
  const denied = () => ({ ok: false, code: 'control-changed', error: 'Shopee 商品表单的目标控件已变化。' });
  if (location.href !== expectedUrl || location.origin !== 'https://seller.shopee.cn' ||
      location.pathname !== '/portal/mtsku/new' || !category || !label ||
      typeof selector !== 'string' || !selector || selector.length > 2048) return denied();
  const categoryField = only(shown('.product-basic-info .product-category-text'));
  if (!categoryField || pathText(categoryField.textContent) !== pathText(category)) return denied();
  if (shown('.eds-modal__mask,[role=dialog],[aria-modal=true],dialog[open],.eds-popper:has(.pulse-popover-button)').length) {
    return { ok: false, code: 'modal', error: '操作前出现了 Shopee 弹窗。' };
  }
  let target;
  try {
    target = only([...document.querySelectorAll(selector)]);
  } catch {
    return denied();
  }
  if (!target || !visible(target) || target.closest('[disabled],[readonly],[aria-disabled=true],.is-disabled,.eds-selector--disabled,.eds-option--disabled')) {
    return denied();
  }

  const attributeLabel = control => {
    const row = control.closest('.product-specification-new .edit-row');
    const node = row?.querySelector(':scope > .edit-label');
    if (!node) return '';
    const ownText = [...node.childNodes].filter(child => child.nodeType === 3).map(child => child.nodeValue).join(' ');
    const title = node.querySelector('.item-title-text') ?? node.querySelector(':scope > span:not(.mandatory)');
    return clean(title?.textContent || clean(ownText) || node.textContent).replace(/^[*＊]\s*|\s*\d+\/\d+$/gu, '');
  };
  const trigger = '.product-specification-new .eds-selector';
  const option = '.eds-option,[role=option]';
  const menu = '.eds-select-popover-content:not(.slide-fast-leave-active)';
  switch (action) {
    case 'attribute-set': {
      const controls = shown('.product-specification-new .edit-row :is(.eds-selector,select,input,textarea,[contenteditable=true])')
        .filter(control => attributeLabel(control) === label && !control.matches('input[type=hidden]') &&
          !control.closest('.eds-popper,.eds-modal,[disabled],[readonly],[aria-disabled=true],.eds-selector--disabled') &&
          !control.parentElement.closest('.eds-selector,select'));
      if (only(controls) !== target) return denied();
      if (target.matches('input[type=checkbox]')) {
        if (typeof value !== 'boolean') return denied();
        if (target.checked !== value) target.click();
        return target.checked === value ? { ok: true } : denied();
      }
      if (target.matches('select')) {
        const wanted = target.multiple ? value : [value];
        if (!Array.isArray(wanted) || !wanted.length || wanted.length > 30 ||
            wanted.some(item => typeof item !== 'string' || !item.trim()) || new Set(wanted.map(clean)).size !== wanted.length) return denied();
        const available = [...target.options].filter(option => option.value && !option.disabled && !option.closest('optgroup[disabled]'));
        const picks = wanted.map(item => only(available.filter(option => clean(option.label) === clean(item))));
        if (!picks.every(Boolean)) return denied();
        if (target.multiple) [...target.options].forEach(option => { option.selected = picks.includes(option); });
        else target.selectedIndex = picks[0].index;
      } else {
        const numeric = target.matches('input[type=number]');
        const content = target.matches('[contenteditable=true]');
        if (!numeric && !content && !target.matches('input[type=text],input:not([type]),textarea')) return denied();
        if (typeof value !== 'string' && typeof value !== 'number') return denied();
        const rendered = String(value);
        if (!rendered.trim() || rendered.length > 4000 || target.maxLength > 0 && rendered.length > target.maxLength) return denied();
        if (numeric && (!/^-?\d+(?:\.\d+)?$/u.test(rendered) || !Number.isFinite(Number(rendered)) ||
            target.min !== '' && Number(rendered) < Number(target.min) || target.max !== '' && Number(rendered) > Number(target.max))) return denied();
        if (content) target.textContent = rendered;
        else {
          const prototype = target.matches('textarea') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (!setter) return denied();
          setter.call(target, rendered);
        }
      }
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }
    case 'attribute-trigger': {
      const matches = shown(trigger).filter(control => attributeLabel(control) === label);
      if (only(matches) !== target || clean(target.innerText ?? target.textContent).slice(0, 400) !== text) return denied();
      break;
    }
    case 'attribute-option': {
      const owner = only(shown(trigger).filter(control => control.getAttribute('aria-expanded') === 'true' ||
        control.closest('.eds-select.is-show')));
      const popover = only(shown(menu).filter(node => node.querySelector(option + ',input:not([type=hidden])')));
      if (!owner || attributeLabel(owner) !== label || !target.matches(option) || !popover?.contains(target) ||
          !text || clean(target.textContent) !== text) return denied();
      break;
    }
    case 'variant-enable':
      if (label !== '开启商品规格' || text !== label || clean(target.textContent) !== label ||
          !target.matches('.product-sales-info .variation-add-button button.primary-dash-button[type=button]')) return denied();
      break;
    case 'variant-reset': {
      const sales = only(shown('.product-sales-info'));
      const rows = shown('.product-basic-info .edit-row').filter(row =>
        clean(row.querySelector(':scope > .edit-label')?.textContent).replace(/^[*＊]\s*/u, '') === '商品名称');
      const title = clean(only(rows)?.querySelector('input[type=text],input:not([type])')?.value);
      if (label !== '清除新表单预带规格' || !title || title !== clean(value) || !sales ||
          only([...sales.querySelectorAll('.variation-edit-item .variation-delete-btn')].filter(visible)) !== target) return denied();
      const names = [...sales.querySelectorAll('.variation-name-panel input')].filter(visible);
      const options = [...sales.querySelectorAll('.variation-option-panel .options-item input')]
        .filter(visible).map(input => clean(input.value)).filter(Boolean);
      if (names.length !== 1 || clean(names[0].value) !== clean(variantName) || !Array.isArray(variantOptions) ||
          options.length !== variantOptions.length || options.some((option, index) => option !== variantOptions[index])) return denied();
      break;
    }
    default:
      return denied();
  }
  target.click();
  return { ok: true };
}

// Write only the one empty name or option input belonging to the current variation axis.
export async function writeListingVariant({ kind, selector, category, name, option, existingOptions }, expectedUrl) {
  const clean = value => String(value ?? '').trim().replace(/\s+/gu, ' ');
  const pathText = value => clean(value).replace(/\s*[＞>›»]\s*/gu, ' > ');
  const visible = node => node.getClientRects().length && getComputedStyle(node).visibility === 'visible' &&
    !node.closest('[aria-hidden=true],[inert]');
  const shown = (query, root = document) => [...root.querySelectorAll(query)].filter(visible);
  const only = items => items.length === 1 ? items[0] : null;
  const denied = reason => ({ ok: false, code: 'variant-control-changed', error: (kind === 'name' ? '规格名称' : '规格选项') + '：' + reason });
  const validText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
  if (location.href !== expectedUrl || location.origin !== 'https://seller.shopee.cn' ||
      location.pathname !== '/portal/mtsku/new' || !['name', 'option'].includes(kind) ||
      typeof selector !== 'string' || !selector || selector.length > 2048 ||
      !validText(category, 220) || !validText(name, 14) ||
      (kind === 'option' && !validText(option, 30)) || !Array.isArray(existingOptions)) return denied('页面地址或输入参数与回放不符。');
  const categoryField = only(shown('.product-basic-info .product-category-text'));
  const sales = only(shown('.product-sales-info'));
  if (!sales) return denied('未找到唯一的销售资料区。');
  if (!categoryField || pathText(categoryField.textContent) !== pathText(category)) return denied('当前商品类目与回放不符。');
  if (shown('.eds-modal__mask,[role=dialog],[aria-modal=true],dialog[open],.eds-popper:has(.pulse-popover-button)').length) {
    return { ok: false, code: 'modal', error: '操作前出现了 Shopee 弹窗。' };
  }
  let target;
  try {
    target = only([...document.querySelectorAll(selector)]);
  } catch {
    return denied('控件定位格式无效。');
  }
  if (!target) return denied('未定位到唯一的输入框。');
  if (!target.matches('input[type=text]') || !visible(target)) return denied('匹配的控件并非可见文本输入框。');
  if (target.matches(':disabled,[readonly]') ||
      target.closest('[aria-disabled=true],.is-disabled,.custom-len-calc-input[disabled=true]')) {
    return denied('匹配的输入框处于禁用或只读状态。');
  }
  const nameField = only(shown('.variation-name-panel input', sales));
  const optionFields = shown('.variation-option-panel .options-item input', sales);
  const currentOptions = optionFields.map(input => clean(input.value)).filter(Boolean);
  if (!nameField) return denied('未找到唯一的规格名称输入框。');
  if (currentOptions.length !== existingOptions.length || currentOptions.some((value, index) => value !== existingOptions[index])) {
    return denied('已有规格选项在读取后发生变化。');
  }
  if (kind === 'name') {
    if (target !== nameField || target.value !== '' || currentOptions.length) return denied('目标并非唯一的空白规格名称输入框。');
  } else {
    const blanks = optionFields.filter(input => input.value === '');
    const next = !currentOptions.length && only(blanks.filter(input => input.closest('.drag-item') &&
      !input.closest('.virtual-options-item'))) || only(blanks.filter(input => input.closest('.virtual-options-item')));
    if (next !== target) return denied('目标并非下一个空白规格选项输入框。');
    if (nameField.value !== name) return denied('当前规格名称与回放不符。');
    if (currentOptions.includes(clean(option))) return denied('相同的规格选项已经存在。');
  }
  target.focus();
  if (!target.isConnected || target.value !== '' || location.href !== expectedUrl) return denied('输入框在聚焦后发生变化。');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setValue.call(target, kind === 'name' ? name : option);
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  await Promise.resolve();
  target.blur();
  return { ok: true };
}

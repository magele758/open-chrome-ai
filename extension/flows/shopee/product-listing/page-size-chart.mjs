// Injected in the top frame. All edits are restricted to Shopee's size chart controls.
export async function operateShopeeSizeChart(request, expectedUrl) {
  const { action = 'read', category } = request;
  const clean = value => String(value ?? '').trim().replace(/\s+/gu, ' ');
  const pathText = value => clean(value).replace(/\s*[＞>›»]\s*/gu, ' > ');
  const all = (q, root = document) => [...(root?.querySelectorAll(q) ?? [])];
  const visible = node => Boolean(node && [...node.getClientRects()].some(rect => rect.width && rect.height)) &&
    getComputedStyle(node).visibility === 'visible' &&
    !node.closest('[aria-hidden=true],[inert]');
  const shown = (q, root) => all(q, root).filter(visible);
  const only = list => list.length === 1 ? list[0] : null;
  const one = (q, root) => only(shown(q, root));
  const failure = (error, code = 'size-chart-control-changed') => ({ ok: false, code, error });
  const exactButton = (root, query, label) => root && only(shown(query, root).filter(node =>
    clean(node.textContent) === label && !node.matches(':disabled,[aria-disabled=true]')));
  const matchesPage = () => location.href === expectedUrl && location.origin === 'https://seller.shopee.cn' &&
    location.pathname === '/portal/mtsku/new' &&
    pathText(one('.product-basic-info .product-category-text')?.textContent) === pathText(category) && Boolean(category);
  if (!matchesPage()) return failure('当前店铺页面或商品类目已变化。', 'page-changed');

  const listing = one('.product-new-size-chart .size-chart-dropdown');
  const addChart = exactButton(listing, 'button.btn[type=button]', '添加新的尺码表');
  const listingSelect = listing && one('.dropDown .eds-selector', listing);
  const modal = only(all('.eds-modal.size-chart-modal').filter(node => one('.eds-modal__mask', node)));
  const title = modal && clean(one('.eds-modal__title', modal)?.textContent);
  const known = title && /^Add New Size Chart Of \S.{0,80}$/u.test(title);
  if (shown('.eds-modal__mask,[role=dialog],[aria-modal=true],dialog[open],.eds-popper:has(.pulse-popover-button)')
    .some(node => !modal?.contains(node))) {
    return failure('页面打开了另一个弹窗。', 'modal');
  }
  if (modal && !known) {
    if (action === 'read' && !title) return { available: Boolean(addChart && listingSelect), dialog: { columns: [], rows: [] } };
    return failure('尺码弹窗标题不匹配。' + (title ? ' 当前标题 ' + title.slice(0, 85) : ''), 'modal');
  }

  const genericUnitMenu = '.eds-popper:has(> .eds-select__menu .eds-option)';
  const menuSelector = `:is(.eds-select-popover-content,.listingUploadSizeChartSelectorPopper,${genericUnitMenu}):not(.slide-fast-leave-active)`;
  const optionSelector = '.eds-option,[role=option]';
  function menuFor(control) {
    if (!control) return null;
    const select = control.closest('.eds-select.is-show');
    if (!select) return null;
    const local = one(menuSelector, select);
    if (local) return local;
    const portal = control.closest('.size-chart-info .listing-edit-table') ? '.listingUploadSizeChartSelectorPopper' :
      control.closest('.size-chart-info .unit') ? genericUnitMenu : '.eds-select-popover-content';
    return only(shown(menuSelector).filter(node => node.matches(portal)));
  }
  function optionsIn(menu) {
    return menu ? shown(optionSelector, menu).filter(option => !option.matches('[aria-disabled=true],.eds-option--disabled,.is-disabled'))
      .map(node => ({ node, value: clean(node.textContent) })).filter(option => option.value) : [];
  }
  function chosen(control) {
    return clean(control?.querySelector('.eds-selector__inner:not(.placeholder)')?.textContent);
  }
  function inspectFields() {
    const nameInput = modal && only(shown('input[type=text]', modal).filter(input => !input.closest('table')));
    const unitSelect = modal && one('.unit .eds-selector', modal);
    const cols = modal ? shown('.mesurements label.eds-checkbox', modal).map(node => ({
      label: clean(node.querySelector('.size-chart-measurement-name')?.textContent),
      node,
      input: only(all('input[type=checkbox]', node)),
    })).filter(column => column.label && column.input) : [];
    const table = modal && one('.size-chart-info .eds-table.listing-edit-table', modal);
    const left = '.eds-table__fix-header.eds-table__fix-left th';
    const main = '.eds-table__main-header th';
    const headerLabels = query => table ? shown(query, table).map(th => clean(th.querySelector('.label-name')?.textContent)) : [];
    const partitions = [
      { heads: headerLabels(left), rows: '.eds-table__fix-body.eds-table__fix-left tbody > tr' },
      { heads: headerLabels(main), rows: '.eds-table__main-body tbody > tr' },
    ];
    const rows = [];
    let valid = Boolean(table && cols.length);
    for (const { heads, rows: selector } of partitions) {
      if (!heads.length) continue;
      const section = shown(selector, table).map(tr => [...tr.children].map(td => one('input[type=text],.eds-selector', td)))
        .filter(cells => cells.some(Boolean));
      if (sectionsMismatch(section)) valid = false;
      section.forEach((cells, index) => {
        rows[index] ??= new Map();
        if (cells.length !== heads.length) valid = false;
        for (const [i, label] of heads.entries()) {
          if (!label || !cells[i] || rows[index].has(label)) valid = false;
          else rows[index].set(label, cells[i]);
        }
      });
    }
    function sectionsMismatch(section) {
      return rows.length > 0 && rows.length !== section.length;
    }
    const active = cols.filter(col => col.input.checked).map(col => col.label);
    if (rows.some(row => active.length !== row.size || active.some(label => !row.has(label)))) valid = false;
    return { nameInput, unitSelect, cols, rows: valid ? rows : [] };
  }
  const validation = () => modal ? shown('.size-chart-edit-form-item-error,[role=alert],.eds-form-item__error', modal)
    .map(node => clean(node.innerText || node.textContent)).filter(Boolean).slice(0, 10) : [];
  const readValue = target => target?.matches('input') ? clean(target.value) : chosen(target);
  const displayValue = one('.unit .eds-selector__inner', modal);
  const readUnit = () => clean(displayValue?.textContent).toLowerCase();
  const listingOptions = () => {
    const menu = menuFor(listingSelect);
    if (!menu) return undefined;
    const options = optionsIn(menu).map(option => option.value);
    return options.length || /Have no size chart to choose|暂无|无尺码表/u.test(menu.textContent) ? options : undefined;
  };
  const fields = modal && inspectFields();
  if (action === 'read') {
    return {
      available: Boolean(addChart && listingSelect),
      selectedName: chosen(listingSelect) || null,
      ...(!modal && { options: listingOptions() }),
      dialog: modal ? {
        title, kind: title.slice('Add New Size Chart Of '.length), name: fields.nameInput?.value ?? '',
        unit: readUnit(),
        columns: fields.cols.map(column => ({
          label: column.label, checked: column.input.checked, locked: column.input.disabled,
        })),
        rows: fields.rows.map(row => Object.fromEntries([...row].map(([label, target]) => [label, readValue(target)]))),
        validation: validation(),
      } : null,
    };
  }

  function setInput(input, value) {
    if (!input || input.matches(':disabled,[readonly]') || !visible(input) || !modal.contains(input) ||
        typeof value !== 'string' || value.length > 50 || !matchesPage()) return false;
    input.focus();
    if (!input.isConnected) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    return true;
  }
  async function openMenu(control) {
    if (!control || !visible(control)) return null;
    if (!menuFor(control)) control.click();
    for (let attempt = 0; attempt < 12; attempt++) {
      const menu = menuFor(control);
      if (menu) return menu;
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    return null;
  }
  function matchOption(menu, wanted, label) {
    const options = optionsIn(menu);
    let matches = options.filter(option => option.value === wanted);
    if (label !== '尺寸（国际）' || matches.length === 1) return only(matches);
    const value = wanted === '2XL' && !matches.length ? 'XXL' : wanted;
    matches = options.filter(option => option.value === value);
    if (matches.length === 1) return matches[0];
    // Tops repeat some letter sizes later in the mixed, unlabelled menu.
    // Use the standard opening sequence only when it still matches exactly.
    const standard = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
    const position = standard.indexOf(value);
    return position >= 0 && standard.every((size, index) => options[index]?.value === size)
      ? options[position] : null;
  }
  async function choose(control, wanted, label) {
    if (!matchesPage()) return false;
    if (readValue(control) === wanted) return true;
    const menu = await openMenu(control);
    const target = matchOption(menu, wanted, label)?.node;
    if (!target || !matchesPage() || !visible(target)) return false;
    target.click();
    return true;
  }
  function safeName(name) {
    return typeof name === 'string' && /^[^\r\n]{1,37}-[0-9a-f]{12}$/u.test(name) && name.length <= 50;
  }
  const good = { ok: true };
  if (!modal) {
    if (!addChart || !listingSelect) return failure('商品表单缺少尺码表控件。');
    if (action === 'open-options') {
      if (!menuFor(listingSelect)) listingSelect.click();
      return good;
    }
    if (action === 'open') {
      if (menuFor(listingSelect)) listingSelect.click();
      addChart.click();
      return good;
    }
    if (action === 'select' && safeName(request.name)) {
      return await choose(listingSelect, request.name, '模板') ? good : failure('没有唯一匹配的尺码模板。');
    }
    return failure('尺码表对话框没有打开。');
  }

  switch (action) {
    case 'dismiss': {
      const button = exactButton(modal, '.size-chart-edit-modal-footer button[type=button]', '取消');
      if (!button) return failure('找不到尺码表取消按钮。');
      button.click();
      return good;
    }
    case 'set-name':
      if (safeName(request.name) && setInput(fields.nameInput, request.name)) return good;
      return failure('尺码表名称字段不可填写。');
    case 'set-unit':
      if (['cm', 'inch'].includes(request.unit) && await choose(fields.unitSelect, request.unit, '单位')) return good;
      return failure('所需单位不在尺码表下拉选项中。');
    case 'toggle-column': {
      const col = only(fields.cols.filter(column => column.label === request.label));
      if (!col || typeof request.checked !== 'boolean' || col.input.disabled) return failure('尺码列已锁定或发生变化。');
      if (col.input.checked !== request.checked) col.input.click();
      return good;
    }
    case 'column-options': {
      const target = fields.rows[0]?.get(request.label);
      if (!target?.matches('.eds-selector')) return failure('所需尺码下拉列不存在。');
      const menu = await openMenu(target);
      if (!menu) return failure('尺码可选值未显示。');
      let options = optionsIn(menu).map(option => option.value);
      // This picker mixes unrelated size systems. For women's tops use the
      // whole even-numbered US clothing sizes actually offered by this menu.
      if (request.label === '尺寸（美国）' && /^女装 > 上衣 > /u.test(pathText(category))) {
        options = options.filter(option => /^(?:US: 0|[2468]|1[02468]|20)$/u.test(option));
      }
      if (menuFor(target)) target.click();
      return { options };
    }
    case 'add-row': {
      const button = exactButton(modal, '.addRow button[type=button]', '新增行');
      if (!button || request.rowCount !== fields.rows.length || request.rowCount < 1 || request.rowCount >= 50) {
        return failure('不能确认尺码表的当前行数。');
      }
      button.click();
      return good;
    }
    case 'fill-rows':
    case 'save': {
      const { rows } = request;
      if (!Array.isArray(rows) || !rows.length || rows.length !== fields.rows.length || rows.length > 50)
        return failure('尺码表行数与输入不一致。');
      for (const [i, data] of rows.entries()) {
        if (!data || Object.keys(data).length !== fields.rows[i].size || [...fields.rows[i]].some(([label, cell]) => {
          const value = data[label];
          if (typeof value !== 'string' || value.length > 35) return true;
          if (cell.matches('input') && !/^\d+(?:\.\d+)?$/u.test(value)) return true;
          const prior = readValue(cell);
          if (prior === value || cell.matches('input') && prior && Number(prior) === Number(value) || label === '尺寸（国际）' && value === '2XL' && prior === 'XXL') return false;
          return action === 'save' || Boolean(prior);
        })) return failure(`第 ${i + 1} 行存在未核对或已修改的尺码字段。`);
      }
      if (action === 'save') {
        const save = exactButton(modal, '.size-chart-edit-modal-footer button[type=button]', '保存');
        if (!save || !safeName(request.name) || fields.nameInput?.value !== request.name ||
            readUnit() !== request.unit || validation().length || !matchesPage()) return failure('保存前尺码表校验未通过。');
        save.click();
        return good;
      }
      for (const [i, data] of rows.entries()) {
        for (const [label, target] of fields.rows[i]) {
          const value = data[label];
          if (!value || readValue(target) === value) continue;
          const applied = target.matches('input') ? setInput(target, value) : await choose(target, value, label);
          if (!applied) return failure(`第 ${i + 1} 行的「${label}」未能填写。`);
        }
      }
      return good;
    }
    default:
      return failure('操作不属于尺码表工作流。');
  }
}

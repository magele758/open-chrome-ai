/** Inspect or fill a new Shopee shop voucher. Chrome injects this function without its module scope. */
export async function operateShopeeVoucherDraft({ expectedUrl, operation = 'read', values } = {}) {
  const failure = (code, error, extra) => ({ ok: false, code, error, submitted: false, ...extra });
  const route = new URL(location.href);
  const shopIds = route.searchParams.getAll('cnsc_shop_id');
  const useCases = route.searchParams.getAll('usecase');
  const onNewRoute = () => location.href === expectedUrl && route.origin === 'https://seller.shopee.cn' &&
    route.pathname === '/portal/marketing/vouchers/new' && !route.hash &&
    [...route.searchParams.keys()].every(key => key === 'cnsc_shop_id' || key === 'usecase') &&
    shopIds.length === 1 && /^\d+$/.test(shopIds[0]) && useCases.length === 1 && useCases[0] === '1';
  if (!onNewRoute()) return failure('voucher-draft-page', '请切换到同一店铺的新建店铺优惠券页面。');
  if (operation !== 'read' && operation !== 'fill') return failure('unknown-action', '不支持此优惠券表单操作。');

  const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
  const text = node => clean(node?.innerText ?? node?.textContent);
  const visible = node => Boolean(node?.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden' &&
    !node.closest('[inert],[hidden],[aria-hidden=true]');
  const one = items => items.length === 1 ? items[0] : null;
  const all = (root, selector) => [...(root?.querySelectorAll(selector) ?? [])].filter(visible);
  const formRow = label => one(all(document, '.eds-react-form-item').filter(item =>
    all(item, '.eds-react-form-item__label').some(element =>
      element.closest('.eds-react-form-item') === item && text(element) === label)));
  const ownInput = (row, selector) => one(all(row, selector).filter(input => input.closest('.eds-react-form-item') === row));
  const nameRow = formRow('优惠券名称');
  const codeRow = formRow('优惠码');
  const periodRow = formRow('优惠券领取期限');
  const typeRow = formRow('优惠券类型');
  const rewardRow = formRow('奖励类型');
  const discountRow = formRow('折扣类型 | 优惠限额');
  const cashField = '.currency-input input.eds-react-input__input[maxlength="13"]';
  const numberField = 'input.eds-react-input-number-input';
  const fixedCodePrefix = text(codeRow).match(/\b[A-Z0-9]{2,8}\b/u)?.[0] || null;
  const discountMode = all(discountRow, '[role=combobox],.eds-react-selector,.eds-react-select,.discount-type-selector,div,span')
    .find(node => text(node) === '折扣金额');
  const checked = row => [...(row?.querySelectorAll('input[type=radio]:checked,input[type=checkbox]:checked') ?? [])]
    .filter(input => visible(input.closest('label')) || visible(input));
  const rewardMode = one(checked(rewardRow))?.value;

  const definitions = [
    { key: 'name', label: '优惠券名称', required: true, input: ownInput(nameRow, 'input.eds-react-input__input[maxlength="100"]'), limit: 100, defaults: [''] },
    { key: 'codeSuffix', label: '优惠码后缀', required: true, input: ownInput(codeRow, 'input.eds-react-input__input[maxlength="5"]'), limit: 5, defaults: [''] },
    { key: 'startsAt', label: '领取开始时间', required: true, input: ownInput(periodRow, '#startDate input'), readOnly: true },
    { key: 'endsAt', label: '领取结束时间', required: true, input: ownInput(periodRow, '#endDate input'), readOnly: true },
    { key: 'discountAmount', label: '折扣金额', required: true, input: ownInput(discountRow, cashField), defaults: [''], readOnly: rewardMode !== '0' || !discountMode },
    { key: 'minimumSpend', label: '最低消费金额', required: true, input: ownInput(formRow('最低消费金额'), cashField), defaults: ['', '0'] },
    { key: 'quantity', label: '可使用总数', required: true, input: ownInput(formRow('可使用总数'), numberField), defaults: ['', '0'] },
    { key: 'perBuyerLimit', label: '每个买家可用的优惠券数量上限', required: true, input: ownInput(formRow('每个买家可用的优惠券数量上限'), numberField), defaults: ['1'] },
  ];
  if (!typeRow || !/店铺优惠券|商店优惠券/u.test(text(typeRow)) || !nameRow || !codeRow || !rewardRow || !discountRow ||
      !definitions.find(field => field.key === 'name')?.input || !definitions.find(field => field.key === 'codeSuffix')?.input) {
    return failure('voucher-draft-unavailable', '暂未读到新建店铺优惠券表单，请等页面加载完毕后重试。');
  }
  const editable = field => Boolean(field.input && !(field.readOnly || field.input.disabled || field.input.readOnly ||
    field.input.closest('[aria-disabled=true],fieldset:disabled')));
  const readFields = () => definitions.map(field => ({
    key: field.key,
    label: field.label,
    value: field.input?.value ?? null,
    required: field.required,
    editable: editable(field),
    ...(field.limit === undefined ? {} : { maxLength: field.limit }),
  }));
  const selectedLabels = label => checked(formRow(label))
    .map(input => text(input.closest('label'))).filter(Boolean);
  const scopeText = label => text(formRow(label)).slice(label.length).trim();
  const result = () => ({
    ok: true,
    kind: 'voucher-draft',
    title: 'Shopee 店铺优惠券试填',
    url: location.href,
    fields: readFields(),
    meta: {
      shopId: shopIds[0], useCase: useCases[0], codePrefix: fixedCodePrefix,
      rewardType: selectedLabels('奖励类型')[0] || null,
      discountType: discountMode ? '折扣金额' : null,
      display: selectedLabels('优惠券显示设置'),
      productScope: scopeText('优惠商品') || null,
    },
    submitted: false,
  });
  if (operation === 'read') return result();

  if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) {
    return failure('voucher-values-invalid', '请提供至少一项优惠券试填参数。');
  }
  const inputByKey = new Map(definitions.map(field => [field.key, field]));
  const money = /^\d{1,9}(?:\.\d{1,2})?$/u;
  const positiveInt = value => /^\d+$/u.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
  const valid = {
    name: value => value.length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(value),
    codeSuffix: value => /^[A-Z0-9]{1,5}$/u.test(value),
    discountAmount: value => money.test(value) && Number(value) > 0,
    minimumSpend: value => money.test(value),
    quantity: positiveInt,
    perBuyerLimit: positiveInt,
  };
  const plannedValues = new Map();
  for (const [key, raw] of Object.entries(values)) {
    const field = inputByKey.get(key);
    if (!field || !editable(field) || !Object.hasOwn(valid, key)) {
      return failure('voucher-field-unsupported', `当前表单不支持填写 ${field?.label || key}。`, { fields: readFields() });
    }
    const value = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
    if (!valid[key](value)) {
      return failure('voucher-values-invalid', `${field.label}的值不符合格式。`, { fields: readFields() });
    }
    plannedValues.set(key, value);
  }
  const quantity = plannedValues.get('quantity') ?? inputByKey.get('quantity').input?.value;
  const limit = plannedValues.get('perBuyerLimit') ?? inputByKey.get('perBuyerLimit').input?.value;
  if (positiveInt(quantity) && positiveInt(limit) && Number(limit) > Number(quantity)) {
    return failure('voucher-values-invalid', '每个买家的领取上限不能超过可使用总数。', { fields: readFields() });
  }
  for (const field of definitions) {
    if (!field.defaults || !field.input) continue;
    const current = field.input.value;
    if (!field.defaults.includes(current) && current !== plannedValues.get(field.key)) {
      return failure('voucher-draft-not-empty', `发现已填写的${field.label}，请在空白新建页试填。`, { fields: readFields() });
    }
  }
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!nativeSet) return failure('voucher-field-unavailable', '当前浏览器无法填写优惠券表单。');
  const applied = [];
  for (const [key, value] of plannedValues) {
    const field = inputByKey.get(key);
    if (!onNewRoute() || !visible(field.input) || !editable(field)) {
      return failure('voucher-draft-changed', '优惠券表单已变化，试填已停止。', { fields: readFields(), applied });
    }
    if (field.input.value !== value) {
      nativeSet.call(field.input, value);
      field.input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: value }));
      field.input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    }
    if (field.input.value !== value && (!(key === 'discountAmount' || key === 'minimumSpend') || Number(field.input.value) !== Number(value))) {
      return failure('voucher-field-unverified', `${field.label}的页面回读结果与输入不一致。`, { fields: readFields(), applied });
    }
    applied.push(key);
  }
  return { ...result(), applied };
}

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { operateShopeeVoucherDraft } from '../draft.js';
import { readShopeeVouchers } from '../page-state.js';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const listUrl = 'https://seller.shopee.cn/portal/marketing/vouchers/list?cnsc_shop_id=123';
const draftUrl = 'https://seller.shopee.cn/portal/marketing/vouchers/new?usecase=1&cnsc_shop_id=123';
const heading = ['优惠券活动名称 | 优惠券码', '优惠券类型', '适用商品范围', '折扣金额', '可使用总数', '已使用', '优惠券领取期间', '操作'];

function browser(t, url, html, operation) {
  const { window } = new JSDOM(html, { url, runScripts: 'outside-only' });
  t.after(() => window.close());
  window.HTMLElement.prototype.getClientRects = function () {
    return this.closest('[hidden]') ? [] : [{ width: 150, height: 24 }];
  };
  const run = window.eval(`(${operation})`);
  return {
    document: window.document,
    run: async (...args) => JSON.parse(JSON.stringify(await run(...args))),
  };
}

function voucherList(t, { empty = false, hasNext = false } = {}) {
  const rows = empty ? '<tr><td colspan="8">未创建优惠券</td></tr>' : `
    <tr><td>Weekend offer\n优惠券码: SHINSALE</td><td>商店优惠券</td><td>全部商品</td><td>฿ 10.00</td>
    <td>30</td><td>5</td><td>2026-11-18 ~ 2026-11-19 (GMT+7)</td><td><button id="danger">删除</button></td></tr>`;
  return browser(t, listUrl, `
    <header><button>商店优惠券 普通折扣 创建</button></header>
    <section><h2>优惠券列表</h2><div role="tab" aria-selected="true">进行中</div>
    <div><div><table><thead><tr>${heading.map(name => `<th>${name}</th>`).join('')}</tr></thead></table></div>
    <div><table><tbody>${rows}</tbody></table></div></div>
    ${hasNext ? '<nav class="eds-react-pagination"><span aria-current="page">1</span><span>共 24 条</span><button id="next" title="下一页">›</button></nav>' : ''}
    </section>`, readShopeeVouchers);
}

test('reads a visible split table and preserves identity, discount, dates and status', async t => {
  const { run } = voucherList(t);
  const result = await run(listUrl, { action: 'read' });
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].title, 'Weekend offer');
  assert.equal(result.rows[0].code, 'SHINSALE');
  assert.equal(result.rows[0].discount, '฿ 10.00');
  assert.equal(result.rows[0].used, '5');
  assert.equal(result.rows[0].validPeriod, '2026-11-18 ~ 2026-11-19 (GMT+7)');
  assert.deepEqual(result.meta.statusCounts, { 进行中: 1 });
  assert.deepEqual(result.meta.voucherTypes, [{ name: '商店优惠券', description: '普通折扣' }]);
  assert.equal((await run(listUrl.replace('123', '456'))).code, 'page-changed');
});

test('distinguishes the displayed empty-list state from loading or unavailable pagination', async t => {
  const { document, run } = voucherList(t, { empty: true });
  const result = await run(listUrl);
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 0);
  assert.equal(result.meta.emptyMessage, '未创建优惠券');
  assert.equal((await run(listUrl, { action: 'next-page' })).code, 'no-next-page');

  const tbody = document.querySelector('tbody');
  tbody.replaceChildren();
  assert.equal((await run(listUrl)).code, 'voucher-list-loading');
  tbody.closest('table').insertAdjacentHTML('afterend', '<div class="eds-react-empty">未创建优惠券</div>');
  assert.equal((await run(listUrl)).meta.emptyMessage, '未创建优惠券');
});

test('advances only the unique enabled next-page control', async t => {
  const { document, run } = voucherList(t, { hasNext: true });
  let clicks = 0;
  const next = document.getElementById('next');
  next.addEventListener('click', () => clicks++);
  document.getElementById('danger').addEventListener('click', () => assert.fail('voucher was modified'));
  const result = await run(listUrl);
  assert.equal(result.meta.totalRecords, 24);
  assert.equal(result.meta.currentPage, 1);
  assert.equal(result.meta.hasNextPage, true);
  assert.equal((await run(listUrl, { action: 'next-page' })).kind, 'vouchers-next-page');
  next.disabled = true;
  assert.equal((await run(listUrl, { action: 'next-page' })).code, 'no-next-page');
  assert.equal(clicks, 1);
});

const row = (label, input) => `<div class="eds-react-form-item"><label class="eds-react-form-item__label">${label}</label>${input}</div>`;
const cash = id => `<div class="currency-input">฿<input id="${id}" class="eds-react-input__input" maxlength="13"></div>`;
const count = (id, value) => `<input id="${id}" class="eds-react-input-number-input" value="${value}">`;
const dated = value => `<input placeholder="Select Date" value="${value}" readonly>`;

function voucherDraft(t, { url = draftUrl, name = '', cashMode = true } = {}) {
  return browser(t, url, `<form>
    <h2>基本详情</h2>
    ${row('优惠券类型', '<div>店铺优惠券</div>')}
    ${row('优惠券名称', `<input id="name" class="eds-react-input__input" maxlength="100" value="${name}">`)}
    ${row('优惠码', '<span>SHIN</span><input id="code" class="eds-react-input__input" maxlength="5">')}
    ${row('优惠券领取期限', `<span id="startDate">${dated('2026-11-18 11:22')}</span><span id="endDate">${dated('2026-11-18 12:22')}</span>`)}
    <h2>奖励设置</h2>
    ${row('奖励类型', `<label><input type="radio" value="0" ${cashMode ? 'checked' : ''} hidden>折扣</label><label><input type="radio" value="1" ${cashMode ? '' : 'checked'} hidden>Shopee币回扣</label>`)}
    ${row('折扣类型 | 优惠限额', `<span>${cashMode ? '折扣金额' : '折扣百分比'}</span>${cash('discount')}`)}
    ${row('最低消费金额', cash('minimum'))}
    ${row('可使用总数', count('quantity', '0'))}
    ${row('每个买家可用的优惠券数量上限', count('limit', '1'))}
    <h2>显示/商品设置</h2>
    ${row('优惠券显示设置', '<label><input type="radio" checked>展示在所有页面</label><label><input type="checkbox" checked>在结账页显示</label>')}
    ${row('优惠商品', '<span>全部商品</span>')}
    <button id="submit" type="submit">确认</button>
  </form>`, operateShopeeVoucherDraft);
}
const sample = { name: 'Shopee 试填', codeSuffix: 'TEST5', discountAmount: 10, minimumSpend: 59, quantity: 30, perBuyerLimit: 2 };

test('reads values, visible settings and hints and fills all six verified fields without submitting', async t => {
  const { document, run } = voucherDraft(t);
  const updates = [];
  document.querySelector('form').addEventListener('input', event => updates.push(event.target.id));
  document.querySelector('form').addEventListener('submit', () => assert.fail('submitted a voucher'));
  document.getElementById('submit').addEventListener('click', () => assert.fail('clicked voucher confirmation'));
  const before = await run({ expectedUrl: draftUrl });
  assert.equal(before.ok, true);
  assert.equal(before.meta.codePrefix, 'SHIN');
  assert.equal(before.meta.discountType, '折扣金额');
  assert.equal(before.fields.find(field => field.key === 'startsAt').value, '2026-11-18 11:22');
  assert.equal(before.fields.find(field => field.key === 'startsAt').editable, false);
  const parameters = { expectedUrl: draftUrl, operation: 'fill', values: sample };
  const result = await run(parameters);
  assert.equal(result.ok, true);
  assert.equal(result.submitted, false);
  assert.deepEqual(result.applied, Object.keys(sample));
  for (const field of result.fields.filter(field => field.editable)) assert.equal(field.value, String(sample[field.key]));
  assert.deepEqual(updates, ['name', 'code', 'discount', 'minimum', 'quantity', 'limit']);
  assert.equal((await run(parameters)).ok, true);
  assert.equal(updates.length, 6);
});

test('rejects an unsupported date, invalid format and inconsistent limits before changing the form', async t => {
  const { document, run } = voucherDraft(t);
  const fill = values => run({ expectedUrl: draftUrl, operation: 'fill', values });
  assert.equal((await fill({ ...sample, startsAt: '2026-11-20' })).code, 'voucher-field-unsupported');
  assert.equal((await fill({ ...sample, codeSuffix: 'manycharacters' })).code, 'voucher-values-invalid');
  assert.equal((await fill({ ...sample, perBuyerLimit: 50 })).code, 'voucher-values-invalid');
  assert.equal(document.getElementById('name').value, '');
  assert.equal(document.getElementById('discount').value, '');
});

test('rejects edited drafts, different shop, other reward mode and existing voucher routes', async t => {
  const userEdited = voucherDraft(t, { name: '用户已填写' });
  const parameters = { expectedUrl: draftUrl, operation: 'fill', values: sample };
  assert.equal((await userEdited.run(parameters)).code, 'voucher-draft-not-empty');
  assert.equal(userEdited.document.getElementById('name').value, '用户已填写');
  assert.equal((await userEdited.run({ ...parameters, expectedUrl: draftUrl.replace('123', '456') })).code, 'voucher-draft-page');
  assert.equal((await voucherDraft(t, { cashMode: false }).run(parameters)).code, 'voucher-field-unsupported');
  const editUrl = draftUrl.replace('/new?', '/edit?voucherId=1&');
  assert.equal((await voucherDraft(t, { url: editUrl }).run({ ...parameters, expectedUrl: editUrl })).code, 'voucher-draft-page');
});

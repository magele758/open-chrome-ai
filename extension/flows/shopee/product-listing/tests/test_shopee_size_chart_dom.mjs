import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { operateShopeeSizeChart } from '../page-size-chart.mjs';

const { JSDOM } = createRequire(import.meta.url)('jsdom');

const url = 'https://seller.shopee.cn/portal/mtsku/new?cnsc_shop_id=123';
const category = '女装 > 上衣 > T恤';
const name = '条纹上衣-deadbeef1234';
const rows = [
  { '尺寸（美国）': '4', '尺寸（国际）': 'S', 胸围: '37.80' },
  { '尺寸（美国）': '16', '尺寸（国际）': '2XL', 胸围: '48.82' },
];

const select = options => `
  <div class="eds-select">
    <div class="eds-selector"><div class="eds-selector__inner placeholder">请选择</div></div>
    <div class="eds-select-popover-content" hidden>${options.map(value => `<div class="eds-option">${value}</div>`).join('')}</div>
  </div>`;

function fixture(t) {
  const { window } = new JSDOM(`
    <div class="product-basic-info"><div class="product-category-text">${category}</div></div>
    <div class="product-new-size-chart"><div class="size-chart-dropdown">
      <div class="dropDown">${select(['另一张尺码表'])}</div>
      <button id="open" class="btn" type="button">添加新的尺码表</button>
    </div></div>
    <div class="eds-modal size-chart-modal"><div class="eds-modal__mask" data-zero-layout>
      <h2 class="eds-modal__title">Add New Size Chart Of 上衣</h2>
      <input id="chart-name" type="text">
      <div class="mesurements">${Object.keys(rows[0]).map(label => `
        <label class="eds-checkbox">
          <input type="checkbox" checked${label === '尺寸（国际）' ? '' : ' disabled'}>
          <span class="size-chart-measurement-name">${label}</span>
        </label>`).join('')}
      </div>
      <div class="size-chart-info"><div class="unit">${select(['cm', 'inch'])}</div><div class="eds-table listing-edit-table">
        <table class="eds-table__fix-header eds-table__fix-left"><thead><tr>
          <th><span class="label-name">尺寸（美国）</span></th><th><span class="label-name">尺寸（国际）</span></th>
        </tr></thead></table>
        <table class="eds-table__main-header"><thead><tr><th><span class="label-name">胸围</span></th></tr></thead></table>
        <table class="eds-table__fix-body eds-table__fix-left"><tbody>${rows.map(() => `
          <tr><td>${select(['4', '16'])}</td><td>${select(['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'S', 'XXL'])}</td></tr>`).join('')}</tbody></table>
        <table class="eds-table__main-body"><tbody>
          ${rows.map(() => '<tr><td><input class="chest" type="text"></td></tr>').join('')}
        </tbody></table>
      </div></div>
      <div class="size-chart-edit-modal-footer">
        <button id="cancel" type="button">取消</button>
        <button id="chart-save" type="button">保存</button>
      </div>
    </div></div>
    <button id="listing-save" type="button">保存</button>
    <button id="listing-create" type="button">创建并发布</button>`,
  { url, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => window.close());
  const { document } = window;
  window.Element.prototype.getClientRects = function () {
    if (this.closest('[hidden]')) return [];
    if (this.closest('[data-zero-layout]')) return [{ width: 0, height: 0 }];
    return [{ width: 120, height: 28 }];
  };
  const $ = id => document.getElementById(id);
  const mask = document.querySelector('.eds-modal__mask');
  const clicks = { open: 0, chartSave: 0, listingSave: 0, listingCreate: 0 };
  $('open').addEventListener('click', () => {
    clicks.open++;
    mask.removeAttribute('data-zero-layout');
  });
  $('cancel').addEventListener('click', () => mask.setAttribute('data-zero-layout', ''));
  $('chart-save').addEventListener('click', () => {
    clicks.chartSave++;
    mask.setAttribute('data-zero-layout', '');
  });
  $('listing-save').addEventListener('click', () => clicks.listingSave++);
  $('listing-create').addEventListener('click', () => clicks.listingCreate++);
  for (const dropdown of document.querySelectorAll('.eds-select')) {
    const input = dropdown.querySelector('.eds-selector');
    const inner = dropdown.querySelector('.eds-selector__inner');
    const menu = dropdown.querySelector('.eds-select-popover-content');
    if (dropdown.closest('.listing-edit-table')) {
      menu.className = 'eds-popper listingUploadSizeChartSelectorPopper';
      document.body.append(menu);
    } else if (dropdown.closest('.unit')) {
      menu.className = 'eds-popper';
      const content = document.createElement('div');
      content.className = 'eds-select__menu';
      content.append(...menu.children);
      menu.append(content);
      document.body.append(menu);
    }
    const setMenuVisible = open => {
      menu.hidden = !open;
      dropdown.classList.toggle('is-show', open);
    };
    input.addEventListener('click', () => setMenuVisible(menu.hidden));
    for (const option of menu.querySelectorAll('.eds-option')) {
      option.addEventListener('click', () => {
        inner.textContent = option.textContent;
        inner.classList.remove('placeholder');
        setMenuVisible(false);
      });
    }
  }
  const run = window.eval(`(${operateShopeeSizeChart})`);
  return {
    document,
    clicks,
    act: (action, args = {}, tabUrl = url) => run({ action, category, ...args }, tabUrl),
  };
}

test('ignores a mounted chart root with a zero-area mask and opens only the exact chart control', async t => {
  const { document, act, clicks } = fixture(t);
  assert.equal(document.querySelector('.eds-modal.size-chart-modal').getClientRects()[0].height, 28);
  assert.equal(document.querySelector('.eds-modal__mask').getClientRects().length, 1);
  const before = await act('read');
  assert.equal(before.available, true);
  assert.equal(before.dialog, null);
  assert.equal((await act('save', { name, unit: 'inch', rows })).ok, false);
  assert.equal((await act('open', {}, url.replace('123', '999'))).code, 'page-changed');
  assert.equal((await act('open')).ok, true);
  const after = await act('read');
  assert.equal(after.dialog.kind, '上衣');
  assert.equal(after.dialog.rows.length, 2);
  assert.deepEqual(clicks, { open: 1, chartSave: 0, listingSave: 0, listingCreate: 0 });
});

test('fills both table sections, verifies decimal cells, and clicks only the chart Save', async t => {
  const { document, act, clicks } = fixture(t);
  await act('open');
  assert.equal((await act('set-name', { name })).ok, true);
  assert.equal((await act('set-unit', { unit: 'inch' })).ok, true);
  document.body.insertAdjacentHTML('beforeend',
    '<div class="eds-select-popover-content"><div class="eds-option">4</div></div>');
  const us = await act('column-options', { label: '尺寸（美国）' });
  assert.deepEqual(Array.from(us.options), ['4', '16']);
  assert.equal(document.querySelector('.listingUploadSizeChartSelectorPopper').parentElement, document.body);
  assert.equal(document.querySelector('.listing-edit-table .eds-select.is-show'), null);
  assert.equal((await act('fill-rows', { rows })).ok, true);
  const read = await act('read');
  assert.equal(read.dialog.rows[0].胸围, '37.80');
  assert.equal(read.dialog.rows[1]['尺寸（国际）'], 'XXL');
  assert.equal(read.dialog.rows[1]['尺寸（美国）'], '16');
  assert.equal((await act('create')).ok, false);
  const chest = document.querySelector('.chest');
  chest.value = '37.89';
  assert.equal((await act('save', { name, unit: 'inch', rows })).ok, false);
  assert.equal(clicks.chartSave, 0);
  chest.value = '37.8';
  assert.equal((await act('save', { name, unit: 'cm', rows })).ok, false);
  assert.equal((await act('save', { name, unit: 'inch', rows })).ok, true);
  assert.equal((await act('read')).dialog, null);
  assert.deepEqual(clicks, { open: 1, chartSave: 1, listingSave: 0, listingCreate: 0 });
});

test('refuses to click through an unrelated visible modal', async t => {
  const { document, act, clicks } = fixture(t);
  await act('open');
  document.body.insertAdjacentHTML('beforeend', '<div role="dialog">另一个弹窗</div>');
  assert.equal((await act('read')).code, 'modal');
  assert.equal((await act('dismiss')).code, 'modal');
  assert.deepEqual(clicks, { open: 1, chartSave: 0, listingSave: 0, listingCreate: 0 });
});

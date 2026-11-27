import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { clickCategoryRecommendation, clickListingControl, operateShopeeCategory, readPage } from '../page-state.mjs';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const url = 'https://seller.shopee.cn/portal/mtsku/new?cnsc_shop_id=123';
const category = '家居生活 > 居家收纳 > 收纳盒';

function fixture(t, markup) {
  const { window } = new JSDOM(markup, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => window.close());
  window.Element.prototype.getClientRects = function () {
    return this.closest('[hidden]') ? [] : [{ width: 120, height: 28 }];
  };
  const wrap = fn => (...args) => JSON.parse(JSON.stringify(window.eval(`(${fn})`)(...args)));
  return {
    document: window.document, window,
    read: wrap(readPage), category: wrap(operateShopeeCategory), choose: wrap(clickCategoryRecommendation),
    change: wrap(clickListingControl),
  };
}

function pickerMarkup() {
  return `<section class="product-basic-info"><div class="edit-row">
    <div class="product-category-box-inner" id="open"><div class="product-category-text"><span class="product-category-placeholder">Please set category</span></div></div>
  </div></section>
  <div class="eds-modal" id="picker" hidden><div class="eds-modal__mask"><div class="eds-modal__content">
    <div class="eds-modal__title">编辑类目</div>
    <div class="category-selector">
      <div class="category-search"><input placeholder="请输入至少 1 个字"></div>
      <div class="category-list">
        <ul class="scroll-item"><li class="category-item" id="root"><p class="text-overflow">家居生活</p><i class="category-item-right"></i></li></ul>
        <ul class="scroll-item" id="children" hidden><li class="category-item" id="parent"><p class="text-overflow">居家收纳</p><i class="category-item-right"></i></li></ul>
        <ul class="scroll-item" id="leaves" hidden><li class="category-item" id="leaf"><p class="text-overflow">收纳盒</p><div class="category-item-right"><i></i></div></li></ul>
      </div>
    </div>
    <div class="eds-modal__footer-buttons"><button id="confirm">Confirm</button><button>Cancel</button></div>
  </div></div></div><button id="publish">创建并发布</button>`;
}

test('matches and confirms a unique live category route, without touching listing publication', t => {
  const app = fixture(t, pickerMarkup());
  const { document } = app;
  const $ = id => document.getElementById(id);
  const picker = args => app.category(args, url);
  let confirms = 0;
  let published = 0;
  $('publish').onclick = () => published++;
  $('open').onclick = () => { $('picker').hidden = false; };
  $('root').onclick = () => { $('root').classList.add('selected'); $('children').hidden = false; };
  $('parent').onclick = () => { $('parent').classList.add('selected'); $('leaves').hidden = false; };
  $('leaf').onclick = () => { $('leaf').classList.add('selected'); };
  $('confirm').onclick = () => {
    confirms++;
    $('picker').hidden = true;
    document.querySelector('.product-category-text').textContent = category;
  };
  assert.equal(picker({ action: 'read' }).available, true);
  assert.equal(app.category({ action: 'open' }, url.replace('123', '999')).ok, false);
  assert.equal(picker({ action: 'open' }).ok, true);
  assert.equal(picker({ action: 'search', query: '收纳', expectedPath: [] }).ok, true);
  assert.equal(picker({ action: 'read' }).query, '收纳');
  assert.equal(picker({ action: 'select', level: 0, label: '家居生活', expectedPath: [] }).ok, true);
  assert.equal(picker({ action: 'confirm', category: '家居生活' }).ok, false);
  assert.equal(picker({ action: 'select', level: 1, label: '居家收纳', expectedPath: [] }).ok, false);
  assert.equal(picker({ action: 'select', level: 1, label: '居家收纳', expectedPath: ['家居生活'] }).ok, true);
  assert.equal(picker({ action: 'select', level: 2, label: '收纳盒', expectedPath: ['家居生活', '居家收纳'] }).ok, true);
  assert.deepEqual(picker({ action: 'read' }).selectedPath, category.split(' > '));
  assert.equal(picker({ action: 'confirm', category: '家居生活 > 居家收纳 > 收纳包' }).ok, false);
  assert.equal(picker({ action: 'confirm', category }).ok, true);
  assert.equal(app.read(category).category, category);
  assert.equal(picker({ action: 'open' }).ok, false);
  assert.deepEqual({ confirms, published }, { confirms: 1, published: 0 });
});

test('does not select category options when a modal intervenes or when the same label is ambiguous', t => {
  const app = fixture(t, pickerMarkup());
  const { document } = app;
  const picker = args => app.category(args, url);
  document.getElementById('picker').hidden = false;
  const other = document.createElement('div');
  other.setAttribute('role', 'dialog');
  document.body.append(other);
  assert.equal(picker({ action: 'read' }).code, 'modal');
  other.remove();
  const root = document.getElementById('root');
  root.after(root.cloneNode(true));
  assert.equal(picker({ action: 'select', level: 0, label: '家居生活', expectedPath: [] }).code, 'category-option-missing');
});

test('returns bindable recommendations without permitting duplicated or disabled candidates', t => {
  const radio = (path, attrs = '') => `<div class="category-select-radio" ${attrs}><i class="radio-indicator"></i><span class="radio-text">${path}</span></div>`;
  const app = fixture(t, `<section class="product-basic-info"><div class="edit-row"><span class="product-category-text">Please set category</span>
    <div class="recommend-category-container">${radio(category)}${radio('家居 > 重复')}${radio('家居 > 重复')}${radio('家居 > 已下架', 'aria-disabled="true"')}</div>
    <div>家居 > 裸文本</div></div></section>`);
  const state = app.read(category);
  assert.deepEqual(state.recommendations, [category, '家居 > 重复']);
  assert.deepEqual(state.categoryRecommendations, [{ path: category, selector: state.recommendation }]);
  assert.equal(app.choose(state.recommendation, category, url).ok, true);
  assert.equal(app.choose(state.recommendation, '家居 > 其他', url).ok, false);
});

test('reports scoped required markers and binds optional text, numeric, and multiselect values', t => {
  const app = fixture(t, `<div class="product-basic-info"><span class="product-category-text">${category}</span></div>
    <section class="product-specification-new">
      <div class="edit-row"><label class="edit-label"><span class="mandatory">*</span><span class="item-title-text">长度</span></label><input type="number" min="1" max="99"></div>
      <div class="edit-row"><label class="edit-label">材质</label><input type="text" maxlength="12"></div>
      <div class="edit-row"><label class="edit-label">适用场景</label><select multiple><option>书桌</option><option>书柜</option><option disabled>失效选项</option></select></div>
      <div class="edit-row"><label class="edit-label">仅保留包装</label><input type="checkbox"></div>
      <div class="edit-row"><label class="edit-label">真实下拉</label><div class="eds-select eds-select--multiple"><div class="eds-selector"><div class="eds-selector__inner"><span class="eds-tag__text">家居</span><input></div></div></div></div>
    </section>`);
  const { document } = app;
  const fields = () => Object.fromEntries(app.read(category).attributes.map(item => [item.label, item]));
  const current = fields();
  assert.equal(current['长度'].required, true);
  assert.equal(current['长度'].type, 'number');
  assert.equal(current['长度'].max, 99);
  assert.equal(current['材质'].required, false);
  assert.equal(current['材质'].type, 'text');
  assert.deepEqual(current['适用场景'].nativeOptions, ['书桌', '书柜']);
  assert.deepEqual(current['真实下拉'].value, ['家居']);
  assert.equal(current['仅保留包装'].value, false);
  const set = (label, value, pinned = category) => app.change({ action: 'attribute-set', label, category: pinned,
    selector: current[label].selector, value }, url);
  let changes = 0;
  document.querySelector('input[type=text]').onchange = () => changes++;
  assert.equal(set('材质', '纸', '家居 > 其他').ok, false);
  assert.equal(set('材质', '纸').ok, true);
  assert.equal(changes, 1);
  assert.equal(set('长度', 101).ok, false);
  assert.equal(set('长度', 10).ok, true);
  assert.equal(set('适用场景', ['书桌', '失效选项']).ok, false);
  assert.equal(set('适用场景', ['书桌', '书柜']).ok, true);
  assert.equal(set('仅保留包装', true).ok, true);
  assert.deepEqual(Object.values(fields()).map(item => item.value), ['10', '纸', ['书桌', '书柜'], true, ['家居']]);
});

test('counts a visible red CSS star without making hidden or non-red decoration required', t => {
  const row = (label, type) => `<div class="edit-row"><label class="edit-label" data-star="${type}">${label}</label><input type="text"></div>`;
  const app = fixture(t, `<section class="product-specification-new">${row('红色', 'visible')}${row('隐藏', 'hidden')}${row('装饰', 'decorative')}</section>`);
  const { window } = app;
  const style = window.getComputedStyle.bind(window);
  window.CSS = { supports: () => true };
  window.getComputedStyle = (el, pseudo) => {
    if (!pseudo) return style(el);
    return { content: '"*"', display: el.dataset.star === 'hidden' ? 'none' : 'inline', visibility: 'visible',
      color: el.dataset.star === 'decorative' ? 'rgb(30, 30, 30)' : 'rgb(238, 77, 45)' };
  };
  assert.deepEqual(app.read(category).attributes.map(({ label, required }) => [label, required]),
    [['红色', true], ['隐藏', false], ['装饰', false]]);
});

test('separates validation in the exact SKU and shipping controls from unrelated errors', t => {
  const { read } = fixture(t, `<section class="product-basic-info">
    <div class="product-category-text">${category}</div><p class="eds-form-item__error">请填写商品描述</p>
  </section><section class="product-sales-info">
    <div class="variation-name-panel"><input value="颜色"></div>
    <div class="variation-option-panel"><div class="options-item"><input value="蓝"></div></div>
    <div class="variation-model-table-fixed-left"><div class="variation-model-table-body">
      <div class="first-variation-cell">蓝</div>
    </div></div>
    <div class="variation-model-table-middle-scroll"><div class="variation-model-table-body"><div class="data-group">
      <div class="table-cell"><div class="model-edit-input"><div class="price-input"><input aria-invalid="true"></div></div>
        <div class="eds-input__error">全球商品价格不可空白</div></div>
    </div></div></div>
  </section><section class="mtsku-product-shipping">
    <div class="edit-row"><div class="edit-label">重量</div><input><p role="alert">重量不可空白</p></div>
  </section>`);
  const state = read(category);
  assert.equal(state.variant.rows[0].price, '');
  assert.deepEqual(state.unscopedValidation, ['请填写商品描述', '全球商品价格不可空白', '重量不可空白']);
  assert.deepEqual(state.validationOutsideSalesAndShipping, ['请填写商品描述']);
});

test('pins seller validation to the exact brand and shipping controls and ignores decorative red text', t => {
  const app = fixture(t, `<section class="product-basic-info">
    <div class="edit-row"><label class="edit-label"><span style="color:red">*</span><span>商品名称</span></label><input id="name"></div>
    <div class="edit-row"><label class="edit-label">商品描述</label><textarea required>已填写</textarea></div>
    <div class="edit-row"><label class="edit-label">* 商品类目</label><div class="product-category-text">${category}</div></div>
  </section><section class="product-specification-new">
    <div class="edit-row"><div class="edit-label"><span class="mandatory">*</span><span>品牌</span></div>
      <div class="eds-select"><div id="brand" class="eds-selector" style="border:1px solid red">
        <div class="eds-selector__inner">请选择</div></div></div>
      <small id="brand-error" style="color:red">请输入商品品牌名称</small>
    </div>
    <div class="edit-row"><label class="edit-label"><span style="color:red">*</span><span>等待解锁</span></label><input disabled required></div>
    <div class="edit-row"><label class="edit-label">颜色</label><input value="红色">
      <span style="color:red">节日推荐</span><span role="alert">编辑已保存</span></div>
  </section><section class="mtsku-product-shipping">
    <div class="edit-row"><div class="edit-label">* 重量</div><input value="0.10"></div>
    <div class="edit-row"><div class="edit-label">* 发货时间</div>
      <span>发货天数（您可以填写1,4到10）</span><input id="shipDays" value="0" style="border:1px solid red">
      <p id="days-error" style="color:red">Your days to ship is now out of range, please change it</p>
    </div>
  </section><p role="alert" style="color:red">2个错误需调整</p>`);
  assert.deepEqual(app.read(category).requiredIssues, [
    { section: 'category-attributes', key: '品牌', label: '品牌', kind: 'missing', message: '请输入商品品牌名称', value: '' },
    { section: 'basic', key: 'title', label: '商品名称', kind: 'missing', value: '' },
    { section: 'shipping', key: 'shipDays', label: '发货时间', kind: 'invalid',
      message: 'Your days to ship is now out of range, please change it', value: '0' },
  ]);
  const { document } = app;
  document.getElementById('name').value = '收纳盒';
  document.getElementById('brand').style.border = '';
  document.querySelector('#brand .eds-selector__inner').textContent = 'NoBrand';
  document.getElementById('brand-error').hidden = true;
  document.getElementById('shipDays').value = '4';
  document.getElementById('shipDays').style.border = '';
  document.getElementById('days-error').hidden = true;
  assert.deepEqual(app.read(category).requiredIssues, []);
  document.getElementById('shipDays').value = '2';
  assert.deepEqual(app.read(category).requiredIssues, [
    { section: 'shipping', key: 'shipDays', label: '发货时间', kind: 'invalid', value: '2' },
  ]);
});

test('detects required main media, a required missing SKU price, and a bad price with a red border', t => {
  const row = (price, invalid = '') => `<div class="data-group">
    <div class="table-cell"><div class="model-edit-input"><div class="price-input"><input value="${price}" ${invalid}></div></div></div>
    <div class="table-cell stock-column"><input value="0" required></div>
  </div>`;
  const { read } = fixture(t, `<section class="product-basic-info">
    <div class="product-category-text">${category}</div><div class="edit-row">
      <div class="edit-label">* 商品图片</div><div class="shopee-image-manager"><div class="shopee-image-manager__upload">
        <span class="shopee-image-manager__upload__content__text">添加图片 (0/9)</span><input type="file" accept="image/*">
      </div></div>
    </div>
  </section><section class="product-sales-info">
    <div class="variation-name-panel"><input value="颜色"></div>
    <div class="variation-option-panel"><div class="options-item"><input value="蓝"></div><div class="options-item"><input value="白"></div>
      <div class="options-item"><input value="粉"></div></div>
    <div class="variation-model-table-fixed-left"><div class="variation-model-table-body">
      <div class="first-variation-cell">蓝</div><div class="first-variation-cell">白</div><div class="first-variation-cell">粉</div>
    </div></div>
    <div class="variation-model-table-middle-scroll">
      <div class="variation-model-table-header"><div role="columnheader"><span style="color:red">*</span><span>全球商品价格</span></div></div>
      <div class="variation-model-table-body">
      ${row('15.01', 'style="border:1px solid red"')}${row('19.99')}${row('')}
    </div></div>
  </section>`);
  assert.deepEqual(read(category).requiredIssues, [
    { section: 'image', key: 'image', label: '商品图片', kind: 'missing', value: false },
    { section: 'sales', key: 'price', label: '全球商品价格', option: '蓝', kind: 'invalid', value: '15.01' },
    { section: 'sales', key: 'price', label: '全球商品价格', option: '粉', kind: 'missing', value: '' },
  ]);
});

test('resets only the sole variation control of the bound, unsaved product form', t => {
  const app = fixture(t, `<section class="product-basic-info">
    <div class="product-category-text">${category}</div>
    <div class="edit-row"><label class="edit-label">商品名称</label><input value="同款商品"></div>
  </section><section class="product-sales-info"><div class="variation-edit-item">
    <div class="variation-name-panel"><input value="颜色"></div>
    <div class="variation-option-panel"><div class="options-item"><input value="旧颜色"></div></div>
    <span class="variation-delete-btn" id="local">×</span>
  </div></section><span class="variation-delete-btn" id="other">×</span>`);
  const clicks = [];
  for (const control of app.document.querySelectorAll('.variation-delete-btn')) {
    control.onclick = () => clicks.push(control.id);
  }
  const args = { action: 'variant-reset', selector: '#local', category, label: '清除新表单预带规格', value: '同款商品',
    variantName: '颜色', variantOptions: ['旧颜色'] };
  assert.equal(app.change({ ...args, value: '错商品' }, url).ok, false);
  assert.equal(app.change({ ...args, selector: '#other' }, url).ok, false);
  assert.equal(app.change({ ...args, variantOptions: ['刚换掉的选项'] }, url).ok, false);
  assert.equal(app.change(args, url).ok, true);
  assert.deepEqual(clicks, ['local']);
});

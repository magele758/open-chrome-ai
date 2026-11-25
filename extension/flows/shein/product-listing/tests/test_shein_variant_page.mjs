import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { sheinVariantPage } from "../variant-page.js";

const href = "https://sellerhub.shein.com/#/spmp/commoditiesInfo?mode=add&last_page=page_commodities_category";
const categoryPath = ["家居&生活", "厨房&餐厅", "饮具", "真空瓶和保温杯"];
const product = {
  variantGroups: [{ name: "颜色", options: [{ value: "Black" }, { value: "白色" }] }],
  sites: ["美国站"],
};

function fixture(t, { preset = "", initial = [], duplicateWhite = false, secondSlot = false, searchable = false, addSecond = false } = {}) {
  const dom = new JSDOM(`<main>
    <div class="spmp_style__commodityCategoryItem--X"><span class="spmp_style__categoryInfo--X">家居&amp;生活 &gt; 厨房&amp;餐厅 &gt; 饮具 &gt; 真空瓶和保温杯</span></div>
    <div class="spec_info_body">
      <div id="main" class="spmp_style__specContentRow--X"></div>
      ${secondSlot ? '<div id="second" class="spmp_style__specContentRow--X"></div>' : ''}
      ${addSecond ? '<button id="add-spec">添加规格类型</button>' : ''}
    </div>
    <button id="other-add-spec">添加规格类型</button>
    <section class="so-form-item publish_site">
      <label class="so-checkinput so-checkinput-checkbox-container"><input type="checkbox">全选</label>
      <label class="so-checkinput so-checkinput-checkbox-container"><input type="checkbox">美国站</label>
      <label class="so-checkinput so-checkinput-checkbox-container"><input type="checkbox" checked>加拿大站</label>
    </section>
    <input id="unrelated" type="checkbox"><label for="unrelated">美国站</label>
    <button id="publish">发布商品</button><button id="save">保存草稿</button>
  </main>`, { url: href, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { document, HTMLElement } = dom.window;
  HTMLElement.prototype.getClientRects = function () {
    return this.closest("[hidden]") ? [] : [{ x: 1, y: 1, height: 20, width: 80 }];
  };
  const clicks = { publish: 0, save: 0, remove: 0, menus: 0 };
  const searches = [];
  for (const id of ["publish", "save"]) document.getElementById(id).onclick = () => clicks[id]++;

  const makeGroup = (id, label, type, values) => {
    let menu;
    const row = document.getElementById(id);
    const open = (role, choices, callback, search) => {
      if (menu?.isConnected) { menu.remove(); return; }
      menu = document.createElement('div');
      menu.className = 'so-list so-hidable so-hidable-animation-240 ' +
        (role === 'type' ? 'so-select-options so-select-control-keyboard' : 'so-select-box-list');
      const current = menu;
      clicks.menus++;
      const scroll = document.createElement('div');
      scroll.className = 'so-scroll-inner';
      const renderChoices = items => {
        scroll.replaceChildren();
        for (const [display, value] of items) {
          const item = document.createElement(role === 'type' ? 'a' : 'label');
          item.className = 'so-checkinput so-checkinput-radio-container so-select-option so-select-option-ltr';
          if (role === 'type') {
            item.href = '#';
            const title = document.createElement('span');
            title.className = 'salesGroupSelect__renderItemEllipsis--X';
            title.title = `${value} ${display.slice(value.length).replace(' 重要', '').trim()}`;
            title.textContent = display;
            item.append(title);
          }
          else {
            const english = document.createElement('span');
            english.className = 'salesGroupSelect__attrValRenderItemEnText--X';
            english.textContent = display.slice(value.length).trim();
            item.append(value, english);
          }
          item.onclick = () => {
            current.classList.remove('so-hidable-show');
            setTimeout(() => current.remove(), 240);
            callback(value);
            render();
          };
          scroll.append(item);
        }
      };
      current.append(scroll);
      setTimeout(() => {
        current.style.opacity = "1";
        current.classList.add('so-hidable-show');
        renderChoices(choices);
      }, 160);
      if (search) search.oninput = () => {
        searches.push(search.textContent);
        current.setAttribute('aria-busy', 'true');
        setTimeout(() => {
          renderChoices([["粉色 Pink", "粉色"], ["浅粉色 Light Pink", "浅粉色"]]);
          current.removeAttribute('aria-busy');
        }, 350);
      };
      current.style.opacity = "0";
      document.body.append(current);
    };
    const render = () => {
      row.replaceChildren();
      const heading = document.createElement('label');
      heading.className = 'spmp_style__specContentLabel--X';
      heading.textContent = label;
      row.append(heading);
      const typeControl = document.createElement('div');
      typeControl.className = 'so-select spmp_style__specAttrSelect--X';
      typeControl.innerHTML = type
        ? `<div class="so-select-result">${type}<span>重要</span></div>`
        : '<div class="so-select-result so-select-empty"><input placeholder="请选择"></div>';
      typeControl.firstChild.onclick = () => open("type", [["颜色Color 重要", "颜色"], ["尺码Size", "尺码"]], value => { type = value; });
      row.append(typeControl);
      if (!type) return;
      for (const item of values) {
        const selected = document.createElement('div');
        selected.className = 'so-select';
        selected.innerHTML = `<div class="so-select-result"><input class="so-select-input" title="${item}"><button class="remove">删除</button></div>`;
        selected.querySelector(".remove").onclick = () => clicks.remove++;
        row.append(selected);
      }
      const empty = document.createElement('div');
      empty.className = 'so-select';
      empty.innerHTML = '<div class="so-select-result so-select-empty"><div class="so-input-placeholder so-select-ellipsis"><span>请选择或自定义</span></div></div>';
      if (searchable) empty.firstChild.insertAdjacentHTML('beforeend', '<div class="so-select-input" contenteditable="true" tabindex="0">﻿</div>');
      const colors = [["黑色 Black", "黑色"], ["白色 White", "白色"], ...(duplicateWhite ? [["白色 White", "白色"]] : [])];
      empty.firstChild.onclick = event => {
        const search = empty.querySelector('[contenteditable]');
        if (event.target !== search) open("value", type === "颜色" ? colors : [["均码 One Size", "均码"]], value => values.push(value), search);
      };
      row.append(empty);
    };
    render();
  };
  makeGroup("main", "* 主规格", preset, [...initial]);
  if (secondSlot) makeGroup("second", "规格类型2", "", []);
  const testAdditions = [];
  const add = document.getElementById('add-spec');
  if (add) add.onclick = () => {
    testAdditions.push('scope');
    setTimeout(() => {
      add.insertAdjacentHTML('beforebegin', '<div id="second" class="spmp_style__specContentRow--X"></div>');
      makeGroup('second', '规格类型2', '', []);
      add.remove();
    }, 220);
  };
  document.getElementById('other-add-spec').onclick = () => testAdditions.push('other');
  const run = async (args = {}) => {
    const result = await dom.window.eval(`(${sheinVariantPage})(${JSON.stringify({ href, categoryPath, ...args })})`);
    return JSON.parse(JSON.stringify(result));
  };
  return { run, clicks, document, searches, testAdditions };
}

test("waits for current legacy dropdown options, reads each selected chip, and checks exact sites", async t => {
  const { run, clicks, document } = fixture(t);
  const result = await run({ kind: "fill", input: product });
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.groups, [{ label: "主规格", name: "颜色", values: ["黑色", "白色"], matches: [
    { requested: "Black", value: "黑色" }, { requested: "白色", value: "白色" },
  ] }]);
  assert.deepEqual(result.sites, [{ name: "美国站", checked: true }, { name: "加拿大站", checked: true }]);
  assert.equal(document.querySelector("#unrelated").checked, false);
  assert.deepEqual(clicks, { publish: 0, save: 0, remove: 0, menus: 3 });
  const second = await run({ kind: "fill", input: product });
  assert.equal(second.items.every(item => item.status === "unchanged"), true);
  assert.deepEqual(second.groups[0].values, ["黑色", "白色"]);
  assert.equal(clicks.menus, 4);
});

test("preserves existing specs and reports ambiguous options and missing secondary slots", async t => {
  const { run, clicks } = fixture(t, { preset: "颜色", initial: ["黑色"], duplicateWhite: true });
  const result = await run({ kind: "fill", input: { ...product,
    variantGroups: [...product.variantGroups, { name: "尺码", options: [{ value: "均码" }] }], sites: ["英国站"] } });
  assert.deepEqual(result.groups[0].values, ["黑色"]);
  assert.deepEqual(result.issues.map(item => item.code), ["OPTION_AMBIGUOUS", "SPEC_CONTROL_MISSING", "SITE_MISSING"]);
  assert.equal(clicks.remove, 0);
});

test("uses a secondary spec control only when it exists on this page", async t => {
  const { run } = fixture(t, { preset: "颜色", initial: ["黑色"], secondSlot: true });
  const result = await run({ kind: "fill", input: { variantGroups: [
    { name: "颜色", options: [{ value: "Black" }] }, { name: "尺码", options: [{ value: "均码" }] },
  ] } });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.groups[1], { label: "规格类型2", name: "尺码", values: ["均码"], matches: [{ requested: "均码", value: "均码" }] });
});

test("reads the explicit no-multicolor message only from the specifications section", async t => {
  const { run, document } = fixture(t, { preset: "默认" });
  const message = "无主规格发品，默认生成1个SKC，不支持复色，仅支持加码";
  document.querySelector("main").append(message);
  assert.equal((await run()).defaultOnly, false);
  document.querySelector(".spec_info_body").append(message);
  assert.equal((await run()).defaultOnly, true);
});

test("reloads absent default-SKC tables by restoring the sole selected native site", async t => {
  const { run, document } = fixture(t, { preset: "默认" });
  document.querySelector(".spec_info_body").append("无主规格发品，默认生成1个SKC，不支持复色，仅支持加码");
  const media = Object.assign(document.createElement("div"), { className: "detail_img_container" });
  document.querySelector("main").append(media);
  const [selectAll, us, canada] = document.querySelectorAll(".publish_site input");
  const changes = [];
  const request = { kind: "refreshSite", input: { sites: ["美国站"] } };
  us.checked = true;
  us.onchange = () => {
    changes.push(us.checked);
    if (us.checked) media.innerHTML = '<div class="so-table">图片</div>';
  };

  assert.equal((await run(request)).code, "SITE_REFRESH_NOT_NEEDED");
  canada.checked = false;
  const refreshed = await run(request);
  assert.equal(refreshed.ok, true);
  assert.deepEqual(changes, [false, true]);
  assert.deepEqual(refreshed.sites, [{ name: "美国站", checked: true }, { name: "加拿大站", checked: false }]);
  assert.equal(selectAll.checked, false);
  assert.equal((await run(request)).code, "SITE_REFRESH_NOT_NEEDED");
  assert.deepEqual(changes, [false, true]);
});

test("adds a requested secondary group through the in-form control and waits for its newly rendered selectors", async t => {
  const { run, testAdditions } = fixture(t, { preset: "颜色", initial: ["黑色"], addSecond: true });
  const result = await run({ kind: "fill", input: { variantGroups: [
    { name: "颜色", options: [{ value: "黑色" }] }, { name: "尺码", options: [{ value: "均码" }] },
  ] } });
  assert.deepEqual(testAdditions, ["scope"]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.groups.map(({ values }) => values), [["黑色"], ["均码"]]);
});

test("searches the live contenteditable specification control and selects the exact full color", async t => {
  const { run, searches } = fixture(t, { preset: "颜色", initial: ["黑色"], searchable: true });
  const result = await run({ kind: "fill", input: { variantGroups: [{ name: "颜色", options: [
    { value: "黑色" }, { value: "白色" }, { value: "粉色" },
  ] }] } });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(searches, ["粉色"]);
  assert.deepEqual(result.groups[0].values, ["黑色", "白色", "粉色"]);
});

test("requires a matching new editor and blocks writes under an unrelated dialog", async t => {
  const { run, clicks, document } = fixture(t);
  assert.equal((await run({ href: href.replace('mode=add', 'mode=edit'), kind: "fill", input: product })).code, "PAGE_CHANGED");
  assert.equal((await run({ kind: "fill", categoryPath: ["错误分类"], input: product })).code, "CATEGORY_CHANGED");
  const dialog = document.createElement('div');
  dialog.setAttribute('aria-modal', 'true');
  document.body.append(dialog);
  assert.equal((await run({ kind: "fill", input: product })).code, "MODAL_BLOCKED");
  assert.equal(clicks.menus, 0);
});

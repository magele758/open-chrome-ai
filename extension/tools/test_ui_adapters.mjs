import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  ANTD_ADAPTER,
  ARIA_NATIVE_ADAPTER,
  ARIA_NATIVE_SPEC,
  DEFAULT_COMPOSITE_ADAPTER_SPEC,
  ELEMENT_PLUS_ADAPTER,
  composeUIAdapterSpec,
  listUIAdapters,
} from "../lib/agent/ui-adapters/index.js";
import { isFileUploadTrigger } from "../lib/agent/policy-guard.js";
import { completeSelectOption, listControls, pageAct, prepareSelectOption } from "../lib/agent/page-fns.js";
import { locateElement } from "../lib/agent/page-snapshot.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

// 1. 注册表顺序与 aria-native 纯净度断言
{
  const adapters = listUIAdapters();
  assert.equal(adapters[0].id, "aria-native", "aria-native must have highest priority");
  assert.ok(adapters.some((a) => a.id === "antd"));
  assert.ok(adapters.some((a) => a.id === "element-plus"));

  const ariaSerialized = JSON.stringify(ARIA_NATIVE_SPEC);
  assert.ok(!/\b(?:ant-|el-|rc-)/.test(ariaSerialized), "ARIA_NATIVE_SPEC must not contain framework classes");
}

function createVisualDom(html) {
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url: "https://portal.example.test/workspace",
  });
  const { window: win } = dom;
  const { document: doc } = win;

  const rectOf = (el) => {
    const raw = el.getAttribute?.("data-r");
    if (!raw) return { x: 20, y: 20, width: 120, height: 28, top: 20, left: 20, right: 140, bottom: 48 };
    const [x, y, width, height] = raw.split(",").map(Number);
    return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height };
  };
  win.Element.prototype.getBoundingClientRect = function () {
    return rectOf(this);
  };
  win.Element.prototype.scrollIntoView = function () {};
  Object.defineProperty(win.HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent;
    },
  });
  Object.defineProperty(win, "innerWidth", { value: 1280 });
  Object.defineProperty(win, "innerHeight", { value: 800 });
  doc.elementFromPoint = (x, y) => {
    const hits = [...doc.querySelectorAll("*")].filter((el) => {
      for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
        if (cur.hidden) return false;
        const st = win.getComputedStyle(cur);
        if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
      }
      const r = rectOf(el);
      return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
    return hits.at(-1) || doc.body;
  };
  return { dom, win, doc };
}

// 2. 五类组件契约在三套框架夹具（aria-native / antd / element-plus）下的同构矩阵验证
const MATRIX_FIXTURES = [
  {
    name: "aria-native",
    adapter: ARIA_NATIVE_ADAPTER,
    spec: composeUIAdapterSpec(["aria-native"]),
    html: `<!doctype html><html><body>
      <button id="bg-btn" data-r="20,20,100,30">背景按钮</button>
      <dialog id="dlg" open aria-labelledby="dlg-title" data-r="80,60,800,600">
        <h2 id="dlg-title" data-r="100,70,200,28">通用配置弹窗</h2>
        <fieldset data-r="100,120,360,70">
          <label for="native-select" data-r="100,120,80,22">运行环境</label>
          <select id="native-select" data-r="100,150,200,30">
            <option value="dev">开发环境</option>
            <option value="stg" selected>预发环境</option>
          </select>
        </fieldset>
        <fieldset data-r="100,200,360,70">
          <legend data-r="100,200,80,22">通知渠道</legend>
          <div id="combo" role="combobox" aria-expanded="false" aria-controls="combo-popup" data-r="100,230,240,30">
            <input id="combo-inp" role="combobox" aria-controls="combo-popup" type="search" value="" data-r="104,232,200,26" />
          </div>
        </fieldset>
        <ul id="combo-popup" role="listbox" style="display:none; overflow-y:auto" data-r="100,264,240,120">
          <li role="option" aria-selected="true" data-r="100,266,220,28">邮件通知</li>
          <li role="option" aria-selected="false" data-r="100,296,220,28">站内消息</li>
        </ul>
        <div id="cascader-popup" data-r="400,200,360,140">
          <ul role="menu" data-r="400,200,170,140">
            <li id="cas-l1" role="menuitemcheckbox" aria-expanded="true" data-r="400,204,160,28">研发部</li>
          </ul>
          <ul role="menu" data-r="580,200,170,140">
            <li id="cas-l2" role="menuitemcheckbox" data-r="580,204,160,28">平台组</li>
          </ul>
        </div>
        <table id="data-tbl" data-r="100,360,600,120">
          <tbody>
            <tr id="row-valid" data-r="100,390,600,32"><td>ITEM-01</td><td>常规条目</td></tr>
            <tr id="row-empty" data-empty="true" data-r="100,425,600,32"><td colspan="2">暂无记录</td></tr>
          </tbody>
        </table>
        <div id="upload-area" data-r="100,500,300,80">
          <button id="upload-trig" type="button" data-r="100,500,120,32">
            <input type="file" style="display:none" />上传附件
          </button>
          <div role="list" data-upload-list="true" data-r="100,540,260,28">
            <button id="upload-rm" type="button" data-r="280,540,60,26">删除附件</button>
          </div>
        </div>
      </dialog>
    </body></html>`,
    expectedSelectedCombo: ["邮件通知"],
  },
  {
    name: "antd",
    adapter: ANTD_ADAPTER,
    spec: composeUIAdapterSpec(["aria-native", "antd"]),
    html: `<!doctype html><html><body>
      <button id="bg-btn" data-r="20,20,100,30">背景按钮</button>
      <div class="ant-modal-wrap" style="z-index:1000" data-r="0,0,1280,800">
        <div id="dlg" class="ant-modal" data-r="80,60,800,600">
          <div class="ant-modal-title" data-r="100,70,200,28">通用配置弹窗</div>
          <div class="ant-form-item" data-r="100,200,360,70">
            <div class="ant-form-item-label" data-r="100,200,80,22"><label>通知渠道</label></div>
            <div id="combo" class="ant-select ant-select-multiple ant-select-show-search" data-r="100,230,240,30">
              <div class="ant-select-selector" data-r="100,230,240,30">
                <span class="ant-select-selection-item" title="邮件通知">
                  <span class="ant-select-selection-item-content">邮件通知</span>
                  <span class="ant-select-selection-item-remove">×</span>
                </span>
                <input id="combo-inp" class="ant-select-selection-search-input" role="combobox" aria-controls="rc_list" type="search" data-r="180,232,50,24" />
              </div>
            </div>
          </div>
          <div id="cascader-popup" class="ant-select-dropdown ant-cascader-dropdown" data-r="400,200,360,140">
            <ul class="ant-cascader-menu" data-r="400,200,170,140">
              <li id="cas-l1" class="ant-cascader-menu-item ant-cascader-menu-item-active" data-r="400,204,160,28">研发部</li>
            </ul>
            <ul class="ant-cascader-menu" data-r="580,200,170,140">
              <li id="cas-l2" class="ant-cascader-menu-item" data-r="580,204,160,28">平台组</li>
            </ul>
          </div>
          <table id="data-tbl" data-r="100,360,600,120">
            <tbody>
              <tr id="row-valid" class="ant-table-row" data-r="100,390,600,32"><td class="ant-table-cell">ITEM-01</td><td class="ant-table-cell">常规条目</td></tr>
              <tr id="row-empty" class="ant-table-placeholder" data-r="100,425,600,32"><td colspan="2">暂无数据</td></tr>
            </tbody>
          </table>
          <span class="ant-upload-wrapper" data-r="100,500,300,80">
            <span id="upload-trig" class="ant-upload" data-r="100,500,120,32">
              <input type="file" style="display:none" />
              <button type="button" data-r="100,500,120,32">上传附件</button>
            </span>
            <div class="ant-upload-list" data-r="100,540,260,28">
              <button id="upload-rm" type="button" data-r="280,540,60,26">删除附件</button>
            </div>
          </span>
        </div>
      </div>
      <div id="combo-popup" class="ant-select-dropdown ant-select-dropdown-hidden" data-r="100,264,240,120">
        <div id="rc_list" role="listbox"></div>
        <div class="ant-select-item ant-select-item-option" title="站内消息" data-r="100,266,220,28">
          <div class="ant-select-item-option-content">站内消息</div>
        </div>
      </div>
    </body></html>`,
    expectedSelectedCombo: ["邮件通知"],
  },
  {
    name: "element-plus",
    adapter: ELEMENT_PLUS_ADAPTER,
    spec: composeUIAdapterSpec(["aria-native", "element-plus"]),
    html: `<!doctype html><html><body>
      <button id="bg-btn" data-r="20,20,100,30">背景按钮</button>
      <div class="el-overlay-dialog" style="z-index:2000" data-r="0,0,1280,800">
        <div id="dlg" class="el-dialog" data-r="80,60,800,600">
          <div class="el-dialog__header"><span class="el-dialog__title" data-r="100,70,200,28">通用配置弹窗</span></div>
          <div class="el-dialog__body" data-r="90,110,780,460">
            <div class="el-form-item" data-r="100,200,360,70">
              <label class="el-form-item__label" data-r="100,200,80,22">通知渠道</label>
              <div id="combo" class="el-select" data-r="100,230,240,30">
                <div class="el-select__wrapper" data-r="100,230,240,30">
                  <span class="el-select__tags-text">邮件通知<i class="el-tag__close">×</i></span>
                  <input id="combo-inp" class="el-select__input" type="text" aria-controls="el_list" data-r="180,232,50,24" />
                </div>
              </div>
            </div>
            <div id="cascader-popup" class="el-cascader__dropdown" data-r="400,200,360,140">
              <div class="el-cascader-menu" data-r="400,200,170,140">
                <div id="cas-l1" class="el-cascader-node in-active-path" data-r="400,204,160,28">研发部</div>
              </div>
              <div class="el-cascader-menu" data-r="580,200,170,140">
                <div id="cas-l2" class="el-cascader-node" data-r="580,204,160,28">平台组</div>
              </div>
            </div>
            <table id="data-tbl" data-r="100,360,600,120">
              <tbody>
                <tr id="row-valid" class="el-table__row" data-r="100,390,600,32"><td class="el-table__cell">ITEM-01</td><td class="el-table__cell">常规条目</td></tr>
                <tr id="row-empty" class="el-table__empty-block" data-r="100,425,600,32"><td colspan="2">暂无数据</td></tr>
              </tbody>
            </table>
            <div class="el-upload-container" data-r="100,500,300,80">
              <div id="upload-trig" class="el-upload" data-r="100,500,120,32">
                <input type="file" style="display:none" />
                <button type="button" data-r="100,500,120,32">上传附件</button>
              </div>
              <ul class="el-upload-list" data-r="100,540,260,28">
                <li><button id="upload-rm" type="button" data-r="280,540,60,26">删除附件</button></li>
              </ul>
            </div>
          </div>
        </div>
      </div>
      <div id="combo-popup" class="el-select-dropdown" style="display:none" data-r="100,264,240,120">
        <ul id="el_list">
          <li class="el-select-dropdown__item" data-r="100,266,220,28">站内消息</li>
        </ul>
      </div>
    </body></html>`,
    expectedSelectedCombo: ["邮件通知"],
  },
];

for (const fx of MATRIX_FIXTURES) {
  const { dom, win, doc } = createVisualDom(fx.html);
  try {
    // (a) Modal 契约：识别 <dialog open> / .ant-modal / .el-dialog，且弹窗控件优先于背景按钮
    const controls = JSON.parse(
      JSON.stringify(win.eval(`(${listControls.toString()})(80, ${JSON.stringify(fx.spec)})`)),
    );
    assert.ok(controls.length > 0, `[${fx.name}] listControls returns visible controls`);
    assert.equal(controls[0].modal, true, `[${fx.name}] modal controls prioritized ahead of background button`);

    // (b) Combobox 契约：原生 <select> 与 aria-selected / 自定义标签幂等已选回读
    const comboEl = doc.getElementById("combo");
    assert.deepEqual(
      fx.adapter.combobox.readSelectedLabels(comboEl),
      fx.expectedSelectedCombo,
      `[${fx.name}] adapter.combobox.readSelectedLabels reads selected items`,
    );

    const idemRes = await win.eval(
      `(${prepareSelectOption.toString()})(${JSON.stringify({
        label: "通知渠道",
        value: "邮件通知",
        adapterSpec: fx.spec,
      })})`,
    );
    assert.equal(idemRes.ok, true, `[${fx.name}] prepareSelectOption idempotent check ok`);
    assert.equal(idemRes.alreadySelected, true, `[${fx.name}] prepareSelectOption detects alreadySelected`);

    if (fx.name === "aria-native") {
      const nativeSel = doc.getElementById("native-select");
      assert.deepEqual(fx.adapter.combobox.readSelectedLabels(nativeSel), ["预发环境"]);
      const pickNative = await win.eval(
        `(${prepareSelectOption.toString()})(${JSON.stringify({
          label: "运行环境",
          value: "开发环境",
          adapterSpec: fx.spec,
        })})`,
      );
      assert.equal(pickNative.ok, true);
      assert.equal(pickNative.value, "dev");
      assert.deepEqual(fx.adapter.combobox.readSelectedLabels(nativeSel), ["开发环境"]);
    }

    // (c) Cascader 契约：多列识别与展开态判定
    const casPopup = doc.getElementById("cascader-popup");
    const cols = fx.adapter.cascader.findColumns(casPopup);
    assert.equal(cols.length, 2, `[${fx.name}] cascader finds 2 columns`);
    assert.equal(
      fx.adapter.cascader.isExpandedItem(doc.getElementById("cas-l1")),
      true,
      `[${fx.name}] cascader identifies active/expanded item`,
    );
    assert.equal(
      fx.adapter.cascader.isExpandedItem(doc.getElementById("cas-l2")),
      false,
      `[${fx.name}] cascader identifies leaf item as not expanded`,
    );

    // (d) Table 契约：有效数据行与空态占位行区分
    assert.equal(
      fx.adapter.table.isEmptyPlaceholder(doc.getElementById("row-valid")),
      false,
      `[${fx.name}] valid row is not empty placeholder`,
    );
    assert.equal(
      fx.adapter.table.isEmptyPlaceholder(doc.getElementById("row-empty")),
      true,
      `[${fx.name}] placeholder row detected`,
    );

    // (e) Upload 契约：上传触发器命中拦截，而已上传列表内的删除按钮放行
    const uploadTrig = doc.getElementById("upload-trig");
    const uploadRm = doc.getElementById("upload-rm");
    assert.equal(isFileUploadTrigger(uploadTrig, fx.spec), true, `[${fx.name}] upload trigger detected`);
    assert.equal(isFileUploadTrigger(uploadRm, fx.spec), false, `[${fx.name}] uploaded list remove button not blocked`);

    const blockedClick = await win.eval(
      `(${pageAct.toString()})("click", ${JSON.stringify({ selector: "#upload-trig", adapterSpec: fx.spec })})`,
    );
    assert.equal(blockedClick.ok, false, `[${fx.name}] pageAct blocks upload trigger by default`);
    assert.equal(blockedClick.blockedFileChooser, true);

    const allowedRm = await win.eval(
      `(${pageAct.toString()})("click", ${JSON.stringify({ selector: "#upload-rm", adapterSpec: fx.spec })})`,
    );
    assert.equal(allowedRm.ok, true, `[${fx.name}] pageAct allows remove button inside upload list`);
  } finally {
    dom.window.close();
  }
}

// 3. 通用虚拟滚动容器查找（零 .rc-virtual-list-holder / .el-scrollbar__wrap 类名依赖）
{
  const { dom, win, doc } = createVisualDom(`<!doctype html><html><body>
    <label for="v-combo" data-r="40,40,80,24">区域列表</label>
    <div id="v-combo" role="combobox" aria-expanded="true" aria-controls="v-popup" data-r="40,70,220,30">
      <input id="v-inp" role="combobox" aria-controls="v-popup" readonly style="opacity:0" data-r="0,0,0,0" />
    </div>
    <div id="v-popup" role="listbox" data-r="40,104,220,120">
      <div id="generic-virtual-viewport" style="overflow-y: auto" data-r="40,104,220,120"></div>
    </div>
  </body></html>`);
  try {
    const viewport = doc.getElementById("generic-virtual-viewport");
    const allItems = Array.from({ length: 15 }, (_, i) => `分区-${i + 1}`);
    Object.defineProperty(viewport, "scrollHeight", { value: 600, configurable: true });
    Object.defineProperty(viewport, "clientHeight", { value: 120, configurable: true });

    const renderSlice = (top) => {
      const start = Math.min(allItems.length - 3, Math.floor(top / 40));
      viewport.innerHTML = "";
      allItems.slice(start, start + 3).forEach((label, idx) => {
        const opt = doc.createElement("div");
        opt.setAttribute("role", "option");
        opt.setAttribute("aria-selected", "false");
        opt.setAttribute("data-r", `40,${106 + idx * 32},200,28`);
        opt.textContent = label;
        opt.addEventListener("click", () => {
          opt.setAttribute("aria-selected", "true");
          doc.getElementById("v-combo").setAttribute("aria-expanded", "false");
        });
        viewport.appendChild(opt);
      });
    };
    renderSlice(0);
    viewport.scrollTo = function ({ top }) {
      this.scrollTop = top;
      renderSlice(top);
    };

    const prep = await win.eval(
      `(${prepareSelectOption.toString()})(${JSON.stringify({
        selector: "#v-combo",
        value: "分区-12",
        adapterSpec: ARIA_NATIVE_SPEC,
      })})`,
    );
    assert.equal(prep.ok, true);
    const comp = await win.eval(
      `(${completeSelectOption.toString()})(${JSON.stringify({
        uid: prep.uid,
        value: "分区-12",
        stage: "select",
        adapterSpec: ARIA_NATIVE_SPEC,
      })})`,
    );
    assert.equal(comp.ok, true, `generic virtual scroll should find 分区-12, got ${JSON.stringify(comp)}`);
    assert.deepEqual([...comp.selected], ["分区-12"]);

    // 验证 locateElement 在合成描述符下同样正常工作
    const loc = win.eval(
      `(${locateElement.toString()})(${JSON.stringify({
        selector: "#v-combo",
        adapterSpec: DEFAULT_COMPOSITE_ADAPTER_SPEC,
      })})`,
    );
    assert.equal(loc.ok, true);
  } finally {
    dom.window.close();
  }
}

console.log("test_ui_adapters: PASS (3 frameworks x 5 component contracts + generic virtual scroll)");

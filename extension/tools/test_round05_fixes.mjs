import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { completeSelectOption, pageAct, prepareSelectOption, scrollPage } from "../lib/agent/page-fns.js";
import { createAgentTools } from "../lib/agent/tools.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const dom = new JSDOM(
  `<!doctype html><html><body>
    <!-- 背景页同名筛选器，验证弹窗优先作用域 -->
    <div class="page-filter" data-r="20,10,400,40">
      <div class="ant-form-item" data-r="20,10,300,36">
        <div class="ant-form-item-label" data-r="20,10,60,32"><label>店铺</label></div>
        <div id="bg-store-select" class="ant-select ant-select-single" data-r="90,10,180,32">
          <div class="ant-select-selector" data-r="90,10,180,32">
            <span class="ant-select-selection-item" title="背景错误店铺">背景错误店铺</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 顶层编辑弹窗（无 <label> 的自定义属性容器 + 成分子表含同名表头 th=材质） -->
    <div id="edit-modal" class="ant-modal" role="dialog" aria-modal="true" style="z-index: 1000" data-r="100,40,900,760">
      <div class="ant-modal-header" data-r="100,40,900,48"><div class="ant-modal-title" data-r="120,50,200,28">编辑面板</div></div>
      <div class="ant-modal-body" data-r="100,90,900,660">
        <!-- 字段 0: 成分（含提示文案与内部表格列头 th=材质，验证不会抢匹配 label='材质'） -->
        <div id="field-comp" class="custom-attr__field" data-r="120,110,820,140">
          <div class="custom-attr__label" data-r="120,110,400,24">
            <span class="custom-attr__required">*</span>
            <span>成分</span>
            <span class="custom-attr__hint">（所有比例之和需等于100%）</span>
          </div>
          <table data-r="120,140,600,80">
            <thead><tr><th data-r="120,140,160,28">材质</th></tr></thead>
            <tbody>
              <tr>
                <td>
                  <div id="comp-row-select" class="ant-select ant-select-single ant-select-show-search" data-r="120,172,160,32">
                    <div class="ant-select-selector" data-r="120,172,160,32">
                      <input id="rc_comp" type="search" role="combobox" aria-controls="rc_comp_list" data-r="120,172,140,28" />
                      <span class="ant-select-selection-placeholder">请选择</span>
                    </div>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 字段 1: * 材质（无 <label> 标签，多选可搜索下拉） -->
        <div id="field-mat" class="custom-attr__field" data-r="120,270,360,72">
          <div class="custom-attr__label" data-r="120,270,120,22">
            <span class="custom-attr__required">*</span>
            <span>材质</span>
          </div>
          <div id="mat-select" class="ant-select ant-select-multiple ant-select-show-search" data-r="120,300,280,32">
            <div id="mat-selector" class="ant-select-selector" data-r="120,300,280,32">
              <input id="rc_mat" type="search" role="combobox" aria-controls="rc_mat_list" data-r="124,302,80,24" />
            </div>
          </div>
        </div>

        <!-- 字段 2: * 细节（单选可搜索下拉） -->
        <div id="field-detail" class="custom-attr__field" data-r="520,270,360,72">
          <div class="custom-attr__label" data-r="520,270,120,22">
            <span>*</span><span>细节</span>
          </div>
          <div id="detail-select" class="ant-select ant-select-single ant-select-show-search" data-r="520,300,280,32">
            <div id="detail-selector" class="ant-select-selector" data-r="520,300,280,32">
              <input id="rc_detail" type="search" role="combobox" aria-controls="rc_detail_list" data-r="524,302,80,24" />
            </div>
          </div>
        </div>

        <!-- 字段 3: * 护理说明（验证「手洗」精确命中而非前缀「手洗或干洗」） -->
        <div id="field-care" class="custom-attr__field" data-r="120,360,360,72">
          <div class="custom-attr__label" data-r="120,360,120,22"><span>*</span><span>护理说明</span></div>
          <div id="care-select" class="ant-select ant-select-single" data-r="120,390,280,32">
            <div id="care-selector" class="ant-select-selector" data-r="120,390,280,32">
              <input id="rc_care" type="search" role="combobox" aria-controls="rc_care_list" readonly style="opacity: 0" data-r="0,0,0,0" />
            </div>
          </div>
        </div>

        <!-- 字段 4: 弹窗内「店铺」（验证遮蔽背景页同名 label） -->
        <div class="ant-form-item" data-r="520,360,360,72">
          <div class="ant-form-item-label" data-r="520,360,80,24"><label>店铺</label></div>
          <div id="modal-store-select" class="ant-select ant-select-multiple" data-r="520,390,280,32">
            <div class="ant-select-selector" data-r="520,390,280,32">
              <span class="ant-select-selection-item" title="Alpha Store">Alpha Store<span class="ant-select-selection-item-remove">×</span></span>
            </div>
          </div>
        </div>

        <!-- 字段 5: 原生 select 与 InputNumber -->
        <select id="native-sel" data-r="120,460,160,30">
          <option value="a">选项A</option>
          <option value="b">选项B</option>
        </select>
        <input id="num-input" type="text" placeholder="数值框" data-r="320,460,120,30" />
      </div>
    </div>

    <!-- 浮层下拉列表（含 AntD 0x0 读屏无障碍隐藏 role=option 与真实可见 .ant-select-item-option） -->
    <div id="dd-mat" class="ant-select-dropdown ant-select-dropdown-hidden" data-r="120,334,280,200">
      <div id="rc_mat_list" role="listbox" style="height: 0px; width: 0px; overflow: hidden" data-r="0,0,0,0">
        <div role="option" aria-label="针织样式" data-r="0,0,0,0">针织样式</div>
      </div>
      <div class="rc-virtual-list" data-r="120,334,280,200">
        <div id="mat-opt-holder" data-r="120,334,280,200"></div>
      </div>
    </div>

    <div id="dd-detail" class="ant-select-dropdown ant-select-dropdown-hidden" data-r="520,334,280,160">
      <div id="rc_detail_list" role="listbox" data-r="0,0,0,0"></div>
      <div id="detail-opt-holder" data-r="520,334,280,160"></div>
    </div>

    <div id="dd-care" class="ant-select-dropdown ant-select-dropdown-hidden" data-r="120,424,280,160">
      <div id="rc_care_list" role="listbox" data-r="0,0,0,0"></div>
      <div id="care-opt-holder" data-r="120,424,280,160"></div>
    </div>
  </body></html>`,
  { pretendToBeVisual: true, url: "https://app.example.com/form" },
);

const { window: win } = dom;
const { document: doc } = win;

for (const k of [
  "window",
  "document",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "Event",
  "InputEvent",
  "KeyboardEvent",
  "MouseEvent",
  "NodeFilter",
  "getComputedStyle",
]) {
  Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true });
}
globalThis.innerHeight = 900;
globalThis.innerWidth = 1440;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

const rectOf = (el) => {
  const raw = el.getAttribute?.("data-r");
  if (!raw) return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  const [x, y, width, height] = raw.split(",").map(Number);
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height };
};
win.Element.prototype.getBoundingClientRect = function () {
  if (this.closest?.(".ant-select-dropdown-hidden")) {
    return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  }
  return rectOf(this);
};

const scrollBehaviors = [];
win.Element.prototype.scrollIntoView = function (opts) {
  scrollBehaviors.push(typeof opts === "object" ? opts.behavior : String(opts));
};
win.scrollTo = function (opts) {
  scrollBehaviors.push(typeof opts === "object" ? opts.behavior : String(opts));
};
globalThis.scrollTo = win.scrollTo;

doc.elementFromPoint = (x, y) => {
  const all = [...doc.querySelectorAll("*")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  });
  return all.length ? all[all.length - 1] : doc.body;
};

// 模拟 AntD Select 交互：CDP 点击展开下拉、搜索过滤虚拟列表、点击可见项更新选中态、ESC 收起多选浮层
function wireMockAntSelect({ selectId, ddId, holderId, inputId, allOptions, multi = false, searchable = true }) {
  const sel = doc.getElementById(selectId);
  const selector = sel.querySelector(".ant-select-selector");
  const dd = doc.getElementById(ddId);
  const holder = doc.getElementById(holderId);
  const input = doc.getElementById(inputId);
  let openClicks = 0;
  let searchTyped = false;

  const renderOptions = (filterText = "") => {
    holder.innerHTML = "";
    const list = filterText
      ? allOptions.filter((o) => o.includes(filterText))
      : allOptions.slice(0, 3); // 模拟虚拟列表默认只渲染前 3 项
    list.forEach((txt, idx) => {
      const div = doc.createElement("div");
      div.className = "ant-select-item ant-select-item-option";
      div.setAttribute("title", txt);
      div.setAttribute("data-r", `120,${336 + idx * 32},260,30`);
      const content = doc.createElement("div");
      content.className = "ant-select-item-option-content";
      content.textContent = txt;
      div.appendChild(content);
      div.addEventListener("click", () => {
        if (!multi) {
          sel.querySelectorAll(".ant-select-selection-item").forEach((n) => n.remove());
        }
        const existing = [...sel.querySelectorAll(".ant-select-selection-item")].find(
          (n) => n.getAttribute("title") === txt,
        );
        if (existing && multi) {
          // 真实 AntD 多选二次点击会反选移除！
          existing.remove();
        } else if (!existing) {
          const tag = doc.createElement("span");
          tag.className = "ant-select-selection-item";
          tag.setAttribute("title", txt);
          tag.textContent = txt;
          selector.appendChild(tag);
        }
        if (!multi) {
          sel.classList.remove("ant-select-open");
          dd.classList.add("ant-select-dropdown-hidden");
        }
      });
      holder.appendChild(div);
    });
  };

  const openDropdown = () => {
    openClicks += 1;
    sel.classList.add("ant-select-open");
    dd.classList.remove("ant-select-dropdown-hidden");
    renderOptions(searchable ? input.value : "");
  };

  input.addEventListener("input", () => {
    searchTyped = true;
    if (!searchable) {
      // 模拟非 showSearch 的 AntD Select 被误填文字后变空列表
      holder.innerHTML = "";
      return;
    }
    renderOptions(input.value);
  });

  doc.addEventListener("mousedown", (ev) => {
    if (!sel.contains(ev.target) && !dd.contains(ev.target)) {
      sel.classList.remove("ant-select-open");
      dd.classList.add("ant-select-dropdown-hidden");
    }
  });

  return {
    openDropdown,
    getOpenClicks: () => openClicks,
    wasSearchTyped: () => searchTyped,
  };
}

const matCtl = wireMockAntSelect({
  selectId: "mat-select",
  ddId: "dd-mat",
  holderId: "mat-opt-holder",
  inputId: "rc_mat",
  allOptions: ["亚麻", "蚕丝", "有机棉", "针织样式", "醋酸纤维"],
  multi: true,
  searchable: true,
});

const detailCtl = wireMockAntSelect({
  selectId: "detail-select",
  ddId: "dd-detail",
  holderId: "detail-opt-holder",
  inputId: "rc_detail",
  allOptions: ["假纽扣", "蝴蝶结", "纽扣", "无"],
  multi: false,
  searchable: true,
});

const careCtl = wireMockAntSelect({
  selectId: "care-select",
  ddId: "dd-care",
  holderId: "care-opt-holder",
  inputId: "rc_care",
  allOptions: ["手洗或干洗", "可手洗且不可干洗", "手洗"],
  multi: false,
  searchable: false,
});

// 模拟 chrome 与 CDP 环境验证 createAgentTools 中的 select_option 全链路
const cdpClicks = [];
globalThis.chrome = {
  tabs: {
    get: async (id) => ({ id, url: "https://app.example.com/form", title: "Form" }),
  },
  storage: { local: { get: async () => ({}) } },
  scripting: {
    executeScript: async ({ func, args = [] }) => [{ frameId: 0, result: await func(...args) }],
  },
};

const mockCdp = {
  ensure: async () => {},
  watchDialog: () => ({ promise: new Promise(() => {}), cancel: () => {} }),
  pendingDialog: () => null,
  watchFileChooser: () => ({ promise: new Promise(() => {}), cancel: () => {} }),
  send: async (_tabId, method, params) => {
    if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
      cdpClicks.push({ x: params.x, y: params.y });
      if (params.x >= 120 && params.x <= 400 && params.y >= 300 && params.y <= 332) matCtl.openDropdown();
      if (params.x >= 520 && params.x <= 800 && params.y >= 300 && params.y <= 332) detailCtl.openDropdown();
      if (params.x >= 120 && params.x <= 400 && params.y >= 390 && params.y <= 422) careCtl.openDropdown();
    }
    return {};
  },
};

const tools = createAgentTools({
  cdp: mockCdp,
  settings: { cdpInput: true },
  getTabId: () => 7,
  getTaskGroupId: () => 1,
  setTaskGroupId: () => {},
});
const selectTool = tools.find((t) => t.name === "select_option");
const fillTool = tools.find((t) => t.name === "fill");

// 1) ADR-015: 无 <label> 的自定义字段容器按 label="材质" 定位，不误中前序「成分」子表 th="材质"，检索过滤虚拟列表并自动收起多选浮层
const r1 = JSON.parse(await selectTool.execute({ label: "材质", value: "针织样式" }));
assert.equal(r1.ok, true, "custom multi-select by label succeeds");
assert.deepEqual(r1.selected, ["针织样式"]);
assert.equal(r1.popupClosed, true, "multi-select dropdown auto-closed after selection");
assert.equal(matCtl.getOpenClicks(), 1);
assert.equal(doc.querySelectorAll("[data-pl-select-uid]").length, 0, "zero temporary attributes left in DOM");

// 2) ADR-015 幂等保护：对已选中「针织样式」的多选框再次调用，不触发点击、不反选移除！
const r1Idem = JSON.parse(await selectTool.execute({ label: "材质", value: "针织样式" }));
assert.equal(r1Idem.ok, true);
assert.equal(r1Idem.alreadySelected, true);
assert.deepEqual(r1Idem.selected, ["针织样式"]);
assert.equal(matCtl.getOpenClicks(), 1, "idempotent call fired 0 extra clicks");

// 3) ADR-015 前置收起残留浮层 + 下一个自定义下拉框「细节 = 无」
doc.getElementById("mat-select").classList.add("ant-select-open");
doc.getElementById("dd-mat").classList.remove("ant-select-dropdown-hidden");
const r2 = JSON.parse(await selectTool.execute({ label: "* 细节", value: "无" }));
assert.equal(r2.ok, true);
assert.deepEqual(r2.selected, ["无"]);
assert.equal(
  doc.getElementById("mat-select").classList.contains("ant-select-open"),
  false,
  "lingering open multi-select closed before opening next field",
);

// 4) ADR-015 非可搜索下拉框（无 ant-select-show-search）绝不向 input 输入过滤词，且精确匹配「手洗」而非前缀「手洗或干洗」
const r3 = JSON.parse(await selectTool.execute({ label: "护理说明", value: "手洗" }));
assert.equal(r3.ok, true, JSON.stringify(r3));
assert.equal(careCtl.wasSearchTyped(), false, "non-searchable ant-select input was never typed into");
assert.deepEqual(r3.selected, ["手洗"], "exact match '手洗' chosen over '手洗或干洗'");

// 5) ADR-015 顶层弹窗作用域优先：label="店铺" 命中弹窗内店铺而非背景页同名筛选器
const r4 = JSON.parse(await selectTool.execute({ label: "店铺", value: "Alpha Store" }));
assert.equal(r4.ok, true);
assert.equal(r4.alreadySelected, true);
assert.deepEqual(r4.selected, ["Alpha Store"]);

// 6) 原生 <select> 向后兼容
const r5 = JSON.parse(await selectTool.execute({ selector: "#native-sel", value: "选项B" }));
assert.equal(r5.ok, true);
assert.equal(r5.value, "b");

// 7) ADR-016: scrollPage / pageAct 滚动一律使用 behavior="instant"，且 fill(blur=true) 触发失焦提交
scrollBehaviors.length = 0;
let blurred = false;
doc.getElementById("num-input").addEventListener("blur", () => {
  blurred = true;
});
await fillTool.execute({ selector: "#num-input", value: "220", blur: true });
scrollPage({ selector: "#field-detail" });
scrollPage({ y: 200 });
assert.equal(blurred, true, "fill with blur:true triggers blur");
assert.ok(scrollBehaviors.length >= 2);
assert.ok(
  scrollBehaviors.every((b) => b === "instant"),
  `expected all scroll behaviors to be 'instant', got ${JSON.stringify(scrollBehaviors)}`,
);

// 直接调用纯注入函数校验缺参报错
const bad = await prepareSelectOption({ value: "无" });
assert.equal(bad.ok, false);
const stale = await completeSelectOption({ uid: "nonexistent", value: "无" });
assert.equal(stale.ok, false);

console.log("test_round05_fixes: ALL PASSED");

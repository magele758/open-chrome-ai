import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createAgentTools } from "../lib/agent/tools.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const dom = new JSDOM(
  `<!doctype html><html><body>
    <div id="modal-wrap" class="ant-modal-wrap" data-r="0,0,1440,900">
      <div id="edit-modal" class="ant-modal" role="dialog" aria-modal="true" data-r="100,40,960,760">
        <div class="ant-modal-content" data-r="100,40,960,760">
          <button type="button" class="ant-modal-close" data-r="1020,48,32,32">×</button>
          <div class="ant-modal-header" data-r="100,40,900,48">
            <div id="modal-title" class="ant-modal-title" data-r="124,50,200,28">编辑面板</div>
          </div>
          <div class="ant-modal-body" data-r="100,90,960,640">
            <!-- 1. 单选下拉：点击选项后 ant-select-open 立即移除，但下拉浮层处于 250ms CSS leave 动画中尚未隐藏 -->
            <div id="field-comp" class="form-attr__field" data-r="120,120,760,120">
              <div id="label-comp" class="form-attr__label" data-r="120,120,240,24"><span>*</span><span>成分</span></div>
              <table data-r="120,150,520,70">
                <tbody>
                  <tr>
                    <td>
                      <div id="comp-select" class="ant-select ant-select-single ant-select-show-search" data-r="120,160,180,32">
                        <div class="ant-select-selector" data-r="120,160,180,32">
                          <input id="rc_comp" type="search" role="combobox" aria-expanded="false" aria-controls="rc_comp_list" data-r="122,162,140,28" />
                        </div>
                      </div>
                    </td>
                    <td>
                      <div class="form-attr__composition-input" data-r="320,160,140,32">
                        <input id="comp-ratio" type="text" placeholder="请输入" data-r="320,160,140,32" />
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- 2. 多选下拉：模拟仅真实 CDP 点击空白标题区才收起浮层（忽略合成 untrusted mousedown） -->
            <div id="field-mat" class="form-attr__field" data-r="120,270,400,72">
              <div id="label-mat" class="form-attr__label" data-r="120,270,140,22"><span>*</span><span>材质</span></div>
              <div id="mat-select" class="ant-select ant-select-multiple ant-select-show-search" data-r="120,300,260,32">
                <div class="ant-select-selector" data-r="120,300,260,32">
                  <input id="rc_mat" type="search" role="combobox" aria-expanded="false" aria-controls="rc_mat_list" data-r="124,302,100,24" />
                </div>
              </div>
            </div>

            <!-- 3. 异常卸载场景下拉：模拟选择后宿主弹窗意外开始关闭（ant-zoom-leave） -->
            <div id="field-rogue" class="form-attr__field" data-r="120,370,400,72">
              <div class="form-attr__label" data-r="120,370,140,22"><span>*</span><span>异常项</span></div>
              <div id="rogue-select" class="ant-select ant-select-single" data-r="120,400,260,32">
                <div class="ant-select-selector" data-r="120,400,260,32">
                  <input id="rc_rogue" type="search" role="combobox" aria-expanded="false" aria-controls="rc_rogue_list" readonly style="opacity: 0" data-r="0,0,0,0" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div id="dd-comp" class="ant-select-dropdown ant-select-dropdown-hidden" data-r="120,194,180,120">
      <div id="rc_comp_list" role="listbox" data-r="0,0,0,0"></div>
      <div id="comp-holder" data-r="120,194,180,120"></div>
    </div>

    <div id="dd-mat" class="ant-select-dropdown ant-select-dropdown-hidden" data-r="120,334,260,160">
      <div id="rc_mat_list" role="listbox" data-r="0,0,0,0"></div>
      <div id="mat-holder" data-r="120,334,260,160"></div>
    </div>

    <div id="dd-rogue" class="ant-select-dropdown ant-select-dropdown-hidden" data-r="120,434,260,120">
      <div id="rc_rogue_list" role="listbox" data-r="0,0,0,0"></div>
      <div id="rogue-holder" data-r="120,434,260,120"></div>
    </div>
  </body></html>`,
  { pretendToBeVisual: true, url: "https://app.example.com/list" },
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
win.Element.prototype.scrollIntoView = function () {};
win.scrollTo = function () {};
globalThis.scrollTo = win.scrollTo;

doc.elementFromPoint = (x, y) => {
  const all = [...doc.querySelectorAll("*")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  });
  return all.length ? all[all.length - 1] : doc.body;
};

// 严格复刻 R6 事故条件：任何冒泡到 Modal wrap 的 Escape 键都会立即销毁整个 Modal！
let escapeCount = 0;
doc.addEventListener(
  "keydown",
  (ev) => {
    if (ev.key === "Escape" || ev.keyCode === 27) {
      escapeCount += 1;
      doc.getElementById("edit-modal")?.remove();
    }
  },
  true,
);

// 1) 单选框：点击选项后立即移除 ant-select-open，但浮层保持 250ms CSS leave 动画不隐藏
const compSel = doc.getElementById("comp-select");
const compInput = doc.getElementById("rc_comp");
const compDd = doc.getElementById("dd-comp");
const compHolder = doc.getElementById("comp-holder");
const openComp = () => {
  compSel.classList.add("ant-select-open");
  compInput.setAttribute("aria-expanded", "true");
  compDd.classList.remove("ant-select-dropdown-hidden");
  compHolder.innerHTML = `<div id="opt-cotton" class="ant-select-item ant-select-item-option" title="选项甲" data-r="120,198,160,30"><div class="ant-select-item-option-content">选项甲</div></div>`;
  doc.getElementById("opt-cotton").addEventListener("click", () => {
    const tag = doc.createElement("span");
    tag.className = "ant-select-selection-item";
    tag.setAttribute("title", "选项甲");
    tag.textContent = "选项甲";
    compSel.querySelector(".ant-select-selector").appendChild(tag);
    compSel.classList.remove("ant-select-open");
    compInput.setAttribute("aria-expanded", "false");
    // 注意：故意延迟 250ms 才添加 ant-select-dropdown-hidden，复现 AntD ant-slide-up-leave 动画！
    setTimeout(() => compDd.classList.add("ant-select-dropdown-hidden"), 250);
  });
};

// 2) 多选框：忽略合成 mousedown，要求通过真实 CDP 点击弹窗内安全中性节点（字段标签或标题）关闭浮层
const matSel = doc.getElementById("mat-select");
const matInput = doc.getElementById("rc_mat");
const matDd = doc.getElementById("dd-mat");
const matHolder = doc.getElementById("mat-holder");
const closeMatTrusted = () => {
  matSel.classList.remove("ant-select-open");
  matInput.setAttribute("aria-expanded", "false");
  matDd.classList.add("ant-select-dropdown-hidden");
};
const openMat = () => {
  matSel.classList.add("ant-select-open");
  matInput.setAttribute("aria-expanded", "true");
  matDd.classList.remove("ant-select-dropdown-hidden");
  matHolder.innerHTML = `<div id="opt-knit" class="ant-select-item ant-select-item-option" title="多选乙" data-r="120,338,240,30"><div class="ant-select-item-option-content">多选乙</div></div>`;
  doc.getElementById("opt-knit").addEventListener("click", () => {
    const tag = doc.createElement("span");
    tag.className = "ant-select-selection-item";
    tag.setAttribute("title", "多选乙");
    tag.textContent = "多选乙";
    matSel.querySelector(".ant-select-selector").appendChild(tag);
    // 多选保持展开，且此处故意不监听合成 mousedown，强制走 CDP 安全中性点击兜底
  });
};

// 3) 异常项：点击后宿主弹窗进入 ant-zoom-leave 关闭态，验证 verifyHostAlive 返回 ok:false
const rogueSel = doc.getElementById("rogue-select");
const rogueDd = doc.getElementById("dd-rogue");
const rogueHolder = doc.getElementById("rogue-holder");
const openRogue = () => {
  rogueSel.classList.add("ant-select-open");
  rogueDd.classList.remove("ant-select-dropdown-hidden");
  rogueHolder.innerHTML = `<div id="opt-rogue" class="ant-select-item ant-select-item-option" title="触发关窗" data-r="120,438,240,30"><div class="ant-select-item-option-content">触发关窗</div></div>`;
  doc.getElementById("opt-rogue").addEventListener("click", () => {
    const tag = doc.createElement("span");
    tag.className = "ant-select-selection-item";
    tag.setAttribute("title", "触发关窗");
    tag.textContent = "触发关窗";
    rogueSel.querySelector(".ant-select-selector").appendChild(tag);
    rogueSel.classList.remove("ant-select-open");
    doc.getElementById("edit-modal").classList.add("ant-zoom-leave");
  });
};

const cdpClicks = [];
globalThis.chrome = {
  tabs: { get: async (id) => ({ id, url: "https://app.example.com/list", title: "List" }) },
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
      const { x, y } = params;
      if (x >= 120 && x <= 300 && y >= 160 && y <= 192) openComp();
      else if (x >= 120 && x <= 380 && y >= 300 && y <= 332) openMat();
      else if (x >= 120 && x <= 380 && y >= 400 && y <= 432) openRogue();
      else {
        const hit = doc.elementFromPoint(x, y);
        if (hit && !matSel.contains(hit) && !matDd.contains(hit) && doc.getElementById("edit-modal")?.contains(hit)) {
          closeMatTrusted();
        }
      }
    }
    return {};
  },
};

const tools = createAgentTools({
  cdp: mockCdp,
  settings: { cdpInput: true },
  getTabId: () => 9,
  getTaskGroupId: () => 1,
  setTaskGroupId: () => {},
});
const selectTool = tools.find((t) => t.name === "select_option");
const fillTool = tools.find((t) => t.name === "fill");

// 断言 1：R6 复现测试——单选选择「选项甲」且浮层尚在 250ms 离场动画中时，0 次 Escape，Modal 存活，紧接比例输入框 fill 成功！
const res1 = JSON.parse(
  await selectTool.execute({ selector: "#field-comp .ant-select", value: "选项甲" }),
);
assert.equal(res1.ok, true, JSON.stringify(res1));
assert.deepEqual(res1.selected, ["选项甲"]);
assert.equal(res1.popupClosed, true);
assert.equal(escapeCount, 0, "select_option must NEVER dispatch Escape");
assert.ok(doc.getElementById("edit-modal"), "host modal remained mounted after single-select");

const fillRes = JSON.parse(
  await fillTool.execute({ selector: ".form-attr__composition-input input", value: "100", blur: true }),
);
assert.equal(fillRes.ok, true, "subsequent fill on composition ratio input succeeded immediately");
assert.equal(doc.getElementById("comp-ratio").value, "100");

// 断言 2：多选选择后即使合成事件未关闭浮层，也会通过 CDP 点击弹窗内安全中性区收起浮层，0 次 Escape，Modal 存活！
const res2 = JSON.parse(await selectTool.execute({ label: "材质", value: "多选乙" }));
assert.equal(res2.ok, true, JSON.stringify(res2));
assert.deepEqual(res2.selected, ["多选乙"]);
assert.equal(res2.popupClosed, true, "multi-select closed via safe CDP neutral click");
assert.equal(escapeCount, 0, "multi-select close must NEVER dispatch Escape");
assert.ok(doc.getElementById("edit-modal"), "host modal remained mounted after multi-select");
assert.equal(doc.querySelectorAll("[data-pl-select-uid], [data-pl-select-dialog]").length, 0, "zero leftover attrs");

// 断言 3：若宿主弹窗因页面异常进入关闭态（ant-zoom-leave），verifyHostAlive 立即返回 ok:false 与 hostClosed:true
const res3 = JSON.parse(await selectTool.execute({ label: "异常项", value: "触发关窗" }));
assert.equal(res3.ok, false, "must fail fast when host modal starts closing");
assert.equal(res3.hostClosed, true);
assert.equal(doc.querySelectorAll("[data-pl-select-uid], [data-pl-select-dialog]").length, 0, "zero leftover attrs on failure");

console.log("test_round06_fixes: ALL PASSED");

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createAgentTools } from "../lib/agent/tools.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const dom = new JSDOM(
  `<!doctype html><html><body>
    <div id="modal-wrap" data-r="0,0,1440,900">
      <div id="edit-modal" role="dialog" aria-modal="true" data-r="100,40,960,760">
        <div class="modal-surface" data-r="100,40,960,760">
          <button type="button" aria-label="关闭" data-r="1020,48,32,32">×</button>
          <header data-r="100,40,900,48">
            <h2 id="modal-title" data-r="124,50,200,28">编辑面板</h2>
          </header>
          <section data-r="100,90,960,640">
            <!-- 1. 单选下拉：点击选项后 aria-expanded 立即变 false，但浮层处于 250ms 动画尚未隐藏 -->
            <div id="field-quota" class="form-attr__field" data-r="120,120,760,120">
              <div id="label-quota" class="form-attr__label" data-r="120,120,240,24"><span>*</span><span>配额分组</span></div>
              <table data-r="120,150,520,70">
                <tbody>
                  <tr>
                    <td>
                      <div id="quota-select" role="combobox" aria-expanded="false" aria-controls="quota_list" data-r="120,160,180,32">
                        <input id="quota_inp" type="search" role="combobox" aria-expanded="false" aria-controls="quota_list" data-r="122,162,140,28" />
                      </div>
                    </td>
                    <td>
                      <div class="numeric-field-input" data-r="320,160,140,32">
                        <input id="quota-weight" type="text" placeholder="请输入" data-r="320,160,140,32" />
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- 2. 多选下拉：模拟仅真实 CDP 点击安全中性标题区才收起浮层（忽略合成 untrusted mousedown） -->
            <div id="field-tags" class="form-attr__field" data-r="120,270,400,72">
              <div id="label-tags" class="form-attr__label" data-r="120,270,140,22"><span>*</span><span>节点标签</span></div>
              <div id="tags-select" role="combobox" aria-expanded="false" aria-controls="tags_list" data-r="120,300,260,32">
                <input id="tags_inp" type="search" role="combobox" aria-expanded="false" aria-controls="tags_list" data-r="124,302,100,24" />
              </div>
            </div>

            <!-- 3. 异常卸载场景下拉：模拟选择后宿主弹窗意外开始关闭（display: none） -->
            <div id="field-rogue" class="form-attr__field" data-r="120,370,400,72">
              <div class="form-attr__label" data-r="120,370,140,22"><span>*</span><span>异常项</span></div>
              <div id="rogue-select" role="combobox" aria-expanded="false" aria-controls="rogue_list" data-r="120,400,260,32">
                <input id="rogue_inp" type="search" role="combobox" aria-expanded="false" aria-controls="rogue_list" readonly style="opacity: 0" data-r="0,0,0,0" />
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>

    <div id="quota_list" role="listbox" style="display: none" data-r="120,194,180,120"></div>
    <div id="tags_list" role="listbox" style="display: none" data-r="120,334,260,160"></div>
    <div id="rogue_list" role="listbox" style="display: none" data-r="120,434,260,120"></div>
  </body></html>`,
  { pretendToBeVisual: true, url: "https://portal.example.test/list" },
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
  for (let cur = this; cur && cur.nodeType === 1; cur = cur.parentElement) {
    if (cur.style?.display === "none") {
      return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    }
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

// 任何冒泡到 Modal 的 Escape 键都会立即销毁整个 Modal
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

// 1) 单选框：点击选项后立即将 aria-expanded 置为 false，但浮层延迟 250ms 才隐藏
const quotaSel = doc.getElementById("quota-select");
const quotaInput = doc.getElementById("quota_inp");
const quotaLb = doc.getElementById("quota_list");
const openQuota = () => {
  quotaSel.setAttribute("aria-expanded", "true");
  quotaInput.setAttribute("aria-expanded", "true");
  quotaLb.style.display = "block";
  quotaLb.innerHTML = `<div id="opt-alpha" role="option" aria-selected="false" data-r="120,198,160,30">选项甲</div>`;
  doc.getElementById("opt-alpha").addEventListener("click", () => {
    doc.getElementById("opt-alpha").setAttribute("aria-selected", "true");
    quotaSel.setAttribute("aria-expanded", "false");
    quotaInput.setAttribute("aria-expanded", "false");
    setTimeout(() => {
      quotaLb.style.display = "none";
    }, 250);
  });
};

// 2) 多选框：忽略合成 mousedown，要求通过真实 CDP 点击弹窗内安全中性节点（字段标签或标题）关闭浮层
const tagsSel = doc.getElementById("tags-select");
const tagsInput = doc.getElementById("tags_inp");
const tagsLb = doc.getElementById("tags_list");
const closeTagsTrusted = () => {
  tagsSel.setAttribute("aria-expanded", "false");
  tagsInput.setAttribute("aria-expanded", "false");
  tagsLb.style.display = "none";
};
const openTags = () => {
  tagsSel.setAttribute("aria-expanded", "true");
  tagsInput.setAttribute("aria-expanded", "true");
  tagsLb.style.display = "block";
  tagsLb.innerHTML = `<div id="opt-beta" role="option" aria-selected="false" data-r="120,338,240,30">多选乙</div>`;
  doc.getElementById("opt-beta").addEventListener("click", () => {
    doc.getElementById("opt-beta").setAttribute("aria-selected", "true");
  });
};

// 3) 异常项：点击后宿主弹窗进入关闭隐藏态，验证 verifyHostAlive 返回 ok:false 与 hostClosed:true
const rogueSel = doc.getElementById("rogue-select");
const rogueLb = doc.getElementById("rogue_list");
const openRogue = () => {
  rogueSel.setAttribute("aria-expanded", "true");
  rogueLb.style.display = "block";
  rogueLb.innerHTML = `<div id="opt-rogue" role="option" aria-selected="false" data-r="120,438,240,30">触发关窗</div>`;
  doc.getElementById("opt-rogue").addEventListener("click", () => {
    doc.getElementById("opt-rogue").setAttribute("aria-selected", "true");
    rogueSel.setAttribute("aria-expanded", "false");
    doc.getElementById("edit-modal").style.display = "none";
  });
};

globalThis.chrome = {
  tabs: { get: async (id) => ({ id, url: "https://portal.example.test/list", title: "List" }) },
  permissions: { contains: async () => true },
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
      const { x, y } = params;
      if (x >= 120 && x <= 300 && y >= 160 && y <= 192) {
        openQuota();
      } else if (x >= 120 && x <= 380 && y >= 300 && y <= 332) {
        openTags();
      } else if (x >= 120 && x <= 380 && y >= 400 && y <= 432) {
        openRogue();
      } else {
        const hit = doc.elementFromPoint(x, y);
        if (hit && (quotaLb.contains(hit) || tagsLb.contains(hit) || rogueLb.contains(hit))) {
          hit.click?.();
        } else if (hit && !tagsSel.contains(hit) && !tagsLb.contains(hit) && doc.getElementById("edit-modal")?.contains(hit)) {
          closeTagsTrusted();
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

// 断言 1：单选选择「选项甲」且浮层尚在 250ms 离场延迟中时，0 次 Escape，Modal 存活，紧接输入框 fill(blur: true) 成功
const res1 = JSON.parse(
  await selectTool.execute({ selector: "#quota-select", value: "选项甲" }),
);
assert.equal(res1.ok, true, JSON.stringify(res1));
assert.deepEqual(res1.selected, ["选项甲"]);
assert.equal(res1.popupClosed, true);
assert.equal(escapeCount, 0, "select_option must NEVER dispatch Escape");
assert.ok(doc.getElementById("edit-modal"), "host modal remained mounted after single-select");

const fillRes = JSON.parse(
  await fillTool.execute({ selector: ".numeric-field-input input", value: "100", blur: true }),
);
assert.equal(fillRes.ok, true, "subsequent fill on numeric input succeeded immediately");
assert.equal(doc.getElementById("quota-weight").value, "100");

// 断言 2：多选选择后即使合成事件未关闭浮层，也会通过 CDP 点击弹窗内安全中性区收起浮层，0 次 Escape，Modal 存活
const res2 = JSON.parse(await selectTool.execute({ label: "节点标签", value: "多选乙" }));
assert.equal(res2.ok, true, JSON.stringify(res2));
assert.deepEqual(res2.selected, ["多选乙"]);
assert.equal(res2.popupClosed, true, "multi-select closed via safe CDP neutral click");
assert.equal(escapeCount, 0, "multi-select close must NEVER dispatch Escape");
assert.ok(doc.getElementById("edit-modal"), "host modal remained mounted after multi-select");
assert.equal(doc.querySelectorAll("[data-pl-select-uid], [data-pl-select-dialog]").length, 0, "zero leftover attrs");

// 断言 3：若宿主弹窗因页面异常进入关闭态，verifyHostAlive 立即返回 ok:false 与 hostClosed:true
const res3 = JSON.parse(await selectTool.execute({ label: "异常项", value: "触发关窗" }));
assert.equal(res3.ok, false, "must fail fast when host modal starts closing");
assert.equal(res3.hostClosed, true);
assert.equal(doc.querySelectorAll("[data-pl-select-uid], [data-pl-select-dialog]").length, 0, "zero leftover attrs on failure");

dom.window.close();
console.log("PASS test_select_close_and_fill_blur.mjs");

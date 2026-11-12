import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { completeSelectOption, prepareSelectOption, scrollPage } from "../lib/agent/page-fns.js";
import { composeUIAdapterSpec } from "../lib/agent/ui-adapters/index.js";
import { createAgentTools } from "../lib/agent/tools.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const ant = (s) => `${"ant"}-${s}`;
const el = (s) => `${"el"}-${s}`;
const rc = (s) => `${"rc"}-${s}`;

// ── Part A: aria-native / antd / element-plus 三套最小 HTML 夹具同构下拉选择契约 ──
{
  const FRAMEWORK_CASES = [
    {
      name: "aria-native",
      adapterSpec: composeUIAdapterSpec(["aria-native"]),
      html: `<!doctype html><html><body>
        <dialog id="dlg" open data-r="60,40,600,400">
          <h3 data-r="80,50,200,26">部门配置</h3>
          <fieldset data-r="80,90,340,70">
            <legend data-r="80,90,100,22">所属部门</legend>
            <div id="combo" role="combobox" aria-expanded="false" aria-controls="lb" data-r="80,120,240,32">
              <input id="combo-inp" role="combobox" aria-controls="lb" readonly style="opacity:0" data-r="0,0,0,0" />
              <span>请选择</span>
            </div>
          </fieldset>
          <ul id="lb" role="listbox" style="display:none" data-r="80,156,240,120">
            <li id="opt-a" role="option" aria-selected="false" data-r="80,158,220,28">平台架构部</li>
            <li id="opt-b" role="option" aria-selected="false" data-r="80,188,220,28">基础运维部</li>
          </ul>
        </dialog>
      </body></html>`,
      openFn(doc) {
        doc.getElementById("combo").setAttribute("aria-expanded", "true");
        doc.getElementById("lb").style.display = "block";
        doc.getElementById("opt-b").onclick = () => {
          doc.getElementById("opt-b").setAttribute("aria-selected", "true");
          doc.getElementById("combo").setAttribute("aria-expanded", "false");
          doc.getElementById("lb").style.display = "none";
        };
      },
    },
    {
      name: "antd",
      adapterSpec: composeUIAdapterSpec(["aria-native", "antd"]),
      html: `<!doctype html><html><body>
        <div class="${ant("modal")}" role="dialog" aria-modal="true" data-r="60,40,600,400">
          <div class="${ant("modal-title")}" data-r="80,50,200,26">部门配置</div>
          <div class="${ant("form-item")}" data-r="80,90,340,70">
            <div class="${ant("form-item-label")}" data-r="80,90,100,22"><label>所属部门</label></div>
            <div id="combo" class="${ant("select")} ${ant("select-single")}" data-r="80,120,240,32">
              <div id="combo-sel" class="${ant("select-selector")}" data-r="80,120,240,32">
                <input id="combo-inp" role="combobox" aria-controls="lb" readonly style="opacity:0" data-r="0,0,0,0" />
              </div>
            </div>
          </div>
        </div>
        <div id="dd" class="${ant("select-dropdown")}" style="display:none" data-r="80,156,240,120">
          <div id="lb" role="listbox" data-r="0,0,0,0"></div>
          <div id="opt-b" class="${ant("select-item")} ${ant("select-item-option")}" title="基础运维部" data-r="80,158,220,28">
            <div class="${ant("select-item-option-content")}">基础运维部</div>
          </div>
        </div>
      </body></html>`,
      openFn(doc) {
        doc.getElementById("combo").classList.add(ant("select-open"));
        doc.getElementById("dd").style.display = "block";
        doc.getElementById("opt-b").onclick = () => {
          const tag = doc.createElement("span");
          tag.className = ant("select-selection-item");
          tag.setAttribute("title", "基础运维部");
          tag.textContent = "基础运维部";
          doc.getElementById("combo-sel").appendChild(tag);
          doc.getElementById("combo").classList.remove(ant("select-open"));
          doc.getElementById("dd").style.display = "none";
        };
      },
    },
    {
      name: "element-plus",
      adapterSpec: composeUIAdapterSpec(["aria-native", "element-plus"]),
      html: `<!doctype html><html><body>
        <div class="${el("dialog")}" role="dialog" aria-modal="true" data-r="60,40,600,400">
          <div class="${el("dialog__header")}"><span class="${el("dialog__title")}" data-r="80,50,200,26">部门配置</span></div>
          <div class="${el("form-item")}" data-r="80,90,340,70">
            <label class="${el("form-item__label")}" data-r="80,90,100,22">所属部门</label>
            <div id="combo" class="${el("select")}" data-r="80,120,240,32">
              <div id="combo-sel" class="${el("select__wrapper")}" data-r="80,120,240,32">
                <input id="combo-inp" class="${el("select__input")}" type="text" aria-controls="lb" readonly data-r="84,122,120,26" />
              </div>
            </div>
          </div>
        </div>
        <div id="dd" class="${el("select-dropdown")}" style="display:none" data-r="80,156,240,120">
          <ul id="lb" data-r="80,156,240,120">
            <li id="opt-b" class="${el("select-dropdown__item")}" data-r="80,158,220,28">基础运维部</li>
          </ul>
        </div>
      </body></html>`,
      openFn(doc) {
        doc.getElementById("combo-sel").classList.add("is-focused");
        doc.getElementById("dd").style.display = "block";
        doc.getElementById("opt-b").onclick = () => {
          const item = doc.createElement("span");
          item.className = el("select__selected-item");
          item.textContent = "基础运维部";
          doc.getElementById("combo-sel").appendChild(item);
          doc.getElementById("combo-sel").classList.remove("is-focused");
          doc.getElementById("dd").style.display = "none";
        };
      },
    },
  ];

  for (const fc of FRAMEWORK_CASES) {
    const subDom = new JSDOM(fc.html, { pretendToBeVisual: true, runScripts: "outside-only", url: "https://portal.example.test/form" });
    try {
      const w = subDom.window;
      const d = w.document;
      const rectOf = (node) => {
        const raw = node.getAttribute?.("data-r");
        if (!raw) return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
        const [x, y, width, height] = raw.split(",").map(Number);
        return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height };
      };
      w.Element.prototype.getBoundingClientRect = function () {
        if (this.style?.display === "none") return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
        return rectOf(this);
      };
      w.Element.prototype.scrollIntoView = function () {};
      w.requestAnimationFrame = (cb) => setTimeout(cb, 0);
      d.elementFromPoint = (x, y) => {
        const hits = [...d.querySelectorAll("*")].filter((node) => {
          for (let cur = node; cur && cur.nodeType === 1; cur = cur.parentElement) {
            if (cur.style?.display === "none") return false;
          }
          const r = rectOf(node);
          return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        });
        return hits.at(-1) || d.body;
      };

      const prep = await w.eval(
        `(${prepareSelectOption.toString()})(${JSON.stringify({ label: "所属部门", value: "基础运维部", useCdp: true, adapterSpec: fc.adapterSpec })})`,
      );
      assert.equal(prep.ok, true, `[${fc.name}] prepareSelectOption ok`);
      assert.equal(prep.needCdpOpen, true);
      fc.openFn(d);

      const comp = await w.eval(
        `(${completeSelectOption.toString()})(${JSON.stringify({ uid: prep.uid, value: "基础运维部", stage: "select", adapterSpec: fc.adapterSpec })})`,
      );
      assert.equal(comp.ok, true, `[${fc.name}] completeSelectOption ok: ${JSON.stringify(comp)}`);
      assert.deepEqual([...comp.selected], ["基础运维部"]);

      const idem = await w.eval(
        `(${prepareSelectOption.toString()})(${JSON.stringify({ label: "所属部门", value: "基础运维部", adapterSpec: fc.adapterSpec })})`,
      );
      assert.equal(idem.alreadySelected, true, `[${fc.name}] second call is idempotent`);
    } finally {
      subDom.window.close();
    }
  }
}

// ── Part B: 复杂表单全链路验证（无 <label> 自定义属性块、内嵌同名 th 防抢匹配、虚拟列表检索、多选自动收起、精确匹配与弹窗作用域） ──
const dom = new JSDOM(
  `<!doctype html><html><body>
    <!-- 背景页同名筛选器，验证弹窗优先作用域 -->
    <div class="page-filter" data-r="20,10,400,40">
      <div class="${ant("form-item")}" data-r="20,10,300,36">
        <div class="${ant("form-item-label")}" data-r="20,10,60,32"><label>所属工作区</label></div>
        <div id="bg-ws-select" class="${ant("select")} ${ant("select-single")}" data-r="90,10,180,32">
          <div class="${ant("select-selector")}" data-r="90,10,180,32">
            <span class="${ant("select-selection-item")}" title="背景错误工作区">背景错误工作区</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 顶层编辑弹窗（无 <label> 的自定义字段容器 + 配额子表含同名表头 th=角色标签） -->
    <div id="edit-modal" class="${ant("modal")}" role="dialog" aria-modal="true" style="z-index: 1000" data-r="100,40,900,760">
      <div class="${ant("modal-header")}" data-r="100,40,900,48"><div class="${ant("modal-title")}" data-r="120,50,200,28">编辑面板</div></div>
      <div class="${ant("modal-body")}" data-r="100,90,900,660">
        <!-- 字段 0: 资源配额（含提示文案与内部表格列头 th=角色标签，验证不会抢匹配 label='角色标签'） -->
        <div id="field-quota" class="custom-attr__field" data-r="120,110,820,140">
          <div class="custom-attr__label" data-r="120,110,400,24">
            <span class="custom-attr__required">*</span>
            <span>资源配额</span>
            <span class="custom-attr__hint">（各项权重合计100%）</span>
          </div>
          <table data-r="120,140,600,80">
            <thead><tr><th data-r="120,140,160,28">角色标签</th></tr></thead>
            <tbody>
              <tr>
                <td>
                  <div id="quota-row-select" class="${ant("select")} ${ant("select-single")} ${ant("select-show-search")}" data-r="120,172,160,32">
                    <div class="${ant("select-selector")}" data-r="120,172,160,32">
                      <input id="rc_quota" type="search" role="combobox" aria-controls="rc_quota_list" data-r="120,172,140,28" />
                      <span class="${ant("select-selection-placeholder")}">请选择</span>
                    </div>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 字段 1: * 角色标签（无 <label> 标签，多选可搜索下拉） -->
        <div id="field-role" class="custom-attr__field" data-r="120,270,360,72">
          <div class="custom-attr__label" data-r="120,270,120,22">
            <span class="custom-attr__required">*</span>
            <span>角色标签</span>
          </div>
          <div id="role-select" class="${ant("select")} ${ant("select-multiple")} ${ant("select-show-search")}" data-r="120,300,280,32">
            <div id="role-selector" class="${ant("select-selector")}" data-r="120,300,280,32">
              <input id="rc_role" type="search" role="combobox" aria-controls="rc_role_list" data-r="124,302,80,24" />
            </div>
          </div>
        </div>

        <!-- 字段 2: * 审批策略（单选可搜索下拉） -->
        <div id="field-approval" class="custom-attr__field" data-r="520,270,360,72">
          <div class="custom-attr__label" data-r="520,270,120,22">
            <span>*</span><span>审批策略</span>
          </div>
          <div id="approval-select" class="${ant("select")} ${ant("select-single")} ${ant("select-show-search")}" data-r="520,300,280,32">
            <div id="approval-selector" class="${ant("select-selector")}" data-r="520,300,280,32">
              <input id="rc_approval" type="search" role="combobox" aria-controls="rc_approval_list" data-r="524,302,80,24" />
            </div>
          </div>
        </div>

        <!-- 字段 3: * 通知方式（验证「邮件」精确命中而非前缀「邮件或短信」） -->
        <div id="field-notify" class="custom-attr__field" data-r="120,360,360,72">
          <div class="custom-attr__label" data-r="120,360,120,22"><span>*</span><span>通知方式</span></div>
          <div id="notify-select" class="${ant("select")} ${ant("select-single")}" data-r="120,390,280,32">
            <div id="notify-selector" class="${ant("select-selector")}" data-r="120,390,280,32">
              <input id="rc_notify" type="search" role="combobox" aria-controls="rc_notify_list" readonly style="opacity: 0" data-r="0,0,0,0" />
            </div>
          </div>
        </div>

        <!-- 字段 4: 弹窗内「所属工作区」（验证遮蔽背景页同名 label） -->
        <div class="${ant("form-item")}" data-r="520,360,360,72">
          <div class="${ant("form-item-label")}" data-r="520,360,96,24"><label>所属工作区</label></div>
          <div id="modal-ws-select" class="${ant("select")} ${ant("select-multiple")}" data-r="520,390,280,32">
            <div class="${ant("select-selector")}" data-r="520,390,280,32">
              <span class="${ant("select-selection-item")}" title="Alpha Workspace">Alpha Workspace<span class="${ant("select-selection-item-remove")}">×</span></span>
            </div>
          </div>
        </div>

        <!-- 字段 5: 原生 select 与数值框 -->
        <select id="native-sel" data-r="120,460,160,30">
          <option value="a">选项A</option>
          <option value="b">选项B</option>
        </select>
        <input id="num-input" type="text" placeholder="数值框" data-r="320,460,120,30" />
      </div>
    </div>

    <!-- 浮层下拉列表（含 0x0 读屏无障碍隐藏 role=option 与真实可见选项） -->
    <div id="dd-role" class="${ant("select-dropdown")} ${ant("select-dropdown-hidden")}" data-r="120,334,280,200">
      <div id="rc_role_list" role="listbox" style="height: 0px; width: 0px; overflow: hidden" data-r="0,0,0,0">
        <div role="option" aria-label="架构评审" data-r="0,0,0,0">架构评审</div>
      </div>
      <div class="${rc("virtual-list")}" data-r="120,334,280,200">
        <div id="role-opt-holder" data-r="120,334,280,200"></div>
      </div>
    </div>

    <div id="dd-approval" class="${ant("select-dropdown")} ${ant("select-dropdown-hidden")}" data-r="520,334,280,160">
      <div id="rc_approval_list" role="listbox" data-r="0,0,0,0"></div>
      <div id="approval-opt-holder" data-r="520,334,280,160"></div>
    </div>

    <div id="dd-notify" class="${ant("select-dropdown")} ${ant("select-dropdown-hidden")}" data-r="120,424,280,160">
      <div id="rc_notify_list" role="listbox" data-r="0,0,0,0"></div>
      <div id="notify-opt-holder" data-r="120,424,280,160"></div>
    </div>
  </body></html>`,
  { pretendToBeVisual: true, url: "https://portal.example.test/form" },
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

const rectOf = (node) => {
  const raw = node.getAttribute?.("data-r");
  if (!raw) return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  const [x, y, width, height] = raw.split(",").map(Number);
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height };
};
const ddHiddenSel = `.${ant("select-dropdown-hidden")}`;
win.Element.prototype.getBoundingClientRect = function () {
  if (this.closest?.(ddHiddenSel)) {
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
  const all = [...doc.querySelectorAll("*")].filter((node) => {
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  });
  return all.length ? all[all.length - 1] : doc.body;
};

function wireMockCombo({ selectId, ddId, holderId, inputId, allOptions, multi = false, searchable = true }) {
  const sel = doc.getElementById(selectId);
  const selector = sel.querySelector(`.${ant("select-selector")}`);
  const dd = doc.getElementById(ddId);
  const holder = doc.getElementById(holderId);
  const input = doc.getElementById(inputId);
  let openClicks = 0;
  let searchTyped = false;

  const renderOptions = (filterText = "") => {
    holder.innerHTML = "";
    const list = filterText
      ? allOptions.filter((o) => o.includes(filterText))
      : allOptions.slice(0, 3);
    const holderRect = rectOf(holder);
    const baseX = holderRect.left || 120;
    const baseY = (holderRect.top || 334) + 2;
    list.forEach((txt, idx) => {
      const div = doc.createElement("div");
      div.className = `${ant("select-item")} ${ant("select-item-option")}`;
      div.setAttribute("title", txt);
      div.setAttribute("data-r", `${baseX},${baseY + idx * 32},260,30`);
      const content = doc.createElement("div");
      content.className = ant("select-item-option-content");
      content.textContent = txt;
      div.appendChild(content);
      div.addEventListener("click", () => {
        if (!multi) {
          sel.querySelectorAll(`.${ant("select-selection-item")}`).forEach((n) => n.remove());
        }
        const existing = [...sel.querySelectorAll(`.${ant("select-selection-item")}`)].find(
          (n) => n.getAttribute("title") === txt,
        );
        if (existing && multi) {
          existing.remove();
        } else if (!existing) {
          const tag = doc.createElement("span");
          tag.className = ant("select-selection-item");
          tag.setAttribute("title", txt);
          tag.textContent = txt;
          selector.appendChild(tag);
        }
        if (!multi) {
          sel.classList.remove(ant("select-open"));
          dd.classList.add(ant("select-dropdown-hidden"));
        }
      });
      holder.appendChild(div);
    });
  };

  const openDropdown = () => {
    openClicks += 1;
    sel.classList.add(ant("select-open"));
    dd.classList.remove(ant("select-dropdown-hidden"));
    renderOptions(searchable ? input.value : "");
  };

  input.addEventListener("input", () => {
    searchTyped = true;
    if (!searchable) {
      holder.innerHTML = "";
      return;
    }
    renderOptions(input.value);
  });

  doc.addEventListener("mousedown", (ev) => {
    if (!sel.contains(ev.target) && !dd.contains(ev.target)) {
      sel.classList.remove(ant("select-open"));
      dd.classList.add(ant("select-dropdown-hidden"));
    }
  });

  return {
    openDropdown,
    getOpenClicks: () => openClicks,
    wasSearchTyped: () => searchTyped,
  };
}

const roleCtl = wireMockCombo({
  selectId: "role-select",
  ddId: "dd-role",
  holderId: "role-opt-holder",
  inputId: "rc_role",
  allOptions: ["值班人员", "安全审计", "变更观察", "架构评审", "容量规划"],
  multi: true,
  searchable: true,
});

const approvalCtl = wireMockCombo({
  selectId: "approval-select",
  ddId: "dd-approval",
  holderId: "approval-opt-holder",
  inputId: "rc_approval",
  allOptions: ["双人会签", "负责人审批", "单人复核", "无"],
  multi: false,
  searchable: true,
});

const notifyCtl = wireMockCombo({
  selectId: "notify-select",
  ddId: "dd-notify",
  holderId: "notify-opt-holder",
  inputId: "rc_notify",
  allOptions: ["邮件或短信", "仅邮件抄送", "邮件"],
  multi: false,
  searchable: false,
});

globalThis.chrome = {
  tabs: {
    get: async (id) => ({ id, url: "https://portal.example.test/form", title: "Form" }),
  },
  permissions: {
    contains: async () => true,
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
      const { x, y } = params;
      if (x >= 120 && x <= 400 && y >= 300 && y <= 332) {
        roleCtl.openDropdown();
      } else if (x >= 520 && x <= 800 && y >= 300 && y <= 332) {
        approvalCtl.openDropdown();
      } else if (x >= 120 && x <= 400 && y >= 390 && y <= 422) {
        notifyCtl.openDropdown();
      } else {
        const hit = doc.elementFromPoint(x, y);
        hit?.dispatchEvent?.(new win.MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        hit?.click?.();
      }
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

// 1) 无 <label> 的自定义字段容器按 label="角色标签" 定位，不误中前序子表 th="角色标签"，检索过滤虚拟列表并自动收起多选浮层
const r1 = JSON.parse(await selectTool.execute({ label: "角色标签", value: "架构评审" }));
assert.equal(r1.ok, true, `custom multi-select by label succeeds: ${JSON.stringify(r1)}`);
assert.deepEqual(r1.selected, ["架构评审"]);
assert.equal(r1.popupClosed, true, "multi-select dropdown auto-closed after selection");
assert.equal(roleCtl.getOpenClicks(), 1);
assert.equal(doc.querySelectorAll("[data-pl-select-uid]").length, 0, "zero temporary attributes left in DOM");

// 2) 幂等保护：对已选中「架构评审」的多选框再次调用，不触发点击、不反选移除
const r1Idem = JSON.parse(await selectTool.execute({ label: "角色标签", value: "架构评审" }));
assert.equal(r1Idem.ok, true);
assert.equal(r1Idem.alreadySelected, true);
assert.deepEqual(r1Idem.selected, ["架构评审"]);
assert.equal(roleCtl.getOpenClicks(), 1, "idempotent call fired 0 extra clicks");

// 3) 前置收起残留浮层 + 下一个自定义下拉框「审批策略 = 无」
doc.getElementById("role-select").classList.add(ant("select-open"));
doc.getElementById("dd-role").classList.remove(ant("select-dropdown-hidden"));
const r2 = JSON.parse(await selectTool.execute({ label: "* 审批策略", value: "无" }));
assert.equal(r2.ok, true);
assert.deepEqual(r2.selected, ["无"]);
assert.equal(
  doc.getElementById("role-select").classList.contains(ant("select-open")),
  false,
  "lingering open multi-select closed before opening next field",
);

// 4) 非可搜索下拉框绝不向 input 输入过滤词，且精确匹配「邮件」而非前缀「邮件或短信」
const r3 = JSON.parse(await selectTool.execute({ label: "通知方式", value: "邮件" }));
assert.equal(r3.ok, true, JSON.stringify(r3));
assert.equal(notifyCtl.wasSearchTyped(), false, "non-searchable combobox input was never typed into");
assert.deepEqual(r3.selected, ["邮件"], "exact match '邮件' chosen over '邮件或短信'");

// 5) 顶层弹窗作用域优先：label="所属工作区" 命中弹窗内控件而非背景页同名筛选器
const r4 = JSON.parse(await selectTool.execute({ label: "所属工作区", value: "Alpha Workspace" }));
assert.equal(r4.ok, true);
assert.equal(r4.alreadySelected, true);
assert.deepEqual(r4.selected, ["Alpha Workspace"]);

// 6) 原生 <select> 向后兼容
const r5 = JSON.parse(await selectTool.execute({ selector: "#native-sel", value: "选项B" }));
assert.equal(r5.ok, true);
assert.equal(r5.value, "b");

// 7) scrollPage / pageAct 滚动一律使用 behavior="instant"，且 fill(blur=true) 触发失焦提交
scrollBehaviors.length = 0;
let blurred = false;
doc.getElementById("num-input").addEventListener("blur", () => {
  blurred = true;
});
await fillTool.execute({ selector: "#num-input", value: "220", blur: true });
scrollPage({ selector: "#field-approval" });
scrollPage({ y: 200 });
assert.equal(blurred, true, "fill with blur:true triggers blur");
assert.ok(scrollBehaviors.length >= 2);
assert.ok(
  scrollBehaviors.every((b) => b === "instant"),
  `expected all scroll behaviors to be 'instant', got ${JSON.stringify(scrollBehaviors)}`,
);

// 8) 直接调用纯注入函数校验缺参/过期 uid 报错
assert.equal((await prepareSelectOption({ value: "无" })).ok, false);
assert.equal((await completeSelectOption({ uid: "nonexistent", value: "无" })).ok, false);

dom.window.close();
console.log("PASS test_ui_adapter_combobox.mjs");

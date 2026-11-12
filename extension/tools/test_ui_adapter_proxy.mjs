import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { locateElement } from "../lib/agent/page-snapshot.js";
import { pageAct } from "../lib/agent/page-fns.js";
import { getCompositeUIAdapterSpec } from "../lib/agent/ui-adapters/index.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const ant = (s) => `${"ant"}-${s}`;

// ── UIAdapter 隐藏 input(opacity:0) 代理控件定位与负向边界守卫（校验注入函数 100% 自包含） ──
{
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <!-- 负向边界：type=hidden、disabled、关闭态弹窗内的代理控件绝不能误命中 -->
      <div class="${ant("select-selector")}" data-r="100,20,200,30">
        <input id="hidden-field" type="hidden" value="opaque-id" />
        <input id="disabled-proxy" type="search" disabled style="opacity: 0" data-r="100,20,200,30" />
      </div>
      <div class="${ant("modal-wrap")}" style="display: none" data-r="0,0,1200,800">
        <div class="${ant("select-selector")}" data-r="100,320,300,32">
          <input id="closed-modal-input" type="search" style="opacity: 0" data-r="100,320,300,32" />
        </div>
      </div>

      <!-- 打开态编辑工单弹窗：内含隐藏代理控件（ARIA combobox + 组件库包裹层 + label 复选框） -->
      <div class="${ant("modal")} modal-shell" role="dialog" aria-modal="true" data-r="80,60,900,600">
        <div id="modal-title" class="${ant("modal-title")}" data-r="100,70,200,28">编辑配置</div>

        <!-- 级联/下拉选择器：内部 input opacity:0 且自身带 role="combobox" -->
        <div id="region-root" class="${ant("select")} ${ant("cascader")}" data-r="100,120,740,32">
          <div id="region-selector" class="${ant("select-selector")}" data-r="100,120,740,32">
            <span class="${ant("select-selection-search")}" data-r="110,121,720,30">
              <input
                id="region"
                type="search"
                role="combobox"
                class="${ant("select-selection-search-input")}"
                style="opacity: 0"
                data-r="110,121,720,30"
              />
            </span>
            <span id="region-placeholder" class="${ant("select-selection-placeholder")}" data-r="110,121,720,30">请选择区域</span>
          </div>
        </div>

        <!-- 可搜索下拉：验证 fill / press 滚动可见包裹层，但保留真实 input 节点写入并派发事件 -->
        <div id="group-root" class="${ant("select")}" data-r="100,180,500,32">
          <div id="group-selector" class="${ant("select-selector")}" data-r="100,180,500,32">
            <span class="${ant("select-selection-search")}" data-r="108,181,480,30">
              <input
                id="group-input"
                type="search"
                role="combobox"
                class="${ant("select-selection-search-input")}"
                style="opacity: 0"
                data-r="108,181,480,30"
              />
            </span>
            <span class="${ant("select-selection-placeholder")}" data-r="108,181,480,30">检索分组</span>
          </div>
        </div>

        <!-- 纯 ARIA combobox 隐藏 input 代理 -->
        <div id="aria-combo-wrap" role="combobox" aria-expanded="false" data-r="100,280,320,32">
          <input id="aria-combo-inp" type="search" style="opacity: 0" data-r="104,282,300,28" />
          <span data-r="104,282,300,28">请选择队列</span>
        </div>

        <!-- 自定义复选框与 label[for] 代理 -->
        <label id="east-wrap" class="${ant("checkbox-wrapper")}" data-r="100,230,90,24">
          <span class="${ant("checkbox")}" data-r="100,234,16,16">
            <input id="node-east" type="checkbox" style="opacity: 0" data-r="0,0,0,0" />
          </span>
          <span>华东节点</span>
        </label>
        <input id="for-cb" type="checkbox" style="opacity: 0" data-r="0,0,0,0" />
        <label id="for-cb-label" for="for-cb" data-r="210,230,80,24">自动归档</label>
      </div>
    </body></html>`,
    {
      pretendToBeVisual: true,
      runScripts: "outside-only",
      url: "https://portal.example.test/workspace/#/configs",
    },
  );

  try {
    const { window: win } = dom;
    const { document: doc } = win;

    const rectOf = (el) => {
      const raw = el.getAttribute?.("data-r");
      if (!raw) return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
      const [x, y, width, height] = raw.split(",").map(Number);
      return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height };
    };
    win.Element.prototype.getBoundingClientRect = function () {
      return rectOf(this);
    };
    const scrolledElements = [];
    win.Element.prototype.scrollIntoView = function (opts) {
      scrolledElements.push({ id: this.id || this.className, opts });
    };
    Object.defineProperty(win.HTMLElement.prototype, "innerText", {
      get() {
        return this.textContent;
      },
    });
    Object.defineProperty(win, "innerWidth", { value: 1280 });
    Object.defineProperty(win, "innerHeight", { value: 800 });

    doc.elementFromPoint = (x, y) => {
      const all = [...doc.querySelectorAll("*")].filter((el) => {
        let cur = el;
        while (cur && cur.nodeType === 1) {
          const st = win.getComputedStyle(cur);
          if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
          cur = cur.parentElement;
        }
        const r = rectOf(el);
        return r.width > 0 && r.height > 0 && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
      });
      return all.at(-1) || null;
    };

    const adapterSpec = getCompositeUIAdapterSpec();
    const runLocate = (spec) => ({
      ...win.eval(`(${locateElement.toString()})(${JSON.stringify({ adapterSpec, ...spec })})`),
    });
    const runPageAct = async (kind, spec) => ({
      ...(await win.eval(`(${pageAct.toString()})(${JSON.stringify(kind)}, ${JSON.stringify({ adapterSpec, ...spec })})`)),
    });

    // 1a. locateElement("#region") 解析到可见包裹层 #region-selector 且通过遮挡检查
    scrolledElements.length = 0;
    const locRegion = runLocate({ selector: "#region" });
    assert.equal(locRegion.ok, true, `expected locateElement(#region) ok, got ${JSON.stringify(locRegion)}`);
    assert.equal(locRegion.tag, "div");
    assert.equal(locRegion.x, 470);
    assert.equal(locRegion.y, 136);
    assert.equal(scrolledElements.at(-1)?.id, "region-selector");

    // 1b. 纯 ARIA combobox 隐藏 input 与 checkbox / label[for] 隐藏代理同样自动解析到可见宿主
    const locAria = runLocate({ selector: "#aria-combo-inp" });
    assert.equal(locAria.ok, true);
    assert.equal(locAria.tag, "div");

    const locEast = runLocate({ selector: "#node-east" });
    assert.equal(locEast.ok, true);
    assert.equal(locEast.tag, "label");

    const locForCb = runLocate({ selector: "#for-cb" });
    assert.equal(locForCb.ok, true);
    assert.equal(locForCb.tag, "label");

    // 1c. 负向守卫：hidden / disabled / 关闭弹窗内 input 仍报 notFound
    assert.equal(runLocate({ selector: "#hidden-field" }).notFound, true);
    assert.equal(runLocate({ selector: "#disabled-proxy" }).notFound, true);
    assert.equal(runLocate({ selector: "#closed-modal-input" }).notFound, true);
    assert.equal((await runPageAct("click", { selector: "#hidden-field" })).notFound, true);
    assert.equal((await runPageAct("fill", { selector: "#disabled-proxy", value: "x" })).notFound, true);

    // 1d. pageAct("click" / "probe" / "wait") 对 #region 作用在可见包裹层 #region-selector
    let regionWrapperClicks = 0;
    doc.getElementById("region-selector").addEventListener("click", () => {
      regionWrapperClicks += 1;
    });
    const clickRegion = await runPageAct("click", { selector: "#region" });
    assert.equal(clickRegion.ok, true);
    assert.equal(clickRegion.match.id, "region-selector");
    assert.equal(regionWrapperClicks, 1);

    const probeRegion = await runPageAct("probe", { selector: "#region" });
    assert.equal(probeRegion.ok, true);
    assert.equal(probeRegion.match.id, "region-selector");

    const waitRegion = await runPageAct("wait", { selector: "#region", timeoutMs: 300 });
    assert.equal(waitRegion.ok, true);
    assert.equal(waitRegion.match.id, "region-selector");

    // 1e. pageAct("fill" / "press") 滚动可见包裹层 #group-selector，但保留真实 input#group-input 写入并派发事件
    const groupEvents = [];
    const groupInput = doc.getElementById("group-input");
    groupInput.addEventListener("input", () => groupEvents.push(`input:${groupInput.value}`));
    groupInput.addEventListener("change", () => groupEvents.push(`change:${groupInput.value}`));
    groupInput.addEventListener("keydown", (e) => groupEvents.push(`keydown:${e.key}`));

    scrolledElements.length = 0;
    const fillGroup = await runPageAct("fill", { selector: "#group-input", value: "核心网关组" });
    assert.equal(fillGroup.ok, true);
    assert.equal(fillGroup.match.id, "group-input");
    assert.equal(groupInput.value, "核心网关组");
    assert.equal(scrolledElements.at(-1)?.id, "group-selector", "scrolls visible wrapper into view");
    assert.ok(groupEvents.includes("input:核心网关组") && groupEvents.includes("change:核心网关组"));

    const pressGroup = await runPageAct("press", { selector: "#group-input", key: "ArrowDown" });
    assert.equal(pressGroup.ok, true);
    assert.ok(groupEvents.includes("keydown:ArrowDown"));
  } finally {
    dom.window.close();
  }
}

console.log("PASS test_ui_adapter_proxy.mjs");

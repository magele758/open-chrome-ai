/**
 * Step 4 感知与交互底座单测：
 * 1. 只读 CDP AX 感知通道（Accessibility.getFullAXTree、代际校验 snapshotId、前后状态 diff、与 DOM 通道并行对比）
 * 2. backendDOMNodeId 坐标解析与遮挡命中测试
 * 3. debugger 权限已授时 click / set_checks / select_option 统一走「命中测试（遮挡显式报错）+ CDP Input.*」，无权限时显式回退合成事件
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createCdp } from "../lib/cdp.js";
import {
  captureAxSnapshot,
  clearAxSnapshots,
  compareAxWithDom,
  diffAxSnapshots,
  validateAxSnapshot,
} from "../lib/agent/ax-snapshot.js";
import { createAgentTools } from "../lib/agent/tools.js";
import { READ_ONLY_TOOLS } from "../lib/agent/trust/tool-classes.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

assert.equal(READ_ONLY_TOOLS.has("ax_snapshot"), true, "ax_snapshot must be registered as READ_ONLY");

// 1. AX 快照采集、代际失效（Page.frameNavigated / DOM.documentUpdated）、前后 diff 与 DOM 并行对比
{
  clearAxSnapshots();
  const listeners = { event: [], detach: [] };
  let axChecked = false;
  const api = {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (_target, method, params) => {
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "main-f" },
            childFrames: [{ frame: { id: "sub-f" } }],
          },
        };
      }
      if (method === "Accessibility.getFullAXTree") {
        if (params?.frameId === "sub-f") {
          return {
            nodes: [
              {
                nodeId: "s1",
                backendDOMNodeId: 201,
                role: { value: "button" },
                name: { value: "子框操作" },
                properties: [],
              },
            ],
          };
        }
        return {
          nodes: [
            { nodeId: "n0", ignored: true, role: { value: "generic" } },
            { nodeId: "n1", role: { value: "RootWebArea" }, name: { value: "Workspace" } },
            {
              nodeId: "n2",
              backendDOMNodeId: 101,
              role: { value: "combobox" },
              name: { value: "优先级" },
              value: { value: "高" },
              properties: [{ name: "expanded", value: { value: false } }],
            },
            {
              nodeId: "n3",
              backendDOMNodeId: 102,
              role: { value: "checkbox" },
              name: { value: "邮件通知" },
              properties: [{ name: "checked", value: { value: axChecked } }],
            },
          ],
        };
      }
      return {};
    },
    onEvent: { addListener: (fn) => listeners.event.push(fn) },
    onDetach: { addListener: (fn) => listeners.detach.push(fn) },
  };

  const cdp = createCdp({ api, idleMs: 0 });
  const snap1 = await captureAxSnapshot(cdp, 7);
  assert.equal(snap1.items.length, 3);
  assert.equal(snap1.items[0].role, "combobox");
  assert.equal(snap1.items[0].backendDOMNodeId, 101);
  assert.equal(snap1.items[1].checked, false);
  assert.equal(snap1.items[2].frameId, "sub-f");
  assert.equal(validateAxSnapshot(cdp, 7, snap1.snapshotId).valid, true);

  // 状态翻转后采集第二份快照，验证 diffAxSnapshots
  axChecked = true;
  const snap2 = await captureAxSnapshot(cdp, 7);
  const diff = diffAxSnapshots(snap1, snap2);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].name, "邮件通知");
  assert.deepEqual(diff.changed[0].changes.checked, { from: false, to: true });

  // 与 DOM 控件列表做并行对比（例如隐藏 proxy combobox 在 AX 中为 combobox，而某自定义无 ARIA div 仅在 DOM 出现）
  const domControls = [
    { tag: "input", type: "search", text: "优先级" },
    { tag: "input", type: "checkbox", text: "邮件通知", checked: false },
    { tag: "button", text: "仅DOM自定义按钮" },
  ];
  const cmp = compareAxWithDom(snap2, domControls);
  assert.equal(cmp.matchedCount, 2);
  assert.equal(cmp.axOnly.length, 1, "sub-frame button only in AX");
  assert.equal(cmp.domOnly.length, 1, "DOM-only button reported");
  assert.equal(cmp.stateMismatches.length, 1, "checked state divergence detected");

  // 触发页面导航事件 -> 旧 snapshotId 立即代际失效
  listeners.event.forEach((fn) => fn({ tabId: 7 }, "Page.frameNavigated", {}));
  const afterNav = validateAxSnapshot(cdp, 7, snap2.snapshotId);
  assert.equal(afterNav.valid, false);
  assert.equal(afterNav.stale, true);
}

// 2. debugger 权限已授时：click / set_checks / select_option 统一走命中测试（遮挡显式报错）+ CDP Input.*
{
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div id="app" data-r="0,0,1000,800">
        <button id="btn-save" type="button" data-r="40,40,120,36">保存草稿</button>
        <label id="chk-wrap" data-r="40,100,180,28">
          <input id="chk-sync" type="checkbox" data-r="44,104,18,18" />自动同步
        </label>
        <div id="multi-combo" role="combobox" aria-expanded="false" aria-controls="multi-listbox" data-r="40,160,220,34">
          <input type="search" role="combobox" aria-expanded="false" aria-controls="multi-listbox" readonly style="opacity:0" data-r="0,0,0,0" />
        </div>
        <div id="multi-listbox" role="listbox" style="display:none" data-r="40,198,220,100">
          <div id="opt-alpha" role="option" aria-selected="false" title="模块A" data-r="44,202,200,30">模块A</div>
        </div>
        <div id="modal-mask" data-r="0,0,1000,800">全局遮罩层</div>
      </div>
    </body></html>`,
    { pretendToBeVisual: true, url: "https://workspace.example.test/form" },
  );

  const prevChrome = globalThis.chrome;
  try {
    const { window: win } = dom;
    const { document: doc } = win;
    for (const k of [
      "window",
      "document",
      "location",
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
    globalThis.innerWidth = 1000;
    globalThis.innerHeight = 800;
    globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    Object.defineProperty(win.HTMLElement.prototype, "innerText", {
      configurable: true,
      get() {
        return this.textContent;
      },
    });
    win.Element.prototype.getBoundingClientRect = function () {
      if (this.style?.display === "none") {
        return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
      }
      const raw = this.getAttribute?.("data-r");
      if (!raw) return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
      const [x, y, width, height] = raw.split(",").map(Number);
      return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height };
    };
    win.Element.prototype.scrollIntoView = function () {};
    doc.elementFromPoint = (x, y) => {
      const hits = [...doc.querySelectorAll("*")].filter((el) => {
        if (el.style?.display === "none") return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      });
      return hits.length ? hits[hits.length - 1] : doc.body;
    };

    let syntheticBtnClicks = 0;
    doc.getElementById("btn-save").addEventListener("click", () => {
      syntheticBtnClicks += 1;
    });

    // 多选框：如果先触发一次合成 click 再触发一次 CDP click，会导致选中后被反选取消！
    let syntheticOptClicks = 0;
    let cdpOptClicks = 0;
    const combo = doc.getElementById("multi-combo");
    const listbox = doc.getElementById("multi-listbox");
    const optAlpha = doc.getElementById("opt-alpha");
    const toggleAlpha = () => {
      const next = optAlpha.getAttribute("aria-selected") !== "true";
      optAlpha.setAttribute("aria-selected", next ? "true" : "false");
    };
    optAlpha.addEventListener("click", () => {
      syntheticOptClicks += 1;
      toggleAlpha();
    });

    let debuggerPermGranted = true;
    const cdpMousePressed = [];
    const listeners = { event: [], detach: [] };
    const cdp = createCdp({
      idleMs: 0,
      api: {
        attach: async () => {},
        detach: async () => {},
        onEvent: { addListener: (fn) => listeners.event.push(fn) },
        onDetach: { addListener: (fn) => listeners.detach.push(fn) },
        sendCommand: async (_target, method, params) => {
          if (method === "Accessibility.getFullAXTree") {
            return {
              nodes: [
                {
                  nodeId: "b1",
                  backendDOMNodeId: 301,
                  role: { value: "button" },
                  name: { value: "保存草稿" },
                  properties: [],
                },
              ],
            };
          }
          if (method === "DOM.getContentQuads" && params?.backendNodeId === 301) {
            return { quads: [[40, 40, 160, 40, 160, 76, 40, 76]] };
          }
          if (method === "DOM.describeNode" && params?.backendNodeId === 301) {
            return { node: { localName: "button" } };
          }
          if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
            cdpMousePressed.push({ x: params.x, y: params.y });
            const hit = doc.elementFromPoint(params.x, params.y);
            if (hit === doc.getElementById("chk-sync") || doc.getElementById("chk-wrap").contains(hit)) {
              const chk = doc.getElementById("chk-sync");
              chk.checked = !chk.checked;
            } else if (combo.contains(hit)) {
              combo.setAttribute("aria-expanded", "true");
              combo.querySelector("input").setAttribute("aria-expanded", "true");
              listbox.style.display = "block";
            } else if (hit === optAlpha) {
              cdpOptClicks += 1;
              toggleAlpha();
            } else if (listbox.style.display === "block" && !listbox.contains(hit)) {
              combo.setAttribute("aria-expanded", "false");
              combo.querySelector("input").setAttribute("aria-expanded", "false");
              listbox.style.display = "none";
            }
          }
          return {};
        },
      },
    });

    globalThis.chrome = {
      tabs: { get: async (id) => ({ id, windowId: 1, url: "https://workspace.example.test/form", title: "Form" }) },
      permissions: {
        contains: async ({ permissions = [] } = {}) =>
          permissions.includes("debugger") ? debuggerPermGranted : true,
      },
      scripting: {
        executeScript: async ({ func, args = [] }) => [{ frameId: 0, result: await func(...args) }],
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      runtime: { id: "test" },
    };

    const tools = Object.fromEntries(
      createAgentTools({
        cdp,
        settings: { cdpInput: true },
        getTabId: () => 3,
        getTaskGroupId: () => 1,
        setTaskGroupId: () => {},
      }).map((t) => [t.name, t]),
    );

    // 2a. 遮罩层存在时：click 与 set_checks 均显式报 occluded: true，且绝不穿透派发任何鼠标点击！
    const clickBlocked = JSON.parse(await tools.click.execute({ selector: "#btn-save" }));
    assert.equal(clickBlocked.ok, false);
    assert.equal(clickBlocked.occluded, true);
    assert.equal(cdpMousePressed.length, 0, "must NOT dispatch CDP mouse click when occluded");
    assert.equal(syntheticBtnClicks, 0, "must NOT dispatch synthetic click when occluded");

    const checkBlocked = JSON.parse(await tools.set_checks.execute({ labels: ["自动同步"], checked: true }));
    assert.equal(checkBlocked.ok, false);
    assert.equal(checkBlocked.results[0].occluded, true);
    assert.equal(cdpMousePressed.length, 0, "set_checks must NOT click through covering mask");

    // 2b. 移除遮罩层后：debugger 已授时 click 走 CDP Input，set_checks 走 CDP Input，ax_snapshot + backendDOMNodeId 点击生效
    doc.getElementById("modal-mask").style.display = "none";

    const clickOk = JSON.parse(await tools.click.execute({ selector: "#btn-save" }));
    assert.equal(clickOk.ok, true);
    assert.equal(clickOk.via, "cdp");
    assert.equal(syntheticBtnClicks, 0, "debugger-granted click uses CDP Input, not synthetic DOM click");
    assert.equal(cdpMousePressed.length, 1);

    const checkOk = JSON.parse(await tools.set_checks.execute({ labels: ["自动同步"], checked: true }));
    assert.equal(checkOk.ok, true);
    assert.equal(doc.getElementById("chk-sync").checked, true);

    // 2c. select_option 在 debugger 已授时：选项点击零合成事件（syntheticOptClicks === 0），单次 CDP 点击选中且收起
    const selOk = JSON.parse(await tools.select_option.execute({ selector: "#multi-combo", value: "模块A" }));
    assert.equal(selOk.ok, true, `select_option failed: ${JSON.stringify(selOk)}`);
    assert.deepEqual(selOk.selected, ["模块A"]);
    assert.equal(syntheticOptClicks, 0, "zero synthetic option clicks when debugger permission granted");
    assert.equal(cdpOptClicks, 1, "exactly one trusted CDP option click");

    // 2d. ax_snapshot 工具只读调用 + backendDOMNodeId 配合 snapshotId 定位点击与过期拦截
    const axRes = JSON.parse(await tools.ax_snapshot.execute({ compareWithDom: true }));
    assert.equal(axRes.ok, true);
    assert.ok(axRes.snapshotId);
    assert.ok(axRes.domComparison);
    const byBid = JSON.parse(
      await tools.trusted_click.execute({ backendDOMNodeId: 301, snapshotId: axRes.snapshotId }),
    );
    assert.equal(byBid.ok, true);

    listeners.event.forEach((fn) => fn({ tabId: 3 }, "DOM.documentUpdated", {}));
    const staleBid = JSON.parse(
      await tools.trusted_click.execute({ backendDOMNodeId: 301, snapshotId: axRes.snapshotId }),
    );
    assert.equal(staleBid.ok, false);
    assert.match(staleBid.error, /已过期/);

    // 2e. 无 debugger 权限时：click 显式降级为合成事件回退
    debuggerPermGranted = false;
    const fallbackClick = JSON.parse(await tools.click.execute({ selector: "#btn-save" }));
    assert.equal(fallbackClick.ok, true);
    assert.equal(syntheticBtnClicks, 1, "falls back to synthetic DOM click only when debugger permission is absent");
  } finally {
    globalThis.chrome = prevChrome;
    dom.window.close();
  }
}

console.log("test_ax_snapshot: PASS");

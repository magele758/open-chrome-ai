import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createCdp } from "../lib/cdp.js";
import { DEBUG_LIMIT } from "../lib/debug-log.js";
import { pageAct } from "../lib/agent/page-fns.js";
import { actOnElement, actOnRef, locateElement, snapshotControls } from "../lib/agent/page-snapshot.js";
import { inspectFileUploadTarget } from "../lib/agent/cdp-tools.js";
import { locatePointLabel, resolveClickElementText } from "../lib/agent/click-label.js";
import { checkHitlRequirement, createAgentTools } from "../lib/agent/tools.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

// ── 0. 调试日志环形缓冲容量与元素动作别名校验 ──
assert.equal(DEBUG_LIMIT, 4000, "DEBUG_LIMIT raised to 4000 so 200+ step runs keep startup/capsule entries");
assert.equal(actOnElement, actOnRef, "actOnElement aliases actOnRef");

// ── 1. 构建通用 DOM 场景（含可见/隐藏 file input、label 包裹、自定义上传触发器、已上传列表移除按钮、普通弹窗按钮与 Shadow DOM 不可逆按钮） ──
const dom = new JSDOM(
  `<!doctype html><html><body>
    <div id="modal" role="dialog" aria-modal="true" data-r="50,40,900,760">
      <section id="modal-body" data-r="60,80,880,640">
        <!-- 1) 原生可见 file input 与隐藏 file input -->
        <input id="visible-file" type="file" data-r="100,100,220,30" />
        <input id="hidden-file" type="file" style="display: none" data-r="0,0,0,0" />

        <!-- 2) label 内嵌 file input 与 label[for] 关联 file input -->
        <label id="nested-file-label" role="button" tabindex="0" data-r="100,150,160,32">
          <input id="nested-file" type="file" style="display: none" data-r="0,0,0,0" />
          <span>选择本地文件</span>
        </label>
        <input id="for-file" type="file" style="display: none" data-r="0,0,0,0" />
        <label id="for-file-label" for="for-file" role="button" tabindex="0" data-r="280,150,160,32">关联上传文件</label>

        <!-- 3) 自定义上传包裹器：同时包含触发器 [role=button] 与同级已上传列表 [data-upload-list] 移除按钮 -->
        <div class="upload-section" data-r="380,710,320,90">
          <div id="custom-upload-trigger" role="button" tabindex="0" data-r="380,720,120,36">
            <input id="custom-attach-file" type="file" style="display: none" data-r="0,0,0,0" />
            <button id="custom-upload-btn" type="button" data-r="380,720,120,36">+ 上传附件</button>
          </div>
          <div role="list" data-upload-list="true" class="upload-list" data-r="380,762,300,28">
            <div class="upload-list-item" data-r="380,762,300,28">
              <span data-r="384,764,180,24">report.pdf</span>
              <button id="btn-remove-uploaded" type="button" data-r="610,762,64,26">移除</button>
            </div>
          </div>
        </div>

        <!-- 4) 动态 JS 触发文件框的普通按钮（DOM 内无 input[type=file]，用于验证引擎级兜底） -->
        <button id="btn-dyn-chooser" type="button" data-r="100,220,140,32">动态选择文件</button>

        <!-- 5) 弹窗底部普通流转/关闭按钮与不可逆按钮 -->
        <button id="btn-next-step" type="button" data-r="520,660,150,34">下一步：确认归档</button>
        <button id="btn-cancel" type="button" data-r="690,660,80,34"><span>取 消</span></button>
        <button id="btn-publish" type="button" data-r="790,660,80,34"><span>发 布</span></button>
        <div id="shadow-host" data-r="100,280,100,34"></div>
      </section>
    </div>
  </body></html>`,
  {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url: "https://portal.example.test/items",
  },
);

const { window: win } = dom;
const { document: doc } = win;

const shadowRoot = doc.getElementById("shadow-host").attachShadow({ mode: "open" });
shadowRoot.innerHTML = `<button id="shadow-delete" type="button" data-r="100,280,100,34">删 除</button>`;

const rectOf = (el) => {
  const raw = el.getAttribute?.("data-r");
  if (!raw) return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  const [x, y, width, height] = raw.split(",").map(Number);
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height };
};
win.Element.prototype.getBoundingClientRect = function () {
  return rectOf(this);
};
let scrollCount = 0;
win.Element.prototype.scrollIntoView = function () {
  scrollCount += 1;
};
Object.defineProperty(win.HTMLElement.prototype, "innerText", {
  get() {
    return this.textContent;
  },
});
win.Range.prototype.getBoundingClientRect = () => ({ width: 10, height: 10, top: 10, left: 10, right: 20, bottom: 20 });
Object.defineProperty(win, "innerWidth", { value: 1280 });
Object.defineProperty(win, "innerHeight", { value: 900 });

const hitTestInRoot = (root, x, y) => {
  const hits = [...root.querySelectorAll("*")].filter((el) => {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const st = win.getComputedStyle(cur);
      if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
      cur = cur.parentElement;
    }
    const r = rectOf(el);
    return r.width > 0 && r.height > 0 && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
  });
  return hits.at(-1) || null;
};
doc.elementFromPoint = (x, y) => hitTestInRoot(doc, x, y);
shadowRoot.elementFromPoint = (x, y) => hitTestInRoot(shadowRoot, x, y);

const evalInPage = (fn, ...args) =>
  win.eval(`(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(", ")})`);

const clickCounts = {};
for (const id of [
  "visible-file",
  "hidden-file",
  "nested-file",
  "nested-file-label",
  "for-file",
  "for-file-label",
  "custom-attach-file",
  "custom-upload-trigger",
  "custom-upload-btn",
  "btn-remove-uploaded",
  "btn-next-step",
  "btn-cancel",
]) {
  clickCounts[id] = 0;
  doc.getElementById(id).addEventListener("click", () => {
    clickCounts[id] += 1;
  });
}

// ── 2. 路径 1: pageAct("click") 默认 fileChooserPolicy="deny" 拦截上传控件，显式 "allow" 放行，且零误伤正常按钮 ──
{
  for (const spec of [
    { selector: "#visible-file" },
    { selector: "#hidden-file" },
    { selector: "#nested-file-label" },
    { text: "选择本地文件" },
    { selector: "#for-file-label" },
    { selector: "#custom-upload-trigger" },
    { selector: "#custom-upload-btn" },
    { text: "+ 上传附件" },
  ]) {
    const res = { ...(await evalInPage(pageAct, "click", spec)) };
    assert.equal(res.ok, false, `pageAct click should block ${JSON.stringify(spec)}`);
    assert.equal(res.blockedFileChooser, true, `expected blockedFileChooser for ${JSON.stringify(spec)}`);
    assert.match(res.error, /upload_file/);
  }
  assert.equal(clickCounts["visible-file"], 0);
  assert.equal(clickCounts["hidden-file"], 0);
  assert.equal(clickCounts["nested-file-label"], 0);
  assert.equal(clickCounts["for-file-label"], 0);
  assert.equal(clickCounts["custom-upload-btn"], 0);

  // 双向策略验证：fileChooserPolicy="allow" 时允许点击上传触发器
  const allowedTrigger = { ...(await evalInPage(pageAct, "click", { selector: "#custom-upload-btn", fileChooserPolicy: "allow" })) };
  assert.equal(allowedTrigger.ok, true);
  assert.equal(clickCounts["custom-upload-btn"], 1);
  clickCounts["custom-upload-btn"] = 0;

  // 同级已上传列表内「移除」与普通弹窗按钮正常点击通过
  const rmRes = { ...(await evalInPage(pageAct, "click", { text: "移除" })) };
  assert.equal(rmRes.ok, true);
  assert.equal(clickCounts["btn-remove-uploaded"], 1);

  const nextRes = { ...(await evalInPage(pageAct, "click", { text: "下一步：确认归档" })) };
  assert.equal(nextRes.ok, true);
  assert.equal(clickCounts["btn-next-step"], 1);

  const cancelRes = { ...(await evalInPage(pageAct, "click", { text: "取消" })) };
  assert.equal(cancelRes.ok, true);
  assert.equal(clickCounts["btn-cancel"], 1);
}

// ── 3. 路径 2: actOnElement / actOnRef("click") 策略拦截文件上传控件且零误伤 ──
{
  const snap = JSON.parse(JSON.stringify(evalInPage(snapshotControls, { limit: 100 })));
  const rawFileNodeId = win.eval(`(() => {
    const c = window.__pagelensSnap;
    const el = document.getElementById("visible-file");
    const id = c.next++;
    c.nodes.set(id, el);
    return id;
  })()`);

  const byIdNode = (domId) =>
    win.eval(`(() => {
      const target = document.getElementById(${JSON.stringify(domId)});
      for (const [id, el] of window.__pagelensSnap.nodes.entries()) if (el === target) return id;
      return null;
    })()`);

  const nestedLabelNode = byIdNode("nested-file-label");
  const customTriggerNode = byIdNode("custom-upload-trigger");
  const customBtnNode = byIdNode("custom-upload-btn");
  const removeBtnNode = byIdNode("btn-remove-uploaded");
  const nextStepNode = byIdNode("btn-next-step");
  const cancelBtnNode = byIdNode("btn-cancel");
  assert.ok(nestedLabelNode && customTriggerNode && customBtnNode && removeBtnNode && nextStepNode && cancelBtnNode);
  assert.ok(snap.items.length > 0);

  for (const node of [rawFileNodeId, nestedLabelNode, customTriggerNode, customBtnNode]) {
    const res = { ...(await evalInPage(actOnElement, "click", { node })) };
    assert.equal(res.ok, false, `actOnElement should block node=${node}`);
    assert.equal(res.blockedFileChooser, true);
    assert.match(res.error, /upload_file/);
  }
  assert.equal(clickCounts["visible-file"], 0);
  assert.equal(clickCounts["custom-upload-btn"], 0);

  assert.equal((await evalInPage(actOnElement, "click", { node: removeBtnNode })).ok, true);
  assert.equal(clickCounts["btn-remove-uploaded"], 2);
  assert.equal((await evalInPage(actOnElement, "click", { node: nextStepNode })).ok, true);
  assert.equal(clickCounts["btn-next-step"], 2);
  assert.equal((await evalInPage(actOnElement, "click", { node: cancelBtnNode })).ok, true);
  assert.equal(clickCounts["btn-cancel"], 2);
}

// ── 4. 路径 3: trusted_click 策略双向验证（deny / allow）+ Page.setInterceptFileChooserDialog 兜底 + upload_file ──
{
  const cdpCalls = [];
  const listeners = { event: [], detach: [] };
  let dynamicChooserOnMouseRelease = false;
  let uploadChooserOnMouseRelease = false;

  const api = {
    attach: async (target) => cdpCalls.push({ method: "attach", tabId: target.tabId }),
    detach: async (target) => cdpCalls.push({ method: "detach", tabId: target.tabId }),
    sendCommand: async (target, method, params) => {
      cdpCalls.push({ method, params, tabId: target.tabId });
      if (method === "Runtime.evaluate" && String(params?.expression || "").includes("#visible-file")) {
        return { result: { objectId: "file-obj-1" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: true } };
      }
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
        if (dynamicChooserOnMouseRelease) {
          for (const fn of listeners.event) fn({ tabId: target.tabId }, "Page.fileChooserOpened", { mode: "selectSingle", backendNodeId: 91 });
        } else if (uploadChooserOnMouseRelease) {
          for (const fn of listeners.event) fn({ tabId: target.tabId }, "Page.fileChooserOpened", { mode: "selectSingle", backendNodeId: 92 });
        }
      }
      return {};
    },
    onEvent: { addListener: (fn) => listeners.event.push(fn) },
    onDetach: { addListener: (fn) => listeners.detach.push(fn) },
  };

  const cdp = createCdp({ api, idleMs: 0 });

  const w1 = cdp.watchFileChooser(5);
  w1.cancel();
  const w2 = cdp.watchFileChooser(5);
  for (const fn of listeners.event) fn({ tabId: 5 }, "Page.fileChooserOpened", { backendNodeId: 123 });
  assert.equal((await w2.promise).backendNodeId, 123);

  const prevChrome = globalThis.chrome;
  globalThis.chrome = {
    tabs: { get: async (id) => ({ id, url: "https://portal.example.test/items", title: "Items" }) },
    scripting: {
      executeScript: async ({ func, args = [] }) => {
        const result = await evalInPage(func, ...args);
        return [{ frameId: 0, result: result == null ? null : JSON.parse(JSON.stringify(result)) }];
      },
    },
  };

  try {
    let activePolicy = { fileChooserPolicy: "deny" };
    const tools = Object.fromEntries(
      createAgentTools({
        getTabId: () => 5,
        settings: { cdpInput: true },
        cdp,
        getPolicy: () => activePolicy,
      }).map((t) => [t.name, t]),
    );
    const mouseEvents = () => cdpCalls.filter((c) => c.method === "Input.dispatchMouseEvent");
    const interceptStates = () =>
      cdpCalls.filter((c) => c.method === "Page.setInterceptFileChooserDialog").map((c) => c.params.enabled);

    // 4a. 默认 fileChooserPolicy="deny"：坐标或选择器落入上传按钮时 0 鼠标事件前置拦截
    for (const args of [
      { x: 423, y: 738 },
      { selector: "#visible-file" },
      { selector: "#hidden-file" },
      { selector: "#nested-file-label" },
      { selector: "#custom-upload-trigger" },
      { text: "+ 上传附件" },
    ]) {
      cdpCalls.length = 0;
      const res = JSON.parse(await tools.trusted_click.execute(args));
      assert.equal(res.ok, false, `trusted_click should block ${JSON.stringify(args)}`);
      assert.equal(res.blockedFileChooser, true);
      assert.match(res.error, /upload_file/);
      assert.equal(mouseEvents().length, 0, "blocked upload target must dispatch zero mouse events");
    }

    // 4b. 显式 fileChooserPolicy="allow" 时放行上传按钮点击
    activePolicy = { fileChooserPolicy: "allow" };
    cdpCalls.length = 0;
    const allowedByPolicy = JSON.parse(await tools.trusted_click.execute({ text: "+ 上传附件" }));
    assert.equal(allowedByPolicy.ok, true);
    assert.equal(mouseEvents().length, 3);
    activePolicy = { fileChooserPolicy: "deny" };

    // 4c. hover 悬停在上传按钮上不受影响
    cdpCalls.length = 0;
    const hovered = JSON.parse(await tools.hover.execute({ text: "+ 上传附件" }));
    assert.equal(hovered.ok, true);
    assert.equal(mouseEvents().length, 1);

    // 4d. 同级已上传列表「移除」、普通按钮「下一步：确认归档」「取 消」正常点击，且拦截开关成对关闭
    for (const args of [{ text: "移除" }, { text: "下一步：确认归档" }, { text: "取消" }, { x: 560, y: 675 }]) {
      cdpCalls.length = 0;
      const res = JSON.parse(await tools.trusted_click.execute(args));
      assert.equal(res.ok, true, `trusted_click should allow ${JSON.stringify(args)}: ${JSON.stringify(res)}`);
      assert.equal(mouseEvents().length, 3);
      assert.deepEqual(interceptStates(), [true, false], "chooser interception cleanly toggled on then off");
    }

    // 4e. 页面 JS 动态创建 input[type=file].click() 触发 Page.fileChooserOpened 被引擎兜底拦截，开关不泄漏
    cdpCalls.length = 0;
    dynamicChooserOnMouseRelease = true;
    const dynRes = JSON.parse(await tools.trusted_click.execute({ selector: "#btn-dyn-chooser" }));
    dynamicChooserOnMouseRelease = false;
    assert.equal(dynRes.ok, false);
    assert.equal(dynRes.blockedFileChooser, true);
    assert.match(dynRes.error, /已自动拦截/);
    assert.deepEqual(interceptStates(), [true, false], "chooser interception switched off in finally");

    // 4f. upload_file 工具在直传 input[type=file] 与点击自定义上传按钮两条路径均正常可用
    cdpCalls.length = 0;
    const upDirect = JSON.parse(
      await tools.upload_file.execute({ selector: "#visible-file", paths: ["/tmp/spec.png"] }),
    );
    assert.equal(upDirect.ok, true);
    assert.equal(upDirect.via, "input");

    cdpCalls.length = 0;
    uploadChooserOnMouseRelease = true;
    const upCustom = JSON.parse(
      await tools.upload_file.execute({ text: "+ 上传附件", paths: ["/tmp/report.pdf"] }),
    );
    uploadChooserOnMouseRelease = false;
    assert.equal(upCustom.ok, true);
    assert.equal(upCustom.via, "file_chooser");
    assert.deepEqual(
      cdpCalls.find((c) => c.method === "DOM.setFileInputFiles")?.params,
      { files: ["/tmp/report.pdf"], backendNodeId: 92 },
    );
    assert.equal(interceptStates().at(-1), false);
  } finally {
    globalThis.chrome = prevChrome;
  }
}

// ── 5. resolveClickElementText 纯坐标 { x, y } 命中控件文案与不可逆动作守卫联动 ──
{
  const injectInDom = async (_tabId, func, args = []) => {
    const r = await evalInPage(func, ...args);
    return r == null ? null : JSON.parse(JSON.stringify(r));
  };

  scrollCount = 0;
  const nextLabel = await resolveClickElementText({
    toolName: "trusted_click",
    args: { x: 560, y: 675 },
    tabId: 5,
    inject: injectInDom,
  });
  assert.equal(nextLabel, "下一步：确认归档");
  assert.equal(scrollCount, 0, "locatePointLabel must never scroll the page");

  const pubLabel = await resolveClickElementText({
    toolName: "trusted_click",
    args: { x: 820, y: 675 },
    tabId: 5,
    inject: injectInDom,
  });
  assert.equal(pubLabel, "发 布");
  const pubDecision = checkHitlRequirement({
    toolName: "trusted_click",
    args: { x: 820, y: 675 },
    elementText: pubLabel,
    hitlMode: "autonomous",
    targetUrl: "https://portal.example.test/items",
    userUrl: "https://portal.example.test/items",
  });
  assert.equal(pubDecision.decision, "confirm");
  assert.equal(pubDecision.irreversible?.id, "publish_send");

  const shadowDelLabel = await resolveClickElementText({
    toolName: "trusted_click",
    args: { x: 140, y: 295 },
    tabId: 5,
    inject: injectInDom,
  });
  assert.equal(shadowDelLabel, "删 除");
  const delDecision = checkHitlRequirement({
    toolName: "trusted_click",
    args: { x: 140, y: 295 },
    elementText: shadowDelLabel,
    hitlMode: "autonomous",
    targetUrl: "https://portal.example.test/items",
    userUrl: "https://portal.example.test/items",
  });
  assert.equal(delDecision.decision, "confirm");
  assert.equal(delDecision.irreversible?.id, "delete");

  const blankBgLabel = await resolveClickElementText({
    toolName: "trusted_click",
    args: { x: 70, y: 90 },
    tabId: 5,
    inject: injectInDom,
  });
  assert.equal(blankBgLabel, "");

  assert.equal(typeof locateElement, "function");
  assert.equal(typeof inspectFileUploadTarget, "function");
  assert.equal(typeof locatePointLabel, "function");
}

dom.window.close();
console.log("PASS test_file_chooser_policy_and_point_label.mjs");

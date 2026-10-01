import assert from "node:assert/strict";
import { createAgentTools, checkHitlRequirement } from "../lib/agent/tools.js";
import { createCdp } from "../lib/cdp.js";
import { dragMoveEvents, keyEvents, mouseClickEvents, parseCombo } from "../lib/cdp-input.js";
import { safeRelativeFilename, waitForDownload } from "../lib/agent/browser-api-tools.js";

// ---- 纯函数 ----
const [selAll, selAllUp] = keyEvents("Control+A");
assert.equal(selAll.type, "rawKeyDown");
assert.equal(selAll.modifiers, 2);
assert.deepEqual(selAll.commands, ["selectAll"], "accelerator shortcuts carry the editing command");
assert.equal(selAll.text, undefined);
assert.equal(selAllUp.type, "keyUp");
assert.deepEqual(keyEvents("Meta+V")[0].commands, ["paste"]);
assert.deepEqual(keyEvents("Control+Shift+Z")[0].commands, ["redo"]);
const [typed] = keyEvents("a");
assert.equal(typed.type, "keyDown");
assert.equal(typed.text, "a");
assert.equal(typed.windowsVirtualKeyCode, 65);
assert.equal(keyEvents("Shift+a")[0].text, "A");
assert.equal(keyEvents("Enter")[0].text, "\r");
assert.equal(keyEvents("F5")[0].windowsVirtualKeyCode, 116);
assert.equal(keyEvents("ArrowDown")[0].windowsVirtualKeyCode, 40);
assert.throws(() => parseCombo("Hyper+A"), /修饰键/);
assert.throws(() => parseCombo("Foo"), /按键/);
assert.throws(() => parseCombo(""), /不能为空/);

const dbl = mouseClickEvents(10, 20, { clickCount: 2 });
assert.deepEqual(dbl.map((e) => e.type), ["mouseMoved", "mousePressed", "mouseReleased", "mousePressed", "mouseReleased"]);
assert.equal(dbl[3].clickCount, 2);
assert.equal(mouseClickEvents(1, 1, { button: "right" })[1].buttons, 2);
assert.throws(() => mouseClickEvents(1, 1, { button: "x" }), /鼠标/);
const drag = dragMoveEvents({ x: 0, y: 0 }, { x: 80, y: 40 }, 4);
assert.equal(drag.at(-1).type, "mouseReleased");
assert.deepEqual([drag.at(-2).x, drag.at(-2).y], [80, 40]);

assert.equal(safeRelativeFilename("../../etc/passwd"), "etc/passwd");
assert.equal(safeRelativeFilename("/abs/a:b?.pdf"), "abs/a_b_.pdf");
assert.equal(safeRelativeFilename(""), "");

// ---- CDP 会话 ----
const calls = [];
const listeners = { event: [], detach: [] };
let handler = () => ({});
const api = {
  attach: async (target) => calls.push({ method: "attach", target }),
  detach: async (target) => calls.push({ method: "detach", target }),
  sendCommand: async (target, method, params) => {
    calls.push({ method, params, tabId: target.tabId });
    return handler(method, params);
  },
  onEvent: { addListener: (f) => listeners.event.push(f) },
  onDetach: { addListener: (f) => listeners.detach.push(f) },
};
const emit = (tabId, method, params) => listeners.event.forEach((f) => f({ tabId }, method, params));
const names = () => calls.map((c) => c.method);

let timers = [];
const cdp = createCdp({
  api,
  idleMs: 1000,
  setTimer: (fn) => {
    const t = { fn };
    timers.push(t);
    return t;
  },
  clearTimer: (t) => (timers = timers.filter((x) => x !== t)),
});
await cdp.send(5, "Runtime.evaluate", {});
await cdp.send(5, "Runtime.evaluate", {});
assert.equal(names().filter((n) => n === "attach").length, 1, "attach once per tab");
assert.equal(names().filter((n) => n === "Page.enable").length, 1);
assert.equal(timers.length, 1, "idle timer is re-armed, not stacked");
timers[0].fn();
await Promise.resolve();
assert.ok(names().includes("detach"), "idle detach removes the debugging banner");
await cdp.send(5, "Runtime.evaluate", {});
assert.equal(names().filter((n) => n === "attach").length, 2, "re-attaches on demand");

emit(5, "Page.javascriptDialogOpening", { type: "confirm", message: "确定删除？" });
assert.equal(cdp.pendingDialog(5).message, "确定删除？");
const waited = cdp.watchDialog(5);
assert.equal((await waited.promise).type, "confirm", "already-open dialog resolves immediately");
emit(5, "Page.javascriptDialogClosed", {});
assert.equal(cdp.pendingDialog(5), null);
listeners.detach.forEach((f) => f({ tabId: 5 }));
assert.equal(cdp.isAttached(5), false, "external detach (user closed banner) is tracked");

const busy = createCdp({
  api: { ...api, attach: async () => { throw new Error("Another debugger is already attached to the tab"); } },
  idleMs: 0,
});
await assert.rejects(busy.send(9, "X"), /DevTools/);

// ---- 工具 ----
const tabsInfo = { 5: { id: 5, url: "https://a.example/", title: "A 页面" } };
let scriptHandler = () => [{ result: null }];
const scriptCalls = [];
globalThis.chrome = {
  tabs: { get: async (id) => tabsInfo[id] },
  scripting: {
    executeScript: async (opts) => {
      scriptCalls.push({ name: opts.func.name, target: opts.target, args: opts.args });
      return scriptHandler(opts);
    },
  },
  webNavigation: { getFrame: async ({ frameId }) => ({ frameId, parentFrameId: frameId === 8 ? 7 : 0, url: "https://pay.example/frame" }) },
};
const images = [];
const ctx = { getTabId: () => 5, settings: { cdpInput: true }, cdp, setImage: (u) => images.push(u) };
const tools = createAgentTools(ctx);
const by = Object.fromEntries(tools.map((t) => [t.name, t]));
for (const n of ["trusted_click", "hover", "trusted_type", "press_keys", "drag_drop", "upload_file", "handle_dialog", "download_file", "list_downloads", "save_page_mhtml", "recently_closed_tabs", "restore_closed_tab", "web_search"]) {
  assert.ok(by[n], `tool ${n}`);
}
const off = createAgentTools({ ...ctx, settings: { cdpInput: false } });
assert.ok(!off.some((t) => t.name === "trusted_click"), "CDP tools hidden when the setting is off");
assert.ok(off.some((t) => t.name === "download_file"), "downloads do not need the debugger");

const located = (over = {}) => ({ ok: true, x: 120, y: 80, page: { x: 100, y: 500, w: 40, h: 20 }, tag: "button", text: "提交", count: 1, ...over });
scriptHandler = (opts) => [{ frameId: 0, result: opts.func.name === "locateElement" ? located() : null }];

const mouseTypes = () => calls.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => c.params);
calls.length = 0;
const clicked = JSON.parse(await by.trusted_click.execute({ selector: "#go" }));
assert.equal(clicked.ok, true);
assert.deepEqual(mouseTypes().map((e) => e.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
assert.deepEqual([mouseTypes()[1].x, mouseTypes()[1].y], [120, 80]);

calls.length = 0;
await by.trusted_click.execute({ selector: "#go", button: "right" });
assert.equal(mouseTypes()[1].button, "right");
calls.length = 0;
await by.trusted_click.execute({ selector: "#go", double: true });
assert.equal(mouseTypes().length, 5);
calls.length = 0;
await by.trusted_click.execute({ x: 7, y: 9 });
assert.deepEqual([mouseTypes()[1].x, mouseTypes()[1].y], [7, 9], "explicit coordinates skip locating");

scriptHandler = (opts) => [{ result: opts.func.name === "locateElement" ? { ok: false, covered: true, error: "目标被其他元素遮挡", blocker: { tag: "div", text: "Cookie 横幅" } } : null }];
calls.length = 0;
const covered = JSON.parse(await by.trusted_click.execute({ selector: "#go" }));
assert.equal(covered.ok, false);
assert.match(covered.error, /Cookie 横幅/);
assert.equal(mouseTypes().length, 0, "a covered target must not be clicked");
assert.match(await by.trusted_click.execute({}), /需要/);

// 跨域 iframe：顶层找不到 -> 所有 frame -> 加上 iframe 在顶层的偏移
scriptHandler = (opts) => {
  if (opts.func.name === "iframeRect") return [{ result: { x: 100, y: 50 } }];
  if (opts.func.name === "locateElement" && opts.target.allFrames) {
    return [{ frameId: 0, result: { ok: false, notFound: true } }, { frameId: 7, result: located({ x: 30, y: 40 }) }];
  }
  if (opts.func.name === "locateElement") return [{ result: { ok: false, notFound: true, error: "没有可见元素" } }];
  return [{ result: null }];
};
calls.length = 0;
const inFrame = JSON.parse(await by.trusted_click.execute({ selector: "#pay" }));
assert.equal(inFrame.ok, true);
assert.deepEqual([mouseTypes()[1].x, mouseTypes()[1].y], [130, 90], "iframe offset is added to frame-local coordinates");

// 键盘
scriptHandler = () => [{ result: located() }];
calls.length = 0;
const pressed = JSON.parse(await by.press_keys.execute({ keys: ["Control+A", "Control+C"] }));
assert.equal(pressed.ok, true);
const keyCalls = calls.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => c.params);
assert.deepEqual(keyCalls.filter((e) => e.type === "rawKeyDown").map((e) => e.commands[0]), ["selectAll", "copy"]);
assert.equal(JSON.parse(await by.press_keys.execute({ keys: ["Hyper+A"] })).ok, false, "bad combos fail before any input");

calls.length = 0;
await by.trusted_type.execute({ selector: "#ed", value: "你好", clear: true, submit: true });
assert.deepEqual(
  calls.filter((c) => /^Input\.(insertText|dispatchKeyEvent)$/.test(c.method)).map((c) => `${c.method.slice(6)}:${c.params.type || ""}:${c.params.key || c.params.text}`),
  [
    "dispatchKeyEvent:rawKeyDown:A",
    "dispatchKeyEvent:keyUp:A",
    "dispatchKeyEvent:rawKeyDown:Delete",
    "dispatchKeyEvent:keyUp:Delete",
    "insertText::你好",
    "dispatchKeyEvent:keyDown:Enter",
    "dispatchKeyEvent:keyUp:Enter",
  ],
  "clear -> insert -> submit order",
);
const typedCalls = calls.filter((c) => c.method === "Input.insertText");
assert.equal(typedCalls[0].params.text, "你好");
assert.ok(calls.filter((c) => c.method === "Input.dispatchKeyEvent").some((c) => c.params.commands?.[0] === "selectAll"), "clear selects all first");
assert.ok(calls.some((c) => c.method === "Input.dispatchKeyEvent" && c.params.key === "Enter"), "submit presses Enter");

// 拖拽：原生拖放被拦截后补发 drag 事件
handler = (method, params) => {
  if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved" && params.buttons === 1) {
    emit(5, "Input.dragIntercepted", { data: { items: [{ mimeType: "text/plain", data: "x" }], dragOperationsMask: 1 } });
  }
  return {};
};
calls.length = 0;
const dragged = JSON.parse(await by.drag_drop.execute({ from: { selector: "#a" }, to: { x: 300, y: 200 } }));
assert.equal(dragged.ok, true);
assert.equal(dragged.nativeDrag, true);
assert.deepEqual(calls.filter((c) => c.method === "Input.dispatchDragEvent").map((c) => c.params.type), ["dragEnter", "dragOver", "drop"]);
assert.equal(calls.at(-1).params.enabled, false, "drag interception is switched back off");
handler = () => ({});

// 上传：直接 input[type=file]
handler = (method) => {
  if (method === "Runtime.evaluate") return { result: { objectId: "obj-1" } };
  if (method === "Runtime.callFunctionOn") return { result: { value: true } };
  return {};
};
calls.length = 0;
const direct = JSON.parse(await by.upload_file.execute({ selector: "input[type=file]", paths: ["/tmp/a.pdf"] }));
assert.equal(direct.via, "input");
assert.deepEqual(calls.find((c) => c.method === "DOM.setFileInputFiles").params, { files: ["/tmp/a.pdf"], objectId: "obj-1" });
assert.match(await by.upload_file.execute({ selector: "x", paths: ["a.pdf"] }), /绝对路径/);

// 上传：自定义按钮 -> 接管文件选择框
handler = (method, params) => {
  if (method === "Runtime.evaluate") return { result: {} };
  if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
    emit(5, "Page.fileChooserOpened", { backendNodeId: 77, mode: "selectSingle" });
  }
  return {};
};
calls.length = 0;
const viaChooser = JSON.parse(await by.upload_file.execute({ text: "上传简历", paths: ["/home/u/cv.pdf"] }));
assert.equal(viaChooser.via, "file_chooser");
assert.deepEqual(calls.find((c) => c.method === "DOM.setFileInputFiles").params, { files: ["/home/u/cv.pdf"], backendNodeId: 77 });
assert.equal(calls.filter((c) => c.method === "Page.setInterceptFileChooserDialog").at(-1).params.enabled, false);
handler = () => ({});

// 对话框：脚本被 alert 卡住时，守卫抢先返回；handle_dialog 处理
assert.match(await by.handle_dialog.execute({}), /没有待处理/);
scriptHandler = () => new Promise(() => {});
setTimeout(() => emit(5, "Page.javascriptDialogOpening", { type: "alert", message: "操作成功" }), 20);
const blocked = await by.click.execute({ selector: "#alert-btn" });
assert.match(blocked, /alert 对话框：「操作成功」/, "a blocking alert no longer hangs the tool");
assert.match(blocked, /handle_dialog/);
calls.length = 0;
const handled = JSON.parse(await by.handle_dialog.execute({ accept: true }));
assert.equal(handled.handled, "alert");
assert.deepEqual(calls.find((c) => c.method === "Page.handleJavaScriptDialog").params, { accept: true });
emit(5, "Page.javascriptDialogClosed", {});

// 工具正常结束但留下了对话框
scriptHandler = () => [{ result: { ok: true, action: "click" } }];
emit(5, "Page.javascriptDialogOpening", { type: "confirm", message: "离开？" });
const after = await by.click.execute({ selector: "#x" });
assert.match(after, /confirm 对话框/);
emit(5, "Page.javascriptDialogClosed", {});

// 截图
handler = (method) => {
  if (method === "Page.getLayoutMetrics") return { cssContentSize: { width: 1200, height: 30000 } };
  if (method === "Page.captureScreenshot") return { data: "QUJD" };
  return {};
};
calls.length = 0;
const full = await by.screenshot.execute({ fullPage: true });
assert.match(full, /整页/);
const shot = calls.find((c) => c.method === "Page.captureScreenshot").params;
assert.equal(shot.captureBeyondViewport, true);
assert.equal(shot.clip.height, 16000, "tall pages are capped");
assert.equal(images.at(-1), "data:image/jpeg;base64,QUJD");
scriptHandler = (opts) => [{ result: opts.func.name === "locateElement" ? located({ page: { x: 10, y: 900, w: 300, h: 120 } }) : null }];
calls.length = 0;
await by.screenshot.execute({ selector: "#chart" });
assert.deepEqual(calls.find((c) => c.method === "Page.captureScreenshot").params.clip, { x: 10, y: 900, width: 300, height: 120, scale: 1 });
handler = () => ({});

// ---- 下载 / 会话 / 搜索 ----
const downloadsApi = (() => {
  let polls = 0;
  return {
    download: async (opts) => {
      downloadsApi.last = opts;
      return 11;
    },
    search: async (q) => {
      if (q.id === 11) {
        polls += 1;
        return [{ id: 11, state: polls < 2 ? "in_progress" : "complete", filename: "/home/u/Downloads/a.pdf", fileSize: 1234, mime: "application/pdf", url: "https://a.example/a.pdf" }];
      }
      return [{ id: 3, state: "complete", filename: "/x/b.zip", fileSize: 5, url: "https://a.example/b.zip", startTime: "t" }];
    },
  };
})();
Object.assign(globalThis.chrome, {
  downloads: downloadsApi,
  sessions: {
    getRecentlyClosed: async () => [
      { lastModified: 1, tab: { sessionId: "s1", title: "T", url: "https://t.example/" } },
      { lastModified: 2, window: { sessionId: "s2", tabs: [{}, {}] } },
    ],
    restore: async (id) => ({ tab: { id: 42, title: "T", url: "https://t.example/" }, id }),
  },
  search: { query: async (o) => (globalThis.chrome.search.last = o) },
});
const tools2 = Object.fromEntries(createAgentTools({ ...ctx, settings: {} }).map((t) => [t.name, t]));
const dl = JSON.parse(await tools2.download_file.execute({ url: "https://a.example/a.pdf", filename: "../r/a.pdf" }));
assert.equal(dl.state, "complete");
assert.equal(dl.filename, "/home/u/Downloads/a.pdf", "returns the local path");
assert.equal(downloadsApi.last.filename, "r/a.pdf", "filename cannot escape the download folder");
assert.match(await tools2.download_file.execute({ url: "javascript:alert(1)" }), /http/);
assert.match(await tools2.download_file.execute({ url: "file:///etc/passwd" }), /http/);
assert.equal(JSON.parse(await tools2.list_downloads.execute({})).at(0).filename, "/x/b.zip");
const closed = JSON.parse(await tools2.recently_closed_tabs.execute({}));
assert.deepEqual(closed.map((c) => c.kind), ["tab", "window"]);
assert.equal(JSON.parse(await tools2.restore_closed_tab.execute({ sessionId: "s1" })).tab.id, 42);
await tools2.web_search.execute({ text: "chrome debugger" });
assert.deepEqual(globalThis.chrome.search.last, { text: "chrome debugger", disposition: "NEW_TAB" });
assert.match(await tools2.web_search.execute({ text: " " }), /不能为空/);
const timedOut = await waitForDownload({ search: async () => [{ id: 1, state: "in_progress" }] }, 1, { timeoutMs: 10, pollMs: 2 });
assert.equal(timedOut.state, "in_progress", "slow downloads return instead of hanging");

for (const name of ["download_file", "upload_file"]) {
  assert.equal(checkHitlRequirement({ toolName: name, hitlMode: "strict" }).needsConfirmation, true, `${name} needs confirmation`);
  assert.equal(checkHitlRequirement({ toolName: name, hitlMode: "autonomous" }).needsConfirmation, false);
}

console.log("test_cdp_tools ok");

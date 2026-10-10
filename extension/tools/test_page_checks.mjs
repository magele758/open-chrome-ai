import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { checkStates, listControls } from "../lib/agent/page-fns.js";
import { countCompletedToolRuns } from "../lib/agent/shell-policy.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const dom = new JSDOM(
  `<body>
  <button data-r="0,0,50,20">发布</button>
  <a href="/x" data-r="0,30,50,20">首页</a>
  <div role="dialog" data-r="100,100,600,600">
    <div data-r="110,110,300,30"><button type="button" role="checkbox" aria-checked="mixed" data-r="110,110,18,18"></button><span>全选</span></div>
    <div data-r="110,150,300,30"><button type="button" role="checkbox" aria-checked="false" data-r="110,150,18,18"></button><span>微信公众号 @听溪问禅</span></div>
    <div data-r="110,190,300,30"><button type="button" role="checkbox" aria-checked="true" data-r="110,190,18,18"></button><span>知乎 @彭磊</span></div>
    <div data-r="110,230,300,30"><button type="button" role="checkbox" aria-checked="false" data-r="110,230,18,18"></button><span>B站专栏 @我为elf狂</span></div>
    <div data-r="110,270,300,30"><button type="button" role="checkbox" aria-checked="false" aria-disabled="true" data-r="110,270,18,18"></button><span>今日头条 登录</span></div>
    <label data-r="110,310,300,30"><input type="checkbox" checked data-r="110,310,16,16"> 掘金</label>
    <div data-r="110,350,300,30"><button type="button" role="checkbox" aria-checked="false" data-r="110,350,18,18"></button><span>全选</span></div>
    <button data-r="500,700,50,20">确定</button>
  </div>
  </body>`,
  { pretendToBeVisual: true, url: "http://localhost:8080/" },
);
const { window } = dom;
const { document } = window;
const rectOf = (el) => {
  const raw = el.getAttribute?.("data-r");
  if (!raw) return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  const [x, y, width, height] = raw.split(",").map(Number);
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height };
};
window.Element.prototype.getBoundingClientRect = function () {
  return rectOf(this);
};
window.Element.prototype.scrollIntoView = function () {};
Object.defineProperty(window.HTMLElement.prototype, "innerText", {
  get() {
    return this.textContent;
  },
});
Object.assign(globalThis, {
  window,
  document,
  HTMLInputElement: window.HTMLInputElement,
});

// listControls: modal controls first, checkboxes carry label + checked
{
  const items = listControls(50);
  assert.equal(items[0].modal, true);
  assert.ok(items.slice(0, 8).every((i) => i.modal));
  const wx = items.find((i) => i.text.startsWith("微信公众号"));
  assert.equal(wx.checked, false);
  const zh = items.find((i) => i.text.startsWith("知乎"));
  assert.equal(zh.checked, true);
  const outside = items.findIndex((i) => i.text === "发布");
  const confirm = items.findIndex((i) => i.text === "确定");
  assert.ok(confirm < outside, "dialog controls precede page controls");
}

// checkStates: list mode
{
  const { items } = checkStates({});
  assert.equal(items.length, 7);
  assert.deepEqual(items.find((i) => i.label.startsWith("今日头条")), { label: "今日头条 登录", checked: false, disabled: true });
  assert.equal(items.find((i) => i.label === "掘金").checked, true);
}

// checkStates: prefix match, centre coordinates, ambiguity, missing
{
  const { results } = checkStates({ labels: ["微信公众号", "知乎", "B站", "全选", "不存在"] });
  assert.deepEqual(results[0], {
    want: "微信公众号", found: true, label: "微信公众号 @听溪问禅", checked: false, disabled: false, ambiguous: false, x: 119, y: 159,
  });
  assert.equal(results[1].checked, true);
  assert.equal(results[2].label, "B站专栏 @我为elf狂");
  assert.equal(results[3].ambiguous, true);
  assert.equal(results[4].found, false);
  assert.equal(checkStates({ labels: ["微信"], exact: true }).results[0].found, false);
}

// duplicate-call guard: re-reading after a mutation is not a repeat
{
  const call = (id, name, args) => ({ role: "assistant", tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
  const result = (id) => ({ role: "tool", tool_call_id: id, content: "x" });
  const probe = { code: "return 1" };
  const history = [
    call("a", "run_js", probe), result("a"),
    call("b", "run_js", probe), result("b"),
  ];
  assert.equal(countCompletedToolRuns(history, "run_js", JSON.stringify(probe)), 2);
  history.push(call("c", "trusted_click", { text: "x" }), result("c"));
  assert.equal(countCompletedToolRuns(history, "run_js", JSON.stringify(probe)), 0);
  assert.equal(countCompletedToolRuns(history, "trusted_click", JSON.stringify({ text: "x" })), 1);
}

console.log("test_page_checks ok");

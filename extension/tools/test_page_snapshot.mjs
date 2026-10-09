import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { snapshotControls, actOnRef, scrollViewport, locateElement, scrollContainerOf, iframeRect } from "../lib/agent/page-snapshot.js";
import { pageAct, queryDom, listControls, runJs } from "../lib/agent/page-fns.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const dom = new JSDOM(
  `<body>
  <label for="mail">邮箱</label><input id="mail" data-r="10,10,200,30">
  <input id="pw" type="password" value="s3cret" aria-label="密码" data-r="10,50,200,30">
  <button id="go" data-r="10,100,80,30">登录</button>
  <button id="off" disabled data-r="10,140,80,30">禁用</button>
  <button id="gone" style="display:none" data-r="10,180,80,30">隐藏</button>
  <button id="far" data-r="10,5000,80,30">很远</button>
  <select id="sel" aria-label="城市" data-r="10,220,120,30"><option value="a">北京</option><option value="b">上海</option></select>
  <div role="checkbox" aria-checked="true" data-r="10,260,20,20">同意条款</div>
  <div id="host" data-r="0,0,0,0"></div>
  <div id="cover" data-r="0,0,0,0"></div>
  </body>`,
  { pretendToBeVisual: true },
);
const { window } = dom;
const { document } = window;

const shadow = document.getElementById("host").attachShadow({ mode: "open" });
shadow.innerHTML = `<button id="deep" data-r="10,300,90,30">影子按钮</button>`;

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
window.scrollBy = () => {};
Object.defineProperty(window.HTMLElement.prototype, "innerText", {
  get() {
    return this.textContent;
  },
});
window.Range.prototype.getBoundingClientRect = () => ({ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 });
const allEls = () => {
  const out = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      out.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return out;
};
document.elementFromPoint = (x, y) => {
  const hits = allEls().filter((el) => {
    const r = rectOf(el);
    return r.width > 0 && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
  });
  return hits.at(-1) || null;
};

Object.assign(globalThis, {
  window,
  document,
  location: window.location,
  getComputedStyle: window.getComputedStyle.bind(window),
  NodeFilter: window.NodeFilter,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  HTMLSelectElement: window.HTMLSelectElement,
  Event: window.Event,
  InputEvent: window.InputEvent,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
});
Object.defineProperty(window, "innerWidth", { value: 1000 });
Object.defineProperty(window, "innerHeight", { value: 700 });

const snap = snapshotControls({});
const byLabel = Object.fromEntries(snap.items.map((i) => [i.label, i]));
assert.ok(byLabel["邮箱"], "label-for name");
assert.equal(byLabel["邮箱"].kind, "fill");
assert.ok(byLabel["登录"] && byLabel["登录"].kind === "click", "button");
assert.equal(byLabel["禁用"], undefined, "disabled skipped");
assert.equal(byLabel["隐藏"], undefined, "display:none skipped");
assert.equal(byLabel["很远"], undefined, "offscreen skipped by default");
assert.ok(byLabel["影子按钮"], "shadow DOM control included");
assert.equal(byLabel["密码"].secret, true);
assert.equal(byLabel["密码"].value, undefined, "password value never leaves the page");
assert.equal(byLabel["城市"].kind, "select");
assert.deepEqual(byLabel["城市"].options.map((o) => o.label), ["北京", "上海"]);
assert.equal(byLabel["同意条款"].role, "checkbox");
assert.equal(byLabel["同意条款"].checked, "true");
const ys = snap.items.map((i) => i.rect.y);
assert.deepEqual(ys, [...ys].sort((a, b) => a - b), "reading order");
assert.equal(snapshotControls({ viewportOnly: false }).items.some((i) => i.label === "很远"), true);

let clicks = 0;
document.getElementById("go").addEventListener("click", () => (clicks += 1));
const ok = await actOnRef("click", { node: byLabel["登录"].node, label: "登录" });
assert.equal(ok.ok, true);
assert.equal(clicks, 1);

const filled = await actOnRef("fill", { node: byLabel["邮箱"].node, label: "邮箱", value: "a@b.c" });
assert.equal(filled.ok, true);
assert.equal(document.getElementById("mail").value, "a@b.c");

const picked = await actOnRef("select", { node: byLabel["城市"].node, label: "城市", value: "上海" });
assert.equal(picked.ok, true);
assert.equal(document.getElementById("sel").value, "b");
assert.equal((await actOnRef("select", { node: byLabel["城市"].node, value: "火星" })).ok, false);

let deepClicks = 0;
shadow.getElementById("deep").addEventListener("click", () => (deepClicks += 1));
assert.equal((await actOnRef("click", { node: byLabel["影子按钮"].node, label: "影子按钮" })).ok, true);
assert.equal(deepClicks, 1, "click reaches into shadow root");

const stale = await actOnRef("click", { node: byLabel["登录"].node, label: "别的名字" });
assert.equal(stale.stale, true, "label drift is reported as stale");
assert.equal((await actOnRef("click", { node: 9999 })).stale, true, "unknown node");

const cover = document.getElementById("cover");
cover.setAttribute("data-r", "0,90,300,60");
const covered = await actOnRef("click", { node: byLabel["登录"].node, label: "登录" });
assert.equal(covered.ok, false);
assert.equal(covered.covered, true, "overlay blocks click");
assert.equal(clicks, 1, "covered click must not fire");
cover.setAttribute("data-r", "0,0,0,0");

assert.equal(scrollViewport("down").ok, true);

// pageAct: 影子 DOM 里的选择器 / 文字能被找到；找不到时带 notFound 标记
const inShadow = await pageAct("click", { selector: "#deep" });
assert.equal(inShadow.ok, true, "pageAct finds shadow selector");
const byText = await pageAct("click", { text: "影子按钮" });
assert.equal(byText.ok, true, "pageAct finds shadow text");
const missing = await pageAct("click", { selector: "#nope" });
assert.equal(missing.ok, false);
assert.equal(missing.notFound, true);
const badSelector = await pageAct("click", { selector: "###" });
assert.equal(badSelector.ok, false);
assert.notEqual(badSelector.notFound, true, "syntax errors are not 'not found'");
const probe = await pageAct("probe", { selector: "#deep" });
assert.equal(probe.ok, true);
assert.equal(probe.match.tag, "button");
assert.equal(queryDom("#deep").length, 1, "queryDom falls back into shadow roots");
assert.ok(listControls(80).some((c) => c.text === "影子按钮"), "listControls includes shadow controls");

// runJs 在 CSP 拦截 eval 时要能识别，而不是当成"元素不存在"
assert.equal((await runJs("return 1+1")).ok, true);
const realAsync = Object.getPrototypeOf(async () => {}).constructor;
const evalBlocked = await (async () => {
  const saved = globalThis.EvalError;
  try {
    Object.defineProperty(Object.getPrototypeOf(async () => {}), "constructor", {
      value: function () {
        throw new EvalError("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not allowed");
      },
      configurable: true,
    });
    return await runJs("return 1");
  } finally {
    Object.defineProperty(Object.getPrototypeOf(async () => {}), "constructor", { value: realAsync, configurable: true });
    globalThis.EvalError = saved;
  }
})();
assert.equal(evalBlocked.ok, false);
assert.equal(evalBlocked.cspBlocked, true, "CSP-blocked eval is flagged so the caller can fall back");

// locateElement：给 CDP 可信输入算坐标
const loc = locateElement({ selector: "#go" });
assert.equal(loc.ok, true);
assert.deepEqual([loc.x, loc.y], [50, 115], "center of the button rect");
assert.equal(locateElement({ text: "登录" }).ok, true);
assert.equal(locateElement({ selector: "#deep" }).ok, true, "locates inside shadow DOM");
{
  let scrolls = 0;
  const prevScroll = window.Element.prototype.scrollIntoView;
  window.Element.prototype.scrollIntoView = function () { scrolls += 1; };
  const labelOnly = locateElement({ selector: "#go", labelOnly: true });
  assert.equal(labelOnly.text, "登录");
  assert.equal(labelOnly.x, undefined, "label lookup does not resolve a click point");
  assert.equal(scrolls, 0, "label lookup does not scroll the page");
  assert.equal(locateElement({ selector: "#pw", labelOnly: true }).text, "密码", "aria-label is the button text; input values stay out");
  assert.equal(scrolls, 0);
  window.Element.prototype.scrollIntoView = prevScroll;
}
assert.equal(locateElement({ selector: "#nope" }).notFound, true);
assert.equal(locateElement({ node: 424242 }).stale, true);
const fresh = snapshotControls({});
const goRef = fresh.items.find((i) => i.label === "登录");
assert.equal(locateElement({ node: goRef.node }).ok, true, "locate by snapshot ref");
cover.setAttribute("data-r", "0,90,300,60");
const hidden = locateElement({ selector: "#go" });
assert.equal(hidden.covered, true);
assert.equal(hidden.blocker.tag, "div");
cover.setAttribute("data-r", "0,0,0,0");

// 页面内部滚动容器
document.body.insertAdjacentHTML(
  "beforeend",
  '<div id="pane" style="overflow-y:auto"><button id="inpane" data-r="300,300,60,20">面板内</button></div>',
);
const pane = document.getElementById("pane");
Object.defineProperty(pane, "scrollHeight", { value: 900 });
Object.defineProperty(pane, "clientHeight", { value: 300 });
pane.scrollBy = (_x, dy) => (pane.scrollTop += dy);
const paneRef = snapshotControls({}).items.find((i) => i.label === "面板内");
const scrolled = scrollContainerOf(paneRef.node, "down");
assert.equal(scrolled.ok, true);
assert.equal(scrolled.moved, true);
assert.equal(scrolled.container, "div");
assert.equal(scrollContainerOf(goRef.node, "down").ok, false, "page-level controls report no container");

document.body.insertAdjacentHTML("beforeend", '<iframe src="https://pay.example/frame" data-r="40,500,300,200"></iframe>');
assert.deepEqual(iframeRect("https://pay.example/frame"), { x: 40, y: 500, ambiguous: false });
assert.equal(iframeRect("https://other.example/").ambiguous, true, "single iframe is used as a fallback");

console.log("test_page_snapshot ok");

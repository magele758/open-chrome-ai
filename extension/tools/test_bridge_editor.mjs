import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { plEditor, plReadRenderedHtml, plSelectContents, plSetInputValue, plWaitFor } from "../lib/bridge/editor-fns.js";
import { deriveExpect, sourceStats } from "../lib/bridge/tools.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const dom = new JSDOM(
  `<head><style>
    #out { color: rgb(51, 51, 51); font-size: 15px; line-height: 1.75; }
    #out h2 { color: rgb(0, 102, 204); border-bottom: 2px solid rgb(0, 102, 204); }
    #out table { border-collapse: collapse; }
    #out td { border: 1px solid rgb(204, 204, 204); padding: 6px; }
    .secret { display: none; }
  </style></head>
  <body>
  <div class="title-editor__input" data-r="10,10,600,40">
    <div id="title-pm" class="ProseMirror" contenteditable="true" data-r="10,10,600,40"></div>
  </div>
  <textarea id="title" data-r="10,60,600,40"></textarea>
  <div id="side" contenteditable="true" data-r="700,10,100,30">side note</div>
  <div id="body" class="ProseMirror" contenteditable="true" data-r="10,120,600,500"><p data-placeholder="从这里开始写正文" class="is-empty"></p></div>
  <div id="hidden-editor" class="ProseMirror" contenteditable="true" data-r="0,0,0,0"></div>
  <div id="out" data-r="10,700,600,300">
    <h2>标题二</h2>
    <p>第一段 <a href="/rel">链接</a></p>
    <script>alert(1)</script>
    <p class="secret">隐藏</p>
    <table><tr><td>A</td><td>B</td></tr></table>
    <img src="/pic.png" alt="">
  </div>
  </body>`,
  { pretendToBeVisual: true, url: "http://localhost:8080/page" },
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
document.elementFromPoint = (x, y) => {
  const hits = [...document.querySelectorAll("*")].filter((el) => {
    const r = rectOf(el);
    return r.width > 0 && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
  });
  return hits.at(-1) || null;
};
Object.assign(globalThis, {
  window,
  document,
  getComputedStyle: (el, pseudo) => (pseudo ? { content: "none" } : window.getComputedStyle(el)),
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  Event: window.Event,
});

// ---- pick: skip title editor and side input, prefer placeholder ----
const pick = plEditor("pick", {});
assert.equal(pick.ok, true);
assert.equal(pick.placeholder.includes("从这里开始写正文"), true);
assert.equal(pick.rect.h, 500);
assert.ok(pick.reasons.includes("placeholder"));
assert.equal(pick.excludedCount, 1, "title-editor ProseMirror is excluded");
assert.ok(pick.candidates.every((c) => c.className !== "ProseMirror" || c.score <= pick.score));
assert.equal(typeof pick.domIndex, "number");

// explicit selector wins; excluded default can be overridden
assert.equal(plEditor("pick", { selector: "#side" }).rect.w, 100);
assert.equal(plEditor("pick", { selector: "#nope" }).code, "NO_EDITOR");

// without placeholder text the body is still preferred over the title / side note
document.querySelector("#body p").setAttribute("data-placeholder", "");
const pick2 = plEditor("pick", {});
assert.equal(pick2.rect.h, 500, "body (tall) beats side note (short) and the excluded title");
// domIndex pins the same editor even if scoring changes
assert.equal(plEditor("pick", { domIndex: pick.domIndex }).rect.h, 500);
document.querySelector("#body p").setAttribute("data-placeholder", "从这里开始写正文");

// ---- prepare: point inside the editor ----
const prep = plEditor("prepare", {});
assert.equal(prep.ok, true);
assert.ok(prep.point.y >= 120 && prep.point.y <= 620);
assert.ok(prep.point.x >= 10 && prep.point.x <= 610);

// ---- verify ----
let v = plEditor("verify", { expect: { minChars: 10 } });
assert.equal(v.ok, false, "empty editor fails minChars");
assert.equal(v.checks.find((c) => c.name === "minChars").actual, 0);

document.querySelector("#body").innerHTML =
  "<h2>日报</h2><p>" + "这是正文内容。".repeat(10) + "</p><table><tr><td>1</td></tr></table><img src='a.png'><img src='b.png'>";
v = plEditor("verify", {
  expect: { minChars: 50, minTables: 1, minImages: 2, contains: ["日报"] },
  titleBefore: "",
  titleEquals: "",
});
assert.equal(v.ok, true, JSON.stringify(v.checks));
assert.equal(v.stats.tables, 1);
assert.equal(v.stats.imgs, 2);
assert.equal(v.title, "");
assert.equal(v.titlePolluted, false);
assert.equal(plEditor("verify", { expect: { minTables: 2 } }).ok, false);
assert.equal(plEditor("verify", { expect: { contains: ["不存在"] } }).ok, false);

// title pollution: body text landing in the title field is detected
const titleEl = document.querySelector("#title");
titleEl.value = "这是正文内容。".repeat(10);
v = plEditor("verify", { expect: { minChars: 50 } });
assert.equal(v.ok, false);
assert.equal(v.titlePolluted, true);
assert.equal(v.checks.find((c) => c.name === "titleNotPolluted").ok, false);
titleEl.value = "每日 LLM 简报";
v = plEditor("verify", { expect: { minChars: 50 }, titleEquals: "每日 LLM 简报", titleBefore: "每日 LLM 简报" });
assert.equal(v.ok, true);
v = plEditor("verify", { titleBefore: "别的标题" });
assert.equal(v.ok, false, "title changed since before");
assert.equal(plEditor("verify", { titleSelector: "", expect: { minChars: 1 } }).title, null, "title check can be disabled");
assert.equal(plEditor("verify", { includeHtml: true }).html.includes("<table>"), true);

// ---- set input value ----
let setRes = plSetInputValue({ selector: "#title", value: "新标题" });
assert.equal(setRes.ok, true);
assert.equal(setRes.matches, true);
assert.equal(titleEl.value, "新标题");
let inputEvents = 0;
titleEl.addEventListener("input", () => (inputEvents += 1));
plSetInputValue({ selector: "#title", value: "再来" });
assert.equal(inputEvents, 1, "input event dispatched for framework state");
assert.equal(plSetInputValue({ selector: "#body", value: "x" }).ok, false, "contenteditable is not an input");
assert.equal(plSetInputValue({ selector: "#none", value: "x" }).notFound, true);

// ---- read rendered html: styles inlined, junk removed ----
const rendered = plReadRenderedHtml({ selector: "#out" });
assert.equal(rendered.ok, true);
assert.ok(rendered.html.includes("color:rgb(51, 51, 51)"), "root colour inlined from stylesheet");
assert.ok(/<h2[^>]*style="[^"]*color:rgb\(0, 102, 204\)/.test(rendered.html), "heading colour inlined");
assert.ok(/<td[^>]*style="[^"]*border-top-width:1px/.test(rendered.html), "table cell border inlined");
assert.ok(rendered.html.includes('href="http://localhost:8080/rel"'), "relative href made absolute");
assert.ok(rendered.html.includes('src="http://localhost:8080/pic.png"'));
assert.ok(!rendered.html.includes("<script"), "script stripped");
assert.ok(!rendered.html.includes('id="out"'), "id stripped");
assert.equal(rendered.stats.tables, 1);
assert.equal(rendered.stats.imgs, 1);
assert.equal(plReadRenderedHtml({ selector: "#missing" }).notFound, true);
assert.equal(plReadRenderedHtml({ selector: "" }).ok, false);
assert.ok(plReadRenderedHtml({ selector: "#out", removeSelectors: ["table"] }).html.indexOf("<table") === -1);

// ---- select contents ----
const sel = plSelectContents({ selector: "#out" });
assert.equal(sel.tables, 1);
assert.equal(plSelectContents({ selector: "#none" }).notFound, true);

// ---- wait for ----
assert.equal((await plWaitFor({ selector: "#out", timeoutMs: 200 })).ok, true);
const miss = await plWaitFor({ selector: "#never", timeoutMs: 150 });
assert.equal(miss.ok, false);

// ---- expectation derivation from source html ----
const html = "<p>" + "字".repeat(100) + "</p><table><tr><td>x</td></tr></table><img src=a><IMG src=b>";
assert.deepEqual(sourceStats(html), { chars: 101, tables: 1, imgs: 2 });
const exp = deriveExpect(html, { minChars: 5 });
assert.equal(exp.minTables, 1);
assert.equal(exp.minImages, 2);
assert.equal(exp.minChars, 5, "explicit expectation overrides derived");
assert.equal(deriveExpect(html).minChars, 85);
assert.deepEqual(deriveExpect("", undefined), {});

console.log("bridge editor tests passed");

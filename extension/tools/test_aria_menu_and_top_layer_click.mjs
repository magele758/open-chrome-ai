import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { listControls, pageAct } from "../lib/agent/page-fns.js";
import { locateElement } from "../lib/agent/page-snapshot.js";
import { getCompositeUIAdapterSpec } from "../lib/agent/ui-adapters/index.js";
import { resolveClickElementText } from "../lib/agent/click-label.js";
import { matchIrreversible } from "../lib/agent/trust/irreversible.js";
import { checkHitlRequirement } from "../lib/agent/tools.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const dom = new JSDOM(
  `<!doctype html><html><body>
    <!-- 底层母弹窗（先挂载，DOM 顺序在前） -->
    <div id="parent-wrap" style="z-index: 1000" data-r="0,0,1440,900">
      <div id="parent-modal" role="dialog" aria-modal="true" style="z-index: 1000" data-r="80,40,1100,800">
        <header data-r="80,40,1100,48">
          <h2 data-r="100,50,200,28">主编辑弹窗</h2>
        </header>
        <section data-r="80,90,1100,640">
          <button id="nav-0" class="nav-link" type="button" data-r="90,110,100,32">分节一</button>
          <button id="nav-1" class="nav-link" type="button" data-r="90,150,100,32">分节二</button>
          <input id="title-input" type="text" value="包含华东区的标题文本" data-r="240,110,400,32" />
          <span class="tag-chip" role="button" data-r="240,160,90,24">规格甲</span>
        </section>
        <footer data-r="80,740,1100,52">
          <button id="parent-next" type="button" data-r="820,748,140,32">下一步：子流程</button>
          <button id="parent-cancel" type="button" data-r="980,748,80,32"><span>取 消</span></button>
        </footer>
      </div>
    </div>

    <!-- 已关闭的历史级联浮层（display: none，DOM 中残留 3 个 li） -->
    <div id="closed-cascader" style="display: none" data-r="240,200,320,180">
      <ul class="cascader-col" role="menu" data-r="240,200,320,180">
        <li id="hidden-cat-0" class="cascader-item" role="menuitemcheckbox" data-r="240,204,300,32">旧分类一</li>
        <li id="hidden-cat-1" class="cascader-item" role="menuitemcheckbox" data-r="240,236,300,32">旧分类二</li>
        <li id="hidden-cat-2" class="cascader-item" role="menuitemcheckbox" data-r="240,268,300,32">华东区</li>
      </ul>
    </div>

    <!-- 当前展开的可见级联浮层（含 menuitemcheckbox 一级与二级菜单，以及 0x0 无障碍隐藏列表） -->
    <div id="open-cascader" class="cascader-popup" data-r="240,220,380,180">
      <div role="listbox" style="width: 0px; height: 0px; overflow: hidden" data-r="0,0,0,0">
        <div id="a11y-opt" role="option" data-r="240,220,100,22">华东区</div>
      </div>
      <div class="cascader-menus" data-r="240,220,380,180">
        <ul class="cascader-col" role="menu" data-r="240,220,180,180">
          <li id="region-disabled" class="cascader-item" role="menuitemcheckbox" aria-disabled="true" data-r="240,222,176,32">华东区</li>
          <li id="region-north" class="cascader-item" role="menuitemcheckbox" title="华北区" data-r="240,254,176,32">
            <div>华北区</div>
          </li>
          <li id="region-east" class="cascader-item" role="menuitemcheckbox" title="华东区" data-r="240,286,176,32">
            <div>华东区</div>
          </li>
          <li id="region-wrong" class="cascader-item" role="menuitemcheckbox" title="华南区" data-r="240,318,176,32">
            <div>华南区</div>
          </li>
        </ul>
        <ul class="cascader-col" role="menu" data-r="422,220,180,180">
          <li id="city-sh" class="cascader-item" role="menuitemcheckbox" title="区域中心城" data-r="422,222,176,32">
            <div>区域中心城</div>
          </li>
        </ul>
      </div>
    </div>

    <!-- 顶层子模态框（后挂载，z-index 更高） -->
    <div id="child-wrap" style="z-index: 1050" data-r="0,0,1440,900">
      <div id="child-modal" role="dialog" aria-modal="true" style="z-index: 1050" data-r="300,120,760,520">
        <header data-r="300,120,760,48">
          <h2 data-r="320,130,200,28">顶层子弹窗</h2>
        </header>
        <section data-r="300,170,760,400">
          <label id="child-spec" data-r="340,210,100,28">
            <input type="radio" name="spec" value="1" data-r="342,214,16,16" />
            <span>规格甲</span>
          </label>
          <button id="btn-confirm-rec" type="button" data-r="520,210,120,28">确认当前推荐</button>
          <button id="btn-safe-act" class="action-btn" type="button" data-r="340,260,90,32">普通预览</button>
          <button id="btn-danger-pub" class="action-btn" type="button" data-r="450,260,90,32">立即发布</button>
        </section>
        <footer data-r="300,580,760,52">
          <button id="child-cancel" type="button" data-r="740,588,76,32">取消</button>
          <button id="child-ok" type="button" data-r="830,588,76,32">确 认</button>
          <button id="child-next" type="button" data-r="920,588,88,32">下一步</button>
        </footer>
      </div>
    </div>
  </body></html>`,
  {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url: "https://example.test/workspace",
  },
);

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
win.Element.prototype.scrollIntoView = function () {};
Object.defineProperty(win.HTMLElement.prototype, "innerText", {
  get() {
    return this.textContent;
  },
});
Object.defineProperty(win, "innerWidth", { value: 1440 });
Object.defineProperty(win, "innerHeight", { value: 900 });

doc.elementFromPoint = (x, y) => {
  const all = [...doc.querySelectorAll("*")].filter((el) => {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const st = win.getComputedStyle(cur);
      if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
      if (cur.style?.overflow === "hidden" && (cur.style?.width === "0px" || cur.style?.height === "0px")) {
        return false;
      }
      cur = cur.parentElement;
    }
    const r = rectOf(el);
    return r.width > 0 && r.height > 0 && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
  });
  return all.at(-1) || null;
};

const adapterSpec = getCompositeUIAdapterSpec();
const runPageAct = async (kind, spec) => ({
  ...(await win.eval(`(${pageAct.toString()})(${JSON.stringify(kind)}, ${JSON.stringify({ adapterSpec, ...spec })})`)),
});
const runLocate = (spec) => ({
  ...win.eval(`(${locateElement.toString()})(${JSON.stringify({ adapterSpec, ...spec })})`),
});
const runListControls = (limit) =>
  JSON.parse(JSON.stringify(win.eval(`(${listControls.toString()})(${JSON.stringify(limit)}, ${JSON.stringify(adapterSpec)})`)));

const clickedIds = [];
for (const el of doc.querySelectorAll("li, button, label, span")) {
  el.addEventListener("click", (e) => {
    if (e.currentTarget === el && el.id) clickedIds.push(el.id);
  });
}

// 1. click({ text }) 与 locateElement({ text }) 支持 menuitemcheckbox 级联菜单项，
//    自动跳过关闭态浮层、0x0 无障碍节点、disabled 项与含同名子串的输入框
{
  doc.getElementById("child-wrap").style.display = "none";
  clickedIds.length = 0;
  const c1 = await runPageAct("click", { text: "华东区" });
  assert.equal(c1.ok, true, `expected click(text='华东区') ok, got ${JSON.stringify(c1)}`);
  assert.equal(c1.match.id, "region-east");
  assert.deepEqual(clickedIds, ["region-east"]);

  const loc1 = runLocate({ text: "华东区" });
  assert.equal(loc1.ok, true, `expected locateElement(text='华东区') ok, got ${JSON.stringify(loc1)}`);
  assert.equal(loc1.y, 302, "locates #region-east center y=286+16");

  clickedIds.length = 0;
  const c2 = await runPageAct("click", { text: "区域中心城" });
  assert.equal(c2.ok, true);
  assert.equal(c2.match.id, "city-sh");
  assert.deepEqual(clickedIds, ["city-sh"]);

  const listed = runListControls(80);
  assert.ok(listed.some((item) => item.text === "华东区" && item.tag === "li"), "listControls includes menuitemcheckbox");
  assert.ok(!listed.some((item) => item.text === "旧分类一"), "listControls excludes hidden menu");
  doc.getElementById("child-wrap").style.display = "";
}

// 2. selector + text 交集过滤（彻底消除混合隐藏节点 DOM 索引与可见 nth 偏移错位）
{
  clickedIds.length = 0;
  const navClick = await runPageAct("click", { selector: "button.nav-link", text: "分节二" });
  assert.equal(navClick.ok, true);
  assert.equal(navClick.match.id, "nav-1", "selector + text narrows to matching visible button");
  assert.deepEqual(clickedIds, ["nav-1"]);

  clickedIds.length = 0;
  const cascaderClick = await runPageAct("click", {
    selector: ".cascader-popup li.cascader-item",
    text: "华北区",
  });
  assert.equal(cascaderClick.ok, true);
  assert.equal(cascaderClick.match.id, "region-north");
  assert.deepEqual(clickedIds, ["region-north"]);

  const notMatched = await runPageAct("click", {
    selector: "button.nav-link",
    text: "不存在的分节",
  });
  assert.equal(notMatched.ok, false);
  assert.equal(notMatched.notFound, true);
}

// 3. 精确匹配优先 + 顶层弹窗优先（防底层母弹窗同名/前缀按钮抢先命中）
{
  clickedIds.length = 0;
  const nextRes = await runPageAct("click", { text: "下一步" });
  assert.equal(nextRes.ok, true);
  assert.equal(nextRes.match.id, "child-next");
  assert.deepEqual(clickedIds, ["child-next"]);

  clickedIds.length = 0;
  const okRes = await runPageAct("click", { text: "确认" });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.match.id, "child-ok");
  assert.deepEqual(clickedIds, ["child-ok"]);

  clickedIds.length = 0;
  const specRes = await runPageAct("click", { text: "规格甲" });
  assert.equal(specRes.ok, true);
  assert.equal(specRes.match.id, "child-spec");

  clickedIds.length = 0;
  const cancelTop = await runPageAct("click", { text: "取消" });
  assert.equal(cancelTop.ok, true);
  assert.equal(cancelTop.match.id, "child-cancel");
  doc.getElementById("child-wrap").style.display = "none";

  const cancelBottom = await runPageAct("click", { text: "取消" });
  assert.equal(cancelBottom.ok, true);
  assert.equal(cancelBottom.match.id, "parent-cancel");
  assert.deepEqual(clickedIds, ["child-cancel", "parent-cancel"]);
  doc.getElementById("child-wrap").style.display = "";
}

// 4. click-label 在同时传 selector + text 时仍解析出目标控件完整文案，确保不可逆守卫不漏检
{
  const fullText = await resolveClickElementText({
    toolName: "click",
    args: { selector: "button.action-btn", text: "立即" },
    tabId: 1,
    inject: async (_tabId, fn, [arg]) => runLocate(arg),
  });
  assert.equal(fullText, "立即发布");
  const hit = checkHitlRequirement({
    toolName: "click",
    args: { selector: "button.action-btn", text: "立即" },
    elementText: fullText,
    hitlMode: "autonomous",
  });
  assert.match(String(hit?.reason || ""), /不可逆操作.*发布/);
  assert.equal(
    matchIrreversible("click", { selector: "button.action-btn", text: "立即" }, {}, { elementText: fullText })?.id,
    "publish_send",
  );
}

dom.window.close();
console.log("PASS test_aria_menu_and_top_layer_click.mjs");

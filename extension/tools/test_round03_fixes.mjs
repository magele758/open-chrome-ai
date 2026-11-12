import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { locateElement } from "../lib/agent/page-snapshot.js";
import { checkStates, listControls, pageAct } from "../lib/agent/page-fns.js";
import { getCompositeUIAdapterSpec } from "../lib/agent/ui-adapters/index.js";
import { extractCapsule, widenCapsule } from "../lib/agent/trust/capsule.js";
import { matchIrreversible } from "../lib/agent/trust/irreversible.js";
import { createAgentTools, resolveActiveTools } from "../lib/agent/tools.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

// ── 1. ADR-010 & ADR-011: DOM 代理控件定位 + 双字中文按钮空格匹配（校验注入函数 100% 自包含） ──
{
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <!-- 负向边界：type=hidden、disabled、关闭态弹窗内的代理控件绝不能误命中 -->
      <div class="ant-select-selector" data-r="100,20,200,30">
        <input id="hidden-field" type="hidden" value="secret-id" />
        <input id="disabled-proxy" type="search" disabled style="opacity: 0" data-r="100,20,200,30" />
      </div>
      <div class="ant-modal-wrap" style="display: none" data-r="0,0,1200,800">
        <div class="ant-select-selector" data-r="100,320,300,32">
          <input id="closed-modal-input" type="search" style="opacity: 0" data-r="100,320,300,32" />
        </div>
      </div>

      <!-- 打开态编辑商品弹窗：内含 Ant Design Cascader / Select 隐藏代理控件与字间空格按钮 -->
      <div class="ant-modal collection-create-modal" role="dialog" aria-modal="true" data-r="80,60,900,600">
        <div id="modal-title" class="ant-modal-title" data-r="100,70,200,28">编 辑 商 品</div>

        <!-- Ant Design Cascader / Select：内部 input opacity:0 且自身带 role="combobox" -->
        <div id="origin-root" class="ant-select ant-cascader" data-r="100,120,740,32">
          <div id="origin-selector" class="ant-select-selector" data-r="100,120,740,32">
            <span class="ant-select-selection-search" data-r="110,121,720,30">
              <input
                id="origin"
                type="search"
                role="combobox"
                class="ant-select-selection-search-input"
                style="opacity: 0"
                data-r="110,121,720,30"
              />
            </span>
            <span id="origin-placeholder" class="ant-select-selection-placeholder" data-r="110,121,720,30">请选择产地</span>
          </div>
        </div>

        <!-- Ant Design 搜索型类目下拉：用于测试 fill / press 保留真实 input 节点同时滚动可见包裹层 -->
        <div id="cat-root" class="ant-select" data-r="100,180,500,32">
          <div id="cat-selector" class="ant-select-selector" data-r="100,180,500,32">
            <span class="ant-select-selection-search" data-r="108,181,480,30">
              <input
                id="category"
                type="search"
                role="combobox"
                class="ant-select-selection-search-input"
                style="opacity: 0"
                data-r="108,181,480,30"
              />
            </span>
            <span class="ant-select-selection-placeholder" data-r="108,181,480,30">搜索类目</span>
          </div>
        </div>

        <!-- 自定义复选框与 label[for] 代理 -->
        <label id="us-wrap" class="ant-checkbox-wrapper" data-r="100,230,90,24">
          <span class="ant-checkbox" data-r="100,234,16,16">
            <input id="site-us" type="checkbox" style="opacity: 0" data-r="0,0,0,0" />
          </span>
          <span>美 国 站</span>
        </label>
        <input id="for-cb" type="checkbox" style="opacity: 0" data-r="0,0,0,0" />
        <label id="for-cb-label" for="for-cb" data-r="210,230,80,24">包 邮</label>

        <button id="btn-cancel" type="button" data-r="620,580,76,32"><span>取 消</span></button>
        <button id="btn-add" type="button" data-r="710,580,76,32">添 加</button>
        <div id="btn-new" role="button" data-r="800,580,76,32">新 增</div>
        <button id="btn-confirm-alloc" type="button" data-r="500,580,100,32">确 认 分 配</button>
      </div>
    </body></html>`,
    {
      pretendToBeVisual: true,
      runScripts: "outside-only",
      url: "https://10.2.31.12:21006/ai-shop-cross-country/#/ai-tools-kj-cross",
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

  // elementFromPoint 模拟真实浏览器：命中同级占位符 #origin-placeholder（不命中 opacity:0 的 #origin）
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

  // 通过 toString() 在独立页面 realm 求值，强校验注入函数零外部闭包依赖
  const adapterSpec = getCompositeUIAdapterSpec();
  const runLocate = (spec) => ({
    ...win.eval(`(${locateElement.toString()})(${JSON.stringify({ adapterSpec, ...spec })})`),
  });
  const runPageAct = async (kind, spec) => ({
    ...(await win.eval(`(${pageAct.toString()})(${JSON.stringify(kind)}, ${JSON.stringify({ adapterSpec, ...spec })})`)),
  });
  const runListControls = (limit) =>
    JSON.parse(JSON.stringify(win.eval(`(${listControls.toString()})(${JSON.stringify(limit)}, ${JSON.stringify(adapterSpec)})`)));
  const runCheckStates = (spec) =>
    JSON.parse(JSON.stringify(win.eval(`(${checkStates.toString()})(${JSON.stringify(spec)})`)));

  // 1a. locateElement("#origin") 解析到可见包裹层 .ant-select-selector 且通过遮挡检查
  scrolledElements.length = 0;
  const locOrigin = runLocate({ selector: "#origin" });
  assert.equal(locOrigin.ok, true, `expected locateElement(#origin) ok, got ${JSON.stringify(locOrigin)}`);
  assert.equal(locOrigin.tag, "div");
  assert.equal(locOrigin.x, 470);
  assert.equal(locOrigin.y, 136);
  assert.equal(scrolledElements.at(-1)?.id, "origin-selector");

  // 1b. checkbox / label[for] 隐藏代理同样自动解析到可见 label
  const locUs = runLocate({ selector: "#site-us" });
  assert.equal(locUs.ok, true);
  assert.equal(locUs.tag, "label");
  const locForCb = runLocate({ selector: "#for-cb" });
  assert.equal(locForCb.ok, true);
  assert.equal(locForCb.tag, "label");

  // 1c. 负向守卫：hidden / disabled / 关闭弹窗内 input 仍报 notFound
  assert.equal(runLocate({ selector: "#hidden-field" }).notFound, true);
  assert.equal(runLocate({ selector: "#disabled-proxy" }).notFound, true);
  assert.equal(runLocate({ selector: "#closed-modal-input" }).notFound, true);
  assert.equal((await runPageAct("click", { selector: "#hidden-field" })).notFound, true);
  assert.equal((await runPageAct("fill", { selector: "#disabled-proxy", value: "x" })).notFound, true);

  // 1d. pageAct("click" / "probe" / "wait") 对 #origin 作用在可见包裹层 .ant-select-selector
  let originWrapperClicks = 0;
  doc.getElementById("origin-selector").addEventListener("click", () => {
    originWrapperClicks += 1;
  });
  const clickOrigin = await runPageAct("click", { selector: "#origin" });
  assert.equal(clickOrigin.ok, true);
  assert.equal(clickOrigin.match.id, "origin-selector");
  assert.equal(originWrapperClicks, 1);

  const probeOrigin = await runPageAct("probe", { selector: "#origin" });
  assert.equal(probeOrigin.ok, true);
  assert.equal(probeOrigin.match.id, "origin-selector");

  const waitOrigin = await runPageAct("wait", { selector: "#origin", timeoutMs: 300 });
  assert.equal(waitOrigin.ok, true);
  assert.equal(waitOrigin.match.id, "origin-selector");

  // 1e. pageAct("fill" / "press") 滚动可见包裹层 #cat-selector，但保留真实 input#category 写入并派发事件
  const catEvents = [];
  const catInput = doc.getElementById("category");
  catInput.addEventListener("input", () => catEvents.push(`input:${catInput.value}`));
  catInput.addEventListener("change", () => catEvents.push(`change:${catInput.value}`));
  catInput.addEventListener("keydown", (e) => catEvents.push(`keydown:${e.key}`));

  scrolledElements.length = 0;
  const fillCat = await runPageAct("fill", { selector: "#category", value: "套头毛衣" });
  assert.equal(fillCat.ok, true);
  assert.equal(fillCat.match.id, "category");
  assert.equal(catInput.value, "套头毛衣");
  assert.equal(scrolledElements.at(-1)?.id, "cat-selector", "scrolls visible wrapper into view");
  assert.ok(catEvents.includes("input:套头毛衣") && catEvents.includes("change:套头毛衣"));

  const pressCat = await runPageAct("press", { selector: "#category", key: "ArrowDown" });
  assert.equal(pressCat.ok, true);
  assert.ok(catEvents.includes("keydown:ArrowDown"));

  // 2. ADR-011：中文按钮字间空格双向兼容匹配
  let cancelClicks = 0;
  doc.getElementById("btn-cancel").addEventListener("click", () => {
    cancelClicks += 1;
  });
  assert.equal((await runPageAct("click", { text: "取消" })).ok, true, "click '取消' matches '取 消'");
  assert.equal((await runPageAct("click", { text: "取 消" })).ok, true, "click '取 消' still matches '取 消'");
  assert.equal(cancelClicks, 2);

  const locAdd = runLocate({ text: "添加" });
  assert.equal(locAdd.ok, true, "locateElement '添加' matches '添 加'");
  const locNew = runLocate({ text: "新增" });
  assert.equal(locNew.ok, true, "locateElement '新增' matches role=button '新 增'");
  const locAlloc = runLocate({ text: "确认分配" });
  assert.equal(locAlloc.ok, true, "locateElement '确认分配' matches '确 认 分 配'");

  const waitCancel = await runPageAct("wait", { text: "取消", timeoutMs: 300 });
  assert.equal(waitCancel.ok, true);
  const waitModalTitle = await runPageAct("wait", { text: "编辑商品", timeoutMs: 300 });
  assert.equal(waitModalTitle.ok, true);
  assert.equal(waitModalTitle.match.id, "modal-title");

  // listControls：双字中文空格按钮压缩为标准紧凑词，便于搜 "取消" / "添加" / "新增"
  const controls = runListControls(50);
  const texts = controls.map((c) => c.text);
  assert.ok(texts.includes("取消"), `expected '取消' in listControls, got ${JSON.stringify(texts)}`);
  assert.ok(texts.includes("添加"), `expected '添加' in listControls, got ${JSON.stringify(texts)}`);
  assert.ok(texts.includes("新增"), `expected '新增' in listControls, got ${JSON.stringify(texts)}`);

  // checkStates：复选框标签在含空格/不含空格下均能命中（需要先让 checkbox 本身有可见尺寸来测 checkStates）
  doc.getElementById("for-cb").setAttribute("data-r", "190,234,16,16");
  doc.getElementById("for-cb").style.opacity = "1";
  doc.getElementById("for-cb").checked = true;
  const csCompact = runCheckStates({ labels: ["包邮"], exact: true });
  assert.equal(csCompact.results[0].found, true);
  assert.equal(csCompact.results[0].checked, true);
  const csSpaced = runCheckStates({ labels: ["包 邮"], exact: true });
  assert.equal(csSpaced.results[0].found, true);

  // 不可逆按钮防线：Ant Design "发 布" / "删 除" 同样命中不可逆确认清单
  assert.equal(matchIrreversible("trusted_click", { selector: ".btn" }, {}, { elementText: "发 布" })?.id, "publish_send");
  assert.equal(matchIrreversible("click", { selector: ".btn" }, {}, { elementText: "删 除" })?.id, "delete");
}

// ── 3. ADR-012: trust/capsule.js 行内反引号与代码围栏收紧（消除 CSS 选择器误触发 shell） ──
{
  const selectorPrompt = [
    "请留在当前页面（https://192.0.2.10:8080/workspace/#/items）完成表单填写。",
    "绝对禁止点击「发布」「删除」「上传文件」！绝对禁止跳转到 external.example.org！",
    "注意页面容器为 `.modal-shell`（内部为 `.modal-shell__content`，字段为 `#origin`），先点击「编辑」，在 `#origin` 选择选项后点击「取消」。",
  ].join("\n");

  const cap = extractCapsule(selectorPrompt);
  assert.deepEqual([...cap.actions].sort(), ["input", "navigate"]);
  assert.deepEqual(cap.commands, []);
  assert.deepEqual(cap.origins, ["192.0.2.10"]);
  for (const forbidden of ["shell", "publish", "delete", "upload", "send", "write", "close", "automation", "settings"]) {
    assert.ok(!cap.actions.includes(forbidden), `unexpected action ${forbidden} in ${JSON.stringify(cap.actions)}`);
  }

  // 动态工具路由器同样不应因 `.modal-shell` 等 CSS 选择器反引号暴露 run_shell / system_ops
  const allTools = createAgentTools({ getTabId: () => 1, getWindowId: () => 1, cdp: {}, settings: {} });
  const activeNames = resolveActiveTools({ userText: selectorPrompt, tools: allTools }).map((t) => t.name);
  assert.ok(activeNames.includes("click") && activeNames.includes("fill") && activeNames.includes("trusted_click"), "keeps DOM tools");
  assert.ok(!activeNames.includes("run_shell"), `must not expose run_shell, got ${JSON.stringify(activeNames)}`);

  // JSON / CSS 代码围栏与普通说明反引号不触发 shell
  const withJsonAndCss = extractCapsule(
    [
      "请打开 https://erp.example.com 按如下结构核对 `.ant-select-selector` 与 `#category`：",
      "```json",
      '{ "modal": ".ant-modal", "mode": "shell", "cmd": "ls -la" }',
      "```",
      "```css",
      ".ant-modal { opacity: 1; }",
      "```",
    ].join("\n"),
  );
  assert.ok(!withJsonAndCss.actions.includes("shell"), `must not grant shell, got ${JSON.stringify(withJsonAndCss.actions)}`);
  assert.deepEqual(withJsonAndCss.commands, []);

  // 真实 shell 场景 1：$ 前缀行内反引号始终提取
  const dollarTick = extractCapsule("帮我看下 `$ git status -sb` 的输出");
  assert.deepEqual(dollarTick.commands, ["git status -sb"]);
  assert.ok(dollarTick.actions.includes("shell"));

  // 真实 shell 场景 2：执行引导词 + 串联反引号命令提取，但忽略选择器反引号
  const runChain = extractCapsule("先检查 `.ant-modal`，然后执行 `npm run lint` 和 `npm test`");
  assert.deepEqual(runChain.commands, ["npm run lint", "npm test"]);
  assert.ok(runChain.actions.includes("shell"));
  assert.deepEqual(extractCapsule("请执行 `.ant-modal` 元素检查").commands, []);

  // 真实 shell 场景 3：hasShellIntent 为真时提取散落命令反引号，但仍排除选择器/URL/纯中文
  const proseShell = extractCapsule(
    "打开终端执行命令：对照 `.ant-drawer`、`#origin`、`https://example.com`、`编辑商品`，排障时用 `pnpm build`",
  );
  assert.deepEqual(proseShell.commands, ["pnpm build"]);

  // 真实 shell 场景 4：无标签或 shell 标签代码围栏
  const unlabeledFence = extractCapsule("请执行：\n```\npwd\necho ok\n```");
  assert.deepEqual(unlabeledFence.commands, ["pwd", "echo ok"]);

  // widenCapsule 手动补充面板保留裸反引号命令，同时过滤选择器
  const widened = widenCapsule(extractCapsule("打开 example.com"), {
    actions: ["shell"],
    text: "example.org\n`make lint`\n`.ant-modal`\n~/Desktop",
  });
  assert.ok(widened.commands.includes("make lint"));
  assert.ok(!widened.commands.includes(".ant-modal"));
}

console.log("PASS test_round03_fixes.mjs");

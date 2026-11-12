import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { locateElement } from "../lib/agent/page-snapshot.js";
import { checkStates, listControls, pageAct } from "../lib/agent/page-fns.js";
import { ARIA_NATIVE_SPEC } from "../lib/agent/ui-adapters/index.js";
import { extractCapsule, widenCapsule } from "../lib/agent/trust/capsule.js";
import { matchIrreversible } from "../lib/agent/trust/irreversible.js";
import { createAgentTools, resolveActiveTools } from "../lib/agent/tools.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

// ── 1. 中文按钮/标题字间空格双向兼容匹配与不可逆动作确认防线 ──
{
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <dialog id="dlg" open aria-modal="true" data-r="80,60,900,600">
        <h2 id="modal-title" data-r="100,70,200,28">编 辑 工 单</h2>
        <input id="for-cb" type="checkbox" checked data-r="190,234,16,16" />
        <label id="for-cb-label" for="for-cb" data-r="210,230,80,24">免 审</label>
        <button id="btn-cancel" type="button" data-r="620,580,76,32"><span>取 消</span></button>
        <button id="btn-add" type="button" data-r="710,580,76,32">添 加</button>
        <div id="btn-new" role="button" data-r="800,580,76,32">新 增</div>
        <button id="btn-confirm-submit" type="button" data-r="500,580,100,32">确 认 提 交</button>
      </dialog>
    </body></html>`,
    {
      pretendToBeVisual: true,
      runScripts: "outside-only",
      url: "https://portal.example.test/workspace/#/tasks",
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
    win.Element.prototype.scrollIntoView = function () {};
    Object.defineProperty(win.HTMLElement.prototype, "innerText", {
      get() {
        return this.textContent;
      },
    });
    Object.defineProperty(win, "innerWidth", { value: 1280 });
    Object.defineProperty(win, "innerHeight", { value: 800 });

    doc.elementFromPoint = (x, y) => {
      const all = [...doc.querySelectorAll("*")].filter((el) => {
        const r = rectOf(el);
        return r.width > 0 && r.height > 0 && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
      });
      return all.at(-1) || null;
    };

    const adapterSpec = ARIA_NATIVE_SPEC;
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

    let cancelClicks = 0;
    doc.getElementById("btn-cancel").addEventListener("click", () => {
      cancelClicks += 1;
    });
    assert.equal((await runPageAct("click", { text: "取消" })).ok, true, "click '取消' matches '取 消'");
    assert.equal((await runPageAct("click", { text: "取 消" })).ok, true, "click '取 消' still matches '取 消'");
    assert.equal(cancelClicks, 2);

    assert.equal(runLocate({ text: "添加" }).ok, true, "locateElement '添加' matches '添 加'");
    assert.equal(runLocate({ text: "新增" }).ok, true, "locateElement '新增' matches role=button '新 增'");
    assert.equal(runLocate({ text: "确认提交" }).ok, true, "locateElement '确认提交' matches '确 认 提 交'");

    assert.equal((await runPageAct("wait", { text: "取消", timeoutMs: 300 })).ok, true);
    const waitModalTitle = await runPageAct("wait", { text: "编辑工单", timeoutMs: 300 });
    assert.equal(waitModalTitle.ok, true);
    assert.equal(waitModalTitle.match.id, "modal-title");

    const controls = runListControls(50);
    const texts = controls.map((c) => c.text);
    assert.ok(texts.includes("取消"), `expected '取消' in listControls, got ${JSON.stringify(texts)}`);
    assert.ok(texts.includes("添加"), `expected '添加' in listControls, got ${JSON.stringify(texts)}`);
    assert.ok(texts.includes("新增"), `expected '新增' in listControls, got ${JSON.stringify(texts)}`);

    const csCompact = runCheckStates({ labels: ["免审"], exact: true });
    assert.equal(csCompact.results[0].found, true);
    assert.equal(csCompact.results[0].checked, true);
    const csSpaced = runCheckStates({ labels: ["免 审"], exact: true });
    assert.equal(csSpaced.results[0].found, true);

    assert.equal(matchIrreversible("trusted_click", { selector: ".btn" }, {}, { elementText: "发 布" })?.id, "publish_send");
    assert.equal(matchIrreversible("click", { selector: ".btn" }, {}, { elementText: "删 除" })?.id, "delete");
  } finally {
    dom.window.close();
  }
}

// ── 2. trust/capsule.js 行内反引号与代码围栏收紧（消除 CSS 选择器误触发 shell） ──
{
  const selectorPrompt = [
    "请留在当前页面（https://192.0.2.10:8080/workspace/#/items）完成表单填写。",
    "绝对禁止点击「发布」「删除」「上传文件」！绝对禁止跳转到 external.example.org！",
    "注意页面容器为 `.modal-shell`（内部为 `.modal-shell__content`，字段为 `#region`），先点击「编辑」，在 `#region` 选择选项后点击「取消」。",
  ].join("\n");

  const cap = extractCapsule(selectorPrompt);
  assert.deepEqual([...cap.actions].sort(), ["input", "navigate"]);
  assert.deepEqual(cap.commands, []);
  assert.deepEqual(cap.origins, ["192.0.2.10"]);
  for (const forbidden of ["shell", "publish", "delete", "upload", "send", "write", "close", "automation", "settings"]) {
    assert.ok(!cap.actions.includes(forbidden), `unexpected action ${forbidden} in ${JSON.stringify(cap.actions)}`);
  }

  const allTools = createAgentTools({ getTabId: () => 1, getWindowId: () => 1, cdp: {}, settings: {} });
  const activeNames = resolveActiveTools({ userText: selectorPrompt, tools: allTools }).map((t) => t.name);
  assert.ok(activeNames.includes("click") && activeNames.includes("fill") && activeNames.includes("trusted_click"), "keeps DOM tools");
  assert.ok(!activeNames.includes("run_shell"), `must not expose run_shell, got ${JSON.stringify(activeNames)}`);

  const withJsonAndCss = extractCapsule(
    [
      "请打开 https://portal.example.test 按如下结构核对 `.combo-trigger` 与 `#region`：",
      "```json",
      '{ "modal": ".dialog-shell", "mode": "shell", "cmd": "ls -la" }',
      "```",
      "```css",
      ".dialog-shell { opacity: 1; }",
      "```",
    ].join("\n"),
  );
  assert.ok(!withJsonAndCss.actions.includes("shell"), `must not grant shell, got ${JSON.stringify(withJsonAndCss.actions)}`);
  assert.deepEqual(withJsonAndCss.commands, []);

  const dollarTick = extractCapsule("帮我看下 `$ git status -sb` 的输出");
  assert.deepEqual(dollarTick.commands, ["git status -sb"]);
  assert.ok(dollarTick.actions.includes("shell"));

  const runChain = extractCapsule("先检查 `.dialog-shell`，然后执行 `npm run lint` 和 `npm test`");
  assert.deepEqual(runChain.commands, ["npm run lint", "npm test"]);
  assert.ok(runChain.actions.includes("shell"));
  assert.deepEqual(extractCapsule("请执行 `.dialog-shell` 元素检查").commands, []);

  const proseShell = extractCapsule(
    "打开终端执行命令：对照 `.drawer-root`、`#region`、`https://example.com`、`编辑工单`，排障时用 `pnpm build`",
  );
  assert.deepEqual(proseShell.commands, ["pnpm build"]);

  const unlabeledFence = extractCapsule("请执行：\n```\npwd\necho ok\n```");
  assert.deepEqual(unlabeledFence.commands, ["pwd", "echo ok"]);

  const widened = widenCapsule(extractCapsule("打开 example.com"), {
    actions: ["shell"],
    text: "example.org\n`make lint`\n`.dialog-shell`\n~/Desktop",
  });
  assert.ok(widened.commands.includes("make lint"));
  assert.ok(!widened.commands.includes(".dialog-shell"));
}

console.log("PASS test_irreversible_cjk.mjs");

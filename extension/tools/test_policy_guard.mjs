import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  DEFAULT_EXECUTION_POLICY,
  evaluateClickPolicy,
  evaluateUrlPolicy,
  normalizeExecutionPolicy,
  shouldBlockFileChooser,
} from "../lib/agent/policy-guard.js";
import { pageAct, scrollPage } from "../lib/agent/page-fns.js";
import { inspectFileUploadTarget } from "../lib/agent/cdp-tools.js";
import { createAgentTools } from "../lib/agent/tools.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

// 1. ExecutionPolicy 纯函数单测：forbidClickTexts / forbidSelectors / forbidUrlPatterns / fileChooserPolicy
{
  const def = normalizeExecutionPolicy(null);
  assert.equal(def, DEFAULT_EXECUTION_POLICY);
  assert.equal(shouldBlockFileChooser(def), true);
  assert.equal(shouldBlockFileChooser({ fileChooserPolicy: "allow" }), false);

  const policy = normalizeExecutionPolicy({
    forbidClickTexts: ["立即发布", "确认删除"],
    forbidSelectors: [".danger-submit", "#hard-delete"],
    forbidUrlPatterns: ["prod.example.test/publish", "/admin/drop"],
    fileChooserPolicy: "deny",
  });

  // 双字/四字中文按钮带空格也能被紧凑匹配拦截
  const c1 = evaluateClickPolicy({ text: "立 即 发 布" }, policy);
  assert.equal(c1.allowed, false);
  assert.equal(c1.code, "POLICY_FORBIDDEN_CLICK_TEXT");

  const c2 = evaluateClickPolicy({ selector: "button.danger-submit" }, policy);
  assert.equal(c2.allowed, false);
  assert.equal(c2.code, "POLICY_FORBIDDEN_SELECTOR");

  assert.equal(evaluateClickPolicy({ text: "保存草稿", selector: "#btn-draft" }, policy).allowed, true);

  const u1 = evaluateUrlPolicy("https://prod.example.test/publish?id=1", policy);
  assert.equal(u1.allowed, false);
  assert.equal(u1.code, "POLICY_FORBIDDEN_URL");
  assert.equal(evaluateUrlPolicy("https://staging.example.test/items", policy).allowed, true);
}

// 2. fileChooserPolicy: "deny" vs "allow" 双向验证（pageAct + inspectFileUploadTarget）
{
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <label id="file-lbl" role="button" data-r="40,40,140,32">
        <input id="file-inp" type="file" style="display:none" />上传文档
      </label>
    </body></html>`,
    { pretendToBeVisual: true, runScripts: "outside-only", url: "https://portal.example.test/form" },
  );
  try {
    const { window: win } = dom;
    const { document: doc } = win;
    win.Element.prototype.getBoundingClientRect = function () {
      const raw = this.getAttribute?.("data-r");
      if (!raw) return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
      const [x, y, width, height] = raw.split(",").map(Number);
      return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height };
    };
    win.Element.prototype.scrollIntoView = function () {};
    let labelClicks = 0;
    doc.getElementById("file-lbl").addEventListener("click", () => {
      labelClicks += 1;
    });

    // 默认 deny：拦截文件选择框
    const denied = await win.eval(
      `(${pageAct.toString()})("click", ${JSON.stringify({ selector: "#file-lbl", fileChooserPolicy: "deny" })})`,
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.blockedFileChooser, true);
    assert.equal(labelClicks, 0);

    const inspectDeny = win.eval(
      `(${inspectFileUploadTarget.toString()})(${JSON.stringify({ selector: "#file-lbl", fileChooserPolicy: "deny" })})`,
    );
    assert.equal(inspectDeny.blocked, true);

    // 显式 allow：放行文件上传触发器点击
    const allowed = await win.eval(
      `(${pageAct.toString()})("click", ${JSON.stringify({ selector: "#file-lbl", fileChooserPolicy: "allow" })})`,
    );
    assert.equal(allowed.ok, true);
    assert.ok(labelClicks >= 1, "label click permitted when fileChooserPolicy='allow'");

    const inspectAllow = win.eval(
      `(${inspectFileUploadTarget.toString()})(${JSON.stringify({ selector: "#file-lbl", fileChooserPolicy: "allow" })})`,
    );
    assert.equal(inspectAllow.blocked, false);
  } finally {
    dom.window.close();
  }
}

// 3. scrollPage 的 scope: "auto" | "window" | "modal" 三态验证（有弹窗打开时 scope="window" 不劫持整页滚动）
{
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <dialog id="open-dlg" open style="z-index: 1000;">
        <div id="dlg-scroller" style="overflow-y: auto;">弹窗长内容</div>
      </dialog>
    </body></html>`,
    { pretendToBeVisual: true, runScripts: "outside-only", url: "https://portal.example.test/list" },
  );
  try {
    const { window: win } = dom;
    const { document: doc } = win;
    const winScrolls = [];
    win.scrollTo = (opts) => winScrolls.push(opts);
    Object.defineProperty(win, "innerHeight", { value: 600 });
    Object.defineProperty(doc.documentElement, "scrollHeight", { value: 2600, configurable: true });
    win.HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.style?.display === "none" || !this.hasAttribute?.("open") && this.tagName === "DIALOG") {
        return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
      }
      return { width: 700, height: 480, top: 40, left: 80, right: 780, bottom: 520 };
    };
    const scroller = doc.getElementById("dlg-scroller");
    Object.defineProperty(scroller, "scrollHeight", { value: 1800, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
    scroller.scrollTo = function (opts) {
      this.scrollTop = opts.top;
    };

    const evalScroll = (opts) => win.eval(`(${scrollPage.toString()})(${JSON.stringify(opts)})`);

    // auto（默认）：滚打开的弹窗
    const rAuto = evalScroll({ y: 350 });
    assert.equal(rAuto.ok, true);
    assert.equal(rAuto.via, "modal-y");
    assert.equal(scroller.scrollTop, 350);
    assert.equal(winScrolls.length, 0);

    // window：即使弹窗打开，也强制滚整页 window，绝不劫持到弹窗！
    const rWin = evalScroll({ y: 500, scope: "window" });
    assert.equal(rWin.ok, true);
    assert.equal(rWin.via, "y");
    assert.equal(scroller.scrollTop, 350, "modal scrollTop untouched when scope='window'");
    assert.deepEqual({ ...winScrolls[0] }, { top: 500, behavior: "instant" });

    // modal：关闭弹窗后显式报无弹窗容器，不静默滚整页
    doc.getElementById("open-dlg").removeAttribute("open");
    const rModalMissing = evalScroll({ percent: 50, scope: "modal" });
    assert.equal(rModalMissing.ok, false);
    assert.match(rModalMissing.error, /弹窗/);
  } finally {
    dom.window.close();
  }
}

// 4. createAgentTools 集成级策略拦截：click（含 selector 反查文本）与 navigate_tab / open_tab
{
  const prevChrome = globalThis.chrome;
  let clickedInPage = false;
  globalThis.chrome = {
    tabs: {
      get: async (id) => ({ id, windowId: 1, title: "Workspace", url: "https://portal.example.test/edit", active: true }),
      query: async () => [{ id: 1, windowId: 1, title: "Workspace", url: "https://portal.example.test/edit", active: true }],
      create: async (opts) => ({ id: 2, windowId: 1, url: opts.url, active: false }),
      update: async (id, opts) => ({ id, windowId: 1, url: opts.url, active: true }),
      group: async () => 11,
    },
    tabGroups: { update: async () => ({}) },
    permissions: { contains: async () => true },
    scripting: {
      executeScript: async ({ func, args = [] }) => {
        if (func.name === "pageAct" && args[0] === "probe") {
          return [{ result: { ok: true, count: 1, match: { tag: "button", id: "pub", text: "立即发布" } } }];
        }
        if (func.name === "pageAct" && args[0] === "click") {
          clickedInPage = true;
          return [{ result: { ok: true, action: "click" } }];
        }
        return [{ result: null }];
      },
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: { id: "test" },
  };
  try {
    const tools = createAgentTools({
      getTabId: () => 1,
      policy: {
        forbidClickTexts: ["立即发布"],
        forbidSelectors: ["#danger-zone"],
        forbidUrlPatterns: ["forbidden.example.test"],
      },
    });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    // selector 未传 text，但 probe 实读出按钮文字为「立即发布」 -> 必须在点击前拦截！
    const resProbeBlock = JSON.parse(await byName.click.execute({ selector: "#pub" }));
    assert.equal(resProbeBlock.ok, false);
    assert.equal(resProbeBlock.blockedByPolicy, true);
    assert.equal(clickedInPage, false, "must never click forbidden button even via selector");

    const resSelBlock = JSON.parse(await byName.click.execute({ selector: "#danger-zone button" }));
    assert.equal(resSelBlock.ok, false);
    assert.equal(resSelBlock.code, "POLICY_FORBIDDEN_SELECTOR");

    const resNavBlock = JSON.parse(await byName.navigate_tab.execute({ url: "https://forbidden.example.test/p" }));
    assert.equal(resNavBlock.ok, false);
    assert.equal(resNavBlock.code, "POLICY_FORBIDDEN_URL");
  } finally {
    globalThis.chrome = prevChrome;
  }
}

console.log("test_policy_guard: PASS");

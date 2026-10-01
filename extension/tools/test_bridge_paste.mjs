import assert from "node:assert/strict";
import { createBridge } from "../lib/bridge/index.js";
import { ERROR_CODES } from "../lib/bridge/protocol.js";
import { plEditor, plReadRenderedHtml, plSelectContents } from "../lib/bridge/editor-fns.js";

const TABS = new Map([
  [1, { id: 1, title: "Doocs", url: "http://localhost:8080/" }],
  [2, { id: 2, title: "WeChat", url: "https://mp.weixin.qq.com/cgi-bin/appmsg" }],
  [3, { id: 3, title: "Bank", url: "https://bank.example/" }],
]);

const SOURCE_HTML = `<section><h2>日报</h2><p>${"这是一段很长的正文。".repeat(30)}</p><table><tr><td>1</td></tr></table><img src="http://x/a.png"><img src="http://x/b.png"></section>`;

/** 模拟编辑页：粘贴是否生效、标题是否被污染都可配置。 */
function makePage() {
  const page = {
    chars: 0,
    tables: 0,
    imgs: 0,
    title: "每日 LLM 简报",
    clipboardHtml: "",
    pasteWorks: () => true,
    pastePollutesTitle: false,
    editorMissing: false,
    selectedAll: false,
    pastes: 0,
    funcs: [],
    focusEmulated: false,
  };
  const stats = (html) => ({
    chars: html.replace(/<[^>]+>/g, "").replace(/\s+/g, "").length,
    tables: (html.match(/<table[\s>]/gi) || []).length,
    imgs: (html.match(/<img[\s>]/gi) || []).length,
  });
  page.onKey = (event) => {
    if (event.type !== "rawKeyDown") return;
    if (event.commands?.includes("selectAll")) page.selectedAll = true;
    if (event.key === "Backspace" && page.selectedAll) {
      Object.assign(page, { chars: 0, tables: 0, imgs: 0 });
      page.selectedAll = false;
    }
    if (event.commands?.includes("paste")) {
      page.pastes += 1;
      if (!page.pasteWorks(page.pastes)) return;
      if (page.pastePollutesTitle) {
        page.title = page.clipboardHtml.replace(/<[^>]+>/g, "");
        return;
      }
      const s = stats(page.clipboardHtml);
      if (page.selectedAll) Object.assign(page, s);
      else {
        page.chars += s.chars;
        page.tables += s.tables;
        page.imgs += s.imgs;
      }
      page.selectedAll = false;
    }
  };
  page.inject = async (_tabId, func, args) => {
    page.funcs.push(func.name);
    if (func === plReadRenderedHtml) return { ok: true, html: SOURCE_HTML, stats: stats(SOURCE_HTML) };
    if (func !== plEditor) throw new Error(`unexpected page function ${func.name}`);
    const [op, spec] = args;
    if (page.editorMissing) return { ok: false, code: "NO_EDITOR", error: "没有找到可用的富文本编辑器" };
    const editor = { tag: "DIV", className: "ProseMirror", domIndex: 2, score: 130, rect: { x: 10, y: 120, w: 600, h: 500 }, candidates: [{}] };
    if (op === "pick") return { ok: true, ...editor };
    if (op === "prepare") return { ok: true, point: { x: 100, y: 150 }, focused: true, ...editor };
    const checks = [];
    const exp = spec.expect || {};
    const add = (name, ok, expected, actual) => checks.push({ name, ok, expected, actual });
    if (exp.minChars != null) add("minChars", page.chars >= exp.minChars, exp.minChars, page.chars);
    if (exp.minTables != null) add("minTables", page.tables >= exp.minTables, exp.minTables, page.tables);
    if (exp.minImages != null) add("minImages", page.imgs >= exp.minImages, exp.minImages, page.imgs);
    const polluted = page.title.length > 64;
    add("titleNotPolluted", !polluted, "<=64", page.title.slice(0, 20));
    if (spec.titleBefore != null) add("titleUnchanged", page.title === spec.titleBefore, spec.titleBefore, page.title);
    return {
      ok: checks.every((c) => c.ok),
      stats: { chars: page.chars, tables: page.tables, imgs: page.imgs },
      title: page.title,
      titlePolluted: polluted,
      checks,
      ...(spec.includeHtml ? { html: "<p>after</p>" } : {}),
    };
  };
  return page;
}

function makeEnv(page, { platform = "mac" } = {}) {
  const cdpLog = [];
  const tabUpdates = [];
  const clipboardWrites = [];
  const env = {
    getSettings: async () => ({
      agentBridgeEnabled: true,
      agentBridgeOrigins: ["http://localhost:*", "https://mp.weixin.qq.com"],
    }),
    tabs: {
      get: async (id) => {
        if (!TABS.has(id)) throw new Error(`No tab with id: ${id}`);
        return TABS.get(id);
      },
      query: async () => [...TABS.values()],
      create: async () => ({ id: 9 }),
      update: async (id, props) => {
        tabUpdates.push({ id, props });
        return {};
      },
    },
    inject: (...a) => page.inject(...a),
    runJs: async () => {
      throw new Error("run_js must not be used by the paste flow");
    },
    cdp: {
      send: async (tabId, method, params) => {
        cdpLog.push({ tabId, method, params });
        if (page.cdpBusy) {
          const err = new Error("该标签已被 DevTools 或其他调试器占用，请先关闭它的开发者工具。");
          err.code = "DEBUGGER_BUSY";
          throw err;
        }
        if (method === "Input.dispatchKeyEvent") page.onKey(params);
        if (method === "Emulation.setFocusEmulationEnabled") page.focusEmulated = true;
        return {};
      },
      ensure: async () => ({}),
    },
    clipboard: {
      write: async ({ html, text }) => {
        clipboardWrites.push({ html, text });
        page.clipboardHtml = html;
        return { via: "mock-copy" };
      },
    },
    platform: () => platform,
    sleep: async () => {},
    now: () => Date.now(),
    extensionVersion: () => "test",
  };
  return { env, cdpLog, tabUpdates, clipboardWrites };
}

let n = 0;
const call = (bridge, tool, args, extra) =>
  bridge.call({ id: `p${++n}`, tool, args: tool === "paste_rich_trusted" ? { settleMs: 20, ...args } : args, ...extra });
const keyCommands = (log) => log.filter((e) => e.method === "Input.dispatchKeyEvent" && e.params.type === "rawKeyDown").map((e) => [e.params.modifiers, e.params.commands?.[0]]);

// ---- 1. 一次成功：顺序、可信键、不抢焦点 ----
{
  const page = makePage();
  const { env, cdpLog, tabUpdates, clipboardWrites } = makeEnv(page);
  const bridge = createBridge(env);
  const res = await call(bridge, "paste_rich_trusted", { tabId: 2, html: SOURCE_HTML, titleEquals: "每日 LLM 简报" });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(res.result.method, "trusted_paste");
  assert.equal(res.result.attempts.length, 1);
  assert.equal(res.result.verify.ok, true);
  assert.equal(res.result.focus, "emulated");
  assert.equal(tabUpdates.length, 0, "default path never activates (steals focus from) the tab");
  assert.equal(clipboardWrites.length, 1);
  assert.ok(clipboardWrites[0].text.includes("这是一段很长的正文"), "plain-text alternative derived");

  const methods = cdpLog.map((e) => e.method);
  assert.equal(methods[0], "Emulation.setFocusEmulationEnabled");
  const clickIdx = methods.indexOf("Input.dispatchMouseEvent");
  const keyIdx = methods.indexOf("Input.dispatchKeyEvent");
  assert.ok(clickIdx > 0 && keyIdx > clickIdx, "click focuses the editor before keys");
  assert.deepEqual(keyCommands(cdpLog), [[4, "selectAll"], [0, undefined], [4, "paste"]], "Meta+A, Backspace, Meta+V with native commands");
  assert.deepEqual(page.funcs.filter((f) => f !== "plEditor"), [], "only editor probes touch the page — no innerHTML/execCommand/DataTransfer");
}

// ---- 2. Linux 用 Control ----
{
  const page = makePage();
  const { env, cdpLog } = makeEnv(page, { platform: "linux" });
  const res = await call(createBridge(env), "paste_rich_trusted", { tabId: 2, html: SOURCE_HTML });
  assert.equal(res.ok, true);
  assert.deepEqual(keyCommands(cdpLog), [[2, "selectAll"], [0, undefined], [2, "paste"]]);
}

// ---- 3. 第一次粘贴无效 → 重试后成功（剪贴板每次重写） ----
{
  const page = makePage();
  page.pasteWorks = (count) => count >= 2;
  const { env, clipboardWrites } = makeEnv(page);
  const res = await call(createBridge(env), "paste_rich_trusted", { tabId: 2, html: SOURCE_HTML });
  assert.equal(res.ok, true);
  assert.equal(res.result.attempts.length, 2);
  assert.equal(res.result.attempts[0].ok, false);
  assert.ok(res.result.attempts[0].failed.length > 0);
  assert.equal(clipboardWrites.length, 2);
}

// ---- 4. 一直失败 → 到上限停止，返回 VERIFY_FAILED，不兜底 ----
{
  const page = makePage();
  page.pasteWorks = () => false;
  const { env, cdpLog } = makeEnv(page);
  const bridge = createBridge(env);
  let res = await call(bridge, "paste_rich_trusted", { tabId: 2, html: SOURCE_HTML });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, ERROR_CODES.VERIFY_FAILED);
  assert.equal(res.error.retryable, false);
  assert.equal(res.error.details.attempts.length, 3, "default: 1 + 2 retries");
  assert.equal(page.pastes, 3);
  assert.deepEqual(page.funcs.filter((f) => f !== "plEditor"), []);
  assert.ok(res.error.hint.includes("innerHTML"));

  page.pastes = 0;
  res = await call(bridge, "paste_rich_trusted", { tabId: 2, html: SOURCE_HTML, retries: 0 });
  assert.equal(res.error.details.attempts.length, 1);
  page.pastes = 0;
  res = await call(bridge, "paste_rich_trusted", { tabId: 2, html: SOURCE_HTML, retries: 99 });
  assert.equal(res.error.details.attempts.length, 4, "retries capped at 3");
  assert.ok(cdpLog.length > 0);
}

// ---- 4b. 旧内容不会让被吞掉的粘贴假通过（粘贴前先全选删除） ----
{
  const page = makePage();
  Object.assign(page, { chars: 5000, tables: 1, imgs: 2 });
  page.pasteWorks = () => false;
  const { env } = makeEnv(page);
  const res = await call(createBridge(env), "paste_rich_trusted", { tabId: 2, html: SOURCE_HTML, retries: 0 });
  assert.equal(res.error.code, ERROR_CODES.VERIFY_FAILED, "stale editor content must not satisfy verification");
}

// ---- 5. 标题被污染 → 失败 ----
{
  const page = makePage();
  page.pastePollutesTitle = true;
  const { env } = makeEnv(page);
  const res = await call(createBridge(env), "paste_rich_trusted", { tabId: 2, html: SOURCE_HTML, retries: 1 });
  assert.equal(res.error.code, ERROR_CODES.VERIFY_FAILED);
  const failed = res.error.details.attempts[0].failed.map((c) => c.name);
  assert.ok(failed.includes("titleNotPolluted") || failed.includes("titleUnchanged"));
}

// ---- 6. 缺 table/img → 默认由来源推导断言，失败 ----
{
  const page = makePage();
  const orig = page.onKey;
  page.onKey = (event) => {
    orig(event);
    if (event.commands?.includes("paste")) {
      page.tables = 0;
      page.imgs = 0;
    }
  };
  const { env } = makeEnv(page);
  const res = await call(createBridge(env), "paste_rich_trusted", { tabId: 2, html: SOURCE_HTML, retries: 0 });
  assert.equal(res.error.code, ERROR_CODES.VERIFY_FAILED);
  const failed = res.error.details.attempts[0].failed.map((c) => c.name).sort();
  assert.deepEqual(failed, ["minImages", "minTables"]);
  const relaxed = await call(createBridge(makeEnv(page).env), "paste_rich_trusted", { tabId: 2, html: SOURCE_HTML, retries: 0, expect: { minTables: 0, minImages: 0 } });
  assert.equal(relaxed.ok, true, "explicit expect overrides derived");
}

// ---- 7. 编辑器找不到 ----
{
  const page = makePage();
  page.editorMissing = true;
  const { env } = makeEnv(page);
  const res = await call(createBridge(env), "paste_rich_trusted", { tabId: 2, html: SOURCE_HTML });
  assert.equal(res.error.code, ERROR_CODES.NO_EDITOR);
  assert.equal(page.pastes, 0);
}

// ---- 8. 调试器被占用：重试一次后结构化报错 ----
{
  const page = makePage();
  page.cdpBusy = true;
  const { env, cdpLog } = makeEnv(page);
  const res = await call(createBridge(env), "paste_rich_trusted", { tabId: 2, html: SOURCE_HTML, retries: 0 });
  assert.equal(res.error.code, ERROR_CODES.DEBUGGER_BUSY);
  assert.equal(res.error.retryable, true);
  assert.equal(cdpLog.filter((e) => e.method === "Emulation.setFocusEmulationEnabled").length, 2, "one retry after 'already attached'");
}

// ---- 9. 来源页读取、授权、activate、includeHtml ----
{
  const page = makePage();
  const { env, tabUpdates } = makeEnv(page);
  const bridge = createBridge(env);
  let res = await call(bridge, "paste_rich_trusted", { tabId: 2, source: { tabId: 1, selector: "#output" }, activate: true, includeHtml: true });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.deepEqual(res.result.source.selector, "#output");
  assert.equal(res.result.focus, "activated");
  assert.ok(tabUpdates.some((u) => u.id === 2 && u.props.active === true), "activate:true is explicit opt-in");
  assert.equal(res.artifacts[0].name, "editor.html");

  res = await call(bridge, "paste_rich_trusted", { tabId: 2, source: { tabId: 3, selector: "#output" } });
  assert.equal(res.error.code, ERROR_CODES.ORIGIN_NOT_ALLOWED, "source tab is authorised too");

  res = await call(bridge, "paste_rich_trusted", { tabId: 2 });
  assert.equal(res.error.code, ERROR_CODES.BAD_ARGS);
  res = await call(bridge, "paste_rich_trusted", { tabId: 3, html: "<p>x</p>" });
  assert.equal(res.error.code, ERROR_CODES.ORIGIN_NOT_ALLOWED);
}

// ---- 10. useClipboard：不写剪贴板，沿用现有内容 ----
{
  const page = makePage();
  page.clipboardHtml = SOURCE_HTML;
  const { env, clipboardWrites } = makeEnv(page);
  const res = await call(createBridge(env), "paste_rich_trusted", { tabId: 2, useClipboard: true, expect: { minChars: 100 } });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(clipboardWrites.length, 0);
}

// ---- 11. copy_selection_trusted ----
{
  const page = makePage();
  const orig = page.inject;
  page.inject = async (tabId, func, args) => {
    if (func === plSelectContents) return { ok: true, chars: 300, tables: 1, imgs: 2 };
    return orig(tabId, func, args);
  };
  const { env, cdpLog } = makeEnv(page);
  const res = await call(createBridge(env), "copy_selection_trusted", { tabId: 1, selector: "#output" });
  assert.equal(res.ok, true);
  assert.deepEqual(keyCommands(cdpLog), [[4, "copy"]]);
  assert.equal(res.result.selected.tables, 1);
}

// ---- 12. 包装的可信输入工具：坐标点击 / 真实按键，焦点模拟 ----
{
  const page = makePage();
  const { env, cdpLog, tabUpdates } = makeEnv(page);
  const bridge = createBridge(env);
  let res = await call(bridge, "trusted_click", { tabId: 2, x: 40, y: 50 });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.deepEqual(cdpLog.filter((e) => e.method === "Input.dispatchMouseEvent").map((e) => e.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.ok(cdpLog.some((e) => e.method === "Emulation.setFocusEmulationEnabled"));
  assert.equal(tabUpdates.length, 0);

  res = await call(bridge, "press_keys", { tabId: 2, keys: ["Meta+V"] });
  assert.equal(res.ok, true);
  assert.equal(page.pastes, 1);
  res = await call(bridge, "press_keys", { tabId: 2, keys: ["Hyper+V"] });
  assert.equal(res.ok, false);
  res = await call(bridge, "trusted_click", { tabId: 2 });
  assert.equal(res.error.code, ERROR_CODES.BAD_ARGS, "missing target is a BAD_ARGS, not a crash");
  res = await call(bridge, "trusted_click", { tabId: 2, x: 1, y: 1, activate: true });
  assert.ok(tabUpdates.some((u) => u.props.active), "activate flag respected");
}

console.log("bridge paste tests passed");

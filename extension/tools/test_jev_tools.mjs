import assert from "node:assert/strict";
import { createAgentTools } from "../lib/agent/tools.js";
import { runJsInTab } from "../lib/chrome.js";
import { runJs } from "../lib/agent/page-fns.js";
import { askJev, isJevActive } from "../lib/jev.js";
import {
  buildJevRequest,
  formatSnapshot,
  interpretJevAnswers,
  mergeFrameSnapshots,
} from "../lib/jev-actions.js";

const item = (over) => ({ node: 1, role: "button", label: "x", kind: "click", rect: { x: 0, y: 0, w: 10, h: 10 }, ...over });
const top = {
  url: "https://a.example/",
  title: "A",
  w: 1000,
  h: 700,
  scroll: { y: 0, height: 2000 },
  text: "顶层文字",
  omitted: 0,
  items: [
    item({ node: 1, role: "textbox", label: "出发地", kind: "fill", value: "" }),
    item({ node: 2, label: "搜索" }),
    item({ node: 3, role: "combobox", label: "舱位", kind: "select", value: "经济舱", options: [{ value: "e", label: "经济舱" }, { value: "b", label: "商务舱" }] }),
  ],
};
const frame = { url: "https://pay.example/", title: "pay", w: 400, h: 300, scroll: { y: 0, height: 300 }, text: "卡号", items: [item({ node: 1, label: "支付", role: "button" })], omitted: 0 };
const tiny = { ...frame, w: 1, h: 1 };
const merged = mergeFrameSnapshots([
  { frameId: 0, result: top },
  { frameId: 7, result: frame },
  { frameId: 9, result: tiny },
]);
assert.equal(merged.items.length, 4);
assert.deepEqual(merged.items.map((i) => i.index), [1, 2, 3, 4]);
assert.equal(merged.items[3].frameId, 7, "iframe control keeps its frame id");
assert.match(merged.text, /\[iframe 7\] 卡号/);
assert.equal(merged.subframes, 1, "1x1 tracker frames are ignored");
assert.match(formatSnapshot(merged), /\[4\] button\s+支付 · iframe 7/);
assert.equal(mergeFrameSnapshots([]), null);

const req = buildJevRequest(merged, "订机票", [{ action: "click", text: "x" }]);
assert.deepEqual(Object.keys(req.questions).sort(), ["click_target", "operation", "select_target", "type_text_target"]);
assert.ok("SCROLL_DOWN" in req.questions.operation.criteria);
assert.ok(!("SCROLL_UP" in req.questions.operation.criteria), "already at top");
assert.deepEqual(Object.keys(req.questions.select_target.criteria), ["3:1", "3:2"]);
assert.ok("1" in req.questions.click_target.criteria, "editable fields can also be clicked");

const uniform = (ids, choice, confidence = 0.9) => {
  const probabilities = Object.fromEntries(
    ids.map((id) => [id, ids.length === 1 ? 1 : id === choice ? 0.7 : 0.3 / (ids.length - 1)]),
  );
  return { choice, probabilities, confidence };
};
const opIds = Object.keys(req.questions.operation.criteria);
const clickIds = Object.keys(req.questions.click_target.criteria);
const decision = interpretJevAnswers(
  { operation: uniform(opIds, "CLICK"), click_target: uniform(clickIds, "2", 0.8) },
  req.space,
);
assert.equal(decision.operation, "CLICK");
assert.equal(decision.item.label, "搜索");
assert.equal(decision.alternatives[0].target, "2");
assert.equal(decision.targetConfidence, 0.8);

const selectDecision = interpretJevAnswers(
  { operation: uniform(opIds, "SELECT"), select_target: uniform(["3:1", "3:2"], "3:2") },
  req.space,
);
assert.equal(selectDecision.option.value, "b");
assert.equal(interpretJevAnswers({ operation: uniform(opIds, "DONE") }, req.space).operation, "DONE");
assert.throws(
  () => interpretJevAnswers({ operation: { choice: "CLICK", probabilities: { CLICK: 0.2 }, confidence: 0.9 } }, req.space),
  /不合法/,
  "malformed choice must never execute",
);
assert.throws(
  () => interpretJevAnswers({ operation: uniform(opIds, "CLICK"), click_target: uniform(["99"], "99") }, req.space),
  /不合法/,
  "target outside the offered set is rejected",
);

const jev = { enabled: true, apiKey: "k", model: "jev-latest", baseUrl: "https://jev.example/v1" };
assert.equal(isJevActive({ jev }), true);
assert.equal(isJevActive({ jev: { ...jev, enabled: false } }), false);
assert.equal(isJevActive({ jev: { ...jev, apiKey: "" } }), false);
assert.equal(isJevActive({}), false);

let attempts = 0;
const answers = await askJev(
  jev,
  { state: {}, questions: {} },
  {
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ answers: { ready: { noul: 1 } } }) };
    },
  },
);
assert.equal(attempts, 2, "503 is retried");
assert.equal(answers.ready.noul, 1);
await assert.rejects(
  askJev(jev, { state: {}, questions: {} }, { fetchImpl: async () => ({ ok: false, status: 401, text: async () => "sk-secret" }) }),
  (err) => /401/.test(err.message) && !/sk-secret/.test(err.message),
);

// ---- 工具接线 ----
const calls = [];
let scriptHandler = () => [{ result: null }];
globalThis.chrome = {
  tabs: { get: async (id) => ({ id, url: "https://a.example/", windowId: 1 }) },
  scripting: {
    executeScript: async (opts) => {
      calls.push({ name: opts.func.name, target: opts.target, world: opts.world, args: opts.args });
      return scriptHandler(opts);
    },
  },
};

const ctx = { getTabId: () => 5, settings: { jev } };
const tools = createAgentTools(ctx);
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
for (const n of ["snapshot_controls", "act_element", "jev_next_action"]) assert.ok(byName[n], n);
const plain = createAgentTools({ getTabId: () => 5, settings: { jev: { ...jev, enabled: false } } });
assert.ok(!plain.some((t) => t.name === "snapshot_controls"), "Jev tools stay hidden until Jev is configured");
assert.ok(plain.some((t) => t.name === "click"));

scriptHandler = (opts) =>
  opts.func.name === "snapshotControls"
    ? [
        { frameId: 0, result: top },
        { frameId: 7, result: frame },
      ]
    : [{ result: { ok: true, action: "click" } }];
const table = await byName.snapshot_controls.execute({});
assert.match(table, /\[2\] button\s+搜索/);
assert.match(table, /iframe 7/);

calls.length = 0;
const clicked = JSON.parse(await byName.act_element.execute({ index: 4, action: "click" }));
assert.equal(clicked.ok, true);
assert.deepEqual(calls[0].target.frameIds, [7], "action is routed to the owning iframe");
assert.equal(calls[0].args[1].label, "支付");

assert.match(await byName.act_element.execute({ index: 99, action: "click" }), /没有编号 99/);
assert.match(await byName.act_element.execute({ index: 2, action: "fill", value: "x" }), /不是可输入控件/);
assert.match(await byName.act_element.execute({ index: 1, action: "fill" }), /需要 value/);

// jev_next_action：只选目标，TYPE_TEXT 需要调用方给 value
const opAnswer = (choice, confidence = 0.9) => ({ operation: uniform(opIds, choice, confidence) });
let jevReply = { ...opAnswer("CLICK"), click_target: uniform(clickIds, "2") };
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  assert.equal(body.model, "jev-latest");
  assert.ok(body.questions.operation && body.state.elements.length === 4);
  return { ok: true, status: 200, json: async () => ({ answers: jevReply }) };
};
scriptHandler = (opts) =>
  opts.func.name === "snapshotControls"
    ? [{ frameId: 0, result: top }, { frameId: 7, result: frame }]
    : [{ result: { ok: true, action: "click" } }];
const advice = JSON.parse(await byName.jev_next_action.execute({ goal: "搜索航班" }));
assert.equal(advice.executed, false);
assert.equal(advice.label, "搜索");

calls.length = 0;
const done = JSON.parse(await byName.jev_next_action.execute({ goal: "搜索航班", execute: true }));
assert.equal(done.executed, true);
assert.ok(calls.some((c) => c.name === "actOnRef" && c.args[1].node === 2));
assert.match(done.page, /可操作控件/, "executed step returns a fresh snapshot");

jevReply = { ...opAnswer("TYPE_TEXT"), type_text_target: uniform(["1"], "1") };
const needs = JSON.parse(await byName.jev_next_action.execute({ goal: "填出发地", execute: true }));
assert.equal(needs.executed, false);
assert.match(needs.needsValue, /value/);

jevReply = { ...opAnswer("CLICK", 0.3), click_target: uniform(clickIds, "2", 0.3) };
const unsure = JSON.parse(await byName.jev_next_action.execute({ goal: "搜索", execute: true }));
assert.equal(unsure.executed, false);
assert.match(unsure.note, /置信度/);

jevReply = opAnswer("DONE");
assert.match(JSON.parse(await byName.jev_next_action.execute({ goal: "x", execute: true })).note, /仅供参考/);

// ---- 跨 frame 兜底：顶层找不到 -> 探测所有 frame -> 只在命中的 frame 里执行 ----
calls.length = 0;
scriptHandler = (opts) => {
  const [kind] = opts.args;
  if (kind === "probe") return [{ frameId: 0, result: { ok: false, notFound: true } }, { frameId: 7, result: { ok: true, count: 1 } }];
  if (opts.target.frameIds?.[0] === 7) return [{ frameId: 7, result: { ok: true, action: "click" } }];
  return [{ frameId: 0, result: { ok: false, error: "没有可见元素", notFound: true } }];
};
const crossFrame = JSON.parse(await byName.click.execute({ selector: "#pay" }));
assert.equal(crossFrame.ok, true);
assert.equal(crossFrame.frameId, 7);
const clickCalls = calls.filter((c) => c.args[0] === "click");
assert.equal(clickCalls.length, 2, "click runs once at top (miss) and once in the matched frame only");
assert.ok(calls.some((c) => c.args[0] === "probe" && c.target.allFrames));

scriptHandler = () => [{ frameId: 0, result: { ok: false, error: "没有可见元素", notFound: true } }];
const nowhere = JSON.parse(await byName.click.execute({ selector: "#nope" }));
assert.equal(nowhere.ok, false, "still reports not found when no frame matches");

// ---- run_js：CSP 拦截后依次退到 MAIN、userScripts ----
const csp = { ok: false, cspBlocked: true, error: "Refused to evaluate a string as JavaScript because 'unsafe-eval'" };
const worlds = [];
scriptHandler = (opts) => {
  worlds.push(opts.world || "ISOLATED");
  return [{ result: csp }];
};
delete globalThis.chrome.userScripts;
const noUserScripts = await runJsInTab(5, runJs, "return 1");
assert.equal(noUserScripts.ok, false);
assert.equal(noUserScripts.cspBlocked, true);
assert.match(noUserScripts.error, /允许用户脚本/, "error tells the model/user how to recover");
assert.deepEqual(worlds, ["ISOLATED", "MAIN"]);

let injected;
globalThis.chrome.userScripts = {
  execute: async (opts) => {
    injected = opts;
    return [{ result: { ok: true, result: 2, via: "userScripts" } }];
  },
};
const viaUserScripts = await runJsInTab(5, runJs, "1+1");
assert.equal(viaUserScripts.result, 2);
assert.equal(injected.world, "USER_SCRIPT");
assert.match(injected.js[0].code, /return \(1\+1\)/);
assert.doesNotMatch(injected.js[0].code, /new Function|eval\(|AsyncFunction/, "user script path must not need eval");

scriptHandler = () => [{ result: { ok: true, result: 3 } }];
assert.equal((await runJsInTab(5, runJs, "3")).result, 3, "no fallback when eval works");

console.log("test_jev_tools ok");

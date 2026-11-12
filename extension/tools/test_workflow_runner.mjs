import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import { extractCapsule } from "../lib/agent/trust/capsule.js";
import { runJs } from "../lib/agent/page-fns.js";
import {
  WORKFLOW_MODEL_ID,
  applyBindTransforms,
  buildAssertStateBatches,
  detectExternalBlocker,
  evaluateDataTransform,
  evaluateWhenPredicate,
  formatWorkflowSummary,
  interpolateParams,
  isWorkflowDirectiveText,
  parseWorkflowDirective,
  runDeterministicWorkflow,
} from "../lib/agent/workflow-runner.js";
import { buildRunRecord } from "../lib/run-recorder.js";
import { extractBuiltinDirective, parseSlashToken, userInvokedSkill } from "../lib/slash.js";

const FAKE_SHOT_DATA_URL =
  "data:image/png;base64," + "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ".repeat(40);

function createJsdomHarness(html, url = "https://portal.example.org/workspace/#/records?tab=open") {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  const { window } = dom;
  const origDoc = globalThis.document;
  const origWin = globalThis.window;
  const origLoc = globalThis.location;
  const origCSS = globalThis.CSS;
  const origGetCS = globalThis.getComputedStyle;
  const origEvent = globalThis.Event;

  function installGlobals() {
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.location = window.location;
    globalThis.Event = window.Event;
    globalThis.getComputedStyle = window.getComputedStyle.bind(window);
    globalThis.CSS = window.CSS || { escape: (s) => String(s).replace(/([^\w-])/g, "\\$1") };
  }

  function restoreGlobals() {
    globalThis.document = origDoc;
    globalThis.window = origWin;
    globalThis.location = origLoc;
    globalThis.CSS = origCSS;
    globalThis.getComputedStyle = origGetCS;
    globalThis.Event = origEvent;
  }

  // Patch getBoundingClientRect in JSDOM so visible elements have non-zero geometry
  const origGBR = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function patchedGBR() {
    if (this.hidden || this.getAttribute("aria-hidden") === "true") {
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    for (let p = this; p && p.nodeType === 1; p = p.parentElement) {
      const st = window.getComputedStyle(p);
      if (st.display === "none" || st.visibility === "hidden") {
        return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
      }
    }
    return { x: 10, y: 10, top: 10, left: 10, right: 130, bottom: 42, width: 120, height: 32 };
  };

  let lastShot = null;
  const rawTools = [
    {
      name: "run_js",
      async execute({ code }) {
        installGlobals();
        try {
          return JSON.stringify(await runJs(code));
        } finally {
          restoreGlobals();
        }
      },
    },
    {
      name: "click",
      async execute({ selector, text }) {
        installGlobals();
        try {
          const cands = selector
            ? [...window.document.querySelectorAll(selector)]
            : [...window.document.querySelectorAll("button, a, label, [role='button'], [role='option'], [role='menuitemcheckbox'], li")];
          const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
          const hit = text
            ? cands.find((el) => norm(el.innerText || el.textContent || el.getAttribute("aria-label")) === norm(text))
            : cands[0];
          if (!hit) return JSON.stringify({ ok: false, error: `element not found: ${selector || text}` });
          if (hit.matches?.('input[type="file"]') || hit.querySelector?.('input[type="file"]')) {
            return JSON.stringify({ ok: false, blockedFileChooser: true, error: "拦截文件上传控件" });
          }
          hit.click();
          return JSON.stringify({ ok: true, clicked: norm(hit.innerText || hit.textContent || selector) });
        } finally {
          restoreGlobals();
        }
      },
    },
    {
      name: "fill",
      async execute({ selector, value }) {
        installGlobals();
        try {
          const el = window.document.querySelector(selector);
          if (!el) return JSON.stringify({ ok: false, error: `input not found: ${selector}` });
          el.value = String(value ?? "");
          el.dispatchEvent(new window.Event("input", { bubbles: true }));
          return JSON.stringify({ ok: true, value: el.value });
        } finally {
          restoreGlobals();
        }
      },
    },
    {
      name: "select_option",
      async execute({ selector, value }) {
        installGlobals();
        try {
          const root = window.document.querySelector(selector);
          if (!root) return JSON.stringify({ ok: false, error: `select not found: ${selector}` });
          if (root.tagName === "SELECT") {
            const opt = [...root.options].find((o) => (o.label || o.textContent || o.value).trim() === String(value));
            if (!opt) return JSON.stringify({ ok: false, error: `option missing: ${value}` });
            const wasSame = root.value === opt.value;
            root.value = opt.value;
            opt.selected = true;
            root.dispatchEvent(new window.Event("change", { bubbles: true }));
            return JSON.stringify({ ok: true, alreadySelected: wasSame, value });
          }
          const avail = (root.getAttribute("data-options") || "").split("|").map((s) => s.trim()).filter(Boolean);
          if (avail.length > 0 && !avail.includes(String(value))) {
            return JSON.stringify({ ok: false, error: `option not available: ${value}` });
          }
          let itemEl = root.querySelector("[role='option'][aria-selected='true']");
          if (!itemEl) {
            itemEl = window.document.createElement("span");
            itemEl.setAttribute("role", "option");
            itemEl.setAttribute("aria-selected", "true");
            root.appendChild(itemEl);
          }
          itemEl.textContent = String(value);
          return JSON.stringify({ ok: true, alreadySelected: false, value });
        } finally {
          restoreGlobals();
        }
      },
    },
    {
      name: "screenshot",
      async execute() {
        lastShot = FAKE_SHOT_DATA_URL;
        return "captured";
      },
    },
  ];

  return {
    dom,
    window,
    rawTools,
    getLastCapturedImage: () => lastShot,
    clearLastCapturedImage: () => {
      lastShot = null;
    },
    resolvePageSnapshot: async () => ({
      tabId: 101,
      url: window.location.href,
      title: window.document.title || "Workspace",
    }),
    cleanup() {
      window.HTMLElement.prototype.getBoundingClientRect = origGBR;
      dom.window.close();
    },
  };
}

// ── 1. /workflow 指令解析、内置指令识别与按步骤实际 op 授权胶囊 ──
{
  const readOnlyWf = {
    schemaVersion: "1.0",
    id: "generic-readonly-audit",
    binds: {
      entryUrl: "https://portal.example.org/workspace/#/records?tab=open",
      ratioText: "季度/年度",
    },
    policy: {
      forbidClickTexts: ["归档", "删除", "上传附件"],
      forbidUrlPatterns: ["external-admin.example.com"],
    },
    steps: [
      { id: "S1.url", op: "assert_url", params: { mustStartWith: "{{entryUrl}}" } },
      { id: "S2.check", op: "assert_state", params: { checks: [{ kind: "modals_count", equals: 0 }] } },
    ],
  };

  const barePrompt = `/workflow\n${JSON.stringify(readOnlyWf, null, 2)}`;
  const fencedPrompt = `/workflow\n\`\`\`json\n${JSON.stringify(readOnlyWf, null, 2)}\n\`\`\``;

  assert.equal(isWorkflowDirectiveText(barePrompt), true);
  assert.equal(isWorkflowDirectiveText(fencedPrompt), true);
  assert.equal(isWorkflowDirectiveText("请说明 workflow 的含义"), false);
  assert.equal(extractBuiltinDirective(barePrompt), "workflow");
  assert.equal(parseSlashToken(barePrompt), null);
  assert.equal(Boolean(userInvokedSkill(barePrompt, [{ id: "workflow", trigger: "/workflow" }])), false);

  const parsed = parseWorkflowDirective(fencedPrompt);
  assert.equal(parsed.id, "generic-readonly-audit");
  assert.deepEqual(parsed.policy.forbidClickTexts, ["归档", "删除", "上传附件"]);

  // 纯只读 workflow 不得无条件授予 input 权限，也不把 forbidUrlPatterns 当作授权站点
  const roCap = extractCapsule(barePrompt);
  assert.equal(roCap.actions.includes("input"), false);
  assert.equal(roCap.origins.includes("portal.example.org"), true);
  assert.equal(roCap.origins.includes("external-admin.example.com"), false);

  // 含交互宏的 workflow 自动按宏展开授予 input 权限
  const mutatingWf = {
    ...readOnlyWf,
    macros: {
      edit_drawer: {
        steps: [{ id: "m1", op: "fill_input", params: { selector: "#title", value: "Updated" } }],
      },
    },
    steps: [{ id: "S1", op: "call_macro", params: { macro: "edit_drawer" } }],
  };
  const mutCap = extractCapsule(`/workflow\n${JSON.stringify(mutatingWf)}`);
  assert.equal(mutCap.actions.includes("input"), true);
}

// ── 2. 参数绑定、条件谓词、纯数据变换与外部阻断探测（收紧不误杀普通正文） ──
{
  const binds = {
    env: { host: "portal.example.org" },
    flags: { enabled: true, skipped: false },
    items: ["Alpha", "Beta"],
  };
  assert.equal(interpolateParams("https://{{env.host}}/app", binds), "https://portal.example.org/app");
  assert.deepEqual(interpolateParams("{{items}}", binds), ["Alpha", "Beta"]);
  assert.equal(evaluateWhenPredicate("flags.enabled", binds), true);
  assert.equal(evaluateWhenPredicate("!flags.skipped", binds), true);
  assert.equal(
    evaluateWhenPredicate(
      { all: ["flags.enabled", { equals: ["{{env.host}}", "portal.example.org"] }] },
      binds,
    ),
    true,
  );

  // 普通正文包含“账号异常”或“登录”不得误触发外部环境阻断
  assert.equal(
    detectExternalBlocker({
      url: "https://portal.example.org/workspace/#/records",
      title: "工单中心",
      text: "工单详情：客户反馈账号异常与登录缓慢，请排查日志" + "。".repeat(400),
    }),
    null,
  );
  // 真实登录重定向路由正常识别
  assert.ok(
    detectExternalBlocker({
      url: "https://portal.example.org/sso/login?redirect=%2Fworkspace",
      title: "统一认证",
      text: "",
    }),
  );

  // plan_field_actions 纯数据变换验证
  const planned = evaluateDataTransform(
    {
      $op: "plan_field_actions",
      fields: [
        { label: "* 优先级", cleanLabel: "优先级", starred: true, selectedItems: [], inputValues: [], isFilled: false, selectCount: 1, inputCount: 0 },
        { label: "* 预估工时", cleanLabel: "预估工时", starred: true, selectedItems: [], inputValues: ["4"], isFilled: true, selectCount: 0, inputCount: 1 },
      ],
      rules: [
        { kind: "select", labelIncludes: "优先级", value: "高" },
        { kind: "input", labelIncludes: "预估工时", value: "8" },
      ],
      preserveExisting: true,
    },
    binds,
  );
  assert.equal(planned.plans.length, 1);
  assert.equal(planned.plans[0].cleanLabel, "优先级");
  assert.equal(planned.expectedFields.length, 2);
  assert.deepEqual(planned.expectedFields[1].inputs, ["4"]);

  const summary = {};
  applyBindTransforms(
    [{ target: "runtime.computed", expr: { $op: "dict_phrase_join", sourceText: "紧急数据库巡检", prefix: "Ops", suffix: "Ticket", dictionary: [["紧急", "Urgent"], ["数据库", "Database"]] } }],
    summary,
  );
  assert.equal(summary.runtime.computed, "Ops Urgent Database Ticket");
}

// ── 3. 标签语义定位、@topDialog、异步行水合、宏/foreach/steps.didMutate 与策略守卫闭环 ──
{
  const html = `<!doctype html><html><head><title>Workspace</title></head><body>
    <header>全部 2 未处理 1 已处理 1</header>
    <table>
      <thead><tr><th>编号</th><th>标题</th><th>处理人</th><th>操作</th></tr></thead>
      <tbody>
        <tr><td>T-100</td><td class="rec-title">已完成数据库备份巡检</td><td>Alice</td><td><button type="button">编辑</button><button type="button">归档</button></td></tr>
        <tr><td>T-101</td><td class="rec-title">紧急网关延迟排查</td><td>-</td><td><button type="button" id="open-t101">编辑</button><button type="button">归档</button></td></tr>
      </tbody>
    </table>

    <dialog id="edit-dialog">
      <h2>编辑记录</h2>
      <div class="section">
        <div class="field-caption">所属团队</div>
        <select id="team-select"><option value="">请选择</option><option value="SRE">SRE</option><option value="QA">QA</option></select>

        <div class="field-caption">* 通知渠道</div>
        <div class="channel-group">
          <label><input type="checkbox" value="all" /> 全选</label>
          <label><input type="checkbox" value="email" checked /> 邮件</label>
          <label><input type="checkbox" value="im" /> 即时消息</label>
        </div>

        <div class="field-caption">* 升级策略</div>
        <div class="policy-box">
          <table>
            <thead><tr><th>所属团队</th><th>升级策略</th></tr></thead>
            <tbody>
              <tr>
                <td>SRE</td>
                <td>
                  <div role="combobox" id="escalation-combo" data-options="默认队列">
                    <span role="option" aria-selected="true">默认队列</span>
                  </div>
                  <button type="button" id="sync-escalation">同步</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <fieldset>
          <legend>根因摘要</legend>
          <input id="summary-input" value="" />
        </fieldset>

        <button type="button" id="open-approver">选择审批人</button>
        <div id="approver-display">未绑定</div>
        <button type="button" id="save-close">确认提交</button>
      </div>
    </dialog>

    <dialog id="approver-dialog">
      <h3>选择审批人</h3>
      <table>
        <tbody id="approver-tbody">
          <tr><td>暂无数据</td></tr>
        </tbody>
      </table>
    </dialog>
  </body></html>`;

  const h = createJsdomHarness(html);
  try {
    const doc = h.window.document;
    doc.getElementById("open-t101").addEventListener("click", () => {
      doc.getElementById("edit-dialog").setAttribute("open", "");
    });
    doc.getElementById("sync-escalation").addEventListener("click", () => {
      doc.getElementById("escalation-combo").setAttribute("data-options", "默认队列|P1值班组");
    });
    doc.getElementById("open-approver").addEventListener("click", () => {
      const sub = doc.getElementById("approver-dialog");
      sub.setAttribute("open", "");
      // Simulate async table hydration after 220ms
      setTimeout(() => {
        doc.getElementById("approver-tbody").innerHTML = `
          <tr><td>OnCall-Lead</td><td><button type="button" id="pick-lead">选用</button></td></tr>
        `;
        doc.getElementById("pick-lead").addEventListener("click", () => {
          doc.getElementById("approver-display").textContent = "审批人:OnCall-Lead";
          sub.removeAttribute("open");
        });
      }, 220);
    });
    doc.getElementById("save-close").addEventListener("click", () => {
      doc.getElementById("edit-dialog").removeAttribute("open");
    });

    const directive = parseWorkflowDirective(
      `/workflow\n${JSON.stringify({
        schemaVersion: "1.0",
        id: "generic-ticket-flow",
        policy: {
          forbidClickTexts: ["归档"],
          forbidUrlPatterns: ["forbidden.example.com"],
        },
        binds: {
          targetTeam: "SRE",
          channels: ["邮件", "即时消息"],
          escalationPolicy: "P1值班组",
          extraTags: [{ label: "根因摘要", val: "网关连接池耗尽" }],
        },
        macros: {
          pick_async_approver: {
            steps: [
              {
                id: "m.open",
                op: "click_and_wait",
                params: { scope: "@topDialog", text: "选择审批人", waitModalsDelta: 1 },
              },
              {
                id: "m.wait_rows",
                op: "wait_for",
                params: {
                  scope: "@topDialog",
                  minRows: 1,
                  rowMustInclude: ["OnCall-Lead"],
                  ignoreTexts: ["暂无数据"],
                  timeoutMs: 3000,
                },
              },
              {
                id: "m.choose",
                op: "row_action",
                params: {
                  scope: "@topDialog",
                  mustIncludeAll: ["OnCall-Lead"],
                  buttonText: "选用",
                  countsAsMutation: true,
                  waitModalsDelta: -1,
                },
              },
            ],
          },
        },
        summaryLines: ["团队={{targetTeam}}", "变更数={{workflow.mutationsCount}}"],
        steps: [
          {
            id: "S1.open_unassigned",
            op: "row_action",
            params: {
              mustIncludeAll: ["T-101"],
              buttonText: "编辑",
              waitSelector: "@topDialog",
            },
          },
          {
            id: "S2.team",
            op: "ensure_select",
            params: { scope: "@topDialog", fieldLabel: "所属团队", value: "{{targetTeam}}" },
          },
          {
            id: "S3.channels",
            op: "ensure_checkboxes",
            params: { scope: "@topDialog", fieldLabel: "通知渠道", equals: "{{channels}}", excludeLabels: ["全选"] },
          },
          {
            id: "S4.escalation",
            op: "ensure_select",
            params: {
              scope: "@topDialog",
              fieldLabel: "升级策略",
              rowText: "{{targetTeam}}",
              value: "{{escalationPolicy}}",
              syncActionText: "同步",
              hydrateWaitMs: 50,
            },
          },
          {
            id: "S5.foreach_inputs",
            op: "foreach",
            params: {
              over: "extraTags",
              as: "tagItem",
              steps: [
                {
                  id: "S5.fill",
                  op: "fill_input",
                  params: { scope: "@topDialog", fieldLabel: "{{tagItem.label}}", value: "{{tagItem.val}}", blur: true },
                },
              ],
            },
          },
          {
            id: "S6.async_approver",
            op: "call_macro",
            params: { macro: "pick_async_approver" },
          },
          {
            id: "S7.verify_dialog",
            op: "assert_state",
            screenshot: true,
            params: {
              scope: "@topDialog",
              checks: [
                { kind: "select_items_include", mustInclude: ["SRE", "P1值班组"] },
                { kind: "checked_checkboxes_equal", fieldLabel: "通知渠道", ignoreLabels: ["全选"], equals: ["邮件", "即时消息"] },
                { kind: "text_includes", mustInclude: ["审批人:OnCall-Lead"] },
              ],
            },
          },
          {
            id: "S8.commit_if_mutated",
            op: "click_and_wait",
            when: "steps.S2.team.didMutate",
            params: { scope: "@topDialog", text: "确认提交", singleShotKey: "commit_once", waitModalsCount: 0 },
          },
        ],
      })}`,
    );

    const traceSteps = [];
    const res = await runDeterministicWorkflow({
      directive,
      rawTools: h.rawTools,
      getLastCapturedImage: h.getLastCapturedImage,
      clearLastCapturedImage: h.clearLastCapturedImage,
      resolvePageSnapshot: h.resolvePageSnapshot,
      traceSteps,
    });

    assert.equal(res.ok, true, res.errorMessage || "");
    assert.equal(res.executedSteps, 8);
    assert.ok(res.mutationsCount >= 4);
    assert.equal(res.binds.steps.S2.team.didMutate, true);

    const summaryText = formatWorkflowSummary(res);
    assert.ok(summaryText.includes("generic-ticket-flow"));
    assert.ok(summaryText.includes("团队=SRE"));
    // 摘要不再耦合任何 Downloads/pagelens-runs 落盘文件名
    assert.equal(summaryText.includes("pagelens-runs"), false);

    // 验证运行记录构建与模型零消耗统计
    const rec = buildRunRecord({
      runId: "run_generic_wf_test",
      source: "sidepanel",
      status: "done",
      endReason: "stop",
      model: { model: WORKFLOW_MODEL_ID },
      startedAt: Date.now() - 200,
      endedAt: Date.now(),
      userPrompt: "/workflow {}",
      botResponse: summaryText,
      steps: traceSteps,
      metrics: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
    assert.equal(rec.traceRecord.toolSteps.length, 8);

    // 策略守卫拦截禁止按钮文本（on_fail: "stop"）
    const forbiddenRes = await runDeterministicWorkflow({
      rawText: `/workflow\n${JSON.stringify({
        schemaVersion: "1.0",
        id: "guard-block-test",
        policy: { forbidClickTexts: ["归档"] },
        steps: [
          { id: "B1", op: "row_action", params: { mustIncludeAll: ["T-101"], buttonText: "归档" } },
          { id: "B2", op: "wait_for", params: { selector: "table" } },
        ],
      })}`,
      rawTools: h.rawTools,
      getLastCapturedImage: h.getLastCapturedImage,
      clearLastCapturedImage: h.clearLastCapturedImage,
      resolvePageSnapshot: h.resolvePageSnapshot,
    });
    assert.equal(forbiddenRes.ok, false);
    assert.equal(forbiddenRes.failure.code, "WORKFLOW_FORBIDDEN_ACTION");
    assert.equal(forbiddenRes.executedSteps, 0);
  } finally {
    h.cleanup();
  }
}

// ── 4. buildAssertStateBatches 分批与 @topDialog / 原生控件断言生成 ──
{
  const batches = buildAssertStateBatches("@topDialog", [
    { id: "c1", kind: "modals_count", equals: 1 },
    { id: "c2", kind: "elements_count", selector: "button", text: "确认", minCount: 1 },
    { id: "c3", kind: "text_excludes", forbid: ["异常"] },
  ]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].count, 3);
}

console.log("PASS: test_workflow_runner.mjs (generic primitives, binds, macros & policy guards)");

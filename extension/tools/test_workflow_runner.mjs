import assert from "node:assert/strict";

import { extractCapsule } from "../lib/agent/trust/capsule.js";
import { runJs } from "../lib/agent/page-fns.js";
import {
  WORKFLOW_MODEL_ID,
  buildAssertStateBatches,
  evaluateWhenPredicate,
  formatWorkflowSummary,
  interpolateParams,
  isWorkflowDirectiveText,
  parseWorkflowDirective,
  runDeterministicWorkflow,
} from "../lib/agent/workflow-runner.js";
import {
  buildRunRecord,
  formatTimestampForFilename,
  predictDetachedImagePaths,
} from "../lib/run-recorder.js";
import { parseSlashToken, userInvokedSkill } from "../lib/slash.js";

const LARGE_FAKE_PNG_DATA_URL =
  "data:image/png;base64," + "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ".repeat(140);

// ── 1. /workflow 指令解析、slash 技能隔离与纯净意图胶囊抽取 ──
{
  const wfObj = {
    schemaVersion: "1.0",
    id: "generic-catalog-draft-v1",
    binds: {
      listUrl: "https://portal.example.org:8443/workspace/#/catalog?tab=drafts",
      ratioLabel: "秋/冬",
      categoryPath: "服饰 / 外套 / 针织衫",
      enableOptionalBlock: false,
    },
    forbidClickTexts: ["发布", "批量发布", "删除", "移除", "上传视频", "上传文件", "保存设置"],
    forbidUrlSubstrings: ["external-seller.example.com"],
    steps: [
      {
        id: "S1.url",
        op: "assert_url",
        params: { mustStartWith: "{{listUrl}}" },
      },
    ],
  };

  const barePrompt = `/workflow\n${JSON.stringify(wfObj, null, 2)}`;
  const fencedPrompt = `/workflow\n\`\`\`json\n${JSON.stringify(wfObj, null, 2)}\n\`\`\``;
  const oversizedPrompt = `/workflow\n${JSON.stringify({ ...wfObj, pad: "x".repeat(25000) })}`;

  assert.equal(isWorkflowDirectiveText(barePrompt), true);
  assert.equal(isWorkflowDirectiveText(fencedPrompt), true);
  assert.equal(isWorkflowDirectiveText("普通对话调用 workflow 同步"), false);

  const parsedBare = parseWorkflowDirective(barePrompt);
  const parsedFenced = parseWorkflowDirective(fencedPrompt);
  assert.equal(parsedBare.id, "generic-catalog-draft-v1");
  assert.equal(parsedFenced.steps.length, 1);

  // slash 菜单与技能恢复隔离
  assert.equal(parseSlashToken("/workflow", 9), null, "/workflow 不弹空技能菜单");
  assert.equal(parseSlashToken(barePrompt, 9), null, "/workflow 多行指令不触发斜杠补全");
  assert.equal(userInvokedSkill(barePrompt), false, "/workflow 不触发技能扫描或侧栏重开续跑");
  assert.equal(userInvokedSkill("/browse 总结这页"), true, "常规 /skill 保持原行为");

  // 胶囊纯净性：即使含超 20,000 字 JSON、forbidClickTexts 含「发布/删除/上传」、路径斜杠文本，也不污染胶囊
  for (const raw of [barePrompt, fencedPrompt, oversizedPrompt]) {
    const cap = extractCapsule(raw);
    assert.deepEqual(cap.actions, ["navigate", "input"], "workflow 胶囊仅含 navigate/input");
    assert.deepEqual(cap.origins, ["portal.example.org"], "仅提取 binds 内合法 URL 域名");
    assert.deepEqual(cap.paths, [], "斜杠分类文案不误判为本机路径");
    assert.deepEqual(cap.commands, [], "JSON 内容不误判为终端命令");
    assert.deepEqual(cap.platforms, [], "不误吸平台列表");
  }
  console.log("PASS 1. /workflow directive parsing, slash exclusion & pure capsule extraction");
}

// ── 2. 参数插值与静态布尔 when 守卫（缺参立即停机且归因 workflow）──
{
  const binds = {
    item: { code: "SKU-100", tags: ["A", "B"] },
    price: "99.50",
    enableExtra: true,
    skipBlock: false,
  };
  const resolved = interpolateParams(
    {
      exactArr: "{{item.tags}}",
      mixedStr: "编码={{item.code}} 价格={{price}}",
    },
    binds,
    { stepIndex: 2, stepId: "S2", op: "fill_input" },
  );
  assert.deepEqual(resolved.exactArr, ["A", "B"]);
  assert.equal(resolved.mixedStr, "编码=SKU-100 价格=99.50");

  assert.equal(evaluateWhenPredicate("enableExtra", binds), true);
  assert.equal(evaluateWhenPredicate("!enableExtra", binds), false);
  assert.equal(evaluateWhenPredicate("!skipBlock", binds), true);

  let bindErr = null;
  try {
    interpolateParams({ bad: "{{missingKey}}" }, binds, { stepIndex: 3, stepId: "S3", op: "fill_input" });
  } catch (err) {
    bindErr = err;
  }
  assert.ok(bindErr, "缺失占位符必须抛错");
  assert.equal(bindErr.blame, "workflow");
  assert.equal(bindErr.code, "WORKFLOW_BIND_MISSING");
  console.log("PASS 2. strict parameter interpolation & static boolean when guard");
}

// ── 3. 幂等收敛测试（已选中下拉、已填输入框、已绑实体均 0 次写操作跳过，绝不反选或点移除）──
{
  const calls = [];
  let lastImg = null;
  const rawTools = {
    run_js: async ({ code }) => {
      calls.push({ tool: "run_js", code: code.slice(0, 50) });
      if (code.includes("location.href")) {
        return JSON.stringify({
          ok: true,
          result: { url: "https://portal.example.org/app#/list", title: "Catalog", bodySample: "Ready" },
        });
      }
      if (code.includes("input#cat")) {
        return JSON.stringify({ ok: true, result: { exists: true, itemText: "一级 / 二级 / 叶子" } });
      }
      if (code.includes("input#titleCn")) {
        return JSON.stringify({ ok: true, result: { exists: true, count: 1, value: "已清洗标题" } });
      }
      if (code.includes(".entity-selected-card")) {
        return JSON.stringify({ ok: true, result: "modelA 尺码:M / 感受:合身 移除" });
      }
      if (code.includes("单价")) {
        return JSON.stringify({
          ok: true,
          result: code.includes("return [...") ? ["88.00", "88.00"] : { count: 2, values: ["88.00", "88.00"] },
        });
      }
      return JSON.stringify({ ok: true, result: true });
    },
    select_option: async (args) => {
      calls.push({ tool: "select_option", args });
      return JSON.stringify({ ok: true, alreadySelected: true, selected: [args.value] });
    },
    wait_for: async (args) => {
      calls.push({ tool: "wait_for", args });
      return JSON.stringify({ ok: true, count: 1 });
    },
    fill: async (args) => {
      calls.push({ tool: "fill", args });
      return JSON.stringify({ ok: true });
    },
    click: async (args) => {
      calls.push({ tool: "click", args });
      return JSON.stringify({ ok: true });
    },
    screenshot: async () => {
      lastImg = LARGE_FAKE_PNG_DATA_URL;
      return "已截图";
    },
  };

  const directive = parseWorkflowDirective(
    `/workflow\n` +
      JSON.stringify({
        schemaVersion: "1.0",
        id: "idempotent-suite",
        binds: {
          baseUrl: "https://portal.example.org/app#/list",
          enableDisabledStep: false,
        },
        forbidClickTexts: ["发布", "移除"],
        steps: [
          { id: "S1", op: "assert_url", params: { mustStartWith: "{{baseUrl}}" } },
          {
            id: "S2",
            op: "ensure_cascader",
            params: {
              selector: "input#cat",
              expectedText: "一级 / 二级 / 叶子",
              mode: "search",
              searchValue: "叶子",
              postWaitSelector: ".attr-panel",
            },
          },
          {
            id: "S3",
            op: "fill_input",
            params: { selector: "input#titleCn", value: "已清洗标题" },
          },
          {
            id: "S4",
            op: "fill_input",
            params: {
              items: [
                { selector: 'input[placeholder="单价"]', all: true, value: "88.00" },
                { selector: "input#titleCn", value: "已清洗标题" },
              ],
            },
          },
          {
            id: "S5",
            op: "ensure_select",
            params: { label: "季节", values: ["秋/冬"] },
          },
          {
            id: "S6",
            op: "ensure_modal_entity",
            params: {
              selectedSelector: ".entity-selected-card",
              alreadyBoundTexts: ["modelA", "尺码:M", "感受:合身"],
              openButtonText: "添加实体",
              rowMustInclude: ["modelA"],
              rowActionText: "使用",
              optionClicks: ["M", "合身"],
              confirmText: "确认",
            },
          },
          {
            id: "S7",
            op: "click_and_wait",
            when: "enableDisabledStep",
            params: { text: "不应执行" },
          },
        ],
      }),
  );

  const traceSteps = [];
  const res = await runDeterministicWorkflow({
    directive,
    rawTools,
    getLastCapturedImage: () => lastImg,
    clearLastCapturedImage: () => {
      lastImg = null;
    },
    resolvePageSnapshot: async () => ({
      tabId: 7,
      url: "https://portal.example.org/app#/list",
      title: "Catalog",
    }),
    traceSteps,
  });

  assert.equal(res.ok, true, "幂等工作流应全部通过");
  assert.equal(res.executedSteps, 6);
  assert.equal(res.skippedSteps, 1);
  assert.equal(
    calls.filter((c) => c.tool === "click" || c.tool === "fill").length,
    0,
    "已满足状态时 click 与 fill 写操作必须严格为 0 次",
  );
  console.log("PASS 3. idempotent ensure_* zero-write skip (0 clicks, 0 fills on pre-satisfied DOM)");
}

// ── 4. 严格 on_fail: "stop"、五字段输出、三重归因（其他 / 工具 / workflow）与红线拦截 ──
{
  // 4a. 第 2 步断言失配 -> 第 3、4 步零执行，归因 workflow，自动补拍失败截图并与 buildRunRecord 路径字节级一致
  let step3Executed = false;
  let lastShot = null;
  const failTraceSteps = [];
  const failRes = await runDeterministicWorkflow({
    rawText:
      `/workflow\n` +
      JSON.stringify({
        schemaVersion: "1.0",
        id: "stop-on-fail-test",
        binds: {},
        forbidClickTexts: ["发布"],
        steps: [
          { id: "T1", op: "assert_url", params: { mustInclude: "portal.example.org" } },
          {
            id: "T2",
            op: "assert_state",
            params: {
              checks: [{ kind: "input_equals", selector: "input#qty", equals: "100" }],
            },
          },
          {
            id: "T3",
            op: "click_and_wait",
            params: { text: "下一步" },
          },
        ],
      }),
    rawTools: {
      run_js: async ({ code }) => {
        if (code.includes("location.href")) {
          return JSON.stringify({
            ok: true,
            result: { url: "https://portal.example.org/edit", title: "Edit", bodySample: "Form" },
          });
        }
        return JSON.stringify({
          ok: true,
          result: {
            pass: false,
            index: 0,
            kind: "input_equals",
            expected: 'input#qty 值 === "100"',
            actual: '实读值 === "50"',
          },
        });
      },
      click: async () => {
        step3Executed = true;
        return JSON.stringify({ ok: true });
      },
      screenshot: async () => {
        lastShot = LARGE_FAKE_PNG_DATA_URL;
        return "已截图";
      },
    },
    getLastCapturedImage: () => lastShot,
    clearLastCapturedImage: () => {
      lastShot = null;
    },
    resolvePageSnapshot: async () => ({ tabId: 9, url: "https://portal.example.org/edit", title: "Edit" }),
    traceSteps: failTraceSteps,
  });

  assert.equal(failRes.ok, false);
  assert.equal(step3Executed, false, "第 2 步失败后第 3 步绝对不可执行");
  assert.equal(failTraceSteps.length, 2, "仅记录前 2 步");
  assert.equal(failRes.failure.blame, "workflow");

  const endedAt = "2026-11-12T05:30:00.000Z";
  const tsSlug = formatTimestampForFilename(endedAt);
  const runId = "run_wftest_01";
  const predictedPaths = predictDetachedImagePaths(failTraceSteps, {
    tsSlug,
    source: "sidepanel",
    runId,
  });
  assert.equal(predictedPaths.length, 1, "失败步自动补拍的截图应预测出 1 条落盘路径");

  const botSummary = formatWorkflowSummary({
    ...failRes,
    allShotPaths: predictedPaths,
    lastShotPath: predictedPaths[predictedPaths.length - 1],
  });
  assert.ok(botSummary.includes("失败步号: 第 2 步 (T2 · assert_state)"));
  assert.ok(botSummary.includes('期望状态原文: input#qty 值 === "100"'));
  assert.ok(botSummary.includes('页面实读原文: 实读值 === "50"'));
  assert.ok(botSummary.includes(`截图路径: ${predictedPaths[0]}`));
  assert.ok(botSummary.includes("失败归属: workflow"));

  const built = buildRunRecord({
    runId,
    source: "sidepanel",
    startedAt: "2026-11-12T05:29:55.000Z",
    endedAt,
    tsSlug,
    status: "failed",
    endReason: "error",
    model: WORKFLOW_MODEL_ID,
    userPrompt: "/workflow {}",
    botResponse: botSummary,
    steps: failTraceSteps,
    conversationMessages: [
      { role: "user", content: "/workflow {}" },
      { role: "assistant", content: botSummary },
    ],
  });
  assert.equal(built.detachedImages.length, 1, "buildRunRecord 应拆离出 1 张独立 PNG");
  assert.equal(
    built.detachedImages[0].filename,
    predictedPaths[0],
    "五字段中的截图路径必须与 buildRunRecord 拆离文件名 100% 字节级一致",
  );
  assert.equal(built.traceRecord.metrics.totalTokens, 0);
  assert.equal(built.traceRecord.toolSteps[1].blame, "workflow");
  assert.equal(built.traceRecord.toolSteps[1].screenshotArtifact, `[artifact:${predictedPaths[0]}]`);

  // 4b. 外部登录失效阻断 -> 归因「其他」
  const extRes = await runDeterministicWorkflow({
    rawText:
      `/workflow\n` +
      JSON.stringify({
        schemaVersion: "1.0",
        id: "external-blocker-test",
        binds: {},
        steps: [{ id: "E1", op: "assert_url", params: { mustInclude: "portal.example.org" } }],
      }),
    rawTools: {
      run_js: async () =>
        JSON.stringify({
          ok: true,
          result: { url: "https://portal.example.org/sso/login", title: "Login", bodySample: "请登录" },
        }),
    },
  });
  assert.equal(extRes.ok, false);
  assert.equal(extRes.failure.blame, "其他");

  // 4c. 文件选择框拦截 -> 归因「工具」
  const toolRes = await runDeterministicWorkflow({
    rawText:
      `/workflow\n` +
      JSON.stringify({
        schemaVersion: "1.0",
        id: "file-chooser-block-test",
        binds: {},
        steps: [{ id: "F1", op: "click_and_wait", params: { text: "选择素材" } }],
      }),
    rawTools: {
      click: async () => JSON.stringify({ ok: false, blockedFileChooser: true, error: "已拦截文件上传控件点击" }),
    },
  });
  assert.equal(toolRes.ok, false);
  assert.equal(toolRes.failure.blame, "工具");

  // 4d. 禁点红线与不可逆动作拦截 -> 底层 click 调用次数严格为 0
  let publishClicked = false;
  const redlineRes = await runDeterministicWorkflow({
    rawText:
      `/workflow\n` +
      JSON.stringify({
        schemaVersion: "1.0",
        id: "redline-block-test",
        binds: {},
        forbidClickTexts: ["发布", "批量发布"],
        steps: [{ id: "R1", op: "click_and_wait", params: { text: "发布" } }],
      }),
    rawTools: {
      click: async () => {
        publishClicked = true;
        return JSON.stringify({ ok: true });
      },
    },
  });
  assert.equal(redlineRes.ok, false);
  assert.equal(publishClicked, false, "命中禁点红线时底层 click 绝不可被调用");
  assert.equal(redlineRes.failure.blame, "workflow");

  console.log("PASS 4. strict on_fail:stop, 5-field report, 3-way blame & detached screenshot path parity");
}

// ── 5. assert_state 全量无截断实读证据链（actualReadback.evidence 完整落入 toolSteps）──
{
  const longFieldDump = Array.from({ length: 18 }, (_, i) => ({
    label: `* 属性_${i + 1}`,
    items: [`枚举值_${i + 1}_完整实读原文`],
    inputs: i === 0 ? ["100"] : [],
  }));
  const passTraceSteps = [];
  const passRes = await runDeterministicWorkflow({
    rawText:
      `/workflow\n` +
      JSON.stringify({
        schemaVersion: "1.0",
        id: "readback-evidence-test",
        binds: {},
        steps: [
          {
            id: "V1.readback",
            op: "assert_state",
            params: {
              checks: [
                { id: "fields_18", kind: "field_blocks_match", expectedFields: [{ labelIncludes: "属性_1", items: ["枚举值_1_完整实读原文"] }] },
                { id: "cn_title", kind: "input_equals", selector: "input#cn", equals: "真实回读标题" },
              ],
            },
          },
        ],
      }),
    rawTools: {
      run_js: async () =>
        JSON.stringify({
          ok: true,
          result: {
            pass: true,
            checkedCount: 2,
            evidence: [
              { index: 0, id: "fields_18", kind: "field_blocks_match", actual: longFieldDump },
              { index: 1, id: "cn_title", kind: "input_equals", actual: "真实回读标题" },
            ],
          },
        }),
    },
    traceSteps: passTraceSteps,
  });

  assert.equal(passRes.ok, true);
  const builtPass = buildRunRecord({
    runId: "run_readback_01",
    source: "sidepanel",
    steps: passTraceSteps,
    model: WORKFLOW_MODEL_ID,
  });
  const stepRec = builtPass.traceRecord.toolSteps[0];
  assert.equal(stepRec.workflowStepId, "V1.readback");
  assert.equal(stepRec.actualReadback.checkedCount, 2);
  assert.equal(stepRec.actualReadback.evidence.length, 2);
  assert.equal(stepRec.actualReadback.evidence[0].actual.length, 18, "18 项属性实读证据不得被截断");
  assert.equal(stepRec.actualReadback.evidence[1].actual, "真实回读标题");
  console.log("PASS 5. assert_state full untruncated actualReadback.evidence persisted in toolSteps");
}

// ── 6. ADR-020 真实 page-fns.runJs 长度契约与深层嵌套实读证据零 "[…]" 截断回归测试 ──
{
  const smallChecks = [
    { id: "m0", kind: "modals_count", equals: 0 },
    { id: "hdr", kind: "text_matches_regex", pattern: "全部\\s*30\\s*未发布\\s*30" },
    { id: "row", kind: "row_state", rowSelector: "tr", mustIncludeAll: ["SKU-01"], expectedCount: 1 },
  ];
  const smallBatches = buildAssertStateBatches("", smallChecks, 6000);
  assert.equal(smallBatches.length, 1);
  assert.ok(smallBatches[0].code.length < 4500, `3 项断言脚本应紧凑 (<4500)，实测=${smallBatches[0].code.length}`);

  const largeChecks = [
    {
      id: "fields_15",
      kind: "field_blocks_match",
      fieldSelector: ".attr-block",
      labelSelector: ".attr-label",
      expectedFields: Array.from({ length: 15 }, (_, k) => ({
        labelIncludes: `字段_${k + 1}`,
        items: [`选项_${k + 1}`],
        ...(k === 0 ? { inputs: ["100"] } : {}),
      })),
    },
    ...Array.from({ length: 28 }, (_, k) => ({
      id: `ph_${k}`,
      kind: "inputs_by_placeholder_equal",
      placeholder: `占位_${k}`,
      equals: [`值_${k}`],
    })),
  ];
  const largeBatches = buildAssertStateBatches(".modal-root", largeChecks, 6000);
  assert.ok(largeBatches.length >= 1);
  for (const b of largeBatches) {
    assert.ok(b.code.length <= 6000, `分批脚本长度必须 <= 6000，实测=${b.code.length}`);
  }

  // 直接走真实 page-fns.js#runJs 验证执行不报“代码过长”且第 6 层数组元素不被 dump 截成 "[…]"
  const prevDoc = globalThis.document;
  const prevStyle = globalThis.getComputedStyle;
  try {
    const fakeBlock = {
      querySelector: (sel) => (sel === ".attr-label" ? { innerText: "* 材质成分" } : null),
      querySelectorAll: (sel) => {
        if (sel === ".ant-select-selection-item") {
          return [{ querySelector: () => null, textContent: "纯棉材质" }];
        }
        if (sel === "input") {
          return [{ type: "text", value: "100" }];
        }
        return [];
      },
    };
    const fakeRoot = {
      innerText: "全部 30 未发布 30",
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === ".attr-block" ? [fakeBlock] : []),
    };
    const fakeBody = {
      innerText: "全部 30 未发布 30 发布中 0 已发布 0 批量发布",
      querySelector: (sel) => (sel === ".modal-root" ? fakeRoot : null),
      querySelectorAll: () => [],
    };
    globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible" });
    // 真实浏览器 Document 节点无 innerText（undefined），文本在 document.body.innerText
    globalThis.document = {
      body: fakeBody,
      documentElement: fakeBody,
      querySelector: (sel) => (sel === ".modal-root" ? fakeRoot : null),
      querySelectorAll: () => [],
    };

    const docScopeBatch = buildAssertStateBatches("", [
      { id: "doc_regex", kind: "text_matches_regex", pattern: "全部\\s*30\\s*未发布\\s*30\\s*发布中\\s*0\\s*已发布\\s*0" },
      { id: "doc_inc", kind: "text_includes", mustInclude: ["批量发布"] },
      { id: "doc_exc", kind: "text_excludes", forbid: ["异常报错"] },
    ]);
    const docOut = await runJs(docScopeBatch[0].code);
    assert.equal(docOut.ok, true);
    assert.equal(docOut.result.pass, true, `默认整页作用域必须读取 document.body.innerText，实际=${JSON.stringify(docOut.result)}`);
    assert.equal(docOut.result.evidence[0].actual, "全部 30 未发布 30 发布中 0 已发布 0");

    const realBatch = buildAssertStateBatches(".modal-root", [
      {
        id: "deep_attr",
        kind: "field_blocks_match",
        fieldSelector: ".attr-block",
        labelSelector: ".attr-label",
        expectedFields: [{ labelIncludes: "材质成分", items: ["纯棉材质"], inputs: ["100"] }],
      },
    ]);
    const realOut = await runJs(realBatch[0].code);
    assert.equal(realOut.ok, true, `真实 runJs 应返回 ok:true，实际=${JSON.stringify(realOut)}`);
    assert.equal(realOut.result.pass, true);
    assert.deepEqual(realOut.result.evidence[0].actual[0].items, ["纯棉材质"], "第 6 层 items 元素不得被 dump 截成 […]");
    assert.deepEqual(realOut.result.evidence[0].actual[0].inputs, ["100"], "第 6 层 inputs 元素不得被 dump 截成 […]");
  } finally {
    globalThis.document = prevDoc;
    globalThis.getComputedStyle = prevStyle;
  }
  console.log("PASS 6. ADR-020/021 real page-fns.runJs code-length, document.body scopeText & depth-6 contract");
}

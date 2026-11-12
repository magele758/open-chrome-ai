import assert from "node:assert/strict";

import { extractCapsule } from "../lib/agent/trust/capsule.js";
import { completeSelectOption, pageAct, runJs } from "../lib/agent/page-fns.js";
import {
  WORKFLOW_MODEL_ID,
  buildAssertStateBatches,
  evaluateWhenPredicate,
  formatWorkflowSummary,
  interpolateParams,
  isWorkflowDirectiveText,
  normalizeCategoryPathText,
  parseWorkflowDirective,
  resolveFormProfileFromSnapshot,
  runDeterministicWorkflow,
  synthesizeAsciiTitle,
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

// ── 7. ADR-022 已保存态图片分配幂等短路 vs 新建修改态完整提交 + 瞬时错误提示捕获 ──
{
  // 7a. 已保存未改动商品（priorMutations === 0，且列级存在 "待确认" 但已有 1 张已确认卡片 + 1 张衍生推荐卡片）
  //     -> 跳过确认推荐、confirmed_cards_min_count 通过、commit_or_shortcircuit_modals 走取消短路关闭双层窗
  let openModals7a = ["编辑弹窗", "子分配弹窗"];
  const clickedTexts7a = [];
  const trace7a = [];
  const res7a = await runDeterministicWorkflow({
    rawText:
      `/workflow\n` +
      JSON.stringify({
        schemaVersion: "1.0",
        id: "idempotent-shortcircuit-7a",
        binds: {},
        forbidClickTexts: ["发布", "移除"],
        steps: [
          {
            id: "F1",
            op: "fill_input",
            params: { selector: "input#title", value: "稳定标题" },
          },
          {
            id: "I1",
            op: "ensure_pending_recommendations",
            params: {
              topmostModal: true,
              cardButtonText: "移除",
              pendingText: "待确认",
              acceptButtonText: "确认推荐",
              minConfirmedCards: 1,
              skipWhenUnmodifiedAndConfirmed: true,
            },
          },
          {
            id: "I2",
            op: "assert_state",
            params: {
              checks: [
                {
                  id: "confirmed_cards",
                  kind: "confirmed_cards_min_count",
                  topmostModal: true,
                  cardButtonText: "移除",
                  pendingText: "待确认",
                  minCount: 1,
                },
              ],
            },
          },
          {
            id: "I3",
            op: "commit_or_shortcircuit_modals",
            params: {
              confirmText: "确认提交",
              cancelText: "取消",
              singleShotKey: "commit_once",
              shortCircuitWhenUnmodified: true,
              topmostModal: true,
              cardButtonText: "移除",
              pendingText: "待确认",
              minConfirmedCards: 1,
              waitModalsCount: 0,
            },
          },
        ],
      }),
    rawTools: {
      run_js: async ({ code }) => {
        if (code.includes("input#title")) {
          return JSON.stringify({ ok: true, result: { exists: true, count: 1, value: "稳定标题" } });
        }
        if (code.includes("acceptVisible")) {
          return JSON.stringify({
            ok: true,
            result: {
              scopeFound: true,
              confirmedCount: 1,
              pendingCount: 1,
              scopeHasPendingText: true,
              confirmedCards: ["1350 × 1800 移除"],
              pendingCards: ["800 × 800 移除"],
              acceptVisible: true,
            },
          });
        }
        if (code.includes("confirmed_cards_min_count")) {
          return JSON.stringify({
            ok: true,
            result: {
              pass: true,
              checkedCount: 1,
              evidence: [
                {
                  index: 0,
                  id: "confirmed_cards",
                  kind: "confirmed_cards_min_count",
                  actual: {
                    confirmedCount: 1,
                    pendingCount: 1,
                    scopeHasPendingText: true,
                    confirmedCards: ["1350 × 1800 移除"],
                    pendingCards: ["800 × 800 移除"],
                  },
                },
              ],
            },
          });
        }
        if (code.includes("foundCancel")) {
          if (openModals7a.length === 0) return JSON.stringify({ ok: true, result: { count: 0 } });
          return JSON.stringify({
            ok: true,
            result: {
              count: openModals7a.length,
              title: openModals7a[openModals7a.length - 1],
              foundCancel: true,
              buttonText: "取消",
            },
          });
        }
        if (code.includes("removeAttribute")) {
          return JSON.stringify({ ok: true, result: true });
        }
        return JSON.stringify({ ok: true, result: openModals7a.length });
      },
      click: async ({ text, selector }) => {
        clickedTexts7a.push(text || selector);
        if (text === "取消" && openModals7a.length > 0) {
          openModals7a.pop();
        }
        return JSON.stringify({ ok: true });
      },
    },
    resolvePageSnapshot: async () => ({ tabId: 12, url: "https://portal.example.org/list", title: "List" }),
    traceSteps: trace7a,
  });
  assert.equal(res7a.ok, true, `7a 应幂等短路成功: ${JSON.stringify(res7a.failure)}`);
  assert.equal(clickedTexts7a.includes("确认推荐"), false, "未改动已保存态不得点击确认推荐");
  assert.equal(clickedTexts7a.includes("确认提交"), false, "未改动已保存态不得点击确认提交");
  assert.deepEqual(clickedTexts7a, ["取消", "取消"], "应按栈序两次点击取消关闭双层弹窗");
  assert.equal(JSON.parse(trace7a[3].resultSummary).mode, "idempotent_short_circuit");

  // 7b. 新建或字段发生修改的商品（priorMutations > 0）-> 点击确认推荐 + 点击确认提交落库
  let acceptVis7b = true;
  let openModals7b = 2;
  const clickedTexts7b = [];
  const trace7b = [];
  const res7b = await runDeterministicWorkflow({
    rawText:
      `/workflow\n` +
      JSON.stringify({
        schemaVersion: "1.0",
        id: "fresh-commit-7b",
        binds: {},
        forbidClickTexts: ["发布", "移除"],
        steps: [
          {
            id: "F1",
            op: "fill_input",
            params: { selector: "input#title", value: "新标题" },
          },
          {
            id: "I1",
            op: "ensure_pending_recommendations",
            params: {
              topmostModal: true,
              cardButtonText: "移除",
              pendingText: "待确认",
              acceptButtonText: "确认推荐",
              minConfirmedCards: 1,
              skipWhenUnmodifiedAndConfirmed: true,
            },
          },
          {
            id: "I2",
            op: "commit_or_shortcircuit_modals",
            params: {
              confirmText: "确认提交",
              cancelText: "取消",
              singleShotKey: "commit_once",
              shortCircuitWhenUnmodified: true,
              topmostModal: true,
              cardButtonText: "移除",
              pendingText: "待确认",
              minConfirmedCards: 1,
              waitModalsCount: 0,
            },
          },
        ],
      }),
    rawTools: {
      run_js: async ({ code }) => {
        if (code.includes("exists: true")) {
          return JSON.stringify({ ok: true, result: { exists: true, count: 1, value: "旧标题" } });
        }
        if (code.includes("input#title")) {
          return JSON.stringify({ ok: true, result: "新标题" });
        }
        if (code.includes("acceptVisible")) {
          return JSON.stringify({
            ok: true,
            result: {
              scopeFound: true,
              confirmedCount: acceptVis7b ? 0 : 1,
              pendingCount: acceptVis7b ? 1 : 0,
              scopeHasPendingText: acceptVis7b,
              confirmedCards: acceptVis7b ? [] : ["1350 × 1800 移除"],
              pendingCards: acceptVis7b ? ["1350 × 1800 移除"] : [],
              acceptVisible: acceptVis7b,
            },
          });
        }
        return JSON.stringify({
          ok: true,
          result: { count: openModals7b, titles: [], alerts: [], errorAlerts: [], loadingCount: 0 },
        });
      },
      fill: async () => JSON.stringify({ ok: true }),
      click: async ({ text }) => {
        clickedTexts7b.push(text);
        if (text === "确认推荐") acceptVis7b = false;
        if (text === "确认提交") openModals7b = 0;
        return JSON.stringify({ ok: true });
      },
    },
    resolvePageSnapshot: async () => ({ tabId: 13, url: "https://portal.example.org/list", title: "List" }),
    traceSteps: trace7b,
  });
  assert.equal(res7b.ok, true, `7b 应完整提交成功: ${JSON.stringify(res7b.failure)}`);
  assert.deepEqual(clickedTexts7b, ["确认推荐", "确认提交"]);
  assert.equal(JSON.parse(trace7b[2].resultSummary).mode, "committed_via_confirm");

  // 7c. 瞬时错误提示捕获：提交后弹出 3 秒即消退的错误提示且按钮结束 loading -> 立即捕获并快速失败
  let pollCount7c = 0;
  const res7c = await runDeterministicWorkflow({
    rawText:
      `/workflow\n` +
      JSON.stringify({
        schemaVersion: "1.0",
        id: "transient-toast-7c",
        binds: {},
        steps: [
          {
            id: "C1",
            op: "click_and_wait",
            params: { text: "确认提交", waitModalsCount: 0, timeoutMs: 12000 },
          },
        ],
      }),
    rawTools: {
      click: async () => JSON.stringify({ ok: true }),
      run_js: async () => {
        pollCount7c += 1;
        // 第 1 次轮询出现瞬时错误 toast，第 2 次轮询 toast 已消退但弹窗仍未关
        const hasToast = pollCount7c === 1;
        return JSON.stringify({
          ok: true,
          result: {
            count: 2,
            titles: ["父弹窗", "子弹窗"],
            alerts: hasToast ? ["1 张图片处理失败: Failed to fetch"] : [],
            errorAlerts: hasToast ? ["1 张图片处理失败: Failed to fetch"] : [],
            loadingCount: 0,
          },
        });
      },
    },
    resolvePageSnapshot: async () => ({ tabId: 14, url: "https://portal.example.org/list", title: "List" }),
  });
  assert.equal(res7c.ok, false);
  assert.equal(res7c.failure.code, "WORKFLOW_ACTION_ERROR_TOAST");
  assert.ok(
    res7c.failure.actual.includes("1 张图片处理失败: Failed to fetch"),
    `即使第 2 次轮询后提示已消退，也必须保留首次捕获到的瞬时错误文本: ${res7c.failure.actual}`,
  );
  console.log("PASS 7. ADR-022 idempotent modal short-circuit vs modified commit & transient error toast fast-fail");
}

// ── 8. ADR-023 弹窗取消离场动画（*-leave）销毁等待契约与新弹窗延迟水合轮询保护 ──
{
  // 8a. close_modals_if_present 点击取消后若旧弹窗仍处于 ant-zoom-leave 离场动画（尚未从 DOM 卸载），
  //     必须等待离场节点彻底消失后才返回；随后 ensure_cascader 遇到新弹窗内控件延迟 1 拍水合也能平滑轮询通过。
  let leavePollsRemaining = 2;
  let cascaderHydratePolls = 2;
  let cancelClicked = 0;

  const res8a = await runDeterministicWorkflow({
    rawText:
      `/workflow\n` +
      JSON.stringify({
        schemaVersion: "1.0",
        id: "leave-animation-settle-8a",
        binds: {},
        steps: [
          {
            id: "C_CLOSE",
            op: "close_modals_if_present",
            params: { modalSelector: ".ant-modal", cancelText: "取消", settleMs: 1200 },
          },
          {
            id: "C_CASC",
            op: "ensure_cascader",
            params: {
              selector: "input#cat",
              expectedText: "一级 / 二级",
              mode: "search",
              searchValue: "二级",
              timeoutMs: 3000,
            },
          },
        ],
      }),
    rawTools: {
      run_js: async ({ code }) => {
        if (code.includes("foundCancel")) {
          if (cancelClicked === 0) {
            return JSON.stringify({
              ok: true,
              result: { count: 1, title: "旧编辑弹窗", foundCancel: true, buttonText: "取消" },
            });
          }
          // 点击取消后非离场弹窗数立即归 0，但离场动画尚未结束
          return JSON.stringify({ ok: true, result: { count: 0 } });
        }
        if (code.includes("removeAttribute")) {
          return JSON.stringify({ ok: true, result: true });
        }
        if (code.includes("input#cat")) {
          if (cascaderHydratePolls > 0) {
            cascaderHydratePolls -= 1;
            return JSON.stringify({ ok: true, result: { exists: false, itemText: "" } });
          }
          return JSON.stringify({ ok: true, result: { exists: true, itemText: "一级 / 二级" } });
        }
        // 非离场轮询 vs 全量离场彻底销毁轮询
        if (code.includes("/leave/")) {
          return JSON.stringify({ ok: true, result: 0 });
        }
        if (leavePollsRemaining > 0) {
          leavePollsRemaining -= 1;
          return JSON.stringify({ ok: true, result: 1 });
        }
        return JSON.stringify({ ok: true, result: 0 });
      },
      click: async () => {
        cancelClicked += 1;
        return JSON.stringify({ ok: true });
      },
    },
    resolvePageSnapshot: async () => ({ tabId: 15, url: "https://portal.example.org/list", title: "List" }),
  });

  assert.equal(res8a.ok, true, `8a 应等待离场动画结束并容忍新控件异步水合: ${JSON.stringify(res8a.failure)}`);
  assert.equal(cancelClicked, 1, "不应向离场动画中的旧弹窗重复点击取消");
  assert.equal(leavePollsRemaining, 0, "close_modals_if_present 必须等到离场动画弹窗彻底归零才返回");
  assert.equal(cascaderHydratePolls, 0, "ensure_cascader 必须轮询等待新弹窗内部输入控件挂载完成");

  // 8b. buildAssertStateBatches 的容器作用域解析与 pageAct(wait) 均必须忽略处于 ant-zoom-leave 离场态的旧弹窗
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevStyle = globalThis.getComputedStyle;
  try {
    const leavingModal = {
      nodeType: 1,
      tagName: "DIV",
      id: "",
      hidden: false,
      className: "ant-modal editor-dialog-modal ant-zoom-leave ant-zoom-leave-active",
      classList: { contains: () => false },
      parentElement: null,
      innerText: "旧弹窗标题",
      textContent: "旧弹窗标题",
      getAttribute: () => null,
      getBoundingClientRect: () => ({ left: 10, top: 10, right: 500, bottom: 400, width: 490, height: 390 }),
      querySelector: () => null,
      querySelectorAll: () => [{ textContent: "旧脏数据" }],
    };
    let mountFresh = false;
    const freshModal = {
      nodeType: 1,
      tagName: "DIV",
      id: "",
      hidden: false,
      className: "ant-modal editor-dialog-modal",
      classList: { contains: () => false },
      parentElement: null,
      innerText: "新弹窗标题",
      textContent: "新弹窗标题",
      getAttribute: () => null,
      getBoundingClientRect: () => ({ left: 10, top: 10, right: 500, bottom: 400, width: 490, height: 390 }),
      querySelector: () => null,
      querySelectorAll: (sel) =>
        sel === ".ant-select-selection-item"
          ? [{ querySelector: () => null, textContent: "新挂载选项" }]
          : [],
    };
    const fakeStyle = () => ({ display: "block", visibility: "visible", opacity: "0.4", zIndex: "1000" });
    globalThis.getComputedStyle = fakeStyle;
    globalThis.window = {
      getComputedStyle: fakeStyle,
      innerHeight: 900,
      innerWidth: 1440,
    };
    globalThis.document = {
      documentElement: { clientHeight: 900, clientWidth: 1440 },
      body: { innerText: "" },
      querySelector: (sel) => (sel === ".editor-dialog-modal" ? leavingModal : null),
      querySelectorAll: (sel) => {
        if (sel.includes("editor-dialog-modal")) {
          return mountFresh ? [leavingModal, freshModal] : [leavingModal];
        }
        return [];
      },
    };

    // 旧弹窗处于 ant-zoom-leave 时，assert_state 容器解析必须判定“容器不存在或正处于关闭离场动画”
    const scopeBatch = buildAssertStateBatches(".editor-dialog-modal", [
      { id: "s_items", kind: "select_items_include", mustInclude: ["新挂载选项"] },
    ]);
    const staleAssert = await runJs(scopeBatch[0].code);
    assert.equal(staleAssert.result.pass, false, "不得读取正处于 ant-zoom-leave 离场动画的旧弹窗数据");

    // pageAct("wait") 同样不得立即误命中 ant-zoom-leave 旧弹窗，而应等到 180ms 后新弹窗挂载才返回
    setTimeout(() => {
      mountFresh = true;
    }, 180);
    const waitOut = await pageAct("wait", {
      selector: ".editor-dialog-modal",
      text: "弹窗标题",
      timeoutMs: 1500,
    });
    assert.equal(waitOut.ok, true, `pageAct wait 应在新弹窗挂载后成功: ${JSON.stringify(waitOut)}`);
    assert.ok(waitOut.waitedMs >= 140, `pageAct wait 不得 0ms 误命中离场旧弹窗，实测 waitedMs=${waitOut.waitedMs}`);

    const freshAssert = await runJs(scopeBatch[0].code);
    assert.equal(freshAssert.result.pass, true, `新弹窗挂载后应读取新弹窗数据: ${JSON.stringify(freshAssert.result)}`);
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.getComputedStyle = prevStyle;
  }
  console.log("PASS 8. ADR-023 modal leave-transition teardown settle, active scope & delayed input hydration");
}

// ── 9. ADR-024 连续下拉选择浮层归属隔离（aria-controls + *-leave 过滤）与弹窗实体动态单选组匹配 ──
{
  // 9a. completeSelectOption: 前序下拉框浮层仍处于 ant-slide-up-leave 关闭动画且归属前序控件 aria-controls 时，
  //     后序下拉框不得误抓前序浮层，必须轮询等待自身 aria-controls 浮层挂载并选中目标项。
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevStyle = globalThis.getComputedStyle;
  const prevMouse = globalThis.MouseEvent;
  try {
    if (typeof globalThis.MouseEvent !== "function") {
      globalThis.MouseEvent = class FakeMouseEvent extends Event {
        constructor(type, init = {}) {
          super(type, init);
          this.clientX = init.clientX || 0;
          this.clientY = init.clientY || 0;
        }
      };
    }
    const fakeStyle = () => ({ display: "block", visibility: "visible", opacity: "0.75", zIndex: "1050" });
    globalThis.getComputedStyle = fakeStyle;
    globalThis.window = { getComputedStyle: fakeStyle, innerWidth: 1440, innerHeight: 900 };

    let selectedValue = "";
    let ownPopupMounted = false;

    const makeOption = (label, onPick) => ({
      nodeType: 1,
      tagName: "DIV",
      id: "",
      className: "ant-select-item ant-select-item-option",
      textContent: label,
      getAttribute: (k) => (k === "title" ? label : null),
      querySelector: (sel) => (sel === ".ant-select-item-option-content" ? { textContent: label } : null),
      getBoundingClientRect: () => ({ x: 100, y: 120, left: 100, top: 120, width: 80, height: 28 }),
      scrollIntoView: () => {},
      dispatchEvent: () => true,
      click: () => onPick?.(label),
    });

    const foreignList = { id: "rc_select_0_list", nodeType: 1 };
    const foreignPopup = {
      nodeType: 1,
      id: "",
      hidden: false,
      parentElement: null,
      className: "ant-select-dropdown ant-slide-up-leave ant-slide-up-leave-active",
      classList: { contains: (c) => c === "ant-slide-up-leave" },
      getBoundingClientRect: () => ({ x: 40, y: 100, left: 40, top: 100, width: 120, height: 96 }),
      querySelectorAll: (sel) => {
        if (sel === "[id]") return [foreignList];
        return [makeOption("模式A"), makeOption("模式B"), makeOption("模式C")];
      },
      querySelector: () => null,
    };
    foreignList.closest = () => foreignPopup;

    const ownList = { id: "rc_select_1_list", nodeType: 1 };
    const ownPopup = {
      nodeType: 1,
      id: "",
      hidden: false,
      parentElement: null,
      className: "ant-select-dropdown",
      classList: { contains: () => false },
      getBoundingClientRect: () => ({ x: 180, y: 100, left: 180, top: 100, width: 90, height: 88 }),
      querySelectorAll: (sel) => {
        if (sel === "[id]") return [ownList];
        return [
          makeOption("单位甲", (v) => {
            selectedValue = v;
          }),
          makeOption("单位乙", (v) => {
            selectedValue = v;
          }),
        ];
      },
      querySelector: () => null,
    };
    ownList.closest = () => ownPopup;

    const foreignInput = {
      nodeType: 1,
      getAttribute: (k) => (k === "aria-controls" || k === "aria-owns" ? "rc_select_0_list" : null),
    };
    const ownInput = {
      nodeType: 1,
      disabled: false,
      readOnly: true,
      value: "",
      getAttribute: (k) => {
        if (k === "aria-controls" || k === "aria-owns") return "rc_select_1_list";
        if (k === "aria-expanded") return ownPopupMounted ? "true" : "false";
        return null;
      },
      blur: () => {},
    };
    const combo1 = {
      nodeType: 1,
      isConnected: true,
      className: "ant-select ant-select-open",
      classList: {
        contains: (c) => c === "ant-select" || (c === "ant-select-open" && !selectedValue),
      },
      getAttribute: (k) => (k === "data-pl-select-dialog" ? "0" : null),
      removeAttribute: () => {},
      contains: (n) => n === ownInput,
      closest: () => null,
      querySelector: (sel) => {
        if (sel.includes("aria-controls") || sel.includes("search") || sel === "input") return ownInput;
        return null;
      },
      querySelectorAll: (sel) => {
        if (sel.includes("ant-select-selection-item") && selectedValue) {
          return [
            {
              getAttribute: (k) => (k === "title" ? selectedValue : null),
              cloneNode: () => ({ querySelectorAll: () => [], textContent: selectedValue }),
            },
          ];
        }
        return [];
      },
    };

    globalThis.document = {
      body: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }), dispatchEvent: () => true },
      documentElement: { clientWidth: 1440, clientHeight: 900 },
      getElementById: (id) => {
        if (id === "rc_select_0_list") return foreignList;
        if (id === "rc_select_1_list") return ownPopupMounted ? ownList : null;
        return null;
      },
      querySelector: (sel) => (sel.includes("uid_unit_1") ? combo1 : null),
      querySelectorAll: (sel) => {
        if (sel.includes("aria-controls")) return [foreignInput, ownInput];
        if (sel.includes("ant-select-dropdown")) return ownPopupMounted ? [foreignPopup, ownPopup] : [foreignPopup];
        return [];
      },
    };

    setTimeout(() => {
      ownPopupMounted = true;
    }, 110);

    const selRes = await completeSelectOption({
      uid: "uid_unit_1",
      value: "单位甲",
      stage: "select",
      allowCdpFallback: false,
    });
    assert.equal(selRes.ok, true, `9a 应忽略前序离场/异主浮层并等待当前下拉浮层挂载: ${JSON.stringify(selRes)}`);
    assert.deepEqual(selRes.selected, ["单位甲"]);
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.getComputedStyle = prevStyle;
    globalThis.MouseEvent = prevMouse;
  }

  // 9b. ensure_modal_entity: 支持动态单选组候选优先匹配（prefer + verifyPrefix + alreadyBoundRegex）
  let boundState = "";
  const clickedTexts = [];
  const trace9b = [];
  const res9b = await runDeterministicWorkflow({
    rawText:
      `/workflow\n` +
      JSON.stringify({
        schemaVersion: "1.0",
        id: "entity-dynamic-radio-9b",
        binds: {},
        steps: [
          {
            id: "E_BIND",
            op: "ensure_modal_entity",
            params: {
              selectedSelector: ".entity-summary",
              alreadyBoundTexts: ["实体记录", "示例档案", "感受:适中"],
              alreadyBoundRegex: "规格:\\S+",
              openButtonText: "添加档案",
              rowMustInclude: ["示例档案"],
              rowActionText: "使用",
              optionClicks: [
                {
                  radioGroupIndex: 0,
                  prefer: ["标准S", "通码One-size"],
                  verifyPrefix: "规格:",
                },
                "适中",
              ],
              confirmText: "确认",
            },
          },
        ],
      }),
    rawTools: {
      run_js: async ({ code }) => {
        if (code.includes(".entity-summary")) {
          return JSON.stringify({ ok: true, result: boundState });
        }
        if (code.includes("tbody tr")) {
          return JSON.stringify({ ok: true, result: { found: true, rowText: "示例档案 使用" } });
        }
        if (code.includes("radiogroup")) {
          return JSON.stringify({
            ok: true,
            result: { found: true, chosenText: "通码One-size", available: ["通码One-size"] },
          });
        }
        if (code.includes("removeAttribute")) {
          return JSON.stringify({ ok: true, result: true });
        }
        return JSON.stringify({ ok: true, result: true });
      },
      wait_for: async () => JSON.stringify({ ok: true }),
      click: async ({ text, selector }) => {
        clickedTexts.push(text || selector);
        if (text === "确认") {
          boundState = "实体记录 示例档案 规格:通码One-size 感受:适中";
        }
        return JSON.stringify({ ok: true });
      },
    },
    resolvePageSnapshot: async () => ({ tabId: 16, url: "https://portal.example.org/list", title: "List" }),
    traceSteps: trace9b,
  });
  assert.equal(res9b.ok, true, `9b 动态单选组匹配应成功: ${JSON.stringify(res9b.failure)}`);
  const out9b = JSON.parse(trace9b[0].resultSummary);
  assert.deepEqual(out9b.selectedOptions, ["通码One-size", "适中"]);
  console.log("PASS 9. ADR-024 select popup ownership isolation (*-leave + aria-controls) & modal dynamic radio matching");
}

// ── 10. ADR-025 嵌套弹窗实体异步列表水合轮询、栈顶作用域隔离与子弹窗离场销毁契约 ──
{
  // 10a. 外层弹窗（modalsBeforeCount=1）自身已含“使用/适中”字样；点击打开子弹窗后先经历未挂载（poll 1）与空表占位“暂无档案”（poll 2–3），
  //      第 4 拍异步列表返回目标行；点击确认后还须等待子弹窗离场动画（allModalCount 从 2 降回 1）才放行。
  let rowPoll = 0;
  let postConfirmPoll = 0;
  let boundText10a = "";
  const clickedMarks10a = [];

  const res10a = await runDeterministicWorkflow({
    rawText:
      `/workflow\n` +
      JSON.stringify({
        schemaVersion: "1.0",
        id: "nested-entity-async-hydration-10a",
        binds: {},
        steps: [
          {
            id: "E_ASYNC",
            op: "ensure_modal_entity",
            params: {
              selectedSelector: ".outer-dialog",
              alreadyBoundTexts: ["已绑档案", "档案甲", "感受:适中"],
              alreadyBoundRegex: "规格:\\S+",
              openButtonText: "选择档案",
              rowMustInclude: ["档案甲"],
              rowActionText: "使用",
              optionClicks: [
                { radioGroupIndex: 0, prefer: ["均码One"], verifyPrefix: "规格:" },
                "适中",
              ],
              confirmText: "确认",
              timeoutMs: 3000,
            },
          },
        ],
      }),
    rawTools: {
      run_js: async ({ code }) => {
        if (code.includes("entity_pre_modal_count")) {
          return JSON.stringify({ ok: true, result: { modalCountBefore: 1 } });
        }
        if (code.includes("entity_post_confirm_settle")) {
          postConfirmPoll += 1;
          // 第 1 拍子弹窗仍处于 ant-zoom-leave 离场态（allModalCount=2），第 2 拍彻底卸载回到 1
          return JSON.stringify({
            ok: true,
            result: { boundText: boundText10a, allModalCount: postConfirmPoll < 2 ? 2 : 1 },
          });
        }
        if (code.includes(".outer-dialog")) {
          return JSON.stringify({ ok: true, result: "外层说明：建议使用高清素材" });
        }
        if (code.includes("emptyPlaceholderOnly")) {
          rowPoll += 1;
          if (rowPoll === 1) {
            return JSON.stringify({
              ok: true,
              result: { found: false, newModalMounted: false, modalCount: 1, modalsBeforeCount: 1 },
            });
          }
          if (rowPoll <= 3) {
            return JSON.stringify({
              ok: true,
              result: { found: false, newModalMounted: true, spinning: false, emptyPlaceholderOnly: true, rows: ["暂无档案"] },
            });
          }
          return JSON.stringify({
            ok: true,
            result: { found: true, newModalMounted: true, rowText: "档案甲 175 使用" },
          });
        }
        if (code.includes("radiogroup")) {
          return JSON.stringify({
            ok: true,
            result: { found: true, chosenText: "均码One", available: ["均码One"] },
          });
        }
        if (code.includes("entity_str_option_probe")) {
          return JSON.stringify({ ok: true, result: { found: true, matchedText: "适中" } });
        }
        if (code.includes("entity_confirm_probe")) {
          return JSON.stringify({ ok: true, result: { found: true, matchedText: "确 认" } });
        }
        return JSON.stringify({ ok: true, result: true });
      },
      click: async ({ text, selector }) => {
        clickedMarks10a.push(selector || text);
        if (selector && clickedMarks10a.length >= 5) {
          boundText10a = "已绑档案 档案甲 规格:均码One 感受:适中";
        }
        return JSON.stringify({ ok: true });
      },
    },
    resolvePageSnapshot: async () => ({ tabId: 17, url: "https://portal.example.org/list", title: "List" }),
  });

  assert.equal(res10a.ok, true, `10a 应轮询越过“暂无档案”短暂空态并完成绑定: ${JSON.stringify(res10a.failure)}`);
  assert.equal(rowPoll, 4, "必须持续轮询直到子弹窗挂载且异步列表行水合完成");
  assert.ok(postConfirmPoll >= 2, "点击确认后必须等到子弹窗离场动画彻底卸载（allModalCount<=1）才返回");

  // 10b. 子弹窗超时未挂载或持续转圈时，必须归因「工具」（WORKFLOW_ENTITY_MODAL_WAIT_TIMEOUT），不得误判「workflow」
  const res10b = await runDeterministicWorkflow({
    rawText:
      `/workflow\n` +
      JSON.stringify({
        schemaVersion: "1.0",
        id: "nested-entity-mount-timeout-10b",
        binds: {},
        steps: [
          {
            id: "E_TIMEOUT",
            op: "ensure_modal_entity",
            params: {
              selectedSelector: ".outer-dialog",
              alreadyBoundTexts: ["已绑档案", "档案甲"],
              openButtonText: "选择档案",
              rowMustInclude: ["档案甲"],
              rowActionText: "使用",
              timeoutMs: 1000,
            },
          },
        ],
      }),
    rawTools: {
      run_js: async ({ code }) => {
        if (code.includes("entity_pre_modal_count")) {
          return JSON.stringify({ ok: true, result: { modalCountBefore: 1 } });
        }
        if (code.includes(".outer-dialog")) {
          return JSON.stringify({ ok: true, result: "" });
        }
        return JSON.stringify({
          ok: true,
          result: { found: false, newModalMounted: true, spinning: true, rows: ["暂无档案"] },
        });
      },
      click: async () => JSON.stringify({ ok: true }),
    },
    resolvePageSnapshot: async () => ({ tabId: 18, url: "https://portal.example.org/list", title: "List" }),
  });

  assert.equal(res10b.ok, false);
  assert.equal(res10b.failure.code, "WORKFLOW_ENTITY_MODAL_WAIT_TIMEOUT");
  assert.equal(res10b.failure.blame, "工具", "异步列表持续 loading 超时应归属工具而非误判主档缺失");
  console.log("PASS 10. ADR-025 nested entity modal async table hydration, top-modal scoping & close settle");
}

// ── 11. ADR-026 通用三层工作流原语：起点自愈、双模式选行、未配置类目即停与双态提交闭环 ──
{
  // 11a-1. 非目标域名只读报错，严禁跨站跳转
  const res11WrongOrigin = await runDeterministicWorkflow({
    rawText:
      `/workflow\n` +
      JSON.stringify({
        schemaVersion: "1.0",
        id: "generic-entry-wrong-origin-11a",
        binds: {},
        steps: [
          {
            id: "W1.entry",
            op: "ensure_page_entry",
            params: {
              mustStartWith: "https://portal.example.org/workspace/",
              targetHashQueryEquals: { view: "tools", menu: "inboxBox" },
            },
          },
        ],
      }),
    rawTools: {
      run_js: async () =>
        JSON.stringify({
          ok: true,
          result: {
            url: "https://other.example.net/dashboard",
            title: "Other",
            queryMap: {},
            hasPasswordInput: false,
            readyFound: false,
            spinning: false,
            bodySample: "Other dashboard",
          },
        }),
    },
    resolvePageSnapshot: async () => ({ tabId: 21, url: "https://other.example.net/dashboard", title: "Other" }),
  });
  assert.equal(res11WrongOrigin.ok, false);
  assert.equal(res11WrongOrigin.failure.code, "WORKFLOW_ENTRY_WRONG_ORIGIN");
  assert.ok(res11WrongOrigin.failure.actual.includes("other.example.net"));

  // 11a-2. 页内从落地页 -> 展开侧边栏 -> 作用域分组导航进入目标列表页 + 快照顶部统计计数（单段代码 < 8000 字符）
  let navStage = 0;
  const entryJsLengths = [];
  const res11EntryNav = await runDeterministicWorkflow({
    rawText:
      `/workflow\n` +
      JSON.stringify({
        schemaVersion: "1.0",
        id: "generic-entry-self-heal-11a",
        binds: {},
        steps: [
          {
            id: "W1.entry",
            op: "ensure_page_entry",
            params: {
              mustStartWith: "https://portal.example.org/workspace/",
              targetHashQueryEquals: { view: "tools", menu: "inboxBox" },
              readySelector: ".ant-table-tbody",
              captureHeaderRegex: "全部\\s*\\d+\\s*未发布\\s*\\d+\\s*发布中\\s*\\d+\\s*已发布\\s*\\d+",
              checkSampleSubstrings: ["2026-11-11 15:05:51", "户外水龙头"],
              navSteps: [
                { kind: "click_if_visible", selector: "button.landing-cta", text: "进入工作台", waitMs: 20 },
                { kind: "click_if_visible", selector: "button[aria-label='展开侧边栏']", waitMs: 20 },
                {
                  kind: "scoped_menu_click",
                  rootSelector: ".side-menu",
                  groupSelector: ".platform-group",
                  headingSelector: "button.platform-heading",
                  headingMustInclude: "channela半托管",
                  headingExclude: "channelb",
                  subItemSelector: ".subnav-item",
                  itemText: "待发箱",
                },
              ],
            },
          },
          {
            id: "W1.verify_header",
            op: "assert_state",
            params: {
              checks: [
                {
                  id: "hdr",
                  kind: "text_matches_regex",
                  pattern: "{{runtime.headerCountsPattern}}",
                },
              ],
            },
          },
        ],
      }),
    rawTools: {
      run_js: async ({ code }) => {
        entryJsLengths.push(code.length);
        assert.ok(code.length < 8000, `run_js 片段超长: ${code.length}`);
        if (code.includes("ensure_page_entry_probe")) {
          if (navStage < 3) {
            return JSON.stringify({
              ok: true,
              result: {
                url: "https://portal.example.org/workspace/#/app?view=landing",
                title: "Portal",
                queryMap: { view: navStage === 0 ? "landing" : "tools", menu: "market" },
                hasPasswordInput: false,
                readyFound: false,
                spinning: false,
                bodySample: "Landing",
              },
            });
          }
          return JSON.stringify({
            ok: true,
            result: {
              url: "https://portal.example.org/workspace/#/app?view=tools&menu=inboxBox",
              title: "Portal",
              queryMap: { view: "tools", menu: "inboxBox" },
              hasPasswordInput: false,
              readyFound: true,
              spinning: false,
              bodySample: "全部 28 未发布 27 发布中 0 已发布 1",
            },
          });
        }
        if (code.includes("landing-cta")) {
          navStage = 1;
          return JSON.stringify({ ok: true, result: { found: true, text: "进入工作台" } });
        }
        if (code.includes("展开侧边栏")) {
          navStage = 2;
          return JSON.stringify({ ok: true, result: { found: true, text: "" } });
        }
        if (code.includes("scoped_menu_probe")) {
          return JSON.stringify({
            ok: true,
            result: { rootFound: true, groupFound: true, itemReady: false, canExpandHeading: true, headingText: "ChannelA channela半托管" },
          });
        }
        if (code.includes("menusub_")) {
          navStage = 3;
          return JSON.stringify({ ok: true, result: { found: true } });
        }
        if (code.includes("wantCancel")) {
          return JSON.stringify({ ok: true, result: { count: 0 } });
        }
        if (code.includes(".ant-modal")) {
          return JSON.stringify({ ok: true, result: 0 });
        }
        if (code.includes("sampleVisible")) {
          return JSON.stringify({
            ok: true,
            result: { headerMatch: "全部 28 未发布 27 发布中 0 已发布 1", sampleVisible: true },
          });
        }
        if (code.includes("pass: true")) {
          return JSON.stringify({ ok: true, result: { pass: true, evidence: [{ id: "hdr", actual: "matched" }] } });
        }
        return JSON.stringify({ ok: true, result: true });
      },
      click: async () => JSON.stringify({ ok: true }),
    },
    resolvePageSnapshot: async () => ({
      tabId: 22,
      url: "https://portal.example.org/workspace/#/app?view=tools&menu=inboxBox",
      title: "Portal",
    }),
  });
  assert.equal(res11EntryNav.ok, true, `11a-2 应完成页内自愈导航: ${JSON.stringify(res11EntryNav.failure)}`);
  assert.equal(res11EntryNav.runtime.manualSampleVisibleOnPage, true);
  assert.ok(res11EntryNav.runtime.headerCountsPattern.includes("28"));

  // 11b. 双模式选行：禁触样本显式拦截 + 默认挑下一件未编辑（自动跳过禁触样本、缺货源价异常行与已保存行）
  const res11ForbidRow = await runDeterministicWorkflow({
    rawText:
      `/workflow\n` +
      JSON.stringify({
        schemaVersion: "1.0",
        id: "generic-row-forbid-11b",
        binds: { claimedAt: "2026-11-11 15:05:51" },
        steps: [
          {
            id: "W1.open",
            op: "select_row_and_open",
            params: {
              targetClaimedAt: "{{claimedAt}}",
              excludeSubstrings: ["2026-11-11 15:05:51", "601103373964438"],
            },
          },
        ],
      }),
    rawTools: {
      run_js: async () => JSON.stringify({ ok: true, result: true }),
    },
    resolvePageSnapshot: async () => ({ tabId: 23, url: "https://portal.example.org/list", title: "List" }),
  });
  assert.equal(res11ForbidRow.ok, false);
  assert.equal(res11ForbidRow.failure.code, "WORKFLOW_FORBIDDEN_ROW");

  // 11c. 类目映射解析、中英标题去噪合成、以及未配置类目即停并输出页面实读带*字段清单
  assert.equal(normalizeCategoryPathText("女装->女士毛衣 -> 女装针织衫开衫"), "女装 / 女士毛衣 / 女装针织衫开衫");
  const catMapFixture = {
    马甲: {
      matchKeywords: ["马甲", "背心"],
      categorySearch: "毛衣",
      categoryPath: "服饰 / 女装 / 女装针织衫开衫",
      enPrefix: "Women's",
      enSuffix: "Cardigan Sweater Vest",
      pkgLength: "30",
      pkgWidth: "24",
      pkgHeight: "5",
      pkgWeight: "320",
      requiresSizeChart: true,
      sizeChartName: "女士外套",
      requiresModel: true,
      modelName: "model_alpha",
      modelFitOption: "合身",
      attrRules: [{ kind: "select", label: "图案", value: "纯色" }],
    },
    外套: {
      matchKeywords: ["外套", "大衣"],
      categorySearch: "毛衣",
      categoryPath: "服饰 / 女装 / 女装针织衫开衫",
      enPrefix: "Women's",
      enSuffix: "Long Coat Outerwear",
      pkgLength: "38",
      pkgWidth: "30",
      pkgHeight: "8",
      pkgWeight: "650",
      requiresSizeChart: true,
      sizeChartName: "女士外套",
      requiresModel: true,
      modelName: "model_alpha",
      modelFitOption: "合身",
      attrRules: [{ kind: "select", label: "图案", value: "纯色" }],
    },
    针织衫: {
      matchKeywords: ["针织衫", "毛衣", "开衫"],
      categorySearch: "毛衣",
      categoryPath: "服饰 / 女装 / 女装针织衫开衫",
      enPrefix: "Women's",
      enSuffix: "Knit Pullover Sweater",
      pkgLength: "32",
      pkgWidth: "25",
      pkgHeight: "4",
      pkgWeight: "350",
      requiresSizeChart: true,
      sizeChartName: "女士外套",
      requiresModel: true,
      modelName: "model_alpha",
      modelFitOption: "合身",
      attrRules: [{ kind: "select", label: "图案", value: "条纹" }],
    },
  };
  const dictFixture = [
    ["白色", "White"],
    ["毛绒", "Soft Fleece"],
    ["单排扣", "Single-Breasted"],
    ["灯芯绒", "Corduroy"],
    ["加厚", "Thickened"],
  ];

  const vestProfile = resolveFormProfileFromSnapshot({
    snapshot: {
      currentCategory: "",
      titleCnRaw: "aaaaaa春秋白色毛绒马甲单排扣背心毛衣bbbbb",
      titleEnRaw: "",
      starredLabels: ["*成分", "*材质"],
    },
    categoryMap: catMapFixture,
    categoryOrder: ["马甲", "外套", "针织衫"],
    enKeywordDictionary: dictFixture,
    forbidTitleSubstrings: ["测试"],
  });
  assert.equal(vestProfile.categoryKey, "马甲");
  assert.equal(vestProfile.titleCn, "春秋白色毛绒马甲单排扣背心毛衣");
  assert.ok(/^[\x20-\x7E]+$/.test(vestProfile.titleEn) && vestProfile.titleEn.includes("Vest"));
  assert.ok(!/test/i.test(vestProfile.titleEn));

  const preservedEn = synthesizeAsciiTitle({
    rawCnTitle: "高领条纹针织衫",
    existingEnTitle: "Women's Striped Mock Neck Knit Sweater",
    dictionary: dictFixture,
    prefix: "Women's",
    suffix: "Sweater",
  });
  assert.equal(preservedEn, "Women's Striped Mock Neck Knit Sweater", "已保存的干净英文标题应原样保留以保证 0 变更幂等");

  assert.throws(
    () =>
      resolveFormProfileFromSnapshot({
        snapshot: {
          currentCategory: "家居厨房 / 卫浴用品 / 浴帘",
          titleCnRaw: "aaaaaa防水加厚浴室挂帘bbbbb",
          titleEnRaw: "",
          starredLabels: ["*材质", "*尺寸规格", "*防水等级"],
        },
        categoryMap: catMapFixture,
        categoryOrder: ["马甲", "外套", "针织衫"],
      }),
    (err) => {
      assert.equal(err.code, "WORKFLOW_CATEGORY_UNMAPPED");
      assert.ok(err.actual.includes("家居厨房 / 卫浴用品 / 浴帘"), "必须指明缺哪个类目配置");
      assert.ok(err.actual.includes("*材质、*尺寸规格、*防水等级"), "必须输出页面实读带*字段清单");
      return true;
    },
  );

  // 11d. 双状态闭环：已保存商品 0 变更走 idempotent_short_circuit 且跳过 W10 重开；未编辑商品走真实提交并执行 W10 重开
  const makeDualStateDirective = (savedMode) => ({
    schemaVersion: "1.0",
    id: savedMode ? "dual-saved-11d" : "dual-unedited-11d",
    binds: {},
    steps: [
      {
        id: "W6.attrs",
        op: "ensure_attr_fields",
        params: {
          preserveExisting: true,
          saveExpectedBindKey: "expectedAttrs",
          requireAllStarredFilled: false,
          rules: [
            { kind: "select", label: "图案", value: "纯色" },
          ],
        },
      },
      {
        id: "W8.model",
        op: "ensure_modal_entity",
        params: {
          selectedSelector: ".outer-dialog",
          alreadyBoundTexts: ["模特信息", "model_alpha", "感受:合身"],
          alreadyBoundRegex: "尺码:\\S+",
          saveVerifyBindKey: "modelVerifyTexts",
          openButtonText: "添加模特",
          rowMustInclude: ["model_alpha"],
          rowActionText: "使用",
        },
      },
      {
        id: "W9.commit",
        op: "commit_or_shortcircuit_modals",
        params: {
          confirmText: "确认分配",
          cancelText: "取消",
          singleShotKey: "save_once",
          shortCircuitWhenUnmodified: true,
          topmostModal: true,
          cardButtonText: "移除",
          pendingText: "待确认",
          minConfirmedCards: 1,
          waitModalsCount: 0,
        },
      },
      {
        id: "W10.reopen_only_when_modified",
        op: "assert_state",
        when: "runtime.wasModified",
        params: {
          checks: [
            { id: "model_verify", kind: "text_includes", mustInclude: "{{runtime.modelVerifyTexts}}" },
          ],
        },
      },
    ],
  });

  const resSaved = await runDeterministicWorkflow({
    rawText: `/workflow\n${JSON.stringify(makeDualStateDirective(true))}`,
    rawTools: {
      run_js: async ({ code }) => {
        if (code.includes("cleanLbl")) {
          return JSON.stringify({ ok: true, result: ["条纹"] });
        }
        if (code.includes(".outer-dialog")) {
          return JSON.stringify({ ok: true, result: "模特信息 model_alpha 尺码:M 感受:合身" });
        }
        if (code.includes("confirmedCount")) {
          return JSON.stringify({ ok: true, result: { scopeFound: true, confirmedCount: 1, pendingCount: 0 } });
        }
        if (code.includes("wantCancel")) {
          return JSON.stringify({ ok: true, result: { count: 0 } });
        }
        if (code.includes(".ant-modal")) {
          return JSON.stringify({ ok: true, result: 0 });
        }
        return JSON.stringify({ ok: true, result: true });
      },
      click: async () => JSON.stringify({ ok: true }),
    },
    resolvePageSnapshot: async () => ({ tabId: 24, url: "https://portal.example.org/list", title: "List" }),
  });
  assert.equal(resSaved.ok, true);
  assert.equal(resSaved.mutationsCount, 0, "已保存商品必须保持 0 变更");
  assert.equal(resSaved.commitMode, "idempotent_short_circuit", "0 变更商品必须走幂等短路关闭");
  assert.equal(resSaved.skippedSteps, 1, "未发生修改时应自动跳过 W10 重开回读步骤");
  assert.deepEqual(resSaved.runtime.expectedAttrs, [{ labelIncludes: "图案", items: ["条纹"] }]);
  assert.deepEqual(resSaved.runtime.modelVerifyTexts, ["模特信息", "model_alpha", "感受:合身", "尺码:M"]);
  const savedSummary = formatWorkflowSummary({ ...resSaved, targetSummary: "针织衫 · 初始已保存" });
  assert.ok(savedSummary.includes("已保存态核对+幂等跳过") && savedSummary.includes("写入变更 0 项"));

  let uneditedModalClosed = false;
  const resUnedited = await runDeterministicWorkflow({
    rawText: `/workflow\n${JSON.stringify(makeDualStateDirective(false))}`,
    rawTools: {
      run_js: async ({ code }) => {
        if (code.includes("cleanLbl")) {
          return JSON.stringify({ ok: true, result: [] });
        }
        if (code.includes(".outer-dialog") && !uneditedModalClosed) {
          return JSON.stringify({ ok: true, result: "模特信息 model_alpha 尺码:S 感受:合身" });
        }
        if (code.includes("noticeNodes")) {
          return JSON.stringify({ ok: true, result: { count: 0, titles: [], alerts: [], errorAlerts: [], loadingCount: 0 } });
        }
        if (code.includes(".ant-modal")) {
          return JSON.stringify({ ok: true, result: 0 });
        }
        if (code.includes("pass: true")) {
          return JSON.stringify({ ok: true, result: { pass: true, evidence: [{ id: "model_verify", actual: "ok" }] } });
        }
        return JSON.stringify({ ok: true, result: true });
      },
      select_option: async ({ value }) => JSON.stringify({ ok: true, alreadySelected: false, selected: value }),
      click: async ({ text }) => {
        if (text === "确认分配") uneditedModalClosed = true;
        return JSON.stringify({ ok: true });
      },
    },
    resolvePageSnapshot: async () => ({ tabId: 25, url: "https://portal.example.org/list", title: "List" }),
  });
  assert.equal(resUnedited.ok, true, `未编辑商品闭环应通过: ${JSON.stringify(resUnedited.failure)}`);
  assert.equal(resUnedited.mutationsCount, 1);
  assert.equal(resUnedited.commitMode, "committed_via_confirm");
  assert.equal(resUnedited.skippedSteps, 0, "发生修改真实保存后必须执行 W10 重开回读校验");
  const uneditedSummary = formatWorkflowSummary({ ...resUnedited, targetSummary: "马甲 · 初始未编辑" });
  assert.ok(uneditedSummary.includes("首次填写+真实保存+回读校验") && uneditedSummary.includes("首次填写/核对耗时:"));

  console.log("PASS 11. ADR-026 generic 3-layer primitives: entry self-heal, dual row picker, unmapped fast-fail & dual-state commit");
}

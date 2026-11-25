import assert from "node:assert/strict";
import { createApprovalQueue, memoryAdapter } from "../lib/agent/trust/approval-queue.js";
import { createTokenRecord } from "../lib/bridge/auth.js";
import { createBridge } from "../lib/bridge/index.js";
import { createFlowTools, flowBridgeCall } from "../lib/bridge/tools-flow.js";

const origin = "https://seller.shopee.cn";
const url = origin + "/portal/mtsku/new?cnsc_shop_id=123";
const input = { shopId: "123", title: "试验 A5 笔记本", description: "示例", category: "文具 > 笔记本", price: "12.9", quantity: "3", weight: "0.2" };

async function setup({ scopes = ["page:read", "page:act", "upload"], origins = [origin], beforeRead, dialog, sizeChartState } = {}) {
  const token = await createTokenRecord({ name: "测试", scopes, origins });
  const approvals = createApprovalQueue({ storage: memoryAdapter() });
  const results = [];
  const fills = [];
  const files = [];
  const scans = [];
  const tab = { id: 7, url };
  const state = {
    url, modal: null, validation: [], category: input.category, categoryReady: true,
    attributes: [], options: [], optionSearch: null,
    fields: Object.fromEntries(["title", "description", "price", "quantity", "weight"].map((key) => [key, { selector: "#" + key, value: "" }])),
    image: { count: 0, cover: false, readyCount: 0, coverReady: false, selector: "#cover" },
    variant: { enable: null, apply: null, options: [], rows: [] },
  };
  const bridge = createBridge({
    approvals,
    getSettings: async () => ({ agentBridgeEnabled: true, agentBridgeOrigins: [origin] }),
    getAgentTokens: async () => [token.record],
    tabs: { get: async (id) => id === tab.id ? { ...tab } : null, query: async () => [{ ...tab }] },
    inject: async (id, fn, args) => {
      assert.equal(id, tab.id);
      if (fn.name === "readPage") {
        scans.push(args);
        await beforeRead?.(tab);
        return structuredClone(state);
      }
      if (fn.name === "queryDom") return [{ tag: "input", type: args[0] === "#cover" ? "file" : "text" }];
      if (fn.name === "plSetInputValue") {
        const { selector, value } = args[0];
        fills.push(selector);
        state.fields[selector.slice(1)].value = value;
        return { ok: true, matches: true, value };
      }
      if (fn.name === "plWaitFor") return { ok: true };
      if (fn.name === "operateShopeeSizeChart" && sizeChartState) return structuredClone(sizeChartState);
      assert.fail(fn.name);
    },
    cdp: {
      pendingDialog: () => dialog || null,
      send: async (_id, method, args) => {
        if (method === "Runtime.evaluate") return { result: { objectId: "test" } };
        if (method === "Runtime.callFunctionOn") return { result: { value: true } };
        if (method === "DOM.setFileInputFiles") {
          files.push(...args.files);
          Object.assign(state.image, { cover: true, count: 1, readyCount: 1, coverReady: true });
        }
        return {};
      },
    },
    onFlowProgress: (event) => results.push(event),
    platform: () => "mac",
    sleep: async () => {},
    now: () => Date.now(),
  });
  let seq = 0;
  const session = { token: token.token, sessionId: "test-session", agentName: "mcp" };
  const request = (tool, args = {}, patch = {}, as = { session }) =>
    bridge.call({ id: "t" + ++seq, tool, args, ...patch }, as);
  const run = (data = input, patch) => request("run_flow", { flowId: "shopee-listing", tabId: tab.id, input: data }, patch);
  return { approvals, bridge, files, fills, request, results, run, scans, session, state, tab };
}

{
  const { request, run, scans, fills, results, bridge } = await setup();
  const catalog = await request("list_flows");
  assert.equal(catalog.result.flows[0].id, "shopee-listing");
  assert.ok(!((await bridge.hello()).tools.some(({ name }) => name === "run_flow")));
  for (const name of ["flow_category_click", "flow_control_click", "flow_variant_write"]) {
    assert.ok(!(await request("list_tools")).result.tools.some((tool) => tool.name === name));
    const directClick = await request(name, { tabId: 7, selector: "#target", category: input.category });
    assert.equal(directClick.error.code, "UNKNOWN_TOOL");
  }
  const legacy = await request("run_flow", { flowId: "shopee-listing", tabId: 7, input }, {}, {});
  assert.equal(legacy.error.code, "UNAUTHORIZED");
  const response = await run();
  assert.equal(response.result.status, "verified");
  assert.deepEqual(scans[0], [input.category]);
  assert.deepEqual(fills, ["#title", "#description", "#price", "#quantity", "#weight"]);
  assert.equal(results.at(-1).status, "verified");
  assert.equal(bridge.leases.size(), 0);
  assert.ok(!JSON.stringify(results).includes(input.title), "UI progress contains only status metadata");
  assert.deepEqual(bridge.audit().filter(({ tool }) => tool === "set_input_value").map(({ ok }) => ok), Array(5).fill(true));
}

{
  const injected = [];
  const tools = createFlowTools({
    inject: async (...args) => { injected.push(args); return { ok: true }; },
  }, { obj: (properties, required) => ({ properties, required }), TAB_ID: { type: "integer" } });
  const categoryClick = tools.find(({ name }) => name === "flow_category_click");
  assert.equal(categoryClick.scope, "page:act");
  const args = { tabId: 7, selector: "#target", category: input.category };
  assert.deepEqual(flowBridgeCall(categoryClick.name, args, 7), { tool: categoryClick.name, args });
  assert.throws(() => flowBridgeCall(categoryClick.name, args, 8), /目标标签/);
  assert.deepEqual(await categoryClick.execute(args, { tab: { url } }), { ok: true });
  assert.equal(injected[0][1].name, "clickCategoryRecommendation");
  assert.deepEqual(injected[0].slice(2), [["#target", input.category, url], { world: "MAIN" }]);
  await assert.rejects(categoryClick.execute(args, { tab: { url: origin + "/portal/mtsku/" } }), /页面|标签页/);

  const controlClick = tools.find(({ name }) => name === "flow_control_click");
  assert.equal(controlClick.scope, "page:act");
  const target = { selector: "#brand", category: input.category, action: "attribute-trigger", label: "品牌", text: "请选择" };
  const click = { tabId: 7, ...target };
  assert.deepEqual(flowBridgeCall(controlClick.name, click, 7), { tool: controlClick.name, args: click });
  assert.throws(() => flowBridgeCall(controlClick.name, click, 8), /目标标签/);
  assert.deepEqual(await controlClick.execute(click, { tab: { url } }), { ok: true });
  assert.equal(injected[1][1].name, "clickListingControl");
  assert.deepEqual(injected[1].slice(2), [[target, url], { world: "MAIN" }]);
  await assert.rejects(controlClick.execute({ ...click, action: "arbitrary-click" }, { tab: { url } }), /流程控件参数/);
  await assert.rejects(controlClick.execute(click, { tab: { url: origin + "/portal/mtsku/" } }), /页面|标签页/);

  const variantWrite = tools.find(({ name }) => name === "flow_variant_write");
  assert.equal(variantWrite.scope, "page:act");
  const variant = { kind: "option", category: input.category, selector: "#option", name: "颜色", option: "蓝色", existingOptions: ["白色"] };
  const write = { tabId: 7, ...variant };
  assert.deepEqual(flowBridgeCall(variantWrite.name, write, 7), { tool: variantWrite.name, args: write });
  assert.throws(() => flowBridgeCall(variantWrite.name, write, 8), /目标标签/);
  assert.deepEqual(await variantWrite.execute(write, { tab: { url } }), { ok: true });
  assert.equal(injected[2][1].name, "writeListingVariant");
  assert.deepEqual(injected[2].slice(2), [[variant, url], { world: "MAIN" }]);
  await assert.rejects(variantWrite.execute({ ...write, existingOptions: [false] }, { tab: { url } }), /规格输入参数/);
  await assert.rejects(variantWrite.execute(write, { tab: { url: origin + "/portal/mtsku/" } }), /页面|标签页/);
}

{
  const { run, fills, scans, request, tab } = await setup({ scopes: ["page:read", "page:act"] });
  for (const changes of [
    { imagePath: "/tmp/sample.png" },
    { variant: { name: "颜色", option: "蓝色", price: "12", quantity: "1", sku: "BLUE", imagePath: "/tmp/blue.png" } },
    { variant: { name: "颜色", options: [{ option: "蓝色", price: "12", quantity: "1", sku: "BLUE", imagePath: "/tmp/blue.png" }] } },
  ]) {
    const result = await run({ ...input, ...changes });
    assert.equal(result.error.code, "SCOPE_DENIED");
    assert.equal(result.error.details.scope, "upload");
  }
  assert.deepEqual(fills, []);
  assert.deepEqual(scans, []);
  tab.url = origin + "/portal/mtsku/";
  assert.equal((await request("flow_page_state", { tabId: tab.id, category: input.category })).error.code, "BAD_ARGS");
}

{
  const { run, request, scans } = await setup({ origins: ["https://a.example"] });
  assert.deepEqual((await request("list_flows")).result.flows, []);
  assert.equal((await run()).error.code, "ORIGIN_NOT_ALLOWED");
  assert.deepEqual(scans, []);
}

{
  const { approvals, run, files } = await setup();
  const withImage = { ...input, imagePath: "/tmp/sample.png" };
  const blocked = await run(withImage);
  assert.equal(blocked.result.code, "CONFIRMATION_REQUIRED");
  assert.deepEqual(files, []);
  const pending = (await approvals.list({ status: "pending" }))[0];
  assert.equal(pending.toolName, "upload_file");
  await approvals.resolve(pending.id, true);
  assert.equal((await run(withImage)).result.status, "verified");
  assert.deepEqual(files, [withImage.imagePath]);
}

{
  const { run, fills } = await setup({
    beforeRead: (tab) => { tab.url = url.replace("=123", "=456"); },
  });
  const response = await run();
  assert.equal(response.result.code, "BAD_ARGS");
  assert.deepEqual(fills, [], "the same-origin shop navigation stops subsequent writes");
}

{
  const { run, fills, scans } = await setup({ dialog: { type: "confirm", message: "请确认商品修改" } });
  const response = await run();
  assert.equal(response.result.status, "needs-review");
  assert.equal(response.result.code, "modal");
  assert.equal(response.result.details.error.details.dialog.type, "confirm");
  assert.deepEqual(fills, []);
  assert.deepEqual(scans, [], "a browser dialog is reported before blocked DOM access");
}

{
  const { run } = await setup({ sizeChartState: { available: true, dialog: { title: "Add New Size Chart Of 上衣" } } });
  const result = await run({
    ...input,
    sizeChart: {
      name: "上衣尺码",
      unit: "cm",
      columns: ["尺寸（国际）", "胸围"],
      rows: [{ "尺寸（国际）": "S", "胸围": "84" }],
    },
  });
  assert.equal(result.result.code, "size-chart-dialog-already-open");
}

{
  const { approvals, run } = await setup({ sizeChartState: { available: true, options: [] } });
  const response = await run({
    ...input,
    sizeChart: {
      name: "上衣尺码", unit: "cm", columns: ["尺寸（国际）", "胸围"],
      rows: [{ "尺寸（国际）": "S", "胸围": "84" }],
    },
  });
  assert.equal(response.result.code, "CONFIRMATION_REQUIRED");
  const pending = (await approvals.list({ status: "pending" }))[0];
  assert.equal(pending.toolName, "flow_size_chart_action");
  assert.equal(pending.item.label, "保存 Shopee 店铺尺码表");
}

{
  const { bridge, request, run, session } = await setup();
  await request("events_subscribe", { types: ["job.progress", "job.done"] });
  const queued = await run(input, { async: true });
  assert.equal(queued.result.status, "running");
  let job;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    job = await request("job_status", { jobId: queued.result.jobId });
    if (job.result.status === "done") break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(job.result.response.result.status, "verified");
  const events = bridge.events.poll(session.sessionId).events;
  assert.ok(events.some((event) => event.type === "job.progress" && event.data?.step === "shipping"));
  assert.ok(events.some((event) => event.type === "job.done" && event.ok === true));
}

{
  let started, resume;
  const reading = new Promise((resolve) => { started = resolve; });
  const suspended = new Promise((resolve) => { resume = resolve; });
  const { bridge, request, run, fills, session } = await setup({
    beforeRead: () => { started(); return suspended; },
  });
  const pending = run();
  await reading;
  const race = await request("set_input_value", { tabId: 7, selector: "#title", value: "another writer" });
  assert.equal(race.error.code, "TAB_LEASED");
  bridge.closeSession(session.sessionId);
  resume();
  assert.equal((await pending).error.code, "UNAUTHORIZED");
  assert.deepEqual(fills, []);
  assert.equal(bridge.leases.size(), 0);
}

console.log("OK bundled deterministic flow uses the existing token scopes, approvals and tab guards");

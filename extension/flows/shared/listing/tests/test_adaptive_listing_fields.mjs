import assert from "node:assert/strict";
import { test } from "node:test";
import { createListingFieldCache, recoverListingFields } from "../adaptive-fields.js";
import { createListingAdvisor } from "../listing-advisor.js";

const shop = { platform: "shein", store: "GS1", market: "美国站", categoryPath: ["家居", "杯子"] };
const material = { key: "material", label: "材质", section: "商品属性", type: "select", required: true, value: "" };
const state = fields => ({ ok: true, fields });
function memoryStorage() {
  const data = {};
  return {
    get: async key => ({ [key]: data[key] }),
    set: async copy => Object.assign(data, copy),
    remove: async key => delete data[key],
  };
}

test("keeps identical field labels separated by site, store, category, editor section, and dependencies", async () => {
  const cache = createListingFieldCache({ storage: memoryStorage() });
  await cache.set(shop, material, ["金属", "玻璃"]);
  assert.deepEqual(await cache.get(shop, material), ["金属", "玻璃"]);
  assert.deepEqual(await cache.get({ ...shop, market: "英国站" }, material), []);
  assert.deepEqual(await cache.get({ ...shop, store: "GS2" }, material), []);
  assert.deepEqual(await cache.get({ ...shop, categoryPath: ["服装", "上衣"] }, material), []);
  assert.deepEqual(await cache.get(shop, { ...material, section: "SKU 规格" }), []);
  assert.deepEqual(await cache.get(shop, { ...material, dependency: "塑料" }), []);
});

test("refreshes a stale option, bounds model requests, and scopes writes to verified form values", async () => {
  const storage = memoryStorage();
  const cache = createListingFieldCache({ storage });
  await cache.set(shop, material, ["旧选项"]);
  const price = { ...material, key: "price", label: "申报价格", type: "number", error: "请填写" };
  const upload = { ...material, key: "image", label: "资质附件", type: "upload" };
  const selected = [];
  let optionsRead = 0;
  let modelCalls = 0;
  let current = state([material, price, upload]);
  const result = await recoverListingFields({ scope: shop, snapshot: current, cache, read: async () => current,
    readOptions: async field => { assert.equal(field.key, "material"); optionsRead++; return ["纯金属", "玻璃"]; },
    suggest: async fields => {
      modelCalls++;
      assert.deepEqual(fields.map(field => field.key), ["material"]);
      return { material: fields[0].options[0], price: 99, image: "/local/file.pdf" };
    },
    apply: async values => {
      selected.push(values);
      if (values.material === "旧选项") return { ok: true, issues: [{ key: "material", code: "OPTION_MISSING" }] };
      current = state([{ ...material, value: values.material }, price, upload]);
      return { ok: true, items: [{ key: "material", status: "verified" }] };
    },
  });
  assert.deepEqual(selected, [{ material: "旧选项" }, { material: "纯金属" }]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.state.fields[0].value, "纯金属");
  assert.equal(optionsRead, 1);
  assert.equal(modelCalls, 2);
  assert.deepEqual(await cache.get(shop, material), ["纯金属", "玻璃"]);
});

test("batches direct text, numeric and checkbox repairs and rejects a value outside the real options", async () => {
  const fields = [
    { ...material, value: ["示例"], multiple: true, error: "选项已变" },
    { ...material, key: "label", type: "text", maxLength: 20, label: "简短描述" },
    { ...material, key: "length", type: "number", max: 10, label: "长度" },
    { ...material, key: "format", type: "checkbox", label: "可叠放" },
  ];
  const writes = [];
  const recovery = await recoverListingFields({ scope: shop, snapshot: state(fields), read: async () => state([]),
    readOptions: async () => ["金属", "玻璃"],
    suggest: async () => ({ material: ["不存在"], label: "日常收纳", length: 3, format: true }),
    apply: async values => { writes.push(values); return { ok: true, items: [] }; },
  });
  assert.deepEqual(writes, [{ label: "日常收纳", length: 3, format: true }]);
  assert.deepEqual(recovery.issues, []);
});

test("opts in to blanks in required-first order while preserving populated and guarded fields", async () => {
  const optional = { ...material, key: "connectivity", label: "连接方式", required: false };
  const title = { ...material, key: "subtitle", label: "副标题", type: "text", required: false };
  const known = { ...title, key: "known", value: "已有资料" };
  const hazard = { ...material, key: "hazard", label: "危险品分类", error: "请填写" };
  const input = [optional, title, known, hazard, material];
  const writes = [];
  for (const includeOptional of [false, true]) {
    let current = state(input);
    const result = await recoverListingFields({ scope: shop, snapshot: current, includeOptional,
      read: async () => current,
      readOptions: async field => field.key === "material" ? ["ABS"] : ["有线", "无线"],
      suggest: async fields => {
        assert.deepEqual(fields.map(field => field.key), includeOptional
          ? ["material", "connectivity", "subtitle"] : ["material"]);
        return { material: "ABS", connectivity: "有线", known: "覆盖", hazard: "无危险品" };
      },
      apply: async chosen => {
        writes.push(chosen);
        current = state(input.map(field => Object.hasOwn(chosen, field.key) ? { ...field, value: chosen[field.key] } : field));
        return { ok: true };
      },
    });
    assert.deepEqual(result.issues, []);
  }
  assert.deepEqual(writes, [{ material: "ABS" }, { material: "ABS", connectivity: "有线" }]);
});

test("refreshes a cached blocking selector after the model cannot match it, without probing abstained optional selectors", async () => {
  const storage = memoryStorage();
  const cache = createListingFieldCache({ storage });
  const optional = { ...material, key: "pattern", label: "图案", required: false };
  await cache.set(shop, material, ["金属"]);
  await cache.set(shop, optional, ["纯色", "条纹"]);
  let current = state([material, optional]);
  let modelCalls = 0;
  const liveReads = [];
  const result = await recoverListingFields({ scope: shop, snapshot: current, read: async () => current, cache, includeOptional: true,
    readOptions: async field => { liveReads.push(field.key); return ["ABS", "玻璃"]; },
    suggest: async fields => {
      modelCalls++;
      if (modelCalls === 1) assert.deepEqual(fields.map(field => field.key), ["material", "pattern"]);
      return fields[0].options.includes("ABS") ? { material: "ABS" } : {};
    },
    apply: async values => {
      assert.deepEqual(values, { material: "ABS" });
      current = state([{ ...material, value: "ABS" }, optional]);
      return { ok: true };
    },
  });
  assert.deepEqual(liveReads, ["material"]);
  assert.deepEqual(await cache.get(shop, material), ["ABS", "玻璃"]);
  assert.equal(modelCalls, 2);
  assert.deepEqual(result.issues, []);
});

test("rechecks an initially empty selector when an upstream choice changes its options", async () => {
  const dependent = { ...material, key: "port", label: "接口", required: false, dependency: "" };
  const unused = { ...material, key: "style", label: "款式", required: false, dependency: "" };
  let current = state([material, dependent, unused]);
  const reads = [];
  const writes = [];
  const result = await recoverListingFields({ scope: shop, snapshot: current, read: async () => current, includeOptional: true,
    readOptions: async field => {
      reads.push(field.key);
      return field.key === "port" ? field.dependency ? ["USB-C"] : [] : ["ABS"];
    },
    suggest: async fields => fields.some(field => field.key === "port") ? { port: "USB-C" } : { material: "ABS" },
    apply: async values => {
      writes.push(values);
      current = state(current.fields.map(field => ({ ...field, dependency: "ABS", value: values[field.key] || field.value })));
      return { ok: true };
    },
  });
  assert.deepEqual(reads, ["material", "port", "style", "port"]);
  assert.deepEqual(writes, [{ material: "ABS" }, { port: "USB-C" }]);
  assert.deepEqual(result.issues, []);
});

test("sends category and field instructions with only the selected product photo and scoped options", async () => {
  const settings = { text: { baseUrl: "http://localhost:1234/v1", model: "text" },
    multimodal: { baseUrl: "http://localhost:1234/v1", model: "vision" } };
  const file = new File(["png"], "cup.png", { type: "image/png" });
  const calls = [];
  const advisor = createListingAdvisor({
    settings, product: { title: "保温杯", operatorNotes: "品牌无要求" }, referenceImages: [{ role: "main", file }],
    async request(model, payload) {
      calls.push({ model, payload });
      return calls.length === 1 ? '{"keywords":["保温杯","杯子"]}' : '{"material":"纯金属"}';
    },
  });
  assert.deepEqual(await advisor.categoryKeywords({ sourceCategories: ["饮具"] }), ["保温杯", "杯子"]);
  assert.deepEqual(await advisor.fields([{ ...material, options: ["纯金属", "玻璃"] }]), { material: "纯金属" });
  assert.ok(calls.every(call => call.model.model === "vision"));
  const content = calls[1].payload.messages.at(-1).content;
  assert.match(content[0].text, /纯金属/u);
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/u);
});

test("includes nested source facts and required status for optional matching", async () => {
  const advisor = createListingAdvisor({
    settings: { text: { baseUrl: "http://localhost:1234/v1", model: "text" } },
    product: { title: "有线键盘", attributes: { 键数: 87 }, shein: { attributes: { 材质: "ABS", 带背光: false } } },
    async request(_model, payload) {
      const [instructions, data] = payload.messages;
      assert.match(instructions.content, /选填字段也应填写/u);
      const { product, fields } = JSON.parse(data.content);
      assert.deepEqual(product.attributes, { 键数: 87, 材质: "ABS", 带背光: false });
      assert.deepEqual(fields, [{ key: "material", label: "材质", type: "select", required: false,
        section: "商品属性", options: ["ABS", "铝"] }]);
      return '{"material":"ABS"}';
    },
  });
  assert.deepEqual(await advisor.fields([{ ...material, required: false, options: ["ABS", "铝"] }]), { material: "ABS" });
});

test("judges category choices only by supplied whole path indices", async () => {
  const calls = [];
  const replies = ['{"index":null,"keywords":["中筒袜","袜子"]}', '{"index":27}', '{"index":1}'];
  const advisor = createListingAdvisor({
    settings: { text: { baseUrl: "http://localhost:1234/v1", model: "text" } },
    product: { title: "成人日常中筒袜" },
    async request(model, payload) {
      calls.push(JSON.parse(payload.messages.at(-1).content));
      return replies.shift();
    },
  });
  const candidates = [["运动&户外", "冬日运动", "滑雪袜"], ["女士服装", "袜子", "中筒袜"]];
  assert.equal(advisor.isAvailable, true);
  assert.deepEqual(await advisor.chooseCachedCategory({ candidates, hints: ["日常中筒袜"] }), { index: null, keywords: ["中筒袜", "袜子"] });
  assert.equal(await advisor.chooseCategory({ candidates }), null);
  assert.equal(await advisor.chooseCategory({ candidates }), 1);
  assert.deepEqual(calls[0].candidates, candidates.map((path, index) => ({ index, path })));
  assert.deepEqual(calls[0].hints, ["日常中筒袜"]);
});

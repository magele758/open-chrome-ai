import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSheinCategory } from "../category-search.js";

const cupPath = ["家居&生活", "厨房&餐厅", "饮具", "马克杯"];
const store = "GS12345678";
const cache = `pagelens.shein.category-keywords.v2.${store}`;
function fixture({ storeKey = store, terms = {}, records = {}, events = [] } = {}) {
  const calls = [];
  const data = new Map(Object.entries(records));
  const storage = {
    get: async key => ({ [key]: data.get(key) }),
    set: async values => { for (const [key, value] of Object.entries(values)) data.set(key, value); },
  };
  const callPage = async input => {
    events.push(input.probe ? "probe" : input.categoryPath ? "commit" : input.kind);
    calls.push(input);
    if (input.kind === "inspect") return { ok: true, selectedPath: [], storeKey };
    const source = terms[input.keyword];
    const path = typeof source === "function" ? source(input) : source;
    if (input.probe && Array.isArray(path)) return { ok: true, status: "candidates", suggestions: [path] };
    if (path && typeof path === "object" && !Array.isArray(path)) return path;
    return Array.isArray(path) ? { ok: true, selectedPath: path, canAdvance: true, storeKey } :
      { ok: false, code: path || "CATEGORY_SEARCH_NO_MATCH" };
  };
  return { calls, storage, callPage, data };
}

test("tries explicit source words and one model shortlist in order, stopping at the first verified shelf category", async () => {
  const state = fixture({ terms: { 马克杯: cupPath, 杯子: ["商品", "其它杯子"] } });
  let models = 0;
  const outcome = await resolveSheinCategory({ ...state, input: { title: "350 ml 黑色咖啡用杯", category: "Kitchen > Drinkware" },
    suggestKeywords: async evidence => {
      models++;
      assert.deepEqual(evidence.sourceCategories, ["Kitchen > Drinkware"]);
      return { keywords: ["马克杯", "杯子"] };
    },
  });
  assert.equal(models, 1);
  assert.deepEqual(outcome.selectedPath, cupPath);
  assert.deepEqual(state.calls.map(call => call.keyword).filter(Boolean), ["Drinkware", "Kitchen", "马克杯"]);
  assert.deepEqual(state.data.get(cache).map(({ keyword, path }) => ({ keyword, path })), [{ keyword: "马克杯", path: cupPath }]);
});

test("reuses only same-store matching keywords, verifies against live results, and replaces stale path receipts", async () => {
  const changedPath = ["家居&生活", "餐厨用品", "马克杯"];
  const state = fixture({ terms: { 马克杯: changedPath }, records: { [cache]: [
    { keyword: "杯", path: cupPath, learnedAt: Date.now() },
    { keyword: "马克杯", path: cupPath, learnedAt: Date.now() },
  ] } });
  const outcome = await resolveSheinCategory({ ...state, input: { title: "黑色马克杯带手柄" },
    suggestKeywords: async () => assert.fail("matched live cache should skip the model"),
  });
  assert.deepEqual(outcome.selectedPath, changedPath);
  assert.deepEqual(state.calls.slice(1).map(call => [call.keyword, call.preferredPath]), [["马克杯", cupPath]]);
  assert.deepEqual(state.data.get(cache)[0].path, changedPath);

  const other = fixture({ storeKey: "GS76543210", terms: { 马克杯: cupPath }, records: { [cache]: state.data.get(cache) } });
  await resolveSheinCategory({ ...other, input: { title: "黑色马克杯带手柄" }, suggestKeywords: async () => ["马克杯"] });
  assert.equal(other.calls.at(-1).preferredPath, undefined);
  assert.equal(other.data.size, 2);
});

test("does not persist without a verified store identity or continue past a changed page", async () => {
  const unknown = fixture({ storeKey: "", terms: { 马克杯: cupPath } });
  assert.equal((await resolveSheinCategory({ ...unknown, input: { title: "马克杯" } })).ok, true);
  assert.equal(unknown.data.size, 0);
  const blocked = fixture({ terms: { 马克杯: "PAGE_CHANGED", 杯子: cupPath } });
  const outcome = await resolveSheinCategory({ ...blocked, input: { title: "马克杯", categoryKeywords: ["马克杯", "杯子"] } });
  assert.equal(outcome.code, "PAGE_CHANGED");
  assert.equal(blocked.calls.length, 2);
  assert.equal(blocked.data.size, 0);
});

test("prioritizes supplied terms over local history and continues past a specialized match", async () => {
  const skiSocks = ["运动&户外", "冬日运动", "滑雪", "滑雪袜"];
  const casualSocks = ["配饰", "服装配饰", "袜子"];
  const uncertain = { ok: false, code: "CATEGORY_SEARCH_UNCERTAIN", suggestions: [skiSocks] };
  const state = fixture({ terms: { 中筒袜: uncertain, 休闲袜: uncertain, 袜子: casualSocks },
    records: { [`pagelens.shein.category-keywords.v1.${store}`]: [{ keyword: "袜子", path: skiSocks, learnedAt: Date.now() }],
      [cache]: [{ keyword: "袜子", path: casualSocks, learnedAt: Date.now() }] } });
  const outcome = await resolveSheinCategory({ ...state,
    input: { title: "成人中筒袜", categoryKeywords: ["中筒袜", "休闲袜", "袜子"] } });
  assert.deepEqual(outcome.selectedPath, casualSocks);
  assert.deepEqual(state.calls.slice(1).map(({ keyword }) => keyword), ["中筒袜", "休闲袜", "袜子"]);
  assert.deepEqual(state.calls.at(-1).preferredPath, casualSocks);
  assert.equal(state.data.get(cache).some(record => record.path.at(-1) === "滑雪袜"), false);
});

test("does not trust first-result cache records from previous versions or store uncertain results", async () => {
  const skiSocks = ["运动&户外", "冬日运动", "滑雪袜"];
  const state = fixture({ terms: { 袜子: { ok: false, code: "CATEGORY_SEARCH_UNCERTAIN", suggestions: [skiSocks] } },
    records: { [`pagelens.shein.category-keywords.v1.${store}`]: [{ keyword: "袜子", path: skiSocks, learnedAt: Date.now() }] } });
  const outcome = await resolveSheinCategory({ ...state, input: { title: "成人袜子测试", categoryKeywords: ["袜子"] } });
  assert.equal(state.calls[1].preferredPath, undefined);
  assert.equal(outcome.code, "CATEGORY_SEARCH_UNCERTAIN");
  assert.deepEqual(outcome.suggestions, [skiSocks]);
  assert.equal(state.data.has(cache), false);
});

test("uses one model call for a verified cached leaf before asking for new keywords", async () => {
  const events = [];
  const state = fixture({ events, terms: { 马克杯: cupPath }, records: { [cache]: [
    { keyword: "马克杯", path: cupPath, learnedAt: Date.now() },
  ] } });
  const outcome = await resolveSheinCategory({ ...state, input: { title: "Ceramic breakfast coffee mug" },
    chooseCachedCategory: async ({ candidates, title }) => {
      events.push("cached-model");
      assert.deepEqual(candidates, [cupPath]);
      assert.equal(title, "Ceramic breakfast coffee mug");
      return { index: 0 };
    },
    suggestKeywords: async () => assert.fail("cache hit skips the keyword model"),
    chooseCategory: async () => assert.fail("cache hit skips the live category model"),
  });
  assert.deepEqual(outcome.selectedPath, cupPath);
  assert.deepEqual(events, ["inspect", "cached-model", "inspect", "commit"]);
  assert.deepEqual(state.calls.at(-1).categoryPath, cupPath);
});

test("asks for keywords, probes the store, and applies only the category the model selected", async () => {
  const events = [];
  const skiSocks = ["运动&户外", "冬日运动", "滑雪", "滑雪袜"];
  const casualSocks = ["内衣&睡衣", "袜子", "中筒袜"];
  const state = fixture({ events, terms: { 中筒袜: input => input.probe ?
    { ok: true, status: "candidates", suggestions: [skiSocks, casualSocks] } : casualSocks } });
  const outcome = await resolveSheinCategory({ ...state, input: { title: "Adult ribbed crew socks" },
    chooseCachedCategory: async () => assert.fail("empty cache skips the cache model"),
    suggestKeywords: async () => { events.push("keyword-model"); return ["中筒袜"]; },
    chooseCategory: async ({ candidates }) => {
      events.push("live-model");
      assert.deepEqual(candidates, [casualSocks, skiSocks]);
      return 0;
    },
  });
  assert.deepEqual(outcome.selectedPath, casualSocks);
  assert.deepEqual(events, ["inspect", "keyword-model", "probe", "live-model", "inspect", "commit"]);
  assert.deepEqual(state.calls.at(-1).categoryPath, casualSocks);
  assert.deepEqual(state.data.get(cache)[0].path, casualSocks);
});

test("uses new terms from the cached model when the formerly verified leaf disappears", async () => {
  const events = [];
  const changedPath = ["家居&生活", "餐厨用品", "马克杯"];
  const state = fixture({ events, terms: { 水杯: "CATEGORY_SEARCH_NO_MATCH", 马克杯: changedPath },
    records: { [cache]: [{ keyword: "水杯", path: cupPath, learnedAt: Date.now() }] } });
  const outcome = await resolveSheinCategory({ ...state, input: { title: "Ceramic breakfast coffee mug" },
    chooseCachedCategory: async () => { events.push("cached-model"); return { index: 0, keywords: ["马克杯"] }; },
    suggestKeywords: async () => assert.fail("cached model already suggested terms"),
    chooseCategory: async ({ candidates }) => { events.push("live-model"); assert.deepEqual(candidates, [changedPath]); return 0; },
  });
  assert.deepEqual(outcome.selectedPath, changedPath);
  assert.deepEqual(events, ["inspect", "cached-model", "inspect", "commit", "probe", "live-model", "inspect", "commit"]);
});

test("does not click when the model cannot match the product to a live leaf", async () => {
  const skiSocks = ["运动&户外", "冬日运动", "滑雪", "滑雪袜"];
  const state = fixture({ terms: { 袜子: skiSocks } });
  const outcome = await resolveSheinCategory({ ...state,
    input: { title: "Adult cotton crew socks", categoryKeywords: ["袜子"] }, chooseCategory: async () => 99 });
  assert.equal(outcome.code, "CATEGORY_SEARCH_UNCERTAIN");
  assert.ok(state.calls.slice(1).every(call => call.probe));
  assert.equal(state.data.size, 0);
});

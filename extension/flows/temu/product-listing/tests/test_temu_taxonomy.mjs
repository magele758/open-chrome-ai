import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { suggestTemuCategory } from "../category-suggestion.js";
import { loadTemuCategoryChildren, loadTemuCategoryRoots, loadTemuOrigins, resolveTemuCategory, resolveTemuOrigin, searchTemuCategories } from "../taxonomy.js";

function localFetch(requests) {
  return async url => {
    requests.push(url.pathname.split("/").at(-1));
    return new Response(await readFile(url));
  };
}

test("loads only the chosen root branch for qualified paths and preserves exact Temu labels", async () => {
  const requests = [];
  const fetchImpl = localFetch(requests);
  const roots = await loadTemuCategoryRoots({ fetchImpl });
  assert.equal(roots.length, 25);
  assert.deepEqual(requests, ["roots.json"]);
  const cup = { id: "31559", path: ["运动与户外用品", "运动与户外休闲用品", "运动杯"] };
  assert.deepEqual(await searchTemuCategories("运动与户外用品 -> 运动与户外休闲用品 -> 运动杯", { fetchImpl, limit: 1 }), [cup]);
  assert.deepEqual(await searchTemuCategories("运动杯", { fetchImpl, rootId: "31148", limit: 1 }), [cup]);
  assert.deepEqual(requests, ["roots.json", "category-31148.json.gz"]);
});

test("supports unscoped leaf search, disambiguating by breadcrumb instead of rewriting category names", async () => {
  const requests = [];
  const fetchImpl = localFetch(requests);
  const exact = await searchTemuCategories("女装针织衫开衫", { fetchImpl, limit: 1 });
  assert.deepEqual(exact, [{ id: "28950", path: ["服装、鞋靴和珠宝饰品", "女士时尚", "女装", "女士毛衣", "女装针织衫开衫"] }]);
  assert.equal(requests.length, 26);
  const cups = await searchTemuCategories(31559, { fetchImpl, limit: 1 });
  assert.equal(cups[0].id, "31559");
  assert.equal(requests.length, 26);
});

test("packs country display names and province choices separately from the category tree", async () => {
  const requests = [];
  const fetchImpl = localFetch(requests);
  const origins = await loadTemuOrigins({ fetchImpl });
  assert.deepEqual(requests, ["origins.json"]);
  assert.equal(origins.length, 227);
  const china = origins.find(entry => entry.country === "中国大陆");
  assert.ok(china.aliases.includes("China"));
  assert.ok(china.regions.includes("广东省"));
  assert.equal(china.regions.length, 31);
});

test("cascades through real branch ids and validates the selected leaf and path together", async () => {
  const requests = [];
  const fetchImpl = localFetch(requests);
  const path = ["运动与户外用品", "运动与户外休闲用品", "运动杯"];
  const roots = await loadTemuCategoryChildren([], { fetchImpl });
  const root = roots.find(row => row.label === path[0]);
  const branch = (await loadTemuCategoryChildren([root.id], { fetchImpl })).find(row => row.label === path[1]);
  const leaf = (await loadTemuCategoryChildren([root.id, branch.id], { fetchImpl })).find(row => row.label === path[2]);
  const ids = [root.id, branch.id, leaf.id];
  const expected = { id: "31559", path, ids };
  assert.equal(branch.leaf, false);
  assert.equal(leaf.leaf, true);
  assert.deepEqual(await loadTemuCategoryChildren(ids, { fetchImpl }), []);
  assert.deepEqual(await loadTemuCategoryChildren([root.id, leaf.id], { fetchImpl }), []);
  assert.deepEqual(await resolveTemuCategory({ id: leaf.id, path }, { fetchImpl }), expected);
  assert.deepEqual(await searchTemuCategories(path.join(" > "), { withIds: true, fetchImpl, limit: 1 }), [expected]);
  assert.equal(await resolveTemuCategory({ id: branch.id, path }, { fetchImpl }), null);
  assert.equal(await resolveTemuCategory({ path: path.slice(0, 2) }, { fetchImpl }), null);
  assert.deepEqual(requests, ["roots.json", "category-31148.json.gz"]);
});

test("maps the mainland and province defaults to exact catalog labels and rejects a province from another country", async () => {
  const origins = await loadTemuOrigins({ fetchImpl: localFetch([]) });
  const mainland = { country: "中国大陆", region: "浙江省" };
  assert.deepEqual(resolveTemuOrigin(origins, mainland), mainland);
  assert.deepEqual(resolveTemuOrigin(origins, { country: "中国", region: "浙江" }), mainland);
  assert.deepEqual(resolveTemuOrigin(origins, { country: "CN", region: "浙江" }), mainland);
  assert.deepEqual(resolveTemuOrigin(origins, { country: "JP", region: "浙江省" }), { country: "日本" });
  assert.equal(resolveTemuOrigin(origins, { country: "未提供", region: "浙江省" }), null);
});

const localSettings = { text: { baseUrl: "http://localhost:1234/v1", model: "test-category" } };

test("locally matches cross-platform product titles and preserves an explicit Temu leaf", async () => {
  const fetchImpl = localFetch([]);
  const options = { fetchImpl, useModel: false };
  const samples = [
    [{ title: "不锈钢保温咖啡杯 滑盖随行杯", categoryPath: ["家居生活", "餐饮用品", "水杯、马克杯与玻璃杯"] }, "运动杯"],
    [{ title: "女士圆领条纹短袖T恤 宽松休闲上衣", categoryPath: ["女装", "上衣", "T恤"] }, "女装T恤"],
    [{ title: "Cap Sleeve Tops for Women Summer Basic Tee Shirts", sourceCategory: "Clothing > Women > T-Shirts" }, "女装T恤"],
  ];
  for (const [product, label] of samples) {
    const suggestion = await suggestTemuCategory(product, options);
    assert.equal(suggestion.source, "local");
    assert.equal(suggestion.category.path.at(-1), label);
    assert.equal(suggestion.category.ids.at(-1), suggestion.category.id);
  }
  const cup = await suggestTemuCategory({ title: "独立商品", categoryId: 31559 }, {
    ...options, settings: localSettings, useModel: true, request: assert.fail,
  });
  assert.equal(cup.source, "provided");
  assert.equal(cup.category.id, "31559");
});

test("asks the configured model once and accepts only catalog candidates", async () => {
  const fetchImpl = localFetch([]);
  let calls = 0;
  const product = { title: "女士短袖 T 恤", description: "棉质短袖", mainImages: ["/private/catalog/photo.png"] };
  const suggestion = await suggestTemuCategory(product, {
    fetchImpl, settings: localSettings,
    request: async (model, { messages }) => {
      calls++;
      assert.equal(model.model, "test-category");
      const { candidates, product } = JSON.parse(messages[1].content);
      assert.ok(candidates.find(([id]) => id === "29069"));
      assert.ok(candidates.length <= 24);
      assert.equal(product.mainImages, undefined);
      return '{"id":"29069"}';
    },
  });
  assert.equal(calls, 1);
  assert.equal(suggestion.source, "model");
  assert.equal(suggestion.category.path.at(-1), "女装T恤");
  const local = await suggestTemuCategory(product, {
    fetchImpl, settings: localSettings, request: async () => '{"id":"1"}',
  });
  assert.equal(local.source, "local");
  assert.equal(local.category.id, "29069");
});

test("finds a real leaf from model-supplied translated keywords and a real root", async () => {
  const suggestion = await suggestTemuCategory({ title: "Dublin armband XY80" }, {
    fetchImpl: localFetch([]), settings: localSettings,
    request: async () => '{"rootId":"31148","keywords":["运动水壶"]}',
  });
  assert.equal(suggestion.source, "model");
  assert.equal(suggestion.category.path.at(-1), "运动水壶");
  assert.equal(suggestion.category.ids[0], "31148");
});

test("cancels the pending category model when the selected product is replaced", async () => {
  const controller = new AbortController();
  await assert.rejects(suggestTemuCategory({ title: "女士短袖 T 恤" }, {
    fetchImpl: localFetch([]), settings: localSettings, signal: controller.signal,
    request: async (_model, { signal }) => {
      controller.abort(new Error("商品已切换"));
      assert.equal(signal.reason, controller.signal.reason);
      signal.throwIfAborted();
    },
  }), /商品已切换/u);
});

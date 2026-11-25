import assert from "node:assert/strict";
import test from "node:test";
import { translateCampaigns } from "../translate.js";

test("only sends foreign fields once and leaves source data intact", async () => {
  const url = "https://seller.shopee.cn/campaigns?campaign=12345";
  const text = `Save 50% on 11.11 with DEAL-2026 at ${url}`;
  const rows = [
    { id: "campaign-A", title: text, summary: "双十一限时活动", url, metrics: { orders: 123 } },
    { id: "campaign-B", title: text, description: "日本語のキャンペーン", summary: "A title", summaryZh: "已有译文" },
    { title: "已有活动", summary: "11.11", description: url },
  ];
  let calls = 0;
  const result = await translateCampaigns(rows, {
    translateBatch: async items => {
      calls++;
      assert.deepEqual(items, [
        { id: 0, text: "Save [[PL:0]] on [[PL:1]] with [[PL:2]] at [[PL:3]]" },
        { id: 1, text: "日本語のキャンペーン" },
      ]);
      return [
        { id: 1, text: "日本站活动" },
        { id: 0, text: "[[PL:1]] 用 [[PL:2]] 立省 [[PL:0]]，链接 [[PL:3]]" },
      ];
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.translation, { status: "complete", requested: 3, translated: 3, failed: 0 });
  assert.deepEqual(result.records, [
    { ...rows[0], titleZh: `11.11 用 DEAL-2026 立省 50%，链接 ${url}` },
    { ...rows[1], titleZh: `11.11 用 DEAL-2026 立省 50%，链接 ${url}`, descriptionZh: "日本站活动" },
    rows[2],
  ]);
  assert.equal(rows[0].titleZh, undefined);
});

test("accepts valid partial results without accepting changed figures or ambiguous output IDs", async () => {
  const rows = [{ title: "Offer 40%" }, { title: "Offer 30%" }, { title: "Offer 20%" }, { title: "Coupon 100" }];
  const result = await translateCampaigns(rows, {
    translateBatch: async () => [
      { id: 0, text: "优惠 [[PL:0]]" },
      { id: 1, text: "优惠 99%" },
      { id: 2, text: "优惠 [[PL:0]]" },
      { id: 2, text: "折扣 [[PL:0]]" },
      { id: 3, text: "优惠券 [[PL:0]] 左右，网址 https://example.com" },
    ],
  });
  assert.deepEqual(result.translation, { status: "partial", requested: 4, translated: 1, failed: 3 });
  assert.deepEqual(result.records, [{ ...rows[0], titleZh: "优惠 40%" }, ...rows.slice(1)]);
});

test("bounds batches and retains rows from failed batches", async () => {
  const rows = Array.from({ length: 17 }, (_, index) => ({ title: `Campaign ${index}` }));
  const sizes = [];
  const result = await translateCampaigns(rows, {
    translateBatch: async items => {
      sizes.push(items.length);
      if (items.length === 1) throw new Error("provider unavailable");
      return items.map(({ id }) => ({ id, text: "活动 [[PL:0]]" }));
    },
  });
  assert.deepEqual(sizes, [16, 1]);
  assert.deepEqual(result.translation, { status: "partial", requested: 17, translated: 16, failed: 1 });
  assert.deepEqual(result.records.at(-1), rows.at(-1));
});

test("returns the captured records when the configured text model is unavailable", async () => {
  const rows = [{ title: "Flash sale", summary: "Shopee 限时抢购" }, { title: "全店大促" }];
  const result = await translateCampaigns(rows, { settings: {} });
  assert.deepEqual(result.records, rows);
  assert.equal(result.translation.status, "model-unavailable");
  const skipped = await translateCampaigns([rows[1]], {
    translateBatch: async () => assert.fail("skip Chinese content"),
  });
  assert.equal(skipped.translation.status, "not-needed");
});

test("calls the selected PageLens text model and reads structured results", async (t) => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  });
  globalThis.chrome = { permissions: { contains: async () => true } };
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, "https://text.example/v1/chat/completions");
    const request = JSON.parse(init.body);
    assert.equal(request.model, "selected-text");
    assert.deepEqual(JSON.parse(request.messages[1].content), [{ id: 0, text: "Mega sale" }]);
    return Response.json({ choices: [{ message: { content: '```json\n[{"id":0,"text":"超级大促"}]\n```' } }] });
  };
  const result = await translateCampaigns([{ id: "955", title: "Mega sale" }], {
    settings: { text: { baseUrl: "https://text.example/v1", model: "selected-text", apiKey: "test" } },
  });
  assert.equal(calls, 1);
  assert.equal(result.records[0].titleZh, "超级大促");
});

test("propagates cancellation without continuing translation", async () => {
  const controller = new AbortController();
  await assert.rejects(translateCampaigns([{ title: "Weekly Flash Sale" }], {
    signal: controller.signal,
    translateBatch: async () => {
      controller.abort();
      return [{ id: 0, text: "每周限时抢购" }];
    },
  }), { name: "AbortError" });
});

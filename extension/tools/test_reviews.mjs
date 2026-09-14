import {
  getIsoWeekInfo,
  formatLocalDate,
  getReviewPeriod,
  filterClippingsForPeriod,
  getClippingsMetadata,
  formatClippingsForPrompt,
  buildReviewPrompt,
  reviewNoteRelPath,
  reviewToObsidianMarkdown,
  saveReviewRecord,
  listAllReviews,
  getReviewByKey,
  deleteReviewRecord,
  generateReviewSummary,
} from "../lib/reviews.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 1. Test getIsoWeekInfo & formatLocalDate
const testDate = new Date(2026, 8, 14); // 2026-09-14 (Monday)
const isoWeek = getIsoWeekInfo(testDate);
assert(isoWeek.year === 2026, "isoWeek year: " + isoWeek.year);
assert(isoWeek.week === 38, "isoWeek week should be 38, got: " + isoWeek.week);
assert(formatLocalDate(testDate) === "2026-09-14", "formatLocalDate");

// 2. Test getReviewPeriod (Daily)
const dailyPeriod = getReviewPeriod("daily", testDate);
assert(dailyPeriod.type === "daily", "daily type");
assert(dailyPeriod.key === "2026-09-14", "daily key: " + dailyPeriod.key);
assert(dailyPeriod.label.includes("2026-09-14"), "daily label: " + dailyPeriod.label);
assert(new Date(dailyPeriod.start).getHours() === 0, "daily start 00:00");
assert(new Date(dailyPeriod.end).getHours() === 23, "daily end 23:59");
assert(formatLocalDate(new Date(dailyPeriod.prevDate)) === "2026-09-13", "daily prev date");
assert(formatLocalDate(new Date(dailyPeriod.nextDate)) === "2026-09-15", "daily next date");

// 3. Test getReviewPeriod (Weekly)
const weeklyPeriod = getReviewPeriod("weekly", testDate);
assert(weeklyPeriod.type === "weekly", "weekly type");
assert(weeklyPeriod.key === "2026-W38", "weekly key: " + weeklyPeriod.key);
assert(weeklyPeriod.week === 38, "weekly week number: " + weeklyPeriod.week);
assert(weeklyPeriod.label.includes("第38周"), "weekly label: " + weeklyPeriod.label);
assert(new Date(weeklyPeriod.start).getDay() === 1, "weekly start is Monday");
assert(new Date(weeklyPeriod.end).getDay() === 0, "weekly end is Sunday");

// 4. Test getReviewPeriod (Monthly)
const monthlyPeriod = getReviewPeriod("monthly", testDate);
assert(monthlyPeriod.type === "monthly", "monthly type");
assert(monthlyPeriod.key === "2026-09", "monthly key: " + monthlyPeriod.key);
assert(monthlyPeriod.label.includes("2026年09月"), "monthly label: " + monthlyPeriod.label);
assert(new Date(monthlyPeriod.start).getDate() === 1, "monthly start 1st");
assert(new Date(monthlyPeriod.end).getDate() === 30, "monthly end 30th for Sept");

// 5. Test filterClippingsForPeriod & getClippingsMetadata
const sampleClippings = [
  {
    id: "clip-1",
    title: "Chrome 插件 Agent 架构设计",
    url: "https://example.com/agent-arch",
    note: "关注 MV3 下 Service Worker 与侧栏通信性能",
    content: "本文详细介绍了基于 Chrome 扩展开发高可用 Agent 系统的最佳实践...",
    tags: ["架构", "Agent", "前端"],
    createdAt: new Date(2026, 8, 14, 10, 0, 0).getTime(),
  },
  {
    id: "clip-2",
    title: "大模型长上下文与思维链推理",
    url: "https://github.com/ai/research",
    note: "在多轮对话中如何压缩长材料",
    content: "长上下文虽然提供了充沛的容量，但关键信息的注意力衰减仍然存在...",
    tags: ["大模型", "AI"],
    createdAt: new Date(2026, 8, 14, 15, 30, 0).getTime(),
  },
  {
    id: "clip-3",
    title: "上周的文章（不应出现在 09-14 日度复盘中）",
    url: "https://example.com/old",
    note: "旧内容",
    content: "旧摘要",
    tags: ["历史"],
    createdAt: new Date(2026, 8, 5, 12, 0, 0).getTime(),
  },
];

const dayFiltered = filterClippingsForPeriod(sampleClippings, dailyPeriod);
assert(dayFiltered.length === 2, "daily filtered should have 2 items, got: " + dayFiltered.length);
assert(dayFiltered[0].id === "clip-1" && dayFiltered[1].id === "clip-2", "daily filtered items");

const meta = getClippingsMetadata(dayFiltered);
assert(meta.count === 2, "meta count");
assert(meta.tags.includes("架构") && meta.tags.includes("Agent") && meta.tags.includes("大模型"), "meta tags");
assert(meta.domains.includes("example.com") && meta.domains.includes("github.com"), "meta domains");

// 6. Test buildReviewPrompt
const promptDaily = buildReviewPrompt({
  type: "daily",
  clippings: dayFiltered,
  periodLabel: dailyPeriod.label,
});
assert(promptDaily.system.includes("个人知识管理"), "daily prompt system");
assert(promptDaily.user.includes("Chrome 插件 Agent 架构设计"), "daily prompt user has title");
assert(promptDaily.user.includes("关注 MV3 下 Service Worker 与侧栏通信性能"), "daily prompt user has user notes");
assert(promptDaily.user.includes("个人思考串联与反思"), "daily prompt user has reflection section");

const promptWeekly = buildReviewPrompt({
  type: "weekly",
  clippings: dayFiltered,
  periodLabel: weeklyPeriod.label,
});
assert(promptWeekly.user.includes("本周核心主题图谱"), "weekly prompt user has thematic clusters");
assert(promptWeekly.user.includes("跨领域交叉连接"), "weekly prompt user has cross-domain synergy");

const promptMonthly = buildReviewPrompt({
  type: "monthly",
  clippings: dayFiltered,
  periodLabel: monthlyPeriod.label,
});
assert(promptMonthly.user.includes("月度宏观知识全景"), "monthly prompt user has knowledge map");
assert(promptMonthly.user.includes("思维演进与心智相变"), "monthly prompt user has mental shift");

// 7. Test reviewNoteRelPath & reviewToObsidianMarkdown
const mockReview = {
  id: "review-test-1",
  type: "weekly",
  periodKey: "2026-W38",
  periodLabel: "2026年 第38周 (09.14 - 09.20)",
  title: "2026年 第38周 每周复盘",
  clippingCount: 2,
  tags: ["架构", "Agent"],
  content: "## 本周知识雷达\n\n本周主要聚焦在 Chrome 扩展与 Agent 架构...",
  createdAt: 1789401600000,
};

const notePath = reviewNoteRelPath(mockReview);
assert(notePath === "PageLens/reviews/weekly/2026-W38-review.md", "note rel path: " + notePath);

const obsMd = reviewToObsidianMarkdown(mockReview);
assert(obsMd.includes("---"), "obsidian markdown has frontmatter");
assert(obsMd.includes('type: "weekly"'), "obsidian markdown type");
assert(obsMd.includes('period_key: "2026-W38"'), "obsidian markdown period_key");
assert(obsMd.includes("本周主要聚焦在 Chrome 扩展与 Agent 架构"), "obsidian markdown body");

// 8. Test Review Storage CRUD
const mockStorage = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => ({ [key]: mockStorage[key] || [] }),
      set: async (obj) => Object.assign(mockStorage, obj),
    },
  },
};

await saveReviewRecord(mockReview);
let allReviews = await listAllReviews();
assert(allReviews.length === 1 && allReviews[0].id === "review-test-1", "saved review record");

const fetched = await getReviewByKey("2026-W38");
assert(fetched && fetched.id === "review-test-1", "getReviewByKey");

// 9. Test generateReviewSummary with mock streaming
const mockModel = { baseUrl: "https://api.mock.test", model: "mock-model", apiKey: "test-key" };
const deltas = [];
const generated = await generateReviewSummary({
  type: "daily",
  dateInput: testDate,
  clippings: dayFiltered,
  model: mockModel,
  stream: async (model, opts, onDelta) => {
    onDelta("# 今日复盘生成成功\n\n");
    onDelta("重点吸收了 Agent 架构与长上下文思考。");
    return "";
  },
  onDelta: (d) => deltas.push(d),
});

assert(generated.periodKey === "2026-09-14", "generated review periodKey: " + generated.periodKey);
assert(generated.content.includes("今日复盘生成成功"), "generated review content: " + generated.content);
assert(deltas.length === 2, "stream deltas received: " + deltas.length);

allReviews = await listAllReviews();
assert(allReviews.some((r) => r.periodKey === "2026-09-14"), "new review saved to storage");

// 10. Test deleteReviewRecord
await deleteReviewRecord(generated.id);
allReviews = await listAllReviews();
assert(!allReviews.some((r) => r.id === generated.id), "deleted review record");

console.log("PASS test_reviews");

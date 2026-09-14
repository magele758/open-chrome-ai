import assert from "node:assert/strict";
import {
  getLocalDateString,
  dailyNoteRelPath,
  isClippingInDailyNote,
  formatDailyNoteEntry,
} from "../lib/clippings.js";
import { defaultSettings, normalizeSettings } from "../lib/storage.js";

// 1. Test storage settings
const def = defaultSettings();
assert.equal(def.dailyNotesFolder, "Daily", "default dailyNotesFolder should be 'Daily'");

const norm1 = normalizeSettings({ dailyNotesFolder: " /我的日记/ " });
assert.equal(norm1.dailyNotesFolder, "我的日记", "normalize dailyNotesFolder strips slashes and spaces");

const norm2 = normalizeSettings({ dailyNotesFolder: "" });
assert.equal(norm2.dailyNotesFolder, "", "allow root folder if empty");

// 2. Test getLocalDateString
const fixedDate = new Date(2026, 8, 14, 15, 30, 0); // September 14, 2026 local time
const dayStr = getLocalDateString(fixedDate.getTime());
assert.equal(dayStr, "2026-09-14", "getLocalDateString formats YYYY-MM-DD");

// 3. Test dailyNoteRelPath
assert.equal(dailyNoteRelPath("Daily", fixedDate.getTime()), "Daily/2026-09-14.md");
assert.equal(dailyNoteRelPath("/日记/工作/", fixedDate.getTime()), "日记/工作/2026-09-14.md");
assert.equal(dailyNoteRelPath("/Users/penglei/Notes/Daily", fixedDate.getTime(), "/Users/penglei/Notes"), "Daily/2026-09-14.md");
assert.equal(dailyNoteRelPath("", fixedDate.getTime()), "2026-09-14.md");
assert.equal(dailyNoteRelPath(null, fixedDate.getTime()), "2026-09-14.md");

// 4. Test formatDailyNoteEntry
const sampleClip = {
  id: "test-clip-123",
  title: "AI 编程智能体大规模架构",
  url: "https://example.com/ai-agents?utm_source=twitter",
  note: "重点关注 Level 3 和 Level 5 的状态机",
  content: "多智能体协作与云端沙箱隔离是关键设计。",
  tags: ["agent", "架构"],
  createdAt: fixedDate.getTime(),
};

const entry = formatDailyNoteEntry(sampleClip);
assert(entry.includes("### 📌 [AI 编程智能体大规模架构](https://example.com/ai-agents?utm_source=twitter)"), "entry title link");
assert(entry.includes("- ⏱️ **采摘时间**：15:30:00"), "entry time");
assert(entry.includes("clipping_id: test-clip-123"), "entry clipping id");
assert(entry.includes("- 🏷️ **标签**：#agent #架构"), "entry tags");
assert(entry.includes("> 💡 **我的思考**：重点关注 Level 3 和 Level 5 的状态机"), "entry note");
assert(entry.includes("多智能体协作与云端沙箱隔离是关键设计。"), "entry content");

// 5. Test isClippingInDailyNote deduplication
const existingDaily = `# 2026-09-14

## 📌 内容采摘

### 📌 [早间新闻](https://news.example.com/morning)
- ⏱️ **采摘时间**：09:00:00
这是一条早间新闻。

${entry}
`;

// Deduplication checks:
assert(isClippingInDailyNote(existingDaily, sampleClip), "should detect exact url & id in daily note");

const sampleClipCleanUrl = {
  ...sampleClip,
  url: "https://example.com/ai-agents", // stripped utm param
};
assert(isClippingInDailyNote(existingDaily, sampleClipCleanUrl), "should detect normalized url");

const sampleClipById = {
  id: "test-clip-123",
  title: "完全不一样的标题",
  url: "https://other.com",
};
assert(isClippingInDailyNote(existingDaily, sampleClipById), "should detect by clipping_id");

const sampleClipByTitle = {
  title: "早间新闻",
  url: "https://news.example.com/morning",
};
assert(isClippingInDailyNote(existingDaily, sampleClipByTitle), "should detect by title and url");

const newClip = {
  id: "brand-new-clip",
  title: "全新未知内容",
  url: "https://novel.org/item-999",
};
assert(!isClippingInDailyNote(existingDaily, newClip), "should not detect new item");

console.log("PASS test_daily_notes");

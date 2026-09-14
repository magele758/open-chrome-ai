import {
  normalizeClippingUrl,
  clippingSlug,
  clippingNoteRelPath,
  clippingToObsidianMarkdown,
  formatBookmarkTitle,
  yamlScalar,
  saveClippingRecord,
  listAllClippings,
  deleteClippingRecord,
  deleteClippingFull,
} from "../lib/clippings.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 1. Test normalizeClippingUrl
const u1 = "https://example.com/blog/article?utm_source=twitter&utm_medium=social&foo=bar#section-2";
const norm1 = normalizeClippingUrl(u1);
assert(norm1 === "https://example.com/blog/article?foo=bar", "should remove utm_* and hash: " + norm1);

const u2 = "https://github.com/torvalds/linux?spm=123.456&ref=hackernews";
const norm2 = normalizeClippingUrl(u2);
assert(norm2 === "https://github.com/torvalds/linux", "should strip spm and ref: " + norm2);

const u3 = "https://example.com/";
assert(normalizeClippingUrl(u3) === "https://example.com", "should normalize root trailing slash");

// 2. Test clippingSlug
assert(clippingSlug("Hello World! 123") === "Hello-World-123", "slug basic");
assert(clippingSlug("深度解读：大模型 Agent 架构设计指南") === "深度解读-大模型-Agent-架构设计指南", "slug chinese");

// 3. Test clippingNoteRelPath
const clipSample = {
  id: "abc12345-test-uuid",
  title: "Agent 路由架构",
  createdAt: 1726108800000, // 2024-09-12T02:40:00.000Z
};
const rel = clippingNoteRelPath(clipSample);
assert(rel.startsWith("PageLens/clippings/"), "rel prefix");
assert(rel.endsWith(".md"), "rel extension");
assert(rel.includes("Agent-路由架构"), "rel contains title slug: " + rel);
assert(rel.includes("abc12345"), "rel contains short id: " + rel);

// 4. Test clippingToObsidianMarkdown
const fullClip = {
  id: "test-clip-1",
  title: "深度解析 Gemini Flash 架构",
  url: "https://example.com/gemini-flash",
  note: "重点关注多模态同传与长上下文机制",
  content: "Gemini Flash 采用了高度优化的推断流水线，支持流式首字低延迟...",
  tags: ["ai", "大模型", "架构设计"],
  createdAt: 1726108800000,
};

const md = clippingToObsidianMarkdown(fullClip);
assert(md.includes("---"), "has frontmatter header");
assert(md.includes(`title: "深度解析 Gemini Flash 架构"`), "frontmatter title");
assert(md.includes(`url: "https://example.com/gemini-flash"`), "frontmatter url");
assert(md.includes(`"ai"`), "has tag ai");
assert(md.includes(`"大模型"`), "has tag 大模型");
assert(md.includes("## 💡 个人思考 / 备注"), "has note section");
assert(md.includes("重点关注多模态同传与长上下文机制"), "has note content");
assert(md.includes("## 🤖 AI 核心提炼"), "has AI content section");
assert(md.includes("Gemini Flash 采用了高度优化的推断流水线"), "has content text");
assert(md.includes("[深度解析 Gemini Flash 架构](https://example.com/gemini-flash)"), "has markdown source link");

// 5. Test formatBookmarkTitle
assert(
  formatBookmarkTitle("官方文档", "非常重要的指南") === "[非常重要的指南] 官方文档",
  "format bookmark with short note"
);
assert(
  formatBookmarkTitle("文章标题", "这是一段非常非常长的思考与备注超过了十五个字") ===
    "[这是一段非常非常长的思考与备注…] 文章标题",
  "format bookmark with long note"
);
assert(formatBookmarkTitle("文章标题", "") === "文章标题", "format bookmark with empty note");

// 6. Test deleteClippingFull and deleteClippingRecord
const mockStorage = {};
const deletedBookmarks = [];
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => ({ [key]: mockStorage[key] || [] }),
      set: async (obj) => Object.assign(mockStorage, obj),
    },
  },
  bookmarks: {
    remove: async (id) => deletedBookmarks.push(id),
  },
};

const testClip = {
  id: "del-test-1",
  title: "待删除测试",
  url: "https://example.com/del",
  bookmarkId: "bm-999",
  createdAt: Date.now(),
};

await saveClippingRecord(testClip);
let all = await listAllClippings();
assert(all.length === 1 && all[0].id === "del-test-1", "saved clipping record");

const delRes = await deleteClippingFull(testClip);
assert(delRes.ok === true, "deleteClippingFull ok");
all = await listAllClippings();
assert(all.length === 0, "record removed from storage");
assert(deletedBookmarks.includes("bm-999"), "bookmark removed");

console.log("PASS test_clippings");

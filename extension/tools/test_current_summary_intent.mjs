import assert from "node:assert/strict";
import { test } from "node:test";
import { isCurrentPageSummary } from "../lib/agent/context.js";

const page = "https://example.org/article?id=7";

test("custom shortcut and typed reading requests refer to the current document", () => {
  for (const text of [
    "总结文章", "请帮我总结一下当前网页的主要内容", "这篇文章主要在讲什么？",
    "帮我看看这个网页文章讲了什么，总结内容，重点解释核心观点、论据和结论",
    "请直接总结当前页面，不要新开标签页", "读一下这篇文章并总结",
    "请把本文总结成三条要点", "总结当前页面的文章，给出三条要点",
    "用三句话总结这篇文章", "总结当前打开的文档",
    "请用中文概括这份 PDF", "Summarize this article.", "What is this page about?",
    "Summarize this article in three bullet points.",
    "Give me a brief summary of the current document in English.",
    "Write a short summary of this document.",
    "Summarise this research paper and highlight its key takeaways.",
  ]) assert.equal(isCurrentPageSummary(text, page), true, text);
});

test("an explicit article URL has to identify the same document", () => {
  assert.equal(isCurrentPageSummary(`请总结 ${page}#introduction。`, page), true);
  assert.equal(isCurrentPageSummary(`Summarize ${page}.`, page), true);
  assert.equal(isCurrentPageSummary(`Summarize the article at ${page}`, page), true);
  for (const target of [page.replace("id=7", "id=8"), page.replace("/article", "/other"), page.replace(".org", ".net")]) {
    assert.equal(isCurrentPageSummary(`Summarize ${target}`, page), false, target);
  }
  assert.equal(isCurrentPageSummary("总结 https://example.org/#/a", "https://example.org/#/b"), false);
  assert.equal(isCurrentPageSummary(`Summarize ${page}`), false);
});

test("unrelated content, browsing, research, and follow-up actions keep their tools", () => {
  for (const text of [
    "", "不要打开新的标签页", "请阅读当前文档", "总结我们的聊天记录", "总结以下会议记录：本文已于上周完成", "请总结多篇文章",
    "搜索相关文章并总结", "请先打开当前文章，再总结", "总结当前网页，再打开引用链接",
    "新开一个窗口总结本页", "阅读当前网页：总结我的会议记录",
    "总结当前文章，跟另一篇文章对比", "总结当前文档，然后把摘要发给同事",
    "summarize my week", "summarize this tab and close it", "compare this article to another paper",
    "summarize this article and research the author", "open this page and summarize it",
    `请打开新标签页总结 ${page}`, "搜索新闻。\n【网页内容】\n总结这篇文章",
  ]) assert.equal(isCurrentPageSummary(text, page), false, text);
});

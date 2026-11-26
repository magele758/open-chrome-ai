import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createAgentTools } from "../lib/agent/tools.js";
import { interceptToolOutput } from "../lib/agent/tool-guardian.js";
import { loadTabPack } from "../lib/page-pack.js";
import { PDF_MAX_CHARS } from "../lib/pdf-text.js";

test("a long article can be read past its preview and paged from the original tab", async t => {
  const tab = { id: 37, windowId: 4, url: "https://example.org/posts/field-notes" };
  const conclusion = "The final comparison found that the downstream sample was warmer.";
  const paragraphs = Array.from({ length: 90 }, (_, i) =>
    `<p>Sampling station ${i + 1}. ${"The river temperature was recorded in the morning. ".repeat(5)}</p>`);
  const dom = new JSDOM(`<main><article>${paragraphs.join("")}<p>${conclusion}</p></article></main>`,
    { url: tab.url, runScripts: "outside-only" });
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
  const previous = globalThis.chrome;
  t.after(() => { window.close(); globalThis.chrome = previous; });
  globalThis.chrome = {
    tabs: { get: async id => { assert.equal(id, tab.id); return tab; } },
    scripting: { executeScript: async ({ func, target, args }) => {
      assert.equal(target.tabId, tab.id);
      return [{ result: await window.eval(`(${func})`)(...args) }];
    } },
  };

  const preview = await loadTabPack(tab.id);
  assert.equal(preview.tabId, tab.id);
  assert.equal(preview.text.length, 9000);
  assert.equal(preview.textTruncated, true);
  assert.ok(!preview.text.includes(conclusion));
  const tools = createAgentTools({
    getTabId: () => tab.id, getWindowId: () => tab.windowId,
    refreshPack: id => loadTabPack(id, { fullArticle: true }),
  });
  const extract = tools.find(tool => tool.name === "extract_page");
  const content = await extract.execute({});
  assert.ok(content.endsWith(conclusion));
  assert.doesNotMatch(content, /超过提取上限/);
  const archived = await interceptToolOutput({ toolName: "extract_page", content });
  assert.ok(archived.intercepted);
  const read = tools.find(tool => tool.name === "read_tool_page");
  const lastPage = JSON.parse(await read.execute({ handle: archived.handle, page: archived.manifest.totalPages }));
  assert.ok(lastPage.content.endsWith(conclusion));

  window.document.querySelector("article p").textContent = "X".repeat(60001);
  const bounded = await extract.execute({});
  assert.match(bounded, /超过提取上限/);
  assert.ok(bounded.endsWith("X".repeat(60000)));
  assert.ok(!bounded.includes(conclusion));

  const sharedPrefix = "Shared measurement conditions. ".repeat(6);
  window.document.querySelector("article").insertAdjacentHTML("beforeend",
    `<p>${sharedPrefix}first sample</p><p>${sharedPrefix}second sample</p>
    <div>DIV_ONLY</div><table><tr><td>18°C</td></tr></table>
    <article data-testid="tweet">Embedded quotation</article><footer>Footnote 1</footer><nav>NOT_ARTICLE</nav>`);
  const source = await loadTabPack(tab.id, { summarySource: true });
  assert.equal(source.textTruncated, false);
  assert.ok(source.text.length > 60000);
  for (const fact of [conclusion, "first sample", "second sample", "DIV_ONLY", "18°C", "Footnote 1"]) {
    assert.ok(source.text.includes(fact), `full article contains ${fact}`);
  }
  assert.doesNotMatch(source.text, /NOT_ARTICLE/);

  tab.url = "https://x.com/fixture/status/1";
  dom.reconfigure({ url: tab.url });
  window.document.body.innerHTML = `<article data-testid="tweet"><div data-testid="twitterArticleRichTextView">
    <p>${"X".repeat(70000)}</p><p>X_ARTICLE_END</p></div></article>`;
  const xSource = await loadTabPack(tab.id, { summarySource: true });
  assert.equal(xSource.kind, "x");
  assert.equal(xSource.textTruncated, false);
  assert.match(xSource.text, /X_ARTICLE_END$/);
});

test("the scoped PDF reader retains the PDF extractor's full text budget", async () => {
  const text = "p".repeat(PDF_MAX_CHARS - 14) + "PDF conclusion";
  const pdf = { kind: "pdf", text, title: "Report" };
  const read = async fullArticle => {
    const tools = createAgentTools({ getTabId: () => 1, refreshPack: async () => ({ ...pdf, fullArticle }) });
    return tools.find(tool => tool.name === "extract_page").execute({});
  };
  assert.doesNotMatch(await read(false), /PDF conclusion/);
  assert.match(await read(true), /PDF conclusion$/);
});

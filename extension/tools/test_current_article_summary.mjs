import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM, VirtualConsole } from "jsdom";
import { browserFixture } from "../../scripts/bombadil/browser-fixture.mjs";
import { itemKey, normalizeRun } from "../lib/sessions.js";

const articleUrl = "https://fixture.invalid/article";
const articleText = "这篇文章介绍了环境监测站如何从河流采样并校准测量值。";
const otherTabText = "另一标签的内容。";
const externalUrl = "https://reference.invalid/read-more";
const prompt = "帮我看看这个网页文章讲了什么，总结内容，重点解释核心观点、论据和结论";
const answer = "文章介绍了河流的采样和校准方法。";
const articleTail = "长期跟踪发现采样站需要在汛期额外校准。";
const fullArticle = articleText + "\n" + "A long term temperature series. ".repeat(380) + articleTail;

async function until(condition, description) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (condition()) return;
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function callTool(id, name, args) {
  return { role: "assistant", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}

function startPanel(html) {
  const { window } = new JSDOM(html, {
    url: "https://fixture.invalid/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
    virtualConsole: new VirtualConsole(),
    beforeParse(browser) {
      Object.assign(browser, { TextDecoder, TextEncoder, structuredClone });
      browser.navigator.locks = { request: async (name, options, fn) => (fn || options)({ name }) };
      browser.HTMLElement.prototype.scrollIntoView = () => {};
    },
  });
  const executeScript = window.chrome.scripting.executeScript;
  window.chrome.scripting.executeScript = async spec => {
    const entries = await executeScript(spec);
    for (const entry of entries) entry.result.text = spec.target.tabId === 18
      ? (spec.args?.[0]?.summarySource ? fullArticle : fullArticle.slice(0, 9000)) : otherTabText;
    return entries;
  };
  return window;
}

function useModel(window, script) {
  const requests = [];
  window.fetch = async (url, options) => {
    assert.ok(String(url).startsWith("https://model.invalid/"));
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "fixture", context_length: 65536 }] });
    const message = script[requests.length];
    assert.ok(message, "unexpected model call");
    requests.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] });
  };
  return requests;
}

function offeredNames(request) {
  return (request.tools || []).map(tool => tool.function.name);
}

function assertSummaryRequest(request) {
  assert.deepEqual(offeredNames(request), [], "the model gets the source directly and cannot open or page through tabs");
  assert.ok(request.max_tokens > 0);
}

test("总结文章 sends the complete original article in one model round even when focus changes", async () => {
  const window = startPanel(await browserFixture("panel"));
  const { chrome, document } = window;
  const created = [];
  const grouped = [];
  chrome.tabs.create = async options => {
    created.push(options.url);
    return { id: 19, windowId: 1, url: options.url };
  };
  chrome.tabs.group = async options => {
    grouped.push(options.tabIds);
    return 20;
  };
  const checkpoints = [];
  chrome.storage.onChanged.addListener((changes, area) => {
    const run = changes[itemKey("Alpha")]?.newValue?.run;
    if (area === "local" && run) checkpoints.push(run);
  });
  const activate = id => document.dispatchEvent(new window.CustomEvent("fixture-activate-tab", { detail: id }));
  const requests = useModel(window, [
    { role: "assistant", content: answer },
    callTool("explicit-new-page", "open_tab", { url: externalUrl }),
    { role: "assistant", content: "已打开链接。" },
  ]);

  try {
    await chrome.storage.local.set({ settings: {
      text: { model: "fixture", apiKey: "fixture", baseUrl: "https://model.invalid" },
      shortcuts: [{ id: "summarize", label: "总结文章", prompt }],
    } });
    const summaryButton = () => [...document.querySelectorAll("#skills button")].find(button => button.textContent === "总结文章");
    const chip = () => document.getElementById("compose-chip-label")?.textContent;
    await until(() => summaryButton() && chip()?.includes("Fixture video"), "configured sidebar shortcut and initial tab");
    activate(18);
    await until(() => chip()?.includes("Fixture article"), "article tab context");
    const acquire = window.navigator.locks.request;
    let switchedTab = false;
    window.navigator.locks.request = async (name, ...args) => {
      if (!switchedTab && name === "pagelens-agent-window-1") {
        switchedTab = true;
        activate(17);
        await until(() => chip()?.includes("Fixture video"), "tab switched while acquiring the window lock");
      }
      return acquire(name, ...args);
    };
    summaryButton().click();
    await until(() => document.querySelector("#msgs")?.textContent.includes(answer) && !document.querySelector(".stream-live"), "article summary");
    assert.equal(requests.length, 1);
    assert.ok(switchedTab);
    for (const request of requests) assertSummaryRequest(request);
    assert.ok(checkpoints.some(run => run.summaryPageUrl === articleUrl && run.windowId === 1 && run.tabId === 18), "reload should have the original tab and URL in storage");
    const initial = requests[0].messages.findLast(message => message.role === "user");
    assert.ok(initial.content.includes(prompt));
    assert.ok(initial.content.includes(articleUrl));
    assert.ok(initial.content.includes(articleText));
    assert.ok(initial.content.includes(fullArticle), "the first request must contain the complete tail beyond the preview");
    assert.ok(!initial.content.includes(otherTabText));
    assert.deepEqual(created, [], "an unadvertised tool call must not open a tab");
    assert.deepEqual(grouped, [], "summarizing the current article should leave its tab group unchanged");

    const input = document.getElementById("input");
    input.value = `请打开一个新的标签页访问 ${externalUrl} 。`;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.getElementById("btn-send").click();
    await until(() => document.querySelector("#msgs")?.textContent.includes("已打开链接。") && !document.querySelector(".stream-live"), "separate explicit browser request");
    assert.ok(offeredNames(requests[1]).includes("open_tab"), "explicit navigation should remain available on the next request");
    assert.deepEqual(created, [externalUrl], "only the explicitly requested tab should open");
  } finally {
    window.close();
  }
});

test("an initially empty article is read from its own tab when text becomes available", async () => {
  const window = startPanel(await browserFixture("panel"));
  const { chrome, document } = window;
  const created = [];
  chrome.tabs.create = async options => {
    created.push(options.url);
    return { id: 19, windowId: 1, url: options.url };
  };
  const requests = useModel(window, [{ role: "assistant", content: answer }]);
  const executeScript = chrome.scripting.executeScript;
  let fullReads = 0;
  chrome.scripting.executeScript = async spec => {
    const entries = await executeScript(spec);
    if (!spec.args?.[0]?.summarySource || ++fullReads <= 1) {
      for (const entry of entries) entry.result.text = "";
    }
    return entries;
  };
  try {
    const chip = () => document.getElementById("compose-chip-label")?.textContent;
    await until(() => chip()?.includes("Fixture video"), "initial page");
    document.dispatchEvent(new window.CustomEvent("fixture-activate-tab", { detail: 18 }));
    await until(() => chip()?.includes("Fixture article"), "article metadata");
    const input = document.getElementById("input");
    const question = "请总结这篇文章。";
    input.value = question;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.getElementById("btn-send").click();
    await until(() => document.querySelector("#msgs")?.textContent.includes(answer) && !document.querySelector(".stream-live"), "summary after article loads");
    assert.equal(requests.length, 1);
    assert.equal(fullReads, 2);
    for (const request of requests) assertSummaryRequest(request);
    const initial = requests[0].messages.findLast(message => message.role === "user");
    assert.ok(initial.content.includes(question) && initial.content.includes(fullArticle));
    assert.ok(initial.content.includes(articleUrl));
    assert.deepEqual(created, []);
  } finally {
    window.close();
  }
});

test("the sidebar uses the selected small model window to summarize every section before answering", async () => {
  const window = startPanel(await browserFixture("panel"));
  const { document } = window;
  const sections = [];
  let combined;
  window.fetch = async (url, options) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "fixture", context_length: 1700 }] });
    const request = JSON.parse(options.body);
    assertSummaryRequest(request);
    const content = request.messages.at(-1).content;
    const part = content.match(/<untrusted_page source="page">\n([\s\S]*)\n<\/untrusted_page>$/)?.[1];
    let text;
    if (part !== undefined) {
      sections.push(part);
      text = `Field note ${sections.length}${part.includes(articleTail) ? ": tail verified" : ""}`;
    } else {
      combined = content;
      text = answer;
    }
    return Response.json({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] });
  };
  try {
    const chip = () => document.getElementById("compose-chip-label")?.textContent;
    await until(() => chip()?.includes("Fixture video"), "starting page");
    document.dispatchEvent(new window.CustomEvent("fixture-activate-tab", { detail: 18 }));
    await until(() => chip()?.includes("Fixture article"), "original article");
    const input = document.getElementById("input");
    input.value = prompt;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.getElementById("btn-send").click();
    await until(() => document.querySelector("#msgs")?.textContent.includes(answer) && !document.querySelector(".stream-live"), "combined summary");
    assert.ok(sections.length > 1);
    assert.equal(sections.join(""), fullArticle);
    assert.ok(combined.includes("Field note 1"));
    assert.ok(combined.includes("tail verified"));
  } finally {
    window.close();
  }
});

test("unsolicited model tool calls cannot open an article tab", async () => {
  const window = startPanel(await browserFixture("panel"));
  const { chrome, document } = window;
  const created = [];
  chrome.tabs.create = async options => { created.push(options.url); };
  const requests = useModel(window, [callTool("duplicate-current-document", "open_tab", { url: articleUrl })]);
  try {
    await until(() => document.getElementById("compose-chip-label")?.textContent.includes("Fixture video"), "initial page");
    document.dispatchEvent(new window.CustomEvent("fixture-activate-tab", { detail: 18 }));
    await until(() => document.getElementById("compose-chip-label")?.textContent.includes("Fixture article"), "article");
    const input = document.getElementById("input");
    input.value = prompt;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.getElementById("btn-send").click();
    await until(() => document.querySelector("#msgs")?.textContent.includes("请求失败"), "invalid model response");
    assert.equal(requests.length, 1);
    assert.deepEqual(created, []);
  } finally {
    window.close();
  }
});

test("session normalization preserves the saved summary source and accepts older unrestricted runs", () => {
  const run = {
    status: "running", tabId: 18, windowId: 1, startedAt: Date.now(),
    history: [{ role: "user", content: prompt }],
  };
  const scoped = normalizeRun({ ...run, summaryPageUrl: articleUrl });
  assert.equal(scoped.summaryPageUrl, articleUrl);
  assert.equal(scoped.tabId, 18);
  assert.equal(scoped.windowId, 1);
  const legacy = normalizeRun(run);
  assert.equal(legacy.tabId, 18);
  assert.ok(!Object.hasOwn(legacy, "summaryPageUrl"));
});

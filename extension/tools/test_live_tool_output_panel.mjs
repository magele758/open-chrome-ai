import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM, VirtualConsole } from "jsdom";
import { browserFixture } from "../../scripts/bombadil/browser-fixture.mjs";

const encoder = new TextEncoder();
const sse = data => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
const completion = (delta, finish_reason = null) => ({ choices: [{ delta, finish_reason }] });

async function until(predicate, description) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

test("the sidebar shows a rate for streamed tool arguments and keeps it while waiting for the next model round", async () => {
  const errors = [];
  const html = await browserFixture("panel");
  const { window } = new JSDOM(html, {
    url: "https://fixture.invalid/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
    virtualConsole: new VirtualConsole().on("jsdomError", error => errors.push(error.message)),
    beforeParse(browser) {
      Object.assign(browser, { TextEncoder, TextDecoder, structuredClone });
      browser.navigator.locks = { request: async (name, options, fn) => (fn || options)({ name }) };
      browser.HTMLElement.prototype.scrollIntoView = () => {};
    },
  });
  const { document } = window;
  const requests = [];
  let finishToolTurn;
  let answer;
  const toolTurn = new Promise(resolve => { finishToolTurn = resolve; });
  const nextAnswer = new Promise(resolve => { answer = resolve; });

  window.fetch = async (url, options) => {
    assert.ok(String(url).startsWith("https://model.invalid/"), `Unexpected fetch ${url}`);
    const round = requests.push(JSON.parse(options.body));
    assert.ok(round <= 2, `Unexpected model round ${round}`);
    const stream = new ReadableStream({
      async start(controller) {
        if (round === 1) {
          controller.enqueue(sse(completion({ tool_calls: [{ index: 0, id: "call_fixture",
            function: { name: "get_page_info", arguments: "{" } }] })));
          await delay(400);
          controller.enqueue(sse(completion({ tool_calls: [{ index: 0,
            function: { arguments: '"tabId":17}' } }] })));
          await toolTurn;
          controller.enqueue(sse(completion({}, "tool_calls")));
          controller.enqueue(sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 } }));
        } else {
          await nextAnswer;
          controller.enqueue(sse(completion({ content: "已读取页面。" }, "stop")));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  };

  const live = () => document.querySelector("#msgs .stream-live");
  const metric = name => live()?.querySelector(`[data-k="${name}"]`)?.textContent;
  try {
    await until(() => document.documentElement.dataset.pagelensWired === "1", "sidebar startup");
    const input = document.getElementById("input");
    // This request uses the general browser prompt, whose tab-layout rules are checked below.
    input.value = "请读取当前页的标题结构。";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.getElementById("btn-send").click();

    await until(() => live()?.dataset.phase === "calling" && /≈[1-9]\d*(?:\.\d+)? Token\/秒/.test(metric("speed")),
      "live model output speed from tool arguments");
    finishToolTurn();
    await until(() => requests.length === 2 && live()?.dataset.phase === "waiting", "next model round");
    const result = requests[1].messages.find(message => message.role === "tool");
    const tokensWhileWaiting = metric("tokens");
    const speedWhileWaiting = metric("speed");

    answer();
    await until(() => !live() && document.querySelector("#msgs")?.textContent.includes("已读取页面。"), "final answer");
    const policy = requests[0].messages.find(message => message.role === "system")?.content;
    assert.match(policy, /总结当前网页或文档时先用已有正文/);
    assert.match(policy, /阅读、总结、普通网页操作和多来源资料比较保持现有标签布局/);
    assert.match(policy, /只有批量浏览器自动化[^。]+taskGroup=true/);
    const toolPayload = result?.content.match(/^<untrusted_page source="get_page_info">\n([\s\S]+)\n<\/untrusted_page>$/)?.[1];
    assert.ok(toolPayload, "The page information should reach the next request as untrusted content");
    const page = JSON.parse(toolPayload);
    assert.equal(page.url, "https://fixture.invalid/video");
    assert.equal(page.domAvailable, true);
    assert.equal(tokensWhileWaiting, "24 Token");
    assert.match(speedWhileWaiting, /^上轮生成 ≈[0-9.]+ Token\/秒$/);
    assert.deepEqual(errors, []);
  } finally {
    finishToolTurn();
    answer();
    window.close();
  }
});

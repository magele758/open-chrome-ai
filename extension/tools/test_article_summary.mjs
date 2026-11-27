import assert from "node:assert/strict";
import { test } from "node:test";
import { runArticleSummary } from "../lib/article-summary.js";
import { estimateMessagesTokens } from "../lib/openai.js";

const article = { title: "Estuary field notes", url: "https://example.org/notes" };
const request = "请总结这篇文章的证据与结论。";
function budget(inputTokens, outputTokens = 256) {
  return { contextTokens: inputTokens + outputTokens + 128, inputTokens, outputTokens };
}
function summary(text) {
  return { content: text, finishReason: "stop", toolCalls: [] };
}
function bodyOf(messages, source = "page") {
  const last = messages.at(-1).content;
  const opening = `<untrusted_page source="${source}">\n`;
  assert.ok(last.includes(opening), `missing source ${source}`);
  return last.slice(last.indexOf(opening) + opening.length, last.lastIndexOf("\n</untrusted_page>"));
}

test("a fitting 27k article reaches one final request intact, ahead of oversized chat history", async () => {
  const text = "At low tide, observers recorded different bird species. ".repeat(490) + "Conclusion from the last day.";
  assert.ok(text.length > 27000);
  const calls = [];
  const limits = budget(10000, 1000);
  const result = await runArticleSummary({
    request, pack: { ...article, text }, budget: limits,
    history: [{ role: "user", content: "unrelated ".repeat(15000) }, { role: "assistant", content: "old" }],
    runTurn: async call => {
      calls.push(call);
      return summary("The article compares bird counts.");
    },
  });
  assert.equal(result.content, "The article compares bird counts.");
  assert.equal(calls.length, 1);
  const { stage, maxTokens, messages } = calls[0];
  assert.equal(stage, "final");
  assert.equal(maxTokens, limits.outputTokens);
  assert.equal(bodyOf(messages), text);
  assert.equal(messages.length, 2);
  assert.ok(messages[1].content.includes(article.title) && messages[1].content.includes(article.url));
  assert.ok(messages[1].content.includes(request));
  assert.ok(estimateMessagesTokens(messages) <= limits.inputTokens);
  assert.doesNotMatch(messages[0].content, /extract_page|read_tool_page/);
});

test("oversized text is covered in order, including its tail, and notes are reduced for a small window", async () => {
  const text = Array.from({ length: 90 }, (_, i) =>
    `Station ${i}: ${"Intertidal field observations. ".repeat(20)}🌊${i === 89 ? " FINAL-FINDING" : ""}\n`).join("");
  const limits = budget(760, 256);
  const parts = [];
  const stages = [];
  const result = await runArticleSummary({
    request, pack: { ...article, text }, budget: limits,
    runTurn: async ({ stage, messages, maxTokens }) => {
      stages.push(stage);
      assert.ok(estimateMessagesTokens(messages) <= limits.inputTokens);
      assert.ok(maxTokens <= limits.outputTokens);
      const body = bodyOf(messages, stage === "segment" ? "page" : "article-notes");
      if (stage === "segment") {
        parts.push(body);
        assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(body));
        return summary(`Evidence condensed. ${"Coastal trends were recorded at each station. ".repeat(5)}${body.includes("FINAL-FINDING") ? " FINAL-FINDING" : ""}`);
      }
      if (stage === "reduce") return summary(body.includes("FINAL-FINDING") ? "FINAL-FINDING" : "Field data");
      assert.ok(body.includes("FINAL-FINDING"));
      return summary("All stations covered, including the final finding.");
    },
  });
  assert.equal(parts.join(""), text);
  assert.ok(stages.includes("reduce"));
  assert.equal(stages.filter(stage => stage === "final").length, 1);
  assert.ok(result.content.includes("final finding"));
});

test("an alias reporting a smaller real context replans after rejection without dropping source", async () => {
  const text = "Measured water levels are lower at the second station. ".repeat(220) + "FINAL-FINDING";
  const rejected = [], accepted = [];
  const result = await runArticleSummary({
    request, pack: { ...article, text }, budget: budget(12000, 2048),
    runTurn: async ({ stage, messages, maxTokens }) => {
      if (estimateMessagesTokens(messages) + maxTokens > 1200) {
        rejected.push(stage);
        throw new Error("400 maximum context length is 1200 tokens");
      }
      if (stage === "segment") {
        const part = bodyOf(messages);
        accepted.push(part);
        return summary(part.includes("FINAL-FINDING") ? "FINAL-FINDING" : "Lower water levels.");
      }
      assert.ok(bodyOf(messages, "article-notes").includes("FINAL-FINDING"));
      return summary("Final answer.");
    },
  });
  assert.deepEqual(rejected, ["final"]);
  assert.equal(accepted.join(""), text);
  assert.equal(result.content, "Final answer.");
});

test("optional history is discarded before a provider limit makes the article split", async () => {
  const text = "Short article.";
  const calls = [];
  await runArticleSummary({
    request, pack: { ...article, text }, budget: budget(9000), history: [
      { role: "user", content: "Earlier question." }, { role: "assistant", content: "Earlier answer." },
    ],
    runTurn: async ({ stage, messages }) => {
      calls.push(stage);
      if (messages.length > 2) throw new Error("context_length_exceeded");
      assert.equal(bodyOf(messages), text);
      return summary("OK");
    },
  });
  assert.deepEqual(calls, ["final", "final"]);
});

test("cancellation during segmentation prevents a final or subsequent section request", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(runArticleSummary({
    request, pack: { ...article, text: "🌊tide ".repeat(7000) }, budget: budget(800), signal: controller.signal,
    runTurn: async ({ stage, signal }) => {
      calls++;
      assert.equal(stage, "segment");
      assert.equal(signal, controller.signal);
      controller.abort();
      return summary("Notes");
    },
  }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("incomplete source, truncated or empty answers and unsolicited tools cannot count as a successful summary", async () => {
  const args = { request, pack: { ...article, text: "Whole source" }, budget: budget(1600) };
  await assert.rejects(runArticleSummary({ ...args, pack: { ...args.pack, textTruncated: true }, runTurn: assert.fail }), /未提取完整/);
  for (const result of [summary(""), summary("<think>internal text</think>"), { ...summary("Partial"), finishReason: "length" }, { ...summary(""), toolCalls: [{ name: "open_tab" }] }]) {
    await assert.rejects(runArticleSummary({ ...args, runTurn: async () => result }));
  }
  let calls = 0;
  await assert.rejects(runArticleSummary({ ...args, runTurn: async () => { calls++; throw new Error("401 unauthorized"); } }), /401/);
  assert.equal(calls, 1);
});

test("unknown model aliases get one whole-document attempt above the conservative estimate", async () => {
  const text = "Comparison of experimental and control stations. ".repeat(2200) + "TAIL";
  const limits = { ...budget(1500, 128), source: "estimate" };
  let calls = 0;
  await runArticleSummary({
    request, pack: { ...article, text }, budget: limits, history: [{ role: "user", content: "Previous request" }],
    runTurn: async ({ stage, messages }) => {
      calls++;
      assert.equal(stage, "final");
      assert.equal(bodyOf(messages), text);
      assert.equal(messages.length, 2);
      return summary("Complete answer");
    },
  });
  assert.equal(calls, 1);

  let rejected = 0;
  const parts = [];
  await runArticleSummary({
    request, pack: { ...article, text }, budget: limits,
    runTurn: async ({ stage, messages }) => {
      if (estimateMessagesTokens(messages) > limits.inputTokens) {
        rejected++;
        throw new Error("input is too long");
      }
      if (stage === "segment") parts.push(bodyOf(messages));
      return summary("Short summary");
    },
  });
  assert.equal(rejected, 1);
  assert.equal(parts.join(""), text);
});

test("persistent context rejection terminates even if advertised limits contradict the provider", async () => {
  let calls = 0;
  await assert.rejects(runArticleSummary({
    request, pack: { ...article, text: "Field observations. ".repeat(1500) }, budget: budget(1400),
    runTurn: async () => {
      assert.ok(calls++ < 20, "should shrink the failed request until no source can fit");
      throw new Error("maximum context length is 99999 tokens");
    },
  }), /上下文不足/);
  assert.ok(calls > 1 && calls < 20);
});

test("explicit article selections stay identifiable and reasoning-only text is not an answer", async () => {
  const selection = "Evidence for condition B.";
  const pack = { ...article, text: `Intro. ${selection} Final note.`, selection };
  await assert.rejects(runArticleSummary({
    request: "总结全文，重点解释选区。", pack, budget: budget(3000),
    runTurn: async ({ messages }) => {
      const body = bodyOf(messages);
      assert.ok(body.includes("【用户选区开始】\n" + selection));
      assert.ok(body.endsWith(" Final note."));
      assert.equal(body.split(selection).length, 2);
      return { ...summary("internal reasoning"), reasoning: "internal reasoning" };
    },
  }), /没有返回文章总结正文/);
});

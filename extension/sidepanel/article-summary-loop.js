import { runArticleSummary } from "../lib/article-summary.js";
import { resolveModelContext } from "../lib/model-context.js";
import { modelOutputSample } from "../lib/agent/loop-kernel.js";
import { streamTurn } from "../lib/openai.js";
import { loadTabPack } from "../lib/page-pack.js";
import { tabInWindow } from "../lib/window-scope.js";

async function checkPage(page) {
  const tab = await tabInWindow(page.id, page.windowId).catch(() => null);
  if (!tab) throw new Error("原文章标签已关闭或移到其他窗口。请在目标文章上重新发起总结。");
  if (tab.url !== page.url) throw new Error("原标签已切换到其他网页。请在要总结的文章上重试。");
}

// A just-activated page can have a title before its body is ready.
async function readArticle(page, signal) {
  for (const pause of [0, 300, 700]) {
    if (pause) await new Promise(resolve => setTimeout(resolve, pause));
    signal.throwIfAborted();
    await checkPage(page);
    const pack = await loadTabPack(page.id, { summarySource: true, signal });
    signal.throwIfAborted();
    await checkPage(page);
    if (pack.url !== page.url) throw new Error("读取期间文章网址发生变化，请在目标文章上重试。");
    if (pack.pdfError && (pack.kind === "pdf" || !pack.text || /\.pdf(?:[?#]|$)/i.test(page.url))) {
      throw new Error("未能读取 PDF 正文：" + pack.pdfError);
    }
    if (pack.text?.trim()) return pack;
    if (pack.domAvailable === false) break;
  }
  throw new Error("原标签页还没有可读取的文章正文，请在页面加载后重试。");
}

export function createArticleSummaryLoop({ page, model, language, onSource }) {
  return {
    async run(request, options) {
      const start = Date.now();
      const traceSteps = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let turnsUsed = 0;
      const metrics = finishReason => ({
        durationMs: Date.now() - start, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
        finishReason, endedAt: Date.now(),
      });
      try {
        const pack = await readArticle(page, options.signal);
        onSource(pack);
        const budget = await resolveModelContext(model, { signal: options.signal });
        traceSteps.push({
          type: "article_source", tabId: page.id, url: pack.url, chars: pack.text.length,
          contextTokens: budget.contextTokens, inputBudget: budget.inputTokens, contextSource: budget.source,
          timestamp: Date.now(),
        });
        const final = await runArticleSummary({
          request, pack, language, budget, signal: options.signal, history: options.history,
          async runTurn({ messages, maxTokens, stage, signal }) {
            signal.throwIfAborted();
            const turn = ++turnsUsed;
            const started = Date.now();
            traceSteps.push({ type: "turn_start", turn, stage, timestamp: started });
            options.onEvent({ type: "turn_prepared", stage });
            const step = { type: "model_turn", turn, stage, messages, tools: [], toolCalls: [] };
            try {
              const isFinal = stage === "final";
              const result = await streamTurn(model, {
                messages, maxTokens, signal,
                onReasoningDelta: isFinal ? options.onReasoningDelta : undefined,
              }, isFinal ? options.onTextDelta : undefined);
              const usage = result.usage || {};
              inputTokens += usage.promptTokens || 0;
              outputTokens += usage.completionTokens || 0;
              Object.assign(step, {
                usage, finishReason: result.finishReason, content: result.content,
                toolCalls: result.toolCalls || [],
              });
              options.onModelOutput(modelOutputSample(result, Date.now() - started));
              return result;
            } catch (err) {
              step.error = err.message;
              throw err;
            } finally {
              traceSteps.push({ ...step, timestamp: Date.now(), durationMs: Date.now() - started });
            }
          },
        });
        return { text: final.content, reasoning: final.reasoning, reason: "stop", turnsUsed, traceSteps, metrics: metrics("stop") };
      } catch (err) {
        err.articleSummaryRun = { traceSteps, metrics: metrics(options.signal.aborted ? "abort" : "error") };
        throw err;
      }
    },
  };
}

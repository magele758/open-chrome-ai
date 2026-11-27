import { splitThinking } from "./markdown.js";
import { isContextWindowError } from "./model-context.js";
import { estimateMessagesTokens, estimateTokens } from "./openai.js";
import { languageInstruction } from "./prompts.js";
import { UNTRUSTED_RULE, wrapUntrusted } from "./untrusted.js";

// Keep the original document and the user's question ahead of optional chat history.
function withHistory(messages, history, inputTokens) {
  // A standalone reading task needs only recent conversation for follow-ups.
  let remaining = Math.min(4096, inputTokens - estimateMessagesTokens(messages));
  let start = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (!["assistant", "user"].includes(item.role) || typeof item.content !== "string") break;
    remaining -= estimateMessagesTokens([item]);
    if (remaining < 0) break;
    if (item.role === "user") start = i;
  }
  return [messages[0], ...history.slice(start), messages[1]];
}

// Find a lossless prefix of the remaining source that fits the actual messages,
// preferring a nearby paragraph boundary and never splitting a surrogate pair.
function chunkEnd(material, start, inputTokens, makeMessages) {
  const remaining = material.length - start;
  // With our estimator even ASCII text needs at least one token per four code units.
  let upper = Math.min(remaining, inputTokens * 4);
  let lower = 0;
  const fits = count => estimateMessagesTokens(makeMessages(material.slice(start, start + count))) <= inputTokens;
  if (fits(upper)) lower = upper;
  else {
    while (lower < upper) {
      const mid = Math.ceil((lower + upper) / 2);
      if (fits(mid)) lower = mid;
      else upper = mid - 1;
    }
  }
  if (lower === remaining) return material.length;
  const candidate = material.slice(start, start + lower);
  const paragraph = candidate.lastIndexOf("\n");
  if (paragraph >= lower / 2) lower = paragraph + 1;
  else {
    const word = Math.max(candidate.lastIndexOf(" "), candidate.lastIndexOf("。"));
    if (word >= lower * 0.75) lower = word + 1;
    else if (/[\uD800-\uDBFF]/.test(candidate.at(-1) || "")) lower--;
  }
  if (lower <= 0) throw new Error("模型上下文不足以容纳总结要求和一段原文。");
  return start + lower;
}

function smallerBudget(budget, error, messages, maxTokens, exceededEstimate = false) {
  const message = String(error?.message || error);
  const reported = message.match(/(?:maximum context length(?: is| of)?|context (?:window|length)(?: limit)?(?: is| of|:|=)?|limit of)\s*([\d,]+)\s*tokens?/i);
  const statedWindow = reported ? Number(reported[1].replaceAll(",", "")) : 0;
  if (exceededEstimate && !statedWindow) return budget;
  const sent = estimateMessagesTokens(messages);
  const contextTokens = exceededEstimate ? statedWindow : Math.min(budget.contextTokens, statedWindow || sent + maxTokens);
  const outputTokens = Math.max(1, Math.min(budget.outputTokens, Math.floor(contextTokens / 5)));
  // If the provider gives its real window, try that before splitting. A provider
  // may also just reject our token estimate without giving a numeric limit.
  let inputTokens = Math.floor((contextTokens - outputTokens) * 0.95);
  if (!exceededEstimate) inputTokens = Math.min(inputTokens, budget.inputTokens);
  if (inputTokens >= sent && Math.min(maxTokens, outputTokens) >= maxTokens) {
    inputTokens = Math.floor(sent / 2);
  }
  if (inputTokens < 1 || (!exceededEstimate && inputTokens >= budget.inputTokens && outputTokens >= budget.outputTokens)) throw error;
  return { contextTokens, inputTokens, outputTokens };
}

function checkedResult(result) {
  if (result?.toolCalls?.length) throw new Error("模型在文章总结中返回了工具调用，请重试。");
  if (result?.finishReason === "length" || result?.finishReason === "max_tokens") {
    throw new Error("模型输出达到长度上限，未产生完整总结。");
  }
  if (result?.finishReason === "content_filter") throw new Error("模型服务中断了本次总结。");
  const { answer } = splitThinking(result?.content || "");
  if (!answer.trim() || answer.trim() === String(result?.reasoning || "").trim()) throw new Error("模型没有返回文章总结正文。");
  return answer.trim();
}

/**
 * The callback receives each real request, so the UI can trace every pass and
 * stream only the final answer. No browser tools enter any of these requests.
 */
export async function runArticleSummary({ request, pack, language, history = [], budget, signal, runTurn }) {
  if (!pack?.text?.trim()) throw new Error("未能读取原标签页的文章正文。");
  if (pack.textTruncated || pack.pdfTruncated) throw new Error("原文章未提取完整，无法生成全文总结。");
  let limits = { ...budget };
  if (![limits.contextTokens, limits.inputTokens, limits.outputTokens].every(n => Number.isInteger(n) && n > 0)) {
    throw new Error("文章总结的模型上下文预算无效。");
  }
  const system = [
    "你是 PageLens。根据用户的要求和提供的原文作答，保留重要事实、论据、结论与适用范围。",
    languageInstruction(language),
    UNTRUSTED_RULE,
  ].join("\n");
  const source = wrapUntrusted([pack.title, pack.url].filter(Boolean).join("\n"), "source");
  const question = `${request}\n\n${source}`;
  let material = pack.text;
  if (pack.selection && /选中|选区|划选|selected|selection|highlighted/i.test(request)) {
    const index = material.indexOf(pack.selection);
    const marked = `【用户选区开始】\n${pack.selection}\n【用户选区结束】`;
    material = index < 0 ? `${material}\n\n${marked}` : material.slice(0, index) + marked + material.slice(index + pack.selection.length);
  }
  let notes = false;
  let useHistory = true;
  let unknownWindow = limits.source === "estimate";
  function messagesFor(stage, body) {
    let instruction;
    if (stage === "final") {
      instruction = notes ? "以下是按原文顺序整理的笔记。综合各段，直接回答用户。" : "以下是当前标签页的完整原文。直接回答用户。";
    } else {
      instruction = notes ? "合并这部分笔记，将篇幅压缩到约四分之一，保留关键证据和结论。只输出精简笔记。" : "提取这段原文中与问题有关的观点、证据、具体数字和限制。只输出精简笔记。";
    }
    const quoted = wrapUntrusted(body, notes ? "article-notes" : pack.kind === "pdf" ? "pdf" : "page");
    return [{ role: "system", content: system }, { role: "user", content: `${question}\n\n${instruction}\n${quoted}` }];
  }

  while (true) {
    signal?.throwIfAborted();
    if (unknownWindow || material.length <= limits.inputTokens * 4) {
      const direct = messagesFor("final", material);
      const fits = estimateMessagesTokens(direct) <= limits.inputTokens;
      if (fits || unknownWindow) {
        // An unknown alias may accept much more than the conservative fallback.
        // Probe the intact document once, without unrelated chat history.
        const exceededEstimate = !fits && unknownWindow;
        unknownWindow = false;
        const messages = !exceededEstimate && useHistory ? withHistory(direct, history, limits.inputTokens) : direct;
        try {
          const result = await runTurn({ messages, maxTokens: limits.outputTokens, stage: "final", signal });
          signal?.throwIfAborted();
          checkedResult(result);
          return result;
        } catch (error) {
          signal?.throwIfAborted();
          if (!isContextWindowError(error)) throw error;
          // A full article with no historical turns may still fit at the advertised limit.
          if (messages.length > direct.length) useHistory = false;
          else limits = smallerBudget(limits, error, messages, limits.outputTokens, exceededEstimate);
          continue;
        }
      }
    }

    const stage = notes ? "reduce" : "segment";
    const reduced = [];
    for (let start = 0; start < material.length;) {
      signal?.throwIfAborted();
      const end = chunkEnd(material, start, limits.inputTokens, body => messagesFor(stage, body));
      const messages = messagesFor(stage, material.slice(start, end));
      const maxTokens = Math.min(limits.outputTokens, Math.max(128, Math.floor(limits.inputTokens / 4)), 4096);
      try {
        const result = await runTurn({ messages, maxTokens, stage, signal });
        signal?.throwIfAborted();
        reduced.push(checkedResult(result));
        start = end;
      } catch (error) {
        signal?.throwIfAborted();
        if (!isContextWindowError(error)) throw error;
        limits = smallerBudget(limits, error, messages, maxTokens);
      }
    }
    const next = reduced.join("\n\n");
    const nextTokens = estimateTokens(next);
    const beforeTokens = estimateTokens(material);
    if (nextTokens >= beforeTokens || (notes && nextTokens > beforeTokens * 0.9 && nextTokens > limits.inputTokens)) {
      throw new Error("模型未能压缩分段笔记，无法在此上下文窗口内生成完整总结。");
    }
    material = next;
    notes = true;
  }
}

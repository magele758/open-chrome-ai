/**
 * Independent streaming runner for SideChat threads.
 * Each sideChatId gets its own AbortController and never blocks or mutates
 * the main conversation loop (`state.busy` / `state.abort`).
 */

import { currentPageMeta, persistSession } from "./session.js";
import { state } from "./state.js";
import { completeChat, streamTurn } from "../lib/openai.js";
import { buildDistillMessages, buildForkMessages, deriveSideChatTitle } from "../lib/sidechat-context.js";
import { isModelReady, resolveModel } from "../lib/storage.js";

function findSideChat(id) {
  return (state.sideChats || []).find((sc) => sc.id === id) || null;
}

export function isSideChatRunning(id) {
  return Boolean(id && state.sideChatUi?.runningIds?.has(id));
}

export function stopSideChatTurn(sideChatId) {
  const ctrl = state.sideChatUi?.aborts?.get(sideChatId);
  if (ctrl) {
    try {
      ctrl.abort();
    } catch {
      /* ignore */
    }
  }
}

export async function sendSideChatTurn(sideChatId, userText, { onUpdate, onDone } = {}) {
  const cleanText = String(userText || "").trim();
  const sc = findSideChat(sideChatId);
  if (!sc || !cleanText) return;

  if (isSideChatRunning(sideChatId)) {
    stopSideChatTurn(sideChatId);
  }

  const now = Date.now();
  const isFirstTurn = (sc.messages || []).length === 0;
  if (isFirstTurn && sc.forkType !== "selection") {
    sc.title = deriveSideChatTitle({ userText: cleanText, forkType: sc.forkType });
  }

  const userMsg = {
    id: crypto.randomUUID(),
    role: "user",
    text: cleanText,
    createdAt: now,
  };
  const botMsg = {
    id: crypto.randomUUID(),
    role: "bot",
    text: "…",
    thinking: "",
    createdAt: now,
  };
  sc.messages.push(userMsg, botMsg);
  sc.updatedAt = now;

  const model = resolveModel(state.settings, "text");
  if (!isModelReady(model)) {
    botMsg.text = "未配置文本模型。请先点击右上角设置添加服务商并勾选模型。";
    botMsg.error = true;
    onUpdate?.(sideChatId);
    onDone?.(sideChatId);
    return;
  }

  const abort = new AbortController();
  state.sideChatUi.aborts.set(sideChatId, abort);
  state.sideChatUi.runningIds.add(sideChatId);
  onUpdate?.(sideChatId);

  const pageMeta = currentPageMeta();
  const pageExcerpt = state.share
    ? (state.chatRef?.context || state.pack?.text || "")
    : "";

  const apiMessages = buildForkMessages({
    settings: state.settings,
    sessionMessages: state.messages,
    pageMeta,
    pageExcerpt,
    sideChat: sc,
    userText: cleanText,
  });

  const startedAt = Date.now();
  try {
    const res = await streamTurn(
      model,
      {
        messages: apiMessages,
        signal: abort.signal,
        onReasoningDelta: (delta) => {
          botMsg.thinking = (botMsg.thinking || "") + delta;
          onUpdate?.(sideChatId, { streaming: true });
        },
      },
      (delta) => {
        if (botMsg.text === "…") botMsg.text = "";
        botMsg.text += delta;
        onUpdate?.(sideChatId, { streaming: true });
      },
    );

    if (res?.content) botMsg.text = res.content;
    else if (botMsg.text === "…") {
      botMsg.text = res?.reasoning ? "（已完成思考，未输出进一步正文）" : "模型未返回正文，请重试。";
    }
    if (res?.reasoning && !botMsg.thinking) botMsg.thinking = res.reasoning;
    botMsg.metrics = {
      durationMs: Math.max(1, Date.now() - startedAt),
      inputTokens: res?.usage?.promptTokens || 0,
      outputTokens: res?.usage?.completionTokens || 0,
      totalTokens: res?.usage?.totalTokens || 0,
      finishReason: res?.finishReason || "stop",
      endedAt: Date.now(),
    };
  } catch (err) {
    const isAbort = err?.name === "AbortError";
    if (isAbort) {
      botMsg.text = botMsg.text && botMsg.text !== "…" ? botMsg.text : "已停止。";
    } else {
      botMsg.text = "请求失败：" + (err?.message || String(err));
      botMsg.error = true;
    }
    botMsg.metrics = {
      durationMs: Math.max(1, Date.now() - startedAt),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      finishReason: isAbort ? "abort" : "error",
      endedAt: Date.now(),
    };
  } finally {
    if (state.sideChatUi.aborts.get(sideChatId) === abort) {
      state.sideChatUi.aborts.delete(sideChatId);
    }
    state.sideChatUi.runningIds.delete(sideChatId);
    sc.updatedAt = Date.now();
    await persistSession().catch(() => {});
    onDone?.(sideChatId);
  }
}

export async function distillSideChatNote(sideChatId, { onDone } = {}) {
  const sc = findSideChat(sideChatId);
  if (!sc) return "";
  const model = resolveModel(state.settings, "text");
  if (!isModelReady(model)) {
    throw new Error("未配置文本模型");
  }
  const hasAnswer = (sc.messages || []).some((m) => m.role === "bot" && !m.error && m.text && m.text !== "…");
  if (!hasAnswer) {
    throw new Error("请先在旁注里至少完成一轮问答后再凝练批注");
  }
  const messages = buildDistillMessages({ settings: state.settings, sideChat: sc });
  const summary = await completeChat(model, {
    messages,
    temperature: 0.2,
    maxTokens: 240,
  });
  const clean = String(summary || "").replace(/^["「『]+|["」』]+$/g, "").replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("未能生成有效总结，请重试");
  sc.pinnedNote = clean.slice(0, 300);
  sc.updatedAt = Date.now();
  await persistSession().catch(() => {});
  onDone?.(sideChatId);
  return sc.pinnedNote;
}

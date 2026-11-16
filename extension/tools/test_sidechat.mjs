import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import {
  applyAnchorsToBody,
  captureSelectionAnchor,
  collectTextSegments,
  locateAnchorInText,
  stripSideChatAnchors,
} from "../lib/sidechat-anchor.js";
import {
  MICRO_SKILL_PROMPTS,
  buildDistillMessages,
  buildForkMessages,
  deriveSideChatTitle,
} from "../lib/sidechat-context.js";
import {
  collectAllSideChats,
  loadSession,
  normalizeSession,
  saveSession,
  sessionToMarkdown,
  sessionToObsidianMarkdown,
  toSummary,
} from "../lib/sessions.js";
import { installMemoryIndexedDB } from "./idb_mem.mjs";

// ---------------------------------------------------------------------------
// 1. Anchor capture, disambiguation, overlapping spans & re-render recovery
// ---------------------------------------------------------------------------
{
  const dom = new JSDOM(`
    <div class="body">
      <p>第一处提到 <strong>KV Cache</strong> 用于缓存键，后面还有 <code>KV Cache</code> 和 <a href="#">注意力机制</a>。</p>
      <p>数学部分 <span class="katex"><span class="katex-mathml">hidden</span><span class="katex-html">x+y</span></span> 结束。</p>
    </div>
  `);
  const doc = dom.window.document;
  const body = doc.querySelector(".body");
  const { plainText } = collectTextSegments(body);

  assert.ok(plainText.includes("KV Cache"), "collects visible text");
  assert.ok(!plainText.includes("hidden"), "skips katex-mathml hidden text");

  // Select the SECOND "KV Cache" (inside <code>)
  const codeText = body.querySelector("code").firstChild;
  const range = doc.createRange();
  range.setStart(codeText, 0);
  range.setEnd(codeText, codeText.length);
  const sel = dom.window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const anchor = captureSelectionAnchor(body, sel);
  assert.ok(anchor, "captures selection anchor");
  assert.equal(anchor.quoteText, "KV Cache");
  assert.ok(anchor.contextBefore.includes("后面还有"), "captures prefix context for disambiguation");

  // Even if plainStart shifts (set invalid offset), contextBefore resolves the SECOND occurrence
  const shifted = { ...anchor, plainStart: 9999, plainEnd: 9999 };
  const resolved = locateAnchorInText(plainText, shifted);
  assert.ok(resolved, "relocates shifted anchor");
  assert.equal(resolved.start, anchor.plainStart, "disambiguates second occurrence via contextBefore");

  // Test overlapping anchors + resolved state + pinned tooltip
  const firstIdx = plainText.indexOf("KV Cache");
  const sc1 = {
    id: "sc-a",
    forkType: "selection",
    title: "缓存键",
    status: "active",
    pinnedNote: "避免重复计算 K/V",
    anchor: { quoteText: "KV Cache 用于缓存", plainStart: firstIdx, plainEnd: firstIdx + 13 },
  };
  const sc2 = {
    id: "sc-b",
    forkType: "selection",
    title: "键机制",
    status: "resolved",
    pinnedNote: "",
    anchor: { quoteText: "用于缓存键", plainStart: firstIdx + 9, plainEnd: firstIdx + 14 },
  };
  const scMissing = {
    id: "sc-c",
    forkType: "selection",
    title: "不存在",
    status: "active",
    anchor: { quoteText: "这段原文已经找不到了" },
  };

  const applyRes = applyAnchorsToBody(body, [sc1, sc2, scMissing], {
    activeId: "sc-a",
    indexMap: new Map([["sc-a", 1], ["sc-b", 2], ["sc-c", 3]]),
  });
  assert.deepEqual(applyRes.attachedIds.sort(), ["sc-a", "sc-b"]);
  assert.deepEqual(applyRes.orphanedIds, ["sc-c"]);
  assert.equal(body.querySelectorAll(".sc-anno-badge").length, 2, "renders 2 inline badges");
  assert.ok(body.querySelector("mark.sc-anchor.is-active"), "marks active anchor");
  assert.ok(body.querySelector("mark.sc-anchor").title.includes("避免重复计算 K/V"), "attaches pinned tooltip");

  // Ensure badges don't pollute plain text extraction & strip cleans up
  const { plainText: afterBadgeText } = collectTextSegments(body);
  assert.equal(afterBadgeText, plainText, "plainText ignores injected badges");
  stripSideChatAnchors(body);
  assert.equal(body.querySelectorAll("mark.sc-anchor, .sc-anno-badge").length, 0, "strip removes marks and badges");
}

// ---------------------------------------------------------------------------
// 2. Context isolation & prompt construction
// ---------------------------------------------------------------------------
{
  const sessionMessages = [
    { id: "m0", role: "user", text: "问题1" },
    { id: "m1", role: "bot", text: "回答1：包含 KV Cache 的说明。" },
    { id: "m2", role: "user", text: "主线后续问题2（不该进旁注）" },
    { id: "m3", role: "bot", text: "主线后续回答2（不该进旁注）" },
  ];
  const sideChat = {
    id: "sc-1",
    parentMessageId: "m1",
    forkType: "selection",
    anchor: { quoteText: "KV Cache" },
    messages: [
      { role: "user", text: "为什么不缓存 Q？" },
      { role: "bot", text: "因为每步只需要当前 token 的 Q。" },
    ],
  };

  const built = buildForkMessages({
    settings: { answerLanguage: "zh" },
    sessionMessages,
    pageMeta: { title: "LLM 综述", url: "https://example.com/llm" },
    sideChat,
    userText: "那显存怎么算？",
  });

  const joined = built.map((m) => m.content).join("\n");
  assert.ok(joined.includes("回答1：包含 KV Cache 的说明。"), "includes parent anchor message");
  assert.ok(!joined.includes("主线后续问题2"), "excludes later main turns after fork point");
  assert.ok(!joined.includes("主线后续回答2"), "excludes later main bot turns after fork point");
  assert.ok(joined.includes("【旁注锚点原文】"), "injects anchor quote banner on turn 0");
  assert.ok(joined.includes("那显存怎么算？"), "appends new SideChat user turn");

  const distill = buildDistillMessages({ settings: {}, sideChat });
  assert.equal(distill.length, 2);
  assert.ok(distill[1].content.includes("为什么不缓存 Q？"));
  assert.equal(deriveSideChatTitle({ quoteText: "  KV   Cache 机制解释  " }), "KV Cache 机制解释");
  assert.ok(MICRO_SKILL_PROMPTS.explain("RoPE").includes("RoPE"));
}

// ---------------------------------------------------------------------------
// 3. Session persistence, migration, isolation & Markdown/Obsidian export
// ---------------------------------------------------------------------------
{
  installMemoryIndexedDB();
  const bag = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (typeof keys === "string") return { [keys]: bag[keys] };
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) out[k] = bag[k];
            return out;
          }
          return { ...bag };
        },
        set: async (obj) => Object.assign(bag, obj),
        remove: async (keys) => {
          for (const k of [].concat(keys)) delete bag[k];
        },
      },
    },
  };

  // Legacy session gets deterministic IDs & empty sideChats
  const legacy = normalizeSession({
    id: "legacy-sc",
    messages: [{ role: "user", text: "hi" }, { role: "bot", text: "hello" }],
  });
  assert.equal(legacy.messages[0].id, "m-0");
  assert.equal(legacy.messages[1].id, "m-1");
  assert.deepEqual(legacy.sideChats, []);

  // Save two distinct sessions with separate sideChats
  const sA = await saveSession({
    id: "sess-a",
    messages: [
      { id: "a-u1", role: "user", text: "会话A问题" },
      { id: "a-b1", role: "bot", text: "会话A回答：关于 RoPE 编码。" },
    ],
    sideChats: [
      {
        id: "sc-a1",
        parentMessageId: "a-b1",
        forkType: "selection",
        anchor: { quoteText: "RoPE 编码", plainStart: 8, plainEnd: 15, status: "attached" },
        title: "RoPE 原理",
        status: "resolved",
        pinnedNote: "复数旋转注入相对位置",
        messages: [
          { id: "m1", role: "user", text: "怎么注入相对位置？" },
          { id: "m2", role: "bot", text: "内积只差角度 (m-n)θ。" },
        ],
        updatedAt: 2000,
      },
    ],
  });
  const sB = await saveSession({
    id: "sess-b",
    messages: [
      { id: "b-u1", role: "user", text: "会话B问题" },
      { id: "b-b1", role: "bot", text: "会话B回答" },
    ],
    sideChats: [
      {
        id: "sc-b1",
        parentMessageId: "b-b1",
        forkType: "message",
        anchor: { quoteText: "会话B回答" },
        title: "B的分支",
        status: "active",
        messages: [],
        updatedAt: 3000,
      },
    ],
  });

  const sumA = toSummary(sA);
  assert.equal(sumA.sideChatCount, 1);
  assert.equal(sumA.unresolvedSideChatCount, 0);

  const loadedA = await loadSession("sess-a");
  assert.equal(loadedA.sideChats.length, 1);
  assert.equal(loadedA.sideChats[0].id, "sc-a1");
  assert.equal(loadedA.sideChats[0].pinnedNote, "复数旋转注入相对位置");

  const loadedB = await loadSession("sess-b");
  assert.equal(loadedB.sideChats.length, 1);
  assert.equal(loadedB.sideChats[0].id, "sc-b1");

  const md = sessionToMarkdown(loadedA);
  assert.ok(md.includes("> [!note] 旁注 · RoPE 原理（已掌握"), "exports Obsidian callout");
  assert.ok(md.includes("**凝练批注**：复数旋转注入相对位置"), "exports pinned note");
  assert.ok(md.includes("**问**：怎么注入相对位置？"), "exports sidechat turns");
  assert.ok(sessionToObsidianMarkdown(loadedA).includes("旁注：1 条"), "obsidian markdown header notes sidechat count");

  const aggregated = collectAllSideChats([loadedA, loadedB]);
  assert.equal(aggregated.length, 2);
  assert.equal(aggregated[0].sideChat.id, "sc-b1", "sorted by updatedAt desc");
  assert.equal(aggregated[1].sideChat.id, "sc-a1");
}

// ---------------------------------------------------------------------------
// 4. SidePanel UI wiring & session-isolation in JSDOM
// ---------------------------------------------------------------------------
{
  globalThis.chrome.permissions = {
    contains: async () => true,
    request: async () => true,
  };

  const html = readFileSync(resolve("extension/sidepanel/index.html"), "utf8");
  const dom = new JSDOM(html, { url: "https://pagelens.local/sidepanel/index.html", runScripts: "outside-only" });
  for (const file of ["marked.min.js", "purify.min.js"]) {
    dom.window.eval(readFileSync(new URL("../vendor/" + file, import.meta.url), "utf8"));
  }
  dom.window.eval(readFileSync(new URL("../vendor/katex/katex.min.js", import.meta.url), "utf8"));
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.NodeFilter = dom.window.NodeFilter;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.Event = dom.window.Event;
  globalThis.marked = dom.window.marked;
  globalThis.DOMPurify = dom.window.DOMPurify;
  globalThis.katex = dom.window.katex;
  globalThis.CSS = { escape: (s) => String(s) };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };

  const { state } = await import("../sidepanel/state.js");
  const { renderMessages } = await import("../sidepanel/messages.js");
  const { applySession, persistSession } = await import("../sidepanel/session.js");
  const { createSideChat, initSideChat, renderSideChatPane } = await import("../sidepanel/sidechat-ui.js");
  const { initReviewView } = await import("../sidepanel/review-view.js");
  const { initMarkdown } = await import("../lib/markdown.js");
  initMarkdown();

  // Mock text model & OpenAI response for SideChat turn + distillation
  state.settings.text = {
    baseUrl: "https://api.example.com/v1",
    model: "test-model",
    apiKey: "test-key",
  };
  let seenPayloads = [];
  globalThis.fetch = async (_url, opts) => {
    const payload = JSON.parse(opts.body);
    seenPayloads.push(payload);
    const isDistill = payload.messages.some((m) => String(m.content).includes("批注提炼助手"));
    return Response.json({
      choices: [
        {
          message: {
            content: isDistill
              ? "只缓存历史 K/V 即可把解码从 O(n²) 降为线性。"
              : "因为当前步只生成最新 token 的 Q，历史 Q 不再使用。",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    });
  };

  initSideChat();
  initReviewView();

  applySession({
    id: "ui-sess-1",
    createdAt: Date.now(),
    pages: [],
    messages: [
      { id: "u1", role: "user", text: "解释大模型推理" },
      { id: "b1", role: "bot", text: "核心包括 KV Cache 和 投机采样 两类优化。" },
    ],
    sideChats: [],
  });

  const sc = createSideChat({
    forkType: "selection",
    parentMessageId: "b1",
    anchor: { quoteText: "KV Cache", plainStart: 5, plainEnd: 13, status: "attached" },
  });
  assert.ok(sc, "creates SideChat thread in UI");
  assert.equal(state.sideChats.length, 1);
  assert.equal(document.getElementById("sc-header-count").textContent, "1");
  assert.ok(document.querySelector("#msgs mark.sc-anchor"), "highlights quote in main chat");
  assert.equal(document.getElementById("sidechat-pane").classList.contains("hidden"), false, "opens SideChat pane");

  // Send a SideChat turn via UI composer
  document.getElementById("sc-input").value = "为什么不缓存 Q？";
  document.getElementById("btn-sc-send").click();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(seenPayloads.length, 1, "calls model for SideChat turn");
  assert.ok(state.sideChats[0].messages.some((m) => m.role === "bot" && m.text.includes("最新 token 的 Q")));
  assert.equal(state.messages.length, 2, "main conversation messages remain untouched");

  // Distill 1-line margin annotation
  document.getElementById("btn-sc-distill").click();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(state.sideChats[0].pinnedNote, "只缓存历史 K/V 即可把解码从 O(n²) 降为线性。");
  assert.equal(document.getElementById("sc-pinned-box").classList.contains("hidden"), false);
  assert.ok(document.querySelector("#msgs mark.sc-anchor").title.includes("只缓存历史 K/V"));

  // Cite back to main composer without mutating main messages
  const citeBtn = [...document.querySelectorAll("#sc-messages button")].find((b) => b.textContent.includes("引用回主线"));
  assert.ok(citeBtn, "renders cite-back button");
  citeBtn.click();
  assert.ok(document.getElementById("input").value.includes("旁注"), "populates main composer on cite-back");
  assert.equal(state.messages.length, 2, "cite-back does not inject into main history until user sends");

  // Responsive wide vs narrow mode classes & drag-to-resize both panels
  const viewChatEl = document.getElementById("view-chat");
  const paneEl = document.getElementById("sidechat-pane");
  const resizerEl = document.getElementById("sc-resizer");
  Object.defineProperty(viewChatEl, "clientWidth", { configurable: true, value: 900 });
  state.sideChatUi.wide = true;
  state.sideChatUi.open = true;
  renderSideChatPane();
  assert.ok(viewChatEl.classList.contains("is-wide-split"));
  assert.ok(paneEl.classList.contains("is-split"));
  assert.equal(paneEl.style.width, "340px");

  // Simulate dragging divider left by 120px (widens SideChat, shrinks main chat)
  const PointerEv = dom.window.PointerEvent || dom.window.MouseEvent;
  resizerEl.dispatchEvent(new PointerEv("pointerdown", { bubbles: true, button: 0, clientX: 560, pointerId: 1 }));
  dom.window.dispatchEvent(new PointerEv("pointermove", { bubbles: true, clientX: 440, pointerId: 1 }));
  dom.window.dispatchEvent(new PointerEv("pointerup", { bubbles: true, clientX: 440, pointerId: 1 }));
  assert.equal(paneEl.style.width, "460px", "wide split resizes SideChat and main chat via drag");
  assert.equal(localStorage.getItem("pagelens.sidechat.splitWidth"), "460", "persists split width");

  // Double-click resets wide split width
  resizerEl.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));
  assert.equal(paneEl.style.width, "340px", "double-click resets split width");

  // Narrow drawer mode drag resize (current width falls back to DEFAULT_SPLIT_WIDTH 340 in jsdom without layout engine)
  Object.defineProperty(viewChatEl, "clientWidth", { configurable: true, value: 420 });
  state.sideChatUi.wide = false;
  renderSideChatPane();
  assert.ok(paneEl.classList.contains("is-drawer"));
  resizerEl.dispatchEvent(new PointerEv("pointerdown", { bubbles: true, button: 0, clientX: 120, pointerId: 2 }));
  dom.window.dispatchEvent(new PointerEv("pointermove", { bubbles: true, clientX: 160, pointerId: 2 }));
  dom.window.dispatchEvent(new PointerEv("pointerup", { bubbles: true, clientX: 160, pointerId: 2 }));
  assert.equal(paneEl.style.width, "300px", "narrow drawer resizes cleanly");
  assert.equal(localStorage.getItem("pagelens.sidechat.drawerWidth"), "300", "persists drawer width");

  // Toggle resolved in UI
  document.getElementById("btn-sc-resolve").click();
  assert.equal(state.sideChats[0].status, "resolved");
  assert.ok(document.querySelector("#msgs mark.sc-anchor.is-resolved"), "anchor updates to resolved style");

  // Clear pinned note in 1 click
  document.getElementById("btn-sc-pinned-clear").click();
  assert.equal(state.sideChats[0].pinnedNote, "", "clears pinned note");
  assert.equal(document.getElementById("sc-pinned-box").classList.contains("hidden"), true);

  // Trigger message-level fork via custom event
  document.dispatchEvent(new dom.window.CustomEvent("pagelens:sidechat-fork", {
    detail: { forkType: "message", messageId: "b1", quoteText: "核心包括 KV Cache" },
  }));
  assert.equal(state.sideChats.length, 2);
  assert.ok(document.querySelector("#msgs .sc-msg-fork-chip"), "renders message-level fork chip");

  // Delete empty message-fork chip in 1 click right from message
  const msgDelBtn = document.querySelector("#msgs .sc-msg-fork-del");
  assert.ok(msgDelBtn, "renders inline delete button on fork chip");
  msgDelBtn.click();
  assert.equal(state.sideChats.length, 1, "deletes empty annotation in 1 click");
  assert.equal(document.querySelectorAll("#msgs .sc-msg-fork-chip").length, 0);

  // Re-add second empty fork to verify cross-session review & multi-delete
  document.dispatchEvent(new dom.window.CustomEvent("pagelens:sidechat-fork", {
    detail: { forkType: "message", messageId: "b1", quoteText: "核心包括 KV Cache" },
  }));
  assert.equal(state.sideChats.length, 2);

  await persistSession();

  // Cross-session Review SideChats tab
  document.querySelector('.review-tab[data-type="sidechats"]').click();
  await new Promise((r) => setTimeout(r, 40));
  const reviewCards = document.querySelectorAll("#review-sc-list .review-sc-card");
  assert.ok(reviewCards.length >= 2, "cross-session review tab lists saved SideChats");

  // Delete non-empty annotation via inline 2-click confirm (#btn-sc-delete) & verify mark removed
  state.sideChatUi.activeId = sc.id;
  renderSideChatPane();
  const threadDelBtn = document.getElementById("btn-sc-delete");
  threadDelBtn.click(); // First click arms
  assert.match(threadDelBtn.textContent, /确认删除/, "first delete click on non-empty thread arms inline confirm");
  assert.equal(state.sideChats.length, 2);
  threadDelBtn.click(); // Second click deletes
  assert.equal(state.sideChats.length, 1, "second click deletes non-empty annotation");
  assert.equal(document.querySelectorAll("#msgs mark.sc-anchor").length, 0, "removes inline highlight mark after delete");

  // Switching to a new session isolates SideChats completely
  applySession({
    id: "ui-sess-2",
    createdAt: Date.now(),
    pages: [],
    messages: [
      { id: "u2", role: "user", text: "另一个会话" },
      { id: "b2", role: "bot", text: "全新的回复内容" },
    ],
    sideChats: [],
  });
  assert.equal(state.sideChats.length, 0, "new session clears previous session SideChats");
  assert.equal(document.getElementById("sc-header-count").textContent, "");
  assert.equal(document.querySelectorAll("#msgs mark.sc-anchor").length, 0);
  renderMessages();
}

console.log("PASS sidechat");

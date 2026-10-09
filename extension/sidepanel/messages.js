import { runSkill } from "./agent-loop.js";
import { openClipModal } from "./clippings-ui.js";
import { $ } from "./dom.js";
import { flashStatus, importCurrentToLibrary } from "./history.js";
import { createMessageScroll } from "./message-scroll.js";
import { messageScroll } from "./panel-refs.js";
import { openShortcutSettings } from "./slash-menu.js";
import { state } from "./state.js";
import { bindToolCardState, toolCardOpen } from "./tool-card-state.js";
import { redactSettingsArgs } from "../lib/agent/settings-tools.js";
import { injectVideo } from "../lib/chrome.js";
import { writeClipboardRich } from "../lib/clipboard.js";
import { highlightQuote } from "../lib/extract.js";
import { isLangfuseConfigured, sendTraceToLangfuse } from "../lib/langfuse.js";
import { bindMarkdownLinks, decorateInlines, enhanceMermaid, formatAnswer, splitThinking } from "../lib/markdown.js";
import { visibleSkills } from "../lib/prompts.js";
import { isModelReady, resolveModel } from "../lib/storage.js";

const thinkingScrolls = new WeakMap();

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function renderSkills() {
  const el = $("skills");
  if (!el) {
    console.warn("[pagelens] wire missing", "skills");
    return;
  }
  el.innerHTML = "";
  visibleSkills(state.settings).forEach((skill) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = skill.label;
    if (skill.custom) btn.classList.add("custom");
    btn.addEventListener("click", () => {
      runSkill(skill).catch((err) => {
        console.error("[pagelens] chip failed", err);
        pushError("发送失败：" + (err.message || err));
      });
    });
    el.appendChild(btn);
  });
  const add = document.createElement("button");
  add.type = "button";
  add.className = "add-shortcut";
  add.title = "添加快捷问题";
  add.textContent = "+";
  add.addEventListener("click", () => openShortcutSettings());
  el.appendChild(add);
}

function formatTokenCount(num) {
  const n = Math.max(0, Number(num) || 0);
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function formatDuration(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

function isMetaTrace(item) {
  return item?.kind === "meta" || ["思考", "压缩上下文", "从中断处继续"].includes(item?.name);
}

function truncateToolText(text, max = 80) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function toolArgHint(item) {
  const args = item?.args || {};
  if (item?.name === "run_shell" && args.command) return truncateToolText(args.command, 88);
  if (args.url) return truncateToolText(args.url, 72);
  if (args.selector) return truncateToolText(args.selector, 56);
  if (args.path) return truncateToolText(args.path, 56);
  if (args.handle) return String(args.handle);
  if (args.query) return truncateToolText(args.query, 48);
  if (args.code) return truncateToolText(args.code, 56);
  return "";
}

function hasToolArgs(args) {
  return Boolean(args && typeof args === "object" && Object.keys(args).length);
}

function formatToolArgs(name, args) {
  if (!hasToolArgs(args)) return "（无输入）";
  if (name === "run_shell") {
    return [
      args.command || "",
      args.cwd ? `cwd: ${args.cwd}` : "",
      args.timeoutMs ? `timeout: ${args.timeoutMs}ms` : "",
    ].filter(Boolean).join("\n") || "（无输入）";
  }
  try {
    return JSON.stringify(name === "update_settings" ? redactSettingsArgs(args) : args, (_k, v) => (
      typeof v === "string" && v.length > 1200 ? `${v.slice(0, 1200)}…` : v
    ), 2);
  } catch {
    return String(args);
  }
}

function pickToolArgs(ev, fallback) {
  return hasToolArgs(ev?.args) ? ev.args : (hasToolArgs(fallback) ? fallback : {});
}

function toolStatusLabel(item) {
  if (item.status === "running") return "进行中";
  if (item.ok === false || item.status === "fail") {
    return /拦截/.test(String(item.preview || "")) ? "已拦截" : "失败";
  }
  const dur = Number(item.durationMs);
  const time = Number.isFinite(dur) && dur > 0 ? formatDuration(dur) : "";
  if (item.archived) return time ? `已归档 · ${time}` : "已归档";
  return time || "完成";
}

function pushTraceItem(botMsg, item) {
  if (!botMsg.trace) botMsg.trace = [];
  botMsg._traceSeq = (botMsg._traceSeq || 0) + 1;
  botMsg.trace.push({ id: String(botMsg._traceSeq), ...item });
}

function finishTraceTool(botMsg, ev) {
  const running = [...(botMsg.trace || [])].reverse().find((t) => t.name === ev.name && t.status === "running");
  const next = {
    kind: "tool",
    name: ev.name,
    ok: ev.ok,
    status: ev.ok ? "ok" : "fail",
    args: pickToolArgs(ev, running?.args),
    preview: ev.content || "",
    durationMs: ev.durationMs || 0,
    archived: Boolean(ev.archived),
  };
  if (running) Object.assign(running, next);
  else pushTraceItem(botMsg, next);
}

function fillToolTrace(root, items, { live = false } = {}) {
  root.innerHTML = "";
  const list = Array.isArray(items) ? items : [];
  const meta = list.filter(isMetaTrace);
  const tools = list.filter((t) => !isMetaTrace(t));
  if (meta.length) {
    const row = document.createElement("div");
    row.className = "tool-trace-meta";
    row.textContent = meta.map((t) => t.name).join(" · ");
    root.appendChild(row);
  }
  for (const item of tools) {
    root.appendChild(createToolCard(item, { open: toolCardOpen(item), live }));
  }
}

function createToolCard(item, { open = false } = {}) {
  const details = document.createElement("details");
  const status = item.status || (item.ok === false ? "fail" : "ok");
  details.className = `tool-card ${status}`;
  details.dataset.id = String(item.id || item.name);
  if (open) details.open = true;

  const summary = document.createElement("summary");
  summary.className = "tool-card-summary";
  const title = document.createElement("span");
  title.className = "tool-card-title";
  title.textContent = item.name || "tool";
  const hint = document.createElement("span");
  hint.className = "tool-card-hint";
  hint.textContent = toolArgHint(item);
  const meta = document.createElement("span");
  meta.className = "tool-card-meta";
  meta.textContent = toolStatusLabel(item);
  if (status === "running") {
    const pulse = document.createElement("span");
    pulse.className = "tool-card-pulse";
    meta.prepend(pulse);
  }
  summary.append(title, hint, meta);

  const body = document.createElement("div");
  body.className = "tool-card-body";
  const inputLabel = document.createElement("div");
  inputLabel.className = "tool-card-label";
  inputLabel.textContent = "输入";
  const input = document.createElement("pre");
  input.className = "tool-card-pre";
  input.textContent = formatToolArgs(item.name, item.args);
  body.append(inputLabel, input);
  const resultLabel = document.createElement("div");
  resultLabel.className = "tool-card-label";
  resultLabel.textContent = status === "running" ? "输出（进行中）" : "输出";
  const result = document.createElement("pre");
  result.className = "tool-card-pre";
  result.textContent = status === "running" && !item.preview ? "执行中…" : String(item.preview || "（无输出）");
  body.append(resultLabel, result);

  details.append(summary, body);
  bindToolCardState(details, item);
  return details;
}

function finishReasonLabel(reason) {
  const map = {
    stop: "正常结束",
    max_turns: "轮次上限",
    abort: "已中断",
    error: "异常退出",
    tool_calls: "工具调用",
    length: "超长截断",
  };
  return map[reason] || reason || "结束";
}

function createMessageFooter(msg) {
  const footer = document.createElement("div");
  footer.className = "msg-footer";

  const stats = document.createElement("div");
  stats.className = "msg-stats";

  if (msg.metrics) {
    const dur = document.createElement("span");
    dur.className = "stat-item stat-duration";
    dur.title = `运行时长：${msg.metrics.durationMs}ms`;
    dur.innerHTML = `<span class="stat-icon">⏱️</span><span class="stat-val">${formatDuration(msg.metrics.durationMs)}</span>`;
    stats.appendChild(dur);

    const inTok = document.createElement("span");
    inTok.className = "stat-item stat-tokens-in";
    inTok.title = `输入 Token：${msg.metrics.inputTokens}`;
    inTok.innerHTML = `<span class="stat-icon">📥</span><span class="stat-val">${formatTokenCount(msg.metrics.inputTokens)}</span>`;
    stats.appendChild(inTok);

    const outTok = document.createElement("span");
    outTok.className = "stat-item stat-tokens-out";
    outTok.title = `输出 Token：${msg.metrics.outputTokens}`;
    outTok.innerHTML = `<span class="stat-icon">📤</span><span class="stat-val">${formatTokenCount(msg.metrics.outputTokens)}</span>`;
    stats.appendChild(outTok);

    const reason = document.createElement("span");
    reason.className = `stat-item stat-reason ${msg.metrics.finishReason || ""}`;
    reason.title = `结束原因：${msg.metrics.finishReason || "未知"}`;
    reason.innerHTML = `<span class="stat-icon">🏁</span><span class="stat-val">${finishReasonLabel(msg.metrics.finishReason)}</span>`;
    stats.appendChild(reason);
  }
  footer.appendChild(stats);

  if (msg.sourceTitle) {
    const source = document.createElement("div");
    source.className = "msg-source";
    source.textContent = `来源：${msg.sourceTitle}`;
    footer.appendChild(source);
  }

  const actions = document.createElement("div");
  actions.className = "msg-actions";

  if (msg.text && !msg.error && msg.text !== "…") {
    const clipBtn = document.createElement("button");
    clipBtn.type = "button";
    clipBtn.className = "btn-clip-card";
    clipBtn.title = "剪藏此回答至 Obsidian 卡片与 Chrome 书签";
    clipBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg><span>剪藏</span>`;
    clipBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openClipModal(msg);
    });
    actions.appendChild(clipBtn);

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn-copy-answer";
    copyBtn.title = "复制回答";
    copyBtn.innerHTML = `<svg class="ico tiny"><use href="#i-copy"/></svg><span>复制</span>`;
    copyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await writeClipboardRich({ text: msg.text, html: formatAnswer(msg.text) });
        copyBtn.querySelector("span").textContent = "已复制";
        setTimeout(() => { copyBtn.querySelector("span").textContent = "复制"; }, 1200);
      } catch (err) {
        flashStatus(err.message || String(err), false);
      }
    });
    actions.appendChild(copyBtn);

    const obsidianBtn = document.createElement("button");
    obsidianBtn.type = "button";
    obsidianBtn.className = "btn-obsidian-answer";
    obsidianBtn.title = "把当前整段对话写入文稿文件夹";
    obsidianBtn.innerHTML = `<svg class="ico tiny"><use href="#i-book"/></svg><span>写入 Obsidian</span>`;
    obsidianBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      importCurrentToLibrary();
    });
    actions.appendChild(obsidianBtn);
  }

  if (msg.traceLog || msg.metrics) {
    const dlBtn = document.createElement("button");
    dlBtn.type = "button";
    dlBtn.className = "btn-download-trace";
    dlBtn.title = "下载本次会话执行 Trace 日志（JSON）";
    dlBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>Trace</span>`;
    dlBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      downloadMessageTrace(msg);
    });
    actions.appendChild(dlBtn);
  }

  footer.appendChild(actions);

  return footer;
}

function downloadMessageTrace(msg) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const sid = state.sessionId ? state.sessionId.slice(0, 8) : "session";
  const filename = `pagelens-trace-${sid}-${ts}.json`;

  const traceData = msg.traceLog || {
    version: "1.0",
    sessionId: state.sessionId,
    timestamp: new Date().toISOString(),
    metrics: msg.metrics,
    trace: msg.trace,
    content: msg.text,
    steps: [],
  };

  const exportPayload = {
    ...traceData,
    conversationContext: {
      sessionId: state.sessionId,
      sessionTitle: state.sessionTitle,
      page: state.tab ? { url: state.tab.url, title: state.tab.title } : null,
      messagesSummary: (state.messages || []).map((m) => ({
        role: m.role,
        textPreview: String(m.text || "").slice(0, 100),
        metrics: m.metrics,
      })),
    },
  };

  const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}

function maybeUploadTraceToLangfuse(traceLog) {
  try {
    if (!traceLog) return;
    const cfg = state?.settings?.langfuse;
    if (!isLangfuseConfigured(cfg)) return;
    const pageInfo = state.tab ? { url: state.tab.url, title: state.tab.title } : null;
    const enriched = {
      ...traceLog,
      page: pageInfo,
      sessionTitle: state.sessionTitle || undefined,
    };
    sendTraceToLangfuse(enriched, cfg).catch(() => {
      // Background telemetry: never disturb user workflow on network failure
    });
  } catch {
    // Fail-safe
  }
}

function renderMessages() {
  const root = $("msgs");
  if (!root) return;
  const scrollTop = messageScroll?.beforeRender();
  root.innerHTML = "";
  if (!state.messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = isModelReady(resolveModel(state.settings, "text"))
      ? "直接问这页，或点「总结本页」。视频总结在上方音视频区，不会覆盖这里的对话。"
      : "先到设置里添加文本服务商并勾选模型。";
    root.appendChild(empty);
    const first = visibleSkills(state.settings).slice(0, 4);
    if (first.length) {
      const actions = document.createElement("div");
      actions.className = "big-actions";
      first.forEach((skill) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = skill.label;
        b.addEventListener("click", () => {
          runSkill(skill).catch((err) => {
            console.error("[pagelens] chip failed", err);
            pushError("发送失败：" + (err.message || err));
          });
        });
        actions.appendChild(b);
      });
      root.appendChild(actions);
    }
    messageScroll?.reset();
    messageScroll?.afterRender();
    return;
  }
  for (const msg of state.messages) {
    const wrap = document.createElement("div");
    wrap.className = `msg ${msg.role}${msg.error ? " error" : ""}`;
    if (msg.role === "user") {
      if (msg.image) {
        const img = document.createElement("img");
        img.className = "thumb";
        img.src = msg.image;
        wrap.appendChild(img);
      }
      wrap.appendChild(document.createTextNode(msg.text));
    } else {
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = "PageLens";
      wrap.appendChild(who);
      const isLast = msg === state.messages[state.messages.length - 1];
      const streamingThis = state.busy && isLast && !msg.metrics;
      if (msg.trace?.length) {
        const tr = document.createElement("div");
        tr.className = "tool-trace";
        fillToolTrace(tr, msg.trace, { live: streamingThis });
        wrap.appendChild(tr);
      }
      const { thinking, answer, isStreamingThinking } = splitThinking(msg.text, msg.thinking);
      const isThinkingNow = streamingThis && (isStreamingThinking || (!answer && Boolean(thinking)));

      if (thinking) {
        wrap.appendChild(createThinkingBox(thinking, { isStreaming: isThinkingNow }));
      }

      const displayText = answer || (isThinkingNow ? "" : (msg.text || (state.busy ? "…" : "")));
      if (displayText) {
        const body = document.createElement("div");
        body.className = "body";
        fillBotBody(body, displayText, { mermaid: !streamingThis && !msg.error });
        wrap.appendChild(body);
      }
      if (msg.metrics || (!streamingThis && displayText && !msg.error && displayText !== "…")) {
        wrap.appendChild(createMessageFooter(msg));
      }
    }
    root.appendChild(wrap);
  }
  messageScroll?.afterRender(scrollTop);
}

function createThinkingBox(thinking, { isStreaming = false } = {}) {
  const details = document.createElement("details");
  details.className = "thinking-box";
  if (isStreaming) {
    details.open = true;
    details.dataset.autoOpen = "true";
  }

  const summary = document.createElement("summary");
  summary.className = "thinking-summary";

  const chevronSvg = `<svg class="thinking-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>`;

  summary.innerHTML = `
    ${chevronSvg}
    <span class="thinking-title">
      <span class="thinking-icon">💭</span>
      <span class="thinking-label">${isStreaming ? "正在思考" : "思考过程"}</span>
      ${isStreaming ? '<span class="thinking-pulse"></span>' : ""}
    </span>
    <span class="thinking-badge">${isStreaming ? "思考中" : "点击展开/收起"}</span>
  `;

  const content = document.createElement("div");
  content.className = "thinking-content";
  content.textContent = thinking;

  details.addEventListener("toggle", () => {
    if (!details.open) {
      delete details.dataset.autoOpen;
    }
    if (messageScroll?.isFollowing()) {
      messageScroll.scrollToBottom({ smooth: false });
    }
  });

  details.appendChild(summary);
  details.appendChild(content);
  thinkingScrolls.set(details, createMessageScroll(content));
  return details;
}

function updateThinkingBox(details, thinking, { isStreaming = false } = {}) {
  const content = details.querySelector(".thinking-content");
  if (content && content.textContent !== thinking) {
    const scroll = thinkingScrolls.get(details);
    const top = scroll?.beforeRender();
    content.textContent = thinking;
    scroll?.afterRender(top);
  }

  const label = details.querySelector(".thinking-label");
  if (label) {
    label.textContent = isStreaming ? "正在思考" : "思考过程";
  }

  const pulse = details.querySelector(".thinking-pulse");
  if (isStreaming && !pulse) {
    const p = document.createElement("span");
    p.className = "thinking-pulse";
    details.querySelector(".thinking-title")?.appendChild(p);
  } else if (!isStreaming && pulse) {
    pulse.remove();
  }

  const badge = details.querySelector(".thinking-badge");
  if (badge) {
    badge.textContent = isStreaming ? "思考中" : "点击展开/收起";
  }

  if (isStreaming && !details.open && details.dataset.autoOpen === "true") {
    details.open = true;
  } else if (!isStreaming && details.dataset.autoOpen === "true") {
    details.open = false;
    delete details.dataset.autoOpen;
  }
}

function fillBotBody(body, text, { mermaid = false } = {}) {
  body.innerHTML = formatAnswer(text);
  decorateInlines(body, { baseUrl: state.pack?.url || state.tab?.url });
  bindMarkdownLinks(body);
  bindAnswerActions(body);
  if (mermaid) enhanceMermaid(body);
}

function parseTimestamp(raw) {
  const parts = raw.split(":").map((n) => Number(n));
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function bindAnswerActions(root) {
  root.querySelectorAll(".ts").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const seconds = parseTimestamp(btn.dataset.t);
      if (seconds == null || !state.tab?.id) return;
      try {
        await injectVideo(state.tab.id, "seek", { seconds });
      } catch (err) {
        pushError("无法跳转播放器：" + err.message);
      }
    });
  });
  root.querySelectorAll(".ref").forEach((el) => {
    el.addEventListener("click", async () => {
      const idx = Number(el.dataset.q) - 1;
      const quote = state.pack?.quotes?.[idx];
      if (!quote || !state.tab?.id) return;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: state.tab.id },
          func: highlightQuote,
          args: [quote.text],
        });
      } catch {
        /* ignore */
      }
    });
  });
}

function pushError(text) {
  messageScroll?.reset();
  state.messages.push({ role: "bot", text, error: true });
  renderMessages();
}

function pushNotice(text) {
  flashStatus(text, true);
}


export {
  thinkingScrolls,
  hostOf,
  renderSkills,
  formatTokenCount,
  formatDuration,
  isMetaTrace,
  truncateToolText,
  toolArgHint,
  hasToolArgs,
  formatToolArgs,
  pickToolArgs,
  toolStatusLabel,
  pushTraceItem,
  finishTraceTool,
  fillToolTrace,
  createToolCard,
  finishReasonLabel,
  createMessageFooter,
  downloadMessageTrace,
  maybeUploadTraceToLangfuse,
  renderMessages,
  createThinkingBox,
  updateThinkingBox,
  fillBotBody,
  parseTimestamp,
  bindAnswerActions,
  pushError,
  pushNotice,
};

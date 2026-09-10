import { PRESETS, defaultSettings, loadSettings, saveSettings, resolveModel, isModelReady } from "../lib/storage.js";
import { streamTurn, testConnection, multimodalUserContent } from "../lib/openai.js";
import { extractPage, seekVideo, highlightQuote } from "../lib/extract.js";
import { systemPrompt, packToContext, visibleSkills, formatTime } from "../lib/prompts.js";
import { loadYoutubeCaptions } from "../lib/youtube.js";
import { initMarkdown, formatAnswer, decorateInlines, bindMarkdownLinks, enhanceMermaid } from "../lib/markdown.js";
import { createAgentLoop } from "../lib/agent/loop.js";
import { createAgentTools } from "../lib/agent/tools.js";
import { loadBundledSkills, shortcutsAsSkills, skillCatalogText } from "../lib/agent/skills.js";
import { restrictedUrl, captureTab as captureVisible } from "../lib/chrome.js";
import {
  clearActiveId,
  deleteSession,
  filterSessions,
  formatWhen,
  listSessions,
  loadAllSessions,
  loadActiveSession,
  loadSession,
  mergePage,
  saveSession,
  sessionFilename,
  sessionToMarkdown,
  sessionsToJSON,
  sessionsToMarkdown,
} from "../lib/sessions.js";
import { isResumableRun } from "../lib/agent/context.js";

const $ = (id) => document.getElementById(id);

const state = {
  settings: defaultSettings(),
  tab: null,
  pack: null,
  share: true,
  messages: [],
  image: null,
  busy: false,
  view: "chat",
  abort: null,
  skills: [],
  sessionId: null,
  sessionCreatedAt: null,
  sessionPages: [],
  histQuery: "",
  run: null,
  stopIntent: null,
  taskGroupId: null,
};

function modelSummary() {
  const text = resolveModel(state.settings, "text");
  const mm = resolveModel(state.settings, "multimodal");
  if (!isModelReady(text)) return "未配置文本模型 · 先到设置填 base_url / model / key";
  const t = text.model;
  const m = isModelReady(mm) ? mm.model : "未配多模态";
  const same = state.settings.multimodalSameAsText;
  return same ? `文本/多模态 · ${t}` : `文本 ${t} · 多模态 ${m}`;
}

function renderModelLine() {
  $("model-line").textContent = modelSummary();
}

function renderContext() {
  const tab = state.tab;
  if (!tab || !state.share) {
    $("ctx-label").textContent = "未分享页面";
    $("ctx-title").textContent = "当前页未分享";
    $("ctx-sub").textContent = "点工具栏打开本侧栏时，默认会带上当前标签";
    return;
  }
  const video = state.pack?.videoIsPrimary && state.pack?.video;
  $("ctx-label").textContent = video ? "正在观看" : state.pack?.kind === "x" ? "正在看帖" : "正在阅读";
  $("ctx-title").textContent = tab.title || "无标题";
  const bits = [hostOf(tab.url)];
  if (state.pack?.kind === "x") bits.push("已提取帖子");
  if (state.pack?.text) bits.push(`${state.pack.text.length} 字`);
  if (video) {
    bits.push(formatTime(video.duration));
    bits.push(state.pack?.captionsStatus === "ready" ? "有字幕" : "无字幕");
  }
  $("ctx-sub").textContent = bits.filter(Boolean).join(" · ");
}

function applyUiFont(size) {
  const next = ["md", "lg", "xl"].includes(size) ? size : "md";
  document.documentElement.dataset.font = next;
}

function fitInput() {
  const el = $("input");
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(160, Math.max(38, el.scrollHeight))}px`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function renderSkills() {
  const el = $("skills");
  el.innerHTML = "";
  visibleSkills(state.settings).forEach((skill) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = skill.label;
    if (skill.custom) btn.classList.add("custom");
    btn.addEventListener("click", () => runSkill(skill));
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

function renderMessages() {
  const root = $("msgs");
  root.innerHTML = "";
  if (!state.messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = isModelReady(resolveModel(state.settings, "text"))
      ? "直接问这页，或点输入框上方的快捷问题。"
      : "先到设置里配置文本模型的 base_url、model_name、api_key。";
    root.appendChild(empty);
    const first = visibleSkills(state.settings).slice(0, 4);
    if (first.length) {
      const actions = document.createElement("div");
      actions.className = "big-actions";
      first.forEach((skill) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = skill.label;
        b.addEventListener("click", () => runSkill(skill));
        actions.appendChild(b);
      });
      root.appendChild(actions);
    }
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
      if (msg.trace?.length) {
        const tr = document.createElement("div");
        tr.className = "trace";
        tr.textContent = msg.trace
          .map((t) => (t.ok === false ? `${t.name} 失败` : t.name))
          .join(" → ");
        wrap.appendChild(tr);
      }
      const body = document.createElement("div");
      body.className = "body";
      const streamingThis = state.busy && msg === state.messages[state.messages.length - 1];
      fillBotBody(body, msg.text || (state.busy ? "…" : ""), { mermaid: !streamingThis && !msg.error });
      wrap.appendChild(body);
    }
    root.appendChild(wrap);
  }
  root.scrollTop = root.scrollHeight;
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
        await chrome.scripting.executeScript({
          target: { tabId: state.tab.id },
          func: seekVideo,
          args: [seconds],
        });
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
  state.messages.push({ role: "bot", text, error: true });
  renderMessages();
}

function setView(view) {
  state.view = view;
  $("view-chat").classList.toggle("hidden", view !== "chat");
  $("view-settings").classList.toggle("hidden", view !== "settings");
  $("view-history").classList.toggle("hidden", view !== "history");
}

function currentPageMeta() {
  if (!state.share) return null;
  const url = state.pack?.url || state.tab?.url;
  if (!url || restrictedUrl(url)) return null;
  return {
    url,
    title: state.pack?.title || state.tab?.title || "",
    hostname: hostOf(url),
    kind: state.pack?.videoIsPrimary ? "video" : state.pack?.kind || "page",
  };
}

let persistChain = Promise.resolve();

function persistSession() {
  persistChain = persistChain.then(persistSessionNow, persistSessionNow);
  return persistChain;
}

async function settleBusy() {
  if (!state.busy) return;
  state.stopIntent = "user";
  state.abort?.abort();
  const t0 = Date.now();
  while (state.busy && Date.now() - t0 < 4000) {
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function persistSessionNow() {
  if (!state.messages.some((m) => m.role === "user" && String(m.text || "").trim())) return;
  if (!state.sessionId) {
    state.sessionId = crypto.randomUUID();
    state.sessionCreatedAt = Date.now();
  }
  const page = currentPageMeta();
  if (page) state.sessionPages = mergePage(state.sessionPages, page);
  const saved = await saveSession({
    id: state.sessionId,
    createdAt: state.sessionCreatedAt || Date.now(),
    pages: state.sessionPages,
    messages: state.messages,
    run: state.run,
    taskGroupId: state.taskGroupId,
  });
  state.sessionPages = saved.pages;
}

function applySession(session) {
  if (!session) return;
  state.sessionId = session.id;
  state.sessionCreatedAt = session.createdAt;
  state.sessionPages = session.pages || [];
  state.messages = (session.messages || []).map((m) => ({
    role: m.role,
    text: m.text || "",
    error: m.error,
    trace: m.trace,
    image: null,
  }));
  state.image = null;
  state.run = session.run || null;
  state.taskGroupId = Number.isInteger(session.taskGroupId) ? session.taskGroupId : null;
  renderAttach();
  renderMessages();
}

async function startNewSession() {
  await settleBusy();
  await persistSession();
  state.sessionId = null;
  state.sessionCreatedAt = null;
  state.sessionPages = [];
  state.messages = [];
  state.image = null;
  state.run = null;
  state.taskGroupId = null;
  await clearActiveId();
  renderAttach();
  renderMessages();
  setView("chat");
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 800);
}

function histStatus(text, ok) {
  const el = $("hist-status");
  if (!el) return;
  el.textContent = text || "";
  el.className = "status" + (ok === true ? " ok" : ok === false ? " bad" : "");
}

function pageLines(pages, limit = 3) {
  const list = pages || [];
  const shown = list.slice(0, limit).map((p) => {
    const title = p.title || p.hostname || "无标题";
    return p.url ? `${title}\n${p.url}` : title;
  });
  if (list.length > limit) shown.push(`等 ${list.length} 个网页`);
  return shown.join("\n");
}

async function renderHistory() {
  const root = $("hist-list");
  if (!root) return;
  const index = filterSessions(await listSessions(), state.histQuery);
  root.innerHTML = "";
  if (!index.length) {
    const empty = document.createElement("p");
    empty.className = "hist-empty";
    empty.textContent = state.histQuery ? "没有匹配的对话。" : "还没有历史。问完就会自动保存，并记下当时的网页。";
    root.appendChild(empty);
    return;
  }
  for (const item of index) {
    const row = document.createElement("div");
    row.className = "hist-item" + (item.id === state.sessionId ? " active" : "");
    const main = document.createElement("button");
    main.type = "button";
    main.className = "hist-main";
    main.title = "打开这条对话";
    const hosts = [...new Set((item.pages || []).map((p) => p.hostname).filter(Boolean))];
    const hostLabel = hosts.length === 1 ? hosts[0] : hosts.length ? `${hosts[0]} 等 ${hosts.length} 站` : "未分享页面";
    main.innerHTML = `
      <div class="t"></div>
      <div class="s"></div>
      <div class="pages"></div>
    `;
    main.querySelector(".t").textContent = item.title || "未命名对话";
    main.querySelector(".s").textContent = [hostLabel, formatWhen(item.updatedAt), `${item.messageCount || 0} 条`]
      .filter(Boolean)
      .join(" · ");
    main.querySelector(".pages").textContent = pageLines(item.pages);
    main.addEventListener("click", () => openHistoryItem(item.id));
    const exp = document.createElement("button");
    exp.type = "button";
    exp.className = "mini";
    exp.textContent = "导出";
    exp.title = "导出 Markdown";
    exp.addEventListener("click", (e) => {
      e.stopPropagation();
      exportOne(item.id);
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "mini";
    del.textContent = "删";
    del.title = "删除";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removeHistoryItem(item.id);
    });
    row.append(main, exp, del);
    root.appendChild(row);
  }
}

async function openHistoryItem(id) {
  await settleBusy();
  await persistSession();
  const session = await loadSession(id);
  if (!session) {
    histStatus("找不到这条对话", false);
    return;
  }
  applySession(session);
  await saveSession(session);
  setView("chat");
}

async function exportOne(id) {
  if (id === state.sessionId) await persistSession();
  const data = await loadSession(id);
  if (!data) {
    histStatus("没有可导出的内容", false);
    return;
  }
  downloadText(sessionFilename(data, "md"), sessionToMarkdown(data), "text/markdown");
  histStatus("已导出 Markdown", true);
}

async function exportAll(kind) {
  await persistSession();
  const all = await loadAllSessions();
  if (!all.length) {
    histStatus("没有可导出的对话", false);
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  if (kind === "json") {
    downloadText(`pagelens-sessions-${day}.json`, sessionsToJSON(all), "application/json");
    histStatus(`已导出 ${all.length} 条 JSON`, true);
    return;
  }
  downloadText(`pagelens-sessions-${day}.md`, sessionsToMarkdown(all), "text/markdown");
  histStatus(`已导出 ${all.length} 条 Markdown`, true);
}

async function removeHistoryItem(id) {
  if (!confirm("删除这条对话？不可恢复。")) return;
  if (id === state.sessionId) await settleBusy();
  await deleteSession(id);
  if (state.sessionId === id) {
    state.sessionId = null;
    state.sessionCreatedAt = null;
    state.sessionPages = [];
    state.messages = [];
    state.image = null;
    state.run = null;
    state.taskGroupId = null;
    renderAttach();
    renderMessages();
  }
  await renderHistory();
  histStatus("已删除", true);
}

async function openHistoryView() {
  await persistSession();
  $("hist-q").value = state.histQuery;
  histStatus("");
  await renderHistory();
  setView("history");
}

function fieldBlock(prefix, model) {
  const presetOpts = PRESETS.map(
    (p) => `<option value="${p.id}" ${p.id === model.preset ? "selected" : ""}>${p.name}</option>`,
  ).join("");
  return `
    <label class="field">预设
      <select data-k="${prefix}.preset">${presetOpts}</select>
    </label>
    <label class="field">base_url
      <input data-k="${prefix}.baseUrl" value="${escapeAttr(model.baseUrl)}" placeholder="https://api.example.com/v1" />
    </label>
    <label class="field">model_name
      <input data-k="${prefix}.model" value="${escapeAttr(model.model)}" placeholder="gpt-4o-mini" />
    </label>
    <label class="field">api_key
      <input data-k="${prefix}.apiKey" type="password" value="${escapeAttr(model.apiKey)}" placeholder="sk-…" autocomplete="off" />
    </label>
    <div class="row-btns">
      <button class="secondary" type="button" data-test="${prefix}">测试连接</button>
      <span class="status" data-test-status="${prefix}"></span>
    </div>
  `;
}

function escapeAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function renderSettingsForm() {
  $("block-text").querySelectorAll(".field, .row-btns").forEach((n) => n.remove());
  $("block-text").insertAdjacentHTML("beforeend", fieldBlock("text", state.settings.text));
  $("mm-same").checked = state.settings.multimodalSameAsText;
  $("mm-fields").innerHTML = fieldBlock("multimodal", state.settings.multimodal);
  $("mm-fields").classList.toggle("hidden", state.settings.multimodalSameAsText);
  $("answer-lang").value = state.settings.answerLanguage;
  $("ui-font").value = state.settings.uiFont || "md";
  renderShortcutList();
  bindSettingFields();
}

function renderShortcutList() {
  const list = $("shortcut-list");
  list.innerHTML = "";
  if (!Array.isArray(state.settings.shortcuts)) state.settings.shortcuts = [];
  state.settings.shortcuts.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    row.innerHTML = `
      <input class="shortcut-label" data-si="${index}" data-sk="label" value="${escapeAttr(item.label)}" placeholder="芯片名，如 找槽点" />
      <textarea class="shortcut-prompt" data-si="${index}" data-sk="prompt" rows="2" placeholder="点芯片时发给模型的完整问题">${escapeAttr(item.prompt)}</textarea>
      <button type="button" class="shortcut-del" data-del="${index}" title="删除">删</button>
    `;
    list.appendChild(row);
  });
  if (!state.settings.shortcuts.length) {
    const empty = document.createElement("p");
    empty.className = "lead";
    empty.textContent = "还没有自定义问题。";
    list.appendChild(empty);
  }
  list.querySelectorAll("[data-sk]").forEach((el) => {
    el.addEventListener("input", () => {
      const i = Number(el.dataset.si);
      const key = el.dataset.sk;
      if (!state.settings.shortcuts[i]) return;
      state.settings.shortcuts[i][key] = el.value;
    });
  });
  list.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.del);
      state.settings.shortcuts.splice(i, 1);
      renderShortcutList();
    });
  });
}

function openShortcutSettings() {
  renderSettingsForm();
  setView("settings");
  $("block-shortcuts")?.scrollIntoView({ block: "start" });
}

function bindSettingFields() {
  document.querySelectorAll("[data-k]").forEach((el) => {
    el.addEventListener("change", () => writeField(el));
    el.addEventListener("input", () => writeField(el));
  });
  document.querySelectorAll("[data-test]").forEach((btn) => {
    btn.addEventListener("click", () => runTest(btn.dataset.test));
  });
}

function writeField(el) {
  const [group, key] = el.dataset.k.split(".");
  state.settings[group][key] = el.value;
  if (key === "preset") {
    const preset = PRESETS.find((p) => p.id === el.value);
    if (preset && preset.baseUrl) {
      state.settings[group].baseUrl = preset.baseUrl;
      const input = document.querySelector(`[data-k="${group}.baseUrl"]`);
      if (input) input.value = preset.baseUrl;
    }
  }
}

async function runTest(group) {
  const status = document.querySelector(`[data-test-status="${group}"]`);
  const model = group === "multimodal" && state.settings.multimodalSameAsText
    ? state.settings.text
    : state.settings[group];
  if (!isModelReady(model)) {
    status.textContent = "请先填满 base_url、model_name、api_key";
    status.className = "status bad";
    return;
  }
  status.textContent = "测试中…";
  status.className = "status";
  try {
    const result = await testConnection(model);
    status.textContent = `可用 · ${result.ms}ms`;
    status.className = "status ok";
  } catch (err) {
    status.textContent = err.message || String(err);
    status.className = "status bad";
  }
}

async function pickTargetTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && !restrictedUrl(active.url)) return active;
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs.find((t) => t.url && !restrictedUrl(t.url)) || active || null;
}

async function refreshTab() {
  const tab = await pickTargetTab();
  state.tab = tab || null;
  if (!state.share || !tab || restrictedUrl(tab.url)) {
    state.pack = null;
    renderContext();
    renderSkills();
    return;
  }
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPage,
    });
    state.pack = result || null;
    if (result && /youtube\.com|youtu\.be/.test(tab.url || "")) {
      const caps = await loadYoutubeCaptions(tab.id, tab.url);
      state.pack.captionsStatus = caps.status;
      state.pack.captionsText = caps.text;
    }
  } catch {
    state.pack = {
      title: tab.title,
      url: tab.url,
      text: "",
      quotes: [],
      video: null,
    };
  }
  renderContext();
  renderSkills();
}

function currentKind(wantImage) {
  return wantImage || state.image ? "multimodal" : "text";
}

function requireModel(kind) {
  const model = resolveModel(state.settings, kind);
  if (isModelReady(model)) return model;
  setView("settings");
  $("save-status").textContent = kind === "multimodal"
    ? "先配置多模态模型，或勾选「与文本模型相同」"
    : "先配置文本模型";
  $("save-status").className = "status bad";
  return null;
}

function paintBot(botMsg) {
  const wrap = document.querySelector("#msgs .msg.bot:last-child");
  if (!wrap) return;
  let traceEl = wrap.querySelector(".trace");
  if (botMsg.trace.length) {
    if (!traceEl) {
      traceEl = document.createElement("div");
      traceEl.className = "trace";
      wrap.querySelector(".who")?.after(traceEl);
    }
    traceEl.textContent = botMsg.trace
      .map((t) => (t.ok === false ? `${t.name} 失败` : t.name))
      .join(" → ");
  }
  const body = wrap.querySelector(".body");
  if (body) fillBotBody(body, botMsg.text || "…", { mermaid: false });
  $("msgs").scrollTop = $("msgs").scrollHeight;
}

async function executeLoop({ userText, history, resume, turnsUsed, lastText, botMsg, model, clearImage }) {
  const skills = [...(state.skills || []), ...shortcutsAsSkills(state.settings)];
  const tools = createAgentTools({
    getTabId: () => state.tab?.id,
    getWindowId: () => state.tab?.windowId,
    refreshPack: async () => {
      await refreshTab();
      return state.pack;
    },
    capture: captureTab,
    setImage: (url) => {
      state.image = url;
      renderAttach();
    },
    onTabsMutated: async () => {
      await refreshTab();
    },
    getTaskGroupId: () => state.taskGroupId,
    setTaskGroupId: (id) => {
      state.taskGroupId = id;
    },
    getTaskGroupTitle: () => {
      const user = [...state.messages].reverse().find((m) => m.role === "user" && m.text);
      const line = String(user?.text || "任务").split("\n")[0].trim().slice(0, 24);
      return `PL · ${line || "任务"}`;
    },
    skills,
  });

  const loop = createAgentLoop({
    maxTurns: 12,
    systemPrompt: [systemPrompt(state.settings), skillCatalogText(skills)].filter(Boolean).join("\n\n"),
    tools,
    model: {
      async runTurn({ messages, tools: turnTools, signal, onTextDelta }) {
        const visionReady = Boolean(state.image) && isModelReady(resolveModel(state.settings, "multimodal"));
        const active = visionReady ? resolveModel(state.settings, "multimodal") : model;
        let msgs = messages;
        if (visionReady) {
          msgs = [
            ...messages,
            { role: "user", content: multimodalUserContent("当前标签页截图：", state.image) },
          ];
        }
        return streamTurn(active, { messages: msgs, tools: turnTools, signal }, onTextDelta);
      },
    },
  });

  state.busy = true;
  state.abort = new AbortController();
  state.run = {
    status: "running",
    history: history || [],
    lastText: lastText || "",
    turnsUsed: turnsUsed || 0,
    startedAt: resume && state.run?.startedAt ? state.run.startedAt : Date.now(),
  };
  $("btn-send").textContent = "■";
  $("btn-send").title = "停止";
  renderMessages();
  persistSession();

  let result = null;
  let failed = false;
  try {
    result = await loop.run(userText, {
      history,
      resume: Boolean(resume),
      turnsUsed: turnsUsed || 0,
      lastText: lastText || "",
      signal: state.abort.signal,
      onTextDelta: (delta) => {
        botMsg.text += delta;
        paintBot(botMsg);
      },
      onEvent: (ev) => {
        if (ev.type === "checkpoint" && !ev.done) {
          state.run = {
            status: "running",
            history: ev.history,
            lastText: ev.lastText,
            turnsUsed: ev.turnsUsed,
            startedAt: state.run?.startedAt || Date.now(),
          };
          persistSession();
        }
        if (ev.type === "compressed") {
          botMsg.trace.push({ name: "压缩上下文", ok: true });
          paintBot(botMsg);
        }
        if (ev.type === "turn_prepared" && botMsg.text) {
          botMsg.trace.push({ name: "思考", ok: true });
          botMsg.text = "";
        }
        if (ev.type === "tools_done") {
          botMsg.trace.push({ name: ev.name, ok: ev.ok });
          paintBot(botMsg);
        }
      },
    });
    const done = document.querySelector("#msgs .msg.bot:last-child .body");
    if (done && !botMsg.error) fillBotBody(done, botMsg.text, { mermaid: true });
  } catch (err) {
    if (err?.name === "AbortError") {
      botMsg.text = botMsg.text || (state.stopIntent === "user" ? "已停止。" : "已中断，重新打开侧栏会继续。");
    } else {
      botMsg.text = "请求失败：" + (err.message || String(err));
      botMsg.error = true;
      failed = true;
    }
    renderMessages();
  } finally {
    const userStop = state.stopIntent === "user";
    const finished = result?.reason === "stop" || result?.reason === "max_turns";
    if (userStop || finished || failed) state.run = null;
    state.busy = false;
    state.abort = null;
    state.stopIntent = null;
    $("btn-send").textContent = "↑";
    $("btn-send").title = "发送";
    if (clearImage) {
      state.image = null;
      renderAttach();
    }
    await persistSession();
  }
}

async function sendPrompt(userText, options = {}) {
  if (state.busy) {
    state.stopIntent = "user";
    state.abort?.abort();
    return;
  }
  const wantImage = Boolean(options.image || state.image);
  const kind = currentKind(wantImage);
  const model = requireModel(kind);
  if (!model) return;
  if (state.share && state.tab) await refreshTab();

  const pack = state.share ? state.pack : null;
  const image = options.image || state.image;
  const context = pack ? packToContext(pack) : "（用户未分享页面）";

  state.messages.push({ role: "user", text: userText, image: image || null });
  const botMsg = { role: "bot", text: "", trace: [] };
  state.messages.push(botMsg);

  const prior = [];
  for (const m of state.messages.slice(0, -2)) {
    if (m.error || (m.role === "bot" && !m.text)) continue;
    if (m.role === "user") prior.push({ role: "user", content: m.text });
    if (m.role === "bot") prior.push({ role: "assistant", content: m.text });
  }

  await executeLoop({
    userText: context ? `${userText}\n\n${context}` : userText,
    history: prior,
    resume: false,
    botMsg,
    model,
    clearImage: options.clearImage,
  });
}

async function resumeInterruptedRun() {
  const run = state.run;
  if (!isResumableRun(run)) return;
  const model = requireModel("text");
  if (!model) return;
  if (state.share && state.tab) await refreshTab();

  let botMsg = state.messages[state.messages.length - 1];
  if (!botMsg || botMsg.role !== "bot") {
    botMsg = { role: "bot", text: run.lastText || "", trace: [] };
    state.messages.push(botMsg);
  } else if (!botMsg.text) {
    botMsg.text = run.lastText || "";
  }
  botMsg.trace = Array.isArray(botMsg.trace) ? botMsg.trace : [];
  if (!botMsg.trace.some((t) => t.name === "从中断处继续")) {
    botMsg.trace.unshift({ name: "从中断处继续", ok: true });
  }

  await executeLoop({
    userText: "",
    history: run.history,
    resume: true,
    turnsUsed: run.turnsUsed,
    lastText: run.lastText,
    botMsg,
    model,
  });
}

async function runSkill(skill) {
  if (skill.image) {
    const shot = await captureTab();
    if (!shot) return;
    state.image = shot;
    renderAttach();
    await sendPrompt(skill.prompt, { image: shot, clearImage: true });
    return;
  }
  await sendPrompt(skill.prompt);
}

async function captureTab(tabId) {
  if (!tabId && !state.tab) await refreshTab();
  const id = tabId || state.tab?.id;
  if (!id && state.tab?.windowId == null) {
    pushError("没有可截取的标签");
    return null;
  }
  try {
    return await captureVisible(id, state.tab?.windowId);
  } catch (err) {
    pushError("截图失败：" + err.message);
    return null;
  }
}

function renderAttach() {
  const row = $("attach-row");
  row.classList.toggle("hidden", !state.image);
  if (state.image) $("attach-thumb").src = state.image;
}

async function consumePending() {
  const { pendingSelection } = await chrome.storage.session.get("pendingSelection");
  if (!pendingSelection) return;
  await chrome.storage.session.remove("pendingSelection");
  $("input").value = `关于这段选区：\n${pendingSelection}\n\n请解释它在本页里的含义。`;
  $("input").focus();
}

function wire() {
  $("btn-settings").addEventListener("click", () => {
    renderSettingsForm();
    setView("settings");
  });
  $("btn-back").addEventListener("click", () => {
    renderSkills();
    renderMessages();
    setView("chat");
  });
  $("btn-add-shortcut").addEventListener("click", () => {
    if (!Array.isArray(state.settings.shortcuts)) state.settings.shortcuts = [];
    state.settings.shortcuts.push({ id: crypto.randomUUID(), label: "", prompt: "" });
    renderShortcutList();
  });
  $("btn-new").addEventListener("click", () => {
    startNewSession();
  });
  $("btn-history").addEventListener("click", () => {
    openHistoryView();
  });
  $("btn-hist-back").addEventListener("click", () => {
    setView("chat");
  });
  $("btn-export-all-md").addEventListener("click", () => exportAll("md"));
  $("btn-export-all-json").addEventListener("click", () => exportAll("json"));
  $("hist-q").addEventListener("input", () => {
    state.histQuery = $("hist-q").value;
    renderHistory();
  });
  $("btn-unpin").addEventListener("click", () => {
    state.share = false;
    renderContext();
  });
  $("btn-save").addEventListener("click", async () => {
    state.settings = await saveSettings(state.settings);
    applyUiFont(state.settings.uiFont);
    renderModelLine();
    renderShortcutList();
    $("save-status").textContent = "已保存到本机";
    $("save-status").className = "status ok";
  });
  $("mm-same").addEventListener("change", (e) => {
    state.settings.multimodalSameAsText = e.target.checked;
    $("mm-fields").classList.toggle("hidden", e.target.checked);
  });
  $("answer-lang").addEventListener("change", (e) => {
    state.settings.answerLanguage = e.target.value;
  });
  $("ui-font").addEventListener("change", (e) => {
    state.settings.uiFont = e.target.value;
    applyUiFont(state.settings.uiFont);
  });
  $("btn-send").addEventListener("click", () => {
    if (state.busy) {
      state.stopIntent = "user";
      state.abort?.abort();
      return;
    }
    const text = $("input").value.trim();
    if (!text) return;
    $("input").value = "";
    fitInput();
    sendPrompt(text, { clearImage: true });
  });
  $("input").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      $("btn-send").click();
    }
  });
  $("input").addEventListener("input", fitInput);
  $("btn-shot").addEventListener("click", async () => {
    const shot = await captureTab();
    if (!shot) return;
    state.image = shot;
    renderAttach();
  });
  $("btn-clear-attach").addEventListener("click", () => {
    state.image = null;
    renderAttach();
  });
  chrome.tabs.onActivated.addListener(() => {
    state.share = state.settings.shareActiveTab;
    refreshTab();
  });
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (tab.active && (info.status === "complete" || info.title || info.url)) {
      refreshTab();
    }
  });
  window.addEventListener("pagehide", () => {
    persistSession();
  });
}

async function boot() {
  initMarkdown();
  state.settings = await loadSettings();
  applyUiFont(state.settings.uiFont);
  state.skills = await loadBundledSkills();
  const active = await loadActiveSession();
  if (active?.messages?.length) applySession(active);
  wire();
  renderModelLine();
  renderSkills();
  renderMessages();
  await refreshTab();
  await consumePending();
  if (!isModelReady(resolveModel(state.settings, "text"))) {
    renderSettingsForm();
    setView("settings");
    return;
  }
  if (isResumableRun(state.run)) {
    resumeInterruptedRun();
  } else if (state.run) {
    state.run = null;
    persistSession();
  }
}

boot();

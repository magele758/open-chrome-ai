import { defaultSettings, loadSettings, saveSettings, applyOptionalLocalSettings, resolveModel, isModelReady, isAsrReady, isTtsReady, useInterpretCaptions, isSkillsEnabled, presetsFor } from "../lib/storage.js";
import { streamTurn, testConnection, multimodalUserContent } from "../lib/openai.js";
import { testTranscriptions } from "../lib/asr.js";
import { testTts, synthesizeTts, getTtsRef, setTtsRef, clearTtsRef, blobToWav, TTS_LANGS } from "../lib/tts.js";
import { highlightQuote } from "../lib/extract.js";
import { loadTabPack } from "../lib/page-pack.js";
import { systemPrompt, packToContext, visibleSkills, formatTime } from "../lib/prompts.js";
import { summarizeTranscript } from "../lib/summarize-transcript.js";
import { loadPageCaptions, transcribeTab, usableTranscript } from "../lib/captions.js";
import { abortRecording, beginCapture, beginTabCapture, discardCapture, recordFromCapture } from "../lib/tab-audio.js";
import { injectVideo } from "../lib/chrome.js";
import { captionsForInterpret, runInterpret } from "../lib/interpret.js";
import {
  libraryStatus,
  pickLibraryFolder,
  setLibraryPath,
  clearSavedHandle,
  syncPackToLibrary,
  writeSessionNote,
  writeSessionNotes,
} from "../lib/library.js";
import { initMarkdown, formatAnswer, decorateInlines, bindMarkdownLinks, enhanceMermaid } from "../lib/markdown.js";
import { createAgentLoop } from "../lib/agent/loop.js";
import { createAgentTools } from "../lib/agent/tools.js";
import { loadRuntimeSkills, shortcutsAsSkills, skillCatalogText } from "../lib/agent/skills.js";
import { applySlashItem, composeSkillPrompt, filterSlashItems, parseSlashToken, slashItemsFromSkills, userInvokedSkill } from "../lib/slash.js";
import { pickSkillFolder, clearSkillFolderHandle, setSkillFolderPath, ensureSkillBody, skillFolderStatus } from "../lib/skill-folder.js";
import { installHint, pingNativeHost } from "../lib/native-host.js";
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

console.info("[pagelens] module start");

const $ = (id) => document.getElementById(id);

function on(id, event, handler) {
  const el = $(id);
  if (!el) {
    console.warn("[pagelens] wire missing", id);
    return null;
  }
  el.addEventListener(event, handler);
  return el;
}

let composerBound = false;

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
  skillsMetaReady: false,
  skillsMetaLoading: false,
  skillsMetaError: "",
  sessionId: null,
  sessionCreatedAt: null,
  sessionPages: [],
  histQuery: "",
  run: null,
  stopIntent: null,
  taskGroupId: null,
  transcribe: null,
  recordAbort: null,
  workAbort: null,
  interpret: null,
  siAbort: null,
  siCapture: null,
  originalAudioOn: true,
  library: { configured: false, granted: false, name: "" },
  skillFolder: { configured: false, granted: false, name: "", count: 0 },
  nativeHost: { ok: false, checked: false },
};

function modelSummary() {
  const text = resolveModel(state.settings, "text");
  const mm = resolveModel(state.settings, "multimodal");
  if (!isModelReady(text)) return "未配置文本模型 · 先到设置填 base_url / model / key";
  const t = text.model;
  const m = isModelReady(mm) ? mm.model : "未配多模态";
  const same = state.settings.multimodalSameAsText;
  const asr = isAsrReady(state.settings.asr) ? ` · ASR ${state.settings.asr.model || "自建"}` : "";
  const tts = isTtsReady(state.settings.tts) ? " · TTS" : "";
  const lib = state.library?.granted ? ` · 文稿夹 ${state.library.name}` : "";
  const sk = skillsOn()
    ? ` · Skills${state.skillsMetaReady ? ` ${state.skills.length}` : ""}`
    : "";
  const sh = state.settings.nativeShell !== false && state.nativeHost?.ok ? " · Shell" : "";
  return (same ? `文本/多模态 · ${t}` : `文本 ${t} · 多模态 ${m}`) + asr + tts + lib + sk + sh;
}

function skillsOn() {
  return isSkillsEnabled(state.settings);
}

function renderModelLine() {
  const el = $("model-line");
  if (el) el.textContent = modelSummary();
}

function syncComposerHints() {
  const input = $("input");
  if (input) {
    input.placeholder = skillsOn()
      ? "问这页 · / 选 skill · Enter 发送 · ⇧Enter 换行"
      : "问这页 · Enter 发送 · ⇧Enter 换行";
  }
  const send = $("btn-send");
  if (send) send.title = "发送（Enter）";
}

function syncSkillFolderControls() {
  $("block-skill-folder")?.classList.toggle("skills-off", !skillsOn());
  syncComposerHints();
}

function renderContext() {
  const tab = state.tab;
  if (!tab || !state.share) {
    $("ctx-label").textContent = "未分享页面";
    $("ctx-title").textContent = "当前页未分享";
    $("ctx-sub").textContent = "点工具栏打开本侧栏时，默认会带上当前标签";
    renderTranscribeAction();
    return;
  }
  const video = state.pack?.videoIsPrimary && state.pack?.video;
  $("ctx-label").textContent = video
    ? "正在观看"
    : state.pack?.kind === "x"
      ? "正在看帖"
      : state.pack?.kind === "pdf"
        ? "正在读 PDF"
        : "正在阅读";
  $("ctx-title").textContent = tab.title || "无标题";
  const bits = [hostOf(tab.url)];
  if (state.pack?.kind === "x") bits.push("已提取帖子");
  if (state.pack?.kind === "pdf") {
    bits.push("已提取 PDF");
    if (state.pack.pdfPages) bits.push(`${state.pack.pdfPages} 页`);
  } else if (state.pack?.pdfError) {
    bits.push("PDF 未抽出");
  }
  if (state.pack?.text) bits.push(`${state.pack.text.length} 字`);
  if (video) {
    bits.push(formatTime(video.duration));
    const src = state.pack?.captionsSource;
    if (state.pack?.captionsStatus === "ready") {
      bits.push(src === "asr-full" || src === "asr" || src === "asr-cache" ? "已转写" : "有字幕");
    } else {
      bits.push("无字幕");
    }
    const tr = state.transcribe;
    const si = state.interpret;
    if (si?.status === "running") {
      bits.push(si.mode === "captions" ? "同传中（跟字幕）" : "同传中（按声音）");
      if (si.hint) bits.push(si.hint);
    } else if (useInterpretCaptions(state.settings) === false) {
      bits.push("同传按声音切句");
    }
    if (tr?.status === "recording") {
      bits.push(`提取中 ${formatTime(tr.currentTime || 0)}/${formatTime(tr.duration || video.duration || 0)}`);
      if (tr.hint) bits.push(tr.hint);
    }
    if (tr?.status === "extracting" || tr?.status === "uploading") bits.push(tr.hint || "正在识别完整音轨");
    if (tr?.status === "error" && tr.error) bits.push(tr.error);
    if (si?.status === "error" && si.error) bits.push(si.error);
    if ((src === "asr-full" || src === "asr" || src === "asr-cache" || src === "interpret") && (!tr || tr.status === "done" || tr.status === "idle")) {
      bits.push("可以直接问总结或章节");
    }
    const n = Number(state.pack?.videoCount) || (Array.isArray(state.pack?.videos) ? state.pack.videos.length : 0);
    if (n > 1) {
      const idx = Number.isInteger(state.pack?.videoIndex) ? state.pack.videoIndex + 1 : 1;
      bits.push(`画面 ${idx}/${n}`);
    }
  }
  $("ctx-sub").textContent = bits.filter(Boolean).join(" · ");
  renderTranscribeAction();
}

const isTranscribing = () => ["extracting", "recording", "uploading"].includes(state.transcribe?.status);

function renderTranscribeAction() {
  const actions = $("ctx-actions");
  const btn = $("btn-transcribe");
  const sum = $("btn-summarize-video");
  const siBtn = $("btn-interpret");
  const capBtn = $("btn-interpret-captions");
  const audioBtn = $("btn-original-audio");
  const bar = $("btn-summarize-bar");
  const siBar = $("btn-interpret-bar");
  const sw = $("btn-video-switch");
  const live = $("si-live");
  const tr = state.transcribe;
  const si = state.interpret;
  const recording = isTranscribing();
  const interpreting = si?.status === "running";
  const asrCaps = state.pack?.captionsSource === "asr-full" || state.pack?.captionsSource === "asr" || state.pack?.captionsSource === "asr-cache" || state.pack?.captionsSource === "interpret";
  const capsReady = state.pack?.captionsStatus === "ready";
  const canShare = Boolean(state.share && state.tab);
  if (actions) actions.classList.toggle("hidden", !canShare && !recording && !interpreting);
  const draftLabel = recording ? "停止" : asrCaps ? "重新取文稿" : "只要文稿";
  if (btn) {
    btn.textContent = draftLabel;
    btn.classList.toggle("busy", Boolean(recording));
    btn.disabled = (!canShare && !recording) || interpreting;
  }
  if (sum) {
    sum.textContent = recording ? "提取中…" : interpreting ? "一键总结" : "一键总结";
    sum.disabled = recording || interpreting || !canShare;
  }
  const videoCount = Number(state.pack?.videoCount) || (Array.isArray(state.pack?.videos) ? state.pack.videos.length : 0);
  const hasPlayer = Boolean(state.pack?.video) || videoCount > 0 || interpreting;
  if (siBtn) {
    const followCaps = useInterpretCaptions(state.settings);
    siBtn.textContent = interpreting ? "停止同传" : "同声传译";
    siBtn.title = interpreting
      ? "停止同传"
      : followCaps
        ? "边看边出中文。有字幕则跟轴；无字幕按声音识别。"
        : "边看边出中文。已关闭跟字幕，按声音约 5 秒一切。";
    siBtn.classList.toggle("busy", Boolean(interpreting));
    siBtn.disabled = recording || (!canShare && !interpreting);
  }
  if (capBtn) {
    const followCaps = useInterpretCaptions(state.settings);
    capBtn.classList.toggle("hidden", !hasPlayer || (!canShare && !interpreting));
    capBtn.textContent = followCaps ? "用字幕" : "按声音";
    capBtn.title = followCaps
      ? "当前跟字幕轴断句。点此改为按声音约 5 秒一切。"
      : "当前不跟字幕。点此改回有字幕就跟轴。";
    capBtn.classList.toggle("busy", !followCaps);
    capBtn.disabled = interpreting || !canShare;
  }
  if (bar) {
    bar.textContent = recording ? "■" : "总";
    bar.title = recording ? "停止提取" : "一键总结";
    bar.classList.toggle("busy", Boolean(recording));
    bar.disabled = interpreting;
  }
  if (siBar) {
    siBar.textContent = interpreting ? "■" : "译";
    siBar.title = interpreting ? "停止同传" : "同声传译";
    siBar.classList.toggle("busy", Boolean(interpreting));
    siBar.disabled = recording;
  }
  if (audioBtn) {
    const on = state.originalAudioOn !== false;
    audioBtn.classList.toggle("hidden", !hasPlayer || (!canShare && !interpreting));
    audioBtn.textContent = on ? "关原声" : "开原声";
    audioBtn.title = on ? "关闭原视频声音" : "开启原视频声音";
    audioBtn.classList.toggle("busy", !on);
    audioBtn.disabled = !state.tab?.id;
  }
  if (sw) {
    const idx = Number.isInteger(state.pack?.videoIndex) ? state.pack.videoIndex : 0;
    sw.classList.toggle("hidden", videoCount < 2);
    sw.textContent = videoCount > 1 ? `画面 ${idx + 1}/${videoCount}` : "画面";
    sw.disabled = recording || interpreting;
  }
  if (live) {
    live.classList.toggle("hidden", !interpreting && !si?.zh);
    if (si?.zh) $("si-zh").textContent = si.zh;
    if (si?.src) $("si-src").textContent = si.src;
    if (interpreting && !si?.zh) {
      $("si-zh").textContent = si?.message || "同传已开始…";
      $("si-src").textContent = si?.hint || "";
    }
  }
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

function renderMessages() {
  const root = $("msgs");
  if (!root) return;
  root.innerHTML = "";
  if (!state.messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = isModelReady(resolveModel(state.settings, "text"))
      ? "直接问这页，或点「一键总结」「同声传译」。"
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
  state.messages.push({ role: "bot", text, error: true });
  renderMessages();
}

function setView(view) {
  state.view = view;
  $("view-chat")?.classList.toggle("hidden", view !== "chat");
  $("view-settings")?.classList.toggle("hidden", view !== "settings");
  $("view-history")?.classList.toggle("hidden", view !== "history");
  if (view !== "chat") hideSlashMenu();
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
  state.transcribe = null;
  state.recordAbort?.abort();
  state.workAbort?.abort();
  abortRecording();
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
    const ops = document.createElement("div");
    ops.className = "hist-ops";
    const exp = document.createElement("button");
    exp.type = "button";
    exp.className = "mini";
    exp.textContent = "导出";
    exp.title = "导出 Markdown";
    exp.addEventListener("click", (e) => {
      e.stopPropagation();
      exportOne(item.id);
    });
    const obsidian = document.createElement("button");
    obsidian.type = "button";
    obsidian.className = "mini";
    obsidian.textContent = "入库";
    obsidian.title = "写入文稿文件夹（Obsidian 可直接打开）";
    obsidian.addEventListener("click", (e) => {
      e.stopPropagation();
      importOneToLibrary(item.id);
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
    ops.append(obsidian, exp, del);
    row.append(main, ops);
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

function flashStatus(text, ok) {
  if (state.view === "history") {
    histStatus(text, ok);
    return;
  }
  const el = $("model-line");
  if (!el) return;
  el.textContent = text || "";
  window.setTimeout(() => renderModelLine(), 2600);
}

async function ensureLibraryForWrite() {
  let info = await libraryStatus({ request: true });
  if (!info.configured) {
    const picked = await pickLibraryFolder();
    info = { configured: true, granted: true, name: picked.name };
  }
  state.library = info;
  paintLibraryStatus(state.library);
  renderModelLine();
  if (!info.granted) {
    throw new Error(info.mode === "path"
      ? (info.error || "文稿路径不可用。确认已安装 Native Host，并到设置重新填路径。")
      : "文稿文件夹未授权。到设置点「重新授权」。");
  }
  return info;
}

async function importOneToLibrary(id) {
  if (id === state.sessionId) await persistSession();
  const data = await loadSession(id);
  if (!data) {
    flashStatus("没有可导入的内容", false);
    return;
  }
  try {
    await ensureLibraryForWrite();
    const saved = await writeSessionNote(data, { request: true });
    flashStatus(`已写入 ${saved.path}`, true);
  } catch (err) {
    if (err?.name === "AbortError") return;
    flashStatus(err.message || String(err), false);
  }
}

async function importAllToLibrary() {
  await persistSession();
  const all = await loadAllSessions();
  if (!all.length) {
    histStatus("没有可导入的对话", false);
    return;
  }
  try {
    await ensureLibraryForWrite();
    const saved = await writeSessionNotes(all, { request: true });
    histStatus(`已写入 ${saved.count} 条到 PageLens/sessions/`, true);
  } catch (err) {
    if (err?.name === "AbortError") return;
    histStatus(err.message || String(err), false);
  }
}

async function importCurrentToLibrary() {
  await persistSession();
  if (!state.sessionId) {
    flashStatus("还没有可保存的对话", false);
    return;
  }
  await importOneToLibrary(state.sessionId);
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

function fieldBlock(prefix, model, hints = {}) {
  const presetOpts = presetsFor(prefix).map(
    (p) => `<option value="${p.id}" ${p.id === model.preset ? "selected" : ""}>${p.name}</option>`,
  ).join("");
  return `
    <label class="field">预设
      <select data-k="${prefix}.preset">${presetOpts}</select>
    </label>
    <label class="field">base_url
      <input data-k="${prefix}.baseUrl" value="${escapeAttr(model.baseUrl)}" placeholder="${escapeAttr(hints.baseUrl || "https://api.example.com/v1")}" />
    </label>
    <label class="field">model_name
      <input data-k="${prefix}.model" value="${escapeAttr(model.model)}" placeholder="${escapeAttr(hints.model || "gpt-4o-mini")}" />
    </label>
    <label class="field">api_key
      <input data-k="${prefix}.apiKey" type="password" value="${escapeAttr(model.apiKey)}" placeholder="${escapeAttr(hints.key || "sk-…")}" autocomplete="off" />
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
  $("block-asr").querySelectorAll(".field, .row-btns").forEach((n) => n.remove());
  $("block-asr").insertAdjacentHTML(
    "beforeend",
    fieldBlock("asr", state.settings.asr, {
      baseUrl: "http://127.0.0.1:8002",
      model: "可空（自建已加载）",
      key: "可空",
    }) + asrExtraFields(state.settings.asr),
  );
  $("block-tts").querySelectorAll(".field, .row-btns, .tts-ref").forEach((n) => n.remove());
  $("block-tts").insertAdjacentHTML("beforeend", ttsFields(state.settings.tts));
  refreshTtsRefLabel();
  $("mm-same").checked = state.settings.multimodalSameAsText;
  $("mm-fields").innerHTML = fieldBlock("multimodal", state.settings.multimodal);
  $("mm-fields").classList.toggle("hidden", state.settings.multimodalSameAsText);
  $("answer-lang").value = state.settings.answerLanguage;
  $("ui-font").value = state.settings.uiFont || "md";
  if ($("native-shell")) $("native-shell").checked = state.settings.nativeShell !== false;
  if ($("skills-enabled")) $("skills-enabled").checked = skillsOn();
  syncSkillFolderControls();
  renderLibraryStatus();
  renderSkillFolderStatus();
  hydrateSkillFolderStatus().catch(() => {});
  renderNativeHostStatus();
  renderShortcutList();
  bindSettingFields();
  bindTtsRefControls();
}

function paintLibraryStatus(info, extra = "") {
  const el = $("library-status");
  if (!el) return;
  const reauth = $("btn-library-reauth");
  const input = $("library-path");
  if (info?.mode === "path" && info.path && input && document.activeElement !== input) {
    input.value = info.path;
  }
  if (!info?.configured) {
    el.textContent = extra || "尚未选择";
    el.className = "status";
    reauth?.classList.add("hidden");
    return;
  }
  if (info.mode === "path") {
    reauth?.classList.add("hidden");
    if (info.granted) {
      el.textContent = extra || `路径 · ${info.path || info.name}`;
      el.className = "status ok";
      return;
    }
    el.textContent = extra || info.error || `路径不可用 · ${info.path || info.name}`;
    el.className = "status bad";
    return;
  }
  if (info.granted) {
    el.textContent = extra || `已授权 · ${info.name}（浏览器不显示完整路径）`;
    el.className = "status ok";
    reauth?.classList.add("hidden");
    return;
  }
  el.textContent = extra || `已选 ${info.name}，需要重新授权`;
  el.className = "status bad";
  reauth?.classList.remove("hidden");
}

async function refreshLibraryStatus({ request = false } = {}) {
  try {
    state.library = await libraryStatus({ request });
  } catch {
    state.library = { configured: false, granted: false, name: "" };
  }
  paintLibraryStatus(state.library);
  renderModelLine();
}

function renderLibraryStatus() {
  paintLibraryStatus(state.library);
}

function paintSkillFolderStatus(info, extra = "") {
  const el = $("skill-folder-status");
  if (!el) return;
  const reauth = $("btn-skills-reauth");
  const refresh = $("btn-skills-refresh");
  const input = $("skill-path");
  if (info?.mode === "path" && info.path && input && document.activeElement !== input) {
    input.value = info.path;
  }
  if (!skillsOn()) {
    const path = info?.path || info?.name;
    el.textContent = extra || (info?.configured ? `已关闭 · 路径仍保留${path ? ` · ${path}` : ""}` : "已关闭（默认）");
    el.className = "status";
    reauth?.classList.add("hidden");
    refresh?.classList.add("hidden");
    return;
  }
  if (!info?.configured) {
    el.textContent = extra || "尚未选择";
    el.className = "status";
    reauth?.classList.add("hidden");
    refresh?.classList.add("hidden");
    return;
  }
  if (info.mode === "path") {
    reauth?.classList.add("hidden");
    if (info.granted) {
      const n = Number(info.count) || 0;
      const cap = info.truncated ? "，已达扫描上限" : "";
      el.textContent = extra || (state.skillsMetaReady
        ? `路径 · ${info.path || info.name} · ${n} 个 skill${cap}`
        : `路径 · ${info.path || info.name} · 输入 / 时再扫描`);
      el.className = "status ok";
      refresh?.classList.remove("hidden");
      return;
    }
    el.textContent = extra || info.error || `路径不可用 · ${info.path || info.name}`;
    el.className = "status bad";
    refresh?.classList.remove("hidden");
    return;
  }
  if (info.granted) {
    const n = Number(info.count) || 0;
    const cap = info.truncated ? "，已达扫描上限" : "";
    el.textContent = extra || (state.skillsMetaReady
      ? `已授权 · ${info.name} · ${n} 个 skill${cap}（浏览器不显示完整路径）`
      : `已授权 · ${info.name} · 输入 / 时再扫描`);
    el.className = "status ok";
    reauth?.classList.add("hidden");
    refresh?.classList.remove("hidden");
    return;
  }
  el.textContent = extra || `已选 ${info.name}，需要重新授权`;
  el.className = "status bad";
  reauth?.classList.remove("hidden");
  refresh?.classList.add("hidden");
}

function renderSkillFolderStatus() {
  paintSkillFolderStatus(state.skillFolder);
}

function folderPathDirty(raw, current) {
  const next = String(raw || "").trim();
  const cur = String(current || "").trim();
  if (!next) return "";
  return next === cur ? "" : next;
}

async function applyFolderPathsFromInputs() {
  const errors = [];
  const libRaw = folderPathDirty($("library-path")?.value, state.library?.path);
  if (libRaw) {
    try {
      paintLibraryStatus(state.library, "正在验证路径…");
      state.library = await setLibraryPath(libRaw);
      paintLibraryStatus(state.library);
      if (state.pack?.captionsStatus === "ready") syncPackToLibrary(state.pack).catch(() => {});
    } catch (err) {
      const msg = err.message || String(err);
      paintLibraryStatus(state.library, msg);
      errors.push(`文稿：${msg}`);
    }
  }
  const skillRaw = folderPathDirty($("skill-path")?.value, state.skillFolder?.path);
  if (skillRaw) {
    try {
      paintSkillFolderStatus(state.skillFolder, "正在验证路径…");
      const next = await setSkillFolderPath(skillRaw);
      state.skillFolder = { ...next, count: 0 };
      clearSkillsCache();
      paintSkillFolderStatus(state.skillFolder, `已设置 ${next.path}，输入 / 时再扫描`);
    } catch (err) {
      const msg = err.message || String(err);
      paintSkillFolderStatus(state.skillFolder, msg);
      errors.push(`Skill：${msg}`);
    }
  }
  renderModelLine();
  return errors;
}

function nativeInstallCommand() {
  const id = chrome.runtime?.id || "";
  return `node native/install-native-host.mjs${id ? ` --extension-id ${id}` : ""}`;
}

function paintNativeHostStatus(info, extra = "") {
  const el = $("native-host-status");
  const idEl = $("native-host-id");
  if (idEl && chrome.runtime?.id) {
    idEl.textContent = `扩展 ID：${chrome.runtime.id}。在仓库根目录执行：${nativeInstallCommand()}`;
  } else if (idEl) {
    idEl.textContent = installHint("");
  }
  if (!el) return;
  if (extra) {
    el.textContent = extra;
    el.className = /失败|未安装|关闭|对不上|错误/.test(extra) ? "status bad" : /可用|已接通/.test(extra) ? "status ok" : "status";
    return;
  }
  if (state.settings.nativeShell === false) {
    el.textContent = "已关闭";
    el.className = "status";
    return;
  }
  if (!info?.checked) {
    el.textContent = "未检测";
    el.className = "status";
    return;
  }
  if (info.ok) {
    el.textContent = `已接通 · ${info.version || "host"}${info.ms != null ? ` · ${info.ms}ms` : ""}`;
    el.className = "status ok";
    return;
  }
  el.textContent = info.error || "未安装";
  el.className = "status bad";
}

function renderNativeHostStatus() {
  paintNativeHostStatus(state.nativeHost);
}

async function refreshNativeHost({ silent = false } = {}) {
  if (!silent) paintNativeHostStatus(state.nativeHost, "测试中…");
  const res = await pingNativeHost();
  state.nativeHost = {
    checked: true,
    ok: res.ok === true,
    version: res.version || "",
    error: res.ok ? "" : res.error || "未安装",
    ms: res.ms,
  };
  paintNativeHostStatus(state.nativeHost);
  renderModelLine();
  return state.nativeHost;
}

async function copyText(text) {
  const value = String(text || "");
  if (!value) return;
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  throw new Error("剪贴板不可用。");
}

let skillScanGen = 0;
let slash = { open: false, items: [], index: 0, token: null };

function hideSlashMenu() {
  slash = { open: false, items: [], index: 0, token: null };
  const el = $("slash-menu");
  if (!el) return;
  el.innerHTML = "";
  el.classList.add("hidden");
}

function renderSlashMenu() {
  const el = $("slash-menu");
  if (!el) return;
  el.innerHTML = "";
  if (!slash.open) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  if (!slash.items.length) {
    const empty = document.createElement("div");
    empty.className = "slash-empty";
    empty.textContent = state.skillsMetaLoading
      ? "正在扫描 skill…"
      : state.skillsMetaError
        ? state.skillsMetaError
        : (state.skills || []).length
          ? "没有匹配的 skill"
          : "没有可用 skill。到设置选择 skill 目录。";
    el.appendChild(empty);
    return;
  }
  slash.items.forEach((item, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slash-item" + (i === slash.index ? " active" : "");
    btn.setAttribute("role", "option");
    const n = document.createElement("div");
    n.className = "n";
    n.textContent = item.name;
    btn.appendChild(n);
    const detail = [item.id !== item.name ? item.id : "", item.hint].filter(Boolean).join(" · ");
    if (detail) {
      const d = document.createElement("div");
      d.className = "d";
      d.textContent = detail;
      btn.appendChild(d);
    }
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      pickSlashItem(item);
    });
    el.appendChild(btn);
  });
  el.querySelector(".slash-item.active")?.scrollIntoView({ block: "nearest" });
}

function updateSlashMenu() {
  const input = $("input");
  if (!input || state.view !== "chat" || !skillsOn()) {
    hideSlashMenu();
    return;
  }
  const token = parseSlashToken(input.value, input.selectionStart);
  if (!token) {
    hideSlashMenu();
    return;
  }
  if (state.skillsMetaLoading || !state.skillsMetaReady) {
    slash = { open: true, items: [], index: 0, token };
    renderSlashMenu();
    if (!state.skillsMetaLoading && !state.skillsMetaError) ensureSkillsMeta();
    return;
  }
  const items = filterSlashItems(slashItemsFromSkills(state.skills), token.query);
  const sameQuery = slash.open && slash.token && slash.token.query === token.query;
  slash = {
    open: true,
    items,
    index: sameQuery ? Math.min(slash.index, Math.max(0, items.length - 1)) : 0,
    token,
  };
  renderSlashMenu();
}

function pickSlashItem(item) {
  const input = $("input");
  if (!input || !item) {
    hideSlashMenu();
    return;
  }
  const token = slash.token || parseSlashToken(input.value, input.selectionStart);
  if (!token) {
    hideSlashMenu();
    return;
  }
  const next = applySlashItem(input.value, token, item);
  input.value = next.text;
  input.setSelectionRange(next.cursor, next.cursor);
  hideSlashMenu();
  fitInput();
  input.focus();
  if (item.skill) ensureSkillBody(item.skill).catch(() => {});
}

function handleSlashKey(e) {
  if (!slash.open || e.isComposing) return false;
  if (e.key === "Escape") {
    e.preventDefault();
    hideSlashMenu();
    return true;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!slash.items.length) return true;
    const delta = e.key === "ArrowDown" ? 1 : -1;
    slash.index = (slash.index + delta + slash.items.length) % slash.items.length;
    renderSlashMenu();
    return true;
  }
  if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
    if (!slash.items.length) return false;
    e.preventDefault();
    pickSlashItem(slash.items[slash.index]);
    return true;
  }
  return false;
}

let skillsMetaPromise = null;

function clearSkillsCache() {
  skillScanGen += 1;
  skillsMetaPromise = null;
  state.skills = [];
  state.skillsMetaReady = false;
  state.skillsMetaLoading = false;
  state.skillsMetaError = "";
}

async function hydrateSkillFolderStatus() {
  try {
    const status = await skillFolderStatus();
    state.skillFolder = {
      configured: status.configured,
      granted: status.granted,
      mode: status.mode || "",
      name: status.name || "",
      path: status.path || "",
      count: state.skillsMetaReady ? state.skillFolder.count || status.count || 0 : 0,
      truncated: state.skillFolder.truncated === true,
      error: status.error || "",
    };
    paintSkillFolderStatus(state.skillFolder);
  } catch (err) {
    console.warn("[pagelens] skill status", err);
  }
}

async function ensureSkillsMeta({ force = false, timeoutMs = 8000, request = false } = {}) {
  if (!skillsOn()) {
    console.info("[pagelens] skill scan skip");
    state.skills = [];
    state.skillsMetaReady = true;
    state.skillsMetaLoading = false;
    state.skillsMetaError = "";
    return state.skillFolder;
  }
  if (state.skillsMetaReady && !force) return state.skillFolder;
  if (skillsMetaPromise && !force) return skillsMetaPromise;
  const gen = ++skillScanGen;
  state.skillsMetaLoading = true;
  state.skillsMetaError = "";
  if (force) state.skillsMetaReady = false;
  if (state.skillFolder?.configured) {
    paintSkillFolderStatus(state.skillFolder, "正在扫描…");
  }
  const run = (async () => {
    try {
      const loaded = await withTimeout(
        loadRuntimeSkills({ request, timeoutMs }),
        timeoutMs,
        "扫描 skill 超时",
      );
      if (gen !== skillScanGen) return state.skillFolder;
      state.skillFolder = {
        configured: loaded.folder.configured,
        granted: loaded.folder.granted,
        mode: loaded.folder.mode || "",
        name: loaded.folder.name || "",
        path: loaded.folder.path || "",
        count: loaded.folder.count || 0,
        truncated: loaded.folder.truncated === true,
        error: loaded.folder.error || "",
      };
      state.skills = loaded.skills;
      state.skillsMetaReady = true;
      state.skillsMetaError = loaded.folder.error || "";
    } catch (err) {
      if (gen !== skillScanGen) return state.skillFolder;
      console.warn("[pagelens] skill scan timeout/error", err);
      state.skillsMetaError = err?.message || String(err);
      state.skillsMetaReady = false;
    } finally {
      if (gen === skillScanGen) {
        state.skillsMetaLoading = false;
        if (skillsMetaPromise === run) skillsMetaPromise = null;
        paintSkillFolderStatus(state.skillFolder);
        renderModelLine();
        if (slash.open) updateSlashMenu();
      }
    }
    return state.skillFolder;
  })();
  skillsMetaPromise = run;
  return run;
}

function renderShortcutList() {
  const list = $("shortcut-list");
  if (!list) return;
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

function asrExtraFields(asr) {
  const lang = asr?.language || "";
  return `
    <label class="field">识别语言
      <select data-k="asr.language">
        <option value="" ${lang === "" ? "selected" : ""}>自动</option>
        <option value="zh" ${lang === "zh" ? "selected" : ""}>中文</option>
        <option value="en" ${lang === "en" ? "selected" : ""}>English</option>
      </select>
    </label>
  `;
}

function ttsFields(tts) {
  const presetOpts = presetsFor("tts").map(
    (p) => `<option value="${p.id}" ${p.id === tts.preset ? "selected" : ""}>${p.name}</option>`,
  ).join("");
  const langOpts = TTS_LANGS.map(
    (l) => `<option value="${l}" ${l === tts.lang ? "selected" : ""}>${l}</option>`,
  ).join("");
  return `
    <label class="field">预设
      <select data-k="tts.preset">${presetOpts}</select>
    </label>
    <label class="field">base_url
      <input data-k="tts.baseUrl" value="${escapeAttr(tts.baseUrl)}" placeholder="http://127.0.0.1:7860" />
    </label>
    <label class="field">语言
      <select data-k="tts.lang">${langOpts}</select>
    </label>
    <label class="field">时长系数 duration_factor
      <input data-k="tts.durationFactor" type="number" min="0.5" max="2" step="0.05" value="${escapeAttr(tts.durationFactor)}" />
    </label>
    <div class="tts-ref">
      <label class="field">参考音色
        <input id="tts-ref-file" type="file" accept="audio/wav,audio/x-wav,audio/mpeg,.wav,.mp3" />
      </label>
      <div class="row-btns">
        <button class="secondary" type="button" id="btn-tts-ref-video">从当前视频截取音色</button>
        <button class="secondary" type="button" id="btn-tts-ref-clear">清除参考音</button>
        <span class="status" id="tts-ref-status"></span>
      </div>
    </div>
    <div class="row-btns">
      <button class="secondary" type="button" data-test="tts">测试连接</button>
      <button class="secondary" type="button" id="btn-tts-preview">试听一句</button>
      <span class="status" data-test-status="tts"></span>
    </div>
  `;
}

async function refreshTtsRefLabel() {
  const el = $("tts-ref-status");
  if (!el) return;
  const rec = await getTtsRef();
  if (!rec) {
    el.textContent = "未上传";
    el.className = "status";
    return;
  }
  const kb = Math.max(1, Math.round((rec.bytes || 0) / 1024));
  el.textContent = `${rec.name || "ref.wav"} · ${kb} KB`;
  el.className = "status ok";
}

function bindTtsRefControls() {
  $("tts-ref-file")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    const el = $("tts-ref-status");
    if (!file) return;
    try {
      await setTtsRef({ blob: file, name: file.name, type: file.type });
      await refreshTtsRefLabel();
    } catch (err) {
      if (el) {
        el.textContent = err.message || String(err);
        el.className = "status bad";
      }
    }
  });
  $("btn-tts-ref-clear")?.addEventListener("click", async () => {
    await clearTtsRef();
    const input = $("tts-ref-file");
    if (input) input.value = "";
    await refreshTtsRefLabel();
  });
  $("btn-tts-ref-video")?.addEventListener("click", () => captureVoiceRef());
  $("btn-tts-preview")?.addEventListener("click", () => previewTts());
}

async function captureVoiceRef() {
  const el = $("tts-ref-status");
  if (!state.tab?.id) {
    if (el) {
      el.textContent = "先打开要配音的视频标签";
      el.className = "status bad";
    }
    return;
  }
  if (el) {
    el.textContent = "正在从当前画面录约 7 秒，请让人声清楚播放…";
    el.className = "status";
  }
  let capture = null;
  try {
    capture = await beginTabCapture(state.tab.id);
    const rec = await recordFromCapture(capture, { maxSeconds: 7, minSeconds: 3, fromStart: false });
    capture = null;
    const wav = await blobToWav(rec.blob);
    const saved = await setTtsRef({ blob: wav, name: "video-ref.wav", type: "audio/wav" });
    await refreshTtsRefLabel();
    if (el) {
      el.textContent = `已截取 ${saved.name} · 可点试听（用译文合成这个音色）`;
      el.className = "status ok";
    }
  } catch (err) {
    if (el) {
      el.textContent = err.message || String(err);
      el.className = "status bad";
    }
  } finally {
    await discardCapture(capture);
  }
}

async function previewTts() {
  const status = document.querySelector(`[data-test-status="tts"]`);
  if (!isTtsReady(state.settings.tts)) {
    if (status) {
      status.textContent = "先填配音 base_url 并上传参考音";
      status.className = "status bad";
    }
    return;
  }
  if (status) {
    status.textContent = "合成中…";
    status.className = "status";
  }
  try {
    const rec = await getTtsRef();
    if (!rec) throw new Error("请先上传参考音色 wav");
    const out = await synthesizeTts(state.settings.tts, "你好，这是 PageLens 试听。");
    const url = URL.createObjectURL(out.blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
    if (status) {
      status.textContent = "已播放";
      status.className = "status ok";
    }
  } catch (err) {
    if (status) {
      status.textContent = err.message || String(err);
      status.className = "status bad";
    }
  }
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
  if (!state.settings[group]) state.settings[group] = {};
  if (key === "durationFactor") state.settings[group][key] = Number(el.value) || 1;
  else state.settings[group][key] = el.value;
  if (key === "preset") {
    const preset = presetsFor(group).find((p) => p.id === el.value);
    if (preset) {
      state.settings[group].baseUrl = preset.baseUrl || "";
      const input = document.querySelector(`[data-k="${group}.baseUrl"]`);
      if (input) input.value = preset.baseUrl || "";
    }
  }
}

async function runTest(group) {
  const status = document.querySelector(`[data-test-status="${group}"]`);
  const model = group === "multimodal" && state.settings.multimodalSameAsText
    ? state.settings.text
    : state.settings[group];
  if (group === "asr") {
    if (!isAsrReady(model)) {
      status.textContent = "请先填 ASR 的 base_url";
      status.className = "status bad";
      return;
    }
  } else if (group === "tts") {
    if (!isTtsReady(model)) {
      status.textContent = "请先填配音 base_url";
      status.className = "status bad";
      return;
    }
  } else if (!isModelReady(model)) {
    status.textContent = "请先填满 base_url、model_name、api_key";
    status.className = "status bad";
    return;
  }
  status.textContent = "测试中…";
  status.className = "status";
  try {
    let result;
    if (group === "asr") result = await testTranscriptions(model);
    else if (group === "tts") result = await testTts(model);
    else result = await testConnection(model);
    status.textContent = `可用 · ${result.ms}ms${result.note ? ` · ${result.note}` : ""}`;
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
  const prevId = state.tab?.id;
  const tab = await pickTargetTab();
  const recording = isTranscribing();
  const interpreting = state.interpret?.status === "running";
  if (!recording && !interpreting && tab?.id !== prevId) state.transcribe = null;
  if (interpreting && tab?.id && prevId && tab.id !== prevId) stopInterpret();
  if (recording && (tab?.id !== prevId || tab?.url !== state.tab?.url)) state.workAbort?.abort();
  state.tab = tab || null;
  if ((recording || state.interpret?.status === "running") && tab?.id === prevId) {
    renderContext();
    return;
  }
  if (!state.share || !tab || restrictedUrl(tab.url)) {
    state.pack = null;
    renderContext();
    renderSkills();
    return;
  }
  try {
    const result = await loadTabPack(tab.id);
    state.pack = result || null;
    if (result && (result.videoIsPrimary || result.video || /youtube\.com|youtu\.be|bilibili\.com/.test(tab.url || ""))) {
      const caps = await loadPageCaptions(tab.id, tab.url);
      state.pack.captionsStatus = caps.status;
      state.pack.captionsText = caps.text;
      state.pack.captionsSource = caps.source;
      state.pack.captionsCues = caps.cues;
      state.pack.captionsComplete = caps.complete === true;
      if (caps.status === "ready") syncPackToLibrary(state.pack).catch(() => {});
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

function needModelMessage(kind) {
  return kind === "multimodal"
    ? "未配置多模态模型。点右上角「设」，或勾选「与文本模型相同」。"
    : "未配置文本模型。点右上角「设」填 base_url / model / key。";
}

function requireModel(kind) {
  const model = resolveModel(state.settings, kind);
  if (isModelReady(model)) return model;
  console.warn("[pagelens] no-model", kind);
  const el = $("save-status");
  if (el) {
    el.textContent = needModelMessage(kind);
    el.className = "status bad";
  }
  return null;
}

function isPlaceholderBotText(text) {
  const s = String(text || "").trim();
  return !s || s === "…";
}

function paintBot(botMsg) {
  const bots = document.querySelectorAll("#msgs .msg.bot");
  const wrap = bots[bots.length - 1];
  if (!wrap) return;
  const trace = Array.isArray(botMsg.trace) ? botMsg.trace : [];
  let traceEl = wrap.querySelector(".trace");
  if (trace.length) {
    if (!traceEl) {
      traceEl = document.createElement("div");
      traceEl.className = "trace";
      wrap.querySelector(".who")?.after(traceEl);
    }
    traceEl.textContent = trace
      .map((t) => (t.ok === false ? `${t.name} 失败` : t.name))
      .join(" → ");
  }
  const body = wrap.querySelector(".body");
  if (body) fillBotBody(body, botMsg.text || "…", { mermaid: false });
  const root = $("msgs");
  if (root) root.scrollTop = root.scrollHeight;
}

function lastUserAskedForSkill() {
  const lastUser = [...state.messages].reverse().find((m) => m.role === "user" && m.text);
  return userInvokedSkill(lastUser?.text || "");
}

async function executeLoop({ userText, history, resume, turnsUsed, lastText, botMsg, model, clearImage }) {
  const useSkills = skillsOn() && lastUserAskedForSkill();
  const skills = useSkills ? [...(state.skills || []), ...shortcutsAsSkills(state.settings)] : [];
  let tools;
  let loop;
  try {
    tools = createAgentTools({
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
    getAbortSignal: () => state.abort?.signal,
    getSessionId: () => state.sessionId,
    setCaptions: applyCaptions,
    onTranscribeProgress: (info) => {
      state.transcribe = { ...(state.transcribe || {}), ...info };
      renderContext();
    },
    skills,
    settings: state.settings,
    nativeShell: state.settings.nativeShell !== false,
    enableSkills: useSkills,
  });

    loop = createAgentLoop({
    maxTurns: 12,
    systemPrompt: [systemPrompt(state.settings, { useSkills }), useSkills ? skillCatalogText(skills) : ""].filter(Boolean).join("\n\n"),
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
  } catch (err) {
    console.error("[pagelens] executeLoop setup", err);
    botMsg.text = "请求失败：" + (err.message || String(err));
    botMsg.error = true;
    renderMessages();
    return;
  }
  console.info("[pagelens] executeLoop", { tools: tools.length, useSkills });

  state.busy = true;
  state.abort = new AbortController();
  state.run = {
    status: "running",
    history: history || [],
    lastText: lastText || "",
    turnsUsed: turnsUsed || 0,
    startedAt: resume && state.run?.startedAt ? state.run.startedAt : Date.now(),
  };
  if ($("btn-send")) {
    $("btn-send").textContent = "■";
    $("btn-send").title = "停止";
  }

  let result = null;
  let failed = false;
  try {
    try {
      renderMessages();
    } catch (err) {
      console.error("[pagelens] renderMessages", err);
    }
    persistSession();
    result = await loop.run(userText, {
      history,
      resume: Boolean(resume),
      turnsUsed: turnsUsed || 0,
      lastText: lastText || "",
      signal: state.abort.signal,
      onTextDelta: (delta) => {
        if (isPlaceholderBotText(botMsg.text)) botMsg.text = "";
        botMsg.text += delta;
        try {
          paintBot(botMsg);
        } catch (err) {
          console.warn("[pagelens] paintBot", err);
        }
      },
      onEvent: (ev) => {
        try {
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
          if (ev.type === "turn_prepared") {
            if (!isPlaceholderBotText(botMsg.text)) {
              botMsg.trace.push({ name: "思考", ok: true });
              botMsg.text = "";
            }
            paintBot(botMsg);
          }
          if (ev.type === "model_done" && ev.content && isPlaceholderBotText(botMsg.text)) {
            botMsg.text = ev.content;
            paintBot(botMsg);
          }
          if (ev.type === "tools_done") {
            botMsg.trace.push({ name: ev.name, ok: ev.ok });
            paintBot(botMsg);
          }
        } catch (err) {
          console.warn("[pagelens] onEvent", err);
        }
      },
    });
    if (!botMsg.error) {
      if (result?.text) botMsg.text = result.text;
      else if (isPlaceholderBotText(botMsg.text)) {
        botMsg.text = result?.reason === "abort" ? "已停止。" : "模型未返回正文，请重试或检查模型服务。";
        botMsg.error = result?.reason !== "abort";
      }
      renderMessages();
    }
  } catch (err) {
    if (err?.name === "AbortError") {
      console.warn("[pagelens] executeLoop abort");
      botMsg.text = botMsg.text || (state.stopIntent === "user" ? "已停止。" : "已中断，重新打开侧栏会继续。");
    } else {
      console.error("[pagelens] executeLoop", err);
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
    if ($("btn-send")) {
      $("btn-send").textContent = "↑";
      $("btn-send").title = "发送（Enter）";
    }
    if (clearImage) {
      state.image = null;
      renderAttach();
    }
    await persistSession();
    console.info("[pagelens] executeLoop done", failed ? "fail" : result?.reason || "ok");
  }
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label || `超时 ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function sendPrompt(userText, options = {}) {
  const text = String(userText || "").trim();
  console.info("[pagelens] sendPrompt", text.slice(0, 80) || "(empty)");
  if (!text && !options.image && !state.image) {
    console.warn("[pagelens] sendPrompt empty");
    return;
  }
  if (state.view !== "chat") setView("chat");
  if (state.busy) {
    console.warn("[pagelens] sendPrompt busy, abort previous then send");
    state.stopIntent = "user";
    state.abort?.abort();
    await settleBusy();
    if (state.busy) {
      console.warn("[pagelens] sendPrompt force-clear busy");
      state.busy = false;
      state.abort = null;
      state.stopIntent = null;
    }
  }

  const image = options.image || state.image;
  state.messages.push({ role: "user", text: text || userText, image: image || null });
  const botMsg = { role: "bot", text: "…", trace: [] };
  state.messages.push(botMsg);
  try {
    renderMessages();
  } catch (err) {
    console.error("[pagelens] renderMessages", err);
  }

  const wantImage = Boolean(image);
  const kind = currentKind(wantImage);
  const model = requireModel(kind);
  if (!model) {
    console.warn("[pagelens] sendPrompt no-model");
    botMsg.text = needModelMessage(kind);
    botMsg.error = true;
    renderMessages();
    return;
  }

  try {
    console.info("[pagelens] sendPrompt executeLoop");
    if (state.share && state.tab) {
      try {
        await withTimeout(refreshTab(), 8000, "读当前页超时，先用已缓存内容。");
      } catch (err) {
        console.warn("[pagelens] refreshTab", err);
        botMsg.trace.push({ name: "读页", ok: false });
      }
    }
    const pack = state.share ? state.pack : null;
    const context = pack ? packToContext(pack) : "（用户未分享页面）";
    const prior = [];
    for (const m of state.messages.slice(0, -2)) {
      if (m.error || (m.role === "bot" && !m.text)) continue;
      if (m.role === "user") prior.push({ role: "user", content: m.text });
      if (m.role === "bot") prior.push({ role: "assistant", content: m.text });
    }
    let loopText = text || userText;
    if (skillsOn() && userInvokedSkill(loopText)) {
      try {
        await ensureSkillsMeta();
      } catch (err) {
        console.warn("[pagelens] skills meta", err);
        botMsg.trace.push({ name: "skill 扫描", ok: false });
      }
      const runtimeSkills = [...(state.skills || []), ...shortcutsAsSkills(state.settings)];
      try {
        loopText = await withTimeout(
          composeSkillPrompt(loopText, runtimeSkills, { loadBody: ensureSkillBody }),
          8000,
          "读取 skill 超时",
        );
      } catch (err) {
        console.warn("[pagelens] skill body", err);
        botMsg.trace.push({ name: "读取 skill", ok: false });
      }
    }
    await executeLoop({
      userText: context ? `${loopText}\n\n${context}` : loopText,
      history: prior,
      resume: false,
      botMsg,
      model,
      clearImage: options.clearImage,
    });
    console.info("[pagelens] sendPrompt ok");
  } catch (err) {
    console.error("[pagelens] sendPrompt fail", err);
    botMsg.text = "请求失败：" + (err.message || String(err));
    botMsg.error = true;
    state.busy = false;
    renderMessages();
  }
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
  const prompt = String(skill?.prompt || "").trim();
  console.info("[pagelens] chip", skill?.label || "", prompt.slice(0, 80));
  if (!prompt) {
    console.warn("[pagelens] chip empty prompt");
    return;
  }
  if (skill.image) {
    const shot = await captureTab();
    if (!shot) return;
    state.image = shot;
    renderAttach();
    await sendPrompt(prompt, { image: shot, clearImage: true });
    return;
  }
  await sendPrompt(prompt);
}

function applyCaptions(caps) {
  if (!caps) return;
  if (!state.pack) state.pack = {};
  state.pack.captionsStatus = caps.status;
  state.pack.captionsText = caps.text;
  state.pack.captionsSource = caps.source;
  state.pack.captionsCues = caps.cues;
  state.pack.captionsComplete = caps.complete === true;
  renderContext();
  if (caps.status === "ready") syncPackToLibrary(state.pack).catch(() => {});
}

function stopInterpret() {
  state.siAbort?.abort();
  abortRecording();
  const capture = state.siCapture;
  state.siCapture = null;
  state.originalAudioOn = true;
  if (state.interpret?.status === "running") {
    state.interpret = { ...(state.interpret || {}), status: "idle" };
    renderContext();
  }
  discardCapture(capture).catch(() => {});
}

function needAsrSettings(message) {
  renderSettingsForm();
  setView("settings");
  $("save-status").textContent = message || "先配置语音转写（ASR）的 base_url";
  $("save-status").className = "status bad";
  $("block-asr")?.scrollIntoView({ block: "start" });
}

async function startTranscribe({ force = false } = {}) {
  if (!state.tab?.id) return null;
  if (state.interpret?.status === "running") stopInterpret();
  if (isTranscribing()) {
    state.workAbort?.abort();
    return null;
  }
  if (state.busy) return null;
  const tab = { ...state.tab };
  const abort = new AbortController();
  state.workAbort = abort;
  state.transcribe = { status: "extracting", hint: "正在获取完整字幕或音轨" };
  renderContext();
  try {
    const caps = await transcribeTab({
      tabId: tab.id, settings: state.settings, force, signal: abort.signal,
      onProgress: (info) => {
        if (state.workAbort !== abort) return;
        state.transcribe = { ...(state.transcribe || {}), ...info };
        renderContext();
      },
    });
    abort.signal.throwIfAborted();
    if (state.tab?.id !== tab.id || state.tab?.url !== tab.url) return null;
    applyCaptions(caps);
    state.transcribe = { status: "done" };
    renderContext();
    return caps;
  } catch (err) {
    state.transcribe = err?.name === "AbortError" ? { status: "idle" } : { status: "error", error: err.message || String(err) };
    renderContext();
    return null;
  } finally {
    if (state.workAbort === abort) state.workAbort = null;
  }
}

async function startSummarizeVideo() {
  if (state.interpret?.status === "running") stopInterpret();
  if (isTranscribing()) {
    pushError("正在获取文稿，请稍候再点「一键总结」。");
    return;
  }
  if (state.busy) return;
  const model = requireModel("text");
  if (!model) {
    pushError(needModelMessage("text"));
    return;
  }
  const packed = usableTranscript({
    status: state.pack?.captionsStatus,
    text: state.pack?.captionsText,
    cues: state.pack?.captionsCues,
    source: state.pack?.captionsSource,
    complete: state.pack?.captionsComplete === true,
  });
  let caps = packed?.complete ? packed : null;
  if (!caps?.text) {
    const extracted = await startTranscribe();
    caps = usableTranscript(extracted) || packed;
  }
  if (!caps?.text) {
    pushError(state.transcribe?.error || "没有可总结的文稿。有字幕会直接总结；否则请启动本机媒体服务。");
    return;
  }
  const title = state.pack?.title || state.tab?.title;
  const abort = new AbortController();
  state.busy = true;
  state.abort = abort;
  state.messages.push({ role: "user", text: "总结整个视频的完整文稿，列出要点和带时间戳的章节。" });
  const botMsg = { role: "bot", text: "正在阅读完整文稿…", trace: [] };
  state.messages.push(botMsg);
  $("btn-send").textContent = "■";
  $("btn-send").title = "停止";
  renderMessages();
  try {
    botMsg.text = await summarizeTranscript({
      text: caps.text, title, model, language: state.settings.answerLanguage, signal: abort.signal,
      onProgress: hint => { botMsg.text = hint; paintBot(botMsg); },
    });
  } catch (error) {
    botMsg.text = error?.name === 'AbortError' ? '已停止总结，完整文稿已保留。' : `全文总结失败：${error.message || error}`;
    botMsg.error = error?.name !== 'AbortError';
  } finally {
    state.busy = false;
    state.abort = null;
    state.stopIntent = null;
    $("btn-send").textContent = "↑";
    $("btn-send").title = "发送（Enter）";
    renderMessages();
    await persistSession();
  }
}

async function toggleInterpretCaptions() {
  if (state.interpret?.status === "running") return;
  const next = useInterpretCaptions(state.settings) === false;
  try {
    state.settings = await saveSettings({ ...state.settings, interpretUseCaptions: next });
    renderContext();
  } catch (err) {
    pushError("无法保存同传设置：" + (err?.message || err));
  }
}

async function toggleOriginalAudio() {
  if (!state.tab?.id) return;
  const next = state.originalAudioOn === false;
  state.originalAudioOn = next;
  renderContext();
  try {
    await injectVideo(state.tab.id, next ? "restore" : "silence");
    state.siCapture?.playback?.setGain?.(next ? 1 : 0);
  } catch (err) {
    state.originalAudioOn = !next;
    renderContext();
    pushError("无法切换原声：" + (err?.message || err));
  }
}

async function startInterpret() {
  if (!state.tab?.id) return;
  if (state.interpret?.status === "running") {
    stopInterpret();
    return;
  }
  if (isTranscribing()) {
    startTranscribe();
    return;
  }
  const followCaps = useInterpretCaptions(state.settings);
  const cues = captionsForInterpret(
    state.pack?.captionsStatus === "ready" ? state.pack.captionsCues : [],
    followCaps,
  );
  if (!cues.length && !isAsrReady(state.settings.asr)) {
    needAsrSettings(followCaps ? "无字幕视频要同传，先配置语音转写（ASR）" : "按声音同传需要先配置语音转写（ASR）");
    return;
  }
  if (cues.length && shouldNeedTranslate(cues) && !requireModel("text")) {
    pushError(needModelMessage("text"));
    return;
  }
  if (!cues.length && !requireModel("text")) {
    pushError(needModelMessage("text"));
    return;
  }

  let startAt = 0;
  let openingHold = false;
  try {
    await injectVideo(state.tab.id, "pick", { fresh: true });
    const st = await injectVideo(state.tab.id, "state");
    startAt = Number(st?.currentTime) || 0;
    openingHold = Boolean(st?.ok && !st.paused && !st.ended);
    if (openingHold) await injectVideo(state.tab.id, "control", { action: "pause" });
  } catch {
    openingHold = false;
  }

  let capture = null;
  const needCapture = !cues.length || isTtsReady(state.settings.tts);
  if (needCapture) {
    try {
      capture = await beginCapture(state.tab.id, { fromStart: false, autoplay: false });
    } catch (err) {
      if (!cues.length) {
        if (openingHold) {
          try { await injectVideo(state.tab.id, "control", { action: "play" }); } catch { /* leave paused */ }
        }
        state.interpret = { status: "error", error: err.message || String(err) };
        renderContext();
        return;
      }
      capture = null;
    }
  }

  const abort = new AbortController();
  state.siAbort = abort;
  state.siCapture = capture;
  state.originalAudioOn = false;
  state.interpret = { status: "running", mode: cues.length ? "captions" : "audio", message: "同传已开始…" };
  renderContext();
  try {
    const result = await runInterpret({
      tabId: state.tab.id,
      settings: state.settings,
      cues,
      startAt,
      openingHold,
      capture,
      signal: abort.signal,
      wantOriginalAudio: () => state.siAbort === abort && state.originalAudioOn,
      onEvent: (ev) => {
        if (state.siAbort !== abort) return;
        if (ev.type === "line") {
          state.interpret = {
            ...(state.interpret || {}),
            status: "running",
            src: ev.src,
            zh: ev.zh,
            mode: ev.mode,
            hint: "",
          };
        } else if (ev.type === "status") {
          state.interpret = {
            ...(state.interpret || {}),
            status: "running",
            message: ev.message || state.interpret?.message,
            hint: ev.hint || "",
            mode: ev.mode || state.interpret?.mode,
            ...(ev.clearLine ? { zh: "", src: "" } : {}),
          };
        } else if (ev.type === "warn") {
          state.interpret = { ...(state.interpret || {}), status: "running", hint: ev.message };
        }
        renderContext();
      },
    });
    if (state.siAbort !== abort) return;
    if (result?.captions?.status === "ready") applyCaptions(result.captions);
    state.originalAudioOn = true;
    if (state.interpret?.status === "running") {
      state.interpret = {
        ...(state.interpret || {}),
        status: "idle",
        message: result?.lines?.length ? "同传已结束" : "同传已停止",
      };
    }
    renderContext();
    } catch (err) {
    if (state.siAbort !== abort) return;
    if (err?.name === "AbortError" || /abort/i.test(err?.message || "")) {
      state.interpret = { ...(state.interpret || {}), status: "idle" };
    } else {
      state.interpret = { status: "error", error: err.message || String(err) };
    }
    renderContext();
  } finally {
    if (state.siAbort === abort) state.originalAudioOn = true;
    await discardCapture(capture);
    if (state.siCapture === capture) state.siCapture = null;
    if (state.siAbort === abort) state.siAbort = null;
    renderContext();
  }
}

function shouldNeedTranslate(cues) {
  const sample = (cues || []).slice(0, 8).map((c) => c.text).join(" ");
  return /[A-Za-z]{3,}/.test(sample) && !/[\u4e00-\u9fff]{8,}/.test(sample);
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
  if (!row) return;
  row.classList.toggle("hidden", !state.image);
  if (state.image && $("attach-thumb")) $("attach-thumb").src = state.image;
}

async function consumePending() {
  const { pendingSelection } = await chrome.storage.session.get("pendingSelection");
  if (!pendingSelection) return;
  await chrome.storage.session.remove("pendingSelection");
  if ($("input")) {
    $("input").value = `关于这段选区：\n${pendingSelection}\n\n请解释它在本页里的含义。`;
    $("input").focus();
  }
}

function bindComposer() {
  if (composerBound) return;
  composerBound = true;
  on("btn-send", "click", () => {
    try {
      const text = $("input")?.value?.trim();
      if (!text) {
        if (state.busy) {
          console.info("[pagelens] sendPrompt busy-stop");
          state.stopIntent = "user";
          state.abort?.abort();
          const line = $("model-line");
          if (line) line.textContent = "已请求停止上一轮";
        } else {
          console.info("[pagelens] sendPrompt empty");
        }
        return;
      }
      if ($("input")) $("input").value = "";
      hideSlashMenu();
      fitInput();
      sendPrompt(text, { clearImage: true }).catch((err) => {
        console.error("[pagelens] send", err);
        pushError("发送失败：" + (err.message || err));
      });
    } catch (err) {
      console.error("[pagelens] click send", err);
      pushError("发送失败：" + (err.message || err));
    }
  });
  on("input", "keydown", (e) => {
    if (handleSlashKey(e)) return;
    if (e.key !== "Enter" || e.isComposing) return;
    if (e.shiftKey) return;
    e.preventDefault();
    $("btn-send")?.click();
  });
  on("input", "input", () => {
    fitInput();
    updateSlashMenu();
  });
  on("input", "click", updateSlashMenu);
  on("input", "keyup", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
      updateSlashMenu();
    }
  });
  console.info("[pagelens] wire send", Boolean($("btn-send")), "shortcuts", Boolean($("skills")));
}

function wire() {
  bindComposer();
  try {
  on("btn-settings", "click", () => {
    renderSettingsForm();
    setView("settings");
  });
  on("btn-back", "click", async () => {
    try {
      const pathErrors = await applyFolderPathsFromInputs();
      if (pathErrors.length) flashStatus(pathErrors.join(" "), false);
    } catch (err) {
      console.warn("[pagelens] apply paths", err);
    }
    renderSkills();
    renderMessages();
    setView("chat");
  });
  on("btn-add-shortcut", "click", () => {
    if (!Array.isArray(state.settings.shortcuts)) state.settings.shortcuts = [];
    state.settings.shortcuts.push({ id: crypto.randomUUID(), label: "", prompt: "" });
    renderShortcutList();
  });
  on("btn-new", "click", () => {
    startNewSession();
  });
  on("btn-history", "click", () => {
    openHistoryView();
  });
  on("btn-hist-back", "click", () => {
    setView("chat");
  });
  on("btn-export-all-md", "click", () => exportAll("md"));
  on("btn-export-all-json", "click", () => exportAll("json"));
  on("btn-import-all-obsidian", "click", () => importAllToLibrary());
  on("btn-obsidian", "click", () => importCurrentToLibrary());
  on("hist-q", "input", () => {
    state.histQuery = $("hist-q").value;
    renderHistory();
  });
  on("btn-unpin", "click", () => {
    state.share = false;
    renderContext();
  });
  on("btn-transcribe", "click", () => {
    const capsReady = state.pack?.captionsStatus === "ready";
    startTranscribe({ force: capsReady });
  });
  $("btn-summarize-video")?.addEventListener("click", () => startSummarizeVideo());
  $("btn-interpret")?.addEventListener("click", () => startInterpret());
  $("btn-interpret-captions")?.addEventListener("click", () => toggleInterpretCaptions());
  $("btn-original-audio")?.addEventListener("click", () => toggleOriginalAudio());
  $("btn-summarize-bar")?.addEventListener("click", () => startSummarizeVideo());
  $("btn-interpret-bar")?.addEventListener("click", () => startInterpret());
  $("btn-video-switch")?.addEventListener("click", async () => {
    if (!state.tab?.id) return;
    const n = Number(state.pack?.videoCount) || (Array.isArray(state.pack?.videos) ? state.pack.videos.length : 0);
    if (n < 2) return;
    const cur = Number.isInteger(state.pack?.videoIndex) ? state.pack.videoIndex : 0;
    const next = (cur + 1) % n;
    try {
      await injectVideo(state.tab.id, "select", { index: next });
      await refreshTab();
    } catch (err) {
      pushError("无法切换画面：" + (err?.message || err));
    }
  });
  on("btn-library-pick", "click", async () => {
    const el = $("library-status");
    try {
      const picked = await pickLibraryFolder();
      if ($("library-path")) $("library-path").value = "";
      state.library = { configured: true, granted: true, mode: "picker", name: picked.name, path: "" };
      paintLibraryStatus(state.library, `已选择 ${picked.name}`);
      renderModelLine();
      if (state.pack?.captionsStatus === "ready") syncPackToLibrary(state.pack).catch(() => {});
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (el) {
        el.textContent = err.message || String(err);
        el.className = "status bad";
      }
    }
  });
  on("btn-library-path", "click", async () => {
    const el = $("library-status");
    const raw = $("library-path")?.value.trim() || "";
    if (!raw) {
      if (el) {
        el.textContent = "先填绝对路径或 ~ 路径。";
        el.className = "status bad";
      }
      return;
    }
    try {
      paintLibraryStatus(state.library, "正在验证路径…");
      const next = await setLibraryPath(raw);
      state.library = next;
      paintLibraryStatus(state.library);
      renderModelLine();
      if (state.pack?.captionsStatus === "ready") syncPackToLibrary(state.pack).catch(() => {});
    } catch (err) {
      if (el) {
        el.textContent = err.message || String(err);
        el.className = "status bad";
      }
    }
  });
  $("library-path")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("btn-library-path")?.click();
    }
  });
  on("btn-library-reauth", "click", async () => {
    await refreshLibraryStatus({ request: true });
    if (state.library.granted && state.pack?.captionsStatus === "ready") {
      syncPackToLibrary(state.pack).catch(() => {});
    }
  });
  on("btn-library-clear", "click", async () => {
    await clearSavedHandle();
    if ($("library-path")) $("library-path").value = "";
    state.library = { configured: false, granted: false, name: "", path: "", mode: "" };
    paintLibraryStatus(state.library, "已清除（磁盘上的文件还在）");
    renderModelLine();
  });
  $("btn-skills-pick")?.addEventListener("click", async () => {
    const el = $("skill-folder-status");
    try {
      const picked = await pickSkillFolder();
      if ($("skill-path")) $("skill-path").value = "";
      state.skillFolder = { configured: true, granted: true, mode: "picker", name: picked.name, path: "", count: 0 };
      clearSkillsCache();
      paintSkillFolderStatus(state.skillFolder, `已选择 ${picked.name}，输入 / 时再扫描`);
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (el) {
        el.textContent = err.message || String(err);
        el.className = "status bad";
      }
    }
  });
  $("btn-skills-path")?.addEventListener("click", async () => {
    const el = $("skill-folder-status");
    const raw = $("skill-path")?.value.trim() || "";
    if (!raw) {
      if (el) {
        el.textContent = "先填绝对路径或 ~ 路径。";
        el.className = "status bad";
      }
      return;
    }
    try {
      paintSkillFolderStatus(state.skillFolder, "正在验证路径…");
      const next = await setSkillFolderPath(raw);
      state.skillFolder = { ...next, count: 0 };
      clearSkillsCache();
      paintSkillFolderStatus(state.skillFolder, `已设置 ${next.path}，输入 / 时再扫描`);
    } catch (err) {
      if (el) {
        el.textContent = err.message || String(err);
        el.className = "status bad";
      }
    }
  });
  $("skill-path")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("btn-skills-path")?.click();
    }
  });
  $("btn-skills-reauth")?.addEventListener("click", async () => {
    if (!skillsOn()) return;
    await skillFolderStatus({ request: true });
    clearSkillsCache();
    await hydrateSkillFolderStatus();
  });
  $("btn-skills-refresh")?.addEventListener("click", async () => {
    if (!skillsOn()) return;
    await ensureSkillsMeta({ force: true, timeoutMs: 15000, request: true });
  });
  $("btn-skills-clear")?.addEventListener("click", async () => {
    await clearSkillFolderHandle();
    if ($("skill-path")) $("skill-path").value = "";
    state.skillFolder = { configured: false, granted: false, name: "", path: "", mode: "", count: 0 };
    clearSkillsCache();
    paintSkillFolderStatus(state.skillFolder, "已清除（磁盘上的 skill 还在）");
    renderModelLine();
  });
  $("skills-enabled")?.addEventListener("change", (e) => {
    state.settings.skillsEnabled = e.target.checked;
    clearSkillsCache();
    if (!e.target.checked) hideSlashMenu();
    syncSkillFolderControls();
    paintSkillFolderStatus(state.skillFolder);
    renderModelLine();
  });
  on("btn-save", "click", async () => {
    const pathErrors = await applyFolderPathsFromInputs();
    state.settings = await saveSettings(state.settings);
    applyUiFont(state.settings.uiFont);
    renderModelLine();
    renderShortcutList();
    if (pathErrors.length) {
      $("save-status").textContent = `设置已保存，路径未生效：${pathErrors.join(" ")}`;
      $("save-status").className = "status bad";
      return;
    }
    $("save-status").textContent = "已保存到本机";
    $("save-status").className = "status ok";
  });
  on("mm-same", "change", (e) => {
    state.settings.multimodalSameAsText = e.target.checked;
    $("mm-fields")?.classList.toggle("hidden", e.target.checked);
  });
  on("answer-lang", "change", (e) => {
    state.settings.answerLanguage = e.target.value;
  });
  on("ui-font", "change", (e) => {
    state.settings.uiFont = e.target.value;
    applyUiFont(state.settings.uiFont);
  });
  $("native-shell")?.addEventListener("change", (e) => {
    state.settings.nativeShell = e.target.checked;
    paintNativeHostStatus(state.nativeHost);
    renderModelLine();
  });
  $("btn-native-copy-id")?.addEventListener("click", async () => {
    try {
      await copyText(chrome.runtime.id);
      paintNativeHostStatus(state.nativeHost, "已复制扩展 ID");
    } catch (err) {
      paintNativeHostStatus(state.nativeHost, err.message || String(err));
    }
  });
  $("btn-native-copy-install")?.addEventListener("click", async () => {
    try {
      await copyText(nativeInstallCommand());
      paintNativeHostStatus(state.nativeHost, "已复制安装命令");
    } catch (err) {
      paintNativeHostStatus(state.nativeHost, err.message || String(err));
    }
  });
  $("btn-native-test")?.addEventListener("click", async () => {
    await refreshNativeHost();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!slash.open) return;
    const menu = $("slash-menu");
    const input = $("input");
    if (menu?.contains(e.target) || input?.contains(e.target)) return;
    hideSlashMenu();
  });
  on("btn-shot", "click", async () => {
    const shot = await captureTab();
    if (!shot) return;
    state.image = shot;
    renderAttach();
  });
  on("btn-clear-attach", "click", () => {
    state.image = null;
    renderAttach();
  });
  chrome.tabs?.onActivated?.addListener(() => {
    state.share = state.settings.shareActiveTab;
    refreshTab();
  });
  chrome.tabs?.onUpdated?.addListener((tabId, info, tab) => {
    if (tab.active && (info.status === "complete" || info.title || info.url)) {
      refreshTab();
    }
  });
  window.addEventListener("pagehide", () => {
    persistSession();
    state.recordAbort?.abort();
    state.workAbort?.abort();
    state.siAbort?.abort();
    abortRecording();
  });
  } catch (err) {
    console.error("[pagelens] wire rest", err);
  }
}

function markWired() {
  document.documentElement.dataset.pagelensWired = "1";
  const line = $("model-line");
  if (line) line.dataset.pagelensBoot = "1";
}

setTimeout(() => {
  if (document.documentElement.dataset.pagelensWired) return;
  const line = $("model-line");
  if (!line || line.dataset.pagelensBoot) return;
  line.textContent = "侧栏脚本未启动。请在侧栏空白处右键→检查，看 [pagelens] 日志（不要看 chrome://extensions 的 Service Worker）。";
}, 3000);

async function boot() {
  console.info("[pagelens] boot");
  try {
    try {
      initMarkdown();
    } catch (err) {
      console.warn("[pagelens] initMarkdown", err);
    }
    try {
      state.settings = (await applyOptionalLocalSettings()) || (await loadSettings());
      applyUiFont(state.settings.uiFont);
    } catch (err) {
      console.error("[pagelens] boot settings", err);
      state.settings = defaultSettings();
    }
    wire();
    markWired();
    syncComposerHints();
    renderModelLine();
    renderSkills();
    renderMessages();
    console.info("[pagelens] wired");
  } catch (err) {
    console.error("[pagelens] boot ui", err);
    try {
      bindComposer();
      markWired();
    } catch (bindErr) {
      console.error("[pagelens] bindComposer", bindErr);
    }
    const line = $("model-line");
    if (line) line.textContent = "启动失败：" + (err?.message || err);
  }
  refreshLibraryStatus().catch((err) => console.warn("[pagelens] library", err));
  refreshNativeHost({ silent: true }).catch(() => {});
  try {
    const active = await loadActiveSession();
    if (active?.messages?.length) {
      applySession(active);
      renderMessages();
    }
  } catch (err) {
    console.warn("[pagelens] session", err);
  }
  refreshTab().catch((err) => console.warn("[pagelens] tab", err));
  consumePending().catch(() => {});
  if (!isModelReady(resolveModel(state.settings, "text"))) {
    console.warn("[pagelens] boot no-model");
    try {
      renderSettingsForm();
    } catch (err) {
      console.warn("[pagelens] settings form", err);
    }
    setView("settings");
    return;
  }
  if (isResumableRun(state.run) && skillsOn() && lastUserAskedForSkill()) {
    resumeInterruptedRun().catch((err) => console.warn("[pagelens] resume", err));
  } else if (state.run) {
    state.run = null;
    persistSession();
  }
}

boot().catch((err) => {
  console.error("[pagelens] boot", err);
  try {
    bindComposer();
    markWired();
  } catch {
    /* ignore */
  }
  const line = document.getElementById("model-line");
  if (line) line.textContent = "启动失败：" + (err?.message || err);
});

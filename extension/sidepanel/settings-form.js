import { $ } from "./dom.js";
import { renderLibraryStatus } from "./library-ui.js";
import { skillsOn, syncSkillFolderControls } from "./model-line.js";
import { renderNativeHostStatus } from "./native-host-ui.js";
import { settingsPage } from "./panel-refs.js";
import { renderSkillFolderStatus } from "./skill-folder-ui.js";
import { hydrateSkillFolderStatus, renderShortcutList } from "./slash-menu.js";
import { state } from "./state.js";
import { escapeAttr, fieldBlock, renderTextProviders } from "./text-providers-ui.js";
import { applyUiTheme } from "./theme.js";
import { LOOP_ENGINE_ID } from "../lib/agent/loop-kernel.js";
import { IRREVERSIBLE_ITEMS, normalizeIrreversibleActions } from "../lib/agent/trust/irreversible.js";
import { testTranscriptions } from "../lib/asr.js";
import { testConnection } from "../lib/openai.js";
import { isAsrReady, isModelReady, isTtsReady, presetsFor } from "../lib/storage.js";
import { beginTabCapture, discardCapture, recordFromCapture } from "../lib/tab-audio.js";
import { TTS_LANGS, blobToWav, clearTtsRef, getTtsRef, setTtsRef, synthesizeTts, testTts } from "../lib/tts.js";

function renderIrreversibleList() {
  const box = $("irreversible-list");
  if (!box) return;
  const on = normalizeIrreversibleActions(state.settings.irreversibleActions);
  box.replaceChildren(
    ...IRREVERSIBLE_ITEMS.map((item) => {
      const label = document.createElement("label");
      label.className = "check";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = on[item.id];
      input.addEventListener("change", () => {
        state.settings.irreversibleActions = { ...normalizeIrreversibleActions(state.settings.irreversibleActions), [item.id]: input.checked };
      });
      label.append(input, ` ${item.label}`);
      return label;
    }),
  );
}

function renderSettingsForm() {
  renderTextProviders();
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
  applyUiTheme(state.settings.uiTheme, state.settings.uiThemeColors);
  if ($("native-shell")) $("native-shell").checked = state.settings.nativeShell !== false;
  if ($("cdp-input")) $("cdp-input").checked = state.settings.cdpInput !== false;
  if ($("agent-bridge")) $("agent-bridge").checked = state.settings.agentBridgeEnabled === true;
  if ($("agent-inbox")) $("agent-inbox").checked = state.settings.agentInboxEnabled === true;
  if ($("hitl-mode")) $("hitl-mode").value = state.settings.hitlMode || "balanced";
  renderIrreversibleList();
  if ($("loop-engine-label")) $("loop-engine-label").textContent = LOOP_ENGINE_ID;
  if ($("skills-enabled")) $("skills-enabled").checked = skillsOn();
  if ($("daily-notes-folder")) $("daily-notes-folder").value = state.settings.dailyNotesFolder ?? "Daily";
  const lf = state.settings.langfuse || {};
  if ($("langfuse-enabled")) $("langfuse-enabled").checked = lf.enabled === true;
  if ($("langfuse-url")) $("langfuse-url").value = lf.baseUrl || "http://localhost:3000";
  if ($("langfuse-pk")) $("langfuse-pk").value = lf.publicKey || "";
  if ($("langfuse-sk")) $("langfuse-sk").value = lf.secretKey || "";
  if ($("langfuse-env")) $("langfuse-env").value = lf.environment || "development";
  if ($("langfuse-status")) {
    $("langfuse-status").textContent = "";
    $("langfuse-status").className = "status";
  }
  syncSkillFolderControls();
  renderLibraryStatus();
  renderSkillFolderStatus();
  hydrateSkillFolderStatus().catch(() => {});
  renderNativeHostStatus();
  renderShortcutList();
  bindSettingFields();
  bindTtsRefControls();
  settingsPage?.render();
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
    <label class="field">配音准备方式
      <select data-k="tts.preparationMode">
        <option value="progressive" ${tts.preparationMode === 'progressive' ? 'selected' : ''}>快速起播，后台持续翻译与配音（推荐）</option>
        <option value="full" ${tts.preparationMode === 'full' ? 'selected' : ''}>完整配音后播放（播放时无需等待生成）</option>
        <option value="buffered" ${tts.preparationMode === 'buffered' ? 'selected' : ''}>全文翻译后，边准备配音边播放</option>
      </select>
    </label>
    <label class="field">翻译上下文
      <select data-k="tts.contextMode">
        <option value="sentence" ${tts.contextMode === 'sentence' ? 'selected' : ''}>按语义句翻译，并带上下文</option>
        <option value="cue" ${tts.contextMode !== 'sentence' ? 'selected' : ''}>按字幕条翻译（默认）</option>
      </select>
    </label>
    <label class="field">连续配音预缓存（秒，快速模式中途缓冲时也使用）
      <input data-k="tts.bufferSeconds" type="number" min="5" max="120" step="5" value="${Number(tts.bufferSeconds) || 30}" />
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
    if (el.dataset.settingBound) return;
    el.dataset.settingBound = "true";
    el.addEventListener("change", () => writeField(el));
    el.addEventListener("input", () => writeField(el));
  });
  document.querySelectorAll("[data-test]").forEach((btn) => {
    if (btn.dataset.settingBound) return;
    btn.dataset.settingBound = "true";
    btn.addEventListener("click", () => runTest(btn.dataset.test));
  });
}

function writeField(el) {
  const [group, key] = el.dataset.k.split(".");
  if (!state.settings[group]) state.settings[group] = {};
  if (key === "durationFactor") state.settings[group][key] = Number(el.value) || 1;
  else if (key === "summaryInputTokens") state.settings[group][key] = Number(el.value) || 200000;
  else if (key === "bufferSegments" || key === "bufferSeconds") state.settings[group][key] = Number(el.value) || 5;
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


export {
  renderIrreversibleList,
  renderSettingsForm,
  asrExtraFields,
  ttsFields,
  refreshTtsRefLabel,
  bindTtsRefControls,
  captureVoiceRef,
  previewTts,
  bindSettingFields,
  writeField,
  runTest,
};

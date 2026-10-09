import { $ } from "./dom.js";
import { settingsPage } from "./panel-refs.js";
import { state } from "./state.js";
import { escapeAttr } from "./text-providers-ui.js";
import { isAsrReady, isModelReady, isSkillsEnabled, isTtsReady, resolveModel } from "../lib/storage.js";
import { enabledModelOptions } from "../lib/text-providers.js";

function modelLineMetaEl() {
  return $("model-line-meta") || $("model-line");
}

function setModelLineMeta(text) {
  const el = modelLineMetaEl();
  if (el) el.textContent = text || "";
}

function modelExtras() {
  const mm = resolveModel(state.settings, "multimodal");
  const same = state.settings.multimodalSameAsText;
  const m = isModelReady(mm) ? mm.model : "未配多模态";
  const asr = isAsrReady(state.settings.asr) ? ` · ASR ${state.settings.asr.model || "自建"}` : "";
  const tts = isTtsReady(state.settings.tts) ? " · TTS" : "";
  const lib = state.library?.granted ? ` · 文稿夹 ${state.library.name}` : "";
  const sk = skillsOn()
    ? ` · Skills${state.skillsMetaReady ? ` ${state.skills.length}` : ""}`
    : "";
  const sh = state.settings.nativeShell !== false && state.nativeHost?.ok ? " · Shell" : "";
  const mmBit = same ? "多模态同文本" : `多模态 ${m}`;
  return `${mmBit}${asr}${tts}${lib}${sk}${sh}`;
}

function modelSummary() {
  const text = resolveModel(state.settings, "text");
  if (!isModelReady(text)) return `未配置文本模型 · 先到设置添加服务商 · ${modelExtras()}`;
  return `${modelExtras()}`;
}

function skillsOn() {
  return isSkillsEnabled(state.settings);
}

function renderModelLine() {
  const pick = $("text-model-pick");
  const options = enabledModelOptions(state.settings.textProviders);
  const ref = state.settings.textRef;
  if (pick) {
    const groups = new Map();
    for (const opt of options) {
      const list = groups.get(opt.providerName) || [];
      list.push(opt);
      groups.set(opt.providerName, list);
    }
    pick.innerHTML = [...groups.entries()].map(([name, items]) => (
      `<optgroup label="${escapeAttr(name)}">${items.map((item) => {
        const value = `${item.providerId}::${item.modelId}`;
        const selected = ref?.providerId === item.providerId && ref?.modelId === item.modelId ? " selected" : "";
        return `<option value="${escapeAttr(value)}"${selected}>${escapeAttr(item.modelId)}</option>`;
      }).join("")}</optgroup>`
    )).join("");
    pick.classList.toggle("hidden", !options.length);
    pick.value = ref ? `${ref.providerId}::${ref.modelId}` : "";
  }
  setModelLineMeta(modelSummary());
  settingsPage?.refreshModels();
}

function syncComposerHints() {
  const input = $("input");
  if (input) {
    if (!state.share && !state.chatRef) {
      input.placeholder = skillsOn()
        ? "直接交代任务 · / 选 skill · Enter 发送"
        : "直接交代任务，不带当前网页 · Enter 发送";
    } else {
      input.placeholder = skillsOn()
        ? "问这页 · / 选 skill · Enter 发送 · ⇧Enter 换行"
        : "问这页 · Enter 发送 · ⇧Enter 换行";
    }
  }
}

function syncSkillFolderControls() {
  $("block-skill-folder")?.classList.toggle("skills-off", !skillsOn());
  syncComposerHints();
}

function readUiPref(key, fallback) {
  try {
    const value = localStorage.getItem(`pagelens.${key}`);
    if (value === "1") return true;
    if (value === "0") return false;
  } catch { /* ignore */ }
  return fallback;
}

function writeUiPref(key, value) {
  try { localStorage.setItem(`pagelens.${key}`, value ? "1" : "0"); } catch { /* ignore */ }
}

function setSendButton(stopping) {
  const btn = $("btn-send");
  if (!btn) return;
  if (stopping) {
    btn.textContent = "■";
    btn.setAttribute("data-tooltip", "停止");
    btn.setAttribute("aria-label", "停止");
    return;
  }
  btn.innerHTML = '<svg class="ico" viewBox="0 0 24 24"><use href="#i-up"/></svg>';
  btn.setAttribute("data-tooltip", "发送");
  btn.setAttribute("aria-label", "发送");
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


export {
  modelLineMetaEl,
  setModelLineMeta,
  modelExtras,
  modelSummary,
  skillsOn,
  renderModelLine,
  syncComposerHints,
  syncSkillFolderControls,
  readUiPref,
  writeUiPref,
  setSendButton,
  applyUiFont,
  fitInput,
};

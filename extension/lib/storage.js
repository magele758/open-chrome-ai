export const PRESETS = [
  { id: "custom", name: "自定义", baseUrl: "" },
  { id: "local-mock", name: "本地 Mock（开发）", baseUrl: "http://127.0.0.1:18787/v1" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "siliconflow", name: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1" },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { id: "moonshot", name: "Kimi / Moonshot", baseUrl: "https://api.moonshot.cn/v1" },
  { id: "dashscope", name: "通义 兼容模式", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "volcengine", name: "火山方舟 兼容", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
  { id: "gemini-compat", name: "Gemini OpenAI 兼容", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "ollama", name: "Ollama 本地", baseUrl: "http://127.0.0.1:11434/v1" },
  { id: "lmstudio", name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
];

export const ASR_PRESETS = [
  { id: "custom", name: "自定义", baseUrl: "" },
  { id: "v1-transcribe", name: "自建 /v1/transcribe", baseUrl: "http://127.0.0.1:8002" },
  { id: "openai", name: "OpenAI Whisper", baseUrl: "https://api.openai.com/v1" },
  { id: "groq", name: "Groq Whisper", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "siliconflow", name: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1" },
  { id: "local", name: "本地 Whisper（OpenAI 兼容）", baseUrl: "http://127.0.0.1:8000/v1" },
];

export const TTS_PRESETS = [
  { id: "off", name: "关闭", baseUrl: "" },
  { id: "index-tts", name: "Index-TTS 2.5（Gradio）", baseUrl: "http://127.0.0.1:7860" },
  { id: "custom", name: "自定义 Gradio", baseUrl: "" },
];

function emptyModel() {
  return {
    preset: "custom",
    baseUrl: "",
    model: "",
    apiKey: "",
  };
}

function emptyAsr() {
  return {
    ...emptyModel(),
    language: "",
  };
}

function emptyTts() {
  return {
    preset: "off",
    baseUrl: "",
    lang: "ZH",
    durationFactor: 1,
    bufferSegments: 5,
  };
}

export function defaultSettings() {
  return {
    text: emptyModel(),
    multimodal: emptyModel(),
    asr: emptyAsr(),
    tts: emptyTts(),
    multimodalSameAsText: false,
    answerLanguage: "zh-CN",
    uiFont: "md",
    shareActiveTab: true,
    nativeShell: true,
    hitlMode: "balanced",
    hitlTimeoutSeconds: 30,
    skillsEnabled: false,
    shortcuts: [],
  };
}

export function normalizeSettings(raw) {
  const base = defaultSettings();
  const merged = { ...base, ...(raw || {}) };
  merged.text = { ...base.text, ...(raw?.text || {}) };
  merged.multimodal = { ...base.multimodal, ...(raw?.multimodal || {}) };
  merged.asr = { ...base.asr, ...(raw?.asr || {}) };
  merged.tts = { ...base.tts, ...(raw?.tts || {}) };
  const factor = Number(merged.tts.durationFactor);
  merged.tts.durationFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const bufSegs = Number(merged.tts.bufferSegments);
  merged.tts.bufferSegments = Number.isFinite(bufSegs) && bufSegs >= 1 ? Math.min(10, Math.max(1, Math.round(bufSegs))) : 5;
  if (!["ZH", "EN", "JA", "AR", "ES"].includes(merged.tts.lang)) merged.tts.lang = "ZH";
  merged.uiFont = ["md", "lg", "xl"].includes(raw?.uiFont) ? raw.uiFont : "md";
  merged.nativeShell = raw?.nativeShell !== false;
  merged.hitlMode = ["strict", "balanced", "autonomous"].includes(raw?.hitlMode) ? raw.hitlMode : "balanced";
  const timeout = Number(raw?.hitlTimeoutSeconds);
  merged.hitlTimeoutSeconds = Number.isFinite(timeout) && timeout > 0 ? Math.min(Math.max(timeout, 5), 300) : 30;
  merged.skillsEnabled = raw?.skillsEnabled === true;
  delete merged.interpretUseCaptions;
  merged.shortcuts = Array.isArray(raw?.shortcuts)
    ? raw.shortcuts.map((s) => ({
        id: String(s?.id || crypto.randomUUID()),
        label: String(s?.label || "").trim(),
        prompt: String(s?.prompt || "").trim(),
      }))
    : [];
  return merged;
}

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return normalizeSettings(settings);
}

/** Optional unpacked-only overlay (extension/local-settings.json, gitignored). */
export async function applyOptionalLocalSettings() {
  try {
    const res = await fetch(chrome.runtime.getURL("local-settings.json"));
    if (!res.ok) return null;
    const extra = await res.json();
    if (!extra || extra.rev == null) return null;
    const { plLocalApplied } = await chrome.storage.local.get("plLocalApplied");
    if (plLocalApplied === extra.rev) return null;
    const cur = await loadSettings();
    const next = { ...cur };
    if (extra.asr && typeof extra.asr === "object") next.asr = { ...cur.asr, ...extra.asr };
    if (extra.tts && typeof extra.tts === "object") next.tts = { ...cur.tts, ...extra.tts };
    const saved = await saveSettings(next);
    await chrome.storage.local.set({ plLocalApplied: extra.rev });
    return saved;
  } catch {
    return null;
  }
}

export async function saveSettings(settings) {
  const next = normalizeSettings(settings);
  next.shortcuts = next.shortcuts.filter((s) => s.label && s.prompt);
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function resolveModel(settings, kind) {
  if (kind === "multimodal" && settings.multimodalSameAsText) {
    return settings.text;
  }
  return kind === "multimodal" ? settings.multimodal : settings.text;
}

export function isModelReady(model) {
  return Boolean(model?.baseUrl?.trim() && model?.model?.trim() && model?.apiKey?.trim());
}

export function isAsrReady(model) {
  if (!model?.baseUrl?.trim()) return false;
  const preset = String(model.preset || "");
  if (preset === "v1-transcribe" || preset === "faster-whisper") return true;
  if (/\/v1\/transcribe/i.test(model.baseUrl || "")) return true;
  return Boolean(model.model?.trim());
}

export function isTtsReady(tts) {
  return Boolean(tts?.baseUrl?.trim());
}



export function isSkillsEnabled(settings) {
  return settings?.skillsEnabled === true;
}

export function presetsFor(group) {
  if (group === "asr") return ASR_PRESETS;
  if (group === "tts") return TTS_PRESETS;
  return PRESETS;
}

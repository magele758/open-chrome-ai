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
  { id: "openai", name: "OpenAI Whisper", baseUrl: "https://api.openai.com/v1" },
  { id: "groq", name: "Groq Whisper", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "siliconflow", name: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1" },
  { id: "local", name: "本地 Whisper", baseUrl: "http://127.0.0.1:8000/v1" },
];

function emptyModel() {
  return {
    preset: "custom",
    baseUrl: "",
    model: "",
    apiKey: "",
  };
}

export function defaultSettings() {
  return {
    text: emptyModel(),
    multimodal: emptyModel(),
    asr: emptyModel(),
    multimodalSameAsText: false,
    answerLanguage: "zh-CN",
    uiFont: "md",
    shareActiveTab: true,
    shortcuts: [],
  };
}

export function normalizeSettings(raw) {
  const base = defaultSettings();
  const merged = { ...base, ...(raw || {}) };
  merged.text = { ...base.text, ...(raw?.text || {}) };
  merged.multimodal = { ...base.multimodal, ...(raw?.multimodal || {}) };
  merged.asr = { ...base.asr, ...(raw?.asr || {}) };
  merged.uiFont = ["md", "lg", "xl"].includes(raw?.uiFont) ? raw.uiFont : "md";
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
  return Boolean(model?.baseUrl?.trim() && model?.model?.trim());
}

export function presetsFor(group) {
  return group === "asr" ? ASR_PRESETS : PRESETS;
}

import { requireHostUrl } from "./optional-permissions.js";
import { modelLimits, modelsUrl } from "./text-providers.js";

// Provider metadata takes precedence: a gateway can deploy a named model with a
// smaller window. These fallbacks match exact published IDs, including router prefixes.
// https://platform.claude.com/docs/en/build-with-claude/context-windows
// https://api-docs.deepseek.com/api/list-models/
// https://developers.openai.com/api/docs/models
const publishedWindows = new Map([
  ["claude-opus-5", 1000000], ["claude-opus-4-8", 1000000], ["claude-opus-4-7", 1000000],
  ["claude-opus-4-6", 1000000], ["claude-sonnet-4-6", 1000000],
  ["claude-opus-4-5", 200000], ["claude-sonnet-4-5", 200000], ["claude-haiku-4-5", 200000],
  ["deepseek-flash", 1048576], ["deepseek-v4-pro", 1048576], ["deepseek-v4-flash", 1000000],
  ["gpt-4o", 128000], ["gpt-4o-mini", 128000],
  ["gpt-4.1", 1047576], ["gpt-4.1-mini", 1047576], ["gpt-4.1-nano", 1047576],
  ["gpt-5", 400000], ["gpt-5-mini", 400000], ["gpt-5-nano", 400000],
]);
const unknownWindow = 32768;
const cache = new WeakMap();

function hasWindow(limits) {
  return Boolean(limits.contextWindowTokens || limits.maxInputTokens);
}

async function providerLimits(model, { signal, fetchImpl }) {
  if (!model.baseUrl) return {};
  const url = modelsUrl(model.baseUrl);
  const key = String(model.apiKey || "").trim();
  const cached = cache.get(model);
  if (cached?.until > Date.now() && cached.url === url && cached.id === model.model && cached.key === key) {
    return cached.limits;
  }
  let limits = {};
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 1200);
  try {
    if (!(await requireHostUrl(url, { interactive: false }))) {
      const response = await fetchImpl(url, {
        method: "GET", credentials: "omit", redirect: "error", signal: controller.signal,
        headers: { Accept: "application/json", Authorization: `Bearer ${key || "local"}` },
      });
      if (response.ok && Number(response.headers?.get?.("content-length") || 0) <= 8 * 1024 * 1024) {
        const payload = await response.json();
        const rows = payload?.data ?? payload?.models ?? payload;
        if (Array.isArray(rows) && rows.length <= 10000) {
          const row = rows.find(item => item?.id === model.model);
          limits = modelLimits(row);
        }
      }
    }
  } catch {
    // Older compatible endpoints may offer chat completions only.
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
  signal?.throwIfAborted();
  cache.set(model, { limits, until: Date.now() + 300000, url, id: model.model, key });
  return limits;
}

export async function resolveModelContext(model, { signal, fetchImpl = globalThis.fetch } = {}) {
  signal?.throwIfAborted();
  let limits = modelLimits(model);
  let source = "provider-catalog";
  if (!hasWindow(limits)) {
    limits = { ...limits, ...await providerLimits(model, { signal, fetchImpl }) };
    source = "provider";
  }
  if (!hasWindow(limits)) {
    const id = String(model.model || "").replace(/^(?:anthropic|openai|deepseek)\//, "");
    const known = publishedWindows.get(id);
    limits.contextWindowTokens = known || unknownWindow;
    source = known ? "model-spec" : "estimate";
  }
  const contextTokens = limits.contextWindowTokens || limits.maxInputTokens;
  const outputTokens = Math.max(1, Math.min(limits.maxOutputTokens || 8192, 8192, Math.floor(contextTokens / 8)));
  const inputLimit = limits.contextWindowTokens
    ? Math.min(limits.contextWindowTokens - outputTokens, limits.maxInputTokens || Infinity)
    : limits.maxInputTokens;
  // The caller counts complete message envelopes. Allow for tokenizer variation
  // and provider-side templates; actual context rejections are handled by the planner.
  const margin = Math.min(4096, Math.ceil(inputLimit * 0.05));
  return { contextTokens, inputTokens: Math.max(1, inputLimit - margin), outputTokens, source };
}

export function isContextWindowError(error) {
  if (error?.name === "AbortError" || error?.status === 429) return false;
  const text = [error?.code, error?.message, typeof error === "string" ? error : ""].filter(Boolean).join(" ");
  if (/rate.limit|tokens per minute|\btpm\b|quota|authentication/i.test(text)) return false;
  if (error?.status === 413 || /^(?:HTTP\s+)?413\b|\b(?:request (?:entity|body)|payload) too large\b/i.test(text.trim())) return true;
  return /context_(?:length|window)_exceeded|maximum context length|exceeds? (?:the )?(?:available |model.s )?context|context (?:window|length).{0,40}(?:exceeded|too (?:small|long))|(?:prompt|input)(?: is| length is)? too long|(?:prompt|input).{0,40}exceeds?.{0,25}(?:tokens?|maximum|limit)|too many (?:input )?tokens|上下文.{0,12}(?:超限|超出|超过)|(?:超出|超过).{0,8}上下文|输入.{0,8}过长/i.test(text);
}

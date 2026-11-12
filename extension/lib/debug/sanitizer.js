/**
 * 统一隐私与凭据脱敏管线（合并原 bridge/audit、debug-log、run-recorder 三套规则）。
 *
 * 提供双档策略：
 * - "strict"（默认）：用于 L0 内存环形日志、L1 零权限手动诊断包、远程 Langfuse 上报前拦截。
 *   强制剥离 URL ?query 与 #hash、擦除内联 Base64 图片、掩码邮箱/手机号/身份证号，并限制文本长度。
 * - "loop"：仅用于 L2 调试模式下本机磁盘 pagelens-runs/ 自动落盘。
 *   在完成密钥/令牌/敏感参数强制擦除的前提下，保留非敏感页面路由与待拆离截图。
 */

export const SENSITIVE_KEY_STRICT_RE =
  /(?:^|[._-])(api[_-]?key|password|passwd|secret|secret[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|authorization|cookie|set-cookie|private[_-]?key|client[_-]?secret|session[_-]?id|credential|headers|blob|buffer|base64)$/i;

export const SENSITIVE_KEY_LOOP_RE =
  /^(api[_-]?key|password|passwd|secret|secret[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization|cookie|set-cookie|private[_-]?key|client[_-]?secret|session[_-]?id|credential)$/i;

const SENSITIVE_QUERY_PARAM_RE =
  /([?&])(token|api_key|apikey|access_token|refresh_token|auth_token|secret|client_secret|password|passwd|signature|code)=([^&#\s"'<>]*)/gi;

const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const BASIC_AUTH_HEADER_RE = /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi;
const SK_TOKEN_RE = /\bsk-[A-Za-z0-9_-]{8,}/g;
const LANGFUSE_KEY_RE = /\b(?:pk|sk)-lf-[A-Za-z0-9_-]{6,}/g;
const JWT_TOKEN_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const URL_BASIC_AUTH_RE = /(https?:\/\/[^/\s:@]+):([^@\s/]+)@/gi;
const HTTP_URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const DATA_IMAGE_INLINE_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi;
const DATA_IMAGE_KEEP_RE = /^data:image\/(png|jpeg|jpg|webp);base64,/i;

const EMAIL_PII_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CN_PHONE_PII_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const CN_ID_PII_RE =
  /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g;

export function isSensitiveFieldKey(key, { profile = "strict" } = {}) {
  const k = String(key || "").trim();
  if (!k) return false;
  if (profile === "loop") {
    if (SENSITIVE_KEY_LOOP_RE.test(k)) return true;
    const tail = k.split(".").pop() || "";
    return Boolean(tail && SENSITIVE_KEY_LOOP_RE.test(tail));
  }
  if (SENSITIVE_KEY_STRICT_RE.test(k)) return true;
  const tail = k.split(".").pop() || "";
  return Boolean(tail && SENSITIVE_KEY_STRICT_RE.test(tail));
}

export function sanitizeUrl(rawUrl, { profile = "strict", keepYoutubeVideoId = false } = {}) {
  const raw = String(rawUrl || "").trim();
  if (!raw) return "";
  if (profile === "loop") {
    return raw
      .replace(URL_BASIC_AUTH_RE, "$1:[REDACTED]@")
      .replace(SENSITIVE_QUERY_PARAM_RE, "$1$2=[REDACTED]");
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "[url]";
    const video =
      keepYoutubeVideoId && /(^|\.)youtube\.com$/i.test(url.hostname)
        ? url.searchParams.get("v")
        : null;
    return `${url.origin}${url.pathname}${video ? `?v=${encodeURIComponent(video)}` : ""}`;
  } catch {
    return "[url]";
  }
}

export function sanitizeString(
  raw,
  {
    profile = "strict",
    maxChars = profile === "strict" ? 500 : 0,
    maskPii = profile === "strict",
    keepYoutubeVideoId = false,
  } = {},
) {
  const str = String(raw ?? "");
  if (!str) return "";
  if (profile === "loop" && DATA_IMAGE_KEEP_RE.test(str)) {
    return str;
  }

  let cleaned = str
    .replace(BEARER_TOKEN_RE, "Bearer [REDACTED]")
    .replace(BASIC_AUTH_HEADER_RE, "Basic [REDACTED]")
    .replace(LANGFUSE_KEY_RE, "[REDACTED]")
    .replace(SK_TOKEN_RE, "[REDACTED]")
    .replace(JWT_TOKEN_RE, "[JWT_REDACTED]");

  if (profile === "loop") {
    cleaned = cleaned
      .replace(URL_BASIC_AUTH_RE, "$1:[REDACTED]@")
      .replace(SENSITIVE_QUERY_PARAM_RE, "$1$2=[REDACTED]");
  } else {
    cleaned = cleaned.replace(DATA_IMAGE_INLINE_RE, (m) => `[IMAGE_DATA_URL len=${m.length}]`);
    cleaned = cleaned.replace(HTTP_URL_RE, (match) =>
      sanitizeUrl(match, { profile: "strict", keepYoutubeVideoId }),
    );
    if (maskPii) {
      cleaned = cleaned
        .replace(EMAIL_PII_RE, "[EMAIL_REDACTED]")
        .replace(CN_ID_PII_RE, "[ID_REDACTED]")
        .replace(CN_PHONE_PII_RE, "[PHONE_REDACTED]");
    }
  }

  if (maxChars > 0 && cleaned.length > maxChars) {
    return `${cleaned.slice(0, maxChars)}…[TRUNCATED ${cleaned.length} chars]`;
  }
  return cleaned;
}

export function sanitizePayload(
  value,
  {
    profile = "strict",
    key = "",
    depth = 0,
    maxDepth = profile === "strict" ? 6 : 16,
    maxChars = profile === "strict" ? 500 : 0,
    maxArray = profile === "strict" ? 30 : 500,
    maxKeys = profile === "strict" ? 40 : 200,
    maskPii = profile === "strict",
    redactErrorMessage = false,
    keepYoutubeVideoId = false,
    redactedToken = "[REDACTED]",
  } = {},
) {
  if (key && isSensitiveFieldKey(key, { profile })) return redactedToken;
  if (depth > maxDepth) return "[MaxDepth]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function") return undefined;

  if (typeof value === "string") {
    return sanitizeString(value, { profile, maxChars, maskPii, keepYoutubeVideoId });
  }

  if (value instanceof Error) {
    if (redactErrorMessage) {
      return { name: value.name || "Error" };
    }
    return {
      name: value.name || "Error",
      message: sanitizeString(value.message || String(value), {
        profile,
        maxChars,
        maskPii,
        keepYoutubeVideoId,
      }),
    };
  }

  const nextOpts = {
    profile,
    depth: depth + 1,
    maxDepth,
    maxChars,
    maxArray,
    maxKeys,
    maskPii,
    redactErrorMessage,
    keepYoutubeVideoId,
    redactedToken,
  };

  if (Array.isArray(value)) {
    const sliced = maxArray > 0 ? value.slice(0, maxArray) : value;
    return sliced.map((item) => sanitizePayload(item, { ...nextOpts, key: "" }));
  }

  if (typeof value === "object") {
    if (
      typeof value.key === "string" &&
      "value" in value &&
      isSensitiveFieldKey(value.key, { profile: "strict" })
    ) {
      const out = {};
      const rawEntries = Object.entries(value);
      const boundedEntries = maxKeys > 0 ? rawEntries.slice(0, maxKeys) : rawEntries;
      for (const [k, v] of boundedEntries) {
        out[k] = k === "value" ? redactedToken : sanitizePayload(v, { ...nextOpts, key: k });
      }
      return out;
    }
    const out = {};
    const entries = Object.entries(value);
    const bounded = maxKeys > 0 ? entries.slice(0, maxKeys) : entries;
    for (const [k, v] of bounded) {
      if (typeof v === "function" || v === undefined) continue;
      out[k] = isSensitiveFieldKey(k, { profile })
        ? redactedToken
        : sanitizePayload(v, { ...nextOpts, key: k });
    }
    return out;
  }

  return sanitizeString(String(value), { profile, maxChars, maskPii, keepYoutubeVideoId });
}

export function sanitizeTraceString(raw) {
  return sanitizeString(raw, { profile: "loop", maxChars: 0, maskPii: false });
}

export function sanitizeTraceValue(value, key = "", depth = 0) {
  return sanitizePayload(value, {
    profile: "loop",
    key,
    depth,
    maxDepth: 16,
    maxChars: 0,
    maxArray: 0,
    maxKeys: 0,
    maskPii: false,
    redactErrorMessage: false,
  });
}

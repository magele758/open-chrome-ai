/** 外部控制入口的开关与 origin 白名单。纯函数。 */

export const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  "http://localhost:*",
  "http://127.0.0.1:*",
  "https://mp.weixin.qq.com",
  "https://zhuanlan.zhihu.com",
  "https://member.bilibili.com",
  "https://creator.xiaohongshu.com",
  "https://creator.douyin.com",
]);

const PATTERN = /^(https?|file):\/\/(\*\.)?([^/:*]*)(:(\*|\d+))?$/i;

export function normalizeOriginPatterns(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_ALLOWED_ORIGINS];
  const out = [];
  for (const item of raw) {
    const value = String(item || "").trim().replace(/\/+$/, "");
    if (value && PATTERN.test(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

export function normalizeBridgeSettings(raw) {
  return {
    agentBridgeEnabled: raw?.agentBridgeEnabled === true,
    agentBridgeOrigins: normalizeOriginPatterns(raw?.agentBridgeOrigins),
  };
}

/** 模式：`https://host`、`http://localhost:*`（任意端口）、`https://*.example.com`（子域）。 */
export function originMatches(pattern, url) {
  const m = PATTERN.exec(String(pattern || ""));
  if (!m) return false;
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    return false;
  }
  const scheme = `${m[1].toLowerCase()}:`;
  if (parsed.protocol !== scheme) return false;
  const host = m[3].toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  if (m[2]) {
    if (!hostname.endsWith(`.${host}`)) return false;
  } else if (hostname !== host) {
    return false;
  }
  const port = m[5];
  if (port === "*") return true;
  const actual = parsed.port || (parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : "");
  const wanted = port ?? (scheme === "https:" ? "443" : scheme === "http:" ? "80" : "");
  return actual === wanted;
}

export function isUrlAllowed(url, patterns) {
  return (patterns || []).some((p) => originMatches(p, url));
}

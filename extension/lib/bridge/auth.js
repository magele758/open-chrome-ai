/**
 * 外部 Agent 的 per-agent token：只存 SHA-256 哈希；scope + origin 范围 + 过期 + 吊销。
 * 纯逻辑（crypto.subtle 在 SW / 页面 / Node 22 都有），存储见 token-store.js。
 */

import { BridgeError, ERROR_CODES } from "./protocol.js";
import { isUrlAllowed, isValidOriginPattern } from "./policy.js";

export const TOKEN_PREFIX = "plk_";
const TOKEN_RE = /^plk_[A-Za-z0-9_-]{43}$/;

export const AGENT_SCOPES = Object.freeze([
  "tabs:read",
  "tabs:manage",
  "page:read",
  "page:act",
  "page:js",
  "clipboard",
  "downloads",
  "upload",
  "settings:read",
  "settings:write",
  "agent:delegate",
  "host:shell",
  "host:fs",
]);

export const SCOPE_LABELS = Object.freeze({
  "tabs:read": "列出标签",
  "tabs:manage": "打开/切换/导航标签",
  "page:read": "读页面、截图",
  "page:act": "点击、输入、粘贴",
  "page:js": "在页面执行 JS",
  clipboard: "写剪贴板",
  downloads: "下载",
  upload: "上传本机文件",
  "settings:read": "读设置（非安全项）",
  "settings:write": "改设置（非安全项）",
  "agent:delegate": "委托扩展内 Agent",
  "host:shell": "本机命令（MCP 垫片）",
  "host:fs": "本机文件（MCP 垫片）",
});

/** agent:delegate 要等来源信任模型（P4）落地才开放，预设里都不含。 */
export const SCOPE_PRESETS = Object.freeze({
  "read-only": Object.freeze(["tabs:read", "page:read"]),
  operate: Object.freeze(["tabs:read", "tabs:manage", "page:read", "page:act", "clipboard"]),
  full: Object.freeze(AGENT_SCOPES.filter((s) => s !== "agent:delegate")),
});

export const MAX_TOKEN_NAME = 40;

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateToken(randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  return `${TOKEN_PREFIX}${base64url(randomBytes(32))}`;
}

export function looksLikeToken(value) {
  return TOKEN_RE.test(String(value || ""));
}

export async function hashToken(token) {
  const data = new TextEncoder().encode(String(token || ""));
  return toHex(await crypto.subtle.digest("SHA-256", data));
}

export function normalizeScopes(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return AGENT_SCOPES.filter((s) => list.includes(s));
}

export function normalizeTokenOrigins(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  const out = [];
  for (const item of list) {
    const value = String(item || "").trim().replace(/\/+$/, "");
    if (value && isValidOriginPattern(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

export function normalizeTokenName(raw) {
  return String(raw || "")
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, MAX_TOKEN_NAME);
}

/** 安装器用名字做文件名（~/.pagelens/agents/<name>.token）。 */
export function tokenFileName(name) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "agent";
}

export function normalizeTokenRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const hash = String(raw.hash || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const num = (v) => (Number.isFinite(Number(v)) && v != null ? Number(v) : null);
  return {
    id: String(raw.id || hash.slice(0, 12)),
    name: normalizeTokenName(raw.name) || "agent",
    hash,
    scopes: normalizeScopes(raw.scopes),
    origins: normalizeTokenOrigins(raw.origins),
    egress: normalizeTokenOrigins(raw.egress),
    expiresAt: num(raw.expiresAt),
    createdAt: num(raw.createdAt) ?? 0,
    revokedAt: num(raw.revokedAt),
  };
}

export function normalizeTokenList(raw) {
  return (Array.isArray(raw) ? raw : []).map(normalizeTokenRecord).filter(Boolean);
}

export function tokenState(record, now = Date.now()) {
  if (!record) return "missing";
  if (record.revokedAt != null) return "revoked";
  if (record.expiresAt != null && now >= record.expiresAt) return "expired";
  return "active";
}

export function hasActiveToken(records, now = Date.now()) {
  return normalizeTokenList(records).some((r) => tokenState(r, now) === "active");
}

/** 新建 token：返回只显示一次的明文与要存储的记录（不含明文）。 */
export async function createTokenRecord(
  { name, scopes, origins, egress, expiresAt = null } = {},
  { now = Date.now(), randomBytes, id } = {},
) {
  const cleanName = normalizeTokenName(name);
  if (!cleanName) throw new Error("token 名称不能为空。");
  const cleanScopes = normalizeScopes(scopes);
  if (!cleanScopes.length) throw new Error("至少选择一个 scope。");
  const token = generateToken(randomBytes);
  const hash = await hashToken(token);
  const record = normalizeTokenRecord({
    id: id || `tok_${hash.slice(0, 12)}`,
    name: cleanName,
    hash,
    scopes: cleanScopes,
    origins: normalizeTokenOrigins(origins),
    egress: normalizeTokenOrigins(egress),
    expiresAt,
    createdAt: now,
    revokedAt: null,
  });
  return { token, record };
}

/** 给 UI / hello 用的公开信息（无哈希）。 */
export function publicTokenInfo(record, now = Date.now()) {
  if (!record) return null;
  const { hash: _hash, ...rest } = record;
  return { ...rest, state: tokenState(record, now) };
}

/** 校验明文 token；失败抛 UNAUTHORIZED（不区分“格式错/不存在”，避免枚举）。 */
export async function verifyToken(records, token, now = Date.now()) {
  const plain = String(token || "");
  if (!plain) {
    throw new BridgeError(ERROR_CODES.UNAUTHORIZED, "缺少 token。", {
      hint: "在 PageLens 设置 → 外部 Agent 创建 token，并通过 PAGELENS_TOKEN 或 --token-file 传给 MCP 垫片。",
    });
  }
  if (!looksLikeToken(plain)) throw new BridgeError(ERROR_CODES.UNAUTHORIZED, "token 无效。");
  const hash = await hashToken(plain);
  const record = normalizeTokenList(records).find((r) => r.hash === hash);
  const state = tokenState(record, now);
  if (state === "missing") throw new BridgeError(ERROR_CODES.UNAUTHORIZED, "token 无效。");
  if (state === "revoked") throw new BridgeError(ERROR_CODES.UNAUTHORIZED, `token「${record.name}」已吊销。`);
  if (state === "expired") throw new BridgeError(ERROR_CODES.UNAUTHORIZED, `token「${record.name}」已过期。`);
  return record;
}

export function scopeAllows(record, scope) {
  return Boolean(scope) && Array.isArray(record?.scopes) && record.scopes.includes(scope);
}

export function requireScope(record, scope, tool) {
  if (scopeAllows(record, scope)) return;
  throw new BridgeError(ERROR_CODES.SCOPE_DENIED, `token「${record?.name || "?"}」没有 ${scope || "(未声明)"} 权限，不能调用 ${tool}。`, {
    hint: "在 PageLens 设置 → 外部 Agent 新建一个 scope 更大的 token。",
    details: { scope: scope || null, tool },
  });
}

export function tokenUrlAllowed(record, url) {
  return isUrlAllowed(url, record?.origins || []);
}

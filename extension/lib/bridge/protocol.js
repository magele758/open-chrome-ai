/** 外部 Agent 控制入口的协议常量、错误码与请求/响应封装。纯函数，不依赖 chrome.*。 */

export const BRIDGE_PROTOCOL = 1;
export const DEFAULT_TIMEOUT_MS = 30000;
export const MAX_TIMEOUT_MS = 120000;
export const MAX_ID_LENGTH = 128;

export const ERROR_CODES = Object.freeze({
  DISABLED: "DISABLED",
  PROTOCOL_UNSUPPORTED: "PROTOCOL_UNSUPPORTED",
  BAD_REQUEST: "BAD_REQUEST",
  BAD_ARGS: "BAD_ARGS",
  ID_CONFLICT: "ID_CONFLICT",
  UNKNOWN_TOOL: "UNKNOWN_TOOL",
  TAB_NOT_FOUND: "TAB_NOT_FOUND",
  TAB_RESTRICTED: "TAB_RESTRICTED",
  ORIGIN_NOT_ALLOWED: "ORIGIN_NOT_ALLOWED",
  DEBUGGER_BUSY: "DEBUGGER_BUSY",
  TIMEOUT: "TIMEOUT",
  NO_EDITOR: "NO_EDITOR",
  CLIPBOARD_FAILED: "CLIPBOARD_FAILED",
  VERIFY_FAILED: "VERIFY_FAILED",
  JOB_NOT_FOUND: "JOB_NOT_FOUND",
  TOOL_FAILED: "TOOL_FAILED",
  UNAUTHORIZED: "UNAUTHORIZED",
  SCOPE_DENIED: "SCOPE_DENIED",
  EGRESS_NOT_ALLOWED: "EGRESS_NOT_ALLOWED",
});

/** 默认可重试的错误码：同一请求稍后再发可能成功。 */
const RETRYABLE = new Set([ERROR_CODES.DEBUGGER_BUSY, ERROR_CODES.TIMEOUT, ERROR_CODES.CLIPBOARD_FAILED]);

export class BridgeError extends Error {
  constructor(code, message, { retryable, details, hint } = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.retryable = retryable ?? RETRYABLE.has(code);
    this.details = details;
    this.hint = hint;
  }
}

const BUSY_PATTERN = /already attached|已被 DevTools 或其他调试器占用|Another debugger is already attached/i;
const RESTRICTED_PATTERN = /受限页|Cannot access (a )?chrome|cannot be scripted|extensions gallery/i;

/** 把任意异常归一成 BridgeError。 */
export function toBridgeError(err) {
  if (err instanceof BridgeError) return err;
  const message = err?.message || String(err);
  if (err?.code === ERROR_CODES.DEBUGGER_BUSY || BUSY_PATTERN.test(message)) {
    return new BridgeError(ERROR_CODES.DEBUGGER_BUSY, message, {
      hint: "该标签已有其他调试器（DevTools / 其他扩展）占用 chrome.debugger；关闭它或 Target.detach 后重试。",
    });
  }
  if (RESTRICTED_PATTERN.test(message)) return new BridgeError(ERROR_CODES.TAB_RESTRICTED, message);
  if (/No tab with id|找不到标签|Tabs cannot be edited/i.test(message)) {
    return new BridgeError(ERROR_CODES.TAB_NOT_FOUND, message);
  }
  return new BridgeError(ERROR_CODES.TOOL_FAILED, message);
}

export function validateRequest(req) {
  if (!req || typeof req !== "object" || Array.isArray(req)) {
    throw new BridgeError(ERROR_CODES.BAD_REQUEST, "请求必须是 JSON 对象。");
  }
  if (req.v != null && req.v !== BRIDGE_PROTOCOL) {
    throw new BridgeError(ERROR_CODES.PROTOCOL_UNSUPPORTED, `不支持协议版本 ${req.v}，当前为 ${BRIDGE_PROTOCOL}。`);
  }
  const id = String(req.id ?? "").trim();
  if (!id || id.length > MAX_ID_LENGTH) {
    throw new BridgeError(ERROR_CODES.BAD_REQUEST, `id 必填，且不超过 ${MAX_ID_LENGTH} 字符。`);
  }
  const tool = String(req.tool ?? "").trim();
  if (!tool) throw new BridgeError(ERROR_CODES.BAD_REQUEST, "tool 必填。");
  const args = req.args ?? {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new BridgeError(ERROR_CODES.BAD_REQUEST, "args 必须是对象。");
  }
  const rawTimeout = req.timeoutMs == null ? DEFAULT_TIMEOUT_MS : Number(req.timeoutMs);
  if (!Number.isFinite(rawTimeout) || rawTimeout <= 0) {
    throw new BridgeError(ERROR_CODES.BAD_REQUEST, "timeoutMs 必须是正数。");
  }
  return {
    v: BRIDGE_PROTOCOL,
    id,
    tool,
    args,
    timeoutMs: Math.min(rawTimeout, MAX_TIMEOUT_MS),
    async: req.async === true,
  };
}

export function okResponse(id, result, { artifacts, meta } = {}) {
  const res = { v: BRIDGE_PROTOCOL, id, ok: true, result: result ?? null };
  if (artifacts?.length) res.artifacts = artifacts;
  res.meta = meta || {};
  return res;
}

export function errorResponse(id, err, { meta } = {}) {
  const e = toBridgeError(err);
  const error = { code: e.code, message: e.message, retryable: e.retryable };
  if (e.hint) error.hint = e.hint;
  if (e.details !== undefined) error.details = e.details;
  return { v: BRIDGE_PROTOCOL, id: id ?? null, ok: false, error, meta: meta || {} };
}

/** 构造 artifact。文本用 utf8，二进制传 base64 字符串。 */
export function makeArtifact(name, mime, data, encoding = "utf8") {
  const size = encoding === "base64" ? Math.floor((String(data).length * 3) / 4) : String(data).length;
  return { name, mime, encoding, size, data: String(data) };
}

/** 请求内容指纹（不含 id），用于幂等判重。 */
export function requestFingerprint(req) {
  return JSON.stringify([req.tool, req.args, req.async]);
}

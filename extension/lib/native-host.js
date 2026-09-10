export const NATIVE_HOST_NAME = "com.pagelens.host";

export function installHint(extensionId) {
  const id = String(extensionId || "").trim();
  const flag = id ? ` --extension-id ${id}` : "";
  return `在仓库根目录执行：node native/install-native-host.mjs${flag}，然后到 chrome://extensions 重新加载 PageLens。`;
}

export function describeNativeError(err, extensionId) {
  const msg = err?.message || String(err || "");
  if (/Specified native messaging host not found|host not found|Access to the specified native messaging host is forbidden/i.test(msg)) {
    return `未安装 Native Host，或 allowed_origins 对不上当前扩展 ID。${installHint(extensionId)}`;
  }
  if (/Native host has exited|disconnected/i.test(msg)) {
    return `Native Host 意外退出。${msg}`;
  }
  return msg || "Native Host 调用失败。";
}

export async function nativeSend(message, { timeoutMs = 12000 } = {}) {
  if (typeof chrome === "undefined" || typeof chrome.runtime?.sendNativeMessage !== "function") {
    return { ok: false, error: "当前环境没有 Native Messaging。" };
  }
  try {
    const send = chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, message);
    const ms = Number(timeoutMs);
    const res = Number.isFinite(ms) && ms > 0
      ? await Promise.race([
          send,
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Native Host 超时（${Math.round(ms / 1000)}s）`)), ms);
          }),
        ])
      : await send;
    if (res && typeof res === "object") return res;
    return { ok: false, error: "host 返回无效。" };
  } catch (err) {
    return { ok: false, error: describeNativeError(err, chrome.runtime?.id) };
  }
}

export async function pingNativeHost() {
  const started = Date.now();
  const res = await nativeSend({ op: "ping" });
  return { ...res, ms: Date.now() - started };
}

export async function execNativeShell({ command, cwd, timeoutMs } = {}) {
  return nativeSend({
    op: "exec",
    command: String(command || ""),
    cwd: cwd ? String(cwd) : undefined,
    timeoutMs,
  });
}

export async function nativeFs(payload, extra = {}) {
  const action = String(payload?.action || "");
  const override = Number(extra.timeoutMs);
  const timeoutMs = Number.isFinite(override) && override > 0
    ? override
    : action === "scanSkills"
      ? 15000
      : 12000;
  return nativeSend({ op: "fs", ...(payload || {}) }, { timeoutMs });
}

export function formatExecResult(res) {
  if (!res || res.ok === false) {
    return res?.error || "本机命令失败。";
  }
  const head = [
    `exit ${res.code ?? "?"}`,
    res.timedOut ? "超时" : "",
    res.ms != null ? `${res.ms}ms` : "",
    res.cwd ? `cwd ${res.cwd}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const out = String(res.stdout || "").trimEnd();
  const err = String(res.stderr || "").trimEnd();
  const parts = [head];
  if (out) parts.push("stdout:\n" + out);
  if (err) parts.push("stderr:\n" + err);
  if (!out && !err) parts.push("(无输出)");
  return parts.join("\n\n");
}

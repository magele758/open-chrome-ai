import { requireOptionalFeature } from "./optional-permissions.js";

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

export async function nativeSend(message, { timeoutMs = 12000, interactive = true, userGesture = false } = {}) {
  const denied = await requireOptionalFeature("nativeMessaging", { interactive, userGesture });
  if (denied) return { ok: false, error: denied };
  if (typeof chrome === "undefined" || typeof chrome.runtime?.sendNativeMessage !== "function") {
    return { ok: false, error: "当前环境没有 Native Messaging。" };
  }
  let timer;
  try {
    const send = chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, message);
    const ms = Number(timeoutMs);
    const res = Number.isFinite(ms) && ms > 0
      ? await Promise.race([
          send,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Native Host 超时（${Math.round(ms / 1000)}s）`)), ms);
          }),
        ])
      : await send;
    if (res && typeof res === "object") return res;
    return { ok: false, error: "host 返回无效。" };
  } catch (err) {
    return { ok: false, error: describeNativeError(err, chrome.runtime?.id) };
  } finally {
    clearTimeout(timer);
  }
}

export async function pingNativeHost() {
  const started = Date.now();
  const res = await nativeSend({ op: "ping" });
  return { ...res, ms: Date.now() - started };
}

let directorySelection;

export function chooseNativeProductDirectory() {
  directorySelection ??= requestDirectorySelection().finally(() => { directorySelection = undefined; });
  return directorySelection;
}

async function requestDirectorySelection() {
  const denied = await requireOptionalFeature("nativeMessaging", { interactive: false });
  if (denied) return { ok: false, error: denied };
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    return await new Promise(resolve => {
      const timer = setTimeout(() => finish({ ok: false, error: "目录选择已超时，请重新选择。" }), 125_000);
      let completed = false;
      function finish(result) {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        resolve(result);
        port.disconnect();
      }
      port.onMessage.addListener(finish);
      port.onDisconnect.addListener(() => finish({
        ok: false,
        error: describeNativeError(chrome.runtime.lastError, chrome.runtime.id),
      }));
      try {
        port.postMessage({ op: "chooseProductDirectory" });
      } catch (error) {
        finish({ ok: false, error: describeNativeError(error, chrome.runtime.id) });
      }
    });
  } catch (error) {
    return { ok: false, error: describeNativeError(error, chrome.runtime.id) };
  }
}

export async function execNativeShell({ command, cwd, timeoutMs } = {}) {
  const requested = Number(timeoutMs);
  const commandMs = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 300_000) : 60_000;
  // Let the host terminate the process and return its exit status before the transport times out.
  return nativeSend({
    op: "exec",
    command: String(command || ""),
    cwd: cwd ? String(cwd) : undefined,
    timeoutMs: commandMs,
  }, { timeoutMs: commandMs + 5_000 });
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

// chrome.runtime.id is identical in every Chrome profile that loads this extension.
// A local-only marker lets the host match the caller even when several profiles are open.
const SAVED_GROUPS_PROFILE_KEY = "savedTabGroupsProfileMarker";

async function savedGroupsProfileMarker() {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage) throw new Error("无法读取 PageLens 的本地存储，无法识别当前 Chrome 配置。");
  const readOrCreate = async () => {
    const stored = (await storage.get(SAVED_GROUPS_PROFILE_KEY))?.[SAVED_GROUPS_PROFILE_KEY];
    if (typeof stored === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(stored)) return stored;
    const value = crypto.randomUUID();
    await storage.set({ [SAVED_GROUPS_PROFILE_KEY]: value });
    return value;
  };
  if (globalThis.navigator?.locks) return navigator.locks.request(SAVED_GROUPS_PROFILE_KEY, readOrCreate);
  return readOrCreate();
}

export async function nativeSavedTabGroups(payload = {}, extra = {}) {
  const action = String(payload?.action || "list");
  const extensionId = globalThis.chrome?.runtime?.id;
  let profileMarker;
  if (["list", "open", "delete"].includes(action)) {
    if (globalThis.chrome?.extension?.inIncognitoContext) {
      return { ok: false, error: "请在普通 Chrome 窗口管理该配置中保存的标签组。" };
    }
    try {
      profileMarker = await savedGroupsProfileMarker();
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }
  const override = Number(extra.timeoutMs);
  const timeoutMs = Number.isFinite(override) && override > 0
    ? override
    : action === "list" ? 12000 : 65000; // First use can also compile and sign the macOS helper.
  const message = {
    ...payload,
    op: "saved_tab_groups",
    action,
    extensionId,
    profileMarker,
  };
  let result = await nativeSend(message, { timeoutMs });
  // On the first visit the new chrome.storage.local key can reach the profile
  // file just after storage.set resolves. Only retry this initial lookup.
  if (action === "list" && !payload.profile && result.code === "PROFILE_MARKER_MISMATCH") {
    await new Promise(resolve => setTimeout(resolve, 300));
    result = await nativeSend(message, { timeoutMs });
  }
  if ((result.ok && action === "list" && result.profileMarker !== profileMarker) ||
      (!result.ok && /未知 op|unknown op/i.test(result.error || ""))) {
    return { ok: false, code: "HOST_UPDATE_REQUIRED", error: `当前 Native Host 不支持按 Chrome 配置识别已保存标签组。${installHint(extensionId)}` };
  }
  return result;
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

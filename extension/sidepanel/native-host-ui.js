import { $ } from "./dom.js";
import { renderModelLine } from "./model-line.js";
import { state } from "./state.js";
import { installHint, pingNativeHost } from "../lib/native-host.js";

function nativeInstallCommand() {
  const id = chrome.runtime?.id || "";
  return `node native/install-native-host.mjs${id ? ` --extension-id ${id}` : ""}`;
}

function paintNativeHostStatus(info, extra = "") {
  const el = $("native-host-status");
  const idEl = $("native-host-id");
  if (idEl && chrome.runtime?.id) {
    idEl.textContent = `扩展 ID：${chrome.runtime.id}。在仓库根目录执行：${nativeInstallCommand()}`;
  } else if (idEl) {
    idEl.textContent = installHint("");
  }
  if (!el) return;
  if (extra) {
    el.textContent = extra;
    el.className = /失败|未安装|关闭|对不上|错误/.test(extra) ? "status bad" : /可用|已接通/.test(extra) ? "status ok" : "status";
    return;
  }
  if (state.settings.nativeShell === false) {
    el.textContent = "已关闭";
    el.className = "status";
    return;
  }
  if (!info?.checked) {
    el.textContent = "未检测";
    el.className = "status";
    return;
  }
  if (info.ok) {
    el.textContent = `已接通 · ${info.version || "host"}${info.ms != null ? ` · ${info.ms}ms` : ""}`;
    el.className = "status ok";
    return;
  }
  el.textContent = info.error || "未安装";
  el.className = "status bad";
}

function renderNativeHostStatus() {
  paintNativeHostStatus(state.nativeHost);
}

async function refreshNativeHost({ silent = false } = {}) {
  if (!silent) paintNativeHostStatus(state.nativeHost, "测试中…");
  const res = await pingNativeHost();
  state.nativeHost = {
    checked: true,
    ok: res.ok === true,
    version: res.version || "",
    error: res.ok ? "" : res.error || "未安装",
    ms: res.ms,
  };
  paintNativeHostStatus(state.nativeHost);
  renderModelLine();
  return state.nativeHost;
}

async function copyText(text) {
  const value = String(text || "");
  if (!value) return;
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  throw new Error("剪贴板不可用。");
}


export {
  nativeInstallCommand,
  paintNativeHostStatus,
  renderNativeHostStatus,
  refreshNativeHost,
  copyText,
};

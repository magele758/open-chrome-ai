/**
 * Service Worker 专用调试入口。
 *
 * W3C Service Worker 规范禁止在 ServiceWorkerGlobalScope 中调用动态 import()
 * （https://github.com/w3c/ServiceWorker/issues/1356）。
 * 因此 SW 端通过本文件静态关联无顶层副作用的调试模块并注入 hooks 注册表；
 * 默认关闭态（settings.debug.enabled === false）下绝不执行初始化、绝不挂载闹钟、绝不探测文件。
 * 发布构建（scripts/build-release.mjs）会将本文件替换为纯 hooks 导出桩，物理剥离 reload-dev.js。
 */

import { initSwDebugRuntime, registerSwDebugModules, syncSwDebugRuntime } from "./hooks.js";
import * as langfuseExporter from "./langfuse-exporter.js";
import * as reloadDev from "./reload-dev.js";
import * as runRecorder from "./run-recorder.js";

registerSwDebugModules({
  reloadDev,
  runRecorder,
  langfuseExporter,
});

if (typeof globalThis.chrome?.runtime?.onMessage?.addListener === "function") {
  globalThis.chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== "pl.debug.checkReloadNow") return false;
    if (sender?.id && sender.id !== globalThis.chrome.runtime?.id) return false;
    reloadDev
      .checkDevReloadOnce()
      .then((res) => sendResponse({ ok: true, result: res }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  });
}

export { initSwDebugRuntime, syncSwDebugRuntime };

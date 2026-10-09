/**
 * Service-worker routing for offscreen video interpretation:
 *   panel  --pl.interpret.cmd-->   SW --pl.interpret.host--> offscreen host
 *   host   --pl.interpret.video--> SW (chrome.scripting on the page)
 *   host   --pl.interpret.native-> SW (native messaging, e.g. media helper start)
 *   host   --pl.interpret.event--> panel (and SW, which closes an idle document)
 */
import { injectVideo } from "./chrome.js";
import { NATIVE_HOST_NAME } from "./native-host.js";
import { AUDIO_PAGE, offscreenDoc } from "./offscreen-doc.js";
import { INTERPRET_CMD, INTERPRET_EVENT, INTERPRET_HOST, INTERPRET_NATIVE, INTERPRET_VIDEO, isActiveState } from "./interpret-messages.js";

const errorText = err => err?.message || String(err || "未知错误");

export function createInterpretRouter({
  chromeApi = globalThis.chrome,
  doc = offscreenDoc,
  video = injectVideo,
} = {}) {
  const fromOffscreen = sender => {
    const url = String(sender?.url || sender?.documentUrl || "");
    return Boolean(url) && url.split("#")[0] === chromeApi.runtime.getURL(AUDIO_PAGE);
  };
  const forward = msg => doc.send({ ...msg, type: INTERPRET_HOST });

  async function command(msg) {
    if (msg.op === "start") return doc.withDocument(() => forward(msg));
    if (!(await doc.exists())) {
      if (msg.op === "list") return { ok: true, tasks: [] };
      if (msg.op === "stop") return { ok: true };
      return { ok: false, error: "同传未在运行" };
    }
    return forward(msg);
  }

  async function nativeCall(message) {
    const response = await chromeApi.runtime.sendNativeMessage(NATIVE_HOST_NAME, message);
    return { ok: true, result: response };
  }

  /** Returns a promise for handled requests, or null when the message is not ours. */
  function handle(msg, sender) {
    switch (msg?.type) {
      case INTERPRET_CMD:
        return command(msg);
      case INTERPRET_VIDEO:
        if (!fromOffscreen(sender)) return Promise.resolve({ ok: false, error: "拒绝：非同传宿主请求" });
        return video(Number(msg.tabId), String(msg.cmd || ""), msg.arg).then(result => ({ ok: true, result }));
      case INTERPRET_NATIVE:
        if (!fromOffscreen(sender)) return Promise.resolve({ ok: false, error: "拒绝：非同传宿主请求" });
        return nativeCall(msg.message);
      default:
        return null;
    }
  }

  function observe(msg) {
    if (msg?.type !== INTERPRET_EVENT || msg.event?.type !== "idle") return;
    if ((msg.tasks || []).some(isActiveState)) return;
    void doc.release().catch(() => {});
  }

  async function tabRemoved(tabId) {
    if (await doc.exists()) await forward({ op: "tabRemoved", tabId }).catch(() => {});
  }

  function install() {
    chromeApi.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      observe(msg);
      const pending = handle(msg, sender);
      if (!pending) return false;
      pending.then(sendResponse, err => sendResponse({ ok: false, error: errorText(err) }));
      return true;
    });
    chromeApi.tabs?.onRemoved?.addListener(tabId => { void tabRemoved(tabId); });
  }

  return { handle, observe, tabRemoved, install };
}

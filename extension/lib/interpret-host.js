/**
 * Video interpretation host. Runs inside the offscreen audio document so the
 * scheduler and dub playback outlive the side panel. The panel talks to it via
 * the service worker (`interpret-host-sw.js`) and mirrors state from broadcast
 * events (`sidepanel/interpret-client.js`).
 *
 * Offscreen documents only expose chrome.runtime, so page control and native
 * messaging are proxied through the service worker.
 */
import { InterpretController } from "./interpret-controller.js";
import { INTERPRET_EVENT, INTERPRET_HOST, INTERPRET_NATIVE, INTERPRET_VIDEO, isActiveState, toMessage } from "./interpret-messages.js";

const errorText = err => err?.message || String(err || "未知错误");

async function rpc(runtime, message) {
  const res = await runtime.sendMessage(message);
  if (!res?.ok) throw new Error(res?.error || "后台服务未响应");
  return res.result;
}

function installNativeProxy(runtime) {
  if (typeof runtime.sendNativeMessage === "function") return;
  try {
    runtime.sendNativeMessage = (_host, message) => rpc(runtime, { type: INTERPRET_NATIVE, message });
  } catch {
    /* frozen runtime object: native helper start stays unavailable */
  }
}

export function createInterpretHost({ runtime = globalThis.chrome?.runtime, isBusy = () => false, engineOptions } = {}) {
  installNativeProxy(runtime);
  const ctrl = new InterpretController({
    video: (tabId, cmd, arg) => rpc(runtime, { type: INTERPRET_VIDEO, tabId, cmd, arg }),
    engineOptions,
  });
  const broadcast = message => {
    try {
      Promise.resolve(runtime.sendMessage(message)).catch(() => {});
    } catch {
      /* no listener: the panel is closed */
    }
  };
  const snapshot = () => toMessage(ctrl.listStates());
  // The controller drops a finished task right after its final notify; reading
  // the task list a microtask later keeps mirrors from holding stale tasks.
  ctrl.subscribe((event, state) => {
    const payload = { event: toMessage(event), state: toMessage(state) };
    queueMicrotask(() => broadcast({ type: INTERPRET_EVENT, ...payload, tasks: snapshot() }));
  });

  async function handle(msg) {
    switch (msg?.op) {
      case "start": {
        const tab = msg.tab;
        if (!tab?.id) throw new Error("没有可操作的标签页");
        ctrl.start({
          tab,
          settings: msg.settings,
          generateFull: Boolean(msg.generateFull),
          onCaptionsReady: captions => broadcast({
            type: INTERPRET_EVENT,
            event: { type: "captions_ready", captions: toMessage(captions), tabId: tab.id },
            tasks: snapshot(),
          }),
        }).catch(err => console.error("[interpret-host] start", err));
        return { ok: true };
      }
      case "stop":
        await ctrl.stop(msg.tabId);
        return { ok: true };
      case "list":
        return { ok: true, tasks: snapshot(), currentTabId: ctrl.currentTabId };
      case "busy":
        return { ok: true, busy: ctrl.listStates().some(isActiveState) || Boolean(isBusy()) };
      case "toggleOriginalAudio":
        return { ok: true, originalAudioOn: await ctrl.toggleOriginalAudio(msg.tabId) };
      case "editLine":
        await ctrl.editCurrentLine(msg.tabId, msg.text);
        return { ok: true };
      case "tabRemoved":
        await ctrl.handleTabRemoved(msg.tabId);
        return { ok: true };
      default:
        return { ok: false, error: `未知同传指令 ${msg?.op || ""}` };
    }
  }

  runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== INTERPRET_HOST) return false;
    handle(msg).then(sendResponse, err => sendResponse({ ok: false, error: errorText(err) }));
    return true;
  });

  return { controller: ctrl, handle };
}

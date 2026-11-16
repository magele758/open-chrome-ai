/**
 * Video interpretation host. Runs inside the offscreen audio document so the
 * scheduler and dub playback outlive the side panel. The panel talks to it via
 * the service worker (`interpret-host-sw.js`) and mirrors state from broadcast
 * events (`sidepanel/interpret-client.js`).
 *
 * Offscreen documents only expose chrome.runtime, so page control and native
 * messaging are proxied through the service worker.
 */
import { loadTimelineArchive, playTimelineArchive } from "./timeline-archive.js";
import { runPlannedInterpret } from "./planned-interpret.js";
import { videoIdentity } from "./library.js";
import { DubQueue } from "./dub-queue.js";
import { preprocessAudio } from "./preprocess-audio.js";
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

export function createInterpretHost({ runtime = globalThis.chrome?.runtime, isBusy = () => false, engineOptions, preprocess = preprocessAudio } = {}) {
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
  const queue = new DubQueue({ process: async (row, progress, signal) =>
    preprocess(row, await rpc(runtime, { type: "pl.queue.settings" }), progress, signal) });

  const compact = new Map();
  async function stopListeners(id) {
    const listening = compact.get(id);
    if (listening) {
      broadcast({ type: "pl.compact.cancel", lease: listening.lease });
      await listening.released;
    }
    const matching = ctrl.listStates().filter(task => videoIdentity(task.url) === id);
    await Promise.all(matching.map(task => ctrl.stop(task.tabId)));
  }

  function liveJobs() {
    return ctrl.getRunningTasks().sort((a, b) => Number(b.tabId === ctrl.currentTabId) - Number(a.tabId === ctrl.currentTabId))
      .map(task => ({ id: videoIdentity(task.url), url: task.url, title: task.title, status: "live", detail: task.message }))
      .concat([...compact.values()].map(({ job }) => ({ id: job.id, url: job.url, title: job.title, status: "live" })));
  }
  // The controller drops a finished task right after its final notify; reading
  // the task list a microtask later keeps mirrors from holding stale tasks.
  ctrl.subscribe((event, state) => {
    const payload = { event: toMessage(event), state: toMessage(state) };
    queueMicrotask(() => broadcast({ type: INTERPRET_EVENT, ...payload, tasks: snapshot() }));
  });

  function resumeQueue() {
    void queue.drain().then(() => broadcast({ type: "pl.queue.idle" }))
      .catch(err => console.error("[dub-queue]", err));
  }

  async function handle(msg) {
    switch (msg?.op) {
      case "compactClaim": {
        if (!/^pagelens-compact:[a-f0-9-]{36}$/.test(msg.lease)) throw Error("无效的音频任务");
        const id = msg.job.id;
        await queue.claimLive(id);
        const released = navigator.locks.request(msg.lease, () => {
          compact.delete(id);
          queue.live.delete(id);
          resumeQueue();
        });
        compact.set(id, { lease: msg.lease, released, job: msg.job });
        await queue.enqueue(msg.job);
        await queue.setPaused(id, false);
        resumeQueue();
        return { ok: true };
      }
      case "queueAdd":
        await queue.enqueue(msg.job);
        resumeQueue();
        return { ok: true };
      case "queueResume":
        resumeQueue();
        return { ok: true };
      case "queuePause":
      case "queueContinue":
        await queue.setPaused(msg.id, msg.op === "queuePause");
        if (msg.op === "queuePause") await stopListeners(msg.id);
        resumeQueue();
        return { ok: true };
      case "queueMove":
        await queue.move(msg.id, msg.direction);
        resumeQueue();
        return { ok: true };
      case "queueList":
        return { ok: true, jobs: await queue.list(), live: liveJobs() };
      case "queueDelete": {
        await queue.setPaused(msg.id, true);
        await stopListeners(msg.id);
        await queue.remove(msg.id);
        broadcast({ type: "pl.queue.idle" });
        return { ok: true };
      }
      case "start": {
        const tab = msg.tab;
        if (!tab?.id) throw new Error("没有可操作的标签页");
        if (ctrl.isRunning(tab.id)) {
          await ctrl.stop(tab.id);
          return { ok: true };
        }
        if (msg.job) {
          await queue.claimLive(msg.job.id);
          resumeQueue();
        }
        ctrl.start({
          tab,
          settings: msg.settings,
          run: async opts => {
            const archive = await loadTimelineArchive(tab.url);
            opts.signal.throwIfAborted();
            if (archive) {
              const player = await opts.video("state");
              opts.signal.throwIfAborted();
              if (!(archive.duration > 0 && player?.duration > 0 && Math.abs(archive.duration - player.duration) > 3)) {
                return playTimelineArchive(archive, opts);
              }
            }
            if (msg.job) {
              await queue.enqueue(msg.job);
              await queue.setPaused(msg.job.id, false);
            }
            return runPlannedInterpret(opts);
          },
          generateFull: Boolean(msg.job || msg.generateFull),
          onCaptionsReady: captions => broadcast({
            type: INTERPRET_EVENT,
            event: { type: "captions_ready", captions: toMessage(captions), tabId: tab.id },
            tasks: snapshot(),
          }),
        }).catch(err => console.error("[interpret-host] start", err)).finally(() => {
          if (msg.job) { queue.live.delete(msg.job.id); resumeQueue(); }
        });
        return { ok: true };
      }
      case "stop":
        await ctrl.stop(msg.tabId);
        return { ok: true };
      case "list":
        return { ok: true, tasks: snapshot(), currentTabId: ctrl.currentTabId };
      case "busy":
        return { ok: true, busy: Boolean(queue.worker) || queue.live.size > 0 || ctrl.listStates().some(isActiveState) || Boolean(isBusy()) };
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

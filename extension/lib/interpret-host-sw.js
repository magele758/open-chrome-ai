/**
 * Service-worker routing for offscreen video interpretation:
 *   panel  --pl.interpret.cmd-->   SW --pl.interpret.host--> offscreen host
 *   host   --pl.interpret.video--> SW (chrome.scripting on the page)
 *   host   --pl.interpret.native-> SW (native messaging, e.g. media helper start)
 *   host   --pl.interpret.event--> panel (and SW, which closes an idle document)
 */
import { loadSettings } from "./storage.js";
import { listDubArchives } from "./audio-composer.js";
import { loadDubJobs, unfinished, unifiedDubList } from "./dub-queue.js";
import { videoIdentity } from "./library.js";
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
    if (msg.op === "queueAdd") {
      const { url, title, id: tabId } = msg.tab;
      if (!/^https?:\/\//i.test(url)) throw Error("请选择视频网页");
      let media;
      if (tabId && (await chromeApi.tabs.get(tabId).catch(() => null))?.url === url) {
        const found = await video(tabId, "media").catch(() => null);
        if (found && (await chromeApi.tabs.get(tabId).catch(() => null))?.url === url) {
          media = { src: found.src, audioSrc: found.audioSrc, duration: found.duration };
        }
      }
      await chromeApi.alarms.create("pl.queue.watch", { delayInMinutes: 1 });
      return doc.withDocument(() => forward({ op: msg.op, job: { url, title, id: videoIdentity(url), media } }));
    }
    if (msg.op === "queueList") {
      const archives = await listDubArchives();
      if (await doc.exists()) {
        const res = await forward(msg);
        if (res?.ok) return { ok: true, jobs: unifiedDubList(res.jobs, archives, res.live || []) };
      }
      const jobs = await loadDubJobs();
      if (jobs.some(unfinished)) await resumePending();
      return { ok: true, jobs: unifiedDubList(jobs.map(({ media, ...row }) => row), archives, []) };
    }
    if (msg.op === "queueDelete") return doc.withDocument(() => forward(msg));
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
      case "pl.queue.settings":
        if (!fromOffscreen(sender)) return Promise.resolve({ ok: false });
        return loadSettings().then(result => ({ ok: true, result }));
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
    if (msg?.type === "pl.queue.idle") { void doc.release().catch(() => {}); return; }
    if (msg?.type !== INTERPRET_EVENT || msg.event?.type !== "idle") return;
    if ((msg.tasks || []).some(isActiveState)) return;
    void doc.release().catch(() => {});
  }

  async function tabRemoved(tabId) {
    if (await doc.exists()) await forward({ op: "tabRemoved", tabId }).catch(() => {});
  }

  async function resumePending() {
    if (!(await loadDubJobs()).some(unfinished)) return;
    await chromeApi.alarms.create("pl.queue.watch", { delayInMinutes: 1 });
    await doc.withDocument(() => forward({ op: "queueResume" }));
  }

  function install() {
    chromeApi.runtime.onStartup?.addListener(() => { void resumePending(); });
    chromeApi.runtime.onInstalled?.addListener(() => { void resumePending(); });
    chromeApi.alarms?.onAlarm.addListener(alarm => {
      if (alarm.name === "pl.queue.watch") void resumePending();
    });
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

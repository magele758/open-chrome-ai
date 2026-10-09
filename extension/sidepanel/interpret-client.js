/**
 * Side-panel view of video interpretation running in the offscreen host.
 * Same surface as InterpretController for the panel; state is a mirror rebuilt
 * from host broadcasts, so closing and reopening the panel loses nothing.
 */
import { loadFullMediaArchive } from "../lib/audio-composer.js";
import { INTERPRET_CMD, INTERPRET_EVENT, isActiveState } from "../lib/interpret-messages.js";

const IDLE_STATE = Object.freeze({
  fsmState: "idle",
  status: "idle",
  originalAudioOn: true,
  mode: "audio",
  message: "",
  hint: "",
  src: "",
  zh: "",
  error: "",
});

export class RemoteInterpretController {
  constructor({ runtime = globalThis.chrome?.runtime, loadArchive = loadFullMediaArchive } = {}) {
    this.runtime = runtime;
    this.loadArchive = loadArchive;
    this.tasks = new Map();
    this.currentTabId = null;
    this.listeners = new Set();
    this.captionHandlers = new Map();
    this.onMessage = (msg) => {
      if (msg?.type === INTERPRET_EVENT) void this.receive(msg);
      return false;
    };
    runtime?.onMessage?.addListener(this.onMessage);
    this.ready = this.sync().catch(() => {});
  }

  dispose() {
    this.runtime?.onMessage?.removeListener?.(this.onMessage);
    this.listeners.clear();
  }

  async command(op, extra = {}) {
    const res = await this.runtime.sendMessage({ type: INTERPRET_CMD, op, ...extra });
    if (!res?.ok) throw new Error(res?.error || "同传后台未响应");
    return res;
  }

  mirror(tasks) {
    this.tasks = new Map((tasks || []).filter(t => t?.tabId).map(t => [t.tabId, t]));
  }

  async sync() {
    const res = await this.command("list");
    this.mirror(res.tasks);
    if (!this.currentTabId && res.currentTabId && this.tasks.has(res.currentTabId)) this.currentTabId = res.currentTabId;
    if (this.tasks.size) this.notify({ type: "sync" }, this.getState());
  }

  async receive({ event, state, tasks }) {
    if (event?.type === "captions_ready") {
      this.mirror(tasks);
      const handler = this.captionHandlers.get(event.tabId);
      try { handler?.(event.captions); } catch (err) { console.error("[interpret-client] captions", err); }
      return;
    }
    if (event?.type === "archive_saved" && event.archive?.videoId) {
      const full = await this.loadArchive(event.archive.videoId).catch(() => null);
      if (full) event = { ...event, archive: full };
    }
    this.mirror(tasks);
    if (event?.type === "idle" && event.tabId) this.captionHandlers.delete(event.tabId);
    this.notify(event, state || this.getState(event?.tabId));
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(event, state) {
    for (const listener of this.listeners) {
      try {
        listener(event, state);
      } catch (err) {
        console.error("[interpret-client] listener error", err);
      }
    }
  }

  getTask(tabId) {
    const id = tabId || this.currentTabId;
    return (id && this.tasks.get(id)) || null;
  }

  getState(tabId) {
    const task = this.getTask(tabId);
    if (task) return task;
    if (!tabId && !this.currentTabId) {
      for (const t of this.tasks.values()) if (isActiveState(t)) return t;
    }
    return { ...IDLE_STATE };
  }

  get fsmState() {
    return this.getTask()?.fsmState || "idle";
  }

  get originalAudioOn() {
    return this.getTask()?.originalAudioOn ?? true;
  }

  isRunning(tabId) {
    if (tabId) return isActiveState(this.tasks.get(tabId));
    return [...this.tasks.values()].some(isActiveState);
  }

  getRunningTasks() {
    return [...this.tasks.values()].filter(isActiveState);
  }

  async start({ tab, settings, onCaptionsReady, generateFull = false }) {
    if (!tab?.id) throw new Error("没有可操作的标签页");
    this.currentTabId = tab.id;
    if (onCaptionsReady) this.captionHandlers.set(tab.id, onCaptionsReady);
    await this.command("start", {
      tab: { id: tab.id, url: tab.url || "", title: tab.title || "" },
      settings,
      generateFull,
    });
  }

  async stop(tabId) {
    await this.command("stop", { tabId: tabId || this.currentTabId || undefined });
  }

  async handleTabRemoved(tabId) {
    if (this.tasks.has(tabId)) await this.stop(tabId);
  }

  async toggleOriginalAudio(tabId) {
    const targetId = tabId || this.currentTabId;
    if (!targetId) return true;
    const res = await this.command("toggleOriginalAudio", { tabId: targetId });
    return res.originalAudioOn;
  }

  async editCurrentLine(tabId, text) {
    await this.command("editLine", { tabId: tabId || this.currentTabId, text });
  }
}

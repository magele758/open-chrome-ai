/**
 * PageLens Live Interpretation Multi-Task Manager & Controller.
 * Manages video probe, capture setup, stream lifecycle, audio-gain toggle, and multi-tab tasks.
 * Interpretation continues in background when switching tabs until the specific tab is closed or stopped.
 */

import { injectVideo } from "../lib/chrome.js";
import { runPlannedInterpret as runInterpret } from "../lib/planned-interpret.js";
import { abortRecording, discardCapture } from "../lib/tab-audio.js";

export const InterpretState = {
  IDLE: "idle",
  PREPARING: "preparing",
  RUNNING: "running",
  STOPPING: "stopping",
  ERROR: "error",
};

export class InterpretTask {
  constructor({ tabId, sourceUrl, title = "" }) {
    this.tabId = tabId;
    this.sourceUrl = sourceUrl || "";
    this.title = title || "";
    this.fsmState = InterpretState.IDLE;
    this.abortController = null;
    this.currentCapture = null;
    this.originalAudioOn = false;
    this.details = {
      mode: "audio",
      message: "",
      hint: "",
      src: "",
      zh: "",
      error: "",
    };
  }

  getState() {
    return {
      tabId: this.tabId,
      title: this.title,
      url: this.sourceUrl,
      fsmState: this.fsmState,
      status:
        this.fsmState === InterpretState.RUNNING
          ? "running"
          : this.fsmState === InterpretState.ERROR
          ? "error"
          : "idle",
      originalAudioOn: this.originalAudioOn,
      ...this.details,
    };
  }

  isRunning() {
    return this.fsmState === InterpretState.RUNNING || this.fsmState === InterpretState.PREPARING;
  }
}

export class InterpretController {
  constructor() {
    this.tasks = new Map();
    this.currentTabId = null;
    this.listeners = new Set();

    // Default fallback state for when no tasks exist
    this.defaultDetails = {
      mode: "audio",
      message: "",
      hint: "",
      src: "",
      zh: "",
      error: "",
    };

    if (typeof chrome !== "undefined" && chrome.tabs?.onRemoved) {
      chrome.tabs.onRemoved.addListener((removedTabId) => {
        this.handleTabRemoved(removedTabId).catch(() => {});
      });
    }
  }

  async handleTabRemoved(tabId) {
    if (this.tasks.has(tabId)) {
      await this.stop(tabId);
    }
  }

  getTask(tabId) {
    const id = tabId || this.currentTabId;
    if (id && this.tasks.has(id)) return this.tasks.get(id);
    return null;
  }

  getState(tabId) {
    const task = this.getTask(tabId);
    if (task) return task.getState();

    // Fallback: only when tabId was not explicitly passed and currentTabId is empty
    if (!tabId && !this.currentTabId) {
      for (const t of this.tasks.values()) {
        if (t.isRunning()) return t.getState();
      }
    }

    return {
      fsmState: InterpretState.IDLE,
      status: "idle",
      originalAudioOn: true,
      ...this.defaultDetails,
    };
  }

  get fsmState() {
    const active = this.getTask();
    return active ? active.fsmState : InterpretState.IDLE;
  }

  get originalAudioOn() {
    const active = this.getTask();
    return active ? active.originalAudioOn : true;
  }

  isRunning(tabId) {
    if (tabId) {
      const task = this.tasks.get(tabId);
      return Boolean(task?.isRunning());
    }
    for (const task of this.tasks.values()) {
      if (task.isRunning()) return true;
    }
    return false;
  }

  getRunningTasks() {
    const out = [];
    for (const task of this.tasks.values()) {
      if (task.isRunning()) out.push(task.getState());
    }
    return out;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(event, tabId) {
    const state = this.getState(tabId);
    for (const listener of this.listeners) {
      try {
        listener(event, state);
      } catch (err) {
        console.error("[InterpretController] listener error", err);
      }
    }
  }

  async toggleOriginalAudio(tabId) {
    const targetId = tabId || this.currentTabId;
    if (!targetId) return true;

    const task = this.tasks.get(targetId);
    const prev = task ? task.originalAudioOn : false;
    const next = !prev;

    if (task) task.originalAudioOn = next;
    this.notify({ type: "audio_toggled", originalAudioOn: next, tabId: targetId }, targetId);

    try {
      await injectVideo(targetId, next ? "restore" : "silence");
      task?.currentCapture?.playback?.setGain?.(next ? 1 : 0);
    } catch (err) {
      if (task) task.originalAudioOn = prev;
      this.notify({ type: "audio_toggled", originalAudioOn: prev, tabId: targetId }, targetId);
      throw new Error("无法切换原声：" + (err?.message || err));
    }
    return next;
  }

  async start({ tab, settings, onCaptionsReady }) {
    if (!tab?.id) throw new Error("没有可操作的标签页");
    if (this.isRunning(tab.id)) {
      await this.stop(tab.id);
      return;
    }

    this.currentTabId = tab.id;
    let task = this.tasks.get(tab.id);
    if (!task) {
      task = new InterpretTask({ tabId: tab.id, sourceUrl: tab.url, title: tab.title });
      this.tasks.set(tab.id, task);
    } else {
      task.sourceUrl = tab.url;
      task.title = tab.title || task.title;
    }

    task.fsmState = InterpretState.PREPARING;
    task.details = {
      mode: "audio",
      message: "正在探测播放器并暂停画面…",
      hint: "",
      src: "",
      zh: "",
      error: "",
    };
    this.notify({ type: "preparing", tabId: tab.id }, tab.id);

    let startAt = 0;
    let openingHold = false;
    try {
      await injectVideo(tab.id, "pick", { fresh: true });
      const st = await injectVideo(tab.id, "state");
      startAt = Number(st?.currentTime) || 0;
      openingHold = Boolean(st?.ok && !st.ended && !st.paused);
      const held = await injectVideo(tab.id, "control", { action: "pause", system: true });
      const verified = await injectVideo(tab.id, "state");
      if (!held?.ok || !verified?.paused) {
        throw new Error("播放器未能暂停，未开始同传。请重试。");
      }
    } catch (err) {
      task.fsmState = InterpretState.ERROR;
      task.details.error = err.message || String(err);
      this.notify({ type: "error", error: task.details.error, tabId: tab.id }, tab.id);
      return;
    }

    const abort = new AbortController();
    task.abortController = abort;
    task.currentCapture = null;
    task.originalAudioOn = false;
    task.fsmState = InterpretState.RUNNING;
    task.details.message = "同传已开始…";
    this.notify({ type: "started", tabId: tab.id }, tab.id);

    try {
      const result = await runInterpret({
        tabId: tab.id,
        sourceUrl: tab.url,
        title: tab.title,
        settings,
        bufferSegments: Number(settings?.tts?.bufferSegments) || 5,
        startAt,
        openingHold,
        capture: task.currentCapture,
        signal: abort.signal,
        wantOriginalAudio: () => task.abortController === abort && task.originalAudioOn,
        onEditable: edit => { task.editLine = edit; },
        onEvent: (ev) => {
          if (task.abortController !== abort) return;
          if (ev.type === "line") {
            task.details.lineId = ev.id;
            task.details.speaker = ev.speaker || '';
            task.details.src = ev.src || "";
            task.details.zh = ev.zh || "";
            task.details.mode = ev.mode || task.details.mode;
            task.details.hint = "";
            this.notify({ type: "line", line: ev, tabId: tab.id }, tab.id);
          } else if (ev.type === "status") {
            task.details.message = ev.message || task.details.message;
            task.details.hint = ev.hint || "";
            task.details.mode = ev.mode || task.details.mode;
            if (ev.clearLine) {
              task.details.src = "";
              task.details.zh = "";
            }
            this.notify({ type: "status", status: ev, tabId: tab.id }, tab.id);
          } else if (ev.type === "warn") {
            task.details.hint = ev.message || "";
            this.notify({ type: "warn", message: ev.message, tabId: tab.id }, tab.id);
          }
        },
      });

      if (task.abortController !== abort) return;
      if (result?.captions?.status === "ready") {
        onCaptionsReady?.(result.captions);
      }

      task.fsmState = InterpretState.IDLE;
      task.originalAudioOn = true;
      task.details.message = result?.lines?.length ? "同传已结束" : "同传已停止";
      this.notify({ type: "stopped", result, tabId: tab.id }, tab.id);
    } catch (err) {
      if (task.abortController !== abort) return;
      if (err?.name === "AbortError" || /abort/i.test(err?.message || "")) {
        task.fsmState = InterpretState.IDLE;
        task.details.message = "同传已中止";
        this.notify({ type: "stopped", tabId: tab.id }, tab.id);
      } else {
        task.fsmState = InterpretState.ERROR;
        task.details.error = err.message || String(err);
        this.notify({ type: "error", error: task.details.error, tabId: tab.id }, tab.id);
      }
    } finally {
      if (task.abortController === abort) {
        task.originalAudioOn = true;
        task.abortController = null;
      }
      const cap = task.currentCapture;
      task.currentCapture = null;
      if (cap) {
        discardCapture(cap).catch(() => {});
      }
      if (task.fsmState === InterpretState.RUNNING || task.fsmState === InterpretState.PREPARING) {
        task.fsmState = InterpretState.IDLE;
      }
      this.notify({ type: "idle", tabId: tab.id }, tab.id);
      this.tasks.delete(tab.id);
    }
  }

  async editCurrentLine(tabId, text) {
    const task = this.tasks.get(tabId || this.currentTabId);
    if (!task?.editLine || !task.details.lineId) throw new Error('当前没有可修改的配音句段');
    await task.editLine(task.details.lineId, text);
  }

  async stop(tabId) {
    const targetId = tabId || this.currentTabId;
    const task = targetId ? this.tasks.get(targetId) : null;

    if (task) {
      task.fsmState = InterpretState.STOPPING;
      task.abortController?.abort();
      const cap = task.currentCapture;
      task.currentCapture = null;
      task.originalAudioOn = true;
      task.fsmState = InterpretState.IDLE;
      task.details.message = "同传已停止";
      this.notify({ type: "stopped", tabId: targetId }, targetId);
      if (cap) {
        await discardCapture(cap).catch(() => {});
      }
      this.tasks.delete(targetId);
      return;
    }

    let stoppedCount = 0;
    // Stop all tasks if no specific tab given
    for (const [id, t] of this.tasks.entries()) {
      t.fsmState = InterpretState.STOPPING;
      t.abortController?.abort();
      const cap = t.currentCapture;
      t.currentCapture = null;
      t.originalAudioOn = true;
      t.fsmState = InterpretState.IDLE;
      this.notify({ type: "stopped", tabId: id }, id);
      stoppedCount++;
      if (cap) {
        await discardCapture(cap).catch(() => {});
      }
    }
    if (stoppedCount === 0) {
      this.notify({ type: "stopped" });
    }
    abortRecording();
    this.tasks.clear();
  }
}

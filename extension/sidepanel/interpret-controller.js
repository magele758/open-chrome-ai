/**
 * PageLens Live Interpretation Finite State Machine (FSM) & Controller.
 * Manages video probe, capture setup, stream lifecycle, audio-gain toggle, and cleanup.
 */

import { injectVideo } from "../lib/chrome.js";
import { runInterpret } from "../lib/interpret.js";
import { abortRecording, discardCapture } from "../lib/tab-audio.js";

export const InterpretState = {
  IDLE: "idle",
  PREPARING: "preparing",
  RUNNING: "running",
  STOPPING: "stopping",
  ERROR: "error",
};

export class InterpretController {
  constructor() {
    this.fsmState = InterpretState.IDLE;
    this.abortController = null;
    this.currentCapture = null;
    this.originalAudioOn = true;
    this.currentTabId = null;
    this.details = {
      mode: "audio",
      message: "",
      hint: "",
      src: "",
      zh: "",
      error: "",
    };
    this.listeners = new Set();
  }

  getState() {
    return {
      fsmState: this.fsmState,
      status: this.fsmState === InterpretState.RUNNING ? "running" : this.fsmState === InterpretState.ERROR ? "error" : "idle",
      originalAudioOn: this.originalAudioOn,
      ...this.details,
    };
  }

  isRunning() {
    return this.fsmState === InterpretState.RUNNING || this.fsmState === InterpretState.PREPARING;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(event) {
    for (const listener of this.listeners) {
      try {
        listener(event, this.getState());
      } catch (err) {
        console.error("[InterpretController] listener error", err);
      }
    }
  }

  async toggleOriginalAudio(tabId) {
    const targetId = tabId || this.currentTabId;
    if (!targetId) return this.originalAudioOn;

    const next = !this.originalAudioOn;
    this.originalAudioOn = next;
    this.notify({ type: "audio_toggled", originalAudioOn: next });

    try {
      await injectVideo(targetId, next ? "restore" : "silence");
      this.currentCapture?.playback?.setGain?.(next ? 1 : 0);
    } catch (err) {
      this.originalAudioOn = !next;
      this.notify({ type: "audio_toggled", originalAudioOn: !next });
      throw new Error("无法切换原声：" + (err?.message || err));
    }
    return this.originalAudioOn;
  }

  async start({ tab, settings, onCaptionsReady }) {
    if (!tab?.id) throw new Error("没有可操作的标签页");
    if (this.isRunning()) {
      await this.stop();
      return;
    }

    this.currentTabId = tab.id;
    this.fsmState = InterpretState.PREPARING;
    this.details = {
      mode: "audio",
      message: "正在探测播放器并暂停画面…",
      hint: "",
      src: "",
      zh: "",
      error: "",
    };
    this.notify({ type: "preparing" });

    let startAt = 0;
    let openingHold = false;
    try {
      await injectVideo(tab.id, "pick", { fresh: true });
      const st = await injectVideo(tab.id, "state");
      startAt = Number(st?.currentTime) || 0;
      openingHold = Boolean(st?.ok && !st.ended);
      const held = await injectVideo(tab.id, "control", { action: "pause", system: true });
      const verified = await injectVideo(tab.id, "state");
      if (!held?.ok || !verified?.paused) {
        throw new Error("播放器未能暂停，未开始同传。请重试。");
      }
    } catch (err) {
      this.fsmState = InterpretState.ERROR;
      this.details.error = err.message || String(err);
      this.notify({ type: "error", error: this.details.error });
      return;
    }

    const abort = new AbortController();
    this.abortController = abort;
    this.currentCapture = null;
    this.originalAudioOn = false;
    this.fsmState = InterpretState.RUNNING;
    this.details.message = "同传已开始…";
    this.notify({ type: "started" });

    try {
      const result = await runInterpret({
        tabId: tab.id,
        sourceUrl: tab.url,
        settings,
        startAt,
        openingHold,
        capture: this.currentCapture,
        signal: abort.signal,
        wantOriginalAudio: () => this.abortController === abort && this.originalAudioOn,
        onEvent: (ev) => {
          if (this.abortController !== abort) return;
          if (ev.type === "line") {
            this.details.src = ev.src || "";
            this.details.zh = ev.zh || "";
            this.details.mode = ev.mode || this.details.mode;
            this.details.hint = "";
            this.notify({ type: "line", line: ev });
          } else if (ev.type === "status") {
            this.details.message = ev.message || this.details.message;
            this.details.hint = ev.hint || "";
            this.details.mode = ev.mode || this.details.mode;
            if (ev.clearLine) {
              this.details.src = "";
              this.details.zh = "";
            }
            this.notify({ type: "status", status: ev });
          } else if (ev.type === "warn") {
            this.details.hint = ev.message || "";
            this.notify({ type: "warn", message: ev.message });
          }
        },
      });

      if (this.abortController !== abort) return;
      if (result?.captions?.status === "ready") {
        onCaptionsReady?.(result.captions);
      }

      this.fsmState = InterpretState.IDLE;
      this.originalAudioOn = true;
      this.details.message = result?.lines?.length ? "同传已结束" : "同传已停止";
      this.notify({ type: "stopped", result });
    } catch (err) {
      if (this.abortController !== abort) return;
      if (err?.name === "AbortError" || /abort/i.test(err?.message || "")) {
        this.fsmState = InterpretState.IDLE;
        this.details.message = "同传已中止";
        this.notify({ type: "stopped" });
      } else {
        this.fsmState = InterpretState.ERROR;
        this.details.error = err.message || String(err);
        this.notify({ type: "error", error: this.details.error });
      }
    } finally {
      if (this.abortController === abort) {
        this.originalAudioOn = true;
        this.abortController = null;
      }
      const cap = this.currentCapture;
      this.currentCapture = null;
      if (cap) {
        discardCapture(cap).catch(() => {});
      }
      if (this.fsmState === InterpretState.RUNNING || this.fsmState === InterpretState.PREPARING) {
        this.fsmState = InterpretState.IDLE;
      }
      this.notify({ type: "idle" });
    }
  }

  async stop() {
    this.fsmState = InterpretState.STOPPING;
    this.abortController?.abort();
    abortRecording();
    const cap = this.currentCapture;
    this.currentCapture = null;
    this.originalAudioOn = true;
    this.fsmState = InterpretState.IDLE;
    this.details.message = "同传已停止";
    this.notify({ type: "stopped" });
    if (cap) {
      await discardCapture(cap).catch(() => {});
    }
  }
}

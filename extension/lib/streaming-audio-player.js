let sharedAudioContext = null;
let sharedKeepAliveSource = null;

export function getSharedAudioContext() {
  if (typeof AudioContext === 'undefined') return null;
  if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
    try {
      sharedAudioContext = new AudioContext();
    } catch {
      return null;
    }
  }
  if (sharedAudioContext && sharedAudioContext.state === 'suspended') {
    sharedAudioContext.resume().catch(() => {});
  }
  if (sharedAudioContext && !sharedKeepAliveSource && typeof sharedAudioContext.createBufferSource === 'function') {
    try {
      const sampleRate = sharedAudioContext.sampleRate || 24000;
      const silentBuffer = sharedAudioContext.createBuffer(1, sampleRate, sampleRate);
      const source = sharedAudioContext.createBufferSource();
      source.buffer = silentBuffer;
      source.loop = true;
      const silentGain = sharedAudioContext.createGain();
      silentGain.gain.setValueAtTime(0.00001, sharedAudioContext.currentTime || 0);
      source.connect(silentGain);
      if (sharedAudioContext.destination) {
        silentGain.connect(sharedAudioContext.destination);
      }
      source.start();
      sharedKeepAliveSource = source;
    } catch {
      // ignore in tests or mock environments
    }
  }
  return sharedAudioContext;
}

export function setSharedAudioContext(ctx) {
  sharedAudioContext = ctx;
}

export class StreamingAudioPlayer {
  constructor(options = {}) {
    this.gapMs = Math.max(0, Number(options.gapMs) || 0);
    this.initialBufferCount = Math.max(1, Number(options.initialBufferCount) || 1);
    this.playbackRate = Math.max(0.25, Math.min(4, Number(options.playbackRate) || 1.0));
    this.volume = Number.isFinite(Number(options.volume)) ? Math.max(0, Math.min(1, Number(options.volume))) : 1.0;
    this.audioDuration = options.audioDuration || null;

    // Custom injectable classes/factories (for testability and headless environments)
    this.AudioContextClass = options.AudioContextClass !== undefined
      ? options.AudioContextClass
      : (typeof AudioContext !== 'undefined' ? AudioContext : null);
    this.createAudioElement = options.createAudioElement || (url => new Audio(url));

    // Event callbacks
    this.onItemStart = options.onItemStart || (() => {});
    this.onItemEnd = options.onItemEnd || (() => {});
    this.onBuffering = options.onBuffering || (() => {});
    this.onQueueUpdate = options.onQueueUpdate || (() => {});
    this.onStateChange = options.onStateChange || (() => {});
    this.onEnded = options.onEnded || (() => {});
    this.onError = options.onError || (() => {});

    // Lifecycle and state
    this.state = 'idle'; // 'idle' | 'buffering' | 'playing' | 'paused' | 'stopped'
    this.isBuffering = false;
    this.userPaused = false;
    this.streamClosed = false;
    this.queue = [];
    this.scheduledItems = [];
    this.history = [];
    this.currentItem = null;
    this.nextScheduledTime = 0;
    this.lastPlayedSourceEnd = 0;

    // Web Audio instances
    this.audioContext = options.audioContext || null;
    this.gainNode = null;
    this.useWebAudio = Boolean(this.AudioContextClass);

    // Element fallback instances
    this.activeAudio = null;
    this.activeAudioUrl = null;
    this.nextAudio = null;
    this.nextAudioUrl = null;

    this.timer = null;
    this.startedCount = 0;
    this.finishedCount = 0;

    if (options.signal) {
      options.signal.addEventListener('abort', () => this.stop(), { once: true });
      if (options.signal.aborted) this.stop();
    }
  }

  getCurrentSourceTime() {
    if (this.currentItem && Number.isFinite(this.currentItem.end)) {
      return this.currentItem.end;
    }
    return this.lastPlayedSourceEnd || 0;
  }

  getScheduledSourceTime() {
    let max = this.getCurrentSourceTime();
    for (const item of this.scheduledItems) {
      if (Number.isFinite(item.end) && item.end > max) max = item.end;
    }
    for (const item of this.queue) {
      if (Number.isFinite(item.end) && item.end > max) max = item.end;
    }
    return max;
  }

  async ensureAudioContext() {
    if (!this.useWebAudio) return null;
    if (!this.audioContext) {
      try {
        const shared = getSharedAudioContext();
        if (shared && typeof shared.createGain === 'function') {
          this.audioContext = shared;
        } else {
          this.audioContext = new this.AudioContextClass();
        }
        if (this.audioContext && !this.gainNode && typeof this.audioContext.createGain === 'function') {
          this.gainNode = this.audioContext.createGain();
          this.gainNode.gain.setValueAtTime(this.volume, this.audioContext.currentTime || 0);
          if (this.audioContext.destination) {
            this.gainNode.connect(this.audioContext.destination);
          }
        }
      } catch (err) {
        console.warn('[StreamingAudioPlayer] Web Audio initialization failed, falling back to Audio element:', err);
        this.useWebAudio = false;
        return null;
      }
    }
    if (this.audioContext && this.audioContext.state === 'suspended' && !this.userPaused) {
      await this.audioContext.resume().catch(() => {});
    }
    if (this.audioContext && this.audioContext.state === 'running') {
      this.startKeepAlive();
    }
    return this.audioContext;
  }

  startKeepAlive() {
    if (this.keepAliveNode || !this.audioContext || typeof this.audioContext.createBuffer !== 'function') return;
    try {
      const sampleRate = this.audioContext.sampleRate || 24000;
      const silentBuffer = this.audioContext.createBuffer(1, sampleRate, sampleRate);
      const source = this.audioContext.createBufferSource();
      source.buffer = silentBuffer;
      source.loop = true;
      const silentGain = this.audioContext.createGain();
      silentGain.gain.setValueAtTime(0, this.audioContext.currentTime || 0);
      source.connect(silentGain);
      if (this.audioContext.destination) {
        silentGain.connect(this.audioContext.destination);
      }
      source.start();
      this.keepAliveNode = source;
      this.keepAliveGain = silentGain;
    } catch {
      // Ignore in mock or restricted environments
    }
  }

  stopKeepAlive() {
    if (this.keepAliveNode) {
      try {
        this.keepAliveNode.stop();
        this.keepAliveNode.disconnect();
      } catch {}
      this.keepAliveNode = null;
    }
    if (this.keepAliveGain) {
      try { this.keepAliveGain.disconnect(); } catch {}
      this.keepAliveGain = null;
    }
  }

  startTicker() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick();
    }, 25);
  }

  stopTicker() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  tick() {
    if (this.state === 'paused' || this.state === 'stopped') return;

    if (this.useWebAudio && this.audioContext) {
      const cur = this.audioContext.currentTime;

      // 1. Check if current scheduled item started
      for (const item of this.scheduledItems) {
        if (!item.started && cur >= item.scheduledStart && cur < item.scheduledEnd) {
          item.started = true;
          this.currentItem = item;
          this.startedCount++;
          if (this.isBuffering) {
            this.isBuffering = false;
            this.onBuffering(false);
          }
          this.setState('playing');
          this.onItemStart(item);
        }
      }

      // 2. Check if scheduled items finished
      while (this.scheduledItems.length > 0 && this.scheduledItems[0].scheduledEnd <= cur) {
        const item = this.scheduledItems.shift();
        if (!item.ended) {
          item.ended = true;
          this.finishedCount++;
          if (Number.isFinite(item.end) && item.end > this.lastPlayedSourceEnd) {
            this.lastPlayedSourceEnd = item.end;
          }
          this.onItemEnd(item);
          if (this.currentItem === item) {
            this.currentItem = null;
          }
        }
      }

      // 3. Starvation or stream end detection
      if (this.scheduledItems.length === 0) {
        if (this.streamClosed && this.queue.length === 0 && !this.isDraining) {
          this.finish();
        } else if (!this.streamClosed && !this.isBuffering && this.startedCount > 0) {
          this.isBuffering = true;
          this.setState('buffering');
          this.onBuffering(true);
        }
      }
    }
  }

  setState(nextState) {
    if (this.state === nextState) return;
    this.state = nextState;
    this.onStateChange(nextState);
  }

  /**
   * Enqueue a new audio chunk from translation/TTS ("翻译一段补一段").
   * @param {object} item - { id, blob, zh, src, speaker, start, end, ... }
   */
  async enqueue(item) {
    if (this.state === 'stopped') return;
    if (!item || !item.blob) throw new Error('Invalid audio chunk for streaming');

    const entry = {
      ...item,
      enqueuedAt: Date.now(),
      started: false,
      ended: false,
      sourceNode: null,
      audioBuffer: null,
      duration: 0,
    };

    this.queue.push(entry);
    this.history.push(entry);
    this.emitQueueUpdate();

    await this.drainQueue();
  }

  async drainQueue() {
    if (this.isDraining || this.state === 'stopped' || this.state === 'paused' || this.userPaused) return;
    this.isDraining = true;

    try {
      if (this.useWebAudio) {
        await this.ensureAudioContext();
        if (!this.audioContext) {
          await this.processQueueElement();
          return;
        }

        this.startTicker();

        while (this.queue.length > 0 && this.state !== 'stopped' && this.state !== 'paused' && !this.userPaused) {
          if (!this.audioContext) break;
          const item = this.queue.shift();
          this.emitQueueUpdate();

          try {
            // Decode audio blob
            let audioBuffer = item.audioBuffer;
            if (!audioBuffer) {
              const arrayBuffer = await item.blob.arrayBuffer();
              if (this.state === 'stopped' || !this.audioContext) break;
              audioBuffer = await new Promise((resolve, reject) => {
                if (!this.audioContext) return resolve(null);
                const res = this.audioContext.decodeAudioData(
                  arrayBuffer.slice(0),
                  buf => resolve(buf),
                  err => reject(err || new Error('音频解码失败'))
                );
                if (res && typeof res.then === 'function') {
                  res.then(resolve, reject);
                }
              });
              if (!audioBuffer || this.state === 'stopped' || !this.audioContext) break;
              item.audioBuffer = audioBuffer;
            }

            if (this.state === 'stopped' || this.state === 'paused' || this.userPaused || !this.audioContext) break;

            item.duration = audioBuffer.duration;
            const offset = Math.min(audioBuffer.duration, item.seekOffset || 0);
            const playDuration = (audioBuffer.duration - offset) / this.playbackRate;

            // Schedule seamlessly:
            // If scheduledItems is empty (starvation recovery or initial start),
            // or if nextScheduledTime has elapsed, schedule immediately at curTime + 0.02.
            // Otherwise, schedule precisely at nextScheduledTime (0ms gapless)!
            const curTime = this.audioContext.currentTime;
            let scheduledStart;
            if (this.scheduledItems.length === 0 || this.nextScheduledTime < curTime) {
              scheduledStart = curTime + 0.02;
            } else {
              scheduledStart = Math.max(curTime + 0.015, this.nextScheduledTime);
            }
            const scheduledEnd = scheduledStart + playDuration;

            const sourceNode = this.audioContext.createBufferSource();
            sourceNode.buffer = audioBuffer;
            sourceNode.playbackRate.value = this.playbackRate;

            if (this.gainNode) {
              sourceNode.connect(this.gainNode);
            } else if (this.audioContext.destination) {
              sourceNode.connect(this.audioContext.destination);
            }

            sourceNode.onended = () => {
              if (item.sourceNode === sourceNode && !item.ended) {
                item.ended = true;
                this.finishedCount++;
                if (Number.isFinite(item.end) && item.end > this.lastPlayedSourceEnd) {
                  this.lastPlayedSourceEnd = item.end;
                }
                const idx = this.scheduledItems.indexOf(item);
                if (idx >= 0) this.scheduledItems.splice(idx, 1);
                this.onItemEnd(item);
                if (this.currentItem === item) this.currentItem = null;
                if (this.scheduledItems.length === 0) {
                  if (this.streamClosed && this.queue.length === 0 && !this.isDraining) {
                    this.finish();
                  } else if (!this.streamClosed && !this.isBuffering && this.startedCount > 0) {
                    this.isBuffering = true;
                    this.setState('buffering');
                    this.onBuffering(true);
                  }
                }
              }
            };

            sourceNode.start(scheduledStart, offset);

            item.scheduledStart = scheduledStart;
            item.scheduledEnd = scheduledEnd;
            item.sourceNode = sourceNode;
            this.nextScheduledTime = scheduledEnd + (this.gapMs / 1000);

            this.scheduledItems.push(item);

            if (this.audioContext.state === 'suspended' && !this.userPaused) {
              await this.audioContext.resume().catch(() => {});
            }

            if (this.isBuffering) {
              this.isBuffering = false;
              this.onBuffering(false);
            }
            if (this.state === 'idle' || this.state === 'buffering') {
              this.setState('playing');
            }
            this.emitQueueUpdate();
          } catch (err) {
            console.error('[StreamingAudioPlayer] decode/schedule error', err);
            this.onError(err);
          }
        }
      } else {
        await this.processQueueElement();
      }
    } finally {
      this.isDraining = false;
    }
  }

  /**
   * Element-based fallback queue (for environments without Web Audio API or unit test mocks).
   */
  async processQueueElement() {
    if (this.state === 'stopped' || this.state === 'paused' || this.userPaused) return;
    if (this.activeAudio && !this.activeAudio.paused && !this.activeAudio.ended) return;
    if (this.queue.length === 0) {
      if (this.streamClosed) {
        this.finish();
      } else if (!this.isBuffering && this.startedCount > 0) {
        this.isBuffering = true;
        this.setState('buffering');
        this.onBuffering(true);
      }
      return;
    }

    const item = this.queue.shift();
    this.emitQueueUpdate();

    try {
      const playUrl = URL.createObjectURL(item.blob);
      this.activeAudioUrl = playUrl;
      const audio = this.createAudioElement(playUrl);
      this.activeAudio = audio;
      audio.playbackRate = this.playbackRate;
      audio.preservesPitch = true;
      audio.currentTime = item.seekOffset || 0;
      audio.volume = Number.isFinite(this.volume) ? this.volume : 1.0;

      item.started = true;
      this.currentItem = item;
      this.startedCount++;

      if (this.isBuffering) {
        this.isBuffering = false;
        this.onBuffering(false);
      }
      this.setState('playing');
      this.onItemStart(item);

      const cleanupUrl = () => {
        if (playUrl) {
          setTimeout(() => {
            try { URL.revokeObjectURL(playUrl); } catch {}
          }, 2000);
        }
        if (this.activeAudioUrl === playUrl) this.activeAudioUrl = null;
      };

      audio.onended = () => {
        cleanupUrl();
        item.ended = true;
        this.finishedCount++;
        if (Number.isFinite(item.end) && item.end > this.lastPlayedSourceEnd) {
          this.lastPlayedSourceEnd = item.end;
        }
        this.onItemEnd(item);
        this.currentItem = null;
        this.activeAudio = null;
        if (this.gapMs > 0) {
          setTimeout(() => void this.processQueueElement(), this.gapMs);
        } else {
          void this.processQueueElement();
        }
      };

      audio.onerror = (e) => {
        cleanupUrl();
        this.onError(new Error('Audio element playback error'));
        item.ended = true;
        this.currentItem = null;
        this.activeAudio = null;
        void this.processQueueElement();
      };

      await audio.play();
    } catch (err) {
      if (this.activeAudioUrl) {
        const u = this.activeAudioUrl;
        setTimeout(() => { try { URL.revokeObjectURL(u); } catch {} }, 2000);
        this.activeAudioUrl = null;
      }
      this.onError(err);
      item.ended = true;
      void this.processQueueElement();
    }
  }

  async play() {
    this.userPaused = false;
    if (this.useWebAudio && this.audioContext) {
      if (this.gainNode && typeof this.gainNode.gain?.setValueAtTime === 'function') {
        try { this.gainNode.gain.setValueAtTime(this.volume, this.audioContext.currentTime || 0); } catch {}
      }
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume().catch(() => {});
      }
    } else if (this.activeAudio && this.activeAudio.paused) {
      await this.activeAudio.play().catch(() => {});
    }
    if (this.state === 'paused' || this.state === 'idle') {
      this.setState('playing');
    }
    if (!this.isDraining) {
      if (this.useWebAudio) {
        void this.drainQueue();
      } else {
        void this.processQueueElement();
      }
    }
  }

  async pause() {
    if (this.state === 'paused' || this.state === 'stopped') return;
    this.userPaused = true;
    this.setState('paused');
    if (this.gainNode && typeof this.gainNode.gain?.setValueAtTime === 'function') {
      try { this.gainNode.gain.setValueAtTime(0, this.audioContext?.currentTime || 0); } catch {}
    }
    if (this.useWebAudio && this.audioContext) {
      if (this.audioContext.state === 'running') {
        await this.audioContext.suspend().catch(() => {});
      }
    } else if (this.activeAudio && !this.activeAudio.paused) {
      try { this.activeAudio.pause(); } catch {}
    }
  }

  async resume() {
    return this.play();
  }

  setPlaybackRate(rate) {
    const r = Math.max(0.25, Math.min(4, Number(rate) || 1.0));
    this.playbackRate = r;
    if (this.useWebAudio) {
      for (const item of this.scheduledItems) {
        if (item.sourceNode && item.sourceNode.playbackRate) {
          try { item.sourceNode.playbackRate.value = r; } catch {}
        }
      }
    }
    if (this.activeAudio) {
      this.activeAudio.playbackRate = r;
    }
    this.emitQueueUpdate();
  }

  setVolume(vol) {
    const v = Number.isFinite(Number(vol)) ? Math.max(0, Math.min(1, Number(vol))) : 1.0;
    this.volume = v;
    if (this.gainNode && this.audioContext && !this.userPaused) {
      try {
        this.gainNode.gain.setValueAtTime(v, this.audioContext.currentTime || 0);
      } catch {}
    }
    if (this.activeAudio) {
      this.activeAudio.volume = v;
    }
  }

  /**
   * Mark stream as complete (no further sentences will be enqueued).
   * Once remaining queued and scheduled audio finishes playing, player will emit onEnded.
   */
  closeStream() {
    this.streamClosed = true;
    if (!this.isDraining && this.queue.length === 0 && this.scheduledItems.length === 0 && !this.activeAudio) {
      this.finish();
    }
  }

  finish() {
    if (this.state === 'stopped') return;
    this.setState('idle');
    this.isBuffering = false;
    this.stopTicker();
    this.onEnded();
  }

  stop() {
    this.userPaused = true;
    this.setState('stopped');
    this.stopTicker();
    this.isBuffering = false;
    this.queue = [];

    // Mute and disconnect gainNode immediately to completely cut off audio
    if (this.gainNode) {
      try {
        this.gainNode.gain.setValueAtTime(0, this.audioContext?.currentTime || 0);
        this.gainNode.disconnect();
      } catch {}
      this.gainNode = null;
    }

    // Stop and disconnect Web Audio sources
    for (const item of this.scheduledItems) {
      if (item.sourceNode) {
        item.sourceNode.onended = null;
        try { item.sourceNode.stop(); } catch {}
        try { item.sourceNode.disconnect(); } catch {}
        item.sourceNode = null;
      }
    }
    this.scheduledItems = [];

    this.stopKeepAlive();
    if (this.audioContext) {
      try {
        if (this.audioContext !== sharedAudioContext && typeof this.audioContext.close === 'function') {
          this.audioContext.close().catch(() => {});
        }
      } catch {}
      this.audioContext = null;
    }

    // Stop fallback audio
    if (this.activeAudio) {
      try {
        this.activeAudio.pause();
        this.activeAudio.src = "";
        this.activeAudio.onended = this.activeAudio.onerror = null;
      } catch {}
      this.activeAudio = null;
    }
    if (this.activeAudioUrl) {
      try { URL.revokeObjectURL(this.activeAudioUrl); } catch {}
      this.activeAudioUrl = null;
    }

    this.currentItem = null;
    this.emitQueueUpdate();
  }

  getTotalDuration() {
    return this.history.reduce((acc, it) => acc + (it.duration || 0), 0);
  }

  getCurrentPlaybackTime() {
    let t = 0;
    const current = this.currentItem || this.scheduledItems[0] || this.queue[0];
    for (const it of this.history) {
      if (it === current) {
        if (this.useWebAudio && this.audioContext && Number.isFinite(it.scheduledStart)) {
          t += (it.seekOffset || 0) + Math.max(0, (this.audioContext.currentTime - it.scheduledStart) * this.playbackRate);
        } else if (this.activeAudio && Number.isFinite(this.activeAudio.currentTime)) {
          t += Math.max(0, this.activeAudio.currentTime);
        } else {
          t += it.seekOffset || 0;
        }
        break;
      }
      t += (it.duration || 0);
    }
    return Math.min(this.getTotalDuration(), t);
  }

  async seekToTime(targetSeconds) {
    if (this.state === 'stopped') return;
    const total = this.getTotalDuration();
    const clamped = Math.max(0, Math.min(total, Number(targetSeconds) || 0));

    if (this.activeAudio) {
      this.activeAudio.onended = this.activeAudio.onerror = null;
      try { this.activeAudio.pause(); } catch {}
      this.activeAudio = null;
    }

    for (const item of this.scheduledItems) {
      if (item.sourceNode) {
        item.sourceNode.onended = null;
        try { item.sourceNode.stop(); } catch {}
        try { item.sourceNode.disconnect(); } catch {}
      }
    }
    this.scheduledItems = [];
    this.queue = [];
    this.currentItem = null;
    this.nextScheduledTime = 0;

    let acc = 0;
    let targetIdx = 0;
    for (let i = 0; i < this.history.length; i++) {
      const dur = this.history[i].duration || 0;
      if (acc + dur > clamped || i === this.history.length - 1) {
        targetIdx = i;
        break;
      }
      acc += dur;
    }

    this.lastPlayedSourceEnd = this.history[targetIdx]?.start || 0;

    for (let j = targetIdx; j < this.history.length; j++) {
      const h = this.history[j];
      h.started = false;
      h.ended = false;
      h.sourceNode = null;
      h.scheduledStart = undefined;
      h.seekOffset = j === targetIdx ? clamped - acc : 0;
      this.queue.push(h);
    }

    this.emitQueueUpdate();
    if (!this.userPaused) {
      if (this.useWebAudio) {
        this.setState('playing');
        this.startTicker();
        await this.drainQueue();
      } else {
        this.setState('playing');
        await this.processQueueElement();
      }
    }
  }

  getStats() {
    const bufferedSec = this.scheduledItems.reduce((acc, it) => acc + (it.duration || 0), 0)
      + this.queue.reduce((acc, it) => acc + (it.duration || 0), 0);
    return {
      state: this.state,
      isBuffering: this.isBuffering,
      userPaused: Boolean(this.userPaused),
      queueLength: this.queue.length,
      scheduledLength: this.scheduledItems.length,
      totalBufferedSeconds: bufferedSec,
      totalDuration: this.getTotalDuration(),
      currentTime: this.getCurrentPlaybackTime(),
      currentItem: this.currentItem,
      playbackRate: this.playbackRate,
      volume: this.volume,
    };
  }

  emitQueueUpdate() {
    try {
      this.onQueueUpdate(this.getStats());
    } catch {}
  }
}

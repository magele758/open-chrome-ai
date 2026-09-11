export function pickMime() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const type of types) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return "";
}

export async function getTabStream(streamId) {
  const audio = {
    mandatory: {
      chromeMediaSource: "tab",
      chromeMediaSourceId: streamId,
    },
  };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video: false });
  } catch {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio,
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
          maxFrameRate: 1,
          maxWidth: 16,
          maxHeight: 16,
        },
      },
    });
    for (const track of stream.getVideoTracks()) track.stop();
    return stream;
  }
}

export function playThrough(stream) {
  let ctx = null;
  let src = null;
  let gain = null;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      ctx = new AC();
      src = ctx.createMediaStreamSource(stream);
      gain = ctx.createGain();
      gain.gain.value = 1;
      src.connect(gain);
      gain.connect(ctx.destination);
      ctx.resume?.();
    }
  } catch {
    /* 播不出来时标签可能会静音，取声仍继续 */
  }
  return {
    setGain(value) {
      if (!gain) return;
      const v = Math.max(0, Math.min(1, Number(value)));
      const next = Number.isFinite(v) ? v : 1;
      try {
        const t = ctx?.currentTime || 0;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.linearRampToValueAtTime(next, t + 0.08);
      } catch {
        gain.gain.value = next;
      }
    },
    dispose() {
      try {
        src?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        gain?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        ctx?.close();
      } catch {
        /* ignore */
      }
    },
  };
}

export function isQuietBlob(blob) {
  return !blob || blob.size < 1500;
}

/**
 * Computes root-mean-square energy of audio float samples.
 */
export function computeRms(data) {
  if (!data || data.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    sum += data[i] * data[i];
  }
  return Math.sqrt(sum / data.length);
}

/**
 * Assesses audio waveform suitability for zero-shot TTS voice cloning (SNR & voice activity).
 * Evaluates RMS energy, clipping distortion, frame-level voice activity ratio, and dynamic range.
 */
export function assessVoiceQuality(samples, sampleRate = 44100) {
  if (!samples || samples.length === 0) {
    return { ok: false, score: 0, reason: "empty_audio" };
  }
  const n = samples.length;
  let sumSq = 0;
  let peak = 0;
  let clippedCount = 0;
  let zeroCrossings = 0;
  let prevSign = samples[0] >= 0;

  // Frame size ~20ms
  const sr = Number(sampleRate) > 0 ? Number(sampleRate) : 44100;
  const frameSize = Math.max(1, Math.floor(sr * 0.02));
  let frameSum = 0;
  let activeSpeechFrames = 0;
  const frameCount = Math.floor(n / frameSize);

  for (let i = 0; i < n; i += 1) {
    const s = samples[i];
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
    if (abs >= 0.98) clippedCount += 1;
    sumSq += s * s;

    const sign = s >= 0;
    if (sign !== prevSign) {
      zeroCrossings += 1;
      prevSign = sign;
    }

    frameSum += s * s;
    if ((i + 1) % frameSize === 0) {
      const frameRms = Math.sqrt(frameSum / frameSize);
      if (frameRms >= 0.02) activeSpeechFrames += 1;
      frameSum = 0;
    }
  }

  const rms = Math.sqrt(sumSq / n);
  if (rms < 0.015) {
    return { ok: false, score: 0, rms, peak, reason: "too_quiet" };
  }
  if (clippedCount / n > 0.05) {
    return { ok: false, score: 0.1, rms, peak, reason: "distorted_clipping" };
  }

  const voiceActivityRatio = frameCount > 0 ? activeSpeechFrames / frameCount : 0;
  if (voiceActivityRatio < 0.15) {
    return { ok: false, score: voiceActivityRatio, rms, peak, reason: "insufficient_speech" };
  }

  const crestFactor = rms > 0 ? peak / rms : 1;
  const durationSec = n / sr;
  const zcrPerSec = durationSec > 0 ? zeroCrossings / durationSec : 0;

  // Score from 0 to 1
  let score = voiceActivityRatio * 0.45 + Math.min(crestFactor / 5, 0.35);
  if (zcrPerSec >= 80 && zcrPerSec <= 4500) score += 0.2;
  else score += 0.05;

  score = Math.min(1, Math.max(0, score));

  return {
    ok: score >= 0.35 && rms >= 0.02 && crestFactor >= 1.8,
    score: Number(score.toFixed(3)),
    rms: Number(rms.toFixed(4)),
    peak: Number(peak.toFixed(4)),
    crestFactor: Number(crestFactor.toFixed(3)),
    voiceActivityRatio: Number(voiceActivityRatio.toFixed(3)),
    zcrPerSec: Math.round(zcrPerSec),
  };
}

/**
 * Creates a lightweight VAD analyzer tapping a MediaStream via WebAudio.
 * Tracks speaking state, speech onset, and silence pause durations.
 */
export function createVadAnalyzer(stream, {
  speechThreshold = 0.02,
  silenceThreshold = 0.012,
  pollIntervalMs = 50,
} = {}) {
  let ctx = null;
  let src = null;
  let analyser = null;
  let buffer = null;

  try {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (AC && stream && typeof stream.getAudioTracks === "function" && stream.getAudioTracks().length > 0) {
      ctx = new AC();
      src = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      buffer = new Float32Array(analyser.fftSize);
      ctx.resume?.().catch(() => {});
    }
  } catch {
    ctx = null;
    src = null;
    analyser = null;
    buffer = null;
  }

  let speechDetected = false;
  let silenceDurationMs = 0;
  let lastRms = 0;
  let timer = null;
  let onSilencePause = null;
  let requiredSilenceMs = 300;
  let minDurationPassed = false;

  const sample = () => {
    if (!analyser || !buffer) return;
    try {
      analyser.getFloatTimeDomainData(buffer);
      lastRms = computeRms(buffer);
    } catch {
      return;
    }

    if (lastRms >= speechThreshold) {
      speechDetected = true;
      silenceDurationMs = 0;
    } else if (lastRms <= silenceThreshold) {
      if (speechDetected) {
        silenceDurationMs += pollIntervalMs;
        if (minDurationPassed && silenceDurationMs >= requiredSilenceMs) {
          onSilencePause?.();
        }
      }
    }
  };

  if (analyser) {
    timer = setInterval(sample, pollIntervalMs);
  }

  return {
    isAvailable: Boolean(analyser),
    getSpeechDetected: () => speechDetected,
    getLastRms: () => lastRms,
    getSilenceDurationMs: () => silenceDurationMs,
    armPauseTrigger: ({ minPassed, pauseMs, onPause }) => {
      minDurationPassed = Boolean(minPassed);
      if (Number.isFinite(pauseMs)) requiredSilenceMs = pauseMs;
      if (typeof onPause === "function") onSilencePause = onPause;
      if (minDurationPassed && speechDetected && silenceDurationMs >= requiredSilenceMs) {
        onSilencePause?.();
      }
    },
    dispose: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      try { src?.disconnect(); } catch { /* ignore */ }
      try { analyser?.disconnect(); } catch { /* ignore */ }
      try { ctx?.close?.(); } catch { /* ignore */ }
      src = null;
      analyser = null;
      ctx = null;
    },
  };
}

export function recordSlice(stream, seconds, signal, options = {}) {
  if (!stream) return Promise.reject(new Error("没有当前标签的声音。"));
  const mime = pickMime();
  const rec = new MediaRecorder(
    stream,
    mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : { audioBitsPerSecond: 48000 },
  );
  const chunks = [];
  const t0 = Date.now();
  const targetSec = Number(seconds) || 5;
  const targetMs = Math.max(800, targetSec * 1000);

  const enableVad = options.enableVad !== false;
  const minMs = Math.max(800, (Number(options.minSeconds) || Math.max(1.8, Math.min(targetSec * 0.45, 2.5))) * 1000);
  const maxMs = Math.max(targetMs, (Number(options.maxSeconds) || Math.max(targetSec + 2.5, 7.5)) * 1000);
  const silencePauseMs = Number(options.silencePauseMs) || 300;

  return new Promise((resolve, reject) => {
    let settled = false;
    let minTimer = null;
    let targetTimer = null;
    let maxTimer = null;
    let fixedTimer = null;

    let vad = null;
    if (enableVad) {
      try {
        vad = createVadAnalyzer(stream, {
          speechThreshold: options.speechThreshold,
          silenceThreshold: options.silenceThreshold,
          pollIntervalMs: options.pollIntervalMs,
        });
      } catch {
        vad = null;
      }
    }

    const clearTimers = () => {
      if (minTimer) { clearTimeout(minTimer); minTimer = null; }
      if (targetTimer) { clearTimeout(targetTimer); targetTimer = null; }
      if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
      if (fixedTimer) { clearTimeout(fixedTimer); fixedTimer = null; }
      if (vad) { vad.dispose(); vad = null; }
    };

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      signal?.removeEventListener("abort", onAbort);
      if (err) {
        reject(err);
        return;
      }
      const type = rec.mimeType || mime || "audio/webm";
      resolve({
        blob: new Blob(chunks, { type }),
        mime: type,
        seconds: (Date.now() - t0) / 1000,
        vad: vad ? {
          speechDetected: vad.getSpeechDetected(),
          lastRms: vad.getLastRms(),
        } : undefined,
      });
    };

    const stop = () => {
      try {
        if (rec.state !== "inactive") rec.stop();
        else finish();
      } catch (err) {
        finish(err);
      }
    };

    const onAbort = () => {
      clearTimers();
      stop();
    };

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => finish();
    rec.onerror = (ev) => finish(ev.error || new Error("无法截取当前声音"));

    if (vad && vad.isAvailable) {
      // 1. When minMs passes, arm pause trigger
      minTimer = setTimeout(() => {
        vad?.armPauseTrigger({
          minPassed: true,
          pauseMs: silencePauseMs,
          onPause: () => stop(),
        });
      }, minMs);

      // 2. If no speech at all by targetMs, finish at target
      targetTimer = setTimeout(() => {
        if (!vad?.getSpeechDetected()) {
          stop();
        }
      }, targetMs);

      // 3. Hard ceiling at maxMs
      maxTimer = setTimeout(() => {
        stop();
      }, maxMs);
    } else {
      // Fallback to fixed timer
      fixedTimer = setTimeout(stop, targetMs);
    }

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      rec.start();
    } catch (err) {
      clearTimers();
      finish(err);
    }
  });
}

export function captureWithRecorder(stream) {
  const mime = pickMime();
  const rec = new MediaRecorder(
    stream,
    mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : { audioBitsPerSecond: 48000 },
  );
  const chunks = [];
  const t0 = Date.now();
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  rec.start(1000);
  return {
    stop() {
      return new Promise((resolve, reject) => {
        const finish = () => {
          const type = rec.mimeType || mime || "audio/webm";
          resolve({
            blob: new Blob(chunks, { type }),
            mime: type,
            seconds: (Date.now() - t0) / 1000,
          });
        };
        if (rec.state === "inactive") {
          finish();
          return;
        }
        rec.onstop = finish;
        rec.onerror = (ev) => reject(ev.error || new Error("录音失败"));
        try {
          rec.stop();
        } catch (err) {
          reject(err);
        }
      });
    },
  };
}

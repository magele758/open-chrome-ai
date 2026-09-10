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

export function recordSlice(stream, seconds, signal) {
  if (!stream) return Promise.reject(new Error("没有当前标签的声音。"));
  const mime = pickMime();
  const rec = new MediaRecorder(
    stream,
    mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : { audioBitsPerSecond: 48000 },
  );
  const chunks = [];
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
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
      clearTimeout(timer);
      stop();
    };
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => finish();
    rec.onerror = (ev) => finish(ev.error || new Error("无法截取当前声音"));
    const ms = Math.max(800, (Number(seconds) || 5) * 1000);
    const timer = setTimeout(stop, ms);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      rec.start();
    } catch (err) {
      clearTimeout(timer);
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

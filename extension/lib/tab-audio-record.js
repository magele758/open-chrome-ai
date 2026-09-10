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
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      ctx = new AC();
      src = ctx.createMediaStreamSource(stream);
      src.connect(ctx.destination);
      ctx.resume?.();
    }
  } catch {
    /* 播不出来时标签可能会静音，录音仍继续 */
  }
  return {
    dispose() {
      try {
        src?.disconnect();
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

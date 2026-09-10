/**
 * Self-contained. Injected via executeScript — no module locals / imports.
 * cmd: list | pick | state | control | seek | select
 */
export function plVideo(cmd, arg) {
  const KEY = "__plVideoIndex";
  const o = arg && typeof arg === "object" ? arg : {};

  const visible = (el) => {
    if (!el) return false;
    const w = el.offsetWidth || 0;
    const h = el.offsetHeight || 0;
    if (el.tagName === "AUDIO") return Number.isFinite(el.duration) && el.duration > 0;
    return w >= 80 && h >= 45;
  };

  const nodes = () =>
    [...document.querySelectorAll("video, audio")].filter(visible);

  const snapshot = (el, i, total) => {
    if (!el) return null;
    const w = el.offsetWidth || 0;
    const h = el.offsetHeight || 0;
    const cls = String(el.className || "");
    const dur = Number.isFinite(el.duration) ? el.duration : 0;
    return {
      i,
      total,
      tag: el.tagName.toLowerCase(),
      width: el.videoWidth || w,
      height: el.videoHeight || h,
      boxW: w,
      boxH: h,
      duration: dur,
      currentTime: el.currentTime || 0,
      paused: Boolean(el.paused),
      ended: Boolean(el.ended),
      playbackRate: el.playbackRate || 1,
      muted: Boolean(el.muted),
      readyState: el.readyState || 0,
      main: /html5-main-video|video-stream/.test(cls) || Boolean(el.closest("#movie_player")),
      label: dur
        ? `${Math.round(w)}×${Math.round(h)} · ${Math.round(dur)}s${el.paused ? "" : " · 播放中"}`
        : `${Math.round(w)}×${Math.round(h)}`,
    };
  };

  const score = (el) => {
    const w = el.offsetWidth || 0;
    const h = el.offsetHeight || 0;
    const area = w * h;
    const cls = String(el.className || "");
    const dur = Number.isFinite(el.duration) ? el.duration : 0;
    let s = Math.min(area / 800, 500);
    if (/html5-main-video/.test(cls)) s += 900;
    if (/video-stream/.test(cls)) s += 200;
    if (el.closest("#movie_player, .html5-video-player, .bpx-player-container, .bilibili-player, .xgplayer, .jwplayer")) {
      s += 250;
    }
    if (!el.paused && !el.ended) s += 320;
    if ((el.currentTime || 0) > 0.4) s += 120;
    if (dur >= 8) s += 80;
    if (dur >= 60) s += 70;
    if ((el.readyState || 0) >= 2) s += 40;
    const st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") s -= 700;
    if (area < 160 * 90) s -= 450;
    if (el.tagName === "AUDIO") s -= 60;
    return s;
  };

  const mark = (el) => {
    document.querySelectorAll("[data-pagelens-player]").forEach((n) => n.removeAttribute("data-pagelens-player"));
    if (el) el.setAttribute("data-pagelens-player", "1");
  };

  const looksIdle = (el) => Boolean(el.paused || el.ended) && (el.currentTime || 0) < 1;

  const pick = () => {
    const all = nodes();
    if (!all.length) return null;
    if (Number.isInteger(o.index) && all[o.index]) {
      globalThis[KEY] = o.index;
      mark(all[o.index]);
      return all[o.index];
    }
    const ranked = all.slice().sort((a, b) => score(b) - score(a));
    const best = ranked[0];
    const stored = globalThis[KEY];
    const storedEl = Number.isInteger(stored) && all[stored] ? all[stored] : null;
    const marked = all.find((el) => el.getAttribute("data-pagelens-player") === "1");
    const sticky = storedEl || marked;
    const staleSticky = Boolean(
      sticky &&
      best &&
      sticky !== best &&
      score(best) - score(sticky) > 80 &&
      looksIdle(sticky) &&
      ((!best.paused && !best.ended) || (best.currentTime || 0) > (sticky.currentTime || 0) + 2)
    );
    if (!o.fresh && sticky && !staleSticky) {
      mark(sticky);
      globalThis[KEY] = all.indexOf(sticky);
      return sticky;
    }
    globalThis[KEY] = all.indexOf(best);
    mark(best);
    return best;
  };

  const playResult = (el) => {
    if (o.fromStart && el.currentTime > 0.5) el.currentTime = 0;
    if (el.muted && !globalThis.__plSiMute) el.muted = false;
    if (o.action === "pause") {
      el.pause();
      return { ok: true, paused: true, currentTime: el.currentTime, duration: el.duration };
    }
    const play = el.play?.();
    if (play && typeof play.then === "function") {
      return play
        .then(() => ({
          ok: true,
          paused: el.paused,
          currentTime: el.currentTime,
          duration: el.duration,
        }))
        .catch((err) => ({
          ok: false,
          error: err?.message || String(err),
          paused: el.paused,
          currentTime: el.currentTime,
          duration: el.duration,
        }));
    }
    return { ok: true, paused: el.paused, currentTime: el.currentTime, duration: el.duration };
  };

  if (cmd === "list") {
    const all = nodes();
    return all.map((el, i) => snapshot(el, i, all.length));
  }
  if (cmd === "select") {
    const all = nodes();
    const i = Number(o.index);
    if (!all[i]) return { ok: false, error: "no-video", count: all.length };
    globalThis[KEY] = i;
    mark(all[i]);
    return { ok: true, video: snapshot(all[i], i, all.length), count: all.length };
  }

  const el = pick();
  if (!el) return { ok: false, error: "no-video", count: 0 };

  const all = nodes();
  const idx = all.indexOf(el);
  if (cmd === "pick" || cmd === "snapshot") {
    return { ok: true, video: snapshot(el, idx, all.length), videos: all.map((n, i) => snapshot(n, i, all.length)) };
  }
  const tapLive = (tap, node) => Boolean(tap?.el && tap.el === node && tap.el.isConnected !== false);
  const speakerOff = (tap) => Boolean(tap?.speaker && tap.speaker.gain.value === 0);
  const attachSilence = (node) => {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const src = ctx.createMediaElementSource(node);
      const speaker = ctx.createGain();
      const dest = ctx.createMediaStreamDestination();
      src.connect(speaker);
      src.connect(dest);
      speaker.connect(ctx.destination);
      speaker.gain.value = 0;
      ctx.resume?.();
      globalThis.__plAudioTap = {
        ctx,
        src,
        speaker,
        dest,
        el: node,
        prevMuted: node.muted,
        prevVolume: node.volume,
      };
    } catch (err) {
      globalThis.__plAudioTap = {
        fallback: true,
        el: node,
        prevMuted: node.muted,
        prevVolume: node.volume,
        error: String(err?.message || err),
      };
      node.muted = true;
      node.volume = 0;
    }
  };

  if (cmd === "state") {
    const tap = globalThis.__plAudioTap;
    const live = tapLive(tap, el);
    return {
      ok: true,
      currentTime: el.currentTime || 0,
      duration: Number.isFinite(el.duration) ? el.duration : 0,
      paused: Boolean(el.paused),
      ended: Boolean(el.ended),
      playbackRate: el.playbackRate || 1,
      seeking: Boolean(el.seeking),
      readyState: el.readyState || 0,
      muted: Boolean(el.muted),
      silenced: Boolean(globalThis.__plSiMute && live && (speakerOff(tap) || (tap?.fallback && el.muted))),
      index: idx,
      count: all.length,
    };
  }
  if (cmd === "control") return playResult(el);
  if (cmd === "silence") {
    globalThis.__plSiMute = true;
    const tap = globalThis.__plAudioTap;
    const live = tapLive(tap, el);
    let rebound = false;
    if (live && tap.speaker) {
      tap.speaker.gain.value = 0;
    } else if (live && tap.fallback && tap.el) {
      tap.el.muted = true;
      tap.el.volume = 0;
    } else {
      if (tap && !live) globalThis.__plAudioTap = null;
      attachSilence(el);
      rebound = Boolean(tap && !live);
    }
    return {
      ok: true,
      via: globalThis.__plAudioTap?.fallback ? "element-mute" : "webaudio",
      rebound,
      index: idx,
    };
  }
  if (cmd === "restore") {
    globalThis.__plSiMute = false;
    const tap = globalThis.__plAudioTap;
    if (tap?.speaker) tap.speaker.gain.value = 1;
    if (tap?.el) {
      tap.el.muted = Boolean(tap.prevMuted);
      if (Number.isFinite(Number(tap.prevVolume))) tap.el.volume = tap.prevVolume;
    }
    return { ok: true, index: idx };
  }
  if (cmd === "seek") {
    if (o.paused) el.pause();
    el.currentTime = Number(o.seconds) || 0;
    const play = o.paused ? null : el.play?.();
    if (play && typeof play.catch === "function") play.catch(() => {});
    return { ok: true, currentTime: el.currentTime, duration: el.duration, index: idx, count: all.length };
  }
  if (cmd === "media") {
    return {
      src: el.currentSrc || el.src || "",
      duration: Number.isFinite(el.duration) ? el.duration : null,
      live: el.duration === Infinity,
      tracks: [...el.querySelectorAll('track[src]')]
        .filter(t => !t.kind || ['subtitles', 'captions'].includes(t.kind))
        .sort((a, b) => Number(b.default) - Number(a.default))
        .map(t => t.src).filter(src => /^https?:/.test(src)),
    };
  }
  if (cmd === "tracks") {
    const fmt = (seconds) => {
      if (!Number.isFinite(seconds)) return "0:00";
      const s = Math.max(0, Math.floor(seconds));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const r = s % 60;
      if (h) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
      return `${m}:${String(r).padStart(2, "0")}`;
    };
    const cues = [];
    for (const track of el.textTracks || []) {
      const list = track.cues;
      if (!list) continue;
      for (let i = 0; i < list.length; i += 1) {
        const cue = list[i];
        const text = String(cue.text || "").replace(/\s+/g, " ").trim();
        if (text) cues.push({ start: cue.startTime, end: cue.endTime, text });
      }
    }
    if (!cues.length) {
      return {
        status: "missing",
        languages: [...(el.textTracks || [])].map((t) => t.language || t.label || ""),
        index: idx,
        count: all.length,
      };
    }
    return {
      status: "ready",
      text: cues.map((c) => `[${fmt(c.start)}] ${c.text}`).join("\n"),
      cues,
      index: idx,
      count: all.length,
    };
  }
  return { ok: false, error: "unknown-cmd" };
}

/**
 * Record audio from the picked media element via captureStream.
 * Used when tabCapture is blocked (extension not invoked on the tab).
 * cmd: start | take | stop
 */
export function plPageAudio(cmd, arg) {
  const g = globalThis;
  const o = arg && typeof arg === "object" ? arg : {};
  const pick = () =>
    document.querySelector("[data-pagelens-player]") ||
    document.querySelector("video.html5-main-video") ||
    document.querySelector("video.video-stream") ||
    [...document.querySelectorAll("video")].sort(
      (a, b) => (b.offsetWidth || 0) * (b.offsetHeight || 0) - (a.offsetWidth || 0) * (a.offsetHeight || 0),
    )[0] ||
    null;

  const startRec = (el) => {
    const tap = g.__plAudioTap;
    let stream = null;
    if (tap?.dest?.stream && tap.dest.stream.getAudioTracks?.().length) {
      stream = tap.dest.stream;
    } else {
      const cap = el.captureStream || el.mozCaptureStream;
      if (!cap) return { ok: false, error: "当前播放器不支持从画面取声。" };
      const media = cap.call(el);
      const audioTracks = media.getAudioTracks();
      if (!audioTracks.length) return { ok: false, error: "这个画面没有音轨。" };
      stream = new MediaStream(audioTracks);
    }
    if (!stream.getAudioTracks().length) return { ok: false, error: "这个画面没有音轨。" };
    const types = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
    const mime = types.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(t)) || "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    const chunks = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    rec.start(1000);
    g.__plPageAudio = { rec, chunks, stream, t0: Date.now(), mime: rec.mimeType || mime || "audio/webm" };
    if (o.fromStart && el.currentTime > 0.5) el.currentTime = 0;
    // Restarting the recorder must not restart the media. In particular,
    // play() on an ended video rewinds it to zero and corrupts the timeline.
    // Interpret holds the picture until the first Chinese audio is ready.
    if (cmd === "start" && el.paused && !el.ended && o.autoplay !== false) {
      const p = el.play?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
    return { ok: true };
  };

  const toB64 = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const s = String(reader.result || "");
        const i = s.indexOf(",");
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      reader.onerror = () => reject(new Error("读音频失败"));
      reader.readAsDataURL(blob);
    });

  if (cmd === "start") {
    const el = pick();
    if (!el) return { ok: false, error: "找不到可取声的视频。" };
    if (g.__plPageAudio?.rec && g.__plPageAudio.rec.state !== "inactive") {
      try {
        g.__plPageAudio.rec.stop();
      } catch {
        /* ignore */
      }
    }
    return startRec(el);
  }

  if (cmd === "take") {
    const sess = g.__plPageAudio;
    if (!sess?.rec) return Promise.resolve({ ok: false, error: "还没开始取声。" });
    const el = pick();
    return new Promise((resolve) => {
      const finish = async () => {
        const blob = new Blob(sess.chunks, { type: sess.mime });
        const seconds = (Date.now() - sess.t0) / 1000;
        let b64 = "";
        try {
          b64 = await toB64(blob);
        } catch {
          b64 = "";
        }
        const next = el ? startRec(el) : { ok: false };
        resolve({
          ok: true,
          b64,
          mime: sess.mime,
          seconds,
          size: blob.size,
          continued: Boolean(next.ok),
        });
      };
      if (sess.rec.state === "inactive") {
        finish();
        return;
      }
      sess.rec.onstop = finish;
      try {
        sess.rec.stop();
      } catch {
        finish();
      }
    });
  }

  if (cmd === "stop") {
    const sess = g.__plPageAudio;
    g.__plPageAudio = null;
    try {
      sess?.rec?.stop();
    } catch {
      /* ignore */
    }
    try {
      sess?.stream?.getTracks?.().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    return { ok: true };
  }
  return { ok: false, error: "unknown-cmd" };
}

/** Pure scoring for tests. Keep weights aligned with plVideo. */
export function scoreVideoInfo(v) {
  const area = (Number(v.boxW) || 0) * (Number(v.boxH) || 0);
  let s = Math.min(area / 800, 500);
  if (v.mainClass) s += 900;
  if (v.streamClass) s += 200;
  if (v.inPlayer) s += 250;
  if (v.playing) s += 320;
  if ((v.currentTime || 0) > 0.4) s += 120;
  if ((v.duration || 0) >= 8) s += 80;
  if ((v.duration || 0) >= 60) s += 70;
  if ((v.readyState || 0) >= 2) s += 40;
  if (v.hidden) s -= 700;
  if (area && area < 160 * 90) s -= 450;
  if (v.tag === "audio") s -= 60;
  return s;
}

export function pickBestVideoIndex(infos) {
  if (!infos?.length) return -1;
  let best = 0;
  let bestScore = -Infinity;
  infos.forEach((v, i) => {
    const s = scoreVideoInfo(v);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  });
  return best;
}

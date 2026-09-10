/** Runs in the page's isolated world. The visible video is the only playback
 * clock; a separate background tab supplies original audio ahead of it.
 */
export function plInterpretVideo(command, options = {}) {
  const g = globalThis;
  const key = '__plInterpretSync';
  let state = g[key];
  if (command === 'start') {
    state?.dispose?.();
    const video = document.querySelector('[data-pagelens-player]') || document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!video) return { ok: false, error: '找不到播放器' };
    state = {
      token: options.token, video, revision: 0, desiredPlaying: true,
      previousMuted: video.muted, ignoredPauses: 0, ignoredPlays: 0,
      originalSilenced: Boolean(options.originalSilenced),
      audio: null, segment: null, loaded: false, done: false, tail: false, audioFinished: false, error: '', disposed: false,
    };
    g[key] = state;
    const pauseVideo = () => {
      if (!video.paused) { state.ignoredPauses++; video.pause(); }
    };
    const pause = () => { state.audio?.pause(); pauseVideo(); };
    const play = () => {
      if (!state.desiredPlaying || !state.segment || !state.audio || state.done) return;
      if (video.paused) {
        state.ignoredPlays++;
        const pending = video.play();
        pending?.catch(err => {
          state.ignoredPlays = Math.max(0, state.ignoredPlays - 1);
          state.error = `视频播放失败：${err.message}`;
        });
      }
    };
    const clearAudio = () => {
      state.cancelLoad?.();
      state.cancelLoad = null;
      if (state.audio) {
        state.audio.pause();
        state.audio.onloadedmetadata = state.audio.onerror = state.audio.onended = null;
        state.audio.removeAttribute('src');
        state.audio.load();
        state.audio = null;
      }
      if (state.url) URL.revokeObjectURL(state.url);
      state.url = null;
      state.segment = null;
      state.loaded = false;
      state.tail = false;
      state.audioFinished = false;
    };
    const onPause = () => {
      if (state.ignoredPauses) state.ignoredPauses--;
      else if (!video.ended) {
        state.audio?.pause();
        state.desiredPlaying = false;
      }
    };
    const onPlay = () => {
      if (state.ignoredPlays) state.ignoredPlays--;
      else state.desiredPlaying = true;
      if (!state.segment || !state.loaded || state.done) pause();
    };
    const onSeek = () => {
      state.revision++;
      clearAudio();
      state.done = false;
      pause();
    };
    const tick = () => {
      if (state.disposed) return;
      const audio = state.audio, segment = state.segment;
      if (!audio || !segment) return;
      audio.volume = Number.isFinite(video.volume) ? video.volume : 1;
      audio.muted = state.originalSilenced ? video.muted : false;
      if (!state.loaded) { pause(); return; }
      if (video.currentTime >= segment.end - 0.015 || video.ended) {
        state.tail = true;
        pauseVideo();
      }
      // Video boundaries never finish speech. Only the audio ended event can
      // release this segment, including the final sentence at the video end.
      if (state.audioFinished) {
        audio.pause();
        if (state.tail) state.done = true;
        return;
      }
      if (video.seeking || !state.desiredPlaying || (!state.tail && (video.paused || video.readyState < 3))) {
        audio.pause();
        return;
      }
      if (video.currentTime < segment.start) { audio.pause(); return; }
      const ratio = audio.duration / (segment.end - segment.start);
      const rate = ratio * video.playbackRate;
      if (!Number.isFinite(rate) || rate < 0.0625 || rate > 16) {
        state.error = '当前倍速与配音时长无法匹配，请降低视频倍速。';
        pause();
        return;
      }
      // Preserve pitch while fitting the translated speech to this source span.
      audio.preservesPitch = true;
      const time = Math.max(0, Math.min(audio.duration, (video.currentTime - segment.start) * ratio));
      // Correct drift gradually. Seeking the audio clock here can skip words
      // or repeat syllables; allow any remaining speech to drain at the end.
      const correction = state.tail ? 1 : Math.max(0.9, Math.min(1.1, 1 + (time - audio.currentTime) * 0.05));
      audio.playbackRate = Math.max(0.0625, Math.min(16, rate * correction));
      if (audio.paused && !state.audioStarting) {
        state.audioStarting = true;
        audio.play().catch(err => {
          if (state.audio !== audio || state.disposed || err.name === 'AbortError') return;
          state.error = `中文配音播放失败：${err.message}`;
          pause();
        })
          .finally(() => { state.audioStarting = false; });
      }
    };
    const onWaiting = () => { if (!state.tail) state.audio?.pause(); };
    video.addEventListener('pause', onPause);
    video.addEventListener('play', onPlay);
    video.addEventListener('seeking', onSeek);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('ratechange', tick);
    video.addEventListener('volumechange', tick);
    video.addEventListener('playing', tick);
    video.addEventListener('timeupdate', tick);
    const timer = setInterval(tick, 40);
    state.pause = pause;
    state.play = play;
    state.tick = tick;
    state.clearAudio = clearAudio;
    state.dispose = () => {
      state.disposed = true;
      clearInterval(timer);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('seeking', onSeek);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('ratechange', tick);
      video.removeEventListener('volumechange', tick);
      video.removeEventListener('playing', tick);
      video.removeEventListener('timeupdate', tick);
      clearAudio();
      video.muted = state.previousMuted;
      if (state.desiredPlaying && video.paused && !video.ended) video.play()?.catch(() => {});
    };
    // The original track is already gated when possible; leave the player's
    // mute control available for the translated track during this session.
    video.muted = !state.originalSilenced;
    pause();
  }
  if (!state || state.token !== options.token) return { ok: false, error: '同步会话已结束' };
  const video = state.video;
  if (!video.isConnected) return { ok: false, error: '播放器已更换，请重新开启同传' };
  const snapshot = () => ({ ok: true, currentTime: video.currentTime, duration: video.duration,
    paused: video.paused, desiredPlaying: state.desiredPlaying, seeking: video.seeking,
    playbackRate: video.playbackRate, revision: state.revision, done: state.done, error: state.error });
  if (command === 'stop') {
    state.dispose();
    delete g[key];
    return { ok: true };
  }
  if (options.revision !== undefined && options.revision !== state.revision) return { ok: false, stale: true };
  if (command === 'hold') {
    state.pause();
    return snapshot();
  }
  if (command === 'audio') {
    if (state.segment && !state.done) return { ok: false, error: '上一段配音尚未播完，不能切换到下一段。' };
    state.pause();
    state.clearAudio();
    state.done = false;
    state.error = '';
    const revision = state.revision;
    const bytes = Uint8Array.from(atob(options.b64), c => c.charCodeAt(0));
    state.url = URL.createObjectURL(new Blob([bytes], { type: options.mime || 'audio/wav' }));
    const audio = new Audio();
    state.audio = audio;
    state.segment = { start: options.start, end: options.end };
    return new Promise(resolve => {
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        audio.onloadedmetadata = audio.onerror = null;
        state.cancelLoad = null;
        resolve(result);
      };
      const timeout = setTimeout(() => finish({ ok: false, error: '中文配音加载超时' }), 10000);
      state.cancelLoad = () => finish({ ok: false, stale: true });
      audio.onerror = () => finish({ ok: false, error: '中文配音无法解码' });
      audio.onloadedmetadata = () => {
        if (state.disposed || state.revision !== revision) { finish({ ok: false, stale: true }); return; }
        if (!(audio.duration > 0) || !Number.isFinite(audio.duration)) { finish({ ok: false, error: '中文配音时长无效' }); return; }
        if (!(options.end > options.start)) { finish({ ok: false, error: '视频分段时间无效' }); return; }
        state.loaded = true;
        finish(snapshot());
        audio.onerror = () => { state.error = '中文配音播放失败'; state.pause(); };
        audio.onended = () => { state.audioFinished = true; state.tick(); };
        // Restore playback only if the user has not paused it during buffering.
        state.play();
      };
      audio.src = state.url;
      audio.preload = 'auto';
      audio.load();
    });
  }
  return snapshot();
}

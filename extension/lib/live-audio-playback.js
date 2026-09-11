/** Follow the live player's transport without seeking within speech (which skips words).
 * Capturing the visible video is necessarily delayed; this controls additional drift.
 */
export async function playFollowingVideo({ blob, start, end, signal, readState, isStale = () => false,
  onStart = () => {}, onTiming = () => {}, tickMs = 100, createAudio = url => new Audio(url),
  align = null }) {
  const url = URL.createObjectURL(blob);
  let audio, timer, started = false;
  try {
    audio = createAudio(url);
    audio.preservesPitch = true;
    await new Promise((resolve, reject) => {
      let done = false;
      const finish = error => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        audio.pause();
        error ? reject(error) : resolve();
      };
      const abort = () => finish();
      signal?.addEventListener('abort', abort, { once: true });
      audio.onended = () => finish();
      audio.onerror = () => finish(new Error('中文配音播放失败'));
      const loadDeadline = Date.now() + 15000;
      const tick = async () => {
        if (done) return;
        try {
          if (signal?.aborted || isStale()) return finish();
          const state = await readState();
          if (done) return;
          if (signal?.aborted || isStale()) return finish();
          if (!state?.ok) throw new Error('播放器已关闭，配音已停止。');
          const aligned = typeof align === 'function'
            ? align(state, audio)
            : { action: 'show', offset: 0 };
          if (aligned?.action === 'skip') return finish();
          const transportHold = state.userPaused || state.seeking
            || (!state.ended && !state.systemHold && (state.paused || state.readyState < 3));
          if (aligned?.action === 'wait' || transportHold) {
            audio.pause();
          } else {
            const rate = Number(state.playbackRate) || 1;
            const span = Number(end) - Number(start);
            const fit = audio.duration > 0 && Number.isFinite(audio.duration) && span > 0
              ? Math.max(0.85, Math.min(1.25, audio.duration / span)) : 1;
            let targetRate = rate * fit;
            if (audio.duration > 0 && span > 0 && Number.isFinite(audio.currentTime)) {
              const mapped = Math.max(0, Math.min(audio.duration,
                (Number(state.currentTime) - Number(start)) * (audio.duration / span)));
              const correction = Math.max(0.9, Math.min(1.1, 1 + (mapped - audio.currentTime) * 0.05));
              targetRate *= correction;
            }
            audio.playbackRate = Math.max(0.25, Math.min(4, targetRate));
            if (audio.paused) {
              // Always speak the full sentence, including after resume.
              // Correct timing by rate/holding the picture, never by skipping words.
              await audio.play();
              if (done || signal?.aborted || isStale()) { audio.pause(); return finish(); }
              if (!started) {
                started = true;
                onStart();
                onTiming({ videoTime: state.currentTime, sourceStart: start, sourceEnd: end,
                  lagSeconds: Number(state.currentTime) - Number(start), playbackRate: audio.playbackRate,
                  offsetSeconds: 0 });
              }
            }
          }
          if (!started && !state.userPaused && audio.readyState === 0 && Date.now() > loadDeadline) {
            throw new Error('中文配音加载超时');
          }
          if (!done) timer = setTimeout(tick, tickMs);
        } catch (error) { finish(error); }
      };
      void tick();
    });
  } finally {
    clearTimeout(timer);
    if (audio) {
      audio.pause();
      audio.onended = audio.onerror = null;
      audio.removeAttribute?.('src');
      audio.load?.();
    }
    URL.revokeObjectURL(url);
  }
}

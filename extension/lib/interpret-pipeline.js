/** Bounded, ordered preparation -> synthesis -> buffered playback.
 * Preparation overlaps (two ASR/translation jobs); GPU synthesis is serial,
 * independently of playback. Each item carries its own audio reference.
 * flushAhead() drops queued/future work for a new generation (seek) but
 * leaves the segment that is currently playing.
 */

function linkJobController(outer) {
  const controller = new AbortController();
  if (!outer) return { controller, dispose() {} };
  if (outer.aborted) {
    controller.abort();
    return { controller, dispose() {} };
  }
  const onAbort = () => { try { controller.abort(); } catch { /* already */ } };
  outer.addEventListener('abort', onAbort);
  const dispose = () => outer.removeEventListener('abort', onAbort);
  controller.signal.addEventListener('abort', dispose, { once: true });
  return { controller, dispose };
}

export function createInterpretPipeline({ prepare, synthesize, play, signal,
  onError = () => {}, onBuffer = () => {}, capacity = 12, prebuffer = 2 }) {
  let count = 0;
  let preparing = 0;
  let closed = false;
  let cancelled = Boolean(signal?.aborted);
  let generation = 0;
  let settled = 0;
  let playingStart = null;
  let audioReady = 0;
  let synthesis = Promise.resolve();
  let jobLink = linkJobController(signal);
  const waiting = [];
  const ready = [];
  const playedStarts = new Set();
  const failedStarts = new Set();
  const startKey = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const hasAudioFor = (start) => {
    const key = startKey(start);
    if (key == null) return false;
    if (playedStarts.has(key) || playingStart === key) return true;
    return ready.some(item => startKey(item?.start) === key);
  };
  const listeners = new Set();
  const notify = () => { for (const fn of [...listeners]) fn(); };
  const wait = () => new Promise(resolve => {
    const wake = () => { listeners.delete(wake); resolve(); };
    listeners.add(wake);
  });
  const cancel = () => {
    cancelled = true;
    ready.length = 0;
    try { jobLink.controller.abort(); } catch { /* already */ }
    notify();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const release = () => { count--; notify(); };
  const report = (err) => { if (!cancelled && err?.name !== 'AbortError') onError(err); };
  const jobCtx = (job) => ({ signal: job.signal, generation: job.generation });
  const stale = (job) => cancelled || job.generation !== generation;

  function startPreparation() {
    while (!cancelled && preparing < 2 && waiting.length) {
      const job = waiting.shift();
      preparing++;
      Promise.resolve().then(() => prepare(job.item, jobCtx(job))).then(job.resolve, err => {
        report(err);
        job.resolve(null);
      }).finally(() => { preparing--; startPreparation(); });
    }
    if (cancelled) while (waiting.length) waiting.shift().resolve(null);
  }

  const playback = (async () => {
    let buffering = true;
    while (!cancelled) {
      if (closed && !ready.length) break;
      if (buffering && !closed && ready.length < prebuffer) {
        onBuffer(ready.length, prebuffer);
        await wait();
        continue;
      }
      if (!ready.length) { buffering = true; continue; }
      buffering = false;
      const item = ready.shift();
      playingStart = startKey(item?.start);
      try { await play(item); } catch (err) { report(err); }
      finally {
        if (playingStart != null) playedStarts.add(playingStart);
        playingStart = null;
        release();
      }
    }
  })();

  return {
    get pending() { return count; },
    get full() { return count >= capacity; },
    get generation() { return generation; },
    async waitForRoom() {
      // Leave headroom after pausing capture, avoiding constant pause/resume.
      while (!cancelled && count > Math.floor(capacity / 2)) await wait();
    },
    async waitUntilSettled(n = 1) {
      while (!cancelled && !closed && settled < n) {
        if (count <= 0) return false;
        await wait();
      }
      return Boolean(!cancelled && settled >= n);
    },
    hasAudio(start) { return hasAudioFor(start); },
    async waitUntilReady(n = 1) {
      while (!cancelled && !closed && audioReady < n) {
        if (count <= 0) return false;
        // Items sitting in ready[] still hold count (prebuffer). That is not in-flight work.
        if (waiting.length === 0 && preparing === 0 && count <= ready.length) {
          return audioReady >= n;
        }
        await wait();
      }
      return audioReady >= n;
    },
    async waitUntilHasAudio(start) {
      const key = startKey(start);
      while (!cancelled && !closed && !hasAudioFor(key)) {
        if (key != null && failedStarts.has(key)) return false;
        if (count <= 0) return false;
        await wait();
      }
      return hasAudioFor(key);
    },
    enqueue(item) {
      if (closed || cancelled) return false;
      if (count >= capacity) throw new Error('同传处理积压，请等待缓冲。');
      count++;
      const job = { item, generation, signal: jobLink.controller.signal };
      const prepared = new Promise(resolve => { job.resolve = resolve; waiting.push(job); });
      startPreparation();
      synthesis = synthesis.then(async () => {
        const input = await prepared;
        if (!input || stale(job)) { release(); return; }
        try {
          const output = await synthesize(input, jobCtx(job));
          if (stale(job)) { release(); return; }
          settled++;
          const key = startKey(input.start);
          if (output) { audioReady++; ready.push(output); notify(); }
          else {
            if (key != null) failedStarts.add(key);
            notify();
            release();
          }
        } catch (err) { report(err); release(); }
      });
      return true;
    },
    flushAhead() {
      generation++;
      settled = 0;
      audioReady = playingStart != null ? 1 : 0;
      failedStarts.clear();
      playedStarts.clear();
      if (playingStart != null) playedStarts.add(playingStart);
      try { jobLink.controller.abort(); } catch { /* already */ }
      jobLink.dispose();
      jobLink = linkJobController(signal);
      while (waiting.length) waiting.shift().resolve(null);
      while (ready.length) {
        ready.shift();
        release();
      }
      notify();
      return generation;
    },
    async finish() {
      // Abort must not wait for an uncooperative remote request.
      const aborted = new Promise(resolve => {
        if (cancelled) resolve();
        else {
          const wake = () => { if (cancelled) { listeners.delete(wake); resolve(); } };
          listeners.add(wake);
        }
      });
      try {
        await Promise.race([synthesis, aborted]);
        closed = true;
        notify();
        await Promise.race([playback, aborted]);
      } finally {
        signal?.removeEventListener('abort', cancel);
        jobLink.dispose();
        listeners.clear();
      }
    },
  };
}

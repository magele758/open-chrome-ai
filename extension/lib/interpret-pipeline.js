/** Bounded, ordered preparation -> synthesis -> buffered playback.
 * Preparation overlaps (two ASR jobs); semantic transformation and synthesis are ordered,
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
  transform, flush, onReset = () => {},
  onError = () => {}, onBuffer = () => {}, capacity = 12, prebuffer = 2 }) {
  capacity = Math.max(1, Number(capacity) || 12);
  prebuffer = Math.min(capacity, Math.max(1, Number(prebuffer) || 2));
  let count = 0;
  let preparing = 0;
  let closed = false;
  let cancelled = Boolean(signal?.aborted);
  let generation = 0;
  let settled = 0;
  let playingStart = null;
  let audioReady = 0;
  let draining = false;
  let buffering = true;
  let partialBuffer = false;
  let transformation = Promise.resolve();
  let synthesis = Promise.resolve();
  let committing = 0;
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
    count -= ready.length;
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

  // One ordered source item may emit zero or many semantic units. Account for
  // every output before awaiting TTS so playback cannot close on a transient 0.
  async function emitOutputs(outputs, job, holdsSlot = true) {
    const items = (Array.isArray(outputs) ? outputs : outputs ? [outputs] : []);
    count += items.length - (holdsSlot ? 1 : 0);
    notify();
    for (const input of items) {
      // A single source chunk can fan out; bound synthesized audio separately
      // from the outstanding source/semantic count used for capture backpressure.
      while (!stale(job) && ready.length >= capacity) await wait();
      if (stale(job)) { release(); continue; }
      try {
        const output = await synthesize(input, jobCtx(job));
        if (stale(job)) { release(); continue; }
        settled++;
        const key = startKey(input.start);
        if (output) { audioReady++; ready.push(output); notify(); }
        else {
          if (key != null) failedStarts.add(key);
          release();
        }
      } catch (err) { report(err); release(); }
    }
  }

  const playback = (async () => {
    while (!cancelled) {
      if (closed && !ready.length) break;
      if (buffering && !closed && ready.length < (draining || partialBuffer ? 1 : prebuffer)) {
        onBuffer(ready.length, prebuffer);
        await wait();
        continue;
      }
      if (!ready.length) { buffering = true; continue; }
      buffering = false;
      partialBuffer = false;
      const item = ready.shift();
      playingStart = startKey(item?.start);
      notify();
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
    get buffering() { return buffering; },
    releasePartialBuffer() {
      // All work settled but some slices contained no speech or failed.
      if (ready.length > 0 && count === ready.length) {
        partialBuffer = true;
        notify();
      }
    },
    get full() { return count >= capacity; },
    get generation() { return generation; },
    async waitForRoom() {
      // Leave headroom after pausing capture, avoiding constant pause/resume.
      while (!cancelled && count > Math.floor(capacity / 2)) await wait();
    },
    async waitUntilPendingAtMost(n = 1) {
      const cap = Number(n);
      const limit = Number.isFinite(cap) ? Math.max(0, cap) : 1;
      // Capture is paused here: let a short final batch drain too.
      draining = true;
      notify();
      try {
        while (!cancelled && count > limit) await wait();
      } finally { draining = false; notify(); }
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
        if (waiting.length === 0 && preparing === 0 && committing === 0 && count <= ready.length) {
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
      committing++;

      const transformTask = transformation.then(async () => {
        try {
          const input = await prepared;
          if (stale(job)) return null;
          return transform ? await transform(input, jobCtx(job)) : input;
        } catch (err) {
          report(err);
          return null;
        }
      });
      transformation = transformTask;

      synthesis = synthesis.then(async () => {
        try {
          const outputs = await transformTask;
          if (stale(job)) { release(); return; }
          if (outputs) await emitOutputs(outputs, job);
          else release();
        } catch (err) { report(err); release(); }
        finally { committing--; notify(); }
      });
      return true;
    },
    flushAhead() {
      generation++;
      onReset(generation);
      buffering = true;
      partialBuffer = false;
      settled = 0;
      audioReady = 0;
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
        if (!closed && !cancelled && flush) {
          const job = { generation, signal: jobLink.controller.signal };
          await Promise.race([(async () => {
            await transformation;
            const outputs = await flush(jobCtx(job));
            if (!stale(job)) await emitOutputs(outputs, job, false);
          })().catch(report), aborted]);
        }
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

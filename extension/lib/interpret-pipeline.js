/** Bounded, ordered preparation -> synthesis -> buffered playback.
 * Preparation overlaps (two ASR/translation jobs); GPU synthesis is serial,
 * independently of playback. Each item carries its own audio reference.
 */
export function createInterpretPipeline({ prepare, synthesize, play, signal,
  onError = () => {}, onBuffer = () => {}, capacity = 12, prebuffer = 2 }) {
  let count = 0;
  let preparing = 0;
  let closed = false;
  let cancelled = Boolean(signal?.aborted);
  let synthesis = Promise.resolve();
  const waiting = [];
  const ready = [];
  const listeners = new Set();
  const notify = () => { for (const fn of [...listeners]) fn(); };
  const wait = () => new Promise(resolve => {
    const wake = () => { listeners.delete(wake); resolve(); };
    listeners.add(wake);
  });
  const cancel = () => { cancelled = true; ready.length = 0; notify(); };
  signal?.addEventListener('abort', cancel, { once: true });
  const release = () => { count--; notify(); };
  const report = (err) => { if (!cancelled && err?.name !== 'AbortError') onError(err); };

  function startPreparation() {
    while (!cancelled && preparing < 2 && waiting.length) {
      const job = waiting.shift();
      preparing++;
      Promise.resolve().then(() => prepare(job.item)).then(job.resolve, err => {
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
      try { await play(item); } catch (err) { report(err); }
      finally { release(); }
    }
  })();

  return {
    get pending() { return count; },
    get full() { return count >= capacity; },
    async waitForRoom() {
      // Leave headroom after pausing capture, avoiding constant pause/resume.
      while (!cancelled && count > Math.floor(capacity / 2)) await wait();
    },
    enqueue(item) {
      if (closed || cancelled) return false;
      if (count >= capacity) throw new Error('同传处理积压，请等待缓冲。');
      count++;
      const prepared = new Promise(resolve => waiting.push({ item, resolve }));
      startPreparation();
      synthesis = synthesis.then(async () => {
        const input = await prepared;
        if (!input || cancelled) { release(); return; }
        try {
          const output = await synthesize(input);
          if (output && !cancelled) { ready.push(output); notify(); }
          else release();
        } catch (err) { report(err); release(); }
      });
      return true;
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
        listeners.clear();
      }
    },
  };
}

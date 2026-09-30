import { withInterpretDeadline } from './interpret-semantic.js';

export function isTransientInterpretError(error) {
  if (error?.name === 'AbortError') return false;
  const message = String(error?.message || '');
  const status = Number(error?.status) || Number(message.match(/\b([45]\d\d)\b/)?.[1]);
  if (status) return [408, 429, 500, 502, 503, 504].includes(status);
  return error?.name === 'TimeoutError' || /failed to fetch|fetch failed|network|load failed|connection|socket|terminated|超时|连接中断/i.test(message);
}

function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

// Retry only the failed request, keeping previously translated batches and audio.
export async function retryInterpretRequest(operation, { signal, onRetry = () => {},
  attempts = 3, delayMs = 800, timeoutMs = 90000, stage, trace } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    signal?.throwIfAborted();
    try {
      return await withInterpretDeadline(operation, signal, timeoutMs, { stage, trace });
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt === attempts || !isTransientInterpretError(error)) throw error;
      onRetry({ attempt, attempts, error });
      await waitForRetry(delayMs * 2 ** (attempt - 1), signal);
    }
  }
}

// A provider that answers in 3-8 s occasionally holds one request for 30 s+.
// After delayMs a second identical request races the first; whichever succeeds
// first wins and the other is aborted. A fast failure before the hedge is
// returned immediately so the retry layer keeps its normal behaviour.
export function hedgeInterpretRequest(operation, { signal, delayMs = 15000, onHedge = () => {} } = {}) {
  if (!Number.isFinite(delayMs)) return operation(signal);
  return new Promise((resolve, reject) => {
    const runs = [];
    let settled = false, failures = 0, timer;
    const cancelRuns = () => { for (const run of runs) run.abort(); };
    const onAbort = () => finish(reject, signal.reason);
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      cancelRuns();
      settle(value);
    };
    const launch = () => {
      const controller = new AbortController();
      runs.push(controller);
      Promise.resolve().then(() => operation(controller.signal)).then(
        value => finish(resolve, value),
        error => { if (!settled && ++failures === runs.length) finish(reject, error); },
      );
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return finish(reject, signal.reason);
    launch();
    timer = setTimeout(() => { if (!settled) { onHedge(); launch(); } }, delayMs);
  });
}

import { debugId, debugLog } from "./debug-log.js";
import { formatTranscript, transcribeAudio } from './asr.js';
import { execNativeShell, pingNativeHost } from './native-host.js';
import { isAsrReady } from './storage.js';

export const MEDIA_HELPER = 'http://127.0.0.1:18789';
export const MEDIA_HELPER_CONDA_ENV = 'pagelens-media';
export const MEDIA_HELPER_ENSURE_SHELL = [
  `conda run -n ${MEDIA_HELPER_CONDA_ENV} --no-capture-output python tools/media_helper.py --ensure`,
  '|| python3 tools/media_helper.py --ensure',
].join(' ');

const LOOPBACK_FETCH = (() => {
  try {
    new Request('http://127.0.0.1/', { targetAddressSpace: 'loopback' });
    return true;
  } catch {
    return false;
  }
})();

export function helperRequestInit(options = {}) {
  return LOOPBACK_FETCH ? { ...options, targetAddressSpace: 'loopback' } : { ...options };
}

export function mediaHelperStartHint() {
  return [
    '完整媒体服务未启动或浏览器无法连接 127.0.0.1:18789。不会改为跟随播放录音。',
    `请在仓库根目录执行：conda run -n ${MEDIA_HELPER_CONDA_ENV} python tools/media_helper.py --ensure`,
    `若尚未建环境：conda create -n ${MEDIA_HELPER_CONDA_ENV} -c conda-forge python=3.12 ffmpeg yt-dlp -y`,
    '若本机服务已在跑：chrome://extensions → PageLens → 详细信息 → 网站设置，将「本地网络」设为允许。',
  ].join('\n');
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

async function wait(signal, ms = 750) {
  checkAbort(signal);
  await new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function probeMediaHelper({ fetchImpl = fetch, origin = MEDIA_HELPER } = {}) {
  try {
    const response = await fetchImpl(origin + '/health', helperRequestInit({ method: 'GET', signal: AbortSignal.timeout(1500) }));
    if (!response.ok) return { ok: false };
    const data = await response.json().catch(() => ({}));
    if (data?.service && data.service !== 'pagelens-media') return { ok: false, data };
    return { ok: true, data };
  } catch {
    return { ok: false };
  }
}

async function defaultStartMediaHelper() {
  const ping = await pingNativeHost();
  const cwd = ping.ok && ping.repoRoot;
  if (!cwd) return { ok: false, started: false, reason: ping.error || 'no-repo' };
  const result = await execNativeShell({
    command: MEDIA_HELPER_ENSURE_SHELL,
    cwd,
    timeoutMs: 25000,
  });
  return { ok: Boolean(result?.ok && result.code === 0), started: true, result };
}

export async function ensureMediaHelper({ fetchImpl = fetch, startImpl, signal, onProgress } = {}) {
  if ((await probeMediaHelper({ fetchImpl })).ok) return { ok: true, started: false };
  onProgress?.({ status: 'extracting', hint: '正在启动本机媒体服务' });
  if (startImpl) await startImpl();
  else {
    const launched = await defaultStartMediaHelper();
    if (!launched.ok) return { ok: false, started: false };
  }
  for (const ms of [200, 400, 800]) {
    checkAbort(signal);
    await wait(signal, ms);
    if ((await probeMediaHelper({ fetchImpl })).ok) return { ok: true, started: true };
  }
  return { ok: false, started: true };
}

function helperDownError(error) {
  return error instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(String(error?.message || error || ''));
}

// Never captures or plays the tab. Every returned ASR cue comes from a downloaded full audio file.
export async function acquireFullTranscript({ url, mediaUrl, asr, signal, onProgress, fetchImpl = fetch, startImpl } = {}) {
  let id;
  const runId = debugId("full-audio");
  debugLog("transcript.start", { runId, url, source: "downloaded-audio", directMedia: Boolean(mediaUrl) });
  const request = async (path, options = {}) => {
    checkAbort(signal);
    const response = await fetchImpl(MEDIA_HELPER + path, helperRequestInit({ ...options, signal }));
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `媒体服务错误 ${response.status}`);
    return response;
  };
  const createJob = async () => request('/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, mediaUrl }),
  });
  try {
    onProgress?.({ status: 'extracting', hint: '正在获取完整音轨' });
    let response;
    try {
      response = await createJob();
    } catch (error) {
      checkAbort(signal);
      if (!helperDownError(error)) throw error;
      debugLog('transcript.helper-down', { runId, error });
      const ready = await ensureMediaHelper({ fetchImpl, startImpl, signal, onProgress });
      if (!ready.ok) throw new Error(mediaHelperStartHint());
      try {
        response = await createJob();
      } catch (retryError) {
        checkAbort(signal);
        if (helperDownError(retryError)) throw new Error(mediaHelperStartHint());
        throw retryError;
      }
    }
    id = (await response.json()).id;
    if (!id || !/^[a-f0-9]{32}$/.test(id)) throw new Error('媒体服务返回了无效任务。');
    let job;
    let lastStatus;
    for (;;) {
      checkAbort(signal);
      job = await (await request(`/jobs/${id}`)).json();
      if (job.status !== lastStatus) {
        debugLog('transcript.status', { runId, jobId: id, status: job.status, duration: job.duration, parts: job.parts?.length });
        lastStatus = job.status;
      }
      if (job.status === 'error') throw new Error(job.error || '完整音轨提取失败');
      if (job.status === 'ready') break;
      const hint = { extracting: '正在寻找完整音轨', downloading: '正在下载完整音轨', splitting: '正在准备音轨分段' }[job.status];
      onProgress?.({ status: 'extracting', hint });
      await wait(signal);
    }
    if (!isAsrReady(asr)) throw new Error('已找到完整音轨，请在设置中配置 ASR 后重新提取。');
    if (!job.parts?.length || !(job.duration > 0)) throw new Error('没有取得完整音轨。');
    let covered = 0;
    for (const part of job.parts) {
      if (Math.abs(part.start - covered) > .1 || !(part.duration > 0)) throw new Error('音轨分段存在缺口，已停止。');
      covered += part.duration;
    }
    if (Math.abs(covered - job.duration) > Math.max(1, job.duration * .001)) throw new Error('音轨覆盖不完整，已停止。');
    const cues = [];
    for (const [index, part] of job.parts.entries()) {
      checkAbort(signal);
      onProgress?.({ status: 'uploading', hint: `正在转写完整音轨 ${index + 1}/${job.parts.length}`, currentTime: part.start, duration: job.duration });
      const blob = await (await request(`/jobs/${id}/audio/${part.index}`)).blob();
      const segments = await transcribeAudio(asr, blob, { filename: `part-${index}.wav`, signal, allowEmpty: true, trace: { runId, chunk: index + 1, start: part.start, seconds: part.duration } });
      cues.push(...formatTranscript(segments, part.start).cues);
    }
    checkAbort(signal);
    const formatted = formatTranscript(cues);
    if (formatted.status !== 'ready') throw new Error('完整音轨中未识别到语音。');
    return { ...formatted, complete: true, duration: job.duration, source: 'asr-full' };
  } catch (error) {
    debugLog("transcript.error", { runId, jobId: id, error });
    throw error;
  } finally {
    debugLog("transcript.end", { runId, jobId: id, cancelled: signal?.aborted === true });
    // Cleanup uses a fresh signal so user cancellation also cancels the downloader.
    if (id) await fetchImpl(`${MEDIA_HELPER}/jobs/${id}`, helperRequestInit({ method: 'DELETE', signal: AbortSignal.timeout(5000) })).catch(() => {});
  }
}

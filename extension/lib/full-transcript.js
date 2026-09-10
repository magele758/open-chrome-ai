import { formatTranscript, transcribeAudio } from './asr.js';
import { isAsrReady } from './storage.js';
import { parseVtt } from './library.js';

const HELPER = 'http://127.0.0.1:18789';

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

async function wait(signal) {
  checkAbort(signal);
  await new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, 750);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function subtitleCues(subtitle) {
  if (subtitle?.format === 'vtt') return parseVtt(subtitle.body);
  if (subtitle?.format === 'json3') {
    return (JSON.parse(subtitle.body).events || []).filter(e => e.segs).map(e => ({
      start: (e.tStartMs || 0) / 1000,
      end: ((e.tStartMs || 0) + (e.dDurationMs || 0)) / 1000,
      text: e.segs.map(s => s.utf8 || '').join('').trim(),
    })).filter(c => c.text);
  }
  return [];
}

// Never captures or plays the tab. Every returned ASR cue comes from a downloaded full audio file.
export async function acquireFullTranscript({ url, mediaUrl, asr, signal, onProgress, fetchImpl = fetch }) {
  let id;
  const request = async (path, options = {}) => {
    checkAbort(signal);
    const response = await fetchImpl(HELPER + path, { ...options, signal });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `媒体服务错误 ${response.status}`);
    return response;
  };
  try {
    onProgress?.({ status: 'extracting', hint: '正在获取完整字幕或音轨' });
    try {
      const response = await request('/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, mediaUrl }),
      });
      id = (await response.json()).id;
    } catch (error) {
      checkAbort(signal);
      if (error instanceof TypeError) throw new Error('完整媒体服务未启动。请运行 tools/media_helper.py 后重试；不会改为跟随播放录音。');
      throw error;
    }
    if (!id || !/^[a-f0-9]{32}$/.test(id)) throw new Error('媒体服务返回了无效任务。');
    let job;
    for (;;) {
      checkAbort(signal);
      job = await (await request(`/jobs/${id}`)).json();
      if (job.status === 'error') throw new Error(job.error || '完整音轨提取失败');
      if (job.status === 'ready') break;
      const hint = { extracting: '正在寻找完整字幕或音轨', downloading: '正在下载完整音轨', splitting: '正在准备音轨分段' }[job.status];
      onProgress?.({ status: 'extracting', hint });
      await wait(signal);
    }
    if (job.subtitle) {
      const formatted = formatTranscript(subtitleCues(job.subtitle));
      if (formatted.status !== 'ready') throw new Error('站点字幕为空或格式不可读，请更新媒体提取工具后重试。');
      return { ...formatted, complete: true, duration: job.duration, source: 'downloaded-subtitles' };
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
      const segments = await transcribeAudio(asr, blob, { filename: `part-${index}.wav`, signal, allowEmpty: true });
      cues.push(...formatTranscript(segments, part.start).cues);
    }
    checkAbort(signal);
    const formatted = formatTranscript(cues);
    if (formatted.status !== 'ready') throw new Error('完整音轨中未识别到语音。');
    return { ...formatted, complete: true, duration: job.duration, source: 'asr-full' };
  } finally {
    // Cleanup uses a fresh signal so user cancellation also cancels the downloader.
    if (id) await fetchImpl(`${HELPER}/jobs/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) }).catch(() => {});
  }
}

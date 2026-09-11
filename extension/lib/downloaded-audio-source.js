import { MEDIA_HELPER, ensureMediaHelper, helperRequestInit, mediaHelperStartHint } from './full-transcript.js';

export function readPcmWav(buffer) {
  const v = new DataView(buffer);
  const tag = i => String.fromCharCode(...new Uint8Array(buffer, i, 4));
  if (buffer.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('音轨格式无效');
  let pcm;
  let valid = false;
  for (let i = 12; i + 8 <= buffer.byteLength;) {
    const size = v.getUint32(i + 4, true), end = i + 8 + size;
    if (end > buffer.byteLength) throw new Error('音轨文件不完整');
    if (tag(i) === 'fmt ') valid = size >= 16 && v.getUint16(i + 8, true) === 1 && v.getUint16(i + 10, true) === 1 && v.getUint32(i + 12, true) === 16000 && v.getUint16(i + 22, true) === 16;
    if (tag(i) === 'data') pcm = new Uint8Array(buffer, i + 8, size);
    i = end + (size % 2);
  }
  if (!valid || !pcm) throw new Error('需要 16kHz 单声道 PCM 音轨');
  return pcm;
}
export function pcmWav(pieces) {
  const size = pieces.reduce((n, p) => n + p.length, 0);
  const buf = new ArrayBuffer(44 + size), v = new DataView(buf), bytes = new Uint8Array(buf);
  const tag = (i, s) => [...s].forEach((c, n) => v.setUint8(i + n, c.charCodeAt(0)));
  tag(0, 'RIFF'); v.setUint32(4, size + 36, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, size, true);
  let offset = 44; for (const p of pieces) { bytes.set(p, offset); offset += p.length; }
  return new Blob([buf], { type: 'audio/wav' });
}

// Independent audio source: no tab recording, player play(), or browser cookies.
export async function openInterpretSource({ url, mediaUrl, signal, onProgress = () => {}, fetchImpl = fetch }) {
  let id;
  const request = async (path, options = {}) => {
    signal?.throwIfAborted();
    const r = await fetchImpl(MEDIA_HELPER + path, helperRequestInit({ ...options, signal }));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `媒体服务错误 ${r.status}`);
    return r;
  };
  const close = async () => {
    if (id) await fetchImpl(`${MEDIA_HELPER}/jobs/${id}`, helperRequestInit({ method: 'DELETE', signal: AbortSignal.timeout(5000) })).catch(() => {});
  };
  try {
    if (!(await ensureMediaHelper({ fetchImpl, signal, onProgress })).ok) throw new Error(mediaHelperStartHint());
    id = (await (await request('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, mediaUrl }) })).json()).id;
    if (!/^[a-f0-9]{32}$/.test(id || '')) { id = null; throw new Error('媒体服务返回无效任务'); }
    let job;
    for (;;) {
      job = await (await request(`/jobs/${id}`)).json();
      if (job.status === 'error') throw new Error(job.error || '音轨下载失败');
      if (job.status === 'ready') break;
      onProgress({ hint: '正在下载独立音轨，播放器保持暂停…' });
      await new Promise((resolve, reject) => {
        const stop = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, 500);
        signal?.addEventListener('abort', stop, { once: true });
      });
    }
    if (!job.parts?.length || !(job.duration > 0)) throw new Error('未取得可用音轨');
    let covered = 0;
    for (const p of job.parts) {
      if (Math.abs(p.start - covered) > .1 || !(p.duration > 0)) throw new Error('音轨分段不连续');
      covered += p.duration;
    }
    if (Math.abs(covered - job.duration) > 1) throw new Error('音轨不完整');
    const cache = new Map();
    return {
      duration: job.duration, close,
      async slice(start, seconds = 5) {
        signal?.throwIfAborted();
        const end = Math.min(job.duration, start + seconds), pieces = [];
        if (!(end > start)) return null;
        for (const p of job.parts) {
          if (p.start >= end || p.start + p.duration <= start) continue;
          if (!cache.has(p.index)) {
            const pcm = readPcmWav(await (await request(`/jobs/${id}/audio/${p.index}`)).arrayBuffer());
            cache.set(p.index, pcm);
            while (cache.size > 2) cache.delete(cache.keys().next().value);
          }
          const pcm = cache.get(p.index);
          const from = Math.round(Math.max(0, start - p.start) * 16000) * 2;
          const to = Math.min(pcm.length, Math.round(Math.min(p.duration, end - p.start) * 16000) * 2);
          pieces.push(pcm.subarray(from, to));
        }
        const blob = pcmWav(pieces);
        return { blob, mime: 'audio/wav', start, end, seconds: (blob.size - 44) / 32000 };
      },
    };
  } catch (error) { await close(); throw error; }
}

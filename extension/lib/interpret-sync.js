import { inject, injectVideo, sleep } from './chrome.js';
import { plInterpretVideo } from './interpret-video.js';
import { createInterpretSource } from './interpret-source.js';
import { createInterpretPipeline } from './interpret-pipeline.js';
import { recordPageSlice } from './tab-audio.js';
import { blobToWav, synthesizeTts } from './tts.js';
import { transcribeAudio, filenameForMime, silentWav } from './asr.js';
import { playbackRateOf, recordSecondsForRate, stripTimeline, videoSliceBounds } from './interpret.js';

async function base64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}

export async function runSynchronizedInterpret({ tabId, settings, cues, signal, onEvent, translate, chunkSeconds = 5 }) {
  const token = crypto.randomUUID();
  const sync = (cmd, arg = {}) => inject(tabId, plInterpretVideo, [cmd, { token, ...arg }]);
  const mode = cues.length ? 'captions' : 'audio';
  const lines = [];
  let source;
  const emit = event => { if (!signal?.aborted) { try { onEvent?.(event); } catch { /* UI */ } } };
  const status = (message, clearLine = false) => emit({ type: 'status', mode, message, hint: message, clearLine });
  await injectVideo(tabId, 'pick');
  const silenced = await injectVideo(tabId, 'silence');
  let position;
  try {
    position = await sync('start', { originalSilenced: silenced?.via === 'webaudio' });
    if (!position?.ok) throw new Error(position?.error || '无法启动视频同步');
    signal?.throwIfAborted();
    if (!Number.isFinite(position.duration) || position.duration <= 0) throw new Error('同步配音需要可定位进度的点播视频。');
    if (position.currentTime >= position.duration - 0.03) return { mode, lines };
    status('正在准备后台取声，画面等待中文配音…');
    source = await createInterpretSource(tabId, position.currentTime, signal);
    // Every seek is a new generation: all old ASR/TTS/playback work is cancelled.
    while (!signal?.aborted) {
      position = await sync('state');
      if (!position?.ok) throw new Error(position?.error || '播放器已关闭');
      const revision = position.revision;
      const epoch = new AbortController();
      const epochSignal = epoch.signal;
      const stop = () => epoch.abort();
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      let nextPosition = null;
      let failure = null;
      const fail = error => { if (!epochSignal.aborted) { failure = error; epoch.abort(); } };
      const monitor = (async () => {
        while (!epochSignal.aborted) {
          const state = await sync('state');
          if (!state?.ok || state.error) { fail(new Error(state?.error || '播放器已关闭')); break; }
          if (state.revision !== revision) { nextPosition = state; epoch.abort(); break; }
          await sleep(80);
        }
      })().catch(fail);
      const pipeline = createInterpretPipeline({
        signal: epochSignal,
        onError: fail,
        onBuffer: (ready, target) => status(`音画同步缓冲 ${ready}/${target} 段，画面等待中…`),
        prepare: async item => {
          const [original, referenceBlob] = await Promise.all([
            item.src !== undefined ? stripTimeline(item.src) : transcribeAudio(settings.asr, item.blob, {
              filename: filenameForMime(item.mime), signal: epochSignal,
            }).then(segments => stripTimeline(segments.map(s => s.text || '').join(' '))),
            blobToWav(item.blob),
          ]);
          epochSignal.throwIfAborted();
          const src = stripTimeline(original);
          const zh = src ? stripTimeline(await translate(src, epochSignal)) : '';
          return { start: item.start, end: item.end, src, zh, referenceBlob };
        },
        synthesize: async item => {
          epochSignal.throwIfAborted();
          const { referenceBlob, ...line } = item;
          const spoken = stripTimeline(item.zh);
          const blob = spoken ? (await synthesizeTts(settings.tts, spoken, {
            referenceBlob, signal: epochSignal, lang: settings.tts.lang || 'ZH',
          })).blob : silentWav(item.end - item.start, 16000);
          return { ...line, blob };
        },
        play: async item => {
          epochSignal.throwIfAborted();
          const b64 = await base64(item.blob);
          epochSignal.throwIfAborted();
          const loaded = await sync('audio', { revision, start: item.start, end: item.end, b64, mime: item.blob.type });
          if (loaded?.stale) { epoch.abort(); return; }
          if (!loaded?.ok) throw new Error(loaded?.error || '无法播放中文配音');
          epochSignal.throwIfAborted();
          if (item.zh) {
            const line = { start: item.start, end: item.end, src: item.src, zh: item.zh };
            lines.push(line);
            emit({ type: 'line', ...line, mode });
          }
          status('中文配音与画面同步 · 暂停、拖动、倍速均跟随视频');
          while (!epochSignal.aborted) {
            const state = await sync('state');
            if (state?.revision !== revision) { nextPosition = state; epoch.abort(); return; }
            if (!state?.ok || state.error) throw new Error(state?.error || '播放器已关闭');
            if (state.done) return;
            await sleep(60);
          }
        },
      });
      try {
        await sync('hold', { revision });
        await source.seek(position.currentTime, epochSignal);
        epochSignal.throwIfAborted();
        const played = await injectVideo(source.tabId, 'control', { action: 'play' });
        if (!played?.ok || played.paused) throw new Error('后台视频无法自动播放，请在后台取声标签页允许播放后重试。');
        let first = true;
        const usedCues = new Set();
        while (!epochSignal.aborted) {
          if (pipeline.full) {
            await injectVideo(source.tabId, 'control', { action: 'pause' });
            await pipeline.waitForRoom();
            epochSignal.throwIfAborted();
            // Clear recorder silence accumulated while the source was paused.
            await source.seek((await injectVideo(source.tabId, 'state')).currentTime, epochSignal);
            await injectVideo(source.tabId, 'control', { action: 'play' });
          }
          const before = await injectVideo(source.tabId, 'state');
          if (!before?.ok) throw new Error('后台取声标签页已关闭');
          if (before.ended || before.currentTime >= before.duration - 0.03) break;
          const remaining = before.duration - before.currentTime;
          const rate = playbackRateOf(before);
          const recSec = Math.min(recordSecondsForRate(chunkSeconds, rate), Math.max(0.8, remaining / rate));
          const slice = await recordPageSlice(source.tabId, recSec, epochSignal);
          epochSignal.throwIfAborted();
          const after = await injectVideo(source.tabId, 'state');
          if (!after?.ok) throw new Error('后台取声标签页已关闭');
          if (after.currentTime <= before.currentTime + 0.02) throw new Error('后台视频播放停滞，请检查视频是否正常加载。');
          const item = {
            ...slice,
            ...videoSliceBounds({
              start: before.currentTime,
              afterTime: after.currentTime,
              wallSeconds: slice.seconds,
              rate: playbackRateOf(after, rate),
            }),
          };
          if (cues.length) {
            const selected = cues.filter((c, index) => {
              // Recorder delivery can run a few milliseconds past a boundary.
              // Assign normal cues by their midpoint, not by the first word
              // that barely overlaps the end of the previous audio slice.
              const anchor = c.end - c.start > chunkSeconds * 2 ? c.start : (c.start + c.end) / 2;
              if (usedCues.has(index) || c.start >= item.end) return false;
              if (anchor >= item.end && !after.ended) return false;
              if (anchor < item.start && !(first && c.end > item.start)) return false;
              usedCues.add(index);
              return true;
            });
            item.src = selected.map(c => c.text).join(' ').trim();
          }
          first = false;
          pipeline.enqueue(item);
          if (after.ended) break;
        }
        await pipeline.finish();
      } catch (error) {
        if (!epochSignal.aborted) failure = error;
      } finally {
        epoch.abort();
        await pipeline.finish();
        await monitor;
        signal?.removeEventListener('abort', stop);
        await sync('hold', { revision }).catch(() => {});
      }
      if (failure) throw failure;
      if (signal?.aborted) break;
      if (!nextPosition) {
        const latest = await sync('state');
        if (latest?.revision !== revision) nextPosition = latest;
      }
      if (!nextPosition) break;
      status('已跳转，正在为新位置准备同步配音…', true);
    }
    return { mode, lines: lines.sort((a, b) => a.start - b.start) };
  } finally {
    await source?.close();
    await sync('stop').catch(() => {});
    await injectVideo(tabId, 'restore').catch(() => {});
  }
}

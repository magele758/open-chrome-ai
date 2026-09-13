import { injectVideo, sleep } from './chrome.js';
import { openInterpretSource } from './downloaded-audio-source.js';
import { transcribeInterpretSlice } from './interpret-asr.js';
import { completeChat } from './openai.js';
import { isAsrReady, isTtsReady, resolveModel } from './storage.js';
import { synthesizeTts, getTtsRef } from './tts.js';
import { linesToCaptions, stripTimeline, voiceRefFromBlob } from './interpret.js';
import { withInterpretDeadline } from './interpret-semantic.js';
import { validateAnalysis, recognitionWindows, translationBatches, validateDubTranslation, fitDub, continuousReadySeconds, voiceCandidates } from './dub-timeline.js';
import { dubKey, readDubCache, writeDubCache, pruneDubCache } from './dub-cache.js';

const modelIdentity = model => ({ baseUrl: model?.baseUrl, model: model?.model, language: model?.language, preset: model?.preset });
const parseJson = text => JSON.parse(String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim());

export async function prepareDubPlan({ source, settings, signal, status = () => {},
  transcribe = transcribeInterpretSlice, chat = completeChat, cacheGet = readDubCache, cacheSet = writeDubCache, incrementalContext }) {
  status('正在分析说话人、停顿与音乐，画面保持暂停…');
  const analysis = await source.analyze();
  const spans = validateAnalysis(analysis, source.duration);
  const sourceKey = analysis.fingerprint || await dubKey({ analysis, url: source.url });
  const recognitionKey = await dubKey({ sourceKey, spans, analysisVersion: analysis.version, asr: modelIdentity(settings.asr), version: 3 });
  let cues = await cacheGet(recognitionKey);
  if (!cues) {
    const windows = recognitionWindows(spans);
    const results = new Array(windows.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(2, windows.length) }, async () => {
      while (next < windows.length) {
        const i = next++, window = windows[i];
        signal.throwIfAborted();
        status(`正在转写完整原稿 ${i + 1}/${windows.length}，画面保持暂停…`);
        const key = await dubKey({ recognitionKey, start: window.start, end: window.end });
        let segments = await cacheGet(key);
        if (!segments) {
          const slice = await source.slice(window.start, window.end - window.start);
          if (!slice) throw new Error('原音轨切片缺失');
          segments = await transcribe(settings.asr, slice, { signal });
          signal.throwIfAborted();
          if (!segments.length && window.kind === 'speech') throw new Error(`检测到人声但未识别到文字：${window.start.toFixed(1)}–${window.end.toFixed(1)} 秒。请重试，已完成内容会保留。`);
          await cacheSet(key, segments);
        }
        results[i] = segments.map((s, n) => {
          const span = window.end - window.start;
          const start = window.start + Math.max(0, Math.min(span, Number(s.start) || 0));
          const end = window.start + Math.max(0, Math.min(span, Number.isFinite(s.end) ? s.end : Number(segments[n + 1]?.start) || span));
          return { id: `${i}:${n}`, start, end: Math.max(start, end), src: stripTimeline(s.text),
            speaker: window.speaker || (s.speaker ? `asr:${i}:${s.speaker}` : `unassigned:${i}:${n}`), overlap: window.overlap, timingQuality: Number.isFinite(s.end) ? 'segment' : 'estimated' };
        }).filter(c => c.src && c.end > c.start);
      }
    }));
    cues = results.flat();
    await cacheSet(recognitionKey, cues);
  }
  const model = resolveModel(settings, 'text');
  const translationKey = await dubKey({ recognitionKey, cues, model: modelIdentity(model), incrementalContext, version: 2 });
  const cached = await cacheGet(translationKey);
  if (cached) return { ...cached, spans, sourceKey, background: analysis.background };
  if (!cues.length) return { lines: [], cues, context: '', spans, sourceKey, background: analysis.background };
  const ask = (system, input, maxTokens = 5000) => withInterpretDeadline(s => chat(model, {
    messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }],
    signal: s, temperature: .1, maxTokens, rejectTruncated: true,
  }), signal, 90000);
  const batches = translationBatches(cues);
  status('正在阅读全文并统一人物、术语与指代…');
  let summaries = [];
  for (const batch of incrementalContext === undefined ? batches : []) {
    summaries.push(await ask('请为后续忠实翻译整理本段主题、人物指代、术语及数字条件。只输出简洁的上下文笔记，不超过500字，不创作内容。', batch, 1200));
  }
  // Hierarchical reduction bounds long-video context without throwing away chapters.
  while (summaries.join('\n').length > 10000) {
    const reduced = [];
    for (let i = 0; i < summaries.length; i += 8) reduced.push(await ask('合并这些按源顺序排列的上下文笔记，保留主题、指代及术语。用不超过800字输出。', summaries.slice(i, i + 8), 1800));
    if (reduced.join('\n').length >= summaries.join('\n').length) throw new Error('全文上下文压缩失败，请重试');
    summaries = reduced;
  }
  const context = incrementalContext ?? summaries.join('\n');
  const lines = [];
  for (const [i, batch] of batches.entries()) {
    signal.throwIfAborted();
    status(`正在生成中文口播稿 ${i + 1}/${batches.length}…`);
    const key = await dubKey({ translationKey, batch });
    let translated = await cacheGet(key);
    if (!translated) {
      const system = '将当前对话完整忠实翻译为自然的简体中文口播稿。上下文仅供理解，不能重复翻译。保留全部事实、数字、否定、条件、不确定性，不做摘要。每条原文id必须按顺序恰好出现一次。每条原文单独输出一条中文，ids数组只能含该条原文的一个id；禁止合并句段。speaker只是分段标识，不能根据内容推测它们是同一个人。每段中文不超过500字，覆盖原音频不超过30秒，不得合并间隔超过0.35秒的原文句段。返回JSON {"lines":[{"ids":["原文id"],"zh":"中文"}]}，只翻译current中的内容。';
      const translateGroup = async (current, before, after) => {
        const groupKey = await dubKey({ translationKey, current, before, after, recovery: 1 });
        const saved = await cacheGet(groupKey);
        if (saved) return saved;
        let lastError;
        for (let attempt = 0; attempt < 2; attempt++) {
          // Service/authentication errors are not formatting errors: never fan them out.
          const response = await ask(system, { context, before, current, after, correction: lastError?.message });
          try {
            const result = validateDubTranslation(parseJson(response), current);
            await cacheSet(groupKey, result);
            return result;
          } catch (error) { signal.throwIfAborted(); lastError = error; }
        }
        if (current.length === 1) throw lastError;
        status('正在按原句重新整理译文，保留各自音色…');
        const result = [];
        // A malformed merge cannot be split by guessing which Chinese words belong to whom.
        // Re-translate each original cue with its neighboring context and immutable timing.
        for (let n = 0; n < current.length; n++) {
          signal.throwIfAborted();
          result.push(...await translateGroup([current[n]], [...(before || []), ...current.slice(0, n)].slice(-2), [...current.slice(n + 1), ...(after || [])].slice(0, 2)));
        }
        return result;
      };
      translated = await translateGroup(batch, batches[i - 1]?.slice(-2), batches[i + 1]?.slice(0, 2));
      await cacheSet(key, translated);
    }
    lines.push(...translated);
  }
  const result = { lines, cues, context };
  await cacheSet(translationKey, result);
  return { ...result, spans, sourceKey, background: analysis.background };
}

export async function audioDuration(blob) {
  const context = new AudioContext();
  try { return (await context.decodeAudioData(await blob.arrayBuffer())).duration; }
  finally { await context.close(); }
}

/** All expensive work is cached independently from playback and seeking. */
export async function runPlannedInterpret(opts) {
  const { tabId, settings } = opts;
  if (!isAsrReady(settings.asr)) throw new Error('请先配置语音识别。');
  const controller = new AbortController(), signal = controller.signal;
  const stop = () => controller.abort();
  opts.signal?.addEventListener('abort', stop, { once: true });
  if (opts.signal?.aborted) stop();
  const video = opts.video || ((cmd, arg) => injectVideo(tabId, cmd, arg));
  const emit = event => { if (!signal.aborted) { try { opts.onEvent?.({ mode: 'audio', ...event }); } catch { /* UI callback */ } } };
  const status = message => emit({ type: 'status', message, hint: message });
  const cacheGet = opts.cacheGet || readDubCache, cacheSet = opts.cacheSet || writeDubCache;
  let source, held = false, muted = false, active = null, activeUrl = null;
  let background = null, backgroundUrl = null, backgroundStart = 0;
  let production = Promise.resolve(), planning = Promise.resolve(), productionError, watching = false;
  const completed = new Set(), ready = new Map();
  let revision, currentIndex = 0, shown = null;
  let playhead = Number(opts.startAt) || 0;
  let plan, preparing = true, preparationMonitor = Promise.resolve();
  const ttsOn = isTtsReady(settings.tts);
  const read = async () => { const s = await video('state'); if (!s?.ok) throw new Error('播放器已关闭'); return s; };
  const hold = async () => {
    const state = await read();
    if (!state.paused) await video('control', { action: 'pause', system: true });
    if (!(await read()).paused) throw new Error('无法暂停画面，已停止配音。');
    held = true;
  };
  const resume = async () => {
    const s = await read();
    if (!held || s.userPaused || signal.aborted) return;
    const result = await video('control', { action: 'play', system: true });
    if (!result?.ok || result.paused) throw new Error('无法恢复视频播放');
    held = false;
  };
  const speaker = async original => {
    if (muted === !original) return;
    const result = await video(original ? 'restore' : 'silence', { fadeSeconds: .08 });
    if (!result?.ok) throw new Error('无法切换原声');
    muted = !original;
  };
  const clearBackground = () => {
    if (background) { background.pause(); background.removeAttribute?.('src'); background.load?.(); background = null; }
    if (backgroundUrl) URL.revokeObjectURL(backgroundUrl);
    backgroundUrl = null;
  };
  const clearAudio = (includeBackground = true) => {
    if (includeBackground) clearBackground();
    if (active) { active.pause(); active.onended = active.onerror = null; active.removeAttribute?.('src'); active.load?.(); active = null; }
    if (activeUrl) URL.revokeObjectURL(activeUrl);
    activeUrl = null;
  };
  try {
    signal.throwIfAborted();
    await video('pick', { fresh: true });
    await video('watch', { initiallyPlaying: Boolean(opts.openingHold) }); watching = true;
    await hold();
    preparationMonitor = (async () => {
      while (preparing && !signal.aborted) {
        if (!(await read()).paused) await hold();
        await sleep(100);
      }
    })().catch(error => { productionError = error; controller.abort(); });
    const media = await video('media');
    source = await (opts.openSource || openInterpretSource)({ url: opts.sourceUrl, mediaUrl: /^https?:/.test(media?.src || '') ? media.src : undefined, signal, onProgress: p => status(p.hint) });
    if (media?.duration > 0 && Math.abs(source.duration - media.duration) > 3) throw new Error('音轨与播放器时长不一致');
    const progressive = !['full', 'buffered'].includes(settings.tts?.preparationMode);
    const coverage = [];
    const coveredUntil = time => {
      let end = time;
      for (const range of coverage) if (range.start <= end + .001 && range.end > end) end = range.end;
      return end;
    };
    plan = progressive ? { lines: [], cues: [], spans: [], sourceKey: await dubKey({ url: opts.sourceUrl, duration: source.duration }), background: false }
      : await prepareDubPlan({ source, settings, signal, status, cacheGet, cacheSet, transcribe: opts.transcribe, chat: opts.chat });
    let analysisRevision = 0;
    let refreshSpeakers = () => {};
    if (progressive) {
      // Whole-file diarization/separation improves future windows, never gates first audio.
      void source.analyze().then(analysis => {
        if (signal.aborted) return;
        plan.spans = validateAnalysis(analysis, source.duration);
        plan.background = analysis.background;
        analysisRevision++;
        refreshSpeakers();
      }).catch(error => { if (!signal.aborted) status(`后台声音分析暂不可用，继续分段翻译：${error.message}`); });
    }
    signal.throwIfAborted();
    const references = new Map();
    const configuredRef = await (opts.getTtsRef || getTtsRef)();
    const configuredBlob = configuredRef?.buffer ? new Blob([configuredRef.buffer], { type: configuredRef.type || 'audio/wav' }) : undefined;
    const refKeys = new Map();
    for (const [person, span] of progressive ? [] : voiceCandidates(plan.spans)) {
      const sample = await source.slice(span.start, Math.min(7, span.end - span.start));
      const ref = await (opts.voiceRef || voiceRefFromBlob)(sample.blob);
      if (ref) references.set(person, ref);
    }
    for (const [person, blob] of references) refKeys.set(person, await dubKey([...new Uint8Array(await blob.arrayBuffer())]));
    const configuredKey = configuredBlob ? await dubKey([...new Uint8Array(await configuredBlob.arrayBuffer())]) : 'none';
    const lines = plan.lines;
    const editsKey = await dubKey({ sourceKey: plan.sourceKey, ids: progressive ? 'progressive' : lines.map(l => [l.id, l.src]), version: 'edits-1' });
    const edits = await cacheGet(editsKey) || {};
    for (const line of lines) if (typeof edits[line.id] === 'string') line.zh = edits[line.id];
    const pending = new Set(lines.map(l => l.id));
    refreshSpeakers = () => {
      // Preserve the current utterance; regenerate future windows using actual speaker boundaries.
      const cutoff = Math.max(playhead, active?.dubItem.end || 0);
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.end > cutoff && !completed.has(line.id) && active?.dubItem.id !== line.id) {
          lines.splice(i, 1); ready.delete(line.id); pending.delete(line.id);
        }
      }
      for (let i = coverage.length - 1; i >= 0; i--) {
        if (coverage[i].start >= cutoff) coverage.splice(i, 1);
        else coverage[i].end = Math.min(coverage[i].end, cutoff);
      }
      status('已识别说话人，正在按各自音色更新后续配音…');
    };
    if (progressive) planning = (async () => {
      while (!signal.aborted) {
        const windowRevision = analysisRevision;
        const start = coveredUntil(playhead);
        if (start >= source.duration || start - playhead >= Math.max(24, (Number(settings.tts?.bufferSeconds) || 30) * 4)) { await sleep(100); continue; }
        // Small first window; subsequent windows retain paragraph context without a whole-file barrier.
        const end = Math.min(source.duration, start + (coverage.length ? 24 : 12), ...coverage.filter(r => r.start > start).map(r => r.start));
        const slice = await source.slice(start, end - start);
        if (!slice) throw new Error('原音轨切片缺失');
        const fingerprint = await dubKey([...new Uint8Array(await slice.blob.arrayBuffer())]);
        const spans = plan.spans.length ? plan.spans.filter(s => s.end > start && s.start < end).map(s => ({ ...s, start: Math.max(s.start, start) - start, end: Math.min(s.end, end) - start }))
          : [{ start: 0, end: end - start, kind: 'unknown', speaker: null }];
        const context = lines.filter(l => l.end <= start).slice(-12).map(l => `${l.src} → ${l.zh}`).join('\n').slice(-6000);
        status(`正在后台准备 ${Math.floor(start)}–${Math.ceil(end)} 秒的中文配音…`);
        const part = await prepareDubPlan({ source: {
          duration: end - start,
          analyze: async () => ({ duration: end - start, fingerprint, spans }),
          slice: (offset, seconds) => source.slice(start + offset, seconds),
        }, settings, signal, status: () => {}, cacheGet, cacheSet, transcribe: opts.transcribe, chat: opts.chat, incrementalContext: context });
        signal.throwIfAborted();
        if (windowRevision !== analysisRevision) continue;
        for (const original of part.lines) {
          const line = { ...original, speaker: /^(asr|unassigned):/.test(original.speaker || '') ? `${original.speaker}:${fingerprint}:${start}` : original.speaker, id: `${start}:${fingerprint}:${original.id}`, start: original.start + start, end: original.end + start };
          if (typeof edits[line.id] === 'string') line.zh = edits[line.id];
          lines.push(line); pending.add(line.id);
        }
        lines.sort((a, b) => a.start - b.start);
        coverage.push({ start, end }); coverage.sort((a, b) => a.start - b.start);
      }
    })().catch(error => { productionError = error; });
    opts.onEditable?.(async (id, text) => {
      const i = lines.findIndex(l => l.id === id);
      const zh = String(text || '').trim();
      if (i < 0 || !zh || zh.length > 500) throw new Error('请输入1–500字的中文口播稿');
      const edited = lines[i] = { ...lines[i], zh };
      edits[id] = zh;
      await cacheSet(editsKey, edits);
      ready.delete(id); completed.delete(id); pending.add(id);
      if (active?.dubItem.id === id) clearAudio();
      await hold();
      await video('seek', { seconds: edited.start, paused: true });
      status('已保存修改，正在重新准备这一句配音…');
    });
    preparing = false;
    await preparationMonitor;
    const full = settings.tts?.preparationMode === 'full';
    const target = Math.max(5, Math.min(120, Number(settings.tts?.bufferSeconds) || 30));
    // One worker preserves voice-service capacity, while playback is independent.
    production = (async () => {
      while (!signal.aborted) {
        if (!pending.size) { await sleep(100); continue; }
        // Seek changes priority, never discards completed work.
        const candidates = lines.filter(l => pending.has(l.id));
        const line = candidates.find(l => l.end > playhead) ?? candidates[0];
        pending.delete(line.id);
        const i = lines.indexOf(line);
        if (!ttsOn) { ready.set(line.id, { ...line, slotEnd: line.end }); continue; }
        if (line.speaker && !references.has(line.speaker)) {
          const span = voiceCandidates(plan.spans).get(line.speaker);
          if (span) {
            const sample = await source.slice(span.start, Math.min(7, span.end - span.start));
            const ref = await (opts.voiceRef || voiceRefFromBlob)(sample.blob);
            if (ref) { references.set(line.speaker, ref); refKeys.set(line.speaker, await dubKey([...new Uint8Array(await ref.arrayBuffer())])); }
          }
        }
        let referenceBlob = references.get(line.speaker);
        if (!referenceBlob && !line.overlap) {
          const sample = await source.slice(line.start, Math.min(7, line.end - line.start));
          referenceBlob = sample && await (opts.voiceRef || voiceRefFromBlob)(sample.blob);
          // Provider speaker IDs are scoped to the recognition window; unknown cues stay separate.
          if (referenceBlob && line.speaker && !line.speaker.startsWith('unassigned:')) references.set(line.speaker, referenceBlob);
        }
        referenceBlob ||= configuredBlob;
        const key = await dubKey({ source: plan.sourceKey, line, tts: { ...modelIdentity(settings.tts), lang: settings.tts.lang, durationFactor: settings.tts.durationFactor }, reference: referenceBlob ? await dubKey([...new Uint8Array(await referenceBlob.arrayBuffer())]) : configuredKey, background: Boolean(plan.background), version: 2 });
        let prepared = await cacheGet(key);
        if (!prepared) {
          status(`正在准备中文配音 ${ready.size + 1}/${lines.length}…`);
          let output, error;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              output = await withInterpretDeadline(s => (opts.synthesizeTts || synthesizeTts)(settings.tts, line.zh, { signal: s, referenceBlob, lang: settings.tts.lang || 'ZH' }), signal, 90000);
              break;
            } catch (e) { signal.throwIfAborted(); error = e; }
          }
          if (!output?.blob) throw error || new Error('配音生成失败');
          const seconds = await (opts.audioDuration || audioDuration)(output.blob);
          if (!(seconds > 0) || !Number.isFinite(seconds)) throw new Error('配音时长无效');
          prepared = { ...fitDub(line, seconds, progressive ? line.end : (lines[i + 1]?.start ?? source.duration)), blob: output.blob };
          if (plan.background) prepared.backgroundBlob = (await source.slice(line.start, prepared.slotEnd - line.start, 'background')).blob;
          await cacheSet(key, prepared);
        }
        if (lines.includes(line)) ready.set(line.id, prepared);
      }
    })().catch(error => { productionError = error; });
    let buffering = true;
    while (!signal.aborted) {
      if (productionError) throw productionError;
      const state = await read();
      playhead = state.currentTime;
      if (revision !== undefined && state.seekRevision !== revision) {
        clearAudio(); completed.clear(); buffering = true;
        status('已跳转，正在读取对应位置的配音缓存…');
      }
      revision = state.seekRevision;
      if (state.seeking) { active?.pause(); await sleep(50); continue; }
      if (state.ended && !active) break;
      currentIndex = lines.findIndex(l => l.end > playhead && !completed.has(l.id));
      const knownEnd = progressive ? coveredUntil(playhead) : source.duration;
      const rate = Math.max(.25, Number(state.playbackRate) || 1);
      const ahead = Math.min(continuousReadySeconds(lines, ready, playhead, source.duration), Math.max(0, knownEnd - playhead)) / rate;
      if (progressive && knownEnd <= playhead && playhead < source.duration && !active) buffering = true;
      if (buffering) {
        const enough = full ? ready.size === lines.length : ahead >= Math.min(progressive ? 3 : target, (source.duration - playhead) / rate);
        if (!enough) {
          await hold();
          status(full ? `画面已暂停，等待完整配音 ${ready.size}/${lines.length}…` : `画面已暂停，连续配音缓冲 ${Math.floor(ahead)}/${progressive ? 3 : target} 秒…`);
          await sleep(100); continue;
        }
        buffering = false;
      }
      const next = currentIndex < 0 ? null : lines[currentIndex];
      if (!active && next && playhead >= next.start - .04) {
        const item = ready.get(next.id);
        if (!item) { buffering = true; await hold(); continue; }
        if (!ttsOn) {
          completed.add(item.id);
          shown = item.id; emit({ type: 'line', ...item });
        } else {
          clearBackground();
          if (item.backgroundBlob) {
            backgroundUrl = URL.createObjectURL(item.backgroundBlob);
            background = (opts.createAudio || (url => new Audio(url)))(backgroundUrl);
            backgroundStart = item.start;
            background.volume = .65;
            background.preservesPitch = true;
          }
          activeUrl = URL.createObjectURL(item.blob);
          active = (opts.createAudio || (url => new Audio(url)))(activeUrl);
          active.preservesPitch = true;
          active.dubItem = item;
          const owner = active;
          active.onended = () => { if (active !== owner) return; completed.add(item.id); clearAudio(false); };
          active.onerror = () => { if (active !== owner) return; productionError = new Error('中文配音播放失败'); clearAudio(); };
          shown = item.id; emit({ type: 'line', ...item, blob: undefined });
        }
      }
      const speechNow = lines.some(l => l.start <= playhead && l.end > playhead);
      if (shown && !active && !speechNow) {
        shown = null;
        emit({ type: 'status', clearLine: true, message: '原声间奏 / 停顿', hint: '' });
      }
      await speaker(Boolean(opts.wantOriginalAudio?.()) || !ttsOn || (!active && !speechNow));
      const voice = active;
      if (state.userPaused || state.readyState < 3 && !held && !state.ended) {
        active?.pause();
      } else if (voice) {
        if (playhead >= voice.dubItem.slotEnd) await hold();
        else await resume();
        // Audio may end, fail, or be replaced while the video command is pending.
        if (active !== voice || signal.aborted) continue;
        voice.playbackRate = Math.min(4, Math.max(.25, (Number(state.playbackRate) || 1) * voice.dubItem.rate));
        if (voice.paused) {
          try {
            await withInterpretDeadline(() => active === voice ? voice.play() : undefined, signal, 15000);
          } catch (error) { if (active === voice || signal.aborted) throw error; }
        }
      } else {
        await resume();
      }
      const accompaniment = background;
      if (accompaniment) {
        const live = await read();
        if (background !== accompaniment || signal.aborted) continue;
        if (live.paused || live.seeking || live.userPaused || !speechNow || opts.wantOriginalAudio?.()) accompaniment.pause();
        else {
          if (Number.isFinite(accompaniment.duration)) {
            const offset = Math.max(0, Math.min(accompaniment.duration, live.currentTime - backgroundStart));
            if (Math.abs(accompaniment.currentTime - offset) > .15) accompaniment.currentTime = offset;
          }
          accompaniment.playbackRate = Math.max(.25, Math.min(4, Number(live.playbackRate) || 1));
          if (accompaniment.paused && !accompaniment.ended) {
            try {
              await withInterpretDeadline(() => background === accompaniment ? accompaniment.play() : undefined, signal, 15000);
            } catch (error) { if (background === accompaniment || signal.aborted) throw error; }
          }
        }
      }
      await sleep(50);
    }
    signal.throwIfAborted();
    return { mode: 'audio', lines, captions: linesToCaptions(lines), prepared: ready.size };
  } finally {
    controller.abort(); preparing = false; clearAudio();
    await preparationMonitor;
    await Promise.all([production, planning]);
    if (watching) {
      const state = await read().catch(() => null);
      if (muted) await video('restore').catch(() => {});
      if (held && state && !state.userPaused && !state.ended) await video('control', { action: 'play', system: true }).catch(() => {});
      await video('unwatch').catch(() => {});
    }
    await source?.close();
    opts.signal?.removeEventListener('abort', stop);
    void pruneDubCache();
  }
}

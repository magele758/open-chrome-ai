import { injectVideo, sleep } from './chrome.js';
import { openInterpretSource } from './downloaded-audio-source.js';
import { transcribeInterpretSlice } from './interpret-asr.js';
import { completeChat } from './openai.js';
import { isAsrReady, isTtsReady, resolveModel } from './storage.js';
import { synthesizeTts, getTtsRef } from './tts.js';
import { linesToCaptions, stripTimeline, voiceRefFromBlob } from './interpret.js';
import { withInterpretDeadline } from './interpret-semantic.js';
import { validateAnalysis, recognitionWindows, translationBatches, validateDubTranslation, fitDub, continuousReadySeconds, voiceCandidates, parseTolerantJson, subtitleSpeaker, subtitleWindowEnd } from './dub-timeline.js';
import { dubKey, readDubCache, writeDubCache, pruneDubCache } from './dub-cache.js';
import { composeCompactDubTrack, composeFullDubTrack, saveFullMediaArchive } from './audio-composer.js';
import { videoIdentity } from './library.js';
import { prepareSpeakerReference } from './interpret-reference.js';
import { stripSubtitleDirections } from './subtitle-text.js';
import { retryInterpretRequest } from './interpret-retry.js';

const modelIdentity = model => ({ baseUrl: model?.baseUrl, model: model?.model, language: model?.language, preset: model?.preset });
const parseJson = text => parseTolerantJson(text);

export async function prepareDubPlan({ source, settings, signal, status = () => {}, recoveryStatus = status,
  transcribe = transcribeInterpretSlice, chat = completeChat, cacheGet = readDubCache, cacheSet = writeDubCache, incrementalContext }) {
  status('正在分析说话人、停顿与音乐，画面保持暂停…');
  const analysis = await source.analyze();
  const spans = validateAnalysis(analysis, source.duration);
  const sourceKey = analysis.fingerprint || await dubKey({ analysis, url: source.url });
  const subtitles = source.subtitles?.map((c, n) => ({ ...c, src: stripSubtitleDirections(c.src || c.text), ...subtitleSpeaker(c, spans, n) })).filter(c => c.src);
  const useSubtitles = Boolean(source.subtitles?.length) && !subtitles.some(c => c.crossSpeaker);
  const recognitionKey = await dubKey({ sourceKey, spans, subtitles, analysisVersion: analysis.version, asr: modelIdentity(settings.asr), version: 5 });
  let cues = await cacheGet(recognitionKey);
  if (!cues) {
    const windows = recognitionWindows(spans);
    if (useSubtitles) {
      cues = subtitles.map((c, n) => ({
        id: c.id || `sub:${n}`,
        start: Math.max(0, Number(c.start) || 0),
        end: Math.max(Number(c.start) || 0, Math.min(source.duration, Number(c.end) || 0)),
        src: stripTimeline(c.src || c.text || ''),
        speaker: c.speaker,
        overlap: c.overlap,
        timingQuality: 'segment'
      })).filter(c => c.src && c.end > c.start);
      await cacheSet(recognitionKey, cues);
    } else {
      if (subtitles?.length) {
        if (!isAsrReady(settings.asr)) throw new Error('字幕跨越了不同说话人，需要配置 ASR 后按原声分句，才能保留各自音色。');
        status('字幕跨越说话人，正在按原声重新分句以保留各自音色…');
      }
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
            return { id: `${i}:${n}`, start, end: Math.max(start, end), src: stripTimeline(stripSubtitleDirections(s.text)),
              speaker: window.speaker || (s.speaker ? `asr:${i}:${s.speaker}` : `unassigned:${i}:${n}`), overlap: window.overlap, timingQuality: Number.isFinite(s.end) ? 'segment' : 'estimated' };
          }).filter(c => c.src && c.end > c.start);
        }
      }));
      cues = results.flat();
      await cacheSet(recognitionKey, cues);
    }
  }
  const model = resolveModel(settings, 'text');
  const translationKey = await dubKey({ recognitionKey, cues, model: modelIdentity(model), incrementalContext, version: 2 });
  const cached = await cacheGet(translationKey);
  if (cached) return { ...cached, spans, sourceKey, background: analysis.background };
  if (!cues.length) return { lines: [], cues, context: '', spans, sourceKey, background: analysis.background };
  const ask = (system, input, maxTokens = 5000) => retryInterpretRequest(s => chat(model, {
    messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }],
    signal: s, temperature: .1, maxTokens, rejectTruncated: true,
  }), { signal, onRetry: ({ attempt, attempts }) => recoveryStatus(`翻译连接暂时中断，正在重试当前段 ${attempt}/${attempts - 1}，已完成内容保留…`) });
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
      const system = '你是一名专业视频演说同传与配音译者。将当前对话/演讲忠实改写为自然流畅、富有表现力的简体中文口播稿。' +
        '核心要求：\n' +
        '1. 口播化表达：遵循中文口语习惯，短句为主，生动地道，彻底去除生硬的字对字欧化翻译腔。\n' +
        '2. 节奏与字数自适应：中文正常发音速度约为每秒 3.5 到 4 字。请参考每句原声的时长，将中文译文字数控制在合理区间内，确保后续配音节奏契合画面，不赶不拖。\n' +
        '3. 忠实严谨：保留原意、逻辑、数字与事实，不做主观摘要或添油加醋。\n' +
        '只输出实际对白，不要添加或朗读“（微笑）”“（叹气）”等舞台动作提示。\n' +
        '4. 格式约束：上下文仅供理解，不得重复翻译。每条原文id必须按顺序恰好出现一次，单独输出一条中文，ids数组只能含该条的一个id，禁止跨句合并。' +
        '译文若需引用请使用中文书名号《》或中文双引号“”，切勿在字符串中包含未转义的半角双引号。' +
        '返回JSON {"lines":[{"ids":["原文id"],"zh":"中文口播稿"}]}，只翻译current中的内容。';
      const translateGroup = async (current, before, after) => {
        const groupKey = await dubKey({ translationKey, current, before, after, recovery: 1 });
        const saved = await cacheGet(groupKey);
        if (saved) return saved;
        let lastError;
        let lastResponse = '';
        for (let attempt = 0; attempt < 2; attempt++) {
          // Service/authentication errors are not formatting errors: never fan them out.
          const response = await ask(system, { context, before, current, after, correction: lastError?.message });
          lastResponse = response;
          try {
            const parsed = parseJson(response);
            if (Array.isArray(parsed?.lines)) parsed.lines = parsed.lines.map(l => ({ ...l, zh: typeof l.zh === 'string' ? stripSubtitleDirections(l.zh) : l.zh }));
            const result = validateDubTranslation(parsed, current);
            await cacheSet(groupKey, result);
            return result;
          } catch (error) { signal.throwIfAborted(); lastError = error; }
        }
        if (current.length === 1) {
          // Single-cue salvage: don't abort a long video dubbing task for a single cue format glitch
          let salvagedZh = '';
          try {
            const parsed = parseTolerantJson(lastResponse);
            const line = Array.isArray(parsed) ? parsed[0] : parsed?.lines?.[0];
            salvagedZh = line?.zh || line?.text || line?.content || '';
          } catch (_) {}
          if (!salvagedZh && typeof lastResponse === 'string') {
            const m = lastResponse.match(/"(?:zh|text|content)"\s*:\s*"([\s\S]*?)"/);
            if (m && m[1]) salvagedZh = m[1].replace(/\\"/g, '"').trim();
          }
          if (!salvagedZh) salvagedZh = current[0].src;
          const salvaged = [{
            id: current[0].id,
            sourceIds: [current[0].id],
            start: current[0].start,
            end: current[0].end,
            src: current[0].src,
            zh: stripSubtitleDirections(salvagedZh).slice(0, 500) || current[0].src,
            speaker: current[0].speaker,
            overlap: current[0].overlap
          }];
          await cacheSet(groupKey, salvaged);
          return salvaged;
        }
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
    const hasSubtitles = Boolean(source.subtitles?.length);
    if (!hasSubtitles && !isAsrReady(settings.asr)) throw new Error('当前视频未检测到字幕，请先配置语音识别（ASR）。');
    if (hasSubtitles) status('检测到视频字幕，正在使用字幕优先极速起播（免 ASR）…');
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
      const ref = await prepareSpeakerReference({ line: { ...span, speaker: person }, spans: plan.spans, source, voiceRef: opts.voiceRef || voiceRefFromBlob });
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
      const cutoff = Math.max(playhead, active?.dubItem.end || 0, ...lines.filter(l => completed.has(l.id)).map(l => l.end));
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
        const desiredEnd = Math.min(source.duration, start + (coverage.length ? 24 : 12), ...coverage.filter(r => r.start > start).map(r => r.start));
        const end = hasSubtitles ? subtitleWindowEnd(source.subtitles, start, desiredEnd, source.duration) : desiredEnd;
        const slice = await source.slice(start, end - start);
        if (!slice) throw new Error('原音轨切片缺失');
        const fingerprint = await dubKey([...new Uint8Array(await slice.blob.arrayBuffer())]);
        const spans = plan.spans.length ? plan.spans.filter(s => s.end > start && s.start < end).map(s => ({ ...s, start: Math.max(s.start, start) - start, end: Math.min(s.end, end) - start }))
          : [{ start: 0, end: end - start, kind: 'unknown', speaker: null }];
        const context = lines.filter(l => l.end <= start).slice(-12).map(l => `${l.src} → ${l.zh}`).join('\n').slice(-6000);
        status(hasSubtitles ? `正在准备 ${Math.floor(start)}–${Math.ceil(end)} 秒的口播翻译与配音…` : `正在后台准备 ${Math.floor(start)}–${Math.ceil(end)} 秒的中文配音…`);
        const partSubtitles = source.subtitles ? source.subtitles.filter(c => c.end > start && c.start < end) : null;
        const part = await prepareDubPlan({ source: {
          duration: end - start,
          subtitles: partSubtitles ? partSubtitles.map(c => ({ ...c, start: Math.max(0, c.start - start), end: Math.min(end - start, c.end - start) })) : null,
          analyze: async () => ({ duration: end - start, fingerprint, spans }),
          slice: (offset, seconds) => source.slice(start + offset, seconds),
        }, settings, signal, status: () => {}, recoveryStatus: status, cacheGet, cacheSet, transcribe: opts.transcribe, chat: opts.chat, incrementalContext: context });
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
        let referenceBlob = references.get(line.speaker);
        if (!referenceBlob) {
          referenceBlob = await prepareSpeakerReference({ line, spans: plan.spans, source, voiceRef: opts.voiceRef || voiceRefFromBlob });
          // Provider speaker IDs are scoped to the recognition window; unknown cues stay separate.
          if (referenceBlob && line.speaker && !line.speaker.startsWith('unassigned:')) references.set(line.speaker, referenceBlob);
        }
        referenceBlob ||= configuredBlob;
        const key = await dubKey({ source: plan.sourceKey, line, tts: { ...modelIdentity(settings.tts), lang: settings.tts.lang, durationFactor: settings.tts.durationFactor }, reference: referenceBlob ? await dubKey([...new Uint8Array(await referenceBlob.arrayBuffer())]) : configuredKey, background: Boolean(plan.background), version: 2 });
        let prepared = await cacheGet(key);
        if (!prepared) {
          status(`正在准备中文配音 ${ready.size + 1}/${lines.length}…`);
          const output = await retryInterpretRequest(s => (opts.synthesizeTts || synthesizeTts)(settings.tts, line.zh, { signal: s, referenceBlob, lang: settings.tts.lang || 'ZH' }), {
            signal, onRetry: ({ attempt, attempts }) => status(`配音连接暂时中断，正在重试当前句 ${attempt}/${attempts - 1}，已完成内容保留…`),
          });
          if (!output?.blob) throw new Error('配音生成失败');
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
    let refill = false;
    while (!signal.aborted) {
      if (productionError) throw productionError;
      const state = await read();
      playhead = state.currentTime;
      if (revision !== undefined && state.seekRevision !== revision) {
        clearAudio(); completed.clear(); buffering = true; refill = false;
        status('已跳转，正在读取对应位置的配音缓存…');
      }
      revision = state.seekRevision;
      if (state.seeking) { active?.pause(); await sleep(50); continue; }
      if (state.ended && !active) break;
      currentIndex = lines.findIndex(l => l.end > playhead && !completed.has(l.id));
      const knownEnd = progressive ? coveredUntil(playhead) : source.duration;
      const rate = Math.max(.25, Number(state.playbackRate) || 1);
      const ahead = Math.min(continuousReadySeconds(lines, ready, playhead, source.duration), Math.max(0, knownEnd - playhead)) / rate;
      if (progressive && knownEnd <= playhead && playhead < source.duration && !active) {
        if (!buffering) refill = true;
        buffering = true;
      }
      if (buffering) {
        const bufferTarget = progressive && !refill ? 3 : target;
        const enough = full ? ready.size === lines.length : ahead >= Math.min(bufferTarget, (source.duration - playhead) / rate);
        if (!enough) {
          await hold();
          status(full ? `画面已暂停，等待完整配音 ${ready.size}/${lines.length}…` : `画面已暂停，连续配音缓冲 ${Math.floor(ahead)}/${bufferTarget} 秒…`);
          await sleep(100); continue;
        }
        buffering = false;
      }
      const next = currentIndex < 0 ? null : lines[currentIndex];
      if (!active && next && playhead >= next.start - .04) {
        let item = ready.get(next.id);
        if (!item) { buffering = true; refill = true; await hold(); continue; }
        // Refit even cached audio against the currently known next turn. Never
        // borrow unprocessed time; later windows may contain another speaker.
        if (ttsOn && item.audioSeconds > 0) {
          const nextStart = lines[currentIndex + 1]?.start ?? knownEnd;
          item = { ...item, ...fitDub(next, item.audioSeconds, Math.min(nextStart, knownEnd)) };
          ready.set(next.id, item);
        }
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
    try {
      const dubbedSegments = [];
      for (const line of lines || []) {
        const item = ready.get(line.id);
        if (item?.blob) {
          dubbedSegments.push({
            id: line.id,
            start: line.start,
            end: item.slotEnd || line.end,
            zh: line.zh,
            src: line.src,
            speaker: line.speaker,
            blob: item.blob,
          });
        }
      }
      const videoId = opts.sourceUrl ? videoIdentity(opts.sourceUrl) : null;
      if (videoId && dubbedSegments.length > 0) {
        const compactAudio = await composeCompactDubTrack(dubbedSegments, { sampleRate: 24000, gapMs: 250 });
        const fullAudio = await composeFullDubTrack(dubbedSegments, { totalDuration: source?.duration || 0 });
        const archive = await saveFullMediaArchive({
          videoId,
          title: opts.title || '视频同传',
          url: opts.sourceUrl,
          duration: source?.duration || 0,
          compactDuration: compactAudio.duration,
          lines,
          cues: linesToCaptions(lines).cues,
          compactCues: compactAudio.cues,
          audioBlob: fullAudio,
          compactAudioBlob: compactAudio.blob,
          processingVersion: 'planned-v1',
        });
        emit({ type: 'archive_saved', archive });
      }
    } catch {
      // Ignore archive compose error on shutdown
    }
    void pruneDubCache();
  }
}

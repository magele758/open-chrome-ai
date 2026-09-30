import { injectVideo, sleep } from './chrome.js';
import { openInterpretSource } from './downloaded-audio-source.js';
import { transcribeInterpretSlice } from './interpret-asr.js';
import { completeChat } from './openai.js';
import { isAsrReady, isTtsReady, resolveModel } from './storage.js';
import { StreamingAudioPlayer } from './streaming-audio-player.js';
import { synthesizeTts, getTtsRef } from './tts.js';
import { linesToCaptions, stripTimeline, voiceRefFromBlob } from './interpret.js';
import { withInterpretDeadline, unfinishedSpeech } from './interpret-semantic.js';
import { validateAnalysis, recognitionWindows, translationBatches, validateDubTranslation, fitDub, continuousReadySeconds, voiceCandidates, parseTolerantJson, subtitleSpeaker, subtitleWindowEnd, subtitleLeadGap, knownQuietUntil } from './dub-timeline.js';
import { buildTranslationInput, createInterpretContext } from './interpret-context.js';
import { groupSentences, restoreSentenceBreaks, budgetChars, endsSentence, hanCount, sentenceUnitsFromRestore, resolveSentenceEdit } from './dub-sentences.js';
import { dubKey, dubBlobKey, readDubCache, writeDubCache, pruneDubCache, createVideoDubCache } from './dub-cache.js';
import { composeCompactDubTrack, composeFullDubTrack, saveFullMediaArchive } from './audio-composer.js';
import { videoIdentity } from './library.js';
import { interpretSourceUrls } from './media-url.js';
import { prepareSpeakerReference } from './interpret-reference.js';
import { stripSubtitleDirections } from './subtitle-text.js';
import { retryInterpretRequest } from './interpret-retry.js';
import { INTERPRET_VERSION, DUB_ARCHIVE_VERSION, speechUnits, safeBudgetRewrite, failedTranslation, bufferingTarget, stableAudioIdentity, ttsAudioIdentity } from './interpret-policy.js';

const modelIdentity = model => ({ baseUrl: model?.baseUrl, model: model?.model, language: model?.language, preset: model?.preset });
const parseJson = text => parseTolerantJson(text);
// Punctuation-only cues ("。") carry no speech; models return empty text for them.
const hasSpeech = text => /[\p{L}\p{N}]/u.test(String(text || ''));
const dubContextMode = settings => settings?.tts?.contextMode === 'sentence' ? 'sentence' : 'cue';
const translateAheadSeconds = settings => {
  const ahead = Number(settings?.tts?.translateAheadSeconds);
  return Number.isFinite(ahead) && ahead >= 30 ? ahead : 600;
};
const clipBrief = text => [...String(text || '')].slice(0, 800).join('').trim();

function sentenceSystem(brief) {
  const head = clipBrief(brief);
  const body = '你是一名专业视频演说同传与配音译者。将当前对话/演讲忠实改写为自然流畅、富有表现力的简体中文口播稿。\n' +
    '核心要求：\n' +
    '1. 口播化表达：遵循中文口语习惯，短句为主，生动地道，彻底去除生硬的字对字欧化翻译腔。\n' +
    '2. 节奏与字数自适应：中文正常发音速度约为每秒 3.5 到 4 字。current 里的 budgetChars 是该句汉字预算，duration 是原声秒数，请把译文字数控制在预算内。\n' +
    '3. 忠实严谨：保留原意、逻辑、数字与事实，不做主观摘要或添油加醋。\n' +
    '只输出实际对白，不要添加或朗读“（微笑）”“（叹气）”等舞台动作提示。\n' +
    '4. brief、glossary、history、lookahead 只供理解上下文。不要翻译 lookahead，不要重复翻译 history 或 brief。\n' +
    '结合 lookahead 预判句意走向（如英文中的定语从句后置、状语后置、因果条件倒装等），并在当前句（current）中重构为语序通顺连贯的中文，但严禁将 lookahead 里的未来内容提前输出到当前译文中。\n' +
    '允许把同一说话人、时间连续、没有跨说话人重叠的 current.id 合并成一条口播；不得跨说话人合并。合并后时长不得超过 30 秒，相邻 id 间隔不得超过 0.35 秒。\n' +
    '每条 current.id 必须按顺序恰好出现一次。\n' +
    '译文若需引用请使用中文书名号《》或中文双引号“”，切勿在字符串中包含未转义的半角双引号。\n' +
    '返回 JSON {"lines":[{"ids":["current.id"],"zh":"中文口播稿","zh_parts":["与该条 sourceIds 等长，可省略"],"terms":[{"source":"原词","target":"译词"}]}]}。terms 只记录本批原文和译文里确实出现的专名或术语。';
  return head ? `全文简报（只帮助理解，不要翻译这段简报）：\n${head}\n\n${body}` : body;
}

function unitView(unit) {
  return {
    id: unit.id,
    sourceIds: unit.sourceIds,
    src: unit.src,
    start: unit.start,
    end: unit.end,
    duration: Math.max(0, Number(unit.end) - Number(unit.start)),
    budgetChars: budgetChars(unit.start, unit.end),
    speaker: unit.speaker,
  };
}

function validatedPrefix(parsed, cues) {
  const lines = Array.isArray(parsed?.lines) ? parsed.lines : Array.isArray(parsed) ? parsed : [];
  const expected = cues.map(cue => String(cue.id));
  let used = 0, count = 0;
  for (const line of lines) {
    const ids = (Array.isArray(line?.ids) ? line.ids : line?.id !== undefined ? [line.id] : []).map(String);
    if (!ids.length || ids.some((id, k) => id !== expected[count + k])) break;
    used++; count += ids.length;
  }
  if (!count || count >= expected.length) return null;
  try { return { count, lines: validateDubTranslation({ lines: lines.slice(0, used) }, cues.slice(0, count)) }; } catch { return null; }
}

function attachCueMembers(units, cues) {
  const byId = new Map(cues.map(cue => [cue.id, cue]));
  return units.map(unit => ({
    ...unit,
    cues: unit.cues || (unit.sourceIds || []).map(id => {
      const cue = byId.get(id);
      if (!cue) throw new Error(`Missing source fragment: ${id}`);
      return cue;
    }),
  }));
}

async function unitsForCues(cues, askOnce) {
  const grouped = groupSentences(cues);
  const unpunctuated = cues.length > 0 && cues.every(cue => !endsSentence(cue.src));
  if (!unpunctuated || typeof askOnce !== 'function') return attachCueMembers(grouped, cues);
  let restored = null;
  try {
    const text = cues.map(cue => cue.src).join(' ');
    restored = await restoreSentenceBreaks(text, (system, userText) => askOnce(system, userText, 800));
  } catch {
    restored = null;
  }
  return attachCueMembers(sentenceUnitsFromRestore(cues, restored) || grouped, cues);
}

function deferOpenTail(units, cues, enabled) {
  if (!enabled || !units.length) return { units, deferredCues: [] };
  const last = units[units.length - 1];
  if (last.end - last.start >= 20 || endsSentence(last.src) || !unfinishedSpeech(last.src)) return { units, deferredCues: [] };
  const known = new Set(cues.map(cue => cue.id));
  const ids = (last.sourceIds || []).filter(id => known.has(id));
  const deferredCues = ids.length === last.sourceIds.length
    ? cues.filter(cue => ids.includes(cue.id))
    : [{ id: last.id, start: last.start, end: last.end, src: last.src, speaker: last.speaker, overlap: last.overlap }];
  return { units: units.slice(0, -1), deferredCues };
}

function normalizeToUnitIds(parsed) {
  const sourceLines = Array.isArray(parsed?.lines) ? parsed.lines : Array.isArray(parsed) ? parsed : [];
  return { lines: sourceLines.map(line => ({ ...line,
    ids: Array.isArray(line?.ids) ? line.ids.map(String) : line?.id != null ? [String(line.id)] : [],
  })) };
}

function expandTranslatedUnits(validated, rawLines, batch, extraTerms = []) {
  const byId = new Map(batch.map(unit => [String(unit.id), unit]));
  return validated.map((line, index) => {
    const raw = rawLines[index] || {};
    const members = [];
    for (const id of line.sourceIds) {
      const unit = byId.get(String(id));
      if (!unit) continue;
      members.push(...(unit.cues?.length ? unit.cues : [unit]));
    }
    const cues = members.length ? members : [{ id: line.id, start: line.start, end: line.end, src: line.src, speaker: line.speaker, overlap: line.overlap }];
    const sourceIds = cues.map(item => item.id);
    const ownTerms = Array.isArray(raw.terms) ? raw.terms : [];
    return {
      id: sourceIds.join('+'),
      sourceIds,
      start: cues[0].start,
      end: cues.at(-1).end,
      src: cues.map(item => item.src).join(' '),
      zh: line.zh,
      speaker: cues[0].speaker,
      overlap: cues.some(item => item.overlap),
      zhParts: Array.isArray(raw.zh_parts) ? raw.zh_parts : Array.isArray(raw.zhParts) ? raw.zhParts : undefined,
      terms: [...ownTerms, ...extraTerms],
      captionSources: cues.map(item => ({ ...item })),
      timingQuality: cues.some(item => item.timingQuality === 'estimated') ? 'estimated' : 'segment',
    };
  });
}

async function fitBudget(line, askOnce) {
  const budget = budgetChars(line.start, line.end);
  if (!(speechUnits(line.zh) > budget * 1.15) || typeof askOnce !== 'function') return line;
  try {
    const limit = Math.max(1, Math.ceil(budget * 1.15));
    const raw = await askOnce(
      `把这句中文口播压缩到不超过 ${limit} 个汉字。不得改变事实、数字、否定、专名和逻辑，不要加解释。只输出压缩后的句子。`,
      { zh: line.zh, src: line.src, budgetChars: budget },
      800,
    );
    let text = String(raw || '').trim();
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        const parsed = parseJson(text);
        const picked = Array.isArray(parsed) ? parsed[0] : parsed;
        text = String(picked?.zh || picked?.text || '').trim();
      } catch { /* model returned plain text */ }
    }
    text = stripSubtitleDirections(text).trim();
    if (text.length > 500 || !safeBudgetRewrite(line.zh, text, limit)) return line;
    return { ...line, zh: text, zhParts: undefined };
  } catch {
    return line;
  }
}

async function hierarchicalBrief(cues, askOnce) {
  const batches = translationBatches(cues);
  if (!batches.length) return '';
  let summaries = [];
  for (const batch of batches) {
    const note = await askOnce('请为后续忠实翻译整理本段主题、人物指代、术语及数字条件。只输出简洁的上下文笔记，不超过500字，不创作内容。', batch, 1200);
    if (note) summaries.push(String(note));
  }
  if (!summaries.length) return '';
  while (summaries.join('\n').length > 10000) {
    const reduced = [];
    for (let i = 0; i < summaries.length; i += 8) {
      const note = await askOnce('合并这些按源顺序排列的上下文笔记，保留主题、指代及术语。用不超过800字输出。', summaries.slice(i, i + 8), 1800);
      if (note) reduced.push(String(note));
    }
    if (!reduced.length || reduced.join('\n').length >= summaries.join('\n').length) break;
    summaries = reduced;
  }
  return summaries.join('\n');
}

async function rememberSubtitleBrief({ subtitles, chat, model, signal, briefBox }) {
  const askOnce = async (system, input, maxTokens = 1200) => {
    try {
      signal.throwIfAborted();
      return await withInterpretDeadline(requestSignal => chat(model, {
        messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }],
        signal: requestSignal, temperature: .1, maxTokens, rejectTruncated: true,
      }), signal, 20000);
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError') throw error;
      return '';
    }
  };
  const cues = (subtitles || []).map(cue => ({ ...cue, src: stripSubtitleDirections(cue.src || cue.text || '') })).filter(cue => cue.src);
  const head = cues.filter(cue => Number(cue.start) < 180).map(cue => cue.src).join(' ');
  if (head) {
    const quick = clipBrief(await askOnce('用不超过300字写翻译简报：主题、人物、术语和语体。不要写成完整口播，不要编造。', head.slice(0, 6000), 800));
    if (quick && !briefBox.full) briefBox.text = quick;
  }
  if (!briefBox.text && cues.length > 0) {
    const sample = cues.filter((_, i) => i % Math.max(1, Math.floor(cues.length / 20)) === 0).map(c => c.src).join(' ');
    const fallback = clipBrief(await askOnce('用不超过300字写翻译简报：主题、人物、术语和语体。不要写成完整口播，不要编造。', sample.slice(0, 6000), 800));
    if (fallback) { briefBox.text = fallback; briefBox.full = true; }
  } else if (briefBox.text && !briefBox.full) {
    briefBox.full = true;
  }
}

function startBriefJob({ cues, askOnce, getBrief, setBrief, windowed }) {
  let text = typeof getBrief === 'function' ? String(getBrief() || '') : '';
  const publish = value => {
    const clipped = clipBrief(value);
    if (!clipped) return;
    text = clipped;
    if (typeof setBrief === 'function') setBrief(clipped);
  };
  const job = (async () => {
    try {
      const head = cues.filter(cue => Number(cue.start) < 180).map(cue => cue.src).join(' ');
      if (head) publish(await askOnce('用不超过300字写翻译简报：主题、人物、术语和语体。不要写成完整口播，不要编造。', head.slice(0, 6000), 800));
      if (!windowed) publish(await hierarchicalBrief(cues, askOnce));
    } catch { /* 简报失败时继续用已有译文 */ }
  })();
  return { read: () => text, job };
}

async function polishChapters(lines, ask) {
  if (lines.length < 2) return lines;
  const next = lines.map(line => ({ ...line }));
  for (let i = 0; i < next.length; i += 20) {
    const slice = next.slice(i, i + 20);
    try {
      const response = await ask(
        '你在做章节润色。只调整各句之间的衔接和术语一致性，不改变事实、数字、否定和说话人。不得改 id、时间或说话人。返回 JSON {"lines":[{"id":"原id","zh":"润色后的中文"}]}，行数和 id 必须与输入一致。',
        { lines: slice.map(line => ({ id: line.id, src: line.src, zh: line.zh, speaker: line.speaker })) },
        5000,
      );
      const parsed = parseJson(response);
      const incoming = Array.isArray(parsed?.lines) ? parsed.lines : null;
      if (!incoming || incoming.length !== slice.length) continue;
      const byId = new Map(incoming.map(line => [String(line.id), line]));
      if (slice.some(line => !byId.has(String(line.id)))) continue;
      for (const line of slice) {
        const zh = stripSubtitleDirections(String(byId.get(String(line.id)).zh || '')).trim();
        if (!zh || zh.length > 500 || !safeBudgetRewrite(line.zh, zh, budgetChars(line.start, line.end) * 1.15)) continue;
        line.zh = zh;
        line.zhParts = undefined;
      }
    } catch { /* 这一章保留原译文 */ }
  }
  return next;
}

function shiftPlannedLine(original, start, fingerprint) {
  const speaker = /^(asr|unassigned):/.test(original.speaker || '') ? `${original.speaker}:${fingerprint}:${start}` : original.speaker;
  const line = { ...original, speaker, id: `${start}:${fingerprint}:${original.id}`, start: original.start + start, end: original.end + start };
  if (Array.isArray(original.captionSources)) {
    line.captionSources = original.captionSources.map(cue => ({ ...cue, start: cue.start + start, end: cue.end + start }));
  }
  return line;
}

async function translateSentenceBatch({ batch, input, ask, askOnce, cacheGet, cacheSet, translationKey, signal, status, onLines = () => {} }) {
  const system = sentenceSystem(input.brief);
  const groupKey = await dubKey({ translationKey, ids: batch.map(unit => unit.id), brief: input.brief, history: input.history, lookahead: input.lookahead, sentence: 1 });
  const saved = await cacheGet(groupKey);
  if (saved) { await onLines(saved); return saved; }
  const unitCues = batch.map(unit => ({ id: unit.id, start: unit.start, end: unit.end, src: unit.src, speaker: unit.speaker, overlap: unit.overlap }));
  let lastError;
  let lastResponse = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await ask(system, { ...input, correction: lastError?.message });
      lastResponse = response;
      const parsed = parseJson(response);
      const normalized = normalizeToUnitIds(parsed, batch);
      if (Array.isArray(normalized.lines)) normalized.lines = normalized.lines.map(line => ({ ...line, zh: typeof line.zh === 'string' ? stripSubtitleDirections(line.zh) : line.zh }));
      const validated = validateDubTranslation(normalized, unitCues);
      const rawLines = Array.isArray(parsed?.lines) ? parsed.lines : Array.isArray(parsed) ? parsed : [];
      const extraTerms = Array.isArray(parsed?.terms) ? parsed.terms : [];
      const expanded = [];
      for (const line of expandTranslatedUnits(validated, rawLines, batch, extraTerms)) {
        const fitted = await fitBudget(line, askOnce);
        expanded.push(fitted);
        await onLines([fitted]);
      }
      await cacheSet(groupKey, expanded);
      return expanded;
    } catch (error) {
      signal.throwIfAborted();
      if (error.requestFailure) {
        if (/\b(401|403)\b/.test(error.message)) throw error;
        const failed = batch.map(c => failedTranslation(c, 'translation-request-failed'));
        await onLines(failed); return failed;
      }
      lastError = error;
    }
  }
  if (batch.length === 1) {
    const line = failedTranslation(batch[0]);
    await onLines([line]);
    return [line];
  }
  status('正在按原句重新整理译文，保留各自音色…');
  const result = [];
  for (let n = 0; n < batch.length; n++) {
    signal.throwIfAborted();
    const unit = batch[n];
    const isolated = buildTranslationInput({
      brief: input.brief,
      glossary: input.glossary,
      history: input.history,
      current: [unitView(unit)],
      lookahead: input.lookahead,
    });
    result.push(...await translateSentenceBatch({ batch: [unit], input: isolated, ask, askOnce, cacheGet, cacheSet, translationKey, signal, status, onLines }));
  }
  return result;
}

async function runSentenceTranslation({ cues, settings, signal, status, ask, askOnce, cacheGet, cacheSet, translationKey, windowed, skipBrief, getBrief, setBrief, extraLookahead, deferUnfinished, priorLines, translationContext, onLines = () => {} }) {
  let units = await unitsForCues(cues, windowed ? undefined : askOnce);
  const deferred = deferOpenTail(units, cues, deferUnfinished);
  units = deferred.units;
  const brief = skipBrief || windowed
    ? { read: () => String(getBrief?.() || ''), job: Promise.resolve() }
    : startBriefJob({ cues, askOnce, getBrief, setBrief, windowed });
  const glossary = translationContext || createInterpretContext({ maxSentences: 12, maxChars: 3000 });
  if (!translationContext) for (const line of priorLines || []) glossary.commit(line.src, line.zh, line.terms || []);
  const publish = async incoming => {
    for (const line of incoming) if (line.translationStatus !== 'failed') glossary.commit(line.src, line.zh, line.terms);
    await onLines(incoming);
  };
  const batches = [];
  for (let i = 0; i < units.length; i += 15) batches.push(units.slice(i, i + 15));
  const lines = [];
  for (let i = 0; i < batches.length; i++) {
    signal.throwIfAborted();
    status(`正在生成中文口播稿 ${i + 1}/${Math.max(1, batches.length)}…`);
    const batch = batches[i];
    const upcoming = [...batches.slice(i + 1).flat(), ...(extraLookahead || [])];
    const lookahead = upcoming.slice(0, 4).map(unit => ({ id: unit.id, src: unit.src }));
    const input = buildTranslationInput({
      brief: brief.read(),
      glossary: glossary.terms(),
      history: glossary.snapshot(),
      current: batch.map(unitView),
      lookahead,
    });
    const translated = await translateSentenceBatch({ batch, input, ask, askOnce: windowed ? undefined : askOnce, cacheGet, cacheSet, translationKey, signal, status, onLines: publish });
    lines.push(...translated);
  }
  if (!windowed) await brief.job;
  const polished = !windowed && ['full', 'buffered'].includes(settings?.tts?.preparationMode) ? await polishChapters(lines, ask) : lines;
  return { lines: polished, context: brief.read(), deferredCues: deferred.deferredCues };
}

export async function prepareDubPlan({ source, settings, signal, status = () => {}, recoveryStatus = status,
  transcribe = transcribeInterpretSlice, chat = completeChat, cacheGet = readDubCache, cacheSet = writeDubCache, incrementalContext, sourceOffset = 0,
  prefixCues, priorLines, deferUnfinished = false, extraLookahead, windowed = false, skipBrief = false, getBrief, setBrief, translationContext, onLines = () => {}, onMetric = () => {} }) {
  if (!windowed) status('正在分析说话人、停顿与音乐，画面保持暂停…');
  const analysis = await source.analyze();
  const spans = validateAnalysis(analysis, source.duration);
  const sourceKey = analysis.fingerprint || await dubKey({ analysis, url: source.url });
  const subtitles = source.subtitles?.map((c, n) => ({ ...c, src: stripSubtitleDirections(c.src || c.text), ...subtitleSpeaker(c, spans, n) })).filter(c => c.src);
  const useSubtitles = Boolean(source.subtitles?.length) && !subtitles.some(c => c.crossSpeaker);
  const recognitionKey = await dubKey({ sourceKey, spans, subtitles, analysisVersion: analysis.version, asr: modelIdentity(settings.asr), version: 5 });
  let incompleteRecognition = false;
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
      })).filter(c => hasSpeech(c.src) && c.end > c.start);
      if (!incompleteRecognition) await cacheSet(recognitionKey, cues);
    } else {
      if (!isAsrReady(settings.asr)) {
        const missing = recognitionWindows(spans).map((span, i) => failedTranslation({ ...span, id: `gap:${i}`, src: '', speaker: span.speaker }, 'missing-subtitles-and-asr'));
        await onLines(missing);
        return { lines: missing, cues: [], context: '', incompleteTranslation: true, spans, sourceKey, background: analysis.background };
      }
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
            let missed = false;
            segments = await transcribe(settings.asr, slice, { signal, onUnrecognized: range => {
              missed = incompleteRecognition = true;
              recoveryStatus(`无法确认 ${(sourceOffset + window.start + range.start).toFixed(1)}–${(sourceOffset + window.start + range.end).toFixed(1)} 秒的人声，已跳过并继续处理后续内容。`);
            } });
            signal.throwIfAborted();
            if (!missed && !segments.length && window.kind === 'speech') throw new Error(`检测到人声但未识别到文字：${window.start.toFixed(1)}–${window.end.toFixed(1)} 秒。请重试，已完成内容会保留。`);
            if (!missed) await cacheSet(key, segments);
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
      if (!incompleteRecognition) await cacheSet(recognitionKey, cues);
    }
  }
  const model = resolveModel(settings, 'text');
  const mode = dubContextMode(settings);
  if (mode === 'sentence' && Array.isArray(prefixCues) && prefixCues.length) {
    const prefixIds = new Set(prefixCues.map(cue => cue.id));
    cues = [...prefixCues, ...cues].filter(cue => cue?.src && cue.end > cue.start).sort((a, b) => a.start - b.start || a.end - b.end);
    // ASR speaker ids restart in every window. An unfinished tail is the same utterance as the next words when the gap is still inside the merge limit.
    const fresh = cues.filter(cue => !prefixIds.has(cue.id));
    const carried = cues.filter(cue => prefixIds.has(cue.id));
    const next = fresh[0];
    const tail = carried.at(-1);
    if (next && tail && !tail.overlap && !next.overlap && next.start - tail.end <= 0.35 + 1e-6) {
      const previous = tail.speaker;
      for (const cue of carried) if (cue.speaker === previous) cue.speaker = next.speaker;
    }
  }
  const translationKey = await dubKey({
    recognitionKey, cues, model: modelIdentity(model),
    incrementalContext: mode === 'cue' ? incrementalContext : undefined,
    contextMode: mode,
    prior: mode === 'sentence' ? (priorLines || []).slice(-12).map(line => [line.src, line.zh]) : undefined,
    version: INTERPRET_VERSION,
    windowed, deferUnfinished, brief: getBrief?.() || '', glossary: translationContext?.terms() || [],
  });
  const cached = await cacheGet(translationKey);
  if (cached) status('已复用缓存的中文口播稿…');
  if (cached) {
    for (const line of cached.lines) translationContext?.commit(line.src, line.zh, line.terms || []);
    await onLines(cached.lines);
    return { ...cached, incompleteRecognition, spans, sourceKey, background: analysis.background };
  }
  if (!cues.length) return { lines: [], cues, context: '', deferredCues: [], incompleteRecognition, spans, sourceKey, background: analysis.background };
  let requestDeadline, requests = 0;
  const ask = async (system, input, maxTokens = 5000) => {
    signal.throwIfAborted();
    // A failed window is delivered as original audio, so the budget must cover
    // a normal slow LLM response (two attempts), not only the fast path.
    if (!requestDeadline || !windowed) requestDeadline = Date.now() + 90000;
    const remaining = requestDeadline - Date.now();
    // Each attempt gets a fair fixed timeout (normal replies take 3–10 s; the
    // provider occasionally stalls one request). Splitting the remaining budget
    // shrank later timeouts to a few seconds and aborted healthy requests.
    if (remaining < 8000 || ++requests > (windowed ? 12 : Infinity)) throw Object.assign(new Error('翻译预算耗尽'), { requestFailure: true });
    const began = Date.now();
    return retryInterpretRequest(s => chat(model, {
      messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }],
      signal: s, temperature: .1, maxTokens, rejectTruncated: true,
    }), { signal, attempts: 2, timeoutMs: Math.min(remaining - 500, windowed ? 30000 : 45000),
      onRetry: ({ error }) => recoveryStatus(/timeout|超时/i.test(`${error?.name} ${error?.message}`)
        ? '翻译响应较慢，正在重试当前段，已完成内容保留…'
        : '翻译连接暂时中断，正在重试当前段，已完成内容保留…') }).catch(error => { error.requestFailure = true; throw error; })
      .finally(() => onMetric({ stage: 'translation', durationMs: Date.now() - began, sourceOffset }));
  };
  let repairRemaining = windowed ? 2500 : 20000;
  const askOnce = async (system, input, maxTokens = 1200) => {
    const began = Date.now();
    if (repairRemaining <= 0) return '';
    try {
      signal.throwIfAborted();
      return await withInterpretDeadline(requestSignal => chat(model, {
        messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }],
        signal: requestSignal, temperature: .1, maxTokens, rejectTruncated: true,
      }), signal, repairRemaining);
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError') throw error;
      return '';
    } finally { repairRemaining -= Date.now() - began; onMetric({ stage: 'text-repair', durationMs: Date.now() - began, sourceOffset }); }
  };
  if (mode === 'sentence') {
    const sentence = await runSentenceTranslation({
      cues, settings, signal, status, ask, askOnce, cacheGet, cacheSet, translationKey,
      windowed, skipBrief, getBrief, setBrief, extraLookahead, deferUnfinished, priorLines, translationContext, onLines,
    });
    const result = { lines: sentence.lines, cues, context: sentence.context, deferredCues: sentence.deferredCues, incompleteTranslation: sentence.lines.some(l => l.translationStatus === 'failed') };
    if (!result.incompleteTranslation) await cacheSet(translationKey, result);
    return { ...result, incompleteRecognition, spans, sourceKey, background: analysis.background };
  }
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
          try {
            const response = await ask(system, { context, before, current, after, correction: lastError?.message });
            lastResponse = response;
            const parsed = parseJson(response);
            if (Array.isArray(parsed?.lines)) parsed.lines = parsed.lines.map(l => ({ ...l, zh: typeof l.zh === 'string' ? stripSubtitleDirections(l.zh) : l.zh }));
            let result;
            try { result = validateDubTranslation(parsed, current); } catch (error) {
              // Models often stop early on long batches. Keep the verified leading
              // lines and translate only the remainder instead of one cue at a time.
              const head = validatedPrefix(parsed, current);
              if (!head) throw error;
              const tail = await translateGroup(current.slice(head.count), [...(before || []), ...current.slice(0, head.count)].slice(-2), after);
              return [...head.lines, ...tail];
            }
            await cacheSet(groupKey, result);
            return result;
          } catch (error) {
            signal.throwIfAborted();
            if (error.requestFailure) {
              if (/\b(401|403)\b/.test(error.message)) throw error;
              return current.map(c => failedTranslation(c, 'translation-request-failed'));
            }
            lastError = error;
          }
        }
        if (current.length === 1) return [failedTranslation(current[0])];
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
      if (!translated.some(l => l.translationStatus === 'failed')) await cacheSet(key, translated);
    }
    lines.push(...translated);
    await onLines(translated);
  }
  const result = { lines, cues, context, incompleteTranslation: lines.some(l => l.translationStatus === 'failed') };
  if (!result.incompleteTranslation) await cacheSet(translationKey, result);
  return { ...result, incompleteRecognition, spans, sourceKey, background: analysis.background };
}

export async function audioDuration(blob) {
  const context = new AudioContext();
  try { return (await context.decodeAudioData(await blob.arrayBuffer())).duration; }
  finally { await context.close(); }
}

/** All expensive work is cached independently from playback and seeking. */
export async function runPlannedInterpret(opts) {
  const { tabId, settings } = opts;
  const startedAt = Date.now();
  let firstPlay = false;
  const controller = new AbortController(), signal = controller.signal;
  const stop = () => controller.abort();
  opts.signal?.addEventListener('abort', stop, { once: true });
  if (opts.signal?.aborted) stop();
  const video = opts.video || ((cmd, arg) => injectVideo(tabId, cmd, arg));
  const emit = event => { if (!signal.aborted) { try { opts.onEvent?.({ mode: 'audio', ...event }); } catch { /* UI callback */ } } };
  let stageHint = '';
  const status = message => {
    if (stageHint === message) return;
    stageHint = message || '';
    emit({ type: 'status', message, hint: message });
  };
  const showWait = message => {
    const stage = stageHint && !stageHint.startsWith('画面已暂停') ? stageHint : '';
    const text = stage ? `${stage} ${message}` : message;
    emit({ type: 'status', message: text, hint: text });
  };
  const videoCache = await createVideoDubCache(opts.sourceUrl ? videoIdentity(opts.sourceUrl) : null);
  const cacheGet = opts.cacheGet || videoCache.get, cacheSet = opts.cacheSet || videoCache.set;
  let reused = 0, generated = 0, fullyPrepared = false;
  const isStreamMode = Boolean(opts.streamPlayback || opts.streamMode);
  const audioOnly = opts.audioOnly === true;
  let source, held = false, muted = false, active = null, activeUrl = null;
  let background = null, backgroundUrl = null, backgroundStart = 0;
  let production = Promise.resolve(), planning = Promise.resolve(), productionError, watching = false;
  const completed = new Set(), ready = new Map();
  let revision, currentIndex = 0, shown = null;
  let playhead = Number(opts.startAt) || 0;
  const streamPlayer = isStreamMode ? (opts.streamPlayer || new StreamingAudioPlayer({
    gapMs: Number(settings?.tts?.gapMs) || 0,
    playbackRate: Number(settings?.tts?.playbackRate) || 1.0,
    volume: Number.isFinite(Number(opts.volume)) ? Math.max(0, Math.min(1, Number(opts.volume))) : 1.0,
    audioDuration: opts.audioDuration || audioDuration,
    AudioContextClass: opts.AudioContextClass,
    createAudioElement: opts.createAudioElement || (opts.createAudio ? (() => opts.createAudio()) : undefined),
    signal,
    onItemStart: (item) => {
      shown = item.id;
      completed.add(item.id);
      emit({ type: 'line', ...item, blob: undefined });
    },
    onBuffering: (isBuffering) => {
      emit({
        type: 'status',
        message: isBuffering ? '等待后续译文缓冲…' : '正在流畅播报…',
        hint: isBuffering ? '正在后台合成下一句' : '',
        isBuffering,
      });
    },
    onQueueUpdate: (stats) => {
      emit({ type: 'stream_stats', stats });
    },
  })) : null;
  if (streamPlayer) opts.onStreamPlayer?.(streamPlayer);
  let plan, preparing = true, preparationMonitor = Promise.resolve();
  let emittedDubComplete = false;
  const ttsOn = isTtsReady(settings.tts);
  const read = async () => { const s = await video('state'); if (!s?.ok) throw new Error('播放器已关闭'); return s; };
  const hold = async () => {
    if (isStreamMode) {
      try {
        const state = await read();
        if (!state.paused) await video('control', { action: 'pause', system: true });
      } catch {}
      held = true;
      return;
    }
    const state = await read();
    if (!state.paused) await video('control', { action: 'pause', system: true });
    if (!state.paused && !(await read()).paused) throw new Error('无法暂停画面，已停止配音。');
    held = true;
  };
  const resume = async () => {
    if (isStreamMode) {
      held = false;
      return;
    }
    if (!held || signal.aborted) return;
    const s = await read();
    if (s.userPaused) return;
    const result = await video('control', { action: 'play', system: true });
    if (!result?.ok || result.paused) throw new Error('无法恢复视频播放');
    held = false;
  };
  const speaker = async original => {
    if (muted === !original) {
      // The panel or host player may have changed the actual gate since last tick.
      const actual = await read();
      if (actual.silenced === undefined || actual.silenced === !original) return;
    }
    const result = await video(original ? 'restore' : 'silence', { fadeSeconds: .08 });
    if (!result?.ok) throw new Error('无法切换原声');
    muted = !original;
  };
  const clearBackground = () => {
    if (background) {
      background.pause();
      background.onended = background.onerror = null;
      background.src = '';
      background = null;
    }
    if (backgroundUrl) {
      const u = backgroundUrl;
      setTimeout(() => { try { URL.revokeObjectURL(u); } catch {} }, 2000);
      backgroundUrl = null;
    }
  };
  const clearAudio = (includeBackground = true) => {
    if (includeBackground) clearBackground();
    if (active) {
      active.pause();
      active.onended = active.onerror = null;
      active.src = '';
      active = null;
    }
    if (activeUrl) {
      const u = activeUrl;
      setTimeout(() => { try { URL.revokeObjectURL(u); } catch {} }, 2000);
      activeUrl = null;
    }
  };
  try {
    signal.throwIfAborted();
    await video('pick', { fresh: true });
    if (!audioOnly) {
      await video('watch', { initiallyPlaying: true }); watching = true;
    }
    if (!isStreamMode && !audioOnly) {
      await hold();
      preparationMonitor = (async () => {
        while (preparing && !signal.aborted) {
          if (!(await read()).paused) await hold();
          await sleep(100);
        }
      })().catch(error => { productionError = error; controller.abort(); });
    }
    const media = await video('media');
    source = await (opts.openSource || openInterpretSource)({ ...interpretSourceUrls({ pageUrl: opts.sourceUrl, mediaSrc: media?.src, audioSrc: media?.audioSrc }), signal, onProgress: p => status(p.hint) });
    emit({ type: 'metric', stage: 'source-ready', durationMs: Date.now() - startedAt });
    if (media?.duration > 0 && Math.abs(source.duration - media.duration) > 3) throw new Error('音轨与播放器时长不一致');
    const hasSubtitles = Boolean(source.subtitles?.length);
    if (!hasSubtitles && !isAsrReady(settings.asr)) throw new Error('当前视频未检测到字幕，请先配置语音识别（ASR）。');
    if (hasSubtitles) status('检测到视频字幕，正在使用字幕优先极速起播（免 ASR）…');
    const savedPlanKey = await dubKey({ videoId: videoIdentity(opts.sourceUrl), duration: source.duration,
      subtitles: source.subtitles, text: modelIdentity(resolveModel(settings, 'text')),
      asr: modelIdentity(settings.asr), contextMode: dubContextMode(settings), preparationMode: settings.tts?.preparationMode, version: INTERPRET_VERSION });
    const savedPlan = opts.plan || await cacheGet(savedPlanKey);
    const realtime = !['full', 'buffered'].includes(settings.tts?.preparationMode);
    const progressive = !savedPlan && realtime;
    if (savedPlan) status('已复用完整翻译，正在读取已生成的配音…');
    const coverage = [];
    const coveredUntil = time => {
      let end = time;
      for (const range of coverage) if (range.start <= end + .001 && range.end > end) end = range.end;
      return end;
    };
    plan = savedPlan || (progressive ? { lines: [], cues: [], spans: [], sourceKey: await dubKey({ url: opts.sourceUrl ? videoIdentity(opts.sourceUrl) : 'unknown', duration: Math.round(Number(source.duration) || 0) }), background: false }
      : await prepareDubPlan({ source, settings, signal, status, cacheGet, cacheSet, transcribe: opts.transcribe, chat: opts.chat }));
    let analysisRevision = 0;
    let productionLatency = 0;
    const translationContext = createInterpretContext({ maxSentences: 12, maxChars: 3000 });
    let refreshSpeakers = () => {};
    if (progressive) {
      // Whole-file diarization/separation improves future windows, never gates first audio.
      void source.analyze().then(analysis => {
        if (signal.aborted) return;
        plan.spans = validateAnalysis(analysis, source.duration);
        plan.background = analysis.background;
        analysisRevision++;
        refreshSpeakers();
      }).catch(error => {
        if (!signal.aborted) {
          console.warn('[planned-interpret] Background voice analysis unavailable, fallback to progressive translation:', error.message);
          // Optional analysis must not overwrite the active translation/TTS stage.
        }
      });
    }
    signal.throwIfAborted();
    const references = new Map();
    const configuredRef = await (opts.getTtsRef || getTtsRef)();
    const configuredBlob = configuredRef?.buffer ? new Blob([configuredRef.buffer], { type: configuredRef.type || 'audio/wav' }) : undefined;
    const refKeys = new Map();
    const configuredKey = configuredBlob ? await dubBlobKey(configuredBlob) : 'none';
    const lines = plan.lines;
    const editsKey = await dubKey({ sourceKey: plan.sourceKey, ids: progressive ? 'progressive' : lines.map(l => [l.id, l.src]), version: 'edits-1' });
    const edits = await cacheGet(editsKey) || {};
    for (const line of lines) {
      const edited = resolveSentenceEdit(line, edits, lines);
      if (typeof edited === 'string') line.zh = edited;
    }
    const pending = new Set(lines.map(l => l.id));
    refreshSpeakers = () => {
      // Speaker analysis applies only to subsequently planned windows. Published
      // text/audio and the current in-flight window are immutable.
      // Reopen only inferred subtitle gaps contradicted by new speech evidence.
      // Already committed line ranges and already watched source time stay intact.
      const revised = [];
      for (const range of coverage) {
        let pieces = [range];
        if (range.quiet) for (const span of plan.spans.filter(s => s.kind === 'speech' && s.end > playhead)) {
          const from = Math.max(playhead, span.start), to = span.end;
          pieces = pieces.flatMap(piece => {
            if (piece.end <= from || piece.start >= to) return [piece];
            return [piece.start < from ? { ...piece, end: from } : null,
              piece.end > to ? { ...piece, start: to } : null].filter(Boolean);
          });
        }
        revised.push(...pieces);
      }
      coverage.splice(0, coverage.length, ...revised.sort((a, b) => a.start - b.start));
      emit({ type: 'metric', stage: 'analysis', revision: analysisRevision, invalidated: 0 });
    };
    const publishLines = async (incoming, start, fingerprint) => {
      signal.throwIfAborted();
      for (const original of incoming) {
        const line = shiftPlannedLine(original, start, fingerprint);
        if (lines.some(existing => existing.id === line.id)) continue;
        const edited = resolveSentenceEdit(line, edits, [...lines, line]);
        if (typeof edited === 'string') { line.zh = edited; line.zhParts = undefined; line.translationStatus = 'translated'; }
        lines.push(line); pending.add(line.id);
        if (line.translationStatus === 'failed') {
          plan.incompleteTranslation = true;
          status('本段翻译无法确认，将保留原声并继续后续内容。');
        }
        // Only the contiguous committed prefix becomes playback coverage.
        if (line.end > start) coverage.push({ start: Math.min(start, line.start), end: line.end });
      }
      lines.sort((a, b) => a.start - b.start);
      coverage.sort((a, b) => a.start - b.start);
    };
    if (progressive) planning = (async () => {
      const sentenceMode = dubContextMode(settings) === 'sentence';
      const briefBox = { text: '', full: false };
      let briefStarted = false;
      let carried = [];
      let recognizedUntil = 0;
      while (!signal.aborted) {
        const windowRevision = analysisRevision;
        const audioPlayhead = Number(opts.getAudioPlayhead?.()) || 0;
        const currentPlayhead = Math.max(
          isStreamMode && streamPlayer ? streamPlayer.getCurrentSourceTime() : playhead,
          audioPlayhead
        );
        const scheduledAudioTime = Math.max(
          streamPlayer ? streamPlayer.getScheduledSourceTime() : 0,
          Number(opts.getAudioScheduledTime?.()) || 0
        );
        const isAudioActive = isStreamMode || Boolean(opts.isAudioActive?.());
        const continuousEnd = coveredUntil(0);
        const start = (currentPlayhead > continuousEnd + 15) ? coveredUntil(currentPlayhead) : continuousEnd;
        const bufferLimit = Math.max(120, (Number(settings.tts?.bufferSeconds) || 30) * 4);
        const bufferedAhead = scheduledAudioTime - currentPlayhead;
        const aheadLimit = sentenceMode ? translateAheadSeconds(settings) : bufferLimit;
        const waiting = sentenceMode
          ? (!opts.generateFull && start - currentPlayhead >= aheadLimit)
          : (!opts.generateFull && start - currentPlayhead >= bufferLimit && (!isAudioActive || bufferedAhead >= 30));
        if (start >= source.duration || waiting) {
          if (sentenceMode && hasSubtitles && !briefStarted && continuousReadySeconds(lines, ready, currentPlayhead, source.duration) >= 30) {
            briefStarted = true;
            void rememberSubtitleBrief({ subtitles: source.subtitles, chat: opts.chat || completeChat, model: resolveModel(settings, 'text'), signal, briefBox }).catch(() => {});
          }
          await sleep(100);
          continue;
        }
        if (hasSubtitles) {
          const gap = subtitleLeadGap(source.subtitles, start, source.duration, { spans: plan.spans, subtitlesComplete: source.subtitlesComplete === true });
          if (gap && gap.end > start + 0.001) {
            coverage.push({ start, end: gap.end, quiet: true });
            coverage.sort((a, b) => a.start - b.start);
            status(gap.kind === 'gap' ? `字幕从 ${Math.floor(gap.end)} 秒开始，先跳过前面的无台词片段…` : '后面没有字幕了');
            continue;
          }
        }
        if (!sentenceMode) {
          // Small first window; subsequent windows retain paragraph context without a whole-file barrier.
          const desiredEnd = Math.min(source.duration, start + (coverage.length ? 24 : 12), ...coverage.filter(r => r.start > start).map(r => r.start));
          const end = hasSubtitles ? subtitleWindowEnd(source.subtitles, start, desiredEnd, source.duration) : desiredEnd;
          const slice = hasSubtitles ? null : await source.slice(start, end - start);
          if (!hasSubtitles && !slice) throw new Error('原音轨切片缺失');
          const fingerprint = hasSubtitles ? await dubKey({ source: plan.sourceKey, start, end, subtitles: source.subtitles }) : await dubBlobKey(slice.blob);
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
          }, settings, signal, status: () => {}, recoveryStatus: status, cacheGet, cacheSet, transcribe: opts.transcribe, chat: opts.chat, incrementalContext: context, sourceOffset: start, windowed: true, onMetric: metric => emit({ type: 'metric', ...metric }), onLines: incoming => publishLines(incoming, start, fingerprint) });
          signal.throwIfAborted();
          plan.incompleteRecognition ||= part.incompleteRecognition;
          plan.incompleteTranslation ||= part.incompleteTranslation;
          await publishLines(part.lines, start, fingerprint);
          coverage.push({ start, end }); coverage.sort((a, b) => a.start - b.start);
          continue;
        }
        const jumped = currentPlayhead > continuousEnd + 15;
        if (jumped) { carried = []; recognizedUntil = start; translationContext.reset(); }
        const newStart = !hasSubtitles && !jumped && recognizedUntil > start + 0.001 ? recognizedUntil : start;
        let end;
        if (hasSubtitles) {
          // Quiet coverage (including a long intro) is not a warmed speech buffer.
          // Keep startup/refill windows short until playable speech is available;
          // the 10-minute lookahead remains a background translation target.
          const playableSpeech = lines.some(line => line.end > currentPlayhead && ready.has(line.id));
          const speechAhead = playableSpeech
            ? Math.min(continuousReadySeconds(lines, ready, currentPlayhead, source.duration),
              Math.max(0, coveredUntil(currentPlayhead) - currentPlayhead)) : 0;
          const warm = playableSpeech && speechAhead >= (progressive ? 3 : Math.max(5, Number(settings.tts?.bufferSeconds) || 30));
          const maxLookahead = currentPlayhead + translateAheadSeconds(settings);
          const desiredEnd = Math.min(source.duration, warm
            ? Math.max(newStart + 24, Math.min(newStart + 120, maxLookahead))
            : newStart + (playableSpeech ? 24 : 12));
          end = subtitleWindowEnd(source.subtitles, newStart, Math.min(desiredEnd, ...coverage.filter(r => r.start > newStart).map(r => r.start)), source.duration);
          if (warm) {
            // Use the same speaker boundaries as prepareDubPlan. Otherwise null
            // speakers merge here but expand into dozens of units during translation.
            const windowCues = source.subtitles.filter(cue => cue.end > newStart && cue.start < end).map((cue, index) => ({ ...cue, src: stripSubtitleDirections(cue.src || cue.text || ''), ...subtitleSpeaker(cue, plan.spans, index) })).filter(cue => cue.src);
            const units = groupSentences(windowCues);
            if (units.length > 15) end = subtitleWindowEnd(source.subtitles, newStart, units[14].end, source.duration);
          }
        } else {
          const span = (coverage.length || carried.length) ? 24 : 12;
          end = Math.min(source.duration, newStart + span, ...coverage.filter(r => r.start > newStart).map(r => r.start));
        }
        if (!(end > newStart)) { await sleep(100); continue; }
        const slice = hasSubtitles ? null : await source.slice(newStart, end - newStart);
        if (!hasSubtitles && !slice) throw new Error('原音轨切片缺失');
        const fingerprint = hasSubtitles ? await dubKey({ source: plan.sourceKey, start: newStart, end, subtitles: source.subtitles }) : await dubBlobKey(slice.blob);
        const spans = plan.spans.length ? plan.spans.filter(s => s.end > newStart && s.start < end).map(s => ({ ...s, start: Math.max(s.start, newStart) - newStart, end: Math.min(s.end, end) - newStart }))
          : [{ start: 0, end: end - newStart, kind: 'unknown', speaker: null }];
        const later = hasSubtitles
          ? groupSentences(source.subtitles.filter(cue => cue.start >= end - 1e-6).map(cue => ({ ...cue, src: stripSubtitleDirections(cue.src || cue.text || '') })).filter(cue => cue.src)).slice(0, 4).map(unit => ({ id: unit.id, src: unit.src }))
          : [];
        status(hasSubtitles ? `正在准备 ${Math.floor(newStart)}–${Math.ceil(end)} 秒的口播翻译与配音…` : `正在后台准备 ${Math.floor(newStart)}–${Math.ceil(end)} 秒的中文配音…`);
        const partSubtitles = hasSubtitles ? source.subtitles.filter(cue => cue.end > newStart && cue.start < end) : null;
        const part = await prepareDubPlan({ source: {
          duration: end - newStart,
          subtitles: partSubtitles ? partSubtitles.map(cue => ({ ...cue, start: Math.max(0, cue.start - newStart), end: Math.min(end - newStart, cue.end - newStart) })) : null,
          analyze: async () => ({ duration: end - newStart, fingerprint, spans }),
          slice: (offset, seconds) => source.slice(newStart + offset, seconds),
        }, settings, signal, status: () => {}, recoveryStatus: status, cacheGet, cacheSet, transcribe: opts.transcribe, chat: opts.chat, sourceOffset: newStart,
          onMetric: metric => emit({ type: 'metric', ...metric }),
          translationContext, onLines: incoming => publishLines(incoming, newStart, fingerprint),
          prefixCues: carried.map(cue => ({ ...cue, start: cue.start - newStart, end: cue.end - newStart })),
          priorLines: lines.filter(line => line.end <= newStart + 0.001).slice(-12),
          deferUnfinished: !hasSubtitles && end < source.duration - 0.05,
          extraLookahead: later, windowed: true, skipBrief: hasSubtitles, getBrief: () => briefBox.text,
          setBrief: text => { if (text && !briefBox.full) briefBox.text = text; },
        });
        signal.throwIfAborted();
        plan.incompleteRecognition ||= part.incompleteRecognition;
        plan.incompleteTranslation ||= part.incompleteTranslation;
        await publishLines(part.lines || [], newStart, fingerprint);
        const deferred = (part.deferredCues || []).map(cue => ({ ...cue, start: cue.start + newStart, end: cue.end + newStart }));
        if (!hasSubtitles) {
          const coverFrom = carried[0]?.start ?? newStart;
          const committedEnd = deferred.length ? Math.min(...deferred.map(cue => cue.start)) : end;
          if (committedEnd > coverFrom + 0.001 && (!deferred.length || part.lines?.length)) {
            coverage.push({ start: coverFrom, end: deferred.length ? committedEnd : end });
          }
          recognizedUntil = end;
          carried = deferred;
        } else {
          coverage.push({ start: newStart, end });
        }
        coverage.sort((a, b) => a.start - b.start);
      }
    })().catch(error => { productionError = error; });
    opts.onEditable?.(async (id, text) => {
      const i = lines.findIndex(l => l.id === id);
      const zh = String(text || '').trim();
      if (i < 0 || !zh || zh.length > 500) throw new Error('请输入1–500字的中文口播稿');
      const edited = lines[i] = { ...lines[i], zh };
      fullyPrepared = false;
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
    const saveCompletedPlan = async () => {
      if (fullyPrepared) return;
      fullyPrepared = true;
      if (!plan.incompleteRecognition && !plan.incompleteTranslation && !plan.incompleteAudio) await cacheSet(savedPlanKey, plan);
    };
    // One worker preserves voice-service capacity, while playback is independent.
    const failedSpeakers = new Set();
    let sharedVoice = null, sharedVoiceSearched = false, sharedVoiceRounds = 0;
    const extractReference = async line => {
      // Download time is not extraction time: slices block until the audio track is ready.
      await source.audioReady?.();
      try {
        return await withInterpretDeadline(s => prepareSpeakerReference({ line, spans: plan.spans,
          source, signal: s, voiceRef: opts.voiceRef || voiceRefFromBlob }), signal, opts.referenceTimeoutMs ?? 8000);
      } catch { signal.throwIfAborted(); return null; }
    };
    // Without diarization every cue is an unknown speaker. Sampling each cue's own
    // audio makes the cloned timbre drift line by line, so pick one clean, long
    // sample for the whole video and keep it. Voice-clone TTS also rejects
    // requests without any reference.
    const videoVoice = async current => {
      if (sharedVoice || sharedVoiceSearched) return sharedVoice;
      // First round ranks the longest early cues; later rounds only try the
      // current line, and give up after a few so failures stay cheap.
      let candidates = current ? [current] : [];
      if (!sharedVoiceRounds) {
        // Rank by speech density, not length: long cues often span intro music,
        // applause or pauses, and the clone then imitates the slow delivery.
        const density = c => speechUnits(c.src || c.text || '') / Math.max(.1, c.end - c.start);
        const pool = (source.subtitles?.length ? source.subtitles : lines).filter(c => c.end - c.start >= 3 && c.end - c.start <= 12);
        const early = pool.filter(c => c.start < 300);
        candidates = [...(early.length ? early : pool).slice().sort((a, b) => density(b) - density(a)).slice(0, 4), ...candidates];
      }
      if (++sharedVoiceRounds >= 3) sharedVoiceSearched = true;
      for (const cand of candidates) {
        const ref = await extractReference(cand);
        if (ref) { sharedVoiceSearched = true; return (sharedVoice = ref); }
      }
      return null;
    };
    // Timbre stays per speaker; tone and pacing follow each line's own original audio.
    const lineEmotion = async line => {
      if (opts.emotionReference === false || !(line.end - line.start >= 1)) return null;
      await source.audioReady?.();
      try {
        return await withInterpretDeadline(async () => {
          const sample = await source.slice(line.start, Math.min(10, line.end - line.start));
          return sample?.blob ? await (opts.voiceRef || voiceRefFromBlob)(sample.blob) : null;
        }, signal, opts.referenceTimeoutMs ?? 8000);
      } catch { signal.throwIfAborted(); return null; }
    };
    production = (async () => {
      while (!signal.aborted) {
        const audioPlayhead = Number(opts.getAudioPlayhead?.()) || 0;
        const currentPlayhead = Math.max(
          isStreamMode && streamPlayer ? streamPlayer.getCurrentSourceTime() : playhead,
          audioPlayhead
        );
        if (!pending.size) {
          if (!emittedDubComplete && lines.length > 0 && (progressive ? coveredUntil(0) >= source.duration : true)) {
            await saveCompletedPlan();
            emittedDubComplete = true;
            emit({ type: plan.incompleteRecognition || plan.incompleteTranslation || plan.incompleteAudio ? 'dub_partial' : 'dub_complete', totalLines: lines.length, duration: source.duration });
          }
          await sleep(100);
          continue;
        }
        // Seek changes priority, never discards completed work.
        const candidates = lines.filter(l => pending.has(l.id));
        const line = candidates.find(l => l.end > currentPlayhead) ?? candidates[0];
        pending.delete(line.id);
        const i = lines.indexOf(line);
        if (!ttsOn) { ready.set(line.id, { ...line, slotEnd: line.end }); continue; }
        if (line.translationStatus === 'failed') {
          ready.set(line.id, { ...line, slotEnd: line.end, fallbackOriginal: true });
          emit({ type: 'dub_gap', start: line.start, end: line.end, reason: line.failureReason });
          continue;
        }
        const productionStart = Date.now();
        const stableAudioKey = await dubKey(stableAudioIdentity({ source: plan.sourceKey, line,
          tts: ttsAudioIdentity(settings.tts), configuredKey, background: plan.background }));
        const readable = async value => {
          if (!value?.blob || !(value.audioSeconds > 0) || !Number.isFinite(value.audioSeconds)) return null;
          try { await value.blob.slice(0, 16).arrayBuffer(); return value; } catch { return null; }
        };
        let prepared = await readable(await cacheGet(stableAudioKey));
        let referenceBlob, refKey = configuredKey, key, emotionBlob = null, emotionKey = 'none';
        if (!prepared) {
          const unknownVoice = !line.speaker || line.speaker.startsWith('unassigned:');
          const referenceStart = Date.now();
          if (unknownVoice) {
            referenceBlob = await videoVoice(line);
          } else {
            referenceBlob = references.get(line.speaker);
            if (!referenceBlob && !failedSpeakers.has(line.speaker)) {
              referenceBlob = await extractReference(line);
              if (referenceBlob) references.set(line.speaker, referenceBlob);
              else failedSpeakers.add(line.speaker);
            }
          }
          emit({ type: 'metric', stage: 'reference', durationMs: Date.now() - referenceStart });
          referenceBlob ||= configuredBlob || (unknownVoice ? null : await videoVoice());
          if (referenceBlob) {
            if (!refKeys.has(referenceBlob)) refKeys.set(referenceBlob, await dubBlobKey(referenceBlob));
            refKey = refKeys.get(referenceBlob);
          }
          emotionBlob = await lineEmotion(line);
          if (emotionBlob) emotionKey = await dubBlobKey(emotionBlob);
          key = await dubKey({ source: plan.sourceKey, line, tts: ttsAudioIdentity(settings.tts), reference: refKey, emotion: emotionKey,
            background: Boolean(plan.background), version: INTERPRET_VERSION });
          prepared = await readable(await cacheGet(key));
        }

        // Global content-based TTS audio cache (reuse across different runs, seeks, or line timestamps)
        const ttsContentKey = await dubKey({
          zh: String(line.zh || '').trim(),
          tts: ttsAudioIdentity(settings.tts),
          reference: refKey,
          emotion: emotionKey,
          version: `${INTERPRET_VERSION}:tts-content`,
        });

        if (!prepared) {
          const cachedContent = await cacheGet(ttsContentKey);
          if (cachedContent?.blob) {
            try {
              await cachedContent.blob.slice(0, 16).arrayBuffer();
              const seconds = cachedContent.audioSeconds || (await (opts.audioDuration || audioDuration)(cachedContent.blob));
              if (seconds > 0) {
                prepared = {
                  ...fitDub(line, seconds, realtime ? line.end : (lines[i + 1]?.start ?? source.duration)),
                  blob: cachedContent.blob,
                  audioSeconds: seconds,
                };
                if (plan.background) {
                  prepared.backgroundBlob = (await withInterpretDeadline(() => source.slice(line.start, prepared.slotEnd - line.start, 'background'), signal, 2000))?.blob;
                }
                await cacheSet(key, prepared);
              }
            } catch {
              prepared = null;
            }
          }
        }

        if (prepared?.blob) reused++;
        if (!prepared) {
          generated++;
          status(`正在准备中文配音 ${ready.size + 1}/${lines.length}…`);
          try {
            const output = await retryInterpretRequest(s => (opts.synthesizeTts || synthesizeTts)(settings.tts, line.zh, { signal: s, referenceBlob, emotionBlob, lang: settings.tts.lang || 'ZH' }), {
              signal, attempts: realtime ? 2 : 3, timeoutMs: opts.ttsTimeoutMs ?? 90000,
              onRetry: () => status('正在重试当前句配音，已完成内容保留…'),
            });
            if (!output?.blob) throw new Error('配音生成失败');
            const seconds = await withInterpretDeadline(() => (opts.audioDuration || audioDuration)(output.blob), signal, 5000);
            if (!(seconds > 0) || !Number.isFinite(seconds)) throw new Error('配音时长无效');
            prepared = { ...fitDub(line, seconds, realtime ? line.end : (lines[i + 1]?.start ?? source.duration)), blob: output.blob, audioSeconds: seconds };
            if (plan.background) {
              try { prepared.backgroundBlob = (await withInterpretDeadline(() => source.slice(line.start, prepared.slotEnd - line.start, 'background'), signal, 2000))?.blob; }
              catch { signal.throwIfAborted(); }
            }
            await cacheSet(key, prepared);
            await cacheSet(ttsContentKey, { blob: output.blob, audioSeconds: seconds, zh: line.zh });
          } catch (error) {
            signal.throwIfAborted();
            plan.incompleteAudio = true;
            ready.set(line.id, { ...line, slotEnd: line.end, fallbackOriginal: true });
            emit({ type: 'warn', message: '本句配音未能生成，保留原声和已确认字幕，继续后续内容。' });
            emit({ type: 'dub_gap', start: line.start, end: line.end, reason: 'tts-failed' });
            continue;
          }
        }
        // Real-time delivery must not retranslate and re-synthesize an already
        // usable clip. Fit its measured duration when playing; never discard it.
        productionLatency = Math.max(productionLatency * .8, (Date.now() - productionStart) / 1000);
        emit({ type: 'metric', stage: 'tts-ready', durationMs: Date.now() - productionStart,
          audioSeconds: prepared.audioSeconds, sourceSeconds: line.end - line.start, holdSeconds: prepared.holdSeconds, reused: !key });
        if (lines.includes(line)) {
          await cacheSet(stableAudioKey, prepared);
          ready.set(line.id, prepared);
          emit({ type: 'generation_progress', reused, generated, ready: ready.size, total: lines.length,
            covered: progressive ? coveredUntil(0) : source.duration, duration: source.duration });
          emit({
            type: 'dub_segment',
            segment: {
              id: line.id,
              zh: line.zh,
              src: line.src,
              speaker: line.speaker,
              start: line.start,
              end: prepared.slotEnd || line.end,
              blob: prepared.blob,
              duration: prepared.audioSeconds || 0,
            },
          });
          if (isStreamMode && streamPlayer && ttsOn) {
            void streamPlayer.enqueue({
              id: line.id,
              zh: line.zh,
              src: line.src,
              speaker: line.speaker,
              start: line.start,
              end: prepared.slotEnd || line.end,
              blob: prepared.blob,
              duration: prepared.audioSeconds || 0,
            });
          }
        }
      }
    })().catch(error => { productionError = error; });
    if (audioOnly) {
      // Generation follows the audio playhead, never the paused video's clock.
      while (!signal.aborted) {
        if (productionError) throw productionError;
        playhead = Number(opts.getAudioPlayhead?.()) || 0;
        if (pending.size === 0 && ready.size >= lines.length &&
            (!progressive || coveredUntil(0) >= source.duration)) {
          await saveCompletedPlan();
          emit({ type: plan.incompleteRecognition || plan.incompleteTranslation || plan.incompleteAudio ? 'dub_partial' : 'dub_complete', totalLines: lines.length, duration: source.duration });
          break;
        }
        await sleep(60);
      }
    } else if (isStreamMode && streamPlayer) {
      status('正在流式播报中文译音（已开启无间隔连续播放）…');
      await speaker(Boolean(opts.wantOriginalAudio?.()) || !ttsOn).catch(() => {});

      while (!signal.aborted) {
        if (productionError) throw productionError;
        const streamSourceTime = streamPlayer.getCurrentSourceTime();
        playhead = streamSourceTime;

        await speaker(Boolean(opts.wantOriginalAudio?.()) || !ttsOn).catch(() => {});

        const allProduced = pending.size === 0 && ready.size >= lines.length && (progressive ? coveredUntil(playhead) >= source.duration : true);
        if (allProduced) await saveCompletedPlan();
        if (allProduced && !streamPlayer.streamClosed) {
          streamPlayer.closeStream();
        }

        if (allProduced && streamPlayer.state === 'idle' && streamPlayer.queue.length === 0 && streamPlayer.scheduledItems.length === 0) {
          break;
        }

        await sleep(60);
      }
    } else {
    let buffering = true;
    let refill = false, waitSince = 0;
    while (!signal.aborted) {
      if (productionError) throw productionError;
      const state = await read();
      playhead = state.currentTime;
      if (revision !== undefined && state.seekRevision !== revision) {
        clearAudio(); completed.clear(); buffering = true; refill = false; waitSince = 0; translationContext.reset();
        status('已跳转，正在读取对应位置的配音缓存…');
      }
      revision = state.seekRevision;
      if (state.seeking) { active?.pause(); await sleep(50); continue; }
      if (pending.size === 0 && ready.size >= lines.length && (!progressive || coveredUntil(0) >= source.duration)) await saveCompletedPlan();
      if (state.ended && !active) break;
      currentIndex = lines.findIndex(l => l.end > playhead && !completed.has(l.id));
      const quietUntil = progressive && !full ? knownQuietUntil(playhead, { lines, subtitles: source?.subtitles, spans: plan?.spans, subtitlesComplete: source?.subtitlesComplete === true }) : null;
      if (quietUntil && !active) {
        buffering = false;
        await speaker(true);
        if (!state.userPaused && !state.ended) await resume();
        if (stageHint !== '无台词，播放原声') {
          shown = null;
          status('无台词，播放原声');
        }
        await sleep(state.userPaused ? 200 : 50);
        continue;
      }
      const knownEnd = progressive ? coveredUntil(playhead) : source.duration;
      const rate = Math.max(.25, Number(state.playbackRate) || 1);
      const ahead = Math.min(continuousReadySeconds(lines, ready, playhead, source.duration), Math.max(0, knownEnd - playhead)) / rate;
      if (progressive && knownEnd <= playhead && playhead < source.duration && !active) {
        if (!buffering) refill = true;
        buffering = true;
      }
      const isPureAudio = false; // Video sync never changes mode based on another player.
      if (buffering) {
        const bufferTarget = realtime ? bufferingTarget({ refill, configured: target, latencySeconds: productionLatency, playbackRate: rate, remaining: source.duration - playhead }) : target;
        const nextReady = currentIndex >= 0 && ready.has(lines[currentIndex].id);
        // Start with the first complete utterance. A refill deadline relaxes the
        // waterline, never advances past speech whose request is still pending.
        const waited = waitSince && Date.now() - waitSince >= (opts.playbackWaitMs ?? 8000);
        const enough = full ? ready.size === lines.length :
          (realtime && nextReady && (!refill || waited)) || ahead >= Math.min(bufferTarget, (source.duration - playhead) / rate);
        if (!enough) {
          if (!waitSince || state.userPaused) waitSince = Date.now();
          if (!isPureAudio) {
            await hold();
            showWait(full ? `画面已暂停，等待完整配音 ${ready.size}/${lines.length}…` : `画面已暂停，连续配音缓冲 ${Math.floor(ahead)}/${bufferTarget} 秒…`);
          }
          await sleep(100); continue;
        }
        if (waitSince) emit({ type: 'metric', stage: 'buffer-wait', durationMs: Date.now() - waitSince });
        waitSince = 0; buffering = false;
        refill = false;
      }
      const next = currentIndex < 0 ? null : lines[currentIndex];
      if (!active && next && playhead >= next.start - .04) {
        let item = ready.get(next.id);
        if (!item) { buffering = true; refill = true; if (!isPureAudio) await hold(); continue; }
        // Refit even cached audio against the currently known next turn. Never
        // borrow unprocessed time; later windows may contain another speaker.
        if (ttsOn && item.audioSeconds > 0) {
          const nextStart = lines[currentIndex + 1]?.start ?? knownEnd;
          item = { ...item, ...fitDub(next, item.audioSeconds, Math.min(nextStart, knownEnd)) };
          ready.set(next.id, item);
        }
        if (!ttsOn || item.fallbackOriginal) {
          completed.add(item.id);
          shown = item.id; emit({ type: 'line', ...item });
        } else if (isPureAudio) {
          // In pure audio mode, StreamingAudioPlayer handles dub playback.
          // Do not play active audio through the video element loop.
          shown = item.id;
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
      if (shown && !active && !speechNow && !isPureAudio) {
        shown = null;
        emit({ type: 'status', clearLine: true, message: '间奏 / 停顿', hint: '' });
      }
      if (!isPureAudio) {
        await speaker(Boolean(opts.wantOriginalAudio?.()) || !ttsOn || lines.some(l => l.start <= playhead && l.end > playhead && ready.get(l.id)?.fallbackOriginal));
      }
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
            if (!firstPlay && active === voice) { firstPlay = true; emit({ type: 'metric', stage: 'first-play', durationMs: Date.now() - startedAt }); }
          } catch (error) { if (active === voice || signal.aborted) throw error; }
        }
      } else {
        if (!isPureAudio) {
          await resume();
        }
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
      await sleep(state?.userPaused ? 200 : 50);
    }
    }
    signal.throwIfAborted();
    if (plan.incompleteRecognition) emit({ type: 'warn', message: '部分人声重试后仍无法确认，已跳过；可重试补全，已完成分段会复用，当前结果未标记为完整音频。' });
    return { mode: 'audio', lines, captions: linesToCaptions(lines), prepared: ready.size, streamPlayer,
      complete: !plan.incompleteRecognition && !plan.incompleteTranslation && !plan.incompleteAudio };
  } finally {
    controller.abort(); preparing = false; clearAudio();
    streamPlayer?.stop();
    await preparationMonitor;
    await Promise.all([production, planning]);
    if (watching) {
      const state = await read().catch(() => null);
      if (muted) await video('restore').catch(() => {});
      if (!audioOnly && !isStreamMode && held && state && !state.userPaused && !state.ended) await video('control', { action: 'play', system: true }).catch(() => {});
      await video('unwatch').catch(() => {});
    }
    await source?.close();
    opts.signal?.removeEventListener('abort', stop);
    try {
      const dubbedSegments = [];
      for (const line of plan?.lines || []) {
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
      if (!opts.signal?.aborted && fullyPrepared && !plan.incompleteRecognition && !plan.incompleteTranslation && !plan.incompleteAudio && videoId && dubbedSegments.length > 0 && dubbedSegments.length === plan.lines.length) {
        opts.onEvent?.({ type: 'status', message: '整段配音已生成，正在拼接并保存完整音频…' });
        const compactAudio = await composeCompactDubTrack(dubbedSegments, { sampleRate: 24000, gapMs: 250 });
        const fullAudio = await composeFullDubTrack(dubbedSegments, { totalDuration: source?.duration || 0 });
        opts.signal?.throwIfAborted();
        const archive = await saveFullMediaArchive({
          videoId,
          title: opts.title || '视频同传',
          url: opts.sourceUrl,
          duration: source?.duration || 0,
          compactDuration: compactAudio.duration,
          lines: plan.lines,
          cues: linesToCaptions(plan.lines).cues,
          compactCues: compactAudio.cues,
          audioBlob: fullAudio,
          compactAudioBlob: compactAudio.blob,
          processingVersion: DUB_ARCHIVE_VERSION,
          complete: true,
        });
        if (!opts.signal?.aborted) opts.onEvent?.({ type: 'archive_saved', mode: 'audio', archive });
      }
    } catch (error) {
      if (!opts.signal?.aborted) opts.onEvent?.({ type: 'warn', message: '完整音频拼接或保存失败：' + error.message });
    }
    void pruneDubCache();
  }
}

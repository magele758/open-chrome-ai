/**
 * Pure interpretation helpers (cue timing, translation cleanup, captions, voice
 * samples). The production engine is `planned-interpret.js`.
 */
import { debugLog } from "./debug-log.js";
import { sleep } from "./chrome.js";
import { completeChat } from "./openai.js";
import { checkSpeechText, isWhisperHallucination } from "./speech-quality.js";
import { isModelReady } from "./storage.js";
import { isQuietBlob, voiceSample } from "./tab-audio-record.js";
import { withInterpretDeadline, validateSemanticTranslation } from "./interpret-semantic.js";
import { splitZhProportional } from "./dub-sentences.js";
import { blobToWav, encodeMonoWav } from "./tts.js";
import { collapseRollingCues } from "./asr.js";

export const CHUNK_SECONDS = 5;
export const VOICE_SAMPLE_SECONDS = 4;
export const LOOKAHEAD_MAX_CUES = 4;
export const LOOKAHEAD_MAX_SECONDS = 20;
export const OPENING_READY_TTS = 3;
export const OPENING_READY_TEXT = 1;

export function openingReadyCount(ttsOn, { bufferSegments } = {}) {
  const custom = Number(bufferSegments);
  if (ttsOn && Number.isFinite(custom) && custom >= 1) {
    return Math.min(10, Math.max(1, Math.round(custom)));
  }
  const n = ttsOn ? OPENING_READY_TTS : OPENING_READY_TEXT;
  return Math.min(LOOKAHEAD_MAX_CUES, Math.max(1, n));
}

export const SEEK_BACK_SECONDS = 0.8;
export const SEEK_FORWARD_SECONDS = 3.2;
export const DISPLAY_LEAD_SECONDS = 0.2;
export const DISPLAY_LATE_GRACE_SECONDS = 1.25;
export const STALE_AFTER_END_SECONDS = 2.4;
export const MAX_PROCESS_LAG_SECONDS = 2.8;
export const SYNC_HOLD_PENDING = 6;

const TRANSLATE_SYSTEM =
  "你是同声传译员。忠实地将当前口语译成简体中文，只输出当前原文的译文，不要引号、解释或原文。保留否定、条件、比较、数字、因果和不确定语气。前面的对话仅供理解指代与统一术语，不能重复翻译。专名不确定时保留原名。输入可能是未说完的分句，不得编造后半句、补充结论或遗漏内容。";

export function chineseRatio(text) {
  const s = String(text || "");
  if (!s) return 0;
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const letters = (s.match(/[A-Za-z\u4e00-\u9fff]/g) || []).length;
  const den = letters || s.replace(/\s/g, "").length || 1;
  return cjk / den;
}

export function shouldTranslate(text) {
  return chineseRatio(text) < 0.5;
}

export function isValidChineseTranslation(zh, src = "") {
  const text = String(zh || "").trim();
  if (!text) return false;
  if (/[\u4e00-\u9fff]/.test(text)) return true;
  if (/[A-Za-z]/.test(src)) return false;
  return true;
}

export function cueKey(cue) {
  return `${Number(cue?.start || 0).toFixed(2)}|${String(cue?.text || "").slice(0, 48)}`;
}

/** Display/VTT clocks and YouTube karaoke tags must never go to translate/TTS. */
export function stripTimeline(text) {
  let s = String(text || "");
  if (!s) return "";
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, " ");
  s = s.replace(/&nbsp;/gi, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  s = s.replace(/\d{1,2}:\d{2}:\d{2}\.\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}\.\d{1,3}/g, " ");
  s = s.replace(/<\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?>/g, "");
  s = s.replace(/\[(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d+)?\]\s*/g, "");
  s = s.replace(/<\/?c(?:\.[^>]*)?>/gi, "");
  s = s.replace(/<\/?(?:i|b|u|ruby|rt|v|lang)(?:\s[^>]*)?>/gi, "");
  s = s.replace(/<[^>]+>/g, "");
  return s.replace(/\s+/g, " ").trim();
}

export function timedCues(cues) {
  return collapseRollingCues((Array.isArray(cues) ? cues : [])
    .map((cue) => ({
      ...cue,
      start: Number(cue?.start),
      text: stripTimeline(cue?.text),
    }))
    .filter((cue) => cue.text && Number.isFinite(cue.start)));
}

/** Stale player reads jump to ~0 while the real clock is mid-video. */
export function isImplausibleReset(prev, next) {
  if (!Number.isFinite(prev) || !Number.isFinite(next)) return false;
  return prev > 5 && next < 1;
}

export function withCueEnds(cues) {
  const list = Array.isArray(cues) ? cues : [];
  return list.map((cue, i) => {
    const start = Number(cue?.start) || 0;
    const end = Number(cue?.end);
    if (Number.isFinite(end) && end > start) return { ...cue, start, end };
    const next = Number(list[i + 1]?.start);
    if (Number.isFinite(next) && next > start) return { ...cue, start, end: next };
    const chars = String(cue?.text || "").length;
    return { ...cue, start, end: start + Math.max(2.2, Math.min(12, chars / 10)) };
  });
}

export function cueWindowEnd(cue) {
  const start = Number(cue?.start) || 0;
  const end = Number(cue?.end);
  if (Number.isFinite(end) && end > start) return end;
  const chars = String(cue?.text || "").length;
  return start + Math.max(2.2, Math.min(12, chars / 10));
}

export function pickLiveCue(cues, t, spoken) {
  const now = Number(t) || 0;
  for (const cue of cues || []) {
    const text = stripTimeline(cue?.text);
    if (!text) continue;
    const start = Number(cue.start) || 0;
    const end = cueWindowEnd(cue);
    const key = cueKey({ ...cue, text });
    if (spoken?.has?.(key)) continue;
    if (now + 0.3 >= start && now < end + 0.35) return { cue: { ...cue, text, start, end }, key };
  }
  return null;
}

export function pickLookaheadCues(cues, t, spoken, opts = {}) {
  const maxCues = Number(opts.maxCues) > 0 ? Number(opts.maxCues) : LOOKAHEAD_MAX_CUES;
  const maxSeconds = Number(opts.maxSeconds) > 0 ? Number(opts.maxSeconds) : LOOKAHEAD_MAX_SECONDS;
  const now = Number(t) || 0;
  const horizon = now + maxSeconds;
  const hits = [];
  let reserved = 0;
  for (const cue of cues || []) {
    const text = stripTimeline(cue?.text);
    if (!text) continue;
    const start = Number(cue.start) || 0;
    const end = cueWindowEnd(cue);
    const key = cueKey({ ...cue, text });
    if (now >= end + 0.35) continue;
    if (start > horizon) continue;
    if (spoken?.has?.(key)) {
      reserved += 1;
      if (reserved >= maxCues) break;
      continue;
    }
    hits.push({ cue: { ...cue, text, start, end }, key });
    if (hits.length + reserved >= maxCues) break;
  }
  return hits;
}

export function playbackRateOf(st, fallback = 1) {
  const r = Number(st?.playbackRate ?? fallback);
  if (!Number.isFinite(r) || r <= 0) return 1;
  return Math.max(0.0625, Math.min(16, r));
}

/** Wall-clock record length so the picture advances about `targetSeconds`. */
export function recordSecondsForRate(targetSeconds = CHUNK_SECONDS, rate = 1) {
  const span = Number(targetSeconds) > 0 ? Number(targetSeconds) : CHUNK_SECONDS;
  return Math.max(1.2, Math.min(12, span / playbackRateOf({ playbackRate: rate })));
}

/** Prefer video.currentTime. Wall duration is only a fallback, scaled by rate. */
export function videoSliceBounds({ start, afterTime, wallSeconds, rate, minAdvance = 0.35 } = {}) {
  const t0 = Number(start);
  const t1 = Number(afterTime);
  const r = playbackRateOf({ playbackRate: rate });
  if (Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0 + minAdvance) {
    return { start: t0, end: t1 };
  }
  const wall = Number(wallSeconds);
  const span = (Number.isFinite(wall) && wall > 0 ? wall : CHUNK_SECONDS) * r;
  const from = Number.isFinite(t0) ? t0 : 0;
  return { start: from, end: from + span };
}

function clampVideoTime(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  if (!(hi > lo)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** Map clip-relative ASR times onto the visible player's clock. */
export function mapAsrSegmentsToVideo(segments, sliceStart, sliceEnd, clipSeconds) {
  const t0 = Number(sliceStart) || 0;
  const rawEnd = Number(sliceEnd);
  const t1 = Number.isFinite(rawEnd) && rawEnd > t0 ? rawEnd : t0 + CHUNK_SECONDS;
  const span = t1 - t0;
  const clip = Number(clipSeconds);
  const list = (Array.isArray(segments) ? segments : [])
    .map((s) => ({ ...s, text: stripTimeline(s?.text) }))
    .filter((s) => s.text);
  if (!list.length) return [];

  const times = list.map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) }));
  const minT = Math.min(...times.map((s) => s.start));
  const maxT = Math.max(...times.map((s) => (Number.isFinite(s.end) ? s.end : s.start)));
  if (minT >= t0 - 0.75 && maxT <= t1 + 1.5 && maxT > t0 + 0.2) {
    return list.map((s, i) => ({
      text: s.text,
      start: clampVideoTime(times[i].start, t0, t1),
      end: clampVideoTime(Number.isFinite(times[i].end) ? times[i].end : t1, t0, t1),
    }));
  }

  let scale = 1;
  if (span > 0 && Number.isFinite(clip) && clip > 0.25 && maxT <= clip + 1.5) scale = span / clip;
  else if (span > 0 && maxT > 0) scale = span / maxT;

  return list.map((s, i) => {
    const rel0 = Math.max(0, times[i].start);
    const rel1 = times[i].end;
    const start = t0 + rel0 * scale;
    const end = Number.isFinite(rel1) ? t0 + rel1 * scale : t1;
    return {
      text: s.text,
      start: clampVideoTime(start, t0, t1),
      end: clampVideoTime(Math.max(end, start + 0.35), t0, t1),
    };
  });
}

export function speechBoundsFromAsr(segments, sliceStart, sliceEnd, clipSeconds) {
  const mapped = mapAsrSegmentsToVideo(segments, sliceStart, sliceEnd, clipSeconds);
  const t0 = Number(sliceStart) || 0;
  const rawEnd = Number(sliceEnd);
  const fallbackEnd = Number.isFinite(rawEnd) && rawEnd > t0 ? rawEnd : t0 + CHUNK_SECONDS;
  if (!mapped.length) return { start: t0, end: fallbackEnd };
  return { start: mapped[0].start, end: mapped[mapped.length - 1].end };
}

export function lineDisplayAction(videoTime, line, {
  lead = DISPLAY_LEAD_SECONDS,
  staleAfter = STALE_AFTER_END_SECONDS,
  expire = false,
} = {}) {
  const t = Number(videoTime);
  const start = Number(line?.start);
  if (!Number.isFinite(t) || !Number.isFinite(start)) return "show";
  const rawEnd = Number(line?.end);
  const until = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : start + CHUNK_SECONDS;
  if (t + lead < start) return "wait";
  if (expire && t > until + staleAfter) return "skip";
  return "show";
}

export function audioOffsetForVideo({ videoTime, start, end, audioDuration, held = false } = {}) {
  if (held) return 0;
  const span = Number(end) - Number(start);
  const lag = Number(videoTime) - Number(start);
  const dur = Number(audioDuration);
  if (!(span > 0.2) || !(dur > 0.2) || !(lag > 0.35)) return 0;
  if (lag >= span + DISPLAY_LATE_GRACE_SECONDS) return 0;
  return Math.max(0, Math.min(dur * 0.92, lag * (dur / span)));
}

export function isTooLateForDub(videoTime, line, grace = DISPLAY_LATE_GRACE_SECONDS) {
  const t = Number(videoTime);
  const start = Number(line?.start);
  if (!Number.isFinite(t) || !Number.isFinite(start)) return false;
  const rawEnd = Number(line?.end);
  const until = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : start + CHUNK_SECONDS;
  return t > until + grace;
}

export function shouldHoldForSync({ pending = 0, lagSeconds = 0, holdPending = SYNC_HOLD_PENDING } = {}) {
  if (Number(pending) >= Number(holdPending)) return true;
  return Number(lagSeconds) > MAX_PROCESS_LAG_SECONDS;
}

export async function waitForLineClock({
  line, readTime, signal, isStale = () => false, pollMs = 80,
} = {}) {
  while (!signal?.aborted && !isStale()) {
    const t = await readTime();
    if (!Number.isFinite(Number(t))) return "skip";
    const action = lineDisplayAction(t, line);
    if (action !== "wait") return action;
    await sleep(pollMs);
  }
  return "skip";
}

export function isSeekJump(prev, next, { paused = false, audioChunk = false, playbackRate = 1 } = {}) {
  if (!Number.isFinite(prev) || !Number.isFinite(next)) return false;
  if (next < prev - SEEK_BACK_SECONDS) return true;
  if (paused && Math.abs(next - prev) > SEEK_BACK_SECONDS) return true;
  const rate = playbackRateOf({ playbackRate });
  const slack = audioChunk ? CHUNK_SECONDS * rate + 2.5 : SEEK_FORWARD_SECONDS * Math.max(1, rate);
  return next > prev + slack;
}

export function pruneSpokenOnSeek(cues, spoken, t) {
  if (!spoken?.delete) return;
  const now = Number(t) || 0;
  for (const cue of cues || []) {
    if (cueWindowEnd(cue) > now - 0.5) spoken.delete(cueKey(cue));
  }
}

export function cleanTranslation(raw, fallback) {
  let s = String(raw || "").replace(/<think>[\s\S]*?<\/think>/gi, " ").trim();
  s = stripTimeline(s);
  if (!s) return checkSpeechText(stripTimeline(fallback), "语音识别");
  s = s.replace(/^```[a-z]*\n?/i, "").replace(/```$/i, "").trim();
  s = s.replace(/^(译文|翻译|中文)[:：]\s*/u, "");
  s = s.replace(/^["「『“]+|[」』"”]+$/g, "").trim();
  s = s.replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim();
  s = stripTimeline(s);
  checkSpeechText(s, "翻译结果");
  return s || checkSpeechText(stripTimeline(fallback), "语音识别");
}

export function joinSegmentText(segments) {
  return (segments || [])
    .map((s) => stripTimeline(s?.text))
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** Index-TTS prompt from a captured slice. Quiet/failed clips or non-voice audio are ignored. */
export async function voiceRefFromBlob(blob, options = {}) {
  if (!blob || isQuietBlob(blob)) return null;
  let wav = blob;
  try {
    wav = await blobToWav(blob);
  } catch {
    wav = blob;
  }
  if (options.checkQuality !== false) {
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (AC && typeof wav.arrayBuffer === "function") {
        const ctx = new AC();
        try {
          const audio = await ctx.decodeAudioData(await wav.arrayBuffer());
          const assessment = voiceSample(audio.getChannelData(0), audio.sampleRate);
          if (!assessment.ok) {
            return null; // Reject low SNR / pure noise / insufficient speech
          }
          if (assessment.gain > 1) wav = encodeMonoWav(assessment.samples, audio.sampleRate);
        } finally {
          ctx.close?.().catch(() => {});
        }
      }
    } catch {
      /* If decoding is not supported in the current environment, fallback to wav */
    }
  }
  return wav;
}

export function voiceSliceEnd(slice, fallbackSeconds = VOICE_SAMPLE_SECONDS) {
  const start = Number(slice?.start);
  const end = Number(slice?.end);
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) return end;
  if (Number.isFinite(start)) return start + (Number(fallbackSeconds) > 0 ? Number(fallbackSeconds) : VOICE_SAMPLE_SECONDS);
  return 0;
}

/** Prefer the latest slice covering t; otherwise the standing session sample. */
export function voiceRefForTime(bank, t, fallback) {
  const now = Number(t);
  if (!Number.isFinite(now) || !Array.isArray(bank)) return fallback || null;
  let best = null;
  for (const slice of bank) {
    if (!slice?.blob) continue;
    const start = Number(slice.start);
    if (!Number.isFinite(start)) continue;
    const end = voiceSliceEnd(slice);
    if (now >= start - 0.35 && now < end + 0.35) {
      if (!best || start >= best.start) best = slice;
    }
  }
  return best?.blob || fallback || null;
}

function captionPieces(line) {
  const sources = Array.isArray(line?.captionSources) ? line.captionSources : [];
  if (sources.length < 2) return null;
  const zh = String(line.zh || "").replace(/\s+/g, " ").trim();
  if (!zh) return null;
  const provided = Array.isArray(line.zhParts) ? line.zhParts : Array.isArray(line.zh_parts) ? line.zh_parts : null;
  const parts = provided && provided.length === sources.length && provided.every(part => typeof part === "string") && provided.join("").replace(/\s+/g, "") === zh.replace(/\s+/g, "")
    ? provided.map(part => String(part).trim())
    : splitZhProportional(zh, sources);
  if (parts.length !== sources.length) return null;
  return sources.map((source, index) => ({
    start: Number(source.start),
    end: Number(source.end),
    text: parts[index],
    src: String(source.src || "").trim(),
  })).filter(cue => cue.text);
}

export function linesToCaptions(lines) {
  const cues = (lines || [])
    .flatMap((line, i) => {
      const pieces = captionPieces(line);
      if (pieces) return pieces;
      const start = Number(line.start);
      const text = String(line.zh || line.src || "").replace(/\s+/g, " ").trim();
      if (!text) return [];
      const next = Number(lines[i + 1]?.start);
      const end = Number(line.end);
      return [{
        start: Number.isFinite(start) ? start : i * CHUNK_SECONDS,
        end: Number.isFinite(end) && end > start ? end : Number.isFinite(next) ? next : undefined,
        text,
        src: String(line.src || "").trim(),
      }];
    })
    .filter(Boolean);
  const text = cues
    .map((c) => {
      const mm = Math.floor(c.start / 60);
      const ss = String(Math.floor(c.start % 60)).padStart(2, "0");
      return `[${mm}:${ss}] ${c.text}`;
    })
    .join("\n");
  return { status: cues.length ? "ready" : "missing", cues, text: text.slice(0, 20000), source: "interpret" };
}

export async function translateToZh(model, text, signal, trace = {}, context = [], terms = []) {
  debugLog("translation.input", { ...trace, text });
  const src = checkSpeechText(stripTimeline(text), "语音识别");
  if (!src) return "";
  if (isWhisperHallucination(src)) {
    debugLog("translation.bypass", { ...trace, reason: "hallucination-dropped", text: src });
    return "";
  }
  if (!shouldTranslate(src)) {
    debugLog("translation.bypass", { ...trace, reason: "already-Chinese", text: src });
    return src;
  }
  if (!isModelReady(model)) {
    throw new Error("同传需要已配置的文本模型。到设置填写文本模型的 base_url / model / key。");
  }
  debugLog("translation.context", { ...trace, context });
  const raw = await withInterpretDeadline(requestSignal => completeChat(model, {
    messages: [
      { role: "system", content: TRANSLATE_SYSTEM + (terms.length ? `\n术语参考（若当前语义不符可修正）：${JSON.stringify(terms)}` : '') },
      ...context.flatMap(p => [
        { role: "user", content: p.src },
        { role: "assistant", content: p.zh },
      ]),
      { role: "user", content: src },
    ],
    temperature: 0.15,
    maxTokens: Math.min(8192, Math.max(4096, Math.ceil(src.length * 4))),
    rejectTruncated: true, lowLatency: true,
    signal: requestSignal,
  }), signal, 45000, { stage: "文本模型：翻译", trace });
  debugLog("translation.raw", { ...trace, text: raw });
  const result = cleanTranslation(raw, src);
  debugLog("translation.result", { ...trace, text: result });
  return result;
}

export async function translateSemanticPrefix(model, src, signal, context = [], trace = {}, terms = []) {
  if (!isModelReady(model)) throw new Error('同传需要已配置的文本模型。');
  const system = `${TRANSLATE_SYSTEM}\n当前输入是连续语音的缓冲，ASR 可能在半句话后误加句号，不能仅凭标点认定完整。请只翻译从开头起语义完整、可以确定的连续前缀，保留末尾尚未说完的部分。可以一次包含多个完整句子。严格返回 JSON：{"prefix":"原文已确认前缀","translation":"前缀的中文译文","suffix":"原文未完成后缀"}。prefix 与 suffix 必须逐字拼回当前输入，包括空格和标点，不得改写原文，不得切断单词。没有可确认前缀时 prefix 和 translation 都为空字符串，suffix 为全部输入。不要翻译后缀，不要附加解释。可选 terms 数组记录当前前缀与译文中确实出现的明确专名或技术术语，每项为 {"source":"原词","target":"译词"}，最多20项，不要猜测。术语参考（若当前语义不符可修正）：${JSON.stringify(terms)}`;
  debugLog('translation.input', { ...trace, text: src, semantic: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await withInterpretDeadline(requestSignal => completeChat(model, {
      messages: [
        { role: 'system', content: system },
        ...context.flatMap(p => [{ role: 'user', content: p.src }, { role: 'assistant', content: p.zh }]),
        { role: 'user', content: src },
      ],
      temperature: 0.1, maxTokens: Math.min(8192, Math.max(4096, Math.ceil(src.length * 4))),
      rejectTruncated: true, lowLatency: true, signal: requestSignal,
    }), signal, 45000, { stage: '文本模型：语义分句翻译', trace });
    signal?.throwIfAborted();
    debugLog('translation.raw', { ...trace, text: raw, semantic: true, attempt });
    try {
      const parsed = validateSemanticTranslation(raw, src);
      if (parsed.prefix) {
        parsed.translation = cleanTranslation(parsed.translation, '');
        if (!isValidChineseTranslation(parsed.translation, parsed.prefix)) throw new Error('没有返回有效的中文译文');
      }
      return parsed;
    } catch (error) {
      debugLog('translation.validation-error', { ...trace, attempt, error });
      if (attempt) throw error;
    }
  }
}

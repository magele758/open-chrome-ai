import { playFollowingVideo } from "./live-audio-playback.js";
import { openInterpretSource } from "./downloaded-audio-source.js";
import { debugId, debugLog } from "./debug-log.js";
/**
 * Live interpretation on the current tab. Never opens a new page.
 * TTS is optional overlay: translation still runs if dubbing fails.
 */

import { injectVideo, injectPageAudio, sleep } from "./chrome.js";
import { recordPageSlice } from "./tab-audio.js";
import { collapseRollingCues, filenameForMime, transcribeAudio } from "./asr.js";
import { completeChat } from "./openai.js";
import { checkSpeechText, hasRunawayRepetition, isWeakSpeechText, isWhisperHallucination } from "./speech-quality.js";
import { isAsrReady, isModelReady, isTtsReady, resolveModel } from "./storage.js";
import { assessVoiceQuality, isQuietBlob, recordSlice } from "./tab-audio-record.js";
import { createInterpretPipeline } from "./interpret-pipeline.js";
import { createSemanticBuffer, withInterpretDeadline, unfinishedSpeech, validateSemanticTranslation } from "./interpret-semantic.js";
import { createInterpretContext } from "./interpret-context.js";
import { blobToWav, synthesizeTts } from "./tts.js";
import { videoIdentity } from "./library.js";
import { composeFullDubTrack, saveFullMediaArchive } from "./audio-composer.js";

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
          const ch = audio.getChannelData(0);
          const assessment = assessVoiceQuality(ch, audio.sampleRate);
          if (!assessment.ok) {
            return null; // Reject low SNR / pure noise / insufficient speech
          }
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

export function linesToCaptions(lines) {
  const cues = (lines || [])
    .map((line, i) => {
      const start = Number(line.start);
      const text = String(line.zh || line.src || "").replace(/\s+/g, " ").trim();
      if (!text) return null;
      const next = Number(lines[i + 1]?.start);
      const end = Number(line.end);
      return {
        start: Number.isFinite(start) ? start : i * CHUNK_SECONDS,
        end: Number.isFinite(end) && end > start ? end : Number.isFinite(next) ? next : undefined,
        text,
        src: String(line.src || "").trim(),
      };
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

async function playTab(tabId, fromStart) {
  try {
    return await injectVideo(tabId, "control", { action: "play", fromStart: fromStart === true, system: true });
  } catch {
    return { ok: false };
  }
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
    maxTokens: Math.min(1800, Math.max(300, Math.ceil(src.length * 1.5))),
    rejectTruncated: true,
    signal: requestSignal,
  }), signal);
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
      temperature: 0.1, maxTokens: Math.min(3000, Math.max(1024, Math.ceil(src.length * 3))),
      rejectTruncated: true, signal: requestSignal,
    }), signal);
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

/**
 * @param {{
 *   tabId: number,
 *   settings: object,
 *   startAt?: number,
 *   openingHold?: boolean,
 *   capture: { stream: MediaStream, playback?: { setGain?: Function } },
 *   signal?: AbortSignal,
 *   wantOriginalAudio?: () => boolean,
 *   recordSlice?: (seconds: number, signal: AbortSignal) => Promise<{blob: Blob, mime?: string, seconds?: number}>,
 *   voiceRefNow?: () => Blob | null | undefined,
 *   onEvent?: (ev: object) => void,
 * }} opts
 */
export async function runInterpret(opts) {
  const { tabId, settings, capture, onEvent } = opts || {};
  if (!tabId) throw new Error("没有可同传的标签。");
  const runId = debugId("interpret");
  let chunkNumber = 0;
  debugLog("interpret.start", { runId, tabId, source: "audio", start: opts.startAt, capture: capture?.pageAudio ? "pageAudio" : "tabCapture" });
  const controller = new AbortController();
  const signal = controller.signal;
  const stop = () => controller.abort();
  const mode = "audio";
  const asr = settings?.asr;
  const textModel = resolveModel(settings, "text");
  const ttsOn = isTtsReady(settings?.tts);
  const customBuffer = opts.bufferSegments ?? opts.settings?.tts?.bufferSegments;
  const openingReady = openingReadyCount(ttsOn, { bufferSegments: customBuffer });
  const independent = Boolean(opts.sourceUrl || opts.openSource);
  let source = null;
  let sourceCursor = Number(opts.startAt) || 0;
  if (!isAsrReady(asr)) throw new Error("请先配置语音转写。");
  if (!independent && mode === "audio" && !capture?.stream) throw new Error("没有当前标签的声音。请再点一次「同声传译」。");
  opts.signal?.addEventListener("abort", stop, { once: true });
  if (opts.signal?.aborted) stop();
  const lines = [];
  const dubbedSegments = [];
  let ttsWarned = false;
  let sessionRef = null;
  const voiceBank = [];
  const emit = ev => { if (!signal.aborted) { try { onEvent?.(ev); } catch { /* UI callback */ } } };
  const status = message => emit({ type: "status", mode, message, hint: message });
  const jobSignal = job => job?.signal || signal;
  const dub = typeof opts.synthesizeTts === "function" ? opts.synthesizeTts : synthesizeTts;

  function rememberSlice(ref, range) {
    if (!ref) return null;
    sessionRef = ref;
    const item = { ref, blob: ref, start: range?.start, end: range?.end };
    voiceBank.push(item);
    if (voiceBank.length > 8) voiceBank.shift();
    return ref;
  }

  async function rememberVoice(blob, range) {
    if (!ttsOn || !blob || isQuietBlob(blob)) return null;
    const ownRef = await voiceRefFromBlob(blob);
    if (!sessionRef) sessionRef = ownRef;
    return rememberSlice(ownRef, range);
  }

  function effectiveRef(line) {
    const now = line?.ownRef;
    if (now) return now;
    return voiceRefForTime(voiceBank, line?.start, sessionRef);
  }
  const liveVoiceRef = effectiveRef;

  // Internal session switch for comparing/rolling back the semantic path.
  const semanticEnabled = opts.semanticTranslation !== false;
  const translationContext = createInterpretContext();
  const semantic = createSemanticBuffer({ modelBoundaries: true, onEvent: event => {
    if (event.type === 'semantic.gap') translationContext.reset();
    debugLog(event.type, { runId, ...event });
  } });
  async function translateUnit(line, job) {
    const s = jobSignal(job);
    try {
      const zh = line.pretranslated ?? await translateToZh(textModel, line.src, s, line.trace,
        semanticEnabled ? translationContext.snapshot() : [], semanticEnabled ? translationContext.terms() : []);
      s.throwIfAborted();
      if (semanticEnabled) translationContext.commit(line.src, zh, line.terms);
      if (line.pretranslated !== undefined) debugLog('translation.result', { ...line.trace, text: zh });
      return { ...line, zh };
    } catch (err) {
      // A missing translation must not leave stale antecedents in the context.
      if (!s.aborted) translationContext.reset();
      throw err;
    }
  }

  const pipelineCapacity = Math.max(16, openingReady * 3);
  const pipeline = createInterpretPipeline({
    signal,
    prebuffer: openingReady,
    capacity: pipelineCapacity,
    onReset: generation => { semantic.reset(generation); translationContext.reset(); },
    transform: async (item, job) => {
      if (!item) translationContext.reset();
      if (!semanticEnabled) return item?.src ? [item] : [];
      const units = semantic.push(item);
      if (units.length || !semantic.pendingText) return units;
      const pending = semantic.pendingText;
      // Chinese does not need a translation request just to detect a boundary.
      if (!shouldTranslate(pending)) {
        if (/[。！？.!?]$/.test(pending)) return semantic.flush('sentence');
        return [];
      }
      if (unfinishedSpeech(pending) && !/[.!?。！？]\s+\S/.test(pending)) return [];
      const s = jobSignal(job);
      try {
        const context = translationContext.snapshot();
        debugLog('translation.context', { ...item?.trace, context });
        const parsed = await translateSemanticPrefix(textModel, pending, s, context, item?.trace, translationContext.terms());
        s.throwIfAborted();
        if (!parsed.prefix) return [];
        return [{ ...semantic.commitPrefix(parsed.prefix), pretranslated: parsed.translation, terms: parsed.terms }];
      } catch (error) {
        if (s.aborted) throw error;
        // Preserve the tail for the next block; hard budgets still ensure progress.
        debugLog('semantic.deferred', { ...item?.trace, error });
        return [];
      }
    },
    flush: () => semanticEnabled ? semantic.flush('end') : [],
    onError: err => emit({ type: "warn", message: err?.message || String(err) }),
    prepare: async (item, job) => {
      const trace = { runId, chunk: ++chunkNumber, start: item.start, seconds: item.seconds, generation: job.generation };
      debugLog("audio.chunk", { ...trace, bytes: item.blob?.size, mime: item.mime });
      // VAD pure music / no speech pass-through: skip model calling and let background music play directly
      if (item.vad && item.vad.speechDetected === false && Number(item.vad.lastRms) < 0.015) {
        debugLog("audio.skipped", { ...trace, reason: "vad-no-speech-music-passthrough" });
        return { empty: true, start: item.start, end: item.end, trace };
      }
      try {
        const s = jobSignal(job);
        let ownRef = item.referenceBlob || null;
        if (!ownRef && item.blob) ownRef = await voiceRefFromBlob(item.blob);
        s.throwIfAborted();
        if (ownRef) rememberSlice(ownRef, { start: item.start, end: item.end });
        const segments = await withInterpretDeadline(requestSignal => transcribeAudio(asr, item.blob, {
          filename: filenameForMime(item.mime), signal: requestSignal, allowEmpty: true, trace,
        }), s);
        const src = stripTimeline(joinSegmentText(segments));
        const sliceSeconds = Number(item.end) - Number(item.start);
        if (hasRunawayRepetition(src)) {
          throw new Error("语音识别出现异常重复，已跳过本段，继续听下一段。");
        }
        const isHallucination = isWhisperHallucination(src, { sliceSeconds, segments });
        if (!src || isWeakSpeechText(src, sliceSeconds) || isHallucination || signal.aborted || s.aborted) {
          debugLog("interpret.skipped", {
            ...trace,
            reason: !src ? "empty-asr" : isHallucination ? "whisper-hallucination" : signal.aborted || s.aborted ? "cancelled" : "weak-asr",
            text: src,
          });
          return !src && !s.aborted ? { empty: true, start: item.start, end: item.end, trace } : null;
        }
        const bounds = speechBoundsFromAsr(segments, item.start, item.end, item.seconds);
        return { start: bounds.start, end: bounds.end, src, ownRef, trace };
      } catch (error) {
        debugLog("interpret.chunk-error", {
          ...trace,
          error,
          reason: /异常重复/.test(error?.message || "") ? "runaway-repetition" : /静音幻觉/.test(error?.message || "") ? "whisper-hallucination" : "request-failed",
        });
        throw error;
      }
    },
    synthesize: async (line, job) => {
      const s = jobSignal(job);
      if (signal.aborted || s.aborted) return null;
      line = await translateUnit(line, job);
      const spoken = stripTimeline(line?.zh);
      const ready = spoken ? { ...line, zh: spoken } : line;
      if (!ttsOn || line.noDub || !spoken || !isValidChineseTranslation(spoken, line.src)) {
        if (lineDisplayAction(lastTime, ready) === "show") presentLine(ready);
        return spoken ? { ...ready, dubbed: false } : null;
      }
      const referenceBlob = liveVoiceRef(ready);
      try {
        debugLog("tts.request", { ...line.trace, text: spoken, hasVoiceReference: Boolean(referenceBlob) });
        const out = await withInterpretDeadline(requestSignal => dub(settings.tts, spoken, {
          signal: requestSignal,
          lang: settings.tts.lang || "ZH",
          ...(referenceBlob ? { referenceBlob } : {}),
        }), s, 30000);
        debugLog("tts.ready", { ...line.trace, bytes: out.blob?.size });
        return { ...ready, blob: out.blob, dubbed: true, referenceBlob };
      } catch (err) {
        debugLog("tts.error", { ...line.trace, error: err });
        if (err?.name === "AbortError") return null;
        if (!ttsWarned) {
          ttsWarned = true;
          emit({ type: "warn", message: `配音未开始，仅显示译文：${err?.message || err}` });
        }
        return { ...ready, dubbed: false };
      }
    },
    play: async item => {
      if (signal.aborted || item?.trace?.generation !== pipeline.generation) return;
      if (item?.dubbed && item?.blob) {
        dubbedSegments.push({
          start: item.start,
          end: item.end,
          blob: item.blob,
          src: item.src,
          zh: item.zh,
        });
      }
      if (independent) {
        const st = await injectVideo(tabId, "state");
        handleSeek(st, { audioChunk: true });
        noteUserOverride(st);
        if (item?.trace?.generation !== pipeline.generation) return;
        await resumeSystemHoldIfAllowed();
      }
      if (!item?.dubbed || !item?.blob || typeof Audio === "undefined") {
        const action = await waitForLineClock({
          line: item,
          signal,
          isStale: () => item.trace?.generation !== pipeline.generation,
          readTime: async () => {
            const st = await injectVideo(tabId, "state");
            handleSeek(st, { audioChunk: true });
            noteUserOverride(st);
            return progressTime(st);
          },
        });
        if (action === "show") presentLine(item);
        else debugLog("interpret.skipped", { ...item.trace, reason: "clock-wait-cancelled" });
        return;
      }
      try {
        const live = await injectVideo(tabId, "state");
        handleSeek(live, { audioChunk: true });
        noteUserOverride(live);
        const lateGrace = Number.isFinite(opts.lateGraceSeconds)
          ? Number(opts.lateGraceSeconds)
          : (openingReady >= 4 ? 2.5 : DISPLAY_LATE_GRACE_SECONDS);
        if (isTooLateForDub(progressTime(live), item, lateGrace)) {
          debugLog("playback.delayed", { ...item.trace, videoTime: progressTime(live) });
          if (!userPaused && !systemHold) await holdForSystem("sync-dub");
        }
        await playFollowingVideo({
          blob: item.blob, start: item.start, end: item.end, signal,
          isStale: () => item.trace.generation !== pipeline.generation,
          readState: async () => {
            const st = await injectVideo(tabId, "state");
            handleSeek(st, { audioChunk: true });
            noteUserOverride(st);
            return { ...st, userPaused, systemHold: Boolean(systemHold) };
          },
          align: (state, audio) => ({
            action: lineDisplayAction(state.currentTime, item),
            offset: audioOffsetForVideo({
              videoTime: state.currentTime,
              start: item.start,
              end: item.end,
              audioDuration: audio?.duration,
              held: Boolean(state.systemHold),
            }),
          }),
          onStart: () => {
            playingLine = item;
            presentLine(item);
            applySpeaker().catch(() => {});
          },
          onTiming: timing => debugLog("playback.timing", { ...item.trace, ...timing }),
        });
      } catch (err) {
        debugLog("playback.error", { ...item.trace, error: err });
        if (err?.name !== "AbortError" && !ttsWarned) {
          ttsWarned = true;
          emit({ type: "warn", message: err?.message || String(err) });
        }
      } finally {
        playingLine = null;
        applySpeaker().catch(() => {});
        if (systemHold === "sync-dub") await resumeSystemHoldIfAllowed();
      }
    },
  });
  function presentLine(line) {
    if (!line || signal.aborted || line.trace?.generation !== pipeline.generation) return;
    const key = `${Number(line.start || 0).toFixed(2)}|${String(line.zh || line.src || "").slice(0, 48)}`;
    if (presentedKeys.has(key)) return;
    presentedKeys.add(key);
    lastPresented = { start: line.start, end: line.end, src: line.src, zh: line.zh };
    debugLog("interpret.line", { ...line.trace, src: line.src, zh: line.zh, identical: line.src === line.zh, tts: ttsOn });
    lines.push(line);
    emit({ type: "line", start: line.start, end: line.end, src: line.src, zh: line.zh, mode,
      utteranceId: line.utteranceId, sourceChunkIds: line.sourceChunkIds, timingQuality: line.timingQuality });
  }
  function maybeClearStale(t) {
    if (!lastPresented || !Number.isFinite(Number(t))) return;
    if (playingLine?.start === lastPresented.start) return;
    if (lineDisplayAction(t, lastPresented, { expire: true }) !== "skip") return;
    lastPresented = null;
    emit({ type: "status", mode, clearLine: true, message: "同传进行中，正在对轴…" });
  }
  const HOLD_OPENING = "opening";
  const HOLD_BACKLOG = "backlog";
  let systemHold = "";
  let userPaused = false;
  let lastTime = null;
  let lastSeekRevision = null;
  let lastPresented = null;
  let playingLine = null;
  const presentedKeys = new Set();
  let silenced = false;
  let pageTapStarted = false;

  function wantOriginal() {
    return Boolean(opts.wantOriginalAudio?.());
  }

  async function ensureSilence() {
    try {
      const r = await injectVideo(tabId, "silence");
      if (r?.ok) silenced = true;
      return r;
    } catch {
      return { ok: false };
    }
  }

  async function applySpeaker(st, { music = false } = {}) {
    if (wantOriginal() || music) {
      if (silenced || st?.silenced) {
        capture?.playback?.setGain?.(1);
        try { await injectVideo(tabId, "restore"); } catch { /* page may have closed */ }
        silenced = false;
      }
      return;
    }
    capture?.playback?.setGain?.(0);
    if (!silenced || st?.silenced === false) await ensureSilence();
  }

  async function holdForSystem(reason) {
    const paused = await injectVideo(tabId, "control", { action: "pause", system: true });
    const verified = await injectVideo(tabId, "state");
    if (!paused?.ok || !verified?.ok || !verified.paused) {
      throw new Error(reason === HOLD_BACKLOG
        ? "同传处理积压，无法暂停播放器；请暂停视频后重试。"
        : "无法暂停播放器，同传已停止。");
    }
    systemHold = reason;
  }

  function noteUserOverride(st) {
    if (!st) return;
    if (typeof st.userPaused === "boolean") userPaused = st.userPaused;
    else {
      if (st.paused && !systemHold && !st.ended) userPaused = true;
      if (!st.paused && !systemHold) userPaused = false;
    }
  }

  async function resumeSystemHoldIfAllowed() {
    if (userPaused || !systemHold || signal.aborted) return;
    if (capture?.pageAudio || pageTapStarted) await injectPageAudio(tabId, "take");
    await playTab(tabId, false);
    systemHold = "";
  }

  function progressTime(st) {
    const t = Number(st?.currentTime);
    if (!Number.isFinite(t)) return lastTime;
    if (systemHold && isImplausibleReset(lastTime, t)) return lastTime;
    return t;
  }

  function handleSeek(st, { audioChunk = false } = {}) {
    const t = progressTime(st);
    if (!Number.isFinite(t)) return;
    // Player events distinguish a seek from normal progress, including at 2x speed.
    const revision = st?.seekRevision;
    const jumped = Number.isFinite(revision)
      ? lastSeekRevision !== null && revision !== lastSeekRevision
      : isSeekJump(lastTime, t, {
        paused: !systemHold && !audioChunk && Boolean(st?.paused),
        audioChunk,
        playbackRate: playbackRateOf(st),
      });
    if (Number.isFinite(revision)) lastSeekRevision = revision;
    if (jumped) {
      pipeline.flushAhead();
      if (independent) sourceCursor = t;
      voiceBank.length = 0;
      lastPresented = null;
      presentedKeys.clear();
      emit({ type: "status", mode, clearLine: true, message: "已跳转，正在识别新位置…" });
      debugLog("playback.seek", { runId, time: t, generation: pipeline.generation });
    }
    lastTime = t;
  }

  async function takeSlice(seconds) {
    if (typeof opts.recordSlice === "function") return opts.recordSlice(seconds, signal);
    if (capture?.pageAudio || pageTapStarted) {
      return recordPageSlice(capture?.tabId || tabId, seconds, signal);
    }
    if (capture?.stream) return recordSlice(capture.stream, seconds, signal);
    return null;
  }

  async function recordCurrentSlice(seconds) {
    try {
      return await takeSlice(seconds);
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      return null;
    }
  }

  async function rememberVoice(blob, range) {
    const ref = await voiceRefFromBlob(blob);
    return rememberSlice(ref, range);
  }

  async function captureOpeningSlice(cursor) {
    if (mode !== "audio" || signal.aborted || userPaused) return { ok: false, stop: true, cursor };
    const start = Number.isFinite(Number(cursor)) ? Number(cursor) : 0;
    const generation = pipeline.generation;
    const before = await injectVideo(tabId, "state").catch(() => null);
    const rate = playbackRateOf(before);
    await playTab(tabId, false);
    let slice = null;
    try {
      slice = await recordCurrentSlice(recordSecondsForRate(CHUNK_SECONDS, rate));
    } finally {
      if (!signal.aborted && !userPaused) {
        try { await holdForSystem(HOLD_OPENING); } catch { /* keep going */ }
      }
    }
    if (signal.aborted || userPaused) return { ok: false, stop: true, cursor: start };
    const recordedSec = Number(slice?.seconds) > 0 ? Number(slice.seconds) : CHUNK_SECONDS;
    const st = await injectVideo(tabId, "state");
    if (st?.ok) {
      if (systemHold && !st.paused && !userPaused) await holdForSystem(HOLD_OPENING);
      handleSeek(st, { audioChunk: true });
      noteUserOverride(st);
    }
    const bounds = videoSliceBounds({
      start,
      afterTime: st?.currentTime,
      wallSeconds: recordedSec,
      rate: playbackRateOf(st, rate),
    });
    if (generation !== pipeline.generation || userPaused || !slice) return { ok: false, stop: true, cursor: bounds.end };
    if (isQuietBlob(slice.blob)) {
      debugLog("audio.skipped", { runId, start, bytes: slice.blob?.size, reason: "byte-size-only", phase: "opening" });
      return { ok: false, stop: false, cursor: bounds.end };
    }
    await rememberVoice(slice.blob, bounds);
    return { ok: Boolean(pipeline.enqueue({ ...slice, start: bounds.start, end: bounds.end })), stop: false, cursor: bounds.end };
  }

  async function captureOpeningAudio() {
    if (mode !== "audio") return;
    let got = 0;
    let attempts = 0;
    const maxAttempts = openingReady + 2;
    let cursor = Number.isFinite(Number(lastTime)) ? Number(lastTime) : 0;
    while (!signal.aborted && !userPaused && got < openingReady && attempts < maxAttempts) {
      attempts += 1;
      const result = await captureOpeningSlice(cursor);
      cursor = Number.isFinite(Number(result.cursor)) ? Number(result.cursor) : cursor;
      if (result.ok) got += 1;
      if (result.stop) break;
    }
  }

  function openingReadyStatus() {
    return ttsOn
      ? `画面已暂停，正在准备前 ${openingReady} 段中文配音…`
      : `画面已暂停，正在准备前 ${openingReady} 段译文…`;
  }

  async function waitForOpeningReady() {
    if (pipeline.pending) {
      if (systemHold) status(openingReadyStatus());
      if (ttsOn) await pipeline.waitUntilReady(openingReady);
      else await pipeline.waitUntilSettled(openingReady);
      const st = await injectVideo(tabId, "state");
      if (st?.ok) {
        if (systemHold && !st.paused) await holdForSystem(systemHold);
        handleSeek(st, { audioChunk: mode === "audio" });
        noteUserOverride(st);
      }
    }
    await resumeSystemHoldIfAllowed();
  }

  let clockAlive = false;
  let monitorClock = Promise.resolve();

  try {
    if (signal.aborted) return { mode, lines, captions: linesToCaptions(lines) };
    await injectVideo(tabId, "pick", { fresh: true });
    await injectVideo(tabId, "watch", { initiallyPlaying: Boolean(opts.openingHold) });
    const st0 = await injectVideo(tabId, "state");
    if (Number.isFinite(st0?.seekRevision)) lastSeekRevision = st0.seekRevision;
    if (!st0?.ok) throw new Error("找不到播放器，同传已停止。");
    const snapped = Number(opts.startAt);
    const read = Number(st0.currentTime);
    lastTime = Number.isFinite(snapped) ? snapped : (Number.isFinite(read) ? read : 0);
    if (Number.isFinite(read) && Number.isFinite(snapped) && !isImplausibleReset(snapped, read)) lastTime = read;
    if (st0.ended) {
      await applySpeaker(st0);
      return { mode, lines, captions: linesToCaptions(lines) };
    }
    if (st0.paused && !opts.openingHold) userPaused = true;
    else if (st0.paused) systemHold = HOLD_OPENING;
    else await holdForSystem(HOLD_OPENING);
    await applySpeaker(st0);
    if ((mode === "audio" || ttsOn) && capture && !capture.pageAudio) {
      try {
        const started = await injectPageAudio(tabId, "start", { fromStart: false, autoplay: false });
        pageTapStarted = Boolean(started?.ok);
      } catch { pageTapStarted = false; }
    }

    status(independent ? "播放器已暂停，正在准备独立音轨…" : `正在采集前 ${openingReady} 段声音，采音时画面会播放…`);
    clockAlive = true;
    monitorClock = (async () => {
      while (!signal.aborted && clockAlive) {
        try {
          const live = await injectVideo(tabId, "state");
          if (live?.ok) {
            handleSeek(live, { audioChunk: true });
            noteUserOverride(live);
            maybeClearStale(progressTime(live));
          }
        } catch { /* tab may have closed */ }
        await sleep(140);
      }
    })();
    if (independent) {
      if (!systemHold) await holdForSystem(HOLD_OPENING);
      const media = await injectVideo(tabId, "media");
      source = await (opts.openSource || openInterpretSource)({
        url: opts.sourceUrl, mediaUrl: /^https?:/.test(media?.src || '') ? media.src : undefined,
        signal, onProgress: p => status(p.hint || "正在准备独立音轨…"),
      });
      if (media?.duration > 0 && Math.abs(source.duration - media.duration) > 3) {
        throw new Error("下载音轨与当前视频时长不一致，无法对齐同传。请等待广告结束后重试。");
      }
      sourceCursor = Number(lastTime) || sourceCursor;
      status(openingReadyStatus());
    } else {
      await captureOpeningAudio();
      await waitForOpeningReady();
    }

    while (!signal.aborted) {
      if (independent) {
        const st = await injectVideo(tabId, "state");
        if (!st?.ok) throw new Error("找不到播放器，同传已停止。");
        if (st.ended) break;
        handleSeek(st, { audioChunk: true });
        noteUserOverride(st);
        await applySpeaker(st);
        if (pipeline.buffering && pipeline.pending > 0 && !userPaused && !systemHold) {
          await holdForSystem(HOLD_BACKLOG);
          status(`画面已暂停，正在缓冲 ${openingReady} 段配音…`);
        }
        // The producer reads downloaded audio without advancing the video.
        if (sourceCursor >= source.duration) break;
        const maxLookaheadSec = Math.max(80, openingReady * CHUNK_SECONDS * 3);
        if (pipeline.full || sourceCursor > Number(st.currentTime) + maxLookaheadSec) {
          pipeline.releasePartialBuffer();
          if (pipeline.pending === 0 && !userPaused) await resumeSystemHoldIfAllowed();
          await sleep(100);
          continue;
        }
        const generation = pipeline.generation;
        const slice = await source.slice(sourceCursor, CHUNK_SECONDS);
        if (signal.aborted) break;
        if (generation !== pipeline.generation) continue;
        if (!slice) break;
        sourceCursor = slice.end;
        pipeline.enqueue(slice);
        continue;
      }
      const holdPending = Math.max(SYNC_HOLD_PENDING, openingReady + 4);
      if (pipeline.full || shouldHoldForSync({ pending: pipeline.pending, holdPending })) {
        if (!userPaused) {
          await holdForSystem(HOLD_BACKLOG);
          status("正在集中处理配音缓冲，完成后继续播放…");
        }
        await pipeline.waitUntilPendingAtMost(Math.max(1, Math.min(3, openingReady - 2)));
        if (signal.aborted) break;
        await resumeSystemHoldIfAllowed();
      }
      const st = await injectVideo(tabId, "state");
      if (st?.ended) break;
      if (!st?.ok) throw new Error("找不到播放器，同传已停止。");
      await applySpeaker(st);
      if (systemHold && !st.paused && !userPaused) {
        await holdForSystem(systemHold);
        await sleep(200);
        continue;
      }
      handleSeek(st, { audioChunk: mode === "audio" });
      maybeClearStale(progressTime(st));
      if (st.paused) {
        if (!systemHold) userPaused = true;
        await sleep(200);
        continue;
      }
      if (userPaused && (capture?.pageAudio || pageTapStarted)) await injectPageAudio(tabId, "take");
      userPaused = false;
      const start = progressTime(st) || 0;
      const generation = pipeline.generation;
      const pauseRevision = st.pauseRevision;
      const rate = playbackRateOf(st);
      const slice = await recordCurrentSlice(recordSecondsForRate(CHUNK_SECONDS, rate));
      if (signal.aborted) break;
      const after = await injectVideo(tabId, "state");
      handleSeek(after, { audioChunk: true });
      noteUserOverride(after);
      if (!slice || generation !== pipeline.generation || userPaused ||
          (Number.isFinite(pauseRevision) && pauseRevision !== after.pauseRevision)) {
        debugLog("audio.skipped", { runId, start, reason: "transport-changed-during-capture" });
        continue;
      }
      const bounds = videoSliceBounds({
        start,
        afterTime: after.currentTime,
        wallSeconds: slice.seconds || CHUNK_SECONDS,
        rate: playbackRateOf(after, rate),
      });
      const item = { ...slice, start: bounds.start, end: bounds.end };
      if (!isQuietBlob(slice.blob)) pipeline.enqueue(item);
      else debugLog("audio.skipped", { runId, start, bytes: slice.blob?.size, reason: "byte-size-only" });
      // Yield even when a custom capture source resolves immediately.
      await sleep(0);
    }
    clockAlive = false;
    // Finish the final text segments on natural end; explicit stop cancels them.
    await pipeline.finish();

    let fullAudio = null;
    let archive = null;
    if (dubbedSegments.length > 0) {
      try {
        const lastSeg = dubbedSegments[dubbedSegments.length - 1];
        const totalDuration = Math.max(Number(lastTime) || 0, (Number(lastSeg?.end) || 0) + 1);
        fullAudio = await composeFullDubTrack(dubbedSegments, { totalDuration });
        const videoId = opts.sourceUrl ? videoIdentity(opts.sourceUrl) : null;
        if (videoId && fullAudio) {
          archive = await saveFullMediaArchive({
            videoId,
            title: opts.title || "视频同传",
            url: opts.sourceUrl,
            duration: totalDuration,
            lines,
            cues: linesToCaptions(lines).cues,
            audioBlob: fullAudio,
            processingVersion: semanticEnabled ? 'semantic-v1' : 'chunk-v0',
          });
          emit({ type: "archive_saved", archive });
        }
      } catch (composeErr) {
        debugLog("composer.error", { error: composeErr });
      }
    }

    return { mode, lines, captions: linesToCaptions(lines), fullAudio, archive };
  } finally {
    clockAlive = false;
    debugLog("interpret.end", { runId, lines: lines.length, cancelled: signal.aborted });
    controller.abort();
    await source?.close();
    await monitorClock.catch(() => {});
    await pipeline.finish();
    opts.signal?.removeEventListener("abort", stop);
    try { await injectVideo(tabId, "unwatch"); } catch { /* page closed */ }
    capture?.playback?.setGain?.(1);
    if (pageTapStarted) {
      try { await injectPageAudio(tabId, "stop"); } catch { /* page may have closed */ }
    }
    if (silenced || capture?.pageAudio) {
      try { await injectVideo(tabId, "restore"); } catch { /* page may have closed */ }
    }
    if (systemHold && !userPaused && (!independent || source)) {
      try { await playTab(tabId, false); } catch { /* page may have closed */ }
    }
  }
}

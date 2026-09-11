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
import { checkSpeechText, isWeakSpeechText, isWhisperHallucination } from "./speech-quality.js";
import { isAsrReady, isModelReady, isTtsReady, resolveModel } from "./storage.js";
import { assessVoiceQuality, isQuietBlob, recordSlice } from "./tab-audio-record.js";
import { createInterpretPipeline } from "./interpret-pipeline.js";
import { blobToWav, synthesizeTts } from "./tts.js";

export const CHUNK_SECONDS = 5;
export const VOICE_SAMPLE_SECONDS = 4;
export const LOOKAHEAD_MAX_CUES = 4;
export const LOOKAHEAD_MAX_SECONDS = 20;
export const OPENING_READY_TTS = 3;
export const OPENING_READY_TEXT = 1;

export function openingReadyCount(ttsOn) {
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
  "你是同声传译员。把用户给出的口语转成通顺的简体中文，只输出译文，不要引号、不要解释、不要原文。若输入已是中文，原样润色成可朗读的短句。";

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

export function isTooLateForDub(videoTime, line) {
  const t = Number(videoTime);
  const start = Number(line?.start);
  if (!Number.isFinite(t) || !Number.isFinite(start)) return false;
  const rawEnd = Number(line?.end);
  const until = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : start + CHUNK_SECONDS;
  return t > until + DISPLAY_LATE_GRACE_SECONDS;
}

export function shouldHoldForSync({ pending = 0, lagSeconds = 0 } = {}) {
  if (Number(pending) >= SYNC_HOLD_PENDING) return true;
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
  if (s.length > 240) s = s.slice(0, 240);
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

export async function translateToZh(model, text, signal, trace = {}) {
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
  const raw = await completeChat(model, {
    messages: [
      { role: "system", content: TRANSLATE_SYSTEM },
      { role: "user", content: src.slice(0, 800) },
    ],
    temperature: 0.15,
    maxTokens: 220,
    signal,
  });
  debugLog("translation.raw", { ...trace, text: raw });
  const result = cleanTranslation(raw, src);
  debugLog("translation.result", { ...trace, text: result });
  return result;
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
  const openingReady = openingReadyCount(ttsOn);
  const independent = Boolean(opts.sourceUrl || opts.openSource);
  let source = null;
  let sourceCursor = Number(opts.startAt) || 0;
  if (!isAsrReady(asr)) throw new Error("请先配置语音转写。");
  if (!independent && mode === "audio" && !capture?.stream) throw new Error("没有当前标签的声音。请再点一次「同声传译」。");
  opts.signal?.addEventListener("abort", stop, { once: true });
  if (opts.signal?.aborted) stop();
  const lines = [];
  let ttsWarned = false;
  let sessionRef = null;
  const voiceBank = [];
  const emit = ev => { if (!signal.aborted) { try { onEvent?.(ev); } catch { /* UI callback */ } } };
  const status = message => emit({ type: "status", mode, message, hint: message });
  const jobSignal = job => job?.signal || signal;
  const dub = typeof opts.synthesizeTts === "function" ? opts.synthesizeTts : synthesizeTts;

  function rememberSlice(blob, range) {
    if (!blob) return null;
    sessionRef = blob;
    const start = Number(range?.start);
    if (!Number.isFinite(start)) return blob;
    const end = voiceSliceEnd({ start, end: range?.end });
    voiceBank.push({ start, end, blob });
    return blob;
  }

  function liveVoiceRef(line) {
    if (line?.ownRef) return line.ownRef;
    const now = opts.voiceRefNow?.();
    if (now) return now;
    return voiceRefForTime(voiceBank, line?.start, sessionRef);
  }

  const pipeline = createInterpretPipeline({
    signal,
    prebuffer: openingReady,
    capacity: 8,
    onError: err => emit({ type: "warn", message: err?.message || String(err) }),
    prepare: async (item, job) => {
      const trace = { runId, chunk: ++chunkNumber, start: item.start, seconds: item.seconds, generation: job.generation };
      debugLog("audio.chunk", { ...trace, bytes: item.blob?.size, mime: item.mime });
      try {
        const s = jobSignal(job);
        let ownRef = item.referenceBlob || null;
        if (!ownRef && item.blob) ownRef = await voiceRefFromBlob(item.blob);
        if (ownRef) rememberSlice(ownRef, { start: item.start, end: item.end });
        const segments = await transcribeAudio(asr, item.blob, {
          filename: filenameForMime(item.mime), signal: s, allowEmpty: true, trace,
        });
        const src = stripTimeline(joinSegmentText(segments));
        const sliceSeconds = Number(item.end) - Number(item.start);
        const isHallucination = isWhisperHallucination(src, { sliceSeconds, segments });
        if (!src || isWeakSpeechText(src, sliceSeconds) || isHallucination || signal.aborted || s.aborted) {
          debugLog("interpret.skipped", {
            ...trace,
            reason: !src ? "empty-asr" : isHallucination ? "whisper-hallucination" : signal.aborted || s.aborted ? "cancelled" : "weak-asr",
            text: src,
          });
          return null;
        }
        const bounds = speechBoundsFromAsr(segments, item.start, item.end, item.seconds);
        const zh = await translateToZh(textModel, src, s, trace);
        return { start: bounds.start, end: bounds.end, src, zh, ownRef, trace };
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
      const spoken = stripTimeline(line?.zh);
      const ready = spoken ? { ...line, zh: spoken } : line;
      if (!ttsOn || !spoken || shouldTranslate(spoken)) {
        if (lineDisplayAction(lastTime, ready) === "show") presentLine(ready);
        return spoken ? { ...ready, dubbed: false } : null;
      }
      const referenceBlob = liveVoiceRef(ready);
      try {
        debugLog("tts.request", { ...line.trace, text: spoken, hasVoiceReference: Boolean(referenceBlob) });
        const out = await dub(settings.tts, spoken, {
          signal: s,
          lang: settings.tts.lang || "ZH",
          ...(referenceBlob ? { referenceBlob } : {}),
        });
        debugLog("tts.ready", { ...line.trace, bytes: out.blob?.size });
        return { ...ready, blob: out.blob, dubbed: true, referenceBlob };
      } catch (err) {
        debugLog("tts.error", { ...line.trace, error: err });
        if (!s.aborted && !signal.aborted) presentLine(ready);
        if (err?.name === "AbortError") return null;
        if (!ttsWarned) {
          ttsWarned = true;
          emit({ type: "warn", message: `配音未开始，仅显示译文：${err?.message || err}` });
        }
        return null;
      }
    },
    play: async item => {
      if (signal.aborted || item?.trace?.generation !== pipeline.generation) return;
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
        if (isTooLateForDub(progressTime(live), item)) {
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
          onStart: () => { playingLine = item; presentLine(item); },
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
    emit({ type: "line", start: line.start, end: line.end, src: line.src, zh: line.zh, mode });
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

  async function applySpeaker(st) {
    if (wantOriginal()) {
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
        if (pipeline.full || sourceCursor > Number(st.currentTime) + 40) {
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
      if (pipeline.full || shouldHoldForSync({ pending: pipeline.pending })) {
        if (!userPaused) {
          await holdForSystem(HOLD_BACKLOG);
          status("正在集中处理配音缓冲，完成后继续播放…");
        }
        await pipeline.waitUntilPendingAtMost(1);
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
    }
    clockAlive = false;
    // Finish the final text segments on natural end; explicit stop cancels them.
    await pipeline.finish();
    return { mode, lines, captions: linesToCaptions(lines) };
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

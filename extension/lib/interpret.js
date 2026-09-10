/**
 * Live interpretation on the current tab. Never opens a new page.
 * TTS is optional overlay: translation still runs if dubbing fails.
 */

import { injectVideo, injectPageAudio, sleep } from "./chrome.js";
import { recordPageSlice } from "./tab-audio.js";
import { collapseRollingCues, filenameForMime, transcribeAudio } from "./asr.js";
import { completeChat } from "./openai.js";
import { isAsrReady, isModelReady, isTtsReady, resolveModel } from "./storage.js";
import { isQuietBlob, recordSlice } from "./tab-audio-record.js";
import { createInterpretPipeline } from "./interpret-pipeline.js";
import { blobToWav, synthesizeTts } from "./tts.js";

export const CHUNK_SECONDS = 5;
export const VOICE_SAMPLE_SECONDS = 4;
export const LOOKAHEAD_MAX_CUES = 4;
export const LOOKAHEAD_MAX_SECONDS = 20;
export const OPENING_READY_TTS = 3;
export const OPENING_READY_TEXT = 2;

export function openingReadyCount(ttsOn) {
  const n = ttsOn ? OPENING_READY_TTS : OPENING_READY_TEXT;
  return Math.min(LOOKAHEAD_MAX_CUES, Math.max(1, n));
}

export const SEEK_BACK_SECONDS = 0.8;
export const SEEK_FORWARD_SECONDS = 3.2;

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

export function isSeekJump(prev, next, { paused = false, audioChunk = false } = {}) {
  if (!Number.isFinite(prev) || !Number.isFinite(next)) return false;
  if (next < prev - SEEK_BACK_SECONDS) return true;
  if (paused && Math.abs(next - prev) > SEEK_BACK_SECONDS) return true;
  const slack = audioChunk ? CHUNK_SECONDS + 2.5 : SEEK_FORWARD_SECONDS;
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
  if (!s) return stripTimeline(fallback);
  s = s.replace(/^```[a-z]*\n?/i, "").replace(/```$/i, "").trim();
  s = s.replace(/^(译文|翻译|中文)[:：]\s*/u, "");
  s = s.replace(/^["「『“]+|[」』"”]+$/g, "").trim();
  s = s.replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim();
  s = stripTimeline(s);
  if (s.length > 240) s = s.slice(0, 240);
  return s || stripTimeline(fallback);
}

export function joinSegmentText(segments) {
  return (segments || [])
    .map((s) => stripTimeline(s?.text))
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** Index-TTS prompt from a captured slice. Quiet/failed clips are ignored. */
export async function voiceRefFromBlob(blob) {
  if (!blob || isQuietBlob(blob)) return null;
  try {
    return await blobToWav(blob);
  } catch {
    return blob;
  }
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

export function captionsForInterpret(cues, useCaptions = false) {
  return useCaptions === true ? timedCues(cues) : [];
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
    return await injectVideo(tabId, "control", { action: "play", fromStart: fromStart === true });
  } catch {
    return { ok: false };
  }
}

export async function translateToZh(model, text, signal) {
  const src = stripTimeline(text);
  if (!src) return "";
  if (!shouldTranslate(src)) return src;
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
  return cleanTranslation(raw, src);
}

/**
 * @param {{
 *   tabId: number,
 *   settings: object,
 *   cues?: Array<{start:number,end?:number,text:string}>,
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
  const controller = new AbortController();
  const signal = controller.signal;
  const stop = () => controller.abort();
  const cues = withCueEnds(timedCues(opts.cues));
  const mode = cues.length ? "captions" : "audio";
  const asr = settings?.asr;
  const textModel = resolveModel(settings, "text");
  const ttsOn = isTtsReady(settings?.tts);
  const openingReady = openingReadyCount(ttsOn);
  if (!cues.length && !isAsrReady(asr)) throw new Error("没有字幕，请先配置语音转写。");
  if (mode === "audio" && !capture?.stream) throw new Error("没有当前标签的声音。请再点一次「同声传译」。");
  opts.signal?.addEventListener("abort", stop, { once: true });
  if (opts.signal?.aborted) stop();
  const lines = [];
  const spoken = new Set();
  const skipDub = new Set();
  let ttsWarned = false;
  let sessionRef = null;
  const voiceBank = [];
  const emit = ev => { if (!signal.aborted) { try { onEvent?.(ev); } catch { /* UI callback */ } } };
  const status = message => emit({ type: "status", mode, message, hint: message });
  const jobSignal = job => job?.signal || signal;
  const dub = typeof opts.synthesizeTts === "function" ? opts.synthesizeTts : synthesizeTts;

  function canTakeSlice() {
    return typeof opts.recordSlice === "function"
      || Boolean(capture?.pageAudio)
      || Boolean(capture?.stream);
  }

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
    onError: err => emit({ type: "warn", message: err?.message || String(err) }),
    prepare: async (item, job) => {
      const s = jobSignal(job);
      let ownRef = item.referenceBlob || null;
      if (!ownRef && item.blob) ownRef = await voiceRefFromBlob(item.blob);
      if (ownRef) rememberSlice(ownRef, { start: item.start, end: item.end });
      const src = stripTimeline(item.src !== undefined ? item.src : joinSegmentText(await transcribeAudio(asr, item.blob, {
        filename: filenameForMime(item.mime), signal: s,
      })));
      if (!src || signal.aborted || s.aborted) return null;
      const zh = await translateToZh(textModel, src, s);
      return { start: item.start, end: item.end, src, zh, ownRef };
    },
    synthesize: async (line, job) => {
      const s = jobSignal(job);
      if (signal.aborted || s.aborted) return null;
      const spoken = stripTimeline(line?.zh);
      const ready = spoken ? { ...line, zh: spoken } : line;
      lines.push(ready);
      emit({ type: "line", ...ready, mode });
      if (!ttsOn || !spoken || shouldTranslate(spoken)) return null;
      const referenceBlob = liveVoiceRef(ready);
      try {
        const out = await dub(settings.tts, spoken, {
          signal: s,
          lang: settings.tts.lang || "ZH",
          ...(referenceBlob ? { referenceBlob } : {}),
        });
        return { ...ready, blob: out.blob, dubbed: true, referenceBlob };
      } catch (err) {
        if (err?.name === "AbortError") return null;
        if (!ttsWarned) {
          ttsWarned = true;
          emit({ type: "warn", message: `配音未开始，仅显示译文：${err?.message || err}` });
        }
        return null;
      }
    },
    play: async item => {
      if (!item?.dubbed || !item?.blob || signal.aborted || typeof Audio === "undefined") return;
      const url = URL.createObjectURL(item.blob);
      try {
        const audio = new Audio(url);
        await new Promise((resolve, reject) => {
          audio.onended = resolve;
          audio.onerror = () => reject(new Error("中文配音播放失败"));
          const pending = audio.play();
          if (pending?.catch) pending.catch(reject);
        });
      } catch (err) {
        if (err?.name !== "AbortError" && !ttsWarned) {
          ttsWarned = true;
          emit({ type: "warn", message: err?.message || String(err) });
        }
      } finally {
        URL.revokeObjectURL(url);
      }
    },
  });
  const HOLD_OPENING = "opening";
  const HOLD_BACKLOG = "backlog";
  let systemHold = "";
  let userPaused = false;
  let lastTime = null;
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
    const paused = await injectVideo(tabId, "control", { action: "pause" });
    if (!paused?.ok) {
      throw new Error(reason === HOLD_BACKLOG
        ? "同传处理积压，无法暂停播放器；请暂停视频后重试。"
        : "无法暂停播放器，同传已停止。");
    }
    systemHold = reason;
  }

  function noteUserOverride(st) {
    if (!st) return;
    if (st.paused && !systemHold) userPaused = true;
    if (!st.paused && !systemHold) userPaused = false;
  }

  async function resumeSystemHoldIfAllowed() {
    if (userPaused || !systemHold || signal.aborted) return;
    if (capture?.pageAudio || pageTapStarted) await injectPageAudio(tabId, "take");
    await playTab(tabId, false);
    systemHold = "";
  }

  function tryEnqueueCue(hit) {
    if (!hit || pipeline.full || signal.aborted) return false;
    spoken.add(hit.key);
    try {
      if (!pipeline.enqueue({ src: hit.cue.text, start: hit.cue.start })) {
        spoken.delete(hit.key);
        return false;
      }
      return true;
    } catch {
      spoken.delete(hit.key);
      return false;
    }
  }

  function enqueueCaptionLookahead(t) {
    if (mode !== "captions") return;
    for (const hit of pickLookaheadCues(cues, t, spoken)) tryEnqueueCue(hit);
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
    if (systemHold) {
      if (isSeekJump(lastTime, t, { paused: true, audioChunk })) {
        pipeline.flushAhead();
        pruneSpokenOnSeek(cues, spoken, t);
        skipDub.clear();
        voiceBank.length = 0;
        enqueueCaptionLookahead(t);
      }
      lastTime = t;
      return;
    }
    if (isSeekJump(lastTime, t, { paused: Boolean(st?.paused), audioChunk })) {
      pipeline.flushAhead();
      pruneSpokenOnSeek(cues, spoken, t);
      skipDub.clear();
      voiceBank.length = 0;
      enqueueCaptionLookahead(t);
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

  let harvestBusy = false;
  function scheduleVoiceHarvest() {
    if (!ttsOn || harvestBusy || userPaused || systemHold || signal.aborted || !canTakeSlice()) return;
    harvestBusy = true;
    const start = Number(lastTime);
    recordCurrentSlice(VOICE_SAMPLE_SECONDS).then((slice) => rememberVoice(slice?.blob, {
      start,
      end: Number.isFinite(start) ? start + VOICE_SAMPLE_SECONDS : undefined,
    })).catch(() => {
      /* keep last sessionRef */
    }).finally(() => { harvestBusy = false; });
  }

  async function captureVoiceSample() {
    if (!ttsOn || sessionRef || signal.aborted || userPaused || !canTakeSlice()) return;
    status("正在截取原声作为配音音色…");
    await playTab(tabId, false);
    const start = Number(lastTime);
    let slice = null;
    try {
      slice = await recordCurrentSlice(VOICE_SAMPLE_SECONDS);
    } finally {
      if (!signal.aborted && !userPaused) {
        try { await holdForSystem(HOLD_OPENING); } catch { /* keep going */ }
      }
    }
    if (!await rememberVoice(slice?.blob, {
      start,
      end: Number.isFinite(start) ? start + VOICE_SAMPLE_SECONDS : undefined,
    })) {
      emit({ type: "warn", message: "未能截取原声，配音将使用设置里的参考音" });
    }
  }

  async function captureOpeningSlice(cursor) {
    if (mode !== "audio" || signal.aborted || userPaused) return { ok: false, stop: true, cursor };
    const start = Number.isFinite(Number(cursor)) ? Number(cursor) : 0;
    await playTab(tabId, false);
    let slice = null;
    try {
      slice = await recordCurrentSlice(CHUNK_SECONDS);
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
      const t = Number(st.currentTime);
      const reset = isImplausibleReset(start, t);
      const seeked = Number.isFinite(t) && !reset && isSeekJump(start, t, {
        audioChunk: true,
        paused: Boolean(st.paused),
      });
      if (seeked) handleSeek(st, { audioChunk: true });
      else if (Number.isFinite(t) && !reset) lastTime = t;
      noteUserOverride(st);
    }
    const next = Number.isFinite(Number(st?.currentTime)) && Number(st.currentTime) > start + 0.4
      ? Number(st.currentTime)
      : start + recordedSec;
    if (!slice) return { ok: false, stop: true, cursor: next };
    if (isQuietBlob(slice.blob)) return { ok: false, stop: false, cursor: next };
    await rememberVoice(slice.blob, { start, end: start + recordedSec });
    return { ok: Boolean(pipeline.enqueue({ ...slice, start })), stop: false, cursor: next };
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

  try {
    if (signal.aborted) return { mode, lines, captions: linesToCaptions(lines) };
    await injectVideo(tabId, "pick", { fresh: true });
    const st0 = await injectVideo(tabId, "state");
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

    if (mode === "captions") {
      if (ttsOn) await captureVoiceSample();
      enqueueCaptionLookahead(lastTime);
      status(openingReadyStatus());
      await waitForOpeningReady();
    } else {
      status(`画面已暂停，正在从当前进度听前 ${openingReady} 段…`);
      await captureOpeningAudio();
      await waitForOpeningReady();
    }

    while (!signal.aborted) {
      if (pipeline.full) {
        if (!userPaused) {
          await holdForSystem(HOLD_BACKLOG);
          status("处理暂时赶不上，已暂停画面等待配音…");
        }
        await pipeline.waitForRoom();
        if (signal.aborted) break;
        await resumeSystemHoldIfAllowed();
      }
      const st = await injectVideo(tabId, "state");
      if (st?.ended) break;
      if (!st?.ok) throw new Error("找不到播放器，同传已停止。");
      await applySpeaker(st);
      if (systemHold && !st.paused && !userPaused) {
        await holdForSystem(systemHold);
        enqueueCaptionLookahead(progressTime(st));
        await sleep(200);
        continue;
      }
      handleSeek(st, { audioChunk: mode === "audio" });
      if (st.paused) {
        if (!systemHold) userPaused = true;
        enqueueCaptionLookahead(progressTime(st));
        await sleep(200);
        continue;
      }
      if (userPaused && (capture?.pageAudio || pageTapStarted)) await injectPageAudio(tabId, "take");
      userPaused = false;
      if (mode === "captions") {
        scheduleVoiceHarvest();
        const now = progressTime(st);
        const live = pickLiveCue(cues, now);
        if (live && !spoken.has(live.key)) tryEnqueueCue(live);
        if (ttsOn && live && spoken.has(live.key) && !pipeline.hasAudio(live.cue.start) && !skipDub.has(live.key)) {
          if (!userPaused) {
            await holdForSystem("dub");
            status("画面已暂停，等待中文配音…");
            const ok = await pipeline.waitUntilHasAudio(live.cue.start);
            if (!ok) skipDub.add(live.key);
          }
          await resumeSystemHoldIfAllowed();
          continue;
        }
        const hit = pickLiveCue(cues, now, spoken);
        if (hit) tryEnqueueCue(hit);
        await sleep(150);
        continue;
      }
      const start = progressTime(st) || 0;
      const slice = await recordCurrentSlice(CHUNK_SECONDS);
      if (signal.aborted) break;
      if (!slice) continue;
      // Recording immediately continues on the next iteration, never waiting
      // for ASR, translation, synthesis, or playback to finish this segment.
      const item = { ...slice, start };
      if (!isQuietBlob(slice.blob)) pipeline.enqueue(item);
    }
    // Finish the final text segments on natural end; explicit stop cancels them.
    await pipeline.finish();
    return { mode, lines, captions: linesToCaptions(lines) };
  } finally {
    controller.abort();
    await pipeline.finish();
    opts.signal?.removeEventListener("abort", stop);
    capture?.playback?.setGain?.(1);
    if (pageTapStarted) {
      try { await injectPageAudio(tabId, "stop"); } catch { /* page may have closed */ }
    }
    if (silenced || capture?.pageAudio) {
      try { await injectVideo(tabId, "restore"); } catch { /* page may have closed */ }
    }
    if (systemHold && !userPaused) {
      try { await playTab(tabId, false); } catch { /* page may have closed */ }
    }
  }
}

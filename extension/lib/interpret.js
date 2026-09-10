/**
 * Live interpretation on the current tab. Never opens a new page.
 * TTS is optional overlay: translation still runs if dubbing fails.
 */

import { injectVideo, injectPageAudio, sleep } from "./chrome.js";
import { recordPageSlice } from "./tab-audio.js";
import { filenameForMime, transcribeAudio } from "./asr.js";
import { completeChat } from "./openai.js";
import { isAsrReady, isModelReady, isTtsReady, resolveModel } from "./storage.js";
import { isQuietBlob, recordSlice } from "./tab-audio-record.js";
import { createInterpretPipeline } from "./interpret-pipeline.js";
import { synthesizeTts } from "./tts.js";

export const CHUNK_SECONDS = 5;

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
    const text = String(cue?.text || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const start = Number(cue.start) || 0;
    const end = cueWindowEnd(cue);
    const key = cueKey(cue);
    if (spoken?.has?.(key)) continue;
    if (now + 0.3 >= start && now < end + 0.35) return { cue: { ...cue, text, start, end }, key };
  }
  return null;
}

export function cleanTranslation(raw, fallback) {
  let s = String(raw || "").trim();
  if (!s) return String(fallback || "").trim();
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  s = s.replace(/^```[a-z]*\n?/i, "").replace(/```$/i, "").trim();
  s = s.replace(/^(译文|翻译|中文)[:：]\s*/u, "");
  s = s.replace(/^["「『“]+|[」』"”]+$/g, "").trim();
  s = s.replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim();
  if (s.length > 240) s = s.slice(0, 240);
  return s || String(fallback || "").trim();
}

export function joinSegmentText(segments) {
  return (segments || [])
    .map((s) => String(s?.text || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
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
  const src = String(text || "").replace(/\s+/g, " ").trim();
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
 *   capture: { stream: MediaStream, playback?: { setGain?: Function } },
 *   signal?: AbortSignal,
 *   onEvent?: (ev: object) => void,
 * }} opts
 */
export async function runInterpret(opts) {
  const { tabId, settings, capture, onEvent } = opts || {};
  if (!tabId) throw new Error("没有可同传的标签。");
  const controller = new AbortController();
  const signal = controller.signal;
  const stop = () => controller.abort();
  const cues = withCueEnds((opts.cues || []).filter(c => String(c?.text || "").trim()));
  const mode = cues.length ? "captions" : "audio";
  const asr = settings?.asr;
  const textModel = resolveModel(settings, "text");
  const ttsOn = isTtsReady(settings?.tts);
  if (!cues.length && !isAsrReady(asr)) throw new Error("没有字幕，请先配置语音转写。");
  if (mode === "audio" && !capture?.stream) throw new Error("没有当前标签的声音。请再点一次「同声传译」。");
  opts.signal?.addEventListener("abort", stop, { once: true });
  if (opts.signal?.aborted) stop();
  const lines = [];
  const spoken = new Set();
  let ttsWarned = false;
  const emit = ev => { if (!signal.aborted) { try { onEvent?.(ev); } catch { /* UI callback */ } } };
  const status = message => emit({ type: "status", mode, message, hint: message });
  const pipeline = createInterpretPipeline({
    signal,
    onError: err => emit({ type: "warn", message: err?.message || String(err) }),
    prepare: async item => {
      const src = item.src !== undefined ? item.src : joinSegmentText(await transcribeAudio(asr, item.blob, {
        filename: filenameForMime(item.mime), signal,
      }));
      if (!src || signal.aborted) return null;
      const zh = await translateToZh(textModel, src, signal);
      return { start: item.start, src, zh };
    },
    synthesize: async line => {
      if (signal.aborted) return null;
      lines.push(line);
      emit({ type: "line", ...line, mode });
      if (!ttsOn || !line.zh) return null;
      try {
        const out = await synthesizeTts(settings.tts, line.zh, {
          signal,
          lang: settings.tts.lang || "ZH",
        });
        return { ...line, blob: out.blob };
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
      if (!item?.blob || signal.aborted || typeof Audio === "undefined") return;
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
  let pausedForBacklog = false;
  let wasPaused = false;
  try {
    if (signal.aborted) return { mode, lines, captions: linesToCaptions(lines) };
    await playTab(tabId, false);
    status("正在翻译字幕…");
    while (!signal.aborted) {
      if (pipeline.full) {
        const paused = await injectVideo(tabId, "control", { action: "pause" });
        if (!paused?.ok) throw new Error("同传处理积压，无法暂停播放器；请暂停视频后重试。");
        pausedForBacklog = true;
        status("处理暂时赶不上，已暂停画面等待配音…");
        await pipeline.waitForRoom();
        if (signal.aborted) break;
        if (capture?.pageAudio) await injectPageAudio(tabId, "take");
        await playTab(tabId, false);
        pausedForBacklog = false;
      }
      const st = await injectVideo(tabId, "state");
      if (st?.ended) break;
      if (!st?.ok) throw new Error("找不到播放器，同传已停止。");
      if (st.paused) {
        wasPaused = true;
        await sleep(200);
        continue;
      }
      if (wasPaused && capture?.pageAudio) await injectPageAudio(tabId, "take");
      wasPaused = false;
      if (mode === "captions") {
        const hit = pickLiveCue(cues, st.currentTime, spoken);
        if (hit) {
          spoken.add(hit.key);
          pipeline.enqueue({ src: hit.cue.text, start: hit.cue.start });
        }
        await sleep(150);
        continue;
      }
      const start = Number(st.currentTime) || 0;
      const slice = capture.pageAudio
        ? await recordPageSlice(capture.tabId, CHUNK_SECONDS, signal)
        : await recordSlice(capture.stream, CHUNK_SECONDS, signal);
      if (signal.aborted) break;
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
    if (capture?.pageAudio) {
      try { await injectVideo(tabId, "restore"); } catch { /* page may have closed */ }
    }
    if (pausedForBacklog) {
      try { await playTab(tabId, false); } catch { /* page may have closed */ }
    }
  }
}

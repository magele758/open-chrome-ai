import { formatTime } from "./prompts.js";

function trimSlash(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

export function transcriptionsUrl(baseUrl) {
  const raw = trimSlash(baseUrl);
  if (!raw) throw new Error("缺少 ASR base_url");
  if (/\/audio\/transcriptions$/i.test(raw)) return raw;
  return `${raw}/audio/transcriptions`;
}

export function filenameForMime(mime) {
  const t = String(mime || "").toLowerCase();
  if (t.includes("wav")) return "audio.wav";
  if (t.includes("mpeg") || t.includes("mp3")) return "audio.mp3";
  if (t.includes("mp4") || t.includes("m4a")) return "audio.m4a";
  if (t.includes("ogg")) return "audio.ogg";
  return "audio.webm";
}

export function silentWav(seconds = 0.2, sampleRate = 16000) {
  const n = Math.max(1, Math.floor(sampleRate * Number(seconds) || 0));
  const dataSize = n * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  return new Blob([buf], { type: "audio/wav" });
}

export function segmentsFromTranscription(json) {
  if (json == null) return [];
  if (typeof json === "string") {
    const text = json.replace(/\s+/g, " ").trim();
    return text ? [{ start: 0, text }] : [];
  }
  if (Array.isArray(json.segments)) {
    return json.segments
      .map((s) => ({
        start: Number(s?.start) || 0,
        text: String(s?.text || "").replace(/\s+/g, " ").trim(),
      }))
      .filter((s) => s.text);
  }
  const text = String(json.text || json.result || "").replace(/\s+/g, " ").trim();
  return text ? [{ start: 0, text }] : [];
}

export function formatTranscript(segments, offset = 0) {
  const cues = (segments || [])
    .map((s) => ({
      start: Math.max(0, (Number(s.start) || 0) + Number(offset || 0)),
      text: String(s.text || "").replace(/\s+/g, " ").trim(),
    }))
    .filter((c) => c.text);
  const text = cues.map((c) => `[${formatTime(c.start)}] ${c.text}`).join("\n");
  return {
    status: cues.length ? "ready" : "missing",
    cues,
    text: text.slice(0, 20000),
  };
}

async function readError(response) {
  const raw = await response.text();
  let detail = raw.slice(0, 400);
  try {
    const json = JSON.parse(raw);
    detail = json.error?.message || json.message || json.msg || detail;
  } catch {
    /* keep text */
  }
  return `${response.status} ${detail}`.trim();
}

function authHeaders(model) {
  return {
    Authorization: `Bearer ${(model.apiKey || "").trim() || "local"}`,
  };
}

async function postTranscription(model, blob, filename, extra, signal) {
  const url = transcriptionsUrl(model.baseUrl);
  const form = new FormData();
  form.append("file", blob, filename);
  form.append("model", String(model.model || "").trim());
  for (const [key, value] of Object.entries(extra || {})) {
    if (value == null || value === "") continue;
    form.append(key, String(value));
  }
  const response = await fetch(url, {
    method: "POST",
    headers: authHeaders(model),
    body: form,
    signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  const ct = (response.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("json")) return response.json();
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

/**
 * POST {base_url}/audio/transcriptions (OpenAI Whisper shape).
 * @returns {Array<{start:number,text:string}>}
 */
export async function transcribeAudio(model, blob, { filename, signal } = {}) {
  if (!blob || !blob.size) throw new Error("没有可转写的音频。");
  const name = filename || filenameForMime(blob.type);
  try {
    const json = await postTranscription(
      model,
      blob,
      name,
      { response_format: "verbose_json" },
      signal,
    );
    const segs = segmentsFromTranscription(json);
    if (segs.length) return segs;
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    const json = await postTranscription(model, blob, name, { response_format: "json" }, signal);
    const segs = segmentsFromTranscription(json);
    if (segs.length) return segs;
    throw err;
  }
  throw new Error("转写结果是空的。");
}

export async function testTranscriptions(model) {
  const started = Date.now();
  const blob = silentWav(0.25);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    await postTranscription(
      model,
      blob,
      "silent.wav",
      { response_format: "json" },
      controller.signal,
    );
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("连接超时（25s）");
    const msg = err?.message || String(err);
    if (/^4\d\d/.test(msg) && /too (short|small)|silent|duration|empty/i.test(msg)) {
      return { ok: true, ms: Date.now() - started, note: "接口可达" };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

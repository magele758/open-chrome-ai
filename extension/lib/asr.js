import { formatTime } from "./prompts.js";

function trimSlash(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

export function asrProtocol(model) {
  const preset = String(model?.preset || "");
  if (preset === "v1-transcribe" || preset === "faster-whisper") return "v1-transcribe";
  const url = String(model?.baseUrl || "");
  if (/\/v1\/transcribe/i.test(url)) return "v1-transcribe";
  return "openai";
}

export function asrOrigin(baseUrl) {
  return trimSlash(baseUrl)
    .replace(/\/v1\/transcribe$/i, "")
    .replace(/\/health$/i, "")
    .replace(/\/v1$/i, "");
}

export function transcriptionsUrl(baseUrl) {
  const raw = trimSlash(baseUrl);
  if (!raw) throw new Error("缺少 ASR base_url");
  if (/\/audio\/transcriptions$/i.test(raw)) return raw;
  return `${raw}/audio/transcriptions`;
}

export function transcribeUrl(model) {
  if (asrProtocol(model) !== "v1-transcribe") return transcriptionsUrl(model.baseUrl);
  const raw = trimSlash(model.baseUrl);
  if (!raw) throw new Error("缺少 ASR base_url");
  if (/\/v1\/transcribe$/i.test(raw)) return raw;
  if (/\/v1$/i.test(raw)) return `${raw}/transcribe`;
  return `${asrOrigin(raw)}/v1/transcribe`;
}

export function asrHealthUrl(model) {
  return `${asrOrigin(model.baseUrl)}/health`;
}

export function asrLanguageValue(model) {
  const raw = String(model?.language || "").trim();
  if (!raw || raw === "auto") return "";
  if (raw === "zh-CN" || raw === "zh-Hans") return "zh";
  return raw;
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
      .map((s) => {
        const end = Number(s?.end);
        return {
          start: Number(s?.start) || 0,
          end: Number.isFinite(end) ? end : undefined,
          text: String(s?.text || "").replace(/\s+/g, " ").trim(),
        };
      })
      .filter((s) => s.text);
  }
  const text = String(json.text || json.result || "").replace(/\s+/g, " ").trim();
  return text ? [{ start: 0, text }] : [];
}

export function formatTranscript(segments, offset = 0) {
  const cues = (segments || [])
    .map((s) => {
      const start = Math.max(0, (Number(s.start) || 0) + Number(offset || 0));
      const endRaw = Number(s.end);
      return {
        start,
        end: Number.isFinite(endRaw) ? Math.max(0, endRaw + Number(offset || 0)) : undefined,
        text: String(s.text || "").replace(/\s+/g, " ").trim(),
      };
    })
    .filter((c) => c.text);
  const text = cues.map((c) => `[${formatTime(c.start)}] ${c.text}`).join("\n");
  return {
    status: cues.length ? "ready" : "missing",
    cues,
    text,
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
  const key = (model.apiKey || "").trim();
  if (!key) return {};
  return { Authorization: `Bearer ${key}` };
}

async function parseJsonResponse(response) {
  const ct = (response.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("json")) return response.json();
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function postTranscription(model, blob, filename, extra, signal) {
  const url = transcriptionsUrl(model.baseUrl);
  const form = new FormData();
  form.append("file", blob, filename);
  const modelName = String(model.model || "").trim();
  if (modelName) form.append("model", modelName);
  for (const [key, value] of Object.entries(extra || {})) {
    if (value == null || value === "") continue;
    form.append(key, String(value));
  }
  const headers = authHeaders(model);
  if (!headers.Authorization) headers.Authorization = "Bearer local";
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: form,
    signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  return parseJsonResponse(response);
}

async function postV1Transcribe(model, blob, filename, signal) {
  const url = transcribeUrl(model);
  const form = new FormData();
  form.append("file", blob, filename);
  const lang = asrLanguageValue(model);
  if (lang) form.append("language", lang);
  form.append("task", "transcribe");
  form.append("vad_filter", "true");
  form.append("beam_size", String(Number(model.beamSize) || 5));
  const response = await fetch(url, {
    method: "POST",
    headers: authHeaders(model),
    body: form,
    signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  return parseJsonResponse(response);
}

/**
 * OpenAI `/audio/transcriptions` 或自建 `POST /v1/transcribe`。
 * @returns {Array<{start:number,end?:number,text:string}>}
 */
export async function transcribeAudio(model, blob, { filename, signal, allowEmpty = false } = {}) {
  if (!blob || !blob.size) throw new Error("没有可转写的音频。");
  const name = filename || filenameForMime(blob.type);
  if (asrProtocol(model) === "v1-transcribe") {
    const json = await postV1Transcribe(model, blob, name, signal);
    const segs = segmentsFromTranscription(json);
    if (segs.length || allowEmpty) return segs;
    throw new Error("转写结果是空的。");
  }
  try {
    const json = await postTranscription(
      model,
      blob,
      name,
      { response_format: "verbose_json" },
      signal,
    );
    const segs = segmentsFromTranscription(json);
    if (segs.length || allowEmpty) return segs;
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    const json = await postTranscription(model, blob, name, { response_format: "json" }, signal);
    const segs = segmentsFromTranscription(json);
    if (segs.length || allowEmpty) return segs;
    throw err;
  }
  throw new Error("转写结果是空的。");
}

export async function testTranscriptions(model) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    if (asrProtocol(model) === "v1-transcribe") {
      const response = await fetch(asrHealthUrl(model), { signal: controller.signal });
      if (!response.ok) throw new Error(await readError(response));
      const json = await parseJsonResponse(response);
      if (json.model_loaded === false) throw new Error("转写服务在线，但模型未加载。");
      return { ok: true, ms: Date.now() - started, note: json.model || "health ok" };
    }
    const blob = silentWav(0.25);
    await postTranscription(model, blob, "silent.wav", { response_format: "json" }, controller.signal);
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

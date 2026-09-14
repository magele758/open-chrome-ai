/**
 * Optional Index-TTS (Gradio 5 /gen_single). Unconfigured = no-op for the rest of PageLens.
 */

import { recordTabAudio } from "./tab-audio.js";

const DB_NAME = "pagelens-fs";
const STORE = "kv";
const REF_KEY = "ttsRefAudio";
const MAX_REF_BYTES = 8 * 1024 * 1024;

export const TTS_LANGS = ["ZH", "EN", "JA", "AR", "ES"];
export const VOICE_REF_SECONDS = 7;
/** IndexTTS 2.5 Gradio /gen_single emo_control_method — clone speaker from prompt wav. */
export const TTS_EMO_SAME_AS_REF = "Same as the voice reference";

let promptCache = { origin: "", key: "", file: null };

export function encodeMonoWav(samples, sampleRate) {
  const n = samples.length;
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
  for (let i = 0; i < n; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] || 0));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

export async function blobToWav(blob) {
  if (!blob) throw new Error("没有音频。");
  if (/wav/i.test(blob.type || "")) return blob;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) throw new Error("当前环境不能把音频转成 wav。");
  const ctx = new AC();
  try {
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    const n = audio.length;
    const samples = new Float32Array(n);
    const chs = Math.max(1, audio.numberOfChannels);
    for (let c = 0; c < chs; c += 1) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < n; i += 1) samples[i] += ch[i] / chs;
    }
    return encodeMonoWav(samples, audio.sampleRate);
  } finally {
    try {
      await ctx.close();
    } catch {
      /* ignore */
    }
  }
}

function trimSlash(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

export function ttsOrigin(baseUrl) {
  return trimSlash(baseUrl).replace(/\/gradio_api\/?$/i, "");
}

export function isTtsConfigured(tts) {
  return Boolean(String(tts?.baseUrl || "").trim());
}

export function buildGenSingleData({ promptFile, text, lang = "ZH", durationFactor = 1 }) {
  const factor = Number(durationFactor);
  return [
    TTS_EMO_SAME_AS_REF,
    promptFile,
    String(text || ""),
    TTS_LANGS.includes(lang) ? lang : "ZH",
    null,
    0.65,
    0, 0, 0, 0, 0, 0, 0, 0,
    "",
    false,
    120,
    Number.isFinite(factor) && factor > 0 ? factor : 1,
    true,
    0.8,
    30,
    0.8,
    0.0,
    3,
    10.0,
    1500,
  ];
}

function promptCacheKey(ref) {
  return `${ref?.bytes || 0}:${ref?.name || ""}:${ref?.type || ""}`;
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("当前环境没有 IndexedDB。"));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("打开存储失败"));
  });
}

export async function getTtsRef() {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(REF_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function captureVoiceRefFromTab(tabId, { signal, onProgress } = {}) {
  if (!tabId) throw new Error("没有可取声音的标签。请打开要配音的视频。");
  const rec = await recordTabAudio({
    tabId,
    maxSeconds: VOICE_REF_SECONDS,
    minSeconds: 3,
    fromStart: false,
    onProgress,
    signal,
  });
  const wav = await blobToWav(rec.blob);
  return setTtsRef({ blob: wav, name: "video-ref.wav", type: "audio/wav" });
}

export async function setTtsRef({ blob, name, type } = {}) {
  if (!blob || !blob.size) throw new Error("请选择参考音色 wav。");
  if (blob.size > MAX_REF_BYTES) throw new Error("参考音太大（上限 8MB）。");
  const buf = await blob.arrayBuffer();
  const db = await openDb();
  const rec = {
    name: String(name || "ref.wav").slice(0, 80),
    type: type || blob.type || "audio/wav",
    bytes: buf.byteLength,
    buffer: buf,
  };
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(rec, REF_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return { name: rec.name, bytes: rec.bytes };
}

export async function clearTtsRef() {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(REF_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}

function refToBlob(rec) {
  if (!rec?.buffer) return null;
  return new Blob([rec.buffer], { type: rec.type || "audio/wav" });
}

async function readError(response) {
  const raw = await response.text();
  let detail = raw.slice(0, 400);
  try {
    const json = JSON.parse(raw);
    detail = json.error || json.message || json.detail || detail;
  } catch {
    /* keep */
  }
  return `${response.status} ${detail}`.trim();
}

function asFileData(uploaded, origName, mime) {
  if (uploaded && typeof uploaded === "object" && uploaded.path) {
    return {
      ...uploaded,
      orig_name: uploaded.orig_name || origName,
      mime_type: uploaded.mime_type || mime,
      meta: { _type: "gradio.FileData" },
    };
  }
  const path = Array.isArray(uploaded) ? uploaded[0] : uploaded;
  return {
    path: typeof path === "string" ? path : String(path?.path || path),
    orig_name: origName,
    mime_type: mime || "audio/wav",
    meta: { _type: "gradio.FileData" },
  };
}

async function gradioUpload(origin, blob, filename, signal) {
  const form = new FormData();
  form.append("files", blob, filename);
  const urls = [`${origin}/gradio_api/upload`, `${origin}/upload`];
  let last = "";
  for (const url of urls) {
    const response = await fetch(url, { method: "POST", body: form, signal });
    if (!response.ok) {
      last = await readError(response);
      continue;
    }
    return response.json();
  }
  throw new Error(last || "参考音上传失败。");
}

function parseSseBlock(block) {
  let event = "message";
  const data = [];
  for (const line of String(block || "").split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  return { event, data: data.join("\n") };
}

function resolveGradioFileUrl(origin, file) {
  if (!file) return "";
  if (typeof file === "string") {
    if (/^https?:/i.test(file)) return file;
    if (file.startsWith("/")) return origin + file;
    return `${origin}/gradio_api/file=${file}`;
  }
  if (file.url) {
    if (/^https?:/i.test(file.url)) return file.url;
    return origin + (file.url.startsWith("/") ? file.url : `/${file.url}`);
  }
  if (file.path) return `${origin}/gradio_api/file=${file.path}`;
  return "";
}

function unwrapFile(data) {
  let cur = data;
  for (let i = 0; i < 6; i += 1) {
    if (!cur) break;
    if (Array.isArray(cur) && cur.length) {
      cur = cur[0];
      continue;
    }
    if (typeof cur === "object" && (cur.url || cur.path)) return cur;
    // IndexTTS returns gr.update(value=audio), rather than bare FileData.
    if (typeof cur === "object" && cur.__type__ === "update" && "value" in cur) {
      cur = cur.value;
      continue;
    }
    break;
  }
  return cur;
}

export async function waitGradioCall(origin, apiName, eventId, signal) {
  const response = await fetch(`${origin}/gradio_api/call/${apiName.replace(/^\//, "")}/${eventId}`, { signal });
  if (!response.ok) throw new Error(`获取配音结果失败：${await readError(response)}`);
  if (!response.body) {
    const json = await response.json();
    return json;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const chunks = buffer.split(/\r?\n\r?\n/);
      buffer = chunks.pop() || "";
      if (done && buffer.trim()) { chunks.push(buffer); buffer = ''; }
      for (const block of chunks) {
        const ev = parseSseBlock(block);
        if (!ev.data) continue;
        if (ev.event === "error") {
          let detail = ev.data;
          try { detail = JSON.parse(detail); } catch { /* plain text error */ }
          throw new Error(`配音生成失败：${String(detail || "服务未返回错误详情").slice(0, 400)}`);
        }
        if (ev.event !== "complete") continue;
        try { return JSON.parse(ev.data); }
        catch { throw new Error('配音结果连接中断：完成事件不完整。'); }
      }
      if (done) break;
    }
    throw new Error('配音结果连接中断：未收到完成事件。');
  } finally {
    // A complete event may arrive before the server closes the long-lived stream.
    try { await reader.cancel(); } catch { /* transport already closed */ }
    reader.releaseLock();
  }
}

export async function testTts(tts, { signal } = {}) {
  const origin = ttsOrigin(tts.baseUrl);
  if (!origin) throw new Error("未配置配音 base_url。");
  const started = Date.now();
  const response = await fetch(`${origin}/gradio_api/info`, { signal });
  if (!response.ok) throw new Error(await readError(response));
  const json = await response.json();
  const has = Boolean(json?.named_endpoints?.["/gen_single"]);
  if (!has) throw new Error("配音服务在线，但没有 /gen_single。");
  return { ok: true, ms: Date.now() - started };
}

export async function synthesizeTts(tts, text, { signal, lang, durationFactor, referenceBlob } = {}) {
  const origin = ttsOrigin(tts.baseUrl);
  if (!origin) throw new Error("未配置配音。到设置填写 Index-TTS 的地址并上传参考音。");
  const line = String(text || "").trim();
  if (!line) throw new Error("没有可朗读的文本。");
  if (line.length > 500) throw new Error("一次最多朗读 500 字，请分段。");
  // Per-segment references are ephemeral: never replace the user's saved voice
  // or reuse the global upload cache (equal-sized clips can contain other voices).
  const temporary = referenceBlob != null;
  const ref = temporary ? { name: "segment-ref.wav", type: referenceBlob?.type } : await getTtsRef();
  const blob = temporary ? referenceBlob : refToBlob(ref);
  if (!blob) throw new Error("还没有参考音色。到设置上传一段 3–10 秒的 wav。");
  const filename = ref.name || "ref.wav";
  const cacheKey = promptCacheKey(ref);
  let promptFile =
    !temporary && promptCache.origin === origin && promptCache.key === cacheKey && promptCache.file
      ? promptCache.file
      : null;
  if (!promptFile) {
    const uploaded = await gradioUpload(origin, blob, filename, signal);
    promptFile = asFileData(uploaded, filename, ref.type);
    if (!temporary) promptCache = { origin, key: cacheKey, file: promptFile };
  }
  const callOnce = async (dataFile) => {
    const call = await fetch(`${origin}/gradio_api/call/gen_single`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: buildGenSingleData({
          promptFile: dataFile,
          text: line,
          lang: lang || tts.lang || "ZH",
          durationFactor: durationFactor ?? tts.durationFactor ?? 1,
        }),
        // The simple /call API reads results by event_id. In Gradio 5.45,
        // a custom session_hash stores them in a different queue and the
        // GET /call/gen_single/{event_id} stream fails with "404: Not Found".
        // Omit it so Gradio uses the event_id for both sides of the call.
      }),
      signal,
    });
    if (!call.ok) throw new Error(`提交配音失败：${await readError(call)}`);
    const queued = await call.json();
    const eventId = queued.event_id || queued.eventId;
    if (!eventId) throw new Error("配音队列没有返回 event_id。");
    return waitGradioCall(origin, "gen_single", eventId, signal);
  };
  let result;
  try {
    result = await callOnce(promptFile);
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    // Re-upload only for an expired reference/queue file. Network recovery is
    // bounded by the caller; auth and server errors cannot repair a reference.
    if (!/\b404\b|file.*(?:not found|does not exist)|参考.*(?:失效|不存在)/i.test(err?.message || '')) throw err;
    if (!temporary) promptCache = { origin: "", key: "", file: null };
    const uploaded = await gradioUpload(origin, blob, filename, signal);
    promptFile = asFileData(uploaded, filename, ref.type);
    if (!temporary) promptCache = { origin, key: cacheKey, file: promptFile };
    result = await callOnce(promptFile);
  }
  const file = unwrapFile(result);
  const abs = resolveGradioFileUrl(origin, file);
  if (!abs) throw new Error("配音完成但没有音频地址。");
  const audioRes = await fetch(abs, { signal });
  if (!audioRes.ok) throw new Error(`下载合成音频失败：${await readError(audioRes)}`);
  const audioBlob = await audioRes.blob();
  return { blob: audioBlob, mime: audioBlob.type || "audio/wav" };
}

/**
 * Audio Composer and 7-Day TTL Media Archive Manager.
 * Stitches multiple TTS dubbing slices into a synchronized full-length WAV audio track
 * using OfflineAudioContext or direct PCM sample placement.
 * Manages 7-day lifecycle storage, metadata tracking, and preloaded replay.
 */

import { encodeMonoWav } from "./tts.js";
import { idbGet, idbSet, idbDel, idbListKeys } from "./idb-kv.js";

export const ARCHIVE_TTL_DAYS = 7;
export const ARCHIVE_TTL_MS = ARCHIVE_TTL_DAYS * 24 * 60 * 60 * 1000;
export const ARCHIVE_PREFIX = "pl.media.archive.";

export function calculateExpireAt(fromTime = Date.now()) {
  return Number(fromTime || Date.now()) + ARCHIVE_TTL_MS;
}

export function isArchiveExpired(expireAt) {
  const ts = Number(expireAt);
  return Number.isFinite(ts) && ts > 0 && Date.now() > ts;
}

/**
 * Extracts 16-bit mono PCM float samples from a WAV ArrayBuffer.
 */
export function extractPcmSamplesFromWav(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 44) return null;
  const v = new DataView(arrayBuffer);
  const tag = (i) => String.fromCharCode(...new Uint8Array(arrayBuffer, i, 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;

  let sampleRate = 24000;
  let channels = 1;
  let bitsPerSample = 16;
  let pcmOffset = -1;
  let pcmSize = 0;

  for (let i = 12; i + 8 <= arrayBuffer.byteLength; ) {
    const chunkTag = tag(i);
    const chunkSize = v.getUint32(i + 4, true);
    const chunkEnd = i + 8 + chunkSize;
    if (chunkEnd > arrayBuffer.byteLength) break;

    if (chunkTag === "fmt ") {
      channels = v.getUint16(i + 8 + 2, true);
      sampleRate = v.getUint32(i + 8 + 4, true);
      bitsPerSample = v.getUint16(i + 8 + 14, true);
    } else if (chunkTag === "data") {
      pcmOffset = i + 8;
      pcmSize = chunkSize;
      break;
    }
    i = chunkEnd + (chunkSize % 2);
  }

  if (pcmOffset < 0 || pcmSize <= 0) return null;

  if (bitsPerSample === 16) {
    const totalSamples = Math.floor(pcmSize / 2);
    const monoCount = Math.floor(totalSamples / channels);
    const samples = new Float32Array(monoCount);
    for (let i = 0; i < monoCount; i += 1) {
      let sum = 0;
      for (let c = 0; c < channels; c += 1) {
        const raw = v.getInt16(pcmOffset + (i * channels + c) * 2, true);
        sum += raw < 0 ? raw / 0x8000 : raw / 0x7fff;
      }
      samples[i] = sum / channels;
    }
    return { samples, sampleRate };
  }
  return null;
}

/**
 * Composes multiple timed audio segments into a single full-length WAV Blob.
 *
 * @param {Array<{ start: number, end?: number, blob: Blob }>} segments
 * @param {object} [opts]
 * @param {number} [opts.sampleRate=24000]
 * @param {number} [opts.totalDuration]
 * @returns {Promise<Blob>}
 */
export async function composeFullDubTrack(segments = [], opts = {}) {
  const validSegments = (Array.isArray(segments) ? segments : []).filter(
    (s) => s && s.blob && Number.isFinite(Number(s.start))
  );

  if (validSegments.length === 0) {
    const emptyRate = opts.sampleRate || 24000;
    return encodeMonoWav(new Float32Array(emptyRate), emptyRate);
  }

  // 1. Calculate target duration and sample rate
  let defaultRate = Number(opts.sampleRate) || 24000;
  let maxEnd = Number(opts.totalDuration) || 0;

  for (const seg of validSegments) {
    const start = Math.max(0, Number(seg.start) || 0);
    const end = Number.isFinite(Number(seg.end)) ? Number(seg.end) : start + 3;
    if (end > maxEnd) maxEnd = end;
  }
  maxEnd = Math.max(1, maxEnd);

  // 2. Try Web Audio OfflineAudioContext if available (Browser environment)
  const AC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;

  if (AC && AudioCtx && typeof AudioCtx.prototype.decodeAudioData === "function") {
    try {
      const sampleRate = defaultRate;
      const totalFrames = Math.ceil(maxEnd * sampleRate);
      const offline = new AC(1, totalFrames, sampleRate);
      const decoder = new AudioCtx();

      try {
        for (const seg of validSegments) {
          const ab = await seg.blob.arrayBuffer();
          const decoded = await decoder.decodeAudioData(ab.slice(0));
          const source = offline.createBufferSource();
          source.buffer = decoded;
          source.connect(offline.destination);
          source.start(Math.max(0, Number(seg.start) || 0));
        }
        const rendered = await offline.startRendering();
        const samples = rendered.getChannelData(0);
        return encodeMonoWav(samples, sampleRate);
      } finally {
        try { await decoder.close(); } catch { /* ignore */ }
      }
    } catch {
      // Fallback to direct PCM stitching
    }
  }

  // 3. Fast pure-JS direct PCM placement (Node.js & fallback)
  let sampleRate = defaultRate;
  const decodedSegments = [];

  for (const seg of validSegments) {
    const ab = await seg.blob.arrayBuffer();
    const pcm = extractPcmSamplesFromWav(ab);
    if (pcm && pcm.samples.length > 0) {
      sampleRate = pcm.sampleRate || sampleRate;
      const startSec = Math.max(0, Number(seg.start) || 0);
      decodedSegments.push({
        startSec,
        samples: pcm.samples,
        rate: pcm.sampleRate,
      });
      const estEnd = startSec + pcm.samples.length / pcm.sampleRate;
      if (estEnd > maxEnd) maxEnd = estEnd;
    }
  }

  const totalSamples = Math.ceil(maxEnd * sampleRate);
  const masterBuffer = new Float32Array(Math.max(sampleRate, totalSamples));

  for (const seg of decodedSegments) {
    const startIdx = Math.floor(seg.startSec * sampleRate);
    const ratio = sampleRate / seg.rate;
    const len = seg.samples.length;

    if (Math.abs(ratio - 1) < 0.01) {
      for (let i = 0; i < len; i += 1) {
        const dest = startIdx + i;
        if (dest < masterBuffer.length) {
          masterBuffer[dest] = Math.max(-1, Math.min(1, masterBuffer[dest] + seg.samples[i]));
        }
      }
    } else {
      // Simple linear resampling
      const targetLen = Math.floor(len * ratio);
      for (let i = 0; i < targetLen; i += 1) {
        const srcIdx = i / ratio;
        const i0 = Math.floor(srcIdx);
        const i1 = Math.min(len - 1, i0 + 1);
        const frac = srcIdx - i0;
        const val = seg.samples[i0] * (1 - frac) + seg.samples[i1] * frac;
        const dest = startIdx + i;
        if (dest < masterBuffer.length) {
          masterBuffer[dest] = Math.max(-1, Math.min(1, masterBuffer[dest] + val));
        }
      }
    }
  }

  return encodeMonoWav(masterBuffer, sampleRate);
}

/**
 * Saves a completed interpretation session archive into IndexedDB and Library.
 */
export async function saveFullMediaArchive({
  videoId,
  title,
  url,
  duration,
  lines = [],
  cues = [],
  audioBlob = null,
  processingVersion = 'chunk-v0',
} = {}) {
  if (!videoId) return null;
  const now = Date.now();
  const expireAt = calculateExpireAt(now);

  const archiveRecord = {
    videoId,
    processingVersion,
    title: String(title || "视频同传").trim(),
    url: String(url || ""),
    duration: Number(duration) || 0,
    createdAt: now,
    expireAt,
    lines: Array.isArray(lines) ? lines : [],
    cues: Array.isArray(cues) ? cues : [],
    audioBlob: audioBlob || null,
    hasAudio: Boolean(audioBlob && audioBlob.size > 100),
  };

  const key = ARCHIVE_PREFIX + videoId;
  await idbSet(key, archiveRecord);
  return archiveRecord;
}

/**
 * Loads media archive for a video, automatically enforcing 7-day TTL expiration.
 */
export async function loadFullMediaArchive(videoId) {
  if (!videoId) return null;
  const key = ARCHIVE_PREFIX + videoId;
  const item = await idbGet(key);
  if (!item) return null;

  if (isArchiveExpired(item.expireAt)) {
    await idbDel(key);
    return null;
  }

  const remainingMs = item.expireAt - Date.now();
  const remainingDays = Math.max(0, Math.ceil(remainingMs / (24 * 3600 * 1000)));

  return {
    ...item,
    remainingDays,
    isValid: true,
  };
}

/**
 * Automatically purges expired archives older than 7 days.
 */
export async function cleanExpiredMediaArchives() {
  const keys = await idbListKeys();
  const deleted = [];
  const now = Date.now();

  for (const key of keys || []) {
    if (typeof key === "string" && key.startsWith(ARCHIVE_PREFIX)) {
      const val = await idbGet(key);
      if (!val?.expireAt || now > Number(val.expireAt)) {
        await idbDel(key);
        deleted.push(key);
      }
    }
  }
  return deleted;
}

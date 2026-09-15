import { idbGet, idbSet, idbDel, idbListKeys } from './idb-kv.js';
const PREFIX = 'dub-v2:';
const TTL = 7 * 86400000;
export async function dubKey(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return PREFIX + [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function repairIfCorruptedArray(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const keys = Object.keys(obj).filter(k => /^\d+$/.test(k));
  if (keys.length > 0 && ('0' in obj)) {
    const nonNumeric = Object.keys(obj).filter(k => !/^\d+$/.test(k) && !['blob', 'backgroundBlob', 'blobBuffer', 'backgroundBuffer', 'mime'].includes(k));
    if (nonNumeric.length === 0) {
      const arr = [];
      for (let i = 0; i < keys.length; i++) {
        if (i in obj) arr.push(obj[i]);
      }
      return arr;
    }
  }
  return obj;
}

export async function readDubCache(key) {
  const entry = await idbGet(key);
  if (!entry || entry.expires < Date.now()) { if (entry) await idbDel(key); return null; }
  let val = entry.value;
  if (!val) return null;

  val = repairIfCorruptedArray(val);
  if (Array.isArray(val)) return val;

  // If it's a plan object with lines/cues arrays, repair them if corrupted
  if (val && typeof val === 'object') {
    if (val.lines && !Array.isArray(val.lines)) val.lines = repairIfCorruptedArray(val.lines);
    if (val.cues && !Array.isArray(val.cues)) val.cues = repairIfCorruptedArray(val.cues);
  }

  // Only audio entries have blob or blobBuffer
  const isAudio = Boolean(val && typeof val === 'object' && (val.blob || val.blobBuffer || val.backgroundBlob || val.backgroundBuffer));
  if (!isAudio) {
    return val;
  }

  try {
    let blobBuffer = val.blobBuffer;
    if (!blobBuffer && val.blob) {
      blobBuffer = await val.blob.arrayBuffer();
      val.blobBuffer = blobBuffer;
      void idbSet(key, { ...entry, value: { ...val, blob: undefined, backgroundBlob: undefined, blobBuffer } });
    }

    if (!blobBuffer || blobBuffer.byteLength < 44) {
      console.warn('[dub-cache] Corrupt/empty buffer in cache, purging key:', key);
      await idbDel(key);
      return null;
    }

    // Always create a fresh in-memory Blob from the ArrayBuffer
    val.blob = new Blob([blobBuffer], { type: val.mime || 'audio/wav' });

    let backgroundBuffer = val.backgroundBuffer;
    if (!backgroundBuffer && val.backgroundBlob) {
      try {
        backgroundBuffer = await val.backgroundBlob.arrayBuffer();
        val.backgroundBuffer = backgroundBuffer;
      } catch {}
    }
    if (backgroundBuffer && backgroundBuffer.byteLength >= 44) {
      val.backgroundBlob = new Blob([backgroundBuffer], { type: 'audio/wav' });
    } else {
      val.backgroundBlob = null;
    }

    return val;
  } catch (err) {
    console.warn('[dub-cache] Corrupt/stale blob in cache, purging key:', key, err);
    await idbDel(key);
    return null;
  }
}

export async function writeDubCache(key, value) {
  try {
    if (!value) {
      return idbSet(key, { expires: Date.now() + TTL, value });
    }
    // If value is an array (e.g. translated lines, cues, transcript segments), save as-is!
    if (Array.isArray(value)) {
      return idbSet(key, { expires: Date.now() + TTL, value });
    }
    // Only serialize blobs if value actually has audio blob properties
    if (typeof value === 'object' && (value.blob || value.backgroundBlob || value.blobBuffer || value.backgroundBuffer)) {
      let blobBuffer = value.blobBuffer;
      if (!blobBuffer && value.blob) {
        blobBuffer = await value.blob.arrayBuffer();
      }
      let backgroundBuffer = value.backgroundBuffer;
      if (!backgroundBuffer && value.backgroundBlob) {
        try { backgroundBuffer = await value.backgroundBlob.arrayBuffer(); } catch {}
      }
      const toStore = {
        ...value,
        blob: undefined,
        backgroundBlob: undefined,
        blobBuffer,
        backgroundBuffer,
        mime: value.blob?.type || value.mime || 'audio/wav',
      };
      return idbSet(key, { expires: Date.now() + TTL, value: toStore });
    }
    // Non-audio objects (plans, metadata, user edits)
    return idbSet(key, { expires: Date.now() + TTL, value });
  } catch {
    return idbSet(key, { expires: Date.now() + TTL, value });
  }
}

export async function pruneDubCache() {
  for (const key of await idbListKeys()) if (String(key).startsWith(PREFIX) && !String(key).endsWith(':cleared')) await readDubCache(key);
}

export async function clearAllDubCache() {
  for (const key of await idbListKeys()) {
    if (String(key).startsWith(PREFIX)) {
      await idbDel(key);
    }
  }
}


// Scope new entries to a video. Legacy shared entries remain readable until that
// video's first explicit clear; clearing one video must not evict another's work.
const videoPrefix = videoId => `${PREFIX}video:${encodeURIComponent(videoId)}:`;
export async function createVideoDubCache(videoId) {
  if (!videoId) return { get: readDubCache, set: writeDubCache };
  const prefix = videoPrefix(videoId);
  const cleared = await idbGet(prefix + 'cleared');
  return {
    async get(key) {
      const own = await readDubCache(prefix + key);
      if (own != null || cleared) return own;
      const legacy = await readDubCache(key);
      if (legacy != null) await writeDubCache(prefix + key, legacy);
      return legacy;
    },
    set: (key, value) => writeDubCache(prefix + key, value),
  };
}

export async function clearVideoDubCache(videoId) {
  if (!videoId) return;
  const prefix = videoPrefix(videoId);
  const keys = (await idbListKeys()).filter(key => String(key).startsWith(prefix));
  await idbDel(keys);
  await idbSet(prefix + 'cleared', true);
}

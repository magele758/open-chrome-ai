import { DATA_DB, DATA_STORE, DATA_VERSION, idbDel, idbGet, idbListKeys, idbSet, idbSetAll } from "./idb-kv.js";

export const PAGELENS_EXTENSION_ID = "anpjolmpgjncncpocenkchhpkefopjne";
export const INTERPRET_EXTENSION_ID = "omofodhapakfeomjlgeebfamkebbdcan";

export const SYNC_NOTIFY_MSG = "pl.sync.changed";
export const SYNC_NOW_MSG = "pl.sync.now";
export const SYNC_STATUS_MSG = "pl.sync.status";
export const SYNC_APPLIED_MSG = "pl.sync.applied";

export const SHARED_SETTINGS_KEYS = [
  "text",
  "textProviders",
  "textRef",
  "asr",
  "tts",
  "langfuse",
  "uiTheme",
  "uiThemeColors",
  "uiFont",
  "nativeShell",
  "answerLanguage",
];

const SYNC_STATE_KEY = "plSyncState";
const SYNC_PEER_KEY = "plSyncPeerId";
const SYNC_TOMBSTONES_KEY = "plSyncTombstones";
const TTS_REF_DB = "pagelens-fs";
const TTS_REF_STORE = "kv";
const TTS_REF_KEY = "ttsRefAudio";
const TOMBSTONE_TTL_MS = 14 * 86400_000;
const CHUNK_RAW_BYTES = 2 * 1024 * 1024; // 2 MiB raw -> ~2.67 MiB base64 (< 64 MiB IPC limit)
const TRANSFER_TTL_MS = 120_000;

const ARCHIVE_PREFIX = "pl.media.archive.";
const ARCHIVE_INFO_PREFIX = "pl.media.info.";
const DUB_QUEUE_PREFIX = "dub-queue:";
const DUB_CACHE_PREFIX = "dub-v2:";
const CAPTION_ITEM_PREFIX = "pl.asr.item.";
const CAPTION_INDEX_KEY = "pl.asr.index";

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function isSyncableIdbKey(key) {
  const s = String(key || "");
  return (
    s.startsWith(DUB_QUEUE_PREFIX) ||
    s.startsWith(ARCHIVE_PREFIX) ||
    s.startsWith(ARCHIVE_INFO_PREFIX) ||
    s.startsWith(DUB_CACHE_PREFIX) ||
    s.startsWith(CAPTION_ITEM_PREFIX)
  );
}

export function pickSharedSettings(settings) {
  const s = settings && typeof settings === "object" ? settings : {};
  const out = {};
  for (const k of SHARED_SETTINGS_KEYS) {
    if (s[k] !== undefined) out[k] = cloneJson(s[k]);
  }
  return out;
}

export function mergeSharedSettings(localSettings, remoteShared, { preserveSummaryTokens = true } = {}) {
  const local = cloneJson(localSettings && typeof localSettings === "object" ? localSettings : {});
  const remote = pickSharedSettings(remoteShared);
  const localSummaryTokens = local?.text?.summaryInputTokens;
  const merged = { ...local, ...remote };
  if (preserveSummaryTokens && Number.isFinite(Number(localSummaryTokens)) && merged.text) {
    merged.text = { ...merged.text, summaryInputTokens: Number(localSummaryTokens) };
  }
  return merged;
}

export function settingsSyncDigest(settings) {
  const picked = pickSharedSettings(settings);
  if (picked.text && typeof picked.text === "object") {
    const { summaryInputTokens: _ignored, ...rest } = picked.text;
    picked.text = rest;
  }
  return JSON.stringify(picked);
}

export function sharedSettingsScore(settings) {
  if (!settings || typeof settings !== "object") return 0;
  let score = 0;
  if (settings.text?.baseUrl?.trim() && settings.text?.model?.trim()) score += 4;
  if (Array.isArray(settings.textProviders) && settings.textProviders.some((p) => p?.baseUrl?.trim() && p?.models?.length)) score += 2;
  if (settings.asr?.baseUrl?.trim()) score += 1;
  if (settings.tts?.baseUrl?.trim()) score += 1;
  return score;
}

export function chooseSettingsSyncAction(local, remote) {
  const localDigest = settingsSyncDigest(local.settings);
  const remoteDigest = settingsSyncDigest(remote.settings);
  if (localDigest === remoteDigest) return "equal";

  const lt = Number(local.updatedAt) || 0;
  const rt = Number(remote.updatedAt) || 0;
  if (lt > 0 && rt > 0) {
    if (rt > lt) return "pull";
    if (lt > rt) return "push";
  } else if (rt > 0 && lt === 0) {
    return sharedSettingsScore(remote.settings) > 0 || sharedSettingsScore(local.settings) === 0 ? "pull" : "push";
  } else if (lt > 0 && rt === 0) {
    return sharedSettingsScore(local.settings) > 0 || sharedSettingsScore(remote.settings) === 0 ? "push" : "pull";
  }

  const ls = sharedSettingsScore(local.settings);
  const rs = sharedSettingsScore(remote.settings);
  if (rs > ls) return "pull";
  if (ls > rs) return "push";
  if (local.role === "interpret" && remote.role === "pagelens" && rs > 0) return "pull";
  if (local.role === "pagelens" && remote.role === "interpret" && ls > 0) return "push";
  return "equal";
}

function bytesToBase64(uint8) {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < uint8.length; i += chunk) {
    binary += String.fromCharCode(...uint8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToUint8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isBinaryValue(val) {
  return val instanceof ArrayBuffer || ArrayBuffer.isView(val);
}

function toUint8(val) {
  if (val instanceof ArrayBuffer) return new Uint8Array(val);
  return new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
}

export function encodeRecordForWire(record) {
  const binaries = [];
  function walk(node) {
    if (node == null || typeof node !== "object") return node;
    if (isBinaryValue(node)) {
      const idx = binaries.length;
      binaries.push(toUint8(node));
      return { __plSyncBin: idx };
    }
    if (Array.isArray(node)) return node.map(walk);
    if (Object.getPrototypeOf(node) !== Object.prototype) return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (v === undefined || typeof v === "function") continue;
      if (typeof Blob !== "undefined" && v instanceof Blob) continue;
      out[k] = walk(v);
    }
    return out;
  }
  const payload = walk(record);
  return { payload, binaries };
}

export function decodeRecordFromWire(payload, binaries) {
  function walk(node) {
    if (node == null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(walk);
    if (Object.keys(node).length === 1 && Number.isInteger(node.__plSyncBin)) {
      const bytes = binaries[node.__plSyncBin];
      if (!bytes) return null;
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = walk(v);
    }
    return out;
  }
  return walk(payload);
}

export function splitUint8Chunks(bytes, chunkSize = CHUNK_RAW_BYTES) {
  if (!bytes?.length) return [""];
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytesToBase64(bytes.subarray(offset, offset + chunkSize)));
  }
  return chunks;
}

export function joinBase64Chunks(chunks) {
  const parts = (chunks || []).map(base64ToUint8);
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    merged.set(p, offset);
    offset += p.length;
  }
  return merged;
}

export function notifySyncChange(detail) {
  try {
    if (typeof chrome === "undefined" || typeof chrome.runtime?.sendMessage !== "function") return;
    Promise.resolve(chrome.runtime.sendMessage({ type: SYNC_NOTIFY_MSG, ...detail })).catch(() => {});
  } catch {
    /* ignore in unit tests / environments without runtime */
  }
}

export function defaultPeerIdFor({ selfId, role } = {}) {
  if (selfId === PAGELENS_EXTENSION_ID || role === "pagelens") return INTERPRET_EXTENSION_ID;
  if (selfId === INTERPRET_EXTENSION_ID || role === "interpret") return PAGELENS_EXTENSION_ID;
  return PAGELENS_EXTENSION_ID;
}

export async function resolveSyncPeerId({ chromeApi = globalThis.chrome, role } = {}) {
  try {
    const data = await chromeApi?.storage?.local?.get?.(SYNC_PEER_KEY);
    const custom = String(data?.[SYNC_PEER_KEY] || "").trim();
    if (/^[a-p]{32}$/.test(custom)) return custom;
  } catch { /* ignore */ }
  return defaultPeerIdFor({ selfId: chromeApi?.runtime?.id, role });
}

export async function saveSyncPeerId(peerId, { chromeApi = globalThis.chrome } = {}) {
  const clean = String(peerId || "").trim();
  if (!clean) {
    await chromeApi?.storage?.local?.remove?.(SYNC_PEER_KEY);
    return "";
  }
  if (!/^[a-p]{32}$/.test(clean)) throw new Error("扩展 ID 格式不对（应为 32 位 a-p 字母）");
  await chromeApi?.storage?.local?.set?.({ [SYNC_PEER_KEY]: clean });
  return clean;
}

async function openTtsRefDb() {
  if (typeof indexedDB === "undefined") return null;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TTS_REF_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TTS_REF_STORE)) db.createObjectStore(TTS_REF_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("打开参考音色存储失败"));
  });
}

async function readLocalTtsRef() {
  try {
    const db = await openTtsRefDb();
    if (!db) return null;
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(TTS_REF_STORE, "readonly");
      const req = tx.objectStore(TTS_REF_STORE).get(TTS_REF_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function writeLocalTtsRef(rec) {
  const db = await openTtsRefDb();
  if (!db) return false;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(TTS_REF_STORE, "readwrite");
    tx.objectStore(TTS_REF_STORE).put(rec, TTS_REF_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return true;
}

async function deleteLocalTtsRef() {
  try {
    const db = await openTtsRefDb();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(TTS_REF_STORE, "readwrite");
      tx.objectStore(TTS_REF_STORE).delete(TTS_REF_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* ignore */ }
}

async function readIdbEntriesWithPrefix(prefix) {
  if (typeof indexedDB === "undefined") return [];
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DATA_DB, DATA_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DATA_STORE)) req.result.createObjectStore(DATA_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return await new Promise((resolve, reject) => {
      const out = [];
      const tx = db.transaction(DATA_STORE, "readonly");
      const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
      const req = tx.objectStore(DATA_STORE).openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(out); return; }
        out.push({ key: String(cursor.key), value: cursor.value });
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    const keys = (await idbListKeys(prefix)) || [];
    const out = [];
    for (const key of keys) out.push({ key, value: await idbGet(key) });
    return out;
  }
}

export function idbRecordTimestamp(key, value) {
  if (!value || typeof value !== "object") return 0;
  if (key.startsWith(ARCHIVE_INFO_PREFIX) || key.startsWith(ARCHIVE_PREFIX)) {
    return Number(value.createdAt ?? value.added) || 0;
  }
  if (key.startsWith(DUB_QUEUE_PREFIX)) {
    return Number(value.updatedAt) || Number(value.added) || 0;
  }
  if (key.startsWith(DUB_CACHE_PREFIX)) {
    if (key.endsWith(":cleared")) return 1;
    return Number(value.expires) || 0;
  }
  if (key.startsWith(CAPTION_ITEM_PREFIX)) {
    return Number(value.at) || 0;
  }
  return 0;
}

export function installInterpretSync({
  role = "pagelens",
  chromeApi = globalThis.chrome,
  normalizeSettings = (x) => x,
  onApplied = () => {},
} = {}) {
  const selfId = chromeApi?.runtime?.id || "";
  const transfers = new Map();
  let syncQueue = Promise.resolve();
  let suppressedSettingsDigest = "";
  let syncInProgress = false;
  let lastStatus = {
    role,
    selfId,
    peerId: defaultPeerIdFor({ selfId, role }),
    connected: false,
    lastSyncAt: 0,
    lastError: "",
    lastResult: null,
  };

  const runSerial = (fn) => {
    const next = syncQueue.then(fn, fn);
    syncQueue = next.catch(() => {});
    return next;
  };

  function cleanupTransfers() {
    const cutoff = Date.now() - TRANSFER_TTL_MS;
    for (const [id, entry] of transfers) {
      if (entry.at < cutoff) transfers.delete(id);
    }
  }

  async function readSyncState() {
    const data = await chromeApi.storage.local.get([SYNC_STATE_KEY, SYNC_TOMBSTONES_KEY, SYNC_PEER_KEY, "settings"]);
    const state = data?.[SYNC_STATE_KEY] && typeof data[SYNC_STATE_KEY] === "object" ? { ...data[SYNC_STATE_KEY] } : {};
    const tombstones = data?.[SYNC_TOMBSTONES_KEY] && typeof data[SYNC_TOMBSTONES_KEY] === "object"
      ? { ...data[SYNC_TOMBSTONES_KEY] }
      : {};
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    for (const [k, ts] of Object.entries(tombstones)) {
      if (!(Number(ts) > cutoff)) delete tombstones[k];
    }
    const customPeer = String(data?.[SYNC_PEER_KEY] || "").trim();
    const peerId = /^[a-p]{32}$/.test(customPeer) ? customPeer : defaultPeerIdFor({ selfId, role });
    return { state, tombstones, peerId, settings: normalizeSettings(data?.settings) };
  }

  async function writeTombstones(updates) {
    const { tombstones } = await readSyncState();
    Object.assign(tombstones, updates);
    await chromeApi.storage.local.set({ [SYNC_TOMBSTONES_KEY]: tombstones });
    return tombstones;
  }

  async function isAllowedSender(sender) {
    const id = sender?.id;
    if (!id) return false;
    if (id === PAGELENS_EXTENSION_ID || id === INTERPRET_EXTENSION_ID) return true;
    const { peerId } = await readSyncState();
    return id === peerId;
  }

  async function sendToPeer(peerId, msg) {
    if (!peerId || peerId === selfId || typeof chromeApi?.runtime?.sendMessage !== "function") {
      throw new Error("未配置有效的对端扩展 ID");
    }
    return chromeApi.runtime.sendMessage(peerId, msg);
  }

  async function applyRemoteSettings(remoteShared, remoteUpdatedAt) {
    const { state, settings } = await readSyncState();
    const merged = normalizeSettings(mergeSharedSettings(settings, remoteShared));
    const digest = settingsSyncDigest(merged);
    if (digest === settingsSyncDigest(settings) && (Number(state.settingsUpdatedAt) || 0) >= (Number(remoteUpdatedAt) || 0)) {
      return false;
    }
    suppressedSettingsDigest = digest;
    const nextState = {
      ...state,
      settingsUpdatedAt: Math.max(Number(remoteUpdatedAt) || Date.now(), Number(state.settingsUpdatedAt) || 0),
      lastSyncedSettingsDigest: digest,
    };
    await chromeApi.storage.local.set({ settings: merged, [SYNC_STATE_KEY]: nextState });
    broadcastApplied(["settings"]);
    return true;
  }

  function broadcastApplied(kinds) {
    try { onApplied(kinds); } catch { /* ignore */ }
    try {
      Promise.resolve(chromeApi.runtime.sendMessage({ type: SYNC_APPLIED_MSG, kinds })).catch(() => {});
    } catch { /* ignore */ }
  }

  async function collectLocalManifest() {
    const { state, tombstones, settings } = await readSyncState();
    const ttsRef = await readLocalTtsRef();
    const records = {};

    for (const { key, value } of await readIdbEntriesWithPrefix(DUB_QUEUE_PREFIX)) {
      if (value) records[key] = { ts: idbRecordTimestamp(key, value), status: value.status, ownerId: value.ownerId || "" };
    }
    const archiveKeysList = (await idbListKeys(ARCHIVE_PREFIX)) || [];
    const archiveKeySet = new Set(archiveKeysList);
    for (const { key, value } of await readIdbEntriesWithPrefix(ARCHIVE_INFO_PREFIX)) {
      if (!value) continue;
      const archiveKey = ARCHIVE_PREFIX + key.slice(ARCHIVE_INFO_PREFIX.length);
      if (!archiveKeySet.has(archiveKey)) continue;
      const complete = typeof value.complete === "boolean" ? value.complete : Boolean(value.playable);
      records[archiveKey] = { ts: Number(value.createdAt ?? value.added) || 0, complete };
    }
    // Fallback for legacy archives that do not yet have a metadata info record.
    for (const key of archiveKeysList) {
      if (records[key]) continue;
      const val = await idbGet(key);
      if (val) records[key] = { ts: Number(val.createdAt) || 0, complete: val.complete === true };
    }
    for (const { key, value } of await readIdbEntriesWithPrefix(DUB_CACHE_PREFIX)) {
      if (value !== undefined) records[key] = { ts: idbRecordTimestamp(key, value) };
    }
    for (const { key, value } of await readIdbEntriesWithPrefix(CAPTION_ITEM_PREFIX)) {
      if (value) records[key] = { ts: Number(value.at) || 0 };
    }

    return {
      ok: true,
      role,
      selfId,
      settings: pickSharedSettings(settings),
      settingsUpdatedAt: Number(state.settingsUpdatedAt) || 0,
      ttsRefMeta: ttsRef?.buffer
        ? { exists: true, name: ttsRef.name, bytes: ttsRef.bytes, updatedAt: Number(ttsRef.updatedAt) || 1 }
        : { exists: false, updatedAt: 0 },
      records,
      tombstones,
    };
  }

  async function readSyncRecord(kind, key) {
    if (kind === "ttsRef") {
      const rec = await readLocalTtsRef();
      return rec ? { exists: true, record: rec } : { exists: false };
    }
    if (kind === "idb") {
      if (!isSyncableIdbKey(key)) throw new Error(`不允许同步的键：${key}`);
      const val = await idbGet(key);
      if (val === undefined) return { exists: false };
      if (key.startsWith(ARCHIVE_PREFIX)) {
        const videoId = key.slice(ARCHIVE_PREFIX.length);
        const info = await idbGet(ARCHIVE_INFO_PREFIX + videoId);
        return { exists: true, record: { main: val, info } };
      }
      return { exists: true, record: val };
    }
    throw new Error(`未知同步类型：${kind}`);
  }

  async function writeSyncRecord(kind, key, decoded) {
    if (kind === "ttsRef") {
      if (!decoded?.buffer) return false;
      await writeLocalTtsRef(decoded);
      const { tombstones } = await readSyncState();
      if (tombstones["ttsRef"]) {
        delete tombstones["ttsRef"];
        await chromeApi.storage.local.set({ [SYNC_TOMBSTONES_KEY]: tombstones });
      }
      broadcastApplied(["ttsRef"]);
      return true;
    }
    if (kind === "idb") {
      if (!isSyncableIdbKey(key)) return false;
      if (key.startsWith(ARCHIVE_PREFIX)) {
        const videoId = key.slice(ARCHIVE_PREFIX.length);
        const main = decoded?.main || decoded;
        const info = decoded?.info;
        const entries = { [key]: main };
        if (info) entries[ARCHIVE_INFO_PREFIX + videoId] = info;
        await idbSetAll(entries);
        await clearTombstones([key, ARCHIVE_INFO_PREFIX + videoId]);
        broadcastApplied(["archive"]);
        return true;
      }
      await idbSet(key, decoded);
      await clearTombstones([key]);
      if (key.startsWith(CAPTION_ITEM_PREFIX) && decoded?.id && decoded?.at) {
        await mergeCaptionIndex(decoded.id, decoded.at);
      }
      const appliedKind = key.startsWith(DUB_QUEUE_PREFIX) ? "dubQueue"
        : key.startsWith(DUB_CACHE_PREFIX) ? "dubCache"
          : key.startsWith(CAPTION_ITEM_PREFIX) ? "captions" : "idb";
      broadcastApplied([appliedKind]);
      return true;
    }
    return false;
  }

  async function mergeCaptionIndex(id, at) {
    try {
      const data = await chromeApi.storage.local.get(CAPTION_INDEX_KEY);
      const list = Array.isArray(data?.[CAPTION_INDEX_KEY]) ? data[CAPTION_INDEX_KEY] : [];
      const next = list.filter((x) => x?.id !== id);
      next.unshift({ id, at });
      next.splice(24);
      await chromeApi.storage.local.set({ [CAPTION_INDEX_KEY]: next });
    } catch { /* ignore */ }
  }

  async function clearTombstones(keys) {
    const { tombstones } = await readSyncState();
    let changed = false;
    for (const k of keys) {
      if (k in tombstones) {
        delete tombstones[k];
        changed = true;
      }
    }
    if (changed) await chromeApi.storage.local.set({ [SYNC_TOMBSTONES_KEY]: tombstones });
  }

  async function applyLocalDeletions(kind, keys, deletedAt) {
    const ts = Number(deletedAt) || Date.now();
    if (kind === "ttsRef") {
      const cur = await readLocalTtsRef();
      if (!cur || (Number(cur.updatedAt) || 1) <= ts) {
        await deleteLocalTtsRef();
        await writeTombstones({ ttsRef: ts });
        broadcastApplied(["ttsRef"]);
      }
      return;
    }
    if (kind === "clearVideoDubCache") {
      const videoId = String(keys?.[0] || "");
      if (!videoId) return;
      const prefix = `${DUB_CACHE_PREFIX}video:${encodeURIComponent(videoId)}:`;
      const existing = (await idbListKeys(prefix)) || [];
      if (existing.length) await idbDel(existing);
      await idbSet(prefix + "cleared", true);
      const updates = { [prefix + "cleared"]: ts };
      for (const k of existing) updates[k] = ts;
      await writeTombstones(updates);
      broadcastApplied(["dubCache"]);
      return;
    }
    if (kind === "idbDelete" && Array.isArray(keys) && keys.length) {
      const safe = keys.filter(isSyncableIdbKey);
      const expanded = new Set(safe);
      for (const k of safe) {
        if (k.startsWith(ARCHIVE_PREFIX)) expanded.add(ARCHIVE_INFO_PREFIX + k.slice(ARCHIVE_PREFIX.length));
      }
      if (!expanded.size) return;
      await idbDel([...expanded]);
      const updates = {};
      for (const k of expanded) updates[k] = ts;
      await writeTombstones(updates);
      broadcastApplied(["dubQueue", "archive", "dubCache"]);
    }
  }

  async function pushRecordToPeer(peerId, kind, key) {
    const res = await readSyncRecord(kind, key);
    if (!res.exists) return false;
    const { payload, binaries } = encodeRecordForWire(res.record);
    if (!binaries.length) {
      await sendToPeer(peerId, { type: "pl.sync.putInline", kind, key, payload });
      return true;
    }
    const transferId = crypto.randomUUID();
    const binMeta = binaries.map((b) => {
      const chunks = splitUint8Chunks(b);
      return { chunks };
    });
    await sendToPeer(peerId, {
      type: "pl.sync.beginWrite",
      transferId,
      kind,
      key,
      payload,
      binaryCount: binaries.length,
    });
    for (let binIndex = 0; binIndex < binMeta.length; binIndex++) {
      const { chunks } = binMeta[binIndex];
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        await sendToPeer(peerId, {
          type: "pl.sync.writeChunk",
          transferId,
          binIndex,
          chunkIndex,
          totalChunks: chunks.length,
          data: chunks[chunkIndex],
        });
      }
    }
    await sendToPeer(peerId, { type: "pl.sync.commitWrite", transferId });
    return true;
  }

  async function pullRecordFromPeer(peerId, kind, key) {
    const init = await sendToPeer(peerId, { type: "pl.sync.beginRead", kind, key });
    if (!init?.ok || !init.exists) return false;
    if (init.inline) {
      const decoded = decodeRecordFromWire(init.payload, []);
      return writeSyncRecord(kind, key, decoded);
    }
    const binaries = [];
    for (let binIndex = 0; binIndex < init.binaryCount; binIndex++) {
      const chunks = [];
      let totalChunks = 1;
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const part = await sendToPeer(peerId, {
          type: "pl.sync.readChunk",
          transferId: init.transferId,
          binIndex,
          chunkIndex,
        });
        if (!part?.ok) throw new Error(part?.error || "分片读取失败");
        totalChunks = part.totalChunks;
        chunks.push(part.data);
      }
      binaries.push(joinBase64Chunks(chunks));
    }
    await sendToPeer(peerId, { type: "pl.sync.endRead", transferId: init.transferId }).catch(() => {});
    const decoded = decodeRecordFromWire(init.payload, binaries);
    return writeSyncRecord(kind, key, decoded);
  }

  async function syncWithPeer({ reason = "auto", force = reason === "manual" } = {}) {
    return runSerial(async () => {
      if (syncInProgress) return lastStatus;
      if (!force && reason === "panel-boot" && lastStatus.connected && lastStatus.lastSyncAt > 0) {
        return lastStatus;
      }
      syncInProgress = true;
      const { peerId, state } = await readSyncState();
      lastStatus = { ...lastStatus, peerId };
      try {
        const remote = await sendToPeer(peerId, { type: "pl.sync.getManifest" });
        if (!remote?.ok) throw new Error(remote?.error || "对端未响应");

        const local = await collectLocalManifest();
        let pulled = 0;
        let pushed = 0;

        // 1. Settings
        const settingsAction = chooseSettingsSyncAction(
          { role, settings: local.settings, updatedAt: local.settingsUpdatedAt },
          { role: remote.role, settings: remote.settings, updatedAt: remote.settingsUpdatedAt },
        );
        if (settingsAction === "pull") {
          const ts = Math.max(remote.settingsUpdatedAt || 0, Date.now());
          if (await applyRemoteSettings(remote.settings, ts)) pulled++;
          await sendToPeer(peerId, { type: "pl.sync.ackSettingsTs", updatedAt: ts }).catch(() => {});
        } else if (settingsAction === "push") {
          const ts = Math.max(local.settingsUpdatedAt || 0, Date.now());
          await sendToPeer(peerId, { type: "pl.sync.applySettings", settings: local.settings, updatedAt: ts });
          const digest = settingsSyncDigest(local.settings);
          await chromeApi.storage.local.set({
            [SYNC_STATE_KEY]: { ...state, settingsUpdatedAt: ts, lastSyncedSettingsDigest: digest },
          });
          pushed++;
        }

        // 2. TTS Reference audio
        const lRef = local.ttsRefMeta;
        const rRef = remote.ttsRefMeta;
        const lRefDel = Number(local.tombstones?.ttsRef) || 0;
        const rRefDel = Number(remote.tombstones?.ttsRef) || 0;
        const maxDel = Math.max(lRefDel, rRefDel);
        if (maxDel > 0 && maxDel >= (lRef.updatedAt || 0) && maxDel >= (rRef.updatedAt || 0)) {
          if (lRef.exists) { await applyLocalDeletions("ttsRef", [], maxDel); pulled++; }
          if (rRef.exists) { await sendToPeer(peerId, { type: "pl.sync.deleteRecord", kind: "ttsRef", keys: [], deletedAt: maxDel }); pushed++; }
        } else if (rRef.exists && (!lRef.exists || rRef.updatedAt > lRef.updatedAt)) {
          if (await pullRecordFromPeer(peerId, "ttsRef", TTS_REF_KEY)) pulled++;
        } else if (lRef.exists && (!rRef.exists || lRef.updatedAt > rRef.updatedAt)) {
          if (await pushRecordToPeer(peerId, "ttsRef", TTS_REF_KEY)) pushed++;
        }

        // 3. IndexedDB records (archives, queue, dub segment caches, transcripts)
        const allKeys = new Set([
          ...Object.keys(local.records),
          ...Object.keys(remote.records || {}),
          ...Object.keys(local.tombstones || {}).filter(isSyncableIdbKey),
          ...Object.keys(remote.tombstones || {}).filter(isSyncableIdbKey),
        ]);

        for (const key of allKeys) {
          const lRec = local.records[key];
          const rRec = remote.records?.[key];
          const lDel = Number(local.tombstones?.[key]) || 0;
          const rDel = Number(remote.tombstones?.[key]) || 0;
          const topDel = Math.max(lDel, rDel);

          if (topDel > 0 && topDel >= (lRec?.ts || 0) && topDel >= (rRec?.ts || 0)) {
            if (lRec) { await applyLocalDeletions("idbDelete", [key], topDel); pulled++; }
            if (rRec) { await sendToPeer(peerId, { type: "pl.sync.deleteRecord", kind: "idbDelete", keys: [key], deletedAt: topDel }); pushed++; }
            continue;
          }

          if (rRec && (!lRec || rRec.ts > lRec.ts || (rRec.complete && !lRec.complete))) {
            if (await pullRecordFromPeer(peerId, "idb", key)) pulled++;
          } else if (lRec && (!rRec || lRec.ts > rRec.ts || (lRec.complete && !rRec.complete))) {
            if (await pushRecordToPeer(peerId, "idb", key)) pushed++;
          }
        }

        lastStatus = {
          role,
          selfId,
          peerId,
          connected: true,
          lastSyncAt: Date.now(),
          lastError: "",
          lastResult: { reason, pulled, pushed },
        };
        return lastStatus;
      } catch (err) {
        lastStatus = {
          ...lastStatus,
          peerId,
          connected: false,
          lastError: err?.message || String(err),
        };
        return lastStatus;
      } finally {
        syncInProgress = false;
      }
    });
  }

  async function handleLocalChange(msg) {
    const { peerId } = await readSyncState();
    try {
      if (msg.kind === "ttsRef") {
        if (msg.deletedAt) {
          await writeTombstones({ ttsRef: msg.deletedAt });
          await sendToPeer(peerId, { type: "pl.sync.deleteRecord", kind: "ttsRef", keys: [], deletedAt: msg.deletedAt });
        } else {
          await clearTombstones(["ttsRef"]);
          await pushRecordToPeer(peerId, "ttsRef", TTS_REF_KEY);
        }
      } else if (msg.kind === "idb" && msg.key) {
        const toClear = msg.key.startsWith(ARCHIVE_PREFIX)
          ? [msg.key, ARCHIVE_INFO_PREFIX + msg.key.slice(ARCHIVE_PREFIX.length)]
          : [msg.key];
        await clearTombstones(toClear);
        await pushRecordToPeer(peerId, "idb", msg.key);
      } else if (msg.kind === "idbBatch" && Array.isArray(msg.keys)) {
        await clearTombstones(msg.keys);
        for (const k of msg.keys) await pushRecordToPeer(peerId, "idb", k);
      } else if (msg.kind === "idbDelete" && Array.isArray(msg.keys)) {
        const ts = Number(msg.deletedAt) || Date.now();
        const updates = {};
        for (const k of msg.keys) if (isSyncableIdbKey(k)) updates[k] = ts;
        await writeTombstones(updates);
        await sendToPeer(peerId, { type: "pl.sync.deleteRecord", kind: "idbDelete", keys: msg.keys, deletedAt: ts });
      } else if (msg.kind === "clearVideoDubCache" && msg.videoId) {
        const ts = Number(msg.deletedAt) || Date.now();
        const prefix = `${DUB_CACHE_PREFIX}video:${encodeURIComponent(msg.videoId)}:`;
        const updates = { [prefix + "cleared"]: ts };
        for (const k of msg.keys || []) updates[k] = ts;
        await writeTombstones(updates);
        await sendToPeer(peerId, { type: "pl.sync.deleteRecord", kind: "clearVideoDubCache", keys: [msg.videoId], deletedAt: ts });
      }
      lastStatus = { ...lastStatus, peerId, connected: true, lastError: "", lastSyncAt: Date.now() };
    } catch (err) {
      lastStatus = { ...lastStatus, peerId, connected: false, lastError: err?.message || String(err) };
    }
  }

  async function handleExternal(msg) {
    cleanupTransfers();
    switch (msg?.type) {
      case "pl.sync.ping":
        return { ok: true, id: selfId, role };
      case "pl.sync.getManifest":
        return collectLocalManifest();
      case "pl.sync.applySettings": {
        await runSerial(() => applyRemoteSettings(msg.settings, msg.updatedAt));
        return { ok: true };
      }
      case "pl.sync.ackSettingsTs": {
        const { state, settings } = await readSyncState();
        const ts = Number(msg.updatedAt) || Date.now();
        if (ts > (Number(state.settingsUpdatedAt) || 0)) {
          await chromeApi.storage.local.set({
            [SYNC_STATE_KEY]: {
              ...state,
              settingsUpdatedAt: ts,
              lastSyncedSettingsDigest: settingsSyncDigest(settings),
            },
          });
        }
        return { ok: true };
      }
      case "pl.sync.putInline": {
        const decoded = decodeRecordFromWire(msg.payload, []);
        await runSerial(() => writeSyncRecord(msg.kind, msg.key, decoded));
        return { ok: true };
      }
      case "pl.sync.beginWrite": {
        transfers.set(msg.transferId, {
          at: Date.now(),
          kind: msg.kind,
          key: msg.key,
          payload: msg.payload,
          bins: Array.from({ length: Number(msg.binaryCount) || 0 }, () => []),
        });
        return { ok: true };
      }
      case "pl.sync.writeChunk": {
        const tr = transfers.get(msg.transferId);
        if (!tr) return { ok: false, error: "传输会话已过期" };
        tr.at = Date.now();
        tr.bins[msg.binIndex][msg.chunkIndex] = msg.data;
        return { ok: true };
      }
      case "pl.sync.commitWrite": {
        const tr = transfers.get(msg.transferId);
        transfers.delete(msg.transferId);
        if (!tr) return { ok: false, error: "传输会话不存在" };
        const binaries = tr.bins.map(joinBase64Chunks);
        const decoded = decodeRecordFromWire(tr.payload, binaries);
        await runSerial(() => writeSyncRecord(tr.kind, tr.key, decoded));
        return { ok: true };
      }
      case "pl.sync.beginRead": {
        const res = await readSyncRecord(msg.kind, msg.key);
        if (!res.exists) return { ok: true, exists: false };
        const { payload, binaries } = encodeRecordForWire(res.record);
        if (!binaries.length) return { ok: true, exists: true, inline: true, payload };
        const transferId = crypto.randomUUID();
        const binChunks = binaries.map((b) => splitUint8Chunks(b));
        transfers.set(transferId, { at: Date.now(), binChunks });
        return { ok: true, exists: true, inline: false, transferId, payload, binaryCount: binChunks.length };
      }
      case "pl.sync.readChunk": {
        const tr = transfers.get(msg.transferId);
        if (!tr) return { ok: false, error: "读取会话已过期" };
        tr.at = Date.now();
        const chunks = tr.binChunks?.[msg.binIndex] || [];
        return { ok: true, totalChunks: chunks.length, data: chunks[msg.chunkIndex] ?? "" };
      }
      case "pl.sync.endRead": {
        transfers.delete(msg.transferId);
        return { ok: true };
      }
      case "pl.sync.deleteRecord": {
        await runSerial(() => applyLocalDeletions(msg.kind, msg.keys, msg.deletedAt));
        return { ok: true };
      }
      default:
        return { ok: false, error: "未知同步指令" };
    }
  }

  chromeApi?.runtime?.onMessageExternal?.addListener((msg, sender, sendResponse) => {
    if (!String(msg?.type || "").startsWith("pl.sync.")) return false;
    isAllowedSender(sender)
      .then((ok) => {
        if (!ok) return { ok: false, error: "未授权的同步来源扩展" };
        return handleExternal(msg);
      })
      .then(sendResponse, (err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  });

  chromeApi?.runtime?.onMessage?.addListener((msg, sender, sendResponse) => {
    if (sender?.id && selfId && sender.id !== selfId) return false;
    if (msg?.type === SYNC_NOTIFY_MSG) {
      runSerial(() => handleLocalChange(msg)).then(() => sendResponse({ ok: true }), (err) => sendResponse({ ok: false, error: err?.message }));
      return true;
    }
    if (msg?.type === SYNC_NOW_MSG) {
      syncWithPeer({ reason: msg.reason || "manual", force: msg.force ?? (msg.reason !== "panel-boot") }).then((status) => sendResponse({ ok: status.connected, status }), (err) => sendResponse({ ok: false, error: err?.message }));
      return true;
    }
    if (msg?.type === SYNC_STATUS_MSG) {
      readSyncState().then(({ peerId }) => sendResponse({ ok: true, status: { ...lastStatus, peerId } }));
      return true;
    }
    return false;
  });

  chromeApi?.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes?.settings) return;
    const nextSettings = normalizeSettings(changes.settings.newValue);
    const nextDigest = settingsSyncDigest(nextSettings);
    if (nextDigest === suppressedSettingsDigest) {
      suppressedSettingsDigest = "";
      return;
    }
    const oldDigest = settingsSyncDigest(normalizeSettings(changes.settings.oldValue));
    if (nextDigest === oldDigest) return;

    runSerial(async () => {
      const { state, peerId } = await readSyncState();
      if (state.lastSyncedSettingsDigest === nextDigest) return;
      // Ignore pure local-settings.json overlay when no user edit has happened yet.
      if (changes.plLocalApplied && !(Number(state.settingsUpdatedAt) > 0)) return;
      const ts = Date.now();
      await chromeApi.storage.local.set({
        [SYNC_STATE_KEY]: { ...state, settingsUpdatedAt: ts, lastSyncedSettingsDigest: nextDigest },
      });
      try {
        await sendToPeer(peerId, { type: "pl.sync.applySettings", settings: pickSharedSettings(nextSettings), updatedAt: ts });
        lastStatus = { ...lastStatus, peerId, connected: true, lastError: "", lastSyncAt: ts };
      } catch (err) {
        lastStatus = { ...lastStatus, peerId, connected: false, lastError: err?.message || String(err) };
      }
    });
  });

  return {
    syncWithPeer,
    handleExternal,
    getStatus: () => ({ ...lastStatus }),
  };
}

/**
 * Large-document KV. Separate from pagelens-fs (library handle) and TTS refs.
 * Missing IndexedDB: get → undefined, set → false, delete → no-op. Never throws.
 */

export const DATA_DB = "pagelens-data";
export const DATA_STORE = "kv";
export const DATA_VERSION = 1;

export function idbAvailable() {
  return typeof globalThis.indexedDB !== "undefined";
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!idbAvailable()) {
      reject(new Error("当前环境没有 IndexedDB。"));
      return;
    }
    const req = indexedDB.open(DATA_DB, DATA_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DATA_STORE)) db.createObjectStore(DATA_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("打开存储失败"));
  });
}

export async function idbGet(key) {
  if (!idbAvailable()) return undefined;
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DATA_STORE, "readonly");
      const req = tx.objectStore(DATA_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

export async function idbGetAll(keys) {
  const out = {};
  for (const key of keys || []) {
    const value = await idbGet(key);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export async function idbSet(key, value) {
  if (!idbAvailable()) return false;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DATA_STORE, "readwrite");
      tx.objectStore(DATA_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch {
    return false;
  }
}

export async function idbSetAll(entries) {
  const keys = Object.keys(entries || {});
  if (!keys.length) return true;
  if (!idbAvailable()) return false;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DATA_STORE, "readwrite");
      const store = tx.objectStore(DATA_STORE);
      for (const key of keys) store.put(entries[key], key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch {
    return false;
  }
}

export async function idbDel(keys) {
  const list = [].concat(keys).filter(Boolean);
  if (!list.length || !idbAvailable()) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DATA_STORE, "readwrite");
      const store = tx.objectStore(DATA_STORE);
      for (const key of list) store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}

export async function idbListKeys() {
  if (!idbAvailable()) return [];
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DATA_STORE, "readonly");
      const req = tx.objectStore(DATA_STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

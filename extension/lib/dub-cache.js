import { idbGet, idbSet, idbDel, idbListKeys } from './idb-kv.js';
const PREFIX = 'dub-v2:';
const TTL = 7 * 86400000;
export async function dubKey(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return PREFIX + [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function readDubCache(key) {
  const entry = await idbGet(key);
  if (!entry || entry.expires < Date.now()) { if (entry) await idbDel(key); return null; }
  return entry.value;
}
export async function writeDubCache(key, value) {
  return idbSet(key, { expires: Date.now() + TTL, value });
}
export async function pruneDubCache() {
  for (const key of await idbListKeys()) if (String(key).startsWith(PREFIX)) await readDubCache(key);
}

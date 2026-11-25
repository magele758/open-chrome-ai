/**
 * Chrome 原生「已保存标签组」（Saved Tab Groups）本机读/控模块：
 *  - 查：纯 JS 只读解析 Chrome profile 的 Sync Data/LevelDB（MANIFEST + .ldb/.sst Snappy + .log WAL + SavedTabGroupData Protobuf），
 *    不加锁、不写盘、零外部 npm 依赖。
 *  - 开 / 删（已关闭的原生保存组）：由 macOS AX Helper 在请求窗口里打开保存组。扩展重新核对打开的组后再执行删除并回读 GUID。
 */

import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { readSessionGroupBindings } from "./session-tab-groups.mjs";

const LEVELDB_MAGIC = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]);
const KEY_PREFIX = "saved_tab_group-dt-";
const KEY_PREFIX_BUF = Buffer.from(KEY_PREFIX, "utf8");
const WAL_BLOCK_SIZE = 32768;
const WINDOWS_EPOCH_OFFSET_US = 11644473600000000n;

// Verified empirically on Chrome 158 SavedTabGroupSpecifics.SavedTabGroup.color (1-indexed)
export const CHROME_COLOR_BY_ENUM = Object.freeze({
  1: "grey",
  2: "blue",
  3: "red",
  4: "yellow",
  5: "green",
  6: "pink",
  7: "purple",
  8: "cyan",
  9: "orange",
});

function readVarint32(buf, pos) {
  let val = 0;
  let shift = 0;
  while (pos < buf.length && shift < 35) {
    const b = buf[pos++];
    val |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [val >>> 0, pos];
    shift += 7;
  }
  throw new Error("Truncated varint32");
}

function readVarint64(buf, pos) {
  let val = 0n;
  let shift = 0n;
  while (pos < buf.length && shift < 70n) {
    const b = BigInt(buf[pos++]);
    val |= (b & 0x7fn) << shift;
    if ((b & 0x80n) === 0n) return [val, pos];
    shift += 7n;
  }
  throw new Error("Truncated varint64");
}

/** Pure-JS Snappy block uncompressor (LevelDB compression_type = 1). */
export function snappyUncompress(src) {
  const [uncompressedLen, startPos] = readVarint32(src, 0);
  if (uncompressedLen > 64 * 1024 * 1024) throw new Error(`Snappy block too large: ${uncompressedLen}`);
  const out = Buffer.allocUnsafe(uncompressedLen);
  let pos = startPos;
  let outPos = 0;
  while (pos < src.length) {
    const tag = src[pos++];
    const type = tag & 0x03;
    if (type === 0) {
      let len = tag >>> 2;
      if (len < 60) {
        len += 1;
      } else {
        const extra = len - 59;
        let l = 0;
        for (let i = 0; i < extra; i += 1) l |= src[pos++] << (8 * i);
        len = l + 1;
      }
      if (pos + len > src.length || outPos + len > uncompressedLen) throw new Error("Corrupt snappy literal");
      src.copy(out, outPos, pos, pos + len);
      pos += len;
      outPos += len;
    } else {
      let len = 0;
      let offset = 0;
      if (type === 1) {
        len = ((tag >>> 2) & 0x07) + 4;
        offset = ((tag & 0xe0) << 3) | src[pos++];
      } else if (type === 2) {
        len = (tag >>> 2) + 1;
        offset = src.readUInt16LE(pos);
        pos += 2;
      } else {
        len = (tag >>> 2) + 1;
        offset = src.readUInt32LE(pos);
        pos += 4;
      }
      if (offset === 0 || offset > outPos || outPos + len > uncompressedLen) throw new Error("Corrupt snappy copy");
      for (let i = 0; i < len; i += 1) {
        out[outPos] = out[outPos - offset];
        outPos += 1;
      }
    }
  }
  if (outPos !== uncompressedLen) throw new Error("Snappy length mismatch");
  return out;
}

/** Read LevelDB 32KB-framed WAL records (used by both .log and MANIFEST-*). */
export function readFramedRecords(buf) {
  const records = [];
  let offset = 0;
  let frag = null;
  while (offset + 7 <= buf.length) {
    const rem = WAL_BLOCK_SIZE - (offset % WAL_BLOCK_SIZE);
    if (rem < 7) {
      offset += rem;
      continue;
    }
    const len = buf.readUInt16LE(offset + 4);
    const type = buf[offset + 6];
    const start = offset + 7;
    if (type === 0) {
      if (len !== 0) throw new Error("Invalid LevelDB log padding");
      offset += rem;
      continue;
    }
    if (len > rem - 7 || start + len > buf.length) throw new Error("Incomplete LevelDB log record");
    const chunk = buf.subarray(start, start + len);
    offset = start + len;
    if (type === 1) {
      if (frag) throw new Error("Incomplete LevelDB log fragments");
      records.push(chunk);
    } else if (type === 2) {
      if (frag) throw new Error("Incomplete LevelDB log fragments");
      frag = [chunk];
    } else if (type === 3) {
      if (!frag) throw new Error("Missing LevelDB log fragment");
      frag.push(chunk);
    } else if (type === 4) {
      if (!frag) throw new Error("Missing LevelDB log fragment");
      frag.push(chunk);
      records.push(Buffer.concat(frag));
      frag = null;
    } else {
      throw new Error("Unrecognized LevelDB log record");
    }
  }
  if (frag || buf.subarray(offset).some((b) => b !== 0)) throw new Error("Incomplete LevelDB log");
  return records;
}

/** Parse LevelDB WAL (.log) WriteBatch entries matching prefix. */
export function parseWalEntries(buf, prefixBuf = KEY_PREFIX_BUF) {
  const out = [];
  for (const batch of readFramedRecords(buf)) {
    if (batch.length < 12) throw new Error("Truncated LevelDB write batch");
    let seq = batch.readBigUInt64LE(0);
    const count = batch.readUInt32LE(8);
    let p = 12;
    for (let i = 0; i < count; i += 1) {
      const tag = batch[p++];
      let klen;
      [klen, p] = readVarint32(batch, p);
      if (p + klen > batch.length) throw new Error("Invalid LevelDB write batch key");
      const keyBuf = batch.subarray(p, p + klen);
      p += klen;
      let val = null;
      if (tag === 1) {
        let vlen;
        [vlen, p] = readVarint32(batch, p);
        if (p + vlen > batch.length) throw new Error("Truncated LevelDB write batch value");
        val = batch.subarray(p, p + vlen);
        p += vlen;
      } else if (tag !== 0) {
        throw new Error("Unsupported LevelDB write batch operation");
      }
      if (bufferStartsWith(keyBuf, prefixBuf)) {
        out.push({ key: keyBuf.toString("utf8"), seq, op: tag === 1 ? "PUT" : "DEL", val });
      }
      seq += 1n;
    }
    if (p !== batch.length) throw new Error("Invalid LevelDB write batch count");
  }
  return out;
}

function bufferStartsWith(buf, prefix) {
  if (prefix.length === 0) return true;
  if (buf.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (buf[i] !== prefix[i]) return false;
  }
  return true;
}

function readBlock(fileBuf, offset, size) {
  const off = Number(offset);
  const sz = Number(size);
  if (off < 0 || sz < 0 || off + sz + 5 > fileBuf.length) throw new Error("SSTable block out of bounds");
  const raw = fileBuf.subarray(off, off + sz);
  const compression = fileBuf[off + sz];
  if (compression === 0) return raw;
  if (compression === 1) return snappyUncompress(raw);
  if (compression === 2 && typeof zlib.zstdDecompressSync === "function") return zlib.zstdDecompressSync(raw);
  throw new Error(`Unsupported SSTable block compression: ${compression}`);
}

function parseBlockEntries(blockBuf) {
  if (blockBuf.length < 4) throw new Error("Truncated SSTable block");
  const numRestarts = blockBuf.readUInt32LE(blockBuf.length - 4);
  const limit = blockBuf.length - 4 - numRestarts * 4;
  if (limit < 0) throw new Error("Invalid SSTable restart count");
  const entries = [];
  let p = 0;
  let prevKey = Buffer.alloc(0);
  while (p < limit) {
    const [shared, p1] = readVarint32(blockBuf, p);
    const [nonShared, p2] = readVarint32(blockBuf, p1);
    const [valLen, p3] = readVarint32(blockBuf, p2);
    p = p3;
    if (shared > prevKey.length || p + nonShared + valLen > limit) throw new Error("Invalid SSTable entry");
    const key = Buffer.allocUnsafe(shared + nonShared);
    prevKey.copy(key, 0, 0, shared);
    blockBuf.copy(key, shared, p, p + nonShared);
    p += nonShared;
    const val = blockBuf.subarray(p, p + valLen);
    p += valLen;
    prevKey = key;
    entries.push({ key, val });
  }
  return entries;
}

/** Parse LevelDB SSTable (.ldb / .sst) entries matching prefix. */
export function parseSstableEntries(fileBuf, prefixBuf = KEY_PREFIX_BUF) {
  if (fileBuf.length < 48) throw new Error("Truncated SSTable footer");
  const footer = fileBuf.subarray(fileBuf.length - 48);
  if (!footer.subarray(40, 48).equals(LEVELDB_MAGIC)) throw new Error("Unrecognized SSTable format");
  let p = 0;
  [, p] = readVarint64(footer, p); // metaindex offset
  [, p] = readVarint64(footer, p); // metaindex size
  const [indexOffset, p2] = readVarint64(footer, p);
  const [indexSize] = readVarint64(footer, p2);
  const indexBlock = readBlock(fileBuf, indexOffset, indexSize);
  const indexEntries = parseBlockEntries(indexBlock);
  const out = [];
  for (const idx of indexEntries) {
    const [dataOffset, d1] = readVarint64(idx.val, 0);
    const [dataSize] = readVarint64(idx.val, d1);
    const dataBlock = readBlock(fileBuf, dataOffset, dataSize);
    for (const entry of parseBlockEntries(dataBlock)) {
      if (entry.key.length < 8) continue;
      const userKey = entry.key.subarray(0, entry.key.length - 8);
      if (!bufferStartsWith(userKey, prefixBuf)) continue;
      const trailer = entry.key.readBigUInt64LE(entry.key.length - 8);
      const type = Number(trailer & 0xffn);
      const seq = trailer >> 8n;
      out.push({
        key: userKey.toString("utf8"),
        seq,
        op: type === 1 ? "PUT" : "DEL",
        val: type === 1 ? Buffer.from(entry.val) : null,
      });
    }
  }
  return out;
}

/** Parse LevelDB CURRENT + MANIFEST to identify live .ldb files and active .log threshold. */
export function readManifestState(leveldbDir) {
  const currentPath = path.join(leveldbDir, "CURRENT");
  const manifestName = fs.readFileSync(currentPath, "utf8").trim();
  if (!/^MANIFEST-\d+$/.test(manifestName)) throw new Error("Invalid LevelDB CURRENT");
  const manifestPath = path.join(leveldbDir, manifestName);
  const manifest = fs.readFileSync(manifestPath);
  const records = readFramedRecords(manifest);
  if (!records.length) throw new Error("Empty LevelDB manifest");
  const liveFiles = new Set();
  let logNumber = 0;
  let prevLogNumber = 0;
  for (const rec of records) {
    let p = 0;
    while (p < rec.length) {
      let tag;
      [tag, p] = readVarint32(rec, p);
      if (tag === 1) {
        const [len, p1] = readVarint32(rec, p);
        p = p1 + len;
      } else if (tag === 2) {
        const [n, p1] = readVarint64(rec, p);
        logNumber = Number(n);
        p = p1;
      } else if (tag === 3 || tag === 4) {
        [, p] = readVarint64(rec, p);
      } else if (tag === 5) {
        [, p] = readVarint32(rec, p);
        const [klen, p1] = readVarint32(rec, p);
        p = p1 + klen;
      } else if (tag === 6) {
        [, p] = readVarint32(rec, p);
        const [fileNum, p1] = readVarint64(rec, p);
        liveFiles.delete(Number(fileNum));
        p = p1;
      } else if (tag === 7) {
        [, p] = readVarint32(rec, p);
        const [fileNum, p1] = readVarint64(rec, p);
        [, p] = readVarint64(rec, p1); // file size
        const [sLen, p2] = readVarint32(rec, p);
        p = p2 + sLen;
        const [lLen, p3] = readVarint32(rec, p);
        p = p3 + lLen;
        liveFiles.add(Number(fileNum));
      } else if (tag === 9) {
        const [n, p1] = readVarint64(rec, p);
        prevLogNumber = Number(n);
        p = p1;
      } else {
        throw new Error(`Unsupported LevelDB manifest tag: ${tag}`);
      }
      if (p > rec.length) throw new Error("Truncated LevelDB manifest entry");
    }
  }
  return { liveFiles, logNumber, prevLogNumber, manifestName, manifestSize: manifest.length };
}

function fileStemNumber(name) {
  const m = /^(\d+)\.(?:ldb|sst|log)$/i.exec(name);
  return m ? Number(m[1]) : null;
}

function readLevelDbSnapshot(leveldbDir, prefixBuf) {
  const manifest = readManifestState(leveldbDir);
  const pendingTables = new Set(manifest.liveFiles);
  const files = fs.readdirSync(leveldbDir);
  const latest = new Map(); // key -> { seq, op, val }
  const logs = new Set();

  const ingest = (entries) => {
    for (const e of entries) {
      const prev = latest.get(e.key);
      if (!prev || e.seq >= prev.seq) latest.set(e.key, e);
    }
  };

  for (const name of files) {
    const num = fileStemNumber(name);
    if (num == null) continue;
    const full = path.join(leveldbDir, name);
    if (/\.(?:ldb|sst)$/i.test(name)) {
      if (!manifest.liveFiles.has(num)) continue;
      ingest(parseSstableEntries(fs.readFileSync(full), prefixBuf));
      pendingTables.delete(num);
    } else if (num >= manifest.logNumber || num === manifest.prevLogNumber) {
      ingest(parseWalEntries(fs.readFileSync(full), prefixBuf));
      logs.add(num);
    }
  }
  if (pendingTables.size || [manifest.logNumber, manifest.prevLogNumber].some(n => n && !logs.has(n))) {
    throw new Error("Missing active LevelDB files");
  }
  if (fs.readFileSync(path.join(leveldbDir, "CURRENT"), "utf8").trim() !== manifest.manifestName ||
      fs.statSync(path.join(leveldbDir, manifest.manifestName)).size !== manifest.manifestSize) {
    throw new Error("LevelDB compacted while reading");
  }

  const alive = new Map();
  for (const [k, rec] of latest) {
    if (rec.op === "PUT" && rec.val) alive.set(k, rec.val);
  }
  return alive;
}

/** Retry on rotation. An incomplete snapshot must never verify a deletion. */
export function readLevelDbPrefix(leveldbDir, prefixBuf = KEY_PREFIX_BUF) {
  try {
    return readLevelDbSnapshot(leveldbDir, prefixBuf);
  } catch {
    return readLevelDbSnapshot(leveldbDir, prefixBuf);
  }
}

function parseProtoFields(buf) {
  const fields = [];
  let p = 0;
  while (p < buf.length) {
    let tag;
    try {
      [tag, p] = readVarint64(buf, p);
    } catch {
      break;
    }
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) {
      const [val, p1] = readVarint64(buf, p);
      p = p1;
      fields.push({ field, wire, val });
    } else if (wire === 2) {
      const [lenBig, p1] = readVarint64(buf, p);
      const len = Number(lenBig);
      if (p1 + len > buf.length) break;
      fields.push({ field, wire, bytes: buf.subarray(p1, p1 + len) });
      p = p1 + len;
    } else if (wire === 1) {
      p += 8;
    } else if (wire === 5) {
      p += 4;
    } else {
      break;
    }
  }
  return fields;
}

function windowsUsToUnixMs(usBig) {
  if (!usBig || usBig <= WINDOWS_EPOCH_OFFSET_US) return null;
  return Number((usBig - WINDOWS_EPOCH_OFFSET_US) / 1000n);
}

/** Decode a SavedTabGroupData (or raw SavedTabGroupSpecifics) protobuf record. */
export function decodeSavedTabGroupRecord(buf) {
  const outer = parseProtoFields(buf);
  const f2 = outer.find((f) => f.field === 2 && f.wire === 2);
  const specFields = f2 ? parseProtoFields(f2.bytes) : outer;

  const guid = specFields.find((f) => f.field === 1 && f.wire === 2)?.bytes?.toString("utf8") || "";
  if (!guid) return null;
  const createdAt = windowsUsToUnixMs(specFields.find((f) => f.field === 2 && f.wire === 0)?.val);
  const updatedAt = windowsUsToUnixMs(specFields.find((f) => f.field === 3 && f.wire === 0)?.val);

  const groupMsg = specFields.find((f) => f.field === 4 && f.wire === 2);
  if (groupMsg) {
    const gf = parseProtoFields(groupMsg.bytes);
    const localData = f2 && outer.find((f) => f.field === 3 && f.wire === 2);
    const localToken = localData && parseProtoFields(localData.bytes)
      .find((f) => f.field === 1 && f.wire === 2)?.bytes.toString("utf8");
    const title = gf.find((f) => f.field === 2 && f.wire === 2)?.bytes?.toString("utf8") || "";
    const colorNum = Number(gf.find((f) => f.field === 3 && f.wire === 0)?.val || 1n);
    const positionField = [7, 4, 1].map((n) => gf.find((f) => f.field === n && f.wire === 0)).find(Boolean);
    const position = Number(positionField?.val ?? 0n);
    return {
      kind: "group",
      guid,
      localGroupId: /^[0-9A-F]{32}$/.test(localToken || "") ? localToken : null,
      title,
      color: CHROME_COLOR_BY_ENUM[colorNum] || "grey",
      position,
      createdAt,
      updatedAt,
    };
  }

  const tabMsg = specFields.find((f) => f.field === 5 && f.wire === 2);
  if (tabMsg) {
    const tf = parseProtoFields(tabMsg.bytes);
    const groupGuid = tf.find((f) => f.field === 1 && f.wire === 2)?.bytes?.toString("utf8") || "";
    const position = Number(tf.find((f) => f.field === 2 && f.wire === 0)?.val ?? 0n);
    const url = tf.find((f) => f.field === 3 && f.wire === 2)?.bytes?.toString("utf8") || "";
    const title = tf.find((f) => f.field === 4 && f.wire === 2)?.bytes?.toString("utf8") || "";
    return {
      kind: "tab",
      guid,
      groupGuid,
      position,
      url,
      title,
      createdAt,
      updatedAt,
    };
  }
  return null;
}

export function defaultChromeUserDataDir(platform = process.platform) {
  if (process.env.PAGELENS_CHROME_USER_DATA_DIR) return process.env.PAGELENS_CHROME_USER_DATA_DIR;
  const home = os.homedir();
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Google", "Chrome");
  if (platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Google", "Chrome", "User Data");
  return path.join(home, ".config", "google-chrome");
}

function safeProfileSegment(raw) {
  const s = String(raw || "").trim();
  if (!s || s.includes("/") || s.includes("\\") || s === "." || s === ".." || s.includes("\0")) return "";
  return s;
}

const PROFILE_MARKER_KEY = "savedTabGroupsProfileMarker";

/** Bind an extension request to the Chrome profile that owns its local storage marker. */
export function resolveChromeProfile({ userDataDir, profile, extensionId, profileMarker } = {}) {
  const root = userDataDir || defaultChromeUserDataDir();
  if (!fs.existsSync(root)) return { error: `找不到 Chrome 数据目录：${root}` };

  const requested = safeProfileSegment(profile);
  if (profile && !requested) return { error: `不合法的 Chrome profile 名称：${profile}` };
  const extId = String(extensionId || "").trim();
  const binding = profileMarker !== undefined && profileMarker !== null;
  if (binding && (!/^[a-p]{32}$/.test(extId) || typeof profileMarker !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(profileMarker))) {
    return { code: "PROFILE_MARKER_INVALID", error: "缺少有效的扩展或 Chrome 配置文件标识，请重新加载 PageLens。" };
  }

  const candidates = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (d.name === "Default" || /^Profile \d+$/.test(d.name) ||
      (binding && fs.existsSync(path.join(root, d.name, "Local Extension Settings", extId, "CURRENT")))))
    .map((d) => d.name)
    .sort((a, b) => (a === "Default" ? -1 : b === "Default" ? 1 : a.localeCompare(b, undefined, { numeric: true })));

  if (binding) {
    const markerBytes = Buffer.from(JSON.stringify(profileMarker));
    const matches = candidates.filter((name) => {
      const dir = path.join(root, name, "Local Extension Settings", extId);
      if (!fs.existsSync(dir)) return false;
      try {
        const entries = readLevelDbPrefix(dir, Buffer.from(PROFILE_MARKER_KEY));
        return entries.get(PROFILE_MARKER_KEY)?.equals(markerBytes);
      } catch {
        return false;
      }
    });
    if (matches.length !== 1 || (requested && matches[0] !== requested)) {
      return {
        code: "PROFILE_MARKER_MISMATCH",
        error: "当前窗口的 Chrome 配置文件标识尚未同步或无法唯一匹配，请从该窗口刷新 PageLens 后重试。",
      };
    }
    const matched = matches[0];
    return { userDataDir: root, profile: matched, syncDir: path.join(root, matched, "Sync Data", "LevelDB"), profiles: candidates, profileMarker };
  }
  if (requested) {
    const syncDir = path.join(root, requested, "Sync Data", "LevelDB");
    if (!fs.existsSync(path.join(root, requested))) return { error: `找不到 Chrome profile：${requested}` };
    return { userDataDir: root, profile: requested, syncDir, profiles: candidates };
  }

  if (!candidates.length) return { error: "找不到 Chrome 配置文件。", profiles: [] };
  const matches = candidates.length > 1 && extId ? candidates.filter((name) =>
    ["Secure Preferences", "Preferences"].some((prefName) => {
      try {
        const pref = JSON.parse(fs.readFileSync(path.join(root, name, prefName), "utf8"));
        return Object.hasOwn(pref.extensions?.settings || {}, extId);
      } catch {
        return false;
      }
    })) : [];
  const possible = matches.length ? matches : candidates;
  if (possible.length !== 1) {
    return {
      code: "PROFILE_AMBIGUOUS",
      error: "无法唯一确定此窗口使用的 Chrome 配置文件，请选择当前窗口所属的配置文件。",
      profiles: possible,
    };
  }
  const picked = possible[0];
  return {
    userDataDir: root,
    profile: picked,
    syncDir: path.join(root, picked, "Sync Data", "LevelDB"),
    profiles: candidates,
  };
}

/** Read all Chrome native Saved Tab Groups from a profile's Sync Data/LevelDB (strictly read-only). */
export function readNativeSavedTabGroups({ userDataDir, profile, extensionId, profileMarker, query, color } = {}) {
  const resolved = resolveChromeProfile({ userDataDir, profile, extensionId, profileMarker });
  if (resolved.error) return { ok: false, ...resolved };
  let records;
  try {
    records = readLevelDbPrefix(resolved.syncDir, KEY_PREFIX_BUF);
  } catch (err) {
    return {
      ok: false,
      profile: resolved.profile,
      profiles: resolved.profiles,
      code: "NATIVE_STORE_UNAVAILABLE",
      error: `暂时无法完整读取 Chrome 已保存标签组（${resolved.profile}），请刷新重试。${err.message}`,
    };
  }
  const groupsByGuid = new Map();
  const tabsByGroup = new Map();

  for (const val of records.values()) {
    const decoded = decodeSavedTabGroupRecord(val);
    if (!decoded) continue;
    if (decoded.kind === "group") {
      groupsByGuid.set(decoded.guid, decoded);
    } else if (decoded.kind === "tab" && decoded.groupGuid) {
      if (!tabsByGroup.has(decoded.groupGuid)) tabsByGroup.set(decoded.groupGuid, []);
      tabsByGroup.get(decoded.groupGuid).push({
        guid: decoded.guid,
        title: decoded.title,
        url: decoded.url,
        position: decoded.position,
      });
    }
  }

  const needle = String(query || "").trim().toLowerCase();
  const colorFilter = String(color || "").trim().toLowerCase();
  const sessionGroups = readSessionGroupBindings(path.join(resolved.userDataDir, resolved.profile));
  const groups = [];
  for (const g of groupsByGuid.values()) {
    const tabs = (tabsByGroup.get(g.guid) || [])
      .sort((a, b) => a.position - b.position)
      .map(({ guid, title, url }) => ({ guid, title, url }));
    if (colorFilter && g.color !== colorFilter) continue;
    if (needle) {
      const hay = `${g.title} ${tabs.map((t) => `${t.title} ${t.url}`).join(" ")}`.toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    groups.push({
      guid: g.guid,
      localGroupId: g.localGroupId,
      ...sessionGroups.get(g.guid),
      title: g.title,
      color: g.color,
      position: g.position,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      tabCount: tabs.length,
      tabs,
      source: "chrome_native",
    });
  }
  groups.sort((a, b) => a.position - b.position || (b.updatedAt || 0) - (a.updatedAt || 0));
  return {
    ok: true,
    profile: resolved.profile,
    profiles: resolved.profiles,
    ...(resolved.profileMarker ? { profileMarker: resolved.profileMarker } : {}),
    count: groups.length,
    groups,
  };
}

// =========================================================================
// macOS Accessibility uses a separate, signed app so TCC grants target a visible app identity.

const WINDOW_MARKER_RE = /^PageLens-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function groupMenuNames(group) {
  const title = group.title.trim();
  if (title) return [title];
  const n = group.tabCount;
  if (!Number.isInteger(n) || n <= 0) return [];
  return [`${n} ${n === 1 ? "tab" : "tabs"}`, `${n} 个标签页`, `${n}个标签页`];
}

function groupMenuLabels(names) {
  // IDS_GROUP_AX_LABEL_GROUP_MENU_ITEM_FORMAT differs from the visible title.
  // Chrome supplies an empty shared-state prefix for a regular group. AX values
  // are trimmed before comparison. Accept the complete localized label only.
  return names.flatMap(name => [
    name,
    `${name} group - Closed`, `Shared ${name} group - Closed`,
    `“${name}”分组 - 已关闭`, `已共享“${name}”分组 - 已关闭`,
    `${name} group - Opened`, `Shared ${name} group - Opened`,
    `“${name}”分组 - 已打开`, `已共享“${name}”分组 - 已打开`,
  ]);
}

export function resolveSavedGroupAction(req, list) {
  if (!list.ok) return list;
  if (!req.guid || !req.profileMarker || list.profileMarker !== req.profileMarker || list.profile !== req.profile || !req.profile || !WINDOW_MARKER_RE.test(req.windowMarker || "")) {
    return { ok: false, code: "TARGET_REQUIRED", error: "原生操作需要保存组 GUID、已确认的 Chrome 配置和请求窗口标记。请重新加载插件并刷新列表。" };
  }
  const target = list.groups.find((g) => g.guid === req.guid);
  if (!target) return { ok: false, code: "GROUP_NOT_FOUND", error: "该保存组已移除，请刷新列表。" };
  if (target.title !== req.title || target.tabCount !== req.tabCount) {
    return { ok: false, code: "GROUP_CHANGED", error: "保存组的名称或标签数已变化，请刷新列表后重试。" };
  }
  const names = groupMenuNames(target);
  const labels = groupMenuLabels(names);
  if (!target.tabCount || !labels.length) return { ok: false, code: "AMBIGUOUS_GROUP", error: "Chrome 菜单中无法识别该空分组。" };
  // The Cocoa menu uses plain titles, includes open and closed groups with tabs
  // and orders them by descending creation time (TabGroupMenuUtils).
  const peers = list.groups.filter(g => g.tabCount > 0 && groupMenuNames(g).some(name => names.includes(name)));
  if (peers.length > 1 && req.allowCandidate !== true) {
    return { ok: false, code: "AMBIGUOUS_TARGET", error: "Chrome 菜单显示多个同名保存组，请按 GUID 在独立验证窗口中打开。" };
  }
  const authorized = req.candidateGroups;
  if (!Array.isArray(authorized) || authorized.length !== peers.length || peers.some(g => {
    const snapshot = authorized.find(p => p.guid === g.guid);
    const urls = (g.tabs || []).map(t => t.url).sort();
    return !snapshot || snapshot.title !== g.title || snapshot.color !== g.color ||
      !Array.isArray(snapshot.urls) || snapshot.urls.length !== urls.length || urls.some((u, i) => u !== snapshot.urls[i]);
  })) {
    return { ok: false, code: "GROUP_CHANGED", error: "保存组或同名候选的标签内容已变化，请刷新后重试。" };
  }
  const sameTime = peers.filter(g => g.createdAt === target.createdAt).length;
  const index = peers.every(g => Number.isFinite(g.createdAt)) && sameTime === 1
    ? peers.sort((a, b) => b.createdAt - a.createdAt).indexOf(target) : -1;
  const scopedMenu = list.groups.every(g => peers.includes(g) || !groupMenuLabels(groupMenuNames(g)).some(s => labels.includes(s)));
  const safeGrid = scopedMenu && peers.length === 1;
  return {
    ok: true, labels, names, safeGrid, scopedMenu, peerCount: peers.length, index,
    allowNewWindow: req.allowNewWindow === true,
    tabLabels: (target.tabs || []).map(t => t.title || t.url),
  };
}

const HELPER_NAME = "PageLens Helper";
const HELPER_EXEC_NAME = "PageLensHelper";
const HELPER_BUNDLE_ID = "com.pagelens.helper";
const HELPER_SOURCE_PATH = fileURLToPath(new URL("./macos/pagelens-ax-helper.m", import.meta.url));
const MENU_SHIM_SOURCE_PATH = fileURLToPath(new URL("./macos/pagelens-ax-menu-shim.m", import.meta.url));
const DISCLAIM_SOURCE_PATH = fileURLToPath(new URL("./macos/pagelens-ax-disclaim.c", import.meta.url));
const TRUST_CACHE_STALE_MS = 60_000;
const TRUST_VIA_DISCLAIM = "disclaim";

export function macAxHelperAppPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".pagelens", `${HELPER_NAME}.app`);
}

function macAxHelperHashPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".pagelens", "pagelens-helper.sha256");
}

function helperInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>${HELPER_NAME}</string>
  <key>CFBundleExecutable</key><string>${HELPER_EXEC_NAME}</string>
  <key>CFBundleIdentifier</key><string>${HELPER_BUNDLE_ID}</string>
  <key>CFBundleName</key><string>${HELPER_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
</dict></plist>
`;
}

function execFileAsync(bin, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, opts, (err, stdout, stderr) => {
      resolve({ ok: !err, err, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Chrome starts a separate host for each sendNativeMessage call. Serialize
// bundle replacement and LaunchServices starts across those processes.
async function withHelperLock(homeDir, work) {
  const key = crypto.createHash("sha256").update(homeDir).digest("hex").slice(0, 20);
  const lock = path.join(os.tmpdir(), `pagelens-ax-${key}.lock`);
  const deadline = Date.now() + 25000;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const owner = Number(fs.readFileSync(lock, "utf8"));
        if (Number.isInteger(owner) && owner > 1) process.kill(owner, 0);
        else if (Date.now() - fs.statSync(lock).mtimeMs > 120000) fs.unlinkSync(lock);
      } catch (status) {
        if (status.code === "ESRCH") fs.rmSync(lock, { force: true });
      }
      if (Date.now() >= deadline) return { ok: false, code: "HELPER_BUSY", error: "PageLens Helper 正在处理另一个请求，请稍后重试。" };
      await sleep(120);
    }
  }
  try { return await work(); }
  finally { fs.rmSync(lock, { force: true }); }
}

/**
 * Compile & ad-hoc sign `~/.pagelens/PageLens Helper.app` once (rebuilt only when source changes).
 * Kept outside the bundle's hash file so the signed `.app` CDHash stays stable across runs & Chrome updates.
 */
async function buildMacAxHelper(homeDir, force = false) {
  if (process.platform !== "darwin") return { ok: false, error: "仅 macOS 支持 PageLens Helper。" };
  if (!fs.existsSync(HELPER_SOURCE_PATH)) return { ok: false, error: `缺少源码：${HELPER_SOURCE_PATH}` };
  const appPath = macAxHelperAppPath(homeDir);
  const binPath = path.join(appPath, "Contents", "MacOS", HELPER_EXEC_NAME);
  const hashPath = macAxHelperHashPath(homeDir);
  const plist = helperInfoPlist();
  const src = fs.readFileSync(HELPER_SOURCE_PATH, "utf8");
  const wantHash = crypto.createHash("sha256").update(src).update("\0").update(plist).digest("hex");

  if (!force && fs.existsSync(binPath)) {
    try {
      fs.accessSync(binPath, fs.constants.X_OK);
      if (fs.readFileSync(hashPath, "utf8").trim() === wantHash &&
          fs.readFileSync(path.join(appPath, "Contents", "Info.plist"), "utf8") === plist) {
        return { ok: true, appPath, built: false };
      }
    } catch {
      /* rebuild if hash missing */
    }
  }

  // Rebuilding an existing app cannot provide a Developer ID or notarization.
  // Preserve a blocked build and its system approval state.
  if (fs.existsSync(binPath)) {
    const blocked = await checkHelperLaunchPolicy(appPath);
    if (blocked) return blocked;
  }
  const baseDir = path.dirname(appPath);
  fs.mkdirSync(baseDir, { recursive: true });
  const tmpApp = path.join(baseDir, `.${HELPER_NAME}.tmp-${process.pid}-${Date.now()}.app`);
  const tmpMacos = path.join(tmpApp, "Contents", "MacOS");
  try {
    fs.mkdirSync(tmpMacos, { recursive: true });
    fs.writeFileSync(path.join(tmpApp, "Contents", "Info.plist"), plist, "utf8");
    const tmpBin = path.join(tmpMacos, HELPER_EXEC_NAME);
    const compiled = await execFileAsync(
      "/usr/bin/clang",
      ["-O2", "-fobjc-arc", "-framework", "Foundation", "-framework", "AppKit", "-framework", "ApplicationServices", HELPER_SOURCE_PATH, "-o", tmpBin],
      { timeout: 30000 },
    );
    if (!compiled.ok) {
      return { ok: false, error: `编译 PageLens Helper 失败：${(compiled.stderr || compiled.err?.message || "").trim()}` };
    }
    const signed = await execFileAsync(
      "/usr/bin/codesign",
      ["--force", "--sign", "-", "--identifier", HELPER_BUNDLE_ID, tmpApp],
      { timeout: 10000 },
    );
    if (!signed.ok) return { ok: false, error: `签名 PageLens Helper 失败：${signed.stderr || signed.err?.message}` };
    const resourceSeal = path.join("Contents", "_CodeSignature", "CodeResources");
    const hasSameBundle = fs.existsSync(path.join(appPath, resourceSeal)) &&
      fs.existsSync(path.join(appPath, "Contents", "Info.plist")) &&
      fs.readFileSync(path.join(appPath, "Contents", "Info.plist"), "utf8") === plist &&
      fs.readFileSync(path.join(appPath, resourceSeal)).equals(fs.readFileSync(path.join(tmpApp, resourceSeal)));
    if (!force && hasSameBundle) {
      // The bundle contains just Info.plist, the resource seal and a signed
      // Mach-O. Darwin rename atomically replaces the latter without ever
      // removing the registered .app URL or executing the staged binary.
      fs.renameSync(tmpBin, binPath);
    } else if (fs.existsSync(appPath)) {
      const backup = `${tmpApp}.previous`;
      fs.renameSync(appPath, backup);
      try {
        fs.renameSync(tmpApp, appPath);
      } catch (err) {
        fs.renameSync(backup, appPath);
        throw err;
      }
      fs.rmSync(backup, { recursive: true, force: true });
    } else {
      fs.renameSync(tmpApp, appPath);
    }
    fs.writeFileSync(hashPath, `${wantHash}\n`, "utf8");
    return { ok: true, appPath, built: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    try {
      fs.rmSync(tmpApp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function ensureMacAxHelper({ homeDir = os.homedir(), force = false } = {}) {
  return withHelperLock(homeDir, () => buildMacAxHelper(homeDir, force));
}

function runMacAxHelper(payload, options = {}) {
  return withHelperLock(os.homedir(), () => launchMacAxHelper(payload, options));
}

// Ask the system about the exact on-disk bundle without launching it. Only
// recognize fresh quarantine states for locally built helpers; leave reviewed
// bundles and other signing arrangements to normal LaunchServices handling.
export async function checkHelperLaunchPolicy(appPath, run = execFileAsync) {
  const opts = { timeout: 2500, env: { ...process.env, LC_ALL: "C" } };
  const quarantine = await run("/usr/bin/xattr", ["-p", "com.apple.quarantine", appPath], opts);
  if (!quarantine.ok || !/^00(?:0[13]|8[13]);/i.test(quarantine.stdout.trim())) return null;
  const signature = await run("/usr/bin/codesign", ["--display", "--verbose=2", appPath], opts);
  if (!signature.ok || !/^Signature=adhoc$/m.test(signature.stderr)) return null;

  // spctl(8): exit 3 specifically denotes a completed assessment with a
  // negative verdict. Timeouts and service failures are inconclusive.
  const assessment = await run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--no-cache", appPath], opts);
  if (assessment.err?.code !== 3) return null;
  return {
    ok: false, code: "HELPER_GATEKEEPER_BLOCKED", helperAppPath: appPath, helperName: HELPER_NAME,
    error: "macOS 阻止启动当前使用本地临时签名的 PageLens Helper。",
    hint: "可从 Chrome 的标签页分组菜单打开目标组，在该窗口回到 PageLens 后刷新并改名或删除。",
  };
}

function grantedHelperApp(homeDir = os.homedir()) {
  return path.join(homeDir, ".pagelens", `${HELPER_NAME}.granted.app`);
}

function helperExecutable(appPath) {
  return path.join(appPath, "Contents", "MacOS", HELPER_EXEC_NAME);
}

function menuShimPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".pagelens", "pagelens-ax-menu-shim.dylib");
}

function trustCachePath(homeDir = os.homedir()) {
  return path.join(homeDir, ".pagelens", "pagelens-ax-trust.json");
}

let trustMemory = null;

function readTrustCache(homeDir) {
  if (trustMemory?.home === homeDir) return trustMemory.entries;
  let entries = {};
  try {
    const raw = JSON.parse(fs.readFileSync(trustCachePath(homeDir), "utf8"));
    if (raw?.entries && typeof raw.entries === "object" && !Array.isArray(raw.entries)) entries = raw.entries;
  } catch {
    entries = {};
  }
  trustMemory = { home: homeDir, entries };
  return entries;
}

function rememberTrust(homeDir, cdhash, trusted, via = TRUST_VIA_DISCLAIM) {
  if (!cdhash || typeof trusted !== "boolean" || via !== TRUST_VIA_DISCLAIM) return;
  try {
    const entries = readTrustCache(homeDir);
    entries[cdhash] = { trusted, at: Date.now(), via: TRUST_VIA_DISCLAIM };
    const file = trustCachePath(homeDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ entries }), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch {
    /* a missed cache only costs another probe */
  }
}

// AXIsProcessTrusted follows the responsible process, not the Mach-O we
// executed. Herdr makes an undisclaimed helper look trusted. Chrome's native
// host makes the same helper look untrusted. Only a spawn that disclaims TCC
// responsibility measures this cdhash. Inherited "direct" and LaunchServices
// "open" entries are ignored so they cannot pin the wrong answer.
export function interpretTrustCache(entry, { refreshStale = false, now = Date.now(), staleMs = TRUST_CACHE_STALE_MS } = {}) {
  if (!entry || typeof entry.trusted !== "boolean" || !Number.isFinite(Number(entry.at))) return null;
  if (entry.via !== TRUST_VIA_DISCLAIM) return null;
  if (entry.trusted === true) return true;
  if (!refreshStale || now - Number(entry.at) < staleMs) return false;
  return null;
}

function cachedTrust(homeDir, cdhash, refreshStale) {
  if (!cdhash) return null;
  return interpretTrustCache(readTrustCache(homeDir)[cdhash], { refreshStale, now: Date.now() });
}

// codesign prints CDHash only with --verbose=4, and it prints it on stderr.
async function helperCdHash(appPath) {
  const shown = await execFileAsync("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], { timeout: 4000 });
  const match = /^CDHash=([0-9a-f]+)/im.exec(shown.stderr);
  return match ? match[1].toLowerCase() : "";
}

function disclaimLauncherPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".pagelens", "pagelens-ax-disclaim");
}

// The launcher lives outside both .app bundles. Node cannot set the
// posix_spawn responsibility attribute itself.
async function ensureDisclaimLauncher(homeDir) {
  if (!fs.existsSync(DISCLAIM_SOURCE_PATH)) return "";
  const bin = disclaimLauncherPath(homeDir);
  const hashFile = `${bin}.sha256`;
  let src;
  try { src = fs.readFileSync(DISCLAIM_SOURCE_PATH); } catch { return ""; }
  const want = crypto.createHash("sha256").update(src).digest("hex");
  try {
    if (fs.existsSync(bin) && fs.readFileSync(hashFile, "utf8").trim() === want) return bin;
  } catch { /* compile */ }
  try { fs.mkdirSync(path.dirname(bin), { recursive: true }); } catch { return ""; }
  const compiled = await execFileAsync("/usr/bin/clang", ["-O2", DISCLAIM_SOURCE_PATH, "-o", bin], { timeout: 20000 });
  if (!compiled.ok || !fs.existsSync(bin)) return "";
  try { fs.chmodSync(bin, 0o755); } catch { /* the compiler already made it executable */ }
  try { fs.writeFileSync(hashFile, `${want}\n`, { mode: 0o600 }); } catch { return ""; }
  return bin;
}

// Spawn via the disclaim launcher. DYLD_INSERT_LIBRARIES is applied only to
// the helper: inserting the menu shim into this tiny C launcher is unnecessary.
function spawnHelperDisclaimed(launcher, bin, args, env) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const childEnv = { ...env };
    const shim = childEnv.DYLD_INSERT_LIBRARIES;
    delete childEnv.DYLD_INSERT_LIBRARIES;
    if (shim) childEnv.PAGELENS_CHILD_DYLD = shim;
    else delete childEnv.PAGELENS_CHILD_DYLD;
    let child;
    let stdout = "";
    let stderr = "";
    try {
      child = spawn(launcher, [bin, ...args], { stdio: ["ignore", "pipe", "pipe"], env: childEnv });
    } catch (err) {
      finish({ ok: false, error: err?.message || String(err) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      finish({ ok: false, error: "助手进程没有启动。" });
    }, 2000);
    child.stdout.on("data", (buf) => { stdout += buf.toString(); });
    child.stderr.on("data", (buf) => { stderr += buf.toString(); });
    child.once("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: err?.message || String(err) });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const pid = Number(/^(\d+)\s*$/.exec(stdout)?.[1]);
      if (code === 0 && Number.isInteger(pid) && pid > 0) finish({ ok: true, pid });
      else finish({ ok: false, error: stderr.trim() || `责任放弃启动器退出码 ${code ?? "none"}` });
    });
  });
}

// ax_status only. The caller already holds the helper lock, so this must not
// take it again. A timeout is unknown, not "untrusted".
async function probeHelperTrust(launcher, binPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pagelens-ax-probe-"));
  const reqPath = path.join(dir, "request.json");
  const resPath = path.join(dir, "response.json");
  const deadline = Date.now() + 3500;
  const env = { ...process.env };
  delete env.DYLD_INSERT_LIBRARIES;
  delete env.PAGELENS_CHILD_DYLD;
  let pid = 0;
  try {
    fs.writeFileSync(reqPath, JSON.stringify({ action: "ax_status", deadlineMs: deadline - 400 }), { mode: 0o600 });
    const child = await spawnHelperDisclaimed(launcher, binPath, [reqPath, resPath], env);
    if (!child.ok) return null;
    pid = child.pid || 0;
    while (Date.now() < deadline && !fs.existsSync(resPath)) await sleep(40);
    if (!fs.existsSync(resPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(resPath, "utf8"));
    return typeof parsed.trusted === "boolean" ? parsed : null;
  } catch {
    return null;
  } finally {
    if (pid && !fs.existsSync(resPath)) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function resolveTrust(homeDir, appPath, refreshStale) {
  const bin = helperExecutable(appPath);
  const cdhash = await helperCdHash(appPath);
  const cached = cachedTrust(homeDir, cdhash, refreshStale);
  if (cached !== null) return { trusted: cached, fromProbe: false, cdhash, body: null };
  const launcher = await ensureDisclaimLauncher(homeDir);
  if (!launcher) return { trusted: null, fromProbe: false, cdhash, body: null };
  const body = await probeHelperTrust(launcher, bin);
  if (!body) return { trusted: null, fromProbe: false, cdhash, body: null };
  rememberTrust(homeDir, cdhash, body.trusted, TRUST_VIA_DISCLAIM);
  return { trusted: body.trusted, fromProbe: true, cdhash, body };
}

function menuShimQuarantineBlocks(text) {
  return /^00(?:0[13]|8[13]);/i.test(String(text || "").trim());
}

// Gatekeeper refuses a Chrome-quarantined shim before the helper reaches main.
// Clear that attribute and ad-hoc sign this dylib only. Never codesign or
// strip either Helper.app: the Accessibility grant is the granted bundle's cdhash.
async function acceptMenuShim(dylib) {
  const dropQuarantine = () => execFileAsync(
    "/usr/bin/xattr",
    ["-d", "com.apple.quarantine", dylib],
    { timeout: 4000 },
  );
  await dropQuarantine();
  const info = await execFileAsync("/usr/bin/codesign", ["-dv", dylib], { timeout: 4000 });
  const detail = `${info.stderr}\n${info.stdout}`;
  const adhoc = /flags=0x2\(adhoc\)/.test(detail) && !/linker-signed/.test(detail);
  if (!adhoc) {
    const signed = await execFileAsync(
      "/usr/bin/codesign",
      ["--force", "--sign", "-", dylib],
      { timeout: 10000 },
    );
    if (!signed.ok) return false;
    await dropQuarantine();
  }
  const left = await execFileAsync("/usr/bin/xattr", ["-p", "com.apple.quarantine", dylib], { timeout: 4000 });
  return fs.existsSync(dylib) && (!left.ok || !menuShimQuarantineBlocks(left.stdout));
}

// The dylib stays outside the .app. A source-hash hit still has to pass
// acceptMenuShim: Chrome can quarantine a dylib whose source hash already matches.
export async function ensureMenuShim(homeDir) {
  if (!fs.existsSync(MENU_SHIM_SOURCE_PATH)) return "";
  const dylib = menuShimPath(homeDir);
  const hashFile = `${dylib}.sha256`;
  let src;
  try { src = fs.readFileSync(MENU_SHIM_SOURCE_PATH); } catch { return ""; }
  const want = crypto.createHash("sha256").update(src).digest("hex");
  let ready = false;
  try {
    ready = fs.existsSync(dylib) && fs.readFileSync(hashFile, "utf8").trim() === want;
  } catch { ready = false; }
  if (!ready) {
    try { fs.mkdirSync(path.dirname(dylib), { recursive: true }); } catch { return ""; }
    const compiled = await execFileAsync("/usr/bin/clang", [
      "-O2", "-fno-objc-arc", "-dynamiclib", "-framework", "Foundation",
      MENU_SHIM_SOURCE_PATH, "-o", dylib,
    ], { timeout: 20000 });
    if (!compiled.ok || !fs.existsSync(dylib)) return "";
    try { fs.writeFileSync(hashFile, `${want}\n`, { mode: 0o600 }); } catch { return ""; }
  }
  return (await acceptMenuShim(dylib)) ? dylib : "";
}

// `mode: "open"` is only a sentinel. launchMacAxHelper refuses it when the
// current bundle is gatekeeper-blocked and never uses it for a trusted Mach-O.
export function planAxLaunch({
  action = "",
  currentBlocked = false,
  currentTrusted = false,
  grantedExists = false,
  grantedTrusted = false,
  shimReady = false,
} = {}) {
  if (!currentBlocked && currentTrusted === true) {
    return { target: "current", mode: "direct", useShim: false };
  }
  if (grantedExists && grantedTrusted === true) {
    if (action === "open" && !shimReady) {
      return { target: "current", mode: currentBlocked ? "open" : "direct", useShim: false };
    }
    return { target: "granted", mode: "direct", useShim: action === "open" };
  }
  return { target: "current", mode: currentBlocked ? "open" : "direct", useShim: false };
}

function choiceFor(plan, appPath, trust, action, shimPath) {
  const env = { ...process.env };
  delete env.DYLD_INSERT_LIBRARIES;
  if (plan.useShim && shimPath) env.DYLD_INSERT_LIBRARIES = shimPath;
  return {
    mode: plan.mode,
    appPath,
    bin: helperExecutable(appPath),
    cdhash: trust.cdhash || "",
    env,
    shortCircuit: plan.mode === "direct" && action === "ax_status" && trust.fromProbe ? trust.body : null,
  };
}

async function chooseAxLaunch(homeDir, payload, currentApp, currentBlocked) {
  const action = String(payload?.action || "");
  const refreshStale = action === "ax_status" || action === "request_accessibility";
  const current = currentBlocked
    ? { trusted: false, fromProbe: false, cdhash: "", body: null }
    : await resolveTrust(homeDir, currentApp, refreshStale);
  if (!currentBlocked && current.trusted === true) {
    return choiceFor(planAxLaunch({ action, currentTrusted: true }), currentApp, current, action, "");
  }

  const grantedApp = grantedHelperApp(homeDir);
  const grantedBin = helperExecutable(grantedApp);
  const grantedExists = fs.existsSync(grantedBin) && await checkHelperLaunchPolicy(grantedApp) == null;
  let granted = { trusted: false, fromProbe: false, cdhash: "", body: null };
  let shim = "";
  if (grantedExists) {
    granted = await resolveTrust(homeDir, grantedApp, refreshStale);
    if (granted.trusted === true && action === "open") shim = await ensureMenuShim(homeDir);
  }
  const plan = planAxLaunch({
    action,
    currentBlocked,
    currentTrusted: false,
    grantedExists,
    grantedTrusted: granted.trusted === true,
    shimReady: Boolean(shim),
  });
  const useGranted = plan.target === "granted";
  return choiceFor(plan, useGranted ? grantedApp : currentApp, useGranted ? granted : current, action, shim);
}

async function launchMacAxHelper(payload, { background = true, timeoutMs = 20000 } = {}) {
  const homeDir = os.homedir();
  const built = await buildMacAxHelper(homeDir);
  if (!built.ok) return built.code ? built : { ...built, helperUnavailable: true };
  const blocked = await checkHelperLaunchPolicy(built.appPath);
  let choice;
  try {
    choice = await chooseAxLaunch(homeDir, payload, built.appPath, Boolean(blocked));
  } catch {
    if (blocked) return blocked;
    const action = String(payload?.action || "");
    choice = choiceFor(
      planAxLaunch({ action, currentBlocked: false, currentTrusted: false }),
      built.appPath,
      { cdhash: "", fromProbe: false, body: null },
      action,
      "",
    );
  }
  // Same bundle id as the granted copy: `open` can start the other app, or a
  // translocated image. An undisclaimed direct spawn also disagrees with the
  // cdhash, because TCC follows Herdr or Chrome instead of the helper. Spawn
  // that Mach-O through the disclaim launcher.
  if (choice.mode !== "direct" && blocked) return blocked;
  if (choice.shortCircuit) {
    return { ...choice.shortCircuit, helperAppPath: choice.appPath, helperName: HELPER_NAME };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pagelens-ax-"));
  const reqPath = path.join(dir, "request.json");
  const resPath = path.join(dir, "response.json");
  let childPid = 0;
  try {
    const deadline = Date.now() + timeoutMs;
    fs.writeFileSync(reqPath, JSON.stringify({ ...payload, deadlineMs: deadline - 750 }), { mode: 0o600 });
    let launch;
    if (choice.mode === "direct") {
      const launcher = await ensureDisclaimLauncher(homeDir);
      const spawned = launcher
        ? await spawnHelperDisclaimed(launcher, choice.bin, [reqPath, resPath], choice.env)
        : { ok: false, error: "无法准备辅助功能责任放弃启动器。" };
      childPid = spawned.pid || 0;
      launch = spawned.ok ? { ok: true, stderr: "", err: null } : { ok: false, stderr: spawned.error || "", err: null };
    } else {
      const openArgs = ["-n", ...(background ? ["-g"] : []), choice.appPath, "--args", reqPath, resPath];
      launch = await execFileAsync("/usr/bin/open", openArgs, { timeout: Math.min(timeoutMs, 5000) });
      if (!launch.ok && /Resource busy|Code=(?:2|16)\b/i.test(launch.stderr) && fs.existsSync(reqPath)) {
        // LaunchServices can briefly hold the bundle after the previous instance
        // exits. Each instance must atomically claim this same request before work.
        await sleep(350);
        launch = await execFileAsync("/usr/bin/open", openArgs, { timeout: Math.min(timeoutMs, 5000) });
      }
    }
    while (Date.now() < deadline && !fs.existsSync(resPath)) {
      if (!launch.ok && fs.existsSync(reqPath)) break;
      await sleep(80);
    }
    if (!fs.existsSync(resPath)) {
      if (childPid) {
        try { process.kill(childPid, "SIGTERM"); } catch { /* already gone */ }
      }
      let phase = "launch_requested";
      try { phase = fs.readFileSync(`${resPath}.phase`, "utf8").trim(); } catch { /* never started */ }
      const claimed = fs.existsSync(`${reqPath}.claimed`);
      const hint = phase === "launch_requested" || !claimed
        ? "系统尚未将请求交给助手。可在访达中打开 PageLens Helper.app 查看 macOS 的启动提示。"
        : "助手已启动。请保持请求窗口在前台，重新检测辅助功能权限后重试。";
      return { ok: false, code: launch.ok ? "HELPER_TIMEOUT" : "HELPER_LAUNCH_FAILED", phase, claimed, hint,
        helperAppPath: choice.appPath, helperName: HELPER_NAME,
        error: (launch.stderr || launch.err?.message || `PageLens Helper 超时（${phase}）。${hint}`).trim() };
    }
    const parsed = JSON.parse(fs.readFileSync(resPath, "utf8"));
    // An `open` result belongs to LaunchServices' identity. Do not store it
    // against this cdhash, or a false there hides a trusted direct spawn.
    if (choice.mode === "direct" && typeof parsed.trusted === "boolean") {
      rememberTrust(homeDir, choice.cdhash, parsed.trusted, TRUST_VIA_DISCLAIM);
    }
    return { ...parsed, helperAppPath: choice.appPath, helperName: HELPER_NAME };
  } catch (err) {
    if (childPid) {
      try { process.kill(childPid, "SIGTERM"); } catch { /* already gone */ }
    }
    return { ok: false, helperAppPath: choice.appPath, helperName: HELPER_NAME, error: err?.message || String(err) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function revealMacAxHelper() {
  if (process.platform !== "darwin") {
    return { ok: false, code: "UNSUPPORTED_PLATFORM", error: "仅 macOS 支持定位 PageLens Helper。" };
  }
  const appPath = macAxHelperAppPath();
  const built = fs.existsSync(appPath) ? { ok: true, appPath } : await ensureMacAxHelper();
  if (!built.ok) return built;
  const opened = await execFileAsync("/usr/bin/open", ["-R", built.appPath], { timeout: 5000 });
  return { ok: opened.ok, helperName: HELPER_NAME, helperAppPath: built.appPath, ...(opened.ok ? {} : { error: opened.stderr || opened.err?.message }) };
}

function axHintWithPath(appPath = macAxHelperAppPath()) {
  return `Chrome 原生助手受 macOS 权限隔离限制，不能复用 Google Chrome 的辅助功能开关；请在「系统设置 → 隐私与安全性 → 辅助功能」里开启「${HELPER_NAME}」（若列表中尚未出现，点「定位 Helper」或点「+」添加 ${appPath}），开启后直接点「重新检测」即可生效（无需重启 Chrome）。`;
}

function openAccessibilitySettingsPane() {
  return new Promise((resolve) => {
    execFile(
      "open",
      ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"],
      { timeout: 5000 },
      (err) => resolve(!err),
    );
  });
}

export async function checkMacAccessibility() {
  if (process.platform !== "darwin") {
    return { ok: false, trusted: false, code: "UNSUPPORTED_PLATFORM", error: "当前仅支持 macOS 辅助功能操控 Chrome 原生已关闭标签组菜单。" };
  }
  const helperRes = await runMacAxHelper({ action: "ax_status" }, { background: true, timeoutMs: 8000 });
  if (!helperRes.ok) return helperRes;
  return { ...helperRes, via: "helper_app", ...(!helperRes.trusted ? { code: "ACCESSIBILITY_REQUIRED", hint: axHintWithPath(helperRes.helperAppPath) } : {}) };
}

export async function requestMacAccessibility() {
  if (process.platform !== "darwin") {
    return { ok: false, trusted: false, code: "UNSUPPORTED_PLATFORM", error: "当前仅支持 macOS 辅助功能权限申请。" };
  }
  const helperRes = await runMacAxHelper({ action: "request_accessibility" }, { background: false, timeoutMs: 10000 });
  if (!helperRes.ok) return helperRes;
  const trusted = Boolean(helperRes.trusted);
  let openedSettings = false;
  if (!trusted) {
    openedSettings = await openAccessibilitySettingsPane();
  }
  const appPath = helperRes?.helperAppPath || macAxHelperAppPath();
  return {
    ok: true,
    trusted,
    openedSettings,
    helperName: HELPER_NAME,
    helperAppPath: appPath,
    ...(!trusted ? { code: "ACCESSIBILITY_REQUIRED", hint: axHintWithPath(appPath) } : {}),
  };
}

export async function diagnoseMacChromeUi({ appName = "Google Chrome" } = {}) {
  if (process.platform !== "darwin") {
    return { ok: false, trusted: false, code: "UNSUPPORTED_PLATFORM", error: "当前仅支持 macOS UI 诊断。" };
  }
  const res = await runMacAxHelper({ action: "diagnose", appName }, { timeoutMs: 12000 });
  return res.code === "ACCESSIBILITY_REQUIRED" ? { ...res, hint: axHintWithPath(res.helperAppPath) } : res;
}

function extensionIdFromArgv(argv = process.argv) {
  for (const arg of argv) {
    const m = /^chrome-extension:\/\/([a-p]{32})\/?$/i.exec(String(arg || ""));
    if (m) return m[1];
  }
  return "";
}

/** Main Native Host request dispatcher for op: "saved_tab_groups". */
export async function handleSavedTabGroups(req = {}) {
  const action = String(req.action || "list").trim();
  const extensionId = req.extensionId || extensionIdFromArgv();
  if (action === "list") {
    const res = readNativeSavedTabGroups({
      userDataDir: req.userDataDir,
      profile: req.profile,
      extensionId,
      profileMarker: req.profileMarker,
      query: req.query,
      color: req.color,
    });
    return { op: "saved_tab_groups", action, supportsBoundOpen: true, ...res };
  }
  if (action === "ax_status") {
    const res = await checkMacAccessibility();
    return { op: "saved_tab_groups", action, ...res };
  }
  if (action === "request_accessibility") {
    const res = await requestMacAccessibility();
    return { op: "saved_tab_groups", action, ...res };
  }
  if (action === "reveal_helper") {
    const res = await revealMacAxHelper();
    return { op: "saved_tab_groups", action, ...res };
  }
  if (action === "diagnose") {
    const res = await diagnoseMacChromeUi({ appName: req.appName || "Google Chrome" });
    return { op: "saved_tab_groups", action, ...res };
  }
  if (action === "open" || action === "delete") {
    const list = readNativeSavedTabGroups({ userDataDir: req.userDataDir, profile: req.profile, extensionId, profileMarker: req.profileMarker });
    const target = resolveSavedGroupAction(req, list);
    if (!target.ok) return { op: "saved_tab_groups", action, ...target };
    if (process.platform !== "darwin") {
      return { ok: false, op: "saved_tab_groups", action, code: "UNSUPPORTED_PLATFORM", error: "当前仅支持 macOS 原生打开已关闭的 Chrome 保存组。" };
    }
    const res = await runMacAxHelper({
      ...target, action: "open", windowMarker: req.windowMarker, appName: req.appName || "Google Chrome",
    }, { timeoutMs: 22000 });
    const result = { ...res, op: "saved_tab_groups", action, guid: req.guid, profile: list.profile, windowMarker: req.windowMarker };
    if (res.code === "ACCESSIBILITY_REQUIRED") result.hint = axHintWithPath(res.helperAppPath);
    // A native UI action can open a candidate, but only the requesting extension
    // can verify its tabs and window before it ungroups anything.
    if (res.ok && action === "delete") return { ...result, ok: false, fallbackOpenToDelete: true };
    return result;
  }
  return { ok: false, op: "saved_tab_groups", action, error: `未知 action：${action}` };
}

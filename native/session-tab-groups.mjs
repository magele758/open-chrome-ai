import fs from "node:fs";
import path from "node:path";

// The desktop SessionService stores the link between a local tab group token and
// its saved GUID in command 27. Command 25 links that token to Chrome tab IDs.
// Layouts: components/sessions/core/session_service_commands.cc (Chromium).
function consumeGroupMetadata(payload, guids) {
  if (payload.length < 28 || payload.readUInt32LE(0) !== payload.length - 4) {
    throw new Error("Invalid session group metadata");
  }
  const token = payload.toString("hex", 4, 20);
  const titleBytes = payload.readUInt32LE(20) * 2;
  const colorOffset = 24 + Math.ceil(titleBytes / 4) * 4;
  if (colorOffset + 4 > payload.length) throw new Error("Truncated session group metadata");
  const savedOffset = colorOffset + 8; // color, is_collapsed, is_saved
  guids.delete(token);
  if (savedOffset + 4 > payload.length || !payload.readUInt32LE(savedOffset)) return;
  const guidOffset = savedOffset + 8;
  if (guidOffset + 36 !== payload.length || payload.readUInt32LE(savedOffset + 4) !== 36) {
    throw new Error("Unrecognized saved group GUID");
  }
  const guid = payload.toString("utf8", guidOffset);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(guid)) throw new Error("Invalid saved group GUID");
  guids.set(token, guid);
}

function newestSession(dir) {
  return fs.readdirSync(dir)
    .filter((file) => /^Session_\d+$/.test(file))
    .sort((a, b) => b.length - a.length || b.localeCompare(a))[0];
}

// The session file can contain page navigation and form state. Seek past those
// records; only read the payloads for the five commands used for group membership.
function readSessionSnapshot(fd, size) {
  const read = (buffer, offset) => {
    if (fs.readSync(fd, buffer, 0, buffer.length, offset) !== buffer.length) throw new Error("Session rotated");
    return buffer;
  };
  const header = read(Buffer.alloc(8), 0);
  if (header.toString("ascii", 0, 4) !== "SNSS" || header.readUInt32LE(4) !== 3) return new Map();
  const windows = new Map();
  const tokens = new Map();
  const guids = new Map();
  const closedWindows = new Set();
  let hasInitialState = false;
  const frame = Buffer.alloc(3);
  for (let offset = 8; offset < size;) {
    read(frame, offset);
    const length = frame.readUInt16LE(0);
    const type = frame[2];
    const end = offset + 2 + length;
    if (length === 0 || end > size) throw new Error("Incomplete session record");
    if (type === 255) hasInitialState = true;
    if ([0, 16, 17, 25, 27].includes(type)) {
      const payload = read(Buffer.alloc(length - 1), offset + 3);
      if (type === 0) {
        if (payload.length !== 8) throw new Error("Invalid session tab window");
        windows.set(payload.readInt32LE(4), payload.readInt32LE(0));
      } else if (type === 16) {
        const tabId = payload.readInt32LE(0);
        tokens.delete(tabId);
        windows.delete(tabId);
      } else if (type === 17) {
        closedWindows.add(payload.readInt32LE(0));
      } else if (type === 25) {
        if (payload.length !== 32 || payload[24] > 1) throw new Error("Unsupported session group membership");
        const tabId = payload.readInt32LE(0);
        if (payload[24] === 1) tokens.set(tabId, payload.toString("hex", 8, 24));
        else tokens.delete(tabId);
      } else {
        consumeGroupMetadata(payload, guids);
      }
    }
    offset = end;
  }
  if (!hasInitialState) return new Map();
  const result = new Map();
  const ambiguous = new Set();
  for (const [tabId, token] of tokens) {
    const guid = guids.get(token);
    const windowId = windows.get(tabId);
    if (!guid || closedWindows.has(windowId)) continue;
    const group = result.get(guid);
    if (windowId === undefined || (group && (group.token !== token || group.sessionWindowId !== windowId))) {
      ambiguous.add(guid);
      continue;
    }
    if (group) group.sessionTabIds.push(tabId);
    else result.set(guid, { token, sessionWindowId: windowId, sessionTabIds: [tabId] });
  }
  for (const guid of ambiguous) result.delete(guid);
  return result;
}

/** Optional metadata. Missing, encrypted or rotating current sessions provide no evidence. */
export function readSessionGroupBindings(profileDir) {
  let fd;
  try {
    const dir = path.join(profileDir, "Sessions");
    const filename = newestSession(dir);
    if (!filename) return new Map();
    fd = fs.openSync(path.join(dir, filename), "r");
    const snapshot = fs.fstatSync(fd);
    const bindings = readSessionSnapshot(fd, snapshot.size);
    const after = fs.fstatSync(fd);
    if (snapshot.size !== after.size || snapshot.mtimeMs !== after.mtimeMs || filename !== newestSession(dir)) return new Map();
    for (const binding of bindings.values()) {
      delete binding.token;
      binding.sessionUpdatedAt = snapshot.mtimeMs;
    }
    return bindings;
  } catch {
    return new Map();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

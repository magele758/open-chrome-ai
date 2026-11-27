import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSessionGroupBindings } from "../../native/session-tab-groups.mjs";

const guid = "12345678-1234-4000-8000-123456789abc";
const token = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const header = Buffer.from([83, 78, 83, 83, 3, 0, 0, 0]); // SNSS, version 3
function command(type, payload = Buffer.alloc(0)) {
  const frame = Buffer.alloc(3);
  frame.writeUInt16LE(1 + payload.length, 0);
  frame[2] = type;
  return Buffer.concat([frame, payload]);
}
function windowForTab(tab, window) {
  const data = Buffer.alloc(8);
  data.writeInt32LE(window, 0);
  data.writeInt32LE(tab, 4);
  return command(0, data);
}
function tabGroup(tab, group) {
  const data = Buffer.alloc(32);
  data.writeInt32LE(tab, 0);
  if (group) {
    group.copy(data, 8);
    data[24] = 1;
  }
  return command(25, data);
}
function metadata(group, saved = true) {
  const title = Buffer.from("工作组", "utf16le");
  const color = 24 + Math.ceil(title.length / 4) * 4;
  const data = Buffer.alloc(color + 12 + (saved ? 40 : 0));
  data.writeUInt32LE(data.length - 4);
  group.copy(data, 4);
  data.writeUInt32LE(title.length / 2, 20);
  title.copy(data, 24);
  if (saved) {
    data.writeUInt32LE(1, color + 8);
    data.writeUInt32LE(36, color + 12);
    data.write(guid, color + 16);
  }
  return command(27, data);
}
function close(type, id) {
  const data = Buffer.alloc(16);
  data.writeInt32LE(id);
  return command(type, data);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pl-session-groups-"));
try {
  const dir = path.join(profile, "Sessions");
  fs.mkdirSync(dir);
  const older = path.join(dir, "Session_9");
  const current = path.join(dir, "Session_10");
  const initial = Buffer.concat([
    header, windowForTab(10, 3), windowForTab(11, 3), windowForTab(12, 3),
    tabGroup(10, token), tabGroup(11, token), tabGroup(12, token), metadata(token),
  ]);
  fs.writeFileSync(older, Buffer.concat([initial, command(255)]));
  fs.writeFileSync(current, initial);
  const read = () => readSessionGroupBindings(profile).get(guid);
  assert.equal(read(), undefined, "an unfinished new session supersedes older sessions");
  fs.appendFileSync(current, Buffer.concat([command(255), tabGroup(12, null), close(16, 11)]));
  assert.deepEqual(read().sessionTabIds, [10]);
  assert.equal(read().sessionWindowId, 3);
  assert.equal(read().sessionUpdatedAt, fs.statSync(current).mtimeMs);
  fs.appendFileSync(current, close(17, 3));
  assert.equal(read(), undefined, "closed windows have no live group binding");
  const other = Buffer.alloc(16, 0x11);
  fs.writeFileSync(current, Buffer.concat([
    initial, command(255), windowForTab(13, 3), tabGroup(13, other), metadata(other),
  ]));
  assert.equal(read(), undefined, "different live tokens mapped to the same GUID are ambiguous");
  fs.appendFileSync(current, metadata(other, false));
  assert.deepEqual(read().sessionTabIds, [10, 11, 12], "unsaving clears the earlier token binding");
  fs.appendFileSync(current, Buffer.from([30, 0, 27]));
  assert.equal(read(), undefined, "truncated records supply no evidence");
  fs.writeFileSync(current, Buffer.from([83, 78, 83, 83, 5, 0, 0, 0]));
  assert.equal(read(), undefined, "encrypted or unknown versions are optional");
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}
console.log("PASS test_saved_group_sessions.mjs");

import "./fixtures/web-locks.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveSavedGroupAction,
  decodeSavedTabGroupRecord,
  handleSavedTabGroups,
  readNativeSavedTabGroups,
  resolveChromeProfile,
  snappyUncompress,
} from "../../native/saved-tab-groups.mjs";
import { handleRequest } from "../../native/pagelens-host.mjs";
import {
  SAVED_GROUPS_USE_HELPER_KEY,
  deleteSavedTabGroupRecord,
  listSavedTabGroups,
  saveTabGroupRecord,
  updateSavedTabGroupRecord,
} from "../lib/saved-tab-groups.js";
import { createSavedTabGroupTools, deleteSingleNativeSavedGroup } from "../lib/agent/saved-tab-group-tools.js";
import { createAgentTools, resolveActiveTools } from "../lib/agent/tools.js";
import { READ_ONLY_TOOLS, isToolPrivileged, toolCategory } from "../lib/agent/trust/tool-classes.js";
import { matchIrreversible } from "../lib/agent/trust/irreversible.js";
import { decideToolCall } from "../lib/agent/trust/decide.js";
import { capsuleCovers, extractCapsule } from "../lib/agent/trust/capsule.js";
import { sourceLabel } from "../lib/agent/trust/taint.js";
import { PAGE_CONTENT_TOOLS } from "../lib/untrusted.js";
import { createBridge } from "../lib/bridge/index.js";
import { createTokenRecord, SCOPE_PRESETS } from "../lib/bridge/auth.js";
import { chromeTabGroups } from "../lib/bridge/leases.js";
import { ERROR_CODES } from "../lib/bridge/protocol.js";
import { createApprovalQueue } from "../lib/agent/trust/approval-queue.js";
import { normalizeSettings } from "../lib/storage.js";

// =========================================================================
// Helpers to synthesize valid Snappy, LevelDB WAL, SSTable, MANIFEST & Protobuf
// =========================================================================
function encodeVarint(n) {
  let v = BigInt(n);
  const bytes = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function protoVarint(field, val) {
  return Buffer.concat([encodeVarint((BigInt(field) << 3n) | 0n), encodeVarint(val)]);
}

function protoBytes(field, buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), "utf8");
  return Buffer.concat([encodeVarint((BigInt(field) << 3n) | 2n), encodeVarint(b.length), b]);
}

function buildSavedGroupProto({ guid, title, colorNum, position = 0, createdUs = 13439744690611518n }) {
  const groupMsg = Buffer.concat([protoBytes(2, title), protoVarint(3, colorNum), protoVarint(4, position)]);
  const spec = Buffer.concat([protoBytes(1, guid), protoVarint(2, createdUs), protoVarint(3, createdUs), protoBytes(4, groupMsg)]);
  return Buffer.concat([protoVarint(1, 1), protoBytes(2, spec)]);
}

function buildSavedTabProto({ guid, groupGuid, url, title, position = 0, createdUs = 13439744690611518n }) {
  const tabMsg = Buffer.concat([protoBytes(1, groupGuid), protoVarint(2, position), protoBytes(3, url), protoBytes(4, title)]);
  const spec = Buffer.concat([protoBytes(1, guid), protoVarint(2, createdUs), protoVarint(3, createdUs), protoBytes(5, tabMsg)]);
  return Buffer.concat([protoVarint(1, 1), protoBytes(2, spec)]);
}

function buildWalRecord(payload) {
  const hdr = Buffer.alloc(7);
  hdr.writeUInt32LE(0, 0); // crc not checked by reader
  hdr.writeUInt16LE(payload.length, 4);
  hdr[6] = 1; // FULL
  return Buffer.concat([hdr, payload]);
}

function buildWriteBatch(seq, entries) {
  const hdr = Buffer.alloc(12);
  hdr.writeBigUInt64LE(BigInt(seq), 0);
  hdr.writeUInt32LE(entries.length, 8);
  const parts = [hdr];
  for (const e of entries) {
    const k = Buffer.from(e.key, "utf8");
    if (e.op === "PUT") {
      parts.push(Buffer.from([1]), encodeVarint(k.length), k, encodeVarint(e.val.length), e.val);
    } else {
      parts.push(Buffer.from([0]), encodeVarint(k.length), k);
    }
  }
  return buildWalRecord(Buffer.concat(parts));
}

function snappyCompressLiteral(buf) {
  const parts = [encodeVarint(buf.length)];
  let pos = 0;
  while (pos < buf.length) {
    const chunkLen = Math.min(buf.length - pos, 60);
    parts.push(Buffer.from([(chunkLen - 1) << 2]), buf.subarray(pos, pos + chunkLen));
    pos += chunkLen;
  }
  return Buffer.concat(parts);
}

function buildDataBlock(sortedEntries) {
  const parts = [];
  for (const { key, val } of sortedEntries) {
    parts.push(encodeVarint(0), encodeVarint(key.length), encodeVarint(val.length), key, val);
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(0, 0); // restart[0] = 0
  trailer.writeUInt32LE(1, 4); // num_restarts = 1
  parts.push(trailer);
  return Buffer.concat(parts);
}

function buildSstable(entries, { snappy = true } = {}) {
  const internalEntries = entries
    .map((e) => {
      const uk = Buffer.from(e.key, "utf8");
      const tr = Buffer.alloc(8);
      tr.writeBigUInt64LE((BigInt(e.seq) << 8n) | BigInt(e.op === "PUT" ? 1 : 0), 0);
      return { key: Buffer.concat([uk, tr]), val: e.val || Buffer.alloc(0) };
    })
    .sort((a, b) => Buffer.compare(a.key, b.key));

  const rawData = buildDataBlock(internalEntries);
  const encodedData = snappy ? snappyCompressLiteral(rawData) : rawData;
  const dataBlock = Buffer.concat([encodedData, Buffer.from([snappy ? 1 : 0, 0, 0, 0, 0])]);

  const dataOffset = 0;
  const dataSize = encodedData.length;
  const indexVal = Buffer.concat([encodeVarint(dataOffset), encodeVarint(dataSize)]);
  const indexBlockRaw = buildDataBlock([{ key: internalEntries.at(-1).key, val: indexVal }]);
  const indexBlock = Buffer.concat([indexBlockRaw, Buffer.from([0, 0, 0, 0, 0])]);

  const indexOffset = dataBlock.length;
  const indexSize = indexBlockRaw.length;

  const metaHandle = Buffer.concat([encodeVarint(0), encodeVarint(0)]);
  const idxHandle = Buffer.concat([encodeVarint(indexOffset), encodeVarint(indexSize)]);
  const handles = Buffer.concat([metaHandle, idxHandle]);
  const footer = Buffer.alloc(48);
  handles.copy(footer, 0);
  Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]).copy(footer, 40);

  return Buffer.concat([dataBlock, indexBlock, footer]);
}

// =========================================================================
// 1. Snappy, Protobuf, LevelDB (.ldb + .log + MANIFEST) & Native Host Tests
// =========================================================================
{
  // Test Snappy with literal + overlapping RLE copy ("abc" + copy len=6 offset=3 -> "abcabcabc")
  const snappyRle = Buffer.from([9, 2 << 2, 0x61, 0x62, 0x63, ((6 - 4) << 2) | 1, 3]);
  assert.equal(snappyUncompress(snappyRle).toString("utf8"), "abcabcabc");

  // Decode protobuf record directly
  const gProto = buildSavedGroupProto({ guid: "g-1", title: "TikTok 测试", colorNum: 9, position: 2 });
  const dec = decodeSavedTabGroupRecord(gProto);
  assert.equal(dec.kind, "group");
  assert.equal(dec.guid, "g-1");
  assert.equal(dec.title, "TikTok 测试");
  assert.equal(dec.color, "orange");
  assert.equal(dec.position, 2);
  assert.ok(dec.createdAt > 1700000000000);

  // Build temp Chrome userDataDir with Default + Profile 1 (extension matched to Profile 1)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pl-test-saved-ldb-"));
  try {
    fs.mkdirSync(path.join(root, "Default", "Sync Data", "LevelDB"), { recursive: true });
    const syncDir = path.join(root, "Profile 1", "Sync Data", "LevelDB");
    fs.mkdirSync(syncDir, { recursive: true });
    fs.writeFileSync(path.join(root, "Profile 1", "Preferences"), JSON.stringify({ extensions: { settings: { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: {} } } }));
    fs.writeFileSync(path.join(root, "Default", "Secure Preferences"), JSON.stringify({ extensions: { settings: { bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: {} } } }));
    fs.writeFileSync(path.join(root, "Local State"), JSON.stringify({ profile: { last_used: "Default" } }));

    const resolved = resolveChromeProfile({ userDataDir: root, extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    assert.equal(resolved.profile, "Profile 1");
    assert.deepEqual(resolved.profiles, ["Default", "Profile 1"]);
    const resolvedSecure = resolveChromeProfile({ userDataDir: root, extensionId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
    assert.equal(resolvedSecure.profile, "Default", "matches unpacked extension in Secure Preferences");

    // SSTable 000005.ldb (Snappy compressed): has Group A (blue), Group B (red), and tabs for both
    const sst = buildSstable([
      { key: "saved_tab_group-dt-ga", seq: 10, op: "PUT", val: buildSavedGroupProto({ guid: "ga", title: "TikTok 店铺测试 A", colorNum: 2, position: 1 }) },
      { key: "saved_tab_group-dt-ta2", seq: 11, op: "PUT", val: buildSavedTabProto({ guid: "ta2", groupGuid: "ga", url: "https://shop.tiktok.com/2", title: "商品2", position: 2 }) },
      { key: "saved_tab_group-dt-ta1", seq: 12, op: "PUT", val: buildSavedTabProto({ guid: "ta1", groupGuid: "ga", url: "https://shop.tiktok.com/1", title: "商品1", position: 0 }) },
      { key: "saved_tab_group-dt-gb", seq: 13, op: "PUT", val: buildSavedGroupProto({ guid: "gb", title: "已删除旧组", colorNum: 3, position: 0 }) },
      { key: "saved_tab_group-dt-tb1", seq: 14, op: "PUT", val: buildSavedTabProto({ guid: "tb1", groupGuid: "gb", url: "https://old.example/", title: "Old", position: 0 }) },
    ]);
    fs.writeFileSync(path.join(syncDir, "000005.ldb"), sst);

    // WAL 000007.log: deletes Group B (seq 20) and adds Group C (seq 21-22)
    const wal = Buffer.concat([
      buildWriteBatch(20, [
        { op: "DEL", key: "saved_tab_group-dt-gb" },
        { op: "PUT", key: "saved_tab_group-dt-gc", val: buildSavedGroupProto({ guid: "gc", title: "研究收藏", colorNum: 5, position: 0 }) },
        { op: "PUT", key: "saved_tab_group-dt-tc1", val: buildSavedTabProto({ guid: "tc1", groupGuid: "gc", url: "https://arxiv.org/abs/99", title: "Paper", position: 0 }) },
      ]),
    ]);
    fs.writeFileSync(path.join(syncDir, "000007.log"), wal);

    // MANIFEST-000002 registers live file 5 and logNumber 7
    const edit = Buffer.concat([
      encodeVarint(2), encodeVarint(7), // logNumber = 7
      encodeVarint(7), encodeVarint(0), encodeVarint(5), encodeVarint(sst.length), encodeVarint(1), Buffer.from("a"), encodeVarint(1), Buffer.from("z"),
    ]);
    fs.writeFileSync(path.join(syncDir, "MANIFEST-000002"), buildWalRecord(edit));
    fs.writeFileSync(path.join(syncDir, "CURRENT"), "MANIFEST-000002\n");

    const listed = readNativeSavedTabGroups({ userDataDir: root, extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    assert.equal(listed.ok, true);
    assert.equal(listed.profile, "Profile 1");
    assert.equal(listed.count, 2, "deleted group gb excluded; orphaned tab tb1 excluded");
    assert.deepEqual(listed.groups.map((g) => [g.guid, g.title, g.color]), [
      ["gc", "研究收藏", "green"],
      ["ga", "TikTok 店铺测试 A", "blue"],
    ]);
    assert.deepEqual(listed.groups[1].tabs.map((t) => t.url), ["https://shop.tiktok.com/1", "https://shop.tiktok.com/2"], "tabs sorted by position");

    const viaHost = await handleRequest({ op: "saved_tab_groups", action: "list", userDataDir: root, profile: "Profile 1", query: "tiktok" });
    assert.equal(viaHost.ok, true);
    assert.equal(viaHost.count, 1);
    assert.equal(viaHost.groups[0].guid, "ga");

    const badProfile = await handleSavedTabGroups({ action: "list", userDataDir: root, profile: "../etc" });
    assert.equal(badProfile.ok, false);

    const localGroupId = "1234567890ABCDEF1234567890ABCDEF";
    assert.equal(dec.localGroupId, null);
    const withLocalId = Buffer.concat([gProto, protoBytes(3, protoBytes(1, localGroupId))]);
    assert.equal(decodeSavedTabGroupRecord(withLocalId).localGroupId, localGroupId);

    // Both profiles can have the same extension ID. Bind to chrome.storage.local in the caller.
    const extensionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const profileMarker = "01020304-5678-1234-8901-123456789abc";
    const req = { op: "saved_tab_groups", action: "list", userDataDir: root, extensionId, profileMarker };
    for (const name of ["Default", "Profile 1"]) {
      const dir = path.join(root, name, "Local Extension Settings", extensionId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "CURRENT"), "MANIFEST-000001\n");
      fs.writeFileSync(path.join(dir, "MANIFEST-000001"), buildWalRecord(Buffer.from([2, 3])));
      const value = name === "Profile 1" ? profileMarker : "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
      fs.writeFileSync(path.join(dir, "000003.log"), buildWriteBatch(1, [
        { op: "PUT", key: "savedTabGroupsProfileMarker", val: Buffer.from(JSON.stringify(value)) },
      ]));
    }
    const bound = await handleRequest(req);
    assert.equal(bound.profile, "Profile 1");
    assert.equal(bound.profileMarker, profileMarker);
    assert.equal(bound.count, 2);
    assert.equal((await handleRequest({ ...req, profile: "Default" })).code, "PROFILE_MARKER_MISMATCH");
    assert.equal((await handleRequest({ ...req, profileMarker: "invalid" })).code, "PROFILE_MARKER_INVALID");
    assert.equal((await handleRequest({ ...req, profileMarker: "00000000-0000-0000-0000-000000000000" })).code, "PROFILE_MARKER_MISMATCH");

    // A partial read must not confirm that a previously listed GUID has disappeared.
    fs.renameSync(path.join(syncDir, "000005.ldb"), path.join(syncDir, "old-table"));
    assert.equal((await handleRequest(req)).code, "NATIVE_STORE_UNAVAILABLE");
    fs.writeFileSync(path.join(syncDir, "000005.ldb"), Buffer.from("broken active table"));
    assert.equal((await handleRequest(req)).code, "NATIVE_STORE_UNAVAILABLE");
    fs.writeFileSync(path.join(syncDir, "000005.ldb"), sst);
    fs.appendFileSync(path.join(syncDir, "MANIFEST-000002"), buildWalRecord(Buffer.from([6, 0, 5])));
    const compacted = await handleRequest(req);
    assert.equal(compacted.ok, true);
    assert.deepEqual(compacted.groups.map((g) => g.guid), ["gc"], "no live tables means obsolete files must be ignored");
    fs.appendFileSync(path.join(syncDir, "000007.log"), buildWriteBatch(40, [{ op: "DEL", key: "saved_tab_group-dt-gc" }]));
    const empty = await handleRequest(req);
    assert.equal(empty.profileMarker, profileMarker);
    assert.deepEqual(empty.groups, []);
    fs.appendFileSync(path.join(root, "Default", "Local Extension Settings", extensionId, "000003.log"), buildWriteBatch(2, [
      { op: "PUT", key: "savedTabGroupsProfileMarker", val: Buffer.from(JSON.stringify(profileMarker)) },
    ]));
    assert.equal((await handleRequest({ ...req, profile: "Profile 1" })).code, "PROFILE_MARKER_MISMATCH",
      "a cloned profile marker cannot be disambiguated by supplying the profile name");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const target = { guid: "target", title: "Demo", tabCount: 2, createdAt: 100, tabs: [{ title: "One", url: "https://one.example" }, { url: "https://two.example" }] };
  const snapshot = g => ({ guid: g.guid, title: g.title, color: g.color, urls: g.tabs.map(t => t.url).sort() });
  const list = { ok: true, profile: "Default", profileMarker: "1faa8f8f-e51c-46f5-b356-755dae4f2776", groups: [target] };
  const req = { ...target, candidateGroups: [snapshot(target)], profile: "Default", profileMarker: list.profileMarker, windowMarker: "PageLens-9d23209a-3649-4d56-966a-f7999941e35e" };
  const targetLabels = resolveSavedGroupAction(req, list).labels;
  assert.ok(targetLabels.includes("Demo"));
  assert.ok(targetLabels.includes("Demo group - Closed"));
  assert.ok(targetLabels.includes("“Demo”分组 - 已关闭"));
  assert.ok(targetLabels.includes("“Demo”分组 - 已打开"));
  assert.ok(targetLabels.includes("Demo group - Opened"));
  assert.ok(!targetLabels.includes("Demo - unrelated group"));
  assert.equal(resolveSavedGroupAction(req, { ...list, groups: [target, { ...target, guid: "other", title: "Demo group - Closed" }] }).scopedMenu, false);
  assert.equal(resolveSavedGroupAction({ ...req, guid: "stale" }, list).code, "GROUP_NOT_FOUND");
  assert.equal(resolveSavedGroupAction({ ...req, title: "Old" }, list).code, "GROUP_CHANGED");
  assert.equal(resolveSavedGroupAction({ ...req, tabCount: 3 }, list).code, "GROUP_CHANGED");
  assert.equal(resolveSavedGroupAction({ ...req, profile: "Profile 2" }, list).code, "TARGET_REQUIRED");
  assert.equal(resolveSavedGroupAction({ ...req, windowMarker: "Chrome" }, list).code, "TARGET_REQUIRED");
  assert.equal(resolveSavedGroupAction(req, { ...list, groups: [target, { ...target, guid: "other" }] }).code, "AMBIGUOUS_TARGET");
  const twins = [target, { ...target, guid: "other" }];
  assert.equal(resolveSavedGroupAction({ ...req, allowCandidate: true }, { ...list, groups: twins }).code, "GROUP_CHANGED");
  const sameTimePlan = resolveSavedGroupAction({ ...req, allowCandidate: true, candidateGroups: twins.map(snapshot) }, { ...list, groups: twins });
  assert.equal(sameTimePlan.index, -1);
  assert.equal(sameTimePlan.safeGrid, false);
  const three = [{ ...target, guid: "earlier", createdAt: 50 }, target, { ...target, guid: "later", createdAt: 150 }];
  const cohort = resolveSavedGroupAction({ ...req, allowCandidate: true, candidateGroups: three.map(snapshot) }, { ...list, groups: three });
  assert.equal(cohort.peerCount, 3);
  assert.equal(cohort.scopedMenu, true);
  assert.equal(cohort.safeGrid, false);
  assert.equal(cohort.index, 1);
  assert.deepEqual(cohort.tabLabels, ["One", "https://two.example"]);
  const unnamed = { ...target, title: "" };
  const unnamedRequest = { ...req, title: "", candidateGroups: [snapshot(unnamed)] };
  const unnamedList = { ...list, groups: [unnamed] };
  assert.ok(resolveSavedGroupAction(unnamedRequest, unnamedList).labels.includes("2 个标签页"));
  assert.equal(resolveSavedGroupAction(unnamedRequest, { ...list, groups: [unnamed, { ...target, guid: "other", title: "2 tabs" }] }).code, "AMBIGUOUS_TARGET");
}

// =========================================================================
// 2. PageLens Saved Tab Groups Store CRUD
// =========================================================================
{
  const mem = {};
  const storage = {
    get: async (k) => ({ [k]: structuredClone(mem[k]) }),
    set: async (obj) => Object.assign(mem, structuredClone(obj)),
  };

  const { record: s1 } = await saveTabGroupRecord(
    { title: "AI 资料", color: "purple", tabs: ["https://a.example/1", { url: "https://b.example/2", title: "B" }, "chrome://settings"] },
    { storage, now: () => 1000 },
  );
  assert.match(s1.id, /^stg_/);
  assert.equal(s1.tabs.length, 2, "non-http URLs skipped");
  assert.equal(s1.color, "purple");

  const updated = await updateSavedTabGroupRecord(
    s1.id,
    { title: "AI 精选", color: "cyan", addTabs: ["https://c.example/3"], removeUrls: ["https://a.example/1"] },
    { storage, now: () => 2000 },
  );
  assert.equal(updated.title, "AI 精选");
  assert.equal(updated.color, "cyan");
  assert.deepEqual(updated.tabs.map((t) => t.url), ["https://b.example/2", "https://c.example/3"]);

  const filtered = await listSavedTabGroups({ query: "c.example", storage });
  assert.equal(filtered.length, 1);

  const removed = await deleteSavedTabGroupRecord(s1.id, { storage });
  assert.equal(removed.id, s1.id);
  assert.equal((await listSavedTabGroups({ storage })).length, 0);
  if (globalThis.navigator?.locks) {
    // Separate module instances simulate two side panels sharing storage.local.
    const otherPanel = await import("../lib/saved-tab-groups.js?second-panel");
    const create = (id) => saveTabGroupRecord({ id, title: id, tabs: ["https://fixture.example/"] }, { storage });
    await create("first");
    await create("second");
    await Promise.all([
      deleteSavedTabGroupRecord("first", { storage }),
      otherPanel.deleteSavedTabGroupRecord("second", { storage }),
    ]);
    assert.deepEqual(await listSavedTabGroups({ storage }), [], "parallel deletes must not resurrect either group");
  }
}

// =========================================================================
// 3. Internal Agent Saved Tab Group Tools (Native + PageLens)
// =========================================================================
{
  const mem = {};
  const storage = {
    get: async (k) => ({ [k]: structuredClone(mem[k]) }),
    set: async (obj) => Object.assign(mem, structuredClone(obj)),
  };

  let nextTabId = 50;
  let nextGroupId = 200;
  const openGroups = new Map([
    [10, { id: 10, windowId: 1, title: "Open Native", color: "blue", collapsed: false }],
  ]);
  const openTabs = new Map([
    [1, { id: 1, windowId: 1, title: "Live A", url: "https://live.example/a", groupId: 10 }],
  ]);
  const nativeStore = [
    { guid: "ng-open", title: "Open Native", color: "blue", tabCount: 1, tabs: [{ guid: "nt1", title: "Live A", url: "https://live.example/a" }], source: "chrome_native" },
    { guid: "ng-closed", title: "TikTok MX 999999", color: "green", tabCount: 1, tabs: [{ guid: "nt2", title: "Seller", url: "https://seller.example/mx" }], source: "chrome_native" },
    { guid: "ng-closed-2", title: "TikTok MX 888888", color: "orange", tabCount: 1, tabs: [{ guid: "nt3", title: "Shop", url: "https://shop.example/88" }], source: "chrome_native" },
  ];
  const axCalls = [];
  const tabOpLog = [];
  const removedWindows = [];
  let failNextList = false;
  let axMode = "ok";
  const nativeGuidByOpenId = new Map([[10, "ng-open"]]);
  let verificationReadFailure = false;

  function syncOpenGroup(gid) {
    const target = nativeStore.find((g) => g.guid === nativeGuidByOpenId.get(gid));
    const group = openGroups.get(gid);
    if (!target || !group) return;
    target.title = group.title;
    target.color = group.color;
    target.tabs = [...openTabs.values()].filter((t) => t.groupId === gid).map((t) => ({ title: t.title, url: t.url }));
    target.tabCount = target.tabs.length;
  }

  const mockChrome = {
    windows: {
      getAll: async () => [...new Set([...openTabs.values()].map((tab) => tab.windowId))].map((id) => ({ id })),
      create: async ({ url }) => {
        const marker = await mockChrome.tabs.create({ url, active: true, windowId: 444 });
        return { id: 444, tabs: [marker] };
      },
      remove: async (id) => {
        assert.equal(id, 444, "only the temporary window may be closed");
        removedWindows.push(id);
        for (const [gid, g] of openGroups) if (g.windowId === id) openGroups.delete(gid);
        for (const [tid, t] of openTabs) if (t.windowId === id) openTabs.delete(tid);
      },
    },
    permissions: { contains: async () => true, request: async () => true },
    storage: { local: storage },
    tabs: {
      get: async (id) => openTabs.get(id),
      query: async (q = {}) =>
        [...openTabs.values()].filter((t) => (q.windowId == null || t.windowId === q.windowId) && (q.groupId == null || t.groupId === q.groupId)),
      create: async (opts) => {
        const id = nextTabId++;
        const title = opts.url.startsWith("data:") ? decodeURIComponent(opts.url).match(/<title>([^<]+)/)[1] : opts.url;
        const t = { id, windowId: opts.windowId ?? 1, title, url: opts.url, groupId: -1, active: Boolean(opts.active) };
        openTabs.set(id, t);
        return t;
      },
      group: async (opts) => {
        const ids = [].concat(opts.tabIds);
        let gid = opts.groupId;
        if (gid == null) {
          gid = nextGroupId++;
          openGroups.set(gid, { id: gid, windowId: opts.createProperties?.windowId ?? 1, title: "", color: "grey", collapsed: false });
        }
        for (const id of ids) openTabs.get(id).groupId = gid;
        syncOpenGroup(gid);
        return gid;
      },
      ungroup: async (rawIds) => {
        const ids = [].concat(rawIds);
        tabOpLog.push({ op: "ungroup", ids });
        for (const id of ids) {
          const t = openTabs.get(id);
          if (t) {
            const gid = t.groupId;
            t.groupId = -1;
            if (gid >= 0 && ![...openTabs.values()].some((x) => x.groupId === gid)) {
              openGroups.delete(gid);
              const idx = nativeStore.findIndex((g) => g.guid === nativeGuidByOpenId.get(gid));
              if (idx >= 0 && axMode !== "sticky") nativeStore.splice(idx, 1);
              if (axMode === "unreadable") verificationReadFailure = true;
            }
          }
        }
      },
      remove: async (rawIds) => {
        const ids = [].concat(rawIds);
        tabOpLog.push({ op: "remove", ids });
        for (const id of ids) {
          const t = openTabs.get(id);
          if (t) {
            const gid = t.groupId;
            openTabs.delete(id);
            if (gid >= 0 && ![...openTabs.values()].some((x) => x.groupId === gid)) openGroups.delete(gid);
          }
        }
      },
    },
    tabGroups: {
      move: async (gid, { windowId }) => {
        const g = openGroups.get(gid);
        if (axMode !== "sticky-window") {
          g.windowId = windowId;
          for (const t of openTabs.values()) if (t.groupId === gid) t.windowId = windowId;
        }
        return { ...g };
      },
      query: async () => [...openGroups.values()].map((g) => ({ ...g })),
      get: async (id) => {
        const g = openGroups.get(id);
        if (!g) throw new Error(`No group ${id}`);
        return { ...g };
      },
      update: async (id, props) => {
        const g = openGroups.get(id);
        Object.assign(g, props);
        syncOpenGroup(id);
        return { ...g };
      },
    },
  };
  globalThis.chrome = mockChrome;

  const nativeCall = async (req) => {
    if (req.action === "list") {
      if (failNextList) {
        failNextList = false;
        return { ok: false, error: "transient" };
      }
      if (verificationReadFailure) return { ok: false, error: "read failed" };
      const needle = String(req.query || "").trim().toLowerCase();
      const rows = nativeStore.filter((g) => !needle || g.title.toLowerCase().includes(needle));
      return { ok: true, supportsBoundOpen: true, profile: "Default", profiles: ["Default"], count: rows.length, groups: structuredClone(rows) };
    }
    if (req.action === "ax_status") {
      return { ok: true, trusted: axMode !== "denied", ...(axMode === "denied" ? { code: "ACCESSIBILITY_REQUIRED", hint: "去系统设置打开" } : {}) };
    }
    axCalls.push(req);
    if (axMode === "denied") {
      return { ok: false, code: "ACCESSIBILITY_REQUIRED", error: "需要辅助功能", hint: "去系统设置打开" };
    }
    if (req.action === "open") {
      assert.equal(req.profile, "Default");
      assert.match(req.windowMarker, /^PageLens-[0-9a-f-]+$/);
      const target = nativeStore.find((g) => g.guid === (axMode === "wrong-duplicate" ? "duplicate-2" : req.guid));
      assert.ok(req.candidateGroups.some((g) => g.guid === req.guid && Array.isArray(g.urls)));
      assert.equal(req.title, target.title);
      const requestWindow = [...openTabs.values()].find((t) => t.title === req.windowMarker).windowId;
      const windowId = {
        "restore-in-new-window": 19,
        "restore-in-existing-window": 20,
        "restore-in-unverified-window": 21,
      }[axMode] ?? requestWindow;
      if (windowId !== requestWindow) assert.equal(req.allowNewWindow, true);
      if (axMode === "restore-in-new-window") {
        await mockChrome.tabs.create({ windowId, url: "https://keep.example/new-window" });
      }
      const gid = nextGroupId++;
      nativeGuidByOpenId.set(gid, target.guid);
      openGroups.set(gid, { id: gid, windowId, title: target.title, color: target.color, collapsed: false });
      const sessionTabIds = [];
      for (const tab of target.tabs) {
        const tid = nextTabId++;
        const live = { id: tid, windowId, title: tab.title, url: tab.url, groupId: gid };
        if (axMode === "pending-unbound") Object.assign(live, { url: "about:blank", pendingUrl: tab.url, status: "loading" });
        if (axMode === "loading-bound" || axMode === "restore-in-new-window") Object.assign(live, { url: "", status: "loading" });
        openTabs.set(tid, live);
        sessionTabIds.push(tid);
      }
      if (axMode !== "pending-unbound" && axMode !== "restore-in-unverified-window") {
        Object.assign(target, { sessionTabIds, sessionWindowId: windowId, sessionUpdatedAt: Date.now() });
      }
      if (axMode === "flaky-list") failNextList = true;
      return { ok: true, candidateOpened: req.allowCandidate, via: "everything_menu", guid: req.guid, profile: req.profile, windowMarker: req.windowMarker };
    }
    return { ok: false };
  };

  const tools = createSavedTabGroupTools({ getWindowId: () => 1 }, { api: mockChrome, storage, nativeCall });
  const run = async (name, args = {}) => JSON.parse(await tools.find((t) => t.name === name).execute(args));

  // List returns every saved native group. Closed rows stay read-only.
  const allSaved = await run("list_saved_tab_groups", {});
  assert.equal(allSaved.chromeNative.count, 3);
  assert.equal(allSaved.chromeNative.groups.find((g) => g.guid === "ng-open").isOpen, true);
  for (const guid of ["ng-closed", "ng-closed-2"]) {
    const row = allSaved.chromeNative.groups.find((g) => g.guid === guid);
    assert.equal(row.isOpen, false);
    assert.equal(row.openGroupId, undefined);
  }

  const closedOnly = await run("list_saved_tab_groups", { source: "chrome_native", closedOnly: true });
  assert.equal(closedOnly.code, "OPEN_IN_CHROME_REQUIRED");
  assert.equal(closedOnly.ok, false);

  // A panel showing a stale row must never reopen a group behind the user's back.
  let panelWindowId = 1;
  const manualTools = createSavedTabGroupTools({ getWindowId: () => panelWindowId, allowNativeOpen: false }, {
    api: mockChrome, storage,
    nativeCall: (req) => {
      assert.equal(req.action, "list", "manual management only reads saved groups from the host");
      return nativeCall(req);
    },
  });
  const manual = async (name, args) => JSON.parse(await manualTools.find(t => t.name === name).execute(args));
  for (const [name, args] of [
    ["open_saved_tab_group", {}],
    ["open_saved_tab_group", { mode: "recreate" }],
    ["update_saved_tab_group", { title: "changed" }],
    ["delete_saved_tab_group", {}],
  ]) {
    assert.equal((await manual(name, { guid: "ng-closed", ...args })).code, "OPEN_IN_CHROME_REQUIRED");
  }
  const manualBatch = await manual("delete_saved_tab_group", { guids: ["ng-closed", "ng-closed-2"] });
  assert.deepEqual(manualBatch.results.map(r => r.code), ["OPEN_IN_CHROME_REQUIRED", "OPEN_IN_CHROME_REQUIRED"]);
  assert.equal(nextTabId, 50, "no marker tab or duplicate group is created");
  panelWindowId = 2;
  assert.equal((await manual("delete_saved_tab_group", { guid: "ng-open" })).code, "WINDOW_SCOPE");
  panelWindowId = 1;

  // Two identical groups are open in different windows. Only the specifically
  // selected saved GUID, its live group ID, and its confirmed window may match.
  const remote = { ...structuredClone(nativeStore[0]), guid: "ng-other-window", sessionWindowId: 2, sessionTabIds: [7] };
  nativeStore.push(remote);
  openGroups.set(14, { ...openGroups.get(10), id: 14, windowId: 2 });
  openTabs.set(7, { ...openTabs.get(1), id: 7, groupId: 14, windowId: 2 });
  nativeGuidByOpenId.set(14, remote.guid);
  const binding = { profile: "Default", guid: remote.guid, id: 14, windowId: 2 };
  const deleteBound = async (expectedOpenGroup, guid = remote.guid, listNative = nativeCall) => {
    const panelTools = createSavedTabGroupTools({ getWindowId: () => 1, expectedOpenGroup }, {
      api: mockChrome, storage, nativeCall: (req) => {
        assert.equal(req.action, "list", "a bound selection must never relaunch Chrome via the Helper");
        return listNative(req);
      },
    });
    return JSON.parse(await panelTools.find((t) => t.name === "delete_saved_tab_group").execute({ guid }));
  };
  assert.equal((await run("delete_saved_tab_group", { guid: remote.guid })).code, "WINDOW_SCOPE");
  for (const stale of [{ profile: "Profile 2" }, { guid: "ng-open" }, { id: 10 }]) {
    assert.equal((await deleteBound({ ...binding, ...stale })).code, "OPEN_GROUP_CHANGED");
  }
  assert.equal((await deleteBound({ ...binding, guid: "ng-closed" }, "ng-closed")).code, "OPEN_GROUP_CHANGED");
  await mockChrome.tabGroups.move(14, { windowId: 3 });
  remote.sessionWindowId = 3;
  let movedReads = 0;
  const movedAt = Date.now();
  const moved = await deleteBound(binding, remote.guid, async (req) => {
    movedReads += 1;
    return nativeCall(req);
  });
  assert.equal(moved.code, "OPEN_GROUP_CHANGED");
  assert.equal(movedReads, 2, "a window mismatch must not poll the session file");
  assert.ok(Date.now() - movedAt < 1000, `window mismatch waited ${Date.now() - movedAt}ms`);
  assert.equal(tabOpLog.length, 0, "no stale selection caused a write");
  const deletedRemote = await deleteBound({ ...binding, windowId: 3 });
  assert.deepEqual(deletedRemote.closedTabIds, [7]);
  assert.equal(deletedRemote.verifiedRemoved, true);
  assert.ok(openGroups.has(10) && openTabs.has(1) && nativeStore.some((g) => g.guid === "ng-open"));

  // A unique title/color/URL signature can be used when there is no session
  // mapping, but must never overrule contrary window or tab IDs for this GUID.
  const unique = { guid: "ng-unique-window", title: "Unique", color: "pink", tabCount: 1, tabs: [{ url: "https://unique.example/" }] };
  nativeStore.push(unique);
  openGroups.set(16, { id: 16, windowId: 3, title: unique.title, color: unique.color });
  openTabs.set(8, { id: 8, windowId: 3, groupId: 16, url: unique.tabs[0].url });
  nativeGuidByOpenId.set(16, unique.guid);
  const uniqueBinding = { profile: "Default", guid: unique.guid, id: 16, windowId: 3 };
  unique.sessionWindowId = 99;
  assert.equal((await deleteBound(uniqueBinding, unique.guid)).code, "OPEN_GROUP_CHANGED");
  delete unique.sessionWindowId;
  unique.sessionTabIds = [88];
  assert.equal((await deleteBound(uniqueBinding, unique.guid)).code, "OPEN_GROUP_CHANGED");
  delete unique.sessionTabIds;
  let reads = 0;
  const changedBeforeUngroup = await deleteBound(uniqueBinding, unique.guid, async (req) => {
    const snapshot = await nativeCall(req);
    if (++reads === 3) snapshot.groups.find((g) => g.guid === unique.guid).sessionTabIds = [88];
    return snapshot;
  });
  assert.equal(changedBeforeUngroup.code, "GROUP_CHANGED", "the final pre-delete read also rejects conflicting session evidence");
  assert.ok(openTabs.has(8) && openGroups.has(16));
  let agreementPhase = 0;
  const agreed = await deleteBound(uniqueBinding, unique.guid, async (req) => {
    const snapshot = await nativeCall(req);
    const row = snapshot.groups.find((g) => g.guid === unique.guid);
    if (!row) return snapshot;
    agreementPhase += 1;
    if (agreementPhase <= 2) {
      row.sessionWindowId = 99;
      row.sessionTabIds = [88];
    } else if (agreementPhase === 3) {
      delete row.sessionWindowId;
      delete row.sessionTabIds;
    } else {
      row.sessionWindowId = 3;
      row.sessionTabIds = [8];
    }
    return snapshot;
  });
  assert.equal(agreed.verifiedRemoved, true);
  assert.ok(agreementPhase > 3, "an empty session list is not agreement; a later live binding is");
  assert.equal((await manual("update_saved_tab_group", { guid: "ng-open", title: "Renamed in Chrome" })).verifiedUpdated, true);

  // Save open group into PageLens store with closeAfterSave: true
  const stashed = await run("save_tab_group", { groupId: 10, title: "已收纳", closeAfterSave: true });
  assert.equal(stashed.ok, true);
  assert.equal(stashed.closedAfterSave, true);
  assert.equal(stashed.closedCount, 1);
  assert.equal(openGroups.has(10), false);

  // Open from PageLens store -> recreates real Chrome group
  const restored = await run("open_saved_tab_group", { id: stashed.group.id, collapsed: true });
  assert.equal(restored.ok, true);
  assert.equal(restored.source, "pagelens");
  assert.equal(restored.group.title, "已收纳");
  assert.equal(restored.group.collapsed, true);

  // Closed native groups are not opened, copied, or deleted.
  const tabsBeforeClosed = nextTabId;
  const axBefore = axCalls.length;
  const recreated = await run("open_saved_tab_group", { guid: "ng-closed", mode: "recreate" });
  assert.equal(recreated.code, "OPEN_IN_CHROME_REQUIRED");
  assert.equal(nextTabId, tabsBeforeClosed);
  assert.equal(axCalls.length, axBefore);

  const updatedNative = await run("update_saved_tab_group", {
    guid: "ng-closed-2",
    title: "TikTok MX 已改名",
    color: "pink",
    addUrls: ["https://shop.example/extra"],
  });
  assert.equal(updatedNative.code, "OPEN_IN_CHROME_REQUIRED");
  assert.equal(nativeStore.find((g) => g.guid === "ng-closed-2").title, "TikTok MX 888888");

  nativeStore.push({ guid: "ng-del-1", title: "待删原生组", color: "red", tabCount: 1, tabs: [{ guid: "td1", title: "T", url: "https://t.example/" }], source: "chrome_native" });
  const deletedClosed = await run("delete_saved_tab_group", { guid: "ng-del-1" });
  assert.equal(deletedClosed.code, "OPEN_IN_CHROME_REQUIRED");
  assert.ok(nativeStore.some((g) => g.guid === "ng-del-1"));

  const elsewhere = { guid: "ng-elsewhere", title: "别处打开", color: "cyan", tabCount: 1, tabs: [{ url: "https://elsewhere.example/" }] };
  nativeStore.push(elsewhere);
  const elsewhereId = nextGroupId++;
  const elsewhereTab = nextTabId++;
  openGroups.set(elsewhereId, { id: elsewhereId, windowId: 8, title: elsewhere.title, color: elsewhere.color, collapsed: false });
  openTabs.set(elsewhereTab, { id: elsewhereTab, windowId: 8, groupId: elsewhereId, url: elsewhere.tabs[0].url, title: "别处" });
  nativeGuidByOpenId.set(elsewhereId, elsewhere.guid);
  const elsewhereTools = createSavedTabGroupTools({ getWindowId: () => 1, detectOpenedInOtherWindow: true }, { api: mockChrome, storage, nativeCall });
  const elsewhereDelete = JSON.parse(await elsewhereTools.find((t) => t.name === "delete_saved_tab_group").execute({ guid: elsewhere.guid }));
  assert.equal(elsewhereDelete.code, "OPENED_IN_OTHER_WINDOW");
  assert.ok(openTabs.has(elsewhereTab));

  const boundTools = createSavedTabGroupTools({
    getWindowId: () => 1,
    expectedOpenGroup: { profile: "Default", guid: elsewhere.guid, id: elsewhereId, windowId: 8 },
  }, { api: mockChrome, storage, nativeCall });
  const deletedOpen = JSON.parse(await boundTools.find((t) => t.name === "delete_saved_tab_group").execute({ guid: elsewhere.guid }));
  assert.equal(deletedOpen.ok, true);
  assert.equal(deletedOpen.via, "ungroup_and_close_open_tabs");
  assert.equal(deletedOpen.verifiedRemoved, true);
  assert.deepEqual(deletedOpen.closedTabIds, [elsewhereTab]);

  nativeStore.push({ guid: "ng-del-2", title: "回退删组", color: "red", tabCount: 1, tabs: [{ guid: "td2", title: "T2", url: "https://t2.example/" }], source: "chrome_native" });
  openGroups.set(99, { id: 99, windowId: 1, title: "回退删组", color: "red" });
  openTabs.set(99, { id: 99, windowId: 1, groupId: 99, url: "https://unrelated.example/" });
  const deletedFallback = await run("delete_saved_tab_group", { guid: "ng-del-2" });
  assert.equal(deletedFallback.code, "OPEN_IN_CHROME_REQUIRED");
  assert.ok(nativeStore.some((g) => g.guid === "ng-del-2"));
  assert.ok(openGroups.has(99) && openTabs.has(99));

  const keep = { guid: "ng-keep-open", title: "保持打开", color: "purple", tabCount: 1, tabs: [{ url: "https://keep.example/" }] };
  nativeStore.push(keep);
  const keepGid = nextGroupId++;
  const keepTid = nextTabId++;
  openGroups.set(keepGid, { id: keepGid, windowId: 1, title: keep.title, color: keep.color });
  openTabs.set(keepTid, { id: keepTid, windowId: 1, groupId: keepGid, url: keep.tabs[0].url });
  nativeGuidByOpenId.set(keepGid, keep.guid);
  const savedUngroup = mockChrome.tabs.ungroup;
  mockChrome.tabs.ungroup = async () => { throw new Error("tabs are being dragged"); };
  const failure = await run("delete_saved_tab_group", { guid: keep.guid });
  assert.equal(failure.code, "UNGROUP_FAILED");
  assert.ok(nativeStore.some((g) => g.guid === keep.guid));
  assert.ok(openTabs.has(keepTid));
  mockChrome.tabs.ungroup = savedUngroup;

  for (const mode of ["unreadable", "sticky"]) {
    axMode = mode;
    const row = { guid: mode, title: mode, color: "green", tabs: [{ url: `https://test.example/${mode}` }], tabCount: 1 };
    nativeStore.push(row);
    const gid = nextGroupId++;
    const tid = nextTabId++;
    openGroups.set(gid, { id: gid, windowId: 1, title: row.title, color: row.color });
    openTabs.set(tid, { id: tid, windowId: 1, groupId: gid, url: row.tabs[0].url });
    nativeGuidByOpenId.set(gid, row.guid);
    const unverified = await run("delete_saved_tab_group", { guid: mode });
    assert.equal(unverified.ok, false);
    assert.equal(unverified.code, mode === "unreadable" ? "DELETE_UNVERIFIED" : "NOT_REMOVED_AFTER_UI_ACTION");
    verificationReadFailure = false;
    axMode = "ok";
  }

  const limited = await run("list_saved_tab_groups", { source: "chrome_native", limit: 1, includeTabs: false });
  assert.equal(limited.chromeNative.groups[0].tabs, undefined);
  assert.ok(limited.chromeNative.count >= 1);
  const deniedProbe = await run("list_saved_tab_groups", { checkAccessibility: true });
  assert.equal(deniedProbe.code, "OPEN_IN_CHROME_REQUIRED");

  const beforeBadBatch = nativeStore.length;
  const badBatch = await run("delete_saved_tab_group", { source: "chrome_native", ids: ["stg_abc"] });
  assert.equal(badBatch.code, "INVALID_SELECTOR");
  assert.equal(nativeStore.length, beforeBadBatch);

  const closedOnlyBatch = await run("delete_saved_tab_group", { source: "chrome_native", query: "TikTok", closedOnly: true });
  assert.equal(closedOnlyBatch.code, "OPEN_IN_CHROME_REQUIRED");

  const batchOpen = { guid: "ng-batch-open", title: "Batch Open", color: "blue", tabCount: 1, tabs: [{ url: "https://batch-open.example/" }] };
  nativeStore.push(
    batchOpen,
    { guid: "ng-batch-closed", title: "Batch Closed", color: "grey", tabCount: 1, tabs: [{ url: "https://batch-closed.example/" }] },
  );
  const batchGid = nextGroupId++;
  const batchTid = nextTabId++;
  openGroups.set(batchGid, { id: batchGid, windowId: 1, title: batchOpen.title, color: batchOpen.color });
  openTabs.set(batchTid, { id: batchTid, windowId: 1, groupId: batchGid, url: batchOpen.tabs[0].url });
  nativeGuidByOpenId.set(batchGid, batchOpen.guid);
  const batchRes = await run("delete_saved_tab_group", { guids: ["ng-batch-open", "ng-batch-closed"] });
  assert.equal(batchRes.batch, true);
  assert.equal(batchRes.deletedCount, 1);
  assert.equal(batchRes.failedCount, 1);
  assert.equal(batchRes.results.find((r) => r.guid === "ng-batch-closed").code, "OPEN_IN_CHROME_REQUIRED");
  assert.ok(!nativeStore.some((g) => g.guid === "ng-batch-open"));
  assert.ok(nativeStore.some((g) => g.guid === "ng-batch-closed"));

  mockChrome.runtime = {
    id: "a".repeat(32),
    sendNativeMessage: async (_name, msg) => ({ ...await nativeCall(msg), profileMarker: msg.profileMarker }),
  };
  const chatTools = createAgentTools({ getWindowId: () => 1, getTabId: () => 1, settings: {} });
  const chat = async (name, args) => JSON.parse(await chatTools.find(t => t.name === name).execute(args));
  assert.equal((await chat("delete_saved_tab_group", { guid: "ng-closed" })).code, "OPEN_IN_CHROME_REQUIRED");
  assert.equal((await chat("open_saved_tab_group", { guid: "ng-closed" })).code, "OPEN_IN_CHROME_REQUIRED");
  assert.equal((await chat("update_saved_tab_group", { guid: "ng-closed", title: "Test" })).code, "OPEN_IN_CHROME_REQUIRED");
  assert.equal((await chat("open_saved_tab_group", { guid: "ng-closed", mode: "recreate" })).code, "OPEN_IN_CHROME_REQUIRED");
  assert.equal(axCalls.length, axBefore);

  const deleteClosed = (target) => deleteSingleNativeSavedGroup({
    chromeApi: mockChrome, callNative: nativeCall, target: structuredClone(target), profile: "Default",
    ctx: { getWindowId: () => 1 },
  });
  const closedRow = nativeStore.find((group) => group.guid === "ng-closed");
  const beforeUngroup = tabOpLog.filter(({ op }) => op === "ungroup").length;
  const refused = await deleteClosed(closedRow);
  assert.equal(refused.code, "OPEN_IN_CHROME_REQUIRED");
  assert.match(refused.error, /请先在 Chrome 中打开该组/);
  assert.ok(nativeStore.includes(closedRow));
  assert.equal(tabOpLog.filter(({ op }) => op === "ungroup").length, beforeUngroup);
  assert.ok(![...openTabs.values()].some((tab) => String(tab.title || "").startsWith("PageLens-")));
  assert.equal(axCalls.filter((call) => call.action === "open").length, 0);
  assert.ok(openTabs.has(keepTid), "unrelated open groups are untouched");
}

// =========================================================================
// 4. Router, Trust, Irreversible & Bridge Security Tests
// =========================================================================
{
  const all = createAgentTools({ getWindowId: () => 1, getTabId: () => 1, settings: {} });
  const names = all.map((t) => t.name);
  for (const name of ["list_saved_tab_groups", "save_tab_group", "open_saved_tab_group", "update_saved_tab_group", "delete_saved_tab_group"]) {
    assert.ok(names.includes(name), `createAgentTools exposes ${name}`);
  }
  const active = resolveActiveTools({ userText: "查看我收纳的已保存标签组", tools: all }).map((t) => t.name);
  assert.ok(active.includes("list_saved_tab_groups") && active.includes("delete_saved_tab_group"));

  assert.ok(READ_ONLY_TOOLS.has("list_saved_tab_groups"));
  assert.ok(PAGE_CONTENT_TOOLS.has("list_saved_tab_groups"));
  assert.equal(sourceLabel("list_saved_tab_groups"), "tabs");
  assert.equal(isToolPrivileged("delete_saved_tab_group"), true);
  assert.equal(isToolPrivileged("save_tab_group", { closeAfterSave: true }), true);
  assert.equal(isToolPrivileged("save_tab_group", { closeAfterSave: false }), false);
  assert.equal(toolCategory("save_tab_group", { closeAfterSave: true }), "close");
  assert.equal(matchIrreversible("delete_saved_tab_group")?.id, "delete");
  assert.equal(matchIrreversible("save_tab_group", { closeAfterSave: true })?.id, "delete");
  assert.equal(matchIrreversible("save_tab_group", { closeAfterSave: false }), null);
  assert.equal(
    decideToolCall({ toolName: "delete_saved_tab_group", args: { guid: "x" }, hitlMode: "autonomous" }).needsConfirmation,
    true,
  );
  const cap = extractCapsule("打开已保存的标签组");
  assert.ok(capsuleCovers(cap, { toolName: "open_saved_tab_group", args: { id: "stg_1" } }).covered);

  // Bridge origin isolation + irreversible approval queue
  const mem = {};
  const savedGroupsStorage = {
    get: async (k) => ({ [k]: structuredClone(mem[k]) }),
    set: async (obj) => Object.assign(mem, structuredClone(obj)),
  };
  await saveTabGroupRecord({ id: "stg_ok", title: "Local Saved", color: "blue", tabs: ["http://localhost:8080/a"] }, { storage: savedGroupsStorage });
  await saveTabGroupRecord({ id: "stg_priv", title: "Bank Saved", color: "red", tabs: ["https://bank.example/vault"] }, { storage: savedGroupsStorage });

  const nativeMockGroups = [
    { guid: "nat_ok", title: "Native Local", color: "green", tabCount: 1, tabs: [{ guid: "n1", title: "L", url: "http://localhost:8080/n" }] },
    { guid: "nat_priv", title: "Native Bank", color: "red", tabCount: 1, tabs: [{ guid: "n2", title: "B", url: "https://bank.example/n" }] },
  ];

  const op = await createTokenRecord({ name: "op", scopes: SCOPE_PRESETS.operate, origins: ["http://localhost:*"] });
  const approvals = createApprovalQueue();
  const TABS = new Map();
  const GROUPS = new Map();
  let nextId = 1;
  let persistDeletion = true;
  let persistEdit = true;
  const mockApi = {
    tabs: {
      ungroup: async (ids) => {
        for (const id of ids) {
          const tab = TABS.get(id);
          const group = GROUPS.get(tab.groupId);
          const nativeIndex = nativeMockGroups.findIndex((g) => g.title === group.title);
          if (persistDeletion && nativeIndex >= 0) nativeMockGroups.splice(nativeIndex, 1);
          GROUPS.delete(tab.groupId);
          tab.groupId = -1;
        }
      },
      group: async ({ tabIds }) => {
        const gid = nextId++;
        GROUPS.set(gid, { id: gid, windowId: 1, title: "", color: "grey", collapsed: false });
        for (const id of tabIds) TABS.get(id).groupId = gid;
        return gid;
      },
    },
    tabGroups: {
      query: async () => [...GROUPS.values()],
      get: async (id) => GROUPS.get(id),
      update: async (id, p) => {
        const group = GROUPS.get(id);
        const saved = nativeMockGroups.find((g) => g.title === group.title);
        if (persistEdit && saved) Object.assign(saved, p);
        return Object.assign(group, p);
      },
    },
  };

  const env = {
    getSettings: async () => normalizeSettings({ agentBridgeEnabled: true, agentBridgeOrigins: ["http://localhost:*"] }),
    getAgentTokens: async () => [op.record],
    approvals,
    savedGroupsStorage,
    nativeSavedTabGroups: async (req) => {
      if (req.action === "list") return { ok: true, supportsBoundOpen: true, profile: "Default", profiles: ["Default"], count: nativeMockGroups.length, groups: structuredClone(nativeMockGroups) };
      if (req.action === "delete") return { ok: true, via: "bookmarks_bar_context_menu" };
      return { ok: true, via: "everything_menu" };
    },
    tabs: {
      get: async (id) => TABS.get(id),
      query: async () => [...TABS.values()],
      create: async (p) => {
        const id = nextId++;
        const t = { id, windowId: 1, url: p.url, title: p.url, groupId: -1 };
        TABS.set(id, t);
        return t;
      },
      update: async (id, p) => ({ id, ...p }),
      reload: async () => {},
      goBack: async () => {},
      goForward: async () => {},
      remove: async (ids) => { for (const id of [ids].flat()) TABS.delete(id); },
    },
    windows: { getAll: async () => [], get: async () => ({ id: 1, tabs: [] }), create: async () => ({ id: 1, tabs: [] }), update: async () => {}, remove: async () => {} },
    tabGroups: chromeTabGroups(mockApi),
    inject: async () => null,
    injectFrames: async () => [],
    runJs: async () => ({ ok: true }),
    cdp: { send: async () => ({}) },
    clipboard: { write: async () => ({}) },
    platform: () => "mac",
    sleep: async () => {},
    now: () => Date.now(),
    extensionVersion: () => "test",
  };
  const bridge = createBridge(env);
  let seq = 0;
  const call = (tool, args = {}, session) => bridge.call({ id: `s${++seq}`, tool, args }, session ? { session } : {});
  const asOp = { token: op.token, sessionId: "s-op", agentName: "op" };

  // Bridge list_saved_tab_groups hides both private native and private pagelens groups
  const listed = await call("list_saved_tab_groups", {}, asOp);
  assert.equal(listed.ok, true);
  const natOk = listed.result.chromeNative.groups.find((g) => g.guid === "nat_ok");
  assert.equal(natOk.isOpen, false, "a closed native group is listed read-only");
  assert.equal(natOk.openGroupId, undefined);
  assert.equal(listed.result.chromeNative.groups.find((g) => g.guid === "nat_priv"), undefined);
  assert.deepEqual(listed.result.pagelens.groups.map((g) => g.id), ["stg_ok"]);
  assert.ok(!JSON.stringify(listed.result).includes("bank.example"));

  const queryOpenGroups = env.tabGroups.query;
  env.tabGroups.query = async () => { throw new Error("Disconnected"); };
  const unknownOpen = await call("list_saved_tab_groups", { source: "chrome_native" }, asOp);
  assert.equal(unknownOpen.result.chromeNative.ok, true);
  assert.equal(unknownOpen.result.chromeNative.openState, "unknown");
  assert.match(unknownOpen.result.chromeNative.warning, /无法核对/);
  const unknownNat = unknownOpen.result.chromeNative.groups.find((g) => g.guid === "nat_ok");
  assert.equal(unknownNat.isOpen, false);
  assert.equal(unknownNat.openGroupId, undefined);
  assert.ok(!JSON.stringify(unknownOpen.result).includes("bank.example"));
  assert.equal((await call("list_saved_tab_groups", { source: "chrome_native", closedOnly: true }, asOp)).error.code, ERROR_CODES.BAD_ARGS);
  env.tabGroups.query = queryOpenGroups;

  // Cannot open or update private saved groups
  assert.equal((await call("open_saved_tab_group", { id: "stg_priv" }, asOp)).error.code, ERROR_CODES.ORIGIN_NOT_ALLOWED);
  assert.equal((await call("open_saved_tab_group", { guid: "nat_priv", mode: "recreate" }, asOp)).error.code, ERROR_CODES.ORIGIN_NOT_ALLOWED);
  assert.equal((await call("update_saved_tab_group", { id: "stg_ok", addUrls: ["https://bank.example/x"] }, asOp)).error.code, ERROR_CODES.ORIGIN_NOT_ALLOWED);

  const staleId = await call("update_saved_tab_group", { id: "stale", matchTitle: "Local Saved", title: "Changed" }, asOp);
  assert.equal(staleId.error.code, ERROR_CODES.TAB_NOT_FOUND);
  nativeMockGroups.push({ ...nativeMockGroups[0], guid: "same-title", title: "Local Saved" });
  const ambiguous = await call("update_saved_tab_group", { matchTitle: "Local Saved", title: "Changed" }, asOp);
  assert.equal(ambiguous.error.code, ERROR_CODES.BAD_ARGS);
  nativeMockGroups.pop();
  assert.equal((await call("save_tab_group", { id: "stg_priv", title: "Changed", tabs: ["http://localhost:8080/"] }, asOp)).error.code, ERROR_CODES.ORIGIN_NOT_ALLOWED);

  const privateHomonym = { ...nativeMockGroups[1], title: nativeMockGroups[0].title, guid: "private-homonym" };
  nativeMockGroups.push(privateHomonym);
  const unsafeOpen = await call("open_saved_tab_group", { guid: "nat_ok" }, asOp);
  assert.equal(unsafeOpen.error.code, ERROR_CODES.TOOL_FAILED, "a closed native group is not opened");
  assert.equal(unsafeOpen.error.details?.code, "OPEN_IN_CHROME_REQUIRED");
  assert.equal(TABS.size, 0);
  nativeMockGroups.pop();

  // delete_saved_tab_group triggers CONFIRMATION_REQUIRED for token without skipIrreversible
  const pending = await call("delete_saved_tab_group", { id: "stg_ok" }, asOp);
  assert.equal(pending.error.code, ERROR_CODES.CONFIRMATION_REQUIRED);
  await approvals.resolve(pending.error.details.pendingId, true);
  const confirmed = await call("delete_saved_tab_group", { id: "stg_ok" }, asOp);
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.result.deleted.id, "stg_ok");

  const live = { id: 990, windowId: 1, title: "Native Local", color: "green" };
  const liveTab = { id: 991, groupId: live.id, windowId: 1, url: "http://localhost:8080/n" };
  GROUPS.set(live.id, live);
  TABS.set(liveTab.id, liveTab);
  const asOther = { ...asOp, sessionId: "s-other" };
  assert.equal((await call("tab_claim", { tabId: liveTab.id }, asOther)).ok, true);
  assert.equal((await call("update_saved_tab_group", { guid: "nat_ok", title: "Renamed" }, asOp)).error.code, ERROR_CODES.TAB_LEASED);
  const deleteArgs = { guid: "nat_ok", profile: "Default" };
  async function approvedNativeDelete() {
    const pending = await call("delete_saved_tab_group", deleteArgs, asOp);
    assert.equal(pending.error.code, ERROR_CODES.CONFIRMATION_REQUIRED);
    await approvals.resolve(pending.error.details.pendingId, true);
    return call("delete_saved_tab_group", deleteArgs, asOp);
  }
  assert.equal((await approvedNativeDelete()).error.code, ERROR_CODES.TAB_LEASED);
  assert.equal(TABS.has(liveTab.id), true);
  assert.equal((await call("tab_release", { tabId: liveTab.id }, asOther)).ok, true);
  const changed = await call("update_saved_tab_group", { guid: "nat_ok", title: "After Rename" }, asOp);
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.equal(nativeMockGroups.find((g) => g.guid === "nat_ok").title, "After Rename");
  persistEdit = false;
  const staleEdit = await call("update_saved_tab_group", { guid: "nat_ok", color: "cyan" }, asOp);
  assert.equal(staleEdit.error.code, ERROR_CODES.VERIFY_FAILED);
  live.color = "green";
  persistDeletion = false;
  const unverified = await approvedNativeDelete();
  assert.equal(unverified.ok, false, "removing live tabs alone cannot confirm deletion of the saved GUID");
  persistDeletion = true;
  GROUPS.set(live.id, live);
  TABS.set(liveTab.id, { ...liveTab, groupId: live.id });
  const deleted = await approvedNativeDelete();
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  assert.equal(deleted.result.guid, "nat_ok");
  assert.equal(deleted.result.verifiedRemoved, true);
  assert.ok(nativeMockGroups.some((g) => g.guid === "nat_priv"));

}

console.log("PASS test_saved_tab_groups.mjs");

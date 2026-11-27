import {
  NATIVE_HOST_NAME,
  describeNativeError,
  execNativeShell,
  formatExecResult,
  installHint,
  nativeFs,
  nativeSavedTabGroups,
  nativeSend,
  pingNativeHost,
} from "../lib/native-host.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(NATIVE_HOST_NAME === "com.pagelens.host", "host name");
assert(installHint("abcdefghijklmnopqrstuvwxyzabcdef").includes("--extension-id"), "install hint id");
assert(/未安装 Native Host/.test(describeNativeError(new Error("Specified native messaging host not found."))), "missing");
assert(/forbidden|对不上|未安装/.test(describeNativeError(new Error("Access to the specified native messaging host is forbidden."))), "forbidden");

const formatted = formatExecResult({
  ok: true,
  code: 0,
  stdout: "hello\n",
  stderr: "warn\n",
  timedOut: false,
  ms: 12,
  cwd: "/tmp",
});
assert(/exit 0/.test(formatted) && /hello/.test(formatted) && /warn/.test(formatted), "format ok");
assert(/本机命令失败|boom/.test(formatExecResult({ ok: false, error: "boom" })), "format err");
assert(/无输出/.test(formatExecResult({ ok: true, code: 0, stdout: "", stderr: "" })), "format empty");

globalThis.chrome = {
  runtime: {
    id: "abcdefghijklmnopqrstuvwxyzabcdef",
    sendNativeMessage: async (name, msg) => {
      assert(name === NATIVE_HOST_NAME, "name");
      if (msg.op === "ping") return { ok: true, op: "ping", version: "1.1.0" };
      if (msg.op === "fs" && msg.action === "stat") return { ok: true, kind: "directory", path: "/tmp/notes", name: "notes" };
      return { ok: false, error: "nope" };
    },
  },
};

const ping = await pingNativeHost();
assert(ping.ok && ping.version === "1.1.0" && ping.ms >= 0, "ping");
const stat = await nativeFs({ action: "stat", path: "/tmp/notes" });
assert(stat.ok && stat.kind === "directory", "native fs");

const bad = await nativeSend({ op: "exec" });
assert(bad.ok === false, "exec mocked fail");

const local = {};
chrome.storage = { local: {
  get: async (key) => ({ [key]: local[key] }),
  set: async (items) => Object.assign(local, items),
} };
const reads = [];
chrome.runtime.sendNativeMessage = async (_, msg) => {
  reads.push(msg);
  return { ok: true, groups: [], profileMarker: msg.profileMarker };
};
assert((await nativeSavedTabGroups()).ok, "bound native saved group list");
assert((await nativeSavedTabGroups({ profileMarker: "wrong" })).ok, "caller cannot override profile marker");
assert(reads[0].profileMarker === reads[1].profileMarker && reads[0].profileMarker.length === 36, "stable local marker");
let lookupAttempts = 0;
chrome.runtime.sendNativeMessage = async (_, msg) => ++lookupAttempts === 1
  ? { ok: false, code: "PROFILE_MARKER_MISMATCH" }
  : { ok: true, groups: [], profileMarker: msg.profileMarker };
assert((await nativeSavedTabGroups()).ok && lookupAttempts === 2, "first read waits for local storage flush");
lookupAttempts = 0;
assert(!(await nativeSavedTabGroups({ action: "open" })).ok && lookupAttempts === 1, "never retry native actions");
chrome.runtime.sendNativeMessage = async () => ({ ok: true, groups: [] });
assert((await nativeSavedTabGroups()).code === "HOST_UPDATE_REQUIRED", "reject unbound list from old host");
chrome.extension = { inIncognitoContext: true };
assert(!(await nativeSavedTabGroups()).ok, "incognito cannot read persistent groups");
delete chrome.extension;

const originalTimer = globalThis.setTimeout;
const deadlines = [];
try {
  globalThis.setTimeout = (fn, ms) => {
    deadlines.push(ms);
    return originalTimer(fn, ms);
  };
  chrome.runtime.sendNativeMessage = async (_, msg) => ({ ok: true, commandMs: msg.timeoutMs });
  for (const [requested, expected] of [[undefined, 60000], [180000, 180000], [400000, 300000]]) {
    const result = await execNativeShell({ command: "true", timeoutMs: requested });
    assert(result.commandMs === expected && deadlines.at(-1) > expected, "wait for the host exit status");
  }
} finally {
  globalThis.setTimeout = originalTimer;
}

chrome.runtime.sendNativeMessage = async () => {
  throw new Error("Specified native messaging host not found.");
};
const miss = await pingNativeHost();
assert(miss.ok === false && /未安装/.test(miss.error), "ping missing");

console.log("PASS native-host client");

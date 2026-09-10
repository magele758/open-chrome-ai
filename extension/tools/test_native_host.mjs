import {
  NATIVE_HOST_NAME,
  describeNativeError,
  formatExecResult,
  installHint,
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
      if (msg.op === "ping") return { ok: true, op: "ping", version: "1.0.0" };
      return { ok: false, error: "nope" };
    },
  },
};

const ping = await pingNativeHost();
assert(ping.ok && ping.version === "1.0.0" && ping.ms >= 0, "ping");

const bad = await nativeSend({ op: "exec" });
assert(bad.ok === false, "exec mocked fail");

chrome.runtime.sendNativeMessage = async () => {
  throw new Error("Specified native messaging host not found.");
};
const miss = await pingNativeHost();
assert(miss.ok === false && /未安装/.test(miss.error), "ping missing");

console.log("PASS native-host client");

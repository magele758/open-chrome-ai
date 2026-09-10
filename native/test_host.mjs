import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TIMEOUT_MS,
  HOST_NAME,
  encodeMessage,
  execCommand,
  handleRequest,
  tryReadMessage,
} from "./pagelens-host.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const ping = await handleRequest({ op: "ping" });
assert(ping.ok && ping.name === HOST_NAME && ping.version, "ping");

const unknown = await handleRequest({ op: "nope" });
assert(unknown.ok === false && /未知/.test(unknown.error), "unknown op");

const empty = await execCommand({ command: "  " });
assert(empty.ok === false && /不能为空/.test(empty.error), "empty command");

const rel = await execCommand({ command: "echo x", cwd: "tmp" });
assert(rel.ok === false && /绝对路径/.test(rel.error), "cwd relative");

const echo = await execCommand({ command: "echo pagelens-host-ok", cwd: os.tmpdir() });
assert(echo.ok && echo.code === 0 && /pagelens-host-ok/.test(echo.stdout), "echo: " + echo.stdout);
assert(echo.cwd === path.resolve(os.tmpdir()), "cwd resolved");

const fail = await execCommand({ command: "exit 7" });
assert(fail.ok && fail.code === 7, "exit code");

const timed = await execCommand({ command: "sleep 5", timeoutMs: 200 });
assert(timed.ok && timed.timedOut && timed.code === 124, "timeout");
assert(timed.ms < 4000, "timeout should not wait full sleep: " + timed.ms);

const framed = encodeMessage({ op: "ping" });
const decoded = tryReadMessage(framed);
assert(decoded.msg.op === "ping" && decoded.rest.length === 0, "frame");
assert(tryReadMessage(framed.subarray(0, 3)) === null, "partial header");
assert(DEFAULT_TIMEOUT_MS === 60_000, "default timeout");

const hostPath = fileURLToPath(new URL("./pagelens-host.mjs", import.meta.url));
const child = spawn(process.execPath, [hostPath], { stdio: ["pipe", "pipe", "pipe"] });
const reply = await new Promise((resolve, reject) => {
  let buf = Buffer.alloc(0);
  const timer = setTimeout(() => reject(new Error("stdio ping timeout")), 4000);
  child.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    try {
      const parsed = tryReadMessage(buf);
      if (parsed) {
        clearTimeout(timer);
        resolve(parsed.msg);
        child.kill();
      }
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
  child.on("error", reject);
  child.stdin.write(encodeMessage({ op: "ping" }));
  child.stdin.end();
});
assert(reply.ok && reply.op === "ping", "stdio ping");

console.log("PASS native-host");

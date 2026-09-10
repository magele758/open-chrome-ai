import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TIMEOUT_MS,
  HOST_NAME,
  encodeMessage,
  execCommand,
  handleFs,
  handleRequest,
  safeJoinRoot,
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pagelens-fs-"));
try {
  const rel = await handleRequest({ op: "fs", action: "stat", path: "relative" });
  assert(rel.ok === false && /绝对路径/.test(rel.error), "fs relative");

  const missing = await handleRequest({ op: "fs", action: "stat", path: path.join(tmp, "nope") });
  assert(missing.ok === false && /不存在/.test(missing.error), "fs missing");

  const st = await handleRequest({ op: "fs", action: "stat", path: tmp });
  assert(st.ok && st.kind === "directory" && st.path === path.resolve(tmp), "fs stat dir");

  const wrote = await handleFs({ action: "writeText", root: tmp, rel: "yt-x/meta.json", text: '{"ok":1}\n' });
  assert(wrote.ok && wrote.path === "yt-x/meta.json", "fs write");
  const read = await handleFs({ action: "readText", root: tmp, rel: "yt-x/meta.json" });
  assert(read.ok && read.text.includes('"ok":1'), "fs read");

  const listed = await handleFs({ action: "readdir", root: tmp, rel: "" });
  assert(listed.ok && listed.entries.some((e) => e.name === "yt-x" && e.kind === "directory"), "fs readdir");

  const escape = handleFs({ action: "writeText", root: tmp, rel: "../secret.md", text: "x" });
  assert(escape.ok === false && /不合法|超出/.test(escape.error), "fs escape " + escape.error);

  const badExt = handleFs({ action: "writeText", root: tmp, rel: "x.bin", text: "x" });
  assert(badExt.ok === false && /只能写入/.test(badExt.error), "fs ext");

  fs.mkdirSync(path.join(tmp, "find-skills"));
  fs.writeFileSync(path.join(tmp, "find-skills", "SKILL.md"), "---\nname: find-skills\ndescription: 搜\n---\n正文\n");
  fs.mkdirSync(path.join(tmp, "bulky"));
  fs.writeFileSync(path.join(tmp, "bulky", "SKILL.md"), `---\nname: bulky\ndescription: 头\n---\n${"x".repeat(80000)}`);
  fs.mkdirSync(path.join(tmp, "node_modules", "fake"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "node_modules", "fake", "SKILL.md"), "---\nname: leak\n---\nno\n");
  const scanned = await handleFs({ action: "scanSkills", path: tmp });
  assert(scanned.ok && scanned.count === 2, "scanSkills count " + scanned.count);
  assert(scanned.files.some((f) => f.path === "find-skills/SKILL.md"), "scanSkills path");
  assert(scanned.files.every((f) => !f.text && !f.body), "scanSkills meta only");
  assert(scanned.files.find((f) => f.name === "bulky")?.when === "头", "scanSkills head only");

  let joinThrew = false;
  try {
    safeJoinRoot(tmp, "../etc/passwd");
  } catch {
    joinThrew = true;
  }
  assert(joinThrew, "safeJoin");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("PASS native-host");

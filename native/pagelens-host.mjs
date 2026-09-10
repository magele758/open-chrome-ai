#!/usr/bin/env node
/**
 * PageLens Chrome Native Messaging host.
 * Protocol: 4-byte native-endian length + UTF-8 JSON. Logs go to stderr only.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_NAME = "com.pagelens.host";
export const HOST_VERSION = "1.0.0";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 300_000;
export const MAX_OUTPUT = 200_000;
export const MAX_COMMAND = 32_000;

const isMain =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

export function encodeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function tryReadMessage(buf) {
  if (buf.length < 4) return null;
  const len = buf.readUInt32LE(0);
  if (len < 0 || len > 8 * 1024 * 1024) {
    throw new Error(`native message too large: ${len}`);
  }
  if (buf.length < 4 + len) return null;
  const json = buf.subarray(4, 4 + len).toString("utf8");
  const msg = JSON.parse(json);
  return { msg, rest: buf.subarray(4 + len) };
}

function clip(text, max = MAX_OUTPUT) {
  const s = String(text || "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n【已截断，共 ${s.length} 字】`;
}

function resolveCwd(raw) {
  const cwd = String(raw || "").trim() || os.homedir();
  if (!path.isAbsolute(cwd)) throw new Error("cwd 必须是绝对路径。");
  if (cwd.includes("\0")) throw new Error("cwd 不合法。");
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`cwd 不存在或不是目录：${cwd}`);
  }
  return cwd;
}

function resolveTimeout(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(n), MAX_TIMEOUT_MS);
}

function loginShell() {
  const sh = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/zsh";
  if (process.platform === "win32") return { bin: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c"] };
  return { bin: sh, args: ["-lc"] };
}

export function execCommand({ command, cwd, timeoutMs } = {}) {
  const cmd = String(command || "").trim();
  if (!cmd) return Promise.resolve({ ok: false, error: "command 不能为空。" });
  if (cmd.length > MAX_COMMAND) return Promise.resolve({ ok: false, error: "command 过长。" });

  let workdir;
  try {
    workdir = resolveCwd(cwd);
  } catch (err) {
    return Promise.resolve({ ok: false, error: err.message || String(err) });
  }

  const timeout = resolveTimeout(timeoutMs);
  const shell = loginShell();
  const started = Date.now();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(shell.bin, [...shell.args, cmd], {
      cwd: workdir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: true,
        code: extra.code,
        stdout: clip(stdout),
        stderr: clip(stderr),
        timedOut,
        ms: Date.now() - started,
        cwd: workdir,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 1500);
    }, timeout);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      stderr += err?.message || String(err);
      finish({ code: 127 });
    });
    child.on("close", (code, signal) => {
      finish({ code: timedOut ? 124 : code == null ? (signal ? 1 : 0) : code });
    });
  });
}

export async function handleRequest(req) {
  const op = String(req?.op || "").trim();
  if (op === "ping") {
    return {
      ok: true,
      op: "ping",
      name: HOST_NAME,
      version: HOST_VERSION,
      shell: process.env.SHELL || "",
      platform: process.platform,
    };
  }
  if (op === "exec") {
    const out = await execCommand({
      command: req.command,
      cwd: req.cwd,
      timeoutMs: req.timeoutMs,
    });
    return { op: "exec", ...out };
  }
  return { ok: false, error: `未知 op：${op || "(空)"}` };
}

function writeReply(obj) {
  process.stdout.write(encodeMessage(obj));
}

export function attachStdio(stdin = process.stdin, stdoutWrite = writeReply) {
  let buf = Buffer.alloc(0);
  stdin.on("data", async (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      let parsed;
      try {
        parsed = tryReadMessage(buf);
      } catch (err) {
        stdoutWrite({ ok: false, error: err.message || String(err) });
        process.exit(1);
        return;
      }
      if (!parsed) break;
      buf = parsed.rest;
      try {
        stdoutWrite(await handleRequest(parsed.msg));
      } catch (err) {
        stdoutWrite({ ok: false, error: err.message || String(err) });
      }
    }
  });
  stdin.on("end", () => process.exit(0));
  stdin.on("error", () => process.exit(1));
}

if (isMain) {
  process.stdin.resume();
  attachStdio();
}

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
import {
  expandUserPath,
  fileExt,
  isSkillFile,
  looksAbsolutePath,
  MAX_FS_TEXT,
  MAX_SKILL_COUNT,
  MAX_SKILL_DEPTH,
  parseSkillMeta,
  SKILL_META_HEAD,
  shouldSkipDir,
  splitRelParts,
  TEXT_FILE_EXT,
} from "../extension/lib/fs-path.js";

export const HOST_NAME = "com.pagelens.host";
export const HOST_VERSION = "1.1.0";
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

function resolveAbs(raw) {
  const expanded = expandUserPath(raw, os.homedir());
  if (!expanded) throw new Error("路径不能为空。");
  if (expanded.includes("\0")) throw new Error("路径不合法。");
  if (!path.isAbsolute(expanded) && !looksAbsolutePath(expanded)) {
    throw new Error("必须是绝对路径（或以 ~ 开头）。");
  }
  const abs = path.resolve(expanded);
  if (!path.isAbsolute(abs)) throw new Error("必须是绝对路径（或以 ~ 开头）。");
  return abs;
}

export function safeJoinRoot(root, rel) {
  const base = resolveAbs(root);
  const parts = String(rel || "").trim() ? splitRelParts(rel) : [];
  const abs = path.resolve(base, ...parts);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (abs !== base && !abs.startsWith(prefix)) throw new Error("路径超出目录。");
  return abs;
}

function sortEntries(entries) {
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

function readFileHead(filePath, max = SKILL_META_HEAD) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function scanSkillTreeFromPath(root, { maxSkills = MAX_SKILL_COUNT, maxDepth = MAX_SKILL_DEPTH } = {}) {
  const files = [];
  let truncated = false;

  const walk = (dir, prefix, depth) => {
    if (truncated) return;
    if (depth > maxDepth) return;
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of names) {
      if (truncated) return;
      const name = ent.name;
      if (ent.isDirectory()) {
        if (shouldSkipDir(name)) continue;
        walk(path.join(dir, name), prefix ? `${prefix}/${name}` : name, depth + 1);
        continue;
      }
      if (!ent.isFile() || !isSkillFile(name)) continue;
      if (files.length >= maxSkills) {
        truncated = true;
        return;
      }
      const rel = prefix ? `${prefix}/${name}` : name;
      let text = "";
      try {
        text = readFileHead(path.join(dir, name));
      } catch {
        continue;
      }
      const meta = parseSkillMeta(text);
      files.push({
        path: rel,
        name: meta?.name || "",
        when: meta?.when || "",
      });
    }
  };

  walk(root, "", 0);
  return { files, truncated };
}

export function handleFs(req) {
  const action = String(req?.action || "").trim();
  try {
    if (action === "stat") {
      const abs = resolveAbs(req.path);
      if (!fs.existsSync(abs)) return { ok: false, op: "fs", action, error: `路径不存在：${abs}` };
      const st = fs.statSync(abs);
      return {
        ok: true,
        op: "fs",
        action,
        path: abs,
        name: path.basename(abs) || abs,
        kind: st.isDirectory() ? "directory" : "file",
      };
    }
    if (action === "readdir") {
      const abs = safeJoinRoot(req.root || req.path, req.rel || "");
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        return { ok: false, op: "fs", action, error: `不是目录：${abs}` };
      }
      const names = fs.readdirSync(abs, { withFileTypes: true });
      const relParts = String(req.rel || "").trim() ? splitRelParts(req.rel) : [];
      const entries = [];
      for (const ent of names.slice(0, 200)) {
        const kind = ent.isDirectory() ? "directory" : "file";
        entries.push({
          name: ent.name,
          kind,
          path: [...relParts, ent.name].join("/"),
        });
      }
      return {
        ok: true,
        op: "fs",
        action,
        folder: path.basename(abs),
        path: relParts.join("/"),
        count: entries.length,
        entries: sortEntries(entries),
      };
    }
    if (action === "readText") {
      const rel = String(req.rel || "").trim();
      const parts = splitRelParts(rel);
      const abs = safeJoinRoot(req.root || req.path, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return { ok: false, op: "fs", action, error: `文件不存在：${abs}` };
      }
      const text = fs.readFileSync(abs, "utf8");
      if (text.length > MAX_FS_TEXT) {
        return {
          ok: true,
          op: "fs",
          action,
          text: `${text.slice(0, MAX_FS_TEXT)}\n【已截断】`,
          bytes: text.length,
          path: parts.join("/"),
          truncated: true,
        };
      }
      return { ok: true, op: "fs", action, text, bytes: text.length, path: parts.join("/") };
    }
    if (action === "writeText") {
      const rel = String(req.rel || "").trim();
      const parts = splitRelParts(rel);
      const name = parts[parts.length - 1];
      if (!TEXT_FILE_EXT.has(fileExt(name))) {
        return { ok: false, op: "fs", action, error: `只能写入 ${[...TEXT_FILE_EXT].join("、")} 文件。` };
      }
      const body = String(req.text ?? "");
      if (body.length > MAX_FS_TEXT) {
        return { ok: false, op: "fs", action, error: `文件太大（>${MAX_FS_TEXT} 字）。` };
      }
      const abs = safeJoinRoot(req.root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body, "utf8");
      return { ok: true, op: "fs", action, path: parts.join("/"), bytes: body.length };
    }
    if (action === "scanSkills") {
      const abs = resolveAbs(req.path);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        return { ok: false, op: "fs", action, error: `不是目录：${abs}` };
      }
      const scanned = scanSkillTreeFromPath(abs, {
        maxSkills: Number(req.maxSkills) || MAX_SKILL_COUNT,
        maxDepth: Number(req.maxDepth) || MAX_SKILL_DEPTH,
      });
      return {
        ok: true,
        op: "fs",
        action,
        path: abs,
        name: path.basename(abs) || abs,
        count: scanned.files.length,
        truncated: scanned.truncated,
        files: scanned.files,
      };
    }
    return { ok: false, op: "fs", action, error: `未知 fs action：${action || "(空)"}` };
  } catch (err) {
    return { ok: false, op: "fs", action, error: err.message || String(err) };
  }
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
  if (op === "fs") {
    return handleFs(req);
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

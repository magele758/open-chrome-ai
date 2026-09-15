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
import { shellPolicyBlock } from "../extension/lib/agent/shell-policy.js";
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
export const HOST_VERSION = "1.3.0";
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
  const blocked = shellPolicyBlock(cmd);
  if (blocked) return Promise.resolve({ ok: false, error: blocked });

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
    if (action === "ensureDir") {
      const abs = resolveAbs(req.path);
      fs.mkdirSync(abs, { recursive: true });
      const st = fs.statSync(abs);
      if (!st.isDirectory()) return { ok: false, op: "fs", action, error: `不是目录：${abs}` };
      return {
        ok: true,
        op: "fs",
        action,
        path: abs,
        name: path.basename(abs) || abs,
        kind: "directory",
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
    if (action === "deleteFile") {
      const rel = String(req.rel || "").trim();
      const parts = splitRelParts(rel);
      const abs = safeJoinRoot(req.root, rel);
      if (fs.existsSync(abs)) {
        fs.unlinkSync(abs);
      }
      return { ok: true, op: "fs", action, path: parts.join("/") };
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
      repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
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

export const MCP_TOOLS = [
  {
    name: "exec_command",
    description: "Execute a shell command on the host system (with timeout and output clipping)",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
        cwd: { type: "string", description: "Working directory (absolute path). Defaults to home dir." },
        timeoutMs: { type: "number", description: "Timeout in milliseconds (default 60000, max 300000)" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read text contents of a file from the host filesystem",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path or root directory path" },
        rel: { type: "string", description: "Optional relative path under root" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write text contents to a file on the host filesystem",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Root directory path" },
        rel: { type: "string", description: "Relative file path under root" },
        text: { type: "string", description: "Text content to write" },
      },
      required: ["root", "rel", "text"],
    },
  },
  {
    name: "list_directory",
    description: "List files and directories within a directory on the host filesystem",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to directory" },
        rel: { type: "string", description: "Optional relative path under path" },
      },
      required: ["path"],
    },
  },
  {
    name: "scan_skills",
    description: "Scan and parse Antigravity/Agent skill definitions (.md files) in a directory tree",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to scan" },
        maxSkills: { type: "number", description: "Maximum skills to return (default 200)" },
        maxDepth: { type: "number", description: "Maximum directory recursion depth (default 4)" },
      },
      required: ["path"],
    },
  },
];

export async function handleMcpRequest(req) {
  if (!req || typeof req !== "object") {
    return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
  }
  const { id, method, params } = req;

  if (method === "notifications/initialized") {
    return null;
  }

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "pagelens-host",
          version: HOST_VERSION,
        },
      },
    };
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: MCP_TOOLS,
      },
    };
  }

  if (method === "tools/call") {
    const name = String(params?.name || "");
    const args = params?.arguments || {};

    if (name === "exec_command") {
      const res = await execCommand({
        command: args.command,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
      });
      const text = res.ok
        ? [res.stdout, res.stderr].filter(Boolean).join("\n") || `(Command exited with code ${res.code})`
        : `Error: ${res.error}`;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text }],
          isError: !res.ok || (res.code != null && res.code !== 0),
        },
      };
    }

    if (name === "read_file") {
      const res = handleFs({
        action: "readText",
        path: args.path,
        root: args.root || args.path,
        rel: args.rel || "",
      });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: res.ok ? res.text : `Error: ${res.error}` }],
          isError: !res.ok,
        },
      };
    }

    if (name === "write_file") {
      const res = handleFs({
        action: "writeText",
        root: args.root,
        rel: args.rel,
        text: args.text,
      });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: res.ok ? `Successfully wrote ${res.bytes} characters to ${res.path}` : `Error: ${res.error}` }],
          isError: !res.ok,
        },
      };
    }

    if (name === "list_directory") {
      const res = handleFs({
        action: "readdir",
        path: args.path,
        root: args.path,
        rel: args.rel || "",
      });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: res.ok ? JSON.stringify(res.entries, null, 2) : `Error: ${res.error}` }],
          isError: !res.ok,
        },
      };
    }

    if (name === "scan_skills") {
      const res = handleFs({
        action: "scanSkills",
        path: args.path,
        maxSkills: args.maxSkills,
        maxDepth: args.maxDepth,
      });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: res.ok ? JSON.stringify(res.files, null, 2) : `Error: ${res.error}` }],
          isError: !res.ok,
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Tool not found: ${name}` },
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

export function attachMcpStdio(stdin = process.stdin, stdout = process.stdout) {
  let lineBuf = "";
  stdin.setEncoding("utf8");
  stdin.on("data", async (chunk) => {
    lineBuf += chunk;
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        const reply = await handleMcpRequest(parsed);
        if (reply) {
          stdout.write(JSON.stringify(reply) + "\n");
        }
      } catch (err) {
        stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: `JSON parse error: ${err.message || String(err)}` },
          }) + "\n",
        );
      }
    }
  });
  stdin.on("end", () => process.exit(0));
  stdin.on("error", () => process.exit(1));
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
  const isMcp = process.argv.includes("--mcp") || Boolean(process.env.PAGELENS_MCP);
  process.stdin.resume();
  if (isMcp) {
    attachMcpStdio();
  } else {
    attachStdio();
  }
}

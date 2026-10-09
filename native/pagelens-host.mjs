#!/usr/bin/env node
/**
 * PageLens Chrome Native Messaging host.
 * Protocol: 4-byte native-endian length + UTF-8 JSON. Logs go to stderr only.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOCKET_PROTOCOL, connectGateway, createBroker, defaultSocketPath } from "./gateway.mjs";
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
export const HOST_VERSION = "1.4.0";
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

const AGENT_DENY_SEG = new Set([".ssh", ".aws", ".gnupg", ".kube", ".netrc"]);

export function agentFsRoots(extra = []) {
  const home = os.homedir();
  const roots = [
    home,
    path.join(home, "Downloads"),
    path.join(home, "Desktop"),
    path.join(home, "Documents"),
    os.tmpdir(),
    path.join(home, ".cache", "pagelens-docs"),
    path.join(home, ".agent-reach"),
  ];
  for (const raw of extra || []) {
    try {
      if (raw) roots.push(resolveAbs(raw));
    } catch {
      /* skip bad extra root */
    }
  }
  return [...new Set(roots.map((r) => path.resolve(r)))];
}

export function isUnderAgentRoot(abs, extraRoots) {
  const target = path.resolve(abs);
  return agentFsRoots(extraRoots).some((root) => {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    return target === root || target.startsWith(prefix);
  });
}

function denyAgentAbs(abs, extraRoots) {
  const segs = String(abs || "").split(/[/\\]/);
  if (segs.some((s) => AGENT_DENY_SEG.has(s))) return `已拦截敏感路径：${abs}`;
  if (!isUnderAgentRoot(abs, extraRoots)) {
    return `已拦截：只能访问家目录、下载/桌面/文档、临时目录、字幕缓存或 ~/.agent-reach。收到：${abs}`;
  }
  return "";
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
  const agentScope = req?.scope === "agent";
  try {
    if (agentScope && (action === "writeText" || action === "deleteFile" || action === "ensureDir")) {
      return { ok: false, op: "fs", action, error: "已拦截：agent 不能通过此接口写文件。" };
    }
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
      if (agentScope) {
        const denied = denyAgentAbs(abs, req.extraRoots);
        if (denied) return { ok: false, op: "fs", action, error: denied };
      }
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
      const parts = rel ? splitRelParts(rel) : [];
      const abs = safeJoinRoot(req.root || req.path, rel);
      if (agentScope) {
        const denied = denyAgentAbs(abs, req.extraRoots);
        if (denied) return { ok: false, op: "fs", action, error: denied };
      }
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
          path: parts.join("/") || path.basename(abs),
          abs,
          truncated: true,
        };
      }
      return { ok: true, op: "fs", action, text, bytes: text.length, path: parts.join("/") || path.basename(abs), abs };
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
  if (op === "clipboard_write") {
    const textIn = String(req.text ?? "");
    const htmlIn = String(req.html ?? "");
    if (!textIn && !htmlIn) return { ok: false, op: "clipboard_write", error: "需要 text 或 html。" };
    const b64 = (s) => Buffer.from(String(s), "utf8").toString("base64");
    const plainB64 = b64(textIn || htmlIn.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    const htmlB64 = b64(htmlIn || "");
    const script =
      "ObjC.import('AppKit');\n" +
      "function fromB64(b64) {\n" +
      "  if (!b64) return '';\n" +
      "  const data = $.NSData.alloc.initWithBase64EncodedStringOptions(b64, 0);\n" +
      "  return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));\n" +
      "}\n" +
      `const plain = fromB64(${JSON.stringify(plainB64)});\n` +
      `const html = fromB64(${JSON.stringify(htmlB64)});\n` +
      "const pb = $.NSPasteboard.generalPasteboard;\n" +
      "pb.clearContents;\n" +
      "const types = html ? $([$.NSPasteboardTypeString, $.NSPasteboardTypeHTML]) : $([$.NSPasteboardTypeString]);\n" +
      "pb.declareTypesOwner(types, null);\n" +
      "pb.setStringForType($(plain), $.NSPasteboardTypeString);\n" +
      "if (html) pb.setStringForType($(html), $.NSPasteboardTypeHTML);\n" +
      "'ok';\n";
    const tmp = path.join(os.tmpdir(), `pagelens-clip-${process.pid}-${Date.now()}.js`);
    try {
      fs.writeFileSync(tmp, script, "utf8");
      const out = await execCommand({
        command: `osascript -l JavaScript ${JSON.stringify(tmp)}`,
        timeoutMs: 12000,
      });
      if (out.code !== 0) {
        return { ok: false, op: "clipboard_write", error: out.stderr || out.stdout || `exit ${out.code}` };
      }
      return { ok: true, op: "clipboard_write", text: textIn.length, html: htmlIn.length };
    } catch (err) {
      return { ok: false, op: "clipboard_write", error: err?.message || String(err) };
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
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

function mcpText(text, isError) {
  return { content: [{ type: "text", text }], isError };
}

/** 本机 shell/fs MCP 工具；未知工具返回 null。 */
export async function callLocalMcpTool(name, args = {}) {
  if (name === "exec_command") {
    const res = await execCommand({
      command: args.command,
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
    });
    const text = res.ok
      ? [res.stdout, res.stderr].filter(Boolean).join("\n") || `(Command exited with code ${res.code})`
      : `Error: ${res.error}`;
    return mcpText(text, !res.ok || (res.code != null && res.code !== 0));
  }
  if (name === "read_file") {
    const res = handleFs({
      action: "readText",
      path: args.path,
      root: args.root || args.path,
      rel: args.rel || "",
    });
    return mcpText(res.ok ? res.text : `Error: ${res.error}`, !res.ok);
  }
  if (name === "write_file") {
    const res = handleFs({
      action: "writeText",
      root: args.root,
      rel: args.rel,
      text: args.text,
    });
    return mcpText(res.ok ? `Successfully wrote ${res.bytes} characters to ${res.path}` : `Error: ${res.error}`, !res.ok);
  }
  if (name === "list_directory") {
    const res = handleFs({
      action: "readdir",
      path: args.path,
      root: args.path,
      rel: args.rel || "",
    });
    return mcpText(res.ok ? JSON.stringify(res.entries, null, 2) : `Error: ${res.error}`, !res.ok);
  }
  if (name === "scan_skills") {
    const res = handleFs({
      action: "scanSkills",
      path: args.path,
      maxSkills: args.maxSkills,
      maxDepth: args.maxDepth,
    });
    return mcpText(res.ok ? JSON.stringify(res.files, null, 2) : `Error: ${res.error}`, !res.ok);
  }
  return null;
}

function mcpInitialize(id, name, capabilities = {}) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
        ...capabilities,
      },
      serverInfo: {
        name,
        version: HOST_VERSION,
      },
    },
  };
}

/** 无 token 的旧 MCP 模式：只有本机 shell/fs 工具，不连扩展。 */
export async function handleMcpRequest(req) {
  if (!req || typeof req !== "object") {
    return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
  }
  const { id, method, params } = req;

  if (method === "notifications/initialized") {
    return null;
  }

  if (method === "initialize") {
    return mcpInitialize(id, "pagelens-host");
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
    const result = await callLocalMcpTool(name, params?.arguments || {});
    if (result) return { jsonrpc: "2.0", id, result };
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

/** 本机工具在网关模式下要求 token 持有的 scope。 */
export const LOCAL_TOOL_SCOPES = Object.freeze({
  exec_command: "host:shell",
  read_file: "host:fs",
  write_file: "host:fs",
  list_directory: "host:fs",
  scan_skills: "host:fs",
});

/** 网关里不需要暴露给 MCP 的元工具（tools/list 已覆盖）。 */
const HIDDEN_BRIDGE_TOOLS = new Set(["list_tools"]);

export function bridgeToolToMcp(tool) {
  const notes = [tool.scope ? `scope: ${tool.scope}` : "", tool.focus && tool.focus !== "none" ? `focus: ${tool.focus}` : ""]
    .filter(Boolean)
    .join("; ");
  return {
    name: tool.name,
    description: notes ? `${tool.description}（${notes}）` : tool.description,
    inputSchema: tool.parameters || { type: "object", properties: {} },
  };
}

/** bridge 响应 → MCP tools/call result；截图等图片 artifact 变成 image 内容。 */
export function bridgeResponseToMcp(res) {
  const content = [];
  if (res?.ok) {
    content.push({ type: "text", text: JSON.stringify(res.result ?? null, null, 2) });
  } else {
    const e = res?.error || { code: "TOOL_FAILED", message: "未知错误" };
    const lines = [`${e.code}: ${e.message}`];
    if (e.hint) lines.push(`提示：${e.hint}`);
    if (e.retryable) lines.push("（可重试）");
    if (e.details !== undefined) lines.push(`details: ${JSON.stringify(e.details).slice(0, 4000)}`);
    content.push({ type: "text", text: lines.join("\n") });
  }
  for (const a of res?.artifacts || []) {
    if (a.encoding === "base64" && /^image\//.test(a.mime || "")) {
      content.push({ type: "image", data: a.data, mimeType: a.mime });
    } else if (a.encoding === "base64") {
      content.push({ type: "resource", resource: { uri: `pagelens://artifact/${a.name}`, mimeType: a.mime, blob: a.data } });
    } else {
      content.push({ type: "resource", resource: { uri: `pagelens://artifact/${a.name}`, mimeType: a.mime, text: a.data } });
    }
  }
  return { content, isError: !res?.ok };
}

export const MCP_LOG_LEVELS = Object.freeze(["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"]);
export const PAGELENS_EVENT_CAPABILITY = "pagelens/events";

/** 扩展推送的事件 → MCP 通知：logging 风格的 notifications/message（level info），声明了实验能力的客户端另收 notifications/pagelens/event。 */
export function eventNotifications(event, { logLevel = "info", custom = false } = {}) {
  const out = [];
  if (MCP_LOG_LEVELS.indexOf(logLevel) <= MCP_LOG_LEVELS.indexOf("info")) {
    out.push({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", logger: "pagelens", data: event } });
  }
  if (custom) out.push({ jsonrpc: "2.0", method: "notifications/pagelens/event", params: { event } });
  return out;
}

/**
 * 带 token 的 MCP 模式：tools/list 来自扩展的会话工具（按 token scope 过滤），
 * 本机 shell/fs 工具只在 token 有 host:shell / host:fs 时出现。
 * notify：把服务端主动通知（事件）写给 MCP 客户端。
 */
export function createGatewayMcpHandler({
  token,
  socketPath = defaultSocketPath(),
  agentName = "",
  connect = connectGateway,
  connectTimeoutMs = 5000,
  notify = () => {},
} = {}) {
  let client = null;
  let connecting = null;
  let clientName = "";
  let logLevel = "info";
  let customEvents = false;

  function onEvent(event) {
    for (const msg of eventNotifications(event, { logLevel, custom: customEvents })) notify(msg);
  }

  async function ensure() {
    if (client && !client.closed) return client;
    connecting ||= connect({ socketPath, token, agentName: agentName || clientName || "mcp", timeoutMs: connectTimeoutMs, onEvent })
      .then((c) => {
        client = c;
        return c;
      })
      .finally(() => {
        connecting = null;
      });
    return connecting;
  }

  const scopes = () => client?.agent?.scopes || [];
  const localAllowed = (name) => Boolean(LOCAL_TOOL_SCOPES[name]) && scopes().includes(LOCAL_TOOL_SCOPES[name]);

  function connectError(id, err) {
    const hint = err?.hint ? `\n提示：${err.hint}` : "";
    return { jsonrpc: "2.0", id, error: { code: -32000, message: `${err?.code && err.code !== "GATEWAY_UNAVAILABLE" ? `${err.code}: ` : ""}${err?.message || err}${hint}` } };
  }

  async function handle(req) {
    if (!req || typeof req !== "object") {
      return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
    }
    const { id, method, params } = req;
    if (method === "notifications/initialized" || (typeof method === "string" && method.startsWith("notifications/"))) return null;
    if (method === "initialize") {
      clientName = String(params?.clientInfo?.name || "").slice(0, 60);
      customEvents = Boolean(params?.capabilities?.experimental?.[PAGELENS_EVENT_CAPABILITY]);
      return mcpInitialize(id, "pagelens", { logging: {}, experimental: { [PAGELENS_EVENT_CAPABILITY]: {} } });
    }
    if (method === "logging/setLevel") {
      const level = String(params?.level || "");
      if (!MCP_LOG_LEVELS.includes(level)) return { jsonrpc: "2.0", id, error: { code: -32602, message: `未知日志级别：${level}` } };
      logLevel = level;
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") {
      let c;
      try {
        c = await ensure();
      } catch (err) {
        return connectError(id, err);
      }
      const tools = c.tools.filter((t) => !HIDDEN_BRIDGE_TOOLS.has(t.name)).map(bridgeToolToMcp);
      for (const t of MCP_TOOLS) if (localAllowed(t.name)) tools.push(t);
      return { jsonrpc: "2.0", id, result: { tools } };
    }
    if (method === "tools/call") {
      const name = String(params?.name || "");
      const args = params?.arguments || {};
      let c;
      try {
        c = await ensure();
      } catch (err) {
        return { jsonrpc: "2.0", id, result: mcpText(err?.message || String(err), true) };
      }
      if (LOCAL_TOOL_SCOPES[name]) {
        if (!localAllowed(name)) {
          return { jsonrpc: "2.0", id, result: mcpText(`SCOPE_DENIED: token 没有 ${LOCAL_TOOL_SCOPES[name]} 权限，不能调用 ${name}。`, true) };
        }
        return { jsonrpc: "2.0", id, result: await callLocalMcpTool(name, args) };
      }
      let res;
      try {
        res = await c.call({ id: `mcp-${crypto.randomUUID()}`, tool: name, args });
      } catch (err) {
        return { jsonrpc: "2.0", id, result: mcpText(err?.message || String(err), true) };
      }
      return { jsonrpc: "2.0", id, result: bridgeResponseToMcp(res) };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }

  return { handle, close: () => client?.close() };
}

export function resolveMcpToken({ argv = process.argv, env = process.env, home = os.homedir() } = {}) {
  const i = argv.indexOf("--token-file");
  if (i >= 0) {
    const raw = String(argv[i + 1] || "").trim();
    if (!raw) throw new Error("--token-file 需要路径。");
    const file = expandUserPath(raw, home);
    return { token: fs.readFileSync(file, "utf8").trim(), source: file };
  }
  const token = String(env.PAGELENS_TOKEN || "").trim();
  return token ? { token, source: "PAGELENS_TOKEN" } : { token: "", source: "" };
}

export function attachMcpStdio(stdin = process.stdin, stdout = process.stdout, handler = handleMcpRequest) {
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
        const reply = await handler(parsed);
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

/**
 * Chrome 端口上的消息分发。一次性 op（ping/exec/fs/clipboard_write）照旧一问一答；
 * connectNative 长连接发 broker.start 后进入 broker 模式，bridge.* 消息转给 socket 会话。
 */
export function createHostMessageHandler({ write, socketPath = defaultSocketPath(), makeBroker = createBroker, log = () => {} }) {
  let broker = null;
  let starting = null;

  async function startBroker() {
    if (broker) return broker;
    starting ||= (async () => {
      const b = makeBroker({ socketPath, post: write, log });
      await b.start();
      broker = b;
      return b;
    })().finally(() => {
      starting = null;
    });
    return starting;
  }

  return {
    async onMessage(msg) {
      if (msg?.type === "broker.start") {
        try {
          const b = await startBroker();
          write({ type: "broker.ready", socketPath: b.socketPath, version: HOST_VERSION, protocol: SOCKET_PROTOCOL });
        } catch (err) {
          write({ type: "broker.error", error: err?.message || String(err) });
        }
        return;
      }
      if (typeof msg?.type === "string" && msg.type.startsWith("bridge.")) {
        broker?.handleExtensionMessage(msg);
        return;
      }
      try {
        write(await handleRequest(msg));
      } catch (err) {
        write({ ok: false, error: err.message || String(err) });
      }
    },
    async close() {
      await starting?.catch(() => {});
      await broker?.close();
      broker = null;
    },
    isBroker: () => Boolean(broker),
  };
}

export function attachStdio(stdin = process.stdin, stdoutWrite = writeReply, { log = (m) => process.stderr.write(`[pagelens-host] ${m}\n`) } = {}) {
  const host = createHostMessageHandler({ write: stdoutWrite, log });
  let buf = Buffer.alloc(0);
  const finish = (code) => {
    host
      .close()
      .catch(() => {})
      .finally(() => process.exit(code));
  };
  stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      let parsed;
      try {
        parsed = tryReadMessage(buf);
      } catch (err) {
        stdoutWrite({ ok: false, error: err.message || String(err) });
        finish(1);
        return;
      }
      if (!parsed) break;
      buf = parsed.rest;
      host.onMessage(parsed.msg);
    }
  });
  stdin.on("end", () => finish(0));
  stdin.on("error", () => finish(1));
  return host;
}

function startMcp() {
  let resolved;
  try {
    resolved = resolveMcpToken();
  } catch (err) {
    process.stderr.write(`[pagelens-mcp] 读取 token 失败：${err.message || err}\n`);
    process.exit(1);
  }
  if (!resolved.token) {
    process.stderr.write("[pagelens-mcp] 未提供 token：只提供本机 shell/fs 工具。浏览器工具需要 PAGELENS_TOKEN 或 --token-file。\n");
    attachMcpStdio();
    return;
  }
  const nameIdx = process.argv.indexOf("--agent-name");
  const agentName = nameIdx >= 0 ? String(process.argv[nameIdx + 1] || "") : String(process.env.PAGELENS_AGENT_NAME || "");
  const gateway = createGatewayMcpHandler({
    token: resolved.token,
    agentName,
    notify: (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`),
  });
  attachMcpStdio(process.stdin, process.stdout, (req) => gateway.handle(req));
}

if (isMain) {
  const isMcp = process.argv.includes("--mcp") || Boolean(process.env.PAGELENS_MCP);
  process.stdin.resume();
  if (isMcp) {
    startMcp();
  } else {
    attachStdio();
  }
}

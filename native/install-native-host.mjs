#!/usr/bin/env node
/**
 * Register com.pagelens.host for Chrome / Chromium on this machine.
 *
 *   node native/install-native-host.mjs
 *   node native/install-native-host.mjs --extension-id <id>
 *   node native/install-native-host.mjs --uninstall
 *
 * 外部 Agent（MCP）：
 *   node native/install-native-host.mjs --save-token <name> [--token plk_...]   # 存到 ~/.pagelens/agents/<name>.token（0600）
 *   node native/install-native-host.mjs --mcp-config <name> [--write-cursor]   # 打印 Cursor / Claude Code / Codex 配置
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { HOST_NAME } from "./pagelens-host.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const extensionDir = path.resolve(repoRoot, "extension");
const hostMjs = path.resolve(here, "pagelens-host.mjs");
const home = os.homedir();
const isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
const TOKEN_RE = /^plk_[A-Za-z0-9_-]{43}$/;
export const MCP_SERVER_NAME = "pagelens";

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return "";
  return String(process.argv[i + 1] || "").trim();
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function chromeUserDataDirs() {
  if (process.platform === "darwin") {
    return [
      path.join(home, "Library/Application Support/Google/Chrome"),
      path.join(home, "Library/Application Support/Google/Chrome Canary"),
      path.join(home, "Library/Application Support/Google/Chrome Dev"),
      path.join(home, "Library/Application Support/Google/Chrome Beta"),
      path.join(home, "Library/Application Support/Chromium"),
    ];
  }
  if (process.platform === "linux") {
    return [
      path.join(home, ".config/google-chrome"),
      path.join(home, ".config/google-chrome-unstable"),
      path.join(home, ".config/chromium"),
    ];
  }
  throw new Error(`暂不支持 ${process.platform}。请在 macOS 或 Linux 上安装。`);
}

function nativeHostDirs() {
  return chromeUserDataDirs()
    .filter((dir) => fs.existsSync(dir))
    .map((dir) => path.join(dir, "NativeMessagingHosts"));
}

function tryParseJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function idsFromSettings(settings, wantPath) {
  const ids = [];
  if (!settings || typeof settings !== "object") return ids;
  const resolved = path.resolve(wantPath);
  for (const [id, info] of Object.entries(settings)) {
    if (!/^[a-p]{32}$/.test(id)) continue;
    const p = info?.path;
    if (p && path.resolve(String(p)) === resolved) ids.push(id);
  }
  return ids;
}

function findExtensionIds(explicit) {
  if (explicit) {
    if (!/^[a-p]{32}$/.test(explicit)) {
      throw new Error(`扩展 ID 格式不对：${explicit}（应为 32 位 a-p）`);
    }
    return [explicit];
  }
  const found = new Set();
  for (const root of chromeUserDataDirs()) {
    if (!fs.existsSync(root)) continue;
    for (const profile of fs.readdirSync(root)) {
      const dir = path.join(root, profile);
      let st;
      try {
        st = fs.statSync(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      for (const name of ["Preferences", "Secure Preferences"]) {
        const json = tryParseJson(path.join(dir, name));
        for (const id of idsFromSettings(json?.extensions?.settings, extensionDir)) found.add(id);
      }
    }
  }
  return [...found];
}

function writeWrapper() {
  const dir = path.join(home, ".pagelens");
  fs.mkdirSync(dir, { recursive: true });
  const runner = path.join(dir, "pagelens-host");
  const nodePath = process.execPath;
  const pathEnv = process.env.PATH || "";
  const body = `#!/bin/sh
export PATH=${JSON.stringify(pathEnv)}
exec ${JSON.stringify(nodePath)} ${JSON.stringify(hostMjs)}
`;
  fs.writeFileSync(runner, body, { mode: 0o755 });
  fs.chmodSync(runner, 0o755);
  return runner;
}

function writeHostManifest(dir, runner, ids) {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${HOST_NAME}.json`);
  const manifest = {
    name: HOST_NAME,
    description: "PageLens native host for local shell",
    path: runner,
    type: "stdio",
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  };
  fs.writeFileSync(dest, `${JSON.stringify(manifest, null, 2)}\n`);
  return dest;
}

function uninstall() {
  const removed = [];
  for (const dir of nativeHostDirs()) {
    const dest = path.join(dir, `${HOST_NAME}.json`);
    if (fs.existsSync(dest)) {
      fs.unlinkSync(dest);
      removed.push(dest);
    }
  }
  const runner = path.join(home, ".pagelens/pagelens-host");
  if (fs.existsSync(runner)) {
    fs.unlinkSync(runner);
    removed.push(runner);
  }
  return removed;
}

export function agentSlug(name) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "agent";
}

export function tokenFilePath(name, homeDir = home) {
  return path.join(homeDir, ".pagelens", "agents", `${agentSlug(name)}.token`);
}

export function saveTokenFile(name, token, homeDir = home) {
  const value = String(token || "").trim();
  if (!TOKEN_RE.test(value)) throw new Error("token 格式不对：应为 plk_ 开头、在 PageLens 设置 → 外部 Agent 里创建。");
  const file = tokenFilePath(name, homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/** MCP 客户端拉起垫片的命令；用绝对路径的 node，避免 GUI 客户端 PATH 里找不到。 */
export function mcpCommand(tokenFile, { nodePath = process.execPath, host = hostMjs } = {}) {
  return { command: nodePath, args: [host, "--mcp", "--token-file", tokenFile] };
}

export function mcpConfigSnippets(name, opts = {}) {
  const file = opts.tokenFile || tokenFilePath(name, opts.home);
  const { command, args } = mcpCommand(file, opts);
  const quote = (v) => (/^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`);
  return {
    tokenFile: file,
    cursor: { mcpServers: { [MCP_SERVER_NAME]: { command, args } } },
    claude: `claude mcp add --scope user ${MCP_SERVER_NAME} -- ${[command, ...args].map(quote).join(" ")}`,
    codex: `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}`,
  };
}

/** 合并进 ~/.cursor/mcp.json；已有文件解析失败时不覆盖。 */
export function writeCursorConfig(entry, file = path.join(home, ".cursor", "mcp.json")) {
  let current = {};
  if (fs.existsSync(file)) {
    try {
      current = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
    } catch (err) {
      throw new Error(`${file} 不是合法 JSON，未修改：${err.message}`);
    }
  }
  const next = { ...current, mcpServers: { ...(current.mcpServers || {}), ...entry.mcpServers } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return file;
}

function printMcpConfig(name) {
  const s = mcpConfigSnippets(name);
  const missing = fs.existsSync(s.tokenFile) ? "" : `（还没有这个文件：先运行 --save-token ${agentSlug(name)}）`;
  console.log(`token 文件：${s.tokenFile}${missing}

Cursor（~/.cursor/mcp.json，或加 --write-cursor 自动合并）：
${JSON.stringify(s.cursor, null, 2)}

Claude Code：
${s.claude}

Codex（~/.codex/config.toml）：
${s.codex}

前提：Chrome 已打开，PageLens 设置 → 外部 Agent 已启用网关。`);
  if (hasFlag("--write-cursor")) console.log(`\n已写入 ${writeCursorConfig(s.cursor)}`);
}

async function readTokenInteractive() {
  const given = argValue("--token");
  if (given) return given;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdin.isTTY ? process.stderr : undefined, terminal: false });
  if (process.stdin.isTTY) process.stderr.write("粘贴 PageLens token（plk_…）后回车：");
  for await (const line of rl) {
    rl.close();
    return line.trim();
  }
  return "";
}

async function agentCommands() {
  const saveName = argValue("--save-token");
  if (hasFlag("--save-token")) {
    if (!saveName) throw new Error("--save-token 需要名称，例如 --save-token cursor");
    const file = saveTokenFile(saveName, await readTokenInteractive());
    console.log(`已保存（0600）：${file}\n`);
    printMcpConfig(saveName);
    return true;
  }
  if (hasFlag("--mcp-config")) {
    printMcpConfig(argValue("--mcp-config") || "agent");
    return true;
  }
  return false;
}

function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(`Usage:
  node native/install-native-host.mjs [--extension-id <id>]
  node native/install-native-host.mjs --uninstall
  node native/install-native-host.mjs --save-token <name> [--token plk_...]
  node native/install-native-host.mjs --mcp-config <name> [--write-cursor]
`);
    return;
  }
  if (hasFlag("--uninstall")) {
    const removed = uninstall();
    console.log(removed.length ? `已删除：\n${removed.join("\n")}` : "没有已安装的 host。");
    return;
  }

  const ids = findExtensionIds(argValue("--extension-id"));
  if (!ids.length) {
    throw new Error(
      "找不到已加载的 PageLens 扩展 ID。先在 chrome://extensions 加载 extension/，再到设置复制扩展 ID，然后运行：\n  node native/install-native-host.mjs --extension-id <id>",
    );
  }

  const dirs = nativeHostDirs();
  if (!dirs.length) {
    throw new Error("没有找到 Chrome 用户数据目录，无法登记 Native Messaging。");
  }

  const runner = writeWrapper();
  const written = dirs.map((dir) => writeHostManifest(dir, runner, ids));
  console.log(`host: ${HOST_NAME}`);
  console.log(`runner: ${runner}`);
  console.log(`extension-id: ${ids.join(", ")}`);
  console.log(`manifest:\n${written.join("\n")}`);
  console.log("请到 chrome://extensions 重新加载 PageLens，再到设置点「测试 host」。");
  console.log("外部 Agent（MCP）：在 PageLens 设置 → 外部 Agent 创建 token，然后运行 --save-token <name> 与 --mcp-config <name>。");
}

if (isMain) {
  try {
    if (hasFlag("--print-ids")) {
      console.log(findExtensionIds(argValue("--extension-id")).join("\n") || "(none)");
    } else if (!(await agentCommands())) {
      main();
    }
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}

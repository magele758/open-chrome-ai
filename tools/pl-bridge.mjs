#!/usr/bin/env node
/**
 * 外部 Agent 参考客户端：通过 CDP 连到 Chrome（--remote-debugging-port），
 * 附加到 PageLens 扩展的 Service Worker，执行 `globalThis.__pl.call(...)`。
 * 零依赖（Node 22+ 自带 WebSocket / fetch）。规范见 docs/agent-interop.md。
 *
 *   node tools/pl-bridge.mjs hello   --port 9222
 *   node tools/pl-bridge.mjs call    --port 9222 --tool list_tabs --args '{}'
 *   node tools/pl-bridge.mjs call    --port 9222 --tool read_rendered_html --args '{"tabId":12,"selector":"#output"}' --artifacts-dir /tmp/arts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? `: ${msg.error.data}` : ""}`));
        else resolve(msg.result);
      } else {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  static async connect({ port = 9222, host = "127.0.0.1" } = {}) {
    const res = await fetch(`http://${host}:${port}/json/version`);
    if (!res.ok) throw new Error(`CDP /json/version 失败：${res.status}`);
    const { webSocketDebuggerUrl } = await res.json();
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")), { once: true });
    });
    return new CdpConnection(ws);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    this.ws.close();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 找到扩展 SW 目标；SW 休眠时目标不存在，打开一个扩展页把它唤醒。 */
export async function findServiceWorker(conn, extensionId, { wakeMs = 8000 } = {}) {
  const prefix = extensionId ? `chrome-extension://${extensionId}/` : "chrome-extension://";
  const pick = async () => {
    const { targetInfos } = await conn.send("Target.getTargets");
    return targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(prefix) && t.url.endsWith("/sw.js"));
  };
  let sw = await pick();
  if (sw || !extensionId) return sw;
  const { targetId } = await conn.send("Target.createTarget", { url: `${prefix}offscreen/clipboard.html`, background: true });
  const deadline = Date.now() + wakeMs;
  while (!sw && Date.now() < deadline) {
    await sleep(200);
    sw = await pick();
  }
  await conn.send("Target.closeTarget", { targetId }).catch(() => {});
  return sw;
}

export async function connectBridge({ port = 9222, host = "127.0.0.1", extensionId } = {}) {
  const conn = await CdpConnection.connect({ port, host });
  const sw = await findServiceWorker(conn, extensionId);
  if (!sw) throw new Error("没有找到 PageLens Service Worker：确认扩展已加载，浏览器带 --enable-unsafe-extension-debugging。");
  const { sessionId } = await conn.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });

  async function evaluate(expression) {
    const res = await conn.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || "evaluate 异常");
    }
    return res.result.value;
  }

  return {
    conn,
    sessionId,
    extensionId: new URL(sw.url).host,
    hello: () => evaluate("globalThis.__pl.hello()"),
    /** 返回完整响应对象（ok / result / error / artifacts / meta）。 */
    async callRaw(tool, args = {}, { id = randomUUID(), timeoutMs, async } = {}) {
      const request = { v: 1, id, tool, args, ...(timeoutMs ? { timeoutMs } : {}), ...(async ? { async: true } : {}) };
      return evaluate(`globalThis.__pl.call(${JSON.stringify(request)})`);
    },
    /** 成功返回 { result, artifacts, meta }，失败抛出带 code/retryable 的错误。 */
    async call(tool, args = {}, opts = {}) {
      const res = await this.callRaw(tool, args, opts);
      if (!res.ok) {
        const err = new Error(`${res.error.code}: ${res.error.message}`);
        Object.assign(err, { code: res.error.code, retryable: res.error.retryable, details: res.error.details, hint: res.error.hint, response: res });
        throw err;
      }
      return res;
    },
    async pollJob(jobId, { intervalMs = 500, timeoutMs = 120000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { result } = await this.call("job_status", { jobId });
        if (result.status === "done") return result.response;
        await sleep(intervalMs);
      }
      throw new Error(`任务 ${jobId} 轮询超时`);
    },
    evaluate,
    close: () => conn.close(),
  };
}

export function saveArtifacts(artifacts = [], dir) {
  mkdirSync(dir, { recursive: true });
  return artifacts.map((a) => {
    const file = join(dir, a.name);
    writeFileSync(file, a.encoding === "base64" ? Buffer.from(a.data, "base64") : a.data);
    return file;
  });
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] == null ? true : argv[++i];
  }
  return flags;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (!["hello", "call"].includes(command)) {
    console.error("用法：pl-bridge.mjs hello|call --port 9222 [--extension-id ID] [--tool NAME --args JSON --timeout MS --artifacts-dir DIR]");
    process.exit(2);
  }
  const bridge = await connectBridge({ port: Number(flags.port) || 9222, extensionId: flags["extension-id"] });
  try {
    if (command === "hello") {
      console.log(JSON.stringify(await bridge.hello(), null, 2));
      return;
    }
    const res = await bridge.callRaw(String(flags.tool), flags.args ? JSON.parse(String(flags.args)) : {}, {
      timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
    });
    if (flags["artifacts-dir"] && res.artifacts?.length) {
      const files = saveArtifacts(res.artifacts, String(flags["artifacts-dir"]));
      res.artifacts = res.artifacts.map((a, i) => ({ name: a.name, mime: a.mime, size: a.size, file: files[i] }));
    }
    console.log(JSON.stringify(res, null, 2));
    process.exitCode = res.ok ? 0 : 1;
  } finally {
    bridge.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}

/**
 * PageLens 外部 Agent 网关（本机部分）。
 *
 *   Agent / MCP 垫片 ──NDJSON──▶ ~/.pagelens/bridge.sock（0600；Windows 命名管道）
 *                                   │  broker（Chrome 用 connectNative 拉起的 pagelens-host）
 *                                   ▼
 *                          Native Messaging port ──▶ 扩展 SW：bridge.call(request, { session })
 *
 * socket 帧（每行一个 JSON）：
 *   → {type:"hello", token, agentName}        ← {type:"welcome", sessionId, protocol:2, tools, agent} | {type:"error", error}
 *   → {type:"call", callId?, request}          ← {type:"result", callId, response}
 *   ← {type:"event", event}                    （订阅后由扩展推送，见 extension/lib/bridge/events.js）
 * port 消息：{type:"bridge.call", sessionId, callId, token, agentName, request} ↔ {type:"bridge.result", sessionId, callId, response}
 *            ← {type:"bridge.event", sessionId|null, event}；→ {type:"bridge.session.closed", sessionId}（socket 断开）
 * broker 不校验 token：每次调用都把 token 交给扩展，由扩展按 token 记录判定 scope / origin。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const SOCKET_PROTOCOL = 2;
/** Chrome 限制 host → 扩展单条消息 1 MB。 */
export const MAX_PORT_MESSAGE_BYTES = 1024 * 1024;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_AGENT_NAME = 80;

export function defaultSocketPath({ env = process.env, platform = process.platform, home = os.homedir(), user } = {}) {
  if (env.PAGELENS_SOCKET) return env.PAGELENS_SOCKET;
  if (platform === "win32") {
    const name = String(user || os.userInfo().username || "user").replace(/[^A-Za-z0-9_.-]/g, "_");
    return `\\\\.\\pipe\\pagelens-bridge-${name}`;
  }
  return path.join(home, ".pagelens", "bridge.sock");
}

const isPipe = (p) => String(p).startsWith("\\\\.\\pipe\\");

/** NDJSON 读取；单行超过 maxBytes 时调 onOverflow 并停止。 */
export function createLineReader(onLine, { maxBytes = MAX_FRAME_BYTES, onOverflow = () => {} } = {}) {
  let buf = "";
  let dead = false;
  return (chunk) => {
    if (dead) return;
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
    if (Buffer.byteLength(buf) > maxBytes) {
      dead = true;
      buf = "";
      onOverflow();
    }
  };
}

function writeFrame(sock, obj) {
  if (sock.destroyed || !sock.writable) return;
  sock.write(`${JSON.stringify(obj)}\n`);
}

function brokerError(id, code, message, hint) {
  return { v: 1, id: id ?? null, ok: false, error: { code, message, retryable: false, ...(hint ? { hint } : {}) }, meta: {} };
}

function probeSocket(socketPath, timeoutMs = 500) {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
    const done = (alive) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

export function createBroker({ socketPath = defaultSocketPath(), post, log = () => {} }) {
  const sessions = new Map();
  const pending = new Map();
  let server = null;
  let seq = 0;

  function forward(session, request, kind, clientCallId) {
    const callId = `b${++seq}`;
    const msg = {
      type: "bridge.call",
      sessionId: session.sessionId,
      callId,
      token: session.token,
      agentName: session.agentName,
      request,
    };
    if (Buffer.byteLength(JSON.stringify(msg)) > MAX_PORT_MESSAGE_BYTES) {
      const response = brokerError(request?.id, "BAD_REQUEST", "请求超过 1 MB（Chrome Native Messaging 上限）。", "大段 HTML 先写到本机文件，再用 inbox htmlFile 或分段发送。");
      deliver(session, kind, clientCallId, response);
      return;
    }
    pending.set(callId, { sessionId: session.sessionId, kind, clientCallId });
    post(msg);
  }

  function deliver(session, kind, clientCallId, response) {
    if (kind === "hello") {
      if (response?.ok) {
        session.welcomed = true;
        writeFrame(session.sock, {
          type: "welcome",
          sessionId: session.sessionId,
          protocol: SOCKET_PROTOCOL,
          tools: response.result?.tools || [],
          agent: response.result?.agent || null,
        });
      } else {
        writeFrame(session.sock, { type: "error", error: response?.error || { code: "UNAUTHORIZED", message: "握手失败" } });
        session.sock.end();
      }
      return;
    }
    writeFrame(session.sock, { type: "result", callId: clientCallId ?? null, response });
  }

  function handleFrame(session, line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      writeFrame(session.sock, { type: "error", error: { code: "BAD_REQUEST", message: "帧不是合法 JSON。" } });
      return;
    }
    if (frame?.type === "hello") {
      if (session.helloSent) {
        writeFrame(session.sock, { type: "error", error: { code: "BAD_REQUEST", message: "重复 hello。" } });
        return;
      }
      session.helloSent = true;
      session.token = String(frame.token || "");
      session.agentName = String(frame.agentName || "").slice(0, MAX_AGENT_NAME);
      forward(session, { id: `hello-${session.sessionId}`, tool: "list_tools", args: {} }, "hello");
      return;
    }
    if (frame?.type === "call") {
      if (!session.welcomed) {
        const response = brokerError(frame.request?.id, "UNAUTHORIZED", "先发 hello 并等到 welcome。");
        writeFrame(session.sock, { type: "result", callId: frame.callId ?? null, response });
        return;
      }
      forward(session, frame.request, "call", frame.callId);
      return;
    }
    if (frame?.type === "ping") {
      writeFrame(session.sock, { type: "pong" });
      return;
    }
    writeFrame(session.sock, { type: "error", error: { code: "BAD_REQUEST", message: `未知帧类型：${frame?.type ?? "(空)"}` } });
  }

  function onConnection(sock) {
    const session = { sessionId: crypto.randomUUID(), sock, token: "", agentName: "", helloSent: false, welcomed: false };
    sessions.set(session.sessionId, session);
    const feed = createLineReader((line) => handleFrame(session, line), {
      onOverflow: () => {
        writeFrame(sock, { type: "error", error: { code: "BAD_REQUEST", message: "单帧过大。" } });
        sock.destroy();
      },
    });
    sock.on("data", feed);
    sock.on("error", () => {});
    sock.on("close", () => {
      sessions.delete(session.sessionId);
      for (const [id, p] of pending) if (p.sessionId === session.sessionId) pending.delete(id);
      if (session.helloSent) {
        try {
          post({ type: "bridge.session.closed", sessionId: session.sessionId });
        } catch {
          /* Chrome 端口已断开 */
        }
      }
    });
  }

  return {
    socketPath,
    async start() {
      if (!isPipe(socketPath)) {
        fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
        if (fs.existsSync(socketPath)) {
          if (await probeSocket(socketPath)) {
            throw new Error(`已有 PageLens 网关在 ${socketPath} 上运行（另一个 Chrome / profile 已启用网关？）`);
          }
          fs.unlinkSync(socketPath);
        }
      }
      server = net.createServer(onConnection);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      if (!isPipe(socketPath)) fs.chmodSync(socketPath, 0o600);
      log(`broker listening on ${socketPath}`);
    },
    handleExtensionMessage(msg) {
      if (msg?.type === "bridge.result") {
        const p = pending.get(msg.callId);
        if (!p) return;
        pending.delete(msg.callId);
        const session = sessions.get(p.sessionId);
        if (session) deliver(session, p.kind, p.clientCallId, msg.response);
        return;
      }
      if (msg?.type === "bridge.event") {
        const targets = msg.sessionId ? [sessions.get(msg.sessionId)].filter(Boolean) : [...sessions.values()];
        for (const s of targets) if (s.welcomed) writeFrame(s.sock, { type: "event", event: msg.event });
      }
    },
    sessionCount: () => sessions.size,
    async close() {
      for (const s of sessions.values()) s.sock.destroy();
      sessions.clear();
      pending.clear();
      if (server) await new Promise((resolve) => server.close(() => resolve()));
      server = null;
      if (!isPipe(socketPath)) {
        try {
          fs.unlinkSync(socketPath);
        } catch {
          /* already gone */
        }
      }
    },
  };
}

export class GatewayUnavailableError extends Error {
  constructor(socketPath, cause) {
    super(
      `PageLens 网关未运行（${socketPath}）。请确认：Chrome 已打开；PageLens 设置 → 外部 Agent 已启用网关且至少有一个有效 token；` +
        `Native Host 已登记（node native/install-native-host.mjs）。${cause ? `（${cause}）` : ""}`,
    );
    this.name = "GatewayUnavailableError";
    this.code = "GATEWAY_UNAVAILABLE";
  }
}

/** 连 socket → hello → welcome。返回 { sessionId, tools, agent, call(request), close(), closed }。 */
export function connectGateway({ socketPath = defaultSocketPath(), token, agentName = "", timeoutMs = 5000, onEvent = () => {}, onClose = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    const pending = new Map();
    let seq = 0;
    let client = null;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new GatewayUnavailableError(socketPath, "握手超时：扩展没有响应")), timeoutMs);

    const feed = createLineReader((line) => {
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      if (!client) {
        if (frame.type === "welcome") {
          settled = true;
          clearTimeout(timer);
          client = {
            sessionId: frame.sessionId,
            protocol: frame.protocol,
            tools: frame.tools || [],
            agent: frame.agent || null,
            closed: false,
            call(request, { timeoutMs: callTimeout = 130_000 } = {}) {
              if (client.closed) return Promise.reject(new GatewayUnavailableError(socketPath, "连接已断开"));
              const callId = `c${++seq}`;
              return new Promise((res, rej) => {
                const t = setTimeout(() => {
                  pending.delete(callId);
                  rej(new Error(`调用 ${request?.tool} 超时`));
                }, callTimeout);
                pending.set(callId, { res, rej, t });
                writeFrame(sock, { type: "call", callId, request });
              });
            },
            close() {
              sock.end();
            },
          };
          resolve(client);
        } else if (frame.type === "error") {
          const err = new Error(frame.error?.message || "网关拒绝连接");
          err.code = frame.error?.code || "UNAUTHORIZED";
          err.hint = frame.error?.hint;
          fail(err);
        }
        return;
      }
      if (frame.type === "result") {
        const p = pending.get(frame.callId);
        if (!p) return;
        pending.delete(frame.callId);
        clearTimeout(p.t);
        p.res(frame.response);
      } else if (frame.type === "event") {
        onEvent(frame.event);
      }
    });

    sock.on("connect", () => writeFrame(sock, { type: "hello", token: String(token || ""), agentName: String(agentName || "") }));
    sock.on("data", feed);
    sock.on("error", (err) => {
      if (!client) fail(new GatewayUnavailableError(socketPath, err.code || err.message));
    });
    sock.on("close", () => {
      if (!client) {
        fail(new GatewayUnavailableError(socketPath, "连接被关闭"));
        return;
      }
      client.closed = true;
      for (const p of pending.values()) {
        clearTimeout(p.t);
        p.rej(new GatewayUnavailableError(socketPath, "连接已断开"));
      }
      pending.clear();
      onClose();
    });
  });
}

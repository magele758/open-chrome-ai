/**
 * 与 Native Host 的长连接（chrome.runtime.connectNative）。host 收到 broker.start 后在
 * ~/.pagelens/bridge.sock 上监听，把外部 Agent 的调用以 bridge.call 转进来；端口断开 host 即退出。
 * 打开的 native port 让 MV3 Service Worker 保持存活；断开后按指数退避重连。
 * 一次性请求（ping / exec / fs）仍走 native-host.js 的 nativeSend。
 * 事件：bridge.events 的推送出口接到当前 port（{type:"bridge.event", sessionId, event}）；
 * host 报 bridge.session.closed 或 port 断开时清掉对应会话的订阅与标签租约。
 */

import { NATIVE_HOST_NAME, describeNativeError } from "./native-host.js";
import { errorResponse } from "./bridge/protocol.js";

export const GATEWAY_PROTOCOL = 2;
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 60_000;

export function reconnectDelay(attempt, base = RECONNECT_BASE_MS, max = RECONNECT_MAX_MS) {
  return Math.min(max, base * 2 ** Math.max(0, attempt));
}

export function createNativeGateway({
  bridge,
  connect = (name) => chrome.runtime.connectNative(name),
  lastError = () => globalThis.chrome?.runtime?.lastError?.message || "",
  onStatus = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  now = () => Date.now(),
  extensionVersion = () => globalThis.chrome?.runtime?.getManifest?.().version ?? null,
  extensionId = () => globalThis.chrome?.runtime?.id ?? "",
  hostName = NATIVE_HOST_NAME,
} = {}) {
  let port = null;
  let timer = null;
  let attempt = 0;
  let running = false;
  let status = { state: "stopped", at: now() };

  function setStatus(next) {
    status = { ...next, at: now() };
    try {
      onStatus(status);
    } catch {
      /* status sink must not break the port */
    }
  }

  function schedule(reason) {
    if (!running || timer) return;
    const delay = reconnectDelay(attempt);
    attempt += 1;
    setStatus({ state: "retrying", error: reason || null, retryInMs: delay, attempt });
    timer = setTimer(() => {
      timer = null;
      open();
    }, delay);
  }

  function pushEvent(sessionId, event) {
    if (!port || status.state !== "connected") return;
    try {
      port.postMessage({ type: "bridge.event", sessionId, event });
    } catch {
      /* port closing */
    }
  }
  bridge?.events?.setSink?.(pushEvent);

  function sessionsGone() {
    try {
      bridge?.closeAllSessions?.();
    } catch {
      /* bridge without session state */
    }
  }

  function drop(p) {
    if (port !== p) return;
    port = null;
    sessionsGone();
    try {
      p.disconnect();
    } catch {
      /* already gone */
    }
  }

  async function dispatch(p, msg) {
    let response;
    try {
      response = await bridge.call(msg.request, {
        session: { token: msg.token, sessionId: msg.sessionId, agentName: msg.agentName },
      });
    } catch (err) {
      response = errorResponse(msg.request?.id, err);
    }
    if (port !== p) return;
    try {
      p.postMessage({ type: "bridge.result", sessionId: msg.sessionId ?? null, callId: msg.callId ?? null, response });
    } catch {
      /* port closed while the call ran */
    }
  }

  function handle(p, msg) {
    if (port !== p || !msg || typeof msg !== "object") return;
    if (msg.type === "broker.ready") {
      attempt = 0;
      setStatus({ state: "connected", socketPath: msg.socketPath || null, hostVersion: msg.version || null });
      return;
    }
    if (msg.type === "broker.error") {
      drop(p);
      schedule(String(msg.error || "broker 启动失败"));
      return;
    }
    if (msg.type === "bridge.call") {
      dispatch(p, msg);
      return;
    }
    if (msg.type === "bridge.session.closed") {
      bridge?.closeSession?.(String(msg.sessionId || ""));
      return;
    }
    if (!msg.type && msg.ok === false && status.state === "connecting") {
      drop(p);
      schedule(`Native Host 不支持网关（${msg.error || "未知 op"}）：请更新仓库后重新运行 node native/install-native-host.mjs`);
    }
  }

  function open() {
    if (!running || port) return;
    let p;
    try {
      p = connect(hostName);
    } catch (err) {
      schedule(describeNativeError(err, extensionId()));
      return;
    }
    port = p;
    setStatus({ state: "connecting" });
    p.onMessage.addListener((msg) => handle(p, msg));
    p.onDisconnect.addListener(() => {
      const reason = lastError();
      if (port !== p) return;
      port = null;
      sessionsGone();
      schedule(reason ? describeNativeError(new Error(reason), extensionId()) : "Native Host 已断开");
    });
    try {
      p.postMessage({ type: "broker.start", protocol: GATEWAY_PROTOCOL, extensionVersion: extensionVersion() });
    } catch (err) {
      drop(p);
      schedule(err?.message || String(err));
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      attempt = 0;
      open();
    },
    stop() {
      running = false;
      if (timer) clearTimer(timer);
      timer = null;
      if (port) drop(port);
      setStatus({ state: "stopped" });
    },
    /** 立刻重试（不等退避），例如用户在设置页点了“重连”。 */
    kick() {
      if (!running || port) return;
      if (timer) clearTimer(timer);
      timer = null;
      open();
    },
    isRunning: () => running,
    isConnected: () => Boolean(port) && status.state === "connected",
    status: () => status,
  };
}

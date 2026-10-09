/**
 * SW 侧网关生命周期：agentGatewayEnabled 打开且至少有一个有效 token 时保持 connectNative 长连接；
 * 设置或 token 变化即同步；每分钟 alarm 兜底（SW 被回收后由 alarm 唤醒重连）。
 */

import { loadSettings } from "../storage.js";
import { createNativeGateway } from "../native-port.js";
import { hasActiveToken } from "./auth.js";
import { TOKENS_KEY, loadAgentTokens } from "./token-store.js";
import { getAuditLog } from "./audit.js";

export const GATEWAY_ALARM = "pagelens-agent-gateway";
export const GATEWAY_STATUS_KEY = "agentGatewayStatus";

export function shouldRunGateway(settings, tokens, now = Date.now()) {
  return settings?.agentGatewayEnabled === true && hasActiveToken(tokens, now);
}

let installed = null;

export function installAgentGateway(bridge) {
  if (installed) return installed;
  const gateway = createNativeGateway({
    bridge,
    onStatus: (status) => {
      chrome.storage.session?.set({ [GATEWAY_STATUS_KEY]: status }).catch?.(() => {});
    },
  });

  async function sync() {
    const [settings, tokens] = await Promise.all([loadSettings(), loadAgentTokens()]);
    if (shouldRunGateway(settings, tokens)) {
      gateway.start();
      const existing = await chrome.alarms.get(GATEWAY_ALARM).catch(() => null);
      if (!existing) await chrome.alarms.create(GATEWAY_ALARM, { periodInMinutes: 1 });
      return { running: true };
    }
    gateway.stop();
    await chrome.alarms.clear(GATEWAY_ALARM).catch(() => {});
    return { running: false };
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== GATEWAY_ALARM) return;
    sync()
      .then(() => gateway.kick())
      .catch(() => {});
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(changes.settings || changes[TOKENS_KEY])) return;
    sync().catch(() => {});
  });
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender?.id !== chrome.runtime.id) return false;
    const type = String(msg?.type || "");
    if (type === "pl.agentGateway.status") {
      sendResponse({ ok: true, running: gateway.isRunning(), status: gateway.status() });
      return false;
    }
    if (type === "pl.agentGateway.reconnect") {
      sync()
        .then(() => {
          gateway.kick();
          sendResponse({ ok: true, running: gateway.isRunning(), status: gateway.status() });
        })
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }
    if (type === "pl.agentAudit.list") {
      getAuditLog()
        .list({ limit: msg.limit || 2000 })
        .then((entries) => sendResponse({ ok: true, entries }))
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }
    if (type === "pl.agentAudit.clear") {
      getAuditLog()
        .clear()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }
    return false;
  });

  sync().catch(() => {});
  installed = { gateway, sync };
  return installed;
}

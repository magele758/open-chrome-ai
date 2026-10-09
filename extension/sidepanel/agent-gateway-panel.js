/**
 * 设置 → 外部 Agent：网关开关、token 新建/吊销、审计查看/导出。
 * token 直接读写 chrome.storage.local.agentTokens（不进 settings）；网关状态与审计由 SW 提供。
 */

import { SCOPE_LABELS, SCOPE_PRESETS, hasActiveToken, tokenFileName } from "../lib/bridge/auth.js";
import { DEFAULT_ALLOWED_ORIGINS } from "../lib/bridge/policy.js";
import { TOKENS_KEY, addAgentToken, listAgentTokens, loadAgentTokens, removeAgentToken, revokeAgentToken } from "../lib/bridge/token-store.js";
import { GATEWAY_STATUS_KEY } from "../lib/bridge/gateway.js";
import { ensureOptionalAccess } from "../lib/optional-permissions.js";
import { loadSettings, saveSettings } from "../lib/storage.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const STATE_TEXT = {
  stopped: "未运行",
  connecting: "正在连接 Native Host…",
  connected: "运行中",
  retrying: "连接失败，稍后重试",
};

const TOKEN_STATE_TEXT = { active: "有效", revoked: "已吊销", expired: "已过期" };

export function describeGatewayStatus(status, enabled) {
  if (!enabled) return { text: "未启用", tone: "" };
  const s = status || { state: "stopped" };
  if (s.state === "connected") return { text: `运行中 · ${s.socketPath || "socket"}`, tone: "ok" };
  if (s.state === "retrying") {
    const secs = s.retryInMs ? `，${Math.round(s.retryInMs / 1000)}s 后重试` : "";
    return { text: `${s.error || "连接失败"}${secs}`, tone: "bad" };
  }
  return { text: STATE_TEXT[s.state] || s.state, tone: "" };
}

export function setupCommands(name, extensionId = "") {
  const slug = tokenFileName(name);
  return [
    "# 在仓库根目录执行。首次使用先登记 Native Host：",
    `node native/install-native-host.mjs${extensionId ? ` --extension-id ${extensionId}` : ""}`,
    "# 保存 token 到 ~/.pagelens/agents/" + slug + ".token（0600；运行后粘贴 token 回车）",
    `node native/install-native-host.mjs --save-token ${slug}`,
    "# 打印 Cursor / Claude Code 的 MCP 配置（加 --write-cursor 直接合并进 ~/.cursor/mcp.json）",
    `node native/install-native-host.mjs --mcp-config ${slug}`,
  ].join("\n");
}

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatAuditLine(e) {
  const args = JSON.stringify(e.argsSummary || {});
  const trust = e.confirmed ? " {已批准}" : e.optOut ? ` {免清单:${e.irreversible || "?"}}` : "";
  return `${fmtTime(e.ts)}  ${e.ok ? "ok " : "ERR"} ${e.agent} · ${e.tool}${e.origin ? ` @ ${e.origin}` : ""}${e.code ? ` [${e.code}]` : ""}${trust}  ${args.length > 160 ? `${args.slice(0, 160)}…` : args}`;
}

export function createAgentGatewayPanel({ root, copyText, onGatewayChanged = () => {} }) {
  const $ = (id) => root.querySelector(`#${id}`);
  if (!$("block-agent-gateway")) return null;
  let enabled = false;
  let status = null;
  let lastToken = "";
  let lastName = "";

  const setStatus = (id, text, tone = "") => {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("ok", tone === "ok");
    el.classList.toggle("bad", tone === "bad");
  };

  function paintGateway() {
    $("agent-gateway").checked = enabled;
    const d = describeGatewayStatus(status, enabled);
    setStatus("agent-gateway-status", d.text, d.tone);
    $("settings-state-agents").textContent = enabled ? (status?.state === "connected" ? "运行中" : "已启用") : "未启用";
  }

  function paintScopes() {
    const preset = $("agent-token-preset").value;
    $("agent-token-scopes").textContent = (SCOPE_PRESETS[preset] || []).map((s) => `${s}（${SCOPE_LABELS[s]}）`).join("、");
  }

  async function paintTokens() {
    const list = await listAgentTokens();
    const ul = $("agent-token-list");
    ul.replaceChildren();
    if (!list.length) {
      const li = document.createElement("li");
      li.textContent = "还没有 token。";
      ul.append(li);
    }
    for (const t of list.slice().reverse()) {
      const li = document.createElement("li");
      li.classList.toggle("inactive", t.state !== "active");
      const info = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = `${t.name} · ${TOKEN_STATE_TEXT[t.state] || t.state}`;
      const meta = document.createElement("small");
      meta.textContent = `scope：${t.scopes.join(", ") || "无"}\n网站：${t.origins.join(", ") || "无"}\n出站白名单：${t.egress?.join(", ") || "无"}${t.skipIrreversible ? "\n⚠️ 免不可逆清单确认" : ""}\n创建 ${fmtTime(t.createdAt)} · 过期 ${t.expiresAt ? fmtTime(t.expiresAt) : "永不"}`;
      meta.style.whiteSpace = "pre-line";
      info.append(title, meta);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "compact secondary";
      if (t.state === "active") {
        btn.textContent = "吊销";
        btn.addEventListener("click", async () => {
          if (!confirm(`吊销 token「${t.name}」？使用它的 Agent 下一次调用就会被拒绝。`)) return;
          await revokeAgentToken(t.id);
          await refresh();
        });
      } else {
        btn.textContent = "删除";
        btn.addEventListener("click", async () => {
          await removeAgentToken(t.id);
          await refresh();
        });
      }
      li.append(info, btn);
      ul.append(li);
    }
  }

  async function setEnabled(next) {
    const tokens = await loadAgentTokens();
    if (next && !hasActiveToken(tokens)) {
      $("agent-gateway").checked = false;
      setStatus("agent-gateway-status", "请先在下面创建一个 token。", "bad");
      return;
    }
    if (next) {
      const gate = await ensureOptionalAccess({ permission: "nativeMessaging", force: true });
      if (!gate.granted && !gate.skipped && !gate.required) {
        $("agent-gateway").checked = false;
        setStatus("agent-gateway-status", gate.message || "未授予本机助手权限。", "bad");
        return;
      }
    }
    const saved = await saveSettings({ ...(await loadSettings()), agentGatewayEnabled: next });
    enabled = saved.agentGatewayEnabled === true;
    onGatewayChanged(enabled);
    paintGateway();
  }

  async function refresh() {
    enabled = (await loadSettings()).agentGatewayEnabled === true;
    const got = await chrome.storage.session?.get(GATEWAY_STATUS_KEY).catch(() => ({}));
    status = got?.[GATEWAY_STATUS_KEY] || null;
    paintGateway();
    await paintTokens();
  }

  async function createToken() {
    const name = $("agent-token-name").value.trim();
    const preset = $("agent-token-preset").value;
    const origins = $("agent-token-origins").value.split(/[\s,]+/).filter(Boolean);
    const egress = $("agent-token-egress").value.split(/[\s,]+/).filter(Boolean);
    const skipIrreversible = $("agent-token-skip-irreversible").checked;
    const days = Number($("agent-token-expiry").value) || 0;
    if (!name) {
      setStatus("agent-token-status", "请填写名称。", "bad");
      return;
    }
    if (!origins.length) {
      setStatus("agent-token-status", "至少填一个网站（或 *）。", "bad");
      return;
    }
    if (skipIrreversible && !confirm(`让「${name}」跳过不可逆动作清单？它发起的发布、删除、上传、改设置等操作将不再等你批准。`)) return;
    try {
      const { token, info } = await addAgentToken({
        name,
        scopes: SCOPE_PRESETS[preset],
        origins,
        egress,
        skipIrreversible,
        expiresAt: days ? Date.now() + days * DAY_MS : null,
      });
      const dropped = origins.length - info.origins.length + egress.length - info.egress.length;
      lastToken = token;
      lastName = info.name;
      $("agent-token-value").textContent = token;
      $("agent-token-setup").textContent = setupCommands(info.name, chrome.runtime?.id || "");
      $("agent-token-reveal").hidden = false;
      $("agent-token-name").value = "";
      $("agent-token-egress").value = "";
      $("agent-token-skip-irreversible").checked = false;
      setStatus("agent-token-status", dropped ? `已创建；忽略了 ${dropped} 个无效网站。` : "已创建。", dropped ? "bad" : "ok");
      await refresh();
    } catch (err) {
      setStatus("agent-token-status", err?.message || String(err), "bad");
    }
  }

  async function fetchAudit(limit) {
    const res = await chrome.runtime.sendMessage({ type: "pl.agentAudit.list", limit });
    if (!res?.ok) throw new Error(res?.error || "读取审计失败");
    return res.entries || [];
  }

  $("agent-token-origins").value = DEFAULT_ALLOWED_ORIGINS.join("\n");
  paintScopes();
  $("agent-token-preset").addEventListener("change", paintScopes);
  $("agent-gateway").addEventListener("change", (e) => {
    setEnabled(e.target.checked).catch((err) => setStatus("agent-gateway-status", err?.message || String(err), "bad"));
  });
  $("btn-agent-gateway-reconnect").addEventListener("click", async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: "pl.agentGateway.reconnect" });
      status = res?.status || status;
      paintGateway();
    } catch (err) {
      setStatus("agent-gateway-status", err?.message || String(err), "bad");
    }
  });
  $("btn-agent-token-create").addEventListener("click", () => createToken());
  $("btn-agent-token-copy").addEventListener("click", async () => {
    await copyText(lastToken).catch(() => {});
    setStatus("agent-token-status", "已复制 token。", "ok");
  });
  $("btn-agent-token-copy-setup").addEventListener("click", async () => {
    await copyText(setupCommands(lastName, chrome.runtime?.id || "")).catch(() => {});
    setStatus("agent-token-status", "已复制配置命令。", "ok");
  });
  $("btn-agent-token-hide").addEventListener("click", () => {
    lastToken = "";
    $("agent-token-value").textContent = "";
    $("agent-token-reveal").hidden = true;
    setStatus("agent-token-status", "");
  });
  $("btn-agent-audit-view").addEventListener("click", async () => {
    try {
      const entries = await fetchAudit(50);
      const view = $("agent-audit-view");
      view.textContent = entries.length ? entries.map(formatAuditLine).join("\n") : "暂无记录。";
      view.hidden = false;
      setStatus("agent-audit-status", `${entries.length} 条`);
    } catch (err) {
      setStatus("agent-audit-status", err?.message || String(err), "bad");
    }
  });
  $("btn-agent-audit-export").addEventListener("click", async () => {
    try {
      const entries = await fetchAudit(2000);
      const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pagelens-agent-audit-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setStatus("agent-audit-status", `已导出 ${entries.length} 条`, "ok");
    } catch (err) {
      setStatus("agent-audit-status", err?.message || String(err), "bad");
    }
  });
  $("btn-agent-audit-clear").addEventListener("click", async () => {
    if (!confirm("清空全部外部 Agent 审计记录？")) return;
    await chrome.runtime.sendMessage({ type: "pl.agentAudit.clear" }).catch(() => {});
    $("agent-audit-view").textContent = "";
    setStatus("agent-audit-status", "已清空", "ok");
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes[GATEWAY_STATUS_KEY]) {
      status = changes[GATEWAY_STATUS_KEY].newValue || null;
      paintGateway();
    }
    if (area === "local" && (changes[TOKENS_KEY] || changes.settings)) refresh().catch(() => {});
  });

  refresh().catch(() => {});
  return { refresh };
}

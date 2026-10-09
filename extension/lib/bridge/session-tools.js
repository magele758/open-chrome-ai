/**
 * 只对网关会话开放的元工具：事件订阅 / 拉取、标签租约；以及 job_status 的返回形态。
 * 不需要额外 scope（tab_claim 例外：token 至少要能在标签上动手），见 docs/agent-interop.md §0.7。
 */

import { BridgeError, ERROR_CODES } from "./protocol.js";
import { requireScope, scopeAllows } from "./auth.js";
import { LEASE_GUARDED_SCOPES } from "./leases.js";

const metaParams = (properties, required = []) => ({ type: "object", properties, additionalProperties: false, required });
const EVENT_TYPES_PARAM = {
  type: "array",
  items: { type: "string" },
  description: "事件类型，如 tab.updated、navigation.completed、download.changed、dialog.opened、job.done；支持 tab.* / *；省略 = token 权限内的全部",
};

export const SESSION_META_TOOLS = Object.freeze([
  {
    name: "events_subscribe",
    description: "订阅浏览器事件（标签/导航/下载/对话框/任务进度）。只推送 token origin 范围内的事件；支持推送的客户端会收到通知，其他用 events_poll 拉取。",
    focus: "none",
    needsTab: false,
    parameters: metaParams({ types: EVENT_TYPES_PARAM }),
  },
  {
    name: "events_unsubscribe",
    description: "取消订阅；省略 types 取消全部。",
    focus: "none",
    needsTab: false,
    parameters: metaParams({ types: EVENT_TYPES_PARAM }),
  },
  {
    name: "events_poll",
    description: "拉取本会话缓冲的事件（每会话保留最近 200 条）。since 传上次返回的 next；dropped=true 表示中间有事件被挤掉。",
    focus: "none",
    needsTab: false,
    parameters: metaParams({
      since: { type: "integer", description: "只返回 seq 大于它的事件，默认 0" },
      max: { type: "integer", description: "默认 50，最大 200" },
    }),
  },
  {
    name: "tab_claim",
    description:
      "独占一个标签：其他 Agent 在它上面调用点击/输入/导航/JS 等会得到 TAB_LEASED（只读工具不受影响）。会话断开或标签关闭时自动释放；本会话 open_tab 打开的标签自动归本会话。",
    focus: "none",
    needsTab: false,
    parameters: metaParams({ tabId: { type: "integer" } }, ["tabId"]),
  },
  {
    name: "tab_release",
    description: "释放标签租约；省略 tabId 释放本会话持有的全部。",
    focus: "none",
    needsTab: false,
    parameters: metaParams({ tabId: { type: "integer" } }),
  },
]);

export const SESSION_META = new Set(SESSION_META_TOOLS.map((t) => t.name));

export function jobView(job) {
  if (job.status === "done") return { status: "done", tool: job.tool, response: job.response };
  if (job.status === "interrupted") {
    return {
      status: "interrupted",
      tool: job.tool,
      startedAt: job.startedAt,
      hint: "Service Worker 重启打断了这个任务，结果未知；先回读页面状态再决定是否重试（换新 id）。",
    };
  }
  return { status: "running", tool: job.tool, startedAt: job.startedAt };
}

/**
 * @param deps.authorizeTab (tabId, auth, settings) → tab（origin 校验）
 * @param deps.owner (auth) → { sessionId, agentId, agentName }
 */
export function createSessionMeta({ events, leases, authorizeTab, owner }) {
  return async function sessionMeta(tool, args, auth, settings) {
    if (!auth?.sessionId) {
      throw new BridgeError(ERROR_CODES.UNAUTHORIZED, `${tool} 只对网关会话（token）开放。`, { retryable: false });
    }
    switch (tool) {
      case "events_subscribe":
        return events.subscribe(auth, args.types);
      case "events_unsubscribe":
        return events.unsubscribe(auth.sessionId, args.types);
      case "events_poll":
        return events.poll(auth.sessionId, { since: args.since, max: args.max });
      case "tab_claim": {
        if (!LEASE_GUARDED_SCOPES.some((s) => scopeAllows(auth.record, s))) requireScope(auth.record, "page:act", "tab_claim");
        const tab = await authorizeTab(args.tabId, auth, settings);
        return leases.claim(tab.id, owner(auth));
      }
      case "tab_release":
        if (args.tabId == null) return { released: leases.releaseSession(auth.sessionId) };
        return { released: leases.release(args.tabId, auth.sessionId) ? [args.tabId] : [] };
      default:
        throw new BridgeError(ERROR_CODES.UNKNOWN_TOOL, `未知工具：${tool}`);
    }
  };
}

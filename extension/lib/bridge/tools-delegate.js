/**
 * 委托 bridge 工具（scope agent:delegate）：把高层任务交给扩展内 LLM Agent（在 SW 里跑），轮询进度与结果。
 * 任务管理见 agent/delegate.js；会话信息取 ctx.session（P1 网关注入：agentName / sessionId / tokenId / egress / skipIrreversible）。
 */

import { getDelegateManager } from "../agent/delegate.js";
import { normalizeDomain, platformDomains } from "../agent/trust/capsule.js";
import { BridgeError, ERROR_CODES } from "./protocol.js";

const CAPSULE_PROP = {
  type: "object",
  description:
    "显式意图胶囊（委托人授权范围）：{ actions?: [navigate|input|publish|send|download|upload|shell|write|clipboard|close|delete|settings|automation|purchase], origins?: [域名], urls?: [网址], platforms?: [wechat|zhihu|…], recipients?: [], paths?: [], commands?: [] }。省略时只从 prompt 原文抽取。",
};

const CODE_MAP = {
  BAD_ARGS: ERROR_CODES.BAD_ARGS,
  TASK_NOT_FOUND: ERROR_CODES.JOB_NOT_FOUND,
};

function toBridge(err) {
  if (err instanceof BridgeError) return err;
  const code = CODE_MAP[err?.code] || ERROR_CODES.TOOL_FAILED;
  return new BridgeError(code, String(err?.message || err), { retryable: err?.retryable === true, details: err?.code ? { reason: err.code } : undefined });
}

function sessionOf(ctx) {
  const s = ctx?.session;
  if (!s || typeof s !== "object") return null;
  return {
    agentName: s.agentName ? String(s.agentName) : "",
    sessionId: s.sessionId ? String(s.sessionId) : "",
    tokenId: s.tokenId ? String(s.tokenId) : "",
    egress: Array.isArray(s.egress) ? s.egress : [],
    skipIrreversible: s.skipIrreversible === true,
  };
}

function ownerOf(ctx) {
  const s = sessionOf(ctx);
  return s?.tokenId || s?.agentName || null;
}

/** 胶囊里的站点必须在调用方可访问的 origin 范围内（委托不能成为越权通道）；不在范围内的丢弃并回报 */
export function restrictCapsuleToCaller(capsule, isAllowed) {
  const allowedDomain = (d) => isAllowed(`https://${d}/`) || isAllowed(`http://${d}/`);
  const dropped = [];
  const origins = capsule.origins.filter((d) => {
    const ok = allowedDomain(d);
    if (!ok) dropped.push(d);
    return ok;
  });
  const urls = capsule.urls.filter((u) => {
    const ok = isAllowed(u);
    if (!ok) dropped.push(normalizeDomain(u) || u);
    return ok;
  });
  const platforms = capsule.platforms.filter((p) => platformDomains(p).some((d) => origins.includes(d)));
  return { capsule: { ...capsule, origins, urls, platforms }, dropped: [...new Set(dropped)] };
}

export function createDelegateTools(env, { obj, TAB_ID }) {
  const manager = () => {
    const m = env.delegate || getDelegateManager();
    if (!m) throw new BridgeError(ERROR_CODES.TOOL_FAILED, "委托任务未就绪（Service Worker 尚未安装委托模块）。", { retryable: true });
    return m;
  };
  const isAllowedFor = (ctx) => (url) => {
    try {
      ctx.authorizeUrl(url);
      return true;
    } catch {
      return false;
    }
  };

  return [
    {
      name: "run_agent_task",
      scope: "agent:delegate",
      description:
        "把高层任务交给 PageLens 内部 Agent 在后台执行（例如“总结这个视频并配音”），立即返回 taskId；用 agent_task_status 轮询步骤与结果。授权范围由 capsule（或 prompt 原文）决定：胶囊内动作自动执行，胶囊外的副作用返回 NEEDS_WIDER_AUTHORIZATION，不可逆动作进待批准队列（CONFIRMATION_REQUIRED + pendingId）。",
      parameters: obj(
        {
          prompt: { type: "string", description: "任务描述（委托人原话）" },
          capsule: CAPSULE_PROP,
          tabId: { ...TAB_ID, description: "任务标签；省略时用当前窗口的活动标签（需在可访问的 origin 内，否则不指定标签）" },
          maxSteps: { type: "integer", minimum: 1, maximum: 40, description: "模型轮次上限，默认 12" },
          model: { type: "string", description: "覆盖文本模型名（沿用设置里的服务地址与密钥）" },
        },
        ["prompt"],
      ),
      async execute(args, ctx) {
        let tab = null;
        if (args.tabId != null) {
          tab = await ctx.authorizeTab(args.tabId);
        } else {
          const [active] = await env.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
          if (active?.id) tab = await ctx.authorizeTab(active.id).catch(() => null);
        }
        const isAllowed = isAllowedFor(ctx);
        try {
          const task = await manager().start({
            prompt: args.prompt,
            capsule: args.capsule,
            tabId: tab?.id ?? null,
            sourceUrl: tab?.url || "",
            maxSteps: args.maxSteps,
            model: args.model,
            session: sessionOf(ctx),
            restrictCapsule: (c) => restrictCapsuleToCaller(c, isAllowed),
          });
          return {
            taskId: task.id,
            status: task.status,
            tabId: task.tabId,
            capsule: task.capsule,
            capsuleSource: task.capsuleSource,
            capsuleSummary: task.capsuleSummary,
            droppedOrigins: task.droppedOrigins,
            maxSteps: task.maxSteps,
          };
        } catch (err) {
          throw toBridge(err);
        }
      },
    },
    {
      name: "agent_task_status",
      scope: "agent:delegate",
      description:
        "委托任务状态：status = running | done | failed | needs_approval | cancelled；steps 为步骤（传 sinceStep 只取之后的新步骤，用于增量轮询）；answer 为最终回答；pending 为待用户批准的操作（approval: pending/approved/rejected）；denied 为被拦下需要扩大授权的操作。",
      parameters: obj(
        {
          taskId: { type: "string" },
          sinceStep: { type: "integer", minimum: 0, description: "只返回编号大于此值的步骤" },
        },
        ["taskId"],
      ),
      async execute(args, ctx) {
        try {
          return await manager().status(args.taskId, { sinceStep: args.sinceStep, owner: ownerOf(ctx) });
        } catch (err) {
          throw toBridge(err);
        }
      },
    },
    {
      name: "agent_task_cancel",
      scope: "agent:delegate",
      description: "取消正在运行的委托任务（已结束的任务原样返回，alreadyFinished=true）。",
      parameters: obj({ taskId: { type: "string" } }, ["taskId"]),
      async execute(args, ctx) {
        try {
          return await manager().cancel(args.taskId, { owner: ownerOf(ctx) });
        } catch (err) {
          throw toBridge(err);
        }
      },
    },
  ];
}

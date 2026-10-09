/** 文件 inbox 的纯逻辑：轮询间隔、Native Host 失败退避、标签白名单挑选、确认摘要。 */

import { isUrlAllowed } from "../bridge/policy.js";

/** Chrome 对打包安装的扩展把 alarm 周期钳到 ≥30s；解包加载不钳。 */
export const POLL_MINUTES_PACKAGED = 0.5;
export const POLL_MINUTES_UNPACKED = 0.1;

export const BACKOFF_BASE_MS = 60 * 1000;
export const BACKOFF_MAX_MS = 30 * 60 * 1000;

/** 会改动页面内容的动作：必须命中 origin 白名单并经用户确认。 */
export const PAGE_ACTIONS = Object.freeze(["paste_html", "wechat_fill_draft", "cose_publish"]);

export function needsConfirmation(action) {
  return PAGE_ACTIONS.includes(String(action || ""));
}

export function pollMinutesFor({ packaged }) {
  return packaged ? POLL_MINUTES_PACKAGED : POLL_MINUTES_UNPACKED;
}

/**
 * 轮询闸门：目录只在首次（或出错后）创建；Native Host 不可用时指数退避，避免每轮都拉起失败的进程。
 */
export function createPollGate({ now = () => Date.now() } = {}) {
  let dirsReady = false;
  let failures = 0;
  let nextAt = 0;
  return {
    canPoll: () => now() >= nextAt,
    retryInMs: () => Math.max(0, nextAt - now()),
    dirsReady: () => dirsReady,
    markDirsReady() {
      dirsReady = true;
    },
    onSuccess() {
      failures = 0;
      nextAt = 0;
    },
    onFailure() {
      dirsReady = false;
      failures += 1;
      nextAt = now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
    },
    reset() {
      dirsReady = false;
      failures = 0;
      nextAt = 0;
    },
  };
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return String(url || "");
  }
}

/**
 * 按 job 条件挑标签，只在白名单 origin 里选。
 * @returns {{ tab: object } | { error: string }}
 */
export function pickAllowedTab(tabs, spec, origins, isRestricted = () => false) {
  const needle = String(spec?.tabUrlIncludes || "").trim();
  const type77 = (t) => /[?&]type=77\b/.test(String(t.url || ""));
  const matched = (tabs || []).filter((t) => {
    const url = String(t.url || "");
    if (!url || isRestricted(url)) return false;
    if (spec?.requireHttps && !/^https:\/\//i.test(url)) return false;
    if (needle && !url.includes(needle)) return false;
    return true;
  });
  let candidates = matched.filter((t) => isUrlAllowed(t.url, origins));
  if (!candidates.length) {
    if (matched.length) {
      const blocked = [...new Set(matched.map((t) => originOf(t.url)))].join(", ");
      return { error: `匹配的标签 origin 不在白名单：${blocked}（在设置的 agentBridgeOrigins 里添加）` };
    }
    return {
      error: needle ? `no tab matching url includes "${needle}"` : "no tabUrlIncludes provided and no matching tab",
    };
  }
  if (spec?.preferType77) {
    const typed = candidates.filter(type77);
    if (typed.length) candidates = typed;
  }
  candidates = [...candidates].sort((a, b) => (b.id || 0) - (a.id || 0));
  return { tab: candidates[0] };
}

function stripTags(html) {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** 给确认弹窗看的摘要；不含完整正文。 */
export function confirmSummary(job, tab, { html = "", text = "", markdown = "" } = {}) {
  const body = text || stripTags(html) || markdown;
  return {
    jobId: String(job?.id || ""),
    action: String(job?.action || ""),
    title: String(job?.title || ""),
    platforms: Array.isArray(job?.platforms) ? job.platforms.map(String) : [],
    tabId: tab?.id ?? null,
    tabTitle: String(tab?.title || ""),
    origin: originOf(tab?.url),
    chars: body.length,
    preview: body.slice(0, 200),
  };
}

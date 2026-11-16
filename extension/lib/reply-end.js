/** Wall-clock end of a finished reply. Metrics win; older logs only stored an ISO timestamp. */
export function messageEndedAtMs(msg) {
  const fromMetrics = Number(msg?.metrics?.endedAt);
  if (Number.isFinite(fromMetrics) && fromMetrics > 0) return Math.round(fromMetrics);
  const fromLog = Date.parse(msg?.traceLog?.timestamp || "");
  if (Number.isFinite(fromLog) && fromLog > 0) return fromLog;
  return 0;
}

/** Month, day, and clock. Same fields as the quiet chat feed. */
export function formatReplyEndClock(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(n);
}

/** Last idle reply says the session ended. Earlier replies only say they ended. */
export function replyEndText(ms, sessionEnded) {
  const clock = formatReplyEndClock(ms);
  if (!clock) return "";
  return `${sessionEnded ? "会话结束" : "结束"} ${clock}`;
}

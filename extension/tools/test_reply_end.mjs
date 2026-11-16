import { formatReplyEndClock, messageEndedAtMs, replyEndText } from "../lib/reply-end.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const ms = Date.parse("2026-11-12T00:41:00.000Z");
const clock = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
}).format(ms);

assert(formatReplyEndClock(ms) === clock, "clock uses month, day, and 24-hour time");
assert(formatReplyEndClock(0) === "", "missing time stays blank");
assert(formatReplyEndClock("nope") === "", "bad time stays blank");
assert(replyEndText(ms, true) === `会话结束 ${clock}`, "the last idle reply says the session ended");
assert(replyEndText(ms, false) === `结束 ${clock}`, "an earlier reply only says it ended");
assert(messageEndedAtMs({ metrics: { endedAt: ms } }) === ms, "metrics endedAt wins");
assert(
  messageEndedAtMs({ metrics: { endedAt: ms }, traceLog: { timestamp: "2020-01-01T00:00:00.000Z" } }) === ms,
  "metrics beat the older log timestamp",
);
assert(
  messageEndedAtMs({ traceLog: { timestamp: "2026-11-12T00:41:00.000Z" } }) === ms,
  "older replies fall back to the trace timestamp",
);
assert(messageEndedAtMs({}) === 0, "a reply without a clock does not invent one");

console.log("reply-end ok");

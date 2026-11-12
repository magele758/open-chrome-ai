/** What a generating reply is doing, and how fast visible text is arriving. */

const SAMPLE_GAP_MS = 400;
const RATE_WINDOW_MS = 2500;
const MIN_RATE_SPAN_S = 0.25;
const SHORT_ELAPSED_MS = 10_000;

const PHASE_LABEL = {
  waiting: "等待模型",
  thinking: "正在思考",
  writing: "正在写",
};

export function runningToolName(trace) {
  const list = Array.isArray(trace) ? trace : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i];
    if (!item || item.kind === "meta") continue;
    if (item.status === "running") return String(item.name || "工具");
  }
  return "";
}

export function noteLiveSample(samples, chars, nowMs) {
  const list = Array.isArray(samples) ? samples : [];
  const count = Math.max(0, Number(chars) || 0);
  const now = Number(nowMs) || 0;
  const last = list[list.length - 1];
  if (last && last.chars === count && now - last.at < SAMPLE_GAP_MS) return list;
  const cutoff = now - 8000;
  const next = list.filter((sample) => sample.at >= cutoff);
  next.push({ at: now, chars: count });
  return next;
}

export function charsPerSecond(samples, nowMs) {
  const list = Array.isArray(samples) ? samples : [];
  const now = Number(nowMs) || 0;
  const recent = list.filter((sample) => now - sample.at <= RATE_WINDOW_MS);
  const span = recent.length >= 2 ? recent : list;
  if (span.length < 2) return null;
  const first = span[0];
  const last = span[span.length - 1];
  const dt = (last.at - first.at) / 1000;
  if (dt < MIN_RATE_SPAN_S) return null;
  const rate = (last.chars - first.chars) / dt;
  if (!Number.isFinite(rate) || rate < 0) return null;
  return Math.round(rate);
}

export function formatLiveElapsed(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "0.0s";
  if (n < SHORT_ELAPSED_MS) return `${(n / 1000).toFixed(1)}s`;
  const total = Math.round(n / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function liveLines({ phase, toolName, elapsedMs, chars, charsPerSec, showDots }) {
  const key = phase === "tool" || phase === "thinking" || phase === "writing" ? phase : "waiting";
  const rate = Number.isFinite(charsPerSec) ? charsPerSec : null;
  const count = Math.max(0, Number(chars) || 0);
  return {
    phaseKey: key,
    phase: key === "tool" ? `正在调用 ${toolName || "工具"}` : PHASE_LABEL[key],
    pace: rate == null ? formatLiveElapsed(elapsedMs) : `${rate} 字/秒`,
    elapsed: formatLiveElapsed(elapsedMs),
    speed: rate == null ? "还没有输出" : `${rate} 字/秒`,
    chars: `${count} 字`,
    toolName: toolName || "",
    showTool: key === "tool",
    showDots: Boolean(showDots),
  };
}

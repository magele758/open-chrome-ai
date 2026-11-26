/** Generation phase and Token telemetry for the current model turn. */

import { estimateTokens } from "../lib/openai.js";

const RATE_WINDOW_MS = 2500;
const MIN_RATE_SPAN_MS = 250;
const SHORT_ELAPSED_MS = 10_000;

const PHASE_LABEL = {
  waiting: "等待模型",
  thinking: "正在思考",
  writing: "正在写",
  calling: "正在生成工具调用",
};
const outputByMessage = new WeakMap();

export function runningToolName(trace) {
  const list = Array.isArray(trace) ? trace : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i];
    if (!item || item.kind === "meta") continue;
    if (item.status === "running") return String(item.name || "工具");
  }
  return "";
}

export function estimateLiveTokens({ answer, thinking }) {
  return estimateTokens(answer === "…" ? "" : answer) + estimateTokens(thinking);
}

export function startLiveModelTurn(msg) {
  const output = outputByMessage.get(msg) || { tokens: 0, estimated: false, lastRate: null };
  output.turn = { answer: "", thinking: "", callTokens: 0, tokens: 0, firstOutput: null, samples: [], phase: "waiting" };
  outputByMessage.set(msg, output);
}

export function noteLiveModelOutput(msg, kind, delta, now = Date.now()) {
  if (!outputByMessage.get(msg)?.turn) startLiveModelTurn(msg);
  const turn = outputByMessage.get(msg).turn;
  const previousTokens = turn.tokens;
  if (kind === "calling") turn.callTokens = Math.max(0, Number(delta) || 0);
  if (kind === "thinking") turn.thinking += delta;
  if (kind === "writing") turn.answer += delta;
  turn.phase = kind;
  turn.tokens = estimateLiveTokens(turn) + turn.callTokens;
  if (turn.tokens === previousTokens) return;
  turn.samples = noteLiveSample(turn.samples, turn.tokens, now);
  if (!turn.firstOutput || turn.tokens < previousTokens) {
    turn.firstOutput = turn.samples.at(-1) ?? null;
  }
}

export function finishLiveModelTurn(msg, { tokens, durationMs, estimated }) {
  if (!outputByMessage.get(msg)?.turn) startLiveModelTurn(msg);
  const output = outputByMessage.get(msg);
  const { turn } = output;
  const count = tokens > 0 ? tokens : turn.tokens;
  const isEstimate = Boolean(estimated || !(tokens > 0));
  if (count > 0) {
    output.tokens += count;
    output.estimated ||= isEstimate;
    const rate = sampleRate(turn.firstOutput, turn.samples.at(-1));
    if (rate != null) {
      output.lastRate = { rate, estimated: true, includesWait: false };
    } else if (durationMs > 0) {
      output.lastRate = { rate: count * 1000 / durationMs, estimated: isEstimate, includesWait: true };
    } else {
      output.lastRate = null;
    }
  }
  output.turn = null;
}

export function liveModelOutput(msg, now) {
  const output = outputByMessage.get(msg);
  if (!output) return null;
  const { turn } = output;
  return {
    phase: turn?.phase || "waiting",
    tokens: output.tokens + (turn?.tokens || 0),
    estimated: output.estimated || Boolean(turn?.tokens),
    tokensPerSec: tokensPerSecond(turn?.samples, now),
    lastRate: output.lastRate,
  };
}

export function noteLiveSample(samples, tokens, nowMs) {
  const list = Array.isArray(samples) ? samples : [];
  const count = Math.max(0, Number(tokens) || 0);
  if (!count) return [];
  const now = Number(nowMs) || 0;
  const last = list[list.length - 1];
  if (last && count < last.tokens) return [{ at: now, tokens: count }];
  if (last && last.tokens === count) return list;
  const cutoff = now - RATE_WINDOW_MS;
  const next = list.filter((sample) => sample.at >= cutoff);
  next.push({ at: now, tokens: count });
  return next;
}

export function tokensPerSecond(samples, nowMs) {
  const list = Array.isArray(samples) ? samples : [];
  const now = Number(nowMs) || 0;
  const span = list.filter((sample) => now - sample.at <= RATE_WINDOW_MS);
  return sampleRate(span[0], span.at(-1));
}

function sampleRate(first, last) {
  if (!first || !last) return null;
  const durationMs = last.at - first.at;
  if (durationMs < MIN_RATE_SPAN_MS) return null;
  const rate = (last.tokens - first.tokens) * 1000 / durationMs;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
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

function formatRate(rate, estimated) {
  if (!Number.isFinite(rate) || rate <= 0) return "";
  if (rate < 0.1) return "<0.1 Token/秒";
  return `${estimated ? "≈" : ""}${Number(rate.toFixed(1))} Token/秒`;
}

export function liveLines({ phase, toolName, elapsedMs, tokens, tokensPerSec, lastRate, estimated = true, showDots }) {
  const key = phase === "tool" || Object.hasOwn(PHASE_LABEL, phase) ? phase : "waiting";
  const active = key === "thinking" || key === "writing" || key === "calling";
  const speed = active ? formatRate(tokensPerSec, true) : "";
  const rate = formatRate(lastRate?.rate, lastRate?.estimated);
  const previousSpeed = rate ? `${lastRate.includesWait ? "上轮整轮平均" : "上轮生成"} ${rate}` : "";
  const count = Math.max(0, Number(tokens) || 0);
  const elapsed = formatLiveElapsed(elapsedMs);
  return {
    phaseKey: key,
    phase: key === "tool" ? `正在调用 ${toolName || "工具"}` : PHASE_LABEL[key],
    pace: speed || (previousSpeed ? `${elapsed} · ${previousSpeed}` : elapsed),
    elapsed,
    speed: speed || previousSpeed || (count ? "—" : "还没有输出"),
    tokens: `${count && estimated ? "≈" : ""}${count} Token`,
    toolName: toolName || "",
    showTool: key === "tool",
    showDots: Boolean(showDots),
  };
}

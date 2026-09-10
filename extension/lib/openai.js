function trimSlash(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

export function chatCompletionsUrl(baseUrl) {
  const raw = trimSlash(baseUrl);
  if (!raw) throw new Error("缺少 base_url");
  if (/\/chat\/completions$/i.test(raw)) return raw;
  return `${raw}/chat/completions`;
}

function headersFor(model) {
  const key = String(model?.apiKey || "").trim() || "local";
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
    "HTTP-Referer": "https://pagelens.local",
    "X-Title": "PageLens",
  };
  return headers;
}

export function normalizeContent(raw) {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw.map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (/thinking|thought|reasoning/i.test(String(part.type || ""))) return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    }).join("");
  }
  if (typeof raw === "object" && typeof raw.text === "string") return raw.text;
  return "";
}

export function messageText(json) {
  const choice = json?.choices?.[0] || {};
  const msg = choice.message || {};
  const primary = normalizeContent(msg.content ?? choice.delta?.content ?? choice.text ?? "");
  if (primary.trim()) return primary.trim();
  return normalizeContent(
    msg.reasoning_content ?? choice.delta?.reasoning_content ?? msg.reasoning ?? "",
  ).trim();
}

function parseSseDelta(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return data === "[DONE]" ? "[DONE]" : null;
  try {
    const json = JSON.parse(data);
    const choice = json.choices?.[0];
    const piece = choice?.delta?.content ?? choice?.message?.content
      ?? choice?.delta?.reasoning_content ?? choice?.message?.reasoning_content ?? "";
    return typeof piece === "string" ? piece : normalizeContent(piece);
  } catch {
    return null;
  }
}

function parseSseTurn(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  if (!data) return null;
  if (data === "[DONE]") return { done: true };
  try {
    const json = JSON.parse(data);
    const choice = json.choices?.[0] || {};
    return {
      content: normalizeContent(choice.delta?.content ?? choice.message?.content ?? choice.text ?? ""),
      reasoning: normalizeContent(
        choice.delta?.reasoning_content ?? choice.message?.reasoning_content
          ?? choice.delta?.reasoning ?? choice.message?.reasoning ?? "",
      ),
      toolCalls: Array.isArray(choice.delta?.tool_calls)
        ? choice.delta.tool_calls
        : (Array.isArray(choice.message?.tool_calls) ? choice.message.tool_calls : []),
      finishReason: choice.finish_reason || "",
    };
  } catch {
    return null;
  }
}

function mergeToolCallDeltas(bucket, deltas) {
  if (!Array.isArray(deltas)) return;
  for (const tc of deltas) {
    if (!tc || typeof tc !== "object") continue;
    // Missing indices still need to distinguish new calls from argument chunks.
    const known = tc.id ? bucket.findIndex((call) => call?.id === tc.id) : -1;
    const i = Number.isInteger(tc.index) ? tc.index
      : known >= 0 ? known
      : tc.id || tc.function?.name ? bucket.length
      : Math.max(0, bucket.length - 1);
    if (!bucket[i]) bucket[i] = { id: "", name: "", arguments: "" };
    if (tc.id) bucket[i].id = tc.id;
    const fn = tc.function || {};
    if (fn.name && fn.name !== bucket[i].name) bucket[i].name += fn.name;
    if (typeof fn.arguments === "string") bucket[i].arguments += fn.arguments;
    else if (fn.arguments && typeof fn.arguments === "object") {
      bucket[i].arguments = JSON.stringify(fn.arguments);
    }
  }
}

function finalizedToolCalls(bucket) {
  return (bucket || [])
    .filter((c) => c && c.name)
    .map((c, i) => ({
      id: c.id || `call_${i}`,
      name: c.name,
      arguments: c.arguments || "{}",
    }));
}

function parseCompletionJson(raw) {
  const text = String(raw || "").trim();
  if (!text.startsWith("{")) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readError(response) {
  const text = await response.text();
  let detail = text.slice(0, 400);
  try {
    const json = JSON.parse(text);
    detail = json.error?.message || json.message || json.msg || detail;
  } catch {
    /* keep text */
  }
  return `${response.status} ${detail}`.trim();
}

async function postChat(model, body, signal) {
  const response = await fetch(chatCompletionsUrl(model.baseUrl), {
    method: "POST",
    headers: headersFor(model),
    signal,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await readError(response));
  return response;
}

function chatBody(model, { messages, temperature, maxTokens, stream }) {
  const body = {
    model: String(model.model || "").trim(),
    stream: stream === true,
    temperature,
    messages: messages || [],
  };
  if (maxTokens) body.max_tokens = maxTokens;
  return body;
}

/**
 * Non-streaming chat completion for short jobs (live translation).
 * Thinking models can spend max_tokens on reasoning and return empty content;
 * retry with a larger budget, then the same streaming path as sidepanel chat.
 */
export async function completeChat(model, { messages, temperature = 0.2, maxTokens = 400, signal } = {}) {
  const once = async (tokens) => {
    const response = await postChat(model, chatBody(model, { messages, temperature, maxTokens: tokens, stream: false }), signal);
    return response.json();
  };
  let json = await once(maxTokens);
  let text = messageText(json);
  const finish = String(json.choices?.[0]?.finish_reason || "").toLowerCase();
  if (!text && maxTokens && (finish === "length" || finish === "max_tokens")) {
    json = await once(Math.max(8192, maxTokens * 8));
    text = messageText(json);
  }
  if (!text) {
    text = String(await streamChat(model, { messages, temperature, signal }, () => {}) || "").trim();
  }
  return text;
}

export async function testConnection(model) {
  const url = chatCompletionsUrl(model.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: headersFor(model),
      signal: controller.signal,
      body: JSON.stringify({
        model: model.model.trim(),
        stream: false,
        max_tokens: 8,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    if (!response.ok) throw new Error(await readError(response));
    const json = await response.json();
    const content = messageText(json);
    return { ok: true, ms: Date.now() - started, preview: content.slice(0, 80) };
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("连接超时（20s）");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} model
 * @param {{ messages: any[], jsonMode?: boolean }} input
 * @param {(delta: string) => void} onDelta
 */
export async function streamChat(model, input, onDelta) {
  const response = await postChat(model, chatBody(model, {
    messages: input.messages,
    temperature: input.temperature ?? 0.3,
    stream: true,
  }), input.signal);

  if (!response.body) {
    const json = await response.json();
    const content = messageText(json);
    if (content) onDelta(content);
    return content;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const delta = parseSseDelta(line);
      if (delta === "[DONE]") return full;
      if (typeof delta === "string" && delta) {
        full += delta;
        onDelta(delta);
      }
    }
  }
  if (buffer.trim()) {
    const delta = parseSseDelta(buffer);
    if (typeof delta === "string" && delta && delta !== "[DONE]") {
      full += delta;
      onDelta(delta);
    }
  }
  return full;
}

/**
 * One model turn with optional tools. Distill of ppeng ModelAdapter.runTurn.
 * @returns {{ content: string, toolCalls: Array<{id,name,arguments}>, finishReason: string }}
 */
export async function streamTurn(model, input, onTextDelta) {
  const url = chatCompletionsUrl(model.baseUrl);
  const body = {
    model: model.model.trim(),
    stream: true,
    temperature: 0.3,
    messages: input.messages,
  };
  if (input.tools?.length) {
    body.tools = input.tools;
    body.tool_choice = "auto";
  }
  const response = await fetch(url, {
    method: "POST",
    headers: headersFor(model),
    signal: input.signal,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await readError(response));

  let content = "";
  let reasoning = "";
  const toolBucket = [];
  let finishReason = "";
  let sawDone = false;

  const consumeEvent = (ev) => {
    if (!ev) return false;
    if (ev.done) {
      sawDone = true;
      return true;
    }
    if (ev.content) {
      content += ev.content;
      onTextDelta?.(ev.content);
    } else if (ev.reasoning) {
      // Same as streamChat: reasoning-only chunks must paint as they arrive.
      onTextDelta?.(ev.reasoning);
    }
    if (ev.reasoning) reasoning += ev.reasoning;
    if (ev.toolCalls?.length) mergeToolCallDeltas(toolBucket, ev.toolCalls);
    if (ev.finishReason) finishReason = ev.finishReason;
    return false;
  };

  const finish = () => {
    const toolCalls = finalizedToolCalls(toolBucket);
    if (!content && reasoning) content = reasoning;
    if (!finishReason) finishReason = toolCalls.length ? "tool_calls" : "stop";
    // Gemini OpenAI compat often reports finish_reason=stop on streamed tool calls.
    if (toolCalls.length && finishReason === "stop") finishReason = "tool_calls";
    return { content, toolCalls, finishReason };
  };

  if (!response.body) {
    const json = await response.json();
    const choice = json.choices?.[0] || {};
    content = messageText(json);
    if (content) onTextDelta?.(content);
    const calls = (choice.message?.tool_calls || []).map((c) => ({
      id: c.id,
      name: c.function?.name,
      arguments: c.function?.arguments || "{}",
    }));
    return { content, toolCalls: calls, finishReason: choice.finish_reason || (calls.length ? "tool_calls" : "stop") };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let rawAll = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    rawAll += chunk;
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (consumeEvent(parseSseTurn(line))) break;
    }
    // Same as streamChat: [DONE] ends the turn even if the socket stays open.
    if (sawDone) {
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
  }
  if (!sawDone && buffer.trim()) consumeEvent(parseSseTurn(buffer));

  const empty = !content && !reasoning && !finalizedToolCalls(toolBucket).length;
  if (empty) {
    const json = parseCompletionJson(rawAll + decoder.decode());
    if (json) {
      content = messageText(json);
      if (content) onTextDelta?.(content);
      const choice = json.choices?.[0] || {};
      const calls = (choice.message?.tool_calls || []).map((c) => ({
        id: c.id,
        name: c.function?.name,
        arguments: typeof c.function?.arguments === "string"
          ? c.function.arguments
          : JSON.stringify(c.function?.arguments || {}),
      })).filter((c) => c.name);
      return {
        content,
        toolCalls: calls,
        finishReason: choice.finish_reason || (calls.length ? "tool_calls" : "stop"),
      };
    }
  }

  return finish();
}

export function textUserContent(text) {
  return text;
}

export function multimodalUserContent(text, imageDataUrl) {
  const parts = [{ type: "text", text }];
  if (imageDataUrl) {
    parts.push({
      type: "image_url",
      image_url: { url: imageDataUrl },
    });
  }
  return parts;
}

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
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${model.apiKey.trim()}`,
    "HTTP-Referer": "https://pagelens.local",
    "X-Title": "PageLens",
  };
  return headers;
}

function parseSseDelta(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return data === "[DONE]" ? "[DONE]" : null;
  try {
    const json = JSON.parse(data);
    const choice = json.choices?.[0];
    return choice?.delta?.content ?? choice?.message?.content ?? "";
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
      content: choice.delta?.content ?? "",
      toolCalls: choice.delta?.tool_calls || choice.message?.tool_calls || [],
      finishReason: choice.finish_reason || json.choices?.[0]?.finish_reason || "",
    };
  } catch {
    return null;
  }
}

function mergeToolCallDeltas(bucket, deltas) {
  for (const tc of deltas || []) {
    const i = Number.isInteger(tc.index) ? tc.index : bucket.length;
    if (!bucket[i]) bucket[i] = { id: "", name: "", arguments: "" };
    if (tc.id) bucket[i].id = tc.id;
    const fn = tc.function || {};
    if (fn.name) bucket[i].name += fn.name;
    if (fn.arguments) bucket[i].arguments += fn.arguments;
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
    const content = json.choices?.[0]?.message?.content || "";
    return { ok: true, ms: Date.now() - started, preview: String(content).slice(0, 80) };
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
  const url = chatCompletionsUrl(model.baseUrl);
  const body = {
    model: model.model.trim(),
    stream: true,
    temperature: 0.3,
    messages: input.messages,
  };
  const response = await fetch(url, {
    method: "POST",
    headers: headersFor(model),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await readError(response));

  if (!response.body) {
    const json = await response.json();
    const content = json.choices?.[0]?.message?.content || "";
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
  const toolBucket = [];
  let finishReason = "";

  const consumeEvent = (ev) => {
    if (!ev || ev.done) return;
    if (ev.content) {
      content += ev.content;
      onTextDelta?.(ev.content);
    }
    if (ev.toolCalls?.length) mergeToolCallDeltas(toolBucket, ev.toolCalls);
    if (ev.finishReason) finishReason = ev.finishReason;
  };

  if (!response.body) {
    const json = await response.json();
    const choice = json.choices?.[0] || {};
    content = choice.message?.content || "";
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
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) consumeEvent(parseSseTurn(line));
  }
  if (buffer.trim()) consumeEvent(parseSseTurn(buffer));

  const toolCalls = toolBucket
    .filter((c) => c && c.name)
    .map((c, i) => ({
      id: c.id || `call_${i}`,
      name: c.name,
      arguments: c.arguments || "{}",
    }));
  if (!finishReason) finishReason = toolCalls.length ? "tool_calls" : "stop";
  return { content, toolCalls, finishReason };
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

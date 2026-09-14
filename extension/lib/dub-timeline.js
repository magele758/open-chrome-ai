/** Source time is immutable. Translation IDs retain a complete audit trail. */
export function validateAnalysis(analysis, duration) {
  if (!analysis || Math.abs(analysis.duration - duration) > .1 || !Array.isArray(analysis.spans)) throw new Error('声音时间轴与视频不一致');
  let cursor = 0;
  for (const s of analysis.spans) {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || Math.abs(s.start - cursor) > .05 || s.end <= s.start || s.end > duration + .05 || !['speech','unknown','silence','music'].includes(s.kind)) throw new Error('声音时间轴存在缺口');
    cursor = s.end;
  }
  if (Math.abs(cursor - duration) > .05) throw new Error('声音时间轴不完整');
  return analysis.spans;
}

export function recognitionWindows(spans, maxSeconds = 30) {
  const out = [];
  for (const span of spans) {
    if (['silence', 'music'].includes(span.kind)) continue;
    let cursor = span.start;
    while (cursor < span.end) {
      const prev = out.at(-1);
      const join = prev && Math.abs(prev.end - cursor) < .01 && prev.speaker === span.speaker && !prev.overlap && !span.overlap && prev.end - prev.start < maxSeconds;
      const end = Math.min(span.end, (join ? prev.start : cursor) + maxSeconds);
      if (join) prev.end = end;
      else out.push({ ...span, start: cursor, end });
      cursor = end;
    }
  }
  return out;
}

export function translationBatches(cues, maxChars = 5000, maxSeconds = 90) {
  const batches = [];
  for (const cue of cues) {
    let batch = batches.at(-1);
    if (!batch || batch.reduce((n, c) => n + c.src.length, 0) + cue.src.length > maxChars || cue.end - batch[0].start > maxSeconds) batches.push(batch = []);
    batch.push(cue);
  }
  return batches;
}

/**
 * Tolerant JSON parser for LLM translation responses.
 * Recovers from unescaped quotes, unescaped newlines, markdown blocks, thinking tags, trailing commas, etc.
 */
export function parseTolerantJson(raw) {
  if (typeof raw !== 'string') return raw;
  let text = String(raw).trim();

  // 1. Strip <think>...</think> or unclosed <think>...
  text = text.replace(/<(?:think|thought)>[\s\S]*?(?:<\/(?:think|thought)>|$)/gi, '').trim();

  // 2. Fast path: direct JSON.parse
  try {
    return JSON.parse(text);
  } catch (_) {}

  // 3. Extract from markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/i);
  if (fenceMatch && fenceMatch[1].trim()) {
    const inside = fenceMatch[1].trim();
    try {
      return JSON.parse(inside);
    } catch (_) {}
    text = inside;
  }

  // 4. Extract outermost JSON object or array
  const firstObj = text.indexOf('{');
  const firstArr = text.indexOf('[');
  let start = -1;
  if (firstObj !== -1 && firstArr !== -1) start = Math.min(firstObj, firstArr);
  else if (firstObj !== -1) start = firstObj;
  else if (firstArr !== -1) start = firstArr;

  if (start !== -1) {
    const lastObj = text.lastIndexOf('}');
    const lastArr = text.lastIndexOf(']');
    const end = Math.max(lastObj, lastArr);
    if (end > start) {
      const candidate = text.slice(start, end + 1);
      try {
        return JSON.parse(candidate);
      } catch (_) {}
      text = candidate;
    }
  }

  // 5. Repair unescaped quotes inside `"zh": "..."` or `"text": "..."` and unescaped newlines
  let repaired = text.replace(/"(?:zh|text|content)"\s*:\s*"([\s\S]*?)"\s*(?=\s*\}|\s*,\s*"(?:ids|id|zh|text|content|start|end|speaker)")/g, (m, content) => {
    const cleaned = content
      .replace(/\r\n|\r|\n/g, '\\n')
      .replace(/(?<!\\)"/g, '\\"');
    return `"zh":"${cleaned}"`;
  });

  // Repair trailing commas before } or ]
  repaired = repaired.replace(/,\s*([\}\]])/g, '$1');

  try {
    return JSON.parse(repaired);
  } catch (_) {}

  // 6. Regex line extraction fallback
  const regexLines = [];
  const itemRegex = /\{[^{}]*?"ids"\s*:\s*\[(.*?)\][^{}]*?"(?:zh|text|content)"\s*:\s*"([\s\S]*?)"[^{}]*?\}|\{[^{}]*?"(?:zh|text|content)"\s*:\s*"([\s\S]*?)"[^{}]*?"ids"\s*:\s*\[(.*?)\][^{}]*?\}/g;
  let match;
  while ((match = itemRegex.exec(text)) !== null) {
    const rawIds = match[1] ?? match[4];
    const zh = match[2] ?? match[3];
    const ids = [];
    const idRegex = /"([^"]+)"|'([^']+)'|(\d+)/g;
    let idMatch;
    while ((idMatch = idRegex.exec(rawIds)) !== null) {
      ids.push(idMatch[1] || idMatch[2] || idMatch[3]);
    }
    if (ids.length && zh) {
      regexLines.push({ ids, zh: zh.replace(/\\"/g, '"').trim() });
    }
  }
  if (regexLines.length > 0) {
    return { lines: regexLines };
  }

  throw new Error('口播稿格式不正确: 无法解析模型返回的 JSON');
}

export function validateDubTranslation(raw, cues) {
  const json = typeof raw === 'string' ? parseTolerantJson(raw) : raw;
  const rawLines = Array.isArray(json) ? json : (Array.isArray(json?.lines) ? json.lines : null);
  if (!rawLines) throw new Error('口播稿格式不正确');
  const lines = rawLines.map(l => ({
    ids: Array.isArray(l?.ids) ? l.ids : (l?.id !== undefined ? [String(l.id)] : []),
    zh: typeof l?.zh === 'string' ? l.zh : (typeof l?.text === 'string' ? l.text : (typeof l?.content === 'string' ? l.content : ''))
  }));
  const expected = cues.map(c => c.id);
  let actual = lines.flatMap(l => l.ids || []);

  if (cues.length === 1 && lines.length === 1) {
    lines[0].ids = [cues[0].id];
    actual = [cues[0].id];
  } else if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    if (lines.length === cues.length && lines.every(l => l.ids.length <= 1)) {
      lines.forEach((l, idx) => { l.ids = [cues[idx].id]; });
      actual = cues.map(c => c.id);
    }
  }

  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('口播稿遗漏、重复或调换了原文');
  const byId = new Map(cues.map(c => [c.id, c]));
  return lines.map(line => {
    if (!line.ids?.length || typeof line.zh !== 'string' || !line.zh.trim() || line.zh.length > 500) throw new Error('口播稿为空');
    const source = line.ids.map(id => byId.get(id));
    if (source.some(c => c.speaker !== source[0].speaker) || source.length > 1 && source.some(c => c.overlap)) throw new Error('口播稿合并了不同说话人');
    if (source.at(-1).end - source[0].start > 30.1 || source.slice(1).some((c, i) => c.start - source[i].end > .35)) throw new Error('口播段过长或跨越了原声空档');
    return { id: line.ids.join('+'), sourceIds: line.ids, start: source[0].start, end: source.at(-1).end,
      src: source.map(c => c.src).join(' '), zh: line.zh.trim(), speaker: source[0].speaker,
      overlap: source.some(c => c.overlap) };
  });
}

export function fitDub(line, audioSeconds, nextStart = line.end) {
  // Borrow at most 1.5 seconds of silence, never the next speaker's turn.
  const slotEnd = Math.max(line.end, Math.min(nextStart, line.end + 1.5));
  const available = Math.max(.2, slotEnd - line.start);
  const rate = Math.min(1.12, Math.max(1, audioSeconds / available));
  return { ...line, audioSeconds, rate, slotEnd, holdSeconds: Math.max(0, audioSeconds / rate - available) };
}

export function continuousReadySeconds(lines, ready, time, duration) {
  for (const line of lines) {
    if (line.end <= time) continue;
    if (!ready.has(line.id)) return Math.max(0, line.start - time);
  }
  return Math.max(0, duration - time);
}

export function voiceCandidates(spans) {
  const refs = new Map();
  for (const s of spans) {
    if (s.kind !== 'speech' || !s.speaker || s.overlap || Number(s.music) > .1 || s.end - s.start < 3) continue;
    const previous = refs.get(s.speaker);
    if (!previous || s.end - s.start > previous.end - previous.start) refs.set(s.speaker, s);
  }
  return refs;
}

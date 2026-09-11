/** Ordered, bounded text assembly. Audio chunks are not sentence boundaries. */
const DANGLING = /\b(?:a|an|the|to|of|for|with|from|about|because|although|if|unless|and|or|but|than|which|whose|my|your|our|their|is|are|was|were|be|been|being|not|only)\s*[.!?,;:]*$/i;
const EXPECTS_COMPLEMENT = /\b(?:(?:don['’]t|doesn['’]t|didn['’]t|do not|does not|did not)\s+(?:think|believe|know|mean)|(?:I|we|they|you)\s+(?:think|believe|know|mean))\s*[.!?,;:]*$/i;

export function unfinishedSpeech(text) {
  return DANGLING.test(text) || EXPECTS_COMPLEMENT.test(text) ||
    /\b(?:think|believe|know|mean)\s+that\s*[.!?,;:]*$/i.test(text) ||
    /\b(?:because|if|when|why|how|that|reason)\s+(?:I|we|they|he|she|it|you)\s*[.!?,;:]*$/i.test(text) ||
    /[,;:\-–—]\s*$/.test(text);
}

function sentenceEnds(text) {
  const ends = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if ('([{'.includes(text[i])) depth++;
    if (')]}'.includes(text[i])) depth = Math.max(0, depth - 1);
    if (!/[.!?。！？]/.test(text[i]) || depth) continue;
    if (text[i] === '.') {
      if (/\d/.test(text[i - 1] || '') && /\d/.test(text[i + 1] || '')) continue;
      const word = text.slice(0, i).match(/([A-Za-z.]+)$/)?.[1] || '';
      if (/^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|[A-Z])$/i.test(word)) continue;
      if (/[A-Za-z.]/.test(text[i + 1] || '')) continue;
    }
    let end = i + 1;
    while (/[.!?。！？"”’')\]]/.test(text[end] || '\0')) end++;
    if (end < text.length && !/\s/.test(text[end]) && !/[\u4e00-\u9fff]/.test(text[end])) continue;
    ends.push(end);
    i = end - 1;
  }
  return ends;
}

function isEquivalentChar(a, b) {
  if (a === b) return true;
  if (/[''ʼ`’]/.test(a) && /[''ʼ`’]/.test(b)) return true;
  if (/[""“”«»]/.test(a) && /[""“”«»]/.test(b)) return true;
  if (/[\-–—]/.test(a) && /[\-–—]/.test(b)) return true;
  return a.toLowerCase() === b.toLowerCase();
}

function alignPrefixToInput(candidatePrefix, input) {
  if (!candidatePrefix || !input) return null;
  let i = 0, j = 0;
  while (i < candidatePrefix.length && j < input.length) {
    const c1 = candidatePrefix[i], c2 = input[j];
    if (c1 === c2) { i++; j++; }
    else if (/\s/.test(c1) && !/\s/.test(c2)) { i++; }
    else if (!/\s/.test(c1) && /\s/.test(c2)) { j++; }
    else if (isEquivalentChar(c1, c2)) { i++; j++; }
    else { return null; }
  }
  if (i < candidatePrefix.length) {
    while (i < candidatePrefix.length && /\s/.test(candidatePrefix[i])) i++;
    if (i < candidatePrefix.length) return null;
  }
  return j;
}

export function validateSemanticTranslation(raw, input) {
  let text = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  let jsonCandidate = fenceMatch ? fenceMatch[1].trim() : text;
  const firstBrace = jsonCandidate.indexOf('{');
  const lastBrace = jsonCandidate.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    jsonCandidate = jsonCandidate.slice(firstBrace, lastBrace + 1);
  } else if (text !== jsonCandidate) {
    const tFirst = text.indexOf('{');
    const tLast = text.lastIndexOf('}');
    if (tFirst !== -1 && tLast > tFirst) {
      jsonCandidate = text.slice(tFirst, tLast + 1);
    }
  }
  let json;
  try {
    json = JSON.parse(jsonCandidate);
  } catch {
    throw new Error('语义分句返回格式不正确');
  }
  if (!json || typeof json.prefix !== 'string' || typeof json.suffix !== 'string' || typeof json.translation !== 'string') {
    throw new Error('语义分句返回格式不正确');
  }

  // Tolerant prefix alignment: resolve whitespace and punctuation drift without triggering retries
  if (json.prefix.trim()) {
    if (json.prefix + json.suffix !== input) {
      const norm = s => s.replace(/\s*([,.;:!?])\s*/g, '$1 ').replace(/\s+/g, ' ').trim();
      const inNorm = norm(input);
      if (norm(json.prefix + json.suffix) === inNorm || norm(json.prefix + ' ' + json.suffix) === inNorm) {
        const end = alignPrefixToInput(json.prefix.trim(), input);
        if (end !== null) {
          json.prefix = input.slice(0, end);
          json.suffix = input.slice(end);
        }
      } else {
        const firstWord = json.prefix.trim().split(/\s+/)[0];
        const idx = input.indexOf(firstWord);
        if (idx > 0 && idx < 80 && /^[\s\u4e00-\u9fff\p{P}]+$/u.test(input.slice(0, idx))) {
          const subInput = input.slice(idx);
          if (norm(json.prefix + json.suffix) === norm(subInput) || norm(json.prefix + ' ' + json.suffix) === norm(subInput)) {
            const end = alignPrefixToInput(json.prefix.trim(), subInput);
            if (end !== null) {
              json.prefix = input.slice(0, idx + end);
              json.suffix = input.slice(idx + end);
            }
          }
        }
      }
    }
  } else {
    json.prefix = '';
    json.suffix = input;
  }

  if (json.prefix + json.suffix !== input || (json.prefix && !json.prefix.trim()) ||
      Boolean(json.prefix) !== Boolean(json.translation.trim())) throw new Error('语义分句未完整保留原文');
  const n = json.prefix.length;
  if (n && n < input.length && /[\p{L}\p{N}]/u.test(input[n - 1]) && /[\p{L}\p{N}]/u.test(input[n])) {
    throw new Error('语义分句切断了单词');
  }
  if (json.prefix && unfinishedSpeech(json.prefix)) throw new Error('语义分句仍然是半句话');
  if (json.terms !== undefined && (!Array.isArray(json.terms) || json.terms.length > 20 ||
      json.terms.some(p => !p || typeof p.source !== 'string' || typeof p.target !== 'string'))) {
    throw new Error('术语返回格式不正确');
  }
  return json;
}

export function createSemanticBuffer({ maxSeconds = 15, maxChars = 1600, modelBoundaries = false, onEvent = () => {} } = {}) {
  let parts = [];
  let sequence = 0;
  let generation = 0;
  const text = () => parts.map(p => p.src).join(' ');
  const emit = (reason, length = text().length, forced = false) => {
    const src = text().slice(0, length).trim();
    if (!src) return null;
    let remaining = length;
    const used = [];
    while (parts.length && remaining > 0) {
      const part = parts[0];
      if (remaining >= part.src.length) {
        used.push(parts.shift());
        remaining -= part.src.length + 1;
      } else {
        const ratio = remaining / part.src.length;
        const end = part.start + (part.end - part.start) * ratio;
        used.push({ ...part, src: part.src.slice(0, remaining), end, timingQuality: 'estimated' });
        parts[0] = { ...part, src: part.src.slice(remaining).trim(), start: end, timingQuality: 'estimated' };
        remaining = 0;
      }
    }
    const first = used[0], last = used.at(-1);
    const sourceChunkIds = [...new Set(used.map(p => p.trace?.chunk).filter(v => v != null))];
    const utteranceId = `${generation}:${++sequence}`;
    const unit = { ...first, src, start: first.start, end: last.end,
      utteranceId, sourceChunkIds, boundaryReason: reason, forced,
      noDub: forced && reason !== 'clause-budget' && unfinishedSpeech(src),
      timingQuality: used.some(p => p.timingQuality === 'estimated') ? 'estimated' : 'segment',
      trace: { ...first.trace, utteranceId, sourceChunkIds, generation, boundaryReason: reason, forced },
    };
    onEvent({ type: 'semantic.commit', ...unit.trace, text: src });
    return unit;
  };
  const drain = () => {
    const units = [];
    while (parts.length) {
      const pending = text();
      const end = !modelBoundaries && sentenceEnds(pending).find(n => n <= maxChars && !unfinishedSpeech(pending.slice(0, n)));
      if (end) { units.push(emit('sentence', end)); continue; }
      const span = parts.at(-1).end - parts[0].start;
      if (span < maxSeconds && pending.length < maxChars) break;
      // Prefer a clause boundary at the budget; never silently truncate the tail.
      const candidates = [...pending.matchAll(/[,;:]\s+/g)].map(m => m.index + 1)
        .filter(n => n >= 40 && n <= maxChars && !unfinishedSpeech(pending.slice(0, n - 1)));
      const boundary = candidates.at(-1);
      let limit = boundary || Math.min(maxChars, pending.length);
      if (!boundary && limit < pending.length) {
        const space = pending.lastIndexOf(' ', limit);
        if (space > 0) limit = space;
      }
      units.push(emit(boundary ? 'clause-budget' : 'budget', limit, true));
    }
    return units.filter(Boolean);
  };
  return {
    get pendingText() { return text(); },
    commitPrefix(prefix) {
      if (!prefix || !text().startsWith(prefix)) throw new Error('语义分句与当前缓冲不一致');
      return emit('model', prefix.length);
    },
    reset(nextGeneration = generation + 1) { parts = []; sequence = 0; generation = nextGeneration; },
    gap() {
      if (parts.length) onEvent({ type: 'semantic.gap', generation, text: text() });
      parts = [];
    },
    push(item) {
      if (!item) { this.gap(); return []; }
      if (item.empty) {
        if (parts.length && (!unfinishedSpeech(text()) || item.end - parts[0].start >= maxSeconds)) return this.flush('silence');
        return [];
      }
      if (parts.length && item.start - parts.at(-1).end > 2) this.gap();
      // ASR often inserts a period after an obviously incomplete chunk.
      const last = parts.at(-1);
      if (last && unfinishedSpeech(last.src)) last.src = last.src.replace(/[.!?]+\s*$/, '');
      parts.push({ ...item, src: item.src.trim() });
      const units = drain();
      onEvent({ type: 'semantic.buffer', generation, text: text() });
      return units;
    },
    flush(reason = 'end') { return parts.length ? [emit(reason, text().length, true)].filter(Boolean) : []; },
  };
}

/** A deadline must release the queue even when a transport ignores abort. */
export async function withInterpretDeadline(operation, signal, timeoutMs = 20000) {
  const controller = new AbortController();
  let timer;
  let rejectCancel;
  const cancelled = new Promise((_, reject) => { rejectCancel = reject; });
  const abort = () => { controller.abort(); rejectCancel(signal?.reason || new DOMException('Cancelled', 'AbortError')); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  timer = setTimeout(() => {
    controller.abort();
    rejectCancel(new Error('同传请求超时，已跳过本段并继续。'));
  }, timeoutMs);
  try {
    return await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    }), cancelled]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

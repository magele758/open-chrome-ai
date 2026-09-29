/** Sentence-sized dub units. Callers fall back to cues when restoreSentenceBreaks returns null. */
import { unfinishedSpeech } from './interpret-semantic.js';

const DEFAULT_MAX_SECONDS = 20;
const DEFAULT_MAX_GAP = 0.35;
const SENTENCE_END = /[。！？；.!?]/;
const ABBREV = /^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|[A-Z])$/i;
const TRAILING_CLOSERS = /[\s"'“”‘’「」『』()（）\[\]【】》」』]+$/u;
const LATIN_WORD = /[A-Za-z0-9]/;

const BREAK_SYSTEM = [
  '你是断句器。用户文本是没有可靠句末标点的转写，不要改写、不要翻译、不要补标点。',
  '只返回 JSON：{"breaks":[字符下标]}。',
  '下标是在该位置之前切开，必须严格递增，落在空白或词边界，且不得超出原文。',
  '没有合适切点时返回 {"breaks":[]}。',
].join('');

export function budgetChars(start, end) {
  return Math.max(1, Math.round((Number(end) - Number(start)) * 3.8));
}

export function groupSentences(cues, options) {
  const maxSeconds = options?.maxSeconds ?? DEFAULT_MAX_SECONDS;
  const maxGap = options?.maxGap ?? DEFAULT_MAX_GAP;
  if (!Array.isArray(cues) || cues.length === 0) return [];
  const ordered = cues.map((cue, index) => ({ cue, index }))
    .sort((a, b) => a.cue.start - b.cue.start || a.cue.end - b.cue.end || a.index - b.index)
    .map(item => item.cue);

  const groups = [];
  let current = null;
  for (const cue of ordered) {
    if (current && canMerge(current, cue, maxSeconds, maxGap)) current.cues.push(cue);
    else {
      if (current) groups.push(toSentence(current.cues));
      current = { cues: [cue] };
    }
  }
  if (current) groups.push(toSentence(current.cues));
  return groups;
}

/**
 * Ask a caller-supplied model where to split unpunctuated text.
 * Returns null when ask is missing, throws, or the breaks fail local checks.
 * @returns {Promise<{breaks:number[], parts:string[]}|null>}
 */
export async function restoreSentenceBreaks(text, ask) {
  if (typeof text !== 'string' || !text) return null;
  if (typeof ask !== 'function') return null;
  let raw;
  try {
    raw = await ask(BREAK_SYSTEM, text);
  } catch {
    return null;
  }
  const breaks = parseBreaks(raw, text);
  if (!breaks) return null;
  const parts = [];
  let cursor = 0;
  for (const index of breaks) {
    parts.push(text.slice(cursor, index));
    cursor = index;
  }
  parts.push(text.slice(cursor));
  if (parts.join('') !== text || parts.some(part => part.length === 0)) return null;
  return { breaks, parts };
}

function canMerge(group, cue, maxSeconds, maxGap) {
  const prev = group.cues[group.cues.length - 1];
  const first = group.cues[0];
  if (prev.speaker !== cue.speaker) return false;
  if (prev.overlap || cue.overlap) return false;
  // 1µs absorbs binary rounding so a gap of 0.35 still counts as <= maxGap.
  if (cue.start - prev.end > maxGap + 1e-6) return false;
  if (cue.end - first.start > maxSeconds + 1e-6) return false;
  return semanticallyUnfinished(prev.src);
}

function semanticallyUnfinished(src) {
  const text = String(src ?? '').trim();
  if (!text) return false;
  if (endsWithSentenceTerminator(text)) return false;
  if (unfinishedSpeech(text)) return true;
  // No hard stop and not an English fragment: still open, but canMerge
  // cuts the run at maxGap and maxSeconds.
  return true;
}

function endsWithSentenceTerminator(text) {
  const trimmed = text.trim().replace(TRAILING_CLOSERS, '');
  if (!trimmed) return false;
  const last = trimmed.at(-1);
  if (!SENTENCE_END.test(last)) return false;
  if (last !== '.') return true;
  // Digits on both sides of "." are decimals ("3.14"), so they never reach here.
  // A trailing abbreviation ("Dr.", "e.g.") is not a sentence end.
  const word = trimmed.slice(0, -1).match(/([A-Za-z.]+)$/)?.[1] || '';
  if (ABBREV.test(word)) return false;
  return true;
}

function toSentence(cues) {
  const sourceIds = cues.map(cue => cue.id);
  return {
    id: sourceIds.join('+'),
    sourceIds,
    cues: cues.map(cue => ({ ...cue })),
    start: cues[0].start,
    end: cues[cues.length - 1].end,
    src: cues.map(cue => cue.src).join(' '),
    speaker: cues[0].speaker,
    overlap: cues.some(cue => cue.overlap),
  };
}

function parseBreaks(raw, text) {
  const obj = coerceBreakObject(raw);
  if (!obj || !Array.isArray(obj.breaks)) return null;
  if (rewritesSource(obj, text)) return null;
  const breaks = [];
  for (const value of obj.breaks) {
    if (!Number.isInteger(value) || !isBoundary(text, value)) return null;
    if (breaks.length && value <= breaks[breaks.length - 1]) return null;
    breaks.push(value);
  }
  return breaks;
}

function coerceBreakObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  let body = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) body = fence[1].trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function rewritesSource(obj, text) {
  for (const key of ['text', 'src', 'content']) {
    if (typeof obj[key] === 'string' && obj[key] !== text) return true;
  }
  const echoed = obj.parts ?? obj.sentences;
  if (echoed == null) return false;
  if (!Array.isArray(echoed) || echoed.some(part => typeof part !== 'string')) return true;
  return echoed.join('') !== text;
}

function isBoundary(text, index) {
  if (index <= 0 || index >= text.length) return false;
  const prev = text[index - 1];
  const next = text[index];
  if (isSurrogate(prev) || isSurrogate(next)) return false;
  if (/\s/.test(prev) || /\s/.test(next)) return true;
  if (LATIN_WORD.test(prev) && LATIN_WORD.test(next)) return false;
  if (splitsDottedToken(text, index)) return false;
  if ((prev === "'" || prev === '’') && LATIN_WORD.test(next) && LATIN_WORD.test(text[index - 2] || '')) return false;
  if ((next === "'" || next === '’') && LATIN_WORD.test(prev) && LATIN_WORD.test(text[index + 1] || '')) return false;
  return true;
}

function splitsDottedToken(text, index) {
  const prev = text[index - 1];
  const next = text[index];
  if (prev === '.' && LATIN_WORD.test(text[index - 2] || '') && LATIN_WORD.test(next)) return true;
  if (next === '.' && LATIN_WORD.test(prev) && LATIN_WORD.test(text[index + 1] || '')) return true;
  return false;
}

function isSurrogate(ch) {
  const code = ch.charCodeAt(0);
  return code >= 0xD800 && code <= 0xDFFF;
}

export function endsSentence(src) {
  return endsWithSentenceTerminator(String(src ?? '').trim());
}

export function hanCount(text) {
  return (String(text || '').match(/\p{Script=Han}/gu) || []).length;
}

/** Old cue-id edits apply only when they hit exactly one sentence and one string. */
export function resolveSentenceEdit(line, edits, lines = [line]) {
  if (!edits || typeof edits !== 'object' || !line) return undefined;
  if (typeof edits[line.id] === 'string') return edits[line.id];
  const ids = (Array.isArray(line.sourceIds) ? line.sourceIds : []).filter(id => id !== line.id && typeof edits[id] === 'string');
  if (ids.length !== 1) return undefined;
  const cueId = ids[0];
  const owners = (Array.isArray(lines) ? lines : [line]).filter(item => item && (item.sourceIds || [item.id]).includes(cueId));
  if (owners.length !== 1) return undefined;
  return edits[cueId];
}

export function splitZhProportional(zh, sources) {
  const list = Array.isArray(sources) ? sources : [];
  const parts = list.map(() => '');
  const chars = [...String(zh || '')];
  if (!list.length || !chars.length) return parts;
  const weights = list.map(source => Math.max(1, [...String(source?.src || '')].length));
  let cursor = 0;
  for (let i = 0; i < list.length; i++) {
    if (i === list.length - 1) {
      parts[i] = chars.slice(cursor).join('');
      break;
    }
    const restWeight = weights.slice(i).reduce((sum, weight) => sum + weight, 0);
    const restChars = chars.length - cursor;
    let take = Math.round(restChars * weights[i] / restWeight);
    take = Math.max(1, Math.min(restChars - (list.length - 1 - i), take));
    parts[i] = chars.slice(cursor, cursor + take).join('');
    cursor += take;
  }
  return parts;
}

/** Map restored break indexes back onto cues. Null keeps the caller's groupSentences result. */
export function sentenceUnitsFromRestore(cues, restored) {
  if (!Array.isArray(cues) || !cues.length || !restored?.breaks || !restored.parts) return null;
  const text = cues.map(cue => String(cue.src || '')).join(' ');
  if (restored.parts.join('') !== text) return null;
  const ranges = [];
  let cursor = 0;
  for (let i = 0; i < cues.length; i++) {
    const src = String(cues[i].src || '');
    ranges.push({ start: cursor, end: cursor + src.length });
    cursor += src.length + (i < cues.length - 1 ? 1 : 0);
  }
  const bounds = [0, ...restored.breaks, text.length];
  const units = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const from = bounds[i];
    const to = bounds[i + 1];
    if (!(to > from)) return null;
    const slice = [];
    for (let n = 0; n < cues.length; n++) {
      const range = ranges[n];
      const startAt = Math.max(range.start, from);
      const endAt = Math.min(range.end, to);
      if (endAt <= startAt) continue;
      const src = String(cues[n].src || '');
      const localStart = startAt - range.start;
      const localEnd = endAt - range.start;
      const part = src.slice(localStart, localEnd);
      if (!part) return null;
      const span = Number(cues[n].end) - Number(cues[n].start);
      const start = Number(cues[n].start) + (src.length ? span * localStart / src.length : 0);
      const end = Number(cues[n].start) + (src.length ? span * localEnd / src.length : span);
      const id = localStart === 0 && localEnd === src.length ? cues[n].id : `${cues[n].id}@${localStart}`;
      slice.push({ ...cues[n], id, start, end, src: part, originalCueId: cues[n].originalCueId || cues[n].id, charStart: localStart, charEnd: localEnd, timingQuality: 'estimated' });
    }
    if (slice.length) units.push(...groupSentences(slice));
  }
  return units.length ? units : null;
}

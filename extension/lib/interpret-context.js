/** Context contains only successfully committed translations, in source order. */
export function createInterpretContext({ maxSentences = 3, maxChars = 1500 } = {}) {
  let history = [];
  const glossary = new Map();
  return {
    reset() { history = []; glossary.clear(); },
    snapshot() { return history.map(item => ({ ...item })); },
    terms() { return [...glossary.values()].filter(p => p.count >= 2).map(({ source, target }) => ({ source, target })); },
    commit(src, zh, terms = []) {
      if (!src || !zh) return;
      history.push({ src, zh });
      while (history.length > maxSentences || history.reduce((n, p) => n + p.src.length + p.zh.length, 0) > maxChars) history.shift();
      const seen = new Set();
      for (const { source, target } of terms) {
        if (!source || !target || source.length > 64 || target.length > 64 || !src.includes(source) || !zh.includes(target)) continue;
        const key = source.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const previous = glossary.get(key);
        glossary.set(key, { source, target, count: previous?.target === target ? previous.count + 1 : 1 });
      }
      while (glossary.size > 50 || [...glossary.values()].reduce((n, p) => n + p.source.length + p.target.length, 0) > 2000) {
        glossary.delete(glossary.keys().next().value);
      }
    },
  };
}

const BRIEF_CHARS = 800;
const HISTORY_SENTENCES = 12;
const HISTORY_CHARS = 3000;
const LOOKAHEAD_SENTENCES = 4;
const LOOKAHEAD_CHARS = 800;
const CURRENT_UNITS = 15;

const chars = text => [...String(text || '')];
const clip = (text, limit) => chars(text).slice(0, limit).join('');

/**
 * Glossary entries reach the translator only after one source keeps the same
 * target. createInterpretContext().terms() already applies that rule: a new
 * target resets count to 1, and terms() hides pairs until count >= 2.
 * Entries without count are treated as already confirmed by that caller.
 */
export function stableGlossary(glossary) {
  const bySource = new Map();
  for (const item of Array.isArray(glossary) ? glossary : []) {
    const source = String(item?.source || '').trim();
    const target = String(item?.target || '').trim();
    if (!source || !target) continue;
    const count = Number(item.count);
    if (Number.isFinite(count) && count < 2) continue;
    const key = source.toLowerCase();
    const previous = bySource.get(key);
    const rank = Number.isFinite(count) ? count : 2;
    if (!previous || rank >= previous.rank) bySource.set(key, { source, target, rank });
  }
  return [...bySource.values()].map(({ source, target }) => ({ source, target }));
}

/** Layered translation payload. Lookahead is source only and must not be translated. */
export function buildTranslationInput({ brief, glossary, history, current, lookahead } = {}) {
  let kept = (Array.isArray(history) ? history : [])
    .filter(item => item?.src && item?.zh)
    .map(item => ({ src: String(item.src), zh: String(item.zh) }))
    .slice(-HISTORY_SENTENCES);
  const weight = items => items.reduce((sum, item) => sum + chars(item.src).length + chars(item.zh).length, 0);
  // Prefer the latest 8–12 sentences, then keep cutting until the character cap holds.
  while (kept.length > 8 && weight(kept) > HISTORY_CHARS) kept.shift();
  while (kept.length && weight(kept) > HISTORY_CHARS) kept.shift();

  const ahead = [];
  let aheadChars = 0;
  for (const item of (Array.isArray(lookahead) ? lookahead : []).slice(0, LOOKAHEAD_SENTENCES)) {
    const src = String(item?.src || '');
    if (!src || aheadChars >= LOOKAHEAD_CHARS) break;
    const room = LOOKAHEAD_CHARS - aheadChars;
    const piece = { src: clip(src, room) };
    if (item?.id != null) piece.id = String(item.id);
    ahead.push(piece);
    aheadChars += chars(piece.src).length;
  }

  const batch = (Array.isArray(current) ? current : []).slice(0, CURRENT_UNITS).map(item => {
    const start = Number(item?.start);
    const end = Number(item?.end);
    const duration = Number.isFinite(Number(item?.duration))
      ? Number(item.duration)
      : (Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0);
    const budget = Number(item?.budgetChars);
    const row = {
      id: item?.id,
      src: String(item?.src || ''),
      budgetChars: Number.isFinite(budget) && budget > 0 ? Math.round(budget) : Math.max(1, Math.round(duration * 3.8)),
      duration,
    };
    if (Array.isArray(item?.sourceIds)) row.sourceIds = item.sourceIds;
    if (Number.isFinite(start)) row.start = start;
    if (Number.isFinite(end)) row.end = end;
    if (item?.speaker != null) row.speaker = item.speaker;
    return row;
  });

  return {
    brief: clip(brief, BRIEF_CHARS),
    glossary: stableGlossary(glossary),
    history: kept,
    current: batch,
    lookahead: ahead,
  };
}

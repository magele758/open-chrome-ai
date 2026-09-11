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

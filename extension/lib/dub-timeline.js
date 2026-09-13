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

export function validateDubTranslation(raw, cues) {
  const json = typeof raw === 'string' ? JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()) : raw;
  if (!Array.isArray(json?.lines)) throw new Error('口播稿格式不正确');
  const expected = cues.map(c => c.id);
  const actual = json.lines.flatMap(l => l.ids || []);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('口播稿遗漏、重复或调换了原文');
  const byId = new Map(cues.map(c => [c.id, c]));
  return json.lines.map(line => {
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

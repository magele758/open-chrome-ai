/** Retry clean references without ever borrowing another/unknown speaker's voice. */
export async function prepareSpeakerReference({ line, spans, source, voiceRef }) {
  const known = line.speaker && !/^(unassigned|asr):/.test(line.speaker);
  const sameSpeaker = known ? spans.filter(s => s.speaker === line.speaker && s.kind === 'speech' && !s.overlap && Number(s.music || 0) <= .1)
    .sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 3) : [];
  const ownSpeech = !line.overlap ? spans.filter(s => s.end > line.start && s.start < line.end && !s.overlap && s.kind === 'speech' && Number(s.music || 0) <= .1 && (!known || s.speaker === line.speaker))
    .map(s => ({ start: Math.max(line.start, s.start), end: Math.min(line.end, s.end) })) : [];
  const regions = [...sameSpeaker, ...ownSpeech, ...(!line.overlap ? [line] : [])];
  const tried = new Set();
  for (const region of regions) {
    const length = region.end - region.start;
    if (!(length > 0)) continue;
    const seconds = Math.min(7, length);
    // A turn may start with a pause. Try its middle/end before falling back.
    for (const start of [region.start, region.start + (length - seconds) / 2, region.end - seconds]) {
      const key = `${start.toFixed(3)}:${seconds.toFixed(3)}`;
      if (tried.has(key)) continue;
      tried.add(key);
      const sample = await source.slice(start, seconds);
      const ref = sample && await voiceRef(sample.blob);
      if (ref) return ref;
    }
  }
  return null;
}

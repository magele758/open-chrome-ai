// Shared, deterministic policy for planning, production and the offline harness.
export const INTERPRET_VERSION = 'planned-v3';
// Saved full-audio archives from older voice/segmentation logic are regenerated, not replayed.
export const DUB_ARCHIVE_VERSION = `${INTERPRET_VERSION}:shared-voice:line-emotion`;
export function speechUnits(text) {
  const value = String(text || '');
  return (value.match(/\p{Script=Han}/gu) || []).length
    + (value.match(/[A-Za-z]+/g) || []).reduce((n, word) => n + Math.max(1, Math.ceil(word.length / 3)), 0)
    + (value.match(/\d/g) || []).length;
}

export function safeBudgetRewrite(before, after, limit) {
  if (!after || speechUnits(after) > limit || speechUnits(after) < speechUnits(before) * .45) return false;
  const tokens = before.match(/\d+(?:[.,]\d+)*%?|[A-Z][A-Za-z0-9-]*|不能|没有|不是|不得|不超过|至少|至多|不|无|未/g) || [];
  return tokens.every(token => after.includes(token));
}

export function failedTranslation(cue, reason = 'translation-invalid') {
  const members = cue.cues?.length ? cue.cues : [cue];
  return { ...cue, id: members.map(c => c.id).join('+'), sourceIds: members.map(c => c.id),
    captionSources: members.map(c => ({ ...c })), zh: '', translationStatus: 'failed', failureReason: reason };
}

export function bufferingTarget({ refill, configured = 30, latencySeconds = 0, playbackRate = 1, remaining = Infinity }) {
  const base = refill ? Math.min(10, Math.max(6, configured)) : 3;
  return Math.min(remaining / Math.max(.25, playbackRate), Math.max(base,
    Math.min(Math.max(base, configured), latencySeconds * 1.25)));
}

export function stableAudioIdentity({ source, line, tts, configuredKey, background }) {
  return { source, line, tts: ttsAudioIdentity(tts), configuredKey, background: Boolean(background), version: `${INTERPRET_VERSION}:audio:shared-voice:line-emotion` };
}

export function ttsAudioIdentity(tts = {}) {
  const { apiKey, preparationMode, bufferSeconds, bufferSegments, contextMode,
    translateAheadSeconds, preparationVersion, playbackMode, gapMs, playbackRate, ...sound } = tts;
  return sound;
}

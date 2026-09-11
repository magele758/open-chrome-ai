/** Conservative guard for runaway ASR/translation output, not normal emphasis.
 * Ignore punctuation and spacing so repeated words/sentences are caught too.
 * Reject the whole suspect segment: trimming its loop cannot recover meaning.
 */
export function hasRunawayRepetition(text) {
  const compact = String(text || '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
  for (const match of compact.matchAll(/([\p{L}\p{N}]{1,40}?)\1{2,}/gu)) {
    const unit = [...match[1]].length;
    const length = [...match[0]].length;
    const repeats = length / unit;
    if (unit < 4 ? repeats >= 6 && length >= 12 : repeats >= 3 && length >= 18) return true;
  }
  return false;
}

export function isWeakSpeechText(text, seconds = 0) {
  const compact = String(text || "").normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "");
  if (compact.length < 2) return true;
  if (Number(seconds) >= 3.5 && compact.length < 3) return true;
  return false;
}

export function checkSpeechText(text, stage) {
  if (hasRunawayRepetition(text)) {
    throw new Error(`${stage}出现异常重复，已跳过本段，继续听下一段。`);
  }
  return text;
}

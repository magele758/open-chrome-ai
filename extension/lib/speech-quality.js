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
    if (unit === 1 ? repeats >= 5 : unit <= 3 ? repeats >= 4 && length >= 8 : repeats >= 4 && length >= 24) return true;
  }
  return false;
}

export function isWeakSpeechText(text, seconds = 0) {
  const compact = String(text || "").normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "");
  if (compact.length < 2) return true;
  if (Number(seconds) >= 3.5 && compact.length < 3) return true;
  return false;
}

export const WHISPER_HALLUCINATION_PATTERNS = [
  /中文字幕/i,
  /字幕(?:志愿者|组|制作|提供|来自|翻译|听译|校对|压制|后期|编辑)/i,
  /时间轴[：:\s]|片尾[：:\s]|后期[：:\s]|听译[：:\s]/i,
  /不吝赐教|批评指正|请多关照/i,
  /(?:感谢|谢谢)(?:您的?)?(?:收看|观看|大家|支持)/i,
  /(?:欢迎|记得|请)(?:订阅|点赞|关注|一键三连)/i,
  /独播剧场|影视剧场|独家剧场/i,
  /subtitles?\s+(?:by|provided\s+by)/i,
  /(?:translated|captions?|transcribed)\s+by/i,
  /amara\.org/i,
  /thank(?:s|\s+you)\s+for\s+(?:watching|listening)/i,
  /please\s+(?:subscribe|like|share)/i,
  /ご視聴ありがとうございました/i,
  /チャンネル登録/i,
];

export const ARTIST_HALLUCINATIONS = [
  /李宗盛/i,
  /周杰伦/i,
  /王力宏/i,
  /林俊杰/i,
  /五月天/i,
];

/**
 * Detects common Whisper silence/music hallucinations (canned subtitle signatures,
 * repeated sponsor/volunteer credits, or singer names hallucinated on background music).
 */
export function isWhisperHallucination(text, { sliceSeconds = 0, segments = [] } = {}) {
  const s = String(text || "").trim();
  if (!s) return false;

  const compact = s.normalize("NFKC").replace(/\s+/g, " ");

  // 1. Matched known subtitle volunteer / watermark patterns
  for (const pattern of WHISPER_HALLUCINATION_PATTERNS) {
    if (pattern.test(compact)) {
      if (compact.length < 40) return true;
      if (/(.{3,15})\s+\1/.test(compact)) return true;
      if (ARTIST_HALLUCINATIONS.some((p) => p.test(compact))) return true;
    }
  }

  // 2. Standalone artist name or repeated short credits without sentence structure
  for (const artist of ARTIST_HALLUCINATIONS) {
    if (artist.test(compact)) {
      if (compact.length < 15) return true;
      if (/(.{2,10})\s+\1/.test(compact)) return true;
    }
  }

  // 3. Duplicate phrase repetition within a short segment (e.g. "foo foo" in < 30 chars)
  const shortRepeatMatch = compact.match(/^(.{3,15})\s+\1(?:\s+.*)?$/);
  if (shortRepeatMatch && compact.length < 35) {
    return true;
  }

  // 4. Abnormal duration inflation (Whisper 30s padding on silence)
  if (Array.isArray(segments) && segments.length > 0) {
    const maxEnd = Math.max(...segments.map((seg) => Number(seg.end) || 0));
    if (maxEnd >= 24 && Number(sliceSeconds) > 0 && sliceSeconds <= 8) {
      return true;
    }
    for (const seg of segments) {
      const segStart = Number(seg.start) || 0;
      const segEnd = Number(seg.end) || 0;
      const segDuration = segEnd - segStart;
      if (segDuration >= 20 && Number(sliceSeconds) > 0 && sliceSeconds <= 8) {
        if (compact.length < 35 || WHISPER_HALLUCINATION_PATTERNS.some((p) => p.test(compact))) {
          return true;
        }
      }
    }
  }

  return false;
}

export function checkSpeechText(text, stage) {
  if (hasRunawayRepetition(text)) {
    throw new Error(`${stage}出现异常重复，已跳过本段，继续听下一段。`);
  }
  if (isWhisperHallucination(text)) {
    throw new Error(`${stage}出现模型静音幻觉（如字幕组/志愿者/水印），已跳过本段。`);
  }
  return text;
}


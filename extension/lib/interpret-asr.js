import { transcribeAudio, filenameForMime } from './asr.js';
import { readPcmWav, pcmWav } from './downloaded-audio-source.js';
import { hasRunawayRepetition } from './speech-quality.js';
import { withInterpretDeadline } from './interpret-semantic.js';
import { debugLog } from './debug-log.js';

// Keep the original slice until recognition succeeds. A shorter decoding window
// can recover a looping model without guessing which repeated words were spoken.
export async function transcribeInterpretSlice(model, item, { signal, trace,
  transcribe = transcribeAudio } = {}) {
  signal?.throwIfAborted();
  let pcm;
  try { pcm = readPcmWav(await item.blob.arrayBuffer()); } catch { /* encoded tab capture */ }
  if (pcm) {
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let peak = 0, energy = 0;
    for (let i = 0; i + 1 < pcm.length; i += 2) {
      const sample = view.getInt16(i, true);
      peak = Math.max(peak, Math.abs(sample));
      energy += sample * sample;
    }
    // Only digital/near-digital silence; quiet speech must still reach ASR.
    if (peak <= 8 && Math.sqrt(energy / Math.max(1, pcm.length / 2)) <= 4) {
      debugLog('audio.skipped', { ...trace, reason: 'pcm-silence' });
      return [];
    }
  }
  const request = blob => withInterpretDeadline(requestSignal => transcribe(model, blob, {
    filename: filenameForMime(blob.type || item.mime), signal: requestSignal, allowEmpty: true, trace,
  }), signal);
  const validate = segments => {
    if (hasRunawayRepetition(segments.map(s => s.text || '').join(' '))) {
      throw new Error('语音识别出现异常重复，重试后仍无法确认本段内容。');
    }
    return segments;
  };
  try {
    return validate(await request(item.blob));
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.name === 'AbortError') throw error;
    // Authentication/configuration failures cannot be repaired by resubmitting.
    if (/\b(?:400|401|403|404|413|415|422)\b/.test(error?.message || '')) throw error;
    debugLog('asr.retry', { ...trace, reason: error.message });
    if (!/异常重复/.test(error.message) || !pcm || pcm.length < 32000 * 2) return validate(await request(item.blob));
    const middle = Math.floor(pcm.length / 4) * 2;
    const segments = [];
    for (const [from, to] of [[0, middle], [middle, pcm.length]]) {
      signal?.throwIfAborted();
      const result = validate(await request(pcmWav([pcm.subarray(from, to)])));
      const duration = (to - from) / 32000;
      for (const s of result) segments.push({ ...s,
        start: from / 32000 + Math.max(0, Math.min(duration, Number(s.start) || 0)),
        end: from / 32000 + (Number.isFinite(s.end) ? Math.max(0, Math.min(duration, s.end)) : duration),
      });
    }
    return validate(segments);
  }
}

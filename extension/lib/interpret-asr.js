import { transcribeAudio, filenameForMime } from './asr.js';
import { readPcmWav, pcmWav } from './downloaded-audio-source.js';
import { hasRunawayRepetition } from './speech-quality.js';
import { withInterpretDeadline } from './interpret-semantic.js';
import { debugLog } from './debug-log.js';

// Keep the original slice until recognition succeeds. A shorter decoding window
// can recover a looping model without guessing which repeated words were spoken.
export async function transcribeInterpretSlice(model, item, { signal, trace,
  transcribe = transcribeAudio, onUnrecognized } = {}) {
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
      const error = new Error('语音识别出现异常重复，重试后仍无法确认本段内容。');
      error.code = 'ASR_REPETITION';
      throw error;
    }
    return segments;
  };
  const recognize = async (blob, from = 0, depth = 0) => {
    try {
      const result = validate(await request(blob));
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.name === 'AbortError') throw error;
      if (/\b(?:400|401|403|404|413|415|422)\b/.test(error?.message || '')) throw error;
      debugLog('asr.retry', { ...trace, reason: error.message, depth });
      const bytes = pcm ? readPcmWav(await blob.arrayBuffer()) : null;
      if (error.code === 'ASR_REPETITION' && bytes?.length >= 128000 && depth < 2) {
        const middle = Math.floor(bytes.length / 4) * 2;
        const segments = [];
        for (const [lo, hi] of [[0, middle], [middle, bytes.length]]) {
          signal?.throwIfAborted();
          const result = await recognize(pcmWav([bytes.subarray(lo, hi)]), from + lo / 32000, depth + 1);
          const duration = (hi - lo) / 32000;
          for (const s of result) segments.push({ ...s,
            start: lo / 32000 + Math.max(0, Math.min(duration, Number(s.start) || 0)),
            end: lo / 32000 + (Number.isFinite(s.end) ? Math.max(0, Math.min(duration, s.end)) : duration),
          });
        }
        return segments;
      }
      try {
        // Split windows already are retries; only retry the original request.
        if (depth > 0) throw error;
        const result = validate(await request(blob));
        signal?.throwIfAborted();
        return result;
      } catch (lastError) {
        signal?.throwIfAborted();
        if (lastError.code !== 'ASR_REPETITION' || !onUnrecognized) throw lastError;
        onUnrecognized({ start: from, end: from + (bytes ? bytes.length / 32000 : Number(item.seconds) || 0) });
        return [];
      }
    }
  };
  return recognize(item.blob);
}

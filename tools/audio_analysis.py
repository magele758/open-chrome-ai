#!/usr/bin/env python3
"""Local speaker/activity analysis. Audio never leaves the media helper.
Model weights are downloaded from Hugging Face; HF_TOKEN is read only here.
"""
import argparse
import hashlib
import json
import time
import os
import shutil
from pathlib import Path


def partition(turns, duration):
    """Keep original time, including overlapping and unassigned intervals."""
    boundaries = sorted({0.0, duration, *(max(0., min(duration, float(t[k]))) for t in turns for k in ('start', 'end'))})
    spans = []
    for start, end in zip(boundaries, boundaries[1:]):
        if end <= start:
            continue
        speakers = sorted({t['speaker'] for t in turns if t['start'] < end and t['end'] > start})
        item = {'start': start, 'end': end, 'speaker': speakers[0] if len(speakers) == 1 else None,
                'speakers': speakers, 'overlap': len(speakers) > 1, 'kind': 'speech' if speakers else 'unknown'}
        if spans and all(spans[-1][k] == item[k] for k in ('speaker', 'speakers', 'overlap', 'kind')):
            spans[-1]['end'] = end
        else:
            spans.append(item)
    return spans


def analyze(root, classifier_factory=None, diarizer_factory=None):
    os.environ.setdefault('PYANNOTE_METRICS_ENABLED', '0')
    import numpy as np
    import soundfile as sf
    import torch
    from pyannote.audio import Pipeline
    from transformers import pipeline
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    files = sorted(Path(root).glob('part-*.wav'))
    chunks = []
    for file in files:
        data, rate = sf.read(file, dtype='float32')
        if rate != 16000 or data.ndim != 1:
            raise ValueError('Expected 16kHz mono WAV')
        chunks.append(data)
    audio = np.concatenate(chunks)
    del chunks
    fingerprint = hashlib.sha256(audio.tobytes()).hexdigest()
    model_name = os.environ.get('PAGELENS_DIARIZATION_MODEL', 'pyannote/speaker-diarization-community-1')
    cache_name = hashlib.sha256((fingerprint + model_name + ':2').encode()).hexdigest()
    cache = Path.home() / '.cache/pagelens-media/analysis' / (cache_name + '.json')
    if cache.is_file() and time.time() - cache.stat().st_mtime < 7 * 86400:
        cached = json.loads(cache.read_text(encoding='utf-8'))
        if not cached.get('background') or all(cache.with_name(cache.stem + f'-bg-{i}.wav').is_file() for i in range(len(files))):
            if cached.get('background'):
                for i in range(len(files)):
                    shutil.copyfile(cache.with_name(cache.stem + f'-bg-{i}.wav'), Path(root) / f'background-{i:05d}.wav')
            return cached
    diarizer = (diarizer_factory or Pipeline.from_pretrained)(os.environ.get('PAGELENS_DIARIZATION_MODEL', 'pyannote/speaker-diarization-community-1'), token=os.environ.get('HF_TOKEN'))
    output = diarizer({'waveform': torch.from_numpy(audio).unsqueeze(0), 'sample_rate': 16000})
    annotation = output.speaker_diarization
    turns = [{'start': t.start, 'end': t.end, 'speaker': str(s)} for t, _, s in annotation.itertracks(yield_label=True)]
    spans = partition(turns, len(audio) / 16000)
    classifier = (classifier_factory or pipeline)('audio-classification', model='MIT/ast-finetuned-audioset-10-10-0.4593', device=-1)
    result = []
    for span in spans:
        # Classify bounded windows; never use energy alone to label music.
        cursor = span['start']
        while cursor < span['end']:
            end = min(span['end'], cursor + 10)
            samples = audio[round(cursor * 16000):round(end * 16000)]
            item = {**span, 'start': cursor, 'end': end}
            rms = float(np.sqrt(np.mean(samples * samples))) if len(samples) else 0
            if rms < 4 / 32768 and (not len(samples) or float(np.max(np.abs(samples))) < 8 / 32768):
                item.update(kind='silence', speaker=None, speakers=[], overlap=False)
            elif len(samples) >= 1600:
                scores = classifier({'array': samples, 'sampling_rate': 16000}, top_k=None)
                speech = max((x['score'] for x in scores if any(s in x['label'].lower() for s in ('speech', 'conversation', 'narration', 'whisper', 'singing', 'vocal'))), default=0)
                music = max((x['score'] for x in scores if x['label'].lower() == 'music'), default=0)
                item['music'] = music
                # Ambiguity stays in the ASR path, not silently discarded.
                if not span['speakers'] and music >= .65 and speech < .05:
                    item['kind'] = 'music'
            result.append(item)
            cursor = end
    mixed = [s for s in result if s['kind'] == 'speech' and s.get('music', 0) >= .1]
    if mixed:
        from demucs.pretrained import get_model
        from demucs.apply import apply_model
        from scipy.signal import resample_poly
        model = get_model('htdemucs').cpu().eval()
        background = np.zeros_like(audio)
        for interval in result:
            if interval['kind'] == 'music':
                start, end = round(interval['start'] * 16000), round(interval['end'] * 16000)
                background[start:end] = audio[start:end]
        for span in mixed:
            start, end = round(span['start'] * 16000), round(span['end'] * 16000)
            lo, hi = max(0, start - 32000), min(len(audio), end + 32000)
            wave = resample_poly(audio[lo:hi], 441, 160).astype('float32')
            tensor = torch.from_numpy(wave).repeat(2, 1).unsqueeze(0)
            mean = tensor.mean()
            scale = tensor.std().clamp_min(1e-6)
            with torch.inference_mode():
                stems = apply_model(model, (tensor - mean) / scale, device='cpu', shifts=0, split=True, progress=False)[0]
                stems = stems * scale + mean
            accompaniment = sum(stems[i] for i, name in enumerate(model.sources) if name != 'vocals').mean(dim=0).numpy()
            separated = resample_poly(accompaniment, 160, 441)
            offset = start - lo
            background[start:end] = separated[offset:offset + end - start]
        cursor = 0
        cache.parent.mkdir(parents=True, exist_ok=True)
        for i, file in enumerate(files):
            count = sf.info(file).frames
            path = Path(root) / f'background-{i:05d}.wav'
            sf.write(path, background[cursor:cursor + count], 16000, subtype='PCM_16')
            shutil.copyfile(path, cache.with_name(cache.stem + f'-bg-{i}.wav'))
            cursor += count
    payload = {'version': 2, 'background': bool(mixed), 'fingerprint': fingerprint, 'duration': len(audio) / 16000, 'spans': result}
    cache.parent.mkdir(parents=True, exist_ok=True)
    temporary = cache.with_suffix('.tmp')
    temporary.write_text(json.dumps(payload), encoding='utf-8')
    temporary.replace(cache)
    return payload


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('directory')
    parser.add_argument('output')
    args = parser.parse_args()
    result = analyze(args.directory)
    Path(args.output).write_text(json.dumps(result), encoding='utf-8')

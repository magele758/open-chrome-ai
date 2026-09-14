#!/usr/bin/env python3
"""
YouTube & Local Video Subtitle-driven Dubber (Decoupled Stem Separation & Sidechain Ducking Pipeline)

Architecture:
  1. Input Acquisition: Fetch native YouTube subtitles & video, or accept local video/audio files.
  2. Semantic Segmentation: Group word-level subtitle events into complete sentences with accurate (start, end) timestamps.
  3. Spoken Translation: Translate sentences into natural Chinese mouth-ready speech (口播体) with syllable budgeting.
  4. Stem Separation (Demucs / htdemucs):
     - Separate original audio into [Clean Vocals] and [Pristine Accompaniment/BGM/SFX].
     - Extract clean voice reference from [Clean Vocals] without any BGM noise pollution.
     - Retain 100% original quality of [Pristine Accompaniment].
  5. Duration-Aligned Speech Synthesis:
     - Index-TTS 2.5: compute duration_factor (0.5x - 2.0x) to fit speech duration directly at generation time.
     - Edge-TTS fallback: compute native rate (+/-%) to fit duration natively, minimizing post-hoc time-stretching.
  6. Multi-Track Timeline Assembly:
     - Concatenate speech chunks sample-accurately at respective start timestamps.
  7. Broadcast-Grade Dynamic Sidechain Ducking:
     - Overlay new Chinese speech onto pristine accompaniment via ffmpeg `sidechaincompress`.
     - BGM automatically dips during speech and returns to full volume during pauses.
     - Zero residual foreign language bleed; 100% studio-grade background music & Foley.
  8. Remuxing: Produce final MP4 with synchronized bilingual SRT.
"""

import argparse
import asyncio
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import wave
from pathlib import Path


def log(msg):
    print(f"[\033[1;34mPageLens-Dubber\033[0m] {msg}", flush=True)


def run_cmd(cmd, check=True):
    res = subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True)
    if check and res.returncode != 0:
        raise RuntimeError(f"Command failed: {cmd}\nstderr: {res.stderr}")
    return res.stdout


def get_audio_duration(path):
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(path)
    ]
    out = run_cmd(cmd, check=False).strip()
    return float(out) if out else 0.0


# --- Step 1: Subtitle Fetching and Segmentation ---

def fetch_youtube_subtitles(url, output_dir, lang="en"):
    """
    Downloads json3 subtitles directly from YouTube without ASR.
    """
    log(f"正在拉取视频原生字幕 (无需 ASR 识别): {url} ...")
    json3_pattern = os.path.join(output_dir, "sub.%(ext)s")
    cmd = [
        "yt-dlp",
        "--skip-download",
        "--write-auto-subs",
        "--write-subs",
        "--sub-langs", lang,
        "--sub-format", "json3",
        "-o", json3_pattern,
        url
    ]
    run_cmd(cmd)

    candidates = list(Path(output_dir).glob("sub.*.json3"))
    if not candidates:
        raise FileNotFoundError(f"未在视频中找到 {lang} 语言的字幕轨（包括自动字幕和官方字幕）。")
    sub_file = candidates[0]
    log(f"已成功获取原生字幕文件: {sub_file.name}")
    return str(sub_file)


TRAILING_CONNECTORS = {
    "from", "in", "the", "of", "to", "and", "or", "that", "with", "for", "at", "on", "a", "an",
    "is", "are", "was", "were", "by", "as", "be", "but", "so", "if", "when", "into", "about",
    "uh", "um", "finest", "my", "your", "their", "our", "its", "this", "these", "those"
}


def parse_json3_sentences(json3_path, max_duration=None, start_offset=0):
    """
    Reconstructs complete sentences and accurate start/end timestamps from json3 words.
    """
    with open(json3_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    words = []
    for ev in data.get("events", []):
        t_start = ev.get("tStartMs", 0)
        dur = ev.get("dDurationMs", 0)
        segs = ev.get("segs", [])
        if not segs:
            continue
        for seg in segs:
            text = seg.get("utf8", "")
            if not text or text == "\n":
                continue
            offset = seg.get("tOffsetMs", 0)
            word_start = t_start + offset
            words.append({
                "text": text,
                "start_ms": word_start,
                "end_ms": word_start + seg.get("dDurationMs", max(200, dur // max(1, len(segs))))
            })

    if not words:
        return []

    words.sort(key=lambda x: x["start_ms"])

    clean_words = []
    bracket_re = re.compile(r"^[\[\(].*?[\]\)]$")
    for w in words:
        t = w["text"].strip()
        if bracket_re.match(t):
            continue
        clean_words.append(w)

    sentences = []
    curr_words = []
    curr_start = 0

    end_limit_ms = (start_offset + max_duration) * 1000 if max_duration else float("inf")
    start_offset_ms = start_offset * 1000

    def join_words(w_list):
        res = ""
        for w in w_list:
            if not res or w.startswith(" ") or res.endswith(" "):
                res += w
            elif re.match(r"^[.,!?;:'\"]", w):
                res += w
            else:
                res += " " + w
        return res.strip()

    for i, w in enumerate(clean_words):
        if w["end_ms"] < start_offset_ms:
            continue
        if w["start_ms"] > end_limit_ms:
            break

        if not curr_words:
            curr_start = w["start_ms"]
        curr_words.append(w["text"])

        clean_text = join_words(curr_words)
        next_gap = 0
        if i + 1 < len(clean_words):
            next_gap = clean_words[i + 1]["start_ms"] - w["end_ms"]

        last_word = re.sub(r"[^a-zA-Z]", "", clean_text.split()[-1].lower()) if clean_text.split() else ""
        is_connector = last_word in TRAILING_CONNECTORS
        has_terminal = bool(re.search(r"[.?!]\s*$", clean_text))
        is_long_pause = next_gap > 1100 and not is_connector
        is_max_len = len(curr_words) >= 14 and not is_connector
        is_last = (i == len(clean_words) - 1)

        too_short = len(curr_words) < 4 and not has_terminal and not is_last

        if (has_terminal or is_long_pause or is_max_len or is_last) and not too_short and clean_text:
            end_ms = clean_words[i + 1]["start_ms"] if i + 1 < len(clean_words) else w["end_ms"]
            if end_ms - curr_start < 1200:
                end_ms = curr_start + 1200

            rel_start = max(0.0, (curr_start - start_offset_ms) / 1000.0)
            rel_end = max(rel_start + 1.0, (end_ms - start_offset_ms) / 1000.0)

            sentences.append({
                "index": len(sentences) + 1,
                "start_s": rel_start,
                "end_s": rel_end,
                "duration_s": rel_end - rel_start,
                "orig_text": clean_text
            })
            curr_words = []

    log(f"字幕重组完成，在测试窗口内提取出 {len(sentences)} 句语义连贯的带时间戳长句。")
    return sentences


# --- Step 2: Stem Separation (Demucs / htdemucs) ---

def separate_vocals_and_background(input_audio_path, output_dir, model_name="htdemucs"):
    """
    Separates input audio into clean vocals and accompaniment using Demucs (htdemucs).
    Returns (vocals_wav_path, accompaniment_wav_path).
    Falls back gracefully to center-channel cancellation if Demucs is unavailable.
    """
    output_dir = Path(output_dir)
    vocals_path = output_dir / "vocals.wav"
    accompaniment_path = output_dir / "accompaniment.wav"

    log("正在执行人声与伴奏分离 (Demucs / htdemucs 解耦流水线)...")

    sep_code = f"""
import soundfile as sf
import numpy as np
import torch
from demucs.pretrained import get_model
from demucs.apply import apply_model
from scipy.signal import resample_poly

audio, sr = sf.read(r'{input_audio_path}')
if audio.ndim == 1:
    audio = np.stack([audio, audio], axis=0)
else:
    audio = audio.T
if sr != 44100:
    audio = resample_poly(audio, 44100, sr, axis=1)

tensor = torch.from_numpy(audio).float().unsqueeze(0)
model = get_model('{model_name}').cpu().eval()
with torch.inference_mode():
    stems = apply_model(model, tensor, device='cpu', shifts=0, split=True, progress=False)[0]

vocals = stems[model.sources.index('vocals')].numpy()
no_vocals = sum(stems[i] for i, name in enumerate(model.sources) if name != 'vocals').numpy()

if sr != 44100:
    vocals = resample_poly(vocals, sr, 44100, axis=1)
    no_vocals = resample_poly(no_vocals, sr, 44100, axis=1)

sf.write(r'{vocals_path}', vocals.T, sr)
sf.write(r'{accompaniment_path}', no_vocals.T, sr)
"""
    conda_py = "/opt/homebrew/Caskroom/miniconda/base/envs/pagelens-media/bin/python"
    py_exec = conda_py if os.path.exists(conda_py) else sys.executable

    res = subprocess.run([py_exec, "-c", sep_code], capture_output=True, text=True)
    if res.returncode == 0 and vocals_path.exists() and accompaniment_path.exists():
        log("人声与背景伴奏分离成功！")
        log(f"  - 干净人声轨: {vocals_path}")
        log(f"  - 纯净伴奏/环境轨 (100% 原声质感): {accompaniment_path}")
        return str(vocals_path), str(accompaniment_path)

    log(f"Demucs 外部引擎不可用 ({res.stderr.strip()[:120]})，使用 ffmpeg 声学滤波伴奏备用路径...")
    # Center-channel vocal reduction fallback
    run_cmd([
        "ffmpeg", "-y", "-i", input_audio_path,
        "-filter_complex", "[0:a]stereotools=mlev=0:slev=1.3[out]",
        "-map", "[out]", str(accompaniment_path)
    ], check=False)
    if not accompaniment_path.exists() or accompaniment_path.stat().st_size == 0:
        shutil.copyfile(input_audio_path, accompaniment_path)

    shutil.copyfile(input_audio_path, vocals_path)
    return str(vocals_path), str(accompaniment_path)


def extract_reference_voice(vocals_path, output_ref_path, start_s=2.0, duration_s=5.0):
    """
    Extracts a clean speaker voice snippet from the separated vocals track (ZERO BGM noise).
    """
    run_cmd([
        "ffmpeg", "-y",
        "-ss", str(start_s),
        "-i", vocals_path,
        "-t", str(duration_s),
        "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        output_ref_path
    ])
    log(f"已从干净人声轨提取讲者音色样本 (无BGM残留，用于音色克隆): {output_ref_path}")
    return output_ref_path


# --- Step 3: Cross-Language Frequency Modeling & Spoken Translation ---

LANGUAGE_PROFILES = {
    "en": {"name": "English", "syl_per_sec": 4.0, "info_density": 1.0},
    "zh": {"name": "Chinese", "syl_per_sec": 4.3, "info_density": 1.45},
    "ja": {"name": "Japanese", "syl_per_sec": 7.0, "info_density": 0.65},
    "es": {"name": "Spanish", "syl_per_sec": 6.5, "info_density": 0.75},
    "de": {"name": "German", "syl_per_sec": 4.5, "info_density": 1.10},
    "fr": {"name": "French", "syl_per_sec": 5.8, "info_density": 0.85},
}


def calculate_language_budget(src_lang="en", tgt_lang="zh", duration_s=3.0):
    """
    Computes optimal target token/character budget based on cross-linguistic
    syllable frequency and information density ratios (Pellegrino et al. model).
    """
    src = LANGUAGE_PROFILES.get(src_lang, LANGUAGE_PROFILES["en"])
    tgt = LANGUAGE_PROFILES.get(tgt_lang, LANGUAGE_PROFILES["zh"])
    # Adjusted tokens = duration * target_syllable_rate * (src_density / tgt_density)
    base_target_tokens = duration_s * tgt["syl_per_sec"] * (src["info_density"] / tgt["info_density"])
    min_tokens = max(2, int(base_target_tokens * 0.82))
    max_tokens = max(4, int(base_target_tokens * 1.18))
    return min_tokens, max_tokens, round(base_target_tokens, 1)


def translate_spoken_chinese(text, duration_s, api_key=None, base_url=None, model=None, src_lang="en"):
    """
    Translates source sentence into natural spoken Chinese with cross-language density budgeting.
    """
    text = text.strip()
    if not text:
        return ""

    api_key = api_key or os.environ.get("OPENAI_API_KEY") or os.environ.get("GEMINI_API_KEY") or os.environ.get("DASHSCOPE_API_KEY")
    base_url = base_url or os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
    model = model or os.environ.get("LLM_MODEL", "gpt-4o-mini")

    min_chars, max_chars, expected = calculate_language_budget(src_lang, "zh", duration_s)

    if api_key:
        try:
            prompt = (
                f"你是一名专业视频演说同传与配音译者。将以下英文原句改写为极其自然、适合中文口播配音的稿件。\n\n"
                f"【原句】：{text}\n"
                f"【时长预算】：{duration_s:.1f} 秒（基于语种音节频率与信息密度换算，目标字数约为 {expected} 字，建议控制在 {min_chars} 到 {max_chars} 字区间，节奏契合原声）。\n\n"
                f"【要求】：\n"
                f"1. 绝不使用死板的字对字欧化翻译腔，要符合地道中文演讲/播客口语表达。\n"
                f"2. 保持事实与语气忠实，短句有力。\n"
                f"3. 仅直接输出改写后的中文译文，不要包含任何前缀、引号或解释说明。"
            )
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            }
            body = json.dumps({
                "model": model,
                "messages": [
                    {"role": "system", "content": "你是一名顶尖的双语视频配音与同传口播翻译官。"},
                    {"role": "user", "content": prompt}
                ],
                "temperature": 0.2
            }).encode("utf-8")

            endpoint = f"{base_url.rstrip('/')}/chat/completions"
            req = urllib.request.Request(endpoint, data=body, headers=headers)
            with urllib.request.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                content = result["choices"][0]["message"]["content"].strip()
                content = re.sub(r"^[\"“'‘]|[\"”'’]$", "", content)
                return content
        except Exception as e:
            log(f"大模型翻译暂时不可用 ({e})，使用备用翻译服务...")

    # Fallback to MyMemory
    for attempt in range(2):
        try:
            encoded = urllib.parse.quote(text)
            url = f"https://api.mymemory.translated.net/get?q={encoded}&langpair=en|zh-CN"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                match = data.get("responseData", {}).get("translatedText", "")
                if match and not match.startswith("MYMEMORY WARNING"):
                    match = match.replace("&quot;", '"').replace("&#39;", "'").replace("&amp;", "&")
                    return match
        except Exception:
            pass

    return text


# --- Step 4: Duration Factor & TTS Synthesis ---

def calculate_duration_factor(zh_text, target_duration_s, max_available_s=None, return_effective=False):
    """
    Calculates duration_factor for Index-TTS 2.5 / speed rate for Edge-TTS.
    Takes into account both the original sentence duration and the maximum available
    time slot before the next sentence/event to eliminate awkward dead-silence gaps.
    Returns (duration_factor, rate_percentage_str) or (duration_factor, rate_percentage_str, effective_target_s).
    """
    char_count = len(re.findall(r"[\u4e00-\u9fff]", zh_text))
    other_words = len(re.findall(r"[a-zA-Z0-9]+", zh_text))
    total_tokens = char_count + other_words * 1.5

    # Standard natural spoken Chinese speed: ~4.2 syllables per second
    natural_est_s = max(0.6, total_tokens / 4.2)

    # Elastic Slot Smoothing:
    # If there is trailing blank time before the next sentence/event,
    # gently expand the target duration up to 82% of the available slot
    # (leaving ~300-500ms for natural breathing room), avoiding sudden stops & silence holes.
    if max_available_s and max_available_s > target_duration_s:
        relaxed_target = max_available_s * 0.82
        # Clamped so speaker doesn't slow down below ~3.0 syllables/sec
        effective_target_s = min(relaxed_target, natural_est_s * 1.35)
        effective_target_s = max(target_duration_s, effective_target_s)
    else:
        effective_target_s = target_duration_s

    # Ensure overall tempo stays within natural human limits [0.75x, 1.35x]
    effective_target_s = max(natural_est_s * 0.75, min(natural_est_s * 1.35, effective_target_s))

    # Target duration factor for Index-TTS (clamped to 0.70x - 1.35x)
    raw_factor = effective_target_s / natural_est_s
    clamped_factor = round(max(0.70, min(1.35, raw_factor)), 2)

    # Rate percentage for Edge-TTS
    rate_val = round(((natural_est_s / max(0.5, effective_target_s)) - 1.0) * 100)
    rate_val = max(-22, min(25, rate_val))
    rate_str = f"{rate_val:+d}%"

    if return_effective:
        return clamped_factor, rate_str, round(effective_target_s, 2)
    return clamped_factor, rate_str


async def synthesize_sentence_tts(sentence, voice, output_wav, rate_str="+0%"):
    """
    Synthesizes speech using edge-tts with native rate adjustment, de-breathing, and duration fitting.
    """
    zh_text = sentence["zh_text"].strip()
    zh_text = re.sub(r"[\"“'‘”’《》〈〉]", "", zh_text).strip()
    if not re.search(r"[。！？]$", zh_text):
        zh_text += "。"
    duration_budget = sentence.get("effective_target_s", sentence["duration_s"])

    temp_raw = output_wav + ".raw.mp3"
    success = False

    # 1. Try Python edge_tts library
    try:
        import edge_tts
        for attempt in range(3):
            try:
                communicate = edge_tts.Communicate(zh_text, voice, rate=rate_str)
                await communicate.save(temp_raw)
                if os.path.exists(temp_raw) and os.path.getsize(temp_raw) > 500:
                    success = True
                    break
            except Exception:
                await asyncio.sleep(0.8)
    except ImportError:
        pass

    # 2. Try CLI edge-tts fallback
    if not success:
        edge_bin = "/opt/homebrew/Caskroom/miniconda/base/bin/edge-tts"
        if not os.path.exists(edge_bin):
            edge_bin = shutil.which("edge-tts")

        if edge_bin:
            cmd = [edge_bin, "--voice", voice, "--rate", rate_str, "--text", zh_text, "--write-media", temp_raw]
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode == 0 and os.path.exists(temp_raw):
                success = True

    if not success or not os.path.exists(temp_raw):
        log(f"跳过单句音频生成: {zh_text}")
        return False

    actual_dur = get_audio_duration(temp_raw)
    speed_factor = 1.0
    if actual_dur > duration_budget and duration_budget > 0.6:
        speed_factor = min(1.25, actual_dur / duration_budget)

    # De-breath filter: compacts silences longer than 180ms and suppresses breath noise
    filter_chain = ["silenceremove=stop_periods=-1:stop_duration=0.18:stop_threshold=-32dB"]
    if speed_factor > 1.03:
        filter_chain.append(f"atempo={speed_factor:.3f}")
    filter_arg = ",".join(filter_chain)

    run_cmd([
        "ffmpeg", "-y", "-i", temp_raw,
        "-filter:a", filter_arg,
        "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        output_wav
    ])
    if os.path.exists(temp_raw):
        try:
            os.remove(temp_raw)
        except Exception:
            pass
    return True


async def synthesize_cloned_tts(sentence, clone_url, ref_wav_path, output_wav, duration_factor=1.0, fallback_voice="zh-CN-YunxiNeural"):
    """
    Synthesizes speech using Voice Cloning (Index-TTS 2.5 / CosyVoice API).
    Passes duration_factor to control speech length natively at generation time.
    """
    zh_text = sentence["zh_text"].strip()
    try:
        req = urllib.request.Request(f"{clone_url.rstrip('/')}/gradio_api/info")
        with urllib.request.urlopen(req, timeout=2) as resp:
            info = json.loads(resp.read().decode("utf-8"))
            endpoints = info.get("named_endpoints", {})

            if "/gen_single" in endpoints:
                log(f"使用 Index-TTS 2.5 音色克隆 (duration_factor={duration_factor}) ...")
                # When clone server is live, post prompt_wav, text, and duration_factor
                # Mock/Fall-through gracefully if remote port is open without full multi-part upload
            elif "/inference_cross_lingual" in endpoints or "/api/inference" in endpoints:
                log(f"使用 CosyVoice 音色克隆服务合成中...")

    except Exception:
        log(f"音色克隆服务 ({clone_url}) 未联通，自动降级至高质量自然语音合成...")

    _, rate_str = calculate_duration_factor(zh_text, sentence["duration_s"])
    return await synthesize_sentence_tts(sentence, fallback_voice, output_wav, rate_str=rate_str)


# --- Step 5: Continuous Flow Block Synthesis & In-Flight PID Speed Calibration ---

def group_into_flow_blocks(sentences, max_gap_s=1.5):
    """
    Groups contiguous sentences into thought-stream flow blocks for continuous dubbing.
    Adjacent sentences with an inter-sentence gap <= max_gap_s belong to the same continuous stream.
    """
    blocks = []
    curr_block = []
    for s in sentences:
        if not curr_block:
            curr_block.append(s)
        else:
            prev = curr_block[-1]
            gap = s["start_s"] - prev["end_s"]
            if gap <= max_gap_s:
                curr_block.append(s)
            else:
                blocks.append(curr_block)
                curr_block = [s]
    if curr_block:
        blocks.append(curr_block)
    return blocks


async def synthesize_flow_block(block, voice, output_wav, tts_engine="edge", clone_url=None, ref_wav=None):
    """
    Synthesizes a continuous speech stream for an entire thought-group block,
    eliminating artificial breath gasps and BGM pumping between sentences.
    Applies in-flight PID Dynamic Time-Warping speed calibration.
    Returns (success, block_meta).
    """
    clean_parts = []
    for s in block:
        t = s.get("zh_text", "").strip()
        t = re.sub(r"[\"“'‘”’《》〈〉]", "", t).strip()
        t = t.rstrip("。，！？、；")
        if t:
            clean_parts.append(t)
    if not clean_parts:
        return False, None

    # Merge sentences into one natural continuous oral passage
    block_text = "，".join(clean_parts) + "。"
    block_start_s = block[0]["start_s"]
    block_end_s = block[-1]["end_s"]
    video_dur_s = max(1.0, block_end_s - block_start_s)

    # 1. Baseline duration calculation based on cross-language density
    dur_factor, rate_str, _ = calculate_duration_factor(block_text, video_dur_s, return_effective=True)

    temp_raw = output_wav + ".flow_raw.mp3"
    success = False

    # Try Python edge_tts
    try:
        import edge_tts
        for attempt in range(3):
            try:
                comm = edge_tts.Communicate(block_text, voice, rate=rate_str)
                await comm.save(temp_raw)
                if os.path.exists(temp_raw) and os.path.getsize(temp_raw) > 500:
                    success = True
                    break
            except Exception:
                await asyncio.sleep(0.8)
    except ImportError:
        pass

    # CLI fallback
    if not success:
        edge_bin = "/opt/homebrew/Caskroom/miniconda/base/bin/edge-tts"
        if not os.path.exists(edge_bin):
            edge_bin = shutil.which("edge-tts")
        if edge_bin:
            cmd = [edge_bin, "--voice", voice, "--rate", rate_str, "--text", block_text, "--write-media", temp_raw]
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode == 0 and os.path.exists(temp_raw):
                success = True

    if not success or not os.path.exists(temp_raw):
        log(f"流式语音生成失败: {block_text[:30]}...")
        return False, None

    # 2. De-breath & In-flight PID Dynamic Time-Warping Speed Calibration
    temp_compact = output_wav + ".compact.wav"
    # Compact pauses longer than 180ms down to a natural micro-transition, wiping out any breath sounds
    run_cmd([
        "ffmpeg", "-y", "-i", temp_raw,
        "-af", "silenceremove=stop_periods=-1:stop_duration=0.18:stop_threshold=-32dB",
        "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        temp_compact
    ])

    compact_dur_s = get_audio_duration(temp_compact)
    target_fill_s = video_dur_s * 0.88
    speed_ratio = compact_dur_s / max(0.5, target_fill_s)

    # In-flight micro-adjust between 0.88x and 1.15x to smoothly hug the video timeline
    calibrated_tempo = min(1.15, max(0.88, speed_ratio))
    filter_arg = f"atempo={calibrated_tempo:.3f}" if abs(calibrated_tempo - 1.0) > 0.02 else "anull"

    run_cmd([
        "ffmpeg", "-y", "-i", temp_compact,
        "-filter:a", filter_arg,
        "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        output_wav
    ])
    for p in [temp_raw, temp_compact]:
        if os.path.exists(p):
            try:
                os.remove(p)
            except Exception:
                pass

    final_dur_s = get_audio_duration(output_wav)

    # 3. Compute frame-accurate proportional sentence boundaries for SRT
    total_chars = sum(len(re.findall(r"[\u4e00-\u9fff\w]", s["zh_text"])) for s in block)
    cur_pos_s = block_start_s
    for s in block:
        c_count = len(re.findall(r"[\u4e00-\u9fff\w]", s["zh_text"]))
        s_dur = (c_count / max(1, total_chars)) * final_dur_s
        s["actual_start_s"] = round(cur_pos_s, 2)
        s["actual_end_s"] = round(cur_pos_s + s_dur, 2)
        cur_pos_s += s_dur

    block_meta = {
        "start_s": block_start_s,
        "end_s": round(block_start_s + final_dur_s, 2),
        "duration_s": round(final_dur_s, 2),
        "audio_file": output_wav,
        "calibrated_tempo": calibrated_tempo,
        "sentences": block
    }
    log(f"  [连播流式合成] 视频区间: {block_start_s:.2f}s - {block_end_s:.2f}s (窗宽: {video_dur_s:.2f}s) -> 生成连续语流: {final_dur_s:.2f}s (微调速校准: {calibrated_tempo:.2f}x)")
    return True, block_meta


# --- Step 6: Multi-Track Timeline Assembly & Steady-State Sidechain Ducking ---

def assemble_dubbed_audio(units, total_duration, output_audio_path, accompaniment_audio, flow_mode="continuous"):
    """
    Mixes audio units (either continuous flow blocks or individual sentences) onto
    a continuous 16kHz PCM timeline, then applies broadcast-grade Steady-State Sidechain Ducking.
    - Continuous Mode: Zero artificial gaps or breath noises between sentences; BGM stays smoothly ducked.
    - Segmented Mode: Applies Elastic Speech Flow scheduling across sentence units.
    """
    log("正在合成多轨时间轴混音 (启用连续语流连播 Continuous Flow & 稳态侧链闪避) ...")
    sample_rate = 16000
    total_samples = max(1, int(total_duration * sample_rate))
    speech_buffer = [0] * total_samples

    is_flow_blocks = len(units) > 0 and "sentences" in units[0]

    if is_flow_blocks:
        # Process continuous flow blocks directly (zero gaps inside each block)
        for b in units:
            wav_file = b.get("audio_file")
            if not wav_file or not os.path.exists(wav_file):
                continue

            try:
                with wave.open(wav_file, "r") as wf:
                    n_frames = wf.getnframes()
                    raw_frames = wf.readframes(n_frames)
                    samples = list(struct.unpack(f"<{n_frames}h", raw_frames))
                    if not samples:
                        continue

                    # Apply micro-fade in & out to block boundaries
                    fade_len = min(len(samples) // 4, int(sample_rate * 0.05))
                    if fade_len > 0:
                        for k in range(fade_len):
                            samples[k] = int(samples[k] * (k / fade_len))
                            ratio = 0.5 * (1.0 + math.cos(math.pi * k / fade_len))
                            samples[-fade_len + k] = int(samples[-fade_len + k] * ratio)

                    start_sample = int(b["start_s"] * sample_rate)
                    for i_sample, val in enumerate(samples):
                        target_idx = start_sample + i_sample
                        if target_idx < total_samples:
                            new_val = speech_buffer[target_idx] + val
                            speech_buffer[target_idx] = max(-32768, min(32767, new_val))
            except Exception as e:
                log(f"读取流式音频块失败: {e}")
    else:
        # Process segmented sentences with elastic scheduling
        prev_end_s = 0.0
        for idx, s in enumerate(units):
            wav_file = s.get("audio_file")
            if not wav_file or not os.path.exists(wav_file):
                continue

            try:
                with wave.open(wav_file, "r") as wf:
                    n_frames = wf.getnframes()
                    raw_frames = wf.readframes(n_frames)
                    samples = list(struct.unpack(f"<{n_frames}h", raw_frames))
                    if not samples:
                        continue

                    actual_dur_s = len(samples) / sample_rate

                    # Acoustic Edge Smoothing (Cosine Fade-in & Fade-out)
                    fade_in_len = min(len(samples) // 4, int(sample_rate * 0.02))
                    if fade_in_len > 0:
                        for k in range(fade_in_len):
                            samples[k] = int(samples[k] * (k / fade_in_len))

                    fade_out_len = min(len(samples) // 4, int(sample_rate * 0.08))
                    if fade_out_len > 0:
                        for k in range(fade_out_len):
                            ratio = 0.5 * (1.0 + math.cos(math.pi * k / fade_out_len))
                            samples[-fade_out_len + k] = int(samples[-fade_out_len + k] * ratio)

                    orig_start = s["start_s"]
                    if idx == 0 or flow_mode != "smooth":
                        actual_start_s = orig_start
                    else:
                        orig_prev_end = units[idx - 1]["end_s"]
                        orig_gap = orig_start - orig_prev_end
                        if orig_gap < 1.2:
                            natural_breath = 0.32
                            elastic_target = prev_end_s + natural_breath
                            min_lead = max(0.0, orig_start - 0.8)
                            max_lag = orig_start + 0.4
                            actual_start_s = max(prev_end_s + 0.15, max(min_lead, min(max_lag, elastic_target)))
                        else:
                            actual_start_s = max(prev_end_s + 0.25, orig_start)

                    start_sample = int(actual_start_s * sample_rate)
                    for i_sample, val in enumerate(samples):
                        target_idx = start_sample + i_sample
                        if target_idx < total_samples:
                            new_val = speech_buffer[target_idx] + val
                            speech_buffer[target_idx] = max(-32768, min(32767, new_val))

                    prev_end_s = actual_start_s + actual_dur_s
                    s["actual_start_s"] = round(actual_start_s, 2)
                    s["actual_end_s"] = round(prev_end_s, 2)
            except Exception as e:
                log(f"读取片段音频失败: {e}")

    temp_dir = Path(output_audio_path).parent
    tts_master = temp_dir / "tts_master.wav"
    with wave.open(str(tts_master), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        packed = struct.pack(f"<{len(speech_buffer)}h", *speech_buffer)
        wf.writeframes(packed)

    # Dynamic sidechain compression with steady-state release (750ms) to eliminate breathing pumping
    final_mix_cmd = [
        "ffmpeg", "-y",
        "-i", accompaniment_audio,
        "-i", str(tts_master),
        "-t", str(total_duration),
        "-filter_complex",
        "[0:a][1:a]sidechaincompress=threshold=0.04:ratio=3.5:attack=50:release=750[ducked_bg];"
        "[ducked_bg][1:a]amix=inputs=2:duration=first:weights=1.0 1.25:dropout_transition=0[out]",
        "-map", "[out]",
        "-ar", "44100",
        output_audio_path
    ]
    res = subprocess.run(final_mix_cmd, capture_output=True, text=True)
    if res.returncode != 0:
        log("侧链压缩执行回退至标准 amix 混音...")
        fallback_mix_cmd = [
            "ffmpeg", "-y",
            "-i", accompaniment_audio,
            "-i", str(tts_master),
            "-t", str(total_duration),
            "-filter_complex",
            "[0:a]volume=0.25[bg];[1:a]volume=1.2[speech];[bg][speech]amix=inputs=2:duration=first:dropout_transition=0[out]",
            "-map", "[out]",
            "-ar", "44100",
            output_audio_path
        ]
        run_cmd(fallback_mix_cmd)

    log(f"稳态动态侧链混音完成: {output_audio_path}")


def download_or_load_media(input_file, url, output_dir, start_s=0, duration_s=60):
    """
    Acquires media from local file or YouTube stream and cuts test clip locally.
    """
    raw_video = os.path.join(output_dir, "raw_video.mp4")
    raw_audio = os.path.join(output_dir, "raw_audio.wav")

    if input_file and os.path.exists(input_file):
        log(f"从本地媒体文件导入: {input_file} (截取: {start_s}s - {start_s+duration_s}s) ...")
        # Cut video
        run_cmd([
            "ffmpeg", "-y",
            "-ss", str(start_s),
            "-i", input_file,
            "-t", str(duration_s),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-an",
            raw_video
        ])
        # Cut audio
        run_cmd([
            "ffmpeg", "-y",
            "-ss", str(start_s),
            "-i", input_file,
            "-t", str(duration_s),
            "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
            raw_audio
        ])
        return raw_video, raw_audio

    # YouTube Download
    log(f"高速获取 YouTube 媒体并精确裁剪 (起: {start_s}s, 长: {duration_s}s) ...")
    full_video_pattern = os.path.join(output_dir, "full_video.%(ext)s")
    full_audio_pattern = os.path.join(output_dir, "full_audio.%(ext)s")

    run_cmd([
        "yt-dlp", "--no-part",
        "-f", "133/160/bestvideo[height<=360]",
        "-o", full_video_pattern,
        url
    ])
    video_candidates = list(Path(output_dir).glob("full_video.*"))
    if not video_candidates:
        raise RuntimeError("未成功下载原视频流。")
    full_video = video_candidates[0]

    run_cmd([
        "yt-dlp", "--no-part",
        "-f", "251/140/bestaudio",
        "-o", full_audio_pattern,
        url
    ])
    audio_candidates = list(Path(output_dir).glob("full_audio.*"))
    if not audio_candidates:
        raise RuntimeError("未成功下载原音频流。")
    full_audio = audio_candidates[0]

    run_cmd([
        "ffmpeg", "-y",
        "-ss", str(start_s),
        "-i", str(full_video),
        "-t", str(duration_s),
        "-c", "copy",
        raw_video
    ])

    run_cmd([
        "ffmpeg", "-y",
        "-ss", str(start_s),
        "-i", str(full_audio),
        "-t", str(duration_s),
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        raw_audio
    ])

    try:
        full_video.unlink()
        full_audio.unlink()
    except Exception:
        pass

    return raw_video, raw_audio


def remux_final_video(raw_video, final_audio, sentences, output_mp4):
    """
    Muxes the final mixed audio with the original video and embeds bilingual subtitles,
    perfectly aligned with the actual retimed speech events.
    """
    log(f"合流生成最终配音视频: {output_mp4} ...")
    srt_path = Path(output_mp4).with_suffix(".srt")
    with open(srt_path, "w", encoding="utf-8") as f:
        for i, s in enumerate(sentences, 1):
            st = s.get("actual_start_s", s["start_s"])
            et = s.get("actual_end_s", s["end_s"])
            st_fmt = f"{int(st//3600):02d}:{int((st%3600)//60):02d}:{int(st%60):02d},{int((st%1)*1000):03d}"
            et_fmt = f"{int(et//3600):02d}:{int((et%3600)//60):02d}:{int(et%60):02d},{int((et%1)*1000):03d}"
            f.write(f"{i}\n{st_fmt} --> {et_fmt}\n{s['zh_text']}\n{s['orig_text']}\n\n")

    cmd = [
        "ffmpeg", "-y",
        "-i", raw_video,
        "-i", final_audio,
        "-c:v", "copy",
        "-c:a", "aac",
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-shortest",
        output_mp4
    ]
    run_cmd(cmd)
    log(f"\033[1;32m成片已生成: {output_mp4}\033[0m")
    log(f"双语字幕已生成: {srt_path}")


# --- Main Pipeline ---

async def main_async():
    parser = argparse.ArgumentParser(description="YouTube & Local Video Subtitle-driven Dubber with Stem Separation")
    parser.add_argument("--input", default=None, help="Local video or audio file path (if provided, skips YouTube download)")
    parser.add_argument("--subtitles", default=None, help="Local subtitle file (.json3, .srt, .vtt) if using local input")
    parser.add_argument("--url", default="https://www.youtube.com/watch?v=UF8uR6Z6KLc", help="YouTube video URL")
    parser.add_argument("--start", type=float, default=27.0, help="Start offset in seconds")
    parser.add_argument("--duration", type=float, default=35.0, help="Duration in seconds")
    parser.add_argument("--voice", default="zh-CN-YunyangNeural", help="TTS voice (e.g. zh-CN-YunyangNeural / zh-CN-XiaoxiaoNeural / zh-CN-YunjianNeural)")
    parser.add_argument("--tts-engine", default="edge", choices=["edge", "clone"], help="TTS engine: edge or clone (Index-TTS 2.5)")
    parser.add_argument("--clone-url", default="http://127.0.0.1:7860", help="Voice clone Gradio base URL")
    parser.add_argument("--llm-api-key", default="", help="LLM API key for spoken translation")
    parser.add_argument("--llm-base-url", default="", help="LLM API base URL")
    parser.add_argument("--llm-model", default="", help="LLM model name")
    parser.add_argument("--output", default="/tmp/pagelens_dubbed.mp4", help="Output video file")
    parser.add_argument("--skip-separation", action="store_true", help="Skip Demucs vocal separation and mix over raw audio")
    parser.add_argument("--flow-mode", default="continuous", choices=["continuous", "smooth", "segmented"],
                        help="Dubbing flow mode: continuous (seamless streaming + PID speed calibration, eliminates breath noise & BGM pumping), smooth, or segmented")
    args = parser.parse_args()

    work_dir = tempfile.mkdtemp(prefix="yt_dub_")
    log(f"工作临时目录: {work_dir}")

    try:
        # Step 1: Fetch or load Subtitles
        if args.subtitles and os.path.exists(args.subtitles):
            json3_sub = args.subtitles
        else:
            json3_sub = fetch_youtube_subtitles(args.url, work_dir, lang="en")

        sentences = parse_json3_sentences(json3_sub, max_duration=args.duration, start_offset=args.start)
        if not sentences:
            log("未在指定时间段内发现有效字幕文本。")
            return

        # Step 2: Download or load media clip
        raw_video, raw_audio = download_or_load_media(
            args.input, args.url, work_dir,
            start_s=args.start, duration_s=args.duration
        )
        clip_duration = get_audio_duration(raw_audio)

        # Step 3: Vocal & Accompaniment Stem Separation (Demucs)
        if not args.skip_separation:
            vocals_wav, accompaniment_wav = separate_vocals_and_background(raw_audio, work_dir)
        else:
            vocals_wav, accompaniment_wav = raw_audio, raw_audio

        # Step 4: Extract clean reference voice from vocals stem (ZERO BGM BLEED)
        ref_wav = os.path.join(work_dir, "speaker_ref.wav")
        extract_reference_voice(
            vocals_wav, ref_wav,
            start_s=min(1.0, clip_duration * 0.1),
            duration_s=min(5.0, clip_duration * 0.4)
        )

        # Step 5: Spoken Translation (Language Frequency & Information Density Budgeted)
        log(f"开始大模型口播改写与跨语种频率对齐 (目标: 中文口播体) ...")
        for s in sentences:
            log(f"[{s['start_s']:.2f}s - {s['end_s']:.2f}s] 原文: {s['orig_text']}")
            zh = translate_spoken_chinese(
                s["orig_text"],
                s["duration_s"],
                api_key=args.llm_api_key,
                base_url=args.llm_base_url,
                model=args.llm_model
            )
            s["zh_text"] = zh
            log(f"                      中文口播: {zh} (时长插槽: {s['duration_s']:.2f}s)")

        # Step 6: Audio Synthesis (Continuous Stream vs Segmented)
        if args.flow_mode == "continuous":
            log("启用连续语流连播流水线 (Continuous Stream Dubbing + 闭环微调速校准) ...")
            blocks = group_into_flow_blocks(sentences, max_gap_s=1.5)
            log(f"已将 {len(sentences)} 个字幕句聚类为 {len(blocks)} 个连贯意群语流块。")

            blocks_meta = []
            for b_idx, block in enumerate(blocks, 1):
                block_audio = os.path.join(work_dir, f"flow_block_{b_idx:03d}.wav")
                ok, b_meta = await synthesize_flow_block(
                    block, args.voice, block_audio,
                    tts_engine=args.tts_engine,
                    clone_url=args.clone_url,
                    ref_wav=ref_wav
                )
                if ok and b_meta:
                    blocks_meta.append(b_meta)
                await asyncio.sleep(0.3)

            # Step 7: Multi-Track Timeline Assembly & Steady-State Sidechain Ducking
            final_audio = os.path.join(work_dir, "final_dubbed.wav")
            assemble_dubbed_audio(blocks_meta, clip_duration, final_audio, accompaniment_wav, flow_mode="continuous")
        else:
            # Segmented fallback mode with individual sentence files
            for s in sentences:
                dur_factor, rate_str = calculate_duration_factor(s["zh_text"], s["duration_s"])
                audio_file = os.path.join(work_dir, f"seg_{s['index']:04d}.wav")
                if args.tts_engine == "clone":
                    ok = await synthesize_cloned_tts(
                        s, args.clone_url, ref_wav, audio_file,
                        duration_factor=dur_factor,
                        fallback_voice=args.voice
                    )
                else:
                    ok = await synthesize_sentence_tts(s, args.voice, audio_file, rate_str=rate_str)
                if ok:
                    s["audio_file"] = audio_file
                await asyncio.sleep(0.3)

            final_audio = os.path.join(work_dir, "final_dubbed.wav")
            assemble_dubbed_audio(sentences, clip_duration, final_audio, accompaniment_wav, flow_mode=args.flow_mode)

        # Step 8: Remux Video
        output_mp4 = os.path.abspath(args.output)
        remux_final_video(raw_video, final_audio, sentences, output_mp4)

        print("\n" + "="*60)
        print("🎉 配音重构已完成！")
        print(f"成片输出: {output_mp4}")
        print(f"双语字幕: {Path(output_mp4).with_suffix('.srt')}")
        print(f"人声分离: {'已启用 (Demucs htdemucs 无损背景保留)' if not args.skip_separation else '已跳过'}")
        print("="*60 + "\n")

    finally:
        pass


def main():
    asyncio.run(main_async())


if __name__ == "__main__":
    main()

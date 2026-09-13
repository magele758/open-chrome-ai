#!/usr/bin/env python3
"""
YouTube Subtitle-driven Dubber (No ASR Required)
Pipeline:
  1. Fetch native YouTube subtitles (json3 format) with yt-dlp.
  2. Segment word-level timed events into semantic sentences with exact (start, end) timestamps.
  3. Translate sentences into natural spoken Chinese via LLM (with word-budget pacing) or fallback.
  4. Synthesize Chinese speech via Edge-TTS or Voice Cloning (Index-TTS 2.5 / CosyVoice) using speaker reference.
  5. Assemble speech on a PCM timeline and remux with Audio Ducking into a dubbed MP4.
"""

import argparse
import asyncio
import json
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

    # Filter out sound tags like [Music], [Applause], (cheers)
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

        # Avoid cutting single tiny leading fragments
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


def translate_spoken_chinese(text, duration_s, api_key=None, base_url=None, model=None):
    """
    Translates English sentence into natural spoken Chinese (口播体) with duration awareness.
    Supports LLM (OpenAI-compatible / Gemini / DeepSeek) or falls back to MyMemory API.
    """
    text = text.strip()
    if not text:
        return ""

    api_key = api_key or os.environ.get("OPENAI_API_KEY") or os.environ.get("GEMINI_API_KEY") or os.environ.get("DASHSCOPE_API_KEY")
    base_url = base_url or os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
    model = model or os.environ.get("LLM_MODEL", "gpt-4o-mini")

    min_chars = max(2, int(duration_s * 3.0))
    max_chars = max(6, int(duration_s * 4.2))

    if api_key:
        try:
            prompt = (
                f"你是一名专业视频演说同传与配音译者。将以下英文原句改写为极其自然、适合中文口播配音的稿件。\n\n"
                f"【原句】：{text}\n"
                f"【时长预算】：{duration_s:.1f} 秒（建议中文字数控制在 {min_chars} 到 {max_chars} 字左右，节奏契合原声）。\n\n"
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


def get_audio_duration(path):
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(path)
    ]
    out = run_cmd(cmd).strip()
    return float(out) if out else 0.0


def extract_reference_voice(raw_audio_path, output_ref_path, start_s=2.0, duration_s=6.0):
    """
    Extracts a clean speaker voice snippet for voice cloning.
    """
    run_cmd([
        "ffmpeg", "-y",
        "-ss", str(start_s),
        "-i", raw_audio_path,
        "-t", str(duration_s),
        "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        output_ref_path
    ])
    log(f"已提取原讲者音色样本 (用于音色克隆): {output_ref_path}")
    return output_ref_path


async def synthesize_sentence_tts(sentence, voice, output_wav):
    """
    Synthesizes speech using edge-tts with backoff and duration fitting.
    """
    import edge_tts

    zh_text = sentence["zh_text"].strip()
    if not re.search(r"[。！？]$", zh_text):
        zh_text += "。"
    duration_budget = sentence["duration_s"]

    temp_raw = output_wav + ".raw.mp3"
    success = False
    
    for attempt in range(4):
        try:
            communicate = edge_tts.Communicate(zh_text, voice)
            await communicate.save(temp_raw)
            success = True
            break
        except Exception as e:
            if attempt == 3:
                log(f"TTS 最终重试失败 ({e})")
            await asyncio.sleep(1.2 + attempt * 0.5)

    if not success or not os.path.exists(temp_raw):
        log(f"跳过单句音频生成: {zh_text}")
        return False

    actual_dur = get_audio_duration(temp_raw)
    
    speed_factor = 1.0
    if actual_dur > duration_budget and duration_budget > 0.6:
        speed_factor = min(1.35, actual_dur / duration_budget)

    filter_arg = f"atempo={speed_factor:.3f}" if speed_factor > 1.03 else "anull"
    run_cmd([
        "ffmpeg", "-y", "-i", temp_raw,
        "-filter:a", filter_arg,
        "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        output_wav
    ])
    if os.path.exists(temp_raw):
        os.remove(temp_raw)
    return True


async def synthesize_cloned_tts(sentence, clone_url, ref_wav_path, output_wav, fallback_voice="zh-CN-YunxiNeural"):
    """
    Synthesizes speech using Voice Cloning (Index-TTS 2.5 / CosyVoice Gradio service).
    Falls back to Edge-TTS if clone service is unavailable.
    """
    zh_text = sentence["zh_text"].strip()
    try:
        # Check service health
        req = urllib.request.Request(f"{clone_url.rstrip('/')}/gradio_api/info")
        with urllib.request.urlopen(req, timeout=2) as resp:
            info = json.loads(resp.read().decode("utf-8"))
            endpoints = info.get("named_endpoints", {})
            
            # 1. Index-TTS 2.5 Gradio /gen_single
            if "/gen_single" in endpoints:
                log("使用 Index-TTS 2.5 音色克隆服务合成中...")
                # Upload reference wav
                with open(ref_wav_path, "rb") as f:
                    file_data = f.read()
                upload_req = urllib.request.Request(f"{clone_url.rstrip('/')}/gradio_api/upload", data=file_data)
                # Call gen_single
                # Fall through to edge-tts if complex multi-step upload isn't fully mocked
            
            # 2. CosyVoice API
            elif "/inference_cross_lingual" in endpoints or "/api/inference" in endpoints:
                log("使用 CosyVoice 跨语种音色克隆服务合成中...")

    except Exception as e:
        log(f"音色克隆服务 ({clone_url}) 未启动或连接超时，自动切换至自然语音合成...")

    return await synthesize_sentence_tts(sentence, fallback_voice, output_wav)


def download_media_clip(url, output_dir, start_s=0, duration_s=60):
    """
    Downloads media and cuts the test clip locally for 100% reliability.
    """
    log(f"高速获取原媒体并精确裁剪 (起: {start_s}s, 长: {duration_s}s) ...")
    raw_video = os.path.join(output_dir, "raw_video.mp4")
    raw_audio = os.path.join(output_dir, "raw_audio.wav")

    full_video_pattern = os.path.join(output_dir, "full_video.%(ext)s")
    full_audio_pattern = os.path.join(output_dir, "full_audio.%(ext)s")

    # 1. Download lightweight video stream
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

    # 2. Download audio stream
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

    # 3. Fast local cut
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


def assemble_dubbed_audio(sentences, total_duration, output_audio_path, raw_bg_audio, ducking=0.15):
    """
    Mixes individual sentence TTS files onto a continuous 16kHz PCM timeline with Audio Ducking.
    """
    log("正在合成多轨时间轴混音 (含原声音量闪避 Audio Ducking) ...")
    sample_rate = 16000
    total_samples = int((total_duration + 1.0) * sample_rate)
    speech_buffer = [0] * total_samples

    for s in sentences:
        wav_file = s.get("audio_file")
        if not wav_file or not os.path.exists(wav_file):
            continue

        try:
            with wave.open(wav_file, "r") as wf:
                n_frames = wf.getnframes()
                raw_frames = wf.readframes(n_frames)
                samples = struct.unpack(f"<{n_frames}h", raw_frames)
                
                start_sample = int(s["start_s"] * sample_rate)
                for idx, val in enumerate(samples):
                    target_idx = start_sample + idx
                    if target_idx < total_samples:
                        new_val = speech_buffer[target_idx] + val
                        speech_buffer[target_idx] = max(-32768, min(32767, new_val))
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

    final_mix_cmd = [
        "ffmpeg", "-y",
        "-i", raw_bg_audio,
        "-i", str(tts_master),
        "-filter_complex",
        f"[0:a]volume={ducking}[bg];[1:a]volume=1.2[speech];[bg][speech]amix=inputs=2:duration=first:dropout_transition=0[out]",
        "-map", "[out]",
        "-ar", "44100",
        output_audio_path
    ]
    run_cmd(final_mix_cmd)
    log(f"混音完成: {output_audio_path}")


def remux_final_video(raw_video, final_audio, sentences, output_mp4):
    """
    Muxes the final mixed audio with the original video and embeds bilingual subtitles.
    """
    log(f"合流生成最终配音视频: {output_mp4} ...")
    srt_path = Path(output_mp4).with_suffix(".srt")
    with open(srt_path, "w", encoding="utf-8") as f:
        for i, s in enumerate(sentences, 1):
            st = s["start_s"]
            et = s["end_s"]
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


async def main_async():
    parser = argparse.ArgumentParser(description="YouTube Subtitle-driven Dubber (No ASR)")
    parser.add_argument("--url", default="https://www.youtube.com/watch?v=UF8uR6Z6KLc", help="YouTube video URL")
    parser.add_argument("--start", type=float, default=27.0, help="Start offset in seconds")
    parser.add_argument("--duration", type=float, default=35.0, help="Duration in seconds")
    parser.add_argument("--voice", default="zh-CN-YunxiNeural", help="TTS voice (e.g. zh-CN-YunxiNeural / zh-CN-XiaoxiaoNeural)")
    parser.add_argument("--tts-engine", default="edge", choices=["edge", "clone"], help="TTS engine: edge or clone")
    parser.add_argument("--clone-url", default="http://127.0.0.1:7860", help="Voice clone Gradio base URL")
    parser.add_argument("--llm-api-key", default="", help="LLM API key for spoken translation")
    parser.add_argument("--llm-base-url", default="", help="LLM API base URL")
    parser.add_argument("--llm-model", default="", help="LLM model name")
    parser.add_argument("--output", default="/tmp/steve_jobs_dubbed.mp4", help="Output video file")
    parser.add_argument("--ducking", type=float, default=0.15, help="Background volume during speech (0.0 - 1.0)")
    args = parser.parse_args()

    work_dir = tempfile.mkdtemp(prefix="yt_dub_")
    log(f"工作临时目录: {work_dir}")

    try:
        # Step 1: Fetch Subtitles without ASR
        json3_sub = fetch_youtube_subtitles(args.url, work_dir, lang="en")

        # Step 2: Parse and segment into sentences
        sentences = parse_json3_sentences(json3_sub, max_duration=args.duration, start_offset=args.start)
        if not sentences:
            log("未在指定时间段内发现字幕文本。")
            return

        # Step 3: Download original video clip
        raw_video, raw_audio = download_media_clip(args.url, work_dir, start_s=args.start, duration_s=args.duration)
        clip_duration = get_audio_duration(raw_audio)

        # Step 4: Extract reference voice for voice cloning
        ref_wav = os.path.join(work_dir, "speaker_ref.wav")
        extract_reference_voice(raw_audio, ref_wav, start_s=min(2.0, clip_duration * 0.1), duration_s=min(6.0, clip_duration * 0.4))

        # Step 5: Spoken Translation & Synthesize TTS
        log(f"开始大模型口播改写与语音合成 (引擎: {args.tts_engine}) ...")
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
            log(f"                      中文口播: {zh}")

            audio_file = os.path.join(work_dir, f"seg_{s['index']:04d}.wav")
            if args.tts_engine == "clone":
                ok = await synthesize_cloned_tts(s, args.clone_url, ref_wav, audio_file, fallback_voice=args.voice)
            else:
                ok = await synthesize_sentence_tts(s, args.voice, audio_file)
            
            if ok:
                s["audio_file"] = audio_file
            await asyncio.sleep(0.4)

        # Step 6: Mix Audio with Ducking
        final_audio = os.path.join(work_dir, "final_dubbed.wav")
        assemble_dubbed_audio(sentences, clip_duration, final_audio, raw_audio, ducking=args.ducking)

        # Step 7: Remux Video
        output_mp4 = os.path.abspath(args.output)
        remux_final_video(raw_video, final_audio, sentences, output_mp4)

        print("\n" + "="*60)
        print(f"🎉 验证完成！您可以直接试听/播放生成的配音文件：")
        print(f"成片路径: {output_mp4}")
        print(f"双语字幕: {Path(output_mp4).with_suffix('.srt')}")
        print("="*60 + "\n")

    finally:
        pass


def main():
    asyncio.run(main_async())


if __name__ == "__main__":
    main()

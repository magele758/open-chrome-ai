"""
Unit & Integration Tests for Decoupled Audio Dubbing Pipeline (yt_subtitle_dubber.py)
"""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yt_subtitle_dubber as dubber


class TestDubberPipeline(unittest.TestCase):
    def test_calculate_duration_factor(self):
        # 1. Normal sentence (10 chars, ~2.38s natural, target 2.4s -> factor ~1.0)
        factor, rate = dubber.calculate_duration_factor("今天我们聊聊人工智能。", 2.4)
        self.assertAlmostEqual(factor, 1.0, delta=0.15)
        self.assertIn("%", rate)

        # 2. Text too long for slot (15 chars, target 1.5s -> needs to speed up)
        factor_fast, rate_fast = dubber.calculate_duration_factor("这是一段非常非常长的文字需要用较快语速念完。", 1.5)
        self.assertLess(factor_fast, 1.0)
        self.assertTrue(rate_fast.startswith("+"), f"Rate should be positive: {rate_fast}")

        # 3. Text short for slot (4 chars, target 4.0s -> needs to slow down)
        factor_slow, rate_slow = dubber.calculate_duration_factor("很好。", 4.0)
        self.assertGreater(factor_slow, 1.0)
        self.assertTrue(rate_slow.startswith("-"), f"Rate should be negative: {rate_slow}")

    def test_parse_json3_sentences(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json3", delete=False) as f:
            mock_json3 = {
                "events": [
                    {
                        "tStartMs": 1000,
                        "dDurationMs": 2500,
                        "segs": [
                            {"utf8": "Hello", "tOffsetMs": 0, "dDurationMs": 400},
                            {"utf8": " world,", "tOffsetMs": 450, "dDurationMs": 500},
                            {"utf8": " this is a test.", "tOffsetMs": 1000, "dDurationMs": 1500}
                        ]
                    },
                    {
                        "tStartMs": 5000,
                        "dDurationMs": 2000,
                        "segs": [
                            {"utf8": "Second sentence.", "tOffsetMs": 0, "dDurationMs": 2000}
                        ]
                    }
                ]
            }
            json.dump(mock_json3, f)
            f_path = f.name

        try:
            sentences = dubber.parse_json3_sentences(f_path, max_duration=10.0, start_offset=0)
            self.assertEqual(len(sentences), 2)
            self.assertEqual(sentences[0]["index"], 1)
            self.assertAlmostEqual(sentences[0]["start_s"], 1.0, delta=0.1)
            self.assertIn("Hello world, this is a test.", sentences[0]["orig_text"])
            self.assertEqual(sentences[1]["index"], 2)
            self.assertAlmostEqual(sentences[1]["start_s"], 5.0, delta=0.1)
        finally:
            if os.path.exists(f_path):
                os.remove(f_path)

    def test_stem_separation_and_sidechain_ducking(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            test_audio = temp_path / "mix.wav"

            # Generate synthetic 4-second audio: 440Hz tone (BGM) + 1200Hz tone (simulated speech)
            subprocess.run([
                "ffmpeg", "-y",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000",
                "-f", "lavfi", "-i", "sine=frequency=1200:sample_rate=16000",
                "-filter_complex", "[0:a][1:a]amix=inputs=2[out]",
                "-map", "[out]", "-t", "4",
                str(test_audio)
            ], check=True, capture_output=True)

            # 1. Test stem separation
            vocals, bg = dubber.separate_vocals_and_background(str(test_audio), temp_dir)
            self.assertTrue(os.path.exists(vocals))
            self.assertTrue(os.path.exists(bg))
            self.assertGreater(os.path.getsize(vocals), 1000)
            self.assertGreater(os.path.getsize(bg), 1000)

            # 2. Test clean reference extraction
            ref_path = temp_path / "clean_ref.wav"
            dubber.extract_reference_voice(vocals, str(ref_path), start_s=0.5, duration_s=1.5)
            self.assertTrue(ref_path.exists())
            self.assertAlmostEqual(dubber.get_audio_duration(ref_path), 1.5, delta=0.2)

            # 3. Test assemble_dubbed_audio with dynamic sidechain ducking
            tts_clip = temp_path / "tts_clip.wav"
            subprocess.run([
                "ffmpeg", "-y",
                "-f", "lavfi", "-i", "sine=frequency=800:sample_rate=16000",
                "-t", "1.5",
                str(tts_clip)
            ], check=True, capture_output=True)

            sentences = [
                {
                    "index": 1,
                    "start_s": 1.0,
                    "end_s": 2.5,
                    "duration_s": 1.5,
                    "audio_file": str(tts_clip)
                }
            ]
            final_audio = temp_path / "final_mixed.wav"
            dubber.assemble_dubbed_audio(sentences, 4.0, str(final_audio), bg)
            self.assertTrue(final_audio.exists())
            self.assertAlmostEqual(dubber.get_audio_duration(final_audio), 4.0, delta=0.3)

    def test_elastic_speech_flow_scheduling(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            bg = temp_path / "bg.wav"
            subprocess.run([
                "ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
                "-t", "8", str(bg)
            ], check=True, capture_output=True)

            clip1 = temp_path / "clip1.wav"
            clip2 = temp_path / "clip2.wav"
            clip3 = temp_path / "clip3.wav"
            for p in [clip1, clip2, clip3]:
                subprocess.run([
                    "ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000",
                    "-t", "1.0", str(p)
                ], check=True, capture_output=True)

            # Sentence 1: planned 1.0s - 3.0s, but TTS is 1.0s long (ends at 2.0s)
            # Sentence 2: planned 3.2s - 4.5s (continuous thought, gap 0.2s) -> should start smoothly at ~2.32s instead of 3.2s!
            # Sentence 3: planned 6.5s - 7.5s (scene cut/long pause, gap 2.0s) -> should preserve pause and start at 6.5s
            sentences = [
                {"index": 1, "start_s": 1.0, "end_s": 3.0, "duration_s": 2.0, "audio_file": str(clip1)},
                {"index": 2, "start_s": 3.2, "end_s": 4.5, "duration_s": 1.3, "audio_file": str(clip2)},
                {"index": 3, "start_s": 6.5, "end_s": 7.5, "duration_s": 1.0, "audio_file": str(clip3)}
            ]

            out_wav = temp_path / "smooth_mix.wav"
            dubber.assemble_dubbed_audio(sentences, 8.0, str(out_wav), str(bg), flow_mode="smooth")

            # Check retimed positions:
            self.assertEqual(sentences[0]["actual_start_s"], 1.0)
            self.assertEqual(sentences[0]["actual_end_s"], 2.0)

            # Sentence 2 should smoothly follow Sentence 1 (+ ~320ms breath), not wait until 3.2s!
            self.assertAlmostEqual(sentences[1]["actual_start_s"], 2.32, delta=0.1)
            self.assertLess(sentences[1]["actual_start_s"], 3.0, "Sentence 2 should eliminate the dead silence pause!")

            # Sentence 3 had a large 2.0s scene gap, so it should anchor at 6.5s
            self.assertAlmostEqual(sentences[2]["actual_start_s"], 6.5, delta=0.1)

    def test_language_budget_and_flow_blocks(self):
        # 1. Language frequency & information density budget
        min_tok, max_tok, expected = dubber.calculate_language_budget("en", "zh", 4.0)
        self.assertGreater(min_tok, 5)
        self.assertLess(max_tok, 20)
        self.assertAlmostEqual(expected, 11.9, delta=0.5)

        # 2. Continuous flow block grouping
        sents = [
            {"index": 1, "start_s": 1.0, "end_s": 3.0, "zh_text": "第一句。"},
            {"index": 2, "start_s": 3.4, "end_s": 5.0, "zh_text": "第二句。"},  # gap 0.4s -> same block
            {"index": 3, "start_s": 8.0, "end_s": 10.0, "zh_text": "第三句。"}   # gap 3.0s -> new block
        ]
        blocks = dubber.group_into_flow_blocks(sents, max_gap_s=1.5)
        self.assertEqual(len(blocks), 2)
        self.assertEqual(len(blocks[0]), 2)
        self.assertEqual(len(blocks[1]), 1)


if __name__ == "__main__":
    unittest.main()

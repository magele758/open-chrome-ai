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


if __name__ == "__main__":
    unittest.main()

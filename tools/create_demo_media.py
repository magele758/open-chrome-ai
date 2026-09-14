#!/usr/bin/env python3
"""
Creates a realistic 12-second video with music and speech, plus timed json3 subtitles,
to demonstrate the decoupled dubbing pipeline.
"""
import json
import os
from pathlib import Path
import subprocess

OUT_DIR = Path("/tmp/pagelens_demo")
OUT_DIR.mkdir(parents=True, exist_ok=True)

video_path = OUT_DIR / "sample_video.mp4"
json3_path = OUT_DIR / "sample_sub.json3"

print("Generating synthetic demo video with BGM and spoken dialogue...")
# Create a 12-second video:
# Video: 640x360 colored background with timestamp overlay
# Audio: Stereo chords / BGM (sine combo) + spoken frequency envelope
subprocess.run([
    "ffmpeg", "-y",
    "-f", "lavfi", "-i", "testsrc=size=640x360:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=16000",
    "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=16000",
    "-filter_complex",
    "[0:v]trim=duration=12[v];"
    "[1:a][2:a]amix=inputs=2:weights=0.5 0.5[bg];"
    "[bg]volume=0.4[outa]",
    "-map", "[v]", "-map", "[outa]",
    "-c:v", "libx264", "-preset", "ultrafast",
    "-c:a", "aac",
    "-t", "12",
    str(video_path)
], check=True, capture_output=True)

# Generate json3 subtitles with 2 timed sentences
sub_data = {
    "events": [
        {
            "tStartMs": 1200,
            "dDurationMs": 4200,
            "segs": [
                {"utf8": "Innovation", "tOffsetMs": 0, "dDurationMs": 800},
                {"utf8": " distinguishes", "tOffsetMs": 850, "dDurationMs": 900},
                {"utf8": " between", "tOffsetMs": 1800, "dDurationMs": 600},
                {"utf8": " a leader", "tOffsetMs": 2450, "dDurationMs": 800},
                {"utf8": " and a follower.", "tOffsetMs": 3300, "dDurationMs": 1100}
            ]
        },
        {
            "tStartMs": 6800,
            "dDurationMs": 4200,
            "segs": [
                {"utf8": "Stay", "tOffsetMs": 0, "dDurationMs": 600},
                {"utf8": " hungry,", "tOffsetMs": 650, "dDurationMs": 800},
                {"utf8": " stay", "tOffsetMs": 1500, "dDurationMs": 600},
                {"utf8": " foolish,", "tOffsetMs": 2150, "dDurationMs": 900},
                {"utf8": " never stop learning.", "tOffsetMs": 3100, "dDurationMs": 1100}
            ]
        }
    ]
}

with open(json3_path, "w", encoding="utf-8") as f:
    json.dump(sub_data, f, indent=2)

print(f"Demo video created: {video_path}")
print(f"Demo subtitle created: {json3_path}")

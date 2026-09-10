"""Integration check with local media: real yt-dlp download and ffmpeg segmentation."""
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
import media_helper as helper


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


class MediaTest(unittest.TestCase):
    def test_full_download_and_segments(self):
        with tempfile.TemporaryDirectory() as source, tempfile.TemporaryDirectory() as output:
            file = str(Path(source) / 'complete.mp4')
            subprocess.run([helper.executable('ffmpeg'), '-v', 'error', '-f', 'lavfi', '-i', 'color=s=160x90:r=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '7', '-c:v', 'libx264', '-c:a', 'aac', file], check=True)
            server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=source))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            job = {'dir': output, 'cancel': threading.Event(), 'process': None}
            original = helper.PART_SECONDS
            helper.PART_SECONDS = 2
            try:
                helper.extract(job, f'http://127.0.0.1:{server.server_port}/complete.mp4', None)
                self.assertEqual(job['status'], 'ready', job.get('error'))
                self.assertEqual(len(job['parts']), 4)
                self.assertAlmostEqual(sum(p['duration'] for p in job['parts']), job['duration'], delta=.1)
                self.assertGreater(job['parts'][-1]['start'], 5.9)
                self.assertEqual(len(list(Path(output).glob('source.*'))), 0)
                helper.cancel(job)
                self.assertFalse(Path(output).exists())
            finally:
                helper.PART_SECONDS = original
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    unittest.main()

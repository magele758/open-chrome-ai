"""Integration check with local media: real yt-dlp download and ffmpeg segmentation."""
import functools
import http.client
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
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

    def test_health_cors_and_ensure_when_running(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), helper.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        port = server.server_port
        origin = 'chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef'
        try:
            self.assertTrue(helper.probe(port))
            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
            conn.request('OPTIONS', '/jobs', headers={
                'Origin': origin,
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Private-Network': 'true',
            })
            preflight = conn.getresponse()
            self.assertEqual(preflight.status, 204)
            self.assertEqual(preflight.getheader('Access-Control-Allow-Private-Network'), 'true')
            preflight.read()
            conn.request('GET', '/health', headers={'Origin': origin})
            health = conn.getresponse()
            body = json.loads(health.read().decode())
            self.assertEqual(health.status, 200)
            self.assertEqual(body['service'], 'pagelens-media')
            self.assertEqual(health.getheader('Access-Control-Allow-Private-Network'), 'true')
            conn.request('OPTIONS', '/health', headers={'Origin': 'null', 'Access-Control-Request-Private-Network': 'true'})
            null_origin = conn.getresponse()
            self.assertEqual(null_origin.status, 204)
            null_origin.read()
            conn.close()
            with patch('sys.stdout', new_callable=io.StringIO):
                self.assertEqual(helper.ensure(port), 0)
        finally:
            server.shutdown()
            server.server_close()

    def test_cache_hit_and_cleanup(self):
        with tempfile.TemporaryDirectory() as source, tempfile.TemporaryDirectory() as cache_dir, tempfile.TemporaryDirectory() as out1, tempfile.TemporaryDirectory() as out2:
            file = str(Path(source) / 'test_video.mp4')
            subprocess.run([helper.executable('ffmpeg'), '-v', 'error', '-f', 'lavfi', '-i', 'color=s=160x90:r=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '4', '-c:v', 'libx264', '-c:a', 'aac', file], check=True)
            server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=source))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            orig_cache = helper.CACHE_DIR
            orig_part = helper.PART_SECONDS
            helper.CACHE_DIR = Path(cache_dir)
            helper.PART_SECONDS = 2
            try:
                target_url = f'http://127.0.0.1:{server.server_port}/test_video.mp4'
                job1 = {'dir': out1, 'cancel': threading.Event(), 'process': None}
                helper.extract(job1, target_url, None)
                self.assertEqual(job1['status'], 'ready')
                self.assertTrue(any(Path(cache_dir).iterdir()), 'Cache should be populated')

                # Second extract should hit cache even if server is shut down!
                server.shutdown()
                server.server_close()

                job2 = {'dir': out2, 'cancel': threading.Event(), 'process': None}
                helper.extract(job2, target_url, None)
                self.assertEqual(job2['status'], 'ready')
                self.assertEqual(len(job2['parts']), len(job1['parts']))
                self.assertEqual(job2['duration'], job1['duration'])

                # Test cleanup
                helper.CACHE_MAX_AGE_SECONDS = -1
                helper.clean_cache()
                self.assertEqual(len(list(Path(cache_dir).iterdir())), 0)
            finally:
                helper.CACHE_DIR = orig_cache
                helper.PART_SECONDS = orig_part
                helper.CACHE_MAX_AGE_SECONDS = 7 * 86400


if __name__ == '__main__':
    unittest.main()

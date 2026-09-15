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
                cached = [p for p in Path(cache_dir).iterdir() if p.is_dir()]
                self.assertEqual(len(cached), 1)
                self.assertRegex(cached[0].name, r'^127-test_video-p2-[0-9a-f]{8}$')
                self.assertEqual((cached[0] / 'source.txt').read_text(encoding='utf-8').strip(), target_url)

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


class TranscriptTest(unittest.TestCase):
    def test_subtitles_stop_before_audio_download(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as cache:
            job = {'dir': root, 'purpose': 'transcript', 'cancel': threading.Event()}
            cues = [{'start': 0, 'end': 5, 'src': 'Complete subtitles'}]
            with patch.object(helper, 'CACHE_DIR', Path(cache)), patch.object(helper, 'downloader_args', return_value=['yt-dlp']), patch.object(helper, 'fetch_subtitles', return_value=cues), patch.object(helper, 'run', return_value=json.dumps({'duration': 5}).encode()) as run:
                helper.extract(job, 'https://fixture.test/subtitles', None)
            self.assertEqual(job['status'], 'ready')
            self.assertEqual(job['subtitles'], cues)
            self.assertEqual(job['parts'], [])
            self.assertEqual(run.call_count, 1, 'only metadata extraction, no download or ffmpeg')

    def test_direct_failure_retries_only_selected_language(self):
        with tempfile.TemporaryDirectory() as root:
            job = {'cancel': threading.Event()}
            info = {'subtitles': {'en': [{'ext': 'json3', 'url': 'https://fixture.test/en'}], 'fr': [{'ext': 'vtt', 'url': 'https://fixture.test/fr'}]}}
            def download(_job, args):
                self.assertEqual(args[args.index('--sub-langs') + 1], '^en$')
                Path(root, 'sub.en.vtt').write_text('WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nComplete subtitles\n')
                return b''
            with patch.object(helper.urllib.request, 'urlopen', side_effect=TimeoutError()), patch.object(helper, 'downloader_args', return_value=['yt-dlp']), patch.object(helper, 'run', side_effect=download) as run:
                cues = helper.fetch_subtitles(job, 'https://fixture.test/video', info, Path(root))
            self.assertTrue(cues)
            self.assertEqual(run.call_count, 1)

    def test_no_tracks_avoids_repeated_metadata_lookup(self):
        with patch.object(helper, 'run') as run:
            self.assertEqual(helper.fetch_subtitles({'cancel': threading.Event()}, 'https://fixture.test', {}, Path('/unused')), [])
            run.assert_not_called()

    def test_audio_mode_still_downloads_for_dubbing(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as cache:
            job = {'dir': root, 'cancel': threading.Event()}
            with patch.object(helper, 'CACHE_DIR', Path(cache)), patch.object(helper, 'downloader_args', return_value=['yt-dlp']), patch.object(helper, 'fetch_subtitles', return_value=[{'src': 'subtitle'}]), patch.object(helper, 'run', side_effect=[json.dumps({'duration': 5}).encode(), RuntimeError('download reached')]) as run:
                helper.extract(job, 'https://fixture.test/dub', None)
            self.assertEqual(run.call_count, 2)
            self.assertIn('download reached', job['error'])

    def test_pick_sub_track_list_prefix_matching(self):
        # Test YouTube custom suffix keys like en-j3PyPqV-e1s
        sub_dict = {'en-j3PyPqV-e1s': [{'ext': 'json3', 'url': 'https://fixture.test/custom_en'}]}
        tracks = helper.pick_sub_track_list(sub_dict)
        self.assertIsNotNone(tracks)
        self.assertEqual(tracks[0]['url'], 'https://fixture.test/custom_en')

        # Test Chinese preference over English prefix
        mixed_dict = {
            'en-j3PyPqV-e1s': [{'ext': 'json3', 'url': 'https://fixture.test/en'}],
            'zh-Hans': [{'ext': 'vtt', 'url': 'https://fixture.test/zh'}]
        }
        self.assertEqual(helper.pick_sub_track_list(mixed_dict)[0]['url'], 'https://fixture.test/zh')

    def test_cache_entry_name_is_readable(self):
        self.assertEqual(helper.cache_label('https://www.youtube.com/watch?v=abcdefghijk'), 'youtube-abcdefghijk')
        self.assertEqual(helper.cache_label('https://youtu.be/abcdefghijk'), 'youtube-abcdefghijk')
        self.assertEqual(helper.cache_label('https://x.com/someone/status/1234567890123456789'), 'x-1234567890123456789')
        self.assertEqual(
            helper.cache_label('https://video.twimg.com/amplify_video/1234567890123456789/vid/avc1/1924x1080/clip.mp4'),
            'x-1234567890123456789',
        )
        self.assertEqual(helper.cache_label('https://www.bilibili.com/video/BV1xx411c7mD'), 'bilibili-BV1xx411c7mD')
        self.assertEqual(helper.cache_label('https://www.youtube.com/shorts/abcdefghijk'), 'youtube-abcdefghijk')
        orig = helper.PART_SECONDS
        helper.PART_SECONDS = 300
        try:
            name = helper.cache_entry_name('https://www.youtube.com/watch?v=abcdefghijk')
            self.assertRegex(name, r'^youtube-abcdefghijk-p300-[0-9a-f]{8}$')
        finally:
            helper.PART_SECONDS = orig

    def test_twitter_prefers_direct_twimg_file(self):
        video_only = 'https://video.twimg.com/amplify_video/1234567890123456789/vid/avc1/1924x1080/clip.mp4?tag=29'
        tweet = 'https://x.com/someone/status/1234567890123456789'
        status = 'https://x.com/i/status/1234567890123456789'
        self.assertTrue(helper.is_twimg_url(video_only))
        self.assertEqual(helper.resolve_download_target(tweet, video_only), video_only)
        self.assertEqual(helper.resolve_download_target(video_only, video_only), video_only)
        self.assertEqual(helper.download_targets(tweet, video_only)[0], video_only)
        self.assertIn(status, helper.download_targets(tweet, video_only))
        self.assertEqual(
            helper.resolve_download_target('https://www.youtube.com/watch?v=abcdefghijk', 'https://rr1.googlevideo.com/videoplayback'),
            'https://www.youtube.com/watch?v=abcdefghijk',
        )


if __name__ == '__main__':
    unittest.main()

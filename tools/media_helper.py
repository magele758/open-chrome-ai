#!/usr/bin/env python3
"""PageLens full-media bridge. Standard library + yt-dlp + ffmpeg, loopback only."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import uuid
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

JOBS = {}
LOCK = threading.RLock()
PART_SECONDS = 300


def executable(name):
    found = shutil.which(name)
    for candidate in (Path.home() / '.local/bin' / name, Path('/opt/homebrew/bin') / name):
        if not found and candidate.is_file():
            found = str(candidate)
    if not found:
        raise RuntimeError(f'缺少 {name}，请安装后重试。')
    return found


def run(job, args):
    with LOCK:
        if job['cancel'].is_set():
            raise RuntimeError('已取消')
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        job['process'] = proc
    try:
        out, err = proc.communicate(timeout=3600)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate()
        raise RuntimeError('媒体下载或处理超时，请重试。')
    finally:
        with LOCK:
            job['process'] = None
    if job['cancel'].is_set():
        raise RuntimeError('已取消')
    if proc.returncode:
        # Never return signed URLs or request headers in errors.
        raise RuntimeError('媒体提取失败：站点可能需要登录、链接已失效或格式不受支持。请更新 yt-dlp 后重试。')
    return out


def duration(job, path):
    data = json.loads(run(job, [executable('ffprobe'), '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(path)]))
    return float(data['format']['duration'])


def fetch_subtitle(info):
    candidates = []
    for auto, group in enumerate(('subtitles', 'automatic_captions')):
        for lang, formats in (info.get(group) or {}).items():
            if not (lang.startswith('zh') or lang.startswith('en') or not candidates):
                continue
            for entry in formats:
                if entry.get('ext') in ('json3', 'vtt') and entry.get('url'):
                    score = (10 if lang.startswith('zh') else 5 if lang.startswith('en') else 0) - auto
                    candidates.append((score, entry))
    for _, entry in sorted(candidates, key=lambda x: -x[0])[:4]:
        try:
            request = urllib.request.Request(entry['url'], headers=info.get('http_headers') or {})
            with urllib.request.urlopen(request, timeout=20) as response:
                body = response.read(32 * 1024 * 1024).decode('utf-8-sig')
            if body.strip():
                return {'format': entry['ext'], 'body': body}
        except Exception:
            continue
    return None


def extract(job, url, media_url):
    try:
        ytdlp = executable('yt-dlp')
        base = [ytdlp, '--no-playlist', '--no-warnings', '--socket-timeout', '30', '--retries', '2']
        job['status'] = 'extracting'
        # A selected direct source avoids accidentally downloading another video on a multi-video page.
        target = media_url or url
        info = json.loads(run(job, base + ['--skip-download', '--dump-single-json', '--', target]))
        if info.get('is_live') or info.get('live_status') in ('is_live', 'is_upcoming', 'post_live'):
            raise RuntimeError('直播尚未形成完整媒体文件，暂时无法生成完整文稿。')
        if info.get('_type') in ('playlist', 'multi_video'):
            raise RuntimeError('请打开单个视频页面再提取完整文稿。')
        expected = float(info.get('duration') or 0)
        subtitle = fetch_subtitle(info)
        if job['cancel'].is_set():
            return
        if subtitle:
            job.update(status='ready', subtitle=subtitle, duration=expected, parts=[])
            return
        job['status'] = 'downloading'
        root = Path(job['dir'])
        run(job, base + ['-f', 'bestaudio/best', '--no-part', '-o', str(root / 'source.%(ext)s'), '--', target])
        files = list(root.glob('source.*'))
        if len(files) != 1:
            raise RuntimeError('未找到完整音轨。')
        actual = duration(job, files[0])
        if actual <= 0 or (expected and abs(actual - expected) > max(3, expected * .01)):
            raise RuntimeError('下载时长与完整视频不一致，已停止，未保存为完整文稿。')
        job['status'] = 'splitting'
        run(job, [executable('ffmpeg'), '-nostdin', '-v', 'error', '-i', str(files[0]), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'segment', '-segment_time', str(PART_SECONDS), '-reset_timestamps', '1', str(root / 'part-%05d.wav')])
        parts, offset = [], 0
        for path in sorted(root.glob('part-*.wav')):
            length = duration(job, path)
            parts.append({'index': len(parts), 'start': offset, 'duration': length})
            offset += length
        if not parts or abs(offset - actual) > max(1, actual * .001):
            raise RuntimeError('音轨分段不完整，已停止。')
        files[0].unlink()
        job.update(status='ready', duration=actual, parts=parts)
    except Exception as exc:
        job.update(status='error', error=str(exc))
    finally:
        if job['cancel'].is_set():
            shutil.rmtree(job['dir'], ignore_errors=True)


def cancel(job):
    with LOCK:
        job['cancel'].set()
        proc = job.get('process')
        if proc and proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    if not proc:
        shutil.rmtree(job['dir'], ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def allowed(self):
        origin = self.headers.get('Origin', '')
        return not origin or origin.startswith('chrome-extension://')

    def reply(self, code, data, mime='application/json'):
        body = json.dumps(data, ensure_ascii=False).encode() if mime == 'application/json' else data
        self.send_response(code)
        if self.allowed() and self.headers.get('Origin'):
            self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
            self.send_header('Vary', 'Origin')
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        if not self.allowed():
            return self.reply(403, {'error': 'Origin denied'})
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin', ''))
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        if not self.allowed() or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.reply(403, {'error': 'Origin or content type denied'})
        if self.path != '/jobs':
            return self.reply(404, {})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 65536:
                raise ValueError('Invalid body size')
            data = json.loads(self.rfile.read(length))
            for value in (data['url'], data.get('mediaUrl') or data['url']):
                if urlparse(value).scheme not in ('http', 'https'):
                    raise ValueError('Only HTTP media URLs are accepted')
            with LOCK:
                if sum(j['status'] not in ('ready', 'error') for j in JOBS.values()) >= 2:
                    return self.reply(429, {'error': '已有提取任务，请稍后重试。'})
                key = uuid.uuid4().hex
                job = {'id': key, 'status': 'extracting', 'dir': tempfile.mkdtemp(prefix='pagelens-media-'), 'created': time.time(), 'cancel': threading.Event(), 'process': None}
                JOBS[key] = job
            threading.Thread(target=extract, args=(job, data['url'], data.get('mediaUrl')), daemon=True).start()
            self.reply(202, {'id': key})
        except (ValueError, KeyError):
            self.reply(400, {'error': 'Invalid request'})

    def do_GET(self):
        if not self.allowed():
            return self.reply(403, {})
        if self.path == '/health':
            return self.reply(200, {'ok': True, 'service': 'pagelens-media', 'version': 1})
        pieces = self.path.strip('/').split('/')
        job = JOBS.get(pieces[1]) if len(pieces) >= 2 and pieces[0] == 'jobs' else None
        if not job:
            return self.reply(404, {})
        job['created'] = time.time()
        if len(pieces) == 2:
            return self.reply(200, {k: job[k] for k in ('id', 'status', 'error', 'duration', 'parts', 'subtitle') if k in job})
        if len(pieces) == 4 and pieces[2] == 'audio' and pieces[3].isdigit() and job['status'] == 'ready':
            index = int(pieces[3])
            if index < len(job.get('parts', [])):
                path = Path(job['dir']) / f'part-{index:05d}.wav'
                return self.reply(200, path.read_bytes(), 'audio/wav')
        self.reply(404, {})

    def do_DELETE(self):
        if not self.allowed():
            return self.reply(403, {})
        key = self.path.removeprefix('/jobs/')
        job = JOBS.pop(key, None)
        if job:
            cancel(job)
        self.reply(200, {'ok': True})


def reap():
    while True:
        time.sleep(60)
        with LOCK:
            expired = [key for key, job in JOBS.items() if time.time() - job['created'] > 3600]
            for key in expired:
                cancel(JOBS.pop(key))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=18789)
    args = parser.parse_args()
    for name in ('yt-dlp', 'ffmpeg', 'ffprobe'):
        executable(name)
    threading.Thread(target=reap, daemon=True).start()
    print(f'PageLens media helper: http://127.0.0.1:{args.port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()

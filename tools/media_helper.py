#!/usr/bin/env python3
"""PageLens full-media bridge. Standard library + yt-dlp + ffmpeg, loopback only."""
import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

JOBS = {}
LOCK = threading.RLock()
PART_SECONDS = 300
DEFAULT_PORT = 18789
SERVICE = 'pagelens-media'
CONDA_ENV = 'pagelens-media'
PORT = DEFAULT_PORT
CACHE_DIR = Path.home() / '.cache' / SERVICE
CACHE_MAX_AGE_SECONDS = 7 * 86400


def conda_prefixes():
    prefixes = []
    if os.environ.get('CONDA_PREFIX'):
        prefixes.append(os.environ['CONDA_PREFIX'])
    bases = []
    if os.environ.get('CONDA_EXE'):
        bases.append(Path(os.environ['CONDA_EXE']).resolve().parent.parent)
    bases.extend((
        Path('/opt/homebrew/Caskroom/miniconda/base'),
        Path('/usr/local/Caskroom/miniconda/base'),
        Path.home() / 'miniconda3',
        Path.home() / 'anaconda3',
        Path.home() / 'miniforge3',
        Path.home() / 'mambaforge',
    ))
    seen = set()
    ordered = []
    for base in bases:
        if not base.is_dir():
            continue
        candidates = [base]
        envs = base / 'envs'
        if envs.is_dir():
            candidates.extend(p for p in sorted(envs.iterdir()) if p.is_dir())
        for candidate in candidates:
            key = str(candidate)
            if key in seen:
                continue
            seen.add(key)
            # Prefer the dedicated helper env when looking up binaries.
            if candidate.name == CONDA_ENV:
                ordered.insert(0, key)
            else:
                ordered.append(key)
    for prefix in prefixes:
        if prefix not in seen:
            ordered.insert(0, prefix)
    return ordered


def enrich_path():
    extras = [str(Path.home() / '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']
    extras.extend(str(Path(prefix) / 'bin') for prefix in conda_prefixes())
    existing = os.environ.get('PATH', '')
    os.environ['PATH'] = os.pathsep.join([*extras, existing])


def find_executable(name):
    found = shutil.which(name)
    if found:
        return found
    for candidate in (
        Path.home() / '.local/bin' / name,
        Path('/opt/homebrew/bin') / name,
        Path('/usr/local/bin') / name,
        *(Path(prefix) / 'bin' / name for prefix in conda_prefixes()),
    ):
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def executable(name):
    found = find_executable(name)
    if not found:
        raise RuntimeError(
            f'缺少 {name}。请先执行：conda create -n {CONDA_ENV} -c conda-forge python=3.12 ffmpeg yt-dlp -y'
        )
    return found


def launch_commands():
    return (
        f'conda run -n {CONDA_ENV} python tools/media_helper.py --ensure',
        f'conda create -n {CONDA_ENV} -c conda-forge python=3.12 ffmpeg yt-dlp -y',
    )


def health_payload():
    bins = {name: bool(find_executable(name)) for name in ('yt-dlp', 'ffmpeg', 'ffprobe')}
    return {
        'ok': True,
        'service': SERVICE,
        'version': 4,
        'audioAnalysis': True,
        'audioAnalysisVersion': 2,
        'port': PORT,
        'bins': bins,
        'ready': all(bins.values()),
    }


def probe(port, timeout=1.5):
    request = urllib.request.Request(
        f'http://127.0.0.1:{int(port)}/health',
        headers={'Accept': 'application/json'},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode('utf-8'))
        return data.get('service') == SERVICE
    except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError, OSError):
        return False


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
        # Classify diagnostics without exposing signed URLs or request headers.
        detail = err.decode('utf-8', errors='replace').lower()
        if '403' in detail and ('forbidden' in detail or 'http' in detail):
            reason = '下载音轨被站点拒绝（HTTP 403）。请更新 yt-dlp 及 yt-dlp-ejs，并确认 Node.js 或 Deno 可用。'
        elif 'sign in' in detail or 'login' in detail:
            reason = '站点要求登录或人机验证，当前下载服务无法获取该视频。'
        elif 'javascript' in detail or 'challenge' in detail or 'ejs' in detail:
            reason = 'YouTube JavaScript 解析失败。请更新 yt-dlp[default]，并安装 Node.js 或 Deno。'
        else:
            reason = '媒体提取失败：链接已失效或格式不受支持。请更新 yt-dlp 后重试。'
        print(json.dumps({'event': 'media.command-error', 'tool': Path(args[0]).name,
                          'exit': proc.returncode, 'reason': reason}, ensure_ascii=False), flush=True)
        raise RuntimeError(reason)
    return out


def duration(job, path):
    data = json.loads(run(job, [executable('ffprobe'), '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(path)]))
    return float(data['format']['duration'])


def downloader_args():
    args = [executable('yt-dlp'), '--ignore-config', '--no-playlist',
            '--no-write-subs', '--no-write-auto-subs', '--no-warnings',
            '--socket-timeout', '30', '--retries', '2']
    # YouTube requires the EJS solver and an explicitly enabled JS runtime.
    # Use an installed runtime; never download executable scripts on demand.
    for runtime in ('deno', 'node'):
        binary = find_executable(runtime)
        if binary:
            args.extend(['--js-runtimes', f'{runtime}:{binary}'])
            break
    return args


def clean_cache():
    if not CACHE_DIR.is_dir():
        return
    now = time.time()
    try:
        for item in CACHE_DIR.iterdir():
            if not item.is_dir():
                continue
            meta_file = item / 'meta.json'
            if meta_file.is_file():
                try:
                    meta = json.loads(meta_file.read_text(encoding='utf-8'))
                    cached_at = meta.get('cached_at', 0)
                    if now - cached_at > CACHE_MAX_AGE_SECONDS:
                        shutil.rmtree(item, ignore_errors=True)
                except Exception:
                    shutil.rmtree(item, ignore_errors=True)
            else:
                try:
                    if now - item.stat().st_mtime > 3600:
                        shutil.rmtree(item, ignore_errors=True)
                except Exception:
                    pass
    except Exception:
        pass


def extract(job, url, media_url):
    try:
        target = media_url or url
        root = Path(job['dir'])
        target_hash = hashlib.sha256(f'{target}_{PART_SECONDS}'.encode('utf-8')).hexdigest()[:24]
        target_cache_dir = CACHE_DIR / target_hash
        meta_file = target_cache_dir / 'meta.json'

        if meta_file.is_file():
            try:
                meta = json.loads(meta_file.read_text(encoding='utf-8'))
                cached_parts = meta.get('parts', [])
                cached_duration = float(meta.get('duration', 0))
                if (
                    cached_duration > 0
                    and cached_parts
                    and meta.get('part_seconds') == PART_SECONDS
                    and all((target_cache_dir / f"part-{p['index']:05d}.wav").is_file() for p in cached_parts)
                ):
                    for p in cached_parts:
                        src_part = target_cache_dir / f"part-{p['index']:05d}.wav"
                        dst_part = root / f"part-{p['index']:05d}.wav"
                        try:
                            os.link(src_part, dst_part)
                        except OSError:
                            shutil.copyfile(src_part, dst_part)
                    job.update(status='ready', duration=cached_duration, parts=cached_parts)
                    print(json.dumps({'event': 'media.cache-hit', 'target': target, 'duration': cached_duration}, ensure_ascii=False), flush=True)
                    return
            except Exception:
                shutil.rmtree(target_cache_dir, ignore_errors=True)

        base = downloader_args()
        job['status'] = 'extracting'
        # A selected direct source avoids accidentally downloading another video on a multi-video page.
        info = json.loads(run(job, base + ['--skip-download', '--dump-single-json', '--', target]))
        if info.get('is_live') or info.get('live_status') in ('is_live', 'is_upcoming', 'post_live'):
            raise RuntimeError('直播尚未形成完整媒体文件，暂时无法生成完整文稿。')
        if info.get('_type') in ('playlist', 'multi_video'):
            raise RuntimeError('请打开单个视频页面再提取完整文稿。')
        expected = float(info.get('duration') or 0)
        if job['cancel'].is_set():
            return
        job['status'] = 'downloading'
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

        # Save to persistent cache
        try:
            target_cache_dir.mkdir(parents=True, exist_ok=True)
            for path in root.glob('part-*.wav'):
                shutil.copyfile(path, target_cache_dir / path.name)
            meta = {
                'url': url,
                'media_url': media_url,
                'duration': actual,
                'parts': parts,
                'part_seconds': PART_SECONDS,
                'cached_at': time.time(),
            }
            (target_cache_dir / 'meta.json').write_text(json.dumps(meta, ensure_ascii=False), encoding='utf-8')
        except Exception:
            pass

        job.update(status='ready', duration=actual, parts=parts)
    except Exception as exc:
        job.update(status='error', error=str(exc))
    finally:
        if job['cancel'].is_set():
            shutil.rmtree(job['dir'], ignore_errors=True)


ANALYSIS_LOCK = threading.Lock()

def analyze_job(job):
    try:
        with ANALYSIS_LOCK:
            if job['cancel'].is_set():
                return
            output = Path(job['dir']) / 'analysis.json'
            run(job, [sys.executable, str(Path(__file__).with_name('audio_analysis.py')), job['dir'], str(output)])
            job['analysis'] = json.loads(output.read_text(encoding='utf-8'))
            job['analysisStatus'] = 'ready'
    except Exception:
        job['analysisStatus'] = 'error'
        job['analysisError'] = '声音分析未完成。请安装 tools/requirements-audio.txt，并确认 HF_TOKEN 可访问 pyannote/speaker-diarization-community-1。'


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
        return not origin or origin == 'null' or origin.startswith('chrome-extension://')

    def cors_headers(self):
        origin = self.headers.get('Origin')
        if self.allowed() and origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Access-Control-Request-Private-Network')

    def reply(self, code, data, mime='application/json'):
        body = json.dumps(data, ensure_ascii=False).encode() if mime == 'application/json' else data
        self.send_response(code)
        self.cors_headers()
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
        self.cors_headers()
        self.send_header('Access-Control-Max-Age', '600')
        self.end_headers()

    def do_POST(self):
        if not self.allowed() or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.reply(403, {'error': 'Origin or content type denied'})
        pieces = self.path.strip('/').split('/')
        if len(pieces) == 3 and pieces[0] == 'jobs' and pieces[2] == 'analysis':
            with LOCK:
                job = JOBS.get(pieces[1])
                if not job or job['status'] != 'ready':
                    return self.reply(409, {'error': '音轨尚未准备好'})
                if not job.get('analysisStatus'):
                    job['analysisStatus'] = 'running'
                    threading.Thread(target=analyze_job, args=(job,), daemon=True).start()
                return self.reply(202, {'status': job['analysisStatus']})
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
        if self.path in ('/health', '/'):
            return self.reply(200, health_payload())
        pieces = self.path.strip('/').split('/')
        job = JOBS.get(pieces[1]) if len(pieces) >= 2 and pieces[0] == 'jobs' else None
        if not job:
            return self.reply(404, {})
        job['created'] = time.time()
        if len(pieces) == 3 and pieces[2] == 'analysis':
            return self.reply(200, {'status': job.get('analysisStatus', 'missing'), 'error': job.get('analysisError'), 'result': job.get('analysis')})
        if len(pieces) == 2:
            return self.reply(200, {k: job[k] for k in ('id', 'status', 'error', 'duration', 'parts') if k in job})
        if len(pieces) == 4 and pieces[2] in ('audio', 'background') and pieces[3].isdigit() and job['status'] == 'ready':
            index = int(pieces[3])
            if index < len(job.get('parts', [])):
                prefix = 'background' if pieces[2] == 'background' else 'part'
                path = Path(job['dir']) / f'{prefix}-{index:05d}.wav'
                if not path.is_file():
                    return self.reply(404, {'error': '音轨尚未生成'})
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
    last_cache_clean = 0
    while True:
        time.sleep(60)
        with LOCK:
            expired = [key for key, job in JOBS.items() if time.time() - job['created'] > 3600]
            for key in expired:
                cancel(JOBS.pop(key))
        if time.time() - last_cache_clean > 3600:
            clean_cache()
            last_cache_clean = time.time()


def serve(port):
    global PORT
    PORT = int(port)
    clean_cache()
    threading.Thread(target=reap, daemon=True).start()
    print(f'PageLens media helper: http://127.0.0.1:{PORT}', flush=True)
    try:
        ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
    except OSError as exc:
        busy = getattr(exc, 'errno', None) in (errno.EADDRINUSE, 48)
        if busy and probe(PORT):
            print(f'already http://127.0.0.1:{PORT}', flush=True)
            return
        if busy:
            raise SystemExit(f'端口 {PORT} 已被其他程序占用，不是 PageLens 媒体服务。') from exc
        raise


def spawn_detached(port):
    script = str(Path(__file__).resolve())
    args = [sys.executable, script, '--port', str(int(port))]
    if os.name == 'nt':
        subprocess.Popen(args, close_fds=True, start_new_session=True)
        return
    child = os.fork()
    if child > 0:
        return
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    log = Path(tempfile.gettempdir()) / 'pagelens-media-helper.log'
    sys.stdout.flush()
    sys.stderr.flush()
    with open(os.devnull, 'rb') as devnull, open(log, 'ab') as handle:
        os.dup2(devnull.fileno(), sys.stdin.fileno())
        os.dup2(handle.fileno(), sys.stdout.fileno())
        os.dup2(handle.fileno(), sys.stderr.fileno())
    try:
        serve(port)
    finally:
        os._exit(0)


def ensure(port):
    if probe(port):
        print(f'already http://127.0.0.1:{int(port)}', flush=True)
        return 0
    spawn_detached(port)
    for _ in range(40):
        time.sleep(0.1)
        if probe(port):
            print(f'PageLens media helper: http://127.0.0.1:{int(port)}', flush=True)
            return 0
    start, create = launch_commands()
    raise SystemExit(
        '媒体服务启动失败。请在仓库根目录执行：\n'
        f'  {start}\n'
        f'若尚未建环境：{create}\n'
        f'日志：{Path(tempfile.gettempdir()) / "pagelens-media-helper.log"}'
    )


if __name__ == '__main__':
    enrich_path()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=DEFAULT_PORT)
    parser.add_argument('--ensure', action='store_true', help='若未就绪则在后台拉起后退出')
    args = parser.parse_args()
    if args.ensure:
        raise SystemExit(ensure(args.port))
    serve(args.port)

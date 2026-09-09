#!/usr/bin/env python3
"""Launch branded Chrome 152+ and load the unpacked extension via CDP pipe."""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
EXT = ROOT / "extension"
PROFILE = ROOT / ".tmp" / "chrome-profile"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
WIKI = "https://zh.wikipedia.org/wiki/Chrome"


def send(fd: int, payload: dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
    os.write(fd, header + body)


def read_msg(fd: int, timeout: float = 15.0) -> dict:
    os.set_blocking(fd, False)
    buf = b""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            chunk = os.read(fd, 65536)
        except BlockingIOError:
            time.sleep(0.05)
            continue
        if not chunk:
            time.sleep(0.05)
            continue
        buf += chunk
        while True:
            sep = buf.find(b"\r\n\r\n")
            if sep < 0:
                break
            header = buf[:sep].decode("ascii", "replace")
            length = None
            for line in header.split("\r\n"):
                if line.lower().startswith("content-length:"):
                    length = int(line.split(":", 1)[1].strip())
            if length is None:
                buf = buf[sep + 4 :]
                continue
            start = sep + 4
            if len(buf) < start + length:
                break
            body = buf[start : start + length]
            buf = buf[start + length :]
            return json.loads(body.decode("utf-8"))
    raise TimeoutError("no CDP message")


def drain_until(fd: int, pred, timeout: float = 15.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        remaining = max(0.05, deadline - time.time())
        try:
            last = read_msg(fd, timeout=remaining)
        except TimeoutError:
            break
        if pred(last):
            return last
    raise TimeoutError(f"predicate not met, last={last}")


def main() -> int:
    PROFILE.mkdir(parents=True, exist_ok=True)
    cmd_r, cmd_w = os.pipe()
    out_r, out_w = os.pipe()
    os.set_inheritable(cmd_r, True)
    os.set_inheritable(out_w, True)

    def preexec():
        os.dup2(cmd_r, 3)
        os.dup2(out_w, 4)

    args = [
        CHROME,
        f"--user-data-dir={PROFILE}",
        "--remote-debugging-pipe",
        "--enable-unsafe-extension-debugging",
        "--remote-debugging-port=9223",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1440,900",
        WIKI,
    ]
    proc = subprocess.Popen(args, close_fds=True, pass_fds=(cmd_r, out_w), preexec_fn=preexec)
    os.close(cmd_r)
    os.close(out_w)

    send(cmd_w, {"id": 1, "method": "Extensions.loadUnpacked", "params": {"path": str(EXT)}})
    try:
        msg = drain_until(out_r, lambda m: m.get("id") == 1, timeout=20)
    except TimeoutError as exc:
        print("loadUnpacked timeout", exc, file=sys.stderr)
        return 1
    print(json.dumps(msg, ensure_ascii=False))
    if "error" in msg:
        return 1
    ext_id = (msg.get("result") or {}).get("id")
    print("EXT_ID", ext_id)
    if ext_id:
        (PROFILE / "extension_id.txt").write_text(ext_id)
    print("chrome pid", proc.pid)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

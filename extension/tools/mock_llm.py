#!/usr/bin/env python3
"""Minimal OpenAI-compatible chat completions server for local PageLens testing."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import time

PORT = 18787


def sse_chunk(text: str) -> bytes:
    payload = {
        "id": "mock-1",
        "object": "chat.completion.chunk",
        "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
    }
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[mock-llm]", args[0])

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            body = {}
        messages = body.get("messages") or []
        last = messages[-1] if messages else {}
        content = last.get("content")
        if isinstance(content, list):
            texts = [p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"]
            has_image = any(isinstance(p, dict) and p.get("type") == "image_url" for p in content)
            user = "\n".join(texts)
            if has_image:
                user = "[含截图] " + user
        else:
            user = str(content or "")

        model = body.get("model") or "mock-text"
        system = ""
        for m in messages:
            if m.get("role") == "system":
                system += str(m.get("content") or "")
        if body.get("stream"):
            answer = self._answer(user, model, system)
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            for ch in answer:
                self.wfile.write(sse_chunk(ch))
                self.wfile.flush()
                time.sleep(0.012)
            self.wfile.write(b"data: [DONE]\n\n")
            return

        answer = self._answer(user, model, system)
        payload = {
            "id": "mock-1",
            "object": "chat.completion",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": answer}, "finish_reason": "stop"}],
        }
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _answer(self, user: str, model: str, system: str = "") -> str:
        if user.strip().lower() == "ping":
            return "pong"
        snippet = user.replace("\n", " ").strip()[:80]
        if "同声传译员" in system or (system and "只输出译文" in system):
            src = user.replace("\n", " ").strip()[:120]
            return f"这是实时译文：{src}" if any("\u4e00" <= ch <= "\u9fff" for ch in src) else f"实时译文：代理协议让智能体共享工具。原文大意是 {src[:40]}"
        if "[含截图]" in user:
            return (
                f"这是多模态模型 `{model}` 看到的当前画面。\n"
                f"上下文片段：{snippet}…\n"
                "〔1〕 页面可见区域已作为图像传入。"
            )
        if "章节" in user or "时间戳" in user:
            return (
                "根据字幕整理的章节：\n"
                "0:12 开场，说明今天要讲什么\n"
                "4:30 核心步骤\n"
                "12:04 环境配置\n"
                "〔1〕 以上时间为示例，接入真实模型后会跟字幕走。"
            )
        return (
            f"文本模型 `{model}` 已读到当前页。\n"
            f"你问的是：{snippet}…\n\n"
            "这是本地 mock 回复，用来看侧栏流式效果。把设置里的 base_url 换成真实三方接口即可。"
        )


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"mock llm on http://127.0.0.1:{PORT}/v1/chat/completions")
    server.serve_forever()
